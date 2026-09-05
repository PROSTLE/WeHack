'use strict';
// Quarantine: the reversal stage of the safety pipeline.
//
// Files the user would recognise go to the OS trash instead — that is a recovery
// path they already understand. Quarantine is for application internals that do
// not belong in a user's trash: orphaned cache directories, leftover support
// folders, and anything else where "Restore" needs to put the bytes back exactly
// where they came from, with their original name and timestamps.
//
// Every entry carries a manifest record with the original path and the plan entry
// that caused it, so the reason for a removal survives as long as the removal does.
//
// The base directory is injected rather than read from Electron's `app`, so this
// module is testable without launching a browser window.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { safeMove, measure } = require('./fsops');

const MANIFEST_NAME = 'manifest.json';
const PAYLOAD_DIR = 'items';
const DEFAULT_RETENTION_DAYS = 30;

class Quarantine {
  /** @param {string} baseDir directory that holds the manifest and payloads */
  constructor(baseDir, { retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
    this.baseDir = baseDir;
    this.itemsDir = path.join(baseDir, PAYLOAD_DIR);
    this.manifestPath = path.join(baseDir, MANIFEST_NAME);
    this.retentionDays = retentionDays;
    this._manifest = null;
  }

  async init() {
    await fsp.mkdir(this.itemsDir, { recursive: true });
    await this._load();
    return this;
  }

  async _load() {
    try {
      const raw = await fsp.readFile(this.manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      this._manifest = Array.isArray(parsed.entries) ? parsed : { version: 1, entries: [] };
    } catch {
      // Missing or corrupt manifest. A corrupt manifest must not orphan payloads
      // silently, so preserve the old file before starting a fresh one.
      try {
        await fsp.access(this.manifestPath);
        await fsp.rename(this.manifestPath, this.manifestPath + '.corrupt-' + Date.now());
      } catch { /* nothing to preserve */ }
      this._manifest = { version: 1, entries: [] };
    }
  }

  async _save() {
    // Write to a temp file then rename, so an interrupted write cannot leave a
    // half-written manifest that loses track of quarantined data.
    const tmp = this.manifestPath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this._manifest, null, 2), 'utf8');
    await fsp.rename(tmp, this.manifestPath);
  }

  list() {
    return this._manifest.entries.map((e) => ({ ...e }));
  }

  get(id) {
    const e = this._manifest.entries.find((x) => x.id === id);
    return e ? { ...e } : null;
  }

  /** Total bytes currently held in quarantine. */
  totalBytes() {
    return this._manifest.entries.reduce((n, e) => n + (e.bytes || 0), 0);
  }

  /**
   * Moves `originalPath` into quarantine.
   * @param {object} planEntry the Part-6 plan entry that authorised this removal
   */
  async add(originalPath, planEntry = {}) {
    const st = await fsp.lstat(originalPath);
    const id = crypto.randomUUID();
    const payload = path.join(this.itemsDir, id, path.basename(originalPath));

    const { bytes, files } = await measure(originalPath);
    const move = await safeMove(originalPath, payload);

    const entry = {
      id,
      originalPath: path.resolve(originalPath),
      name: path.basename(originalPath),
      payloadPath: payload,
      isDirectory: st.isDirectory(),
      bytes,
      fileCount: files,
      mode: st.mode,
      mtimeMs: st.mtimeMs,
      quarantinedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.retentionDays * 86400e3).toISOString(),
      moveMethod: move.method,
      hash: move.hash || null,
      // Provenance: why this was removed at all.
      reason: planEntry.reason || null,
      evidence: planEntry.evidence || null,
      category: planEntry.category || null,
      confidence: planEntry.confidence || null,
      source: planEntry.source || null,
    };

    this._manifest.entries.push(entry);
    await this._save();
    return entry;
  }

  /**
   * Puts an entry back where it came from.
   * If something now occupies the original path, restores alongside it under a
   * non-colliding name rather than overwriting whatever is there.
   */
  async restore(id) {
    const idx = this._manifest.entries.findIndex((e) => e.id === id);
    if (idx === -1) throw new Error(`No quarantine entry with id ${id}`);
    const entry = this._manifest.entries[idx];

    try {
      await fsp.access(entry.payloadPath);
    } catch {
      throw new Error(`Quarantined data for ${entry.name} is missing from disk`);
    }

    let dest = entry.originalPath;
    let renamed = false;
    try {
      await fsp.access(dest);
      // Occupied. Restore next to it instead of destroying the occupant.
      const dir = path.dirname(dest);
      const ext = path.extname(entry.name);
      const stem = path.basename(entry.name, ext);
      let n = 2;
      for (;;) {
        const cand = path.join(dir, `${stem} (restored ${n})${ext}`);
        try { await fsp.access(cand); n++; }
        catch { dest = cand; renamed = true; break; }
      }
    } catch { /* original path is free */ }

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const move = await safeMove(entry.payloadPath, dest);

    // Restore the original modification time so the file looks untouched.
    try {
      await fsp.utimes(dest, new Date(), new Date(entry.mtimeMs));
    } catch { /* non-fatal */ }

    await fsp.rm(path.join(this.itemsDir, entry.id), { recursive: true, force: true });
    this._manifest.entries.splice(idx, 1);
    await this._save();

    return { restoredTo: dest, renamed, method: move.method, bytes: entry.bytes };
  }

  /** Permanently removes one entry's payload. Irreversible by design. */
  async forget(id) {
    const idx = this._manifest.entries.findIndex((e) => e.id === id);
    if (idx === -1) throw new Error(`No quarantine entry with id ${id}`);
    const entry = this._manifest.entries[idx];
    await fsp.rm(path.join(this.itemsDir, entry.id), { recursive: true, force: true });
    this._manifest.entries.splice(idx, 1);
    await this._save();
    return { id, bytes: entry.bytes };
  }

  /** Drops entries past their retention date. Returns what it removed. */
  async purgeExpired(now = Date.now()) {
    const expired = this._manifest.entries.filter((e) => Date.parse(e.expiresAt) <= now);
    const removed = [];
    for (const e of expired) {
      await fsp.rm(path.join(this.itemsDir, e.id), { recursive: true, force: true });
      removed.push({ id: e.id, name: e.name, bytes: e.bytes });
    }
    if (removed.length) {
      const gone = new Set(removed.map((r) => r.id));
      this._manifest.entries = this._manifest.entries.filter((e) => !gone.has(e.id));
      await this._save();
    }
    return removed;
  }

  /**
   * Reconciles the manifest against what is actually on disk.
   * Returns payload directories with no manifest entry, and manifest entries
   * whose payload has vanished. Both are reported rather than silently repaired.
   */
  async audit() {
    const known = new Set(this._manifest.entries.map((e) => e.id));
    let onDisk = [];
    try { onDisk = await fsp.readdir(this.itemsDir); } catch { /* not created yet */ }
    const orphanPayloads = onDisk.filter((d) => !known.has(d));
    const missingPayloads = [];
    for (const e of this._manifest.entries) {
      try { await fsp.access(e.payloadPath); }
      catch { missingPayloads.push({ id: e.id, name: e.name }); }
    }
    return { orphanPayloads, missingPayloads };
  }
}

module.exports = { Quarantine, DEFAULT_RETENTION_DAYS };
