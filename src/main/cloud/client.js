'use strict';
// Reading a cloud account: who it belongs to, how full it is, and what is in it.
//
// The one thing this does that a sync folder cannot, and the reason the whole
// OAuth path is worth its complexity: BOTH PROVIDERS COMPUTE A CONTENT HASH
// SERVER-SIDE AND HAND IT OVER IN THE FILE LISTING.
//
//   Google Drive  `md5Checksum`  on every binary file
//   OneDrive      `file.hashes`  — quickXorHash always, sha1/sha256 often
//
// That means exact-duplicate detection across an entire cloud account without
// downloading a single byte. Locally, hashing requires the bytes, which is why
// the placeholder guard in src/main/fs/cloud.js has to skip online-only files
// entirely. Here the provider has already done the hashing.
//
// The caveat, stated because it changes what the results mean: a hash from
// Google is comparable with another hash from Google, and NexaFiles' local
// hashes are SHA-256. So cloud-to-cloud matching within one provider is exact,
// and cloud-to-local matching works only where the algorithms line up —
// OneDrive's sha256Hash lines up with the local one, Google's MD5 does not.
// Where they do not, size is a candidate filter and nothing is claimed as a
// match. See dedupe.js.
//
// Everything below is a read. The tokens carry no write scope, so there is no
// call here that could modify anybody's cloud even if it were asked to.

const providers = require('./providers');

const PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 30_000;

/** One authorised GET. Retries a rate limit once, honouring Retry-After. */
async function apiGet(url, accessToken, { attempt = 0 } = {}) {
  let resp;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`The request could not be completed: ${e.message}`);
  }

  if (resp.status === 401) {
    const err = new Error('The access token was refused. Sign in again.');
    err.code = 'UNAUTHORISED';
    throw err;
  }
  if ((resp.status === 429 || resp.status >= 500) && attempt < 2) {
    const after = Number(resp.headers.get('retry-after'));
    const waitMs = Number.isFinite(after) && after > 0
      ? Math.min(after * 1000, 30_000)
      : 1000 * (attempt + 1);
    await new Promise((r) => setTimeout(r, waitMs));
    return apiGet(url, accessToken, { attempt: attempt + 1 });
  }

  const text = await resp.text();
  if (!resp.ok) {
    let detail = '';
    try { detail = JSON.parse(text)?.error?.message || ''; } catch { /* not JSON */ }
    const err = new Error(detail || `The provider returned HTTP ${resp.status}.`);
    err.status = resp.status;
    throw err;
  }
  try { return JSON.parse(text); }
  catch { throw new Error('The provider returned a response that was not JSON.'); }
}

// ── who the account belongs to ─────────────────────────────────────────────

async function identity(providerId, accessToken) {
  const p = providers.get(providerId);
  if (providerId === 'google') {
    const j = await apiGet(`${p.api}/about?fields=user(displayName,emailAddress)`, accessToken);
    return {
      email: j?.user?.emailAddress || null,
      displayName: j?.user?.displayName || null,
    };
  }
  const j = await apiGet(`${p.api}/me`, accessToken);
  return {
    email: j.userPrincipalName || j.mail || null,
    displayName: j.displayName || null,
  };
}

/**
 * How full the account is.
 *
 * The one figure the local sync folder genuinely cannot answer, because the
 * quota lives on the provider's side and nothing on disk records it.
 */
async function quota(providerId, accessToken) {
  const p = providers.get(providerId);
  if (providerId === 'google') {
    const j = await apiGet(`${p.api}/about?fields=storageQuota`, accessToken);
    const q = j?.storageQuota || {};
    const limit = q.limit ? Number(q.limit) : null;
    const used = q.usage ? Number(q.usage) : null;
    return {
      usedBytes: used,
      totalBytes: limit,                       // null means an unlimited plan
      freeBytes: limit !== null && used !== null ? Math.max(0, limit - used) : null,
      inDriveBytes: q.usageInDrive ? Number(q.usageInDrive) : null,
      measuredAt: new Date().toISOString(),
    };
  }
  const j = await apiGet(`${p.api}/me/drive?$select=quota`, accessToken);
  const q = j?.quota || {};
  return {
    usedBytes: typeof q.used === 'number' ? q.used : null,
    totalBytes: typeof q.total === 'number' ? q.total : null,
    freeBytes: typeof q.remaining === 'number' ? q.remaining : null,
    inDriveBytes: typeof q.used === 'number' ? q.used : null,
    measuredAt: new Date().toISOString(),
  };
}

// ── the file listing ───────────────────────────────────────────────────────

