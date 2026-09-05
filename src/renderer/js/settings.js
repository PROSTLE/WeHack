// Settings.
//
// Five sections, and a rule that governs all of them: nothing here is a
// decoration. Every control reads its current value from the process that owns
// it and writes back to that same process, every figure is measured when the
// panel opens, and anything the platform will not report says so instead of
// showing a plausible number. A switch that looks like a setting but changes
// nothing is worse than no switch, because it teaches the user that the
// interface lies.

import { icon } from './icons.js';

let nexa = null;
let H = null;

const SECTIONS = [
  ['appearance', 'sparkle', 'Appearance'],
  ['assistant', 'chat', 'Assistant'],
  ['machine', 'cpu', 'This PC'],
  ['access', 'shield', 'Access to this PC'],
  ['data', 'disk', 'NexaFiles’ own data'],
];

export const state = {
  section: 'appearance',
  settings: null,       // the persisted preferences, as the main process has them
  agent: null,          // key status, model, tool list
  models: null,         // fetched from the API, never hardcoded
  modelsError: null,
  machine: null,
  storage: null,
  roots: null,
  busy: null,
  probe: null,          // the result of the last connection test
  voice: null,          // which dictation engine would answer right now
  wakeModel: null,      // whether the wake word's acoustic model is downloaded
  wakeProgress: null,   // {received,total,ratio} while it is being fetched
  // How many files have been described so far. Kept beside the toggle so the
  // panel can always say what has been sent, not only what may be.
  describeIndex: null,
  loading: false,
};

export function init(bridge, helpers) {
  nexa = bridge;
  H = helpers;
}

// ── data ───────────────────────────────────────────────────────────────────

/** Loads everything the open section needs. Cheap sections load eagerly. */
export async function load({ force = false } = {}) {
  state.loading = true;
  H.rerender();

  const jobs = [];
  if (force || !state.settings) {
    jobs.push(H.guard(() => nexa.settings.get(), 'Reading settings').then((v) => { state.settings = v; }));
  }
  if (force || !state.agent) {
    jobs.push(H.guard(() => nexa.agent.status(), 'Reading assistant status').then((v) => { state.agent = v; }));
  }
  if (force || !state.roots) {
    jobs.push(H.guard(() => nexa.roots.list(), 'Reading roots').then((v) => { state.roots = v; }));
  }
  if (force || !state.voice) {
    jobs.push(nexa.voice.status().then((v) => { state.voice = v; }).catch(() => {}));
  }
  if (force || !state.wakeModel) {
    jobs.push(nexa.wake.modelStatus().then((v) => { state.wakeModel = v; }).catch(() => {}));
  }
  if (force || !state.describeIndex) {
    jobs.push(nexa.describe.status()
      .then((v) => { state.describeIndex = v.indexed; }).catch(() => {}));
  }
  if ((state.section === 'machine' && (force || !state.machine))) {
    jobs.push(H.guard(() => nexa.system.machine(), 'Reading machine details').then((v) => { state.machine = v; }));
  }
  if ((state.section === 'data' && (force || !state.storage))) {
    jobs.push(H.guard(() => nexa.system.storage(), 'Reading storage').then((v) => { state.storage = v; }));
  }

  await Promise.all(jobs);
  state.loading = false;
  H.rerender();
}

export async function show(section) {
  if (section) state.section = section;
  await load();
}

/** Re-reads how many files have been described, after a change to that. */
async function refreshDescribeIndex() {
  try {
    const s = await nexa.describe.status();
    state.describeIndex = s.indexed;
  } catch { /* the panel simply shows no count */ }
}

// ── render ─────────────────────────────────────────────────────────────────

export function render() {
  const esc = H.esc;
  return `
    <div class="settings">
      <header class="set-head">
        <h1>Settings</h1>
        <p class="muted">Everything here is read from, and written to, the running
           application. Nothing on this page is a placeholder.</p>
      </header>

      <nav class="set-nav" role="tablist">
        ${SECTIONS.map(([id, ic, label]) => `
          <button role="tab" data-section="${id}" aria-selected="${state.section === id}">
            ${icon(ic, { size: 15 })}<span>${esc(label)}</span>
          </button>`).join('')}
      </nav>

      <div class="set-body">
        ${state.busy ? `<div class="set-busy"><span class="spinner"></span>${esc(state.busy)}</div>` : ''}
        ${sectionBody()}
      </div>
    </div>`;
}

function sectionBody() {
  switch (state.section) {
    case 'appearance': return appearance();
    case 'assistant': return assistant();
    case 'machine': return machineSection();
    case 'access': return access();
    case 'data': return data();
    default: return '';
  }
}

function panel(title, note, body, actions = '') {
  const esc = H.esc;
  return `
    <section class="panel set-panel">
      <header>
        <h2>${esc(title)}</h2>
        ${actions ? `<div class="actions">${actions}</div>` : ''}
      </header>
      ${note ? `<p class="set-note">${note}</p>` : ''}
      ${body}
    </section>`;
}

/** A definition list. Every value is measured; `null` renders as "not reported". */
function facts(rows) {
  const esc = H.esc;
  return `
    <dl class="set-facts">
      ${rows.filter(Boolean).map(([k, v, title]) => `
        <dt${title ? ` title="${esc(title)}"` : ''}>${esc(k)}</dt>
        <dd>${v === null || v === undefined || v === ''
          ? '<span class="muted">not reported by this platform</span>'
          : v}</dd>`).join('')}
    </dl>`;
}

// ── appearance ─────────────────────────────────────────────────────────────

const THEME_CHOICES = [
  ['system', 'gauge', 'Match Windows', 'Follows the system setting, and changes with it while the app is open.'],
  ['light', 'sparkle', 'Light', 'Porcelain ground, ultramarine primary. The original palette.'],
  ['dark', 'eyeOff', 'Dark', 'The same palette on an indigo-charcoal ground, with the pigments lifted to match.'],
];

