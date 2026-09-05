'use strict';
// The file index.
//
// Uses Node's built-in SQLite (available in Electron 37 / Node 22.21), so the
// application ships with no native modules to compile and no runtime
// dependencies at all. Verified working under the packaged Electron runtime.
//
// The v1 `files` table is extended rather than replaced. `sensitivity` is gone:
// it held a PII/threat judgement the application could not actually justify.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 9;

class Index {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  open() {
    this.db = new DatabaseSync(this.dbPath);
    // WAL keeps reads responsive while the scanner is writing.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this._migrate();
    return this;
  }

  _migrate() {
    const d = this.db;
    d.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

    const row = d.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
    const current = row ? Number(row.value) : 0;

    // A database written by version 1 already has a `files` table, with a
    // completely different shape: no scanId, and a `sensitivity` column holding
    // the PII judgement that version removed. `CREATE TABLE IF NOT EXISTS` is a
    // no-op against it, so every later statement — starting with the index on
    // scanId — fails, and the application cannot start at all.
    //
    // The legacy table is renamed rather than dropped. The file index itself is
    // a cache that a rescan rebuilds, but `starred` recorded real user intent,
    // so it is kept where the user can still get at it.
    this.migratedFromV1 = false;
    if (this._tableExists('files') && !this._hasColumn('files', 'scanId')) {
      const archive = this._freeTableName('files_legacy_v1');
      d.exec(`ALTER TABLE files RENAME TO ${archive}`);
      this.migratedFromV1 = archive;
      console.warn(
        `[db] found a version 1 file index and renamed it to ${archive}. ` +
        `Run a scan to rebuild the index in the current format.`
      );
    }

    if (current < 2) {
      // A scan is a measurement event. Every number the UI shows traces back to
      // one of these rows, so the UI can always say when it was measured.
      d.exec(`
        CREATE TABLE IF NOT EXISTS scans (
          id          TEXT PRIMARY KEY,
          root        TEXT NOT NULL,
          startedAt   TEXT NOT NULL,
          finishedAt  TEXT,
          status      TEXT NOT NULL,          -- running | complete | cancelled | failed
          fileCount   INTEGER DEFAULT 0,
          dirCount    INTEGER DEFAULT 0,
          totalBytes  INTEGER DEFAULT 0,
          skippedCount INTEGER DEFAULT 0,
          notes       TEXT                    -- JSON array of honest caveats
        )
      `);

      d.exec(`
        CREATE TABLE IF NOT EXISTS files (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          scanId      TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
          path        TEXT NOT NULL,
          name        TEXT NOT NULL,
          parent      TEXT,
          isDirectory INTEGER NOT NULL DEFAULT 0,
          size        INTEGER NOT NULL DEFAULT 0,
          mtimeMs     REAL,
          atimeMs     REAL,
          birthMs     REAL,
          extension   TEXT,
          type        TEXT,                   -- rule-based file type
          category    TEXT,                   -- treemap pigment category
          depth       INTEGER DEFAULT 0,
          fileId      TEXT,                   -- dev:inode, for hardlink detection
          starred     INTEGER DEFAULT 0,
          tags        TEXT,
          UNIQUE(scanId, path)
        )
      `);

      d.exec(`CREATE INDEX IF NOT EXISTS idx_files_scan     ON files(scanId)`);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_files_size     ON files(scanId, size DESC)`);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_files_parent   ON files(scanId, parent)`);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_files_category ON files(scanId, category)`);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_files_ext      ON files(scanId, extension)`);

