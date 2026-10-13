// ── strategy.* simulation layer ─────────────────────────────────────────────
// Design D3 (tv-alignment plan): deterministic replay ledger.
//   * strategy.entry/exit/close/order/cancel append Order records to
//     ctx.state['strategy|orders'] — nothing fills at call time.
//   * Lazy constants (strategy.position_size, .equity, …) replay the ledger
//     at read time, so a value is a pure function of (orders, bar index) and
//     never depends on when the constant is read.
//   * Fill model: an order recorded on bar i fills at bar i+1's open
//     (process_orders_on_close=false) or bar i's close (true). Orders with
//     limit/stop stay pending until their price is touched (limit/stop price
//     or better), cancelled, or the data ends. Reversal entries close the
//     opposite position and open the new side in one fill.
//   * strategyDecl() parses the strategy(...) decl into ctx.state
//     ['strategy|cfg']. The interpreter calls it from the `strategy` decl case
//     (wired by the interpreter task); without it a default config applies.
//
// IMPORTANT: this module self-registers at import time. `builtins/index.ts`
// must contain `import './strategy';` (added by the index task).

import { NA, VTRUE, type BuiltinCtx, type Node, type StrategyDecl, type Value } from '../contracts';
import { getConstant, registerBuiltin, registerConstant, registerLazyConstant } from './registry';
import { asStr, bindArgs, curNum, numVal, truthy, warnOnce, bindDeclArgs, type RtCtx } from './util';
import { declDrawQuotas } from './draw';
import { part, tzOf } from '../tz';

// ── Types ───────────────────────────────────────────────────────────────────

export interface StratCfg {
  initial_capital: number;
  /** 'fixed' | 'percent_of_equity' | 'cash' */
  default_qty_type: string;
  default_qty_value: number;
  /** 'percent' | 'cash_per_contract' | 'cash_per_order' */
  commission_type: string;
  commission_value: number;
  process_orders_on_close: boolean;
  currency: string;
  pyramiding: number;
  /** Ticks added to (buys) / subtracted from (sells) the fill price of market
   *  and stop orders. Limit fills are never slipped (Pine: "the fill price of
   *  market/stop orders"). Default 0. */
  slippage: number;
  /** Percentage of the purchase price that must be covered by equity for long
   *  / short positions. 0 disables every position-size limit. Default 100. */
  margin_long: number;
  margin_short: number;
  /** `margin_long` or `margin_short` was passed to strategy() — the reference
   *  makes strategy.margin_liquidation_price na without it. */
  marginDeclared?: boolean;
}

export interface StratOrder {
  /** Bar the call executed on. */
  bar: number;
  seq: number;
  kind: 'entry' | 'exit' | 'close' | 'order' | 'cancel' | 'risk';
  id: string;
  /** Entry id to close (exit/cancel/cancel_all). */
  fromEntry: string;
  dir: number;
  /** Absolute qty (>0 = explicit), else 0 → config/qty_percent. */
  qty: number;
  /** `qty` was passed explicitly — a present ≤0 is zero contracts, NOT the
   *  default-qty fallback. */
  qtySet?: boolean;
  /** Percent of equity (entries) / of position (exits); 0 = unused. */
  eqPct: number;
  /** `qty_percent` was passed explicitly — same ≤0 = zero contracts rule. */
  eqPctSet?: boolean;
  limit?: number;
  stop?: number;
  /** strategy.close(immediately=true) → fill at close(bar). */
  immediate: boolean;
  /** Last bar this order was touch-checked in a replay; -1 = none. */
  seen: number;
  /** Bar a cancel event retired this order (fills at cancel bar already done). */
  cancelledAt?: number;
  /** OCA group name + strategy.oca.* type ('cancel' | 'reduce'). */
  ocaName?: string;
  ocaType?: string;
  /** strategy.exit profit/loss in ticks → limit/stop prices vs avg entry. */
  profitTicks?: number;
  lossTicks?: number;
  /** Trailing stop: trail_price price / trail_points ticks activate it;
   *  trail_offset ticks is the retrace distance from the extreme. */
  trailPrice?: number;
  trailPoints?: number;
  trailOffset?: number;
  /** Per-replay scratch: most favorable price seen since the position opened. */
  trailPeak?: number;
  /** Per-replay scratch: resolved qty/price of the pending fill. */
  fillQty?: number;
  fillPrice?: number;
  /** Order comment (TV paints it next to the trade marker). */
  comment?: string;
  /** Duplicate-id / OCA-reduce modifications applied during replay. */
  mod?: { qty: number; qtySet?: boolean; eqPct: number; eqPctSet?: boolean; limit?: number; stop?: number };
  /** `kind === 'risk'` payload — one strategy.risk.* call. */
  risk?: RiskRuleSpec;
}

/** One `strategy.risk.*` call, recorded in the ledger so the replay stays a
 *  pure function of (orders, bars, cfg) — a rule installed on bar 5 must not
 *  affect a replay that stops on bar 3. */
export interface RiskRuleSpec {
  rule: 'allow_entry_in' | 'max_drawdown' | 'max_intraday_loss'
      | 'max_cons_loss_days' | 'max_intraday_filled_orders' | 'max_position_size';
  /** Enum string for allow_entry_in, a number for the rest. */
  value: string | number;
  /** `type` arg was strategy.percent_of_equity (not strategy.cash). */
  percent: boolean;
}

/** Risk rules active at a point of the replay. */
interface ActiveRules {
  allowEntryIn: string;
  maxDrawdown?: { value: number; percent: boolean };
  maxIntradayLoss?: { value: number; percent: boolean };
  maxConsLossDays?: number;
  maxIntradayFilledOrders?: number;
  maxPositionSize?: number;
}

/** One order fill — a StrategyTrade anchor for the IndicatorModel. */
export interface ExecRec {
  /** Fill bar index. */
  bar: number;
  price: number;
  dir: number;
  kind: 'entry' | 'exit';
  label?: string;
  qty: number;
  /** Round-trip id — an entry and its exits share it. */
  tradeId: number;
}

/** An open entry leg — one strategy.opentrades row (FIFO exit consumption). */
export interface TradeLeg {
  bar: number;
  time: number;
  price: number;
  /** Entry order id — strategy.opentrades.entry_id. */
  id: string;
  /** Entry order comment — strategy.opentrades.entry_comment. */
  comment: string;
  /** Order that last closed this leg — strategy.closedtrades.exit_id. */
  exitId: string;
  /** Its comment — strategy.closedtrades.exit_comment. */
  exitComment: string;
  /** Signed side (+1 long / -1 short). */
  dir: number;
  /** Remaining open contracts. */
  qty: number;
  /** Contracts this leg opened — the trade's size. */
  openedQty: number;
  /** Realized price P&L accumulated from exit fills (before commission). */
  pnl: number;
  /** Commission on the entry fill. */
  entryComm: number;
  /** Commission on exit fills applied to this leg. */
  exitComm: number;
  /** Contracts already closed by exit fills (weighted exit avg). */
  exitQty: number;
  exitNotional: number;
  exitBar: number;
  exitTime: number;
}

/** A fully-closed entry leg — one strategy.closedtrades row. */
export interface ClosedTrade {
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  dir: number;
  openedQty: number;
  /** Entry order id — strategy.closedtrades.entry_id. */
  id: string;
  /** Entry order comment — strategy.closedtrades.entry_comment. */
  comment: string;
  /** Order that closed the leg — strategy.closedtrades.exit_id. */
  exitId: string;
  /** Its comment — strategy.closedtrades.exit_comment. */
  exitComment: string;
  exitBar: number;
  exitTime: number;
  exitPrice: number;
  /** Net of entry + exit commission. */
  profit: number;
  commission: number;
}

interface Sim {
  qty: number;
  avgEntry: number;
  realizedPnl: number;
  closedTrades: number;
  openTrades: number;
  /** Executions so far — buildModel maps these to TradeExecution[]. */
  execs: ExecRec[];
  /** Current round-trip counter; entries at flat position bump it. */
  curTrade: number;
  /** Open entry legs feeding the position (FIFO exit consumption). */
  openLegs: TradeLeg[];
  /** Fully-closed entry legs, chronological — strategy.closedtrades.* rows. */
  closed: ClosedTrade[];
  /** Entry id that opened the current position — strategy.position_entry_name. */
  positionEntryName: string;
  /** Largest |position| over the replay — strategy.max_contracts_held_*. */
  maxContractsAll: number;
  maxContractsLong: number;
  maxContractsShort: number;
}

const ORDERS_KEY = 'strategy|orders';
const CFG_KEY = 'strategy|cfg';
const CACHE_KEY = 'strategy|simCache';

// ── ctx plumbing ────────────────────────────────────────────────────────────

function stateOf(ctx: BuiltinCtx | undefined): Map<string, unknown> | undefined {
  if (!ctx) return undefined;
  const rt = ctx as RtCtx;
  rt.state ??= new Map();
  return rt.state as Map<string, unknown>;
}

function ordersOf(ctx: BuiltinCtx | undefined): StratOrder[] {
  const st = stateOf(ctx);
  if (!st) return [];
  let o = st.get(ORDERS_KEY) as StratOrder[] | undefined;
  if (!o) { o = []; st.set(ORDERS_KEY, o); }
  return o;
}

const DEFAULT_CFG: StratCfg = {
  initial_capital: 100000,
  default_qty_type: 'fixed',
  default_qty_value: 1,
  commission_type: 'percent',
  commission_value: 0,
  process_orders_on_close: false,
  currency: 'NONE',
  pyramiding: 0,
  slippage: 0,
  margin_long: 100,
  margin_short: 100,
};

export function cfgOf(ctx: BuiltinCtx | undefined): StratCfg {
  return (stateOf(ctx)?.get(CFG_KEY) as StratCfg | undefined) ?? DEFAULT_CFG;
}

/** syminfo.mintick for tick-denominated params (profit/loss/trail_*); 1 = fallback. */
function mintickOf(ctx: BuiltinCtx): number {
  const v = ctx.syminfo?.mintick;
  const u = v !== undefined && v.kind === 'series' ? v.v.cur() : v;
  return u !== undefined && (u.kind === 'int' || u.kind === 'float') && u.v > 0 ? u.v : 1;
}

