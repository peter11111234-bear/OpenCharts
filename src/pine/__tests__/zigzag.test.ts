// Self-implemented ZigZag (TV library source unavailable). Behaviour is NOT
// guaranteed to match TradingView; only the fields .start/.end/.price/.time are
// consumed by the Pine scripts. These tests pin our own contract.

import { describe, expect, it } from 'vitest';
import {
  createZigZagState,
  zigZagLastPivot,
  zigZagStep,
  type ZigZagBar,
  type ZigZagPoint,
} from '../zigzag';

/** Same shape as the `oscBars` generator in mzigzag_semantics.test.ts. */
const oscBars = (n: number): ZigZagBar[] => {
  const bars: ZigZagBar[] = [];
  for (let i = 0; i < n; i++) {
    const p = 22000 + Math.sin(i / 8) * 500 + Math.sin(i / 3) * 80;
    bars.push({ index: i, high: p + 40, low: p - 40, time: i * 300000 });
  }
  return bars;
};

/**
 * Feed bars once, recording every pivot the way a consumer would: whenever
 * `zigZagStep` reports a new confirmation, the last pivot's `end` is the new one.
 */
const runOnce = (bars: ZigZagBar[], devPct: number, depth: number) => {
  const state = createZigZagState();
  const confirmed: boolean[] = [];
  const pivots: ZigZagPoint[] = [];
  for (const bar of bars) {
    const isPivot = zigZagStep(state, bar, devPct, depth);
    confirmed.push(isPivot);
    if (isPivot) {
      // The very first confirmation has no predecessor, so `zigZagLastPivot`
      // cannot expose it; read the confirmed list directly (public field).
      const added = state.pivots[state.pivots.length - 1];
      if (!added) throw new Error(`confirmed at bar ${bar.index} but no pivot was appended`);
      pivots.push(added);
    }
  }
  return { state, confirmed, pivots, last: zigZagLastPivot(state) };
};

const kindOf = (bars: ZigZagBar[], p: ZigZagPoint): 'high' | 'low' | 'other' => {
  const bar = bars[p.bar];
  if (!bar) return 'other';
  if (p.price === bar.high) return 'high';
  if (p.price === bar.low) return 'low';
  return 'other';
};

describe('zigzag (self-implemented)', () => {
  it('devPct = NaN: tracks but never confirms, never throws', () => {
    const bars = oscBars(50);
    const state = createZigZagState();
    for (const bar of bars) {
      expect(zigZagStep(state, bar, Number.NaN, 3)).toBe(false);
    }
    expect(zigZagLastPivot(state)).toBeUndefined();
  });

  it('oscillating series: >= 4 pivots with alternating high/low', () => {
    const bars = oscBars(200);
    const { pivots, last } = runOnce(bars, 1, 3);

    expect(pivots.length).toBeGreaterThanOrEqual(4);
    expect(last).toBeDefined();
    expect(last!.end).toEqual(pivots[pivots.length - 1]);
    expect(last!.start).toEqual(pivots[pivots.length - 2]);

    const kinds = pivots.map((p) => kindOf(bars, p));
    expect(kinds.every((k) => k === 'high' || k === 'low')).toBe(true);
    for (let i = 1; i < kinds.length; i++) {
      expect(kinds[i]).not.toBe(kinds[i - 1]);
    }
  });

  it('monotonic rise: at most one confirmation and no pivot pair', () => {
    const bars: ZigZagBar[] = [];
    for (let i = 0; i < 60; i++) {
      const low = 100 + i;
      bars.push({ index: i, high: low + 80, low, time: i * 300000 });
    }
    const { confirmed, last } = runOnce(bars, 1, 3);

    expect(confirmed.filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(last).toBeUndefined();
  });

  it('idempotent: re-processing the same index restores the previous state', () => {
    const bars = oscBars(120);
    const single = runOnce(bars, 1, 3);

    const state = createZigZagState();
    const confirmed: boolean[] = [];
    const pivots: ZigZagPoint[] = [];
    for (const bar of bars) {
      const first = zigZagStep(state, bar, 1, 3);
      zigZagStep(state, bar, 1, 3); // same index again: must be a no-op net effect
      confirmed.push(first);
      if (first) {
        const added = state.pivots[state.pivots.length - 1];
        if (!added) throw new Error(`confirmed at bar ${bar.index} but no pivot was appended`);
        pivots.push(added);
      }
    }

    expect(confirmed).toEqual(single.confirmed);
    expect(pivots).toEqual(single.pivots);
    expect(zigZagLastPivot(state)).toEqual(single.last);
  });

  it('depth gates confirmation: sufficient reversal 1 bar after the extreme', () => {
    // bar0: hi=97/lo=90 → up move 7.8% (<8%), no leg yet.
    // bar1: hi=98 vs lo=90 → 8.9% → up leg confirmed, hi=98 @ bar1.
    // bar2: low 89 is a 9.2% drop from 98, but only 1 bar after the extreme.
    const bars: ZigZagBar[] = [
      { index: 0, high: 97, low: 90, time: 0 },
      { index: 1, high: 98, low: 92, time: 300000 },
      { index: 2, high: 97, low: 89, time: 600000 },
    ];

    const shallow = runOnce(bars, 8, 5);
    expect(shallow.confirmed).toEqual([false, true, false]);
    expect(shallow.last).toBeUndefined();

    const deep = runOnce(bars, 8, 1);
    expect(deep.confirmed).toEqual([false, true, true]);
    expect(deep.last).toEqual({
      start: { price: 90, time: 0, bar: 0 },
      end: { price: 98, time: 300000, bar: 1 },
    });
  });

  it('down leg: reversal measured from the highest high since the low, not just the current bar', () => {
    // bar1 confirms the first leg (hi 100 @0 → lo 90 @1, 11% ≥ 8%).
    // bar2/bar3 print lower highs, so the rise must be measured from 99 (bar1's
    // high), not from the current bar's high (96). 99 vs 90 is 10% ≥ 8%.
    const bars: ZigZagBar[] = [
      { index: 0, high: 100, low: 99, time: 0 },
      { index: 1, high: 99, low: 90, time: 300000 },
      { index: 2, high: 97, low: 93, time: 600000 },
      { index: 3, high: 96, low: 92, time: 900000 },
    ];
    // bar2 reverses the down leg, so the new up leg's extreme is the 99 high (bar1).
    // The trough since that high is 93 (bar2); bar3 dips only to 92, a 7.1% drop
    // from 99 (< 8%), so nothing else confirms.
    const { confirmed, last } = runOnce(bars, 8, 1);

    expect(confirmed).toEqual([false, true, true, false]);
    expect(last).toEqual({
      start: { price: 100, time: 0, bar: 0 },
      end: { price: 90, time: 300000, bar: 1 },
    });
  });

  it('pivot price/time come from the actual extreme bar', () => {
    const bars = oscBars(200);
    const { pivots } = runOnce(bars, 1, 3);

    for (const p of pivots) {
      const bar = bars[p.bar]!;
      const isHigh = p.price === bar.high;
      const isLow = p.price === bar.low;
      expect(isHigh || isLow).toBe(true);
      expect(p.time).toBe(bar.time);
    }
  });
});
