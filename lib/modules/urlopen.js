'use strict';
const fs = require('fs');
const http = require('http');
const { Buffers, toBuffer } = require('../buffers');
const { normaliseResponse } = require('../urlopen-mock');
const XML = require('../xml');

function urlopenError(message, code, extra) {
  const e = new Error(message);
  e.errorMessage = message;
  e.errorCode = code || '0x8580005c';
  e.errorDescription = extra && extra.description || message;
  e.errorSuggestion = extra && extra.suggestion || 'Check the target and the mock configuration.';
  if (extra && extra.type) e.type = extra.type;
  return e;
}

/** The request object handed to mock matchers/handlers and recorded in gw.urlopen.calls */
function buildRequest(options) {
  if (typeof options === 'string') options = { target: options };
  if (!options || !options.target) throw new TypeError('urlopen.open: options.target is required');
  const headers = {};
  for (const [k, v] of Object.entries(options.headers || {})) headers[k] = v;
  if (options.contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = options.contentType;
  }
  const hasData = options.data !== undefined && options.data !== null;
  const data = hasData ? toBuffer(options.data) : Buffer.alloc(0);
  if (hasData && typeof options.data === 'object' && !Buffer.isBuffer(options.data) && typeof options.data.nodeType !== 'number'
      && !(options.data instanceof Buffers) && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  const method = String(options.method || (hasData ? 'POST' : 'GET')).toUpperCase();
  const req = {
    target: String(options.target),
    method,
    headers,
    data,
    get body() { return data.toString(); },
    json() { return JSON.parse(data.toString()); },
    xml() { return XML.parse(data); },
    getHeader(name) {
      const k = Object.keys(headers).find((h) => h.toLowerCase() === String(name).toLowerCase());
      return k === undefined ? undefined : headers[k];
    },
    timeout: options.timeout == null ? 60 : Number(options.timeout), // seconds, DataPower default
    sslClientProfile: options.sslClientProfile,
    sslProxyProfile: options.sslProxyProfile,
    agent: options.agent,
    options,
    time: new Date().toISOString(),
  };
  return req;
}

/** The response object passed to the urlopen.open callback. */
class UrlopenResponse {
  constructor(env, spec) {
    Object.defineProperty(this, '_env', { value: env });
    Object.defineProperty(this, '_body', { value: spec.body, writable: true });
    this.statusCode = spec.statusCode;
    this.reasonPhrase = spec.reasonPhrase;
    this.headers = spec.headers;
  }
  get(name) {
    const k = Object.keys(this.headers).find((h) => h.toLowerCase() === String(name).toLowerCase());
    return k === undefined ? undefined : this.headers[k];
  }
  _read(kind, cb) {
    this._env.trace('response.read', { kind, bytes: this._body ? this._body.length : 0 });
    return this._env.async(() => {
      if (this._body === null) throw urlopenError('urlopen: response body already consumed or disconnected', '0x85800062');
      const body = this._body;
      switch (kind) {
        case 'buffer': return body;
        case 'buffers': return new Buffers(body);
        case 'json':
          try { return JSON.parse(body.toString()); } catch (e) {
            throw urlopenError('readAsJSON: response is not valid JSON: ' + e.message, '0x85800063');
          }
        case 'xml': return XML.parse(body);
      }
    }, cb, `response.readAs${{ buffer: 'Buffer', buffers: 'Buffers', json: 'JSON', xml: 'XML' }[kind]} callback`);
  }
  readAsBuffer(cb) { return this._read('buffer', cb); }
  readAsBuffers(cb) { return this._read('buffers', cb); }
  readAsJSON(cb) { return this._read('json', cb); }
  readAsXML(cb) { return this._read('xml', cb); }
  disconnect() { this._body = null; }
}

function localFileResponse(env, req) {
  const p = env.resolveDpUrl(req.target);
  if (!p) return null;
  if (req.method !== 'GET' && req.method !== 'POST') return null;
  try {
    const body = fs.readFileSync(p);
    return normaliseResponse({ statusCode: 200, body });
  } catch (e) {
    return { __error: `urlopen: cannot open ${req.target}: ${e.code || e.message}`, __code: '0x85800051' };
  }
}

async function passthrough(req) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), req.timeout * 1000);
  try {
    const r = await fetch(req.target, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.data,
      signal: ctrl.signal,
    });
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return { statusCode: r.status, reasonPhrase: r.statusText || http.STATUS_CODES[r.status], headers, body: Buffer.from(await r.arrayBuffer()) };
  } finally { clearTimeout(t); }
}

