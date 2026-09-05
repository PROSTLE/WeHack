'use strict';
// Deterministic, rule-based file classification.
//
// This replaces a TF-IDF model that was trained on a synthetic dataset the
// training script generated from random word lists. Its confidence scores were
// not measurements of anything.
//
// Every result here is explainable in one sentence, needs no training data, and
// runs at walk speed. Three signals, in order of authority:
//
//   1. Magic bytes  — what the file actually is. Authoritative when read.
//   2. Path context — where it lives. A file under AppData/Cache is a cache
//                     regardless of its extension.
//   3. Extension    — what it claims to be. Weakest signal, and the only one
//                     available during a fast walk.
//
// When 1 and 3 disagree the mismatch is reported rather than silently resolved.

const path = require('path');

// Treemap categories. These map to the five pigments in the UI and nowhere else.
const CATEGORY = Object.freeze({
  APPLICATIONS: 'applications',
  DOCUMENTS: 'documents',
  MEDIA: 'media',
  CACHE: 'cache',
  SYSTEM: 'system',
});

// Null-prototype: a file whose extension is "constructor", "__proto__" or any
// other Object.prototype member must not resolve to an inherited function.
// Real files in AppData/Local triggered exactly this and produced an undefined
// category, which SQLite then rejected.
const EXT_TYPES = Object.assign(Object.create(null), {
  // documents
  pdf: ['pdf', CATEGORY.DOCUMENTS], doc: ['document', CATEGORY.DOCUMENTS],
  docx: ['document', CATEGORY.DOCUMENTS], odt: ['document', CATEGORY.DOCUMENTS],
  rtf: ['document', CATEGORY.DOCUMENTS], txt: ['text', CATEGORY.DOCUMENTS],
  md: ['text', CATEGORY.DOCUMENTS], xls: ['spreadsheet', CATEGORY.DOCUMENTS],
  xlsx: ['spreadsheet', CATEGORY.DOCUMENTS], csv: ['spreadsheet', CATEGORY.DOCUMENTS],
  ods: ['spreadsheet', CATEGORY.DOCUMENTS], ppt: ['presentation', CATEGORY.DOCUMENTS],
  pptx: ['presentation', CATEGORY.DOCUMENTS], odp: ['presentation', CATEGORY.DOCUMENTS],
  epub: ['ebook', CATEGORY.DOCUMENTS], mobi: ['ebook', CATEGORY.DOCUMENTS],

  // media
  jpg: ['image', CATEGORY.MEDIA], jpeg: ['image', CATEGORY.MEDIA],
  png: ['image', CATEGORY.MEDIA], gif: ['image', CATEGORY.MEDIA],
  bmp: ['image', CATEGORY.MEDIA], webp: ['image', CATEGORY.MEDIA],
  tif: ['image', CATEGORY.MEDIA], tiff: ['image', CATEGORY.MEDIA],
  heic: ['image', CATEGORY.MEDIA], svg: ['image', CATEGORY.MEDIA],
  ico: ['image', CATEGORY.MEDIA], raw: ['image', CATEGORY.MEDIA],
  cr2: ['image', CATEGORY.MEDIA], nef: ['image', CATEGORY.MEDIA],
  dng: ['image', CATEGORY.MEDIA],
  mp4: ['video', CATEGORY.MEDIA], mkv: ['video', CATEGORY.MEDIA],
  mov: ['video', CATEGORY.MEDIA], avi: ['video', CATEGORY.MEDIA],
  wmv: ['video', CATEGORY.MEDIA], webm: ['video', CATEGORY.MEDIA],
  flv: ['video', CATEGORY.MEDIA], m4v: ['video', CATEGORY.MEDIA],
  mp3: ['audio', CATEGORY.MEDIA], wav: ['audio', CATEGORY.MEDIA],
  flac: ['audio', CATEGORY.MEDIA], aac: ['audio', CATEGORY.MEDIA],
  ogg: ['audio', CATEGORY.MEDIA], m4a: ['audio', CATEGORY.MEDIA],
  wma: ['audio', CATEGORY.MEDIA],

  // applications and their payloads
  exe: ['executable', CATEGORY.APPLICATIONS], msi: ['installer', CATEGORY.APPLICATIONS],
  dll: ['library', CATEGORY.APPLICATIONS], so: ['library', CATEGORY.APPLICATIONS],
  dylib: ['library', CATEGORY.APPLICATIONS], app: ['application', CATEGORY.APPLICATIONS],
  dmg: ['disk-image', CATEGORY.APPLICATIONS], pkg: ['installer', CATEGORY.APPLICATIONS],
  deb: ['package', CATEGORY.APPLICATIONS], rpm: ['package', CATEGORY.APPLICATIONS],
  appimage: ['application', CATEGORY.APPLICATIONS],
  zip: ['archive', CATEGORY.APPLICATIONS], rar: ['archive', CATEGORY.APPLICATIONS],
  '7z': ['archive', CATEGORY.APPLICATIONS], tar: ['archive', CATEGORY.APPLICATIONS],
  gz: ['archive', CATEGORY.APPLICATIONS], bz2: ['archive', CATEGORY.APPLICATIONS],
  xz: ['archive', CATEGORY.APPLICATIONS], iso: ['disk-image', CATEGORY.APPLICATIONS],

  // code — documents category, because it is user-authored work
  js: ['code', CATEGORY.DOCUMENTS], ts: ['code', CATEGORY.DOCUMENTS],
  jsx: ['code', CATEGORY.DOCUMENTS], tsx: ['code', CATEGORY.DOCUMENTS],
  py: ['code', CATEGORY.DOCUMENTS], java: ['code', CATEGORY.DOCUMENTS],
  c: ['code', CATEGORY.DOCUMENTS], h: ['code', CATEGORY.DOCUMENTS],
  cpp: ['code', CATEGORY.DOCUMENTS], cs: ['code', CATEGORY.DOCUMENTS],
  go: ['code', CATEGORY.DOCUMENTS], rs: ['code', CATEGORY.DOCUMENTS],
  rb: ['code', CATEGORY.DOCUMENTS], php: ['code', CATEGORY.DOCUMENTS],
  swift: ['code', CATEGORY.DOCUMENTS], kt: ['code', CATEGORY.DOCUMENTS],
  html: ['code', CATEGORY.DOCUMENTS], css: ['code', CATEGORY.DOCUMENTS],
  json: ['data', CATEGORY.DOCUMENTS], xml: ['data', CATEGORY.DOCUMENTS],
  yml: ['data', CATEGORY.DOCUMENTS], yaml: ['data', CATEGORY.DOCUMENTS],
  sql: ['data', CATEGORY.DOCUMENTS],

  // regenerable
  log: ['log', CATEGORY.CACHE], tmp: ['temporary', CATEGORY.CACHE],
  temp: ['temporary', CATEGORY.CACHE], cache: ['cache', CATEGORY.CACHE],
  bak: ['backup', CATEGORY.CACHE], old: ['backup', CATEGORY.CACHE],
  crashlog: ['crash-report', CATEGORY.CACHE], dmp: ['crash-report', CATEGORY.CACHE],
  thumbdata: ['thumbnail', CATEGORY.CACHE],

  // system
  sys: ['system', CATEGORY.SYSTEM], dat: ['data', CATEGORY.SYSTEM],
  db: ['database', CATEGORY.SYSTEM], sqlite: ['database', CATEGORY.SYSTEM],
  lnk: ['shortcut', CATEGORY.SYSTEM], ini: ['configuration', CATEGORY.SYSTEM],
  cfg: ['configuration', CATEGORY.SYSTEM], plist: ['configuration', CATEGORY.SYSTEM],
  ttf: ['font', CATEGORY.SYSTEM], otf: ['font', CATEGORY.SYSTEM],
  woff: ['font', CATEGORY.SYSTEM], woff2: ['font', CATEGORY.SYSTEM],
});

