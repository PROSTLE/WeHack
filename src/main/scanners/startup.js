'use strict';
// Startup and background load.
//
// This scanner reports; it does not disable anything. Disabling a startup item
// is a write to the registry or to a launchd plist, which goes through the same
// plan/preview/approve pipeline as any other change.
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
    const rows = await ps(`
      Get-ScheduledTask -ErrorAction SilentlyContinue |
        Where-Object { $_.State -ne 'Disabled' -and ($_.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }) } |
        ForEach-Object {
          [pscustomobject]@{
            name = $_.TaskName; taskPath = $_.TaskPath
            action = ($_.Actions | ForEach-Object { $_.Execute }) -join '; '
          }
        } | ConvertTo-Json -Compress -Depth 3
    `);
    for (const r of rows) {
      items.push({
        name: r.name,
        command: r.action || '',
        source: 'Scheduled task (at logon)',
        location: (r.taskPath || '') + r.name,
        kind: 'scheduled-task',
        evidence: `Scheduled task ${r.taskPath}${r.name} runs at logon: ${r.action || 'no executable recorded'}`,
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

  // Automatic services.
  try {
    const rows = await ps(`
      Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
        Where-Object { $_.StartMode -eq 'Auto' } |
        ForEach-Object {
          [pscustomobject]@{ name = $_.DisplayName; svc = $_.Name; pathName = $_.PathName; state = $_.State }
        } | ConvertTo-Json -Compress -Depth 3
    `);
    for (const r of rows) {
      items.push({
        name: r.name || r.svc,
        command: r.pathName || '',
        source: 'Service (automatic start)',
        location: `Service: ${r.svc}`,
        kind: 'service',
        running: r.state === 'Running',
        evidence: `Windows service "${r.svc}" is set to start automatically. Executable: ${r.pathName || 'not recorded'}`,
      });
    }
  } catch {
    notes.push('Automatic-start services could not be enumerated.');
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

/**
 * Enumerates what starts automatically.
 * @returns {{items: Array, notes: Array, incomplete: boolean, platform: string}}
 */
async function listStartupItems() {
  let result;
  try {
    if (process.platform === 'win32') result = await startupWindows();
    else if (process.platform === 'darwin') result = await startupMac();
    else result = await startupLinux();
  } catch (err) {
    return {
      items: [], notes: [`Startup items could not be enumerated: ${err.message}`],
      incomplete: true, platform: process.platform,
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

  return {
    items: unique,
    notes,
    incomplete: !!result.incomplete,
    platform: process.platform,
  };
}

module.exports = { listStartupItems };
