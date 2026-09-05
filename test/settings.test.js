// The settings store: what it accepts, what it refuses, and what it hands back.
//
// The store sits between the renderer and a file on disk, so it is the place
// where a malformed or hostile value has to stop. The tests that matter here
// are the refusals.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Settings, sanitise, defaults } = require('../src/main/settings.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-settings-'));

console.log('-- defaults --');
const d = defaults();
ok('the theme follows the system until told otherwise', d.theme === 'system');
ok('no model is pinned', d.assistant.model === null);
ok('no keys are present', d.assistant.keys.length === 0);

console.log('\n-- what is refused --');
ok('an unknown theme falls back to the default',
  sanitise({ theme: 'neon' }).theme === 'system');
ok('a theme that is not a string is refused',
  sanitise({ theme: { toString: () => 'dark' } }).theme === 'system');
ok('a model id with a path separator is refused',
  sanitise({ assistant: { model: '../../etc/passwd' } }).assistant.model === null);
ok('a model id with a query string is refused',
  sanitise({ assistant: { model: 'gemini-2.0?key=x' } }).assistant.model === null);
ok('a plausible model id is kept',
  sanitise({ assistant: { model: 'gemini-2.5-flash' } }).assistant.model === 'gemini-2.5-flash');
ok('a too-short key is dropped',
  sanitise({ assistant: { keys: ['abc'] } }).assistant.keys.length === 0);
ok('keys are trimmed and capped at eight',
  (() => {
    const s = sanitise({ assistant: { keys: Array.from({ length: 20 }, (_, i) => `  key-${i}-padding  `) } });
    return s.assistant.keys.length === 8 && s.assistant.keys[0] === 'key-0-padding';
  })());
ok('an unknown layout is refused',
  sanitise({ files: { layout: 'cover-flow' } }).files.layout === 'details');
ok('a sort direction outside 1 and -1 is refused',
  sanitise({ files: { sortDir: 7 } }).files.sortDir === 1);
ok('a non-object survives without throwing',
  sanitise('nonsense').theme === 'system' && sanitise(null).theme === 'system');

console.log('\n-- round trip --');
const store = new Settings(DIR);
store.update({ theme: 'dark', files: { layout: 'tiles', showHidden: true } });
ok('the choice reaches the file',
  JSON.parse(fs.readFileSync(store.file, 'utf8')).theme === 'dark');
ok('a partial update leaves the other sections alone',
  store.values.files.sortKey === 'name' && store.values.files.layout === 'tiles');

const reopened = new Settings(DIR);
ok('and survives a restart',
  reopened.values.theme === 'dark' && reopened.values.files.showHidden === true);

// The bug this replaced: one bad field in a patch reset the whole section to
// factory settings, quietly throwing away a layout the user had chosen.
store.update({ files: { layout: 'cover-flow' } });
ok('an invalid field in an update leaves the stored value alone',
  store.values.files.layout === 'tiles', store.values.files.layout);
ok('and does not disturb its neighbours',
  store.values.files.showHidden === true && store.values.theme === 'dark');

console.log('\n-- keys never travel back to the renderer --');
store.update({ assistant: { keys: ['AIzaSyTESTKEY-0001', 'AIzaSyTESTKEY-0002'] } });
const payload = store.forRenderer();
const asText = JSON.stringify(payload);
ok('the payload reports how many keys there are', payload.assistant.keyCount === 2);
ok('it shows only the last four characters',
  payload.assistant.keyHints.join() === '…0001,…0002', payload.assistant.keyHints.join());
ok('and contains no key material at all', !asText.includes('AIzaSyTESTKEY'));
ok('the key itself is still on disk for the main process to use',
  new Settings(DIR).values.assistant.keys.length === 2);

console.log('\n-- a corrupt file is not fatal --');
fs.writeFileSync(store.file, '{ this is not json', 'utf8');
const recovered = new Settings(DIR);
ok('it falls back to the defaults rather than failing to start',
  recovered.values.theme === 'system');

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