/** syminfo.pointvalue — money moved by a whole-number price move (futures ≠ 1). */
function pointValueOf(ctx: BuiltinCtx): number {
  const v = ctx.syminfo?.pointvalue;
  const u = v !== undefined && v.kind === 'series' ? v.v.cur() : v;
  return u !== undefined && (u.kind === 'int' || u.kind === 'float') && u.v > 0 ? u.v : 1;
}

// ── bar prices ──────────────────────────────────────────────────────────────

function numAt(s: { get(n: number): Value }, bar: number, upto: number): number {
  if (bar < 0 || bar > upto) return NaN;
  const v = s.get(upto - bar);
  return v.kind === 'int' || v.kind === 'float' ? v.v : NaN;
}

const openAt = (ctx: BuiltinCtx, bar: number, upto: number) => numAt(ctx.open, bar, upto);
const closeAt = (ctx: BuiltinCtx, bar: number, upto: number) => numAt(ctx.close, bar, upto);
const highAt = (ctx: BuiltinCtx, bar: number, upto: number) => numAt(ctx.high, bar, upto);
const lowAt = (ctx: BuiltinCtx, bar: number, upto: number) => numAt(ctx.low, bar, upto);
const timeAt = (ctx: BuiltinCtx, bar: number, upto: number) => numAt(ctx.time, bar, upto);

/** Empty simulation — shared by `simAt` early-outs and the `simulate` init. */
const emptySim = (): Sim => ({
  qty: 0, avgEntry: 0, realizedPnl: 0, closedTrades: 0, openTrades: 0,
  execs: [], curTrade: 0, openLegs: [], closed: [],
  positionEntryName: '', maxContractsAll: 0, maxContractsLong: 0, maxContractsShort: 0,
});

// ── replay ──────────────────────────────────────────────────────────────────

/**
 * Simulate through the end of `uptoBar`. Pure in (orders, bars, cfg):
 * scratch fields on orders are rewritten each call, so results do not
 * depend on call order or call sites.
 */
