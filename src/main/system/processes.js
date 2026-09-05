'use strict';
// Process enumeration.
//
// There is no Node or Electron API for other applications' CPU and memory, so
// this shells out to the platform's own tooling. Verified unelevated on
// Windows 11 26200 (292 processes returned, no elevation prompt).
//
// Deliberately no `systeminformation` dependency: everything needed here is one
// PowerShell or ps invocation, and a dependency that shells out internally would
// add install weight without adding capability.

const { execFile } = require('child_process');
const path = require('path');
const util = require('util');
const execFileP = util.promisify(execFile);

const IS_WIN = process.platform === 'win32';

/** Runs a PowerShell snippet and parses its JSON output. */
async function ps(script, timeout = 15000) {
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
  );
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Lists running processes with their memory and executable path.
 *
 * `cpuPercent` is omitted rather than guessed: a single sample of a cumulative
 * CPU counter is not a utilization figure, and reporting one would be inventing
 * a number. Call `sampleCpuByProcess` if per-process CPU is actually needed.
 */
async function listProcesses() {
  if (IS_WIN) {
    const rows = await ps(`
      Get-Process | ForEach-Object {
        $p = $null
        try { $p = $_.Path } catch { }
        [pscustomobject]@{
          pid  = $_.Id
          name = $_.ProcessName
          rss  = $_.WorkingSet64
          path = $p
        }
      } | ConvertTo-Json -Compress -Depth 3
    `);
    return rows.map((r) => ({
      pid: r.pid,
      name: r.name,
      rssBytes: r.rss || 0,
      execPath: r.path || null,
    }));
  }

  // macOS / Linux
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,rss=,comm='], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) return null;
      return {
        pid: Number(m[1]),
        name: path.basename(m[3]),
        rssBytes: Number(m[2]) * 1024,   // ps reports RSS in kilobytes
        execPath: m[3].startsWith('/') ? m[3] : null,
      };
    })
    .filter(Boolean);
}

/**
 * Per-process CPU as a genuine percentage, measured by diffing two samples of
 * the cumulative CPU-time counter over a known interval.
 *
 * A single reading of total CPU time is not utilization. This takes two.
 */
async function sampleCpuByProcess(intervalMs = 1000) {
  const read = async () => {
    if (IS_WIN) {
      const rows = await ps(`
        Get-Process | ForEach-Object {
          $c = 0.0
          try { if ($_.CPU -ne $null) { $c = [double]$_.CPU } } catch { }
          [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; cpu = $c }
        } | ConvertTo-Json -Compress -Depth 3
      `);
      return new Map(rows.map((r) => [r.pid, { name: r.name, cpuSec: r.cpu || 0 }]));
    }
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,time=,comm='], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const map = new Map();
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+([\d:.]+)\s+(.*)$/);
      if (!m) continue;
      const parts = m[2].split(':').map(Number);
      const sec = parts.reduce((acc, v) => acc * 60 + v, 0);
      map.set(Number(m[1]), { name: path.basename(m[3]), cpuSec: sec });
    }
    return map;
  };

  const t0 = Date.now();
  const a = await read();
  await new Promise((r) => setTimeout(r, intervalMs));
  const b = await read();
  const elapsedSec = (Date.now() - t0) / 1000;

  const cores = require('os').cpus().length || 1;
  const out = [];
  for (const [pid, cur] of b) {
    const prev = a.get(pid);
    if (!prev) continue;                       // started mid-sample; no baseline
    const delta = cur.cpuSec - prev.cpuSec;
    if (delta < 0) continue;                   // pid reused
    // Percentage of one core, then normalised across all cores.
    const pct = (delta / elapsedSec) * 100 / cores;
    out.push({ pid, name: cur.name, cpuPercent: Math.min(100, Math.max(0, pct)) });
  }
  return out.sort((x, y) => y.cpuPercent - x.cpuPercent);
}

/**
 * Reports which of the given paths are in use by a running process.
 *
 * Matching is by executable path and by containment: a process running from
 * inside a directory counts as using that directory. This is conservative by
 * design — it would rather block a safe deletion than allow an unsafe one.
 *
 * This is not a complete open-file-handle check. It catches the case that
 * matters (deleting an application's files while that application runs) but
 * cannot see a process holding a handle to a file elsewhere. The caller must
 * treat a `false` as "no evidence of use", not as proof of safety.
 */
async function pathsInUse(paths) {
  let procs;
  try {
    procs = await listProcesses();
  } catch (err) {
    // If we cannot enumerate processes we must not claim the paths are free.
    return { checked: false, error: err.message, inUse: [] };
  }

  const norm = (p) => (process.platform === 'linux' ? p : p.toLowerCase());
  const running = procs
    .filter((p) => p.execPath)
    .map((p) => ({ ...p, key: norm(path.resolve(p.execPath)) }));

  const inUse = [];
  for (const target of paths) {
    const t = norm(path.resolve(target));
    const holder = running.find(
      (p) => p.key === t || p.key.startsWith(t.endsWith(path.sep) ? t : t + path.sep)
    );
    if (holder) {
      inUse.push({ path: target, pid: holder.pid, process: holder.name, execPath: holder.execPath });
    }
  }
  return { checked: true, inUse };
}

module.exports = { listProcesses, sampleCpuByProcess, pathsInUse };
