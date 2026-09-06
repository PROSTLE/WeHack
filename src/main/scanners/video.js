'use strict';
// Video content fingerprinting, including sub-clip detection.
//
// The problem this solves is one whole-file hashing cannot touch. A 40-second
// cut exported from a two-hour film shares no SHA-256 with its source, and no
// whole-video perceptual hash either — the two files have different lengths,
// different bitrates, usually different resolutions. Finding "this clip already
// exists inside that film" is a *subsequence* problem over a temporal
// fingerprint, not a hashing problem.
//
// How it works:
//   1. Each video is reduced to a sequence of 64-bit difference hashes, one per
//      sampled frame, each tagged with its timestamp.
//   2. To ask whether A is contained in B, slide A's sequence along B's and look
//      for a run where every frame matches within a small Hamming distance.
//
// Cost discipline, measured on this machine rather than assumed:
//
//   Dense keyframe decode ....... ~8 s per GB, and CPU-idle throughout — it is
//                                 bound by disk read speed (~375 MB/s), so no
//                                 amount of threading makes it faster.
//   Seek-based sampling ......... ~0.17 s per frame, independent of file size,
//                                 because it reads only around each seek point.
//
// Therefore: every video gets a cheap seek-based coarse signature whose cost
// depends on frame count, not gigabytes. Dense decoding is reserved for the
// short side of a candidate pair, where reading the whole file is cheap anyway.
// Fingerprints are cached against size and mtime, so a rescan costs nothing.

const { execFile, spawn } = require('child_process');
const util = require('util');
const path = require('path');
const execFileP = util.promisify(execFile);

const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts'];

// 9x8 greyscale: 8 rows of 9 pixels, giving 8 horizontal comparisons per row.
const FRAME_W = 9;
const FRAME_H = 8;
const FRAME_BYTES = FRAME_W * FRAME_H;

let toolCache = null;

/**
 * Locates ffmpeg and ffprobe.
 *
 * These are system binaries, not npm packages, so the project keeps its zero
 * runtime-dependency property. When they are absent the video scanner reports
 * that it cannot run rather than silently returning no duplicates — an empty
 * result and an unavailable tool must not look the same to the user.
 */
async function detectTools() {
  if (toolCache) return toolCache;
  const found = {};
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      const { stdout } = await execFileP(bin, ['-version'], { timeout: 8000, windowsHide: true });
      found[bin] = (stdout.split('\n')[0] || '').trim();
    } catch {
      found[bin] = null;
    }
  }
  toolCache = {
    available: !!(found.ffmpeg && found.ffprobe),
    ffmpeg: found.ffmpeg,
    ffprobe: found.ffprobe,
    reason: found.ffmpeg && found.ffprobe
      ? null
      : 'ffmpeg and ffprobe were not found on PATH. Video content analysis needs ' +
        'them to decode frames. Everything else in NexaFiles works without them.',
  };
  return toolCache;
}

/** Container and stream metadata. Cheap: no decoding. */
async function probe(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'format=duration,bit_rate,size',
    '-show_entries', 'stream=width,height,codec_name,avg_frame_rate',
    '-of', 'json', file,
  ], { timeout: 30000, maxBuffer: 4 << 20, windowsHide: true });

  const j = JSON.parse(stdout);
  const s = (j.streams && j.streams[0]) || {};
  const f = j.format || {};
  const duration = parseFloat(f.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('no readable duration');
  }
  return {
    durationSec: duration,
    width: s.width || 0,
    height: s.height || 0,
    codec: s.codec_name || null,
    bitRate: parseInt(f.bit_rate, 10) || 0,
    sizeBytes: parseInt(f.size, 10) || 0,
  };
}

/** Difference hash of one 9x8 greyscale frame: 64 bits as a BigInt. */
function dHashFromGray(buf, offset = 0) {
  let bits = 0n;
  let n = 0n;
  for (let y = 0; y < FRAME_H; y++) {
    const row = offset + y * FRAME_W;
    for (let x = 0; x < FRAME_W - 1; x++) {
      if (buf[row + x] > buf[row + x + 1]) bits |= (1n << n);
      n++;
    }
  }
  return bits;
}