function appearance() {
  const esc = H.esc;
  const current = state.settings?.theme || 'system';
  const effective = state.settings?.effective;

  return panel(
    'Theme',
    'The choice is stored and applied before the window is drawn, so a dark session ' +
    'opens dark rather than flashing white first.',
    `
    <div class="theme-choices">
      ${THEME_CHOICES.map(([id, ic, label, blurb]) => `
        <button class="theme-card" data-theme-choice="${id}" aria-pressed="${current === id}">
          <span class="theme-swatch theme-swatch-${id}" aria-hidden="true">
            <span class="tsw-bar"></span><span class="tsw-bar short"></span><span class="tsw-dot"></span>
          </span>
          <span class="theme-label">${icon(ic, { size: 14 })} ${esc(label)}</span>
          <span class="theme-blurb">${esc(blurb)}</span>
        </button>`).join('')}
    </div>

    <div class="set-inline-note">
      ${icon('info', { size: 13 })}
      <span>Currently showing the <strong>${effective?.dark ? 'dark' : 'light'}</strong> theme${
        current === 'system' ? ', because that is what Windows is set to' : ''}.</span>
    </div>`
  ) + panel(
    'The Files view',
    'These are the same controls as the Files view’s own Sort and View menus. ' +
    'They are stored here so the view opens the way you left it.',
    facts([
      ['Layout', `<span class="mono">${esc(state.settings?.files.layout || 'details')}</span>`],
      ['Hidden and system items', state.settings?.files.showHidden ? 'Shown' : 'Hidden'],
      ['Sorted by', `<span class="mono">${esc(state.settings?.files.sortKey || 'name')}</span>,
        ${state.settings?.files.sortDir === -1 ? 'descending' : 'ascending'}`],
    ])
  );
}

// ── assistant ──────────────────────────────────────────────────────────────

function assistant() {
  const esc = H.esc;
  const a = state.agent;
  const configured = !!a?.configured;
  const source = a?.keySource;
  const model = state.settings?.assistant.model;

  const keyStatus = configured
    ? `<span class="pill ok">${icon('check', { size: 12 })} ${a.keyCount} key${a.keyCount > 1 ? 's' : ''} configured</span>
       <span class="muted">from ${esc(source || 'an unknown source')}</span>`
    : `<span class="pill">${icon('caution', { size: 12 })} No API key</span>
       <span class="muted">the assistant is unavailable; every local feature still works</span>`;

  const keyPanel = panel(
    'API key',
    'The assistant is the one feature that leaves this machine. Without a key, scanning, ' +
    'duplicate detection, leftovers, quarantine and the Files view are all unaffected — only ' +
    'the chat panel stops working. A key saved here is written to <span class="mono">settings.json</span> ' +
    'in NexaFiles’ own data folder, in plain text, and takes precedence over ' +
    '<span class="mono">GEMINI_API_KEYS</span> in the environment.',
    `
    <div class="set-row">${keyStatus}</div>
    ${a?.keyCount && state.settings?.assistant.keyHints?.length ? `
      <div class="set-row">
        ${state.settings.assistant.keyHints.map((h) => `<span class="chip mono">${esc(h)}</span>`).join('')}
      </div>` : ''}
    <div class="set-field">
      <label for="set-key">Paste a key, or several separated by commas</label>
      <div class="set-input-row">
        <input type="password" id="set-key" class="set-input mono" spellcheck="false"
               autocomplete="off" placeholder="AIza…">
        <button class="btn primary" id="set-key-save">${icon('check')} Save</button>
        ${state.settings?.assistant.keyCount
          ? `<button class="btn" id="set-key-clear">${icon('trash')} Clear</button>` : ''}
      </div>
      <p class="set-hint">Keys are never shown back to the interface once saved — only the
        last four characters are.</p>
    </div>`
  );

  const modelRows = state.models || [];
  const modelPanel = panel(
    'Model',
    'This list is fetched from Google with your own key rather than written into this ' +
    'application, so it is whatever your key can actually call today. Only models that ' +
    'support <span class="mono">generateContent</span> are offered, because that is the ' +
    'only method the agent uses.',
    `
    <div class="set-field">
      <label for="set-model">Model used by the assistant</label>
      <div class="set-input-row">
        <select id="set-model" class="set-input" ${modelRows.length ? '' : 'disabled'}>
          <option value="">Default (${esc(a?.model || 'not reported')})</option>
          ${modelRows.map((m) => `
            <option value="${esc(m.id)}" ${model === m.id ? 'selected' : ''}>
              ${esc(m.label || m.id)} — ${esc(m.id)}
            </option>`).join('')}
        </select>
        <button class="btn" id="set-models-refresh" ${configured ? '' : 'disabled'}>
          ${icon('refresh')} ${state.models ? 'Refresh' : 'Load models'}
        </button>
      </div>
      ${state.modelsError ? `<p class="set-hint error">${esc(state.modelsError)}</p>` : ''}
      ${!configured ? '<p class="set-hint">Add a key above to load the list.</p>' : ''}
      ${modelRows.length && model ? (() => {
        const m = modelRows.find((x) => x.id === model);
        return m ? `<p class="set-hint">${esc(m.description || '')}
          ${m.inputTokenLimit ? `Input limit ${H.formatNumber(m.inputTokenLimit)} tokens;
          output ${H.formatNumber(m.outputTokenLimit)}.` : ''}</p>` : '';
      })() : ''}
    </div>

    <div class="set-row">
      <button class="btn" id="set-test" ${configured ? '' : 'disabled'}>
        ${icon('activity')} Test the connection
      </button>
      <button class="btn quiet" id="set-reset-chat">${icon('restore')} Reset the conversation</button>
      ${state.probe ? (state.probe.ok
        ? `<span class="pill ok">${icon('check', { size: 12 })} replied in ${state.probe.ms} ms</span>`
        : `<span class="pill bad">${icon('caution', { size: 12 })} ${esc(state.probe.error)}</span>`) : ''}
    </div>
    ${state.probe?.ok ? `<p class="set-hint">Model answered: <span class="mono">${esc(state.probe.reply)}</span></p>` : ''}`
  );

  const toolPanel = panel(
    'What the assistant can do',
    'The agent has exactly these tools and no others. It has no tool that deletes, moves or ' +
    'writes anything: the two <span class="mono">propose_*</span> tools return a plan for you ' +
    'to approve, and approving it runs the same deterministic code as every other removal.',
    `<div class="tool-list">
      ${(a?.tools || []).map((t) => `
        <div class="tool-row">
          <span class="mono tool-name">${esc(t.name)}</span>
          <span class="tool-desc">${esc(t.description)}</span>
        </div>`).join('') || '<p class="muted">Tool list not available.</p>'}
    </div>`
  );

  const o = state.settings?.overlay || {};
  const bound = state.settings?.overlayHotkeyBound;
  const overlayPanel = panel(
    'The overlay panel',
    'A second, floating panel that opens over whatever you are doing, on one keystroke, ' +
    'anywhere — to find a document by what is inside it and convert it without going ' +
    'looking for this window first. It is not always listening: the microphone opens ' +
    'when the panel opens and closes when it closes, and there is no state in which it ' +
    'is hidden and recording.',
    `
    <div class="set-row">
      ${o.enabled
        ? (bound && bound.ok === false
          ? `<span class="pill bad">${icon('caution', { size: 12 })} ${esc(bound.why || 'the shortcut could not be claimed')}</span>`
          : `<span class="pill ok">${icon('check', { size: 12 })} ${esc(bound?.hotkey || o.hotkey)} is bound</span>`)
        : `<span class="pill">${icon('info', { size: 12 })} switched off</span>`}
    </div>

    <div class="set-field">
      <label for="set-overlay-hotkey">The key that opens it</label>
      <div class="set-input-row">
        <input type="text" id="set-overlay-hotkey" class="set-input mono" spellcheck="false"
               autocomplete="off" value="${esc(o.hotkey || '')}" placeholder="Control+Alt+Space">
        <button class="btn primary" id="set-overlay-hotkey-save">${icon('check')} Bind</button>
        <button class="btn" id="set-overlay-try" ${o.enabled ? '' : 'disabled'}>
          ${icon('eye')} Show it
        </button>
      </div>
      <p class="set-hint">Written the way Electron names chords —
        <span class="mono">Control</span>, <span class="mono">Alt</span>,
        <span class="mono">Shift</span>, <span class="mono">CommandOrControl</span>,
        joined by <span class="mono">+</span>. A chord another application already
        owns cannot be claimed, and this panel says so rather than leaving you
        pressing a key that does nothing.</p>
    </div>

    <label class="set-check">
      <input type="checkbox" id="set-overlay-enabled" ${o.enabled ? 'checked' : ''}>
      <span><strong>Enable the overlay.</strong> Off releases the shortcut and closes the
        hidden window it lives in.</span>
    </label>
    <label class="set-check">
      <input type="checkbox" id="set-overlay-listen" ${o.listenOnOpen ? 'checked' : ''}>
      <span><strong>Open the microphone with the panel.</strong> Off opens it ready to be
        typed into instead; the microphone button still works.</span>
    </label>
    <label class="set-check">
      <input type="checkbox" id="set-overlay-blur" ${o.hideOnBlur ? 'checked' : ''}>
      <span><strong>Dismiss it when it loses focus.</strong> A panel holding a question you
        have not answered stays put either way.</span>
    </label>
    <label class="set-check warn">
      <input type="checkbox" id="set-overlay-wake" ${o.wakeWord ? 'checked' : ''}
             ${state.wakeModel?.ready ? '' : 'disabled'}>
      <span><strong>Listen for “Hey Nexa”.</strong> This is the one setting in NexaFiles
        that holds your microphone open. The phrase is now recognised <em>on this
        machine</em>, by a speech model running in this application: no audio, no
        transcript and no record that you spoke is sent anywhere, whether or not the
        phrase was heard. That is also why it is fast — the panel opens as you finish
        saying it, rather than after a round-trip to a server. Your system’s recording
        indicator stays lit the whole time this is on, and NexaFiles cannot switch that
        off; it is the honest signal that the microphone is open.
        ${state.wakeModel?.ready ? '' : '<em>The speech model below has to be downloaded first.</em>'}</span>
    </label>
    ${wakeModelBlock()}`
  );

  return keyPanel + dictationPanel() + describePanel() + modelPanel + overlayPanel + toolPanel;
}

