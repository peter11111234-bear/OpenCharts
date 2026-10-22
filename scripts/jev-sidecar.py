"""Jev decision sidecar for OpenCharts.

Browser -> POST /decide {state, questions, model?} -> first working Jev channel.

The JEV-FREE model on the OpenCode GO subscription is the primary and effectively
the only channel the shadow collector should ever need (it is $0):

  1. jev-zen     https://opencode.ai/zen/v1/systemone    model jev-1.13-free   ($0, GO sub)
  2. jev-direct  https://api.typesafe.ai/v1/systemone    model jev-latest      (fallback)

OpenRouter was removed on 2026-10-16 by request. It was also the actual cause of
a full outage: this file used to read only OPENROUTER_API_KEY, which had been
revoked (upstream 401 "User not found"), so every shadow decision 502'd.

The Zen key comes from the OpenCode credential store (~/.local/share/opencode/
auth.json, "opencode-go"), so no key needs to live in this repo.

Fail-closed: no key at all -> 503; every upstream failing -> 502; daily cap -> 429.

Run:  python C:\\Users\\bear9\\OpenCharts\\scripts\\jev-sidecar.py
"""
import json
import os
import time
import urllib.request
import urllib.error
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HOST = "127.0.0.1"
PORT = 8787

ZEN_ENDPOINT = os.environ.get("JEV_ZEN_ENDPOINT", "https://opencode.ai/zen/v1/systemone")
ZEN_MODEL = os.environ.get("JEV_ZEN_MODEL", "jev-1.13-free")
DIRECT_ENDPOINT = os.environ.get("JEV_DIRECT_ENDPOINT", "https://api.typesafe.ai/v1/systemone")
DIRECT_MODEL = os.environ.get("JEV_DIRECT_MODEL", "jev-latest")

ENV_FILE = Path(r"C:\MyTradingProjects\.env")
JEV_DOTENV = Path(r"C:\Users\bear9\jev-laya-bench\jev-wigolo\.env")
AUTH_JSON = Path(os.path.expanduser("~/.local/share/opencode/auth.json"))
MAX_CALLS_PER_DAY = int(os.environ.get("JEV_SIDECAR_MAX_CALLS", "2000"))
PAID_MAX_PER_DAY = int(os.environ.get("JEV_PAID_MAX_CALLS", "1000"))
SPEND_FILE = Path(__file__).with_name("jev-sidecar-spend.json")
UPSTREAM_TIMEOUT = int(os.environ.get("JEV_SIDECAR_TIMEOUT", "60"))
RATE_BACKOFF_BASE = int(os.environ.get("JEV_RATE_BACKOFF_S", "60"))

# Free-tier rate-limit state. jev-1.13-free answers with FreeUsageLimitError (429)
# once its quota is drained; remember when we may try it again instead of
# hammering it on every request.
_RATE = {"until": 0.0, "streak": 0}


def _dotenv_key(path: Path, name: str) -> str:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if s.startswith("export "):
                s = s[len("export "):].lstrip()
            if s.startswith(name + "="):
                val = s.split("=", 1)[1].strip()
                if " #" in val:  # strip inline comment suffix
                    val = val.split(" #", 1)[0].rstrip()
                return val.strip('"').strip("'")
    except OSError:
        pass
    return ""


def load_key(name: str) -> str:
    """env first, then the two project .env files."""
    k = os.environ.get(name, "").strip()
    if k:
        return k
    for path in (ENV_FILE, JEV_DOTENV):
        k = _dotenv_key(path, name)
        if k:
            return k
    return ""