// Path fragments that mark regenerable data. Matched case-insensitively against
// individual path segments, so a folder literally named "Cache" matches but a
// document called "cache-design-notes.pdf" does not.
const CACHE_SEGMENTS = new Set([
  'cache', 'caches', 'cachestorage', 'code cache', 'gpucache', 'shadercache',
  'temp', 'tmp', 'temporary internet files', 'logs', 'log', 'crashreports',
  'crash reports', 'crashdumps', 'diagnosticreports', 'thumbnails', 'thumbs',
  'webcache', 'inetcache', 'service worker', 'blob_storage', '.cache',
  'saved application state', 'crashpad', 'minidump',
]);

// Segments that mark user data. These outrank cache detection: a preferences
// file inside an app support folder is still the user's data.
const USER_DATA_SEGMENTS = new Set([
  'documents', 'desktop', 'pictures', 'photos', 'music', 'videos', 'movies',
  'downloads', 'projects', 'saves', 'savegames', 'saved games', 'preferences',
  'licenses', 'license', 'mail', 'keychains', 'contacts', 'bookmarks',
]);

function segmentsOf(p) {
  return p.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
}

/**
 * Fast classification from path alone. This is what runs during the walk.
 * @returns {{type: string, category: string, reason: string}}
 */
function classifyPath(filePath, { isDirectory = false } = {}) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const segs = segmentsOf(filePath);
  const parentSegs = segs.slice(0, -1);

  // Path context outranks extension for regenerable data, but user-data
  // locations outrank both.
  const userDataHit = parentSegs.find((s) => USER_DATA_SEGMENTS.has(s));
  const cacheHit = parentSegs.find((s) => CACHE_SEGMENTS.has(s));

  const entry = EXT_TYPES[ext];
  // Only trust a well-formed [type, category] pair.
  const known = Array.isArray(entry) && typeof entry[0] === 'string' ? entry : null;

  if (cacheHit && !userDataHit) {
    return {
      type: known ? known[0] : (isDirectory ? 'folder' : 'file'),
      category: CATEGORY.CACHE,
      reason: `Inside a folder named "${cacheHit}"`,
    };
  }

  if (known) {
    return {
      type: known[0],
      category: known[1],
      reason: `Extension .${ext}`,
    };
  }

  // An unrecognised file inside one of the user's own folders is the user's
  // data, not "system". Defaulting it to system made a scan of Documents report
  // most of its contents as unclassified system files, which is both wrong and
  // useless: game saves, project files and application-specific formats all
  // live under Documents and all belong to the user.
  if (userDataHit) {
    return {
      type: isDirectory ? 'folder' : (ext ? `.${ext}` : 'unknown'),
      category: CATEGORY.DOCUMENTS,
      reason: `Inside your "${userDataHit}" folder`,
    };
  }

  if (isDirectory) {
    return { type: 'folder', category: CATEGORY.SYSTEM, reason: 'Directory' };
  }

  return {
    type: ext ? `.${ext}` : 'unknown',
    category: CATEGORY.SYSTEM,
    reason: ext ? `Unrecognised extension .${ext}` : 'No extension',
  };
}

