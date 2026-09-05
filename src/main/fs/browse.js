'use strict';
// Directory listing for the Files view.
//
// This is deliberately separate from `fs:readDirectory`, which the assistant's
// tools use. A file manager needs more than names and sizes: it needs the
// hidden and system attributes Explorer honours, the type description Explorer
// prints in its Type column, and an honest per-entry note when something could
// not be read. It also has to keep working when one entry in a folder of ten
// thousand is locked, so every entry is read inside its own try.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { classifyPath } = require('../classify/rules');
const { readDirectoryAttributes, isHiddenByName } = require('./attributes');

// The Type column. Explorer reads these from the registry, per machine; this is
// a fixed table of the descriptions Windows ships, with a generic fallback that
// matches Explorer's own wording for anything unregistered ("XYZ File").
const TYPE_NAMES = Object.assign(Object.create(null), {
  exe: 'Application', msi: 'Windows Installer Package', bat: 'Windows Batch File',
  cmd: 'Windows Command Script', ps1: 'Windows PowerShell Script',
  dll: 'Application Extension', sys: 'System File', ini: 'Configuration Settings',
  lnk: 'Shortcut', url: 'Internet Shortcut', reg: 'Registration Entries',
  txt: 'Text Document', md: 'Markdown Document', log: 'Text Document',
  rtf: 'Rich Text Document', pdf: 'PDF Document',
  doc: 'Microsoft Word Document', docx: 'Microsoft Word Document',
  xls: 'Microsoft Excel Worksheet', xlsx: 'Microsoft Excel Worksheet',
  csv: 'Comma Separated Values File',
  ppt: 'Microsoft PowerPoint Presentation', pptx: 'Microsoft PowerPoint Presentation',
  zip: 'Compressed (zipped) Folder', rar: 'RAR Archive', '7z': '7z Archive',
  tar: 'TAR Archive', gz: 'GZ Archive', iso: 'Disc Image File',
  jpg: 'JPG File', jpeg: 'JPEG File', png: 'PNG File', gif: 'GIF File',
  bmp: 'BMP File', webp: 'WEBP File', svg: 'SVG Document', ico: 'Icon',
  heic: 'HEIC File', tif: 'TIF File', tiff: 'TIFF File',
  mp4: 'MP4 Video', mkv: 'Matroska Video', mov: 'QuickTime Movie',
  avi: 'AVI Video', webm: 'WEBM Video', wmv: 'Windows Media Video',
  mp3: 'MP3 Audio', wav: 'Wave Audio', flac: 'FLAC Audio', m4a: 'M4A Audio',
  aac: 'AAC Audio', ogg: 'OGG Audio',
  html: 'HTML Document', htm: 'HTML Document', css: 'Cascading Style Sheet',
  js: 'JavaScript File', ts: 'TypeScript File', json: 'JSON File',
  xml: 'XML Document', yml: 'YAML File', yaml: 'YAML File',
  py: 'Python File', java: 'Java Source File', c: 'C Source File',
  cpp: 'C++ Source File', cs: 'C# Source File', rs: 'Rust Source File',
  go: 'Go Source File', sh: 'Shell Script', db: 'Data Base File',
  sqlite: 'Data Base File', ttf: 'TrueType Font File', otf: 'OpenType Font File',
  woff: 'Web Open Font Format', woff2: 'Web Open Font Format',
  torrent: 'BitTorrent File', apk: 'Android Package', dmg: 'Apple Disk Image',
});

// How many entries are examined at once. Measured on this machine: 5,000 files
// take 755 ms one at a time and 117 ms in batches of this size.
const STAT_BATCH = 128;

/** Files Windows will launch as code. Opening one is not the same as viewing it. */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'msc', 'cpl', 'jar', 'reg', 'app', 'sh', 'appimage', 'run',
  // A shortcut runs whatever it points at, which may well be any of the above.
  'lnk',
]);

function typeLabel(entry) {
  if (entry.isDirectory) return 'File folder';
  const ext = entry.extension;
  if (!ext) return 'File';
  return TYPE_NAMES[ext] || `${ext.toUpperCase()} File`;
}

function isExecutable(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXECUTABLE_EXTENSIONS.has(ext);
}

/**
 * Breadcrumb segments for a path, starting at its volume root.
 * C:\Users\HP\Pictures becomes C:\ then Users, HP, Pictures.
 */
function pathSegments(target) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const rest = resolved.slice(root.length).split(/[\\/]/).filter(Boolean);
  const segments = [{ name: root, path: root, isRoot: true }];
  let acc = root;
  for (const part of rest) {
    acc = path.join(acc, part);
    segments.push({ name: part, path: acc, isRoot: false });
  }
  return segments;
}

/** The containing directory, or null when already at a volume root. */
function parentOf(target) {
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  return parent === resolved ? null : parent;
}

