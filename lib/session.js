'use strict';
const { Context } = require('./context');

/**
 * The GatewayScript `session` global.
 *   session.input / session.output        -> Context
 *   session.name(name)                    -> existing Context or undefined
 *   session.createContext(name)           -> new Context
 *   session.parameters                    -> GatewayScript action parameters
 *   session.reject(reason)                -> fail the transaction with a message
 */
function createSession(env) {
  const contexts = env.contexts;
  const session = {
    get input() { return contexts.get('INPUT'); },
    get output() { return contexts.get('OUTPUT'); },
    get parameters() { return env.runOptions.parameters || {}; },

    name(name) {
      if (name == null) return undefined;
      const n = String(name);
      if (['INPUT', 'OUTPUT'].includes(n.toUpperCase())) return contexts.get(n.toUpperCase());
      return contexts.get(n);
    },

    createContext(name) {
      name = String(name);
      if (['INPUT', 'OUTPUT', 'NULL'].includes(name.toUpperCase())) {
        throw new Error(`createContext: '${name}' is a reserved context name`);
      }
      if (contexts.has(name)) throw new Error(`createContext: context '${name}' already exists`);
      const ctx = new Context(env, name);
      contexts.set(name, ctx);
      return ctx;
    },

    reject(reason) {
      env.rejected = true;
      env.rejectReason = reason == null ? 'Rejected by GatewayScript' : String(reason);
      env.log('error', 'gatewayscript', `session.reject: ${env.rejectReason}`);
    },
  };
  return session;
}

module.exports = { createSession };
