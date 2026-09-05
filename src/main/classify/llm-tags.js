'use strict';
// Describing a file in words, so it can be found by describing it.
//
// Every other classifier in this directory is deterministic: `rules.js` reads
// magic bytes and extensions, `extract.js` reads text out of a container. They
// answer "what kind of file is this". None of them can answer "which photo has
// the brown dog in it", because that is not written down anywhere on the disk.
//
// This one asks a model. That makes it the only classifier here whose output is
// not a measurement, and three rules follow from that:
//
//   1. It is off until switched on. Describing a file means sending that file
//      to Google, which is a thing a user must choose, not discover afterwards.
//      The switch lives in Settings beside the wake word, which is the other
//      feature that had to be opted into for the same kind of reason.
//   2. Nothing it produces is presented as measured. Each row records which
//      model wrote it and when, and the interface says "described by <model>"
//      rather than letting tags sit next to byte counts as though they had the
//      same standing.
//   3. What comes back is parsed, never executed. The source technique this is
//      modelled on used `eval()` on the model's reply; a reply is untrusted
//      text, and it is JSON-parsed here and then checked field by field.
//
// The reading is done by ../llm/attachments.js, which already knows how to put
// an image inline (resizing one that is too large) and how to pull text out of
// a PDF or a Word file. Reusing it means a file is read exactly one way in this
// application, and that way already carries the prompt-injection guard.

const path = require('path');
const fsp = require('fs').promises;

const attachments = require('../llm/attachments');

// What is worth describing. Everything else is skipped rather than sent: a DLL
// has nothing to say about itself, and paying an API call to be told so is
// waste the user did not agree to.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const DOC_EXTS = new Set([
  'pdf', 'doc', 'docx', 'txt', 'md', 'markdown', 'rtf', 'odt',
  'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'json', 'xml', 'html', 'htm', 'log',
]);
const CODE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp',
  'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sh', 'ps1', 'sql', 'css', 'scss',
]);

// A single file should never be able to bloat the index or the prompt.
const MAX_TAGS = 40;
const MAX_TAG_CHARS = 48;
// Images above this are still described — attachments.js resizes them — but a
// file this large is usually a video or an archive, which is not sent at all.
const MAX_SOURCE_BYTES = 32 << 20;

const SYSTEM_INSTRUCTION = [
  'You describe a single file so that a person can find it later by describing',
  'it from memory. You reply with JSON only.',
  '',
  'Reply exactly: {"tags": ["...", "..."], "summary": "one short sentence"}',
  '',
  'Rules for tags:',
  '- Lower case. No punctuation except internal hyphens.',
  '- Describe what is actually visible or written, not what might be there.',
  '- For a photo or image: the subjects, how many, what they are doing, the',
  '  setting, the dominant colours, indoor or outdoor, day or night, and the',
  '  kind of shot (screenshot, selfie, diagram, scan, receipt, chart).',
  '- Include proper nouns you can actually read: names, places, dates, brands,',
  '  and text visible in the image.',
  '- For a document: what it is about, its key topics, its type (invoice,',
  '  resume, report, contract, notes, slides), and any names or dates in it.',
  '- For a spreadsheet or data file: the column names.',
  '- For source code: what it does, the language, the libraries it imports.',
  '- Add the obvious near-synonyms a person might search with instead. If a tag',
  '  is more than one word, also add each meaningful word on its own.',
  '- 10 to 30 tags. Never invent a name, date or place you cannot see.',
  '',
  'If you cannot tell what the file contains, reply {"tags": [], "summary": ""}',
  'rather than guessing.',
].join('\n');

/** Which of the three descriptions this file gets, or null to skip it. */
function kindOf(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (DOC_EXTS.has(ext)) return 'document';
  if (CODE_EXTS.has(ext)) return 'code';
  return null;
}

/** Whether this file is one this feature will spend an API call on. */
function isDescribable(filePath) {
  return kindOf(filePath) !== null;
}

/**
 * The JSON out of a model reply.
 *
 * The reply is untrusted text. It is JSON-parsed — never evaluated — and a
 * reply that is not the expected shape is a failure to record, not something
 * to coerce into looking like success.
 */
