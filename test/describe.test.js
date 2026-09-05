// Describing files, and finding them from a description.
//
// Every model call is faked. What is being tested is everything around the
// call — which files get sent, which are skipped, how a reply is parsed, how a
// query becomes a match expression, and what happens when the model returns
// something hostile or malformed. Those are the parts that can be wrong
// silently; the API call itself is either made or it isn't.
//
// The two anti-patterns from the source project this feature is modelled on are
// covered directly: a reply is never evaluated, and a query the model wrote is
// never executed. Both have a test that would fail loudly if that changed.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { Index } = require('../src/main/db.js');
const llmTags = require('../src/main/classify/llm-tags.js');
const tagSearch = require('../src/main/search/tag-search.js');
const { sanitise, defaults } = require('../src/main/settings.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

/** A Gemini client that answers with whatever the test decides. */
function fakeGemini(reply, { model = 'fake-model', fail: shouldFail = null } = {}) {
  return {
    available: true,
    model,
    calls: [],
    async generate(contents, opts) {
      this.calls.push({ contents, opts });
      if (shouldFail) throw shouldFail;
      return { candidates: [{ content: { parts: [{ text: reply }] } }] };
    },
  };
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-describe-'));
  const dbPath = path.join(work, 'index.db');
  const index = new Index(dbPath).open();

  console.log('\n-- which files are worth describing --');
  ok('a photo is', llmTags.isDescribable('a.jpg') && llmTags.kindOf('a.JPG') === 'image');
  ok('a document is', llmTags.kindOf('a.pdf') === 'document');
  ok('source code is', llmTags.kindOf('a.py') === 'code');
  // Paying an API call to be told a DLL has nothing to say is waste the user
  // did not agree to.
  ok('a binary is not', !llmTags.isDescribable('a.dll') && !llmTags.isDescribable('a.exe'));
  ok('an extensionless file is not', !llmTags.isDescribable('LICENSE'));

  console.log('\n-- the reply is parsed, never evaluated --');
  // The source technique called eval() on this. If that ever came back, this
  // string would create a file and the test would notice.
  const marker = path.join(work, 'EVALUATED');
  // Valid JSON whose *tag* is executable code. The source technique this is
  // modelled on ran eval() over the reply; if that ever came back, parsing this
  // would create the marker file and the next assertion would catch it.
  const evil = `require('fs').writeFileSync(${JSON.stringify(marker)},'1')`;
  const parsedEvil = llmTags.parseReply(JSON.stringify({ tags: [evil, 'dog'], summary: 'hi' }));
  ok('a reply carrying code still parses as data', parsedEvil.ok === true, parsedEvil.note || '');
  ok('and nothing on disk was created by parsing it', !fs.existsSync(marker));
  // What matters is that nothing executable survives: no call syntax, no
  // quotes, no path separators. The bare word "require" is just a word.
  ok('every character that could execute is stripped out',
    parsedEvil.tags.every((t) => !/[()[\]{};:'"`$\\/=.]/.test(t)),
    JSON.stringify(parsedEvil.tags).slice(0, 90));
  ok('the ordinary tag beside it survives', parsedEvil.tags.includes('dog'));

  console.log('\n-- malformed replies fail, and say why --');
  for (const [label, reply] of [
    ['prose', 'here are your tags: dog, cat'],
    ['an array', '[1,2,3]'],
    ['no tags key', '{"summary":"hi"}'],
    ['nothing', ''],
  ]) {
    const r = llmTags.parseReply(reply);
    ok(`${label} is refused with a reason`,
      r.ok === false && typeof r.note === 'string' && r.note.length > 10);
  }
  ok('a fenced reply is still accepted',
    llmTags.parseReply('```json\n{"tags":["dog","grass"]}\n```').tags.length === 2);
  ok('tags are capped',
    llmTags.parseReply(JSON.stringify({ tags: Array.from({ length: 200 }, (_, i) => `tag${i}`) }))
      .tags.length === llmTags.MAX_TAGS);

  console.log('\n-- describing one real file --');
  const img = path.join(work, 'IMG_4821.jpg');
  // A 1x1 PNG is enough: attachments.js reads it, and the model is faked.
  await fsp.writeFile(img, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));

  const gem = fakeGemini('{"tags":["Dog","brown dog","grass","outdoor","pet"],"summary":"A dog."}');
  const described = await llmTags.describeFile(img, { gemini: gem });
  ok('it succeeds', described.ok === true, described.note || '');
  ok('tags come back lower-cased and de-duplicated',
    described.tags.includes('dog') && described.tags.includes('brown dog'));
  ok('the model that wrote them is recorded', described.model === 'fake-model');
  ok('the API was asked for JSON, not asked nicely in prose',
    gem.calls[0]?.opts?.generationConfig?.responseMimeType === 'application/json');
  ok('the file was actually sent as image data',
    JSON.stringify(gem.calls[0].contents).includes('inlineData'));

  console.log('\n-- a file that cannot be described is remembered as such --');
  const failing = fakeGemini('', { fail: Object.assign(new Error('quota'), { code: 'RATE' }) });
  const bad = await llmTags.describeFile(img, { gemini: failing });
  // Without this row the indexer would pay to fail on the same file forever.
  ok('it reports failure rather than throwing', bad.ok === false && !!bad.note);
  const missing = await llmTags.describeFile(path.join(work, 'nope.jpg'), { gemini: gem });
  ok('a file that is gone is reported, not thrown', missing.ok === false);
  const cancelled = fakeGemini('', { fail: Object.assign(new Error('Stopped.'), { code: 'CANCELLED' }) });
  let travelled = false;
  try { await llmTags.describeFile(img, { gemini: cancelled }); }
  catch (e) { travelled = e.code === 'CANCELLED'; }
  // A cancellation is the user's decision, not a property of the file.
  ok('a cancellation travels instead of being stored against the file', travelled);

  console.log('\n-- storing and finding --');
  const put = (p, kind, ext, tags) => index.putFileTags({
    pathKey: p.toLowerCase(), path: p, name: path.basename(p), extension: ext,
    category: kind === 'image' ? 'media' : 'documents', kind,
    size: 10, mtimeMs: 1, tags, model: 'fake-model', ok: true,
  });
  put('C:/pics/IMG_4821.JPG', 'image', 'jpg',
    ['dog', 'brown dog', 'brown', 'grass', 'outdoor', 'pet', 'animal']);
  put('C:/pics/IMG_9001.JPG', 'image', 'jpg', ['cat', 'black', 'sofa', 'indoor', 'pet']);
  put('C:/docs/q3.pdf', 'document', 'pdf', ['revenue', 'quarterly', 'report', 'dog']);

  ok('a described file is not described again',
    index.fileTagsFresh('c:/pics/img_4821.jpg', 10, 1) === true);
  ok('but a changed one is',
    index.fileTagsFresh('c:/pics/img_4821.jpg', 999, 1) === false);

  const found = await tagSearch.findByDescription(index, 'a photo of a brown dog on grass',
    { gemini: null, limit: 10 });
  ok('the right photo is first', found.results[0]?.name === 'IMG_4821.JPG',
    found.results.map((r) => r.name).join(', '));
  // "photo" in the query has to exclude the PDF, which is tagged "dog" too.
  ok('the kind asked for excludes a document that matched a word',
    !found.results.some((r) => r.name === 'q3.pdf'));
  ok('it says which terms matched, as evidence',
    (found.results[0]?.matched || []).includes('dog'));
  ok('with no key it says the words were not expanded',
    /No API key/.test(found.note || ''));

  console.log('\n-- the model emits words; this code builds the query --');
  const terms = ['brown dog', 'a" OR 1=1 --', 'NEAR', '(('];
  const expr = tagSearch.matchExpression(terms);
  // Reconstructed rather than split on " OR ", because one of the terms
  // contains " OR " itself — which is exactly the case that has to be safe.
  const expected = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  ok('the expression is exactly each term quoted, and nothing else',
    expr === expected, expr);
  ok('an embedded quote is doubled, not escaped away', expr.includes('""'));
  for (const nasty of ['a" OR 1=1 --', 'NEAR', '((', '*', 'dog AND NOT grass']) {
    let threw = null;
    try { index.searchFileTags(tagSearch.matchExpression(['dog', nasty])); }
    catch (e) { threw = e.message; }
    ok(`a hostile term cannot break the query: ${JSON.stringify(nasty)}`, threw === null, threw || '');
  }

  console.log('\n-- what the expansion model is allowed to return --');
  const expander = fakeGemini(JSON.stringify({
    terms: ['puppy', 'canine', 'DROP TABLE files', 12, null],
    kind: 'nonsense',
    extensions: ['.JPG', 'png', 'not an ext!', 'jpeg'],
  }));
  const exp = await tagSearch.expandQuery('a dog', { gemini: expander });
  ok('non-string terms are dropped', !exp.terms.some((t) => typeof t !== 'string'));
  ok('an invalid kind falls back to what the query itself says', exp.kind === null);
  ok('extensions are normalised and the invalid one dropped',
    exp.extensions.includes('jpg') && exp.extensions.includes('png') &&
    !exp.extensions.some((e) => e.includes(' ')), exp.extensions.join(','));
  ok('the user\'s own words survive expansion', exp.terms.includes('dog'));

  const broken = fakeGemini('not json');
  const fell = await tagSearch.expandQuery('a dog', { gemini: broken });
  // The feature degrades to a plain keyword search rather than failing.
  ok('a broken expansion degrades to the typed words',
    fell.terms.includes('dog') && /wrong shape|not|JSON/i.test(fell.note || ''));

  console.log('\n-- an empty index is not an empty result --');
  const empty = new Index(path.join(work, 'empty.db')).open();
  const none = await tagSearch.findByDescription(empty, 'a dog', { gemini: null });
  // "nothing matched" and "nothing has been described" are different answers.
  ok('it says nothing has been described, not that nothing matched',
    none.results.length === 0 && /described/i.test(none.note || ''), none.note);
  empty.close();

  console.log('\n-- descriptions outlive files, so they are reconciled --');
  ok('a description whose file is gone is dropped by a verify',
    index.pruneFileTags(() => false) === 3);
  ok('and the index reports itself empty afterwards',
    index.tagIndexStats().described === 0);

  console.log('\n-- which files a capped run spends its calls on --');
  //
  // This is the bug that made the feature look broken on a real machine. A run
  // is capped at a couple of hundred API calls; a scan can hold a million
  // files. The first version borrowed the document indexer's candidate query,
  // which orders by size descending because that caller genuinely wants the
  // biggest documents first. For describing, that is exactly backwards: it
  // spends the whole cap on the largest PDFs on the disk and never reaches an
  // 80 KB photo in Downloads — which is the file the feature exists to find.
  const ord = new Index(path.join(work, 'order.db')).open();
  ord.db.prepare(`INSERT INTO scans (id, root, status, startedAt) VALUES ('s1', ?, 'complete', 'x')`)
    .run('C:\\');
  const insert = ord.db.prepare(
    'INSERT INTO files (scanId,path,name,isDirectory,size,mtimeMs,extension) VALUES (?,?,?,0,?,?,?)');
  const PHOTO = 'C:\\Users\\HP\\Downloads\\picture.png';
  insert.run('s1', 'C:\\huge.pdf', 'huge.pdf', 90_000_000, 1_000, 'pdf');
  insert.run('s1', PHOTO, 'picture.png', 79_999, 5_000, 'png');
  insert.run('s1', 'C:\\Users\\HP\\Downloads\\notes.pdf', 'notes.pdf', 400, 6_000, 'pdf');
  insert.run('s1', 'C:\\ancient.jpg', 'ancient.jpg', 200, 10, 'jpg');
  insert.run('s1', 'C:\\app.py', 'app.py', 500, 9_000, 'py');

  const imgExts = ['png', 'jpg', 'jpeg'];
  const all = ord.describeCandidates('s1', { imageExts: imgExts, otherExts: ['pdf'] });
  ok('a picture is reached before a 90 MB PDF',
    all[0].path === PHOTO, all.map((r) => path.basename(r.path)).join(' > '));
  ok('pictures come before everything else',
    all.findIndex((r) => r.extension === 'pdf') > all.findIndex((r) => r.extension === 'jpg'));
  ok('and the newer picture comes before the older one',
    all.findIndex((r) => r.path === PHOTO)
      < all.findIndex((r) => path.basename(r.path) === 'ancient.jpg'));
  ok('code is not described unless it was opted into',
    !all.some((r) => r.extension === 'py'));
  ok('opting into code includes it',
    ord.describeCandidates('s1', { imageExts: imgExts, otherExts: ['pdf', 'py'] })
      .some((r) => r.extension === 'py'));

  // Scoping is the option that makes a capped run useful at all.
  const scoped = ord.describeCandidates('s1', {
    imageExts: imgExts, otherExts: ['pdf'], under: 'C:\\Users\\HP\\Downloads',
  });
  ok('a run scoped to a folder returns only that folder',
    scoped.length === 2 && scoped.every((r) => r.path.includes('Downloads')),
    scoped.map((r) => path.basename(r.path)).join(', '));
  ok('and the picture is still first inside it', scoped[0].path === PHOTO);
  ok('a zero-byte file is never sent',
    (() => {
      insert.run('s1', 'C:\\empty.png', 'empty.png', 0, 7_000, 'png');
      return !ord.describeCandidates('s1', { imageExts: imgExts }).some((r) => r.size === 0);
    })());
  ord.close();

  console.log('\n-- the setting is off until it is switched on --');
  ok('describing is off by default', defaults().describe.enabled === false);
  ok('the per-run cap is clamped, not trusted',
    sanitise({ describe: { maxFilesPerRun: 999999 } }).describe.maxFilesPerRun === 5000 &&
    sanitise({ describe: { maxFilesPerRun: -5 } }).describe.maxFilesPerRun === 10);
  ok('a junk value leaves the stored one alone',
    sanitise({ describe: { enabled: 'yes' } }).describe.enabled === false);

  index.close();
  await fsp.rm(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
