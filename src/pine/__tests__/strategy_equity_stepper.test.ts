// ── equity-curve stepper: bit-identical to the old per-bar replay ───────────
// The new equity metrics fold the stepper's recorded `SimCache.equity` prefix
// (strategyEquity.ts). This harness pins that recorded curve to the OLD
// implementation — a from-scratch `simulate()` replay of every past bar — as a
// FROZEN ORACLE. The two must be bit-identical (Object.is, never toBeCloseTo):
// any divergence in fill timing, commission booking or the riskWalk write
// point shows up here.
//
// The oracle below is copied VERBATIM from the removed shifted()/equityAt()
// (strategyEquity.ts @ pre-S2). DO NOT REFACTOR — it is the ground truth.
//
// ONE deliberate exception: `strategy.risk.max_cons_loss_days`, whose trigger
// bar is gated on the END OF THE CURRENT RUN (`b === uptoBar`) — so the old
// per-read replay contradicted itself across bars and cannot serve as an
// oracle. That rule has its own pinned test at the bottom of this file, and
// the oracle matrix below deliberately does not install it.

import { describe, expect, it } from 'vitest';
import type { BarData, BuiltinCtx, Value } from '../contracts';
import { BarCtx } from '../context';
import '../builtins';
import { BUILTINS, getConstant } from '../builtins';
import { cfgOf, simulate, type StratOrder } from '../builtins/strategy';
import { snapCtxState, restoreCtxState } from '../interpreter';

