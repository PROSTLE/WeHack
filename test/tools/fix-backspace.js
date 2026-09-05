// Repairs regex word-boundary escapes that were written to disk as literal
// backspace bytes (0x08) by a shell heredoc. `\b` inside a JavaScript regex is a
// word boundary; the same two characters passed through a heredoc became the
// control character, so the pattern silently matched nothing.
const fs = require('fs');
const path = require('path');

const target = process.argv[2];
const buf = fs.readFileSync(target);
const BS = 0x08;

let count = 0;
for (const b of buf) if (b === BS) count++;
console.log(`${path.basename(target)}: ${count} literal backspace byte(s)`);

if (count === 0) { console.log('nothing to repair'); process.exit(0); }

// Show the surrounding source so the repair is visible, then replace each
// backspace with the two characters it should have been.
const text = buf.toString('utf8');
const lines = text.split(/\r?\n/);
lines.forEach((l, i) => {
  if (l.includes('')) {
    console.log(`  line ${i + 1}: ${JSON.stringify(l.trim()).slice(0, 100)}`);
  }
});

const repaired = text.split('').join('\\b');
fs.writeFileSync(target, repaired, 'utf8');

const after = fs.readFileSync(target);
let remaining = 0;
for (const b of after) if (b === BS) remaining++;
console.log(`repaired; ${remaining} backspace byte(s) remain`);
