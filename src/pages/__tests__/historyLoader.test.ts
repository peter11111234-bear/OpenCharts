import { describe, it, expect, vi } from "vitest";
import type { LogicalRange } from "lightweight-charts";
import type { Candle } from "../../services/schemas.ts";
import { EMPTY_EXTENSION, prependExtension } from "../trading/chartHistory.ts";
import {
  createLoadMoreState,
  extensionWindowMs,
  getSeriesOldestMs,
  isLoadMoreEligible,
  makeHistoryLoader,
  type HistorySeries,
} from "../trading/historyLoader.ts";

/**
 * Drives the real loader state machine against a synthetic 1-minute history and
 * a fake fetcher, so the scroll-left contract is covered without mounting the
 * chart or the React Query layer. The fake fetch mirrors demo/candles.ts: bounds
 * inclusive at both ends, which is what re-sends the boundary bar the chart
 * already holds.
 */

const MINUTE = 60;
const BARS = 1000;
const LAST = 1_700_000_000;
const TF = "1m";
const RANGE = { from: 0, to: 100 } as LogicalRange;

/** Display time of bar `i`; index 0 is the oldest. */
const barTime = (i: number) => LAST - (BARS - 1 - i) * MINUTE;
const indexOf = (timeSec: number) => BARS - 1 - (LAST - timeSec) / MINUTE;

const candle = (time: number): Candle =>
  ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 }) as Candle;

/**
 * Let the loader's then/catch/finally chain run. Microtasks only, no clock: the
 * chain is at most three links deep, so a bounded drain is deterministic.
 */
const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

/** The window the loader asked for, sliced the way candles.ts slices it. */
function windowOf(range: { fromMs: number; toMs: number }): Candle[] {
  const fromSec = Math.floor(range.fromMs / 1000);
  const toSec = Math.ceil(range.toMs / 1000);
  const bars: Candle[] = [];
  for (let i = 0; i < BARS; i++) {
    const t = barTime(i);
    if (t >= fromSec && t <= toSec) bars.push(candle(t));
  }
  return bars;
}

function harness(opts: { loadedFrom?: number; barsBefore?: number } = {}) {
  let from = opts.loadedFrom ?? BARS - 100;
  const state = createLoadMoreState();
  const calls: { fromMs: number; toMs: number }[] = [];
  const batches: Candle[][] = [];
  const base = { current: LAST };
  const series: HistorySeries = {
    data: () => {
      const out: { time: number }[] = [];
      for (let i = from; i < BARS; i++) out.push({ time: barTime(i) });
      return out;
    },
    barsInLogicalRange: () => ({ barsBefore: opts.barsBefore ?? 0 }),
  };
  const load = makeHistoryLoader({
    symbol: "BTCUSD",
    timeframeRef: { current: TF },
    seriesRef: { current: series },
    stateRef: { current: state },
    baseRef: base,
    fetchCandles: (_symbol, _timeframe, range) => {
      calls.push(range);
      return Promise.resolve(windowOf(range));
    },
    onLoaded: (bars) => {
      batches.push(bars);
      from = Math.min(from, indexOf(Number(bars[0]!.time)));
    },
  });
  return {
    series,
    state,
    base,
    calls,
    batches,
    load: () => load(RANGE),
    loadedFrom: () => from,
  };
}

