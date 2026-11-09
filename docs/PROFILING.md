# Profiling GatewayScripts

`gws-run --profile` runs a script a few hundred times against your mocked backends and reports:

- **CPU time per line** of your code, with the simulator's own code filtered out
- **memory allocated per function**, per transaction
- **deoptimizations**: lines where V8 threw away optimized code, with V8's reason and what usually causes it
- **how long each callback holds the thread** before yielding
- **one transaction, step by step**: reads, writes, `urlopen` calls, `require()`s, and heap changes
- **findings**: problems from the performance checklist, each pointing at a line or a measurement

The findings follow the *JavaScript / Node.js Performance Strategies* guide (V8 internals, profiling, and the DataPower GatewayScript section), and each one names the section it comes from.

## Try it

```bash
node bin/gws-run.js examples/profiling/local/slow-report.js \
  --input examples/profiling/request.json \
  --mocks examples/profiling/mocks.js \
  --profile
```

[`slow-report.js`](../examples/profiling/local/slow-report.js) exports 2,000 orders as CSV and breaks several checklist rules on purpose. [`fast-report.js`](../examples/profiling/local/fast-report.js) produces the identical CSV the recommended way. Profile both and compare. On the machine used to write this:

| Per transaction | slow-report | fast-report |
|---|---|---|
| Wall time | ~6 ms | ~4 ms |
| CPU in the script's own code | ~3.2 ms | ~1.5 ms |
| Memory allocated by the script | 1.2 MB | 573 KB |
| Findings to fix | 7 | 0 |

Your numbers will differ; the ratio is what matters.

## Profile your own script