export function simulate(ctx: BuiltinCtx, orders: StratOrder[], cfg: StratCfg, uptoBar: number): Sim {
  const sim: Sim = emptySim();
  if (uptoBar < 0) return sim;
  const n = orders.length;
  const tick = mintickOf(ctx);
  // Reset all replay scratch so the result is a pure function of (orders, bars).
  for (const o of orders) {
    o.seen = -1; o.cancelledAt = undefined; o.trailPeak = undefined;
    o.fillQty = undefined; o.fillPrice = undefined; o.mod = undefined;
  }
  const pending: StratOrder[] = [];
  let i = 0;

  // ── strategy.risk.* state (see riskWalk) ──
  const rules: ActiveRules = { allowEntryIn: 'strategy.direction.all' };
  let riskBar = -1;        // last bar the rule engine has observed
  let haltBar = -1;        // permanent halt began on this bar (-1 = trading)
  let sessionHaltDay = -1; // day key an intraday halt began in
  let day = -1;            // day key of the bar being evaluated
  let dayStartEquity = cfg.initial_capital;
  let dayPeak = cfg.initial_capital;
  let peakEquity = cfg.initial_capital;
  let consLoss = 0;
  const fillsByDay = new Map<number, number>();
  const pointValue = pointValueOf(ctx);

  /** Touch-check every pending order through `limit`, filling on touch. */
  const advancePending = (limit: number): void => {
    const lim = Math.min(limit, uptoBar);
    for (let k = 0; k < pending.length; k++) {
      const o = pending[k]!;
      for (let b = o.seen + 1; b <= lim; b++) {
        if (o.cancelledAt !== undefined && b > o.cancelledAt) break;
        if (fillCandidate(o, b)) {
          applyFill(o, b, o.fillPrice!, o.fillQty!);
          if (rules.maxIntradayFilledOrders !== undefined) {
            const k = dayKeyOf(b);
            fillsByDay.set(k, (fillsByDay.get(k) ?? 0) + 1);
          }
          o.seen = b;
          break;
        }
        o.seen = b;
      }
      if (o.fillPrice !== undefined || (o.cancelledAt !== undefined && o.seen >= o.cancelledAt)) {
        pending.splice(k, 1);
        k--;
      }
    }
  };

  /** Resolve this order's fill on bar b; sets fillPrice/fillQty on success.
   *  limit+stop on one order form an OCO pair — the first level the bar's
   *  high/low touches fills; when both are touched the conservative (worse)
   *  fill wins: the stop for buys, the limit for sells. Exit orders also
   *  derive levels from profit/loss ticks and trail_* params. */
  const fillCandidate = (o: StratOrder, b: number): boolean => {
    if (o.kind === 'cancel') return false;
    const sameBar = o.immediate || (cfg.process_orders_on_close && o.bar === b);
    const r = sameBar ? o.bar : o.bar + 1;
    const dir = effDir(o);
    const lo = lowAt(ctx, b, uptoBar);
    const hi = highAt(ctx, b, uptoBar);
    const op = openAt(ctx, b, uptoBar);
    // Exit extras: profit/loss ticks → limit/stop prices vs avg entry;
    // trail_* → trailing stop armed when the excursion reaches the activation
    // level, then the stop trails the extreme by trail_offset ticks.
    let limit = o.mod?.limit ?? o.limit;
    let stop = o.mod?.stop ?? o.stop;
    if (o.kind === 'exit' && sim.qty !== 0) {
      const side = Math.sign(sim.qty); // +1 long, -1 short
      if (o.profitTicks !== undefined && limit === undefined) limit = sim.avgEntry + side * o.profitTicks * tick;
      if (o.lossTicks !== undefined && stop === undefined) stop = sim.avgEntry - side * o.lossTicks * tick;
      if ((o.trailPrice !== undefined || o.trailPoints !== undefined) && b >= r) {
        const act = o.trailPrice ?? sim.avgEntry + side * (o.trailPoints ?? 0) * tick;
        // Track the favorable extreme only while the position is open.
        if (o.trailPeak === undefined) o.trailPeak = sim.avgEntry;
        const cur = side > 0 ? highAt(ctx, b, uptoBar) : lowAt(ctx, b, uptoBar);
        if (Number.isFinite(cur)) {
          o.trailPeak = side > 0 ? Math.max(o.trailPeak, cur) : Math.min(o.trailPeak, cur);
        }
        const armed = side > 0 ? o.trailPeak >= act : o.trailPeak <= act;
        // Trailing stop = peak − offset (no open-gap adj: the level is set
        // intra-bar at the extreme, so the open never gaps past it).
        if (armed && Number.isFinite(lo) && (side > 0 ? lo <= (o.trailPeak - side * (o.trailOffset ?? 0) * tick)
                                                  : hi >= (o.trailPeak - side * (o.trailOffset ?? 0) * tick))) {
          const trailStop = o.trailPeak - side * (o.trailOffset ?? 0) * tick;
          const tq = resolveQty(o, trailStop, b, dir);
          if (tq > 0) { o.fillPrice = trailStop + dir * cfg.slippage * tick; o.fillQty = tq; return true; }
        }
      }
    }
    const touch = limit !== undefined || stop !== undefined;
    // Conditional orders wait for a level; a trail/profit/loss-only exit has
    // no level until it arms (or a position exists), so it stays pending.
    const conditional = touch
      || (o.kind === 'exit'
        && (o.profitTicks !== undefined || o.lossTicks !== undefined
          || o.trailPrice !== undefined || o.trailPoints !== undefined
          || o.trailOffset !== undefined));
    let price: number;
    /** True when the fill level came from a stop — slippage applies there and
     *  on market fills, never on limit fills. */
    let fromStop = false;
    if (!conditional) {
      if (b !== r) return false;
      price = sameBar ? closeAt(ctx, b, uptoBar) : openAt(ctx, b, uptoBar);
      fromStop = true;
    } else {
      if (b < r) return false;
      if (dir === 0) return false;
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
      // Fill at the trigger, unless the open already gapped past it —
      // broker-style: a buy stop fills at open when open > stop (worse), a
      // buy limit fills at open when open < limit (better); mirrored for sells.
      const adj = (lvl: number, isStop: boolean): number =>
        Number.isFinite(op)
          ? (dir > 0
            ? (isStop ? Math.max(lvl, op) : Math.min(lvl, op))
            : (isStop ? Math.min(lvl, op) : Math.max(lvl, op)))
          : lvl;
      const stopPx = stop !== undefined && (dir > 0 ? hi >= stop : lo <= stop) ? adj(stop, true) : undefined;
      const limitPx = limit !== undefined && (dir > 0 ? lo <= limit : hi >= limit) ? adj(limit, false) : undefined;
      if (stopPx === undefined && limitPx === undefined) return false;
      // Conservative intra-bar ordering: the worse fill price wins.
      if (stopPx === undefined) price = limitPx!;
      else if (limitPx === undefined) { price = stopPx; fromStop = true; }
      else {
        price = dir > 0 ? Math.max(stopPx, limitPx) : Math.min(stopPx, limitPx);
        fromStop = price === stopPx;
      }
    }
    if (!Number.isFinite(price)) return false;
    if (fromStop && cfg.slippage > 0) price += dir * cfg.slippage * tick;
    const qty = resolveQty(o, price, b, dir);
    if (!(qty > 0)) { o.seen = b; return false; }
    // Margin: a position-increasing fill must be covered by equity.
    if ((o.kind === 'entry' || o.kind === 'order') && !marginOk(b, price, qty, dir)) {
      warnOnce(ctx, 'strategy|margin',
        'strategy(): not enough money to open the position — the order is not filled');
      o.seen = b;
      return false;
    }
    o.fillPrice = price;
    o.fillQty = qty;
    return true;
  };

  for (;;) {
    let ev = -1;
    for (let j = i; j < n; j++) {
      const o = orders[j]!;
      if (o.seen < o.bar) { ev = j; break; }
    }
    if (ev < 0) break;
    const o = orders[ev]!;
    i = ev + 1;
    if (o.bar > uptoBar) { o.seen = o.bar; continue; }
    // Pending orders settle through this event's bar before it is applied.
    advancePending(o.bar);
    riskWalk(o.bar);
    if (o.kind === 'risk') {
      applyRisk(o.risk!);
      o.seen = o.bar;
      continue;
    }
    // A triggered rule stops new orders: permanent until the end of the run,
    // intraday until the end of that trading day.
    if (haltBar >= 0 && o.bar >= haltBar) { o.seen = o.bar; continue; }
    if (sessionHaltDay >= 0 && sessionHaltDay === day) { o.seen = o.bar; continue; }
    if (o.kind === 'cancel') {
      const any = o.id === '' || o.id === 'strategy.cancel_all';
      for (const p of pending) {
        if (any || p.id === o.id || (o.fromEntry !== '' && p.id === o.fromEntry)) p.cancelledAt = o.bar;
      }
      o.seen = o.bar;
      continue;
    }
    // Duplicate pending entry id → modify in place (Pine semantics).
    if (o.kind === 'entry' || o.kind === 'order') {
      const dupe = pending.find(p => (p.kind === 'entry' || p.kind === 'order') && p.id === o.id && p.dir === o.dir);
      if (dupe) { dupe.mod = { qty: o.qty, qtySet: o.qtySet, eqPct: o.eqPct, eqPctSet: o.eqPctSet, limit: o.limit, stop: o.stop }; o.seen = o.bar; continue; }
      // Same-direction entry while positioned → ignored unless pyramiding.
      if (sim.qty !== 0 && Math.sign(sim.qty) === o.dir && sim.openTrades >= cfg.pyramiding + 1) { o.seen = o.bar; continue; }
    }
    o.seen = o.bar - 1; // next advance checks from this order's bar
    pending.push(o);
  }
  advancePending(uptoBar);
  riskWalk(uptoBar);
  return sim;

  // ── nested helpers (closure over sim/ctx) ──

  function fillDir(o: StratOrder): number {
    if (o.kind === 'entry' || o.kind === 'order') return o.dir;
    return -Math.sign(sim.qty); // exit/close trades against the open position
  }

  /** True when the active allow_entry_in rule permits opening in `d`. */
  function dirAllowed(d: number): boolean {
    const a = rules.allowEntryIn;
    if (a === 'strategy.direction.long') return d > 0;
    if (a === 'strategy.direction.short') return d < 0;
    return true;
  }

  /** Effective fill direction. A strategy.entry() whose direction the active
   *  allow_entry_in rule forbids can only reduce the opposite position (Pine:
   *  "Instead of opening a short position … this command will close long
   *  entries") and answers 0 when the strategy is flat. */
  function effDir(o: StratOrder): number {
    const d = fillDir(o);
    if (o.kind !== 'entry' || d === 0 || dirAllowed(d)) return d;
    return sim.qty !== 0 && Math.sign(sim.qty) !== d ? -Math.sign(sim.qty) : 0;
  }

  /** strategy.risk.max_position_size() — cap an entry so the resulting
   *  position never exceeds the limit (a reversal counts only its new side,
   *  the closing half frees the old one). */
  function capEntryQty(q: number, dir: number): number {
    const max = rules.maxPositionSize;
    if (max === undefined || !(q > 0)) return q;
    const adding = sim.qty !== 0 && Math.sign(sim.qty) === dir;
    return adding ? Math.max(0, Math.min(q, max - Math.abs(sim.qty))) : Math.min(q, max);
  }

  /** Can the account cover the margin a position-increasing fill requires?
   *  Required margin is the resulting position's value times the margin
   *  ratio; a ratio of 0 disables every position-size limit (Pine). Equality
   *  is allowed: percent_of_equity sizing lands exactly on equity. */
  function marginOk(at: number, price: number, qty: number, dir: number): boolean {
    const ratio = (dir > 0 ? cfg.margin_long : cfg.margin_short) / 100;
    if (!(ratio > 0)) return true;
    const traded = sim.qty !== 0 && Math.sign(sim.qty) !== dir ? qty + Math.abs(sim.qty) : qty;
    const resulting = Math.abs(sim.qty + dir * traded);
    return equityNow(at) >= resulting * price * pointValue * ratio;
  }

  /** Day key of bar `b` — the calendar day in the symbol's timezone. One bar
   *  of a D/W/M chart opens on its own day, so the key is one-per-bar there,
   *  matching Pine's "per 1 day (per 1 bar, if chart resolution is higher
   *  than 1 day)". */
  function dayKeyOf(b: number): number {
    const t = timeAt(ctx, b, uptoBar);
    if (!Number.isFinite(t)) return b;
    const tz = tzOf(ctx);
    return part(t, tz, 'year') * 10000 + part(t, tz, 'month') * 100 + part(t, tz, 'day');
  }

  /** Install one strategy.risk.* rule; the latest call for a rule wins. */
  function applyRisk(r: RiskRuleSpec): void {
    switch (r.rule) {
      case 'allow_entry_in': rules.allowEntryIn = String(r.value); break;
      case 'max_drawdown': rules.maxDrawdown = { value: Number(r.value), percent: r.percent }; break;
      case 'max_intraday_loss': rules.maxIntradayLoss = { value: Number(r.value), percent: r.percent }; break;
      case 'max_cons_loss_days': rules.maxConsLossDays = Number(r.value); break;
      case 'max_intraday_filled_orders': rules.maxIntradayFilledOrders = Number(r.value); break;
      case 'max_position_size': rules.maxPositionSize = Number(r.value); break;
    }
  }

  /** Close the whole position at bar `b`'s close — the "all open positions
   *  are closed" half of every strategy.risk.* rule. */
  function flattenAt(b: number, label: string): void {
    if (sim.qty === 0) return;
    const price = closeAt(ctx, b, uptoBar);
    if (!Number.isFinite(price)) return;
    const qty = Math.abs(sim.qty);
    applyFill({
      bar: b, seq: -1, kind: 'close', id: '', fromEntry: '', dir: -Math.sign(sim.qty),
      qty, qtySet: true, eqPct: 0, eqPctSet: false,
      limit: undefined, stop: undefined, immediate: true, seen: b, comment: label,
    }, b, price, qty);
  }

  /** A rule fired: cancel every pending order and flatten the position.
   *  `permanent` rules stop the run for good, the intraday ones until the
   *  end of the current trading day. */
  function trigger(b: number, permanent: boolean, label: string): void {
    for (const p of pending) if (p.cancelledAt === undefined) p.cancelledAt = b;
    flattenAt(b, label);
    if (permanent) haltBar = b;
    else sessionHaltDay = day;
  }

  /** TV Broker Emulator margin call: when the equity left after the open
   *  position is no longer enough to sustain it, the broker liquidates four
   *  times the size needed to cover the loss. Checked on every bar's close. */
  function marginCall(b: number): void {
    if (sim.qty === 0) return;
    const dir = Math.sign(sim.qty);
    const ratio = (dir > 0 ? cfg.margin_long : cfg.margin_short) / 100;
    // MarginLiquidationPrice divides by (ratio - direction): zero means the
    // price is unattainable, i.e. a 100%-margin long is never called.
    if (ratio - dir === 0) return;
    const price = closeAt(ctx, b, uptoBar);
    if (!Number.isFinite(price)) return;
    const size = Math.abs(sim.qty);
    const mvs = size * price * pointValue;
    const marginRequired = mvs * ratio;
    if (!(equityNow(b) <= marginRequired)) return;
    // The documented algorithm books the open trade as a loss (step 3).
    const openProfit = -Math.abs(mvs - size * sim.avgEntry * pointValue);
    const equity = cfg.initial_capital + sim.realizedPnl + openProfit;
    const moneyLost = (equity - marginRequired) / ratio;
    const units = Math.trunc(Math.abs(moneyLost / price) * 1e8) / 1e8;
    const liq = Math.min(size, units * 4);
    if (!(liq > 0)) return;
    applyFill({
      bar: b, seq: -1, kind: 'close', id: '', fromEntry: '', dir: -dir,
      qty: liq, qtySet: true, eqPct: 0, eqPctSet: false,
      limit: undefined, stop: undefined, immediate: true, seen: b, comment: 'Margin call',
    }, b, price, liq);
  }

  /** True when any strategy.risk.* rule is installed. */
  function rulesActive(): boolean {
    return rules.maxDrawdown !== undefined || rules.maxIntradayLoss !== undefined
      || rules.maxConsLossDays !== undefined || rules.maxIntradayFilledOrders !== undefined;
  }

  /** A margin call is only reachable when the open position's margin ratio
   *  makes MarginLiquidationPrice attainable — a 100%-margin long never is. */
  function marginWatchable(): boolean {
    if (sim.qty === 0) return false;
    const dir = Math.sign(sim.qty);
    return (dir > 0 ? cfg.margin_long : cfg.margin_short) / 100 - dir !== 0;
  }

  /** Evaluate the installed rules on every bar the replay has not observed
   *  yet, up to `to`; the fills for those bars have already settled. */
  function riskWalk(to: number): void {
    const lim = Math.min(to, uptoBar);
    // Nothing to observe: no rule installed and no position a margin call
    // could touch. Keeps plain strategies off this per-bar loop entirely.
    if (!rulesActive() && !marginWatchable()) {
      if (lim > riskBar) riskBar = lim;
      return;
    }
    for (let b = riskBar + 1; b <= lim; b++) {
      const k = dayKeyOf(b);
      if (k !== day) {
        day = k;
        dayStartEquity = b > 0 ? equityNow(b - 1) : cfg.initial_capital;
        dayPeak = Math.max(dayStartEquity, equityNow(b));
      }
      const eq = equityNow(b);
      if (eq > peakEquity) peakEquity = eq;
      if (eq > dayPeak) dayPeak = eq;
      riskBar = b;
      if (haltBar >= 0 || sessionHaltDay === k) continue;
      const maxFills = rules.maxIntradayFilledOrders;
      if (maxFills !== undefined && (fillsByDay.get(k) ?? 0) >= maxFills) {
        trigger(b, false, 'max_intraday_filled_orders');
        continue;
      }
      const il = rules.maxIntradayLoss;
      if (il !== undefined && il.value > 0) {
        const loss = dayPeak - eq;
        if (il.percent ? dayPeak > 0 && loss / dayPeak * 100 >= il.value : loss >= il.value) {
          trigger(b, false, 'max_intraday_loss');
          continue;
        }
      }
      const dd = rules.maxDrawdown;
      if (dd !== undefined && dd.value > 0) {
        const drop = peakEquity - eq;
        if (dd.percent
          ? (peakEquity > 0 && drop / peakEquity * 100 >= dd.value) || eq <= 0
          : drop >= dd.value) {
          trigger(b, true, 'max_drawdown');
          continue;
        }
      }
      // max_cons_loss_days is judged on the day's last bar.
      const nDays = rules.maxConsLossDays;
      if (nDays !== undefined && nDays > 0 && (b === uptoBar || dayKeyOf(b + 1) !== k)) {
        if (eq < dayStartEquity) consLoss++;
        else consLoss = 0;
        if (consLoss >= nDays) {
          trigger(b, true, 'max_cons_loss_days');
          continue;
        }
      }
      marginCall(b);
    }
  }

  function commission(qty: number, price: number): number {
    switch (cfg.commission_type) {
      case 'strategy.commission.percent':
      case 'percent': return Math.abs(qty) * price * cfg.commission_value / 100;
      case 'strategy.commission.cash_per_order':
      case 'cash_per_order': return cfg.commission_value;
      default: return Math.abs(qty) * cfg.commission_value; // cash_per_contract
    }
  }

  /** Equity as of bar `at` — uses that bar's close for open-position P&L. */
  function equityNow(atBar: number): number {
    return cfg.initial_capital + sim.realizedPnl
      + (sim.qty !== 0 ? sim.qty * (closeAt(ctx, atBar, uptoBar) - sim.avgEntry) : 0);
  }

  /** Contracts this order trades at `price`; 0/NaN → no fill. */
  function resolveQty(o: StratOrder, price: number, atBar: number, dir: number): number {
    if (o.kind === 'entry' || o.kind === 'order') {
      const eqPct = o.mod?.eqPct ?? o.eqPct;
      const qty = o.mod?.qty ?? o.qty;
      const qtySet = o.mod?.qtySet ?? o.qtySet ?? false;
      const eqPctSet = o.mod?.eqPctSet ?? o.eqPctSet ?? false;
      // Explicit non-positive qty/qty_percent = zero contracts, NOT a
      // default-qty substitution — qty=0 must never fill 1 contract.
      if (qtySet && !(qty > 0)) return 0;
      if (eqPctSet && !(eqPct > 0)) return 0;
      let out: number;
      if (eqPct > 0) out = equityNow(atBar) * eqPct / (100 * price);
      else if (qty > 0) out = qty;
      else switch (cfg.default_qty_type) {
        case 'strategy.percent_of_equity':
        case 'percent_of_equity':
          out = equityNow(atBar) * cfg.default_qty_value / (100 * price);
          break;
        case 'strategy.cash':
        case 'cash':
          out = cfg.default_qty_value / price;
          break;
        default:
          out = cfg.default_qty_value;
      }
      // strategy.risk.max_position_size() caps strategy.entry() alone.
      return o.kind === 'entry' ? capEntryQty(out, dir) : out;
    }
    // exit / close — contracts to close. Both honor qty/qty_percent
    // (TV: close has qty + qty_percent params, default qty_percent=100).
    const pos = Math.abs(sim.qty);
    if (pos === 0) return 0;
    if (o.qty > 0) return Math.min(o.qty, pos);
    if (o.eqPct > 0) return pos * Math.min(1, o.eqPct / 100);
    // Explicit qty=0 (or qty_percent=0) closes NOTHING — an absent arg
    // falls through to the full-position default, a present zero does not.
    if (o.qtySet === true || o.eqPctSet === true) return 0;
    return pos;
  }

  function applyFill(o: StratOrder, bar: number, price: number, qty: number): void {
    const dir = effDir(o);
    // A direction the allow_entry_in rule forbids turns the entry into a
    // plain close: it must not open a leg or start a round trip.
    const isEntry = o.kind === 'order' || (o.kind === 'entry' && dirAllowed(o.dir));
    // A reversal entry trades |position| + qty contracts: the fill closes the
    // old side and opens the new one in a single order (Pine behavior).
    const traded = isEntry && sim.qty !== 0 && Math.sign(sim.qty) !== dir
      ? qty + Math.abs(sim.qty) : qty;
    const match = traded * dir; // signed contracts traded
    if (match === 0) return;
    // New round-trip: entry at flat position OR an entry that flips the side.
    if (isEntry && (sim.qty === 0 || Math.sign(sim.qty) !== dir)) {
      sim.curTrade++;
      // The order that initially opened the position names it until flat.
      sim.positionEntryName = o.id;
    }
    sim.execs.push({
      bar, price, dir,
      kind: isEntry ? 'entry' : 'exit',
      label: o.comment !== undefined && o.comment !== '' ? o.comment : o.id,
      qty: traded,
      tradeId: sim.curTrade,
    });
    const comm = commission(match, price);
    sim.realizedPnl -= comm;
    const closeLeg = (c: number): void => {
      // Position bookkeeping only — realized PnL books per consumed leg in
      // the FIFO loop below (leg-exact prices, matching closedtrades.profit).
      const q = Math.min(Math.abs(c), Math.abs(sim.qty));
      sim.qty -= Math.sign(sim.qty) * q;
      if (sim.qty === 0) sim.avgEntry = 0;
    };
    // Trade ledger: open legs are strategy.opentrades rows; exit fills consume
    // them FIFO — a fully-consumed leg becomes a strategy.closedtrades row.
    // The fill's commission lands on the closing side's legs when the fill
    // reduces a position, otherwise on the leg it opens.
    // Only fills trading AGAINST the open position consume legs — a
    // same-direction entry adds a leg, it never closes one.
    const closing = Math.sign(match) === Math.sign(sim.qty) ? 0 : Math.min(Math.abs(match), Math.abs(sim.qty));
    const opening = Math.abs(match) - closing;
    if (closing > 0) {
      let left = closing;
      while (left > 1e-12 && sim.openLegs.length > 0) {
        const leg = sim.openLegs[0]!;
        const q = Math.min(left, leg.qty);
        const pnl = q * (price - leg.price) * leg.dir;
        leg.pnl += pnl;
        sim.realizedPnl += pnl; // leg-exact: TV books trade profit at its own entry price
        leg.exitQty += q;
        leg.exitNotional += q * price;
        leg.exitBar = bar;
        leg.exitTime = timeAt(ctx, bar, uptoBar);
        leg.exitComm += comm * (q / closing);
        leg.exitId = o.id;
        leg.exitComment = o.comment ?? '';
        leg.qty -= q;
        left -= q;
        if (leg.qty <= 1e-12) {
          sim.openLegs.shift();
          sim.closed.push({
            entryBar: leg.bar, entryTime: leg.time, entryPrice: leg.price,
            dir: leg.dir, openedQty: leg.openedQty,
            id: leg.id, comment: leg.comment,
            exitId: leg.exitId, exitComment: leg.exitComment,
            exitBar: leg.exitBar, exitTime: leg.exitTime,
            exitPrice: leg.exitNotional / leg.exitQty,
            profit: leg.pnl - leg.entryComm - leg.exitComm,
            commission: leg.entryComm + leg.exitComm,
          });
          sim.closedTrades++; // a fully-consumed leg is one closed trade
        }
      }
    }
    if (opening > 1e-12) {
      sim.openLegs.push({
        bar, time: timeAt(ctx, bar, uptoBar), price, dir: Math.sign(match),
        id: o.id, comment: o.comment ?? '', exitId: '', exitComment: '',
        qty: opening, openedQty: opening, pnl: 0,
        entryComm: closing > 0 ? 0 : comm,
        exitComm: 0, exitQty: 0, exitNotional: 0, exitBar: -1, exitTime: NaN,
      });
    }
    if (sim.qty === 0) {
      sim.qty = match;
    } else if (Math.sign(sim.qty) === Math.sign(match)) {
      if (o.kind === 'entry' || o.kind === 'order') {
        sim.qty += match;
      } else {
        closeLeg(match); // shouldn't happen (exit dir opposes position)
      }
    } else {
      // Opposite trade: close what we can, open the rest (reversal).
      const before = Math.abs(sim.qty);
      closeLeg(match);
      const rem = Math.abs(match) - before;
      if (rem > 0) sim.qty = Math.sign(match) * rem;
    }
    // Live-leaf derivation: opentrades = open legs; avg price = weighted mean
    // of the legs still open (TV: position_avg_price covers remaining trades,
    // so a partial exit against the cheapest leg moves the average).
    sim.openTrades = sim.openLegs.length;
    let legQty = 0, legNotional = 0;
    for (const l of sim.openLegs) { legQty += l.qty; legNotional += l.qty * l.price; }
    sim.avgEntry = legQty > 1e-12 ? legNotional / legQty : 0;
    // Position size only changes at fills, so the per-fill max is exact for
    // the whole range (strategy.max_contracts_held_*).
    const held = Math.abs(sim.qty);
    if (held > sim.maxContractsAll) sim.maxContractsAll = held;
    if (sim.qty > sim.maxContractsLong) sim.maxContractsLong = sim.qty;
    if (-sim.qty > sim.maxContractsShort) sim.maxContractsShort = -sim.qty;
    // OCA: a fill in an oca group retires (cancel) or shrinks (reduce) its
    // pending siblings. cancelledAt = bar-1 forbids same-bar sibling fills —
    // the group is one-cancels-others, not first-touched-wins-later.
    if (o.ocaName !== undefined && o.ocaName !== '') {
      for (const p of pending) {
        if (p === o || p.ocaName !== o.ocaName) continue;
        const t = p.ocaType ?? o.ocaType ?? 'none';
        if (t.endsWith('cancel')) p.cancelledAt = bar - 1;
        else if (t.endsWith('reduce')) {
          const rem = Math.max(0, (p.mod?.qty ?? p.qty) - qty);
          if (rem <= 0) {
            // Reduced to nothing → the sibling must never fill (resolveQty
            // would otherwise fall back to default_qty_value and refill it).
            p.cancelledAt = bar - 1;
          } else {
            p.mod = { qty: rem, eqPct: p.mod?.eqPct ?? p.eqPct, limit: p.mod?.limit ?? p.limit, stop: p.mod?.stop ?? p.stop };
          }
        }
      }
    }
  }
}

