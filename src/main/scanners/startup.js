'use strict';
// Startup and background load.
//
// This scanner enumerates and measures; it never writes. Switching an item off
// is a write to the registry or to the task scheduler and lives entirely in
// ../system/startup-control.js, so there is exactly one file to audit for
// anything that changes the machine.
//
// What this file does do is attach two things to every entry it finds: whether
// Windows is currently honouring it, and what it costs right now. A list of
// startup entries with no state and no cost is a list you cannot act on — it
// cannot tell you what is already off, and it cannot tell you which of forty
// entries is the one actually holding four hundred megabytes.
//
// The macOS limitation below is real and must reach the user interface. Login
// items registered through SMAppService (the modern API, used by most software
// shipped since Ventura) are stored in a private database, not as plist files,
// and are visible only in System Settings > General > Login Items. An
// unsandboxed Electron app has no supported way to enumerate them. A list that
// omits them is therefore incomplete, and presenting it as the whole truth
// would be a fabricated claim of completeness.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const control = require('../system/startup-control');

async function ps(script, timeout = 30000) {
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
  );
  const t = stdout.trim();
  if (!t) return [];
  const parsed = JSON.parse(t);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ── Windows ────────────────────────────────────────────────────────────────

async function startupWindows() {
  const items = [];
  const notes = [];

  // Run and RunOnce keys, per-user and machine-wide.
  try {
    const rows = await ps(`
      $keys = @(
        @{ p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';        s = 'HKCU Run' },
        @{ p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';    s = 'HKCU RunOnce' },
        @{ p = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';        s = 'HKLM Run' },
        @{ p = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce';    s = 'HKLM RunOnce' },
        @{ p = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; s = 'HKLM Run (32-bit)' }
      )
      $out = @()
      foreach ($k in $keys) {
        try {
          $props = Get-ItemProperty -Path $k.p -ErrorAction Stop
          foreach ($p in $props.PSObject.Properties) {
            if ($p.Name -like 'PS*') { continue }
            $out += [pscustomobject]@{
              name = $p.Name; command = [string]$p.Value; source = $k.s; location = $k.p
            }
          }
        } catch { }
      }
      $out | ConvertTo-Json -Compress -Depth 3
    `);
    for (const r of rows) {
      items.push({
        name: r.name,
        command: r.command,
        source: r.source,
        location: r.location,
        kind: 'registry-run',
        evidence: `Registry value "${r.name}" under ${r.location}, command: ${r.command}`,
      });
    }
  } catch (err) {
    notes.push(`Registry Run keys could not be read (${err.message}).`);
  }

  // Startup folders.
  const folders = [
    [path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), 'User Startup folder'],
    [path.join(process.env.ProgramData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), 'Common Startup folder'],
  ];
  for (const [dir, label] of folders) {
    if (!dir) continue;
    try {
      for (const e of await fsp.readdir(dir)) {
        if (e.toLowerCase() === 'desktop.ini') continue;
        items.push({
          name: path.basename(e, path.extname(e)),
          command: path.join(dir, e),
          source: label,
          location: dir,
          kind: 'startup-folder',
          evidence: `Shortcut or program present in the ${label}: ${path.join(dir, e)}`,
        });
      }
    } catch { /* folder absent */ }
  }

  // Scheduled tasks with a logon trigger.
  try {
    // Disabled tasks are listed too, and marked. A management view that hid
    // them could switch a task off and then never offer to switch it back on.
    const rows = await ps(`
      Get-ScheduledTask -ErrorAction SilentlyContinue |
        Where-Object { $_.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' } } |
        ForEach-Object {
          [pscustomobject]@{
            name = $_.TaskName; taskPath = $_.TaskPath; state = [string]$_.State
            action = ($_.Actions | ForEach-Object { $_.Execute }) -join '; '
          }
        } | ConvertTo-Json -Compress -Depth 3
    `);
    for (const r of rows) {
      const enabled = r.state !== 'Disabled';
      items.push({
        name: r.name,
        command: r.action || '',
        source: 'Scheduled task (at logon)',
        location: (r.taskPath || '') + r.name,
        kind: 'scheduled-task',
        enabled,
        stateKnown: true,
        evidence: `Scheduled task ${r.taskPath}${r.name} runs at logon: ${r.action || 'no executable recorded'}` +
          `${enabled ? '' : ' — currently disabled, so it does not fire'}`,
      });
    }
  } catch (err) {
    // Get-ScheduledTask fails outright on some Windows configurations
    // ("The system cannot find the file specified"), so fall back to the older
    // schtasks CLI, which reports the trigger type in its verbose CSV output.
    try {
      const rows = await ps(`
        $raw = schtasks.exe /query /v /fo CSV 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { '' } else {
          $raw | ConvertFrom-Csv |
            Where-Object { $_.'Scheduled Task State' -eq 'Enabled' -and $_.'Schedule Type' -match 'logon' } |
            ForEach-Object {
              [pscustomobject]@{
                name = $_.TaskName
                action = $_.'Task To Run'
                schedule = $_.'Schedule Type'
              }
            } | ConvertTo-Json -Compress -Depth 3
        }
      `);
      const seenTask = new Set();
      for (const r of rows) {
        if (!r || !r.name || seenTask.has(r.name)) continue;
        seenTask.add(r.name);
        items.push({
          name: path.basename(r.name),
          command: r.action || '',
          source: 'Scheduled task (at logon)',
          location: r.name,
          kind: 'scheduled-task',
          enabled: true,
          stateKnown: true,
          evidence: `Scheduled task ${r.name} is enabled with a "${r.schedule}" trigger` +
            `${r.action ? `, running: ${r.action}` : ''}`,
        });
      }
    } catch {
      notes.push(
        'Scheduled tasks could not be enumerated on this system, so logon-triggered ' +
        'tasks are not represented in this list. The list is therefore incomplete.'
      );
    }
  }

  // Services. Automatic ones start with Windows; a Manual one that is running
  // right now is also part of the background load the user is looking at, and
  // is the state a service NexaFiles switched off ends up in — so both are
  // listed, and which is which is recorded rather than blurred.
  try {
    const rows = await ps(`
      Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
        Where-Object { $_.StartMode -eq 'Auto' -or ($_.StartMode -eq 'Manual' -and $_.State -eq 'Running') } |
        ForEach-Object {
          [pscustomobject]@{
            name = $_.DisplayName; svc = $_.Name; pathName = $_.PathName
            state = $_.State; startMode = $_.StartMode; procId = $_.ProcessId
          }
        } | ConvertTo-Json -Compress -Depth 3
    `);
    for (const r of rows) {
      const auto = r.startMode === 'Auto';
      items.push({
        name: r.name || r.svc,
        command: r.pathName || '',
        source: auto ? 'Service (automatic start)' : 'Service (on demand, running now)',
        location: `Service: ${r.svc}`,
        kind: 'service',
        running: r.state === 'Running',
        pid: r.procId || null,
        startMode: r.startMode,
        enabled: auto,
        stateKnown: true,
        evidence: auto
          ? `Windows service "${r.svc}" is set to start automatically. ` +
            `Executable: ${r.pathName || 'not recorded'}`
          : `Windows service "${r.svc}" does not start with Windows — something ` +
            `asked for it. Executable: ${r.pathName || 'not recorded'}`,
      });
    }
  } catch {
    notes.push('Automatic-start services could not be enumerated.');
  }

  // Which of the Run and Startup-folder entries Windows is currently honouring.
  // Read once for the whole machine rather than per item.
  try {
    const approvals = await control.readApprovalStates();
    for (const it of items) {
      if (it.kind !== 'registry-run' && it.kind !== 'startup-folder') continue;
      const key = `${it.source}::${control.approvalValueName(it).toLowerCase()}`;
      if (approvals.has(key)) {
        it.enabled = !approvals.get(key);
        it.stateKnown = true;
        if (!it.enabled) {
          it.evidence += ' — Windows is currently set to skip this entry, ' +
            'so it does not run at login.';
        }
      } else {
        // No approval byte recorded at all. Explorer treats that as enabled,
        // which is the state every untouched entry is in.
        it.enabled = true;
        it.stateKnown = true;
      }
    }
  } catch {
    notes.push(
      'Whether each Run entry is currently switched on could not be read, so ' +
      'every entry below is shown without its on/off state.');
  }

  return { items, notes };
}