function hamming(a, b) {
  let x = a ^ b, c = 0;
  while (x) { x &= x - 1n; c++; }
  return c;
}

/** Runs ffmpeg and collects raw greyscale frames from stdout. */
function runFrames(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    const chunks = [];
    let len = 0;
    // Kept, not discarded. `-v error` means anything arriving here is a real
    // complaint, and it is the only explanation of a failure available.
    let errText = '';
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(
      () => { proc.kill(); finish(reject, new Error('ffmpeg timed out')); },
      timeoutMs);

    proc.stdout.on('data', (d) => { chunks.push(d); len += d.length; });
    proc.stderr.on('data', (d) => {
      if (errText.length < 4096) errText += d.toString();
    });
    proc.on('error', (e) => finish(reject, e));
    proc.on('close', (code) => {
      // The exit code is checked rather than ignored, and this is the whole
      // point of the function.
      //
      // ffmpeg writes frames to stdout as it decodes them, so a run that dies
      // partway — an unreadable file, a corrupt stream, a codec this build
      // cannot decode — still leaves a buffer full of real frames behind. The
      // previous version resolved with whatever had arrived, so a decode that
      // failed after twenty seconds of a three-minute film produced a
      // perfectly well-formed twenty-second fingerprint, and nothing anywhere
      // downstream could tell it apart from a complete one.
      //
      // What that produced was not a crash but a wrong answer: a clip really
      // present in the part of the film that never got decoded was reported as
      // "no match" — an absence stated as a finding, from evidence that was
      // never gathered. Both callers already treat a throw properly (the
      // coarse pass skips that timestamp, the dense pass falls back to coarse
      // and counts the failure), so failing loudly here is what lets them.
      if (code !== 0) {
        const why = errText.trim().slice(-300) || `exit code ${code}`;
        return finish(reject, new Error(`ffmpeg failed: ${why}`));
      }
      finish(resolve, Buffer.concat(chunks, len));
    });
  });
}

/**
 * Coarse signature: `count` frames at evenly spaced timestamps, each fetched by
 * an input seek. Cost scales with `count`, not with file size, so a 5 GB film
 * and a 50 MB clip cost the same.
 */
async function coarseSignature(file, durationSec, count = 24) {
  const frames = [];
  // Stay clear of the first and last 3% — titles and credits are not content.
  const start = durationSec * 0.03;
  const span = durationSec * 0.94;
  const step = span / Math.max(1, count - 1);

  for (let i = 0; i < count; i++) {
    const t = start + step * i;
    try {
      const buf = await runFrames([
        '-v', 'error',
        '-ss', t.toFixed(3),
        '-i', file,
        '-vf', `scale=${FRAME_W}:${FRAME_H},format=gray`,
        '-frames:v', '1',
        '-f', 'rawvideo', '-',
      ], 30000);
      if (buf.length >= FRAME_BYTES) {
        frames.push({ tMs: Math.round(t * 1000), hash: dHashFromGray(buf, 0) });
      }
    } catch { /* unseekable point; a gap is honest, a fabricated frame is not */ }
  }
  return frames;
}

/**
 * Dense signature: one frame per fixed time interval.
 *
 * Sampling on a *time* grid rather than on keyframes is what makes cross-encode
 * matching possible at all. Keyframe placement is an encoder decision: measured
 * on this machine, a 4K HEVC source carried a keyframe every 0.93 s while an
 * H.264 re-encode of a 40 s excerpt from it carried one every 3.6 s. Two
 * sequences sampled at different rates cannot be compared index by index, and an
 * earlier keyframe-based version of this function failed to find a clip that was
 * demonstrably present in its own source.
 *
 * At one frame per second, frame *i* is second *i* in both files, so a match
 * offset is directly a timestamp.
 */
