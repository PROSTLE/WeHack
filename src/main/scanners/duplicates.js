'use strict';
// Duplicate detection in three tiers.
//
// None of this is AI, and the UI must not call it that. Tiers 2 and 3 are
// perceptual hashing algorithms — deterministic, explainable, and reproducible,
// which is precisely why they are more defensible than a model would be.
//
// Tier 1  exact            size bucket -> head/tail sample -> full SHA-256
// Tier 2  image-perceptual dHash + Hamming distance
// Tier 3  text-simhash     SimHash over word shingles + Hamming distance
//
// The cost discipline in tier 1 is the whole game: hashing every file on a disk
// is the standard naive approach and it turns a minutes-long scan into an
// hours-long one. Files are only ever fully hashed after they have already
// matched on size AND on their first and last 4 KB.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { hashFile, hashRange, mapLimit } = require('../safety/fsops');
const { CATEGORY } = require('../classify/rules');
const video = require('./video');

const SAMPLE_BYTES = 4096;

// How many candidate files to sample at once. Lower than the 64 used for stats
// because these reads carry data rather than just metadata, and the point is to
// keep the disk queue busy, not to thrash it.
const READ_CONCURRENCY = 16;

// ── Tier 1: exact duplicates ───────────────────────────────────────────────

/**
 * @param {Index} index
 * @param {string} scanId
 * @param {object} opts
 * @returns {Promise<{groups: Array, stats: object}>}
 */
async function findExactDuplicates(index, scanId, {
  minBytes = 4096,
  under = null,
  onProgress = () => {},
  shouldCancel = () => false,
} = {}) {
  const stats = { sizeGroups: 0, candidates: 0, sampled: 0, fullyHashed: 0, bytesHashed: 0 };

  // Step 1. Only files sharing an exact byte length can be identical.
  const sizeGroups = index.sizeCollisionGroups(scanId, minBytes, { under });
  stats.sizeGroups = sizeGroups.length;

  const groups = [];
  let processed = 0;

  for (const sg of sizeGroups) {
    if (shouldCancel()) break;
    const files = index.filesOfSize(scanId, sg.size, { under });
    stats.candidates += files.length;

    // Hardlinks are the same bytes on disk already; deleting one reclaims
    // nothing. Collapse them by dev:inode before doing any work.
    const byInode = new Map();
    const unique = [];
    for (const f of files) {
      if (f.fileId) {
        if (byInode.has(f.fileId)) continue;
        byInode.set(f.fileId, f.path);
      }
      unique.push(f);
    }
    if (unique.length < 2) continue;

    // Step 2. Cheap discriminator: first and last 4 KB. This eliminates almost
    // all same-size non-duplicates for the cost of two small reads.
    //
    // The reads run several at a time. Each is two 4 KB reads whose cost is
    // almost entirely waiting on the disk, and awaiting them one file after
    // another left the queue empty between each -- the same latency-bound
    // pattern the walker had. The grouping below is by content hash, so the
    // order results arrive in cannot affect which files end up together.
    const bySample = new Map();
    const sampled = await mapLimit(unique, READ_CONCURRENCY, async (f) => {
      if (shouldCancel()) return null;
      try {
        const head = await hashRange(f.path, 0, Math.min(SAMPLE_BYTES, sg.size));
        const tailStart = Math.max(0, sg.size - SAMPLE_BYTES);
        const tail = sg.size > SAMPLE_BYTES
          ? await hashRange(f.path, tailStart, sg.size - tailStart)
          : head;
        return { f, key: head + ':' + tail };
      } catch {
        return null;   // unreadable; leave it out rather than guess
      }
    });
    for (const r of sampled) {
      if (!r) continue;
      stats.sampled++;
      if (!bySample.has(r.key)) bySample.set(r.key, []);
      bySample.get(r.key).push(r.f);
    }

    // Step 3. Only now, for survivors, the full hash.
    for (const [, bucket] of bySample) {
      if (bucket.length < 2) continue;
      const byHash = new Map();
      for (const f of bucket) {
        if (shouldCancel()) break;
        try {
          const h = await hashFile(f.path);
          stats.fullyHashed++;
          stats.bytesHashed += sg.size;
          if (!byHash.has(h)) byHash.set(h, []);
          byHash.get(h).push(f);
        } catch { /* unreadable */ }
      }
      for (const [h, members] of byHash) {
        if (members.length < 2) continue;
        groups.push({
          id: crypto.randomUUID(),
          tier: 'exact',
          signature: h,
          // One copy is kept; the rest is what could be reclaimed.
          wastedBytes: sg.size * (members.length - 1),
          members: members.map((m) => ({ path: m.path, size: m.size, distance: 0 })),
        });
      }
    }

    processed++;
    if (processed % 20 === 0) {
      onProgress({ phase: 'exact', processed, total: sizeGroups.length, ...stats });
    }
  }

  return { groups, stats };
}

