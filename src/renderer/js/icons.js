// One icon set, drawn to a single convention: 24x24 viewBox, 2px stroke,
// round caps and joins, no fills. Every icon carries meaning — a file type, a
// destructive action, a state. Nothing here is decoration; an icon that sat
// beside a heading purely for texture would be deleted.
//
// These are hand-drawn to the same geometric grid Lucide uses rather than
// bundled from it, so the application ships no third-party icon assets. Lucide
// itself is ISC licensed (MIT for Feather-derived icons) and would have been
// fine to bundle; drawing them simply keeps the dependency count at zero.
//
// There are no emoji anywhere in this application.

const PATHS = {
  // navigation and structure
  disk:      '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  folder:    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file:      '<path d="M14 3v5h5"/><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z"/>',
  home:      '<path d="M4 11 12 4l8 7"/><path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9"/>',
  layers:    '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  chevron:   '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',

  // file types
  image:     '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m3 16 5-4 4 3 3-2 6 5"/>',
  video:     '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
  audio:     '<path d="M9 18V5l10-2v13"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="16" r="2"/>',
  document:  '<path d="M14 3v5h5"/><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z"/><path d="M9 13h6M9 17h4"/>',
  archive:   '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>',
  code:      '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/>',
  app:       '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  cache:     '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',

  // actions
  scan:      '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  trash:     '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  quarantine:'<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"/><path d="M9 12h6"/>',
  restore:   '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v5h5"/>',
  cancel:    '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  check:     '<path d="m5 13 4 4 10-10"/>',
  plus:      '<path d="M12 5v14M5 12h14"/>',
  external:  '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  send:      '<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>',

  // state
  info:      '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.6" fill="currentColor"/>',
  caution:   '<path d="M12 4 3 19h18z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>',
  clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  copies:    '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  power:     '<path d="M12 4v8"/><path d="M7.5 7a7 7 0 1 0 9 0"/>',
  activity:  '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  chat:      '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4z"/>',
  shield:    '<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z"/>',
  eye:       '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>',

  // session and profile
  gauge:     '<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 14 4-4"/><circle cx="12" cy="18" r="1.2" fill="currentColor"/>',
  cpu:       '<rect x="7" y="7" width="10" height="10" rx="1.5"/><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
  memory:    '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 17v3M12 17v3M17 17v3M7 7V4M12 7V4M17 7V4"/>',
  user:      '<circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  sparkle:   '<path d="M12 4v6M12 14v6M4 12h6M14 12h6"/>',
  trendUp:   '<path d="M4 16 10 10l4 4 6-6"/><path d="M15 8h5v5"/>',
  trendDown: '<path d="M4 8 10 14l4-4 6 6"/><path d="M15 16h5v-5"/>',
  download:  '<path d="M12 4v10"/><path d="m8 11 4 4 4-4"/><path d="M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1"/>',

  // files view
  arrowLeft: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  arrowUp:   '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  refresh:   '<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v5h-5"/>',
  drive:     '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 13h18"/><circle cx="7.5" cy="16" r="1" fill="currentColor"/>',
  pc:        '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  folderOpen:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z"/><path d="M3 10h18l-2 8a2 2 0 0 1-2 1.6H5A2 2 0 0 1 3 18z"/>',
  folderPlus:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  copyFile:  '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  cut:       '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 4l8 12M16 4 8 16"/>',
  paste:     '<path d="M9 4h6v3H9z"/><path d="M9 5.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5a2 2 0 0 0-2-2h-2"/>',
  rename:    '<path d="M4 20h16"/><path d="M6 15.5 15.5 6a2.1 2.1 0 0 1 3 3L9 18.5l-4 1z"/>',
  sort:      '<path d="M4 7h13M4 12h9M4 17h5"/><path d="m17 13 3 3 3-3"/>',
  layout:    '<rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="15" width="7" height="5" rx="1"/><rect x="14" y="15" width="7" height="5" rx="1"/>',
  rows:      '<path d="M4 7h16M4 12h16M4 17h16"/>',
  eyeOff:    '<path d="M3 3l18 18"/><path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.3 3.9"/><path d="M6.3 8.1C3.7 9.7 2 12 2 12s3.5 6 10 6a10 10 0 0 0 3.7-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  attach:    '<path d="M20 11.5 12.2 19a4.5 4.5 0 0 1-6.4-6.4l8-7.8a3 3 0 0 1 4.2 4.2l-7.9 7.8a1.5 1.5 0 0 1-2.1-2.1l7.3-7.2"/>',
  x:         '<path d="M6 6l12 12M18 6 6 18"/>',
  mic:       '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  micOff:    '<path d="M3 3l18 18"/><path d="M15 5v-.5a3 3 0 0 0-6-.4"/><path d="M9 9v2a3 3 0 0 0 4.6 2.5"/><path d="M5 11a7 7 0 0 0 10.3 6.2"/><path d="M19 11a7 7 0 0 1-.5 2.6"/><path d="M12 18v3"/>',
  stopSquare:'<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  properties:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.6" fill="currentColor"/>',
  lock:      '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  link:      '<path d="M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6"/><path d="M14 11a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 19.7l1.5-1.5"/>',

  // window controls
  minimize:  '<path d="M5 12h14"/>',
  maximize:  '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  close:     '<path d="M6 6l12 12M18 6 6 18"/>',
};

