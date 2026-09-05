// Safety-pipeline tests: plan invariants, approval gating, and execution.
// Uses a fake trash so the test does not depend on Electron's shell.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { Plan, CATEGORY, ACTION, CONFIDENCE } = require('../src/main/safety/plan.js');
const { createExecutor } = require('../src/main/safety/execute.js');
const { Quarantine } = require('../src/main/safety/quarantine.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}
function throws(name, fn, match) {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  ok(name, msg !== null && (!match || msg.includes(match)), msg ? `<- ${msg.slice(0, 60)}` : '(did not throw)');
}

(async () => {
  console.log('\n-- plan invariants --');
  const p = new Plan({ source: 'test', title: 'Test plan' });

  throws('entry without evidence is rejected',
    () => p.add({ path: 'x', action: ACTION.TRASH, bytes: 1, reason: 'r', category: CATEGORY.REGENERABLE }),
    'evidence');
  throws('entry without a measured size is rejected',
    () => p.add({ path: 'x', action: ACTION.TRASH, reason: 'r', evidence: 'e', category: CATEGORY.REGENERABLE }),
    'measured byte size');
  throws('estimated (non-numeric) size is rejected',
    () => p.add({ path: 'x', action: ACTION.TRASH, bytes: '~2 MB', reason: 'r', evidence: 'e', category: CATEGORY.REGENERABLE }),
    'measured byte size');
  throws('unknown category is rejected',
    () => p.add({ path: 'x', action: ACTION.TRASH, bytes: 1, reason: 'r', evidence: 'e', category: 'junk' }),
    'Unknown category');

  const regen = p.add({
    path: path.join(os.tmpdir(), 'a'), action: ACTION.TRASH, bytes: 100,
    reason: 'cache', evidence: 'no matching install', category: CATEGORY.REGENERABLE,
    confidence: CONFIDENCE.HIGH,
  });
  ok('regenerable entry is pre-selected', regen.selected === true);

  const ud = p.add({
    path: path.join(os.tmpdir(), 'b'), action: ACTION.QUARANTINE, bytes: 200,
    reason: 'licence file', evidence: 'bundle id unresolved', category: CATEGORY.USER_DATA,
    confidence: CONFIDENCE.HIGH, selected: true,   // producer asks for it...
  });
  ok('user-data is NEVER pre-selected, even when requested', ud.selected === false);

  const low = p.add({
    path: path.join(os.tmpdir(), 'c'), action: ACTION.TRASH, bytes: 50,
    reason: 'maybe stale', evidence: 'heuristic only', category: CATEGORY.REGENERABLE,
    confidence: CONFIDENCE.LOW,
  });
  ok('low-confidence entry is not pre-selected', low.selected === false);

  const t = p.totals();
  ok('totals sum measured bytes', t.bytes === 350, `${t.bytes}`);
  ok('selected totals count only selected', t.selectedBytes === 100, `${t.selectedBytes}`);
  ok('user data is reported separately', t.userData.count === 1 && t.userData.bytes === 200);
  ok('grouped() separates user data', p.grouped().userData.length === 1);

  console.log('\n-- approval gating --');
  const qDir = path.join(os.tmpdir(), 'nexafiles-pipe-q');
  const workDir = path.join(os.tmpdir(), 'nexafiles-pipe-work');
  await fsp.rm(qDir, { recursive: true, force: true });
  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(workDir, { recursive: true });
  const q = await new Quarantine(qDir).init();

  const trashed = [];
  const exec = createExecutor({
    assertInsideRoot: (pp) => {
      const r = path.resolve(pp);
      if (!r.toLowerCase().startsWith(workDir.toLowerCase())) {
        throw new Error('outside approved root');
      }
      if (!fs.existsSync(r)) throw new Error('does not exist');
      return r;
    },
    trashItem: async (pp) => { trashed.push(pp); await fsp.rm(pp, { recursive: true, force: true }); },
    quarantine: q,
    pathsInUse: async () => ({ checked: true, inUse: [] }),
  });

  let refused = null;
  try { await exec.execute(p); } catch (e) { refused = e.message; }
  ok('executing an unapproved plan is refused', refused && refused.includes('not been approved'));
  ok('nothing was trashed by the refused run', trashed.length === 0);

  console.log('\n-- execution --');
  const realPlan = new Plan({ source: 'test' });
  const fileA = path.join(workDir, 'cache.dat');
  const fileB = path.join(workDir, 'support-dir');
  const fileC = path.join(workDir, 'keepme.txt');
  await fsp.writeFile(fileA, 'A'.repeat(1000));
  await fsp.mkdir(fileB, { recursive: true });
  await fsp.writeFile(path.join(fileB, 'x.log'), 'B'.repeat(500));
  await fsp.writeFile(fileC, 'keep');

  realPlan.add({ path: fileA, action: ACTION.TRASH, bytes: 1000, reason: 'stale cache',
    evidence: 'not read in 400 days', category: CATEGORY.REGENERABLE, confidence: CONFIDENCE.HIGH });
  realPlan.add({ path: fileB, action: ACTION.QUARANTINE, bytes: 500, reason: 'orphaned support dir',
    evidence: 'no uninstall entry for publisher', category: CATEGORY.REGENERABLE, confidence: CONFIDENCE.HIGH });
  const keeper = realPlan.add({ path: fileC, action: ACTION.TRASH, bytes: 4, reason: 'user doc',
    evidence: 'in documents folder', category: CATEGORY.USER_DATA, confidence: CONFIDENCE.HIGH });

  realPlan.approve();
  const out = await exec.execute(realPlan);

  ok('selected file was trashed', out.summary.trashed === 1 && !fs.existsSync(fileA));
  ok('selected dir was quarantined', out.summary.quarantined === 1 && !fs.existsSync(fileB));
  ok('UNSELECTED user-data file untouched', fs.existsSync(fileC));
  ok('bytes reclaimed are the measured bytes', out.summary.bytesReclaimed === 1500, `${out.summary.bytesReclaimed}`);
  ok('execution notes state the in-use check scope',
    out.notes.some((n) => n.includes('open handle')));

  console.log('\n-- restore after execution --');
  const qEntry = q.list()[0];
  ok('quarantine holds the executed item', !!qEntry && qEntry.name === 'support-dir');
  ok('quarantine entry kept its evidence', qEntry.evidence.includes('uninstall entry'));
  await q.restore(qEntry.id);
  ok('restore puts the directory back', fs.existsSync(path.join(fileB, 'x.log')));

  console.log('\n-- in-use blocking --');
  const busyPlan = new Plan({ source: 'test' });
  const busy = path.join(workDir, 'busy.exe');
  await fsp.writeFile(busy, 'x');
  busyPlan.add({ path: busy, action: ACTION.TRASH, bytes: 1, reason: 'leftover',
    evidence: 'no install record', category: CATEGORY.REGENERABLE, confidence: CONFIDENCE.HIGH });
  busyPlan.approve();
  const busyExec = createExecutor({
    assertInsideRoot: (pp) => path.resolve(pp),
    trashItem: async () => { throw new Error('should not be called'); },
    quarantine: q,
    pathsInUse: async () => ({ checked: true, inUse: [{ path: busy, pid: 999, process: 'busy' }] }),
  });
  const busyOut = await busyExec.execute(busyPlan);
  ok('file in use is skipped, not deleted', busyOut.summary.skipped === 1 && fs.existsSync(busy));
  ok('skip explains which process holds it', busyOut.results[0].detail.includes('pid 999'));

  const failExec = createExecutor({
    assertInsideRoot: (pp) => path.resolve(pp),
    trashItem: async () => {},
    quarantine: q,
    pathsInUse: async () => ({ checked: false, error: 'enumeration blocked', inUse: [] }),
  });
  let hardFail = null;
  try { await failExec.execute(busyPlan); } catch (e) { hardFail = e.message; }
  ok('unverifiable in-use state aborts rather than assuming safe',
    hardFail && hardFail.includes('Refusing to execute'));

  console.log('\n-- root re-validation at execute time --');
  const escapePlan = new Plan({ source: 'test' });
  escapePlan.add({ path: path.join(os.tmpdir(), 'elsewhere.txt'), action: ACTION.TRASH, bytes: 1,
    reason: 'x', evidence: 'y', category: CATEGORY.REGENERABLE, confidence: CONFIDENCE.HIGH });
  escapePlan.approve();
  const escapeOut = await exec.execute(escapePlan);
  ok('path outside approved root fails at execution', escapeOut.summary.failed === 1);
  ok('failure names the reason', escapeOut.results[0].detail.includes('outside approved root'));

  await fsp.rm(qDir, { recursive: true, force: true });
  await fsp.rm(workDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
