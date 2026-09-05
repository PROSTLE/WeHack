# NexaFiles

A file manager that shows you what is actually on your disk, and proves why
anything it offers to remove is safe to remove.

It is built around one rule: **every number on screen is a measurement of your
disk.** There is no health score, no optimisation rating, no "PC health
percentage". If nothing has been measured, the interface says so rather than
showing a figure.

---

## What it does

**Disk composition.** Walks a folder you choose and records every file's size and
timestamps into a local SQLite index. The result is a treemap where area is
measured bytes, hue is category, and *saturation is recency* — a large, washed-out
block is stale space, visible at a glance without a word of explanation.

**Duplicates, in three tiers.** None of it is machine learning, and the interface
never calls it that:

| Tier | Method | Certainty |
|---|---|---|
| Exact | Size bucket → first/last 4 KB sample → full SHA-256 | Byte-for-byte identical |
| Images | Difference hash (dHash) over pixels, Hamming distance ≤ 6 of 64 bits | Visually similar, *not* identical |
| Documents | SimHash over three-word shingles, Hamming distance ≤ 12 of 64 bits | Textually similar, *not* identical |

Files are only hashed in full after they have already matched on exact size *and*
on their first and last 4 KB. Hashing every file on a disk is the standard naive
approach and it turns a minutes-long scan into an hours-long one.

Results are drawn as groups, each with a header saying how many copies it holds
and what keeping one would save, and every file in a group opens — either in the
application that owns it, or in its folder. Deciding which of five identical
files to keep means looking at them, and a list you can only read is a list you
cannot act on. A search this long must also be stoppable: the Stop button under
the progress bar hands back what was found by the time it stopped, and everything
downstream — the panel, the plan, the assistant — is told the search was cut
short, so a partial total is never presented as a complete one.

**A real file manager.** The Files view browses the machine the way Explorer
does, because that is the view people already know how to read: folders first,
the same four columns (Name, Date modified, Type, Size), double-click to open,
F2 to rename, Delete to the Recycle Bin, Backspace for up, Ctrl+C/X/V, drag and
drop between folders, four layouts, and an expandable tree of Quick access and
This PC in the sidebar. Icons and thumbnails are the ones Windows itself
provides, read through the shell rather than guessed from the extension.

Hidden and system items are identified by the attribute the filesystem actually
records — Node exposes no attribute bits on Windows, so each opened directory
costs one `dir /a:H` and one `dir /a:S`, cached against its mtime — rather than
by a list of well-known names. Three things differ from Explorer, deliberately:

- Deleting always goes to the Recycle Bin. There is no permanent delete.
- Running an executable is confirmed first, in a system dialog. Opening a
  document is a read; running a program is not.
- A drive you have not approved shows a button, not an error, and nothing on it
  has been read at the point that button appears.

**Settings that are actually settings.** Five sections — Appearance, Assistant,
This PC, Access to this PC, and NexaFiles' own data — and every control in them
reads from and writes to the running process. The theme is stored and applied
before the window is drawn. The model list is fetched from Google with your own
key rather than baked into the source, so it is whatever your key can call
today. The machine panel reports the processor, memory, GPU, displays and power
source the OS actually returns, and says "not reported by this platform" where
it returns nothing. The access panel is a live view of the approved-root
registry, with the buttons that grant and withdraw.

**Two themes.** Light and dark, or match Windows and change with it while the app
is open. Every colour in the application — including the charts, the treemap, the
illustrations and the file-manager chrome — resolves to a token, so the dark
theme is a data change rather than a second stylesheet. The treemap's recency
ramp inverts with the ground: stale space washes out towards white on porcelain
and sinks towards black on charcoal, because fading towards white on a dark
ground would make the stalest blocks the loudest thing on screen.

**Application leftovers.** Folders under `%APPDATA%`, `%LOCALAPPDATA%` and
`%PROGRAMDATA%` (or `~/Library/…`, or `~/.config`) that belong to applications
that appear to be gone. This is the feature most likely to be wrong, so it is the
most heavily corroborated — see below.

**System uptime.** The same figure Task Manager reports, verified against it:
Task Manager's PerfOS "System Up Time" counter read 39,459 s while `os.uptime()`
read 39,471 s twelve seconds later, and the boot time each implies matches
`Win32_OperatingSystem.LastBootUpTime` exactly. It keeps counting through sleep,
because the machine is still on.

