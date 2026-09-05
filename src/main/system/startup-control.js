'use strict';
// Turning startup items off, and back on.
//
// The enumerating half of this lives in ../scanners/startup.js. This half is
// the only place in the application that writes to the registry or to the task
// scheduler, and every write it makes is reversible by the write next to it.
//
// The mechanism on Windows is deliberately the same one Task Manager uses:
// Explorer reads a companion key, StartupApproved, before honouring a Run value
// or a Startup-folder shortcut, and skips the ones marked disabled. Nothing is
// deleted, nothing is moved, and the original Run value or shortcut stays
// exactly where the program that installed it put it — so re-enabling is a
// single byte, and an item this application turned off can equally be turned
// back on from Task Manager. Deleting the Run value would also stop the item,
// and would be unrecoverable; that is why this does not do it.
//
// A value's first byte carries the state. Even means enabled, odd means
// disabled; bytes 4..11 hold the FILETIME the disable happened, which is what
// Task Manager shows as "Disabled at". The rest is zero.

const { execFile } = require('child_process');
const path = require('path');
const util = require('util');
const execFileP = util.promisify(execFile);

const IS_WIN = process.platform === 'win32';

/** Escapes a string for embedding in a PowerShell single-quoted literal. */
function q(s) {
  return "'" + String(s === null || s === undefined ? '' : s).replace(/'/g, "''") + "'";
}

async function ps(script, { timeout = 30000, json = true } = {}) {
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
  );
  const text = stdout.trim();
  if (!json) return text;
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ── where an item's on/off switch lives ────────────────────────────────────

// Keyed by the `source` string the scanner records, so the two halves cannot
// drift apart without the lookup failing loudly rather than writing to the
// wrong hive.
const APPROVAL_KEYS = {
  'HKCU Run': {
    path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
    admin: false,
  },
  'HKLM Run': {
    path: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
    admin: true,
  },
  'HKLM Run (32-bit)': {
    path: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32',
    admin: true,
  },
  'User Startup folder': {
    path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder',
    admin: false,
  },
  'Common Startup folder': {
    path: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder',
    admin: true,
  },
};

/**
 * The name Explorer files an item's approval byte under.
 *
 * A Run value is filed under the value's own name. A Startup-folder item is
 * filed under the file name, extension included — "Foo.lnk", not "Foo".
 */
function approvalValueName(item) {
  if (item.kind === 'startup-folder') return path.basename(item.command || item.name);
  return item.name;
}

/** Whether this process can write to HKLM and to services. */
async function isElevated() {
  if (!IS_WIN) return false;
  try {
    const out = await ps(
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) | ConvertTo-Json -Compress',
      { timeout: 10000 });
    return out[0] === true;
  } catch {
    return false;
  }
}

/**
 * Reads every StartupApproved byte on the machine.
 *
 * Returned as a Map from "<source>::<value name lowercased>" to true when the
 * item is disabled. An item with no entry at all has never been touched, which
 * Explorer treats as enabled — so absence is not the same as "unknown" here.
 */
async function readApprovalStates() {
  const states = new Map();
  if (!IS_WIN) return states;

  const sources = Object.entries(APPROVAL_KEYS)
    .map(([source, k]) => `@{ s = ${q(source)}; p = ${q(k.path)} }`)
    .join(', ');

  let rows = [];
  try {
    rows = await ps(`
      $keys = @(${sources})
      $out = @()
      foreach ($k in $keys) {
        try {
          $props = Get-ItemProperty -Path $k.p -ErrorAction Stop
          foreach ($p in $props.PSObject.Properties) {
            if ($p.Name -like 'PS*') { continue }
            $v = $p.Value
            $first = 0
            if ($v -is [byte[]] -and $v.Length -gt 0) { $first = [int]$v[0] }
            $out += [pscustomobject]@{ source = $k.s; name = $p.Name; first = $first }
          }
        } catch { }
      }
      $out | ConvertTo-Json -Compress -Depth 3
    `);
  } catch {
    return states;   // no approvals recorded, or the key does not exist yet
  }

  for (const r of rows) {
    if (!r || !r.name) continue;
    states.set(`${r.source}::${String(r.name).toLowerCase()}`, (r.first & 1) === 1);
  }
  return states;
}

