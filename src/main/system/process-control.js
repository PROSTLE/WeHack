'use strict';
// Ending a running process.
//
// This is the one operation in NexaFiles with no undo. A file goes to the trash
// or to quarantine and comes back; a process that is closed is gone, along with
// whatever it had not yet saved. So the rules here are stricter than anywhere
// else in the application:
//
//   1. A process the operating system needs is refused outright, not warned
//      about. Ending csrss.exe or lsass.exe bugchecks Windows immediately, and
//      no confirmation dialog makes that a reasonable thing to offer.
//   2. NexaFiles will not end itself, or the shell it is drawn on.
//   3. Everything else is allowed, and every one of them is told to close
//      politely first. A window that is asked to close can save its work and
//      put up its own "you have unsaved changes" prompt; a process that is
//      terminated cannot. Termination is the fallback, not the first move.
//
// The classification below is by executable name because that is what the
// operating system's own protection is keyed on, and because a renamed copy of
// csrss.exe somewhere else on disk is not the real one and must not inherit its
// protection. Refusing by name over-protects slightly. That is the correct
// direction to be wrong in.

const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

const IS_WIN = process.platform === 'win32';

// Ending any of these either bugchecks Windows or leaves the session unusable.
const CRITICAL = new Set([
  'system', 'system idle process', 'registry', 'memory compression',
  'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsm',
  'svchost', 'fontdrvhost', 'dwm', 'sihost', 'wudfhost', 'audiodg',
  'securityhealthservice', 'trustedinstaller',
  // POSIX
  'init', 'systemd', 'launchd', 'kernel_task', 'kthreadd', 'windowserver', 'loginwindow',
]);

// Ending these is survivable but takes the desktop or a signed-in session with
// it, so they are allowed only with the warning attached.
const HEAVY = new Map([
  ['explorer', 'This is the Windows desktop, taskbar and Start menu. Closing it ' +
    'makes them disappear until Windows restarts it, which it usually does ' +
    'within a few seconds. Open files are not affected.'],
  ['ctfmon', 'This runs keyboard input, language switching and touch keyboards. ' +
    'Closing it can stop text input in some applications until you sign in again.'],
  ['finder', 'This is the macOS desktop and file windows. It relaunches itself.'],
]);

// Antimalware engines. Windows protects most of these at the kernel level and
// the close would fail anyway, but "it would fail anyway" is not a reason to
// put a Close button next to your virus scanner and let someone find out by
// pressing it. A utility that offers to switch off the machine's protection as
// though it were one more memory hog is a utility with the wrong idea about
// what it is for, so these are refused by name and the reason says so.
const SECURITY = new Set([
  'msmpeng', 'nissrv', 'securityhealthservice', 'securityhealthsystray',
  'mssense', 'sensecncproxy', 'windefend', 'msascuil',
  'avp', 'avgnt', 'avguard', 'mcshield', 'ekrn', 'bdagent', 'vsserv',
  'nortonsecurity', 'ns', 'avastsvc', 'avgsvc', 'sophosfs', 'sophoshealth',
  'cbdefense', 'csfalconservice', 'sentinelagent', 'xagt',
]);

/** The name a protection rule is matched on. */
function baseName(name) {
  return String(name || '').replace(/\.(exe|com)$/i, '').trim().toLowerCase();
}

/**
 * Says whether one process — or a whole group of them — may be closed, before
 * anything is attempted.
 *
 * Takes `pids` as well as `pid` because the running list groups by program, and
 * an Electron application is one main process and a dozen renderers under a
 * single name. NexaFiles is itself such an application: checking only the first
 * pid in the group would let it offer to close a group that its own main
 * process is sitting in, and the button would work.
 *
 * Returned as data so the interface can grey out what it must not offer rather
 * than offering it and reporting a refusal afterwards.
 */