Alongside it, a CPU and memory graph **scoped to the current boot session**.
Samples are recorded every 15 seconds and tagged with a session id derived from
boot time, so the series survives closing the app and survives sleep, and starts
again from zero after a restart. Samples from previous boots are deleted, not
averaged in. The panel always states how much of the session it actually
observed — NexaFiles cannot sample time during which it was not running.

**Startup and background load.** What runs at login, with the evidence for each
and what each is costing in memory right now — a list of forty names with no
figures against them cannot tell you which one to switch off. Entries can be
switched off from here, never silently: on Windows this writes the same
`StartupApproved` byte Task Manager writes, so the entry stays exactly where its
installer put it and Windows is simply told to skip it. Nothing is deleted, and
every switch has an equal switch back. Machine-wide entries and services are
listed but refuse to change without administrator rights, and say so before you
press anything rather than after.

A second tab shows what is running *now*, one row per program rather than one per
process. Closing something there is the only action in NexaFiles with no undo, so
it is asked to close first — the same request clicking its X makes, which lets a
program with unsaved work put up its own prompt — and only terminated if it does
not go. Processes Windows needs are refused outright rather than warned about,
and so is security software: freeing a few hundred megabytes is not worth leaving
the machine unprotected.

**System visibility.** CPU, memory, and per-process usage. There is deliberately
no "free up RAM" button; see *What this deliberately does not do*.

**The overlay panel — Nexa.** One keystroke, from anywhere, over anything. It
opens a floating panel at the edge of the screen, opens the microphone with it,
and closes both together. Say *"open my blog on elephants and convert it to a
PDF"* while you are in your mail client, and it searches the text inside your
documents, finds the post, and offers you the PDF.

The panel is one object that changes shape rather than a sequence of dialogs: it
starts compact and listening, grows into a list when several of your files match,
becomes a conversion slip when you pick one, and ends as a finished file with
Save a copy, Show in folder and Open. Everything the side panel can do it can do,
and nothing it cannot — it proposes, and you approve in the panel before a byte
is written.

By default it is **not always listening**: the microphone opens when the panel
opens and closes when it closes, the same rule the assistant's composer already
held to. Saying **"Hey Nexa"** can open it instead, and that is off until you
switch it on, because it is the one feature here that holds the microphone open.
The setting explains exactly what that costs before you turn it on, and *Known
limitations* says it again.

**Searching inside your files.** The scanner has always recorded every file's
name and size, and `classify/extract.js` has always been able to read the real
text out of `.docx`, `.pptx`, `.pdf`, `.rtf` and every plain format. What was
missing was somewhere to put the words: `doc_text` stored a SimHash, which
answers *are these two documents the same* and cannot answer *which of these is
about elephants*. The words now go into SQLite's own full-text index, which ships
inside the runtime and adds no dependency.

It is a stemmed inverted index with bm25 ranking — not a model, not an embedding,
and it is never described as one. A file is returned because it was opened, read
and found to contain the words, and the passage that matched comes back with it,
so the panel shows you *why* a file is on the list instead of asking you to trust
a ranking. A file whose text could not be extracted is recorded as unread with
the reason, because "nothing matched" and "never looked" must not be the same
answer. Indexing is bounded by a time budget and says what it did not reach.

---

## The safety pipeline

Every destructive operation — from a button, from the assistant, from anywhere —
passes through the same five stages. No code path bypasses it.

1. **Plan** — a list of `{ path, action, bytes, reason, evidence, confidence, category }`.
   An entry without concrete evidence is rejected at construction. An entry whose
   size was not measured is rejected at construction.
2. **Preview** — the plan is rendered with every item expandable to its evidence.
   Nothing has happened yet.
3. **Approve** — an explicit action. Never a default-yes dialog, never a countdown,
   never auto-apply.
4. **Execute** — user-visible files go to the **system trash**. Application
   internals go to an app-managed **quarantine** with a manifest recording the
   original path, size, permissions, timestamps, and the plan entry that caused
   the removal. `fs.unlink` is never used on a first pass.
5. **Reverse** — quarantine retains for 30 days with one-click restore to the
   original location.

