'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { expectRun, gatewayFactory, request, advanceTime, seedTemporary, matches } = require('../testing');

const EXAMPLES = path.join(__dirname, '..', 'examples');
const newGateway = gatewayFactory({ localDir: path.join(EXAMPLES, 'local') }, (gw) => {
  gw.urlopen.when({ method: 'POST', target: 'https://auth.example.com/oauth2/token' }).replyJson({ access_token: 't' });
  gw.urlopen.when('https://orders.example.com/orders').replyJson({ id: 'O1', state: 'NEW' }, 201, { 'X-Trace': 'abc' });
});
const order = () => request.json({ sku: 'X1' }, { method: 'POST', uri: '/orders', headers: { 'X-Correlation-Id': 'c-1' } });

/** assert that fn fails with an AssertionError whose message matches every pattern */
function fails(fn, ...patterns) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof assert.AssertionError, `expected an AssertionError, got ${err && err.name}`);
    for (const p of patterns) assert.match(err.message, p);
    return true;
  });
}

test('passing chain over the bundled example', async () => {
  const res = await newGateway().run('local:///orchestrate.js', order());
  expectRun(res)
    .succeeded()
    .status(201)
    .header('content-type', 'application/json')
    .noHeader('X-Debug')
    .json({ orderId: 'O1', status: 'NEW' })
    .jsonIncludes({ orderId: /^O\d+$/ })
    .text(/"orderId":"O1"/)
    .calledBackend('POST', 'https://auth.example.com/oauth2/token')
    .calledBackend(/orders\.example\.com/, { times: 1 })
    .notCalledBackend('GET', '*')
    .backendCalls(['POST https://auth.example.com/oauth2/token', /^POST https:\/\/orders/])
    .sentToBackend('POST', /orders/, { headers: { Authorization: 'Bearer t', 'x-correlation-id': 'c-1' }, json: { sku: 'X1' }, timeout: 5 })
    .sentToBackend(/oauth2/, { body: /grant_type=client_credentials/ })
    .serviceVar('var://service/mpgw/skip-backside', true)
    .notLogged('error');
});

