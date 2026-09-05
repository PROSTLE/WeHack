// Dictation and the wake word's model store.
//
// Neither the microphone nor the recogniser can be exercised from Node, so what
// is tested here is everything around them: which engine a given configuration
// actually selects, that a failure in the fast engine falls back rather than
// failing the user, that the key never has to be right for a bad recording to
// be refused, and that a half-finished model download is never mistaken for a
// finished one.

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { GroqClient } = require('../src/main/llm/groq.js');
const { WakeModelStore, MODEL } = require('../src/main/wake/model-store.js');
const { transcribe, resolveEngine } = require('../src/main/llm/voice.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}

/** Base64 for `n` bytes, long enough to clear the minimum-length gate. */
const payload = (n) => Buffer.alloc(n, 7).toString('base64');
const GOOD = { data: payload(40_000), mimeType: 'audio/wav' };

/** A Gemini stand-in, as the existing voice tests use. */
function fakeGemini(reply, { throws = null } = {}) {
  const calls = [];
  return {
    calls,
    available: true,
    status: () => ({ model: 'gemini-3.5-flash-lite', configured: true }),
    generate: async (contents, opts) => {
      calls.push({ contents, opts });
      if (throws) throw throws;
      return { candidates: [{ content: { parts: [{ text: reply }] } }] };
    },
  };
}

/** A Groq stand-in built on an injected fetch. */
function fakeGroq(handler, key = 'gsk_' + 'k'.repeat(40)) {
  const client = new GroqClient({ key });
  const calls = [];
  client.transcribeCalls = calls;
  const realFetch = globalThis.fetch;
  client._install = () => { globalThis.fetch = async (...args) => { calls.push(args); return handler(...args); }; };
  client._restore = () => { globalThis.fetch = realFetch; };
  return client;
}

const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

(async () => {
  console.log('-- which engine answers --');

  ok('a bare Gemini client is still the Gemini path, as the old callers pass it',
    resolveEngine(fakeGemini('x')).engine === 'gemini');

  ok('Groq preferred and configured wins',
    resolveEngine({ gemini: fakeGemini('x'), groq: { available: true }, engine: 'groq' }).engine === 'groq');

  ok('Groq preferred but unconfigured falls back rather than failing',
    resolveEngine({ gemini: fakeGemini('x'), groq: { available: false }, engine: 'groq' }).engine === 'gemini');

  ok('Gemini preferred is honoured even when Groq is available',
    resolveEngine({ gemini: fakeGemini('x'), groq: { available: true }, engine: 'gemini' }).engine === 'gemini');

  console.log('\n-- a recording is checked before any engine is reached --');

  const neverReaches = async (audio) => {
    const g = fakeGemini('unused');
    const q = fakeGroq(async () => jsonResponse({ text: 'unused' }));
    q._install();
    try {
      await transcribe({ gemini: g, groq: q, engine: 'groq' }, audio);
      return 'accepted';
    } catch {
      return g.calls.length === 0 && q.transcribeCalls.length === 0 ? null : 'sent anyway';
    } finally {
      q._restore();
    }
  };

  ok('an unaccepted format never reaches Groq either',
    (await neverReaches({ data: payload(50_000), mimeType: 'audio/x-raw' })) === null);
  ok('a too-short recording never reaches Groq either',
    (await neverReaches({ data: payload(500), mimeType: 'audio/wav' })) === null);
  ok('a payload that is not base64 never reaches Groq either',
    (await neverReaches({ data: 'not base64!!', mimeType: 'audio/wav' })) === null);

  console.log('\n-- Groq answers --');

  {
    const q = fakeGroq(async () => jsonResponse({ text: 'where is my tax return' }));
    q._install();
    const out = await transcribe({ gemini: fakeGemini('no'), groq: q, engine: 'groq' }, GOOD);
    q._restore();
    ok('the words come back from Groq', out.text === 'where is my tax return', out.text);
    ok('and the answer says which engine produced it', out.engine === 'groq', out.engine);
    ok('an empty transcript is reported as empty, not guessed at',
      (await (async () => {
        const q2 = fakeGroq(async () => jsonResponse({ text: '   ' }));
        q2._install();
        const r = await transcribe({ gemini: null, groq: q2, engine: 'groq' }, GOOD);
        q2._restore();
        return r.empty === true && r.text === '';
      })()));
  }

  {
    // The vocabulary hint and the filename both matter, and both are easy to
    // regress into nothing: Whisper picks its demuxer from the extension.
    let sent = null;
    const q = fakeGroq(async (_url, init) => { sent = init.body; return jsonResponse({ text: 'ok' }); });
    q._install();
    await transcribe({ gemini: null, groq: q, engine: 'groq' }, GOOD);
    q._restore();
    ok('the audio is sent with a filename Whisper can demux',
      sent.get('file')?.name === 'speech.wav', sent.get('file')?.name);
    ok('the model is the turbo one', sent.get('model') === 'whisper-large-v3-turbo');
    ok('a vocabulary hint is sent, so filenames are misheard less',
      /PDF|DOCX/.test(sent.get('prompt') || ''));
    ok('the temperature is zero: this is transcription, not writing',
      sent.get('temperature') === '0');
  }

  console.log('\n-- when Groq cannot answer --');

  {
    const gem = fakeGemini('the fallback heard this');
    const q = fakeGroq(async () => { throw new TypeError('network down'); });
    q._install();
    const out = await transcribe({ gemini: gem, groq: q, engine: 'groq' }, GOOD);
    q._restore();
    ok('an unreachable Groq falls back to Gemini rather than failing the user',
      out.text === 'the fallback heard this' && out.engine === 'gemini', out.engine);
  }

  {
    const gem = fakeGemini('should not be reached');
    const q = fakeGroq(async () => jsonResponse({ error: { message: 'bad key' } }, 401));
    q._install();
    let code = null;
    try {
      await transcribe({ gemini: gem, groq: q, engine: 'groq' }, GOOD);
    } catch (err) { code = err.code; }
    q._restore();
    ok('a wrong key is reported rather than hidden behind a fallback', code === 'BAD_KEY', String(code));
    ok('and the fallback was not quietly used instead', gem.calls.length === 0);
  }

  {
    const q = fakeGroq(async () => jsonResponse({ error: { message: 'slow down' } }, 429, { 'retry-after': '30' }));
    q._install();
    let err1 = null;
    try { await transcribe({ gemini: null, groq: q, engine: 'groq' }, GOOD); } catch (e) { err1 = e; }
    ok('a rate limit is named as one', err1?.code === 'RATE_LIMITED', String(err1?.code));
    ok('and says when it lifts', err1?.retryAfterMs === 30_000, String(err1?.retryAfterMs));

    // The second call must not spend a request to be told the same thing.
    const before = q.transcribeCalls.length;
    let err2 = null;
    try { await transcribe({ gemini: null, groq: q, engine: 'groq' }, GOOD); } catch (e) { err2 = e; }
    q._restore();
    ok('a limit in force is not re-tested against the API',
      q.transcribeCalls.length === before && err2?.code === 'RATE_LIMITED');
  }

  {
    const q = new GroqClient({ key: '' });
    ok('an unconfigured client reports itself unavailable', q.available === false);
    ok('and setting a key makes it available', q.setKey('gsk_' + 'z'.repeat(40)) === true);
    ok('the status never returns the key itself',
      !JSON.stringify(q.status()).includes('zzzz' + 'z'.repeat(30)));
  }

  console.log('\n-- the wake word’s model store --');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexa-wake-'));

  {
    const store = new WakeModelStore(dir, { fetch: async () => { throw new Error('should not be called'); } });
    ok('an absent model is not ready', (await store.isReady()) === false);
    ok('and its status offers no URL to load', (await store.status()).url === null);
  }

  {
    // A truncated download must not be accepted: it would fail much later,
    // inside a worker, as "the recogniser would not start".
    const short = Buffer.alloc(1024, 3);
    const store = new WakeModelStore(dir, {
      fetch: async () => new Response(short, { headers: { 'content-length': String(short.length) } }),
    });
    let code = null;
    try { await store.ensure(); } catch (err) { code = err.code; }
    ok('a short download is refused as truncated', code === 'TRUNCATED', String(code));
    ok('and leaves nothing behind that would pass as a model', (await store.isReady()) === false);
    ok('not even a .part file', !fs.existsSync(store.partFile));
  }

  {
    // A complete one is accepted, cached, and not fetched twice.
    const full = Buffer.alloc(MODEL.bytes, 9);
    let fetches = 0;
    const store = new WakeModelStore(dir, {
      fetch: async () => { fetches++; return new Response(full, { headers: { 'content-length': String(MODEL.bytes) } }); },
    });
    const seen = [];
    const out = await store.ensure((p) => seen.push(p));
    ok('a complete download is accepted', out.ready === true && (await store.isReady()));
    ok('and reports progress while it arrives', seen.length > 0 && seen.at(-1).ratio === 1);
    ok('the URL it hands back is the custom scheme, not a file path',
      out.url.startsWith('nexa-model://'), out.url);

    const again = await store.ensure();
    ok('a cached model is not downloaded again', again.cached === true && fetches === 1);

    await store.remove();
    ok('removing it makes it not ready again', (await store.isReady()) === false);
  }

  await fsp.rm(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('unexpected failure:', err);
  process.exit(1);
});
