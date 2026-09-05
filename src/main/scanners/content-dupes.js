'use strict';
// Content-level duplicate detection for documents and video.
//
// These two tiers are separated from the byte-level and image tiers because
// both need to open the file and understand its format before any comparison is
// possible, and both are expensive enough to deserve a cache.
//
//   Documents  The text is parsed out of the container (PDF content streams,
//              OOXML parts) and fingerprinted with SimHash. Before this, .pdf
//              and .docx were read as raw UTF-8, which produced compressed
//              binary noise, so documents were never actually compared.
//
//   Video      Each file is reduced to a sequence of per-frame hashes on a
//              fixed one-second grid. Matching a short sequence inside a long
//              one finds a clip that was cut from a longer source, which no
//              whole-file hash can do.
//
// Every fingerprint is cached against the file size and modification time, so a
// second scan of an unchanged drive costs almost nothing. A changed file gets a
// different cache key and is recomputed.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { extractText } = require('../classify/extract');
const video = require('./video');

// ── documents ───────────────────────────────────────────────────────────────

// Everything the extractor can genuinely read.
const DOC_EXTS = [
  'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'log', 'yml', 'yaml',
  'rtf', 'pdf', 'docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods',
];

/**
 * Groups documents whose text is nearly identical.
 *
 * @param {Index} index
 * @param {string} scanId
 * @param {{simHash:Function, hamming64:Function}} algo the shared hashers
 */
async function findSimilarDocuments(index, scanId, algo, {
  minBytes = 2048,
  under = null,
  maxDistance = 12,
  minChars = 120,
  onProgress = () => {},
  shouldCancel = () => false,
} = {}) {
  const files = index.filesByExtensions(scanId, DOC_EXTS, minBytes, { under });
  const hashes = [];
  const stats = {
    examined: 0, fromCache: 0, extracted: 0, fingerprinted: 0,
    noText: 0, unsupported: 0, byFormat: {},
  };
  const notes = [];

  const bump = (fmt, key) => {
    stats.byFormat[fmt] = stats.byFormat[fmt] || { tried: 0, withText: 0, noText: 0 };
    stats.byFormat[fmt][key]++;
  };

  for (const f of files) {
    if (shouldCancel()) break;
    stats.examined++;

    let st;
    try { st = fs.statSync(f.path); } catch { continue; }
    const ext = path.extname(f.path).slice(1).toLowerCase();

    const cached = index.getDocText(f.path, st.size, st.mtimeMs);
    if (cached) {
      stats.fromCache++;
      bump(ext, 'tried');
      if (cached.simhash) {
        hashes.push({
          path: f.path, size: f.size, hash: BigInt('0x' + cached.simhash),
          chars: cached.chars, method: cached.method,
        });
        stats.fingerprinted++;
        bump(ext, 'withText');
      } else {
        stats.noText++;
        bump(ext, 'noText');
      }
      continue;
    }

    const r = await extractText(f.path);
    bump(ext, 'tried');

    if (!r.ok) {
      stats.unsupported++;
      bump(ext, 'noText');
      index.putDocText({
        path: f.path, size: st.size, mtimeMs: st.mtimeMs,
        simhash: null, chars: 0, method: r.method, note: r.note,
      });
      continue;
    }
    stats.extracted++;

    const h = r.chars >= minChars ? algo.simHash(r.text) : null;
    if (h === null) {
      // A real answer rather than a failure: there is too little text here to
      // compare. A scanned PDF lands in this branch and says so.
      stats.noText++;
      bump(ext, 'noText');
      index.putDocText({
        path: f.path, size: st.size, mtimeMs: st.mtimeMs,
        simhash: null, chars: r.chars, method: r.method, note: r.note,
      });
    } else {
      stats.fingerprinted++;
      bump(ext, 'withText');
      index.putDocText({
        path: f.path, size: st.size, mtimeMs: st.mtimeMs,
        simhash: h.toString(16).padStart(16, '0'),
        chars: r.chars, method: r.method, note: r.note,
      });
      hashes.push({ path: f.path, size: f.size, hash: h, chars: r.chars, method: r.method });
    }

    if (stats.examined % 20 === 0) {
      onProgress({ phase: 'documents', ...stats, total: files.length });
    }
  }

  const groups = [];
  const used = new Set();
  for (let i = 0; i < hashes.length; i++) {
    if (used.has(i)) continue;
    const members = [{ ...hashes[i], distance: 0 }];
    for (let j = i + 1; j < hashes.length; j++) {
      if (used.has(j)) continue;
      const d = algo.hamming64(hashes[i].hash, hashes[j].hash);
      if (d <= maxDistance) { members.push({ ...hashes[j], distance: d }); used.add(j); }
    }
    if (members.length < 2) continue;
    used.add(i);

    // Keep whichever copy yielded the most text: it is the most complete
    // version, which matters when the same report exists as .docx and .pdf.
    const sorted = members.sort((a, b) => (b.chars || 0) - (a.chars || 0));
    groups.push({
      id: crypto.randomUUID(),
      tier: 'text-simhash',
      signature: hashes[i].hash.toString(16).padStart(16, '0'),
      wastedBytes: sorted.slice(1).reduce((n, m) => n + m.size, 0),
      members: sorted.map((m) => ({
        path: m.path, size: m.size, distance: m.distance,
        chars: m.chars, method: m.method,
      })),
    });
  }

  const skipped = stats.noText + stats.unsupported;
  if (skipped > 0) {
    notes.push(
      `${skipped} document(s) yielded no comparable text. Scanned PDFs hold page ` +
      `images rather than words, and legacy .doc is a binary format this cannot ` +
      `read. Those files were not compared, rather than being compared badly.`
    );
  }

  return { groups, stats, notes };
}

