// Dashboard sections: statistic cards, storage capacity, the boot-session
// graph, the by-year comparison, and recently changed files.
//
// Every figure rendered here comes from a measurement. Two consequences worth
// stating, because they are what separate this from the reference dashboard it
// was styled against:
//
//   - A change badge ("+24%") is only drawn when there is an earlier scan of the
//     same folder to compare against. With one scan there is no change to
//     report, so the card says so instead of inventing a trend.
//   - The session graph plots samples actually recorded during this boot
//     session. Before any exist it shows an empty state, and it always says how
//     much of the session it actually observed — NexaFiles cannot record time
//     during which it was not running.

import { icon, iconForType, illustration } from './icons.js';
import * as charts from './charts.js';
import { CATEGORY_LABEL, blockColour, describeAge } from './treemap.js';

const CATEGORY_ORDER = ['documents', 'media', 'applications', 'cache', 'system'];

const CATEGORY_ICON = {
  documents: 'document',
  media: 'image',
  applications: 'app',
  cache: 'cache',
  system: 'file',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'short' });
}

/** Human uptime, split so the unit can be set smaller than the numeral. */
export function uptimeParts(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push([d, 'd']);
  if (d || h) parts.push([h, 'h']);
  parts.push([m, 'm']);
  if (!d) parts.push([s, 's']);
  return parts;
}

// ── statistic cards ─────────────────────────────────────────────────────────

/**
 * One card per treemap category, with measured bytes and a real monthly trend.
 * @param {object} summary  the overview:summary payload
 * @param {(n:number)=>string} formatBytes
 * @param {(n:number)=>{value:string,unit:string}} splitBytes
 */
