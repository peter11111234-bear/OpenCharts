// ── PineTS context facade (B3 spike) ─────────────────────────────────────────
// Lets pinets-src namespace methods run inside our BuiltinCtx without the
// pinets package. Reference source: C:/Users/bear9/pinets-src (PineTS
// v0.11.0-ish, AGPL-3.0-only). Ported method bodies are verbatim-adapted and
// carry `Source:` comments with the upstream file + line range.
//
// NOT wired into builtins/index.ts on purpose — the spike is feasibility
// evidence, not default-on. Tests import registerPortedTa() directly.
//
// Collision semantics (D3 / Step 0): registerBuiltin is a plain Map.set —
// re-registering 'ta.rsi' silently overwrites. registerPortedTa() registers
// the pilots under the SAME names so scripts hit the ported impl, warning once
// per overwritten name. The bare `ta.tr` lazy constant (series form) is NOT
// replaced — only the call-form builtin.

import { NA, type BuiltinCtx, type BuiltinFn, type Value } from './contracts';
import { BUILTINS, registerBuiltin } from './builtins/registry';
import { bindArgs, type RtCtx } from './builtins/util';
import { Series as PineSeries } from './contracts';

// ── Value → raw JS scalar (pinets works on bare numbers/booleans/strings) ────

const raw = (v: Value): unknown => {
  switch (v.kind) {
    case 'int': case 'float': case 'bool': case 'string': case 'color': return v.v;
    case 'na': return NaN;
    case 'series': return raw(v.v.cur());
    case 'array': return v.v.map(raw);
    default: return undefined; // void/udt/drawings — no ta counterpart
  }
};

// ── Series (adapted from pinets-src/src/Series.ts:1-56) ──────────────────────
// Same semantics: get(i) reads the value i bars ago; data arrays index from
// the end. Two backing modes: a materialized array (verbatim upstream) or a
// live read-through into our contracts.Series (hist[n] = n bars ago — the same
// direction pinets uses, so offset arithmetic transfers unchanged).

export class PtSeries {
  /** Value of a read before the first bar: na. */
  public beforeStart: unknown = NaN;
  private readBack: ((lookback: number) => unknown) | undefined;

  constructor(public data: unknown[] = [], public offset = 0) {}

  /** Alternate ctor: read-through over one of our contracts.Series. */
  static fromPine(s: PineSeries): PtSeries {
    const pt = new PtSeries();
    pt.readBack = (i) => {
      const v = s.get(i);
      return v.kind === 'na' ? NaN : raw(v);
    };
    return pt;
  }

  public get(index: number): unknown {
    // Pine reads an `na` offset as 0: `close[na]` is the current bar.
    if (index == null || Number.isNaN(index)) index = 0;
    // Fractional lookbacks truncate toward zero (upstream RC2 safety net).
    let lookback = this.offset + index;
    if (!Number.isInteger(lookback)) lookback = Math.trunc(lookback);
    if (this.readBack) {
      if (lookback < 0) return this.beforeStart;
      return this.readBack(lookback);
    }
    const realIndex = this.data.length - 1 - lookback;
    if (realIndex < 0) return this.beforeStart;
    if (realIndex >= this.data.length) return NaN;
    return this.data[realIndex];
  }

  public set(index: number, value: unknown): void {
    if (this.readBack) return; // live series are read-only here
    const realIndex = this.data.length - 1 - (this.offset + index);
    if (realIndex >= 0 && realIndex < this.data.length) {
      this.data[realIndex] = value;
    }
  }

  public get length(): number {
    return this.data.length;
  }

  public toArray(): unknown[] {
    return this.data;
  }

  static from(source: unknown): PtSeries {
    if (source instanceof PtSeries) return source;
    if (source instanceof PineSeries) return PtSeries.fromPine(source);
    if (Array.isArray(source)) return new PtSeries(source);
    return new PtSeries([source]); // scalar → single-element array
  }
}

// Ported bodies keep the upstream identifier.
const Series = PtSeries;

/** Adapt a builtin arg Value to what pinets code expects: series → PtSeries,
 *  scalars → raw JS primitives. */
export function adaptSeries(v: Value, ctx: BuiltinCtx): PtSeries | unknown {
  void ctx;
  if (v.kind === 'series') return PtSeries.fromPine(v.v);
  return raw(v);
}

// ── Facade ──────────────────────────────────────────────────────────────────
// Fields ported methods actually touch (grep over ta/methods: taState 213,
// idx 118, precision 88, data 81, get 67, pine 7, params 7). `params` left to
// a later tier — see the Review Ledger report.

