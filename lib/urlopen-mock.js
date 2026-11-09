'use strict';
const http = require('http');
const { toBuffer } = require('./buffers');

/**
 * Registry of simulated backend responses for urlopen.open().
 *
 *   gw.urlopen.when('https://api/x').reply(200, { ok: true })
 *   gw.urlopen.when({ method: 'POST', target: /token$/ }).replyOnce(503)   // first call fails...
 *     .when({ method: 'POST', target: /token$/ }).reply(200, '...')        // ...later calls succeed
 *   gw.urlopen.when(req => req.json().id === 7).reply(req => ({ statusCode: 201, body: req.json() }))
 *   gw.urlopen.when('https://slow/').delay(5000).reply(200)   // longer than options.timeout -> timeout error
 *   gw.urlopen.when('https://down/').error('connection refused')
 *   gw.urlopen.calls     // every request the script made
 */

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$');
}

function matchValue(expected, actual, req) {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) return expected.test(actual == null ? '' : String(actual));
  if (typeof expected === 'function') return !!expected(actual, req);
  if (typeof expected === 'string' && expected.includes('*')) return globToRegExp(expected).test(String(actual));
  return String(expected).toLowerCase() === String(actual).toLowerCase() || String(expected) === String(actual);
}

function compileMatcher(m) {
  if (m == null || m === '*') return () => true;
  if (typeof m === 'function') return m;
  if (typeof m === 'string' || m instanceof RegExp) return (req) => matchValue(m, req.target, req);
  // object matcher
  return (req) => {
    if (!matchValue(m.target ?? m.url, req.target, req)) return false;
    if (!matchValue(m.method, req.method, req)) return false;
    if (m.headers) {
      for (const [k, v] of Object.entries(m.headers)) if (!matchValue(v, req.getHeader(k), req)) return false;
    }
    if (m.body !== undefined) {
      if (typeof m.body === 'object' && !(m.body instanceof RegExp) && typeof m.body !== 'function') {
        let j; try { j = req.json(); } catch { return false; }
        if (!deepContains(j, m.body)) return false;
      } else if (!matchValue(m.body, req.body, req)) return false;
    }
    return true;
  };
}

function deepContains(actual, expected) {
  if (expected === actual) return true;
  if (typeof expected !== 'object' || expected === null) return false;
  if (typeof actual !== 'object' || actual === null) return false;
  return Object.keys(expected).every((k) => deepContains(actual[k], expected[k]));
}

/** Normalise a reply spec into { statusCode, reasonPhrase, headers, body:Buffer } */
function normaliseResponse(spec) {
  const headers = { ...(spec.headers || {}) };
  const hasCT = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  let body = spec.body;
  if (body != null && typeof body === 'object' && !Buffer.isBuffer(body) && typeof body.nodeType !== 'number'
      && !(body && typeof body.toBuffer === 'function')) {
    if (!hasCT) headers['Content-Type'] = 'application/json';
  } else if (typeof body === 'string' && !hasCT) {
    headers['Content-Type'] = /^\s*</.test(body) ? 'application/xml' : 'text/plain';
  } else if (body && typeof body.nodeType === 'number' && !hasCT) {
    headers['Content-Type'] = 'application/xml';
  }
  const statusCode = spec.statusCode == null ? 200 : Number(spec.statusCode);
  return {
    statusCode,
    reasonPhrase: spec.reasonPhrase ?? (http.STATUS_CODES[statusCode] || ''),
    headers,
    body: toBuffer(body),
  };
}

class MockRoute {
  constructor(matcher, description) {
    this._matcherArg = matcher;
    this.match = compileMatcher(matcher);
    this.description = description;
    this._responder = null;
    this._remaining = Infinity;
    this._delay = 0;
    this.hits = 0;
  }
  /** reply(status, body?, headers?) | reply({statusCode, reasonPhrase, headers, body}) | reply(fn(req)) */
  reply(statusOrSpecOrFn, body, headers) {
    if (typeof statusOrSpecOrFn === 'function') this._responder = statusOrSpecOrFn;
    else if (typeof statusOrSpecOrFn === 'object' && statusOrSpecOrFn !== null) this._responder = () => statusOrSpecOrFn;
    else this._responder = () => ({ statusCode: statusOrSpecOrFn, body, headers });
    return this;
  }
  replyOnce(...args) { this._remaining = 1; return this.reply(...args); }

