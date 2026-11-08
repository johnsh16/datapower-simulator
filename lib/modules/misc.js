'use strict';
const nodeUtil = require('util');
const nodeCrypto = require('crypto');

/**
 * multistep module: multistep.callRule(ruleName, input, output, cb)
 * Rules are simulated with gw.rules[ruleName] = async (inputCtx, outputCtx, { session, env }) => {}
 */
function createMultistep(env) {
  const ctxOf = (c, create) => (typeof c === 'string' ? env.getOrCreateContext(c, create) : c);
  return {
    callRule(ruleName, input, output, cb) {
      return env.async(async () => {
        const rule = env.gateway.rules[ruleName] || (env.runOptions.rules || {})[ruleName];
        if (!rule) throw Object.assign(new Error(`multistep.callRule: no simulated rule '${ruleName}' (set gw.rules['${ruleName}'])`), { errorCode: '0x85800080' });
        env.trace('multistep.callRule', { ruleName });
        await rule(ctxOf(input, false), ctxOf(output, true), { session: env.session, env });
      }, cb);
    },
  };
}

/**
 * util module, as documented for DataPower (GatewayScript cheat sheet): format,
 * inherits, inspect, isArray, isDate, isError, isRegExp, and the XML helpers
 * isNode, isNodeList, isNamedNodeMap, plus safeTypeOf (documented, not emulated).
 * Other Node util functions still work but log a warning, because a script that
 * relies on them may fail on the appliance.
 */
function createUtil(env) {
  const isNode = (o) => o != null && typeof o === 'object' && typeof o.nodeType === 'number';
  const documented = {
    format: nodeUtil.format,
    inspect: nodeUtil.inspect,
    inherits: nodeUtil.inherits,
    isArray: (o) => Array.isArray(o),
    isDate: (o) => o instanceof Date || Object.prototype.toString.call(o) === '[object Date]',
    isError: (o) => o instanceof Error || Object.prototype.toString.call(o) === '[object Error]',
    isRegExp: (o) => o instanceof RegExp || Object.prototype.toString.call(o) === '[object RegExp]',
    isNode,
    isNodeList: (o) => o != null && typeof o === 'object' && typeof o.length === 'number' && typeof o.item === 'function'
      && !(typeof o.getNamedItem === 'function'),
    isNamedNodeMap: (o) => o != null && typeof o === 'object' && typeof o.getNamedItem === 'function',
    safeTypeOf() {
      throw new Error("gws-sim: util.safeTypeOf is listed for DataPower, but its behaviour isn't documented in the sources gws-sim was built from, so it isn't emulated.");
    },
  };
  return warnBeyondDocs(env, 'util', documented, nodeUtil);
}

/**
 * Expose `documented` as-is; fall back to `fallback` for anything else, logging a
 * warning once per name and run, so tests still run but the gap is visible.
 */
function warnBeyondDocs(env, moduleName, documented, fallback) {
  const warned = new Set();
  return new Proxy(documented, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop in t) return t[prop];
      if (fallback && prop in fallback) {
        if (env && !warned.has(prop)) {
          warned.add(prop);
          env.log('warn', 'gws-sim', `${moduleName}.${prop} isn't in DataPower's documentation for the ${moduleName} module; it works here but may not on the appliance`);
        }
        return fallback[prop];
      }
      return undefined;
    },
  });
}

/**
 * crypto module: Node's crypto, with DataPower-style key references.
 * Keys/certs are looked up by name from gw.keys: 'name:myKey' or just 'myKey'.
 */
function createCrypto(env) {
  const key = (ref) => {
    if (typeof ref !== 'string') return ref;
    const name = ref.replace(/^name:/, '');
    const k = env.gateway.keys[name];
    if (k !== undefined) return k;
    if (/^name:/.test(ref)) throw new Error(`crypto: key/cert object '${name}' not found (set gw.keys['${name}'])`);
    return ref;
  };
  const wrapSign = (s) => { const orig = s.sign.bind(s); s.sign = (k, fmt) => orig(key(k), fmt); return s; };
  const wrapVerify = (v) => { const orig = v.verify.bind(v); v.verify = (k, sig, fmt) => orig(key(k), sig, fmt); return v; };
  return {
    ...nodeCrypto,
    createHash: nodeCrypto.createHash,
    createHmac: (alg, k, o) => nodeCrypto.createHmac(alg, key(k), o),
    createSign: (alg, o) => wrapSign(nodeCrypto.createSign(alg, o)),
    createVerify: (alg, o) => wrapVerify(nodeCrypto.createVerify(alg, o)),
    createCipheriv: (alg, k, iv, o) => nodeCrypto.createCipheriv(alg, key(k), iv, o),
    createDecipheriv: (alg, k, iv, o) => nodeCrypto.createDecipheriv(alg, key(k), iv, o),
    randomBytes: nodeCrypto.randomBytes,
    getHashes: nodeCrypto.getHashes,
    getCiphers: nodeCrypto.getCiphers,
  };
}

/** Placeholder for modules whose behaviour depends on appliance objects. */
function unsupported(name) {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return () => {
        throw new Error(`gws-sim: module '${name}' (${String(prop)}) is not emulated. Supply your own simulation with new Gateway({ modules: { '${name}': {...} } }).`);
      };
    },
  });
}

module.exports = { createMultistep, createUtil, createCrypto, unsupported, warnBeyondDocs };
