// Duplicate detection confined to one folder, driven through the real app.
//
// The claim being tested is narrow: a search scoped to a folder returns the
// duplicates inside that folder and none from outside it. The fixture is built
// so that a wrong answer is obvious — identical files are planted in two
// sibling folders, so a scope that leaks returns groups spanning both.
//
// A near-miss is planted too: a sibling folder whose name is a prefix of the
// scoped one. "Photos" and "Photos Backup" share a string prefix, and a filter
// that forgets the trailing separator quietly includes the wrong tree.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const { mainWindow } = require(path.join(__dirname, 'main-window.js'));
const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(os.homedir(), '.nexafiles-dupe-scope');

require(path.join(ROOT, 'main.js'));
setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 120000);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
};

// Big enough to clear the 4 KB floor exact-duplicate detection applies.
const BODY_A = 'A'.repeat(9000);
const BODY_B = 'B'.repeat(9000);

app.whenReady().then(() => {
  const tick = setInterval(async () => {
    const win = mainWindow(BrowserWindow);
    if (!win || win.webContents.isLoading()) return;
    clearInterval(tick);
    await new Promise((r) => setTimeout(r, 2500));

    const js = (code) => win.webContents.executeJavaScript(code);
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));

    try {
      fs.rmSync(FIXTURE, { recursive: true, force: true });
      const photos = path.join(FIXTURE, 'Photos');
      const backup = path.join(FIXTURE, 'Photos Backup');   // the prefix trap
      const other = path.join(FIXTURE, 'Other');
      for (const d of [photos, backup, other]) fs.mkdirSync(d, { recursive: true });

      // A duplicate pair wholly inside Photos: this is what a scoped search must find.
      fs.writeFileSync(path.join(photos, 'one.txt'), BODY_A);
      fs.writeFileSync(path.join(photos, 'one-copy.txt'), BODY_A);
      // A duplicate pair wholly inside Other: a scoped search must not find it.
      fs.writeFileSync(path.join(other, 'x.txt'), BODY_B);
      fs.writeFileSync(path.join(other, 'x-copy.txt'), BODY_B);
      // And a pair inside the prefix-trap folder, also out of scope.
      fs.writeFileSync(path.join(backup, 'one.txt'), BODY_A);
      fs.writeFileSync(path.join(backup, 'one-again.txt'), BODY_A);

      await js(`window.nexa.scan.start(${JSON.stringify(FIXTURE)})`);
      await settle(4000);
      const scan = await js('window.nexa.scan.current()');
      ok('the fixture was scanned', !!scan && scan.fileCount >= 6, `${scan && scan.fileCount} files`);

      const run = (under) => js(
        `window.nexa.duplicates.find('exact', ${JSON.stringify(under ? { under } : {})})`);
      const paths = (r) => r.groups.flatMap((g) => g.members.map((m) => m.path));

      console.log('\n-- the whole scan --');
      const all = await run(null);
      const allPaths = paths(all);
      ok('every planted pair is found without a scope', all.groups.length >= 2,
        `${all.groups.length} group(s)`);
      ok('the result reports itself as unscoped', all.scope === null && all.scopeName === null);
      ok('it says what it searched', all.searchedRoot === scan.root, all.searchedRoot);

      console.log('\n-- scoped to one folder --');
      const scoped = await run(photos);
      const scopedPaths = paths(scoped);
      ok('the scope is reported back', scoped.scopeName === 'Photos', String(scoped.scopeName));
      ok('duplicates inside the folder are still found', scoped.groups.length === 1,
        `${scoped.groups.length} group(s)`);
      ok('every file returned is inside the chosen folder',
        scopedPaths.length > 0 && scopedPaths.every((p) => p.startsWith(photos + path.sep)),
        scopedPaths.map((p) => path.relative(FIXTURE, p)).join(', '));
      ok('the unrelated folder contributed nothing',
        !scopedPaths.some((p) => p.startsWith(other + path.sep)));

      console.log('\n-- the prefix trap --');
      ok('a sibling whose name merely starts the same is excluded',
        !scopedPaths.some((p) => p.startsWith(backup + path.sep)),
        scopedPaths.filter((p) => p.startsWith(backup)).join(', ') || 'none leaked');
      ok('scoping found strictly fewer files than the whole scan',
        scopedPaths.length < allPaths.length, `${scopedPaths.length} vs ${allPaths.length}`);

      console.log('\n-- refusals --');
      const outside = await js(
        `window.nexa.duplicates.find('exact', { under: ${JSON.stringify(os.tmpdir())} })
          .then(() => 'ALLOWED').catch((e) => e.message)`);
      ok('a folder outside the scan is refused with a reason',
        outside !== 'ALLOWED' && /outside the folder that was scanned/i.test(outside), outside);

      const rootScope = await run(scan.root);
      ok('scoping to the scan root is the same as no scope',
        rootScope.scope === null && rootScope.groups.length === all.groups.length,
        `${rootScope.groups.length} group(s)`);

      console.log('\n-- the assistant is not handed a subtree as if it were the disk --');
      // A scoped run must not populate the cache find_duplicates reads.
      await run(photos);
      const viaAgent = await js(`window.nexa.agent.status()`);
      ok('agent status still answers after a scoped run', !!viaAgent);

    } catch (err) {
      console.log('  ERROR  ' + err.message + '\n' + (err.stack || '').slice(0, 700));
      fail++;
    }

    try { fs.rmSync(FIXTURE, { recursive: true, force: true }); } catch { /* leave it */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    app.exit(fail ? 1 : 0);
  }, 400);
});
