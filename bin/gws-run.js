#!/usr/bin/env node
'use strict';
/**
 * gws-run <script.js> [options]
 *   --input <file|string>     request body (file path, or literal text)
 *   --headers <file.json>     request headers
 *   --service-vars <file.json>
 *   --contexts <file.json>    { "name": { "body": ..., "variables": {...} } }
 *   --params <file.json>      session.parameters
 *   --mocks <file.js|json>    urlopen mocks: JSON array of route definitions, or a JS
 *                             module exporting an array or a function (gw) => {...}
 *   --local-dir <dir>         directory backing local:/// (default: the script's directory)
 *   --store-dir <dir>         directory backing store:///
 *   --passthrough             send unmatched urlopen requests to the real network
 *   --log <level>             echo logs at/above level (debug|info|notice|warn|error)
 *   --json                    print the full result (or profile report) as JSON
 *
 * Profiling
 *   --profile                 run the script many times and report CPU per line, memory per
 *                             function, deoptimizations, and best-practice findings
 *   --iterations <n>          transactions to profile (default 200)
 *   --warmup <n>              transactions to run first so V8 optimizes hot code (default 30)
 *   --top <n>                 rows per table (default 10)
 *   --profile-out <dir>       also save .cpuprofile / .heapprofile (open in Chrome DevTools
 *                             or VS Code) and the report as .txt and .json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Gateway } = require('..');

const args = process.argv.slice(2);
const opt = {};
let script;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (['passthrough', 'json', 'help', 'profile'].includes(key)) opt[key] = true;
    else opt[key] = args[++i];
  } else script = a;
}
if (!script || opt.help) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '').replace(/^ \* ?/gm, ''));
  process.exit(script ? 0 : 1);
}

const readJson = (f) => (f ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined);
const readInput = (v) => (v === undefined ? undefined : fs.existsSync(v) ? fs.readFileSync(v) : v);

const gatewayOptions = () => ({
  localDir: opt['local-dir'] || path.dirname(path.resolve(script)),
  storeDir: opt['store-dir'],
});
const runOptions = () => ({
  input: readInput(opt.input),
  headers: readJson(opt.headers),
  serviceVars: readJson(opt['service-vars']),
  contexts: readJson(opt.contexts),
  parameters: readJson(opt.params),
});
async function applyMocks(gw) {
  if (opt.passthrough) gw.urlopen.onUnmatched = 'passthrough';
  if (opt.mocks) {
    const m = opt.mocks.endsWith('.json') ? readJson(opt.mocks) : require(path.resolve(opt.mocks));
    if (typeof m === 'function') await m(gw); else gw.urlopen.load(m);
  }
}

// --- profiling: the parent re-runs this command in a child Node process with the V8
// flags profiling needs (manual GC, deopt log), then merges the deopt log into the report.
if (opt.profile && !process.env.GWS_PROFILE_DIR) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-profile-'));
  const logFile = path.join(tmp, 'v8-deopt.log');
  const child = spawn(process.execPath,
    ['--expose-gc', '--log-deopt', `--logfile=${logFile}`, '--no-logfile-per-isolate', __filename, ...args],
    { env: { ...process.env, GWS_PROFILE_DIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  // V8 also prints each deopt to the console; the report shows them properly, so drop those lines
  const forward = (stream, dest) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) if (!/^\[(bailout|deoptimiz)/.test(l)) dest.write(l + '\n');
    });
    stream.on('end', () => { if (buf && !/^\[(bailout|deoptimiz)/.test(buf)) dest.write(buf + '\n'); });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('close', (code) => {
    try {
      if (code !== 0) process.exit(code || 1);
      const { addDeopts, formatReport } = require('../lib/profiler');
      const report = JSON.parse(fs.readFileSync(path.join(tmp, 'report.json'), 'utf8'));
      addDeopts(report, fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
      const text = formatReport(report, { top: Number(opt.top) || 10 });
      if (opt.json) console.log(JSON.stringify(report, null, 2));
      else console.log('\n' + text);
      if (opt['profile-out']) {
        const base = path.join(opt['profile-out'], path.basename(report.script, '.js'));
        fs.writeFileSync(base + '.profile.json', JSON.stringify(report, null, 2));
        fs.writeFileSync(base + '.profile.txt', text + '\n');
        console.log(`\nSaved to ${opt['profile-out']}/: ${path.basename(base)}.cpuprofile and .heapprofile ` +
          '(open in Chrome DevTools or VS Code), plus .profile.txt and .profile.json');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  return;
}

(async () => {
  if (process.env.GWS_PROFILE_DIR) {
    const { profile, writeArtifacts } = require('../lib/profiler');
    if (opt.passthrough) { console.error('--profile can\'t be combined with --passthrough: real network latency would swamp the numbers. Mock the backends instead.'); process.exit(1); }
    const name = path.basename(script);
    let report;
    try {
      report = await profile({
        script,
        gatewayOptions: gatewayOptions(),
        runOptions: runOptions(),
        setup: applyMocks,
        iterations: Number(opt.iterations) || 200,
        warmup: opt.warmup !== undefined ? Number(opt.warmup) : 30,
        onProgress: (msg) => process.stderr.write(`Profiling ${name}: ${msg}...\n`),
      });
    } catch (e) {
      console.error('\n' + e.message);
      if (e.result && e.result.urlopenCalls.some((c) => !c.matched)) console.error('Hint: some urlopen calls had no mock. Pass --mocks so every backend answers.');
      process.exit(1);
    }
    if (opt['profile-out']) writeArtifacts(report, opt['profile-out']);
    const { raw, ...rest } = report;
    fs.writeFileSync(path.join(process.env.GWS_PROFILE_DIR, 'report.json'), JSON.stringify(rest));
    // end naturally instead of process.exit(): V8 flushes the deopt log only on a normal shutdown
    return;
  }

  const gw = new Gateway({ ...gatewayOptions(), printLogs: opt.log || false });
  await applyMocks(gw);
  const res = await gw.run(script, runOptions());
  if (opt.json) {
    console.log(JSON.stringify({ ...res, output: res.output.text, input: undefined, contexts: undefined,
      error: res.error && String(res.error.stack || res.error) }, null, 2));
  } else {
    console.log(`\n=== ${res.statusCode} ${res.reasonPhrase}${res.rejected ? '  (rejected: ' + res.rejectReason + ')' : ''}`);
    console.log('response headers:', res.headers.response);
    console.log('output:', res.output.text);
    for (const c of res.urlopenCalls) console.log(`urlopen: ${c.method} ${c.target} -> ${c.response ? c.response.statusCode : 'error'}${c.matched ? '' : ' (unmatched)'}`);
    if (res.error) console.error('\nerror:', res.error.stack || res.error);
  }
  process.exit(res.error ? 1 : 0);
})();
