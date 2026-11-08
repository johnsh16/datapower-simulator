# Test helpers

`require('gws-sim/testing')` gives you two things:

- **`expectRun(res)`**: one-line checks on a run's outcome, response, backend calls, logs, variables and files. When one fails, the message shows the whole run, so you rarely need to add `console.log` to find out why.
- **Setup shortcuts**: build requests, share backend mocks between tests, simulate failing or slow backends, and control time for `fs` TTLs.

They throw Node's `AssertionError`, so they work with `node:test`, Jest, Mocha or any other runner.

```js
const test = require('node:test');
const { expectRun, gatewayFactory, request } = require('gws-sim/testing');

const newGateway = gatewayFactory({ localDir: 'local' }, (gw) => {
  gw.urlopen.when(/oauth2\/token/).replyJson({ access_token: 't' });
  gw.urlopen.when('https://orders.example.com/orders').replyJson({ id: 'O1', state: 'NEW' }, 201);
});

test('creates an order', async () => {
  const res = await newGateway().run('local:///orchestrate.js',
    request.json({ sku: 'X1' }, { method: 'POST', uri: '/orders' }));

  expectRun(res)
    .succeeded()
    .status(201)
    .json({ orderId: 'O1', status: 'NEW' })
    .sentToBackend('POST', /orders/, { headers: { Authorization: 'Bearer t' }, json: { sku: 'X1' } });
});
```

In this repository, import from `'../testing'` (or the right relative path) instead of `'gws-sim/testing'`. [`examples/walkthrough/greet.helpers.test.js`](../examples/walkthrough/greet.helpers.test.js) is the walkthrough's test file rewritten with the helpers; compare it with [`greet.test.js`](../examples/walkthrough/greet.test.js).

## When a check fails

```
Expected status 201 but got 504

Run:
  status:   504 Gateway Timeout
  body:     "{\"error\":\"backend unavailable\"}"
  backends:
            POST https://auth.example.com/oauth2/token -> 200
            POST https://orders.example.com/orders -> error
  logs:
            [error] backend call failed: connection refused
```

Every failure ends with this summary: status, error or reject reason, body, response headers, each backend call with its result (and any that matched no mock), and warning or error logs.

## `expectRun(res)` checks

Each check returns the same object, so they chain. Wherever a check takes an expected value, you can pass:

- **a value**, which must match exactly;
- **a RegExp**, tested against the text;
- **a function**, used as a predicate.

Objects passed to `jsonIncludes`, `sentToBackend` and `wroteFile` match **partially**: extra fields in the actual value are fine.

**Outcome**

| Check | Passes when |
|---|---|
| `.succeeded()` | No uncaught error and no `session.reject()` |
| `.rejected(reason?)` | `session.reject()` was called (with a matching reason) |
| `.crashed(message?)` | The script threw (with a matching message) |
| `.clean()` | Succeeded, and nothing logged at warning level or worse. This includes the simulator's warnings about modules DataPower may not have |

**Response**

| Check | Passes when |
|---|---|
| `.status(code, reason?)` | The status code (and reason phrase) sent to the client |
| `.header(name, value?)` | A response header is set (and matches); the name is case-insensitive |
| `.noHeader(name)` | A response header isn't set |
| `.forwardedHeader(name, value?)` | A header in `hm.current`, i.e. sent on to the backend |
| `.json(expected)` | The body is JSON equal to `expected` (RegExp and function values inside it act as matchers) |
| `.jsonIncludes(partial)` | The body is JSON containing these fields |
| `.text(expected)` | The body text |
| `.xpath(expr, expected?)` | XPath on an XML body, e.g. `.xpath('string(//id)', '7')`; without `expected`, that it selects something |

**Backend calls.** A target is an exact URL, a pattern with `*`, or a RegExp. The method is optional.

