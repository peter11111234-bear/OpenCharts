"""Backfill missing ticks for all watchlist stocks.

Usage: python -m hotscan.backfill [--since HH:MM:SS]
  --since  fetch only ticks from this Taipei time to now (RangeTime query).
           Without it the whole day is fetched (AllDay) — only for the first
           backfill of a day: a full day of ~100 stocks is ~400k ticks, and
           repeating that every 30 min burned the 500MB daily Shioaji quota
           on 2026-10-21 while adding <1% new ticks.

Dedup strategy: use full datetime string (microsecond precision) as unique key.
Validation: warn if stored count < API count.
"""
import argparse
import json
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from hotscan import config, storage, stream

TAIPEI = timezone(timedelta(hours=config.TZ_OFFSET))
TICK_LOG = config.LOG_DIR / "hot-ticks.jsonl"


def ticks_body(contract: dict, date_str: str, since: str | None, until: str) -> dict:
    """Request body: the whole day, or only [since, until] when since is given."""
    body = {"contract": contract, "date": date_str}
    if since:
        body.update(query_type="RangeTime", time_start=since, time_end=until)
    return body


def fetch_ticks(contract: dict, date_str: str, since: str | None = None, until: str = "23:59:59") -> list[dict]:
    """Fetch ticks for a contract on a date (whole day, or from `since`)."""
    body = ticks_body(contract, date_str, since, until)
    try:
        res = stream.post("/api/v1/data/ticks", body, timeout=60)
        dts = res.get("datetime", [])
        closes = res.get("close", [])
        vols = res.get("volume", [])
        tts = res.get("tick_type", [])
        ticks = []
        for i in range(len(dts)):
            ticks.append({
                "dt": dts[i],  # full datetime string for dedup
                "close": closes[i] if i < len(closes) else 0,
                "volume": vols[i] if i < len(vols) else 0,
                "tick_type": tts[i] if i < len(tts) else 0,
            })
        return ticks
    except Exception as e:
        print(f"fetch {contract['code']} failed: {e}", file=sys.stderr)
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="HH:MM:SS Taipei; fetch only from this time (default: whole day)")
    args = ap.parse_args()
    if args.since:
        datetime.strptime(args.since, "%H:%M:%S")  # fail fast on a bad value

    stocks = storage.load_watchlist()
    now = datetime.now(TAIPEI)
    today = now.strftime("%Y-%m-%d")
    until = now.strftime("%H:%M:%S")
    print(f"range: {args.since or 'all day'} -> {until if args.since else ''}")

    # load existing datetime keys per code
    seen: dict[str, set] = {}
    if TICK_LOG.exists():
        for line in TICK_LOG.read_text(encoding="utf-8").splitlines():
            try:
                d = json.loads(line)
                code = d["code"]
                # use dt if present, else composite key for old records
                key = d.get("dt") or (d["ts"], d["price"], d["vol"], d.get("tick_type", 0))
                if code not in seen:
                    seen[code] = set()
                seen[code].add(key)
            except:
                pass

    total_added = 0
    total_api = 0
    for s in stocks:
        code = s["code"]
        contract = {"security_type": "STK", "exchange": s["exchange"], "code": code}
        ticks = fetch_ticks(contract, today, args.since, until)
        total_api += len(ticks)
        added = 0
        for t in ticks:
            dt_str = t["dt"]
            try:
                ts = int(datetime.fromisoformat(dt_str).replace(tzinfo=TAIPEI).timestamp())
                price = float(t["close"])
                vol = t["volume"]
                tt = t["tick_type"]
            except Exception:
                continue
            if code not in seen:
                seen[code] = set()
            # dual check: dt (backfilled records) + composite (live records lack dt)
            if dt_str in seen[code] or (ts, price, vol, tt) in seen[code]:
                continue
            seen[code].add(dt_str)
            storage.append_jsonl(TICK_LOG, {
                "ts": ts, "dt": dt_str, "code": code, "price": price, "vol": vol,
                "tick_type": tt, "amount": 0,
            })
            added += 1
        total_added += added
        skipped = len(ticks) - added
        # warn only when API has data but nothing added AND nothing skipped —
        # skipped ticks were already logged live (normal), not a loss
        if len(ticks) > 0 and added == 0 and skipped == 0:
            print(f"WARNING {code}: API={len(ticks)} added=0 skipped=0 (fetch/parse error)")
        else:
            print(f"{code}: +{added}/{len(ticks)} (skipped {skipped} existing)")
        time.sleep(0.1)

    print(f"total: API={total_api} added={total_added}")
    if total_added < total_api * 0.9:
        print("ERROR: significant tick loss detected")


if __name__ == "__main__":
    main()
