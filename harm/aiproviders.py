"""Built-in AI Assist: send photos plus HaRM's prompt to the AI service the user picked.

Supported: Anthropic (Claude), OpenAI (ChatGPT), Google (Gemini), and any OpenAI-compatible
endpoint (Ollama, LM Studio, OpenRouter, …). Only the user's own API key is used; it is stored
encrypted in the vault. Redirects are never followed, so the key can't leak to another host.
"""

import json
import ssl
import urllib.error
import urllib.request
from urllib.parse import urlparse

TIMEOUT = 240
MAX_TOKENS = 8000

PROVIDERS = {
    "anthropic": {"label": "Claude (Anthropic)", "model": "claude-sonnet-5-5", "web": True, "key": True,
                  "keys_url": "https://console.anthropic.com/settings/keys"},
    "openai": {"label": "ChatGPT (OpenAI)", "model": "gpt-5", "web": True, "key": True,
               "keys_url": "https://platform.openai.com/api-keys"},
    "gemini": {"label": "Gemini (Google)", "model": "gemini-2.5-flash", "web": True, "key": True,
               "keys_url": "https://aistudio.google.com/apikey"},
    "compatible": {"label": "Other / local (OpenAI-compatible: Ollama, LM Studio, OpenRouter…)", "model": "",
                   "web": False, "key": False, "keys_url": ""},
}


class AIError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=ssl.create_default_context()))


def _post(url: str, headers: dict, body: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    try:
        with _opener.open(req, timeout=TIMEOUT) as r:
            return json.loads(r.read(20_000_000))
    except urllib.error.HTTPError as e:
        detail = e.read(4000).decode(errors="replace")
        try:
            j = json.loads(detail)
            detail = (j.get("error") or {}).get("message") if isinstance(j.get("error"), dict) else j.get("error") or j.get("message") or detail
        except ValueError:
            pass
        if e.code in (401, 403):
            raise AIError(f"The AI service rejected the API key ({e.code}). Check it in Settings › AI Assist.")
        if e.code == 429:
            raise AIError("The AI service says you're over its rate or spending limit (429). Try again later or check your plan.")
        raise AIError(f"The AI service answered {e.code}: {str(detail)[:400]}")
    except (urllib.error.URLError, OSError) as e:
        raise AIError(f"Couldn't reach the AI service: {getattr(e, 'reason', e)}")
    except ValueError:
        raise AIError("The AI service sent back something that isn't JSON.")


def _split(data_url: str) -> tuple[str, str]:
    head, _, b64 = data_url.partition(",")
    mime = head[5:].split(";")[0] if head.startswith("data:") else "image/jpeg"
    if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
        raise AIError("Photos must be JPEG, PNG, WebP or GIF")
    return mime, b64


# ---------------------------------------------------------------- providers

def _anthropic(conf, key, prompt, images, web):
    content = [{"type": "image", "source": {"type": "base64", "media_type": m, "data": d}} for m, d in map(_split, images)]
    content.append({"type": "text", "text": prompt})
    body = {"model": conf["model"], "max_tokens": MAX_TOKENS, "messages": [{"role": "user", "content": content}]}
    if web:
        body["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 8}]
    r = _post("https://api.anthropic.com/v1/messages",
              {"x-api-key": key, "anthropic-version": "2023-06-01"}, body)
    return "\n".join(b.get("text", "") for b in r.get("content", []) if b.get("type") == "text")


def _openai(conf, key, prompt, images, web):
    content = [{"type": "input_text", "text": prompt}]
    content += [{"type": "input_image", "image_url": url} for url in images]
    body = {"model": conf["model"], "input": [{"role": "user", "content": content}]}
    if web:
        body["tools"] = [{"type": "web_search"}]
    r = _post("https://api.openai.com/v1/responses", {"Authorization": f"Bearer {key}"}, body)
    if r.get("output_text"):
        return r["output_text"]
    texts = []
    for item in r.get("output", []):
        for c in item.get("content", []) or []:
            if c.get("type") in ("output_text", "text"):
                texts.append(c.get("text", ""))
    return "\n".join(texts)


def _gemini(conf, key, prompt, images, web):
    parts = [{"inline_data": {"mime_type": m, "data": d}} for m, d in map(_split, images)]
    parts.append({"text": prompt})
    body = {"contents": [{"role": "user", "parts": parts}]}
    if web:
        body["tools"] = [{"google_search": {}}]
    model = conf["model"].removeprefix("models/")
    r = _post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
              {"x-goog-api-key": key}, body)
    cands = r.get("candidates") or []
    if not cands:
        raise AIError("Gemini returned no answer" + (f": {r.get('promptFeedback')}" if r.get("promptFeedback") else ""))
    return "\n".join(p.get("text", "") for p in (cands[0].get("content") or {}).get("parts", []))


def _compatible(conf, key, prompt, images, web):
    base = (conf.get("base_url") or "").rstrip("/")
    u = urlparse(base)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise AIError("Set the service address in Settings › AI Assist, e.g. http://localhost:11434/v1 for Ollama.")
    if not conf.get("model"):
        raise AIError("Set the model name in Settings › AI Assist (one that can see images, e.g. llava or qwen2.5vl).")
    content = [{"type": "text", "text": prompt}] + [{"type": "image_url", "image_url": {"url": url}} for url in images]
    body = {"model": conf["model"], "messages": [{"role": "user", "content": content}], "max_tokens": MAX_TOKENS}
    r = _post(f"{base}/chat/completions", {"Authorization": f"Bearer {key}"} if key else {}, body)
    try:
        return r["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise AIError("The service's reply wasn't in the OpenAI chat format.")


CALL = {"anthropic": _anthropic, "openai": _openai, "gemini": _gemini, "compatible": _compatible}


def ask(conf: dict, key: str | None, prompt: str, images: list[str]) -> dict:
    """Send the photos and prompt; returns {"text": reply, "web": used_web_search, "note": str|None}."""
    provider = conf.get("provider")
    if provider not in CALL:
        raise AIError("Choose an AI service in Settings › AI Assist first.")
    if PROVIDERS[provider]["key"] and not key:
        raise AIError("Add your API key in Settings › AI Assist first.")
    if not images:
        raise AIError("Add at least one photo.")
    conf = {**conf, "model": conf.get("model") or PROVIDERS[provider]["model"]}
    web = bool(conf.get("web", True)) and PROVIDERS[provider]["web"]
    try:
        text = CALL[provider](conf, key, prompt, images, web)
        note = None
    except AIError as e:
        # Some models/accounts can't use web search: try once more without it.
        if not web or not any(w in str(e).lower() for w in ("tool", "search", "web")):
            raise
        text = CALL[provider](conf, key, prompt, images, False)
        web, note = False, "Web search wasn't available for this model, so values are the AI's own estimates."
    if not text.strip():
        raise AIError("The AI returned an empty answer. Try clearer photos or another model.")
    return {"text": text, "web": web, "note": note}