def zen_key() -> str:
    """GO subscription key first (auth.json "opencode-go"), then OPENCODE_API_KEY,
    then the plain Zen credential. Mirrors jev_judge._zen_key."""
    try:
        auth = json.loads(AUTH_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        auth = {}
    go = auth.get("opencode-go")
    if isinstance(go, dict) and go.get("key"):
        return go["key"]
    k = os.environ.get("OPENCODE_API_KEY", "").strip()
    if k:
        return k
    oc = auth.get("opencode")
    if isinstance(oc, dict):
        return oc.get("key") or ""
    return ""


def channels() -> list[dict]:
    """JEV-FREE on the OpenCode GO subscription first, then TypeSafe direct.

    Zen is $0, so the shadow collector normally costs nothing. TypeSafe direct
    is kept as a funded fallback for when Zen is unavailable. OpenRouter was
    removed 2026-10-16 by request (and its key was dead anyway).
    """
    out = []
    k = zen_key()
    if k:
        out.append({"tag": "jev-zen", "url": ZEN_ENDPOINT, "key": k, "model": ZEN_MODEL})
    k = load_key("TYPESAFE_API_KEY")
    if k:
        out.append({"tag": "jev-direct", "url": DIRECT_ENDPOINT, "key": k, "model": DIRECT_MODEL})
    return out


def _spend_load() -> dict:
    today = date.today().isoformat()
    data = {"date": today, "count": 0, "paid": 0}
    try:
        if SPEND_FILE.exists():
            data = json.loads(SPEND_FILE.read_text(encoding="utf-8"))
            if data.get("date") != today:
                data = {"date": today, "count": 0, "paid": 0}
    except Exception:
        data = {"date": today, "count": 0, "paid": 0}
    data["date"] = today
    data.setdefault("count", 0)
    data.setdefault("paid", 0)
    return data


def _spend_save(data: dict) -> None:
    try:
        SPEND_FILE.write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        pass  # a spend-file write failure must not block decisions


def spend_check_and_increment() -> bool:
    """True = under the daily cap (and counted). False = cap reached, refuse."""
    data = _spend_load()
    if data["count"] >= MAX_CALLS_PER_DAY:
        return False
    data["count"] += 1
    _spend_save(data)
    return True


def record_paid_call() -> None:
    """Count a call that a non-free channel served, so a backfill cannot quietly
    drain the funded TypeSafe balance."""
    data = _spend_load()
    data["paid"] = data.get("paid", 0) + 1
    _spend_save(data)


def spend_refund() -> None:
    """Refund a daily slot when every channel fails, so budget isn't eaten by outages."""
    data = _spend_load()
    if data.get('count', 0) > 0:
        data['count'] -= 1
    _spend_save(data)


def spend_snapshot() -> dict:
    data = _spend_load()
    return {"calls_today": data["count"], "paid_today": data["paid"], "paid_max": PAID_MAX_PER_DAY}


def rate_limit_until() -> float:
    """Unix time before which the free channel should not be retried."""
    return _RATE["until"]


def note_rate_limit(retry_after: int | None = None) -> float:
    """Remember a free-tier 429 with exponential backoff. Returns the new until."""
    _RATE["streak"] += 1
    delay = retry_after or min(RATE_BACKOFF_BASE * (2 ** (_RATE["streak"] - 1)), 900)
    _RATE["until"] = time.time() + delay
    return _RATE["until"]


def clear_rate_limit() -> None:
    _RATE["streak"] = 0
    _RATE["until"] = 0.0


def ask_jev(state: dict, questions: dict, model: str | None) -> tuple[dict | None, str | None, int]:
    """Try each channel in order. Returns (payload, error, status).

    Free tier first. A free-tier 429 is remembered with exponential backoff, and
    the funded channel is only used while under its own daily cap — so a burst
    can neither hammer the free quota nor silently drain the paid balance.
    Accepts any jev-family model name back (the relay resolves "jev-latest" to
    something like "typesafe/jev-1.13-20260917") and fails closed on anything
    else — jevbot INV-06 (adapted).
    """
    errors = []
    now = time.time()
    for ch in channels():
        free = ch["tag"] == "jev-zen"
        if free and now < _RATE["until"]:
            errors.append(f"{ch['tag']} skipped (cooling down {int(_RATE['until'] - now)}s)")
            continue
        if not free and _spend_load()["paid"] >= PAID_MAX_PER_DAY:
            errors.append(f"{ch['tag']} skipped (paid cap {PAID_MAX_PER_DAY}/day reached)")
            continue
        body = json.dumps({"model": model or ch["model"], "state": state,
                           "questions": questions}).encode()
        req = urllib.request.Request(
            ch["url"], data=body, method="POST",
            headers={"Authorization": f"Bearer {ch['key']}",
                     "Content-Type": "application/json",
                     "User-Agent": "jev-sidecar/1.2"},
        )
        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as res:
                out = json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:200]
            errors.append(f"{ch['tag']} HTTP {e.code}: {detail}")
            if e.code == 429:
                if free:
                    note_rate_limit()
                else:
                    _RATE["until"] = max(_RATE["until"], time.time() + RATE_BACKOFF_BASE)
            continue
        except Exception as e:
            errors.append(f"{ch['tag']} {type(e).__name__}: {e}")
            continue
        got_model = out.get("model") if isinstance(out, dict) else None
        if got_model and "jev" not in str(got_model).lower():
            errors.append(f"{ch['tag']} model mismatch: {got_model}")
            continue
        if free:
            clear_rate_limit()
        else:
            record_paid_call()
        if isinstance(out, dict):
            out["_channel"] = ch["tag"]
        return out, None, 200
    if not errors:
        return None, "no Jev channel: log in to OpenCode Zen (opencode-go) or set TYPESAFE_API_KEY", 503
    status = 429 if _RATE["until"] > time.time() else 502
    return None, "all Jev channels failed: " + " | ".join(errors), status


class Handler(BaseHTTPRequestHandler):
    def _send(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if urlparse(self.path).path == "/health":
            chans = channels()
            snap = spend_snapshot()
            until = rate_limit_until()
            self._send({
                "ok": bool(chans),
                "channels": [c["tag"] for c in chans],
                "key_configured": bool(chans),
                "date": date.today().isoformat(),
                "rate_limited_until": round(until, 2),
                "rate_limited_for": max(0, int(until - time.time())),
                **snap,
                "max_calls": MAX_CALLS_PER_DAY,
            })
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/decide":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            self._send({"error": f"bad request: {e}"}, 400)
            return
        state = payload.get("state")
        questions = payload.get("questions")
        if not isinstance(state, dict) or not isinstance(questions, dict) or not questions:
            self._send({"error": "body must be {state: object, questions: object}"}, 400)
            return
        if not spend_check_and_increment():
            self._send({"error": f"daily cap {MAX_CALLS_PER_DAY} reached"}, 429)
            return
        out, err, status = ask_jev(state, questions, payload.get("model"))
        if err:
            if "all Jev channels failed" in (err or ""):
                spend_refund()
            self._send({"error": err, "rate_limited_for": max(0, int(rate_limit_until() - time.time()))},
                       status)
            return
        self._send(out if isinstance(out, dict) else {"answers": out})

    def log_message(self, fmt: str, *args) -> None:
        print(f"{time.strftime('%H:%M:%S')} {fmt % args}")


if __name__ == "__main__":
    _chans = channels()
    print(f"jev-sidecar on http://{HOST}:{PORT}  channels={[c['tag'] for c in _chans] or 'NONE (503)'}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
