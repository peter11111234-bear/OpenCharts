// ── equity-sink differential: the call surfaces the R2 probe never walked ────
// CHARACTERISATION / REGRESSION COVERAGE — not a bug fix. Exploration over 1200
// scenarios found 0 divergences; this file pins that so a later change to fill
// settlement, the risk walk or the per-bar cache cannot move the sink silently.
//
// Contract, per bar b, with `Object.is` (NEVER toBeCloseTo):
//   1. `SimCache.equity[b]`                 === oracle(b)
//   2. public `strategy.equity` read at b   === oracle(b)
//   3. stride invariance: reading every bar one by one and reading a sparse set
//      (so one run walks several bars at once) give element-wise equal sinks
//   4. hand-derived FROZEN LITERALS per face — an anchor independent of both live
//      computations, because the oracle and the subject share code (see limit 1)
//
// KNOWN LIMITS — keep these explicit; do not "simplify" them away:
//   1. The oracle replays with the product's own `simulate()`. This proves
//      "cached fold == from-scratch replay", NOT "simulate() is correct": fill
//      matching, OCA semantics, commission, risk thresholds, margin calls and
//      FIFO leg booking are structurally blind to this differential.
//   2. `strategy.exit`'s `from_entry` is a DEAD parameter (strategy.ts:567 is its
//      only read, and a cancel always carries fromEntry ""), so an exit flattens
//      the whole position. Its cell pins observable behaviour — it is NOT a
//      correctness claim.
//   3. `strategy.risk.max_cons_loss_days` gates its day-end on the current run's
//      last bar, so a per-read replay contradicts itself across bars. It is NOT
//      installed here; strategy_equity_stepper.test.ts pins it separately.
//   4. Assertions stay on finite closes: the sink folds through `curveEquity`
//      (which guards a non-finite close) while the public read does not.
//   5. `profit` / `loss` / `trail_*` are MINTICK-denominated and BarCtx defaults
//      `syminfo.mintick` to 0.01, so every cell sets it EXPLICITLY (mintick = 1).

import { describe, expect, it } from 'vitest';
import type { BarData, BuiltinCtx, Value } from '../contracts';
import { BarCtx } from '../context';
import '../builtins';
import { BUILTINS, getConstant } from '../builtins';
import { cfgOf, simulate, type StratOrder } from '../builtins/strategy';

// ── FROZEN ORACLE (verbatim from strategy_equity_stepper.test.ts) ──────────
/** Offset every get(n) by (cur − b) so simulate(uptoBar=b) sees bar-b prices. */
function shifted(ctx: BuiltinCtx, b: number): BuiltinCtx {
  const d = ctx.barIndex - b;
  if (d === 0) return ctx;
  const s = (x: { get(n: number): Value }) => ({ get: (n: number) => x.get(n + d) });
  return {
    ...ctx,
    open: s(ctx.open), high: s(ctx.high), low: s(ctx.low), close: s(ctx.close), time: s(ctx.time),
  } as BuiltinCtx;
}
/** Mark-to-market equity at bar `b` (uses that bar's close for open P&L). */
function equityAt(ctx: BuiltinCtx, orders: StratOrder[], b: number): number {
  const cfg = cfgOf(ctx);
  if (orders.length === 0 || b < 0) return cfg.initial_capital;
  const sc = shifted(ctx, b);
  const sim = simulate(sc, orders, cfg, b);
  const cv = sc.close.get(0);
  const close = cv.kind === 'int' || cv.kind === 'float' ? cv.v : NaN;
  const open = sim.qty !== 0 && Number.isFinite(close) ? sim.qty * (close - sim.avgEntry) : 0;
  return cfg.initial_capital + sim.realizedPnl + open;
}
// ── end FROZEN ORACLE ──────────────────────────────────────────────────────

type Ctx = BuiltinCtx & { state: Map<string, unknown> };
const S = (v: string): Value => ({ kind: 'string', v });
const F = (v: number): Value => ({ kind: 'float', v });
const numV = (v: Value | undefined): number => (v && (v.kind === 'int' || v.kind === 'float') ? v.v : NaN);

