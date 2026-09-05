'use strict';
// Searching what is *inside* files, rather than what they are called.
//
// The application already had two-thirds of this and could not use it. The
// walker records every file's name, size and times. `extract.js` reads the real
// text out of .docx, .pptx, .pdf, .rtf and every plain format. What was missing
// was somewhere to put the words: `doc_text` stores a SimHash, which answers
// "are these two documents the same" and cannot answer "which of these is about
// elephants". This module keeps the words in SQLite's own full-text index and
// answers the second question.
//
// Three rules, and they are the same three the rest of the application holds to:
//
//   1. Every result is a file that was opened and read. There is no guessing
//      from a filename, and no result is returned for a file whose text was
//      never successfully extracted.
//   2. A file that could not be read is recorded as unread, with the reason,
//      and is reported as such. "No match" and "never looked" must not be the
//      same answer — a scanned PDF holding only page images genuinely has no
//      text, and saying "nothing matched" about it would be a lie of omission.
//   3. Indexing is bounded by a time budget and a file cap, and it says what it
//      covered. A search that ran out of budget reports how far it got instead
//      of presenting a partial sweep as a complete one.
//
// Nothing here is a model, an embedding, or a semantic anything. It is a
// stemmed inverted index with bm25 ranking — a documented, inspectable
// algorithm that has been in SQLite for a decade. The assistant reads the
// snippets this returns and does the judging; retrieval stays honest.

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const roots = require('../security/roots');
const { extractText, EXTRACTABLE } = require('../classify/extract');

// Extraction reads the whole file into memory. A 200 MB "document" is either a
// database with a .json extension or a mistake, and reading it would stall the
// index for one useless row.
const MAX_DOC_BYTES = 32 << 20;

// Stored per file. Enough to find any passage and to quote it back; far short of
// keeping a copy of the user's documents in the index.
const MAX_STORED_CHARS = 200_000;

const EXTRACTABLE_SET = new Set(EXTRACTABLE);

// Directories that never hold a document the user wrote. Skipping them is what
// makes an unindexed home directory searchable in seconds rather than minutes:
// node_modules alone is usually more files than everything else combined.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  'env', '.env', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
  '.cache', 'cache', 'caches', '.gradle', '.m2', '.cargo', '.rustup',
  '.npm', '.yarn', '.pnpm-store', 'vendor', 'bower_components',
  '.trash', '$recycle.bin', 'appdata', 'library', 'applications',
  'windows', 'program files', 'program files (x86)', 'programdata',
  '.docker', '.vagrant', 'site-packages', '.pyenv', '.nvm',
]);

// Where a person's own writing actually lives. Searched first, so a question
// about a blog post is usually answered before the walk reaches anything else.
const PREFERRED = ['Documents', 'Desktop', 'Downloads', 'Notes', 'Writing', 'Blog', 'OneDrive'];

// Words that match half the corpus and rank nothing. Dropped from a query, but
// never from the stored text — a phrase search still needs them present.
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i',
  'if', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'she',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'will',
  'with', 'would', 'you', 'your',
  // Words that describe the *task*, not the subject. "Find my blog about
  // elephants" is a search for elephants; without these the word "find" ranks
  // every file containing the word "find".
  'find', 'open', 'show', 'get', 'search', 'look', 'convert', 'make', 'turn',
  'file', 'files', 'document', 'documents', 'please', 'want', 'need', 'about',
]);

/**
 * The searchable words in a phrase.
 *
 * Kept deliberately dumb: lowercase, split on anything that is not a letter or
 * digit, drop the stop words and anything shorter than three characters. The
 * stemming that turns "elephants" into "elephant" is done by SQLite's porter
 * tokenizer, on both the stored text and the query, so it does not need doing
 * here and doing it here would only disagree with it.
 */