/** Returns an <svg> string for the named icon. */
export function icon(name, { size = 16, className = '' } = {}) {
  const d = PATHS[name];
  if (!d) return '';
  return `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/** Maps a classified file type to the icon that distinguishes it. */
export function iconForType(type, isDirectory) {
  if (isDirectory) return 'folder';
  switch (type) {
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'pdf': case 'document': case 'text': case 'spreadsheet':
    case 'presentation': case 'ebook': return 'document';
    case 'archive': case 'disk-image': case 'package': case 'installer': return 'archive';
    case 'code': case 'data': return 'code';
    case 'executable': case 'library': case 'application': return 'app';
    case 'cache': case 'log': case 'temporary': case 'crash-report':
    case 'thumbnail': case 'backup': return 'cache';
    default: return 'file';
  }
}

/* ── Illustrations ─────────────────────────────────────────────────────────
 *
 * Three, and only three: the first run, a scan that found nothing reclaimable,
 * and an empty quarantine. These are the three moments where the screen would
 * otherwise be blank and the user needs orientation. They are deliberately
 * absent from every working surface — a tool someone stares at for an hour
 * needs quiet, not personality.
 *
 * Drawn flat, muted, and in the same palette as the interface.
 */

const ILLUSTRATION = {
  // First run: an unmeasured disk. Outlined blocks, nothing filled in yet.
  firstRun: `
    <svg class="illustration" viewBox="0 0 200 150" fill="none" aria-hidden="true">
      <rect x="18" y="20" width="164" height="112" rx="6" stroke="var(--il-line)" stroke-width="2"/>
      <rect x="32" y="36" width="62" height="46" rx="3" stroke="var(--il-detail)" stroke-width="2" stroke-dasharray="5 4"/>
      <rect x="102" y="36" width="66" height="28" rx="3" stroke="var(--il-detail)" stroke-width="2" stroke-dasharray="5 4"/>
      <rect x="102" y="72" width="30" height="44" rx="3" stroke="var(--il-detail)" stroke-width="2" stroke-dasharray="5 4"/>
      <rect x="140" y="72" width="28" height="20" rx="3" stroke="var(--il-detail)" stroke-width="2" stroke-dasharray="5 4"/>
      <rect x="32" y="92" width="62" height="24" rx="3" stroke="var(--il-detail)" stroke-width="2" stroke-dasharray="5 4"/>
      <circle cx="150" cy="112" r="15" stroke="var(--pig-1)" stroke-width="2.5"/>
      <path d="m161 123 8 8" stroke="var(--pig-1)" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`,

  // Nothing reclaimable: the map is full, every block accounted for.
  nothingFound: `
    <svg class="illustration" viewBox="0 0 200 150" fill="none" aria-hidden="true">
      <rect x="18" y="20" width="164" height="112" rx="6" stroke="var(--il-line)" stroke-width="2"/>
      <rect x="30" y="32" width="70" height="54" rx="3" fill="var(--il-fill-1)"/>
      <rect x="106" y="32" width="64" height="32" rx="3" fill="var(--il-fill-2)"/>
      <rect x="106" y="70" width="64" height="50" rx="3" fill="var(--il-fill-3)"/>
      <rect x="30" y="92" width="70" height="28" rx="3" fill="var(--il-fill-4)"/>
      <path d="m84 106 9 9 19-21" stroke="var(--restore)" stroke-width="3.5"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,

  // Empty quarantine: a shield with nothing held behind it.
  emptyQuarantine: `
    <svg class="illustration" viewBox="0 0 200 150" fill="none" aria-hidden="true">
      <path d="M100 26 58 42v34c0 26 18 46 42 51 24-5 42-25 42-51V42z"
            stroke="var(--il-detail)" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M78 84h44" stroke="var(--il-line)" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M86 68h28M86 100h28" stroke="var(--il-line)" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`,
};

