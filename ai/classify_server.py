import os
import sys
import pickle
import json
import time
from flask import Flask, request, jsonify
from flask_cors import CORS
from google import genai

# Fix Unicode output on Windows
if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if sys.stderr and hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

app = Flask(__name__)
CORS(app)

# ── Load sklearn model ──
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'model.pkl')
try:
    with open(MODEL_PATH, 'rb') as f:
        model = pickle.load(f)
    print(f"[OK] sklearn model loaded from {MODEL_PATH}")
except Exception as e:
    print(f"[ERROR] Error loading sklearn model: {e}")
    model = None

# ── Configure Gemini key pool ──
_raw_keys = os.environ.get('GEMINI_API_KEYS', '')
if _raw_keys:
    ALL_GEMINI_KEYS = [k.strip() for k in _raw_keys.split(',')
                       if k.strip() and k.strip() != 'YOUR_API_KEY_HERE']
else:
    single = os.environ.get('GEMINI_API_KEY', '')
    ALL_GEMINI_KEYS = [single] if single and single != 'YOUR_API_KEY_HERE' else []

if ALL_GEMINI_KEYS:
    print(f"[OK] Gemini API configured ({len(ALL_GEMINI_KEYS)} key(s) available)")
else:
    print("[WARN] No GEMINI_API_KEY set -- Gemini endpoints will return fallback responses")

# ── Per-key cooldown tracker ──
# {index: float(unix_timestamp)} — key is available when time.time() >= timestamp
_key_cooldown_until = {}
RATE_LIMIT_COOLDOWN = 62   # free-tier RPM window is 60s, add 2s buffer


def _available_key_index():
    """Return the first key index NOT in cooldown, or None if all cooling."""
    now = time.time()
    for i in range(len(ALL_GEMINI_KEYS)):
        if now >= _key_cooldown_until.get(i, 0):
            return i
    return None


def _wait_secs_for_earliest():
    """Seconds until the soonest key exits cooldown."""
    now = time.time()
    if not ALL_GEMINI_KEYS:
        return 0.0
    return min(max(0.0, _key_cooldown_until.get(i, 0) - now)
               for i in range(len(ALL_GEMINI_KEYS)))


# ── Health check ──
@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "sklearn": model is not None,
        "gemini": bool(ALL_GEMINI_KEYS),
        "gemini_keys": len(ALL_GEMINI_KEYS)
    }), 200


