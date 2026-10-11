// ── pinets ta ports — STATEFUL A tier (24 methods) ───────────────────────────
// Verbatim-adapted PineTS (AGPL-3.0-only) method bodies running on the
// pinetsShim facade. Registers via registerPtSlice at import time; the shim's
// registerPortedTa() installs them under their real `ta.*` names.
//
// Typing convention (no `any` — repo rule): upstream bodies treat context as
// `any`; here `taState` entries are cast once to the structural interface the
// upstream body writes (`as PtXxxState`), and Series.get()/context.get()
// results are narrowed with `as number`/`as boolean` at the read — the values
// are our own bar data, so the boundary cast is trusted.

import { PtSeries as Series, registerPtSlice, type PineTsCtx, type PtFactory, type PtSlice } from './pinetsShim';

// ── Shared state shapes (the fields each upstream body writes) ───────────────

// cci / dev — window keeps na entries, so unknown[].
interface PtWinSumCountState {
    lastIdx: number;
    prevWindow: unknown[]; prevSum: number; prevCallCount: number;
    currentWindow: unknown[]; currentSum: number; currentCallCount: number;
}

// bb / bbw — na bars are excluded from the window entirely.
interface PtWinSumState {
    lastIdx: number;
    prevWindow: number[]; prevSum: number;
    currentWindow: number[]; currentSum: number;
}

// highest / lowest / linreg / change — window + call count, no running sum.
interface PtWinCountState {
    lastIdx: number;
    prevWindow: unknown[]; prevCallCount: number;
    currentWindow: unknown[]; currentCallCount: number;
}

// accdist / cum.
interface PtCumState {
    lastIdx: number;
    prevCumulativeSum: number;
    currentCumulativeSum: number;
}

// atr.
interface PtAtrState {
    lastIdx: number;
    prevAtr: number | null; prevInitSum: number; prevInitCount: number;
    currentAtr: number | null; currentInitSum: number; currentInitCount: number;
}

// barssince.
interface PtBarssinceState {
    lastIdx: number;
    prevLastTrueIndex: number | null;
    currentLastTrueIndex: number | null;
}

// alma.
interface PtAlmaState {
    lastIdx: number;
    prevWindow: number[]; prevCallCount: number;
    currentWindow: number[]; currentCallCount: number;
    weightsKey: string; weights: number[];
}

// cmo.
interface PtCmoState {
    lastIdx: number;
    prevGainsWindow: number[]; prevLossesWindow: number[];
    prevGainsSum: number; prevLossesSum: number; prevLength: number | undefined;
    currentGainsWindow: number[]; currentLossesWindow: number[];
    currentGainsSum: number; currentLossesSum: number; currentLength: number | undefined;
}

// dmi.
interface PtDmiState {
    lastIdx: number;
    prevTrInitSum: number; prevPlusInitSum: number; prevMinusInitSum: number; prevInitCount: number;
    prevSmoothedTR: number; prevSmoothedPlus: number; prevSmoothedMinus: number;
    prevDxInitSum: number; prevAdxInitCount: number; prevADX: number;
    currentTrInitSum: number; currentPlusInitSum: number; currentMinusInitSum: number; currentInitCount: number;
    currentSmoothedTR: number; currentSmoothedPlus: number; currentSmoothedMinus: number;
    currentDxInitSum: number; currentAdxInitCount: number; currentADX: number;
}

// ema.
interface PtEmaState {
    lastIdx: number;
    prevEma: number | null; prevInitSum: number; prevInitCount: number;
    currentEma: number | null; currentInitSum: number; currentInitCount: number;
}

// kc / kcw inner EMA cell + outer state.
interface PtEmaCell { prevEma: number | null; initSum: number; initCount: number }
interface PtKcState {
    lastIdx: number;
    basisState: PtEmaCell; rangeState: PtEmaCell;
    currentBasisState: PtEmaCell; currentRangeState: PtEmaCell;
}

// ── Inlined upstream utils (do not exist on the facade) ──────────────────────

// Source: pinets-src/src/namespaces/ta/utils/nonNaWindow.ts:3 — upstream `isNa`
// covers null/undefined/NaN (4 call sites in the helpers below).
const isNa = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

// Source: pinets-src/src/namespaces/ta/utils/naAware.ts:13-25 — verbatim;
// generic so each helper's carried shape stays typed.
interface PtBarState<T> {
    lastIdx: number; shared: boolean;
    prev: T; current: T;
}
function barState<T extends { callIdx: number }>(context: PineTsCtx, key: string | undefined, init: () => T): PtBarState<T> | undefined {
    if (!key) return undefined;
    if (!context.taState) context.taState = {};
    let state = context.taState[key] as PtBarState<T> | undefined;
    if (!state) state = context.taState[key] = { lastIdx: -1, shared: false, prev: init(), current: init() };
    if (context.idx > state.lastIdx) {
        if (state.lastIdx >= 0) state.prev = { ...state.current };
        state.lastIdx = context.idx;
    } else if (state.current.callIdx === context.idx) {
        state.shared = true;
    }
    return state.shared ? undefined : state;
}

// Mirror of builtins/ta.ts constNum for the PtSeries side: the interpreter
// wraps scalar literals as constant series, so `ta.highest(4)` arrives as a
// const-series in the `source` slot, not a bare scalar like upstream expects.
// Scans back until the pre-start sentinel; na entries are gaps, not variance
// (same rule as constSeriesNum). Returns the constant value or undefined.
function ptConstNum(context: PineTsCtx, s: Series): number | undefined {
    let v: number | undefined;
    for (let k = 0; k <= context.idx; k++) {
        const h = s.get(k);
        if (isNa(h)) continue;
        if (typeof h !== 'number' || (v !== undefined && h !== v)) return undefined;
        v = h;
    }
    return v;
}

// Source: pinets-src/src/namespaces/ta/utils/naAware.ts:35-57 — verbatim.
function consecutiveMoves(context: PineTsCtx, key: string | undefined, series: Series, length: number, up: boolean): boolean {
    const moved = (a: number, b: number) => (up ? a > b : a < b);
    const state = barState(context, key, () => ({ count: 0, callIdx: -1, length: NaN }));

    let count: number;
    if (state && state.prev.callIdx === context.idx - 1 && state.prev.length === length) {
        const a = series.get(0) as number;
        const b = series.get(1) as number;
        count = isNa(a) || isNa(b) ? state.prev.count : moved(a, b) ? state.prev.count + 1 : 0;
    } else {
        count = 0;
        for (let j = 0; j < context.idx && count < length; j++) {
            const a = series.get(j) as number;
            const b = series.get(j + 1) as number;
            if (isNa(a) || isNa(b)) continue;
            if (!moved(a, b)) break;
            count++;
        }
    }

    if (state) state.current = { count, callIdx: context.idx, length };
    return count >= length;
}

// Source: pinets-src/src/namespaces/ta/utils/naAware.ts:67-94 — verbatim.
function crossPair(context: PineTsCtx, key: string | undefined, s1: Series, s2: Series): [number, number, number, number] {
    const a0 = s1.get(0) as number;
    const b0 = s2.get(0) as number;
    const state = barState(context, key, () => ({ a: NaN, b: NaN, callIdx: -1 }));

    let a1 = NaN;
    let b1 = NaN;
    if (state && state.prev.callIdx === context.idx - 1) {
        a1 = state.prev.a;
        b1 = state.prev.b;
    } else {
        for (let k = 1; k <= context.idx; k++) {
            const a = s1.get(k) as number;
            const b = s2.get(k) as number;
            if (!isNa(a) && !isNa(b)) {
                a1 = a;
                b1 = b;
                break;
            }
        }
    }

    if (state) {
        const valid = !isNa(a0) && !isNa(b0);
        state.current = { a: valid ? a0 : a1, b: valid ? b0 : b1, callIdx: context.idx };
    }
    return [a0, b0, a1, b1];
}