// ── deterministic-read cache ────────────────────────────────────────────────
// Simulation is a pure function of (orders.length, uptoBar, ctx). Memoize per
// orders-array so repeated lazy reads on the same bar don't replay.

interface SimCache { count: number; byBar: Map<number, Sim> }

function simAt(ctx: BuiltinCtx, uptoBar: number): Sim {
  const st = stateOf(ctx);
  if (!st) return emptySim();
  const orders = st.get(ORDERS_KEY) as StratOrder[] | undefined;
  if (!orders || orders.length === 0) return emptySim();
  let cache = st.get(CACHE_KEY) as SimCache | undefined;
  if (!cache || cache.count !== orders.length) { cache = { count: orders.length, byBar: new Map() }; st.set(CACHE_KEY, cache); }
  let r = cache.byBar.get(uptoBar);
  if (!r) { r = simulate(ctx, orders, cfgOf(ctx), uptoBar); cache.byBar.set(uptoBar, r); }
  return r;
}

/** Final-bar executions for engine → IndicatorModel.trades. */
export function execsAt(ctx: BuiltinCtx | undefined, uptoBar: number): ExecRec[] {
  if (!ctx) return [];
  return simAt(ctx, uptoBar).execs;
}

// ── arg helpers ─────────────────────────────────────────────────────────────

