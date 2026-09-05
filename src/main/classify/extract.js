'use strict';
// Text extraction from document formats.
//
// This exists because the text-similarity scanner was reading .docx and .pdf as
// raw UTF-8, which produces compressed binary noise, so documents were never
// actually compared. The feature appeared to exist and did not.
//
// No model is trained here, and none is needed. These are documented container
// formats, not gibberish:
//
//   .docx .xlsx .pptx  ZIP archives of XML. The text sits in <w:t>, <t> and
//                      <a:t> elements. Node's zlib inflates them; no dependency.
//   .pdf               A object graph whose content streams are usually
//                      Flate-compressed. Inflate them and read the text-showing
//                      operators (Tj, TJ, ', ").
//
// Parsing gives the exact text the file contains. A classifier trained to guess
// at compressed bytes would be less accurate, unexplainable, and would need
// training data that does not exist — the same mistake as the synthetic-data
// model this project already removed.
//
// Where extraction genuinely cannot work — a scanned PDF holding only page
// images, an encrypted file — that is reported. An empty result and "this file
// has no extractable text" must not look the same to the caller.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const ZIP_XML_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
const PLAIN_FORMATS = new Set(['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'log', 'tsv', 'yml', 'yaml']);

// ── minimal ZIP reader ──────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/**
 * Lists the entries of a ZIP archive by walking its central directory.
 * Returns [{ name, method, compressedSize, size, localOffset }].
 */
function readZipDirectory(buf) {
  // The end-of-central-directory record sits at the tail, after a comment of
  // up to 64 KB, so scan backwards for its signature.
  let eocd = -1;
  const from = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a ZIP archive (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length) break;
    if (buf.readUInt32LE(offset) !== CEN_SIG) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compressedSize, size, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflates one entry's bytes. */
function readZipEntry(buf, entry) {
  const o = entry.localOffset;
  if (buf.readUInt32LE(o) !== LOC_SIG) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(o + 26);
  const extraLen = buf.readUInt16LE(o + 28);
  const start = o + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;                 // stored
  if (entry.method === 8) return zlib.inflateRawSync(raw);  // deflate
  throw new Error(`unsupported ZIP compression method ${entry.method}`);
}

// ── XML text ────────────────────────────────────────────────────────────────

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Pulls the contents of the named elements out of an XML document. */
function textFromXml(xml, tagNames) {
  const out = [];
  for (const tag of tagNames) {
    // Matches <w:t>, <w:t xml:space="preserve">, and the self-closing form.
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
    let m;
    while ((m = re.exec(xml)) !== null) {
      const inner = m[1].replace(/<[^>]*>/g, '');
      if (inner) out.push(decodeEntities(inner));
    }
  }
  return out;
}

// ── Office Open XML ─────────────────────────────────────────────────────────

const OOXML_PARTS = {
  docx: { match: (n) => n === 'word/document.xml' || /^word\/(header|footer)\d*\.xml$/.test(n), tags: ['w:t'] },
  pptx: { match: (n) => /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(n), tags: ['a:t'] },
  xlsx: { match: (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(n), tags: ['t', 'v'] },
  odt: { match: (n) => n === 'content.xml', tags: ['text:p', 'text:span'] },
  odp: { match: (n) => n === 'content.xml', tags: ['text:p', 'text:span'] },
  ods: { match: (n) => n === 'content.xml', tags: ['text:p', 'text:span'] },
};

function extractOoxml(buf, ext) {
  const spec = OOXML_PARTS[ext];
  if (!spec) throw new Error(`no extraction rule for .${ext}`);

  const entries = readZipDirectory(buf);
  const parts = entries.filter((e) => spec.match(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  if (parts.length === 0) {
    return { text: '', partsRead: 0, note: `no ${ext} text parts found inside the archive` };
  }

  const chunks = [];
  let read = 0;
  for (const p of parts) {
    try {
      const xml = readZipEntry(buf, p).toString('utf8');
      chunks.push(...textFromXml(xml, spec.tags));
      read++;
    } catch { /* one damaged part should not lose the rest */ }
  }
  return {
    text: chunks.join(' ').replace(/\s+/g, ' ').trim(),
    partsRead: read,
    note: `read ${read} of ${parts.length} XML part(s)`,
  };
}

// ── PDF ─────────────────────────────────────────────────────────────────────

/** Decodes a PDF literal string, honouring escapes and nested parentheses. */
function decodePdfLiteral(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b' || n === 'f') out += ' ';
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += n;   // \( \) \\ and anything else is literal
  }
  return out;
}

function decodePdfHex(s) {
  const hex = s.replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.substr(i, 2), 16);
    if (code >= 32 || code === 10 || code === 9) out += String.fromCharCode(code);
  }
  return out;
}

/**
 * Reads the text-showing operators out of a decoded content stream.
 * Tj and ' show one string; TJ shows an array of strings interleaved with
 * kerning numbers, which are discarded.
 */
function textFromContentStream(s) {
  const out = [];

  // Literal and hex strings that are arguments to a text operator.
  const re = /(\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)|<[0-9A-Fa-f\s]*>)\s*(Tj|TJ|'|")?|\[([\s\S]*?)\]\s*TJ/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[3] !== undefined) {
      // A TJ array: pull every string inside it.
      const inner = m[3];
      const sub = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>/g;
      let k;
      let piece = '';
      while ((k = sub.exec(inner)) !== null) {
        const tok = k[0];
        piece += tok[0] === '(' ? decodePdfLiteral(tok.slice(1, -1)) : decodePdfHex(tok.slice(1, -1));
      }
      if (piece) out.push(piece);
    } else if (m[2]) {
      const tok = m[1];
      const piece = tok[0] === '(' ? decodePdfLiteral(tok.slice(1, -1)) : decodePdfHex(tok.slice(1, -1));
      if (piece) out.push(piece);
    }
  }
  return out.join(' ');
}

/**
 * Extracts text from a PDF by inflating its Flate-compressed content streams.
 *
 * A PDF whose pages are scanned images contains no text operators at all. That
 * is reported as such rather than as an empty document, because the two mean
 * very different things when deciding whether two files are duplicates.
 */
function extractPdf(buf, { maxStreams = 400, maxChars = 400_000 } = {}) {
  const latin = buf.toString('latin1');
  let streams = 0, inflated = 0, failed = 0, skipped = 0, rejected = 0;
  const chunks = [];
  let chars = 0;

  // `endstream` also contains the word "stream". Matching it yielded offsets
  // pointing into the middle of stream data, so every inflate failed and the
  // bytes that survived were parsed as convincing-looking noise. Exclude it.
  const re = /(?<!end)stream\r?\n/g;
  let m;
  while ((m = re.exec(latin)) !== null && streams < maxStreams && chars < maxChars) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    streams++;

    // The stream's dictionary sits immediately before it.
    const dictStart = Math.max(0, latin.lastIndexOf('<<', m.index));
    const dict = latin.slice(dictStart, m.index);

    // Advance past this stream before anything below can skip it. Leaving the
    // cursor where it was meant the scan resumed *inside* binary image data,
    // desynchronising every offset that followed and losing real content
    // streams that came after the first image.
    re.lastIndex = end;

    let data = buf.subarray(start, end);
    if (/\/Subtype\s*\/Image/.test(dict) ||
        /\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict)) {
      skipped++;
      continue;   // pixels, not prose
    }
    if (/\/FlateDecode/.test(dict)) {
      try {
        data = zlib.inflateSync(data);
        inflated++;
      } catch {
        try { data = zlib.inflateRawSync(data); inflated++; }
        catch { failed++; continue; }
      }
    }

    const decoded = data.toString('latin1');

    // A page's content stream marks its text with BT ... ET. Font programs,
    // colour profiles and image data contain none, and an earlier version that
    // skipped this check happily "extracted" JPEG bytes as text — producing the
    // sort of confident nonsense that would then match other files at random.
    if (!/\bBT\b/.test(decoded)) { skipped++; re.lastIndex = end; continue; }

    let text = '';
    const blocks = decoded.match(/\bBT\b[\s\S]*?\bET\b/g);
    if (blocks) {
      for (const b of blocks) text += textFromContentStream(b) + ' ';
    }
    text = text.trim();

    if (text && isMostlyPrintable(text)) { chunks.push(text); chars += text.length; }
    else if (text) rejected++;
    re.lastIndex = end;
  }

  let text = chunks.join(' ').replace(/\s+/g, ' ').trim();

  // Final guard: if what came out is not predominantly readable, report none.
  if (text && !isMostlyPrintable(text)) { rejected++; text = ''; }

  let note = `${streams} stream(s) examined, ${inflated} inflated, ${skipped} non-text`;
  if (failed) note += `, ${failed} unreadable`;
  if (rejected) note += `, ${rejected} rejected as non-text`;
  if (!text && streams > 0) {
    note += '. No readable text found — this PDF most likely holds scanned page ' +
            'images rather than text, so its words cannot be compared.';
  }
  return { text, streams, inflated, note };
}

