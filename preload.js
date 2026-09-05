'use strict';
// The bridge. `contextIsolation` is on and `nodeIntegration` is off, so this is
// the only surface the renderer has. Every method here is an explicit, named
// capability — the renderer cannot reach `fs`, `child_process`, or an arbitrary
// IPC channel.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Unwraps the { ok, data, error } envelope every handler returns. */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res) throw new Error(`No response from ${channel}`);
  if (!res.ok) {
    const err = new Error(res.error || 'Unknown error');
    err.code = res.code;
    throw err;
  }
  return res.data;
}

/** Registers a listener and returns a function that removes it. */
function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('nexa', {
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },

  roots: {
    list: () => call('roots:list'),
    choose: () => call('roots:choose'),
    pick: (title) => call('roots:pick', title),
    approve: (p) => call('roots:approve', p),
    revoke: (p) => call('roots:revoke', p),
    setProtected: (list) => call('roots:setProtected', list),
  },

  locations: {
    drives: () => call('locations:drives'),
    folders: () => call('locations:folders'),
    home: () => call('locations:home'),
  },

  fs: {
    readDirectory: (p) => call('fs:readDirectory', p),
    stat: (p) => call('fs:stat', p),
    measure: (p) => call('fs:measure', p),
    readHead: (p, bytes) => call('fs:readHead', p, bytes),
    openNative: (p) => call('fs:openNative', p),
    revealNative: (p) => call('fs:revealNative', p),
    createFolder: (dir, name) => call('fs:createFolder', dir, name),
    rename: (p, name) => call('fs:rename', p, name),
    move: (src, destDir) => call('fs:move', src, destDir),
  },

  // The Files view. Everything here goes through the same approved-root gate as
  // the rest of the bridge; `list` and `subfolders` differ only in that they
  // report a refusal as data, so the view can offer to fix it, instead of
  // throwing at the user.
  explorer: {
    places: (opts) => call('explorer:places', opts || {}),
    list: (dirPath) => call('explorer:list', dirPath),
    subfolders: (dirPath) => call('explorer:subfolders', dirPath),
    icon: (filePath) => call('explorer:icon', filePath),
    thumbnail: (filePath, size) => call('explorer:thumbnail', filePath, size),
    open: (filePath) => call('explorer:open', filePath),
    reveal: (filePath) => call('explorer:reveal', filePath),
    trash: (paths) => call('explorer:trash', paths),
    copy: (paths, destDir) => call('explorer:copy', paths, destDir),
    move: (paths, destDir) => call('explorer:move', paths, destDir),
    properties: (targetPath, opts) => call('explorer:properties', targetPath, opts || {}),
    newFolder: (parentDir) => call('explorer:newFolder', parentDir),
    createFolder: (parentDir, name) => call('fs:createFolder', parentDir, name),
    rename: (oldPath, newName) => call('fs:rename', oldPath, newName),
  },

  // A dropped File carries no usable path of its own since Electron 32; the
  // path has to be resolved here, in the preload, where `webUtils` lives.
  // This reads nothing — it only names what was dropped.
  dropped: {
    pathFor: (file) => {
      try { return webUtils.getPathForFile(file) || null; } catch { return null; }
    },
  },

  scan: {
    start: (root) => call('scan:start', root),
    cancel: () => call('scan:cancel'),
    current: () => call('scan:current'),
    list: () => call('scan:list'),
    composition: (scanId, under) => call('scan:composition', scanId, under),
    files: (opts) => call('scan:files', opts),
    onProgress: (h) => on('scan:progress', h),
    onComplete: (h) => on('scan:complete', h),
  },

  duplicates: {
    find: (tier) => call('duplicates:find', tier),
  },

  leftovers: {
    find: () => call('leftovers:find'),
  },

  startup: {
    list: () => call('startup:list'),
  },

  // Converting a document. `run` is for files the user picked in the Files view;
  // `executeProposal` is for a conversion the assistant proposed and the user
  // then approved, and it carries only the proposal's id — the paths stay in the
  // main process, where the renderer cannot substitute them.
  convert: {
    support: (opts) => call('convert:support', opts || {}),
    preview: (paths, opts) => call('convert:preview', paths, opts || {}),
    run: (paths, opts) => call('convert:run', paths, opts || {}),
    executeProposal: (id, opts) => call('convert:executeProposal', id, opts || {}),
  },

  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
    onThemeChange: (h) => on('theme:changed', h),
  },

  system: {
    load: () => call('system:load'),
    machine: () => call('system:machine'),
    storage: () => call('system:storage'),
    openUserData: () => call('system:openUserData'),
    processes: () => call('system:processes'),
    processCpu: () => call('system:processCpu'),
    uptime: () => call('system:uptime'),
    session: () => call('system:session'),
  },

  overview: {
    summary: () => call('overview:summary'),
  },

  profile: {
    get: () => call('profile:get'),
  },

  plan: {
    fromDuplicates: (tier) => call('plan:fromDuplicates', tier),
    fromLeftovers: () => call('plan:fromLeftovers'),
    get: (id) => call('plan:get', id),
    setSelection: (id, ids) => call('plan:setSelection', id, ids),
    execute: (id) => call('plan:execute', id),
    onProgress: (h) => on('execute:progress', h),
  },

  quarantine: {
    list: () => call('quarantine:list'),
    restore: (id) => call('quarantine:restore', id),
    forget: (id) => call('quarantine:forget', id),
    audit: () => call('quarantine:audit'),
  },

  agent: {
    status: () => call('agent:status'),
    models: () => call('agent:models'),
    test: () => call('agent:test'),
    attach: (filePath) => call('agent:attach', filePath),
    send: (message, attachmentPaths) => call('agent:send', message, attachmentPaths || []),
    // A recording made in the renderer, sent once and kept nowhere. What comes
    // back is text for the composer, not a message to the assistant: nothing is
    // asked until the user presses Send.
    transcribe: (audio) => call('agent:transcribe', audio),
    reset: () => call('agent:reset'),
  },
});