// ── video ───────────────────────────────────────────────────────────────────

function serialiseSig(frames) {
  if (!frames || !frames.length) return null;
  return frames.map((f) => f.hash.toString(16).padStart(16, '0')).join(',');
}

function parseSig(text) {
  if (!text) return null;
  return text.split(',').filter(Boolean).map((h, i) => ({
    index: i, tMs: i * 1000, hash: BigInt('0x' + h),
  }));
}

/**
 * Finds duplicate videos, and clips that were cut from a longer source.
 *
 * The cascade reflects costs measured on real files rather than guessed at:
 *
 *   probe, metadata only ......... about 1.8 s, independent of file size
 *   coarse, 24 seeks ............. about 1.5 s, independent of file size
 *   dense, one frame per second .. about 8 s/GB for H.264, 87 s/GB for 4K HEVC
 *
 * Every video therefore gets a probe and a coarse signature. Dense sampling is
 * the only thing that can locate a clip inside a film, and it is the expensive
 * one, so it is limited to files below `denseMaxBytes`. Files above that are
 * compared whole-video only, and the result says so instead of implying the
 * search was exhaustive.
 */
async function findVideoDuplicates(index, scanId, {
  minBytes = 1 << 20,
  under = null,
  denseMaxBytes = 2 * (1 << 30),
  coarseFrames = 24,
  wholeVideoMinRatio = 0.75,
  onProgress = () => {},
  shouldCancel = () => false,
} = {}) {
  const tools = await video.detectTools();
  if (!tools.available) {
    return {
      groups: [],
      stats: { available: false, examined: 0 },
      notes: [tools.reason],
    };
  }

  const files = index.filesByExtensions(scanId, video.VIDEO_EXTS, minBytes, { under });
  const fps = [];
  const stats = {
    available: true, examined: 0, fromCache: 0, probed: 0,
    coarse: 0, dense: 0, tooLargeForDense: 0, failed: 0,
  };
  const notes = [];

  for (const f of files) {
    if (shouldCancel()) break;
    stats.examined++;
    let st;
    try { st = fs.statSync(f.path); } catch { continue; }

    const cached = index.getVideoFp(f.path, st.size, st.mtimeMs);
    if (cached) {
      stats.fromCache++;
      fps.push({
        path: f.path, size: st.size,
        durationSec: cached.durationSec, width: cached.width, height: cached.height,
        codec: cached.codec, bitRate: cached.bitRate,
        coarse: parseSig(cached.coarse) || [],
        dense: parseSig(cached.dense),
      });
      continue;
    }

    let meta;
    try { meta = await video.probe(f.path); stats.probed++; }
    catch { stats.failed++; continue; }

    let coarse = [];
    try {
      coarse = await video.coarseSignature(f.path, meta.durationSec, coarseFrames);
      if (coarse.length) stats.coarse++;
    } catch { /* a missing coarse signature is not fatal */ }

    let dense = null;
    if (st.size <= denseMaxBytes) {
      try {
        dense = (await video.denseSignature(f.path, { fps: 1 })).frames;
        stats.dense++;
      } catch { /* fall back to coarse only */ }
    } else {
      stats.tooLargeForDense++;
    }

    index.putVideoFp({
      path: f.path, size: st.size, mtimeMs: st.mtimeMs,
      durationSec: meta.durationSec, width: meta.width, height: meta.height,
      codec: meta.codec, bitRate: meta.bitRate,
      coarse: serialiseSig(coarse), dense: dense ? serialiseSig(dense) : null,
      denseFps: dense ? 1 : null,
      note: dense ? 'coarse and dense' : 'coarse only',
    });

    fps.push({ path: f.path, size: st.size, ...meta, coarse, dense });
    onProgress({ phase: 'video', ...stats, total: files.length });
  }

  if (stats.tooLargeForDense > 0) {
    notes.push(
      `${stats.tooLargeForDense} file(s) exceeded ` +
      `${(denseMaxBytes / (1 << 30)).toFixed(0)} GB and were compared whole-video only. ` +
      `A clip taken from one of them cannot be located without a full ` +
      `frame-by-frame pass, which reads the entire file.`
    );
  }

  const groups = [];
  const used = new Set();

  for (let i = 0; i < fps.length; i++) {
    if (used.has(i)) continue;
    const a = fps[i];

    for (let j = i + 1; j < fps.length; j++) {
      if (used.has(j)) continue;
      const b = fps[j];

      // Same length: compare the whole thing, catching re-encodes.
      const durClose = Math.abs((a.durationSec || 0) - (b.durationSec || 0)) <= 2;
      if (durClose && a.coarse.length >= 6 && b.coarse.length >= 6) {
        const c = video.compareCoarse(a.coarse, b.coarse);
        if (c && c.matchRatio >= wholeVideoMinRatio) {
          const keep = video.betterOf(a, b);
          const drop = keep === a ? b : a;
          groups.push(makeGroup('video-whole', keep, drop, {
            whole: c,
            reason: `Same length and visually identical across ${c.comparedFrames} sampled frames`,
          }));
          used.add(j);
          continue;
        }
      }

      // Different lengths: is the shorter one an excerpt of the longer?
      if (a.dense && b.dense) {
        const [shortOne, longOne] = a.dense.length <= b.dense.length ? [a, b] : [b, a];
        if (shortOne.dense.length >= 6 && longOne.dense.length > shortOne.dense.length) {
          const sub = video.findSubsequence(shortOne.dense, longOne.dense);
          if (sub) {
            groups.push(makeGroup('video-subclip', longOne, shortOne, {
              subclip: {
                startSec: sub.offset,
                startLabel: video.fmtTime(sub.offset * 1000),
                endLabel: video.fmtTime((sub.offset + shortOne.dense.length) * 1000),
                matchedFrames: sub.matchedFrames,
                comparedFrames: sub.comparedFrames,
                matchRatio: sub.matchRatio,
                meanDistance: sub.meanDistance,
              },
            }));
            used.add(j);
          }
        }
      }
    }
  }

  return { groups, stats, notes };
}

