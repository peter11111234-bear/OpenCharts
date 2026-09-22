/**
 * Jev-Trades indicator contract — pandas `ewm(adjust=False)` / `rolling(N)` semantics.
 * Separate from lib/indicators.ts on purpose: chart indicators seed EMA with SMA,
 * Jev state needs pandas recursion seeded with the first value. Do NOT merge.
 * Mirrors pipeline/data_collector.py::calculate_indicators (commit 01fb18e).
 */

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

const NANN = Number.NaN;

/** pandas ewm(span|alpha, adjust=False, min_periods): recursion seeded with first
 *  non-NaN value; NaN inputs carry the previous output forward but don't count
 *  toward min_periods. Output is NaN until min_periods non-NaN inputs seen. */
function ewmMean(src: number[], alpha: number, minPeriods: number): number[] {
  const out = new Array<number>(src.length).fill(NANN);
  let prev = NANN;
  let seen = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i]!;
    if (!Number.isNaN(x)) {
      seen++;
      prev = Number.isNaN(prev) ? x : alpha * x + (1 - alpha) * prev;
    }
    if (seen >= minPeriods) out[i] = prev;
  }
  return out;
}

const emaSpan = (src: number[], period: number, minPeriods = period) =>
  ewmMean(src, 2 / (period + 1), minPeriods);

const wilder = (src: number[], period: number) => ewmMean(src, 1 / period, period);

/** pandas rolling(period) with default min_periods=period: any NaN in window -> NaN. */
function rolling(src: number[], period: number, fn: (w: number[]) => number): number[] {
  const out = new Array<number>(src.length).fill(NANN);
  for (let i = period - 1; i < src.length; i++) {
    const w = src.slice(i - period + 1, i + 1);
    if (w.every((v) => !Number.isNaN(v))) out[i] = fn(w);
  }
  return out;
}

const rMean = (src: number[], p: number) => rolling(src, p, (w) => w.reduce((a, b) => a + b, 0) / p);
const rSum = (src: number[], p: number) => rolling(src, p, (w) => w.reduce((a, b) => a + b, 0));
const rMax = (src: number[], p: number) => rolling(src, p, (w) => Math.max(...w));
const rMin = (src: number[], p: number) => rolling(src, p, (w) => Math.min(...w));

/** pandas WMA via rolling apply (weights 1..period). */
function wma(src: number[], period: number): number[] {
  const denom = (period * (period + 1)) / 2;
  return rolling(src, period, (w) => {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += w[j]! * (j + 1);
    return acc / denom;
  });
}

const last = (arr: number[]): number | null => {
  const v = arr[arr.length - 1];
  return v === undefined || Number.isNaN(v) || !Number.isFinite(v) ? null : v;
};

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!);
const div = (a: number[], b: number[]) => a.map((v, i) => v / b[i]!);

