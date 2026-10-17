// ── strategy equity / openprofit / max_drawdown tests ───────────────────────
// Read-side plumbing: lazy constants replay the order ledger per bar and
// mark the open position to that bar's close.

import { describe, expect, it } from 'vitest';
import type { BarData, BuiltinCtx, Value } from '../contracts';
import { BarCtx } from '../context';
import '../builtins';
import { BUILTINS, getConstant } from '../builtins';

function mkBars(closes: number[]): BarData[] {
  return closes.map((c, i) => ({
    openTime: i * 60000,
    open: c,
    high: c + 2,
    low: c - 2,
    close: c,
    volume: 1000 + i,
  }));
}

function mkRtCtx(bars: BarData[]): { ctx: BuiltinCtx & { state: Map<string, unknown> }; barCtx: BarCtx } {
  const barCtx = new BarCtx(bars, { market: 'D' });
  const ctx = barCtx.seek(0) as BuiltinCtx & { state: Map<string, unknown> };
  ctx.state = new Map();
  return { ctx, barCtx };
}

function callStrategy(name: string, args: Value[] = [], named: Record<string, Value> = {}, ctx?: BuiltinCtx): Value {
  const fn = BUILTINS.get(`strategy.${name}`);
  if (!fn) throw new Error(`strategy.${name} not registered`);
  return fn(ctx ?? mkRtCtx(mkBars([0])).ctx, args, named);
}

function numV(v: Value | undefined): number {
  return v && (v.kind === 'int' || v.kind === 'float') ? v.v : NaN;
}

// Flat closes: fills land at the next bar's open.
describe('strategy equity plumbing', () => {
  it('equity = initial + realized + unrealized, per bar, for a 2-trade script', () => {
    const { ctx, barCtx } = mkRtCtx(mkBars([10, 11, 12, 13, 14, 15]));

    // bar0: no orders → flat equity = initial_capital (default 100000)
    expect(numV(getConstant('strategy.equity', ctx))).toBe(100000);
    expect(numV(getConstant('strategy.openprofit', ctx))).toBe(0);
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBe(0);

    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(1); // fills bar1 open=11 → +1 long; close 11 → mtm 0
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100000);
    expect(numV(getConstant('strategy.openprofit', ctx))).toBeCloseTo(0);

    barCtx.seek(2); // close 12 → unrealized +1
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100001);
    expect(numV(getConstant('strategy.openprofit', ctx))).toBeCloseTo(1);
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBe(0);

    callStrategy('entry', [{ kind: 'string', v: 'S' }, { kind: 'string', v: 'strategy.short' }], {}, ctx);
    barCtx.seek(3); // reversal at open 13: realized +2, short -1 at 13
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100002);
    expect(numV(getConstant('strategy.openprofit', ctx))).toBeCloseTo(0);
    expect(numV(getConstant('strategy.closedtrades', ctx))).toBe(1);

    barCtx.seek(4); // close 14 → short unrealized -1
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100001);
    expect(numV(getConstant('strategy.openprofit', ctx))).toBeCloseTo(-1);
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(1);

    barCtx.seek(5); // close 15 → short unrealized -2
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100000);
    expect(numV(getConstant('strategy.openprofit', ctx))).toBeCloseTo(-2);
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(2);
  });

  it('max_drawdown tracks the deepest peak-to-trough, then holds after recovery', () => {
    const { ctx, barCtx } = mkRtCtx(mkBars([10, 10, 8, 6, 9, 12, 11]));
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(1); // fills at open 10, close 10 → equity 100000
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100000);
    barCtx.seek(2); // close 8 → equity 99998, dd 2
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(2);
    barCtx.seek(3); // close 6 → equity 99996, dd 4
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(4);
    barCtx.seek(4); // close 9 → equity 99999; recovery doesn't shrink dd
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(4);
    barCtx.seek(5); // close 12 → equity 100002 new peak; dd holds 4
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100002);
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(4);
    barCtx.seek(6); // close 11 → equity 100001, dd vs new peak = 1 < 4
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(4);
  });

  it('max_runup tracks the deepest trough-to-peak, then holds after a pullback', () => {
    const { ctx, barCtx } = mkRtCtx(mkBars([10, 10, 8, 6, 9, 12, 11]));
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    // equity = [100000,100000,99998,99996,99999,100002,100001]; the trough
    // bottoms at 99996 (bar3), so runup peaks at 100002−99996 = 6 at bar5 and
    // holds after the bar6 pullback (100001−99996 = 5 < 6).
    const ru: number[] = [];
    for (let b = 0; b < 7; b++) {
      if (b > 0) barCtx.seek(b);
      ru.push(numV(getConstant('strategy.max_runup', ctx)));
    }
    expect(ru).toEqual([0, 0, 0, 0, 3, 6, 6]);
  });

  it('a forming-bar tick re-records the curve so a same-bar re-read sees new drawdown', () => {
    // Deliberate change (P4 §2.4), treated as a bug fix: the recorder
    // re-records the forming bar on a tick, so re-reading max_drawdown at the
    // same bar reflects the new close instead of holding the first-read value.
    const bars = mkBars([10, 10, 8]);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(1); // fills at open 10, close 10 → equity 100000, dd 0
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(0);
    // Tick: bar1 close 10 → 6 shows a −4 mark-to-market loss on the open long.
    barCtx.updateBar({ ...bars[1]!, close: 6, high: 10, low: 4 });
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(4);
  });

  it('max_drawdown is 0 with no orders and stays 0 while flat', () => {
    const { ctx, barCtx } = mkRtCtx(mkBars([10, 11, 12]));
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBe(0);
    barCtx.seek(1);
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBe(0);
    barCtx.seek(2);
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBe(0);
  });

  it('realized loss drops equity and the drawdown persists once flat', () => {
    // Buy at 11 (bar1 open), exit fills bar3 open 7 → realized -4 while flat.
    const { ctx, barCtx } = mkRtCtx(mkBars([10, 11, 8, 7, 7]));
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(1); // long at 11, close 11 → equity 100000
    callStrategy('close', [{ kind: 'string', v: 'L' }], {}, ctx);
    barCtx.seek(2); // close placed bar1 fills bar2 open 8 → realized -3
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(99997);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(0);
    expect(numV(getConstant('strategy.openprofit', ctx))).toBe(0);
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(3);
    barCtx.seek(4); // flat: equity pinned at 99997, drawdown persists
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(99997);
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(3);
  });
});
