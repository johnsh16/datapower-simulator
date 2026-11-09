'use strict';
/**
 * Profiler behind `gws-run --profile`.
 *
 * Runs a GatewayScript many times under V8's CPU profiler and sampling heap
 * profiler, keeps only what happened in the user's own files, and checks the
 * script against the practices in "JavaScript / Node.js Performance Strategies":
 *
 *   - CPU time per line, and per function including the built-ins it called
 *   - bytes allocated per function per transaction
 *   - deoptimizations, with V8's reason, per line (needs --log-deopt; the CLI sets it)
 *   - a step-by-step timeline of one transaction with heap changes
 *   - findings: input read more than once, output written more than once,
 *     require() inside callbacks, long synchronous stretches, urlopen without a
 *     timeout, repeated calls to one backend, large context variables, logging
 *     volume, garbage-collection share, heap growth, and source patterns that
 *     defeat V8's optimizer
 */
const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const vm = require('vm');
const inspector = require('inspector');
const { performance } = require('perf_hooks');
const { Gateway } = require('./gateway');

const DOC = 'JavaScript / Node.js Performance Strategies';

// thresholds for findings
const LIMITS = {
  syncMs: 10,                // a synchronous stretch longer than this holds a runtime noticeably
  bigVariableBytes: 64 * 1024,
  logsPerTxn: 5,
  repeatedCalls: 3,
  allocPerTxnBytes: 512 * 1024,
  heapGrowthPerTxnBytes: 1024,
  gcShare: 0.10,
};

function getGc() {
  if (typeof global.gc === 'function') return global.gc;
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc');
}

function post(session, method, params = {}) {
  return new Promise((resolve, reject) => session.post(method, params, (e, r) => (e ? reject(e) : resolve(r))));
}

const normUrl = (u) => (u && u.startsWith('file://') ? decodeURIComponent(new URL(u).pathname) : u || '');
const SPECIAL = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);
const isBuiltin = (cf) => cf.url === '' && !SPECIAL.has(cf.functionName);
const fnLabel = (cf) => cf.functionName || (cf.lineNumber === 0 && cf.columnNumber === 0 ? '(top level)' : '(anonymous)');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ---------------------------------------------------------------------------
// CPU: per line (own code) and per function (own code + built-ins it called)
// ---------------------------------------------------------------------------
function analyzeCpu(profile, userFiles) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const usPerSample = (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length);
  const isUser = (n) => userFiles.has(normUrl(n.callFrame.url));

  const lines = new Map();
  const funcs = new Map();
  let totalTicks = 0, gcTicks = 0, userTicks = 0;
  const fnEntry = (n) => {
    const file = normUrl(n.callFrame.url);
    const key = `${file}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}:${n.callFrame.functionName}`;
    if (!funcs.has(key)) funcs.set(key, { name: fnLabel(n.callFrame), file, line: n.callFrame.lineNumber + 1, selfTicks: 0, builtinTicks: 0 });
    return funcs.get(key);
  };

  for (const n of profile.nodes) {
    const hits = n.hitCount || 0;
    totalTicks += hits;
    if (n.callFrame.functionName === '(garbage collector)') gcTicks += hits;
    if (isUser(n)) {
      fnEntry(n).selfTicks += hits;
      userTicks += hits;
      const file = normUrl(n.callFrame.url);
      for (const pt of n.positionTicks || []) {
        const key = `${file}:${pt.line}`;
        lines.set(key, (lines.get(key) || { file, line: pt.line, ticks: 0 }));
        lines.get(key).ticks += pt.ticks;
      }
    } else if (isBuiltin(n.callFrame) && hits) {
      // charge built-ins (JSON.parse, String.prototype.split, ...) to the user function that called them
      let p = parent.get(n.id);
      while (p !== undefined && isBuiltin(byId.get(p).callFrame)) p = parent.get(p);
      if (p !== undefined && isUser(byId.get(p))) {
        fnEntry(byId.get(p)).builtinTicks += hits;
        userTicks += hits;
      }
    }
  }
  const ms = (t) => (t * usPerSample) / 1000;
  return {
    usPerSample,
    totalMs: ms(totalTicks),
    userMs: ms(userTicks),
    gcShare: totalTicks ? gcTicks / totalTicks : 0,
    lines: [...lines.values()].map((l) => ({ ...l, ms: ms(l.ticks) })).sort((a, b) => b.ticks - a.ticks),
    functions: [...funcs.values()].map((f) => ({ ...f, selfMs: ms(f.selfTicks), builtinMs: ms(f.builtinTicks) }))
      .sort((a, b) => (b.selfTicks + b.builtinTicks) - (a.selfTicks + a.builtinTicks)),
  };
}

