// ── T12#4: winRing must not latch the forming bar ───────────────────────────
// `winRingReader` (builtins/ta.ts) memoizes one `vs.get(i)` per source bar per
// run. Only committed bars may be latched: the forming bar's value still
// changes within the bar, so a latched copy would serve a stale read to a later
// `get(formingBar)` in the same run. `ta.stoch` reaches the reader through its
// hi/lo sources, which makes it the shortest observable path to the latch.

import { describe, it, expect } from 'vitest';
import '../builtins/ta';
import { BUILTINS } from '../builtins/registry';
import { Series } from '../contracts';
import { BarSeries } from '../series';
import type { BarData, BuiltinCtx, Value } from '../contracts';

// ── helper: copied verbatim from ta.test.ts ──────────────────────────────────
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
    plots: [], drawings: [], warnings: [], alerts: [], logs: [],
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
// ────────────────────────────────────────────────────────────────────────────

describe('winRing must not latch the forming bar (T12#4)', () => {
  it('re-reading after rewriting the forming bar returns the new value', () => {
    const bars = mkBars(6);                       // close = 100 + i ⇒ close[5] = 105
    const ctx = newCtx(bars);
    // Both source series live outside the bar loop: every `ta.stoch` call then
    // resolves the SAME VS for them, so one ring is shared across the calls.
    const hi = new BarSeries(), lo = new BarSeries();

    let atFormingBar: Value | undefined;
    for (let i = 0; i < bars.length; i++) {
      pushBar(ctx, bars[i]!, i);
      hi.setAt(i, fv(10));
      lo.setAt(i, fv(0));
      const v = call('stoch', ctx, [ser(ctx.close), ser(hi), ser(lo), iv(2)]);
      if (i === bars.length - 1) atFormingBar = v;  // read before the rewrite
    }

    // Rewrite the forming bar's source in place — still the same bar, still
    // barIndex 5. 100*(105-0)/(10-0) = 1050, then 100*(105-0)/(20-0) = 525.
    expect(numv(atFormingBar!)).toBe(1050);
    hi.setAt(bars.length - 1, fv(20));
    expect(numv(call('stoch', ctx, [ser(ctx.close), ser(hi), ser(lo), iv(2)]))).toBe(525);
  });
});
