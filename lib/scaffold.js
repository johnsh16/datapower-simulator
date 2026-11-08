'use strict';
/**
 * Test generator behind `gws-new-test`.
 *
 *   1. analyze()     reads the script's source for the inputs it uses
 *                    (body format, headers, service variables, contexts, ...)
 *   2. discover()    runs the script with placeholder backends to find the
 *                    urlopen calls it makes
 *   3. characterize() runs each scenario exactly as the generated test will
 *   4. generate()    writes a test file whose assertions match what was observed
 *
 * The result is a test file that passes immediately (unless the script crashes
 * in some scenario, which is flagged) and documents the script's behaviour.
 */
const fs = require('fs');
const path = require('path');
const { Gateway } = require('./gateway');
const { defaultServiceVars, camelize } = require('./modules/service-metadata');

const PKG_ROOT = path.resolve(__dirname, '..');
// DataPower modules the simulator can't run for real (see docs/MODULES.md)
const UNSUPPORTED = ['jose', 'jwk', 'apigw', 'ratelimit', 'json-xml-converter', 'mgmt', 'policy-utility'];
const FILE_SCHEME = /^(local|store|temporary):/;
const PLACEHOLDER = { statusCode: 200, body: {} };
const FAILURE = { statusCode: 500, body: { error: 'simulated backend failure' } };

// ---------------------------------------------------------------------------
// 1. static analysis
// ---------------------------------------------------------------------------
function uniq(a) { return [...new Set(a)]; }
function allMatches(src, re, group) { return [...src.matchAll(re)].map((m) => m[group]); }

