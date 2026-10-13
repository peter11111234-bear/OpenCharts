// ── strategy.* simulation layer tests ───────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { Series, type BarData, type BuiltinCtx, type Node, type StrategyDecl, type Value } from '../contracts';
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

  it('warns once about declared-but-unimplemented parameters', () => {
    const { ctx } = mkRtCtx(mkBars(1));
    strategyDecl(ctx, {
      type: 'strategy',
      args: [
        { name: 'risk_free_rate', value: numN(1) },
        { name: 'calc_on_every_tick', value: boolN(true) },
        { name: 'initial_capital', value: numN(1234) },
      ],
    });
    // A second declaration in the same run must not repeat the warning.
    strategyDecl(ctx, { type: 'strategy', args: [{ name: 'risk_free_rate', value: numN(2) }] });
    const hits = ctx.warnings.filter((w) => w.startsWith('strategy():'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("'risk_free_rate'");
    expect(hits[0]).toContain("'calc_on_every_tick'");
    // Supported parameters are not reported.
    expect(hits[0]).not.toContain("'initial_capital'");
    expect(hits[0]).not.toContain("'slippage'");
    expect(hits[0]).not.toContain("'margin_long'");
  });

  it('parses slippage and the margin percentages into the config', () => {
    const { ctx } = mkRtCtx(mkBars(1));
    strategyDecl(ctx, {
      type: 'strategy',
      args: [
        { name: 'slippage', value: numN(5) },
        { name: 'margin_long', value: numN(25) },
        { name: 'margin_short', value: numN(50) },
      ],
    });
    const cfg = ctx.state.get('strategy|cfg') as StratCfg;
    expect(cfg.slippage).toBe(5);
    expect(cfg.margin_long).toBe(25);
    expect(cfg.margin_short).toBe(50);
    expect(ctx.warnings.filter((w) => w.startsWith('strategy():'))).toHaveLength(0);
  });

  it('does not warn for a declaration that only uses supported parameters', () => {
    const { ctx } = mkRtCtx(mkBars(1));
    strategyDecl(ctx, {
      type: 'strategy',
      args: [
        { name: 'initial_capital', value: numN(10000) },
        { name: 'commission_type', value: strN('strategy.commission.percent') },
        { name: 'max_lines_count', value: numN(500) },
      ],
    });
    expect(ctx.warnings.filter((w) => w.startsWith('strategy():'))).toHaveLength(0);
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
/** evalArg wraps series args in a one-slot Series — mirrors the runtime shape. */
const wrap = (v: Value): Value => {
  const s = new Series();
  s.set(v);
  return { kind: 'series', v: s };
};

const callTrades = (name: string, ctx: BuiltinCtx, i: number): Value =>
  callStrategy(name, [{ kind: 'int', v: i }], {}, ctx);


// ── order gating / fill-model regressions ──────────────────────────────────

describe('strategy order gating', () => {
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

// ── trade comments ──────────────────────────────────────────────────

describe('strategy trade comments', () => {
  it('close_all(comment=) labels the exit execution', async () => {
    const src = `strategy("s")
if bar_index == 0
  strategy.entry("L", strategy.long)
if bar_index == 2
  strategy.close_all(comment="tp-hit")
plot(strategy.position_size)`;
    const r = await runScript(parse(src), mkBars(5, 10), { symbol: 'TEST', timeframe: 'D' });
    const exit = r.execs!.find(e => e.kind === 'exit');
    expect(exit).toBeDefined();
    expect(exit!.label).toBe('tp-hit');
    expect(exit!.tradeId).toBe(r.execs!.find(e => e.kind === 'entry')!.tradeId);
  });

  it('order(comment=) labels the entry execution', async () => {
    const src = `strategy("s")
if bar_index == 0
  strategy.order("O", strategy.long, comment="scale-in")
plot(strategy.position_size)`;
    const r = await runScript(parse(src), mkBars(3, 10), { symbol: 'TEST', timeframe: 'D' });
    const entry = r.execs!.find(e => e.kind === 'entry');
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('scale-in');
  });
});

// ── per-trade accessors + P&L rollups ───────────────────────────────────────

describe('strategy.closedtrades/opentrades accessors', () => {
  // bars: open=close=10..17. Entry fills next-bar open:
  //   L entry(bar0) → fills bar1 @11; exit(bar2) → fills bar3 @13 → +2
  //   S entry(bar4) → fills bar5 @15; exit(bar6) → fills bar7 @17 → -2
  const twoTrades = () => {
    const bars = mkBars(8, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(2);
    callStrategy('exit', [{ kind: 'string', v: 'XL' }, { kind: 'string', v: 'L' }], {}, ctx);
    barCtx.seek(4);
    callStrategy('entry', [{ kind: 'string', v: 'S' }, { kind: 'string', v: 'strategy.short' }], {}, ctx);
    barCtx.seek(6);
    callStrategy('exit', [{ kind: 'string', v: 'XS' }, { kind: 'string', v: 'S' }], {}, ctx);
    barCtx.seek(7);
    return { ctx, barCtx };
  };

  it('closedtrades.* expose per-trade fields, index 0 = FIRST closed trade', () => {
    const { ctx } = twoTrades();
    expect(numV(getConstant('strategy.closedtrades', ctx))).toBe(2);
    // TV: trade_num is the chronological index — 0 = first closed trade
    // (the long: entry 11 → exit 13, win), last = strategy.closedtrades - 1.
    expect(numV(callTrades('closedtrades.entry_bar_index', ctx, 0))).toBe(1);
    expect(numV(callTrades('closedtrades.entry_price', ctx, 0))).toBe(11);
    expect(numV(callTrades('closedtrades.entry_time', ctx, 0))).toBe(1 * 60000);
    expect(numV(callTrades('closedtrades.exit_bar_index', ctx, 0))).toBe(3);
    expect(numV(callTrades('closedtrades.exit_price', ctx, 0))).toBe(13);
    expect(numV(callTrades('closedtrades.exit_time', ctx, 0))).toBe(3 * 60000);
    expect(numV(callTrades('closedtrades.profit', ctx, 0))).toBeCloseTo(2);
    expect(numV(callTrades('closedtrades.size', ctx, 0))).toBe(1);
    expect(numV(callTrades('closedtrades.commission', ctx, 0))).toBe(0);
    // Second closed trade = the short (entry 15 → exit 17, loss).
    expect(numV(callTrades('closedtrades.entry_price', ctx, 1))).toBe(15);
    expect(numV(callTrades('closedtrades.profit', ctx, 1))).toBeCloseTo(-2);
    expect(numV(callTrades('closedtrades.size', ctx, 1))).toBe(-1);
    // Out of range → na.
    expect(callTrades('closedtrades.profit', ctx, 2).kind).toBe('na');
    expect(callTrades('closedtrades.profit', ctx, -1).kind).toBe('na');
  });

  it('opentrades.* describe live entry legs', () => {
    // Long closed by bar 5; short entry fills bar5 @15 — one live leg.
    const bars = mkBars(8, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(2);
    callStrategy('exit', [{ kind: 'string', v: 'XL' }, { kind: 'string', v: 'L' }], {}, ctx);
    barCtx.seek(4);
    callStrategy('entry', [{ kind: 'string', v: 'S' }, { kind: 'string', v: 'strategy.short' }], {}, ctx);
    barCtx.seek(5);
    expect(numV(getConstant('strategy.opentrades', ctx))).toBe(1);
    expect(numV(callTrades('opentrades.entry_bar_index', ctx, 0))).toBe(5);
    expect(numV(callTrades('opentrades.entry_price', ctx, 0))).toBe(15);
    expect(numV(callTrades('opentrades.entry_time', ctx, 0))).toBe(5 * 60000);
    expect(numV(callTrades('opentrades.size', ctx, 0))).toBe(-1);
    expect(callTrades('opentrades.entry_price', ctx, 1).kind).toBe('na');
  });

  it('grossprofit / grossloss / netprofit roll up closed trades', () => {
    const { ctx } = twoTrades();
    expect(numV(getConstant('strategy.grossprofit', ctx))).toBeCloseTo(2);
    expect(numV(getConstant('strategy.grossloss', ctx))).toBeCloseTo(2);
    expect(numV(getConstant('strategy.netprofit', ctx))).toBeCloseTo(0);
  });

  it('accessors resolve through runScript (dotted-call dispatch)', async () => {
    const src = `strategy("s")
if bar_index == 0
  strategy.entry("L", strategy.long)
if bar_index == 2
  strategy.exit("XL", "L")
if bar_index == 4
  strategy.entry("S", strategy.short)
if bar_index == 6
  strategy.exit("XS", "S")
plot(strategy.closedtrades.profit(0), "p0")
plot(strategy.closedtrades.profit(1), "p1")
plot(strategy.closedtrades.entry_price(0), "e0")
plot(strategy.netprofit, "np")
plot(strategy.grossprofit, "gp")
plot(strategy.grossloss, "gl")`;
    const r = await runScript(parse(src), mkBars(8, 10), { symbol: 'TEST', timeframe: 'D' });
    const last = (k: string) => numV(r.plots.get(k)!.values.at(-1));
    // Chronological: trade 0 = long (+2, entry @11), trade 1 = short (-2).
    expect(last('p0')).toBeCloseTo(2);
    expect(last('p1')).toBeCloseTo(-2);
    expect(last('e0')).toBe(11);
    expect(last('np')).toBeCloseTo(0);
    expect(last('gp')).toBeCloseTo(2);
    expect(last('gl')).toBeCloseTo(2);
  });
});

// ── 2026-10-09 QA round: TV-parity regression pins ─────────────────────────
// Probed via scratch/_strategy_qa.mjs; findings in docs/strategy-qa-2026-10-09.md.

describe('strategy QA 2026-10-09', () => {
  it('strategy.close honors qty — partial close leaves the rest open', () => {
    // TV: close("L", qty=1) on a 2-contract position leaves +1 open.
    // Pre-fix: qty/qty_percent were ignored — close always flattened.
    const bars = mkBars(6, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }, { kind: 'int', v: 2 }], {}, ctx);
    barCtx.seek(2);
    callStrategy('close', [{ kind: 'string', v: 'L' }], { qty: wrap({ kind: 'int', v: 1 }) }, ctx);
    barCtx.seek(3); // close fills bar3 open (13): 1 of 2 → +1 remains
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    expect(numV(getConstant('strategy.opentrades', ctx))).toBe(1);
    expect(numV(getConstant('strategy.closedtrades', ctx))).toBe(0); // leg only half-consumed
  });

  it('strategy.close honors qty_percent', () => {
    const bars = mkBars(6, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }, { kind: 'int', v: 2 }], {}, ctx);
    barCtx.seek(2);
    callStrategy('close', [{ kind: 'string', v: 'L' }], { qty_percent: wrap({ kind: 'int', v: 50 }) }, ctx);
    barCtx.seek(3);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
  });

  it('positional args follow the v5 signature — close(id, comment, qty, …)', () => {
    // v5 close() order: (id, comment, qty, qty_percent, alert_message,
    // immediately) — `when` is deprecated and NOT positional. Pre-fix order
    // had `when` 2nd, so ("L","note",1) bound qty→comment and lost qty.
    const bars = mkBars(6, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }, { kind: 'int', v: 2 }], {}, ctx);
    barCtx.seek(2);
    callStrategy('close', [
      { kind: 'string', v: 'L' },
      { kind: 'string', v: 'half' },
      { kind: 'int', v: 1 },
    ], {}, ctx);
    barCtx.seek(3);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
  });

  it('entry qty=0 / qty<0 fills zero contracts — never the default qty', async () => {
    // QA round-2 3a/3b (P2): qtyOf stored explicit ≤0 as qty=0, which
    // resolveQty couldn't tell from "absent" → fell back to default_qty_value
    // and filled 1 contract. qtySet now distinguishes present from absent.
    for (const q of [0, -2]) {
      const r = await runScript(parse(
        `strategy("s")\nif bar_index == 0\n  strategy.entry("L", strategy.long, qty=${q})\nplot(strategy.position_size)`),
        mkBars(6, 10), { symbol: 'TEST', timeframe: 'D' });
      const pos = [...r.plots.values()][0]!.values.map(numV);
      expect(pos, `qty=${q}`).toEqual([0, 0, 0, 0, 0, 0]);
    }
  });

  it('close qty=0 closes nothing — an explicit zero is not a flatten', async () => {
    // QA round-2 3c (P2): qty=0 failed qty>0 and eqPct>0, then fell through
    // to `return pos` — a full-position close.
    const r = await runScript(parse(
      `strategy("s")\nif bar_index == 0\n  strategy.entry("L", strategy.long, qty=2)\nif bar_index == 3\n  strategy.close("L", qty=0)\nplot(strategy.position_size)`),
      mkBars(6, 10), { symbol: 'TEST', timeframe: 'D' });
    const pos = [...r.plots.values()][0]!.values.map(numV);
    expect(pos).toEqual([0, 2, 2, 2, 2, 2]);
  });

  it('close qty_percent=0 closes nothing; absent qty_percent still flattens', async () => {
    // Same family: explicit 0 ≠ absent. qty_percent=0 → 0 contracts;
    // plain close("L") → full position (default qty_percent=100).
    const r0 = await runScript(parse(
      `strategy("s")\nif bar_index == 0\n  strategy.entry("L", strategy.long, qty=2)\nif bar_index == 3\n  strategy.close("L", qty_percent=0)\nplot(strategy.position_size)`),
      mkBars(6, 10), { symbol: 'TEST', timeframe: 'D' });
    expect([...r0.plots.values()][0]!.values.map(numV)).toEqual([0, 2, 2, 2, 2, 2]);
    const rAll = await runScript(parse(
      `strategy("s")\nif bar_index == 0\n  strategy.entry("L", strategy.long, qty=2)\nif bar_index == 3\n  strategy.close("L")\nplot(strategy.position_size)`),
      mkBars(6, 10), { symbol: 'TEST', timeframe: 'D' });
    expect([...rAll.plots.values()][0]!.values.map(numV)).toEqual([0, 2, 2, 2, 0, 0]);
  });

  it('positional close_all(comment) labels the exit execution', async () => {
    // v5 close_all() order: (comment, alert_message, immediately) — pre-fix it
    // shared close()'s order, binding positional arg0 to a dead `id` slot.
    const src = `strategy("s")
if bar_index == 0
  strategy.entry("L", strategy.long)
if bar_index == 2
  strategy.close_all("done-all")
plot(strategy.position_size)`;
    const r = await runScript(parse(src), mkBars(5, 10), { symbol: 'TEST', timeframe: 'D' });
    const exit = r.execs!.find(e => e.kind === 'exit');
    expect(exit).toBeDefined();
    expect(exit!.label).toBe('done-all');
  });

  it('position_avg_price re-derives from remaining legs after a partial exit', () => {
    // TV: position_avg_price = average entry of the trades still open. Two
    // legs @11 and @12 (avg 11.5); FIFO exit of the first 2 contracts retires
    // the @11 leg → remaining position is the @12 leg → avg 12.
    const bars = mkBars(8, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    strategyDecl(ctx, { type: 'strategy', args: [{ name: 'pyramiding', value: numN(2) }] });
    callStrategy('entry', [{ kind: 'string', v: 'A' }, { kind: 'string', v: 'strategy.long' }, { kind: 'int', v: 2 }], {}, ctx);
    barCtx.seek(1); // A fills bar1 open 11 (2x)
    callStrategy('entry', [{ kind: 'string', v: 'B' }, { kind: 'string', v: 'strategy.long' }, { kind: 'int', v: 2 }], {}, ctx);
    barCtx.seek(2); // B fills bar2 open 12 (2x) → avg (22+24)/4 = 11.5
    expect(numV(getConstant('strategy.position_avg_price', ctx))).toBeCloseTo(11.5);
    barCtx.seek(3);
    callStrategy('exit', [{ kind: 'string', v: 'X' }, { kind: 'string', v: 'A' }, { kind: 'int', v: 2 }], {}, ctx);
    barCtx.seek(4); // exit fills bar4 open 14 → leg A consumed FIFO
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(2);
    expect(numV(getConstant('strategy.opentrades', ctx))).toBe(1);
    expect(numV(getConstant('strategy.position_avg_price', ctx))).toBe(12);
  });

  it('equity is continuous across a partial exit (leg-price PnL booking)', () => {
    // PnL must book at the closed leg's entry price, not the blended average.
    // Legs @11 (2x) and @12 (2x), avg 11.5. Exit 2 at bar4 open 14: leg-exact
    // realized = 2×(14−11)=6; remaining @12, close 14 → openprofit +4.
    // equity = 100000 + 6 + 4 = 100010. Pre-fix booked 2×(14−11.5)=5 realized
    // but kept stale avg 11.5 → openprofit +5: equity equal by accident, both
    // halves wrong (openprofit 5 vs TV's 4; closedtrades.profit 6 vs realized 5).
    const bars = mkBars(8, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    strategyDecl(ctx, { type: 'strategy', args: [{ name: 'pyramiding', value: numN(2) }] });
    callStrategy('entry', [{ kind: 'string', v: 'A' }, { kind: 'string', v: 'strategy.long' }, { kind: 'int', v: 2 }], {}, ctx);
    barCtx.seek(1);
    callStrategy('entry', [{ kind: 'string', v: 'B' }, { kind: 'string', v: 'strategy.long' }, { kind: 'int', v: 2 }], {}, ctx);
    barCtx.seek(3);
    callStrategy('exit', [{ kind: 'string', v: 'X' }, { kind: 'string', v: 'A' }, { kind: 'int', v: 2 }], {}, ctx);
    barCtx.seek(4);
    expect(numV(getConstant('strategy.equity', ctx))).toBeCloseTo(100010);
    expect(numV(getConstant('strategy.openprofit', ctx))).toBeCloseTo(4);
    // The retired leg reports leg-exact profit: 2×(14−11) = 6.
    expect(numV(callTrades('closedtrades.profit', ctx, 0))).toBeCloseTo(6);
    expect(numV(getConstant('strategy.netprofit', ctx))).toBeCloseTo(6);
  });

  // TV-parity pins for bugs whose fix needs per-leg entry-id tracking in the
  // replay ledger — outside the ≤20-line QA-fix scope (see findings doc).
  it.fails('strategy.close(id) only closes the named entry — unmatched id is a no-op', () => {
    const bars = mkBars(6, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(2);
    callStrategy('close', [{ kind: 'string', v: 'NOPE' }], {}, ctx);
    barCtx.seek(3);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
  });

  it.fails('strategy.exit(from_entry) does not fill when no open entry has that id', () => {
    const bars = mkBars(6, 10);
    const { ctx, barCtx } = mkRtCtx(bars);
    callStrategy('entry', [{ kind: 'string', v: 'L' }, { kind: 'string', v: 'strategy.long' }], {}, ctx);
    barCtx.seek(2);
    callStrategy('exit', [{ kind: 'string', v: 'X' }, { kind: 'string', v: 'NOPE' }], {}, ctx);
    barCtx.seek(3);
    expect(numV(getConstant('strategy.position_size', ctx))).toBe(1);
    expect(numV(getConstant('strategy.opentrades', ctx))).toBe(1);
  });
});

// ── S5: slippage, margin and the strategy.risk.* rules ──────────────────────

/** Explicit OHLC rows — the slippage/margin/risk tests need price paths the
 *  linear mkBars ramp cannot express. */
const ohlc = (rows: [number, number, number, number, number][]): BarData[] =>
  rows.map(([openTime, open, high, low, close], i) => ({ openTime, open, high, low, close, volume: 1 + i }));

const DAY = 86_400_000;

const posSeries = (r: { plots: Map<string, { values: Value[] }> }): number[] =>
  [...r.plots.values()][0]!.values.map(numV);

const runStrat = (src: string, bars: BarData[]) =>
  runScript(parse(src), bars, { symbol: 'TEST', timeframe: 'D' });

describe('strategy slippage', () => {
  it('worsens a market fill by slippage × mintick', async () => {
    const r = await runStrat(`strategy("s", slippage = 5)
if bar_index == 0
  strategy.entry("L", strategy.long)
plot(strategy.position_avg_price)`, mkBars(3, 10));
    // bar1 open 11 → +5 × 0.01
    expect(numV([...r.plots.values()][0]!.values.at(-1))).toBeCloseTo(11.05);
  });

  it('leaves a limit fill unslipped but slips a stop', async () => {
    const avg = async (opt: string) => {
      const r = await runStrat(`strategy("s", slippage = 5)
if bar_index == 0
  strategy.entry("L", strategy.long, ${opt})
plot(strategy.position_avg_price)`, mkBars(3, 10));
      return numV([...r.plots.values()][0]!.values.at(-1));
    };
    // bar1 low 10 touches the limit → fills at the limit itself
    expect(await avg('limit = 10')).toBeCloseTo(10);
    // bar1 high 13 touches the stop 12 → fills at 12 + 0.05
    expect(await avg('stop = 12')).toBeCloseTo(12.05);
  });
});

describe('strategy margin', () => {
  it('rejects an entry the equity cannot cover', async () => {
    const r = await runStrat(`strategy("s", initial_capital = 1000)
if bar_index == 0
  strategy.entry("L", strategy.long, qty = 1000)
plot(strategy.position_size)`, mkBars(4, 10));
    expect(posSeries(r)).toEqual([0, 0, 0, 0]);
    expect(r.warnings.some(w => /not enough money/.test(w))).toBe(true);
  });

  it('margin_long = 0 disables every position-size limit', async () => {
    const r = await runStrat(`strategy("s", initial_capital = 1000, margin_long = 0)
if bar_index == 0
  strategy.entry("L", strategy.long, qty = 1000)
plot(strategy.position_size)`, mkBars(4, 10));
    expect(posSeries(r).at(-1)).toBe(1000);
  });

  it('liquidates part of the position on a margin call', async () => {
    // 150 contracts @100 on 10 000 of equity at 50% margin (required 7 500).
    // At close 60 the equity left is 4 000 against 4 500 required → the broker
    // liquidates 4 × (1 000 / 0.5 / 60) contracts. TV truncates that to whole
    // contracts (16 × 4 = 64); this engine is fractional throughout, so it
    // keeps the fractional size.
    const bars = ohlc([
      [0, 100, 101, 99, 100],
      [DAY, 100, 101, 99, 100],
      [2 * DAY, 100, 100, 59, 60],
      [3 * DAY, 60, 61, 59, 60],
    ]);
    const r = await runStrat(`strategy("s", initial_capital = 10000, margin_long = 50)
if bar_index == 0
  strategy.entry("L", strategy.long, qty = 150)
plot(strategy.position_size)`, bars);
    const pos = posSeries(r);
    expect(pos[1]).toBe(150);
    expect(pos[2]).toBeCloseTo(150 - 4 * (1000 / 60), 4);
    expect(pos[3]).toBeCloseTo(pos[2]!, 4);
    // The position stays open — a margin call liquidates, it does not halt.
    expect(pos[3]).toBeGreaterThan(0);
  });
});

describe('strategy.risk.*', () => {
  it('allow_entry_in(long) turns a short entry into a close', async () => {
    const r = await runStrat(`strategy("s")
strategy.risk.allow_entry_in(strategy.direction.long)
if bar_index == 0
  strategy.entry("L", strategy.long)
if bar_index == 2
  strategy.entry("S", strategy.short)
plot(strategy.position_size)`, mkBars(5, 10));
    // bar3: the forbidden short cannot open — it closes the long instead
    expect(posSeries(r)).toEqual([0, 1, 1, 0, 0]);
  });

  it('max_position_size caps strategy.entry()', async () => {
    const r = await runStrat(`strategy("s", default_qty_value = 100)
strategy.risk.max_position_size(10)
if bar_index == 0
  strategy.entry("L", strategy.long)
plot(strategy.position_size)`, mkBars(4, 10));
    expect(posSeries(r).at(-1)).toBe(10);
  });

  it('max_drawdown flattens the position and stops the run', async () => {
    const bars = ohlc([
      [0, 100, 101, 99, 100],
      [DAY, 100, 101, 99, 100],
      [2 * DAY, 100, 100, 49, 50],
      [3 * DAY, 50, 51, 49, 50],
    ]);
    const r = await runStrat(`strategy("s", initial_capital = 1000)
strategy.risk.max_drawdown(50, strategy.percent_of_equity)
if bar_index == 0
  strategy.entry("L", strategy.long, qty = 10)
if bar_index == 3
  strategy.entry("L2", strategy.long, qty = 10)
plot(strategy.position_size)`, bars);
    // bar2 close 50 = −50% of the 1 000 peak → flatten; bar3 entry never opens
    expect(posSeries(r)).toEqual([0, 10, 0, 0]);
  });

  it('max_intraday_loss halts only until the end of the day', async () => {
    const bars = ohlc([
      [0, 100, 101, 99, 100],
      [60_000, 100, 101, 99, 100],
      [120_000, 100, 100, 49, 50],
      [180_000, 50, 51, 49, 50],
    ]);
    const r = await runStrat(`strategy("s", initial_capital = 1000)
strategy.risk.max_intraday_loss(50, strategy.percent_of_equity)
if bar_index == 0
  strategy.entry("L", strategy.long, qty = 10)
if bar_index == 3
  strategy.entry("L2", strategy.long, qty = 10)
plot(strategy.position_size)`, bars);
    expect(posSeries(r)).toEqual([0, 10, 0, 0]);
  });

  it('max_intraday_filled_orders stops new orders for the rest of the day', async () => {
    const r = await runStrat(`strategy("s")
strategy.risk.max_intraday_filled_orders(2)
if bar_index == 0
  strategy.entry("L", strategy.long)
if bar_index == 2
  strategy.entry("S", strategy.short)
if bar_index == 4
  strategy.entry("L2", strategy.long)
plot(strategy.position_size)`, mkBars(6, 10));
    // fills at bar1 and bar3 reach the cap → bar4's entry is dropped
    expect(posSeries(r)).toEqual([0, 1, 1, 0, 0, 0]);
  });

  it('max_cons_loss_days stops after N losing days', async () => {
    const bars = ohlc([
      [0, 100, 101, 99, 100],
      [DAY, 100, 101, 94, 95],
      [2 * DAY, 95, 96, 89, 90],
      [3 * DAY, 90, 91, 84, 85],
    ]);
    const r = await runStrat(`strategy("s", initial_capital = 10000)
strategy.risk.max_cons_loss_days(2)
if bar_index == 0
  strategy.entry("L", strategy.long, qty = 10)
plot(strategy.position_size)`, bars);
    // day1 −50, day2 −50 → two losing days → flatten on bar2's close
    expect(posSeries(r)).toEqual([0, 10, 0, 0]);
  });
});

