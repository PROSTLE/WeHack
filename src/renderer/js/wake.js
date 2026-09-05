// Listening for "Hey Nexa".
//
// WHAT CHANGED, AND WHY
//
// This used to work by sending audio away to be recognised. A level meter
// watched for an utterance, waited for it to end, encoded it, and posted it to
// Gemini to ask what had been said. It worked, and it was slow in a way no
// amount of tuning could fix: the phrase could not be recognised until the
// speaker had stopped talking (420 ms of trailing silence), and then not until
// a network round-trip and an LLM inference had completed (another 600–2500 ms).
// Between one and three seconds, every time, before a panel appeared — and a
// missed recognition cost the whole of it again.
//
// Recognition now happens here, on this machine, using Vosk: a Kaldi speech
// recogniser compiled to WebAssembly, running in a worker, against a 40 MB
// acoustic model cached in userData. The consequences are the point:
//
//   * It is fast. Vosk emits *partial* results while someone is still speaking,
//     so the phrase is matched at the moment the last syllable lands rather than
//     after a silence timeout. There is no trailing-silence wait and no network
//     leg, so the panel opens in roughly the time it takes to draw it.
//   * It is accurate, because it is a speech recogniser rather than a language
//     model asked to act as one, and because a miss costs nothing — every audio
//     block is examined instead of one buffered utterance per 1.5 seconds.
//   * Nothing leaves the machine. Not the audio, not a transcript, not the fact
//     that someone spoke. The model download is the only network access this
//     feature ever makes, it happens once, and it happens when the user switches
//     the feature on.
//
// The operating system's recording indicator is still the honest signal that
// the microphone is open, and it is still deliberately the one relied on. What
// has changed is what sits behind it.
//
// Nothing is written to disk at any point. Audio exists as a few blocks of
// Float32 in memory on their way into the recogniser and is overwritten
// continuously.
//
// ON "NEXA" NOT BEING A WORD
//
// Vosk can be given a grammar — a closed list of phrases — which is normally
// the right way to spot a keyword, because it makes everything else
// unrecognisable and the match near-certain. It is not usable here: a grammar
// may only contain words in the model's lexicon, and "Nexa" is not an English
// word and is not in it. Asking for one would fail outright.
//
// So recognition is free-form and the matching is done below, against what this
// model actually returns for that sound — which was measured rather than
// guessed at, and is written out in full above `matchesWake`. The previous
// implementation had reached the same accommodation empirically, listing
// "nexus", "next" and "nexo" as acceptable; the difference is that the list
// here comes from running the real recogniser over real speech, and so does
// the rule that decides what to do with it.
//
// WHERE THIS RUNS
//
// In the hidden listener window (src/renderer/wake.html), not in the panel.
// The recogniser's WebAssembly glue needs 'unsafe-eval', and the panel is the
// window that renders file names and document text — granting it there would
// widen the blast radius of any escaping mistake in the panel. The listener
// renders nothing and never displays user content, so the permission is
// confined to a document that has no injection surface to speak of.

const TARGET_RATE = 16_000;

// Blocks fed to the recogniser. 128 ms at 16 kHz — small enough that a partial
// result lands promptly, large enough not to cross the worker boundary
// needlessly often.
const BLOCK = 2048;

// Below this the block is a quiet room, and feeding it to the recogniser costs
// CPU to be told so. This is an efficiency gate, not the detector: it is set far
// beneath speech, and anything at all ambiguous is passed through.
const NOISE_GATE = 0.012;

// How long the recogniser goes on being fed after the level drops, so a phrase
// is not cut off by the pause in the middle of "hey… Nexa".
const HANGOVER_MS = 700;

// Audio kept from before the gate opened, so the recogniser hears the start of
// "hey" rather than joining halfway through it.
const PRE_ROLL_MS = 300;

// After firing, this long before the phrase can fire again. It stops one
// utterance opening the panel twice as further partials arrive, and is short
// enough that a deliberate second summon still works.
const REFRACTORY_MS = 1_200;

