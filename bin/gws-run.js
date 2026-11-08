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
 *   --json                    print the full result as JSON
 */
const fs = require('fs');
const path = require('path');
const { Gateway } = require('..');

const args = process.argv.slice(2);
const opt = {};
let script;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (['passthrough', 'json', 'help'].includes(key)) opt[key] = true;
    else opt[key] = args[++i];
  } else script = a;
}
if (!script || opt.help) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '').replace(/^ \* ?/gm, ''));
  process.exit(script ? 0 : 1);
}

const readJson = (f) => (f ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined);
const readInput = (v) => (v === undefined ? undefined : fs.existsSync(v) ? fs.readFileSync(v) : v);

(async () => {
  const gw = new Gateway({
    localDir: opt['local-dir'] || path.dirname(path.resolve(script)),
    storeDir: opt['store-dir'],
    printLogs: opt.log || false,
  });
  if (opt.passthrough) gw.urlopen.onUnmatched = 'passthrough';
  if (opt.mocks) {
    const m = opt.mocks.endsWith('.json') ? readJson(opt.mocks) : require(path.resolve(opt.mocks));
    if (typeof m === 'function') await m(gw); else gw.urlopen.load(m);
  }
  const res = await gw.run(script, {
    input: readInput(opt.input),
    headers: readJson(opt.headers),
    serviceVars: readJson(opt['service-vars']),
    contexts: readJson(opt.contexts),
    parameters: readJson(opt.params),
  });
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
