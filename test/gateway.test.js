'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Gateway } = require('..');

const LOCAL = path.join(__dirname, '..', 'examples', 'local');
const gw = () => new Gateway({ localDir: LOCAL });

test('session input/output, Buffer and JSON', async () => {
  const r = await gw().runCode(`
    session.input.readAsBuffer(function (e, b) {
      session.output.write(b.toString().toUpperCase());
    });`, { input: 'hello' });
  assert.equal(r.output.text, 'HELLO');
  assert.equal(r.statusCode, 200);
  assert.ok(r.ok);
});

test('readAsJSON error on invalid JSON is delivered to callback', async () => {
  const r = await gw().runCode(`
    session.input.readAsJSON(function (e, j) { session.output.write(e ? 'ERR:' + e.errorMessage : 'ok'); });`, { input: '{bad' });
  assert.match(r.output.text, /^ERR:readAsJSON: invalid JSON/);
});

test('readAs* without callback returns a Promise (async/await)', async () => {
  const r = await gw().runCode(`
    (async function () {
      var j = await session.input.readAsJSON();
      session.output.write({ n: j.n + 1 });
    })();`, { input: { n: 1 } });
  assert.deepEqual(r.output.json(), { n: 2 });
});

test('XML global and readAsXML', async () => {
  const r = await gw().runCode(`
    session.input.readAsXML(function (e, doc) {
      var name = doc.getElementsByTagName('name')[0].textContent;
      session.output.write(XML.parse('<hi>' + name + '</hi>'));
    });`, { input: '<req><name>Bob</name></req>' });
  assert.equal(r.output.text, '<hi>Bob</hi>');
});

test('named contexts and context variables via session and var://context', async () => {
  const r = await gw().runCode(`
    var sm = require('service-metadata');
    var ctx = session.name('saved') || session.createContext('saved');
    ctx.setVariable('id', 7);
    sm.setVar('var://context/saved/other', 'x');
    session.name('pre').readAsJSON(function (e, j) {
      session.output.write({ pre: j.v, id: sm.getVar('var://context/saved/id'), other: ctx.getVariable('other') });
    });`, { contexts: { pre: { v: 'p' } } });
  assert.deepEqual(r.output.json(), { pre: 'p', id: 7, other: 'x' });
  assert.equal(r.contexts.saved.variables.id, 7);
});

test('header-metadata: original read-only, current/response mutable, status codes', async () => {
  const r = await gw().runCode(`
    var hm = require('header-metadata');
    var out = { orig: hm.original.get('x-in'), all: Object.keys(hm.current.headers) };
    try { hm.original.set('a', 'b'); } catch (e) { out.ro = true; }
    hm.current.set('X-Added', 'yes');
    hm.current.remove('X-In');
    hm.response.statusCode = '404 Not Found';
    hm.response.set('X-Resp', '1');
    session.output.write(out);`, { headers: { 'X-In': 'v' } });
  assert.deepEqual(r.output.json(), { orig: 'v', all: ['X-In'], ro: true });
  assert.deepEqual(r.headers.current, { 'X-Added': 'yes' });
  assert.equal(r.statusCode, 404);
  assert.equal(r.reasonPhrase, 'Not Found');
});

test('service-metadata: camelCase properties map to var:// paths', async () => {
  const r = await gw().runCode(`
    var sm = require('service-metadata');
    sm.mpgw.skipBackside = true;
    sm.routingUrl = 'http://b:1/x';
    session.output.write({ m: sm.protocolMethod, uri: sm.URI, in: sm.URLIn, custom: sm.getVar('var://service/my-thing') });`,
  { serviceVars: { 'var://service/protocol-method': 'GET', 'var://service/URI': '/a?b=1', 'var://service/URL-in': 'http://h/a', 'var://service/my-thing': 'z' } });
  assert.deepEqual(r.output.json(), { m: 'GET', uri: '/a?b=1', in: 'http://h/a', custom: 'z' });
  assert.equal(r.serviceVars['var://service/mpgw/skip-backside'], true);
  assert.equal(r.serviceVars['var://service/routing-url'], 'http://b:1/x');
});