// ── Ported methods ──────────────────────────────────────────────────────────

// Source: pinets-src/src/namespaces/ta/methods/accdist.ts:11-58 (verbatim body).
function ptAccdist(context: PineTsCtx) {
    return (_callId?: string) => {
        if (!context.taState) context.taState = {};
        const stateKey = _callId || 'accdist';

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevCumulativeSum: 0,
                // Tentative state
                currentCumulativeSum: 0,
            };
        }

        const state = context.taState[stateKey] as PtCumState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevCumulativeSum = state.currentCumulativeSum;
            }
            state.lastIdx = context.idx;
        }

        const close = context.get(context.data.close, 0) as number;
        const high = context.get(context.data.high, 0) as number;
        const low = context.get(context.data.low, 0) as number;
        const volume = context.get(context.data.volume, 0) as number;

        if (isNaN(close) || isNaN(high) || isNaN(low) || isNaN(volume)) {
            state.currentCumulativeSum = state.prevCumulativeSum;
            return context.precision(state.prevCumulativeSum);
        }

        const range = high - low;
        let term = 0;

        if (range !== 0) {
            term = ((close - low) - (high - close)) / range * volume;
        }

        const currentSum = state.prevCumulativeSum + term;
        state.currentCumulativeSum = currentSum;

        return context.precision(currentSum);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/alma.ts:23-127 (verbatim body;
// `floor` arrives through the positional `rest` channel like upstream).
function ptAlma(context: PineTsCtx) {
    return (source: unknown, _period: unknown, _offset: unknown, _sigma: unknown, ...rest: unknown[]) => {
        // The transpiler appends the call id after the optional `floor` argument.
        const _callId: string | undefined = typeof rest[rest.length - 1] === 'string' ? rest.pop() as string : undefined;
        const period = Series.from(_period).get(0) as number;
        const offset = Series.from(_offset).get(0) as number;
        const sigma = Series.from(_sigma).get(0) as number;
        const floor = rest.length > 0 && !!Series.from(rest[0]).get(0);

        // Incremental ALMA calculation using rolling window
        if (!context.taState) context.taState = {};
        const stateKey = _callId || `alma_${period}_${offset}_${sigma}_${floor}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevWindow: [],
                prevCallCount: 0,
                // Tentative state (working window)
                currentWindow: [],
                currentCallCount: 0,
                // Weights for `weightsKey`; a series length recomputes them
                weightsKey: '',
                weights: [],
            };
        }

        const state = context.taState[stateKey] as PtAlmaState;

        const weightsKey = `${period}_${offset}_${sigma}_${floor}`;
        if (state.weightsKey !== weightsKey) {
            const m = floor ? Math.floor(offset * (period - 1)) : offset * (period - 1);
            const s = period / sigma;
            const weights = [];
            let weightSum = 0;

            for (let i = 0; i < period; i++) {
                const weight = Math.exp(-Math.pow(i - m, 2) / (2 * s * s));
                weights.push(weight);
                weightSum += weight;
            }

            // Normalize weights
            for (let i = 0; i < weights.length; i++) {
                weights[i]! /= weightSum;
            }
            state.weights = weights;
            state.weightsKey = weightsKey;
        }

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                // Commit the tentative window to prevWindow
                state.prevWindow = [...state.currentWindow];
                state.prevCallCount = state.currentCallCount;
            }
            state.lastIdx = context.idx;
        }

        const currentValue = Series.from(source).get(0) as number;

        // Start with the committed window
        const window = [...state.prevWindow];

        // Add current value to window (most recent at front)
        window.unshift(currentValue);

        while (window.length > period) {
            window.pop();
        }

        // Track actual call count for callsite-correct backfill
        const callCount = state.prevCallCount + 1;
        if (window.length < period && (callCount >= period || context.idx >= period - 1)) {
            const series = Series.from(source);
            while (window.length < period) {
                window.push(series.get(window.length) as number);
            }
        }

        // Update tentative state
        state.currentWindow = window;
        state.currentCallCount = callCount;

        if (window.length < period) {
            // Not enough data yet
            return NaN;
        }

        // Calculate weighted average
        // Window is [newest, ..., oldest], but weights are indexed [oldest, ..., newest]
        // So we need to apply weights in reverse order
        let alma = 0;
        for (let i = 0; i < period; i++) {
            // weights[0] = oldest, weights[period-1] = newest
            // window[0] = newest, window[period-1] = oldest
            // So weights[i] should multiply window[period-1-i]
            alma += state.weights[i]! * window[period - 1 - i]!;
        }

        return context.precision(alma);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/atr.ts:5-94 (verbatim body).
function ptAtr(context: PineTsCtx) {
    return (_period: unknown, _callId?: string) => {
        const period = Series.from(_period).get(0) as number;

        // Incremental ATR calculation
        if (!context.taState) context.taState = {};
        const stateKey = _callId || `atr_${period}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevAtr: null,
                prevInitSum: 0,
                prevInitCount: 0,
                // Tentative state
                currentAtr: null,
                currentInitSum: 0,
                currentInitCount: 0,
            };
        }

        const state = context.taState[stateKey] as PtAtrState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevAtr = state.currentAtr;
                state.prevInitSum = state.currentInitSum;
                state.prevInitCount = state.currentInitCount;
            }
            state.lastIdx = context.idx;
        }

        const high = context.get(context.data.high, 0) as number;
        const low = context.get(context.data.low, 0) as number;
        const close = context.get(context.data.close, 0) as number;

        // Fix: Handle NaN inputs
        if (isNaN(high) || isNaN(low) || isNaN(close)) {
            return NaN;
        }

        // Read previous close directly from context data — always correct
        // regardless of whether ATR was called on previous bars.
        // This fixes the stale-prevClose bug when ATR is called conditionally.
        const prevClose: number | null = context.idx > 0 ? context.get(context.data.close, 1) as number : null;

        // Calculate True Range
        let tr;
        if (prevClose !== null && !isNaN(prevClose)) {
            const hl = high - low;
            const hc = Math.abs(high - prevClose);
            const lc = Math.abs(low - prevClose);
            tr = Math.max(hl, hc, lc);
        } else {
            tr = high - low;
        }

        let initCount = state.prevInitCount;
        let initSum = state.prevInitSum;
        // `?? NaN` — unreachable null (initCount >= period implies prevAtr set)
        let prevAtr = state.prevAtr ?? NaN;

        if (initCount < period) {
            // Accumulate TR for SMA initialization
            initSum += tr;
            initCount++;

            // Store tentative state
            state.currentInitSum = initSum;
            state.currentInitCount = initCount;

            if (initCount === period) {
                const atr = initSum / period;
                state.currentAtr = atr;
                return context.precision(atr);
            }
            return NaN;
        }

        // Calculate ATR using RMA formula
        const atr = (prevAtr * (period - 1) + tr) / period;

        // Store tentative result
        state.currentAtr = atr;

        return context.precision(atr);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/barssince.ts:10-52 (verbatim body).
function ptBarssince(context: PineTsCtx) {
    return (condition: unknown, _callId?: string) => {
        if (!context.taState) context.taState = {};
        const stateKey = _callId || 'barssince';

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevLastTrueIndex: null,
                // Tentative state
                currentLastTrueIndex: null,
            };
        }
        const state = context.taState[stateKey] as PtBarssinceState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevLastTrueIndex = state.currentLastTrueIndex;
            }
            state.lastIdx = context.idx;
        }

        const cond = Series.from(condition).get(0);

        // Use committed previous last true index as base
        let lastTrueIndex: number | null = state.prevLastTrueIndex;

        if (cond) {
            lastTrueIndex = context.idx;
        }

        // Update tentative state
        state.currentLastTrueIndex = lastTrueIndex;

        if (lastTrueIndex === null) {
            return NaN;
        }

        return context.idx - lastTrueIndex;
    };
}

