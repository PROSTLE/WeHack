// The Files view.
//
// This is a file manager, and it behaves like the one the user already knows:
// folders first, the same four columns, the same double-click, the same F2,
// the same Delete, the same Backspace. Where it differs from Explorer it does
// so deliberately, and says why on screen:
//
//   - Deleting always goes to the Recycle Bin. There is no permanent delete
//     here, because a file manager bolted onto a disk cleaner should never be
//     the thing that loses somebody's work.
//   - Running a program asks first. Opening a document is a read; running an
//     executable is not, and the confirmation comes from the system, not here.
//   - A location outside the folders you have approved shows a button, not an
//     error. Nothing has been read at that point, and the button is the grant.
//
// Rendering is string-based like the rest of the renderer, but selection,
// renaming and icon loading mutate the DOM in place: re-rendering four thousand
// rows because one of them became selected would be visible.

import { icon, iconForType } from './icons.js';

const DRAG_TYPE = 'application/x-nexafiles-paths';
const RENDER_CAP = 2000;

/** Set once by init(). */
let nexa = null;
let H = null;             // helpers from app.js: esc, formatBytes, toast, rerender

export const state = {
  path: null,
  listing: null,           // { entries, counts, segments, parent, access }
  access: null,
  loading: false,
  error: null,

  history: [],
  historyIndex: -1,

  selection: new Set(),
  anchor: null,            // for shift-click ranges
  renaming: null,

  sort: { key: 'name', dir: 1 },
  layout: 'details',       // details | list | tiles | icons
  showHidden: false,
  query: '',
  limit: RENDER_CAP,

  busy: null,              // a long copy or move, named while it runs
  clipboard: null,         // { op: 'copy' | 'cut', paths: [] }
  places: null,            // drives and user folders, with access for each
  menu: null,              // open context menu element
};

export function init(bridge, helpers) {
  nexa = bridge;
  H = helpers;
}

// ── data ───────────────────────────────────────────────────────────────────

export async function loadPlaces() {
  try {
    state.places = await nexa.explorer.places();
  } catch (err) {
    H.toast(`Could not read this machine's drives: ${err.message}`, 'error');
  }
  return state.places;
}

/**
 * Opens a directory.
 *
 * A refused location is not an error: the reply says access has not been
 * granted, the view says so, and the user decides. Nothing was read.
 */
let navigationSeq = 0;

export async function navigate(target, { push = true, keepSelection = false } = {}) {
  if (!target) return;
  // Directories take as long as they take, and a user who clicks twice must end
  // up where they clicked last — not wherever the disk happened to answer last.
  // Every reply that is not the most recent request is dropped.
  const seq = ++navigationSeq;

  state.loading = true;
  state.error = null;
  if (!keepSelection) { state.selection.clear(); state.anchor = null; }
  state.renaming = null;
  H.rerender();

  let reply = null;
  try {
    reply = await nexa.explorer.list(target);
  } catch (err) {
    if (seq !== navigationSeq) return;
    state.error = err.message;
    state.loading = false;
    H.rerender();
    return;
  }
  if (seq !== navigationSeq) return;

  state.loading = false;
  state.path = reply.path;
  state.access = reply.access;
  state.listing = { ...reply, entries: reply.entries || null };
  // A refresh keeps the view as it was; a new folder starts capped again.
  if (!keepSelection) state.limit = RENDER_CAP;

  if (push) {
    // Anything forward of the current point is replaced, as in every browser.
    state.history = state.history.slice(0, state.historyIndex + 1);
    if (state.history[state.history.length - 1] !== reply.path) {
      state.history.push(reply.path);
    }
    state.historyIndex = state.history.length - 1;
  }
  H.rerender();
}

export async function refresh() {
  if (state.path) await navigate(state.path, { push: false, keepSelection: true });
}

export function goBack() {
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  navigate(state.history[state.historyIndex], { push: false });
}

export function goForward() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  navigate(state.history[state.historyIndex], { push: false });
}

export function goUp() {
  const parent = state.listing?.parent;
  if (parent) navigate(parent);
}

/** Grants access to a location the user just tried to open. */
async function grantAccess(target) {
  try {
    await nexa.roots.approve(target);
    H.toast(`NexaFiles can now read ${target}. Withdraw it any time under Approved roots.`);
    await loadPlaces();
    await navigate(target, { push: false });
    H.onRootsChanged?.();
  } catch (err) {
    H.toast(err.message, 'error');
  }
}

// ── derived ────────────────────────────────────────────────────────────────

function visibleEntries() {
  const all = state.listing?.entries || [];
  const q = state.query.trim().toLowerCase();
  const filtered = all.filter((e) => {
    if (!state.showHidden && (e.hidden || e.system)) return false;
    if (q && !e.name.toLowerCase().includes(q)) return false;
    return true;
  });

  const { key, dir } = state.sort;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  filtered.sort((a, b) => {
    // Folders first, always, in every sort. Explorer does this and so does
    // every other file manager; a folder sorted between two files by size
    // reads as a mistake.
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let cmp = 0;
    if (key === 'size') cmp = (a.size || 0) - (b.size || 0);
    else if (key === 'mtimeMs') cmp = (a.mtimeMs || 0) - (b.mtimeMs || 0);
    else if (key === 'typeLabel') cmp = collator.compare(a.typeLabel || '', b.typeLabel || '');
    else cmp = collator.compare(a.name, b.name);
    if (cmp === 0) cmp = collator.compare(a.name, b.name);
    return cmp * dir;
  });
  return filtered;
}

/** Layout, sort and the hidden switch are preferences; they outlive the session. */
function persistPrefs() {
  H.savePrefs?.({
    layout: state.layout,
    showHidden: state.showHidden,
    sortKey: state.sort.key,
    sortDir: state.sort.dir,
  });
}

function setBusy(label) {
  state.busy = label;
  H.rerender();
}

function selectedEntries() {
  const all = state.listing?.entries || [];
  return all.filter((e) => state.selection.has(e.path));
}

function driveForCurrentPath() {
  if (!state.places || !state.path) return null;
  const lower = state.path.toLowerCase();
  return state.places.drives.find((d) => lower.startsWith(d.path.toLowerCase())) || null;
}

// ── formatting ─────────────────────────────────────────────────────────────

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function sizeCell(entry) {
  if (entry.isDirectory) return '';
  return H.formatBytes(entry.size);
}

