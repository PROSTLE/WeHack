// Tier-2 perceptual image hashing. Must run under Electron, because decoding
// uses nativeImage rather than an image library.
//   env -u ELECTRON_RUN_AS_NODE npx electron test/images.electron.js
const { app, nativeImage } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { makePng } = require('./make-png.js');
const { Index } = require('../src/main/db.js');
const { ScanController } = require('../src/main/scanners/composition.js');
const {
  findSimilarImages, dHashFromBitmap, hamming64, duplicatesToPlanEntries,
} = require('../src/main/scanners/duplicates.js');
const { Plan, CATEGORY, ACTION, CONFIDENCE } = require('../src/main/safety/plan.js');

let pass = 0, fail = 0;
const log = [];
function ok(name, cond, extra = '') {
  log.push((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

function hashOf(buf) {
  const img = nativeImage.createFromBuffer(buf);
  const small = img.resize({ width: 9, height: 8, quality: 'good' });
  const s = small.getSize();
  return dHashFromBitmap(small.toBitmap(), s.width, s.height);
}

app.whenReady().then(async () => {
  const work = path.join(__dirname, '.tmp-img');
  const dbPath = path.join(__dirname, '.tmp-img.db');
  await fsp.rm(work, { recursive: true, force: true });
  for (const s of ['', '-wal', '-shm']) await fsp.rm(dbPath + s, { force: true });
  await fsp.mkdir(work, { recursive: true });

  // A recognisable "photo": smooth diagonal gradient with a bright square.
  const photo = (w, h) => makePng(w, h, (x, y) => {
    const fx = x / w, fy = y / h;
    const inBox = fx > 0.55 && fx < 0.8 && fy > 0.2 && fy < 0.5;
    if (inBox) return [250, 240, 200];
    return [Math.floor(40 + 180 * fx), Math.floor(30 + 160 * fy), Math.floor(90 + 60 * (1 - fx))];
  });

  // A genuinely different image: vertical bars.
  const bars = (w, h) => makePng(w, h, (x) =>
    (Math.floor(x / 8) % 2 === 0) ? [20, 20, 30] : [230, 220, 210]);

  console.log('-- dHash behaviour --');
  const big = photo(320, 240);
  const smallSameImage = photo(160, 120);      // same picture, half resolution
  const different = bars(320, 240);

  const hBig = hashOf(big);
  const hSmall = hashOf(smallSameImage);
  const hDiff = hashOf(different);
  const dScale = hamming64(hBig, hSmall);
  const dOther = hamming64(hBig, hDiff);
  log.push(`   distance(320x240, same image at 160x120) = ${dScale}`);
  log.push(`   distance(320x240, different image)       = ${dOther}`);

  ok('identical bytes hash identically', hamming64(hBig, hashOf(big)) === 0);
  ok('same image at half resolution stays close', dScale <= 6, `${dScale} bits`);
  // What matters is not an arbitrary bit count but that the distance sits well
  // clear of the clustering threshold the scanner actually uses (6 bits).
  const THRESHOLD = 6;
  ok('rescaled copy falls inside the clustering threshold',
    dScale <= THRESHOLD, `${dScale} <= ${THRESHOLD}`);
  ok('a different image falls well outside the threshold',
    dOther > THRESHOLD * 2, `${dOther} > ${THRESHOLD * 2}`);
  ok('the two cases are clearly separated', dOther > dScale * 2, `${dScale} vs ${dOther}`);

  console.log('-- scanner integration --');
  await fsp.writeFile(path.join(work, 'holiday-full.png'), big);
  await fsp.writeFile(path.join(work, 'holiday-thumb.png'), smallSameImage);
  await fsp.writeFile(path.join(work, 'barcode.png'), different);

  const index = new Index(dbPath).open();
  const scan = await new ScanController(index).start(work, () => {});
  const { groups, stats } = await findSimilarImages(index, scan.id, nativeImage, { minBytes: 100 });
  log.push(`   stats: ${JSON.stringify(stats)}`);

  ok('all three images decoded', stats.decoded === 3 && stats.failed === 0);
  ok('one near-duplicate group found', groups.length === 1, `${groups.length}`);
  if (groups.length === 1) {
    const names = groups[0].members.map((m) => path.basename(m.path)).sort();
    ok('the two versions of the same photo grouped',
      names.join(',') === 'holiday-full.png,holiday-thumb.png', names.join(','));
    ok('the unrelated image is excluded', !names.includes('barcode.png'));
    ok('the larger copy is kept, the smaller proposed',
      groups[0].members[0].size > groups[0].members[1].size);

    const specs = duplicatesToPlanEntries(groups, { Plan, CATEGORY, ACTION, CONFIDENCE });
    const plan = new Plan({ source: 'duplicates' });
    const e = plan.add(specs[0]);
    ok('image near-duplicate is user-data', e.category === CATEGORY.USER_DATA);
    ok('image near-duplicate is NOT pre-selected', e.selected === false);
    ok('evidence gives the measured bit distance', /\d+ of 64 bits/.test(e.evidence));
    ok('evidence warns they are not byte-identical', e.evidence.includes('NOT byte-identical'));
    ok('evidence does not claim this is AI',
      !/\bAI\b|\bmodel\b|neural/i.test(e.evidence + e.reason));
  }

  index.close();
  await fsp.rm(work, { recursive: true, force: true });
  for (const s of ['', '-wal', '-shm']) await fsp.rm(dbPath + s, { force: true });

  console.log(log.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('THREW:', e); app.exit(1); });
