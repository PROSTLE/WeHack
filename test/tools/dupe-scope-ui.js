// The folder-scope control in the Duplicates view, driven by clicking it.
//
// The native folder dialog cannot be clicked by a test, so it is the one thing
// replaced: `showOpenDialog` answers with the folder this test wants chosen.
// Everything after that is the real control — the real click handler, the real
// bridge call, the real scoped search, the real panel.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, dialog } = require('electron');

const { mainWindow } = require(path.join(__dirname, 'main-window.js'));
const ROOT = path.join(__dirname, '..', '..');
const OUT = process.env.NEXA_OUT || __dirname;
const FIXTURE = path.join(os.homedir(), '.nexafiles-dupe-scope-ui');
const PHOTOS = path.join(FIXTURE, 'Photos');

// The one stub: the folder the user "chooses".
let chooses = PHOTOS;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chooses] });

require(path.join(ROOT, 'main.js'));
setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 120000);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
};

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
    const shot = async (n) => {
      fs.writeFileSync(path.join(OUT, `${n}.png`), (await win.webContents.capturePage()).toPNG());
      console.log('   captured', `${n}.png`);
    };
    const text = (sel) => js(
      `document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g,' ').trim() || ''`);

    try {
      fs.rmSync(FIXTURE, { recursive: true, force: true });
      const other = path.join(FIXTURE, 'Other');
      for (const d of [PHOTOS, other]) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(PHOTOS, 'one.txt'), BODY_A);
      fs.writeFileSync(path.join(PHOTOS, 'one-copy.txt'), BODY_A);
      fs.writeFileSync(path.join(other, 'x.txt'), BODY_B);
      fs.writeFileSync(path.join(other, 'x-copy.txt'), BODY_B);

      await js(`window.nexa.scan.start(${JSON.stringify(FIXTURE)})`);
      await settle(4000);

      await js(`document.querySelector('[data-view="duplicates"]').click()`);
      await settle(600);

      console.log('-- the control is there and states the default --');
      ok('the scope bar is drawn', await js(`!!document.querySelector('.dupe-scope')`));
      const initial = await text('.dupe-scope-value');
      ok('it says the search covers everything scanned',
        /everything scanned/i.test(initial), initial);
      ok('a "choose a folder" button is offered',
        await js(`!!document.getElementById('dupe-pick-folder')`));
      ok('no "whole scan" reset is shown while nothing is narrowed',
        await js(`!document.getElementById('dupe-clear-folder')`));
      await shot('dupe-scope-1-default');

      console.log('\n-- choosing a folder --');
      await js(`document.getElementById('dupe-pick-folder').click()`);
      await settle(1200);
      const narrowed = await text('.dupe-scope-value');
      ok('the chosen folder is shown', /Photos/.test(narrowed), narrowed);
      ok('it is marked as a narrowed search',
        await js(`!!document.querySelector('.dupe-scope-value.narrowed')`));
      ok('a way back to the whole scan appears',
        await js(`!!document.getElementById('dupe-clear-folder')`));
      await shot('dupe-scope-2-narrowed');

      console.log('\n-- running the scoped search from the button --');
      await js(`document.querySelector('[data-dupe="exact"]').click()`);
      await settle(4000);
      const header = await js(
        `[...document.querySelectorAll('.panel header .muted')].map((e) => e.textContent.replace(/\\s+/g,' ').trim()).join(' | ')`);
      ok('the result names the folder it searched', /in Photos/.test(header), header);
      const shown = await js(
        `[...document.querySelectorAll('.panel .table .path')].map((e) => e.textContent.trim())`);
      ok('only files from that folder are listed',
        shown.length > 0 && shown.every((p) => p.includes(`${path.sep}Photos${path.sep}`)),
        JSON.stringify(shown.slice(0, 4)));
      await shot('dupe-scope-3-results');

      console.log('\n-- going back to the whole scan --');
      await js(`document.getElementById('dupe-clear-folder').click()`);
      await settle(600);
      const back = await text('.dupe-scope-value');
      ok('it says everything scanned again', /everything scanned/i.test(back), back);
      ok('the narrowed results were cleared with the scope',
        await js(`!document.querySelector('[data-dupe-plan]')`));

      await js(`document.querySelector('[data-dupe="exact"]').click()`);
      await settle(4000);
      const wideHeader = await js(
        `[...document.querySelectorAll('.panel header .muted')].map((e) => e.textContent.replace(/\\s+/g,' ').trim()).join(' | ')`);
      ok('the unscoped result says so instead of naming a folder',
        /across everything scanned/.test(wideHeader), wideHeader);
      await shot('dupe-scope-4-whole-scan');

    } catch (err) {
      console.log('  ERROR  ' + err.message + '\n' + (err.stack || '').slice(0, 700));
      fail++;
      try { await shot('dupe-scope-error'); } catch { /* window gone */ }
    }

    try { fs.rmSync(FIXTURE, { recursive: true, force: true }); } catch { /* leave it */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    app.exit(fail ? 1 : 0);
  }, 400);
});
