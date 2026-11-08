'use strict';
const { Buffers, toBuffer } = require('./buffers');
const XML = require('./xml');

function dpError(message, code) {
  const e = new Error(message);
  e.errorMessage = message;
  e.errorCode = code || '0x85800001';
  return e;
}

/**
 * A GatewayScript context (session.input, session.output, or a named
 * context created by session.createContext / referenced by session.name).
 */
class Context {
  constructor(env, name, body, vars) {
    Object.defineProperty(this, '_env', { value: env, enumerable: false });
    this.name = name;
    this._body = body == null ? null : toBuffer(body);
    this._vars = new Map(Object.entries(vars || {}));
  }

  // ---- writing ------------------------------------------------------------
  write(data) {
    if (this.name === 'OUTPUT' && this._env.rejected) {
      this._env.log('warn', 'gatewayscript', 'session.output.write ignored after session.reject()');
      return;
    }
    const buf = toBuffer(data);
    this._body = this._env.options.appendOutput && this._body ? Buffer.concat([this._body, buf]) : buf;
    this._env.trace('context.write', { context: this.name, bytes: buf.length });
  }

  // ---- reading ------------------------------------------------------------
  _read(kind, cb) {
    const run = () => {
      const body = this._body || Buffer.alloc(0);
      switch (kind) {
        case 'buffer': return body;
        case 'buffers': return new Buffers(body);
        case 'json': {
          if (!body.length) throw dpError(`readAsJSON: context '${this.name}' is empty`);
          try { return JSON.parse(body.toString()); } catch (e) {
            throw dpError(`readAsJSON: invalid JSON in context '${this.name}': ${e.message}`);
          }
        }
        case 'xml': {
          if (!body.length) throw dpError(`readAsXML: context '${this.name}' is empty`);
          return XML.parse(body);
        }
      }
    };
    return this._env.async(run, cb);
  }

  readAsBuffer(cb) { return this._read('buffer', cb); }
  readAsBuffers(cb) { return this._read('buffers', cb); }
  readAsJSON(cb) { return this._read('json', cb); }
  readAsXML(cb) { return this._read('xml', cb); }

  // ---- context variables (var://context/<name>/<var>) ---------------------
  setVariable(name, value) { this._vars.set(name, value); }
  getVariable(name) { return this._vars.get(name); }
  deleteVariable(name) { return this._vars.delete(name); }
  listVariables() { return [...this._vars.keys()]; }
  setVar(name, value) { return this.setVariable(name, value); }
  getVar(name) { return this.getVariable(name); }
  deleteVar(name) { return this.deleteVariable(name); }

  // ---- test helpers (not part of DataPower) --------------------------------
  get body() { return this._body; }
  get text() { return this._body ? this._body.toString() : ''; }
  json() { return this._body && this._body.length ? JSON.parse(this._body.toString()) : undefined; }
  xml() { return this._body && this._body.length ? XML.parse(this._body) : undefined; }
  get variables() { return Object.fromEntries(this._vars); }
}

module.exports = { Context, dpError };
