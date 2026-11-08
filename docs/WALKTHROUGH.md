# Walkthrough: setting up and testing GatewayScripts

This guide takes you from a fresh checkout to a GatewayScript with automated tests that cover the happy path, backend errors, and bad input. It takes about 15 minutes.

Everything here uses the files in [`examples/walkthrough/`](../examples/walkthrough), so you can run each step as you read.

**You'll need:** Node.js 18 or later (`node --version`) and git. No DataPower appliance required.

---

## 1. Install

```bash
git clone https://github.com/johnsh16/datapower-simulator.git
cd datapower-simulator
npm install
npm test
```

The last line should end with `# pass 22` and `# fail 0`. If it does, the simulator is working.

## 2. How it fits together

On DataPower, a GatewayScript action receives a request, may call other services with `urlopen`, and writes a response. The simulator plays every part of that except your script:

```
  request you define          your script, unchanged          backends you define
 ┌──────────────────┐        ┌────────────────────────┐       ┌────────────────────┐
 │ input, headers,  │ ─────► │  greet.js              │ ────► │ gw.urlopen.when()  │
 │ service vars     │        │  session, hm, sm,      │ ◄──── │   .reply(...)      │
 └──────────────────┘        │  urlopen, console ...  │       └────────────────────┘
                             └───────────┬────────────┘
                                         ▼
                      result: statusCode, output, headers, logs, urlopenCalls
```

Three things to know:

- **`local:///` is a folder on your machine.** You choose it with the `localDir` option (or `--local-dir` on the command line). `local:///greet.js` then means `<localDir>/greet.js`, and `require('local:///lib/x.js')` works the same way.
- **Backends are fake by default.** Any `urlopen.open()` call that doesn't match a mock you set up fails with an error telling you exactly which URL was unmatched. Nothing reaches the real network unless you ask for it.
- **Scripts need no changes.** Write them exactly as you would for the appliance. The same file runs in both places.

## 3. Meet the example script

[`examples/walkthrough/local/greet.js`](../examples/walkthrough/local/greet.js) reads `{ "name": "ada" }`, looks the user up in a profile service, and returns a greeting. It handles four outcomes:

| Situation | Response |
|---|---|
| Profile found | `200` `{ "message": "Hello, Ada Lovelace!" }` |
| Profile service returns 404 | `404` `{ "error": "no such user" }` |
| Profile service unreachable, slow, or sends invalid JSON | `502` `{ "error": "profile service unavailable" }` |
| Request body isn't valid JSON with a name | `400` with an error message |

Open the file and skim it. It uses `session.input`, `header-metadata`, `service-metadata`, `urlopen`, and `console`, which covers most real scripts.

## 4. Run it from the command line

The quickest way to try a script is `bin/gws-run.js`. Give it the script, a request body, and a file of mock backend responses:

```bash
node bin/gws-run.js examples/walkthrough/local/greet.js \
  --input examples/walkthrough/request.json \
  --headers examples/walkthrough/headers.json \
  --mocks examples/walkthrough/mocks.json
```

You should see:

```
=== 200 OK
response headers: { 'Content-Type': 'application/json' }
output: {"message":"Hello, Ada Lovelace!"}
urlopen: GET https://profiles.example.com/users/ada -> 200
```

The mocks file is plain JSON. The first entry that matches a request answers it:

```json
[
  { "match": { "method": "GET", "target": "https://profiles.example.com/users/ada" },
    "response": { "statusCode": 200, "body": { "displayName": "Ada Lovelace" } } },
  { "match": "https://profiles.example.com/users/*",
    "response": { "statusCode": 404 } }
]
```

Now try the other paths. `--input` also accepts literal JSON, and `--log info` prints the script's `console` output:

```bash
# unknown user: the second mock (wildcard) answers with 404
node bin/gws-run.js examples/walkthrough/local/greet.js --input '{"name":"zed"}' \
  --mocks examples/walkthrough/mocks.json --log info

# no mocks at all: the call is unmatched, so the script takes its 502 path
node bin/gws-run.js examples/walkthrough/local/greet.js --input '{"name":"ada"}' --log error
```

Add `--json` to any command to see the full result, including service variables and every log line.

**All CLI options**

