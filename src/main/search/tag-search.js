'use strict';
// Finding a file by describing it.
//
// "the photo of the brown dog on grass" has to reach a file called IMG_4821.JPG.
// Nothing measurable about that file connects the two, so the connection is made
// through ../classify/llm-tags.js, which wrote down what the picture shows. This
// module is the other half: it turns the sentence a person typed into terms that
// can be matched against those descriptions.
//
// The technique is borrowed from a prior project that did the same job by asking
// a model to emit a SQL query and then executing whatever came back. That is the
// one part deliberately not carried over. A model here emits **only a list of
// words**; the query is built in this file, from those words, by code that can
// be read. The model cannot reach the database, cannot choose a table, and
// cannot express anything the grammar below does not allow.
//
// It degrades rather than fails. With no API key, or when the expansion call
// errors, the user's own words are used directly — a plain keyword search over
// the descriptions, which is worse at synonyms and perfectly functional.

const path = require('path');

// Words that carry no search signal. The expansion model is told to drop them
// too, but the fallback path has no model, so the list lives here.
const STOP = new Set([
  'a', 'an', 'the', 'my', 'me', 'i', 'is', 'are', 'was', 'were', 'be', 'been',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'about', 'into',
  'and', 'or', 'but', 'that', 'this', 'these', 'those', 'it', 'its',
  'find', 'show', 'get', 'give', 'search', 'look', 'want', 'need', 'please',
  'file', 'files', 'where', 'which', 'what', 'who', 'when', 'have', 'has',
  'some', 'any', 'all', 'there', 'here', 'do', 'does', 'did', 'can', 'you',
]);

// What the user can mean by "picture", "document", "code". Kept here rather
// than asked of the model because it is a fact about this application's own
// index — `kind` is a column llm-tags.js writes — not a matter of judgement.
const KIND_WORDS = {
  image: ['image', 'images', 'photo', 'photos', 'photograph', 'photographs',
    'picture', 'pictures', 'pic', 'pics', 'screenshot', 'screenshots',
    'selfie', 'wallpaper', 'png', 'jpg', 'jpeg'],
  document: ['document', 'documents', 'doc', 'docs', 'pdf', 'pdfs', 'report',
    'reports', 'invoice', 'invoices', 'resume', 'cv', 'slide', 'slides',
    'spreadsheet', 'sheet', 'note', 'notes', 'paper', 'papers'],
  code: ['code', 'script', 'scripts', 'source', 'program', 'function', 'class'],
};

const EXPANSION_INSTRUCTION = [
  'You turn a description of a file into search terms. You reply with JSON only.',
  '',
  'Reply exactly:',
  '{"terms": ["...", "..."], "kind": "image"|"document"|"code"|null,',
  ' "extensions": ["jpg", "png"]}',
  '',
  'Rules:',
  '- "terms" are lower-case words someone might have used to describe the file:',
  '  the things named in the query, plus their obvious synonyms, plurals and',
  '  singulars, and the words a photo of that thing would be tagged with.',
  '- Split multi-word ideas into their parts as well as keeping the whole.',
  '  "red sports car" gives "red sports car", "sports car", "car", "red", "sports".',
  '- Do not invent specifics the query does not contain. "a dog" must not become',
  '  "labrador". Broadening to "pet" and "animal" is correct; narrowing is not.',
  '- 5 to 25 terms. Drop filler words like "find me the".',
  '- "kind" is the sort of file being asked for, or null if the query does not say.',
  '- "extensions" are file extensions the answer is likely to have, without dots.',
  '  Leave it empty unless the query implies a format.',
].join('\n');

/** The user's own words, when there is no model to expand them. */
function plainTerms(query) {
  const words = String(query || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(words)];
}

/** The kind of file the query itself names, if it names one. */
function kindFromQuery(query) {
  const words = new Set(plainTerms(query));
  for (const [kind, markers] of Object.entries(KIND_WORDS)) {
    if (markers.some((m) => words.has(m))) return kind;
  }
  return null;
}

/**
 * Turns a description into search terms.
 *
 * @returns {{terms: string[], kind: string|null, extensions: string[], expandedBy: string, note: string|null}}
 */
