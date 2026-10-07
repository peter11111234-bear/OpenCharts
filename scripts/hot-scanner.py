"""Hot-stock large-order scanner — real-time tick stream, single-print ≥10M detection.

Subscribes the top-100 (by daily amount) TW stocks via the local shioaji server,
consumes the tick SSE stream, detects single-tick prints ≥ --min-amount,
maintains rolling 5/15/30/60m stats per stock, tracks net large-order momentum
for reversal alerts, and appends everything to logs/hot-scanner.jsonl.

No orders, no polling — pure SSE push + local computation.

Run:
  python scripts/hot-scanner.py                    # live, latest watchlist
  python scripts/hot-scanner.py --date 2026-09-22  # specific watchlist file
  python scripts/hot-scanner.py --replay FILE      # replay tick jsonl
  python scripts/hot-scanner.py --report           # summarize today's jsonl
"""
import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

SHIOAJI = "http://127.0.0.1:8080"
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
TAIPEI = timezone(timedelta(hours=8))
FWD_WINDOWS = (300, 900, 1800, 3600)          # +5m/+15m/+30m/+60m seconds
STAT_WINDOWS = (300, 900, 1800, 3600)
REVERSAL_PCT = 0.30                            # peak/trough reversal threshold
REVERSAL_MIN = 20_000_000                      # min absolute move to alert (元)
NET_WINDOW = 3600                              # net_large rolling window (s)


# ── HTTP helpers ──

def post(path: str, payload: dict, timeout: int = 30) -> dict | list:
    req = urllib.request.Request(f"{SHIOAJI}{path}", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode())


def get_sse(path: str, timeout: int = 30, heartbeat: int = 60):
    """Yield parsed SSE events {event, data} from a streaming endpoint."""
    req = urllib.request.Request(f"{SHIOAJI}{path}", headers={"Accept": "text/event-stream"})
    res = urllib.request.urlopen(req, timeout=timeout)
    event, data = None, []
    last_data = time.time()
    for raw in res:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].strip())
            last_data = time.time()
        elif line == "":
            if event and data:
                yield event, "\n".join(data)
            event, data = None, []
        # heartbeat check: if no data for N seconds, raise to trigger reconnect
        if time.time() - last_data > heartbeat:
            raise TimeoutError(f"SSE heartbeat timeout ({heartbeat}s)")


# ── Watchlist ──

def load_watchlist(date_str: str | None) -> list[dict]:
    """Load logs/hot-watchlist-YYYYMMDD.json; regenerate via hot-watchlist.py if missing."""
    if date_str:
        d = date_str.replace("-", "")
    else:
        # find newest watchlist file
        files = sorted(LOG_DIR.glob("hot-watchlist-*.json"))
        if files:
            return json.loads(files[-1].read_text(encoding="utf-8"))["stocks"]
        d = datetime.now(TAIPEI).strftime("%Y%m%d")
    path = LOG_DIR / f"hot-watchlist-{d}.json"
    if not path.exists():
        print(f"watchlist {path} missing — run hot-watchlist.py first", file=sys.stderr)
        sys.exit(1)
    return json.loads(path.read_text(encoding="utf-8"))["stocks"]


# ── Per-stock state ──

class StockState:
    __slots__ = ("code", "name", "exchange", "last_price", "last_tick_price",
                 "bar", "bars_1m", "large_events", "net_large", "net_peak",
                 "net_trough", "pending_fwd", "consec_large")

    def __init__(self, code: str, name: str, exchange: str):
        self.code = code
        self.name = name
        self.exchange = exchange
        self.last_price = 0.0
        self.last_tick_price = 0.0
        self.bar: dict | None = None          # current 1m bucket
        self.bars_1m: deque = deque(maxlen=60)  # last 60 completed 1m bars
        self.large_events: deque = deque(maxlen=200)  # (ts, amount, dir) for net_large
        self.net_large = 0.0
        self.net_peak = 0.0
        self.net_trough = 0.0
        self.pending_fwd: list[dict] = []
        self.consec_large = 0


def minute_bucket(epoch: int) -> int:
    return epoch - (epoch % 60)


def tick_epoch(t: dict) -> int:
    ms = _parse_dt(t.get("date", ""), t.get("time", ""))
    return ms if ms else int(time.time())


def _parse_dt(d: str, t: str) -> int:
    try:
        return int(datetime.fromisoformat(f"{d}T{t}").replace(tzinfo=TAIPEI).timestamp())
    except Exception:
        return 0


def tick_price(t: dict) -> float:
    v = t.get("close", 0)
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# ── Stats ──

def rolling_stats(st: StockState, now: int) -> dict:
    out = {}
    for w in STAT_WINDOWS:
        cutoff = now - w
        vol = buy = sell = large_n = 0
        first_close = None
        for b in reversed(st.bars_1m):
            if b["time"] < cutoff:
                break
            vol += b["volume"]
            if b["close"] > b["open"]:
                buy += b["volume"]
            elif b["close"] < b["open"]:
                sell += b["volume"]
            if b.get("large"):
                large_n += 1
            if first_close is None:
                first_close = b["open"]
        chg = ((st.last_price - first_close) / first_close * 100) if first_close else 0
        out[f"{w // 60}m"] = {"vol": vol, "buy_vol": buy, "sell_vol": sell,
                              "large_n": large_n, "chg_pct": round(chg, 2)}
    return out


