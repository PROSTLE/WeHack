// Generates the application icon: a treemap mark in the product palette.
// Written with the same dependency-free PNG encoder the tests use, so building
// the icon needs no image tooling.
const fs = require('fs');
const path = require('path');
const { makePng } = require('../make-png.js');

const GROUND = [238, 241, 245];
const BLOCKS = [
  // x, y, w, h in a 0..1 grid, colour — the five pigments, laid out as a map.
  [0.00, 0.00, 0.52, 0.58, [44, 63, 203]],    // ultramarine
  [0.52, 0.00, 0.48, 0.34, [15, 138, 126]],   // viridian
  [0.52, 0.34, 0.28, 0.24, [201, 162, 39]],   // ochre
  [0.80, 0.34, 0.20, 0.24, [155, 45, 143]],   // plum
  [0.00, 0.58, 0.30, 0.42, [91, 107, 140]],   // slate
  [0.30, 0.58, 0.34, 0.42, [15, 138, 126]],   // viridian
  [0.64, 0.58, 0.36, 0.42, [44, 63, 203]],    // ultramarine
];

function render(size) {
  const pad = Math.round(size * 0.10);
  const inner = size - pad * 2;
  const gap = Math.max(1, Math.round(size * 0.018));
  const radius = Math.round(size * 0.16);

  return makePng(size, size, (x, y) => {
    // Rounded-square mask, so the mark reads as an app icon rather than a chart.
    const cx = Math.min(x, size - 1 - x);
    const cy = Math.min(y, size - 1 - y);
    if (cx < radius && cy < radius) {
      const dx = radius - cx, dy = radius - cy;
      if (dx * dx + dy * dy > radius * radius) return GROUND;
    }

    const fx = (x - pad) / inner;
    const fy = (y - pad) / inner;
    if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return [225, 230, 236];

    for (const [bx, by, bw, bh, colour] of BLOCKS) {
      const x0 = pad + bx * inner, y0 = pad + by * inner;
      const x1 = x0 + bw * inner, y1 = y0 + bh * inner;
      if (x >= x0 + gap / 2 && x < x1 - gap / 2 && y >= y0 + gap / 2 && y < y1 - gap / 2) {
        return colour;
      }
    }
    return [225, 230, 236];   // the gaps between blocks
  });
}

const out = path.join(__dirname, '..', '..', 'assets');
fs.mkdirSync(out, { recursive: true });
for (const size of [512, 256, 128, 64, 32, 16]) {
  const file = size === 512 ? 'icon.png' : `icon-${size}.png`;
  fs.writeFileSync(path.join(out, file), render(size));
  console.log(`wrote assets/${file} (${size}x${size})`);
}