async function denseSignature(file, { fps = 1, maxFrames = 20000, timeoutMs = 900000 } = {}) {
  const buf = await runFrames([
    '-v', 'error',
    '-i', file,
    '-vf', `fps=${fps},scale=${FRAME_W}:${FRAME_H},format=gray`,
    '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-',
  ], timeoutMs);

  const total = Math.floor(buf.length / FRAME_BYTES);
  const take = Math.min(total, maxFrames);
  const frames = [];
  for (let i = 0; i < take; i++) {
    frames.push({
      index: i,
      tMs: Math.round((i / fps) * 1000),
      hash: dHashFromGray(buf, i * FRAME_BYTES),
    });
  }
  return { frames, sampleCount: total, fps };
}

/**
 * Looks for `needle` as a contiguous run inside `haystack`.
 *
 * Returns the best alignment found, or null. `matchRatio` is the share of the
 * needle's frames that matched at that alignment; requiring every frame to match
 * would make the result brittle against re-encoding, so a high threshold on the
 * ratio is used instead of demanding perfection.
 *
 * Frames that are visually featureless — a fade to black, a blank title card —
 * match almost anything, so they are excluded from the evidence rather than
 * being allowed to inflate the score.
 */
function findSubsequence(needle, haystack, {
  maxFrameDistance = 8,
  minMatchRatio = 0.8,
  minFrames = 4,
} = {}) {
  const n = needle.length;
  const h = haystack.length;
  if (n < minFrames || h < n) return null;

  const informative = (f) => {
    // A hash of all-zero or all-one bits carries no structure.
    const ones = hamming(f.hash, 0n);
    return ones > 6 && ones < 58;
  };
  const usable = needle.map(informative);
  const usableCount = usable.filter(Boolean).length;
  if (usableCount < minFrames) return null;

  let best = null;
  for (let offset = 0; offset + n <= h; offset++) {
    let matched = 0;
    let distanceSum = 0;
    let misses = 0;
    const allowedMisses = Math.floor(usableCount * (1 - minMatchRatio));

    for (let i = 0; i < n; i++) {
      if (!usable[i]) continue;
      const d = hamming(needle[i].hash, haystack[offset + i].hash);
      if (d <= maxFrameDistance) { matched++; distanceSum += d; }
      else if (++misses > allowedMisses) break;
    }

    const ratio = matched / usableCount;
    if (ratio >= minMatchRatio && (!best || ratio > best.matchRatio)) {
      best = {
        offset,
        matchedFrames: matched,
        comparedFrames: usableCount,
        matchRatio: ratio,
        meanDistance: matched ? distanceSum / matched : null,
      };
    }
  }
  return best;
}

/** Whole-video similarity, for re-encodes of the same content. */
function compareCoarse(a, b, { maxFrameDistance = 8 } = {}) {
  const n = Math.min(a.length, b.length);
  if (n < 6) return null;
  let matched = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const d = hamming(a[i].hash, b[i].hash);
    if (d <= maxFrameDistance) { matched++; sum += d; }
  }
  return {
    comparedFrames: n,
    matchedFrames: matched,
    matchRatio: matched / n,
    meanDistance: matched ? sum / matched : null,
  };
}

/**
 * Decides which of two videos to keep.
 *
 * Quality first, and never the shorter one: a clip is a subset of its source, so
 * proposing the source for removal would destroy footage. Pixel count outranks
 * bitrate, which outranks file size.
 */
function betterOf(a, b) {
  const pixels = (v) => (v.width || 0) * (v.height || 0);
  if (Math.abs((a.durationSec || 0) - (b.durationSec || 0)) > 1) {
    return (a.durationSec || 0) > (b.durationSec || 0) ? a : b;
  }
  if (pixels(a) !== pixels(b)) return pixels(a) > pixels(b) ? a : b;
  if ((a.bitRate || 0) !== (b.bitRate || 0)) return (a.bitRate || 0) > (b.bitRate || 0) ? a : b;
  return (a.sizeBytes || 0) >= (b.sizeBytes || 0) ? a : b;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

module.exports = {
  VIDEO_EXTS,
  FRAME_W, FRAME_H, FRAME_BYTES,
  detectTools,
  probe,
  dHashFromGray,
  hamming,
  coarseSignature,
  denseSignature,
  findSubsequence,
  compareCoarse,
  betterOf,
  fmtTime,
};
