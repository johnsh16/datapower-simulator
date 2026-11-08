'use strict';
const crypto = require('crypto');

/** Commonly used DataPower service variables and their simulator defaults. */
function defaultServiceVars() {
  const tid = String(Math.floor(Math.random() * 1e6) * 2 + 1); // DP request transaction ids are odd
  return {
    'var://service/protocol-method': 'POST',
    'var://service/protocol': 'http',
    'var://service/URI': '/',
    'var://service/URL-in': 'http://127.0.0.1:8080/',
    'var://service/URL-out': '',
    'var://service/routing-url': '',
    'var://service/routing-url-sslprofile': '',
    'var://service/transaction-id': tid,
    'var://service/global-transaction-id': crypto.randomUUID().replace(/-/g, '').slice(0, 24),
    'var://service/transaction-rule-name': 'gws-sim_request_rule',
    'var://service/transaction-rule-type': 'request',
    'var://service/domain-name': 'default',
    'var://service/processor-name': 'gws-sim',
    'var://service/processor-type': 'multi-protocol-gateway',
    'var://service/client-service-address': '127.0.0.1',
    'var://service/local-service-address': '127.0.0.1:8080',
    'var://service/time-started': new Date().toISOString(),
    'var://service/mpgw/skip-backside': '',
    'var://service/mpgw/backend-timeout': '180',
    'var://service/error-code': '',
    'var://service/error-subcode': '',
    'var://service/error-message': '',
    'var://service/formatted-error-message': '',
    'var://service/error-protocol-response': '',
    'var://service/error-protocol-reason-phrase': '',
    'var://service/error-ignore': '',
    'var://service/max-call-depth': '128',
    'var://service/persistent-connection-counter': '0',
    'var://service/system/ident': '<identification><product-id>gws-sim</product-id><device-name>gws-sim</device-name></identification>',
  };
}

/** 'skip-backside' -> 'skipBackside', 'URL-in' -> 'URLIn', 'URI' -> 'URI' */
function camelize(segment) {
  const [first, ...rest] = segment.split('-');
  return first + rest.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join('');
}

/**
 * Builds a var:// resolver shared by service-metadata, system-metadata and
 * multistep. Handles var://service/*, var://system/*, var://context/<ctx>/<var>
 * and var://local/<var> (mapped to the 'local' context).
 */
function createVarStore(env) {
  const service = env.serviceVars;
  const system = env.systemVars;

  const resolveCtx = (path) => {
    const m = path.match(/^var:\/\/(context|local)\/(.*)$/);
    if (!m) return null;
    if (m[1] === 'local') return { ctxName: env.runOptions.localContextName || 'INPUT', varName: m[2] };
    const idx = m[2].indexOf('/');
    return idx < 0 ? { ctxName: m[2], varName: '' } : { ctxName: m[2].slice(0, idx), varName: m[2].slice(idx + 1) };
  };

  return {
    get(path) {
      path = String(path);
      if (path.startsWith('var://service/')) return service.get(path);
      if (path.startsWith('var://system/')) return system.get(path);
      const c = resolveCtx(path);
      if (c) {
        const ctx = env.getOrCreateContext(c.ctxName, false);
        return ctx ? ctx.getVariable(c.varName) : undefined;
      }
      throw new Error(`getVar: unsupported variable '${path}'`);
    },
    set(path, value) {
      path = String(path);
      env.trace('setVar', { path, value });
      if (path.startsWith('var://service/')) return void service.set(path, value);
      if (path.startsWith('var://system/')) return void system.set(path, value);
      const c = resolveCtx(path);
      if (c) return void env.getOrCreateContext(c.ctxName, true).setVariable(c.varName, value);
      throw new Error(`setVar: unsupported variable '${path}'`);
    },
  };
}

/**
 * service-metadata module.
 *   sm.getVar('var://service/protocol-method'), sm.setVar(...), sm.list()
 *   sm.protocolMethod, sm.URI, sm.URLIn, sm.mpgw.skipBackside = true, ...
 * Property names are derived from the var:// path, so any service variable
 * you seed (via runOptions.serviceVars) is reachable both ways.
 */
function createServiceMetadata(env) {
  const vars = createVarStore(env);
  const PREFIX = 'var://service/';

  function proxyFor(prefixSegments) {
    const target = {};
    if (prefixSegments.length === 0) {
      target.getVar = (p) => vars.get(p);
      target.setVar = (p, v) => vars.set(p, v);
      target.list = () => [...env.serviceVars.entries()].map(([name, value]) => ({ name, value }));
    }
    const pathFor = (prop) => {
      // find a known var whose camelized segment matches
      for (const key of env.serviceVars.keys()) {
        const segs = key.slice(PREFIX.length).split('/');
        if (segs.length <= prefixSegments.length) continue;
        if (!prefixSegments.every((s, i) => segs[i] === s)) continue;
        if (camelize(segs[prefixSegments.length]) === prop) {
          return { full: segs.length === prefixSegments.length + 1 ? key : null, seg: segs[prefixSegments.length] };
        }
      }
      return null;
    };
    return new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'symbol' || prop in t) return t[prop];
        if (prop === 'toJSON') return () => Object.fromEntries(env.serviceVars);
        const hit = pathFor(prop);
        if (!hit) return undefined;
        if (hit.full) return env.serviceVars.get(hit.full);
        return proxyFor([...prefixSegments, hit.seg]);
      },
      set(t, prop, value) {
        const hit = pathFor(prop);
        const seg = hit ? hit.seg : prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        vars.set(PREFIX + [...prefixSegments, seg].join('/'), value);
        return true;
      },
    });
  }
  return proxyFor([]);
}

/** system-metadata module: getVar/setVar/list for var://system/* variables. */
function createSystemMetadata(env) {
  const vars = createVarStore(env);
  return {
    getVar: (p) => vars.get(p),
    setVar: (p, v) => vars.set(p, v),
    list: () => [...env.systemVars.entries()].map(([name, value]) => ({ name, value })),
  };
}

module.exports = { createServiceMetadata, createSystemMetadata, createVarStore, defaultServiceVars, camelize };
