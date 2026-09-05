'use strict';
// Document conversion: turning a file into another format, without ever
// destroying the one that was there.
//
// Three rules hold, and they are the reason this module can exist in an
// application whose premise is that it never damages anything:
//
//   1. The source is opened read-only and is never deleted, moved or rewritten.
//      A conversion adds a file. If it fails, the disk is as it was.
//   2. Nothing is overwritten silently. A destination that already exists is
//      either refused or given a numbered name, never replaced, because the file
//      standing in the way is one the user made and this tool did not measure.
//   3. What cannot be converted is said plainly. The set of possible conversions
//      depends on what is installed on this machine, so it is discovered at
//      runtime and reported honestly — never assumed, never faked with a
//      lower-fidelity substitute the user did not ask for.
//
// Fidelity note: Office's own PDF export is used where Office is present because
// it is the renderer that produced the layout in the first place. LibreOffice is
// the fallback. Neither is bundled — an Electron installer cannot ship an office
// suite — so a machine with neither gets rule 3.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');

const roots = require('../security/roots');

const SCRIPT = path.join(__dirname, 'office-convert.ps1');

// A conversion drives a whole office suite: first launch is slow, and a document
// with a hundred embedded images is slower. Past this something is wrong — a
// modal dialog waiting on a desktop nobody can see is the usual cause — and
// hanging forever is worse than failing.
const TIMEOUT_MS = 180_000;

// What each Office application can open, lowercased and without the dot.
const WORD = ['doc', 'docx', 'docm', 'rtf', 'odt', 'txt', 'html', 'htm'];
const POWERPOINT = ['ppt', 'pptx', 'pptm', 'odp'];
const EXCEL = ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods'];

const LIBREOFFICE_CANDIDATES = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/soffice',
  '/usr/bin/libreoffice',
  '/snap/bin/libreoffice',
];

/** Runs a program without a shell, so no argument is ever re-parsed. */
function run(file, args, { env = {}, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout,
      windowsHide: true,
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * Asks Windows whether an Office application is actually registered.
 *
 * The question is put to the COM registry rather than answered by looking for an
 * installation directory, because a folder left behind by an uninstall would
 * otherwise be read as a working Word — and this application exists partly to
 * point out that such folders are litter.
 */
async function probeOfficeApp(progId) {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `if ([Type]::GetTypeFromProgID('${progId}')) { 'yes' } else { 'no' }`,
    ], { timeout: 20_000 });
    return stdout.trim() === 'yes';
  } catch {
    return false;
  }
}

function findLibreOffice() {
  for (const p of LIBREOFFICE_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable, treat as absent */ }
  }
  return null;
}

let cached = null;

/**
 * What this machine can convert, right now.
 *
 * Cached after the first call: probing spawns PowerShell three times, and the
 * answer does not change while the application is running. `refresh` exists for
 * the case where the user installs Office and would reasonably expect the
 * application to notice without a restart.
 */