/**
 * Dictation, which is now a different engine from the assistant.
 *
 * These were the same thing until recently, and the result was that the model
 * chosen for answering questions was also the one asked to hear them — a
 * general model doing speech recognition as a side job, slowly and not very
 * well. They are separate settings because they are separate problems.
 */
function dictationPanel() {
  const esc = H.esc;
  const v = state.voice;
  const d = state.settings?.dictation || {};

  const status = !v ? '<span class="pill">Reading…</span>'
    : v.engine === 'groq'
      ? `<span class="pill ok">${icon('check', { size: 12 })} Groq ${esc(v.groq.model)}</span>
         <span class="muted">fast, and a real speech model</span>`
      : v.engine === 'gemini'
        ? `<span class="pill">${icon('caution', { size: 12 })} Falling back to ${esc(v.gemini.model || 'Gemini')}</span>
           <span class="muted">slower and less accurate; add a Groq key below</span>`
        : `<span class="pill">${icon('caution', { size: 12 })} No engine</span>
           <span class="muted">dictation is unavailable</span>`;

  const cooling = v?.groq?.cooldownMs > 0
    ? `<p class="set-hint">Groq's free limit is in force for another
       ${Math.ceil(v.groq.cooldownMs / 1000)}s. Dictation falls back to Gemini until it lifts.</p>`
    : '';

  return panel(
    'Dictation',
    'What turns your speech into text in the composer. Groq runs ' +
    '<span class="mono">whisper-large-v3-turbo</span>, which is a speech recognition model ' +
    'rather than a chat model asked to transcribe: ten seconds of speech comes back in about ' +
    'a third of a second, against two to four for the Gemini path, and it mishears far less. ' +
    'Groq’s free tier needs an account but no card, and is rate-limited per minute and per ' +
    'day. The key is written to <span class="mono">settings.json</span> in plain text, the ' +
    'same as the Gemini keys, and is never shown back to this interface once saved.',
    `
    <div class="set-row">${status}</div>
    ${cooling}
    ${d.groqConfigured ? `
      <div class="set-row"><span class="chip mono">${esc(d.groqKeyHint || '')}</span></div>` : ''}
    <div class="set-field">
      <label for="set-groq-key">Groq API key</label>
      <div class="set-input-row">
        <input type="password" id="set-groq-key" class="set-input mono" spellcheck="false"
               autocomplete="off" placeholder="gsk_…">
        <button class="btn primary" id="set-groq-save">${icon('check')} Save</button>
        ${d.groqConfigured ? `<button class="btn" id="set-groq-clear">${icon('trash')} Clear</button>` : ''}
      </div>
      <p class="set-hint">Free from <span class="mono">console.groq.com/keys</span>. With no key
        here, dictation falls back to the assistant’s Gemini model.</p>
    </div>
    <div class="set-field">
      <label for="set-dictation-engine">Preferred engine</label>
      <select id="set-dictation-engine" class="set-input">
        <option value="groq" ${d.engine === 'groq' ? 'selected' : ''}>Groq — Whisper turbo (recommended)</option>
        <option value="gemini" ${d.engine === 'gemini' ? 'selected' : ''}>Gemini — the assistant’s own model</option>
      </select>
      <p class="set-hint">Groq with no key saved falls back to Gemini rather than failing.</p>
    </div>`
  );
}

