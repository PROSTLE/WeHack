const { contextBridge, ipcRenderer } = require('electron');

// Expose safe window-control and file system APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),

  // Directory operations
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  getDrives: () => ipcRenderer.invoke('get-drives'),
  getSpecialFolders: () => ipcRenderer.invoke('get-special-folders'),
  getDirectoryStats: (dirPath) => ipcRenderer.invoke('get-directory-stats', dirPath),

  // File info
  getFileStats: (filePath) => ipcRenderer.invoke('get-file-stats', filePath),
  readFileContent: (filePath) => ipcRenderer.invoke('read-file-content', filePath),
  readFileHead: (filePath, maxBytes) => ipcRenderer.invoke('read-file-head', filePath, maxBytes),
  hashFile: (filePath) => ipcRenderer.invoke('hash-file', filePath),

  // File operations
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  renameFile: (oldPath, newName) => ipcRenderer.invoke('rename-file', oldPath, newName),
  createFolder: (parentDir, folderName) => ipcRenderer.invoke('create-folder', parentDir, folderName),
  moveFile: (sourcePath, destDir) => ipcRenderer.invoke('move-file', sourcePath, destDir),
  openFileNative: (filePath) => ipcRenderer.invoke('open-file-native', filePath),
});
