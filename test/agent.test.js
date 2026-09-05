// The agent loop: what it remembers, what it does when told to stop, and what
// it says when the model was never reached.
//
// No model is called here. The client is a stand-in that answers with whatever
// the test hands it, which is the only way to assert on a tool-calling loop
// without paying for a network round trip per assertion — and the parts worth
// asserting on are all local anyway: the shape of the conversation that gets
// resent, whether a cancelled turn leaves the history intact, and whether a
// failure is reported honestly rather than papered over with a plausible answer.

const {
  Agent, trimHistory, isUserQuestion, HISTORY_TURNS,
} = require('../src/main/llm/agent.js');
const { httpError } = require('../src/main/llm/gemini.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}

/** A model that answers with a scripted sequence of turns. */
function fakeGemini(turns, { onGenerate = null } = {}) {
  const seen = [];
  let i = 0;
  return {
    available: true,
    seen,
    generate: async (contents, opts) => {
      // A copy, because the agent goes on mutating the array it was handed.
      seen.push(contents.map((c) => ({ role: c.role, parts: [...c.parts] })));
      onGenerate?.(contents, opts, i);
      const next = turns[Math.min(i, turns.length - 1)];
      i++;
      if (next instanceof Error) throw next;
      return { candidates: [{ content: { parts: next } }] };
    },
  };
}

const textTurn = (t) => [{ text: t }];
const callTurn = (name, args = {}) => [{ functionCall: { name, args } }];

(async () => {
  console.log('-- the conversation that gets resent --');

  {
    // Four exchanges, each a question, a tool call, its result and an answer.
    const history = [];
    for (let n = 0; n < 4; n++) {
      history.push({ role: 'user', parts: [{ text: `q${n}` }] });
      history.push({ role: 'model', parts: [{ functionCall: { name: 'get_scan_status' } }] });
      history.push({ role: 'user', parts: [{ functionResponse: { name: 'get_scan_status' } }] });
      history.push({ role: 'model', parts: [{ text: `a${n}` }] });
    }

    const kept = trimHistory(history, 2);
    ok('trimming keeps the requested number of exchanges',
      kept.filter(isUserQuestion).length === 2, `got ${kept.filter(isUserQuestion).length}`);
    ok('trimming keeps the most recent ones, not the oldest',
      kept[0].parts[0].text === 'q2', `starts at ${kept[0].parts[0].text}`);
    ok('trimming cuts at a question, never mid-exchange',
      isUserQuestion(kept[0]), 'first entry is a user question');

    // The rule that matters: a model turn carrying function calls and the turn
    // carrying their responses must survive together. The API rejects the whole
    // conversation otherwise, so a bad cut breaks the assistant outright.
    let orphans = 0;
    for (let n = 0; n < kept.length; n++) {
      const calls = (kept[n].parts || []).filter((p) => p.functionCall).length;
      if (!calls) continue;
      const answers = (kept[n + 1]?.parts || []).filter((p) => p.functionResponse).length;
      if (answers !== calls) orphans++;
    }
    ok('no function call is left without its response', orphans === 0, `${orphans} orphan(s)`);

    ok('a short conversation is left alone',
      trimHistory(history.slice(0, 4), 8).length === 4);
    ok('tool results are not mistaken for the user speaking',
      isUserQuestion({ role: 'user', parts: [{ functionResponse: { name: 'x' } }] }) === false);
    ok('the default bound is a stated number', Number.isInteger(HISTORY_TURNS) && HISTORY_TURNS > 0);
  }

  {
    // Ten questions in a row must not grow the resent conversation without end.
    const gemini = fakeGemini([textTurn('fine')]);
    const agent = new Agent({ gemini, tools: {} });
    for (let n = 0; n < HISTORY_TURNS + 4; n++) await agent.send(`question ${n}`);
    ok('a long session stops growing at the bound',
      agent.historyDepth() <= HISTORY_TURNS, `depth ${agent.historyDepth()}`);
    const lastSent = gemini.seen[gemini.seen.length - 1];
    ok('the oldest questions are gone from what is sent',
      !JSON.stringify(lastSent).includes('question 0'));
    ok('the most recent one is still there',
      JSON.stringify(lastSent).includes(`question ${HISTORY_TURNS + 3}`));
  }

  console.log('\n-- stopping --');

  {
    const controller = new AbortController();
    // The model asks for a tool; the signal is tripped while that runs, so the
    // stop lands in the middle of a turn rather than between two.
    const gemini = fakeGemini([callTurn('get_scan_status'), textTurn('done')]);
    const agent = new Agent({
      gemini,
      tools: {
        get_scan_status: async () => { controller.abort(); return { scanned: false }; },
      },
    });
    await agent.send('first question');
    const depthBefore = agent.historyDepth();

    const out = await agent.send('the one that gets stopped', { signal: controller.signal });
    ok('a stopped turn is reported as stopped, not as an answer', out.error === 'CANCELLED', out.error);
    ok('a stopped turn says so in words a person can read', /stopped/i.test(out.reply), out.reply);
    ok('a stopped turn proposes nothing', out.plan === null && out.conversion === null);
    ok('a stopped turn is removed from the conversation entirely',
      agent.historyDepth() === depthBefore, `depth ${agent.historyDepth()} vs ${depthBefore}`);
    ok('nothing half-finished is left behind',
      !JSON.stringify(agent.history).includes('the one that gets stopped'));

    // The real point of removing it: the next question must still work. A model
    // turn whose function calls were never answered would have the API reject
    // every request made afterwards.
    const after = await agent.send('the next question');
    ok('the assistant still works after a stop', after.error === null, String(after.error));
  }

  {
    // Stopped before it began: no request should be sent at all.
    const controller = new AbortController();
    controller.abort();
    const gemini = fakeGemini([textTurn('should never be reached')]);
    const agent = new Agent({
      gemini,
      tools: {},
      // The stand-in does not consult the signal, so the agent's own check is
      // what has to catch this.
    });
    const out = await agent.send('already stopped', { signal: controller.signal });
    ok('a turn stopped before it started sends nothing', gemini.seen.length === 0,
      `${gemini.seen.length} request(s)`);
    ok('and is still reported as stopped', out.error === 'CANCELLED', out.error);
  }

  console.log('\n-- failure is reported, never invented --');

  {
    const boom = Object.assign(new Error('The Gemini service returned an error (HTTP 503).'), {
      code: 'UPSTREAM',
    });
    const gemini = fakeGemini([boom]);
    const agent = new Agent({ gemini, tools: {} });
    await agent.send('a question that worked').catch(() => {});
    const before = agent.historyDepth();

    const out = await agent.send('a question that failed');
    ok('a failed turn names the failure', out.error === 'UPSTREAM', String(out.error));
    ok('a failed turn does not answer the question',
      /could not be reached/i.test(out.reply), out.reply);
    ok('a failed turn does not stay in the conversation',
      agent.historyDepth() === before, `depth ${agent.historyDepth()} vs ${before}`);
  }

  {
    const exhausted = Object.assign(new Error('all keys'), {
      code: 'ALL_KEYS_EXHAUSTED', retryAfterMs: 45_000,
    });
    const agent = new Agent({ gemini: fakeGemini([exhausted]), tools: {} });
    const out = await agent.send('anything');
    ok('a rate limit says how long to wait', /45 seconds/.test(out.reply), out.reply);
  }

  {
    const agent = new Agent({ gemini: { available: false }, tools: {} });
    const out = await agent.send('anything');
    ok('no key is reported as no key', out.error === 'NO_KEY');
    ok('the reply without a key has the same shape as any other',
      'plan' in out && 'conversion' in out && 'choice' in out && 'toolCalls' in out);
  }

  console.log('\n-- an HTTP failure is turned into something actionable --');

  {
    const cases = [
      [404, '{}', 'NO_SUCH_MODEL', /Settings/],
      [429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}', 'RATE_LIMITED', /rate limit/i],
      [400, '{"error":{"message":"API key not valid"}}', 'BAD_KEY', /Settings/],
      [403, '{}', 'KEY_REFUSED', /refused/i],
      [503, '{}', 'UPSTREAM', /HTTP 503/],
    ];
    for (const [status, body, code, shape] of cases) {
      const err = httpError(status, body, 'gemini-x');
      ok(`HTTP ${status} is named ${code}`, err.code === code, err.code);
      ok(`HTTP ${status} says something the user can act on`, shape.test(err.message), err.message);
    }
    ok('only a server error is retried',
      httpError(503, '{}', 'm').transient === true &&
      httpError(404, '{}', 'm').transient === false);
    ok('a rate limit is flagged as one, for the key rotation to act on',
      httpError(429, 'RESOURCE_EXHAUSTED', 'm').rateLimited === true);
    ok("the API's own explanation is preferred over the raw envelope",
      httpError(400, '{"error":{"message":"contents is required"}}', 'm')
        .message.includes('contents is required'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