// Source: pinets-src/src/namespaces/ta/methods/bb.ts:21-113 (verbatim body;
// returns [middle, upper, lower] like the existing builtin).
function ptBb(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _mult: unknown, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const mult = Series.from(_mult).get(0) as number;

        // Use incremental calculation with rolling window
        if (!context.taState) context.taState = {};
        const stateKey = _callId || `bb_${length}_${mult}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevWindow: [],
                prevSum: 0,
                // Tentative state
                currentWindow: [],
                currentSum: 0,
            };
        }

        const state = context.taState[stateKey] as PtWinSumState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevWindow = [...state.currentWindow];
                state.prevSum = state.currentSum;
            }
            state.lastIdx = context.idx;
        }

        const currentValue = Series.from(source).get(0) as number;

        // Handle NaN input
        if (isNaN(currentValue)) {
            state.currentWindow = [...state.prevWindow];
            state.currentSum = state.prevSum;
            return [[NaN, NaN, NaN]];
        }

        // Use committed state to calculate current state
        const window = [...state.prevWindow];
        let sum = state.prevSum;

        // Add current value to window
        window.unshift(currentValue);
        sum += currentValue;

        // Remove oldest value if window exceeds length
        while (window.length > length) {
            const oldValue = window.pop()!;
            sum -= oldValue;
        }

        // Backfill from source if window is undersized (dynamic length recovery)
        // Break on NaN since this function intentionally excludes NaN from the window
        if (window.length < length && context.idx >= length - 1) {
            const series = Series.from(source);
            while (window.length < length) {
                const val = series.get(window.length) as number;
                if (isNaN(val)) break;
                window.push(val);
                sum += val;
            }
        }

        // Update tentative state
        state.currentWindow = window;
        state.currentSum = sum;

        // Not enough data yet
        if (window.length < length) {
            return [[NaN, NaN, NaN]];
        }

        // Calculate middle band (SMA)
        const middle = sum / length;

        // Calculate standard deviation
        let sumSquaredDiff = 0;
        for (let i = 0; i < length; i++) {
            sumSquaredDiff += Math.pow(window[i]! - middle, 2);
        }
        const stdev = Math.sqrt(sumSquaredDiff / length);

        // Calculate upper and lower bands
        const upper = middle + mult * stdev;
        const lower = middle - mult * stdev;

        // Return as tuple with double brackets
        return [[context.precision(middle), context.precision(upper), context.precision(lower)]];
    };
}

// Source: pinets-src/src/namespaces/ta/methods/bbw.ts:13-100 (verbatim body;
// pinets multiplies the width by 100 where the existing builtin returns the
// raw fraction — a documented divergence covered by the tier test).
function ptBbw(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _mult: unknown, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const mult = Series.from(_mult).get(0) as number;

        if (!context.taState) context.taState = {};
        const stateKey = _callId || `bbw_${length}_${mult}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevWindow: [],
                prevSum: 0,
                // Tentative state
                currentWindow: [],
                currentSum: 0,
            };
        }

        const state = context.taState[stateKey] as PtWinSumState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevWindow = [...state.currentWindow];
                state.prevSum = state.currentSum;
            }
            state.lastIdx = context.idx;
        }

        const currentValue = Series.from(source).get(0) as number;

        if (isNaN(currentValue)) {
            state.currentWindow = [...state.prevWindow];
            state.currentSum = state.prevSum;
            return NaN;
        }

        const window = [...state.prevWindow];
        let sum = state.prevSum;

        window.unshift(currentValue);
        sum += currentValue;

        while (window.length > length) {
            const removed = window.pop()!;
            sum -= removed;
        }

        // Backfill from source if window is undersized (dynamic length recovery)
        // Break on NaN since this function intentionally excludes NaN from the window
        if (window.length < length && context.idx >= length - 1) {
            const series = Series.from(source);
            while (window.length < length) {
                const val = series.get(window.length) as number;
                if (isNaN(val)) break;
                window.push(val);
                sum += val;
            }
        }

        state.currentWindow = window;
        state.currentSum = sum;

        if (window.length < length) {
            return NaN;
        }

        const basis = sum / length;

        let sumSqDiff = 0;
        for (let i = 0; i < length; i++) {
            const diff = window[i]! - basis;
            sumSqDiff += diff * diff;
        }
        const variance = sumSqDiff / length;
        const stdev = Math.sqrt(variance);

        const dev = mult * stdev;

        if (basis === 0) {
            return context.precision(0);
        }

        const bbw = ((2 * dev) / basis) * 100;
        return context.precision(bbw);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/cci.ts:24-117 (verbatim body;
// flat window → 0 where the existing builtin returns na — documented).
function ptCci(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;

        // Use incremental calculation with rolling window
        if (!context.taState) context.taState = {};
        const stateKey = _callId || `cci_${length}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevWindow: [],
                prevSum: 0,
                prevCallCount: 0,
                // Tentative state
                currentWindow: [],
                currentSum: 0,
                currentCallCount: 0,
            };
        }

        const state = context.taState[stateKey] as PtWinSumCountState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevWindow = [...state.currentWindow];
                state.prevSum = state.currentSum;
                state.prevCallCount = state.currentCallCount;
            }
            state.lastIdx = context.idx;
        }

        const currentValue = Series.from(source).get(0) as number;

        // Use committed state
        const window = [...state.prevWindow];
        let sum = state.prevSum;

        // The window keeps na values (TradingView's cci, through ta.dev, is na while one is inside
        // it); they add 0 to the running sum. (upstream local, 4 call sites)
        const num = (v: unknown): number => (v === null || v === undefined || Number.isNaN(v as number) ? 0 : v as number);
        window.unshift(currentValue);
        sum += num(currentValue);

        // Remove oldest value if window exceeds length
        while (window.length > length) {
            const oldValue = window.pop();
            sum -= num(oldValue);
        }

        // Track actual call count for callsite-correct backfill
        const callCount = state.prevCallCount + 1;
        if (window.length < length && (callCount >= length || context.idx >= length - 1)) {
            const series = Series.from(source);
            while (window.length < length) {
                const val = series.get(window.length);
                if (isNaN(val as number)) break;
                window.push(val);
                sum += val as number;
            }
        }

        // Update tentative state
        state.currentWindow = window;
        state.currentSum = sum;
        state.currentCallCount = callCount;

        // Not enough data yet
        if (window.length < length || window.some((v) => v === null || v === undefined || Number.isNaN(v as number))) {
            return NaN;
        }

        // Calculate SMA (mean)
        const sma = sum / length;

        // Calculate Mean Deviation
        let sumAbsoluteDeviations = 0;
        for (let i = 0; i < length; i++) {
            sumAbsoluteDeviations += Math.abs((window[i] as number) - sma);
        }
        const meanDeviation = sumAbsoluteDeviations / length;

        // Avoid division by zero
        if (meanDeviation === 0) {
            return 0;
        }

        // Calculate CCI
        const cci = (currentValue - sma) / (0.015 * meanDeviation);

        return context.precision(cci);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/change.ts:5-73 (verbatim body +
// `_length === undefined → 1` guard: the shim binds omitted args as undefined
// where upstream's transpiler would land the call id in the length slot).
function ptChange(context: PineTsCtx) {
    return (source: unknown, _length: unknown = 1, _callId?: string) => {
        //handle the case where ta.change is called with the source only,
        // in that case the transpiler will inject the callId as a second parameter
        // so we need to extract the callId and set the length to 1
        if (typeof _length === 'string') {
            _callId = _length;
            _length = 1;
        }
        if (_length === undefined) _length = 1; // shim: omitted arg binds undefined
        const length = Series.from(_length).get(0) as number;

        // Simple lookback - store window
        if (!context.taState) context.taState = {};
        const stateKey = _callId || `change_${length}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevWindow: [],
                prevCallCount: 0,
                // Tentative state
                currentWindow: [],
                currentCallCount: 0,
            };
        }

        const state = context.taState[stateKey] as PtWinCountState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevWindow = [...state.currentWindow];
                state.prevCallCount = state.currentCallCount;
            }
            state.lastIdx = context.idx;
        }

        const currentValue = Series.from(source).get(0) as number;

        // Use committed state as base
        const window = [...state.prevWindow];

        window.unshift(currentValue);

        while (window.length > length + 1) {
            window.pop();
        }

        // Track actual call count for callsite-correct backfill
        const callCount = state.prevCallCount + 1;
        if (window.length < length + 1 && (callCount >= length + 1 || context.idx >= length)) {
            const series = Series.from(source);
            while (window.length < length + 1) {
                window.push(series.get(window.length));
            }
        }

        // Update tentative state
        state.currentWindow = window;
        state.currentCallCount = callCount;

        if (window.length <= length) {
            return NaN;
        }

        const change = currentValue - (window[length] as number);
        return context.precision(change);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/cmo.ts:21-152 (verbatim body).
