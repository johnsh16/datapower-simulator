// Run with: node --test examples/walkthrough/greet.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Gateway } = require('../..');

function newGateway() {
  return new Gateway({ localDir: path.join(__dirname, 'local') });
}

test('greets a known user', async () => {
  const gw = newGateway();
  gw.urlopen.when('https://profiles.example.com/users/ada')
    .reply(200, { displayName: 'Ada Lovelace' });

  const res = await gw.run('local:///greet.js', {
    input: { name: 'ada' },
    headers: { 'X-Correlation-Id': 'abc-123' },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.output.json(), { message: 'Hello, Ada Lovelace!' });
  // check what the script sent to the backend
  assert.equal(res.urlopenCalls.length, 1);
  assert.equal(res.urlopenCalls[0].getHeader('X-Correlation-Id'), 'abc-123');
});

test('returns 404 when the profile service has no such user', async () => {
  const gw = newGateway();
  gw.urlopen.when('https://profiles.example.com/users/*').reply(404);

  const res = await gw.run('local:///greet.js', { input: { name: 'nobody' } });

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.output.json(), { error: 'no such user' });
});

test('returns 502 when the profile service returns a server error', async () => {
  const gw = newGateway();
  gw.urlopen.when('https://profiles.example.com/users/ada').reply(500, { error: 'db down' });

  const res = await gw.run('local:///greet.js', { input: { name: 'ada' } });

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.output.json(), { error: 'profile service unavailable' });
});

test('returns 502 when the profile service times out', async () => {
  const gw = newGateway();
  gw.urlopen.when('https://profiles.example.com/users/*').timeout();

  const res = await gw.run('local:///greet.js', { input: { name: 'ada' } });

  assert.equal(res.statusCode, 502);
  assert.match(res.logsAt('error')[0], /timeout/);
});

test('returns 502 when the profile service sends invalid JSON', async () => {
  const gw = newGateway();
  gw.urlopen.when('https://profiles.example.com/users/ada').reply(200, 'not json');

  const res = await gw.run('local:///greet.js', { input: { name: 'ada' } });

  assert.equal(res.statusCode, 502);
  assert.equal(res.error, null); // handled, not crashed
});

test('returns 400 for a bad request body', async () => {
  const res = await newGateway().run('local:///greet.js', { input: 'not json' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.urlopenCalls.length, 0); // never called the backend
});