// ── render ─────────────────────────────────────────────────────────────────

export function render() {
  const esc = H.esc;

  if (!state.path && !state.loading) {
    // First paint: the view has not been pointed anywhere yet.
    return `<div class="explorer"><div class="ex-empty"><p class="muted">Opening your home folder…</p></div></div>`;
  }

  return `
    <div class="explorer" data-path="${esc(state.path || '')}">
      ${toolbar()}
      ${commandBar()}
      ${state.busy ? `
        <div class="ex-busy">
          <span class="spinner"></span>
          <span>${H.esc(state.busy)}</span>
        </div>` : ''}
      <div class="ex-body" id="ex-body" tabindex="0" role="listbox"
           aria-label="Contents of ${esc(state.path || '')}" aria-multiselectable="true">
        ${bodyContent()}
      </div>
      ${statusBar()}
    </div>`;
}

function toolbar() {
  const esc = H.esc;
  const segments = state.listing?.segments || [];
  const canBack = state.historyIndex > 0;
  const canForward = state.historyIndex < state.history.length - 1;
  const canUp = !!state.listing?.parent;

  return `
    <div class="ex-bar">
      <div class="ex-nav">
        <button class="ex-icon-btn" id="ex-back" ${canBack ? '' : 'disabled'}
                title="Back (Alt+Left)" aria-label="Back">${icon('arrowLeft')}</button>
        <button class="ex-icon-btn" id="ex-forward" ${canForward ? '' : 'disabled'}
                title="Forward (Alt+Right)" aria-label="Forward">${icon('arrowRight')}</button>
        <button class="ex-icon-btn" id="ex-up" ${canUp ? '' : 'disabled'}
                title="Up one level (Backspace)" aria-label="Up">${icon('arrowUp')}</button>
        <button class="ex-icon-btn" id="ex-refresh" title="Refresh (F5)"
                aria-label="Refresh">${icon('refresh')}</button>
      </div>

      <div class="ex-crumbs" id="ex-crumbs">
        ${segments.map((s, i) => {
          const last = i === segments.length - 1;
          const name = s.isRoot ? driveLabel(s.path) : s.name;
          return `
            <button class="ex-crumb ${last ? 'current' : ''}" data-goto="${esc(s.path)}"
                    data-drop-target="${esc(s.path)}">${esc(name)}</button>
            ${last ? '' : `<span class="ex-crumb-sep">${icon('chevron', { size: 11 })}</span>`}`;
        }).join('')}
      </div>

      <div class="ex-search">
        ${icon('scan', { size: 14 })}
        <input id="ex-query" type="search" spellcheck="false"
               placeholder="Filter this folder" value="${esc(state.query)}"
               aria-label="Filter the items in this folder by name">
      </div>
    </div>`;
}

function driveLabel(rootPath) {
  const drive = (state.places?.drives || []).find(
    (d) => d.path.toLowerCase() === rootPath.toLowerCase()
  );
  if (!drive) return rootPath;
  return `${drive.label} (${drive.id || rootPath})`;
}

function commandBar() {
  const sel = state.selection.size;
  const one = sel === 1;
  const clip = state.clipboard?.paths?.length || 0;
  const disabled = (cond) => (cond ? '' : 'disabled');

  return `
    <div class="ex-commands">
     <div class="ex-cmd-left">
      <button class="ex-cmd" id="ex-new-folder" ${disabled(!!state.listing?.entries)}>
        ${icon('folderPlus')}<span>New folder</span>
      </button>
      <span class="ex-cmd-sep"></span>
      <button class="ex-cmd" id="ex-open" ${disabled(one)}>${icon('external')}<span>Open</span></button>
      <button class="ex-cmd" id="ex-copy" ${disabled(sel > 0)}>${icon('copyFile')}<span>Copy</span></button>
      <button class="ex-cmd" id="ex-cut" ${disabled(sel > 0)}>${icon('cut')}<span>Cut</span></button>
      <button class="ex-cmd" id="ex-paste" ${disabled(clip > 0 && !!state.listing?.entries)}>
        ${icon('paste')}<span>Paste${clip ? ` (${clip})` : ''}</span>
      </button>
      <button class="ex-cmd" id="ex-rename" ${disabled(one)}>${icon('rename')}<span>Rename</span></button>
      <button class="ex-cmd danger" id="ex-delete" ${disabled(sel > 0)}>
        ${icon('trash')}<span>Delete</span>
      </button>
      <span class="ex-cmd-sep"></span>
      <button class="ex-cmd" id="ex-ask" ${disabled(sel > 0)}>
        ${icon('attach')}<span>Ask the assistant</span>
      </button>
     </div>

     <div class="ex-cmd-right">
      <div class="ex-menu-host">
        <button class="ex-cmd" id="ex-sort-btn" aria-haspopup="true">${icon('sort')}<span>Sort</span></button>
        <div class="ex-menu" id="ex-sort-menu" hidden>
          ${[['name', 'Name'], ['mtimeMs', 'Date modified'], ['typeLabel', 'Type'], ['size', 'Size']]
            .map(([k, label]) => `
              <button data-sort-key="${k}" ${state.sort.key === k ? 'aria-checked="true"' : ''}>
                ${state.sort.key === k ? icon('check', { size: 13 }) : '<span class="ex-menu-gap"></span>'}
                ${label}
              </button>`).join('')}
          <div class="ex-menu-rule"></div>
          ${[[1, 'Ascending'], [-1, 'Descending']].map(([d, label]) => `
            <button data-sort-dir="${d}" ${state.sort.dir === d ? 'aria-checked="true"' : ''}>
              ${state.sort.dir === d ? icon('check', { size: 13 }) : '<span class="ex-menu-gap"></span>'}
              ${label}
            </button>`).join('')}
        </div>
      </div>

      <div class="ex-menu-host">
        <button class="ex-cmd" id="ex-view-btn" aria-haspopup="true">${icon('layout')}<span>View</span></button>
        <div class="ex-menu" id="ex-view-menu" hidden>
          ${[['icons', 'Large icons'], ['tiles', 'Tiles'], ['list', 'List'], ['details', 'Details']]
            .map(([k, label]) => `
              <button data-layout="${k}" ${state.layout === k ? 'aria-checked="true"' : ''}>
                ${state.layout === k ? icon('check', { size: 13 }) : '<span class="ex-menu-gap"></span>'}
                ${label}
              </button>`).join('')}
          <div class="ex-menu-rule"></div>
          <button data-toggle-hidden="1">
            ${state.showHidden ? icon('check', { size: 13 }) : '<span class="ex-menu-gap"></span>'}
            Hidden and system items
          </button>
        </div>
      </div>
     </div>
    </div>`;
}

