'use strict';
// NexaFiles main process.
//
// What is deliberately absent here, compared to the previous version:
//   - No Python sidecar, no virtualenv bootstrap, no pip install on first launch.
//     The application had run `execSync` to build a venv before showing a window,
//     which blocked startup for minutes on a machine without Python. Everything
//     that process did is now done in Node.
//   - No API keys loaded from a file in the repository.

const path = require('path');
const { app, BrowserWindow, Menu, shell, session, nativeImage, dialog, nativeTheme, systemPreferences, protocol } = require('electron');

const roots = require('./src/main/security/roots');
const { AppState } = require('./src/main/app-state');
const { register } = require('./src/main/ipc');
const { Agent, OVERLAY_INSTRUCTION } = require('./src/main/llm/agent');
const agentTools = require('./src/main/llm/tools');
const overlay = require('./src/main/overlay');
const wakeModelStore = require('./src/main/wake/model-store');

// Declared before the app is ready, because Chromium fixes its scheme table at
// startup and a scheme registered later is simply not a scheme. This one serves
// exactly one file — the wake word's cached acoustic model — to the recogniser
// worker, which cannot read it over file://. See src/main/wake/model-store.js.
wakeModelStore.registerScheme(protocol);

let mainWindow = null;
let state = null;

/**
 * One copy at a time.
 *
 * Two instances would open the same SQLite index, the same quarantine manifest
 * and the same settings file, and would take turns overwriting each other's
 * work. Rather than detect that from a launcher script — window titles are a
 * poor thing to depend on — the application refuses to be started twice: the
 * second launch hands its arguments to the first and exits, and the first
 * brings its window forward, which is what the person double-clicking meant.
 *
 * The test runner sets NEXAFILES_ALLOW_MULTIPLE so that an orphaned instance
 * from a previous suite cannot silently prevent the next one from starting.
 */
const allowMultiple = process.env.NEXAFILES_ALLOW_MULTIPLE === '1';
const hasInstanceLock = allowMultiple || app.requestSingleInstanceLock();

