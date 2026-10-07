// ── strategy.* simulation layer tests ───────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { NA, Series, type BarData, type BuiltinCtx, type Node, type StrategyDecl, type Value } from '../contracts';
import { BarCtx } from '../context';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/strategy';
import { BUILTINS, getConstant } from '../builtins';
import { strategyDecl, type StratCfg } from '../builtins/strategy';

// ── helpers ─────────────────────────────────────────────────────────────────

function mkBars(n: number, openBase = 10): BarData[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 60000,
    open: openBase + i,
    high: openBase + i + 2,
    low: openBase + i - 1,
    close: openBase + i,
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
  return fn(ctx ?? mkRtCtx(mkBars(1)).ctx, args, named);
}

function numV(v: Value | undefined): number {
  return v && (v.kind === 'int' || v.kind === 'float') ? v.v : NaN;
}

const strN = (v: string): Node => ({ type: 'str', v });
const numN = (v: number): Node => ({ type: 'num', v, isInt: true });
const boolN = (v: boolean): Node => ({ type: 'bool', v });
const memN = (obj: string, prop: string): Node => ({ type: 'member', obj: { type: 'ident', name: obj }, prop });

// ── constants ───────────────────────────────────────────────────────────────

describe('strategy constants', () => {
  it('registers strategy.* enum constants', () => {
    for (const k of ['long', 'short', 'fixed', 'percent_of_equity', 'cash']) {
      expect(getConstant(`strategy.${k}`), `strategy.${k}`).toEqual({ kind: 'string', v: `strategy.${k}` });
    }
    expect(getConstant('strategy.direction.long')).toEqual({ kind: 'string', v: 'strategy.direction.long' });
    expect(getConstant('strategy.direction.short')).toEqual({ kind: 'string', v: 'strategy.direction.short' });
    for (const k of ['percent', 'cash_per_contract', 'cash_per_order']) {
      expect(getConstant(`strategy.commission.${k}`), `strategy.commission.${k}`)
        .toEqual({ kind: 'string', v: `strategy.commission.${k}` });
    }
    for (const k of ['none', 'cancel', 'reduce']) {
      expect(getConstant(`strategy.oca.${k}`), `strategy.oca.${k}`)
        .toEqual({ kind: 'string', v: `strategy.oca.${k}` });
    }
  });

  it('registers currency.* constants', () => {
    for (const c of ['USD', 'TWD', 'EUR', 'JPY', 'GBP', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NONE', 'BTC', 'ETH']) {
      expect(getConstant(`currency.${c}`), `currency.${c}`).toEqual({ kind: 'string', v: `currency.${c}` });
    }
  });

  it('registers strategy builtins', () => {
    for (const name of ['entry', 'exit', 'close', 'close_all', 'order', 'cancel', 'cancel_all']) {
      expect(BUILTINS.has(`strategy.${name}`), `strategy.${name}`).toBe(true);
    }
  });
});

// ── strategyDecl ────────────────────────────────────────────────────────────

describe('strategyDecl', () => {
  it('parses named args into ctx.state', () => {
    const { ctx } = mkRtCtx(mkBars(1));
    const node: StrategyDecl = {
      type: 'strategy',
      args: [
        { name: 'initial_capital', value: numN(50000) },
        { name: 'default_qty_type', value: strN('strategy.percent_of_equity') },
        { name: 'default_qty_value', value: numN(10) },
        { name: 'commission_type', value: strN('strategy.commission.cash_per_order') },
        { name: 'commission_value', value: numN(5) },
        { name: 'process_orders_on_close', value: boolN(true) },
        { name: 'currency', value: strN('currency.TWD') },
      ],
    };
    strategyDecl(ctx, node);
    const cfg = ctx.state.get('strategy|cfg') as StratCfg;
    expect(cfg.initial_capital).toBe(50000);
    expect(cfg.default_qty_type).toBe('strategy.percent_of_equity');
    expect(cfg.default_qty_value).toBe(10);
    expect(cfg.commission_type).toBe('strategy.commission.cash_per_order');
    expect(cfg.commission_value).toBe(5);
    expect(cfg.process_orders_on_close).toBe(true);
    expect(cfg.currency).toBe('currency.TWD');
  });

  it('binds positional args by Pine signature order', () => {
    const { ctx } = mkRtCtx(mkBars(1));
    // strategy(title, shorttitle, overlay, format, precision, scale,
    //   pyramiding, calc_on_order_fills, calc_on_every_tick, max_bars_back,
    //   backtest_fill_limits_assumption, default_qty_type, default_qty_value,
    //   initial_capital, currency, slippage, commission_type, commission_value,
    //   process_orders_on_close, ...)
    const node: StrategyDecl = {
      type: 'strategy',
      args: [
        { value: strN('title') },        // title
        { value: strN('st') },           // shorttitle
        { value: boolN(true) },          // overlay
        { value: strN('f') },            // format
        { value: numN(2) },              // precision
        { value: strN('s') },            // scale
        { value: numN(4) },              // pyramiding
        { value: boolN(false) },         // calc_on_order_fills
        { value: boolN(false) },         // calc_on_every_tick
        { value: numN(50) },             // max_bars_back
        { value: numN(0) },              // backtest_fill_limits_assumption
        { value: strN('strategy.percent_of_equity') }, // default_qty_type
        { value: numN(7) },              // default_qty_value
        { value: numN(20000) },          // initial_capital
        { value: strN('currency.TWD') }, // currency
        { value: numN(0) },              // slippage
        { value: strN('strategy.commission.cash_per_order') }, // commission_type
        { value: numN(5) },              // commission_value
        { value: boolN(true) },          // process_orders_on_close
      ],
    };
    strategyDecl(ctx, node);
    const cfg = ctx.state.get('strategy|cfg') as StratCfg;
    expect(cfg.initial_capital).toBe(20000);
    expect(cfg.default_qty_type).toBe('strategy.percent_of_equity');
    expect(cfg.default_qty_value).toBe(7);
    expect(cfg.commission_type).toBe('strategy.commission.cash_per_order');
    expect(cfg.commission_value).toBe(5);
    expect(cfg.process_orders_on_close).toBe(true);
    expect(cfg.currency).toBe('currency.TWD');
    expect(cfg.pyramiding).toBe(4);
  });

  it('resolves member constants in args', () => {
    const { ctx } = mkRtCtx(mkBars(1));
    const node: StrategyDecl = {
      type: 'strategy',
      args: [
        { name: 'default_qty_type', value: memN('strategy', 'percent_of_equity') },
        { name: 'currency', value: memN('currency', 'TWD') },
      ],
    };
    strategyDecl(ctx, node);
    const cfg = ctx.state.get('strategy|cfg') as StratCfg;
    expect(cfg.default_qty_type).toBe('strategy.percent_of_equity');
    expect(cfg.currency).toBe('currency.TWD');
  });

  it('applies defaults for missing args', () => {
    const { ctx } = mkRtCtx(mkBars(1));
    strategyDecl(ctx, { type: 'strategy', args: [] });
    const cfg = ctx.state.get('strategy|cfg') as StratCfg;
    expect(cfg.initial_capital).toBe(100000);
    expect(cfg.default_qty_type).toBe('fixed');
    expect(cfg.default_qty_value).toBe(1);
    expect(cfg.commission_type).toBe('percent');
    expect(cfg.commission_value).toBe(0);
    expect(cfg.process_orders_on_close).toBe(false);
    expect(cfg.currency).toBe('NONE');
    expect(cfg.pyramiding).toBe(0);
  });
});

// ── entry fill model ────────────────────────────────────────────────────────

describe('strategy.entry fill model', () => {
  it('entry fills at next bar open (process_orders_on_close=false)', () => {
    const bars = mkBars(5, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    // bar 0: entry long — fills at bar 1 open (11)
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    // bar 0 read: still flat (deterministic: fill only lands at bar 1)
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(0);
    barCtx.seek(1);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    expect(numV(getConstant('strategy.position_avg_price', ctx))).toBe(11);
  });

  it('reversal flips position', () => {
    const bars = mkBars(5, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(2);
    callStrategy('entry', [{ kind: 'string', v: 'S' }, { kind: 'string', v: 'strategy.short' }], {}, ctx);
    // bar 2 read: S placed this bar, not yet filled → still +1
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    barCtx.seek(3);
    // bar 3: reversal fill at open 13 → flat long closed, short 1 open
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(-1);
    expect(numV(getConstant('strategy.position_avg_price', ctx))).toBe(13);
  });

  it('process_orders_on_close=true fills at bar close', () => {
    const bars = mkBars(5, 10);
    const { ctx } = mkRtCtx(bars);
    strategyDecl(ctx, {
      type: 'strategy',
      args: [{ name: 'process_orders_on_close', value: boolN(true) }],
    });
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    // bar 0: fills same bar at close (10)
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    expect(numV(getConstant('strategy.position_avg_price', ctx))).toBe(10);
  });

  it('entry inside if only records when reached (e2e)', async () => {
    const src = `strategy("t")
if bar_index == 0
  strategy.entry("L", strategy.long)
if bar_index == 2
  strategy.entry("S", strategy.short)
plot(strategy.position_size)`;
    const parsed = parse(src);
    const r = await runScript(parsed, mkBars(5, 10), { symbol: 'TEST', timeframe: 'D' });
    const vals = [...r.plots.values()][0]!.values.map(v => numV(v));
    expect(vals).toEqual([0, 1, 1, -1, -1]);
  });
});

// ── equity / trades ─────────────────────────────────────────────────────────

describe('strategy.equity', () => {
  it('computes equity for a 2-trade fixture', () => {
    // bars: open=close=10..14, qty=1
    const bars = mkBars(5, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(2);
    callStrategy('entry', [{ kind: 'string', v: 'S' }, { kind: 'string', v: 'strategy.short' }], {}, ctx);
    barCtx.seek(3);
    // Long closed at 13 (bought 11) → realized +2; short 1 at 13, close 13 → open 0
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100002);
    expect(numV(getConstant('strategy.closedtrades', ctx))).toBe(1);
    barCtx.seek(4);
    // close 14: openprofit = -1*(14-13) = -1 → equity 100001
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100001);
    expect(numV(getConstant('strategy.openprofit', ctx))).toBeCloseTo(-1);
    expect(numV(getConstant('strategy.opentrades', ctx))).toBe(1);
  });

  it('strategy.close flattens the position', () => {
    const bars = mkBars(5, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(2);
    callStrategy('close', [{ kind: 'string', v: 'L' }], {}, ctx);
    // close order placed at bar 2 → fills bar 3 open (13)
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    barCtx.seek(3);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(0);
    expect(numV(getConstant('strategy.closedtrades', ctx))).toBe(1);
    // realized +2, flat → equity stays 100002
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100002);
  });

  it('strategy.exit closes with qty; closedtrades counts only fully-closed positions', () => {
    // TV semantics: strategy.closedtrades increments when a trade leg's
    // position goes fully flat — a partial exit does NOT close a trade. The
    // pre-fix fixture encoded the inflated count (partial → +1); corrected.
    const bars = mkBars(6, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }, { kind: 'int', v: 2 }], {}, ctx);
    barCtx.seek(2);
    callStrategy('exit', [{ kind: 'string', v: 'X' }, { kind: 'string', v: 'L' }, { kind: 'int', v: 1 }], {}, ctx);
    barCtx.seek(3);
    // exit 1 of 2 at bar3 open (13): realized +2, remaining +1 → not closed
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    expect(numV(getConstant('strategy.closedtrades', ctx))).toBe(0);
    barCtx.seek(4);
    callStrategy('exit', [{ kind: 'string', v: 'X2' }, { kind: 'string', v: 'L' }], {}, ctx);
    barCtx.seek(5);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(0);
    expect(numV(getConstant('strategy.closedtrades', ctx))).toBe(1);
  });
});

