"""SSE stream management: subscribe, connect, reconnect, event dispatch."""

import json
import sys
import time
import urllib.request
import urllib.error

from . import config


def post(path: str, payload: dict, timeout: int = 30) -> dict | list:
    req = urllib.request.Request(f"{config.SHIOAJI_BASE}{path}",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode())


def subscribe_all(stocks: list[dict]) -> int:
    """Subscribe tick for each stock. Returns success count."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    ok = 0
    def sub(s):
        body = {"security_type": "STK", "exchange": s["exchange"],
                "code": s["code"], "quote_type": "Tick"}
        try:
            post(config.SUBSCRIBE_PATH, body, timeout=10)
            return s["code"], True
        except Exception as e:
            return s["code"], False
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = [ex.submit(sub, s) for s in stocks]
        for f in as_completed(futures):
            code, success = f.result()
            if success:
                ok += 1
            else:
                print(f"subscribe {code} failed", file=sys.stderr)
    return ok


def sse_events(path: str, heartbeat: int = 90):
    """Yield (event, data) tuples from SSE endpoint.

    Raises TimeoutError if no complete event arrives for `heartbeat` seconds —
    covers the case where the connection stays open (keep-alive bytes) but the
    server stopped sending events.
    """
    import requests
    res = requests.get(f"{config.SHIOAJI_BASE}{path}",
                       headers={"Accept": "text/event-stream"},
                       stream=True, timeout=(10, 30))  # connect, read
    event, data_lines = None, []
    last_event = time.time()
    for raw in res.iter_lines(decode_unicode=True):
        line = raw.rstrip("\r\n") if raw else ""
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())
        elif line == "":
            if event and data_lines:
                last_event = time.time()
                yield event, "\n".join(data_lines)
            event, data_lines = None, []
        if time.time() - last_event > heartbeat:
            raise TimeoutError(f"SSE heartbeat timeout ({heartbeat}s)")


def stream_loop(stocks: list[dict], on_tick_fn) -> None:
    """Main SSE loop with reconnect. Calls on_tick_fn(code, tick_dict)."""
    backoff = config.SSE_BACKOFF_INIT
    while True:
        try:
            print(f"connecting SSE {config.SHIOAJI_BASE}{config.SSE_TICK_PATH} ...")
            for event, data in sse_events(config.SSE_TICK_PATH):
                if event != config.SSE_TICK_EVENT:
                    continue
                try:
                    t = json.loads(data)
                except json.JSONDecodeError:
                    continue
                code = t.get("code", "")
                if code:
                    on_tick_fn(code, t)
            backoff = config.SSE_BACKOFF_INIT
        except Exception as e:
            print(f"SSE error: {type(e).__name__}: {e} — reconnect in {backoff}s",
                  file=sys.stderr)
            time.sleep(backoff)
            backoff = min(backoff * 2, config.SSE_BACKOFF_MAX)
            subscribe_all(stocks)