**What quarantine is, since the name is jargon.** It is not an antivirus
quarantine and it is not a second recycle bin. It is the undo for the one class
of deletion the recycle bin handles badly. Files you would recognise — a photo, a
document, a download — go to the recycle bin, because that is the undo you
already know how to use. What comes here instead is application *internals*:
leftover cache and support folders from under `AppData`, which have to go back to
the exact path, name and timestamp they came from or the application that owns
them will behave as though its data is gone. Dragging a folder back out of the
recycle bin does not reliably do that; restoring from here does, and if the
original path is occupied it restores alongside rather than overwriting whatever
now lives there. Each entry also keeps the evidence that justified its removal,
so if something breaks a week later the question "what was taken, and why" has an
answer instead of a guess. Nothing is actually deleted until the 30 days are up.

**Hard rules enforced in code, not by convention:**

- Every filesystem IPC handler resolves its path and refuses anything outside a
  root you approved. Symlinks are resolved first, so a link inside a root cannot
  widen it.
- `C:\Windows`, `/System`, `/usr`, install roots and a user-editable protected
  list are refused even when they sit inside an approved root.
- Nothing belonging to a running process is touched; if the process list cannot
  be read, execution **aborts** rather than assuming the path is free.
- **`user-data` items are never pre-selected**, whatever the producing scanner
  requests, and are shown in a visually separate section.

### Leftover detection is a heuristic, and is treated as one

A folder is only reported when **four** things are true at once: no installed
application matches its name, no folder of that name exists where applications
are installed, no running process matches it, and nothing has written to it in
90 days.

That last condition is a measurement rather than an inference, and it is the
single most effective false-positive filter. On the development machine,
name-matching alone flagged 146 folders including `Programs` (where per-user
applications are *installed*), `wsl`, `USOShared`, `WindowsOobeAppHost`, and the
application's own data directory. Adding the corroborating checks removed all of
those. Nothing here is ever rated higher than *medium* confidence.

---

### Attributes, and the answer that is not a failure

`dir /a:S` exits 1 and prints "File Not Found" when a directory holds nothing
carrying that attribute. Treating that as a failure — which the first version of
this did — made a folder with no hidden *and* no system entries report that its
attributes could not be read, which dropped the listing back to the Unix
dot-prefix convention and hid `.gitignore`, `.env` and every other dot-file that
Windows shows perfectly well. The empty set is an answer. `test/attributes.test.js`
holds the line, including for folder names containing `&` and spaces.

### Nothing in the interface is inert

`test/tools/e2e-ui-audit.js` opens every view, panel and menu in the running
application, enumerates every button, input and select the user can see, and
asks Chromium — through the DevTools protocol, not through this application's
own code — whether that element or an ancestor has a listener bound to it. 369
controls are examined. A control that is deliberately disabled (Paste with an
empty clipboard, Load models with no API key) is reported as such; an *enabled*
control with nothing listening fails the run. It has already caught one: an API
key field that ignored the Enter key.

### Browsing widens access, visibly

