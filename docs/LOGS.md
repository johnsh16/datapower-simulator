# Test logs

Run your tests with `gws-test` and everything they printed, plus a record of every script run, is saved to a `logs` folder at the root of your project. When a test fails, you can open the log to see what the script was sent, what each backend returned and what the script logged, without rerunning anything.

```bash
npm test                                   # in this repo
npx gws-test                               # in your own project: runs test/*.test.js
npx gws-test test/testRetry.test.js        # some files
npx gws-test -- --test-name-pattern=token  # anything after -- goes to node --test
```

The terminal shows the same output as `node --test`. The runner then prints where the logs went:

```
Logs: logs/2026-11-08_22-45-55/  (results.log, runs/ for 3 test file(s); also logs/latest/)
```

## What's in the folder

Each run gets its own folder, named for the local date and time it started, so earlier runs are kept:

```
logs/
  2026-11-08_22-45-55/
    results.log              what the terminal showed: each test, pass/fail, failure messages, exit code
    runs/
      testRetry.test.log     every gw.run() / gw.runCode() in test/testRetry.test.js
      orders.test.log
  2026-11-08_23-02-10/
    ...
  latest/                    a copy of the newest run's folder
```

`logs/latest/` always holds the last run, so you can keep `logs/latest/results.log` open in your editor. `logs/` is in `.gitignore`. Delete old run folders whenever you like.

## Reading a run log

Each script run is one block:

```
=== Run 2  22:45:56  get-token.js  "valid on attempt 2: invalid -> valid"  (4 ms)
from:      test/testRetry.retry.test.js:147
request:   input {"input":"test_input"}
status:    200 OK
output:    token_text
backends:
  1. POST https://auth.example.com/token
     sent:     grant_type=client_credentials
     received: 200 {"access_token":""}
  2. POST https://auth.example.com/token
     sent:     grant_type=client_credentials
     received: 200 {"access_token":"token_text"}
script log:
  console.warn    Token attempt 1 failed: invalid token response
```

| Line | What it shows |
|---|---|
| `=== Run N` | The run's number in this test file, the time, the script, the label (if you gave one) and how long it took. |
| `from:` | The line in your test file that started the run. Use it to match a run to its test. |
| `request:` | The `input`, `headers`, `serviceVars` and `parameters` you passed. |
| `status:` / `output:` / `headers:` | What the script returned. `(script threw an error)` or `(rejected: ...)` follows the status when that happened. |
| `backends:` | Every `urlopen.open` call in order: what was sent, and the response or the reason it failed (`error: connection refused`, a timeout). `[no mock matched]` marks a call you didn't mock. |
| `script log:` | Every `console.log`, `console.info`, `console.error`, ... call made by the script and the modules it requires, in order, with the method used. Messages from the simulator itself show their level and source instead, e.g. `[warn] (gws-sim) ...`. |
| `undeclared variables:` | Variables the script assigned without `var`. On DataPower (strict mode) that's a ReferenceError. |
| `error:` | The stack trace, if the script threw. |

`console.log` calls in your **test files** (not the script) show up in the terminal, so they're in `results.log`, just above the test that made them.

Bodies and messages longer than 2000 characters are cut, with a note saying how much was left out.

### Labelling runs

Pass `label` to `gw.run` to name a run in the log:

```js
const res = await gw.run('local:///testRetry.js', { input: {}, label: 'first token invalid' });
```

The [retry template](RETRY-TEMPLATE.md) labels each run with its test, for example `"gives up after 3 calls: invalid -> invalid -> invalid -> valid"`.

## Options

| Option | Effect |
|---|---|
| `--log-dir <dir>` | Put the logs somewhere else (default: `logs`, in the folder you run from). |
| `--no-logs` | Run the tests without writing any logs. |
| `--help` | Show the usage. |

Files and patterns are paths, or a `*` pattern inside one folder (`test/*.test.js`). The runner expands the pattern itself, so it works the same in Windows `cmd` and PowerShell. With no files, it runs `test/*.test.js`.

The run log works without the runner too. Set the folder on the gateway, or with an environment variable:

```js
new Gateway({ localDir, runLogDir: 'logs/manual' });   // this gateway only
new Gateway({ localDir, runLogDir: null });            // never log this gateway's runs
```

```bash
GWS_RUN_LOG_DIR=logs/manual node --test test/orders.test.js     # macOS / Linux
set GWS_RUN_LOG_DIR=logs\manual && node --test test\orders.test.js   # Windows cmd
```

Plain `node --test`, without either setting, writes no logs.

## Using it in your own project

Add a script to your `package.json` so `npm test` uses the runner:

```json
"scripts": {
  "test": "gws-test test/*.test.js"
}
```