/** Explicit OHLC rows `[open, high, low, close]`, optional whole minutes per day. */
function mkBars(rows: number[][], dayLen = 0): BarData[] {
  const t = (i: number): number => (dayLen <= 0
    ? i * 60000
    : Date.UTC(2026, 0, 1 + Math.floor(i / dayLen)) + (i % dayLen) * 60000);
  return rows.map((r, i) => ({
    openTime: t(i), closeTime: t(i) + 59999, open: r[0]!, high: r[1]!, low: r[2]!, close: r[3]!, volume: 1000 + i,
  }));
}
const R = (o: number, h: number, l: number, c: number): number[] => [o, h, l, c];

interface Call { bar: number; qual: string; args: Value[]; named?: Record<string, Value> }

/** Drive one scenario. Every bar is SEQUENCED (the script body runs on all of
 *  them), but the equity is only READ at `reads` — a sparse read set makes one
 *  run walk several bars at once, the path where a fill could leak across bars.
 *  Reading sparsely must not change which orders exist: only the queries do. */
function drive(bars: BarData[], calls: Call[], rules: Call[], reads: number[], cfg: Record<string, unknown> = {}) {
  const barCtx = new BarCtx(bars, { market: 'D' });
  const ctx = barCtx.seek(0) as Ctx;
  ctx.state = new Map();
  (ctx as unknown as { syminfo: Record<string, Value> }).syminfo = { mintick: F(1) };
  ctx.state.set('strategy|cfg', { ...cfgOf(ctx), ...cfg });
  const call = (c: Call): void => {
    const fn = BUILTINS.get(c.qual);
    if (!fn) throw new Error(`not registered: ${c.qual}`);
    fn(ctx, c.args, c.named ?? {});
  };
  for (const r of rules) call(r);
  const readAt: boolean[] = [];
  for (const b of reads) readAt[b] = true;
  const pub: number[] = []; // sparse: index = bar, only the observed bars are set
  for (let b = 0; b < bars.length; b++) {
    barCtx.seek(b);
    for (const c of calls) if (c.bar === b) call(c);
    if (!readAt[b]) continue;
    pub[b] = numV(getConstant('strategy.equity', ctx));
    numV(getConstant('strategy.max_drawdown', ctx)); // drives the curve fold too
  }
  const equity = (ctx.state.get('strategy|simCache') as { equity: number[] } | undefined)?.equity ?? [];
  const orders = (ctx.state.get('strategy|orders') as StratOrder[] | undefined) ?? [];
  return { ctx, sink: Array.from(equity), orders, pub };
}

const eqArr = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => Object.is(v, b[i]!));

/** Three anchors + density: literals, oracle, public read, and one sink entry per
 *  observed bar. Returns the divergent bars so a red run shows all of them. */
function triage(sink: number[], hand: number[] | undefined, pub: number[], ctx: Ctx, orders: StratOrder[], bars: number): string[] {
  const bad: string[] = [];
  if (sink.length !== bars) bad.push(`density: sink.length=${sink.length} want=${bars}`);
  for (let b = 0; b < bars; b++) {
    const oracle = equityAt(ctx, orders, b);
    if (!Object.is(sink[b], oracle)) bad.push(`b=${b} sink=${sink[b]} oracle=${oracle}`);
    if (hand && !Object.is(sink[b], hand[b]!)) bad.push(`b=${b} sink=${sink[b]} literal=${hand[b]}`);
    const p = pub[b];
    if (p !== undefined && !Object.is(p, oracle)) bad.push(`b=${b} public=${p} oracle=${oracle}`);
  }
  return bad;
}