// ── macOS ──────────────────────────────────────────────────────────────────

async function startupMac() {
  const items = [];
  const notes = [];
  const home = os.homedir();

  const dirs = [
    [path.join(home, 'Library', 'LaunchAgents'), 'User launch agent'],
    ['/Library/LaunchAgents', 'System launch agent'],
    ['/Library/LaunchDaemons', 'System launch daemon'],
  ];

  for (const [dir, label] of dirs) {
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.plist')) continue;
      const full = path.join(dir, e);
      let program = '';
      try {
        const { stdout } = await execFileP('defaults', ['read', full.replace(/\.plist$/, ''), 'ProgramArguments']);
        program = stdout.replace(/\s+/g, ' ').trim();
      } catch {
        try {
          const { stdout } = await execFileP('defaults', ['read', full.replace(/\.plist$/, ''), 'Program']);
          program = stdout.trim();
        } catch { /* neither key present */ }
      }
      items.push({
        name: path.basename(e, '.plist'),
        command: program,
        source: label,
        location: full,
        kind: 'launch-plist',
        evidence: `Property list at ${full}${program ? `, runs: ${program}` : ''}`,
      });
    }
  }

  // The limitation that must reach the interface.
  notes.push(
    'This list is incomplete. Login items registered through SMAppService — the ' +
    'method most software shipped since macOS 13 uses — are held in a private ' +
    'database rather than as property list files, and no supported interface ' +
    'exposes them to an app like this one. Open System Settings > General > ' +
    'Login Items to see the full list.'
  );

  return { items, notes, incomplete: true };
}