  // ---- shortcuts ------------------------------------------------------------
  /** JSON body (Content-Type: application/json). */
  replyJson(body, status = 200, headers = {}) {
    return this.reply({ statusCode: status, body, headers: { 'Content-Type': 'application/json', ...headers } });
  }
  /** XML body (Content-Type: application/xml). */
  replyXml(xml, status = 200, headers = {}) {
    return this.reply({ statusCode: status, body: String(xml), headers: { 'Content-Type': 'application/xml', ...headers } });
  }
  /** Plain-text body (Content-Type: text/plain). */
  replyText(text, status = 200, headers = {}) {
    return this.reply({ statusCode: status, body: String(text), headers: { 'Content-Type': 'text/plain', ...headers } });
  }
  /** Just a status, e.g. replyStatus(204) or replyStatus(503, 'busy'). */
  replyStatus(status, body = '', headers = {}) {
    return this.reply({ statusCode: status, body, headers });
  }
  /**
   * Answer successive calls in order; the last answer repeats.
   *   replySequence([{ statusCode: 503 }, { statusCode: 200, body: { ok: true } }])
   * Entries are reply specs, or functions of the request.
   */
  replySequence(specs) {
    if (!Array.isArray(specs) || !specs.length) throw new TypeError('replySequence needs a non-empty array of replies');
    let i = 0;
    this._responder = (req) => {
      const spec = specs[Math.min(i++, specs.length - 1)];
      return typeof spec === 'function' ? spec(req) : spec;
    };
    return this;
  }
  /** The backend can't be reached: the script's callback gets a connection error. */
  down(message = 'connection refused') { return this.error(message); }
  /** Answer after `ms` (longer than the script's urlopen timeout means a timeout). */
  slow(ms) { return this.delay(ms); }
  /**
   * Fail the first `n` calls, then answer with whatever is chained next:
   *   gw.urlopen.when(url).failFirst(2).replyJson({ ok: true })        // 503, 503, then 200
   *   gw.urlopen.when(url).failFirst(1, 'down').replyJson({ ok: true }) // connection error, then 200
   * `failure` is a status code, 'down', 'timeout', or a reply spec.
   */
  failFirst(n, failure = 503) {
    this.times(n);
    if (failure === 'down') this.down();
    else if (failure === 'timeout') this.timeout();
    else if (typeof failure === 'number') this.replyStatus(failure);
    else this.reply(failure);
    return this._registry.when(this._matcherArg);
  }
  /** Simulate a connection-level failure (callback receives an error, no response). */
  error(errOrMessage, errorCode) {
    this._responder = () => ({ __error: errOrMessage, __code: errorCode });
    return this;
  }
  errorOnce(...args) { this._remaining = 1; return this.error(...args); }
  /** Simulate a backend that never answers within options.timeout. */
  timeout() { this._delay = Infinity; this._responder = () => ({}); return this; }
  delay(ms) { this._delay = ms; return this; }
  times(n) { this._remaining = n; return this; }
  once() { return this.times(1); }
  /** Chain another route: gw.urlopen.when(a).reply(..).when(b).reply(..) */
  when(matcher) { return this._registry.when(matcher); }
  get exhausted() { return this._remaining <= 0; }
}

class UrlopenMock {
  constructor() {
    this.routes = [];
    this.calls = [];
    /** What to do when no route matches: 'error' (default), 'passthrough' (real network) or fn(req). */
    this.onUnmatched = 'error';
  }
  when(matcher) {
    const r = new MockRoute(matcher, typeof matcher === 'function' ? '<fn>' : String(matcher && (matcher.target || matcher.url) || matcher));
    r._registry = this;
    this.routes.push(r);
    return r;
  }
  /** Add routes from plain config objects (handy for JSON/YAML fixture files). */
  load(defs) {
    for (const d of [].concat(defs || [])) {
      const r = this.when(d.match ?? d.request ?? d.target ?? '*');
      if (d.times) r.times(d.times);
      if (d.delay) r.delay(d.delay);
      if (d.timeout) r.timeout();
      else if (d.error) r.error(d.error, d.errorCode);
      else r.reply(d.response || { statusCode: d.statusCode, reasonPhrase: d.reasonPhrase, headers: d.headers, body: d.body });
    }
    return this;
  }
  reset() { this.routes = []; this.calls = []; this.onUnmatched = 'error'; return this; }
  resetCalls() { this.calls = []; return this; }
  find(req) {
    for (const r of this.routes) if (!r.exhausted && r.match(req)) return r;
    return null;
  }
  /** Assert helper: every route registered with times()/once() was consumed. */
  pendingRoutes() { return this.routes.filter((r) => r._remaining !== Infinity && r._remaining > 0); }
}

module.exports = { UrlopenMock, MockRoute, normaliseResponse, compileMatcher };