function bodyContent() {
  const esc = H.esc;

  if (state.loading) {
    return `<div class="ex-empty"><div class="spinner"></div><p class="muted">Reading this folder…</p></div>`;
  }
  if (state.error) {
    return `<div class="ex-empty">
      ${icon('caution', { size: 22 })}
      <h3>This folder could not be opened</h3>
      <p class="muted">${esc(state.error)}</p>
    </div>`;
  }
  if (state.access && !state.access.allowed) return gate();
  if (!state.listing?.entries) return '';

  const entries = visibleEntries();
  if (!entries.length) {
    const hiddenCount = state.listing.counts.hidden;
    return `<div class="ex-empty">
      ${icon('folderOpen', { size: 22 })}
      <h3>${state.query ? 'Nothing here matches that' : 'This folder is empty'}</h3>
      ${!state.query && hiddenCount && !state.showHidden ? `
        <p class="muted">${hiddenCount} hidden or system item(s) are not being shown.
          Turn them on under View.</p>` : ''}
      ${state.query ? `<p class="muted">No item in this folder has "${esc(state.query)}" in its name.</p>` : ''}
    </div>`;
  }

  const shown = entries.slice(0, state.limit);
  const more = entries.length - shown.length;

  const body = state.layout === 'details' ? detailsTable(shown) : grid(shown);
  const overflow = more > 0 ? `
    <div class="ex-more">
      <span class="muted">Showing the first ${H.formatNumber(shown.length)} of
        ${H.formatNumber(entries.length)} items.</span>
      <button class="btn small" id="ex-show-all">Show all ${H.formatNumber(entries.length)}</button>
    </div>` : '';

  return body + overflow;
}

function gate() {
  const esc = H.esc;
  const target = state.path;

  if (state.access.reason === 'missing') {
    return `
      <div class="ex-gate">
        ${icon('caution', { size: 22 })}
        <h3>${esc(target)} is not there</h3>
        <p>Nothing at that path exists any more. A removable drive that has been
           unplugged, or a folder that has been renamed or deleted, both look
           like this.</p>
        <p class="muted">This is not a permissions problem, so there is nothing
           to approve.</p>
        <button class="btn" data-goto="${esc(state.listing?.parent || '')}"
          ${state.listing?.parent ? '' : 'disabled'}>
          ${icon('arrowUp')} Go up one level
        </button>
      </div>`;
  }

  if (state.access.reason === 'protected') {
    return `
      <div class="ex-gate">
        ${icon('lock', { size: 22 })}
        <h3>${esc(target)} is a protected location</h3>
        <p>NexaFiles never reads inside ${esc(state.access.detail)}. This is not a
           permission you can grant here — the rule exists so that a bug in this
           application, or anything that manages to drive it, cannot touch the
           files Windows itself depends on.</p>
        <p class="muted">Use File Explorer if you need to look inside it.</p>
      </div>`;
  }
  return `
    <div class="ex-gate">
      ${icon('shield', { size: 22 })}
      <h3>NexaFiles has not been given access to ${esc(target)}</h3>
      <p>Nothing here has been read. NexaFiles only opens locations you have
         approved, so this drive is closed to it until you say otherwise.</p>
      <p class="muted">Granting access lets the Files view list this location and
         open what is inside it. It deletes nothing and changes nothing, and you
         can withdraw it at any time from Approved roots in the sidebar.</p>
      <button class="btn primary" data-grant="${esc(target)}">
        ${icon('shield')} Give NexaFiles access to ${esc(target)}
      </button>
    </div>`;
}