function ptCmo(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;

        if (!context.taState) context.taState = {};
        const stateKey = _callId || `cmo_${length}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevGainsWindow: [],
                prevLossesWindow: [],
                prevGainsSum: 0,
                prevLossesSum: 0,
                prevLength: undefined,
                // Tentative state
                currentGainsWindow: [],
                currentLossesWindow: [],
                currentGainsSum: 0,
                currentLossesSum: 0,
                currentLength: undefined,
            };
        }

        const state = context.taState[stateKey] as PtCmoState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevGainsWindow = [...state.currentGainsWindow];
                state.prevLossesWindow = [...state.currentLossesWindow];
                state.prevGainsSum = state.currentGainsSum;
                state.prevLossesSum = state.currentLossesSum;
                state.prevLength = state.currentLength;
            }
            state.lastIdx = context.idx;
        }

        // Get current and previous values
        const currentValue = Series.from(source).get(0) as number;
        const previousValue = Series.from(source).get(1) as number;

        // Handle NaN inputs
        if (isNaN(currentValue) || isNaN(previousValue)) {
            // Can't calculate mom, so can't update properly. Return NaN.
            return NaN;
        }

        // Calculate momentum (change)
        const mom = currentValue - previousValue;

        // Calculate gains and losses
        const gain = mom >= 0 ? mom : 0;
        const loss = mom >= 0 ? 0 : -mom;

        let gainsWindow: number[];
        let lossesWindow: number[];
        let gainsSum: number;
        let lossesSum: number;

        if (state.prevLength !== undefined && state.prevLength !== length) {
            // A series length changed: rebuild the windows from the source history
            gainsWindow = [];
            lossesWindow = [];
            gainsSum = 0;
            lossesSum = 0;
            const series = Series.from(source);
            for (let i = 0; i < length; i++) {
                const m = (series.get(i) as number) - (series.get(i + 1) as number);
                if (isNaN(m)) break;
                gainsWindow.push(m >= 0 ? m : 0);
                lossesWindow.push(m >= 0 ? 0 : -m);
                gainsSum += gainsWindow[i]!;
                lossesSum += lossesWindow[i]!;
            }
        } else {
            // Use committed state
            gainsWindow = [...state.prevGainsWindow];
            lossesWindow = [...state.prevLossesWindow];
            gainsSum = state.prevGainsSum;
            lossesSum = state.prevLossesSum;

            // Add to windows
            gainsWindow.unshift(gain);
            lossesWindow.unshift(loss);
            gainsSum += gain;
            lossesSum += loss;
        }
        state.currentLength = length;

        // Not enough data yet
        if (gainsWindow.length < length) {
            state.currentGainsWindow = gainsWindow;
            state.currentLossesWindow = lossesWindow;
            state.currentGainsSum = gainsSum;
            state.currentLossesSum = lossesSum;
            return NaN;
        }

        // Remove oldest values if window exceeds length
        if (gainsWindow.length > length) {
            const oldGain = gainsWindow.pop()!;
            const oldLoss = lossesWindow.pop()!;
            gainsSum -= oldGain;
            lossesSum -= oldLoss;
        }

        // Update tentative state
        state.currentGainsWindow = gainsWindow;
        state.currentLossesWindow = lossesWindow;
        state.currentGainsSum = gainsSum;
        state.currentLossesSum = lossesSum;

        // Calculate CMO
        const denominator = gainsSum + lossesSum;

        if (denominator === 0) {
            return context.precision(0);
        }

        const cmo = 100 * (gainsSum - lossesSum) / denominator;

        return context.precision(cmo);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/cross.ts:20-38 (verbatim body).
function ptCross(context: PineTsCtx) {
    return (source1: unknown, source2: unknown, _callId?: string) => {
        // The previous values come from the most recent earlier bar where both were non-na.
        const [current1, current2, prev1, prev2] = crossPair(context, _callId, Series.from(source1), Series.from(source2));

        // If any value is NaN, return false
        if (isNaN(current1) || isNaN(current2) || isNaN(prev1) || isNaN(prev2)) {
            return false;
        }

        // Check if series1 crossed above series2 (crossover)
        const crossedOver = current1 > current2 && prev1 <= prev2;

        // Check if series1 crossed below series2 (crossunder)
        const crossedUnder = current1 < current2 && prev1 >= prev2;

        return crossedOver || crossedUnder;
    };
}

// Source: pinets-src/src/namespaces/ta/methods/crossover.ts:6-13 (verbatim body).
function ptCrossover(context: PineTsCtx) {
    return (source1: unknown, source2: unknown, _callId?: string) => {
        // The previous values come from the most recent earlier bar where both were non-na
        // (TradingView: previous at or below, current strictly above).
        const [current1, current2, prev1, prev2] = crossPair(context, _callId, Series.from(source1), Series.from(source2));
        return prev1 <= prev2 && current1 > current2;
    };
}

// Source: pinets-src/src/namespaces/ta/methods/crossunder.ts:6-13 (verbatim body).
function ptCrossunder(context: PineTsCtx) {
    return (source1: unknown, source2: unknown, _callId?: string) => {
        // The previous values come from the most recent earlier bar where both were non-na
        // (TradingView: previous at or above, current strictly below).
        const [current1, current2, prev1, prev2] = crossPair(context, _callId, Series.from(source1), Series.from(source2));
        return prev1 >= prev2 && current1 < current2;
    };
}

// Source: pinets-src/src/namespaces/ta/methods/cum.ts:18-59 (verbatim body).
function ptCum(context: PineTsCtx) {
    return (source: unknown, _callId?: string) => {
        // Initialize state for cumulative calculation
        if (!context.taState) context.taState = {};
        const stateKey = _callId || 'cum';

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevCumulativeSum: 0,
                // Tentative state
                currentCumulativeSum: 0,
            };
        }

        const state = context.taState[stateKey] as PtCumState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevCumulativeSum = state.currentCumulativeSum;
            }
            state.lastIdx = context.idx;
        }

        const currentValue = Series.from(source).get(0) as number;

        // An na bar returns na and adds nothing (TradingView), so bars before the first value are na too.
        if (isNaN(currentValue)) {
            state.currentCumulativeSum = state.prevCumulativeSum;
            return NaN;
        }

        // Add current value to committed cumulative sum
        const currentSum = state.prevCumulativeSum + currentValue;

        // Update tentative state
        state.currentCumulativeSum = currentSum;

        return context.precision(currentSum);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/dev.ts:5-82 (verbatim body).
function ptDev(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;

        // Mean Absolute Deviation
        if (!context.taState) context.taState = {};
        const stateKey = _callId || `dev_${length}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevWindow: [],
                prevSum: 0,
                prevCallCount: 0,
                // Tentative state
                currentWindow: [],
                currentSum: 0,
                currentCallCount: 0,
            };
        }

        const state = context.taState[stateKey] as PtWinSumCountState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevWindow = [...state.currentWindow];
                state.prevSum = state.currentSum;
                state.prevCallCount = state.currentCallCount;
            }
            state.lastIdx = context.idx;
        }

        const currentValue = Series.from(source).get(0) as number;

        const window = [...state.prevWindow];
        let sum = state.prevSum;

        // The window keeps na values (TradingView's dev is na while one is inside it); they add 0
        // to the running sum. (upstream local, 4 call sites)
        const num = (v: unknown): number => (v === null || v === undefined || Number.isNaN(v as number) ? 0 : v as number);
        window.unshift(currentValue);
        sum += num(currentValue);

        while (window.length > length) {
            const oldValue = window.pop();
            sum -= num(oldValue);
        }

        // Track actual call count for callsite-correct backfill
        const callCount = state.prevCallCount + 1;
        if (window.length < length && (callCount >= length || context.idx >= length - 1)) {
            const series = Series.from(source);
            while (window.length < length) {
                const val = series.get(window.length);
                window.push(val);
                sum += num(val);
            }
        }

        state.currentWindow = window;
        state.currentSum = sum;
        state.currentCallCount = callCount;

        if (window.length < length || window.some((v) => v === null || v === undefined || Number.isNaN(v as number))) {
            return NaN;
        }

        const mean = sum / length;
        let sumDeviation = 0;
        for (let i = 0; i < length; i++) {
            sumDeviation += Math.abs((window[i] as number) - mean);
        }

        const dev = sumDeviation / length;
        return context.precision(dev);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/dmi.ts:28-203 (verbatim body).
