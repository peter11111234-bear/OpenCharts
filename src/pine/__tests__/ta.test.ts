// ── ta.* builtin unit tests ─────────────────────────────────────────────────
// Builtins are invoked directly with a hand-rolled BuiltinCtx whose OHLCV
// Series are filled bar-by-bar from synthetic BarData — mirrors how the
// interpreter drives them (same ctx object across bars, barIndex advanced).

import { describe, it, expect, beforeEach } from 'vitest';
import '../builtins/ta';
import { BUILTINS, getConstant } from '../builtins/registry';
import { Series } from '../contracts';
import { BarSeries } from '../series';
import type { BarData, BuiltinCtx, Value } from '../contracts';
import { truthy } from '../builtins/util';

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
  ctx.hl2.set({ kind: 'float', v: (b.high + b.low) / 2 });
  ctx.hlc3.set({ kind: 'float', v: (b.high + b.low + b.close) / 3 });
  ctx.ohlc4.set({ kind: 'float', v: (b.open + b.high + b.low + b.close) / 4 });
  ctx.hlcc4.set({ kind: 'float', v: (b.high + b.low + b.close + b.close) / 4 });
}

/** Fresh ctx; calls fn at every bar 0..n-1, returns per-bar results. */
function runBars(bars: BarData[], fn: (ctx: BuiltinCtx) => Value): Value[] {
  const ctx = newCtx(bars);
  const out: Value[] = [];
  for (let i = 0; i < bars.length; i++) {
    pushBar(ctx, bars[i]!, i);
    out.push(fn(ctx));
  }
  return out;
}

const call = (name: string, ctx: BuiltinCtx, args: Value[], named: Record<string, Value> = {}): Value => {
  const fn = BUILTINS.get(`ta.${name}`);
  if (!fn) throw new Error(`ta.${name} not registered`);
  return fn(ctx, args, named);
};

const ser = (s: Series): Value => ({ kind: 'series', v: s });
const iv = (n: number): Value => ({ kind: 'int', v: n });
const fv = (n: number): Value => ({ kind: 'float', v: n });

const numv = (v: Value): number => {
  if (v.kind === 'int' || v.kind === 'float') return v.v;
  throw new Error(`expected number, got ${v.kind}`);
};
const arrv = (v: Value): Value[] => {
  if (v.kind === 'array') return v.v;
  throw new Error(`expected array, got ${v.kind}`);
};

// ── registration ─────────────────────────────────────────────────────────────

describe('ta.* registration', () => {
  it('registers every required builtin', () => {
    const names = [
      'sma', 'ema', 'rma', 'wma', 'hma', 'vwma', 'rsi', 'macd', 'atr', 'tr',
      'stdev', 'variance', 'highest', 'highestbars', 'lowest', 'lowestbars',
      'cross', 'crossover', 'crossunder', 'change', 'roc', 'momentum', 'mom',
      'cum', 'sum', 'cor', 'dev', 'median', 'mode',
      'percentile_linear_interpolation', 'percentile_nearest_rank',
      'pivothigh', 'pivotlow', 'supertrend', 'swma', 'wad', 'cci', 'cmo', 'cog',
      'dmi', 'fisher', 'kc', 'kcW', 'linreg', 'mfi', 'nadarayaWatsonEnvelope',
      'nvi', 'pvi', 'obv', 'pvt', 'sar', 'tsi', 'vwap', 'vortex', 'wpr',
    ];
    for (const n of names) expect(BUILTINS.has(`ta.${n}`), `ta.${n}`).toBe(true);
  });
});

// ── sma ─────────────────────────────────────────────────────────────────────

describe('ta.sma', () => {
  let bars: BarData[];
  beforeEach(() => { bars = mkBars(20); });

  it('returns na until window fills', () => {
    const res = runBars(mkBars(6), (c) => call('sma', c, [ser(c.close), iv(5)]));
    for (let i = 0; i < 4; i++) expect(res[i]!.kind).toBe('na');
    expect(numv(res[4]!)).toBeCloseTo(102, 9); // mean 100..104
  });

  it('bar 10 len5 = mean of closes 6..10', () => {
    const res = runBars(bars, (c) => call('sma', c, [ser(c.close), iv(5)]));
    const expected = (106 + 107 + 108 + 109 + 110) / 5;
    expect(numv(res[10]!)).toBeCloseTo(expected, 9);
  });
});

