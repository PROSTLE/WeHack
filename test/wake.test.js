// What the recogniser really returns, and what the matcher must do with it.
//
// Every string below was produced by running test/tools/wake-truth.js: real
// speech through the real Vosk model this application ships. Nothing here is
// invented, which is the point — the matcher's rules were derived from this
// output, and if a change to them breaks a case, that case is a recording of
// something a person actually said.
//
// Four macOS voices, seven phrases each. The wake phrases are the ones whose
// name begins "hey_nexa"; the rest are ordinary sentences containing "next",
// which is what the recogniser turns "Nexa" into and therefore the exact thing
// that must not open the panel.

// The real module, not a copy of it: a matcher that agrees with these
// recordings but is not the one shipping would test nothing.
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  if (cond) pass++; else fail++;
}

// [label, should wake, final transcript, partial transcripts]
const RECORDED = [
  ["Alex__go_to_the_next_file", false, "go to the next file", ["go to", "go to the", "go to the next"]],
  ["Alex__hello_there", false, "hello there", ["hello", "hello there"]],
  ["Alex__hey_nexa", true, "the next", ["the"]],
  ["Alex__hey_nexa_find_my_downloads", true, "the next of find my downloads", ["the", "the next of", "the next of find", "the next of find my"]],
  ["Alex__next_week", false, "the next week", ["the next"]],
  ["Alex__open_the_next_folder", false, "open the next folder", ["open the", "open the next", "open the next folder"]],
  ["Alex__send_me_the_next_slide", false, "send me the next slide", ["send me", "send me the", "send me the next", "send me the next slide"]],
  ["Daniel__go_to_the_next_file", false, "go to the next fall", ["go to the", "go to the next", "go to the next five"]],
  ["Daniel__hello_there", false, "hello there", ["the", "hello there"]],
  ["Daniel__hey_nexa", true, "hey next", ["hey"]],
  ["Daniel__hey_nexa_find_my_downloads", true, "hey next of find my downloads", ["hey", "hey next", "hey next of", "hey next of find", "hey next of find my"]],
  ["Daniel__next_week", false, "next week", ["next"]],
  ["Daniel__open_the_next_folder", false, "open the next folder", ["open the", "open the next"]],
  ["Daniel__send_me_the_next_slide", false, "send me the next slide", ["send me", "send me the", "send me the next", "send me the next slide"]],
  ["Karen__go_to_the_next_file", false, "go to the next to file", ["go to the", "go to the next"]],
  ["Karen__hello_there", false, "hello there", ["hello"]],
  ["Karen__hey_nexa", true, "hey next so", ["hey"]],
  ["Karen__hey_nexa_find_my_downloads", true, "hey next of find my downloads", ["hey", "hey next of", "hey next of find my"]],
  ["Karen__next_week", false, "next week", ["next"]],
  ["Karen__open_the_next_folder", false, "urban the next folder", ["open the", "then the next"]],
  ["Karen__send_me_the_next_slide", false, "send me the next slide", ["send me", "send me the", "send me the next", "send me the next slide"]],
  ["Samantha__go_to_the_next_file", false, "go to the next file", ["go", "go to the", "go to the next", "go to the next five"]],
  ["Samantha__hello_there", false, "hello there", ["hello there"]],
  ["Samantha__hey_nexa", true, "the next up", ["they", "the"]],
  ["Samantha__hey_nexa_find_my_downloads", true, "the next of find my downloads", ["they", "the", "the next available", "the next of find", "the next of find my"]],
  ["Samantha__next_week", false, "next week", ["next"]],
  ["Samantha__open_the_next_folder", false, "open the next folder", ["open the", "open the next"]],
  ["Samantha__send_me_the_next_slide", false, "send me the next slide", ["send me", "send me the", "send me the next", "send me the next slide"]],
  ["go_to_the_next_file", false, "go to the next file", ["go to", "go to the", "go to the next"]],
  ["hello_there", false, "hello there", ["hello", "hello there"]],
  ["hey_nexa", true, "the next", ["the"]],
  ["hey_nexa_find_my_tax_return", true, "the next of find my tax return", ["the", "the next of", "the next of find", "the next of find my", "the next of find my tax"]],
  ["hey_nexa_where_are_my_screenshots", true, "the next a where are my screen shots", ["the", "the next", "the next aware", "the next a where are my", "the next a where are my screen"]],
  ["next_week", false, "the next week", ["the", "the next"]],
  ["send_me_the_next_slide", false, "send me the next slide", ["send me", "send me the", "send me the next", "send me the next slide"]],
];

(async () => {
const { matchesWake } = await import(
  pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'wake.js')).href);

console.log('-- what the recogniser returned, and what we do with it --');

for (const [label, shouldWake, final, partials] of RECORDED) {
  // The user experiences whichever fires first: a partial mid-utterance, or the
  // final result when the utterance closes.
  const firedOnPartial = partials.some((p) => matchesWake(p, { final: false }));
  const firedOnFinal = matchesWake(final, { final: true });
  const woke = firedOnPartial || firedOnFinal;
  ok(`${shouldWake ? 'wakes on ' : 'ignores  '}${label}`, woke === shouldWake,
     JSON.stringify(final));
}

console.log('\n-- the phrase is caught mid-utterance where it can be --');

// A wake phrase followed by a command must fire before the command is finished,
// because that is the whole reason for recognising on-device.
const withCommand = RECORDED.filter(([l, w]) => w && l.includes('find_my'));
for (const [label, , , partials] of withCommand) {
  const at = partials.find((p) => matchesWake(p, { final: false }));
  ok(`${label} fires on a partial, not at the end`, !!at, at ? JSON.stringify(at) : 'only at the end');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('unexpected failure:', err); process.exit(1); });
