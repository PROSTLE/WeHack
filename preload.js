const { contextBridge, ipcRenderer } = require('electron');

// Expose safe window-control and file system APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),
  
  // File system operations
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  getFileStats: (filePath) => ipcRenderer.invoke('get-file-stats', filePath),
  readFileContent: (filePath) => ipcRenderer.invoke('read-file-content', filePath),
});