// ── Linux ──────────────────────────────────────────────────────────────────

async function startupLinux() {
  const items = [];
  const notes = [];
  const home = os.homedir();

  for (const [dir, label] of [
    [path.join(home, '.config', 'autostart'), 'User autostart'],
    ['/etc/xdg/autostart', 'System autostart'],
  ]) {
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.desktop')) continue;
      const full = path.join(dir, e);
      let exec = '';
      try {
        const text = await fsp.readFile(full, 'utf8');
        const m = text.match(/^Exec=(.*)$/m);
        if (m) exec = m[1].trim();
      } catch { /* unreadable */ }
      items.push({
        name: path.basename(e, '.desktop'),
        command: exec,
        source: label,
        location: full,
        kind: 'autostart-desktop',
        evidence: `Desktop entry at ${full}${exec ? `, Exec=${exec}` : ''}`,
      });
    }
  }

  try {
    const { stdout } = await execFileP('systemctl', ['--user', 'list-unit-files', '--state=enabled', '--no-legend', '--no-pager']);
    for (const line of stdout.split('\n')) {
      const name = line.trim().split(/\s+/)[0];
      if (!name) continue;
      items.push({
        name,
        command: '',
        source: 'systemd user unit (enabled)',
        location: name,
        kind: 'systemd-user',
        evidence: `systemd user unit ${name} is enabled and starts with the session`,
      });
    }
  } catch {
    notes.push('systemd user units could not be listed; they are not represented here.');
  }

  return { items, notes };
}

// ── what an entry costs right now ──────────────────────────────────────────

/**
 * The executable out of a command line.
 *
 * Run values are stored as whatever string the installer felt like writing:
 * a quoted path with arguments, a bare path with arguments, or a path with no
 * arguments at all. Only the first of those is unambiguous, so the other two
 * are recovered by looking for the extension rather than by splitting on
 * spaces — "C:\Program Files\..." has spaces in the path itself.
 */
function executableFromCommand(command) {
  const s = String(command || '').trim();
  if (!s) return null;

  const quoted = s.match(/^"([^"]+)"/);
  if (quoted) return quoted[1];

  const withExt = s.match(/^(.*?\.(?:exe|com|bat|cmd|scr))(?:\s|$)/i);
  if (withExt) return withExt[1];

  // No recognisable executable and no quotes: if there is no argument
  // separator at all, the whole string is the path.
  if (!/\s[-/]/.test(s)) return s;
  return null;
}

/**
 * Attaches the running cost of each entry.
 *
 * An entry is charged with a process when the process is running from the same
 * executable the entry names, or — for a service — from the recorded pid. Both
 * are identity, not resemblance: matching on a name alone would charge every
 * `updater.exe` on the disk to whichever entry happened to be listed first.
 *
 * Anything not matched is reported as not running rather than as costing
 * nothing, because those are different claims.
 */