async function expandQuery(query, { gemini = null, signal = null } = {}) {
  const own = plainTerms(query);
  const fallback = {
    terms: own,
    kind: kindFromQuery(query),
    extensions: [],
    expandedBy: 'your words, unexpanded',
    note: null,
  };

  if (!gemini || !gemini.available) {
    fallback.note = 'No API key is configured, so the words you typed were ' +
      'matched as they are. Synonyms were not added.';
    return fallback;
  }

  let reply;
  try {
    reply = await gemini.generate(
      [{ role: 'user', parts: [{ text: String(query || '').slice(0, 600) }] }],
      {
        systemInstruction: EXPANSION_INSTRUCTION,
        signal,
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
      }
    );
  } catch (err) {
    if (err.code === 'CANCELLED') throw err;
    fallback.note = `Synonyms could not be added (${err.message}), so the words ` +
      'you typed were matched as they are.';
    return fallback;
  }

  const parts = reply?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();

  let parsed;
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    parsed = JSON.parse((fenced ? fenced[1] : text).trim());
  } catch {
    fallback.note = 'The expansion did not come back as JSON, so the words you ' +
      'typed were matched as they are.';
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.terms)) {
    fallback.note = 'The expansion came back in the wrong shape, so the words ' +
      'you typed were matched as they are.';
    return fallback;
  }

  // Everything below is a whitelist, not a sanitisation: a value that is not
  // exactly what was asked for is dropped, never repaired into something that
  // happens to parse.
  const seen = new Set();
  const terms = [];
  for (const raw of [...own, ...parsed.terms]) {
    if (typeof raw !== 'string') continue;
    const t = raw.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 48);
    if (t.length < 2 || STOP.has(t) || seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
    if (terms.length >= 40) break;
  }

  const kind = ['image', 'document', 'code'].includes(parsed.kind)
    ? parsed.kind
    : kindFromQuery(query);

  const extensions = Array.isArray(parsed.extensions)
    ? [...new Set(parsed.extensions
        .filter((e) => typeof e === 'string')
        .map((e) => e.toLowerCase().replace(/^\./, '').trim())
        .filter((e) => /^[a-z0-9]{1,8}$/.test(e)))].slice(0, 12)
    : [];

  return {
    terms: terms.length ? terms : own,
    kind,
    extensions,
    expandedBy: gemini.model,
    note: null,
  };
}

/**
 * An FTS5 MATCH expression, built here rather than anywhere near the model.
 *
 * Every term becomes a quoted phrase, which makes it a literal in FTS5's
 * grammar — a term containing `OR`, `NEAR` or a bare `"` cannot change the
 * shape of the query, because a doubled quote inside a quoted string is just a
 * quote. This is the whole reason the model is asked for words and not for a
 * query.
 */
function matchExpression(terms) {
  const quoted = terms
    .map((t) => String(t).replace(/"/g, '""').trim())
    .filter(Boolean)
    .map((t) => `"${t}"`);
  return quoted.join(' OR ');
}

/**
 * How well one described file answers the query, and why.
 *
 * bm25 already ranks by rarity, but it cannot say *which* of the user's terms
 * matched, and that is the sentence the interface has to show: "matched dog,
 * brown, grass". So the overlap is recomputed here against the stored tags,
 * which also lets a file that hits four terms outrank one that hits one.
 */
function scoreRow(row, terms) {
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { tags = []; }
  const bag = new Set(tags);
  const joined = tags.join(' ');

  const matched = [];
  for (const term of terms) {
    if (bag.has(term)) { matched.push(term); continue; }
    // A multi-word term counts when the phrase appears among the tags, and a
    // single word counts when it is a whole word inside a longer tag —
    // "dog" matches the tag "dog park", but not the tag "dogma".
    const re = new RegExp(`(?:^|\\s)${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
    if (re.test(joined)) matched.push(term);
  }

  return {
    matched,
    // Rarity from bm25 (lower is better there, so it is negated), plus a strong
    // reward for covering more of what the person actually asked for.
    score: matched.length * 10 - (row.rank || 0),
  };
}

/**
 * Finds files whose description matches a description.
 *
 * @param {object} index the Index
 * @param {string} query what the user typed
 * @param {object} opts
 * @returns {Promise<object>} results plus everything needed to explain them
 */
async function findByDescription(index, query, {
  gemini = null, signal = null, limit = 40, kind = null, exists = null,
} = {}) {
  const stats = index.tagIndexStats();
  if (!stats.described) {
    return {
      query, results: [], terms: [], kind: null, extensions: [],
      expandedBy: null, indexed: stats,
      note: 'No files have been described yet. Build the description index from ' +
            'the Discover view before searching by description.',
    };
  }

  const expansion = await expandQuery(query, { gemini, signal });
  const wantKind = kind || expansion.kind;
  if (!expansion.terms.length) {
    return {
      query, results: [], terms: [], kind: wantKind, extensions: [],
      expandedBy: expansion.expandedBy, indexed: stats,
      note: 'That description had no words to search with.',
    };
  }

  const rows = index.searchFileTags(matchExpression(expansion.terms), {
    limit: Math.min(200, limit * 4),
    kind: wantKind,
    extensions: expansion.extensions.length ? expansion.extensions : null,
  });

  const scored = rows.map((row) => {
    const { matched, score } = scoreRow(row, expansion.terms);
    let tags = [];
    try { tags = JSON.parse(row.tags || '[]'); } catch { /* stored malformed */ }
    return {
      path: row.path,
      name: row.name,
      extension: row.extension,
      category: row.category,
      kind: row.kind,
      size: row.size,
      mtimeMs: row.mtimeMs,
      tags,
      matched,
      score,
      describedBy: row.model,
      describedAt: row.taggedAt,
    };
  });

  // A description can outlive the file it describes. Rows whose file is gone
  // are dropped from the answer rather than offered and then failing to open.
  const live = exists ? scored.filter((r) => exists(r.path)) : scored;

  live.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);

  return {
    query,
    results: live.slice(0, limit),
    terms: expansion.terms,
    kind: wantKind,
    extensions: expansion.extensions,
    expandedBy: expansion.expandedBy,
    indexed: stats,
    dropped: scored.length - live.length,
    note: expansion.note,
  };
}

module.exports = {
  findByDescription,
  expandQuery,
  matchExpression,
  plainTerms,
  kindFromQuery,
  scoreRow,
  KIND_WORDS,
  EXPANSION_INSTRUCTION,
};
