// NexaFiles renderer.
//
// Every figure shown here arrives from a measurement of the user's disk. There
// is no placeholder number, no estimate, and no score. When nothing has been
// measured, the interface says so rather than filling the space.

import { icon, iconForType, illustration } from './icons.js';
import * as explorer from './explorer.js';
import * as settings from './settings.js';
import * as treemap from './treemap.js';
import * as charts from './charts.js';
import * as dash from './dashboard.js';
import * as voice from './voice.js';

const nexa = window.nexa;

const state = {
  view: 'overview',
  scan: null,
  composition: null,
  crumbs: [],
  selectedBlock: null,
  fileList: { files: [], total: { n: 0, bytes: 0 }, under: null, category: null },
  plan: null,
  duplicates: null,
  // Which folder the duplicate search is confined to, or null for the whole
  // scan. Held here rather than read off the DOM so that switching views and
  // coming back does not quietly widen a search the user narrowed.
  dupeScope: null,
  leftovers: null,
  startup: null,
  // The Startup view answers two questions — what starts with Windows, and what
  // is running right now — and which one is on screen is remembered here so
  // that acting on a row and coming back does not throw the user to the top.
  startupTab: 'startup',
  startupFilter: 'all',
  background: null,
  backgroundFilter: 'all',
  system: null,
  quarantine: null,
  scanning: false,
  busy: null,
  // What stops the job `busy` is describing, or null when it cannot be stopped.
  // Held as a function rather than a flag because the Stop button has to reach
  // a different channel for a duplicate search than for a leftover sweep, and
  // the progress bar should not have to know which is running.
  busyCancel: null,
  // The stop has been asked for and the scanner has not returned yet. The
  // button becomes "Stopping…" rather than staying pressable, so a second click
  // cannot read as "it did not work".
  cancelPending: false,
  chat: [],
  chatAttachments: [],   // files dropped on the assistant, not yet sent
  chatDraft: '',         // what is in the composer but not yet sent
  // A question is in flight. While it is, the composer is a Stop button: two
  // questions against one conversation would interleave into nonsense, and the
  // main process refuses the second anyway.
  chatBusy: false,
  // What the assistant is doing right now, in the user's terms — "Reading your
  // documents… 220 read". A search across a disk takes tens of seconds, and a
  // motionless "Thinking…" for that long reads as a hang.
  chatStage: null,

  // Spoken input. `phase` is the only part the composer's markup depends on;
  // the level and the clock are written straight into the DOM twenty times a
  // second, because re-rendering the panel that often would fight the caret.
  voice: { phase: 'idle', supported: null },
  asideTab: 'plan',

  // The Files view's sidebar tree: which branches are open and what is in them.
  tree: { expanded: new Set(), children: new Map(), loading: new Set() },

  // The persisted preferences, as the main process holds them.
  prefs: null,
  dark: false,

  // Dashboard additions
  summary: null,        // measured category totals, drives, memory, deltas
  session: null,        // this boot session's recorded CPU/memory series
  profile: null,        // the account signed in on this machine
  sessionMetric: 'cpu', // which series the session graph shows
  uptimeTimer: null,
};

// ── formatting ─────────────────────────────────────────────────────────────

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Byte formatting. Binary units, because that is what a filesystem reports. */
function formatBytes(bytes, decimals) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  const n = Number(bytes);
  if (n === 0) return '0 B';
  const i = Math.min(Math.floor(Math.log(Math.abs(n)) / Math.log(1024)), UNITS.length - 1);
  const value = n / Math.pow(1024, i);
  const d = decimals !== undefined ? decimals : (i === 0 ? 0 : value < 10 ? 1 : value < 100 ? 1 : 0);
  return `${value.toFixed(d)} ${UNITS[i]}`;
}

/** Splits a byte figure so the hero can set the unit at a fraction of the size. */
function splitBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n === 0) return { value: '0', unit: 'B' };
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  const v = n / Math.pow(1024, i);
  return { value: v.toFixed(i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0), unit: UNITS[i] };
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── toasts ─────────────────────────────────────────────────────────────────

