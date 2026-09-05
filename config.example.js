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
};