// Magic-byte signatures. Offset 0 unless stated.
const MAGIC = [
  { type: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46], exts: ['pdf'] },
  { type: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], exts: ['png'] },
  { type: 'jpeg', bytes: [0xff, 0xd8, 0xff], exts: ['jpg', 'jpeg'] },
  { type: 'gif', bytes: [0x47, 0x49, 0x46, 0x38], exts: ['gif'] },
  { type: 'bmp', bytes: [0x42, 0x4d], exts: ['bmp'] },
  { type: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04], exts: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'jar', 'apk'] },
  { type: 'rar', bytes: [0x52, 0x61, 0x72, 0x21], exts: ['rar'] },
  { type: '7z', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], exts: ['7z'] },
  { type: 'gzip', bytes: [0x1f, 0x8b], exts: ['gz', 'tgz'] },
  { type: 'pe-executable', bytes: [0x4d, 0x5a], exts: ['exe', 'dll', 'sys', 'msi', 'scr'] },
  { type: 'elf', bytes: [0x7f, 0x45, 0x4c, 0x46], exts: ['so', 'elf', 'bin', ''] },
  { type: 'sqlite', bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65], exts: ['db', 'sqlite', 'sqlite3'] },
  { type: 'ogg', bytes: [0x4f, 0x67, 0x67, 0x53], exts: ['ogg', 'oga', 'ogv'] },
  { type: 'flac', bytes: [0x66, 0x4c, 0x61, 0x43], exts: ['flac'] },
  { type: 'mp3', bytes: [0x49, 0x44, 0x33], exts: ['mp3'] },
  { type: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], exts: ['webp', 'wav', 'avi'] },
  { type: 'mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, exts: ['mp4', 'm4v', 'm4a', 'mov', 'heic'] },
];

/**
 * Confirms what a file actually is from its leading bytes.
 * @param {Buffer} head first ~16 bytes
 * @returns {{actual: string|null, matchesExtension: boolean|null, note: string}}
 */
function classifyMagic(head, filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!head || head.length < 2) {
    return { actual: null, matchesExtension: null, note: 'File too short to identify' };
  }

  for (const sig of MAGIC) {
    const off = sig.offset || 0;
    if (head.length < off + sig.bytes.length) continue;
    let hit = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (head[off + i] !== sig.bytes[i]) { hit = false; break; }
    }
    if (!hit) continue;

    const matches = sig.exts.includes(ext);
    return {
      actual: sig.type,
      matchesExtension: matches,
      note: matches
        ? `Content confirms .${ext} (${sig.type} signature)`
        : `Content is ${sig.type}, but the file is named .${ext}`,
    };
  }

  return {
    actual: null,
    matchesExtension: null,
    note: 'No recognised file signature',
  };
}

/** True when the path sits inside a location whose contents regenerate. */
function isRegenerablePath(filePath) {
  const segs = segmentsOf(filePath);
  if (segs.some((s) => USER_DATA_SEGMENTS.has(s))) return false;
  return segs.some((s) => CACHE_SEGMENTS.has(s));
}

module.exports = {
  CATEGORY,
  classifyPath,
  classifyMagic,
  isRegenerablePath,
  EXT_TYPES,
  CACHE_SEGMENTS,
  USER_DATA_SEGMENTS,
};
