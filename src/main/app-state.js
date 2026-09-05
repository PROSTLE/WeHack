'use strict';
// Application state. One object owns the index, the quarantine, the executor
// and the most recent scanner results, so the IPC handlers and the agent's
// tools operate on exactly the same data rather than each keeping their own.

const path = require('path');
const fs = require('fs');
const { Index } = require('./db');
const { ScanController } = require('./scanners/composition');
const { Quarantine } = require('./safety/quarantine');
const { createExecutor } = require('./safety/execute');
const { Plan, CATEGORY, ACTION, CONFIDENCE } = require('./safety/plan');
const roots = require('./security/roots');
const { pathsInUse } = require('./system/processes');
const { SessionRecorder } = require('./system/session');
const { Settings } = require('./settings');
const { GeminiClient } = require('./llm/gemini');
const { GroqClient } = require('./llm/groq');
const { WakeModelStore } = require('./wake/model-store');
const { Agent } = require('./llm/agent');

const { CloudAccounts } = require('./cloud/accounts');

class AppState {
  constructor({ userDataDir, trashItem, safeStorage = null }) {
    this.userDataDir = userDataDir;
    // Connected cloud accounts. safeStorage is injected rather than required
    // here so this class stays constructible in a test without Electron.
    this.cloudAccounts = new CloudAccounts(userDataDir, safeStorage);
    this.index = new Index(path.join(userDataDir, 'nexafiles_index.db')).open();
    this.scanner = new ScanController(this.index);
    this.quarantine = new Quarantine(path.join(userDataDir, 'quarantine'));
    this.executor = createExecutor({
      assertInsideRoot: (p, o) => roots.assertInsideRoot(p, o),
      trashItem,
      quarantine: this.quarantine,
      pathsInUse,
    });

    // Plans awaiting approval, keyed by id. A plan lives here between being
    // proposed and being executed; nothing else can reach it.
    this.plans = new Map();

    // Conversion proposals awaiting approval, keyed by id. Held here rather than
    // sent to the renderer and back so that what gets converted is what the user
    // was shown, not whatever a later message claims was agreed.
    this.conversions = new Map();

    // Open "which of these did you mean" questions, keyed by id. They live here
    // for the same reason conversions do: when the answer comes back, the paths it
    // names are checked against the ones that were actually offered, rather than
    // believed. The two panels keep separate sets because they keep separate
    // conversations — an answer given in one is not an answer to the other's
    // question, and letting either redeem the other's id would make it one.
    this.overlayChoices = new Map();
    this.panelChoices = new Map();

    // The in-flight requests, so a Stop or a dismissal has something to abort.
    // One at a time per panel: the composer is disabled while a question is
    // running, and a second concurrent turn against a single shared history would
    // interleave into nonsense in any case.
    this.panelRequest = null;
    this.overlayRequest = null;

    // The passages the most recent content search matched on, keyed by path.
    // Held so that a follow-up "which of these did you mean" can show the user
    // the sentence that put each file on the list.
    this.lastContentMatches = new Map();

    // The same, for the most recent description search: the tags that put each
    // file on the list, so a follow-up "which of these did you mean" can show
    // why each one is there rather than asking for a choice on trust.
    this.lastDescriptionMatches = new Map();

    // Whether a description build is running, so a second one is refused rather
    // than spending a second set of API calls on the same files.
    this.taggingRun = null;

    // Most recent scanner outputs, so the UI and the agent share one result set.
    this.lastDuplicates = { exact: null, image: null, text: null, video: null };
    this.lastLeftovers = null;
    this.lastStartup = null;

    this.settings = new Settings(userDataDir);

    // The optional local config file, read once. Gitignored, never committed.
    this.localConfig = (() => {
      try {
        const p = path.join(__dirname, '..', '..', 'config.js');
        return fs.existsSync(p) ? require(p) : null;
      } catch { return null; }
    })();

    this.gemini = GeminiClient.fromEnvironment(() => this.localConfig);

    // Where the key in use came from, so the interface can say so rather than
    // just reporting that one exists.
    this.keySource = this.gemini.available
      ? (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY ? 'environment' : 'config file')
      : null;

    // A key saved in Settings is the user's most recent, most deliberate
    // choice, so it wins over the environment and the config file.
    const saved = this.settings.values.assistant;
    if (saved.keys.length) {
      this.gemini.setKeys(saved.keys);
      this.keySource = 'settings';
    }
    if (saved.model) this.gemini.setModel(saved.model);

    // Dictation. The key may also come from the environment, which is how a
    // developer runs this without putting a key in a settings file.
    const dictation = this.settings.values.dictation;
    this.groq = new GroqClient({
      key: dictation.groqKey || process.env.GROQ_API_KEY || '',
    });

    // The wake word's acoustic model. Constructed always, downloaded only when
    // the user switches the feature on — see src/main/wake/model-store.js.
    this.wakeModel = new WakeModelStore(userDataDir);

    this.agent = null;         // the side panel's, built once tools are registered
    this.overlayAgent = null;  // the overlay's, with its own history and instruction

    // Records CPU and memory for the current boot session. Started in init().
    this.session = null;

    this.protectedPathsFile = path.join(userDataDir, 'protected-paths.json');
    this._loadProtectedPaths();

    // Roots the user granted in an earlier run. Without this every drive the
    // user opened in the Files view would have to be approved again at each
    // launch, which trains people to click through the one prompt that matters.
    this.approvedRootsFile = path.join(userDataDir, 'approved-roots.json');
    this._loadApprovedRoots();
  }