def update_net_large(st: StockState, ts: int, amount: float, direction: int) -> None:
    st.large_events.append((ts, amount, direction))
    cutoff = ts - NET_WINDOW
    while st.large_events and st.large_events[0][0] < cutoff:
        st.large_events.popleft()
    st.net_large = sum(a * d for _, a, d in st.large_events)
    if st.net_large > st.net_peak:
        st.net_peak = st.net_large
    if st.net_large < st.net_trough:
        st.net_trough = st.net_large


def check_reversal(st: StockState, ts: int) -> dict | None:
    """Return alert dict if net_large reversed ≥30% and ≥20M from peak/trough."""
    if st.net_peak > 0:
        drop = st.net_peak - st.net_large
        if drop >= REVERSAL_MIN and st.net_peak > 0 and drop / st.net_peak >= REVERSAL_PCT:
            alert = {"alert": "buy_exhaustion", "code": st.code, "name": st.name,
                     "net_large": round(st.net_large), "peak": round(st.net_peak),
                     "drop_pct": round(drop / st.net_peak, 2), "ts": ts}
            st.net_peak = st.net_large  # reset so we don't re-fire
            return alert
    if st.net_trough < 0:
        rise = st.net_large - st.net_trough
        if rise >= REVERSAL_MIN and st.net_trough < 0 and rise / abs(st.net_trough) >= REVERSAL_PCT:
            alert = {"alert": "sell_relief", "code": st.code, "name": st.name,
                     "net_large": round(st.net_large), "trough": round(st.net_trough),
                     "rise_pct": round(rise / abs(st.net_trough), 2), "ts": ts}
            st.net_trough = st.net_large
            return alert
    return None


# ── Event handling ──

def on_tick(st: StockState, t: dict, min_amount: float, log_f) -> None:
    price = tick_price(t)
    vol = t.get("volume", 0) or 0
    ts = tick_epoch(t)
    if price <= 0:
        return

    # tick direction vs previous tick
    tick_dir = 0
    if st.last_tick_price > 0:
        tick_dir = 1 if price > st.last_tick_price else -1 if price < st.last_tick_price else 0
    st.last_tick_price = price
    st.last_price = price

    amount = vol * price * 1000  # volume is in 張 (1000 shares)
    is_large = amount >= min_amount

    # 1m bar aggregation
    bucket = minute_bucket(ts)
    if st.bar is None or st.bar["time"] != bucket:
        if st.bar is not None:
            st.bars_1m.append(st.bar)
        st.bar = {"time": bucket, "open": price, "high": price, "low": price,
                  "close": price, "volume": vol, "large": False}
    else:
        st.bar["high"] = max(st.bar["high"], price)
        st.bar["low"] = min(st.bar["low"], price)
        st.bar["close"] = price
        st.bar["volume"] += vol

    if is_large:
        st.bar["large"] = True
        st.consec_large += 1
        direction = tick_dir if tick_dir != 0 else (1 if price >= st.bar["open"] else -1)
        update_net_large(st, ts, amount, direction)

        event = {
            "ts": ts, "bar_time": bucket, "code": st.code, "name": st.name,
            "exchange": st.exchange, "price": price,
            "vol_tick": vol, "amount_tick": round(amount),
            "tick_dir": tick_dir, "consec_large_1m": st.consec_large,
            "stats": rolling_stats(st, ts),
            "fwd": {f"{w // 60}m": None for w in FWD_WINDOWS},
        }
        st.pending_fwd.append({"event_ts": ts, "price": price,
                               "deadlines": {w: ts + w for w in FWD_WINDOWS},
                               "fwd": event["fwd"]})
        log_f.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        log_f.flush()
        print(f"{datetime.fromtimestamp(ts, TAIPEI):%H:%M:%S} {st.code} {st.name} "
              f"{'BUY' if direction > 0 else 'SELL'} {vol}張 @{price} "
              f"= {amount / 1e6:.0f}M net={st.net_large / 1e6:+.0f}M")

        alert = check_reversal(st, ts)
        if alert:
            log_f.write(json.dumps(alert, ensure_ascii=False, separators=(",", ":")) + "\n")
            log_f.flush()
            print(f"  *** ALERT {alert['alert']} {st.code} {st.name} "
                  f"net={alert['net_large'] / 1e6:+.0f}M "
                  f"peak={alert.get('peak', alert.get('trough', 0)) / 1e6:.0f}M ***")
    else:
        st.consec_large = 0

    # fwd backfill
    for pf in st.pending_fwd:
        for w in FWD_WINDOWS:
            key = f"{w // 60}m"
            if pf["fwd"][key] is None and ts >= pf["deadlines"][w]:
                pf["fwd"][key] = round((price - pf["price"]) / pf["price"] * 100, 3)
                upd = {"fwd_update": {"code": st.code, "event_ts": pf["event_ts"],
                                      "window": key, "pct": pf["fwd"][key]}}
                log_f.write(json.dumps(upd, ensure_ascii=False, separators=(",", ":")) + "\n")
    st.pending_fwd = [p for p in st.pending_fwd if any(v is None for v in p["fwd"].values())]


