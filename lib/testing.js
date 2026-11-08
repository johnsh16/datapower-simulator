'use strict';
/**
 * Test helpers for gws-sim: require('gws-sim/testing').
 *
 * Assertions on a run result:
 *   expectRun(res).succeeded().status(200).json({ id: 7 }).calledBackend('GET', /users/)
 *
 * Setup shortcuts:
 *   const newGateway = gatewayFactory({ localDir }, (gw) => { gw.urlopen.when(/token/).replyJson({ access_token: 't' }); });
 *   const res = await newGateway().run('local:///orders.js', request.json({ sku: 'X1' }, { method: 'POST', uri: '/orders' }));
 *
 * Assertions throw Node's AssertionError, so they work with node:test, Jest, Mocha
 * or anything else. Every failure message ends with a summary of the run.
 */
const assert = require('assert');
const util = require('util');
const xpath = require('xpath');
const { Gateway } = require('./gateway');
const XML = require('./xml');

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------
/**
 * Does `actual` satisfy `expected`?
 *   RegExp   -> tests the string form
 *   function -> predicate(actual)
 *   object   -> every key in expected matches (extra keys in actual are fine)
 *   array    -> same length, each element matches
 *   anything else -> strict equality
 */
function matches(actual, expected) {
  if (expected instanceof RegExp) return actual != null && expected.test(typeof actual === 'string' ? actual : String(actual));
  if (typeof expected === 'function') return !!expected(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return false;
    return Object.keys(expected).every((k) => matches(actual[k], expected[k]));
  }
  return Object.is(actual, expected);
}

/** Exact deep equality, except that RegExp and function values in `expected` act as matchers. */
function equalsWithMatchers(actual, expected) {
  if (expected instanceof RegExp || typeof expected === 'function') return matches(actual, expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => equalsWithMatchers(actual[i], e));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const ka = Object.keys(actual), ke = Object.keys(expected);
    return ka.length === ke.length && ke.every((k) => Object.prototype.hasOwnProperty.call(actual, k) && equalsWithMatchers(actual[k], expected[k]));
  }
  return Object.is(actual, expected);
}

/** A target matcher: exact URL, glob with *, RegExp, or predicate. */
function targetMatches(target, expected) {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) return expected.test(target);
  if (typeof expected === 'function') return !!expected(target);
  if (String(expected).includes('*')) {
    const re = new RegExp('^' + String(expected).replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(target);
  }
  return target === String(expected);
}

const show = (v) => util.inspect(v, { depth: 6, breakLength: 100, maxStringLength: 400 });
const getHeader = (headers, name) => {
  const k = Object.keys(headers || {}).find((h) => h.toLowerCase() === String(name).toLowerCase());
  return k === undefined ? undefined : headers[k];
};

// ---------------------------------------------------------------------------
// run summary, appended to every failure
// ---------------------------------------------------------------------------
function describeRun(res) {
  const lines = [];
  const body = res.output && res.output.text;
  lines.push(`  status:   ${res.statusCode} ${res.reasonPhrase || ''}${res.rejected ? `  (rejected: ${res.rejectReason})` : ''}`);
  if (res.error) lines.push(`  error:    ${String(res.error.stack || res.error).split('\n').slice(0, 3).join('\n            ')}`);
  lines.push(`  body:     ${body ? (body.length > 400 ? JSON.stringify(body.slice(0, 400)) + '...' : JSON.stringify(body)) : '(empty)'}`);
  const rh = res.headers && res.headers.response;
  if (rh && Object.keys(rh).length) lines.push(`  headers:  ${show(rh)}`);
  const calls = res.urlopenCalls || [];
  lines.push(`  backends: ${calls.length ? '' : '(none called)'}`);
  for (const c of calls) {
    const outcome = c.response ? c.response.statusCode : 'error';
    lines.push(`            ${c.method} ${c.target} -> ${outcome}${c.matched ? '' : '  (no mock matched)'}`);
  }
  const logs = (res.logs || []).filter((l) => ['emerg', 'alert', 'critic', 'error', 'warn'].includes(l.level));
  if (logs.length) {
    lines.push('  logs:');
    for (const l of logs.slice(0, 8)) lines.push(`            [${l.level}] ${l.message.split('\n')[0]}`);
  }
  return 'Run:\n' + lines.join('\n');
}