// ── matching ────────────────────────────────────────────────────────────────
//
// This section is written against measurements, not guesses. test/tools/
// wake-truth.js feeds recorded speech through this exact model and prints what
// comes back; every rule below exists because of something in that output.
//
// What the recogniser returns when a person says "Hey Nexa", across four
// different voices:
//
//     "the next"        "hey next"       "hey next so"
//     "the next up"     "the next of find my downloads"
//     "the next a where are my screen shots"
//
// Three things follow from that, and they are the whole design:
//
//   1. "Nexa" never comes back as "nexa". It is not in the model's lexicon, so
//      the closest in-vocabulary word wins, and that word is almost always
//      "next". Matching the spelling would mean never waking.
//   2. The "hey" is not reliable either — half the voices produce "the". So the
//      leading word cannot be required to be a greeting.
//   3. What *is* reliable is position. The name lands in the first two words of
//      the utterance every single time, and in ordinary speech containing the
//      word "next" it does not: "go to the next file", "open the next folder",
//      "send me the next slide" all put it at index two or later.
//
// Position is therefore the primary signal, and it leaves exactly one genuine
// collision: "next week" and "the next week" begin the same way the wake phrase
// does. That is what FOLLOWERS handles — the word after the name. "week" makes
// it a sentence about time; "of", "a", "so", "up" or nothing at all make it the
// mangled tail of "Nexa".

// The name, as this model actually renders it, plus the spellings a different
// voice or a real human plausibly produces.
const NAMES = [
  'next', 'nexa', 'nexus', 'nexo', 'nexar', 'lexa', 'nexia', 'necksa',
  'nexis', 'nexen', 'lexus', 'necks', 'annex', 'annexe', 'nexium',
];

// Words that may precede the name. "hey" and its cousins are the strong ones;
// "the", "a" and "and" are what the recogniser substitutes for "hey" when the
// speaker does not over-enunciate, which is most of the time.
const STRONG_LEADERS = ['hey', 'hay', 'hi', 'high', 'ok', 'okay', 'eh', 'ay'];
const WEAK_LEADERS = ['the', 'a', 'and', 'they', 'he', 'her', 'to', 'that', 'this', 'if'];

// If one of these follows the name, this was a sentence about something else.
// "next week", "the next one", "the next step" — all ordinary English, all
// beginning exactly the way the wake phrase does.
const FOLLOWERS = [
  'week', 'weeks', 'time', 'times', 'one', 'ones', 'day', 'days', 'month',
  'months', 'year', 'years', 'morning', 'night', 'page', 'pages', 'slide',
  'slides', 'file', 'files', 'folder', 'folders', 'step', 'steps', 'item',
  'items', 'line', 'lines', 'level', 'chapter', 'section', 'question',
  'meeting', 'door', 'kin', 'thing', 'things', 'part', 'round', 'song',
  'track', 'video', 'episode', 'stop', 'train', 'bus', 'flight', 'appointment',
];

const words = (text) => String(text || '')
  .toLowerCase()
  .replace(/[^a-z\s]/g, ' ')
  .split(/\s+/)
  .filter(Boolean);

/**
 * Whether a recognised string is the wake phrase.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.final] true for a completed utterance, false for a
 *   partial that may still be growing. It matters: on a partial, "the next" has
 *   not yet ruled out "the next week", so a weakly-led match waits for either
 *   the following word or the end of the utterance. A strongly-led one — "hey
 *   next" — is unambiguous and fires immediately, which is the common case and
 *   the fast path.
 */
export function matchesWake(text, { final = false } = {}) {
  const w = words(text);

  // The name has to be one of the first two words. This is the rule doing most
  // of the work; without it every "next" in ordinary speech is a wake word.
  for (let i = 0; i < Math.min(2, w.length); i++) {
    if (!isName(w[i])) continue;

    const leader = i > 0 ? w[i - 1] : null;
    // A word before the name that is neither a greeting nor one of the things
    // the recogniser substitutes for one — "my nexus phone" — is a sentence.
    if (leader !== null && !STRONG_LEADERS.includes(leader) && !WEAK_LEADERS.includes(leader)) {
      continue;
    }

    const follower = w[i + 1] || null;
    if (follower && FOLLOWERS.includes(follower)) return false;

    // Strongly led: "hey next" cannot be anything else, so it fires on the
    // partial without waiting to see what comes after it.
    if (leader !== null && STRONG_LEADERS.includes(leader)) return true;

    // Weakly led, or no leader at all. A following word that is not an ordinary
    // one is the tail of "Nexa" ("the next of…"), and settles it. Otherwise the
    // utterance has to be over before "the next" can be told from "the next
    // week", which costs the fraction of a second between the last syllable and
    // the recogniser closing the segment.
    if (follower) return true;
    if (final) return true;
  }
  return false;
}