function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.innerHTML = icon(kind === 'error' ? 'caution' : 'check') + `<span>${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
}

async function guard(fn, label) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message || `${label} failed`, 'error');
    return null;
  }
}

// ── rail ───────────────────────────────────────────────────────────────────

const VIEWS = [
  ['overview', 'disk', 'Overview'],
  ['files', 'folderOpen', 'Files'],
  ['duplicates', 'copies', 'Duplicates'],
  ['leftovers', 'layers', 'Leftovers'],
  ['startup', 'power', 'Startup'],
  ['system', 'activity', 'System'],
  ['quarantine', 'quarantine', 'Quarantine'],
  ['settings', 'gauge', 'Settings'],
];

/**
 * The sidebar.
 *
 * Quick access and This PC behave the way they do in Explorer: clicking a
 * location opens it in the Files view, and the twisty beside it expands the
 * folders inside without leaving where you are. The scan action that used to
 * be the only thing these did is still here, on the button that appears when
 * you hover a location — browsing is what a click means everywhere else, and
 * that is the expectation worth matching.
 */
async function renderRail() {
  const rail = document.getElementById('rail');
  const [places, rootsInfo, quarantine] = await Promise.all([
    explorer.loadPlaces(),
    guard(() => nexa.roots.list(), 'Reading roots'),
    guard(() => nexa.quarantine.list(), 'Reading quarantine'),
  ]);

  const qCount = quarantine ? quarantine.items.length : 0;
  const home = places?.home;
  const folders = places?.folders || [];
  const drives = places?.drives || [];

  rail.innerHTML = `
    ${dash.railProfile(state.profile)}
    <div class="rail-group">
      <h2>Views</h2>
      ${VIEWS.map(([id, ic, label]) => `
        <button class="rail-item" data-view="${id}" aria-current="${state.view === id}">
          ${icon(ic)}<span class="label">${label}</span>
          ${id === 'quarantine' && qCount ? `<span class="meta">${qCount}</span>` : ''}
        </button>`).join('')}
    </div>

    <div class="rail-group">
      <h2>Quick access</h2>
      <div id="rail-quick">
        ${home ? placeNode({ ...home, iconName: 'home' }, 0) : ''}
        ${folders.map((f) => placeNode({ ...f, iconName: folderIcon(f.name) }, 0)).join('')}
      </div>
      <button class="rail-item" id="choose-root">
        ${icon('plus')}<span class="label">Choose another folder</span>
      </button>
    </div>

    <div class="rail-group">
      <h2>This PC</h2>
      <div id="rail-drives">
        ${drives.length
          ? drives.map((d) => driveNode(d)).join('')
          : '<div class="drive muted">No drives reported.</div>'}
      </div>
    </div>

    <div class="rail-group">
      <h2>Approved roots</h2>
      ${(rootsInfo?.roots || []).map((r) => `
        <div class="rail-item" style="cursor:default">
          ${icon('shield')}<span class="label mono" title="${esc(r)}">${esc(r)}</span>
        </div>`).join('') || '<div class="drive muted">None.</div>'}
      <p class="rail-note">
        These are the only locations NexaFiles can read. Opening a drive in Files
        adds it here; nothing outside this list is ever touched.
      </p>
    </div>`;

  wireRail(rail);
}

const FOLDER_ICONS = {
  Desktop: 'layout', Documents: 'document', Downloads: 'download',
  Pictures: 'image', Music: 'audio', Videos: 'video', Movies: 'video',
};
function folderIcon(name) { return FOLDER_ICONS[name] || 'folder'; }

/** One row in the sidebar tree, with its expanded children beneath it. */
function placeNode(place, depth, extra = '') {
  const open = state.tree.expanded.has(place.path);
  const current = explorer.state.path &&
    explorer.state.path.toLowerCase() === place.path.toLowerCase();
  const locked = place.access && !place.access.allowed;
  const children = state.tree.children.get(place.path);

  return `
    <div class="rail-node">
      <div class="rail-row ${current ? 'current' : ''}" data-drop-target="${esc(place.path)}"
           style="padding-left:${8 + depth * 14}px">
        <button class="rail-twisty ${open ? 'open' : ''}" data-twisty="${esc(place.path)}"
                aria-label="${open ? 'Collapse' : 'Expand'} ${esc(place.name)}"
                aria-expanded="${open}">${icon('chevron', { size: 12 })}</button>
        <button class="rail-place ${locked ? 'locked' : ''}" data-browse="${esc(place.path)}"
                aria-current="${!!current}" title="${esc(place.path)}">
          ${icon(place.iconName || 'folder')}
          <span class="label">${esc(place.name)}</span>
          ${locked ? `<span class="rail-free" title="NexaFiles has not been given access to this location">${icon('lock', { size: 11 })}</span>` : extra}
        </button>
        <button class="rail-scan" data-scan-root="${esc(place.path)}"
                title="Measure what is inside ${esc(place.name)}"
                aria-label="Scan ${esc(place.name)}">${icon('scan', { size: 13 })}</button>
      </div>
      ${open ? `<div class="rail-children">${
        state.tree.loading.has(place.path)
          ? `<div class="rail-loading" style="padding-left:${28 + depth * 14}px">Reading…</div>`
          : (children || []).length
            ? children.map((c) => placeNode({
                name: c.name, path: c.path, iconName: 'folder',
                access: c.protectedBy ? { allowed: false } : null,
              }, depth + 1)).join('')
            : `<div class="rail-loading" style="padding-left:${28 + depth * 14}px">No folders inside.</div>`
      }</div>` : ''}
    </div>`;
}

function driveNode(drive) {
  const usedPct = drive.totalBytes ? (drive.usedBytes / drive.totalBytes) * 100 : 0;
  const free = `<span class="rail-free">${formatBytes(drive.freeBytes)} free</span>`;
  return `
    ${placeNode({ ...drive, name: `${drive.label} (${drive.id || drive.path})`, iconName: 'drive' }, 0, free)}
    <div class="rail-drive-bar" title="${esc(formatBytes(drive.usedBytes))} of ${esc(formatBytes(drive.totalBytes))} in use">
      <div class="bar"><span style="width:${usedPct.toFixed(1)}%"></span></div>
    </div>`;
}

function wireRail(rail) {
  rail.querySelectorAll('[data-view]').forEach((b) => {
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      renderAll();
      if (state.view === 'settings') settings.load();
    });
  });
  rail.querySelectorAll('[data-browse]').forEach((b) => {
    b.addEventListener('click', () => browseTo(b.dataset.browse));
  });
  rail.querySelectorAll('[data-scan-root]').forEach((b) => {
    b.addEventListener('click', (ev) => { ev.stopPropagation(); startScan(b.dataset.scanRoot); });
  });
  rail.querySelectorAll('[data-twisty]').forEach((b) => {
    b.addEventListener('click', (ev) => { ev.stopPropagation(); toggleBranch(b.dataset.twisty); });
  });

  // A folder in the sidebar is a drop target, exactly as it is in Explorer.
  rail.querySelectorAll('[data-drop-target]').forEach((el) => {
    el.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = ev.ctrlKey ? 'copy' : 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      el.classList.remove('drop-target');
      const dest = el.dataset.dropTarget;
      const paths = (await explorer.pathsFromDrop(ev)).filter((x) => x !== dest);
      if (!paths.length) return;
      const res = await guard(
        () => (ev.ctrlKey ? nexa.explorer.copy(paths, dest) : nexa.explorer.move(paths, dest)),
        'Drop'
      );
      if (!res) return;
      const done = ev.ctrlKey ? res.copied : res.moved;
      toast(`${done} item(s) ${ev.ctrlKey ? 'copied' : 'moved'} into ${dest}.`);
      if (explorer.state.path) await explorer.refresh();
    });
  });

  document.getElementById('choose-root')?.addEventListener('click', async () => {
    const chosen = await guard(() => nexa.roots.choose(), 'Choosing folder');
    if (chosen) { await renderRail(); browseTo(chosen.path); }
  });
}

/** Opens a location in the Files view, switching to it if necessary. */
function browseTo(target) {
  state.view = 'files';
  explorer.navigate(target);
  renderAll();
}

/** Expands or collapses one branch of the sidebar tree. */
async function toggleBranch(target) {
  const { expanded, children, loading } = state.tree;
  if (expanded.has(target)) {
    expanded.delete(target);
    await renderRail();
    return;
  }
  expanded.add(target);
  if (!children.has(target)) {
    loading.add(target);
    await renderRail();
    const reply = await guard(() => nexa.explorer.subfolders(target), 'Reading folders');
    loading.delete(target);
    // A location without access lists nothing rather than failing: the row is
    // still clickable, and clicking it is what offers the grant.
    children.set(target, reply?.folders || []);
  }
  await renderRail();
}

// ── scanning ───────────────────────────────────────────────────────────────

async function startScan(root) {
  if (state.scanning) { toast('A scan is already running.'); return; }
  state.scanning = true;
  state.cancelPending = false;
  state.view = 'overview';
  state.crumbs = [];
  state.selectedBlock = null;
  state.duplicates = null;
  // A folder chosen under the previous scan may not exist in this one, and a
  // stale scope would silently return nothing.
  state.dupeScope = null;
  state.leftovers = null;
  state.plan = null;
  renderAll();

  const scan = await guard(() => nexa.scan.start(root), 'Scan');
  state.scanning = false;
  state.cancelPending = false;

  if (scan) {
    state.scan = scan;
    await loadComposition(scan.root);
    await loadSummary();
    toast(`Scan finished. ${formatNumber(scan.fileCount)} files, ${formatBytes(scan.totalBytes)}.`);
  }
  renderAll();
}

async function loadComposition(under) {
  const comp = await guard(() => nexa.scan.composition(null, under), 'Reading composition');
  if (!comp) return;
  state.composition = comp;
  state.scan = comp.scan;
  state.crumbs = buildCrumbs(comp.scan.root, comp.under);
  await loadFiles({ under: comp.under, category: null });
}

function buildCrumbs(root, current) {
  const crumbs = [{ name: root, path: root }];
  if (current === root) return crumbs;
  const sep = root.includes('\\') ? '\\' : '/';
  const rest = current.slice(root.length).split(sep).filter(Boolean);
  let acc = root;
  for (const part of rest) {
    acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

async function loadFiles({ under, category }) {
  const res = await guard(() => nexa.scan.files({
    under: under || null, category: category || null, limit: 300,
  }), 'Reading files');
  if (res) state.fileList = { ...res, under, category };
}

// ── dashboard data ─────────────────────────────────────────────────────────

async function loadSummary() {
  state.summary = await guard(() => nexa.overview.summary(), 'Reading summary');
}

async function loadSession() {
  state.session = await guard(() => nexa.system.session(), 'Reading session');
}

async function loadProfile() {
  state.profile = await guard(() => nexa.profile.get(), 'Reading profile');
  const chip = document.getElementById('profile-chip');
  if (chip && state.profile) chip.innerHTML = dash.profileChip(state.profile);
}

/** Ticks the uptime numeral without repainting the whole view. */
function startUptimeTicker() {
  if (state.uptimeTimer) clearInterval(state.uptimeTimer);
  state.uptimeTimer = setInterval(async () => {
    const el = document.getElementById('uptime-value');
    if (!el) return;
    const up = await nexa.system.uptime().catch(() => null);
    if (!up) return;
    el.innerHTML = dash.uptimeParts(up.seconds)
      .map(([v, u]) => `${v}<span class="u-unit">${u}</span>`).join('');
  }, 1000);
}

// ── views ──────────────────────────────────────────────────────────────────

function renderAll() {
  const stage = document.getElementById('stage');
  // The Files view manages its own scrolling, so the stage gives up its padding
  // and its scrollbar for it.
  stage.classList.toggle('stage-flush', state.view === 'files');
  switch (state.view) {
    case 'overview':    stage.innerHTML = viewOverview(); break;
    case 'files':       stage.innerHTML = explorer.render(); break;
    case 'duplicates':  stage.innerHTML = viewDuplicates(); break;
    case 'leftovers':   stage.innerHTML = viewLeftovers(); break;
    case 'startup':     stage.innerHTML = viewStartup(); break;
    case 'system':      stage.innerHTML = viewSystem(); break;
    case 'quarantine':  stage.innerHTML = viewQuarantine(); break;
    case 'settings':    stage.innerHTML = settings.render(); break;
  }
  wireStage();
  if (state.view === 'files') explorer.wire(stage);
  if (state.view === 'settings') settings.wire(stage);
  renderAside();
  document.querySelectorAll('#rail [data-view]').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.view === state.view));
  });
  document.getElementById('scan-context').textContent = state.scan
    ? `${state.scan.root} — measured ${new Date(state.scan.finishedAt).toLocaleString()}`
    : '';
  if (state.view === 'overview' && state.composition) drawTreemap();
}

/**
 * The bar that says something is running.
 *
 * Everything long-running that this bar can describe is also something the user
 * must be able to call off. A comparison across a whole disk takes minutes, and
 * a progress line with no way out is the thing that makes people force-quit the
 * application — so whichever job is running names its own stop, and the button
 * is drawn from that rather than only for the folder walk.
 */
function progressBlock() {
  if (!state.scanning && !state.busy) return '';
  const stoppable = state.scanning || state.busyCancel;
  return `
    <div class="progress">
      <div class="spinner"></div>
      <div class="progress-text">
        <div class="progress-counts" id="progress-counts">${esc(state.busy || 'Starting…')}</div>
        <div class="progress-current" id="progress-current"></div>
      </div>
      ${state.cancelPending
        ? '<span class="progress-stopping">Stopping…</span>'
        : stoppable
          ? `<button class="btn small" id="${state.scanning ? 'cancel-scan' : 'cancel-busy'}">
               ${icon('cancel', { size: 13 })} Stop
             </button>`
          : ''}
    </div>`;
}

// ── overview ───────────────────────────────────────────────────────────────
//
// The Overview used to be eight full-width panels of identical visual weight,
// stacked in the order they happened to be written: the headline figure, the
// category cards, the drive, the machine's uptime, the treemap, a year
// breakdown, recent files, largest files. Nothing said which of those answered
// which question, and a panel about the processor sat in the middle of four
// panels about the disk. Reading it meant scrolling the whole thing every time.
//
// It is now four named sections, in the order the questions actually get asked:
// what can I get back, where is the space, what is worth looking at, and how is
// the machine. The panels are unchanged; what changed is that they are grouped
// and labelled, so the page can be navigated instead of read.

/** A labelled break between groups of panels. */
function sectionHead(title, note) {
  return `
    <div class="section-head">
      <h2>${esc(title)}</h2>
      ${note ? `<span class="section-note">${esc(note)}</span>` : ''}
      <span class="section-rule"></span>
    </div>`;
}

/**
 * The headline figure, in a card rather than floating on the background.
 *
 * The number kept its size but gained a container and a set of supporting
 * facts beside it. On its own it was a very large number with nothing to scale
 * it against — "12.1 GB" means one thing on a 200 GB scan and another on a
 * 2 TB one, and the facts that settle that were previously three panels away.
 */
function heroCard(scan, reclaimable) {
  const facts = [
    ['Measured', formatBytes(scan.totalBytes)],
    ['Files', formatNumber(scan.fileCount)],
    ['Folders', formatNumber(scan.dirCount)],
  ];
  const factList = `
    <dl class="hero-facts">
      ${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
      <div class="wide">
        <dt>Scanned</dt>
        <dd class="mono" title="${esc(scan.root)}">${esc(shortenPath(scan.root, 30))}</dd>
      </div>
    </dl>`;

  if (reclaimable.known) {
    const { value, unit } = splitBytes(reclaimable.bytes);
    return `
      <section class="hero-card">
        <div class="hero-main">
          <span class="hero-eyebrow">${icon('shield', { size: 13 })} Reclaimable</span>
          <h1 class="hero-value"><span>${value}</span><span class="hero-unit">${unit}</span></h1>
          <p class="hero-caption">
            Across <strong>${formatNumber(reclaimable.items)}</strong> item(s) that
            ${esc(reclaimable.basis)}. Every one carries the evidence that identified it.
          </p>
          <button class="btn primary hero-drill" id="hero-drill">
            ${icon('eye')} Review the itemised plan
          </button>
        </div>
        ${factList}
      </section>`;
  }

  const { value, unit } = splitBytes(scan.totalBytes);
  return `
    <section class="hero-card">
      <div class="hero-main">
        <span class="hero-eyebrow">${icon('disk', { size: 13 })} Measured on this disk</span>
        <h1 class="hero-value"><span>${value}</span><span class="hero-unit">${unit}</span></h1>
        <p class="hero-caption">
          Nothing has been checked for reclaimable space yet. Run a duplicate or
          leftover scan and the figure above becomes what you could actually recover.
        </p>
        <div class="row" style="margin-top:14px">
          <button class="btn primary" data-goto="duplicates">${icon('copies')} Find duplicates</button>
          <button class="btn" data-goto="leftovers">${icon('layers')} Find leftovers</button>
        </div>
      </div>
      ${factList}
    </section>`;
}

function viewOverview() {
  if (state.scanning) {
    return progressBlock() + `<div class="panel"><p class="muted">Walking the folder. Results appear when it finishes.</p></div>`;
  }

  if (!state.scan || !state.composition) {
    return `
      <div class="empty">
        ${illustration('firstRun')}
        <h2>No scan has run yet</h2>
        <p>Choose a folder and NexaFiles will measure what is actually inside it.
           Nothing is read until you pick one, and nothing is ever removed without
           your approval.</p>
        <button class="btn primary" id="empty-choose">${icon('scan')} Choose a folder to scan</button>
      </div>
      ${state.session ? sectionHead('This machine') : ''}
      ${dash.sessionPanel(state.session, state.sessionMetric, { formatBytes })}`;
  }

  const { scan, categories, children } = state.composition;
  const reclaimable = knownReclaimable();

  const legend = categories.map((c) => {
    const col = treemap.blockColour(c.category, null);
    return `
      <div class="legend-item">
        <span class="legend-swatch" style="background:${col.css}"></span>
        <span>${esc(treemap.CATEGORY_LABEL[c.category] || c.category)}</span>
        <span class="legend-bytes">${formatBytes(c.bytes)}</span>
      </div>`;
  }).join('');

  const caveats = scan.notes && scan.notes.length ? `
    <div class="panel-note ${scan.skippedCount ? 'caution' : ''}">
      <strong>What this measurement does not include</strong>
      <ul>${scan.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    </div>` : '';

  return progressBlock() +
    heroCard(scan, reclaimable) +

    // ── where the space is ──────────────────────────────────────────────
    // The categories, the map of them, and the drive they sit on: three views
    // of one question, now adjacent instead of separated by the uptime graph.
    sectionHead('Where the space is',
      `measured ${new Date(scan.finishedAt).toLocaleDateString()}`) +
    (state.summary ? dash.statCards(state.summary, { formatBytes, splitBytes }) : '') + `
    <div class="panel">
      <header>
        <h2>Explore by folder</h2>
        <div class="actions">
          <button class="btn small" id="rescan">${icon('scan')} Scan again</button>
        </div>
      </header>

      <div class="crumbs" id="crumbs">
        ${state.crumbs.map((c, i) => i === state.crumbs.length - 1
          ? `<span class="current mono">${esc(c.name)}</span>`
          : `<button data-crumb="${esc(c.path)}" class="mono">${esc(c.name)}</button>
             <span class="sep">${icon('chevron', { size: 12 })}</span>`).join('')}
      </div>

      <div class="treemap-wrap">
        <div class="treemap" id="treemap"></div>
      </div>

      <div class="legend">${legend}</div>
      <div class="legend-note">
        ${icon('info', { size: 14 })}
        <span>Block size is measured bytes. Colour is category.</span>
        <span class="legend-fade"></span>
        <span>Fading shows how long since anything in it was opened.</span>
      </div>
      ${caveats}
    </div>
    ${state.summary ? dash.storagePanel(state.summary, { formatBytes }) : ''}

    ` +
    // ── worth a look ────────────────────────────────────────────────────
    sectionHead('Worth a look', 'the files behind those figures') + `
    <div class="panel">
      <header>
        <h2>${state.fileList.under && state.fileList.under !== scan.root
              ? 'Files in ' + esc(shortPath(state.fileList.under))
              : 'Largest files'}</h2>
        <span class="muted">${formatNumber(state.fileList.total.n)} files,
          ${formatBytes(state.fileList.total.bytes)}</span>
      </header>
      ${fileTable(state.fileList.files)}
    </div>
    ` +
    (state.summary ? dash.recentPanel(state.summary, { formatBytes }) : '') +
    (state.summary ? dash.byYearPanel(state.summary, { formatBytes }) : '') +

    // ── this machine ────────────────────────────────────────────────────
    // Nothing here is about the disk, which is exactly why it used to read as
    // an interruption. Last, under its own heading, it reads as an aside.
    (state.session ? sectionHead('This machine') : '') +
    dash.sessionPanel(state.session, state.sessionMetric, { formatBytes });
}

function shortPath(p) {
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter(Boolean);
  return parts.length > 2 ? '…' + sep + parts.slice(-2).join(sep) : p;
}

function fileTable(files) {
  if (!files.length) {
    return '<p class="muted">No files recorded here.</p>';
  }
  return `
    <div class="list-scroll">
      <table class="table">
        <thead>
          <tr><th style="width:26px"></th><th>Name</th><th>Location</th>
              <th class="num">Size</th><th class="num">Last opened</th></tr>
        </thead>
        <tbody>
          ${files.slice(0, 300).map((f) => `
            <tr data-file="${esc(f.path)}" title="${esc(f.path)}">
              <td>${icon(iconForType(f.type, false))}</td>
              <td class="name">${esc(f.name)}</td>
              <td class="path">${esc(f.path)}</td>
              <td class="num bytes">${formatBytes(f.size)}</td>
              <td class="num muted nowrap">${f.atimeMs ? esc(treemap.describeAge(f.atimeMs)) : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function drawTreemap() {
  const el = document.getElementById('treemap');
  if (!el || !state.composition) return;
  const items = state.composition.children.map((c) => ({
    name: c.name, path: c.path, bytes: c.bytes, category: c.category,
    isDirectory: !!c.isDirectory, newestAccessMs: c.newestAccessMs,
  }));
  if (!items.length) {
    el.innerHTML = '<div class="empty" style="padding:36px"><p class="muted">This folder holds no measured files.</p></div>';
    return;
  }
  treemap.render(el, items, {
    formatBytes,
    selectedPath: state.selectedBlock,
    onSelect: async (block) => {
      if (block.isDirectory) {
        await loadComposition(block.path);
        renderAll();
      } else {
        state.selectedBlock = block.path;
        await loadFiles({ under: state.composition.under, category: null });
        renderAll();
      }
    },
  });
}

/** Reclaimable is only "known" once something has actually measured it. */
function knownReclaimable() {
  let bytes = 0, items = 0;
  const parts = [];
  if (state.duplicates?.exact) {
    bytes += state.duplicates.exact.totalWasted;
    items += state.duplicates.exact.groups.reduce((n, g) => n + g.members.length - 1, 0);
    parts.push('are byte-identical copies of another file');
  }
  if (state.leftovers) {
    const regen = state.leftovers.findings.filter((f) => f.category === 'regenerable');
    bytes += regen.reduce((n, f) => n + f.bytes, 0);
    items += regen.length;
    parts.push('regenerate themselves if removed');
  }
  return { known: items > 0, bytes, items, basis: parts.join(', or ') };
}

// ── duplicates ─────────────────────────────────────────────────────────────

const TIERS = [
  ['exact', 'Exact duplicates', 'Byte-for-byte identical files, confirmed with SHA-256.'],
  ['image', 'Near-identical images', 'The same picture at different sizes or re-exported, found by perceptual hashing.'],
  ['text', 'Near-identical documents',
    'Text is parsed out of PDF, Word, PowerPoint and Excel files, then fingerprinted with SimHash. A scanned PDF holds no text and is reported as such rather than compared.'],
  ['video', 'Duplicate and excerpted video',
    'Videos reduced to one frame hash per second. Finds re-encodes of the same footage, and clips cut out of a longer file, reporting where in the original each clip begins.'],
];

/**
 * Where the duplicate search will look.
 *
 * Comparing files means comparing what the scan measured, so this narrows the
 * search within the scan rather than starting a new one — which is why the
 * button offers folders under the scan root and says so when one is refused.
 * A search over one folder is a different measurement from a search over the
 * whole scan, and the results below say which they were.
 */
function dupeScopeBar() {
  const scoped = !!state.dupeScope;
  return `
    <div class="dupe-scope">
      <span class="dupe-scope-label">Search in</span>
      <span class="dupe-scope-value ${scoped ? 'narrowed' : ''}" title="${esc(state.dupeScope || state.scan.root)}">
        ${icon(scoped ? 'folder' : 'disk', { size: 13 })}
        <span>${scoped ? esc(shortenPath(state.dupeScope)) : 'Everything scanned'}</span>
      </span>
      <span class="dupe-scope-actions">
        <button class="btn small" id="dupe-pick-folder">
          ${icon('folderOpen', { size: 13 })} ${scoped ? 'Change folder' : 'Choose a folder'}
        </button>
        ${scoped ? `
          <button class="btn small" id="dupe-clear-folder">
            ${icon('x', { size: 13 })} Whole scan
          </button>` : ''}
      </span>
    </div>`;
}

/** A path shortened from the middle: the start and the end both say where. */
function shortenPath(p, max = 52) {
  const s = String(p || '');
  if (s.length <= max) return s;
  const parts = s.split(/[\\/]/);
  if (parts.length <= 2) return s.slice(0, max - 1) + '…';
  const tail = parts.slice(-2).join('\\');
  return `${parts[0]}\\…\\${tail}`;
}

function viewDuplicates() {
  if (!state.scan) return needScan('find duplicates');

  const found = state.duplicates || {};
  return progressBlock() + `
    <div class="panel">
      <header><h2>Duplicates</h2></header>
      <p class="muted" style="margin-top:-6px;max-width:80ch">
        Three methods, none of them machine learning. Each reports how it reached
        its conclusion so you can check it yourself.
      </p>
      ${dupeScopeBar()}
      <div class="row" style="margin-top:14px;flex-wrap:wrap">
        ${TIERS.map(([id, label]) => `
          <button class="btn ${id === 'exact' ? 'primary' : ''}" data-dupe="${id}">
            ${icon('copies')} ${label}
          </button>`).join('')}
      </div>
    </div>

    ${TIERS.map(([id, label, blurb]) => {
      const r = found[id];
      if (!r) return '';
      const where = r.scopeName
        ? `in ${esc(r.scopeName)}`
        : 'across everything scanned';
      if (!r.groups.length) {
        return `<div class="panel"><header><h2>${label}</h2></header>
          <p class="muted">None found ${where}. ${esc(blurb)}</p>
          <div class="panel-note">${esc(r.method)}</div></div>`;
      }
      const shown = r.groups.slice(0, DUPE_GROUP_LIMIT);
      const hidden = r.groups.length - shown.length;
      return `
        <div class="panel">
          <header>
            <h2>${label}</h2>
            <span class="muted">${formatNumber(r.groups.length)} group(s),
              ${formatBytes(r.totalWasted)} reclaimable ${where}</span>
            <div class="actions">
              <button class="btn primary small" data-dupe-plan="${id}">
                ${icon('eye')} Build a plan
              </button>
            </div>
          </header>
          ${r.cancelled ? `
            <div class="panel-note caution">
              ${icon('caution', { size: 13 })} This search was stopped before it
              finished. What is listed is real; what is <em>not</em> listed proves
              nothing, because the rest of the folder was never compared.
            </div>` : ''}
          <div class="panel-note">${icon('info', { size: 13 })} ${esc(r.method)}</div>
          <p class="muted" style="margin:10px 0 0;font-size:12px">
            Double-click a row to open the file, or use
            ${icon('external', { size: 11 })} to open and
            ${icon('folderOpen', { size: 11 })} to show it in its folder. Check a
            copy against the one marked <span class="chip">kept</span> before you
            build a plan — nothing is removed until you approve it.
          </p>
          <div class="list-scroll" style="margin-top:10px">
            <table class="table dupe-table">
              <thead><tr>
                <th>File</th>
                <th class="num">Size</th>
                <th class="num">Difference</th>
                <th class="dupe-actions-col">Open</th>
              </tr></thead>
              <tbody>
                ${shown.map((g, gi) => dupeGroupRows(g, gi, id)).join('')}
              </tbody>
            </table>
          </div>
          ${hidden > 0 ? `
            <div class="panel-note">
              ${icon('info', { size: 13 })} ${formatNumber(hidden)} further group(s)
              were found and are not drawn here, to keep this list scrollable. They
              are all included in the plan.
            </div>` : ''}
        </div>`;
    }).join('')}`;
}

/** How many groups the table draws before it stops, for the sake of the DOM. */
const DUPE_GROUP_LIMIT = 60;

/**
 * One duplicate group: a header row naming it, then its files.
 *
 * The header exists because the previous table ran every group together, so
 * "the files in this group" was a claim the markup never actually made — three
 * copies of one photo and two copies of another were twenty-five adjacent rows
 * with nothing to say where one group stopped. Each file row carries its own
 * open and reveal controls, because deciding which of five identical files to
 * keep means looking at where they live and, quite often, opening them.
 */
function dupeGroupRows(g, gi, tier) {
  const kept = g.members[0];
  return `
    <tr class="dupe-group-head">
      <td colspan="4">
        <span class="dupe-group-n">Group ${gi + 1}</span>
        <span class="dupe-group-meta">
          ${formatNumber(g.members.length)} copies of
          <strong>${esc(kept.path.split(/[\\/]/).pop())}</strong>
          — ${formatBytes(g.wastedBytes)} reclaimable if you keep one
        </span>
        ${g.subclip ? `
          <span class="dupe-group-note">
            The second file is the passage from
            ${esc(g.subclip.startLabel)} to ${esc(g.subclip.endLabel)} of the first,
            matched across ${formatNumber(g.subclip.matchedFrames)} of
            ${formatNumber(g.subclip.comparedFrames)} sampled frames.
          </span>` : ''}
        ${g.whole?.reason ? `
          <span class="dupe-group-note">${esc(g.whole.reason)}.</span>` : ''}
      </td>
    </tr>
    ${g.members.map((m, i) => `
      <tr class="dupe-file ${i === 0 ? 'is-kept' : ''}" data-dupe-file="${esc(m.path)}"
          title="Double-click to open this file">
        <td>
          <div class="name">${esc(m.path.split(/[\\/]/).pop())}
            ${i === 0 ? '<span class="chip">kept</span>' : ''}</div>
          <div class="path" title="${esc(m.path)}">${esc(m.path)}</div>
          ${m.durationSec || m.width ? `
            <div class="dupe-detail">
              ${m.durationSec ? `${formatClock(m.durationSec)} long` : ''}
              ${m.durationSec && m.width ? ' · ' : ''}
              ${m.width ? `${m.width}×${m.height}` : ''}
            </div>` : ''}
        </td>
        <td class="num bytes">${formatBytes(m.size)}</td>
        <td class="num muted">${tier === 'exact' ? 'identical' : `${m.distance}/64 bits`}</td>
        <td class="dupe-actions-col">
          <span class="dupe-row-actions">
            <button class="icon-btn" data-open-dupe="${esc(m.path)}"
                    title="Open this file" aria-label="Open this file">
              ${icon('external', { size: 14 })}
            </button>
            <button class="icon-btn" data-reveal-dupe="${esc(m.path)}"
                    title="Show in its folder" aria-label="Show in its folder">
              ${icon('folderOpen', { size: 14 })}
            </button>
          </span>
        </td>
      </tr>`).join('')}`;
}

/** Seconds as m:ss, for a clip's length or its offset into a longer file. */
function formatClock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── leftovers ──────────────────────────────────────────────────────────────

function viewLeftovers() {
  const l = state.leftovers;

  if (!l) {
    return progressBlock() + `
      <div class="panel">
        <header><h2>Application leftovers</h2></header>
        <p class="muted" style="max-width:82ch">
          Folders left behind by applications that appear to be gone. A folder is
          only reported when no installed application matches its name, no folder
          of that name exists where applications are installed, no running process
          matches it, and nothing has written to it in 90 days.
        </p>
        <div class="row" style="margin-top:14px">
          <button class="btn primary" id="find-leftovers">${icon('scan')} Look for leftovers</button>
        </div>
      </div>`;
  }

  const regen = l.findings.filter((f) => f.category === 'regenerable');
  const userData = l.findings.filter((f) => f.category === 'user-data');

  if (!l.findings.length) {
    return progressBlock() + `
      <div class="empty">
        ${illustration('nothingFound')}
        <h2>${l.cancelled ? 'Stopped before anything was found' : 'Nothing looks left behind'}</h2>
        <p>${l.cancelled
          ? `The sweep was stopped part of the way through, so this is not a
             finding — it is simply where it got to.`
          : `Every application-data folder examined matches something that is still
             installed, still running, or has been written to recently.`}</p>
        <button class="btn primary" id="find-leftovers">${icon('scan')} Look again</button>
      </div>`;
  }

  return progressBlock() + `
    <div class="panel">
      <header>
        <h2>Application leftovers</h2>
        <span class="muted">${formatNumber(l.findings.length)} found,
          ${formatBytes(l.findings.reduce((n, f) => n + f.bytes, 0))}</span>
        <div class="actions">
          <button class="btn primary small" id="leftover-plan">${icon('eye')} Build a plan</button>
          <button class="btn small" id="find-leftovers">${icon('scan')} Scan again</button>
        </div>
      </header>
      ${l.cancelled ? `
        <div class="panel-note caution">
          ${icon('caution', { size: 13 })} This sweep was stopped before it finished.
          The folders below were examined and judged; the ones it never reached are
          simply absent, and their absence means nothing.
        </div>` : ''}
      <div class="panel-note caution">
        <strong>Read this before removing anything</strong>
        <ul>${l.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      </div>
    </div>

    ${leftoverSection('Regenerates if removed', regen,
      'These rebuild themselves the next time the tool that owns them runs. Removing them costs time, not data.')}
    ${leftoverSection('Possibly your data', userData,
      'These may hold licences, saved games, project files or settings. Nothing here is selected by default, and you should open anything you do not recognise before removing it.', true)}`;
}

function leftoverSection(title, findings, blurb, isUserData) {
  if (!findings.length) return '';
  return `
    <div class="panel">
      <header><h2>${title}</h2>
        <span class="muted">${formatBytes(findings.reduce((n, f) => n + f.bytes, 0))}</span>
      </header>
      <p class="muted" style="margin-top:-6px;max-width:82ch">${esc(blurb)}</p>
      <div class="plan-section ${isUserData ? 'user-data' : ''}" style="margin-top:14px">
        ${findings.map((f, i) => `
          <div class="plan-row">
            <span>${icon('folder')}</span>
            <div class="stack">
              <span class="plan-name">${esc(f.name)}</span>
              <span class="plan-path">${esc(f.path)}</span>
              <span class="plan-reason">${esc(f.reason)}</span>
              <button class="evidence-toggle" data-evidence="lo-${isUserData ? 'u' : 'r'}-${i}">
                Show the evidence
              </button>
              <div class="evidence" id="lo-${isUserData ? 'u' : 'r'}-${i}" hidden>
                <span class="evidence-label">Why this was identified</span>
                ${esc(f.evidence)}
              </div>
            </div>
            <span class="chip confidence-${esc(f.confidence)}">${esc(f.confidence)} confidence</span>
            <span class="plan-bytes">${formatBytes(f.bytes)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

// ── startup and background load ────────────────────────────────────────────
//
// Two questions, one view. "What starts when I log in, and can I stop it" is
// answered by the first tab; "what is running right now, and can I close it" by
// the second. They are the same view because they are the same complaint, and
// because the answer to the first is usually visible in the second: an entry
// you switch off is one you can watch disappear from the running list.
//
// Every row here states what it costs. A list of forty startup entries with no
// figures against them tells you nothing about which one to switch off, which
// is exactly the criticism that produced this rewrite.

/** The program rows exactly as the running list last drew them. */
let backgroundShown = [];

/** Which of the two tabs is showing. */
const STARTUP_TABS = [
  ['startup', 'power', 'Starts with Windows'],
  ['background', 'activity', 'Running now'],
];

const STARTUP_FILTERS = [
  ['all', 'Everything'],
  ['on', 'Switched on'],
  ['off', 'Switched off'],
  ['running', 'Running now'],
  ['heavy', 'Heaviest first'],
];

function viewStartup() {
  return `
    <div class="seg-tabs">
      ${STARTUP_TABS.map(([id, ic, label]) => `
        <button class="seg-tab" data-startup-tab="${id}"
                aria-selected="${state.startupTab === id}">
          ${icon(ic, { size: 14 })} ${label}
        </button>`).join('')}
    </div>
    ${state.startupTab === 'background' ? viewBackground() : viewStartupItems()}`;
}

function viewStartupItems() {
  const s = state.startup;
  if (!s) {
    return progressBlock() + `
      <div class="panel">
        <header><h2>What starts with Windows</h2></header>
        <p class="muted" style="max-width:80ch">
          Every program, task and service that starts on its own when you log in
          — with what each one is costing in memory right now, so it is possible
          to tell which of them is worth switching off.
        </p>
        <p class="muted" style="max-width:80ch">
          NexaFiles switches items off the way Task Manager does: the entry stays
          exactly where its installer put it, and Windows is told to skip it.
          Nothing is deleted, so every switch here has an equal switch back.
        </p>
        <button class="btn primary" id="load-startup" style="margin-top:14px">
          ${icon('power')} List what starts with Windows
        </button>
      </div>`;
  }

  const items = s.items.map((it, i) => ({ ...it, idx: i }));
  const enabled = items.filter((i) => i.enabled);
  const off = items.length - enabled.length;
  const running = items.filter((i) => i.runningNow);

  const filtered = filterStartupItems(items);
  const groups = {};
  for (const it of filtered) (groups[it.source] ||= []).push(it);

  return progressBlock() + `
    <div class="panel">
      <header>
        <h2>What starts with Windows</h2>
        <div class="actions">
          <button class="btn small" id="load-startup">${icon('refresh', { size: 13 })} Re-read</button>
        </div>
      </header>
      <div class="plan-totals">
        <div>
          <div class="plan-total-value">${formatNumber(enabled.length)}</div>
          <div class="plan-total-label">entries Windows currently starts,
            of ${formatNumber(items.length)} found${off ? ` — ${formatNumber(off)} already off` : ''}</div>
        </div>
        <div>
          <div class="plan-total-value">${formatNumber(running.length)}</div>
          <div class="plan-total-label">of them running at this moment</div>
        </div>
        <div>
          <div class="plan-total-value">${s.measuredImpact
            ? formatBytes(s.impact.totalRssBytes, 1) : '—'}</div>
          <div class="plan-total-label">${s.measuredImpact
            ? `held by those, across ${formatNumber(s.impact.distinctProcesses)} process(es)`
            : 'memory in use could not be measured'}</div>
        </div>
      </div>

      <div class="panel-note">
        ${icon('info', { size: 13 })}
        Switching an entry off does not close it if it is already running — it
        stops it starting <em>next</em> time. To reclaim the memory now, close it
        under <button class="linkish" data-startup-tab="background">Running now</button>.
        ${s.elevated ? '' : `
          Machine-wide entries and services are shown but cannot be changed:
          NexaFiles is not running as administrator.`}
      </div>

      ${s.incomplete || s.notes.length ? `
        <div class="panel-note caution">
          ${icon('caution', { size: 13 })} <strong>What this list does not cover</strong>
          <ul>${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        </div>` : ''}

      <div class="filter-bar">
        ${STARTUP_FILTERS.map(([id, label]) => `
          <button class="chip-btn" data-startup-filter="${id}"
                  aria-pressed="${state.startupFilter === id}">${label}</button>`).join('')}
        <span class="filter-count">${formatNumber(filtered.length)} shown</span>
      </div>
    </div>

    ${filtered.length ? Object.entries(groups).map(([source, list]) => `
      <div class="panel">
        <header>
          <h2>${esc(source)}</h2>
          <span class="muted">${formatNumber(list.length)} entr${list.length === 1 ? 'y' : 'ies'}${
            list.some((i) => i.rssBytes)
              ? ` · ${formatBytes(list.reduce((n, i) => n + (i.sharesProcess ? 0 : i.rssBytes), 0))} in use now`
              : ''}</span>
        </header>
        <div class="startup-list">
          ${list.map(startupRow).join('')}
        </div>
      </div>`).join('') : `
      <div class="panel">
        <p class="muted">Nothing matches that filter.</p>
      </div>`}`;
}

function filterStartupItems(items) {
  switch (state.startupFilter) {
    case 'on':      return items.filter((i) => i.enabled);
    case 'off':     return items.filter((i) => !i.enabled);
    case 'running': return items.filter((i) => i.runningNow);
    case 'heavy':   return [...items].sort((a, b) => (b.rssBytes || 0) - (a.rssBytes || 0));
    default:        return items;
  }
}

/**
 * One startup entry.
 *
 * The switch is disabled rather than hidden when the entry cannot be changed,
 * with the reason attached: "you cannot do this and here is why" is useful,
 * and a row that silently lacks a control is not.
 */
function startupRow(it) {
  const can = it.control?.toggleable;
  const cost = it.runningNow
    ? `${formatBytes(it.rssBytes)}${it.sharesProcess ? ' (shared)' : ''}` +
      `${it.processCount > 1 ? ` · ${it.processCount} processes` : ''}`
    : null;

  return `
    <div class="startup-row ${it.enabled ? '' : 'is-off'}">
      <span class="startup-state ${it.enabled ? 'on' : 'off'}"
            title="${it.enabled ? 'Windows starts this' : 'Windows skips this'}">
        ${icon(it.enabled ? 'check' : 'x', { size: 12 })}
      </span>
      <div class="stack">
        <span class="startup-name">
          ${esc(it.name)}
          ${it.runningNow ? '<span class="chip running">running</span>' : ''}
          ${!it.enabled ? '<span class="chip">off</span>' : ''}
        </span>
        <span class="startup-line">
          <span class="startup-cmd" title="${esc(it.command || '')}">${esc(it.command || 'no command recorded')}</span>
          <button class="evidence-toggle" data-evidence="su-${it.idx}">Show the evidence</button>
        </span>
        <div class="evidence" id="su-${it.idx}" hidden>
          <span class="evidence-label">How NexaFiles found this</span>
          ${esc(it.evidence)}
          ${it.control?.note ? `<br><br><strong>Switching it off:</strong> ${esc(it.control.note)}` : ''}
        </div>
      </div>
      <span class="startup-cost">${cost ? esc(cost) : '<span class="muted">not running</span>'}</span>
      <button class="btn small" data-startup-toggle="${it.idx}"
              ${can ? '' : 'disabled'}
              title="${esc(it.control?.note || '')}">
        ${it.enabled ? `${icon('power', { size: 13 })} Turn off` : `${icon('check', { size: 13 })} Turn on`}
      </button>
    </div>`;
}

// ── running now ────────────────────────────────────────────────────────────

function viewBackground() {
  const b = state.background;
  if (!b) {
    return progressBlock() + `
      <div class="panel">
        <header><h2>What is running now</h2></header>
        <p class="muted" style="max-width:80ch">
          Everything running on this machine, one row per program rather than one
          per process — a browser is thirty processes and knowing what the browser
          costs is the useful figure, not what its twenty-second tab costs.
        </p>
        <p class="muted" style="max-width:80ch">
          Closing something here frees its memory immediately, and is the only
          action in NexaFiles with no undo: anything the program has not saved is
          gone. So it is asked to close first, the way clicking its X asks it —
          a program with unsaved work gets to put up its own prompt.
        </p>
        <div class="row" style="margin-top:14px">
          <button class="btn primary" id="load-background">${icon('activity')} Show what is running</button>
        </div>
      </div>`;
  }

  const closable = b.groups.filter((g) => g.control.closable);
  const shown = state.backgroundFilter === 'closable' ? closable : b.groups;
  // The rows are addressed by position, so the list the buttons were drawn from
  // is the list the click handler resolves against. Re-deriving it there would
  // work until the filter changed between the two, and then it would close the
  // wrong program.
  backgroundShown = shown;

  return progressBlock() + `
    <div class="panel">
      <header>
        <h2>What is running now</h2>
        <div class="actions">
          <button class="btn small" id="load-background">${icon('refresh', { size: 13 })} Re-measure</button>
          <button class="btn small" id="load-background-cpu">${icon('cpu', { size: 13 })} With CPU</button>
        </div>
      </header>
      <div class="plan-totals">
        <div>
          <div class="plan-total-value">${formatNumber(b.groups.length)}</div>
          <div class="plan-total-label">programs, across
            ${formatNumber(b.processCount)} processes</div>
        </div>
        <div>
          <div class="plan-total-value">${formatBytes(b.totalRssBytes, 1)}</div>
          <div class="plan-total-label">working set across all of them</div>
        </div>
        <div>
          <div class="plan-total-value">${formatNumber(closable.length)}</div>
          <div class="plan-total-label">that NexaFiles will offer to close;
            the rest are parts of Windows</div>
        </div>
      </div>
      <div class="panel-note">
        ${icon('info', { size: 13 })}
        Measured ${new Date(b.measuredAt).toLocaleTimeString()}.
        ${b.cpuMeasured
          ? 'CPU is a genuine percentage, taken by diffing two samples one second apart.'
          : 'CPU is not shown: a single reading of a cumulative counter is not a percentage. ' +
            'Press "With CPU" to spend a second measuring it properly.'}
        Working set is memory the process currently has resident — it is not the
        amount that would be freed, because parts of it are shared with other
        processes.
      </div>
      <div class="filter-bar">
        <button class="chip-btn" data-bg-filter="all"
                aria-pressed="${state.backgroundFilter !== 'closable'}">Everything</button>
        <button class="chip-btn" data-bg-filter="closable"
                aria-pressed="${state.backgroundFilter === 'closable'}">Only what I can close</button>
        <span class="filter-count">${formatNumber(shown.length)} shown</span>
      </div>
    </div>

    <div class="panel">
      <div class="list-scroll" style="max-height:560px">
        <table class="table">
          <thead><tr>
            <th>Program</th>
            ${b.cpuMeasured ? '<th class="num">CPU</th>' : ''}
            <th class="num">Memory</th>
            <th class="num">Processes</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${shown.slice(0, 200).map((g, i) => `
              <tr class="${g.control.closable ? '' : 'is-protected'}">
                <td>
                  <div class="name">${esc(g.name)}
                    ${g.control.severity === 'heavy'
                      ? '<span class="chip caution-chip">part of the desktop</span>' : ''}
                    ${g.control.severity === 'critical'
                      ? '<span class="chip">Windows</span>' : ''}
                    ${g.control.severity === 'security'
                      ? '<span class="chip caution-chip">security software</span>' : ''}</div>
                  <div class="path">${esc(g.execPath || 'path not readable without elevation')}</div>
                  ${g.control.closable ? '' : `
                    <div class="dupe-detail">${esc(g.control.reason)}</div>`}
                </td>
                ${b.cpuMeasured
                  ? `<td class="num bytes">${g.cpuPercent === null
                      ? '<span class="muted">—</span>'
                      : `${g.cpuPercent.toFixed(1)}%`}</td>`
                  : ''}
                <td class="num bytes">${formatBytes(g.rssBytes)}</td>
                <td class="num muted">${formatNumber(g.processCount)}</td>
                <td class="num">
                  <button class="btn small" data-end-program="${i}"
                          ${g.control.closable ? '' : 'disabled'}
                          title="${esc(g.control.reason)}">
                    ${g.control.closable ? 'Close' : 'Protected'}
                  </button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${shown.length > 200 ? `
        <div class="panel-note">${icon('info', { size: 13 })}
          Showing the 200 largest of ${formatNumber(shown.length)}.</div>` : ''}
    </div>`;
}

// ── system ─────────────────────────────────────────────────────────────────

function viewSystem() {
  const s = state.system;
  if (!s) {
    return `<div class="panel">
      <header><h2>System</h2></header>
      <button class="btn primary" id="load-system">${icon('activity')} Measure current load</button>
    </div>`;
  }

  return `
    <div class="panel">
      <header>
        <h2>Current load</h2>
        <div class="actions"><button class="btn small" id="load-system">${icon('activity')} Measure again</button></div>
      </header>
      <div class="plan-totals">
        <div>
          <div class="plan-total-value">${s.cpu.percent.toFixed(0)}<span style="font-size:0.45em">%</span></div>
          <div class="plan-total-label">CPU across ${s.cpu.cores} cores,
            sampled over ${s.cpu.intervalMs} ms</div>
        </div>
        <div>
          <div class="plan-total-value">${formatBytes(s.memory.usedBytes, 1)}</div>
          <div class="plan-total-label">of ${formatBytes(s.memory.totalBytes)} memory in use</div>
        </div>
        <div>
          <div class="plan-total-value">${formatBytes(s.own.workingSetBytes, 1)}</div>
          <div class="plan-total-label">used by NexaFiles itself,
            across ${s.own.processCount} process(es)</div>
        </div>
      </div>
      <div class="panel-note">
        ${icon('info', { size: 13 })}
        NexaFiles deliberately offers no way to "free" memory. On macOS, flushing
        caches the system maintains on purpose leaves the machine slower while it
        rebuilds them; on Windows, clearing the standby list needs kernel-level
        tooling and is genuinely risky. A modern operating system manages memory
        better than a utility like this one can, so this panel reports and does
        not intervene.
        ${s.memory.caveat ? `<br><br>${esc(s.memory.caveat)}` : ''}
        ${!s.loadAverage.available ? `<br><br>${esc(s.loadAverage.reason)}` : ''}
      </div>
    </div>

    <div class="panel">
      <header><h2>Memory by process</h2>
        <span class="muted">top ${Math.min(30, (state.processes || []).length)}</span>
      </header>
      ${(state.processes || []).length ? `
        <div class="list-scroll">
          <table class="table">
            <thead><tr><th>Process</th><th>Path</th><th class="num">Memory</th></tr></thead>
            <tbody>
              ${state.processes.slice(0, 30).map((p) => `
                <tr>
                  <td class="name">${esc(p.name)} <span class="muted mono">${p.pid}</span></td>
                  <td class="path">${esc(p.execPath || 'not readable without elevation')}</td>
                  <td class="num bytes">${formatBytes(p.rssBytes)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="muted">Not measured yet.</p>'}
    </div>`;
}

// ── quarantine ─────────────────────────────────────────────────────────────

/**
 * What quarantine is for, in the words of the problem it solves.
 *
 * The name is jargon and the empty state used to assume the reader already knew
 * what it meant. It is not an antivirus quarantine and it is not a second
 * recycle bin: it is the undo for the one class of deletion the recycle bin
 * handles badly — a folder buried inside AppData that has to go back to the
 * exact path it came from, under its exact name, or the application that owns
 * it will not find it.
 */
function quarantineExplainer() {
  return `
    <div class="panel-note">
      ${icon('info', { size: 13 })}
      <strong>What quarantine is, and why it is not the recycle bin</strong>
      <ul>
        <li><strong>Files you would recognise never come here.</strong> A photo, a
          document, a download — those go to the recycle bin, because that is the
          undo you already know how to use.</li>
        <li><strong>Application internals come here instead.</strong> Leftover
          cache and support folders from under AppData restore to the exact path,
          name and timestamp they had. Dragging a folder back out of the recycle
          bin does not reliably do that, and an application that cannot find its
          own folder where it left it behaves as though its data is gone.</li>
        <li><strong>Every item keeps the reason it was removed.</strong> If
          something stops working a week later, this list can tell you what was
          taken and what the evidence for taking it was — so "restore it and see"
          is an answer available to you rather than a guess.</li>
        <li><strong>It empties itself after 30 days.</strong> Until then nothing
          is actually deleted; the bytes are simply held somewhere the application
          that owned them cannot see. After that the space is genuinely returned.</li>
      </ul>
    </div>`;
}

function viewQuarantine() {
  const q = state.quarantine;
  if (!q || !q.items.length) {
    return `
      <div class="empty">
        ${illustration('emptyQuarantine')}
        <h2>Quarantine is empty</h2>
        <p>Nothing has been removed from inside an application yet. When something
           is, it is held here rather than deleted — so a removal that turns out to
           have been a mistake is a mistake you can take back.</p>
      </div>
      <div class="panel">
        <header><h2>What this is for</h2></header>
        ${quarantineExplainer()}
      </div>`;
  }

  return `
    <div class="panel">
      <header>
        <h2>Quarantine</h2>
        <span class="muted">${q.items.length} item(s), ${formatBytes(q.totalBytes)}</span>
      </header>
      <p class="muted" style="margin-top:-6px">
        Each of these can be restored to its original location. After its expiry
        date it is deleted permanently.
      </p>
      ${quarantineExplainer()}
      <div style="margin-top:14px">
        ${q.items.map((it, i) => `
          <div class="plan-row">
            <span>${icon(it.isDirectory ? 'folder' : 'file')}</span>
            <div class="stack">
              <span class="plan-name">${esc(it.name)}</span>
              <span class="plan-path">${esc(it.originalPath)}</span>
              <span class="plan-reason">
                Held since ${esc(it.quarantinedAt.slice(0, 10))}.
                Deleted permanently after ${esc(it.expiresAt.slice(0, 10))}.
              </span>
              ${it.evidence ? `
                <button class="evidence-toggle" data-evidence="q-${i}">Why it was removed</button>
                <div class="evidence" id="q-${i}" hidden>
                  <span class="evidence-label">Recorded at the time of removal</span>
                  ${esc(it.evidence)}
                </div>` : ''}
            </div>
            <button class="btn small" data-restore="${esc(it.id)}">
              ${icon('restore')} Restore
            </button>
            <span class="plan-bytes">${formatBytes(it.bytes)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function needScan(action) {
  return `
    <div class="empty">
      ${illustration('firstRun')}
      <h2>No scan has run yet</h2>
      <p>NexaFiles needs to measure a folder before it can ${esc(action)}.</p>
      <button class="btn primary" id="empty-choose">${icon('scan')} Choose a folder to scan</button>
    </div>`;
}

// ── aside: plan preview and assistant ──────────────────────────────────────

/**
 * One message in the transcript.
 *
 * An assistant turn is not only prose. It can carry a question back to the user
 * — a list of files that all match what they asked for — or a proposal to
 * convert some of them, or the record of a conversion they approved. Each of
 * those is a thing to act on rather than to read, so each gets its own block
 * under the text rather than being flattened into a sentence.
 */
function chatMessage(m, index) {
  return `
    <div class="chat-msg ${m.role}">
      <div class="who">${m.role === 'user' ? 'You' : 'Assistant'}</div>
      ${m.files?.length ? `<div class="chat-files">${m.files.map((f) => `
        <span class="chat-file">${icon(f.kind === 'image' ? 'image' : 'document', { size: 11 })}
          ${esc(f.name)}</span>`).join('')}</div>` : ''}
      ${m.text && !m.pending ? `<div class="body">${esc(m.text)}</div>` : ''}
      ${m.pending ? chatPending(m) : ''}
      ${m.choice ? chatChoice(m.choice, index) : ''}
      ${m.conversion ? chatConversion(m.conversion, index) : ''}
      ${m.results ? chatResults(m.results) : ''}
      ${m.tools?.length ? `<div class="chat-tools">Used: ${
        [...new Set(m.tools.map((t) => t.name))].map(esc).join(', ')}</div>` : ''}
      ${m.attachmentNotes?.length ? `<div class="chat-tools">${
        m.attachmentNotes.map((n) => esc(n.note)).join(' ')}</div>` : ''}
    </div>`;
}

/** The live commentary under a question that has not been answered yet. */
function chatPending(m) {
  return `
    <div class="chat-working">
      <span class="chat-dots"><i></i><i></i><i></i></span>
      <span class="chat-stage">${esc(state.chatStage || m.text || 'Thinking…')}</span>
    </div>`;
}

/**
 * "Which of these did you mean" — the question the assistant asks back.
 *
 * Every row shows the passage that put the file on the list, with the matched
 * words marked, because the user is choosing between their own documents and the
 * thing that identifies one is what it says, not its name. Answered lists stay
 * on screen but stop being clickable: the choice was made and re-making it would
 * ask the same question of a conversation that has moved on.
 */
function chatChoice(choice, index) {
  const answered = !!choice.answered;
  return `
    <div class="chat-choice ${answered ? 'answered' : ''}">
      <p class="choice-q">${esc(choice.question)}</p>
      ${choice.options.map((o) => `
        <button class="choice-file" data-choice="${index}" data-path="${esc(o.path)}"
                ${answered ? 'disabled' : ''}
                ${choice.answered === o.path ? 'aria-current="true"' : ''}>
          <span class="choice-mark">${esc((o.extension || '?').slice(0, 4))}</span>
          <span class="choice-text">
            <span class="choice-name">${esc(o.name)}</span>
            <span class="choice-meta">${esc(o.folder)}${
              o.bytes != null ? ` · ${formatBytes(o.bytes)}` : ''}${
              o.lastModified ? ` · ${esc(o.lastModified)}` : ''}</span>
            ${o.snippet ? `<span class="choice-snip">${snippetHtml(o.snippet)}</span>`
              : o.opening ? `<span class="choice-snip">${esc(o.opening)}</span>` : ''}
          </span>
        </button>`).join('')}
    </div>`;
}

/**
 * A search snippet, with the words that matched marked.
 *
 * The snippet arrives with its matched runs wrapped in the guillemets FTS5 was
 * given, rather than in markup, so that nothing coming out of a file can be
 * interpreted as HTML. It is escaped first and the markers are turned into tags
 * afterwards, which is the only order in which that holds.
 */
function snippetHtml(snippet) {
  return esc(String(snippet))
    .replace(/‹/g, '<mark>')
    .replace(/›/g, '</mark>');
}

/**
 * A conversion the assistant proposed and nobody has approved yet.
 *
 * Every destination is shown before anything is written, because a conversion
 * writes a file the user did not have. Approving it here sends only the
 * proposal's id back: the paths never leave the main process, so an approval of
 * one conversion cannot be redeemed for another.
 */
function chatConversion(c, index) {
  const clashes = c.items.filter((i) => i.targetExists).length;
  return `
    <div class="chat-proposal ${c.spent ? 'spent' : ''}">
      ${c.items.map((i) => `
        <div class="proposal-row">
          <span class="proposal-name" title="${esc(i.source)}">${esc(i.name)}</span>
          <span class="proposal-arrow">→</span>
          <span class="proposal-name to" title="${esc(i.target)}">${esc(i.targetName)}</span>
          ${i.targetExists ? '<span class="proposal-tag">exists</span>' : ''}
        </div>`).join('')}
      <p class="proposal-note">Converted by ${esc(c.engine)}. The original is never
         changed or removed — this adds a file beside it${
         clashes ? ', under a numbered name where one is already there' : ''}.</p>
      ${c.spent ? '' : `
        <div class="proposal-actions">
          <button class="btn primary" data-convert="${index}">
            ${icon('check', { size: 14 })} Convert ${c.items.length === 1 ? 'it' : `all ${c.items.length}`} to ${esc(c.format.toUpperCase())}
          </button>
          <button class="btn" data-dismiss-conversion="${index}">Not now</button>
        </div>`}
    </div>`;
}

/** What a conversion actually produced, once it has run. */
function chatResults(res) {
  const made = (res.results || []).filter((r) => r.ok);
  const failed = (res.results || []).filter((r) => !r.ok);
  return `
    <div class="chat-proposal done">
      ${made.map((r) => `
        <div class="proposal-row">
          <span class="proposal-tag new">${esc(extOf(r.target))}</span>
          <span class="proposal-name" title="${esc(r.target)}">${esc(baseName(r.target))}</span>
          <span class="proposal-meta">${formatBytes(r.bytes)}</span>
          <button class="proposal-link" data-reveal="${esc(r.target)}">Show</button>
          <button class="proposal-link" data-open="${esc(r.target)}">Open</button>
        </div>`).join('')}
      ${failed.map((r) => `
        <div class="proposal-row failed">
          ${icon('caution', { size: 12 })}
          <span class="proposal-name" title="${esc(r.source)}">${esc(baseName(r.source))}</span>
          <span class="proposal-meta">${esc(r.error || 'could not be converted')}</span>
        </div>`).join('')}
    </div>`;
}

/** The label on a produced file, taken from the file itself rather than assumed. */
function extOf(p) {
  const name = baseName(p);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE';
}

function baseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

function renderAside() {
  const tabs = document.getElementById('aside-tabs');
  const body = document.getElementById('aside-body');
  const foot = document.getElementById('aside-foot');

  // The composer's contents are state, and have to be treated as state: this
  // panel is rebuilt whenever anything re-renders the shell — switching to the
  // Plan tab and back, finishing a scan, or the session graph refreshing itself
  // every fifteen seconds — and a half-typed question used to vanish with it.
  // Captured before either branch runs, because both replace the panel.
  const liveInput = foot.querySelector('#chat-input');
  if (liveInput) state.chatDraft = liveInput.value;
  const hadFocus = !!liveInput && document.activeElement === liveInput;
  const caret = liveInput ? liveInput.selectionStart : null;

  // Whether the transcript was scrolled to its end, measured before the panel is
  // replaced because afterwards the old position is gone. This decides whether
  // the new content is followed. This shell re-renders on a timer — the session
  // graph refreshes every fifteen seconds — so pinning unconditionally would
  // repeatedly throw someone out of a transcript they had scrolled back through.
  // Arriving on the tab counts as being at the end: the measurement in hand
  // describes whatever the panel was showing before, which on a tab switch is the
  // other tab's content and says nothing about the transcript.
  const arriving = renderAside.lastTab !== 'chat';
  renderAside.lastTab = state.asideTab;
  const atBottom = arriving || !body.scrollHeight ||
    body.scrollHeight - body.scrollTop - body.clientHeight < 48;

  tabs.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === state.asideTab));
  });

  if (state.asideTab === 'plan') {
    body.innerHTML = state.plan ? planPreview(state.plan) : `
      <div style="padding:20px 4px">
        <p class="muted">No plan is waiting.</p>
        <p class="muted">Find duplicates or leftovers, then build a plan. Nothing
           is ever removed until you have seen the list and approved it.</p>
      </div>`;
    foot.innerHTML = state.plan ? `
      <button class="btn destructive" id="approve-plan" style="width:100%;justify-content:center">
        ${icon('trash')} ${planActionLabel(state.plan)}
      </button>
      <p class="muted" style="margin:8px 0 0;font-size:12px">
        ${state.plan.totals.selectedCount} of ${state.plan.totals.itemCount} item(s) selected.
        Files go to the system trash; application data goes to quarantine for 30 days.
      </p>` : '';
    wireAside();
    return;
  }

  body.innerHTML = state.chat.length
    ? state.chat.map((m, i) => chatMessage(m, i)).join('')
    : `
    <div style="padding:20px 4px">
      <p class="muted">Ask about what the scan measured, or about what is inside
         your documents — "the blog I wrote about elephants" finds the file by
         reading them, not by guessing at filenames.</p>
      <p class="muted">The assistant can read the scan results and propose a
         cleanup or a conversion to PDF, but it cannot delete, move or write
         anything itself — every proposal comes back here for you to approve.</p>
      <p class="muted">Drop a file here, or drag one out of the Files view, and it
         will be read: a picture is sent as an image, a PDF, Word or text file as
         the text inside it.</p>
      <p class="muted">Or press the microphone and speak. What you said is
         written into the box below for you to read and correct — nothing is
         asked until you press Send.</p>
    </div>`;

  // A transcript that grows off the bottom of a panel nobody scrolled is a
  // transcript with the answer hidden in it — but only someone already reading
  // the end wants to be carried along. Pinned after the paint rather than during
  // it, because the new height is not known until the browser has laid the
  // message out.
  if (atBottom) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });

  foot.innerHTML = `
    ${state.chatAttachments.length ? `
      <div class="chat-attachments">
        ${state.chatAttachments.map((a, i) => `
          <span class="chat-chip ${a.error ? 'error' : ''}" title="${esc(a.path)}">
            ${icon(a.error ? 'caution' : a.kind === 'image' ? 'image' : 'document', { size: 13 })}
            <span class="chip-name">${esc(a.name)}</span>
            ${a.error ? '' : `<span class="chip-size">${formatBytes(a.size)}</span>`}
            <button data-drop-attachment="${i}" aria-label="Remove ${esc(a.name)}">
              ${icon('x', { size: 12 })}
            </button>
          </span>`).join('')}
      </div>` : `
      <div class="chat-dropzone">
        ${icon('attach', { size: 14 })}
        <span>Drop a file here to ask about it.</span>
      </div>`}
    <textarea class="chat-input" id="chat-input" rows="3"
      placeholder="${state.chatAttachments.length
        ? 'Summarise this, or ask anything about it'
        : 'What is taking up the most space?'}">${esc(state.chatDraft)}</textarea>
    ${voiceStatus()}
    <div class="composer-actions">
      <button class="btn mic ${state.voice.phase}" id="chat-mic"
              title="${micTitle()}" aria-label="${micTitle()}"
              aria-pressed="${state.voice.phase === 'recording'}"
              ${micDisabled() ? 'disabled' : ''}>
        ${icon(state.voice.supported === false ? 'micOff'
          : state.voice.phase === 'recording' ? 'stopSquare' : 'mic')}
      </button>
      ${state.chatBusy ? `
        <button class="btn" id="chat-stop" style="flex:1;justify-content:center">
          ${icon('stopSquare')} Stop
        </button>` : `
        <button class="btn primary" id="chat-send" style="flex:1;justify-content:center"
                ${state.voice.phase !== 'idle' ? 'disabled' : ''}>
          ${icon('send')} Send
        </button>`}
    </div>
    ${state.chat.length ? `
      <button class="chat-clear" id="chat-clear" ${state.chatBusy ? 'disabled' : ''}>
        Clear this conversation
      </button>` : ''}`;

  // Put the caret back where it was, so a re-render mid-sentence is invisible.
  if (hadFocus) {
    const restored = foot.querySelector('#chat-input');
    if (restored) {
      restored.focus();
      const at = Math.min(caret ?? restored.value.length, restored.value.length);
      restored.setSelectionRange(at, at);
    }
  }
  wireAside();
}

// ── spoken input ───────────────────────────────────────────────────────────
//
// The microphone fills in the composer. It does not send anything: what comes
// back from transcription lands in the text box, where the user reads it,
// corrects the word it got wrong, and presses Send — the same deliberate act
// that a typed question ends with. An assistant that acted on speech the
// moment it heard it would be one misheard sentence away from proposing a
// deletion nobody asked for.

function micDisabled() {
  return state.voice.supported === false
    || state.voice.phase === 'starting'
    || state.voice.phase === 'transcribing';
}

function micTitle() {
  if (state.voice.supported === false) return 'This build cannot record audio.';
  switch (state.voice.phase) {
    case 'starting':     return 'Opening the microphone…';
    case 'recording':    return 'Stop recording and transcribe';
    case 'transcribing': return 'Transcribing…';
    default:             return 'Ask by voice — the words appear here for you to send';
  }
}

/**
 * The line under the composer while the microphone is open.
 *
 * The meter is a real reading of the signal, not an animation: a bar that moves
 * whether or not anything is being heard would be the one part of this feature
 * that lies. Both the meter and the clock are written directly by the recorder's
 * callbacks — this only lays out the elements they write into.
 */
function voiceStatus() {
  if (state.voice.phase === 'recording') {
    return `
      <div class="voice-status recording" role="status">
        ${icon('mic', { size: 13 })}
        <span class="voice-meter"><span class="voice-level" id="voice-level"></span></span>
        <span class="voice-time" id="voice-time">0:00</span>
        <button class="voice-discard" id="chat-mic-discard">Discard</button>
      </div>`;
  }
  if (state.voice.phase === 'starting') {
    return `<div class="voice-status" role="status">Opening the microphone…</div>`;
  }
  if (state.voice.phase === 'transcribing') {
    return `<div class="voice-status" role="status">Writing down what you said…</div>`;
  }
  return '';
}

function setVoicePhase(phase) {
  state.voice.phase = phase;
  renderAside();
}

async function toggleMic() {
  if (state.voice.phase === 'recording') return stopAndTranscribe();
  if (state.voice.phase === 'idle') return startRecording();
}

async function startRecording() {
  if (state.voice.supported === null) state.voice.supported = voice.isSupported();
  if (!state.voice.supported) {
    toast('This build cannot record audio.', 'error');
    renderAside();
    return;
  }

  // The permission prompt happens inside `start`, and on a first run it can sit
  // there for as long as the user takes to answer. The button says so rather
  // than appearing to have done nothing.
  setVoicePhase('starting');
  try {
    await voice.start({
      onLevel: (level) => {
        const bar = document.getElementById('voice-level');
        if (bar) bar.style.transform = `scaleX(${level.toFixed(3)})`;
      },
      onTick: (ms) => {
        const clock = document.getElementById('voice-time');
        if (clock) clock.textContent = clockText(ms);
      },
      onAutoStop: (why) => {
        toast(why);
        stopAndTranscribe();
      },
    });
  } catch (err) {
    setVoicePhase('idle');
    toast(err.message, 'error');
    return;
  }
  setVoicePhase('recording');
}

async function stopAndTranscribe() {
  if (state.voice.phase !== 'recording') return;
  setVoicePhase('transcribing');

  let clip;
  try {
    clip = await voice.stop();
  } catch (err) {
    // Too short or silent: the recording never reached the network, and saying
    // which of the two it was is more use than "transcription failed".
    setVoicePhase('idle');
    toast(err.message, 'error');
    return;
  }

  const res = await guard(
    () => nexa.agent.transcribe({ data: clip.data, mimeType: clip.mimeType }),
    'Transcribing'
  );
  setVoicePhase('idle');
  if (!res) return;

  if (res.empty) {
    toast('Nothing recognisable was said in that recording.');
    return;
  }

  // Appended, not substituted: a half-typed question plus a spoken clause is a
  // reasonable thing to do, and silently discarding what was already there
  // would lose work.
  const existing = state.chatDraft.trim();
  state.chatDraft = existing ? `${existing} ${res.text}` : res.text;
  renderAside();

  const input = document.getElementById('chat-input');
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = input.scrollHeight;
  }
}

/** Abandons the recording. Nothing is transcribed and nothing is sent. */
function discardRecording() {
  if (state.voice.phase !== 'recording') return;
  voice.cancel();
  setVoicePhase('idle');
  toast('Recording discarded.');
}

function clockText(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function planActionLabel(plan) {
  const sel = plan.entries.filter((e) => e.selected);
  const bytes = sel.reduce((n, e) => n + e.bytes, 0);
  return sel.length === 0 ? 'Nothing selected' : `Remove ${sel.length} item(s), ${formatBytes(bytes)}`;
}

function planPreview(plan) {
  const regen = plan.entries.filter((e) => e.category === 'regenerable');
  const userData = plan.entries.filter((e) => e.category === 'user-data');

  const rows = (entries, prefix) => entries.map((e, i) => `
    <div class="plan-row ${e.selected ? 'selected-for-removal' : ''}">
      <input type="checkbox" data-entry="${esc(e.id)}" ${e.selected ? 'checked' : ''}
             aria-label="Include ${esc(e.name)}">
      <div class="stack">
        <span class="plan-name">${esc(e.name)}</span>
        <span class="plan-path">${esc(e.path)}</span>
        <span class="plan-reason">${esc(e.reason)}</span>
        <button class="evidence-toggle" data-evidence="${prefix}-${i}">Show the evidence</button>
        <div class="evidence" id="${prefix}-${i}" hidden>
          <span class="evidence-label">Why this was identified</span>
          ${esc(Array.isArray(e.evidence) ? e.evidence.join(' ') : e.evidence)}
        </div>
      </div>
      <span class="chip confidence-${esc(e.confidence)}">${esc(e.confidence)}</span>
      <span class="plan-bytes">${formatBytes(e.bytes)}</span>
    </div>`).join('');

  return `
    <div class="plan-totals">
      <div>
        <div class="plan-total-value">${formatBytes(plan.totals.selectedBytes, 1)}</div>
        <div class="plan-total-label">selected to remove</div>
      </div>
      <div>
        <div class="plan-total-value">${plan.totals.selectedCount}</div>
        <div class="plan-total-label">of ${plan.totals.itemCount} items</div>
      </div>
    </div>

    ${plan.notes?.length ? `
      <div class="panel-note caution" style="margin:14px 0">
        <ul>${plan.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      </div>` : ''}

    ${regen.length ? `
      <div class="plan-section">
        <h3>${icon('restore', { size: 14 })} Regenerates if removed</h3>
        <p>These rebuild themselves when needed. Selected by default.</p>
        ${rows(regen, 'pr')}
      </div>` : ''}

    ${userData.length ? `
      <div class="plan-section user-data">
        <h3>${icon('caution', { size: 14 })} Possibly your data</h3>
        <p>Not selected, and not selected for you. Check anything here yourself
           before including it.</p>
        ${rows(userData, 'pu')}
      </div>` : ''}`;
}

// ── wiring ─────────────────────────────────────────────────────────────────

function wireStage() {
  const stage = document.getElementById('stage');

  stage.querySelector('#empty-choose')?.addEventListener('click', async () => {
    const chosen = await guard(() => nexa.roots.choose(), 'Choosing folder');
    if (chosen) { await renderRail(); startScan(chosen.path); }
  });
  stage.querySelector('#rescan')?.addEventListener('click', () => {
    if (state.scan) startScan(state.scan.root);
  });
  stage.querySelector('#cancel-scan')?.addEventListener('click', () => {
    state.cancelPending = true;
    renderAll();
    nexa.scan.cancel().catch(() => {});
  });
  stage.querySelector('#cancel-busy')?.addEventListener('click', cancelBusy);
  stage.querySelector('#hero-drill')?.addEventListener('click', async () => {
    if (state.duplicates?.exact?.groups.length) await buildPlan('duplicates', 'exact');
    else if (state.leftovers) await buildPlan('leftovers');
  });

  stage.querySelectorAll('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => { state.view = b.dataset.goto; renderAll(); });
  });
  stage.querySelectorAll('[data-crumb]').forEach((b) => {
    b.addEventListener('click', async () => { await loadComposition(b.dataset.crumb); renderAll(); });
  });
  stage.querySelectorAll('[data-file]').forEach((tr) => {
    tr.addEventListener('dblclick', () => nexa.fs.revealNative(tr.dataset.file).catch(() => {}));
  });

  stage.querySelector('#dupe-pick-folder')?.addEventListener('click', pickDuplicateFolder);
  stage.querySelector('#dupe-clear-folder')?.addEventListener('click', clearDuplicateFolder);
  stage.querySelectorAll('[data-dupe]').forEach((b) => {
    b.addEventListener('click', () => runDuplicates(b.dataset.dupe));
  });
  stage.querySelectorAll('[data-dupe-plan]').forEach((b) => {
    b.addEventListener('click', () => buildPlan('duplicates', b.dataset.dupePlan));
  });

  // Opening a duplicate. Deciding which of five identical files to keep means
  // looking at them, so the row itself opens the file and the two buttons split
  // "open it" from "show me where it lives" — the second being the one that
  // actually answers "which copy is this".
  stage.querySelectorAll('[data-open-dupe]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openDuplicate(b.dataset.openDupe);
    });
  });
  stage.querySelectorAll('[data-reveal-dupe]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      revealDuplicate(b.dataset.revealDupe);
    });
  });
  stage.querySelectorAll('[data-dupe-file]').forEach((tr) => {
    tr.addEventListener('dblclick', () => openDuplicate(tr.dataset.dupeFile));
  });

  stage.querySelector('#find-leftovers')?.addEventListener('click', runLeftovers);
  stage.querySelector('#leftover-plan')?.addEventListener('click', () => buildPlan('leftovers'));
  stage.querySelector('#load-startup')?.addEventListener('click', loadStartup);
  stage.querySelector('#load-system')?.addEventListener('click', loadSystem);

  stage.querySelectorAll('[data-startup-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      state.startupTab = b.dataset.startupTab;
      renderAll();
      // Arriving at the running list for the first time should show it, not an
      // invitation to press one more button.
      if (state.startupTab === 'background' && !state.background) loadBackground();
    });
  });
  stage.querySelectorAll('[data-startup-filter]').forEach((b) => {
    b.addEventListener('click', () => { state.startupFilter = b.dataset.startupFilter; renderAll(); });
  });
  stage.querySelectorAll('[data-startup-toggle]').forEach((b) => {
    b.addEventListener('click', () => toggleStartupItem(Number(b.dataset.startupToggle)));
  });
  stage.querySelector('#load-background')?.addEventListener('click', () => loadBackground());
  stage.querySelector('#load-background-cpu')?.addEventListener('click', () => loadBackground(true));
  stage.querySelectorAll('[data-bg-filter]').forEach((b) => {
    b.addEventListener('click', () => { state.backgroundFilter = b.dataset.bgFilter; renderAll(); });
  });
  stage.querySelectorAll('[data-end-program]').forEach((b) => {
    b.addEventListener('click', () => endProgram(Number(b.dataset.endProgram)));
  });

  stage.querySelectorAll('[data-restore]').forEach((b) => {
    b.addEventListener('click', () => restoreItem(b.dataset.restore));
  });

  stage.querySelectorAll('[data-session-metric]').forEach((b) => {
    b.addEventListener('click', () => {
      state.sessionMetric = b.dataset.sessionMetric;
      renderAll();
    });
  });

  wireEvidence(stage);
}

