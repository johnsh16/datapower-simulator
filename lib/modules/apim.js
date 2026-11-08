'use strict';
/**
 * apim module (API Connect GatewayScript policies on the API Gateway / v5c).
 * Variables are a dotted-path tree seeded from runOptions.apim:
 *   apim.getvariable('request.headers.content-type'), apim.setvariable('message.body', x)
 */
function createApim(env) {
  const root = env.apimVars;
  const segs = (p) => String(p).split('.').filter(Boolean);

  const get = (path) => {
    let cur = root;
    for (const s of segs(path)) {
      if (cur == null || typeof cur !== 'object') return undefined;
      const key = Object.keys(cur).find((k) => k === s) ?? Object.keys(cur).find((k) => k.toLowerCase() === s.toLowerCase());
      cur = key === undefined ? undefined : cur[key];
    }
    return cur;
  };
  const set = (path, value, action = 'set') => {
    const parts = segs(path);
    let cur = root;
    for (const s of parts.slice(0, -1)) { if (cur[s] == null || typeof cur[s] !== 'object') cur[s] = {}; cur = cur[s]; }
    const last = parts[parts.length - 1];
    if (action === 'clear') delete cur[last];
    else if (action === 'add' && cur[last] !== undefined) cur[last] = [].concat(cur[last], value);
    else cur[last] = value;
    env.trace('apim.setvariable', { path, action });
  };

  const readInput = (kind) => (cb) => env.session.input[kind](cb);

  return {
    getvariable: get,
    setvariable: set,
    getContext: get,
    setContext: set,
    output(contentType) {
      env.headerMetadata.response.set('Content-Type', contentType);
      set('message.headers.content-type', contentType);
    },
    error(name, httpCode, httpReasonPhrase, message) {
      env.apimError = { name, httpCode, httpReasonPhrase, message };
      if (httpCode) {
        env.headerMetadata.response.statusCode = httpCode;
        if (httpReasonPhrase) env.headerMetadata.response.reasonPhrase = httpReasonPhrase;
      }
      env.session.reject(message || name);
    },
    readInputAsBuffer: readInput('readAsBuffer'),
    readInputAsBuffers: readInput('readAsBuffers'),
    readInputAsJSON: readInput('readAsJSON'),
    readInputAsXML: readInput('readAsXML'),
  };
}

module.exports = { createApim };
