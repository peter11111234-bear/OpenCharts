// ── pinetsComposite (B3 composite tier) tests ────────────────────────────────
// Covers hma/macd/mom/param. Composite ports ride `context.pine.ta.<dep>` —
// the dep slices (wma/ema/change) are owned by sibling tiers landing in the
// same round, so this file registers adapted copies of those upstream bodies
// itself (test-local; vitest isolates modules per file). registerPortedTa()
// still overwrites the matching production builtins; originals are restored
// after the file.
//
// Documented divergences vs our builtins:
//  * ta.macd: pinets `ema` seeds with the SMA of the first `period` values and
//    returns na until bar period-1; our emaVs seeds ema(0)=x and is finite
//    from bar 0. So the ported macd emits [na,na,na] until bar slowlen-1 and
//    a signal line from bar slowlen+siglen-2 — no bar-for-bar equality with
//    our builtin. Parity is asserted against an independent upstream-semantics
//    replication instead (SMA-seeded EMA chain).
//  * ta.hma: pinets root window is floor(sqrt(n)); ours is round(sqrt(n)) and
//    clamps to >=1 — assert parity at lengths where they agree (9→3, 25→5).
//    On na bars pinets wma fill-forwards the last value into the window while
//    our wmaWin yields na (bad>0) — exercised via a clean series.
//  * ta.mom: ported delegates to upstream change (window lookback c−c[len]) —
//    bar-for-bar equal to our momImpl, including na through bar len-1.
//  * ta.param: not a Pine builtin (upstream transpiler internal); registered
//    for facade.pine.ta completeness. The builtin wrapper yields na because a
//    PtSeries isn't a script Value — the ported body is driven directly via
//    facade.pine.ta.param.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../builtins';
import { BUILTINS } from '../builtins/registry';
import { Series } from '../contracts';
import type { BarData, BuiltinCtx, BuiltinFn, Value } from '../contracts';
import {
  makePineTsCtx,
  PtSeries,
  registerPtSlice,
  registerPortedTa,
  type PineTsCtx,
  type PtFactory,
} from '../pinetsShim';
import '../pinetsComposite';

// ── Adapted upstream dep ports (test-local stand-ins for sibling tiers) ──────
// Verbatim-adapted exactly like the tier files: upstream `any` → unknown,
// state records typed. If a dep's own slice is already registered these
// entries just get overwritten by the identical body.

interface WinState {
  lastIdx: number;
  prevWindow: number[];
  prevCallCount: number;
  currentWindow: number[];
  currentCallCount: number;
}

const newWinState = (): WinState => ({
  lastIdx: -1, prevWindow: [], prevCallCount: 0, currentWindow: [], currentCallCount: 0,
});

