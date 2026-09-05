// Video sub-clip detection, tested against real video on this machine.
//
// The test cuts a genuine excerpt out of a real file, re-encodes it at a
// different resolution and bitrate so it shares no bytes with its source, and
// then asks the matcher to locate it. That is the case whole-file hashing and
// whole-video perceptual hashing both miss entirely.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const V = require('../src/main/scanners/video.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

/** Smallest real video at least `minSec` long, so the test stays quick. */
async function pickSource() {
  const roots = [
    path.join(os.homedir(), 'Videos'),
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop'),
  ];
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (!V.VIDEO_EXTS.includes(ext)) continue;
      const full = path.join(root, e.name);
      try {
        const st = fs.statSync(full);
        if (st.size > 5 * 1024 * 1024) found.push({ path: full, size: st.size });
      } catch { /* skip */ }
    }
  }
  found.sort((a, b) => a.size - b.size);
  for (const f of found) {
    try {
      const meta = await V.probe(f.path);
      if (meta.durationSec >= 90) return { ...f, meta };
    } catch { /* unreadable; try the next */ }
  }
  return null;
}

(async () => {
  const tools = await V.detectTools();
  console.log(`ffmpeg:  ${tools.ffmpeg || 'not found'}`);
  console.log(`ffprobe: ${tools.ffprobe || 'not found'}`);
  if (!tools.available) {
    console.log('\n  SKIP  ffmpeg/ffprobe unavailable; video analysis cannot run.');
    console.log('        This is reported to the user rather than returning "no duplicates".');
    process.exit(0);
  }

  console.log('\n-- hashing primitives --');
  const flat = Buffer.alloc(V.FRAME_BYTES, 128);
  ok('a featureless frame hashes to zero', V.dHashFromGray(flat, 0) === 0n);
  const ramp = Buffer.alloc(V.FRAME_BYTES);
  // Descending across each row, so the left>right comparison actually fires.
  for (let i = 0; i < V.FRAME_BYTES; i++) ramp[i] = 224 - (i % V.FRAME_W) * 28;
  const rampHash = V.dHashFromGray(ramp, 0);
  ok('a structured frame hashes to non-zero', rampHash !== 0n);
  ok('identical frames have distance 0', V.hamming(rampHash, V.dHashFromGray(ramp, 0)) === 0);

  const src = await pickSource();
  if (!src) {
    console.log('\n  SKIP  no video of at least 90 s found to test against.');
    process.exit(0);
  }
  console.log(`\nsource: ${path.basename(src.path)}`);
  console.log(`        ${(src.size / 1048576).toFixed(0)} MB, ${src.meta.durationSec.toFixed(0)} s, ` +
              `${src.meta.width}x${src.meta.height} ${src.meta.codec}`);

  const work = path.join(__dirname, '.tmp-video');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  // A real excerpt: 40 s from a third of the way in, re-encoded at half
  // resolution and a different bitrate, so it shares no bytes with the source.
  const CUT_START = Math.floor(src.meta.durationSec / 3);
  const CUT_LEN = 40;
  const clip = path.join(work, 'excerpt.mp4');
  const halfW = Math.max(2, Math.floor(src.meta.width / 2 / 2) * 2);
  const halfH = Math.max(2, Math.floor(src.meta.height / 2 / 2) * 2);

  console.log(`\n-- building a real excerpt: ${CUT_LEN}s from ${CUT_START}s, re-encoded at ${halfW}x${halfH} --`);
  const t0 = Date.now();
  await execFileP('ffmpeg', [
    '-v', 'error', '-y',
    '-ss', String(CUT_START), '-i', src.path,
    '-t', String(CUT_LEN),
    '-vf', `scale=${halfW}:${halfH}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-an', clip,
  ], { timeout: 300000, windowsHide: true });
  console.log(`   encoded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  ok('the excerpt was created', fs.existsSync(clip));
  const clipMeta = await V.probe(clip);
  ok('the excerpt is a different resolution', clipMeta.width !== src.meta.width,
    `${clipMeta.width}x${clipMeta.height} vs ${src.meta.width}x${src.meta.height}`);

  // Prove the excerpt is invisible to the techniques we already had.
  const crypto = require('crypto');
  const sha = (f) => crypto.createHash('sha256')
    .update(fs.readFileSync(f, { encoding: null }).subarray(0, 8 << 20)).digest('hex');
  ok('whole-file hashing does NOT relate them', sha(clip) !== sha(src.path));
  ok('their byte sizes differ',
    fs.statSync(clip).size !== fs.statSync(src.path).size);

  console.log('\n-- fingerprinting --');
  const tClip = Date.now();
  const clipSig = await V.denseSignature(clip);
  const clipMs = Date.now() - tClip;
  console.log(`   excerpt: ${clipSig.sampleCount} samples (1/s) in ${clipMs} ms`);
  ok('the excerpt yielded samples', clipSig.frames.length >= 4, `${clipSig.frames.length}`);

  const tSrc = Date.now();
  const srcSig = await V.denseSignature(src.path);
  const srcSecs = (Date.now() - tSrc) / 1000;
  const gb = src.size / 1073741824;
  console.log(`   source:  ${srcSig.sampleCount} samples (1/s) in ${srcSecs.toFixed(1)}s ` +
              `(${(srcSecs / Math.max(gb, 0.001)).toFixed(1)} s/GB)`);
  ok('the source yielded samples', srcSig.frames.length > clipSig.frames.length);

  console.log('\n-- sub-clip detection --');
  const match = V.findSubsequence(clipSig.frames, srcSig.frames);
  ok('the excerpt was located inside its source', match !== null,
    match ? `offset frame ${match.offset}` : 'no match');

  if (match) {
    console.log(`   matched ${match.matchedFrames}/${match.comparedFrames} frames ` +
                `(${(match.matchRatio * 100).toFixed(0)}%), mean distance ` +
                `${match.meanDistance.toFixed(1)}/64 bits`);
    const impliedSec = match.offset;   // 1 fps grid: frame index == seconds
    console.log(`   implied position ~${impliedSec.toFixed(0)}s; the cut was made at ${CUT_START}s`);
    ok('the match ratio is high', match.matchRatio >= 0.8,
      `${(match.matchRatio * 100).toFixed(0)}%`);
    ok('the located position is near the true cut point',
      Math.abs(impliedSec - CUT_START) <= 3,
      `off by ${Math.abs(impliedSec - CUT_START).toFixed(0)}s`);
  }

  console.log('\n-- it must not match unrelated footage --');
  // Reversing the excerpt keeps every frame but destroys the ordering, so any
  // match found here would mean the matcher is not really testing sequence.
  const shuffled = [...clipSig.frames].reverse();
  const falseMatch = V.findSubsequence(shuffled, srcSig.frames);
  ok('a re-ordered excerpt does not match', falseMatch === null || falseMatch.matchRatio < 0.8,
    falseMatch ? `${(falseMatch.matchRatio * 100).toFixed(0)}%` : 'no match');

  console.log('\n-- which copy is kept --');
  const keep = V.betterOf(
    { ...src.meta, path: src.path },
    { ...clipMeta, path: clip }
  );
  ok('the longer source is kept, not the excerpt', keep.path === src.path,
    path.basename(keep.path));

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e.message); process.exit(1); });
