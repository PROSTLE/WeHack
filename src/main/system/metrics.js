'use strict';
// System visibility.
//
// This module reports. It offers no way to "free" memory, and that is a design
// decision rather than an omission:
//
//   - On macOS, `purge` and similar tools flush disk caches the OS maintains
//     deliberately; the machine is slower afterwards while it rebuilds them.
//   - On Windows, clearing the standby list needs kernel-level tooling and is
//     genuinely risky.
//
// A modern operating system manages memory better than a userland utility can.
// What can honestly be offered is visibility: what is using memory and CPU
// right now, what starts automatically, and what the user could turn off.

const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

const IS_WIN = process.platform === 'win32';

/** Snapshot of the cumulative per-core CPU tick counters. */
function cpuSnapshot() {
  return os.cpus().map((c) => ({ ...c.times }));
}

/**
 * CPU utilisation as a real percentage.
 *
 * `os.cpus()` returns cumulative tick counters, not percentages. A single call
 * yields a number that describes the whole uptime of the machine, which is
 * useless as a "current load" reading. Two samples are required, and the
 * difference between them is the only honest figure available.
 *
 * @param {number} intervalMs gap between samples
 */
async function sampleCpu(intervalMs = 500) {
  const a = cpuSnapshot();
  await new Promise((r) => setTimeout(r, intervalMs));
  const b = cpuSnapshot();

  let idleDelta = 0, totalDelta = 0;
  const perCore = [];

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const t0 = a[i], t1 = b[i];
    const idle = t1.idle - t0.idle;
    const total =
      (t1.user - t0.user) + (t1.nice - t0.nice) + (t1.sys - t0.sys) +
      (t1.irq - t0.irq) + idle;
    idleDelta += idle;
    totalDelta += total;
    perCore.push(total > 0 ? ((total - idle) / total) * 100 : 0);
  }

  return {
    // Percentage of all cores busy over the sampled interval.
    percent: totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0,
    perCore,
    cores: a.length,
    model: os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown',
    intervalMs,
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Memory.
 *
 * On macOS and Linux `os.freemem()` under-reports what is actually usable,
 * because the OS deliberately keeps free RAM populated with disk cache. "Free
 * memory is low" is normal and healthy on those platforms, so the caveat
 * travels with the number rather than being left for the UI to remember.
 */
async function readMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const result = {
    totalBytes: total,
    freeBytes: free,
    usedBytes: total - free,
    usedPercent: total > 0 ? ((total - free) / total) * 100 : 0,
    availableBytes: null,
    caveat: null,
    measuredAt: new Date().toISOString(),
  };

  if (IS_WIN) {
    // Windows reports an "available" figure that already accounts for reclaimable
    // standby memory, which is closer to what a user means by "free".
    try {
      const { stdout } = await execFileP(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          '(Get-CimInstance Win32_OperatingSystem | Select-Object -ExpandProperty FreePhysicalMemory)'],
        { timeout: 10000, windowsHide: true }
      );
      const kb = parseInt(stdout.trim(), 10);
      if (Number.isFinite(kb)) result.availableBytes = kb * 1024;
    } catch { /* fall back to os.freemem() alone */ }
  } else {
    result.caveat =
      'On this platform the operating system deliberately uses otherwise-free memory ' +
      'as disk cache, so a low "free" figure is normal and is not a problem to fix.';
  }

  return result;
}

/**
 * Load average.
 *
 * `os.loadavg()` returns [0, 0, 0] on Windows — it is a Unix concept with no
 * Windows equivalent — so it is reported as unavailable rather than as zero.
 * Displaying three zeroes would be showing a number that means nothing.
 */
function readLoadAverage() {
  if (IS_WIN) {
    return {
      available: false,
      reason: 'Load average is a Unix measure and has no Windows equivalent.',
      values: null,
    };
  }
  const [one, five, fifteen] = os.loadavg();
  return { available: true, values: { one, five, fifteen }, cores: os.cpus().length };
}

/**
 * NexaFiles' own footprint.
 *
 * An optimizer built on Electron invites an obvious question. Volunteering the
 * number is the honest answer to it, and it costs nothing to show.
 */
function readOwnFootprint(app) {
  const metrics = app.getAppMetrics();
  let workingSetBytes = 0;
  const processes = metrics.map((m) => {
    // Electron reports memory in kilobytes.
    const ws = (m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0) * 1024;
    workingSetBytes += ws;
    return {
      pid: m.pid,
      type: m.type,
      name: m.name || m.serviceName || m.type,
      workingSetBytes: ws,
      cpuPercent: m.cpu ? m.cpu.percentCPUUsage : 0,
    };
  });
  return {
    workingSetBytes,
    processCount: processes.length,
    processes: processes.sort((a, b) => b.workingSetBytes - a.workingSetBytes),
    measuredAt: new Date().toISOString(),
  };
}

function systemInfo() {
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    hostname: os.hostname(),
    uptimeSeconds: os.uptime(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  };
}

module.exports = {
  sampleCpu,
  readMemory,
  readLoadAverage,
  readOwnFootprint,
  systemInfo,
  cpuSnapshot,
};
