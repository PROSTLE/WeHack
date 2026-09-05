// Runs the real extractor over a handful of ordinary PDFs and prints what it
// got, so a failure can be traced to a specific stage rather than guessed at.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractText } = require('../../src/main/classify/extract.js');

function findPdfs(dir, out = [], depth = 0) {
  if (depth > 5 || out.length >= 8) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('$') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findPdfs(p, out, depth + 1);
    else if (/\.pdf$/i.test(e.name) && !/webfetch|media_/i.test(e.name)) {
      try { if (fs.statSync(p).size > 20000) out.push(p); } catch { /* skip */ }
    }
    if (out.length >= 8) return out;
  }
  return out;
}

(async () => {
  const files = findPdfs(path.join(os.homedir(), 'Documents'));
  console.log(`testing ${files.length} ordinary PDFs\n`);
  for (const f of files) {
    const r = await extractText(f);
    console.log(path.basename(f).slice(0, 46));
    console.log(`   ok=${r.ok} chars=${r.chars}`);
    console.log(`   note: ${r.note}`);
    if (r.chars) console.log(`   text: ${JSON.stringify(r.text.slice(0, 160))}`);
    console.log('');
  }
})();