// ── G1 strategy.exit: hand-derived frozen literals ─────────────────────────
describe('strategy.exit faces settle per bar (frozen literals + oracle)', () => {
  it('profit=10 ticks: fills at the limit, that bar re-booked, flat after', () => {
    const bars = mkBars([
      R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 103, 99, 102), R(102, 106, 101, 105),
      R(105, 112, 104, 110), R(110, 112, 108, 109), R(109, 110, 107, 108), R(108, 109, 107, 108),
    ]);
    const calls: Call[] = [
      { bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(1)] },
      // id, from_entry, qty, qty_percent, profit, limit, loss
      { bar: 1, qual: 'strategy.exit', args: [S('X'), S('E'), F(1), F(0), F(10), F(NaN), F(5)] },
    ];
    const { ctx, sink, orders, pub } = drive(bars, calls, [], [0, 1, 2, 3, 4, 5, 6, 7]);
    const hand = [100000, 100000, 100002, 100005, 100010, 100010, 100010, 100010];
    expect(triage(sink, hand, pub, ctx, orders, bars.length)).toEqual([]);
    expect(eqArr(sink, hand)).toBe(true);
  });

  it('loss=5 ticks: fills at the stop and holds after', () => {
    const bars = mkBars([
      R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 102, 99, 101), R(101, 103, 94, 96),
      R(96, 98, 94, 96), R(96, 98, 94, 96), R(96, 98, 94, 96), R(96, 98, 94, 96),
    ]);
    const calls: Call[] = [
      { bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(1)] },
      { bar: 1, qual: 'strategy.exit', args: [S('X'), S('E'), F(1), F(0), F(NaN), F(NaN), F(5)] },
    ];
    const { ctx, sink, orders, pub } = drive(bars, calls, [], [0, 1, 2, 3, 4, 5, 6, 7]);
    const hand = [100000, 100000, 100001, 99995, 99995, 99995, 99995, 99995];
    expect(triage(sink, hand, pub, ctx, orders, bars.length)).toEqual([]);
  });

  it('from_entry is accepted but not used (BEHAVIOUR PIN, not a correctness claim)', () => {
    // Same scenario as the profit cell, but the exit names a different entry id:
    // the position still flattens, which is what the engine does today.
    const bars = mkBars([
      R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 103, 99, 102), R(102, 106, 101, 105),
      R(105, 112, 104, 110), R(110, 112, 108, 109), R(109, 110, 107, 108), R(108, 109, 107, 108),
    ]);
    const calls: Call[] = [
      { bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(1)] },
      { bar: 1, qual: 'strategy.exit', args: [S('X'), S('OTHER'), F(1), F(0), F(10), F(NaN), F(5)] },
    ];
    const { ctx, sink, orders, pub } = drive(bars, calls, [], [0, 1, 2, 3, 4, 5, 6, 7]);
    // The discriminator is bars 5..7, NOT bar 4: an honoured from_entry would leave
    // the position open, so it would ride 110 → 109 → 108 (100010, 100009, 100008)
    // instead of flattening at 110. Asserting only sink[4] passed in both worlds.
    const hand = [100000, 100000, 100002, 100005, 100010, 100010, 100010, 100010];
    expect(triage(sink, hand, pub, ctx, orders, bars.length)).toEqual([]);
    expect(eqArr(sink, hand)).toBe(true);
  });

  it('trail_points arms at the excursion and trail_offset trails the peak', () => {
    // Peak 106 (bar 3) >= act 105 → stop = 106 − 3 = 103 → bar 3's low 102 takes it.
    const bars = mkBars([
      R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 104, 99, 103), R(103, 106, 102, 105),
      R(105, 106, 104, 105), R(105, 106, 104, 105), R(105, 106, 104, 105), R(105, 106, 104, 105),
    ]);
    const calls: Call[] = [
      { bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(1)] },
      // id, from_entry, qty, qty_percent, profit, limit, loss, stop, trail_price, trail_points, trail_offset
      { bar: 1, qual: 'strategy.exit', args: [S('X'), S('E'), F(1), F(0), F(NaN), F(NaN), F(NaN), F(NaN), F(NaN), F(5), F(3)] },
    ];
    const { ctx, sink, orders, pub } = drive(bars, calls, [], [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(triage(sink, undefined, pub, ctx, orders, bars.length)).toEqual([]);
    expect(sink[2]).toBe(100003);            // still open, marked at the close
    expect(sink[3]).toBe(100003);            // filled at 103 → +3, and the bar is re-booked
    expect(sink[7]).toBe(100003);
  });
});

