"""Jev decision sidecar for OpenCharts.

Browser -> POST /decide {state, questions, model?} -> OpenRouter /v1/systemone.
OPENROUTER_API_KEY stays server-side: env var first, then C:\\MyTradingProjects\\.env.
Fail-closed: no key -> 503; upstream error -> 502; daily cap -> 429.
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
BASE = os.environ.get("TYPESAFE_BASE_URL", "https://openrouter.ai/api")
ENDPOINT = BASE + "/v1/systemone"
DEFAULT_MODEL = "jev-latest"
ENV_FILE = Path(r"C:\MyTradingProjects\.env")
MAX_CALLS_PER_DAY = int(os.environ.get("JEV_SIDECAR_MAX_CALLS", "2000"))
SPEND_FILE = Path(__file__).with_name("jev-sidecar-spend.json")


def load_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if key:
        return key
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            k, sep, v = line.partition("=")
            if sep and k.strip() == "OPENROUTER_API_KEY":
                return v.strip().strip('"').strip("'")
    return ""


def spend_check_and_increment() -> bool:
    """True = under daily cap (and counted). False = cap reached, refuse."""
    today = date.today().isoformat()
    data = {"date": today, "count": 0}
    try:
        if SPEND_FILE.exists():
            data = json.loads(SPEND_FILE.read_text(encoding="utf-8"))
            if data.get("date") != today:
                data = {"date": today, "count": 0}
    except Exception:
        data = {"date": today, "count": 0}
    if data["count"] >= MAX_CALLS_PER_DAY:
        return False
    data["count"] += 1
    try:
        SPEND_FILE.write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        pass  # spend file write failure must not block decisions
    return True


def calls_today() -> int:
    today = date.today().isoformat()
    try:
        if SPEND_FILE.exists():
            data = json.loads(SPEND_FILE.read_text(encoding="utf-8"))
            return int(data.get("count", 0)) if data.get("date") == today else 0
    except Exception:
        pass
    return 0


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
            self._send({
                "ok": True,
                "key_configured": bool(load_key()),
                "date": date.today().isoformat(),
                "calls_today": calls_today(),
                "max_calls": MAX_CALLS_PER_DAY,
            })
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/decide":
            self.send_error(404)
            return
        key = load_key()
        if not key:
            self._send({"error": "OPENROUTER_API_KEY not set (env or C:\\MyTradingProjects\\.env)"}, 503)
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
        model = payload.get("model") or DEFAULT_MODEL
        body = json.dumps({"model": model, "state": state, "questions": questions}).encode()
        req = urllib.request.Request(
            ENDPOINT, data=body, method="POST",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                out = json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            self._send({"error": f"upstream {e.code}: {detail}"}, 502)
            return
        except Exception as e:
            self._send({"error": f"upstream: {type(e).__name__}: {e}"}, 502)
            return
        # jevbot INV-06 (adapted): OpenRouter resolves "jev-latest" to a versioned
        # name like "typesafe/jev-1.13-20260917" — accept any jev-family model,
        # still fail closed on anything else.
        got_model = out.get("model") if isinstance(out, dict) else None
        if got_model and "jev" not in str(got_model).lower():
            self._send({"error": f"model mismatch: requested {model}, got {got_model}"}, 502)
            return
        self._send(out if isinstance(out, dict) else {"answers": out})

    def log_message(self, fmt: str, *args) -> None:
        print(f"{time.strftime('%H:%M:%S')} {fmt % args}")


if __name__ == "__main__":
    print(f"jev-sidecar on http://{HOST}:{PORT}  endpoint={ENDPOINT}  key={'set' if load_key() else 'MISSING'}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
