const { extractText } = require('../../src/main/classify/extract.js');
const fs = require('fs'), path = require('path'), os = require('os');

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('$') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (['pdf','docx','pptx','xlsx','doc'].includes(ext)) out.push(p);
    }
  }
  return out;
}

(async () => {
  const files = walk(os.homedir()).slice(0, 200);
  const byExt = {};
  let okCount = 0, textCount = 0;
  const rows = [];
  for (const f of files) {
    const t0 = Date.now();
    const r = await extractText(f);
    const ms = Date.now() - t0;
    const ext = r.extension;
    byExt[ext] = byExt[ext] || { n: 0, ok: 0, withText: 0, chars: 0, ms: 0 };
    byExt[ext].n++; byExt[ext].ms += ms;
    if (r.ok) { byExt[ext].ok++; okCount++; }
    if (r.ok && r.chars > 50) { byExt[ext].withText++; textCount++; byExt[ext].chars += r.chars; }
    rows.push({ f, r, ms });
  }
  console.log('files tried:', files.length);
  console.log('');
  console.log('ext    tried   parsed  with-text   avg chars   avg ms');
  for (const [ext, s] of Object.entries(byExt)) {
    console.log('  ' + ext.padEnd(6) + String(s.n).padStart(4) + String(s.ok).padStart(9) +
      String(s.withText).padStart(11) + String(s.withText ? Math.round(s.chars/s.withText) : 0).padStart(12) +
      String(Math.round(s.ms/s.n)).padStart(9));
  }
  console.log('');
  console.log('=== sample extracted text (proof it is real) ===');
  const shown = new Set();
  for (const { f, r } of rows) {
    if (!r.ok || r.chars < 200 || shown.has(r.extension)) continue;
    shown.add(r.extension);
    console.log('');
    console.log(r.extension.toUpperCase() + '  ' + path.basename(f));
    console.log('  method: ' + r.method + '  |  ' + r.note);
    console.log('  chars: ' + r.chars);
    console.log('  text: "' + r.text.slice(0, 220).replace(/\s+/g,' ') + '..."');
  }
  console.log('');
  console.log('=== files that yielded no text (honest failures) ===');
  let n = 0;
  for (const { f, r } of rows) {
    if (r.ok && r.chars < 50 && n < 6) { n++; console.log('  ' + path.basename(f).slice(0,50) + '  -> ' + r.note.slice(0,110)); }
    if (!r.ok && n < 12) { n++; console.log('  ' + path.basename(f).slice(0,50) + '  -> NOT PARSED: ' + r.note.slice(0,90)); }
  }
})();
