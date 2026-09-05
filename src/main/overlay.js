'use strict';
// The overlay: NexaFiles when NexaFiles is not the window you are looking at.
//
// The premise is that the useful moment for "where is my blog about elephants"
// is while you are writing an email about it, not after you have found the file
// manager, brought it forward and clicked into a panel. So this is a second
// window: frameless, transparent, floating above other applications, summoned
// by one keystroke from anywhere and dismissed by another.
//
// By default it is not listening. The microphone opens when the panel opens and
// closes when the panel closes, which is the same rule the side panel's composer
// already holds to.
//
// "Hey Nexa" is the one way that changes, and it is off until someone switches
// it on: it holds the microphone open, and the setting that enables it says so
// in as many words rather than in a footnote. Nothing it hears leaves the
// machine — the phrase is recognised on-device, which is written out in full at
// the top of src/renderer/js/wake.js, where that listening actually happens.
//
// What it can do is bounded by exactly the same tools and the same approved-root
// gate as the side panel. The overlay is a different way in, not a different set
// of powers: it proposes, the user approves in the panel, and NexaFiles acts.

const path = require('path');
const { BrowserWindow, globalShortcut, screen, shell } = require('electron');
const wakeWindow = require('./wake/window');

// Wide enough for a file path to be readable, narrow enough to sit beside real
// work without covering it.
const WIDTH = 420;

// The window is grown and shrunk to fit its contents. These bound it: the
// compact listening state, and the tallest the list of choices is allowed to
// get before it scrolls inside the card instead.
const MIN_HEIGHT = 132;
const MAX_HEIGHT = 660;

// Transparent margin inside the window, around the card. The card's shadow and
// its glow are drawn here; without it both are clipped at the window edge and
// the panel reads as a rectangle pasted onto the screen.
const GUTTER = 28;

// Chosen per platform because Alt+Space is the window menu on Windows and is not
// ours to take. Both are overridable in Settings.
const DEFAULT_HOTKEY = process.platform === 'darwin' ? 'Alt+Space' : 'Control+Alt+Space';

let overlayWindow = null;
let registeredHotkey = null;

// Whether the panel's renderer has said it is listening for events yet, and the
// show it missed if it had not.
//
// `show()` used to fire `overlay:shown` the instant the window was shown, which
// on the very first summon is before the renderer's module has run and bound its
// handler. The event went nowhere, so the panel opened idle and the microphone
// never armed — and only on the first press, which is the worst kind of bug to
// be told about, because the second press always worked.
let rendererReady = false;
let missedShow = null;

/**
 * The renderer reporting that it is bound and ready.
 * @returns {{visible: boolean, reason: string|null}} so a renderer that came up
 *   into an already-visible window can start the same way it would have on show.
 */
function markReady() {
  rendererReady = true;
  const win = get();
  const visible = !!win && win.isVisible();
  const reason = missedShow;
  missedShow = null;
  return { visible, reason: visible ? (reason || 'hotkey') : null };
}

/** The window, when there is one that has not been destroyed. */
function get() {
  return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;
}

/** True when these are the overlay's own web contents. */
function isOverlayContents(wc) {
  const win = get();
  return !!win && wc === win.webContents;
}

/**
 * Where the panel sits: against the right edge of the display holding the
 * pointer, below the menu bar.
 *
 * The display is chosen at show time rather than at creation, because a laptop
 * that was docked into a second monitor since launch should not be told that
 * the assistant lives on a screen that is no longer there.
 */
function placement(height) {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const h = Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT) + GUTTER * 2;
  const w = WIDTH + GUTTER * 2;
  return {
    x: Math.round(area.x + area.width - w - 12),
    y: Math.round(area.y + Math.min(88, Math.max(12, area.height * 0.1))),
    width: w,
    height: Math.min(h, area.height - 24),
  };
}

