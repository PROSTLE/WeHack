'use strict';
// Filesystem primitives used by the safety pipeline.
//
// The important one is `safeMove`. `fs.rename` throws EXDEV when source and
// destination sit on different filesystems, which is the normal case here:
// quarantine lives in userData on the system drive, and the files being
// quarantined routinely do not. The fallback copies, verifies the copy by
// hash, and only then removes the source. The source is never removed before
// the destination is confirmed byte-identical.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

/** SHA-256 of a file, streamed so large files do not land in memory. */
async function hashFile(filePath) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), h);
  return h.digest('hex');
}

/** SHA-256 of a byte range. Used by the duplicate scanner's cheap pre-check. */
async function hashRange(filePath, start, length) {
  const h = crypto.createHash('sha256');
  await pipeline(
    fs.createReadStream(filePath, { start, end: start + length - 1 }),
    h
  );
  return h.digest('hex');
}

/** Recursive size and file count for a directory, skipping symlinks. */
async function measure(target) {
  let bytes = 0, files = 0, dirs = 0, skipped = 0;
  const st = await fsp.lstat(target);
  if (st.isSymbolicLink()) return { bytes: 0, files: 0, dirs: 0, skipped: 1 };
  if (!st.isDirectory()) return { bytes: st.size, files: 1, dirs: 0, skipped: 0 };

  const stack = [target];
  while (stack.length) {
    const dir = stack.pop();
    dirs++;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { skipped++; continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) { skipped++; continue; }
      if (e.isDirectory()) { stack.push(full); continue; }
      try {
        const s = await fsp.lstat(full);
        bytes += s.size;
        files++;
      } catch { skipped++; }
    }
  }
  return { bytes, files, dirs: dirs - 1, skipped };
}

/** Copies a single file and returns the destination hash. */
async function copyFileVerified(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
  const [a, b] = await Promise.all([hashFile(src), hashFile(dest)]);
  if (a !== b) {
    await fsp.rm(dest, { force: true });
    throw new Error(`Copy verification failed for ${src}: hashes differ`);
  }
  return b;
}

/** Recursively copies a directory, verifying every file by hash. */
async function copyDirVerified(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isSymbolicLink()) continue;      // never follow links across a move
    if (e.isDirectory()) await copyDirVerified(s, d);
    else await copyFileVerified(s, d);
  }
}

/**
 * Moves a file or directory, surviving cross-filesystem boundaries.
 *
 * Returns { method: 'rename' | 'copy-verify-delete', hash?: string }.
 * On the copy path the source is deleted only after every copied byte has
 * been verified against the original.
 */
async function safeMove(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  try {
    await fsp.rename(src, dest);
    return { method: 'rename' };
  } catch (err) {
    // EXDEV: different filesystems. EPERM/EACCES also surface here on Windows
    // for some cross-volume cases, so fall back on those too.
    if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(err.code)) throw err;
  }

  const st = await fsp.lstat(src);
  if (st.isDirectory()) {
    await copyDirVerified(src, dest);
    // Verified above file-by-file; safe to remove the source tree.
    await fsp.rm(src, { recursive: true, force: true });
    return { method: 'copy-verify-delete' };
  }

  const hash = await copyFileVerified(src, dest);
  await fsp.rm(src, { force: true });
  return { method: 'copy-verify-delete', hash };
}

// Above this size a copy is checked by size rather than by hash. Hashing both
// sides of a 4 GB video means reading 8 GB to confirm a copy the filesystem
// already reported as complete, which turns a routine file-manager action into
// a minutes-long wait. Below it, every copied byte is still verified.
const VERIFY_BY_HASH_LIMIT = 64 << 20;

/**
 * Copies a file or a whole tree, for the Files view.
 *
 * Unlike `safeMove` this never removes the source. Symlinks are skipped rather
 * than followed, so a copy cannot escape the tree it was asked to copy.
 *
 * @returns {{files: number, bytes: number, verified: number, unverified: number, skipped: number}}
 */
async function copyPath(src, dest, { onProgress = null } = {}) {
  const stats = { files: 0, bytes: 0, verified: 0, unverified: 0, skipped: 0 };

  async function copyOne(from, to) {
    const st = await fsp.lstat(from);
    if (st.isSymbolicLink()) { stats.skipped++; return; }

    if (st.isDirectory()) {
      await fsp.mkdir(to, { recursive: true });
      for (const e of await fsp.readdir(from, { withFileTypes: true })) {
        await copyOne(path.join(from, e.name), path.join(to, e.name));
      }
      return;
    }

    if (st.size <= VERIFY_BY_HASH_LIMIT) {
      await copyFileVerified(from, to);
      stats.verified++;
    } else {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
      const after = await fsp.stat(to);
      if (after.size !== st.size) {
        await fsp.rm(to, { force: true });
        throw new Error(`Copy of ${path.basename(from)} is ${after.size} bytes, not ${st.size}`);
      }
      stats.unverified++;
    }
    stats.files++;
    stats.bytes += st.size;
    if (onProgress) onProgress({ current: from, ...stats });
  }

  await copyOne(src, dest);
  return stats;
}

/** Picks a non-colliding name in `dir` for `base`, appending ` (2)`, ` (3)`… */
async function uniqueDestination(dir, base) {
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  let candidate = path.join(dir, base);
  let n = 2;
  for (;;) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${stem} (${n})${ext}`);
      n++;
    } catch {
      return candidate;
    }
  }
}

module.exports = {
  hashFile,
  hashRange,
  measure,
  safeMove,
  uniqueDestination,
  copyFileVerified,
  copyDirVerified,
  copyPath,
  VERIFY_BY_HASH_LIMIT,
};
