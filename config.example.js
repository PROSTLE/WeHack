// NexaFiles configuration template.
//
// Copy this file to `config.js` and fill in your own keys, OR set the
// environment variable GEMINI_API_KEYS (comma-separated) before launching.
// Environment variables take precedence over this file.
//
// `config.js` is gitignored and must never be committed or shared.
// Get keys at: https://aistudio.google.com/apikey

module.exports = {
  // One or more Gemini API keys. Multiple keys are rotated automatically
  // when one hits a rate limit (see src/main/llm/gemini.js).
  GEMINI_API_KEYS: [],

  // ── cloud sign-in ────────────────────────────────────────────────────────
  //
  // These are OAuth client IDs, and they are NOT secrets. Every application
  // with a "Sign in with Google" button ships one; it identifies the app, not
  // the user, and it is visible in any app's binary or page source. The secret
  // half does not exist for desktop apps at all — that is what PKCE replaces.
  //
  // Set them here ONCE, as whoever builds this copy of NexaFiles, and everyone
  // who runs it just presses "Sign in". Leave them empty and NexaFiles asks each
  // user to paste their own, which works but is a much worse experience.
  //
  // Where to get them:
  //   Google     console.cloud.google.com → new project → enable "Google Drive
  //              API" → Credentials → OAuth client ID → type "Desktop app".
  //   Microsoft  entra.microsoft.com → App registrations → New registration →
  //              Authentication → Add a platform → "Mobile and desktop
  //              applications" → redirect URI http://localhost → enable
  //              "Allow public client flows".
  //
  // ONE THING TO KNOW BEFORE DISTRIBUTING THIS TO OTHER PEOPLE:
  // Google classes `drive.readonly` as a *restricted* scope. For yourself and
  // up to 100 accounts you add as test users, an unverified app works fine and
  // costs nothing. Publishing it to the general public with that scope requires
  // Google's verification plus an annual third-party security assessment, which
  // is a real expense. Microsoft places no equivalent burden on `Files.Read`.
  CLOUD_GOOGLE_CLIENT_ID: '',
  CLOUD_MICROSOFT_CLIENT_ID: '',
};
