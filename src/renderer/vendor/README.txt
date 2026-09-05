vosk.js is the unmodified dist bundle of vosk-browser 0.0.8
(https://github.com/ccoreilly/vosk-browser), Apache-2.0.

It is vendored rather than imported from node_modules because this renderer has
no bundler and loads its scripts under a `script-src 'self'` policy. The bundle
is UMD and self-contained: its worker and the Kaldi WASM build are inlined into
it, so it needs no sibling files at runtime — only `blob:` in worker-src and
'wasm-unsafe-eval' in script-src, which src/renderer/overlay.html grants.

Upstream licence: Apache License 2.0.
Vosk itself (https://alphacephei.com/vosk/) is also Apache-2.0, as are the
models served from the vosk-browser model host.