if (!hasInstanceLock) {
  console.log('[nexafiles] already running; bringing the existing window forward.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow() {
  // The window paints its own background before the document loads. Deciding
  // the theme here, rather than in the renderer, is what stops a dark session
  // opening with a white flash.
  const dark = nativeTheme.shouldUseDarkColors;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 640,
    frame: false,
    titleBarStyle: 'hidden',
    // The porcelain ground the interface is painted on, or its dark twin.
    backgroundColor: dark ? '#0F1219' : '#EEF1F5',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,          // the preload needs `require` for ipcRenderer
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  mainWindow.webContents.openDevTools();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  Menu.setApplicationMenu(null);

  // Deny every permission but one. No camera, no geolocation, no notifications,
  // no screen capture. The single exception is the microphone, which the
  // assistant's composer uses to take a spoken question — and even that is
  // narrowed twice: the request must come from this window's own document, and
  // it must ask for audio alone. A request that also wants video is a request
  // for the camera wearing the same name, and is refused.
  //
  // Granting it here is not the whole of the consent. Chromium asks only once
  // per session, so the honest gate is the button: the microphone is opened
  // when the user presses it and closed the moment they stop, and the operating
  // system's own recording indicator stays the final word on whether it is on.
  const audioOnly = (details) => {
    const types = details?.mediaTypes;
    // An absent list is not an implicit "audio". Only an explicit audio-and-
    // nothing-else request qualifies.
    return Array.isArray(types) && types.length > 0 && types.every((t) => t === 'audio');
  };
  // The overlay is one of ours as much as the main window is: it is the panel
  // the microphone button now mostly lives in, and refusing it would leave the
  // feature working only in the window the user was not looking at.
  // The listener window is one of ours too, and it is the one that most needs
  // this: it exists solely to hold a microphone for the wake word. It is
  // created only when that setting is on, so granting it here cannot open a
  // microphone the user did not ask for.
  const wakeWindowModule = require('./src/main/wake/window');
  const isOwnWindow = (wc) => {
    if (!!mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents) return true;
    if (overlay.isOverlayContents(wc)) return true;
    const listener = wakeWindowModule.get();
    return !!listener && wc === listener.webContents;
  };

  session.defaultSession.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (permission === 'media' && isOwnWindow(wc) && audioOnly(details)) {
      // On macOS the permission must go through systemPreferences.askForMediaAccess
      // so the OS raises the TCC dialog and adds the app to Privacy → Microphone.
      // Calling callback(true) directly bypasses that gate entirely.
      if (process.platform === 'darwin') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        callback(granted);
      } else {
        callback(true);
      }
      return;
    }
    console.warn(`[security] denied permission request: ${permission}`);
    callback(false);
  });

  // The check handler answers `navigator.permissions.query` and decides whether
  // device labels are visible to `enumerateDevices`. It mirrors the rule above,
  // with the same audio-only narrowing — here the media type arrives singular.
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => {
    if (permission === 'media' && isOwnWindow(wc) && details?.mediaType === 'audio') return true;
    return false;
  });

  // The renderer may reload itself, and nothing else. Navigating to any other
  // document — remote or local — is either a bug or an attack, so it is refused.
  const appDocument = path.join(__dirname, 'src', 'renderer', 'index.html');
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let target = null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'file:') target = decodeURIComponent(parsed.pathname).replace(/^\//, '');
    } catch { /* unparseable; treated as foreign below */ }

    const isOwnDocument = target &&
      path.resolve(target).toLowerCase() === appDocument.toLowerCase();

    if (!isOwnDocument) {
      event.preventDefault();
      console.warn(`[security] blocked navigation to ${url}`);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // External links open in the real browser, never in an app window.
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // `window-all-closed` no longer fires once the overlay exists: it is a
    // window, it is hidden rather than closed, and it keeps the count above
    // zero forever. Closing the visible window is still the user asking to
    // quit, and without this the application would go on running with nothing
    // on screen and no tray icon to close it from — the exact windowless
    // process `reportFatal` exists to prevent.
    if (process.platform !== 'darwin') app.quit();
  });
}

/**
 * Startup failed before a window existed.
 *
 * Without this the process stayed alive with no window and no message — three
 * background processes and nothing on screen, which is the worst possible way
 * for an application to fail. Now the reason is shown and the app exits.
 */
function reportFatal(err) {
  console.error('[nexafiles] startup failed:', err);
  try {
    dialog.showErrorBox(
      'NexaFiles could not start',
      `${err.message}

` +
      `The file index lives in:
${app.getPath('userData')}

` +
      `If this persists, closing NexaFiles and renaming nexafiles_index.db in ` +
      `that folder will let the application rebuild it. Nothing on your disk ` +
      `outside that folder is affected.`
    );
  } catch { /* dialog unavailable; the console message is all we have */ }
  app.exit(1);
}

/**
 * Brings up the overlay and binds its summoning key.
 *
 * The window is created now rather than on first use: a panel that has to boot a
 * renderer before it can appear would take a second to answer a keystroke, and
 * the whole point of it is that it is there the instant it is asked for. It
 * stays hidden until then and costs one idle renderer.
 *
 * A hotkey another application already owns cannot be claimed, and that is
 * reported rather than swallowed — a shortcut that silently does nothing is
 * indistinguishable from a feature that does not work.
 */
function startOverlay() {
  const prefs = state.settings.values.overlay || {};
  if (!prefs.enabled) {
    console.log('[nexafiles] overlay disabled in settings.');
    return;
  }

  overlay.create();
  const bound = overlay.registerHotkey(prefs.hotkey, () => overlay.toggle());
  if (bound.ok) {
    console.log(`[nexafiles] overlay ready. Press ${bound.hotkey} anywhere to open it.`);
  } else {
    console.warn(`[nexafiles] ${bound.why}`);
  }
  return bound;
}

