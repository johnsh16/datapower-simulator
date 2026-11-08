'use strict';
const xpath = require('xpath');
const XML = require('../xml');

/**
 * transform module.
 *   transform.xpath(expression, xmldom, cb)  or  transform.xpath({ expression, xmldom, namespace }, cb)
 *   transform.xslt({ location, xmldom, parameters }, cb)
 *   transform.xquery({ location, xmldom|jsondom, parameters }, cb)
 *
 * XPath is evaluated for real. XSLT/XQuery are simulated: register a handler per
 * stylesheet location with gw.transforms['local:///x.xsl'] = (doc, params) => result
 * (result may be a Document, XML string, or JS value). Without a handler the
 * callback receives an error.
 */
function createTransform(env) {
  const toNodeList = (r) => {
    if (r == null) return [];
    if (typeof r === 'string') return [XML.parse(r)];
    if (Array.isArray(r)) return r;
    return [r];
  };

  function runHandler(kind, options, cb) {
    return env.async(async () => {
      const loc = options.location;
      const handler = env.gateway.transforms[loc] || (env.runOptions.transforms || {})[loc];
      if (!handler) {
        const e = new Error(`transform.${kind}: no simulated handler registered for '${loc}' (set gw.transforms['${loc}'])`);
        e.errorCode = '0x85800070';
        throw e;
      }
      env.trace(`transform.${kind}`, { location: loc });
      const input = options.xmldom ?? options.jsondom ?? options.input;
      return toNodeList(await handler(input, options.parameters || {}, options));
    }, cb);
  }

  return {
    xpath(exprOrOpts, nodeOrCb, maybeCb) {
      let expression, node, ns, cb;
      if (typeof exprOrOpts === 'object') {
        ({ expression, xmldom: node, namespace: ns } = exprOrOpts); cb = nodeOrCb;
      } else { expression = exprOrOpts; node = nodeOrCb; cb = maybeCb; }
      return env.async(() => {
        const select = ns ? xpath.useNamespaces(ns) : xpath.select;
        return select(expression, node);
      }, cb);
    },
    xslt(options, cb) { return runHandler('xslt', options, cb); },
    xquery(options, cb) { return runHandler('xquery', options, cb); },
  };
}

module.exports = { createTransform };
