// The overlay panel's renderer.
//
// One object that changes shape. Every state below draws into the same card,
// the card's height is measured and animated, and the window is resized under it
// so the two move together — grow the window first and then the card, shrink the
// card first and then the window, or the panel visibly clips itself mid-morph.
//
// The flow it exists for, end to end:
//
//   key pressed → the microphone opens → you speak → it stops when you do
//   → what you said is written down → the assistant searches inside your files
//   → one match: it proposes → several: it asks which
//   → you approve → NexaFiles converts → you save, reveal or open it
//
// Two rules hold throughout, and they are the same two the side panel holds to:
// speech is transcribed into a request the user can see before anything acts on
// it, and nothing on disk is written until the user presses the button that
// writes it. The assistant proposes. This panel is where the person agrees.

import * as voice from './voice.js';

const nexa = window.nexa;

const card = document.getElementById('card');
const body = document.getElementById('body');
const headTitle = document.getElementById('head-title');
const headSub = document.getElementById('head-sub');
const micBtn = document.getElementById('mic-btn');
const sendBtn = document.getElementById('send-btn');
const input = document.getElementById('ask-input');
const closeBtn = document.getElementById('close-btn');
const cardHead = document.getElementById('card-head');
const composer = document.getElementById('composer');

const MAX_CARD = 604;   // past this the body scrolls instead of the card growing
const MIN_CARD = 132;   // the compact, listening shape

const state = {
  phase: 'idle',        // idle | listening | transcribing | thinking | answer | choice | proposal | done | error
  heard: '',            // what the microphone was told, as written down
  reply: '',
  choice: null,
  conversion: null,
  results: null,
  stage: null,          // the live commentary line
  error: null,
  status: null,         // what the main process says is configured
  busy: false,
};

let lastHeight = 132;

// ── shaping ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The matched passage, with the marks SQLite put around the matched words
 * turned into real emphasis.
 *
 * The text is escaped first and the markers substituted after, so a document
 * containing "<b>" shows those characters rather than turning bold. The
 * markers themselves are two characters no ordinary document contains, which is
 * why they were chosen for the snippet in the first place.
 */