export interface PineTsCtx {
  idx: number;
  /** pinets: method — rounds to `decimals` digits on a 10^decimals grid. */
  precision: (value: number, decimals?: number) => unknown;
  /** Per-run shared state bag, keyed by _callId/stateKey inside each method. */
  taState: Record<string, unknown>;
  get: (source: unknown, index: number) => unknown;
  data: {
    open: PtSeries; high: PtSeries; low: PtSeries; close: PtSeries;
    volume: PtSeries; openTime: PtSeries;
  };
  pine: { ta: Record<string, unknown>; syminfo: Record<string, unknown> };
  /** pinets Context.ta — deprecated getter aliasing pine.ta (hma uses it). */
  ta: Record<string, unknown>;
  /** pinets Context.params — named scalar-history store (param.ts). */
  params: Record<string, unknown[]>;
}

// pinets Context.precision (Context.class.ts:780-787) — verbatim.
const PRECISION_EPSILON = 10 ** 10;
function ptPrecision(value: number, decimals = 10): unknown {
  if (typeof value !== 'number') return value;
  const epsilon = decimals === 10 ? PRECISION_EPSILON : 10 ** decimals;
  if (!(Math.abs(value) * epsilon < 2 ** 53)) return value;
  return Math.round(value * epsilon) / epsilon;
}

// pinets Context.get (Context.class.ts:826-855) — verbatim-adapted: our
// contracts.Series slots in beside PtSeries; Value leaves unwrap via raw().
function ptGet(source: unknown, index: number): unknown {
  if (index == null || (typeof index === 'number' && Number.isNaN(index))) index = 0;
  if (typeof index === 'number' && !Number.isInteger(index)) index = Math.trunc(index);
  if (source instanceof PtSeries) return source.get(index);
  if (source instanceof PineSeries) {
    const v = source.get(index);
    return v.kind === 'na' ? NaN : raw(v);
  }
  if (Array.isArray(source)) {
    const realIndex = source.length - 1 - index;
    if (realIndex < 0 || realIndex >= source.length) return NaN;
    return source[realIndex];
  }
  return source; // scalar passthrough — ignores index (upstream behavior)
}

/** Ported method factories; `pine.ta` exposes them bound to the facade. */
export type PtFactory = (context: PineTsCtx) => (...a: unknown[]) => unknown;
/** A ported slice contributes {name: {factory, order}} — merged into PORTED by
 *  the tier files' registration below. */
export type PtSlice = Record<string, { factory: PtFactory; order: readonly string[] }>;
const PORTED: PtSlice = {};

const FACADES = new WeakMap<BuiltinCtx, PineTsCtx>();

/** One facade per BuiltinCtx (ctx is stable across bars — only idx changes). */
export function makePineTsCtx(ctx: BuiltinCtx): PineTsCtx {
  const rt = ctx as RtCtx;
  rt.state ??= new Map();
  let bag = rt.state.get('pt|taState') as Record<string, unknown> | undefined;
  if (bag === undefined) { bag = {}; rt.state.set('pt|taState', bag); }

  let facade = FACADES.get(ctx);
  if (facade === undefined) {
    const syminfo: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx.syminfo)) syminfo[k] = raw(v);
    facade = {
      idx: ctx.barIndex,
      precision: ptPrecision,
      taState: bag,
      get: ptGet,
      data: {
        open: PtSeries.fromPine(ctx.open),
        high: PtSeries.fromPine(ctx.high),
        low: PtSeries.fromPine(ctx.low),
        close: PtSeries.fromPine(ctx.close),
        volume: PtSeries.fromPine(ctx.volume),
        openTime: PtSeries.fromPine(ctx.time),
      },
      pine: { ta: {}, syminfo },
      ta: {},
      params: {},
    };
    // Bound-ported methods for cross-calls (pinets macd → pine.ta.ema style).
    for (const [n, p] of Object.entries(PORTED)) facade.pine.ta[n] = p.factory(facade);
    facade.ta = facade.pine.ta; // upstream Context.ta getter aliases pine.ta
    FACADES.set(ctx, facade);
  }
  facade.idx = ctx.barIndex;
  facade.taState = bag; // same object each time — kept for clarity
  return facade;
}

/** Merge a ported slice into the registry — called by tier files
 *  (pinetsStateless/stateful/composite) at import time. */
export function registerPtSlice(slice: PtSlice): void {
  Object.assign(PORTED, slice);
}

