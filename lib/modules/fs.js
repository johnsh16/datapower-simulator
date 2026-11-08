'use strict';
/**
 * The DataPower GatewayScript fs module (require('fs')). This is NOT Node's fs.
 *
 * Functions, per the DataPower GatewayScript cheat sheet: appendFile, exists,
 * readFile, readAsJSON, readAsXML, rename, temporary, truncate, unlink, writeFile.
 *
 * Behaviour, from IBM's fs module page as quoted in the IBM community and IBM APARs
 * IT30858 / IT46135:
 *   - files are named by DataPower URL: local:///..., store:///..., temporary:///...
 *   - scripts write to temporary: only
 *   - a file written to temporary: has a time-to-live given by the TTL label, in
 *     seconds, 0-86400, default 10. TTL 0 keeps the file. The TTL applies only to
 *     temporary:, and the file outlives the transaction that wrote it.
 *
 * Calls are asynchronous with Node-style callbacks (error, result). Without a
 * callback they return a Promise. The exact argument order of the "second forms"
 * isn't documented in sources available here, so both likely shapes are accepted:
 *   fs.writeFile('temporary:///a.json', data, cb)
 *   fs.writeFile({ file: 'temporary:///a.json', TTL: 60 }, data, cb)
 *   fs.writeFile('temporary:///a.json', data, { TTL: 60 }, cb)
 */
const nodeFs = require('fs');
const path = require('path');
const { toBuffer } = require('../buffers');
const XML = require('../xml');

const DEFAULT_TTL = 10;
const MAX_TTL = 86400;
const READABLE = ['local', 'store', 'temporary'];

function fsError(message, code) {
  const e = new Error(message);
  e.errorMessage = message;
  e.code = code;
  return e;
}

