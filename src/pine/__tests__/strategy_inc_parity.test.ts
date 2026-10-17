// ── strategy incremental parity & read-order immunity test ─────────────────
// Tests that:
// 1. Calling strategy.max_drawdown (which replays one-shot simulate per bar)
//    does NOT corrupt or wipe the resumable stepper cursor used by simAt.
// 2. Reading order-invariant: [drawdown then equity] vs [equity then drawdown]
//    must produce identical position_size, equity, and execs across bars.
// 3. Counterfactual parity: Stepper results must match from-scratch full replay.

import { describe, expect, it } from 'vitest';
import type { BarData, BuiltinCtx, Value } from '../contracts';
import { BarCtx } from '../context';
import '../builtins';
import { BUILTINS, getConstant } from '../builtins';
import { execsAt } from '../builtins/strategy';

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

describe('strategy stepper parity & read-order immunity', () => {
  it('read order: drawdown before equity vs equity before drawdown produces identical fills & equity', () => {
    const bars = mkBars([10, 11, 12, 13, 14, 15, 14, 13, 12, 11]);

    // Scenario 1: Always read equity/pos FIRST, then max_drawdown
    const s1 = mkRtCtx(bars);
    const pos1: number[] = [];
    const eq1: number[] = [];
    const dd1: number[] = [];

    // Scenario 2: Always read max_drawdown FIRST, then equity/pos
    const s2 = mkRtCtx(bars);
    const pos2: number[] = [];
    const eq2: number[] = [];
    const dd2: number[] = [];

    for (let b = 0; b < bars.length; b++) {
      s1.barCtx.seek(b);
      s2.barCtx.seek(b);

      // Bar 0: Enter Long
      if (b === 0) {
        callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, s1.ctx);
        callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, s2.ctx);
      }
      // Bar 4: Close Long, Enter Short
      if (b === 4) {
        callStrategy('close', [{ kind: 'string', v: 'L' }], {}, s1.ctx);
        callStrategy('entry', [{ kind: 'string', v: 'S' }, { kind: 'string', v: 'strategy.short' }], {}, s1.ctx);

        callStrategy('close', [{ kind: 'string', v: 'L' }], {}, s2.ctx);
        callStrategy('entry', [{ kind: 'string', v: 'S' }, { kind: 'string', v: 'strategy.short' }], {}, s2.ctx);
      }

      // S1: Equity then Drawdown
      pos1.push(numV(getConstant('strategy.position_size', s1.ctx)));
      eq1.push(numV(getConstant('strategy.equity', s1.ctx)));
      dd1.push(numV(getConstant('strategy.max_drawdown', s1.ctx)));

      // S2: Drawdown then Equity (hazard path if cursor is wiped!)
      dd2.push(numV(getConstant('strategy.max_drawdown', s2.ctx)));
      eq2.push(numV(getConstant('strategy.equity', s2.ctx)));
      pos2.push(numV(getConstant('strategy.position_size', s2.ctx)));
    }

    // Assert identical state across all bars
    expect(pos2).toEqual(pos1);
    expect(eq2).toEqual(eq1);
    expect(dd2).toEqual(dd1);

    // Assert executions are identical
    const execs1 = execsAt(s1.ctx, bars.length - 1);
    const execs2 = execsAt(s2.ctx, bars.length - 1);
    expect(execs2).toEqual(execs1);
    expect(execs1.length).toBeGreaterThan(0);
  });

  it('duplicate ID order modification with limit and market orders across bars', () => {
    const bars = mkBars([100, 100, 100, 100, 100]);
    const { ctx, barCtx } = mkRtCtx(bars);

    // Bar 0: Enter with a far limit that won't touch (limit=50)
    barCtx.seek(0);
    callStrategy('entry', [{ kind: 'string', v: 'E' }, { kind: 'string', v: 'strategy.long' }, { kind: 'float', v: 1 }, { kind: 'float', v: 50 }], {}, ctx);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(0);

    // Bar 1: Still not touched
    barCtx.seek(1);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(0);

    // Bar 2: Modify order 'E' with limit=101 (touches high=102, should fill)
    barCtx.seek(2);
    callStrategy('entry', [{ kind: 'string', v: 'E' }, { kind: 'string', v: 'strategy.long' }, { kind: 'float', v: 1 }, { kind: 'float', v: 101 }], {}, ctx);

    // Bar 3: The modified order should be filled on or after Bar 2
    barCtx.seek(3);
    const pos = numV(getConstant('strategy.position_size', ctx));
    expect(pos).toBe(1);
  });

  it('duplicate ID modified to a MARKET order fills on the bar after the modification', () => {
    // The modified order must take its fill-timing from the modification bar
    // (`mod.bar`), not the original placement bar: with the placement bar's
    // `r = o.bar + 1` the market order could never match the scanned bar and
    // would sit in `pending` forever.
    const bars = mkBars([100, 100, 100, 100]);
    const { ctx, barCtx } = mkRtCtx(bars);
    const pos = () => numV(getConstant('strategy.position_size', ctx));

    // Bar 0: a far limit that will never touch while pending.
    barCtx.seek(0);
    callStrategy('entry', [{ kind: 'string', v: 'E' }, { kind: 'string', v: 'strategy.long' }, { kind: 'float', v: 1 }, { kind: 'float', v: 50 }], {}, ctx);
    barCtx.seek(1);
    expect(pos()).toBe(0);

    // Bar 2: same id, no limit/stop → market. Must NOT fill on bar 2 itself.
    barCtx.seek(2);
    callStrategy('entry', [{ kind: 'string', v: 'E' }, { kind: 'string', v: 'strategy.long' }, { kind: 'float', v: 1 }], {}, ctx);
    expect(pos()).toBe(0);

    // Bar 3: fills at this bar's open.
    barCtx.seek(3);
    expect(pos()).toBe(1);
  });

  it('forming bar tick updates reflect price changes when order count is identical', () => {
    const bars = mkBars([100, 100, 100]);
    const { ctx, barCtx } = mkRtCtx(bars);

    // Bar 0: Enter position
    barCtx.seek(0);
    callStrategy('entry', [{ kind: 'string', v: 'E' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);

    // Bar 1: Position filled, price at close=100
    barCtx.seek(1);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    const eqInit = numV(getConstant('strategy.equity', ctx));

    // Simulate intraday tick price change on Bar 1 (close moves from 100 to 110)
    barCtx.updateBar({ ...bars[1]!, close: 110, high: 112 });
    const eqUpdated = numV(getConstant('strategy.equity', ctx));
    expect(eqUpdated).toBeGreaterThan(eqInit);
  });

  it('max_drawdown agrees with the drawdown of the per-bar equity series', () => {
    // Invariant between the two equity implementations: the curve replays past
    // bars through `shifted()`, while the per-bar samples come from simAt. Any
    // divergence between them (e.g. a series the wrapper fails to offset) shows
    // up here. A daily rule is installed so the replay's derived day boundaries
    // are exercised too.
    const mkDaily = (closes: number[]) =>
      closes.map((c, i) => ({
        openTime: Date.UTC(2026, 0, 1 + i),
        closeTime: Date.UTC(2026, 0, 1 + i) + 86_399_999,
        open: c, high: c + 1, low: c - 1, close: c, volume: 1000,
      }));
    const bars = mkDaily([100, 90, 95, 80, 85, 70]);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('risk.max_cons_loss_days', [{ kind: 'int', v: 1 }], {}, ctx);

    const eqs: number[] = [];
    for (let b = 0; b < bars.length; b++) {
      barCtx.seek(b);
      if (b === 0) {
        callStrategy('entry', [
          { kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }, { kind: 'float', v: 1 },
        ], {}, ctx);
      }
      eqs.push(numV(getConstant('strategy.equity', ctx)));
    }
    let peak = -Infinity;
    let dd = 0;
    for (const e of eqs) {
      if (e > peak) peak = e;
      if (peak - e > dd) dd = peak - e;
    }
    expect(numV(getConstant('strategy.max_drawdown', ctx))).toBeCloseTo(dd, 6);
  });
});
