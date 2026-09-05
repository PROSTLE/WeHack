// Document and video duplicate detection, end to end against real files.
//
// The fixture is built from the machine's own documents and video, then a known
// duplicate and a known excerpt are planted so the scanners have something they
// must find. Nothing is asserted about files the test did not create.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

const { Index } = require('../src/main/db.js');
const { ScanController } = require('../src/main/scanners/composition.js');
const dupes = require('../src/main/scanners/duplicates.js');
const content = require('../src/main/scanners/content-dupes.js');
const video = require('../src/main/scanners/video.js');
const { Plan, CATEGORY, ACTION, CONFIDENCE } = require('../src/main/safety/plan.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

/**
 * Real files under home matching a predicate, returned smallest first.
 *
 * Collecting several candidates matters: the first video found may be too short
 * or unreadable, and stopping there made the video half of this test skip
 * silently on a machine that did have suitable footage.
 */
function findFile(pred, dir = os.homedir(), depth = 0, found = []) {
  if (depth > 5 || found.length >= 40) return depth === 0 ? finish(found) : found;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return depth === 0 ? finish(found) : found; }
  for (const e of entries) {
    if (e.name.startsWith('$') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFile(pred, p, depth + 1, found);
    else if (pred(p)) {
      try {
        const st = fs.statSync(p);
        if (st.size > 20000) found.push({ p, size: st.size });
      } catch { /* unreadable */ }
    }
    if (found.length >= 40) break;
  }
  return depth === 0 ? finish(found) : found;
}

function finish(found) {
  return found.sort((a, b) => a.size - b.size).map((x) => x.p);
}

(async () => {
  const work = path.join(__dirname, '.tmp-content');
  const dbPath = path.join(__dirname, '.tmp-content.db');
  await fsp.rm(work, { recursive: true, force: true });
  for (const s of ['', '-wal', '-shm']) await fsp.rm(dbPath + s, { force: true });
  await fsp.mkdir(path.join(work, 'copies'), { recursive: true });

  // ── documents ─────────────────────────────────────────────────────────────
  console.log('\n-- documents --');
  // Pick a PDF that actually yields text. Many real PDFs are scanned page
  // images with no text layer at all, and one of those makes a useless fixture
  // — the scanner would correctly find nothing and the test would look broken.
  const { extractText } = require('../src/main/classify/extract.js');
  let srcPdf = null;
  for (const c of findFile((p) => /\.pdf$/i.test(p)).slice(0, 30)) {
    try {
      const r = await extractText(c);
      if (r.ok && r.chars > 800) { srcPdf = c; break; }
    } catch { /* try the next */ }
  }
  const srcDocx = findFile((p) => /\.docx$/i.test(p))[0];
  if (srcPdf) console.log(`   using PDF: ${path.basename(srcPdf)}`);

  if (!srcPdf) {
    console.log('  SKIP  no PDF available to test with');
  } else {
    // A real duplicate: the same document filed under a different name.
    await fsp.copyFile(srcPdf, path.join(work, 'report.pdf'));
    await fsp.copyFile(srcPdf, path.join(work, 'copies', 'report-final-v2.pdf'));
    if (srcDocx) await fsp.copyFile(srcDocx, path.join(work, 'notes.docx'));

    // An unrelated document, which must NOT be grouped with them.
    await fsp.writeFile(path.join(work, 'unrelated.txt'),
      'shopping list milk eggs bread coffee sugar flour butter cheese '.repeat(60));

    const index = new Index(dbPath).open();
    const scan = await new ScanController(index).start(work, () => {});
    ok('fixture indexed', scan.fileCount >= 3, `${scan.fileCount} files`);

    const t0 = Date.now();
    const r1 = await content.findSimilarDocuments(index, scan.id,
      { simHash: dupes.simHash, hamming64: dupes.hamming64 }, { minBytes: 1000 });
    const firstMs = Date.now() - t0;
    console.log('   stats:', JSON.stringify(r1.stats.byFormat));

    const pdfGroup = r1.groups.find((g) =>
      g.members.every((m) => /\.pdf$/i.test(m.path)));
    ok('the renamed PDF copy was found', !!pdfGroup,
      pdfGroup ? `${pdfGroup.members.length} members` : 'no PDF group');
    if (pdfGroup) {
      const names = pdfGroup.members.map((m) => path.basename(m.path)).sort();
      ok('both copies are in the group, despite different names',
        names.join(',') === 'report-final-v2.pdf,report.pdf', names.join(','));
      ok('the group records how the text was read',
        pdfGroup.members.every((m) => typeof m.method === 'string' && m.method.length > 0),
        pdfGroup.members[0].method);
      ok('character counts were recorded',
        pdfGroup.members.every((m) => m.chars > 0));
    }
    ok('the unrelated text file was not grouped in',
      !r1.groups.some((g) => g.members.some((m) => /unrelated/.test(m.path))));

    // The cache is the whole reason a rescan is cheap; prove it is used.
    const t1 = Date.now();
    const r2 = await content.findSimilarDocuments(index, scan.id,
      { simHash: dupes.simHash, hamming64: dupes.hamming64 }, { minBytes: 1000 });
    const secondMs = Date.now() - t1;
    console.log(`   first pass ${firstMs} ms, cached pass ${secondMs} ms`);
    ok('second pass came from the cache',
      r2.stats.fromCache > 0 && r2.stats.extracted === 0,
      `fromCache=${r2.stats.fromCache} extracted=${r2.stats.extracted}`);
    ok('cached pass finds the same groups', r2.groups.length === r1.groups.length);

    // Plan entries.
    const specs = content.contentDupesToPlanEntries(r1.groups, { ACTION, CATEGORY, CONFIDENCE });
    if (specs.length) {
      const plan = new Plan({ source: 'test' });
      const e = plan.add(specs[0]);
      ok('document duplicates are never pre-selected', e.selected === false);
      ok('they are categorised as user data', e.category === CATEGORY.USER_DATA);
      ok('evidence states they are not byte-identical',
        e.evidence.includes('NOT byte-identical'));
      ok('evidence names the extraction method and bit distance',
        /\d+ of 64 bits/.test(e.evidence) && /characters/.test(e.evidence));
    }
    index.close();
  }

  // ── video ─────────────────────────────────────────────────────────────────
  console.log('\n-- video --');
  const tools = await video.detectTools();
  if (!tools.available) {
    console.log('  SKIP  ffmpeg unavailable:', tools.reason);
  } else {
    // Try each candidate in turn rather than giving up on the first unusable one.
    const candidates = findFile((p) => /\.(mp4|mov|mkv|webm|m4v)$/i.test(p));
    let usable = null;
    for (const c of candidates.slice(0, 30)) {
      try {
        const meta = await video.probe(c);
        if (meta.durationSec >= 60) { usable = { path: c, meta }; break; }
      } catch { /* try the next candidate */ }
    }
    if (usable) {
      console.log(`   source: ${path.basename(usable.path)} ` +
        `(${usable.meta.durationSec.toFixed(0)}s, ${usable.meta.width}x${usable.meta.height})`);
    }

    if (!usable) {
      console.log('  SKIP  no video of at least 60 s found');
    } else {
      const vdir = path.join(work, 'video');
      await fsp.mkdir(vdir, { recursive: true });
      const CUT_AT = 30, CUT_LEN = 25;

      // A short source, so the dense pass stays quick.
      const base = path.join(vdir, 'original.mp4');
      await execFileP('ffmpeg', ['-v', 'error', '-y', '-i', usable.path,
        '-t', '75', '-vf', 'scale=480:-2', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-crf', '32', '-an', base], { timeout: 600000, windowsHide: true });

      // An excerpt of it, re-encoded smaller: shares no bytes with the original.
      const clip = path.join(vdir, 'clip-we-forgot-to-delete.mp4');
      await execFileP('ffmpeg', ['-v', 'error', '-y', '-ss', String(CUT_AT), '-i', base,
        '-t', String(CUT_LEN), '-vf', 'scale=320:-2', '-c:v', 'libx264',
        '-preset', 'ultrafast', '-crf', '34', '-an', clip],
        { timeout: 300000, windowsHide: true });

      ok('fixture videos created', fs.existsSync(base) && fs.existsSync(clip));

      const index2 = new Index(dbPath).open();
      const scan2 = await new ScanController(index2).start(vdir, () => {});
      const t0 = Date.now();
      const rv = await content.findVideoDuplicates(index2, scan2.id, { minBytes: 1000 });
      console.log(`   scanned in ${Date.now() - t0} ms; stats: ${JSON.stringify(rv.stats)}`);

      const sub = rv.groups.find((g) => g.tier === 'video-subclip');
      ok('the excerpt was identified as part of the original', !!sub,
        sub ? `starts ${sub.subclip.startLabel}` : 'not found');

      if (sub) {
        ok('the longer original is the one kept',
          path.basename(sub.members[0].path) === 'original.mp4',
          path.basename(sub.members[0].path));
        ok('the clip is the one proposed',
          path.basename(sub.members[1].path) === 'clip-we-forgot-to-delete.mp4');
        ok('the reported start is close to where it was cut',
          Math.abs(sub.subclip.startSec - CUT_AT) <= 3,
          `${sub.subclip.startSec}s vs ${CUT_AT}s`);
        ok('the match ratio is high', sub.subclip.matchRatio >= 0.8,
          `${(sub.subclip.matchRatio * 100).toFixed(0)}%`);

        const vspecs = content.contentDupesToPlanEntries([sub], { ACTION, CATEGORY, CONFIDENCE });
        const vplan = new Plan({ source: 'test' });
        const ve = vplan.add(vspecs[0]);
        ok('the clip, not the source, is proposed for removal',
          path.basename(ve.path) === 'clip-we-forgot-to-delete.mp4');
        ok('the excerpt is never pre-selected', ve.selected === false);
        ok('evidence gives the timestamp inside the original',
          ve.evidence.includes(sub.subclip.startLabel));
        ok('evidence explains why the longer file is kept',
          ve.evidence.includes('removing it would lose the rest'));
      }

      // Cache check.
      const t1 = Date.now();
      const rv2 = await content.findVideoDuplicates(index2, scan2.id, { minBytes: 1000 });
      console.log(`   cached pass ${Date.now() - t1} ms`);
      ok('video fingerprints came from the cache on rescan',
        rv2.stats.fromCache > 0 && rv2.stats.probed === 0,
        `fromCache=${rv2.stats.fromCache} probed=${rv2.stats.probed}`);
      ok('cached pass finds the same groups', rv2.groups.length === rv.groups.length);
      index2.close();
    }
  }

  await fsp.rm(work, { recursive: true, force: true });
  for (const s of ['', '-wal', '-shm']) await fsp.rm(dbPath + s, { force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e.message); process.exit(1); });