// ---------------------------------------------------------------------------
// expectRun
// ---------------------------------------------------------------------------
class RunExpectation {
  constructor(res) {
    if (!res || typeof res !== 'object' || !('statusCode' in res) || !res.output) {
      throw new TypeError('expectRun() needs the result of gw.run() or gw.runCode(). Did you forget to await it?');
    }
    this.res = res;
  }

  _fail(message, details) {
    throw new assert.AssertionError({
      message: `${message}${details ? '\n' + details : ''}\n\n${describeRun(this.res)}`,
      stackStartFn: this._fail,
    });
  }
  _check(ok, message, details) { if (!ok) this._fail(message, details); return this; }
  _json() {
    const text = this.res.output.text;
    try { return text ? JSON.parse(text) : undefined; } catch (e) {
      return this._fail('Expected the response body to be JSON, but it isn\'t', `  parse error: ${e.message}`);
    }
  }
  _calls(method, target) {
    return this.res.urlopenCalls.filter((c) => (!method || c.method.toUpperCase() === String(method).toUpperCase()) && targetMatches(c.target, target));
  }
  /** calledBackend(target) or calledBackend(method, target); options optional last. */
  _callArgs(args) {
    let [a, b, c] = args;
    if (b === undefined || (b !== null && typeof b === 'object' && !(b instanceof RegExp))) return { method: undefined, target: a, opts: b || {} };
    return { method: a, target: b, opts: c || {} };
  }
  _label(method, target) { return `${method ? method.toUpperCase() + ' ' : ''}${target instanceof RegExp ? target : JSON.stringify(target)}`; }

  // ---- outcome ---------------------------------------------------------------
  /** The script finished: no uncaught error and no session.reject(). */
  succeeded() {
    if (this.res.error) this._fail('Expected the script to succeed, but it threw an error');
    return this._check(!this.res.rejected, `Expected the script to succeed, but it called session.reject(${JSON.stringify(this.res.rejectReason)})`);
  }
  /** session.reject() was called, optionally with a matching reason. */
  rejected(reason) {
    this._check(this.res.rejected, 'Expected the script to reject the request, but it didn\'t');
    return this._check(reason === undefined || matches(this.res.rejectReason, reason),
      `Expected the reject reason to match ${show(reason)}`, `  actual:   ${JSON.stringify(this.res.rejectReason)}`);
  }
  /** The script threw an uncaught error, optionally matching a message. */
  crashed(message) {
    this._check(!!this.res.error, 'Expected the script to throw an error, but it didn\'t');
    return this._check(message === undefined || matches(this.res.error.message, message),
      `Expected the error message to match ${show(message)}`, `  actual:   ${JSON.stringify(this.res.error.message)}`);
  }
  /** No error, no reject, and no warnings or errors logged by the script or simulator. */
  clean() {
    this.succeeded();
    const bad = this.res.logs.filter((l) => ['emerg', 'alert', 'critic', 'error', 'warn'].includes(l.level));
    return this._check(!bad.length, `Expected no warnings or errors in the logs, but found ${bad.length}`);
  }

