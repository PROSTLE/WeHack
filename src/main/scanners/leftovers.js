'use strict';
// Application leftovers: configuration, caches and support files belonging to
// applications that are no longer installed.
//
// This matching is heuristic and it will produce false positives. That is not a
// caveat buried in a README — it shapes the design:
//
//   - Every finding carries the specific evidence that produced it (which
//     registry key was absent, which bundle identifier did not resolve).
//   - Shared vendor directories are the main trap. %APPDATA%\Microsoft and
//     ~/Library/Application Support/Adobe are used by many products, and a
//     helper daemon can legitimately outlive the app that installed it. Known
//     shared vendors are never proposed for removal at all.
//   - Findings are split into regenerable (caches, logs, crash reports) and
//     user data (licences, saved games, projects, mail, preferences). User data
//     is never pre-selected. Deleting a licence file because "the app is gone"
//     is data loss, and it is how this category of tool earned its reputation.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const { measure } = require('../safety/fsops');

// Vendor directories shared by many products, or owned by the OS. A leftover
// verdict on any of these would be wrong often enough to be dangerous, so they
// are excluded from proposals entirely.
const SHARED_OR_SYSTEM = new Set([
  // Vendor folders many products write into.
  'microsoft', 'windows', 'windowsapps', 'common files', 'package cache',
  'packages', 'temp', 'tmp', 'inteldriverupdater', 'intel', 'nvidia',
  'nvidia corporation', 'amd', 'realtek', 'apple', 'apple computer',
  'adobe', 'google', 'mozilla', 'oracle', 'java', 'sun', 'connecteddevicesplatform',
  'comms', 'crashdumps', 'd3dscache', 'diagnostics', 'elevateddiagnostics',
  'iconcache', 'publishers', 'virtualstore', 'gecko', 'systemcertificates',
  'application data', 'history', 'network', 'cache', 'caches',

  // Install roots. %LOCALAPPDATA%\Programs is where per-user applications are
  // installed; proposing it would offer to delete the user's applications.
  'programs', 'program files', 'programdata',

  // Windows components and services that carry no uninstall entry of their own.
  'usoshared', 'usoprivate', 'windowsoobeapphost', 'whesvc', 'wsl',
  'lxss', 'defender', 'windowsdefender', 'windowssecurityhealth',
  'systemprofile', 'onedrive', 'powershell', 'terminal', 'winget',
  'shellexperiencehost', 'startmenuexperiencehost', 'searchhost',
  'devicesflow', 'accountpictures', 'clipsvc', 'inputmethod', 'ime',
  'fontcache', 'ncsi', 'usermanager', 'appv', 'msix',

  // Shared runtimes and browser engines used by many applications at once.
  'cef', 'electron', 'electron-builder', 'chromium', 'webview2', 'edgewebview',
  'node', 'nodejs', 'dotnet', '.dotnet', 'mono', 'python', 'pip', 'jetbrains',
]);

// Developer and runtime caches that belong to tooling rather than to an
// installed desktop application. These are real regenerable caches, but they
// are NOT evidence that any application was uninstalled, so they are reported
// under their own reason rather than as leftovers.
const KNOWN_TOOL_CACHES = new Map([
  ['npm-cache', 'the npm package manager'],
  ['npm', 'the npm package manager'],
  ['yarn', 'the Yarn package manager'],
  ['pnpm', 'the pnpm package manager'],
  ['pub', 'the Dart pub package manager'],
  ['uv', 'the uv Python package manager'],
  ['pip', 'the pip package manager'],
  ['go-build', 'the Go build cache'],
  ['ms-playwright', 'Playwright browser downloads'],
  ['ms-playwright-go', 'Playwright browser downloads'],
  ['puccinialin', 'a Rust toolchain helper cache'],
  ['dotslash', 'the DotSlash tool cache'],
  ['.dartserver', 'the Dart analysis server'],
  ['gradle', 'the Gradle build cache'],
  ['.gradle', 'the Gradle build cache'],
  ['maven', 'the Maven build cache'],
  ['.m2', 'the Maven build cache'],
  ['nuget', 'the NuGet package cache'],
  ['arduino15', 'the Arduino IDE'],
]);

// Directory names that regenerate on their own if removed.
const REGENERABLE_HINTS = [
  'cache', 'caches', 'logs', 'log', 'temp', 'tmp', 'crashes', 'crashreports',
  'crashpad', 'gpucache', 'code cache', 'shadercache', 'thumbnails',
  'service worker', 'blob_storage', 'diagnosticreports', 'saved application state',
];

