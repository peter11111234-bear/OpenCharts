"""Storage: jsonl read/write, watchlist cache, report output."""

import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

from . import config

TAIPEI = timezone(timedelta(hours=config.TZ_OFFSET))


def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def load_watchlist(date_str: str | None = None) -> list[dict]:
    """Load logs/hot-watchlist-YYYYMMDD.json. Returns stocks list."""
    if date_str:
        d = date_str.replace("-", "")
        path = config.LOG_DIR / f"{config.WATCHLIST_PREFIX}-{d}.json"
        if not path.exists():
            print(f"watchlist {path} missing — run hot-watchlist.py first", file=sys.stderr)
            sys.exit(1)
        return json.loads(path.read_text(encoding="utf-8"))["stocks"]
    # newest file
    files = sorted(config.LOG_DIR.glob(f"{config.WATCHLIST_PREFIX}-*.json"))
    if not files:
        print("no watchlist found — run hot-watchlist.py first", file=sys.stderr)
        sys.exit(1)
    return json.loads(files[-1].read_text(encoding="utf-8"))["stocks"]


def write_dist(dist: dict, date_str: str) -> None:
    """Write per-stock tick amount histogram for calibration."""
    path = config.LOG_DIR / f"{config.DIST_LOG_PREFIX}-{date_str}.jsonl"
    for code, buckets in dist.items():
        append_jsonl(path, {"date": date_str, "code": code, "buckets": buckets})


def read_events(path: Path | None = None) -> tuple[list[dict], list[dict], dict]:
    """Read scanner jsonl → (events, alerts, fwd_updates)."""
    path = path or config.SCANNER_LOG
    events, alerts, fwd = [], [], {}
    if not path.exists():
        return events, alerts, fwd
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "alert" in d:
            alerts.append(d)
        elif "fwd_update" in d:
            u = d["fwd_update"]
            fwd.setdefault(u["event_ts"], {})[u["window"]] = u["pct"]
        elif "code" in d:
            events.append(d)
    return events, alerts, fwd


def print_report() -> None:
    events, alerts, fwd = read_events()
    print(f"events: {len(events)}  alerts: {len(alerts)}")
    by_code: dict[str, list] = {}
    for e in events:
        by_code.setdefault(e["code"], []).append(e)
    print(f"{'code':<6} {'name':<10} {'n':>3} {'buy':>4} {'sell':>4} {'net_M':>8} {'fwd5m%':>7}")
    for code, evs in sorted(by_code.items(), key=lambda x: -len(x[1]))[:20]:
        buys = sum(1 for e in evs if e.get("tick_dir", 0) > 0)
        sells = len(evs) - buys
        net = sum(e["amount_tick"] * (1 if e.get("tick_dir", 0) > 0 else -1) for e in evs) / 1e6
        f5 = [fwd.get(e["ts"], {}).get("5m") for e in evs]
        f5 = [x for x in f5 if x is not None]
        avg5 = sum(f5) / len(f5) if f5 else 0
        print(f"{code:<6} {evs[0].get('name', code):<10} {len(evs):>3} {buys:>4} {sells:>4} "
              f"{net:>+8.0f} {avg5:>+7.2f}")
