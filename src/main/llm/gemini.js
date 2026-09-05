'use strict';
// Gemini client, in Node.
//
// The per-key cooldown logic here is ported from the Python sidecar it replaces,
// because that logic was genuinely well built. What changed is only where it
// runs and where the keys come from: the environment, never a file in the repo.
//
// Behaviour on rate limits, unchanged from the original:
//   Pass 1  try every key not currently in cooldown; on a 429 stamp that key
//           with a 62-second cooldown and move to the next immediately.
//   Pass 2  if every key is cooling, wait for the soonest to come back, then
//           retry once.
//   Failure is propagated honestly rather than being disguised as an empty
//   result — a caller must be able to tell "the model said nothing" apart from
//   "the model was never reached".

const RATE_LIMIT_COOLDOWN_MS = 62_000;   // free-tier window is 60s; 2s of slack
// A 500 or 503 is the service having a bad moment, not the request being wrong.
// Sending the same call again a second later costs a second and turns an outright
// failure into a slightly slow answer; the previous behaviour propagated the first
// one and ended the turn.
const TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = 700;
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * The answer out of a response's parts.
 *
 * A thinking model interleaves its reasoning as parts flagged `thought`. They
 * are not the answer, and a caller that concatenates every text part gets the
 * model's scratch work glued to the front of whatever it actually said.
 */