function wireEvidence(scope) {
  scope.querySelectorAll('[data-evidence]').forEach((b) => {
    b.addEventListener('click', () => {
      const target = document.getElementById(b.dataset.evidence);
      if (!target) return;
      target.hidden = !target.hidden;
      b.textContent = target.hidden ? 'Show the evidence' : 'Hide the evidence';
    });
  });
}

function wireAside() {
  const body = document.getElementById('aside-body');
  const foot = document.getElementById('aside-foot');
  wireEvidence(body);

  body.querySelectorAll('[data-entry]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const ids = [...body.querySelectorAll('[data-entry]')]
        .filter((x) => x.checked).map((x) => x.dataset.entry);
      const updated = await guard(() => nexa.plan.setSelection(state.plan.id, ids), 'Updating selection');
      if (updated) { state.plan = updated; renderAside(); }
    });
  });

  foot.querySelectorAll('[data-drop-attachment]').forEach((b) => {
    b.addEventListener('click', () => {
      state.chatAttachments.splice(Number(b.dataset.dropAttachment), 1);
      renderAside();
    });
  });

  body.querySelectorAll('[data-choice]').forEach((b) => {
    b.addEventListener('click', () => answerChoice(Number(b.dataset.choice), b.dataset.path));
  });
  body.querySelectorAll('[data-convert]').forEach((b) => {
    b.addEventListener('click', () => approveConversion(Number(b.dataset.convert)));
  });
  body.querySelectorAll('[data-dismiss-conversion]').forEach((b) => {
    b.addEventListener('click', () => {
      const m = state.chat[Number(b.dataset.dismissConversion)];
      if (m?.conversion) { m.conversion.spent = true; renderAside(); }
    });
  });
  body.querySelectorAll('[data-reveal]').forEach((b) => {
    b.addEventListener('click', () => guard(() => nexa.fs.revealNative(b.dataset.reveal), 'Showing the file'));
  });
  body.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => guard(() => nexa.fs.openNative(b.dataset.open), 'Opening the file'));
  });

  foot.querySelector('#approve-plan')?.addEventListener('click', executePlan);
  foot.querySelector('#chat-send')?.addEventListener('click', sendChat);
  foot.querySelector('#chat-stop')?.addEventListener('click', stopChat);
  foot.querySelector('#chat-clear')?.addEventListener('click', clearChat);
  foot.querySelector('#chat-mic')?.addEventListener('click', toggleMic);
  foot.querySelector('#chat-mic-discard')?.addEventListener('click', discardRecording);
  foot.querySelector('#chat-input')?.addEventListener('input', (e) => {
    state.chatDraft = e.target.value;
  });
  foot.querySelector('#chat-input')?.addEventListener('keydown', (e) => {
    // Enter sends, because this is a chat box and that is what a chat box does.
    // Shift+Enter is the newline, and Ctrl/Cmd+Enter still sends for anyone who
    // learned it that way.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      sendChat();
      return;
    }
    // Escape is the universal "stop this": a live microphone first, then a
    // question the assistant is still working on.
    if (e.key === 'Escape') {
      if (state.voice.phase === 'recording') { e.preventDefault(); discardRecording(); }
      else if (state.chatBusy) { e.preventDefault(); stopChat(); }
    }
  });
}