/** Pine direction value → signed 1/-1. Accepts enum strings and numbers. */
function dirOf(v: Value | undefined): number {
  if (v === undefined || v.kind === 'na') return 0;
  const u = v.kind === 'series' ? v.v.cur() : v;
  if (u.kind === 'int' || u.kind === 'float') return Math.sign(u.v);
  const s = asStr(u);
  if (s.includes('short')) return -1;
  if (s.includes('long')) return 1;
  return 0;
}

/** Absolute qty (entries) or fraction percent, series-aware. */
function qtyOf(bound: Map<string, Value>, name: string): number {
  const n = curNum(bound.get(name) ?? NA);
  return n !== undefined && Number.isFinite(n) ? n : 0;
}

/** qty + qty_percent value/flag bundle — spread into a StratOrder literal.
 *  A present-but-≤0 arg means zero contracts, so presence must travel with
 *  the value (qtySet/eqPctSet). Used by all four order builtins. */
function qtyFields(bound: Map<string, Value>): Pick<StratOrder, 'qty' | 'qtySet' | 'eqPct' | 'eqPctSet'> {
  return {
    qty: qtyOf(bound, 'qty'),
    qtySet: bound.has('qty'),
    eqPct: qtyOf(bound, 'qty_percent'),
    eqPctSet: bound.has('qty_percent'),
  };
}

function optNum(bound: Map<string, Value>, name: string): number | undefined {
  const n = curNum(bound.get(name) ?? NA);
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

function strOf(v: Value | undefined, def = ''): string {
  if (v === undefined || v.kind === 'na') return def;
  return asStr(v);
}

function pushOrder(ctx: BuiltinCtx, o: Omit<StratOrder, 'bar' | 'seq' | 'seen'>): void {
  const orders = ordersOf(ctx);
  orders.push({ ...o, bar: ctx.barIndex, seq: orders.length, seen: -1 });
}

// ── builtins ────────────────────────────────────────────────────────────────

// Pine v5 signature orders. `when` was deprecated in v5 — it binds only as a
// named arg (bindArgs accepts any named key) and never occupies a positional
// slot; a positional arg after `when`'s old slot belongs to the next v5 param.
const ENTRY_ORDER = ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment', 'comment_disabled', 'alert_message', 'disable_alert', 'when'] as const;
const EXIT_ORDER = ['id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop', 'trail_price', 'trail_points', 'trail_offset', 'oca_name', 'oca_type', 'comment', 'comment_disabled', 'comment_profit', 'comment_loss', 'comment_trailing', 'alert_message', 'alert_profit', 'alert_loss', 'alert_trailing', 'disable_alert', 'when'] as const;
const ORDER_ORDER = ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment', 'alert_message', 'disable_alert', 'when'] as const;
const CLOSE_ORDER = ['id', 'comment', 'qty', 'qty_percent', 'alert_message', 'immediately', 'disable_alert', 'when'] as const;
const CLOSE_ALL_ORDER = ['comment', 'alert_message', 'immediately', 'disable_alert', 'when'] as const;

registerBuiltin('strategy', 'entry', (c, args, named) => {
  const bound = bindArgs(args, named, ENTRY_ORDER);
  const dir = dirOf(bound.get('direction'));
  if (dir === 0) return { kind: 'void' };
  const when = bound.get('when');
  if (when !== undefined && !truthy(when)) return { kind: 'void' };
  pushOrder(c, {
    kind: 'entry',
    id: strOf(bound.get('id'), 'entry'),
    fromEntry: '',
    dir,
    ...qtyFields(bound),
    limit: optNum(bound, 'limit'),
    stop: optNum(bound, 'stop'),
    ocaName: strOf(bound.get('oca_name')) || undefined,
    ocaType: strOf(bound.get('oca_type')) || undefined,
    comment: strOf(bound.get('comment')) || undefined,
    immediate: false,
  });
  return { kind: 'void' };
});

registerBuiltin('strategy', 'exit', (c, args, named) => {
  const bound = bindArgs(args, named, EXIT_ORDER);
  const when = bound.get('when');
  if (when !== undefined && !truthy(when)) return { kind: 'void' };
  pushOrder(c, {
    kind: 'exit',
    id: strOf(bound.get('id'), 'exit'),
    fromEntry: strOf(bound.get('from_entry')),
    dir: 0,
    ...qtyFields(bound),
    limit: optNum(bound, 'limit'),
    stop: optNum(bound, 'stop'),
    profitTicks: optNum(bound, 'profit'),
    lossTicks: optNum(bound, 'loss'),
    trailPrice: optNum(bound, 'trail_price'),
    trailPoints: optNum(bound, 'trail_points'),
    trailOffset: optNum(bound, 'trail_offset'),
    ocaName: strOf(bound.get('oca_name')) || undefined,
    ocaType: strOf(bound.get('oca_type')) || undefined,
    immediate: false,
    comment: strOf(bound.get('comment')) || undefined,
  });
  return { kind: 'void' };
});

registerBuiltin('strategy', 'close', (c, args, named) => {
  const bound = bindArgs(args, named, CLOSE_ORDER);
  const when = bound.get('when');
  if (when !== undefined && !truthy(when)) return { kind: 'void' };
  const imm = bound.get('immediately');
  pushOrder(c, {
    kind: 'close',
    id: strOf(bound.get('id')),
    fromEntry: '',
    dir: 0,
    ...qtyFields(bound),
    limit: undefined,
    stop: undefined,
    // evalArg wraps bool args in a BarSeries — read through the wrapper.
    immediate: imm !== undefined && truthy(imm),
    comment: strOf(bound.get('comment')) || undefined,
  });
  return { kind: 'void' };
});

registerBuiltin('strategy', 'close_all', (c, args, named) => {
  const bound = bindArgs(args, named, CLOSE_ALL_ORDER);
  const when = bound.get('when');
  if (when !== undefined && !truthy(when)) return { kind: 'void' };
  const imm = bound.get('immediately');
  pushOrder(c, {
    kind: 'close', id: '', fromEntry: '', dir: 0,
    qty: 0, eqPct: 0, limit: undefined, stop: undefined,
    immediate: imm !== undefined && truthy(imm),
    comment: strOf(bound.get('comment')) || undefined,
  });
  return { kind: 'void' };
});

registerBuiltin('strategy', 'order', (c, args, named) => {
  const bound = bindArgs(args, named, ORDER_ORDER);
  const dir = dirOf(bound.get('direction'));
  if (dir === 0) return { kind: 'void' };
  const when = bound.get('when');
  if (when !== undefined && !truthy(when)) return { kind: 'void' };
  pushOrder(c, {
    kind: 'order',
    id: strOf(bound.get('id'), 'order'),
    fromEntry: '',
    dir,
    ...qtyFields(bound),
    limit: optNum(bound, 'limit'),
    stop: optNum(bound, 'stop'),
    ocaName: strOf(bound.get('oca_name')) || undefined,
    ocaType: strOf(bound.get('oca_type')) || undefined,
    immediate: false,
    comment: strOf(bound.get('comment')) || undefined,
  });
  return { kind: 'void' };
});

registerBuiltin('strategy', 'cancel', (c, args, named) => {
  const bound = bindArgs(args, named, ['id', 'when'] as const);
  const when = bound.get('when');
  if (when !== undefined && !truthy(when)) return { kind: 'void' };
  const id = strOf(bound.get('id'));
  if (id === '') {
    // TV: cancel() requires an id — only strategy.cancel_all() cancels all.
    // A bare cancel() must not silently retire every pending order.
    warnOnce(c, 'strategy.cancel|noid', 'strategy.cancel() requires an id — use strategy.cancel_all() to cancel all orders');
    return { kind: 'void' };
  }
  pushOrder(c, {
    kind: 'cancel',
    id,
    fromEntry: '',
    dir: 0, qty: 0, eqPct: 0,
    limit: undefined, stop: undefined, immediate: false,
  });
  return { kind: 'void' };
});

registerBuiltin('strategy', 'cancel_all', (c, args, named) => {
  const bound = bindArgs(args, named, ['when', 'comment', 'alert_message'] as const);
  const when = bound.get('when');
  if (when !== undefined && !truthy(when)) return { kind: 'void' };
  pushOrder(c, {
    kind: 'cancel', id: 'strategy.cancel_all', fromEntry: '',
    dir: 0, qty: 0, eqPct: 0,
    limit: undefined, stop: undefined, immediate: false,
  });
  return { kind: 'void' };
});

// ── strategy.risk.* rules ───────────────────────────────────────────────────
// Every call appends a ledger event; simulate() installs the rule when it
// reaches that bar, so a rule declared on bar 0 governs the whole replay and
// one declared on bar 5 leaves the earlier bars untouched.

function pushRisk(ctx: BuiltinCtx, spec: RiskRuleSpec): void {
  const orders = ordersOf(ctx);
  orders.push({
    bar: ctx.barIndex, seq: orders.length, seen: -1, kind: 'risk',
    id: '', fromEntry: '', dir: 0, qty: 0, eqPct: 0,
    limit: undefined, stop: undefined, immediate: false, risk: spec,
  });
}

/** `type` argument of the money/percent rules → percent flag (cash otherwise). */
function isPercentType(v: Value | undefined): boolean {
  const s = strOf(v);
  return s === 'strategy.percent_of_equity' || s === 'percent_of_equity';
}

registerBuiltin('strategy.risk', 'allow_entry_in', (c, args, named) => {
  const bound = bindArgs(args, named, ['value'] as const);
  pushRisk(c, {
    rule: 'allow_entry_in',
    value: strOf(bound.get('value'), 'strategy.direction.all'),
    percent: false,
  });
  return { kind: 'void' };
});

registerBuiltin('strategy.risk', 'max_drawdown', (c, args, named) => {
  const bound = bindArgs(args, named, ['value', 'type', 'alert_message'] as const);
  pushRisk(c, {
    rule: 'max_drawdown',
    value: qtyOf(bound, 'value'),
    percent: isPercentType(bound.get('type')),
  });
  return { kind: 'void' };
});

registerBuiltin('strategy.risk', 'max_intraday_loss', (c, args, named) => {
  const bound = bindArgs(args, named, ['value', 'type', 'alert_message'] as const);
  pushRisk(c, {
    rule: 'max_intraday_loss',
    value: qtyOf(bound, 'value'),
    percent: isPercentType(bound.get('type')),
  });
  return { kind: 'void' };
});

registerBuiltin('strategy.risk', 'max_cons_loss_days', (c, args, named) => {
  const bound = bindArgs(args, named, ['count', 'alert_message'] as const);
  pushRisk(c, { rule: 'max_cons_loss_days', value: qtyOf(bound, 'count'), percent: false });
  return { kind: 'void' };
});

registerBuiltin('strategy.risk', 'max_intraday_filled_orders', (c, args, named) => {
  const bound = bindArgs(args, named, ['count', 'alert_message'] as const);
  pushRisk(c, { rule: 'max_intraday_filled_orders', value: qtyOf(bound, 'count'), percent: false });
  return { kind: 'void' };
});

registerBuiltin('strategy.risk', 'max_position_size', (c, args, named) => {
  const bound = bindArgs(args, named, ['contracts'] as const);
  pushRisk(c, { rule: 'max_position_size', value: qtyOf(bound, 'contracts'), percent: false });
  return { kind: 'void' };
});

// ── lazy series constants ───────────────────────────────────────────────────

registerLazyConstant('strategy', 'position_size', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  const sim = simAt(ctx!, ctx?.barIndex ?? -1);
  return numVal(sim.qty);
});