function answerText(parts) {
  return (parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
}

/**
 * Turns an HTTP failure into something a person can act on.
 *
 * "Gemini HTTP 404" followed by 300 characters of JSON tells the user nothing they
 * can do anything about. Each status below has one likely cause in this
 * application, and naming it is the difference between an assistant that is dead
 * for no stated reason and a setting the user can go and change. `transient` marks
 * the ones worth sending again.
 */
function httpError(status, text, model) {
  const rateLimited = status === 429 || /RESOURCE_EXHAUSTED/.test(text);
  let message;
  let code;
  if (rateLimited) {
    message = 'That key has reached its rate limit.';
    code = 'RATE_LIMITED';
  } else if (status === 400 && /API[_ ]?key/i.test(text)) {
    message = 'The API key was rejected as invalid. Check it in Settings.';
    code = 'BAD_KEY';
  } else if (status === 400) {
    message = `The request was rejected: ${extractApiMessage(text)}`;
    code = 'BAD_REQUEST';
  } else if (status === 401 || status === 403) {
    message = 'The API key was refused. Check that it is current and that the ' +
              'Generative Language API is enabled for it.';
    code = 'KEY_REFUSED';
  } else if (status === 404) {
    message = `This key cannot call "${model}". Choose a different model in Settings.`;
    code = 'NO_SUCH_MODEL';
  } else if (status >= 500) {
    message = `The Gemini service returned an error (HTTP ${status}).`;
    code = 'UPSTREAM';
  } else {
    message = `Gemini HTTP ${status}: ${extractApiMessage(text)}`;
    code = 'HTTP_ERROR';
  }
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.rateLimited = rateLimited;
  err.transient = status >= 500;
  err.detail = String(text).slice(0, 300);
  return err;
}

/** The API's own explanation, when it sent one, rather than the raw envelope. */
function extractApiMessage(text) {
  try {
    const msg = JSON.parse(text)?.error?.message;
    if (msg) return String(msg).slice(0, 200);
  } catch { /* not JSON; fall through to the raw text */ }
  return String(text).slice(0, 200);
}

class GeminiClient {
  constructor({ keys = [], model = DEFAULT_MODEL, timeoutMs = 30_000 } = {}) {
    this.keys = keys.filter(Boolean);
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.cooldownUntil = new Map();   // key index -> epoch ms
  }

  get available() {
    return this.keys.length > 0;
  }

  /**
   * Replaces the key set at runtime.
   *
   * Cooldowns are dropped with the old keys: they described how the previous
   * set was behaving and say nothing about a key that has just been added.
   */
  setKeys(keys) {
    this.keys = [...new Set((keys || []).map((k) => String(k || '').trim()).filter(Boolean))];
    this.cooldownUntil.clear();
    return this.keys.length;
  }

  /** Chooses the model. `null` restores the built-in default. */
  setModel(model) {
    this.model = model || DEFAULT_MODEL;
    return this.model;
  }

  /**
   * The models this key may actually call, asked of the API rather than
   * hardcoded here.
   *
   * A list baked into the source is wrong the moment Google publishes or
   * retires one, and the user would have no way to tell. Only models that
   * declare `generateContent` are returned, because those are the only ones
   * this application can use.
   */
  async listModels() {
    if (this.keys.length === 0) {
      const err = new Error('No API key is configured, so the model list cannot be fetched.');
      err.code = 'NO_KEY';
      throw err;
    }
    const idx = this._availableKeyIndex() ?? 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(
        `${ENDPOINT}?key=${encodeURIComponent(this.keys[idx])}&pageSize=200`,
        { signal: controller.signal }
      );
      const text = await resp.text();
      if (!resp.ok) {
        const err = new Error(`Gemini HTTP ${resp.status}: ${text.slice(0, 200)}`);
        err.status = resp.status;
        throw err;
      }
      const body = JSON.parse(text);
      return (body.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => ({
          id: String(m.name || '').replace(/^models\//, ''),
          label: m.displayName || null,
          description: m.description || null,
          inputTokenLimit: m.inputTokenLimit ?? null,
          outputTokenLimit: m.outputTokenLimit ?? null,
        }))
        .filter((m) => m.id)
        .sort((a, b) => a.id.localeCompare(b.id));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends the smallest possible real request, to prove the key and the model
   * work together. Reporting "connected" without having connected would be
   * exactly the kind of claim this application exists not to make.
   */
  async probe() {
    const started = Date.now();
    const resp = await this.generate(
      [{ role: 'user', parts: [{ text: 'Reply with the single word: ready' }] }]
    );
    const parts = resp?.candidates?.[0]?.content?.parts || [];
    return {
      ok: true,
      model: this.model,
      ms: Date.now() - started,
      reply: answerText(parts).slice(0, 80),
    };
  }

  /** Loads keys from the environment, then from an optional local config file. */
  static fromEnvironment(loadConfigFile) {
    const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
    let keys = raw.split(',').map((k) => k.trim()).filter(Boolean);

    if (keys.length === 0 && typeof loadConfigFile === 'function') {
      try {
        const cfg = loadConfigFile() || {};
        const fromFile = cfg.GEMINI_API_KEYS || (cfg.GEMINI_API_KEY ? [cfg.GEMINI_API_KEY] : []);
        keys = (fromFile || [])
          .map((k) => (k || '').trim())
          .filter((k) => k && !k.startsWith('PASTE_') && k !== 'YOUR_GEMINI_API_KEY_HERE');
      } catch { /* no config file, which is the expected case */ }
    }

    // De-duplicate: the old config shipped the same key twice.
    return new GeminiClient({ keys: [...new Set(keys)] });
  }

  _availableKeyIndex(now = Date.now()) {
    for (let i = 0; i < this.keys.length; i++) {
      if (now >= (this.cooldownUntil.get(i) || 0)) return i;
    }
    return null;
  }

  _msUntilSoonestKey(now = Date.now()) {
    if (this.keys.length === 0) return 0;
    let soonest = Infinity;
    for (let i = 0; i < this.keys.length; i++) {
      soonest = Math.min(soonest, Math.max(0, (this.cooldownUntil.get(i) || 0) - now));
    }
    return soonest === Infinity ? 0 : soonest;
  }

  status() {
    const now = Date.now();
    return {
      configured: this.keys.length > 0,
      keyCount: this.keys.length,
      keysAvailable: this.keys.filter((_, i) => now >= (this.cooldownUntil.get(i) || 0)).length,
      nextKeyInMs: this._msUntilSoonestKey(now),
      model: this.model,
    };
  }

  /**
   * Runs one call, retrying only what is worth retrying.
   *
   * A transient failure is the service or the network, and the same request sent
   * again a moment later usually succeeds. Everything else — a rejected key, an
   * unknown model, a malformed conversation — fails identically however many times
   * it is sent, so it is raised at once rather than after three seconds of pointless
   * waiting. A rate limit is not retried here either: the caller has another key to
   * try, which is faster than waiting for this one to cool.
   */
  async _withTransientRetries(attempt, signal) {
    let last;
    for (let i = 0; i <= TRANSIENT_RETRIES; i++) {
      try {
        return await attempt();
      } catch (err) {
        if (!err.transient || err.rateLimited || signal?.aborted) throw err;
        last = err;
        if (i < TRANSIENT_RETRIES) {
          await new Promise((r) => setTimeout(r, TRANSIENT_BACKOFF_MS * (i + 1)));
        }
      }
    }
    throw last;
  }

  async _callOnce(keyIndex, contents, systemInstruction, tools, signal = null,
                  generationConfig = null) {
    const body = { contents };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (tools) body.tools = tools;
    // Optional, and absent for every existing caller. It exists so that the
    // callers who need machine-readable output — describing a file, expanding a
    // search — can ask the API to emit JSON rather than hoping prose parses.
    if (generationConfig) body.generationConfig = generationConfig;

    // Two things can end this request: the timeout, and the user pressing Stop.
    // Both are aborts, and they are combined rather than raced by hand so that
    // whichever fires first tears down the same fetch.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const composite = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    try {
      const resp = await fetch(
        `${ENDPOINT}/${this.model}:generateContent?key=${encodeURIComponent(this.keys[keyIndex])}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: composite,
        }
      );
      const text = await resp.text();
      if (!resp.ok) throw httpError(resp.status, text, this.model);
      return JSON.parse(text);
    } catch (err) {
      // An abort is not a failure to report as one, and which abort it was decides
      // what the user is told — so the two are told apart here rather than both
      // surfacing as the opaque "This operation was aborted".
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        if (signal?.aborted) {
          const stopped = new Error('Stopped.');
          stopped.code = 'CANCELLED';
          throw stopped;
        }
        const slow = new Error(
          `The model did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`);
        slow.code = 'TIMEOUT';
        slow.transient = true;
        throw slow;
      }
      // fetch itself failing is the network rather than the service, and is worth
      // the same retry.
      if (err instanceof TypeError) {
        const net = new Error('Could not reach the Gemini API. Check the network connection.');
        net.code = 'NETWORK';
        net.transient = true;
        throw net;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends a conversation and returns the raw candidate.
   * @param {Array} contents Gemini `contents` array
   * @throws when no key could complete the request
   */
  async generate(contents, { systemInstruction = null, tools = null, signal = null,
                             generationConfig = null } = {}) {
    if (signal?.aborted) {
      const stopped = new Error('Stopped.');
      stopped.code = 'CANCELLED';
      throw stopped;
    }
    if (this.keys.length === 0) {
      const err = new Error(
        'No Gemini API key is configured. Set GEMINI_API_KEYS in the environment, ' +
        'or copy config.example.js to config.js and add one.'
      );
      err.code = 'NO_KEY';
      throw err;
    }

    const errors = [];

    // Pass 1: every key not in cooldown.
    for (let attempt = 0; attempt < this.keys.length; attempt++) {
      const idx = this._availableKeyIndex();
      if (idx === null) break;
      try {
        return await this._withTransientRetries(
          () => this._callOnce(idx, contents, systemInstruction, tools, signal, generationConfig), signal);
      } catch (err) {
        if (err.code === 'CANCELLED') throw err;
        if (err.rateLimited) {
          this.cooldownUntil.set(idx, Date.now() + RATE_LIMIT_COOLDOWN_MS);
          errors.push(`key ${idx}: rate limited`);
          continue;
        }
        errors.push(`key ${idx}: ${err.message}`);
        throw err;   // a non-rate-limit failure is real; do not mask it
      }
    }

    // Pass 2: everything is cooling. Wait for the soonest and try once more.
    const waitMs = this._msUntilSoonestKey();
    if (waitMs > 0 && waitMs <= RATE_LIMIT_COOLDOWN_MS + 1000) {
      await new Promise((r) => setTimeout(r, waitMs + 250));
      const idx = this._availableKeyIndex();
      if (idx !== null) {
        try {
          return await this._withTransientRetries(
            () => this._callOnce(idx, contents, systemInstruction, tools, signal, generationConfig), signal);
        } catch (err) {
          if (err.code === 'CANCELLED') throw err;
          if (err.rateLimited) this.cooldownUntil.set(idx, Date.now() + RATE_LIMIT_COOLDOWN_MS);
          errors.push(`key ${idx} after wait: ${err.message}`);
        }
      }
    }

    const err = new Error(
      `Every configured Gemini key is rate limited. Tried ${this.keys.length} key(s): ` +
      errors.join('; ')
    );
    err.code = 'ALL_KEYS_EXHAUSTED';
    err.retryAfterMs = this._msUntilSoonestKey();
    throw err;
  }

  /** Convenience: plain text in, plain text out. */
  async text(prompt, systemInstruction = null) {
    const resp = await this.generate(
      [{ role: 'user', parts: [{ text: prompt }] }],
      { systemInstruction }
    );
    const parts = resp?.candidates?.[0]?.content?.parts || [];
    return answerText(parts);
  }
}

module.exports = {
  GeminiClient, RATE_LIMIT_COOLDOWN_MS, DEFAULT_MODEL, answerText, httpError,
};