// ── actions ────────────────────────────────────────────────────────────────

async function runDuplicates(tier) {
  const scope = state.dupeScope;
  const where = scope ? shortenPath(scope, 34) : null;
  state.busy = where
    ? `Comparing files in ${where}…`
    : `Comparing files (${tier})…`;
  state.busyCancel = () => nexa.duplicates.cancel();
  state.cancelPending = false;
  renderAll();

  const res = await guard(
    () => nexa.duplicates.find(tier, { under: scope }), 'Duplicate scan');
  state.busy = null;
  state.busyCancel = null;
  state.cancelPending = false;

  if (res) {
    state.duplicates = { ...(state.duplicates || {}), [tier]: res };
    // The toast names the folder for the same reason the panel does: a count
    // with no scope attached reads as a statement about the whole disk. A
    // stopped search says so in the same breath, because "no duplicates found"
    // after a cancellation would be a claim the search never earned.
    const place = res.scopeName ? ` in ${res.scopeName}` : '';
    if (res.cancelled) {
      toast(res.groups.length
        ? `Stopped. ${res.groups.length} group(s) found${place} before it stopped.`
        : `Stopped before anything was found${place}.`);
    } else {
      toast(res.groups.length
        ? `${res.groups.length} group(s) found${place}, ${formatBytes(res.totalWasted)} reclaimable.`
        : `No duplicates found${place}.`);
    }
  }
  renderAll();
}