/**
 * Repaints just the download bar.
 *
 * Called on every progress event, which arrive ten times a second for the
 * length of a forty-megabyte download. Re-rendering the whole Settings view
 * that many times would rebuild every panel on the page to move one div, so
 * this reaches for the two nodes that actually change and leaves the rest of
 * the document alone. If they are not on screen there is nothing to do.
 */
export function rerenderProgress() {
  const p = state.wakeProgress;
  if (!p) return;
  const bar = document.querySelector('#set-wake-progress-bar');
  const label = document.querySelector('#set-wake-progress-label');
  if (!bar || !label) return;      // the section is not open, or the model is ready
  const pct = Math.round((p.ratio || 0) * 100);
  bar.style.width = `${pct}%`;
  label.textContent = `${(p.received / 1e6).toFixed(0)} MB of ${(p.total / 1e6).toFixed(0)} MB`;
  const pill = document.querySelector('#set-wake-progress-pill');
  if (pill) pill.textContent = `Downloading the speech model — ${pct}%`;
}

/**
 * The wake word's acoustic model.
 *
 * Presented as its own thing with its own download button rather than fetched
 * silently when the checkbox is ticked: it is forty megabytes, and a checkbox
 * that quietly pulls forty megabytes is a checkbox that lied about what it did.
 */
/**
 * Describing files, and the undo for having done it.
 *
 * This panel exists as much to be switched *off* as on. It is the only feature
 * in NexaFiles that sends the contents of a user's files anywhere, so the
 * count of what has been sent, and the button that deletes all of it, are both
 * on screen at all times rather than being something to go and find.
 */
function describePanel() {
  const esc = H.esc;
  const d = state.settings?.describe;
  if (!d) return '';
  const idx = state.describeIndex;          // filled by the status call
  const hasKey = !!state.agent?.configured;

  return panel(
    'Describing files, to find them by description',
    'Every other search in NexaFiles matches something measured off your disk. This one ' +
    'shows each picture and document to the model once and stores the words it comes back ' +
    'with, so “a photo of a brown dog on grass” can find ' +
    '<span class="mono">IMG_4821.JPG</span>. It is the one feature that sends the contents ' +
    'of your files to Google, which is why it is off until you switch it on.',
    `
    <label class="set-check warn">
      <input type="checkbox" id="set-describe-enabled" ${d.enabled ? 'checked' : ''}
             ${hasKey ? '' : 'disabled'}>
      <span><strong>Let NexaFiles describe my files.</strong> Nothing is sent by switching
        this on: it only unlocks the button in the Discover view. From then on, each file
        you choose to describe — its pixels if it is an image, its text if it is a
        document — is sent to the Gemini API once, and the words that come back are stored
        on this machine. A file that has not changed is never sent twice.
        ${hasKey ? '' : '<em>An API key has to be configured above first.</em>'}</span>
    </label>

    ${d.enabled ? `
      <div class="set-field">
        <label for="set-describe-cap">Most files to describe in one run</label>
        <div class="set-input-row">
          <input type="number" id="set-describe-cap" class="set-input mono"
                 min="10" max="5000" step="10" value="${Number(d.maxFilesPerRun)}">
          <span class="muted">one API call each</span>
        </div>
        <p class="set-hint">A ceiling on what a single press of “Describe my files” can
          spend. Raising it does not describe more on its own — the button still has to be
          pressed, and it can be stopped part-way.</p>
      </div>

      <label class="set-check">
        <input type="checkbox" id="set-describe-docs" ${d.includeDocuments ? 'checked' : ''}>
        <span><strong>Describe documents too, not only pictures.</strong> Pictures are what
          this feature exists for — nothing on disk says what is in one. A document’s words
          can already be searched without sending it anywhere, from the assistant.</span>
      </label>
      <label class="set-check">
        <input type="checkbox" id="set-describe-code" ${d.includeCode ? 'checked' : ''}>
        <span><strong>Describe source code as well.</strong> Off by default: a project
          folder is thousands of files, and each one would be a separate call.</span>
      </label>
    ` : ''}

    ${idx ? `
      <div class="set-row" style="margin-top:12px">
        <span class="pill ${idx.described ? 'ok' : ''}">
          ${icon(idx.described ? 'check' : 'info', { size: 12 })}
          ${Number(idx.described).toLocaleString()} file(s) described
        </span>
        <span class="muted">
          ${idx.files > idx.described
            ? `${Number(idx.files - idx.described).toLocaleString()} more were looked at and could not be described`
            : 'held on this machine, in NexaFiles’ own database'}
        </span>
      </div>` : ''}

    ${idx && idx.files ? `
      <div class="set-row">
        <button class="btn" id="set-describe-verify">${icon('check')} Verify</button>
        <button class="btn destructive" id="set-describe-clear">${icon('trash')} Delete every description</button>
      </div>
      <p class="set-hint">Verify drops descriptions of files that no longer exist. Deleting
        them all is the undo for having switched this on: the stored words go, and nothing
        is re-sent unless you describe again. It does not reach what the API already
        received — only Google can speak to that.</p>` : ''}`
  );
}

