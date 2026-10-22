"""Record live futures ticks and publish local 1m bars for /vela.

Fallback for when Shioaji kbars return nothing (daily 500MB quota exhausted,
2026-10-21): the live tick_fop stream still flows and does not count against
the quota, so we keep our own 1m bars.

- Raw ticks: logs/fop-ticks-YYYYMMDD.jsonl (by tick date), replayed on start.
- Bars:      public/local-bars/<CODE>.json  [{time(epoch s), open, high, low, close, volume}]
             rewritten every 10s; Vite serves public/ without a restart.

Run: python -u scripts/fop-tick-recorder.py
"""
import json
import os
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = ROOT / "logs"
BARS_DIR = ROOT / "public" / "local-bars"
STREAM = "http://127.0.0.1:8080/api/v1/stream/data/tick_fop"
TAIPEI = timezone(timedelta(hours=8))
KEEP_DAYS = 3
FLUSH_EVERY = 10
RECORD_PREFIXES = ("TMF",)  # /vela 只看微台；小台 MXF 不錄（換月後代碼前綴不變）

bars: dict[str, dict[int, dict]] = {}  # code -> minute epoch s -> bar
dirty: set[str] = set()


def tick_epoch(t: dict) -> int | None:
    try:
        dt = datetime.fromisoformat(f"{t['date']}T{t['time']}").replace(tzinfo=TAIPEI)
    except (KeyError, ValueError):
        return None
    return int(dt.timestamp())


def add_tick(t: dict) -> bool:
    if t.get("simtrade"):
        return False
    code = t.get("code")
    if not code or not code.startswith(RECORD_PREFIXES):
        return False
    ts = tick_epoch(t)
    try:
        price = float(t.get("close"))
    except (TypeError, ValueError):
        return False
    if not code or ts is None or price <= 0:
        return False
    vol = int(t.get("volume") or 0)
    minute = ts - ts % 60
    b = bars.setdefault(code, {}).get(minute)
    if b is None:
        bars[code][minute] = {"time": minute, "open": price, "high": price, "low": price, "close": price, "volume": vol}
    else:
        b["high"] = max(b["high"], price)
        b["low"] = min(b["low"], price)
        b["close"] = price
        b["volume"] += vol
    dirty.add(code)
    return True


def prune_logs() -> None:
    """Delete raw tick logs older than replay() reads (~20–60MB/day otherwise piles up)."""
    cutoff = datetime.now(TAIPEI).date() - timedelta(days=KEEP_DAYS)
    for f in LOG_DIR.glob("fop-ticks-*.jsonl"):
        try:
            if datetime.strptime(f.stem[-8:], "%Y%m%d").date() < cutoff:
                f.unlink()
        except (ValueError, OSError):
            pass


def replay() -> None:
    cutoff = datetime.now(TAIPEI).date() - timedelta(days=KEEP_DAYS)
    for f in sorted(LOG_DIR.glob("fop-ticks-*.jsonl")):
        try:
            day = datetime.strptime(f.stem[-8:], "%Y%m%d").date()
        except ValueError:
            continue
        if day < cutoff:
            continue
        for line in f.read_text(encoding="utf-8").splitlines():
            try:
                add_tick(json.loads(line))
            except json.JSONDecodeError:
                pass


def flush() -> None:
    BARS_DIR.mkdir(parents=True, exist_ok=True)
    oldest = int(time.time()) - KEEP_DAYS * 86400
    for code in list(dirty):
        series = bars[code]
        for k in [k for k in series if k < oldest]:
            del series[k]
        out = BARS_DIR / f"{code}.json"
        tmp = out.with_suffix(".tmp")
        tmp.write_text(json.dumps([series[k] for k in sorted(series)], separators=(",", ":")), encoding="utf-8")
        # Windows refuses the replace while Vite is serving the file (WinError 5):
        # retry briefly, else keep it dirty for the next flush — never raise (that
        # escaped the reconnect handler and killed the recorder on 2026-10-21 17:14).
        for _ in range(5):
            try:
                os.replace(tmp, out)
                dirty.discard(code)
                break
            except PermissionError:
                time.sleep(0.2)


def run() -> None:
    prune_logs()
    replay()
    flush()
    print(f"replayed: { {c: len(s) for c, s in bars.items()} }", flush=True)
    last_flush = time.time()
    last_prune = datetime.now(TAIPEI).date()
    while True:
        try:
            req = urllib.request.Request(STREAM, headers={"Accept": "text/event-stream"})
            with urllib.request.urlopen(req, timeout=60) as res:
                print("stream connected", flush=True)
                for raw in res:
                    line = raw.decode("utf-8", "replace").strip()
                    if line.startswith("data:") and '"code"' in line:
                        t = json.loads(line[5:])
                        if add_tick(t):
                            day = t["date"].replace("-", "")
                            with open(LOG_DIR / f"fop-ticks-{day}.jsonl", "a", encoding="utf-8") as f:
                                f.write(json.dumps(t, separators=(",", ":")) + "\n")
                    if time.time() - last_flush >= FLUSH_EVERY:
                        flush()
                        last_flush = time.time()
                        if datetime.now(TAIPEI).date() != last_prune:
                            prune_logs()
                            last_prune = datetime.now(TAIPEI).date()
        except Exception as e:  # stream drop / server restart: reconnect
            print(f"stream error: {e}; reconnect in 5s", flush=True)
            flush()
            time.sleep(5)


if __name__ == "__main__":
    run()
