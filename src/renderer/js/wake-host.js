// The listener window's only job.
//
// This module owns the wake word: it holds the microphone, drives the
// recogniser in wake.js, and tells the main process when the phrase was heard.
// It has no interface, because the window it runs in has no interface.
//
// It is driven from the main process rather than deciding for itself, which is
// the difference between this and the arrangement it replaced. Previously the
// panel's own renderer armed the wake word, which meant the feature depended on
// a window that exists to be shown and hidden, and the "is the panel open?"
// question — the one that decides whether to listen at all — had to be answered
// by watching IPC events and hoping they arrived in the right order. The main
// process already knows the answer to that question. Now it says so.

import * as wake from './wake.js';

const nexa = window.nexa;

// Whether the panel is on screen. While it is, its own microphone is the one
// that matters and this one stops recognising — the stream stays open so the
// two are not fighting over the device.
let panelOpen = false;

let armed = false;
let arming = false;

async function arm(modelUrl) {
  if (armed || arming) return { ok: true, already: true };
  if (!modelUrl) return { ok: false, why: 'no model' };
  arming = true;
  try {
    await wake.start({
      modelUrl,
      paused: () => panelOpen,
      onWake: () => { nexa.wake.heard().catch(() => {}); },
      // A block the recogniser could not take is not worth interrupting anyone
      // over, but a stream of them means something is wrong, so the first is
      // reported where a developer will see it.
      onError: (err) => console.warn('[wake]', err.message),
    });
    armed = true;
    return { ok: true };
  } catch (err) {
    console.warn('[wake] could not start:', err.message);
    return { ok: false, why: err.message };
  } finally {
    arming = false;
  }
}

function disarm() {
  wake.stop();
  armed = false;
  return { ok: true };
}

nexa.wake.onArm(async (payload) => { await arm(payload?.modelUrl); });
nexa.wake.onDisarm(() => disarm());
nexa.wake.onPanel((payload) => {
  panelOpen = !!payload?.open;
  // Exposed for the integration test, which has no other way to observe a
  // variable inside a module. Harmless: it is a boolean in a window that
  // renders nothing.
  window.__wakePanelOpen = panelOpen;
});

// Announce that the handlers above are bound, and take whatever instruction the
// main process was holding for us. Without this the very first arm — which is
// sent while this document is still parsing 5.8 MB of recogniser — would go
// nowhere, and the wake word would appear to work only after a restart.
nexa.wake.hostReady().then(async (state) => {
  panelOpen = !!state?.panelOpen;
  if (state?.arm) await arm(state.modelUrl);
}).catch(() => { /* the main process will arm us when it is ready */ });
