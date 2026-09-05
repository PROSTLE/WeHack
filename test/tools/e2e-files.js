// End-to-end test of the Files view, through the real running application.
//
// Everything here goes through `window.nexa` — the same bridge the interface
// uses — so a handler that works only when called directly in the main process
// fails this test, as it should.
//
// A fixture is built inside the user's home directory, which is the one root
// approved by launching the app. Nothing outside it is written to, and the
// destructive steps (trash, move) only ever name paths inside it.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const FIXTURE = path.join(os.homedir(), '.nexafiles-files-e2e');
let pass = 0, fail = 0;
const out = [];
function ok(name, cond, extra = '') {
  out.push((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}

require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => {
  console.log(out.join('\n'));
  console.log('E2E FILES TIMEOUT');
  app.exit(2);
}, 120000);

app.whenReady().then(() => {
  const tick = setInterval(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.webContents.isLoading()) return;
    clearInterval(tick);
    await new Promise((r) => setTimeout(r, 1500));

    const js = (code) => win.webContents.executeJavaScript(code);
    const q = (v) => JSON.stringify(v);

    // ---- fixture ----
    fs.rmSync(FIXTURE, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE, 'folder-a'), { recursive: true });
    fs.mkdirSync(path.join(FIXTURE, 'folder-b'), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE, 'notes.txt'), 'The quick brown fox jumps over the lazy dog.\n');
    fs.writeFileSync(path.join(FIXTURE, 'report.md'), '# Heading\n\nA paragraph of text.\n');
    fs.writeFileSync(path.join(FIXTURE, 'folder-a', 'inner.txt'), 'inner\n');
    fs.writeFileSync(path.join(FIXTURE, 'big.bin'), Buffer.alloc(200 * 1024, 7));

    let layoutBefore = null;   // the user's Files layout, restored in `finally`

    try {
      // ---- listing ----
      const listing = await js(`window.nexa.explorer.list(${q(FIXTURE)})`);
      ok('listing is allowed inside an approved root', listing.access.allowed === true);
      ok('every fixture entry is listed', listing.counts.total === 5, `${listing.counts.total}`);
      ok('folders and files are counted apart',
        listing.counts.folders === 2 && listing.counts.files === 3,
        `${listing.counts.folders}/${listing.counts.files}`);
      ok('measured bytes are the files only',
        listing.counts.bytes === fs.statSync(path.join(FIXTURE, 'notes.txt')).size +
          fs.statSync(path.join(FIXTURE, 'report.md')).size + 200 * 1024,
        `${listing.counts.bytes}`);

      const notes = listing.entries.find((e) => e.name === 'notes.txt');
      ok('a file carries its type description', notes && notes.typeLabel === 'Text Document',
        notes && notes.typeLabel);
      ok('a file carries a modification time', !!(notes && notes.mtimeMs > 0));
      ok('a folder reports no size, as Explorer does',
        listing.entries.find((e) => e.name === 'folder-a').size === null);
      ok('breadcrumb segments start at the volume root',
        listing.segments[0].isRoot === true && listing.segments.length > 2,
        listing.segments.map((s) => s.name).join(' > '));
      ok('the parent folder is reachable', listing.parent === os.homedir(), listing.parent);

      // ---- hidden and system attributes ----
      if (process.platform === 'win32') {
        const home = await js(`window.nexa.explorer.list(${q(os.homedir())})`);
        ok('Windows attributes were read for the home folder', home.attributesRead === true);
        const appData = home.entries.find((e) => e.name === 'AppData');
        ok('AppData is reported as hidden, as Explorer reports it',
          !appData || appData.hidden === true);
        const junction = home.entries.find((e) => e.name === 'Application Data');
        ok('a junction is flagged hidden, system and a link',
          !junction || (junction.hidden && junction.system && junction.isSymlink));
      }

      // ---- a location that has not been approved ----
      const drive = path.parse(os.homedir()).root;
      const cRoot = await js(`window.nexa.explorer.list(${q(drive)})`);
      ok('an unapproved location returns a refusal, not contents',
        cRoot.entries === null && cRoot.access.allowed === false,
        cRoot.access.reason);
      ok('the refusal says access was never granted, not that it failed',
        cRoot.access.reason === 'outside');

      const windows = path.join(drive, 'Windows');
      if (process.platform === 'win32' && fs.existsSync(windows)) {
        const prot = await js(`window.nexa.explorer.list(${q(windows)})`);
        ok('a protected location is refused as protected, and cannot be granted',
          prot.access.allowed === false && prot.access.reason === 'protected',
          prot.access.detail);
      }

      // ---- places ----
      const places = await js('window.nexa.explorer.places()');
      ok('the machine’s drives are enumerated', Array.isArray(places.drives) && places.drives.length > 0,
        places.drives.map((d) => d.id || d.path).join(' '));
      ok('each drive reports free and total space',
        places.drives.every((d) => d.totalBytes > 0 && d.freeBytes >= 0));
      ok('the home folder is listed as accessible', places.home.access.allowed === true);
      ok('user folders are enumerated', places.folders.length > 0,
        places.folders.map((f) => f.name).join(' '));

      // ---- create, rename ----
      const made = await js(`window.nexa.explorer.newFolder(${q(FIXTURE)})`);
      ok('a folder can be created', fs.existsSync(made.path));
      ok('it is named the way Explorer names one', made.name === 'New folder', made.name);
      const madeAgain = await js(`window.nexa.explorer.newFolder(${q(FIXTURE)})`);
      ok('a second one is numbered rather than failing',
        madeAgain.name === 'New folder (2)', madeAgain.name);
      fs.rmSync(madeAgain.path, { recursive: true, force: true });
      const renamed = await js(`window.nexa.explorer.rename(${q(made.path)}, "renamed")`);
      ok('a folder can be renamed',
        fs.existsSync(renamed.path) && !fs.existsSync(made.path), renamed.path);

      // ---- copy ----
      const copy = await js(
        `window.nexa.explorer.copy([${q(path.join(FIXTURE, 'notes.txt'))}], ${q(path.join(FIXTURE, 'folder-b'))})`
      );
      ok('a file copies into another folder', copy.copied === 1);
      ok('the copy is byte-identical',
        fs.readFileSync(path.join(FIXTURE, 'folder-b', 'notes.txt'), 'utf8')
          === fs.readFileSync(path.join(FIXTURE, 'notes.txt'), 'utf8'));
      ok('the original is still there', fs.existsSync(path.join(FIXTURE, 'notes.txt')));

      const copyAgain = await js(
        `window.nexa.explorer.copy([${q(path.join(FIXTURE, 'notes.txt'))}], ${q(path.join(FIXTURE, 'folder-b'))})`
      );
      ok('a second copy is renamed rather than overwriting the first',
        copyAgain.results[0].to.includes('(2)'), copyAgain.results[0].to);

      // ---- move ----
      const moved = await js(
        `window.nexa.explorer.move([${q(path.join(FIXTURE, 'report.md'))}], ${q(path.join(FIXTURE, 'folder-a'))})`
      );
      ok('a file moves into another folder', moved.moved === 1);
      ok('the source is gone after a move',
        !fs.existsSync(path.join(FIXTURE, 'report.md'))
        && fs.existsSync(path.join(FIXTURE, 'folder-a', 'report.md')));

      const intoItself = await js(
        `window.nexa.explorer.move([${q(path.join(FIXTURE, 'folder-a'))}], ${q(path.join(FIXTURE, 'folder-a'))})`
      );
      ok('a folder cannot be moved into itself', intoItself.results[0].ok === false,
        intoItself.results[0].error);

      // ---- properties ----
      const props = await js(`window.nexa.explorer.properties(${q(path.join(FIXTURE, 'folder-a'))}, { deep: true })`);
      ok('a folder’s size is measured on request',
        props.contents && props.contents.files === 2, JSON.stringify(props.contents));
      const fileProps = await js(`window.nexa.explorer.properties(${q(path.join(FIXTURE, 'big.bin'))})`);
      ok('a file reports its exact byte count', fileProps.size === 200 * 1024, `${fileProps.size}`);

      // ---- icons ----
      const iconUrl = await js(`window.nexa.explorer.icon(${q(path.join(FIXTURE, 'notes.txt'))})`);
      ok('the system icon for a file is returned as a data URL',
        typeof iconUrl === 'string' && iconUrl.startsWith('data:image/'),
        typeof iconUrl === 'string' ? `${iconUrl.length} chars` : String(iconUrl));

      // ---- refusals outside the approved roots ----
      //
      // A rejection crossing executeJavaScript keeps only its message, so the
      // code the interface branches on is read inside the renderer and returned
      // as data.
      const outside = process.platform === 'win32'
        ? path.join(drive, 'Program Files')
        : path.join(drive, 'etc');
      const refused = await js(
        `window.nexa.explorer.properties(${q(outside)})
           .then(() => null, (e) => ({ code: e.code, message: e.message }))`
      );
      ok('an existing path outside every approved root is refused',
        refused !== null && /outside every approved root/.test(refused.message),
        refused ? refused.message : 'not refused');

      // ---- the assistant reads a dropped file ----
      const attached = await js(`window.nexa.agent.attach(${q(path.join(FIXTURE, 'notes.txt'))})`);
      ok('a dropped text file is described before it is sent',
        attached.ok === true && attached.kind === 'document' && attached.size > 0,
        `${attached.kind} ${attached.size}`);

      const attachRefusal = await js(`window.nexa.agent.attach(${q(outside)})`);
      ok('a file outside the approved roots is refused as data the composer can act on',
        attachRefusal.ok === false && attachRefusal.reason === 'outside'
        && !!attachRefusal.folder,
        `${attachRefusal.reason}: ${attachRefusal.message}`);

      // ---- trash ----
      const target = path.join(FIXTURE, 'big.bin');
      const trashed = await js(`window.nexa.explorer.trash([${q(target)}])`);
      ok('a file goes to the system trash', trashed.trashed === 1 && !fs.existsSync(target),
        JSON.stringify(trashed.results[0]));

      const trashRoot = await js(`window.nexa.explorer.trash([${q(os.homedir())}])`);
      ok('an approved root cannot be deleted from the file manager',
        trashRoot.results[0].ok === false && fs.existsSync(os.homedir()),
        trashRoot.results[0].error);

      // ---- dropping a file on the assistant ----
      //
      // Dispatched as a real DragEvent carrying the same data the Files view
      // puts on the clipboard when a row is dragged, so this covers the whole
      // path: the drop handler, the path resolution, and the chip that appears.
      const dropped = await js(`(async () => {
        const dt = new DataTransfer();
        dt.setData('application/x-nexafiles-paths', JSON.stringify([${q(path.join(FIXTURE, 'notes.txt'))}]));
        document.querySelector('.aside').dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
        );
        await new Promise((r) => setTimeout(r, 1200));
        const chip = document.querySelector('.chat-chip');
        return {
          tab: document.querySelector('#aside-tabs [aria-selected="true"]').dataset.tab,
          chip: chip ? chip.textContent : null,
        };
      })()`);
      ok('dropping a file on the assistant switches to it', dropped.tab === 'chat', dropped.tab);
      // The chip's text is normalised here rather than inside the injected
      // script: a backslash escape in a template literal never reaches the page.
      const chipText = (dropped.chip || '').split(/\s+/).filter(Boolean).join(' ');
      ok('and the file appears as an attachment, named and sized',
        chipText.includes('notes.txt') && /\d+ (B|KB|MB)/.test(chipText),
        chipText || 'no chip');

      const removed = await js(`(async () => {
        const btn = document.querySelector('[data-drop-attachment]');
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 300));
        return document.querySelectorAll('.chat-chip').length;
      })()`);
      ok('and it can be taken off again before sending', removed === 0, `${removed} left`);

      // ---- the view itself ----
      //
      await js(`(() => {
        const btn = document.querySelector('#rail [data-view="files"]');
        if (btn) btn.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 1500));

      // The assertions below read the column headers, which only the "details"
      // layout draws. That is the built-in default, but it is also a preference
      // the user owns: anyone who has switched the Files view to icons once
      // would see this suite fail on a view that is working correctly.
      //
      // The layout is chosen through the View menu rather than by writing the
      // setting, because the setting is written *by* the view — the renderer
      // holds the live layout and pushes it down, so a value poked into the
      // store underneath it is simply overwritten on the next render.
      layoutBefore = await js(`(async () => {
        const before = document.querySelector('#ex-view-menu [aria-checked="true"][data-layout]');
        const was = before ? before.dataset.layout : null;
        document.querySelector('#ex-view-menu [data-layout="details"]').click();
        await new Promise((r) => setTimeout(r, 600));
        return was;
      })()`);
      const ui = await js(`(() => ({
        hasExplorer: !!document.querySelector('.explorer'),
        rows: document.querySelectorAll('.ex-row').length,
        columns: [...document.querySelectorAll('.ex-table thead th')].map((t) => t.textContent.trim().split(' ')[0]),
        crumbs: [...document.querySelectorAll('.ex-crumb')].map((c) => c.textContent.trim()),
        status: (document.querySelector('.ex-status') || {}).textContent || '',
        drives: document.querySelectorAll('#rail-drives .rail-place').length,
        quick: document.querySelectorAll('#rail-quick .rail-place').length,
      }))()`);
      ok('the Files view renders', ui.hasExplorer === true);
      ok('it lists the home folder’s contents', ui.rows > 0, `${ui.rows} rows`);
      ok('it shows Explorer’s four columns',
        ui.columns.join(',') === 'Name,Date,Type,Size', ui.columns.join(','));
      ok('the path is shown as breadcrumbs', ui.crumbs.length > 1, ui.crumbs.join(' > '));
      ok('the status bar reports item count and free space',
        /item\(s\)/.test(ui.status) && /free of/.test(ui.status), ui.status.trim());
      ok('every drive on the machine is in the sidebar',
        ui.drives === places.drives.length, `${ui.drives} of ${places.drives.length}`);
      ok('the user’s folders are in the sidebar', ui.quick > 1, `${ui.quick}`);

      const navigated = await js(`(async () => {
        const row = [...document.querySelectorAll('.ex-row')]
          .find((r) => r.dataset.directory === '1');
        if (!row) return { ok: false, why: 'no folder row' };
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 1200));
        return {
          ok: true,
          path: document.querySelector('.explorer').dataset.path,
          canGoBack: !document.querySelector('#ex-back').disabled,
        };
      })()`);
      ok('double-clicking a folder opens it', navigated.ok && navigated.path !== os.homedir(),
        navigated.path);
      ok('and Back becomes available', navigated.canGoBack === true);

      // ---- filtering must not disable the rest of the list ----
      //
      // The filter box re-renders the list on every keystroke. It used to
      // re-bind only the rows, which left the column headers and "Show all"
      // inert for the rest of the session: typing in the filter box silently
      // broke sorting.
      // Two files whose name order and size order disagree, so a change of sort
      // is unmistakable rather than a coincidence.
      fs.writeFileSync(path.join(FIXTURE, 'alpha-t.txt'), 'x'.repeat(9000));
      fs.writeFileSync(path.join(FIXTURE, 'beta-t.txt'), 'x'.repeat(100));

      const filtered = await js(`(async () => {
        const mod = await import('./js/explorer.js');
        await mod.navigate(${q(FIXTURE)});
        await new Promise((r) => setTimeout(r, 900));
        const q = document.querySelector('#ex-query');
        q.value = 't';
        q.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 500));
        const names = () => [...document.querySelectorAll('.ex-row .ex-label')]
          .map((e) => e.textContent);
        const byName = names();
        document.querySelector('[data-sort-col="size"]').click();
        await new Promise((r) => setTimeout(r, 700));
        const bySize = names();
        q.value = '';
        document.querySelector('#ex-query').value = '';
        document.querySelector('#ex-query').dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        return { byName, bySize, filteredOut: byName.every((n) => n.includes('t')) };
      })()`);
      ok('the filter narrows the list to matching names',
        filtered.byName.length > 1 && filtered.filteredOut,
        filtered.byName.join(', '));
      ok('and the column headers still sort after filtering',
        filtered.bySize.join() !== filtered.byName.join(),
        `${filtered.byName.join(', ')} then ${filtered.bySize.join(', ')}`);

      // ---- a location that is gone is not a permissions problem ----
      const missing = await js(`(async () => {
        const mod = await import('./js/explorer.js');
        await mod.navigate('Z:' + String.fromCharCode(92) + 'no-such-drive');
        await new Promise((r) => setTimeout(r, 700));
        const heading = document.querySelector('.ex-gate h3');
        return {
          reason: mod.state.access && mod.state.access.reason,
          heading: heading ? heading.textContent.trim() : null,
          offersGrant: !!document.querySelector('[data-grant]'),
        };
      })()`);
      ok('a path that does not exist reports that, not a missing permission',
        missing.reason === 'missing', String(missing.reason));
      ok('and does not offer to approve a drive that is not there',
        missing.offersGrant === false, missing.heading || '');
    } catch (err) {
      ok(`unexpected failure: ${err.message}`, false);
    } finally {
      fs.rmSync(FIXTURE, { recursive: true, force: true });
      // The layout is the user's choice, not the suite's, so it goes back even
      // when an assertion above threw.
      if (layoutBefore && layoutBefore !== 'details') {
        await js(`(() => {
          const b = document.querySelector('#ex-view-menu [data-layout=${JSON.stringify(layoutBefore)}]');
          if (b) b.click();
          return true;
        })()`).catch(() => {});
      }
    }

    console.log(out.join('\n'));
    console.log(`\n  ${pass} passed, ${fail} failed`);
    app.exit(fail === 0 ? 0 : 1);
  }, 300);
});
