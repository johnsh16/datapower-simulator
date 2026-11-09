# gws-sim — DataPower GatewayScript simulator for Node.js

Run DataPower GatewayScript actions locally, unchanged, with the appliance's globals and modules emulated and every `urlopen.open()` answered by responses you define.

**New here?** Start with the [step-by-step walkthrough](docs/WALKTHROUGH.md).

**Testing your own script?** Run `npx gws-new-test` (or `npm run new-test` in this repo). It asks a few questions, finds the backends your script calls, and writes a test file that already passes. See [step 8 of the walkthrough](docs/WALKTHROUGH.md#8-create-a-test-for-your-own-script).

```bash
npm install
npm test                       # simulator and test-generator tests
node examples/run-example.js   # token + backend orchestration with a retried 503
```

## Quick start

```js
const { Gateway } = require('gws-sim');

const gw = new Gateway({ localDir: './local' });          // local:/// maps here: same layout as the appliance's local:

gw.urlopen
  .when({ method: 'POST', target: 'https://auth/token' }).reply(200, { access_token: 'abc' })
  .when('https://backend/orders*').reply(201, { id: 'O1' }, { 'X-Trace': '9' });

const res = await gw.run('local:///orchestrate.js', {
  input: { sku: 'X1' },                                    // session.input (object, string, Buffer, XML Document)
  headers: { 'Content-Type': 'application/json' },        // header-metadata original/current
  serviceVars: { 'var://service/URI': '/orders' },        // service-metadata
});

res.statusCode;        // 201 (hm.response.statusCode, 500 on reject/throw, else 200)
res.output.json();     // session.output as JSON  (also .text, .body, .xml())
res.headers.response;  // hm.response headers;  also .current, .original
res.urlopenCalls;      // every outbound request with method, target, headers, body, response
res.logs;              // console output: [{ level, category, message, time }]
res.rejected, res.rejectReason, res.error, res.serviceVars, res.contexts
```

Or from the command line:

```bash
node bin/gws-run.js examples/local/orchestrate.js \
  --input examples/request.json --service-vars examples/service-vars.json \
  --mocks examples/mocks.json --log info
```

## Simulating backend responses (`urlopen.open`)

Routes are checked in registration order; the first one that matches and isn't used up answers.

| Matcher | Example |
|---|---|
| exact URL / glob | `when('https://api/users/*')` |
| RegExp | `when(/\/users\/\d+$/)` |
| object | `when({ method: 'POST', target: /token/, headers: { authorization: /^Bearer / }, body: { type: 'x' } })` — `body` as object = partial JSON match |
| function | `when(req => req.json().id === 7)` |

| Response | Example |
|---|---|
| status, body, headers | `.reply(200, { ok: true }, { ETag: 'v1' })` — objects become JSON; Content-Type is inferred |
| full spec | `.reply({ statusCode: 404, reasonPhrase: 'Gone', body: '<err/>' })` |
| dynamic | `.reply(req => ({ statusCode: 201, body: req.json() }))` (may be async) |
| connection error | `.error('connection refused', '0x80e00001')` → callback gets `(err)` with `errorMessage` / `errorCode` |
| timeout | `.delay(10000).reply(200)` when `options.timeout` is shorter, or `.timeout()` → error with `type: 'timeout'` |
| sequences | `.times(2).reply(503)` then another `when(...).reply(200)`; `replyOnce`, `errorOnce` |

`req` (also what's in `res.urlopenCalls`) has `target`, `method`, `headers`, `getHeader(name)`, `data` (Buffer), `body`, `json()`, `xml()`, `timeout`, `sslClientProfile`, and the raw `options`.

Unmatched requests fail with *"no mock matched GET https://…"* by default. Change with `gw.urlopen.onUnmatched = 'passthrough'` (real network) or a function `req => spec`. `local:///` and `store:///` targets read files from `localDir` / `storeDir` when not mocked.

Mocks can also come from fixture files — `new Gateway({ mocks: [...] })`, `gw.urlopen.load([...])`, or `runOptions.mocks`:

```json
[{ "match": { "method": "GET", "target": "https://api/*" }, "times": 1,
   "response": { "statusCode": 200, "headers": { "X-A": "1" }, "body": { "ok": true } } },
 { "match": "https://down/", "error": "connection refused" },
 { "match": "https://slow/", "timeout": true }]
```

Mocked delays are capped at 25 ms (`maxSimulatedDelayMs`) so timeout tests stay fast; set `realDelays: true` to wait for real. `gw.urlopen.reset()` clears routes and calls; `gw.urlopen.pendingRoutes()` lists `times()`/`once()` routes that were never consumed.

## What's emulated

**Globals:** `session`, `console`, `XML`, `Buffers`, `Buffer`, `require`, `module`/`exports`, `setTimeout`/`setInterval`/`setImmediate` (+ clears). The run finishes when all async work completes, like a transaction.

| Area | Coverage |
|---|---|
| `session` | `input`, `output`, `name()`, `createContext()`, `parameters`, `reject()` |
| Contexts | `readAsBuffer/Buffers/JSON/XML` (callback or Promise), `write()` (replaces, set `appendOutput` to append), `setVariable/getVariable/deleteVariable` (+ `setVar/getVar`) |
| `console` | `debug/info/log/notice/warn/error/critical/alert/emerg/trace`, `console.options({ category })` |
| `header-metadata` | `original` (read-only), `current`, `response`: `get()`, `get(name)` (case-insensitive), `set`, `remove`, `headers`, `statusCode` (`404` or `'404 Not Found'`), `reasonPhrase` |
| `service-metadata` | `getVar/setVar/list`, camelCase properties derived from any `var://service/…` path (`sm.protocolMethod`, `sm.URI`, `sm.URLIn`, `sm.mpgw.skipBackside = true`), plus `var://context/…`, `var://local/…`, `var://system/…` |
| `system-metadata` | `getVar/setVar/list`, plus `getVariable/setVariable` |
| `fs` | DataPower's `fs` (not Node's): `readFile`, `readAsJSON`, `readAsXML`, `exists`, `writeFile`, `appendFile`, `rename`, `truncate`, `unlink`. Reads `local:`, `store:`, `temporary:`; writes `temporary:` only, with a `TTL` in seconds (default 10, `0` keeps the file). `temporary:///` is shared by all runs of a `Gateway`, so files outlive one transaction |
| `sprintf` | `sprintf()` / `vsprintf()` with the documented specifiers, flags, and `%2$s` argument swapping |
| `urlopen` | `open(options|target, cb)` — fully mockable as above |
| `transform` | `xpath()` evaluated for real; `xslt()`/`xquery()` call handlers you register: `gw.transforms['local:///x.xsl'] = (doc, params) => result` |
| `multistep` | `callRule()` calls `gw.rules[name] = async (inputCtx, outputCtx) => {}` |
| `apim` | `getvariable/setvariable`, `output()`, `error()`, `readInputAs*` (API Connect policies) |
| `crypto` | Node crypto; `'name:key'` references resolve from `gw.keys` |
| `jwt` | `JWTEncoder` / `JWTDecoder` with sign/verify/validate for HS/RS/PS/ES — an approximation of the appliance API; JWE not emulated |
| `util` | The documented DataPower set: `format`, `inspect`, `inherits`, `isArray`, `isDate`, `isError`, `isRegExp`, and the XML helpers `isNode`, `isNodeList`, `isNamedNodeMap`. Other Node `util` functions work with a warning |
| Node subset | Documented for DataPower: `assert`, `punycode`, `querystring`, `url` (plus the `Buffer` global). `buffer`, `events`, `path`, `string_decoder`, `zlib` aren't in DataPower's documentation; they load with a warning |
| `require()` | `local:///`, `store:///`, relative paths. npm packages are refused (as on the appliance) unless `allowNodeModules: true` |

**Not emulated:** `jose`, `jwk`, `apigw`, `ratelimit`, `json-xml-converter`, `mgmt`, and `policy-utility` exist on DataPower but depend on appliance objects or configuration. They load, and any call explains how to supply your own with `new Gateway({ modules: { ratelimit: { … } } })`. Any module can be replaced this way (a function value is called with the run environment as a factory). `fs.temporary` and `util.safeTypeOf` are listed for DataPower but undocumented in the sources used, so they throw a clear error.

Which modules DataPower provides, with sources and confidence levels: [docs/MODULES.md](docs/MODULES.md).

## Gateway options

`localDir` (the folder that stands for `local:///`; it must hold files in the same layout as the appliance, so `local:///lib/x.js` is `<localDir>/lib/x.js`), `storeDir`, `temporaryDir`, `printLogs` (`true` or a level), `appendOutput`, `allowNodeModules`, `maxSimulatedDelayMs`, `realDelays`, `timeoutMs` (default 30 s; a run that never finishes fails), `serviceVars` / `systemVars` (defaults for every run), `modules`, `globals`, `mocks`, `transforms`, `rules`, `keys`.

## Run options

`input`, `headers` (plain object, or `{ original, current, response }`), `serviceVars`, `systemVars`, `contexts` (`{ name: body }` or `{ name: { body, variables } }`), `parameters`, `apim` (variable tree), `mocks`, `transforms`, `rules`, `modules`, `globals`, `timeoutMs`.

## Using it with a test runner

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { Gateway } = require('gws-sim');

test('returns 504 when the backend times out', async () => {
  const gw = new Gateway({ localDir: './local' });
  gw.urlopen.when(/token/).reply(200, { access_token: 't' }).when(/orders/).timeout();
  const res = await gw.run('local:///orchestrate.js', { input: {}, serviceVars: { 'var://service/URI': '/orders' } });
  assert.equal(res.statusCode, 504);
});
```

Works the same under Jest or Mocha.

### Retry template

[`templates/retry.test.js`](templates/retry.test.js) tests a script that calls one endpoint several times until it gets a good answer. Copy it, fill in its `CONFIG` block (script, endpoint, attempt limit, valid and invalid answers, expected success and give-up results), and it generates a test per scenario: valid on each attempt, giving up, never calling past the limit, your own call sequences, and strict mode. See [the walkthrough](docs/WALKTHROUGH.md#6-simulate-the-backend-misbehaving).

**Undeclared variables.** Scripts share Node's global object, so after each run the simulator removes any global the script created, so state can't leak into the next run. It also logs a warning and lists the names in `res.leakedGlobals`. On DataPower, which runs GatewayScript in strict mode, the same assignment throws a `ReferenceError`.

## Profiling

`gws-run --profile` runs a script a few hundred times against your mocks and reports CPU time per line, memory allocated per function, V8 deoptimizations, how long each callback blocks, and findings from the performance checklist (input read twice, `require()` in callbacks, `urlopen` without a timeout, large context variables, leaks, and more):

```bash
node bin/gws-run.js examples/profiling/local/slow-report.js \
  --input examples/profiling/request.json --mocks examples/profiling/mocks.js --profile
```

See [docs/PROFILING.md](docs/PROFILING.md) for how to read the report.

## Known differences from the appliance

- Default service variable values are placeholders; seed the ones your script depends on.
- XSLT/XQuery are not executed — you register the result each stylesheet should produce.
- Error codes are representative, not the exact codes firmware would log.
- Scripts run in the same Node process (not sandboxed), so they can reach Node globals DataPower doesn't have — the simulator won't catch that.