// Source: pinets-src/src/namespaces/ta/methods/wma.ts:5-81
const depWma = (context: PineTsCtx) => {
  return (source: unknown, _period: unknown, _callId?: string) => {
    const period = PtSeries.from(_period).get(0) as number;

    // Weighted Moving Average
    if (!context.taState) context.taState = {};
    const stateKey = _callId || `wma_${period}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = newWinState();
    }

    const state = context.taState[stateKey] as WinState;

    // Commit logic
    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevWindow = [...state.currentWindow];
        state.prevCallCount = state.currentCallCount;
      }
      state.lastIdx = context.idx;
    }

    const currentValue = PtSeries.from(source).get(0) as number;
    const currentIsNa = currentValue === null || currentValue === undefined || Number.isNaN(currentValue);

    // Use committed state
    const window = [...state.prevWindow];

    // TradingView weighs an na bar with the last non-na value before it (and returns na on the
    // na bar itself), so the window holds the source with na values filled forward.
    window.unshift(currentIsNa ? (window.length ? window[0]! : NaN) : currentValue);

    while (window.length > period) {
      window.pop();
    }

    // Track actual call count for callsite-correct backfill
    const callCount = state.prevCallCount + 1;
    if (window.length < period && (callCount >= period || context.idx >= period - 1)) {
      const series = PtSeries.from(source);
      while (window.length < period) {
        window.push(series.get(window.length) as number);
      }
      for (let i = window.length - 2; i >= 0; i--) {
        if (Number.isNaN(window[i])) window[i] = window[i + 1]!;
      }
    }

    // Update tentative state
    state.currentWindow = window;
    state.currentCallCount = callCount;

    if (window.length < period || currentIsNa || window.some((v) => Number.isNaN(v))) {
      return NaN;
    }

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < period; i++) {
      const weight = period - i;
      numerator += window[i]! * weight;
      denominator += weight;
    }

    const wma = numerator / denominator;
    return context.precision(wma);
  };
};

// Source: pinets-src/src/namespaces/ta/methods/ema.ts:5-79
const depEma = (context: PineTsCtx) => {
  return (source: unknown, _period: unknown, _callId?: string) => {
    const period = PtSeries.from(_period).get(0) as number;

    // Incremental EMA calculation
    if (!context.taState) context.taState = {};
    const stateKey = _callId || `ema_${period}`;

    // Initialize state structure
    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        // Committed state (from end of lastIdx-1)
        prevEma: null as number | null,
        prevInitSum: 0,
        prevInitCount: 0,
        // Tentative state (for current lastIdx)
        currentEma: null as number | null,
        currentInitSum: 0,
        currentInitCount: 0,
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number;
      prevEma: number | null; prevInitSum: number; prevInitCount: number;
      currentEma: number | null; currentInitSum: number; currentInitCount: number;
    };

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

    const currentValue = PtSeries.from(source).get(0) as number;

    if (currentValue === null || currentValue === undefined || isNaN(currentValue)) {
      return NaN;
    }

    // Use 'prev' variables for calculation to ensure stability during live updates
    // We calculate 'current' values but DO NOT overwrite 'prev' values yet
    let initCount = state.prevInitCount;
    let initSum = state.prevInitSum;
    const prevEma = state.prevEma;

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
    const ema = currentValue * alpha + prevEma! * (1 - alpha);

    // Store tentative result
    state.currentEma = ema;

    return context.precision(ema);
  };
};

// Source: pinets-src/src/namespaces/ta/methods/change.ts:5-74
const depChange = (context: PineTsCtx) => {
  return (source: unknown, _length: unknown = 1, _callId?: string) => {
    //handle the case where ta.change is called with the source only,
    // in that case the transpiler will inject the callId as a second parameter
    // so we need to extract the callId and set the length to 1
    if (typeof _length === 'string') {
      _callId = _length;
      _length = 1;
    }
    const length = PtSeries.from(_length).get(0) as number;

    // Simple lookback - store window
    if (!context.taState) context.taState = {};
    const stateKey = _callId || `change_${length}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = newWinState();
    }

    const state = context.taState[stateKey] as WinState;

    // Commit logic
    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevWindow = [...state.currentWindow];
        state.prevCallCount = state.currentCallCount;
      }
      state.lastIdx = context.idx;
    }

    const currentValue = PtSeries.from(source).get(0) as number;

    // Use committed state as base
    const window = [...state.prevWindow];

    window.unshift(currentValue);

    while (window.length > length + 1) {
      window.pop();
    }

    // Track actual call count for callsite-correct backfill
    const callCount = state.prevCallCount + 1;
    if (window.length < length + 1 && (callCount >= length + 1 || context.idx >= length)) {
      const series = PtSeries.from(source);
      while (window.length < length + 1) {
        window.push(series.get(window.length) as number);
      }
    }

    // Update tentative state
    state.currentWindow = window;
    state.currentCallCount = callCount;

    if (window.length <= length) {
      return NaN;
    }

    const change = currentValue - window[length]!;
    return context.precision(change);
  };
};

// Must precede beforeAll: makePineTsCtx binds every PORTED entry into
// facade.pine.ta at facade creation.
registerPtSlice({
  wma: { factory: depWma as PtFactory, order: ['source', 'length'] },
  ema: { factory: depEma as PtFactory, order: ['source', 'length'] },
  change: { factory: depChange as PtFactory, order: ['source', 'length'] },
});

// ── harness (mirrors pinetsShim.test.ts) ─────────────────────────────────────

