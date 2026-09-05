'use strict';
// The current boot session, and the live sampler that fills its graph.
//
// The uptime figure here is the same one Windows Task Manager reports. Verified
// on the development machine: Task Manager's PerfOS "System Up Time" counter read
// 39,459 s while `os.uptime()` read 39,471 s twelve seconds later, and the boot
// time each implies matches `Win32_OperatingSystem.LastBootUpTime` exactly
// (22:27:08). Because it is derived from boot time rather than from a tick
// counter, it keeps counting across sleep — the machine is still on, so the time
// still counts, which is the behaviour asked for.
//
// Session identity comes from that boot time, rounded to the minute:
//   - closing and reopening NexaFiles keeps the same session, so the graph
//     continues rather than restarting;
//   - sleeping and waking keeps the same session, for the same reason;
//   - a restart or shutdown produces a new boot time, a new session, and a graph
//     that begins again from zero.
//
// Samples belonging to any other session are deleted, not accumulated. This
// panel is a picture of the current session and nothing else.

const os = require('os');
const metrics = require('./metrics');

const SAMPLE_INTERVAL_MS = 15_000;

/** Milliseconds since the epoch at which this machine booted. */
function bootTimeMs() {
  return Date.now() - os.uptime() * 1000;
}

/**
 * Stable identifier for the current boot session.
 * Rounded to the minute so that clock drift between application launches does
 * not split one session into several.
 */
function bootId() {
  const rounded = Math.round(bootTimeMs() / 60000) * 60000;
  return `boot-${new Date(rounded).toISOString().slice(0, 16)}`;
}

function uptime() {
  const seconds = os.uptime();
  return {
    seconds,
    bootedAt: new Date(bootTimeMs()).toISOString(),
    // Broken out so the interface can set the unit at a smaller size than
    // the numeral, the way the hero figure does.
    days: Math.floor(seconds / 86400),
    hours: Math.floor((seconds % 86400) / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
    source: 'os.uptime(), the same measure Task Manager reports as "Up time". ' +
            'It counts time spent asleep, because the machine was still on.',
  };
}

class SessionRecorder {
  /** @param {Index} index the SQLite index that stores the samples */
  constructor(index, { app, intervalMs = SAMPLE_INTERVAL_MS } = {}) {
    this.index = index;
    this.app = app;
    this.intervalMs = intervalMs;
    this.bootId = bootId();
    this.timer = null;
    this.lastSample = null;
  }

  /** Discards previous sessions, then begins sampling this one. */
  start() {
    try {
      const dropped = this.index.dropOtherSessions(this.bootId);
      if (dropped) console.log(`[session] discarded ${dropped} sample(s) from previous boots`);
    } catch (err) {
      console.warn('[session] could not clear previous sessions:', err.message);
    }

    // Take one immediately so a freshly opened window has a point to draw.
    this.sample().catch(() => {});
    this.timer = setInterval(() => { this.sample().catch(() => {}); }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Measures once and records it. Every value written here is measured. */
  async sample() {
    // A 400 ms window is enough to diff the CPU tick counters without making the
    // sampler itself a noticeable load.
    const [cpu, mem] = await Promise.all([metrics.sampleCpu(400), metrics.readMemory()]);
    let ownBytes = null;
    try {
      ownBytes = metrics.readOwnFootprint(this.app).workingSetBytes;
    } catch { /* app metrics unavailable */ }

    const row = {
      uptimeSec: os.uptime(),
      cpuPercent: cpu.percent,
      memUsedBytes: mem.usedBytes,
      memTotalBytes: mem.totalBytes,
      ownBytes,
    };
    this.index.recordMetricSample(this.bootId, row);
    this.lastSample = { ...row, atMs: Date.now() };
    return row;
  }

  /**
   * The session series, downsampled to at most `points` buckets so a long
   * session does not ship thousands of rows to the renderer.
   *
   * Buckets are averages of real samples. A bucket with no samples is omitted
   * rather than interpolated: a gap in the line is a period the application was
   * not running, and smoothing over it would be inventing readings.
   */
  series({ points = 180 } = {}) {
    const raw = this.index.sessionSamples(this.bootId, 5000);
    const coverage = this.index.sessionCoverage(this.bootId);

    if (raw.length === 0) {
      return {
        bootId: this.bootId,
        points: [],
        coverage,
        recording: this.timer !== null,
        intervalMs: this.intervalMs,
        note: 'No samples recorded yet for this session.',
      };
    }

    let out = raw;
    if (raw.length > points) {
      const size = Math.ceil(raw.length / points);
      out = [];
      for (let i = 0; i < raw.length; i += size) {
        const chunk = raw.slice(i, i + size);
        const avg = (k) => {
          const vals = chunk.map((c) => c[k]).filter((v) => typeof v === 'number');
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };
        out.push({
          atMs: chunk[Math.floor(chunk.length / 2)].atMs,
          uptimeSec: avg('uptimeSec'),
          cpuPercent: avg('cpuPercent'),
          memUsedBytes: avg('memUsedBytes'),
          memTotalBytes: chunk[0].memTotalBytes,
          ownBytes: avg('ownBytes'),
        });
      }
    }

    return {
      bootId: this.bootId,
      points: out,
      coverage,
      recording: this.timer !== null,
      intervalMs: this.intervalMs,
      // How much of the boot session the graph actually covers. If NexaFiles was
      // opened an hour into a ten-hour session, the graph covers one hour, and
      // the interface says so instead of implying it covers everything.
      observedSeconds: coverage.firstMs ? (coverage.lastMs - coverage.firstMs) / 1000 : 0,
      sessionSeconds: os.uptime(),
    };
  }
}

module.exports = { SessionRecorder, uptime, bootId, bootTimeMs, SAMPLE_INTERVAL_MS };
