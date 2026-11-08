'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');
const { Context } = require('./context');
const { Buffers } = require('./buffers');
const XML = require('./xml');
const { createSession } = require('./session');
const { createConsole, LEVELS } = require('./console');
const { createHeaderMetadata } = require('./modules/header-metadata');
const { createServiceMetadata, createSystemMetadata, defaultServiceVars } = require('./modules/service-metadata');
const { createUrlopen } = require('./modules/urlopen');
const { createTransform } = require('./modules/transform');
const { createMultistep, createUtil, createCrypto, unsupported } = require('./modules/misc');
const { createApim } = require('./modules/apim');
const { createJwt } = require('./modules/jwt');

/** Node core modules that GatewayScript also exposes (CommonJS-compatible subset). */
const NODE_PASSTHROUGH = ['assert', 'buffer', 'events', 'path', 'punycode', 'querystring', 'string_decoder', 'url', 'zlib'];

const BUILTINS = {
  'header-metadata': (env) => env.headerMetadata,
  'service-metadata': (env) => createServiceMetadata(env),
  'system-metadata': (env) => createSystemMetadata(env),
  urlopen: (env) => createUrlopen(env),
  transform: (env) => createTransform(env),
  multistep: (env) => createMultistep(env),
  apim: (env) => createApim(env),
  util: () => createUtil(),
  crypto: (env) => createCrypto(env),
  jwt: (env) => createJwt(env),
  buffers: () => Buffers,
  console: (env) => env.console,
  // Appliance-object-backed modules: override via new Gateway({ modules: {...} })
  jose: () => unsupported('jose'),
  mq: () => unsupported('mq'),
  sql: () => unsupported('sql'),
  ssh: () => unsupported('ssh'),
  b2b: () => unsupported('b2b'),
};

let activeEnv = null;
process.on('unhandledRejection', (reason) => {
  if (activeEnv && !activeEnv.finished) activeEnv.fail(reason instanceof Error ? reason : new Error(String(reason)));
  else throw reason;
});

class Env {
  constructor(gateway, runOptions) {
    this.gateway = gateway;
    this.options = gateway.options;
    this.runOptions = runOptions;
    this.pending = 0;
    this.finished = false;
    this.rejected = false;
    this.rejectReason = null;
    this.errors = [];
    this.logs = [];
    this.events = [];
    this.urlopenCalls = [];
    this.moduleCache = new Map();
    this.timers = new Map();
    this.syncDone = false;            // true once the script's top-level code has finished
    this.syncBlocks = [];             // [{ label, ms }] each synchronous stretch of script code
    this.t0 = performance.now();

    this.serviceVars = new Map(Object.entries({ ...defaultServiceVars(), ...gateway.options.serviceVars, ...runOptions.serviceVars }));
    this.systemVars = new Map(Object.entries({ ...gateway.options.systemVars, ...runOptions.systemVars }));
    this.apimVars = JSON.parse(JSON.stringify(runOptions.apim || {}));

    this.contexts = new Map();
    this.contexts.set('INPUT', new Context(this, 'INPUT', runOptions.input));
    this.contexts.set('OUTPUT', new Context(this, 'OUTPUT'));
    for (const [name, def] of Object.entries(runOptions.contexts || {})) {
      const isDef = def && typeof def === 'object' && ('body' in def || 'variables' in def);
      this.contexts.set(name, new Context(this, name, isDef ? def.body : def, isDef ? def.variables : undefined));
    }

    this.console = createConsole(this);
    this.session = createSession(this);
    createHeaderMetadata(this);
    this._seedApim();

    this.done = new Promise((resolve) => { this._resolveDone = resolve; });
  }