// ── G2 oca ─────────────────────────────────────────────────────────────────
describe('oca siblings', () => {
  it('oca.cancel: the filled leg cancels its sibling for good', () => {
    // DISCRIMINATOR: sibling S (stop 95) is reachable on bar 5 (low 94) — after T
    // filled on bar 3. With the cancel honoured S never fills and 1 lot rides to 97
    // (100002); a broken cancel lets S sell at 95 and leaves 100000. The old version
    // put S at a level no bar ever touched, so it passed with oca removed entirely.
    const bars = mkBars([
      R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 106, 99, 105),
      R(105, 108, 104, 107), R(107, 108, 94, 97), R(97, 99, 96, 97), R(97, 99, 96, 97),
    ]);
    const calls: Call[] = [
      { bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(2)] },
      { bar: 1, qual: 'strategy.exit', args: [S('T'), S('E'), F(1), F(100), F(NaN), F(105), F(NaN), F(NaN), F(NaN), F(NaN), F(NaN), S('g'), S('strategy.oca.cancel')] },
      { bar: 1, qual: 'strategy.exit', args: [S('S'), S('E'), F(1), F(100), F(NaN), F(NaN), F(NaN), F(95), F(NaN), F(NaN), F(NaN), S('g'), S('strategy.oca.cancel')] },
    ];
    const { ctx, sink, orders, pub } = drive(bars, calls, [], [0, 1, 2, 3, 4, 5, 6, 7]);
    const hand = [100000, 100000, 100000, 100010, 100012, 100002, 100002, 100002];
    expect(triage(sink, hand, pub, ctx, orders, bars.length)).toEqual([]);
    expect(eqArr(sink, hand)).toBe(true);
    expect(orders.map(o => `${o.id}:${o.ocaType}`)).toEqual(['E:undefined', 'T:strategy.oca.cancel', 'S:strategy.oca.cancel']);
  });

  it('oca.reduce: the filled leg reduces the sibling instead of cancelling it', () => {
    // DISCRIMINATOR: 3 lots @100. T (qty 1, limit 105) fills on bar 3 and cuts
    // sibling S from 3 contracts to 2. S arms on bar 5 (low 94 < stop 95) and sells
    // its reduced 2 — the position ends flat at 99995. A cancel-typed sibling would
    // be gone and the remaining 2 lots would ride 97 → 99999. (A `none` sibling also
    // ends at 99995: resolveQty caps its 3 contracts to the 2 that remain.)
    const bars = mkBars([
      R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 106, 99, 105),
      R(105, 108, 104, 107), R(107, 108, 94, 97), R(97, 99, 96, 97), R(97, 99, 96, 97),
    ]);
    const calls: Call[] = [
      { bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(3)] },
      { bar: 1, qual: 'strategy.exit', args: [S('T'), S('E'), F(1), F(100), F(NaN), F(105), F(NaN), F(NaN), F(NaN), F(NaN), F(NaN), S('g'), S('strategy.oca.reduce')] },
      { bar: 1, qual: 'strategy.exit', args: [S('S'), S('E'), F(3), F(100), F(NaN), F(NaN), F(NaN), F(95), F(NaN), F(NaN), F(NaN), S('g'), S('strategy.oca.reduce')] },
    ];
    const { ctx, sink, orders, pub } = drive(bars, calls, [], [0, 1, 2, 3, 4, 5, 6, 7]);
    const hand = [100000, 100000, 100000, 100015, 100019, 99995, 99995, 99995];
    expect(triage(sink, hand, pub, ctx, orders, bars.length)).toEqual([]);
    expect(eqArr(sink, hand)).toBe(true);
  });
});

// ── G3 cancel / cancel_all / close_all ─────────────────────────────────────
describe('cancel and close_all', () => {
  it('cancel(id) retires a pending limit; close_all flattens at the next open', () => {
    // DISCRIMINATOR: pyramiding=1 keeps the second same-direction entry RESTING
    // (the guard at strategy.ts:583 drops it at the default 0, which made the old
    // version pass with strategy.cancel removed). Bar 3's low 88 reaches E2's
    // limit 90, so a broken cancel would add a second lot at 90 and the bar-4
    // flatten would book +20 instead of +5.
    const bars = mkBars([
      R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 102, 98, 101), R(101, 102, 88, 89),
      R(105, 107, 104, 106), R(106, 107, 105, 106), R(106, 107, 105, 106), R(106, 107, 105, 106),
    ]);
    const calls: Call[] = [
      { bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(1)] },
      { bar: 1, qual: 'strategy.entry', args: [S('E2'), S('strategy.long'), F(1), F(90)] },
      { bar: 2, qual: 'strategy.cancel', args: [S('E2')] },
      { bar: 3, qual: 'strategy.close_all', args: [] },
    ];
    const { ctx, sink, orders, pub } = drive(bars, calls, [], [0, 1, 2, 3, 4, 5, 6, 7], { pyramiding: 1 });
    const hand = [100000, 100000, 100001, 99989, 100005, 100005, 100005, 100005];
    expect(triage(sink, hand, pub, ctx, orders, bars.length)).toEqual([]);
    expect(eqArr(sink, hand)).toBe(true);
  });

  it('cancel_all retires every pending order (none may fill later)', () => {
    // DISCRIMINATOR: E2 rests only because pyramiding=1, and its limit 95 sits
    // inside bar 3's range (88..100). Cancelled → 1 lot @100 rides: 89 → 99889.
    // Alive → a second lot at 95 (avg 97.5) would make bar 3 read 99983.
    const bars = mkBars([
      R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 101, 88, 89),
      R(89, 92, 88, 91), R(91, 93, 90, 92), R(92, 93, 91, 92), R(92, 93, 91, 92),
    ]);
    const calls: Call[] = [
      { bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(1)] },
      { bar: 1, qual: 'strategy.entry', args: [S('E2'), S('strategy.long'), F(1), F(95)] },
      { bar: 2, qual: 'strategy.cancel_all', args: [] },
    ];
    const { ctx, sink, orders, pub } = drive(bars, calls, [], [0, 1, 2, 3, 4, 5, 6, 7], { pyramiding: 1 });
    const hand = [100000, 100000, 100000, 99989, 99991, 99992, 99992, 99992];
    expect(triage(sink, hand, pub, ctx, orders, bars.length)).toEqual([]);
    expect(eqArr(sink, hand)).toBe(true);
  });
});

