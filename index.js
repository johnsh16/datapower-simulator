'use strict';
const { Gateway, DEFAULTS } = require('./lib/gateway');
const { UrlopenMock } = require('./lib/urlopen-mock');
const { Buffers } = require('./lib/buffers');
const XML = require('./lib/xml');

/** Convenience: one-shot run with a fresh Gateway. */
function run(script, runOptions = {}, gatewayOptions = {}) {
  return new Gateway(gatewayOptions).run(script, runOptions);
}

/** Profiling (see docs/PROFILING.md). Loaded on first use. */
module.exports = { Gateway, UrlopenMock, Buffers, XML, run, DEFAULTS };
Object.defineProperty(module.exports, 'profiler', { enumerable: true, get: () => require('./lib/profiler') });