// ── ema / wma / hma / swma / vwma ───────────────────────────────────────────

describe('moving averages', () => {
  it('ema seeds at first src value and converges', () => {
    const res = runBars(mkBars(10), (c) => call('ema', c, [ser(c.close), iv(5)]));
    expect(numv(res[0]!)).toBeCloseTo(100, 9);
    const a = 2 / 6;
    let e = 100;
    for (let i = 1; i < 10; i++) e = a * (100 + i) + (1 - a) * e;
    expect(numv(res[9]!)).toBeCloseTo(e, 9);
  });

  it('wma uses linear weights', () => {
    const res = runBars(mkBars(5), (c) => call('wma', c, [ser(c.close), iv(3)]));
    expect(numv(res[4]!)).toBeCloseTo((102 + 2 * 103 + 3 * 104) / 6, 9);
  });

  it('hma smooths a ramp', () => {
    const res = runBars(mkBars(15), (c) => call('hma', c, [ser(c.close), iv(9)]));
    const v = numv(res[14]!);
    expect(v).toBeGreaterThan(110);
    expect(v).toBeLessThan(120);
  });

  it('swma weights 1 2 2 1', () => {
    const res = runBars(mkBars(5), (c) => call('swma', c, [ser(c.close)]));
    // bar4 window: closes 101,102,103,104 with weights 1,2,2,1 (oldest→newest)
    expect(numv(res[4]!)).toBeCloseTo((101 * 1 + 102 * 2 + 103 * 2 + 104 * 1) / 6, 9);
  });

  it('vwma weights by volume', () => {
    const bars = mkBars(3, (i) => ({ close: [10, 20, 30][i], volume: [1, 1, 2][i] }));
    const res = runBars(bars, (c) => call('vwma', c, [ser(c.close), iv(3)]));
    expect(numv(res[2]!)).toBeCloseTo((10 + 20 + 60) / 4, 9);
  });
});

// ── rma / rsi / atr / tr ────────────────────────────────────────────────────

