"""Generate deterministic candles + pandas-expected indicator values for the
jevIndicators.ts conformance test. Mirrors Jev-Trades data_collector.py
calculate_indicators (commit 01fb18e) verbatim.

Run:  python C:\\Users\\bear9\\OpenCharts\\scripts\\gen_jev_fixture.py
Requires: pandas (pip install pandas)
"""
import json
from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parent.parent / "src" / "__tests__" / "fixtures" / "jev-indicators.json"
N = 260


def make_candles() -> list[dict]:
    """Deterministic pseudo-random walk (LCG), no external data needed."""
    candles = []
    price = 17000.0
    state = 12345
    for i in range(N):
        state = (1103515245 * state + 12345) % (2**31)
        r1 = state / 2**31 - 0.5          # [-0.5, 0.5)
        state = (1103515245 * state + 12345) % (2**31)
        r2 = state / 2**31                # [0, 1)
        o = price
        c = o * (1 + r1 * 0.004)
        h = max(o, c) * (1 + r2 * 0.002)
        l = min(o, c) * (1 - r2 * 0.002)
        v = 1000 + int(r2 * 5000)
        candles.append({"time": 1758000000 + i * 60, "open": round(o, 2),
                        "high": round(h, 2), "low": round(l, 2),
                        "close": round(c, 2), "volume": v})
        price = c
    return candles


def _wilder(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def _wma(series: pd.Series, period: int) -> pd.Series:
    weights = pd.Series(range(1, period + 1), dtype="float64")
    return series.rolling(period).apply(lambda values: float((values * weights.to_numpy()).sum() / weights.sum()), raw=True)


def _last(value):
    return None if pd.isna(value) else round(float(value), 6)


def expected(candles: list[dict]) -> dict:
    close = pd.Series([b["close"] for b in candles], dtype="float64")
    high = pd.Series([b["high"] for b in candles], dtype="float64")
    low = pd.Series([b["low"] for b in candles], dtype="float64")
    volume = pd.Series([b["volume"] for b in candles], dtype="float64")
    typical = (high + low + close) / 3
    ma = {}
    for period in (10, 20, 30, 50, 100, 200):
        ma[f"ema_{period}"] = close.ewm(span=period, adjust=False, min_periods=period).mean()
        ma[f"sma_{period}"] = close.rolling(period).mean()
    ma["ichimoku_base_line_9_26_52_26"] = (high.rolling(26).max() + low.rolling(26).min()) / 2
    ma["vwma_20"] = (close * volume).rolling(20).sum() / volume.rolling(20).sum().replace(0, float("nan"))
    hma_half = _wma(close, 9 // 2)
    hma_full = _wma(close, 9)
    ma["hull_ma_9"] = _wma(2 * hma_half - hma_full, int(9 ** 0.5))

    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    average_gain = _wilder(gain, 14)
    average_loss = _wilder(loss, 14)
    rsi = 100 - (100 / (1 + average_gain / average_loss.replace(0, float("nan"))))
    rsi = rsi.mask((average_loss == 0) & (average_gain > 0), 100)
    rsi = rsi.mask((average_gain == 0) & (average_loss > 0), 0)
    trailing_high = high.rolling(14).max()
    trailing_low = low.rolling(14).min()
    raw_stochastic = 100 * (close - trailing_low) / (trailing_high - trailing_low).replace(0, float("nan"))
    stochastic_k = raw_stochastic.rolling(3).mean()
    mean_deviation = typical.rolling(20).apply(lambda values: float(abs(values - values.mean()).mean()), raw=True)
    cci = (typical - typical.rolling(20).mean()) / (0.015 * mean_deviation)

    true_range = pd.concat([high - low, (high - close.shift()).abs(), (low - close.shift()).abs()], axis=1).max(axis=1)
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = up_move.where((up_move > down_move) & (up_move > 0), 0)
    minus_dm = down_move.where((down_move > up_move) & (down_move > 0), 0)
    atr14 = _wilder(true_range, 14)
    plus_di = 100 * _wilder(plus_dm, 14) / atr14
    minus_di = 100 * _wilder(minus_dm, 14) / atr14
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, float("nan"))
    adx = _wilder(dx, 14)

    macd = close.ewm(span=12, adjust=False, min_periods=26).mean() - close.ewm(span=26, adjust=False, min_periods=26).mean()
    macd_signal = macd.ewm(span=9, adjust=False, min_periods=9).mean()
    stoch_rsi = 100 * (rsi - rsi.rolling(14).min()) / (rsi.rolling(14).max() - rsi.rolling(14).min()).replace(0, float("nan"))
    stoch_rsi_fast = stoch_rsi.rolling(3).mean()
    williams = -100 * (trailing_high - close) / (trailing_high - trailing_low).replace(0, float("nan"))
    awesome = (high + low).div(2).rolling(5).mean() - (high + low).div(2).rolling(34).mean()
    momentum = close - close.shift(10)
    bull_bear = (high - close.ewm(span=13, adjust=False, min_periods=13).mean()) + (low - close.ewm(span=13, adjust=False, min_periods=13).mean())
    true_low = pd.concat([low, close.shift()], axis=1).min(axis=1)
    buying_pressure = close - true_low
    uo = (4 * buying_pressure.rolling(7).sum() / true_range.rolling(7).sum() + 2 * buying_pressure.rolling(14).sum() / true_range.rolling(14).sum() + buying_pressure.rolling(28).sum() / true_range.rolling(28).sum()) / 7 * 100

    result = {name: _last(values.iloc[-1]) for name, values in ma.items()}
    result.update({
        "relative_strength_index_14": _last(rsi.iloc[-1]),
        "stochastic_percent_k_14_3_3": _last(stochastic_k.iloc[-1]),
        "commodity_channel_index_20": _last(cci.iloc[-1]),
        "average_directional_index_14": _last(adx.iloc[-1]),
        "awesome_oscillator": _last(awesome.iloc[-1]),
        "momentum_10": _last(momentum.iloc[-1]),
        "macd_level_12_26": _last(macd.iloc[-1]),
        "stochastic_rsi_fast_3_3_14_14": _last(stoch_rsi_fast.iloc[-1]),
        "williams_percent_range_14": _last(williams.iloc[-1]),
        "bull_bear_power": _last(bull_bear.iloc[-1]),
        "ultimate_oscillator_7_14_28": _last(uo.iloc[-1]),
        "ema20": _last(ma["ema_20"].iloc[-1]),
        "sma50": _last(ma["sma_50"].iloc[-1]),
        "rsi14": _last(rsi.iloc[-1]),
        "macd": _last(macd.iloc[-1]),
        "signal": _last(macd_signal.iloc[-1]),
        "atr14": _last(atr14.iloc[-1]),
    })
    return result


def main() -> None:
    candles = make_candles()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"candles": candles, "expected": expected(candles)}), encoding="utf-8")
    print(f"wrote {OUT} ({N} candles)")


if __name__ == "__main__":
    main()
