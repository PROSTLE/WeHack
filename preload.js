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
    // Sync folders found on this machine. Local knowledge only — this signs in
    // to nothing and contacts nothing.
    cloud: () => call('locations:cloud'),
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
    find: (tier, opts) => call('duplicates:find', tier, opts || {}),
    // Stops a comparison already running. What it had found by then still comes
    // back from `find`, marked as partial — see the handler for why.
    cancel: () => call('duplicates:cancel'),
  },

  leftovers: {
    find: () => call('leftovers:find'),
    cancel: () => call('leftovers:cancel'),
  },

  // Describing files, and finding them by description. This is the one part of
  // NexaFiles that sends file contents anywhere, so every call below refuses
  // until the setting is on — the refusal names the setting, so a feature that
  // is switched off never looks broken.
  describe: {
    status: () => call('describe:status'),
    // Spends one API call per file, so it is bounded and interruptible.
    build: (opts) => call('describe:build', opts || {}),
    cancel: () => call('describe:cancel'),
    // Reads the index; describes nothing and costs nothing but the expansion.
    search: (query, opts) => call('describe:search', query, opts || {}),
    forFile: (filePath) => call('describe:forFile', filePath),
    // Drops descriptions of files that are gone.
    verify: () => call('describe:verify'),
    clear: () => call('describe:clear'),
    onProgress: (h) => on('describe:progress', h),
  },

  // Startup entries, and switching them off. `setEnabled` names an item by the
  // four fields that identify it rather than sending a registry path to write
  // to: the main process resolves those against what it actually enumerated,
  // so the renderer can only ever act on something that is really there.
  // Opening a link in the real browser. The renderer cannot name a destination:
  // the main process allowlists which URLs it will open, because openExternal
  // hands a string to the operating system and the OS will launch more than
  // web pages.
  shell: {
    openExternal: (url) => call('shell:openExternal', url),
  },

  // Connected cloud accounts. Every call is read-only against the provider —
  // the OAuth scopes requested grant no write access at all, so nothing here
  // can modify anybody's cloud. Tokens never cross this bridge in either
  // direction: they are encrypted in the main process and used there.
  cloud: {
    // Providers, their registered client ids, and the accounts already signed in.
    providers: () => call('cloud:providers'),
    // Opens the system browser and waits for the loopback redirect.
    signIn: (providerId) => call('cloud:signIn', providerId),
    // Pulls the file listing: names, sizes, dates and the provider's own hash.
    // Downloads no file content.
    import: (accountId) => call('cloud:import', accountId),
    cancelImport: () => call('cloud:cancelImport'),
    // Duplicates found on the providers' published hashes, without downloading.
    duplicates: (opts) => call('cloud:duplicates', opts || {}),
    stats: (accountId) => call('cloud:stats', accountId),
    // Forgets the account here. Does not revoke access at the provider.
    disconnect: (accountId) => call('cloud:disconnect', accountId),
    onProgress: (h) => on('cloud:progress', h),
  },

  startup: {
    list: () => call('startup:list'),
    setEnabled: (ref, enabled) => call('startup:setEnabled', ref, enabled),
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
    // Every window is told when preferences change, so a switch thrown in the
    // main window's Settings takes effect in the overlay now rather than at the
    // next launch.
    onChanged: (h) => on('settings:changed', h),
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
    // Everything running, one row per program instead of one per process.
    background: (opts) => call('system:background', opts || {}),
    // Closes a program. Asks its windows to close first; only terminates if
    // they do not go, and only when `force` is set.
    endProgram: (name, pids, opts) => call('system:endProgram', name, pids, opts || {}),
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

  // The overlay panel. It is a second window over the same main process, so it
  // reaches the same tools through the same envelope — nothing here is a power
  // the side panel does not also have.
  overlay: {
    // Asks the assistant. Distinct from `agent.send` because the overlay keeps
    // its own conversation: a question asked over another application must not
    // appear in the panel's transcript, and vice versa.
    ask: (message) => call('overlay:ask', message),
    // The user's answer to an ask_user_to_choose question, by proposal id. The
    // paths are re-validated in the main process against the offered set.
    choose: (choiceId, paths) => call('overlay:choose', choiceId, paths || []),
    // Executes a conversion the assistant proposed and the user just approved.
    convert: (conversionId, opts) => call('overlay:convert', conversionId, opts || {}),
    // Offers a native Save dialog for a file the conversion produced.
    saveCopy: (filePath) => call('overlay:saveCopy', filePath),
    reveal: (filePath) => call('overlay:reveal', filePath),
    open: (filePath) => call('overlay:open', filePath),
    reset: () => call('overlay:reset'),
    // Abandons a question still running. Nothing it had reached is kept and
    // nothing on disk is touched either way.
    cancel: () => call('overlay:cancel'),
    status: () => call('overlay:status'),
    // Raises the panel from the main window — the "Show it" button in Settings,
    // for someone whose chosen chord turned out to be taken.
    show: () => call('overlay:show'),
    // The renderer announcing it is bound. Answers with whether the panel is
    // already on screen, so a summon that arrived too early is not lost.
    ready: () => call('overlay:ready'),
    // Raised because the wake phrase was heard. Separate from `show` so the
    // panel knows to arm the microphone whatever the "listen on open" setting
    // says — the user has just spoken to it.
    showFromWake: () => call('overlay:showFromWake'),
    // The renderer measures its own card and asks for a window that fits it.
    resize: (height, opts) => call('overlay:resize', height, opts || {}),
    hide: () => call('overlay:hide'),
    // Progress while a question is being answered, so the panel can say what it
    // is doing rather than spinning.
    onStage: (h) => on('overlay:stage', h),
    onShown: (h) => on('overlay:shown', h),
    onHidden: (h) => on('overlay:hidden', h),
    onBlurred: (h) => on('overlay:blurred', h),
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
    // The user's answer to "which of these did you mean". Only ids the main
    // process itself handed out are accepted, and only paths it actually offered.
    choose: (choiceId, paths) => call('agent:choose', choiceId, paths || []),
    // Stop. Abandons the turn in flight; nothing that had already been proposed
    // is carried forward and nothing on disk is touched either way.
    cancel: () => call('agent:cancel'),
    // What the assistant is doing right now — which tool, how many documents read
    // — pushed while it happens rather than summarised after it finishes.
    onStage: (h) => on('agent:stage', h),
  },

  // Dictation and the wake word. Separate from `agent` because neither is the
  // assistant: one turns speech into text for the composer, the other decides
  // whether the panel should open at all.
  voice: {
    // Which engine would answer right now, and whether a limit is in force.
    status: () => call('voice:status'),
  },

  wake: {
    // Whether the acoustic model is on disk, and the URL to load it from.
    modelStatus: () => call('wake:modelStatus'),
    // Fetches it if it is not. Resolves once it is ready to use.
    ensureModel: () => call('wake:ensureModel'),
    cancelModel: () => call('wake:cancelModel'),
    removeModel: () => call('wake:removeModel'),
    // Bytes as they arrive, so a forty-megabyte download can show a bar.
    onModelProgress: (h) => on('wake:modelProgress', h),

    // ── the listener window's own channel ──────────────────────────────────
    // Used only by src/renderer/js/wake-host.js. The panel has no reason to
    // touch these: it no longer runs the recogniser.

    // The listener announcing its handlers are bound. Answers with whatever
    // instruction the main process was holding for it.
    hostReady: () => call('wake:hostReady'),
    // The phrase was heard. Raising the panel is the main process's decision,
    // not the listener's — it re-checks the settings before showing anything.
    heard: () => call('overlay:showFromWake'),
    onArm: (h) => on('wake:arm', h),
    onDisarm: (h) => on('wake:disarm', h),
    onPanel: (h) => on('wake:panel', h),
  },
});
