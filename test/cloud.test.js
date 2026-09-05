// Cloud sync folders, and the files in them that are not really on the disk.
//
// Three things are being defended here, and each has a cost if it breaks:
//
//   1. The measurement. NexaFiles says it shows what is on your disk. A
//      placeholder reports its full size and occupies nothing, so counting it
//      as disk usage makes that claim false.
//   2. The bandwidth. Hashing or describing a placeholder downloads it. Run
//      unguarded over a dehydrated cloud folder, a duplicate scan downloads
//      the whole account.
//   3. The data. Deleting a file inside a sync folder deletes it from the
//      cloud and every other signed-in device, which is not something the
//      recycle bin or quarantine can undo.

const fs = require('fs');
const os = require('os');
const path = require('path');

const cloud = require('../src/main/fs/cloud.js');
const { Index } = require('../src/main/db.js');
const { Plan, CATEGORY, ACTION, CONFIDENCE } = require('../src/main/safety/plan.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

/** A stats object shaped like the one fs returns. */
const stats = (size, blocks) => ({ size, blocks });
const PROVIDER = { provider: 'onedrive', label: 'OneDrive', path: 'C:\\Users\\HP\\OneDrive' };

console.log('\n-- what is measured, and what is inferred --');
// physicalBytes is a measurement and is always reported.
ok('a normal file reports its allocated blocks',
  cloud.describeStorage(stats(4096, 8), null).physicalBytes === 4096);
ok('a file outside a sync folder is never called a placeholder',
  cloud.describeStorage(stats(1_000_000, 0), null).placeholder === false);

// The inference needs BOTH conditions, because zero blocks alone is not proof.
const ph = cloud.describeStorage(stats(1_053_417, 0), PROVIDER);
ok('a large zero-block file inside a sync folder is a placeholder', ph.placeholder === true);
ok('and it says on what basis', /allocated no blocks/i.test(ph.basis || ''), ph.basis || '');
ok('the provider is recorded', ph.provider === 'onedrive');

// This is the false positive that a naive `blocks === 0` check would produce.
// NTFS keeps a small enough file inside its own MFT record, where it also
// reports zero blocks. desktop.ini on a real machine does exactly this.
const resident = cloud.describeStorage(stats(93, 0), PROVIDER);
ok('a tiny resident file is NOT called a placeholder', resident.placeholder === false,
  `${cloud.RESIDENT_CEILING} byte floor`);
ok('but its real footprint is still reported honestly', resident.physicalBytes === 0);

ok('a materialised file inside a sync folder is not a placeholder',
  cloud.describeStorage(stats(1_000_000, 1954), PROVIDER).placeholder === false);

// A platform that does not report blocks has not said the file is absent.
ok('an unmeasurable platform reports null, not a guessed zero',
  cloud.describeStorage({ size: 100 }, PROVIDER).physicalBytes === null);
ok('and makes no placeholder claim without a measurement',
  cloud.describeStorage({ size: 100 }, PROVIDER).placeholder === false);

console.log('\n-- a mounted virtual drive is not a folder of placeholders --');
//
// The bug this defends against was real and would have shipped. OneDrive's
// Files On-Demand leaves NTFS placeholders that allocate zero blocks, so "how
// much is here" is measurable. Google Drive's G: is a virtual filesystem whose
// driver reports FULL allocation for every file whether or not a byte is
// cached — a 28 MB video that has never been downloaded reports 54,649 blocks.
// Measured on the real drive. Trusting `blocks` there would report a streamed
// account as fully resident, which is the same overstatement this module
// exists to prevent, in the opposite direction.
const GDRIVE = { provider: 'googledrive', label: 'Google Drive (G:)',
  path: 'G:\\My Drive', virtualDrive: true };

const streamed = cloud.describeStorage(stats(27_979_921, 54_649), GDRIVE);
ok('a fully-allocated file on a virtual drive is not called resident',
  streamed.storageKnown === false && streamed.physicalBytes === null);
ok('it is marked as streamed rather than as a placeholder',
  streamed.streamed === true && streamed.placeholder === false);
ok('and it says why the figure is not knowable',
  /reports every one as fully allocated/i.test(streamed.basis || ''), streamed.basis || '');
// Both mean "reading this may download it", which is what the guards check.
ok('a streamed file still counts as one that would be downloaded',
  cloud.wouldDownload({ cloudStreamed: true }) === true);
ok('and so does a placeholder',
  cloud.wouldDownload({ cloudPlaceholder: true }) === true);
ok('an ordinary local file would not',
  cloud.wouldDownload({ cloudPlaceholder: false, cloudStreamed: false }) === false);
// The OneDrive path must be untouched by all of this.
ok('a real sync folder still measures its footprint',
  cloud.describeStorage(stats(1_053_417, 0), PROVIDER).storageKnown === true);

const mixed = cloud.summarise([
  { size: 1000, physicalSize: 1000, cloudPlaceholder: false, cloudStreamed: false },
  { size: 5000, physicalSize: 0, cloudPlaceholder: true, cloudStreamed: false },
  { size: 9000, physicalSize: null, cloudPlaceholder: false, cloudStreamed: true },
]);
// The streamed row belongs in neither total: adding its size asserts it is
// here, adding zero asserts it is not, and nobody measured either.
ok('a streamed file is left out of the on-disk total rather than guessed at',
  mixed.physicalBytes === 1000, String(mixed.physicalBytes));
ok('it is still counted in what the files report', mixed.logicalBytes === 15_000);
ok('and reported on its own line', mixed.streamed === 1 && mixed.streamedLogicalBytes === 9000);
ok('with the count of footprints that are simply unknown', mixed.unknownFootprint === 1);

console.log('\n-- containment --');
const m = cloud.makeMatcher([PROVIDER]);
ok('a file inside the sync folder matches',
  !!m.match('C:\\Users\\HP\\OneDrive\\CHEM.docx'));
ok('a file elsewhere does not',
  !m.match('C:\\Users\\HP\\Downloads\\picture.png'));
// "OneDriveTemp" must not count as being inside "OneDrive".
ok('a sibling folder with the same prefix does not match',
  !m.match('C:\\Users\\HP\\OneDriveTemp\\x.docx'));
ok('matching is case-insensitive on Windows',
  process.platform === 'linux' || !!m.match('c:\\users\\hp\\onedrive\\x.docx'));
ok('no providers means nothing matches', cloud.makeMatcher([]).match('C:\\anything') === null);

console.log('\n-- the two totals --');
const rows = [
  { size: 7_448_765, physicalSize: 0, cloudPlaceholder: true },
  { size: 1_140, physicalSize: 4_096, cloudPlaceholder: false },
  { size: 93, physicalSize: 0, cloudPlaceholder: false },
];
const s = cloud.summarise(rows);
ok('the logical total is what the files report', s.logicalBytes === 7_449_998);
ok('the physical total is what the disk holds', s.physicalBytes === 4_096);
ok('placeholders are counted', s.placeholders === 1);
// This is the figure that would otherwise be presented as reclaimable.
ok('and the bytes they claim but do not hold are separated out',
  s.placeholderLogicalBytes === 7_448_765);

console.log('\n-- content scans do not download the cloud --');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-cloud-'));
const index = new Index(path.join(work, 't.db')).open();
index.db.prepare(`INSERT INTO scans (id, root, status, startedAt) VALUES ('s1', ?, 'complete', 'x')`)
  .run('C:\\');
const ins = index.db.prepare(`
  INSERT INTO files (scanId,path,name,isDirectory,size,mtimeMs,extension,physicalSize,cloudProvider,cloudPlaceholder)
  VALUES (?,?,?,0,?,?,?,?,?,?)`);
// Two identical-size files, one local and one an online-only cloud copy.
ins.run('s1', 'C:\\local\\a.bin', 'a.bin', 5000, 1, 'bin', 5000, null, 0);
ins.run('s1', 'C:\\local\\b.bin', 'b.bin', 5000, 1, 'bin', 5000, null, 0);
ins.run('s1', 'C:\\Users\\HP\\OneDrive\\c.bin', 'c.bin', 5000, 1, 'bin', 0, 'onedrive', 1);
ins.run('s1', 'C:\\Users\\HP\\OneDrive\\pic.png', 'pic.png', 900000, 2, 'png', 0, 'onedrive', 1);
ins.run('s1', 'C:\\local\\pic.png', 'pic.png', 900000, 2, 'png', 900000, null, 0);

const members = index.filesOfSize('s1', 5000);
ok('a duplicate scan does not collect an online-only file',
  members.length === 2 && !members.some((r) => r.path.includes('OneDrive')),
  members.map((r) => path.basename(r.path)).join(','));
ok('but it will when explicitly asked to',
  index.filesOfSize('s1', 5000, { includeCloud: true }).length === 3);
ok('and it can say how many it left alone, and how much they weigh',
  index.placeholdersExcluded('s1').count === 2 &&
  index.placeholdersExcluded('s1').bytes === 905000);

const cands = index.describeCandidates('s1', { imageExts: ['png'] });
ok('describing does not send an online-only picture either',
  cands.length === 1 && !cands[0].path.includes('OneDrive'),
  cands.map((r) => r.path).join(','));

console.log('\n-- the plan says what a deletion really does --');
const info = index.cloudInfoForPath('s1', 'C:\\Users\\HP\\OneDrive\\pic.png');
ok('the scan can be asked about a path', info && info.cloudProvider === 'onedrive');
ok('and reports that it holds nothing locally', info.physicalBytes === 0);
ok('a path the scan never saw returns nothing, not a false all-clear',
  index.cloudInfoForPath('s1', 'C:\\never\\seen.txt') === null);

const plan = new Plan({ source: 'test' });
const cloudEntry = plan.add({
  path: 'C:\\Users\\HP\\OneDrive\\cache.tmp',
  action: ACTION.TRASH,
  bytes: 900000,
  reason: 'regenerable cache',
  evidence: 'It rebuilds itself.',
  category: CATEGORY.REGENERABLE,
  confidence: CONFIDENCE.HIGH,
  ...info,
});
const localEntry = plan.add({
  path: 'C:\\local\\cache.tmp',
  action: ACTION.TRASH,
  bytes: 900000,
  reason: 'regenerable cache',
  evidence: 'It rebuilds itself.',
  category: CATEGORY.REGENERABLE,
  confidence: CONFIDENCE.HIGH,
});

// The invariant that matters: an identical, equally-confident, equally
// regenerable file is pre-selected locally and never pre-selected in the cloud.
ok('an ordinary regenerable file is still pre-selected', localEntry.selected === true);
ok('the same file inside a sync folder is NOT pre-selected', cloudEntry.selected === false);
ok('and it carries the warning about what deletion means',
  /every other signed-in device/i.test(cloudEntry.cloudWarning || ''));
ok('the warning says it frees nothing locally when it is online-only',
  /frees nothing locally/i.test(cloudEntry.cloudWarning || ''));
ok('the entry records what it would actually free here',
  cloudEntry.physicalBytes === 0 && localEntry.physicalBytes === 900000);
// The user may still choose it deliberately; what is refused is doing it for them.
plan.setSelection([cloudEntry.id]);
ok('but the user can still select it themselves', cloudEntry.selected === true);

index.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