// ---------------------------------------------------------------------------
// Heap: bytes allocated per function (sampling; includes objects already collected)
// ---------------------------------------------------------------------------
function analyzeHeap(heapProfile, userFiles, iterations) {
  const funcs = new Map();
  let total = 0, user = 0;
  const visit = (node, owner) => {
    const cf = node.callFrame;
    let me = owner;
    if (userFiles.has(normUrl(cf.url))) {
      const key = `${normUrl(cf.url)}:${cf.lineNumber}:${cf.columnNumber}:${cf.functionName}`;
      if (!funcs.has(key)) funcs.set(key, { name: fnLabel(cf), file: normUrl(cf.url), line: cf.lineNumber + 1, bytes: 0 });
      me = funcs.get(key);
    } else if (!isBuiltin(cf)) {
      me = null; // simulator / Node internals: not the user's allocation
    }
    total += node.selfSize;
    if (me) { me.bytes += node.selfSize; user += node.selfSize; }
    for (const c of node.children || []) visit(c, me);
  };
  visit(heapProfile.head, null);
  return {
    totalPerTxn: total / iterations,
    userPerTxn: user / iterations,
    functions: [...funcs.values()].map((f) => ({ ...f, perTxn: f.bytes / iterations })).sort((a, b) => b.bytes - a.bytes),
  };
}

// ---------------------------------------------------------------------------
// Deopts from a V8 --log-deopt file
// ---------------------------------------------------------------------------
const DEOPT_HINTS = [
  [/wrong map|map check|unexpected map/i, 'An object reached this line with a different shape (hidden class) than before. Create objects with the same properties in the same order; avoid adding properties later or using delete.'],
  [/not a smi|overflow|not a heap ?number|lost precision|minus zero|nan/i, 'A number changed representation (small integer vs double, or NaN/-0). Keep numeric values one kind; consider typed arrays for numeric data.'],
  [/hole|out of bounds|not a js ?array|wrong (elements|array)/i, 'An array was holey, sparse, or accessed out of bounds. Fill arrays densely from index 0 and avoid mixing element types.'],
  [/insufficient type feedback/i, 'Optimized code reached a branch it had never run before. Usually harmless if it happens once; repeated, it means hot code takes rarely-seen paths.'],
  [/wrong call target|wrong (feedback|name)|unexpected (value|type)/i, 'This call site saw a different function or type than before (polymorphic). Pass the same kinds of objects to hot functions.'],
  [/string|not a string|not internalized/i, 'A value expected to be a string was something else (or vice versa). Keep types consistent.'],
];
function explainDeopt(reason) {
  for (const [re, text] of DEOPT_HINTS) if (re.test(reason)) return text;
  return 'V8 discarded optimized code here because an assumption it made stopped holding.';
}

function parseDeoptLog(text, userFiles) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^code-deopt,(?:[^,]*,){6}<(.+):(\d+):(\d+)>,(.*)$/);
    if (!m) continue;
    const file = normUrl(m[1]);
    if (!userFiles.has(file)) continue;
    const key = `${file}:${m[2]}:${m[4]}`;
    if (!out.has(key)) out.set(key, { file, line: Number(m[2]), column: Number(m[3]), reason: m[4].trim(), count: 0 });
    out.get(key).count++;
  }
  return [...out.values()].sort((a, b) => b.count - a.count).map((d) => ({ ...d, hint: explainDeopt(d.reason) }));
}