/** The Stop button under whichever long job is running. */
async function cancelBusy() {
  if (!state.busyCancel || state.cancelPending) return;
  state.cancelPending = true;
  renderAll();
  await guard(state.busyCancel, 'Stopping');
}

/**
 * Narrows the duplicate search to one folder.
 *
 * Offered from the scan root, because this filters what the scan already
 * measured rather than starting a new one. A folder outside the scan is refused
 * by the main process with a sentence saying so, which is surfaced as-is rather
 * than being turned into a generic failure.
 */
async function pickDuplicateFolder() {
  const picked = await guard(
    () => nexa.roots.pick('Find duplicates in which folder?'), 'Choosing a folder');
  if (!picked?.path) return;

  state.dupeScope = picked.path;
  // Results already on screen describe a different search, so they go rather
  // than sitting under a heading that now says something else.
  state.duplicates = null;
  renderAll();
  toast(`Duplicate searches will look in ${shortenPath(picked.path, 40)}.`);
}

function clearDuplicateFolder() {
  state.dupeScope = null;
  state.duplicates = null;
  renderAll();
}

async function runLeftovers() {
  state.busy = 'Comparing application data against installed applications…';
  state.busyCancel = () => nexa.leftovers.cancel();
  state.cancelPending = false;
  renderAll();

  const res = await guard(() => nexa.leftovers.find(), 'Leftover scan');
  state.busy = null;
  state.busyCancel = null;
  state.cancelPending = false;

  if (res) {
    state.leftovers = res;
    if (res.cancelled) {
      toast(res.findings.length
        ? `Stopped. ${res.findings.length} folder(s) found before it stopped.`
        : 'Stopped before anything was found.');
    } else {
      toast(res.findings.length
        ? `${res.findings.length} folder(s) found.`
        : 'Nothing looks left behind.');
    }
  }
  renderAll();
}