function detailsTable(entries) {
  const esc = H.esc;
  const arrow = (key) => (state.sort.key === key
    ? `<span class="ex-sort-arrow ${state.sort.dir === 1 ? 'asc' : ''}">
         ${icon('chevronDown', { size: 12 })}</span>`
    : '');

  return `
    <table class="ex-table">
      <thead>
        <tr>
          <th class="ex-col-name" data-sort-col="name">Name ${arrow('name')}</th>
          <th class="ex-col-date" data-sort-col="mtimeMs">Date modified ${arrow('mtimeMs')}</th>
          <th class="ex-col-type" data-sort-col="typeLabel">Type ${arrow('typeLabel')}</th>
          <th class="ex-col-size num" data-sort-col="size">Size ${arrow('size')}</th>
        </tr>
      </thead>
      <tbody>
        ${entries.map((e, i) => `
          <tr class="ex-row ${rowClasses(e)}" data-path="${esc(e.path)}" data-index="${i}"
              data-directory="${e.isDirectory ? '1' : ''}" draggable="true"
              ${e.isDirectory ? `data-drop-target="${esc(e.path)}"` : ''}
              role="option" aria-selected="${state.selection.has(e.path)}"
              title="${esc(tooltip(e))}">
            <td class="ex-col-name">
              <span class="ex-ico" ${iconHint(e)}>${icon(iconForType(e.type, e.isDirectory))}</span>
              ${nameCell(e)}
              ${badges(e)}
            </td>
            <td class="ex-col-date mono">${esc(formatDate(e.mtimeMs))}</td>
            <td class="ex-col-type">${esc(e.typeLabel)}</td>
            <td class="ex-col-size num mono">${esc(sizeCell(e))}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function grid(entries) {
  const esc = H.esc;
  return `
    <div class="ex-grid ex-grid-${state.layout}">
      ${entries.map((e, i) => `
        <div class="ex-row ex-tile ${rowClasses(e)}" data-path="${esc(e.path)}" data-index="${i}"
             data-directory="${e.isDirectory ? '1' : ''}" draggable="true"
             ${e.isDirectory ? `data-drop-target="${esc(e.path)}"` : ''}
             role="option" aria-selected="${state.selection.has(e.path)}"
             title="${esc(tooltip(e))}">
          <span class="ex-ico" ${iconHint(e)}>${icon(iconForType(e.type, e.isDirectory))}</span>
          <span class="ex-tile-text">
            ${nameCell(e)}
            ${state.layout === 'tiles' ? `
              <span class="ex-tile-meta">${esc(e.typeLabel)}${e.isDirectory ? '' : ` · ${esc(sizeCell(e))}`}</span>` : ''}
          </span>
          ${badges(e)}
        </div>`).join('')}
    </div>`;
}

function rowClasses(e) {
  const c = [];
  if (state.selection.has(e.path)) c.push('selected');
  if (e.hidden || e.system) c.push('faded');
  if (state.clipboard?.op === 'cut' && state.clipboard.paths.includes(e.path)) c.push('cut');
  if (e.unreadable) c.push('unreadable');
  return c.join(' ');
}

function nameCell(e) {
  const esc = H.esc;
  if (state.renaming === e.path) {
    return `<input class="ex-rename-input" value="${esc(e.name)}" spellcheck="false"
                   aria-label="New name for ${esc(e.name)}">`;
  }
  return `<span class="ex-label">${esc(e.name)}</span>`;
}

function badges(e) {
  const out = [];
  if (e.isSymlink) out.push(`<span class="ex-badge" title="Shortcut or junction">${icon('link', { size: 12 })}</span>`);
  if (e.protectedBy) out.push(`<span class="ex-badge" title="Protected location: NexaFiles will not open this">${icon('lock', { size: 12 })}</span>`);
  if (e.unreadable) out.push(`<span class="ex-badge caution" title="Details could not be read (${H.esc(e.unreadable)})">${icon('caution', { size: 12 })}</span>`);
  return out.join('');
}

function tooltip(e) {
  const bits = [e.path, e.typeLabel];
  if (!e.isDirectory) bits.push(H.formatBytes(e.size));
  if (e.hidden) bits.push('hidden');
  if (e.system) bits.push('system');
  if (e.readOnly) bits.push('read-only');
  if (e.linkTarget) bits.push(`→ ${e.linkTarget}`);
  return bits.filter(Boolean).join('  ·  ');
}

/** How the icon for this entry should be fetched once it scrolls into view. */
function iconHint(e) {
  if (e.isDirectory) return '';
  const wantsThumbnail = state.layout !== 'details' && state.layout !== 'list' &&
    (e.type === 'image' || e.type === 'video' || e.extension === 'pdf');
  const key = wantsThumbnail || e.executable || e.extension === 'lnk' || e.extension === 'ico'
    ? `path:${e.path}` : `ext:${e.extension || 'none'}`;
  return `data-icon-path="${H.esc(e.path)}" data-icon-key="${H.esc(key)}"` +
         (wantsThumbnail ? ' data-icon-thumb="1"' : '');
}

function statusBar() {
  const esc = H.esc;
  const counts = state.listing?.counts;
  const sel = selectedEntries();
  const drive = driveForCurrentPath();

  const left = counts
    ? `${H.formatNumber(visibleEntries().length)} item(s)` +
      (counts.hidden && !state.showHidden ? `, ${H.formatNumber(counts.hidden)} hidden` : '') +
      (counts.unreadable ? `, ${H.formatNumber(counts.unreadable)} unreadable` : '')
    : '';

  const middle = sel.length
    ? `${H.formatNumber(sel.length)} selected` +
      (sel.some((e) => !e.isDirectory)
        ? `, ${H.formatBytes(sel.reduce((n, e) => n + (e.size || 0), 0))}`
        : '')
    : '';

  const right = drive
    ? `${esc(drive.label)} (${esc(drive.id || '')}) — ${H.formatBytes(drive.freeBytes)} free of ${H.formatBytes(drive.totalBytes)}`
    : '';

  return `
    <div class="ex-status">
      <span id="ex-status-left">${left}</span>
      <span class="ex-status-sel" id="ex-status-sel">${middle}</span>
      <span class="ex-status-spacer"></span>
      ${state.listing && !state.listing.attributesRead && state.listing.entries ? `
        <span class="muted" title="Windows attributes could not be read for this folder, so hidden items are identified by name only.">
          ${icon('info', { size: 12 })} attributes unread</span>` : ''}
      <span class="mono muted">${right}</span>
    </div>`;
}

// ── selection ──────────────────────────────────────────────────────────────

function applySelection(scope) {
  const rows = scope.querySelectorAll('.ex-row');
  rows.forEach((row) => {
    const on = state.selection.has(row.dataset.path);
    row.classList.toggle('selected', on);
    row.setAttribute('aria-selected', String(on));
  });
  const sel = selectedEntries();
  const status = scope.querySelector('#ex-status-sel');
  if (status) {
    status.textContent = sel.length
      ? `${H.formatNumber(sel.length)} selected` +
        (sel.some((e) => !e.isDirectory)
          ? `, ${H.formatBytes(sel.reduce((n, e) => n + (e.size || 0), 0))}` : '')
      : '';
  }
  // The command bar's enabled state depends on the selection, and nothing else
  // in it changes, so it is updated rather than re-rendered.
  const one = sel.length === 1;
  const any = sel.length > 0;
  const set = (id, enabled) => {
    const b = scope.querySelector(id);
    if (b) b.disabled = !enabled;
  };
  set('#ex-open', one);
  set('#ex-copy', any);
  set('#ex-cut', any);
  set('#ex-rename', one);
  set('#ex-delete', any);
  set('#ex-ask', any);
}

function selectOnly(path) {
  state.selection.clear();
  if (path) state.selection.add(path);
  state.anchor = path;
}

function selectRange(toPath) {
  const entries = visibleEntries();
  const from = entries.findIndex((e) => e.path === state.anchor);
  const to = entries.findIndex((e) => e.path === toPath);
  if (to === -1) return;
  const [a, b] = from === -1 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
  state.selection.clear();
  for (let i = a; i <= b; i++) state.selection.add(entries[i].path);
}

// ── icons, loaded as rows come into view ───────────────────────────────────

// Keyed by extension for ordinary files and by path for the ones whose icon is
// their own (executables, shortcuts, thumbnails). Capped: a folder of ten
// thousand installers would otherwise hold ten thousand data URLs in memory.
const ICON_CACHE_LIMIT = 600;
const iconCache = new Map();
let iconObserver = null;

function hydrateIcons(scope) {
  if (iconObserver) iconObserver.disconnect();
  const root = scope.querySelector('#ex-body');
  if (!root) return;

  iconObserver = new IntersectionObserver((entries) => {
    for (const it of entries) {
      if (!it.isIntersecting) continue;
      iconObserver.unobserve(it.target);
      paintIcon(it.target);
    }
  }, { root, rootMargin: '240px' });

  root.querySelectorAll('.ex-ico[data-icon-key]').forEach((el) => iconObserver.observe(el));
}

async function paintIcon(el) {
  const key = el.dataset.iconKey;
  const filePath = el.dataset.iconPath;
  if (!key || !filePath) return;

  if (iconCache.has(key)) {
    const url = iconCache.get(key);
    if (url) el.innerHTML = `<img src="${url}" alt="" draggable="false">`;
    return;
  }

  let url = null;
  try {
    if (el.dataset.iconThumb) url = await nexa.explorer.thumbnail(filePath, 128);
    if (!url) url = await nexa.explorer.icon(filePath);
  } catch {
    url = null;   // the drawn icon already on screen is the fallback
  }
  if (iconCache.size >= ICON_CACHE_LIMIT) iconCache.delete(iconCache.keys().next().value);
  iconCache.set(key, url);
  if (url && el.isConnected) el.innerHTML = `<img src="${url}" alt="" draggable="false">`;
}

// ── actions ────────────────────────────────────────────────────────────────

async function openEntry(entry) {
  if (!entry) return;
  if (entry.isDirectory) { navigate(entry.path); return; }
  try {
    const res = await nexa.explorer.open(entry.path);
    if (res.cancelled) H.toast(`${entry.name} was not run.`);
  } catch (err) {
    H.toast(`Could not open ${entry.name}: ${err.message}`, 'error');
  }
}

function entryByPath(p) {
  return (state.listing?.entries || []).find((e) => e.path === p) || null;
}

/**
 * Creates a folder and puts its name straight into edit.
 *
 * Explorer asks for the name afterwards, in the list, rather than in a dialog
 * beforehand — which is just as well, since Electron's renderer has no
 * `window.prompt` to ask with.
 */
async function newFolder() {
  const made = await H.guard(() => nexa.explorer.newFolder(state.path), 'New folder');
  if (!made) return;
  await refresh();
  selectOnly(made.path);
  state.renaming = made.path;
  H.rerender();
  const input = document.querySelector('.ex-rename-input');
  if (input) { input.focus(); input.select(); }
}

function beginRename() {
  const sel = selectedEntries();
  if (sel.length !== 1) return;
  state.renaming = sel[0].path;
  H.rerender();
  const input = document.querySelector('.ex-rename-input');
  if (input) {
    input.focus();
    const dot = input.value.lastIndexOf('.');
    // Explorer preselects the stem, so typing replaces the name and keeps the
    // extension. Doing otherwise makes every rename a two-step operation.
    if (dot > 0 && !entryByPath(state.renaming)?.isDirectory) input.setSelectionRange(0, dot);
    else input.select();
  }
}

async function commitRename(newName) {
  const target = state.renaming;
  state.renaming = null;
  if (!target || !newName) { H.rerender(); return; }
  const entry = entryByPath(target);
  if (!entry || newName === entry.name) { H.rerender(); return; }
  try {
    const renamed = await nexa.explorer.rename(target, newName.trim());
    await refresh();
    selectOnly(renamed.path);
    H.rerender();
  } catch (err) {
    H.toast(`Could not rename: ${err.message}`, 'error');
    H.rerender();
  }
}

async function deleteSelection() {
  const sel = selectedEntries();
  if (!sel.length) return;
  const bytes = sel.reduce((n, e) => n + (e.size || 0), 0);
  const ok = window.confirm(
    `Send ${sel.length} item(s) to the Recycle Bin?\n\n` +
    sel.slice(0, 8).map((e) => `  ${e.name}`).join('\n') +
    (sel.length > 8 ? `\n  …and ${sel.length - 8} more` : '') +
    `\n\n${bytes ? `${H.formatBytes(bytes)} of files. ` : ''}` +
    `They go to the Recycle Bin, not to permanent deletion, and Windows can put ` +
    `them back. Folders are sent whole, with everything inside them.`
  );
  if (!ok) return;

  const res = await H.guard(() => nexa.explorer.trash(sel.map((e) => e.path)), 'Delete');
  if (!res) return;
  const failed = res.results.filter((r) => !r.ok);
  H.toast(`${res.trashed} item(s) sent to the Recycle Bin.` +
          (failed.length ? ` ${failed.length} could not be.` : ''));
  for (const f of failed.slice(0, 3)) H.toast(`${f.path}: ${f.error}`, 'error');
  state.selection.clear();
  await refresh();
}

function copySelection(op) {
  const sel = selectedEntries();
  if (!sel.length) return;
  state.clipboard = { op, paths: sel.map((e) => e.path) };
  H.toast(`${sel.length} item(s) ready to ${op === 'cut' ? 'move' : 'copy'}. Open a folder and paste.`);
  H.rerender();
}

async function paste(destDir = state.path) {
  const clip = state.clipboard;
  if (!clip?.paths.length) return;
  setBusy(`${clip.op === 'cut' ? 'Moving' : 'Copying'} ${clip.paths.length} item(s)…`);
  const res = await H.guard(
    () => (clip.op === 'cut'
      ? nexa.explorer.move(clip.paths, destDir)
      : nexa.explorer.copy(clip.paths, destDir)),
    'Paste'
  );
  setBusy(null);
  if (!res) return;

  const done = clip.op === 'cut' ? res.moved : res.copied;
  const failed = res.results.filter((r) => !r.ok);
  H.toast(`${done} item(s) ${clip.op === 'cut' ? 'moved' : 'copied'}.` +
          (failed.length ? ` ${failed.length} failed.` : ''));
  for (const f of failed.slice(0, 3)) H.toast(`${f.path.split(/[\\/]/).pop()}: ${f.error}`, 'error');
  if (clip.op === 'cut') state.clipboard = null;
  await refresh();
}

async function dropOnto(paths, destDir, { copy }) {
  if (!paths.length) return;
  setBusy(`${copy ? 'Copying' : 'Moving'} ${paths.length} item(s)…`);
  const res = await H.guard(
    () => (copy ? nexa.explorer.copy(paths, destDir) : nexa.explorer.move(paths, destDir)),
    'Drop'
  );
  setBusy(null);
  if (!res) return;
  const failed = res.results.filter((r) => !r.ok);
  H.toast(`${copy ? res.copied : res.moved} item(s) ${copy ? 'copied' : 'moved'} into ` +
          `${destDir.split(/[\\/]/).pop() || destDir}.` +
          (failed.length ? ` ${failed.length} failed.` : ''));
  for (const f of failed.slice(0, 3)) H.toast(`${f.path.split(/[\\/]/).pop()}: ${f.error}`, 'error');
  await refresh();
}

/**
 * Properties, in a panel rather than a system alert box.
 *
 * A folder's size is the only figure here that is not free: it means walking
 * the tree, which is why it is measured on request and why the panel says so
 * while it is happening.
 */
async function showProperties(entry) {
  if (!entry) return;
  setBusy(entry.isDirectory ? `Measuring ${entry.name}…` : null);
  const props = await H.guard(
    () => nexa.explorer.properties(entry.path, { deep: entry.isDirectory }),
    'Properties'
  );
  setBusy(null);
  if (!props) return;

  const esc = H.esc;
  const rows = [
    ['Type', esc(props.typeLabel)],
    ['Location', `<span class="mono">${esc(props.path)}</span>`],
    props.isDirectory
      ? ['Contents', `${H.formatBytes(props.contents.bytes)} in ` +
          `${H.formatNumber(props.contents.files)} file(s), ` +
          `${H.formatNumber(props.contents.dirs)} folder(s)` +
          (props.contents.skipped
            ? ` <span class="muted">(${H.formatNumber(props.contents.skipped)} not readable)</span>`
            : '')]
      : ['Size', `${H.formatBytes(props.size)} ` +
          `<span class="muted">(${H.formatNumber(props.size)} bytes)</span>`],
    ['Modified', esc(formatDate(props.mtimeMs))],
    ['Created', esc(formatDate(props.birthMs))],
    ['Last opened', esc(formatDate(props.atimeMs))],
    props.readOnly ? ['Attributes', 'Read-only'] : null,
    props.isSymlink
      ? ['Note', 'This is a shortcut or junction. The size is the link itself, not its target.']
      : null,
  ].filter(Boolean);

  const dialog = document.createElement('div');
  dialog.className = 'ex-dialog-backdrop';
  dialog.innerHTML = `
    <div class="ex-dialog" role="dialog" aria-modal="true" aria-label="Properties of ${esc(props.name)}">
      <header>
        <span class="ex-ico">${icon(iconForType(props.type, props.isDirectory), { size: 18 })}</span>
        <h3>${esc(props.name)}</h3>
        <button class="ex-icon-btn" data-close aria-label="Close">${icon('x')}</button>
      </header>
      <dl>
        ${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
      </dl>
      <footer><button class="btn" data-close>Close</button></footer>
    </div>`;
  document.body.appendChild(dialog);

  // Escape closes it, and the listener that watches for Escape is removed
  // however it closes. Removing it only in the Escape branch left one behind
  // for every dialog closed with the button.
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    dialog.remove();
  }
  dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) close(); });
  document.addEventListener('keydown', onKey);
  dialog.querySelector('[data-close]')?.focus();
}

