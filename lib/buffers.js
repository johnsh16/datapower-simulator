'use strict';
/**
 * Emulation of the GatewayScript `Buffers` object: an ordered collection of
 * Buffer chunks that behaves like one logical buffer.
 */
class Buffers {
  constructor(init) {
    this._chunks = [];
    if (init == null) return;
    const list = Array.isArray(init) ? init : [init];
    for (const c of list) this.push(c);
  }

  static isBuffers(o) { return o instanceof Buffers; }

  get length() { return this._chunks.reduce((n, c) => n + c.length, 0); }

  push(...items) {
    for (const item of items) {
      if (item instanceof Buffers) this._chunks.push(...item._chunks);
      else if (Buffer.isBuffer(item)) this._chunks.push(item);
      else this._chunks.push(Buffer.from(String(item)));
    }
    return this.length;
  }

  unshift(...items) {
    const b = new Buffers(items);
    this._chunks.unshift(...b._chunks);
    return this.length;
  }

  concat(...items) {
    const out = new Buffers(this._chunks);
    out.push(...items);
    return out;
  }

  toBuffer() { return Buffer.concat(this._chunks); }

  toString(encoding = 'utf8', start, end) {
    return this.toBuffer().toString(encoding, start, end);
  }

  slice(start, end) { return new Buffers(this.toBuffer().subarray(start, end)); }

  splice(start, deleteCount, ...items) {
    const buf = this.toBuffer();
    const s = start < 0 ? Math.max(buf.length + start, 0) : Math.min(start, buf.length);
    const dc = deleteCount === undefined ? buf.length - s : Math.max(0, deleteCount);
    const removed = new Buffers(buf.subarray(s, s + dc));
    const rest = new Buffers([buf.subarray(0, s), ...new Buffers(items)._chunks, buf.subarray(s + dc)]);
    this._chunks = rest._chunks;
    return removed;
  }

  indexOf(value, byteOffset, encoding) { return this.toBuffer().indexOf(value, byteOffset, encoding); }

  get(index) { return this.toBuffer()[index]; }

  set(index, value) {
    const buf = this.toBuffer();
    buf[index] = value;
    this._chunks = [buf];
  }

  copy(target, targetStart, sourceStart, sourceEnd) {
    return this.toBuffer().copy(target, targetStart, sourceStart, sourceEnd);
  }

  toJSON() { return { type: 'Buffers', data: [...this.toBuffer()] }; }
}

/** Normalise anything GatewayScript code might write/send into a Buffer. */
function toBuffer(data) {
  if (data == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Buffers) return data.toBuffer();
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data);
  // XML DOM node?
  if (data && typeof data === 'object' && typeof data.nodeType === 'number') {
    const { XMLSerializer } = require('@xmldom/xmldom');
    return Buffer.from(new XMLSerializer().serializeToString(data));
  }
  if (typeof data === 'object') return Buffer.from(JSON.stringify(data));
  return Buffer.from(String(data));
}

module.exports = { Buffers, toBuffer };
