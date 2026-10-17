// ── T9: ta state tables must be bounded in TOTAL, not just per leaf map ──────
// `stateFor`'s `cap` clears only the one map that holds the leaf key. A key
// whose varying dimension sits in the MIDDLE of the path — `dmi`'s `diL`,
// `kc`'s `L`/`mult` — therefore still mints a fresh nested map per distinct
// value, so the subtree total grows with the bar count even though each leaf
// map stays capped. These tests measure the whole subtree, which is the
// property that matters.

import { describe, it, expect } from 'vitest';
import '../builtins/ta';
import { BUILTINS } from '../builtins/registry';
import { Series } from '../contracts';
import type { BarData, BuiltinCtx, Value } from '../contracts';
import type { RtCtx } from '../builtins/util';

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

// ── measurement ──────────────────────────────────────────────────────────────

/** Entries across EVERY level of a `ctx.state` subtree. A per-leaf-map count
 *  cannot see a middle dimension minting new maps, so this is the measure of
 *  "the table stops growing". */
function subtreeEntries(ctx: BuiltinCtx, group: string): number {
  let n = 0;
  const walk = (m: Map<unknown, unknown>): void => {
    for (const [, v] of m) { n++; if (v instanceof Map) walk(v); }
  };
  const g = (ctx as RtCtx).state?.get(group);
  if (g instanceof Map) walk(g);
  return n;
}

/** `dmi` reads OHLC from ctx, so only (diLength, adxSmoothing) are positional;
 *  a fresh length each bar drives the middle dimension. */
function dmiEntries(bars: number): number {
  const bs = mkBars(bars);
  const ctx = newCtx(bs);
  for (let i = 0; i < bars; i++) {
    pushBar(ctx, bs[i]!, i);
    const len = iv(i + 1);
    call('dmi', ctx, [len, len]);
  }
  return subtreeEntries(ctx, 'dvs') + subtreeEntries(ctx, 'stv');
}

/** A FIXED outer dimension with a growing INNER one. `dmi`'s bound2 parts end
 *  with `diL` and its inner map is keyed by `adxL`, so two equal lengths (as
 *  above) give every outer key exactly one inner entry and `bound2`'s inner
 *  clear never fires. A constant diLength lets the inner map fill up — the
 *  only shape that exercises that branch. */
function dmiInnerEntries(bars: number): number {
  const bs = mkBars(bars);
  const ctx = newCtx(bs);
  for (let i = 0; i < bars; i++) {
    pushBar(ctx, bs[i]!, i);
    call('dmi', ctx, [iv(14), iv(i + 1)]);
  }
  return subtreeEntries(ctx, 'dvs') + subtreeEntries(ctx, 'stv');
}

/** `kc` positional order is (source, length, mult, useTrueRange); varying both
 *  L and mult drives two middle dimensions. */
function kcEntries(bars: number): number {
  const bs = mkBars(bars);
  const ctx = newCtx(bs);
  for (let i = 0; i < bars; i++) {
    pushBar(ctx, bs[i]!, i);
    call('kc', ctx, [ser(ctx.close), iv(i + 1), iv(2 + (i % 3)), { kind: 'bool', v: false }]);
  }
  return subtreeEntries(ctx, 'dvs') + subtreeEntries(ctx, 'stv');
}

describe('ta state tables stay bounded in total, not just per leaf map (T9)', () => {
  // 240 vs 480, not 120 vs 240: a capped map's size oscillates with period
  // `VS_LEN_MAX` as the length grows, so two phase-misaligned sizes differ by
  // ~cap per site even though the table is bounded (measured: 120 vs 240 gave
  // +48 dvs / +64 stv = 2 x 8 x site-count in each case). Both sizes below sit
  // on the same phase, so the totals must match outright.
  it('dmi: a fixed diLength with a growing adxSmoothing stays bounded', () => {
    // Covers bound2's INNER clear: with two equal lengths above, the inner map
    // holds one entry per outer key, so removing that clear changes nothing.
    // A fixed diLength makes the adxL map the only thing growing.
    const a = dmiInnerEntries(240), b = dmiInnerEntries(480);
    expect(a).toBeGreaterThan(0);
    expect(b - a).toBeLessThanOrEqual(32);   // no inner clear: grows ~linearly ⇒ FAIL
  });

  it('dmi: doubling the bars must not add table entries', () => {
    const a = dmiEntries(240), b = dmiEntries(480);
    expect(a).toBeGreaterThan(0);
    expect(b - a).toBeLessThanOrEqual(32);   // unfixed: grows ~linearly ⇒ FAIL
  });

  it('kc: doubling the bars must not add table entries', () => {
    const a = kcEntries(240), b = kcEntries(480);
    expect(a).toBeGreaterThan(0);
    expect(b - a).toBeLessThanOrEqual(32);   // unfixed: L and mult each mint ⇒ FAIL
  });
});