// ── Ported methods ──────────────────────────────────────────────────────────

// Source: pinets-src/src/namespaces/ta/methods/tr.ts:6-33 (verbatim body;
// `context` typed as PineTsCtx, handle_na arg arrives raw not Series).
function ptTr(context: PineTsCtx) {
  return (handle_na?: unknown, _callId?: string) => {
    // True Range calculation
    // TR = max(high - low, abs(high - close[1]), abs(low - close[1]))
    // handle_na: if true, returns high - low when close[1] is NaN (default behavior)
    //            if false, returns NaN when close[1] is NaN

    // Default to true to maintain backward compatibility with the getter behavior
    let handleNa = true;
    if (typeof handle_na === 'string') {
      _callId = handle_na;
    } else if (handle_na !== undefined) {
      handleNa = Series.from(handle_na).get(0) as boolean;
    }

    const high0 = context.get(context.data.high, 0) as number;
    const low0 = context.get(context.data.low, 0) as number;
    const close1 = context.get(context.data.close, 1) as number;

    if (isNaN(close1)) {
      // If handle_na is true, return high - low, otherwise return NaN
      return handleNa ? context.precision(high0 - low0) : NaN;
    }

    const val = Math.max(high0 - low0, Math.abs(high0 - close1), Math.abs(low0 - close1));
    return context.precision(val);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/rsi.ts:5-117 (verbatim body).
function ptRsi(context: PineTsCtx) {
  return (source: unknown, _period: unknown, _callId?: string) => {
    const period = Series.from(_period).get(0) as number;

    // Incremental RSI calculation
    if (!context.taState) context.taState = {};
    const stateKey = _callId || `rsi_${period}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        // Committed state
        prevPrevValue: null,
        prevAvgGain: 0,
        prevAvgLoss: 0,
        prevInitGains: [] as number[],
        prevInitLosses: [] as number[],
        // Tentative state
        currentPrevValue: null,
        currentAvgGain: 0,
        currentAvgLoss: 0,
        currentInitGains: [] as number[],
        currentInitLosses: [] as number[],
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number;
      prevPrevValue: number | null;
      prevAvgGain: number; prevAvgLoss: number;
      prevInitGains: number[]; prevInitLosses: number[];
      currentPrevValue: number | null;
      currentAvgGain: number; currentAvgLoss: number;
      currentInitGains: number[]; currentInitLosses: number[];
    };

    // Commit logic
    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevPrevValue = state.currentPrevValue;
        state.prevAvgGain = state.currentAvgGain;
        state.prevAvgLoss = state.currentAvgLoss;
        state.prevInitGains = [...state.currentInitGains]; // Deep copy array
        state.prevInitLosses = [...state.currentInitLosses]; // Deep copy array
      }
      state.lastIdx = context.idx;
    }

    const currentValue = Series.from(source).get(0) as number;

    // An na bar does not advance the averages, and the change on the next bar is na too (it
    // needs the value before it), so that bar returns na and only stores its value, as on TradingView.
    if (currentValue === null || currentValue === undefined || isNaN(currentValue)) {
      state.currentPrevValue = NaN;
      state.currentInitGains = [...state.prevInitGains];
      state.currentInitLosses = [...state.prevInitLosses];
      state.currentAvgGain = state.prevAvgGain;
      state.currentAvgLoss = state.prevAvgLoss;
      return NaN;
    }

    // Use committed state
    const prevValue = state.prevPrevValue;

    // First valid bar or previous was NaN/null — store value, don't compute diff
    if (prevValue === null || isNaN(prevValue)) {
      state.currentPrevValue = currentValue;
      state.currentInitGains = [...state.prevInitGains];
      state.currentInitLosses = [...state.prevInitLosses];
      state.currentAvgGain = state.prevAvgGain;
      state.currentAvgLoss = state.prevAvgLoss;
      return NaN;
    }

    let avgGain = state.prevAvgGain;
    let avgLoss = state.prevAvgLoss;
    const initGains = [...state.prevInitGains]; // Copy for tentative usage
    const initLosses = [...state.prevInitLosses]; // Copy for tentative usage

    // Calculate gain/loss from previous value
    const diff = currentValue - prevValue;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    // Accumulate gains/losses until we have 'period' values
    if (initGains.length < period) {
      initGains.push(gain);
      initLosses.push(loss);

      // Update tentative state arrays
      state.currentInitGains = initGains;
      state.currentInitLosses = initLosses;
      state.currentPrevValue = currentValue;

      // Once we have 'period' gain/loss pairs, calculate first RSI
      if (initGains.length === period) {
        // Calculate first RSI using simple averages
        avgGain = initGains.reduce((a, b) => a + b, 0) / period;
        avgLoss = initLosses.reduce((a, b) => a + b, 0) / period;

        state.currentAvgGain = avgGain;
        state.currentAvgLoss = avgLoss;

        const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        return context.precision(rsi);
      }
      return NaN;
    }

    // Calculate RSI using smoothed averages (Wilder's smoothing)
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    // Store tentative state
    state.currentAvgGain = avgGain;
    state.currentAvgLoss = avgLoss;
    state.currentPrevValue = currentValue;

    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    return context.precision(rsi);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/supertrend.ts:28-187 (verbatim
// body; tuple return `[[st, dir]]` unwrapped one level by ptToValue).
function ptSupertrend(context: PineTsCtx) {
  return (_factor: unknown, _atrPeriod: unknown, _callId?: string) => {
    const atrPeriod = Series.from(_atrPeriod).get(0) as number;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `supertrend_${Series.from(_factor).get(0)}_${atrPeriod}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        // TradingView uses the factor of the first bar for the whole series
        factor: Series.from(_factor).get(0),
        lastIdx: -1,
        // Committed state
        prevTrSum: 0,
        prevAtrValue: NaN,
        prevAtrCount: 0,
        prevLowerBand: NaN,
        prevUpperBand: NaN,
        prevSuperTrend: NaN,
        prevDirection: NaN,
        // Tentative state
        currentTrSum: 0,
        currentAtrValue: NaN,
        currentAtrCount: 0,
        currentLowerBand: NaN,
        currentUpperBand: NaN,
        currentSuperTrend: NaN,
        currentDirection: NaN,
      };
    }

    const state = context.taState[stateKey] as {
      factor: number; lastIdx: number;
      prevTrSum: number; prevAtrValue: number; prevAtrCount: number;
      prevLowerBand: number; prevUpperBand: number;
      prevSuperTrend: number; prevDirection: number;
      currentTrSum: number; currentAtrValue: number; currentAtrCount: number;
      currentLowerBand: number; currentUpperBand: number;
      currentSuperTrend: number; currentDirection: number;
    };
    const factor = state.factor;

    // Commit logic
    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevTrSum = state.currentTrSum;
        state.prevAtrValue = state.currentAtrValue;
        state.prevAtrCount = state.currentAtrCount;
        state.prevLowerBand = state.currentLowerBand;
        state.prevUpperBand = state.currentUpperBand;
        state.prevSuperTrend = state.currentSuperTrend;
        state.prevDirection = state.currentDirection;
      }
      state.lastIdx = context.idx;
    }

    // Get current OHLC values
    const high = context.get(context.data.high, 0) as number;
    const low = context.get(context.data.low, 0) as number;
    const close = context.get(context.data.close, 0) as number;

    // Handle NaN inputs
    if (isNaN(high) || isNaN(low) || isNaN(close)) {
      return [[NaN, NaN]];
    }

    // Calculate hl2 (source)
    const hl2 = (high + low) / 2;

    // Read previous close directly from context data — always correct
    // regardless of whether Supertrend was called on previous bars.
    // This fixes the stale-prevClose bug when Supertrend is called conditionally.
    const prevClose = context.idx > 0 ? context.get(context.data.close, 1) as number : NaN;

    // Calculate True Range
    let tr;
    if (isNaN(prevClose)) {
      tr = high - low;
    } else {
      tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    }

    // Calculate ATR using RMA (using committed state)
    let atrCount = state.prevAtrCount;
    let trSum = state.prevTrSum;
    let atrValue = state.prevAtrValue;

    atrCount++;
    if (atrCount <= atrPeriod) {
      trSum += tr;
      if (atrCount === atrPeriod) {
        atrValue = trSum / atrPeriod;
      }
    } else {
      // RMA formula: rma = (prev_rma * (length - 1) + current) / length
      atrValue = (atrValue * (atrPeriod - 1) + tr) / atrPeriod;
    }

    const atr = atrValue;

    // Store tentative state for ATR
    state.currentAtrCount = atrCount;
    state.currentTrSum = trSum;
    state.currentAtrValue = atrValue;

    // Not enough data for ATR yet
    if (isNaN(atr)) {
      return [[NaN, NaN]];
    }

    // Calculate bands
    let upperBand = hl2 + factor * atr;
    let lowerBand = hl2 - factor * atr;

    // Get previous bands (use 0 if NaN - nz() behavior)
    // Use committed previous bands
    const prevLowerBand = isNaN(state.prevLowerBand) ? 0 : state.prevLowerBand;
    const prevUpperBand = isNaN(state.prevUpperBand) ? 0 : state.prevUpperBand;

    // Adjust lowerBand: keep previous if price didn't break below
    // lowerBand := lowerBand > prevLowerBand or close[1] < prevLowerBand ? lowerBand : prevLowerBand
    if (!isNaN(state.prevLowerBand)) {
      if (lowerBand > prevLowerBand || prevClose < prevLowerBand) {
        // Keep new lowerBand
      } else {
        lowerBand = prevLowerBand;
      }
    }

    // Adjust upperBand: keep previous if price didn't break above
    // upperBand := upperBand < prevUpperBand or close[1] > prevUpperBand ? upperBand : prevUpperBand
    if (!isNaN(state.prevUpperBand)) {
      if (upperBand < prevUpperBand || prevClose > prevUpperBand) {
        // Keep new upperBand
      } else {
        upperBand = prevUpperBand;
      }
    }

    // Determine direction
    let direction: number;
    let superTrend: number;

    const prevSuperTrend = state.prevSuperTrend;

    if (atrCount === atrPeriod) {
      // First bar with ATR - initialize direction
      direction = 1;
    } else if (prevSuperTrend === state.prevUpperBand) {
      // Previous supertrend was upper band (bearish)
      direction = close > upperBand ? -1 : 1;
    } else {
      // Previous supertrend was lower band (bullish)
      direction = close < lowerBand ? 1 : -1;
    }

    // Set supertrend based on direction
    superTrend = direction === -1 ? lowerBand : upperBand;

    // Store tentative state for bands & supertrend
    state.currentLowerBand = lowerBand;
    state.currentUpperBand = upperBand;
    state.currentSuperTrend = superTrend;
    state.currentDirection = direction;

    return [[context.precision(superTrend), direction]];
  };
}

