'use strict';
// Approved-root registry and path validation.
//
// Every filesystem IPC handler resolves its incoming path through `assertInsideRoot`
// before touching the disk. The renderer can name any path it likes; if that path
// does not resolve to a location inside a root the user explicitly approved, the
// call is rejected. This is the only thing standing between a compromised renderer
// and the whole filesystem.

const path = require('path');
const fs = require('fs');
const os = require('os');

// Roots the user has approved this session, stored as resolved real paths.
const approvedRoots = new Set();

// Paths that are never readable or writable regardless of approved roots.
// Matching is by prefix on the resolved path.
//
// Windows entries are derived from the environment rather than hardcoded to C:,
// because the system drive is not always C: and hardcoding it would silently
// disable these protections on machines where it is not.
const winSystemDrive = process.env.SystemDrive || 'C:';
const winRoot = process.env.SystemRoot || process.env.windir || path.join(winSystemDrive, 'Windows');
const winProgramFiles = process.env.ProgramFiles || path.join(winSystemDrive, 'Program Files');

const PLATFORM_DENY = {
  win32: [
    winRoot,
    path.join(winProgramFiles, 'WindowsApps'),
    path.join(winSystemDrive, path.sep, 'System Volume Information'),
    path.join(winSystemDrive, path.sep, '$Recycle.Bin'),
    path.join(winSystemDrive, path.sep, 'Recovery'),
  ],
  darwin: [
    '/System',
    '/usr',
    '/bin',
    '/sbin',
    '/private/var/db',
    '/Library/Apple',
  ],
  linux: [
    '/proc',
    '/sys',
    '/dev',
    '/boot',
    '/usr',
    '/bin',
    '/sbin',
  ],
};

// User-editable protected paths, loaded from and persisted to disk by protected.js.
let userProtected = [];

function setUserProtected(list) {
  userProtected = (list || []).map((p) => normalize(p));
}

function getUserProtected() {
  return [...userProtected];
}

/** Case-folds on Windows/macOS, strips trailing separators, resolves `..`. */
function normalize(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  let r = path.resolve(p);
  if (r.length > 1 && (r.endsWith(path.sep))) r = r.slice(0, -1);
  return process.platform === 'linux' ? r : r.toLowerCase();
}

/** True when `child` is `parent` or lives beneath it. Not a string prefix test. */
function isWithin(parent, child) {
  if (!parent || !child) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function isDenied(resolved) {
  const deny = PLATFORM_DENY[process.platform] || [];
  for (const d of deny) {
    if (isWithin(normalize(d), resolved)) return d;
  }
  for (const p of userProtected) {
    if (isWithin(p, resolved)) return p;
  }
  return null;
}

/**
 * Adds a root the user chose through a native directory picker.
 * Resolves symlinks so a link inside the root cannot later widen its scope.
 */
function approveRoot(dirPath) {
  let real;
  try {
    real = fs.realpathSync(dirPath);
  } catch {
    real = dirPath;
  }
  const n = normalize(real);
  if (!n) throw new Error('Invalid root path');
  const denied = isDenied(n);
  if (denied) {
    throw new Error(`Cannot approve a protected location (${denied})`);
  }
  approvedRoots.add(n);
  return real;
}

function revokeRoot(dirPath) {
  approvedRoots.delete(normalize(dirPath));
}

function listRoots() {
  return [...approvedRoots];
}

/**
 * The gate. Returns the resolved absolute path, or throws.
 *
 * `allowRootItself` lets a caller operate on the root directory itself
 * (listing it, for example) while still rejecting anything outside.
 */
function assertInsideRoot(candidate, { mustExist = false } = {}) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error('Path must be a non-empty string');
  }
  // Reject NUL and other control characters outright; they are used to truncate
  // paths in some syscall layers.
  if (/[\u0000-\u001f]/.test(candidate)) {
    throw new Error('Path contains control characters');
  }

  const resolved = path.resolve(candidate);

  // Resolve symlinks where the target exists, so a symlink inside an approved
  // root cannot point outside it.
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch (err) {
    if (mustExist) throw new Error(`Path does not exist: ${candidate}`);
    // For a path being created, the parent must exist and be inside a root.
    try {
      real = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      real = resolved;
    }
  }

  const n = normalize(real);
  const denied = isDenied(n);
  if (denied) {
    throw new Error(`Refused: ${candidate} is inside a protected location (${denied})`);
  }

  for (const root of approvedRoots) {
    if (isWithin(root, n)) return real;
  }
  throw new Error(
    `Refused: ${candidate} is outside every approved root. ` +
    `Add its folder as a root before operating on it.`
  );
}

/**
 * The non-throwing form of `assertInsideRoot`.
 *
 * The Files view needs to know whether it may open a location *before* it tries,
 * so it can offer the user the one button that grants access rather than showing
 * them an error they did not cause. This answers that question and nothing else:
 * it grants nothing and changes nothing.
 *
 * @returns {{allowed: boolean, reason: 'ok'|'protected'|'outside', detail: string|null, root: string|null}}
 */
function accessFor(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { allowed: false, reason: 'outside', detail: null, root: null };
  }
  let real = path.resolve(candidate);
  try { real = fs.realpathSync(real); } catch { /* may not exist; judged as named */ }
  const n = normalize(real);

  const denied = isDenied(n);
  if (denied) return { allowed: false, reason: 'protected', detail: denied, root: null };

  for (const root of approvedRoots) {
    if (isWithin(root, n)) return { allowed: true, reason: 'ok', detail: null, root };
  }
  return { allowed: false, reason: 'outside', detail: null, root: null };
}

/** Seeds the roots a user implicitly approves by launching the app. */
function approveDefaultRoots() {
  const home = os.homedir();
  const seeded = [];
  try {
    approveRoot(home);
    seeded.push(home);
  } catch { /* home unreadable; leave roots empty */ }
  return seeded;
}

module.exports = {
  approveRoot,
  accessFor,
  revokeRoot,
  listRoots,
  assertInsideRoot,
  approveDefaultRoots,
  setUserProtected,
  getUserProtected,
  normalize,
  isWithin,
  isDenied,
};