      // Duplicate sets. `tier` records how the match was established, so the UI
      // can state the actual method rather than calling all of it "AI".
      d.exec(`
        CREATE TABLE IF NOT EXISTS duplicate_groups (
          id        TEXT PRIMARY KEY,
          scanId    TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
          tier      TEXT NOT NULL,            -- exact | image-perceptual | text-simhash
          signature TEXT NOT NULL,            -- sha256, or the perceptual hash
          memberCount INTEGER DEFAULT 0,
          wastedBytes INTEGER DEFAULT 0       -- total minus the one copy kept
        )
      `);
      d.exec(`
        CREATE TABLE IF NOT EXISTS duplicate_members (
          groupId  TEXT NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
          path     TEXT NOT NULL,
          size     INTEGER NOT NULL,
          distance INTEGER DEFAULT 0,         -- Hamming distance for near-duplicates
          PRIMARY KEY (groupId, path)
        )
      `);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_dupgroups_scan ON duplicate_groups(scanId)`);

      // Recursive directory totals, computed once after a scan in a single
      // bottom-up pass. Deriving these per query with a LIKE prefix match was
      // both slow and wrong for paths containing SQL wildcards.
      d.exec(`
        CREATE TABLE IF NOT EXISTS dir_rollup (
          scanId         TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
          path           TEXT NOT NULL,
          bytes          INTEGER NOT NULL DEFAULT 0,
          fileCount      INTEGER NOT NULL DEFAULT 0,
          newestAccessMs REAL,
          PRIMARY KEY (scanId, path)
        )
      `);
    }

    if (current < 3) {
      // Samples recorded during the current boot session.
      //
      // `bootId` is derived from the machine's boot time, so the series survives
      // closing and reopening the application, and survives sleep (sleeping does
      // not change when the machine booted). A restart produces a new bootId and
      // the graph starts again from zero, which is the behaviour asked for.
      // Samples from previous boots are discarded rather than accumulated.
      d.exec(`
        CREATE TABLE IF NOT EXISTS metrics_samples (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          bootId        TEXT NOT NULL,
          atMs          INTEGER NOT NULL,
          uptimeSec     REAL,
          cpuPercent    REAL,
          memUsedBytes  INTEGER,
          memTotalBytes INTEGER,
          ownBytes      INTEGER
        )
      `);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_boot ON metrics_samples(bootId, atMs)`);
    }

    if (current < 4) {
      // Content fingerprints, cached against the file's size and modification
      // time. Extracting text from a PDF or sampling frames from a film is
      // expensive; doing it once and reusing it is what makes a rescan of a
      // large drive cheap. A file that changes gets a different key and is
      // recomputed automatically.
      d.exec(`
        CREATE TABLE IF NOT EXISTS doc_text (
          path       TEXT NOT NULL,
          size       INTEGER NOT NULL,
          mtimeMs    REAL NOT NULL,
          simhash    TEXT,
          chars      INTEGER,
          method     TEXT,
          note       TEXT,
          extractedAt TEXT,
          PRIMARY KEY (path, size, mtimeMs)
        )
      `);
      d.exec(`
        CREATE TABLE IF NOT EXISTS video_fp (
          path        TEXT NOT NULL,
          size        INTEGER NOT NULL,
          mtimeMs     REAL NOT NULL,
          durationSec REAL,
          width       INTEGER,
          height      INTEGER,
          codec       TEXT,
          bitRate     INTEGER,
          coarse      TEXT,
          dense       TEXT,
          denseFps    REAL,
          note        TEXT,
          computedAt  TEXT,
          PRIMARY KEY (path, size, mtimeMs)
        )
      `);
    }

    if (current < 5) {
      // The searchable text of documents.
      //
      // `doc_text` above stores a SimHash and nothing else, which answers "are
      // these two files saying the same thing" and cannot answer "which file
      // talks about elephants". Answering that needs the words, so they are
      // kept here — in SQLite's own full-text index, which ships inside the
      // runtime and adds no dependency.
      //
      // Two tables rather than one because an FTS5 table cannot carry a useful
      // primary key or be queried cheaply by path: `doc_fts` holds the words,
      // `doc_bodies` holds the bookkeeping, and they are joined on rowid. The
      // bookkeeping is keyed on path, size and mtime — the same freshness key
      // the fingerprint caches use — so a file that has not changed is never
      // read twice, and a file that has changed is re-read automatically.
      d.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
          name,
          body,
          tokenize = 'porter unicode61 remove_diacritics 2'
        )
      `);
      // `pathKey` is the case-folded path and `path` is the one the disk
      // actually spells. They are separate columns because they answer separate
      // questions: Windows and macOS will hand back "/Users/x" and "/users/x"
      // for the same file depending on which call produced it, so a lookup keyed
      // on the display spelling silently misses and re-indexes the same document
      // forever — which is exactly what happened before this column existed.
      d.exec(`
        CREATE TABLE IF NOT EXISTS doc_bodies (
          rowid      INTEGER PRIMARY KEY,
          pathKey    TEXT NOT NULL UNIQUE,
          path       TEXT NOT NULL,
          name       TEXT NOT NULL,
          size       INTEGER NOT NULL,
          mtimeMs    REAL NOT NULL,
          chars      INTEGER NOT NULL DEFAULT 0,
          extension  TEXT,
          method     TEXT,
          note       TEXT,
          ok         INTEGER NOT NULL DEFAULT 1,
          indexedAt  TEXT NOT NULL
        )
      `);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_bodies_fresh ON doc_bodies(pathKey, size, mtimeMs)`);
    }

    if (current < 6) {
      // Described content: what a file is *about*, in words, so that it can be
      // found by describing it rather than by naming it.
      //
      // This is the one index in NexaFiles whose contents did not come from
      // measuring the disk — the words are written by a model that was shown
      // the file. That makes it categorically different from every other table
      // here, and the difference is carried in the data rather than assumed:
      // `model` records which model produced the tags and `taggedAt` when, so
      // a tag can always be attributed, and `ok`/`note` record the files that
      // were looked at and could not be described, because "no tags" and
      // "never examined" are not the same answer.
      //
      // Keyed on path rather than on a scan, like doc_bodies and for the same
      // reason: describing a file costs an API call, so the work must survive
      // a rescan. `size` and `mtimeMs` are the freshness key — a file that has
      // changed since it was described is re-described automatically, and one
      // that has not is never paid for twice.
      d.exec(`
        CREATE TABLE IF NOT EXISTS file_tags (
          rowid      INTEGER PRIMARY KEY,
          pathKey    TEXT NOT NULL UNIQUE,
          path       TEXT NOT NULL,
          name       TEXT NOT NULL,
          extension  TEXT,
          category   TEXT,
          kind       TEXT,
          size       INTEGER NOT NULL,
          mtimeMs    REAL NOT NULL,
          tags       TEXT NOT NULL DEFAULT '[]',
          tagCount   INTEGER NOT NULL DEFAULT 0,
          model      TEXT,
          ok         INTEGER NOT NULL DEFAULT 1,
          note       TEXT,
          taggedAt   TEXT NOT NULL
        )
      `);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_tags_fresh ON file_tags(pathKey, size, mtimeMs)`);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_tags_kind  ON file_tags(kind)`);

      // The words themselves, in SQLite's own full-text index, joined to
      // file_tags on rowid — the same two-table shape doc_fts/doc_bodies uses,
      // for the same reason: an FTS5 table cannot carry a useful key of its own.
      d.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS tag_fts USING fts5(
          tags,
          name,
          tokenize = 'porter unicode61 remove_diacritics 2'
        )
      `);
    }

    if (current < 7) {
      // How much of a file's reported size is actually on this disk.
      //
      // A file inside OneDrive, Google Drive or Dropbox can report its full
      // size while occupying nothing at all — Windows calls it Files On-Demand,
      // and the bytes only arrive when something reads them. Recording the two
      // figures separately is what lets NexaFiles keep its central claim
      // honest: `size` answers "how big is this file", `physicalSize` answers
      // "how much of my disk is it using", and for a placeholder those differ
      // by the whole file.
      //
      // Added as columns rather than a side table because every row needs them
      // and they come free from the stat the walker already performs.
      for (const [col, decl] of [
        ['physicalSize', 'INTEGER'],
        ['cloudProvider', 'TEXT'],
        ['cloudPlaceholder', 'INTEGER NOT NULL DEFAULT 0'],
        // A file on a mounted virtual drive (Google Drive's G:). Distinct from a
        // placeholder: a placeholder is measurably absent, whereas this one's
        // local footprint is not knowable at all, because the driver reports
        // every file as fully allocated whether it is cached or not. Both mean
        // "reading this may download it", which is what the guards check.
        ['cloudStreamed', 'INTEGER NOT NULL DEFAULT 0'],
      ]) {
        if (!this._hasColumn('files', col)) {
          d.exec(`ALTER TABLE files ADD COLUMN ${col} ${decl}`);
        }
      }
      d.exec(`CREATE INDEX IF NOT EXISTS idx_files_cloud ON files(scanId, cloudPlaceholder)`);
    }

    if (current < 8) {
      // Files that live in a connected cloud account.
      //
      // Kept apart from `files` on purpose. Every row in `files` is something
      // this machine walked and measured; a row here was described to us over
      // the network by a provider, and was never seen. Mixing them would put
      // unmeasured sizes into totals that the whole application presents as
      // measured, and there would be no way afterwards to tell which was which.
      //
      // `hash` and `hashAlgorithm` are the reason this table earns its place:
      // the provider computed them, so duplicates can be found across a cloud
      // account without downloading anything. The algorithm is stored beside
      // the value because a Google MD5 and a local SHA-256 are not comparable
      // and must never be joined as though they were.
      d.exec(`
        CREATE TABLE IF NOT EXISTS cloud_files (
          id            INTEGER PRIMARY KEY,
          accountId     TEXT NOT NULL,
          provider      TEXT NOT NULL,
          remoteId      TEXT NOT NULL,
          name          TEXT NOT NULL,
          mimeType      TEXT,
          size          INTEGER,
          hash          TEXT,
          hashAlgorithm TEXT,
          modifiedAt    TEXT,
          createdAt     TEXT,
          webUrl        TEXT,
          parentPath    TEXT,
          isNativeDoc   INTEGER NOT NULL DEFAULT 0,
          importedAt    TEXT NOT NULL,
          UNIQUE(accountId, remoteId)
        )
      `);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_cloud_account ON cloud_files(accountId)`);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_cloud_hash    ON cloud_files(hashAlgorithm, hash)`);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_cloud_size    ON cloud_files(size)`);
    }

    d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`)
      .run(String(SCHEMA_VERSION));
  }

  // ── recorded system metrics, scoped to the current boot session ──────────

  /** Stores one measured sample against the current boot session. */
  recordMetricSample(bootId, { uptimeSec, cpuPercent, memUsedBytes, memTotalBytes, ownBytes }) {
    this.db.prepare(`
      INSERT INTO metrics_samples
        (bootId, atMs, uptimeSec, cpuPercent, memUsedBytes, memTotalBytes, ownBytes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(bootId, Date.now(), uptimeSec, cpuPercent, memUsedBytes, memTotalBytes, ownBytes);
  }

  /** Every sample from this boot session, oldest first. */
  sessionSamples(bootId, limit = 2000) {
    const rows = this.db.prepare(`
      SELECT atMs, uptimeSec, cpuPercent, memUsedBytes, memTotalBytes, ownBytes
      FROM metrics_samples WHERE bootId = ?
      ORDER BY atMs DESC LIMIT ?
    `).all(bootId, limit);
    return rows.reverse();
  }

  sessionCoverage(bootId) {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS n, MIN(atMs) AS firstMs, MAX(atMs) AS lastMs,
             AVG(cpuPercent) AS cpuAvg, MAX(cpuPercent) AS cpuMax
      FROM metrics_samples WHERE bootId = ?
    `).get(bootId);
    return {
      sampleCount: r.n || 0,
      firstMs: r.firstMs || null,
      lastMs: r.lastMs || null,
      cpuAvg: r.cpuAvg,
      cpuMax: r.cpuMax,
    };
  }

  /**
   * Drops everything that does not belong to the current boot session.
   * The graph is explicitly a picture of this session, so older sessions are
   * not kept around to be quietly averaged into it.
   */
  dropOtherSessions(bootId) {
    const r = this.db.prepare(`DELETE FROM metrics_samples WHERE bootId != ?`).run(bootId);
    return r.changes || 0;
  }

  // ── derived history from the scan itself ─────────────────────────────────

  /**
   * Bytes and file counts by calendar month, taken from each file's own
   * modification time. This is real history and needs no recording period —
   * it is already on the disk the moment a scan finishes.
   */
  fileActivityByMonth(scanId, months = 12) {
    const since = Date.now() - months * 31 * 86400000;
    return this.db.prepare(`
      SELECT
        strftime('%Y-%m', mtimeMs / 1000, 'unixepoch', 'localtime') AS month,
        SUM(size) AS bytes,
        COUNT(*)  AS files
      FROM files
      WHERE scanId = ? AND isDirectory = 0 AND mtimeMs IS NOT NULL AND mtimeMs >= ?
      GROUP BY month
      ORDER BY month
    `).all(scanId, since);
  }

  /**
   * Bytes per category per month, so each statistic card can carry a real
   * trend line instead of a decorative squiggle.
   */
  categoryActivityByMonth(scanId, months = 12) {
    const since = Date.now() - months * 31 * 86400000;
    return this.db.prepare(`
      SELECT
        strftime('%Y-%m', mtimeMs / 1000, 'unixepoch', 'localtime') AS month,
        category,
        SUM(size) AS bytes
      FROM files
      WHERE scanId = ? AND isDirectory = 0 AND mtimeMs IS NOT NULL AND mtimeMs >= ?
      GROUP BY month, category
      ORDER BY month
    `).all(scanId, since);
  }

  /** Bytes per category per calendar year, for the stacked comparison. */
  categoryByYear(scanId, years = 3) {
    const rows = this.db.prepare(`
      SELECT
        strftime('%Y', mtimeMs / 1000, 'unixepoch', 'localtime') AS year,
        category,
        SUM(size) AS bytes,
        COUNT(*)  AS files
      FROM files
      WHERE scanId = ? AND isDirectory = 0 AND mtimeMs IS NOT NULL
      GROUP BY year, category
      ORDER BY year
    `).all(scanId);
    const keep = [...new Set(rows.map((r) => r.year))].sort().slice(-years);
    return rows.filter((r) => keep.includes(r.year));
  }

  /** Most recently modified files — the real equivalent of a recent-uploads list. */
  recentlyModified(scanId, limit = 12) {
    return this.db.prepare(`
      SELECT path, name, size, extension, type, category, mtimeMs
      FROM files
      WHERE scanId = ? AND isDirectory = 0 AND mtimeMs IS NOT NULL
      ORDER BY mtimeMs DESC LIMIT ?
    `).all(scanId, limit);
  }

  /** The scan immediately before `scanId` for the same root, for real deltas. */
  previousScan(scanId) {
    const cur = this.getScan(scanId);
    if (!cur) return null;
    const s = this.db.prepare(`
      SELECT * FROM scans
      WHERE root = ? AND status = 'complete' AND startedAt < ?
      ORDER BY startedAt DESC LIMIT 1
    `).get(cur.root, cur.startedAt);
    return s ? { ...s, notes: s.notes ? JSON.parse(s.notes) : [] } : null;
  }

  _tableExists(name) {
    return !!this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
    ).get(name);
  }

  _hasColumn(table, column) {
    try {
      return this.db.prepare(`PRAGMA table_info(${table})`).all()
        .some((c) => c.name === column);
    } catch {
      return false;
    }
  }

  /** First unused name in the `base`, `base_2`, `base_3` … series. */
  _freeTableName(base) {
    if (!this._tableExists(base)) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}_${i}`;
      if (!this._tableExists(candidate)) return candidate;
    }
    return `${base}_${Date.now()}`;
  }

  // ── content fingerprint cache ────────────────────────────────────────────

  getDocText(path, size, mtimeMs) {
    return this.db.prepare(
      `SELECT * FROM doc_text WHERE path = ? AND size = ? AND mtimeMs = ?`
    ).get(path, size, mtimeMs) || null;
  }

  putDocText(row) {
    this.db.prepare(`
      INSERT OR REPLACE INTO doc_text
        (path, size, mtimeMs, simhash, chars, method, note, extractedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.path, row.size, row.mtimeMs, row.simhash, row.chars,
           row.method, row.note, new Date().toISOString());
  }

  getVideoFp(path, size, mtimeMs) {
    return this.db.prepare(
      `SELECT * FROM video_fp WHERE path = ? AND size = ? AND mtimeMs = ?`
    ).get(path, size, mtimeMs) || null;
  }

  putVideoFp(row) {
    this.db.prepare(`
      INSERT OR REPLACE INTO video_fp
        (path, size, mtimeMs, durationSec, width, height, codec, bitRate,
         coarse, dense, denseFps, note, computedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.path, row.size, row.mtimeMs, row.durationSec, row.width, row.height,
           row.codec, row.bitRate, row.coarse, row.dense, row.denseFps, row.note,
           new Date().toISOString());
  }

  /** Drops cache rows whose file no longer exists at that size and time. */
  pruneFingerprints(existingKeys) {
    const keep = new Set(existingKeys);
    let removed = 0;
    for (const table of ['doc_text', 'video_fp']) {
      const rows = this.db.prepare(`SELECT path, size, mtimeMs FROM ${table}`).all();
      const del = this.db.prepare(
        `DELETE FROM ${table} WHERE path = ? AND size = ? AND mtimeMs = ?`);
      for (const r of rows) {
        if (!keep.has(`${r.path}|${r.size}|${r.mtimeMs}`)) {
          del.run(r.path, r.size, r.mtimeMs);
          removed++;
        }
      }
    }
    return removed;
  }

  // ── document text, searchable ────────────────────────────────────────────
  //
  // Everything here is a measurement of a file that was actually opened and
  // read. A path that has never been indexed is absent, and absent is reported
  // as "not read yet" rather than as "contains nothing" — the difference
  // matters, because the assistant is allowed to say the second and must never
  // say it when it means the first.

  /** True when this exact file, at this size and time, is already indexed. */
  docBodyFresh(pathKey, size, mtimeMs) {
    const row = this.db.prepare(
      `SELECT rowid FROM doc_bodies WHERE pathKey = ? AND size = ? AND mtimeMs = ?`
    ).get(pathKey, size, mtimeMs);
    return !!row;
  }

  /**
   * Stores one file's text.
   *
   * A file whose text could not be read is stored too, with `ok = 0` and the
   * reason: without that row the indexer would re-open the same unreadable
   * PDF on every single search, and the interface could never explain why a
   * file it can see is not among the results.
   */
  putDocBody({ pathKey, path: filePath, name, size, mtimeMs, chars, extension, method, note, ok, body }) {
    const key = pathKey || filePath;
    const existing = this.db.prepare(`SELECT rowid FROM doc_bodies WHERE pathKey = ?`).get(key);
    if (existing) {
      this.db.prepare(`DELETE FROM doc_fts WHERE rowid = ?`).run(existing.rowid);
      this.db.prepare(`DELETE FROM doc_bodies WHERE rowid = ?`).run(existing.rowid);
    }
    const info = this.db.prepare(
      `INSERT INTO doc_fts (name, body) VALUES (?, ?)`
    ).run(name, ok ? String(body || '') : '');
    this.db.prepare(`
      INSERT INTO doc_bodies
        (rowid, pathKey, path, name, size, mtimeMs, chars, extension, method, note, ok, indexedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(Number(info.lastInsertRowid), key, filePath, name, size, mtimeMs,
           chars || 0, extension || null, method || null, note || null,
           ok ? 1 : 0, new Date().toISOString());
  }

  /**
   * Full-text search over indexed documents.
   *
   * Ranked by bm25, which weighs a term by how rare it is across the corpus, so
   * a file about elephants outranks one that mentions an elephant once in a
   * shopping list. The name column is weighted more heavily than the body: a
   * file called "elephants.docx" is a stronger signal than a paragraph.
   *
   * `snippet()` returns the matched words in their own sentence. That is the
   * evidence — it is what lets the interface show why a file was returned
   * instead of asking the user to take the ranking on trust.
   */
  searchDocBodies(matchExpression, { limit = 25 } = {}) {
    return this.db.prepare(`
      SELECT b.path, b.name, b.size, b.mtimeMs, b.extension, b.chars, b.method,
             bm25(doc_fts, 8.0, 1.0) AS rank,
             snippet(doc_fts, 1, '‹', '›', '…', 24) AS snippet
      FROM doc_fts
      JOIN doc_bodies b ON b.rowid = doc_fts.rowid
      WHERE doc_fts MATCH ? AND b.ok = 1
      ORDER BY rank
      LIMIT ?
    `).all(matchExpression, Math.min(Math.max(1, limit), 200));
  }

  /** The whole indexed text of one file, for a closer read than a snippet. */
  docBodyFor(pathKey) {
    return this.db.prepare(`
      SELECT b.path, b.name, b.chars, b.method, b.note, b.ok, doc_fts.body
      FROM doc_bodies b JOIN doc_fts ON doc_fts.rowid = b.rowid
      WHERE b.pathKey = ?
    `).get(pathKey) || null;
  }

  /** How much has been read, for an interface that must not overstate it. */
  docIndexStats() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS files,
             SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS readable,
             SUM(chars) AS chars,
             MAX(indexedAt) AS lastIndexedAt
      FROM doc_bodies
    `).get();
    return {
      files: row?.files || 0,
      readable: row?.readable || 0,
      chars: row?.chars || 0,
      lastIndexedAt: row?.lastIndexedAt || null,
    };
  }

  /** Forgets one indexed document, by its case-folded path. */
  deleteDocBody(pathKey) {
    const row = this.db.prepare(`SELECT rowid FROM doc_bodies WHERE pathKey = ?`).get(pathKey);
    if (!row) return false;
    this.db.prepare(`DELETE FROM doc_fts WHERE rowid = ?`).run(row.rowid);
    this.db.prepare(`DELETE FROM doc_bodies WHERE rowid = ?`).run(row.rowid);
    return true;
  }

  /** Drops rows whose file is gone, so a deleted document stops being found. */
  pruneDocBodies(exists = (p) => require('fs').existsSync(p)) {
    const rows = this.db.prepare(`SELECT rowid, path FROM doc_bodies`).all();
    let removed = 0;
    for (const r of rows) {
      if (exists(r.path)) continue;
      this.db.prepare(`DELETE FROM doc_fts WHERE rowid = ?`).run(r.rowid);
      this.db.prepare(`DELETE FROM doc_bodies WHERE rowid = ?`).run(r.rowid);
      removed++;
    }
    return removed;
  }

  // ── described content ────────────────────────────────────────────────────
  //
  // Unlike everything above, these words were not measured off the disk — they
  // were written by a model that was shown the file. Every row therefore
  // carries which model wrote it and when, and a file that was examined and
  // could not be described is stored with `ok = 0` and the reason, so that
  // "nothing matched" is never confused with "never looked at".

  /** True when this exact file, at this size and time, has already been described. */
  fileTagsFresh(pathKey, size, mtimeMs) {
    const row = this.db.prepare(
      `SELECT rowid FROM file_tags WHERE pathKey = ? AND size = ? AND mtimeMs = ?`
    ).get(pathKey, size, mtimeMs);
    return !!row;
  }

  /**
   * Stores one file's description.
   *
   * Replaces any previous description of the same path outright: a file that
   * has changed is a different file, and merging old tags into new ones would
   * leave the index asserting things about content that no longer exists.
   */
  putFileTags({
    pathKey, path: filePath, name, extension, category, kind,
    size, mtimeMs, tags, model, ok, note,
  }) {
    const key = pathKey || filePath;
    const list = Array.isArray(tags) ? tags : [];
    const existing = this.db.prepare(`SELECT rowid FROM file_tags WHERE pathKey = ?`).get(key);
    if (existing) {
      this.db.prepare(`DELETE FROM tag_fts WHERE rowid = ?`).run(existing.rowid);
      this.db.prepare(`DELETE FROM file_tags WHERE rowid = ?`).run(existing.rowid);
    }
    const info = this.db.prepare(
      `INSERT INTO tag_fts (tags, name) VALUES (?, ?)`
    ).run(ok ? list.join(' ') : '', name);
    this.db.prepare(`
      INSERT INTO file_tags
        (rowid, pathKey, path, name, extension, category, kind,
         size, mtimeMs, tags, tagCount, model, ok, note, taggedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(Number(info.lastInsertRowid), key, filePath, name,
           extension || null, category || null, kind || null,
           size, mtimeMs, JSON.stringify(list), list.length,
           model || null, ok ? 1 : 0, note || null, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  /**
   * Finds files whose description matches.
   *
   * Ranked by bm25 over the tag bag, with the file's own name weighted lower
   * than its tags — the whole point of this index is to find a photo whose
   * name is `IMG_4821.JPG`, so a name match is a bonus rather than the signal.
   *
   * `kind` and `extensions` narrow by what the file *is*, which is measured
   * rather than described, so a query for a picture cannot return a spreadsheet
   * however well its words happen to match.
   */
  searchFileTags(matchExpression, { limit = 40, kind = null, extensions = null } = {}) {
    const clauses = [`tag_fts MATCH ?`, `t.ok = 1`];
    const args = [matchExpression];
    if (kind) { clauses.push(`t.kind = ?`); args.push(kind); }
    if (Array.isArray(extensions) && extensions.length) {
      clauses.push(`t.extension IN (${extensions.map(() => '?').join(',')})`);
      args.push(...extensions.map((e) => String(e).replace(/^\./, '').toLowerCase()));
    }
    args.push(Math.min(Math.max(1, limit), 200));
    return this.db.prepare(`
      SELECT t.path, t.name, t.extension, t.category, t.kind, t.size, t.mtimeMs,
             t.tags, t.model, t.taggedAt,
             bm25(tag_fts, 4.0, 1.0) AS rank
      FROM tag_fts
      JOIN file_tags t ON t.rowid = tag_fts.rowid
      WHERE ${clauses.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `).all(...args);
  }

  /** One file's description, for showing why it was returned. */
  fileTagsFor(pathKey) {
    return this.db.prepare(
      `SELECT * FROM file_tags WHERE pathKey = ?`
    ).get(pathKey) || null;
  }

  /** How much has been described, for an interface that must not overstate it. */
  tagIndexStats() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS files,
             SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS described,
             SUM(tagCount) AS tags,
             MAX(taggedAt) AS lastTaggedAt
      FROM file_tags
    `).get();
    const byKind = this.db.prepare(`
      SELECT kind, COUNT(*) AS n FROM file_tags WHERE ok = 1 GROUP BY kind
    `).all();
    return {
      files: row?.files || 0,
      described: row?.described || 0,
      tags: row?.tags || 0,
      lastTaggedAt: row?.lastTaggedAt || null,
      byKind: Object.fromEntries(byKind.map((r) => [r.kind || 'other', r.n])),
    };
  }

  /** Forgets one file's description. */
  deleteFileTags(pathKey) {
    const row = this.db.prepare(`SELECT rowid FROM file_tags WHERE pathKey = ?`).get(pathKey);
    if (!row) return false;
    this.db.prepare(`DELETE FROM tag_fts WHERE rowid = ?`).run(row.rowid);
    this.db.prepare(`DELETE FROM file_tags WHERE rowid = ?`).run(row.rowid);
    return true;
  }

  /** Drops descriptions of files that are gone. */
  pruneFileTags(exists = (p) => require('fs').existsSync(p)) {
    const rows = this.db.prepare(`SELECT rowid, path FROM file_tags`).all();
    let removed = 0;
    for (const r of rows) {
      if (exists(r.path)) continue;
      this.db.prepare(`DELETE FROM tag_fts WHERE rowid = ?`).run(r.rowid);
      this.db.prepare(`DELETE FROM file_tags WHERE rowid = ?`).run(r.rowid);
      removed++;
    }
    return removed;
  }

  /** Every description, dropped. Used when the feature is switched off. */
  clearFileTags() {
    const n = this.db.prepare(`SELECT COUNT(*) AS n FROM file_tags`).get()?.n || 0;
    this.db.exec(`DELETE FROM tag_fts`);
    this.db.exec(`DELETE FROM file_tags`);
    return n;
  }

  /** Forgets every indexed body. The Settings view offers this. */
  clearDocBodies() {
    const n = this.db.prepare(`SELECT COUNT(*) AS n FROM doc_bodies`).get()?.n || 0;
    this.db.exec(`DELETE FROM doc_fts`);
    this.db.exec(`DELETE FROM doc_bodies`);
    return n;
  }

  // ── scans ────────────────────────────────────────────────────────────────
  createScan(id, root) {
    this.db.prepare(
      `INSERT INTO scans (id, root, startedAt, status) VALUES (?, ?, ?, 'running')`
    ).run(id, root, new Date().toISOString());
    return id;
  }

  finishScan(id, { status, fileCount, dirCount, totalBytes, skippedCount, notes }) {
    this.db.prepare(`
      UPDATE scans SET finishedAt = ?, status = ?, fileCount = ?, dirCount = ?,
        totalBytes = ?, skippedCount = ?, notes = ? WHERE id = ?
    `).run(
      new Date().toISOString(), status, fileCount | 0, dirCount | 0,
      totalBytes, skippedCount | 0, JSON.stringify(notes || []), id
    );
  }

  getScan(id) {
    const s = this.db.prepare(`SELECT * FROM scans WHERE id = ?`).get(id);
    if (!s) return null;
    return { ...s, notes: s.notes ? JSON.parse(s.notes) : [] };
  }

  latestCompleteScan(root = null) {
    const q = root
      ? `SELECT * FROM scans WHERE status='complete' AND root = ? ORDER BY finishedAt DESC LIMIT 1`
      : `SELECT * FROM scans WHERE status='complete' ORDER BY finishedAt DESC LIMIT 1`;
    const s = root ? this.db.prepare(q).get(root) : this.db.prepare(q).get();
    if (!s) return null;
    return { ...s, notes: s.notes ? JSON.parse(s.notes) : [] };
  }

  listScans(limit = 25) {
    return this.db.prepare(
      `SELECT * FROM scans ORDER BY startedAt DESC LIMIT ?`
    ).all(limit).map((s) => ({ ...s, notes: s.notes ? JSON.parse(s.notes) : [] }));
  }

  deleteScan(id) {
    this.db.prepare(`DELETE FROM scans WHERE id = ?`).run(id);
  }

  /** Keeps the N most recent scans; older ones and their rows are dropped. */
  pruneScans(keep = 5) {
    const old = this.db.prepare(
      `SELECT id FROM scans ORDER BY startedAt DESC LIMIT -1 OFFSET ?`
    ).all(keep);
    for (const s of old) this.deleteScan(s.id);
    return old.length;
  }

  // ── files ────────────────────────────────────────────────────────────────
  /** Inserts a batch inside one transaction. Called by the scan controller. */
  insertBatch(scanId, rows) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files
        (scanId, path, name, parent, isDirectory, size, mtimeMs, atimeMs, birthMs,
         extension, type, category, depth, fileId,
         physicalSize, cloudProvider, cloudPlaceholder, cloudStreamed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        stmt.run(
          scanId, r.path, r.name, r.parent, r.isDirectory ? 1 : 0, r.size,
          r.mtimeMs, r.atimeMs, r.birthMs, r.extension, r.type, r.category,
          r.depth, r.fileId,
          // `physicalSize` falls back to the logical size rather than to zero:
          // a platform that does not report allocated blocks has not told us
          // the file is absent, and defaulting to zero would invent that claim.
          // A streamed file's footprint is genuinely unknown, so NULL survives
          // rather than being filled in with its logical size — which would put
          // an invented number into a column the interface reports as measured.
          r.cloudStreamed
            ? null
            : (r.physicalSize === undefined || r.physicalSize === null
                ? r.size : r.physicalSize),
          r.cloudProvider || null,
          r.cloudPlaceholder ? 1 : 0,
          r.cloudStreamed ? 1 : 0
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return rows.length;
  }

  /** Bytes per treemap category for one scan. */
  categoryTotals(scanId) {
    return this.db.prepare(`
      SELECT category, SUM(size) AS bytes, COUNT(*) AS count
      FROM files WHERE scanId = ? AND isDirectory = 0
      GROUP BY category ORDER BY bytes DESC
    `).all(scanId);
  }

  /**
   * Computes recursive totals for every directory in a scan, bottom-up.
   *
   * Directories are processed deepest-first, so by the time a directory is
   * reached, every one of its subdirectories has already contributed its total.
   * One pass, no per-query prefix matching, exact for paths containing any
   * character at all.
   */
  computeRollups(scanId) {
    const d = this.db;
    d.prepare(`DELETE FROM dir_rollup WHERE scanId = ?`).run(scanId);

    // Direct file contents of each directory.
    const direct = new Map();
    for (const r of d.prepare(`
      SELECT parent, SUM(size) AS bytes, COUNT(*) AS n, MAX(atimeMs) AS newest
      FROM files WHERE scanId = ? AND isDirectory = 0 AND parent IS NOT NULL
      GROUP BY parent
    `).all(scanId)) {
      direct.set(r.parent, { bytes: r.bytes || 0, fileCount: r.n || 0, newest: r.newest });
    }

    // Accumulators, seeded with each directory's direct contents.
    const acc = new Map();
    const dirs = d.prepare(`
      SELECT path, parent, depth FROM files
      WHERE scanId = ? AND isDirectory = 1 ORDER BY depth DESC
    `).all(scanId);

    for (const dir of dirs) {
      if (!acc.has(dir.path)) acc.set(dir.path, { bytes: 0, fileCount: 0, newest: null });
    }

    for (const [p, v] of direct) {
      const a = acc.get(p);
      if (a) {
        a.bytes += v.bytes;
        a.fileCount += v.fileCount;
        a.newest = maxOrNull(a.newest, v.newest);
      } else {
        // A parent that was never recorded as a directory row (can happen if the
        // walk was cancelled mid-tree). Keep the bytes rather than losing them.
        acc.set(p, { bytes: v.bytes, fileCount: v.fileCount, newest: v.newest });
      }
    }

    // Deepest-first, so each directory folds into its parent already complete.
    for (const dir of dirs) {
      const a = acc.get(dir.path);
      if (!a || !dir.parent) continue;
      const p = acc.get(dir.parent);
      if (!p) continue;
      p.bytes += a.bytes;
      p.fileCount += a.fileCount;
      p.newest = maxOrNull(p.newest, a.newest);
    }

    const ins = d.prepare(
      `INSERT OR REPLACE INTO dir_rollup (scanId, path, bytes, fileCount, newestAccessMs)
       VALUES (?, ?, ?, ?, ?)`
    );
    d.exec('BEGIN');
    try {
      for (const [p, v] of acc) ins.run(scanId, p, v.bytes, v.fileCount, v.newest);
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
    return acc.size;
  }

  /**
   * Immediate children of `parent`, directories carrying their recursive size.
   * This is what the treemap draws.
   */
  childrenWithRollup(scanId, parent) {
    return this.db.prepare(`
      SELECT
        f.path, f.name, f.isDirectory, f.extension, f.category, f.mtimeMs,
        CASE WHEN f.isDirectory = 1
             THEN COALESCE(r.bytes, 0) ELSE f.size END AS bytes,
        CASE WHEN f.isDirectory = 1
             THEN COALESCE(r.fileCount, 0) ELSE 1 END AS fileCount,
        CASE WHEN f.isDirectory = 1
             THEN r.newestAccessMs ELSE f.atimeMs END AS newestAccessMs
      FROM files f
      LEFT JOIN dir_rollup r ON r.scanId = f.scanId AND r.path = f.path
      WHERE f.scanId = ? AND f.parent = ?
      ORDER BY bytes DESC
    `).all(scanId, parent);
  }

  /** Recursive total for one directory. */
  rollupFor(scanId, dirPath) {
    return this.db.prepare(
      `SELECT bytes, fileCount, newestAccessMs FROM dir_rollup WHERE scanId = ? AND path = ?`
    ).get(scanId, dirPath) || { bytes: 0, fileCount: 0, newestAccessMs: null };
  }

  /** Largest files in a scan, optionally under a subtree. Paginated. */
  largestFiles(scanId, { under = null, limit = 200, offset = 0, category = null } = {}) {
    const clauses = [`scanId = ?`, `isDirectory = 0`];
    const args = [scanId];
    if (under) {
      const prefix = under.endsWith(path.sep) ? under : under + path.sep;
      clauses.push(`path LIKE ? ESCAPE '\\'`);
      args.push(escapeLike(prefix) + '%');
    }
    if (category) { clauses.push(`category = ?`); args.push(category); }
    args.push(limit, offset);
    return this.db.prepare(`
      SELECT path, name, size, extension, type, category, mtimeMs, atimeMs
      FROM files WHERE ${clauses.join(' AND ')}
      ORDER BY size DESC LIMIT ? OFFSET ?
    `).all(...args);
  }

  countFiles(scanId, { under = null, category = null } = {}) {
    const clauses = [`scanId = ?`, `isDirectory = 0`];
    const args = [scanId];
    if (under) {
      const prefix = under.endsWith(path.sep) ? under : under + path.sep;
      clauses.push(`path LIKE ? ESCAPE '\\'`);
      args.push(escapeLike(prefix) + '%');
    }
    if (category) { clauses.push(`category = ?`); args.push(category); }
    return this.db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM files WHERE ${clauses.join(' AND ')}`
    ).get(...args);
  }

  /**
   * A subtree filter, in the form the file queries already use.
   *
   * Returned as a clause and its argument rather than as a string spliced into
   * the SQL, so a folder name containing a quote or a percent sign is a folder
   * name and not a query. Trailing separator included, so that scoping to
   * "…/Photos" cannot also pull in "…/Photos Backup".
   */
  static _underClause(under) {
    if (!under) return null;
    const prefix = under.endsWith(path.sep) ? under : under + path.sep;
    return { clause: `path LIKE ? ESCAPE '\\'`, arg: escapeLike(prefix) + '%' };
  }

  /**
   * Candidate groups for exact-duplicate detection: same size, more than one file.
   *
   * Cloud placeholders are excluded, and that exclusion is not a detail. A
   * placeholder reports a size but holds no bytes here, so hashing one means
   * downloading the whole file. Over a dehydrated OneDrive that turns a
   * duplicate scan into a download of the entire account — hours of transfer
   * the user never asked for, and on a metered connection, money. They are
   * counted separately by `placeholdersExcluded` so the interface can say what
   * was left out instead of quietly returning a smaller answer.
   */
  sizeCollisionGroups(scanId, minBytes = 4096, { under = null, includeCloud = false } = {}) {
    const scope = Index._underClause(under);
    const cloudClause = includeCloud ? '' : ' AND cloudPlaceholder = 0 AND cloudStreamed = 0';
    return this.db.prepare(`
      SELECT size, COUNT(*) AS n FROM files
      WHERE scanId = ? AND isDirectory = 0 AND size >= ?${
        scope ? ` AND ${scope.clause}` : ''}${cloudClause}
      GROUP BY size HAVING n > 1 ORDER BY size DESC
    `).all(...[scanId, minBytes, ...(scope ? [scope.arg] : [])]);
  }

  /**
   * What the last scan recorded about where a path's bytes live.
   *
   * Looked up at plan-building time rather than threaded through every scanner,
   * because every scanner would have to remember to carry it and one that
   * forgot would produce a plan entry that silently loses the warning. One
   * lookup, in one place, cannot be forgotten by a new scanner added later.
   *
   * A path the scan never saw returns nulls, which the plan entry treats as
   * "not in a sync folder" — the same answer it had before any of this existed.
   */
  cloudInfoForPath(scanId, filePath) {
    if (!scanId || !filePath) return null;
    const row = this.db.prepare(`
      SELECT cloudProvider, cloudPlaceholder, physicalSize, size
      FROM files WHERE scanId = ? AND path = ? LIMIT 1
    `).get(scanId, path.resolve(filePath));
    if (!row) return null;
    return {
      cloudProvider: row.cloudProvider || null,
      cloudPlaceholder: row.cloudPlaceholder === 1,
      physicalBytes: row.physicalSize ?? row.size,
    };
  }

  /**
   * Whether anything under a path is inside a sync folder.
   *
   * Used for directory entries — a leftover is a folder, and the folder itself
   * has no cloud row of its own worth trusting, but what is inside it does.
   */
  cloudInfoForTree(scanId, dirPath) {
    if (!scanId || !dirPath) return null;
    const scope = Index._underClause(path.resolve(dirPath));
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(cloudPlaceholder) AS placeholders,
             MAX(cloudProvider) AS provider,
             SUM(physicalSize) AS physical
      FROM files
      WHERE scanId = ? AND isDirectory = 0 AND cloudProvider IS NOT NULL AND ${scope.clause}
    `).get(scanId, scope.arg);
    if (!row || !row.n) return null;
    return {
      cloudProvider: row.provider || null,
      cloudPlaceholder: row.placeholders === row.n,
      physicalBytes: row.physical || 0,
      syncedFiles: row.n,
    };
  }

  /**
   * The sync-folder picture for one scan, per provider.
   *
   * Returns null when nothing in the scan is in a sync folder, so an interface
   * can leave the whole subject out rather than drawing an empty panel about
   * cloud storage to somebody who has none.
   */
  cloudSummary(scanId) {
    const rows = this.db.prepare(`
      SELECT cloudProvider AS provider,
             COUNT(*) AS files,
             SUM(size) AS logicalBytes,
             SUM(physicalSize) AS physicalBytes,
             SUM(cloudPlaceholder) AS placeholders,
             SUM(CASE WHEN cloudPlaceholder = 1 THEN size ELSE 0 END) AS placeholderBytes
      FROM files
      WHERE scanId = ? AND isDirectory = 0 AND cloudProvider IS NOT NULL
      GROUP BY cloudProvider
    `).all(scanId);
    if (!rows.length) return null;

    const total = rows.reduce((acc, r) => ({
      files: acc.files + r.files,
      logicalBytes: acc.logicalBytes + (r.logicalBytes || 0),
      physicalBytes: acc.physicalBytes + (r.physicalBytes || 0),
      placeholders: acc.placeholders + (r.placeholders || 0),
      placeholderBytes: acc.placeholderBytes + (r.placeholderBytes || 0),
    }), { files: 0, logicalBytes: 0, physicalBytes: 0, placeholders: 0, placeholderBytes: 0 });

    return { providers: rows, ...total };
  }

  // ── cloud accounts' files ────────────────────────────────────────────────
  //
  // Everything here was reported by a provider over the network. None of it was
  // measured by this machine, and the interface must never present it as though
  // it had been.

  /** Replaces one account's imported listing, inside a transaction. */
  replaceCloudFiles(accountId, provider, rows) {
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM cloud_files WHERE accountId = ?`).run(accountId);
      const stmt = this.db.prepare(`
        INSERT INTO cloud_files
          (accountId, provider, remoteId, name, mimeType, size, hash, hashAlgorithm,
           modifiedAt, createdAt, webUrl, parentPath, isNativeDoc, importedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of rows) {
        stmt.run(
          accountId, provider, r.remoteId, r.name, r.mimeType || null,
          r.size === null || r.size === undefined ? null : r.size,
          r.hash || null, r.hashAlgorithm || null,
          r.modifiedAt || null, r.createdAt || null, r.webUrl || null,
          r.parentPath || null, r.isNativeDoc ? 1 : 0, now
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return rows.length;
  }

  cloudFileStats(accountId = null) {
    const where = accountId ? 'WHERE accountId = ?' : '';
    const args = accountId ? [accountId] : [];
    const row = this.db.prepare(`
      SELECT COUNT(*) AS files,
             SUM(COALESCE(size, 0)) AS bytes,
             SUM(CASE WHEN hash IS NOT NULL THEN 1 ELSE 0 END) AS hashed,
             SUM(CASE WHEN isNativeDoc = 1 THEN 1 ELSE 0 END) AS nativeDocs,
             MAX(importedAt) AS lastImportAt
      FROM cloud_files ${where}
    `).get(...args);
    return {
      files: row?.files || 0,
      bytes: row?.bytes || 0,
      hashed: row?.hashed || 0,
      nativeDocs: row?.nativeDocs || 0,
      lastImportAt: row?.lastImportAt || null,
    };
  }

  /**
   * Duplicates inside the cloud, found on the provider's own hashes.
   *
   * Grouped by algorithm as well as value, so an MD5 from Google can never be
   * joined to a SHA-256 from OneDrive and reported as a match. Within one
   * algorithm the match is exact and needed no download.
   */
  cloudDuplicateGroups({ minBytes = 1, accountId = null } = {}) {
    const scope = accountId ? 'AND accountId = ?' : '';
    const args = accountId ? [minBytes, accountId] : [minBytes];
    const groups = this.db.prepare(`
      SELECT hashAlgorithm, hash, COUNT(*) AS n, MAX(size) AS size,
             SUM(COALESCE(size,0)) AS totalBytes
      FROM cloud_files
      WHERE hash IS NOT NULL AND COALESCE(size,0) >= ? ${scope}
      GROUP BY hashAlgorithm, hash
      HAVING n > 1
      ORDER BY totalBytes DESC
      LIMIT 500
    `).all(...args);

    return groups.map((g) => ({
      ...g,
      wastedBytes: (g.size || 0) * (g.n - 1),
      members: this.db.prepare(`
        SELECT accountId, provider, remoteId, name, size, webUrl, modifiedAt, parentPath
        FROM cloud_files
        WHERE hashAlgorithm = ? AND hash = ?
        ORDER BY COALESCE(modifiedAt, '') ASC
      `).all(g.hashAlgorithm, g.hash),
    }));
  }

  /**
   * Files present both in a cloud account and on this disk.
   *
   * Joined on the hash only where the algorithms agree — OneDrive's sha256Hash
   * against a local SHA-256 is a real match; Google's MD5 against it is not
   * comparable at all, and those are reported separately as size-only
   * candidates rather than as matches.
   */
  cloudLocalMatches(scanId, { minBytes = 1 << 20, limit = 200 } = {}) {
    const rows = this.db.prepare(`
      SELECT c.accountId, c.provider, c.name AS cloudName, c.size, c.webUrl,
             c.hashAlgorithm, c.remoteId,
             f.path AS localPath, f.cloudProvider AS localSyncedTo
      FROM cloud_files c
      JOIN files f
        ON f.scanId = ?
       AND f.isDirectory = 0
       AND f.size = c.size
       AND LOWER(f.name) = LOWER(c.name)
      WHERE c.size >= ?
      ORDER BY c.size DESC
      LIMIT ?
    `).all(scanId, minBytes, Math.min(Math.max(1, limit), 1000));

    // The confidence is decided here rather than in SQL, because it depends on
    // whether the two hashes are even the same kind of thing. Only sha256 from
    // OneDrive is directly comparable with what NexaFiles computes locally;
    // anything else is a name-and-size coincidence and is labelled as one.
    return rows.map((r) => ({
      ...r,
      basis: r.hashAlgorithm === 'sha256'
        ? 'same name and size, and the provider reports a SHA-256 that can be ' +
          'checked against a local hash'
        : 'same name and size only — the provider\'s hash is ' +
          `${r.hashAlgorithm || 'absent'}, which cannot be compared with a local one`,
      comparable: r.hashAlgorithm === 'sha256',
    }));
  }

  clearCloudFiles(accountId) {
    const n = this.db.prepare(`SELECT COUNT(*) AS n FROM cloud_files WHERE accountId = ?`)
      .get(accountId)?.n || 0;
    this.db.prepare(`DELETE FROM cloud_files WHERE accountId = ?`).run(accountId);
    return n;
  }

  /** How many files a content scan is leaving alone because reading them downloads them. */
  placeholdersExcluded(scanId, { under = null, minBytes = 0 } = {}) {
    const scope = Index._underClause(under);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n, SUM(size) AS bytes,
             COUNT(DISTINCT cloudProvider) AS providers
      FROM files
      WHERE scanId = ? AND isDirectory = 0 AND cloudPlaceholder = 1 AND size >= ?${
        scope ? ` AND ${scope.clause}` : ''}
    `).get(...[scanId, minBytes, ...(scope ? [scope.arg] : [])]);
    return { count: row?.n || 0, bytes: row?.bytes || 0, providers: row?.providers || 0 };
  }

  /**
   * The files of one exact size.
   *
   * Scoped by the same subtree as the size groups that produced it. Without that
   * the counts would disagree with the results: a size group counted inside the
   * chosen folder would go on to collect its members from the whole scan, and a
   * "duplicates in Downloads" search would report pairs that are not both in
   * Downloads.
   */
  filesOfSize(scanId, size, { under = null, includeCloud = false } = {}) {
    const scope = Index._underClause(under);
    // Excluded on the same terms as the size groups that produced this call.
    // If they disagreed, a group counted without placeholders would go on to
    // collect members including them, and the scan would download the very
    // files the grouping was careful to leave out.
    const cloudClause = includeCloud ? '' : ' AND cloudPlaceholder = 0 AND cloudStreamed = 0';
    return this.db.prepare(`
      SELECT path, size, fileId FROM files
      WHERE scanId = ? AND isDirectory = 0 AND size = ?${
        scope ? ` AND ${scope.clause}` : ''}${cloudClause}
    `).all(...[scanId, size, ...(scope ? [scope.arg] : [])]);
  }

  filesByExtensions(scanId, exts, minBytes = 0, { under = null } = {}) {
    const marks = exts.map(() => '?').join(',');
    const scope = Index._underClause(under);
    return this.db.prepare(`
      SELECT path, size, extension FROM files
      WHERE scanId = ? AND isDirectory = 0 AND size >= ? AND extension IN (${marks})${
        scope ? ` AND ${scope.clause}` : ''}
      ORDER BY size DESC
    `).all(...[scanId, minBytes, ...exts, ...(scope ? [scope.arg] : [])]);
  }

  /**
   * Files worth describing, in the order worth describing them.
   *
   * Deliberately not `filesByExtensions`, which orders by size descending
   * because its caller — the document text index — genuinely wants the biggest
   * documents first. Describing has the opposite priority and the mistake was
   * expensive: with a per-run cap of 200 over a scan of nearly a million files,
   * size-first spends every call on the largest PDFs on the disk and never
   * reaches an 80 KB photo in Downloads, which is exactly the file the feature
   * exists to find.
   *
   * So: pictures first, because nothing on disk says what is in one and they
   * are the case with no alternative; then most recently changed, because a
   * capped run should cover what the user has been working with rather than
   * whatever happens to sort first.
   */
  describeCandidates(scanId, {
    imageExts = [], otherExts = [], under = null, limit = 2000, includeCloud = false,
  } = {}) {
    const all = [...imageExts, ...otherExts];
    if (!all.length) return [];
    const allMarks = all.map(() => '?').join(',');
    const imgMarks = imageExts.length ? imageExts.map(() => '?').join(',') : "''";
    const scope = Index._underClause(under);
    return this.db.prepare(`
      SELECT path, size, mtimeMs, extension,
             CASE WHEN extension IN (${imgMarks}) THEN 0 ELSE 1 END AS kindRank
      FROM files
      WHERE scanId = ? AND isDirectory = 0 AND size > 0
        AND extension IN (${allMarks})${scope ? ` AND ${scope.clause}` : ''}
        ${includeCloud ? '' : 'AND cloudPlaceholder = 0 AND cloudStreamed = 0'}
      ORDER BY kindRank ASC, mtimeMs DESC
      LIMIT ?
    `).all(...[
      ...imageExts, scanId, ...all, ...(scope ? [scope.arg] : []),
      Math.min(Math.max(1, limit), 50_000),
    ]);
  }

  // ── duplicates ───────────────────────────────────────────────────────────
  saveDuplicateGroup(scanId, group) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO duplicate_groups
          (id, scanId, tier, signature, memberCount, wastedBytes)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(group.id, scanId, group.tier, group.signature,
        group.members.length, group.wastedBytes);
      const m = this.db.prepare(
        `INSERT OR REPLACE INTO duplicate_members (groupId, path, size, distance) VALUES (?, ?, ?, ?)`
      );
      for (const mem of group.members) m.run(group.id, mem.path, mem.size, mem.distance || 0);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  clearDuplicates(scanId, tier = null) {
    if (tier) this.db.prepare(`DELETE FROM duplicate_groups WHERE scanId = ? AND tier = ?`).run(scanId, tier);
    else this.db.prepare(`DELETE FROM duplicate_groups WHERE scanId = ?`).run(scanId);
  }

  listDuplicateGroups(scanId, tier = null) {
    const groups = tier
      ? this.db.prepare(`SELECT * FROM duplicate_groups WHERE scanId = ? AND tier = ? ORDER BY wastedBytes DESC`).all(scanId, tier)
      : this.db.prepare(`SELECT * FROM duplicate_groups WHERE scanId = ? ORDER BY wastedBytes DESC`).all(scanId);
    const memStmt = this.db.prepare(`SELECT path, size, distance FROM duplicate_members WHERE groupId = ? ORDER BY size DESC`);
    return groups.map((g) => ({ ...g, members: memStmt.all(g.id) }));
  }

  duplicateTotals(scanId) {
    return this.db.prepare(`
      SELECT tier, COUNT(*) AS groups, COALESCE(SUM(wastedBytes),0) AS wastedBytes
      FROM duplicate_groups WHERE scanId = ? GROUP BY tier
    `).all(scanId);
  }

  close() {
    if (this.db) { this.db.close(); this.db = null; }
  }
}

/** Larger of two possibly-null timestamps. */
function maxOrNull(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

/** Escapes LIKE wildcards so a path containing % or _ still matches literally. */
function escapeLike(s) {
  return s.replace(/([\\%_])/g, '\\$1');
}

module.exports = { Index, SCHEMA_VERSION };
