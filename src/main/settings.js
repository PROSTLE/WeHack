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

// The overlay's summoning key. Validated as a shape rather than against a list
// of every possible chord: Electron is the authority on whether an accelerator
// can actually be registered, and it reports that at registration time. What is
// checked here is that the string is an accelerator at all, so a corrupt
// settings file cannot make startup throw.
const HOTKEY_PATTERN = /^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)\+)*[A-Za-z0-9]{1,12}$/;
const DEFAULT_HOTKEY = process.platform === 'darwin' ? 'Alt+Space' : 'Control+Alt+Space';
const LAYOUTS = ['details', 'list', 'tiles', 'icons'];

// Which engine turns speech into text in the composer.
//
//   groq   — Whisper large v3 turbo on Groq's free tier. A real speech
//            recognition model, roughly ten times faster than the Gemini path
//            and markedly more accurate. Needs a free key, which is why it is
//            not simply hardcoded as the only option.
//   gemini — the original path, kept as the fallback for someone who has a
//            Gemini key and does not want a second account.
const DICTATION_ENGINES = ['groq', 'gemini'];
const SORT_KEYS = ['name', 'mtimeMs', 'typeLabel', 'size'];

function defaults() {
  return {
    theme: 'system',
    assistant: {
      model: null,          // null means "whatever the client's default is"
      keys: [],
    },
    dictation: {
      // Groq when a key is present, Gemini otherwise. Resolved at call time
      // rather than here, so adding a key upgrades the engine without the user
      // having to find a second setting and change it too.
      engine: 'groq',
      groqKey: '',
    },
    files: {
      layout: 'details',
      showHidden: false,
      sortKey: 'name',
      sortDir: 1,
    },
    overlay: {
      enabled: true,
      hotkey: DEFAULT_HOTKEY,
      // Whether pressing the key opens the microphone as well as the panel.
      // On by default because the panel exists to be spoken to, and off is one
      // click away for someone who would rather type.
      listenOnOpen: true,
      // Whether the panel closes when it loses focus. Off would leave a floating
      // window over everything until dismissed, which some people prefer.
      hideOnBlur: true,
      // "Hey Nexa". Off by default, and it is the only setting in this file
      // that holds a microphone open. Nothing it hears is sent anywhere — the
      // phrase is recognised on this machine; see src/renderer/js/wake.js.
      // It also needs the acoustic model to have been downloaded, which is why
      // switching it on is not by itself enough to make it listen.
      wakeWord: false,
    },
    // Describing files so they can be found by describing them.
    //
    // Off by default, and it is the second setting in this file that has to be
    // — the wake word is the other. Switching it on sends the contents of the
    // files it describes to Google: the pixels of a photo, the text of a
    // document. That is a decision a person makes deliberately, not one they
    // discover afterwards, so nothing here happens until this is true.
    describe: {
      enabled: false,
      // A ceiling on how many files one build will describe, because each one
      // is an API call. The user can raise it; it exists so that pressing the
      // button cannot quietly spend a thousand calls.
      maxFilesPerRun: 200,
      // Whether documents and code are described as well as images. Images are
      // the case this feature exists for and are cheap to describe; a folder of
      // source files is neither.
      includeDocuments: true,
      includeCode: false,
    },
    // Connecting to a cloud account.
    //
    // Only the client IDs live here. They are registered by whoever runs this
    // copy and are not credentials: OAuth calls an installed application a
    // "public client" precisely because it cannot keep a secret, which is why
    // the flow uses PKCE and there is no secret field to fill in. The tokens a
    // sign-in produces are a different matter entirely and are encrypted — see
    // src/main/cloud/accounts.js.
    cloud: {
      googleClientId: '',
      microsoftClientId: '',
    },
  };
}

const DESCRIBE_KINDS = ['includeDocuments', 'includeCode'];

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
    dictation: { ...defaults().dictation, ...(base.dictation || {}) },
    files: { ...defaults().files, ...(base.files || {}) },
    overlay: { ...defaults().overlay, ...(base.overlay || {}) },
    describe: { ...defaults().describe, ...(base.describe || {}) },
    cloud: { ...defaults().cloud, ...(base.cloud || {}) },
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

  const d = raw.dictation;
  if (d && typeof d === 'object') {
    if (DICTATION_ENGINES.includes(d.engine)) out.dictation.engine = d.engine;
    // An empty string is a deliberate "forget my key", so it is accepted where
    // a short non-empty string is refused as a paste that went wrong.
    if (typeof d.groqKey === 'string') {
      const key = d.groqKey.trim();
      if (key === '' || key.length >= 20) out.dictation.groqKey = key;
    }
  }
  if (!DICTATION_ENGINES.includes(out.dictation.engine)) out.dictation.engine = 'groq';

  const o = raw.overlay;
  if (o && typeof o === 'object') {
    if (typeof o.enabled === 'boolean') out.overlay.enabled = o.enabled;
    if (typeof o.listenOnOpen === 'boolean') out.overlay.listenOnOpen = o.listenOnOpen;
    if (typeof o.hideOnBlur === 'boolean') out.overlay.hideOnBlur = o.hideOnBlur;
    if (typeof o.wakeWord === 'boolean') out.overlay.wakeWord = o.wakeWord;
    if (typeof o.hotkey === 'string' && HOTKEY_PATTERN.test(o.hotkey.trim())) {
      out.overlay.hotkey = o.hotkey.trim();
    }
  }
  if (!HOTKEY_PATTERN.test(out.overlay.hotkey || '')) out.overlay.hotkey = DEFAULT_HOTKEY;

  const de = raw.describe;
  if (de && typeof de === 'object') {
    if (typeof de.enabled === 'boolean') out.describe.enabled = de.enabled;
    for (const k of DESCRIBE_KINDS) {
      if (typeof de[k] === 'boolean') out.describe[k] = de[k];
    }
    // Clamped rather than trusted: this number decides how many paid API calls
    // one button press can make.
    const n = Number(de.maxFilesPerRun);
    if (Number.isFinite(n)) {
      out.describe.maxFilesPerRun = Math.min(Math.max(10, Math.round(n)), 5000);
    }
  }

  const cl = raw.cloud;
  if (cl && typeof cl === 'object') {
    // A client id is a path/query value in an OAuth URL, so anything that could
    // change which URL is called is refused rather than encoded around. An empty
    // string is a deliberate "forget it" and is accepted.
    for (const k of ['googleClientId', 'microsoftClientId']) {
      if (typeof cl[k] !== 'string') continue;
      const v = cl[k].trim();
      if (v === '' || /^[A-Za-z0-9._~:@-]{8,200}$/.test(v)) out.cloud[k] = v;
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
      overlay: { ...this.values.overlay },
      describe: { ...this.values.describe },
      assistant: {
        model: this.values.assistant.model,
        keyCount: keys.length,
        // Enough to tell one key from another, not enough to use one.
        keyHints: keys.map((k) => `…${k.slice(-4)}`),
        source: keys.length ? 'settings' : null,
      },
      dictation: {
        engine: this.values.dictation.engine,
        // Same rule as the Gemini keys: presence and a hint, never the key.
        groqConfigured: this.values.dictation.groqKey.length > 0,
        groqKeyHint: this.values.dictation.groqKey
          ? `…${this.values.dictation.groqKey.slice(-4)}`
          : null,
      },
    };
  }
}

module.exports = { Settings, defaults, sanitise, THEMES, LAYOUTS, SORT_KEYS, DICTATION_ENGINES };
