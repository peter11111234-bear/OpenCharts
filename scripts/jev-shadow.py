"""Jev shadow collector — 5m decisions on TXF, 1m order-flow features, log only.

Every completed 5m bar: fetch 1m kbars from the local shioaji server, resample
to 5m, compute the Jev-Trades indicator set (pandas parity), add order-flow
features from the 1m tape, POST {state, questions} to the jev-sidecar, and
append the result to logs/jev-shadow.jsonl. No orders are placed — this is a
measurement loop to see whether Jev's calls have edge before wiring execution.

Run:  python C:\\Users\\bear9\\OpenCharts\\scripts\\jev-shadow.py [--symbol TXFJ6] [--selftest]
"""
import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

SHIOAJI = "http://127.0.0.1:8080"
SIDECAR = "http://127.0.0.1:8787"
LOG = Path(__file__).resolve().parent.parent / "logs" / "jev-shadow.jsonl"
TAIPEI = timezone(timedelta(hours=8))
TF_SECONDS = 300
MAX_BARS_5M = 400          # indicator warmup depth
LARGE_VOL_MULT = 3.0       # 1m bar volume > 3x trailing-20 median = large print
FLOW_WINDOW_1M = 30        # order-flow stats over last 30 one-minute bars

CONTRACTS = {
    "TXFJ6": {"security_type": "FUT", "exchange": "TAIFEX", "code": "TXFJ6"},
    "MXFJ6": {"security_type": "FUT", "exchange": "TAIFEX", "code": "MXFJ6"},
    "2330": {"security_type": "STK", "exchange": "TSE", "code": "2330"},
}