function ptDmi(context: PineTsCtx) {
    return (_diLength: unknown, _adxSmoothing: unknown, _callId?: string) => {
        const diLength = Series.from(_diLength).get(0) as number;
        const adxSmoothing = Series.from(_adxSmoothing).get(0) as number;

        if (!context.taState) context.taState = {};
        const stateKey = _callId || `dmi_${diLength}_${adxSmoothing}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,

                // Committed state
                // (prevHigh/prevLow/prevClose removed — read directly from context)

                // RMA states for TR, +DM, -DM
                prevTrInitSum: 0,
                prevPlusInitSum: 0,
                prevMinusInitSum: 0,
                prevInitCount: 0,

                prevSmoothedTR: NaN,
                prevSmoothedPlus: NaN,
                prevSmoothedMinus: NaN,

                // RMA state for ADX
                prevDxInitSum: 0,
                prevAdxInitCount: 0,
                prevADX: NaN,

                // Tentative state (current)
                currentTrInitSum: 0,
                currentPlusInitSum: 0,
                currentMinusInitSum: 0,
                currentInitCount: 0,

                currentSmoothedTR: NaN,
                currentSmoothedPlus: NaN,
                currentSmoothedMinus: NaN,

                currentDxInitSum: 0,
                currentAdxInitCount: 0,
                currentADX: NaN,
            };
        }

        const state = context.taState[stateKey] as PtDmiState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevTrInitSum = state.currentTrInitSum;
                state.prevPlusInitSum = state.currentPlusInitSum;
                state.prevMinusInitSum = state.currentMinusInitSum;
                state.prevInitCount = state.currentInitCount;

                state.prevSmoothedTR = state.currentSmoothedTR;
                state.prevSmoothedPlus = state.currentSmoothedPlus;
                state.prevSmoothedMinus = state.currentSmoothedMinus;

                state.prevDxInitSum = state.currentDxInitSum;
                state.prevAdxInitCount = state.currentAdxInitCount;
                state.prevADX = state.currentADX;
            }
            state.lastIdx = context.idx;
        }

        const high = context.get(context.data.high, 0) as number;
        const low = context.get(context.data.low, 0) as number;
        const close = context.get(context.data.close, 0) as number;

        if (isNaN(high) || isNaN(low) || isNaN(close)) {
            return [[NaN, NaN, NaN]];
        }

        // Read previous bar's OHLC directly from context data — always correct
        // regardless of whether DMI was called on previous bars.
        // This fixes the stale-prevClose bug when DMI is called conditionally.
        const prevHigh = context.idx > 0 ? context.get(context.data.high, 1) as number : NaN;
        const prevLow = context.idx > 0 ? context.get(context.data.low, 1) as number : NaN;
        const prevClose = context.idx > 0 ? context.get(context.data.close, 1) as number : NaN;

        if (isNaN(prevHigh)) {
            // First bar — no previous data
            return [[NaN, NaN, NaN]];
        }

        // Calculate TR
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));

        // Calculate Directional Movement
        const up = high - prevHigh;
        const down = prevLow - low;

        const plusDM = (up > down && up > 0) ? up : 0;
        const minusDM = (down > up && down > 0) ? down : 0;

        // --- Calculate Smoothed TR, +DM, -DM (RMA with diLength) ---
        let initCount = state.prevInitCount;
        let trInitSum = state.prevTrInitSum;
        let plusInitSum = state.prevPlusInitSum;
        let minusInitSum = state.prevMinusInitSum;
        let smoothedTR = state.prevSmoothedTR;
        let smoothedPlus = state.prevSmoothedPlus;
        let smoothedMinus = state.prevSmoothedMinus;

        initCount++;

        if (initCount <= diLength) {
            trInitSum += tr;
            plusInitSum += plusDM;
            minusInitSum += minusDM;

            if (initCount === diLength) {
                smoothedTR = trInitSum / diLength;
                smoothedPlus = plusInitSum / diLength;
                smoothedMinus = minusInitSum / diLength;
            }
        } else {
            // Incremental RMA
            const alpha = 1 / diLength;
            smoothedTR = alpha * tr + (1 - alpha) * smoothedTR;
            smoothedPlus = alpha * plusDM + (1 - alpha) * smoothedPlus;
            smoothedMinus = alpha * minusDM + (1 - alpha) * smoothedMinus;
        }

        // Save tentative state
        state.currentInitCount = initCount;
        state.currentTrInitSum = trInitSum;
        state.currentPlusInitSum = plusInitSum;
        state.currentMinusInitSum = minusInitSum;
        state.currentSmoothedTR = smoothedTR;
        state.currentSmoothedPlus = smoothedPlus;
        state.currentSmoothedMinus = smoothedMinus;

        // If not enough data for DI, return NaNs
        if (initCount < diLength) {
            return [[NaN, NaN, NaN]];
        }

        // Calculate DI
        const plusDI = smoothedTR === 0 ? 0 : (100 * smoothedPlus / smoothedTR);
        const minusDI = smoothedTR === 0 ? 0 : (100 * smoothedMinus / smoothedTR);

        // Calculate DX
        const sumDI = plusDI + minusDI;
        const dx = sumDI === 0 ? 0 : (100 * Math.abs(plusDI - minusDI) / sumDI);

        // --- Calculate ADX (RMA of DX with adxSmoothing) ---
        let adxInitCount = state.prevAdxInitCount;
        let dxInitSum = state.prevDxInitSum;
        let prevADX = state.prevADX;
        let adx = NaN;

        adxInitCount++;

        if (adxInitCount <= adxSmoothing) {
            dxInitSum += dx;

            if (adxInitCount === adxSmoothing) {
                prevADX = dxInitSum / adxSmoothing;
                adx = prevADX;
            }
        } else {
            const alphaAdx = 1 / adxSmoothing;
            prevADX = alphaAdx * dx + (1 - alphaAdx) * prevADX;
            adx = prevADX;
        }

        // Save tentative state
        state.currentAdxInitCount = adxInitCount;
        state.currentDxInitSum = dxInitSum;
        state.currentADX = prevADX;

        return [[context.precision(plusDI), context.precision(minusDI), context.precision(adx)]];
    };
}

// Source: pinets-src/src/namespaces/ta/methods/ema.ts:5-78 (verbatim body;
// pinets seeds with the SMA of the first `period` bars while the existing
// builtin recurs from bar 0 — a documented seeding divergence).
function ptEma(context: PineTsCtx) {
    return (source: unknown, _period: unknown, _callId?: string) => {
        const period = Series.from(_period).get(0) as number;

        // Incremental EMA calculation
        if (!context.taState) context.taState = {};
        const stateKey = _callId || `ema_${period}`;

        // Initialize state structure
        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state (from end of lastIdx-1)
                prevEma: null,
                prevInitSum: 0,
                prevInitCount: 0,
                // Tentative state (for current lastIdx)
                currentEma: null,
                currentInitSum: 0,
                currentInitCount: 0,
            };
        }

        const state = context.taState[stateKey] as PtEmaState;

        // Check if we moved to a new bar index
        if (context.idx > state.lastIdx) {
            // Commit the tentative state from the previous bar to be the new "prev" state
            if (state.lastIdx >= 0) {
                state.prevEma = state.currentEma;
                state.prevInitSum = state.currentInitSum;
                state.prevInitCount = state.currentInitCount;
            }
            state.lastIdx = context.idx;
        }

        const currentValue = Series.from(source).get(0) as number;

        if (currentValue === null || currentValue === undefined || isNaN(currentValue)) {
            return NaN;
        }

        // Use 'prev' variables for calculation to ensure stability during live updates
        // We calculate 'current' values but DO NOT overwrite 'prev' values yet
        let initCount = state.prevInitCount;
        let initSum = state.prevInitSum;
        // `?? NaN` — unreachable null (initCount >= period implies prevEma set)
        let prevEma = state.prevEma ?? NaN;

        if (initCount < period) {
            // Accumulate for SMA initialization
            initSum += currentValue;
            initCount++;

            // Store tentative state
            state.currentInitSum = initSum;
            state.currentInitCount = initCount;

            if (initCount === period) {
                const ema = initSum / period;
                state.currentEma = ema;
                return context.precision(ema);
            }
            return NaN;
        }

        // Calculate EMA incrementally: EMA = alpha * current + (1 - alpha) * prevEMA
        const alpha = 2 / (period + 1);
        const ema = currentValue * alpha + prevEma * (1 - alpha);

        // Store tentative result
        state.currentEma = ema;

        return context.precision(ema);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/falling.ts:20-29 (verbatim body;
// consecutiveMoves inlined at top of file).
function ptFalling(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const series = Series.from(source);

        // Consecutive moves as TradingView counts them: a pair touching an na value neither
        // extends nor breaks the run.
        return consecutiveMoves(context, _callId, series, length, false);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/highest.ts:5-90 (verbatim body +
// scalar-source guard: the shim binds `ta.highest(5)` as source=5/length=undef
// where upstream's transpiler would land the call id in the length slot).
function ptHighest(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _callId?: string) => {
        // if the _length is of type string, this is probably the _callId
        // ==> this is a weak approach to determine syntaxes : ta.highest(length) vs ta.highest(source, length)
        if (typeof _length === 'string' && _callId === undefined) {
            _callId = _length
            _length = source
            source = context.data.high;
        }
        if (_length === undefined) { // shim one-arg form: scalar or const-series length over `high`
            const sc = source instanceof Series ? ptConstNum(context, source) : (source as number);
            _length = sc;
            source = context.data.high;
        }

        const length = Series.from(_length).get(0) as number;

        // Rolling maximum
        if (!context.taState) context.taState = {};
        const stateKey = _callId || `highest_${length}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevWindow: [],
                prevCallCount: 0,
                // Tentative state
                currentWindow: [],
                currentCallCount: 0,
            };
        }

        const state = context.taState[stateKey] as PtWinCountState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevWindow = [...state.currentWindow];
                state.prevCallCount = state.currentCallCount;
            }
            state.lastIdx = context.idx;
        }

        const currentValue = Series.from(source).get(0);

        // Use committed state
        const window = [...state.prevWindow];

        window.unshift(currentValue);

        while (window.length > length) {
            window.pop();
        }

        // Track actual call count for callsite-correct backfill
        const callCount = state.prevCallCount + 1;

        // Backfill from source series when the window is undersized.
        // Use both callCount (for top-level calls) and context.idx
        // (for conditional blocks where callCount < length but enough
        // chart bars exist to look back through the source series).
        if (window.length < length && (callCount >= length || context.idx >= length - 1)) {
            const series = Series.from(source);
            while (window.length < length) {
                window.push(series.get(window.length));
            }
        }

        // Update tentative state
        state.currentWindow = window;
        state.currentCallCount = callCount;

        if (window.length < length) {
            return NaN;
        }

        // TradingView resets the window at na: only the bars since the most recent na
        // take part (the window is newest → oldest, so that is the prefix before the
        // first na), and an na on the current bar yields na
        // (tests/namespaces/ta/na-window-semantics.test.ts).
        const firstNa = window.findIndex((v) => v === undefined || isNaN(v as number));
        const validValues = firstNa === -1 ? window : window.slice(0, firstNa);
        if (validValues.length === 0) {
            return NaN;
        }

        const max = Math.max(...validValues as number[]);
        return context.precision(max);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/highestbars.ts:11-49 (verbatim
// body + the same shim one-arg guard as highest).
function ptHighestbars(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _callId?: string) => {
        // ta.highestbars(length): the call id lands in the length slot
        if (typeof _length === 'string' && _callId === undefined) {
            _callId = _length;
            _length = source;
            source = context.data.high;
        }
        if (_length === undefined) { // shim one-arg form: scalar or const-series length over `high`
            const sc = source instanceof Series ? ptConstNum(context, source) : (source as number);
            _length = sc;
            source = context.data.high;
        }
        const length = Series.from(_length).get(0) as number;
        const series = Series.from(source);

        // Stateless calculation (accesses past data via Series),
        // but result depends on historical data availability.

        if (context.idx < length - 1) {
            return NaN;
        }

        let maxVal = -Infinity;
        let maxOffset = NaN;

        for (let i = 0; i < length; i++) {
            const val = series.get(i) as number;

            // TradingView resets the window at na: only the bars since the most recent
            // na take part, and an na on the current bar yields offset 0
            // (tests/namespaces/ta/na-window-semantics.test.ts).
            if (val === undefined || isNaN(val)) break;

            // `>=` so that, scanning newest → oldest, an older bar with the same value
            // overwrites: TradingView returns the offset of the OLDEST bar among ties.
            if (isNaN(maxOffset) || val >= maxVal) {
                maxVal = val;
                maxOffset = -i;
            }
        }

        return isNaN(maxOffset) ? 0 : maxOffset;
    };
}