The approved-root gate is unchanged: every handler that touches a path still
resolves it through `assertInsideRoot` first. What the Files view adds is a way
to *see* that gate rather than trip over it. Pointing it at `D:\` returns a
refusal as data — `{ access: { allowed: false, reason: 'outside' } }`, with no
directory read — and the view renders that as one button that grants the root.
Granted roots are listed in the sidebar, persist to `approved-roots.json` in
userData, and can be withdrawn.

A protected location (`C:\Windows`, `WindowsApps`, `System Volume Information`,
`$Recycle.Bin`) is refused as protected and *cannot* be granted from the
interface at all, because the rule exists to survive a bug in this application.

---

## What this deliberately does not do

**No "free up RAM" button.** On macOS, flushing caches the OS maintains on purpose
leaves the machine slower while it rebuilds them. On Windows, clearing the standby
list needs kernel-level tooling and is genuinely risky. A modern operating system
manages memory better than a userland utility can. NexaFiles shows you what is
using memory and lets you decide.

**No "clear system cache" button.** `session.clearCache()` clears only
NexaFiles' own Chromium cache and nothing else. Presenting that as a system
cleaner would be claiming a capability the code does not have. Clearing another
application's cache means deleting files, so it goes through the safety pipeline
like any other deletion.

**No PII or malware detection.** The previous version had a `sensitivity` column
and threat-shaped iconography. Credible PII detection or malware scanning is not
achievable in this scope, and claiming either invites a question that ends badly.
The column is gone.

**No fabricated data anywhere.** The previous version shipped `ai/model.pkl`,
trained by `ai/train_classifier.py` on 4,100 samples the script generated itself
from random filename fragments (`print("Generating enhanced synthetic dataset...")`,
line 11). Every confidence score it produced was a number derived from invented
filenames. Both files are deleted. Classification is now rule-based: extension,
path context, and magic bytes, each explainable in one sentence.

---

## Architecture

```
main.js                     Electron main process
preload.js                  contextBridge — the renderer's entire surface
src/main/
  security/roots.js         path validation; the gate every fs handler passes
  safety/plan.js            plan construction and its invariants
  safety/execute.js         the only code that removes anything
  safety/quarantine.js      manifest, restore, expiry
  safety/fsops.js           EXDEV-safe move, streaming hashes, measurement
  scanners/walker.worker.js disk walk, in a worker thread
  scanners/composition.js   scan controller, streams batches into SQLite
  scanners/duplicates.js    three tiers
  scanners/leftovers.js     orphan detection with corroboration
  scanners/startup.js       login items
  settings.js               persisted preferences, validated on the way in
  fs/browse.js              directory listing for the Files view
  fs/attributes.js          Windows hidden/system attributes, per directory
  classify/rules.js         rule-based classification
  system/                   metrics, processes, drives, boot-session recorder
  system/machine.js         processor, memory, GPU, displays, power, versions
  llm/                      Gemini client, agent loop, tool implementations
  llm/attachments.js        dropped files, read as pixels or extracted text
  overlay.js                the floating panel's window, placement and hotkey
  search/content-index.js   full-text index over document text; bounded indexing
  convert/index.js          conversion, engine chosen by what the file is
  convert/builtin-pdf.js    Markdown/text/HTML/CSV/JSON → PDF, no office suite
  db.js                     SQLite index (node:sqlite)
src/renderer/
  css/app.css               base system: palette, type, layout
  css/dashboard.css         dashboard surfaces, mint accent, elevation
  css/explorer.css          the Files view, in Explorer's proportions
  css/settings.css          the settings page
  js/settings.js            settings: theme, model, machine, access, storage
  js/explorer.js            the file manager: listing, selection, drag and drop
  js/treemap.js             squarified treemap, hue by category, fade by age
  overlay.html              the floating panel's document
  css/overlay.css           the panel: the aura, the glass, and the morph
  js/overlay.js             the panel's state machine and its fit-to-content
  js/charts.js              inline-SVG chart primitives (no library, no network)
  js/dashboard.js           stat cards, capacity bars, session graph, recent list
  js/icons.js               the icon set and the four illustrations
  js/app.js                 application logic
  fonts/                    bundled OFL typefaces and their licences
