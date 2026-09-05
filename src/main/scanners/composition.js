'use strict';
// Scan controller: owns the walker worker, writes batches into SQLite, and
// reports progress. The renderer never sees a row it did not ask for.

const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'walker.worker.js');

class ScanController {
  constructor(index) {
    this.index = index;
    this.active = null;   // { id, worker, root }
  }

  get isRunning() {
    return this.active !== null;
  }

  /**
   * Walks `root`, streaming rows into the index.
   * @param {(p:object)=>void} onProgress
   * @returns {Promise<object>} the finished scan record
   */
  start(root, onProgress = () => {}) {
    if (this.active) throw new Error('A scan is already running.');

    const scanId = crypto.randomUUID();
    this.index.createScan(scanId, root);

    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: { root, followSymlinks: false, crossDevice: false },
      });
      this.active = { id: scanId, worker, root };

      let written = 0;
      let lastProgressAt = 0;
      const errors = [];

      worker.on('message', (msg) => {
        try {
          if (msg.type === 'batch') {
            this.index.insertBatch(scanId, msg.rows);
            written += msg.rows.length;
          } else if (msg.type === 'progress') {
            // Throttle: the walker reports per directory, which on a large tree
            // is far more often than a UI can usefully repaint.
            const now = Date.now();
            if (now - lastProgressAt > 120) {
              lastProgressAt = now;
              onProgress({
                scanId,
                phase: 'walking',
                fileCount: msg.fileCount,
                dirCount: msg.dirCount,
                totalBytes: msg.totalBytes,
                skipped: msg.skipped,
                current: msg.current,
                written,
              });
            }
          } else if (msg.type === 'error') {
            errors.push(msg.message);
          } else if (msg.type === 'done') {
            const notes = [...msg.notes];
            for (const e of errors) notes.push(`Error during walk: ${e}`);

            // Directory totals are computed once, here, rather than derived on
            // every treemap query.
            try {
              this.index.computeRollups(scanId);
            } catch (err) {
              notes.push(`Directory totals could not be computed: ${err.message}`);
            }

            this.index.finishScan(scanId, {
              status: msg.cancelled ? 'cancelled' : 'complete',
              fileCount: msg.fileCount,
              dirCount: msg.dirCount,
              totalBytes: msg.totalBytes,
              skippedCount: msg.skipped,
              notes,
            });
            this.active = null;
            worker.terminate();
            resolve(this.index.getScan(scanId));
          }
        } catch (err) {
          this.active = null;
          worker.terminate();
          this.index.finishScan(scanId, {
            status: 'failed', fileCount: 0, dirCount: 0, totalBytes: 0,
            skippedCount: 0, notes: [`Scan failed: ${err.message}`],
          });
          reject(err);
        }
      });

      worker.on('error', (err) => {
        this.active = null;
        this.index.finishScan(scanId, {
          status: 'failed', fileCount: 0, dirCount: 0, totalBytes: 0,
          skippedCount: 0, notes: [`Worker error: ${err.message}`],
        });
        reject(err);
      });

      worker.on('exit', (code) => {
        if (this.active && this.active.id === scanId) {
          this.active = null;
          if (code !== 0) reject(new Error(`Scan worker exited with code ${code}`));
        }
      });
    });
  }

  cancel() {
    if (!this.active) return false;
    this.active.worker.postMessage({ type: 'cancel' });
    return true;
  }
}

module.exports = { ScanController };