# ── Classify file (sklearn) ──
@app.route('/classify', methods=['POST'])
def classify_file():
    if not model:
        return jsonify({"error": "sklearn model not loaded"}), 500

    data = request.json
    if not data:
        return jsonify({"error": "No JSON payload"}), 400

    filename = data.get('filename', '')
    extension = data.get('extension', '')
    content_snippet = data.get('content_snippet', '')

    combined_text = f"{extension} {extension} {extension} {filename} {content_snippet}".lower().strip()

    try:
        prediction = model.predict([combined_text])[0]
        probabilities = model.predict_proba([combined_text])[0]
        confidence = float(max(probabilities))
        return jsonify({
            "category": prediction,
            "confidence": confidence,
            "probabilities": {
                cls: float(prob)
                for cls, prob in zip(model.classes_, probabilities)
            }
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Gemini call with smart per-key cooldown + auto-wait on exhaustion ──
def gemini_generate(prompt, model_name='gemini-2.0-flash-lite'):
    """
    Pass 1: Try every key that is not in cooldown.
            On 429: stamp that key with a 62s cooldown and try the next immediately.
    Pass 2: If ALL keys are cooling, wait for the soonest-ready one (max 65s),
            then try once more. This avoids "busy" errors in normal usage.
    Raises on hard errors (auth, network) or if all keys still fail after waiting.
    """
    if not ALL_GEMINI_KEYS:
        return None

    def _call(idx):
        key = ALL_GEMINI_KEYS[idx]
        client = genai.Client(api_key=key)
        result = client.models.generate_content(model=model_name, contents=prompt)
        return result.text

    # -- Pass 1: iterate non-cooling keys --
    tried = set()
    for _ in range(len(ALL_GEMINI_KEYS)):
        idx = _available_key_index()
        if idx is None or idx in tried:
            break
        tried.add(idx)
        try:
            text = _call(idx)
            print(f"[OK] Gemini key {idx} responded")
            return text
        except Exception as e:
            err = str(e)
            if '429' in err or 'RESOURCE_EXHAUSTED' in err:
                _key_cooldown_until[idx] = time.time() + RATE_LIMIT_COOLDOWN
                print(f"[WAIT] Key {idx} rate-limited -> {RATE_LIMIT_COOLDOWN}s cooldown. Trying next...")
            else:
                raise   # hard error (auth, model name, network) — fail fast

    # -- Pass 2: all keys cooling; wait for the earliest one --
    wait = _wait_secs_for_earliest()
    if 0 < wait <= 65:
        print(f"[WAIT] All {len(ALL_GEMINI_KEYS)} key(s) cooling. Waiting {wait:.1f}s for earliest...")
        time.sleep(wait + 0.5)
        idx = _available_key_index()
        if idx is not None:
            try:
                text = _call(idx)
                print(f"[OK] Gemini key {idx} responded after cooldown wait")
                return text
            except Exception as e:
                err = str(e)
                if '429' in err or 'RESOURCE_EXHAUSTED' in err:
                    _key_cooldown_until[idx] = time.time() + RATE_LIMIT_COOLDOWN

    raise Exception('All API keys rate-limited. Please wait a moment or add another key in config.js.')


# ── Summarize file content ──
@app.route('/summarize', methods=['POST'])
def summarize_file():
    data = request.json or {}
    filename = data.get('filename', 'Unknown file')
    content_snippet = data.get('content_snippet', '')

    if not content_snippet:
        return jsonify({"summary": "No content available to summarize."}), 200

    if not ALL_GEMINI_KEYS:
        return jsonify({
            "summary": f"[Gemini offline] {filename} - set GEMINI_API_KEY to enable summarization."
        }), 200

    try:
        snippet = content_snippet[:4000]
        prompt = (
            f"Summarize this file in 2-3 clear sentences. Be concise and informative.\n"
            f"File: {filename}\n\nContent:\n{snippet}"
        )
        text = gemini_generate(prompt)
        return jsonify({"summary": text})
    except Exception as e:
        err_str = str(e)
        if 'rate' in err_str.lower() or '429' in err_str:
            return jsonify({"summary": "AI is temporarily busy. Please try again in a moment."}), 200
        return jsonify({"summary": f"Summary failed: {err_str}"}), 200


# ── NLP chat ──
@app.route('/chat', methods=['POST'])
def chat():
    data = request.json or {}
    message = data.get('message', '')
    context = data.get('context', {})

    if not message:
        return jsonify({"reply": "Please ask me something!"}), 200

    if not ALL_GEMINI_KEYS:
        return jsonify({
            "reply": "Gemini is offline. Set GEMINI_API_KEY to enable natural language chat.",
            "gemini_available": False
        }), 200

    try:
        context_parts = []
        if context.get('currentDirectory'):
            context_parts.append(f"Current folder: {context['currentDirectory']}")
        if context.get('fileCount'):
            context_parts.append(f"Total files in view: {context['fileCount']}")
        if context.get('selectedFiles'):
            names = ', '.join(context['selectedFiles'][:5])
            context_parts.append(f"Selected files: {names}")
        if context.get('dupCount'):
            context_parts.append(f"Duplicates found: {context['dupCount']}")
        if context.get('piiCount'):
            context_parts.append(f"PII alerts: {context['piiCount']}")

        classification_section = ""
        if context.get('classificationSummary'):
            classification_section = f"\nAI Classification Summary: {context['classificationSummary']}"

        if context.get('classifiedFiles'):
            cf = context['classifiedFiles']
            file_listings = []
            for category, file_list in cf.items():
                names = [f['name'] for f in file_list[:15]]
                extra = f" (+{len(file_list) - 15} more)" if len(file_list) > 15 else ""
                file_listings.append(f"  {category} ({len(file_list)} files): {', '.join(names)}{extra}")
            classification_section += "\nDetailed classification:\n" + "\n".join(file_listings)

        context_str = '\n'.join(context_parts)

        prompt = f"""You are NexaFiles AI - an intelligent file management assistant built into a desktop app.
You help users organize files, find duplicates, detect sensitive data, and understand their storage.
Be concise, direct, and action-oriented. Use plain text (no markdown headers).

Current app state:
{context_str if context_str else 'No context available'}
{classification_section}

IMPORTANT INSTRUCTION:
You have access to the sklearn AI classification data above. When the user asks about files by category,
use the classification data to answer accurately.

If the user wants to VIEW or FILTER files by a category, include an "action" field:
{{"reply": "your text response here", "action": {{"type": "filter", "category": "work"}}}}

Valid categories for filter actions: work, personal, media, code, archive, other

If the user asks to sort files by category:
{{"reply": "Sorting files by AI category.", "action": {{"type": "sort_by_category"}}}}

If NO action is needed:
{{"reply": "your text response here"}}

Always respond in valid JSON. Never include anything outside the JSON object.

User: {message}"""

        try:
            raw = gemini_generate(prompt)
        except Exception as api_err:
            err_str = str(api_err)
            if 'rate' in err_str.lower() or '429' in err_str:
                return jsonify({
                    "reply": "All my AI keys are busy right now. Please add another API key in config.js or wait a moment!",
                    "action": None,
                    "gemini_available": True
                }), 200
            raise

        if not raw:
            return jsonify({"reply": "Couldn't get a response. Please try again.", "action": None, "gemini_available": True}), 200

        raw = raw.strip()
        if raw.startswith('```'):
            raw = raw.split('\n', 1)[1] if '\n' in raw else raw[3:]
            if raw.endswith('```'):
                raw = raw[:-3].strip()

        try:
            parsed = json.loads(raw)
            reply = parsed.get('reply', raw)
            action = parsed.get('action', None)
            return jsonify({"reply": reply, "action": action, "gemini_available": True})
        except json.JSONDecodeError:
            return jsonify({"reply": raw, "action": None, "gemini_available": True})

    except Exception as e:
        return jsonify({
            "reply": "Something went wrong on my end. Please try again in a moment.",
            "action": None,
            "gemini_available": False
        }), 200


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5050, debug=False)