// Source: pinets-src/src/namespaces/ta/methods/kc.ts:16-124 (verbatim body;
// pinets seeds both EMAs with SMAs where the existing builtin recurs from
// bar 0 — documented seeding divergence).
function ptKc(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _mult: unknown, _useTrueRange?: unknown, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const mult = Series.from(_mult).get(0) as number;
        let useTrueRange = true;
        if (typeof _useTrueRange === 'string') {
            //this is the _callId passed by the transpiler
            _callId = _useTrueRange;
        } else if (_useTrueRange !== undefined) {
            useTrueRange = Series.from(_useTrueRange).get(0) as boolean;
        }

        // Calculate span
        let span;
        const high = context.get(context.data.high, 0) as number;
        const low = context.get(context.data.low, 0) as number;

        if (useTrueRange) {
            // Calculate TR
            const close1 = context.get(context.data.close, 1) as number;
            if (isNaN(close1)) {
                span = NaN;
            } else {
                span = Math.max(high - low, Math.abs(high - close1), Math.abs(low - close1));
            }
        } else {
            span = high - low;
        }

        const currentValue = Series.from(source).get(0) as number;

        if (!context.taState) context.taState = {};
        const stateKey = _callId || `kc_${length}_${mult}_${useTrueRange}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                basisState: { prevEma: null, initSum: 0, initCount: 0 },
                rangeState: { prevEma: null, initSum: 0, initCount: 0 },
                // Tentative state
                currentBasisState: { prevEma: null, initSum: 0, initCount: 0 },
                currentRangeState: { prevEma: null, initSum: 0, initCount: 0 },
            };
        }

        const state = context.taState[stateKey] as PtKcState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                // Commit tentative states to committed states
                state.basisState = { ...state.currentBasisState };
                state.rangeState = { ...state.currentRangeState };
            }
            state.lastIdx = context.idx;
        }

        // Helper to update EMA state (upstream local; 2 call sites, keeps the
        // committed/tentative split readable as upstream wrote it).
        const updateEma = (committedState: PtEmaCell, tentativeState: PtEmaCell, value: number, period: number): number => {
            if (isNaN(value)) {
                 // Propagate previous state
                 Object.assign(tentativeState, committedState);
                 return tentativeState.prevEma !== null ? tentativeState.prevEma : NaN;
            }

            let initCount = committedState.initCount;
            let initSum = committedState.initSum;
            let prevEma = committedState.prevEma;

            if (initCount < period) {
                initSum += value;
                initCount++;

                tentativeState.initSum = initSum;
                tentativeState.initCount = initCount;
                tentativeState.prevEma = prevEma; // Unchanged until initialized

                if (initCount === period) {
                    const ema = initSum / period;
                    tentativeState.prevEma = ema;
                    return ema;
                }
                return NaN;
            }

            const alpha = 2 / (period + 1);
            // `?? NaN` — unreachable null (initCount >= period implies prevEma set)
            const ema = value * alpha + (prevEma ?? NaN) * (1 - alpha);

            tentativeState.prevEma = ema;
            tentativeState.initSum = initSum;
            tentativeState.initCount = initCount;

            return ema;
        };

        const basis = updateEma(state.basisState, state.currentBasisState, currentValue, length);
        const rangeEma = updateEma(state.rangeState, state.currentRangeState, span, length);

        if (isNaN(basis) || isNaN(rangeEma)) {
            return [[NaN, NaN, NaN]];
        }

        const upper = basis + rangeEma * mult;
        const lower = basis - rangeEma * mult;

        return [[context.precision(basis), context.precision(upper), context.precision(lower)]];
    };
}

// Source: pinets-src/src/namespaces/ta/methods/kcw.ts:15-123 (verbatim body;
// NOTE the name collides with the existing `ta.kcw` builtin which is actually
// TV's kcW (Keltner with WMA basis, tuple) — pinets kcw is the scalar width —
// documented name/semantic mismatch covered by the tier test).
function ptKcw(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _mult: unknown, _useTrueRange?: unknown, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const mult = Series.from(_mult).get(0) as number;

        let useTrueRange = true;
        if (typeof _useTrueRange === 'string') {
            //this is the _callId passed by the transpiler
            _callId = _useTrueRange;
        } else if (_useTrueRange !== undefined) {
            useTrueRange = Series.from(_useTrueRange).get(0) as boolean;
        }

        if (!context.taState) context.taState = {};
        const stateKey = _callId || `kcw_${length}_${mult}_${useTrueRange}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                basisState: { prevEma: null, initSum: 0, initCount: 0 },
                rangeState: { prevEma: null, initSum: 0, initCount: 0 },
                // Tentative state
                currentBasisState: { prevEma: null, initSum: 0, initCount: 0 },
                currentRangeState: { prevEma: null, initSum: 0, initCount: 0 },
            };
        }

        const state = context.taState[stateKey] as PtKcState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.basisState = { ...state.currentBasisState };
                state.rangeState = { ...state.currentRangeState };
            }
            state.lastIdx = context.idx;
        }

        // Helper to update EMA state (upstream local; 2 call sites)
        const updateEma = (committedState: PtEmaCell, tentativeState: PtEmaCell, value: number, period: number): number => {
            if (isNaN(value)) {
                Object.assign(tentativeState, committedState);
                return tentativeState.prevEma !== null ? tentativeState.prevEma : NaN;
            }

            let initCount = committedState.initCount;
            let initSum = committedState.initSum;
            let prevEma = committedState.prevEma;

            if (initCount < period) {
                initSum += value;
                initCount++;

                tentativeState.initSum = initSum;
                tentativeState.initCount = initCount;
                tentativeState.prevEma = prevEma;

                if (initCount === period) {
                    const ema = initSum / period;
                    tentativeState.prevEma = ema;
                    return ema;
                }
                return NaN;
            }

            const alpha = 2 / (period + 1);
            // `?? NaN` — unreachable null (initCount >= period implies prevEma set)
            const ema = value * alpha + (prevEma ?? NaN) * (1 - alpha);

            tentativeState.prevEma = ema;
            tentativeState.initSum = initSum;
            tentativeState.initCount = initCount;

            return ema;
        };

        // Calculate span
        let span;
        const high = context.get(context.data.high, 0) as number;
        const low = context.get(context.data.low, 0) as number;

        if (useTrueRange) {
            // Calculate TR
            const close1 = context.get(context.data.close, 1) as number;
            if (isNaN(close1)) {
                span = NaN;
            } else {
                span = Math.max(high - low, Math.abs(high - close1), Math.abs(low - close1));
            }
        } else {
            span = high - low;
        }

        const currentValue = Series.from(source).get(0) as number;
        const basis = updateEma(state.basisState, state.currentBasisState, currentValue, length);
        const rangeEma = updateEma(state.rangeState, state.currentRangeState, span, length);

        if (isNaN(basis) || isNaN(rangeEma)) {
            return NaN;
        }

        if (basis === 0) {
            return context.precision(0);
        }

        const kcw = (2 * rangeEma * mult) / basis;

        return context.precision(kcw);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/linreg.ts:5-91 (verbatim body).