# ── Subscribe & stream ──

def subscribe_all(stocks: list[dict]) -> int:
    ok = 0
    for s in stocks:
        contract = {"security_type": "STK", "exchange": s["exchange"], "code": s["code"]}
        try:
            post("/api/v1/stream/subscribe", {"contract": contract, "quote_type": "Tick"})
            ok += 1
        except Exception as e:
            print(f"subscribe {s['code']} failed: {e}", file=sys.stderr)
    return ok


def run_live(stocks: list[dict], min_amount: float) -> None:
    primary = [s for s in stocks if s.get("role") == "primary"]
    alternate = [s for s in stocks if s.get("role") == "alternate"]
    print(f"watchlist: {len(primary)} primary + {len(alternate)} alternate")

    n = subscribe_all(primary)
    print(f"subscribed {n}/{len(primary)}")
    if n < len(primary) and alternate:
        need = len(primary) - n
        print(f"subscribing {min(need, len(alternate))} alternates")
        subscribe_all(alternate[:need])

    states = {s["code"]: StockState(s["code"], s["name"], s["exchange"]) for s in stocks}
    log_path = LOG_DIR / "hot-scanner.jsonl"
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    backoff = 1
    last_data = time.time()
    while True:
        try:
            print(f"connecting SSE {SHIOAJI}/api/v1/stream/data/tick_stk ...")
            with open(log_path, "a", encoding="utf-8") as log_f:
                for event, data in get_sse("/api/v1/stream/data/tick_stk"):
                    if event != "tick_stk":
                        continue
                    last_data = time.time()
                    try:
                        t = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    code = t.get("code", "")
                    st = states.get(code)
                    if st:
                        on_tick(st, t, min_amount, log_f)
            backoff = 1
        except Exception as e:
            print(f"SSE error: {type(e).__name__}: {e} — reconnect in {backoff}s", file=sys.stderr)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
            # re-subscribe after reconnect
            subscribe_all(primary)
        # heartbeat check: if no data for 60s, force reconnect
        if time.time() - last_data > 60:
            print("SSE heartbeat timeout — reconnecting", file=sys.stderr)
            last_data = time.time()
            subscribe_all(primary)


def run_replay(path: str, min_amount: float) -> None:
    """Replay a jsonl of tick events (same shape as SSE data lines)."""
    states: dict[str, StockState] = {}
    log_path = LOG_DIR / "hot-scanner-replay.jsonl"
    with open(path, encoding="utf-8") as f, open(log_path, "w", encoding="utf-8") as log_f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            t = json.loads(line)
            code = t.get("code", "")
            if code not in states:
                states[code] = StockState(code, t.get("name", code), t.get("exchange", "TSE"))
            on_tick(states[code], t, min_amount, log_f)
    print(f"replay done -> {log_path}")


def run_report() -> None:
    log_path = LOG_DIR / "hot-scanner.jsonl"
    if not log_path.exists():
        print("no log file", file=sys.stderr)
        return
    events, alerts, fwd = [], [], {}
    for line in log_path.read_text(encoding="utf-8").splitlines():
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

    print(f"events: {len(events)}  alerts: {len(alerts)}")
    by_code: dict[str, list] = {}
    for e in events:
        by_code.setdefault(e["code"], []).append(e)
    print(f"{'code':<6} {'name':<10} {'n':>3} {'buy':>4} {'sell':>4} {'net_M':>8} {'fwd5m%':>7}")
    for code, evs in sorted(by_code.items(), key=lambda x: -len(x[1]))[:20]:
        buys = sum(1 for e in evs if e["tick_dir"] > 0)
        sells = len(evs) - buys
        net = sum(e["amount_tick"] * (1 if e["tick_dir"] > 0 else -1) for e in evs) / 1e6
        f5 = [fwd.get(e["ts"], {}).get("5m") for e in evs]
        f5 = [x for x in f5 if x is not None]
        avg5 = sum(f5) / len(f5) if f5 else 0
        print(f"{code:<6} {evs[0]['name']:<10} {len(evs):>3} {buys:>4} {sells:>4} "
              f"{net:>+8.0f} {avg5:>+7.2f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="watchlist date YYYY-MM-DD")
    ap.add_argument("--min-amount", type=float, default=10_000_000,
                    help="單筆大單金額下限（元），預設 1000 萬")
    ap.add_argument("--replay", metavar="FILE", help="replay tick jsonl")
    ap.add_argument("--report", action="store_true")
    args = ap.parse_args()

    if args.report:
        run_report()
        return 0
    if args.replay:
        run_replay(args.replay, args.min_amount)
        return 0

    stocks = load_watchlist(args.date)
    run_live(stocks, args.min_amount)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