| Option | What it sets |
|---|---|
| `--input <file or text>` | Request body (`session.input`) |
| `--headers <file.json>` | Request headers (`hm.original` / `hm.current`) |
| `--service-vars <file.json>` | Service variables, e.g. `{ "var://service/URI": "/orders" }` |
| `--contexts <file.json>` | Named contexts produced by earlier actions |
| `--params <file.json>` | `session.parameters` |
| `--mocks <file.json or .js>` | Backend responses |
| `--local-dir <dir>` | Folder for `local:///` (defaults to the script's folder) |
| `--passthrough` | Send unmatched requests to the real network |
| `--log <level>` | Print logs at this level and above |
| `--json` | Print the full result as JSON |

## 5. Write automated tests

The command line is good for exploring. For anything you want to keep, write tests so every scenario is checked each time you change the script. Open [`examples/walkthrough/greet.test.js`](../examples/walkthrough/greet.test.js) and run it:

```bash
npm run test:walkthrough
# same as: node --test examples/walkthrough/greet.test.js
```

You should see five passing tests.

Each test follows the same three steps:

```js
test('greets a known user', async () => {
  // 1. Arrange: create a gateway and describe how the backend behaves
  const gw = newGateway();
  gw.urlopen.when('https://profiles.example.com/users/ada')
    .reply(200, { displayName: 'Ada Lovelace' });

  // 2. Act: run the script with a request
  const res = await gw.run('local:///greet.js', {
    input: { name: 'ada' },
    headers: { 'X-Correlation-Id': 'abc-123' },
  });

  // 3. Assert: check the response and what the script sent
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.output.json(), { message: 'Hello, Ada Lovelace!' });
  assert.equal(res.urlopenCalls[0].getHeader('X-Correlation-Id'), 'abc-123');
});
```

Create a new `Gateway` in each test so mocks from one test never leak into another.

**What you can check on the result**

| Property | Meaning |
|---|---|
| `res.statusCode`, `res.reasonPhrase` | Status returned to the client |
| `res.output.json()`, `.text`, `.xml()` | What the script wrote to `session.output` |
| `res.headers.response`, `.current` | Response headers, and headers forwarded to the backend |
| `res.urlopenCalls` | Every outbound call: `method`, `target`, `getHeader()`, `json()`, `body`, `response` |
| `res.logs`, `res.logsAt('error')` | Everything logged with `console` |
| `res.serviceVars` | Service variables after the run, e.g. `skip-backside` |
| `res.contexts` | Every context, with its body and variables |
| `res.rejected`, `res.rejectReason` | Whether the script called `session.reject()` |
| `res.error` | An uncaught exception, if the script crashed |

## 6. Simulate the backend misbehaving

Most production bugs live in error handling, which is hard to trigger against a real backend. With mocks, each failure is one line:

```js
gw.urlopen.when(url).reply(404);                          // an HTTP error status
gw.urlopen.when(url).reply(500, '<fault/>');              // an error with a body
gw.urlopen.when(url).timeout();                           // no answer before options.timeout
gw.urlopen.when(url).error('connection refused');         // can't connect at all
gw.urlopen.when(url).reply(200, 'not json');              // a malformed body
```

The malformed-body case is worth a test in every script. An early version of `greet.js` ignored the error from `resp.readAsJSON()`, so a backend returning `200 not json` crashed the script with a `500`. The test `returns 502 when the profile service sends invalid JSON` caught it, and checks `res.error` is `null` to prove the failure was handled rather than thrown.

For scripts that retry, queue responses in order. Here the first two calls get a 503 and the third succeeds:

```js
gw.urlopen
  .when(url).times(2).reply(503)
  .when(url).reply(200, { ok: true });
```

To make the response depend on the request, pass a function:

```js
gw.urlopen.when('https://profiles.example.com/users/*')
  .reply((req) => ({ statusCode: 200, body: { displayName: req.target.split('/').pop() } }));
```

Matchers can be an exact URL, a `*` wildcard, a regular expression, an object such as `{ method: 'POST', target: /token/, headers: { authorization: /^Bearer / } }`, or a function of the request. Timeouts are simulated quickly, so tests don't actually wait.

## 7. Recreate your service's environment

Real scripts often depend on more than the request body. Pass whatever your script reads:

```js
await gw.run('local:///orders.js', {
  input: { sku: 'X1' },
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
  serviceVars: {
    'var://service/URI': '/orders/42',
    'var://service/protocol-method': 'PUT',
  },
  contexts: {
    // output of an earlier action in the rule
    tokenResponse: { body: { access_token: 'abc' }, variables: { cached: true } },
  },
  parameters: { environment: 'test' },    // session.parameters
});
```

Your script then sees `sm.URI === '/orders/42'`, `session.name('tokenResponse')` returns that context, and so on. Seed every service variable your script reads, because the simulator's defaults are only placeholders.

Shared code in `local:///` works as on the appliance, so `require('local:///lib/config.js')` loads `<localDir>/lib/config.js`.

## 8. Testing your own scripts

1. Copy your scripts into a folder, keeping the same layout they have under `local:///` on the appliance.
2. Create a test file next to them and point `localDir` at that folder.
3. Write one test for the normal case, then one for each failure your script handles: each error status, a timeout, a connection failure, and bad input.
4. Run `node --test path/to/your.test.js` after every change.

When the tests pass, deploy the same script files to DataPower. No edits are needed.

## 9. Troubleshooting

| Message or symptom | What it means |
|---|---|
| `urlopen: no mock matched GET https://...` | The script called a URL you didn't mock. Check `res.urlopenCalls` to see the exact URL and method, then add a matching `when()`. |
| `Cannot find module 'local:///...'` | `localDir` points at the wrong folder. It should be the folder that `local:///` maps to. |
| `Cannot find module 'lodash'` | npm packages aren't available on DataPower, so they're refused here too. |
| `module 'mq' ... is not emulated` | `jose`, `mq`, `sql`, `ssh` and `b2b` need appliance objects. Provide a fake with `new Gateway({ modules: { mq: {...} } })`. |
| `transform.xslt: no simulated handler` | Stylesheets aren't executed. Register the result: `gw.transforms['local:///map.xsl'] = (doc, params) => '<out/>'`. |
| `did not complete within 30000ms` | Something kept running, usually a `setInterval` that was never cleared or a callback that was never called. |
| Output is empty | Check `res.rejected` and `res.error`. Output written after `session.reject()` is discarded. |

## 10. Where to go next

- The [README](../README.md) is the full reference for every module, mock option, and setting.
- [`examples/local/orchestrate.js`](../examples/local/orchestrate.js) is a larger example: it fetches an OAuth token, calls a backend, and retries on 503. [`examples/run-example.js`](../examples/run-example.js) runs it.
- [`test/gateway.test.js`](../test/gateway.test.js) has a test for each simulated feature, which makes it a good source of copy-paste snippets.