async function capabilities({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  const [word, powerpoint, excel] = await Promise.all([
    probeOfficeApp('Word.Application'),
    probeOfficeApp('PowerPoint.Application'),
    probeOfficeApp('Excel.Application'),
  ]);
  const libreOffice = findLibreOffice();

  const from = new Set();
  if (word) WORD.forEach((e) => from.add(e));
  if (powerpoint) POWERPOINT.forEach((e) => from.add(e));
  if (excel) EXCEL.forEach((e) => from.add(e));
  if (libreOffice) [...WORD, ...POWERPOINT, ...EXCEL].forEach((e) => from.add(e));

  const engines = [];
  if (word || powerpoint || excel) {
    engines.push({
      id: 'office',
      label: 'Microsoft Office',
      apps: { word, powerpoint, excel },
      note: 'Uses each application’s own PDF export, which is the renderer that produced the layout.',
    });
  }
  if (libreOffice) {
    engines.push({ id: 'libreoffice', label: 'LibreOffice', path: libreOffice });
  }

  cached = {
    available: engines.length > 0,
    engines,
    // Sorted so the interface can render a stable list rather than a set's order.
    canConvertFrom: [...from].sort(),
    to: engines.length ? ['pdf'] : [],
    why: engines.length
      ? null
      : 'No document converter is installed. NexaFiles converts documents using Microsoft ' +
        'Office or LibreOffice, and neither was found on this machine. Installing either ' +
        'one enables conversion; NexaFiles cannot bundle an office suite.',
  };
  return cached;
}

/** The extension without its dot, lowercased. `''` when there is none. */
function extOf(p) {
  return path.extname(p).replace(/^\./, '').toLowerCase();
}

/**
 * The path a conversion would write to, and whether anything is already there.
 *
 * Kept separate from `convert` so the interface can show the user the exact
 * destination before anything runs. A proposal that does not say where the file
 * lands is asking for approval of something unstated.
 */
function destinationFor(sourcePath, { outDir = null, format = 'pdf' } = {}) {
  const dir = outDir || path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const target = path.join(dir, `${base}.${format}`);
  return { target, exists: fs.existsSync(target) };
}

/** `notes.pdf` taken -> `notes (2).pdf`. Never returns a path that exists. */
function uniqueDestination(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${base} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find an unused name next to ${target}.`);
}

/**
 * Converts one file.
 *
 * @param {string} sourcePath          file to read; must be inside an approved root
 * @param {object} [opts]
 * @param {string} [opts.format]       target format; only 'pdf' is supported today
 * @param {string} [opts.outDir]       destination directory; defaults to the source's
 * @param {'refuse'|'rename'} [opts.onConflict]  what to do when the target exists
 * @returns {Promise<{ok: true, source: string, target: string, bytes: number, engine: string, ms: number}>}
 * @throws when the path is outside a root, the format is unsupported, or the
 *         converter failed — never silently producing a partial file
 */
async function convert(sourcePath, { format = 'pdf', outDir = null, onConflict = 'refuse' } = {}) {
  if (format !== 'pdf') {
    throw new Error(`NexaFiles can convert to PDF. "${format}" is not a format it can write.`);
  }

  // Both ends are checked. A source inside a root that writes its output outside
  // one would be a way to place a file anywhere on the disk.
  const src = roots.assertInsideRoot(sourcePath, { mustExist: true });
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    throw new Error(`${path.basename(src)} is a folder. Only files can be converted.`);
  }

  const ext = extOf(src);
  const caps = await capabilities();
  if (!caps.available) throw new Error(caps.why);
  if (!caps.canConvertFrom.includes(ext)) {
    throw new Error(
      `${ext ? `.${ext} files` : 'Files without an extension'} cannot be converted on this ` +
      `machine. Convertible here: ${caps.canConvertFrom.map((e) => `.${e}`).join(', ')}.`
    );
  }

  const destDir = roots.assertInsideRoot(outDir || path.dirname(src), { mustExist: true });
  let { target, exists } = destinationFor(src, { outDir: destDir, format });
  if (exists) {
    if (onConflict === 'rename') {
      target = uniqueDestination(target);
    } else {
      const err = new Error(
        `${path.basename(target)} already exists in that folder. NexaFiles will not ` +
        `overwrite a file it did not create.`
      );
      err.code = 'TARGET_EXISTS';
      err.target = target;
      throw err;
    }
  }

  const started = Date.now();
  const engine = caps.engines[0];

  // Written to a temporary name first, then moved into place. A converter killed
  // half-way through would otherwise leave a truncated PDF sitting at the name of
  // a document the user believes was converted.
  const staging = path.join(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'nexafiles-convert-')),
    path.basename(target)
  );

  try {
    if (engine.id === 'office') {
      await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
      ], { env: { NEXA_SRC: src, NEXA_DST: staging } });
    } else {
      await run(engine.path, [
        '--headless', '--norestore', '--convert-to', format,
        '--outdir', path.dirname(staging), src,
      ]);
      // LibreOffice names the output after the source and ignores any name given
      // to it, so the file it actually wrote is found and moved.
      const produced = path.join(
        path.dirname(staging),
        `${path.basename(src, path.extname(src))}.${format}`
      );
      if (produced !== staging) await fsp.rename(produced, staging);
    }

    const outStat = await fsp.stat(staging);
    if (outStat.size === 0) throw new Error('The converter produced an empty file.');

    // Re-checked immediately before the move: the conflict test above happened
    // before a conversion that may have taken minutes, and something else may
    // have written that name in the meantime.
    if (fs.existsSync(target)) {
      if (onConflict !== 'rename') {
        const err = new Error(`${path.basename(target)} appeared while the conversion was running.`);
        err.code = 'TARGET_EXISTS';
        throw err;
      }
      target = uniqueDestination(target);
    }
    await fsp.rename(staging, target).catch(async (err) => {
      // A staging directory on another volume cannot be renamed across, which is
      // the ordinary case when TEMP and the destination are different drives.
      if (err.code !== 'EXDEV') throw err;
      await fsp.copyFile(staging, target);
      await fsp.unlink(staging).catch(() => {});
    });

    return {
      ok: true,
      source: src,
      target,
      bytes: (await fsp.stat(target)).size,
      sourceBytes: stat.size,
      engine: engine.id,
      ms: Date.now() - started,
    };
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      throw new Error(
        `Converting ${path.basename(src)} took longer than ${Math.round(TIMEOUT_MS / 1000)} ` +
        `seconds and was stopped. The source file was not changed.`
      );
    }
    // Office reports failures on stderr; surfacing it beats "conversion failed".
    const detail = (err.stderr || '').trim().split('\n')[0];
    throw new Error(
      `Could not convert ${path.basename(src)}${detail ? `: ${detail}` : `: ${err.message}`}`
    );
  } finally {
    await fsp.rm(path.dirname(staging), { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  capabilities,
  convert,
  destinationFor,
  uniqueDestination,
  extOf,
  WORD,
  POWERPOINT,
  EXCEL,
};