// ── G4 risk rules ──────────────────────────────────────────────────────────
describe('strategy.risk surfaces', () => {
  it('max_position_size caps the entry; allow_entry_in turns the reverse entry into a close', () => {
    const bars = mkBars([
      R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 102, 98, 100),
      R(104, 106, 103, 104), R(104, 106, 103, 104), R(104, 106, 103, 104), R(104, 106, 103, 104),
    ]);
    const rules: Call[] = [
      { bar: 0, qual: 'strategy.risk.allow_entry_in', args: [S('strategy.direction.long')] },
      { bar: 0, qual: 'strategy.risk.max_position_size', args: [F(1)] },
    ];
    const calls: Call[] = [
      { bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(3)] },
      { bar: 2, qual: 'strategy.entry', args: [S('Sh'), S('strategy.short'), F(1)] },
    ];
    const { ctx, sink, orders, pub } = drive(bars, calls, rules, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(triage(sink, undefined, pub, ctx, orders, bars.length)).toEqual([]);
    // The cap keeps 1 lot (3 would mark +12 on bar 4); the blocked reverse entry
    // CLOSES that lot at bar 3's open 100, so nothing rides the bar-4 rise.
    expect(sink.every(v => Object.is(v, 100000))).toBe(true);
  });

  it('max_drawdown still triggers and flattens through the sink (no regression)', () => {
    const bars = mkBars([R(100, 101, 99, 100), R(100, 101, 99, 90), R(90, 91, 89, 80), R(80, 82, 70, 70),
      R(70, 72, 69, 71), R(71, 73, 70, 72), R(72, 73, 71, 72), R(72, 73, 71, 72)]);
    const rules: Call[] = [{ bar: 0, qual: 'strategy.risk.max_drawdown', args: [F(5)] }];
    const calls: Call[] = [{ bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(1)] }];
    const { ctx, sink, orders, pub } = drive(bars, calls, rules, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(triage(sink, undefined, pub, ctx, orders, bars.length)).toEqual([]);
  });

  it('multi-day: per-day 0.8% twice (cumulative 1.6%) must NOT trigger — the reset', () => {
    const bars = mkBars([
      R(100, 101, 99, 100), R(100, 101, 99, 100), R(100, 101, 99, 100),
      R(100, 101, 98, 99), R(99, 100, 98, 99), R(99, 100, 98, 99),
      R(99, 100, 97, 98), R(98, 99, 97, 98), R(98, 99, 97, 98),
      R(98, 101, 97, 100), R(100, 101, 99, 100), R(100, 101, 99, 100),
    ], 3);
    const rules: Call[] = [{ bar: 0, qual: 'strategy.risk.max_intraday_loss', args: [F(1), S('strategy.percent_of_equity')] }];
    const calls: Call[] = [{ bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(800)] }];
    const { ctx, sink, orders, pub } = drive(bars, calls, rules, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const hand = [100000, 100000, 100000, 99200, 99200, 99200, 98400, 98400, 98400, 100000, 100000, 100000];
    expect(triage(sink, hand, pub, ctx, orders, bars.length)).toEqual([]);
    expect(sink[11]).toBe(100000); // recovered ⇒ nothing was flattened ⇒ the day counter reset
  });

  it('multi-day: one day over the threshold flattens and it stays flat', () => {
    const bars = mkBars([
      R(100, 101, 99, 100), R(100, 101, 99, 100), R(100, 101, 99, 100),
      R(100, 101, 99, 96), R(96, 97, 95, 96), R(96, 97, 95, 96),
      R(96, 101, 95, 100), R(100, 101, 99, 100), R(100, 101, 99, 100),
    ], 3);
    const rules: Call[] = [{ bar: 0, qual: 'strategy.risk.max_intraday_loss', args: [F(0.05), S('strategy.percent_of_equity')] }];
    const calls: Call[] = [{ bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(300)] }];
    const { ctx, sink, orders, pub } = drive(bars, calls, rules, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(triage(sink, undefined, pub, ctx, orders, bars.length)).toEqual([]);
    // −1200 realized on day 2, and the day-3 rise back to 100 does NOT restore it.
    expect(sink[8]).toBe(98800);
  });
});

