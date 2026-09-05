'use strict';
// Tool implementations for the agent.
//
// Read tools return measured data or an explicit statement that nothing has
// been measured. Plan tools return `{ __plan }`, which the agent loop strips out
// and hands to the UI — the model itself only ever sees a summary. No tool here
// deletes, moves, or writes anything.

const path = require('path');
const fsp = require('fs').promises;
const roots = require('../security/roots');
const { Plan, CATEGORY, ACTION, CONFIDENCE } = require('../safety/plan');
const duplicates = require('../scanners/duplicates');
const { findLeftovers, leftoversToPlanEntries } = require('../scanners/leftovers');
const { listStartupItems } = require('../scanners/startup');
const metrics = require('../system/metrics');
const { listProcesses } = require('../system/processes');
const { classifyMagic } = require('../classify/rules');
const converter = require('../convert');

const NO_SCAN = {
  scanned: false,
  message: 'No scan has been run yet, so there is nothing measured to report. ' +
           'Ask the user to choose a folder and run a scan.',
};

function build(state, { app, nativeImage }) {
  const requireScan = () => {
    const scan = state.currentScan();
    if (!scan) return null;
    return scan;
  };

  return {
    async get_scan_status() {
      const scan = requireScan();
      if (!scan) return NO_SCAN;
      return {
        scanned: true,
        root: scan.root,
        finishedAt: scan.finishedAt,
        fileCount: scan.fileCount,
        directoryCount: scan.dirCount,
        totalBytes: scan.totalBytes,
        skippedCount: scan.skippedCount,
        caveats: scan.notes,
      };
    },

    async get_disk_composition({ under } = {}) {
      const scan = requireScan();
      if (!scan) return NO_SCAN;
      const dir = under || scan.root;
      try { roots.assertInsideRoot(dir); } catch (e) { return { error: e.message }; }
      const children = state.index.childrenWithRollup(scan.id, dir).slice(0, 30);
      return {
        scanned: true,
        under: dir,
        totalBytes: scan.totalBytes,
        categories: state.index.categoryTotals(scan.id),
        largestChildren: children.map((c) => ({
          name: c.name, path: c.path, bytes: c.bytes,
          isDirectory: !!c.isDirectory, fileCount: c.fileCount, category: c.category,
        })),
      };
    },

    async query_largest_files({ under, category, limit } = {}) {
      const scan = requireScan();
      if (!scan) return NO_SCAN;
      if (under) {
        try { roots.assertInsideRoot(under); } catch (e) { return { error: e.message }; }
      }
      const files = state.index.largestFiles(scan.id, {
        under: under || null,
        category: category || null,
        limit: Math.min(Math.max(1, limit || 20), 100),
      });
      return {
        scanned: true,
        files: files.map((f) => ({
          path: f.path, name: f.name, bytes: f.size,
          type: f.type, category: f.category,
          lastModified: f.mtimeMs ? new Date(f.mtimeMs).toISOString().slice(0, 10) : null,
        })),
      };
    },

    async find_duplicates({ tier } = {}) {
      const scan = requireScan();
      if (!scan) return NO_SCAN;
      const key = tier === 'image' ? 'image' : tier === 'text' ? 'text' : 'exact';

      if (!state.lastDuplicates[key]) {
        if (key === 'image') {
          state.lastDuplicates.image = await duplicates.findSimilarImages(state.index, scan.id, nativeImage, {});
        } else if (key === 'text') {
          state.lastDuplicates.text = await duplicates.findSimilarText(state.index, scan.id, {});
        } else {
          state.lastDuplicates.exact = await duplicates.findExactDuplicates(state.index, scan.id, {});
        }
      }

      const found = state.lastDuplicates[key];
      return {
        scanned: true,
        tier: key,
        method: key === 'exact'
          ? 'SHA-256 after a size and head/tail pre-filter. Matches are byte-identical.'
          : key === 'image'
            ? 'Difference hashing of image pixels, grouped by Hamming distance. Not machine learning.'
            : 'SimHash over word shingles, grouped by Hamming distance. Not machine learning.',
        groupCount: found.groups.length,
        reclaimableBytes: found.groups.reduce((n, g) => n + g.wastedBytes, 0),
        groups: found.groups.slice(0, 20).map((g) => ({
          signature: g.signature,
          reclaimableBytes: g.wastedBytes,
          files: g.members.map((m) => ({ path: m.path, bytes: m.size, bitsDifferent: m.distance })),
        })),
      };
    },

    async find_leftovers() {
      if (!state.lastLeftovers) {
        state.lastLeftovers = await findLeftovers({ listProcesses });
      }
      const { findings, notes, stats } = state.lastLeftovers;
      return {
        stats,
        caveats: notes,
        totalBytes: findings.reduce((n, f) => n + f.bytes, 0),
        findings: findings.slice(0, 40).map((f) => ({
          path: f.path, name: f.name, bytes: f.bytes, fileCount: f.fileCount,
          daysIdle: f.daysIdle, category: f.category, confidence: f.confidence,
          evidence: f.evidence,
        })),
      };
    },

    async list_startup_items() {
      if (!state.lastStartup) state.lastStartup = await listStartupItems();
      const s = state.lastStartup;
      return {
        platform: s.platform,
        incomplete: s.incomplete,
        caveats: s.notes,
        itemCount: s.items.length,
        items: s.items.slice(0, 60).map((i) => ({
          name: i.name, command: i.command, source: i.source, evidence: i.evidence,
        })),
      };
    },

    async get_system_load() {
      const [cpu, memory] = await Promise.all([metrics.sampleCpu(500), metrics.readMemory()]);
      const own = metrics.readOwnFootprint(app);
      return {
        cpuPercent: Number(cpu.percent.toFixed(1)),
        cpuCores: cpu.cores,
        memoryTotalBytes: memory.totalBytes,
        memoryUsedBytes: memory.usedBytes,
        memoryCaveat: memory.caveat,
        nexafilesOwnMemoryBytes: own.workingSetBytes,
        note: 'There is no way to "free" memory that would leave the machine faster; ' +
              'this is reported for visibility only.',
      };
    },

    async read_file_head({ path: filePath, bytes } = {}) {
      let safe;
      try {
        safe = roots.assertInsideRoot(filePath, { mustExist: true });
      } catch (e) {
        return { error: e.message };
      }
      const cap = Math.min(Math.max(1, bytes || 2048), 8192);
      const fd = await fsp.open(safe, 'r');
      try {
        const buf = Buffer.alloc(cap);
        const { bytesRead } = await fd.read(buf, 0, cap, 0);
        const head = buf.subarray(0, bytesRead);
        const magic = classifyMagic(head, safe);
        const binary = head.subarray(0, Math.min(512, bytesRead)).includes(0);
        return {
          path: safe,
          bytesRead,
          identifiedAs: magic.actual,
          extensionMatchesContent: magic.matchesExtension,
          note: magic.note,
          // Flagged explicitly so the model treats it as data, not instructions.
          contentIsUntrustedData: true,
          content: binary ? null : head.toString('utf8'),
        };
      } finally {
        await fd.close();
      }
    },

    // ── plan tools ─────────────────────────────────────────────────────────

    async propose_cleanup({ sources = [], minBytes = 0 } = {}) {
      const scan = requireScan();
      const plan = new Plan({
        source: 'assistant',
        title: 'Cleanup proposed by the assistant',
        roots: roots.listRoots(),
      });
      const want = new Set(sources);
      let considered = 0;

      if (want.has('duplicates-exact')) {
        if (!scan) return NO_SCAN;
        if (!state.lastDuplicates.exact) {
          state.lastDuplicates.exact = await duplicates.findExactDuplicates(state.index, scan.id, {});
        }
        for (const spec of duplicates.duplicatesToPlanEntries(
          state.lastDuplicates.exact.groups, { Plan, CATEGORY, ACTION, CONFIDENCE }
        )) {
          considered++;
          if (spec.bytes < minBytes) continue;
          try { roots.assertInsideRoot(spec.path, { mustExist: true }); } catch { continue; }
          plan.add(spec);
        }
      }

      if (want.has('leftovers-regenerable') || want.has('leftovers-all')) {
        if (!state.lastLeftovers) state.lastLeftovers = await findLeftovers({ listProcesses });
        for (const note of state.lastLeftovers.notes) plan.addNote(note);
        const onlyRegenerable = !want.has('leftovers-all');
        for (const spec of leftoversToPlanEntries(
          state.lastLeftovers.findings, { ACTION, CATEGORY, CONFIDENCE }
        )) {
          considered++;
          if (spec.bytes < minBytes) continue;
          if (onlyRegenerable && spec.category !== CATEGORY.REGENERABLE) continue;
          try { roots.assertInsideRoot(spec.path, { mustExist: true }); } catch { continue; }
          plan.add(spec);
        }
      }

      const totals = plan.totals();
      return {
        __plan: plan,
        summary: {
          itemCount: totals.itemCount,
          consideredCount: considered,
          totalBytes: totals.bytes,
          preSelectedBytes: totals.selectedBytes,
          userDataItemsNotSelected: totals.userData.count,
        },
      };
    },

    async propose_quarantine({ paths = [], reason } = {}) {
      const plan = new Plan({
        source: 'assistant',
        title: 'Quarantine proposed by the assistant',
        roots: roots.listRoots(),
      });
      const rejected = [];
      for (const p of paths.slice(0, 200)) {
        let safe;
        try {
          safe = roots.assertInsideRoot(p, { mustExist: true });
        } catch (e) {
          rejected.push({ path: p, why: e.message });
          continue;
        }
        const m = await require('../safety/fsops').measure(safe);
        const st = await fsp.stat(safe);
        plan.add({
          path: safe,
          action: ACTION.QUARANTINE,
          bytes: m.bytes,
          fileCount: m.files,
          isDirectory: st.isDirectory(),
          reason: reason || 'Proposed by the assistant',
          evidence: `Requested by the assistant. Measured on disk: ${m.bytes.toLocaleString()} ` +
                    `bytes across ${m.files.toLocaleString()} file(s). No automated check ` +
                    `established that this is safe to remove, so it is not pre-selected.`,
          // Assistant-proposed removals are never pre-selected: the reasoning
          // came from a language model, not from a measurement.
          category: CATEGORY.USER_DATA,
          confidence: CONFIDENCE.LOW,
          source: 'assistant',
        });
      }
      const totals = plan.totals();
      return {
        __plan: plan,
        summary: {
          itemCount: totals.itemCount,
          totalBytes: totals.bytes,
          rejected,
          note: 'Nothing is pre-selected. The user must choose each item.',
        },
      };
    },

    /**
     * What this machine can convert. A read tool: it inspects the installed
     * software and writes nothing.
     *
     * The model must call this before proposing a conversion, so that it says
     * "LibreOffice or Office is needed and neither is installed" rather than
     * proposing work that cannot be carried out.
     */
    async get_conversion_support() {
      const caps = await converter.capabilities();
      return {
        available: caps.available,
        convertibleExtensions: caps.canConvertFrom,
        targetFormats: caps.to,
        engine: caps.engines[0]?.label || null,
        why: caps.why,
      };
    },

    /**
     * Proposes converting files, and converts nothing.
     *
     * Conversion writes to the disk, so it goes through the same gate as
     * removal: the model produces an inert proposal, the interface shows the
     * exact destination of every file, and the user approves before a single
     * byte is written. The model cannot name a destination — it is derived from
     * the source — so a proposal cannot be steered into writing somewhere the
     * user did not expect.
     */
    async propose_conversion({ paths = [], format = 'pdf' } = {}) {
      const caps = await converter.capabilities();
      if (!caps.available) return { error: caps.why };
      if (!caps.to.includes(format)) {
        return { error: `NexaFiles can convert to ${caps.to.join(', ') || 'nothing'}, not ${format}.` };
      }

      const items = [];
      const rejected = [];
      for (const p of paths.slice(0, 100)) {
        let safe;
        try {
          safe = roots.assertInsideRoot(p, { mustExist: true });
        } catch (e) {
          rejected.push({ path: p, why: e.message });
          continue;
        }
        const ext = converter.extOf(safe);
        if (!caps.canConvertFrom.includes(ext)) {
          rejected.push({ path: safe, why: `.${ext || '(none)'} cannot be converted on this machine.` });
          continue;
        }
        const st = await fsp.stat(safe);
        if (st.isDirectory()) {
          rejected.push({ path: safe, why: 'This is a folder, not a file.' });
          continue;
        }
        const dest = converter.destinationFor(safe, { format });
        items.push({
          source: safe,
          name: path.basename(safe),
          target: dest.target,
          targetName: path.basename(dest.target),
          targetExists: dest.exists,
          sourceBytes: st.size,
        });
      }

      if (items.length === 0) {
        return { error: 'None of those files can be converted.', rejected };
      }

      const conversion = {
        id: require('crypto').randomUUID(),
        kind: 'conversion',
        format,
        engine: caps.engines[0]?.label || 'unknown',
        createdAt: Date.now(),
        items,
      };

      return {
        __conversion: conversion,
        summary: {
          fileCount: items.length,
          format,
          engine: conversion.engine,
          conflicts: items.filter((i) => i.targetExists).map((i) => i.targetName),
          rejected,
          note: 'A conversion proposal was created and is shown to the user for approval. ' +
                'Nothing has been converted and no file has been written. The source files ' +
                'are never modified or deleted.',
        },
      };
    },
  };
}

module.exports = { build };