  async init() {
    await this.quarantine.init();
    // Expired items are dropped at startup rather than accumulating forever.
    const purged = await this.quarantine.purgeExpired();
    if (purged.length) {
      console.log(`[quarantine] purged ${purged.length} expired item(s)`);
    }
    // Keep the index from growing without bound across many scans.
    this.index.pruneScans(5);
    return this;
  }

  _loadProtectedPaths() {
    try {
      const raw = fs.readFileSync(this.protectedPathsFile, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) roots.setUserProtected(list);
    } catch { /* none saved yet */ }
  }

  saveProtectedPaths(list) {
    roots.setUserProtected(list);
    fs.writeFileSync(this.protectedPathsFile, JSON.stringify(list, null, 2), 'utf8');
    return roots.getUserProtected();
  }

  _loadApprovedRoots() {
    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(this.approvedRootsFile, 'utf8'));
    } catch { return; }
    if (!Array.isArray(saved)) return;
    for (const p of saved) {
      // A root that has since become protected, or a drive that is no longer
      // attached, is dropped rather than reinstated.
      try {
        if (fs.statSync(p).isDirectory()) roots.approveRoot(p);
      } catch { /* gone, or refused; not a root any more */ }
    }
  }

  /** Persists the current root set. Called whenever one is granted or revoked. */
  saveApprovedRoots() {
    const list = roots.listRoots();
    try {
      fs.writeFileSync(this.approvedRootsFile, JSON.stringify(list, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[roots] could not persist approved roots: ${err.message}`);
    }
    return list;
  }

  /**
   * The OAuth client id for a provider, and where it came from.
   *
   * A client id is not a credential — it identifies the application, not the
   * user, and every app with a "Sign in with Google" button ships one openly.
   * So unlike an API key it is perfectly reasonable to bake in, and when it is,
   * the user never sees the subject at all: they press Sign in.
   *
   * Precedence runs from most deliberate to least: something the user typed in
   * Settings beats the environment, which beats what the build shipped with.
   */
  cloudClientId(provider) {
    const key = provider === 'google' ? 'googleClientId' : 'microsoftClientId';
    const fromSettings = (this.settings.values.cloud?.[key] || '').trim();
    if (fromSettings) return { clientId: fromSettings, source: 'settings' };

    const envName = provider === 'google'
      ? 'CLOUD_GOOGLE_CLIENT_ID' : 'CLOUD_MICROSOFT_CLIENT_ID';
    const fromEnv = (process.env[envName] || '').trim();
    if (fromEnv) return { clientId: fromEnv, source: 'environment' };

    const fromConfig = String(this.localConfig?.[envName] || '').trim();
    if (fromConfig) return { clientId: fromConfig, source: 'config file' };

    return { clientId: '', source: null };
  }

  /** The scan the UI is currently showing, or null if none has ever run. */
  currentScan() {
    return this.index.latestCompleteScan();
  }

  registerPlan(plan) {
    this.plans.set(plan.id, plan);
    // Only a handful of plans need to be retained; drop the oldest beyond that.
    if (this.plans.size > 10) {
      const oldest = [...this.plans.keys()][0];
      this.plans.delete(oldest);
    }
    return plan;
  }

  getPlan(id) {
    const p = this.plans.get(id);
    if (!p) throw new Error('That plan is no longer available. Run the scan again.');
    return p;
  }

  /** Begins recording the boot session. Needs Electron's `app` for own-memory. */
  startSession(app) {
    this.session = new SessionRecorder(this.index, { app }).start();
    console.log(`[session] recording ${this.session.bootId}`);
    return this.session;
  }

  close() {
    try { this.session?.stop(); } catch { /* not started */ }
    try { this.index.close(); } catch { /* already closed */ }
  }
}

module.exports = { AppState, Plan, CATEGORY, ACTION, CONFIDENCE };