registerLazyConstant('strategy', 'position_avg_price', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  const sim = simAt(ctx!, ctx?.barIndex ?? -1);
  return sim.qty !== 0 ? { kind: 'float', v: sim.avgEntry } : NA;
});

registerLazyConstant('strategy', 'equity', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  if (!ctx) return NA;
  const cfg = cfgOf(ctx);
  const sim = simAt(ctx, ctx.barIndex);
  const open = sim.qty !== 0 ? sim.qty * (closeAt(ctx, ctx.barIndex, ctx.barIndex) - sim.avgEntry) : 0;
  return { kind: 'float', v: cfg.initial_capital + sim.realizedPnl + open };
});

registerLazyConstant('strategy', 'openprofit', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  if (!ctx) return NA;
  const sim = simAt(ctx, ctx.barIndex);
  if (sim.qty === 0) return { kind: 'float', v: 0 };
  return { kind: 'float', v: sim.qty * (closeAt(ctx, ctx.barIndex, ctx.barIndex) - sim.avgEntry) };
});

registerLazyConstant('strategy', 'closedtrades', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return numVal(simAt(ctx!, ctx?.barIndex ?? -1).closedTrades);
});

registerLazyConstant('strategy', 'opentrades', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return numVal(simAt(ctx!, ctx?.barIndex ?? -1).openTrades);
});

// ── per-trade function accessors + P&L rollups ─────────────────────────────
// strategy.closedtrades.* / strategy.opentrades.* take trade_num: TV numbers
// trades chronologically — 0 = FIRST trade, last = count-1. Out of range →
// na. Fields missing on a row kind → na.

function regClosed(name: string, pick: (t: ClosedTrade) => number): void {
  registerBuiltin('strategy.closedtrades', name, (c, args) => {
    if (!c) return NA;
    const rows = simAt(c, c.barIndex).closed;
    const i = curNum(args[0] ?? NA);
    const t = i !== undefined && i >= 0 && i < rows.length ? rows[Math.trunc(i)]! : undefined;
    if (t === undefined) return NA;
    const v = pick(t);
    return Number.isFinite(v) ? numVal(v) : NA;
  });
}

function regOpen(name: string, pick: (t: TradeLeg) => number): void {
  registerBuiltin('strategy.opentrades', name, (c, args) => {
    if (!c) return NA;
    const rows = simAt(c, c.barIndex).openLegs;
    const i = curNum(args[0] ?? NA);
    const t = i !== undefined && i >= 0 && i < rows.length ? rows[Math.trunc(i)]! : undefined;
    if (t === undefined) return NA;
    const v = pick(t);
    return Number.isFinite(v) ? numVal(v) : NA;
  });
}

/** Identity fields shared by open and closed trade rows. */
interface TradeIds { id: string; comment: string; exitId: string; exitComment: string }

/** String-valued per-trade accessor (entry_id / entry_comment / …). */
function regStr(ns: string, name: string, pick: (t: TradeIds) => string): void {
  registerBuiltin(ns, name, (c, args) => {
    if (!c) return NA;
    const sim = simAt(c, c.barIndex);
    const rows: readonly TradeIds[] = ns === 'strategy.closedtrades' ? sim.closed : sim.openLegs;
    const i = curNum(args[0] ?? NA);
    const t = i !== undefined && i >= 0 && i < rows.length ? rows[Math.trunc(i)]! : undefined;
    return t === undefined ? NA : { kind: 'string', v: pick(t) };
  });
}

// ── trade excursions (MFE / MAE) ────────────────────────────────────────────
// TV defines a trade's run-up/drawdown as the largest favorable / adverse
// price move while it was open, in account currency; the percent variants
// divide by the trade's size (entry price × quantity) — the guide calls it
// "a percentage of the trade's size". Scanning the bar range is memoized by
// row content so the documented "loop over every trade on every bar" pattern
// costs one scan per closed trade instead of one per bar.

interface ExcCache { byKey: Map<string, { runup: number; drawdown: number }> }
const EXC_KEY = 'strategy|excCache';

function excursionOf(
  ctx: BuiltinCtx, key: string, dir: number, entryPrice: number, qty: number,
  fromBar: number, toBar: number,
): { runup: number; drawdown: number } {
  const st = stateOf(ctx);
  let cache = st?.get(EXC_KEY) as ExcCache | undefined;
  if (st && !cache) { cache = { byKey: new Map() }; st.set(EXC_KEY, cache); }
  const hit = cache?.byKey.get(key);
  if (hit) return hit;
  let runup = 0, drawdown = 0;
  const upto = ctx.barIndex;
  for (let b = Math.max(0, fromBar); b <= toBar; b++) {
    const hi = highAt(ctx, b, upto), lo = lowAt(ctx, b, upto);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    const up = (dir > 0 ? hi - entryPrice : entryPrice - lo) * qty;
    const dn = (dir > 0 ? entryPrice - lo : hi - entryPrice) * qty;
    if (up > runup) runup = up;
    if (dn > drawdown) drawdown = dn;
  }
  const res = { runup, drawdown };
  cache?.byKey.set(key, res);
  return res;
}

/** Excursion accessor for one trade row; `to` is the exit bar (closed) or the
 *  current bar (open). Percent variants use the trade's size as denominator. */
function regExc(ns: string, name: string, which: 'runup' | 'drawdown', percent: boolean): void {
  registerBuiltin(ns, name, (c, args) => {
    if (!c) return NA;
    const sim = simAt(c, c.barIndex);
    const i = curNum(args[0] ?? NA);
    if (i === undefined || i < 0) return NA;
    const k = Math.trunc(i);
    // A closed row spans entry→exit; an open one spans entry→the current bar
    // (a TradeLeg also carries exitBar = -1, so the namespace decides).
    let dir: number, entryPrice: number, size: number, entryBar: number, endBar: number;
    if (ns === 'strategy.closedtrades') {
      const t = sim.closed[k];
      if (t === undefined) return NA;
      ({ dir, entryPrice, size } = { dir: t.dir, entryPrice: t.entryPrice, size: t.openedQty });
      entryBar = t.entryBar;
      endBar = t.exitBar;
    } else {
      const t = sim.openLegs[k];
      if (t === undefined) return NA;
      ({ dir, entryPrice, size } = { dir: t.dir, entryPrice: t.price, size: t.openedQty });
      entryBar = t.bar;
      endBar = c.barIndex;
    }
    if (endBar < entryBar) return NA;
    const key = `${ns}|${which}|${dir}|${entryPrice}|${size}|${entryBar}|${endBar}`;
    const ex = excursionOf(c, key, dir, entryPrice, size, entryBar, endBar);
    const v = which === 'runup' ? ex.runup : ex.drawdown;
    if (!percent) return numVal(v);
    const denom = entryPrice * size;
    return denom > 0 ? numVal(v / denom * 100) : NA;
  });
}

/** Unrealized P&L of one open leg (its partial exits + remaining contracts). */
function openLegProfit(ctx: BuiltinCtx, leg: TradeLeg): number {
  const close = closeAt(ctx, ctx.barIndex, ctx.barIndex);
  const open = Number.isFinite(close) ? leg.qty * leg.dir * (close - leg.price) : 0;
  return leg.pnl - leg.entryComm - leg.exitComm + open;
}

regClosed('entry_bar_index', t => t.entryBar);
regClosed('entry_price', t => t.entryPrice);
regClosed('entry_time', t => t.entryTime);
regClosed('exit_bar_index', t => t.exitBar);
regClosed('exit_price', t => t.exitPrice);
regClosed('exit_time', t => t.exitTime);
regClosed('profit', t => t.profit);
regClosed('size', t => t.openedQty * t.dir);
regClosed('commission', t => t.commission);

regOpen('entry_bar_index', t => t.bar);
regOpen('entry_price', t => t.price);
regOpen('entry_time', t => t.time);
regOpen('size', t => t.qty * t.dir);
regOpen('commission', t => t.entryComm + t.exitComm);

/** strategy.opentrades.profit() — marked to the current bar's close. */
registerBuiltin('strategy.opentrades', 'profit', (c, args) => {
  if (!c) return NA;
  const rows = simAt(c, c.barIndex).openLegs;
  const i = curNum(args[0] ?? NA);
  const t = i !== undefined && i >= 0 && i < rows.length ? rows[Math.trunc(i)]! : undefined;
  return t === undefined ? NA : numVal(openLegProfit(c, t));
});

