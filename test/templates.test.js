'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Gateway } = require('..');

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'templates', 'retry.test.js');
const EXAMPLE = path.join(ROOT, 'examples', 'retry', 'local', 'get-token.js');
const TMP = path.join(__dirname, '.tmp-templates');
const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.NODE_TEST_CONTEXT;

test.before(() => fs.mkdirSync(TMP, { recursive: true }));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** Run a test file; return the names of passing and failing tests. */
function runTests(file) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', env: CLEAN_ENV, timeout: 120000 });
  const names = (re) => [...r.stdout.matchAll(re)].map((m) => m[1]);
  return { passed: names(/^ok \d+ - (.+)$/gm), failed: names(/^not ok \d+ - (.+)$/gm), stdout: r.stdout };
}

/** The template, pointed at a copy of the example script changed by `mutate`, with optional CONFIG edits. */
function templateAgainst(name, mutate, editTemplate = (t) => t) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'local'), { recursive: true });
  const source = fs.readFileSync(EXAMPLE, 'utf8');
  const changed = mutate(source);
  assert.notEqual(changed, source, `mutation '${name}' changed nothing`);
  fs.writeFileSync(path.join(dir, 'local', 'get-token.js'), changed);
  const tpl = fs.readFileSync(TEMPLATE, 'utf8')
    .replace("path.join(__dirname, '..', 'examples', 'retry', 'local')", JSON.stringify(path.join(dir, 'local')))
    .replace("require('..');", `require(${JSON.stringify(ROOT)});`);
  const edited = editTemplate(tpl);
  const file = path.join(dir, 'retry.test.js');
  fs.writeFileSync(file, edited);
  return runTests(file);
}

test('the retry template passes against the bundled example, with one test per scenario', () => {
  const r = runTests(TEMPLATE);
  assert.deepEqual(r.failed, [], r.stdout);
  assert.deepEqual(r.passed, [
    'valid on attempt 1: valid',
    'valid on attempt 2: invalid -> valid',
    'valid on attempt 3: invalid -> invalid -> valid',
    'gives up after 3 invalid answers',
    'gives up after 3 connection errors',
    'valid on attempt 2: error -> valid',
    'valid on attempt 3: timeout -> invalid -> valid',
    'gives up: invalid -> error -> timeout',
    'works in strict mode, as on DataPower',
  ]);
});

test('the template catches a script that retries too many times', () => {
  const r = templateAgainst('too-many', (s) => s.replace('var MAX_ATTEMPTS = 3', 'var MAX_ATTEMPTS = 4'));
  assert.deepEqual(r.failed, ['gives up after 3 invalid answers', 'gives up after 3 connection errors', 'gives up: invalid -> error -> timeout']);
  assert.match(r.stdout, /expected 3 call\(s\) to POST https:\/\/auth\.example\.com\/token, got 4/);
});

test('the template catches a script that never retries', () => {
  const r = templateAgainst('no-retry', (s) => s.replace('attempt <= retryLimit;', 'attempt <= 1;'));
  assert.deepEqual(r.passed, ['valid on attempt 1: valid']);
});

test('the template catches an undeclared variable, which fails on DataPower', () => {
  const r = templateAgainst('undeclared', (s) => s.replace('      var token = await tokenFunction()', '      token = await tokenFunction()'));
  assert.ok(r.failed.includes('works in strict mode, as on DataPower'), r.stdout);
  assert.ok(r.failed.includes('valid on attempt 1: valid'), 'the leak check fails ordinary tests too');
  assert.match(r.stdout, /assigned undeclared variable\(s\) token/);
});

test('globals a script creates are removed after the run and reported', async () => {
  const code = `count = (typeof count === 'number' ? count : 0) + 1; session.output.write(String(count));`;
  const gw = new Gateway();
  const first = await gw.runCode(code);
  const second = await gw.runCode(code);
  assert.equal(first.output.text, '1');
  assert.equal(second.output.text, '1', 'state leaked from the first run');
  assert.deepEqual(first.leakedGlobals, ['count']);
  assert.equal(typeof globalThis.count, 'undefined');
  assert.ok(first.logs.some((l) => l.level === 'warn' && /assigned 'count' without declaring it/.test(l.message)));

  const clean = await gw.runCode(`var x = 1; session.output.write('ok');`);
  assert.deepEqual(clean.leakedGlobals, []);
});

// The example, changed to load settings from a second backend before getting a token.
const withSettingsCall = (s) => s.replace("session.input.readAsJSON(async function (err) {",
  `function loadSettings () {
  return new Promise(function (resolve, reject) {
    urlopen.open({ target: 'https://config.example.com/settings', timeout: 5 }, function (err, resp) {
      if (err) return reject(err)
      resp.readAsJSON(function (e, j) { e ? reject(e) : resolve(j) })
    })
  })
}

session.input.readAsJSON(async function (err) {
  try { await loadSettings() } catch (e) { hm.response.statusCode = 500; session.output.write({ error: 'no settings' }); return }`);

test('a script that calls another backend needs it in CONFIG.setup', () => {
  const without = templateAgainst('other-backend', withSettingsCall);
  assert.equal(without.passed.length, 0, 'unmocked second backend should fail every test');

  const withSetup = templateAgainst('other-backend-setup', withSettingsCall, (t) => t.replace('  setup(gw) {},',
    "  setup(gw) { gw.urlopen.when('https://config.example.com/settings').reply(200, { region: 'us' }); },"));
  assert.deepEqual(withSetup.failed, [], withSetup.stdout);
  assert.equal(withSetup.passed.length, 9);
});

test('the endpoint can be a RegExp or a * pattern, and calls are still counted', () => {
  for (const [name, target] of [['regexp', '/auth\\.example\\.com\\/token$/'], ['glob', "'https://auth.example.com/*'"]]) {
    const ok = templateAgainst(`target-${name}`, (s) => s + '\n',
      (t) => t.replace("target: 'https://auth.example.com/token' }", `target: ${target} }`));
    assert.deepEqual(ok.failed, [], `${name}: ${ok.stdout}`);
    assert.equal(ok.passed.length, 9, name);

    const tooMany = templateAgainst(`target-${name}-4`, (s) => s.replace('var MAX_ATTEMPTS = 3', 'var MAX_ATTEMPTS = 4'),
      (t) => t.replace("target: 'https://auth.example.com/token' }", `target: ${target} }`));
    assert.ok(tooMany.failed.includes('gives up after 3 invalid answers'), `${name}: retrying 4 times must still be caught`);
  }
});
