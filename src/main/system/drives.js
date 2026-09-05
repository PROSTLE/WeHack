'use strict';
// Drive and volume enumeration.
//
// The previous implementation shelled out to `wmic`. Microsoft has deprecated
// it and it is absent on current Windows builds — verified absent on the
// Windows 11 26200 machine this was developed against, which means the old
// drive list returned nothing at all there. This uses Get-CimInstance instead.

const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

async function ps(script, timeout = 15000) {
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
  );
  const t = stdout.trim();
  if (!t) return [];
  const parsed = JSON.parse(t);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function listDrives() {
  if (process.platform === 'win32') {
    // DriveType 3 = local fixed disk, 2 = removable.
    const rows = await ps(`
      Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3 OR DriveType=2' -ErrorAction SilentlyContinue |
        ForEach-Object {
          [pscustomobject]@{
            id = $_.DeviceID; label = $_.VolumeName; size = $_.Size
            free = $_.FreeSpace; type = $_.DriveType; fs = $_.FileSystem
          }
        } | ConvertTo-Json -Compress -Depth 3
    `);
    return rows
      .filter((r) => r.id)
      .map((r) => ({
        id: r.id,
        name: r.label || (r.type === 2 ? 'Removable' : 'Local disk'),
        path: r.id + path.sep,
        totalBytes: Number(r.size) || 0,
        freeBytes: Number(r.free) || 0,
        usedBytes: (Number(r.size) || 0) - (Number(r.free) || 0),
        fileSystem: r.fs || null,
        removable: r.type === 2,
      }));
  }

  // macOS and Linux: df reports every mounted filesystem.
  const { stdout } = await execFileP('df', ['-kP'], { maxBuffer: 4 * 1024 * 1024 });
  const lines = stdout.trim().split('\n').slice(1);
  const drives = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [filesystem, blocks, , available] = parts;
    const mount = parts.slice(5).join(' ');
    // Pseudo-filesystems carry no useful capacity figure.
    if (/^(devfs|map|tmpfs|udev|overlay|none|proc|sysfs)$/.test(filesystem)) continue;
    if (mount.startsWith('/System/Volumes/') && mount !== '/System/Volumes/Data') continue;
    const total = (parseInt(blocks, 10) || 0) * 1024;
    const free = (parseInt(available, 10) || 0) * 1024;
    if (total === 0) continue;
    drives.push({
      id: mount,
      name: mount === '/' ? (process.platform === 'darwin' ? 'Macintosh HD' : 'Root') : path.basename(mount),
      path: mount,
      totalBytes: total,
      freeBytes: free,
      usedBytes: total - free,
      fileSystem: filesystem,
      removable: mount.startsWith('/Volumes/') || mount.startsWith('/media/') || mount.startsWith('/mnt/'),
    });
  }
  return drives;
}

/** The standard per-user folders, filtered to those that actually exist. */
function specialFolders() {
  const fs = require('fs');
  const home = os.homedir();
  const candidates = [
    ['Home', home],
    ['Desktop', path.join(home, 'Desktop')],
    ['Documents', path.join(home, 'Documents')],
    ['Downloads', path.join(home, 'Downloads')],
    ['Pictures', path.join(home, 'Pictures')],
    ['Music', path.join(home, 'Music')],
    ['Videos', path.join(home, process.platform === 'darwin' ? 'Movies' : 'Videos')],
  ];
  return candidates
    .filter(([, p]) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
    .map(([name, p]) => ({ name, path: p }));
}

module.exports = { listDrives, specialFolders };
