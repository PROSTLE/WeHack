'use strict';
// IPC surface.
//
// Every handler that touches a path calls `roots.assertInsideRoot` first. The
// renderer can name any path it likes; if it is not inside a root the user
// approved, the call is refused. This closes the hole where a compromised
// renderer had the whole filesystem available to it.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const { ipcMain, dialog, shell, app, nativeImage, nativeTheme, screen, powerMonitor } = require('electron');
const roots = require('../security/roots');
const { Plan, CATEGORY, ACTION, CONFIDENCE } = require('../safety/plan');
const { safeMove, uniqueDestination, measure, copyPath } = require('../safety/fsops');
const { classifyPath, classifyMagic } = require('../classify/rules');
const browse = require('../fs/browse');
const attachments = require('../llm/attachments');
const converter = require('../convert');
const voice = require('../llm/voice');
const duplicates = require('../scanners/duplicates');
const contentDupes = require('../scanners/content-dupes');
const { findLeftovers, leftoversToPlanEntries } = require('../scanners/leftovers');
const { listStartupItems } = require('../scanners/startup');
const metrics = require('../system/metrics');
const drives = require('../system/drives');
const machine = require('../system/machine');
const { listProcesses, sampleCpuByProcess } = require('../system/processes');
const sessionInfo = require('../system/session');
const overlay = require('../overlay');