  // ---- response ----------------------------------------------------------------
  /** Status code sent to the client, and optionally its reason phrase. */
  status(code, reason) {
    this._check(this.res.statusCode === code, `Expected status ${code} but got ${this.res.statusCode}`);
    return this._check(reason === undefined || matches(this.res.reasonPhrase, reason),
      `Expected reason phrase ${show(reason)} but got ${JSON.stringify(this.res.reasonPhrase)}`);
  }
  /** A response header (case-insensitive name; value string, RegExp or predicate). Omit value to check it exists. */
  header(name, value) {
    const actual = getHeader(this.res.headers.response, name);
    this._check(actual !== undefined, `Expected response header ${JSON.stringify(name)} to be set, but it isn't`);
    return this._check(value === undefined || matches(actual, value),
      `Expected response header ${JSON.stringify(name)} to match ${show(value)}`, `  actual:   ${JSON.stringify(actual)}`);
  }
  /** A response header that must not be set. */
  noHeader(name) {
    const actual = getHeader(this.res.headers.response, name);
    return this._check(actual === undefined, `Expected response header ${JSON.stringify(name)} not to be set`, `  actual:   ${JSON.stringify(actual)}`);
  }
  /** A header forwarded to the backend (hm.current). */
  forwardedHeader(name, value) {
    const actual = getHeader(this.res.headers.current, name);
    this._check(actual !== undefined, `Expected header ${JSON.stringify(name)} to be forwarded (hm.current), but it isn't set`);
    return this._check(value === undefined || matches(actual, value),
      `Expected forwarded header ${JSON.stringify(name)} to match ${show(value)}`, `  actual:   ${JSON.stringify(actual)}`);
  }
  /** The JSON body equals `expected` exactly (RegExp / function values inside act as matchers). */
  json(expected) {
    const actual = this._json();
    return this._check(equalsWithMatchers(actual, expected), 'Expected the JSON body to equal the expected value',
      `  expected: ${show(expected)}\n  actual:   ${show(actual)}`);
  }
  /** The JSON body contains `expected` (extra fields are fine). */
  jsonIncludes(expected) {
    const actual = this._json();
    return this._check(matches(actual, expected), 'Expected the JSON body to include the expected fields',
      `  expected: ${show(expected)}\n  actual:   ${show(actual)}`);
  }
  /** The body as text: exact string, RegExp, or predicate. */
  text(expected) {
    const actual = this.res.output.text;
    return this._check(matches(actual, expected), `Expected the body to match ${show(expected)}`);
  }
  /** Evaluate XPath on the XML body: xpath('string(//id)', '7'), or omit expected to check a node exists. */
  xpath(expression, expected, namespaces) {
    let doc;
    try { doc = XML.parse(this.res.output.text); } catch (e) { return this._fail('Expected the response body to be XML, but it isn\'t', `  parse error: ${e.message}`); }
    const select = namespaces ? xpath.useNamespaces(namespaces) : xpath.select;
    let value = select(expression, doc);
    if (Array.isArray(value)) {
      if (expected === undefined) return this._check(value.length > 0, `Expected XPath ${expression} to select something, but it selected nothing`);
      value = value.length ? (value[0].textContent ?? value[0].nodeValue) : undefined;
    }
    if (expected === undefined) return this._check(value !== '' && value !== false && value !== undefined, `Expected XPath ${expression} to be non-empty`);
    return this._check(matches(value, expected), `Expected XPath ${expression} to match ${show(expected)}`, `  actual:   ${show(value)}`);
  }

