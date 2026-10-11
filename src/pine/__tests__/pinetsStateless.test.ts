// ── pinetsStateless (B3) tests ──────────────────────────────────────────────
// 15 ported methods. registerPortedTa() OVERWRITES colliding production
// builtins (12 of 15); originals captured + restored around the suite.
//
// Parity notes / documented divergences vs the existing builtins:
//  - percentile_linear_interpolation: DIFFERENT index formula — builtin uses
//    pos=(pct/100)*(L-1), pinets uses (pct/100)*L-0.5. They agree only at
//    pct=50 (median); parity is asserted there and documented.
//  - mode: on frequency ties pinets picks the smallest value, the builtin
//    keeps the first-seen — test data avoids ties.
//  - pivothigh/pivotlow: builtin is strict (an equal neighbor kills the
//    pivot); pinets has asymmetric tie + na-break semantics. Test data is
//    strictly distinct inside windows → parity; 1-arg form (`ta.pivothigh(3)`)
//    is NaN under pinets (rightbars reads NaN) where the builtin defaults
//    right=left — not tested, pinets-faithful.
//  - correlation: builtin named args are source_a/source_b (pinets source1/
//    source2) — parity driven positionally.
//  - sma/median/vwma/stdev/variance/correlation: pinets nonNaWindow SKIPS na
//    bars; builtins require a fully-defined window. Clean data → parity.
//  - iii / wvad / percentrank: no existing builtin → semantic smoke only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../builtins';
import '../pinetsStateless';
import { BUILTINS } from '../builtins/registry';
import { Series } from '../contracts';
import type { BarData, BuiltinCtx, BuiltinFn, Value } from '../contracts';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { registerPortedTa } from '../pinetsShim';

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

