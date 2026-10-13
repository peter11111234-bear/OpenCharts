// ── Data-source-dependent TV v6 namespaces: warn stubs ──────────────────────
// These entries are documented Pine v6 builtins, but every one of them needs a
// data source this engine does not have: tick-level footprint aggregation
// (`footprint.*`, `volume_row.*`), alternative ticker construction
// (`ticker.renko`/`kagi`/…), third-party or fundamental feeds (already stubbed
// in request.ts), and the field selectors `request.earnings` / `request.dividends`
// / `request.splits` take.
//
// They are registered so the name RESOLVES. An unregistered name reports
// "identifier not found" / "unknown constant", which hides the real reason and
// makes the user think the engine is missing a name it simply cannot compute.
//
// Every use warns and returns na. Warning is the point: silent na is wrong here.
// The fields especially must not be static string constants — `asNum` coerces
// the dotted selector string to 0 (`Number('earnings.actual')` is NaN), so
// `plot(earnings.actual)` would draw a flat line at 0 with no explanation.
// Fields are therefore lazy constants: only the lazy getter receives the run
// ctx, which carries the warning sink.

import type { BuiltinCtx, Value } from '../contracts';
import { NA } from '../contracts';
import { registerBuiltin, registerLazyConstant } from './registry';

/** Push `msg` at most once per run (`warnings` is the run's own array). */
function warnOnce(ctx: BuiltinCtx | undefined, msg: string): void {
  if (ctx === undefined) return;
  if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
}

/** A TV builtin that needs a data source we do not have: resolve, warn, na. */
function dataFn(ns: string, names: readonly string[], why: string): void {
  for (const name of names) {
    registerBuiltin(ns, name, (ctx): Value => {
      warnOnce(ctx, `${ns}.${name}: not supported — ${why}; returning na`);
      return NA;
    });
  }
}

/** A TV field selector that needs a data source we do not have: same contract,
 *  as a lazy constant so the warning names the exact field that was read. */
function dataField(ns: string, names: readonly string[], why: string): void {
  for (const name of names) {
    registerLazyConstant(ns, name, (ctx?: unknown): Value => {
      warnOnce(ctx as BuiltinCtx | undefined, `${ns}.${name}: not supported — ${why}; returning na`);
      return NA;
    });
  }
}

// Footprint aggregation. `footprint` / `volume_row` themselves are namespace
// roots (syntax, not values) — only the dotted members are values.
dataFn('footprint', [
  'buy_volume', 'delta', 'get_row_by_price', 'poc', 'rows',
  'sell_volume', 'total_volume', 'vah', 'val',
], 'no tick-level footprint data source is wired');
dataFn('volume_row', [
  'buy_volume', 'delta', 'down_price', 'has_buy_imbalance',
  'has_sell_imbalance', 'sell_volume', 'total_volume', 'up_price',
], 'no tick-level footprint data source is wired');

// Alternative ticker ids. These look pure, but the id each one builds is a
// data-source contract (the suffix TV's backend understands); guessing the
// format would produce an unresolvable symbol with no warning at all.
dataFn('ticker', [
  'heikinashi', 'inherit', 'kagi', 'linebreak', 'modify', 'new',
  'pointfigure', 'renko', 'standard',
], 'alternative ticker ids are not resolved by this engine');

// Field selectors for request.earnings / request.dividends / request.splits.
// Those request functions are themselves stubs (request.ts), so the selector
// only has to be honest about there being no data.
dataField('earnings', [
  'actual', 'estimate', 'future_eps', 'future_period_end_time',
  'future_revenue', 'future_time', 'standardized',
], 'no earnings data source is wired');
dataField('dividends', [
  'future_amount', 'future_ex_date', 'future_pay_date', 'gross', 'net',
], 'no dividends data source is wired');
dataField('splits', ['denominator', 'numerator'], 'no splits data source is wired');