function snippetHtml(text) {
  return esc(text).replace(/‹/g, '<mark>').replace(/›/g, '</mark>');
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** A path shortened from the left, because the end of it is the part that says where. */
function shortFolder(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

/** The folder a file is in. Used where naming the file again would be noise. */
function folderOf(filePath) {
  const parts = String(filePath || '').split(/[\\/]/);
  parts.pop();
  return shortFolder(parts.join('/'));
}

// ── the views ───────────────────────────────────────────────────────────────

function viewIdle() {
  if (state.status && !state.status.assistantConfigured) {
    return `<div class="view">
      <p class="say">The assistant needs a Gemini API key before it can answer.
         Everything else in NexaFiles works without one.</p>
      <p class="hint">Add a key in Settings, in the Assistant section.</p>
    </div>`;
  }
  return `<div class="view">
    <p class="say quiet">Ask for a file by what it is about — “my blog on elephants”
       — and Nexa will read your documents to find it.</p>
    <p class="hint">Press <kbd>Esc</kbd> to dismiss.</p>
  </div>`;
}

function viewListening() {
  return `<div class="view">
    <div class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    <p class="hint">Speak — it stops on its own when you finish.
       <kbd>Esc</kbd> to cancel.</p>
  </div>`;
}

function viewWorking(message) {
  return `<div class="view">
    ${state.heard ? `<p class="heard">${esc(state.heard)}</p>` : ''}
    <div class="working"><span class="dot"></span><span>${esc(message)}</span></div>
  </div>`;
}

function viewAnswer() {
  return `<div class="view">
    ${state.heard ? `<p class="heard">${esc(state.heard)}</p>` : ''}
    <p class="say">${esc(state.reply)}</p>
  </div>`;
}

function viewChoice() {
  const c = state.choice;
  return `<div class="view">
    ${state.heard ? `<p class="heard">${esc(state.heard)}</p>` : ''}
    <p class="choice-q">${esc(c.question)}</p>
    <div class="files">
      ${c.options.map((o) => `
        <button class="file" data-pick="${esc(o.path)}">
          <span class="file-mark">${esc((o.extension || '?').slice(0, 4))}</span>
          <span class="file-text">
            <span class="file-name">${esc(o.name)}</span>
            <span class="file-meta">${esc(shortFolder(o.folder))}${
              o.bytes != null ? ` · ${formatBytes(o.bytes)}` : ''}${
              o.lastModified ? ` · ${esc(o.lastModified)}` : ''}</span>
            ${o.snippet
              ? `<span class="file-snip">${snippetHtml(o.snippet)}</span>`
              : o.opening ? `<span class="file-snip">${esc(o.opening)}</span>` : ''}
          </span>
        </button>`).join('')}
    </div>
  </div>`;
}

function viewProposal() {
  const c = state.conversion;
  return `<div class="view">
    ${state.heard ? `<p class="heard">${esc(state.heard)}</p>` : ''}
    <p class="say">${esc(state.reply)}</p>
    <div class="slip">
      ${c.items.map((i) => `
        <div class="slip-row">
          <span class="slip-name" title="${esc(i.source)}">${esc(i.name)}</span>
          <span class="slip-arrow">→</span>
          <span class="slip-name to" title="${esc(i.target)}">${esc(i.targetName)}</span>
          ${i.targetExists ? '<span class="tag">exists</span>' : ''}
        </div>`).join('')}
    </div>
    <p class="note">Converted by ${esc(c.engine)}. The original is never changed or
       removed — this adds a file next to it${
       c.items.some((i) => i.targetExists) ? ', under a numbered name where one is already there' : ''}.</p>
    <div class="actions">
      <button class="btn primary" data-act="convert">Convert to ${esc(c.format.toUpperCase())}</button>
      <button class="btn" data-act="dismiss">Not now</button>
    </div>
  </div>`;
}

function viewDone() {
  const made = (state.results?.results || []).filter((r) => r.ok);
  const failed = (state.results?.results || []).filter((r) => !r.ok);
  return `<div class="view">
    <p class="say">${esc(state.reply)}</p>
    ${made.map((r) => `
      <div class="slip">
        <div class="slip-row">
          <span class="tag new">PDF</span>
          <span class="slip-name" title="${esc(r.target)}">${esc(r.target.split(/[\\/]/).pop())}</span>
        </div>
        <div class="slip-row">
          <span class="tag done">saved</span>
          <span class="file-meta">${esc(folderOf(r.target))} · ${formatBytes(r.bytes)}</span>
        </div>
      </div>
      <div class="actions">
        <button class="btn primary" data-act="save" data-path="${esc(r.target)}">Save a copy…</button>
        <button class="btn" data-act="reveal" data-path="${esc(r.target)}">Show in folder</button>
        <button class="btn" data-act="open" data-path="${esc(r.target)}">Open</button>
      </div>`).join('')}
    ${failed.length ? `<p class="trouble">${failed.map((f) => esc(f.error)).join(' ')}</p>` : ''}
  </div>`;
}

function viewError() {
  return `<div class="view">
    ${state.heard ? `<p class="heard">${esc(state.heard)}</p>` : ''}
    <p class="trouble">${esc(state.error)}</p>
  </div>`;
}

/** The line under the title: what the panel is doing, in three or four words. */
function subtitle() {
  switch (state.phase) {
    case 'listening':     return 'Listening…';
    case 'transcribing':  return 'Writing that down…';
    case 'thinking':      return state.stage || 'Thinking…';
    case 'choice':        return `${state.choice.options.length} files match`;
    case 'proposal':      return 'Ready to convert';
    case 'done':          return 'Done';
    case 'error':         return 'That did not work';
    default:              return state.status?.hotkey ? `Press ${state.status.hotkey} anywhere` : 'Ready';
  }
}

function currentView() {
  switch (state.phase) {
    case 'listening':    return viewListening();
    case 'transcribing': return viewWorking('Writing down what you said…');
    case 'thinking':     return viewWorking(state.stage || 'Thinking…');
    case 'answer':       return viewAnswer();
    case 'choice':       return viewChoice();
    case 'proposal':     return viewProposal();
    case 'done':         return viewDone();
    case 'error':        return viewError();
    default:             return viewIdle();
  }
}

// ── the morph ───────────────────────────────────────────────────────────────

/**
 * The height the card wants.
 *
 * Computed from the parts rather than by setting the card to `height: auto` and
 * reading it back. That trick works, but it reads a height while a height
 * transition may be mid-flight, and it has to be exactly right first time —
 * there is no second chance to notice the answer was ten pixels short, which is
 * how the panel ended up drawn just too small to show its own buttons.
 *
 * The head and the composer are fixed; the content is whatever the view is.
 * `.view` is `display: flow-root`, so its box genuinely contains its children's
 * margins and this sum is the real number.
 */
function desiredHeight() {
  const view = body.firstElementChild;
  const content = view ? view.getBoundingClientRect().height : 0;
  const chrome = cardHead.offsetHeight + composer.offsetHeight;
  // The body's own vertical padding, which the content sits inside.
  const raw = Math.ceil(chrome + content + 2);

  // The body scrolls only when the card has actually been clamped. Leaving
  // `overflow-y: auto` on permanently puts a scrollbar track down the side of a
  // panel whose content fits, which reads as content hidden below the fold when
  // there is none.
  body.classList.toggle('scrolls', raw > MAX_CARD);

  return Math.min(Math.max(raw, MIN_CARD), MAX_CARD);
}

let pendingShrink = null;

/**
 * Moves the card and the window to fit the content now in it.
 *
 * Growing, the window has to be enlarged first — the card cannot animate into
 * space the window does not have, and doing it the other way round clips the
 * bottom of the panel for the length of the animation. Shrinking, the reverse:
 * the card closes up first and the window follows once it has arrived, so no
 * frame shows the transparent gap.
 */
async function fit() {
  const target = desiredHeight();
  if (Math.abs(target - lastHeight) < 1) return;

  clearTimeout(pendingShrink);
  if (target > lastHeight) {
    await nexa.overlay.resize(target, { immediate: true });
    card.style.height = `${target}px`;
  } else {
    card.style.height = `${target}px`;
    pendingShrink = setTimeout(() => nexa.overlay.resize(target), 440);
  }
  lastHeight = target;
}

function render() {
  const sub = subtitle();
  if (headSub.textContent !== sub) {
    headSub.textContent = sub;
    headSub.classList.remove('shift');
    void headSub.offsetWidth;
    headSub.classList.add('shift');
  }

  body.innerHTML = currentView();

  const busy = state.phase === 'listening' ? 'listening'
    : (state.phase === 'thinking' || state.phase === 'transcribing') ? 'true'
    : 'false';
  document.body.dataset.busy = busy;

  micBtn.classList.toggle('live', state.phase === 'listening');
  micBtn.disabled = state.phase === 'transcribing' || state.phase === 'thinking';
  sendBtn.disabled = state.phase === 'thinking' || state.phase === 'transcribing';

  fit();
}

// Text reflows after a font settles, a long filename wraps a line later than
// expected, and a view drawn at one width is a different height at another. Any
// of those leaves the card at a height that was right when it was measured and
// is wrong now. Rather than trying to measure perfectly once, the panel watches
// its own content and corrects itself.
if (typeof ResizeObserver === 'function') {
  const watcher = new ResizeObserver(() => {
    if (Math.abs(desiredHeight() - lastHeight) > 1) fit();
  });
  watcher.observe(body);
  const observeView = () => {
    const view = body.firstElementChild;
    if (view) watcher.observe(view);
  };
  new MutationObserver(observeView).observe(body, { childList: true });
  observeView();
}

function setPhase(phase, patch = {}) {
  Object.assign(state, patch, { phase });
  render();
}

// ── speech ──────────────────────────────────────────────────────────────────
//
// The panel is opened to be spoken at, so the microphone opens with it. What
// makes that bearable rather than alarming is that it closes with it too: there
// is no state in which this panel is hidden and recording, and the stop below
// runs on every path out — silence, Escape, the button, a lost window.

// How the panel decides you have stopped talking. Speech has to be heard first,
// so a panel opened in a quiet room waits rather than immediately deciding the
// silence was the end of a sentence.
const SPEECH_LEVEL = 0.055;      // above this is a voice rather than a room
const SILENCE_MS = 1100;         // quiet for this long after speech ends it
const NO_SPEECH_MS = 6500;       // opened, nothing said: give up rather than hang

let heardSpeech = false;
let lastLoudAt = 0;
let openedAt = 0;
let silenceTimer = null;

function setLevel(level) {
  document.documentElement.style.setProperty('--level', level.toFixed(3));
}

async function startListening() {
  if (state.phase === 'listening') return;
  if (voice.isRecording()) return;
  if (!voice.isSupported()) {
    setPhase('error', { error: 'This build cannot record audio. Type the question instead.' });
    input.focus();
    return;
  }

  heardSpeech = false;
  lastLoudAt = 0;
  openedAt = performance.now();

  try {
    await voice.start({
      onLevel: (level) => {
        setLevel(level);
        const now = performance.now();
        if (level > SPEECH_LEVEL) { heardSpeech = true; lastLoudAt = now; }
      },
    });
  } catch (err) {
    setPhase('error', { error: err.message });
    input.focus();
    return;
  }

  setPhase('listening', { heard: '', reply: '', choice: null, conversion: null, results: null, error: null });

  // Polled rather than driven from onLevel so that the decision is made on
  // elapsed time even when the level callback goes quiet.
  clearInterval(silenceTimer);
  silenceTimer = setInterval(() => {
    if (state.phase !== 'listening') { clearInterval(silenceTimer); return; }
    const now = performance.now();
    if (heardSpeech && now - lastLoudAt > SILENCE_MS) {
      clearInterval(silenceTimer);
      stopAndAsk();
    } else if (!heardSpeech && now - openedAt > NO_SPEECH_MS) {
      clearInterval(silenceTimer);
      cancelListening();
      setPhase('idle');
      input.focus();
    }
  }, 120);
}

function cancelListening() {
  clearInterval(silenceTimer);
  setLevel(0);
  try { voice.cancel(); } catch { /* nothing was open */ }
}

/** Ends the recording, writes it down, and asks with it. */
async function stopAndAsk() {
  clearInterval(silenceTimer);
  if (!voice.isRecording()) return;

  let recording;
  try {
    recording = await voice.stop();
  } catch (err) {
    setLevel(0);
    setPhase(err.code === 'TOO_SHORT' || err.code === 'SILENT' ? 'idle' : 'error',
      { error: err.message });
    if (err.code === 'TOO_SHORT' || err.code === 'SILENT') input.focus();
    return;
  }
  setLevel(0);
  setPhase('transcribing');

  let transcript;
  try {
    transcript = await nexa.agent.transcribe(recording);
  } catch (err) {
    setPhase('error', { error: err.message });
    return;
  }

  if (!transcript.text) {
    setPhase('idle');
    input.focus();
    return;
  }

  // What was heard is shown before it is acted on, and stays on screen beside
  // the answer. A panel that acts on a misheard sentence without ever showing it
  // leaves the user unable to tell a wrong answer from a wrong question.
  await ask(transcript.text);
}

// ── asking ──────────────────────────────────────────────────────────────────

async function ask(question) {
  setPhase('thinking', { heard: question, stage: null, error: null });
  try {
    const res = await nexa.overlay.ask(question);
    applyAnswer(res);
  } catch (err) {
    setPhase('error', { error: err.message });
  }
}

/** Routes one answer from the assistant into the state it should show. */
function applyAnswer(res) {
  if (res.choice) {
    setPhase('choice', { choice: res.choice, reply: res.reply, stage: null });
    return;
  }
  if (res.conversion) {
    setPhase('proposal', { conversion: res.conversion, reply: res.reply, stage: null });
    return;
  }
  setPhase('answer', { reply: res.reply, stage: null });
}

async function pick(path) {
  const question = state.choice?.id;
  setPhase('thinking', { stage: 'Opening that one…' });
  try {
    applyAnswer(await nexa.overlay.choose(question, [path]));
  } catch (err) {
    setPhase('error', { error: err.message });
  }
}

async function runConversion() {
  const proposal = state.conversion;
  setPhase('thinking', { stage: 'Converting…' });
  try {
    const results = await nexa.overlay.convert(proposal.id, { onConflict: 'rename' });
    const made = results.results.filter((r) => r.ok);
    setPhase(made.length ? 'done' : 'error', {
      results,
      reply: made.length === 1
        ? `Converted. ${made[0].target.split(/[\\/]/).pop()} is next to the original.`
        : `Converted ${made.length} files. They are next to their originals.`,
      error: made.length ? null : (results.results[0]?.error || 'Nothing was converted.'),
    });
  } catch (err) {
    setPhase('error', { error: err.message });
  }
}

// ── wiring ──────────────────────────────────────────────────────────────────

body.addEventListener('click', async (event) => {
  const picked = event.target.closest('[data-pick]');
  if (picked) return pick(picked.dataset.pick);

  const action = event.target.closest('[data-act]');
  if (!action) return;
  const { act, path } = action.dataset;

  if (act === 'convert') return runConversion();
  if (act === 'dismiss') return setPhase('answer', { reply: 'Left as it was. Nothing was written.' });

  try {
    if (act === 'save') {
      const saved = await nexa.overlay.saveCopy(path);
      if (saved.saved) setPhase('done', { reply: `Saved a copy to ${saved.path}.` });
    } else if (act === 'reveal') {
      await nexa.overlay.reveal(path);
    } else if (act === 'open') {
      await nexa.overlay.open(path);
    }
  } catch (err) {
    setPhase('error', { error: err.message });
  }
});

micBtn.addEventListener('click', () => {
  if (state.phase === 'listening') return stopAndAsk();
  return startListening();
});

function submitTyped() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  if (voice.isRecording()) cancelListening();
  ask(text);
}

sendBtn.addEventListener('click', submitTyped);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); submitTyped(); }
});

