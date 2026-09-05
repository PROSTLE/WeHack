// Diagnostic: runs the leftover scanner on this machine with the same
// corroborating signals the app uses, and prints every finding.
const { findLeftovers } = require('../../src/main/scanners/leftovers.js');
const { listProcesses } = require('../../src/main/system/processes.js');

(async () => {
  const t0 = Date.now();
  const { findings, notes, stats } = await findLeftovers({ listProcesses });
  console.log('stats:', JSON.stringify(stats));
  console.log('elapsed:', Date.now() - t0, 'ms');
  const total = findings.reduce((n, f) => n + f.bytes, 0);
  console.log('findings: ' + findings.length + ', ' + (total / 1073741824).toFixed(2) + ' GB');
  console.log('  regenerable: ' + findings.filter(f => f.category === 'regenerable').length);
  console.log('  user-data  : ' + findings.filter(f => f.category === 'user-data').length);
  console.log('');
  for (const f of findings.slice(0, 25)) {
    const mb = (f.bytes / 1048576).toFixed(1).padStart(9);
    console.log('  ' + mb + ' MB  [' + f.category + '/' + f.confidence + '/' + f.kind + ']  idle ' +
      String(f.daysIdle).padStart(4) + 'd  ' + f.location + '  ' + f.name);
  }
  console.log('');
  notes.forEach(n => console.log('  - ' + n));
})();