describe('wilder family', () => {
  it('rma is na for first len-1 bars then sma-seeded', () => {
    const res = runBars(mkBars(10), (c) => call('rma', c, [ser(c.close), iv(3)]));
    expect(res[0]!.kind).toBe('na');
    expect(res[1]!.kind).toBe('na');
    const rma2 = (100 + 101 + 102) / 3;
    expect(numv(res[2]!)).toBeCloseTo(rma2, 9);
    expect(numv(res[3]!)).toBeCloseTo((103 + 2 * rma2) / 3, 9);
  });

  it('tr: bar0 na (handle_na default), else max(h-l,|h-c1|,|l-c1|)', () => {
    const bars = mkBars(3, (i) => [
      { open: 10, high: 12, low: 8, close: 10 },
      { open: 10, high: 15, low: 9, close: 14 },
      { open: 14, high: 16, low: 13, close: 15 },
    ][i]!);
    const res = runBars(bars, (c) => call('tr', c, []));
    expect(res[0]!.kind).toBe('na');
    expect(numv(res[1]!)).toBeCloseTo(Math.max(6, 5, 1), 9);
    expect(numv(res[2]!)).toBeCloseTo(Math.max(3, 2, 1), 9);
  });

  it('tr(handle_na=false) gives h-l on bar 0', () => {
    const res = runBars(mkBars(2), (c) => call('tr', c, [], { handle_na: { kind: 'bool', v: false } }));
    expect(numv(res[0]!)).toBeCloseTo(3, 9);
  });

  it('atr non-negative after warmup', () => {
    const res = runBars(mkBars(30), (c) => call('atr', c, [iv(10)]));
    expect(res[9]!.kind).toBe('na'); // tr bar0 = na → rma seeds at bar 10
    for (let i = 10; i < 30; i++) expect(numv(res[i]!)).toBeGreaterThanOrEqual(0);
  });

  it('rsi in 0..100, =100 on monotonic rise', () => {
    const res = runBars(mkBars(40), (c) => call('rsi', c, [ser(c.close), iv(14)]));
    for (let i = 14; i < 40; i++) {
      const v = numv(res[i]!);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(numv(res[39]!)).toBe(100);
  });

  it('rsi ~50 on alternating closes', () => {
    const bars = mkBars(40, (i) => ({ close: i % 2 === 0 ? 100 : 101, high: 102, low: 99 }));
    const res = runBars(bars, (c) => call('rsi', c, [ser(c.close), iv(14)]));
    expect(numv(res[39]!)).toBeGreaterThan(30);
    expect(numv(res[39]!)).toBeLessThan(70);
  });
});

// ── highest/lowest/bars ─────────────────────────────────────────────────────

describe('extremes', () => {
  const bars = mkBars(10, (i) => ({ high: 10 + i, low: 10 - i, close: 10 }));

  it('highest/lowest over window', () => {
    const res = runBars(bars, (c) => call('highest', c, [ser(c.high), iv(4)]));
    expect(numv(res[9]!)).toBe(19);
    const resL = runBars(bars, (c) => call('lowest', c, [ser(c.low), iv(4)]));
    expect(numv(resL[9]!)).toBe(1);
  });

  it('highest(5) single-arg form uses high', () => {
    const res = runBars(bars, (c) => call('highest', c, [iv(5)]));
    expect(numv(res[9]!)).toBe(19);
  });

  it('highestbars returns negative offset of max', () => {
    const b2 = mkBars(6, (i) => ({ high: [1, 2, 9, 3, 4, 5][i]!, low: 0, close: 0 }));
    const res = runBars(b2, (c) => call('highestbars', c, [iv(6)]));
    expect(numv(res[5]!)).toBe(-3); // max at bar 2 → -3
  });

  it('lowestbars returns negative offset of min', () => {
    const b2 = mkBars(6, (i) => ({ low: [9, 8, 1, 3, 4, 5][i]!, high: 10, close: 0 }));
    const res = runBars(b2, (c) => call('lowestbars', c, [iv(6)]));
    expect(numv(res[5]!)).toBe(-3);
  });
});

// ── cross family ─────────────────────────────────────────────────────────────

describe('cross', () => {
  it('detects crossover only at the crossing bar', () => {
    const sA = new Series(), sB = new Series();
    const aVals = [1, 1, 1, 3, 3, 3], bVals = [2, 2, 2, 2, 2, 2];
    const bars = mkBars(6);
    const ctx = newCtx(bars);
    const over: boolean[] = [], under: boolean[] = [], any: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      pushBar(ctx, bars[i]!, i);
      sA.set(fv(aVals[i]!));
      sB.set(fv(bVals[i]!));
      over.push(truthy(call('crossover', ctx, [ser(sA), ser(sB)])));
      under.push(truthy(call('crossunder', ctx, [ser(sA), ser(sB)])));
      any.push(truthy(call('cross', ctx, [ser(sA), ser(sB)])));
    }
    expect(over).toEqual([false, false, false, true, false, false]);
    expect(under).toEqual([false, false, false, false, false, false]);
    expect(any).toEqual([false, false, false, true, false, false]);
  });

  it('detects crossunder', () => {
    const sA = new Series(), sB = new Series();
    const aVals = [3, 3, 3, 1, 1], bVals = [2, 2, 2, 2, 2];
    const bars = mkBars(5);
    const ctx = newCtx(bars);
    const under: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      pushBar(ctx, bars[i]!, i);
      sA.set(fv(aVals[i]!));
      sB.set(fv(bVals[i]!));
      under.push(truthy(call('crossunder', ctx, [ser(sA), ser(sB)])));
    }
    expect(under).toEqual([false, false, false, true, false]);
  });
});

// ── macd ─────────────────────────────────────────────────────────────────────