/**
 * Describes how — and whether — one enumerated item can be switched off.
 *
 * Returned as data rather than acted on, because the interface has to be able
 * to say "this one needs administrator" before the user clicks, not after.
 */
function describeControl(item, { elevated = false } = {}) {
  if (!IS_WIN) {
    if (item.kind === 'autostart-desktop') {
      return {
        toggleable: true,
        method: 'desktop-hidden',
        needsAdmin: String(item.source || '').startsWith('System'),
        note: 'Switched off by adding Hidden=true to the desktop entry.',
      };
    }
    return {
      toggleable: false, method: null, needsAdmin: false,
      note: 'NexaFiles cannot change this kind of item on this platform. ' +
            'Use the system settings instead.',
    };
  }

  if (item.kind === 'registry-run' || item.kind === 'startup-folder') {
    if (/RunOnce/i.test(item.source || '')) {
      return {
        toggleable: false, method: null, needsAdmin: false,
        note: 'A RunOnce entry deletes itself the first time it runs, so there ' +
              'is nothing here to switch off permanently.',
      };
    }
    const key = APPROVAL_KEYS[item.source];
    if (!key) {
      return {
        toggleable: false, method: null, needsAdmin: false,
        note: 'This item is not in a location the Explorer approval list covers.',
      };
    }
    return {
      toggleable: !key.admin || elevated,
      method: 'startup-approved',
      needsAdmin: key.admin,
      note: key.admin
        ? 'Machine-wide. Changing it needs NexaFiles to be running as administrator.'
        : 'Switched off the same way Task Manager does it: the entry stays where ' +
          'it is and Windows is told to skip it.',
    };
  }

  if (item.kind === 'scheduled-task') {
    return {
      toggleable: true,
      method: 'scheduled-task',
      needsAdmin: false,
      note: 'Disabling a task leaves its definition in place; it simply stops ' +
            'firing. Some machine-wide tasks will still refuse without ' +
            'administrator rights.',
    };
  }

  if (item.kind === 'service') {
    return {
      toggleable: elevated,
      method: 'service',
      needsAdmin: true,
      note: 'A service start type is machine-wide, so changing it needs ' +
            'NexaFiles to be running as administrator. NexaFiles sets it to ' +
            'Manual rather than Disabled, so anything that genuinely needs the ' +
            'service can still start it on demand.',
    };
  }

  return {
    toggleable: false, method: null, needsAdmin: false,
    note: 'NexaFiles does not know how to change this kind of item.',
  };
}

// ── the writes ─────────────────────────────────────────────────────────────

async function setApprovalByte(item, enabled) {
  const key = APPROVAL_KEYS[item.source];
  if (!key) throw new Error(`${item.source} has no approval key.`);
  const valueName = approvalValueName(item);

  // Enabled is 02 followed by zeroes. Disabled is 03 followed by the FILETIME
  // of the moment it happened, which is what Task Manager reads back as
  // "Disabled at" — writing zeroes there would work but would show a blank date.
  await ps(`
    $ErrorActionPreference = 'Stop'
    $p = ${q(key.path)}
    if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
    $b = New-Object byte[] 12
    if (${enabled ? '$true' : '$false'}) {
      $b[0] = 2
    } else {
      $b[0] = 3
      $stamp = [BitConverter]::GetBytes([DateTime]::Now.ToFileTime())
      [Array]::Copy($stamp, 0, $b, 4, 8)
    }
    New-ItemProperty -Path $p -Name ${q(valueName)} -PropertyType Binary -Value $b -Force | Out-Null
    'ok'
  `, { json: false });

  return {
    changed: true,
    enabled,
    evidence: `${enabled ? 'Enabled' : 'Disabled'} by writing the approval byte for ` +
      `"${valueName}" under ${key.path}. The original entry was not modified.`,
  };
}