/** A token that is the name, allowing for one letter of slop in the spelling. */
function isName(word) {
  if (!word) return false;
  if (NAMES.includes(word)) return true;
  // Only for longer tokens: at three letters a single edit reaches too far.
  return word.length >= 5 && NAMES.some((n) => n.length >= 4 && withinOneEdit(word, n));
}

/** Levenshtein distance ≤ 1, decided without building the matrix. */
function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let slack = 1;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (slack-- === 0) return false;
    if (short.length === long.length) { i++; j++; } else { j++; }
  }
  return true;
}

// ── the model, loaded once and kept warm ────────────────────────────────────

let modelPromise = null;

/**
 * Loads the acoustic model, at most once per renderer.
 *
 * Held in a promise rather than reloaded per session because unpacking 40 MB
 * takes a second or two, and paying that when the user toggles the setting is
 * very different from paying it when they speak.
 */
function loadModel(modelUrl) {
  if (modelPromise) return modelPromise;
  if (!window.Vosk?.createModel) {
    return Promise.reject(new Error('The speech recogniser failed to load.'));
  }
  // Log level -1 silences Kaldi, which is otherwise extremely chatty on stderr.
  modelPromise = window.Vosk.createModel(modelUrl, -1).catch((err) => {
    modelPromise = null;      // a failed load must not be cached as the answer
    throw err;
  });
  return modelPromise;
}

/** Drops the cached model, freeing the worker and its memory. */
export function unloadModel() {
  const pending = modelPromise;
  modelPromise = null;
  pending?.then((m) => { try { m.terminate(); } catch { /* already gone */ } })
         .catch(() => { /* it never loaded */ });
}

// ── the session ─────────────────────────────────────────────────────────────

let session = null;

export function isSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.AudioContext && window.Vosk);
}

export function isListening() {
  return !!session;
}

/**
 * Starts listening for the phrase.
 *
 * @param {object} opts
 * @param {string} opts.modelUrl              where the cached model is served
 * @param {() => void} opts.onWake            the phrase was heard
 * @param {(text: string) => void} [opts.onHeard]  recognised speech that was not it
 * @param {(err: Error) => void} [opts.onError]
 * @param {() => boolean} [opts.paused]       true while detection should be skipped
 */