describe('ta.macd', () => {
  it('returns [macd, signal, hist] array', () => {
    const res = runBars(mkBars(60), (c) =>
      call('macd', c, [ser(c.close), iv(12), iv(26), iv(9)]));
    const v = arrv(res[59]!);
    expect(v).toHaveLength(3);
    expect(numv(v[2]!)).toBeCloseTo(numv(v[0]!) - numv(v[1]!), 9);
    expect(numv(v[0]!)).toBeGreaterThan(0); // steady uptrend
  });
});

// ── supertrend ───────────────────────────────────────────────────────────────

describe('ta.supertrend', () => {
  it('returns [line, dir] and flips to uptrend (-1) on reversal', () => {
    const bars = mkBars(40, (i) => {
      const c = i < 20 ? 100 - i * 2 : 60 + (i - 20) * 2;
      return { open: c, high: c + 1.5, low: c - 1.5, close: c };
    });
    const res = runBars(bars, (c) => call('supertrend', c, [fv(3), iv(10)]));
    const v = arrv(res[39]!);
    expect(v).toHaveLength(2);
    expect(numv(v[1]!)).toBe(-1); // Pine: dir -1 = uptrend
    expect(numv(v[0]!)).toBeLessThan(bars[39]!.close); // lower band under price
  });
});

// ── misc window stats ────────────────────────────────────────────────────────

describe('window stats', () => {
  it('stdev/variance on a known window', () => {
    const bars = mkBars(6, (i) => ({ close: i, high: i + 1, low: Math.max(0, i - 1), open: i }));
    const res = runBars(bars, (c) => call('variance', c, [ser(c.close), iv(5)]));
    expect(numv(res[5]!)).toBeCloseTo(2, 9); // var(1..5)=2 population? window bars1..5 → values 1..5 var=2
    const res2 = runBars(bars, (c) => call('stdev', c, [ser(c.close), iv(5)]));
    expect(numv(res2[5]!)).toBeCloseTo(Math.SQRT2, 9);
  });

  it('median/mode/percentiles', () => {
    const bars = mkBars(5, (i) => ({ close: [3, 1, 4, 1, 5][i]! }));
    const res = runBars(bars, (c) => call('median', c, [ser(c.close), iv(5)]));
    expect(numv(res[4]!)).toBe(3);
    const resM = runBars(bars, (c) => call('mode', c, [ser(c.close), iv(5)]));
    expect(numv(resM[4]!)).toBe(1);
    const resP = runBars(bars, (c) => call('percentile_nearest_rank', c, [ser(c.close), iv(5), fv(50)]));
    expect(numv(resP[4]!)).toBe(3); // sorted 1,1,3,4,5 → rank ceil(2.5)=3 → 3
    const resL = runBars(bars, (c) => call('percentile_linear_interpolation', c, [ser(c.close), iv(5), fv(25)]));
    expect(numv(resL[4]!)).toBeCloseTo(1, 9); // pos=1 → sorted[1]=1
  });

  it('change/roc/mom', () => {
    const bars = mkBars(10);
    const res = runBars(bars, (c) => call('change', c, [ser(c.close)]));
    expect(res[0]!.kind).toBe('na');
    expect(numv(res[5]!)).toBeCloseTo(1, 9);
    const resR = runBars(bars, (c) => call('roc', c, [ser(c.close), iv(5)]));
    expect(numv(resR[9]!)).toBeCloseTo(100 * (109 - 104) / 104, 9);
    const resM = runBars(bars, (c) => call('mom', c, [ser(c.close), iv(4)]));
    expect(numv(resM[9]!)).toBeCloseTo(4, 9);
  });

  it('cum/sum', () => {
    const bars = mkBars(5);
    const res = runBars(bars, (c) => call('cum', c, [ser(c.close)]));
    expect(numv(res[4]!)).toBeCloseTo(100 + 101 + 102 + 103 + 104, 9);
    const resS = runBars(bars, (c) => call('sum', c, [ser(c.close), iv(3)]));
    expect(numv(resS[4]!)).toBeCloseTo(102 + 103 + 104, 9);
  });

  it('cor ~1 for linearly related series', () => {
    const res = runBars(mkBars(10), (c) => call('cor', c, [ser(c.close), ser(c.high), iv(5)]));
    expect(numv(res[9]!)).toBeGreaterThan(0.9);
  });

  it('dev = mean absolute deviation', () => {
    const bars = mkBars(4, (i) => ({ close: [1, 2, 3, 4][i]! }));
    const res = runBars(bars, (c) => call('dev', c, [ser(c.close), iv(4)]));
    // |1-2.5|+|2-2.5|+|3-2.5|+|4-2.5| = 4 → /4 = 1
    expect(numv(res[3]!)).toBeCloseTo(1, 9);
  });
});

