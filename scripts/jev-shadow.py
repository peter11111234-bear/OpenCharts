"""Jev shadow collector — 5m decisions on TXF, 1m order-flow features, log only.

Every completed 5m bar: fetch 1m kbars from the local shioaji server, resample
to 5m, compute the Jev-Trades indicator set (pandas parity), add order-flow
features from the 1m tape, POST {state, questions} to the jev-sidecar, and
append the result to logs/jev-shadow.jsonl. No orders are placed — this is a
measurement loop to see whether Jev's calls have edge before wiring execution.

Discipline (learned 2026-10-16, at the cost of 426 lost bars + a drained free quota):

  * Only a bar that came back with `answers` counts as done. Failed bars stay
    pending and are retried, instead of being burned forever.
  * No bar is consumed while the sidecar is down or cooling off from a 429.
  * Calls are rate limited (--rate) and a backlog is capped (--max-per-cycle),
    so catch-up cannot burst the free tier into the paid fallback.
  * Failures go to logs/jev-shadow-errors.jsonl; the dataset stays clean.

Run:  python C:\\Users\\bear9\\OpenCharts\\scripts\\jev-shadow.py [--symbol auto] [--selftest]
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import numpy as np

SHIOAJI = "http://127.0.0.1:8080"
SIDECAR = "http://127.0.0.1:8787"
LOG = Path(__file__).resolve().parent.parent / "logs" / "jev-shadow.jsonl"
ERRLOG = Path(__file__).resolve().parent.parent / "logs" / "jev-shadow-errors.jsonl"
TAIPEI = timezone(timedelta(hours=8))
TF_SECONDS = 300
MAX_BARS_5M = 400          # indicator warmup depth
LARGE_VOL_MULT = 3.0       # 1m bar volume > 3x trailing-20 median = large print
FLOW_WINDOW_1M = 30        # order-flow stats over last 30 one-minute bars
DECIDE_ATTEMPTS = 3        # tries per bar before giving up this cycle
RETRY_DELAYS = (5, 20)     # seconds between those tries
MAX_BAR_TRIES = 5          # cycles a bar may fail before being parked (in-memory only)


def _day_session(ts):
    # Taipei local time of a bar: only 08:45 - 13:45 counts as a day session bar.
    tt = __import__("datetime").datetime.fromtimestamp(ts, TAIPEI).timetuple()
    mins = tt.tm_hour * 60 + tt.tm_min
    return 8 * 60 + 45 <= mins <= 13 * 60 + 45

# ─── Day / night session helpers ───────────────────────────────────────────
DAY_START_MIN = 8 * 60 + 45   # 08:45
DAY_END_MIN = 13 * 60 + 45    # 13:45

def in_day_session(ts: float) -> bool:
    tt = datetime.fromtimestamp(ts, TAIPEI).timetuple()
    mins = tt.tm_hour * 60 + tt.tm_min
    return DAY_START_MIN <= mins <= DAY_END_MIN


def load_env(name: str) -> str:
    """Resolve a secret from env or .env files, mirrors sidecar.load_key semantics."""
    k = os.environ.get(name, '').strip()
    if k:
        return k
    for path in (Path(r'C:\MyTradingProjects\.env'),
                 Path(r'C:\Users\bear9\jev-laya-bench\jev-wigolo\.env')):
        try:
            for line in path.read_text(encoding='utf-8').splitlines():
                s = line.strip()
                if s.startswith('export '):
                    s = s[7:].lstrip()
                if s.startswith(name + '='):
                    val = s.split('=', 1)[1].strip()
                    if ' #' in val:
                        val = val.split(' #', 1)[0].rstrip()
                    val = val.strip('"').strip("'")
                    if val:
                        return val
        except OSError:
            continue
    return ''

# TAIFEX month codes: A=Jan .. L=Dec
MONTH_CODES = "ABCDEFGHIJKL"

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
    "volatility_amplitude_atr": {
        "type": "choice",
        "instructions": "Evaluate current price amplitude and volatility using `atr14` relative to `current_price` and recent day range. Classify the volatility regime.",
        "criteria": {
            "compressed": "ATR is low relative to price, range is tightly coiled, awaiting expansion.",
            "normal": "ATR is within typical intraday expansion levels, orderly price movement.",
            "expanded_or_exhausted": "ATR is unusually wide with erratic or climactic price bars, high volatility risk.",
        },
    },
    "trend_breakout_adx": {
        "type": "choice",
        "instructions": "Using `average_directional_index_14`, `plus_di_14`, and `minus_di_14`, classify the trend breakout direction. (ADX > 25 signifies active trend, +DI > -DI is bullish, -DI > +DI is bearish, ADX < 20 is choppy/no trend).",
        "criteria": {
            "bullish_breakout": "ADX > 25 with +DI clearly above -DI, strong upward breakout/trend momentum.",
            "bearish_breakout": "ADX > 25 with -DI clearly above +DI, strong downward breakdown/trend momentum.",
            "consolidation": "ADX < 20 or DIs intertwined with no directional leadership.",
        },
    },
    "choppiness_regime": {
        "type": "choice",
        "instructions": "Using `chop_14` (Choppiness Index, where >= 60 is a choppy range and < 60 indicates an active trend according to TRIS390 threshold), is the market in a choppy consolidation zone?",
        "criteria": {
            "choppy_range": "CHOP >= 60, price is oscillating within a consolidation zone with high risk of false breakouts.",
            "transitional": "CHOP between 45 and 60, transitioning between consolidation and breakout.",
            "clean_trend": "CHOP < 45, market is in a clean directional trending environment.",
        },
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
    # Choppiness Index (CHOP 14) - parity with TRIS390.pine:289-293
    tr_sum_14 = tr.rolling(14).sum()
    range_diff_14 = th - tl
    chop_ratio = (tr_sum_14 / range_diff_14.replace(0, float("nan"))).clip(lower=1e-9)
    chop_14 = 100.0 * (np.log10(chop_ratio) / np.log10(14.0))
    chop_14 = chop_14.mask(range_diff_14 == 0, 100.0)
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
        "plus_di_14": _last(pdi.iloc[-1]),
        "minus_di_14": _last(mdi.iloc[-1]),
        "chop_14": _last(chop_14.iloc[-1]),
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


def sidecar_health() -> dict | None:
    """GET /health. None means the sidecar is unreachable right now."""
    try:
        with urllib.request.urlopen(f"{SIDECAR}/health", timeout=5) as res:
            return json.loads(res.read().decode())
    except Exception:
        return None


def front_month_symbol(prefix: str = "TXF", today: date | None = None) -> str:
    """TAIFEX front-month contract code, rolling after the 3rd-Wednesday expiry.

    Without this the collector keeps polling an expired contract and silently
    collects nothing (the same silent-failure class this file was fixed for).
    """
    today = today or datetime.now(TAIPEI).date()
    year, month = today.year, today.month
    d = date(year, month, 15)
    while d.weekday() != 2:  # first Wednesday on/after the 15th = 3rd Wednesday
        d += timedelta(days=1)
    if today > d:
        if month == 12:
            year, month = year + 1, 1
        else:
            month += 1
    return f"{prefix}{MONTH_CODES[month - 1]}{year % 10}"


def contract_for(code: str) -> dict:
    """Known contracts keep their metadata; any other code is assumed TAIFEX FUT."""
    return CONTRACTS.get(code) or {"security_type": "FUT", "exchange": "TAIFEX", "code": code}


def fetch_1m(contract: dict, days: int = 2, start_date: date | None = None) -> list[dict]:
    end = datetime.now(TAIPEI).date()
    start = start_date or (end - timedelta(days=days))
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
    """Bar times already ANSWERED.

    Only rows that came back with `answers` count. A failed bar is deliberately
    left out of this set so the loop retries it instead of burning it forever —
    counting every row is how a 2-day sidecar outage silently destroyed 426
    bars (2026-09-22 13:10 .. 2026-09-24 10:15).
    """
    times = set()
    if LOG.exists():
        for line in LOG.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("answers"):
                times.add(rec["bar_time"])
    return times


def append_log(event: dict, path: Path = LOG) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_suffix(path.suffix + ".lock")
    for _ in range(50):
        try:
            with lock.open("x", encoding="utf-8"):
                break
        except (FileExistsError, OSError):
            import time as _t; _t.sleep(0.05)
    try:
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n")
    finally:
        try: lock.unlink()
        except (OSError, FileNotFoundError): pass


def decide_once(state: dict) -> tuple[dict, int | None]:
    """One POST /decide. Returns (payload, http_status); HTTP errors never raise.

    A 429 (free-tier quota) or 503 (no channel) must stop the caller, not be
    retried into a paid-fallback storm.
    """
    try:
        return post(f"{SIDECAR}/decide", {"state": state, "questions": QUESTIONS}, timeout=45), None
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read().decode(errors='replace')[:300]}"}, e.code
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}, None


def decide_with_retry(state: dict, attempts: int = DECIDE_ATTEMPTS) -> tuple[dict, int, int | None]:
    """POST /decide with bounded backoff. Returns (answer, attempts_used, status).

    Only transient failures are retried. A 429/503 comes back immediately so the
    caller can back off instead of burning quota and money.
    """
    ans: dict = {"error": "unknown"}
    status: int | None = None
    for i in range(attempts):
        ans, status = decide_once(state)
        if "error" not in ans or status in (429, 503):
            return ans, i + 1, status
        if i < attempts - 1:
            time.sleep(RETRY_DELAYS[min(i, len(RETRY_DELAYS) - 1)])
    return ans, attempts, status


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
    ans, tries, _ = decide_with_retry(state, attempts=2)
    print(json.dumps({"action": ans.get("answers", {}).get("action_choice"),
                      "model": ans.get("model"), "error": ans.get("error"), "tries": tries},
                     ensure_ascii=False))
    return 0 if "answers" in ans else 1



def _day_session(ts):
    tt = __import__('datetime').datetime.fromtimestamp(ts, TAIPEI).timetuple()
    mins = tt.tm_hour * 60 + tt.tm_min
    return 8 * 60 + 45 <= mins <= 13 * 60 + 45



def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="auto", choices=list(CONTRACTS) + ["auto"],
                    help="'auto' = TAIFEX front month (rolls after the 3rd Wednesday)")
    ap.add_argument("--poll", type=int, default=30, help="seconds between kbar refetches")
    ap.add_argument("--days", type=int, default=2, help="days of 1m history to fetch")
    ap.add_argument("--since", help="backfill: only decide bars on/after this Taipei date (YYYY-MM-DD)")
    ap.add_argument("--until", help="backfill: only decide bars on/before this Taipei date (YYYY-MM-DD)")
    ap.add_argument("--warmup", type=int, default=MAX_BARS_5M,
                    help="5m bars of history kept (indicator warmup; raise for backfill)")
    ap.add_argument("--rate", type=int, default=6,
                    help="max /decide calls per minute (free-tier quota guard)")
    ap.add_argument("--max-per-cycle", type=int, default=3,
                    help="cap bars consumed in one cycle so a backlog cannot burst the quota")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--all-sessions", action="store_true",
                    help="also collect night-session bars (default: day session 08:45-13:45 only)")
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    symbol = front_month_symbol() if args.symbol == "auto" else args.symbol
    contract = contract_for(symbol)
    if args.symbol == "auto":
        print(f"auto front month -> {symbol}")

    # Backfill window: --since/--until scope which bars may be decided, and the
    # fetch reaches back far enough to warm the indicators up before --since.
    fetch_start = date.fromisoformat(args.since) - timedelta(days=3) if args.since else None
    lo = int(datetime.combine(date.fromisoformat(args.since), datetime.min.time(), TAIPEI).timestamp()) if args.since else None
    hi = (int(datetime.combine(date.fromisoformat(args.until), datetime.min.time(), TAIPEI).timestamp())
          + 86400 - 1) if args.until else None

    seen = logged_bar_times()
    risk_session = RiskSession() if os.environ.get('RISK_GATE', '1') == '1' else None
    parked: set[int] = set()
    tries: dict[int, int] = {}
    gap = 60.0 / max(1, args.rate)   # min seconds between /decide calls
    last_call = 0.0
    backoff = 0
    print(f"jev-shadow {symbol}: dataset={LOG} ({len(seen)} bars answered), errors={ERRLOG.name}")
    print(f"  rate={args.rate}/min (gap {gap:.1f}s), max {args.max_per_cycle} bars/cycle, poll {args.poll}s")

    while True:
        try:
            health = sidecar_health()
            # Never consume a bar while the sidecar is unreachable or cooling off
            # from a free-tier 429. Consuming bars regardless is what turned a
            # 2-day outage into 426 permanently lost bars, and bursting the
            # backlog is what drained the free quota into the paid channel.
            if health is None:
                print(f"{datetime.now(TAIPEI):%H:%M:%S} sidecar DOWN — waiting {args.poll}s, no bars consumed")
                time.sleep(args.poll)
                continue
            rl_for = int(health.get("rate_limited_for") or 0)
            paid, paid_max = health.get("paid_today") or 0, health.get("paid_max") or 0
            paid_available = (not paid_max) or (paid < paid_max)
            # Only stall when there is NO usable channel: free tier cooling off AND
            # the paid fallback capped. Otherwise keep going — the client-side gap
            # below is what protects the free quota.
            if rl_for > 0 and not paid_available:
                wait = min(max(rl_for + 2, args.poll), 900)
                print(f"{datetime.now(TAIPEI):%H:%M:%S} free cooling ({rl_for}s) and paid cap "
                      f"reached ({paid}/{paid_max}) — sleeping {wait}s")
                time.sleep(wait)
                continue

            bars_1m = fetch_1m(contract, days=args.days, start_date=fetch_start)
            bars_5m = resample_5m(bars_1m)[-args.warmup:]
            now_bucket = int(time.time()) - (int(time.time()) % TF_SECONDS)
            completed = [b for b in bars_5m
                         if b["time"] < now_bucket and b["time"] not in seen and b["time"] not in parked
                         and (lo is None or b["time"] >= lo) and (hi is None or b["time"] <= hi)
                         and (getattr(args, "all_sessions", False) or _day_session(b["time"]))]
            if len(completed) > args.max_per_cycle:
                print(f"  backlog {len(completed)} bars — taking {args.max_per_cycle} this cycle")

            aborted = False
            for bar in completed[:args.max_per_cycle]:
                # Client-side rate limit: stay under the free tier instead of
                # bursting the backlog and falling back to the paid channel.
                wait = gap - (time.time() - last_call)
                if wait > 0:
                    time.sleep(wait)
                upto = [b for b in bars_5m if b["time"] <= bar["time"]]
                flow_upto = [b for b in bars_1m if b["time"] < bar["time"] + TF_SECONDS]
                state = build_state(symbol, upto, flow_upto)
                last_call = time.time()
                ans, used, status = decide_with_retry(state)
                _gate_verdict = 'n/a'
                _gate_lots_mult = 1.0
                _gate_reason = ''
                _gate_rule = ''
                _prev_outcome = None
                _ds_res = None
                if status in (429, 503):
                    append_log({"ts": time.time(), "bar_time": bar["time"], "symbol": symbol,
                                "throttled": True, "status": status, "error": ans.get("error")}, ERRLOG)
                    print(f"  sidecar {status} — bar stays pending, backing off")
                    aborted = True
                    break
                answered = bool(ans.get("answers"))
                if risk_session is not None and answered:
                    _prev_outcome = risk_session._close_open_position(bar)
                    gate_res = risk_session.gate(bar, ans)
                    _gate_verdict, _gate_lots_mult, _gate_reason, _gate_rule = gate_res
                    trig_ok, trigger = should_escalate(ans)
                    if trig_ok:
                        _ds_res = deepseek_escalate(state, ans, trigger)
                    choice = (ans.get('answers') or {}).get('action_choice', {}).get('choice')
                    if _gate_verdict == 'approve' and choice in ('buy', 'sell'):
                        risk_session.follow_count_today += 1
                        risk_session.open_entry = bar['close']
                        risk_session.open_direction = choice
                        risk_session.open_ts = bar['time']
                event = {"ts": time.time(), "bar_time": bar["time"], "symbol": symbol,
                         "price": bar["close"], "order_flow": state["order_flow"],
                         "answers": ans.get("answers"), "channel": ans.get("_channel"),
                         "model": ans.get("model"), "error": ans.get("error"), "attempts": used,
                         "risk_gate": {"verdict": _gate_verdict,
                                      "lots_mult": _gate_lots_mult,
                                      "reason": _gate_reason,
                                      "rule": _gate_rule,
                                      "prev_outcome": _prev_outcome},
                         "deepseek": _ds_res}
                if answered:
                    append_log(event)              # the dataset: successes only
                    seen.add(bar["time"])
                    tries.pop(bar["time"], None)
                    backoff = 0
                else:
                    n = tries[bar["time"]] = tries.get(bar["time"], 0) + 1
                    append_log(event, ERRLOG)      # diagnostics: never the dataset
                    if n >= MAX_BAR_TRIES:
                        parked.add(bar["time"])
                        append_log({"ts": time.time(), "bar_time": bar["time"], "symbol": symbol,
                                    "parked": True, "attempts": n, "error": ans.get("error")}, ERRLOG)
                        print(f"  parked {datetime.fromtimestamp(bar['time'], TAIPEI):%m-%d %H:%M} "
                              f"after {n} failed cycles")
                a = (ans.get("answers") or {}).get("action_choice", {})
                ds_txt = None
                if _ds_res is not None:
                    ds_txt = _ds_res.get("verdict") + " (lots=" + str(_ds_res.get("lots", 0)) + ")"
                print(f"{datetime.fromtimestamp(bar['time'], TAIPEI):%m-%d %H:%M} "
                      f"px={bar['close']} action={a.get('choice')} conf={a.get('confidence')} "
                      f"ch={ans.get('_channel')} risk={_gate_verdict} ds={ds_txt} "
                      f"err={ans.get('error')} tries={used}")
            if aborted:
                backoff = 60 if backoff == 0 else min(backoff * 2, 900)
                print(f"  sleeping {backoff}s before retrying")
                time.sleep(backoff)
        except Exception as e:
            print(f"loop error: {type(e).__name__}: {e}")
        time.sleep(args.poll)



# --- 2026-10-16 §4.5 / §6 helpers merged ---
# ─── 2026-10-16 §4.5 / §6 helpers (night-session, DeepSeek, risk gate) ────

DEEPSEEK_KEY = load_env('DEEPSEEK_API_KEY')
DEEPSEEK_MODEL = os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')
DEEPSEEK_ESCALATE = os.environ.get('DEEPSEEK_ESCALATE', '1') == '1'
DEEPSEEK_MAX_PER_DAY = int(os.environ.get('DEEPSEEK_MAX_PER_DAY', '150'))
DEEPSEEK_SPEND_FILE = Path(__file__).with_name('jev-deepseek-spend.json')

_DS_SYS = ('You are a quantitative risk reviewer for TMF micro-futures. Given Jev atomic '
           'judgement, decide one of three outcomes and output STRICT JSON only: '
           '{"verdict":"approve|veto|reduce","lots":int,"reason":"<=200 chars"}. '
           'approve: agree. veto: serious issue -> skip. reduce: uncertainty -> Jev lots halved. '
           'lots=0 for veto; otherwise 0,1,2. Cite a concrete risk or signal reason.')


def _get_deepseek_paid_today():
    today = datetime.now(TAIPEI).date().isoformat()
    try:
        if DEEPSEEK_SPEND_FILE.exists():
            d = json.loads(DEEPSEEK_SPEND_FILE.read_text(encoding='utf-8'))
            if d.get('date') == today:
                return int(d.get('count', 0))
    except Exception:
        pass
    return 0


def _bump_deepseek_paid():
    today = datetime.now(TAIPEI).date().isoformat()
    try:
        cnt = _get_deepseek_paid_today()
        DEEPSEEK_SPEND_FILE.write_text(json.dumps({'date': today, 'count': cnt + 1}), encoding='utf-8')
    except Exception:
        pass


# P60 of volatility_regime.score over 1324 logged bars (2026-09-22..10-20):
# about 40% of bars count as volatile (user decision 2026-10-21). The old 1.5
# sat above the highest score ever logged (1.3), so it never fired.
# Recompute once a month or so of new bars is logged.
VOLATILE_MIN_SCORE = 0.67


def _is_volatile(vol, min_score=VOLATILE_MIN_SCORE):
    """volatility_regime is a Jev Score (0 Calm, 1 Normal, 2 Volatile).
    Read the numbers only: the answer's `legend` always contains "Volatile:",
    so any substring test on the dict is always true (bug of 2026-10-19)."""
    if not isinstance(vol, dict):
        return False
    try:
        if float(vol.get('score')) >= min_score:
            return True
    except (TypeError, ValueError):
        pass
    try:
        return float((vol.get('probabilities') or {}).get('2')) >= 0.5
    except (TypeError, ValueError):
        return False


def should_escalate(ans):
    """plan-v1 §4.4 triggers: low confidence, volatile env, low reliability setup."""
    if not ans or not ans.get('answers'):
        return False, ''
    a = ans['answers'].get('action_choice', {}) or {}
    try:
        conf = float(a.get('confidence', 1.0))
    except (TypeError, ValueError):
        conf = 1.0
    vol = ans['answers'].get('volatility_regime', {}) or {}
    low_rel = ans['answers'].get('low_reliability_setup', {}) or {}
    if isinstance(low_rel, dict):
        lr = low_rel.get('value') if low_rel.get('value') is not None else low_rel.get('choice')
    else:
        lr = low_rel
    try:
        lr_num = int(lr) if lr is not None else 0
    except (TypeError, ValueError):
        lr_num = 0
    if conf < 0.6:
        return True, 'confidence < 0.6'
    # volatility is a Score (0=Calm,1=Normal,2=Volatile). Trigger on score>=1.0
    # OR on the Volatile-probability reaching 0.5, whichever first.
    try:
        vnum = float(vol.get('score') if isinstance(vol, dict) else vol)
    except (TypeError, ValueError):
        vnum = None
    volatile_prob = (vol.get('probabilities', {}) or {}).get('2') if isinstance(vol, dict) else None
    try: volatile_prob = float(volatile_prob)
    except (TypeError, ValueError): volatile_prob = None
    if (vnum is not None and vnum >= 1.0) or (volatile_prob is not None and volatile_prob >= 0.5):
        return True, 'volatile environment (score=%s prob2=%s)' % (vnum, volatile_prob)
    if lr_num >= 1:
        return True, 'low reliability setup'
    return False, ''


def deepseek_escalate(state, ans, trigger):
    """Shadow second opinion. Returns dict {verdict, lots, reason, trigger} or None."""
    if not DEEPSEEK_ESCALATE or not DEEPSEEK_KEY:
        return None
    if _get_deepseek_paid_today() >= DEEPSEEK_MAX_PER_DAY:
        return None
    answers = (ans or {}).get('answers') or {}
    payload = {
        'model': DEEPSEEK_MODEL,
        'messages': [
            {'role': 'system', 'content': _DS_SYS},
            {'role': 'user', 'content':
                'Jev answer (JSON):\n' + json.dumps(answers, ensure_ascii=False) + '\n\n'
                'Escalation trigger: ' + trigger + '\n\n'
                'Signal state (key indicators):\n'
                ' current_price=' + str(state.get('current_price')) +
                '  change_percent=' + str(state['price'].get('change_percent')) + '\n'
                ' day_high=' + str(state['price'].get('day_high')) +
                '  day_low=' + str(state['price'].get('day_low')) + '\n'
                ' oscillators=' + str(state.get('oscillators', [])) + '\n'
                ' position=' + str(state.get('position')) + '  quantity=' + str(state.get('quantity')) +
                '  risk_appetite=' + str(state.get('risk_appetite')) + '\n'
                'Return JSON only.'},
        ],
        'response_format': {'type': 'json_object'},
        'temperature': 0.0,
        'max_tokens': 200,
    }
    import urllib.request
    try:
        req = urllib.request.Request(
            'https://api.deepseek.com/v1/chat/completions',
            data=json.dumps(payload).encode('utf-8'),
            headers={'Authorization': 'Bearer ' + DEEPSEEK_KEY,
                     'Content-Type': 'application/json'},
            method='POST')
        txt = json.loads(urllib.request.urlopen(req, timeout=25).read().decode('utf-8'))
        content = txt['choices'][0]['message']['content']
        out = json.loads(content)
        v = (out.get('verdict') or 'approve').lower()
        if v not in ('approve', 'veto', 'reduce'):
            v = 'approve'
        lots = int(out.get('lots', 0))
        lots = 0 if v == 'veto' else max(0, min(lots, 3))
        _bump_deepseek_paid()
        return {'verdict': v, 'lots': lots,
                'reason': str(out.get('reason', ''))[:200],
                'trigger': trigger}
    except Exception as e:
        return {'error': str(type(e).__name__) + ': ' + str(e), 'trigger': trigger}


class RiskSession:
    """Track within-day counters for §6 risk rules (shadow mode).

    Trade outcomes simulated via forward prices: when a new bar closes after
    our last entry, infer P&L from direction suggested vs close.
    In real execution this must be replaced by the broker's fills.
    """

    def __init__(self):
        self.follow_count_today = 0
        self.realized_points = 0.0
        self.consecutive_losses = 0
        self.in_profit_protect = False
        self.open_entry = None
        self.open_direction = None
        self.open_ts = None

    def _close_open_position(self, current_bar):
        if self.open_entry is None or self.open_direction is None:
            return None
        if self.open_direction == 'flat':
            self.open_entry = None
            self.open_direction = None
            self.open_ts = None
            return None
        cur = current_bar['close']
        mult = 1 if self.open_direction == 'buy' else -1
        pnl = mult * (cur - self.open_entry)
        self.realized_points += pnl
        if pnl >= 0:
            self.consecutive_losses = 0
        else:
            self.consecutive_losses += 1
        if self.realized_points >= 800:
            self.in_profit_protect = True
        outcome = {'entry': self.open_entry, 'exit': cur,
                   'direction': self.open_direction, 'pnl_points': round(pnl, 2),
                   'realized_points': round(self.realized_points, 2)}
        self.open_entry = None
        self.open_direction = None
        self.open_ts = None
        return outcome

    def gate(self, bar, ans):
        answers = (ans or {}).get('answers') or {}
        a = answers.get('action_choice', {}) or {}
        choice = a.get('choice')
        try:
            conf = float(a.get('confidence', 0.0) or 0.0)
        except (TypeError, ValueError):
            conf = 0.0
        vol = answers.get('volatility_regime', {}) or {}

        # --- hard vetoes ---
        # Jev's action_choice offers buy/hold/sell only, never 'flat': treat hold as flat
        # (user decision 2026-10-20), or a hold bar falls through to approve/reduce.
        if choice in ('flat', 'hold'):
            return 'veto', 0.0, 'flat choice', 'flat'
        if _is_volatile(vol):
            return 'veto', 0.0, 'volatile environment -> risk>=1', 'volatile'
        if self.follow_count_today >= 5:
            return 'veto', 0.0, 'daily follow cap (5) reached', 'max_follow_day'
        if self.in_profit_protect and choice in ('buy', 'sell'):
            return 'veto', 0.0, 'daily profit protect gate (+800 pts already)', 'profit_protect'
        if self.consecutive_losses >= 3:
            return 'veto', 0.0, '3 consecutive losses -> stop for day', 'consec_loss_stop'

        # --- reduces ---
        lots_mult = 1.0
        reasons = []
        if conf < 0.85:
            lots_mult = min(lots_mult, 0.5)
            reasons.append('medium confidence (<0.85)')
        if conf < 0.6:
            lots_mult = min(lots_mult, 0.5)
            reasons.append('low confidence (<0.6)')
        if self.consecutive_losses == 2:
            lots_mult = min(lots_mult, 0.5)
            reasons.append('2 consecutive losses -> half lots')
        if lots_mult < 1.0:
            return 'reduce', lots_mult, reasons[0], 'reduce'
        return 'approve', 1.0, 'strong signal, risk=0', 'full'

if __name__ == "__main__":
    raise SystemExit(main())
