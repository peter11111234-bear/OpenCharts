// ── ta.* stdlib-alignment additions ─────────────────────────────────────────
// The 13 TV v6 names the engine did not answer: ta.accdist, ta.alma,
// ta.barssince, ta.falling, ta.iii, ta.max, ta.min, ta.percentrank,
// ta.pivot_point_levels, ta.range, ta.rci, ta.rising, ta.wvad.
// Semantics per the official reference; values hand-computed below.

import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { BUILTINS, getConstant } from '../builtins/registry';
import '../builtins/index';
import type { BarData } from '../contracts';

const bar = (i: number, o: number, h: number, l: number, c: number, v = 100): BarData =>
  ({ openTime: i * 60000, open: o, high: h, low: l, close: c, volume: v });

const fromCloses = (closes: number[]): BarData[] =>
  closes.map((c, i) => bar(i, c, c + 1, c - 1, c));

/** Run `plot(<expr>, "x")` over the bars and return the plotted series. */
async function plotOver(bars: BarData[], src: string): Promise<(number | null)[]> {
  const r = await runScript(parse(`${src}\nplot(x, "x")`), bars, { symbol: 'TEST', timeframe: 'D' });
  return (r.plots.get('x')?.values ?? []).map((v) => (v.kind === 'int' || v.kind === 'float' ? v.v : null));
}

/** Plot the expression itself — a bare `x = <series>` binding would keep the
 *  series Value un-unwrapped and plot nothing. */
const asExpr = (expr: string, bars: BarData[]): Promise<(number | null)[]> =>
  plotOver(bars, `plot(${expr}, "x")`);

describe('ta.* stdlib alignment', () => {
  it('registers every previously missing name', () => {
    for (const n of ['alma', 'barssince', 'falling', 'max', 'min', 'percentrank',
      'pivot_point_levels', 'range', 'rci', 'rising']) {
      expect(BUILTINS.has(`ta.${n}`), `ta.${n}`).toBe(true);
    }
    // Variables in TV (`plot(ta.iii)`), so they resolve as constants.
    for (const n of ['accdist', 'iii', 'wvad']) {
      expect(getConstant(`ta.${n}`), `ta.${n}`).toBeDefined();
    }
  });

  it('ta.iii / ta.wvad are per-bar and ta.accdist accumulates', async () => {
    // bar0: iii = ((2·2.5−3−1)/(3−1))·10 = 5 ; wvad = ((2.5−1)/2)·10 = 7.5
    //       accdist = ((2.5−1)−(3−2.5))/2·10 = 5
    // bar1: iii = ((2·3.5−4−2)/2)·20 = 10 ; wvad = ((3.5−2)/2)·20 = 15
    //       accdist = 5 + ((3.5−2)−(4−3.5))/2·20 = 15
    const bars = [bar(0, 1, 3, 1, 2.5, 10), bar(1, 2, 4, 2, 3.5, 20)];
    expect(await asExpr('ta.iii', bars)).toEqual([5, 10]);
    expect(await asExpr('ta.wvad', bars)).toEqual([7.5, 15]);
    expect(await asExpr('ta.accdist', bars)).toEqual([5, 15]);
  });

  it('ta.max / ta.min run over the whole chart so far', async () => {
    const bars = fromCloses([5, 3, 8, 2]);
    expect(await asExpr('ta.max(close)', bars)).toEqual([5, 5, 8, 8]);
    expect(await asExpr('ta.min(close)', bars)).toEqual([5, 3, 3, 2]);
  });

  it('ta.barssince counts bars since the condition last held, na if never', async () => {
    const bars = fromCloses([5, 7, 6, 8, 4]);
    expect(await asExpr('ta.barssince(close > 6)', bars)).toEqual([null, 0, 1, 0, 1]);
  });

  it('ta.rising / ta.falling test `length` consecutive strict moves', async () => {
    // Booleans do not plot; map to 1/0.
    const rising = fromCloses([1, 2, 3, 3, 4]);
    expect(await asExpr('ta.rising(close, 2) ? 1 : 0', rising)).toEqual([0, 0, 1, 0, 0]);
    expect(await asExpr('ta.falling(close, 2) ? 1 : 0', rising)).toEqual([0, 0, 0, 0, 0]);
    const falling = fromCloses([5, 4, 3, 3, 2]);
    expect(await asExpr('ta.falling(close, 2) ? 1 : 0', falling)).toEqual([0, 0, 1, 0, 0]);
  });

  it('ta.range spans the last `length` values', async () => {
    const bars = fromCloses([1, 5, 3, 4, 2]);
    // windows {1,5,3}→4, {5,3,4}→2, {3,4,2}→2
    expect(await asExpr('ta.range(close, 3)', bars)).toEqual([null, null, 4, 2, 2]);
  });

  it('ta.percentrank is the share of prior values at or below the current one', async () => {
    const bars = fromCloses([5, 1, 2, 3, 4]);
    // bar4: current 4 vs {3,2,1,5} → 3 of 4 → 75
    expect(await asExpr('ta.percentrank(close, 4)', bars)).toEqual([null, null, null, null, 75]);
  });

  it('ta.rci is ±100 for a monotonic window', async () => {
    const up = fromCloses([1, 2, 3, 4, 5]);
    expect((await asExpr('ta.rci(close, 4)', up))[4]).toBeCloseTo(100);
    const down = fromCloses([5, 4, 3, 2, 1]);
    expect((await asExpr('ta.rci(close, 4)', down))[4]).toBeCloseTo(-100);
  });

  it('ta.alma reproduces a constant source and waits for a full window', async () => {
    const flat = fromCloses(Array.from({ length: 12 }, () => 10));
    const out = await asExpr('ta.alma(close, 9, 0.85, 6)', flat);
    for (let i = 0; i < 8; i++) expect(out[i], `bar ${i}`).toBeNull();
    expect(out[11]).toBeCloseTo(10);
  });

  it('ta.pivot_point_levels publishes the closed period once the anchor fires', async () => {
    // period 0 = {h3, l1, c2} → Traditional P = (3+1+2)/3 = 2, R1 = 3, S1 = 1.
    const bars = [bar(0, 1, 3, 1, 2), bar(1, 2, 5, 2, 4), bar(2, 3, 6, 3, 5), bar(3, 4, 7, 4, 6)];
    const src = 'ta.pivot_point_levels("Traditional", bar_index == 1)';
    expect(await asExpr(`array.get(${src}, 0)`, bars)).toEqual([null, 2, 2, 2]);
    expect(await asExpr(`array.get(${src}, 1)`, bars)).toEqual([null, 3, 3, 3]);
    expect(await asExpr(`array.get(${src}, 2)`, bars)).toEqual([null, 1, 1, 1]);
  });

  it('rejects an unknown pivot type', async () => {
    const bars = [bar(0, 1, 3, 1, 2), bar(1, 2, 5, 2, 4)];
    await expect(plotOver(bars, 'x = array.get(ta.pivot_point_levels("Nope", bar_index == 1), 0)'))
      .rejects.toThrow(/invalid argument 'Nope'/);
  });
});