// ---------------------------------------------------------------------------
// Source patterns (static) that work against V8 or the appliance
// ---------------------------------------------------------------------------
function staticFindings(file) {
  const src = fs.readFileSync(file, 'utf8').split('\n');
  const found = [];
  const INFO = new Set(['arguments', 'holey-array', 'string-concat-loop', 'log-in-loop']);
  const add = (line, rule, message, section) => found.push({ file, line, rule, message, section, severity: INFO.has(rule) ? 'info' : 'warn' });
  let depth = 0;
  const loopDepths = [];
  src.forEach((text, i) => {
    const line = i + 1;
    const code = text.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    const inLoop = loopDepths.length > 0;
    if (/\bdelete\s+[\w$]/.test(code)) add(line, 'delete', 'delete changes an object\'s shape and can push V8 into slow dictionary mode. Set the property to undefined instead, or build a new object.', '1. Write engine-friendly code');
    if (/(^|[^.\w$])eval\s*\(/.test(code)) add(line, 'eval', 'eval blocks optimization of the surrounding function.', '1. Write engine-friendly code');
    if (/\bwith\s*\(/.test(code)) add(line, 'with', 'with blocks optimization of the surrounding function.', '1. Write engine-friendly code');
    if (/\barguments\b/.test(code)) add(line, 'arguments', 'arguments is used here. Heavy use of it in hot code can block optimization; prefer named or rest parameters.', '1. Write engine-friendly code');
    if (/JSON\.parse\(\s*JSON\.stringify\(/.test(code)) add(line, 'json-clone', 'JSON.parse(JSON.stringify(...)) copies the whole payload twice. Avoid parse/stringify cycles; copy only what you need.', '6. Payload handling');
    if (/new\s+Array\(\s*[\w$]+\s*\)/.test(code)) add(line, 'holey-array', 'new Array(n) creates a holey array. Build arrays by pushing, or use a typed array for numbers.', '1. Write engine-friendly code');
    if (inLoop && /\+=\s*(""|[\w$.]+\s*\+\s*""|String\()/.test(code)) add(line, 'string-concat-loop', 'A string is built with += inside a loop. V8 handles this reasonably, but for large outputs it creates many intermediate strings that must be flattened later. If this line is hot above, collect the parts in an array and join once.', '6. Payload handling');
    if (inLoop && /\bconsole\.(log|debug|info|notice)\s*\(/.test(code)) add(line, 'log-in-loop', 'Logging inside a loop adds per-iteration overhead. Keep console logging out of hot paths.', '6. Production hygiene');
    if (inLoop && /\brequire\s*\(/.test(code)) add(line, 'require-in-loop', 'require() inside a loop. Load modules once at the top of the script.', '6. Compile once');
    if (/\b(for|while)\s*\(|\.(forEach|map|filter|reduce)\s*\(/.test(code)) loopDepths.push(depth);
    for (const ch of code) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; while (loopDepths.length && depth <= loopDepths[loopDepths.length - 1]) loopDepths.pop(); }
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// The profile run
// ---------------------------------------------------------------------------
/**
 * profile({ script, gatewayOptions, runOptions, setup(gw), iterations, warmup })
 * Returns a report object; render it with formatReport().
 */
async function profile(opts) {
  const {
    script, gatewayOptions = {}, runOptions = {}, setup = () => {},
    iterations = 200, warmup = 30, cpuIntervalUs = 50, heapIntervalBytes = 256,
    onProgress = () => {},
  } = opts;
  // mocked backends answer instantly, so timings measure the script, not simulated latency
  const gwOpts = { ...gatewayOptions, maxSimulatedDelayMs: 0, realDelays: false, runLogDir: null };
  const runOnce = async (extra) => {
    const gw = new Gateway({ ...gwOpts, ...extra });
    await setup(gw);
    return gw.run(script, runOptions);
  };

  // 1. one instrumented run: what a single transaction does, step by step
  onProgress('checking one transaction');
  const probe = await runOnce({ instrument: true });
  if (probe.error) {
    const e = new Error(`The script failed before profiling could start: ${probe.error.message}`);
    e.result = probe;
    throw e;
  }
  const userFiles = new Set(probe.scriptFiles.map((f) => path.resolve(f)));

  // 2. warm up so V8 has optimized the hot code, as it would be on a busy appliance
  onProgress(`warming up (${warmup} transactions)`);
  for (let i = 0; i < warmup; i++) await runOnce();

  // 3. a plain pass with no profilers attached. Two reasons: V8 writes deopt events
  // to its log only while the CPU profiler is off, and heap growth must be measured
  // without profile data sitting in memory. Growth is checked in two halves so a
  // one-off allocation (a lazily built cache) isn't mistaken for a leak.
  onProgress(`measuring heap growth and deopts (${iterations} transactions)`);
  const gc = getGc();
  const settle = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
  // Wall time and synchronous stretches are also measured here: the CPU profiler
  // slows code down several times, so its absolute timings would overstate them.
  const half = Math.max(1, Math.floor(iterations / 2));
  const times = [];
  const blocks = new Map();
  let failed = 0;
  const measured = async () => {
    const t = performance.now();
    const r = await runOnce();
    times.push(performance.now() - t);
    if (r.error) failed++;
    for (const b of r.syncBlocks) {
      if (!blocks.has(b.label)) blocks.set(b.label, []);
      blocks.get(b.label).push(b.ms);
    }
  };
  const h0 = settle();
  for (let i = 0; i < half; i++) await measured();
  const h1 = settle();
  for (let i = 0; i < half; i++) await measured();
  const h2 = settle();
  const growthA = (h1 - h0) / half, growthB = (h2 - h1) / half;

  // 4. profile
  onProgress(`profiling ${iterations} transactions`);
  const session = new inspector.Session();
  session.connect();
  await post(session, 'Profiler.enable');
  await post(session, 'Profiler.setSamplingInterval', { interval: cpuIntervalUs });
  await post(session, 'HeapProfiler.enable');
  await post(session, 'HeapProfiler.startSampling', {
    samplingInterval: heapIntervalBytes, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  });
  await post(session, 'Profiler.start');
  for (let i = 0; i < iterations; i++) await runOnce();
  const { profile: cpuProfile } = await post(session, 'Profiler.stop');
  const { profile: heapProfile } = await post(session, 'HeapProfiler.stopSampling');
  session.disconnect();

  const sortedTimes = [...times].sort((a, b) => a - b);
  const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
  const cpu = analyzeCpu(cpuProfile, userFiles);
  // The profile says where time goes; the unprofiled pass says how much there is.
  // Scale the profiler's milliseconds down to unprofiled speed.
  const scale = cpu.totalMs > 0 ? Math.min(1, avgMs / (cpu.totalMs / iterations)) : 1;
  for (const l of cpu.lines) l.ms *= scale;
  for (const f of cpu.functions) { f.selfMs *= scale; f.builtinMs *= scale; }
  cpu.userMs *= scale;
  cpu.totalMs *= scale;
  const heap = analyzeHeap(heapProfile, userFiles, iterations);

  const report = {
    tool: 'gws-sim profiler',
    script: probe.scriptFiles[0],
    userFiles: [...userFiles],
    iterations,
    warmup,
    deoptLoggedTransactions: 1 + warmup + 2 * half, // probe + warm-up + measuring pass (V8 logs nothing while profiling)
    failedRuns: failed,
    time: {
      avgMs,
      profilerSlowdown: scale > 0 ? 1 / scale : 1,
      p50Ms: percentile(sortedTimes, 50),
      p95Ms: percentile(sortedTimes, 95),
      maxMs: sortedTimes[sortedTimes.length - 1],
      userCpuMsPerTxn: cpu.userMs / iterations,
      totalCpuMsPerTxn: cpu.totalMs / iterations,
    },
    memory: {
      allocatedPerTxn: heap.totalPerTxn,
      userAllocatedPerTxn: heap.userPerTxn,
      heapGrowthPerTxn: (growthA + growthB) / 2,
      heapGrowthHalves: [growthA, growthB],
      gcShare: cpu.gcShare,
    },
    lines: cpu.lines.map((l) => ({ ...l, msPerTxn: l.ms / iterations })),
    cpuFunctions: cpu.functions.map((f) => ({ ...f, msPerTxn: (f.selfMs + f.builtinMs) / iterations })),
    allocFunctions: heap.functions,
    syncBlocks: [...blocks.entries()].map(([label, arr]) => {
      const s = [...arr].sort((a, b) => a - b);
      return { label, count: arr.length / iterations, medianMs: percentile(s, 50), maxMs: s[s.length - 1] };
    }).sort((a, b) => b.medianMs - a.medianMs),
    timeline: timeline(probe),
    deopts: null, // filled in by addDeopts() when a --log-deopt file is available
    findings: [],
    raw: { cpuProfile, heapProfile },
  };
  report.findings = runtimeFindings(report, probe).concat(
    report.userFiles.flatMap((f) => staticFindings(f).map((x) => ({ ...x, source: 'code' }))));
  return report;
}

function timeline(probe) {
  const steps = [];
  let prevHeap = null;
  const t0 = probe.events.length ? probe.events[0].ms : 0;
  for (const e of probe.events) {
    let what;
    switch (e.type) {
      case 'require': what = `require('${e.spec}')${e.lazy ? '  (inside a callback)' : ''}`; break;
      case 'context.read': what = `read ${e.context.toLowerCase()} as ${e.kind}`; break;
      case 'response.read': what = `read urlopen response as ${e.kind} (${fmtBytes(e.bytes)})`; break;
      case 'context.write': what = `write ${e.context.toLowerCase()} (${fmtBytes(e.bytes)})`; break;
      case 'context.setVariable': what = `set ${e.context}.${e.name} (${fmtBytes(e.bytes)})`; break;
      case 'urlopen.open': what = `urlopen ${e.method} ${e.target}${e.timeoutSet ? '' : '  (no timeout set)'}`; break;
      case 'setVar': what = `setVar ${e.path}`; break;
      default: what = e.type;
    }
    steps.push({ ms: e.ms - t0, what, heapDelta: prevHeap == null ? 0 : e.heapUsed - prevHeap });
    prevHeap = e.heapUsed;
  }
  return steps;
}

function runtimeFindings(report, probe) {
  const f = [];
  const add = (severity, rule, message, section, extra = {}) => f.push({ severity, rule, message, section, source: 'run', ...extra });
  const ev = probe.events;

  const inputReads = ev.filter((e) => e.type === 'context.read' && e.context === 'INPUT');
  if (inputReads.length > 1) add('warn', 'read-once', `session.input is read ${inputReads.length} times per transaction (${inputReads.map((e) => e.kind).join(', ')}). Read it once with the narrowest reader and reuse the result.`, '6. Payload handling');
  const outWrites = ev.filter((e) => e.type === 'context.write' && e.context === 'OUTPUT');
  if (outWrites.length > 1) add('warn', 'write-once', `session.output is written ${outWrites.length} times per transaction. Build the response, then write it once.`, '6. Payload handling');

  const lazy = [...new Set(ev.filter((e) => e.type === 'require' && e.lazy).map((e) => e.spec))];
  if (lazy.length) add('warn', 'lazy-require', `require() runs inside a callback for: ${lazy.join(', ')}. Load modules at the top of the script so they're resolved once.`, '6. Compile once, not per transaction');

  for (const b of report.syncBlocks) {
    if (b.medianMs > LIMITS.syncMs) {
      add('warn', 'long-sync', `"${b.label}" runs ${b.medianMs.toFixed(1)} ms without yielding (max ${b.maxMs.toFixed(1)} ms). On the appliance that holds a GatewayScript runtime; under load, other transactions queue. Move heavy work to a native action or shrink it.`, '6. Monitor the runtime pool');
    }
  }

  const calls = ev.filter((e) => e.type === 'urlopen.open');
  const noTimeout = [...new Set(calls.filter((c) => !c.timeoutSet).map((c) => `${c.method} ${c.target}`))];
  if (noTimeout.length) add('warn', 'urlopen-timeout', `urlopen without a timeout option: ${noTimeout.join('; ')}. A slow backend then holds the runtime for the default timeout. Set timeout to what the caller can wait.`, '6. Monitor the runtime pool');
  const perTarget = {};
  for (const c of calls) perTarget[c.target] = (perTarget[c.target] || 0) + 1;
  for (const [t, n] of Object.entries(perTarget)) {
    if (n >= LIMITS.repeatedCalls) add('info', 'repeated-calls', `${t} is called ${n} times in one transaction. If these are retries, make sure they're bounded.`, '6. Monitor the runtime pool');
  }

  for (const e of ev.filter((x) => x.type === 'context.setVariable' && x.bytes > LIMITS.bigVariableBytes)) {
    add('warn', 'big-variable', `Context variable ${e.context}.${e.name} holds ${fmtBytes(e.bytes)}. Don't keep large payloads in variables unless a later step needs them.`, '6. Payload handling');
  }

  const logs = probe.logs.length;
  if (logs > LIMITS.logsPerTxn) add('info', 'log-volume', `${logs} log messages per transaction. Keep console logging out of hot paths.`, '6. Production hygiene');
  const debugLogs = probe.logs.filter((l) => l.level === 'debug').length;
  if (debugLogs) add('info', 'debug-logs', `${debugLogs} debug-level message(s) per transaction. Make sure debug logging is off in production.`, '6. Production hygiene');

  if (report.memory.userAllocatedPerTxn > LIMITS.allocPerTxnBytes) {
    add('info', 'alloc-heavy', `Your code allocates about ${fmtBytes(report.memory.userAllocatedPerTxn)} per transaction (see "Memory allocated by function" for where). Some of that is unavoidable work; look for copies you don't need. Appliance memory is shared.`, '1. Reduce allocations / 6. Payload handling');
  }
  if (report.memory.gcShare > LIMITS.gcShare) {
    const share = report.memory.allocatedPerTxn ? report.memory.userAllocatedPerTxn / report.memory.allocatedPerTxn : 0;
    add('info', 'gc-share', `Garbage collection took ${(report.memory.gcShare * 100).toFixed(0)}% of CPU in this run, simulator included; your code made ${(share * 100).toFixed(0)}% of the allocations. Reducing your allocations lowers this.`, '1. Reduce allocations / 3. Tune the runtime');
  }
  if (report.memory.heapGrowthHalves.every((g) => g > LIMITS.heapGrowthPerTxnBytes)) {
    add('warn', 'heap-growth', `The heap grew about ${fmtBytes(report.memory.heapGrowthPerTxn)} per transaction after garbage collection. Something may be keeping data between transactions (globals, caches that never evict).`, '6. Payload handling');
  }
  if (report.failedRuns) add('warn', 'failed-runs', `${report.failedRuns} of ${report.iterations} measured transactions threw an error, so some numbers describe the failure path.`, '2. Find the actual hotspots');
  return f;
}

function perTxn(count, report) {
  const n = report.deoptLoggedTransactions || 1;
  const r = count / n;
  return `${count}x in ${n} transactions (${r >= 0.95 ? `about ${Math.round(r)} per transaction` : 'not every transaction'})`;
}

/** Merge a V8 --log-deopt file into the report (the CLI runs the profile in a child process with that flag). */
function addDeopts(report, logText) {
  report.deopts = parseDeoptLog(logText, new Set(report.userFiles));
  for (const d of report.deopts) {
    report.findings.push({
      severity: d.reason.match(/insufficient type feedback/i) ? 'info' : 'warn',
      rule: 'deopt', file: d.file, line: d.line, source: 'v8',
      message: `V8 deoptimized here ${perTxn(d.count, report)} (reason: ${d.reason}). ${d.hint}`,
      section: '1. Write engine-friendly code',
    });
  }
  return report;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function fmtBytes(n) {
  const a = Math.abs(n);
  if (a >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (a >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return Math.round(n) + ' B';
}
const fmtMs = (n) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(3)) + ' ms';
const pad = (s, n) => (String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length));
const lpad = (s, n) => (String(s).length >= n ? String(s) : ' '.repeat(n - String(s).length) + String(s));

function formatReport(report, { top = 10, cwd = process.cwd() } = {}) {
  const rel = (f) => path.relative(cwd, f) || f;
  const srcCache = new Map();
  const srcLine = (file, line) => {
    if (!srcCache.has(file)) { try { srcCache.set(file, fs.readFileSync(file, 'utf8').split('\n')); } catch { srcCache.set(file, []); } }
    const t = (srcCache.get(file)[line - 1] || '').replace(/\s+\/\/.*$/, '').trim();
    return t.length > 70 ? t.slice(0, 67) + '...' : t;
  };
  const out = [];
  const say = (s = '') => out.push(s);
  const t = report.time, m = report.memory;
  const width = (rows) => Math.max(0, ...rows.map((r) => r.length)) + 2;

  say(`=== Profile of ${rel(report.script)}: ${report.iterations} transactions (after ${report.warmup} warm-up)`);
  say();
  say('Per transaction');
  say(`  wall time      avg ${fmtMs(t.avgMs)}   p50 ${fmtMs(t.p50Ms)}   p95 ${fmtMs(t.p95Ms)}   max ${fmtMs(t.maxMs)}`);
  say(`  your code      ${fmtMs(t.userCpuMsPerTxn)} CPU of ${fmtMs(t.totalCpuMsPerTxn)} total (the rest is the simulator and Node)`);
  if (t.profilerSlowdown >= 1.2) say(`                 CPU times below are scaled to unprofiled speed (the profiler made code ${t.profilerSlowdown.toFixed(1)}x slower)`);
  say(`  allocated      ${fmtBytes(m.userAllocatedPerTxn)} by your code, ${fmtBytes(m.allocatedPerTxn)} in total`);
  const growing = m.heapGrowthHalves.every((g) => g > LIMITS.heapGrowthPerTxnBytes);
  say(`  heap growth    ${m.heapGrowthPerTxn > 0 ? fmtBytes(m.heapGrowthPerTxn) + ' retained after GC' : 'none after GC'}${growing ? '  <- growing: possible leak' : '  (stable)'}`);
  say(`  GC share       ${(m.gcShare * 100).toFixed(1)}% of CPU`);
  say('  Mocked backends answer instantly, so these numbers are CPU cost, not network latency.');

  say();
  say('Hottest lines (CPU in your code only)');
  if (!report.lines.length) say('  (too little time in your code to sample; try --iterations 2000)');
  const lines = report.lines.slice(0, top);
  const lw = width(lines.map((l) => `${rel(l.file)}:${l.line}`));
  const userTotal = report.lines.reduce((a, l) => a + l.ms, 0) || 1;
  for (const l of lines) {
    say(`  ${pad(`${rel(l.file)}:${l.line}`, lw)}${lpad(fmtMs(l.msPerTxn), 10)}/txn ${lpad(((l.ms / userTotal) * 100).toFixed(0) + '%', 5)}   ${srcLine(l.file, l.line)}`);
  }

  say();
  const anyBuiltin = report.cpuFunctions.some((f) => f.builtinMs > 0);
  say(anyBuiltin ? 'Functions (CPU per transaction, including built-ins they call such as JSON.parse)' : 'Functions (CPU per transaction)');
  const fns = report.cpuFunctions.slice(0, top);
  const fw = width(fns.map((f) => `${f.name}  ${rel(f.file)}:${f.line}`));
  for (const f of fns) {
    say(`  ${pad(`${f.name}  ${rel(f.file)}:${f.line}`, fw)}${lpad(fmtMs(f.msPerTxn), 10)}` +
      (anyBuiltin ? `   (own ${fmtMs(f.selfMs / report.iterations)}, built-ins ${fmtMs(f.builtinMs / report.iterations)})` : ''));
  }

  say();
  say('Memory allocated by function (sampled, per transaction; includes short-lived objects)');
  if (!report.allocFunctions.length) say('  (no allocations sampled in your code)');
  const afs = report.allocFunctions.slice(0, top);
  const aw = width(afs.map((f) => `${f.name}  ${rel(f.file)}:${f.line}`));
  for (const f of afs) say(`  ${pad(`${f.name}  ${rel(f.file)}:${f.line}`, aw)}${lpad(fmtBytes(f.perTxn), 10)}`);

  say();
  say('Synchronous stretches (how long script code holds the thread before yielding)');
  const bw = width(report.syncBlocks.map((b) => b.label));
  for (const b of report.syncBlocks.slice(0, top)) {
    say(`  ${pad(b.label, bw)}median ${lpad(fmtMs(b.medianMs), 9)}   max ${lpad(fmtMs(b.maxMs), 9)}${Math.abs(b.count - 1) > 0.01 ? `   x${+b.count.toFixed(2)} per transaction` : ''}`);
  }

  say();
  say('One transaction, step by step (the first, unoptimized run; heap change is since the previous step, and negative means garbage was collected)');
  const sw = Math.min(70, width(report.timeline.map((x) => x.what)));
  for (const x of report.timeline) say(`  ${lpad(fmtMs(x.ms), 10)}  ${pad(x.what, sw)}${lpad((x.heapDelta >= 0 ? '+' : '') + fmtBytes(x.heapDelta), 10)}`);

  say();
  if (report.deopts === null) say('Deoptimizations: not collected (run through `gws-run --profile`, which enables V8\'s deopt log)');
  else if (!report.deopts.length) say(`Deoptimizations: none in your code (checked over ${report.deoptLoggedTransactions} transactions)`);
  else {
    say(`Deoptimizations in your code (V8 threw away optimized code; counted over ${report.deoptLoggedTransactions} transactions)`);
    const dw = width(report.deopts.slice(0, top).map((d) => `${rel(d.file)}:${d.line}:${d.column}`));
    for (const d of report.deopts.slice(0, top)) say(`  ${pad(`${rel(d.file)}:${d.line}:${d.column}`, dw)}${lpad('x' + d.count, 6)}   ${d.reason}`);
  }

  say();
  const warn = report.findings.filter((x) => x.severity === 'warn');
  const info = report.findings.filter((x) => x.severity !== 'warn');
  say(`Findings: ${warn.length} to fix, ${info.length} to check. Each names the section of "${DOC}" it relates to.`);
  if (!report.findings.length) say('  None. Nothing from the checklist showed up in this run.');
  for (const x of [...warn, ...info]) {
    const where = x.file ? `${rel(x.file)}:${x.line}  ` : '';
    say(`  ${x.severity === 'warn' ? '[fix]  ' : '[check]'} ${where}${x.message}`);
    if (x.file && x.line) { const sl = srcLine(x.file, x.line); if (sl) say(`          > ${sl}`); }
    say(`          (${x.section})`);
  }

  say();
  say('Check on the appliance (not measurable here):');
  say('  - GatewayScript cache enabled (disabled by default on Docker/container editions)');
  say('  - no queuing in `show gatewayscript-status` under load');
  say('  - multistep probe and debug log levels off in production');
  return out.join('\n');
}

/** Write .cpuprofile / .heapprofile (open in Chrome DevTools or VS Code), report.json and report.txt. */
function writeArtifacts(report, dir, text) {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(report.script, '.js');
  const files = {
    cpu: path.join(dir, `${base}.cpuprofile`),
    heap: path.join(dir, `${base}.heapprofile`),
    json: path.join(dir, `${base}.profile.json`),
    text: path.join(dir, `${base}.profile.txt`),
  };
  fs.writeFileSync(files.cpu, JSON.stringify(report.raw.cpuProfile));
  fs.writeFileSync(files.heap, JSON.stringify(report.raw.heapProfile));
  const { raw, ...rest } = report;
  fs.writeFileSync(files.json, JSON.stringify(rest, null, 2));
  if (text) fs.writeFileSync(files.text, text + '\n');
  return files;
}

module.exports = { profile, addDeopts, formatReport, writeArtifacts, parseDeoptLog, staticFindings, analyzeCpu, analyzeHeap, LIMITS };