/**
 * Lists one directory.
 *
 * Hidden and system entries are always returned, tagged; filtering them is the
 * view's decision, exactly as it is in Explorer's Options dialog. Nothing is
 * omitted silently: an entry whose metadata could not be read is returned with
 * `unreadable` set and the reason attached.
 *
 * @param {string} dirPath already resolved and checked against approved roots
 * @param {(p:string)=>string|null} isDenied protected-location test
 */
async function listDirectory(dirPath, { isDenied = () => null } = {}) {
  const dirents = await fsp.readdir(dirPath, { withFileTypes: true });
  const attrs = await readDirectoryAttributes(dirPath);

  let unreadableCount = 0;

  /** Everything known about one entry. Its own failure stays its own. */
  async function describe(d) {
    const full = path.join(dirPath, d.name);
    const lower = d.name.toLowerCase();
    const entry = {
      name: d.name,
      path: full,
      isDirectory: d.isDirectory(),
      isSymlink: d.isSymbolicLink(),
      extension: d.isDirectory() ? null : (path.extname(d.name).slice(1).toLowerCase() || null),
      size: null,
      mtimeMs: null,
      atimeMs: null,
      birthMs: null,
      readOnly: false,
      hidden: attrs ? attrs.hidden.has(lower) : isHiddenByName(d.name),
      system: attrs ? attrs.system.has(lower) : false,
      unreadable: null,
      protectedBy: null,
    };

    try {
      const st = await fsp.lstat(full);
      // A junction or symlink is sized and dated by its own record, not its
      // target. That is what Explorer shows for one too.
      entry.isSymlink = st.isSymbolicLink();
      if (entry.isSymlink) {
        try {
          const target = await fsp.stat(full);
          entry.isDirectory = target.isDirectory();
          entry.linkTarget = await fsp.readlink(full).catch(() => null);
        } catch { entry.linkBroken = true; }
      } else {
        entry.isDirectory = st.isDirectory();
      }
      entry.size = entry.isDirectory ? null : st.size;
      entry.mtimeMs = st.mtimeMs;
      entry.atimeMs = st.atimeMs;
      entry.birthMs = st.birthtimeMs;
      // 0o200 is the owner-write bit; Windows clears it for a read-only file.
      entry.readOnly = !(st.mode & 0o200);
    } catch (err) {
      entry.unreadable = err.code || 'EACCES';
      unreadableCount++;
    }

    const c = classifyPath(full, { isDirectory: entry.isDirectory });
    entry.type = c.type;
    entry.category = c.category;
    entry.typeLabel = typeLabel(entry);
    entry.executable = !entry.isDirectory && isExecutable(full);
    entry.protectedBy = isDenied(full);
    return entry;
  }

  // Statting five thousand files one after another takes about three quarters
  // of a second, and a folder of five thousand files is an ordinary Downloads
  // folder. In batches the same work takes about a tenth of that, because the
  // wait is the filesystem answering rather than this process thinking. The
  // batch is bounded so a folder of a hundred thousand entries cannot open a
  // hundred thousand handles at once.
  const entries = [];
  for (let i = 0; i < dirents.length; i += STAT_BATCH) {
    entries.push(...await Promise.all(dirents.slice(i, i + STAT_BATCH).map(describe)));
  }

  const files = entries.filter((e) => !e.isDirectory);
  return {
    path: path.resolve(dirPath),
    parent: parentOf(dirPath),
    segments: pathSegments(dirPath),
    entries,
    attributesRead: attrs !== null,
    counts: {
      total: entries.length,
      folders: entries.length - files.length,
      files: files.length,
      hidden: entries.filter((e) => e.hidden || e.system).length,
      unreadable: unreadableCount,
      bytes: files.reduce((n, f) => n + (f.size || 0), 0),
    },
  };
}

/** Immediate subfolders, for the navigation tree. Cheap: no per-entry stat. */
async function listSubfolders(dirPath, { isDenied = () => null, limit = 400 } = {}) {
  const dirents = await fsp.readdir(dirPath, { withFileTypes: true });
  const attrs = await readDirectoryAttributes(dirPath);
  const out = [];
  for (const d of dirents) {
    if (out.length >= limit) break;
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    const full = path.join(dirPath, d.name);
    if (d.isSymbolicLink()) {
      try { if (!(await fsp.stat(full)).isDirectory()) continue; } catch { continue; }
    }
    out.push({
      name: d.name,
      path: full,
      hidden: attrs ? attrs.hidden.has(d.name.toLowerCase()) : isHiddenByName(d.name),
      system: attrs ? attrs.system.has(d.name.toLowerCase()) : false,
      protectedBy: isDenied(full),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return out;
}

module.exports = {
  listDirectory,
  listSubfolders,
  pathSegments,
  parentOf,
  typeLabel,
  isExecutable,
  TYPE_NAMES,
  EXECUTABLE_EXTENSIONS,
};