describe("history loader", () => {
  it("prepends strictly older bars on each scroll and stops at the start of history", async () => {
    const h = harness({ loadedFrom: 900 });

    h.load();
    await flush();
    // 500 genuinely older bars plus the boundary bar the chart already holds.
    expect(h.calls[0]).toEqual({
      fromMs: (barTime(900) - 500 * MINUTE) * 1000,
      toMs: barTime(900) * 1000,
    });
    expect(h.batches[0]).toHaveLength(501);
    expect(h.batches[0]![0]!.time).toBe(barTime(400));
    expect(h.batches[0]!.at(-1)!.time).toBe(barTime(900));
    expect(h.loadedFrom()).toBe(400);

    h.load();
    await flush();
    expect(h.batches[1]!.at(-1)!.time).toBe(barTime(400));
    expect(h.batches[1]![0]!.time).toBe(barTime(0));
    expect(h.loadedFrom()).toBe(0);

    h.load();
    await flush();
    // Start of history: the window can only return the boundary bar, so the
    // oldest bar cannot move again.
    expect(h.batches[2]!.map((c) => c.time)).toEqual([barTime(0)]);
    expect(h.loadedFrom()).toBe(0);

    // The eligibility guard then turns itself off by itself.
    expect(isLoadMoreEligible(h.state, h.series, RANGE)).toBe(false);
    h.load();
    await flush();
    expect(h.calls).toHaveLength(3);
  });

  it("keeps the merged history contiguous across loads", async () => {
    const h = harness({ loadedFrom: 900 });
    let ext = EMPTY_EXTENSION;

    for (let round = 0; round < 3; round++) {
      h.load();
      await flush();
      ext = prependExtension(ext, h.batches.at(-1)!, h.base.current);
    }

    const unique = [...new Set(ext.bars.map((c) => c.time))].sort((a, b) => a - b);
    expect(unique).toHaveLength(BARS - 99);
    // Ascending with every slot between the ends filled: no hole at either seam.
    expect(unique.filter((t, i) => i > 0 && t - unique[i - 1]! !== MINUTE)).toEqual([]);
    expect(unique[0]).toBe(barTime(0));
    expect(unique.at(-1)).toBe(barTime(900));
  });

  it("walks past a gap instead of locking end-of-history on the first empty window", async () => {
    const windowMs = extensionWindowMs(TF);
    // One window plus a second: the first walk-back step stays above the epoch.
    const oldestSec = windowMs / 1000 + 1;
    const state = createLoadMoreState();
    const calls: { fromMs: number; toMs: number }[] = [];
    const series: HistorySeries = {
      data: () => [{ time: oldestSec }, { time: oldestSec + MINUTE }],
      barsInLogicalRange: () => ({ barsBefore: 0 }),
    };
    let deferred = Promise.withResolvers<Candle[]>();
    let loaded = 0;
    const load = makeHistoryLoader({
      symbol: "BTCUSD",
      timeframeRef: { current: TF },
      seriesRef: { current: series },
      stateRef: { current: state },
      baseRef: { current: 7 },
      fetchCandles: (_symbol, _timeframe, range) => {
        calls.push(range);
        return deferred.promise;
      },
      onLoaded: () => {
        loaded += 1;
      },
    });

    load(RANGE);
    expect(calls[0]!.toMs).toBe(oldestSec * 1000);
    deferred.resolve([]);
    await flush();

    // An empty window is a gap, not the end of history: the boundary shifts
    // back one window and the loader stays armed for the next scroll.
    expect(loaded).toBe(0);
    expect(state.noMoreData).toBe(false);
    expect(state.loading).toBe(false);
    expect(state.fetchFromMs).toBe(calls[0]!.toMs - windowMs);
    expect(isLoadMoreEligible(state, series, RANGE)).toBe(true);

    // The shifted boundary is below the epoch, so the next empty reply ends it.
    const shifted = state.fetchFromMs;
    deferred = Promise.withResolvers<Candle[]>();
    load(RANGE);
    // Consuming the boundary clears it, which is what the scroll loop relies on.
    expect(calls[1]!.toMs).toBe(shifted);
    expect(state.fetchFromMs).toBe(0);
    deferred.resolve([]);
    await flush();

    expect(state.noMoreData).toBe(true);
    expect(isLoadMoreEligible(state, series, RANGE)).toBe(false);
    load(RANGE);
    expect(calls).toHaveLength(2);
  });

  it("resets the boundary after a failed request so the user can retry", async () => {
    const h = harness({ loadedFrom: 900 });
    const failing = makeHistoryLoader({
      symbol: "BTCUSD",
      timeframeRef: { current: TF },
      seriesRef: { current: h.series },
      stateRef: { current: h.state },
      baseRef: h.base,
      fetchCandles: () => Promise.reject(new Error("offline")),
      onLoaded: (bars) => h.batches.push(bars),
    });

    failing(RANGE);
    await flush();

    expect(h.state.loading).toBe(false);
    expect(h.state.lastFetchedBeforeMs).toBe(0);
    expect(h.batches).toHaveLength(0);
    expect(isLoadMoreEligible(h.state, h.series, RANGE)).toBe(true);
  });

  it("hands the reply the time base read when the request was made", async () => {
    const deferred = Promise.withResolvers<Candle[]>();
    const seen: number[] = [];
    const base = { current: LAST };
    const state = createLoadMoreState();
    const load = makeHistoryLoader({
      symbol: "BTCUSD",
      timeframeRef: { current: TF },
      seriesRef: {
        current: {
          data: () => [{ time: barTime(BARS - 1) }],
          barsInLogicalRange: () => ({ barsBefore: 0 }),
        } as HistorySeries,
      },
      stateRef: { current: state },
      baseRef: base,
      fetchCandles: () => deferred.promise,
      onLoaded: (_bars, batchBase) => seen.push(batchBase),
    });

    load(RANGE);
    // The payload re-anchors while the reply is still in flight. The bars were
    // produced against the older base, so that is the one they must merge onto.
    base.current = LAST + 5 * MINUTE;
    deferred.resolve([candle(barTime(BARS - 1))]);
    await flush();

    expect(seen).toEqual([LAST]);
    expect(seen[0]).not.toBe(base.current);
  });

  it("stays out of the way unless the user is at the left edge with history to gain", () => {
    const series: HistorySeries = {
      data: () => [{ time: barTime(999) }],
      barsInLogicalRange: () => ({ barsBefore: 0 }),
    };

    expect(getSeriesOldestMs(series)).toBe(barTime(999) * 1000);
    expect(isLoadMoreEligible(createLoadMoreState(), series, RANGE)).toBe(true);

    expect(isLoadMoreEligible({ ...createLoadMoreState(), loading: true }, series, RANGE)).toBe(false);
    expect(isLoadMoreEligible({ ...createLoadMoreState(), noMoreData: true }, series, RANGE)).toBe(false);

    const farBehind: HistorySeries = {
      data: () => [{ time: barTime(999) }],
      barsInLogicalRange: () => ({ barsBefore: 500 }),
    };
    expect(isLoadMoreEligible(createLoadMoreState(), farBehind, RANGE)).toBe(false);
    // A shifted boundary from a previous empty window keeps the loader armed,
    // but only once the user is back at the left edge.
    expect(isLoadMoreEligible({ ...createLoadMoreState(), fetchFromMs: 1 }, series, RANGE)).toBe(true);
    expect(isLoadMoreEligible({ ...createLoadMoreState(), fetchFromMs: 1 }, farBehind, RANGE)).toBe(false);

    const empty: HistorySeries = { data: () => [], barsInLogicalRange: () => ({ barsBefore: 0 }) };
    expect(getSeriesOldestMs(empty)).toBe(0);
    expect(isLoadMoreEligible(createLoadMoreState(), empty, RANGE)).toBe(false);

    const onLoaded = vi.fn();
    makeHistoryLoader({
      symbol: "BTCUSD",
      timeframeRef: { current: TF },
      seriesRef: { current: null },
      stateRef: { current: createLoadMoreState() },
      baseRef: { current: 0 },
      fetchCandles: () => Promise.resolve([]),
      onLoaded,
    })(null);
    expect(onLoaded).not.toHaveBeenCalled();
  });
});
