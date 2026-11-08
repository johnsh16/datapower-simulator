'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { profile, formatReport, parseDeoptLog, staticFindings, addDeopts } = require('../lib/profiler');

const ROOT = path.join(__dirname, '..');
const LOCAL = path.join(ROOT, 'examples', 'profiling', 'local');
const MOCKS = require('../examples/profiling/mocks.js');
const CLI = path.join(ROOT, 'bin', 'gws-run.js');
const TMP = path.join(__dirname, '.tmp-profiler');

test.before(() => fs.mkdirSync(TMP, { recursive: true }));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const quick = (name) => profile({
  script: path.join(LOCAL, name),
  gatewayOptions: { localDir: LOCAL },
  runOptions: { input: { since: '2026-11-01' } },
  setup: MOCKS,
  iterations: 20,
  warmup: 3,
});
const rules = (report) => new Set(report.findings.map((f) => f.rule));

test('slow example: per-line CPU, per-function memory, and the planted problems', async () => {
  const r = await quick('slow-report.js');
  const file = path.join(LOCAL, 'slow-report.js');

  assert.ok(r.lines.length > 0, 'no lines sampled');
  assert.ok(r.lines.every((l) => l.file === file), 'only the script\'s own lines are reported');
  const hotLines = r.lines.slice(0, 4).map((l) => l.line);
  assert.ok(hotLines.includes(7) || hotLines.includes(21), `expected toRow or the JSON copy to be hot, got ${hotLines}`);
  assert.ok(r.allocFunctions.some((f) => f.name === 'toRow' && f.perTxn > 0));
  assert.ok(r.time.userCpuMsPerTxn > 0 && r.time.userCpuMsPerTxn <= r.time.totalCpuMsPerTxn);

  for (const rule of ['read-once', 'write-once', 'lazy-require', 'urlopen-timeout', 'big-variable', 'json-clone', 'delete', 'debug-logs']) {
    assert.ok(rules(r).has(rule), `missing finding: ${rule}`);
  }
  assert.ok(!rules(r).has('heap-growth'), 'the example does not leak');
  assert.ok(r.timeline.some((s) => /require\('util'\)\s+\(inside a callback\)/.test(s.what)));

  const text = formatReport(r, { cwd: ROOT });
  assert.match(text, /Hottest lines/);
  assert.match(text, /slow-report\.js:21 .*JSON\.parse\(JSON\.stringify/);
});

test('fast example: the same work without the planted problems', async () => {
  const r = await quick('fast-report.js');
  for (const rule of ['read-once', 'write-once', 'lazy-require', 'urlopen-timeout', 'big-variable', 'json-clone', 'delete']) {
    assert.ok(!rules(r).has(rule), `unexpected finding: ${rule}`);
  }
  assert.equal(r.findings.filter((f) => f.severity === 'warn').length, 0);
});

test('a script that keeps data between transactions is reported as growing', async () => {
  fs.writeFileSync(path.join(TMP, 'leaky.js'), `
    globalThis.__seen = globalThis.__seen || [];
    globalThis.__seen.push(Buffer.alloc(8192, 1).toString('hex'));
    session.output.write('ok');`);
  const r = await profile({ script: path.join(TMP, 'leaky.js'), gatewayOptions: { localDir: TMP }, iterations: 40, warmup: 2 });
  delete globalThis.__seen;
  assert.ok(rules(r).has('heap-growth'), `growth was ${r.memory.heapGrowthHalves}`);
});

test('static checks point at the line and grade severity', () => {
  const f = path.join(TMP, 'static.js');
  fs.writeFileSync(f, [
    'var s = "";',
    'for (var i = 0; i < 9; i++) {',
    '  s += "x" + i;',
    '  var u = require("util");',
    '  console.debug(i);',
    '}',
    'delete o.a; // comment with eval( inside',
    'var c = JSON.parse(JSON.stringify(o));',
  ].join('\n'));
  const found = staticFindings(f);
  const at = (rule) => found.find((x) => x.rule === rule);
  assert.equal(at('string-concat-loop').line, 3);
  assert.equal(at('string-concat-loop').severity, 'info');
  assert.equal(at('require-in-loop').line, 4);
  assert.equal(at('log-in-loop').line, 5);
  assert.equal(at('delete').line, 7);
  assert.equal(at('delete').severity, 'warn');
  assert.equal(at('json-clone').line, 8);
  assert.equal(at('eval'), undefined, 'text inside comments is ignored');
});

test('deopt log lines are matched to the user\'s files and explained', () => {
  const file = '/work/local/x.js';
  const log = [
    'v8-version,12,4,254,21,-node.57,0',
    `code-deopt,19124,640,0x7f80,-1,85,deopt-eager,<${file}:3:36>,wrong map`,
    `code-deopt,19125,640,0x7f80,-1,85,deopt-eager,<${file}:3:36>,wrong map`,
    'code-deopt,21282,832,0x7f8,-1,125,deopt-eager,</sim/lib/env.js:4:19>,overflow',
  ].join('\n');
  const d = parseDeoptLog(log, new Set([file]));
  assert.equal(d.length, 1);
  assert.deepEqual({ line: d[0].line, column: d[0].column, count: d[0].count, reason: d[0].reason }, { line: 3, column: 36, count: 2, reason: 'wrong map' });
  assert.match(d[0].hint, /shape/);

  const report = { userFiles: [file], findings: [], deoptLoggedTransactions: 2 };
  addDeopts(report, log);
  assert.match(report.findings[0].message, /2x in 2 transactions \(about 1 per transaction\)/);
});

test('CLI --profile finds a real deopt and saves DevTools profiles', () => {
  fs.writeFileSync(path.join(TMP, 'shapes.js'), [
    'function area(s) {',
    '  return s.w * s.h;',
    '}',
    'var total = 0;',
    'for (var i = 0; i < 200000; i++) total += area({ w: i, h: 2 });',
    'for (var j = 0; j < 10; j++) total += area({ h: 2, w: j });',
    'session.output.write(String(total));',
  ].join('\n'));
  const out = path.join(TMP, 'artifacts');
  const r = spawnSync(process.execPath, [CLI, path.join(TMP, 'shapes.js'), '--profile', '--iterations', '6', '--warmup', '1', '--profile-out', out],
    { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /shapes\.js:2:\d+ +x\d+ +wrong map/);
  assert.doesNotMatch(r.stdout, /^\[bailout/m, 'V8\'s raw deopt lines are filtered out');
  const cpu = JSON.parse(fs.readFileSync(path.join(out, 'shapes.cpuprofile'), 'utf8'));
  assert.ok(Array.isArray(cpu.nodes) && cpu.nodes.length > 0);
  assert.ok(JSON.parse(fs.readFileSync(path.join(out, 'shapes.heapprofile'), 'utf8')).head);
  assert.ok(fs.existsSync(path.join(out, 'shapes.profile.txt')));
});
