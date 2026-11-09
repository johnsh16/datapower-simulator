// Retry test template: one endpoint, called several times, answering differently each time.
//
// Use it for any GatewayScript that retries a backend until it gets a good answer.
//   1. Copy this file into your test folder, e.g. test\myScript.retry.test.js
//   2. Edit the CONFIG block below. Nothing else needs to change.
//   3. Run it:  node --test test\myScript.retry.test.js
//
// From CONFIG it generates these tests:
//   - a valid answer on attempt 1, 2, ... up to maxAttempts (invalid answers before it)
//   - giving up after maxAttempts invalid answers
//   - giving up after maxAttempts connection errors
//   - never calling more than maxAttempts times (a valid answer waits after the limit)
//   - every sequence you list in `sequences`, e.g. error, then invalid, then valid
//   - the script running in strict mode, as on DataPower
// Each test checks how many times the endpoint was called and what the script returned.
//
// Full guide, with every CONFIG option and examples: docs/RETRY-TEMPLATE.md

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Gateway } = require('..');   // in a project that installs gws-sim: require('gws-sim')

// =============================================================================
// CONFIG: describe your script and endpoint
// =============================================================================
const CONFIG = {
  // The folder that stands for local:/// (this file's folder is __dirname).
  // For test\ and local\ side by side: path.join(__dirname, '..', 'local')
  localDir: path.join(__dirname, '..', 'examples', 'retry', 'local'),

  // The script under test, as a local:/// path
  script: 'local:///get-token.js',

  // What to send it: the second argument to gw.run (input, headers, serviceVars, ...)
  request: { input: { input: 'test_input' } },

  // The endpoint the script retries. target: an exact URL, a pattern with *, or a RegExp
  endpoint: { method: 'POST', target: 'https://auth.example.com/token' },

  // How many times the script should try before giving up
  maxAttempts: 3,

  // The kinds of answer the endpoint can give. Each is a reply
  // ({ statusCode, headers, body }), { error: 'message' } for a connection
  // failure, or { timeout: true }. Add your own kinds and use them in `sequences`.
  answers: {
    valid:   { statusCode: 200, body: { access_token: 'token_text' } },
    invalid: { statusCode: 200, body: { access_token: '' } },
    error:   { error: 'connection refused' },
    timeout: { timeout: true },
  },

  // Extra call sequences to test, by answer name. The last answer repeats for any
  // further calls. Whether the script should succeed, and on which attempt, is
  // worked out from the first 'valid' within maxAttempts.
  sequences: [
    ['error', 'valid'],
    ['timeout', 'invalid', 'valid'],
    ['invalid', 'error', 'timeout'],
  ],

  // What the script returns when attempt `attempt` gets a valid answer
  expectSuccess(res, attempt) {
    assert.equal(res.statusCode, 200);
    assert.equal(res.output.text, 'token_text');
  },

  // What the script returns when it gives up
  expectGaveUp(res) {
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.output.json(), { error: 'No valid token after 3 attempts' });
  },

  // Also run the script with 'use strict', as DataPower does (catches undeclared variables)
  strictMode: true,

  // Mocks for any OTHER backends the script calls (the retried endpoint is set up for
  // you), or other Gateway setup: gw.urlopen.when('https://other/api').reply(200, {...})
  setup(gw) {},

  // Gateway options: timerScale makes setTimeout backoff 1000x faster (ignored by
  // older gws-sim versions, where waits just take real time)
  gateway: { timerScale: 0.001 },
};

// =============================================================================
// Below here: the tests generated from CONFIG. No need to edit.
// =============================================================================
const { endpoint, maxAttempts, answers } = CONFIG;

function answerFor(name) {
  const a = answers[name];
  if (!a) throw new Error(`CONFIG.sequences uses '${name}', which isn't in CONFIG.answers (${Object.keys(answers).join(', ')})`);
  return a;
}

/**
 * A gateway whose endpoint answers the named sequence in call order; the last answer
 * repeats. Returns the gateway and the endpoint's routes, whose hits count the calls.
 */
