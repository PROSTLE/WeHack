// Settings, through the running application.
//
// The unit test proves the store validates. This proves the settings are
// *connected*: that choosing a theme repaints the window, that a preference
// saved in one view is the preference another view opens with, and that the
// key the interface can never see is nonetheless the key the client uses.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { DEFAULT_MODEL } = require(path.join(__dirname, '..', '..', 'src', 'main', 'llm', 'gemini.js'));

let pass = 0, fail = 0;
const out = [];
function ok(name, cond, extra = '') {
  out.push((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}

require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => {
  console.log(out.join('\n'));
  console.log('E2E SETTINGS TIMEOUT');
  app.exit(2);
}, 120000);

app.whenReady().then(() => {
  const tick = setInterval(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.webContents.isLoading()) return;
    clearInterval(tick);
    await new Promise((r) => setTimeout(r, 2000));

    const js = (code) => win.webContents.executeJavaScript(code);
    const settingsFile = path.join(app.getPath('userData'), 'settings.json');
    const onDisk = () => {
      try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return null; }
    };
    const original = onDisk();

    try {
      // ---- the theme is applied, not merely stored ----
      const dark = await js(`window.nexa.settings.set({ theme: 'dark' })`);
      ok('choosing dark reports dark as the effective theme', dark.effective.dark === true);
      ok('and it is written to disk', onDisk().theme === 'dark', JSON.stringify(onDisk().theme));

      await js(`(async () => {
        const s = await window.nexa.settings.get();
        document.documentElement.setAttribute('data-theme', s.effective.dark ? 'dark' : 'light');
      })()`);
      await new Promise((r) => setTimeout(r, 400));

      const painted = await js(`(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          attr: document.documentElement.getAttribute('data-theme'),
          ground: cs.getPropertyValue('--ground').trim(),
          ink: cs.getPropertyValue('--ink').trim(),
          bodyBg: getComputedStyle(document.body).backgroundColor,
        };
      })()`);
      ok('the document is marked dark', painted.attr === 'dark');
      ok('and the ground token actually changed', painted.ground === '#0F1219', painted.ground);
      ok('and the ink inverted with it', painted.ink === '#E9EDF5', painted.ink);

      // Nothing may still be painting a literal light colour underneath.
      const lightLeftovers = await js(`(() => {
        const bad = [];
        for (const el of document.querySelectorAll('.panel, .rail, .stage, .aside, .titlebar')) {
          const bg = getComputedStyle(el).backgroundColor;
          const m = bg.match(/rgb\\((\\d+), (\\d+), (\\d+)\\)/);
          if (!m) continue;
          const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
          if ((r + g + b) / 3 > 200) bad.push(el.className + ' ' + bg);
        }
        return bad.slice(0, 5);
      })()`);
      ok('no surface stayed light behind the dark theme',
        lightLeftovers.length === 0, lightLeftovers.join(' | '));

      const light = await js(`window.nexa.settings.set({ theme: 'light' })`);
      ok('switching back reports light', light.effective.dark === false);

      const system = await js(`window.nexa.settings.set({ theme: 'system' })`);
      ok('"match the system" resolves to whatever the system is set to',
        typeof system.effective.dark === 'boolean', `dark=${system.effective.dark}`);

      // ---- the same switch, driven through the interface ----
      //
      // The bug this replaced: choosing a theme repainted the window but left
      // the Appearance section showing the previous choice as selected,
      // because a listener patched a copy of the settings taken at startup
      // instead of re-reading them.
      const viaUi = await js(`(async () => {
        document.querySelector('#rail [data-view="settings"]').click();
        await new Promise((r) => setTimeout(r, 1200));
        document.querySelector('[data-section="appearance"]').click();
        await new Promise((r) => setTimeout(r, 700));
        document.querySelector('[data-theme-choice="dark"]').click();
        await new Promise((r) => setTimeout(r, 1000));
        const read = () => ({
          attr: document.documentElement.getAttribute('data-theme'),
          dark: document.querySelector('[data-theme-choice="dark"]').getAttribute('aria-pressed'),
          light: document.querySelector('[data-theme-choice="light"]').getAttribute('aria-pressed'),
        });
        const afterDark = read();
        document.querySelector('[data-theme-choice="light"]').click();
        await new Promise((r) => setTimeout(r, 1000));
        return { afterDark, afterLight: read() };
      })()`);
      ok('clicking the dark card repaints the interface',
        viaUi.afterDark.attr === 'dark', viaUi.afterDark.attr);
      ok('and marks itself as the current choice',
        viaUi.afterDark.dark === 'true' && viaUi.afterDark.light === 'false',
        `dark=${viaUi.afterDark.dark} light=${viaUi.afterDark.light}`);
      ok('clicking light switches back, in both the paint and the control',
        viaUi.afterLight.attr === 'light' && viaUi.afterLight.light === 'true'
        && viaUi.afterLight.dark === 'false',
        JSON.stringify(viaUi.afterLight));

      // ---- the Files view's preferences ----
      await js(`window.nexa.settings.set({ files: { layout: 'tiles', showHidden: true, sortKey: 'size', sortDir: -1 } })`);
      const files = (await js(`window.nexa.settings.get()`)).files;
      ok('the Files view preferences round trip',
        files.layout === 'tiles' && files.showHidden === true
        && files.sortKey === 'size' && files.sortDir === -1,
        JSON.stringify(files));

      const refused = await js(`window.nexa.settings.set({ files: { layout: 'cover-flow' } })`);
      ok('an invalid layout is refused rather than stored',
        refused.files.layout === 'tiles', refused.files.layout);

      // ---- keys ----
      const withKey = await js(`window.nexa.settings.set({ assistant: { keys: ['AIzaSyE2E-TEST-KEY-9876'] } })`);
      ok('a saved key is counted', withKey.assistant.keyCount === 1);
      ok('but only its last four characters come back',
        withKey.assistant.keyHints[0] === '…9876'
        && !JSON.stringify(withKey).includes('AIzaSyE2E'),
        withKey.assistant.keyHints[0]);

      const status = await js(`window.nexa.agent.status()`);
      ok('and the client is actually using it',
        status.configured === true && status.keyCount === 1 && status.keySource === 'settings',
        `${status.keyCount} from ${status.keySource}`);
      ok('the assistant reports its tool list', (status.tools || []).length >= 8,
        `${(status.tools || []).length} tools`);
      ok('and none of those tools can write anything',
        !(status.tools || []).some((t) => /delete|remove|move|write/i.test(t.name)),
        (status.tools || []).map((t) => t.name).join(' '));

      const cleared = await js(`window.nexa.settings.set({ assistant: { keys: [] } })`);
      ok('clearing the key empties the count', cleared.assistant.keyCount === 0);

      // ---- the model ----
      const modelSet = await js(`window.nexa.settings.set({ assistant: { model: 'gemini-2.5-flash' } })`);
      ok('a model choice is stored', modelSet.assistant.model === 'gemini-2.5-flash');
      const modelStatus = await js(`window.nexa.agent.status()`);
      ok('and handed to the client that will call it',
        modelStatus.model === 'gemini-2.5-flash', modelStatus.model);
      await js(`window.nexa.settings.set({ assistant: { model: null } })`);
      // Compared against the constant rather than a copy of its value: the
      // default moves whenever Google retires a model, and a literal here would
      // turn that into a test failure that says nothing about what broke.
      ok('clearing it restores the built-in default',
        (await js(`window.nexa.agent.status()`)).model === DEFAULT_MODEL, DEFAULT_MODEL);

      // ---- a half-typed question survives a re-render ----
      //
      // The session graph refreshes itself every fifteen seconds and re-renders
      // the shell with it, which used to wipe whatever was in the assistant's
      // composer. Anything the user typed vanished while they were typing it.
      const draft = await js(`(async () => {
        document.querySelector('#rail [data-view="overview"]').click();
        await new Promise((r) => setTimeout(r, 900));
        document.querySelector('#aside-tabs [data-tab="chat"]').click();
        await new Promise((r) => setTimeout(r, 400));
        const ta = document.querySelector('#chat-input');
        ta.focus();
        ta.value = 'which of these folders is safe to delete';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const typed = ta.value;

        // Switching aside tabs, and a full re-render of the shell.
        document.querySelector('#aside-tabs [data-tab="plan"]').click();
        await new Promise((r) => setTimeout(r, 250));
        document.querySelector('#aside-tabs [data-tab="chat"]').click();
        await new Promise((r) => setTimeout(r, 250));
        const afterTabs = document.querySelector('#chat-input').value;

        document.querySelector('#rail [data-view="overview"]').click();
        await new Promise((r) => setTimeout(r, 900));
        const el = document.querySelector('#chat-input');
        return { typed, afterTabs, afterRender: el ? el.value : '(composer gone)' };
      })()`);
      ok('the composer keeps its text across an aside tab switch',
        draft.afterTabs === draft.typed, draft.afterTabs);
      ok('and across a full re-render of the shell',
        draft.afterRender === draft.typed, draft.afterRender);

      // ---- this machine ----
      const m = await js(`window.nexa.system.machine()`);
      ok('the processor is reported', !!m.cpu.model && m.cpu.cores > 0,
        `${m.cpu.model} × ${m.cpu.cores}`);
      ok('memory is reported and adds up',
        m.memory.totalBytes > 0 && m.memory.usedBytes + m.memory.freeBytes === m.memory.totalBytes);
      ok('the OS is reported', !!m.os.hostname && !!m.os.release);
      ok('at least one display is reported', (m.displays || []).length > 0);
      ok('the runtime versions are the ones actually running',
        m.runtime.electron === process.versions.electron
        && m.runtime.node === process.versions.node);
      ok('the power source is answered either way',
        m.power.onBattery === true || m.power.onBattery === false || !!m.power.note);

      const storage = await js(`window.nexa.system.storage()`);
      ok('NexaFiles reports what it is storing',
        storage.index.bytes > 0 && storage.userData.length > 0,
        `${storage.index.bytes} bytes of index`);

      // ---- a model list without a key fails honestly ----
      const noKey = await js(`window.nexa.agent.models().then(() => null, (e) => e.message)`);
      ok('asking for models without a key says so rather than inventing a list',
        typeof noKey === 'string' && /API key/i.test(noKey), String(noKey).slice(0, 60));
    } catch (err) {
      ok(`unexpected failure: ${err.message}`, false);
    } finally {
      // Leave the machine as it was found.
      if (original) fs.writeFileSync(settingsFile, JSON.stringify(original, null, 2), 'utf8');
      else fs.rmSync(settingsFile, { force: true });
    }

    console.log(out.join('\n'));
    console.log(`\n  ${pass} passed, ${fail} failed`);
    app.exit(fail === 0 ? 0 : 1);
  }, 300);
});