```

**Zero runtime dependencies.** The index uses Node's built-in `node:sqlite`
(Electron 37 / Node 22.21), and perceptual image hashing decodes through
Electron's own `nativeImage`, so there is no native module to compile and nothing
to install. A packaged build was verified to start and render with no Python
present and an empty `dependencies` map.

### The agent

The assistant has **read tools** it may call freely and **plan tools** that
return a proposal and nothing else. It cannot delete, move, or modify anything;
it cannot emit a shell command; and it cannot name a path to delete outside a
plan the user then approves. File contents handed to it are explicitly flagged as
untrusted data, so a filename containing an instruction is described rather than
obeyed.

The assistant is optional. Without an API key everything else works unchanged —
scanning, duplicates, leftovers, quarantine and restore are all local.

Files dropped on the assistant are read in the main process and reach the model
as content, never as a path it could act on: an image goes as pixels (resized
first if it would be too large to send), and a PDF, Word, PowerPoint, Excel or
text file goes as the text extracted from it by the same parsers the duplicate
scanner uses. Each is introduced by a header naming it as file content, and the
system instruction says that content is data and never an instruction. A file
that could not be read is reported as unread rather than described.

The side panel and the overlay run two agents over the same tools, each with
its own conversation and its own instruction — the panel answers a question, the
overlay does one thing now — and both behave the same way in the four places
that decide whether an assistant is usable rather than merely present.

**It says what it is doing while it does it.** A question that asks about the
contents of a document sends the assistant through every document it can reach
inside a time budget, which takes tens of seconds. Progress is pushed to the
panel as it happens — which tool is running, how many files have been read — so
the wait is legible instead of being indistinguishable from a hang.

**It can ask a question back.** When several files genuinely match what was
asked for, the assistant calls `ask_user_to_choose` rather than picking one:
choosing which of someone's documents to act on is not a decision a language
model gets to make. The panel draws the candidates as a list, each row carrying
the passage that put that file on it with the matched words marked, because what
identifies a document is what it says rather than what it is called. The answer
is checked against the options that were actually offered — a path nobody was
shown is dropped rather than searched for.

**It can be stopped.** A running question is abandoned on Stop, on Escape, or on
dismissing the overlay. Nothing the assistant has can leave anything half-done —
every tool either reads or produces a proposal — and the abandoned turn is
removed from the conversation entirely, so the next question starts from the last
exchange that finished. That last part is not tidiness: a turn left half-present,
with function calls that were never answered, makes the API reject every request
made afterwards, and one Stop would otherwise break the assistant until it was
reset.

**It stops growing.** Only the last few exchanges are resent. An unbounded
history means every tool result ever returned — forty file listings, a hundred
search snippets — is sent again on every subsequent turn, so a long session gets
slower and more expensive and eventually exceeds the model's input limit and
fails outright. The conversation is cut only at the start of a question, never
between a function call and its response.

Proposals are acted on in the panel where they were made. A conversion shows
every destination before a byte is written, and approving it sends only the
proposal's id — the paths never leave the main process, which is what stops an
approval of the conversion the user read being redeemed for a different one. A
cleanup plan goes to the Plan tab, where it is reviewed and approved like any
other.

Failure is reported as itself. A rate-limited key rotates to the next one and
says how long the wait is; a server error is retried a couple of times, because
a 503 is the service having a bad moment rather than the request being wrong;
and anything that will fail identically however often it is sent — a rejected
key, a model this key cannot call, a malformed conversation — is raised at once
and named, so the user has a setting to change rather than an opaque HTTP code.
No answer is ever fabricated for a question the model was never asked.

A question can also be spoken. The microphone opens when the button is pressed
and closes the moment it is pressed again — the tracks are stopped and the audio
graph is torn down, so the operating system's recording indicator goes out with
the button, and switching away from the assistant panel closes it too rather
than leaving it open behind a tab. The recording is downmixed to 16 kHz mono in
the renderer, sent once for transcription, and kept nowhere: it is never written
to disk, in either process.

What comes back is text in the composer, not a message to the assistant. The
user reads it, fixes the word it misheard, and presses Send — a spoken sentence
gets exactly as far as a typed one before anything is asked. The transcription
request carries no tools, so it cannot call one, and its instruction says that
speech is to be written down and never obeyed: a recording that says "delete
everything" fills in a text box and stops there.

### The Electron question

NexaFiles is a disk tool built on a runtime known for heavy memory use. Rather
than hope nobody notices, the titlebar shows its own working-set size, measured
live via `app.getAppMetrics()` and refreshed every 15 seconds. Scanning runs in a
worker thread, results stream to SQLite in batches, and the renderer queries with
pagination rather than holding the index in memory.

Measured on the development machine: a walk of 624,805 files / 101.9 GB completed
in 152 seconds at a peak of 140 MB RSS.

---

## Setup

### Starting it

`start.bat` in the project root launches the application: double-click it, or
run `.\start.bat` from a terminal (`start` alone is a cmd built-in, so the
extension is needed). `start.bat --console` keeps the log in the window.

The script exists because of one environment variable. Electron reads
`ELECTRON_RUN_AS_NODE`, and several editors, terminals and agent shells set it
for their own tooling. When it is set, the `electron` binary starts as plain
Node, `require('electron')` returns no `app`, and `main.js` dies at
`app.whenReady()` with *Cannot read properties of undefined*. `npm start` fails
that way in such a shell; the launcher clears the variable first. `test/run-all.js`
clears it too, for the same reason.

Only one copy runs at a time. A second launch hands its arguments to the first,
brings that window forward and exits, because two instances would open the same
SQLite index, quarantine manifest and settings file and take turns overwriting
each other. The test suites set `NEXAFILES_ALLOW_MULTIPLE=1` so an orphaned
instance from an earlier suite cannot silently stop the next one from starting.


```bash
npm install
npm start
```

Tests:

```bash
npm test        # 10 suites, 239 assertions
```

The last suite drives the real application through the entire destructive path
via the same bridge the interface uses — scan, find duplicates, build a plan,
approve, execute, verify — and confirms that a protected system path and a path
outside an approved root are both refused by the live IPC surface.

The suite also includes a **real cross-volume move** between two physical drives,
because `fs.rename` throws `EXDEV` across filesystems and the previous version's
`move-file` failed silently on it. `safeMove` falls back to copy → verify by
hash → delete, and never removes the source before the destination is confirmed
byte-identical.

### The assistant (optional)

The simplest way is Settings → Assistant → paste a key. It is stored in
`settings.json` inside NexaFiles' own data folder, in plain text, and takes
precedence over the environment. The interface can never read it back: the
bridge returns the number of keys and the last four characters of each, and
nothing else. The two routes below still work and are the right choice if you
would rather no key were written to disk by this application at all.

```bash
# Environment takes precedence and is preferred.
export GEMINI_API_KEYS="key1,key2"

