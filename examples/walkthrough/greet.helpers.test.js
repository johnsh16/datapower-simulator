// The same checks as greet.test.js, written with gws-sim's test helpers.
// Run with: npm run test:walkthrough
const test = require('node:test');
const path = require('path');
const { expectRun, gatewayFactory, request } = require('../../testing');   // in your project: require('gws-sim/testing')

const PROFILE = 'https://profiles.example.com/users/ada';
const newGateway = gatewayFactory({ localDir: path.join(__dirname, 'local') });
const greet = (gw, body = { name: 'ada' }) => gw.run('local:///greet.js', request.json(body, { headers: { 'X-Correlation-Id': 'abc-123' } }));

test('greets a known user', async () => {
  const gw = newGateway((g) => g.urlopen.when(PROFILE).replyJson({ displayName: 'Ada Lovelace' }));
  expectRun(await greet(gw))
    .succeeded()
    .status(200)
    .json({ message: 'Hello, Ada Lovelace!' })
    .sentToBackend('GET', PROFILE, { headers: { 'X-Correlation-Id': 'abc-123' } });
});

test('returns 404 when the profile service has no such user', async () => {
  const gw = newGateway((g) => g.urlopen.when('https://profiles.example.com/users/*').replyStatus(404));
  expectRun(await greet(gw, { name: 'nobody' })).status(404).json({ error: 'no such user' });
});

test('returns 502 when the profile service returns a server error', async () => {
  const gw = newGateway((g) => g.urlopen.when(PROFILE).replyJson({ error: 'db down' }, 500));
  expectRun(await greet(gw)).status(502).json({ error: 'profile service unavailable' }).logged('error', /returned 500/);
});

test('returns 502 when the profile service times out', async () => {
  const gw = newGateway((g) => g.urlopen.when(PROFILE).timeout());
  expectRun(await greet(gw)).status(502).logged('error', /timeout/);
});

test('returns 502 when the profile service sends invalid JSON', async () => {
  const gw = newGateway((g) => g.urlopen.when(PROFILE).replyText('not json'));
  expectRun(await greet(gw)).succeeded().status(502);
});

test('returns 400 for a bad request body', async () => {
  expectRun(await newGateway().run('local:///greet.js', request.text('not json')))
    .status(400)
    .notCalledBackend(/profiles/);
});