function makeGroup(tier, keep, drop, extra) {
  return {
    id: crypto.randomUUID(),
    tier,
    signature: (keep.dense || keep.coarse || [])[0]
      ? (keep.dense || keep.coarse)[0].hash.toString(16).padStart(16, '0')
      : 'unavailable',
    wastedBytes: drop.size,
    subclip: extra.subclip || null,
    whole: extra.whole || null,
    members: [
      {
        path: keep.path, size: keep.size, role: 'keep', distance: 0,
        durationSec: keep.durationSec, width: keep.width, height: keep.height,
      },
      {
        path: drop.path, size: drop.size, role: 'duplicate',
        distance: Math.round(extra.subclip?.meanDistance ?? extra.whole?.meanDistance ?? 0),
        durationSec: drop.durationSec, width: drop.width, height: drop.height,
      },
    ],
  };
}

// ── plan entries ────────────────────────────────────────────────────────────

/**
 * Turns document and video groups into plan entries.
 *
 * Neither tier produces byte-identical matches, so nothing here is ever
 * pre-selected: choosing between two versions of a document, or deciding that a
 * clip is expendable because its source still exists, is a judgement only the
 * person who made them can make.
 */
function contentDupesToPlanEntries(groups, { ACTION, CATEGORY, CONFIDENCE }) {
  const entries = [];
  for (const g of groups) {
    const [keep, ...rest] = g.members;
    for (const m of rest) {
      let reason, evidence;

      if (g.tier === 'video-subclip') {
        const s = g.subclip;
        reason = `Appears in full inside ${path.basename(keep.path)} at ${s.startLabel}`;
        evidence =
          `Every ${s.comparedFrames} second(s) of this clip was matched against ` +
          `${path.basename(keep.path)} frame by frame on a one-second grid. ` +
          `${s.matchedFrames} of ${s.comparedFrames} frames matched ` +
          `(${(s.matchRatio * 100).toFixed(0)}%), at a mean difference of ` +
          `${(s.meanDistance || 0).toFixed(1)} out of 64 bits, aligned starting at ` +
          `${s.startLabel}. The longer file is kept because it contains this footage ` +
          `and more; removing it would lose the rest.`;
      } else if (g.tier === 'video-whole') {
        const w = g.whole;
        reason = `Same footage as ${path.basename(keep.path)}`;
        evidence =
          `Both files are the same length and matched on ${w.matchedFrames} of ` +
          `${w.comparedFrames} sampled frames (${(w.matchRatio * 100).toFixed(0)}%), ` +
          `mean difference ${(w.meanDistance || 0).toFixed(1)} of 64 bits. ` +
          `The copy kept is ${keep.width}x${keep.height}; this one is ` +
          `${m.width}x${m.height}. They are NOT byte-identical.`;
      } else {
        reason = `Nearly the same text as ${path.basename(keep.path)}`;
        evidence =
          `Text was extracted from both files (${m.method}) and fingerprinted with ` +
          `SimHash. The two fingerprints differ by ${m.distance} of 64 bits; ` +
          `unrelated documents typically differ by 26 or more. This file yielded ` +
          `${(m.chars || 0).toLocaleString()} characters, the copy being kept yielded ` +
          `${(keep.chars || 0).toLocaleString()}. They are NOT byte-identical, and one ` +
          `may be a different edition or format of the other.`;
      }

      entries.push({
        path: m.path,
        action: ACTION.TRASH,
        bytes: m.size,
        isDirectory: false,
        reason,
        evidence,
        // Never pre-selected: none of these are provably redundant.
        category: CATEGORY.USER_DATA,
        confidence: CONFIDENCE.LOW,
        source: `duplicates:${g.tier}`,
        group: g.id,
      });
    }
  }
  return entries;
}

module.exports = {
  DOC_EXTS,
  findSimilarDocuments,
  findVideoDuplicates,
  contentDupesToPlanEntries,
  serialiseSig,
  parseSig,
};