// ── Tier 2: near-duplicate images (dHash) ──────────────────────────────────

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff'];

/**
 * Difference hash: resize to 9x8 greyscale, then emit one bit per horizontally
 * adjacent pixel pair recording whether the left is brighter than the right.
 * 64 bits. Robust to rescaling and re-compression, which is exactly the case
 * being caught — the same photo at two resolutions.
 *
 * Decoding uses Electron's nativeImage, so there is no image library dependency.
 */
function dHashFromBitmap(bgra, width, height) {
  // nativeImage.toBitmap() returns BGRA, premultiplied, row-major.
  const grey = new Float64Array(width * height);
  for (let i = 0, p = 0; i < bgra.length; i += 4, p++) {
    // Rec. 601 luma from B, G, R.
    grey[p] = 0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2];
  }
  let bits = 0n;
  let n = 0n;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = grey[y * width + x];
      const right = grey[y * width + x + 1];
      if (left > right) bits |= (1n << n);
      n++;
    }
  }
  return bits;
}

function hamming64(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x) { x &= x - 1n; count++; }
  return count;
}

/**
 * @param {object} nativeImage Electron's nativeImage module, injected so this
 *   file stays unit-testable outside the Electron runtime.
 */
async function findSimilarImages(index, scanId, nativeImage, {
  under = null,
  minBytes = 16384,
  maxDistance = 6,
  onProgress = () => {},
  shouldCancel = () => false,
} = {}) {
  const files = index.filesByExtensions(scanId, IMAGE_EXTS, minBytes, { under });
  const hashes = [];
  const stats = { examined: 0, decoded: 0, failed: 0 };

  for (const f of files) {
    if (shouldCancel()) break;
    stats.examined++;
    try {
      const img = nativeImage.createFromPath(f.path);
      if (img.isEmpty()) { stats.failed++; continue; }
      const small = img.resize({ width: 9, height: 8, quality: 'good' });
      const size = small.getSize();
      if (size.width < 9 || size.height < 8) { stats.failed++; continue; }
      const bits = dHashFromBitmap(small.toBitmap(), size.width, size.height);
      hashes.push({ ...f, hash: bits });
      stats.decoded++;
    } catch {
      stats.failed++;
    }
    if (stats.examined % 50 === 0) {
      onProgress({ phase: 'images', ...stats, total: files.length });
    }
  }

  // Cluster by Hamming distance. O(n^2) over decoded images only; acceptable
  // because the image count after the size filter is small relative to the disk.
  const used = new Set();
  const groups = [];
  for (let i = 0; i < hashes.length; i++) {
    if (used.has(i)) continue;
    const members = [{ ...hashes[i], distance: 0 }];
    for (let j = i + 1; j < hashes.length; j++) {
      if (used.has(j)) continue;
      const d = hamming64(hashes[i].hash, hashes[j].hash);
      if (d <= maxDistance) {
        members.push({ ...hashes[j], distance: d });
        used.add(j);
      }
    }
    if (members.length < 2) continue;
    used.add(i);
    // Keep the largest copy; the rest is reclaimable.
    const sorted = members.sort((a, b) => b.size - a.size);
    groups.push({
      id: crypto.randomUUID(),
      tier: 'image-perceptual',
      signature: hashes[i].hash.toString(16).padStart(16, '0'),
      wastedBytes: sorted.slice(1).reduce((n, m) => n + m.size, 0),
      members: sorted.map((m) => ({ path: m.path, size: m.size, distance: m.distance })),
    });
  }

  return { groups, stats };
}

// ── Tier 3: near-duplicate documents (SimHash) ─────────────────────────────

// Plain-text formats only. Container formats (PDF, DOCX, PPTX) are handled by
// content-dupes.js, which parses their text out properly rather than reading
// their compressed bytes as UTF-8.
const TEXT_EXTS = ['txt', 'md', 'csv', 'json', 'xml', 'html', 'log', 'rtf'];

/** 64-bit SimHash over 3-word shingles. */
function simHash(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;
  const vector = new Array(64).fill(0);
  for (let i = 0; i <= words.length - 3; i++) {
    const shingle = words[i] + ' ' + words[i + 1] + ' ' + words[i + 2];
    const digest = crypto.createHash('md5').update(shingle).digest();
    for (let bit = 0; bit < 64; bit++) {
      const byte = digest[bit >> 3];
      const set = (byte >> (bit & 7)) & 1;
      vector[bit] += set ? 1 : -1;
    }
  }
  let hash = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (vector[bit] > 0) hash |= (1n << BigInt(bit));
  }
  return hash;
}