// ── context menu ───────────────────────────────────────────────────────────

function closeMenu() {
  state.menu?.remove();
  state.menu = null;
}

function openContextMenu(x, y, entry) {
  closeMenu();
  const sel = selectedEntries();
  const many = sel.length > 1;
  const items = [];

  if (entry) {
    items.push(['open', entry.isDirectory ? 'Open' : (entry.executable ? 'Run' : 'Open'), 'external', false]);
    items.push(['reveal', 'Show in File Explorer', 'eye', false]);
    items.push(['ask', many ? `Ask the assistant about these ${sel.length}` : 'Ask the assistant about this', 'attach', false]);
    if (entry.isDirectory) items.push(['scan', 'Scan this folder for space', 'scan', false]);
    items.push(['sep1', '', '', false]);
    items.push(['copy', 'Copy', 'copyFile', false]);
    items.push(['cut', 'Cut', 'cut', false]);
    if (entry.isDirectory && state.clipboard?.paths.length) {
      items.push(['paste-into', `Paste ${state.clipboard.paths.length} item(s) here`, 'paste', false]);
    }
    items.push(['rename', 'Rename', 'rename', many]);
    items.push(['sep2', '', '', false]);
    items.push(['delete', 'Delete', 'trash', false, 'danger']);
    items.push(['sep3', '', '', false]);
    items.push(['properties', 'Properties', 'properties', many]);
  } else {
    items.push(['new-folder', 'New folder', 'folderPlus', false]);
    if (state.clipboard?.paths.length) {
      items.push(['paste', `Paste ${state.clipboard.paths.length} item(s)`, 'paste', false]);
    }
    items.push(['sep1', '', '', false]);
    items.push(['refresh', 'Refresh', 'refresh', false]);
    items.push(['reveal-here', 'Show this folder in File Explorer', 'eye', false]);
    items.push(['scan-here', 'Scan this folder for space', 'scan', false]);
  }

  const menu = document.createElement('div');
  menu.className = 'ex-context';
  menu.innerHTML = items.map(([id, label, ic, disabled, kind]) => (
    id.startsWith('sep')
      ? '<div class="ex-menu-rule"></div>'
      : `<button data-action="${id}" ${disabled ? 'disabled' : ''} class="${kind || ''}">
           ${icon(ic, { size: 14 })}<span>${H.esc(label)}</span>
         </button>`
  )).join('');
  document.body.appendChild(menu);

  // Keep it on screen: a menu opened near the bottom edge opens upward.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  state.menu = menu;

  menu.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    closeMenu();
    await runMenuAction(btn.dataset.action, entry);
  });
}