  _seedApim() {
    const a = this.apimVars;
    a.request = a.request || {};
    if (a.request.headers === undefined) a.request.headers = Object.fromEntries(
      Object.entries(this.headerMetadata.original.headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (a.request.verb === undefined) a.request.verb = this.serviceVars.get('var://service/protocol-method');
    if (a.request.path === undefined) a.request.path = this.serviceVars.get('var://service/URI');
    a.message = a.message || {};
    if (a.message.headers === undefined) a.message.headers = {};
  }

  // ---- logging / tracing --------------------------------------------------
  log(level, category, message) {
    const entry = { time: new Date().toISOString(), level, category, message };
    this.logs.push(entry);
    const p = this.options.printLogs;
    if (p && LEVELS.indexOf(level) <= LEVELS.indexOf(p === true ? 'debug' : p)) {
      const line = `[${category}][${level}] ${message}`;
      (LEVELS.indexOf(level) <= 3 ? process.stderr : process.stdout).write(line + '\n');
    }
  }
  trace(type, data) {
    const e = { time: new Date().toISOString(), type, ...data };
    if (this.options.instrument) {
      e.ms = performance.now() - this.t0;
      e.heapUsed = process.memoryUsage().heapUsed;
    }
    this.events.push(e);
  }
  /** Run script code synchronously and record how long it held the thread. */
  timed(label, fn) {
    const start = performance.now();
    try { return fn(); } finally { this.syncBlocks.push({ label, ms: performance.now() - start }); }
  }

  // ---- async bookkeeping ---------------------------------------------------
  /** Run fn on a later tick; deliver (err, value) to cb, or return a Promise if cb is omitted. */
  async(fn, cb, label = 'callback') {
    this.pending++;
    let resolveP, rejectP;
    const p = typeof cb === 'function' ? null : new Promise((res, rej) => { resolveP = res; rejectP = rej; });
    setImmediate(async () => {
      let err = null, val;
      try { val = await fn(); } catch (e) { err = e; }
      try {
        if (p) (err ? rejectP(err) : resolveP(val));
        else if (!this.finished) this.timed(label, () => cb(err, val));
      } catch (e) { this.fail(e); }
      this.pending--;
      this.checkDone();
    });
    return p || undefined;
  }
  later(ms, fn, label = 'callback') {
    this.pending++;
    setTimeout(() => {
      try { if (!this.finished) this.timed(label, fn); } catch (e) { this.fail(e); }
      this.pending--;
      this.checkDone();
    }, ms);
  }
  simDelay(ms) {
    if (!ms) return 0;
    return this.options.realDelays ? ms : Math.min(ms, this.options.maxSimulatedDelayMs);
  }
  checkDone() {
    if (this.pending > 0 || this.finished) return;
    // let promise chains settle and schedule more work before declaring completion
    setImmediate(() => setImmediate(() => {
      if (this.pending === 0 && !this.finished) this.finish();
    }));
  }
  fail(err) {
    if (this.finished) return;
    this.errors.push(err);
    this.log('error', 'gatewayscript', `Uncaught error: ${err && err.stack || err}`);
    this.finish();
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    for (const [h, kind] of this.timers) (kind === 'interval' ? clearInterval : clearTimeout)(h);
    if (activeEnv === this) activeEnv = null;
    this._resolveDone();
  }

  /** Tracked timer globals so the simulator knows when the script is finished. */
  timerGlobals() {
    const env = this;
    const wrap = (fn, args) => () => { try { if (!env.finished) env.timed('timer callback', () => fn(...args)); } catch (e) { env.fail(e); } };
    return {
      setTimeout(fn, ms, ...args) {
        env.pending++;
        const h = setTimeout(() => { env.timers.delete(h); wrap(fn, args)(); env.pending--; env.checkDone(); }, ms);
        env.timers.set(h, 'timeout');
        return h;
      },
      clearTimeout(h) { if (env.timers.delete(h)) { clearTimeout(h); env.pending--; env.checkDone(); } },
      setInterval(fn, ms, ...args) {
        env.pending++;
        const h = setInterval(wrap(fn, args), ms);
        env.timers.set(h, 'interval');
        return h;
      },
      clearInterval(h) { if (env.timers.delete(h)) { clearInterval(h); env.pending--; env.checkDone(); } },
      setImmediate(fn, ...args) {
        env.pending++;
        return setImmediate(() => { wrap(fn, args)(); env.pending--; env.checkDone(); });
      },
      clearImmediate,
    };
  }

  // ---- contexts & files -----------------------------------------------------
  getOrCreateContext(name, create) {
    const n = ['INPUT', 'OUTPUT'].includes(String(name).toUpperCase()) ? String(name).toUpperCase() : String(name);
    if (!this.contexts.has(n) && create) this.contexts.set(n, new Context(this, n));
    return this.contexts.get(n);
  }
  /** local:///a/b.js -> <localDir>/a/b.js (also store:/// and temporary:///) */
  resolveDpUrl(url) {
    const m = String(url).match(/^(local|store|temporary|cert|sharedcert):\/\/\/?(.*)$/);
    if (!m) return null;
    const base = this.options[m[1] + 'Dir'];
    if (!base) throw new Error(`No directory configured for ${m[1]}:/// (set Gateway option '${m[1]}Dir')`);
    return path.join(base, m[2]);
  }

  // ---- module system --------------------------------------------------------
  makeRequire(fromFile) {
    const req = (spec) => this.loadModule(String(spec), fromFile);
    req.resolve = (spec) => this.resolveFile(spec, fromFile);
    req.cache = this.moduleCache;
    return req;
  }
  resolveFile(spec, fromFile) {
    let p = this.resolveDpUrl(spec);
    if (!p && (spec.startsWith('./') || spec.startsWith('../') || path.isAbsolute(spec))) {
      p = path.resolve(fromFile ? path.dirname(fromFile) : process.cwd(), spec);
    }
    if (!p) return null;
    for (const c of [p, p + '.js', path.join(p, 'index.js')]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    throw new Error(`Cannot find module '${spec}'`);
  }
  loadModule(spec, fromFile) {
    const name = spec.replace(/^node:/, '');
    this.trace('require', { spec, lazy: this.syncDone, from: fromFile });
    if (this.moduleCache.has(name)) return this.moduleCache.get(name);

    const overrides = { ...this.options.modules, ...this.runOptions.modules };
    let exported;
    if (Object.prototype.hasOwnProperty.call(overrides, name)) {
      const o = overrides[name];
      // a function is a factory called with the run environment; anything else is used as-is
      exported = typeof o === 'function' ? o(this) : o;
    } else if (BUILTINS[name]) {
      exported = BUILTINS[name](this);
    } else if (NODE_PASSTHROUGH.includes(name)) {
      exported = require(name);
    } else {
      const file = this.resolveFile(spec, fromFile);
      if (file) {
        if (this.moduleCache.has(file)) return this.moduleCache.get(file).exports;
        const mod = { exports: {}, id: file, filename: file, loaded: false };
        this.moduleCache.set(file, mod);
        this.execute(fs.readFileSync(file, 'utf8'), file, mod);
        mod.loaded = true;
        return mod.exports;
      }
      if (this.options.allowNodeModules) exported = require(require.resolve(spec, { paths: [fromFile ? path.dirname(fromFile) : process.cwd()] }));
      else throw new Error(`Cannot find module '${spec}' (not a GatewayScript built-in; set allowNodeModules or Gateway option 'modules' to provide it)`);
    }
    this.moduleCache.set(name, exported);
    return exported;
  }

  /** Execute GatewayScript source with the DataPower globals in scope. */
  execute(code, filename, mod) {
    const g = {
      require: this.makeRequire(filename),
      module: mod,
      exports: mod.exports,
      __filename: filename,
      __dirname: path.dirname(filename),
      session: this.session,
      console: this.console,
      XML,
      Buffers,
      Buffer,
      ...this.timerGlobals(),
      ...(this.options.globals || {}),
      ...(this.runOptions.globals || {}),
    };
    const names = Object.keys(g);
    const fn = vm.compileFunction(code.replace(/^#!.*/, ''), names, { filename });
    return fn.apply(mod.exports, names.map((n) => g[n]));
  }

  start(code, filename) {
    activeEnv = this;
    const mod = { exports: {}, id: filename, filename, loaded: false };
    try {
      this.timed('script top level', () => this.execute(code, filename, mod));
    } catch (e) {
      this.fail(e);
    }
    this.syncDone = true;
    this.checkDone();
  }
}

module.exports = { Env, BUILTINS, NODE_PASSTHROUGH };
