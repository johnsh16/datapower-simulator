'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { findLocalRefs, normaliseInput, checkLocalDir, suggestLocalDir } = require('../lib/local-dir');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp-local-dir');
const PROJ = path.join(TMP, 'my gateway');           // a space, like many real folder names
const SCRIPT = path.join(PROJ, 'local', 'apis', 'orders.js');
const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.NODE_TEST_CONTEXT;

// the layout used in the walkthrough's "Choosing the local:/// folder" table
test.before(() => {
  fs.mkdirSync(path.join(PROJ, 'local', 'apis'), { recursive: true });
  fs.mkdirSync(path.join(PROJ, 'local', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'local', 'lib', 'util.js'), "module.exports = { greet: function (n) { return 'hi ' + n; } };");
  fs.writeFileSync(SCRIPT, "var util = require('local:///lib/util.js');\nsession.output.write(util.greet('x'));\n");
});
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('findLocalRefs lists complete local:/// paths only', () => {
  const refs = findLocalRefs(`
    require('local:///lib/util.js'); require("local:///lib/b.js");
    urlopen.open('local:///data/lookup.xml', cb);
    var dyn = 'local:///lib/' + name;            // incomplete: skipped
    var t = \`local:///x/\${name}.js\`;           // template: skipped
    require('local:///lib/util.js');             // duplicate`);
  assert.deepEqual(refs, ['lib/util.js', 'lib/b.js', 'data/lookup.xml']);
});

test('normaliseInput handles quotes, escaped spaces and ~', () => {
  const cwd = '/work';
  assert.equal(normaliseInput('local', cwd), path.resolve('/work/local'));
  assert.equal(normaliseInput("  'my gateway/local'  ", cwd), path.resolve('/work/my gateway/local'));
  assert.equal(normaliseInput('"my gateway/local"', cwd), path.resolve('/work/my gateway/local'));
  assert.equal(normaliseInput('my\\ gateway/local', cwd), path.resolve('/work/my gateway/local'));
  assert.equal(normaliseInput('~/gw', cwd), path.join(os.homedir(), 'gw'));
  assert.equal(normaliseInput('/abs/dir', cwd), path.resolve('/abs/dir'));
});

test('the walkthrough table: which folders work for local:///', () => {
  const refs = ['lib/util.js'];
  const at = (answer) => checkLocalDir(answer, SCRIPT, refs, PROJ);

  const good = at('local');
  assert.equal(good.ok, true);
  assert.equal(good.scriptUrl, 'local:///apis/orders.js');
  assert.deepEqual(good.missing, []);

  const deep = at('local/apis');
  assert.equal(deep.scriptUrl, 'local:///orders.js');
  assert.deepEqual(deep.missing.map((m) => m.url), ['local:///lib/util.js']);

  const top = at('.');
  assert.equal(top.scriptUrl, 'local:///local/apis/orders.js');
  assert.equal(top.missing.length, 1);

  assert.match(at('local/apis/orders.js').problem, /That's a file, not a folder.*Give the folder that contains it, e.g\. local[\\/]apis/);
  assert.match(at('nope').problem, /doesn't exist/);
  assert.match(at('local:///').problem, /That's the DataPower name/);
  assert.match(at('').problem, /Give a folder path/);
  assert.match(checkLocalDir(path.join(ROOT, 'examples'), SCRIPT, refs, PROJ).problem, /orders\.js isn't inside .*must be the folder that contains the script/);
});

test('the suggested folder is the deepest one where every local:/// file exists', () => {
  assert.equal(suggestLocalDir(SCRIPT, ['lib/util.js']), path.join(PROJ, 'local'));
  assert.equal(suggestLocalDir(SCRIPT, []), path.dirname(SCRIPT));          // nothing to go on
  assert.equal(suggestLocalDir(SCRIPT, ['no/such.js']), path.dirname(SCRIPT));
});

test('gws-run: works out local:/// for a script in a subfolder; rejects a folder without the script', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'gws-run.js'), SCRIPT, ...args], { encoding: 'utf8', env: CLEAN_ENV });
  const ok = run();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /output: hi x/);

  const bad = run('--local-dir', path.join(ROOT, 'examples'));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--local-dir .*orders\.js isn't inside/);

  const deep = run('--local-dir', path.join(PROJ, 'local', 'apis'));
  assert.match(deep.stderr, /warning: local:\/\/\/lib\/util\.js isn't in --local-dir/);
});

test('gws-new-test: explains local:///, re-asks on bad answers, accepts a good one', async () => {
  const out = path.join(TMP, 'orders.test.js');
  const answers = ['local:///', 'local/apis/orders.js', 'local/apis', 'n', "'local'", ''];
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'bin', 'gws-new-test.js'), SCRIPT, '--interactive', '--out', out, '--no-run'],
      { cwd: PROJ, stdio: ['pipe', 'pipe', 'pipe'], env: CLEAN_ENV });
    let stdout = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stdin.write(answers.join('\n') + '\n');
    const timer = setTimeout(() => { c.kill(); resolve({ code: 'hung', stdout }); }, 20000);
    c.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout }); });
  });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /Where is local:\/\/\/ on this computer\?/);
  assert.match(r.stdout, /It must be a folder \(not a file\) that contains orders\.js/);
  assert.match(r.stdout, /Your script uses local:\/\/\/lib\/util\.js, so that file needs to be in it too/);
  assert.match(r.stdout, /local {2,}-> your script is local:\/\/\/apis\/orders\.js/);
  assert.match(r.stdout, /Folder for local:\/\/\/ \[local\]/);
  assert.match(r.stdout, /That's the DataPower name/);
  assert.match(r.stdout, /That's a file, not a folder/);
  assert.match(r.stdout, /missing: local:\/\/\/lib\/util\.js/);
  assert.match(r.stdout, /OK: your script will be local:\/\/\/apis\/orders\.js/);
  // the script's local:/// address is in the setup file the test and the profile share
  assert.match(fs.readFileSync(out.replace(/\.test\.js$/, '.setup.js'), 'utf8'), /const SCRIPT = 'local:\/\/\/apis\/orders\.js';/);
});
