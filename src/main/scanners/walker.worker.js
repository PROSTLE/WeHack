'use strict';
// Disk-composition walker. Runs in a worker thread so a scan of a large tree
// never blocks the main process or the renderer.
//
// Rules this walker follows, and why:
//   - Iterative, not recursive. A deep tree must not blow the stack.
//   - Never hashes. Hashing during the walk is what turns a two-minute scan into
//     a two-hour one; the duplicate scanner hashes later, and only candidates.
//   - Never follows symlinks, and never crosses a device boundary. A link loop
//     or a mounted network share would otherwise make the walk unbounded.
//   - Streams results in batches. A million rows are never accumulated in memory
//     and sent at once.
//   - Checks for cancellation between batches.

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { classifyPath } = require('../classify/rules');

const BATCH_SIZE = 2000;

async function walk() {
  const { root, followSymlinks = false, crossDevice = false } = workerData;

  let rootDev = null;
  try {
    rootDev = (await fsp.lstat(root)).dev;
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: `Cannot read root ${root}: ${err.message}` });
    return;
  }

  const stack = [{ dir: root, depth: 0 }];
  const seenDirs = new Set();          // realpath guard against link loops
  let batch = [];
  let fileCount = 0, dirCount = 0, totalBytes = 0;
  let skipped = 0;
  const skipReasons = new Map();
  let cancelled = false;
  let lastProgressPost = 0;

  parentPort.on('message', (m) => {
    if (m && m.type === 'cancel') cancelled = true;
  });

  const noteSkip = (reason) => {
    skipped++;
    skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
  };

  const flush = (force = false) => {
    if (batch.length >= BATCH_SIZE || (force && batch.length)) {
      parentPort.postMessage({ type: 'batch', rows: batch });
      batch = [];
    }
  };

  // Record the root itself so the treemap has something to hang children from.
  {
    const c = classifyPath(root, { isDirectory: true });
    batch.push(rowFor(root, null, true, 0, null, 0, c));
  }

  while (stack.length) {
    if (cancelled) break;
    const { dir, depth } = stack.pop();

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      noteSkip(err.code === 'EPERM' || err.code === 'EACCES' ? 'permission denied' : err.code || 'unreadable');
      continue;
    }

    for (const entry of entries) {
      if (cancelled) break;
      const full = path.join(dir, entry.name);

      let st;
      try {
        st = await fsp.lstat(full);
      } catch (err) {
        noteSkip(err.code === 'EPERM' || err.code === 'EACCES' ? 'permission denied' : err.code || 'unreadable');
        continue;
      }

      if (st.isSymbolicLink()) {
        if (!followSymlinks) { noteSkip('symbolic link'); continue; }
        try { st = await fsp.stat(full); } catch { noteSkip('broken link'); continue; }
      }

      // Do not wander onto another filesystem: network shares and mounted
      // volumes would make both the walk and the reported total meaningless.
      if (!crossDevice && st.dev !== rootDev) { noteSkip('different filesystem'); continue; }

      if (st.isDirectory()) {
        // Guard against reaching the same directory twice. Identity comes from
        // device:inode, which lstat has already returned, rather than from a
        // realpath() call per directory — that syscall dominated walk time on a
        // 100k-directory tree. Symlinks and junctions are skipped above, so this
        // only has to catch genuine filesystem-level aliasing.
        if (st.ino) {
          const key = `${st.dev}:${st.ino}`;
          if (seenDirs.has(key)) { noteSkip('already visited'); continue; }
          seenDirs.add(key);
        }

        dirCount++;
        const c = classifyPath(full, { isDirectory: true });
        batch.push(rowFor(full, dir, true, 0, st, depth + 1, c));
        stack.push({ dir: full, depth: depth + 1 });
      } else if (st.isFile()) {
        fileCount++;
        totalBytes += st.size;
        const c = classifyPath(full, { isDirectory: false });
        batch.push(rowFor(full, dir, false, st.size, st, depth + 1, c));
      } else {
        noteSkip('not a regular file');
      }

      flush();
    }

    const now = Date.now();
    if (now - lastProgressPost > 150) {
      lastProgressPost = now;
      parentPort.postMessage({
        type: 'progress',
        fileCount, dirCount, totalBytes, skipped, current: dir,
      });
    }
  }

  flush(true);

  // Turn the skip tally into plain sentences the UI can show verbatim. An
  // incomplete scan says so rather than presenting its total as the whole truth.
  const notes = [];
  for (const [reason, n] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
    notes.push(`${n.toLocaleString()} item(s) skipped: ${reason}.`);
  }
  if (skipReasons.has('permission denied')) {
    notes.push('Totals below exclude locations this account cannot read, so the real figure is higher.');
  }

  parentPort.postMessage({
    type: 'done',
    cancelled,
    fileCount, dirCount, totalBytes, skipped, notes,
  });
}

function rowFor(full, parent, isDirectory, size, st, depth, c) {
  return {
    path: full,
    name: path.basename(full) || full,
    parent,
    isDirectory,
    size,
    mtimeMs: st ? st.mtimeMs : null,
    atimeMs: st ? st.atimeMs : null,
    birthMs: st ? st.birthtimeMs : null,
    extension: isDirectory ? null : path.extname(full).slice(1).toLowerCase() || null,
    type: c.type,
    category: c.category,
    depth,
    // dev:inode identifies hardlinks, so the same bytes are not counted twice.
    fileId: st && st.ino ? `${st.dev}:${st.ino}` : null,
  };
}

walk().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message, stack: err.stack });
});
