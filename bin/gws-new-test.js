#!/usr/bin/env node
'use strict';
/**
 * gws-new-test: create a test file for a GatewayScript.
 *
 *   npx gws-new-test                    guided: asks for everything
 *   npx gws-new-test path/to/script.js  guided, script already chosen
 *   npx gws-new-test script.js --yes    no questions, use defaults
 *
 * Inside this repository, use `npm run new-test -- <args>` instead of `npx gws-new-test`.
 *
 * Options
 *   --input <file|json|text>   sample request body
 *   --service-vars <file.json> service variables, e.g. { "var://service/URI": "/orders" }
 *   --local-dir <dir>          the folder on this computer that stands for local:///. It must
 *                              contain the script and hold files in the same layout as the
 *                              appliance (local:///lib/x.js -> <dir>/lib/x.js). Relative to
 *                              the current directory, or absolute. Default: worked out from
 *                              the local:/// files the script uses, else the script's folder.
 *   --out <file>               where to write the test (default: test/<script>.test.js)
 *   --force                    overwrite an existing test file
 *   --yes                      don't ask questions; use defaults and placeholders
 *   --no-run                   don't run the new test after creating it
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { createTest, analyze } = require('../lib/scaffold');
const { findLocalRefs, checkLocalDir, suggestLocalDir } = require('../lib/local-dir');

// ---- arguments ---------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') opts.help = true;
  else if (['--force', '--yes', '--no-run', '--interactive'].includes(a)) opts[a.slice(2)] = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
  else positional.push(a);
}
if (opts.help) {
  const doc = fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1];
  console.log(doc.replace(/^ \* ?/gm, '').trim());
  process.exit(0); // nothing has opened stdin yet, so exiting here is safe
}
const interactive = !opts.yes && (opts.interactive || process.stdin.isTTY);

// ---- prompting (works for a terminal and for piped answers) ------------------
let rl;
let lines;
function prompter() {
  if (!lines) {
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    lines = rl[Symbol.asyncIterator]();
  }
  return lines;
}
/** Stop reading the terminal. An open stdin keeps Node alive, so this must happen before exit. */
function closePrompts() {
  if (rl) { rl.close(); rl = null; lines = null; }
  process.stdin.pause();
  if (typeof process.stdin.unref === 'function') process.stdin.unref();
}
/**
 * End the process once everything has been written. Nothing may keep Node running
 * after generation: not the prompt reader, not a timer left by a script under test.
 * Waiting for stdout/stderr to flush first matters on macOS and Windows, where
 * writes to pipes or terminals can still be pending when process.exit() is called.
 */
function finish(code = 0) {
  closePrompts();
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}
async function ask(question, fallback) {
  if (!interactive) return fallback;
  process.stdout.write(`\n${question}${fallback !== undefined && fallback !== '' ? ` [${fallback}]` : ''}\n> `);
  const { value, done } = await prompter().next();
  if (!interactive || !process.stdin.isTTY) process.stdout.write((done ? '' : value) + '\n');
  const answer = done ? '' : String(value).trim();
  return answer === '' ? fallback : answer;
}

/** A file path, JSON, or plain text -> the value to use. */
function readValue(answer, { preferJson = true } = {}) {
  if (answer === undefined || answer === '') return undefined;
  let text = answer;
  if (fs.existsSync(answer) && fs.statSync(answer).isFile()) text = fs.readFileSync(answer, 'utf8');
  if (preferJson) { try { return JSON.parse(text); } catch { /* not JSON */ } }
  return text;
}