# ── Questions: verbatim from Jev-Trades pipeline/schema.py (commit 01fb18e) ──
QUESTIONS = {
    "action_choice": {
        "type": "choice",
        "instructions": "Given `current_price`, `oscillators`, `moving_averages`, `change_percent`, `day_high`, `day_low`, the current `position`/`quantity`/`average_entry_price`, and `risk_appetite`, which action best matches the weight of evidence right now? Respect the supplied risk appetite: aggressive may act on a promising but incomplete setup, balanced requires broader agreement, and conservative requires strong confirmation.",
        "criteria": {
            "buy": "Momentum and trend indicators are broadly bullish-aligned, no oscillator shows extreme overbought exhaustion, and there is no open position or an existing long the evidence supports adding to.",
            "hold": "Signals are mixed, contradictory, or already reflected in the existing position.",
            "sell": "Oscillators show overbought exhaustion or moving averages are rolling over, and there is an open long position the evidence supports reducing or closing.",
        },
    },
    "trend_alignment": {
        "type": "choice",
        "instructions": "Compare `current_price` against short (10-20), medium (30-50), and long (100-200) period moving averages. Classify the trend structure.",
        "criteria": {
            "strong_uptrend": "Price above all tiers, shorter averages stacked above longer ones.",
            "weak_or_transitional": "Averages clustered close together or crossing.",
            "downtrend": "Price below all tiers, shorter averages stacked below longer ones.",
        },
    },
    "overbought_condition": {
        "type": "noul",
        "instructions": "Do RSI, Stochastic %K, Stochastic RSI Fast, and Williams %R collectively indicate the instrument is overbought and due for a pause, given `current_price` is also near `day_high`?",
    },
    "volatility_regime": {
        "type": "score",
        "instructions": "Using the spread between `day_high` and `day_low` relative to `current_price`, and how tightly the moving averages are clustered, how volatile is the current environment?",
        "criteria": [
            "Calm: tight day range, moving averages closely bunched.",
            "Normal: moderate day range, some separation between MA tiers.",
            "Volatile: wide day range, MA tiers widely separated or whipsawing.",
        ],
    },
    "signal_confluence": {
        "type": "score",
        "instructions": "How much agreement is there between `oscillators` and `moving_averages`?",
        "criteria": [
            "Conflicting: they point in clearly opposite directions.",
            "Partial: most agree, a subset disagrees.",
            "Strong: near-total alignment.",
        ],
    },
    "buying_quantity": {
        "type": "score",
        "instructions": "Assuming the evidence favored a Buy, and factoring in `risk_appetite`, the current volatility regime, and `max_wallet_position_pct`, how large should the position be relative to a full-size position? Aggressive can choose a larger size when evidence is promising; conservative should prefer a probe unless alignment is strong.",
        "criteria": [
            "Small probe: directionally bullish but limited confidence, or a volatile regime that argues for caution.",
            "Standard size: solid agreement across indicators in a normal volatility regime.",
            "Full size: near-total alignment with no overbought warning, in a calm-to-normal regime.",
        ],
    },
    "selling_quantity": {
        "type": "score",
        "instructions": "Assuming the evidence favored a Sell, and there is an open position with a given `unrealized_pnl_pct`, how much should be reduced?",
        "criteria": [
            "Partial trim: one mild warning sign, trend structure still intact.",
            "Half reduction: multiple exhaustion signals or MAs flattening.",
            "Full exit: broad-based reversal evidence or a clear trend breakdown.",
        ],
    },
    "stop_loss_target": {
        "type": "choice",
        "instructions": "If entering or managing a position, what stop loss distance is appropriate given the current volatility regime, recent swing low, and support levels?",
        "criteria": {
            "tight": "Tight stop loss (0.75% to 1.5% below entry) for quick scalp or high conviction setups with tight invalidation.",
            "moderate": "Standard stop loss (2.0% to 3.5% below entry) placed below key short-term moving average support (EMA 20 / SMA 50).",
            "wide": "Wide stop loss (4.0% to 6.0% below entry) for volatile swings or longer holding periods.",
        },
    },
    "take_profit_target": {
        "type": "choice",
        "instructions": "If entering or managing a position, what take profit target aligns best with momentum and upside resistance?",
        "criteria": {
            "conservative": "Quick profit target (1.5% to 3.0% gain) near immediate local resistance or oscillator peak.",
            "balanced": "Balanced target (3.5% to 6.5% gain) aiming for trend expansion with healthy risk-reward.",
            "aggressive": "Extended runner target (7.0% to 12.0%+ gain) targeting multi-tier breakout or strong momentum rally.",
        },
    },
    "low_reliability_setup": {
        "type": "noul",
        "instructions": "Given `time_frame` is 5 minute and the current volatility regime, are the signals more likely to be noise than a reliable, tradeable edge right now?",
    },
    "conviction_level": {
        "type": "score",
        "instructions": "Independent of direction, how much conviction does the full picture provide for taking any action at all, versus staying flat?",
        "criteria": [
            "Low: indicators mostly Neutral or contradictory.",
            "Moderate: clear majority agree, a few holdouts.",
            "High: near-unanimous agreement.",
        ],
    },
}

# ── Indicators: pandas parity with data_collector.calculate_indicators ──

def _wilder(s: pd.Series, p: int) -> pd.Series:
    return s.ewm(alpha=1 / p, adjust=False, min_periods=p).mean()


def _wma(s: pd.Series, p: int) -> pd.Series:
    w = pd.Series(range(1, p + 1), dtype="float64")
    return s.rolling(p).apply(lambda v: float((v * w.to_numpy()).sum() / w.sum()), raw=True)


def _last(v):
    return None if pd.isna(v) else round(float(v), 6)