async function buildPlan(kind, tier) {
  const plan = await guard(
    () => (kind === 'duplicates' ? nexa.plan.fromDuplicates(tier) : nexa.plan.fromLeftovers()),
    'Building plan'
  );
  if (!plan) return;
  if (!plan.entries.length) { toast('There is nothing to propose.'); return; }
  state.plan = plan;
  if (state.voice.phase === 'recording') discardRecording();
  state.asideTab = 'plan';
  renderAside();
  toast(`Plan ready: ${plan.entries.length} item(s) to review.`);
}

async function executePlan() {
  if (!state.plan) return;
  const sel = state.plan.entries.filter((e) => e.selected);
  if (!sel.length) { toast('Nothing is selected.'); return; }

  const bytes = formatBytes(sel.reduce((n, e) => n + e.bytes, 0));
  const ok = window.confirm(
    `Remove ${sel.length} item(s), ${bytes}?\n\n` +
    `Files go to the system trash. Application data goes to quarantine and can be ` +
    `restored for 30 days.`
  );
  if (!ok) return;

  const result = await guard(() => nexa.plan.execute(state.plan.id), 'Executing plan');
  if (!result) return;

  state.plan = null;
  const s = result.summary;
  toast(`Removed ${s.trashed + s.quarantined} item(s), ${formatBytes(s.bytesReclaimed)} reclaimed.` +
    (s.skipped ? ` ${s.skipped} skipped.` : '') + (s.failed ? ` ${s.failed} failed.` : ''));

  if (s.failed || s.skipped) {
    for (const r of result.results.filter((x) => x.status !== 'trashed' && x.status !== 'quarantined')) {
      toast(`${r.name}: ${r.detail}`, 'error');
    }
  }

  state.leftovers = null;
  state.duplicates = null;
  await refreshQuarantine();
  await loadSummary();
  await renderRail();
  renderAll();
}

