'use strict';
const http = require('http');

/**
 * A case-insensitive header collection with DataPower semantics.
 * get(name) / get() / set(name, value) / remove(name) / headers
 * plus statusCode / reasonPhrase on the mutable sets.
 */
class HeaderSet {
  constructor(name, initial, { readOnly = false, statusCode, reasonPhrase } = {}) {
    this._name = name;
    this._readOnly = readOnly;
    this._map = new Map(); // lowercase -> { name, value }
    for (const [k, v] of Object.entries(initial || {})) this._map.set(k.toLowerCase(), { name: k, value: v });
    this._statusCode = statusCode;
    this._reasonPhrase = reasonPhrase;
  }

  _guard(op) {
    if (this._readOnly) throw new Error(`header-metadata: ${this._name}.${op}() is not allowed; '${this._name}' headers are read-only`);
  }

  get(name) {
    if (name === undefined) return this.headers;
    const e = this._map.get(String(name).toLowerCase());
    return e ? e.value : undefined;
  }

  set(name, value) {
    this._guard('set');
    this._map.set(String(name).toLowerCase(), { name: String(name), value: Array.isArray(value) ? value.map(String) : String(value) });
  }

  remove(name) {
    this._guard('remove');
    return this._map.delete(String(name).toLowerCase());
  }

  get headers() {
    const o = {};
    for (const { name, value } of this._map.values()) o[name] = value;
    return o;
  }

  get statusCode() { return this._statusCode; }
  set statusCode(v) {
    this._guard('statusCode=');
    // DataPower accepts 404 or "404 Not Found"
    const m = String(v).match(/^\s*(\d{3})\s*(.*)$/);
    if (!m) throw new Error(`header-metadata: invalid statusCode '${v}'`);
    this._statusCode = Number(m[1]);
    this._reasonPhrase = m[2] || http.STATUS_CODES[this._statusCode] || '';
  }

  get reasonPhrase() { return this._reasonPhrase; }
  set reasonPhrase(v) { this._guard('reasonPhrase='); this._reasonPhrase = String(v); }

  toJSON() { return this.headers; }
}

/**
 * header-metadata module:
 *   hm.original  - headers as received off the wire (read-only)
 *   hm.current   - headers that will be sent on to the next hop (mutable)
 *   hm.response  - headers/status returned to the client (mutable)
 */
function createHeaderMetadata(env) {
  const h = env.runOptions.headers || {};
  const isPlain = h && !h.original && !h.current && !h.response;
  const original = isPlain ? h : (h.original || h.current || {});
  const current = isPlain ? h : (h.current || h.original || {});
  const response = isPlain ? {} : (h.response || {});
  const rs = env.runOptions.responseStatus;

  const hm = {
    original: new HeaderSet('original', original, { readOnly: true, statusCode: env.runOptions.originalStatusCode }),
    current: new HeaderSet('current', current, { statusCode: env.runOptions.currentStatusCode }),
    response: new HeaderSet('response', response, rs ? { statusCode: rs.statusCode, reasonPhrase: rs.reasonPhrase } : {}),
  };
  env.headerMetadata = hm;
  return hm;
}

module.exports = { createHeaderMetadata, HeaderSet };
