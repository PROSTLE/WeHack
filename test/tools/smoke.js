const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const { mainWindow } = require('./main-window');
const rendererLogs = [];
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    rendererLogs.push(`[${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.on('did-fail-load', (_ev, code, desc, url) => {
    rendererLogs.push(`did-fail-load ${code} ${desc} ${url}`);
  });
  win.webContents.on('preload-error', (_ev, p, err) => {
    rendererLogs.push(`preload-error ${p}: ${err.message}`);
  });
});

require(path.join(__dirname, '..', '..', 'main.js'));

setTimeout(() => { dump(); app.exit(2); }, 22000);

function dump() {
  console.log('--- renderer console ---');
  rendererLogs.forEach((l) => console.log('  ' + l));
}

app.whenReady().then(() => {
  const tick = setInterval(async () => {
    const win = mainWindow(BrowserWindow);
    if (!win || win.webContents.isLoading()) return;
    clearInterval(tick);
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const probe = await win.webContents.executeJavaScript(
        `({ rail: document.querySelector('#rail').children.length,
            stage: document.getElementById('stage').innerText.slice(0,200),
            bridge: typeof window.nexa })`
      );
      console.log('PROBE ' + JSON.stringify(probe));
    } catch (e) {
      console.log('PROBE FAILED: ' + e.message);
    }
    dump();
    app.exit(0);
  }, 300);
});
