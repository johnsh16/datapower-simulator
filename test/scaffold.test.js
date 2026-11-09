'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
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
    var sm = require('service-metadata'); var hm = require('header-metadata'); var rl = require('ratelimit');
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
  assert.deepEqual(info.unsupportedModules, ['ratelimit']);
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

/**
 * Run the CLI with stdin left open after the answers, the way a terminal behaves.
 * Resolves with the exit code and output, or reports a hang after `limitMs`.
 */
function runWithOpenStdin(args, answers, limitMs = 20000) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: CLEAN_ENV });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.stdin.write(answers.join('\n') + '\n'); // note: never c.stdin.end()
    const timer = setTimeout(() => { c.kill(); resolve({ hung: true, stdout, stderr }); }, limitMs);
    c.on('exit', (code) => { clearTimeout(timer); resolve({ hung: false, code, stdout, stderr }); });
  });
}

test('CLI: Node exits once the test is generated, even with stdin still open', async () => {
  const out = path.join(TMP, 'open-stdin.test.js');
  const r = await runWithOpenStdin([GREET, '--interactive'], ['', '{"name":"ada"}', out, '{"displayName":"Ada"}']);
  assert.equal(r.hung, false, 'the generator kept running after it finished');
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(out));
  // the whole summary was flushed before exiting
  assert.match(r.stdout, /3\. Add a test for any other case your script handles/);

  // early exits release the terminal too: refusing to overwrite the file just written
  const again = await runWithOpenStdin([GREET, '--interactive'], ['', '{"name":"ada"}', out, 'n']);
  assert.equal(again.hung, false, 'the generator kept running after refusing to overwrite');
  assert.equal(again.code, 1);
  assert.match(again.stdout, /Stopped without changing anything/);
});

// A token fetch that waits 2 s between up to three attempts, like a real retry with backoff.
const BACKOFF_SCRIPT = `
  var urlopen = require('urlopen');
  session.input.readAsJSON(function (e, req) {
    (function attempt(n) {
      urlopen.open({ target: 'https://auth.example.com/token', method: 'POST', data: req, timeout: 30 }, function (err, resp) {
        if (err) { if (n < 3) return setTimeout(function () { attempt(n + 1); }, 2000); return session.output.write({ error: 'failed' }); }
        resp.readAsJSON(function (e2, t) {
          if (t && t.access_token) return session.output.write({ token: t.access_token, attempts: n });
          if (n < 3) return setTimeout(function () { attempt(n + 1); }, 2000);
          session.output.write({ error: 'invalid' });
        });
      });
    })(1);
  });`;

test('timerScale shortens script timers but keeps their order', async () => {
  const { Gateway } = require('..');
  const code = `var order = [];
    setTimeout(function () { order.push('slow'); }, 3000);
    setTimeout(function () { order.push('fast'); }, 1000);
    setTimeout(function () { session.output.write(order); }, 5000);`;
  const t0 = Date.now();
  const res = await new Gateway({ timerScale: 0.001 }).runCode(code);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.deepEqual(res.output.json(), ['fast', 'slow']);
});

test('a script that retries with backoff is generated in well under a second, and so are its tests', async () => {
  fs.writeFileSync(path.join(TMP, 'local', 'backoff.js'), BACKOFF_SCRIPT);
  const out = path.join(TMP, 'backoff.test.js');
  const messages = [];
  const t0 = Date.now();
  const r = await createTest({
    scriptPath: path.join(TMP, 'local', 'backoff.js'), outFile: out, input: { input: 'x' },
    onNewCall: async () => ({ access_token: 'tok' }), onProgress: (m) => messages.push(m),
  });
  assert.ok(Date.now() - t0 < 3000, `generation took ${Date.now() - t0} ms`);
  assert.deepEqual(messages.filter((m) => m.startsWith('checking')).map((m) => m.split(':')[0]),
    ['checking 1/4', 'checking 2/4', 'checking 3/4', 'checking 4/4']);
  // retries happened (500 -> three attempts) without waiting 2 s each
  assert.equal(r.scenarios.find((s) => s.kind === 'failure').observed.calls.length, 3);
  assert.match(r.code, /new Gateway\(\{ localDir: LOCAL_DIR, timerScale: 0\.001 \}\)/);

  fs.writeFileSync(out, r.code);
  const t1 = Date.now();
  const run = runNodeTest(out);
  assert.equal(run.fail, 0, run.stdout);
  assert.ok(Date.now() - t1 < 5000, `generated tests took ${Date.now() - t1} ms`);
});

test('a script that never finishes is reported, and each stuck check is run once', async () => {
  fs.writeFileSync(path.join(TMP, 'local', 'stuck.js'), `
    session.input.readAsJSON(function () { setInterval(function () {}, 1000); });`);
  const messages = [];
  const t0 = Date.now();
  const r = await createTest({
    scriptPath: path.join(TMP, 'local', 'stuck.js'), outFile: path.join(TMP, 'stuck.test.js'), input: {},
    onProgress: (m) => messages.push(m),
  });
  assert.ok(messages.some((m) => /didn't finish within 2 s/.test(m)), messages.join('\n'));
  assert.ok(r.warnings.some((w) => /never finished in 2 check\(s\).*setInterval that is never cleared/.test(w)), r.warnings.join('\n'));
  // discovery (2 runs) + 2 checks, each once: about 8 s, not 2 x as long
  assert.ok(Date.now() - t0 < 12000, `took ${Date.now() - t0} ms`);
});
