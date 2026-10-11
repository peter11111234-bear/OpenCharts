// ── PineTS ta ports: "stateless" tier ────────────────────────────────────────
// Verbatim-adapted bodies from pinets-src/src/namespaces/ta/methods. `Series`
// = PtSeries via alias; `na`→NaN. Args arrive raw (number) or as PtSeries —
// upstream `Series.from(...).get(0)` unwraps both.
// Upstream helpers inlined at the bottom (isNa, nonNaWindow, pivothigh,
// pivotlow) — they aren't part of the shim facade.
//
// NOTE on state: several of these (sma/stdev/variance/median/vwma/correlation)
// use upstream `nonNaWindow`, which keeps a rolling window in context.taState —
// so "stateless" here means "no bespoke state object", not "no taState".

import { PtSeries as Series, registerPtSlice, type PineTsCtx, type PtFactory, type PtSlice } from './pinetsShim';

// Upstream arg shape: a PtSeries, or a raw scalar (number/bool) Series.from wraps.
type PtArg = unknown;

// ── Source: pinets-src/src/namespaces/ta/methods/cog.ts:20-59 ───────────────
function ptCog(context: PineTsCtx) {
    return (source: PtArg, _length: PtArg, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const sourceSeries = Series.from(source);

        // Calculate sum of source over length period
        let sum = 0;
        let hasNaN = false;

        for (let i = 0; i < length; i++) {
            const value = sourceSeries.get(i) as number;
            if (isNaN(value)) {
                hasNaN = true;
                break;
            }
            sum += value;
        }

        // Return NaN if we don't have enough data
        if (hasNaN) {
            return NaN;
        }

        // Calculate weighted sum
        // num = sum of (price[i] * (i + 1))
        let num = 0;
        for (let i = 0; i < length; i++) {
            const price = sourceSeries.get(i) as number;
            num += price * (i + 1);
        }

        // Avoid division by zero
        if (sum === 0) {
            return NaN;
        }

        // Calculate COG
        const cog = -num / sum;

        return context.precision(cog);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/correlation.ts:16-42 ───────
function ptCorrelation(context: PineTsCtx) {
    return (source1: PtArg, source2: PtArg, _length: PtArg, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const s1 = Series.from(source1);
        const s2 = Series.from(source2);
        const key = _callId || `correlation_${length}`;

        const mean = (suffix: string, valueAt: (k: number) => number) => {
            const w = nonNaWindow(context, `${key}_${suffix}`, valueAt, length);
            if (!w) return NaN;
            let sum = 0;
            for (const v of w.values) sum += v;
            return sum / length;
        };
        const mx = mean('x', (k) => s1.get(k) as number);
        const my = mean('y', (k) => s2.get(k) as number);
        const mxy = mean('xy', (k) => (s1.get(k) as number) * (s2.get(k) as number));
        const mxx = mean('xx', (k) => (s1.get(k) as number) * (s1.get(k) as number));
        const myy = mean('yy', (k) => (s2.get(k) as number) * (s2.get(k) as number));
        if ([mx, my, mxy, mxx, myy].some((v) => Number.isNaN(v))) return NaN;

        const varX = mxx - mx * mx;
        const varY = myy - my * my;
        if (varX <= 0 || varY <= 0) return context.precision(0);

        return context.precision((mxy - mx * my) / Math.sqrt(varX * varY));
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/iii.ts:8-29 ────────────────
function ptIii(context: PineTsCtx) {
    return (_callId?: string) => {
        const close = context.get(context.data.close, 0) as number;
        const high = context.get(context.data.high, 0) as number;
        const low = context.get(context.data.low, 0) as number;
        const volume = context.get(context.data.volume, 0) as number;

        if (isNaN(close) || isNaN(high) || isNaN(low) || isNaN(volume)) {
            return NaN;
        }

        const range = high - low;

        if (range === 0) {
            return context.precision(0);
        }

        const iii = ((2 * close - high - low) / range) * volume;
        return context.precision(iii);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/median.ts:5-20 ─────────────
function ptMedian(context: PineTsCtx) {
    return (source: PtArg, _length: PtArg, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const series = Series.from(source);

        // Median of the last `length` non-na values (na values are skipped, as on TradingView).
        const window = nonNaWindow(context, _callId || `median_${length}`, (k) => series.get(k) as number, length);
        if (!window) return NaN;

        const sorted = window.values.slice().sort((a, b) => a - b);
        const mid = Math.floor(length / 2);
        const median = length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;

        return context.precision(median);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/mode.ts:8-44 ───────────────
function ptMode(context: PineTsCtx) {
    return (source: PtArg, _length: PtArg, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const series = Series.from(source);

        if (context.idx < length - 1) {
            return NaN;
        }

        const counts = new Map<number, number>();

        for (let i = 0; i < length; i++) {
            const val = series.get(i) as number;
            if (isNaN(val)) continue;

            counts.set(val, (counts.get(val) || 0) + 1);
        }

        if (counts.size === 0) return NaN;

        let modeVal = NaN;
        let maxFreq = -1;

        for (const [val, freq] of counts.entries()) {
            if (freq > maxFreq) {
                maxFreq = freq;
                modeVal = val;
            } else if (freq === maxFreq) {
                if (val < modeVal) {
                    modeVal = val;
                }
            }
        }

        return modeVal; // Should I return int or float? Input determines it. Return value is as-is.
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/percentile_linear_interpolation.ts:8-45 ──
function ptPercentileLinearInterpolation(context: PineTsCtx) {
    return (source: PtArg, _length: PtArg, _percentage: PtArg, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const percentage = Series.from(_percentage).get(0) as number;
        const series = Series.from(source);

        if (context.idx < length - 1) {
            return NaN;
        }

        const values: number[] = [];
        for (let i = 0; i < length; i++) {
            const val = series.get(i) as number;
            if (isNaN(val)) return NaN;
            values.push(val);
        }

        values.sort((a, b) => a - b);

        // Formula inferred from test data: index = (percentage / 100) * length - 0.5
        let index = (percentage / 100) * length - 0.5;

        if (index < 0) index = 0;
        if (index > length - 1) index = length - 1;

        const lowerIndex = Math.floor(index);
        const upperIndex = Math.ceil(index);

        if (lowerIndex === upperIndex) {
            return context.precision(values[lowerIndex]!);
        }

        const fraction = index - lowerIndex;
        const result = values[lowerIndex]! + fraction * (values[upperIndex]! - values[lowerIndex]!);

        return context.precision(result);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/percentile_nearest_rank.ts:8-39 ──
function ptPercentileNearestRank(context: PineTsCtx) {
    return (source: PtArg, _length: PtArg, _percentage: PtArg, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const percentage = Series.from(_percentage).get(0) as number;
        const series = Series.from(source);

        if (context.idx < length - 1) {
            return NaN;
        }

        const values: number[] = [];
        for (let i = 0; i < length; i++) {
            const val = series.get(i) as number;
            if (!isNaN(val)) {
                values.push(val);
            }
        }

        if (values.length === 0) return NaN;

        values.sort((a, b) => a - b);

        // Nearest Rank: index = ceil(P/100 * N) - 1
        let index = Math.ceil((percentage / 100) * values.length) - 1;

        if (index < 0) index = 0;
        if (index >= values.length) index = values.length - 1;

        return context.precision(values[index]!);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/percentrank.ts:7-30 ────────
function ptPercentrank(context: PineTsCtx) {
    return (source: PtArg, _length: PtArg, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const series = Series.from(source);

        if (context.idx < length) {
            return NaN;
        }

        const currentValue = series.get(0) as number;

        // As on TradingView, an na value (current or previous) compares false, so it is not counted,
        // and the count is always divided by `length`: an na bar returns 0.
        let count = 0;
        if (currentValue !== null && currentValue !== undefined) {
            for (let i = 1; i <= length; i++) {
                const val = series.get(i) as number;
                if (val !== null && val !== undefined && val <= currentValue) count++;
            }
        }

        return context.precision((count / length) * 100);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/pivothigh.ts:5-24 ──────────
// Adapted: our binder maps a 2-arg `ta.pivothigh(l, r)` call onto (source,
// leftbars); a scalar `source` means the real source is the default `high`
// (upstream gets a string _callId in _rightbars — both cases handled).
// `sourceArray` replaces upstream toArray(): PtSeries.fromPine is live
// read-through so .data is empty; materialize history forward-time instead.
function ptPivothigh(context: PineTsCtx) {
    return (source: PtArg, _leftbars: PtArg, _rightbars: PtArg, _callId?: string) => {
        //handle the case where source is not provided, in that case _rightbars will receive the _callId from the transpiler (a string value)
        if (typeof _rightbars === 'string') {
            _rightbars = _leftbars;
            _leftbars = source;
            // Upstream assigns the overwritten (non-string) _rightbars here —
            // a no-op for stateless pivots; cast keeps the verbatim shape.
            _callId = _rightbars as string;

            //by default source is
            source = context.data.high;
        }
        // Binder variant of the same case: scalar first arg.
        if (typeof source === 'number' || source === undefined) {
            _rightbars = _leftbars;
            _leftbars = source;
            source = context.data.high;
        }
        const leftbars = Series.from(_leftbars).get(0) as number;
        const rightbars = Series.from(_rightbars).get(0) as number;

        // Stateless calculation using full array history
        const sourceSeries = Series.from(source);
        const idx = context.idx;
        const sourceArray = new Array<number>(idx + 1);
        for (let j = 0; j <= idx; j++) sourceArray[j] = sourceSeries.get(idx - j) as number;
        const result = pivothighUtil(sourceArray, leftbars, rightbars);
        return context.precision(result[idx]!);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/pivotlow.ts:5-26 ───────────
function ptPivotlow(context: PineTsCtx) {
    return (source: PtArg, _leftbars: PtArg, _rightbars: PtArg, _callId?: string) => {
        //handle the case where source is not provided
        //in this case _rightbars will receive the _callId from the transpiler (a string value)
        if (typeof _rightbars === 'string') {
            _rightbars = _leftbars;
            _leftbars = source;
            _callId = _rightbars as string;

            //by default source is
            source = context.data.low;
        }
        if (typeof source === 'number' || source === undefined) {
            _rightbars = _leftbars;
            _leftbars = source;
            source = context.data.low;
        }

        const leftbars = Series.from(_leftbars).get(0) as number;
        const rightbars = Series.from(_rightbars).get(0) as number;

        // Stateless calculation using full array history
        const sourceSeries = Series.from(source);
        const idx = context.idx;
        const sourceArray = new Array<number>(idx + 1);
        for (let j = 0; j <= idx; j++) sourceArray[j] = sourceSeries.get(idx - j) as number;
        const result = pivotlowUtil(sourceArray, leftbars, rightbars);
        return context.precision(result[idx]!);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/sma.ts:5-15 ────────────────
function ptSma(context: PineTsCtx) {
    return (source: PtArg, _period: PtArg, _callId?: string) => {
        const period = Series.from(_period).get(0) as number;
        const series = Series.from(source);

        // Mean of the last `period` non-na values (na values are skipped, as on TradingView).
        const window = nonNaWindow(context, _callId || `sma_${period}`, (k) => series.get(k) as number, period);
        if (!window) return NaN;

        return context.precision(window.sum / period);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/stdev.ts:5-26 ──────────────
function ptStdev(context: PineTsCtx) {
    return (source: PtArg, _length: PtArg, ...rest: unknown[]) => {
        // The transpiler appends the call id after the optional `biased` argument.
        const _callId: string | undefined = typeof rest[rest.length - 1] === 'string' ? rest.pop() as string : undefined;
        const length = Series.from(_length).get(0) as number;
        // Our binder passes `undefined` for an omitted `biased` — same default as upstream rest.length===0.
        const bias = rest.length === 0 || rest[0] === undefined || !!Series.from(rest[0]).get(0);
        const series = Series.from(source);

        // Over the last `length` non-na values (na values are skipped, as on TradingView).
        const window = nonNaWindow(context, _callId || `stdev_${length}_${bias}`, (k) => series.get(k) as number, length);
        if (!window) return NaN;

        const mean = window.sum / length;
        let sumSquaredDiff = 0;
        for (const v of window.values) sumSquaredDiff += Math.pow(v - mean, 2);

        const divisor = bias ? length : length - 1;
        const stdev = Math.sqrt(sumSquaredDiff / divisor);

        return context.precision(stdev);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/variance.ts:5-31 ───────────
function ptVariance(context: PineTsCtx) {
    return (source: PtArg, _length: PtArg, ...rest: unknown[]) => {
        // The transpiler appends the call id after the optional `biased` argument.
        const _callId: string | undefined = typeof rest[rest.length - 1] === 'string' ? rest.pop() as string : undefined;
        const length = Series.from(_length).get(0) as number;
        const biased = rest.length === 0 || rest[0] === undefined || !!Series.from(rest[0]).get(0);
        const series = Series.from(source);

        // Over the last `length` non-na values (na values are skipped, as on TradingView).
        const window = nonNaWindow(context, _callId || `variance_${length}_${biased}`, (k) => series.get(k) as number, length);
        if (!window) return NaN;

        // Summed here rather than with the running sum: `sumSquares / length - mean^2` magnifies drift.
        let sum = 0;
        let sumSquares = 0;
        for (const v of window.values) {
            sum += v;
            sumSquares += v * v;
        }

        const mean = sum / length;
        const biasedVariance = sumSquares / length - mean * mean;
        const variance = biased ? biasedVariance : (biasedVariance * length) / (length - 1);

        return context.precision(variance);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/vwma.ts:5-27 ───────────────
function ptVwma(context: PineTsCtx) {
    return (source: PtArg, _period: PtArg, _callId?: string) => {
        const period = Series.from(_period).get(0) as number;
        const series = Series.from(source);
        const volume = Series.from(context.data.volume);
        const stateKey = _callId || `vwma_${period}`;

        // sma(source * volume) / sma(volume), each over its own last `period` non-na values: a bar
        // where the source is na drops out of the numerator only, as on TradingView.
        const weighted = nonNaWindow(context, `${stateKey}_sv`, (k) => (series.get(k) as number) * (volume.get(k) as number), period);
        const volumes = nonNaWindow(context, `${stateKey}_v`, (k) => volume.get(k) as number, period);
        if (!weighted || !volumes) return NaN;

        let sumVolPrice = 0;
        let sumVol = 0;
        for (let i = 0; i < period; i++) {
            sumVolPrice += weighted.values[i]!;
            sumVol += volumes.values[i]!;
        }

        return context.precision(sumVolPrice / sumVol);
    };
}

// ── Source: pinets-src/src/namespaces/ta/methods/wvad.ts:9-30 ───────────────
function ptWvad(context: PineTsCtx) {
    return (_callId?: string) => {
        const close = context.get(context.data.close, 0) as number;
        const open = context.get(context.data.open, 0) as number;
        const high = context.get(context.data.high, 0) as number;
        const low = context.get(context.data.low, 0) as number;
        const volume = context.get(context.data.volume, 0) as number;

        if (isNaN(close) || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(volume)) {
            return NaN;
        }

        const range = high - low;
        if (range === 0) {
            return context.precision(0);
        }

        const wvad = ((close - open) / range) * volume;
        return context.precision(wvad);
    };
}

// ── Inlined upstream helpers ─────────────────────────────────────────────────

// Source: pinets-src/src/namespaces/ta/utils/naAware.ts:3 — isNa, verbatim
// (named: the null/undefined/NaN triple-check is a real semantic guard).
const isNa = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

type Entry = { v: number; n: number };
type NonNaWindowState = {
    lastIdx: number;
    prev: { entries: Entry[]; sum: number; calls: number; callIdx: number; exhausted: boolean; length: number };
    current: { entries: Entry[]; sum: number; calls: number; callIdx: number; exhausted: boolean; length: number };
};
const isNonNaWindowState = (v: unknown): v is NonNaWindowState =>
    typeof v === 'object' && v !== null && 'lastIdx' in v && 'prev' in v && 'current' in v;

// Source: pinets-src/src/namespaces/ta/utils/nonNaWindow.ts:21-62 — verbatim
// (context typed PineTsCtx; taState record holds the same state shape).
export function nonNaWindow(
    context: PineTsCtx,
    key: string,
    valueAt: (k: number) => number,
    length: number
): { values: number[]; sum: number } | undefined {
    if (!context.taState) context.taState = {};
    const stored = context.taState[key];
    let state: NonNaWindowState;
    if (isNonNaWindowState(stored)) {
        state = stored;
    } else {
        context.taState[key] = state = {
            lastIdx: -1,
            prev: { entries: [] as Entry[], sum: 0, calls: 0, callIdx: -1, exhausted: false, length: NaN },
            current: { entries: [] as Entry[], sum: 0, calls: 0, callIdx: -1, exhausted: false, length: NaN },
        };
    }

    if (context.idx > state.lastIdx) {
        if (state.lastIdx >= 0) state.prev = { ...state.current, entries: [...state.current.entries] };
        state.lastIdx = context.idx;
    }

    const prev = state.prev;
    const calls = prev.calls + 1;
    const entries: Entry[] = [...prev.entries];
    let sum = prev.sum;
    let exhausted = prev.exhausted && prev.callIdx === context.idx - 1 && prev.length === length;

    const value = valueAt(0);
    if (!isNa(value)) {
        entries.unshift({ v: value, n: calls });
        sum += value;
    }
    while (entries.length > length) sum -= entries.pop()!.v;

    let rebuilt = prev.length !== length;
    if (entries.length < length && !exhausted && (calls >= length || context.idx >= length - 1)) {
        const k0 = entries.length ? calls - entries[entries.length - 1]!.n + 1 : 1;
        for (let k = k0; entries.length < length && k <= context.idx; k++) {
            const v = valueAt(k);
            if (!isNa(v)) entries.push({ v, n: calls - k });
        }
        exhausted = entries.length < length;
        rebuilt = true;
    }
    if (rebuilt) sum = entries.reduce((s, e) => s + e.v, 0);

    state.current = { entries, sum, calls, callIdx: context.idx, exhausted, length };
    return entries.length < length ? undefined : { values: entries.map((e) => e.v), sum };
}

// Source: pinets-src/src/namespaces/ta/utils/pivothigh.ts:2-52 — verbatim.
export function pivothighUtil(source: number[], leftbars: number, rightbars: number): number[] {
    const result = new Array<number>(source.length).fill(NaN);

    // We need at least leftbars + rightbars + 1 (for the center point) values
    for (let i = leftbars + rightbars; i < source.length; i++) {
        const pivot = source[i - rightbars];
        // An na candidate is never a pivot
        if (pivot === undefined || isNaN(pivot)) continue;
        let isPivot = true;

        // TradingView's tie rule is asymmetric: a LEFT bar equal to the candidate does
        // not disqualify it (only a strictly higher one does), while a RIGHT bar equal to
        // the candidate does — the later equal bar becomes the pivot instead. Verified
        // against TradingView on a hand-built series (tests/namespaces/ta/tie-handling.test.ts).
        // TradingView also stops scanning at the first na on either side: bars behind it
        // are never examined, so they cannot disqualify the candidate
        // (tests/namespaces/ta/na-window-semantics.test.ts).
        for (let j = 1; j <= leftbars; j++) {
            const v = source[i - rightbars - j];
            if (v === undefined || isNaN(v)) break;
            if (v > pivot) {
                isPivot = false;
                break;
            }
        }

        // Check if the pivot is strictly higher than all bars to the right within rightbars range
        if (isPivot) {
            for (let j = 1; j <= rightbars; j++) {
                const v = source[i - rightbars + j];
                if (v === undefined || isNaN(v)) break;
                if (v >= pivot) {
                    isPivot = false;
                    break;
                }
            }
        }

        // If this is a pivot point, set its value, otherwise keep NaN
        if (isPivot) {
            result[i] = pivot;
        }
    }

    return result;
}

// Source: pinets-src/src/namespaces/ta/utils/pivotlow.ts:2-52 — verbatim.
export function pivotlowUtil(source: number[], leftbars: number, rightbars: number): number[] {
    const result = new Array<number>(source.length).fill(NaN);

    // We need at least leftbars + rightbars + 1 (for the center point) values
    for (let i = leftbars + rightbars; i < source.length; i++) {
        const pivot = source[i - rightbars];
        // An na candidate is never a pivot
        if (pivot === undefined || isNaN(pivot)) continue;
        let isPivot = true;

        // TradingView's tie rule is asymmetric: a LEFT bar equal to the candidate does
        // not disqualify it (only a strictly lower one does), while a RIGHT bar equal to
        // the candidate does — the later equal bar becomes the pivot instead. Verified
        // against TradingView on a hand-built series (tests/namespaces/ta/tie-handling.test.ts).
        // TradingView also stops scanning at the first na on either side: bars behind it
        // are never examined, so they cannot disqualify the candidate
        // (tests/namespaces/ta/na-window-semantics.test.ts).
        for (let j = 1; j <= leftbars; j++) {
            const v = source[i - rightbars - j];
            if (v === undefined || isNaN(v)) break;
            if (v < pivot) {
                isPivot = false;
                break;
            }
        }

        // Check if the pivot is strictly lower than all bars to the right within rightbars range
        if (isPivot) {
            for (let j = 1; j <= rightbars; j++) {
                const v = source[i - rightbars + j];
                if (v === undefined || isNaN(v)) break;
                if (v <= pivot) {
                    isPivot = false;
                    break;
                }
            }
        }

        // If this is a pivot point, set its value, otherwise keep NaN
        if (isPivot) {
            result[i] = pivot;
        }
    }

    return result;
}

// ── Slice registration ───────────────────────────────────────────────────────
// Upstream bodies keep their any-shaped signatures under the typed PtArg
// alias; the boundary cast to PtFactory is per-port, once (same as pinetsShim).

const SLICE: PtSlice = {
    cog: { factory: ptCog as unknown as PtFactory, order: ['source', 'length'] },
    correlation: { factory: ptCorrelation as unknown as PtFactory, order: ['source1', 'source2', 'length'] },
    iii: { factory: ptIii as unknown as PtFactory, order: [] },
    median: { factory: ptMedian as unknown as PtFactory, order: ['source', 'length'] },
    mode: { factory: ptMode as unknown as PtFactory, order: ['source', 'length'] },
    percentile_linear_interpolation: { factory: ptPercentileLinearInterpolation as unknown as PtFactory, order: ['source', 'length', 'percentage'] },
    percentile_nearest_rank: { factory: ptPercentileNearestRank as unknown as PtFactory, order: ['source', 'length', 'percentage'] },
    percentrank: { factory: ptPercentrank as unknown as PtFactory, order: ['source', 'length'] },
    pivothigh: { factory: ptPivothigh as unknown as PtFactory, order: ['source', 'leftbars', 'rightbars'] },
    pivotlow: { factory: ptPivotlow as unknown as PtFactory, order: ['source', 'leftbars', 'rightbars'] },
    sma: { factory: ptSma as unknown as PtFactory, order: ['source', 'period'] },
    stdev: { factory: ptStdev as unknown as PtFactory, order: ['source', 'length', 'biased'] },
    variance: { factory: ptVariance as unknown as PtFactory, order: ['source', 'length', 'biased'] },
    vwma: { factory: ptVwma as unknown as PtFactory, order: ['source', 'period'] },
    wvad: { factory: ptWvad as unknown as PtFactory, order: [] },
};
registerPtSlice(SLICE);