def calculate_indicators(bars: list[dict]) -> dict:
    close = pd.Series([b["close"] for b in bars], dtype="float64")
    high = pd.Series([b["high"] for b in bars], dtype="float64")
    low = pd.Series([b["low"] for b in bars], dtype="float64")
    volume = pd.Series([b["volume"] for b in bars], dtype="float64")
    typical = (high + low + close) / 3
    ma = {}
    for p in (10, 20, 30, 50, 100, 200):
        ma[f"ema_{p}"] = close.ewm(span=p, adjust=False, min_periods=p).mean()
        ma[f"sma_{p}"] = close.rolling(p).mean()
    ma["ichimoku_base_line_9_26_52_26"] = (high.rolling(26).max() + low.rolling(26).min()) / 2
    ma["vwma_20"] = (close * volume).rolling(20).sum() / volume.rolling(20).sum().replace(0, float("nan"))
    ma["hull_ma_9"] = _wma(2 * _wma(close, 4) - _wma(close, 9), 3)

    delta = close.diff()
    gain, loss = delta.clip(lower=0), -delta.clip(upper=0)
    ag, al = _wilder(gain, 14), _wilder(loss, 14)
    rsi = 100 - (100 / (1 + ag / al.replace(0, float("nan"))))
    rsi = rsi.mask((al == 0) & (ag > 0), 100).mask((ag == 0) & (al > 0), 0)
    th, tl = high.rolling(14).max(), low.rolling(14).min()
    raw_k = 100 * (close - tl) / (th - tl).replace(0, float("nan"))
    stoch_k = raw_k.rolling(3).mean()
    md = typical.rolling(20).apply(lambda v: float(abs(v - v.mean()).mean()), raw=True)
    cci = (typical - typical.rolling(20).mean()) / (0.015 * md)
    tr = pd.concat([high - low, (high - close.shift()).abs(), (low - close.shift()).abs()], axis=1).max(axis=1)
    up, dn = high.diff(), -low.diff()
    pdm = up.where((up > dn) & (up > 0), 0)
    mdm = dn.where((dn > up) & (dn > 0), 0)
    atr14 = _wilder(tr, 14)
    pdi, mdi = 100 * _wilder(pdm, 14) / atr14, 100 * _wilder(mdm, 14) / atr14
    adx = _wilder(100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, float("nan")), 14)
    macd = close.ewm(span=12, adjust=False, min_periods=26).mean() - close.ewm(span=26, adjust=False, min_periods=26).mean()
    macd_sig = macd.ewm(span=9, adjust=False, min_periods=9).mean()
    srsi = 100 * (rsi - rsi.rolling(14).min()) / (rsi.rolling(14).max() - rsi.rolling(14).min()).replace(0, float("nan"))
    will = -100 * (th - close) / (th - tl).replace(0, float("nan"))
    awesome = (high + low).div(2).rolling(5).mean() - (high + low).div(2).rolling(34).mean()
    mom = close - close.shift(10)
    e13 = close.ewm(span=13, adjust=False, min_periods=13).mean()
    bb = (high - e13) + (low - e13)
    tlow = pd.concat([low, close.shift()], axis=1).min(axis=1)
    bp = close - tlow
    uo = (4 * bp.rolling(7).sum() / tr.rolling(7).sum() + 2 * bp.rolling(14).sum() / tr.rolling(14).sum() + bp.rolling(28).sum() / tr.rolling(28).sum()) / 7 * 100

    out = {k: _last(v.iloc[-1]) for k, v in ma.items()}
    out.update({
        "relative_strength_index_14": _last(rsi.iloc[-1]),
        "stochastic_percent_k_14_3_3": _last(stoch_k.iloc[-1]),
        "commodity_channel_index_20": _last(cci.iloc[-1]),
        "average_directional_index_14": _last(adx.iloc[-1]),
        "awesome_oscillator": _last(awesome.iloc[-1]),
        "momentum_10": _last(mom.iloc[-1]),
        "macd_level_12_26": _last(macd.iloc[-1]),
        "stochastic_rsi_fast_3_3_14_14": _last(srsi.rolling(3).mean().iloc[-1]),
        "williams_percent_range_14": _last(will.iloc[-1]),
        "bull_bear_power": _last(bb.iloc[-1]),
        "ultimate_oscillator_7_14_28": _last(uo.iloc[-1]),
        "atr14": _last(atr14.iloc[-1]),
        "signal": _last(macd_sig.iloc[-1]),
    })
    return out


MA_KEYS = ("ema_10", "sma_10", "ema_20", "sma_20", "ema_30", "sma_30", "ema_50", "sma_50",
           "ema_100", "sma_100", "ema_200", "sma_200", "ichimoku_base_line_9_26_52_26", "vwma_20", "hull_ma_9")