function attachImpact(items, processes) {
  const norm = (p) => (process.platform === 'linux' ? p : String(p).toLowerCase());

  const byExe = new Map();
  const byPid = new Map();
  for (const p of processes) {
    byPid.set(p.pid, p);
    if (!p.execPath) continue;
    const k = norm(path.resolve(p.execPath));
    if (!byExe.has(k)) byExe.set(k, []);
    byExe.get(k).push(p);
  }

  for (const it of items) {
    it.exePath = executableFromCommand(it.command);

    let matched = [];
    if (it.pid && byPid.has(it.pid)) {
      matched = [byPid.get(it.pid)];
    } else if (it.exePath) {
      let key;
      try { key = norm(path.resolve(it.exePath)); } catch { key = null; }
      if (key && byExe.has(key)) matched = byExe.get(key);
    }

    if (matched.length) {
      it.runningNow = true;
      it.processCount = matched.length;
      it.rssBytes = matched.reduce((n, p) => n + (p.rssBytes || 0), 0);
      it.pids = matched.map((p) => p.pid);
    } else {
      it.runningNow = false;
      it.processCount = 0;
      it.rssBytes = 0;
      it.pids = [];
    }
  }

  // Several services share one svchost.exe, and several Run entries can point
  // at one executable. Each of those entries is correctly charged the whole
  // process — it is the whole process that entry is responsible for — but a
  // total that added them up would count the same megabytes many times over.
  // So the shared ones are marked, and the total is taken over distinct pids.
  const pidUsers = new Map();
  for (const it of items) {
    for (const pid of it.pids) pidUsers.set(pid, (pidUsers.get(pid) || 0) + 1);
  }

  const counted = new Set();
  let totalRss = 0;
  let runningCount = 0;
  for (const it of items) {
    it.sharesProcess = it.pids.some((pid) => pidUsers.get(pid) > 1);
    if (!it.runningNow) continue;
    runningCount++;
    for (const pid of it.pids) {
      if (counted.has(pid)) continue;
      counted.add(pid);
      totalRss += byPid.get(pid)?.rssBytes || 0;
    }
  }

  return { items, totalRssBytes: totalRss, runningCount, distinctProcesses: counted.size };
}

/**
 * Enumerates what starts automatically, with its current state and cost.
 *
 * @param {object} deps
 * @param {Function} [deps.listProcesses] injected so the cost figures come from
 *   the same enumeration the System view uses rather than a second one.
 */
async function listStartupItems({ listProcesses = null } = {}) {
  let result;
  try {
    if (process.platform === 'win32') result = await startupWindows();
    else if (process.platform === 'darwin') result = await startupMac();
    else result = await startupLinux();
  } catch (err) {
    return {
      items: [], notes: [`Startup items could not be enumerated: ${err.message}`],
      incomplete: true, platform: process.platform,
      elevated: false, measuredImpact: false,
    };
  }

  const items = result.items || [];
  const notes = result.notes || [];

  // De-duplicate: a program can appear as both a Run key and a startup shortcut.
  const seen = new Set();
  const unique = [];
  for (const it of items) {
    const key = `${it.kind}::${it.name}::${it.location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(it);
  }

  // Whether the machine-wide entries can be changed at all in this session.
  let elevated = false;
  try { elevated = await control.isElevated(); } catch { /* assume not */ }
  for (const it of unique) {
    it.control = control.describeControl(it, { elevated });
    if (it.enabled === undefined) { it.enabled = true; it.stateKnown = false; }
  }

  // What each one is costing right now.
  let measuredImpact = false;
  let impact = { totalRssBytes: 0, runningCount: 0, distinctProcesses: 0 };
  if (listProcesses) {
    try {
      const out = attachImpact(unique, await listProcesses());
      impact = {
        totalRssBytes: out.totalRssBytes,
        runningCount: out.runningCount,
        distinctProcesses: out.distinctProcesses,
      };
      measuredImpact = true;
    } catch (err) {
      notes.push(
        `Memory in use by each entry could not be measured (${err.message}), so ` +
        'no cost is shown against them.');
    }
  }

  return {
    items: unique,
    notes,
    incomplete: !!result.incomplete,
    platform: process.platform,
    elevated,
    measuredImpact,
    impact,
  };
}

module.exports = { listStartupItems, executableFromCommand, attachImpact };