// ── order gating / fill-model regressions ──────────────────────────────────

describe('strategy order gating', () => {
  const wrap = (v: Value): Value => {
    const s = new Series();
    s.set(v);
    return { kind: 'series', v: s };
  };

  it('when=false records no order on any strategy call', () => {
    const { ctx } = mkRtCtx(mkBars(5, 10));
    const whenFalse = { when: wrap({ kind: 'bool', v: false }) };
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], whenFalse, ctx);
    callStrategy('exit', [{ kind: 'string', v: 'X' }], whenFalse, ctx);
    callStrategy('close', [{ kind: 'string', v: 'L' }], whenFalse, ctx);
    callStrategy('order', [{ kind: 'string', v: 'O' }, { kind: 'string', v: 'strategy.long' }], whenFalse, ctx);
    expect((ctx.state.get('strategy|orders') ?? [])).toHaveLength(0);
    expect(ctx.warnings.length).toBe(0);
  });

  it('strategy.close(immediately=true) fills at the same bar close', () => {
    // evalArg wraps bool args in a BarSeries — regressions: immediate must read
    // through the wrapper (truthy), not the Value kind.
    const { ctx, barCtx } = mkRtCtx(mkBars(5, 10));
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(2); // position +1 at 12
    callStrategy('close', [{ kind: 'string', v: 'L' }], { immediately: wrap({ kind: 'bool', v: true }) }, ctx);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(0);
    expect(numV(getConstant('strategy.closedtrades', ctx))).toBe(1);
    // entry filled bar1 open (11); close(immediately) fills bar2 close (12)
    // → +1 realized. Flat at bar2, equity 100001.
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100001);
  });

  it('entry with limit+stop fills when either level is touched (OCO, not both-required)', () => {
    // TV treats limit+stop on one order as an OCO pair — whichever the bar
    // touches first fills. mkBars: bar1 low=10 touches limit 10.5; stop 999
    // is unreachable — the order must still fill at the limit price.
    const { ctx, barCtx } = mkRtCtx(mkBars(3, 10));
    callStrategy('entry', [
      { kind: 'string', v: 'E' }, { kind: 'string', v: 'strategy.long' },
    ], { limit: wrap({ kind: 'float', v: 10.5 }), stop: wrap({ kind: 'float', v: 999 }) }, ctx);
    barCtx.seek(1);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    expect(numV(getConstant('strategy.position_avg_price', ctx))).toBe(10.5);
  });

  it('both levels touched same bar fills at the worse price (conservative)', () => {
    // buy entry: stop 10.5, limit 10.2 — bar1 (o11/h12/l10) touches both.
    // The open already gapped past the stop (11 > 10.5) so the stop side
    // fills at the open; worse than the limit → fill at 11.
    const { ctx, barCtx } = mkRtCtx(mkBars(3, 10));
    callStrategy('entry', [
      { kind: 'string', v: 'E' }, { kind: 'string', v: 'strategy.long' },
    ], { limit: wrap({ kind: 'float', v: 10.2 }), stop: wrap({ kind: 'float', v: 10.5 }) }, ctx);
    barCtx.seek(1);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    expect(numV(getConstant('strategy.position_avg_price', ctx))).toBe(11);
  });

  it('stop-only entry still fills on touch', () => {
    const { ctx, barCtx } = mkRtCtx(mkBars(4, 10));
    // buy stop above market: bar1 high = 12 touches stop 11.5 → fills at 11.5
    callStrategy('entry', [
      { kind: 'string', v: 'E' }, { kind: 'string', v: 'strategy.long' },
    ], { stop: wrap({ kind: 'float', v: 11.5 }) }, ctx);
    barCtx.seek(1);
    // bar1 opens at 11 ≤ stop 11.5 → no gap fill; touched stop fills at 11.5
    expect(numV(getConstant('strategy.position_avg_price', ctx))).toBe(11.5);
  });

  it('bare strategy.cancel() warns and does not cancel-all; named id cancels', () => {
    // pending stop order placed bar0; bare cancel() at bar0 must NOT retire it
    const { ctx, barCtx } = mkRtCtx(mkBars(6, 10));
    callStrategy('entry', [
      { kind: 'string', v: 'P' }, { kind: 'string', v: 'strategy.long' },
    ], { stop: wrap({ kind: 'float', v: 17 }) }, ctx);
    callStrategy('cancel', [], {}, ctx);
    expect(ctx.warnings.some(w => /cancel/.test(w))).toBe(true);
    barCtx.seek(5); // bar5 high = 10+5+2 = 17 touches stop 17 → fills
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);

    // explicit id does cancel
    const { ctx: c2, barCtx: b2 } = mkRtCtx(mkBars(6, 10));
    callStrategy('entry', [
      { kind: 'string', v: 'P' }, { kind: 'string', v: 'strategy.long' },
    ], { stop: wrap({ kind: 'float', v: 17 }) }, c2);
    callStrategy('cancel', [{ kind: 'string', v: 'P' }], {}, c2);
    b2.seek(5);
    expect(numV(getConstant('strategy.position_size', c2))).toBe(0);
  });

  it('strategy.exit profit/loss ticks convert to limit/stop levels', () => {
    // custom bars: entry long fills bar1 open=10; bar2 high 13 → profit at 12
    const bars: BarData[] = [
      { openTime: 0, open: 9, high: 9.5, low: 8.5, close: 9, volume: 1 },
      { openTime: 1, open: 10, high: 10.5, low: 9.5, close: 10, volume: 1 },
      { openTime: 2, open: 10.5, high: 13, low: 10, close: 12.5, volume: 1 },
      { openTime: 3, open: 12.5, high: 13, low: 11, close: 11, volume: 1 },
    ];
    const { ctx, barCtx } = mkRtCtx(bars);
    // mintick 0.01 → profit=200 ticks → +2.0 over entry
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    callStrategy('exit', [{ kind: 'string', v: 'X' }, { kind: 'string', v: 'L' }],
      { profit: wrap({ kind: 'float', v: 200 }), loss: wrap({ kind: 'float', v: 500 }) }, ctx);
    barCtx.seek(2); // bar2 high 13 ≥ limit 12 → fills at 12
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(0);
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100002);
  });

  it('strategy.exit trail_* arms on trail_points then exits on trail_offset retrace', () => {
    const bars: BarData[] = [
      { openTime: 0, open: 9, high: 9.5, low: 8.5, close: 9, volume: 1 },
      { openTime: 1, open: 10, high: 10.5, low: 9.5, close: 10, volume: 1 },
      { openTime: 2, open: 10.5, high: 13, low: 10, close: 12.5, volume: 1 },
      { openTime: 3, open: 12.5, high: 13.5, low: 12, close: 13, volume: 1 },
      { openTime: 4, open: 12, high: 12, low: 10, close: 10.5, volume: 1 },
    ];
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    // trail activates at +2.0 (200 ticks × mintick .01), trails peak by 1.0 (100 ticks)
    callStrategy('exit', [{ kind: 'string', v: 'X' }, { kind: 'string', v: 'L' }],
      { trail_points: wrap({ kind: 'float', v: 200 }), trail_offset: wrap({ kind: 'float', v: 100 }) }, ctx);
    barCtx.seek(2); // peak 13 ≥ activation 12 → armed, stop 12; low 10? no: bar2 low=10
    // bar2 low 10 < stop 12 → triggers immediately at 12
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(0);
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100002);
  });

  it('oca cancel group: first fill cancels sibling orders', () => {
    const { ctx, barCtx } = mkRtCtx(mkBars(5, 10));
    callStrategy('entry', [
      { kind: 'string', v: 'A' }, { kind: 'string', v: 'strategy.long' },
    ], { stop: wrap({ kind: 'float', v: 12 }), oca_name: wrap({ kind: 'string', v: 'g' }), oca_type: wrap({ kind: 'string', v: 'strategy.oca.cancel' }) }, ctx);
    callStrategy('entry', [
      { kind: 'string', v: 'B' }, { kind: 'string', v: 'strategy.long' },
    ], { stop: wrap({ kind: 'float', v: 14 }), oca_name: wrap({ kind: 'string', v: 'g' }), oca_type: wrap({ kind: 'string', v: 'strategy.oca.cancel' }) }, ctx);
    barCtx.seek(1); // bar1 high 12 touches A's stop → fills, B cancelled
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    barCtx.seek(4); // bar4 high 14 would fill B — must stay cancelled
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    expect(numV(getConstant('strategy.closedtrades', ctx))).toBe(0);
  });
});
