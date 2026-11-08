'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { analyze, createTest, lit } = require('../lib/scaffold');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp-scaffold');
const GREET = path.join(ROOT, 'examples', 'walkthrough', 'local', 'greet.js');
const CLI = path.join(ROOT, 'bin', 'gws-new-test.js');

test.before(() => fs.mkdirSync(path.join(TMP, 'local'), { recursive: true }));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// child processes must not inherit the parent runner's NODE_TEST_CONTEXT
const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.NODE_TEST_CONTEXT;

function runNodeTest(file) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', env: CLEAN_ENV });
  return {
    pass: Number((r.stdout.match(/^# pass (\d+)/m) || [])[1]),
    fail: Number((r.stdout.match(/^# fail (\d+)/m) || [])[1]),
    stdout: r.stdout,
  };
}

test('analyze finds what a script reads', () => {
  const info = analyze(`
    var sm = require('service-metadata'); var hm = require('header-metadata'); var mq = require('mq');
    var t = require('transform'); var ms = require('multistep');
    if (sm.protocolMethod === 'GET') {}
    sm.mpgw.skipBackside = true;
    var u = sm.getVar('var://service/URL-in');
    var a = hm.current.get('Authorization');
    var c = session.name('cache') || session.createContext('cache');
    var p = session.name('prior');
    var r = session.parameters.region;
    t.xslt({ location: 'local:///x.xsl' }, function () {});
    ms.callRule('audit', session.input, 'o', function () {});
    session.input.readAsXML(function () {});`);
  assert.equal(info.inputKind, 'xml');
  assert.deepEqual(info.headers, ['Authorization']);
  assert.deepEqual(info.serviceVars.sort(), ['var://service/URL-in', 'var://service/protocol-method']);
  assert.deepEqual(info.contexts, ['prior']); // 'cache' is created by the script itself
  assert.deepEqual(info.parameters, ['region']);
  assert.deepEqual(info.unsupportedModules, ['mq']);
  assert.deepEqual(info.transforms, ['local:///x.xsl']);
  assert.deepEqual(info.rules, ['audit']);
});

test('lit writes readable JavaScript literals', () => {
  assert.equal(lit({ a: 1, 'b-c': "it's" }), "{ a: 1, 'b-c': 'it\\'s' }");
  assert.equal(lit([]), '[]');
  assert.equal(lit({ list: ['x'.repeat(40), 'y'.repeat(40)] }), `{\n  list: [\n    '${'x'.repeat(40)}',\n    '${'y'.repeat(40)}',\n  ],\n}`);
});

test('generated test for the walkthrough script passes as-is', async () => {
  const out = path.join(TMP, 'greet.test.js');
  const r = await createTest({ scriptPath: GREET, outFile: out, input: { name: 'ada' } });
  fs.writeFileSync(out, r.code);

  assert.deepEqual(r.spec.backends.map((b) => `${b.method} ${b.target}`), ['GET https://profiles.example.com/users/ada']);
  assert.deepEqual(r.scenarios.map((s) => s.kind), ['happy', 'failure', 'timeout', 'badInput']);
  assert.match(r.code, /require\('\.\.\/\.\.'\)/);       // inside the repo: relative import
  assert.match(r.code, /responds 502 when GET .* times out/);

  const run = runNodeTest(out);
  assert.equal(run.fail, 0, run.stdout);
  assert.equal(run.pass, 4);
});

test('sample responses from onNewCall are used and unlock later calls', async () => {
  fs.writeFileSync(path.join(TMP, 'local', 'chain.js'), `
    var urlopen = require('urlopen');
    urlopen.open('https://a.example/first', function (e, r) {
      r.readAsJSON(function (e2, j) {
        urlopen.open('https://b.example/' + j.next, function (e3, r2) {
          r2.readAsJSON(function (e4, k) { session.output.write({ got: k.v }); });
        });
      });
    });`);
  const samples = { 'https://a.example/first': { next: 'second' }, 'https://b.example/second': { v: 42 } };
  const out = path.join(TMP, 'chain.test.js');
  const r = await createTest({
    scriptPath: path.join(TMP, 'local', 'chain.js'), outFile: out, onNewCall: async (b) => samples[b.target],
  });
  assert.deepEqual(r.spec.backends.map((b) => b.target), ['https://a.example/first', 'https://b.example/second']);
  assert.ok(r.spec.backends.every((b) => !b.placeholder));
  assert.deepEqual(r.scenarios[0].observed.json, { got: 42 });
  fs.writeFileSync(out, r.code);
  // this script has no error handling, so only the normal-request test is expected to pass
  const run = runNodeTest(out);
  assert.match(run.stdout, /^ok \d+ - responds 200 to a normal request$/m);
  assert.ok(r.warnings.some((w) => /fails with 500" fails for now: the script crashed/.test(w)));
});

test('crashes are flagged and the matching test fails until fixed', async () => {
  fs.writeFileSync(path.join(TMP, 'local', 'crashy.js'), `
    require('urlopen').open('https://x.example/', function (e, r) {
      r.readAsJSON(function (e2, j) { session.output.write({ n: j.deep.value }); });
    });`);
  const out = path.join(TMP, 'crashy.test.js');
  const r = await createTest({ scriptPath: path.join(TMP, 'local', 'crashy.js'), outFile: out });
  fs.writeFileSync(out, r.code);

  assert.match(r.code, /WARNING: when this file was generated, the script crashed here/);
  assert.ok(r.warnings.some((w) => /placeholder backend response/.test(w)));
  const run = runNodeTest(out);
  assert.ok(run.fail >= 1);
});

test('volatile output pins only the fields that stayed the same', async () => {
  fs.writeFileSync(path.join(TMP, 'local', 'stamp.js'), `session.output.write({ ok: true, at: Date.now() + Math.random() });`);
  const out = path.join(TMP, 'stamp.test.js');
  const r = await createTest({ scriptPath: path.join(TMP, 'local', 'stamp.js'), outFile: out });
  assert.match(r.code, /assert\.deepEqual\(body\.ok, true\)/);
  assert.match(r.code, /changed between runs: at/);
});

test('CLI: --yes creates and runs a test; guided mode reads piped answers', () => {
  const out1 = path.join(TMP, 'cli-yes.test.js');
  const a = spawnSync(process.execPath, [CLI, GREET, '--yes', '--input', '{"name":"ada"}', '--out', out1], { encoding: 'utf8', env: CLEAN_ENV });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /Created .*cli-yes\.test\.js with 4 tests \(all 4 passing\)/);

  const out2 = path.join(TMP, 'cli-guided.test.js');
  const answers = ['', '{"name":"ada"}', out2, '{"displayName":"Ada"}'].join('\n') + '\n';
  const b = spawnSync(process.execPath, [CLI, GREET, '--interactive'], { encoding: 'utf8', input: answers, env: CLEAN_ENV });
  assert.equal(b.status, 0, b.stderr);
  assert.match(fs.readFileSync(out2, 'utf8'), /message: 'Hello, Ada!'/);

  const c = spawnSync(process.execPath, [CLI, GREET, '--yes', '--out', out2], { encoding: 'utf8', env: CLEAN_ENV });
  assert.equal(c.status, 1); // refuses to overwrite without --force
  assert.match(c.stdout, /Stopped without changing anything/);
});
