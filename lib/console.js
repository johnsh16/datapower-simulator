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
  const write = (level) => (...args) => env.log(level, category, util.format(...args));
  const c = {
    emerg: write('emerg'),
    alert: write('alert'),
    critical: write('critic'),
    critic: write('critic'),
    error: write('error'),
    warn: write('warn'),
    notice: write('notice'),
    info: write('info'),
    log: write('info'),
    debug: write('debug'),
    trace: (...args) => env.log('debug', category, util.format(...args) + '\n' + new Error().stack.split('\n').slice(2).join('\n')),
    options(opts = {}) { return createConsole(env, opts.category || category); },
  };
  return c;
}

module.exports = { createConsole, LEVELS };