// Typing is a decision to type. The microphone closes rather than recording the
// user muttering while they write the question out instead.
input.addEventListener('input', () => {
  if (state.phase === 'listening' && input.value) {
    cancelListening();
    setPhase('idle');
  }
});

closeBtn.addEventListener('click', dismiss);

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  if (state.phase === 'listening') {
    cancelListening();
    setPhase('idle');
    return;
  }
  dismiss();
});

function dismiss() {
  cancelListening();
  // Walking away from a question stops it. Not awaited: the panel should close
  // on the keystroke rather than after a round trip, and the main process
  // abandons the turn either way.
  nexa.overlay.cancel().catch(() => { /* nothing was running */ });
  nexa.overlay.hide();
}

// ── the window's own life ───────────────────────────────────────────────────

/**
 * Everything that happens when the panel comes up.
 *
 * Shared between the event and the ready handshake, because the panel can be
 * summoned before its renderer has finished starting — the first press after
 * launch, every time — and both routes have to open it the same way.
 */
async function opened({ spoken = false } = {}) {
  // Three independent round-trips, issued together rather than one after
  // another. They were sequential, which put three IPC latencies in front of
  // every single open for no reason: the reset does not depend on the status
  // and neither depends on the settings. On the wake-word path this is now the
  // only waiting left between hearing the phrase and a usable panel, so it is
  // worth the `Promise.all`.
  const [status, settings] = await Promise.all([
    nexa.overlay.status().catch(() => null),
    nexa.settings.get().catch(() => null),
    // Every visit starts clean. The alternative — reopening onto the answer to
    // a question asked an hour ago — reads as the panel having been left running.
    nexa.overlay.reset().catch(() => {}),
  ]);
  state.status = status;

  Object.assign(state, {
    heard: '', reply: '', choice: null, conversion: null, results: null, error: null, stage: null,
  });
  setPhase('idle');
  input.value = '';

  applyTheme(settings);
  // Opened by the wake word, the microphone always arms: the user has just
  // spoken to it and is mid-sentence.
  const wantsMic = spoken || settings?.overlay?.listenOnOpen !== false;
  // `dictationConfigured` rather than `assistantConfigured`: a Groq key alone is
  // enough to turn speech into text, and refusing the microphone because there
  // is no Gemini key would disable dictation for the recommended setup.
  if (wantsMic && (state.status?.dictationConfigured ?? state.status?.assistantConfigured)) {
    startListening();
  } else {
    input.focus();
  }
}