function create() {
  const win = new BrowserWindow({
    ...placement(MIN_HEIGHT),
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,          // the card draws its own; the OS one would box it
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,         // it is a panel, not a document
    alwaysOnTop: true,
    acceptFirstMouse: true,
    roundedCorners: false,     // the card is the shape, not the window
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,          // the preload needs require for ipcRenderer
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      spellcheck: false,
      backgroundThrottling: false,   // the animation must not stall unfocused
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  // Above ordinary windows, and above full-screen ones: a panel summoned by a
  // keystroke that then appears behind the window you pressed it over is a
  // panel that did not appear.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Clicking away dismisses it, the way every other summoned panel behaves.
  // A conversion the user has not answered yet is the one exception — losing an
  // in-progress question to a stray click would mean asking for it all over
  // again — and the renderer is what knows whether it is holding one.
  win.on('blur', () => {
    if (!get()) return;
    win.webContents.send('overlay:blurred');
  });

  // The overlay may reload itself and navigate nowhere. Same rule as the main
  // window, for the same reason.
  const ownDocument = path.join(__dirname, '..', 'renderer', 'overlay.html');
  win.webContents.on('will-navigate', (event, url) => {
    let target = null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'file:') target = decodeURIComponent(parsed.pathname).replace(/^\//, '');
    } catch { /* unparseable; refused below */ }
    if (!target || path.resolve(target).toLowerCase() !== ownDocument.toLowerCase()) {
      event.preventDefault();
      console.warn(`[security] blocked overlay navigation to ${url}`);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    overlayWindow = null;
    rendererReady = false;
    missedShow = null;
  });

  // A reload re-runs the renderer, so its handlers are gone until it says
  // otherwise. Without this, the panel survives a reload looking fine and
  // silently stops responding to being shown.
  win.webContents.on('did-start-loading', () => { rendererReady = false; });

  overlayWindow = win;
  return win;
}

/** Brings the panel up, ready to listen. */
function show({ reason = 'hotkey' } = {}) {
  const win = get() || create();
  const bounds = win.getBounds();
  win.setBounds({ ...placement(bounds.height - GUTTER * 2) });
  // The listener stops recognising while the panel is up: from here the panel's
  // own microphone is the one that matters, and the wake word firing again over
  // an open panel would be the assistant interrupting itself.
  wakeWindow.setPanelOpen(true);
  win.showInactive();
  // Shown inactive first, then focused: on macOS this is what stops the panel
  // stealing the caret from the application the user was typing in until it is
  // actually up and drawn.
  win.focus();
  if (rendererReady) {
    win.webContents.send('overlay:shown', { reason });
  } else {
    // Held until the renderer says it is listening, rather than sent into a
    // window that cannot hear it yet.
    missedShow = reason;
  }
  return true;
}

function hide() {
  const win = get();
  if (!win) return false;
  win.webContents.send('overlay:hidden');
  win.hide();
  wakeWindow.setPanelOpen(false);
  return true;
}

function toggle() {
  const win = get();
  if (win && win.isVisible()) return hide();
  return show({ reason: 'hotkey' });
}

/**
 * Resizes the window to fit the card the renderer has drawn.
 *
 * The card animates its own height in CSS, which is what makes the panel feel
 * like one thing changing shape rather than a series of dialogs. The window has
 * to follow, and the order matters: growing, the window is enlarged first so
 * the card has somewhere to expand into; shrinking, the card finishes its
 * animation first and the window closes up behind it. The renderer decides
 * which of those it is asking for.
 */
function resize(height, { immediate = false } = {}) {
  const win = get();
  if (!win) return false;
  const target = placement(Math.round(height));
  const current = win.getBounds();
  if (Math.abs(current.height - target.height) < 2 && current.x === target.x) return true;
  win.setBounds(target, process.platform === 'darwin' && !immediate);
  return true;
}

/**
 * Binds the summoning key.
 *
 * A shortcut that another application already owns cannot be registered, and
 * Electron reports that by returning false rather than by throwing. That is
 * worth surfacing: a hotkey that silently does nothing is indistinguishable
 * from a broken feature, so the caller gets told and can say so in Settings.
 *
 * @returns {{ok: boolean, hotkey: string, why: string|null}}
 */
function registerHotkey(accelerator, onTrigger) {
  const wanted = accelerator || DEFAULT_HOTKEY;
  unregisterHotkey();
  let ok = false;
  try {
    ok = globalShortcut.register(wanted, onTrigger);
  } catch (err) {
    return { ok: false, hotkey: wanted, why: err.message };
  }
  if (!ok) {
    return {
      ok: false,
      hotkey: wanted,
      why: `${wanted} is already taken by another application, so NexaFiles could not ` +
           `claim it. Choose a different shortcut in Settings.`,
    };
  }
  registeredHotkey = wanted;
  return { ok: true, hotkey: wanted, why: null };
}

function unregisterHotkey() {
  if (!registeredHotkey) return;
  try { globalShortcut.unregister(registeredHotkey); } catch { /* already gone */ }
  registeredHotkey = null;
}

function currentHotkey() {
  return registeredHotkey;
}

function destroy() {
  unregisterHotkey();
  const win = get();
  if (win) win.destroy();
  overlayWindow = null;
}

module.exports = {
  create, get, show, hide, toggle, resize, destroy, markReady,
  registerHotkey, unregisterHotkey, currentHotkey, isOverlayContents,
  DEFAULT_HOTKEY, WIDTH, MIN_HEIGHT, MAX_HEIGHT, GUTTER,
};
