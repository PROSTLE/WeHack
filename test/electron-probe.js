// Runs inside the real Electron main process to verify runtime capabilities we
// intend to depend on. Exits non-zero if any of them are missing.
const { app, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const out = [];
let failed = 0;
function check(name, fn) {
  try {
    const detail = fn();
    out.push(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
  } catch (e) {
    out.push(`  FAIL  ${name}  <- ${e.message}`);
    failed++;
  }
}

app.whenReady().then(() => {
  out.push(`Electron ${process.versions.electron} / Node ${process.versions.node} / Chromium ${process.versions.chrome}`);

  check('node:sqlite is available in Electron', () => {
    const { DatabaseSync } = require('node:sqlite');
    if (!DatabaseSync) throw new Error('DatabaseSync missing');
    return '';
  });

  check('node:sqlite can create, write and read a database', () => {
    const { DatabaseSync } = require('node:sqlite');
    const p = path.join(os.tmpdir(), 'nexafiles-probe.db');
    fs.rmSync(p, { force: true });
    const db = new DatabaseSync(p);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, path TEXT UNIQUE, size INTEGER)');
    const ins = db.prepare('INSERT INTO t (path, size) VALUES (?, ?)');
    for (let i = 0; i < 1000; i++) ins.run('/p/' + i, i * 10);
    const row = db.prepare('SELECT COUNT(*) AS n, SUM(size) AS s FROM t').get();
    db.close();
    fs.rmSync(p, { force: true });
    if (Number(row.n) !== 1000) throw new Error('row count wrong: ' + row.n);
    return `1000 rows, sum=${row.s}`;
  });

  check('node:sqlite supports WAL and transactions', () => {
    const { DatabaseSync } = require('node:sqlite');
    const p = path.join(os.tmpdir(), 'nexafiles-probe2.db');
    fs.rmSync(p, { force: true });
    const db = new DatabaseSync(p);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE t (a INTEGER)');
    db.exec('BEGIN');
    const ins = db.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 5000; i++) ins.run(i);
    db.exec('COMMIT');
    const n = db.prepare('SELECT COUNT(*) AS n FROM t').get().n;
    db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true });
    if (Number(n) !== 5000) throw new Error('tx row count wrong');
    return '5000 rows in one transaction';
  });

  check('nativeImage can decode and resize an image (for perceptual hashing)', () => {
    const { makePng } = require('./make-png.js');
    // A real gradient PNG, so the resize below has actual detail to preserve.
    const png = makePng(64, 64, (x, y) => [x * 4, y * 4, (x ^ y) * 4]);
    const img = nativeImage.createFromBuffer(png);
    if (img.isEmpty()) throw new Error('decode produced empty image');
    const small = img.resize({ width: 9, height: 8, quality: 'good' });
    const bmp = small.toBitmap();
    const size = small.getSize();
    if (bmp.length !== size.width * size.height * 4) {
      throw new Error(`unexpected bitmap length ${bmp.length} for ${size.width}x${size.height}`);
    }
    // Confirm the pixels are not all identical, i.e. real content survived.
    const distinct = new Set();
    for (let i = 0; i < bmp.length; i += 4) distinct.add(bmp[i]);
    if (distinct.size < 3) throw new Error('resize lost all detail');
    return `decoded ${img.getSize().width}x${img.getSize().height} -> ${size.width}x${size.height}, ${bmp.length}B BGRA, ${distinct.size} distinct blue values`;
  });

  check('app.getAppMetrics reports our own footprint', () => {
    const m = app.getAppMetrics();
    if (!Array.isArray(m) || m.length === 0) throw new Error('no metrics');
    const mem = m.reduce((n, p) => n + (p.memory?.workingSetSize || 0), 0);
    return `${m.length} processes, ${(mem / 1024).toFixed(1)} MB working set`;
  });

  check('shell.trashItem exists', () => {
    const { shell } = require('electron');
    if (typeof shell.trashItem !== 'function') throw new Error('missing');
    return '';
  });

  console.log(out.join('\n'));
  console.log(`\n${failed} failed`);
  app.exit(failed ? 1 : 0);
});
