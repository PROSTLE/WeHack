'use strict';
// The speech model "Hey Nexa" listens with.
//
// WHY THERE IS A DOWNLOAD HERE AT ALL
//
// The previous wake word worked by sending every short utterance near the
// microphone to Google and asking what it was. That is why it was slow — a
// keystroke's worth of intent cost a network round-trip and an LLM inference,
// somewhere between one and three seconds — and it is also why the file that
// implemented it had to open with four paragraphs explaining what left the
// machine.
//
// Both problems have the same fix: recognise the phrase here, on this computer.
// That needs an acoustic model, an acoustic model is forty megabytes, and forty
// megabytes is not something to put in a git repository or an installer that
// most users will never enable the feature from. So it is fetched once, on the
// first occasion someone actually switches the wake word on, and cached in
// userData forever after.
//
// It is fetched from the vosk-browser project's own model host, in the .tar.gz
// layout that library expects. Vosk is Apache-2.0 and the models are free; there
// is no account, no key and no per-use cost, which is the point.
//
// AFTER THE DOWNLOAD, NOTHING LEAVES
//
// This is the last network access the wake word ever makes. Once the model is
// on disk, detection is entirely local: no audio, no transcript and no metadata
// goes anywhere, whether or not the phrase was heard. The recording indicator
// stays the honest signal that the microphone is open, but what it is open
// *to* is now a process on this machine.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// The small US English model: 40 MB, and the one vosk-browser publishes in the
// packed layout its worker can read. The large model is an order of magnitude
// bigger and buys accuracy on continuous dictation that a four-syllable wake
// phrase has no use for.
const MODEL = {
  id: 'vosk-model-small-en-us-0.15',
  url: 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz',
  // Checked against the response rather than trusted from it: a truncated
  // download that still parsed as gzip would fail much later, inside a worker,
  // as an unreadable model.
  bytes: 41_184_862,
};

// The scheme the renderer's worker fetches the cached file over.
//
// It cannot simply be handed a file:// path: the vosk worker is created from a
// blob: URL and fetching file:// from there is refused by Chromium, and opening
// the renderer's CSP to file: would be a far larger concession than this. A
// custom scheme that serves exactly one file out of userData is the narrow
// version of the same permission.
const SCHEME = 'nexa-model';

class WakeModelStore {
  /**
   * @param {string} userDataDir where the cached model lives
   * @param {object} [deps]
   * @param {typeof fetch} [deps.fetch] injectable for the tests
   */
  constructor(userDataDir, { fetch: fetchImpl = globalThis.fetch } = {}) {
    this.dir = path.join(userDataDir, 'wake-models');
    this.file = path.join(this.dir, `${MODEL.id}.tar.gz`);
    this.partFile = `${this.file}.part`;
    this.fetch = fetchImpl;
    // The download in flight, so two callers cannot start two of them.
    this.inFlight = null;
    this.abort = null;
  }

  /** The URL the renderer hands to `createModel`. */
  get modelUrl() {
    return `${SCHEME}://model/${MODEL.id}.tar.gz`;
  }

  /** Whether the model is on disk and the right size. */
  async isReady() {
    try {
      const stat = await fsp.stat(this.file);
      return stat.size === MODEL.bytes;
    } catch {
      return false;
    }
  }

  async status() {
    const ready = await this.isReady();
    return {
      ready,
      downloading: !!this.inFlight,
      id: MODEL.id,
      bytes: MODEL.bytes,
      url: ready ? this.modelUrl : null,
    };
  }

