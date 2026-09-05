'use strict';
// What this machine actually is.
//
// Every field here is read from the operating system or from Electron at the
// moment it is asked for. Nothing is cached across calls, nothing is inferred
// from a marketing name, and anything the platform declines to report comes
// back as null with a reason rather than as a plausible-looking guess — the
// same standard the rest of the application holds itself to.

const os = require('os');

/** Averages the reported clock speed; cores idle at different speeds. */
function cpuSummary() {
  const cpus = os.cpus() || [];
  if (!cpus.length) {
    return { model: null, cores: 0, speedMHz: null, note: 'The OS reported no CPUs.' };
  }
  const speeds = cpus.map((c) => c.speed).filter((n) => n > 0);
  return {
    model: cpus[0].model.trim(),
    cores: cpus.length,
    // os.cpus() reports logical processors, which is what Task Manager calls
    // "Logical processors" and not what it calls "Cores".
    logical: true,
    speedMHz: speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null,
    architecture: os.arch(),
    endianness: os.endianness(),
  };
}

function memorySummary() {
  const total = os.totalmem();
  const free = os.freemem();
  return { totalBytes: total, freeBytes: free, usedBytes: total - free };
}

function osSummary() {
  let version = null;
  try { version = os.version(); } catch { /* not on every platform */ }
  const user = os.userInfo();
  return {
    platform: process.platform,
    release: os.release(),
    version,
    type: os.type(),
    hostname: os.hostname(),
    username: user.username,
    homedir: user.homedir,
    shell: user.shell || null,
    uptimeSeconds: os.uptime(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/**
 * The graphics adapter, as Chromium sees it.
 *
 * `basic` avoids the several-hundred-millisecond cost of the complete probe,
 * and is the level that carries the vendor and device names.
 */
async function graphics(app) {
  try {
    const info = await app.getGPUInfo('basic');
    const device = (info.gpuDevice || []).find((d) => d.active) || (info.gpuDevice || [])[0];
    return {
      vendor: info.auxAttributes?.glVendor || null,
      renderer: info.auxAttributes?.glRenderer || null,
      driverVersion: device?.driverVersion || null,
      deviceId: device ? `${device.vendorId}:${device.deviceId}` : null,
      note: null,
    };
  } catch (err) {
    return { vendor: null, renderer: null, note: `Not reported: ${err.message}` };
  }
}

/** The screens Electron can see, and which one the window is on. */
function displays(screen, browserWindow) {
  try {
    const all = screen.getAllDisplays();
    const current = browserWindow && !browserWindow.isDestroyed()
      ? screen.getDisplayMatching(browserWindow.getBounds())
      : screen.getPrimaryDisplay();
    return all.map((d) => ({
      id: String(d.id),
      widthPx: d.size.width,
      heightPx: d.size.height,
      scaleFactor: d.scaleFactor,
      colorDepth: d.colorDepth,
      internal: !!d.internal,
      current: d.id === current.id,
    }));
  } catch {
    return [];
  }
}

function runtime(app) {
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    userData: app.getPath('userData'),
    execPath: process.execPath,
    packaged: app.isPackaged,
  };
}

/**
 * Everything about the machine, in one call.
 *
 * @param {object} deps Electron's `app`, `screen`, `powerMonitor`, and the window
 */
async function describe({ app, screen, powerMonitor, browserWindow, drives }) {
  const [gpu, driveList] = await Promise.all([
    graphics(app),
    drives ? drives.listDrives().catch(() => []) : Promise.resolve([]),
  ]);

  let power = { onBattery: null, note: 'Power source not reported on this platform.' };
  try {
    power = { onBattery: powerMonitor.isOnBatteryPower(), note: null };
  } catch { /* left as reported above */ }

  return {
    cpu: cpuSummary(),
    memory: memorySummary(),
    os: osSummary(),
    gpu,
    displays: displays(screen, browserWindow),
    drives: driveList,
    power,
    runtime: runtime(app),
    measuredAt: new Date().toISOString(),
  };
}

module.exports = { describe, cpuSummary, memorySummary, osSummary, graphics, displays, runtime };
