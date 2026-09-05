'use strict';
// Transcription, done by something that only transcribes.
//
// The assistant's Gemini client is a general model asked to do speech
// recognition as a side job, and it shows: it paraphrases, it wraps answers in
// "Transcript:", it occasionally answers the question instead of writing it
// down, and on `gemini-3.5-flash-lite` — the default — it is simply not very
// good at hearing words. Every one of those failures is a generative model
// behaving like a generative model.
//
// This is Whisper instead, hosted by Groq. It is an ASR model: it has no
// conversational behaviour to suppress, so none of the defensive unwrapping the
// Gemini path needs applies here. It is also very fast — Groq runs
// whisper-large-v3-turbo far above real time, so ten seconds of speech comes
// back in roughly a third of a second rather than the two to four the Gemini
// round-trip costs.
//
// It is free to use. The free tier wants an account and a key, has no card
// attached, and is rate-limited per minute and per day — generous for one
// person dictating questions at a file manager, and the limits are reported
// here rather than swallowed, so a user who hits one is told what happened and
// when it lifts.
//
// The key lives in settings.json alongside the Gemini keys and is subject to
// the same rule: write-only from the renderer's point of view.

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

// The turbo model. Roughly Whisper large's accuracy at a fraction of the
// latency, which for dictation is the trade worth making — nobody is
// transcribing an interview here, they are asking where a file went.
const DEFAULT_MODEL = 'whisper-large-v3-turbo';

// Groq refuses payloads past 25 MB on the free tier. Our own ceiling is far
// below that already (voice.js caps the recording), but a limit stated here is
// a better error than a 413 from a server.
const MAX_AUDIO_BYTES = 24_000_000;

// A vocabulary hint. Whisper accepts a `prompt` that biases decoding toward
// words it would otherwise mis-hear, and the words this application cares about
// are exactly the ones general English ASR gets wrong: file extensions read as
// letters, folder names, and the assistant's own name.
//
// This is a bias, not a constraint — nothing here prevents any other word being
// transcribed. It is the cheapest accuracy win available on this path.
const VOCABULARY =
  'NexaFiles, Nexa. Asking about files on a computer: PDF, DOCX, XLSX, PPTX, ' +
  'CSV, PNG, JPEG, HEIC, MP4, ZIP, folder, Downloads, Documents, Desktop, ' +
  'screenshot, duplicate, filename, gigabytes, megabytes.';

class GroqClient {
  constructor({ key = '', model = DEFAULT_MODEL, timeoutMs = 30_000 } = {}) {
    this.key = String(key || '').trim();
    this.model = model || DEFAULT_MODEL;
    this.timeoutMs = timeoutMs;
    // Set when the API reports a rate limit, so the next call can say how long
    // is left rather than firing into a limit that is still in force.
    this.cooldownUntil = 0;
  }

  get available() {
    return this.key.length > 0;
  }

  setKey(key) {
    this.key = String(key || '').trim();
    this.cooldownUntil = 0;
    return this.available;
  }

  setModel(model) {
    this.model = model || DEFAULT_MODEL;
    return this.model;
  }

  status() {
    return {
      configured: this.available,
      model: this.model,
      keyHint: this.available ? `…${this.key.slice(-4)}` : null,
      cooldownMs: Math.max(0, this.cooldownUntil - Date.now()),
    };
  }

  /**
   * Transcribes one recording.
   *
   * @param {Buffer} audio      the raw bytes, already decoded from base64
   * @param {string} mimeType   what those bytes are
   * @param {object} [opts]
   * @param {string} [opts.language]  an ISO code; 'en' skips language detection
   *   and is measurably faster, which is why it is the default rather than
   *   leaving Whisper to work it out every time.
   * @returns {Promise<{text: string, ms: number}>}
   */
  async transcribe(audio, mimeType, { language = 'en' } = {}) {
    if (!this.available) {
      const err = new Error('No Groq API key is configured.');
      err.code = 'NO_KEY';
      throw err;
    }
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      const err = new Error(
        `That recording is ${(audio.byteLength / 1e6).toFixed(1)} MB, past the ` +
        `${(MAX_AUDIO_BYTES / 1e6).toFixed(0)} MB limit.`
      );
      err.code = 'TOO_LONG';
      throw err;
    }

    const waitMs = this.cooldownUntil - Date.now();
    if (waitMs > 0) {
      const err = new Error(
        `Groq's free tier is rate-limited for another ${Math.ceil(waitMs / 1000)}s.`
      );
      err.code = 'RATE_LIMITED';
      err.retryAfterMs = waitMs;
      throw err;
    }

    // The extension matters: Whisper's server-side decoder picks its demuxer
    // from the filename, and a WAV sent as "audio" is rejected as unreadable.
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mimeType }), fileNameFor(mimeType));
    form.append('model', this.model);
    form.append('response_format', 'json');
    form.append('temperature', '0');       // transcription, not creative writing
    form.append('prompt', VOCABULARY);
    if (language) form.append('language', language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();

    let resp;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}` },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        const timeout = new Error(`Groq did not answer within ${this.timeoutMs / 1000}s.`);
        timeout.code = 'TIMEOUT';
        throw timeout;
      }
      const offline = new Error(`Groq could not be reached: ${err.message}`);
      offline.code = 'UNREACHABLE';
      throw offline;
    }
    clearTimeout(timer);

    if (!resp.ok) throw await describeFailure(resp, this);

    let body;
    try {
      body = await resp.json();
    } catch {
      const err = new Error('Groq returned something that was not a transcript.');
      err.code = 'BAD_RESPONSE';
      throw err;
    }

    return { text: String(body?.text || '').trim(), ms: Date.now() - started };
  }
}

/** Whisper's decoder reads the container from the extension, so it needs one. */
function fileNameFor(mimeType) {
  const ext = {
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
    'audio/webm': 'webm',
    'audio/mp4': 'm4a',
  }[mimeType] || 'wav';
  return `speech.${ext}`;
}

/**
 * Turns a failed response into an error a person can act on.
 *
 * The distinction that matters is between "your key is wrong" — which the user
 * must fix and which will never fix itself — and "you are going too fast",
 * which lifts on its own and should not send anyone to re-read their settings.
 */
async function describeFailure(resp, client) {
  let detail = '';
  try {
    const body = await resp.json();
    detail = body?.error?.message || '';
  } catch { /* an error page rather than an error object */ }

  if (resp.status === 401 || resp.status === 403) {
    const err = new Error(
      'Groq rejected the API key. Check it in Settings — keys begin with "gsk_".'
    );
    err.code = 'BAD_KEY';
    err.status = resp.status;
    return err;
  }

  if (resp.status === 429) {
    // `retry-after` is in seconds when present. When it is not, a minute is the
    // free tier's window and a safe assumption.
    const header = Number(resp.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : 60_000;
    client.cooldownUntil = Date.now() + retryAfterMs;
    const err = new Error(
      `Groq's free tier limit was reached. It lifts in about ` +
      `${Math.ceil(retryAfterMs / 1000)}s${detail ? ` (${detail})` : ''}.`
    );
    err.code = 'RATE_LIMITED';
    err.status = 429;
    err.retryAfterMs = retryAfterMs;
    return err;
  }

  const err = new Error(
    `Groq returned ${resp.status}${detail ? `: ${detail}` : '.'}`
  );
  err.code = 'HTTP_ERROR';
  err.status = resp.status;
  return err;
}

module.exports = { GroqClient, DEFAULT_MODEL, MAX_AUDIO_BYTES, VOCABULARY };
