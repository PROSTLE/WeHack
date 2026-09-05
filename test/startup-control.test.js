// Startup management and process protection, tested against fixed inputs so
// the result does not depend on what happens to be installed or running on the
// machine running the tests.
//
// Nothing here writes to the registry or ends a process. The writes are one
// PowerShell call each and are covered by using the application; what is worth
// pinning down is everything that decides *whether* a write happens — the
// parsing, the matching, and above all the refusals, because a mistake in
// those is the difference between switching off an updater and bugchecking
// somebody's machine.

const { executableFromCommand, attachImpact } = require('../src/main/scanners/startup.js');
const { describeControl, approvalValueName } = require('../src/main/system/startup-control.js');
const { classifyProcess } = require('../src/main/system/process-control.js');
const { groupByProgram } = require('../src/main/system/processes.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

console.log('\n-- reading the executable out of a Run value --');
// Installers write these four shapes, and splitting on whitespace gets three
// of them wrong because Program Files has a space in it.
ok('quoted path with arguments',
  executableFromCommand('"C:\\Program Files\\Foo\\foo.exe" --background') ===
  'C:\\Program Files\\Foo\\foo.exe');
ok('unquoted path with arguments, recovered by extension',
  executableFromCommand('C:\\Tools\\bar.exe /silent') === 'C:\\Tools\\bar.exe');
ok('bare path with no arguments',
  executableFromCommand('C:\\Tools\\baz.exe') === 'C:\\Tools\\baz.exe');
ok('unquoted path containing spaces and no arguments',
  executableFromCommand('C:\\Program Files\\Foo\\foo.exe') ===
  'C:\\Program Files\\Foo\\foo.exe');
ok('empty command yields nothing rather than a guess',
  executableFromCommand('') === null && executableFromCommand(null) === null);

console.log('\n-- charging each entry with what it is actually running --');
const items = [
  { name: 'Foo',      kind: 'registry-run', command: '"C:\\Apps\\foo.exe" --bg' },
  { name: 'Bar',      kind: 'registry-run', command: 'C:\\Apps\\bar.exe' },
  { name: 'SvcOne',   kind: 'service',      command: 'C:\\Windows\\svchost.exe -k net', pid: 700 },
  { name: 'SvcTwo',   kind: 'service',      command: 'C:\\Windows\\svchost.exe -k net', pid: 700 },
  { name: 'Absent',   kind: 'registry-run', command: 'C:\\Apps\\gone.exe' },
];
const procs = [
  { pid: 100, name: 'foo', rssBytes: 50, execPath: 'C:\\Apps\\foo.exe' },
  { pid: 101, name: 'foo', rssBytes: 70, execPath: 'C:\\Apps\\foo.exe' },
  { pid: 200, name: 'bar', rssBytes: 30, execPath: 'C:\\Apps\\bar.exe' },
  { pid: 700, name: 'svchost', rssBytes: 900, execPath: 'C:\\Windows\\svchost.exe' },
];
const impact = attachImpact(items, procs);
const byName = Object.fromEntries(items.map((i) => [i.name, i]));

ok('an entry with two processes is charged both',
  byName.Foo.runningNow && byName.Foo.processCount === 2 && byName.Foo.rssBytes === 120);
ok('an entry with one process is charged one',
  byName.Bar.runningNow && byName.Bar.rssBytes === 30);
ok('a service is matched by its recorded pid, not by name',
  byName.SvcOne.runningNow && byName.SvcOne.rssBytes === 900);
ok('an entry with nothing running reports not-running, not zero cost',
  byName.Absent.runningNow === false && byName.Absent.processCount === 0);
ok('entries sharing one process are marked as sharing it',
  byName.SvcOne.sharesProcess === true && byName.SvcTwo.sharesProcess === true);
ok('an entry with its own processes is not marked as sharing',
  byName.Foo.sharesProcess === false);
// The whole point of the marking: two services in one svchost are 900 bytes
// between them, not 1800. A total that double-counted would overstate what
// switching things off could possibly recover.
ok('the total counts each process once however many entries claim it',
  impact.totalRssBytes === 50 + 70 + 30 + 900, String(impact.totalRssBytes));
ok('the total counts distinct processes, not entries',
  impact.distinctProcesses === 4 && impact.runningCount === 4,
  `${impact.distinctProcesses} processes, ${impact.runningCount} entries`);

console.log('\n-- where an item\'s on/off switch lives --');
const winOpts = { elevated: false };
const runItem = { kind: 'registry-run', name: 'Foo', source: 'HKCU Run', location: 'HKCU:\\...' };
const hklmItem = { kind: 'registry-run', name: 'Foo', source: 'HKLM Run', location: 'HKLM:\\...' };
const onceItem = { kind: 'registry-run', name: 'Foo', source: 'HKCU RunOnce', location: 'HKCU:\\...' };
const folder = { kind: 'startup-folder', name: 'Foo', source: 'User Startup folder',
  command: 'C:\\Users\\x\\Start Menu\\Startup\\Foo.lnk' };

if (process.platform === 'win32') {
  ok('a per-user Run entry can be switched off without administrator',
    describeControl(runItem, winOpts).toggleable === true);
  ok('a machine-wide Run entry cannot, and says why',
    describeControl(hklmItem, winOpts).toggleable === false &&
    /administrator/i.test(describeControl(hklmItem, winOpts).note));
  ok('the same machine-wide entry can when elevated',
    describeControl(hklmItem, { elevated: true }).toggleable === true);
  ok('a RunOnce entry is refused, because it deletes itself anyway',
    describeControl(onceItem, winOpts).toggleable === false &&
    describeControl(onceItem, winOpts).method === null);
  ok('a scheduled task can be disabled without elevation',
    describeControl({ kind: 'scheduled-task', name: 'T', source: 'Scheduled task (at logon)' },
      winOpts).method === 'scheduled-task');
  ok('a service is refused unelevated and flagged as needing administrator',
    describeControl({ kind: 'service', name: 'S', source: 'Service (automatic start)' },
      winOpts).toggleable === false &&
    describeControl({ kind: 'service', name: 'S', source: 'Service (automatic start)' },
      winOpts).needsAdmin === true);
  ok('an unknown kind is refused rather than guessed at',
    describeControl({ kind: 'something-new', name: 'X', source: 'Nowhere' }, winOpts)
      .method === null);
} else {
  ok('on a non-Windows host, Run entries are reported as unchangeable',
    describeControl(runItem, winOpts).method === null);
  ok('a Linux autostart entry is switched off by hiding it',
    describeControl({ kind: 'autostart-desktop', name: 'X', source: 'User autostart' },
      winOpts).method === 'desktop-hidden');
}

// Explorer files a Startup-folder item under its file name, extension and all.
// Getting this wrong writes an approval byte nothing ever reads, and the item
// keeps starting while the interface claims it is off.
ok('a Run value is filed under its own name',
  approvalValueName(runItem) === 'Foo');
ok('a startup-folder item is filed under its file name, extension included',
  approvalValueName(folder) === 'Foo.lnk');

console.log('\n-- what may be closed, and what may not --');
const crit = classifyProcess({ pid: 900, name: 'csrss.exe' });
ok('a process Windows needs is refused, not merely warned about',
  crit.closable === false && crit.severity === 'critical');
ok('the refusal says what would happen',
  /stops the machine/i.test(crit.reason), crit.reason);
ok('the .exe suffix does not evade the protection',
  classifyProcess({ pid: 1, name: 'lsass.exe' }).closable === false &&
  classifyProcess({ pid: 1, name: 'lsass' }).closable === false);
ok('pid 4 and pid 0 are refused whatever they are called',
  classifyProcess({ pid: 4, name: 'anything' }).closable === false &&
  classifyProcess({ pid: 0, name: 'anything' }).closable === false);

// NexaFiles is one main process and several renderers under a single name. A
// check that looked only at the first pid in the group would happily offer to
// close the group its own main process is sitting in.
const selfGroup = classifyProcess({ pid: 12345, pids: [12345, process.pid], name: 'electron' });
ok('a program group containing NexaFiles itself is refused',
  selfGroup.closable === false && /NexaFiles itself/.test(selfGroup.reason));
ok('the same name without our pid in it is closable',
  classifyProcess({ pid: 12345, pids: [12345, 12346], name: 'electron' }).closable === true);

const sec = classifyProcess({ pid: 5, name: 'MsMpEng.exe' });
ok('security software is refused rather than offered',
  sec.closable === false && sec.severity === 'security');
ok('the refusal explains itself instead of just greying out',
  /security software/i.test(sec.reason) && sec.reason.length > 60);

const heavy = classifyProcess({ pid: 6, name: 'explorer.exe' });
ok('the desktop is closable but carries its warning',
  heavy.closable === true && heavy.severity === 'heavy' &&
  /taskbar/i.test(heavy.reason));

const normal = classifyProcess({ pid: 7, name: 'chrome.exe' });
ok('an ordinary program is closable',
  normal.closable === true && normal.severity === 'normal');
ok('even an ordinary program states the cost of closing it',
  /not saved will be lost/i.test(normal.reason));

console.log('\n-- one row per program, not per process --');
const grouped = groupByProgram([
  { pid: 1, name: 'chrome', rssBytes: 100, execPath: 'C:\\c\\chrome.exe' },
  { pid: 2, name: 'chrome', rssBytes: 200, execPath: 'C:\\c\\chrome.exe' },
  { pid: 3, name: 'notepad', rssBytes: 10, execPath: null },
], [{ pid: 1, name: 'chrome', cpuPercent: 4 }]);

ok('processes of one program collapse into one row',
  grouped.length === 2 && grouped[0].name === 'chrome' && grouped[0].processCount === 2);
ok('the row carries the total memory and every pid',
  grouped[0].rssBytes === 300 && grouped[0].pids.length === 2);
ok('rows are ordered by what they cost',
  grouped[0].rssBytes >= grouped[1].rssBytes);
ok('CPU is summed only over members that were actually sampled',
  grouped[0].cpuPercent === 4);
// "Not measured" and "using no CPU" are different answers and must not be
// flattened into the same zero.
ok('a program with no sampled member reports null CPU, not zero',
  grouped[1].cpuPercent === null);
ok('a program whose path is unreadable still appears',
  grouped[1].name === 'notepad' && grouped[1].execPath === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