test('urlopen: mocked reply, request recorded, headers and body readable', async () => {
  const g = gw();
  g.urlopen.when({ method: 'GET', target: /\/users\/\d+$/ }).reply(200, { name: 'Ann' }, { ETag: 'v1' });
  const r = await g.runCode(`
    var urlopen = require('urlopen');
    urlopen.open({ target: 'https://api/users/5', headers: { Accept: 'application/json' } }, function (e, resp) {
      resp.readAsJSON(function (e2, j) { session.output.write({ s: resp.statusCode, rp: resp.reasonPhrase, etag: resp.get('etag'), name: j.name }); });
    });`);
  assert.deepEqual(r.output.json(), { s: 200, rp: 'OK', etag: 'v1', name: 'Ann' });
  assert.equal(r.urlopenCalls.length, 1);
  assert.equal(r.urlopenCalls[0].getHeader('accept'), 'application/json');
  assert.equal(r.urlopenCalls[0].method, 'GET');
});

test('urlopen: dynamic handler sees the request; default method POST when data is sent', async () => {
  const g = gw();
  g.urlopen.when((req) => req.target.startsWith('https://echo')).reply((req) => ({ statusCode: 202, body: { got: req.json(), m: req.method } }));
  const r = await g.runCode(`
    require('urlopen').open({ target: 'https://echo/x', data: { a: 1 } }, function (e, resp) {
      resp.readAsJSON(function (e2, j) { session.output.write(j); });
    });`);
  assert.deepEqual(r.output.json(), { got: { a: 1 }, m: 'POST' });
  assert.equal(r.urlopenCalls[0].getHeader('content-type'), 'application/json');
});

test('urlopen: sequenced responses with replyOnce / times', async () => {
  const g = gw();
  g.urlopen.when('https://flaky/*').times(2).reply(503)
    .when('https://flaky/*').reply(200, 'finally');
  const r = await g.runCode(`
    var urlopen = require('urlopen'); var codes = [];
    (function go() {
      urlopen.open('https://flaky/a', function (e, resp) {
        codes.push(resp.statusCode);
        if (resp.statusCode === 503) return go();
        resp.readAsBuffer(function (e2, b) { session.output.write(codes.join(',') + ' ' + b); });
      });
    })();`);
  assert.equal(r.output.text, '503,503,200 finally');
});

