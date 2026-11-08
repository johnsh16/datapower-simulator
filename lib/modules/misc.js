'use strict';
const nodeUtil = require('util');
const nodeCrypto = require('crypto');
const vm = require('vm');

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

/** util module: Node's util plus DataPower's util.safeeval(). */
function createUtil() {
  return {
    ...nodeUtil,
    format: nodeUtil.format,
    inspect: nodeUtil.inspect,
    inherits: nodeUtil.inherits,
    /** Evaluates an expression in an empty sandbox (no require/session/globals). */
    safeeval(code) { return vm.runInNewContext(String(code), Object.create(null), { timeout: 1000 }); },
  };
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

module.exports = { createMultistep, createUtil, createCrypto, unsupported };
