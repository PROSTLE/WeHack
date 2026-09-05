const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const os = require('os');
const { execSync, spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// Load local config (Gemini API key etc.)
let appConfig = {};
try { appConfig = require('./config'); } catch (e) { /* config.js not present, fine */ }

let mainWindow;
let db;
let aiServerProcess = null;
const AI_SERVER_URL = 'http://127.0.0.1:5050';

// ── Start the Python AI (Flask + sklearn + Gemini) server ──
function startAIServer() {
  const projectRoot = __dirname;
  const venvPython = path.join(projectRoot, 'ai', 'venv', 'bin', 'python3');
  const serverScript = path.join(projectRoot, 'ai', 'classify_server.py');

  // Pass Gemini API key from env or config.js to child process
  const env = { ...process.env };
  if (appConfig.GEMINI_API_KEY && appConfig.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE') {
    env.GEMINI_API_KEY = appConfig.GEMINI_API_KEY;
  }

  aiServerProcess = spawn(venvPython, [serverScript], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  aiServerProcess.stdout.on('data', (d) => console.log('[AI Server]', d.toString().trim()));
  aiServerProcess.stderr.on('data', (d) => console.error('[AI Server ERR]', d.toString().trim()));
  aiServerProcess.on('error', (e) => console.error('[AI Server] Failed to start:', e.message));
  aiServerProcess.on('close', (code) => {
    console.log(`[AI Server] Process exited with code ${code}`);
    aiServerProcess = null;
  });
  console.log('[AI Server] Spawned PID:', aiServerProcess.pid);
}

// ── Helper: proxy a POST request to AI server ──
async function aiPost(endpoint, body) {
  try {
    const resp = await fetch(`${AI_SERVER_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    return await resp.json();
  } catch (err) {
    console.error(`[AI IPC] ${endpoint} error:`, err.message);
    return null;
  }
}


async function initDB() {
  const dbPath = path.join(app.getPath('userData'), 'nexafiles_index.db');
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE,
      name TEXT,
      isDirectory BOOLEAN,
      size INTEGER,
      modified TEXT,
      created TEXT,
      accessed TEXT,
      extension TEXT,
      tags TEXT,
      type TEXT,
      sensitivity TEXT,
      isDuplicate BOOLEAN,
      starred BOOLEAN DEFAULT 0
    )
  `);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0F172A',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  Menu.setApplicationMenu(null);

  // ── SECURITY: Permission handler ──
  // Only allow microphone access (for voice input).
  // Deny ALL other permissions (camera, geolocation, notifications, etc.).
  // This ensures even if the app is compromised, it cannot access anything else.
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media'];  // 'media' covers microphone
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      console.warn(`Blocked permission request: ${permission}`);
      callback(false);
    }
  });

  // Also handle permission checks (for `navigator.permissions.query`)
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission === 'media') return true;
    return false;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC: Window controls ──
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('win-close', () => mainWindow?.close());

// ── IPC: Home directory ──
ipcMain.handle('get-home-dir', () => {
  return os.homedir();
});

// ── IPC: Get Windows drives ──
ipcMain.handle('get-drives', async () => {
  try {
    if (process.platform === 'win32') {
      // Use wmic to enumerate logical drives
      const raw = execSync('wmic logicaldisk get DeviceID,Size,FreeSpace,VolumeName /format:csv', { encoding: 'utf8' });
      const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('Node'));
      const drives = [];
      for (const line of lines) {
        const parts = line.trim().split(',');
        if (parts.length >= 5) {
          const [, deviceID, freeSpace, size, volumeName] = parts;
          if (deviceID && deviceID.match(/^[A-Z]:$/i)) {
            drives.push({
              letter: deviceID.trim(),
              name: volumeName ? volumeName.trim() : '',
              path: deviceID.trim() + '\\',
              totalBytes: parseInt(size) || 0,
              freeBytes: parseInt(freeSpace) || 0,
            });
          }
        }
      }
      return drives;
    } else {
      // macOS / Linux: get real disk usage via df
      try {
        const dfOutput = execSync('df -k /', { encoding: 'utf8' });
        const lines = dfOutput.trim().split('\n');
        if (lines.length >= 2) {
          const parts = lines[1].trim().split(/\s+/);
          // df -k columns: Filesystem, 1K-blocks, Used, Available, Use%, Mounted on
          const totalBytes = (parseInt(parts[1]) || 0) * 1024;
          const availableBytes = (parseInt(parts[3]) || 0) * 1024;
          const driveName = process.platform === 'darwin' ? 'Macintosh HD' : 'Root';
          return [{ letter: '/', name: driveName, path: '/', totalBytes, freeBytes: availableBytes }];
        }
      } catch (dfErr) {
        console.error('df error:', dfErr);
      }
      return [{ letter: '/', name: 'Root', path: '/', totalBytes: 0, freeBytes: 0 }];
    }
  } catch (err) {
    console.error('get-drives error:', err);
    return [];
  }
});