const WAVY = mkBars(40, (i) => ({
  open: 100 + i,
  high: 102 + i + (i % 3),
  low: 99 + i - (i % 2),
  close: 100 + i + (i % 5) - (i % 3),
  volume: 1000 + i * 7 + (i % 4) * 13,
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
const int = (v: number): Value => ({ kind: 'int', v });
const bool = (v: boolean): Value => ({ kind: 'bool', v });

let orig: Map<string, BuiltinFn | undefined>;
beforeAll(() => {
  orig = registerPortedTa();
});
afterAll(() => {
  for (const [name, fn] of orig) {
    if (fn) BUILTINS.set(`ta.${name}`, fn);
  }
});

// Parity driver: ported (live BUILTINS) vs displaced original, bar-for-bar.
// na/na counts as equal; na/value mismatches fail.
function expectParity(name: string, bars: BarData[], mkArgs: (c: BuiltinCtx) => Value[], named: Record<string, Value> = {}) {
  const origFn = orig.get(name)!;
  const a = runBars(bars, (c) => origFn(c, mkArgs(c), named));
  const b = runBars(bars, (c) => BUILTINS.get(`ta.${name}`)!(c, mkArgs(c), named));
  const diffs: string[] = [];
  for (let i = 0; i < bars.length; i++) {
    const av = a[i]!, bv = b[i]!;
    if (av.kind === 'na' || bv.kind === 'na') {
      if (av.kind !== bv.kind) diffs.push(`bar${i}: ${av.kind} vs ${bv.kind}`);
    } else {
      const d = Math.abs(numv(av) - numv(bv));
      if (!(d < 1e-8)) diffs.push(`bar${i}: ${numv(av)} vs ${numv(bv)}`);
    }
  }
  expect(diffs).toEqual([]);
}

describe('pinetsStateless: parity with existing builtins', () => {
  it('ta.sma(source, length) parity', () => {
    expectParity('sma', WAVY, (c) => [ser(c.close), int(9)]);
  });

  it('ta.stdev(source, length, biased) parity — both bias modes', () => {
    expectParity('stdev', WAVY, (c) => [ser(c.close), int(9)]);
    expectParity('stdev', WAVY, (c) => [ser(c.close), int(9)], { biased: bool(false) });
  });

  it('ta.variance(source, length, biased) parity — both bias modes', () => {
    expectParity('variance', WAVY, (c) => [ser(c.close), int(9)]);
    expectParity('variance', WAVY, (c) => [ser(c.close), int(9)], { biased: bool(false) });
  });

  it('ta.vwma(source, length) parity', () => {
    expectParity('vwma', WAVY, (c) => [ser(c.close), int(9)]);
  });

  it('ta.median(source, length) parity — odd and even windows', () => {
    expectParity('median', WAVY, (c) => [ser(c.close), int(9)]);
    expectParity('median', WAVY, (c) => [ser(c.close), int(10)]);
  });

  it('ta.mode(source, length) parity (unique dominant value per window)', () => {
    // Mostly 50 with distinct noise — every window has a unique mode, so the
    // tie rules (pinets: smallest; builtin: first-seen) never engage.
    const bars = mkBars(40, (i) => ({ close: 50 + (i % 3 === 0 ? i + 0.5 : 0) }));
    expectParity('mode', bars, (c) => [ser(c.close), int(7)]);
  });

  it('ta.correlation(s1, s2, length) parity (positional args)', () => {
    expectParity('correlation', WAVY, (c) => [ser(c.high), ser(c.low), int(9)]);
  });

  it('ta.cog(source, length) parity', () => {
    expectParity('cog', WAVY, (c) => [ser(c.close), int(9)]);
  });

  it('ta.percentile_nearest_rank parity', () => {
    expectParity('percentile_nearest_rank', WAVY, (c) => [ser(c.close), int(9), int(70)]);
  });

  it('ta.percentile_linear_interpolation parity at pct=50 only', () => {
    // DIVERGENCE (documented above): different index formula — builtin
    // (pct/100)*(L-1) vs pinets (pct/100)*L-0.5. Equal iff pct==50.
    expectParity('percentile_linear_interpolation', WAVY, (c) => [ser(c.close), int(9), int(50)]);
  });

  it('ta.pivothigh/pivotlow(high, l, r) parity on strictly-distinct data', () => {
    // Ramp + smooth 8-bar wave, no equal values inside any ±2 window — the
    // builtin strict rule and pinets asymmetric-tie rule then coincide.
    // (Ties still differ: pinets allows equal LEFT neighbors on pivothigh,
    // the builtin does not — documented divergence.)
    const bars = mkBars(30, (i) => ({
      open: 100 + i,
      high: 200 + i * 0.5 + (i % 8 === 4 ? 10 : 0),
      low: 90 + i * 0.5 - (i % 8 === 4 ? 10 : 0),
      close: 100 + i,
    }));
    expectParity('pivothigh', bars, (c) => [ser(c.high), int(2), int(2)]);
    expectParity('pivotlow', bars, (c) => [ser(c.low), int(2), int(2)]);
  });
});

describe('pinetsStateless: smoke for methods without builtins', () => {
  it('ta.iii() = ((2*close - high - low)/(high - low)) * volume', () => {
    const res = runBars(WAVY, (c) => BUILTINS.get('ta.iii')!(c, [], {}));
    for (let i = 0; i < WAVY.length; i++) {
      const b = WAVY[i]!;
      const expected = ((2 * b.close - b.high - b.low) / (b.high - b.low)) * b.volume;
      expect(numv(res[i]!)).toBeCloseTo(expected, 8);
    }
  });

  it('ta.wvad() = ((close - open)/(high - low)) * volume', () => {
    const res = runBars(WAVY, (c) => BUILTINS.get('ta.wvad')!(c, [], {}));
    for (let i = 0; i < WAVY.length; i++) {
      const b = WAVY[i]!;
      const expected = ((b.close - b.open) / (b.high - b.low)) * b.volume;
      expect(numv(res[i]!)).toBeCloseTo(expected, 8);
    }
  });

  it('ta.percentrank(close, length) hand-checked on the last bar', () => {
    const L = 5;
    const res = runBars(WAVY, (c) => BUILTINS.get('ta.percentrank')!(c, [ser(c.close), int(L)], {}));
    for (let i = 0; i < L; i++) expect(res[i]!.kind).toBe('na');
    const last = WAVY[WAVY.length - 1]!.close;
    let count = 0;
    for (let k = 1; k <= L; k++) if (WAVY[WAVY.length - 1 - k]!.close <= last) count++;
    expect(numv(res[WAVY.length - 1]!)).toBeCloseTo((count / L) * 100, 8);
  });

  it('ported ta.sma reachable from a pine script via runScript', async () => {
    const src = `indicator("t")\nplot(ta.sma(close, 9), "s")\n`;
    const r = await runScript(parse(src), WAVY, { symbol: 'T', timeframe: '1' });
    const vals = r.plots.get('s')!.values;
    const direct = runBars(WAVY, (c) => orig.get('sma')!(c, [ser(c.close), int(9)], {}));
    for (let i = 0; i < WAVY.length; i++) {
      if (direct[i]!.kind === 'na') expect(vals[i]!.kind).toBe('na');
      else expect(numv(vals[i]!)).toBeCloseTo(numv(direct[i]!), 8);
    }
  });
});
