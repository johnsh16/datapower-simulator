'use strict';
const util = require('util');

/** DataPower log levels, most to least severe. */
const LEVELS = ['emerg', 'alert', 'critic', 'error', 'warn', 'notice', 'info', 'debug'];

/**
 * The GatewayScript `console` global. Messages are captured in the run
 * result (result.logs) and optionally echoed to the real console.
 *   console.debug/info/notice/warn/error/critical/alert/emerg/log/trace
 *   console.options({ category: 'mycat' }).info('x')
 */
function createConsole(env, category = 'gatewayscript-user') {
  const write = (level, method) => (...args) => env.log(level, category, util.format(...args), method);
  const c = {
    emerg: write('emerg', 'emerg'),
    alert: write('alert', 'alert'),
    critical: write('critic', 'critical'),
    critic: write('critic', 'critic'),
    error: write('error', 'error'),
    warn: write('warn', 'warn'),
    notice: write('notice', 'notice'),
    info: write('info', 'info'),
    log: write('info', 'log'),
    debug: write('debug', 'debug'),
    trace: (...args) => env.log('debug', category, util.format(...args) + '\n' + new Error().stack.split('\n').slice(2).join('\n'), 'trace'),
    options(opts = {}) { return createConsole(env, opts.category || category); },
  };
  return c;
}

module.exports = { createConsole, LEVELS };