// ── FROZEN ORACLE (verbatim old shifted()/equityAt()) ──────────────────────
/** Offset every get(n) by (cur − b) so simulate(uptoBar=b) sees bar-b prices. */
function shifted(ctx: BuiltinCtx, b: number): BuiltinCtx {
  const d = ctx.barIndex - b;
  if (d === 0) return ctx;
  const s = (x: { get(n: number): Value }) => ({
    get: (n: number) => x.get(n + d),
  });
  return {
    ...ctx,
    open: s(ctx.open),
    high: s(ctx.high),
    low: s(ctx.low),
    close: s(ctx.close),
    // `time` too: simulate() derives its day boundaries (`risk.*` daily rules)
    // and leg exit times from it, and an unshifted series would make every bar
    // read the CURRENT bar's time — contradicting this wrapper's contract.
    time: s(ctx.time),
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
  const open = sim.qty !== 0 && Number.isFinite(close)
    ? sim.qty * (close - sim.avgEntry)
    : 0;
  return cfg.initial_capital + sim.realizedPnl + open;
}
// ── end FROZEN ORACLE ──────────────────────────────────────────────────────

function mkBars(closes: number[]): BarData[] {
  return closes.map((c, i) => ({
    openTime: i * 60000,
    closeTime: (i + 1) * 60000 - 1,
    open: c,
    high: c + 2,
    low: c - 2,
    close: c,
    volume: 1000 + i,
  }));
}

type Ctx = BuiltinCtx & { state: Map<string, unknown> };

function mkRtCtx(bars: BarData[]): { ctx: Ctx; barCtx: BarCtx } {
  const barCtx = new BarCtx(bars, { market: 'D' });
  const ctx = barCtx.seek(0) as Ctx;
  ctx.state = new Map();
  return { ctx, barCtx };
}

function callStrategy(name: string, args: Value[] = [], named: Record<string, Value> = {}, ctx?: Ctx): Value {
  const fn = BUILTINS.get(`strategy.${name}`);
  if (!fn) throw new Error(`strategy.${name} not registered`);
  return fn(ctx ?? mkRtCtx(mkBars([0])).ctx, args, named);
}

function numV(v: Value | undefined): number {
  return v && (v.kind === 'int' || v.kind === 'float') ? v.v : NaN;
}

const S = (v: string): Value => ({ kind: 'string', v });

const F = (v: number): Value => ({ kind: 'float', v });

/** Per-bar `Object.is` triage of the recorded sink against BOTH anchors: the
 *  frozen oracle and the hand-computed literal. Returns one line per mismatch
 *  so a red run shows every divergent bar at once. */
function mismatches(got: number[], want: number[], ctx: Ctx, bars: number): string[] {
  const orders = ordersOf(ctx);
  const out: string[] = [];
  for (let b = 0; b < bars; b++) {
    const oracle = equityAt(ctx, orders, b);
    if (!Object.is(got[b], want[b])) out.push(`b=${b} sink=${got[b]} want=${want[b]}`);
    if (!Object.is(got[b], oracle)) out.push(`b=${b} sink=${got[b]} oracle=${oracle}`);
  }
  return out;
}

function ordersOf(ctx: Ctx): StratOrder[] {
  return (ctx.state.get('strategy|orders') as StratOrder[] | undefined) ?? [];
}

/** The stepper's recorded equity curve (SimCache.equity). */
function recordedEquity(ctx: Ctx): number[] {
  return (ctx.state.get('strategy|simCache') as { equity: number[] } | undefined)?.equity ?? [];
}

/** Per-bar `Object.is` triage of the recorded sink against the FROZEN ORACLE
 *  over the CURRENT ledger — for the invalidation-branch cells, where the
 *  ledger changes mid-test and a hard-coded literal would pin the wrong thing. */
function oracleMismatches(ctx: Ctx, bars: number): string[] {
  const orders = ordersOf(ctx);
  const rec = recordedEquity(ctx);
  const out: string[] = [];
  for (let b = 0; b < bars; b++) {
    const want = equityAt(ctx, orders, b);
    if (!Object.is(rec[b], want)) out.push(`b=${b} sink=${rec[b]} oracle=${want}`);
  }
  return out;
}

describe('equity-curve stepper is bit-identical to the old per-bar replay', () => {
  it('multi-fill script with a reversal matches the oracle per bar', () => {
    // S-B: 10 bars, bar0 entry L, bar4 close L + entry S, bar7 close S.
    const bars = mkBars([10, 11, 12, 13, 14, 15, 14, 13, 12, 11]);
    const { ctx, barCtx } = mkRtCtx(bars);
    const got: number[] = [];
    const pub: number[] = [];

    for (let b = 0; b < bars.length; b++) {
      barCtx.seek(b);
      if (b === 0) callStrategy('entry', [S('L'), S('strategy.long')], {}, ctx);
      if (b === 4) {
        callStrategy('close', [S('L')], {}, ctx);
        callStrategy('entry', [S('S'), S('strategy.short')], {}, ctx);
      }
      if (b === 7) callStrategy('close', [S('S')], {}, ctx);

      pub.push(numV(getConstant('strategy.equity', ctx))); // drives the stepper
      numV(getConstant('strategy.max_drawdown', ctx)); // drives the curve fold
      const rec = recordedEquity(ctx);
      expect(rec.length).toBe(b + 1); // dense 0..b, no holes
      got.push(rec[b]!);
    }

    // Oracle over the FINAL ledger — later orders must not move earlier bars.
    const orders = ordersOf(ctx);
    for (let b = 0; b < bars.length; b++) {
      const oracle = equityAt(ctx, orders, b);
      expect(Object.is(got[b], oracle)).toBe(true);
      expect(Object.is(pub[b], oracle)).toBe(true);
    }
    expect(got.length).toBe(bars.length);
  });

  it('a rule-triggered flatten is booked post-riskWalk (S-A literals)', () => {
    // 1% commission + risk.max_drawdown(5): bar2 triggers a flatten whose exit
    // commission is booked in that bar's equity. Pre-rule would be 99989.1;
    // post-rule (this recorder + oracle) is 99988.3.
    const bars = mkBars([100, 90, 80, 95, 70]);
    const { ctx, barCtx } = mkRtCtx(bars);
    ctx.state.set('strategy|cfg', {
      ...cfgOf(ctx),
      commission_type: 'strategy.commission.percent',
      commission_value: 1,
    });
    callStrategy('entry', [S('L'), S('strategy.long')], {}, ctx);
    callStrategy('risk.max_drawdown', [{ kind: 'float', v: 5 }], {}, ctx);

    const got: number[] = [];
    for (let b = 0; b < bars.length; b++) {
      barCtx.seek(b);
      numV(getConstant('strategy.equity', ctx));
      numV(getConstant('strategy.max_drawdown', ctx));
      got.push(recordedEquity(ctx)[b]!);
    }

    const orders = ordersOf(ctx);
    const oracle = bars.map((_, b) => equityAt(ctx, orders, b));
    const want = [100000, 99999.1, 99988.3, 99988.3, 99988.3];
    for (let b = 0; b < bars.length; b++) {
      expect(Object.is(got[b], want[b])).toBe(true);
      expect(Object.is(oracle[b], want[b])).toBe(true);
      expect(Object.is(got[b], oracle[b])).toBe(true);
    }
    // Exact dd (float artifact, not 11.7): 100000 − 99988.3.
    expect(Object.is(numV(getConstant('strategy.max_drawdown', ctx)), 11.69999999999709)).toBe(true);
  });

  it('equity[] survives a forming-bar rollback and resume (S-G)', () => {
    const bars = mkBars([100, 101, 103, 104]);
    const { ctx, barCtx } = mkRtCtx(bars);
    barCtx.seek(0);
    callStrategy('entry', [S('L'), S('strategy.long')], {}, ctx);

    barCtx.seek(1);
    numV(getConstant('strategy.equity', ctx)); // drive stepper to bar 1
    const eq1 = recordedEquity(ctx)[1]!;
    const ids = new Map<unknown, unknown>();
    const ck = snapCtxState(ctx.state, ids);

    barCtx.seek(2);
    numV(getConstant('strategy.equity', ctx)); // drives stepper to bar 2
    const eq2 = recordedEquity(ctx)[2]!;
    const before = ctx.state.get('strategy|simCache') as { run?: { bar: number }; byBar: Map<number, unknown> };
    const beforeRollback = { runBar: before.run?.bar, byBarSize: before.byBar.size };

    restoreCtxState(ck, 1, ids);
    const after = ctx.state.get('strategy|simCache') as { run?: { bar: number }; byBar: Map<number, unknown> };
    const afterRollback = { runBar: after.run?.bar, byBarSize: after.byBar.size };

    numV(getConstant('strategy.equity', ctx)); // resume from the restored run
    const eq2again = recordedEquity(ctx)[2]!;

    expect(Object.is(eq2, eq2again)).toBe(true);
    expect(eq1).toBe(100000);
    expect(beforeRollback).toEqual({ runBar: 2, byBarSize: 2 });
    expect(afterRollback).toEqual({ runBar: 1, byBarSize: 1 });
  });

  // ── R1 reds + the settle-matrix: fill bars must settle per bar ────────────
  // The four late-fill triggers (same-bar fills, process_orders_on_close,
  // dup-id `seen` rewinds) and multi-bar walks are the paths where a fill can
  // leak into — or never reach — another bar's mark. Driving is deliberately
  // SPARSE in several cells (reads jump bars) so one run walks several bars at
  // once: the sink must be read-pattern independent.

  it('a mid-walk limit fill marks only its own bar onward (R1-Important-1)', () => {
    // bar0: limit entry (qty 1, limit 91) — only bar3's low (90) touches;
    // bar6: a second order event. Reads at bars 0 and 6..9 only, so run(6)
    // walks bars 1..6 in one pass: the bar3 fill must not leak into bars 1/2.
    const bars = mkBars([100, 99, 98, 92, 93, 94, 95, 96, 97, 98]);
    const { ctx, barCtx } = mkRtCtx(bars);
    barCtx.seek(0);
    callStrategy('entry', [S('L'), S('strategy.long'), F(1), F(91)], {}, ctx);
    numV(getConstant('strategy.equity', ctx)); // drive the stepper through bar 0

    barCtx.seek(6);
    callStrategy('close', [S('L')], {}, ctx); // second order event at bar 6
    numV(getConstant('strategy.equity', ctx)); // run(6) walks bars 1..6 at once
    for (let b = 7; b < bars.length; b++) {
      barCtx.seek(b);
      numV(getConstant('strategy.equity', ctx));
    }

    expect(recordedEquity(ctx).length).toBe(bars.length);
    // Bars 1/2 stay flat (initial capital); the bar3 fill marks 100000 +
    // (close − 91); the bar6 close order fills at bar7's open (96) → +5.
    const want = [100000, 100000, 100000, 100001, 100002, 100003, 100004, 100005, 100005, 100005];
    expect(mismatches(recordedEquity(ctx), want, ctx, bars.length)).toEqual([]);
  });

  it('a same-bar fill re-books its bar’s mark (R1-Important-2)', () => {
    // process_orders_on_close + 1% commission: the bar0 entry fills at bar0's
    // close — after the bar's mark exists — so the mark must be re-booked:
    // sink[0] is the settled 99999, never the pre-fill 100000.
    const bars = mkBars([100, 100, 100]);
    const { ctx, barCtx } = mkRtCtx(bars);
    ctx.state.set('strategy|cfg', {
      ...cfgOf(ctx),
      commission_type: 'strategy.commission.percent',
      commission_value: 1,
      process_orders_on_close: true,
    });
    barCtx.seek(0);
    callStrategy('entry', [S('L'), S('strategy.long')], {}, ctx);
    for (let b = 0; b < bars.length; b++) {
      barCtx.seek(b);
      numV(getConstant('strategy.equity', ctx));
    }

    const want = [99999, 99999, 99999]; // 100000 − 1% × 100 commission
    expect(mismatches(recordedEquity(ctx), want, ctx, bars.length)).toEqual([]);
  });

  it('a fill and a rule-triggered flatten on the same bar book post-flatten (matrix)', () => {
    // bar0: market entry A (fills bar1 @100) + limit entry B (limit 89, fills
    // bar4 @89) + risk.max_drawdown(5). Bar4 books BOTH the limit fill and the
    // trigger's flatten (close @90 → −9): its mark is 99991, and bars 1..3 must
    // not carry B's fill. Reads at bars 0 and 4..9 (run(4) walks bars 1..4).
    const bars = mkBars([100, 100, 100, 100, 90, 90, 90, 90, 90, 90]);
    const { ctx, barCtx } = mkRtCtx(bars);
    barCtx.seek(0);
    callStrategy('entry', [S('A'), S('strategy.long'), F(1)], {}, ctx);
    callStrategy('entry', [S('B'), S('strategy.long'), F(1), F(89)], {}, ctx);
    callStrategy('risk.max_drawdown', [F(5)], {}, ctx);
    numV(getConstant('strategy.equity', ctx));
    for (let b = 4; b < bars.length; b++) {
      barCtx.seek(b);
      numV(getConstant('strategy.equity', ctx));
    }

    // B's fill at bar4 (2 lots @94.5 avg marked at 90) drops equity 9 below
    // the 100000 peak → max_drawdown(5) flattens at bar4's close (90): −10 +1.
    const want = [100000, 100000, 100000, 100000, 99991, 99991, 99991, 99991, 99991, 99991];
    expect(mismatches(recordedEquity(ctx), want, ctx, bars.length)).toEqual([]);
  });

  it('a mid-range fill and a later rule trigger share one walk (matrix)', () => {
    // bar0: market entry A (fills bar1 @100) + limit entry B (limit 97, fills
    // bar2 @97) + risk.max_drawdown(5). One sparse read at bar4 walks bars
    // 1..4: bar2's fill must not leak into bar1's mark (100000, not 100003),
    // and the trigger fires at bar4 — the drop there (100001 − 99979 = 22 for
    // the settled view) crosses 5 while bar2's does not (1 < 5).
    const bars = mkBars([100, 100, 99, 99, 88, 88, 88]);
    const { ctx, barCtx } = mkRtCtx(bars);
    barCtx.seek(0);
    callStrategy('entry', [S('A'), S('strategy.long'), F(1)], {}, ctx);
    callStrategy('entry', [S('B'), S('strategy.long'), F(1), F(97)], {}, ctx);
    callStrategy('risk.max_drawdown', [F(5)], {}, ctx);
    numV(getConstant('strategy.equity', ctx)); // run(0)
    barCtx.seek(4);
    numV(getConstant('strategy.equity', ctx)); // run(4) walks bars 1..4 at once
    for (let b = 5; b < bars.length; b++) {
      barCtx.seek(b);
      numV(getConstant('strategy.equity', ctx));
    }

    // A@100 (bar1), B@97 (bar2) → 2 lots @98.5: 100001 at bars 2/3; the bar4
    // drop (88 close → 99979) triggers, flatten books (88−100)+(88−97) = −21.
    const want = [100000, 100000, 100001, 100001, 99979, 99979, 99979];
    expect(mismatches(recordedEquity(ctx), want, ctx, bars.length)).toEqual([]);
  });

  it('a fill at the walk range’s last bar marks that bar post-fill (matrix)', () => {
    // bar0: limit entry (limit 87) — only bar4's low (86) touches. A sparse
    // read at bar4 walks bars 1..4 and the fill lands on the range's LAST bar:
    // bars 1..3 stay flat, bar4 carries the fill.
    const bars = mkBars([100, 101, 102, 103, 88, 90, 91]);
    const { ctx, barCtx } = mkRtCtx(bars);
    barCtx.seek(0);
    callStrategy('entry', [S('L'), S('strategy.long'), F(1), F(87)], {}, ctx);
    numV(getConstant('strategy.equity', ctx)); // run(0)
    for (let b = 4; b < bars.length; b++) {
      barCtx.seek(b);
      numV(getConstant('strategy.equity', ctx));
    }

    // Fill @min(87, open 88) = 87 on bar4; marks are 100000 + (close − 87).
    const want = [100000, 100000, 100000, 100000, 100001, 100003, 100004];
    expect(mismatches(recordedEquity(ctx), want, ctx, bars.length)).toEqual([]);
  });

  it('a dup-id `seen` rewind re-books the modified bar (matrix)', () => {
    // process_orders_on_close: the bar2 dup-id modification re-checks its new
    // limit against bar2 itself (seen rewind to 1) and fills there @91 AFTER
    // the bar's mark was booked — the mark must be re-booked (100001), not
    // frozen at the pre-fill 100000.
    const bars = mkBars([100, 100, 92, 93, 94]);
    const { ctx, barCtx } = mkRtCtx(bars);
    ctx.state.set('strategy|cfg', { ...cfgOf(ctx), process_orders_on_close: true });
    barCtx.seek(0);
    callStrategy('entry', [S('E'), S('strategy.long'), F(1), F(50)], {}, ctx); // never touches
    numV(getConstant('strategy.equity', ctx)); // run(0)
    barCtx.seek(2);
    callStrategy('entry', [S('E'), S('strategy.long'), F(1), F(91)], {}, ctx); // modify → fills bar2
    numV(getConstant('strategy.equity', ctx)); // run(2) walks bars 1..2 at once
    for (let b = 3; b < bars.length; b++) {
      barCtx.seek(b);
      numV(getConstant('strategy.equity', ctx));
    }

    // Rewind fill @min(91, open 92) = 91 on bar2; marks 100000 + (close − 91).
    const want = [100000, 100000, 100001, 100002, 100003];
    expect(mismatches(recordedEquity(ctx), want, ctx, bars.length)).toEqual([]);
  });

  it('rule evaluation sees settled state only — no fill look-ahead (matrix)', () => {
    // THE rule-timing correction, pinned. Same shape as the mid-range cell but
    // with the limit close enough that the OLD batched walk's ruleBody(1) saw
    // B's bar2 fill: eq(1) read 100005 (look-ahead) → peak 100005 → the drop
    // at bar2 (6) tripped max_drawdown(5) there. The settled view keeps eq(1)
    // at 100000 and trips at bar4 instead (drop 19). This literal pins the
    // corrected timing; it is a deliberate change, not oracle drift.
    const bars = mkBars([100, 100, 97, 97, 88, 88, 88]);
    const { ctx, barCtx } = mkRtCtx(bars);
    barCtx.seek(0);
    callStrategy('entry', [S('A'), S('strategy.long'), F(1)], {}, ctx);
    callStrategy('entry', [S('B'), S('strategy.long'), F(1), F(95)], {}, ctx); // fills bar2 @95
    callStrategy('risk.max_drawdown', [F(5)], {}, ctx);
    numV(getConstant('strategy.equity', ctx)); // run(0)
    barCtx.seek(4);
    numV(getConstant('strategy.equity', ctx)); // run(4) walks bars 1..4 at once
    for (let b = 5; b < bars.length; b++) {
      barCtx.seek(b);
      numV(getConstant('strategy.equity', ctx));
    }

    const want = [100000, 100000, 99999, 99999, 99981, 99981, 99981];
    expect(mismatches(recordedEquity(ctx), want, ctx, bars.length)).toEqual([]);
  });

  // ── SimCache invalidation branches (P9 advisor must-fix; R2 residual 2) ───
  // simAt drops the memo + the recorded curve when the ledger shrinks, when an
  // order is appended, and when it empties. Those three branches had no
  // directed test — only the forming-bar OHLC branch was covered by the fuzz.
  it('a shrunken ledger wipes the curve and re-walks it (branch: orders shrink)', () => {
    // The scenario must make the two ledgers OBSERVABLY different, or the
    // memo's stale curve would satisfy the oracle anyway: the close fills at
    // bar3's open (110 = bar3's close) and pays an exit commission, so the
    // flattened mark (100007.9) differs from the open-position mark (100009).
    const bars = mkBars([100, 100, 100, 110]);
    const { ctx, barCtx } = mkRtCtx(bars);
    ctx.state.set('strategy|cfg', {
      ...cfgOf(ctx),
      commission_type: 'strategy.commission.percent',
      commission_value: 1,
    });
    barCtx.seek(0);
    callStrategy('entry', [S('A'), S('strategy.long')], {}, ctx); // fills bar1 @100
    barCtx.seek(2);
    callStrategy('close', [S('A')], {}, ctx); // fills bar3's open (110)
    barCtx.seek(3);
    numV(getConstant('strategy.equity', ctx));
    expect(recordedEquity(ctx).length).toBe(4);
    expect(Object.is(recordedEquity(ctx)[3], 100007.9)).toBe(true); // −1% −1.1%, +10

    // Rollback shrank the ledger: the close is gone, so the marks the cache
    // carries for bar 3 (flattened at 110, exit commission booked) are wrong,
    // and the memo would hand them back verbatim. The branch must wipe and the
    // resume must re-walk from bar 0 — no exit commission, open position: 100009.
    const orders = ordersOf(ctx);
    ctx.state.set('strategy|orders', orders.slice(0, 1));
    numV(getConstant('strategy.equity', ctx));

    expect(Object.is(recordedEquity(ctx)[3], 100009)).toBe(true);
    expect(recordedEquity(ctx).length).toBe(4); // dense 0..3 again
    expect(oracleMismatches(ctx, bars.length)).toEqual([]);
  });

  it('an order appended after the bar was marked re-walks that bar (branch: orders append)', () => {
    const bars = mkBars([100, 100, 100, 92, 93]);
    const { ctx, barCtx } = mkRtCtx(bars);
    ctx.state.set('strategy|cfg', { ...cfgOf(ctx), process_orders_on_close: true });
    barCtx.seek(0);
    callStrategy('entry', [S('L'), S('strategy.long'), F(1), F(50)], {}, ctx); // never fills
    barCtx.seek(3);
    numV(getConstant('strategy.equity', ctx)); // curve 0..3, still flat
    expect(recordedEquity(ctx).length).toBe(4);

    // New order appended at the CURRENT bar after its mark was booked: the
    // branch drops the run and truncates the curve to that bar, so the fill
    // re-books bar 3 instead of leaving the stale flat mark. Asserted BEFORE
    // the walk extends — a later read would reprocess the new order through the
    // resume path and re-book bar 3 anyway, which hides the branch entirely.
    callStrategy('entry', [S('M'), S('strategy.long'), F(1), F(91)], {}, ctx);
    numV(getConstant('strategy.equity', ctx));

    expect(Object.is(recordedEquity(ctx)[3], 100001)).toBe(true);
    expect(oracleMismatches(ctx, 4)).toEqual([]);

    barCtx.seek(4);
    numV(getConstant('strategy.equity', ctx));

    expect(recordedEquity(ctx).length).toBe(5);
    expect(oracleMismatches(ctx, bars.length)).toEqual([]);
  });

  it('max_cons_loss_days: the curve is the causal history, not a per-bar re-replay', () => {
    // DELIBERATE divergence from the frozen oracle — the one rule the matrix
    // above excludes. `max_cons_loss_days` is judged on "the day's last bar",
    // which the stepper approximates as the END OF THE CURRENT RUN
    // (`b === uptoBar`, strategy.ts:784). A streamed read finishes its run at
    // the bar being read, so with a read at bar 3 the check fires there and the
    // rule's halt is permanent; a from-scratch replay to bar 5 only ever checks
    // bar 5. Hence sink[5] = 99988.04 (flattened at bar 3's close 101) while
    // equityAt(5) = 99979.96 (still short, flattened at bar 5's close 105).
    // The OLD per-read replay was itself self-contradictory across bars (bar 3
    // said "flattened at 3", bar 5 said "flattened at 5"); the recorded curve
    // is one consistent history instead. Pinned here so a future change to the
    // run-end gate has to be a conscious one.
    const bars = mkBars([100, 97, 97, 101, 101, 105, 105, 108, 113, 117, 118]);
    const { ctx, barCtx } = mkRtCtx(bars);
    ctx.state.set('strategy|cfg', {
      ...cfgOf(ctx),
      commission_type: 'strategy.commission.percent',
      commission_value: 1,
    });
    callStrategy('risk.max_cons_loss_days', [F(1)], {}, ctx);
    callStrategy('entry', [S('E0'), S('strategy.short'), F(2)], {}, ctx); // fills bar1 @97

    const got: number[] = [];
    for (let b = 0; b < bars.length; b++) {
      barCtx.seek(b);
      numV(getConstant('strategy.equity', ctx));
      numV(getConstant('strategy.max_drawdown', ctx));
      got.push(recordedEquity(ctx)[b]!);
    }

    // −1.94 entry commission, then −8 + 2.02 exit commission when the rule
    // flattens at bar 3's close (101) → 99988.04, held to the last bar.
    const want = [100000, 99998.06, 99998.06, 99988.04, 99988.04, 99988.04, 99988.04, 99988.04, 99988.04, 99988.04, 99988.04];
    for (let b = 0; b < bars.length; b++) expect(Object.is(got[b], want[b])).toBe(true);

    const orders = ordersOf(ctx);
    expect(Object.is(got[3], equityAt(ctx, orders, 3))).toBe(true);   // same run end → same answer
    expect(Object.is(equityAt(ctx, orders, 5), 99979.96)).toBe(true); // fresh replay to 5 flattens at 5
    expect(Object.is(got[5], equityAt(ctx, orders, 5))).toBe(false); // …and that is the pinned divergence
  });

  it('an emptied ledger clears the curve (branch: no orders)', () => {
    const bars = mkBars([100, 101, 102]);
    const { ctx, barCtx } = mkRtCtx(bars);
    barCtx.seek(0);
    callStrategy('entry', [S('A'), S('strategy.long')], {}, ctx);
    barCtx.seek(2);
    numV(getConstant('strategy.equity', ctx));
    expect(recordedEquity(ctx).length).toBe(3);

    ctx.state.set('strategy|orders', []); // rollback to before any order
    expect(Object.is(numV(getConstant('strategy.equity', ctx)), 100000)).toBe(true);
    expect(recordedEquity(ctx).length).toBe(0);
    expect(Object.is(numV(getConstant('strategy.max_drawdown', ctx)), 0)).toBe(true);
  });
});
