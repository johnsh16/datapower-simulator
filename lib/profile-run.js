'use strict';
/**
 * Run a profile from a command-line program and print the report. Used by
 * `gws-run --profile` and by the <script>.profile.js files gws-new-test writes.
 *
 * Deoptimizations come from V8's deopt log, which can only be turned on when Node
 * starts. So runProfile() re-runs the current program in a child Node process with
 * the flags profiling needs (--expose-gc, --log-deopt). In the child, the same call
 * sees GWS_PROFILE_DIR and does the profiling; the parent then merges the deopt log
 * into the report and prints it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { profile, addDeopts, formatReport, writeArtifacts } = require('./profiler');

const CHILD_ENV = 'GWS_PROFILE_DIR';

const OPTIONS_HELP = [
  '  --iterations <n>     transactions to profile (default 200)',
  '  --warmup <n>         transactions to run first so V8 optimizes hot code (default 30)',
  '  --top <n>            rows per table (default 10)',
  '  --profile-out <dir>  also save .cpuprofile / .heapprofile (open in Chrome DevTools',
  '                       or VS Code) and the report as .txt and .json',
  '  --json               print the report as JSON',
].join('\n');

/** --iterations, --warmup, --top, --profile-out, --json, --help -> options for runProfile(). */
function parseProfileArgs(argv) {
  const o = {};
  const whole = (flag, value, min) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) throw new Error(`${flag} needs a whole number${min ? ` of at least ${min}` : ''}, not '${value}'`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--iterations') o.iterations = whole(a, argv[++i], 1);
    else if (a === '--warmup') o.warmup = whole(a, argv[++i], 0);
    else if (a === '--top') o.top = whole(a, argv[++i], 1);
    else if (a === '--profile-out') o.profileOut = argv[++i];
    else throw new Error(`Unknown option '${a}'.`);
  }
  return o;
}

/**
 * runProfile({ script, gatewayOptions, runOptions, setup(gw), iterations, warmup,
 *              top, json, profileOut, unmatchedHint }, argv?)
 *
 * Pass `argv` (usually process.argv.slice(2)) to let the person running the
 * program set --iterations, --warmup, --top, --profile-out and --json.
 * Resolves with the report in the process that prints it, or null; failures
 * set process.exitCode.
 */
async function runProfile(opts, argv) {
  let o = { ...opts };
  if (argv) {
    let parsed;
    try {
      parsed = parseProfileArgs(argv);
    } catch (e) {
      console.error(`${e.message}\n\nOptions:\n${OPTIONS_HELP}`);
      process.exitCode = 1;
      return null;
    }
    if (parsed.help) {
      if (!process.env[CHILD_ENV]) console.log(`Profile ${o.script} (see docs/PROFILING.md in gws-sim).\n\nOptions:\n${OPTIONS_HELP}`);
      return null;
    }
    o = { ...o, ...parsed };
  }
  return process.env[CHILD_ENV] ? profileHere(o, process.env[CHILD_ENV]) : profileInChild(o);
}

/** In the child: profile, and leave the report where the parent will find it. */
async function profileHere(o, dir) {
  const name = path.basename(String(o.script));
  let report;
  try {
    report = await profile({
      script: o.script,
      gatewayOptions: o.gatewayOptions,
      runOptions: o.runOptions,
      setup: o.setup,
      iterations: o.iterations || 200,
      warmup: o.warmup !== undefined ? o.warmup : 30,
      onProgress: (msg) => process.stderr.write(`Profiling ${name}: ${msg}...\n`),
    });
  } catch (e) {
    console.error('\n' + e.message);
    if (e.result && e.result.urlopenCalls.some((c) => !c.matched)) {
      console.error(`Hint: some urlopen calls had no mock. ${o.unmatchedHint || 'Mock every backend the script calls.'}`);
    }
    process.exitCode = 1;
    return null;
  }
  if (o.profileOut) writeArtifacts(report, o.profileOut);
  const { raw, ...rest } = report;
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(rest));
  // end naturally instead of process.exit(): V8 flushes the deopt log only on a normal shutdown
  return null;
}

/** In the parent: re-run this program with the V8 flags profiling needs, then print the report. */
function profileInChild(o) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-profile-'));
  const logFile = path.join(tmp, 'v8-deopt.log');
  const child = spawn(process.execPath,
    [...process.execArgv, '--expose-gc', '--log-deopt', `--logfile=${logFile}`, '--no-logfile-per-isolate',
      process.argv[1], ...process.argv.slice(2)],
    { env: { ...process.env, [CHILD_ENV]: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });

  // V8 also prints each deopt to the console; the report shows them properly, so drop those lines
  const deoptLine = (l) => /^\[(bailout|deoptimiz)/.test(l);
  const forward = (stream, dest) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) if (!deoptLine(l)) dest.write(l + '\n');
    });
    stream.on('end', () => { if (buf && !deoptLine(buf)) dest.write(buf + '\n'); });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  return new Promise((resolve) => {
    child.on('close', (code) => {
      try {
        if (code !== 0) { process.exitCode = code || 1; return resolve(null); }
        const report = JSON.parse(fs.readFileSync(path.join(tmp, 'report.json'), 'utf8'));
        addDeopts(report, fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
        const text = formatReport(report, { top: o.top || 10 });
        if (o.json) console.log(JSON.stringify(report, null, 2));
        else console.log('\n' + text);
        if (o.profileOut) {
          const base = path.join(o.profileOut, path.basename(report.script, '.js'));
          fs.writeFileSync(base + '.profile.json', JSON.stringify(report, null, 2));
          fs.writeFileSync(base + '.profile.txt', text + '\n');
          console.log(`\nSaved to ${o.profileOut}/: ${path.basename(base)}.cpuprofile and .heapprofile ` +
            '(open in Chrome DevTools or VS Code), plus .profile.txt and .profile.json');
        }
        resolve(report);
      } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
        resolve(null);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
}

module.exports = { runProfile, parseProfileArgs, OPTIONS_HELP };