const mkBars = (n: number, gen?: (i: number) => Partial<BarData>): BarData[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: i * 60000,
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1000 + i * 10,
    ...(gen ? gen(i) : {}),
  }));

const WAVY = mkBars(60, (i) => ({
  open: 100 + i,
  high: 102 + i + (i % 3),
  low: 99 + i - (i % 2),
  close: 100 + i + (i % 5) - (i % 3),
}));

function newCtx(bars: BarData[]): BuiltinCtx {
  return {
    barIndex: -1,
    barCount: bars.length,
    open: new Series(), high: new Series(), low: new Series(), close: new Series(),
    volume: new Series(), time: new Series(),
    hl2: new Series(), hlc3: new Series(), ohlc4: new Series(), hlcc4: new Series(),
    plots: [], drawings: [], warnings: [], alerts: [],
    syminfo: {},
    timeframe: { period: '1', multiplier: 1, isseconds: false, isminutes: true, isdaily: false, isweekly: false, ismonthly: false, isintraday: true },
    callUdf: () => { throw new Error('no udf in tests'); },
  };
}

function pushBar(ctx: BuiltinCtx, b: BarData, i: number): void {
  ctx.barIndex = i;
  ctx.open.set({ kind: 'float', v: b.open });
  ctx.high.set({ kind: 'float', v: b.high });
  ctx.low.set({ kind: 'float', v: b.low });
  ctx.close.set({ kind: 'float', v: b.close });
  ctx.volume.set({ kind: 'float', v: b.volume });
  ctx.time.set({ kind: 'int', v: b.openTime });
}

function runBars(bars: BarData[], fn: (ctx: BuiltinCtx) => Value): Value[] {
  const ctx = newCtx(bars);
  const out: Value[] = [];
  for (let i = 0; i < bars.length; i++) {
    pushBar(ctx, bars[i]!, i);
    out.push(fn(ctx));
  }
  return out;
}

const numv = (v: Value): number =>
  v.kind === 'int' || v.kind === 'float' ? v.v : NaN;
const ser = (s: Series): Value => ({ kind: 'series', v: s });
const intv = (n: number): Value => ({ kind: 'int', v: n });
const tuplev = (v: Value): number[] =>
  v.kind === 'array' ? v.v.map(numv) : [NaN, NaN, NaN];

let orig: Map<string, BuiltinFn | undefined>;
beforeAll(() => {
  orig = registerPortedTa();
});
afterAll(() => {
  for (const [name, fn] of orig) {
    if (fn) BUILTINS.set(`ta.${name}`, fn);
  }
});

