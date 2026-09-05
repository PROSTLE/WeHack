// Walker + index integration test, run against a real directory tree on disk.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { Index } = require('../src/main/db.js');
const { ScanController } = require('../src/main/scanners/composition.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

(async () => {
  // Deliberately NOT under os.tmpdir(): that path contains a segment named
  // "Temp", which the classifier correctly treats as regenerable, and every
  // file in the fixture would be categorised as cache.
  const work = path.join(__dirname, '.tmp-scan');
  const dbPath = path.join(__dirname, '.tmp-scan.db');
  await fsp.rm(work, { recursive: true, force: true });
  for (const s of ['', '-wal', '-shm']) await fsp.rm(dbPath + s, { force: true });

  // Build a tree with known byte totals so the scan can be checked against
  // arithmetic rather than against itself.
  await fsp.mkdir(path.join(work, 'Documents'), { recursive: true });
  await fsp.mkdir(path.join(work, 'Pictures'), { recursive: true });
  await fsp.mkdir(path.join(work, 'AppData', 'Cache'), { recursive: true });
  await fsp.mkdir(path.join(work, 'deep', 'a', 'b', 'c'), { recursive: true });

  const files = [
    ['Documents/report.pdf', 10000],
    ['Documents/notes.md', 500],
    ['Documents/sheet.xlsx', 2500],
    ['Pictures/holiday.jpg', 40000],
    ['Pictures/screenshot.png', 15000],
    ['AppData/Cache/blob.tmp', 30000],
    ['AppData/Cache/entries.log', 5000],
    ['deep/a/b/c/buried.txt', 100],
    ['root-level.zip', 8000],
  ];
  let expectedBytes = 0;
  for (const [rel, size] of files) {
    await fsp.writeFile(path.join(work, rel), Buffer.alloc(size, 0x41));
    expectedBytes += size;
  }

  const index = new Index(dbPath).open();
  const ctl = new ScanController(index);

  let progressCalls = 0;
  let sawIncreasingCount = false;
  let lastCount = -1;
  const t0 = Date.now();
  const scan = await ctl.start(work, (p) => {
    progressCalls++;
    if (p.fileCount >= lastCount) sawIncreasingCount = true;
    lastCount = p.fileCount;
  });
  const elapsed = Date.now() - t0;

  console.log(`   scanned in ${elapsed}ms, ${progressCalls} progress events`);

  ok('scan completed', scan.status === 'complete', scan.status);
  ok('file count matches the tree', scan.fileCount === files.length, `${scan.fileCount} vs ${files.length}`);
  ok('byte total matches arithmetic', scan.totalBytes === expectedBytes,
    `${scan.totalBytes} vs ${expectedBytes}`);
  // Documents, Pictures, AppData, AppData/Cache, deep, deep/a, deep/a/b, deep/a/b/c
  ok('directory count correct', scan.dirCount === 8, `${scan.dirCount}`);
  ok('progress was reported', progressCalls > 0 && sawIncreasingCount);

  // --- classification ---
  const cats = index.categoryTotals(scan.id);
  const byCat = Object.fromEntries(cats.map((c) => [c.category, c.bytes]));
  console.log('   categories:', JSON.stringify(byCat));
  ok('media category holds the images', byCat.media === 55000, `${byCat.media}`);
  ok('documents category holds docs+code', byCat.documents === 13100, `${byCat.documents}`);
  ok('cache category detected by folder name, not extension',
    byCat.cache === 35000, `${byCat.cache}`);
  ok('archive counted as application payload', byCat.applications === 8000, `${byCat.applications}`);
  ok('category bytes sum to the scan total',
    cats.reduce((n, c) => n + c.bytes, 0) === expectedBytes);

  // The .log file inside Cache/ must be cache by location; a .log elsewhere is
  // cache by extension. Both land in cache, but for stated reasons.
  const logRow = index.largestFiles(scan.id, { limit: 500 })
    .find((f) => f.name === 'entries.log');
  ok('cache file classified as cache', logRow.category === 'cache');

  // --- rollup ---
  const kids = index.childrenWithRollup(scan.id, work);
  const kidMap = Object.fromEntries(kids.map((k) => [k.name, k.bytes]));
  console.log('   children rollup:', JSON.stringify(kidMap));
  ok('directory rollup sums descendants', kidMap.Documents === 13000, `${kidMap.Documents}`);
  ok('nested rollup reaches the deepest file', kidMap.deep === 100, `${kidMap.deep}`);
  ok('rollup children sum to the total',
    kids.reduce((n, k) => n + k.bytes, 0) === expectedBytes);
  ok('rollup is ordered largest first', kids[0].bytes >= kids[kids.length - 1].bytes);

  // --- queries ---
  const largest = index.largestFiles(scan.id, { limit: 3 });
  ok('largest files ordered by size', largest[0].name === 'holiday.jpg' && largest[0].size === 40000);
  ok('pagination returns distinct rows',
    index.largestFiles(scan.id, { limit: 3, offset: 3 })[0].name !== largest[0].name);
  const counted = index.countFiles(scan.id);
  ok('countFiles agrees with the scan record',
    counted.n === files.length && counted.bytes === expectedBytes);
  const underDocs = index.countFiles(scan.id, { under: path.join(work, 'Documents') });
  ok('subtree filter counts only that subtree', underDocs.n === 3 && underDocs.bytes === 13000);

  // --- size-collision candidates for the duplicate scanner ---
  await fsp.writeFile(path.join(work, 'Documents', 'copy.pdf'), Buffer.alloc(10000, 0x41));
  const scan2 = await ctl.start(work, () => {});
  const groups = index.sizeCollisionGroups(scan2.id, 4096);
  ok('size collision detected for identical-size files',
    groups.some((g) => g.size === 10000 && g.n === 2), JSON.stringify(groups.slice(0, 2)));

  // --- scan history ---
  ok('two scans recorded', index.listScans().length === 2);
  ok('latest complete scan is the newer one', index.latestCompleteScan().id === scan2.id);

  // --- cancellation ---
  const cancelCtl = new ScanController(index);
  const big = path.join(work, 'many');
  await fsp.mkdir(big, { recursive: true });
  for (let i = 0; i < 400; i++) await fsp.writeFile(path.join(big, `f${i}.bin`), Buffer.alloc(64));
  const runP = cancelCtl.start(work, () => { cancelCtl.cancel(); });
  const cancelled = await runP;
  ok('cancelled scan is recorded as cancelled', cancelled.status === 'cancelled', cancelled.status);
  ok('controller is free after cancellation', cancelCtl.isRunning === false);

  index.close();
  await fsp.rm(work, { recursive: true, force: true });
  for (const s of ['', '-wal', '-shm']) await fsp.rm(dbPath + s, { force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