nexa.overlay.onShown((payload) => opened({ spoken: payload?.reason === 'wake' }));

nexa.overlay.onHidden(() => {
  cancelListening();
  setPhase('idle');
});

// Clicking away dismisses the panel — unless it is holding something the user
// has not answered yet. Losing an unanswered question to a stray click would
// mean asking for the whole thing again.
nexa.overlay.onBlurred(async () => {
  const settings = await nexa.settings.get().catch(() => null);
  if (settings?.overlay?.hideOnBlur === false) return;
  if (state.phase === 'choice' || state.phase === 'proposal' || state.phase === 'done') return;
  if (state.phase === 'thinking' || state.phase === 'transcribing') return;
  dismiss();
});

// The live commentary. These arrive while a question is being answered, and are
// the difference between "reading your documents… 240 read" and a spinner.
nexa.overlay.onStage((payload) => {
  if (state.phase !== 'thinking') return;
  const named = {
    indexing: payload.message || 'Reading your documents…',
    searching: payload.message || 'Searching…',
    converting: payload.message || 'Converting…',
    thinking: 'Thinking…',
    working: 'Working…',
    tool: describeTool(payload.tool),
  };
  const next = named[payload.stage] || 'Working…';
  if (next === state.stage) return;
  state.stage = next;
  render();
});