export function calculateJevIndicators(candles: CandleData[]): Record<string, number | null> {
  const n = candles.length;
  const close = candles.map((c) => c.close);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const volume = candles.map((c) => c.volume ?? 0);
  const typical = candles.map((c) => (c.high + c.low + c.close) / 3);

  const result: Record<string, number | null> = {};

  // ── Moving averages ──
  for (const p of [10, 20, 30, 50, 100, 200]) {
    result[`ema_${p}`] = last(emaSpan(close, p));
    result[`sma_${p}`] = last(rMean(close, p));
  }
  const hh26 = rMax(high, 26);
  const ll26 = rMin(low, 26);
  result["ichimoku_base_line_9_26_52_26"] = last(hh26.map((v, i) => (v + ll26[i]!) / 2));
  const pv = close.map((c, i) => c * volume[i]!);
  result["vwma_20"] = last(div(rSum(pv, 20), rSum(volume, 20)));
  const hmaHalf = wma(close, 4); // 9 // 2
  const hmaFull = wma(close, 9);
  const hull = wma(hmaHalf.map((v, i) => 2 * v - hmaFull[i]!), 3); // int(9 ** 0.5)
  result["hull_ma_9"] = last(hull);

  // ── RSI 14 (Wilder) ──
  const gain = new Array<number>(n).fill(NANN);
  const loss = new Array<number>(n).fill(NANN);
  for (let i = 1; i < n; i++) {
    const d = close[i]! - close[i - 1]!;
    gain[i] = Math.max(d, 0);
    loss[i] = Math.max(-d, 0);
  }
  const avgGain = wilder(gain, 14);
  const avgLoss = wilder(loss, 14);
  const rsi = avgGain.map((g, i) => {
    const l = avgLoss[i]!;
    if (Number.isNaN(g) || Number.isNaN(l)) return NANN;
    if (l === 0) return g > 0 ? 100 : NANN; // pandas: NaN unless masked; both-zero stays NaN
    return 100 - 100 / (1 + g / l);
  });
  // pandas mask: (avg_loss==0 & avg_gain>0)->100, (avg_gain==0 & avg_loss>0)->0
  for (let i = 0; i < n; i++) {
    if (avgLoss[i] === 0 && avgGain[i]! > 0) rsi[i] = 100;
    if (avgGain[i] === 0 && avgLoss[i]! > 0) rsi[i] = 0;
  }
  result["relative_strength_index_14"] = last(rsi);

  // ── Stochastic %K 14,3,3 ──
  const hh14 = rMax(high, 14);
  const ll14 = rMin(low, 14);
  const rawK = close.map((c, i) => {
    const range = hh14[i]! - ll14[i]!;
    return range === 0 || Number.isNaN(range) ? NANN : (100 * (c - ll14[i]!)) / range;
  });
  result["stochastic_percent_k_14_3_3"] = last(rMean(rawK, 3));

  // ── CCI 20 ──
  const meanDev = rolling(typical, 20, (w) => {
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    return w.reduce((a, b) => a + Math.abs(b - m), 0) / w.length;
  });
  const tpMean = rMean(typical, 20);
  result["commodity_channel_index_20"] = last(
    typical.map((t, i) => (t - tpMean[i]!) / (0.015 * meanDev[i]!)),
  );

  // ── ATR 14 + ADX 14 (Wilder) ──
  const tr = high.map((h, i) => {
    if (i === 0) return h - low[i]!;
    const pc = close[i - 1]!;
    return Math.max(h - low[i]!, Math.abs(h - pc), Math.abs(low[i]! - pc));
  });
  const plusDm = new Array<number>(n).fill(0);
  const minusDm = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = high[i]! - high[i - 1]!;
    const down = low[i - 1]! - low[i]!;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  const atr14 = wilder(tr, 14);
  const plusDi = div(wilder(plusDm, 14).map((v) => 100 * v), atr14);
  const minusDi = div(wilder(minusDm, 14).map((v) => 100 * v), atr14);
  const dx = plusDi.map((p, i) => {
    const s = p + minusDi[i]!;
    return s === 0 || Number.isNaN(s) ? NANN : (100 * Math.abs(p - minusDi[i]!)) / s;
  });
  result["average_directional_index_14"] = last(wilder(dx, 14));

  // ── MACD 12/26 + signal 9 ──
  const ema12 = emaSpan(close, 12, 26);
  const ema26 = emaSpan(close, 26, 26);
  const macdLine = sub(ema12, ema26);
  const signal = ewmMean(macdLine, 2 / 10, 9);
  result["macd_level_12_26"] = last(macdLine);

  // ── Stochastic RSI fast 3,3,14,14 ──
  const rsiMin = rMin(rsi, 14);
  const rsiMax = rMax(rsi, 14);
  const stochRsi = rsi.map((r, i) => {
    const range = rsiMax[i]! - rsiMin[i]!;
    return range === 0 || Number.isNaN(range) ? NANN : (100 * (r - rsiMin[i]!)) / range;
  });
  result["stochastic_rsi_fast_3_3_14_14"] = last(rMean(stochRsi, 3));

  // ── Williams %R 14 ──
  result["williams_percent_range_14"] = last(
    close.map((c, i) => {
      const range = hh14[i]! - ll14[i]!;
      return range === 0 || Number.isNaN(range) ? NANN : (-100 * (hh14[i]! - c)) / range;
    }),
  );

  // ── Awesome Oscillator ──
  const median = candles.map((c) => (c.high + c.low) / 2);
  result["awesome_oscillator"] = last(sub(rMean(median, 5), rMean(median, 34)));

  // ── Momentum 10 ──
  result["momentum_10"] = n > 10 ? close[n - 1]! - close[n - 11]! : null;

  // ── Bull/Bear Power (EMA 13) ──
  const ema13 = emaSpan(close, 13);
  result["bull_bear_power"] = last(high.map((h, i) => h - ema13[i]! + (low[i]! - ema13[i]!)));

  // ── Ultimate Oscillator 7/14/28 ──
  const trueLow = low.map((l, i) => (i === 0 ? l : Math.min(l, close[i - 1]!)));
  const bp = close.map((c, i) => c - trueLow[i]!);
  const bp7 = rSum(bp, 7);
  const tr7 = rSum(tr, 7);
  const bp14 = rSum(bp, 14);
  const tr14 = rSum(tr, 14);
  const bp28 = rSum(bp, 28);
  const tr28 = rSum(tr, 28);
  const uo = bp.map((_, i) => ((4 * (bp7[i]! / tr7[i]!) + 2 * (bp14[i]! / tr14[i]!) + bp28[i]! / tr28[i]!) / 7) * 100);
  result["ultimate_oscillator_7_14_28"] = last(uo);

  // ── Aliases (Jev-Trades extra keys) ──
  result["ema20"] = result["ema_20"] ?? null;
  result["sma50"] = result["sma_50"] ?? null;
  result["rsi14"] = result["relative_strength_index_14"] ?? null;
  result["macd"] = result["macd_level_12_26"] ?? null;
  result["signal"] = last(signal);
  result["atr14"] = last(atr14);

  return result;
}
