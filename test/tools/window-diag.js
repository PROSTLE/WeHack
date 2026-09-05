const path = require('path');
const { app, BrowserWindow } = require('electron');
const marks = [];
const t0 = Date.now();
const mark = (m) => { marks.push(`${String(Date.now()-t0).padStart(6)}ms  ${m}`); };

app.on('browser-window-created', (_e, win) => {
  mark('browser-window-created');
  win.once('ready-to-show', () => mark('EVENT ready-to-show'));
  win.webContents.once('did-finish-load', () => mark('EVENT did-finish-load'));
  win.webContents.once('dom-ready', () => mark('EVENT dom-ready'));
  win.once('show', () => mark('EVENT show'));
  win.webContents.on('render-process-gone', (_ev, d) => mark('render-process-gone: ' + JSON.stringify(d)));
  win.webContents.on('preload-error', (_ev, p, err) => mark('preload-error: ' + err.message));
  win.webContents.on('console-message', (e) => { if (e.level >= 2) mark('console: ' + e.message); });
});

require(path.join(__dirname, '..', '..', 'main.js'));

setTimeout(() => {
  const w = BrowserWindow.getAllWindows()[0];
  mark('--- after 8s ---');
  if (!w) { mark('NO WINDOW OBJECT'); }
  else {
    mark('isVisible()   = ' + w.isVisible());
    mark('isMinimized() = ' + w.isMinimized());
    mark('isDestroyed() = ' + w.isDestroyed());
    mark('getBounds()   = ' + JSON.stringify(w.getBounds()));
    mark('isLoading()   = ' + w.webContents.isLoading());
  }
  console.log(marks.join('\n'));
  app.exit(0);
}, 8000);