  // ---- backends -----------------------------------------------------------------
  /**
   * The script called a backend: calledBackend(target) / calledBackend(method, target),
   * with options { times: n }. Target: exact URL, glob with *, or RegExp.
   */
  calledBackend(...args) {
    const { method, target, opts } = this._callArgs(args);
    const calls = this._calls(method, target);
    if (opts.times !== undefined) {
      return this._check(calls.length === opts.times, `Expected ${this._label(method, target)} to be called ${opts.times} time(s), but it was called ${calls.length} time(s)`);
    }
    return this._check(calls.length > 0, `Expected ${this._label(method, target)} to be called, but it wasn't`);
  }
  /** The script did not call a backend. */
  notCalledBackend(...args) {
    const { method, target } = this._callArgs(args);
    const calls = this._calls(method, target);
    return this._check(calls.length === 0, `Expected ${this._label(method, target)} not to be called, but it was called ${calls.length} time(s)`);
  }
  /** The exact sequence of backend calls, as 'METHOD url' strings (RegExp entries allowed). */
  backendCalls(expected) {
    const actual = this.res.urlopenCalls.map((c) => `${c.method} ${c.target}`);
    return this._check(Array.isArray(expected) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e)),
      'Expected a different sequence of backend calls', `  expected: ${show(expected)}\n  actual:   ${show(actual)}`);
  }
  /**
   * What the script sent to a backend (the first matching call, or { call: n }):
   *   sentToBackend('POST', /token/, { headers: { Authorization: /^Bearer / }, json: { sku: 'X1' }, body: /grant_type/, timeout: 5 })
   */
  sentToBackend(...args) {
    if (args.length < 2 || args.length > 3) throw new TypeError('sentToBackend(target, checks) or sentToBackend(method, target, checks)');
    const [method, target, opts] = args.length === 3 ? args : [undefined, args[0], args[1]];
    const calls = this._calls(method, target);
    const label = this._label(method, target);
    this._check(calls.length > 0, `Expected ${label} to be called, but it wasn't`);
    const call = calls[opts.call || 0];
    this._check(!!call, `Expected at least ${(opts.call || 0) + 1} call(s) to ${label}, but there were ${calls.length}`);
    for (const [name, value] of Object.entries(opts.headers || {})) {
      const actual = call.getHeader(name);
      this._check(actual !== undefined && matches(actual, value), `Expected ${label} to be sent header ${JSON.stringify(name)} matching ${show(value)}`, `  actual:   ${JSON.stringify(actual)}`);
    }
    if (opts.json !== undefined) {
      let actual;
      try { actual = call.json(); } catch { this._fail(`Expected ${label} to be sent JSON, but the request body isn't JSON`, `  body:     ${JSON.stringify(call.body)}`); }
      this._check(matches(actual, opts.json), `Expected ${label} to be sent JSON including the expected fields`, `  expected: ${show(opts.json)}\n  actual:   ${show(actual)}`);
    }
    if (opts.body !== undefined) this._check(matches(call.body, opts.body), `Expected ${label} to be sent a body matching ${show(opts.body)}`, `  actual:   ${JSON.stringify(call.body)}`);
    if (opts.timeout !== undefined) this._check(call.timeout === opts.timeout, `Expected ${label} to use timeout ${opts.timeout}s`, `  actual:   ${call.timeout}s${call.options && call.options.timeout == null ? ' (not set by the script; the default)' : ''}`);
    return this;
  }

  // ---- logs, variables, files ---------------------------------------------------------
  /** A log message at a level (or any level) matching text: logged('error', /timeout/) or logged(/timeout/). */
  logged(levelOrText, text) {
    const level = text === undefined ? undefined : levelOrText;
    const pattern = text === undefined ? levelOrText : text;
    const hit = this.res.logs.some((l) => (!level || l.level === level || (level === 'critical' && l.level === 'critic')) && matches(l.message, pattern));
    return this._check(hit, `Expected a ${level ? level + ' ' : ''}log message matching ${show(pattern)}`,
      `  logged:\n${this.res.logs.map((l) => `            [${l.level}] ${l.message.split('\n')[0]}`).join('\n') || '            (nothing)'}`);
  }
  /** No log message at this level (or matching text). */
  notLogged(levelOrText, text) {
    const level = text === undefined && typeof levelOrText === 'string' && /^(emerg|alert|critic|critical|error|warn|notice|info|debug)$/.test(levelOrText) ? levelOrText : (text === undefined ? undefined : levelOrText);
    const pattern = text !== undefined ? text : (level ? undefined : levelOrText);
    const hits = this.res.logs.filter((l) => (!level || l.level === level) && (pattern === undefined || matches(l.message, pattern)));
    return this._check(!hits.length, `Expected no ${level ? level + ' ' : ''}log messages${pattern !== undefined ? ' matching ' + show(pattern) : ''}, but found ${hits.length}`,
      hits.slice(0, 5).map((l) => `            [${l.level}] ${l.message.split('\n')[0]}`).join('\n'));
  }
  /** A service variable after the run: serviceVar('var://service/mpgw/skip-backside', true). */
  serviceVar(name, value) {
    const actual = this.res.serviceVars[name];
    return this._check(value === undefined ? actual !== undefined && actual !== '' : matches(actual, value),
      `Expected service variable ${name} to ${value === undefined ? 'be set' : 'match ' + show(value)}`, `  actual:   ${show(actual)}`);
  }
  /** A context variable: contextVar('audit', 'orders', value?). */
  contextVar(context, name, value) {
    const ctx = this.res.contexts[context];
    this._check(!!ctx, `Expected context ${JSON.stringify(context)} to exist, but it doesn't`, `  contexts: ${Object.keys(this.res.contexts).join(', ')}`);
    const actual = ctx.variables[name];
    return this._check(value === undefined ? actual !== undefined : matches(actual, value),
      `Expected ${context}.${name} to ${value === undefined ? 'be set' : 'match ' + show(value)}`, `  actual:   ${show(actual)}`);
  }
  /** A file the script left behind (e.g. with fs): wroteFile('temporary:///t.json', { json: {...} } | { text } | omitted). */
  wroteFile(dpUrl, expected) {
    const buf = this.res.readFile(dpUrl);
    this._check(buf !== undefined, `Expected ${dpUrl} to exist after the run, but it doesn't`);
    if (expected && expected.json !== undefined) {
      let actual;
      try { actual = JSON.parse(buf.toString()); } catch { this._fail(`Expected ${dpUrl} to contain JSON, but it doesn't`, `  content:  ${JSON.stringify(buf.toString().slice(0, 200))}`); }
      this._check(matches(actual, expected.json), `Expected ${dpUrl} to contain the expected JSON`, `  expected: ${show(expected.json)}\n  actual:   ${show(actual)}`);
    }
    if (expected && expected.text !== undefined) this._check(matches(buf.toString(), expected.text), `Expected ${dpUrl} to match ${show(expected.text)}`, `  content:  ${JSON.stringify(buf.toString().slice(0, 200))}`);
    return this;
  }
  /** No file at this DataPower path after the run. */
  noFile(dpUrl) {
    return this._check(this.res.readFile(dpUrl) === undefined, `Expected ${dpUrl} not to exist after the run, but it does`);
  }
}

