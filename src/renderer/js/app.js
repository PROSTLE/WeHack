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
  system: null,
  quarantine: null,
  scanning: false,
  busy: null,
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

function progressBlock() {
  if (!state.scanning && !state.busy) return '';
  return `
    <div class="progress">
      <div class="spinner"></div>
      <div class="progress-text">
        <div class="progress-counts" id="progress-counts">${state.busy || 'Starting…'}</div>
        <div class="progress-current" id="progress-current"></div>
      </div>
      ${state.scanning ? '<button class="btn small" id="cancel-scan">Cancel</button>' : ''}
    </div>`;
}

// ── overview ───────────────────────────────────────────────────────────────

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

  return progressBlock() + `
    <div class="hero">
      ${reclaimable.known ? `
        <h1 class="hero-value">
          <span>${splitBytes(reclaimable.bytes).value}</span>
          <span class="hero-unit">${splitBytes(reclaimable.bytes).unit} reclaimable</span>
        </h1>
        <p class="hero-caption">
          Measured across <strong>${formatNumber(reclaimable.items)}</strong> item(s) that
          ${esc(reclaimable.basis)}. Every one carries the evidence that identified it.
        </p>
        <button class="btn primary hero-drill" id="hero-drill">
          ${icon('eye')} Review the itemised plan
        </button>
      ` : `
        <h1 class="hero-value">
          <span>${splitBytes(scan.totalBytes).value}</span>
          <span class="hero-unit">${splitBytes(scan.totalBytes).unit} measured</span>
        </h1>
        <p class="hero-caption">
          <strong>${formatNumber(scan.fileCount)}</strong> files in
          <strong>${formatNumber(scan.dirCount)}</strong> folders.
          Nothing has been checked for reclaimable space yet — run a duplicate
          or leftover scan and the figure above becomes what you could recover.
        </p>
        <div class="row" style="margin-top:14px">
          <button class="btn primary" data-goto="duplicates">${icon('copies')} Find duplicates</button>
          <button class="btn" data-goto="leftovers">${icon('layers')} Find leftovers</button>
        </div>
      `}
    </div>

    ${state.summary ? dash.statCards(state.summary, { formatBytes, splitBytes }) : ''}
    ${state.summary ? dash.storagePanel(state.summary, { formatBytes }) : ''}
    ${dash.sessionPanel(state.session, state.sessionMetric, { formatBytes })}

    <div class="panel">
      <header>
        <h2>Where the space is</h2>
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

    ${state.summary ? dash.byYearPanel(state.summary, { formatBytes }) : ''}
    ${state.summary ? dash.recentPanel(state.summary, { formatBytes }) : ''}

    <div class="panel">
      <header>
        <h2>${state.fileList.under && state.fileList.under !== scan.root
              ? 'Files in ' + esc(shortPath(state.fileList.under))
              : 'Largest files'}</h2>
        <span class="muted">${formatNumber(state.fileList.total.n)} files,
          ${formatBytes(state.fileList.total.bytes)}</span>
      </header>
      ${fileTable(state.fileList.files)}
    </div>`;
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
            <tr data-file="${esc(f.path)}">
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
          <div class="panel-note">${icon('info', { size: 13 })} ${esc(r.method)}</div>
          <div class="list-scroll" style="margin-top:12px">
            <table class="table">
              <thead><tr><th>Files in this group</th><th class="num">Size each</th><th class="num">Difference</th></tr></thead>
              <tbody>
                ${r.groups.slice(0, 60).map((g) => g.members.map((m, i) => `
                  <tr>
                    <td>
                      <div class="name">${esc(m.path.split(/[\\/]/).pop())}
                        ${i === 0 ? '<span class="chip">kept</span>' : ''}</div>
                      <div class="path">${esc(m.path)}</div>
                    </td>
                    <td class="num bytes">${formatBytes(m.size)}</td>
                    <td class="num muted">${id === 'exact' ? 'identical' : `${m.distance}/64 bits`}</td>
                  </tr>`).join('')).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    }).join('')}`;
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
    return `
      <div class="empty">
        ${illustration('nothingFound')}
        <h2>Nothing looks left behind</h2>
        <p>Every application-data folder examined matches something that is still
           installed, still running, or has been written to recently.</p>
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

// ── startup ────────────────────────────────────────────────────────────────

function viewStartup() {
  const s = state.startup;
  if (!s) {
    return progressBlock() + `
      <div class="panel">
        <header><h2>Startup and background load</h2></header>
        <p class="muted" style="max-width:80ch">
          What starts automatically when you log in. NexaFiles reports these; it
          does not change them.
        </p>
        <button class="btn primary" id="load-startup" style="margin-top:14px">
          ${icon('power')} List startup items
        </button>
      </div>`;
  }

  const groups = {};
  for (const it of s.items) (groups[it.source] ||= []).push(it);

  return `
    <div class="panel">
      <header>
        <h2>Startup and background load</h2>
        <span class="muted">${formatNumber(s.items.length)} item(s)</span>
      </header>
      ${s.incomplete || s.notes.length ? `
        <div class="panel-note caution">
          ${icon('caution', { size: 13 })} <strong>This list is incomplete</strong>
          <ul>${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        </div>` : ''}
    </div>
    ${Object.entries(groups).map(([source, items]) => `
      <div class="panel">
        <header><h2>${esc(source)}</h2><span class="muted">${items.length}</span></header>
        <div class="list-scroll">
          <table class="table">
            <thead><tr><th>Name</th><th>Runs</th></tr></thead>
            <tbody>
              ${items.map((i) => `
                <tr>
                  <td class="name">${esc(i.name)}</td>
                  <td class="path">${esc(i.command || '—')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`).join('')}`;
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

function viewQuarantine() {
  const q = state.quarantine;
  if (!q || !q.items.length) {
    return `
      <div class="empty">
        ${illustration('emptyQuarantine')}
        <h2>Quarantine is empty</h2>
        <p>Anything NexaFiles removes from inside an application is held here for
           30 days, with a record of where it came from, so you can put it back
           exactly where it was.</p>
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
  stage.querySelector('#cancel-scan')?.addEventListener('click', () => nexa.scan.cancel());
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
  stage.querySelector('#find-leftovers')?.addEventListener('click', runLeftovers);
  stage.querySelector('#leftover-plan')?.addEventListener('click', () => buildPlan('leftovers'));
  stage.querySelector('#load-startup')?.addEventListener('click', loadStartup);
  stage.querySelector('#load-system')?.addEventListener('click', loadSystem);

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
  renderAll();

  const res = await guard(
    () => nexa.duplicates.find(tier, { under: scope }), 'Duplicate scan');
  state.busy = null;

  if (res) {
    state.duplicates = { ...(state.duplicates || {}), [tier]: res };
    // The toast names the folder for the same reason the panel does: a count
    // with no scope attached reads as a statement about the whole disk.
    const place = res.scopeName ? ` in ${res.scopeName}` : '';
    toast(res.groups.length
      ? `${res.groups.length} group(s) found${place}, ${formatBytes(res.totalWasted)} reclaimable.`
      : `No duplicates found${place}.`);
  }
  renderAll();
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
  renderAll();
  const res = await guard(() => nexa.leftovers.find(), 'Leftover scan');
  state.busy = null;
  if (res) {
    state.leftovers = res;
    toast(res.findings.length ? `${res.findings.length} folder(s) found.` : 'Nothing looks left behind.');
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

async function loadStartup() {
  state.busy = 'Reading startup entries…';
  renderAll();
  state.startup = await guard(() => nexa.startup.list(), 'Startup');
  state.busy = null;
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
