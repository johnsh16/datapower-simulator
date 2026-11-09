'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Env } = require('./env');
const { UrlopenMock } = require('./urlopen-mock');
const { writeRunLog } = require('./run-log');

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
  // runLogDir: folder for per-run logs (default: $GWS_RUN_LOG_DIR, set by gws-test); null turns it off
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
    if (!runOptions.__caller) runOptions = { ...runOptions, __caller: callerLocation() };
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
    if (!runOptions.__caller) runOptions = { ...runOptions, __caller: callerLocation() };
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
    const result = buildResult(env, Date.now() - started);
    writeRunLog(this.options, result, { ...runOptions, filename: runOptions.filename });
    return result;
  }
}

/** 'test/testRetry.test.js:33': the first stack frame outside gws-sim and Node, for the run log. */
function callerLocation() {
  const here = path.dirname(__dirname);
  for (const line of (new Error().stack || '').split('\n').slice(1)) {
    const m = line.match(/\(?((?:[A-Za-z]:)?[^():]+):(\d+):\d+\)?\s*$/);
    if (!m) continue;
    const file = m[1].replace(/^file:\/\//, '');
    if (file.startsWith('node:') || !path.isAbsolute(file)) continue;
    if (file.startsWith(path.join(here, 'lib') + path.sep) || file === path.join(here, 'index.js')) continue;
    return `${path.relative(process.cwd(), file) || file}:${m[2]}`;
  }
  return null;
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
    leakedGlobals: env.leakedGlobals || [],          // undeclared variables the script assigned (removed after the run)
    syncBlocks: env.syncBlocks,                       // how long each stretch of script code held the thread
    scriptFiles: [env.runOptions.filename, ...[...env.moduleCache.keys()].filter((k) => path.isAbsolute(k))].filter(Boolean),
    urlopenCalls: env.urlopenCalls,
    serviceVars: Object.fromEntries(env.serviceVars),
    systemVars: Object.fromEntries(env.systemVars),
    apimVars: env.apimVars,
    duration,
    /**
     * Contents of a file in a DataPower directory after the run, e.g. what the script
     * wrote with fs: res.readFile('temporary:///token.json'). Returns a Buffer, or
     * undefined if the file doesn't exist or its TTL has passed.
     */
    readFile(dpUrl) {
      const p = env.resolveDpUrl(dpUrl);
      if (!p) throw new Error(`readFile: '${dpUrl}' isn't a DataPower URL such as temporary:///name`);
      const until = env.gateway.temporaryExpiries.get(path.resolve(p));
      if (until !== undefined && env.gateway.now() >= until) return undefined;
      return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p) : undefined;
    },
    /** true when the script wrote output and neither rejected nor threw */
    get ok() { return !error && !env.rejected; },
    logsAt(level) { return env.logs.filter((l) => l.level === level).map((l) => l.message); },
  };
}

module.exports = { Gateway, DEFAULTS };