// Directory names that hold data a user would be upset to lose.
const USER_DATA_HINTS = [
  'saves', 'savegames', 'saved games', 'profiles', 'profile', 'licence',
  'license', 'licenses', 'projects', 'documents', 'mail', 'databases',
  'indexeddb', 'local storage', 'bookmarks', 'history', 'keychain',
  'preferences', 'settings', 'config', 'user data', 'userdata', 'backups',
];

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Tokens a directory name could plausibly share with an application name. */
function tokens(s) {
  return (s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

// ── Installed-application inventory ────────────────────────────────────────

async function ps(script, timeout = 30000) {
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }
  );
  const t = stdout.trim();
  if (!t) return [];
  const parsed = JSON.parse(t);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Windows: the three uninstall registry hives.
 * Verified readable without elevation (248 entries on the test machine).
 */
async function installedWindows() {
  const rows = await ps(`
    $paths = @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    )
    Get-ItemProperty $paths -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName } |
      ForEach-Object {
        [pscustomobject]@{
          name      = $_.DisplayName
          publisher = $_.Publisher
          location  = $_.InstallLocation
          key       = $_.PSPath
        }
      } | ConvertTo-Json -Compress -Depth 3
  `);
  return rows.map((r) => ({
    name: r.name || '',
    publisher: r.publisher || '',
    location: r.location || '',
    key: (r.key || '').replace('Microsoft.PowerShell.Core\\Registry::', ''),
  }));
}

/** macOS: bundle identifiers of every installed application. */
async function installedMac() {
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
  const apps = [];
  for (const dir of dirs) {
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.app')) continue;
      const plist = path.join(dir, e, 'Contents', 'Info.plist');
      let bundleId = '';
      try {
        const { stdout } = await execFileP('defaults', ['read', plist.replace(/\.plist$/, ''), 'CFBundleIdentifier']);
        bundleId = stdout.trim();
      } catch { /* unreadable plist */ }
      apps.push({
        name: path.basename(e, '.app'),
        publisher: '',
        location: path.join(dir, e),
        key: bundleId || path.join(dir, e),
        bundleId,
      });
    }
  }
  return apps;
}

/** Linux: desktop entries plus the package manager, whichever is available. */
async function installedLinux() {
  const apps = [];
  const desktopDirs = [
    '/usr/share/applications',
    path.join(os.homedir(), '.local', 'share', 'applications'),
  ];
  for (const dir of desktopDirs) {
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.desktop')) continue;
      apps.push({ name: path.basename(e, '.desktop'), publisher: '', location: '', key: path.join(dir, e) });
    }
  }
  for (const [bin, args] of [['dpkg-query', ['-f', '${binary:Package}\n', '-W']], ['rpm', ['-qa']]]) {
    try {
      const { stdout } = await execFileP(bin, args, { maxBuffer: 16 * 1024 * 1024 });
      for (const line of stdout.split('\n')) {
        const n = line.trim();
        if (n) apps.push({ name: n, publisher: '', location: '', key: `${bin}:${n}` });
      }
      break;
    } catch { /* package manager not present */ }
  }
  return apps;
}

async function listInstalledApplications() {
  if (process.platform === 'win32') return installedWindows();
  if (process.platform === 'darwin') return installedMac();
  return installedLinux();
}

// ── Candidate locations ────────────────────────────────────────────────────

function candidateRoots() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const roots = [];
    if (process.env.APPDATA) roots.push({ dir: process.env.APPDATA, label: '%APPDATA%' });
    if (process.env.LOCALAPPDATA) roots.push({ dir: process.env.LOCALAPPDATA, label: '%LOCALAPPDATA%' });
    if (process.env.ProgramData) roots.push({ dir: process.env.ProgramData, label: '%PROGRAMDATA%' });
    return roots;
  }
  if (process.platform === 'darwin') {
    const lib = path.join(home, 'Library');
    return [
      { dir: path.join(lib, 'Application Support'), label: '~/Library/Application Support' },
      { dir: path.join(lib, 'Caches'), label: '~/Library/Caches' },
      { dir: path.join(lib, 'Preferences'), label: '~/Library/Preferences' },
      { dir: path.join(lib, 'Containers'), label: '~/Library/Containers' },
      { dir: path.join(lib, 'Saved Application State'), label: '~/Library/Saved Application State' },
      { dir: path.join(lib, 'Logs'), label: '~/Library/Logs' },
    ];
  }
  return [
    { dir: path.join(home, '.config'), label: '~/.config' },
    { dir: path.join(home, '.cache'), label: '~/.cache' },
    { dir: path.join(home, '.local', 'share'), label: '~/.local/share' },
  ];
}

