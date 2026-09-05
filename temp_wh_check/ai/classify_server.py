import os
import pickle
import json
import time
from flask import Flask, request, jsonify
from flask_cors import CORS
from google import genai
from google.genai import types

app = Flask(__name__)
CORS(app)  # Allow cross-origin requests from Electron

# ── Load sklearn model ──
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'model.pkl')
try:
    with open(MODEL_PATH, 'rb') as f:
        model = pickle.load(f)
    print(f"✅ sklearn model loaded from {MODEL_PATH}")
except Exception as e:
    print(f"❌ Error loading sklearn model: {e}")
    model = None

# ── Configure Gemini ──
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
gemini_client = None
if GEMINI_API_KEY and GEMINI_API_KEY != 'YOUR_API_KEY_HERE':
    try:
        gemini_client = genai.Client(api_key=GEMINI_API_KEY)
        print("✅ Gemini API configured")
    except Exception as e:
        print(f"⚠️  Gemini config failed: {e}")
else:
    print("⚠️  No GEMINI_API_KEY set — Gemini endpoints will return fallback responses")


# ── Health check ──
@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "sklearn": model is not None,
        "gemini": gemini_client is not None
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

    # Build combined text — MUST match train_classifier.py's build_feature_text()
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


# ── Summarize file content (Gemini) ──
@app.route('/summarize', methods=['POST'])
def summarize_file():
    data = request.json or {}
    filename = data.get('filename', 'Unknown file')
    content_snippet = data.get('content_snippet', '')

    if not content_snippet:
        return jsonify({"summary": "No content available to summarize."}), 200

    if not gemini_client:
        return jsonify({
            "summary": f"[Gemini offline] {filename} — content-based summarization unavailable. Set GEMINI_API_KEY to enable."
        }), 200

    try:
        snippet = content_snippet[:4000]
        prompt = f"""You are NexaFiles AI, an intelligent file assistant.
Provide a concise 2-3 sentence summary of this file's content.
File: {filename}

Content:
{snippet}"""
        result = gemini_client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt
        )
        return jsonify({"summary": result.text})
    except Exception as e:
        return jsonify({"summary": f"Summary failed: {str(e)}"}), 200


# ── NLP chat (Gemini) ──
@app.route('/chat', methods=['POST'])
def chat():
    data = request.json or {}
    message = data.get('message', '')
    context = data.get('context', {})

    if not message:
        return jsonify({"reply": "Please ask me something!"}), 200

    if not gemini_client:
        return jsonify({
            "reply": "Gemini is offline. Set GEMINI_API_KEY to enable natural language chat. I can still help with basic commands!",
            "gemini_available": False
        }), 200

    try:
        # Build context sections
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

        # Classification summary from sklearn model
        classification_section = ""
        if context.get('classificationSummary'):
            classification_section = f"\nAI Classification Summary: {context['classificationSummary']}"

        if context.get('classifiedFiles'):
            cf = context['classifiedFiles']
            file_listings = []
            for category, file_list in cf.items():
                names = [f['name'] for f in file_list[:15]]  # cap at 15 per category
                extra = f" (+{len(file_list) - 15} more)" if len(file_list) > 15 else ""
                file_listings.append(f"  {category} ({len(file_list)} files): {', '.join(names)}{extra}")
            classification_section += "\nDetailed classification:\n" + "\n".join(file_listings)

        context_str = '\n'.join(context_parts)

        prompt = f"""You are NexaFiles AI — an intelligent file management assistant built into a desktop app.
You help users organize files, find duplicates, detect sensitive data, and understand their storage.
Be concise, direct, and action-oriented. Use plain text (no markdown headers).

Current app state:
{context_str if context_str else 'No context available'}
{classification_section}

IMPORTANT INSTRUCTION:
You have access to the sklearn AI classification data above. When the user asks about files by category (e.g. "show me work files", "find my media", "what code files do I have"), use the classification data to answer accurately.

If the user wants to VIEW or FILTER files by a category, you MUST include an "action" field in your JSON response.
You MUST respond with valid JSON in this exact format:
{{"reply": "your text response here", "action": {{"type": "filter", "category": "work"}}}}

Valid categories for filter actions: work, personal, media, code, archive, other

If the user asks to sort files by category:
{{"reply": "Sorting files by AI category.", "action": {{"type": "sort_by_category"}}}}

If NO action is needed (just a normal question/answer), return:
{{"reply": "your text response here"}}

Always respond in valid JSON. Never include anything outside the JSON object.

User: {message}"""

        # Retry with exponential backoff for rate limit errors
        max_retries = 3
        raw = None
        for attempt in range(max_retries + 1):
            try:
                result = gemini_client.models.generate_content(
                    model='gemini-2.5-flash',
                    contents=prompt
                )
                raw = result.text.strip()
                break  # Success, exit retry loop
            except Exception as api_err:
                err_str = str(api_err)
                if '429' in err_str or 'RESOURCE_EXHAUSTED' in err_str:
                    if attempt < max_retries:
                        wait = 2 ** (attempt + 1)  # 2s, 4s, 8s
                        print(f"⏳ Gemini rate limited, retrying in {wait}s (attempt {attempt + 1}/{max_retries})...")
                        time.sleep(wait)
                        continue
                    else:
                        return jsonify({
                            "reply": "I'm a bit busy right now — my rate limit was reached. Please wait a few seconds and try again! 🙏",
                            "action": None,
                            "gemini_available": True
                        }), 200
                else:
                    raise  # Re-raise non-rate-limit errors

        if raw is None:
            return jsonify({"reply": "Couldn't get a response. Please try again.", "action": None, "gemini_available": True}), 200

        # Parse the Gemini response as JSON
        # Strip markdown code fences if present
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
            # If Gemini didn't return valid JSON, use raw text as reply
            return jsonify({"reply": raw, "action": None, "gemini_available": True})

    except Exception as e:
        return jsonify({
            "reply": "Something went wrong on my end. Please try again in a moment.",
            "action": None,
            "gemini_available": False
        }), 200


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5050, debug=False)