async function setTaskEnabled(item, enabled) {
  // `location` is taskPath + name, e.g. \Microsoft\Windows\Foo\Bar.
  const full = item.location || item.name;
  const cut = full.lastIndexOf('\\');
  const dir = cut >= 0 ? full.slice(0, cut + 1) : '\\';
  const leaf = cut >= 0 ? full.slice(cut + 1) : full;

  await ps(`
    $ErrorActionPreference = 'Stop'
    ${enabled ? 'Enable-ScheduledTask' : 'Disable-ScheduledTask'} -TaskPath ${q(dir)} -TaskName ${q(leaf)} | Out-Null
    'ok'
  `, { json: false });

  return {
    changed: true,
    enabled,
    evidence: `Scheduled task ${full} was ${enabled ? 'enabled' : 'disabled'}. ` +
      'Its definition and its actions are unchanged.',
  };
}

async function setServiceStart(item, enabled) {
  const svc = String(item.location || '').replace(/^Service:\s*/, '') || item.name;
  const mode = enabled ? 'Automatic' : 'Manual';

  await ps(`
    $ErrorActionPreference = 'Stop'
    Set-Service -Name ${q(svc)} -StartupType ${mode}
    'ok'
  `, { json: false });

  return {
    changed: true,
    enabled,
    evidence: `Service "${svc}" start type set to ${mode}. ` +
      (enabled
        ? 'It will start with Windows again.'
        : 'It no longer starts with Windows, but anything that needs it can ' +
          'still start it on demand. It was not disabled outright.'),
  };
}

async function setDesktopEntryHidden(item, enabled) {
  const fsp = require('fs').promises;
  const file = item.location;
  let text = await fsp.readFile(file, 'utf8');
  text = text.replace(/^Hidden\s*=.*$\r?\n?/gim, '');
  if (!enabled) {
    text = text.replace(/^\[Desktop Entry\][ \t]*$/im, '[Desktop Entry]\nHidden=true');
  }
  await fsp.writeFile(file, text, 'utf8');
  return {
    changed: true,
    enabled,
    evidence: `${enabled ? 'Removed' : 'Added'} Hidden=true in ${file}.`,
  };
}

/**
 * Switches one startup item on or off.
 *
 * @param {object} item an entry as `listStartupItems` reported it
 * @param {boolean} enabled the state wanted
 */
async function setStartupItemEnabled(item, enabled) {
  if (!item || !item.kind) throw new Error('No startup item was named.');
  const elevated = await isElevated();
  const control = describeControl(item, { elevated });

  if (!control.method) throw new Error(control.note);
  if (control.needsAdmin && !elevated && control.method !== 'scheduled-task') {
    const err = new Error(
      `"${item.name}" is a machine-wide entry. Close NexaFiles, right-click it ` +
      'and choose "Run as administrator", then try again.');
    err.code = 'NEEDS_ADMIN';
    throw err;
  }

  try {
    switch (control.method) {
      case 'startup-approved': return await setApprovalByte(item, enabled);
      case 'scheduled-task':   return await setTaskEnabled(item, enabled);
      case 'service':          return await setServiceStart(item, enabled);
      case 'desktop-hidden':   return await setDesktopEntryHidden(item, enabled);
      default: throw new Error(control.note);
    }
  } catch (err) {
    // A refusal from Windows is almost always a rights problem, and saying so
    // is more use than passing on "Access is denied."
    if (/denied|UnauthorizedAccess|0x80070005/i.test(err.message)) {
      const e = new Error(
        `Windows refused the change to "${item.name}". This entry needs ` +
        'administrator rights — restart NexaFiles with "Run as administrator".');
      e.code = 'NEEDS_ADMIN';
      throw e;
    }
    throw err;
  }
}

module.exports = {
  APPROVAL_KEYS,
  approvalValueName,
  describeControl,
  readApprovalStates,
  isElevated,
  setStartupItemEnabled,
};