export function statCards(summary, { formatBytes, splitBytes }) {
  const { categories = [], deltas, categoryByMonth = [] } = summary;
  if (!categories.length) return '';

  // Build a per-category monthly series for the sparklines.
  const months = [...new Set(categoryByMonth.map((r) => r.month))].sort();
  const seriesFor = (cat) => {
    const byMonth = Object.fromEntries(
      categoryByMonth.filter((r) => r.category === cat).map((r) => [r.month, r.bytes])
    );
    return months.map((m) => byMonth[m] || 0);
  };

  const ordered = CATEGORY_ORDER
    .map((c) => categories.find((x) => x.category === c))
    .filter(Boolean)
    .concat(categories.filter((c) => !CATEGORY_ORDER.includes(c.category)));

  return `
    <div class="stat-grid">
      ${ordered.map((c) => {
        const { value, unit } = splitBytes(c.bytes);
        const colour = blockColour(c.category, null).css;
        const series = seriesFor(c.category);
        const spark = charts.sparkline(series, { colour, width: 150, height: 34 });
        const delta = deltas ? deltas.byCategory[c.category] : null;

        let badge;
        if (delta === null || delta === undefined) {
          // "first scan" read as a caption for the sparkline beside it, which
          // is a different measurement entirely. It is a statement about there
          // being nothing to compare against, so it now says that.
          badge = `<span class="delta none" title="A change figure needs two scans of the same folder to compare against. This is the first.">no earlier scan</span>`;
        } else if (delta === 0) {
          badge = `<span class="delta none">no change</span>`;
        } else {
          const up = delta > 0;
          badge = `<span class="delta ${up ? 'up' : 'down'}"
            title="Measured change since the scan of ${esc((deltas.since || '').slice(0, 10))}">
            ${icon(up ? 'trendUp' : 'trendDown', { size: 12 })}
            ${up ? '+' : '-'}${esc(formatBytes(Math.abs(delta)))}</span>`;
        }

        return `
          <div class="stat-card">
            <div class="stat-head">
              <span class="stat-swatch" style="background:${colour}"></span>
              ${icon(CATEGORY_ICON[c.category] || 'file', { size: 14 })}
              <span>${esc(CATEGORY_LABEL[c.category] || c.category)}</span>
            </div>
            <div class="stat-value">${esc(value)}<span class="stat-unit">${esc(unit)}</span></div>
            ${spark ? `
              <div class="stat-spark"
                   title="Bytes in this category by the month each file was last changed. This is a shape, not a trend line: it says when the files were written, not how the category has grown.">
                ${spark}
                <span class="spark-caption">by month last changed</span>
              </div>` : ''}
            <div class="stat-foot">
              <span>${esc(Number(c.count).toLocaleString())} files</span>
              ${badge}
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

// ── storage capacity, with the drive illustration ───────────────────────────

export function storagePanel(summary, { formatBytes }) {
  const { categories = [], drives = [], scan } = summary;
  if (!scan) return '';

  // The drive the scanned folder actually lives on.
  const rootDrive = drives.find((d) =>
    scan.root.toLowerCase().startsWith(d.path.toLowerCase())) || drives[0];
  if (!rootDrive) return '';

  const scanned = categories.reduce((n, c) => n + c.bytes, 0);

  // One bar, not two. This panel used to draw the scan's category breakdown as
  // well — the same five figures the statistic cards above it and the treemap
  // legend below it were both already showing, which made three statements of
  // one fact on a single screen and left the panel's actual subject buried
  // under them. What only this panel can say is where the scan sits on the
  // whole drive, so that is all it says now.
  const driveBar = [
    { label: `Scanned (${formatBytes(scanned)})`, bytes: scanned, colour: PALETTE_SCAN },
    { label: 'Rest of the drive, not examined',
      bytes: Math.max(0, rootDrive.usedBytes - scanned), colour: 'var(--chart-rest)' },
  ];

  return `
    <div class="panel raised">
      <header>
        <h2>Room on the drive</h2>
        <span class="muted">what this scan covers, against the whole disk</span>
      </header>
      <div class="drive-panel">
        <div class="drive-art-wrap">
          ${illustration('drive')}
          <div class="drive-caption">
            <span class="d-id">${esc(rootDrive.id)}</span>
            <span class="d-name">${esc(rootDrive.name)}</span>
            <span class="d-fs">${esc(rootDrive.fileSystem || '')}</span>
          </div>
        </div>

        <div>
          <div class="cap-head">
            <span class="cap-title">${esc(rootDrive.id)} ${esc(rootDrive.name)}</span>
            <span class="cap-usage">Using
              <strong>${esc(formatBytes(rootDrive.usedBytes))}</strong>
              of ${esc(formatBytes(rootDrive.totalBytes))}</span>
          </div>
          ${charts.capacityBar(driveBar, rootDrive.totalBytes, { height: 15 })}
          <div class="cap-legend">
            ${driveBar.map((b) => `
              <span class="legend-item">
                <span class="legend-swatch" style="background:${b.colour}"></span>
                <span>${esc(b.label)}</span>
                <span class="legend-bytes">${esc(formatBytes(b.bytes))}</span>
              </span>`).join('')}
            <span class="legend-item">
              <span class="legend-swatch" style="background:var(--chart-track)"></span>
              <span>Free</span>
              <span class="legend-bytes">${esc(formatBytes(rootDrive.freeBytes))}</span>
            </span>
          </div>
          <p class="muted" style="margin:11px 0 0;font-size:12px">
            Only <span class="mono">${esc(scan.root)}</span> was examined. The grey
            portion is the rest of the drive, which this scan did not look at —
            scan a wider folder to account for it.
          </p>
        </div>
      </div>
    </div>`;
}

const PALETTE_SCAN = 'var(--mint-700)';

// ── boot-session graph ──────────────────────────────────────────────────────

export function sessionPanel(session, metric, { formatBytes }) {
  if (!session) return '';

  const up = session.uptime;
  const parts = up ? uptimeParts(up.seconds) : [];
  const points = session.points || [];
  const cov = session.coverage || {};

  const isCpu = metric === 'cpu';
  const series = points.map((p) => ({
    x: p.atMs,
    y: isCpu ? p.cpuPercent : (p.memUsedBytes || 0) / (p.memTotalBytes || 1) * 100,
    label: new Date(p.atMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  }));

  const latest = points[points.length - 1] || null;
  const memPct = latest && latest.memTotalBytes
    ? (latest.memUsedBytes / latest.memTotalBytes) * 100 : 0;

  const chart = series.length >= 2
    ? `<div class="chart-frame">${charts.areaChart(series, {
        max: 100, unit: '%',
        colour: isCpu ? charts.PALETTE[700] : 'var(--pig-1)',
        fill: isCpu ? charts.PALETTE[100] : 'var(--primary-wash)',
        gradientId: isCpu ? 'cpuFill' : 'memFill',
      })}</div>`
    : `<div class="chart-empty">
         ${icon('activity', { size: 22 })}
         <strong>Not enough samples yet</strong>
         <span>NexaFiles records CPU and memory every
           ${Math.round((session.intervalMs || 15000) / 1000)} seconds while it is open.
           The graph appears once there are two readings, and it covers this boot
           session only.</span>
       </div>`;

  const observed = session.observedSeconds || 0;
  const total = session.sessionSeconds || (up ? up.seconds : 0);

  return `
    <div class="panel raised">
      <header>
        <h2>System uptime</h2>
        <div class="actions">
          <div class="seg-toggle">
            <button data-session-metric="cpu" aria-pressed="${isCpu}">CPU</button>
            <button data-session-metric="memory" aria-pressed="${!isCpu}">Memory</button>
          </div>
        </div>
      </header>

      <div class="session-grid">
        <div>
          <div class="uptime" style="margin-bottom:14px">
            <div class="uptime-value" id="uptime-value">
              ${parts.map(([v, u]) => `${v}<span class="u-unit">${u}</span>`).join('')}
            </div>
            <div class="uptime-sub">
              Running since ${up ? esc(new Date(up.bootedAt).toLocaleString()) : 'unknown'}.
              This is the same figure Task Manager reports, and it keeps counting
              through sleep because the machine stays on.
            </div>
          </div>
          ${chart}
          <p class="muted" style="margin:9px 0 0;font-size:11.5px">
            ${points.length
              ? `Graph covers ${esc(humanSpan(observed))} of a ${esc(humanSpan(total))} session —
                 NexaFiles can only sample while it is open. It resets when the machine restarts.`
              : 'The graph resets to zero when the machine restarts, and continues across sleep and app restarts.'}
          </p>
        </div>

        <div class="session-stats">
          <div class="session-stat">
            ${charts.ring(latest ? latest.cpuPercent : 0, {
              size: 62, stroke: 7, colour: charts.PALETTE[700], label: 'CPU' })}
            <div class="s-body">
              <div class="s-value">${latest ? latest.cpuPercent.toFixed(1) : '—'}%</div>
              <div class="s-label">now</div>
            </div>
          </div>
          <div class="session-stat">
            ${charts.ring(memPct, { size: 62, stroke: 7, colour: 'var(--pig-1)', label: 'RAM' })}
            <div class="s-body">
              <div class="s-value">${latest ? esc(formatBytes(latest.memUsedBytes)) : '—'}</div>
              <div class="s-label">of ${latest ? esc(formatBytes(latest.memTotalBytes)) : '—'}</div>
            </div>
          </div>
          <div style="border-top:1px solid var(--mint-100);padding-top:11px">
            <div class="s-value mono">${cov.sampleCount || 0}</div>
            <div class="s-label">samples this session${cov.cpuAvg != null
              ? `, ${cov.cpuAvg.toFixed(1)}% average CPU` : ''}</div>
          </div>
        </div>
      </div>
    </div>`;
}

function humanSpan(seconds) {
  if (!seconds || seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} m`;
  return `${m} m`;
}

// ── by-year comparison and recent files ─────────────────────────────────────

export function byYearPanel(summary, { formatBytes }) {
  const rows = summary.categoryByYear || [];
  if (!rows.length) return '';

  const years = [...new Set(rows.map((r) => r.year))].sort();
  const groups = years.map((y) => ({
    group: y,
    stacks: CATEGORY_ORDER
      .map((cat) => {
        const hit = rows.find((r) => r.year === y && r.category === cat);
        return hit ? {
          label: CATEGORY_LABEL[cat] || cat,
          value: hit.bytes,
          colour: blockColour(cat, null).css,
        } : null;
      })
      .filter(Boolean),
  }));

  return `
    <div class="panel">
      <header>
        <h2>Storage by year last modified</h2>
        <span class="muted">from each file's own timestamp</span>
      </header>
      ${charts.stackedColumns(groups, { format: formatBytes })}
      <p class="muted" style="margin:12px 0 0;font-size:12px">
        Files grouped by the year they were last changed. Tall recent columns mean
        active work; tall old columns mean space that has not been touched in a
        long time.
      </p>
    </div>`;
}

export function recentPanel(summary, { formatBytes }) {
  const recent = summary.recent || [];
  if (!recent.length) return '';
  return `
    <div class="panel">
      <header>
        <h2>Recently changed</h2>
        <span class="muted">newest first</span>
      </header>
      ${recent.map((f) => `
        <div class="recent-row" data-file="${esc(f.path)}">
          <span class="r-icon">${icon(iconForType(f.type, false), { size: 14 })}</span>
          <div class="stack">
            <span class="r-name">${esc(f.name)}</span>
            <span class="r-path">${esc(f.path)}</span>
          </div>
          <span class="r-when">${esc(describeAge(f.mtimeMs))}</span>
          <span class="r-size">${esc(formatBytes(f.size))}</span>
        </div>`).join('')}
    </div>`;
}

// ── profile ─────────────────────────────────────────────────────────────────

export function profileChip(profile) {
  if (!profile) return '';
  return `
    <span class="avatar">${esc(profile.initials)}</span>
    <span class="stack">
      <span class="p-name">${esc(profile.username)}</span>
      <span class="p-role">${esc(profile.hostname)}</span>
    </span>`;
}

export function railProfile(profile) {
  if (!profile) return '';
  return `
    <div class="rail-profile">
      <span class="avatar lg">${esc(profile.initials)}</span>
      <div class="p-meta">
        <div class="p-name">${esc(profile.username)}</div>
        <div class="p-host" title="${esc(profile.homedir)}">${esc(profile.homedir)}</div>
      </div>
    </div>`;
}