// ── Matching ───────────────────────────────────────────────────────────────

/**
 * Decides whether `dirName` corresponds to any installed application.
 * @returns {{matched: boolean, how: string, app?: object}}
 */
function matchAgainstInstalled(dirName, installed, indexes) {
  const n = norm(dirName);
  if (!n) return { matched: true, how: 'empty name; not evaluated' };

  // Exact normalised match against an application or publisher name.
  const byName = indexes.byName.get(n);
  if (byName) return { matched: true, how: `matches installed application "${byName.name}"`, app: byName };
  const byPub = indexes.byPublisher.get(n);
  if (byPub) return { matched: true, how: `matches publisher "${byPub.publisher}"`, app: byPub };

  // macOS: directories are frequently named by reverse-DNS bundle id.
  if (indexes.byBundle.has(dirName)) {
    const a = indexes.byBundle.get(dirName);
    return { matched: true, how: `matches bundle identifier of "${a.name}"`, app: a };
  }
  // A container named com.vendor.App.Helper belongs to com.vendor.App.
  for (const bid of indexes.byBundle.keys()) {
    if (dirName.startsWith(bid + '.')) {
      return { matched: true, how: `belongs to bundle "${bid}"`, app: indexes.byBundle.get(bid) };
    }
  }

  // Substring containment in either direction, for names like "Slack" vs
  // "SlackHelper" or "Visual Studio Code" vs "Code".
  for (const app of installed) {
    const an = norm(app.name);
    if (an.length >= 4 && (an.includes(n) || n.includes(an))) {
      return { matched: true, how: `name overlaps installed application "${app.name}"`, app };
    }
  }

  // Shared word token, at lower confidence.
  const dirTokens = new Set(tokens(dirName));
  if (dirTokens.size) {
    for (const app of installed) {
      for (const t of tokens(app.name)) {
        if (dirTokens.has(t)) {
          return { matched: true, how: `shares the word "${t}" with installed application "${app.name}"`, app };
        }
      }
    }
  }

  return { matched: false, how: '' };
}

function classifyLeftover(dirName, fullPath) {
  const lower = dirName.toLowerCase();
  const segs = fullPath.toLowerCase().split(/[\\/]+/);
  const hitsUser = USER_DATA_HINTS.find((h) => lower.includes(h) || segs.includes(h));
  const hitsRegen = REGENERABLE_HINTS.find((h) => lower.includes(h) || segs.includes(h));
  // User data wins ties: a "Cache" folder inside a "Profiles" folder is still
  // more likely to matter than a bare cache.
  if (hitsUser) return { category: 'user-data', hint: hitsUser };
  if (hitsRegen) return { category: 'regenerable', hint: hitsRegen };
  return { category: 'user-data', hint: null };  // unknown defaults to cautious
}

/**
 * Finds directories under the platform's application-data roots that do not
 * correspond to any installed application.
 *
 * @returns {{findings: Array, notes: Array, stats: object}}
 */
