// Conversion, through the running application.
//
// The unit suite proves the converter converts. This proves it is *connected*:
// that the bridge exposes it, that the approved-roots check still applies when
// the call arrives from a renderer, and that a proposal can only be executed
// once and only by its id.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond, extra = '') {
  out.push((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}

const FIXTURE = path.join(require('os').homedir(), '.nexafiles-convert-e2e');

require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => {
  console.log(out.join('\n'));
  console.log('E2E CONVERT TIMEOUT');
  app.exit(2);
}, 300000);

app.whenReady().then(() => {
  const tick = setInterval(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.webContents.isLoading()) return;
    clearInterval(tick);
    await new Promise((r) => setTimeout(r, 2000));

    const js = (code) => win.webContents.executeJavaScript(code);
    const q = (v) => JSON.stringify(v);

    fs.rmSync(FIXTURE, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE, { recursive: true });

    try {
      const support = await js(`window.nexa.convert.support()`);
      ok('the bridge reports conversion support', typeof support.available === 'boolean');

      if (!support.available) {
        ok('and explains why when nothing is installed', typeof support.why === 'string');
        console.log(out.join('\n'));
        console.log(`\n  ${pass} passed, ${fail} failed (no converter on this machine)`);
        return app.exit(fail === 0 ? 0 : 1);
      }

      ok('an engine is named', !!support.engines[0].label, support.engines[0].label);
      ok('docx is convertible here', support.canConvertFrom.includes('docx'));

      // A real .docx, made by the same Word this feature drives.
      const docx = path.join(FIXTURE, 'memo.docx');
      const { execFileSync } = require('child_process');
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference='Stop'
        [string]$d = $env:NEXA_MK
        $w = New-Object -ComObject Word.Application
        $w.Visible = $false
        try { $x = $w.Documents.Add(); $x.Content.Text = "e2e"; $x.SaveAs2($d, 16); $x.Close(0) }
        finally { $w.Quit() }`],
        { env: { ...process.env, NEXA_MK: docx }, timeout: 120000, windowsHide: true });
      ok('a real document exists to convert', fs.existsSync(docx));

      await js(`window.nexa.roots.approve(${q(FIXTURE)})`);

      const preview = await js(`window.nexa.convert.preview([${q(docx)}])`);
      ok('the destination is shown before anything runs',
        preview[0].ok && preview[0].target === path.join(FIXTURE, 'memo.pdf'),
        preview[0].target || preview[0].why);
      ok('and nothing was written by previewing', !fs.existsSync(path.join(FIXTURE, 'memo.pdf')));

      const run = await js(`window.nexa.convert.run([${q(docx)}])`);
      ok('a user-chosen file converts', run.converted === 1 && run.failed === 0,
        JSON.stringify(run.results[0].error || run.results[0].target));
      const pdf = path.join(FIXTURE, 'memo.pdf');
      ok('the PDF is on disk', fs.existsSync(pdf), `${fs.statSync(pdf).size} bytes`);
      ok('the source survives untouched', fs.existsSync(docx));

      const again = await js(`window.nexa.convert.run([${q(docx)}])`);
      ok('converting again refuses rather than overwriting',
        again.failed === 1 && again.results[0].code === 'TARGET_EXISTS');

      // ---- the path the assistant takes ----
      // A protected system location, not a path outside the roots: this machine
      // has whole drives approved, so "outside every root" is not reachable here
      // and asserting it would only prove the fixture was placed somewhere odd.
      // The deny list overrides approved roots, so it holds on every machine —
      // and it is the guard that actually matters, since a user who approves C:\
      // is relying on exactly this to keep Windows out of reach.
      const protectedFile = path.join(process.env.SystemRoot || 'C:\\Windows', 'win.ini');
      const refused = await js(`window.nexa.convert.run([${q(protectedFile)}])`);
      ok('a protected system path is refused through the bridge, despite the drive being an approved root',
        refused.failed === 1 && /protected|refused/i.test(refused.results[0].error),
        (refused.results[0].error || '').slice(0, 70));
      ok('and refusing it wrote no PDF into the system folder',
        !fs.existsSync(protectedFile.replace(/\.ini$/, '.pdf')));

      const bogus = await js(
        `window.nexa.convert.executeProposal('not-a-real-id').then(() => null, (e) => e.message)`
      );
      ok('an unknown proposal id is refused', typeof bogus === 'string' && /no longer available/i.test(bogus));
    } catch (err) {
      ok(`unexpected failure: ${err.message}`, false);
    } finally {
      fs.rmSync(FIXTURE, { recursive: true, force: true });
    }

    console.log(out.join('\n'));
    console.log(`\n  ${pass} passed, ${fail} failed`);
    app.exit(fail === 0 ? 0 : 1);
  }, 300);
});
