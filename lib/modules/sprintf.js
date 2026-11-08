'use strict';
/**
 * The DataPower sprintf module: require('sprintf').sprintf / .vsprintf
 * Implements the syntax in IBM's GatewayScript playground docs (sprintf.markdown):
 *   %[argnum$][+]['padchar|0][-][width][.precision]type
 *   types: % b c d i e E u f o O s S x X j
 */
const util = require('util');

const RE = /%(?:(\d+)\$)?(\+)?(0|'[^$])?(-)?(\d+)?(?:\.(\d+))?([%bcdieEufoOsSxXj])/g;

function vsprintf(format, args) {
  if (typeof format !== 'string') throw new TypeError('sprintf: format must be a string');
  args = args || [];
  let next = 0;
  return format.replace(RE, (whole, argnum, plus, padSpec, left, width, precision, type) => {
    if (type === '%') return '%';
    const idx = argnum ? Number(argnum) - 1 : next++;
    if (idx >= args.length) throw new RangeError(`sprintf: too few arguments for ${whole}`);
    let arg = args[idx];
    const prec = precision === undefined ? undefined : Number(precision);
    let s;
    let numeric = false;
    switch (type) {
      case 'b': s = (parseInt(arg, 10) >>> 0).toString(2); numeric = true; break;
      case 'c': s = String.fromCharCode(parseInt(arg, 10)); break;
      case 'd': case 'i': s = String(parseInt(arg, 10)); numeric = true; break;
      case 'e': s = prec !== undefined ? Number(arg).toExponential(prec) : Number(arg).toExponential(); numeric = true; break;
      case 'E': s = (prec !== undefined ? Number(arg).toExponential(prec) : Number(arg).toExponential()).toUpperCase(); numeric = true; break;
      case 'u': s = String(parseInt(arg, 10) >>> 0); numeric = true; break;
      case 'f': s = prec !== undefined ? parseFloat(arg).toFixed(prec) : String(parseFloat(arg)); numeric = true; break;
      case 'o': s = (parseInt(arg, 10) >>> 0).toString(8); numeric = true; break;
      case 'O': s = util.inspect(arg); break;
      case 's': s = String(arg); if (prec !== undefined) s = s.slice(0, prec); break;
      case 'S': s = String(arg).toUpperCase(); if (prec !== undefined) s = s.slice(0, prec); break;
      case 'x': s = (parseInt(arg, 10) >>> 0).toString(16); numeric = true; break;
      case 'X': s = (parseInt(arg, 10) >>> 0).toString(16).toUpperCase(); numeric = true; break;
      case 'j': s = JSON.stringify(arg, null, prec ? prec : 0); break;
    }
    let sign = '';
    if (numeric && ['d', 'i', 'e', 'E', 'f'].includes(type)) {
      if (s.startsWith('-')) { sign = '-'; s = s.slice(1); } else if (plus) sign = '+';
    }
    const padChar = padSpec ? (padSpec === '0' ? '0' : padSpec.charAt(1)) : ' ';
    const w = width ? Number(width) : 0;
    const len = sign.length + s.length;
    if (len >= w) return sign + s;
    const pad = padChar.repeat(w - len);
    if (left) return sign + s + (padChar === '0' ? ' '.repeat(w - len) : pad);
    return padChar === '0' ? sign + pad + s : pad + sign + s;
  });
}

function sprintf(format, ...args) {
  return vsprintf(format, args);
}

module.exports = { sprintf, vsprintf };