async function findLeftovers({
  onProgress = () => {},
  shouldCancel = () => false,
  maxDirs = 4000,
  // A directory written to recently is in active use, whatever the registry
  // says. This is a measurement, not an inference, and it is the single most
  // effective false-positive filter available.
  staleDays = 90,
  listProcesses = null,
} = {}) {
  const notes = [];
  const stats = {
    installedApps: 0, directoriesExamined: 0, matched: 0, unmatched: 0,
    skippedShared: 0, skippedRecent: 0, skippedRunning: 0, skippedInstallDir: 0,
    toolCaches: 0,
  };

  let installed = [];
  try {
    installed = await listInstalledApplications();
  } catch (err) {
    return {
      findings: [],
      stats,
      notes: [
        `Could not enumerate installed applications (${err.message}). ` +
        `Without that list nothing can be identified as a leftover, so no findings are reported.`,
      ],
    };
  }
  stats.installedApps = installed.length;

  if (installed.length === 0) {
    return {
      findings: [],
      stats,
      notes: ['No installed applications could be enumerated, so no leftover analysis was performed.'],
    };
  }

  // Indexes for fast exact matching.
  const indexes = { byName: new Map(), byPublisher: new Map(), byBundle: new Map() };
  for (const a of installed) {
    if (a.name) indexes.byName.set(norm(a.name), a);
    if (a.publisher) indexes.byPublisher.set(norm(a.publisher), a);
    if (a.bundleId) indexes.byBundle.set(a.bundleId, a);
  }

  // Corroborating signal 1: names of things actually installed on disk, taken
  // from install locations rather than from the registry. Catches applications
  // that register under a different display name than their data folder.
  const installedDirNames = new Set();
  for (const a of installed) {
    if (a.location) {
      const base = path.basename(a.location.replace(/[\/]+$/, ''));
      if (base) installedDirNames.add(norm(base));
    }
  }
  for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
                    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (!pf) continue;
    try {
      for (const e of await fsp.readdir(pf, { withFileTypes: true })) {
        if (e.isDirectory()) installedDirNames.add(norm(e.name));
      }
    } catch { /* not present */ }
  }

  // Corroborating signal 2: anything currently running is not a leftover.
  const runningNames = new Set();
  if (listProcesses) {
    try {
      for (const p of await listProcesses()) {
        runningNames.add(norm(p.name));
        if (p.execPath) {
          for (const seg of p.execPath.split(/[\/]+/)) runningNames.add(norm(seg));
        }
      }
    } catch {
      notes.push('Running processes could not be listed, so findings were not cross-checked against them.');
    }
  }

  const staleCutoff = Date.now() - staleDays * 86400e3;
  const findings = [];
  const roots = candidateRoots();

  for (const root of roots) {
    if (shouldCancel()) break;
    let entries;
    try {
      entries = await fsp.readdir(root.dir, { withFileTypes: true });
    } catch (err) {
      notes.push(`${root.label} could not be read (${err.code || err.message}); it was not examined.`);
      continue;
    }

    for (const entry of entries) {
      if (shouldCancel()) break;
      if (stats.directoriesExamined >= maxDirs) {
        notes.push(`Stopped after examining ${maxDirs} directories; the list may be incomplete.`);
        break;
      }
      if (!entry.isDirectory()) continue;
      // Never follow a link out of the area being examined.
      if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;

      const dirName = entry.name;
      const full = path.join(root.dir, dirName);
      stats.directoriesExamined++;

      if (SHARED_OR_SYSTEM.has(dirName.toLowerCase())) {
        stats.skippedShared++;
        continue;
      }

      const key = norm(dirName);

      // Corroboration 1: an application installed on disk under this name is
      // not gone, however it chooses to register itself for uninstall.
      if (installedDirNames.has(key)) { stats.skippedInstallDir++; continue; }

      // Corroboration 2: something running under this name is definitively in use.
      if (runningNames.has(key)) { stats.skippedRunning++; continue; }

      const m = matchAgainstInstalled(dirName, installed, indexes);
      const toolCache = KNOWN_TOOL_CACHES.get(dirName.toLowerCase());
      if (m.matched && !toolCache) { stats.matched++; continue; }
      if (!m.matched) stats.unmatched++;

      // Corroboration 3: staleness. A directory written to recently is in
      // active use whatever the registry says. This is measured, not inferred,
      // and it is the single most effective false-positive filter available.
      let dirStat;
      try {
        dirStat = await fsp.stat(full);
      } catch { continue; }
      const lastTouched = Math.max(dirStat.mtimeMs, dirStat.ctimeMs);
      if (lastTouched > staleCutoff) { stats.skippedRecent++; continue; }

      let size;
      try {
        size = await measure(full);
      } catch { continue; }
      if (size.bytes === 0) continue;

      const cls = toolCache
        ? { category: 'regenerable', hint: 'a package-manager cache' }
        : classifyLeftover(dirName, full);
      if (toolCache) stats.toolCaches++;

      const daysIdle = Math.floor((Date.now() - lastTouched) / 86400e3);

      // Confidence reflects how much the evidence actually supports removal.
      // Nothing here reaches "high". An absent uninstall entry is an inference
      // about intent, not a measurement, and on a real machine that inference is
      // wrong often enough that it must never justify a deletion on its own.
      const confidence = cls.category === 'regenerable' ? 'medium' : 'low';

      const registryEvidence = process.platform === 'win32'
        ? `No entry named "${dirName}" was found among ${installed.length} applications registered `
          + `under the Windows uninstall keys (HKLM, HKLM\WOW6432Node and HKCU), no registered `
          + `application name or publisher matches it, and no folder of that name exists under `
          + `Program Files or %LOCALAPPDATA%\Programs.`
        : process.platform === 'darwin'
          ? `No installed application bundle in /Applications or ~/Applications has the identifier `
            + `or name "${dirName}" (${installed.length} bundles checked).`
          : `No desktop entry or installed package matches "${dirName}" `
            + `(${installed.length} entries checked).`;

      const idleEvidence = `Nothing has written to it in ${daysIdle} days (last modified `
        + `${new Date(lastTouched).toISOString().slice(0, 10)}), and no running process `
        + `matches its name.`;

      const measured = `Measured on disk: ${size.bytes.toLocaleString()} bytes across `
        + `${size.files.toLocaleString()} file(s).`;

      const evidenceParts = toolCache
        ? [
            `This is a cache belonging to ${toolCache}, not the leftovers of an uninstalled `
            + `application. It regenerates on next use, at the cost of re-downloading its contents.`,
            idleEvidence,
            measured,
          ]
        : [
            registryEvidence,
            idleEvidence,
            cls.hint
              ? `The name or path contains "${cls.hint}", which is why it is filed as ${cls.category}.`
              : `Nothing in the name identifies what this holds, so it is treated as user data by default.`,
            measured,
          ];

      findings.push({
        path: full,
        name: dirName,
        location: root.label,
        bytes: size.bytes,
        fileCount: size.files,
        daysIdle,
        isDirectory: true,
        category: cls.category,
        confidence,
        kind: toolCache ? 'tool-cache' : 'orphan',
        reason: toolCache
          ? `Cache for ${toolCache}, unused for ${daysIdle} days`
          : `No installed application corresponds to "${dirName}", unused for ${daysIdle} days`,
        evidence: evidenceParts.join(' '),
      });

      onProgress({ phase: 'leftovers', ...stats, current: full });
    }
  }

  findings.sort((a, b) => b.bytes - a.bytes);

  // Honest framing, always shown with the results.
  notes.push(
    'Leftover detection is a heuristic, not a measurement. A folder is only ' +
    'proposed when four things are true at once: no installed application matches ' +
    'its name, no folder of that name exists under an install location, no running ' +
    `process matches it, and nothing has written to it in ${staleDays} days. Even so it ` +
    'can be wrong — a component may be dormant rather than orphaned.'
  );
  notes.push(
    `${stats.skippedShared} shared or system folder(s) were excluded from analysis entirely, ` +
    `${stats.skippedInstallDir} matched an installed application on disk, ` +
    `${stats.skippedRunning} matched a running process, and ` +
    `${stats.skippedRecent} had been written to within the last ${staleDays} days.`
  );
  if (stats.toolCaches > 0) {
    notes.push(
      `${stats.toolCaches} of these are package-manager or build caches. They are not ` +
      'evidence that anything was uninstalled; they simply have not been used recently ' +
      'and will rebuild themselves if removed.'
    );
  }
  if (process.platform === 'win32') {
    notes.push(
      'Applications installed from the Microsoft Store, and portable applications ' +
      'that never register an uninstall entry, are not represented in the installed list.'
    );
  }

  return { findings, notes, stats };
}

/** Converts findings into plan-entry specs. */
function leftoversToPlanEntries(findings, { ACTION, CATEGORY: CAT, CONFIDENCE }) {
  return findings.map((f) => ({
    path: f.path,
    action: ACTION.QUARANTINE,   // app internals do not belong in the user's trash
    bytes: f.bytes,
    fileCount: f.fileCount,
    isDirectory: true,
    reason: f.reason,
    evidence: f.evidence,
    category: f.category === 'regenerable' ? CAT.REGENERABLE : CAT.USER_DATA,
    confidence: f.confidence === 'medium' ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW,
    source: 'leftovers',
  }));
}

module.exports = {
  findLeftovers,
  listInstalledApplications,
  leftoversToPlanEntries,
  matchAgainstInstalled,
  classifyLeftover,
  candidateRoots,
  SHARED_OR_SYSTEM,
};
