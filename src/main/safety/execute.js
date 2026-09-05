'use strict';
// Stage 4 of the safety pipeline: execution.
//
// This is the only code in the application that removes anything. It refuses to
// run on a plan that has not been approved, re-validates every path against the
// approved roots even though the producing scanner already did, and checks for
// running processes before touching anything.
//
// Re-validating is deliberate duplication. The scanner that built the plan and
// the code that executes it are separated by an IPC boundary and a user
// interaction, and a plan is a plain object that crossed that boundary.

const path = require('path');
const { ACTION } = require('./plan');

/**
 * @param {object} deps injected so this is testable without Electron
 * @param {(p:string)=>string} deps.assertInsideRoot throws if outside approved roots
 * @param {(p:string)=>Promise<void>} deps.trashItem   shell.trashItem
 * @param {object} deps.quarantine                     Quarantine instance
 * @param {(paths:string[])=>Promise<object>} deps.pathsInUse
 */
function createExecutor({ assertInsideRoot, trashItem, quarantine, pathsInUse }) {
  /**
   * Runs the selected entries of an approved plan.
   * @param {Plan} plan
   * @param {(progress:object)=>void} onProgress
   */
  async function execute(plan, onProgress = () => {}) {
    if (!plan || !plan.approved) {
      throw new Error(
        'Refusing to execute a plan that has not been approved. ' +
        'Every removal passes through plan, preview, and explicit approval.'
      );
    }

    const targets = plan.selectedEntries();
    if (targets.length === 0) {
      return { results: [], summary: emptySummary(), notes: ['Nothing was selected.'] };
    }

    const notes = [];

    // --- pre-flight: running processes -------------------------------------
    const usage = await pathsInUse(targets.map((e) => e.path));
    const blockedPaths = new Map();
    if (!usage.checked) {
      // Could not enumerate. Do not proceed as if that meant "nothing is running".
      throw new Error(
        `Cannot verify whether these files are in use (${usage.error}). ` +
        `Refusing to execute rather than risk removing files from a running application.`
      );
    }
    for (const u of usage.inUse) {
      blockedPaths.set(path.resolve(u.path), u);
    }
    if (blockedPaths.size) {
      notes.push(
        `${blockedPaths.size} item(s) were skipped because a running process is using them.`
      );
    }
    // Honest scope statement: this check sees executables, not every open handle.
    notes.push(
      'The in-use check compares against running executable paths. It cannot see ' +
      'a process holding an open handle to a file outside its own install location.'
    );

    // --- execute ------------------------------------------------------------
    const results = [];
    let done = 0;

    for (const entry of targets) {
      const result = {
        id: entry.id,
        path: entry.path,
        name: entry.name,
        bytes: entry.bytes,
        action: entry.action,
        status: 'pending',
        detail: null,
        restoreId: null,
      };

      try {
        const blocker = blockedPaths.get(path.resolve(entry.path));
        if (blocker) {
          result.status = 'skipped';
          result.detail =
            `In use by ${blocker.process} (pid ${blocker.pid}). ` +
            `Close it and run the plan again.`;
          results.push(result);
          continue;
        }

        // Re-validate. The plan crossed an IPC boundary to get here.
        const safePath = assertInsideRoot(entry.path, { mustExist: true });

        if (entry.action === ACTION.TRASH) {
          await trashItem(safePath);
          result.status = 'trashed';
          result.detail = 'Moved to the system trash. Restore it from there.';
        } else if (entry.action === ACTION.QUARANTINE) {
          const q = await quarantine.add(safePath, {
            reason: entry.reason,
            evidence: entry.evidence,
            category: entry.category,
            confidence: entry.confidence,
            source: entry.source,
          });
          result.status = 'quarantined';
          result.restoreId = q.id;
          result.detail = `Held in quarantine until ${q.expiresAt.slice(0, 10)}. Restore any time before then.`;
        } else {
          throw new Error(`Unknown action "${entry.action}"`);
        }
      } catch (err) {
        result.status = 'failed';
        result.detail = err.message;
      }

      results.push(result);
      done++;
      onProgress({ done, total: targets.length, current: result });
    }

    return { results, summary: summarise(results), notes };
  }

  return { execute };
}

function emptySummary() {
  return { trashed: 0, quarantined: 0, skipped: 0, failed: 0, bytesReclaimed: 0 };
}

function summarise(results) {
  const s = emptySummary();
  for (const r of results) {
    if (r.status === 'trashed') { s.trashed++; s.bytesReclaimed += r.bytes; }
    else if (r.status === 'quarantined') { s.quarantined++; s.bytesReclaimed += r.bytes; }
    else if (r.status === 'skipped') s.skipped++;
    else if (r.status === 'failed') s.failed++;
  }
  return s;
}

module.exports = { createExecutor };
