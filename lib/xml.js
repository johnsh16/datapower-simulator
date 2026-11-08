'use strict';
/** The GatewayScript `XML` global: XML.parse(string|Buffer) -> Document, XML.stringify(node) -> string. */
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const xpath = require('xpath');

function parse(input, options) {
  const text = Buffer.isBuffer(input) ? input.toString() :
    (input && typeof input.toBuffer === 'function') ? input.toBuffer().toString() : String(input);
  const errors = [];
  const doc = new DOMParser({
    onError: (level, msg) => { if (level !== 'warning') errors.push(msg); },
  }).parseFromString(text, 'text/xml');
  if (errors.length || !doc || !doc.documentElement) {
    const err = new Error('XML parse error: ' + (errors[0] || 'no root element'));
    err.errorCode = '0x85800001';
    throw err;
  }
  return doc;
}

function stringify(node, options) {
  if (options && options.omitXmlDeclaration === false && node.nodeType === 9) {
    return '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(node);
  }
  return new XMLSerializer().serializeToString(node);
}

/** Convenience (not in DataPower): evaluate XPath on a node. */
function query(node, expr, namespaces) {
  const select = namespaces ? xpath.useNamespaces(namespaces) : xpath.select;
  return select(expr, node);
}

module.exports = { parse, stringify, query, DOMParser, XMLSerializer };
