// Simulates what electron-builder would put inside app.asar, using the exact
// `build.files` globs from package.json, then launches the app from that
// isolated copy.
//
// This is the direct test for the defect where `build.files` omitted the
// application's backend: any file the running app needs but the glob does not
// match will be missing here, and the app will fail to start.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const patterns = pkg.build.files;
const stage = path.join(root, 'dist-sim', 'app');

/** Minimal glob matcher covering the pattern styles electron-builder uses. */
function toRegExp(pattern) {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  const rx = body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/\*/g, '§ANY§')
    .replace(/\*\*/g, '§ANY§')
    .replace(/\*/g, '[^/]*')
    .replace(/§ANY§/g, '.*')
    .replace(/\?/g, '.');
  return { negated, re: new RegExp('^' + rx + '$') };
}

const rules = patterns.map(toRegExp);

function included(rel) {
  const p = rel.split(path.sep).join('/');
  let inc = false;
  for (const { negated, re } of rules) {
    if (re.test(p)) inc = !negated;
  }
  return inc;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'dist-sim', 'test'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else acc.push(path.relative(root, full));
  }
  return acc;
}

fs.rmSync(path.join(root, 'dist-sim'), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const all = walk(root);
const picked = all.filter(included);
const skipped = all.filter((f) => !included(f));

for (const rel of picked) {
  const dest = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, rel), dest);
}

// package.json itself is always included by electron-builder.
fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));

console.log(`staged ${picked.length} file(s) from build.files globs`);
console.log(`excluded ${skipped.length} file(s)`);
console.log('\nincluded:');
for (const f of picked) console.log('  ' + f);
console.log('\nexcluded:');
for (const f of skipped) console.log('  ' + f);

// Runtime dependencies must be empty for this simulation to be valid without
// copying node_modules.
const deps = Object.keys(pkg.dependencies || {});
console.log('\nruntime dependencies:', deps.length ? deps.join(', ') : 'none');

// Now launch the staged copy and confirm it starts and renders.
const probe = path.join(stage, '__probe.js');
fs.writeFileSync(probe, `
const path = require('path');
const { app, BrowserWindow } = require('electron');
const failures = [];
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => { if (e.level >= 2) failures.push(e.message); });
  win.webContents.on('did-fail-load', (_ev, c, d, u) => failures.push('did-fail-load ' + d + ' ' + u));
  win.webContents.on('preload-error', (_ev, p, err) => failures.push('preload-error ' + err.message));
});
require(path.join(__dirname, 'main.js'));
setTimeout(() => { console.log('PACKAGED-TIMEOUT'); app.exit(2); }, 30000);
app.whenReady().then(() => {
  const t = setInterval(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.webContents.isLoading()) return;
    clearInterval(t);
    await new Promise(r => setTimeout(r, 2500));
    try {
      const r = await win.webContents.executeJavaScript(
        "(() => { try {" +
        "  const h = document.querySelector('.empty h2');" +
        "  return { rail: document.querySelector('#rail').children.length," +
        "           stage: (document.getElementById('stage').innerText || '').slice(0,90)," +
        "           bridge: typeof window.nexa," +
        "           icons: document.querySelectorAll('svg.icon, svg.illustration').length," +
        "           displayFont: h ? getComputedStyle(h).fontFamily : 'no heading rendered' };" +
        "} catch (e) { return { probeError: e.message }; } })()");
      console.log('PACKAGED-PROBE ' + JSON.stringify(r));
    } catch (e) { console.log('PACKAGED-PROBE-FAILED ' + e.message); failures.push(e.message); }
    if (failures.length) console.log('PACKAGED-FAILURES ' + JSON.stringify(failures));
    console.log(failures.length ? 'PACKAGED-RESULT FAIL' : 'PACKAGED-RESULT OK');
    app.exit(failures.length ? 1 : 0);
  }, 300);
});
`);

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(electron, [probe], { stdio: 'inherit', env, cwd: stage });
process.exit(r.status === 0 ? 0 : 1);
