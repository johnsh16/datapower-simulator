'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Gateway } = require('..');
const { sprintf, vsprintf } = require('../lib/modules/sprintf');

const TMP = path.join(__dirname, '.tmp-modules');
const LOCAL = path.join(TMP, 'local');

test.before(() => {
  fs.mkdirSync(path.join(LOCAL, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(LOCAL, 'config.json'), '{ "tokenUrl": "https://auth.example.com/token" }');
  fs.writeFileSync(path.join(LOCAL, 'map.xml'), '<map><k id="a">1</k></map>');
});
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const newGw = () => new Gateway({ localDir: LOCAL });
const run = (gw, code, opts) => gw.runCode(code, opts).then((r) => {
  if (r.error) throw r.error;
  return r;
});

// ---------------------------------------------------------------------------
// fs
// ---------------------------------------------------------------------------
test('fs: a module loaded by the script can require fs (the reported failure)', async () => {
  fs.writeFileSync(path.join(LOCAL, 'lib', 'cfg.js'), `
    var fs = require('fs');
    exports.load = function (cb) { fs.readAsJSON('local:///config.json', cb); };`);
  const r = await run(newGw(), `
    require('local:///lib/cfg.js').load(function (e, c) { session.output.write(e ? 'ERR ' + e.message : c.tokenUrl); });`);
  assert.equal(r.output.text, 'https://auth.example.com/token');
});

test('fs: reads local: as Buffer, string, JSON and XML', async () => {
  const r = await run(newGw(), `
    var fs = require('fs'), out = {};
    fs.readFile('local:///config.json', function (e, buf) {
      out.isBuffer = Buffer.isBuffer(buf);
      fs.readFile('local:///config.json', 'utf8', function (e2, text) {
        out.text = typeof text;
        fs.readAsXML('local:///map.xml', function (e3, doc) {
          out.xml = doc.documentElement.firstChild.getAttribute('id');
          fs.readAsJSON('local:///nope.json', function (e4) {
            out.missing = e4.code;
            session.output.write(out);
          });
        });
      });
    });`);
  assert.deepEqual(r.output.json(), { isBuffer: true, text: 'string', xml: 'a', missing: 'ENOENT' });
});

test('fs: writes go to temporary: only, and survive into the next transaction', async () => {
  const gw = newGw();
  await run(gw, `require('fs').writeFile('temporary:///state/n.txt', '1', function (e) { session.output.write(e ? e.message : 'ok'); });`);
  const second = await run(gw, `require('fs').readFile('temporary:///state/n.txt', 'utf8', function (e, t) { session.output.write(e ? e.code : t); });`);
  assert.equal(second.output.text, '1');

  const denied = await run(gw, `
    var fs = require('fs'), out = [];
    fs.writeFile('local:///x.txt', 'x', function (e) {
      out.push(e.code);
      fs.writeFile('store:///x.txt', 'x', function (e2) {
        out.push(e2.code);
        fs.readFile('temporary:///../../../etc/passwd', function (e3) { out.push(e3.code); session.output.write(out); });
      });
    });`);
  assert.deepEqual(denied.output.json(), ['EACCES', 'EACCES', 'EACCES']);
  assert.ok(!fs.existsSync(path.join(LOCAL, 'x.txt')));
});

test('fs: TTL is 10 s by default, settable both ways, 0 keeps the file', async () => {
  const gw = newGw();
  let now = 1_000_000;
  gw.now = () => now;
  await run(gw, `
    var fs = require('fs');
    fs.writeFile('temporary:///default.txt', 'd', function () {
      fs.writeFile({ file: 'temporary:///obj.txt', TTL: 60 }, 'o', function () {
        fs.writeFile('temporary:///opt.txt', 'p', { TTL: 60 }, function () {
          fs.writeFile({ file: 'temporary:///keep.txt', TTL: 0 }, 'k', function () { session.output.write('ok'); });
        });
      });
    });`);
  const which = async () => (await run(gw, `
    var fs = require('fs'), names = ['default', 'obj', 'opt', 'keep'], out = {}, n = 0;
    names.forEach(function (x) {
      fs.exists('temporary:///' + x + '.txt', function (yes) { out[x] = yes; if (++n === names.length) session.output.write(out); });
    });`)).output.json();

  now += 9_000;
  assert.deepEqual(await which(), { default: true, obj: true, opt: true, keep: true });
  now += 2_000; // 11 s
  assert.deepEqual(await which(), { default: false, obj: true, opt: true, keep: true });
  now += 60_000;
  assert.deepEqual(await which(), { default: false, obj: false, opt: false, keep: true });
});

test('fs: invalid TTLs are rejected; very large ones are accepted with a warning', async () => {
  const r = await newGw().runCode(`
    require('fs').writeFile({ file: 'temporary:///t.txt', TTL: -1 }, 'x', function (e) { session.output.write(e.name + ': ' + e.message); });`);
  assert.match(r.output.text, /^RangeError: fs: TTL must be a whole number of seconds from 0 to 86400/);
  const big = await newGw().runCode(`require('fs').writeFile({ file: 'temporary:///t.txt', TTL: 100000 }, 'x', function (e) { session.output.write(e ? 'err' : 'ok'); });`);
  assert.equal(big.output.text, 'ok'); // accepted, as reported on real firmware
  assert.ok(big.logs.some((l) => /above the documented maximum/.test(l.message)));
});

test('fs: appendFile, rename (keeps TTL), truncate, unlink', async () => {
  const gw = newGw();
  let now = 5_000_000;
  gw.now = () => now;
  const r = await run(gw, `
    var fs = require('fs'), out = {};
    fs.writeFile({ file: 'temporary:///a.log', TTL: 30 }, 'one\\n', function () {
      fs.appendFile('temporary:///a.log', 'two\\n', function () {
        fs.rename('temporary:///a.log', 'temporary:///b.log', function () {
          fs.readFile('temporary:///b.log', 'utf8', function (e, t) {
            out.renamed = t;
            fs.truncate('temporary:///b.log', 3, function () {
              fs.readFile('temporary:///b.log', 'utf8', function (e2, t2) {
                out.truncated = t2;
                fs.unlink('temporary:///b.log', function () {
                  fs.exists('temporary:///b.log', function (err, yes) { out.afterUnlink = yes; out.errArg = err; session.output.write(out); });
                });
              });
            });
          });
        });
      });
    });`);
  assert.deepEqual(r.output.json(), { renamed: 'one\ntwo\n', truncated: 'one', afterUnlink: false, errArg: null });

  // rename carries the TTL over
  await run(gw, `var fs = require('fs'); fs.writeFile({ file: 'temporary:///c.txt', TTL: 30 }, 'c', function () { fs.rename('temporary:///c.txt', 'temporary:///d.txt', function () { session.output.write('ok'); }); });`);
  now += 31_000;
  const gone = await run(gw, `require('fs').exists('temporary:///d.txt', function (yes) { session.output.write(String(yes)); });`);
  assert.equal(gone.output.text, 'false');
});

test('fs: no callback returns a Promise; fs.temporary explains it is not emulated', async () => {
  const r = await run(newGw(), `
    var fs = require('fs');
    (async function () {
      await fs.writeFile('temporary:///p.json', JSON.stringify({ v: 2 }));
      var j = await fs.readAsJSON('temporary:///p.json');
      var msg; try { fs.temporary(); } catch (e) { msg = e.message; }
      session.output.write({ v: j.v, temporary: /isn't emulated/.test(msg) });
    })();`);
  assert.deepEqual(r.output.json(), { v: 2, temporary: true });
});

test('fs is DataPower\'s module even when npm modules are allowed', async () => {
  const r = await run(new Gateway({ localDir: LOCAL, allowNodeModules: true }), `
    var fs = require('fs');
    session.output.write({ readAsJSON: typeof fs.readAsJSON, readFileSync: typeof fs.readFileSync });`);
  assert.deepEqual(r.output.json(), { readAsJSON: 'function', readFileSync: 'undefined' });
});

// ---------------------------------------------------------------------------
// sprintf
// ---------------------------------------------------------------------------
test('sprintf: the documented specifiers, flags and argument swapping', async () => {
  assert.equal(sprintf('%2$s %3$s a %1$s', 'cracker', 'Polly', 'wants'), 'Polly wants a cracker');
  assert.equal(vsprintf('%s, %s, %s and %s', ['a', 'b', 'c', 'd']), 'a, b, c and d');
  assert.equal(sprintf('%05d|%-5d|%+d|%+d', 42, 42, 42, -42), '00042|42   |+42|-42');
  assert.equal(sprintf("%'*8s|%.2f|%.3s|%S", 'pad', 3.14159, 'abcdef', 'up'), '*****pad|3.14|abc|UP');
  assert.equal(sprintf('%b %o %x %X %c %u %%', 5, 8, 255, 255, 65, -1), '101 10 ff FF A 4294967295 %');
  assert.equal(sprintf('%j', { a: 1 }), '{"a":1}');
  assert.equal(sprintf('%.1e|%E', 12345, 0.5), '1.2e+4|5E-1');
  assert.throws(() => sprintf('%s %s', 'one'), /too few arguments/);

  const r = await run(newGw(), `var s = require('sprintf'); session.output.write(s.sprintf('%03d-%s', 7, 'x'));`);
  assert.equal(r.output.text, '007-x');
});

// ---------------------------------------------------------------------------
// util, system-metadata, module availability
// ---------------------------------------------------------------------------
test('util: documented functions, DataPower XML helpers, and a warning beyond the docs', async () => {
  const r = await run(newGw(), `
    var util = require('util');
    var doc = XML.parse('<a x="1"><b/><b/></a>');
    var out = {
      isNode: util.isNode(doc.documentElement), notNode: util.isNode({}),
      isNodeList: util.isNodeList(doc.getElementsByTagName('b')),
      isNamedNodeMap: util.isNamedNodeMap(doc.documentElement.attributes),
      listIsNotMap: util.isNamedNodeMap(doc.getElementsByTagName('b')),
      isArray: util.isArray([]), isDate: util.isDate(new Date()), isError: util.isError(new Error()), isRegExp: util.isRegExp(/x/),
      format: util.format('%s=%d', 'n', 3),
      promisify: typeof util.promisify,
    };
    session.output.write(out);`);
  assert.deepEqual(r.output.json(), {
    isNode: true, notNode: false, isNodeList: true, isNamedNodeMap: true, listIsNotMap: false,
    isArray: true, isDate: true, isError: true, isRegExp: true, format: 'n=3', promisify: 'function',
  });
  assert.ok(r.logs.some((l) => l.level === 'warn' && /util\.promisify isn't in DataPower's documentation/.test(l.message)));
  assert.ok(!r.logs.some((l) => /util\.format/.test(l.message)), 'documented functions do not warn');
});

test('system-metadata accepts setVariable/getVariable as well as setVar/getVar', async () => {
  const r = await run(newGw(), `
    var sysm = require('system-metadata');
    sysm.setVariable('var://system/app/token', 'abc');
    session.output.write(sysm.getVar('var://system/app/token') + sysm.getVariable('var://system/app/token'));`);
  assert.equal(r.output.text, 'abcabc');
});

test('module availability matches the documentation', async () => {
  const r = await run(newGw(), `
    var out = {};
    ['assert', 'punycode', 'querystring', 'url', 'fs', 'sprintf', 'util', 'crypto', 'jwt', 'transform', 'multistep',
     'header-metadata', 'service-metadata', 'system-metadata', 'urlopen', 'console',
     'jose', 'jwk', 'apigw', 'ratelimit', 'json-xml-converter', 'mgmt', 'policy-utility',
     'events', 'path', 'zlib', 'mq', 'sql', 'http', 'child_process'].forEach(function (m) {
      try { require(m); out[m] = 'ok'; } catch (e) { out[m] = 'missing'; }
    });
    var stub; try { require('ratelimit').check(); } catch (e) { stub = /not emulated/.test(e.message); }
    out.stubExplains = stub;
    session.output.write(out);`);
  const o = r.output.json();
  for (const m of ['assert', 'punycode', 'querystring', 'url', 'fs', 'sprintf', 'util', 'crypto', 'jwt', 'transform', 'multistep',
    'header-metadata', 'service-metadata', 'system-metadata', 'urlopen', 'console',
    'jose', 'jwk', 'apigw', 'ratelimit', 'json-xml-converter', 'mgmt', 'policy-utility']) assert.equal(o[m], 'ok', m);
  for (const m of ['events', 'path', 'zlib']) assert.equal(o[m], 'ok', `${m} still loads`);
  for (const m of ['mq', 'sql', 'http', 'child_process']) assert.equal(o[m], 'missing', m);
  assert.equal(o.stubExplains, true);
  const warned = r.logs.filter((l) => /isn't listed in DataPower's GatewayScript documentation/.test(l.message)).map((l) => l.message.match(/require\('(\w+)'\)/)[1]);
  assert.deepEqual(warned.sort(), ['events', 'path', 'zlib']);
});
