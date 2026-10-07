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
}

export interface StratOrder {
  /** Bar the call executed on. */
  bar: number;
  seq: number;
  kind: 'entry' | 'exit' | 'close' | 'order' | 'cancel';
  id: string;
  /** Entry id to close (exit/cancel/cancel_all). */
  fromEntry: string;
  dir: number;
  /** Absolute qty (>0 = explicit), else 0 → config/qty_percent. */
  qty: number;
  /** Percent of equity (entries) / of position (exits); 0 = unused. */
  eqPct: number;
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
  mod?: { qty: number; eqPct: number; limit?: number; stop?: number };
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
}

const ORDERS_KEY = 'strategy|orders';
const CFG_KEY = 'strategy|cfg';
const CACHE_KEY = 'strategy|simCache';

// ── ctx plumbing ────────────────────────────────────────────────────────────

function stateOf(ctx: BuiltinCtx | undefined): Map<string, unknown> | undefined {
  if (!ctx) return undefined;
  const rt = ctx as RtCtx;
  rt.state ??= new Map();
  return rt.state;
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

// ── replay ──────────────────────────────────────────────────────────────────

/**
 * Simulate through the end of `uptoBar`. Pure in (orders, bars, cfg):
 * scratch fields on orders are rewritten each call, so results do not
 * depend on call order or call sites.
 */
export function simulate(ctx: BuiltinCtx, orders: StratOrder[], cfg: StratCfg, uptoBar: number): Sim {
  const sim: Sim = { qty: 0, avgEntry: 0, realizedPnl: 0, closedTrades: 0, openTrades: 0, execs: [], curTrade: 0 };
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

  /** Touch-check every pending order through `limit`, filling on touch. */
  const advancePending = (limit: number): void => {
    const lim = Math.min(limit, uptoBar);
    for (let k = 0; k < pending.length; k++) {
      const o = pending[k]!;
      for (let b = o.seen + 1; b <= lim; b++) {
        if (o.cancelledAt !== undefined && b > o.cancelledAt) break;
        if (fillCandidate(o, b)) { applyFill(o, b, o.fillPrice!, o.fillQty!); o.seen = b; break; }
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
    const dir = fillDir(o);
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
          const tq = resolveQty(o, trailStop, b);
          if (tq > 0) { o.fillPrice = trailStop; o.fillQty = tq; return true; }
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
    if (!conditional) {
      if (b !== r) return false;
      price = sameBar ? closeAt(ctx, b, uptoBar) : openAt(ctx, b, uptoBar);
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
      price = stopPx !== undefined && limitPx !== undefined
        ? (dir > 0 ? Math.max(stopPx, limitPx) : Math.min(stopPx, limitPx))
        : (stopPx ?? limitPx)!;
    }
    if (!Number.isFinite(price)) return false;
    const qty = resolveQty(o, price, b);
    if (!(qty > 0)) { o.seen = b; return false; }
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
      if (dupe) { dupe.mod = { qty: o.qty, eqPct: o.eqPct, limit: o.limit, stop: o.stop }; o.seen = o.bar; continue; }
      // Same-direction entry while positioned → ignored unless pyramiding.
      if (sim.qty !== 0 && Math.sign(sim.qty) === o.dir && sim.openTrades >= cfg.pyramiding + 1) { o.seen = o.bar; continue; }
    }
    o.seen = o.bar - 1; // next advance checks from this order's bar
    pending.push(o);
  }
  advancePending(uptoBar);
  return sim;

  // ── nested helpers (closure over sim/ctx) ──

  function fillDir(o: StratOrder): number {
    if (o.kind === 'entry' || o.kind === 'order') return o.dir;
    return -Math.sign(sim.qty); // exit/close trades against the open position
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
  function resolveQty(o: StratOrder, price: number, atBar: number): number {
    if (o.kind === 'entry' || o.kind === 'order') {
      const eqPct = o.mod?.eqPct ?? o.eqPct;
      const qty = o.mod?.qty ?? o.qty;
      if (eqPct > 0) return equityNow(atBar) * eqPct / (100 * price);
      if (qty > 0) return qty;
      switch (cfg.default_qty_type) {
        case 'strategy.percent_of_equity':
        case 'percent_of_equity':
          return equityNow(atBar) * cfg.default_qty_value / (100 * price);
        case 'strategy.cash':
        case 'cash':
          return cfg.default_qty_value / price;
        default:
          return cfg.default_qty_value;
      }
    }
    // exit / close — contracts to close.
    const pos = Math.abs(sim.qty);
    if (pos === 0) return 0;
    if (o.kind === 'close') return pos;
    if (o.qty > 0) return Math.min(o.qty, pos);
    if (o.eqPct > 0) return pos * Math.min(1, o.eqPct / 100);
    return pos;
  }

  function applyFill(o: StratOrder, bar: number, price: number, qty: number): void {
    const dir = fillDir(o);
    const isEntry = o.kind === 'entry' || o.kind === 'order';
    // A reversal entry trades |position| + qty contracts: the fill closes the
    // old side and opens the new one in a single order (Pine behavior).
    const traded = isEntry && sim.qty !== 0 && Math.sign(sim.qty) !== dir
      ? qty + Math.abs(sim.qty) : qty;
    const match = traded * dir; // signed contracts traded
    if (match === 0) return;
    // New round-trip: entry at flat position OR an entry that flips the side.
    if (isEntry && (sim.qty === 0 || Math.sign(sim.qty) !== dir)) sim.curTrade++;
    sim.execs.push({
      bar, price, dir,
      kind: isEntry ? 'entry' : 'exit',
      label: o.comment !== undefined && o.comment !== '' ? o.comment : o.id,
      qty: traded,
      tradeId: sim.curTrade,
    });
    sim.realizedPnl -= commission(match, price);
    const closeLeg = (c: number): void => {
      const q = Math.min(Math.abs(c), Math.abs(sim.qty));
      sim.realizedPnl += q * (price - sim.avgEntry) * Math.sign(sim.qty);
      sim.qty -= Math.sign(sim.qty) * q;
      // TV: a trade is closed only when the position goes fully flat — partial
      // exits do not count. openTrades ≈ legs feeding the position, so a full
      // close adds every leg (pyramiding-safe approximation).
      if (sim.qty === 0) {
        sim.closedTrades += Math.max(1, sim.openTrades);
        sim.avgEntry = 0;
        sim.openTrades = 0;
      }
    };
    if (sim.qty === 0) {
      sim.qty = match;
      sim.avgEntry = price;
      sim.openTrades += 1;
    } else if (Math.sign(sim.qty) === Math.sign(match)) {
      const w = Math.abs(match);
      if (o.kind === 'entry' || o.kind === 'order') {
        sim.avgEntry = (sim.avgEntry * Math.abs(sim.qty) + price * w) / (Math.abs(sim.qty) + w);
        sim.qty += match;
        sim.openTrades += 1;
      } else {
        closeLeg(match); // shouldn't happen (exit dir opposes position)
      }
    } else {
      // Opposite trade: close what we can, open the rest (reversal).
      const before = Math.abs(sim.qty);
      closeLeg(match);
      const rem = Math.abs(match) - before;
      if (rem > 0) {
        sim.qty = Math.sign(match) * rem;
        sim.avgEntry = price;
        sim.openTrades += 1;
      }
    }
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
  if (!st) return { qty: 0, avgEntry: 0, realizedPnl: 0, closedTrades: 0, openTrades: 0, execs: [], curTrade: 0 };
  const orders = st.get(ORDERS_KEY) as StratOrder[] | undefined;
  if (!orders || orders.length === 0) return { qty: 0, avgEntry: 0, realizedPnl: 0, closedTrades: 0, openTrades: 0, execs: [], curTrade: 0 };
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

const ENTRY_ORDER = ['id', 'direction', 'qty', 'limit', 'stop', 'when', 'comment', 'comment_disabled', 'alert_message', 'oca_name', 'oca_type', 'disable_alert'] as const;
const EXIT_ORDER = ['id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop', 'trail_price', 'trail_points', 'trail_offset', 'when', 'comment', 'comment_disabled', 'comment_profit', 'comment_loss', 'comment_trailing', 'alert_message', 'alert_profit', 'alert_loss', 'alert_trailing', 'disable_alert'] as const;
const ORDER_ORDER = ['id', 'direction', 'qty', 'limit', 'stop', 'when', 'comment', 'alert_message', 'oca_name', 'oca_type', 'disable_alert'] as const;
const CLOSE_ORDER = ['id', 'when', 'immediately', 'comment', 'qty', 'qty_percent', 'alert_message', 'disable_alert'] as const;

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
    qty: qtyOf(bound, 'qty'),
    eqPct: qtyOf(bound, 'qty_percent'),
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
    qty: qtyOf(bound, 'qty'),
    eqPct: qtyOf(bound, 'qty_percent'),
    limit: optNum(bound, 'limit'),
    stop: optNum(bound, 'stop'),
    profitTicks: optNum(bound, 'profit'),
    lossTicks: optNum(bound, 'loss'),
    trailPrice: optNum(bound, 'trail_price'),
    trailPoints: optNum(bound, 'trail_points'),
    trailOffset: optNum(bound, 'trail_offset'),
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
    qty: qtyOf(bound, 'qty'),
    eqPct: qtyOf(bound, 'qty_percent'),
    limit: undefined,
    stop: undefined,
    // evalArg wraps bool args in a BarSeries — read through the wrapper.
    immediate: imm !== undefined && truthy(imm),
    comment: strOf(bound.get('comment')) || undefined,
  });
  return { kind: 'void' };
});

registerBuiltin('strategy', 'close_all', (c, args, named) => {
  const bound = bindArgs(args, named, CLOSE_ORDER);
  const when = bound.get('when');
  if (when !== undefined && !truthy(when)) return { kind: 'void' };
  const imm = bound.get('immediately');
  pushOrder(c, {
    kind: 'close', id: '', fromEntry: '', dir: 0,
    qty: 0, eqPct: 0, limit: undefined, stop: undefined,
    immediate: imm !== undefined && truthy(imm),
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
    qty: qtyOf(bound, 'qty'),
    eqPct: qtyOf(bound, 'qty_percent'),
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
enumSet('currency', ['USD', 'TWD', 'EUR', 'JPY', 'GBP', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NONE', 'BTC', 'ETH']);

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
  'max_boxes_count', 'max_tables_count', 'max_polylines_count',
  'risk_free_rate', 'use_bar_magnifier',
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
  };
  st.set(CFG_KEY, cfg);
}