`gws-new-test` sets profiling up when it creates a test (see [step 8 of the walkthrough](WALKTHROUGH.md#8-create-a-test-for-your-own-script)). For `--out test/orders.test.js` it writes three files:

| File | What it holds |
|---|---|
| `test/orders.setup.js` | The request, the fake backends, and the gateway options |
| `test/orders.test.js` | The tests, run with `node --test test/orders.test.js` |
| `test/orders.profile.js` | The profile, run with `node test/orders.profile.js` |

```bash
node test/orders.profile.js
node test/orders.profile.js --iterations 500 --profile-out profiles
```

The tests and the profile both load the setup file, so a real backend response you paste into `BACKENDS` there is what the tests check and what the profile measures. There's no separate `--input` or `--mocks` to keep in step.

A small sample request says little about how a script copes with real traffic. To profile a bigger one without changing what the tests send, override `runOptions` in the profile file; it has a commented-out example.

## Options

| Option | Default | What it does |
|---|---|---|
| `--profile` | | `gws-run` only: turn profiling on. Takes the usual `--input`, `--headers`, `--service-vars`, `--mocks`, ... A generated `.profile.js` file always profiles, and gets the request and mocks from its setup file. |
| `--iterations <n>` | 200 | Transactions to measure. Raise it if "Hottest lines" says too little was sampled. |
| `--warmup <n>` | 30 | Transactions run first, unmeasured, so V8 has optimized the hot code. |
| `--top <n>` | 10 | Rows per table. |
| `--profile-out <dir>` | | Also save `.cpuprofile` and `.heapprofile` files, plus the report as `.txt` and `.json`. |
| `--json` | | Print the report as JSON instead of text. |

The other options work the same for `gws-run --profile` and a generated `.profile.js` file. Every backend the script calls needs a mock. Real network latency would drown out the numbers, so `--passthrough` isn't allowed with `--profile`.

## Reading the report

**Per transaction.** Wall time is measured with no profiler attached. "Your code" is the CPU spent in your files, including built-ins they call such as `JSON.parse`. The rest is the simulator and Node, which have no counterpart on the appliance. Mocked backends answer instantly, so this is CPU cost, not latency.

**Hottest lines.** Each line of your code with its share of your CPU time. Start at the top: a line at 40% is where an improvement pays off. The profiler slows code down a few times, so these milliseconds are scaled back to unprofiled speed. The report says by how much.

**Memory allocated by function.** Bytes allocated per transaction, including objects that were garbage collected moments later. That's the right measure for GC pressure. It comes from sampling, so small numbers are approximate. V8 records allocations by function, not by line.

**Synchronous stretches.** How long each piece of your code runs before handing control back. On the appliance a script holds a GatewayScript runtime while it runs, and a long stretch under load makes other transactions queue. Stretches over 10 ms are reported as findings.

**One transaction, step by step.** The first, unoptimized run, in order. The heap column is the change since the previous step; a big negative number just means garbage collection ran.

**Deoptimizations.** Lines where V8 discarded optimized machine code because an assumption stopped holding, such as an object with a different shape or a number that stopped being a small integer. The count covers every transaction except the profiled ones, because V8 doesn't log deopts while its CPU profiler runs. "Insufficient type feedback" once or twice is normal; anything that repeats every transaction is worth fixing.

## What the findings check

| Finding | What it means | Guide section |
|---|---|---|
| Input read more than once | `session.input` is read twice or more, e.g. as JSON and again as a buffer | 6. Payload handling |
| Output written more than once | Each write copies the payload; build the response, then write it once (in the simulator a later write also replaces an earlier one) | 6. Payload handling |
| `require()` inside a callback | Modules should be loaded at the top of the script | 6. Compile once |
| Long synchronous stretch | A callback runs over 10 ms without yielding | 6. Monitor the runtime pool |
| `urlopen` without a timeout | A slow backend then holds the runtime for the default timeout | 6. Monitor the runtime pool |
| Repeated calls to one backend | Three or more calls to the same URL in one transaction; check retries are bounded | 6. Monitor the runtime pool |
| Large context variable | A variable over 64 KB, e.g. a whole payload kept "just in case" | 6. Payload handling |
| Log volume, debug logs | More than 5 messages per transaction, or any at debug level | 6. Production hygiene |
| Heap growth | Memory still held after GC grows with every transaction: a likely leak | 6. Payload handling |
| Heavy allocation, GC share | Where memory churn is coming from | 1. Reduce allocations, 3. Tune the runtime |
| Deoptimization | V8's reason, translated into the usual cause and fix | 1. Write engine-friendly code |
| `delete`, `eval`, `with`, `arguments`, `new Array(n)` | Source patterns that defeat V8's optimizer | 1. Write engine-friendly code |
| `JSON.parse(JSON.stringify(...))` | A full copy through text | 6. Payload handling |
| `+=` string building, logging, or `require()` inside a loop | Per-iteration costs in hot paths | 6. Payload handling, Production hygiene |

`[fix]` means the rule is clearly broken. `[check]` means it's worth a look but may be fine; for example, some allocation is unavoidable work.

The report ends with three items from the checklist that only the appliance can tell you: whether the GatewayScript cache is enabled, whether `show gatewayscript-status` shows queuing under load, and whether the probe and debug logging are off.

## Going deeper in DevTools or VS Code

With `--profile-out profiles`, the report also saves:

- `<script>.cpuprofile`: open it in Chrome DevTools (Performance panel, *Load profile*) for a flame chart and per-function times, or open it in VS Code, which reads `.cpuprofile` files too.
- `<script>.heapprofile`: open it in Chrome DevTools (Memory panel, *Load*) to browse allocations as a tree.

These include the simulator's frames too, which the text report filters out.

## From code

```js
const { profile, formatReport } = require('gws-sim').profiler;

const report = await profile({
  script: 'local/orders.js',
  gatewayOptions: { localDir: 'local' },
  runOptions: { input: { id: 7 } },
  setup: (gw) => gw.urlopen.when(/orders/).reply(200, { items: [] }),
  iterations: 200,
});
console.log(formatReport(report));
```

`profile()` returns the report without deoptimizations: they need V8's deopt log, which can only be turned on when Node starts. `runProfile()` takes the same options, re-runs your program in a child Node process with that log on, and prints the full report. It's what `gws-run --profile` and the generated `.profile.js` files use:

```js
const { runProfile } = require('gws-sim').profiler;

runProfile({
  script: 'local:///orders.js',
  gatewayOptions: { localDir: 'local' },
  runOptions: { input: { id: 7 } },
  setup: (gw) => gw.urlopen.when(/orders/).reply(200, { items: [] }),
}, process.argv.slice(2)); // optional: accept --iterations, --warmup, --top, --profile-out, --json
```

## How close is this to the appliance?

The simulator runs your script in the Node and V8 version on your machine, not the appliance's firmware, so treat the numbers as relative. They're good for "which line is hot," "did this change help," and "does this leak," but not for predicting appliance throughput. Specifically:

- The simulator compiles your script fresh for each transaction, so V8 only optimizes code that's hot within a single transaction, such as a loop over a large payload. With the GatewayScript cache, the appliance may keep compiled code between transactions.
- Simulator overhead is excluded from line and function figures but is present in wall time.
- Native actions (Validate, Transform, ...) and the network aren't simulated.
