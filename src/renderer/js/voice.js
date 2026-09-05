// Spoken input, captured in the renderer.
//
// The microphone is opened when the user presses the button and closed the
// moment they stop — every track is stopped and the audio graph is torn down,
// so the operating system's recording indicator goes out with the button. A
// stream is never held open between questions "in case", because a held stream
// is a live microphone the user has no reason to believe is live.
//
// What leaves here is a 16 kHz mono WAV. The browser records Opus in a WebM
// container, which is compact but not a format the transcription API reliably
// decodes, so the recording is decoded and re-encoded as plain PCM before it is
// sent. 16 kHz is the rate speech recognition works at; sending 48 kHz stereo
// would triple the payload to carry nothing a transcript would use.
//
// Nothing is written to disk at any point, here or in the main process.

const TARGET_RATE = 16_000;

// Long enough for any question worth asking a file manager, short enough that a
// button left pressed by accident cannot quietly record the room. The recorder
// stops itself at the limit and reports that it did.
export const MAX_MS = 120_000;

// Under this, the press was a mis-click rather than a sentence.
const MIN_MS = 350;

let active = null;   // the one recording in flight, or null

/** Whether this build can record at all. */
export function isSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

export function isRecording() {
  return !!active;
}

/** The container the browser will actually give us, best first. */
function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';   // let the browser choose
}

/**
 * Turns a getUserMedia failure into something a person can act on.
 *
 * The DOM names are precise and useless: "NotAllowedError" is both "you said no
 * once" and "Windows has microphone access switched off for every app", and the
 * fix is different in each case.
 */
function describeCaptureError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone was refused. Check that microphone access is allowed ' +
           'for desktop apps in your system privacy settings.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Plug one in, or type the question instead.';
  }
  if (name === 'NotReadableError') {
    return 'The microphone is in use by another application.';
  }
  return err?.message || 'The microphone could not be opened.';
}

/**
 * Starts recording.
 *
 * @param {object} opts
 * @param {(level: number) => void} [opts.onLevel] loudness, 0..1, twenty times a second
 * @param {(ms: number) => void} [opts.onTick] elapsed milliseconds
 * @param {(reason: string) => void} [opts.onAutoStop] called when the limit is reached
 * @throws with a readable message if the microphone cannot be opened
 */
export async function start({ onLevel, onTick, onAutoStop } = {}) {
  if (active) throw new Error('Already recording.');
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
    throw new Error(describeCaptureError(err));
  }

  const mimeType = pickMimeType();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(`This build could not start a recording: ${err.message}`);
  }

  const chunks = [];
  recorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });

  // The level meter. This is the only honest signal that the microphone is
  // actually hearing something — a button that merely turns red says nothing
  // about whether the right device is selected.
  let audioCtx = null;
  let analyser = null;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);   // deliberately not connected to the destination
  } catch {
    audioCtx = null;            // metering is a nicety; recording proceeds without it
  }

  const startedAt = performance.now();
  const session = {
    stream, recorder, chunks, audioCtx, analyser, startedAt,
    stopped: false, timer: null, meter: null, autoStopped: false,
  };
  active = session;

  if (analyser) {
    const buf = new Float32Array(analyser.fftSize);
    session.meter = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      // Speech sits well below full scale; the multiplier lifts a normal voice
      // into a visible range without pinning the meter at the top.
      onLevel?.(Math.min(1, rms * 6));
    }, 50);
  }

  session.timer = setInterval(() => {
    const ms = performance.now() - startedAt;
    onTick?.(ms);
    if (ms >= MAX_MS && !session.autoStopped) {
      session.autoStopped = true;
      onAutoStop?.(`Recording stopped at ${Math.round(MAX_MS / 1000)} seconds.`);
    }
  }, 100);

  recorder.start();
  return session;
}

/** Stops the microphone and tears the graph down. Safe to call twice. */
function teardown(session) {
  if (session.stopped) return;
  session.stopped = true;
  clearInterval(session.timer);
  clearInterval(session.meter);
  try { session.stream.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
  try { session.audioCtx?.close(); } catch { /* already closed */ }
  if (active === session) active = null;
}

/**
 * Stops recording and returns the WAV, ready to send.
 *
 * @returns {Promise<{ data: string, mimeType: string, durationMs: number, bytes: number }>}
 * @throws if the press was too short to hold speech, or the audio was silent
 */
export async function stop() {
  const session = active;
  if (!session) throw new Error('Nothing is being recorded.');

  const durationMs = performance.now() - session.startedAt;

  const blob = await new Promise((resolve) => {
    session.recorder.addEventListener('stop', () => {
      resolve(new Blob(session.chunks, { type: session.recorder.mimeType || 'audio/webm' }));
    }, { once: true });
    try {
      session.recorder.stop();
    } catch {
      resolve(new Blob(session.chunks, { type: 'audio/webm' }));
    }
  });

  teardown(session);

  if (durationMs < MIN_MS || blob.size === 0) {
    const err = new Error('Hold the button while you speak, or click once to start and again to stop.');
    err.code = 'TOO_SHORT';
    throw err;
  }

  const wav = await toWav(await blob.arrayBuffer());
  return { data: wav.base64, mimeType: 'audio/wav', durationMs: Math.round(durationMs), bytes: wav.bytes };
}

/** Abandons the recording without producing anything. */
export function cancel() {
  if (!active) return;
  const session = active;
  try { session.recorder.stop(); } catch { /* never started */ }
  teardown(session);
}

/** Decodes whatever the browser recorded, downmixes to mono and resamples. */
async function toWav(arrayBuffer) {
  const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } catch {
    throw new Error('The recording could not be read back. Try again.');
  } finally {
    try { decodeCtx.close(); } catch { /* already closed */ }
  }

  // OfflineAudioContext does the resampling, which is the one part of this that
  // is genuinely hard to do well by hand.
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);

  // A recording with no signal in it is a microphone that was muted or wrong.
  // Saying so here costs nothing; sending it costs a request and comes back
  // with an empty answer the user has to interpret.
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] < 0 ? -samples[i] : samples[i];
    if (v > peak) peak = v;
  }
  if (peak < 0.005) {
    const err = new Error('That recording was silent. Check which microphone your system is using.');
    err.code = 'SILENT';
    throw err;
  }

  const buffer = encodeWav(samples, TARGET_RATE);
  return { base64: base64FromBuffer(buffer), bytes: buffer.byteLength };
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
  view.setUint32(16, 16, true);                // PCM header length
  view.setUint16(20, 1, true);                 // format: PCM
  view.setUint16(22, 1, true);                 // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);    // byte rate
  view.setUint16(32, 2, true);                 // block align
  view.setUint16(34, 16, true);                // bits per sample
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

/** Chunked, because `String.fromCharCode(...millions)` overflows the stack. */
function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