function analyze(source) {
  const info = {};

  const kind = source.match(/session\.input\.readAs(JSON|XML|Buffers?)\b|readInputAs(JSON|XML|Buffers?)\b/);
  info.inputKind = kind ? (kind[1] || kind[2]).replace(/s$/, '').toLowerCase() : null; // json | xml | buffer | null

  info.headers = uniq(allMatches(source, /\.(?:current|original)\.get\(\s*(['"])([^'"]+)\1/g, 2));

  // service variables: sm.getVar('var://service/x') and sm.camelCase properties
  const camelToPath = {};
  for (const key of Object.keys(defaultServiceVars())) {
    camelToPath[key.slice('var://service/'.length).split('/').map(camelize).join('.')] = key;
  }
  const vars = allMatches(source, /getVar\(\s*(['"])(var:\/\/service\/[^'"]+)\1/g, 2);
  for (const name of allMatches(source, /(?:var|let|const)\s+(\w+)\s*=\s*require\(\s*['"]service-metadata['"]\s*\)/g, 1)) {
    const re = new RegExp(`\\b${name}\\.([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)(?!\\s*=[^=])`, 'g');
    for (const chain of allMatches(source, re, 1)) if (camelToPath[chain]) vars.push(camelToPath[chain]);
  }
  info.serviceVars = uniq(vars).filter((v) => !/\/(error-|formatted-error|transaction-id|global-transaction-id|time-)/.test(v));

  const created = new Set(allMatches(source, /createContext\(\s*(['"])([^'"]+)\1/g, 2));
  info.contexts = uniq(allMatches(source, /session\.name\(\s*(['"])([^'"]+)\1/g, 2))
    .filter((n) => !created.has(n) && !['INPUT', 'OUTPUT'].includes(n.toUpperCase()));

  info.parameters = uniq([
    ...allMatches(source, /session\.parameters\.(\w+)/g, 1),
    ...allMatches(source, /session\.parameters\[\s*(['"])(\w+)\1/g, 2),
  ]);

  info.unsupportedModules = uniq(allMatches(source, /require\(\s*['"](\w+)['"]\s*\)/g, 1)).filter((m) => UNSUPPORTED.includes(m));
  info.transforms = uniq(allMatches(source, /location\s*:\s*(['"])([^'"]+\.(?:xslt?|xq|xquery))\1/g, 2));
  info.rules = uniq(allMatches(source, /callRule\(\s*(['"])([^'"]+)\1/g, 2));
  info.usesApim = /require\(\s*['"]apim['"]\s*\)/.test(source);
  return info;
}

/** A starting request built from what the script reads. */
function defaultRequest(info, input) {
  const req = {};
  if (input !== undefined) req.input = input;
  else if (info.inputKind === 'json') req.input = {};
  else if (info.inputKind === 'xml') req.input = '<request/>';
  else if (info.inputKind === 'buffer') req.input = 'sample request body';

  if (info.headers.length) {
    req.headers = {};
    for (const h of info.headers) req.headers[h] = /^content-type$/i.test(h)
      ? (info.inputKind === 'xml' ? 'application/xml' : 'application/json')
      : 'test-' + h.toLowerCase();
  }
  if (info.serviceVars.length) {
    const d = defaultServiceVars();
    req.serviceVars = {};
    for (const v of info.serviceVars) req.serviceVars[v] = d[v] !== undefined ? d[v] : '';
  }
  if (info.contexts.length) {
    req.contexts = {};
    for (const c of info.contexts) req.contexts[c] = { body: {}, variables: {} };
  }
  if (info.parameters.length) {
    req.parameters = {};
    for (const p of info.parameters) req.parameters[p] = 'test-' + p;
  }
  return req;
}

// ---------------------------------------------------------------------------
// 2 + 3. running scenarios. applySetup() MUST mirror newGateway() in the
// generated file, so what we observe here is what the test will see.
// ---------------------------------------------------------------------------
function applySetup(spec, overrides, discovering) {
  const gw = new Gateway({
    localDir: spec.localDir,
    timeoutMs: 10000,
    modules: Object.fromEntries(spec.info.unsupportedModules.map((m) => [m, {}])),
  });
  for (const loc of spec.info.transforms) gw.transforms[loc] = (doc) => doc;
  for (const name of spec.info.rules) {
    gw.rules[name] = async (input, output) => { if (input) output.write(await input.readAsBuffer()); };
  }
  for (const o of overrides || []) {
    const r = gw.urlopen.when({ method: o.method, target: o.target });
    if (o.timeout) r.timeout(); else r.reply(o.response);
  }
  for (const b of spec.backends) gw.urlopen.when({ method: b.method, target: b.target }).reply(b.response);
  if (discovering) gw.urlopen.onUnmatched = () => PLACEHOLDER;
  return gw;
}

function snapshot(res) {
  const body = res.output.text;
  let json;
  try { json = body ? JSON.parse(body) : undefined; } catch { json = undefined; }
  return {
    statusCode: res.statusCode,
    reasonPhrase: res.reasonPhrase,
    body,
    json,
    rejected: res.rejected,
    rejectReason: res.rejectReason,
    error: res.error ? String(res.error.message || res.error).split('\n')[0] : null,
    calls: res.urlopenCalls.map((c) => `${c.method} ${c.target}`),
  };
}

async function runScenario(spec, request, overrides, discovering) {
  return applySetup(spec, overrides, discovering).run(spec.scriptUrl, request);
}

/**
 * Find the backend calls the script makes. Each round re-runs the script and
 * takes only the FIRST call not seen before: anything after it may have been
 * shaped by a placeholder answer (e.g. a URL built from a field the placeholder
 * lacks), so it is only trusted once the earlier call has its real sample.
 * Finally, backends the script no longer calls with the final samples are dropped.
 */
async function discover(spec, onNewCall, maxCalls = 20) {
  for (let round = 0; round < maxCalls; round++) {
    const res = await runScenario(spec, spec.request, [], true);
    const known = new Set(spec.backends.map((b) => `${b.method} ${b.target}`));
    const next = res.urlopenCalls.find((c) => !FILE_SCHEME.test(c.target) && !known.has(`${c.method} ${c.target}`));
    if (!next) break;
    const b = { method: next.method, target: next.target, response: { ...PLACEHOLDER }, placeholder: true };
    if (onNewCall) {
      const sample = await onNewCall(b);
      if (sample !== undefined) { b.response = { statusCode: 200, body: sample }; b.placeholder = false; }
    }
    spec.backends.push(b);
  }
  const final = await runScenario(spec, spec.request, [], true);
  const used = new Set(final.urlopenCalls.map((c) => `${c.method} ${c.target}`));
  spec.backends = spec.backends.filter((b) => used.has(`${b.method} ${b.target}`));
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function badInputFor(kind) {
  if (kind === 'json') return { label: 'is not valid JSON', value: 'this is not JSON' };
  if (kind === 'xml') return { label: 'is not valid XML', value: 'this is not XML' };
  return null;
}

/** Run every scenario the generated file will contain; run twice to spot unstable output. */
async function characterize(spec) {
  const scenarios = [];
  const add = async (s) => {
    const a = snapshot(await runScenario(spec, s.request, s.overrides, false));
    const b = snapshot(await runScenario(spec, s.request, s.overrides, false));
    s.observed = a;
    s.stableBody = a.body === b.body;
    // fields that matched across both runs (for objects whose body varies)
    if (!s.stableBody && isPlainObject(a.json) && isPlainObject(b.json)) {
      s.stableFields = Object.keys(a.json).filter((k) => JSON.stringify(a.json[k]) === JSON.stringify(b.json[k]));
      s.volatileFields = Object.keys(a.json).filter((k) => !s.stableFields.includes(k));
    }
    scenarios.push(s);
  };

  await add({ kind: 'happy', request: spec.request, overrides: [] });
  for (const b of spec.backends.slice(0, 5)) {
    await add({ kind: 'failure', backend: b, request: spec.request,
      overrides: [{ method: b.method, target: b.target, response: FAILURE }] });
    await add({ kind: 'timeout', backend: b, request: spec.request,
      overrides: [{ method: b.method, target: b.target, timeout: true }] });
  }
  const bad = badInputFor(spec.info.inputKind);
  if (bad && spec.request.input !== undefined) {
    await add({ kind: 'badInput', bad, request: { ...spec.request, input: bad.value }, overrides: [] });
  }
  return scenarios;
}

// ---------------------------------------------------------------------------
// 4. code generation
// ---------------------------------------------------------------------------
/** JS string literal in single quotes. */
function q(str) {
  return "'" + String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
}
/** Readable JS literal: unquoted identifier keys, single quotes, short values inline. */
function lit(v, indent = 0) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return q(v);
  const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k));
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    const items = v.map((x) => lit(x, indent + 2));
    const one = '[' + items.join(', ') + ']';
    return one.length <= 70 && !one.includes('\n') ? one : '[\n' + items.map((x) => inner + x).join(',\n') + ',\n' + pad + ']';
  }
  const entries = Object.entries(v);
  if (!entries.length) return '{}';
  const items = entries.map(([k, x]) => key(k) + ': ' + lit(x, indent + 2));
  const one = '{ ' + items.join(', ') + ' }';
  return one.length <= 70 && !one.includes('\n') ? one : '{\n' + items.map((x) => inner + x).join(',\n') + ',\n' + pad + '}';
}
function relSegments(fromDir, to) {
  const rel = path.relative(fromDir, to);
  return rel ? rel.split(path.sep) : [];
}

function libraryRef(outFile) {
  const rel = path.relative(PKG_ROOT, path.resolve(outFile));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'gws-sim';
  const r = path.relative(path.dirname(path.resolve(outFile)), PKG_ROOT).split(path.sep).join('/');
  return r ? r : '.';
}

function outcome(o) {
  if (o.error) return 'does not crash';
  if (o.rejected) return 'rejects the request';
  return `responds ${o.statusCode}`;
}
function scenarioTitle(s) {
  const o = outcome(s.observed);
  switch (s.kind) {
    case 'happy': return s.observed.error ? 'handles a normal request without crashing' : `${o} to a normal request`;
    case 'failure': return `${o} when ${s.backend.method} ${s.backend.target} fails with 500`;
    case 'timeout': return `${o} when ${s.backend.method} ${s.backend.target} times out`;
    case 'badInput': return `${o} when the request body ${s.bad.label}`;
  }
}

/** A backend failed but the client was told everything is fine: worth a human look. */
function masksFailure(s) {
  const o = s.observed;
  return (s.kind === 'failure' || s.kind === 'timeout') && !o.error && !o.rejected && o.statusCode < 300;
}

function assertionsFor(s, ind) {
  const o = s.observed;
  const p = ' '.repeat(ind);
  const out = [];
  if (o.error) {
    out.push(`${p}// WARNING: when this file was generated, the script crashed here:`);
    out.push(`${p}//   ${o.error}`);
    out.push(`${p}// This test fails until the script handles this case. If you change the`);
    out.push(`${p}// script, assert the status code and body it should return instead.`);
    out.push(`${p}assert.equal(res.error, null, res.error && res.error.stack);`);
    return out;
  }
  if (masksFailure(s)) {
    out.push(`${p}// NOTE: the backend failed, but the script still answered ${o.statusCode}.`);
    out.push(`${p}// Is that what callers should get? If not, fix the script and update this test.`);
  }
  out.push(`${p}assert.equal(res.error, null, res.error && res.error.stack);`);
  if (o.rejected) {
    out.push(`${p}assert.equal(res.rejected, true);`);
    out.push(`${p}assert.equal(res.rejectReason, ${q(o.rejectReason)});`);
    return out;
  }
  out.push(`${p}assert.equal(res.statusCode, ${o.statusCode});`);
  if (!s.stableBody && s.stableFields && s.stableFields.length) {
    out.push(`${p}const body = res.output.json();`);
    for (const k of s.stableFields) {
      const access = /^[A-Za-z_$][\w$]*$/.test(k) ? `body.${k}` : `body[${q(k)}]`;
      out.push(`${p}assert.deepEqual(${access}, ${lit(o.json[k], ind)});`);
    }
    out.push(`${p}// not pinned because they changed between runs: ${s.volatileFields.join(', ')}`);
  } else if (!s.stableBody) {
    out.push(`${p}// The response body changed between runs (timestamps or IDs?), so it isn't`);
    out.push(`${p}// pinned here. TODO: assert the parts that matter, e.g.`);
    out.push(`${p}// assert.equal(res.output.json().someField, 'expected');`);
  } else if (o.body === '') {
    out.push(`${p}assert.equal(res.output.text, '');`);
  } else if (o.json !== undefined) {
    out.push(`${p}assert.deepEqual(res.output.json(), ${lit(o.json, ind)});`);
  } else if (o.body.length <= 400) {
    out.push(`${p}assert.equal(res.output.text, ${q(o.body)});`);
  } else {
    out.push(`${p}// TODO: the response body is long; assert the parts that matter.`);
  }
  return out;
}

function generate(spec, scenarios, outFile, meta = {}) {
  const outDir = path.dirname(path.resolve(outFile));
  const scriptName = path.basename(spec.scriptPath);
  const localSegs = relSegments(outDir, spec.localDir).map(q);
  const anyPlaceholder = spec.backends.some((b) => b.placeholder);
  const L = [];

  L.push(`// Tests for ${scriptName}`);
  L.push(`// Generated by gws-new-test${meta.date ? ' on ' + meta.date : ''} from what the script does today.`);
  L.push('//');
  L.push(`//   Run them:  node --test ${meta.runPath || path.relative(process.cwd(), path.resolve(outFile)).split(path.sep).join('/')}`);
  L.push('//');
  L.push('// Each test records how the script behaves right now, so if a later change');
  L.push('// alters that behaviour, a test fails and shows you exactly what changed.');
  L.push('// Search for TODO to find the placeholders worth replacing with real data.');
  L.push('');
  L.push(`const test = require('node:test');`);
  L.push(`const assert = require('node:assert/strict');`);
  L.push(`const path = require('path');`);
  L.push(`const { Gateway } = require(${q(libraryRef(outFile))});`);
  L.push('');
  L.push(`// local:/// points at this folder, so the script is ${spec.scriptUrl}`);
  L.push(`const LOCAL_DIR = path.join(__dirname${localSegs.length ? ', ' + localSegs.join(', ') : ''});`);
  L.push(`const SCRIPT = ${q(spec.scriptUrl)};`);
  L.push('');

  // request
  L.push('// The request every test sends. TODO: make it look like a real request.');
  const reqLines = [];
  if (spec.request.input !== undefined) reqLines.push(`  input: ${lit(spec.request.input, 2)},`);
  if (spec.request.headers) reqLines.push(`  // headers the script reads\n  headers: ${lit(spec.request.headers, 2)},`);
  if (spec.request.serviceVars) reqLines.push(`  // service variables the script reads (simulator defaults; set real values)\n  serviceVars: ${lit(spec.request.serviceVars, 2)},`);
  if (spec.request.contexts) reqLines.push(`  // contexts the script expects earlier actions to have created\n  contexts: ${lit(spec.request.contexts, 2)},`);
  if (spec.request.parameters) reqLines.push(`  // session.parameters the script reads\n  parameters: ${lit(spec.request.parameters, 2)},`);
  L.push(`const REQUEST = {${reqLines.length ? '\n' + reqLines.join('\n') + '\n' : ''}};`);
  L.push('');

  // backends
  if (spec.backends.length) {
    L.push('// Fake backends: one for each call the script made while this file was generated.');
    if (anyPlaceholder) L.push('// TODO: entries marked "placeholder" answer with an empty JSON object; paste in a real response.');
    L.push('const BACKENDS = [');
    for (const b of spec.backends) {
      L.push('  {');
      L.push(`    method: ${q(b.method)},`);
      L.push(`    target: ${q(b.target)},`);
      L.push(`    response: ${lit(b.response, 4)},${b.placeholder ? ' // placeholder' : ''}`);
      L.push('  },');
    }
    L.push('];');
  } else {
    L.push('// The script made no backend (urlopen) calls with this request.');
    L.push('const BACKENDS = [];');
  }
  L.push('');

  // newGateway
  L.push('// A fresh simulated gateway per test, so mocks never leak between tests.');
  L.push('// `overrides` replace individual backends; they are registered first, so they win.');
  L.push('function newGateway(overrides = []) {');
  if (spec.info.unsupportedModules.length) {
    L.push('  const gw = new Gateway({');
    L.push('    localDir: LOCAL_DIR,');
    L.push('    // TODO: these modules need appliance objects; fake the functions your script calls');
    L.push(`    modules: { ${spec.info.unsupportedModules.map((m) => `${m}: {}`).join(', ')} },`);
    L.push('  });');
  } else {
    L.push('  const gw = new Gateway({ localDir: LOCAL_DIR });');
  }
  for (const loc of spec.info.transforms) {
    L.push(`  // TODO: stylesheets aren't executed; return what ${loc} would produce`);
    L.push(`  gw.transforms[${q(loc)}] = (doc) => doc;`);
  }
  for (const r of spec.info.rules) {
    L.push(`  // TODO: simulate what the '${r}' rule does (this copies input to output)`);
    L.push(`  gw.rules[${q(r)}] = async (input, output) => { if (input) output.write(await input.readAsBuffer()); };`);
  }
  L.push('  for (const o of overrides) {');
  L.push('    const route = gw.urlopen.when({ method: o.method, target: o.target });');
  L.push('    if (o.timeout) route.timeout(); else route.reply(o.response);');
  L.push('  }');
  L.push('  for (const b of BACKENDS) gw.urlopen.when({ method: b.method, target: b.target }).reply(b.response);');
  L.push('  return gw;');
  L.push('}');
  if (spec.backends.length) {
    L.push('');
    L.push(`const FAILURE = ${lit(FAILURE, 0)};`);
  }

  // tests
  for (const s of scenarios) {
    L.push('');
    L.push(`test(${q(scenarioTitle(s))}, async () => {`);
    const idx = s.backend ? spec.backends.indexOf(s.backend) : -1;
    if (s.kind === 'happy') L.push('  const res = await newGateway().run(SCRIPT, REQUEST);');
    else if (s.kind === 'failure') L.push(`  const res = await newGateway([{ ...BACKENDS[${idx}], response: FAILURE }]).run(SCRIPT, REQUEST);`);
    else if (s.kind === 'timeout') L.push(`  const res = await newGateway([{ ...BACKENDS[${idx}], timeout: true }]).run(SCRIPT, REQUEST);`);
    else if (s.kind === 'badInput') L.push(`  const res = await newGateway().run(SCRIPT, { ...REQUEST, input: ${q(s.bad.value)} });`);
    L.push('');
    L.push(...assertionsFor(s, 2));
    if (s.kind === 'happy' && !s.observed.error) {
      L.push('  // the backend calls it made, in order');
      L.push(`  assert.deepEqual(res.urlopenCalls.map((c) => c.method + ' ' + c.target), ${lit(s.observed.calls, 2)});`);
    }
    L.push('});');
  }
  L.push('');
  return L.join('\n');
}

/** Everything together. Returns { file, code, spec, scenarios, warnings }. */
async function createTest({ scriptPath, localDir, outFile, input, serviceVars, onNewCall, date }) {
  scriptPath = path.resolve(scriptPath);
  localDir = path.resolve(localDir || path.dirname(scriptPath));
  const rel = path.relative(localDir, scriptPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${path.basename(scriptPath)} isn't inside the local:/// folder you chose (${localDir}). ` +
      'Pick the folder that contains the script (or a parent of it) with --local-dir.');
  }
  const source = fs.readFileSync(scriptPath, 'utf8');
  const info = analyze(source);
  const spec = {
    scriptPath,
    localDir,
    scriptUrl: 'local:///' + rel.split(path.sep).join('/'),
    info,
    request: defaultRequest(info, input),
    backends: [],
  };
  if (serviceVars && Object.keys(serviceVars).length) {
    spec.request.serviceVars = { ...(spec.request.serviceVars || {}), ...serviceVars };
  }
  await discover(spec, onNewCall);
  const scenarios = await characterize(spec);
  const code = generate(spec, scenarios, outFile, { date });

  const warnings = [];
  for (const s of scenarios) {
    if (s.observed.error) {
      const hint = s.kind === 'happy' && spec.backends.some((b) => b.placeholder)
        ? ' This is probably the placeholder backend response missing fields the script reads: paste a real response into BACKENDS and regenerate or edit the test.'
        : '';
      warnings.push(`"${scenarioTitle(s)}" fails for now: the script crashed (${s.observed.error}).${hint}`);
    }
    else if (masksFailure(s)) warnings.push(`"${scenarioTitle(s)}": a backend failed but the client still got ${s.observed.statusCode}. Check that's intended.`);
  }
  if (!spec.backends.length && /require\(\s*['"]urlopen['"]/.test(source)) {
    warnings.push('The script uses urlopen but made no calls with this request. Try a more realistic --input so it reaches its backend calls.');
  }
  if (spec.backends.some((b) => b.placeholder)) warnings.push('Some backends answer with a placeholder {}. Replace them with real responses (search for "placeholder").');
  if (info.unsupportedModules.length) warnings.push(`Fake the ${info.unsupportedModules.join(', ')} module(s) in newGateway() before relying on these tests.`);
  return { file: outFile, code, spec, scenarios, warnings };
}

module.exports = { lit, scenarioTitle, analyze, defaultRequest, discover, characterize, generate, createTest, applySetup };
