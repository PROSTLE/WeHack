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

  console.log('\n-- a fresh database still works --');
  const freshPath = path.join(__dirname, '.tmp-fresh.db');
  for (const s of ['', '-wal', '-shm']) fs.rmSync(freshPath + s, { force: true });
  const fresh = new Index(freshPath).open();
  ok('a new database reports no legacy migration', fresh.migratedFromV1 === false);
  ok('a new database has no legacy table', fresh.db.prepare(
    `SELECT name FROM sqlite_master WHERE name LIKE 'files_legacy%'`).all().length === 0);
  fresh.close();

  for (const f of [dbPath, freshPath]) {
    for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true });
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