app.whenReady().then(async () => {
  // Losing the single-instance lock means another copy owns the index; this
  // process is on its way out and must not touch anything on the way.
  if (!hasInstanceLock) return;

  // The user's home directory is the one root approved by launching the app.
  // Everything else must be chosen explicitly through the directory picker.
  roots.approveDefaultRoots();

  state = new AppState({
    userDataDir: app.getPath('userData'),
    trashItem: (p) => shell.trashItem(p),
  });
  await state.init();

  // Applied before the window exists, so the very first frame is the right
  // colour rather than the right colour a moment later.
  nativeTheme.themeSource = state.settings.values.theme;

  if (state.index.migratedFromV1) {
    console.log(
      `[nexafiles] upgraded an older file index. The previous one was kept as ` +
      `"${state.index.migratedFromV1}". Run a scan to rebuild the index.`
    );
  }

  // Serving the cached model has to be in place before any renderer asks for
  // it, which the overlay does as soon as the wake word is switched on.
  state.wakeModel.registerProtocol(protocol);

  createWindow();
  register(state, mainWindow);

  // Begin recording this boot session's CPU and memory. The graph it feeds
  // covers this session only and restarts from zero after a reboot.
  state.startSession(app);

  // The assistant is optional. Without a key everything else still works.
  //
  // Its tools carry the same progress hook the overlay's do. A question that
  // sends the assistant through four hundred documents takes tens of seconds,
  // and a panel showing an unchanging "Thinking…" for that long is a panel the
  // user reasonably concludes has hung.
  state.agent = new Agent({
    gemini: state.gemini,
    label: 'panel',
    tools: agentTools.build(state, {
      app,
      nativeImage,
      onStage: (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:stage', payload);
        }
      },
    }),
  });

  // The overlay's agent. Same tools, same gate, its own conversation and its own
  // instruction — the panel is for considered answers and the overlay is for one
  // thing done now, and one instruction cannot be good at both. Its tools carry
  // a progress hook so the panel can say "reading your documents" while it is.
  state.overlayAgent = new Agent({
    gemini: state.gemini,
    systemInstruction: OVERLAY_INSTRUCTION,
    label: 'overlay',
    tools: agentTools.build(state, {
      app,
      nativeImage,
      onStage: (payload) => {
        const win = overlay.get();
        if (win) win.webContents.send('overlay:stage', payload);
      },
    }),
  });

  startOverlay();

  // The wake word, if it is switched on and its model is here. This is the only
  // place it is started, and it is started from the settings rather than from a
  // flag held anywhere else — see applyWakeSetting in src/main/ipc/index.js.
  await register.applyWakeSetting?.().then((r) => {
    if (r?.armed) console.log('[nexafiles] listening for "Hey Nexa" — on this machine, nothing is sent anywhere.');
    else if (r?.why === 'no model') console.log('[nexafiles] "Hey Nexa" is on but its speech model is not downloaded; enable it in Settings.');
  }).catch((err) => console.warn('[wake]', err.message));

  const keyStatus = state.gemini.status();
  console.log(
    `[nexafiles] ready. assistant: ${keyStatus.configured
      ? `${keyStatus.keyCount} key(s) configured`
      : 'no API key configured (local features unaffected)'}`
  );
}).catch(reportFatal);

// A rejection anywhere in startup must not leave a windowless process running.
process.on('unhandledRejection', (err) => {
  if (!mainWindow) reportFatal(err instanceof Error ? err : new Error(String(err)));
  else console.error('[nexafiles] unhandled rejection:', err);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});


app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  state?.close();
  // The listener holds a microphone. It goes first, and unconditionally.
  require('./src/main/wake/window').destroy();
  // A global shortcut outlives the window that registered it. Releasing it here
  // is what stops a killed instance from holding the key hostage for the next one.
  overlay.destroy();
});

app.on('will-quit', () => overlay.unregisterHotkey());
