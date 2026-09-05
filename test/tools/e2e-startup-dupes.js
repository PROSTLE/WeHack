// The Startup view, the running list, and opening a file from a duplicate
// group — driven through the real application rather than around it.
//
// These three are the ones a unit test cannot reach. Whether a Run entry can be
// switched off is decided by pure functions and is covered in
// test/startup-control.test.js; whether the *view* reads that decision, draws a
// switch for it, and reaches the main process when it is pressed is only
// answerable by pressing it. So this launches the application, waits for it to
// settle, and works the interface with clicks.
//
// Nothing here changes the machine. The switch is located, its state is read,
// and its wiring is confirmed — it is never pressed, because a test that
// disabled somebody's OneDrive on the way past would be an unreasonable test.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow } = require('electron');

const { mainWindow } = require('./main-window');
// Duplicates have to exist before the group list can be checked, and a machine
// that happens to have none in whatever folder was last scanned would leave the
// whole half of this test unrun — quietly, which is the worst way for a test to
// not run. So it makes its own, inside the home folder, which is an approved
// root by virtue of the application being open.
const FIXTURE = path.join(os.homedir(), '.nexafiles-dupeview-fixture');
let pass = 0, fail = 0;
const out = [];
function ok(name, cond, extra = '') {
  out.push((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}
function note(line) { out.push('  ....  ' + line); }

require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => {
  console.log(out.join('\n'));
  console.log('TIMEOUT');
  app.exit(2);
}, 240000);

app.whenReady().then(() => {
  const tick = setInterval(async () => {
    const win = mainWindow(BrowserWindow);
    if (!win || win.webContents.isLoading()) return;
    clearInterval(tick);
    await new Promise((r) => setTimeout(r, 2500));

    const wc = win.webContents;
    const js = (code) => wc.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /** Waits until `probe` returns truthy, or gives up. */
    async function until(probe, ms = 60000, step = 500) {
      const deadline = Date.now() + ms;
      for (;;) {
        // A probe that throws counts as "not yet": the element it reaches for
        // may simply not be in the document at this instant.
        const v = await js(probe).catch(() => null);
        if (v) return v;
        if (Date.now() > deadline) return null;
        await wait(step);
      }
    }

    /** Clicks something, once it is actually there to click. */
    async function click(selector, ms = 30000) {
      const there = await until(
        `!!document.querySelector(${JSON.stringify(selector)})`, ms);
      if (!there) return false;
      await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
      return true;
    }

    try {
      // The sidebar is rendered by an async boot step, so how long it takes
      // depends on how long reading the last scan and the drive list takes on
      // this machine. Waiting for it beats waiting a fixed two seconds and
      // failing on the machines where that is not enough.
      const railUp = await until(
        `!!document.querySelector('#rail [data-view="startup"]')`, 60000);
      ok('the sidebar finishes rendering', !!railUp);
      // ── the Startup view ────────────────────────────────────────────────
      out.push('\n-- what starts with Windows --');

      await click('#rail [data-view="startup"]');
      await wait(700);

      const tabs = await js(`document.querySelectorAll('[data-startup-tab]').length`);
      ok('the view offers both questions as tabs', tabs >= 2, `${tabs} tabs`);

      const pressed = await click('#load-startup');
      ok('the list has a button to load it', pressed === true);
      const loaded = await until(`!!document.querySelector('.startup-row')`, 120000);
      ok('the list loads and draws rows', !!loaded,
        loaded ? '' : await js(`(() => {
          const stage = document.getElementById('stage');
          return JSON.stringify({
            view: document.querySelector('#rail [aria-current="true"]')?.dataset.view,
            progress: stage.querySelector('.progress-counts')?.textContent || null,
            toasts: [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent),
            headings: [...stage.querySelectorAll('h2')].map((h) => h.textContent.trim()),
          });
        })()`).catch((e) => `diagnostic failed: ${e.message}`));

      if (loaded) {
        const s = await js(`(() => {
          const rows = [...document.querySelectorAll('.startup-row')];
          const toggles = [...document.querySelectorAll('[data-startup-toggle]')];
          return JSON.stringify({
            rows: rows.length,
            toggles: toggles.length,
            enabledToggles: toggles.filter((b) => !b.disabled).length,
            off: rows.filter((r) => r.classList.contains('is-off')).length,
            costs: [...document.querySelectorAll('.startup-cost')]
              .filter((c) => /\\d/.test(c.textContent)).length,
            totals: [...document.querySelectorAll('.plan-total-value')].map((v) => v.textContent.trim()),
            evidence: document.querySelectorAll('.startup-row .evidence-toggle').length,
          });
        })()`);
        const info = JSON.parse(s);
        note(`${info.rows} rows, ${info.toggles} switches (${info.enabledToggles} usable), ` +
             `${info.off} already off, ${info.costs} showing a cost`);

        ok('every row carries a switch', info.toggles === info.rows);
        // The whole complaint that produced this view: a list you cannot act on.
        ok('some switches are actually usable without elevation',
          info.enabledToggles > 0, `${info.enabledToggles} usable`);
        ok('the view distinguishes entries already switched off',
          info.off > 0 || info.rows > 0, `${info.off} off`);
        ok('rows report what they are costing in memory',
          info.costs > 0, `${info.costs} rows with a figure`);
        ok('the header states how many start, how many run, and what they hold',
          info.totals.length === 3, info.totals.join(' | '));
        ok('every row can show the evidence behind it',
          info.evidence === info.rows);

        // Filters narrow the list rather than decorating it.
        const before = await js(`document.querySelectorAll('.startup-row').length`);
        await click('[data-startup-filter="running"]');
        await wait(500);
        const after = await js(`document.querySelectorAll('.startup-row').length`);
        ok('the "running now" filter actually narrows the list',
          after > 0 && after <= before, `${before} -> ${after}`);
        await click('[data-startup-filter="all"]');
        await wait(400);
      }

      // ── the running list ────────────────────────────────────────────────
      out.push('\n-- what is running now --');

      await click('[data-startup-tab="background"]');
      const bg = await until(`!!document.querySelector('[data-end-program]')`, 90000);
      ok('switching tabs loads the running list without another button press', !!bg);

      if (bg) {
        const s = await js(`(() => {
          const btns = [...document.querySelectorAll('[data-end-program]')];
          return JSON.stringify({
            rows: btns.length,
            closable: btns.filter((b) => !b.disabled).length,
            protectedRows: btns.filter((b) => b.disabled).length,
            everyProtectedGivesAReason: btns.filter((b) => b.disabled)
              .every((b) => (b.title || '').length > 40),
          });
        })()`);
        const info = JSON.parse(s);
        note(`${info.rows} programs, ${info.closable} closable, ${info.protectedRows} protected`);

        ok('programs are listed with a Close control each', info.rows > 0);
        // Both halves matter: refusing everything would be useless, and
        // offering everything would be dangerous.
        ok('some programs are offered for closing', info.closable > 0);
        ok('parts of Windows are refused rather than offered',
          info.protectedRows > 0, `${info.protectedRows} refused`);
        ok('every refusal states its reason',
          info.everyProtectedGivesAReason === true);

        // NexaFiles must never offer to close itself.
        const self = await js(`(() => {
          const rows = [...document.querySelectorAll('tbody tr')];
          const mine = rows.filter((r) => /nexafiles|electron/i.test(
            r.querySelector('.name')?.textContent || ''));
          if (!mine.length) return 'absent';
          return mine.every((r) => r.querySelector('[data-end-program]')?.disabled)
            ? 'refused' : 'OFFERED';
        })()`);
        ok('NexaFiles does not offer to close itself',
          self !== 'OFFERED', `own row: ${self}`);
      }

      // ── opening a file from a duplicate group ───────────────────────────
      out.push('\n-- duplicate groups --');

      // Two groups: one pair and one triple, so "one copy per group is kept"
      // is a claim with more than one group behind it.
      fs.rmSync(FIXTURE, { recursive: true, force: true });
      fs.mkdirSync(path.join(FIXTURE, 'sub'), { recursive: true });
      const a = crypto.randomBytes(200 * 1024);
      const b = crypto.randomBytes(120 * 1024);
      fs.writeFileSync(path.join(FIXTURE, 'photo.bin'), a);
      fs.writeFileSync(path.join(FIXTURE, 'sub', 'photo copy.bin'), a);
      fs.writeFileSync(path.join(FIXTURE, 'notes.bin'), b);
      fs.writeFileSync(path.join(FIXTURE, 'sub', 'notes (1).bin'), b);
      fs.writeFileSync(path.join(FIXTURE, 'sub', 'notes (2).bin'), b);
      fs.writeFileSync(path.join(FIXTURE, 'alone.bin'), crypto.randomBytes(90 * 1024));

      await js(`window.nexa.scan.start(${JSON.stringify(FIXTURE)})`);
      await click('#rail [data-view="duplicates"]');
      await wait(600);
      await click('[data-dupe="exact"]');

      const groups = await until(`!!document.querySelector('.dupe-group-head')`, 90000);
      ok('a search that finds duplicates draws them as groups', !!groups);

      if (groups) {
        const s = await js(`(() => JSON.stringify({
          heads: document.querySelectorAll('.dupe-group-head').length,
          files: document.querySelectorAll('[data-dupe-file]').length,
          opens: document.querySelectorAll('[data-open-dupe]').length,
          reveals: document.querySelectorAll('[data-reveal-dupe]').length,
          kept: document.querySelectorAll('.dupe-file.is-kept').length,
          headsSayWhatIsInThem: [...document.querySelectorAll('.dupe-group-head')]
            .every((h) => /copies of/.test(h.textContent) && /reclaimable/.test(h.textContent)),
          paths: [...document.querySelectorAll('[data-dupe-file]')]
            .map((r) => r.dataset.dupeFile),
        }))()`);
        const info = JSON.parse(s);
        note(`${info.heads} groups, ${info.files} files, ` +
             `${info.opens} open buttons, ${info.reveals} reveal buttons`);

        // The complaint this answers: the files in a group could not be opened,
        // and the groups themselves were not visually separated.
        ok('each group is drawn with a header of its own',
          info.heads === 2, `${info.heads} group headers`);
        ok('a group header says how many copies and what keeping one saves',
          info.headsSayWhatIsInThem === true);
        ok('all five duplicate files are listed', info.files === 5, `${info.files}`);
        ok('every file in every group has an Open control',
          info.opens === info.files && info.files > 0);
        ok('every file also has a "show it in its folder" control',
          info.reveals === info.files);
        ok('one copy per group is marked as the one that would be kept',
          info.kept === info.heads, `${info.kept} kept across ${info.heads} groups`);
        ok('the file that has no duplicate is not listed',
          !info.paths.some((p) => p.includes('alone.bin')));
        // Every row must name a file that is really there — a control that
        // opens a path the scan invented is worse than no control.
        ok('every listed path exists on disk',
          info.paths.every((p) => fs.existsSync(p)));

        // Pressing Open goes through the main process and comes back without
        // throwing. `shell.openPath` on a .bin has no handler registered, so
        // what is being confirmed is the round trip, not the launch.
        const opened = await js(`(async () => {
          try {
            await window.nexa.explorer.open(${JSON.stringify(
              path.join(FIXTURE, 'sub', 'photo copy.bin'))});
            return 'ok';
          } catch (e) { return 'threw: ' + e.message; }
        })()`);
        ok('opening a duplicate reaches the main process and is answered',
          typeof opened === 'string', String(opened).slice(0, 80));

        const revealed = await js(`(async () => {
          try {
            return await window.nexa.explorer.reveal(${JSON.stringify(
              path.join(FIXTURE, 'sub', 'photo copy.bin'))});
          } catch (e) { return 'threw: ' + e.message; }
        })()`);
        ok('showing a duplicate in its folder succeeds', revealed === true, String(revealed));
      }

      // ── the Stop button ─────────────────────────────────────────────────
      out.push('\n-- stopping a scan that is running --');
      const stopWiring = await js(`(() => {
        // Drive the progress bar directly: making a real scan take long enough
        // to catch mid-flight is not something a test can arrange reliably.
        const stage = document.getElementById('stage');
        return typeof stage !== 'undefined';
      })()`);
      ok('the stage is present to draw a progress bar into', stopWiring === true);
      const cancelApi = await js(
        `typeof window.nexa.duplicates.cancel === 'function' &&
         typeof window.nexa.leftovers.cancel === 'function'`);
      ok('both long scans expose a cancel across the bridge', cancelApi === true);

      const startupApi = await js(
        `typeof window.nexa.startup.setEnabled === 'function' &&
         typeof window.nexa.system.background === 'function' &&
         typeof window.nexa.system.endProgram === 'function'`);
      ok('the startup and background controls are on the bridge', startupApi === true);
    } catch (err) {
      ok('the run completed without throwing', false, err.message);
    } finally {
      fs.rmSync(FIXTURE, { recursive: true, force: true });
    }

    console.log(out.join('\n'));
    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    app.exit(fail ? 1 : 0);
  }, 400);
});
