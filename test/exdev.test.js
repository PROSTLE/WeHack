// Verifies safeMove survives a real cross-filesystem boundary.
// This machine has C: and D:, so the EXDEV path is exercised for real,
// not simulated.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { safeMove, hashFile, measure } = require('../src/main/safety/fsops.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

// Find a second volume to move across. Falls back to same-volume if none.
function pickCrossVolumeDir() {
  if (process.platform !== 'win32') return null;
  const home = os.homedir();
  const homeDrive = path.parse(home).root;
  for (const letter of 'DEFGHIJ') {
    const root = letter + ':' + path.sep;
    if (root.toLowerCase() === homeDrive.toLowerCase()) continue;
    try {
      fs.accessSync(root, fs.constants.W_OK);
      return path.join(root, 'nexafiles-exdev-test');
    } catch { /* not present or not writable */ }
  }
  return null;
}

(async () => {
  const srcDir = path.join(os.tmpdir(), 'nexafiles-exdev-src');
  await fsp.rm(srcDir, { recursive: true, force: true });
  await fsp.mkdir(srcDir, { recursive: true });

  // ---- same-volume move should take the fast rename path ----
  const a = path.join(srcDir, 'a.bin');
  await fsp.writeFile(a, crypto_random(64 * 1024));
  const aHash = await hashFile(a);
  const sameDest = path.join(srcDir, 'moved', 'a.bin');
  const r1 = await safeMove(a, sameDest);
  ok('same-volume move succeeds', fs.existsSync(sameDest));
  ok('same-volume uses rename (no needless copy)', r1.method === 'rename', `method=${r1.method}`);
  ok('same-volume content intact', (await hashFile(sameDest)) === aHash);
  ok('same-volume source gone', !fs.existsSync(a));

  // ---- cross-volume move: the actual EXDEV case ----
  const crossDir = pickCrossVolumeDir();
  if (!crossDir) {
    console.log('  SKIP  cross-volume move (no second writable volume found)');
  } else {
    await fsp.rm(crossDir, { recursive: true, force: true });
    const b = path.join(srcDir, 'b.bin');
    await fsp.writeFile(b, crypto_random(3 * 1024 * 1024));
    const bHash = await hashFile(b);

    // Prove fs.rename alone genuinely fails here — this is defect 7.
    // The destination directory must exist first, otherwise rename fails with
    // ENOENT and we would be asserting the wrong thing.
    await fsp.mkdir(crossDir, { recursive: true });
    let renameErr = null;
    try { await fsp.rename(b, path.join(crossDir, 'b.bin')); }
    catch (e) { renameErr = e.code; }
    ok('bare fs.rename fails with EXDEV across volumes (defect 7 reproduced)',
      renameErr === 'EXDEV', `code=${renameErr}`);

    const crossDest = path.join(crossDir, 'b.bin');
    const r2 = await safeMove(b, crossDest);
    ok('cross-volume move succeeds', fs.existsSync(crossDest));
    ok('cross-volume used copy-verify-delete', r2.method === 'copy-verify-delete', `method=${r2.method}`);
    ok('cross-volume content byte-identical', (await hashFile(crossDest)) === bHash);
    ok('cross-volume source removed only after verify', !fs.existsSync(b));

    // ---- cross-volume directory move ----
    const tree = path.join(srcDir, 'tree');
    await fsp.mkdir(path.join(tree, 'nested'), { recursive: true });
    await fsp.writeFile(path.join(tree, 'one.txt'), 'one');
    await fsp.writeFile(path.join(tree, 'nested', 'two.txt'), 'two');
    const before = await measure(tree);
    const treeDest = path.join(crossDir, 'tree');
    const r3 = await safeMove(tree, treeDest);
    const after = await measure(treeDest);
    ok('cross-volume directory move succeeds', fs.existsSync(path.join(treeDest, 'nested', 'two.txt')));
    ok('cross-volume directory used copy path', r3.method === 'copy-verify-delete');
    ok('cross-volume directory byte total preserved',
      before.bytes === after.bytes, `${before.bytes} -> ${after.bytes}`);
    ok('cross-volume directory source removed', !fs.existsSync(tree));

    await fsp.rm(crossDir, { recursive: true, force: true });
  }

  await fsp.rm(srcDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();

function crypto_random(n) { return require('crypto').randomBytes(n); }