/**
 * True when a string is predominantly ordinary readable characters.
 *
 * Binary misread as text fails this decisively, which is the point: it is far
 * better to report that a PDF has no extractable text than to feed noise into a
 * similarity comparison and have it match something.
 */
function isMostlyPrintable(s, threshold = 0.85) {
  if (!s) return false;
  const sample = s.length > 4000 ? s.slice(0, 4000) : s;
  let good = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13 ||
        (c >= 0xC0 && c <= 0x24F)) good++;
  }
  const ratio = good / sample.length;
  if (ratio < threshold) return false;
  // Real prose contains spaces; a run of symbols with none is not text.
  const letters = (sample.match(/[A-Za-z]/g) || []).length;
  return letters / sample.length > 0.35;
}

// ── RTF ─────────────────────────────────────────────────────────────────────

function extractRtf(buf) {
  const s = buf.toString('latin1');
  const text = s
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\par[d]?/g, ' ')
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, note: 'RTF control words stripped' };
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Returns the readable text of a document.
 *
 * @returns {{ok, text, chars, method, note, extension}}
 *   `ok` is false when the format is unsupported or the file could not be read.
 *   `ok` true with empty text is a real answer: the file contains no text.
 */
async function extractText(filePath, { maxBytes = 64 << 20 } = {}) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const base = { extension: ext, text: '', chars: 0 };

  let buf;
  try {
    const st = await fsp.stat(filePath);
    if (st.size === 0) return { ...base, ok: true, method: 'empty', note: 'file is empty' };
    const fh = await fsp.open(filePath, 'r');
    try {
      const len = Math.min(st.size, maxBytes);
      buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
    } finally { await fh.close(); }
  } catch (err) {
    return { ...base, ok: false, method: 'unreadable', note: err.message };
  }

  try {
    if (PLAIN_FORMATS.has(ext)) {
      // Reject binary masquerading as text rather than hashing noise.
      if (buf.subarray(0, Math.min(1024, buf.length)).includes(0)) {
        return { ...base, ok: false, method: 'plain', note: 'contains NUL bytes; not text' };
      }
      let text = buf.toString('utf8');
      if (ext === 'html' || ext === 'htm' || ext === 'xml') {
        text = decodeEntities(text.replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' '));
      }
      text = text.replace(/\s+/g, ' ').trim();
      return { ...base, ok: true, text, chars: text.length, method: 'plain text', note: 'read directly' };
    }

    if (ZIP_XML_FORMATS.has(ext)) {
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        return { ...base, ok: false, method: 'ooxml', note: 'not a ZIP archive despite its extension' };
      }
      const r = extractOoxml(buf, ext);
      return { ...base, ok: true, text: r.text, chars: r.text.length,
               method: `${ext.toUpperCase()} (ZIP + XML)`, note: r.note };
    }

    if (ext === 'pdf') {
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return { ...base, ok: false, method: 'pdf', note: 'missing %PDF- signature' };
      }
      const r = extractPdf(buf);
      return { ...base, ok: true, text: r.text, chars: r.text.length,
               method: 'PDF content streams', note: r.note };
    }

    if (ext === 'rtf') {
      const r = extractRtf(buf);
      return { ...base, ok: true, text: r.text, chars: r.text.length,
               method: 'RTF', note: r.note };
    }

    // Legacy .doc is a compound binary format; it is not supported, and saying
    // so is better than extracting noise from it.
    if (ext === 'doc') {
      return { ...base, ok: false, method: 'doc',
               note: 'legacy Word .doc is a compound binary format and is not supported. ' +
                     'Files saved as .docx are read fully.' };
    }

    return { ...base, ok: false, method: 'unsupported', note: `no extractor for .${ext}` };
  } catch (err) {
    return { ...base, ok: false, method: 'failed', note: err.message };
  }
}

/** Extensions this module can genuinely read. */
const EXTRACTABLE = [
  ...PLAIN_FORMATS, ...ZIP_XML_FORMATS, 'pdf', 'rtf',
];

module.exports = {
  extractText,
  EXTRACTABLE,
  PLAIN_FORMATS,
  ZIP_XML_FORMATS,
  // exported for tests
  readZipDirectory,
  readZipEntry,
  textFromXml,
  textFromContentStream,
  isMostlyPrintable,
  decodePdfLiteral,
  decodePdfHex,
};