ALIAS_KEYS = {"atr14", "signal", "ema20", "sma50", "rsi14", "macd"}


# ── Order-flow features from the 1m tape ──

def order_flow(bars_1m: list[dict]) -> dict:
    """Consecutive large-print detection on 1m bars — the real value of 1m data."""
    recent = bars_1m[-FLOW_WINDOW_1M:]
    if len(recent) < 21:
        return {"available": False}
    vols = [b["volume"] for b in recent]
    large = []
    for i, b in enumerate(recent):
        base = sorted(vols[max(0, i - 20):i])
        med = base[len(base) // 2] if base else 0
        is_large = med > 0 and b["volume"] > LARGE_VOL_MULT * med
        large.append(is_large)
    # consecutive large prints ending at the latest bar
    streak = 0
    for flag in reversed(large):
        if flag:
            streak += 1
        else:
            break
    # direction of the latest large print (close vs open)
    last_large_dir = 0
    for b, flag in zip(reversed(recent), reversed(large)):
        if flag:
            last_large_dir = 1 if b["close"] > b["open"] else -1 if b["close"] < b["open"] else 0
            break
    up = sum(1 for b, f in zip(recent, large) if f and b["close"] > b["open"])
    dn = sum(1 for b, f in zip(recent, large) if f and b["close"] < b["open"])
    return {
        "available": True,
        "large_bars_30m": sum(large),
        "large_bars_up_30m": up,
        "large_bars_down_30m": dn,
        "consecutive_large_now": streak,
        "last_large_direction": {1: "up", -1: "down", 0: "flat"}[last_large_dir],
        "volume_multiple_threshold": LARGE_VOL_MULT,
    }


# ── Data plumbing ──

def post(url: str, payload: dict, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode())


def fetch_1m(contract: dict, days: int = 2) -> list[dict]:
    end = datetime.now(TAIPEI).date()
    start = end - timedelta(days=days)
    res = post(f"{SHIOAJI}/api/v1/data/kbars",
               {"contract": contract, "start": start.isoformat(), "end": end.isoformat()})
    bars = []
    for i, dt in enumerate(res.get("datetime", [])):
        epoch = int(datetime.fromisoformat(dt).replace(tzinfo=TAIPEI).timestamp())
        bars.append({"time": epoch, "open": res["Open"][i], "high": res["High"][i],
                     "low": res["Low"][i], "close": res["Close"][i], "volume": res["Volume"][i]})
    bars.sort(key=lambda b: b["time"])
    return bars


def resample_5m(bars_1m: list[dict]) -> list[dict]:
    groups: dict[int, list[dict]] = {}
    for b in bars_1m:
        groups.setdefault(b["time"] - (b["time"] % TF_SECONDS), []).append(b)
    out = []
    for t in sorted(groups):
        g = groups[t]
        out.append({"time": t, "open": g[0]["open"], "high": max(x["high"] for x in g),
                    "low": min(x["low"] for x in g), "close": g[-1]["close"],
                    "volume": sum(x["volume"] for x in g)})
    return out


def taipei_day_start(epoch: int) -> int:
    d = datetime.fromtimestamp(epoch, TAIPEI)
    return int(datetime(d.year, d.month, d.day, tzinfo=TAIPEI).timestamp())


def build_state(symbol: str, bars_5m: list[dict], bars_1m: list[dict]) -> dict:
    ind = calculate_indicators(bars_5m)
    price = bars_5m[-1]["close"]
    day0 = taipei_day_start(bars_5m[-1]["time"])
    day_bars = [b for b in bars_1m if b["time"] >= day0]
    day_high = max((b["high"] for b in day_bars), default=price)
    day_low = min((b["low"] for b in day_bars), default=price)
    day_open = day_bars[0]["open"] if day_bars else price
    day_vol = sum(b["volume"] for b in day_bars)
    return {
        "symbol": symbol,
        "current_price": price,
        "oscillators": {k: v for k, v in ind.items() if k not in MA_KEYS and k not in ALIAS_KEYS},
        "moving_averages": {k: ind.get(k) for k in MA_KEYS},
        "position": "None",
        "quantity": 0,
        "time_frame": "5 minute",
        "cash_balance": 100000,
        "position_quantity": 0,
        "average_entry_price": None,
        "unrealized_pnl_pct": 0,
        "position_age_bars": 0,
        "stop_loss_price": None,
        "take_profit_price": None,
        "stop_loss_pct": None,
        "take_profit_pct": None,
        "max_wallet_position_pct": 0.75,
        "risk_appetite": "balanced",
        "order_flow": order_flow(bars_1m),
        "price": {
            "atr14": ind.get("atr14"),
            "change_percent": round((price - day_open) / day_open * 100, 4) if day_open else 0,
            "day_high": day_high,
            "day_low": day_low,
            "open_price": day_open,
            "day_volume": day_vol,
        },
    }


def logged_bar_times() -> set[int]:
    times = set()
    if LOG.exists():
        for line in LOG.read_text(encoding="utf-8").splitlines():
            try:
                times.add(json.loads(line)["bar_time"])
            except Exception:
                continue
    return times


def append_log(event: dict) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n")


def decide(state: dict) -> dict:
    return post(f"{SIDECAR}/decide", {"state": state, "questions": QUESTIONS}, timeout=45)


def selftest() -> int:
    """Offline check: synthetic bars -> state shape + one real /decide call."""
    sys.path.insert(0, str(Path(__file__).parent))
    from gen_jev_fixture import make_candles  # reuse the deterministic generator
    bars_1m = make_candles()
    bars_5m = resample_5m(bars_1m)
    state = build_state("SELFTEST", bars_5m, bars_1m)
    print(json.dumps({"state_keys": sorted(state), "order_flow": state["order_flow"],
                      "n_osc": len(state["oscillators"]), "n_ma": len(state["moving_averages"])},
                     ensure_ascii=False, indent=1))
    ans = decide(state)
    print(json.dumps({"action": ans.get("answers", {}).get("action_choice"),
                      "model": ans.get("model"), "error": ans.get("error")}, ensure_ascii=False))
    return 0 if "answers" in ans else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="TXFJ6", choices=list(CONTRACTS))
    ap.add_argument("--poll", type=int, default=30, help="seconds between kbar refetches")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    contract = CONTRACTS[args.symbol]
    seen = logged_bar_times()
    print(f"jev-shadow {args.symbol}: logging to {LOG} ({len(seen)} bars already logged)")
    while True:
        try:
            bars_1m = fetch_1m(contract)
            bars_5m = resample_5m(bars_1m)[-MAX_BARS_5M:]
            now_bucket = int(time.time()) - (int(time.time()) % TF_SECONDS)
            completed = [b for b in bars_5m if b["time"] < now_bucket and b["time"] not in seen]
            for bar in completed:
                upto = [b for b in bars_5m if b["time"] <= bar["time"]]
                flow_upto = [b for b in bars_1m if b["time"] < bar["time"] + TF_SECONDS]
                state = build_state(args.symbol, upto, flow_upto)
                try:
                    ans = decide(state)
                except Exception as e:
                    ans = {"error": f"{type(e).__name__}: {e}"}
                event = {"ts": time.time(), "bar_time": bar["time"], "symbol": args.symbol,
                         "price": bar["close"], "order_flow": state["order_flow"],
                         "answers": ans.get("answers"), "model": ans.get("model"),
                         "error": ans.get("error")}
                append_log(event)
                seen.add(bar["time"])
                a = (ans.get("answers") or {}).get("action_choice", {})
                print(f"{datetime.fromtimestamp(bar['time'], TAIPEI):%H:%M} "
                      f"px={bar['close']} action={a.get('choice')} conf={a.get('confidence')} "
                      f"err={ans.get('error')}")
        except Exception as e:
            print(f"loop error: {type(e).__name__}: {e}")
        time.sleep(args.poll)


if __name__ == "__main__":
    raise SystemExit(main())
