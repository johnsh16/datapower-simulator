// Test logs: the per-run log (runLogDir / GWS_RUN_LOG_DIR) and the gws-test runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Gateway } = require('..');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `gws-${name}-`));
const RUNNER = path.join(__dirname, '..', 'bin', 'gws-test.js');

test('run log: request, label, caller, backend calls, script log', async () => {
  const dir = tmp('runlog');
  const gw = new Gateway({ runLogDir: dir });
  gw.urlopen.when('https://api.example.com/ok').reply(200, { ok: true });
  const code = `
    var urlopen = require('urlopen');
    console.info('calling');
    urlopen.open({ target: 'https://api.example.com/ok', method: 'POST', data: 'ping' }, function (e, r) {
      urlopen.open({ target: 'https://down.example.com/' }, function (e2) {
        session.output.write(e2 ? 'down' : 'up');
      });
    });`;
  await gw.runCode(code, { input: 'hello', label: 'my label' });
  const log = fs.readFileSync(path.join(dir, 'logs.test.log'), 'utf8');
  assert.match(log, /=== Run 1 .*\(inline code\) {2}"my label"/);
  assert.match(log, /from: {6}test[\\/]logs\.test\.js:\d+/);
  assert.match(log, /request: {3}input hello/);
  assert.match(log, /output: {4}down/);
  assert.match(log, /1\. POST https:\/\/api\.example\.com\/ok\n {5}sent: {5}ping\n {5}received: 200 /);
  assert.match(log, /2\. GET https:\/\/down\.example\.com\/ {2}\[no mock matched\]\n {5}received: error: \S/);
  assert.match(log, /\[info\] calling/);
});

test('run log: numbers runs, shows errors, cuts long text', async () => {
  const dir = tmp('runlog');
  const gw = new Gateway({ runLogDir: dir });
  await gw.runCode(`session.output.write('x'.repeat(5000));`);
  await gw.runCode(`throw new Error('boom');`);
  const log = fs.readFileSync(path.join(dir, 'logs.test.log'), 'utf8');
  assert.match(log, /x{2000}\.\.\. \(3000 more characters\)/);
  assert.match(log, /=== Run 2 /);
  assert.match(log, /\(script threw an error\)/);
  assert.match(log, /error: {5}Error: boom/);
});

test('run log: off by default, runLogDir: null beats GWS_RUN_LOG_DIR', async () => {
  const dir = tmp('runlog');
  const saved = process.env.GWS_RUN_LOG_DIR;
  try {
    delete process.env.GWS_RUN_LOG_DIR;
    await new Gateway().runCode(`session.output.write('a');`);
    process.env.GWS_RUN_LOG_DIR = dir;
    await new Gateway({ runLogDir: null }).runCode(`session.output.write('b');`);
    assert.deepEqual(fs.readdirSync(dir), []);
    await new Gateway().runCode(`session.output.write('c');`);
    assert.deepEqual(fs.readdirSync(dir), ['logs.test.log']);
  } finally {
    if (saved === undefined) delete process.env.GWS_RUN_LOG_DIR; else process.env.GWS_RUN_LOG_DIR = saved;
  }
});

/** A small project: one passing and one failing test that both run a script. */
function project() {
  const dir = tmp('project');
  fs.mkdirSync(path.join(dir, 'test'));
  const gws = JSON.stringify(path.join(__dirname, '..'));
  fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), `
    const test = require('node:test');
    const assert = require('node:assert/strict');
    const { Gateway } = require(${gws});
    test('passes', async () => {
      const res = await new Gateway().runCode("session.output.write('hi')", { label: 'pass run' });
      assert.equal(res.output.text, 'hi');
    });
    test('fails', async () => {
      const res = await new Gateway().runCode("session.output.write('hi')", { label: 'fail run' });
      assert.equal(res.output.text, 'bye');
    });`);
  return dir;
}

const runner = (cwd, ...args) => {
  const env = { ...process.env };
  delete env.GWS_RUN_LOG_DIR;
  return spawnSync(process.execPath, [RUNNER, ...args], { cwd, env, encoding: 'utf8' });
};

test('gws-test: results.log, runs/, latest, a new folder each run', () => {
  const cwd = project();
  const first = runner(cwd, 'test/*.test.js');
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stdout, /Logs: logs[\\/]/);
  const runs = () => fs.readdirSync(path.join(cwd, 'logs')).filter((d) => d !== 'latest');
  assert.equal(runs().length, 1);
  const results = fs.readFileSync(path.join(cwd, 'logs', runs()[0], 'results.log'), 'utf8');
  assert.match(results, /✔ passes/);
  assert.match(results, /✖ fails/);
  assert.match(results, /'hi' !== 'bye'|bye/);
  assert.match(results, /exit code: 1/);
  assert.doesNotMatch(results, /\x1b\[/);
  const runLog = fs.readFileSync(path.join(cwd, 'logs', runs()[0], 'runs', 'a.test.log'), 'utf8');
  assert.match(runLog, /"pass run"/);
  assert.match(runLog, /"fail run"/);
  assert.equal(fs.readFileSync(path.join(cwd, 'logs', 'latest', 'results.log'), 'utf8'), results);

  const second = runner(cwd, '--', '--test-name-pattern=passes');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(runs().length, 2);
  const latest = fs.readFileSync(path.join(cwd, 'logs', 'latest', 'results.log'), 'utf8');
  assert.match(latest, /exit code: 0/);
  assert.doesNotMatch(latest, /✖ fails/);
});

test('gws-test: --no-logs and --log-dir', () => {
  const cwd = project();
  assert.equal(runner(cwd, '--no-logs').status, 1);
  assert.equal(fs.existsSync(path.join(cwd, 'logs')), false);
  assert.equal(runner(cwd, '--log-dir', 'out/test-logs').status, 1);
  assert.ok(fs.existsSync(path.join(cwd, 'out', 'test-logs', 'latest', 'results.log')));
});