describe('pinetsComposite tier', () => {
  it('ta.hma ported == existing builtin bar-for-bar at len 9 and 25', () => {
    // floor(sqrt(9))=round(sqrt(9))=3 and floor(sqrt(25))=round(sqrt(25))=5 —
    // the only formula divergence is floor-vs-round on the root window.
    const origHma = orig.get('hma')!;
    for (const len of [9, 25]) {
      const a = runBars(WAVY, (c) => origHma(c, [ser(c.close), intv(len)], {}));
      const b = runBars(WAVY, (c) => BUILTINS.get('ta.hma')!(c, [ser(c.close), intv(len)], {}));
      for (let i = 0; i < WAVY.length; i++) {
        if (a[i]!.kind === 'na') {
          expect(b[i]!.kind, `len=${len} bar=${i}`).toBe('na');
        } else {
          expect(numv(b[i]!), `len=${len} bar=${i}`).toBeCloseTo(numv(a[i]!), 8);
        }
      }
    }
  });

  it('ta.mom ported == existing builtin bar-for-bar (delegates to change)', () => {
    const origMom = orig.get('mom')!;
    const a = runBars(WAVY, (c) => origMom(c, [ser(c.close), intv(4)], {}));
    const b = runBars(WAVY, (c) => BUILTINS.get('ta.mom')!(c, [ser(c.close), intv(4)], {}));
    for (let i = 0; i < WAVY.length; i++) {
      if (a[i]!.kind === 'na') {
        expect(b[i]!.kind, `bar=${i}`).toBe('na');
      } else {
        expect(numv(b[i]!), `bar=${i}`).toBeCloseTo(numv(a[i]!), 8);
      }
    }
    // hand-check: last bar = close[0] - close[4]
    const last = WAVY.length - 1;
    expect(numv(b[last]!)).toBeCloseTo(WAVY[last]!.close - WAVY[last - 4]!.close, 9);
  });

  it('ta.macd ported matches upstream-semantics replication (SMA-seeded EMA)', () => {
    // Independent replication of pinets semantics: SMA-seeded EMAs, signal EMA
    // accumulates only over bars where macdLine is finite.
    const [F, S, G] = [12, 26, 9];
    const src = WAVY.map((b) => b.close);
    const emaSeries = (vals: (number | undefined)[], p: number): (number | undefined)[] => {
      const out: (number | undefined)[] = new Array<number | undefined>(vals.length).fill(undefined);
      let sum = 0, cnt = 0, prev = 0;
      for (let i = 0; i < vals.length; i++) {
        const x = vals[i];
        if (x === undefined || Number.isNaN(x)) continue;
        if (cnt < p) {
          sum += x; cnt++;
          if (cnt === p) { prev = sum / p; out[i] = prev; }
          continue;
        }
        const a = 2 / (p + 1);
        prev = x * a + prev * (1 - a);
        out[i] = prev;
      }
      return out;
    };
    const fe = emaSeries(src, F), se = emaSeries(src, S);
    const ml = src.map((_, i) => (fe[i] === undefined || se[i] === undefined ? undefined : fe[i]! - se[i]!));
    const gl = emaSeries(ml, G);

    const res = runBars(WAVY, (c) =>
      BUILTINS.get('ta.macd')!(c, [ser(c.close), intv(F), intv(S), intv(G)], {}));

    // seeded shape: na until slow EMA seeds at bar S-1; signal from bar S+G-2.
    for (let i = 0; i < S - 1; i++) expect(tuplev(res[i]!)[0], `macd na bar=${i}`).toBeNaN();
    expect(tuplev(res[S - 1]!)[0]).not.toBeNaN();
    expect(tuplev(res[S + G - 3]!)[1]).toBeNaN();
    expect(tuplev(res[S + G - 2]!)[1]).not.toBeNaN();

    for (let i = 0; i < WAVY.length; i++) {
      const [m, g, h] = tuplev(res[i]!);
      if (ml[i] === undefined) expect(m, `macd bar=${i}`).toBeNaN();
      else expect(m, `macd bar=${i}`).toBeCloseTo(ml[i]!, 9);
      if (gl[i] === undefined) expect(g, `signal bar=${i}`).toBeNaN();
      else expect(g, `signal bar=${i}`).toBeCloseTo(gl[i]!, 9);
      if (ml[i] === undefined || gl[i] === undefined) expect(h, `hist bar=${i}`).toBeNaN();
      else expect(h, `hist bar=${i}`).toBeCloseTo(ml[i]! - gl[i]!, 9);
    }
  });

  it('ta.param (facade): scalar-history store + offset reads', () => {
    const ctx = newCtx(WAVY);
    pushBar(ctx, WAVY[0]!, 0);
    const facade = makePineTsCtx(ctx);
    const param = facade.pine.ta.param as (src: unknown, idx: unknown, name?: string) => PtSeries;

    // scalar source → stored once; later calls update the tail (no growth)
    expect(param(42, 0, 'k').get(0)).toBe(42);
    expect(param(7, 0, 'k').get(0)).toBe(7);
    expect(facade.params['k']).toEqual([7]); // replaced, not appended

    // array source → PtSeries over it, index = offset into the past
    expect(param([1, 2, 3], 0, 'arr').get(0)).toBe(3);
    expect(param([1, 2, 3], 1, 'arr').get(0)).toBe(2);

    // Series passthrough; index shifts the offset
    const ps = PtSeries.from([5, 6, 7]);
    expect(param(ps, 0, 'x')).toBe(ps);
    expect(param(ps, 1, 'x').get(0)).toBe(6);
  });
});
