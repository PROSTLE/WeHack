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
const { app, BrowserWindow, Menu, shell, session, nativeImage, dialog, nativeTheme } = require('electron');

const roots = require('./src/main/security/roots');
const { AppState } = require('./src/main/app-state');
const { register } = require('./src/main/ipc');
const { Agent } = require('./src/main/llm/agent');
const agentTools = require('./src/main/llm/tools');

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
  const isOwnWindow = (wc) => !!mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents;

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'media' && isOwnWindow(wc) && audioOnly(details)) {
      callback(true);
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

  mainWindow.on('closed', () => { mainWindow = null; });
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

  createWindow();
  register(state, mainWindow);

  // Begin recording this boot session's CPU and memory. The graph it feeds
  // covers this session only and restarts from zero after a reboot.
  state.startSession(app);

  // The assistant is optional. Without a key everything else still works.
  state.agent = new Agent({
    gemini: state.gemini,
    tools: agentTools.build(state, { app, nativeImage }),
  });

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
});
