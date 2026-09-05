// Path-validation tests. Run: node test/roots.test.js
const r = require('../src/main/security/roots.js');
const os = require('os'), path = require('path');

let pass = 0, fail = 0;
function check(name, fn, shouldThrow) {
  let threw = false, msg = '';
  try { fn(); } catch (e) { threw = true; msg = e.message; }
  const ok = threw === shouldThrow;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (threw ? '  <- ' + msg.slice(0, 66) : ''));
  ok ? pass++ : fail++;
}

const home = os.homedir();
const WIN = process.platform === 'win32';

console.log('\n-- scoping: only the home root is approved --');
r.approveDefaultRoots();
console.log('   roots:', r.listRoots());
check('home itself allowed', () => r.assertInsideRoot(home), false);
check('path under home allowed', () => r.assertInsideRoot(path.join(home, 'Documents')), false);
check('traversal out of home denied', () => r.assertInsideRoot(path.join(home, '..', '..')), true);
check('empty path denied', () => r.assertInsideRoot(''), true);
check('null byte denied', () => r.assertInsideRoot(home + '\u0000/etc'), true);
check('non-string denied', () => r.assertInsideRoot(null), true);
if (WIN) {
  check('unapproved D: denied', () => r.assertInsideRoot('D:' + path.sep), true);
  check('other user profile denied',
    () => r.assertInsideRoot(path.join(path.dirname(home), 'SomeoneElse', 'Documents')), true);
}

console.log('\n-- deny list: system root approved, deny list must still hold --');
const sysRoot = WIN ? 'C:' + path.sep : '/';
check('approving system root succeeds', () => r.approveRoot(sysRoot), false);
if (WIN) {
  check('C:\\Windows denied even under C:\\ root',
    () => r.assertInsideRoot(path.join('C:', 'Windows', 'System32', 'cmd.exe')), true);
  check('$Recycle.Bin denied',
    () => r.assertInsideRoot(path.join('C:', '$Recycle.Bin', 'S-1-5-21')), true);
  check('WindowsApps denied',
    () => r.assertInsideRoot(path.join('C:', 'Program Files', 'WindowsApps', 'pkg')), true);
  check('ordinary Program Files allowed',
    () => r.assertInsideRoot(path.join('C:', 'Program Files')), false);
  check('cannot approve C:\\Windows as a root',
    () => r.approveRoot(path.join('C:', 'Windows')), true);
} else {
  check('/usr denied', () => r.assertInsideRoot('/usr/bin/ls'), true);
  check('/System denied', () => r.assertInsideRoot('/System/Library'), true);
  check('cannot approve /usr as a root', () => r.approveRoot('/usr'), true);
}

console.log('\n-- user-editable protected list --');
const protectedDir = path.join(home, 'Documents', 'Taxes');
r.setUserProtected([protectedDir]);
check('protected path denied', () => r.assertInsideRoot(path.join(protectedDir, '2024.pdf')), true);
check('protected dir itself denied', () => r.assertInsideRoot(protectedDir), true);
check('prefix-sibling NOT denied (not a string prefix test)',
  () => r.assertInsideRoot(path.join(home, 'Documents', 'TaxesArchive')), false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
