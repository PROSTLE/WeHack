// Quarantine round-trip tests, including the cross-volume case.
// Per the build plan, restore is proven to work before anything is built
// that puts data into quarantine.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { Quarantine } = require('../src/main/safety/quarantine.js');
const { hashFile, measure, mapLimit } = require('../src/main/safety/fsops.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

function crossVolumeBase() {
  if (process.platform !== 'win32') return null;
  const homeRoot = path.parse(os.homedir()).root;
  for (const letter of 'DEFGHIJ') {
    const root = letter + ':' + path.sep;
    if (root.toLowerCase() === homeRoot.toLowerCase()) continue;
    try { fs.accessSync(root, fs.constants.W_OK); return path.join(root, 'nexafiles-q-test'); }
    catch { /* skip */ }
  }
  return null;
}

async function run(label, qBase, workDir) {
  console.log(`\n-- ${label} --`);
  await fsp.rm(qBase, { recursive: true, force: true });
  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(workDir, { recursive: true });

  const q = await new Quarantine(qBase).init();

  // --- single file round trip ---
  const f = path.join(workDir, 'orphan-cache.dat');
  await fsp.writeFile(f, require('crypto').randomBytes(256 * 1024));
  const origHash = await hashFile(f);
  const origStat = await fsp.stat(f);

  const entry = await q.add(f, {
    reason: 'Cache directory for an application with no uninstall entry',
    evidence: 'No registry key under HKLM/HKCU Uninstall matched publisher "AcmeCorp"',
    category: 'regenerable',
    confidence: 'medium',
    source: 'leftovers',
  });
  ok('source removed after quarantine', !fs.existsSync(f));
  ok('payload exists in quarantine', fs.existsSync(entry.payloadPath));
  ok('entry records measured byte size', entry.bytes === origStat.size, `${entry.bytes}`);
  ok('entry retains its evidence', typeof entry.evidence === 'string' && entry.evidence.length > 0);
  ok('entry retains its category', entry.category === 'regenerable');
  ok('manifest persisted to disk', fs.existsSync(path.join(qBase, 'manifest.json')));
  ok('totalBytes reflects held data', q.totalBytes() === origStat.size);

  // --- manifest survives a fresh process ---
  const q2 = await new Quarantine(qBase).init();
  ok('manifest reloads in a new instance', q2.list().length === 1);
  ok('reloaded entry keeps original path', q2.get(entry.id).originalPath === path.resolve(f));

  // --- restore ---
  const res = await q2.restore(entry.id);
  ok('restore returns original location', res.restoredTo === path.resolve(f), res.restoredTo);
  ok('restored file exists', fs.existsSync(f));
  ok('restored content byte-identical', (await hashFile(f)) === origHash);
  ok('restored mtime preserved',
    Math.abs((await fsp.stat(f)).mtimeMs - origStat.mtimeMs) < 2000);
  ok('manifest empty after restore', q2.list().length === 0);
  ok('payload cleaned up', !fs.existsSync(path.join(qBase, 'items', entry.id)));

  // --- directory round trip ---
  const tree = path.join(workDir, 'AcmeCorp');
  await fsp.mkdir(path.join(tree, 'Logs'), { recursive: true });
  await fsp.writeFile(path.join(tree, 'settings.ini'), 'theme=dark');
  await fsp.writeFile(path.join(tree, 'Logs', 'run.log'), 'x'.repeat(4096));
  const dirEntry = await q2.add(tree, { category: 'regenerable', reason: 'orphaned support dir' });
  ok('directory quarantined', !fs.existsSync(tree) && fs.existsSync(dirEntry.payloadPath));
  ok('directory byte total measured', dirEntry.bytes === 4096 + 10, `${dirEntry.bytes}`);
  await q2.restore(dirEntry.id);
  ok('directory restored with nested contents',
    fs.existsSync(path.join(tree, 'Logs', 'run.log')));
  ok('nested file content intact',
    (await fsp.readFile(path.join(tree, 'Logs', 'run.log'), 'utf8')).length === 4096);

  // --- restore into an occupied path must not overwrite ---
  const g = path.join(workDir, 'contested.txt');
  await fsp.writeFile(g, 'ORIGINAL');
  const cEntry = await q2.add(g, { category: 'regenerable' });
  await fsp.writeFile(g, 'SOMETHING NEW LIVES HERE NOW');
  const cRes = await q2.restore(cEntry.id);
  ok('occupied path is not overwritten',
    (await fsp.readFile(g, 'utf8')) === 'SOMETHING NEW LIVES HERE NOW');
  ok('restore lands beside the occupant', cRes.renamed === true && fs.existsSync(cRes.restoredTo));
  ok('restored-beside content is the quarantined original',
    (await fsp.readFile(cRes.restoredTo, 'utf8')) === 'ORIGINAL');

  // --- expiry ---
  const e = path.join(workDir, 'expiring.txt');
  await fsp.writeFile(e, 'old');
  const eEntry = await q2.add(e, { category: 'regenerable' });
  const notYet = await q2.purgeExpired(Date.now());
  ok('unexpired entry is not purged', notYet.length === 0 && q2.list().length === 1);
  const later = Date.parse(eEntry.expiresAt) + 1000;
  const purged = await q2.purgeExpired(later);
  ok('expired entry is purged', purged.length === 1 && q2.list().length === 0);
  ok('purged payload removed from disk', !fs.existsSync(path.join(qBase, 'items', eEntry.id)));

  // --- audit ---
  const audit = await q2.audit();
  ok('audit reports a clean store',
    audit.orphanPayloads.length === 0 && audit.missingPayloads.length === 0);

  // --- restoring an unknown id fails loudly ---
  let threw = false;
  try { await q2.restore('not-a-real-id'); } catch { threw = true; }
  ok('restoring unknown id throws', threw);

  await fsp.rm(qBase, { recursive: true, force: true });
  await fsp.rm(workDir, { recursive: true, force: true });
}

(async () => {
  const tmp = os.tmpdir();
  // Same-volume: quarantine store and source on the same drive.
  await run('same-volume quarantine',
    path.join(tmp, 'nexafiles-q'), path.join(tmp, 'nexafiles-work'));

  // Cross-volume: the realistic case, since userData sits on the system drive
  // and the files being cleaned often do not.
  const cross = crossVolumeBase();
  if (!cross) {
    console.log('\n  SKIP  cross-volume quarantine (no second writable volume)');
  } else {
    await run('cross-volume quarantine (store on another drive)',
      cross, path.join(tmp, 'nexafiles-work2'));
    await fsp.rm(cross, { recursive: true, force: true });
  }

  // -- measure(), which was rewritten to overlap its stats -------------------
  //
  // It used to await one lstat at a time; it now walks a level at a time with
  // sixty-four in flight, which took the leftover sweep from 218 s to 7.6 s on
  // a real machine. That is a change to traversal order, and reorderings are
  // exactly what quietly drops or double-counts a file -- so the totals are
  // checked against a fixture whose answer is known by construction.
  console.log('\n-- measuring a tree --');
  const mRoot = path.join(os.tmpdir(), 'nexafiles-measure-fixture');
  await fsp.rm(mRoot, { recursive: true, force: true });
  await fsp.mkdir(path.join(mRoot, 'a', 'b', 'c'), { recursive: true });
  await fsp.mkdir(path.join(mRoot, 'd'), { recursive: true });
  await fsp.mkdir(path.join(mRoot, 'empty'), { recursive: true });
  await fsp.writeFile(path.join(mRoot, 'top.bin'), Buffer.alloc(100));
  await fsp.writeFile(path.join(mRoot, 'a', 'one.bin'), Buffer.alloc(200));
  await fsp.writeFile(path.join(mRoot, 'a', 'b', 'two.bin'), Buffer.alloc(300));
  await fsp.writeFile(path.join(mRoot, 'a', 'b', 'c', 'three.bin'), Buffer.alloc(400));
  await fsp.writeFile(path.join(mRoot, 'd', 'four.bin'), Buffer.alloc(500));

  const m = await measure(mRoot);
  ok('every byte is counted once', m.bytes === 1500, `${m.bytes}`);
  ok('every file is counted once', m.files === 5, `${m.files}`);
  // a, a/b, a/b/c, d, empty -- the root itself is not counted.
  ok('every directory is counted once, excluding the root', m.dirs === 5, `${m.dirs}`);

  const single = await measure(path.join(mRoot, 'top.bin'));
  ok('a plain file measures as itself', single.bytes === 100 && single.files === 1);

  // Deep enough that a level-at-a-time loop with a bug would stop early.
  let deep = path.join(mRoot, 'deep');
  await fsp.mkdir(deep);
  for (let i = 0; i < 40; i++) {
    deep = path.join(deep, 'x');
    await fsp.mkdir(deep);
    await fsp.writeFile(path.join(deep, 'f.bin'), Buffer.alloc(10));
  }
  const md = await measure(path.join(mRoot, 'deep'));
  ok('a forty-level tree is descended to the bottom',
    md.files === 40 && md.bytes === 400 && md.dirs === 40,
    `${md.files} files, ${md.bytes} bytes, ${md.dirs} dirs`);
  await fsp.rm(mRoot, { recursive: true, force: true });

  // The limiter itself: order preserved, nothing dropped, cap respected.
  let liveNow = 0, peak = 0;
  const seen = await mapLimit([...Array(500).keys()], 8, async (n) => {
    liveNow++; peak = Math.max(peak, liveNow);
    await new Promise((r) => setTimeout(r, n % 3));
    liveNow--;
    return n * 2;
  });
  ok('mapLimit returns results in input order, none missing',
    seen.length === 500 && seen.every((v, i) => v === i * 2));
  ok('and never exceeds its concurrency limit', peak <= 8, `peak ${peak}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
