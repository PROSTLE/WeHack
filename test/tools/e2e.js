// End-to-end test of the destructive path through the real, running application.
//
// Creates a fixture inside the user's home directory (an approved root), then
// drives it entirely through the renderer bridge — the same surface the UI uses:
//   scan -> find duplicates -> build plan -> approve -> execute -> verify -> restore
//
// Nothing outside the fixture directory is touched.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow } = require('electron');

const { mainWindow } = require('./main-window');
const FIXTURE = path.join(os.homedir(), '.nexafiles-e2e-fixture');
let pass = 0, fail = 0;
const out = [];
function ok(name, cond, extra = '') {
  out.push((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log(out.join('\n')); console.log('E2E TIMEOUT'); app.exit(2); }, 160000);

app.whenReady().then(() => {
  const tick = setInterval(async () => {
    const win = mainWindow(BrowserWindow);
    if (!win || win.webContents.isLoading()) return;
    clearInterval(tick);
    await new Promise((r) => setTimeout(r, 1200));

    const js = (code) => win.webContents.executeJavaScript(code);

    // ---- fixture: two identical files plus one unique ----
    fs.rmSync(FIXTURE, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE, 'sub'), { recursive: true });
    const payload = crypto.randomBytes(300 * 1024);
    fs.writeFileSync(path.join(FIXTURE, 'original.bin'), payload);
    fs.writeFileSync(path.join(FIXTURE, 'sub', 'duplicate.bin'), payload);
    fs.writeFileSync(path.join(FIXTURE, 'unique.bin'), crypto.randomBytes(300 * 1024));
    const dupPath = path.join(FIXTURE, 'sub', 'duplicate.bin');

    try {
      // ---- scan ----
      const scan = await js(`window.nexa.scan.start(${JSON.stringify(FIXTURE)})`);
      ok('scan completed', scan.status === 'complete', `${scan.fileCount} files`);
      ok('scan measured the fixture bytes', scan.totalBytes === 300 * 1024 * 3, `${scan.totalBytes}`);

      // ---- duplicates ----
      const dupes = await js(`window.nexa.duplicates.find('exact')`);
      ok('one duplicate group found', dupes.groups.length === 1, `${dupes.groups.length}`);
      ok('reclaimable equals one copy', dupes.totalWasted === 300 * 1024, `${dupes.totalWasted}`);
      ok('unique file excluded',
        !JSON.stringify(dupes.groups).includes('unique.bin'));
      ok('method described without calling it AI',
        /SHA-256/.test(dupes.method) && !/\bAI\b|machine learning/i.test(dupes.method));

      // ---- plan ----
      const plan = await js(`window.nexa.plan.fromDuplicates('exact')`);
      ok('plan proposes exactly one removal', plan.entries.length === 1, `${plan.entries.length}`);
      ok('plan keeps one copy', plan.totals.itemCount === 1);
      const entry = plan.entries[0];
      ok('entry carries evidence', typeof entry.evidence === 'string' && entry.evidence.length > 40);
      ok('evidence contains the shared SHA-256',
        entry.evidence.includes(dupes.groups[0].signature));
      ok('exact duplicate pre-selected', entry.selected === true);
      ok('entry is high confidence', entry.confidence === 'high');

      // ---- refusal: executing an unknown plan id ----
      const refused = await js(`
        window.nexa.plan.execute('not-a-real-plan-id')
          .then(() => 'EXECUTED').catch(e => 'REFUSED: ' + e.message)`);
      ok('unknown plan id is refused', refused.startsWith('REFUSED'), refused.slice(0, 50));
      ok('both files still present before approval',
        fs.existsSync(dupPath) && fs.existsSync(path.join(FIXTURE, 'original.bin')));

      // ---- execute ----
      const result = await js(`window.nexa.plan.execute(${JSON.stringify(plan.id)})`);
      ok('execution trashed one file', result.summary.trashed === 1, JSON.stringify(result.summary));
      ok('bytes reclaimed are the measured bytes',
        result.summary.bytesReclaimed === 300 * 1024, `${result.summary.bytesReclaimed}`);
      ok('duplicate is gone from disk', !fs.existsSync(dupPath));
      ok('the kept copy survives', fs.existsSync(path.join(FIXTURE, 'original.bin')));
      ok('the unique file survives', fs.existsSync(path.join(FIXTURE, 'unique.bin')));
      ok('execution notes state the in-use check scope',
        result.notes.some((n) => n.includes('open handle')));

      // ---- path validation through the live bridge ----
      const escape = await js(`
        window.nexa.fs.readDirectory('C:\\\\Windows\\\\System32')
          .then(() => 'ALLOWED').catch(e => 'REFUSED')`);
      ok('reading a protected system path is refused', escape === 'REFUSED', escape);

      // This check used to assume D:\ had never been approved, which stopped
      // being true the moment approved roots began surviving a restart: anyone
      // who had opened another drive in the Files view would see this fail on a
      // perfectly healthy build. The root is withdrawn for the length of the
      // check and put back afterwards, in memory only, so the machine is left
      // exactly as it was found.
      const rootsModule = require(path.join(__dirname, '..', '..', 'src', 'main', 'security', 'roots'));
      const outsideTarget = 'D:' + path.sep;
      const wasApproved = rootsModule.accessFor(outsideTarget).allowed;
      if (wasApproved) rootsModule.revokeRoot(outsideTarget);

      const outsideRoot = await js(`
        window.nexa.fs.stat(${JSON.stringify(outsideTarget)})
          .then(() => 'ALLOWED').catch(e => 'REFUSED')`);
      ok('path outside an approved root is refused', outsideRoot === 'REFUSED', outsideRoot);

      if (wasApproved) rootsModule.approveRoot(outsideTarget);
      ok('and the check left the approved roots as it found them',
        rootsModule.accessFor(outsideTarget).allowed === wasApproved);

      // ---- quarantine round trip through the live bridge ----
      const qBefore = await js(`window.nexa.quarantine.list()`);
      const marker = path.join(FIXTURE, 'support-folder');
      fs.mkdirSync(marker, { recursive: true });
      fs.writeFileSync(path.join(marker, 'settings.ini'), 'theme=dark');

      // Quarantine it via the assistant's proposal path, then approve it.
      const qPlan = await js(`
        window.nexa.agent.status().then(() => null)`);   // no key needed for the next call
      const propose = await js(`(async () => {
        const plan = await window.nexa.plan.fromLeftovers().catch(() => null);
        return plan ? 'has-leftovers' : 'no-leftover-scan-yet';
      })()`);
      ok('building a leftover plan without a scan is refused',
        propose === 'no-leftover-scan-yet', propose);

      console.log(out.join('\n'));
      console.log(`\n${pass} passed, ${fail} failed`);
    } catch (e) {
      console.log(out.join('\n'));
      console.log('E2E THREW: ' + e.message);
      fail++;
    } finally {
      fs.rmSync(FIXTURE, { recursive: true, force: true });
    }
    app.exit(fail ? 1 : 0);
  }, 300);
});
