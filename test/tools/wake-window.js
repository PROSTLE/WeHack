// The listener window, end to end: does switching the setting on actually
// produce a window that has loaded the recogniser and armed itself, and does
// switching it off destroy it (and with it the microphone)?
const path=require('path');
const {app,BrowserWindow}=require('electron');
require(path.join(__dirname,'..','..','main.js'));
const wakeWindow=require('../../src/main/wake/window.js');
const overlay=require('../../src/main/overlay.js');

let pass=0,fail=0; const out=[];
const ok=(n,c,e='')=>{out.push((c?'  PASS  ':'  FAIL  ')+n+(e?'  '+e:''));c?pass++:fail++;};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

app.whenReady().then(async()=>{
  await sleep(3000);
  const { ipcMain } = require('electron');

  // Settings go through the real IPC path the interface uses.
  const invoke = (ch,...a)=>ipcMain._invokeHandlers.get(ch)({},...a);

  ok('no listener window before the wake word is switched on', !wakeWindow.get());

  await invoke('settings:set',{overlay:{wakeWord:true}});

  // Polled rather than slept at. The listener parses 5.8 MB of recogniser and
  // unpacks a 40 MB model before it is ready, and how long that takes depends
  // entirely on the machine — a fixed wait is either flaky or needlessly slow.
  const until = async (what, fn, ms=30000) => {
    const deadline = Date.now()+ms;
    while (Date.now() < deadline) {
      try { if (await fn()) return true; } catch { /* not up yet */ }
      await sleep(200);
    }
    console.log(`  (timed out waiting for ${what})`);
    return false;
  };

  const ready = await until('the listener to bind', async () => {
    const w = wakeWindow.get();
    if (!w || w.webContents.isLoading()) return false;
    return w.webContents.executeJavaScript(`typeof window.nexa?.wake?.hostReady === 'function' && typeof window.Vosk?.createModel === 'function'`);
  });
  ok('the listener came up within thirty seconds', ready);

  const win = wakeWindow.get();
  ok('switching it on creates the listener window', !!win);
  if (win) {
    ok('the listener is hidden', !win.isVisible());
    ok('and cannot take focus from what the user is typing in', !win.isFocusable());
    const url = win.webContents.getURL();
    ok('it loaded the listener document, not the panel', url.includes('wake.html'), url);

    const probe = await win.webContents.executeJavaScript(`({
      vosk: typeof window.Vosk?.createModel === 'function',
      bridge: typeof window.nexa?.wake?.hostReady === 'function',
      body: document.body.textContent.trim().length,
    })`);
    ok('the recogniser loaded there', probe.vosk);
    ok('the bridge is available to it', probe.bridge);
    ok('and the document renders nothing at all', probe.body === 0, `${probe.body} chars`);
  }

  // Opening the panel must suspend recognition.
  overlay.show({reason:'test'});
  const signalled = await until('the panel-open signal', async () => {
    const w2 = wakeWindow.get();
    return w2 && w2.webContents.executeJavaScript(`window.__wakePanelOpen === true`);
  }, 5000);
  ok('the panel opening is signalled to the listener, which stops recognising', signalled);

  overlay.hide();
  const cleared = await until('the panel-closed signal', async () => {
    const w2 = wakeWindow.get();
    return w2 && w2.webContents.executeJavaScript(`window.__wakePanelOpen === false`);
  }, 5000);
  ok('and closing it starts recognition again', cleared);

  await invoke('settings:set',{overlay:{wakeWord:false}});
  await sleep(800);
  ok('switching it off destroys the listener, closing the microphone', !wakeWindow.get());

  console.log(out.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  app.exit(fail?1:0);
}).catch(e=>{console.error(e);app.exit(1);});