async function runMenuAction(action, entry) {
  switch (action) {
    case 'open': return openEntry(entry);
    case 'reveal': return nexa.explorer.reveal(entry.path).catch((e) => H.toast(e.message, 'error'));
    case 'reveal-here': return nexa.explorer.reveal(state.path).catch((e) => H.toast(e.message, 'error'));
    case 'ask': return H.attachToAssistant(selectedEntries().map((e) => e.path));
    case 'scan': return H.scanFolder(entry.path);
    case 'scan-here': return H.scanFolder(state.path);
    case 'copy': return copySelection('copy');
    case 'cut': return copySelection('cut');
    case 'paste': return paste();
    case 'paste-into': return paste(entry.path);
    case 'rename': return beginRename();
    case 'delete': return deleteSelection();
    case 'properties': return showProperties(entry);
    case 'new-folder': return newFolder();
    case 'refresh': return refresh();
    default: return undefined;
  }
}

// ── wiring ─────────────────────────────────────────────────────────────────

export function wire(stage) {
  const body = stage.querySelector('#ex-body');
  if (!body) return;

  // toolbar
  stage.querySelector('#ex-back')?.addEventListener('click', goBack);
  stage.querySelector('#ex-forward')?.addEventListener('click', goForward);
  stage.querySelector('#ex-up')?.addEventListener('click', goUp);
  stage.querySelector('#ex-refresh')?.addEventListener('click', refresh);
  // Only the breadcrumbs. The same attributes appear inside the list — on the
  // access gate's buttons — and those belong to wireBody; binding them here as
  // well would fire each of them twice.
  stage.querySelector('#ex-crumbs')?.querySelectorAll('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => navigate(b.dataset.goto));
  });

  const query = stage.querySelector('#ex-query');
  query?.addEventListener('input', () => {
    state.query = query.value;
    const scrolled = body.scrollTop;
    body.innerHTML = bodyContent();
    body.scrollTop = scrolled;
    // Everything inside the body was just replaced, headers and buttons
    // included. Re-wiring only the rows left the column headers and "Show all"
    // dead for the rest of the session — the filter box quietly broke sorting.
    wireBody(stage, body);
    updateStatus(stage);
  });

  // command bar
  stage.querySelector('#ex-new-folder')?.addEventListener('click', newFolder);
  stage.querySelector('#ex-open')?.addEventListener('click', () => openEntry(selectedEntries()[0]));
  stage.querySelector('#ex-copy')?.addEventListener('click', () => copySelection('copy'));
  stage.querySelector('#ex-cut')?.addEventListener('click', () => copySelection('cut'));
  stage.querySelector('#ex-paste')?.addEventListener('click', () => paste());
  stage.querySelector('#ex-rename')?.addEventListener('click', beginRename);
  stage.querySelector('#ex-delete')?.addEventListener('click', deleteSelection);
  stage.querySelector('#ex-ask')?.addEventListener('click',
    () => H.attachToAssistant(selectedEntries().map((e) => e.path)));
  wireMenu(stage, '#ex-sort-btn', '#ex-sort-menu');
  wireMenu(stage, '#ex-view-btn', '#ex-view-menu');

  stage.querySelectorAll('[data-sort-key]').forEach((b) => {
    b.addEventListener('click', () => {
      state.sort.key = b.dataset.sortKey;
      persistPrefs();
      H.rerender();
    });
  });
  stage.querySelectorAll('[data-sort-dir]').forEach((b) => {
    b.addEventListener('click', () => {
      state.sort.dir = Number(b.dataset.sortDir);
      persistPrefs();
      H.rerender();
    });
  });
  stage.querySelectorAll('[data-layout]').forEach((b) => {
    b.addEventListener('click', () => {
      state.layout = b.dataset.layout;
      persistPrefs();
      H.rerender();
    });
  });
  stage.querySelector('[data-toggle-hidden]')?.addEventListener('click', () => {
    state.showHidden = !state.showHidden;
    persistPrefs();
    H.rerender();
  });
  wireBody(stage, body);
  wireKeys(stage, body);

  // Empty space: clears the selection, and accepts a drop into this folder.
  body.addEventListener('mousedown', (ev) => {
    if (ev.target.closest('.ex-row') || ev.button !== 0) return;
    state.selection.clear();
    state.anchor = null;
    applySelection(stage);
  });
  body.addEventListener('contextmenu', (ev) => {
    if (ev.target.closest('.ex-row')) return;
    ev.preventDefault();
    openContextMenu(ev.clientX, ev.clientY, null);
  });

  wireDropTargets(stage);
  body.addEventListener('dragover', (ev) => {
    if (!state.listing?.entries) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = ev.ctrlKey ? 'copy' : 'move';
  });
  body.addEventListener('drop', async (ev) => {
    if (ev.target.closest('[data-drop-target]')) return;   // handled there
    const paths = await pathsFromDrop(ev);
    if (paths.length) {
      ev.preventDefault();
      await dropOnto(paths, state.path, { copy: ev.ctrlKey });
    }
  });

  if (!state.renaming) body.focus({ preventScroll: true });
}