// ── IPC: Get special user folders ──
ipcMain.handle('get-special-folders', () => {
  const home = os.homedir();
  return {
    home,
    desktop: path.join(home, 'Desktop'),
    documents: path.join(home, 'Documents'),
    downloads: path.join(home, 'Downloads'),
    music: path.join(home, 'Music'),
    pictures: path.join(home, 'Pictures'),
    videos: path.join(home, 'Videos'),
    recyclebin: process.platform === 'win32' ? 'shell:RecycleBinFolder' : null,
  };
});

// ── IPC: Select directory ──
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// ── IPC: Read directory with full metadata ──
ipcMain.handle('read-directory', async (event, dirPath) => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter(entry => !entry.name.startsWith('.')) // hide dotfiles
        .map(async (entry) => {
          const fullPath = path.join(dirPath, entry.name);
          try {
            const stats = await fs.stat(fullPath);
            return {
              name: entry.name,
              path: fullPath,
              isDirectory: entry.isDirectory(),
              size: stats.size,
              modified: stats.mtime.toISOString(),
              created: stats.birthtime.toISOString(),
              accessed: stats.atime.toISOString(),
              extension: path.extname(entry.name).toLowerCase()
            };
          } catch (err) {
            return null;
          }
        })
    );
    return files.filter(f => f !== null);
  } catch (error) {
    console.error('Error reading directory:', error);
    throw error;
  }
});

// ── IPC: Get file stats ──
ipcMain.handle('get-file-stats', async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      modified: stats.mtime.toISOString(),
      created: stats.birthtime.toISOString(),
      accessed: stats.atime.toISOString(),
      isDirectory: stats.isDirectory()
    };
  } catch (error) {
    throw error;
  }
});

// ── IPC: Read file content (text) ──
ipcMain.handle('read-file-content', async (event, filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (error) {
    throw error;
  }
});

// ── IPC: Read first N bytes of a file (for PII scanning) ──
ipcMain.handle('read-file-head', async (event, filePath, maxBytes = 8192) => {
  try {
    const fd = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buffer, 0, maxBytes, 0);
    await fd.close();
    return buffer.slice(0, bytesRead).toString('utf8', 0, bytesRead);
  } catch (error) {
    // Binary or unreadable file
    return null;
  }
});

// ── IPC: Compute file hash (MD5 for duplicate detection) ──
ipcMain.handle('hash-file', async (event, filePath) => {
  try {
    const content = await fs.readFile(filePath);
    return crypto.createHash('md5').update(content).digest('hex');
  } catch (error) {
    return null;
  }
});

// ── IPC: Delete file (move to trash) ──
ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    await shell.trashItem(filePath);
    return { success: true };
  } catch (error) {
    console.error('Delete failed:', error);
    return { success: false, error: error.message };
  }
});

// ── IPC: Rename file/folder ──
ipcMain.handle('rename-file', async (event, oldPath, newName) => {
  try {
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);
    await fs.rename(oldPath, newPath);
    return { success: true, newPath };
  } catch (error) {
    console.error('Rename failed:', error);
    return { success: false, error: error.message };
  }
});