function wakeModelBlock() {
  const m = state.wakeModel;
  const p = state.wakeProgress;
  const mb = (n) => `${(n / 1e6).toFixed(0)} MB`;

  if (p && !m?.ready) {
    const pct = Math.round((p.ratio || 0) * 100);
    return `
      <div class="set-field">
        <div class="set-row">
          <span class="pill" id="set-wake-progress-pill">Downloading the speech model — ${pct}%</span>
          <span class="muted" id="set-wake-progress-label">${mb(p.received)} of ${mb(p.total)}</span>
        </div>
        <div class="set-progress">
          <div class="set-progress-bar" id="set-wake-progress-bar" style="width:${pct}%"></div>
        </div>
        <div class="set-input-row">
          <button class="btn" id="set-wake-cancel">Cancel</button>
        </div>
      </div>`;
  }

  if (m?.ready) {
    return `
      <div class="set-field">
        <div class="set-row">
          <span class="pill ok">${icon('check', { size: 12 })} Speech model ready</span>
          <span class="muted">${H.esc(m.id)} — recognition happens on this machine</span>
        </div>
        <div class="set-input-row">
          <button class="btn" id="set-wake-remove">${icon('trash')} Remove it (${mb(m.bytes)})</button>
        </div>
      </div>`;
  }

  return `
    <div class="set-field">
      <div class="set-row">
        <span class="pill">${icon('caution', { size: 12 })} Speech model not downloaded</span>
      </div>
      <p class="set-hint">“Hey Nexa” recognises the phrase on this machine rather than sending
        audio away, which needs a ${mb(m?.bytes || 41184862)} acoustic model. It is fetched once and
        cached; after that the wake word works with no network at all.</p>
      <div class="set-input-row">
        <button class="btn primary" id="set-wake-download">Download the speech model</button>
      </div>
    </div>`;
}

// ── this PC ────────────────────────────────────────────────────────────────

function machineSection() {
  const esc = H.esc;
  const m = state.machine;
  if (!m) {
    return panel('This PC', 'Reading the machine…', '<p class="muted">One moment.</p>');
  }

  const pct = m.memory.totalBytes ? (m.memory.usedBytes / m.memory.totalBytes) * 100 : 0;

  return panel(
    'Processor and memory',
    'Read from the operating system when this panel opened, at ' +
    `<span class="mono">${esc(new Date(m.measuredAt).toLocaleTimeString())}</span>.`,
    facts([
      ['Processor', esc(m.cpu.model)],
      ['Logical processors', `${H.formatNumber(m.cpu.cores)}${m.cpu.speedMHz
        ? ` at ${(m.cpu.speedMHz / 1000).toFixed(2)} GHz average` : ''}`],
      ['Architecture', esc(m.cpu.architecture)],
      ['Memory installed', esc(H.formatBytes(m.memory.totalBytes))],
      ['Memory in use', `${esc(H.formatBytes(m.memory.usedBytes))} — ${pct.toFixed(0)}%
        <div class="bar" style="margin-top:6px"><span style="width:${pct.toFixed(1)}%"></span></div>`],
      ['Memory free', esc(H.formatBytes(m.memory.freeBytes))],
      ['Power source', m.power.onBattery === null
        ? null : (m.power.onBattery ? 'On battery' : 'Plugged in')],
    ]),
    `<button class="btn small" id="set-machine-refresh">${icon('refresh')} Measure again</button>`
  ) + panel(
    'Operating system',
    '',
    facts([
      ['System', `${esc(m.os.type)} ${esc(m.os.version || '')}`],
      ['Release', `<span class="mono">${esc(m.os.release)}</span>`],
      ['Computer name', esc(m.os.hostname)],
      ['Signed in as', esc(m.os.username)],
      ['Home folder', `<span class="mono">${esc(m.os.homedir)}</span>`],
      ['Up for', esc(H.humanSpan(m.os.uptimeSeconds))],
      ['Region and time zone', `${esc(m.os.locale)} · ${esc(m.os.timeZone)}`],
    ])
  ) + panel(
    'Graphics and displays',
    '',
    facts([
      ['Renderer', esc(m.gpu.renderer)],
      ['Vendor', esc(m.gpu.vendor)],
      ['Driver', esc(m.gpu.driverVersion)],
      ...(m.displays || []).map((d, i) => [
        `Display ${i + 1}${d.current ? ' (this window)' : ''}`,
        `${d.widthPx} × ${d.heightPx} at ${d.scaleFactor}× · ${d.colorDepth}-bit${d.internal ? ' · internal' : ''}`,
      ]),
    ])
  ) + panel(
    'Drives',
    'The same enumeration the Files view uses.',
    `<div class="scroll-x"><table class="table">
      <thead><tr><th>Volume</th><th>File system</th><th class="num">Used</th>
        <th class="num">Free</th><th class="num">Capacity</th></tr></thead>
      <tbody>
        ${(m.drives || []).map((d) => `
          <tr>
            <td class="name">${esc(d.id || d.path)} ${esc(d.name)}${d.removable ? ' <span class="chip">removable</span>' : ''}</td>
            <td>${esc(d.fileSystem || '—')}</td>
            <td class="num bytes">${esc(H.formatBytes(d.usedBytes))}</td>
            <td class="num bytes">${esc(H.formatBytes(d.freeBytes))}</td>
            <td class="num bytes">${esc(H.formatBytes(d.totalBytes))}</td>
          </tr>`).join('')}
      </tbody>
    </table></div>`
  ) + panel(
    'NexaFiles itself',
    'An optimiser built on Electron should be willing to say what it costs.',
    facts([
      ['Version', esc(m.runtime.appVersion)],
      ['Electron', esc(m.runtime.electron)],
      ['Chromium', esc(m.runtime.chromium)],
      ['Node', esc(m.runtime.node)],
      ['Packaged build', m.runtime.packaged ? 'Yes' : 'No — running from source'],
      ['Running from', `<span class="mono">${esc(m.runtime.execPath)}</span>`],
    ])
  );
}