test('failure messages say what was expected and summarise the run', async () => {
  const res = await newGateway().run('local:///orchestrate.js', order());
  fails(() => expectRun(res).status(200), /Expected status 200 but got 201/, /Run:\n {2}status: {3}201 Created/, /backends: \n +POST https:\/\/auth\.example\.com\/oauth2\/token -> 200/);
  fails(() => expectRun(res).json({ orderId: 'O2', status: 'NEW' }), /JSON body to equal/, /expected: \{ orderId: 'O2'/, /actual: {3}\{ orderId: 'O1'/);
  fails(() => expectRun(res).header('X-Missing'), /response header "X-Missing" to be set/);
  fails(() => expectRun(res).calledBackend('GET', /orders/), /Expected GET \/orders\/ to be called, but it wasn't/);
  fails(() => expectRun(res).calledBackend(/orders/, { times: 2 }), /called 2 time\(s\), but it was called 1 time\(s\)/);
  fails(() => expectRun(res).sentToBackend(/orders/, { headers: { Authorization: 'Bearer nope' } }), /sent header "Authorization" matching 'Bearer nope'/, /actual: {3}"Bearer t"/);
  fails(() => expectRun(res).sentToBackend(/orders/, { timeout: 30 }), /use timeout 30s/, /actual: {3}5s/);
  fails(() => expectRun(res).rejected(), /Expected the script to reject the request/);
  fails(() => expectRun(res).logged('error', /boom/), /error log message matching \/boom\//);
});

test('outcomes: rejected, crashed, clean', async () => {
  const gw = newGateway();
  const rej = await gw.runCode(`session.reject('auth failed: no token');`);
  expectRun(rej).rejected(/auth failed/);
  fails(() => expectRun(rej).succeeded(), /called session\.reject\("auth failed: no token"\)/);

  const crash = await gw.runCode(`session.input.readAsJSON(function (e, j) { session.output.write(j.a.b); });`, request.json({}));
  expectRun(crash).crashed(/Cannot read properties of undefined/);
  fails(() => expectRun(crash).succeeded(), /threw an error/, /error: {4}TypeError/);

  const noisy = await gw.runCode(`console.warn('careful'); session.output.write('ok');`);
  expectRun(noisy).succeeded().logged('warn', /careful/).logged(/careful/);
  fails(() => expectRun(noisy).clean(), /no warnings or errors in the logs, but found 1/, /\[warn\] careful/);
  expectRun(await gw.runCode(`session.output.write('ok');`)).clean();
});

test('xpath, context variables, forwarded headers and files', async () => {
  const gw = newGateway();
  const res = await gw.runCode(`
    var hm = require('header-metadata'), fs = require('fs');
    hm.current.set('X-Forward', 'yes');
    session.createContext('audit').setVariable('who', 'ada');
    fs.writeFile({ file: 'temporary:///cache/u.json', TTL: 60 }, JSON.stringify({ id: 7, name: 'ada' }), function () {
      session.output.write('<user id="7"><name>ada</name><tag/></user>');
    });`);
  expectRun(res)
    .xpath('string(/user/name)', 'ada')
    .xpath('/user/@id', '7')
    .xpath('//tag')
    .contextVar('audit', 'who', 'ada')
    .forwardedHeader('x-forward', 'yes')
    .wroteFile('temporary:///cache/u.json', { json: { id: 7 } })
    .noFile('temporary:///cache/other.json');
  fails(() => expectRun(res).xpath('//missing'), /selected nothing/);
  fails(() => expectRun(res).contextVar('nope', 'x'), /context "nope" to exist/, /contexts: .*audit/);
  fails(() => expectRun(res).wroteFile('temporary:///cache/u.json', { json: { id: 8 } }), /contain the expected JSON/, /actual: {3}\{ id: 7, name: 'ada' \}/);
  fails(() => expectRun(res).json({}), /body to be JSON, but it isn't/);

  advanceTime(gw, 61);
  expectRun(res).noFile('temporary:///cache/u.json'); // TTL passed
});

test('expectRun explains a forgotten await', () => {
  assert.throws(() => expectRun(Promise.resolve({})), /Did you forget to await it\?/);
});

test('matches: partial objects, arrays, RegExp and predicates', () => {
  assert.ok(matches({ a: 1, b: { c: 'xyz', d: 2 } }, { b: { c: /y/ } }));
  assert.ok(matches([1, { a: 2, z: 0 }], [1, { a: 2 }]));
  assert.ok(!matches([1, 2], [1]));
  assert.ok(matches(5, (n) => n > 3));
  assert.ok(!matches(null, { a: 1 }));
});

test('request builders set body, content type, method, URI and headers', () => {
  assert.deepEqual(order(), {
    input: { sku: 'X1' },
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': 'c-1' },
    serviceVars: { 'var://service/protocol-method': 'POST', 'var://service/URI': '/orders' },
  });
  assert.equal(request.form({ a: '1', b: 'x y' }).input, 'a=1&b=x+y');
  assert.equal(request.xml('<a/>').headers['Content-Type'], 'application/xml');
  assert.equal(request.text('hi', { parameters: { p: 1 } }).parameters.p, 1);
  assert.equal(request.empty({ uri: '/health' }).serviceVars['var://service/protocol-method'], 'GET');
});

test('gatewayFactory: fresh gateway per test; per-test mocks win over shared ones', async () => {
  const a = newGateway();
  const b = newGateway((gw) => gw.urlopen.when('https://orders.example.com/orders').down());
  assert.notEqual(a, b);
  expectRun(await a.run('local:///orchestrate.js', order())).status(201);
  expectRun(await b.run('local:///orchestrate.js', order())).status(504).json({ error: 'backend unavailable' });
});

test('backend shortcuts: failFirst, replySequence, slow, replyXml/Text/Status', async () => {
  const gw = newGateway((g) => {
    g.urlopen.when('https://orders.example.com/orders').failFirst(1).replyJson({ id: 'O9', state: 'RETRIED' }, 201);
  });
  const res = await gw.run('local:///orchestrate.js', order());
  expectRun(res).status(201).json({ orderId: 'O9', status: 'RETRIED' }).calledBackend(/orders/, { times: 2 }).logged('warn', /backend 503, retrying/);

  const timeout = newGateway((g) => g.urlopen.when('https://orders.example.com/orders').slow(60000).replyJson({}));
  expectRun(await timeout.run('local:///orchestrate.js', order())).status(504).logged('error', /timeout/);

  const seq = newGateway((g) => g.urlopen.when('https://s/x').replySequence([{ statusCode: 401 }, (req) => ({ statusCode: 200, body: req.method })]));
  const s = await seq.runCode(`var u = require('urlopen'), out = [];
    u.open('https://s/x', function (e, r) { out.push(r.statusCode);
      u.open('https://s/x', function (e2, r2) { r2.readAsBuffer(function (e3, b) { out.push(r2.statusCode + ':' + b);
        u.open('https://s/x', function (e4, r3) { out.push(r3.statusCode); session.output.write(out); }); }); }); });`);
  expectRun(s).json([401, '200:GET', 200]);

  const kinds = newGateway((g) => {
    g.urlopen.when('https://k/xml').replyXml('<a>1</a>');
    g.urlopen.when('https://k/text').replyText('hi', 202);
    g.urlopen.when('https://k/none').replyStatus(204);
  });
  const k = await kinds.runCode(`var u = require('urlopen'), out = {};
    u.open('https://k/xml', function (e, r) { out.xml = r.get('content-type');
      u.open('https://k/text', function (e2, r2) { out.text = r2.statusCode + ' ' + r2.get('content-type');
        u.open('https://k/none', function (e3, r3) { out.none = r3.statusCode; session.output.write(out); }); }); });`);
  expectRun(k).json({ xml: 'application/xml', text: '202 text/plain', none: 204 });
});

test('seedTemporary and advanceTime drive fs-based caching across transactions', async () => {
  const gw = gatewayFactory()();
  seedTemporary(gw, { 'token.json': { token: 'seeded' } }, { ttl: 300 });
  const script = `require('fs').readAsJSON('temporary:///token.json', function (e, t) { session.output.write(e ? 'none' : t.token); });`;
  expectRun(await gw.runCode(script)).text('seeded');
  advanceTime(gw, 299);
  expectRun(await gw.runCode(script)).text('seeded');
  advanceTime(gw, 2);
  expectRun(await gw.runCode(script)).text('none');
});