# Or copy the template. config.js is gitignored and must never be committed.
cp config.example.js config.js
```

Multiple keys are rotated automatically with a 62-second per-key cooldown on rate
limits.

---

## Licences

| Component | Licence | Notes |
|---|---|---|
| Bricolage Grotesque | SIL OFL 1.1 | Bundled, `src/renderer/fonts/LICENSE-BricolageGrotesque-OFL.txt` |
| Geist / Geist Mono | SIL OFL 1.1 | Bundled, `src/renderer/fonts/LICENSE-Geist-OFL.txt` |
| Icons | — | Drawn for this project; no third-party icon assets are bundled |
| Charts | — | Inline SVG drawn for this project; no charting library |

Verified at source in September 2026. Lucide (ISC, with MIT for Feather-derived
icons) was evaluated and would have been fine to bundle; the icons here are drawn
to the same 24×24 / 2px-stroke convention instead, which keeps the dependency
count at zero.

---

## Known limitations

These are stated because a tool whose pitch is honesty has to be honest about
itself.

**Code signing.** The application is **not signed or notarised**. An unsigned
Electron binary that reads the registry and deletes files *will* be flagged by
SmartScreen and by Gatekeeper. Windows reputation effectively requires a signing
certificate; macOS requires notarisation through a paid Developer Program.
Neither is in place, so expect a warning on first launch and treat that warning
as correct behaviour on your operating system's part.

**macOS login items are under-reported.** Items registered through
`SMAppService` — the method most software shipped since macOS 13 uses — live in a
private database, not as plist files, and no supported interface exposes them to
an unsandboxed app. The startup panel states this on screen rather than
presenting a partial list as complete. This was not verified on a macOS machine;
the code path is written but untested there.

**macOS Full Disk Access** is required to read other applications' containers and
is not requestable programmatically. The app is designed to ship outside the Mac
App Store, since the sandbox required there is incompatible with what it does.

**Windows process paths.** Only 143 of 314 running processes expose their
executable path without elevation, so the in-use check cannot see every process.
It compares against running executable paths and cannot detect a process holding
an open handle to a file outside its own install location. The execution result
states this scope explicitly rather than implying the check is complete.

**`Get-ScheduledTask` fails on some Windows configurations** ("The system cannot
find the file specified"). The scanner falls back to `schtasks.exe`; if both
fail it says the list is incomplete rather than showing a short list as the
whole truth.

**The first search on a large disk reads only part of it.** Content indexing has
a time budget and a file cap, so a machine that has never been scanned will have
its Documents, Desktop and Downloads read first and may not reach everything else
before the budget runs out. The result says so — `indexComplete` is false and the
assistant is instructed to report that the search covered what it had time to
read — and the next search continues where it left off, because a file that has
not changed is never read twice. Running a scan first makes the index use the
scan's file list instead of walking, which is much faster.

**Hidden folders are not searched.** The content index skips dot-directories and
the usual machine-generated trees (`node_modules`, caches, `Library`, `AppData`).
A document nobody can see in their file manager is not one they are searching
for, and skipping them is most of why an unindexed home directory is searchable
in seconds rather than minutes.

**"Hey Nexa" holds the microphone open, but nothing it hears leaves the machine.**
It is off by default. With it on, the phrase is recognised here, by a speech
model running inside this application — no audio, no transcript and no record
that anyone spoke is sent anywhere, whether or not the phrase was heard. That is
also why it is fast: the panel opens as the last syllable lands, rather than
after a round-trip to a server.

This used to work the other way, and it is worth saying what changed and what it
cost. Every short utterance near the microphone was uploaded to be transcribed
and checked, which was both a real privacy cost and the reason the feature was
slow — one to three seconds between speaking and a panel, most of it network and
model inference. It is now Vosk, a Kaldi recogniser compiled to WebAssembly,
against a 40 MB acoustic model, running in a hidden window that exists only
while the setting is on — no window, no microphone. The earlier version of this document said there
was no way around the upload "without shipping a keyword-spotting model, and this
project has no runtime dependencies to carry one". That was the wrong trade: the
application already ships a browser engine, and the model is fetched once, on the
first occasion someone actually switches the feature on. The operating system's
own recording indicator stays lit whenever it is listening, NexaFiles cannot
suppress it, and that is still deliberately the signal relied on.

**The wake phrase is matched generously.** "Nexa" is not an English word, it is
not in the recogniser's lexicon, and it never comes back spelled that way — so
"Nexus", "next", "next a" and "Lexa" are all accepted after a leading "hey".
Being strict would mean a wake word that mostly does not wake; requiring the
"hey" is what stops the panel opening whenever somebody says "next" in a
sentence. This is also why the phrase is matched rather than constrained by a
grammar, which would be the usual way to spot a keyword: a Vosk grammar may only
contain words the model already knows, and this one is not.

**Dictation and the assistant are different models now.** Turning speech into
text is done by `whisper-large-v3-turbo` on Groq's free tier — a speech
recognition model, where the assistant's Gemini model was a chat model asked to
transcribe as a side job. Ten seconds of speech comes back in about a third of a
second rather than two to four, and it mishears far less. It needs a free key,
set in Settings; with no key, dictation falls back to the Gemini path rather than
failing. Recordings are still never written to disk, and the transcript still
lands in the composer as text to read and send deliberately, never as a turn in
the conversation.

**Word, PowerPoint and Excel still need an office suite.** NexaFiles renders
Markdown, plain text, HTML, CSV, TSV, JSON and logs to PDF itself, through the
browser it already contains, and names itself as the engine when it does. It
cannot reproduce Word's layout without Word, and it does not try — a `.docx` on a
machine with neither Office nor LibreOffice is reported as needing one rather
than converted at lower fidelity and called done.

**The built-in Markdown renderer is deliberately incomplete.** It covers
headings, emphasis, code, links, images, lists, quotes and rules — what people
write in a post. It is not CommonMark, does not claim to be, and does not render
footnotes, reference links or tables.

**Not tested on macOS or Linux.** The platform-specific code for both is written
and reviewed, but every measurement in this README was taken on Windows 11
(build 26200). Treat the non-Windows paths as unverified.

**No remote resources can load in the renderer.** The content security policy is
`default-src 'none'` with `connect-src 'none'`, so a CDN charting library —
Google Charts included — cannot be used here. The charts are inline SVG drawn in
`js/charts.js` for that reason, not by preference against those libraries.

**`node:sqlite` is marked experimental** in Node 22. It is stable in practice and
was verified working under the packaged Electron runtime, but it emits an
experimental warning to the console and its API could change in a future Node
release.

---

## What changed from v1

| | Before | After |
|---|---|---|
| API keys | Two live Gemini keys in `config.js`, shipped in the archive | Removed from the tree; loaded from environment. **Both keys must be revoked.** |
| Classifier | TF-IDF model trained on 4,100 fabricated filenames | Deterministic rules: extension, path, magic bytes |
| Backend | Python Flask sidecar, venv built with `execSync` at first launch | Removed. Node throughout, zero dependencies |
| `build.files` | Excluded `ai/`, `config.js`, `gemini.js` — every installer shipped a broken app | Verified complete by launching a staged package |
| Path validation | None; any absolute path accepted from the renderer | Every handler validates against approved roots |
| `move-file` | `fs.rename`, threw `EXDEV` across drives | Copy → verify → delete fallback, tested across real drives |
| `gemini.js` | Dead code requiring an uninstalled dependency | Deleted |
| Emoji | 286 in `index.html` | 0 |
| Drive enumeration | `wmic`, **absent on the test machine** — returned nothing | `Get-CimInstance Win32_LogicalDisk` |
| Permissions | `media` allowed unconditionally, for anything asking | Everything denied except audio-only `media`, from this window's own document, for the assistant's microphone |
| UI | 4,761-line single file, dark navy `#0F172A` | Modular; light, measured, no fabricated figures |
