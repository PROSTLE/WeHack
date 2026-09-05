// Runs every test suite. Electron-hosted suites are run under Electron because
// they exercise APIs (nativeImage, node:sqlite in the packaged runtime) that
// only exist there.
const { spawnSync } = require('child_process');
const path = require('path');

const NODE_SUITES = [
  ['path validation', 'roots.test.js'],
  ['database upgrade from v1', 'migration.test.js'],
  ['cross-volume move (EXDEV)', 'exdev.test.js'],
  ['quarantine round trip', 'quarantine.test.js'],
  ['safety pipeline', 'pipeline.test.js'],
  ['scan and index', 'scan.test.js'],
  ['duplicates (tiers 1 and 3)', 'duplicates.test.js'],
  ['leftover matching', 'leftovers.test.js'],
  ['persisted settings', 'settings.test.js'],
  ['Windows hidden and system attributes', 'attributes.test.js'],
  ['document text extraction', 'extract.test.js'],
  ['files dropped on the assistant', 'attachments.test.js'],
  ['spoken input to the assistant', 'voice.test.js'],
  ['video sub-clip detection', 'video.test.js'],
  ['document and video duplicates', 'content-dupes.test.js'],
  // Drives whichever office suite is installed. Skips itself, loudly, on a
  // machine that has none rather than reporting a pass it did not earn.
  ['document conversion to PDF', 'convert.test.js'],
];

const ELECTRON_SUITES = [
  ['electron runtime capabilities', 'electron-probe.js'],
  ['perceptual image hashing (tier 2)', 'images.electron.js'],
  // Drives the real application through the whole destructive path via the same
  // bridge the interface uses: scan, find, plan, approve, execute, verify.
  ['end-to-end through the running app', path.join('tools', 'e2e.js')],
  // Drives the Files view through the same bridge the interface uses: list,
  // navigate, create, copy, move, trash, and the refusal shown for a location
  // the user has not approved.
  ['the Files view, end to end', path.join('tools', 'e2e-files.js')],
  ['settings, end to end', path.join('tools', 'e2e-settings.js')],
  // Conversion through the bridge: destination shown before writing, source left
  // intact, no silent overwrite, and the protected-path guard still holding.
  ['conversion, end to end', path.join('tools', 'e2e-convert.js')],
  // Walks every view and asks Chromium whether each control the user can see
  // actually has a listener bound to it. Nothing in this interface is inert.
  ['every control in the interface', path.join('tools', 'e2e-ui-audit.js')],
];

const results = [];

function run(label, cmd, args, env) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    shell: false,
  });
  results.push({ label, code: r.status });
  return r.status === 0;
}

for (const [label, file] of NODE_SUITES) {
  run(label, process.execPath, ['--no-warnings', path.join('test', file)]);
}

const electronBin = require('electron');
const electronEnv = { ...process.env };
delete electronEnv.ELECTRON_RUN_AS_NODE;   // otherwise Electron starts in Node mode
// The application refuses to run twice at once. A suite must not be defeated by
// an instance orphaned from an earlier one, so the suites opt out of that lock.
electronEnv.NEXAFILES_ALLOW_MULTIPLE = '1';
for (const [label, file] of ELECTRON_SUITES) {
  run(label, electronBin, [path.join('test', file)], { ELECTRON_RUN_AS_NODE: undefined, ...electronEnv });
}

console.log('\n================ summary ================');
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${r.label}${ok ? '' : `  (exit ${r.code})`}`);
}
console.log(`\n${results.length - failed} of ${results.length} suites passed.\n`);
process.exit(failed ? 1 : 0);