// ── pivots ───────────────────────────────────────────────────────────────────

describe('pivots', () => {
  it('pivothigh detects peak rightbars ago', () => {
    const bars = mkBars(7, (i) => ({ high: [1, 2, 5, 4, 3, 2, 1][i]!, low: 0, close: 0 }));
    const res = runBars(bars, (c) => call('pivothigh', c, [ser(c.high), iv(2), iv(2)]));
    expect(res[3]!.kind).toBe('na');
    expect(numv(res[4]!)).toBe(5); // peak at bar 2 reported at bar 4
    expect(res[5]!.kind).toBe('na');
  });

  it('pivotlow(3,3) overload on low', () => {
    const bars = mkBars(9, (i) => ({ low: [9, 8, 7, 6, 1, 6, 7, 8, 9][i]!, high: 10, close: 5 }));
    const res = runBars(bars, (c) => call('pivotlow', c, [iv(3), iv(3)]));
    expect(numv(res[7]!)).toBe(1); // trough bar 4 reported bar 7
  });
});

// ── volume/accumulation ──────────────────────────────────────────────────────

describe('volume indicators', () => {
  it('obv adds/subtracts volume', () => {
    const bars = mkBars(4, (i) => ({ close: [10, 11, 10, 12][i]!, volume: [100, 200, 300, 400][i]! }));
    const res = runBars(bars, (c) => call('obv', c, [ser(c.close)]));
    expect(res[0]!.kind).toBe('na');
    expect(numv(res[3]!)).toBeCloseTo(300, 9); // 0+200-300+400
  });

  it('wad finite', () => {
    const bars = mkBars(10, (i) => ({ close: 100 + i, high: 102 + i, low: 99 + i }));
    const res = runBars(bars, (c) => call('wad', c, []));
    expect(Number.isFinite(numv(res[9]!))).toBe(true);
  });

  it('pvt/vwap/nvi/pvi finite', () => {
    const bars = mkBars(20);
    const p = runBars(bars, (c) => call('pvt', c, []));
    expect(Number.isFinite(numv(p[19]!))).toBe(true);
    const vw = runBars(bars, (c) => call('vwap', c, []));
    expect(numv(vw[19]!)).toBeGreaterThan(0);
    const n = runBars(bars, (c) => call('nvi', c, []));
    const pv = runBars(bars, (c) => call('pvi', c, []));
    // monotonically increasing volume → nvi stays 1000, pvi rises
    expect(numv(n[19]!)).toBe(1000);
    expect(numv(pv[19]!)).toBeGreaterThan(1000);
  });

  it('mfi in 0..100', () => {
    const res = runBars(mkBars(30), (c) => call('mfi', c, [ser(c.hlc3), iv(14)]));
    const v = numv(res[29]!);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });
});

// ── oscillator misc ─────────────────────────────────────────────────────────