  /**
   * Fetches the model if it is not already here.
   *
   * Downloads to a `.part` file and renames only once every byte has arrived,
   * so an interrupted download leaves no half-model that `isReady` would
   * cheerfully accept on the next launch.
   *
   * @param {(p: {received: number, total: number, ratio: number}) => void} [onProgress]
   * @returns {Promise<{ready: true, url: string, cached: boolean}>}
   */
  async ensure(onProgress) {
    if (await this.isReady()) {
      return { ready: true, url: this.modelUrl, cached: true };
    }
    // A second caller joins the first download rather than starting its own.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this._download(onProgress).finally(() => {
      this.inFlight = null;
      this.abort = null;
    });
    return this.inFlight;
  }

  async _download(onProgress) {
    await fsp.mkdir(this.dir, { recursive: true });

    const controller = new AbortController();
    this.abort = controller;

    let resp;
    try {
      resp = await this.fetch(MODEL.url, { signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') {
        const cancelled = new Error('The model download was cancelled.');
        cancelled.code = 'CANCELLED';
        throw cancelled;
      }
      const offline = new Error(
        `The speech model could not be downloaded: ${err.message}. ` +
        `"Hey Nexa" needs it once; after that it works offline.`
      );
      offline.code = 'UNREACHABLE';
      throw offline;
    }

    if (!resp.ok || !resp.body) {
      const err = new Error(`The speech model could not be downloaded (HTTP ${resp.status}).`);
      err.code = 'HTTP_ERROR';
      throw err;
    }

    const total = Number(resp.headers.get('content-length')) || MODEL.bytes;
    let received = 0;

    // Streamed to disk rather than buffered: forty megabytes held in memory to
    // be written out in one go is forty megabytes of renderer-adjacent heap for
    // no reason, and the progress figure has to come from somewhere anyway.
    const out = fs.createWriteStream(this.partFile);
    try {
      for await (const chunk of resp.body) {
        received += chunk.length;
        if (!out.write(Buffer.from(chunk))) {
          await new Promise((resolve) => out.once('drain', resolve));
        }
        onProgress?.({ received, total, ratio: total ? received / total : 0 });
      }
      await new Promise((resolve, reject) => {
        out.end((err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      out.destroy();
      await fsp.rm(this.partFile, { force: true });
      if (err.name === 'AbortError') {
        const cancelled = new Error('The model download was cancelled.');
        cancelled.code = 'CANCELLED';
        throw cancelled;
      }
      throw err;
    }

    // A short file is a truncated download, not a model. Refusing it here means
    // the failure is reported now, in a sentence about downloading, rather than
    // three layers away as "the recogniser would not start".
    const stat = await fsp.stat(this.partFile);
    if (stat.size !== MODEL.bytes) {
      await fsp.rm(this.partFile, { force: true });
      const err = new Error(
        `The speech model downloaded incompletely (${stat.size} of ${MODEL.bytes} bytes). Try again.`
      );
      err.code = 'TRUNCATED';
      throw err;
    }

    await fsp.rename(this.partFile, this.file);
    return { ready: true, url: this.modelUrl, cached: false };
  }

  /** Stops a download in progress. Safe to call when there is none. */
  cancel() {
    try { this.abort?.abort(); } catch { /* already finished */ }
    return !!this.abort;
  }

  /** Removes the cached model, for a user reclaiming the 40 MB. */
  async remove() {
    this.cancel();
    await fsp.rm(this.file, { force: true });
    await fsp.rm(this.partFile, { force: true });
    return true;
  }

  /**
   * Serves the cached model over the custom scheme.
   *
   * Exactly one file is reachable this way. The request's path is compared
   * against the one name we publish rather than joined onto a directory, so
   * there is no traversal to reason about — an unrecognised path is a 404, not
   * a lookup.
   */
  registerProtocol(protocol) {
    protocol.handle(SCHEME, async (request) => {
      const wanted = `${SCHEME}://model/${MODEL.id}.tar.gz`;
      if (request.url !== wanted) {
        return new Response('Not found', { status: 404 });
      }
      try {
        const data = await fsp.readFile(this.file);
        return new Response(data, {
          status: 200,
          headers: {
            'content-type': 'application/gzip',
            'content-length': String(data.byteLength),
          },
        });
      } catch {
        return new Response('The speech model is not downloaded.', { status: 404 });
      }
    });
  }
}

/**
 * Declares the scheme before the app is ready.
 *
 * `supportFetchAPI` is what lets the vosk worker `fetch` it at all; `secure`
 * keeps it out of the mixed-content rules that would otherwise block it from a
 * file:// document. Both have to be set here, before `app.whenReady`, because
 * Chromium fixes its scheme table at startup.
 */
function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

module.exports = { WakeModelStore, registerScheme, MODEL, SCHEME };