// ── stride invariance ──────────────────────────────────────────────────────
describe('the sink does not depend on the read stride', () => {
  it('single-bar reads and sparse reads agree element-wise', () => {
    const bars = mkBars([
      R(100, 102, 98, 100), R(100, 102, 98, 100), R(100, 103, 99, 102), R(102, 106, 101, 105),
      R(105, 112, 104, 110), R(110, 112, 108, 109), R(109, 110, 107, 108), R(108, 109, 107, 108),
    ]);
    const calls: Call[] = [
      { bar: 0, qual: 'strategy.entry', args: [S('E'), S('strategy.long'), F(1)] },
      { bar: 1, qual: 'strategy.exit', args: [S('X'), S('E'), F(1), F(0), F(10), F(NaN), F(5)] },
      { bar: 3, qual: 'strategy.order', args: [S('O'), S('strategy.long'), F(1)] },
    ];
    const single = drive(bars, calls, [], [0, 1, 2, 3, 4, 5, 6, 7]);
    const chunked = drive(bars, calls, [], [0, 2, 4, 7]);
    const hand = [100000, 100000, 100002, 100005, 100010, 100010, 100010, 100010];
    expect(eqArr(single.sink, chunked.sink)).toBe(true);
    expect(eqArr(single.sink, hand)).toBe(true);
    expect(triage(chunked.sink, hand, chunked.pub, chunked.ctx, chunked.orders, bars.length)).toEqual([]);
  });
});

// ── bounded deterministic sweep over the same surfaces ─────────────────────
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Scn { bars: BarData[]; calls: Call[]; rules: Call[]; reads: number[]; sparse: number[]; cfg: Record<string, unknown>; tag: string }

