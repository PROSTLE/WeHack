// Duplicate-detection tests against real files on disk.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Index } = require('../src/main/db.js');
const { ScanController } = require('../src/main/scanners/composition.js');
const {
  findExactDuplicates, findSimilarText, simHash, hamming64, duplicatesToPlanEntries,
} = require('../src/main/scanners/duplicates.js');
const { Plan, CATEGORY, ACTION, CONFIDENCE } = require('../src/main/safety/plan.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

(async () => {
  const work = path.join(__dirname, '.tmp-dup');
  const dbPath = path.join(__dirname, '.tmp-dup.db');
  await fsp.rm(work, { recursive: true, force: true });
  for (const s of ['', '-wal', '-shm']) await fsp.rm(dbPath + s, { force: true });
  await fsp.mkdir(path.join(work, 'sub'), { recursive: true });

  // Two byte-identical copies of the same 200 KB payload.
  const payload = crypto.randomBytes(200 * 1024);
  await fsp.writeFile(path.join(work, 'original.bin'), payload);
  await fsp.writeFile(path.join(work, 'sub', 'copy.bin'), payload);

  // A decoy: same size, same first 4 KB, but different in the middle.
  // This is the case the head/tail sample is supposed to let through to the
  // full hash, and the full hash is supposed to reject.
  const decoy = Buffer.from(payload);
  decoy[100 * 1024] ^= 0xff;
  await fsp.writeFile(path.join(work, 'decoy.bin'), decoy);

  // Same size but different content throughout — must be rejected by the sample.
  await fsp.writeFile(path.join(work, 'unrelated.bin'), crypto.randomBytes(200 * 1024));

  // A small file below the threshold, duplicated.
  await fsp.writeFile(path.join(work, 'tiny-a.txt'), 'x');
  await fsp.writeFile(path.join(work, 'tiny-b.txt'), 'x');

  const index = new Index(dbPath).open();
  const scan = await new ScanController(index).start(work, () => {});
  ok('fixture indexed', scan.fileCount === 6, `${scan.fileCount}`);

  // ── tier 1 ──
  const { groups, stats } = await findExactDuplicates(index, scan.id, { minBytes: 4096 });
  console.log('   tier-1 stats:', JSON.stringify(stats));

  ok('exactly one exact-duplicate group found', groups.length === 1, `${groups.length}`);
  const g = groups[0];
  ok('group has the two identical files', g.members.length === 2, `${g.members.length}`);
  const names = g.members.map((m) => path.basename(m.path)).sort();
  ok('group members are original.bin and copy.bin',
    names.join(',') === 'copy.bin,original.bin', names.join(','));
  ok('decoy with one flipped byte is excluded',
    !g.members.some((m) => m.path.includes('decoy')));
  ok('unrelated same-size file is excluded',
    !g.members.some((m) => m.path.includes('unrelated')));
  ok('wasted bytes counts all but one copy',
    g.wastedBytes === 200 * 1024, `${g.wastedBytes}`);
  ok('signature is a sha-256 hex digest', /^[0-9a-f]{64}$/.test(g.signature));
  ok('signature matches the real file hash',
    g.signature === crypto.createHash('sha256').update(payload).digest('hex'));
  ok('sub-threshold tiny files were never considered',
    !JSON.stringify(groups).includes('tiny-'));

  // Cost discipline: 4 same-size candidates, but only the 3 that survived the
  // head/tail sample should have been fully hashed.
  ok('cheap sample ran on every candidate', stats.sampled === 4, `${stats.sampled}`);
  ok('full hash ran only on sample survivors, not all candidates',
    stats.fullyHashed < stats.sampled, `hashed ${stats.fullyHashed} of ${stats.sampled} sampled`);

  // ── plan construction ──
  const specs = duplicatesToPlanEntries(groups, { Plan, CATEGORY, ACTION, CONFIDENCE });
  ok('plan keeps one copy and proposes the rest', specs.length === 1, `${specs.length}`);
  const plan = new Plan({ source: 'duplicates' });
  const e = plan.add(specs[0]);
  ok('exact duplicate is categorised regenerable', e.category === CATEGORY.REGENERABLE);
  ok('exact duplicate is high confidence', e.confidence === CONFIDENCE.HIGH);
  ok('evidence names the kept file and the shared hash',
    e.evidence.includes(g.signature) && e.evidence.includes('Byte-identical'));
  ok('evidence is specific enough to verify by hand',
    e.evidence.includes('original.bin') || e.evidence.includes('copy.bin'));

  // ── SimHash unit behaviour ──
  console.log('\n   -- simhash --');
  const base = 'the quick brown fox jumps over the lazy dog and then keeps running through the field';
  const edited = 'the quick brown fox jumps over the lazy dog and then keeps running through the meadow';
  const different = 'financial results for the fourth quarter showed revenue growth across all regions';
  const hb = simHash(base), he = simHash(edited), hd = simHash(different);
  const dEdit = hamming64(hb, he), dDiff = hamming64(hb, hd);
  console.log(`   distance(base, one-word edit) = ${dEdit}`);
  console.log(`   distance(base, unrelated)     = ${dDiff}`);
  ok('identical text hashes identically', hamming64(hb, simHash(base)) === 0);
  ok('a one-word edit stays close', dEdit < dDiff, `${dEdit} < ${dDiff}`);
  ok('unrelated text is far away', dDiff > 10, `${dDiff}`);
  ok('too-short text yields no hash', simHash('hi') === null);

  // ── tier 3 on real files ──
  const doc = 'Quarterly report. '.repeat(200) + 'Revenue increased across every region this period.';
  await fsp.writeFile(path.join(work, 'report-v1.txt'), doc);
  await fsp.writeFile(path.join(work, 'report-v2.txt'), doc + ' Minor addendum appended here.');
  await fsp.writeFile(path.join(work, 'shopping.txt'), 'milk eggs bread coffee '.repeat(200));
  const scan2 = await new ScanController(index).start(work, () => {});
  const textOut = await findSimilarText(index, scan2.id, { minBytes: 1024 });
  console.log('   tier-3 stats:', JSON.stringify(textOut.stats));
  ok('near-identical documents grouped', textOut.groups.length === 1, `${textOut.groups.length}`);
  if (textOut.groups.length === 1) {
    const tnames = textOut.groups[0].members.map((m) => path.basename(m.path)).sort();
    ok('the two report versions matched', tnames.join(',') === 'report-v1.txt,report-v2.txt', tnames.join(','));
    ok('unrelated document excluded', !tnames.includes('shopping.txt'));
    const tspecs = duplicatesToPlanEntries(textOut.groups, { Plan, CATEGORY, ACTION, CONFIDENCE });
    const tplan = new Plan({ source: 'duplicates' });
    const te = tplan.add(tspecs[0]);
    ok('near-duplicate is categorised user-data', te.category === CATEGORY.USER_DATA);
    ok('near-duplicate is NOT pre-selected', te.selected === false);
    ok('evidence states the files are not byte-identical',
      te.evidence.includes('NOT byte-identical'));
    ok('evidence states the measured bit distance', /\d+ of 64 bits/.test(te.evidence));
  }

  index.close();
  await fsp.rm(work, { recursive: true, force: true });
  for (const s of ['', '-wal', '-shm']) await fsp.rm(dbPath + s, { force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