function classifyProcess(proc) {
  const key = baseName(proc.name);
  const pids = Array.isArray(proc.pids) && proc.pids.length
    ? proc.pids
    : [proc.pid];

  if (pids.includes(process.pid) || pids.includes(process.ppid)) {
    return {
      closable: false,
      severity: 'critical',
      reason: 'This is NexaFiles itself. Close it from its own window — closing ' +
        'it from in here would end this list along with everything on it.',
    };
  }

  if (pids.some((p) => p === 0 || p === 4)) {
    return {
      closable: false,
      severity: 'critical',
      reason: 'This is an operating-system process with no user-space existence.',
    };
  }

  if (SECURITY.has(key)) {
    return {
      closable: false,
      severity: 'security',
      reason: `${proc.name} is security software. NexaFiles will not offer to ` +
        'close it: freeing a few hundred megabytes is not worth leaving the ' +
        'machine unprotected, and Windows would refuse in any case. Turn it off ' +
        'through its own settings if that is really what you want.',
    };
  }

  if (CRITICAL.has(key)) {
    return {
      closable: false,
      severity: 'critical',
      reason: `${proc.name} is part of Windows itself. Ending it stops the ` +
        'machine immediately, so NexaFiles will not offer to do it.',
    };
  }

  if (HEAVY.has(key)) {
    return { closable: true, severity: 'heavy', reason: HEAVY.get(key) };
  }

  return {
    closable: true,
    severity: 'normal',
    reason: 'Anything this process has not saved will be lost. NexaFiles asks ' +
      'it to close first, so a program with unsaved work can put up its own ' +
      'prompt before anything is discarded.',
  };
}

/**
 * Closes one process.
 *
 * Asks first, insists second. `taskkill` without /F posts WM_CLOSE to the
 * process's windows, which is the same thing clicking the X does — the program
 * gets to save, and gets to refuse. Only if it is still there afterwards is it
 * terminated, and only when the caller asked for that.
 *
 * @param {{pid: number, name: string}} proc
 * @param {{force?: boolean, graceMs?: number}} opts
 */
async function endProcess(proc, { force = true, graceMs = 2500 } = {}) {
  const verdict = classifyProcess(proc);
  if (!verdict.closable) {
    const err = new Error(verdict.reason);
    err.code = 'PROTECTED';
    throw err;
  }

  const pid = Number(proc.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('That is not a process id.');

  const asked = await requestClose(pid);
  if (asked.gone) {
    return { pid, name: proc.name, method: 'closed', forced: false,
      detail: `${proc.name} closed when asked.` };
  }

  await new Promise((r) => setTimeout(r, graceMs));
  if (!(await isRunning(pid))) {
    return { pid, name: proc.name, method: 'closed', forced: false,
      detail: `${proc.name} closed when asked.` };
  }

  if (!force) {
    return { pid, name: proc.name, method: 'refused', forced: false,
      detail: `${proc.name} was asked to close and did not. It may be showing a ` +
        'prompt of its own, or it may have no window to close.' };
  }

  await terminate(pid);
  if (await isRunning(pid)) {
    throw new Error(
      `${proc.name} could not be closed. It is most likely running as another ` +
      'user or with higher rights than NexaFiles has.');
  }
  return { pid, name: proc.name, method: 'terminated', forced: true,
    detail: `${proc.name} did not respond to a close request and was terminated. ` +
      'Unsaved work in it is gone.' };
}

async function requestClose(pid) {
  if (IS_WIN) {
    try {
      await execFileP('taskkill.exe', ['/PID', String(pid)], { windowsHide: true, timeout: 10000 });
      return { gone: !(await isRunning(pid)) };
    } catch {
      // taskkill exits non-zero when the process has no window to close, which
      // is not a failure — it just means the polite route was unavailable.
      return { gone: false };
    }
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone, or not ours */ }
  return { gone: !(await isRunning(pid)) };
}

async function terminate(pid) {
  if (IS_WIN) {
    await execFileP('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 10000 });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

async function isRunning(pid) {
  if (IS_WIN) {
    try {
      const { stdout } = await execFileP(
        'tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        { windowsHide: true, timeout: 10000 });
      return /^"/.test(stdout.trim());
    } catch {
      return false;
    }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

module.exports = { classifyProcess, endProcess, CRITICAL, HEAVY, SECURITY };
