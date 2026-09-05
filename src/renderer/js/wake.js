// Listening for "Hey Nexa".
//
// Read this before switching it on, because it is the one feature in NexaFiles
// that trades privacy for convenience, and the trade should be made knowingly.
//
// HOW IT WORKS
//
//   1. The microphone is held open. Audio is analysed on this machine, in this
//      process, and the overwhelming majority of it never leaves: a level meter
//      runs over the signal and nothing is recorded while the room is quiet.
//   2. When the level rises above the speech threshold, and falls again, that
//      one short utterance is captured.
//   3. Only if it is *wake-phrase shaped* — between 0.4 and 2.5 seconds — is it
//      transcribed, which means sending those two seconds to Google. Anything
//      longer is a sentence, not a wake phrase, and is discarded here without
//      being sent.
//   4. If the transcript begins with the wake phrase, the panel opens. Otherwise
//      the transcript is dropped and nothing is kept.
//
// WHAT THIS COSTS
//
// Short utterances near the microphone are sent to Google to be checked, whether
// or not they were addressed to this application. That is a real cost and it is
// why this is off by default and why nothing here is enabled quietly. There is
// no way around it without shipping a keyword-spotting model, which this project
// has no runtime dependencies to carry — and an on-device detector written from
// scratch would be so unreliable that people would leave the panel open instead,
// which is worse for privacy than either option.
//
// The operating system's own recording indicator is the honest signal that this
// is running, and it is deliberately the one we rely on: it is drawn by the OS,
// NexaFiles cannot suppress it, and it does not go out while the microphone is
// open. If it is lit and you did not expect it, this is why.
//
// Nothing is written to disk at any point. The rolling buffer is a few seconds
// of samples in memory, overwritten continuously and dropped when listening
// stops.

const TARGET_RATE = 16_000;

// A wake phrase is short. Anything outside this is not one, and is discarded
// rather than sent — this bound is most of what keeps ordinary conversation off
// the network.
const MIN_UTTERANCE_MS = 400;
const MAX_UTTERANCE_MS = 2_500;

// Level above which the signal is a voice rather than a room, and how long it
// must stay below that before the utterance is treated as finished.
const SPEECH_LEVEL = 0.045;
const TRAILING_SILENCE_MS = 420;

// A floor between checks, so a noisy room cannot turn into a stream of requests.
const MIN_CHECK_INTERVAL_MS = 1_500;

// What counts as the phrase. Deliberately generous: "Nexa" is not a word any
// speech model has strong priors for, and it comes back as "Nexus", "next" or
// "Nexo" often enough that being strict would mean a wake word that mostly does
// not wake. Every one of these still requires the "hey" in front of it, which is
// what stops the panel opening every time the application is mentioned.
const WAKE_PATTERN = /^\s*(?:hey|hi|hay|ok|okay)[,!.\s]+(?:nexa|nexus|next|nexo|nexar|lexa|nexia|necksa)\b/i;

let session = null;

export function isSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.AudioContext);
}

export function isListening() {
  return !!session;
}

/**
 * Starts listening for the phrase.
 *
 * @param {object} opts
 * @param {() => void} opts.onWake            the phrase was heard
 * @param {(text: string) => void} [opts.onHeard]  a checked utterance that was not it
 * @param {(err: Error) => void} [opts.onError]
 * @param {(audio: object) => Promise<{text: string}>} opts.transcribe
 * @param {() => boolean} [opts.paused]       true while checking should be skipped
 */
export async function start({ onWake, onHeard, onError, transcribe, paused }) {
  if (session) return session;
  if (!isSupported()) throw new Error('This build cannot record audio.');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
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

  // A ScriptProcessor rather than an AudioWorklet: a worklet's module has to be
  // fetched by URL, and this renderer's content security policy forbids every
  // origin including its own for that purpose. The node is deprecated and this
  // is a 16 kHz mono stream — the work it does per block is a sum of squares.
  const BLOCK = 2048;
  const processor = ctx.createScriptProcessor(BLOCK, 1, 1);

  // Kept just long enough to hold a wake phrase plus the moment before it, so
  // the captured utterance does not start halfway through the word "hey".
  const PRE_ROLL_BLOCKS = Math.ceil((TARGET_RATE * 0.35) / BLOCK);
  const preRoll = [];

  let speaking = false;
  let quietSince = 0;
  let captured = [];
  let lastCheckAt = 0;

  const state = { stream, ctx, source, processor, stopped: false };
  session = state;

  processor.onaudioprocess = (event) => {
    if (state.stopped) return;
    const input = event.inputBuffer.getChannelData(0);

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const now = performance.now();

    // While the panel is open, its own microphone is the one that matters. The
    // stream here keeps running so the two are not fighting over the device, but
    // nothing is captured and nothing is checked.
    if (paused?.()) {
      speaking = false;
      captured = [];
      return;
    }

    const block = new Float32Array(input);   // the event's buffer is reused

    if (!speaking) {
      preRoll.push(block);
      if (preRoll.length > PRE_ROLL_BLOCKS) preRoll.shift();
      if (rms > SPEECH_LEVEL) {
        speaking = true;
        captured = [...preRoll, block];
        quietSince = 0;
      }
      return;
    }

    captured.push(block);

    if (rms > SPEECH_LEVEL) {
      quietSince = 0;
    } else if (!quietSince) {
      quietSince = now;
    }

    const spokenMs = (captured.length * BLOCK / TARGET_RATE) * 1000;
    const finished = quietSince && now - quietSince > TRAILING_SILENCE_MS;

    // Too long to be a wake phrase: this is someone talking. Dropped here,
    // without being sent anywhere.
    if (spokenMs > MAX_UTTERANCE_MS) {
      speaking = false;
      captured = [];
      return;
    }

    if (!finished) return;

    const utterance = captured;
    speaking = false;
    captured = [];

    const lengthMs = (utterance.length * BLOCK / TARGET_RATE) * 1000;
    if (lengthMs < MIN_UTTERANCE_MS) return;
    if (now - lastCheckAt < MIN_CHECK_INTERVAL_MS) return;
    lastCheckAt = now;

    check(utterance).catch((err) => onError?.(err));
  };

  async function check(blocks) {
    const wav = encodeWav(concat(blocks), TARGET_RATE);
    let result;
    try {
      result = await transcribe({
        data: base64FromBuffer(wav),
        mimeType: 'audio/wav',
      });
    } catch {
      return;   // a failed check is not an event; the next utterance tries again
    }
    if (state.stopped) return;
    const text = String(result?.text || '').trim();
    if (!text) return;
    if (WAKE_PATTERN.test(text)) onWake?.();
    else onHeard?.(text);
  }

  source.connect(processor);
  // Connected to a silent gain node rather than to the speakers: a
  // ScriptProcessor does not run unless its output is connected to something,
  // and connecting it to the destination would play the microphone back into
  // the room.
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
  session = null;
}

// ── encoding, shared in shape with voice.js ─────────────────────────────────

function concat(blocks) {
  let length = 0;
  for (const b of blocks) length += b.length;
  const out = new Float32Array(length);
  let at = 0;
  for (const b of blocks) { out.set(b, at); at += b.length; }
  return out;
}

/** Mono 16-bit PCM in a WAV container. */
function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return buffer;
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export { WAKE_PATTERN, MIN_UTTERANCE_MS, MAX_UTTERANCE_MS };