// ── access ─────────────────────────────────────────────────────────────────

function access() {
  const esc = H.esc;
  const list = state.roots?.roots || [];
  const guarded = state.roots?.protectedPaths || [];

  return panel(
    'What NexaFiles can reach',
    'Every part of this application that touches a path — the scanner, the Files view, ' +
    'the assistant’s read tools, and the code that removes things — resolves that path ' +
    'against this list first. A location that is not inside one of these cannot be read, ' +
    'listed, opened, copied or deleted, whatever asks for it.',
    `
    <div class="root-list">
      ${list.length ? list.map((r) => `
        <div class="root-row">
          ${icon('shield', { size: 14 })}
          <span class="mono root-path">${esc(r)}</span>
          <button class="btn small" data-revoke-root="${esc(r)}">${icon('x', { size: 12 })} Withdraw</button>
        </div>`).join('') : '<p class="muted">No location is approved. Nothing can be read.</p>'}
    </div>
    <div class="set-row" style="margin-top:12px">
      <button class="btn" id="set-add-root">${icon('plus')} Approve a folder…</button>
    </div>
    <p class="set-hint">Your home folder is approved by launching the application. Anything
      else — another drive, a folder on a second disk — is approved by you, here or by
      opening it in the Files view, and is remembered between runs.</p>`
  ) + panel(
    'Locations nothing can touch',
    'These are refused even when they sit inside an approved root, and the refusal happens ' +
    'below the interface, so no button anywhere in this application can override it.',
    `
    <div class="root-list">
      <div class="root-row fixed">
        ${icon('lock', { size: 14 })}
        <span class="root-path">Windows, WindowsApps, System Volume Information, $Recycle.Bin
          and Recovery — built in, and not removable.</span>
      </div>
      ${guarded.map((p) => `
        <div class="root-row">
          ${icon('lock', { size: 14 })}
          <span class="mono root-path">${esc(p)}</span>
          <button class="btn small" data-unprotect="${esc(p)}">${icon('x', { size: 12 })} Remove</button>
        </div>`).join('')}
    </div>
    <div class="set-row" style="margin-top:12px">
      <button class="btn" id="set-add-protected">${icon('lock')} Protect a folder…</button>
    </div>
    <p class="set-hint">Choosing a folder here does not give NexaFiles access to it — it does
      the opposite, and takes precedence over every approval.</p>`
  ) + panel(
    'What it will never do',
    '',
    `<ul class="set-list">
      <li>Delete anything without showing you the list first and waiting for your approval.</li>
      <li>Delete permanently. Files go to the Recycle Bin; application data goes to
          quarantine for 30 days with a record of where it came from.</li>
      <li>Send the contents of your disk anywhere. The only thing that leaves this machine
          is what you type into the assistant and the files you drop on it yourself.</li>
      <li>Run anything on your behalf. The assistant cannot execute a command, and the
          Files view asks before it launches a program.</li>
    </ul>`
  );
}

// ── data ───────────────────────────────────────────────────────────────────

function data() {
  const esc = H.esc;
  const st = state.storage;
  if (!st) return panel('NexaFiles’ own data', '', '<p class="muted">Reading…</p>');

  return panel(
    'What NexaFiles stores, and where',
    'All of it lives in one folder. Deleting that folder loses the file index, the ' +
    'quarantine and these settings, and nothing else.',
    facts([
      ['Data folder', `<span class="mono">${esc(st.userData)}</span>`],
      ['File index', `${esc(H.formatBytes(st.index.bytes))} — ${H.formatNumber(st.index.scans)} scan(s) kept`],
      ['Quarantine', `${H.formatNumber(st.quarantine.items)} item(s), ${esc(H.formatBytes(st.quarantine.bytes))}`],
      ['Settings', `<span class="mono">${esc(st.settings.path.split(/[\\/]/).pop())}</span> —
        ${esc(H.formatBytes(st.settings.bytes))}`],
      ['Approved roots', `${H.formatNumber(st.approvedRoots.count)} stored in
        <span class="mono">${esc(st.approvedRoots.path.split(/[\\/]/).pop())}</span>`],
    ]),
    `<button class="btn small" id="set-open-data">${icon('external')} Open the folder</button>`
  );
}

// ── wiring ─────────────────────────────────────────────────────────────────