// A drive, drawn at illustration quality: platter, spindle, actuator arm and
// enclosure. Used as the visual anchor of the storage panel. It is drawn here
// rather than sourced, so nothing is fetched and no third-party image or brand
// is reproduced.
ILLUSTRATION.drive = `
  <svg class="illustration drive-art" viewBox="0 0 240 180" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="platterFace" x1="0.2" y1="0" x2="0.8" y2="1">
        <stop offset="0%" stop-color="var(--il-metal-1)"/>
        <stop offset="45%" stop-color="var(--il-metal-2)"/>
        <stop offset="100%" stop-color="var(--il-metal-3)"/>
      </linearGradient>
      <linearGradient id="caseFace" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--panel)"/>
        <stop offset="100%" stop-color="var(--il-shell-2)"/>
      </linearGradient>
      <linearGradient id="mintSweep" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="var(--mint-500)"/>
        <stop offset="100%" stop-color="var(--mint-900)"/>
      </linearGradient>
    </defs>

    <rect x="26" y="20" width="188" height="140" rx="12" fill="url(#caseFace)" stroke="var(--il-line)" stroke-width="2"/>
    <rect x="36" y="30" width="168" height="120" rx="8" fill="var(--il-shell)" stroke="var(--line)"/>

    <circle cx="106" cy="90" r="54" fill="url(#platterFace)" stroke="var(--il-metal-4)" stroke-width="1.5"/>
    <circle cx="106" cy="90" r="41" fill="none" stroke="var(--il-metal-5)" stroke-width="1"/>
    <circle cx="106" cy="90" r="30" fill="none" stroke="var(--il-metal-5)" stroke-width="1"/>
    <circle cx="106" cy="90" r="19" fill="none" stroke="var(--il-metal-5)" stroke-width="1"/>

    <path d="M106 36a54 54 0 0 1 46 26" stroke="url(#mintSweep)" stroke-width="4" stroke-linecap="round"/>

    <circle cx="106" cy="90" r="11" fill="var(--il-hub)"/>
    <circle cx="106" cy="90" r="4.5" fill="var(--il-metal-1)"/>

    <circle cx="188" cy="46" r="8" fill="var(--il-arm)"/>
    <path d="M188 46 141 78" stroke="var(--il-arm)" stroke-width="9" stroke-linecap="round"/>
    <path d="M144 76l-9 6" stroke="var(--il-hub)" stroke-width="5" stroke-linecap="round"/>

    <rect x="36" y="150" width="168" height="10" rx="4" fill="var(--chart-track)"/>
    <rect x="36" y="150" width="96" height="10" rx="4" fill="var(--mint-500)"/>
  </svg>`;

export function illustration(name) {
  return ILLUSTRATION[name] || '';
}
