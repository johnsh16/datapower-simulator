'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Env } = require('./env');
const { UrlopenMock } = require('./urlopen-mock');

const DEFAULTS = {
  localDir: process.cwd(),        // local:///
  storeDir: null,                 // store:///
  temporaryDir: null,             // temporary:/// (default: a fresh folder per Gateway, shared by its runs)
  fsWritable: ['temporary'],      // directories the fs module may write to (DataPower: temporary: only)
  printLogs: false,               // false | true | 'error' | 'warn' | 'info' | ...
  appendOutput: false,            // DataPower replaces the context on write(); set true to append
  allowNodeModules: false,        // allow require() of npm packages (not possible on an appliance)
  maxSimulatedDelayMs: 25,        // cap for mocked delays/timeouts so tests stay fast
  instrument: false,              // record heap usage and timing on every trace event (profiling)
  realDelays: false,              // honour mocked delays for real
  timerScale: 1,                  // multiply script setTimeout/setInterval delays (0.001: 2 s backoff takes 2 ms)
  timeoutMs: 30000,               // fail a run that never finishes (e.g. a forgotten setInterval)
  serviceVars: {},                // defaults merged into every run
  systemVars: {},
  modules: {},                    // name -> object | factory(env)
  globals: {},                    // extra globals injected into every script
};

/**
 * A simulated DataPower GatewayScript action.
 *
 *   const gw = new Gateway({ localDir: './local' });
 *   gw.urlopen.when('https://backend/api').reply(200, { ok: true });
 *   const res = await gw.run('local:///script.js', { input: {...}, headers: {...} });
 */
class Gateway {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    for (const k of ['localDir', 'storeDir', 'temporaryDir', 'certDir', 'sharedcertDir']) {
      if (this.options[k]) this.options[k] = path.resolve(this.options[k]);
    }
    this.urlopen = new UrlopenMock();
    if (options.mocks) this.urlopen.load(options.mocks);
    this.transforms = { ...(options.transforms || {}) }; // 'local:///x.xsl' -> (doc, params) => result
    this.rules = { ...(options.rules || {}) };           // multistep.callRule simulations
    this.keys = { ...(options.keys || {}) };             // crypto/jwt key objects by name
    this.temporaryExpiries = new Map();                  // fs TTLs: absolute path -> expiry (ms)
  }

  /** Current time for fs TTLs. Replace in tests to move time forward: gw.now = () => t. */
  now() { return Date.now(); }

  /**
   * The folder standing in for temporary:///. Like the appliance's temporary:
   * directory it outlives a single transaction: every run of this Gateway shares it.
   */
  temporaryDir() {
    if (!this.options.temporaryDir) this.options.temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-sim-temporary-'));
    fs.mkdirSync(this.options.temporaryDir, { recursive: true });
    return this.options.temporaryDir;
  }

  /** Run a GatewayScript file ('local:///x.js', relative or absolute path). */
  run(script, runOptions = {}) {
    let file = script;
    const m = String(script).match(/^(local|store|temporary):\/\/\/?(.*)$/);
    if (m) {
      const base = this.options[m[1] + 'Dir'];
      if (!base) throw new Error(`No directory configured for ${m[1]}:///`);
      file = path.join(base, m[2]);
    }
    file = path.resolve(file);
    return this.runCode(fs.readFileSync(file, 'utf8'), { ...runOptions, filename: file });
  }

  /** Run GatewayScript source code directly. */
  async runCode(code, runOptions = {}) {
    if (runOptions.mocks) this.urlopen.load(runOptions.mocks);
    const filename = runOptions.filename || path.join(this.options.localDir, '<inline>.js');
    const env = new Env(this, runOptions);
    const started = Date.now();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        env.fail(new Error(`GatewayScript did not complete within ${this.options.timeoutMs}ms (pending async operations: ${env.pending})`));
        resolve();
      }, runOptions.timeoutMs || this.options.timeoutMs);
    });
    env.start(code, filename);
    await Promise.race([env.done, timeout]);
    clearTimeout(timer);
    return buildResult(env, Date.now() - started);
  }
}

function buildResult(env, duration) {
  const hm = env.headerMetadata;
  const error = env.errors[0] || null;
  let statusCode = hm.response.statusCode;
  let reasonPhrase = hm.response.reasonPhrase;
  if (error) { statusCode = 500; reasonPhrase = 'Internal Server Error'; }
  else if (env.rejected && !statusCode) { statusCode = 500; reasonPhrase = 'Internal Server Error'; }
  if (!statusCode) { statusCode = 200; reasonPhrase = 'OK'; }

  if (env.rejected || error) {
    env.serviceVars.set('var://service/error-message', env.rejectReason || String(error && error.message));
    env.serviceVars.set('var://service/error-code', error ? '0x85800001' : '0x00d30003');
  }

  const contexts = Object.fromEntries(env.contexts);
  return {
    output: env.contexts.get('OUTPUT'),
    input: env.contexts.get('INPUT'),
    contexts,
    statusCode,
    reasonPhrase,
    headers: {
      original: hm.original.headers,
      current: hm.current.headers,
      response: hm.response.headers,
    },
    currentStatusCode: hm.current.statusCode,
    rejected: env.rejected,
    rejectReason: env.rejectReason,
    apimError: env.apimError || null,
    error,
    errors: env.errors,
    logs: env.logs,
    events: env.events,
    syncBlocks: env.syncBlocks,                       // how long each stretch of script code held the thread
    scriptFiles: [env.runOptions.filename, ...[...env.moduleCache.keys()].filter((k) => path.isAbsolute(k))].filter(Boolean),
    urlopenCalls: env.urlopenCalls,
    serviceVars: Object.fromEntries(env.serviceVars),
    systemVars: Object.fromEntries(env.systemVars),
    apimVars: env.apimVars,
    duration,
    /** true when the script wrote output and neither rejected nor threw */
    get ok() { return !error && !env.rejected; },
    logsAt(level) { return env.logs.filter((l) => l.level === level).map((l) => l.message); },
  };
}

module.exports = { Gateway, DEFAULTS };