// ── IPC: Create folder ──
ipcMain.handle('create-folder', async (event, parentDir, folderName) => {
  try {
    const folderPath = path.join(parentDir, folderName);
    await fs.mkdir(folderPath, { recursive: true });
    return { success: true, path: folderPath };
  } catch (error) {
    console.error('Create folder failed:', error);
    return { success: false, error: error.message };
  }
});

// ── IPC: Move file ──
ipcMain.handle('move-file', async (event, sourcePath, destDir) => {
  try {
    const fileName = path.basename(sourcePath);
    const destPath = path.join(destDir, fileName);
    await fs.rename(sourcePath, destPath);
    return { success: true, newPath: destPath };
  } catch (error) {
    console.error('Move failed:', error);
    return { success: false, error: error.message };
  }
});

// ── IPC: Open file with system default app ──
ipcMain.handle('open-file-native', async (event, filePath) => {
  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ── IPC: Get directory size (recursive) ──
ipcMain.handle('get-directory-stats', async (event, dirPath) => {
  try {
    let totalSize = 0;
    let fileCount = 0;
    let folderCount = 0;

    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            folderCount++;
            await walk(fullPath);
          } else {
            const stats = await fs.stat(fullPath);
            totalSize += stats.size;
            fileCount++;
          }
        } catch (e) { /* skip inaccessible */ }
      }
    }
    await walk(dirPath);
    return { totalSize, fileCount, folderCount };
  } catch (error) {
    throw error;
  }
});

// ── IPC: Local DB Index ──
ipcMain.handle('db-get-all-files', async () => {
  try {
    const rawFiles = await db.all('SELECT * FROM files');
    return rawFiles.map(f => ({
      ...f,
      isDirectory: !!f.isDirectory,
      isDuplicate: !!f.isDuplicate,
      starred: !!f.starred,
      tags: f.tags ? JSON.parse(f.tags) : []
    }));
  } catch (error) {
    console.error('DB get error:', error);
    return [];
  }
});

ipcMain.handle('db-insert-file', async (event, fileData) => {
  const { path: fpath, name, isDirectory, size, modified, created, accessed, extension, tags, type, sensitivity, isDuplicate, starred } = fileData;
  try {
    await db.run(`INSERT OR REPLACE INTO files (path, name, isDirectory, size, modified, created, accessed, extension, tags, type, sensitivity, isDuplicate, starred)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fpath, name, isDirectory ? 1 : 0, size, modified, created, accessed, extension, JSON.stringify(tags || []), type, sensitivity, isDuplicate ? 1 : 0, starred ? 1 : 0]
    );
    return { success: true };
  } catch (error) {
    console.error('DB insert error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('db-delete-file', async (event, filePath) => {
  await db.run('DELETE FROM files WHERE path = ?', [filePath]);
  return { success: true };
});

ipcMain.handle('db-clear-index', async () => {
  await db.run('DELETE FROM files');
  return { success: true };
});

// ── AI IPC Handlers ──
ipcMain.handle('ai-health', async () => {
  try {
    const resp = await fetch(`${AI_SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return await resp.json();
  } catch {
    return { status: 'offline', sklearn: false, gemini: false };
  }
});

ipcMain.handle('ai-classify', async (event, { filename, extension, content_snippet }) => {
  const result = await aiPost('/classify', { filename, extension, content_snippet });
  return result; // { category, confidence, probabilities } or null on error
});

ipcMain.handle('ai-summarize', async (event, { filename, content_snippet }) => {
  const result = await aiPost('/summarize', { filename, content_snippet });
  return result ? result.summary : null;
});

ipcMain.handle('ai-chat', async (event, { message, context }) => {
  const result = await aiPost('/chat', { message, context });
  return result || null;  // return full object: { reply, action, gemini_available }
});

// ── App lifecycle ──
app.whenReady().then(async () => {
  await initDB();
  startAIServer();
  createWindow();
});

app.on('window-all-closed', () => {
  // Kill the AI server process
  if (aiServerProcess) {
    aiServerProcess.kill();
    aiServerProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (aiServerProcess) {
    aiServerProcess.kill();
    aiServerProcess = null;
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
