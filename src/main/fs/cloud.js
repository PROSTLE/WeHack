'use strict';
// Cloud sync folders, and the files in them that are not really there.
//
// OneDrive, Google Drive and Dropbox all present themselves as ordinary
// folders, and NexaFiles has always been able to scan them for that reason.
// What it could not do until now is tell the difference between a file in one
// of those folders and a *placeholder* for a file in one of those folders.
//
// A placeholder is Windows' "Files On-Demand": the directory entry exists, the
// filesystem reports the file's full size, and none of those bytes are on this
// disk. Reading one byte downloads the whole file. That single fact breaks
// three things at once if it is not known about:
//
//   1. The measurement. NexaFiles claims to show what is actually on your
//      disk. Counting 40 GB of placeholders as 40 GB of disk usage makes that
//      claim false, and makes "reclaimable" nonsense — deleting a placeholder
//      frees almost nothing locally.
//   2. The scans. Duplicate detection hashes file contents. Run over a
//      dehydrated OneDrive it would download every file in it, which for a
//      large account is hundreds of gigabytes, hours of transfer, and on a
//      metered connection, money. Describing files has the same problem.
//   3. The safety pipeline. Deleting a file inside a sync folder does not just
//      delete it here — the deletion propagates to the cloud and to every
//      other device signed in. NexaFiles' whole promise is that removals are
//      reversible via the recycle bin or quarantine, and for a synced file
//      that promise does not hold the way the user expects.
//
// WHAT IS MEASURED AND WHAT IS INFERRED, because they are not the same:
//
//   * `physicalBytes` is measured. `stat.blocks` is the count of 512-byte
//     blocks the filesystem has actually allocated, and Node reports it on
//     Windows. A file with a size and zero allocated blocks is occupying no
//     space here. That is a fact, whatever the cause.
//   * `placeholder` is inferred, and the inference is stated. Zero allocated
//     blocks is not proof on its own: NTFS stores a small enough file entirely
//     inside its MFT record, where it also reports zero blocks. `desktop.ini`
//     at 93 bytes on this machine does exactly that and is a perfectly real
//     file. So the inference requires the file to be inside a known sync
//     folder AND to be larger than any resident file can be. Below that size
//     the distinction is not worth making and is not made.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

// NTFS stores a file inside its own MFT record when it fits; the record is
// 1 KB and holds attributes as well, so nothing near 4 KB is ever resident.
// Under this size, "zero blocks" says nothing and no claim is made.
const RESIDENT_CEILING = 4096;

/** Case-folded, resolved path, matching how the rest of the app keys paths. */
function keyOf(p) {
  return process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase();
}

/**
 * The sync folders on this machine.
 *
 * Found by looking for the folders the desktop clients actually create, plus
 * the environment variables OneDrive sets for itself. Nothing is contacted and
 * no credentials are involved: this is a question about directories.
 */
async function detectProviders() {
  const home = os.homedir();
  const found = [];
  const seen = new Set();

  const add = async (dir, provider, label, extra = {}) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    const k = keyOf(resolved);
    if (seen.has(k)) return;
    try {
      const st = await fsp.stat(resolved);
      if (!st.isDirectory()) return;
    } catch { return; }
    seen.add(k);
    found.push({ provider, label, path: resolved, key: k, virtualDrive: false, ...extra });
  };

  // OneDrive names its own roots in the environment, which covers the
  // business variants whose folder name carries the tenant.
  await add(process.env.OneDrive, 'onedrive', 'OneDrive');
  await add(process.env.OneDriveConsumer, 'onedrive', 'OneDrive — Personal');
  await add(process.env.OneDriveCommercial, 'onedrive', 'OneDrive — Work or School');
  await add(path.join(home, 'OneDrive'), 'onedrive', 'OneDrive');

  // Anything of the shape "OneDrive - Contoso" beside the home folder.
  try {
    for (const e of await fsp.readdir(home, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (/^OneDrive\s*-\s*.+/i.test(e.name)) {
        await add(path.join(home, e.name), 'onedrive', e.name);
      }
    }
  } catch { /* home unreadable; nothing to add */ }

  // Google Drive for Desktop mounts a virtual drive by default and can also
  // mirror into a folder.
  await add(path.join(home, 'Google Drive'), 'googledrive', 'Google Drive');
  await add(path.join(home, 'GoogleDrive'), 'googledrive', 'Google Drive');
  if (process.platform === 'win32') {
    for (const letter of 'GHIJKLMNOPQRSTUVWXYZ') {
      const candidate = `${letter}:\\My Drive`;
      // A mounted Drive letter is a *virtual filesystem*, not a folder full of
      // NTFS placeholders, and the difference matters — see `virtualDrive`
      // below and the note on describeStorage().
      // eslint-disable-next-line no-await-in-loop
      await add(candidate, 'googledrive', `Google Drive (${letter}:)`, { virtualDrive: true });
    }
  }

  await add(path.join(home, 'Dropbox'), 'dropbox', 'Dropbox');
  await add(path.join(home, 'iCloudDrive'), 'icloud', 'iCloud Drive');
  await add(path.join(home, 'Box'), 'box', 'Box');

  return found;
}

