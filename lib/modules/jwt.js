'use strict';
const crypto = require('crypto');

/**
 * Approximation of the DataPower jwt module (JWS only; JWE is not emulated).
 *
 *   var enc = new jwt.JWTEncoder(claims);
 *   enc.setProtectedHeader('alg', 'HS256').setProtectedHeader('typ', 'JWT')
 *      .addOperation('sign', 'name:myHmacKey')
 *      .encode(function (err, token) {});
 *
 *   var dec = new jwt.JWTDecoder(token);
 *   dec.addOperation('verify', 'name:myCert').addOperation('validate', { aud: 'x' })
 *      .decode(function (err, claims) {});
 *
 * Keys are resolved from gw.keys by name (HMAC secret string/Buffer or PEM).
 */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const HASH = { 256: 'sha256', 384: 'sha384', 512: 'sha512' };

function createJwt(env) {
  const key = (ref) => {
    if (typeof ref !== 'string') return ref;
    const name = ref.replace(/^name:/, '');
    if (env.gateway.keys[name] === undefined) throw new Error(`jwt: key object '${name}' not found (set gw.keys['${name}'])`);
    return env.gateway.keys[name];
  };

  function sign(alg, input, k) {
    const bits = alg.slice(2);
    if (alg.startsWith('HS')) return crypto.createHmac(HASH[bits], k).update(input).digest();
    if (alg.startsWith('RS')) return crypto.createSign('RSA-' + HASH[bits].toUpperCase()).update(input).sign(k);
    if (alg.startsWith('PS')) return crypto.sign(HASH[bits], Buffer.from(input), { key: k, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: Number(bits) / 8 });
    if (alg.startsWith('ES')) return crypto.sign(HASH[bits], Buffer.from(input), { key: k, dsaEncoding: 'ieee-p1363' });
    throw new Error(`jwt: unsupported alg ${alg}`);
  }
  function verify(alg, input, sig, k) {
    const bits = alg.slice(2);
    if (alg.startsWith('HS')) { const exp = sign(alg, input, k); return sig.length === exp.length && crypto.timingSafeEqual(exp, sig); }
    if (alg.startsWith('RS')) return crypto.createVerify('RSA-' + HASH[bits].toUpperCase()).update(input).verify(k, sig);
    if (alg.startsWith('PS')) return crypto.verify(HASH[bits], Buffer.from(input), { key: k, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: Number(bits) / 8 }, sig);
    if (alg.startsWith('ES')) return crypto.verify(HASH[bits], Buffer.from(input), { key: k, dsaEncoding: 'ieee-p1363' }, sig);
    throw new Error(`jwt: unsupported alg ${alg}`);
  }

  class JWTEncoder {
    constructor(claims) { this.claims = claims; this.header = { typ: 'JWT' }; this.ops = []; }
    setProtectedHeader(k, v) { this.header[k] = v; return this; }
    addOperation(op, arg) { this.ops.push([op, arg]); return this; }
    encode(cb) {
      return env.async(() => {
        const s = this.ops.find(([op]) => op === 'sign');
        if (!s) throw new Error('jwt: JWTEncoder requires a sign operation');
        const header = { ...this.header };
        if (s[1] && typeof s[1] === 'object' && s[1].alg) header.alg = s[1].alg;
        if (!header.alg) throw new Error('jwt: alg protected header is required');
        const ref = s[1] && typeof s[1] === 'object' && !Buffer.isBuffer(s[1]) ? s[1].key : s[1];
        const input = b64u(JSON.stringify(header)) + '.' + b64u(typeof this.claims === 'string' ? this.claims : JSON.stringify(this.claims));
        return input + '.' + b64u(sign(header.alg, input, key(ref)));
      }, cb);
    }
  }

  class JWTDecoder {
    constructor(token) { this.token = String(token); this.ops = []; }
    addOperation(op, arg) { this.ops.push([op, arg]); return this; }
    decode(cb) {
      return env.async(() => {
        const parts = this.token.split('.');
        if (parts.length !== 3) throw Object.assign(new Error('jwt: malformed JWS compact serialization'), { errorCode: '0x8580009a' });
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        for (const [op, arg] of this.ops) {
          if (op === 'verify') {
            const ref = arg && typeof arg === 'object' && !Buffer.isBuffer(arg) ? arg.key : arg;
            if (!verify(header.alg, parts[0] + '.' + parts[1], Buffer.from(parts[2], 'base64url'), key(ref))) {
              throw Object.assign(new Error('jwt: signature verification failed'), { errorCode: '0x8580009b' });
            }
          } else if (op === 'validate') {
            const now = Math.floor(Date.now() / 1000);
            const skew = (arg && arg.skew) || 0;
            if (claims.exp !== undefined && now > claims.exp + skew) throw new Error('jwt: token expired');
            if (claims.nbf !== undefined && now + skew < claims.nbf) throw new Error('jwt: token not yet valid');
            if (arg && arg.aud && ![].concat(claims.aud).includes(arg.aud)) throw new Error('jwt: audience mismatch');
            if (arg && arg.iss && claims.iss !== arg.iss) throw new Error('jwt: issuer mismatch');
          }
        }
        return claims;
      }, cb);
    }
  }

  return { JWTEncoder, JWTDecoder };
}

module.exports = { createJwt };