describe('oscillators', () => {
  it('cci/cmo/cog/wpr sane values', () => {
    const bars = mkBars(25);
    const cci = runBars(bars, (c) => call('cci', c, [ser(c.hlc3), iv(14)]));
    expect(Number.isFinite(numv(cci[24]!))).toBe(true);
    const cmo = runBars(bars, (c) => call('cmo', c, [ser(c.close), iv(9)]));
    expect(numv(cmo[24]!)).toBe(100); // strictly rising
    const cog = runBars(bars, (c) => call('cog', c, [ser(c.close), iv(10)]));
    expect(numv(cog[24]!)).toBeLessThan(0);
    const wpr = runBars(bars, (c) => call('wpr', c, [iv(14)]));
    const w = numv(wpr[24]!);
    expect(w).toBeGreaterThanOrEqual(-100);
    expect(w).toBeLessThanOrEqual(0);
  });

  it('linreg fits a perfect ramp to the last value', () => {
    const res = runBars(mkBars(10), (c) => call('linreg', c, [ser(c.close), iv(5), iv(0)]));
    expect(numv(res[9]!)).toBeCloseTo(109, 9);
  });

  it('tsi in -100..100, positive in uptrend', () => {
    const res = runBars(mkBars(60), (c) => call('tsi', c, [ser(c.close), iv(13), iv(25)]));
    const v = numv(res[59]!);
    expect(v).toBeGreaterThanOrEqual(-100);
    expect(v).toBeLessThanOrEqual(100);
    expect(v).toBeGreaterThan(0);
  });

  it('vortex returns [vi+, vi-]', () => {
    const res = runBars(mkBars(30), (c) => call('vortex', c, [iv(14)]));
    const v = arrv(res[29]!);
    expect(v).toHaveLength(2);
    expect(numv(v[0]!)).toBeGreaterThan(0);
  });

  it('dmi returns [+di, -di, adx]', () => {
    const res = runBars(mkBars(40), (c) => call('dmi', c, [iv(14), iv(14)]));
    const v = arrv(res[39]!);
    expect(v).toHaveLength(3);
    expect(numv(v[0]!)).toBeGreaterThan(numv(v[1]!)); // uptrend: +di > -di
  });

  it('kc returns [basis, upper, lower]', () => {
    const res = runBars(mkBars(40), (c) => call('kc', c, [iv(20), fv(2)]));
    const v = arrv(res[39]!);
    expect(v).toHaveLength(3);
    expect(numv(v[1]!)).toBeGreaterThan(numv(v[0]!));
    expect(numv(v[0]!)).toBeGreaterThan(numv(v[2]!));
  });

  it('sar is positive and finite', () => {
    const res = runBars(mkBars(30), (c) => call('sar', c, []));
    expect(numv(res[29]!)).toBeGreaterThan(0);
  });

  it('fisher returns [fisher, trigger]', () => {
    const res = runBars(mkBars(30), (c) => call('fisher', c, [ser(c.hlc3), iv(9)]));
    const v = arrv(res[29]!);
    expect(v).toHaveLength(2);
    expect(Number.isFinite(numv(v[0]!))).toBe(true);
  });

  it('nadarayaWatsonEnvelope returns [upper, lower]', () => {
    const res = runBars(mkBars(40), (c) => call('nadarayaWatsonEnvelope', c, [ser(c.close)]));
    const v = arrv(res[39]!);
    expect(v).toHaveLength(2);
    expect(numv(v[0]!)).toBeGreaterThan(numv(v[1]!));
  });
});

// ── stoch / valuewhen / bare ta.tr / ta.obv ──────────────────────────────────

