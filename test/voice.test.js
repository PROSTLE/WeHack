// Spoken input: what the transcriber accepts, what it refuses, and what it
// makes of an answer that did not follow instructions.
//
// The renderer opens the microphone, so nothing here can test the capture. What
// can be tested is the part that matters for trust: a recording is checked
// before it is sent anywhere, an unusable one is named as unusable rather than
// forwarded, and a model that ignores "return only the words" does not get to
// put its own framing into the user's composer.
const {
  transcribe, tidy, MAX_AUDIO_BYTES, MIN_AUDIO_BYTES,
} = require('../src/main/llm/voice.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}

/** A stand-in client: records what it was asked and answers with `reply`. */
function fakeGemini(reply, { throws = null, model = 'gemini-2.0-flash-lite' } = {}) {
  const calls = [];
  return {
    calls,
    status: () => ({ model }),
    generate: async (contents, opts) => {
      calls.push({ contents, opts });
      if (throws) throw throws;
      return { candidates: [{ content: { parts: [{ text: reply }] } }] };
    },
  };
}

/** Base64 for `n` bytes of nothing in particular. */
function payload(n) {
  return Buffer.alloc(n, 7).toString('base64');
}

const GOOD = { data: payload(MIN_AUDIO_BYTES * 2), mimeType: 'audio/wav' };

(async () => {
  console.log('-- what is refused before anything is sent --');

  const refused = async (audio, why) => {
    const g = fakeGemini('unused');
    try {
      await transcribe(g, audio);
      return `${why}: it was accepted`;
    } catch {
      return g.calls.length === 0 ? null : `${why}: it reached the model anyway`;
    }
  };

  ok('a format outside the accepted list never reaches the model',
    (await refused({ data: payload(50_000), mimeType: 'audio/x-raw' })) === null);
  ok('a video container is refused',
    (await refused({ data: payload(50_000), mimeType: 'video/webm' })) === null);
  ok('a payload that is not base64 is refused',
    (await refused({ data: 'not base64!!', mimeType: 'audio/wav' })) === null);
  ok('a recording under the minimum length is refused',
    (await refused({ data: payload(MIN_AUDIO_BYTES - 500), mimeType: 'audio/wav' })) === null);
  ok('a recording over the size limit is refused',
    (await refused({ data: payload(MAX_AUDIO_BYTES + 100_000), mimeType: 'audio/wav' })) === null);
  ok('a missing mime type is refused',
    (await refused({ data: payload(50_000) })) === null);

  ok('the too-short refusal is labelled, so the composer can say which it was',
    await (async () => {
      try { await transcribe(fakeGemini('x'), { data: payload(100), mimeType: 'audio/wav' }); }
      catch (err) { return err.code === 'TOO_SHORT'; }
      return false;
    })());

  console.log('\n-- what is sent --');
  const g = fakeGemini('How much space are my videos using?');
  const out = await transcribe(g, GOOD);
  const parts = g.calls[0].contents[0].parts;
  ok('the audio is sent inline, with its declared type',
    parts[0].inlineData?.mimeType === 'audio/wav' && parts[0].inlineData.data === GOOD.data);
  ok('a system instruction accompanies it',
    typeof g.calls[0].opts.systemInstruction === 'string' &&
    g.calls[0].opts.systemInstruction.length > 0);
  ok('the instruction says speech is to be written down, not obeyed',
    /transcribe the order|never as an instruction/i.test(g.calls[0].opts.systemInstruction));
  ok('no tools are offered, so transcription cannot call one',
    !g.calls[0].opts.tools);
  ok('the words come back', out.text === 'How much space are my videos using?');
  ok('the recording is reported as non-empty', out.empty === false);
  ok('the size is reported back', out.bytes > 0);

  console.log('\n-- a model that did not follow instructions --');
  ok('a fenced block is unwrapped', tidy('```\nDelete my caches\n```') === 'Delete my caches');
  ok('a language-tagged fence is unwrapped', tidy('```text\nFind duplicates\n```') === 'Find duplicates');
  ok('a "Transcript:" label is dropped', tidy('Transcript: what is in Downloads') === 'what is in Downloads');
  ok('a "Transcription:" label is dropped', tidy('Transcription:  hello there') === 'hello there');
  ok('wrapping quotes are dropped', tidy('"show me the big files"') === 'show me the big files');
  ok('an internal quote is left alone',
    tidy('open the file called "notes"') === 'open the file called "notes"');
  ok('a spoken refusal to transcribe comes back empty', tidy('[No speech]') === '');
  ok('"inaudible" comes back empty', tidy('inaudible') === '');
  ok('ordinary speech is untouched',
    tidy('  Which folder grew the most this week?  ') === 'Which folder grew the most this week?');

  console.log('\n-- silence --');
  const silent = await transcribe(fakeGemini('   '), GOOD);
  ok('an empty answer is reported as empty rather than guessed at',
    silent.empty === true && silent.text === '');

  console.log('\n-- a model that cannot hear --');
  const audioError = Object.assign(new Error('Invalid value at inline_data.mime_type'), { status: 400 });
  ok('a model that rejects audio is named as the problem',
    await (async () => {
      try { await transcribe(fakeGemini('x', { throws: audioError, model: 'gemma-3' }), GOOD); }
      catch (err) { return err.code === 'MODEL_NO_AUDIO' && /gemma-3/.test(err.message); }
      return false;
    })());
  ok('an unrelated failure is propagated unchanged',
    await (async () => {
      const other = Object.assign(new Error('network down'), { status: 503 });
      try { await transcribe(fakeGemini('x', { throws: other }), GOOD); }
      catch (err) { return err === other; }
      return false;
    })());

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