function createFs(env) {
  const gw = env.gateway;
  const expiries = gw.temporaryExpiries; // absolute path -> expiry time in ms (Infinity = kept)
  const writable = env.options.fsWritable;

  /** 'temporary:///a/b.json' or { file, TTL } -> { file, scheme, abs, ttl } */
  function target(arg, access) {
    let file = arg;
    let ttl;
    if (arg && typeof arg === 'object' && !Buffer.isBuffer(arg)) {
      file = arg.file ?? arg.path ?? arg.name;
      ttl = arg.TTL ?? arg.ttl;
    }
    if (typeof file !== 'string') {
      throw new TypeError("fs: the file must be a DataPower URL such as 'temporary:///name.json', or an object { file, TTL }");
    }
    const m = file.match(/^([a-z]+):\/\/\/?(.*)$/i);
    if (!m) throw fsError(`fs: '${file}' isn't a DataPower file URL. Use local:///, store:/// or temporary:///.`, 'EINVAL');
    const scheme = m[1].toLowerCase();
    if (access === 'write' && !writable.includes(scheme)) {
      throw fsError(`fs: ${scheme}: is read-only to GatewayScript; write to temporary:/// instead`, 'EACCES');
    }
    if (access === 'read' && !READABLE.includes(scheme) && !writable.includes(scheme)) {
      throw fsError(`fs: ${scheme}: can't be read with fs`, 'EACCES');
    }
    const base = env.dirFor(scheme);
    const abs = path.resolve(base, m[2]);
    if (abs !== base && !abs.startsWith(base + path.sep)) throw fsError(`fs: '${file}' points outside ${scheme}:`, 'EACCES');
    return { file, scheme, abs, ttl };
  }

  /** Lazily delete a temporary: file whose TTL has passed. */
  function expire(t) {
    const until = expiries.get(t.abs);
    if (until !== undefined && gw.now() >= until) {
      try { nodeFs.unlinkSync(t.abs); } catch { /* already gone */ }
      expiries.delete(t.abs);
    }
  }
  function present(t) {
    expire(t);
    return nodeFs.existsSync(t.abs) && nodeFs.statSync(t.abs).isFile();
  }
  function mustExist(t) {
    if (!present(t)) throw fsError(`fs: ${t.file} doesn't exist`, 'ENOENT');
  }

  function applyTtl(t, opts, isNew) {
    const ttl = t.ttl ?? (opts && (opts.TTL ?? opts.ttl));
    if (t.scheme !== 'temporary') {
      if (ttl !== undefined) env.log('warn', 'gws-sim', `fs: TTL only applies to temporary:, ignored for ${t.file}`);
      return;
    }
    if (ttl === undefined && !isNew) return; // appending keeps the existing lifetime
    const secs = ttl === undefined ? DEFAULT_TTL : Number(ttl);
    if (!Number.isInteger(secs) || secs < 0) throw new RangeError(`fs: TTL must be a whole number of seconds from 0 to ${MAX_TTL}; got ${ttl}`);
    if (secs > MAX_TTL) env.log('warn', 'gws-sim', `fs: TTL ${secs} is above the documented maximum of ${MAX_TTL} seconds`);
    expiries.set(t.abs, secs === 0 ? Infinity : gw.now() + secs * 1000);
  }

  function write(t, data, opts, append) {
    const isNew = !present(t);
    nodeFs.mkdirSync(path.dirname(t.abs), { recursive: true });
    (append ? nodeFs.appendFileSync : nodeFs.writeFileSync)(t.abs, toBuffer(data));
    applyTtl(t, opts, isNew);
    env.trace(append ? 'fs.appendFile' : 'fs.writeFile', { file: t.file, bytes: toBuffer(data).length });
  }

  /** Wrap an implementation: trailing callback -> (err, result); none -> Promise. */
  const op = (name, impl) => function (...args) {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
    return env.async(() => impl(...args), cb, `fs.${name} callback`);
  };

  const fs = {
    readFile: op('readFile', (file, options) => {
      const t = target(file, 'read');
      mustExist(t);
      env.trace('fs.readFile', { file: t.file });
      const buf = nodeFs.readFileSync(t.abs);
      const enc = typeof options === 'string' ? options : options && options.encoding;
      return enc ? buf.toString(enc) : buf;
    }),
    readAsJSON: op('readAsJSON', (file) => {
      const t = target(file, 'read');
      mustExist(t);
      env.trace('fs.readAsJSON', { file: t.file });
      try { return JSON.parse(nodeFs.readFileSync(t.abs, 'utf8')); } catch (e) {
        throw fsError(`fs.readAsJSON: ${t.file} isn't valid JSON: ${e.message}`, 'EINVAL');
      }
    }),
    readAsXML: op('readAsXML', (file) => {
      const t = target(file, 'read');
      mustExist(t);
      env.trace('fs.readAsXML', { file: t.file });
      return XML.parse(nodeFs.readFileSync(t.abs));
    }),
    writeFile: op('writeFile', (file, data, options) => write(target(file, 'write'), data, options, false)),
    appendFile: op('appendFile', (file, data, options) => write(target(file, 'write'), data, options, true)),
    rename: op('rename', (from, to, options) => {
      const a = target(from, 'write');
      const b = target(to, 'write');
      mustExist(a);
      nodeFs.mkdirSync(path.dirname(b.abs), { recursive: true });
      nodeFs.renameSync(a.abs, b.abs);
      const kept = expiries.get(a.abs);
      expiries.delete(a.abs);
      if (b.ttl !== undefined || (options && (options.TTL ?? options.ttl) !== undefined)) applyTtl(b, options, true);
      else if (kept !== undefined) expiries.set(b.abs, kept);
      env.trace('fs.rename', { from: a.file, to: b.file });
    }),
    truncate: op('truncate', (file, len) => {
      const t = target(file, 'write');
      mustExist(t);
      nodeFs.truncateSync(t.abs, typeof len === 'number' ? len : 0);
      env.trace('fs.truncate', { file: t.file });
    }),
    unlink: op('unlink', (file) => {
      const t = target(file, 'write');
      mustExist(t);
      nodeFs.unlinkSync(t.abs);
      expiries.delete(t.abs);
      env.trace('fs.unlink', { file: t.file });
    }),
    /**
     * exists(file, cb). Node's legacy fs.exists calls back with just the boolean;
     * DataPower's argument order isn't documented in available sources, so a
     * callback declared with two parameters gets (error, exists), one gets (exists).
     */
    exists(file, cb) {
      const check = () => { const t = target(file, 'read'); return present(t); };
      if (typeof cb !== 'function') return env.async(check);
      if (cb.length >= 2) return env.async(check, cb, 'fs.exists callback');
      return env.async(check, (err, yes) => cb(err ? false : yes), 'fs.exists callback');
    },
    temporary() {
      throw fsError('gws-sim: fs.temporary is listed for DataPower, but its behaviour isn\'t documented in the sources gws-sim was built from, so it isn\'t emulated. Provide it with new Gateway({ modules: { fs: ... } }) if you need it.', 'ENOSYS');
    },
  };
  return fs;
}

module.exports = { createFs, DEFAULT_TTL, MAX_TTL };