function updateStatus(stage) {
  const left = stage.querySelector('#ex-status-left');
  if (left && state.listing?.counts) {
    const counts = state.listing.counts;
    left.textContent = `${H.formatNumber(visibleEntries().length)} item(s)` +
      (counts.hidden && !state.showHidden ? `, ${H.formatNumber(counts.hidden)} hidden` : '') +
      (counts.unreadable ? `, ${H.formatNumber(counts.unreadable)} unreadable` : '');
  }
  applySelection(stage);
}

function wireMenu(stage, buttonSel, menuSel) {
  const button = stage.querySelector(buttonSel);
  const menu = stage.querySelector(menuSel);
  if (!button || !menu) return;
  button.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const wasHidden = menu.hidden;
    stage.querySelectorAll('.ex-menu').forEach((m) => { m.hidden = true; });
    menu.hidden = !wasHidden;
  });
}

/**
 * Every listener that lives inside the scrolling list.
 *
 * Called on a full render and again whenever the body alone is re-rendered —
 * which the filter box does on every keystroke. Anything wired here must be
 * wired *only* here, or the two paths drift apart.
 */
function wireBody(stage, body) {
  body.querySelectorAll('[data-sort-col]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortCol;
      if (state.sort.key === key) state.sort.dir *= -1;
      else { state.sort.key = key; state.sort.dir = 1; }
      persistPrefs();
      H.rerender();
    });
  });

  body.querySelector('#ex-show-all')?.addEventListener('click', () => {
    state.limit = Infinity;
    H.rerender();
  });

  body.querySelectorAll('[data-grant]').forEach((b) => {
    b.addEventListener('click', () => grantAccess(b.dataset.grant));
  });

  body.querySelectorAll('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => navigate(b.dataset.goto));
  });

  wireRows(stage, body);
  hydrateIcons(stage);
}

