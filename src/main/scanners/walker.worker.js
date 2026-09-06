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
const cloud = require('../fs/cloud');

const BATCH_SIZE = 2000;

// How many stats to keep outstanding. Sixty-four is where the measured curve
// flattens on this machine: 8 gives 5.6x over sequential, 32 gives 6.6x, 64
// gives 7.7x, and 128 gives nothing more.
const STAT_CONCURRENCY = 64;

/**
 * Applies `fn` across `items` with at most `limit` outstanding, preserving
 * input order in the result.
 *
 * Not `Promise.all(items.map(fn))`: a directory can hold hundreds of thousands
 * of entries and that would open a handle for every one of them at once.
 * Duplicated here rather than imported from safety/fsops because this file runs
 * in a worker thread and should not pull the safety pipeline in with it.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  );
  return out;
}

async function walk() {
  const { root, followSymlinks = false, crossDevice = false } = workerData;

  // Which of this machine's folders are cloud sync roots. Resolved once, before
  // the walk, because the answer is a property of the machine and asking per
  // file would cost a directory probe a million times over. A file inside one
  // of these may report a size while holding none of those bytes locally, and
  // the walk has to record which — see src/main/fs/cloud.js.
  let cloudMatcher = cloud.makeMatcher([]);
  try {
    cloudMatcher = cloud.makeMatcher(await cloud.detectProviders());
  } catch { /* no sync folders detectable; every file counts as ordinary */ }

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
  // Measured beside totalBytes, never instead of it. Both are true and they
  // answer different questions: what these files weigh, and what of that is
  // actually on this disk.
  let physicalBytes = 0, placeholderCount = 0, placeholderBytes = 0;
  let streamedCount = 0, streamedBytes = 0;
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

    // Stat this directory's entries with several calls in flight at once.
    //
    // A stat is a syscall with latency, not a computation, so awaiting them one
    // after another leaves the disk idle in between. Measured on this machine
    // over a real tree: 10,500 stat/s sequentially against 81,000 stat/s with
    // sixty-four outstanding -- and a walk of a home directory is roughly a
    // million of these, so the difference is minutes.
    //
    // The results are consumed below in the original `entries` order, so
    // nothing about the walk's output depends on which stat finished first: the
    // rows, the totals and the skip tally come out identical to the sequential
    // version. Only the waiting is shared.
    const stats = await mapLimit(entries, STAT_CONCURRENCY, async (entry) => {
      try {
        return { st: await fsp.lstat(path.join(dir, entry.name)), err: null };
      } catch (err) {
        return { st: null, err };
      }
    });

    for (let i = 0; i < entries.length; i++) {
      if (cancelled) break;
      const entry = entries[i];
      const full = path.join(dir, entry.name);

      let st = stats[i].st;
      if (!st) {
        const err = stats[i].err;
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
        // What of this file is actually here. For anything outside a sync
        // folder this is the file's own size and costs nothing to record; for
        // a placeholder it is zero, and that difference is the whole point.
        const storage = cloud.describeStorage(st, cloudMatcher.match(full));
        if (storage.placeholder) {
          placeholderCount++;
          placeholderBytes += st.size;
        }
        if (storage.streamed) {
          streamedCount++;
          streamedBytes += st.size;
        }
        // A streamed file contributes to neither total: its local footprint is
        // not knowable, and guessing either way would put an invented number
        // into a figure the interface presents as measured.
        if (!storage.streamed) {
          physicalBytes += storage.physicalBytes === null ? st.size : storage.physicalBytes;
        }
        batch.push(rowFor(full, dir, false, st.size, st, depth + 1, c, storage));
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
    // The cloud picture for this walk. Reported separately so the interface can
    // say "8.9 GB of this is in OneDrive and not on your disk" rather than
    // quietly folding it into a total that would then be wrong.
    physicalBytes, placeholderCount, placeholderBytes, streamedCount, streamedBytes,
    cloudRoots: cloudMatcher.providers.map((p) => ({
      provider: p.provider, label: p.label, path: p.path,
    })),
  });
}

function rowFor(full, parent, isDirectory, size, st, depth, c, storage = null) {
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
    // Null rather than the size when there is no storage reading, so the
    // database can tell "not measured" from "measured as equal".
    physicalSize: storage ? storage.physicalBytes : null,
    cloudProvider: storage ? storage.provider : null,
    cloudPlaceholder: storage ? storage.placeholder : false,
    // Carried through to the row rather than dropped here. The walk already
    // counts streamed files into its own totals, so leaving this out looked
    // harmless — but the database uses it for two decisions the walk does not:
    // it is what keeps `physicalSize` NULL for a file whose footprint is
    // unknowable instead of filling in its logical size, and it is what the
    // duplicate and describe scanners test to avoid reading a file that a
    // driver would have to download first.
    cloudStreamed: storage ? storage.streamed : false,
  };
}

walk().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err.message, stack: err.stack });
});