/** Tool names are internal; this is what they are doing, in the user's terms. */
function describeTool(name) {
  switch (name) {
    case 'search_file_contents': return 'Reading your documents…';
    case 'read_document':        return 'Reading that file…';
    case 'ask_user_to_choose':   return 'Narrowing it down…';
    case 'get_conversion_support': return 'Checking what can be converted…';
    case 'propose_conversion':   return 'Preparing the conversion…';
    case 'get_scan_status':
    case 'get_disk_composition':
    case 'query_largest_files':  return 'Checking the last scan…';
    case 'find_duplicates':      return 'Comparing files…';
    default:                     return 'Working…';
  }
}

function applyTheme(settings) {
  const dark = settings?.effective?.dark;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

nexa.settings.onThemeChange((payload) => applyTheme({ effective: payload }));

// ── the wake word ───────────────────────────────────────────────────────────
//
// Not here any more. The recogniser runs in its own hidden window
// (src/renderer/wake.html, driven by js/wake-host.js) and the main process
// decides when it listens, because the main process is what knows whether this
// panel is on screen. This module's only remaining part in it is that opening
// with `reason: 'wake'` arms the microphone whatever "listen on open" says —
// the user has just spoken to it, and is probably mid-sentence.
//
// A note for whoever reads this next to the previous implementation still in
// git history: it drove the recogniser from here using
// `document.visibilityState === 'visible'` as the "is the panel actually on
// screen" check. That doesn't work — Electron keeps `visibilityState` at
// `'visible'` for a hidden BrowserWindow when `backgroundThrottling:false` is
// set (which this window needs, to keep recognising while another application
// has focus), so the condition was permanently true and the wake word could
// never actually fire. The dedicated listener window and the main-process-
// driven `wake:panel` signal replaced that mechanism because of this bug, not
// merely for cleanliness.

(async function boot() {
  state.status = await nexa.overlay.status().catch(() => null);
  const settings = await nexa.settings.get().catch(() => null);
  applyTheme(settings);
  setPhase('idle');

  // Announce that the handlers above are bound. The answer says whether the
  // panel is already on screen — it can be, when the very first press of the
  // shortcut arrived before this script finished running.
  const ready = await nexa.overlay.ready().catch(() => null);
  if (ready?.visible) await opened({ spoken: ready.reason === 'wake' });

})();

// A change in Settings takes effect now, not at the next launch.
nexa.settings.onChanged?.(async (settings) => {
  state.status = await nexa.overlay.status().catch(() => state.status);
  applyTheme(settings);
});
