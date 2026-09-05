'use strict';
// Building the description index.
//
// Walks the files worth describing, sends each to ../classify/llm-tags.js, and
// stores what comes back. It is the expensive half of describe-to-find: one API
// call per file, so everything here exists to make sure a call is made only
// when it will buy something.
//
//   - A file whose size and modification time already have a description is
//     skipped outright. Re-running the build after adding fifty photos costs
//     fifty calls, not five thousand.
//   - A file that was examined and could not be described is remembered as
//     such, so it is not paid for again on the next run.
//   - Everything is bounded and interruptible: a file cap, a wall-clock
//     ceiling, and a cancel flag checked between files. A run that stops early
//     says so, and the interface repeats that rather than implying the disk was
//     covered.
//
// Files are taken from the last scan when there is one, because that is already
// a measured list of what exists. Without a scan it walks the approved roots
// instead, so the feature can be tried before committing to a full scan.

const path = require('path');
const fsp = require('fs').promises;

const roots = require('../security/roots');
const llmTags = require('../classify/llm-tags');
const { classifyPath } = require('../classify/rules');

// Directories never worth describing: their contents are machine-generated,
// enormous, and nobody searches for them by description.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'venv', '.venv', '__pycache__',
  'dist', 'build', 'out', 'target', 'obj', 'bin', '.next', '.nuxt', '.cache',
  'appdata', 'windows', 'program files', 'program files (x86)', 'programdata',
  '$recycle.bin', 'system volume information', 'library', 'caches',
  'site-packages', 'vendor', '.gradle', '.m2', 'temp', 'tmp',
]);

const MAX_WALK_DEPTH = 8;

function shouldSkipDir(name) {
  const n = name.toLowerCase();
  return n.startsWith('.') || SKIP_DIRS.has(n);
}

/** Case-folded path, matching how db.js keys its path-addressed tables. */
function pathKeyOf(p) {
  return process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase();
}

/**
 * Describable files out of the last scan — already a measured list of what
 * exists, ordered pictures-first and most-recent-first by the query itself.
 *
 * @param {object} kinds which sorts of file the user agreed to describe
 */
function candidatesFromScan(index, scanId, { limit, under = null, kinds = {} }) {
  const otherExts = [
    ...(kinds.includeDocuments === false ? [] : llmTags.DOC_EXTS),
    ...(kinds.includeCode ? llmTags.CODE_EXTS : []),
  ];
  const rows = index.describeCandidates(scanId, {
    imageExts: [...llmTags.IMAGE_EXTS],
    otherExts,
    under,
    limit: limit * 2,
  });
  const out = [];
  for (const r of rows) {
    if (!llmTags.isDescribable(r.path)) continue;
    out.push({ path: r.path, size: r.size });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Describable files found by walking, for a machine with no scan yet.
 *
 * Breadth-first from each approved root so that the shallow, human-arranged
 * folders are reached before anything buried deep in a tree.
 */
async function candidatesFromWalk({ limit, deadline, under = null }) {
  const found = [];
  const startingPoints = under
    ? [roots.assertInsideRoot(under, { mustExist: true })]
    : roots.listRoots();

  const queue = [];
  for (const root of startingPoints) {
    let real = root;
    try { real = require('fs').realpathSync.native(root); } catch { /* keep as stored */ }
    queue.push({ dir: real, depth: 0 });
  }

  while (queue.length && found.length < limit) {
    if (Date.now() > deadline) break;
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;   // unreadable; not an error worth stopping the walk for
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= MAX_WALK_DEPTH || shouldSkipDir(e.name)) continue;
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!e.isFile() || !llmTags.isDescribable(full)) continue;
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      found.push({ path: full, size: st.size });
      if (found.length >= limit) break;
    }
  }
  return found;
}

/**
 * Describes files, within a budget.
 *
 * @param {object} ctx
 * @param {object} ctx.index
 * @param {string|null} ctx.scanId
 * @param {object} deps
 * @param {object} deps.gemini
 * @param {object} [deps.nativeImage]
 * @param {object} opts
 * @param {number} [opts.maxFiles]  hard cap on API calls this run
 * @param {number} [opts.budgetMs]  wall-clock ceiling
 * @param {string} [opts.under]     restrict to one folder
 * @param {Function} [opts.onProgress]
 * @param {Function} [opts.shouldCancel]
 */