function gatewayAnswering(sequence) {
  const gw = new Gateway({ localDir: CONFIG.localDir, ...CONFIG.gateway });
  const routes = sequence.map((name, i) => {
    const a = answerFor(name);
    const route = gw.urlopen.when({ method: endpoint.method, target: endpoint.target });
    if (i < sequence.length - 1) route.times(1);
    if (a.error) route.error(a.error, a.errorCode);
    else if (a.timeout) route.timeout();
    else route.reply(a);
    return route;
  });
  if (CONFIG.setup) CONFIG.setup(gw);   // registered after the endpoint's routes, so those win
  return { gw, routes };
}

/** Success on the first 'valid' within maxAttempts, or giving up after maxAttempts calls. */
function expectedOutcome(sequence) {
  for (let i = 0; i < maxAttempts; i++) {
    const name = sequence[Math.min(i, sequence.length - 1)];
    if (name === 'valid') return { succeeds: true, attempt: i + 1, calls: i + 1 };
  }
  return { succeeds: false, calls: maxAttempts };
}

// Calls that reached the endpoint's routes, however `target` is written
const callsToEndpoint = (routes) => routes.reduce((n, r) => n + r.hits, 0);
const endpointLabel = `${endpoint.method} ${endpoint.target}`;

function describeRun(res) {
  return [
    `status ${res.statusCode}, body ${JSON.stringify(res.output.text)}`,
    `calls: ${res.urlopenCalls.map((c) => `${c.method} ${c.target} -> ${c.response ? c.response.statusCode : 'error'}`).join('; ') || 'none'}`,
    ...res.logs.filter((l) => ['error', 'warn'].includes(l.level)).map((l) => `[${l.level}] ${l.message}`),
  ].join('\n  ');
}

async function check(sequence, runIt = (gw) => gw.run(CONFIG.script, CONFIG.request)) {
  const expected = expectedOutcome(sequence);
  const { gw, routes } = gatewayAnswering(sequence);
  const res = await runIt(gw);
  const context = `\n  ${describeRun(res)}`;
  assert.equal(res.error, null, (res.error && res.error.stack) + context);
  assert.deepEqual(res.leakedGlobals || [], [],
    `the script assigned undeclared variable(s) ${(res.leakedGlobals || []).join(', ')}: on DataPower (strict mode) ` +
    'that throws a ReferenceError. Declare them with var.' + context);
  assert.equal(callsToEndpoint(routes), expected.calls,
    `expected ${expected.calls} call(s) to ${endpointLabel}, got ${callsToEndpoint(routes)}` + context);
  try {
    if (expected.succeeds) CONFIG.expectSuccess(res, expected.attempt);
    else CONFIG.expectGaveUp(res);
  } catch (e) {
    e.message += context;
    throw e;
  }
}

const label = (sequence) => sequence.join(' -> ');

// valid on attempt 1..maxAttempts
for (let invalidFirst = 0; invalidFirst < maxAttempts; invalidFirst++) {
  const sequence = [...Array(invalidFirst).fill('invalid'), 'valid'];
  test(`valid on attempt ${invalidFirst + 1}: ${label(sequence)}`, () => check(sequence));
}

// gives up; a valid answer waits after the limit and must never be requested
test(`gives up after ${maxAttempts} invalid answers`, () => check([...Array(maxAttempts).fill('invalid'), 'valid']));
if (answers.error) {
  test(`gives up after ${maxAttempts} connection errors`, () => check([...Array(maxAttempts).fill('error'), 'valid']));
}

// your sequences
for (const sequence of CONFIG.sequences || []) {
  const o = expectedOutcome(sequence);
  test(`${o.succeeds ? `valid on attempt ${o.attempt}` : 'gives up'}: ${label(sequence)}`, () => check(sequence));
}

// strict mode, as on DataPower
if (CONFIG.strictMode) {
  test('works in strict mode, as on DataPower', () => {
    const file = path.join(CONFIG.localDir, CONFIG.script.replace(/^local:\/\/\/?/, ''));
    const source = "'use strict';\n" + fs.readFileSync(file, 'utf8');
    return check(['invalid', 'valid'], (gw) => gw.runCode(source, { ...CONFIG.request, filename: file }));
  });
}