/** Wraps a handler so a thrown error crosses IPC as a structured failure. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || null };
    }
  });
}

function register(state, mainWindow) {
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  // ── window ───────────────────────────────────────────────────────────────
  ipcMain.on('win:minimize', () => mainWindow?.minimize());
  ipcMain.on('win:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize();
  });
  ipcMain.on('win:close', () => mainWindow?.close());

  // ── roots and locations ──────────────────────────────────────────────────
  handle('roots:list', async () => ({
    roots: roots.listRoots(),
    protectedPaths: roots.getUserProtected(),
  }));

  handle('roots:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Choose a folder for NexaFiles to scan',
      buttonLabel: 'Approve this folder',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const approved = roots.approveRoot(result.filePaths[0]);
    state.saveApprovedRoots();
    return { path: approved };
  });

  /**
   * Picks a folder without granting anything.
   *
   * `roots:choose` approves what it picks, which is right for "scan this" and
   * wrong for "never touch this". Protecting a folder must not be the act that
   * makes it reachable.
   */
  handle('roots:pick', async (title) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: String(title || 'Choose a folder'),
      buttonLabel: 'Choose',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return { path: result.filePaths[0] };
  });

  handle('roots:approve', async (dirPath) => {
    const approved = roots.approveRoot(dirPath);
    state.saveApprovedRoots();
    return { path: approved, roots: roots.listRoots() };
  });

  handle('roots:revoke', async (dirPath) => {
    roots.revokeRoot(dirPath);
    state.saveApprovedRoots();
    return true;
  });
  handle('roots:setProtected', async (list) => state.saveProtectedPaths(list || []));

  handle('locations:drives', async () => drives.listDrives());
  handle('locations:folders', async () => drives.specialFolders());
  handle('locations:home', async () => os.homedir());

  // ── browsing ─────────────────────────────────────────────────────────────
  handle('fs:readDirectory', async (dirPath) => {
    const safe = roots.assertInsideRoot(dirPath, { mustExist: true });
    const entries = await fsp.readdir(safe, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      const full = path.join(safe, e.name);
      try {
        const st = await fsp.lstat(full);
        const c = classifyPath(full, { isDirectory: e.isDirectory() });
        out.push({
          name: e.name,
          path: full,
          isDirectory: e.isDirectory(),
          isSymlink: st.isSymbolicLink(),
          size: st.size,
          mtimeMs: st.mtimeMs,
          atimeMs: st.atimeMs,
          extension: path.extname(e.name).slice(1).toLowerCase() || null,
          type: c.type,
          category: c.category,
        });
      } catch { /* unreadable entry; omit rather than guess at its properties */ }
    }
    return out;
  });

  handle('fs:stat', async (filePath) => {
    const safe = roots.assertInsideRoot(filePath, { mustExist: true });
    const st = await fsp.stat(safe);
    return {
      path: safe, size: st.size, isDirectory: st.isDirectory(),
      mtimeMs: st.mtimeMs, atimeMs: st.atimeMs, birthMs: st.birthtimeMs, mode: st.mode,
    };
  });

  handle('fs:measure', async (dirPath) => {
    const safe = roots.assertInsideRoot(dirPath, { mustExist: true });
    return measure(safe);
  });

  handle('fs:readHead', async (filePath, bytes = 4096) => {
    const safe = roots.assertInsideRoot(filePath, { mustExist: true });
    const cap = Math.min(Math.max(1, bytes | 0), 65536);
    const fd = await fsp.open(safe, 'r');
    try {
      const buf = Buffer.alloc(cap);
      const { bytesRead } = await fd.read(buf, 0, cap, 0);
      const head = buf.subarray(0, bytesRead);
      const magic = classifyMagic(head, safe);
      // Only return text when the content is plausibly text.
      const isBinary = head.subarray(0, Math.min(1024, bytesRead)).includes(0);
      return {
        bytesRead,
        magic,
        text: isBinary ? null : head.toString('utf8'),
        binary: isBinary,
      };
    } finally {
      await fd.close();
    }
  });

  handle('fs:openNative', async (filePath) => {
    const safe = roots.assertInsideRoot(filePath, { mustExist: true });
    const err = await shell.openPath(safe);
    if (err) throw new Error(err);
    return true;
  });

  handle('fs:revealNative', async (filePath) => {
    const safe = roots.assertInsideRoot(filePath, { mustExist: true });
    shell.showItemInFolder(safe);
    return true;
  });

  handle('fs:createFolder', async (parentDir, name) => {
    const safeParent = roots.assertInsideRoot(parentDir, { mustExist: true });
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('That folder name is not valid.');
    const target = roots.assertInsideRoot(path.join(safeParent, name));
    await fsp.mkdir(target, { recursive: false });
    return { path: target };
  });

  handle('fs:rename', async (oldPath, newName) => {
    const safe = roots.assertInsideRoot(oldPath, { mustExist: true });
    if (!newName || /[\\/:*?"<>|]/.test(newName)) throw new Error('That name is not valid.');
    const target = roots.assertInsideRoot(path.join(path.dirname(safe), newName));
    await fsp.rename(safe, target);
    return { path: target };
  });

  // Cross-filesystem safe: rename first, copy-verify-delete on EXDEV.
  handle('fs:move', async (sourcePath, destDir) => {
    const safeSource = roots.assertInsideRoot(sourcePath, { mustExist: true });
    const safeDest = roots.assertInsideRoot(destDir, { mustExist: true });
    const target = await uniqueDestination(safeDest, path.basename(safeSource));
    const result = await safeMove(safeSource, target);
    return { path: target, method: result.method };
  });

  // ── files view ───────────────────────────────────────────────────────────
  //
  // A file manager asks a different question of the security layer than the
  // scanner does. The scanner is handed a root and works inside it; the Files
  // view is pointed at wherever the user clicked and has to be able to say
  // "you have not given me access to D:\ yet, here is the button that does"
  // rather than throwing an error the user did not cause. That is why these
  // handlers report `access` instead of refusing outright — but nothing is
  // read until `assertInsideRoot` has passed, exactly as before.

  const deniedBy = (p) => roots.isDenied(roots.normalize(p));

  // Enumerating volumes means spawning PowerShell, which costs about 700 ms.
  // The sidebar re-renders whenever a tree branch opens, a root changes or a
  // plan runs, and paying that three times to redraw the same two drives made
  // the sidebar feel broken. The list is held for a few seconds and dropped
  // the moment anything could have changed it.
  const DRIVE_CACHE_MS = 5000;
  let driveCache = { at: 0, list: null };

  const listDrivesCached = async ({ force = false } = {}) => {
    const fresh = Date.now() - driveCache.at < DRIVE_CACHE_MS;
    if (!force && fresh && driveCache.list) return driveCache.list;
    try {
      driveCache = { at: Date.now(), list: await drives.listDrives() };
    } catch {
      driveCache = { at: Date.now(), list: driveCache.list || [] };
    }
    return driveCache.list;
  };

  /** Called wherever free space could have changed under us. */
  const invalidateDrives = () => { driveCache.at = 0; };

  /** Everything the sidebar shows: drives, user folders, and access to each. */
  handle('explorer:places', async ({ force = false } = {}) => {
    const [driveList, folders] = await Promise.all([
      listDrivesCached({ force }),
      Promise.resolve(drives.specialFolders()),
    ]);
    const withAccess = (name, p, extra = {}) => ({
      name, path: p, access: roots.accessFor(p), ...extra,
    });
    // Home is returned on its own so the sidebar can head the list with it;
    // leaving it in `folders` as well would list it twice.
    const homePath = os.homedir().toLowerCase();
    return {
      home: withAccess('Home', os.homedir()),
      folders: folders
        .filter((f) => f.path.toLowerCase() !== homePath)
        .map((f) => withAccess(f.name, f.path)),
      drives: driveList.map((d) => withAccess(d.name, d.path, {
        id: d.id,
        label: d.name,
        totalBytes: d.totalBytes,
        freeBytes: d.freeBytes,
        usedBytes: d.usedBytes,
        fileSystem: d.fileSystem,
        removable: d.removable,
      })),
      roots: roots.listRoots(),
    };
  });

  /**
   * Lists a directory for the Files view.
   *
   * Returns `{ access, entries }`. When access has not been granted the reply
   * carries the reason and no contents — the directory is not read at all.
   */
  handle('explorer:list', async (dirPath) => {
    const target = String(dirPath || '');
    const access = roots.accessFor(target);
    if (!access.allowed) {
      // "You have not approved this" and "this is not there" are different
      // answers, and offering to grant access to a drive that has been
      // unplugged is the wrong one. Existence is checked only once access has
      // already been refused, so this adds nothing to the normal path.
      const missing = access.reason === 'outside' && !fs.existsSync(path.resolve(target));
      return {
        path: path.resolve(target),
        parent: browse.parentOf(target),
        segments: browse.pathSegments(target),
        access: missing ? { ...access, reason: 'missing' } : access,
        entries: null,
        counts: null,
      };
    }
    const safe = roots.assertInsideRoot(target, { mustExist: true });
    const listing = await browse.listDirectory(safe, { isDenied: deniedBy });
    return { ...listing, access };
  });

  /** Immediate subfolders, for expanding a branch of the sidebar tree. */
  handle('explorer:subfolders', async (dirPath) => {
    const access = roots.accessFor(String(dirPath || ''));
    if (!access.allowed) return { access, folders: null };
    const safe = roots.assertInsideRoot(dirPath, { mustExist: true });
    return { access, folders: await browse.listSubfolders(safe, { isDenied: deniedBy }) };
  });

  /**
   * The icon Windows itself shows for a file, as a data URL.
   *
   * This is what makes an installer look like its own installer and a shortcut
   * look like what it points at. It is read from the shell, not guessed from
   * the extension, and returns null rather than a placeholder when the shell
   * has nothing for it.
   */
  handle('explorer:icon', async (filePath) => {
    const safe = roots.assertInsideRoot(filePath, { mustExist: true });
    try {
      const image = await app.getFileIcon(safe, { size: 'normal' });
      if (!image || image.isEmpty()) return null;
      return image.toDataURL();
    } catch {
      return null;
    }
  });

  /** A real thumbnail of the file's contents, where the platform can make one. */
  handle('explorer:thumbnail', async (filePath, size = 96) => {
    const safe = roots.assertInsideRoot(filePath, { mustExist: true });
    const px = Math.min(Math.max(32, size | 0), 512);
    try {
      const image = await nativeImage.createThumbnailFromPath(safe, { width: px, height: px });
      if (!image || image.isEmpty()) return null;
      return image.toDataURL();
    } catch {
      // No thumbnail provider for this type. The icon is the honest fallback.
      return null;
    }
  });

  /**
   * Creates a folder and returns where it landed.
   *
   * Explorer names it "New folder", then "New folder (2)", and puts the name
   * straight into edit. It does not ask first, and neither does this — partly
   * because that is the flow people expect, and partly because Electron has no
   * `window.prompt` to ask with.
   */
  handle('explorer:newFolder', async (parentDir) => {
    const safeParent = roots.assertInsideRoot(parentDir, { mustExist: true });
    const target = await uniqueDestination(safeParent, 'New folder');
    roots.assertInsideRoot(target);
    await fsp.mkdir(target);
    return { path: target, name: path.basename(target) };
  });

  /**
   * Opens a file with whatever the system associates with it.
   *
   * Documents are handed straight over. A program is not: running an executable
   * is the one thing a file manager does that cannot be undone, so it is
   * confirmed first, in a system dialog the renderer cannot forge or suppress.
   */
  handle('explorer:open', async (filePath) => {
    const safe = roots.assertInsideRoot(filePath, { mustExist: true });
    const st = await fsp.stat(safe);
    if (st.isDirectory()) {
      const err = new Error('That is a folder. Open it in the Files view instead.');
      err.code = 'IS_DIRECTORY';
      throw err;
    }

    if (browse.isExecutable(safe)) {
      // A shortcut is whatever it points at, so say what that is rather than
      // asking about the .lnk itself.
      let target = null;
      if (path.extname(safe).toLowerCase() === '.lnk') {
        try { target = shell.readShortcutLink(safe).target; } catch { /* unreadable */ }
      }
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Run it', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Run this program?',
        message: `Run ${path.basename(target || safe)}?`,
        detail: `${safe}${target ? `\n\nThis shortcut points at:\n${target}` : ''}\n\n` +
                `Windows will execute this file. Opening a document shows you its ` +
                `contents; running a program lets it do anything you can do. ` +
                `NexaFiles is asking because it cannot tell you what this one will do.`,
      });
      if (response !== 0) return { opened: false, cancelled: true, path: safe };
    }

    const failure = await shell.openPath(safe);
    if (failure) throw new Error(failure);
    return { opened: true, cancelled: false, path: safe };
  });

  /** Shows the item where it lives, in the system's own file manager. */
  handle('explorer:reveal', async (filePath) => {
    const safe = roots.assertInsideRoot(filePath, { mustExist: true });
    shell.showItemInFolder(safe);
    return true;
  });

  /**
   * Deletes to the system trash. Nothing here bypasses it.
   *
   * Each path is reported separately: one locked file must not stop the rest,
   * and the user is told exactly which ones did not go.
   */
  handle('explorer:trash', async (paths) => {
    const results = [];
    for (const p of (paths || []).slice(0, 500)) {
      try {
        const safe = roots.assertInsideRoot(p, { mustExist: true });
        // An approved root is the thing granting access to its own contents.
        // Deleting it from inside the file manager is refused.
        if (roots.listRoots().includes(roots.normalize(safe))) {
          throw new Error('This folder is one of NexaFiles\u2019 approved roots. ' +
                          'Remove it as a root first if you really mean to delete it.');
        }
        await shell.trashItem(safe);
        results.push({ path: p, ok: true });
      } catch (err) {
        results.push({ path: p, ok: false, error: err.message });
      }
    }
    invalidateDrives();
    return { results, trashed: results.filter((r) => r.ok).length };
  });

  /** Copies into a folder, never over anything: collisions get " (2)". */
  handle('explorer:copy', async (paths, destDir) => {
    const safeDest = roots.assertInsideRoot(destDir, { mustExist: true });
    const results = [];
    for (const p of (paths || []).slice(0, 500)) {
      try {
        const safe = roots.assertInsideRoot(p, { mustExist: true });
        if (roots.isWithin(roots.normalize(safe), roots.normalize(safeDest))) {
          throw new Error('A folder cannot be copied into itself.');
        }
        const target = await uniqueDestination(safeDest, path.basename(safe));
        const stats = await copyPath(safe, target);
        results.push({ path: p, ok: true, to: target, ...stats });
      } catch (err) {
        results.push({ path: p, ok: false, error: err.message });
      }
    }
    invalidateDrives();
    return { results, copied: results.filter((r) => r.ok).length };
  });

  /** Moves into a folder. Cross-volume moves copy, verify, then remove. */
  handle('explorer:move', async (paths, destDir) => {
    const safeDest = roots.assertInsideRoot(destDir, { mustExist: true });
    const results = [];
    for (const p of (paths || []).slice(0, 500)) {
      try {
        const safe = roots.assertInsideRoot(p, { mustExist: true });
        if (roots.isWithin(roots.normalize(safe), roots.normalize(safeDest))) {
          throw new Error('A folder cannot be moved into itself.');
        }
        if (roots.normalize(path.dirname(safe)) === roots.normalize(safeDest)) {
          throw new Error('It is already in that folder.');
        }
        const target = await uniqueDestination(safeDest, path.basename(safe));
        const moved = await safeMove(safe, target);
        results.push({ path: p, ok: true, to: target, method: moved.method });
      } catch (err) {
        results.push({ path: p, ok: false, error: err.message });
      }
    }
    return { results, moved: results.filter((r) => r.ok).length };
  });

  /**
   * Size, dates and attributes for one item.
   *
   * A folder's size is the sum of what is inside it, which means walking it.
   * That is why it is measured on request rather than in every listing: Explorer
   * leaves the Size column blank for folders for the same reason.
   */
  handle('explorer:properties', async (targetPath, { deep = false } = {}) => {
    const safe = roots.assertInsideRoot(targetPath, { mustExist: true });
    const st = await fsp.lstat(safe);
    const isDirectory = st.isDirectory();
    const c = classifyPath(safe, { isDirectory });
    const out = {
      path: safe,
      name: path.basename(safe) || safe,
      isDirectory,
      isSymlink: st.isSymbolicLink(),
      size: isDirectory ? null : st.size,
      mtimeMs: st.mtimeMs,
      atimeMs: st.atimeMs,
      birthMs: st.birthtimeMs,
      readOnly: !(st.mode & 0o200),
      type: c.type,
      category: c.category,
      typeLabel: browse.typeLabel({ isDirectory, extension: path.extname(safe).slice(1).toLowerCase() || null }),
      executable: !isDirectory && browse.isExecutable(safe),
      contents: null,
    };
    if (isDirectory && deep) out.contents = await measure(safe);
    return out;
  });

  // ── settings ─────────────────────────────────────────────────────────────
  //
  // Every control in the Settings view maps to one of these. There is no
  // preference in the interface that is not stored, applied, and readable back
  // — a toggle that looks like a setting but changes nothing is worse than no
  // toggle at all.

  /** Applies the theme choice to the window and the OS-level hint. */
  const applyTheme = (choice) => {
    nativeTheme.themeSource = choice;                    // 'system' | 'light' | 'dark'
    const dark = nativeTheme.shouldUseDarkColors;
    // The window's own background shows during a resize and before the first
    // paint. Leaving it porcelain in dark mode produces a white flash.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(dark ? '#0F1219' : '#EEF1F5');
    }
    return dark;
  };

  // The result of the most recent attempt to claim the summoning key, so both
  // Settings and the overlay itself can report a chord that could not be bound.
  let overlayHotkey = { ok: true, hotkey: overlay.currentHotkey(), why: null };

  const settingsPayload = () => ({
    ...state.settings.forRenderer(),
    overlayHotkeyBound: { ...overlayHotkey, hotkey: overlay.currentHotkey() || overlayHotkey.hotkey },
    effective: {
      dark: nativeTheme.shouldUseDarkColors,
      systemDark: nativeTheme.shouldUseDarkColors && nativeTheme.themeSource === 'system',
      source: nativeTheme.themeSource,
    },
    assistantKeySource: state.keySource,
  });

  handle('settings:get', async () => settingsPayload());

  handle('settings:set', async (patch) => {
    const before = state.settings.values;
    state.settings.update(patch || {});
    const after = state.settings.values;

    if (after.theme !== before.theme || (patch && patch.theme)) applyTheme(after.theme);

    if (patch && patch.assistant) {
      if ('keys' in patch.assistant) {
        if (after.assistant.keys.length) {
          state.gemini.setKeys(after.assistant.keys);
          state.keySource = 'settings';
        } else {
          // Cleared: fall back to whatever the environment or config file has.
          const fallback = require('../llm/gemini').GeminiClient.fromEnvironment(() => {
            const cfg = path.join(__dirname, '..', '..', '..', 'config.js');
            return fs.existsSync(cfg) ? require(cfg) : null;
          });
          state.gemini.setKeys(fallback.keys);
          state.keySource = fallback.keys.length
            ? (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY ? 'environment' : 'config file')
            : null;
        }
      }
      if ('model' in patch.assistant) state.gemini.setModel(after.assistant.model);
    }

    // The overlay's key is claimed from the operating system, so a change has to
    // be applied now rather than at the next launch — and whether the claim
    // succeeded is part of the answer, because another application may already
    // hold that chord and the user needs to be told rather than left pressing a
    // key that does nothing.
    if (patch && patch.overlay) {
      if (after.overlay.enabled) {
        if (!overlay.get()) overlay.create();
        overlayHotkey = overlay.registerHotkey(after.overlay.hotkey, () => overlay.toggle());
      } else {
        overlay.destroy();
        overlayHotkey = { ok: false, hotkey: after.overlay.hotkey, why: 'The overlay is switched off.' };
      }
    }

    // Both windows are told. The overlay reads three of these — whether it is
    // enabled, whether it listens on open, and whether it is listening for the
    // wake phrase — and a change that only took effect at the next launch would
    // be a switch that appears to do nothing.
    const payload = settingsPayload();
    send('settings:changed', payload);
    const overlayWindow = overlay.get();
    if (overlayWindow) overlayWindow.webContents.send('settings:changed', payload);
    return payload;
  });

  // The OS theme can change while the app is open; when the choice is "match
  // the system", the interface has to follow it without being asked.
  nativeTheme.on('updated', () => {
    send('theme:changed', {
      dark: nativeTheme.shouldUseDarkColors,
      source: nativeTheme.themeSource,
    });
  });

  // ── this machine ─────────────────────────────────────────────────────────
  handle('system:machine', async () => machine.describe({
    app,
    screen,
    powerMonitor,
    browserWindow: mainWindow,
    // "Measure again" has to mean it, so this path never reads the cache.
    drives: { listDrives: () => listDrivesCached({ force: true }) },
  }));

  /** What NexaFiles itself is storing, and where. */
  handle('system:storage', async () => {
    const userData = app.getPath('userData');
    const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return null; } };
    const quarantine = state.quarantine.list();
    return {
      userData,
      index: {
        path: path.join(userData, 'nexafiles_index.db'),
        bytes: sizeOf(path.join(userData, 'nexafiles_index.db')),
        scans: state.index.listScans().length,
      },
      quarantine: {
        path: path.join(userData, 'quarantine'),
        items: quarantine.length,
        bytes: state.quarantine.totalBytes(),
      },
      settings: {
        path: state.settings.file,
        bytes: sizeOf(state.settings.file),
      },
      approvedRoots: {
        path: state.approvedRootsFile,
        count: roots.listRoots().length,
      },
    };
  });

  /** Opens NexaFiles' own data folder. It is the only path this can open. */
  handle('system:openUserData', async () => {
    const failure = await shell.openPath(app.getPath('userData'));
    if (failure) throw new Error(failure);
    return true;
  });

  // ── scanning ─────────────────────────────────────────────────────────────
  handle('scan:start', async (root) => {
    const safe = roots.assertInsideRoot(root, { mustExist: true });
    // Reset derived results: they describe the previous scan, not this one.
    state.lastDuplicates = { exact: null, image: null, text: null, video: null };
    state.lastLeftovers = null;

    const scan = await state.scanner.start(safe, (p) => send('scan:progress', p));
    send('scan:complete', scan);
    return scan;
  });

  handle('scan:cancel', async () => state.scanner.cancel());
  handle('scan:current', async () => state.currentScan());
  handle('scan:list', async () => state.index.listScans());

  handle('scan:composition', async (scanId, under) => {
    const scan = scanId ? state.index.getScan(scanId) : state.currentScan();
    if (!scan) return null;
    const dir = under || scan.root;
    return {
      scan,
      categories: state.index.categoryTotals(scan.id),
      children: state.index.childrenWithRollup(scan.id, dir),
      rollup: state.index.rollupFor(scan.id, dir),
      under: dir,
    };
  });

  handle('scan:files', async ({ scanId, under, category, limit, offset }) => {
    const scan = scanId ? state.index.getScan(scanId) : state.currentScan();
    if (!scan) return { files: [], total: 0 };
    const opts = {
      under: under || null, category: category || null,
      limit: Math.min(Math.max(1, limit || 200), 1000), offset: offset || 0,
    };
    return {
      files: state.index.largestFiles(scan.id, opts),
      total: state.index.countFiles(scan.id, { under: opts.under, category: opts.category }),
    };
  });

  // ── duplicates ───────────────────────────────────────────────────────────
  handle('duplicates:find', async (tier) => {
    const scan = state.currentScan();
    if (!scan) throw new Error('No scan has run yet. Scan a folder first.');
    const onProgress = (p) => send('scan:progress', { ...p, scanId: scan.id });

    let out;
    if (tier === 'image') {
      out = await duplicates.findSimilarImages(state.index, scan.id, nativeImage, { onProgress });
      state.lastDuplicates.image = out;
    } else if (tier === 'text') {
      // Documents go through real format parsing now, not a raw byte read.
      out = await contentDupes.findSimilarDocuments(
        state.index, scan.id,
        { simHash: duplicates.simHash, hamming64: duplicates.hamming64 },
        { onProgress });
      state.lastDuplicates.text = out;
    } else if (tier === 'video') {
      out = await contentDupes.findVideoDuplicates(state.index, scan.id, { onProgress });
      state.lastDuplicates.video = out;
    } else {
      out = await duplicates.findExactDuplicates(state.index, scan.id, { onProgress });
      state.lastDuplicates.exact = out;
    }

    state.index.clearDuplicates(scan.id, tierName(tier));
    for (const g of out.groups) state.index.saveDuplicateGroup(scan.id, g);

    return {
      tier: tierName(tier),
      groups: out.groups,
      stats: out.stats,
      totalWasted: out.groups.reduce((n, g) => n + g.wastedBytes, 0),
      method: methodDescription(tier),
    };
  });

  // ── leftovers ────────────────────────────────────────────────────────────
  handle('leftovers:find', async () => {
    const out = await findLeftovers({
      listProcesses,
      onProgress: (p) => send('scan:progress', p),
    });
    state.lastLeftovers = out;
    return out;
  });

  // ── startup and system ───────────────────────────────────────────────────
  handle('startup:list', async () => {
    state.lastStartup = await listStartupItems();
    return state.lastStartup;
  });

  handle('system:load', async () => {
    const [cpu, memory] = await Promise.all([metrics.sampleCpu(500), metrics.readMemory()]);
    return {
      cpu, memory,
      loadAverage: metrics.readLoadAverage(),
      own: metrics.readOwnFootprint(app),
      info: metrics.systemInfo(),
    };
  });

  handle('system:processes', async () => {
    const list = await listProcesses();
    return list.sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 100);
  });

  handle('system:processCpu', async () => sampleCpuByProcess(1000));

  // Uptime, as Task Manager reports it. Counts time asleep, because the machine
  // was still on during it.
  handle('system:uptime', async () => sessionInfo.uptime());

  // The current boot session's recorded CPU and memory series.
  handle('system:session', async () => {
    if (!state.session) {
      return { points: [], coverage: { sampleCount: 0 }, recording: false,
               note: 'Session recording has not started.' };
    }
    return { ...state.session.series(), uptime: sessionInfo.uptime() };
  });

  // Everything the overview's summary strip needs, measured, in one round trip.
  handle('overview:summary', async () => {
    const scan = state.currentScan();
    const [drivesList, memory] = await Promise.all([
      drives.listDrives().catch(() => []),
      metrics.readMemory(),
    ]);

    if (!scan) {
      return { scan: null, drives: drivesList, memory, uptime: sessionInfo.uptime() };
    }

    const categories = state.index.categoryTotals(scan.id);
    const previous = state.index.previousScan(scan.id);

    // Deltas are only reported when there is an earlier scan of the same root to
    // compare against. Without one there is no change to state, so none is shown.
    let deltas = null;
    if (previous) {
      const prevCats = Object.fromEntries(
        state.index.categoryTotals(previous.id).map((c) => [c.category, c.bytes])
      );
      deltas = {
        since: previous.finishedAt,
        total: scan.totalBytes - previous.totalBytes,
        byCategory: Object.fromEntries(
          categories.map((c) => [c.category, c.bytes - (prevCats[c.category] || 0)])
        ),
      };
    }

    return {
      scan,
      previous: previous ? { id: previous.id, finishedAt: previous.finishedAt } : null,
      deltas,
      categories,
      drives: drivesList,
      memory,
      uptime: sessionInfo.uptime(),
      activityByMonth: state.index.fileActivityByMonth(scan.id, 12),
      categoryByMonth: state.index.categoryActivityByMonth(scan.id, 12),
      categoryByYear: state.index.categoryByYear(scan.id, 3),
      recent: state.index.recentlyModified(scan.id, 10),
      quarantineBytes: state.quarantine.totalBytes(),
    };
  });

  handle('profile:get', async () => {
    const os = require('os');
    const info = os.userInfo();
    return {
      username: info.username,
      homedir: info.homedir,
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      // Initials for a generated avatar. No photograph, no fetched image.
      initials: (info.username || '?')
        .replace(/[^a-zA-Z0-9 ._-]/g, '')
        .split(/[ ._-]+/).filter(Boolean).slice(0, 2)
        .map((w) => w[0].toUpperCase()).join('') || '?',
      approvedRoots: roots.listRoots().length,
    };
  });

  // ── plans ────────────────────────────────────────────────────────────────
  handle('plan:fromDuplicates', async (tier) => {
    const key = tier === 'image' ? 'image'
      : tier === 'text' ? 'text'
      : tier === 'video' ? 'video' : 'exact';
    const found = state.lastDuplicates[key];
    if (!found) throw new Error('Run the duplicate scan first.');
    const plan = new Plan({
      source: `duplicates:${key}`,
      title: key === 'exact' ? 'Remove exact duplicate files' : 'Review near-duplicate files',
      roots: roots.listRoots(),
    });
    const specs = (key === 'video' || key === 'text')
      ? contentDupes.contentDupesToPlanEntries(found.groups, { ACTION, CATEGORY, CONFIDENCE })
      : duplicates.duplicatesToPlanEntries(found.groups, { Plan, CATEGORY, ACTION, CONFIDENCE });
    for (const spec of specs) plan.add(spec);
    for (const n of (found.notes || [])) plan.addNote(n);
    if (key !== 'exact') {
      plan.addNote(
        'These files are not byte-identical. They were matched by perceptual hashing, ' +
        'which measures visual or textual similarity. Nothing here is pre-selected, ' +
        'because choosing which version to keep is a judgement only you can make.'
      );
    }
    state.registerPlan(plan);
    return plan.toJSON();
  });

  handle('plan:fromLeftovers', async () => {
    if (!state.lastLeftovers) throw new Error('Run the leftover scan first.');
    const plan = new Plan({
      source: 'leftovers',
      title: 'Remove leftovers from uninstalled applications',
      roots: roots.listRoots(),
      notes: [...state.lastLeftovers.notes],
    });
    for (const spec of leftoversToPlanEntries(state.lastLeftovers.findings, { ACTION, CATEGORY, CONFIDENCE })) {
      // Skip anything outside an approved root rather than proposing something
      // that would be refused at execution time.
      try { roots.assertInsideRoot(spec.path, { mustExist: true }); } catch { continue; }
      plan.add(spec);
    }
    state.registerPlan(plan);
    return plan.toJSON();
  });

  handle('plan:setSelection', async (planId, ids) => {
    const plan = state.getPlan(planId);
    plan.setSelection(ids || []);
    return plan.toJSON();
  });

  handle('plan:get', async (planId) => state.getPlan(planId).toJSON());

  handle('plan:execute', async (planId) => {
    const plan = state.getPlan(planId);
    plan.approve();                       // explicit, per-plan, never defaulted
    const result = await state.executor.execute(plan, (p) => send('execute:progress', p));
    state.plans.delete(planId);
    invalidateDrives();
    return result;
  });

  // ── quarantine ───────────────────────────────────────────────────────────
  handle('quarantine:list', async () => ({
    items: state.quarantine.list(),
    totalBytes: state.quarantine.totalBytes(),
  }));
  handle('quarantine:restore', async (id) => {
    const restored = await state.quarantine.restore(id);
    invalidateDrives();
    return restored;
  });
  handle('quarantine:forget', async (id) => state.quarantine.forget(id));
  handle('quarantine:audit', async () => state.quarantine.audit());

  // ── assistant ────────────────────────────────────────────────────────────
  handle('agent:status', async () => ({
    ...state.gemini.status(),
    keySource: state.keySource,
    // The agent is a fixed set of tools; naming them is more use to someone
    // deciding whether to trust it than any description of the model would be.
    tools: require('../llm/agent').toolDeclarations()[0].functionDeclarations
      .map((d) => ({ name: d.name, description: d.description })),
  }));

  /** The models this key can actually call, asked of the API. */
  handle('agent:models', async () => state.gemini.listModels());

  /** Sends one real request, so "working" means it worked. */
  handle('agent:test', async () => state.gemini.probe());
  handle('agent:reset', async () => { state.agent?.reset(); return true; });
  /**
   * Describes a file dropped on the assistant, before anything is sent.
   *
   * A drop is a read, and a read obeys the same rule as every other: the file
   * must be inside a root the user approved. A refusal comes back as data — an
   * `ok: false` with the reason and the folder that would need granting —
   * rather than as a thrown error, because a custom `code` on an Error does not
   * survive the context bridge, and the composer has to be able to tell "not
   * allowed yet" apart from "could not be read".
   */
  handle('agent:attach', async (filePath) => {
    const target = String(filePath || '');
    const access = roots.accessFor(target);
    if (!access.allowed) {
      return {
        ok: false,
        reason: access.reason,          // 'outside' or 'protected'
        path: target,
        name: path.basename(target),
        folder: path.dirname(path.resolve(target)),
        message: access.reason === 'protected'
          ? `${path.basename(target)} is inside a protected location (${access.detail}), which NexaFiles never reads.`
          : `${path.basename(target)} is outside every folder NexaFiles may read.`,
      };
    }
    const safe = roots.assertInsideRoot(target, { mustExist: true });
    const described = await attachments.describe(safe);
    return { ok: !described.error, ...described };
  });

  /**
   * Turns a spoken question into text.
   *
   * The recording arrives from the renderer and is forwarded to the model; it
   * is never written to disk and nothing about it is kept once this returns.
   * The transcript goes back to the composer for the user to read and send
   * themselves — this handler cannot start a conversation, only fill in a text
   * box, so a microphone left open cannot ask the agent anything.
   */
  handle('agent:transcribe', async (audio) => {
    if (!state.gemini?.available) {
      const err = new Error('No API key is configured, so speech cannot be transcribed.');
      err.code = 'NO_KEY';
      throw err;
    }
    return voice.transcribe(state.gemini, audio || {});
  });

  handle('agent:send', async (message, attachmentPaths) => {
    if (!state.agent) throw new Error('The assistant is not available.');

    // Attachments are read here, in the main process, and reach the model as
    // extracted text or pixels. Six at a time: past that the request stops
    // being a question about some files and starts being a bulk upload.
    const attachmentParts = [];
    const attachmentNotes = [];
    for (const p of (attachmentPaths || []).slice(0, 6)) {
      try {
        const safe = roots.assertInsideRoot(p, { mustExist: true });
        const built = await attachments.toParts(safe, { nativeImage });
        attachmentParts.push(...built.parts);
        attachmentNotes.push({ path: p, ok: built.ok, note: built.note });
      } catch (err) {
        attachmentNotes.push({ path: p, ok: false, note: err.message });
      }
    }

    const out = await state.agent.send(
      String(message || '').slice(0, 8000),
      { attachmentParts }
    );
    if (out.plan) state.registerPlan(out.plan);
    if (out.conversion) state.conversions.set(out.conversion.id, out.conversion);
    return {
      reply: out.reply,
      plan: out.plan ? out.plan.toJSON() : null,
      conversion: out.conversion || null,
      toolCalls: out.toolCalls,
      error: out.error,
      attachments: attachmentNotes,
    };
  });

  // ── the overlay panel ────────────────────────────────────────────────────
  //
  // A second window with its own conversation, over the same tools. Everything
  // it can reach, the side panel can reach; the difference is where it appears
  // and how it is asked. The safety model is untouched: the model proposes, the
  // handlers below act only on a proposal the user approved, and every path is
  // re-validated here rather than trusted from the renderer.

  /** Whatever the renderer needs to draw itself before anything is asked. */
  handle('overlay:status', async () => {
    const g = state.gemini.status();
    const caps = await converter.capabilities();
    return {
      assistantConfigured: !!g.configured,
      model: g.model,
      hotkey: overlay.currentHotkey(),
      conversion: {
        available: caps.available,
        selfRendered: caps.selfRendered || [],
        needsOfficeSuite: caps.needsOfficeSuite || [],
        why: caps.why,
      },
      documentsIndexed: state.index.docIndexStats(),
    };
  });

  handle('overlay:resize', async (height, { immediate = false } = {}) =>
    overlay.resize(Number(height) || 0, { immediate: !!immediate }));

  handle('overlay:hide', async () => overlay.hide());

  /**
   * The renderer reporting that it is bound and listening.
   *
   * Answers with whether the window is already visible, so a panel whose
   * renderer finished starting up after it was summoned opens the way it would
   * have if it had been ready in time.
   */
  handle('overlay:ready', async () => overlay.markReady());

  /** Raised by the wake phrase rather than by the shortcut. */
  handle('overlay:showFromWake', async () => {
    const prefs = state.settings.values.overlay || {};
    if (!prefs.enabled || !prefs.wakeWord) return false;
    if (!overlay.get()) overlay.create();
    return overlay.show({ reason: 'wake' });
  });

  handle('overlay:show', async () => {
    if (!state.settings.values.overlay?.enabled) {
      throw new Error('The overlay is switched off in Settings.');
    }
    if (!overlay.get()) overlay.create();
    return overlay.show({ reason: 'settings' });
  });

  handle('overlay:reset', async () => {
    state.overlayAgent?.reset();
    state.overlayChoices.clear();
    return true;
  });

  /**
   * One question, asked of the overlay's own agent.
   *
   * Progress is pushed to the overlay window as it happens — which tool is
   * running, how many documents have been read — because a question that reads
   * four hundred files takes seconds, and a panel that shows a spinner for that
   * long is a panel that looks broken.
   */
  const askOverlay = async (message) => {
    if (!state.overlayAgent) throw new Error('The assistant is not available.');
    const out = await state.overlayAgent.send(String(message || '').slice(0, 4000), {
      onStage: (payload) => {
        const win = overlay.get();
        if (win) win.webContents.send('overlay:stage', payload);
      },
    });

    if (out.plan) state.registerPlan(out.plan);
    if (out.conversion) state.conversions.set(out.conversion.id, out.conversion);
    // The offered set is remembered here, so that when the answer comes back the
    // paths can be checked against what was actually offered rather than taken
    // on the renderer's word.
    if (out.choice) state.overlayChoices.set(out.choice.id, out.choice);

    return {
      reply: out.reply,
      plan: out.plan ? out.plan.toJSON() : null,
      conversion: out.conversion || null,
      choice: out.choice || null,
      toolCalls: out.toolCalls,
      error: out.error,
    };
  };

  handle('overlay:ask', async (message) => askOverlay(message));

  /**
   * The user's answer to "which of these did you mean".
   *
   * The renderer sends back ids of what it displayed; each is checked against
   * the options that were actually offered for that question. A renderer that
   * sent a path nobody was shown would be naming a file the user never saw, and
   * that path is dropped rather than searched for.
   */
  handle('overlay:choose', async (choiceId, paths) => {
    const choice = state.overlayChoices.get(String(choiceId || ''));
    if (!choice) throw new Error('That question is no longer open.');

    const offered = new Map(choice.options.map((o) => [roots.normalize(o.path), o]));
    const picked = [];
    for (const p of (paths || []).slice(0, 12)) {
      const match = offered.get(roots.normalize(String(p || '')));
      if (match) picked.push(match);
    }
    if (picked.length === 0) throw new Error('None of those files were among the ones offered.');

    state.overlayChoices.delete(choice.id);

    // Phrased as the user answering, because that is what happened. The model
    // sees a normal turn of conversation naming absolute paths it already knows.
    const answer = picked.length === 1
      ? `I mean this one: ${picked[0].path}`
      : `I mean these: ${picked.map((p) => p.path).join(', ')}`;
    return askOverlay(answer);
  });

  /**
   * Runs a conversion the assistant proposed and the user just approved.
   *
   * Only the proposal's id crosses the bridge. The paths live in the main
   * process, which is what stops an approval of one conversion being redeemed
   * for a different one.
   */
  handle('overlay:convert', async (conversionId, { onConflict = 'rename' } = {}) => {
    const proposal = state.conversions.get(String(conversionId || ''));
    if (!proposal) throw new Error('That conversion proposal is no longer available.');

    const results = [];
    for (const item of proposal.items) {
      const win = overlay.get();
      if (win) {
        win.webContents.send('overlay:stage', {
          stage: 'converting', message: `Converting ${path.basename(item.source)}…`,
        });
      }
      try {
        results.push(await converter.convert(item.source, { format: proposal.format, onConflict }));
      } catch (err) {
        results.push({ ok: false, source: item.source, error: err.message, code: err.code || null });
      }
    }
    // Spent once, exactly as in the side panel: an approval is for one run.
    state.conversions.delete(proposal.id);
    return {
      results,
      converted: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  });

  /**
   * "Save it somewhere else" — a native Save dialog, then a copy.
   *
   * A copy rather than a move: the file the conversion produced sits beside its
   * source, where the user can find it again, and this adds a second one where
   * they asked for it. Nothing is removed by saving.
   */
  handle('overlay:saveCopy', async (filePath) => {
    const src = roots.assertInsideRoot(filePath, { mustExist: true });
    const win = overlay.get();
    const result = await dialog.showSaveDialog(win || mainWindow, {
      title: 'Save a copy',
      defaultPath: path.join(app.getPath('downloads'), path.basename(src)),
      filters: [{ name: 'PDF', extensions: ['pdf'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };

    // The destination is wherever the user pointed the dialog, and a location
    // they chose in a system dialog is a location they approved — the same
    // reasoning the directory picker already relies on.
    const dest = result.filePath;
    await fsp.copyFile(src, dest);
    return { saved: true, path: dest, bytes: (await fsp.stat(dest)).size };
  });

  handle('overlay:reveal', async (filePath) => {
    const safe = roots.assertInsideRoot(filePath, { mustExist: true });
    shell.showItemInFolder(safe);
    return true;
  });

  /**
   * Opens a file in whatever the system uses for it.
   *
   * The overlay only ever offers this for a PDF it has just produced or a
   * document it found, and `openPath` hands off to the registered application
   * rather than executing anything itself — but the extension is still checked,
   * because "open" on a .exe is not opening, it is running.
   */
  handle('overlay:open', async (filePath) => {
    const safe = roots.assertInsideRoot(filePath, { mustExist: true });
    const ext = path.extname(safe).slice(1).toLowerCase();
    const EXECUTABLE = ['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'sh', 'app', 'command'];
    if (EXECUTABLE.includes(ext)) {
      throw new Error(`${path.basename(safe)} is a program. The overlay does not run programs.`);
    }
    const problem = await shell.openPath(safe);
    if (problem) throw new Error(problem);
    return true;
  });

  // ── conversion ───────────────────────────────────────────────────────────
  //
  // Converting is the one thing in this application that writes a file the user
  // did not already have, so it is gated the same way removal is: the assistant
  // proposes, this handler is what actually runs, and it only ever runs on a
  // proposal the user approved by id.

  handle('convert:support', async ({ refresh = false } = {}) => converter.capabilities({ refresh }));

  /** The destination a conversion would use, so the UI can show it beforehand. */
  handle('convert:preview', async (paths, { format = 'pdf' } = {}) => {
    const out = [];
    for (const p of (paths || []).slice(0, 100)) {
      try {
        const safe = roots.assertInsideRoot(p, { mustExist: true });
        const dest = converter.destinationFor(safe, { format });
        out.push({ source: safe, target: dest.target, targetExists: dest.exists, ok: true });
      } catch (err) {
        out.push({ source: p, ok: false, why: err.message });
      }
    }
    return out;
  });

  /**
   * Converts files the user chose in the Files view.
   *
   * No proposal id here, and none is needed: the paths came from the user
   * selecting rows in their own file manager, which is the approval. Every path
   * is still re-validated against the approved roots, because the renderer is
   * not trusted to send back only what it was given.
   */
  handle('convert:run', async (paths, { format = 'pdf', onConflict = 'refuse' } = {}) => {
    const results = [];
    for (const p of (paths || []).slice(0, 100)) {
      try {
        results.push(await converter.convert(p, { format, onConflict }));
      } catch (err) {
        results.push({ ok: false, source: p, error: err.message, code: err.code || null });
      }
    }
    return {
      results,
      converted: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  });

  /**
   * Executes a conversion the assistant proposed, after the user approved it.
   *
   * The proposal is looked up by id and its own stored paths are used. Paths are
   * never taken from the caller at this point: accepting them would let a
   * compromised renderer approve one conversion and perform another.
   */
  handle('convert:executeProposal', async (conversionId, { onConflict = 'refuse' } = {}) => {
    const proposal = state.conversions.get(conversionId);
    if (!proposal) throw new Error('That conversion proposal is no longer available.');

    const results = [];
    for (const item of proposal.items) {
      try {
        results.push(await converter.convert(item.source, { format: proposal.format, onConflict }));
      } catch (err) {
        results.push({ ok: false, source: item.source, error: err.message, code: err.code || null });
      }
    }
    // Spent once. A proposal that could be replayed is a proposal the user
    // approved once and authorised forever.
    state.conversions.delete(conversionId);
    return {
      results,
      converted: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  });
}

function tierName(tier) {
  if (tier === 'image') return 'image-perceptual';
  if (tier === 'text') return 'text-simhash';
  if (tier === 'video') return 'video';
  return 'exact';
}

function methodDescription(tier) {
  if (tier === 'image') {
    return 'Difference hashing: each image is reduced to 9x8 greyscale and encoded as ' +
           '64 bits recording which of each adjacent pixel pair is brighter. Files whose ' +
           'hashes differ by 6 bits or fewer are grouped. This is not machine learning.';
  }
  if (tier === 'text') {
    return 'SimHash over three-word shingles, producing a 64-bit fingerprint per document. ' +
           'Files differing by 12 bits or fewer are grouped. This is not machine learning.';
  }
  return 'Files are grouped by exact byte size, then by a hash of their first and last ' +
         '4 KB, and only survivors are hashed in full with SHA-256. Every match is ' +
         'byte-for-byte identical.';
}

module.exports = { register };