function genScn(seed: number, n: number): Scn {
  const r = mulberry32(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const roll = (p: number): boolean => r() < p;
  const rows: number[][] = [[100, 102, 98, 100]];
  let prev = 100;
  for (let i = 1; i < n; i++) {
    const o = prev;
    const c = Math.round((prev + (r() * 8 - 4)) * 100) / 100;
    rows.push(R(o, Math.max(o, c) + Math.round(r() * 2), Math.min(o, c) - Math.round(r() * 2), c));
    prev = c;
  }
  const dayLen = pick([0, 3, 5, 7]);
  const cfg: Record<string, unknown> = {};
  if (roll(0.5)) { cfg.commission_type = 'strategy.commission.percent'; cfg.commission_value = pick([0, 0.1, 1]); }
  if (roll(0.3)) cfg.process_orders_on_close = true;

  const rules: Call[] = [];
  if (roll(0.3)) rules.push({ bar: 0, qual: 'strategy.risk.max_drawdown', args: [F(pick([2, 5, 10]))] });
  if (roll(0.2)) rules.push({ bar: 0, qual: 'strategy.risk.max_intraday_loss', args: [F(pick([0.5, 1, 2])), S('strategy.percent_of_equity')] });
  if (roll(0.2)) rules.push({ bar: 0, qual: 'strategy.risk.max_intraday_filled_orders', args: [F(pick([1, 2, 3]))] });
  if (roll(0.25)) rules.push({ bar: 0, qual: 'strategy.risk.max_position_size', args: [F(pick([1, 2]))] });
  if (roll(0.2)) rules.push({ bar: 0, qual: 'strategy.risk.allow_entry_in', args: [S(pick(['strategy.direction.long', 'strategy.direction.short']))] });

  const calls: Call[] = [];
  let k = 0;
  for (let b = 0; b < n; b++) {
    if (roll(0.5)) {
      const kind = r();
      if (kind < 0.35) {
        const args: Value[] = [S(`E${k++}`), S(pick(['strategy.long', 'strategy.short'])), F(pick([1, 2]))];
        // slots 4/5 (limit, stop) are always written so an entry-side oca pair
        // can land in slots 6/7; F(NaN) reads as 'absent' (optNum).
        args.push(F(roll(0.4) ? pick([95, 99, 101, 105]) : NaN), F(NaN));
        if (roll(0.25)) args.push(S('g'), S(pick(['strategy.oca.cancel', 'strategy.oca.reduce'])));
        calls.push({ bar: b, qual: 'strategy.entry', args });
      } else if (kind < 0.6) {
        // Every slot is written in order — id, from_entry, qty, qty_percent,
        // profit, limit, loss, stop, trail_price, trail_points, trail_offset —
        // because a conditional push here shifted every later positional arg.
        const args: Value[] = [
          S(`X${k++}`), S(pick(['E0', 'E1', ''])), F(pick([1, 0])), F(roll(0.5) ? pick([0, 50, 100]) : 0),
          F(pick([NaN, 3, 10])), F(pick([NaN, 95, 105])),
          F(pick([NaN, 3, 10])), F(pick([NaN, 95, 105])),
          F(NaN), F(pick([NaN, 5])), F(pick([NaN, 2])),
        ];
        if (roll(0.4)) args.push(S('g'), S(pick(['strategy.oca.cancel', 'strategy.oca.reduce'])));
        calls.push({ bar: b, qual: 'strategy.exit', args });
      } else if (kind < 0.8) {
        const args: Value[] = [S(`O${k++}`), S(pick(['strategy.long', 'strategy.short'])), F(pick([1, 2]))];
        if (roll(0.5)) args.push(F(pick([95, 99, 101, 105])));
        calls.push({ bar: b, qual: 'strategy.order', args });
      } else {
        calls.push({ bar: b, qual: 'strategy.close', args: [S(pick(['E0', 'E1', '']))] });
      }
    }
    if (roll(0.1)) calls.push({ bar: b, qual: 'strategy.cancel', args: [S(`E${Math.floor(r() * 3)}`)] });
    if (roll(0.06)) calls.push({ bar: b, qual: 'strategy.cancel_all', args: [] });
    if (roll(0.06)) calls.push({ bar: b, qual: 'strategy.close_all', args: [] });
  }
  const reads: number[] = [];
  for (let b = 0; b < n; b++) if (roll(0.6)) reads.push(b);
  if (reads[reads.length - 1] !== n - 1) reads.push(n - 1);
  const step = 2 + Math.floor(r() * 3);
  const sparse: number[] = [];
  for (let b = 0; b < n; b += step) sparse.push(b);
  if (sparse[sparse.length - 1] !== n - 1) sparse.push(n - 1);
  return { bars: mkBars(rows, dayLen), calls, rules, reads, sparse, cfg, tag: `seed=${seed} dayLen=${dayLen} rules=${rules.length} calls=${calls.length}` };
}

describe('bounded seeded sweep over exit / oca / cancel / risk surfaces', () => {
  const N = 60;
  const BARS = 12;
  it(`${N} deterministic scenarios: sink, public read and stride invariance all agree`, () => {
    const bad: string[] = [];
    let strideChecked = 0;
    for (let seed = 1; seed <= N; seed++) {
      const scn = genScn(seed, BARS);
      const a = drive(scn.bars, scn.calls, scn.rules, scn.reads, scn.cfg);
      const b = drive(scn.bars, scn.calls, scn.rules, scn.sparse, scn.cfg);
      const problems = triage(a.sink, undefined, a.pub, a.ctx, a.orders, BARS);
      if (problems.length > 0) bad.push(`${scn.tag} :: ${problems.slice(0, 4).join(' ; ')}`);
      if (a.sink.length === 0 || b.sink.length === 0) {
        // An order exists in every scenario, so a dense fold must exist for both
        // strides: an empty sink is a failure, not a reason to skip the check.
        bad.push(`${scn.tag} :: empty sink (a=${a.sink.length} b=${b.sink.length})`);
      } else {
        strideChecked++;
        if (!eqArr(a.sink, b.sink)) bad.push(`${scn.tag} :: stride mismatch`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(strideChecked).toBe(N); // pin the sample size: a vacuous skip must fail
  });
});
