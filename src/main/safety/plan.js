'use strict';
// The plan: stage 1 of the safety pipeline.
//
// Nothing in this application deletes anything directly. Scanners and the agent
// both produce a Plan, the UI renders it, the user approves specific entries, and
// only then does the executor act. A plan is inert data.
//
// Two invariants are enforced here rather than left to callers:
//   1. An entry without concrete evidence is rejected. If the code cannot say why
//      a file is reclaimable, the user must not be asked to approve deleting it.
//   2. An entry categorised `user-data` is never selected by default, regardless
//      of what the producing scanner asked for.

const crypto = require('crypto');
const path = require('path');

const CATEGORY = Object.freeze({
  REGENERABLE: 'regenerable',   // caches, logs, crash reports, thumbnails
  USER_DATA: 'user-data',       // licences, saves, projects, mail, preferences
});

const ACTION = Object.freeze({
  TRASH: 'trash',               // user-visible files -> OS trash
  QUARANTINE: 'quarantine',     // app internals -> reversible app-managed store
});

const CONFIDENCE = Object.freeze({
  HIGH: 'high',                 // deterministic: byte-identical hash, exact match
  MEDIUM: 'medium',             // strong heuristic with named evidence
  LOW: 'low',                   // suggestive only; never pre-selected
});

class PlanEntry {
  constructor(spec) {
    const missing = [];
    if (!spec.path) missing.push('path');
    if (!spec.action) missing.push('action');
    if (!spec.reason) missing.push('reason');
    if (!spec.evidence) missing.push('evidence');
    if (!spec.category) missing.push('category');
    if (missing.length) {
      throw new Error(
        `Plan entry is missing required field(s): ${missing.join(', ')}. ` +
        `Every entry must carry the concrete evidence that produced it.`
      );
    }
    if (!Object.values(ACTION).includes(spec.action)) {
      throw new Error(`Unknown action "${spec.action}"`);
    }
    if (!Object.values(CATEGORY).includes(spec.category)) {
      throw new Error(`Unknown category "${spec.category}"`);
    }
    if (typeof spec.bytes !== 'number' || !Number.isFinite(spec.bytes) || spec.bytes < 0) {
      throw new Error(
        `Plan entry for ${spec.path} has no measured byte size. ` +
        `Sizes must be measured on disk, never estimated.`
      );
    }

    this.id = crypto.randomUUID();
    this.path = path.resolve(spec.path);
    this.name = path.basename(this.path);
    this.action = spec.action;
    this.bytes = spec.bytes;
    this.fileCount = spec.fileCount ?? 1;
    this.isDirectory = !!spec.isDirectory;
    this.reason = spec.reason;
    this.evidence = spec.evidence;          // string, or array of strings
    this.category = spec.category;
    this.confidence = spec.confidence || CONFIDENCE.MEDIUM;
    this.source = spec.source || 'unknown'; // which scanner produced this
    this.group = spec.group || null;        // e.g. a duplicate-set id

    // Invariant 2. Anything that is user data, or that the code is not confident
    // about, starts unselected no matter what the producer requested.
    this.selected =
      this.category === CATEGORY.REGENERABLE &&
      this.confidence !== CONFIDENCE.LOW &&
      spec.selected !== false;
  }
}

class Plan {
  constructor({ source, title, roots = [], notes = [] } = {}) {
    this.id = crypto.randomUUID();
    this.createdAt = new Date().toISOString();
    this.source = source || 'unknown';
    this.title = title || 'Cleanup plan';
    this.roots = roots;
    // Honest caveats shown alongside the plan: incomplete enumeration,
    // permissions that were denied, scanners that were skipped.
    this.notes = notes;
    this.entries = [];
    this.approved = false;
    this.approvedAt = null;
  }

  add(spec) {
    const e = new PlanEntry(spec);
    this.entries.push(e);
    return e;
  }

  addNote(text) {
    if (text && !this.notes.includes(text)) this.notes.push(text);
    return this;
  }

  /** Byte and count totals, split by category and by selection state. */
  totals() {
    const t = {
      itemCount: this.entries.length,
      bytes: 0,
      selectedCount: 0,
      selectedBytes: 0,
      regenerable: { count: 0, bytes: 0 },
      userData: { count: 0, bytes: 0 },
    };
    for (const e of this.entries) {
      t.bytes += e.bytes;
      if (e.selected) { t.selectedCount++; t.selectedBytes += e.bytes; }
      const bucket = e.category === CATEGORY.USER_DATA ? t.userData : t.regenerable;
      bucket.count++;
      bucket.bytes += e.bytes;
    }
    return t;
  }

  /** Entries grouped for display: regenerable first, user data separated. */
  grouped() {
    return {
      regenerable: this.entries.filter((e) => e.category === CATEGORY.REGENERABLE),
      userData: this.entries.filter((e) => e.category === CATEGORY.USER_DATA),
    };
  }

  setSelection(ids) {
    const want = new Set(ids);
    for (const e of this.entries) e.selected = want.has(e.id);
    return this.totals();
  }

  selectedEntries() {
    return this.entries.filter((e) => e.selected);
  }

  /** Stage 3. Approval is explicit, per-plan, and cannot be defaulted on. */
  approve() {
    this.approved = true;
    this.approvedAt = new Date().toISOString();
    return this;
  }

  /** Plain object for IPC. */
  toJSON() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      source: this.source,
      title: this.title,
      roots: this.roots,
      notes: this.notes,
      entries: this.entries.map((e) => ({ ...e })),
      totals: this.totals(),
      approved: this.approved,
    };
  }
}

module.exports = { Plan, PlanEntry, CATEGORY, ACTION, CONFIDENCE };
