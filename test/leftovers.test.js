// Leftover-matching and classification logic, tested against fixed inputs so
// the result does not depend on what happens to be installed on the machine.
const path = require('path');
const {
  matchAgainstInstalled, classifyLeftover, leftoversToPlanEntries, SHARED_OR_SYSTEM,
} = require('../src/main/scanners/leftovers.js');
const { Plan, CATEGORY, ACTION, CONFIDENCE } = require('../src/main/safety/plan.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

const installed = [
  { name: 'Mozilla Firefox (x64 en-US)', publisher: 'Mozilla', location: 'C:\\Program Files\\Mozilla Firefox' },
  { name: 'Slack', publisher: 'Slack Technologies', location: '' },
  { name: 'Visual Studio Code', publisher: 'Microsoft Corporation', location: '' },
  { name: 'Docker Desktop', publisher: 'Docker Inc.', location: '' },
  { name: 'Xcode', publisher: 'Apple', location: '/Applications/Xcode.app', bundleId: 'com.apple.dt.Xcode' },
];
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const indexes = { byName: new Map(), byPublisher: new Map(), byBundle: new Map() };
for (const a of installed) {
  indexes.byName.set(norm(a.name), a);
  if (a.publisher) indexes.byPublisher.set(norm(a.publisher), a);
  if (a.bundleId) indexes.byBundle.set(a.bundleId, a);
}
const match = (n) => matchAgainstInstalled(n, installed, indexes);

console.log('\n-- matching: installed applications must NOT be flagged --');
ok('exact name matches', match('Slack').matched);
ok('publisher name matches', match('Mozilla').matched);
ok('name variant matches by containment', match('SlackHelper').matched);
ok('shortened name matches', match('Code').matched === true);
ok('bundle identifier matches', match('com.apple.dt.Xcode').matched);
ok('bundle sub-identifier matches parent',
  match('com.apple.dt.Xcode.Helper').matched);
ok('publisher with punctuation matches', match('Docker Inc').matched);

console.log('\n-- matching: genuinely unknown names ARE flagged --');
ok('unrelated vendor is unmatched', match('AcmeWidgets').matched === false);
ok('random string is unmatched', match('zzqqxx').matched === false);

console.log('\n-- the exclusion list protects install roots and OS components --');
for (const dangerous of ['Programs', 'Windows', 'Microsoft', 'WindowsApps',
                         'USOShared', 'USOPrivate', 'wsl', 'Packages', 'Temp']) {
  ok(`"${dangerous}" is excluded from analysis entirely`,
    SHARED_OR_SYSTEM.has(dangerous.toLowerCase()));
}

console.log('\n-- regenerable vs user data --');
const c = (n, p = 'C:\\Users\\x\\AppData\\Local') => classifyLeftover(n, path.join(p, n));
ok('a cache folder is regenerable', c('SomeAppCache').category === 'regenerable');
ok('a logs folder is regenerable', c('Logs').category === 'regenerable');
ok('crash reports are regenerable', c('CrashReports').category === 'regenerable');
ok('saved games are user data', c('SaveGames').category === 'user-data');
ok('licences are user data', c('Licenses').category === 'user-data');
ok('an unrecognised name defaults to user data (cautious)',
  c('Wibble').category === 'user-data');
ok('a cache INSIDE a profile folder is treated as user data',
  classifyLeftover('Cache', 'C:\\Users\\x\\AppData\\Roaming\\App\\Profiles\\Cache').category === 'user-data');

console.log('\n-- plan entries --');
const findings = [
  {
    path: 'C:\\Users\\x\\AppData\\Local\\AcmeCache', name: 'AcmeCache',
    bytes: 500000, fileCount: 12, category: 'regenerable', confidence: 'medium',
    reason: 'No installed application corresponds to "AcmeCache", unused for 200 days',
    evidence: 'No entry named "AcmeCache" was found among 186 applications. Nothing has written to it in 200 days.',
  },
  {
    path: 'C:\\Users\\x\\AppData\\Roaming\\AcmeSaves', name: 'AcmeSaves',
    bytes: 900000, fileCount: 40, category: 'user-data', confidence: 'low',
    reason: 'No installed application corresponds to "AcmeSaves", unused for 400 days',
    evidence: 'No entry named "AcmeSaves" was found. Nothing has written to it in 400 days.',
  },
];
const specs = leftoversToPlanEntries(findings, { ACTION, CATEGORY, CONFIDENCE });
const plan = new Plan({ source: 'leftovers' });
const entries = specs.map((s) => plan.add(s));

ok('leftovers are quarantined, not trashed',
  entries.every((e) => e.action === ACTION.QUARANTINE));
ok('regenerable leftover is pre-selected', entries[0].selected === true);
ok('user-data leftover is NOT pre-selected', entries[1].selected === false);
ok('every entry carries its evidence',
  entries.every((e) => typeof e.evidence === 'string' && e.evidence.length > 30));
ok('evidence states how long the folder has been idle',
  entries.every((e) => /\d+ days/.test(e.evidence)));
ok('no entry claims high confidence',
  entries.every((e) => e.confidence !== CONFIDENCE.HIGH));
ok('totals separate user data from regenerable',
  plan.totals().userData.bytes === 900000 && plan.totals().regenerable.bytes === 500000);
ok('only the regenerable bytes are pre-selected',
  plan.totals().selectedBytes === 500000, `${plan.totals().selectedBytes}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