export async function start({ modelUrl, onWake, onHeard, onError, paused }) {
  if (session) return session;
  if (!isSupported()) throw new Error('This build cannot listen for the wake word.');
  if (!modelUrl) throw new Error('The speech model has not been downloaded yet.');

  // The model first: opening the microphone and then failing to load would
  // light the recording indicator for a feature that is not going to work.
  const model = await loadModel(modelUrl);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        // Deliberately off, unlike the dictation path. Automatic gain control
        // continuously renormalises the signal, which moves the noise floor
        // under the gate below and makes a fixed threshold meaningless in a
        // quiet room. The recogniser does not need a normalised level.
        autoGainControl: false,
      },
    });
  } catch (err) {
    const named = new Error(
      err?.name === 'NotAllowedError'
        ? 'The microphone was refused, so “Hey Nexa” cannot listen. Allow microphone ' +
          'access for desktop apps in your system privacy settings.'
        : err?.name === 'NotFoundError'
          ? 'No microphone was found, so “Hey Nexa” cannot listen.'
          : err?.message || 'The microphone could not be opened.'
    );
    named.code = err?.name;
    throw named;
  }

  const ctx = new AudioContext({ sampleRate: TARGET_RATE });
  const source = ctx.createMediaStreamSource(stream);

  // A ScriptProcessor rather than an AudioWorklet, for the reason the previous
  // implementation gave and which still holds: a worklet's module has to be
  // fetched by URL and this renderer's policy forbids that. The work done per
  // block here is a sum of squares and a copy.
  const processor = ctx.createScriptProcessor(BLOCK, 1, 1);

  const recognizer = new model.KaldiRecognizer(TARGET_RATE);
  recognizer.setWords(false);      // the text is all that is matched against

  const state = {
    stream, ctx, source, processor, recognizer,
    stopped: false, firedAt: 0, lastPartial: '',
  };
  session = state;

  const fire = () => {
    const now = performance.now();
    if (now - state.firedAt < REFRACTORY_MS) return;
    state.firedAt = now;
    onWake?.();
  };

  recognizer.on('partialresult', (message) => {
    if (state.stopped) return;
    const partial = message?.result?.partial || '';
    if (!partial || partial === state.lastPartial) return;
    state.lastPartial = partial;
    // This is the fast path, and the reason the panel now appears while the
    // speaker is still finishing the word: partials arrive mid-utterance.
    if (matchesWake(partial, { final: false })) fire();
  });

  recognizer.on('result', (message) => {
    if (state.stopped) return;
    state.lastPartial = '';
    const text = message?.result?.text || '';
    if (!text) return;
    if (matchesWake(text, { final: true })) fire();
    else onHeard?.(text);
  });

  recognizer.on('error', (message) => {
    onError?.(new Error(message?.error || 'The recogniser failed.'));
  });

  const preRollBlocks = Math.max(1, Math.round((TARGET_RATE * (PRE_ROLL_MS / 1000)) / BLOCK));
  const preRoll = [];
  let openUntil = 0;

  processor.onaudioprocess = (event) => {
    if (state.stopped) return;
    const input = event.inputBuffer.getChannelData(0);

    // While the panel is open its own microphone is the one that matters. The
    // stream keeps running so the two are not fighting over the device, but
    // nothing is recognised and the recogniser is not fed.
    if (paused?.()) {
      preRoll.length = 0;
      openUntil = 0;
      return;
    }

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const now = performance.now();

    // The event's buffer is reused by the browser, so it is copied before being
    // held or handed across the worker boundary.
    const block = new Float32Array(input);

    if (rms > NOISE_GATE) {
      // Opening: the pre-roll goes in first so the recogniser hears the attack
      // of the first word rather than its middle.
      if (now > openUntil) {
        for (const held of preRoll) feed(held);
        preRoll.length = 0;
      }
      openUntil = now + HANGOVER_MS;
      feed(block);
      return;
    }

    if (now < openUntil) {
      feed(block);          // still inside the hangover; the phrase may continue
      return;
    }

    preRoll.push(block);
    if (preRoll.length > preRollBlocks) preRoll.shift();
  };

  function feed(block) {
    try {
      state.recognizer.acceptWaveformFloat(block, TARGET_RATE);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  source.connect(processor);
  // Connected to a silent gain node rather than the speakers: a ScriptProcessor
  // does not run unless its output goes somewhere, and the destination would
  // play the microphone back into the room.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  processor.connect(sink);
  sink.connect(ctx.destination);
  state.sink = sink;

  return state;
}

/** Closes the microphone and tears the graph down. Safe to call twice. */
export function stop() {
  const state = session;
  if (!state || state.stopped) { session = null; return; }
  state.stopped = true;
  try { state.processor.onaudioprocess = null; } catch { /* already gone */ }
  try { state.processor.disconnect(); } catch { /* already gone */ }
  try { state.sink?.disconnect(); } catch { /* already gone */ }
  try { state.source.disconnect(); } catch { /* already gone */ }
  try { state.stream.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
  try { state.ctx.close(); } catch { /* already closed */ }
  // The recogniser is removed but the model is kept: it is expensive to load
  // and the user is likely to switch this back on.
  try { state.recognizer.remove(); } catch { /* already gone */ }
  session = null;
}

export { NAMES, STRONG_LEADERS, WEAK_LEADERS, FOLLOWERS, REFRACTORY_MS, NOISE_GATE };
