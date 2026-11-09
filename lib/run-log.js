'use strict';
/**
 * Per-run log: after each gw.run()/gw.runCode(), append what happened to a text file.
 *
 * Turned on by the Gateway option `runLogDir`, or the environment variable
 * GWS_RUN_LOG_DIR (set by `gws-test` / `npm test`). Each test file gets its own log,
 * named after the file, so test files running in parallel never interleave.
 * `runLogDir: null` turns it off for one Gateway even when the variable is set.
 */
const fs = require('fs');
const path = require('path');

const MAX_TEXT = 2000;   // longer bodies and messages are cut, with a note saying how long they were

function clip(text) {
  const s = String(text);
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}... (${s.length - MAX_TEXT} more characters)` : s;
}

const show = (v) => {
  if (v === undefined) return '(none)';
  if (Buffer.isBuffer(v)) return clip(v.toString());
  return clip(typeof v === 'string' ? v : JSON.stringify(v));
};

const indent = (text, pad = '    ') => String(text).split('\n').join('\n' + pad);

/** The log directory for a gateway, or null when run logging is off. */
function runLogDirFor(gatewayOptions) {
  if (Object.prototype.hasOwnProperty.call(gatewayOptions, 'runLogDir')) return gatewayOptions.runLogDir || null;
  return process.env.GWS_RUN_LOG_DIR || null;
}

/** e.g. test/testRetry.test.js -> testRetry.test.log; outside node --test -> runs.log */
function logFileName() {
  const main = process.argv.slice(1).find((a) => /\.(test|spec)\.[cm]?js$/.test(a) || /[\\/]test[\\/].+\.[cm]?js$/.test(a));
  return main ? path.basename(main).replace(/\.[cm]?js$/, '') + '.log' : 'runs.log';
}

const counters = new Map();

function format(res, runOptions, n) {
  const lines = [];
  const when = new Date().toTimeString().slice(0, 8);
  const label = runOptions.label ? `  "${runOptions.label}"` : '';
  const script = runOptions.filename ? path.basename(runOptions.filename) : '(inline code)';
  lines.push(`=== Run ${n}  ${when}  ${script}${label}  (${res.duration} ms)`);
  if (runOptions.__caller) lines.push(`from:      ${runOptions.__caller}`);

  const req = [];
  if (runOptions.input !== undefined) req.push(`input ${show(runOptions.input)}`);
  if (runOptions.headers) req.push(`headers ${show(runOptions.headers)}`);
  if (runOptions.serviceVars) req.push(`serviceVars ${show(runOptions.serviceVars)}`);
  if (runOptions.parameters) req.push(`parameters ${show(runOptions.parameters)}`);
  lines.push(`request:   ${req.length ? req.join('\n           ') : '(no input)'}`);

  const outcome = res.error ? '  (script threw an error)' : res.rejected ? `  (rejected: ${res.rejectReason})` : '';
  lines.push(`status:    ${res.statusCode} ${res.reasonPhrase || ''}${outcome}`);
  lines.push(`output:    ${res.output.text ? show(res.output.text) : '(empty)'}`);
  const headers = res.headers.response;
  if (headers && Object.keys(headers).length) lines.push(`headers:   ${show(headers)}`);

  lines.push(`backends:${res.urlopenCalls.length ? '' : '  (none called)'}`);
  res.urlopenCalls.forEach((c, i) => {
    const result = c.response ? `${c.response.statusCode} ${show(c.response.body)}` : `error: ${c.error || 'no response'}`;
    lines.push(`  ${i + 1}. ${c.method} ${c.target}${c.matched ? '' : '  [no mock matched]'}`);
    if (c.data && c.data.length) lines.push(`     sent:     ${show(c.data)}`);
    lines.push(`     received: ${result}`);
  });

  lines.push(`script log:${res.logs.length ? '' : ' (nothing logged)'}`);
  for (const l of res.logs) lines.push(`  [${l.level}]${l.category === 'gatewayscript-user' ? '' : ` (${l.category})`} ${indent(clip(l.message), '    ')}`);

  if (res.leakedGlobals && res.leakedGlobals.length) lines.push(`undeclared variables: ${res.leakedGlobals.join(', ')}`);
  if (res.error) lines.push(`error:     ${indent(clip(res.error.stack || res.error), '           ')}`);
  return lines.join('\n') + '\n\n';
}

/** Append one run to the log, if logging is on. Never throws: a log problem mustn't fail a test. */
function writeRunLog(gatewayOptions, res, runOptions) {
  const dir = runLogDirFor(gatewayOptions);
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, logFileName());
    const n = (counters.get(file) || 0) + 1;
    counters.set(file, n);
    fs.appendFileSync(file, format(res, runOptions, n));
  } catch (e) {
    process.emitWarning(`gws-sim: couldn't write the run log: ${e.message}`);
  }
}

module.exports = { writeRunLog, runLogDirFor, format, logFileName };