describe('stoch / valuewhen / bare series', () => {
  it('ta.stoch', () => {
    const bars = mkBars(10, (i) => ({ high: i + 10, low: i, close: i + 5 }));
    const r = runBars(bars, (c) => call('stoch', c, [ser(c.close), ser(c.high), ser(c.low), iv(5)]));
    // bars 5..9 window: hi range 15..19, lo range 5..9, close 14 → 100*(14-5)/(19-5) ≈ 64.29
    expect(numv(r[9]!)).toBeCloseTo(100 * 9 / 14, 1);
  });

  it('ta.valuewhen', () => {
    const bars = mkBars(5, (i) => ({ close: i }));
    // cond true when close >= 3 (bars 3,4); occ0 → close 4, occ1 → close 3
    const cond = new Series();
    const r = runBars(bars, (c) => {
      cond.set(c.barIndex >= 3 ? { kind: 'bool', v: true } : { kind: 'bool', v: false });
      return call('valuewhen', c, [{ kind: 'series', v: cond }, ser(c.close), iv(0)]);
    });
    expect(r[2]!.kind).toBe('na');
    expect(numv(r[4]!)).toBe(4);
    const cond2 = new Series();
    const r2 = runBars(bars, (c) => {
      cond2.set(c.barIndex >= 3 ? { kind: 'bool', v: true } : { kind: 'bool', v: false });
      return call('valuewhen', c, [{ kind: 'series', v: cond2 }, ser(c.close), iv(1)]);
    });
    expect(numv(r2[4]!)).toBe(3);
  });

  it('bare ta.tr / ta.obv series', () => {
    expect(getConstant('ta.tr')).toBeDefined();
    expect(getConstant('ta.obv')).toBeDefined();
    // ta.tr used as source in ta.sum: 5 bars of tr (bar0 na → ignored)
    const bars = mkBars(5, (i) => ({ high: i + 10, low: i, close: i + 5 }));
    const r = runBars(bars, (c) => call('sum', c, [getConstant('ta.tr', c)!, iv(5)]));
    // bar i: h-l = 10 dominates |h-pc|=6,|l-pc|=4 → tr=10; bar0 na. sum=40.
    expect(numv(r[4]!)).toBe(40);
  });

  it('ta.change accepts series args (Task 5 arg tracking)', () => {
    const bars = mkBars(4, (i) => ({ close: i * 2 }));
    const r = runBars(bars, (c) => call('change', c, [ser(c.close), iv(2)]));
    expect(numv(r[3]!)).toBe(4);
  });
});
// ── evalArg series-wrap regression ───────────────────────────────────────────
// evalArg wraps EVERY int/float/bool arg in a per-callsite BarSeries, so
// builtins must unwrap before reading scalars. `wrap` simulates that wrapper.

/** Mimic evalArg: scalar → BarSeries carrying the value at the current bar. */
const wrap = (n: number) => (c: BuiltinCtx): Value => {
  const s = new BarSeries();
  s.setAt(c.barIndex, { kind: 'float', v: n });
  return { kind: 'series', v: s };
};

describe('evalArg series-wrap regressions', () => {
  it('ta.highest(N) one-arg length form with wrapped scalar', () => {
    const bars = mkBars(8);
    const r = runBars(bars, (c) => call('highest', c, [wrap(3)(c)]));
    // highest(high, 3): highs 102+i → last-3 max at bar 7 = 102+7
    expect(numv(r[7]!)).toBeCloseTo(102 + 7, 9);
  });

  it('ta.highestbars(N) one-arg form with wrapped scalar', () => {
    const bars = mkBars(6);
    const r = runBars(bars, (c) => call('highestbars', c, [wrap(4)(c)]));
    expect(numv(r[5]!)).toBe(0); // rising highs → most recent is highest
  });

  it('ta.pivothigh(src, l, r) 3-arg form with wrapped scalars', () => {
    const bars = mkBars(7, (i) => ({ high: [1, 2, 5, 4, 3, 2, 1][i]!, low: 0, close: 0 }));
    const r = runBars(bars, (c) => call('pivothigh', c, [ser(c.high), wrap(2)(c), wrap(2)(c)]));
    expect(numv(r[4]!)).toBe(5);
  });

  it('ta.pivothigh(l, r) overload with wrapped scalars uses high', () => {
    const bars = mkBars(7, (i) => ({ high: [1, 2, 5, 4, 3, 2, 1][i]!, low: 0, close: 0 }));
    const r = runBars(bars, (c) => call('pivothigh', c, [wrap(2)(c), wrap(2)(c)]));
    expect(numv(r[4]!)).toBe(5);
  });

  it('ta.bb explicit mult with wrapped scalar', () => {
    const bars = mkBars(6, (i) => ({ close: [1, 2, 3, 4, 5, 6][i]! }));
    const r = runBars(bars, (c) => call('bb', c, [ser(c.close), wrap(5)(c), wrap(3)(c)]));
    const v = arrv(r[5]!);
    // basis 4, stdev(1..5 pop) = sqrt(2) → upper = 4 + 3·√2
    expect(numv(v[0]!)).toBeCloseTo(4, 9);
    expect(numv(v[1]!)).toBeCloseTo(4 + 3 * Math.SQRT2, 9);
    expect(numv(v[2]!)).toBeCloseTo(4 - 3 * Math.SQRT2, 9);
  });
});

// ── degenerate-window na guards ──────────────────────────────────────────────