regStr('strategy.closedtrades', 'entry_id', t => t.id);
regStr('strategy.closedtrades', 'exit_id', t => t.exitId);
regStr('strategy.closedtrades', 'entry_comment', t => t.comment);
regStr('strategy.closedtrades', 'exit_comment', t => t.exitComment);
regStr('strategy.opentrades', 'entry_id', t => t.id);
regStr('strategy.opentrades', 'entry_comment', t => t.comment);

regExc('strategy.closedtrades', 'max_runup', 'runup', false);
regExc('strategy.closedtrades', 'max_drawdown', 'drawdown', false);
regExc('strategy.closedtrades', 'max_runup_percent', 'runup', true);
regExc('strategy.closedtrades', 'max_drawdown_percent', 'drawdown', true);
regExc('strategy.opentrades', 'max_runup', 'runup', false);
regExc('strategy.opentrades', 'max_drawdown', 'drawdown', false);
regExc('strategy.opentrades', 'max_runup_percent', 'runup', true);
regExc('strategy.opentrades', 'max_drawdown_percent', 'drawdown', true);

/** P&L as a percentage of the trade's size (entry price × quantity). */
function regProfitPercent(ns: string, name: string, open: boolean): void {
  registerBuiltin(ns, name, (c, args) => {
    if (!c) return NA;
    const sim = simAt(c, c.barIndex);
    const i = curNum(args[0] ?? NA);
    if (i === undefined || i < 0) return NA;
    const k = Math.trunc(i);
    let entryPrice: number, size: number, profit: number;
    if (open) {
      const leg = sim.openLegs[k];
      if (leg === undefined) return NA;
      entryPrice = leg.price;
      size = leg.openedQty;
      profit = openLegProfit(c, leg);
    } else {
      const t = sim.closed[k];
      if (t === undefined) return NA;
      entryPrice = t.entryPrice;
      size = t.openedQty;
      profit = t.profit;
    }
    const denom = entryPrice * size;
    return denom > 0 ? numVal(profit / denom * 100) : NA;
  });
}
regProfitPercent('strategy.closedtrades', 'profit_percent', false);
regProfitPercent('strategy.opentrades', 'profit_percent', true);

registerLazyConstant('strategy', 'grossprofit', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  if (!ctx) return NA;
  return { kind: 'float', v: simAt(ctx, ctx.barIndex).closed.reduce((s, t) => t.profit > 0 ? s + t.profit : s, 0) };
});

registerLazyConstant('strategy', 'grossloss', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  if (!ctx) return NA;
  return { kind: 'float', v: Math.abs(simAt(ctx, ctx.barIndex).closed.reduce((s, t) => t.profit < 0 ? s + t.profit : s, 0)) };
});

registerLazyConstant('strategy', 'netprofit', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  if (!ctx) return NA;
  return { kind: 'float', v: simAt(ctx, ctx.barIndex).closed.reduce((s, t) => s + t.profit, 0) };
});

// ── trade statistics + performance ratios ───────────────────────────────────
// Percent bases follow the reference: the whole-range metrics (gross/net/max
// run-up/max drawdown) are "a percentage of the initial capital"; the per-trade
// ones are "a percentage of the trade's size"; openprofit_percent is documented
// as openPL / realizedEquity × 100.

const closedOf = (ctx: BuiltinCtx): ClosedTrade[] => simAt(ctx, ctx.barIndex).closed;

/** Whole-range metric as a percentage of the initial capital. */
export function pctOfCapital(ctx: BuiltinCtx, v: number): Value {
  const cap = cfgOf(ctx).initial_capital;
  return cap > 0 ? numVal(v / cap * 100) : NA;
}

const closedSum = (ctx: BuiltinCtx, keep: (t: ClosedTrade) => boolean): number =>
  closedOf(ctx).reduce((s, t) => keep(t) ? s + t.profit : s, 0);

registerLazyConstant('strategy', 'grossprofit_percent', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? pctOfCapital(ctx, closedSum(ctx, t => t.profit > 0)) : NA;
});

registerLazyConstant('strategy', 'grossloss_percent', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? pctOfCapital(ctx, Math.abs(closedSum(ctx, t => t.profit < 0))) : NA;
});

registerLazyConstant('strategy', 'netprofit_percent', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? pctOfCapital(ctx, closedSum(ctx, () => true)) : NA;
});

/** strategy.openprofit_percent — openPL / realizedEquity × 100, where the
 *  realized equity is the initial capital plus every closed trade's P&L. */
registerLazyConstant('strategy', 'openprofit_percent', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  if (!ctx) return NA;
  const sim = simAt(ctx, ctx.barIndex);
  if (sim.qty === 0) return numVal(0);
  const close = closeAt(ctx, ctx.barIndex, ctx.barIndex);
  if (!Number.isFinite(close)) return NA;
  const realizedEquity = cfgOf(ctx).initial_capital + sim.realizedPnl;
  if (realizedEquity === 0) return NA;
  return numVal(sim.qty * (close - sim.avgEntry) / realizedEquity * 100);
});

registerLazyConstant('strategy', 'wintrades', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? numVal(closedOf(ctx).filter(t => t.profit > 0).length) : NA;
});

registerLazyConstant('strategy', 'losstrades', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? numVal(closedOf(ctx).filter(t => t.profit < 0).length) : NA;
});

registerLazyConstant('strategy', 'eventrades', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? numVal(closedOf(ctx).filter(t => t.profit === 0).length) : NA;
});

/** Mean of `pick` over the closed trades `keep` accepts; na with no such row. */
function meanOver(ctx: BuiltinCtx, keep: (t: ClosedTrade) => boolean, pick: (t: ClosedTrade) => number): Value {
  const rows = closedOf(ctx).filter(keep);
  if (rows.length === 0) return NA;
  return numVal(rows.reduce((s, t) => s + pick(t), 0) / rows.length);
}

/** Per-trade P&L as a percentage of the trade's size (entry price × qty). */
const tradePct = (t: ClosedTrade): number =>
  t.entryPrice * t.openedQty > 0 ? t.profit / (t.entryPrice * t.openedQty) * 100 : NaN;

registerLazyConstant('strategy', 'avg_trade', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? meanOver(ctx, () => true, t => t.profit) : NA;
});

registerLazyConstant('strategy', 'avg_trade_percent', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? meanOver(ctx, () => true, tradePct) : NA;
});

registerLazyConstant('strategy', 'avg_winning_trade', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? meanOver(ctx, t => t.profit > 0, t => t.profit) : NA;
});

registerLazyConstant('strategy', 'avg_winning_trade_percent', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? meanOver(ctx, t => t.profit > 0, tradePct) : NA;
});

registerLazyConstant('strategy', 'avg_losing_trade', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? meanOver(ctx, t => t.profit < 0, t => t.profit) : NA;
});

registerLazyConstant('strategy', 'avg_losing_trade_percent', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? meanOver(ctx, t => t.profit < 0, tradePct) : NA;
});

// ── position / account state ────────────────────────────────────────────────

registerLazyConstant('strategy', 'initial_capital', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? numVal(cfgOf(ctx).initial_capital) : NA;
});

/** strategy.account_currency — the currency code the run books P&L in. The
 *  strategy() default (currency.NONE, the bare string 'NONE') means "the chart
 *  symbol's currency". Legacy dotted values ('currency.TWD') are still accepted
 *  because the strategy() `currency=` argument may carry one. */
function accountCurrencyOf(ctx: BuiltinCtx): string {
  const c = cfgOf(ctx).currency;
  if (c === '' || c === 'NONE' || c === 'currency.NONE') {
    const v = ctx.syminfo?.currency;
    const u = v !== undefined && v.kind === 'series' ? v.v.cur() : v;
    return u !== undefined ? asStr(u) : 'NONE';
  }
  return c.startsWith('currency.') ? c.slice('currency.'.length) : c;
}

registerLazyConstant('strategy', 'account_currency', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? { kind: 'string', v: accountCurrencyOf(ctx) } : NA;
});

registerLazyConstant('strategy', 'position_entry_name', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  if (!ctx) return NA;
  const sim = simAt(ctx, ctx.barIndex);
  return sim.qty !== 0 ? { kind: 'string', v: sim.positionEntryName } : NA;
});

registerLazyConstant('strategy', 'max_contracts_held_all', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? numVal(simAt(ctx, ctx.barIndex).maxContractsAll) : NA;
});

registerLazyConstant('strategy', 'max_contracts_held_long', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? numVal(simAt(ctx, ctx.barIndex).maxContractsLong) : NA;
});

registerLazyConstant('strategy', 'max_contracts_held_short', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? numVal(simAt(ctx, ctx.barIndex).maxContractsShort) : NA;
});

/** strategy.closedtrades.first_index — the List of Trades is never trimmed by
 *  this engine, so the oldest listed trade is always number 0. */
registerLazyConstant('strategy.closedtrades', 'first_index', () => numVal(0));

/** strategy.opentrades.capital_held — the account money the open legs tie up:
 *  each leg's current market value times its side's margin ratio. na when the
 *  run uses no margin at all (both ratios zero). */
registerLazyConstant('strategy', 'opentrades.capital_held', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  if (!ctx) return NA;
  const cfg = cfgOf(ctx);
  if (cfg.margin_long === 0 && cfg.margin_short === 0) return NA;
  const sim = simAt(ctx, ctx.barIndex);
  if (sim.openLegs.length === 0) return numVal(0);
  const close = closeAt(ctx, ctx.barIndex, ctx.barIndex);
  const price = Number.isFinite(close) ? close : 0;
  const pv = pointValueOf(ctx);
  let held = 0;
  for (const leg of sim.openLegs) {
    const ratio = (leg.dir > 0 ? cfg.margin_long : cfg.margin_short) / 100;
    held += leg.qty * price * pv * ratio;
  }
  return numVal(held);
});

/** strategy.margin_liquidation_price — the price where the Broker Emulator's
 *  margin call fires. Solving available funds = equity − margin = 0 for the
 *  price gives (dir·Q·PV·entry − E0) / (Q·PV·(dir − ratio)), with E0 the
 *  equity excluding the open position's P&L. A zero denominator (100% margin
 *  long) means the price is unattainable. na when flat, when no margin
 *  parameter was declared, or when the ratio is zero (no limit). */
