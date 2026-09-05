// Drives the real app through a scan and captures the populated interface,
// then checks the design constraints against the rendered DOM.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const logs = [];
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    if (e.level >= 2) logs.push(`[${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
});

require(path.join(__dirname, '..', '..', 'main.js'));
setTimeout(() => { console.log('TIMEOUT'); console.log(logs.join('\n')); app.exit(2); }, 170000);

const TARGET = process.argv[2] || path.join(os.homedir(), 'Documents');

app.whenReady().then(() => {
  const tick = setInterval(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.webContents.isLoading()) return;
    clearInterval(tick);
    await new Promise((r) => setTimeout(r, 1500));

    const js = (code) => win.webContents.executeJavaScript(code);

    console.log('scanning', TARGET);
    await js(`window.nexa.scan.start(${JSON.stringify(TARGET)})`);
    await new Promise((r) => setTimeout(r, 1200));

    // Reload the view the way the UI does after a scan completes.
    await js(`(async () => {
      const s = await window.nexa.scan.current();
      const c = await window.nexa.scan.composition(null, s.root);
      window.__probe = { scan: s, comp: c };
    })()`);
    await new Promise((r) => setTimeout(r, 800));

    const probe = await js(`(() => {
      const s = window.__probe.scan, c = window.__probe.comp;
      return {
        files: s.fileCount, bytes: s.totalBytes, status: s.status,
        categories: c.categories.map(x => x.category + '=' + x.bytes),
        children: c.children.length,
      };
    })()`);
    console.log('SCAN ' + JSON.stringify(probe));

    // Force the renderer to redraw with the scan loaded.
    await js(`location.reload()`);
    await new Promise((r) => setTimeout(r, 22000));

    let design;
    try {
      design = await js(`(() => {
        try {
          const txt = document.body.innerText || '';
          const radii = new Set();
          const grads = [];
          const crimson = [];
          for (const sheet of document.styleSheets) {
            let rules = [];
            try { rules = Array.from(sheet.cssRules || []); } catch (e) { continue; }
            for (const r of rules) {
              if (!r || !r.style) continue;
              const br = r.style.borderRadius;
              if (br) radii.add(br.trim());
              const bg = (r.style.background || '') + ' ' + (r.style.backgroundImage || '');
              if (bg.indexOf('gradient') !== -1) grads.push(r.selectorText || '?');
              const all = ((r.style.color||'') + (r.style.background||'') + (r.style.backgroundColor||'') + (r.style.borderColor||'')).toLowerCase();
              if (all.indexOf('c21d3e') !== -1 || all.indexOf('--reclaim') !== -1) crimson.push(r.selectorText || '?');
            }
          }
          const heroEl = document.querySelector('.hero-value');
          return {
            emoji: (txt.match(/\p{Extended_Pictographic}/gu) || []),
            arrows: (txt.match(/→/g) || []).length,
            middots: (txt.match(/·/g) || []).length,
            icons: document.querySelectorAll('svg.icon').length,
            illustrations: document.querySelectorAll('svg.illustration').length,
            treemapBlocks: document.querySelectorAll('.tm-block').length,
            legendItems: document.querySelectorAll('.legend-item').length,
            heroText: heroEl ? heroEl.innerText.replace(/\n/g, ' ') : null,
            heroFont: heroEl ? getComputedStyle(heroEl).fontFamily : null,
            bodyBg: getComputedStyle(document.body).backgroundColor,
            radii: Array.from(radii),
            gradients: grads,
            crimsonRules: crimson
          };
        } catch (e) { return { probeError: e.message }; }
      })()`);
    } catch (e) {
      design = { outerError: e.message };
    }
    console.log('DESIGN ' + JSON.stringify(design, null, 1));

    // Capture the top, then scroll and capture the lower half of the overview.
    const shoot = async (name) => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, name), img.toPNG());
      console.log('screenshot: ' + name);
    };
    await shoot('shot-1-top.png');
    await js("document.getElementById('stage').scrollTop = 780");
    await new Promise((r) => setTimeout(r, 700));
    await shoot('shot-2-mid.png');
    await js("document.getElementById('stage').scrollTop = 1700");
    await new Promise((r) => setTimeout(r, 700));
    await shoot('shot-3-low.png');
    if (logs.length) { console.log('--- renderer errors ---'); console.log(logs.join('\n')); }
    app.exit(0);
  }, 300);
});