function findScripts(dir, out = [], depth = 0) {
  if (depth > 4 || out.length >= 12) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || ['node_modules', 'test', 'tests', 'lib', 'bin', 'docs'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findScripts(p, out, depth + 1);
    else if (/\.js$/.test(e.name) && !/\.test\.js$|mocks?\.js$|run-example|config\.js$/.test(e.name)) {
      const src = fs.readFileSync(p, 'utf8');
      if (/\bsession\.(input|output|name|reject)\b|require\(\s*['"](urlopen|header-metadata|service-metadata)['"]/.test(src)) out.push(path.relative(process.cwd(), p));
    }
  }
  return out;
}

const say = (s = '') => console.log(s);

// ---- main --------------------------------------------------------------------
(async () => {
  say('gws-new-test: create a test for a GatewayScript');

  // 1. which script
  let script = positional[0];
  if (!script) {
    if (!interactive) { console.error('Usage: gws-new-test <script.js> [options]   (or run it in a terminal to be asked)'); return finish(1); }
    const found = findScripts(process.cwd());
    if (found.length) say('\nGatewayScripts found here:\n' + found.map((f) => '  ' + f).join('\n'));
    script = await ask('Which script do you want to test? (path to the .js file)', found[0]);
  }
  if (!script || !fs.existsSync(script)) { console.error(`\nCan't find the script '${script}'.`); return finish(1); }
  const source = fs.readFileSync(script, 'utf8');
  const info = analyze(source);

  // 2. local:/// folder
  const refs = findLocalRefs(source);
  const suggested = suggestLocalDir(script, refs);
  const shown = (p) => path.relative(process.cwd(), p) || '.';
  const describe = (check) => {
    say(check.missing.length ? `  With this folder, your script would be ${check.scriptUrl}` : `  OK: your script will be ${check.scriptUrl}`);
    for (const f of check.found) say(`  found:   ${f.url}`);
    for (const f of check.missing) say(`  missing: ${f.url}  (looked for ${shown(f.file)})`);
  };
  let local;
  if (opts['local-dir']) {
    local = checkLocalDir(opts['local-dir'], script, refs);
    if (!local.ok) { console.error(`\n--local-dir ${opts['local-dir']}: ${local.problem}`); return finish(1); }
    say(`\nlocal:/// is ${shown(local.dir)}`);
    describe(local);
    if (local.missing.length) say('  Some local:/// files your script uses aren\'t in that folder. Check --local-dir if the test fails to load them.');
  } else if (!interactive) {
    local = checkLocalDir(suggested, script, refs);
  } else {
    const name = path.basename(script);
    const parent = path.dirname(suggested);
    say('\nWhere is local:/// on this computer?');
    say('  On DataPower, local:/// is your domain\'s local: directory. Give the folder on this computer');
    say('  that holds the same files in the same layout, so that local:///lib/util.js would be the');
    say('  file <folder>/lib/util.js.');
    say(`  - It must be a folder (not a file) that contains ${name}, directly or in a subfolder.`);
    say(`  - Type it relative to where you ran this command (${process.cwd()}), or as an absolute path.`);
    if (refs.length) say(`  - Your script uses ${refs.map((r) => 'local:///' + r).join(', ')}, so ${refs.length === 1 ? 'that file needs' : 'those files need'} to be in it too.`);
    say('  For example:');
    const examples = [suggested];
    if (parent !== suggested && !path.relative(process.cwd(), parent).startsWith('..')) examples.push(parent);
    const width = Math.max(...examples.map((e) => shown(e).length)) + 2;
    for (const e of examples) {
      const c = checkLocalDir(e, script, refs);
      say(`    ${shown(e).padEnd(width)}-> your script is ${c.scriptUrl}${c.missing.length ? '  (but local:///' + refs[0] + ' would be missing)' : ''}`);
    }
    for (;;) {
      const answer = await ask('Folder for local:///', shown(suggested));
      local = checkLocalDir(answer, script, refs);
      if (!local.ok) { say(`  ${local.problem}`); continue; }
      describe(local);
      if (!local.missing.length) break;
      const anyway = await ask('  Some files your script uses aren\'t in this folder, so it\'s probably not the right one. Use it anyway? (y/N)', 'n');
      if (/^y/i.test(anyway)) break;
    }
  }
  const localDir = local.dir;

  // 3. request body
  let input = readValue(opts.input, { preferJson: info.inputKind !== 'xml' });
  if (input === undefined && info.inputKind) {
    const label = { json: 'JSON', xml: 'XML', buffer: 'text' }[info.inputKind];
    const example = { json: '{ "id": 1 }', xml: '<request><id>1</id></request>', buffer: 'hello' }[info.inputKind];
    for (;;) {
      const answer = await ask(
        `The script reads a ${label} request body. Paste a realistic one on one line, or give a file path.\n` +
        `A realistic body matters: it decides which backend calls the script makes. (example: ${example})`, '');
      input = readValue(answer, { preferJson: info.inputKind !== 'xml' });
      if (!interactive || answer === undefined || info.inputKind !== 'json' || typeof input !== 'string') break;
      say('  That isn\'t valid JSON. Try again, or press Enter to skip.');
    }
  }

  // 3b. service variables that shape the request (URI, method, ...)
  const serviceVars = opts['service-vars'] ? readValue(opts['service-vars']) : {};
  const { defaultServiceVars } = require('../lib/modules/service-metadata');
  const defaults = defaultServiceVars();
  const toAsk = info.serviceVars.filter((v) => !(v in serviceVars));
  if (interactive && toAsk.length) {
    say('\nThe script reads these service variables. Press Enter to keep the simulator default.');
    for (const v of toAsk) {
      const answer = await ask(`  ${v}`, defaults[v] !== undefined && defaults[v] !== '' ? defaults[v] : undefined);
      if (answer !== undefined) serviceVars[v] = answer;
    }
  }

  // 4. output file
  const base = path.basename(script, '.js');
  let out = opts.out || await ask('Where should the test file go?', path.join('test', `${base}.test.js`));
  if (fs.existsSync(out) && !opts.force) {
    const yes = await ask(`${out} already exists. Overwrite it? (y/N)`, interactive ? 'n' : 'n');
    if (!/^y/i.test(yes)) { say('\nStopped without changing anything. Use --out to pick another file, or --force.'); return finish(1); }
  }

  // 5. discovery + generation
  say(`\nRunning ${script} to see which backends it calls...`);
  const result = await createTest({
    scriptPath: script,
    localDir,
    outFile: out,
    input,
    serviceVars,
    date: new Date().toISOString().slice(0, 10),
    onNewCall: async (b) => {
      say(`  found: ${b.method} ${b.target}`);
      const answer = await ask(
        `  What does ${b.target} normally send back? Paste a sample JSON body on one line, give a file path,\n` +
        '  or press Enter to use a placeholder for now.', '');
      return readValue(answer);
    },
  });

  closePrompts(); // every question has been asked; release the terminal before the test run
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, result.code);
  const testCount = result.scenarios.length;

  // 6. run it
  let summary = '';
  if (!opts['no-run']) {
    // a clean environment: inside another test runner, NODE_TEST_CONTEXT would change the output format
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', out], { encoding: 'utf8', env });
    const pass = Number((r.stdout.match(/^# pass (\d+)/m) || [])[1] || 0);
    const fail = Number((r.stdout.match(/^# fail (\d+)/m) || [])[1] || 0);
    summary = fail ? ` (${pass} passing, ${fail} failing; see below)` : ` (all ${pass} passing)`;
  }

  say(`\nCreated ${out} with ${testCount} test${testCount === 1 ? '' : 's'}${summary}.`);
  if (result.spec.backends.length) {
    say('\nBackends it mocks:');
    for (const b of result.spec.backends) say(`  ${b.method} ${b.target}${b.placeholder ? '   (placeholder response)' : ''}`);
  }
  if (result.warnings.length) {
    say('\nWorth a look:');
    for (const w of result.warnings) say('  - ' + w);
  }
  say('\nNext steps:');
  say(`  1. Open ${out} and work through the TODO comments.`);
  say(`  2. Run it:  node --test ${out.split(path.sep).join('/')}`);
  say('  3. Add a test for any other case your script handles. Copy an existing test and change the request or the backend override.');
  finish(0);
})().catch((e) => {
  console.error('\n' + (process.env.GWS_DEBUG ? (e.stack || e) : (e.message || e)));
  if (!process.env.GWS_DEBUG) console.error('(set GWS_DEBUG=1 to see the full error)');
  finish(1);
});
