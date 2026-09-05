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

  async _callOnce(keyIndex, contents, systemInstruction, tools) {
    const body = { contents };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (tools) body.tools = tools;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(
        `${ENDPOINT}/${this.model}:generateContent?key=${encodeURIComponent(this.keys[keyIndex])}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );
      const text = await resp.text();
      if (!resp.ok) {
        const err = new Error(`Gemini HTTP ${resp.status}: ${text.slice(0, 300)}`);
        err.status = resp.status;
        err.rateLimited = resp.status === 429 || /RESOURCE_EXHAUSTED/.test(text);
        throw err;
      }
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends a conversation and returns the raw candidate.
   * @param {Array} contents Gemini `contents` array
   * @throws when no key could complete the request
   */
  async generate(contents, { systemInstruction = null, tools = null } = {}) {
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
        return await this._callOnce(idx, contents, systemInstruction, tools);
      } catch (err) {
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
          return await this._callOnce(idx, contents, systemInstruction, tools);
        } catch (err) {
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

module.exports = { GeminiClient, RATE_LIMIT_COOLDOWN_MS, DEFAULT_MODEL, answerText };
