'use strict';
// Persisted preferences.
//
// One file in userData, read once at startup and written on every change. Two
// rules shape it:
//
//   1. Everything is validated on the way in. The renderer is not trusted to
//      send a sane theme name or a plausible model id, so an unknown value is
//      replaced by the default rather than stored and puzzled over later.
//   2. API keys are write-only from the renderer's point of view. They can be
//      set and cleared, and their presence and last four characters can be
//      read, but the bridge never hands the key itself back to the interface.
//      They live here rather than in the repository, which is where the
//      previous version kept them.

const fs = require('fs');
const path = require('path');

const THEMES = ['system', 'light', 'dark'];
const LAYOUTS = ['details', 'list', 'tiles', 'icons'];
const SORT_KEYS = ['name', 'mtimeMs', 'typeLabel', 'size'];

function defaults() {
  return {
    theme: 'system',
    assistant: {
      model: null,          // null means "whatever the client's default is"
      keys: [],
    },
    files: {
      layout: 'details',
      showHidden: false,
      sortKey: 'name',
      sortDir: 1,
    },
  };
}

/**
 * Coerces anything into a valid settings object. Never throws.
 *
 * `base` is what an invalid or absent field falls back to. Reading the file
 * uses the defaults; applying an update uses the values already stored, so a
 * single bad field in a patch cannot quietly reset the rest of the section to
 * factory settings — which is exactly what it did before, and is the kind of
 * data loss a user would notice only after their layout had gone.
 */
function sanitise(raw, base = defaults()) {
  const out = {
    ...defaults(),
    ...base,
    assistant: { ...defaults().assistant, ...(base.assistant || {}) },
    files: { ...defaults().files, ...(base.files || {}) },
  };
  if (!raw || typeof raw !== 'object') return out;

  if (THEMES.includes(raw.theme)) out.theme = raw.theme;
  else if (!THEMES.includes(out.theme)) out.theme = defaults().theme;

  const a = raw.assistant;
  if (a && typeof a === 'object') {
    if (a.model === null) {
      out.assistant.model = null;            // an explicit "use the default"
    } else if (typeof a.model === 'string' && a.model.trim()) {
      // Model ids are a path segment in the API URL; anything that could change
      // which URL is called is refused rather than encoded around.
      const model = a.model.trim();
      if (/^[A-Za-z0-9._-]{1,80}$/.test(model)) out.assistant.model = model;
    }
    if (Array.isArray(a.keys)) {
      out.assistant.keys = a.keys
        .filter((k) => typeof k === 'string' && k.trim().length >= 8)
        .map((k) => k.trim())
        .slice(0, 8);
    }
  }

  const f = raw.files;
  if (f && typeof f === 'object') {
    if (LAYOUTS.includes(f.layout)) out.files.layout = f.layout;
    if (typeof f.showHidden === 'boolean') out.files.showHidden = f.showHidden;
    if (SORT_KEYS.includes(f.sortKey)) out.files.sortKey = f.sortKey;
    if (f.sortDir === 1 || f.sortDir === -1) out.files.sortDir = f.sortDir;
  }

  return out;
}

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.values = defaults();
    this.load();
  }

  load() {
    try {
      this.values = sanitise(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      this.values = defaults();   // absent or corrupt; the defaults are correct
    }
    return this.values;
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[settings] could not be saved: ${err.message}`);
    }
    return this.values;
  }

  /** Merges a partial update, one section at a time, and persists it. */
  update(patch) {
    this.values = sanitise(patch || {}, this.values);
    return this.save();
  }

  /** What the renderer is allowed to see: everything except the keys. */
  forRenderer() {
    const keys = this.values.assistant.keys;
    return {
      theme: this.values.theme,
      files: { ...this.values.files },
      assistant: {
        model: this.values.assistant.model,
        keyCount: keys.length,
        // Enough to tell one key from another, not enough to use one.
        keyHints: keys.map((k) => `…${k.slice(-4)}`),
        source: keys.length ? 'settings' : null,
      },
    };
  }
}

module.exports = { Settings, defaults, sanitise, THEMES, LAYOUTS, SORT_KEYS };
