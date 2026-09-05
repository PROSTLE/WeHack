'use strict';
// Conversion, against the converter that is actually installed.
//
// Nothing here is mocked. A test that stubs the office suite would prove only
// that the wiring compiles, and every interesting failure in this module —
// a modal dialog, a locked source, a destination on another volume — lives
// precisely in the part a stub replaces.
//
// The suite skips itself, loudly, on a machine with no converter, because
// "0 failed" from a suite that ran nothing is a lie.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

const convert = require('../src/main/convert');
const roots = require('../src/main/security/roots');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}
function section(t) { console.log(`\n-- ${t} --`); }

const FIXTURE = path.join(os.homedir(), '.nexafiles-convert-test');

/** Builds a real .docx by driving Word, so the input is a genuine Office file. */
async function makeDocx(target) {
  const { execFile } = require('child_process');
  const script = `
    $ErrorActionPreference='Stop'
    [string]$dst = $env:NEXA_MAKE_DST
    $w = New-Object -ComObject Word.Application
    $w.Visible = $false
    try {
      $d = $w.Documents.Add()
      $d.Content.Text = "NexaFiles conversion test." + [char]13 + "Second line."
      $d.SaveAs2($dst, 16)
      $d.Close(0)
    } finally { $w.Quit() }`;
  await new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 120000, windowsHide: true, env: { ...process.env, NEXA_MAKE_DST: target } },
      (err) => (err ? reject(err) : resolve()));
  });
}

(async () => {
  const caps = await convert.capabilities();

  section('what this machine can do');
  ok('capabilities are reported without throwing', typeof caps.available === 'boolean');
  // Not `available`: NexaFiles renders Markdown, text and HTML itself, so on a
  // machine with no office suite that flag is true while every format this suite
  // exercises is still unconvertible. The question is whether an office suite is
  // here. (Under plain Node there is no BrowserWindow either, so the built-in
  // engine is absent too and this is simply "no converter at all".)
  const officeEngine = (caps.engines || []).find((e) => e.id !== 'builtin');
  if (!officeEngine) {
    console.log(`\n  SKIPPED: no office suite installed. ${caps.why || ''}`);
    console.log(`\n  ${pass} passed, ${fail} failed (conversion suite skipped)`);
    process.exit(fail === 0 ? 0 : 1);
  }
  ok('an engine is named', caps.engines.length > 0, caps.engines.map((e) => e.id).join(','));
  ok('docx is listed as convertible', caps.canConvertFrom.includes('docx'));
  ok('pdf is the target format', caps.to.includes('pdf'));
  ok('a machine with an engine gives no reason for refusing', caps.why === null);

  fs.rmSync(FIXTURE, { recursive: true, force: true });
  fs.mkdirSync(FIXTURE, { recursive: true });
  roots.approveRoot(FIXTURE);

  try {
    section('a real document');
    const docx = path.join(FIXTURE, 'letter.docx');
    await makeDocx(docx);
    ok('the fixture document was created', fs.existsSync(docx), `${fs.statSync(docx).size} bytes`);

    const before = fs.statSync(docx);
    const r = await convert.convert(docx);
    ok('it converts', r.ok === true, `${r.engine} in ${r.ms}ms`);
    ok('the output is a .pdf next to the source',
      r.target === path.join(FIXTURE, 'letter.pdf'), r.target);
    ok('the output exists and is not empty', fs.existsSync(r.target) && r.bytes > 0, `${r.bytes} bytes`);

    const head = Buffer.alloc(5);
    const fd = fs.openSync(r.target, 'r');
    fs.readSync(fd, head, 0, 5, 0);
    fs.closeSync(fd);
    ok('the output really is a PDF, by its magic bytes',
      head.toString('latin1') === '%PDF-', JSON.stringify(head.toString('latin1')));

    section('the source is untouched')
    const after = fs.statSync(docx);
    ok('the source still exists', fs.existsSync(docx));
    ok('its size is unchanged', after.size === before.size, `${after.size}`);
    ok('its modified time is unchanged', after.mtimeMs === before.mtimeMs);

    section('an existing file is never overwritten');
    let refused = null;
    try { await convert.convert(docx); } catch (e) { refused = e; }
    ok('a second conversion is refused rather than overwriting',
      refused && refused.code === 'TARGET_EXISTS', refused ? refused.code : 'no error');
    ok('and it says which file is in the way',
      refused && /already exists/i.test(refused.message));

    const renamed = await convert.convert(docx, { onConflict: 'rename' });
    ok('asked to rename, it writes a numbered name instead',
      renamed.target === path.join(FIXTURE, 'letter (2).pdf'), path.basename(renamed.target));
    ok('and the original PDF is still intact',
      fs.existsSync(path.join(FIXTURE, 'letter.pdf')));

    section('what it refuses');
    // A file that genuinely exists, outside every approved root. Using a path
    // that is merely absent would pass this test for the wrong reason — the
    // "does not exist" check would fire before the root check ever ran, and the
    // boundary this asserts on would go untested.
    const stray = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'nexa-stray-')), 'stray.docx');
    await fsp.copyFile(docx, stray);
    let outside = null;
    try { await convert.convert(stray); } catch (e) { outside = e; }
    ok('an existing file outside every approved root is refused',
      outside !== null && /root/i.test(outside.message),
      outside ? outside.message.slice(0, 70) : 'no error');
    ok('and refusing it wrote nothing next to it',
      !fs.existsSync(stray.replace(/\.docx$/, '.pdf')));
    await fsp.rm(path.dirname(stray), { recursive: true, force: true });

    const txtOnly = path.join(FIXTURE, 'notes.zzz');
    await fsp.writeFile(txtOnly, 'not a document');
    let badExt = null;
    try { await convert.convert(txtOnly); } catch (e) { badExt = e; }
    ok('an unconvertible extension is named, not guessed at',
      badExt && /cannot be converted/i.test(badExt.message));

    let badFormat = null;
    try { await convert.convert(docx, { format: 'docx' }); } catch (e) { badFormat = e; }
    ok('a target format it cannot write is refused',
      badFormat && /not a format/i.test(badFormat.message));

    let dirErr = null;
    try { await convert.convert(FIXTURE); } catch (e) { dirErr = e; }
    ok('a folder is refused', dirErr && /folder/i.test(dirErr.message));

    section('destination reporting');
    const d = convert.destinationFor(docx);
    ok('the destination can be shown before converting',
      d.target === path.join(FIXTURE, 'letter.pdf') && d.exists === true);
  } finally {
    fs.rmSync(FIXTURE, { recursive: true, force: true });
    roots.revokeRoot(FIXTURE);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n  suite crashed:', err);
  process.exit(1);
});
