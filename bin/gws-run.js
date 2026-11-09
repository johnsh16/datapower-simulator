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
 *   --local-dir <dir>         the folder on this computer that stands for local:///. It must
 *                             contain the script and hold files in the same layout as the
 *                             appliance (local:///lib/x.js -> <dir>/lib/x.js). Relative to the
 *                             current directory, or absolute. Default: worked out from the
 *                             local:/// files the script uses, else the script's folder.
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
const path = require('path');
const { Gateway } = require('..');
const { findLocalRefs, checkLocalDir, suggestLocalDir } = require('../lib/local-dir');

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

// local:/// on this machine: checked once, so a wrong --local-dir fails with a clear message
// instead of a 'Cannot find module local:///...' from deep inside the script.
let localDir;
if (fs.existsSync(script) && !/^(local|store|temporary):/.test(script)) {
  const refs = findLocalRefs(fs.readFileSync(script, 'utf8'));
  if (opt['local-dir']) {
    const check = checkLocalDir(opt['local-dir'], script, refs);
    if (!check.ok) { console.error(`--local-dir ${opt['local-dir']}: ${check.problem}`); process.exit(1); }
    for (const f of check.missing) console.error(`warning: ${f.url} isn't in --local-dir (looked for ${f.file})`);
    localDir = check.dir;
  } else {
    localDir = suggestLocalDir(script, refs);
  }
} else {
  localDir = opt['local-dir'] ? path.resolve(opt['local-dir']) : process.cwd();
}

const gatewayOptions = () => ({
  localDir,
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

// --- profiling (lib/profile-run.js re-runs this command in a child Node process with the
// V8 flags profiling needs, then prints the report with the deopts merged in)
if (opt.profile) {
  if (opt.passthrough) {
    console.error('--profile can\'t be combined with --passthrough: real network latency would swamp the numbers. Mock the backends instead.');
    process.exit(1);
  }
  require('../lib/profile-run').runProfile({
    script,
    gatewayOptions: gatewayOptions(),
    runOptions: runOptions(),
    setup: applyMocks,
    iterations: Number(opt.iterations) || undefined,
    warmup: opt.warmup !== undefined ? Number(opt.warmup) : undefined,
    top: Number(opt.top) || undefined,
    json: opt.json,
    profileOut: opt['profile-out'],
    unmatchedHint: 'Pass --mocks so every backend answers.',
  });
  return;
}

(async () => {
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