function ptLinreg(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _offset: unknown, _callId?: string) => {
        const length = Series.from(_length).get(0) as number;
        const offset = Series.from(_offset).get(0) as number;

        // Linear Regression
        if (!context.taState) context.taState = {};
        const stateKey = _callId || `linreg_${length}_${offset}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevWindow: [],
                prevCallCount: 0,
                // Tentative state
                currentWindow: [],
                currentCallCount: 0
            };
        }

        const state = context.taState[stateKey] as PtWinCountState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevWindow = [...state.currentWindow];
                state.prevCallCount = state.currentCallCount;
            }
            state.lastIdx = context.idx;
        }

        const currentValue = Series.from(source).get(0);

        const window = [...state.prevWindow];
        window.unshift(currentValue);

        while (window.length > length) {
            window.pop();
        }

        // Track actual call count for callsite-correct backfill
        const callCount = state.prevCallCount + 1;
        if (window.length < length && (callCount >= length || context.idx >= length - 1)) {
            const series = Series.from(source);
            while (window.length < length) {
                window.push(series.get(window.length));
            }
        }

        state.currentWindow = window;
        state.currentCallCount = callCount;

        if (window.length < length) {
            return NaN;
        }

        let sumX = 0;
        let sumY = 0;
        let sumXY = 0;
        let sumXX = 0;
        const n = length;

        // Calculate regression coefficients
        // window[0] is most recent (x = length - 1), window[length-1] is oldest (x = 0)
        for (let j = 0; j < length; j++) {
            const x = length - 1 - j; // Most recent bar has highest x value
            const y = window[j] as number;
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumXX += x * x;
        }

        const denominator = n * sumXX - sumX * sumX;
        if (denominator === 0) {
            return NaN;
        }

        const slope = (n * sumXY - sumX * sumY) / denominator;
        const intercept = (sumY - slope * sumX) / n;

        // Pine formula: intercept + slope * (length - 1 - offset)
        const linRegValue = intercept + slope * (length - 1 - offset);

        return context.precision(linRegValue);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/lowest.ts:5-89 (verbatim body +
// shim one-arg guard, mirroring highest).
function ptLowest(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _callId?: string) => {
        // if the _length is of type string, this is probably the _callId
        // ==> this is a weak approach to determine syntaxes : ta.low(length) vs ta.low(source, length)
        if (typeof _length === 'string' && _callId === undefined) {
            _callId = _length
            _length = source
            source = context.data.low;
        }
        if (_length === undefined) { // shim one-arg form: scalar or const-series length over `low`
            const sc = source instanceof Series ? ptConstNum(context, source) : (source as number);
            _length = sc;
            source = context.data.low;
        }

        const length = Series.from(_length).get(0) as number;

        // Rolling minimum
        if (!context.taState) context.taState = {};
        const stateKey = _callId || `lowest_${length}`;

        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prevWindow: [],
                prevCallCount: 0,
                // Tentative state
                currentWindow: [],
                currentCallCount: 0,
            };
        }

        const state = context.taState[stateKey] as PtWinCountState;

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) {
                state.prevWindow = [...state.currentWindow];
                state.prevCallCount = state.currentCallCount;
            }
            state.lastIdx = context.idx;
        }

        const currentValue = Series.from(source).get(0);

        // Use committed state
        const window = [...state.prevWindow];

        window.unshift(currentValue);

        while (window.length > length) {
            window.pop();
        }

        // Track actual call count for callsite-correct backfill
        const callCount = state.prevCallCount + 1;

        // Backfill from source series when the window is undersized.
        // Use both callCount (for top-level calls) and context.idx
        // (for conditional blocks where callCount < length but enough
        // chart bars exist to look back through the source series).
        if (window.length < length && (callCount >= length || context.idx >= length - 1)) {
            const series = Series.from(source);
            while (window.length < length) {
                window.push(series.get(window.length));
            }
        }

        // Update tentative state
        state.currentWindow = window;
        state.currentCallCount = callCount;

        if (window.length < length) {
            return NaN;
        }

        // TradingView resets the window at na: only the bars since the most recent na
        // take part (the window is newest → oldest, so that is the prefix before the
        // first na), and an na on the current bar yields na
        // (tests/namespaces/ta/na-window-semantics.test.ts).
        const firstNa = window.findIndex((v) => v === undefined || isNaN(v as number));
        const validValues = firstNa === -1 ? window : window.slice(0, firstNa);
        if (validValues.length === 0) {
            return NaN;
        }
        const min = Math.min(...validValues as number[]);
        return context.precision(min);
    };
}

// Source: pinets-src/src/namespaces/ta/methods/lowestbars.ts:11-48 (verbatim
// body + the same shim one-arg guard as lowest).
function ptLowestbars(context: PineTsCtx) {
    return (source: unknown, _length: unknown, _callId?: string) => {
        // ta.lowestbars(length): the call id lands in the length slot
        if (typeof _length === 'string' && _callId === undefined) {
            _callId = _length;
            _length = source;
            source = context.data.low;
        }
        if (_length === undefined) { // shim one-arg form: scalar or const-series length over `low`
            const sc = source instanceof Series ? ptConstNum(context, source) : (source as number);
            _length = sc;
            source = context.data.low;
        }
        const length = Series.from(_length).get(0) as number;
        const series = Series.from(source);

        // Stateless calculation (accesses past data via Series)

        if (context.idx < length - 1) {
            return NaN;
        }

        let minVal = Infinity;
        let minOffset = NaN;

        for (let i = 0; i < length; i++) {
            const val = series.get(i) as number;

            // TradingView resets the window at na: only the bars since the most recent
            // na take part, and an na on the current bar yields offset 0
            // (tests/namespaces/ta/na-window-semantics.test.ts).
            if (val === undefined || isNaN(val)) break;

            // `<=` so that, scanning newest → oldest, an older bar with the same value
            // overwrites: TradingView returns the offset of the OLDEST bar among ties.
            if (isNaN(minOffset) || val <= minVal) {
                minVal = val;
                minOffset = -i;
            }
        }

        return isNaN(minOffset) ? 0 : minOffset;
    };
}

// ── Slice registration ──────────────────────────────────────────────────────

const SLICE: PtSlice = {
    accdist: { factory: ptAccdist as unknown as PtFactory, order: [] },
    alma: { factory: ptAlma as unknown as PtFactory, order: ['source', 'period', 'offset', 'sigma', 'floor'] },
    atr: { factory: ptAtr as unknown as PtFactory, order: ['length'] },
    barssince: { factory: ptBarssince as unknown as PtFactory, order: ['condition'] },
    bb: { factory: ptBb as unknown as PtFactory, order: ['source', 'length', 'mult'] },
    bbw: { factory: ptBbw as unknown as PtFactory, order: ['source', 'length', 'mult'] },
    cci: { factory: ptCci as unknown as PtFactory, order: ['source', 'length'] },
    change: { factory: ptChange as unknown as PtFactory, order: ['source', 'length'] },
    cmo: { factory: ptCmo as unknown as PtFactory, order: ['source', 'length'] },
    cross: { factory: ptCross as unknown as PtFactory, order: ['source1', 'source2'] },
    crossover: { factory: ptCrossover as unknown as PtFactory, order: ['source1', 'source2'] },
    crossunder: { factory: ptCrossunder as unknown as PtFactory, order: ['source1', 'source2'] },
    cum: { factory: ptCum as unknown as PtFactory, order: ['source'] },
    dev: { factory: ptDev as unknown as PtFactory, order: ['source', 'length'] },
    dmi: { factory: ptDmi as unknown as PtFactory, order: ['diLength', 'adxSmoothing'] },
    ema: { factory: ptEma as unknown as PtFactory, order: ['source', 'length'] },
    falling: { factory: ptFalling as unknown as PtFactory, order: ['source', 'length'] },
    highest: { factory: ptHighest as unknown as PtFactory, order: ['source', 'length'] },
    highestbars: { factory: ptHighestbars as unknown as PtFactory, order: ['source', 'length'] },
    kc: { factory: ptKc as unknown as PtFactory, order: ['source', 'length', 'mult', 'useTrueRange'] },
    kcw: { factory: ptKcw as unknown as PtFactory, order: ['source', 'length', 'mult', 'useTrueRange'] },
    linreg: { factory: ptLinreg as unknown as PtFactory, order: ['source', 'length', 'offset'] },
    lowest: { factory: ptLowest as unknown as PtFactory, order: ['source', 'length'] },
    lowestbars: { factory: ptLowestbars as unknown as PtFactory, order: ['source', 'length'] },
};
registerPtSlice(SLICE);