function wireRows(stage, body) {
  body.querySelectorAll('.ex-row').forEach((row) => {
    const path = row.dataset.path;

    row.addEventListener('mousedown', (ev) => {
      if (ev.button === 2 && state.selection.has(path)) return;   // keep multi-selection
      if (ev.shiftKey) selectRange(path);
      else if (ev.ctrlKey || ev.metaKey) {
        if (state.selection.has(path)) state.selection.delete(path);
        else state.selection.add(path);
        state.anchor = path;
      } else if (!state.selection.has(path)) {
        selectOnly(path);
      }
      applySelection(stage);
    });

    row.addEventListener('click', (ev) => {
      if (ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
      if (state.selection.size > 1) { selectOnly(path); applySelection(stage); }
    });

    row.addEventListener('dblclick', () => openEntry(entryByPath(path)));

    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (!state.selection.has(path)) { selectOnly(path); applySelection(stage); }
      openContextMenu(ev.clientX, ev.clientY, entryByPath(path));
    });

    row.addEventListener('dragstart', (ev) => {
      if (!state.selection.has(path)) { selectOnly(path); applySelection(stage); }
      const paths = [...state.selection];
      ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
      ev.dataTransfer.setData('text/plain', paths.join('\n'));
      ev.dataTransfer.effectAllowed = 'copyMove';
    });
  });

  const renameInput = body.querySelector('.ex-rename-input');
  if (renameInput) {
    renameInput.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); commitRename(renameInput.value); }
      if (ev.key === 'Escape') { state.renaming = null; H.rerender(); }
    });
    renameInput.addEventListener('blur', () => {
      if (state.renaming) commitRename(renameInput.value);
    });
    renameInput.addEventListener('dblclick', (ev) => ev.stopPropagation());
  }

  wireDropTargets(stage);
}

/** Folder rows and breadcrumbs accept a drop, exactly as they do in Explorer. */
function wireDropTargets(scope) {
  scope.querySelectorAll('[data-drop-target]').forEach((el) => {
    if (el.dataset.dropWired) return;
    el.dataset.dropWired = '1';

    el.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = ev.ctrlKey ? 'copy' : 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      el.classList.remove('drop-target');
      const dest = el.dataset.dropTarget;
      const paths = await pathsFromDrop(ev);
      const filtered = paths.filter((p) => p !== dest);
      if (filtered.length) await dropOnto(filtered, dest, { copy: ev.ctrlKey });
    });
  });
}

/** Paths behind a drop: our own rows, or real files dragged in from Windows. */
export async function pathsFromDrop(ev) {
  const own = ev.dataTransfer.getData(DRAG_TYPE);
  if (own) {
    try { return JSON.parse(own); } catch { /* fall through to files */ }
  }
  const out = [];
  for (const file of ev.dataTransfer.files || []) {
    const p = nexa.dropped.pathFor(file);
    if (p) out.push(p);
  }
  return out;
}

function wireKeys(stage, body) {
  body.addEventListener('keydown', async (ev) => {
    if (ev.target.classList?.contains('ex-rename-input')) return;
    const entries = visibleEntries();
    const current = state.anchor || [...state.selection][0];
    const index = entries.findIndex((e) => e.path === current);
    const perRow = state.layout === 'details' || state.layout === 'list' ? 1 : columnsInGrid(body);

    const move = (delta) => {
      const next = Math.max(0, Math.min(entries.length - 1, (index === -1 ? 0 : index + delta)));
      const target = entries[next];
      if (!target) return;
      if (ev.shiftKey && state.anchor) selectRange(target.path);
      else selectOnly(target.path);
      state.anchor = ev.shiftKey ? state.anchor : target.path;
      applySelection(stage);
      body.querySelector(`.ex-row[data-path="${cssEscape(target.path)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    };

    // Alt+Left and Alt+Right are Back and Forward in every layout, so they are
    // taken before the arrows mean movement.
    if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); return goBack(); }
    if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); return goForward(); }

    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); return move(perRow);
      case 'ArrowUp': ev.preventDefault(); return move(-perRow);
      case 'ArrowRight': if (perRow > 1) { ev.preventDefault(); return move(1); } return;
      case 'ArrowLeft': if (perRow > 1) { ev.preventDefault(); return move(-1); } return;
      case 'Home': ev.preventDefault(); return move(-entries.length);
      case 'End': ev.preventDefault(); return move(entries.length);
      case 'Enter': ev.preventDefault(); return openEntry(entryByPath(current));
      case 'Backspace': ev.preventDefault(); return goUp();
      case 'Delete': ev.preventDefault(); return deleteSelection();
      case 'F2': ev.preventDefault(); return beginRename();
      case 'F5': ev.preventDefault(); return refresh();
      case 'Escape': closeMenu(); state.selection.clear(); return applySelection(stage);
      default: break;
    }

    if (!(ev.ctrlKey || ev.metaKey)) return;

    switch (ev.key.toLowerCase()) {
      case 'a':
        ev.preventDefault();
        state.selection = new Set(entries.map((e) => e.path));
        return applySelection(stage);
      case 'c': ev.preventDefault(); return copySelection('copy');
      case 'x': ev.preventDefault(); return copySelection('cut');
      case 'v': ev.preventDefault(); return paste();
      case 'f': ev.preventDefault(); return stage.querySelector('#ex-query')?.focus();
      default: return undefined;
    }
  });
}

function columnsInGrid(body) {
  const grid = body.querySelector('.ex-grid');
  const tile = body.querySelector('.ex-tile');
  if (!grid || !tile) return 1;
  return Math.max(1, Math.round(grid.clientWidth / tile.getBoundingClientRect().width));
}

/** CSS.escape is present in Electron, but a path in an attribute selector still
 *  needs the backslashes doubled before it. */
function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

// A click anywhere else closes whatever popover is open.
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.ex-context')) closeMenu();
  if (!ev.target.closest('.ex-menu-host')) {
    document.querySelectorAll('.ex-menu').forEach((m) => { m.hidden = true; });
  }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenu(); });