/**
 * urlopen module: urlopen.open(options|target, callback(error, response))
 * Requests are answered by the gateway's mock registry (gw.urlopen), then
 * local:/// / store:/// files, then the onUnmatched policy.
 */
function createUrlopen(env) {
  const mock = env.gateway.urlopen;

  function open(options, callback) {
    if (typeof callback !== 'function') {
      return new Promise((resolve, reject) => open(options, (e, r) => (e ? reject(e) : resolve(r))));
    }
    let req;
    try { req = buildRequest(options); } catch (e) { return env.async(() => { throw e; }, callback); }

    const route = mock.find(req);
    const call = { ...req, matched: route ? route.description : null };
    delete call.options; call.options = options;
    mock.calls.push(call);
    env.urlopenCalls.push(call);
    env.trace('urlopen.open', {
      method: req.method, target: req.target, matched: call.matched,
      timeoutSet: typeof options === 'object' && options.timeout != null, dataBytes: req.data.length,
    });

    const resolveSpec = async () => {
      if (route) {
        route._remaining -= 1; route.hits += 1;
        const out = await route._responder(req);
        return { spec: out || {}, delay: route._delay };
      }
      const local = localFileResponse(env, req);
      if (local) return { spec: local, delay: 0 };
      const policy = mock.onUnmatched;
      if (typeof policy === 'function') return { spec: (await policy(req)) || {}, delay: 0 };
      if (policy === 'passthrough') return { spec: await passthrough(req), delay: 0 };
      return { spec: { __error: `urlopen: no mock matched ${req.method} ${req.target}`, __code: '0x8580005d' }, delay: 0 };
    };

    env.pending++;
    resolveSpec().then(({ spec, delay }) => {
      const timeoutMs = req.timeout * 1000;
      if (delay > timeoutMs) {
        const e = urlopenError(`urlopen: timeout after ${req.timeout}s waiting for ${req.target}`, '0x85800064', { type: 'timeout' });
        call.error = e.errorMessage;
        return env.later(env.simDelay(timeoutMs), () => callback(e), 'urlopen callback');
      }
      if (spec instanceof Error || spec.__error !== undefined) {
        const src = spec instanceof Error ? spec : spec.__error;
        const e = src instanceof Error ? Object.assign(src, { errorMessage: src.errorMessage || src.message, errorCode: src.errorCode || spec.__code || '0x8580005c' })
          : urlopenError(String(src), spec.__code);
        call.error = e.errorMessage;
        return env.later(env.simDelay(delay), () => callback(e), 'urlopen callback');
      }
      const resp = new UrlopenResponse(env, normaliseResponse(spec));
      call.response = { statusCode: resp.statusCode, reasonPhrase: resp.reasonPhrase, headers: resp.headers, body: resp._body.toString() };
      env.later(env.simDelay(delay), () => callback(null, resp), 'urlopen callback');
    }).catch((e) => {
      call.error = `urlopen: ${e.message}`;
      env.later(0, () => callback(urlopenError(call.error, '0x8580005c')));
    }).finally(() => { env.pending--; env.checkDone(); });
  }

  return { open, UrlopenResponse };
}

module.exports = { createUrlopen, buildRequest, UrlopenResponse, urlopenError };