/** Start a chain of assertions on a run result. */
function expectRun(res) { return new RunExpectation(res); }

// ---------------------------------------------------------------------------
// setup shortcuts
// ---------------------------------------------------------------------------
/**
 * A function that makes a fresh Gateway per test with shared options and setup:
 *   const newGateway = gatewayFactory({ localDir }, (gw) => { gw.urlopen.when(/token/).replyJson({...}); });
 *   const gw = newGateway((gw) => { ... per-test additions, registered before the shared ones so they win ... });
 */
function gatewayFactory(options = {}, sharedSetup) {
  return function newGateway(perTest) {
    const gw = new Gateway(options);
    if (perTest) perTest(gw);
    if (sharedSetup) sharedSetup(gw);
    return gw;
  };
}

function withRequestOptions(base, opts = {}) {
  const { method, uri, url, headers, serviceVars, ...rest } = opts;
  const out = { ...rest, ...base };
  out.headers = { ...(base.headers || {}), ...(headers || {}) };
  const sv = { ...(serviceVars || {}) };
  if (method) sv['var://service/protocol-method'] = String(method).toUpperCase();
  if (uri) sv['var://service/URI'] = uri;
  if (url) sv['var://service/URL-in'] = url;
  if (Object.keys(sv).length) out.serviceVars = sv;
  return out;
}

/**
 * Run options for common requests. Each accepts { method, uri, url, headers,
 * serviceVars, contexts, parameters, ... } in its last argument.
 *   request.json({ sku: 'X1' }, { method: 'POST', uri: '/orders', headers: { Authorization: 'Bearer t' } })
 */
const request = {
  json: (body, opts) => withRequestOptions({ input: body, headers: { 'Content-Type': 'application/json' } }, opts),
  xml: (body, opts) => withRequestOptions({ input: typeof body === 'string' ? body : XML.stringify(body), headers: { 'Content-Type': 'application/xml' } }, opts),
  text: (body, opts) => withRequestOptions({ input: String(body), headers: { 'Content-Type': 'text/plain' } }, opts),
  form: (fields, opts) => withRequestOptions({
    input: new URLSearchParams(fields).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, opts),
  empty: (opts) => withRequestOptions({}, { method: 'GET', ...opts }),
};

/** Move the clock that fs TTLs use: advanceTime(gw, 301) is five minutes and a second later. */
function advanceTime(gw, seconds) {
  const offset = (gw.__timeOffset || 0) + seconds * 1000;
  gw.__timeOffset = offset;
  gw.now = () => Date.now() + offset;
  return gw;
}

/**
 * Put files in temporary:/// before a run, as earlier transactions would have:
 *   seedTemporary(gw, { 'token.json': { token: 'abc' }, 'note.txt': 'hi' })
 * Objects are written as JSON. TTL defaults to 0 (kept) so seeds don't expire mid-test.
 */
function seedTemporary(gw, files, { ttl = 0 } = {}) {
  const fs = require('fs');
  const path = require('path');
  const dir = gw.temporaryDir();
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name.replace(/^temporary:\/\/\/?/, ''));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
    gw.temporaryExpiries.set(path.resolve(p), ttl === 0 ? Infinity : gw.now() + ttl * 1000);
  }
  return gw;
}

module.exports = {
  expectRun, RunExpectation, describeRun, matches,
  gatewayFactory, request, advanceTime, seedTemporary,
};
