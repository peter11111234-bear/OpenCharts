// ── QA-R1-B: error + boundary paths after the perf commits ──────────────────
// Covers the observable-invariant surfaces the perf work touched:
//   1. calendar builtins (hour/minute/year/dayofweek) on NA ctx.time → na,
//      not 0 — the partsRec memo must not turn a missing part into 0.
//   2. input.int override: ctx.inputs beats defval through the per-callsite
//      recordAndOverride memo.
//   3. UDF f(x)=>x[1]+x with a literal arg f(20): the UDF path must keep the
//      real callHist BarSeries (NOT the LitSeries builtin fast-path), so
//      x[1] is na on bar 0 and 20 after → na/40/40.
//   4. Two ta.sma(close,5) callsites don't share state — each produces the
//      correct SMA (a shared callsite key would double-feed one window).
//   5. time('W') → na on non-week-boundary bars, bar open time on Mondays.

import { describe, expect, it } from 'vitest';
import { NA, Series, type BuiltinCtx, type RunResult, type Value } from '../contracts';
import { BUILTINS } from '../builtins/registry';
import type { RtCtx } from '../builtins/util';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';

const mkCtx = (over: Partial<BuiltinCtx> = {}): BuiltinCtx => ({
  barIndex: 0,
  barCount: 1,
  open: new Series(),
  high: new Series(),
  low: new Series(),
  close: new Series(),
  volume: new Series(),
  time: new Series(),
  hl2: new Series(),
  hlc3: new Series(),
  ohlc4: new Series(),
  hlcc4: new Series(),
  plots: [],
  drawings: [],
  warnings: [],
  alerts: [],
  syminfo: { timezone: { kind: 'string', v: 'UTC' } },
  timeframe: {
    period: 'D',
    multiplier: 1,
    isseconds: false,
    isminutes: false,
    isdaily: true,
    isweekly: false,
    ismonthly: false,
    isintraday: false,
  },
  callUdf: () => NA,
  ...over,
});

const intV = (v: number): Value => ({ kind: 'int', v });
const strV = (v: string): Value => ({ kind: 'string', v });

const call = (name: string, args: Value[] = [], named: Record<string, Value> = {}, ctx = mkCtx()): Value => {
  const fn = BUILTINS.get(name);
  if (!fn) throw new Error(`builtin not registered: ${name}`);
  return fn(ctx, args, named);
};

/** plot values of plot index i, 'na' for kind==='na'. */
const plotVals = (r: RunResult, i = 0): unknown[] => {
  const plot = Array.from(r.plots.values())[i];
  if (!plot) throw new Error(`plot[${i}] missing — have ${r.plots.size}`);
  return plot.values.map(v => (v.kind === 'na' ? 'na' : v.v));
};

// ── 1. calendar fields on NA ctx.time → na (never 0) ────────────────────────
describe('calendar builtins on NA ctx.time', () => {
  // mkCtx() leaves `time` an empty Series → ctx.time.get(0) === NA.
  const naCtx = mkCtx();
  for (const name of ['hour', 'minute', 'year', 'dayofweek'] as const) {
    it(`${name} returns na`, () => {
      const v = call(name, [], {}, naCtx);
      expect(v.kind).toBe('na');
    });
  }

  it('still na when the explicit time arg is na', () => {
    const v = call('hour', [NA], {}, naCtx);
    expect(v.kind).toBe('na');
  });

  it('control: a real time yields a number', () => {
    const s = new Series();
    s.set({ kind: 'int', v: Date.UTC(2024, 0, 2, 15, 30) }); // Tue 15:30 UTC
    const ctx = mkCtx({ time: s, syminfo: { timezone: strV('UTC') } });
    const v = call('hour', [], {}, ctx);
    expect(v).toEqual({ kind: 'int', v: 15 });
  });
});

