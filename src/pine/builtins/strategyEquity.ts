// ── strategy.max_drawdown ───────────────────────────────────────────────────
// strategy.equity/openprofit live in strategy.ts (its owner's region). This
// module adds `strategy.max_drawdown` — the max peak-to-trough of the equity
// curve so far (mark-to-market at each bar's close).
//
// Historical equity needs simulate() evaluated *as of* each past bar. The
// ctx OHLC Series history is relative to the current bar, and simulate()
// prices fills at `get(upto - b)`, which only lands on bar b when
// upto == ctx.barIndex. shifted() wraps ctx so simulate(uptoBar=b) reads bar
// b's prices correctly for any b ≤ barIndex.

import { NA, type BuiltinCtx, type Value } from '../contracts';
import { registerLazyConstant } from './registry';
import { numVal, type RtCtx } from './util';
import { cfgOf, simulate, type StratOrder } from './strategy';

const ORDERS_KEY = 'strategy|orders';
const DD_KEY = 'strategy|ddCache';

interface DdCache {
  /** orders.length the equity curve was computed against (invalidation key). */
  count: number;
  /** equity[k] = equity at bar k (mark-to-market at that bar's close). */
  equity: number[];
  peak: number;
  dd: number;
}

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

registerLazyConstant('strategy', 'max_drawdown', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  if (!ctx) return NA;
  const rt = ctx as RtCtx;
  rt.state ??= new Map();
  const orders = (rt.state.get(ORDERS_KEY) as StratOrder[] | undefined) ?? [];
  const bar = ctx.barIndex;
  let cache = rt.state.get(DD_KEY) as DdCache | undefined;
  if (!cache || cache.count !== orders.length) {
    cache = { count: orders.length, equity: [], peak: -Infinity, dd: 0 };
    rt.state.set(DD_KEY, cache);
  }
  // Extend the curve to the current bar; equity per bar is memoized so a
  // read every bar costs one replay of the new bars each time.
  for (let b = cache.equity.length; b <= bar; b++) {
    const eq = equityAt(ctx, orders, b);
    cache.equity.push(eq);
    if (eq > cache.peak) cache.peak = eq;
    const dd = cache.peak - eq;
    if (dd > cache.dd) cache.dd = dd;
  }
  return numVal(cache.dd);
});
