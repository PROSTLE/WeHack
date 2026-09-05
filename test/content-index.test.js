// Content search: does the index find the file that is *about* a thing, rather
// than every file that happens to contain the word once.
//
// The corpus is deliberately adversarial in the way a real disk is: one long
// article about elephants, one shopping list that mentions an elephant costume
// in passing, one file named after elephants that is about something else, and
// one file with no text in it at all.

const fs = require('fs');
const os = require('os');
const path = require('path');

const roots = require('../src/main/security/roots.js');
const { Index } = require('../src/main/db.js');
const search = require('../src/main/search/content-index.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

// Resolved, because macOS hands out /var/folders/... for a directory that really
// lives at /private/var/folders/... . The indexer stores the resolved spelling,
// so a test that looked rows up by the unresolved one would find nothing and
// would pass every "this must not be indexed" assertion for the wrong reason.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-search-')));
const docs = path.join(tmp, 'Documents');
fs.mkdirSync(docs, { recursive: true });
roots.approveRoot(tmp);

const ARTICLE = `
Why Elephants Remember
An elephant herd is led by its oldest female. Elephants recognise the bones of
their dead, and an elephant separated from its herd will call for days. The
matriarch remembers where water was found in a drought forty years earlier, and
that memory is what keeps the herd alive. Elephant calves stay with their
mothers far longer than most mammals.
`.repeat(4);

fs.writeFileSync(path.join(docs, 'elephant-blog.md'), ARTICLE);
fs.writeFileSync(path.join(docs, 'shopping.txt'),
  'Milk, bread, eggs, an elephant costume for the school play, batteries, tea.');
fs.writeFileSync(path.join(docs, 'elephants-invoice.txt'),
  'Invoice 4417. Payment terms thirty days. Total due 210.00. Consultancy, March.');
fs.writeFileSync(path.join(docs, 'photo.txt'), '');
// A file that is not what its extension claims. Extraction fails, and the point
// of the assertion below is that this is recorded as "could not read" rather
// than quietly becoming a document with no text in it.
fs.writeFileSync(path.join(docs, 'scanned.pdf'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
// Inside a skipped directory: present on disk, must never be indexed.
fs.mkdirSync(path.join(docs, 'node_modules', 'pkg'), { recursive: true });
fs.writeFileSync(path.join(docs, 'node_modules', 'pkg', 'readme.md'), 'elephants '.repeat(200));

const index = new Index(path.join(tmp, 'index.db')).open();

(async () => {
  console.log('-- keyword extraction --');
  const kw = search.keywordsFrom('Hey Nexa open my blog on elephants and convert it to a pdf');
  ok('drops task verbs and stop words', !kw.includes('open') && !kw.includes('convert') && !kw.includes('and'),
    JSON.stringify(kw));
  ok('keeps the subject', kw.includes('elephants'), JSON.stringify(kw));
  ok('a query of only stop words yields nothing', search.keywordsFrom('the and of it').length === 0);

  console.log('-- FTS expression is escaped, not interpreted --');
  ok('quotes are doubled', search.termExpression('a"b') === '"a""b"*');
  ok('an FTS operator is searched for, not run',
    search.termExpression('AND') === '"AND"*');

  console.log('-- indexing --');
  const run = await search.ensureIndexed({ index, scanId: null }, { budgetMs: 20_000, maxFiles: 200 });
  ok('read the documents it found', run.read >= 4, `read ${run.read} of ${run.candidates}`);
  ok('an empty file is not a candidate at all', !index.docBodyFor(roots.normalize(path.join(docs, 'photo.txt'))));
  ok('reports completion honestly', run.complete === true);
  ok('skipped node_modules',
    !index.docBodyFor(roots.normalize(path.join(docs, 'node_modules', 'pkg', 'readme.md'))));

  const stats = index.docIndexStats();
  ok('a file whose text could not be extracted is recorded as unread, with a reason',
    stats.files > stats.readable, `${stats.readable} readable of ${stats.files}`);
  const broken = index.docBodyFor(roots.normalize(path.join(docs, 'scanned.pdf')));
  ok('and the reason is kept', !!broken && broken.ok === 0 && !!broken.note, broken?.note);

  console.log('-- a second pass reads nothing again --');
  const again = await search.ensureIndexed({ index, scanId: null }, { budgetMs: 20_000, maxFiles: 200 });
  ok('unchanged files are skipped', again.read === 0 && again.skippedFresh >= 3,
    `read ${again.read}, skipped ${again.skippedFresh}`);

  console.log('-- a changed file is re-read --');
  fs.writeFileSync(path.join(docs, 'shopping.txt'), 'Milk, bread, eggs, tea, and nothing else.');
  const third = await search.ensureIndexed({ index, scanId: null }, { budgetMs: 20_000, maxFiles: 200 });
  ok('the edited file is read again', third.read === 1, `read ${third.read}`);

  console.log('-- ranking --');
  const r = search.search({ index }, 'my blog about elephants');
  ok('found something', r.matches.length > 0, JSON.stringify(r.terms));
  ok('the article ranks first', r.matches[0]?.name === 'elephant-blog.md',
    r.matches.map((m) => m.name).join(', '));
  ok('the edited shopping list no longer matches',
    !r.matches.some((m) => m.name === 'shopping.txt'));
  ok('a filename match with no matching text still ranks below the article',
    r.matches.findIndex((m) => m.name === 'elephants-invoice.txt') !== 0);
  ok('every match carries the passage that caused it',
    r.matches.every((m) => typeof m.snippet === 'string' && m.snippet.length > 0));
  ok('every match says how many terms it matched',
    r.matches.every((m) => m.matchedTermCount >= 1 && m.termCount === r.terms.length));

  console.log('-- stemming --');
  ok('singular finds plural', search.search({ index }, 'elephant').matches.length > 0);

  console.log('-- a term nobody wrote --');
  const none = search.search({ index }, 'quokkas');
  ok('returns no matches rather than the closest thing', none.matches.length === 0);
  ok('and still reports how much was searched', none.searched >= 3, `searched ${none.searched}`);

  console.log('-- reading one back --');
  const body = search.readIndexed({ index }, path.join(docs, 'elephant-blog.md'), { maxChars: 100 });
  ok('returns the text', body.ok && body.text.length === 100);
  ok('says it was truncated', body.truncated === true);
  const empty = search.readIndexed({ index }, path.join(docs, 'photo.txt'));
  ok('an unreadable file says so rather than returning ""', empty.ok === false && !!empty.note);

  console.log('-- case-folding --');
  // The same file, spelled the way the other half of the application spells it.
  const shouted = path.join(docs.toUpperCase(), 'ELEPHANT-BLOG.MD');
  ok('a differently-cased path finds the same indexed file',
    process.platform === 'linux' || search.readIndexed({ index }, shouted).ok === true);

  console.log('-- the root gate still holds --');
  let refused = false;
  try {
    search.readIndexed({ index }, path.join(os.tmpdir(), '..', 'etc', 'hosts'));
  } catch { refused = true; }
  ok('a path outside every approved root is refused', refused);

  index.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
