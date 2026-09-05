'use strict';
// The listener window.
//
// A hidden, chromeless BrowserWindow whose only occupant is the speech
// recogniser. It is created when the wake word is switched on and destroyed
// when it is switched off, which means the microphone is held open by a window
// that exists if and only if the user asked for it — there is no path by which
// this listens without the setting being on.
//
// It is separate from the overlay for a reason given in full in
// src/renderer/wake.html: the recogniser needs 'unsafe-eval', and that
// permission belongs in a document that renders nothing rather than in the
// panel that renders file names and document text.

const path = require('path');
const { BrowserWindow } = require('electron');

let win = null;
// What the renderer should be told the moment it says it is ready. The window
// takes a moment to parse the recogniser, and an instruction sent before then
// would be sent into a document that cannot hear it — the same first-run bug
// the overlay's `markReady` exists to prevent, in the same shape.
let pending = { arm: false, modelUrl: null, panelOpen: false };
let hostReady = false;

function get() {
  return win && !win.isDestroyed() ? win : null;
}

function create() {
  if (get()) return win;

  win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    frame: false,
    skipTaskbar: true,
    // Never focusable and never shown: this is a background service that
    // happens to be a window, and a window that can take focus is one that can
    // steal the caret from whatever the user is typing in.
    focusable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,             // the preload needs require for ipcRenderer
      preload: path.join(__dirname, '..', '..', '..', 'preload.js'),
      spellcheck: false,
      // The recogniser must go on running while the user is in another
      // application — which is the entire point of a wake word.
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'wake.html'));

  win.webContents.on('did-start-loading', () => { hostReady = false; });
  win.on('closed', () => { win = null; hostReady = false; });

  return win;
}

/** The renderer reporting that its handlers are bound. */
function markHostReady() {
  hostReady = true;
  return { ...pending };
}

function send(channel, payload) {
  const w = get();
  if (w && hostReady) w.webContents.send(channel, payload);
}

/**
 * Switches the wake word on.
 *
 * @param {string} modelUrl where the cached acoustic model is served
 */
function arm(modelUrl) {
  pending = { ...pending, arm: true, modelUrl };
  create();
  send('wake:arm', { modelUrl });
  return true;
}

/** Switches it off and closes the window, which closes the microphone. */
function disarm() {
  pending = { ...pending, arm: false, modelUrl: null };
  const w = get();
  if (!w) return false;
  // Destroyed rather than merely told to stop: a hidden window holding a
  // microphone open because a message went astray is exactly the failure this
  // feature cannot afford. No window, no microphone.
  w.destroy();
  win = null;
  hostReady = false;
  return true;
}

/** Tells the listener whether the panel is on screen. */
function setPanelOpen(open) {
  pending = { ...pending, panelOpen: !!open };
  send('wake:panel', { open: !!open });
  return true;
}

function isArmed() {
  return !!get() && pending.arm;
}

function destroy() {
  disarm();
}

module.exports = { create, get, arm, disarm, setPanelOpen, isArmed, markHostReady, destroy };