test('urlopen: connection error, timeout, and unmatched request', async () => {
  const g = gw();
  g.urlopen.when('https://down/').error('connection refused', '0x80e00001');
  g.urlopen.when('https://slow/').delay(5000).reply(200);
  const r = await g.runCode(`
    var urlopen = require('urlopen'); var out = {}; var n = 0;
    function done() { if (++n === 3) session.output.write(out); }
    urlopen.open('https://down/', function (e) { out.down = e && e.errorCode; done(); });
    urlopen.open({ target: 'https://slow/', timeout: 2 }, function (e) { out.slow = e && e.type; done(); });
    urlopen.open('https://nowhere/', function (e) { out.none = e && e.errorMessage; done(); });`);
  const o = r.output.json();
  assert.equal(o.down, '0x80e00001');
  assert.equal(o.slow, 'timeout');
  assert.match(o.none, /no mock matched GET https:\/\/nowhere\//);
});

test('urlopen: local:/// files are served from localDir', async () => {
  const r = await gw().runCode(`
    require('urlopen').open('local:///lookup.xml', function (e, resp) {
      resp.readAsXML(function (e2, doc) {
        require('transform').xpath('string(//code[@id="C"])', doc, function (e3, v) { session.output.write(v); });
      });
    });`);
  assert.equal(r.output.text, 'Closed');
});

test('urlopen: mocks loaded from plain config (fixture files)', async () => {
  const g = new Gateway({
    localDir: LOCAL,
    mocks: [
      { match: { method: 'GET', target: 'https://cfg/a' }, response: { statusCode: 200, body: { from: 'fixture' } } },
      { match: 'https://cfg/err', error: 'boom' },
    ],
  });
  const r = await g.runCode(`
    require('urlopen').open('https://cfg/a', function (e, resp) { resp.readAsJSON(function (e2, j) { session.output.write(j); }); });`);
  assert.deepEqual(r.output.json(), { from: 'fixture' });
});

test('session.reject and uncaught errors', async () => {
  const rej = await gw().runCode(`session.reject('nope'); session.output.write('ignored');`);
  assert.equal(rej.rejected, true);
  assert.equal(rej.rejectReason, 'nope');
  assert.equal(rej.output.text, '');
  assert.equal(rej.statusCode, 500);

  const thrown = await gw().runCode(`session.input.readAsBuffer(function () { undefinedFn(); });`, { input: 'x' });
  assert.match(thrown.error.message, /undefinedFn is not defined/);
  assert.equal(thrown.ok, false);
});

test('console levels and categories are captured', async () => {
  const r = await gw().runCode(`
    console.debug('d'); console.info('i %d', 5); console.options({ category: 'mine' }).error('boom');`);
  assert.deepEqual(r.logsAt('info'), ['i 5']);
  assert.equal(r.logs.find((l) => l.level === 'error').category, 'mine');
});

test('require local:/// module and Buffers global', async () => {
  const r = await gw().runCode(`
    var cfg = require('local:///lib/config.js');
    var b = new Buffers(['ab', Buffer.from('cd')]); b.push('ef');
    session.output.write(cfg.timeout + ':' + b.toString() + ':' + b.length);`);
  assert.equal(r.output.text, '5:abcdef:6');
});

test('unknown npm module is refused like on the appliance; overrides work', async () => {
  const r = await gw().runCode(`require('lodash');`);
  assert.match(r.error.message, /Cannot find module 'lodash'/);
  const g = new Gateway({ modules: { mq: { put: () => 'queued' } } });
  const r2 = await g.runCode(`session.output.write(require('mq').put());`);
  assert.equal(r2.output.text, 'queued');
});

test('transform.xslt uses a registered simulation; multistep.callRule too', async () => {
  const g = gw();
  g.transforms['local:///map.xsl'] = (doc, params) => `<out p="${params.p}">${doc.documentElement.textContent}</out>`;
  g.rules['enrich'] = async (input, output) => { const j = await input.readAsJSON(); output.write({ ...j, enriched: true }); };
  const r = await g.runCode(`
    var t = require('transform'), ms = require('multistep');
    t.xslt({ location: 'local:///map.xsl', xmldom: XML.parse('<a>v</a>'), parameters: { p: 1 } }, function (e, nodes) {
      var tmp = session.createContext('tmp'); tmp.write({ x: 1 });
      ms.callRule('enrich', tmp, 'res', function (e2) {
        session.name('res').readAsJSON(function (e3, j) {
          session.output.write({ xslt: XML.stringify(nodes[0]), rule: j });
        });
      });
    });`);
  assert.deepEqual(r.output.json(), { xslt: '<out p="1">v</out>', rule: { x: 1, enriched: true } });
});

test('jwt encode/decode with named HMAC key', async () => {
  const g = gw(); g.keys.hmac = 'secret';
  const r = await g.runCode(`
    var jwt = require('jwt');
    new jwt.JWTEncoder({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 60 }).setProtectedHeader('alg', 'HS256')
      .addOperation('sign', 'name:hmac').encode(function (e, tok) {
        new jwt.JWTDecoder(tok).addOperation('verify', 'name:hmac').addOperation('validate', {}).decode(function (e2, c) {
          session.output.write(e2 ? 'ERR ' + e2.message : c.sub);
        });
      });`);
  assert.equal(r.output.text, 'u1');
});

test('apim module: variables, output content-type, apim.error', async () => {
  const r = await gw().runCode(`
    var apim = require('apim');
    var ct = apim.getvariable('request.headers.content-type');
    apim.setvariable('message.headers.x-a', 'b');
    if (apim.getvariable('client.app.name') !== 'demo') { apim.error('Forbidden', 403, 'Forbidden', 'no app'); return; }
    apim.output('application/json');
    session.output.write({ ct: ct });`, { headers: { 'Content-Type': 'application/json' }, apim: { client: { app: { name: 'other' } } } });
  assert.equal(r.statusCode, 403);
  assert.equal(r.apimError.message, 'no app');
  assert.equal(r.rejected, true);
});

test('script that never finishes is failed by the run timeout', async () => {
  const r = await gw().runCode(`setInterval(function () {}, 10);`, { timeoutMs: 100 });
  assert.match(r.error.message, /did not complete/);
});

test('the bundled example script runs end to end', async () => {
  const g = gw();
  g.urlopen.when({ method: 'POST', target: 'https://auth.example.com/oauth2/token' }).reply(200, { access_token: 't' })
    .when('https://orders.example.com/orders').reply(201, { id: 'O1', state: 'NEW' });
  const r = await g.run('local:///orchestrate.js', { input: { a: 1 }, serviceVars: { 'var://service/URI': '/orders' } });
  assert.deepEqual(r.output.json(), { orderId: 'O1', status: 'NEW' });
  assert.equal(r.statusCode, 201);
  assert.equal(r.urlopenCalls[1].getHeader('authorization'), 'Bearer t');
});