function parseReply(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, note: 'The model replied with nothing.' };

  // JSON mode returns bare JSON, but a model asked for JSON in prose sometimes
  // still fences it. Both are accepted; nothing else is.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, note: 'The model did not reply with valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, note: 'The model replied with JSON of the wrong shape.' };
  }
  if (!Array.isArray(parsed.tags)) {
    return { ok: false, note: 'The reply carried no tag list.' };
  }

  const seen = new Set();
  const tags = [];
  for (const entry of parsed.tags) {
    if (typeof entry !== 'string') continue;
    const tag = entry.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_CHARS);
    if (tag.length < 2 || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }

  const summary = typeof parsed.summary === 'string'
    ? parsed.summary.replace(/\s+/g, ' ').trim().slice(0, 300)
    : '';

  return { ok: true, tags, summary };
}

/**
 * Describes one file.
 *
 * Returns a record whether or not it worked. A file that was looked at and
 * could not be described is stored with `ok: false` and the reason, because the
 * alternative — leaving it absent — makes it indistinguishable from a file that
 * was never examined, and would have the indexer paying to fail on the same
 * unreadable PDF on every run.
 *
 * @param {string} filePath
 * @param {object} deps
 * @param {import('../llm/gemini').GeminiClient} deps.gemini
 * @param {object} [deps.nativeImage] Electron's nativeImage, for resizing
 * @param {AbortSignal} [deps.signal]
 */
async function describeFile(filePath, { gemini, nativeImage = null, signal = null } = {}) {
  const kind = kindOf(filePath);
  const base = {
    path: filePath,
    name: path.basename(filePath),
    extension: path.extname(filePath).slice(1).toLowerCase() || null,
    kind,
  };

  if (!kind) {
    return { ...base, ok: false, tags: [], note: 'Not a kind of file NexaFiles describes.' };
  }

  let st;
  try {
    st = await fsp.stat(filePath);
  } catch (err) {
    return { ...base, ok: false, tags: [], note: `Could not be read: ${err.message}` };
  }
  base.size = st.size;
  base.mtimeMs = st.mtimeMs;

  if (st.size === 0) {
    return { ...base, ok: false, tags: [], note: 'The file is empty.' };
  }
  if (st.size > MAX_SOURCE_BYTES) {
    return {
      ...base, ok: false, tags: [],
      note: `The file is ${st.size} bytes, which is larger than NexaFiles will send.`,
    };
  }

  // Reading is delegated, so an image is inlined and resized and a document is
  // text-extracted by the same code the assistant's attachments already use.
  let read;
  try {
    read = await attachments.toParts(filePath, { nativeImage });
  } catch (err) {
    return { ...base, ok: false, tags: [], note: `Could not be read: ${err.message}` };
  }
  if (!read.ok || !read.parts.length) {
    return { ...base, ok: false, tags: [], note: read.note || 'The file could not be read.' };
  }

  const ask = {
    role: 'user',
    parts: [
      ...read.parts,
      { text: 'Describe the file above as JSON, following your instructions exactly.' },
    ],
  };

  let reply;
  try {
    reply = await gemini.generate([ask], {
      systemInstruction: SYSTEM_INSTRUCTION,
      signal,
      // Asking the API for JSON is more reliable than asking the prose for it,
      // and it is why the client learned to carry a generation config.
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    });
  } catch (err) {
    // A cancellation is the user's decision and must travel, not be recorded
    // against the file as though the file were the problem.
    if (err.code === 'CANCELLED') throw err;
    return { ...base, ok: false, tags: [], note: err.message, transient: true };
  }

  const parts = reply?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
  const out = parseReply(text);
  if (!out.ok) {
    return { ...base, ok: false, tags: [], note: out.note };
  }
  if (!out.tags.length) {
    return {
      ...base, ok: false, tags: [],
      note: 'The model was shown the file and could not describe it.',
    };
  }

  return {
    ...base,
    ok: true,
    tags: out.tags,
    summary: out.summary,
    model: gemini.model,
    note: null,
  };
}

module.exports = {
  describeFile,
  isDescribable,
  kindOf,
  parseReply,
  SYSTEM_INSTRUCTION,
  IMAGE_EXTS,
  DOC_EXTS,
  CODE_EXTS,
  MAX_TAGS,
};