/** A Google Drive file, in NexaFiles' own shape. */
function fromGoogle(f) {
  // A Google Docs/Sheets/Slides file is not a stored blob: it has no size and
  // no checksum, because there is no file to hash. Recording it with a zero
  // size would put a fake number in a total, so both stay null.
  const isNative = String(f.mimeType || '').startsWith('application/vnd.google-apps');
  return {
    remoteId: f.id,
    name: f.name,
    mimeType: f.mimeType || null,
    size: isNative ? null : (f.size !== undefined ? Number(f.size) : null),
    modifiedAt: f.modifiedTime || null,
    createdAt: f.createdTime || null,
    parents: Array.isArray(f.parents) ? f.parents : [],
    trashed: !!f.trashed,
    webUrl: f.webViewLink || null,
    hashAlgorithm: f.md5Checksum ? 'md5' : null,
    hash: f.md5Checksum || null,
    isFolder: f.mimeType === 'application/vnd.google-apps.folder',
    isNativeDoc: isNative,
  };
}

/** A OneDrive item, in the same shape. */
function fromMicrosoft(f) {
  const hashes = f.file?.hashes || {};
  // sha256 first: it is the one that is directly comparable with the hashes
  // NexaFiles computes locally. quickXorHash is Microsoft's own and is only
  // comparable with another OneDrive file.
  const [algorithm, value] = hashes.sha256Hash ? ['sha256', hashes.sha256Hash]
    : hashes.sha1Hash ? ['sha1', hashes.sha1Hash]
    : hashes.quickXorHash ? ['quickxor', hashes.quickXorHash]
    : [null, null];

  return {
    remoteId: f.id,
    name: f.name,
    mimeType: f.file?.mimeType || null,
    size: typeof f.size === 'number' ? f.size : null,
    modifiedAt: f.lastModifiedDateTime || null,
    createdAt: f.createdDateTime || null,
    parents: f.parentReference?.id ? [f.parentReference.id] : [],
    parentPath: f.parentReference?.path || null,
    trashed: !!f.deleted,
    webUrl: f.webUrl || null,
    hashAlgorithm: algorithm,
    hash: value ? String(value).toLowerCase() : null,
    isFolder: !!f.folder,
    isNativeDoc: false,
  };
}

/**
 * Every file in the account, a page at a time.
 *
 * Metadata only: names, sizes, dates, hashes. No file content is requested and
 * none is transferred, so importing a terabyte account costs a few hundred
 * kilobytes of JSON and downloads nothing.
 *
 * @param {Function} opts.onPage called with each page, so a long import can
 *   report progress and be stopped between pages rather than at the end.
 */
async function listFiles(providerId, accessToken, {
  onPage = null, shouldCancel = () => false, maxFiles = 100_000,
} = {}) {
  const p = providers.get(providerId);
  const out = [];
  let pages = 0;
  let next = null;
  let complete = true;

  const first = providerId === 'google'
    ? `${p.api}/files?pageSize=${PAGE_SIZE}&fields=nextPageToken,files(` +
      'id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,parents,trashed,webViewLink)' +
      '&q=trashed%3Dfalse&supportsAllDrives=true&includeItemsFromAllDrives=true'
    : `${p.api}/me/drive/root/delta?$top=${PAGE_SIZE}`;

  next = first;
  while (next) {
    if (shouldCancel()) { complete = false; break; }
    if (out.length >= maxFiles) { complete = false; break; }

    // eslint-disable-next-line no-await-in-loop
    const page = await apiGet(next, accessToken);
    pages++;

    const items = providerId === 'google' ? (page.files || []) : (page.value || []);
    for (const raw of items) {
      const row = providerId === 'google' ? fromGoogle(raw) : fromMicrosoft(raw);
      if (row.trashed || row.isFolder) continue;
      out.push(row);
    }

    if (onPage) {
      onPage({ pages, files: out.length, provider: providerId });
    }

    const token = providerId === 'google' ? page.nextPageToken : null;
    next = providerId === 'google'
      ? (token ? `${first}&pageToken=${encodeURIComponent(token)}` : null)
      : (page['@odata.nextLink'] || null);
  }

  return {
    files: out,
    pages,
    complete,
    // What proportion carry a hash, because that decides how much of the
    // duplicate search can actually work.
    hashed: out.filter((f) => f.hash).length,
    note: complete
      ? null
      : `Listing stopped after ${out.length} file(s); the account holds more.`,
  };
}

module.exports = { identity, quota, listFiles, apiGet, fromGoogle, fromMicrosoft };
