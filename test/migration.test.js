// Upgrade tests.
//
// Written after the application failed to start on the development machine: the
// real userData database had been created by version 1, whose `files` table has
// no `scanId` column. `CREATE TABLE IF NOT EXISTS` left it in place, the index
// on scanId then failed, and startup died with an unhandled rejection.
//
// Every other suite began from an empty database, which is exactly why none of
// them caught it.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Index } = require('../src/main/db.js');
const { ScanController } = require('../src/main/scanners/composition.js');
const { findExactDuplicates } = require('../src/main/scanners/duplicates.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

/** Recreates the exact version 1 schema, as found on the real machine. */
function makeV1Database(file) {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE,
      name TEXT,
      isDirectory BOOLEAN,
      size INTEGER,
      modified TEXT,
      created TEXT,
      accessed TEXT,
      extension TEXT,
      tags TEXT,
      type TEXT,
      sensitivity TEXT,
      isDuplicate BOOLEAN,
      starred BOOLEAN DEFAULT 0
    )
  `);
  const ins = db.prepare(
    `INSERT INTO files (path, name, isDirectory, size, type, sensitivity, starred)
     VALUES (?, ?, 0, ?, ?, ?, ?)`
  );
  ins.run('C:\\old\\a.txt', 'a.txt', 100, 'text', 'low', 1);
  ins.run('C:\\old\\b.pdf', 'b.pdf', 200, 'pdf', 'high', 0);
  db.close();
}

(async () => {
  const dbPath = path.join(__dirname, '.tmp-migrate.db');
  const work = path.join(__dirname, '.tmp-migrate-work');

  console.log('\n-- upgrading a version 1 database --');
  makeV1Database(dbPath);

  let index = null, threw = null;
  try { index = new Index(dbPath).open(); } catch (e) { threw = e.message; }
  ok('opening a v1 database does not throw', threw === null, threw || '');
  if (threw) { console.log(`\n${pass} passed, ${fail} failed\n`); process.exit(1); }

  ok('migration reports that it moved the legacy table',
    typeof index.migratedFromV1 === 'string', String(index.migratedFromV1));

  const tables = index.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  ).all().map((t) => t.name);
  ok('legacy rows are preserved, not destroyed', tables.includes('files_legacy_v1'),
    tables.join(', '));
  const legacy = index.db.prepare(`SELECT COUNT(*) AS n FROM files_legacy_v1`).get();
  ok('legacy row contents survive', legacy.n === 2, `${legacy.n} rows`);
  ok('a starred flag from v1 is still readable',
    index.db.prepare(`SELECT starred FROM files_legacy_v1 WHERE name = 'a.txt'`).get().starred === 1);

  const cols = index.db.prepare(`PRAGMA table_info(files)`).all().map((c) => c.name);
  ok('the new files table has scanId', cols.includes('scanId'));
  ok('the removed sensitivity column is gone', !cols.includes('sensitivity'));

  const version = index.db.prepare(
    `SELECT value FROM meta WHERE key = 'schema_version'`).get();
  ok('schema version is recorded', version && Number(version.value) >= 3, version?.value);
  ok('metrics table exists', index.db.prepare(
    `SELECT name FROM sqlite_master WHERE name = 'metrics_samples'`).get() !== undefined);

  console.log('\n-- the upgraded database is usable --');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(work, 'one.txt'), 'x'.repeat(500));
  fs.writeFileSync(path.join(work, 'sub', 'two.bin'), Buffer.alloc(1500));

  const scan = await new ScanController(index).start(work, () => {});
  ok('a scan completes against the upgraded database', scan.status === 'complete', scan.status);
  ok('the scan measured the fixture', scan.totalBytes === 2000, `${scan.totalBytes}`);
  ok('rollups computed', index.rollupFor(scan.id, work).bytes === 2000);
  index.recordMetricSample('boot-test', {
    uptimeSec: 10, cpuPercent: 5, memUsedBytes: 1, memTotalBytes: 2, ownBytes: 3,
  });
  ok('metric samples can be written', index.sessionCoverage('boot-test').sampleCount === 1);

  console.log('\n-- reopening is stable --');
  index.close();
  let reopened = null, threw2 = null;
  try { reopened = new Index(dbPath).open(); } catch (e) { threw2 = e.message; }
  ok('reopening an upgraded database does not throw', threw2 === null, threw2 || '');
  ok('the second open does not re-archive anything',
    reopened && reopened.migratedFromV1 === false, String(reopened?.migratedFromV1));
  ok('scan data survives the reopen',
    reopened.getScan(scan.id).totalBytes === 2000);

  const tables2 = reopened.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'files_legacy%'`
  ).all();
  ok('exactly one legacy archive exists after two opens', tables2.length === 1,
    tables2.map((t) => t.name).join(', '));
  reopened.close();

  // -- the version counter running ahead of the schema ---------------------
  //
  // The failure this reproduces shipped. A build added the cloud columns under
  // `current < 7`; a later build appended `cloudStreamed` to that same block.
  // A database that had already run block 7 never ran it again, so it carried
  // `schema_version = 9` while `files` had no `cloudStreamed` column -- and
  // then every statement naming it failed with `no such column: cloudStreamed`,
  // taking out scanning, duplicates, leftovers and describe at once.
  //
  // It was unrecoverable in the worst way: the insert used by scanning was one
  // of the failing statements, so a rescan could not repair it either. What the
  // user saw was a file manager that had quietly stopped finding anything.
  console.log('\n-- a database whose version ran ahead of its columns --');
  const aheadPath = path.join(__dirname, '.tmp-ahead.db');
  for (const sfx of ['', '-wal', '-shm']) fs.rmSync(aheadPath + sfx, { force: true });

  // Built the honest way -- let the current code create it, then take the
  // column back out and leave the version claiming it is still there. Doing it
  // this way rather than hand-writing the old schema keeps the fixture accurate
  // as the rest of the table changes.
  new Index(aheadPath).open().close();
  {
    const raw = new DatabaseSync(aheadPath);
    // Every index over the column has to go first: SQLite refuses to drop a
    // column that an index still references, partial ones included.
    raw.exec('DROP INDEX IF EXISTS idx_files_cloud');
    for (const [name] of Index.CLOUD_INDEXES) raw.exec(`DROP INDEX IF EXISTS ${name}`);
    raw.exec('ALTER TABLE files DROP COLUMN cloudStreamed');
    raw.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '9')`);
    raw.close();
  }
  {
    const raw = new DatabaseSync(aheadPath);
    const before = raw.prepare(`PRAGMA table_info(files)`).all().map((c) => c.name);
    raw.close();
    ok('the fixture really is missing the column', !before.includes('cloudStreamed'));
  }

  let healed = null, threw3 = null;
  try { healed = new Index(aheadPath).open(); } catch (e) { threw3 = e.message; }
  ok('opening it does not throw', threw3 === null, threw3 || '');

  const healedCols = healed.db.prepare(`PRAGMA table_info(files)`).all().map((c) => c.name);
  ok('the missing column is added back', healedCols.includes('cloudStreamed'));
  ok('the repair is reported rather than done silently',
    Array.isArray(healed.repairedColumns) && healed.repairedColumns.includes('cloudStreamed'),
    JSON.stringify(healed.repairedColumns));
  // The partial indexes over the cloud columns are rebuilt alongside them --
  // they were dropped with the column, and a repair that restored the column
  // but not its indexes would leave the placeholder tally scanning the table.
  const healedIdx = healed.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='files'`
  ).all().map((r) => r.name);
  ok('the indexes over the repaired column are rebuilt too',
    Index.CLOUD_INDEXES.every(([n]) => healedIdx.includes(n)), healedIdx.join(', '));

  // The point of the repair is that the operations that were dead come back.
  const healWork = path.join(__dirname, '.tmp-heal-work');
  fs.rmSync(healWork, { recursive: true, force: true });
  fs.mkdirSync(healWork, { recursive: true });
  fs.writeFileSync(path.join(healWork, 'copy-a.bin'), Buffer.alloc(6000, 7));
  fs.writeFileSync(path.join(healWork, 'copy-b.bin'), Buffer.alloc(6000, 7));
  fs.writeFileSync(path.join(healWork, 'other.bin'), Buffer.alloc(6000, 9));

  let healScan = null, threw4 = null;
  try { healScan = await new ScanController(healed).start(healWork, () => {}); }
  catch (e) { threw4 = e.message; }
  ok('scanning works again', threw4 === null && healScan && healScan.status === 'complete',
    threw4 || (healScan && healScan.status) || '');

  let dupOut = null, threw5 = null;
  try { dupOut = await findExactDuplicates(healed, healScan.id, { minBytes: 1024 }); }
  catch (e) { threw5 = e.message; }
  ok('duplicate detection works again', threw5 === null, threw5 || '');
  ok('and it finds the pair that is genuinely duplicated',
    dupOut && dupOut.groups.length === 1 && dupOut.groups[0].members.length === 2,
    dupOut ? `${dupOut.groups.length} group(s)` : '');

  healed.close();
  const reheal = new Index(aheadPath).open();
  ok('a second open repairs nothing, because nothing is left to repair',
    reheal.repairedColumns.length === 0, JSON.stringify(reheal.repairedColumns));
  reheal.close();
  for (const sfx of ['', '-wal', '-shm']) fs.rmSync(aheadPath + sfx, { force: true });
  fs.rmSync(healWork, { recursive: true, force: true });

  // -- the index that made duplicate searches take hours ---------------------
  //
  // `idx_files_cloud` was `files(scanId, cloudPlaceholder)`: every row in the
  // table, keyed on a boolean that is 0 for nearly all of them. With no
  // statistics SQLite assumed it was selective and used it for the duplicate
  // scanner's per-size lookup, walking every non-placeholder row in the scan
  // instead of seeking on `idx_files_size`.
  //
  // Measured on a real 1.2 million row index that was 562 ms per lookup, once
  // per size group -- 8.25 hours of query time for a whole-scan search before
  // a byte was hashed. What makes it worth a test rather than just a fix is
  // that it is invisible at test-fixture scale: on a few hundred rows the bad
  // plan is microseconds, so no existing suite could ever have caught it. What
  // is asserted here is therefore the plan itself, not a duration.
  console.log('\n-- the duplicate lookup uses the size index --');
  const idxPath = path.join(__dirname, '.tmp-index.db');
  for (const sfx of ['', '-wal', '-shm']) fs.rmSync(idxPath + sfx, { force: true });
  const shaped = new Index(idxPath).open();

  ok('the old whole-table cloud index is gone', shaped.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_files_cloud'`
  ).get() === undefined);

  const cloudIdx = shaped.db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='files'
      AND sql LIKE '%WHERE%'`).all();
  ok('the cloud indexes that remain are partial', cloudIdx.length === Index.CLOUD_INDEXES.length,
    cloudIdx.map((r) => r.name).join(', '));

  // The lookup findExactDuplicates makes once per size group.
  const lookupPlan = shaped.db.prepare(`EXPLAIN QUERY PLAN
    SELECT path, size, fileId FROM files
    WHERE scanId = ? AND isDirectory = 0 AND size = ?
      AND cloudPlaceholder = 0 AND cloudStreamed = 0`).all('s', 1)
    .map((r) => r.detail).join(' | ');
  ok('the per-size lookup seeks on the size index', /idx_files_size/.test(lookupPlan), lookupPlan);
  ok('and does not fall back to a partial cloud index',
    !/idx_files_(placeholder|streamed|provider)/.test(lookupPlan), lookupPlan);

  // The query the dropped index existed to serve must still be indexed.
  const tallyPlan = shaped.db.prepare(`EXPLAIN QUERY PLAN
    SELECT COUNT(*) AS n, SUM(size) AS bytes
    FROM files WHERE scanId = ? AND isDirectory = 0 AND cloudPlaceholder = 1 AND size >= ?`)
    .all('s', 0).map((r) => r.detail).join(' | ');
  ok('the placeholder tally still uses an index rather than scanning',
    /idx_files_placeholder/.test(tallyPlan), tallyPlan);
  shaped.close();

  // A database carrying the old index is repaired on open, like the columns.
  {
    const raw = new DatabaseSync(idxPath);
    for (const [name] of Index.CLOUD_INDEXES) raw.exec(`DROP INDEX IF EXISTS ${name}`);
    raw.exec('CREATE INDEX idx_files_cloud ON files(scanId, cloudPlaceholder)');
    raw.close();
  }
  const repaired = new Index(idxPath).open();
  ok('an existing database has the bad index taken away on open',
    repaired.rebuiltCloudIndex === true && repaired.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_files_cloud'`
    ).get() === undefined);
  repaired.close();
  const stable = new Index(idxPath).open();
  ok('and a second open changes nothing further', stable.rebuiltCloudIndex === false);
  stable.close();
  for (const sfx of ['', '-wal', '-shm']) fs.rmSync(idxPath + sfx, { force: true });

  console.log('\n-- a fresh database still works --');
  const freshPath = path.join(__dirname, '.tmp-fresh.db');
  for (const s of ['', '-wal', '-shm']) fs.rmSync(freshPath + s, { force: true });
  const fresh = new Index(freshPath).open();
  ok('a new database reports no legacy migration', fresh.migratedFromV1 === false);
  ok('a new database has no legacy table', fresh.db.prepare(
    `SELECT name FROM sqlite_master WHERE name LIKE 'files_legacy%'`).all().length === 0);
  // The other direction: a new install must already have every column the
  // reconciler knows about, so it never depends on the repair path to be usable.
  const freshCols = fresh.db.prepare(`PRAGMA table_info(files)`).all().map((c) => c.name);
  const missingCols = Index.FILE_COLUMNS.map(([c]) => c).filter((c) => !freshCols.includes(c));
  ok('a new database already has every expected column', missingCols.length === 0,
    missingCols.join(', '));
  ok('and needed no repair to get them', fresh.repairedColumns.length === 0,
    JSON.stringify(fresh.repairedColumns));
  fresh.close();

  for (const f of [dbPath, freshPath]) {
    for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true });
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