// ── Value conversion + builtin wrapper ──────────────────────────────────────

const toValue = (v: unknown): Value => {
  if (Array.isArray(v)) {
    // pinets tuples arrive as [[a, b]] — unwrap one level.
    const inner = v.length === 1 && Array.isArray(v[0]) ? v[0] as unknown[] : v;
    return { kind: 'array', v: inner.map(toValue) };
  }
  if (typeof v === 'number') return !Number.isFinite(v) ? NA : { kind: 'float', v };
  if (typeof v === 'boolean') return { kind: 'bool', v };
  if (typeof v === 'string') return { kind: 'string', v };
  if (v === undefined || v === null) return NA;
  return NA;
};

/** BuiltinFn wrapper: bind Pine args → raw JS, run the ported inner fn with
 *  the callsite id as _callId, convert the result back to a Value. */
function wrapPorted(name: string, factory: PtFactory, order: readonly string[]): BuiltinFn {
  return (ctx, args, named) => {
    const bound = bindArgs(args, named, order);
    const rawArgs = order.map((k) => {
      const v = bound.get(k);
      return v === undefined ? undefined : adaptSeries(v, ctx);
    });
    const rt = ctx as RtCtx;
    const out = factory(makePineTsCtx(ctx))(...rawArgs, rt.callsite ?? `pt|${name}`);
    return toValue(out);
  };
}

// Upstream bodies are `any`-shaped (optional named params); unknown[] rest
// args can't unify with them, so the boundary cast is per-port, once.
PORTED.tr = { factory: ptTr as unknown as PtFactory, order: ['handle_na'] };
PORTED.rsi = { factory: ptRsi as unknown as PtFactory, order: ['source', 'length'] };
PORTED.supertrend = { factory: ptSupertrend as unknown as PtFactory, order: ['factor', 'atrPeriod'] };

/** Register the pilot ports under their real `ta.*` names. registerBuiltin
 *  silently overwrites (Map.set) — warn so the swap is visible in test logs.
 *  Returns the displaced originals so a test can restore them. */
export function registerPortedTa(): Map<string, BuiltinFn | undefined> {
  const displaced = new Map<string, BuiltinFn | undefined>();
  for (const [name, p] of Object.entries(PORTED)) {
    const key = `ta.${name}`;
    displaced.set(name, BUILTINS.get(key));
    if (BUILTINS.has(key)) console.warn(`pinetsShim: overwriting ${key} with ported impl`);
    registerBuiltin('ta', name, wrapPorted(name, p.factory, p.order));
  }
  return displaced;
}
