// Chart primitives, drawn as inline SVG.
//
// No charting library and no remote assets: the renderer's content security
// policy forbids every external origin, so Google Charts (or any CDN library)
// cannot load here. These are hand-drawn to the same visual language — flat
// fills, a mint accent ramp, generous whitespace, values on the axis rather
// than in a tooltip only.
//
// Every function takes measured values. None of them synthesise a point to make
// a line look better: a gap in the data is drawn as a gap.

const MINT = {
  900: 'var(--mint-900)',
  700: 'var(--mint-700)',
  500: 'var(--mint-500)',
  300: 'var(--mint-300)',
  100: 'var(--mint-100)',
};

export const PALETTE = MINT;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Nice round upper bound for an axis. */
function niceMax(v) {
  if (!v || v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

/**
 * Area chart with a line on top.
 * @param {Array<{x:number, y:number|null, label?:string}>} points
 */
export function areaChart(points, {
  width = 720, height = 190, max = null, unit = '%', pad = { t: 12, r: 10, b: 22, l: 34 },
  colour = MINT[700], fill = MINT[100], format = (v) => Math.round(v) + unit,
  xTicks = 6, gradientId = 'areaFill',
} = {}) {
  const valid = points.filter((p) => typeof p.y === 'number' && Number.isFinite(p.y));
  if (valid.length === 0) return '';

  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const yMax = max !== null ? max : niceMax(Math.max(...valid.map((p) => p.y)) * 1.15);
  const xMin = points[0].x;
  const xMax = points[points.length - 1].x;
  const span = Math.max(1, xMax - xMin);

  const sx = (x) => pad.l + ((x - xMin) / span) * w;
  const sy = (y) => pad.t + h - (Math.min(y, yMax) / yMax) * h;

  // Build the line as segments so a null run becomes a real gap.
  const segments = [];
  let cur = [];
  for (const p of points) {
    if (typeof p.y === 'number' && Number.isFinite(p.y)) cur.push(p);
    else if (cur.length) { segments.push(cur); cur = []; }
  }
  if (cur.length) segments.push(cur);

  const linePaths = segments.map((seg) => {
    const d = seg.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="2"
             stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');

  const areaPaths = segments.filter((s) => s.length > 1).map((seg) => {
    const d = seg.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('')
      + `L${sx(seg[seg.length - 1].x).toFixed(1)},${(pad.t + h).toFixed(1)}`
      + `L${sx(seg[0].x).toFixed(1)},${(pad.t + h).toFixed(1)}Z`;
    return `<path d="${d}" fill="url(#${gradientId})"/>`;
  }).join('');

  // Horizontal guides with labelled values.
  const rows = 4;
  const guides = Array.from({ length: rows + 1 }, (_, i) => {
    const v = (yMax / rows) * i;
    const y = sy(v);
    return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${(pad.l + w).toFixed(1)}" y2="${y.toFixed(1)}"
              stroke="var(--chart-grid)" stroke-width="1"/>
            <text x="${pad.l - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end"
              font-size="10" fill="var(--chart-axis)" font-family="var(--mono)">${esc(format(v))}</text>`;
  }).join('');

  // Labels are thinned by *position*, not by index. Sampling every nth point
  // assumes the points are evenly spread across the axis, and these are not:
  // NexaFiles records while it is open, so a session with a gap in it puts many
  // samples into a narrow band of time, and every label in that band lands on
  // top of the last one. This keeps whichever labels can be read.
  const minGap = Math.max(52, w / Math.max(1, xTicks));
  let lastLabelX = -Infinity;
  const xLabels = points.map((p) => {
    const x = sx(p.x);
    if (!p.label || x - lastLabelX < minGap) return '';
    lastLabelX = x;
    // The first and last labels sit on the plot's own edges, so centring them
    // hangs half of each outside the frame and the browser clips it.
    const anchor = x <= pad.l + 14 ? 'start' : x >= pad.l + w - 14 ? 'end' : 'middle';
    return `<text x="${x.toFixed(1)}" y="${height - 6}" text-anchor="${anchor}"
       font-size="10" fill="var(--chart-axis)">${esc(p.label)}</text>`;
  }).join('');

  const last = valid[valid.length - 1];

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
         preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${fill}" stop-opacity="0.95"/>
          <stop offset="100%" stop-color="${fill}" stop-opacity="0.15"/>
        </linearGradient>
      </defs>
      ${guides}
      ${areaPaths}
      ${linePaths}
      <circle cx="${sx(last.x).toFixed(1)}" cy="${sy(last.y).toFixed(1)}" r="3.5"
              fill="${colour}" stroke="var(--chart-dot-edge)" stroke-width="2"/>
      ${xLabels}
    </svg>`;
}

/**
 * Segmented capacity bar — the shape used for storage and for memory.
 * @param {Array<{label:string, bytes:number, colour:string}>} segments
 */
export function capacityBar(segments, total, { height = 13, showRemainder = true } = {}) {
  const used = segments.reduce((n, s) => n + Math.max(0, s.bytes), 0);
  const cap = Math.max(total, used) || 1;
  const parts = [...segments];
  if (showRemainder && cap > used) {
    parts.push({ label: 'Free', bytes: cap - used, colour: 'var(--chart-track)', muted: true });
  }
  return `
    <div class="capbar" style="height:${height}px" role="img">
      ${parts.map((p) => {
        const pct = (Math.max(0, p.bytes) / cap) * 100;
        if (pct <= 0) return '';
        return `<span class="capbar-seg" style="width:${pct.toFixed(2)}%;background:${p.colour}"
                  title="${esc(p.label)}"></span>`;
      }).join('')}
    </div>`;
}

/**
 * Grouped stacked columns.
 * @param {Array<{group:string, stacks:Array<{label:string,value:number,colour:string}>}>} groups
 */
export function stackedColumns(groups, { height = 190, format = (v) => v, barWidth = 46 } = {}) {
  if (!groups.length) return '';
  const totals = groups.map((g) => g.stacks.reduce((n, s) => n + Math.max(0, s.value), 0));
  const yMax = niceMax(Math.max(...totals, 1) * 1.1);
  const plotH = height - 34;

  return `
    <div class="cols" role="img">
      ${groups.map((g, gi) => {
        const total = totals[gi];
        return `
          <div class="col">
            <div class="col-stack" style="height:${plotH}px">
              ${g.stacks.map((s) => {
                const px = (Math.max(0, s.value) / yMax) * plotH;
                if (px < 0.5) return '';
                return `<span class="col-seg" style="height:${px.toFixed(1)}px;background:${s.colour}"
                          title="${esc(s.label)}: ${esc(format(s.value))}"></span>`;
              }).reverse().join('')}
            </div>
            <div class="col-total">${esc(format(total))}</div>
            <div class="col-label">${esc(g.group)}</div>
          </div>`;
      }).join('')}
    </div>`;
}

/** Small inline trend line for a statistic card. */
export function sparkline(values, { width = 96, height = 30, colour = MINT[700] } = {}) {
  const vals = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (vals.length < 2) return '';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const d = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * width;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join('');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"
    aria-hidden="true"><path d="${d}" fill="none" stroke="${colour}" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Ring gauge for a single measured percentage. */
export function ring(percent, { size = 92, stroke = 9, colour = MINT[700], track = 'var(--chart-track)', label = '' } = {}) {
  const p = Math.max(0, Math.min(100, percent || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - p / 100);
  const mid = size / 2;
  return `
    <svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">
      <circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
      <circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="${colour}" stroke-width="${stroke}"
              stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}"
              stroke-dashoffset="${offset.toFixed(2)}"
              transform="rotate(-90 ${mid} ${mid})"/>
      <text x="${mid}" y="${mid - 1}" text-anchor="middle" dominant-baseline="middle"
            font-size="19" font-weight="700" fill="var(--ink)"
            font-family="var(--display)">${Math.round(p)}</text>
      <text x="${mid}" y="${mid + 15}" text-anchor="middle" dominant-baseline="middle"
            font-size="9" fill="var(--chart-axis)">${esc(label)}</text>
    </svg>`;
}