async function buildDescriptions({ index, scanId }, { gemini, nativeImage = null }, {
  maxFiles = 200,
  budgetMs = 10 * 60_000,
  under = null,
  kinds = {},
  onProgress = null,
  shouldCancel = () => false,
} = {}) {
  if (!gemini || !gemini.available) {
    const err = new Error(
      'Describing files needs a Gemini API key. Add one in Settings, then try again.');
    err.code = 'NO_KEY';
    throw err;
  }

  const started = Date.now();
  const deadline = started + budgetMs;

  // A folder the user named is searched against the scan when the scan covers
  // it, because that is already a measured list and needs no second walk. Only
  // a folder outside the scan, or no scan at all, falls back to walking.
  let candidates = [];
  let source;
  if (scanId) {
    candidates = candidatesFromScan(index, scanId, { limit: maxFiles * 6, under, kinds });
    source = under ? `the last scan, within ${path.basename(under)}` : 'the last scan';
  }
  if (!candidates.length) {
    candidates = await candidatesFromWalk({ limit: maxFiles * 4, deadline, under });
    source = under ? `a walk of ${under}` : 'a walk of your approved folders';
  }

  const stats = {
    examined: 0, described: 0, skippedFresh: 0, failed: 0, tags: 0,
    candidates: candidates.length,
  };
  let complete = true;
  let stoppedBy = null;

  for (const cand of candidates) {
    if (shouldCancel()) { complete = false; stoppedBy = 'cancelled'; break; }
    if (stats.described >= maxFiles) { complete = false; stoppedBy = 'file cap'; break; }
    if (Date.now() > deadline) { complete = false; stoppedBy = 'time budget'; break; }

    // Narrowing to a folder is not a way to widen what may be read: the path
    // still has to be inside a root the user approved.
    let safe;
    try {
      safe = roots.assertInsideRoot(cand.path, { mustExist: true });
    } catch {
      continue;
    }

    let st;
    try { st = await fsp.stat(safe); } catch { continue; }

    const key = pathKeyOf(safe);
    if (index.fileTagsFresh(key, st.size, st.mtimeMs)) {
      stats.skippedFresh++;
      continue;
    }

    stats.examined++;
    if (onProgress) {
      onProgress({
        phase: 'describe',
        examined: stats.examined,
        described: stats.described,
        failed: stats.failed,
        total: Math.min(candidates.length, maxFiles),
        current: safe,
      });
    }

    let result;
    try {
      result = await llmTags.describeFile(safe, { gemini, nativeImage });
    } catch (err) {
      if (err.code === 'CANCELLED') { complete = false; stoppedBy = 'cancelled'; break; }
      result = { ok: false, tags: [], note: err.message };
    }

    const c = classifyPath(safe, { isDirectory: false });
    index.putFileTags({
      pathKey: key,
      path: safe,
      name: path.basename(safe),
      extension: path.extname(safe).slice(1).toLowerCase() || null,
      category: c.category,
      kind: llmTags.kindOf(safe),
      size: st.size,
      mtimeMs: st.mtimeMs,
      tags: result.tags || [],
      model: result.model || gemini.model,
      ok: !!result.ok,
      note: result.note || null,
    });

    if (result.ok) {
      stats.described++;
      stats.tags += result.tags.length;
    } else {
      stats.failed++;
    }
  }

  return {
    ...stats,
    complete,
    stoppedBy,
    source,
    elapsedMs: Date.now() - started,
    model: gemini.model,
    indexed: index.tagIndexStats(),
    // What the interface must repeat rather than paraphrase. A partial run is
    // the normal case for a large disk, and a count from one must never be
    // shown as though it covered everything.
    note: complete
      ? `Described every candidate found from ${source}.`
      : `Stopped after ${stats.described} file(s) — ${stoppedBy}. ` +
        `Files not yet described cannot be found by description; run it again to continue.`,
  };
}

module.exports = { buildDescriptions, candidatesFromWalk, pathKeyOf, shouldSkipDir, SKIP_DIRS };
