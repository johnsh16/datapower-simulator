# Retry test template

[`templates/retry.test.js`](../templates/retry.test.js) tests a GatewayScript that calls one endpoint several times until it gets a good answer, such as a token fetch with up to three attempts. You describe the script, the endpoint and its possible answers in one `CONFIG` block. The template then generates a test for every way the calls can go, and checks each time that the script made exactly the right number of calls and returned the right result.

## Quick start

1. **Copy the template** into your test folder, named after your script:

   ```
   copy templates\retry.test.js test\testRetry.retry.test.js
   ```

2. **Edit the `CONFIG` block** at the top of the copy. Nothing below it needs changing. At minimum, set:
   - `localDir`;
   - `script`;
   - `endpoint`;
   - `maxAttempts`;
   - the `valid` and `invalid` answers;
   - `expectSuccess` and `expectGaveUp`.

   The [CONFIG reference](#config-reference) covers every field.

3. **Run it:**

   ```
   node --test test\testRetry.retry.test.js
   ```

   Or `npx gws-test test\testRetry.retry.test.js` to also save the output to `logs\` (see [LOGS.md](LOGS.md)).

As shipped, the template tests [`examples/retry/local/get-token.js`](../examples/retry/local/get-token.js), so you can run it unchanged first to see what it does: `node --test templates/retry.test.js`.

**Where the copy lives decides two lines:**

| Your layout | `localDir` | Import |
|---|---|---|
| Inside this repo, `test\` next to `local\` | `path.join(__dirname, '..', 'local')` | `require('..')` (as shipped) |
| Your own project that installs gws-sim | the folder that stands for `local:///` | change to `require('gws-sim')` |

## How it works

**Answers have names.** `CONFIG.answers` defines what the endpoint can send back: `valid`, `invalid`, `error` (the connection fails) and `timeout` as shipped, plus any kinds you add.

**A sequence lists the answers in call order.** `['invalid', 'invalid', 'valid']` means:

1. the first call gets the `invalid` answer;
2. the second gets `invalid`;
3. the third and every later call get `valid`.

The last answer repeats for any further calls.

**The expected result comes from the first `valid` within `maxAttempts`.** If one is there, the script should succeed on that attempt, having made exactly that many calls. If not, it should give up after exactly `maxAttempts` calls. With `maxAttempts: 3`:

| Sequence | Expected result | Expected calls |
|---|---|---|
| `valid` | success on attempt 1 | 1 |
| `invalid → valid` | success on attempt 2 | 2 |
| `error → timeout → valid` | success on attempt 3 | 3 |
| `invalid → invalid → invalid → valid` | gives up; the 4th answer must never be requested | 3 |
| `invalid → error` | gives up (`error` repeats) | 3 |

## Generated tests

With the shipped `CONFIG`, the template generates these nine tests:

| Test name | Sequence | What it proves |
|---|---|---|
| `valid on attempt 1: valid` | `valid` | Stops after the first good answer |
| `valid on attempt 2: invalid -> valid` | `invalid, valid` | Retries after a bad answer |
| `valid on attempt 3: invalid -> invalid -> valid` | `invalid, invalid, valid` | Uses every attempt it's allowed |
| `gives up after 3 invalid answers` | `invalid ×3, valid` | Stops at the limit, even though a 4th call would succeed |
| `gives up after 3 connection errors` | `error ×3, valid` | Treats connection failures as failed attempts |
| one test per entry in `CONFIG.sequences` | as listed | Your own mixes, e.g. `timeout -> invalid -> valid` |
| `works in strict mode, as on DataPower` | `invalid, valid` | Runs with `'use strict'` added, as the appliance does |

The `valid on attempt N` tests run from 1 to `maxAttempts`. The connection-error test is generated only if `answers.error` exists, and the strict-mode test only if `strictMode` is true.

**Every test checks:**

1. the script didn't crash;
2. it didn't assign an undeclared variable, which works in the simulator but throws a `ReferenceError` on DataPower;
3. it called the endpoint exactly the expected number of times;
4. your `expectSuccess(res, attempt)` or `expectGaveUp(res)` passes.

## CONFIG reference

| Field | Type | Meaning |
|---|---|---|
| `localDir` | string | The folder that stands for `local:///`. See [Choosing the `local:///` folder](WALKTHROUGH.md#choosing-the-local-folder) |
| `script` | string | The script under test, as a `local:///` path, e.g. `'local:///testRetry.js'` |
| `request` | object | The second argument to `gw.run`: `input`, `headers`, `serviceVars`, `contexts`, `parameters` |
| `endpoint.method` | string | The HTTP method the script uses on the retried endpoint |
| `endpoint.target` | string or RegExp | The endpoint: an exact URL, a pattern with `*`, or a RegExp |
| `maxAttempts` | number | How many calls the script should make before giving up |
| `answers` | object | Named answers the endpoint can give. Each one is a reply `{ statusCode, headers, body }`, `{ error: 'message', errorCode? }` for a connection failure, or `{ timeout: true }` |
| `sequences` | array of arrays | Extra call sequences to test, by answer name |
| `expectSuccess(res, attempt)` | function | Assertions for a successful run. `attempt` is the attempt that got the valid answer |
| `expectGaveUp(res)` | function | Assertions for a run that gave up |
| `strictMode` | boolean | Also run the script with `'use strict'`, as DataPower does |
| `setup(gw)` | function | Mocks for any **other** backends the script calls, or other Gateway setup. Runs after the endpoint is mocked, so the endpoint's answers take priority |
| `gateway` | object | Extra `Gateway` options. `timerScale: 0.001` makes `setTimeout` backoff 1000x faster |

`expectSuccess` and `expectGaveUp` receive the run result, with `res.statusCode`, `res.output.text`, `res.output.json()`, `res.headers.response`, `res.logs` and more. See step 5 of the walkthrough, [Write automated tests](WALKTHROUGH.md#5-write-automated-tests), for what you can check on the result and how `assert.equal` and `assert.deepEqual` compare values.

## Recipes

**An HTTP error counts as invalid.** If your script treats a 401 as a failed attempt:

```js
invalid: { statusCode: 401, body: { error: 'unauthorized' } },
```

**More kinds of answer.** Add them to `answers` and use them by name in `sequences`:

```js
answers: {
  valid:   { statusCode: 200, body: { access_token: 'token_text' } },
  invalid: { statusCode: 200, body: { access_token: '' } },
  expired: { statusCode: 401, body: { error: 'token expired' } },
  busy:    { statusCode: 503, headers: { 'Retry-After': '1' }, body: '' },
  error:   { error: 'connection refused' },
  timeout: { timeout: true },
},
sequences: [
  ['busy', 'expired', 'valid'],
  ['expired', 'busy', 'timeout'],
],
```

**The script also calls other backends.** Only the retried endpoint is mocked for you; any other call has no mock and fails. Add the others in `setup`:

```js
setup(gw) {
  gw.urlopen.when('https://config.example.com/settings').reply(200, { region: 'us' });
},
```

**The script waits between attempts.** Retry backoff with `setTimeout` runs in real time unless you scale it. Keep `gateway: { timerScale: 0.001 }` so a 2-second wait takes 2 ms. Timers still fire in the same order. On a simulator version without `timerScale`, the option is ignored and tests just take longer.

**Checking the attempt number.** If the script reports which attempt succeeded, use the `attempt` argument:

```js
expectSuccess(res, attempt) {
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.output.json(), { token: 'token_text', attempts: attempt });
},
```

**Checking logs.** For example, that the script logs each failed attempt:

```js
expectGaveUp(res) {
  assert.equal(res.statusCode, 502);
  assert.equal(res.logs.filter((l) => /attempt \d+ failed/.test(l.message)).length, 3);
},
```

**The request matters.** If the script reads headers or service variables, set them in `request`:

```js
request: {
  input: { member: '12345' },
  headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': 'test-1' },
  serviceVars: { 'var://service/URI': '/roster/token' },
},
```

**Several retried endpoints.** One copy of the template covers one endpoint. For a script that retries two endpoints, make two copies, one per endpoint, and mock the other endpoint in each copy's `setup` with a plain valid reply.

## Reading a failure

A failed test says what went wrong, then shows the run. Here a script retried four times instead of three:

```
AssertionError [ERR_ASSERTION]: expected 3 call(s) to POST https://auth.example.com/token, got 4
  status 200, body "token_text"
  calls: POST https://auth.example.com/token -> 200; POST https://auth.example.com/token -> 200; POST https://auth.example.com/token -> 200; POST https://auth.example.com/token -> 200
```

The run summary shows:
- the status and body the script returned;
- every backend call, in order, with its result (`error` for a connection failure or timeout);
- any warnings and errors the script or the simulator logged.

For more, run the tests with `npx gws-test` and open `logs\latest\runs\<test file>.log`. Each run is labelled with its test (for example `"valid on attempt 2: invalid -> valid"`) and shows what was sent on each call, everything the script logged, and the full error. See [LOGS.md](LOGS.md).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every test fails; the calls line shows `-> error` for a URL that isn't your endpoint | The script calls another backend that isn't mocked. Add it in `setup` |
| Every test fails with 0 calls to the endpoint | `endpoint.method` or `endpoint.target` doesn't match what the script calls. The calls line shows the actual method and URL |
| Call counts are double or more what you expect | The library the script uses retries internally, so one attempt makes several calls. Set `maxAttempts` and the sequences to the number of calls, not attempts, or mock at the library's level |
| `the script assigned undeclared variable(s) ...` | Declare each named variable with `var`. On DataPower the script stops with a `ReferenceError` at that line |
| Only `works in strict mode` fails | Code that is legal only outside strict mode, such as a duplicate parameter name or writing to a read-only property. The error message names it |
| `CONFIG.sequences uses 'x', which isn't in CONFIG.answers` | A name in `sequences` has no entry in `answers` |
| Tests take seconds each | The script waits between attempts. Check that `gateway` has `timerScale: 0.001` |

## Limitations

- **One retried endpoint per copy.** Any other endpoints the script calls are mocked in `setup`, with fixed answers.
- **Outcome rule.** The expected outcome assumes the script stops at the first `valid` answer and gives up after `maxAttempts` calls. A script that, say, needs two valid answers in a row needs its own `expectSuccess`, `expectGaveUp` and test cases.
- **Strict mode is an approximation.** The strict-mode test adds `'use strict'` to the top of the script. DataPower's runtime may differ in other ways; see [What GatewayScript can `require()`](MODULES.md#language-level).
