'use strict';
/**
 * Helpers for choosing the folder that stands in for local:/// on this machine.
 *
 * On DataPower, local:/// is the application domain's local: directory. The simulator
 * maps it to a folder on disk, and that folder must hold the same files in the same
 * layout, so 'local:///lib/util.js' in a script resolves to <folder>/lib/util.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Every complete local:///... path written as a string literal in the source. */
function findLocalRefs(source) {
  const refs = new Set();
  for (const m of source.matchAll(/(['"`])local:\/\/\/?([^'"`\s]+)\1/g)) {
    // skip folder prefixes ('local:///lib/' + name) and template strings; they aren't files
    if (!m[2].includes('${') && !m[2].endsWith('/')) refs.add(m[2].replace(/^\/+/, ''));
  }
  return [...refs];
}

/**
 * Turn what someone typed into an absolute path: trims spaces and surrounding
 * quotes (drag-and-drop into a terminal often adds them), unescapes "\ ", expands ~.
 */
function normaliseInput(answer, cwd = process.cwd()) {
  let p = String(answer).trim();
  if (/^(['"]).*\1$/.test(p)) p = p.slice(1, -1);
  p = p.replace(/\\ /g, ' ');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

/** 'local:///lib/x.js' for a file under the folder (forward slashes on every OS). */
function toLocalUrl(dir, file) {
  return 'local:///' + path.relative(dir, file).split(path.sep).join('/');
}

/**
 * Check a candidate folder. Returns { ok, dir, problem, scriptUrl, found, missing }.
 * `problem` is set when the folder can't work at all; `missing` lists local:/// files
 * the script refers to that aren't where they would be on the appliance.
 */
function checkLocalDir(answer, scriptPath, refs = [], cwd = process.cwd()) {
  const raw = String(answer || '').trim();
  const result = { ok: false, dir: null, problem: null, scriptUrl: null, found: [], missing: [] };
  if (!raw) { result.problem = 'Give a folder path.'; return result; }
  if (/^local:/i.test(raw)) {
    result.problem = "That's the DataPower name. Give the folder on this computer that holds the same files, e.g. ./local";
    return result;
  }
  const dir = normaliseInput(raw, cwd);
  result.dir = dir;
  if (!fs.existsSync(dir)) {
    result.problem = `That folder doesn't exist: ${dir}`;
    return result;
  }
  if (!fs.statSync(dir).isDirectory()) {
    result.problem = `That's a file, not a folder: ${dir}. Give the folder that contains it, e.g. ${path.relative(cwd, path.dirname(dir)) || '.'}`;
    return result;
  }
  const script = path.resolve(scriptPath);
  const rel = path.relative(dir, script);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    result.problem = `${path.basename(script)} isn't inside ${dir}. local:/// must be the folder that contains the script, or one of its parent folders.`;
    return result;
  }
  result.scriptUrl = toLocalUrl(dir, script);
  for (const ref of refs) {
    const file = path.join(dir, ref);
    (fs.existsSync(file) ? result.found : result.missing).push({ url: 'local:///' + ref, file });
  }
  result.ok = true;
  return result;
}

/**
 * The best default: the deepest folder at or above the script where every local:///
 * file the script refers to exists. Falls back to the script's own folder.
 */
function suggestLocalDir(scriptPath, refs = []) {
  const scriptDir = path.dirname(path.resolve(scriptPath));
  if (!refs.length) return scriptDir;
  for (let dir = scriptDir; ; dir = path.dirname(dir)) {
    if (refs.every((r) => fs.existsSync(path.join(dir, r)))) return dir;
    if (path.dirname(dir) === dir) return scriptDir;
  }
}

module.exports = { findLocalRefs, normaliseInput, toLocalUrl, checkLocalDir, suggestLocalDir };