// ── 2. input.int: ctx.inputs override beats defval ──────────────────────────
describe('input.int override via memoized recordAndOverride', () => {
  const mkInputCtx = (inputs: Record<string, unknown>): RtCtx => {
    const ctx = mkCtx() as RtCtx;
    ctx.callsite = '#0';
    ctx.inputs = inputs;
    ctx.inputSchemas = [];
    return ctx;
  };

  it('override {title:0} returns 0, not defval 5', () => {
    // input.int(5, 'title') — the override key matches the input's title.
    const ctx = mkInputCtx({ title: 0 });
    const v = call('input.int', [intV(5), strV('title')], {}, ctx);
    expect(v).toEqual({ kind: 'int', v: 0 });
    // memo path (second call, same callsite) must still honor the override.
    const v2 = call('input.int', [intV(5), strV('title')], {}, ctx);
    expect(v2).toEqual({ kind: 'int', v: 0 });
  });

  it('no override returns defval 5 (memo hit path too)', () => {
    const ctx = mkInputCtx({});
    const v = call('input.int', [intV(5), strV('title')], {}, ctx);
    expect(v).toEqual({ kind: 'int', v: 5 });
    const v2 = call('input.int', [intV(5), strV('title')], {}, ctx);
    expect(v2).toEqual({ kind: 'int', v: 5 });
  });

  it('end-to-end via runScript inputValues', async () => {
    const src = 'indicator("t")\na = input.int(5, "title")\nplot(a)';
    const r = await runScript(parse(src), [
      { openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { openTime: 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ], { inputValues: { title: 0 } });
    expect(plotVals(r)).toEqual([0, 0]);
  });
});

// ── 3. UDF literal arg pinned to HEAD — x[1] needs real history ─────────────
describe('UDF f(x)=>x[1]+x with literal f(20)', () => {
  it('returns na/40/40 across bars (baseline pin semantics)', async () => {
    const src = 'indicator("t")\nf(x) => x[1] + x\nplot(f(20))';
    const r = await runScript(parse(src), [
      { openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { openTime: 60_000, open: 2, high: 2, low: 2, close: 2, volume: 1 },
      { openTime: 120_000, open: 3, high: 3, low: 3, close: 3, volume: 1 },
    ]);
    expect(plotVals(r)).toEqual(['na', 40, 40]);
  });
});

// ── 4. two ta.sma callsites are independent ─────────────────────────────────
describe('ta.sma per-callsite state', () => {
  it('two sma(close,5) callsites each yield the true SMA', async () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17];
    const bars = closes.map((c, i) => ({
      openTime: i * 60_000, open: c, high: c + 1, low: c - 1, close: c, volume: 100,
    }));
    const src = 'indicator("t")\na = ta.sma(close, 5)\nb = ta.sma(close, 5)\nplot(a)\nplot(b)';
    const r = await runScript(parse(src), bars);
    const expected: (number | 'na')[] = closes.map((_, i) =>
      i < 4 ? 'na' : closes.slice(i - 4, i + 1).reduce((s, x) => s + x, 0) / 5);
    const av = plotVals(r, 0);
    const bv = plotVals(r, 1);
    expect(av).toEqual(expected);
    expect(bv).toEqual(expected);
    // Shared state would have double-fed one window → wrong/divergent values.
    expect(bv).toEqual(av);
  });

  it('sma inside a UDF called twice still isolates per callsite', async () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17];
    const bars = closes.map((c, i) => ({
      openTime: i * 60_000, open: c, high: c + 1, low: c - 1, close: c, volume: 100,
    }));
    const src = 'indicator("t")\ng() => ta.sma(close, 5)\nplot(g())\nplot(g())';
    const r = await runScript(parse(src), bars);
    const expected: (number | 'na')[] = closes.map((_, i) =>
      i < 4 ? 'na' : closes.slice(i - 4, i + 1).reduce((s, x) => s + x, 0) / 5);
    expect(plotVals(r, 0)).toEqual(expected);
    expect(plotVals(r, 1)).toEqual(expected);
  });
});

// ── 5. time('W') week-boundary semantics ────────────────────────────────────
describe("time('W')", () => {
  it('na off-boundary, open time on Monday bars', async () => {
    // Daily bars starting Mon 2024-01-01 UTC (Mon 08:00 Asia/Taipei — default tz).
    const bars = Array.from({ length: 10 }, (_, i) => ({
      openTime: Date.UTC(2024, 0, 1 + i),
      open: 1, high: 1, low: 1, close: 1, volume: 1,
    }));
    const src = 'indicator("t")\nplot(time("W"))';
    const r = await runScript(parse(src), bars);
    const expected: (number | 'na')[] = bars.map((b, i) =>
      i === 0 || i === 7 ? b.openTime : 'na');
    expect(plotVals(r)).toEqual(expected);
  });
});
