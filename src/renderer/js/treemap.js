// Squarified treemap.
//
// Area is bytes. Hue is category. Saturation is recency: a block accessed this
// week renders at full strength, one untouched for a year renders washed out
// against the same hue. That is the mechanism that makes the map self-
// explaining — a large, pale block is obviously stale space without a word of
// explanation, and it is the one place in this interface where a continuous
// value is encoded as a colour ramp.

const PIGMENT = {
  applications: { h: 234, s: 64, l: 48 },   /* ultramarine */
  documents:    { h: 173, s: 80, l: 30 },   /* viridian */
  media:        { h: 47,  s: 70, l: 47 },   /* ochre */
  cache:        { h: 307, s: 55, l: 39 },   /* plum */
  system:       { h: 219, s: 22, l: 45 },   /* slate */
};

export const CATEGORY_LABEL = {
  applications: 'Applications',
  documents:    'Documents & user data',
  media:        'Media',
  cache:        'Caches & regenerable',
  system:       'System & unclassified',
};

const DAY = 86_400_000;

// Which ground the map is being drawn on. Recency fades *away* from the ground
// it sits on: on porcelain a stale block washes out towards white, and on a
// dark ground it sinks towards black. Fading towards white on a dark ground
// would make the stalest space the loudest thing on screen, which is precisely
// backwards.
let dark = false;

/** Called by the renderer whenever the theme changes. */
export function setDark(value) { dark = !!value; }

/**
 * Colour for one block.
 * @param {string} category
 * @param {number|null} lastAccessMs
 */
export function blockColour(category, lastAccessMs) {
  const base = PIGMENT[category] || PIGMENT.system;
  let factor = 1;

  if (lastAccessMs) {
    const ageDays = (Date.now() - lastAccessMs) / DAY;
    if (ageDays <= 7) factor = 1;
    else if (ageDays >= 365) factor = 0.35;
    else {
      // Linear between one week and one year, floored at 35%.
      factor = 1 - 0.65 * ((ageDays - 7) / (365 - 7));
    }
  }

  const s = Math.round(base.s * factor);
  // Fresh blocks sit a little brighter on a dark ground so the pigment still
  // reads as pigment; stale ones then sink rather than wash out.
  const lit = dark ? base.l + 8 : base.l;
  const l = Math.round(dark
    ? lit - (1 - factor) * 20
    : lit + (1 - factor) * 26);
  return { css: `hsl(${base.h} ${s}% ${l}%)`, lightness: l };
}

/** Squarified treemap layout. Returns rectangles in the given bounds. */
export function layout(items, width, height) {
  const total = items.reduce((n, i) => n + Math.max(0, i.bytes), 0);
  if (total <= 0 || width <= 0 || height <= 0) return [];

  const scale = (width * height) / total;
  const nodes = items
    .filter((i) => i.bytes > 0)
    .map((i) => ({ ...i, area: i.bytes * scale }))
    .sort((a, b) => b.area - a.area);

  const out = [];
  let x = 0, y = 0, w = width, h = height;
  let row = [];

  const shortest = () => Math.min(w, h);

  /** Worst aspect ratio in a row given the side length it will occupy. */
  const worst = (r, side) => {
    if (r.length === 0 || side === 0) return Infinity;
    const sum = r.reduce((n, i) => n + i.area, 0);
    const max = Math.max(...r.map((i) => i.area));
    const min = Math.min(...r.map((i) => i.area));
    const s2 = side * side, sum2 = sum * sum;
    return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
  };

  const emit = (r) => {
    const sum = r.reduce((n, i) => n + i.area, 0);
    if (sum <= 0) return;
    const horizontal = w >= h;
    const thickness = sum / (horizontal ? h : w);
    let offset = 0;
    for (const item of r) {
      const length = item.area / thickness;
      if (horizontal) {
        out.push({ ...item, x, y: y + offset, w: thickness, h: length });
      } else {
        out.push({ ...item, x: x + offset, y, w: length, h: thickness });
      }
      offset += length;
    }
    if (horizontal) { x += thickness; w -= thickness; }
    else { y += thickness; h -= thickness; }
  };

  for (const node of nodes) {
    const side = shortest();
    if (row.length === 0 || worst([...row, node], side) <= worst(row, side)) {
      row.push(node);
    } else {
      emit(row);
      row = [node];
    }
    if (w <= 0 || h <= 0) break;
  }
  if (row.length) emit(row);

  return out;
}

/** Renders the treemap into `container`. */
export function render(container, items, { onSelect, selectedPath, formatBytes }) {
  container.innerHTML = '';
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (!width || !height) return;

  const rects = layout(items, width, height);

  for (const r of rects) {
    const { css, lightness } = blockColour(r.category, r.newestAccessMs);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tm-block' + (r.w < 34 || r.h < 24 ? ' tiny' : '');
    // Contrast against the block's own lightness, not a fixed guess.
    el.classList.add(lightness > 58 ? 'dark-text' : 'light-text');
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${Math.max(0, r.w - 1)}px`;
    el.style.height = `${Math.max(0, r.h - 1)}px`;
    el.style.background = css;
    if (selectedPath === r.path) el.setAttribute('aria-selected', 'true');

    const age = r.newestAccessMs
      ? `, last opened ${describeAge(r.newestAccessMs)}`
      : '';
    el.title = `${r.name}\n${formatBytes(r.bytes)}${age}\n${r.path}`;
    el.setAttribute('aria-label', `${r.name}, ${formatBytes(r.bytes)}${age}`);
    el.innerHTML =
      `<div class="tm-name">${escapeHtml(r.name)}</div>` +
      `<div class="tm-size">${formatBytes(r.bytes)}</div>`;

    el.addEventListener('click', () => onSelect(r));
    container.appendChild(el);
  }
}

export function describeAge(ms) {
  const days = Math.floor((Date.now() - ms) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = (days / 365).toFixed(days < 730 ? 0 : 1);
  return `${years} year${Number(years) === 1 ? '' : 's'} ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