describe('degenerate windows', () => {
  const flat = mkBars(6, () => ({ close: 5, high: 5, low: 5 }));

  it('rsi flat window → na (not 50)', () => {
    const r = runBars(flat, (c) => call('rsi', c, [ser(c.close), iv(3)]));
    expect(r[5]!.kind).toBe('na');
  });
  it('cci flat window → na', () => {
    const r = runBars(flat, (c) => call('cci', c, [ser(c.close), iv(3)]));
    expect(r[5]!.kind).toBe('na');
  });
  it('wpr hh==ll → na', () => {
    const r = runBars(flat, (c) => call('wpr', c, [iv(3)]));
    expect(r[5]!.kind).toBe('na');
  });
  it('stdev/variance length 1 biased → 0', () => {
    const r = runBars(mkBars(3), (c) => call('stdev', c, [ser(c.close), iv(1)]));
    expect(numv(r[2]!)).toBe(0);
    const v = runBars(mkBars(3), (c) => call('variance', c, [ser(c.close), iv(1)]));
    expect(numv(v[2]!)).toBe(0);
  });
});

// ── kc / correlation / tsi names / vwap ─────────────────────────────────────

describe('fix regressions', () => {
  it('ta.kc honors TV arg order (source, length, mult)', () => {
    const bars = mkBars(30);
    const r = runBars(bars, (c) => call('kc', c, [ser(c.close), iv(20), fv(1.5)]));
    const v = arrv(r[29]!);
    expect(v).toHaveLength(3);
    // upper > basis > lower
    expect(numv(v[1]!)).toBeGreaterThan(numv(v[0]!));
    expect(numv(v[0]!)).toBeGreaterThan(numv(v[2]!));
  });

  it('ta.kcw alias registered', () => {
    expect(BUILTINS.has('ta.kcw')).toBe(true);
  });

  it('ta.correlation alias matches ta.cor', () => {
    const bars = mkBars(10);
    const a = runBars(bars, (c) => call('correlation', c, [ser(c.close), ser(c.high), iv(5)]));
    const b = runBars(bars, (c) => call('cor', c, [ser(c.close), ser(c.high), iv(5)]));
    expect(numv(a[9]!)).toBeCloseTo(numv(b[9]!), 12);
  });

  it('ta.tsi accepts TV names short_length/long_length', () => {
    const bars = mkBars(60);
    const named = runBars(bars, (c) =>
      call('tsi', c, [ser(c.close)], { short_length: iv(13), long_length: iv(25) }));
    const pos = runBars(bars, (c) => call('tsi', c, [ser(c.close), iv(13), iv(25)]));
    expect(numv(named[59]!)).toBeCloseTo(numv(pos[59]!), 12);
  });

  it('ta.vwap returns [vwap,upper,lower] when stdev arg present', () => {
    const bars = mkBars(10);
    const r = runBars(bars, (c) => call('vwap', c, [ser(c.hlc3), fv(1)]));
    const v = arrv(r[9]!);
    expect(v).toHaveLength(3);
    expect(numv(v[1]!)).toBeGreaterThanOrEqual(numv(v[0]!));
    expect(numv(v[0]!)).toBeGreaterThanOrEqual(numv(v[2]!));
  });

  it('ta.vwap bool anchor resets cumulative sums', () => {
    // anchor true at bars 5+ → vwap at bar 9 reflects only bars 5..9
    const bars = mkBars(10);
    const anchor = new Series();
    const r = runBars(bars, (c) => {
      anchor.set(c.barIndex >= 5 ? { kind: 'bool', v: true } : { kind: 'bool', v: false });
      return call('vwap', c, [ser(c.hlc3)], { anchor: { kind: 'series', v: anchor } });
    });
    // bars 5..9: hlc3 = (102+i + 99+i + 100+i)/3 = 100.333+i ≈; vwap ≈ mean hlc3
    const expectApprox = ((102 + 9 + 99 + 9 + 100 + 9) / 3);
    expect(numv(r[9]!)).toBeGreaterThan(expectApprox - 2); // ≈105.33, vol-weighted
    expect(numv(r[9]!)).toBeLessThan(expectApprox + 2);
  });
});
