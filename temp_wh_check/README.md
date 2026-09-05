# NexaFiles – AI File Manager
### Electron Desktop App

A sleek, AI-powered file manager desktop application built with Electron.

---

## 📦 Prerequisites

- **Node.js** v18 or later → https://nodejs.org
- **npm** (comes with Node.js)

---

## 🚀 Quick Start (Run in Dev Mode)

```bash
# 1. Install dependencies
npm install

# 2. Launch the app
npm start
```

---

## 🏗️ Build Installers

### Windows (.exe installer)
```bash
npm run build:win
```
Output: `dist/NexaFiles Setup 1.0.0.exe`

### macOS (.dmg)
```bash
npm run build:mac
```
Output: `dist/NexaFiles-1.0.0.dmg`
> **Note:** macOS builds must be run on a Mac.

### Linux (.AppImage / .deb)
```bash
npm run build:linux
```

### All platforms at once
```bash
npm run build:all
```

---

## 📁 Project Structure

```
nexafiles/
├── main.js          ← Electron main process (window, IPC)
├── preload.js       ← Secure IPC bridge
├── package.json     ← Dependencies & build config
├── src/
│   └── index.html   ← App UI (all HTML/CSS/JS)
└── assets/
    ├── icon.png     ← App icon (Linux / Windows fallback)
    ├── icon.ico     ← Windows icon
    └── icon.icns    ← macOS icon
```

---

## ✨ Features

- **AI Suggested** – Smart file picks based on recency and usage
- **Duplicate Detection** – Find and remove duplicate files
- **AI Sort** – One-click intelligent file grouping by type
- **AI Search** – Natural language queries like *"large files"* or *"recent PDFs"*
- **Full keyboard shortcuts** – Ctrl+C, Ctrl+X, Ctrl+V, Delete, F2, Ctrl+A
- **Context menus**, modals, and native window controls
- **Custom frameless window** with draggable titlebar

---

## 🖼️ Adding a Custom Icon

Place your icon files in the `assets/` folder:
- `icon.png` — 512×512 PNG (Linux & fallback)
- `icon.ico` — Windows multi-size ICO
- `icon.icns` — macOS ICNS

Free tools to convert PNG → ICO/ICNS:
- https://cloudconvert.com/png-to-ico
- https://cloudconvert.com/png-to-icns
