import type { LogicalRange } from "lightweight-charts";
import type { Candle } from "../../services/schemas.ts";
import { TF_INTERVAL_MS, type Timeframe } from "./constants.ts";

/**
 * Scroll-triggered history loading: when the user reaches the left edge of the
 * loaded data, fetch the preceding window and prepend it so the chart extends
 * seamlessly. Kept free of React and of the chart runtime — only the two series
 * members it actually reads — so the state machine is testable on its own.
 */

const LOAD_MORE_THRESHOLD = 20; // trigger when fewer than N bars remain on the left
const LOAD_MORE_WINDOW = 500; // how many interval-widths to fetch per extension

/** The slice of a chart series this loader reads. */
export interface HistorySeries {
  data(): readonly { time: unknown }[];
  barsInLogicalRange(range: LogicalRange): { barsBefore: number | null } | null;
}

export type LoadMoreState = {
  loading: boolean;
  noMoreData: boolean;
  lastFetchedBeforeMs: number;
  // When > 0, use this as toMs for the next fetch instead of the series' oldest
  // bar. Set after an empty-range response so we skip over gaps (e.g. Forex
  // weekends) rather than permanently locking noMoreData on the first empty
  // window.
  fetchFromMs: number;
};

/** Fetches one millisecond window of history. Injected so the loader is testable. */
export type FetchOlderCandles = (
  symbol: string,
  timeframe: string,
  range: { fromMs: number; toMs: number },
) => Promise<Candle[]>;

export type HistoryLoaderOptions = {
  symbol: string;
  /** The chart persists across timeframe changes, so the loader must read the current one. */
  timeframeRef: { current: string };
  seriesRef: { current: HistorySeries | null };
  stateRef: { current: LoadMoreState };
  /** Time base the loaded payload is expressed in (see chartHistory.ts). */
  baseRef: { current: number };
  fetchCandles: FetchOlderCandles;
  onLoaded: (bars: Candle[], base: number) => void;
};

export function createLoadMoreState(): LoadMoreState {
  return { loading: false, noMoreData: false, lastFetchedBeforeMs: 0, fetchFromMs: 0 };
}

/** Milliseconds spanned by one extension fetch on a timeframe. */
export function extensionWindowMs(timeframe: string): number {
  return LOAD_MORE_WINDOW * (TF_INTERVAL_MS[timeframe as Timeframe] ?? 60_000);
}

export function getSeriesOldestMs(series: HistorySeries): number {
  const data = series.data();
  return data.length === 0 ? 0 : Number(data[0]!.time) * 1_000;
}

export function isLoadMoreEligible(
  state: LoadMoreState,
  series: HistorySeries,
  range: LogicalRange,
): boolean {
  if (state.loading || state.noMoreData) return false;
  const barsInfo = series.barsInLogicalRange(range);
  if ((barsInfo?.barsBefore ?? Number.POSITIVE_INFINITY) > LOAD_MORE_THRESHOLD) return false;
  // A shifted window from a previous empty-range response is always eligible —
  // we need to try the window before the gap (e.g. before a Forex weekend).
  if (state.fetchFromMs > 0) return true;
  const oldestMs = getSeriesOldestMs(series);
  if (oldestMs === 0) return false;
  return state.lastFetchedBeforeMs === 0 || oldestMs < state.lastFetchedBeforeMs;
}

/**
 * Apply one in-flight window request. `base` is the time base the reply will be
 * expressed in, captured when the request was made rather than here: a reply
 * landing after the payload re-anchored would otherwise be merged onto the wrong
 * base, which opens a hole at the batch seam.
 */
export function fetchOlderRange(
  toMs: number,
  windowMs: number,
  state: LoadMoreState,
  pending: Promise<Candle[]>,
  base: number,
  onLoaded: (bars: Candle[], base: number) => void,
): void {
  pending
    .then((bars) => {
      if (bars.length === 0) {
        // Empty window — could be a gap (e.g. Forex weekend) rather than true
        // end of history. Shift the fetch boundary back one more window so the
        // next scroll event tries the range before this gap instead of stopping.
        const nextToMs = toMs - windowMs;
        if (nextToMs > 0) {
          state.fetchFromMs = nextToMs;
        } else {
          state.noMoreData = true;
        }
      } else {
        onLoaded(bars, base);
      }
    })
    .catch(() => {
      // Reset the fetch boundary so the user can retry by scrolling again.
      // Without this, a transient network error permanently blocks history
      // loading for the current view (lastFetchedBeforeMs stays set but no
      // bars were prepended, so the eligibility guard never clears).
      state.lastFetchedBeforeMs = 0;
    })
    .finally(() => {
      state.loading = false;
    });
}

export function makeHistoryLoader(opts: HistoryLoaderOptions): (range: LogicalRange | null) => void {
  const { symbol, timeframeRef, seriesRef, stateRef, baseRef, fetchCandles, onLoaded } = opts;
  return (range) => {
    const series = seriesRef.current;
    if (!range || !series) return;
    const state = stateRef.current;
    if (!isLoadMoreEligible(state, series, range)) return;
    // Use the shifted boundary from a prior empty-range response when present,
    // otherwise fall back to the series' current oldest bar.
    const toMs = state.fetchFromMs > 0 ? state.fetchFromMs : getSeriesOldestMs(series);
    if (toMs === 0) return;
    const timeframe = timeframeRef.current;
    const windowMs = extensionWindowMs(timeframe);
    state.loading = true;
    state.lastFetchedBeforeMs = toMs;
    state.fetchFromMs = 0;
    // Capture the base now: the reply is produced against whatever base is
    // pinned at request time, and reading it back on arrival would race a
    // re-anchor in between.
    const base = baseRef.current;
    fetchOlderRange(
      toMs,
      windowMs,
      state,
      fetchCandles(symbol, timeframe, { fromMs: toMs - windowMs, toMs }),
      base,
      onLoaded,
    );
  };
}
