#!/usr/bin/env node
'use strict';
/**
 * gws-test: run tests and save their output to a logs folder.
 *
 *   npm test                                  all tests (inside this repo)
 *   npx gws-test test/testRetry.test.js       some files (in your own project)
 *   npx gws-test -- --test-name-pattern=token  options after -- go to node --test
 *
 * Each run writes a new folder at the project root (the current directory):
 *   logs/2026-11-08_22-45-03/results.log   what the terminal showed: each test, pass/fail, failure messages
 *   logs/2026-11-08_22-45-03/runs/*.log    every script run, one file per test file: request, status,
 *                                          output, each backend call (sent/received), what the script logged
 *   logs/latest/                           a copy of the newest run
 *
 * Options (before any --)
 *   --log-dir <dir>   where to put the logs (default: logs)
 *   --no-logs         run the tests without writing logs
 *   --help
 * Files and patterns: paths, or a * pattern inside one folder (test/*.test.js).
 * With no files, runs test/*.test.js.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const files = [];
const nodeArgs = [];
let logRoot = 'logs';
let logs = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--') { nodeArgs.push(...args.slice(i + 1)); break; }
  if (a === '--help' || a === '-h') {
    console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '').trim());
    process.exit(0);
  }
  if (a === '--log-dir') logRoot = args[++i];
  else if (a === '--no-logs') logs = false;
  else if (a.startsWith('--')) nodeArgs.push(a);   // e.g. --test-name-pattern=x
  else files.push(a);
}

/** Expand 'dir/*.test.js' ourselves: Windows shells don't, and older Node can't. */
function expand(pattern) {
  if (!pattern.includes('*')) return [pattern];
  const dir = path.dirname(pattern);
  const re = new RegExp('^' + path.basename(pattern).replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*') + '$');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
}
const testFiles = (files.length ? files : ['test/*.test.js']).flatMap(expand);
if (!testFiles.length) {
  console.error(`No test files found for: ${(files.length ? files : ['test/*.test.js']).join(' ')}`);
  process.exit(1);
}

// logs/<local date_time>/ (a second run in the same second gets -2, -3, ...)
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
let runDir = null;
if (logs) {
  runDir = path.resolve(logRoot, stamp);
  for (let n = 2; fs.existsSync(runDir); n++) runDir = path.resolve(logRoot, `${stamp}-${n}`);
  fs.mkdirSync(path.join(runDir, 'runs'), { recursive: true });
}

const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;                       // a clean test run even when started from inside one
if (runDir) env.GWS_RUN_LOG_DIR = path.join(runDir, 'runs');
else delete env.GWS_RUN_LOG_DIR;
if (process.stdout.isTTY && !('NO_COLOR' in env)) env.FORCE_COLOR = '1';   // keep the terminal's colors

const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...nodeArgs, ...testFiles],
  { env, stdio: ['inherit', 'pipe', 'pipe'] });

const results = runDir ? fs.createWriteStream(path.join(runDir, 'results.log')) : null;
const plain = (chunk) => String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
if (results) {
  results.write(`gws-test run ${stamp}\ncommand: node --test ${[...nodeArgs, ...testFiles].join(' ')}\n\n`);
}
child.stdout.on('data', (d) => { process.stdout.write(d); if (results) results.write(plain(d)); });
child.stderr.on('data', (d) => { process.stderr.write(d); if (results) results.write(plain(d)); });

child.on('close', (code, signal) => {
  const exit = code === null ? 1 : code;
  const finish = () => {
    if (runDir) {
      // logs/latest = a copy of this run (a copy rather than a link, which Windows may not allow)
      const latest = path.resolve(logRoot, 'latest');
      try {
        fs.rmSync(latest, { recursive: true, force: true });
        fs.cpSync(runDir, latest, { recursive: true });
      } catch (e) {
        console.error(`Couldn't update ${latest}: ${e.message}`);
      }
      const runs = fs.readdirSync(path.join(runDir, 'runs'));
      const rel = path.relative(process.cwd(), runDir) || runDir;
      console.log(`\nLogs: ${rel}${path.sep}  (results.log${runs.length ? `, runs${path.sep} for ${runs.length} test file(s)` : ''}; also ${path.join(logRoot, 'latest')}${path.sep})`);
    }
    process.exit(signal ? 1 : exit);
  };
  if (results) results.end(`\nexit code: ${exit}${signal ? ` (stopped by ${signal})` : ''}\n`, finish);
  else finish();
});
