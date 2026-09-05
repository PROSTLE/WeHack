'use strict';
// Windows hidden and system attributes.
//
// Node exposes no attribute bits on Windows. `fs.Stats.mode` carries the
// read-only flag and nothing else, so a listing built from `readdir` alone
// shows AppData, $Recycle.Bin, pagefile.sys and System Volume Information
// sitting in the open — a view of the disk that looks nothing like the one
// Explorer shows, which is the view the user recognises.
//
// `dir /a:H /b` and `dir /a:S /b` each report every hidden or system entry in
// a directory, files and folders alike, in one process. Two spawns per opened
// directory, roughly 40 ms together, cached against the directory's mtime.
// That is a great deal cheaper than one `attrib` call per entry, and unlike a
// list of well-known names it is the attribute the filesystem actually records.
//
// On macOS and Linux the convention is a leading dot, which needs no process.

const { execFile } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');

const CACHE_LIMIT = 48;
const TIMEOUT_MS = 6000;

/** dir (lowercased) -> { mtimeMs, hidden:Set, system:Set } */
const cache = new Map();

function runDir(dirPath, attr) {
  return new Promise((resolve) => {
    execFile(
      process.env.ComSpec || 'cmd.exe',
      // Resolved first: cmd reads a leading forward slash as the start of a
      // switch, so "c:/Lang/NexaFiles" would be parsed as `dir /Lang...` and
      // fail. Every caller inside the app passes a native path already, but a
      // listing must not depend on that.
      ['/d', '/c', 'dir', `/a:${attr}`, '/b', path.resolve(dirPath)],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const names = () => new Set(
          String(stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.toLowerCase())
        );

        if (!err) return resolve(names());

        // `dir` exits 1 and prints "File Not Found" when the directory simply
        // holds nothing carrying that attribute. That is an answer — the empty
        // set — and not a failure. Conflating the two was wrong in a way the
        // user could see: a folder with no hidden *and* no system entries
        // reported that its attributes could not be read, which dropped the
        // listing back to the dot-prefix convention and hid .gitignore, .env
        // and every other dot-file, none of which Windows hides at all.
        if (/File Not Found/i.test(String(stderr || ''))) return resolve(new Set());

        // Anything else is a real failure. It resolves rather than rejecting,
        // because an unreadable attribute list must not stop the directory from
        // being listed — but it resolves to null, so the caller can say the
        // attributes are unknown rather than claim nothing is hidden.
        return resolve(stdout ? names() : null);
      }
    );
  });
}

function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

/**
 * Reads which entries of `dirPath` carry the hidden or system attribute.
 *
 * @returns {Promise<{hidden:Set<string>, system:Set<string>}|null>}
 *   Names are lowercased. `null` when attributes could not be read at all, so a
 *   caller can say "not known" instead of "not hidden".
 */
async function readDirectoryAttributes(dirPath) {
  if (process.platform !== 'win32') return null;

  const key = path.resolve(dirPath).toLowerCase();
  let mtimeMs = 0;
  try { mtimeMs = (await fsp.stat(dirPath)).mtimeMs; } catch { /* listed anyway */ }

  const hit = cache.get(key);
  if (hit && hit.mtimeMs === mtimeMs) return { hidden: hit.hidden, system: hit.system };

  const [hidden, system] = await Promise.all([runDir(dirPath, 'H'), runDir(dirPath, 'S')]);
  if (!hidden && !system) return null;

  const value = { mtimeMs, hidden: hidden || new Set(), system: system || new Set() };
  remember(key, value);
  return { hidden: value.hidden, system: value.system };
}

/** The platform's own answer for one entry, used when no listing was read. */
function isHiddenByName(name) {
  return typeof name === 'string' && name.startsWith('.') && name !== '.' && name !== '..';
}

function clearCache() { cache.clear(); }

module.exports = { readDirectoryAttributes, isHiddenByName, clearCache };