export function wire(stage) {
  stage.querySelectorAll('[data-section]').forEach((b) => {
    b.addEventListener('click', () => { show(b.dataset.section); });
  });

  // appearance
  stage.querySelectorAll('[data-theme-choice]').forEach((b) => {
    b.addEventListener('click', async () => {
      const updated = await H.guard(
        () => nexa.settings.set({ theme: b.dataset.themeChoice }), 'Saving the theme');
      if (!updated) return;
      state.settings = updated;
      H.applyTheme(updated.effective.dark);
      H.rerender();
    });
  });

  // assistant
  const saveFromField = async () => {
    const input = stage.querySelector('#set-key');
    if (!input) return;
    const keys = input.value.split(',').map((k) => k.trim()).filter(Boolean);
    if (!keys.length) { H.toast('Paste a key first.', 'error'); return; }
    await saveKeys(keys, `${keys.length} key(s) saved.`);
    input.value = '';
  };

  stage.querySelector('#set-key-save')?.addEventListener('click', saveFromField);
  // Pasting a key and pressing Enter is what everyone does; a field that
  // ignores Enter and insists on the button is a small, daily annoyance.
  stage.querySelector('#set-key')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); saveFromField(); }
  });

  stage.querySelector('#set-key-clear')?.addEventListener('click', async () => {
    if (!window.confirm('Remove the saved key(s)?\n\nNexaFiles will fall back to ' +
      'GEMINI_API_KEYS in the environment, or config.js, if either is present.')) return;
    await saveKeys([], 'Saved key(s) removed.');
  });

  stage.querySelector('#set-models-refresh')?.addEventListener('click', loadModels);

  // The overlay's controls. Each writes to the running process and re-reads what
  // came back, because binding a shortcut can fail — another application may
  // already hold that chord — and the answer to "did that work" has to come from
  // the attempt rather than from the fact that a value was saved.
  const saveOverlay = async (patch) => {
    state.settings = await H.guard(() => nexa.settings.set({ overlay: patch }), 'Saving');
    H.rerender();
    const bound = state.settings?.overlayHotkeyBound;
    if (bound && bound.ok === false && bound.why) H.toast(bound.why, 'error');
  };

  stage.querySelector('#set-overlay-hotkey-save')?.addEventListener('click', () => {
    const field = stage.querySelector('#set-overlay-hotkey');
    saveOverlay({ hotkey: field.value.trim() });
  });
  stage.querySelector('#set-overlay-hotkey')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') saveOverlay({ hotkey: ev.target.value.trim() });
  });
  stage.querySelector('#set-overlay-enabled')?.addEventListener('change', (ev) =>
    saveOverlay({ enabled: ev.target.checked }));
  stage.querySelector('#set-overlay-listen')?.addEventListener('change', (ev) =>
    saveOverlay({ listenOnOpen: ev.target.checked }));
  stage.querySelector('#set-overlay-blur')?.addEventListener('change', (ev) =>
    saveOverlay({ hideOnBlur: ev.target.checked }));
  stage.querySelector('#set-overlay-wake')?.addEventListener('change', (ev) =>
    saveOverlay({ wakeWord: ev.target.checked }));
  stage.querySelector('#set-overlay-try')?.addEventListener('click', async () => {
    await H.guard(() => nexa.overlay.show(), 'Opening the overlay');
  });

  // ── describing files ─────────────────────────────────────────────────────

  const saveDescribe = async (patch) => {
    state.settings = await H.guard(() => nexa.settings.set({ describe: patch }), 'Saving');
    await refreshDescribeIndex();
    H.rerender();
  };

  stage.querySelector('#set-describe-enabled')?.addEventListener('change', async (ev) => {
    if (!ev.target.checked) { await saveDescribe({ enabled: false }); return; }
    // Switching it on is the moment the user agrees that their files may be
    // sent, so it is said in those words rather than implied by a toggle.
    const ok = window.confirm(
      'Let NexaFiles describe your files?\n\n' +
      'From then on, each file you choose to describe is sent to the Gemini API — ' +
      'the pixels of a picture, the text of a document — and the words that come ' +
      'back are stored on this machine.\n\n' +
      'Switching this on sends nothing by itself. Nothing leaves until you press ' +
      '"Describe my files" in the Discover view, and you can delete every stored ' +
      'description from here afterwards.');
    if (!ok) { ev.target.checked = false; return; }
    await saveDescribe({ enabled: true });
    H.toast('Describing is on. Nothing has been sent yet — use the Discover view.');
  });

  stage.querySelector('#set-describe-docs')?.addEventListener('change', (ev) =>
    saveDescribe({ includeDocuments: ev.target.checked }));
  stage.querySelector('#set-describe-code')?.addEventListener('change', (ev) =>
    saveDescribe({ includeCode: ev.target.checked }));
  stage.querySelector('#set-describe-cap')?.addEventListener('change', (ev) => {
    const n = Number(ev.target.value);
    if (Number.isFinite(n)) saveDescribe({ maxFilesPerRun: n });
  });

  stage.querySelector('#set-describe-verify')?.addEventListener('click', async () => {
    const out = await H.guard(() => nexa.describe.verify(), 'Verifying');
    if (!out) return;
    await refreshDescribeIndex();
    H.rerender();
    H.toast(out.removed
      ? `Dropped ${out.removed} description(s) of files that are gone.`
      : 'Every described file is still where it was.');
  });

  stage.querySelector('#set-describe-clear')?.addEventListener('click', async () => {
    const n = state.describeIndex?.files || 0;
    const ok = window.confirm(
      `Delete all ${n} stored description(s)?\n\n` +
      'The words NexaFiles stored about your files are removed from this machine. ' +
      'Your files are not touched.\n\n' +
      'This cannot reach what the API already received — only Google can speak to ' +
      'that. It also means describing again would re-send those files.');
    if (!ok) return;
    const out = await H.guard(() => nexa.describe.clear(), 'Deleting descriptions');
    if (!out) return;
    await refreshDescribeIndex();
    H.rerender();
    H.toast(`Deleted ${out.removed} description(s).`);
  });

  // ── dictation ────────────────────────────────────────────────────────────

  // Enter in the field saves, the same as the Gemini key above it. A key is
  // pasted and then submitted, and reaching for the mouse to finish is exactly
  // the friction that leaves a half-configured setting behind.
  const saveGroqKey = async () => {
    const field = stage.querySelector('#set-groq-key');
    const key = (field?.value || '').trim();
    if (!key) { H.toast('Paste a key first.', 'error'); return; }
    const updated = await H.guard(
      () => nexa.settings.set({ dictation: { groqKey: key } }), 'Saving the Groq key');
    if (!updated) return;
    if (field) field.value = '';
    state.settings = updated;
    state.voice = await nexa.voice.status().catch(() => state.voice);
    H.toast(state.settings.dictation.groqConfigured
      ? 'Dictation will use Groq from the next thing you say.'
      : 'That key looked too short to be a Groq key.');
    H.rerender();
  };

  stage.querySelector('#set-groq-save')?.addEventListener('click', saveGroqKey);
  stage.querySelector('#set-groq-key')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); saveGroqKey(); }
  });

  stage.querySelector('#set-groq-clear')?.addEventListener('click', async () => {
    const updated = await H.guard(
      () => nexa.settings.set({ dictation: { groqKey: '' } }), 'Clearing the Groq key');
    if (!updated) return;
    state.settings = updated;
    state.voice = await nexa.voice.status().catch(() => state.voice);
    H.toast('The Groq key was cleared. Dictation falls back to Gemini.');
    H.rerender();
  });

  stage.querySelector('#set-dictation-engine')?.addEventListener('change', async (ev) => {
    const updated = await H.guard(
      () => nexa.settings.set({ dictation: { engine: ev.target.value } }), 'Saving the engine');
    if (!updated) return;
    state.settings = updated;
    state.voice = await nexa.voice.status().catch(() => state.voice);
    H.rerender();
  });

  // ── the wake word's model ────────────────────────────────────────────────

  stage.querySelector('#set-wake-download')?.addEventListener('click', async () => {
    state.wakeProgress = { received: 0, total: state.wakeModel?.bytes || 0, ratio: 0 };
    H.rerender();
    try {
      await nexa.wake.ensureModel();
      state.wakeModel = await nexa.wake.modelStatus();
      H.toast('The speech model is ready. “Hey Nexa” now works offline.');
    } catch (err) {
      H.toast(err?.message || 'The speech model could not be downloaded.');
    } finally {
      state.wakeProgress = null;
      H.rerender();
    }
  });

  stage.querySelector('#set-wake-cancel')?.addEventListener('click', async () => {
    await nexa.wake.cancelModel().catch(() => {});
  });

  stage.querySelector('#set-wake-remove')?.addEventListener('click', async () => {
    // Removing the model is also switching the feature off: leaving the checkbox
    // ticked with nothing to recognise with would be a setting that claims to be
    // listening and is not.
    await H.guard(() => nexa.settings.set({ overlay: { wakeWord: false } }), 'Switching the wake word off');
    await nexa.wake.removeModel().catch(() => {});
    state.settings = await nexa.settings.get().catch(() => state.settings);
    state.wakeModel = await nexa.wake.modelStatus().catch(() => null);
    H.toast('The speech model was removed and “Hey Nexa” switched off.');
    H.rerender();
  });

  stage.querySelector('#set-model')?.addEventListener('change', async (ev) => {
    const updated = await H.guard(
      () => nexa.settings.set({ assistant: { model: ev.target.value || null } }),
      'Saving the model');
    if (!updated) return;
    state.settings = updated;
    state.agent = await H.guard(() => nexa.agent.status(), 'Reading assistant status');
    state.probe = null;
    H.toast(`The assistant will use ${ev.target.value || 'the default model'}.`);
    H.rerender();
  });

  stage.querySelector('#set-test')?.addEventListener('click', async () => {
    setBusy('Sending one request to the model…');
    try {
      state.probe = await nexa.agent.test();
    } catch (err) {
      state.probe = { ok: false, error: err.message };
    }
    setBusy(null);
  });

  stage.querySelector('#set-reset-chat')?.addEventListener('click', async () => {
    await H.guard(() => nexa.agent.reset(), 'Resetting');
    H.resetChat();
    H.toast('The conversation was cleared.');
  });

  // machine
  stage.querySelector('#set-machine-refresh')?.addEventListener('click', () => load({ force: true }));

  // access
  stage.querySelector('#set-add-root')?.addEventListener('click', async () => {
    const chosen = await H.guard(() => nexa.roots.choose(), 'Choosing a folder');
    if (!chosen) return;
    state.roots = await H.guard(() => nexa.roots.list(), 'Reading roots');
    H.toast(`${chosen.path} is now readable by NexaFiles.`);
    H.onRootsChanged();
    H.rerender();
  });

  stage.querySelectorAll('[data-revoke-root]').forEach((b) => {
    b.addEventListener('click', async () => {
      const target = b.dataset.revokeRoot;
      if (!window.confirm(`Withdraw access to ${target}?\n\nNexaFiles will no longer be ` +
        `able to read, list or open anything inside it.`)) return;
      await H.guard(() => nexa.roots.revoke(target), 'Withdrawing');
      state.roots = await H.guard(() => nexa.roots.list(), 'Reading roots');
      H.onRootsChanged();
      H.rerender();
    });
  });

  stage.querySelector('#set-add-protected')?.addEventListener('click', async () => {
    const chosen = await H.guard(() => nexa.roots.pick('Choose a folder to protect'), 'Choosing a folder');
    if (!chosen) return;
    const next = [...(state.roots?.protectedPaths || []), chosen.path];
    await H.guard(() => nexa.roots.setProtected(next), 'Protecting');
    state.roots = await H.guard(() => nexa.roots.list(), 'Reading roots');
    H.toast(`${chosen.path} is now off limits to NexaFiles.`);
    H.onRootsChanged();
    H.rerender();
  });

  stage.querySelectorAll('[data-unprotect]').forEach((b) => {
    b.addEventListener('click', async () => {
      const next = (state.roots?.protectedPaths || []).filter((p) => p !== b.dataset.unprotect);
      await H.guard(() => nexa.roots.setProtected(next), 'Updating');
      state.roots = await H.guard(() => nexa.roots.list(), 'Reading roots');
      H.onRootsChanged();
      H.rerender();
    });
  });

  // data
  stage.querySelector('#set-open-data')?.addEventListener('click', () => {
    nexa.system.openUserData().catch((err) => H.toast(err.message, 'error'));
  });
}

function setBusy(label) {
  state.busy = label;
  H.rerender();
}

async function saveKeys(keys, message) {
  setBusy(keys.length ? 'Saving…' : 'Clearing…');
  const updated = await H.guard(
    () => nexa.settings.set({ assistant: { keys } }), 'Saving the key');
  if (updated) {
    state.settings = updated;
    state.agent = await H.guard(() => nexa.agent.status(), 'Reading assistant status');
    state.models = null;
    state.modelsError = null;
    state.probe = null;
    H.toast(message);
  }
  setBusy(null);
}

async function loadModels() {
  setBusy('Asking Google which models this key can call…');
  try {
    state.models = await nexa.agent.models();
    state.modelsError = state.models.length ? null : 'The API returned no usable models.';
  } catch (err) {
    state.models = null;
    state.modelsError = err.message;
  }
  setBusy(null);
}