function keywordsFrom(query) {
  const seen = new Set();
  const out = [];
  for (const raw of String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const w = raw.trim();
    if (w.length < 3) continue;
    if (STOP_WORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * One term as an FTS5 MATCH expression.
 *
 * Double quotes make it a literal string rather than a fragment of FTS5's query
 * language, so a user typing `AND` or `*` or `"` searches for those characters
 * instead of writing a query. The trailing `*` matches on prefix, which catches
 * "elephant" in "elephantine" — the porter tokenizer handles plurals and tenses
 * but not compounds.
 */
function termExpression(term) {
  return `"${String(term).replace(/"/g, '""')}"*`;
}

// ── deciding what to read ───────────────────────────────────────────────────

/** True for a file this module can extract text from at a sensible cost. */
function isCandidate(filePath, size) {
  if (size > MAX_DOC_BYTES || size === 0) return false;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXTRACTABLE_SET.has(ext);
}

function shouldSkipDir(name) {
  const n = name.toLowerCase();
  if (n.startsWith('.') && n !== '.') return true;
  return SKIP_DIRS.has(n);
}

/**
 * Candidate documents, from the most recent scan when there is one.
 *
 * A scan has already walked the disk and recorded every file, so asking SQLite
 * is free where re-walking would cost seconds. This is the fast path and it is
 * the one that runs on a machine the user has actually scanned.
 */
function candidatesFromScan(index, scanId, { limit }) {
  const rows = index.filesByExtensions(scanId, [...EXTRACTABLE_SET], 1);
  const out = [];
  for (const r of rows) {
    if (r.size > MAX_DOC_BYTES) continue;
    out.push({ path: r.path, size: r.size });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Candidate documents found by walking, for a machine with no scan yet.
 *
 * Breadth-first from each approved root, with Documents and Desktop pulled to
 * the front of the queue, a depth cap, and the skip list above. This is not a
 * substitute for a scan and does not pretend to be one: it exists so that the
 * first question ever asked of the assistant can be answered without making the
 * user run a scan first.
 */
async function candidatesFromWalk({ limit, deadline, under = null }) {
  const found = [];
  const queue = [];

  // A caller may scope the walk to one folder. It still has to be inside an
  // approved root — narrowing the search is not a way to widen what may be read.
  const startingPoints = under
    ? [roots.assertInsideRoot(under, { mustExist: true })]
    : roots.listRoots();

  for (const root of startingPoints) {
    // listRoots stores case-folded paths. `realpathSync.native` is what restores
    // the true spelling — the JavaScript implementation resolves symlinks but
    // hands back "/users/param" unchanged, and every path derived from it would
    // then be shown to the user in a spelling their disk does not use.
    let real = root;
    try { real = fs.realpathSync.native(root); } catch {
      try { real = fs.realpathSync(root); } catch { /* keep the folded form */ }
    }
    queue.push({ dir: real, depth: 0 });
  }

  // Preferred folders first, then the roots themselves.
  const preferred = [];
  for (const { dir } of [...queue]) {
    for (const name of PREFERRED) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isDirectory()) preferred.push({ dir: p, depth: 1 });
      } catch { /* not present on this machine */ }
    }
  }
  queue.unshift(...preferred);

  const seen = new Set();
  while (queue.length && found.length < limit) {
    if (Date.now() > deadline) break;
    const { dir, depth } = queue.shift();
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (depth > 6) continue;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;   // unreadable directory; not an error worth stopping for
    }

    for (const entry of entries) {
      if (found.length >= limit) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (!EXTRACTABLE_SET.has(ext)) continue;
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      if (st.size === 0 || st.size > MAX_DOC_BYTES) continue;
      found.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }

  return found;
}

/**
 * Reads and indexes documents, within a budget.
 *
 * Returns what it actually did, including what it ran out of time to reach.
 * A caller that reports "searched everything" on the strength of this without
 * checking `complete` is making a claim this function did not make.
 *
 * @param {object} deps
 * @param {import('../db').Index} deps.index
 * @param {string|null} deps.scanId   most recent scan, when one exists
 * @param {object} [opts]
 * @param {number} [opts.budgetMs]    wall-clock ceiling for the whole pass
 * @param {number} [opts.maxFiles]    ceiling on documents read this pass
 * @param {string} [opts.under]       restrict to one folder, which must itself be
 *                                    inside an approved root
 * @param {(p: object) => void} [opts.onProgress]
 */
async function ensureIndexed({ index, scanId }, {
  budgetMs = 20_000,
  maxFiles = 1_500,
  under = null,
  onProgress = null,
} = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;

  let candidates;
  let source;
  if (scanId && !under) {
    candidates = candidatesFromScan(index, scanId, { limit: maxFiles * 4 });
    source = 'the last scan';
  } else {
    candidates = await candidatesFromWalk({ limit: maxFiles * 2, deadline, under });
    source = under ? `a walk of ${under}` : 'a walk of your approved folders';
  }

  let read = 0;
  let skippedFresh = 0;
  let failed = 0;
  let complete = true;

  for (const cand of candidates) {
    if (read >= maxFiles || Date.now() > deadline) {
      complete = false;
      break;
    }

    let st;
    try {
      st = await fsp.stat(cand.path);
    } catch {
      continue;   // listed by a scan, gone since; nothing to index
    }
    if (!st.isFile() || !isCandidate(cand.path, st.size)) continue;

    if (index.docBodyFresh(roots.normalize(cand.path), st.size, st.mtimeMs)) {
      skippedFresh++;
      continue;
    }

    // The read itself goes through the same gate as every other read in this
    // application. A path from a stale scan row could name a file that has since
    // moved inside a folder the user withdrew.
    let safe;
    try {
      safe = roots.assertInsideRoot(cand.path, { mustExist: true });
    } catch {
      continue;
    }

    const extracted = await extractText(safe);
    index.putDocBody({
      pathKey: roots.normalize(safe),
      path: safe,
      name: path.basename(safe),
      size: st.size,
      mtimeMs: st.mtimeMs,
      chars: extracted.chars || 0,
      extension: extracted.extension,
      method: extracted.method,
      note: extracted.note,
      ok: extracted.ok && (extracted.text || '').trim().length > 0,
      body: (extracted.text || '').slice(0, MAX_STORED_CHARS),
    });

    read++;
    if (!extracted.ok) failed++;
    if (onProgress && read % 5 === 0) {
      onProgress({ read, failed, total: candidates.length, current: path.basename(safe) });
    }
  }

  return {
    source,
    candidates: candidates.length,
    read,
    skippedFresh,
    failed,
    complete,
    ms: Date.now() - started,
  };
}

// ── searching ───────────────────────────────────────────────────────────────

/**
 * Finds documents whose text matches a phrase.
 *
 * Each keyword is searched separately and the results merged, rather than
 * issuing one OR query, because that is what makes "matched 3 of 3 terms"
 * something the interface can honestly show. A file containing every term
 * outranks one containing a single term however often it repeats it, which is
 * the difference between a blog about elephants and a shopping list that
 * mentions an elephant costume.
 *
 * @returns {{terms, matches, searched, note}}
 */
function search({ index }, query, { limit = 12, perTerm = 60 } = {}) {
  const terms = keywordsFrom(query);
  const stats = index.docIndexStats();

  if (terms.length === 0) {
    return {
      terms: [], matches: [], searched: stats.readable,
      note: 'That question had no searchable words in it.',
    };
  }

  const byPath = new Map();
  for (const term of terms) {
    let rows;
    try {
      rows = index.searchDocBodies(termExpression(term), { limit: perTerm });
    } catch {
      continue;   // a term FTS5 will not parse; the others still count
    }
    for (const row of rows) {
      const existing = byPath.get(row.path);
      if (existing) {
        existing.terms.add(term);
        // bm25 returns a negative score where more negative is a better match.
        existing.score += row.rank;
        if (!existing.snippet.includes(row.snippet)) existing.snippets.push(row.snippet);
      } else {
        byPath.set(row.path, {
          path: row.path,
          name: row.name,
          size: row.size,
          mtimeMs: row.mtimeMs,
          extension: row.extension,
          chars: row.chars,
          method: row.method,
          terms: new Set([term]),
          score: row.rank,
          snippet: row.snippet,
          snippets: [row.snippet],
        });
      }
    }
  }

  // The index is a record of files that were read, and a file can be moved,
  // renamed or deleted after it was read. Returning one anyway produces a result
  // the user cannot act on — and, worse, hands the assistant a path that every
  // later step refuses, which is exactly the loop this check was written to end.
  // The row is forgotten as it is dropped, so the same ghost is not re-checked
  // on every search from here on.
  let vanished = 0;
  for (const [key, m] of [...byPath.entries()]) {
    if (fs.existsSync(m.path)) continue;
    byPath.delete(key);
    try { index.deleteDocBody(roots.normalize(m.path)); } catch { /* already gone */ }
    vanished++;
  }

  const matches = [...byPath.values()]
    .map((m) => {
      const nameHit = terms.some((t) => m.name.toLowerCase().includes(t));
      return {
        path: m.path,
        name: m.name,
        bytes: m.size,
        extension: m.extension,
        chars: m.chars,
        readWith: m.method,
        lastModified: m.mtimeMs ? new Date(m.mtimeMs).toISOString().slice(0, 10) : null,
        matchedTerms: [...m.terms],
        matchedTermCount: m.terms.size,
        termCount: terms.length,
        filenameMatches: nameHit,
        // The passage that caused the match, with the matched words marked.
        // This is the evidence: it is why the interface can show the user what
        // it found rather than asking them to trust a ranking.
        snippet: m.snippets.slice(0, 2).join(' … '),
        _rank: m.score,
      };
    })
    .sort((a, b) => {
      if (b.matchedTermCount !== a.matchedTermCount) return b.matchedTermCount - a.matchedTermCount;
      if (b.filenameMatches !== a.filenameMatches) return b.filenameMatches ? 1 : -1;
      return a._rank - b._rank;
    })
    .slice(0, limit)
    .map(({ _rank, ...rest }) => rest);

  return {
    terms,
    matches,
    searched: stats.readable - vanished,
    unreadable: stats.files - stats.readable,
    note: stats.files === 0
      ? 'No document has been read yet, so there is nothing to search.'
      : vanished
        ? `${vanished} previously indexed file(s) no longer exist and were dropped.`
        : null,
  };
}

/** More of one document's text than a snippet, for a closer look. */
function readIndexed({ index }, filePath, { maxChars = 6_000 } = {}) {
  const safe = roots.assertInsideRoot(filePath, { mustExist: true });
  const row = index.docBodyFor(roots.normalize(safe));
  if (!row) return { ok: false, path: safe, note: 'This file has not been read into the index.' };
  if (!row.ok) return { ok: false, path: safe, note: row.note || 'No text could be extracted from this file.' };
  const body = String(row.body || '');
  return {
    ok: true,
    path: safe,
    name: row.name,
    chars: row.chars,
    readWith: row.method,
    truncated: body.length > maxChars,
    text: body.slice(0, maxChars),
  };
}

module.exports = {
  ensureIndexed,
  search,
  readIndexed,
  keywordsFrom,
  termExpression,
  isCandidate,
  MAX_DOC_BYTES,
  MAX_STORED_CHARS,
  STOP_WORDS,
};
