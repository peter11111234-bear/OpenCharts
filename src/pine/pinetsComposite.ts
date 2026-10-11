// ── pinets composite tier (B3) — hma / macd / mom / param ────────────────────
// Methods that compose other ta.* functions through `context.pine.ta`, plus the
// `param` scalar-history store. Bodies are verbatim-adapted from pinets-src
// (PineTS, AGPL-3.0-only): `Series` → PtSeries, scalar args unwrapped via
// `Series.from(x).get(0)`, `na` → NaN. Cross-calls (`context.pine.ta.wma` /
// `.ema` / `.change`) resolve at runtime once the sibling slices register —
// makePineTsCtx binds every PORTED entry into facade.pine.ta.
//
// Inlined helper imports from upstream: none (all deps ride context.pine.ta).

import {
  PtSeries as Series,
  registerPtSlice,
  type PineTsCtx,
  type PtFactory,
  type PtSlice,
} from './pinetsShim';

// Source: pinets-src/src/namespaces/ta/methods/hma.ts:5-118 (verbatim body;
// `context` typed as PineTsCtx, state records cast like ptRsi).
function ptHma(context: PineTsCtx) {
  return (source: unknown, _period: unknown, _callId?: string) => {
    const period = Series.from(_period).get(0) as number;

    // Hull Moving Average: HMA = WMA(2*WMA(n/2) - WMA(n), sqrt(n))
    const halfPeriod = Math.floor(period / 2);
    const sqrtPeriod = Math.floor(Math.sqrt(period));

    // Get wma function from context.ta
    const wmaFn = context.pine.ta.wma as (s: unknown, p: unknown, id?: string) => number;

    // Pass derived call IDs to internal WMA calls to avoid state collision
    const wma1 = wmaFn(source, halfPeriod, _callId ? `${_callId}_wma1` : undefined);
    const wma2 = wmaFn(source, period, _callId ? `${_callId}_wma2` : undefined);

    const rawIsNa = isNaN(wma1) || isNaN(wma2);

    // Create synthetic source for final WMA: 2*wma1 - wma2
    // We need to feed this into WMA calculation
    // Store the raw value in a temporary series
    if (!context.taState) context.taState = {};
    const stateKey = _callId || `hma_raw_${period}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        // Committed state
        prevValues: [] as number[],
        // Tentative state
        currentValues: [] as number[],
      };
    }

    const rawState = context.taState[stateKey] as {
      lastIdx: number;
      prevValues: number[];
      currentValues: number[];
    };

    // Commit logic for raw values
    if (context.idx > rawState.lastIdx) {
      if (rawState.lastIdx >= 0) {
        rawState.prevValues = [...rawState.currentValues];
      }
      rawState.lastIdx = context.idx;
    }

    const rawHma = 2 * wma1 - wma2;

    // Use committed values as base
    const values = [...rawState.prevValues];
    values.unshift(rawHma);

    // Keep history manageable (though not strictly necessary for simple series, but helps debugging/memory)
    if (values.length > sqrtPeriod + 1) values.pop();

    rawState.currentValues = values;

    // Apply WMA to the raw HMA values
    const hmaStateKey = _callId ? `${_callId}_hma_final` : `hma_final_${period}`;

    if (!context.taState[hmaStateKey]) {
      context.taState[hmaStateKey] = {
        lastIdx: -1,
        // Committed state
        prevWindow: [] as number[],
        // Tentative state
        currentWindow: [] as number[],
      };
    }

    const state = context.taState[hmaStateKey] as {
      lastIdx: number;
      prevWindow: number[];
      currentWindow: number[];
    };

    // Commit logic for final WMA
    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevWindow = [...state.currentWindow];
      }
      state.lastIdx = context.idx;
    }

    // Use committed window
    const window = [...state.prevWindow];

    // An na bar (source na, so both inner WMAs are na) returns na and weighs the last raw value
    // in its slot, like `ta.wma` on an na source. Before the first raw value nothing is kept.
    if (rawIsNa) {
      if (!window.length) return NaN;
      window.unshift(window[0] as number);
      while (window.length > sqrtPeriod) window.pop();
      state.currentWindow = window;
      return NaN;
    }
    window.unshift(rawHma);

    if (window.length < sqrtPeriod) {
      state.currentWindow = window;
      return NaN;
    }

    while (window.length > sqrtPeriod) {
      window.pop();
    }

    state.currentWindow = window;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < sqrtPeriod; i++) {
      const weight = sqrtPeriod - i;
      numerator += (window[i] as number) * weight;
      denominator += weight;
    }

    const hma = numerator / denominator;
    return context.precision(hma);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/macd.ts:22-69 (verbatim body;
// context.pine.ta.ema bound once to a typed alias instead of three inline
// `any` calls — same function, same call sites).
function ptMacd(context: PineTsCtx) {
  return (source: unknown, _fastLength: unknown, _slowLength: unknown, _signalLength: unknown, _callId?: string) => {
    const fastLength = Series.from(_fastLength).get(0) as number;
    const slowLength = Series.from(_slowLength).get(0) as number;
    const signalLength = Series.from(_signalLength).get(0) as number;

    // Generate unique IDs for internal EMAs
    // If _callId is provided, derive IDs from it.
    // Otherwise, generate a base ID based on parameters (standard behavior),
    // but this might be risky if multiple MACDs have same params.
    // However, the caller (transpiler) typically provides _callId for the main call.

    const baseId = _callId || `macd_${fastLength}_${slowLength}_${signalLength}`;

    const fastEmaId = `${baseId}_fast`;
    const slowEmaId = `${baseId}_slow`;
    const signalEmaId = `${baseId}_signal`;

    const emaFn = context.pine.ta.ema as (s: unknown, p: unknown, id?: string) => number;

    // Calculate Fast and Slow EMAs
    // context.pine.ta.ema returns the current EMA value
    const fastMA = emaFn(source, fastLength, fastEmaId);
    const slowMA = emaFn(source, slowLength, slowEmaId);

    // Calculate MACD Line
    // Handle NaN cases if EMAs are not yet valid
    let macdLine = NaN;
    if (!isNaN(fastMA) && !isNaN(slowMA)) {
      macdLine = fastMA - slowMA;
    }

    // Calculate Signal Line
    // We pass the current macdLine value to the EMA function.
    // The EMA function maintains state (prevEMA), so passing the current scalar is sufficient.
    // We must ensure we don't pass NaN to EMA, as it might corrupt the state (initSum).
    let signalLine = NaN;
    if (!isNaN(macdLine)) {
      signalLine = emaFn(macdLine, signalLength, signalEmaId);
    }

    // Calculate Histogram
    let histLine = NaN;
    if (!isNaN(macdLine) && !isNaN(signalLine)) {
      histLine = macdLine - signalLine;
    }

    return [[context.precision(macdLine), context.precision(signalLine), context.precision(histLine)]];
  };
}

// Source: pinets-src/src/namespaces/ta/methods/mom.ts:5-12 (verbatim body).
function ptMom(context: PineTsCtx) {
  return (source: unknown, _length: unknown, _callId?: string) => {
    const length = Series.from(_length).get(0);

    // Momentum is same as change
    const changeFn = context.pine.ta.change as (s: unknown, l: unknown, id?: string) => unknown;
    return changeFn(source, length, _callId);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/param.ts:5-27 (verbatim body;
// `params` is the facade's named scalar-history store). Returns a PtSeries —
// the builtin wrapper can't express a live series as a Value today, so
// ta.param through the script path yields na; the ported body is exercised
// directly via facade.pine.ta.param in tests (and by upstream-internal
// consumers).
function ptParam(context: PineTsCtx) {
  return (source: unknown, index: unknown, name?: string) => {
    const params = context.params;
    const key = name as string;
    if (source instanceof Series) {
      if (index) {
        return new Series(source.data, source.offset + (index as number));
      }
      return source;
    }

    if (!params[key]) params[key] = [];

    if (Array.isArray(source)) {
      return new Series(source, (index as number) || 0);
    } else {
      if (params[key]!.length === 0) {
        params[key]!.push(source);
      } else {
        params[key]![params[key]!.length - 1] = source;
      }
      return new Series(params[key]!, (index as number) || 0);
    }
  };
}

// ── Slice registration ───────────────────────────────────────────────────────
// `order` = our Pine named-arg names (matches builtins/ta.ts bindArgs orders:
// hma/mom ('source','length'), macd ('source','fastlen','slowlen','siglen')).

const SLICE: PtSlice = {
  hma: { factory: ptHma as unknown as PtFactory, order: ['source', 'length'] },
  macd: { factory: ptMacd as unknown as PtFactory, order: ['source', 'fastlen', 'slowlen', 'siglen'] },
  mom: { factory: ptMom as unknown as PtFactory, order: ['source', 'length'] },
  param: { factory: ptParam as unknown as PtFactory, order: ['source', 'index', 'name'] },
};
registerPtSlice(SLICE);