// Threshold calibrated against real document pairs rather than picked from a
// textbook. Measured Hamming distances over 64 bits:
//
//   identical / reflowed whitespace / PDF extraction noise ....  0
//   one word changed ..........................................  8
//   one sentence appended .....................................  8
//   a quarter of the document deleted ......................... 20
//   unrelated source code ..................................... 26
//   unrelated shopping list ................................... 32
//   unrelated prose ........................................... 39
//
// 12 clears the common near-duplicate cases with margin and deliberately does
// NOT catch the "quarter of the document deleted" case at 20. That is the right
// trade for a tool that proposes deletions: a document missing a quarter of its
// content is arguably not the same document, and a false positive here costs
// the user far more than a miss. Tier-3 results are user data, never
// pre-selected, and marked low confidence regardless.
async function findSimilarText(index, scanId, {
  minBytes = 2048,
  under = null,
  maxBytesRead = 1024 * 1024,
  maxDistance = 12,
  onProgress = () => {},
  shouldCancel = () => false,
} = {}) {
  const files = index.filesByExtensions(scanId, TEXT_EXTS, minBytes, { under });
  const hashes = [];
  const stats = { examined: 0, hashed: 0, failed: 0 };

  for (const f of files) {
    if (shouldCancel()) break;
    stats.examined++;
    try {
      const fd = await fsp.open(f.path, 'r');
      const len = Math.min(f.size, maxBytesRead);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, 0);
      await fd.close();
      const h = simHash(buf.toString('utf8'));
      if (h === null) { stats.failed++; continue; }
      hashes.push({ ...f, hash: h });
      stats.hashed++;
    } catch {
      stats.failed++;
    }
    if (stats.examined % 50 === 0) {
      onProgress({ phase: 'text', ...stats, total: files.length });
    }
  }

  const used = new Set();
  const groups = [];
  for (let i = 0; i < hashes.length; i++) {
    if (used.has(i)) continue;
    const members = [{ ...hashes[i], distance: 0 }];
    for (let j = i + 1; j < hashes.length; j++) {
      if (used.has(j)) continue;
      const d = hamming64(hashes[i].hash, hashes[j].hash);
      if (d <= maxDistance) { members.push({ ...hashes[j], distance: d }); used.add(j); }
    }
    if (members.length < 2) continue;
    used.add(i);
    const sorted = members.sort((a, b) => b.size - a.size);
    groups.push({
      id: crypto.randomUUID(),
      tier: 'text-simhash',
      signature: hashes[i].hash.toString(16).padStart(16, '0'),
      wastedBytes: sorted.slice(1).reduce((n, m) => n + m.size, 0),
      members: sorted.map((m) => ({ path: m.path, size: m.size, distance: m.distance })),
    });
  }

  return { groups, stats };
}

// ── Plan construction ──────────────────────────────────────────────────────

const TIER_LABEL = {
  'exact': 'Exact duplicate',
  'image-perceptual': 'Visually near-identical image',
  'text-simhash': 'Near-identical document text',
};

/**
 * Turns duplicate groups into plan entries.
 *
 * The largest copy in each group is kept and never appears in the plan. Every
 * other member carries the specific evidence for its match: the SHA-256 both
 * files share, or the perceptual distance and the path of the copy being kept.
 *
 * Near-duplicates are NOT byte-identical — one is usually higher quality — so
 * they are categorised as user data and never pre-selected.
 */
function duplicatesToPlanEntries(groups, { Plan, CATEGORY: CAT, ACTION, CONFIDENCE }) {
  const entries = [];
  for (const g of groups) {
    const [keep, ...rest] = g.members;
    for (const m of rest) {
      const isExact = g.tier === 'exact';
      entries.push({
        path: m.path,
        action: ACTION.TRASH,
        bytes: m.size,
        isDirectory: false,
        reason: `${TIER_LABEL[g.tier]} of ${path.basename(keep.path)}`,
        evidence: isExact
          ? `Byte-identical to ${keep.path}. Both files are ${m.size.toLocaleString()} bytes ` +
            `and share SHA-256 ${g.signature}.`
          : `Perceptual hash ${g.signature} differs from ${keep.path} by ${m.distance} of 64 bits ` +
            `(closer means more similar; unrelated files typically differ by 26 or more). ` +
            `The files are NOT byte-identical — one may be higher quality or more complete than the other.`,
        // Exact copies are provably redundant. Near-duplicates are a judgement
        // about which version the user wants, which is theirs to make.
        category: isExact ? CAT.REGENERABLE : CAT.USER_DATA,
        confidence: isExact ? CONFIDENCE.HIGH : CONFIDENCE.LOW,
        source: `duplicates:${g.tier}`,
        group: g.id,
      });
    }
  }
  return entries;
}

module.exports = {
  findExactDuplicates,
  findSimilarImages,
  findSimilarText,
  duplicatesToPlanEntries,
  simHash,
  hamming64,
  dHashFromBitmap,
  TIER_LABEL,
  IMAGE_EXTS,
  TEXT_EXTS,
};