async function restoreItem(id) {
  const res = await guard(() => nexa.quarantine.restore(id), 'Restore');
  if (res) {
    toast(res.renamed
      ? `Restored beside the existing file, as ${res.restoredTo.split(/[\\/]/).pop()}.`
      : `Restored to ${res.restoredTo}.`);
    await refreshQuarantine();
    await renderRail();
    renderAll();
  }
}

async function refreshQuarantine() {
  state.quarantine = await guard(() => nexa.quarantine.list(), 'Reading quarantine');
}

// ── opening a duplicate ────────────────────────────────────────────────────

/**
 * Opens one of the files in a duplicate group.
 *
 * Goes through the Files view's own open, so a duplicate that turns out to be
 * an executable gets the same "run this program?" question it would get in the
 * Files view. A duplicate list is precisely where a stray copy of an installer
 * ends up, and it would be a poor place to lose that check.
 */
async function openDuplicate(filePath) {
  if (!filePath) return;
  try {
    const res = await nexa.explorer.open(filePath);
    if (res && res.cancelled) toast('Left it alone.');
  } catch (err) {
    if (err.code === 'IS_DIRECTORY') {
      state.view = 'files';
      renderAll();
      explorer.navigate(filePath, { push: true });
      return;
    }
    // The commonest failure by far is that the copy has already been removed
    // since the scan, which is worth saying plainly rather than passing on a
    // shell error about a path.
    toast(`Could not open it: ${err.message}`, 'error');
  }
}

async function revealDuplicate(filePath) {
  if (!filePath) return;
  const ok = await guard(() => nexa.explorer.reveal(filePath), 'Showing the file');
  if (ok) toast('Opened its folder.');
}

// ── startup and background load ────────────────────────────────────────────

async function loadStartup() {
  state.busy = 'Reading startup entries and measuring what they are using…';
  renderAll();
  state.startup = await guard(() => nexa.startup.list(), 'Startup');
  state.busy = null;
  renderAll();
}

/**
 * Switches one startup entry on or off.
 *
 * The list is re-read afterwards rather than patched, because the answer to
 * "did that work" is what the registry says now, not what this function
 * intended. A write that silently failed would otherwise leave a row claiming
 * a state the machine is not in.
 */
async function toggleStartupItem(index) {
  const item = state.startup?.items?.[index];
  if (!item) return;

  const turningOff = item.enabled;
  if (turningOff && item.kind === 'service') {
    const ok = window.confirm(
      `Stop the service "${item.name}" starting with Windows?\n\n` +
      `It will be set to start on demand rather than automatically, so anything ` +
      `that genuinely needs it can still start it. It is not disabled outright, ` +
      `and this can be undone from this same list.`);
    if (!ok) return;
  }

  state.busy = `${turningOff ? 'Switching off' : 'Switching on'} ${item.name}…`;
  renderAll();

  const res = await guard(
    () => nexa.startup.setEnabled(
      { kind: item.kind, source: item.source, location: item.location, name: item.name },
      !turningOff),
    'Changing a startup item');

  state.busy = null;
  if (res) {
    toast(turningOff
      ? `${item.name} will not start with Windows. It is still installed, and this ` +
        `list can switch it back on.`
      : `${item.name} will start with Windows again.`);
    // Re-read, so what is on screen is what is on the machine.
    state.startup = await guard(() => nexa.startup.list(), 'Startup');
  }
  renderAll();
}

async function loadBackground(withCpu = false) {
  state.busy = withCpu
    ? 'Measuring CPU across one second, and memory for every process…'
    : 'Reading what is running…';
  renderAll();
  const res = await guard(() => nexa.system.background({ withCpu }), 'Running programs');
  if (res) state.background = res;
  state.busy = null;
  renderAll();
}

/**
 * Closes every process belonging to one program.
 *
 * The confirmation is deliberately specific — the name, the process count, the
 * memory, and what closing costs — because this is the only thing NexaFiles
 * does that cannot be undone, and a generic "are you sure?" would not give
 * anybody enough to answer with.
 */
async function endProgram(index) {
  const g = backgroundShown[index];
  if (!g) return;
  if (!g.control.closable) { toast(g.control.reason, 'error'); return; }

  const ok = window.confirm(
    `Close ${g.name}?\n\n` +
    `${g.processCount} process(es), ${formatBytes(g.rssBytes)} of memory.\n\n` +
    `${g.control.reason}\n\n` +
    `This cannot be undone, and it does not stop ${g.name} starting again next ` +
    `time you log in — use "Starts with Windows" for that.`);
  if (!ok) return;

  state.busy = `Closing ${g.name}…`;
  renderAll();
  const res = await guard(() => nexa.system.endProgram(g.name, g.pids), 'Closing a program');
  state.busy = null;

  if (res) {
    if (res.closed && !res.failed) {
      toast(`${g.name} closed — ${res.closed} process(es).` +
        (res.forced ? ' Some had to be terminated.' : ''));
    } else if (res.closed) {
      toast(`${res.closed} of ${res.closed + res.failed} process(es) closed. ` +
        `The rest are running with rights NexaFiles does not have.`, 'error');
    } else {
      toast(`${g.name} could not be closed. ` +
        `${res.results[0]?.detail || ''}`, 'error');
    }
    // Re-measure rather than removing the row: what actually happened is a
    // question for the operating system, and a program that respawns itself
    // should be visibly still there.
    await loadBackground(state.background?.cpuMeasured);
    return;
  }
  renderAll();
}

async function loadSystem() {
  state.busy = 'Sampling CPU over one second…';
  renderAll();
  const [load, procs] = await Promise.all([
    guard(() => nexa.system.load(), 'System load'),
    guard(() => nexa.system.processes(), 'Processes'),
  ]);
  state.system = load;
  state.processes = procs || [];
  state.busy = null;
  renderAll();
}

/**
 * One turn, however it was started.
 *
 * A typed question and an answer to "which of these did you mean" are the same
 * thing from here: a message goes to the main process, a placeholder holds the
 * bottom of the transcript while it runs, and whatever comes back replaces it.
 * Everything that makes the turn interruptible or narratable lives here rather
 * than being repeated at each call site.
 */
async function runTurn(send, { pendingText = 'Thinking…' } = {}) {
  state.chatBusy = true;
  state.chatStage = null;
  state.chat.push({ role: 'assistant', text: pendingText, pending: true });
  renderAside();

  const res = await guard(send, 'Assistant');

  state.chatBusy = false;
  state.chatStage = null;
  state.chat.pop();   // the placeholder

  if (!res) { renderAside(); return null; }

  // A stopped turn is not an answer and is not recorded as one. Saying so in one
  // line is better than an empty bubble, which reads as the assistant having
  // replied with nothing.
  if (res.cancelled) {
    state.chat.push({ role: 'assistant', text: 'Stopped.' });
    renderAside();
    return res;
  }

  state.chat.push({
    role: 'assistant',
    text: res.reply,
    tools: res.toolCalls,
    choice: res.choice || null,
    conversion: res.conversion || null,
    // Anything that could not be read is reported next to the reply rather
    // than left for the user to infer from a vague answer.
    attachmentNotes: (res.attachments || []).filter((a) => !a.ok),
  });

  if (res.plan) {
    state.plan = res.plan;
    toast('The assistant proposed a plan. Review it in the Plan tab before approving.');
  }
  renderAside();
  return res;
}

