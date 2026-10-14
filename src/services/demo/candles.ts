import type { Candle } from "../schemas.ts";

/**
 * Loads the bundled REAL OHLC history and serves it to the chart / feed.
 *
 * History is time-shifted at runtime so the most recent bar aligns to the
 * current period, making the demo feel "live" while every OHLC value remains
 * genuine market data (never synthetic). The demo feed (feed.ts) then streams
 * replayed real ticks forward from "now".
 */

// Eagerly bundle every data/<SYMBOL>_<tf>.json file.
const modules = import.meta.glob<{ default: Candle[] }>("./data/*.json", { eager: true });

const series = new Map<string, Candle[]>();
for (const [path, mod] of Object.entries(modules)) {
  const key = path.replace("./data/", "").replace(".json", ""); // e.g. "BTCUSD_1h"
  series.set(key, mod.default);
}

const TF_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

function rawSeries(symbol: string, timeframe: string): Candle[] {
  return series.get(`${symbol}_${timeframe}`) ?? [];
}

/** Start of the current period (seconds) for a timeframe. */
function currentBucketSec(timeframe: string): number {
  const interval = TF_SECONDS[timeframe] ?? 60;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec - (nowSec % interval);
}

// The shift is memoised per series. Recomputing it on every call slid the whole
// series forward by whole periods whenever the wall clock crossed a bucket
// boundary, so a second fetch returned bars offset from the ones already on the
// chart (duplicate/near-duplicate candles). The anchor instead pins one time
// base for as long as the wall clock stays in the bucket it was pinned to.
//
// A tail request may re-anchor once the clock leaves that bucket: the chart is
// rebuilt from its payload, and a frozen anchor would leave the visible tail
// stopped at the session's first access while every repair refetch returned a
// byte-identical payload. A windowed request never re-anchors — its whole job is
// to stay contiguous with the bars already on screen.
const anchorBySeries = new Map<string, { delta: number; bucket: number }>();

/** Per-series shift that maps the last real bar onto the current period. */
function shiftDelta(symbol: string, timeframe: string, bars: Candle[], refresh: boolean): number {
  const key = `${symbol}_${timeframe}`;
  const bucket = currentBucketSec(timeframe);
  const cached = anchorBySeries.get(key);
  if (cached && (!refresh || cached.bucket === bucket)) return cached.delta;
  if (bars.length === 0) return 0;
  const delta = bucket - bars[bars.length - 1]!.time;
  anchorBySeries.set(key, { delta, bucket });
  return delta;
}

/** Millisecond bounds, matching the market-data contract's `range` argument. */
export type CandleRange = { fromMs: number; toMs: number };

/**
 * Real history for a symbol/timeframe, shifted so the last bar is the current
 * period. `range` windows the result to [fromMs, toMs] inclusive at both ends,
 * matching how the live backend treats the same millisecond bounds — the
 * "load older history" caller passes its oldest visible bar as toMs, so the
 * boundary bar comes back too and the chart's dedupe swallows it.
 */
export function getHistory(
  symbol: string,
  timeframe: string,
  limit?: number,
  range?: CandleRange,
): Candle[] {
  const bars = rawSeries(symbol, timeframe);
  if (bars.length === 0) return [];
  // Only a tail request (no range window) is allowed to move the time base.
  const delta = shiftDelta(symbol, timeframe, bars, range === undefined);
  let out = bars.map((c) => ({ ...c, time: c.time + delta }));
  if (range) {
    const fromSec = Math.floor(range.fromMs / 1000);
    const toSec = Math.ceil(range.toMs / 1000);
    out = out.filter((c) => c.time >= fromSec && c.time <= toSec);
  }
  return limit && limit < out.length ? out.slice(-limit) : out;
}

/** Drop the memoised anchors. For tests and HMR, which reuse the module. */
export function resetShiftCache(): void {
  anchorBySeries.clear();
}

/** Fine-grained close series (1m) used by the feed to replay real ticks. */
export function getTickPrices(symbol: string): number[] {
  const bars = rawSeries(symbol, "1m");
  return bars.map((c) => c.close);
}

/** Latest real close — seed price before the feed starts streaming. */
export function getSeedPrice(symbol: string): number {
  const prices = getTickPrices(symbol);
  return prices[prices.length - 1] ?? 0;
}
