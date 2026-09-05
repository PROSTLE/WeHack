// Finds the application's main window.
//
// Every end-to-end suite used to take `BrowserWindow.getAllWindows()[0]` and
// assume it was the interface. That was never guaranteed — the array is not
// documented as being in creation order — and it stopped being true the moment
// the overlay panel started existing as a second, hidden window. The failure it
// produced was a confusing one: every assertion that went through the bridge
// passed, because the overlay shares the same preload, and the first assertion
// that touched the DOM failed with "cannot read properties of null" because the
// overlay's document has none of the interface's elements in it.
//
// So the window is named rather than guessed at.

const MAIN_DOCUMENT = 'index.html';

/**
 * @param {typeof import('electron').BrowserWindow} BrowserWindow
 * @returns {import('electron').BrowserWindow|null}
 */
function mainWindow(BrowserWindow) {
  const windows = BrowserWindow.getAllWindows();
  return windows.find((w) => {
    try {
      return w.webContents.getURL().includes(MAIN_DOCUMENT);
    } catch {
      return false;   // destroyed between the listing and the question
    }
  }) || null;
}

module.exports = { mainWindow, MAIN_DOCUMENT };