registerLazyConstant('strategy', 'margin_liquidation_price', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  if (!ctx) return NA;
  const cfg = cfgOf(ctx);
  if (!cfg.marginDeclared) return NA;
  const sim = simAt(ctx, ctx.barIndex);
  if (sim.qty === 0) return NA;
  const dir = Math.sign(sim.qty);
  const ratio = (dir > 0 ? cfg.margin_long : cfg.margin_short) / 100;
  if (!(ratio > 0)) return NA;
  const size = Math.abs(sim.qty) * pointValueOf(ctx);
  const denom = size * (dir - ratio);
  if (denom === 0) return NA;
  const e0 = cfg.initial_capital + sim.realizedPnl;
  return numVal((dir * size * sim.avgEntry - e0) / denom);
});

// ── currency conversion + default sizing ────────────────────────────────────

/** strategy.convert_to_account / convert_to_symbol — both need a daily FX
 *  rate this engine has no source for. Same-currency runs are the identity;
 *  a cross-currency run is reported once and returns the input unchanged
 *  rather than inventing a rate. */
function convertCurrency(ctx: BuiltinCtx, args: readonly Value[], dir: 'account' | 'symbol'): Value {
  const n = curNum(args[0] ?? NA);
  if (n === undefined || !Number.isFinite(n)) return NA;
  const sym = ctx.syminfo?.currency;
  const symCur = sym !== undefined ? asStr(sym.kind === 'series' ? sym.v.cur() : sym) : '';
  const acct = accountCurrencyOf(ctx);
  if (symCur !== acct) {
    warnOnce(ctx, 'strategy|fx',
      `strategy.convert_to_${dir}(): no exchange rate for ${symCur} → ${acct}; the value is returned unchanged`);
  }
  return numVal(n);
}
registerBuiltin('strategy', 'convert_to_account', (c, args) => c ? convertCurrency(c, args, 'account') : NA);
registerBuiltin('strategy', 'convert_to_symbol', (c, args) => c ? convertCurrency(c, args, 'symbol') : NA);

/** strategy.default_entry_qty(fill_price) — the quantity an entry would size
 *  to at that price under the strategy's default_qty_* settings. Ignores any
 *  open position, exactly like the reference. */
registerBuiltin('strategy', 'default_entry_qty', (c, args) => {
  if (!c) return NA;
  const price = curNum(args[0] ?? NA);
  if (price === undefined || !(price > 0)) return NA;
  const cfg = cfgOf(c);
  const sim = simAt(c, c.barIndex);
  const close = closeAt(c, c.barIndex, c.barIndex);
  const open = sim.qty !== 0 && Number.isFinite(close) ? sim.qty * (close - sim.avgEntry) : 0;
  const equity = cfg.initial_capital + sim.realizedPnl + open;
  switch (cfg.default_qty_type) {
    case 'strategy.percent_of_equity':
    case 'percent_of_equity':
      return numVal(equity * cfg.default_qty_value / (100 * price));
    case 'strategy.cash':
    case 'cash':
      return numVal(cfg.default_qty_value / price);
    default:
      return numVal(cfg.default_qty_value);
  }
});

// ── enum / currency constants ───────────────────────────────────────────────

function enumSet(ns: string, names: readonly string[]): void {
  for (const n of names) registerConstant(ns, n, { kind: 'string', v: `${ns}.${n}` });
}

enumSet('strategy', ['long', 'short', 'fixed', 'percent_of_equity', 'cash']);
enumSet('strategy.direction', ['long', 'short', 'all']);
enumSet('strategy.commission', ['percent', 'cash_per_contract', 'cash_per_order']);
enumSet('strategy.oca', ['none', 'cancel', 'reduce']);
// Plan's `strategy.order.*` constants are the OCA family in Pine v5; register
// both spellings so either reference resolves.
enumSet('strategy.order', ['none', 'cancel', 'reduce']);
// currency.* — TV's `currency.USD` IS the string "USD" (unlike the dotted-name
// enums above), so these carry the bare code as their value. `currency.NONE`
// means "use the chart symbol's currency" (see accountCurrencyOf).
const CURRENCY_CODES = [
  'NONE', 'USD', 'EUR', 'AUD', 'GBP', 'NZD', 'CAD', 'CHF', 'HKD', 'JPY', 'NOK',
  'SEK', 'SGD', 'TRY', 'ZAR', 'RUB', 'BTC', 'ETH', 'MYR', 'KRW', 'USDT', 'INR',
  'PLN', 'PKR', 'EGP', 'AED', 'COP', 'MXN', 'CLP', 'BRL', 'ARS', 'PEN', 'IDR',
  'SAR', 'BDT', 'BHD', 'CNY', 'CZK', 'DKK', 'HUF', 'ILS', 'ISK', 'KES', 'KWD',
  'LKR', 'MAD', 'NGN', 'PHP', 'QAR', 'RON', 'RSD', 'THB', 'TND', 'TWD', 'VES',
  'VND',
];
for (const c of CURRENCY_CODES) registerConstant('currency', c, { kind: 'string', v: c });

// ── strategy(...) declaration ───────────────────────────────────────────────

/** Evaluate literal-ish decl arg nodes (no eval frame available). */
function staticLit(n: Node): Value | undefined {
  switch (n.type) {
    case 'num': return numVal(n.v);
    case 'str': return { kind: 'string', v: n.v };
    case 'bool': return n.v ? VTRUE : { kind: 'bool', v: false };
    case 'color': return { kind: 'color', v: n.v };
    case 'na': return NA;
    case 'unary': {
      if (n.op !== '-') return undefined;
      const a = staticLit(n.arg);
      return a && (a.kind === 'int' || a.kind === 'float')
        ? numVal(-a.v) : undefined;
    }
    case 'member':
      return n.obj.type === 'ident' ? getConstant(`${n.obj.name}.${n.prop}`) : undefined;
    default:
      return undefined;
  }
}

/**
 * Parse `strategy(...)` declaration args into `ctx.state['strategy|cfg']`.
 * Called once per run by the interpreter's `case 'strategy'` handler
 * (wired by the interpreter task — this export works standalone).
 */
/** Pine v5 strategy() signature order — exported so declDrawQuotas (and any
 *  other decl-level reader) binds positionals the same way. */
export const STRATEGY_DECL_ORDER = [
  'title', 'shorttitle', 'overlay', 'format', 'precision', 'scale',
  'pyramiding', 'calc_on_order_fills', 'calc_on_every_tick',
  'max_bars_back', 'backtest_fill_limits_assumption',
  'default_qty_type', 'default_qty_value',
  'initial_capital', 'currency',
  'slippage', 'commission_type', 'commission_value',
  'process_orders_on_close', 'close_entries_rule',
  'margin_long', 'margin_short',
  'explicit_plot_zorder', 'max_lines_count', 'max_labels_count',
  'max_boxes_count', 'calc_bars_count', 'risk_free_rate', 'use_bar_magnifier',
  'fill_orders_on_standard_ohlc', 'max_polylines_count', 'dynamic_requests',
  'behind_chart', 'calc_on_every_history_tick',
] as const;

/** `strategy()` parameters that carry behaviour this engine does not implement.
 *  A declared-but-ignored parameter is reported once per run (see strategyDecl)
 *  instead of vanishing silently: a `slippage` that disappears makes the equity
 *  curve look better than the run actually is. Display metadata (title, format,
 *  precision, scale) and the quota parameters declDrawQuotas reads are NOT here. */
export const STRATEGY_UNSUPPORTED_PARAMS = [
  'calc_on_order_fills', 'calc_on_every_tick', 'max_bars_back',
  'backtest_fill_limits_assumption', 'close_entries_rule',
  'risk_free_rate', 'use_bar_magnifier',
  'calc_bars_count', 'fill_orders_on_standard_ohlc', 'dynamic_requests',
  'calc_on_every_history_tick',
] as const;

export function strategyDecl(ctx: BuiltinCtx, node: StrategyDecl): void {
  const st = stateOf(ctx);
  if (!st) return;
  // Pine v5 strategy() signature order; positionals fill slots not named.
  const bound = bindDeclArgs(node.args, STRATEGY_DECL_ORDER);
  // Drawing-count quotas live on RtCtx for draw.ts's live-object caps.
  declDrawQuotas(ctx, node.args, STRATEGY_DECL_ORDER);
  const lit = (name: string): Value | undefined => {
    const n = bound.get(name);
    return n === undefined ? undefined : staticLit(n);
  };
  const num = (name: string, def: number): number => {
    const v = lit(name);
    return v && (v.kind === 'int' || v.kind === 'float') ? v.v : def;
  };
  const str = (name: string, def: string): string => {
    const v = lit(name);
    return v === undefined || v.kind === 'na' ? def : asStr(v);
  };
  const bool = (name: string, def: boolean): boolean => {
    const v = lit(name);
    return v?.kind === 'bool' ? v.v : def;
  };
  const cfg: StratCfg = {
    initial_capital: num('initial_capital', DEFAULT_CFG.initial_capital),
    default_qty_type: str('default_qty_type', DEFAULT_CFG.default_qty_type),
    default_qty_value: num('default_qty_value', DEFAULT_CFG.default_qty_value),
    commission_type: str('commission_type', DEFAULT_CFG.commission_type),
    commission_value: num('commission_value', DEFAULT_CFG.commission_value),
    process_orders_on_close: bool('process_orders_on_close', false),
    currency: str('currency', DEFAULT_CFG.currency),
    pyramiding: num('pyramiding', DEFAULT_CFG.pyramiding),
    slippage: num('slippage', DEFAULT_CFG.slippage),
    margin_long: num('margin_long', DEFAULT_CFG.margin_long),
    margin_short: num('margin_short', DEFAULT_CFG.margin_short),
    marginDeclared: bound.has('margin_long') || bound.has('margin_short'),
  };
  st.set(CFG_KEY, cfg);
  // Declared-but-unimplemented parameters are reported once per run instead of
  // being dropped in silence (see STRATEGY_UNSUPPORTED_PARAMS).
  const ignored = STRATEGY_UNSUPPORTED_PARAMS.filter((n) => bound.has(n));
  if (ignored.length > 0) {
    warnOnce(ctx, 'strategy|unsupported',
      `strategy(): ${ignored.map((n) => `'${n}'`).join(', ')} declared but not implemented — the run ignores ${ignored.length > 1 ? 'them' : 'it'}`);
  }
}