| Check | Passes when |
|---|---|
| `.calledBackend([method,] target, { times }?)` | The script called it (exactly `times` times) |
| `.notCalledBackend([method,] target)` | The script didn't call it |
| `.backendCalls(['POST https://...', /orders/])` | The exact sequence of calls |
| `.sentToBackend([method,] target, checks)` | The first matching call (or `{ call: n }`) was sent `headers: {...}`, `json: {...}`, `body: string or RegExp`, or `timeout: seconds` |

**Logs, variables and files**

| Check | Passes when |
|---|---|
| `.logged([level,] text)` | A log message (at that level) matches |
| `.notLogged(level or text)` | No message at that level, or matching that text |
| `.serviceVar(name, value?)` | A service variable after the run, e.g. `'var://service/mpgw/skip-backside'` |
| `.contextVar(context, name, value?)` | A context variable |
| `.wroteFile(url, { json } or { text }?)` | A file exists after the run (and its contents match), e.g. one written with `fs` to `temporary:///`. Respects TTLs |
| `.noFile(url)` | No file there, or its TTL has passed |

## Setup shortcuts

**`gatewayFactory(options, sharedSetup)`** returns a function that makes a fresh `Gateway` for each test, so mocks never leak between tests. Mocks added in the per-test function are registered first, so they win over the shared ones:

```js
const newGateway = gatewayFactory({ localDir: 'local' }, (gw) => {
  gw.urlopen.when(/token/).replyJson({ access_token: 't' });      // every test
});
const gw = newGateway((gw) => gw.urlopen.when(/orders/).down());  // just this test
```

**`request.*`** builds the second argument to `gw.run()`. Each one sets the body and `Content-Type`. The last argument can add `method`, `uri` and `url` (which become service variables), `headers`, and any other run option (`contexts`, `parameters`, ...):

```js
request.json({ sku: 'X1' }, { method: 'POST', uri: '/orders', headers: { Authorization: 'Bearer t' } })
request.xml('<order><id>7</id></order>')
request.form({ grant_type: 'client_credentials' })
request.text('hello')
request.empty({ uri: '/health' })            // GET with no body
```

**Backend replies** chain onto `gw.urlopen.when(...)`, alongside `reply`, `error`, `timeout`, `delay` and `times`:

| Shortcut | What the script sees |
|---|---|
| `.replyJson(body, status = 200, headers?)` | A JSON response |
| `.replyXml(xml, status = 200, headers?)` | An XML response |
| `.replyText(text, status = 200, headers?)` | A text response |
| `.replyStatus(status, body?)` | Just a status, e.g. `204` or `503` |
| `.replySequence([spec, spec, ...])` | One reply per call, in order; the last repeats. Entries can be functions of the request |
| `.failFirst(n, failure = 503)` | `n` failures, then whatever you chain next. `failure` can be a status, `'down'`, `'timeout'` or a reply spec |
| `.down(message?)` | A connection error: the backend is unreachable |
| `.slow(ms)` | The answer arrives after `ms`. Longer than the script's `timeout` means a timeout |

```js
gw.urlopen.when(/orders/).failFirst(2).replyJson({ id: 'O1' });         // 503, 503, then 200
gw.urlopen.when(/token/).replySequence([{ statusCode: 401 }, { statusCode: 200, body: { access_token: 'new' } }]);
```

**Time and files**

- `advanceTime(gw, seconds)` moves the clock `fs` TTLs use, without waiting.
- `seedTemporary(gw, files, { ttl })` puts files in `temporary:///` before a run, as an earlier transaction would have. Objects are written as JSON; `ttl` defaults to 0 (kept).

```js
seedTemporary(gw, { 'token.json': { token: 'cached' } }, { ttl: 300 });
expectRun(await gw.run('local:///main.js')).notCalledBackend(/token/);  // uses the cached token
advanceTime(gw, 301);
expectRun(await gw.run('local:///main.js')).calledBackend(/token/);     // cache expired
```

**`matches(actual, expected)`** is the matching rule the checks use, exported for your own assertions.
