// Windows hidden and system attributes.
//
// The defect this suite exists to prevent: `dir /a:S` exits 1 and prints
// "File Not Found" when a directory holds nothing with that attribute, and
// treating that as a failure made the whole listing fall back to the Unix
// dot-prefix convention. In a project folder — dot-files, nothing actually
// hidden — that hid .gitignore, which Windows shows perfectly well.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const A = require('../src/main/fs/attributes.js');
const browse = require('../src/main/fs/browse.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}

if (process.platform !== 'win32') {
  console.log('  SKIP  attributes are a Windows concept; nothing to test here.');
  process.exit(0);
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-attr-'));

function makeDir(name, { hidden = [], system = [], plain = [] } = {}) {
  const dir = path.join(DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [...hidden, ...system, ...plain]) {
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  for (const f of hidden) execFileSync('attrib', ['+H', path.join(dir, f)]);
  for (const f of system) execFileSync('attrib', ['+S', path.join(dir, f)]);
  return dir;
}

(async () => {
  console.log('-- a folder with nothing hidden --');
  const plain = makeDir('plain', { plain: ['.gitignore', 'readme.md'] });
  const a1 = await A.readDirectoryAttributes(plain);
  ok('the attributes are read, not reported as unreadable', a1 !== null);
  ok('and the answer is that nothing is hidden',
    a1 && a1.hidden.size === 0 && a1.system.size === 0);

  const l1 = await browse.listDirectory(plain);
  ok('the listing says the attributes were read', l1.attributesRead === true);
  const dot = l1.entries.find((e) => e.name === '.gitignore');
  ok('a dot-file is NOT hidden on Windows, whatever Unix would say',
    dot && dot.hidden === false, dot && String(dot.hidden));
  ok('so nothing is filtered out of the default view', l1.counts.hidden === 0);

  console.log('\n-- a folder with real hidden and system files --');
  const mixed = makeDir('mixed', {
    hidden: ['secret.txt'], system: ['sys.dat'], plain: ['open.txt', '.config'],
  });
  const a2 = await A.readDirectoryAttributes(mixed);
  ok('the hidden file is found', a2.hidden.has('secret.txt'), [...a2.hidden].join());
  ok('the system file is found', a2.system.has('sys.dat'), [...a2.system].join());

  const l2 = await browse.listDirectory(mixed);
  const byName = Object.fromEntries(l2.entries.map((e) => [e.name, e]));
  ok('the hidden file is flagged', byName['secret.txt'].hidden === true);
  ok('the system file is flagged', byName['sys.dat'].system === true);
  ok('the ordinary file is not', byName['open.txt'].hidden === false);
  ok('and neither is the dot-file beside them', byName['.config'].hidden === false);
  ok('the count matches what was marked', l2.counts.hidden === 2, `${l2.counts.hidden}`);

  console.log('\n-- paths that upset a command line --');
  // `&` is a cmd operator and a perfectly ordinary character in a folder name.
  const amp = makeDir('R&D notes', { hidden: ['h.txt'], plain: ['a.txt'] });
  const a3 = await A.readDirectoryAttributes(amp);
  ok('an ampersand and spaces in the path are handled',
    a3 !== null && a3.hidden.has('h.txt'), a3 ? [...a3.hidden].join() : 'null');
  const l3 = await browse.listDirectory(amp);
  ok('and nothing was executed by the shell along the way',
    l3.counts.total === 2, `${l3.counts.total} entries`);

  // cmd reads a leading forward slash as a switch.
  const forward = plain.replace(/\\/g, '/');
  const a4 = await A.readDirectoryAttributes(forward);
  ok('a path written with forward slashes still works', a4 !== null);

  console.log('\n-- the cache --');
  A.clearCache();
  const before = Date.now();
  await A.readDirectoryAttributes(mixed);
  const cold = Date.now() - before;
  const warm0 = Date.now();
  await A.readDirectoryAttributes(mixed);
  const warm = Date.now() - warm0;
  ok('a repeated read is served from the cache', warm <= cold, `${cold} ms then ${warm} ms`);

  fs.writeFileSync(path.join(mixed, 'newer.txt'), 'x');
  execFileSync('attrib', ['+H', path.join(mixed, 'newer.txt')]);
  const a5 = await A.readDirectoryAttributes(mixed);
  ok('and a change to the folder invalidates it',
    a5.hidden.has('newer.txt'), [...a5.hidden].join());

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
