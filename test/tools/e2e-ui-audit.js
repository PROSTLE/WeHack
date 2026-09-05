// Every control in the interface, checked for a handler.
//
// The claim this test defends is narrow and worth defending: there is no button
// in NexaFiles that does nothing. It walks each view, enumerates every
// interactive element the user can see, and asks Chromium — through the
// DevTools protocol, not through the application's own code — whether that
// element or one of its ancestors actually has a listener bound to it.
//
// A disabled control is reported separately rather than counted as a failure:
// "Paste" with an empty clipboard is meant to be dead, and saying so is the
// honest result. What fails this test is an *enabled* control with nothing
// listening to it.
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond, extra = '') {
  out.push((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}

require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => {
  console.log(out.join('\n'));
  console.log('UI AUDIT TIMEOUT');
  app.exit(2);
}, 180000);

app.whenReady().then(() => {
  const tick = setInterval(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.webContents.isLoading()) return;
    clearInterval(tick);
    await new Promise((r) => setTimeout(r, 2500));

    const wc = win.webContents;
    const js = (code) => wc.executeJavaScript(code);

    wc.debugger.attach('1.3');
    const send = (method, params) => wc.debugger.sendCommand(method, params);
    await send('DOM.enable');
    await send('Runtime.enable');
    await send('DOMDebugger.enable').catch(() => {});

    /**
     * Interactive elements in a container, each with the number of click-ish
     * listeners bound to it or to any ancestor.
     */
    async function controlsIn(selector, label) {
      const { result } = await send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll(${JSON.stringify(selector)} + ' button, ' +
          ${JSON.stringify(selector)} + ' input, ' +
          ${JSON.stringify(selector)} + ' select, ' +
          ${JSON.stringify(selector)} + ' textarea, ' +
          ${JSON.stringify(selector)} + ' [role="tab"], ' +
          ${JSON.stringify(selector)} + ' [role="option"]')]`,
        returnByValue: false,
      });
      const { result: props } = await send('Runtime.getProperties', {
        objectId: result.objectId,
        ownProperties: true,
      });

      const controls = [];
      for (const p of props) {
        if (!/^\d+$/.test(p.name) || !p.value || !p.value.objectId) continue;
        const objectId = p.value.objectId;

        // What is it, and is it meant to be usable right now?
        const { result: desc } = await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function () {
            return JSON.stringify({
              tag: this.tagName.toLowerCase(),
              id: this.id || null,
              cls: this.className && this.className.toString ? this.className.toString().slice(0, 60) : '',
              text: (this.textContent || this.placeholder || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
              disabled: !!this.disabled,
              data: Object.keys(this.dataset || {}).join(','),
            });
          }`,
          returnByValue: true,
        });
        const info = JSON.parse(desc.value);

        // Listeners on the element itself, then on each ancestor: a menu whose
        // items are handled by one listener on the menu is wired, not inert.
        let listeners = 0;
        let current = objectId;
        for (let depth = 0; depth < 12 && current; depth++) {
          try {
            const res = await send('DOMDebugger.getEventListeners', { objectId: current, depth: 0 });
            listeners += (res.listeners || []).filter(
              (l) => ['click', 'mousedown', 'change', 'input', 'keydown', 'dblclick', 'submit'].includes(l.type)
            ).length;
          } catch { /* node gone; counted as zero at this level */ }
          if (listeners) break;
          const { result: parent } = await send('Runtime.callFunctionOn', {
            objectId: current,
            functionDeclaration: 'function () { return this.parentElement; }',
          });
          current = parent && parent.objectId ? parent.objectId : null;
        }

        controls.push({ ...info, listeners, where: label });
      }
      return controls;
    }

    async function auditView(label, selector) {
      const controls = await controlsIn(selector, label);
      const live = controls.filter((c) => !c.disabled);
      const inert = live.filter((c) => c.listeners === 0);
      const disabled = controls.length - live.length;

      ok(`${label}: every enabled control has a handler`,
        inert.length === 0,
        `${live.length} live` + (disabled ? `, ${disabled} deliberately disabled` : '') +
        (inert.length ? ` — INERT: ${inert.map((c) => c.id || c.text || c.cls).join(' | ')}` : ''));
      return controls.length;
    }

    try {
      let total = 0;

      // ---- the shell ----
      total += await auditView('Title bar', '.titlebar');
      total += await auditView('Sidebar', '#rail');
      total += await auditView('Assistant panel', '.aside');

      // ---- each view in turn ----
      const views = [
        ['Overview', 'overview', 2200],
        ['Files', 'files', 3000],
        ['Duplicates', 'duplicates', 1200],
        ['Leftovers', 'leftovers', 1200],
        ['Startup', 'startup', 1200],
        ['System', 'system', 1200],
        ['Quarantine', 'quarantine', 1200],
        ['Settings', 'settings', 2000],
      ];
      for (const [label, id, wait] of views) {
        const clicked = await js(`(() => {
          const b = document.querySelector('#rail [data-view="${id}"]');
          if (!b) return false; b.click(); return true;
        })()`);
        ok(`${label} opens from the sidebar`, clicked === true);
        await new Promise((r) => setTimeout(r, wait));
        total += await auditView(label, '#stage');
      }

      // ---- the settings sections, which are separate renders ----
      for (const section of ['assistant', 'machine', 'access', 'data']) {
        const clicked = await js(`(() => {
          const b = document.querySelector('[data-section="${section}"]');
          if (!b) return false; b.click(); return true;
        })()`);
        ok(`Settings › ${section} opens`, clicked === true);
        await new Promise((r) => setTimeout(r, section === 'machine' ? 2600 : 1400));
        total += await auditView(`Settings › ${section}`, '#stage');
      }

      // ---- nothing on screen may overlap something else on screen ----
      //
      // The session graph labels its x-axis with times, and NexaFiles only
      // records while it is open, so a session with a gap puts many samples
      // into a narrow band. Thinning the labels by index rather than by
      // position printed them on top of each other.
      await js(`document.querySelector('#rail [data-view="overview"]').click()`);
      await new Promise((r) => setTimeout(r, 2600));
      const axis = await js(`(() => {
        const frame = document.querySelector('.chart-frame');
        if (!frame) return { skipped: true };
        const boxes = [...frame.querySelectorAll('text')]
          .filter((t) => /:/.test(t.textContent))
          .map((t) => { const b = t.getBoundingClientRect();
            return { text: t.textContent.trim(), left: b.left, right: b.right }; })
          .sort((a, b) => a.left - b.left);
        let overlaps = [];
        for (let i = 1; i < boxes.length; i++) {
          if (boxes[i].left < boxes[i - 1].right) overlaps.push(boxes[i - 1].text + '/' + boxes[i].text);
        }
        const fb = frame.getBoundingClientRect();
        const outside = boxes
          .filter((b) => b.left < fb.left - 1 || b.right > fb.right + 1)
          .map((b) => b.text);
        return { skipped: false, count: boxes.length, overlaps, outside };
      })()`);
      if (axis.skipped) {
        out.push('  SKIP  the session graph has too few samples to label');
      } else {
        ok('no two axis labels overlap', axis.overlaps.length === 0,
          `${axis.count} labels` + (axis.overlaps.length ? ` — ${axis.overlaps.join(', ')}` : ''));
        ok('and none is clipped by the edge of the chart',
          axis.outside.length === 0, axis.outside.join(', '));
      }

      // ---- panels that only exist after an action ----
      await js(`document.querySelector('#rail [data-view="files"]').click()`);
      await new Promise((r) => setTimeout(r, 2000));
      const menuOpened = await js(`(async () => {
        const row = document.querySelector('.ex-row');
        if (!row) return false;
        row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
        await new Promise((r) => setTimeout(r, 400));
        return !!document.querySelector('.ex-context');
      })()`);
      ok('the Files context menu opens', menuOpened === true);
      if (menuOpened) total += await auditView('Files context menu', '.ex-context');
      await js(`document.querySelector('.ex-context')?.remove()`);

      const sortMenu = await js(`(async () => {
        document.querySelector('#ex-sort-btn').click();
        await new Promise((r) => setTimeout(r, 300));
        const m = document.querySelector('#ex-sort-menu');
        return !!m && !m.hidden;
      })()`);
      ok('the Sort menu opens', sortMenu === true);
      if (sortMenu) total += await auditView('Sort menu', '#ex-sort-menu');

      const viewMenu = await js(`(async () => {
        document.querySelector('#ex-view-btn').click();
        await new Promise((r) => setTimeout(r, 300));
        const m = document.querySelector('#ex-view-menu');
        return !!m && !m.hidden;
      })()`);
      ok('the View menu opens', viewMenu === true);
      if (viewMenu) total += await auditView('View menu', '#ex-view-menu');

      // ---- the assistant tab, whose composer is built on demand ----
      await js(`document.querySelector('#aside-tabs [data-tab="chat"]').click()`);
      await new Promise((r) => setTimeout(r, 600));
      total += await auditView('Assistant composer', '.aside');

      out.push(`\n  ${total} controls examined`);
    } catch (err) {
      ok(`the audit itself failed: ${err.message}`, false);
    }

    try { wc.debugger.detach(); } catch { /* already gone */ }
    console.log(out.join('\n'));
    console.log(`\n  ${pass} passed, ${fail} failed`);
    app.exit(fail === 0 ? 0 : 1);
  }, 300);
});