/** An index for cheap containment tests during a scan. */
function makeMatcher(providers) {
  // The key is derived here rather than trusted from the caller. `detectProviders`
  // sets one, but any other caller — a test, a settings-supplied folder — would
  // otherwise have to know to, and forgetting produced a crash rather than a
  // miss, which is the worse of the two failures.
  const prefixes = (providers || [])
    .filter((p) => p && p.path)
    .map((p) => {
      const key = p.key || keyOf(p.path);
      return {
        ...p,
        key,
        prefix: key.endsWith(path.sep) ? key : key + path.sep,
      };
    });
  return {
    providers,
    /** The provider whose folder contains this path, or null. */
    match(filePath) {
      if (!prefixes.length) return null;
      const k = keyOf(filePath);
      for (const p of prefixes) {
        if (k === p.key || k.startsWith(p.prefix)) return p;
      }
      return null;
    },
    get empty() { return prefixes.length === 0; },
  };
}

/**
 * What a file's stats say about where its bytes are.
 *
 * @param {import('fs').Stats} st
 * @param {object|null} provider the sync folder containing it, if any
 * @returns {{physicalBytes: number|null, placeholder: boolean, provider: string|null,
 *            basis: string|null}}
 */
function describeStorage(st, provider = null) {
  // Node reports `blocks` on Windows as well as POSIX. Where it does not, the
  // honest answer is "not measured", not a guessed zero.
  const measured = typeof st.blocks === 'number' && st.blocks >= 0
    ? st.blocks * 512
    : null;

  if (!provider) {
    return {
      physicalBytes: measured, placeholder: false, streamed: false,
      storageKnown: measured !== null, provider: null, basis: null,
    };
  }

  // A MOUNTED VIRTUAL DRIVE IS A DIFFERENT ANIMAL, and getting this wrong was
  // a real bug rather than a subtlety.
  //
  // OneDrive's Files On-Demand leaves NTFS placeholders in a real folder: the
  // filesystem allocates no blocks, so "how much is here" is measurable and the
  // answer is zero. Google Drive's G: is not that. It is a virtual filesystem
  // served by a driver, and it reports FULL block allocation for every file
  // whether or not a byte of it is cached locally — a 28 MB video that has
  // never been downloaded still reports 54,649 allocated blocks.
  //
  // So on a virtual drive `blocks` says nothing at all about local storage, and
  // treating it as a measurement would have NexaFiles reporting a streamed
  // Google Drive as fully resident on the disk. That is the exact overstatement
  // this module exists to prevent, in the other direction. The honest answer is
  // that the figure is not knowable from here, and it is reported as unknown.
  if (provider.virtualDrive) {
    return {
      physicalBytes: null,
      placeholder: false,
      streamed: true,
      storageKnown: false,
      provider: provider.provider,
      basis:
        `${provider.label} is a virtual drive: its driver serves files on demand ` +
        'and reports every one as fully allocated whether or not it is cached ' +
        'here. How much of this file is actually on the disk is not visible to ' +
        'NexaFiles, and reading it may download it.',
    };
  }

  if (measured === null) {
    return {
      physicalBytes: null, placeholder: false, streamed: false,
      storageKnown: false, provider: provider.provider, basis: null,
    };
  }

  // The inference, with its own conditions spelled out so the interface can
  // repeat them rather than asserting a bare "not on disk".
  const placeholder = measured === 0 && st.size >= RESIDENT_CEILING;
  return {
    physicalBytes: measured,
    placeholder,
    streamed: false,
    storageKnown: true,
    provider: provider.provider,
    basis: placeholder
      ? `Inside ${provider.label} and the filesystem has allocated no blocks for it, ` +
        `though it reports ${st.size} bytes. Files this size are never stored inside ` +
        `the MFT record, so the bytes are in the cloud, not on this disk.`
      : null,
  };
}

/**
 * Sums what a set of scanned rows really occupies.
 *
 * Returns both figures because both are true and they answer different
 * questions: "how much is this folder" is the logical total, "how much of my
 * disk is it using" is the physical one.
 */
function summarise(rows) {
  let logical = 0;
  let physical = 0;
  let placeholders = 0;
  let placeholderLogical = 0;
  let streamed = 0;
  let streamedLogical = 0;
  let unknown = 0;

  for (const r of rows) {
    logical += r.size || 0;
    if (r.cloudStreamed) {
      // Counted into neither total. Adding its logical size to "on this disk"
      // would assert something nobody measured; adding zero would assert the
      // opposite. It is reported on its own line instead.
      streamed++;
      streamedLogical += r.size || 0;
      unknown++;
      continue;
    }
    physical += r.physicalSize ?? r.size ?? 0;
    if (r.cloudPlaceholder) {
      placeholders++;
      placeholderLogical += r.size || 0;
    }
  }

  return {
    logicalBytes: logical,
    physicalBytes: physical,
    placeholders,
    placeholderLogicalBytes: placeholderLogical,
    // Files on a virtual drive, whose local footprint is not knowable from here.
    streamed,
    streamedLogicalBytes: streamedLogical,
    unknownFootprint: unknown,
    // What a user would actually free by deleting everything whose footprint is
    // known. Deliberately excludes the streamed ones rather than guessing.
    onDiskBytes: physical,
  };
}

/**
 * Whether reading this file's contents would pull it down from the cloud.
 *
 * The question every content scanner has to ask before it opens a file:
 * hashing, fingerprinting and describing all read bytes, and reading a
 * placeholder is a download.
 */
function wouldDownload(row) {
  // Both cases: a dehydrated placeholder definitely has to be fetched, and a
  // file on a virtual drive may have to be. Neither is safe to hash or describe
  // without the user having asked for the transfer.
  return !!row && (row.cloudPlaceholder === true || row.cloudStreamed === true);
}

module.exports = {
  detectProviders,
  makeMatcher,
  describeStorage,
  summarise,
  wouldDownload,
  keyOf,
  RESIDENT_CEILING,
};
