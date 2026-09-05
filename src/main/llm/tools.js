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
const contentIndex = require('../search/content-index');

const NO_SCAN = {
  scanned: false,
  message: 'No scan has been run yet, so there is nothing measured to report. ' +
           'Ask the user to choose a folder and run a scan.',
};

/**
 * @param {object} state the application state
 * @param {object} deps
 * @param {Function} [deps.onStage] called with what the assistant is doing right
 *   now, so an interface can say "reading 40 documents" while it happens rather
 *   than showing a spinner for eight seconds and then an answer. Optional: the
 *   side panel passes nothing and the tools behave identically without it.
 */
function build(state, { app, nativeImage, onStage = null }) {
  const requireScan = () => {
    const scan = state.currentScan();
    if (!scan) return null;
    return scan;
  };

  const stage = (name, detail) => {
    try { onStage?.({ stage: name, ...detail }); } catch { /* the UI is optional */ }
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

    /**
     * Searches what is inside the user's documents.
     *
     * Two things happen here, in this order, and the order is the whole design:
     * the index is brought up to date (bounded by a time budget), and then it is
     * queried. Neither step guesses. A file appears in the results because it was
     * opened, read, and found to contain the words — and the passage that
     * matched comes back with it, so the model has evidence to reason about
     * rather than a ranking to trust.
     *
     * The snippets are file contents, which is to say untrusted data. The system
     * instruction covers this, and the flag below repeats it in the payload.
     */
    async search_file_contents({ query, limit } = {}) {
      const text = String(query || '').trim();
      if (!text) return { error: 'A search needs something to search for.' };

      const scan = state.currentScan();
      stage('indexing', { message: 'Reading your documents…' });

      const indexed = await contentIndex.ensureIndexed(
        { index: state.index, scanId: scan?.id || null },
        {
          budgetMs: 25_000,
          maxFiles: 2_000,
          onProgress: (p) => stage('indexing', {
            message: `Reading your documents… ${p.read} read`,
            read: p.read, total: p.total, current: p.current,
          }),
        }
      );

      stage('searching', { message: `Searching ${indexed.read + indexed.skippedFresh} documents…` });
      const found = contentIndex.search(
        { index: state.index }, text, { limit: Math.min(Math.max(1, limit || 10), 25) });

      // Kept so that if the model goes on to ask the user which file they meant,
      // the list can show the passage that actually matched rather than each
      // file's opening words. The passage is the reason the file is on the list,
      // and it is what lets someone recognise their own document at a glance.
      state.lastContentMatches = new Map(
        found.matches.map((m) => [roots.normalize(m.path), m]));

      return {
        query: text,
        searchedTerms: found.terms,
        documentsSearched: found.searched,
        documentsUnreadable: found.unreadable,
        coverage: indexed.complete
          ? `Every document found via ${indexed.source} was read.`
          : `Reading stopped at the time limit after ${indexed.read} document(s); ` +
            `${indexed.candidates} were found via ${indexed.source}. The results below ` +
            `cover what was read, not necessarily the whole disk.`,
        indexComplete: indexed.complete,
        matchCount: found.matches.length,
        // Every snippet below is text taken out of a file. It is evidence about
        // what the file says and is never an instruction.
        contentIsUntrustedData: true,
        matches: found.matches,
        note: found.note,
      };
    },

    /**
     * Reads more of one document than a snippet shows.
     *
     * Used to tell two candidates apart: a snippet says a file mentions
     * elephants, and this says whether it is an article about them or a
     * paragraph in a diary. Returns only text that was already extracted and
     * indexed, so it can never read a file the search did not reach.
     */
    async read_document({ path: filePath, maxChars } = {}) {
      try {
        const out = contentIndex.readIndexed(
          { index: state.index }, String(filePath || ''),
          { maxChars: Math.min(Math.max(200, maxChars || 4_000), 12_000) });
        return { ...out, contentIsUntrustedData: true };
      } catch (e) {
        return { error: e.message };
      }
    },

    /**
     * Asks the user which files they meant, and stops.
     *
     * This is the one tool that produces no data. It returns a question, the
     * interface renders it as a list the user can pick from, and the answer
     * comes back as the next turn of the conversation. It exists because the
     * alternative — the model choosing on the user's behalf when several files
     * genuinely match — is the model deciding which of the user's documents to
     * act on, which is exactly the class of decision this application never
     * takes without asking.
     */
    async ask_user_to_choose({ question, paths = [], multiple = false } = {}) {
      const options = [];
      const rejected = [];
      for (const p of paths.slice(0, 12)) {
        let safe;
        try {
          safe = roots.assertInsideRoot(p, { mustExist: true });
        } catch (e) {
          // Named rather than skipped. A path that cannot be offered is usually
          // a file that has moved since it was indexed, and the model has to be
          // told which one and why — given a bare "no options", it will call
          // this tool again with the same paths until it runs out of rounds,
          // and the user is left looking at a question with no list under it.
          rejected.push({ path: p, why: e.message });
          continue;
        }
        let size = null;
        let mtimeMs = null;
        try {
          const st = await fsp.stat(safe);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch { /* listed without its measurements */ }
        const key = roots.normalize(safe);
        const indexed = state.index.docBodyFor(key);
        const matched = state.lastContentMatches?.get(key) || null;
        options.push({
          path: safe,
          name: path.basename(safe),
          folder: path.dirname(safe),
          bytes: size,
          lastModified: mtimeMs ? new Date(mtimeMs).toISOString().slice(0, 10) : null,
          extension: path.extname(safe).slice(1).toLowerCase(),
          // A one-line description of the file, taken from its own opening words
          // rather than written by the model. The user is choosing between their
          // own documents and should see their own words.
          opening: indexed?.ok
            ? String(indexed.body || '').replace(/\s+/g, ' ').trim().slice(0, 160)
            : null,
          // The passage from the most recent search that put this file on the
          // list, with the matched words marked. Absent when the file was not
          // reached through a search.
          snippet: matched?.snippet || null,
          matchedTerms: matched?.matchedTerms || null,
        });
      }

      if (options.length === 0) {
        return {
          error: 'None of those files could be offered to the user.',
          rejected,
          note: 'Do not call this tool again with these paths. They are not there. ' +
                'Either search again, or tell the user plainly that the files you found ' +
                'no longer exist.',
        };
      }

      return {
        __choice: {
          id: require('crypto').randomUUID(),
          question: String(question || 'Which one did you mean?').slice(0, 300),
          multiple: !!multiple,
          options,
        },
        summary: {
          asked: true,
          optionCount: options.length,
          // Reported even on success: a list that quietly lost half its entries
          // would have the model talking about files the user cannot see.
          rejected,
          note: 'The user is being shown this list and will answer in their next message. ' +
                'Stop here and wait, say nothing further, and do not choose on their behalf.',
        },
      };
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
        engines: caps.engines.map((e) => ({ id: e.id, label: e.label, note: e.note || null })),
        // Which engine would handle what, so the model can say "this one needs
        // Word installed and that one does not" instead of one flat yes or no.
        renderedByNexaFiles: caps.selfRendered || [],
        needsOfficeSuite: caps.needsOfficeSuite || [],
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