async function sendChat() {
  if (state.voice.phase !== 'idle' || state.chatBusy) return;
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  const files = state.chatAttachments.filter((a) => !a.error);
  if (!text && !files.length) return;

  input.value = '';
  state.chatDraft = '';
  const question = text || 'Describe the attached file(s).';
  const paths = files.map((f) => f.path);
  state.chatAttachments = [];
  state.chat.push({ role: 'user', text: question, files });

  await runTurn(() => nexa.agent.send(question, paths),
    { pendingText: files.length ? 'Reading the file…' : 'Thinking…' });
}

/** Stop. The turn is abandoned in the main process; nothing on disk is touched. */
async function stopChat() {
  if (!state.chatBusy) return;
  state.chatStage = 'Stopping…';
  renderAside();
  await guard(() => nexa.agent.cancel(), 'Stopping');
}

/**
 * The user picking a file from a list the assistant offered.
 *
 * The pick is echoed into the transcript as the user's own turn, because that is
 * what it is — clicking a row is answering a question — and a conversation where
 * the answer is invisible is one nobody can read back afterwards.
 */
async function answerChoice(index, chosenPath) {
  if (state.chatBusy) return;
  const message = state.chat[index];
  const choice = message?.choice;
  if (!choice || choice.answered) return;

  const option = choice.options.find((o) => o.path === chosenPath);
  choice.answered = chosenPath;
  state.chat.push({ role: 'user', text: option ? option.name : chosenPath });
  await runTurn(() => nexa.agent.choose(choice.id, [chosenPath]),
    { pendingText: 'Opening that one…' });
}

/**
 * Approving a conversion the assistant proposed.
 *
 * Only the proposal's id is sent. The paths stayed in the main process the whole
 * time, which is what stops an approval of the conversion the user read being
 * redeemed for a different one. Existing files are never overwritten: a clash
 * gets a numbered name.
 */
async function approveConversion(index) {
  const message = state.chat[index];
  const proposal = message?.conversion;
  if (!proposal || proposal.spent) return;

  proposal.spent = true;
  state.chatBusy = true;
  state.chatStage = `Converting ${proposal.items.length} file(s)…`;
  state.chat.push({ role: 'assistant', text: state.chatStage, pending: true });
  renderAside();

  const res = await guard(
    () => nexa.convert.executeProposal(proposal.id, { onConflict: 'rename' }),
    'Converting');

  state.chatBusy = false;
  state.chatStage = null;
  state.chat.pop();

  if (!res) {
    // The proposal was not spent after all, so it goes back to being offered.
    proposal.spent = false;
    renderAside();
    return;
  }

  state.chat.push({
    role: 'assistant',
    text: res.converted === 0
      ? 'Nothing was converted.'
      : `Converted ${res.converted} file${res.converted === 1 ? '' : 's'}${
          res.failed ? `. ${res.failed} could not be converted.` : '.'}`,
    results: res,
  });
  renderAside();
}

/** Forgets the conversation, in the panel and in the main process alike. */
async function clearChat() {
  if (state.chatBusy) return;
  await guard(() => nexa.agent.reset(), 'Clearing');
  state.chat = [];
  state.chatStage = null;
  renderAside();
}

/**
 * Attaches files to the assistant.
 *
 * A file outside the approved roots is not simply refused: dropping it on the
 * panel is a clear enough request that the right answer is to ask once, then
 * read it. The refusal arrives as data rather than as a thrown error, because a
 * custom code on an Error does not survive the context bridge.
 */
async function attachToAssistant(paths) {
  if (!paths?.length) return;
  state.asideTab = 'chat';

  for (const p of paths.slice(0, 6)) {
    if (state.chatAttachments.length >= 6) {
      toast('Six files at a time is the limit for one question.');
      break;
    }
    if (state.chatAttachments.some((a) => a.path === p)) continue;

    let info = await guard(() => nexa.agent.attach(p), 'Attaching');
    if (!info) continue;

    if (!info.ok && info.reason === 'outside') {
      const ok = window.confirm(
        `${p}\n\nThis file is outside the folders NexaFiles may read.\n\n` +
        `Give it read access to ${info.folder} so the assistant can open this file?`
      );
      if (!ok) continue;
      const granted = await guard(() => nexa.roots.approve(info.folder), 'Granting access');
      if (!granted) continue;
      info = await guard(() => nexa.agent.attach(p), 'Attaching');
      await renderRail();
      if (!info) continue;
    }

    if (!info.ok) toast(info.message || info.error || 'That file could not be attached.', 'error');
    else state.chatAttachments.push(info);
  }
  renderAside();
}

// ── footprint ──────────────────────────────────────────────────────────────

// NexaFiles is an optimizer built on Electron. Volunteering its own memory use,
// live, is the honest answer to the obvious question.
async function refreshFootprint() {
  try {
    const load = await nexa.system.load();
    document.getElementById('footprint').textContent =
      `NexaFiles is using ${formatBytes(load.own.workingSetBytes, 1)}`;
  } catch { /* leave the previous reading */ }
}

// ── boot ───────────────────────────────────────────────────────────────────

/**
 * Paints the chosen theme.
 *
 * The main process decides which theme is in force — it owns the stored choice
 * and it is the thing that knows what Windows is set to — so the renderer is
 * told `dark` or `light` and never has to work it out. Anything that computes
 * a colour in JavaScript rather than reading a token is handed the answer too.
 */
function applyTheme(dark) {
  state.dark = !!dark;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  treemap.setDark(!!dark);
  // The treemap is drawn into a canvas of absolutely-positioned blocks whose
  // colours were computed under the old theme, so it has to be redrawn.
  if (state.view === 'overview' && state.composition) drawTreemap();
}

/** Everything the Settings view needs from the shell it lives in. */
function settingsHelpers() {
  return {
    esc,
    formatBytes,
    formatNumber,
    humanSpan,
    toast,
    guard,
    rerender: () => { if (state.view === 'settings') renderAll(); },
    applyTheme,
    onRootsChanged: () => renderRail(),
    resetChat: () => {
      voice.cancel();
      state.voice.phase = 'idle';
      state.chat = [];
      state.chatAttachments = [];
      state.chatDraft = '';
      renderAside();
    },
  };
}

/** Days, hours and minutes, for a duration in seconds. */
function humanSpan(seconds) {
  if (!seconds || seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} m`;
  return `${m} m`;
}

/** Everything the Files view needs from the shell it lives in. */
function explorerHelpers() {
  return {
    esc,
    formatBytes,
    formatNumber,
    toast,
    guard,
    rerender: () => { if (state.view === 'files') renderAll(); },
    attachToAssistant,
    scanFolder: (p) => startScan(p),
    onRootsChanged: () => renderRail(),
    // Layout, sort order and the hidden-items switch are preferences, not
    // session state: the view should open the way it was left.
    savePrefs: (files) => {
      nexa.settings.set({ files }).then((updated) => { state.prefs = updated; })
        .catch(() => { /* a preference that failed to save is not worth a toast */ });
    },
  };
}

/**
 * A file dropped anywhere else in the window would make Electron navigate to
 * it, replacing the interface with the file. The assistant panel handles its
 * own drops; everywhere else, the drop is swallowed.
 */
function wireWindowDrops() {
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => ev.preventDefault());

  const aside = document.querySelector('.aside');
  if (!aside) return;

  let depth = 0;
  aside.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    depth++;
    aside.classList.add('drop-active');
  });
  aside.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) aside.classList.remove('drop-active');
  });
  aside.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });
  aside.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    depth = 0;
    aside.classList.remove('drop-active');
    const paths = await explorer.pathsFromDrop(ev);
    if (!paths.length) {
      toast('Nothing readable was dropped.', 'error');
      return;
    }
    await attachToAssistant(paths);
  });
}

/**
 * What a progress report says, in the user's terms.
 *
 * Tool names are internal — nobody asked about `search_file_contents` — and the
 * stages that carry their own message (reading documents, converting) already
 * say something better than any name would. Anything unrecognised falls back to
 * "Working…" rather than leaking an identifier into the panel.
 */
function describeStage(payload) {
  if (!payload) return null;
  if (payload.message) return payload.message;
  switch (payload.stage) {
    case 'indexing':  return 'Reading your documents…';
    case 'searching': return 'Searching…';
    case 'converting': return 'Converting…';
    case 'thinking':  return 'Thinking…';
    case 'working':   return 'Working…';
    case 'tool':      return describeTool(payload.tool);
    default:          return 'Working…';
  }
}

function describeTool(name) {
  switch (name) {
    case 'search_file_contents':   return 'Reading your documents…';
    case 'read_document':          return 'Reading that file…';
    case 'read_file_head':         return 'Looking inside that file…';
    case 'ask_user_to_choose':     return 'Narrowing it down…';
    case 'get_conversion_support': return 'Checking what can be converted…';
    case 'propose_conversion':     return 'Preparing the conversion…';
    case 'propose_cleanup':
    case 'propose_quarantine':     return 'Drawing up a proposal…';
    case 'get_scan_status':
    case 'get_disk_composition':
    case 'query_largest_files':    return 'Checking the last scan…';
    case 'find_duplicates':        return 'Comparing files…';
    case 'find_leftovers':         return 'Looking for leftovers…';
    case 'list_startup_items':     return 'Reading what starts at login…';
    case 'get_system_load':        return 'Measuring the system…';
    default:                       return 'Working…';
  }
}

async function boot() {
  // Asked once, so a build that cannot record shows a struck-through microphone
  // from the first frame rather than only after someone presses it.
  state.voice.supported = voice.isSupported();

  document.getElementById('win-min').addEventListener('click', () => nexa.window.minimize());
  document.getElementById('win-max').addEventListener('click', () => nexa.window.maximize());
  document.getElementById('win-close').addEventListener('click', () => nexa.window.close());

  document.getElementById('aside-tabs').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      // The recording indicator lives in the composer. Switching away would
      // hide it while the microphone stayed open, which is the one state this
      // feature must never be in.
      if (b.dataset.tab !== 'chat' && state.voice.phase === 'recording') discardRecording();
      state.asideTab = b.dataset.tab;
      renderAside();
    });
  });

  nexa.scan.onProgress((p) => {
    const counts = document.getElementById('progress-counts');
    const current = document.getElementById('progress-current');
    if (counts && p.fileCount !== undefined) {
      counts.textContent =
        `${formatNumber(p.fileCount)} files in ${formatNumber(p.dirCount)} folders, ${formatBytes(p.totalBytes)}`;
    } else if (counts && p.phase) {
      counts.textContent = `${p.phase}: ${formatNumber(p.examined || p.processed || 0)} examined`;
    }
    if (current && p.current) current.textContent = p.current;
  });

  // What the assistant is doing, while it does it. Only the one line inside the
  // pending bubble is rewritten: re-rendering the whole panel on every progress
  // tick would fight the caret in the composer, which is exactly the bug the
  // draft-preserving code above this exists to undo.
  nexa.agent.onStage((payload) => {
    if (!state.chatBusy) return;
    const next = describeStage(payload);
    if (!next || next === state.chatStage) return;
    state.chatStage = next;
    const line = document.querySelector('#aside-body .chat-stage');
    if (line) line.textContent = next;
  });

  explorer.init(nexa, explorerHelpers());
  settings.init(nexa, settingsHelpers());
  wireWindowDrops();

  // The theme is applied before anything is drawn, and follows the system while
  // the app is open when that is the stored choice.
  state.prefs = await guard(() => nexa.settings.get(), 'Reading settings');
  if (state.prefs) {
    applyTheme(state.prefs.effective.dark);
    settings.state.settings = state.prefs;
    explorer.state.layout = state.prefs.files.layout;
    explorer.state.showHidden = state.prefs.files.showHidden;
    explorer.state.sort = { key: state.prefs.files.sortKey, dir: state.prefs.files.sortDir };
  }
  // Bytes as the wake word's acoustic model arrives. Only the Settings section
  // draws it, and only while it is open — the check is cheap and the alternative
  // is re-rendering the whole interface forty megabytes' worth of times.
  nexa.wake.onModelProgress((p) => {
    settings.state.wakeProgress = p;
    if (state.view === 'settings') settings.rerenderProgress?.();
  });

  // Setting the theme — from this interface or from Windows — makes the main
  // process the authority on what is now in force, so the answer is re-read
  // from it rather than patched into a copy taken at startup. Patching the
  // copy is what made the Appearance section show the previous choice as
  // selected after a switch.
  nexa.settings.onThemeChange(async (p) => {
    applyTheme(p.dark);
    const fresh = await guard(() => nexa.settings.get(), 'Reading settings');
    if (fresh) {
      state.prefs = fresh;
      settings.state.settings = fresh;
    }
    renderAll();
  });

  await loadProfile();
  state.scan = await guard(() => nexa.scan.current(), 'Reading last scan');
  if (state.scan) await loadComposition(state.scan.root);
  await Promise.all([loadSummary(), loadSession()]);
  await refreshQuarantine();
  await renderRail();
  renderAll();

  // The Files view opens on the home folder, which is approved by launching
  // the application, so it always has somewhere to start.
  const home = await guard(() => nexa.locations.home(), 'Reading home folder');
  if (home) explorer.navigate(home, { push: true });

  refreshFootprint();
  setInterval(refreshFootprint, 15000);

  // The uptime numeral ticks every second. The sampled graph refreshes at the
  // sampling interval, because redrawing faster than samples arrive shows
  // nothing new.
  startUptimeTicker();
  setInterval(async () => {
    if (state.view !== 'overview') return;
    await loadSession();
    const host = document.getElementById('stage');
    if (host && host.querySelector('.session-grid')) renderAll();
  }, 15000);

  window.addEventListener('resize', () => {
    if (state.view === 'overview' && state.composition) drawTreemap();
  });
}

boot();
