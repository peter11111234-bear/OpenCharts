// ── strategy equity-curve metrics ───────────────────────────────────────────
// strategy.max_drawdown / max_runup (+ their percent variants) — the largest
// peak-to-trough fall and the largest trough-to-peak recovery of the equity
// curve so far (mark-to-market at each bar's close). The percent variants use
// the initial capital as denominator, per the reference.
// strategy.equity/openprofit live in strategy.ts (its owner's region).
//
// The equity curve is recorded by the resumable stepper (strategy.ts): every
// `simAt` run writes one mark-to-market entry per bar into `SimCache.equity`
// after that bar's fills, risk rules and margin call settle. This module folds
// that recorded prefix into the running peak/drawdown and trough/runup; it
// never replays past bars itself. There is nothing to fold with no orders (no
// `strategy|simCache` leaf is created), so that case keeps the historical flat
// curve — initial capital every bar, dd/runup 0.

import { NA, type BuiltinCtx } from '../contracts';
import { registerLazyConstant } from './registry';
import { numVal, type RtCtx } from './util';
import { execsAt, pctOfCapital, type StratOrder } from './strategy';

const ORDERS_KEY = 'strategy|orders';
/** Mirrors strategy.ts's private CACHE_KEY — the SimCache `equity` sink lives
 *  under this state key. Read by value to avoid exporting the key. */
const CACHE_KEY = 'strategy|simCache';
const DD_KEY = 'strategy|ddCache';

interface DdCache {
  /** orders.length the fold was computed against (invalidation key). */
  count: number;
  /** Number of `SimCache.equity` entries folded so far (the fold cursor). */
  len: number;
  /** equity[len - 1] as last folded — a moved tail means the sink rewound and
   *  re-recorded (forming-bar tick / orders change), so refold from 0. */
  lastEq: number | undefined;
  peak: number;
  dd: number;
  /** Running equity trough + the largest trough-to-peak recovery. */
  trough: number;
  runup: number;
}

/** Reset the running accumulators so the next fold starts from entry 0. */
function resetFold(c: DdCache): void {
  c.len = 0;
  c.lastEq = undefined;
  c.peak = -Infinity;
  c.dd = 0;
  c.trough = Infinity;
  c.runup = 0;
}

/** Extend the fold to the current bar and return its cache. One fold pass per
 *  new equity entry, so reading any equity metric every bar is cheap. */
function equityCurve(ctx: BuiltinCtx): DdCache {
  const rt = ctx as RtCtx;
  rt.state ??= new Map();
  const orders = (rt.state.get(ORDERS_KEY) as StratOrder[] | undefined) ?? [];
  const bar = ctx.barIndex;
  let cache = rt.state.get(DD_KEY) as DdCache | undefined;
  if (!cache) {
    cache = { count: orders.length, len: 0, lastEq: undefined, peak: -Infinity, dd: 0, trough: Infinity, runup: 0 };
    rt.state.set(DD_KEY, cache);
  } else if (cache.count !== orders.length) {
    // The ledger grew or shrank; the folded values no longer correspond. The
    // sink below is re-recorded against the new ledger, so refold from 0. The
    // cache object is mutated in place (never swapped) so a checkpoint restore
    // restates its fields on the same instance.
    cache.count = orders.length;
    resetFold(cache);
  }
  // No orders ⇒ no `strategy|simCache` leaf; the flat initial-capital curve
  // reports dd/runup 0 (the historical behaviour).
  if (orders.length === 0) {
    resetFold(cache);
    return cache;
  }
  // Drive the resumable stepper to `bar`; it records `SimCache.equity` as it
  // goes. `execsAt` is the exported door into simAt — its result is unused.
  execsAt(ctx, bar);
  const src = (rt.state.get(CACHE_KEY) as { equity: number[] } | undefined)?.equity ?? [];
  // `src` is append-only in the steady state, but a forming-bar tick or an
  // orders change rewinds and re-records it. If it rewound below our cursor, or
  // the last folded entry moved, the accumulators are stale — refold from 0.
  if (src.length < cache.len || (cache.len > 0 && !Object.is(src[cache.len - 1], cache.lastEq))) {
    resetFold(cache);
  }
  for (let b = cache.len; b < src.length; b++) {
    const eq = src[b]!;
    if (eq > cache.peak) cache.peak = eq;
    const dd = cache.peak - eq;
    if (dd > cache.dd) cache.dd = dd;
    if (eq < cache.trough) cache.trough = eq;
    const ru = eq - cache.trough;
    if (ru > cache.runup) cache.runup = ru;
  }
  cache.len = src.length;
  cache.lastEq = src.length > 0 ? src[src.length - 1] : undefined;
  return cache;
}

/** Whole-range equity metric as a percentage of the initial capital (the
 *  reference's basis for max_drawdown_percent / max_runup_percent). */

registerLazyConstant('strategy', 'max_drawdown', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? numVal(equityCurve(ctx).dd) : NA;
});

registerLazyConstant('strategy', 'max_drawdown_percent', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? pctOfCapital(ctx, equityCurve(ctx).dd) : NA;
});

registerLazyConstant('strategy', 'max_runup', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? numVal(equityCurve(ctx).runup) : NA;
});

registerLazyConstant('strategy', 'max_runup_percent', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  return ctx ? pctOfCapital(ctx, equityCurve(ctx).runup) : NA;
});
