# Walkthrough: setting up and testing GatewayScripts

This guide takes you from a fresh checkout to a GatewayScript with automated tests that cover the happy path, backend errors, and bad input. It takes about 15 minutes.

> **Just want a test for your own script?** Install (step 1), then jump to [step 8](#8-create-a-test-for-your-own-script). The test generator asks a few questions and writes a passing test file for you.

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

The output should end with `# pass 29` and `# fail 0`. If it does, the simulator is working.

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

- **`local:///` is a folder on your machine.** On DataPower, `local:///` is your domain's `local:` directory. Here you point it at a folder on your computer that holds the same files in the same layout, using the `localDir` option or `--local-dir` on the command line. See [Choosing the `local:///` folder](#choosing-the-local-folder) below.
- **Backends are fake by default.** Any `urlopen.open()` call that doesn't match a mock you set up fails with an error telling you exactly which URL was unmatched. Nothing reaches the real network unless you ask for it.
- **Scripts need no changes.** Write them exactly as you would for the appliance. The same file runs in both places.

### Choosing the `local:///` folder

The folder you give for `local:///` must:

- **be a folder, not a file**, given relative to the directory you run the command from, or as an absolute path;
- **contain your script**, directly or in a subfolder;
- **mirror the appliance's layout**, so every `local:///...` path your script uses exists at the same place under it.

For example, with this project:

```
my-gateway/              <- you run commands here
└── local/               <- local:/// is this folder: --local-dir local
    ├── apis/orders.js   <- the script is local:///apis/orders.js
    └── lib/util.js      <- require('local:///lib/util.js') finds this file
```

| If you give | The script is | `local:///lib/util.js` resolves to | Works? |
|---|---|---|---|
| `local` | `local:///apis/orders.js` | `local/lib/util.js` | yes |
| `local/apis` | `local:///orders.js` | `local/apis/lib/util.js` | no, file missing |
| `.` | `local:///local/apis/orders.js` | `./lib/util.js` | no, file missing |
| `local/apis/orders.js` | | | no, that's a file |

You usually don't need to choose. When you leave it out, the tools pick the deepest folder above your script where every `local:///` file the script mentions exists, which is the first row here. The test generator shows this suggestion, explains the rules, and checks your answer before going on.

## 3. Meet the example script

[`examples/walkthrough/local/greet.js`](../examples/walkthrough/local/greet.js) reads `{ "name": "ada" }`, looks the user up in a profile service, and returns a greeting. It handles four outcomes:

| Situation | Response |
|---|---|
| Profile found | `200` `{ "message": "Hello, Ada Lovelace!" }` |
| Profile service returns 404 | `404` `{ "error": "no such user" }` |
| Profile service unreachable, slow, returns a server error, or sends invalid JSON | `502` `{ "error": "profile service unavailable" }` |
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
| `--local-dir <dir>` | The folder that stands for `local:///` (see [above](#choosing-the-local-folder)). Defaults to the folder that makes the script's `local:///` paths resolve. |
| `--passthrough` | Send unmatched requests to the real network |
| `--log <level>` | Print logs at this level and above |
| `--json` | Print the full result as JSON |

## 5. Write automated tests

The command line is good for exploring. For anything you want to keep, write tests so every scenario is checked each time you change the script. Open [`examples/walkthrough/greet.test.js`](../examples/walkthrough/greet.test.js) and run it:

```bash
npm run test:walkthrough
# same as: node --test examples/walkthrough/greet.test.js
```

You should see six passing tests.

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

## 8. Create a test for your own script

You don't have to start from a blank file. The test generator reads your script, runs it once to find the backends it calls, and writes a test file that already passes.

**1. Put your scripts in a folder.** Keep the layout they have under `local:///` on the appliance, so `require('local:///lib/util.js')` still resolves. For example:

```
my-gateway/
└── local/
    ├── orders.js
    └── lib/util.js
```

**2. Run the generator and answer its questions.**

```bash
npx gws-new-test                 # if you installed gws-sim in your own project
npm run new-test                 # inside this repository
```

It asks, one at a time:

| Question | What to give it |
|---|---|
| Which script? | The `.js` file. It lists the GatewayScripts it finds. |
| Where is `local:///`? | The folder from step 1 (`local` in the example), relative to where you ran the command. Press Enter to accept the suggestion. If the answer can't be right (it's a file, doesn't contain the script, or is missing a `local:///` file the script uses), it tells you why and asks again. |
| A sample request body | A realistic request, pasted on one line or as a file path. This matters: it decides which path through your script runs. |
| Service variables | Shown only if your script reads them, such as `var://service/URI`. Press Enter to keep a default. |
| Where to save the test | Press Enter for `test/<script>.test.js`. |
| What each backend sends back | Asked for every `urlopen` call it finds. Paste a real response body, or press Enter for a placeholder you can fill in later. |

Then it writes the file, runs it, and tells you what to look at:

```
Created test/orders.test.js with 6 tests (all 6 passing).

Backends it mocks:
  POST https://auth.example.com/oauth2/token
  POST https://orders.example.com/orders

Next steps:
  1. Open test/orders.test.js and work through the TODO comments.
  2. Run it:  node --test test/orders.test.js
```

**3. Read what you got.** The file contains one test per situation, each checking what your script does today:

- a normal request
- each backend failing with a 500
- each backend timing out
- a request body that isn't valid JSON or XML (if your script reads one)

Each test pins the status code, the response body, and which backends were called. If a later change alters any of that, the test fails and shows the difference. Values that change on every run, like timestamps, are left out automatically.

**4. Act on the warnings.** The generator points out two kinds of problem:

- *"the script crashed"*: in that situation your script throws instead of responding. The matching test fails until you fix the script. If it only crashes on the normal request, the cause is usually a placeholder backend response missing a field your script reads. Paste a real response into `BACKENDS` in the test file.
- *"a backend failed but the client still got 200"*: your script hides a failure from its caller. Sometimes that's intended, but it's worth a look. The generator found exactly this in an earlier version of `greet.js`, which answered "Hello, undefined!" when the profile service returned a 500.

**5. Make it yours.** Search the file for `TODO` and replace placeholders with realistic data. To add another case, copy a test and change the request or the backend it overrides. Everything from steps 5 to 7 above works in these files.

Prefer no questions? Pass everything as options:

```bash
npx gws-new-test local/orders.js --yes \
  --input request.json --service-vars service-vars.json --out test/orders.test.js
```

Run `npx gws-new-test --help` for every option. Once your tests pass, deploy the same script files to DataPower. No edits are needed.

## 9. Troubleshooting

| Message or symptom | What it means |
|---|---|
| `urlopen: no mock matched GET https://...` | The script called a URL you didn't mock. Check `res.urlopenCalls` to see the exact URL and method, then add a matching `when()`. |
| `Cannot find module 'local:///...'` | `local:///` points at the wrong folder, often one level too deep. It must be the folder whose layout matches the appliance's `local:`; see [Choosing the `local:///` folder](#choosing-the-local-folder). |
| `--local-dir ...: <script> isn't inside ...` | The folder you gave doesn't contain the script. Give the script's folder or one of its parents. |
| `Cannot find module 'lodash'` | npm packages aren't available on DataPower, so they're refused here too. |
| `module 'mq' ... is not emulated` | `jose`, `mq`, `sql`, `ssh` and `b2b` need appliance objects. Provide a fake with `new Gateway({ modules: { mq: {...} } })`. |
| `transform.xslt: no simulated handler` | Stylesheets aren't executed. Register the result: `gw.transforms['local:///map.xsl'] = (doc, params) => '<out/>'`. |
| `did not complete within 30000ms` | Something kept running, usually a `setInterval` that was never cleared or a callback that was never called. |
| Generated test says *"the script crashed"* | See step 8, part 4: fix the script, or replace a placeholder backend response with a real one. |
| Generator found no backend calls | Your sample request probably took an early exit (like a 400). Run it again with a more realistic `--input`. |
| Output is empty | Check `res.rejected` and `res.error`. Output written after `session.reject()` is discarded. |

## 10. Where to go next

- The [README](../README.md) is the full reference for every module, mock option, and setting.
- [`examples/local/orchestrate.js`](../examples/local/orchestrate.js) is a larger example: it fetches an OAuth token, calls a backend, and retries on 503. [`examples/run-example.js`](../examples/run-example.js) runs it.
- [`test/gateway.test.js`](../test/gateway.test.js) has a test for each simulated feature, which makes it a good source of copy-paste snippets.
