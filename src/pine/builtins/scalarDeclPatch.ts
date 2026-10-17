// The option-A ScalarSpec table (docs/superpowers/plans/2026-10-17-wrapeval-option-a.md).
// Declares, by dotted builtin name, the args that must arrive as a PLAIN value
// rather than a `{kind:'series'}` wrapper; `callBuiltin` applies it at the
// single funnel and keys the map by function object, so aliases share one spec
// and the JIT needs no mirror.
//
// This table is the whole declaration surface on purpose: one auditable list
// instead of the same spec repeated at ~60 `registerBuiltin` call sites.
// Imported LAST from builtins/index.ts so every module has registered first.
//
// `order` carries the family's `bindArgs` parameter list — always the same
// exported `*_ORDER` constant the implementation binds with, so the table and
// the binding cannot drift. `idx` holds slots of that list, but the funnel only
// sees the raw positional array, so a named arg claiming a lower slot shifts
// every positional after it — `order` is what lets `callBuiltin` resolve where
// a positional actually landed (reviewer finding
// R2-I1). It is declared for every entry whose `idx` is not a 0-based prefix
// (asserted by `scalar_spec_integrity.test.ts`); the remaining entries keep the
// index-equals-slot shortcut on purpose, see that test's NOT-caught list.
import { BUILTINS, SCALAR_BUILTINS } from './registry';
import type { ScalarSpec } from './registry';
import { PLOT_ORDER, SHAPE_ORDER, PLOTBAR_ORDER, PLOTCANDLE_ORDER, HLINE_ORDER } from './plot';
import { INPUT_ORDER, ENUM_ORDER } from './input';
import {
  ARRAY_BIASED_ORDER,
  ARRAY_COV_ORDER,
  ARRAY_FILL_ORDER,
  ARRAY_ID_INDEX_ORDER,
  ARRAY_ID_INDEX_VALUE_ORDER,
  ARRAY_ID_VALUE_ORDER,
  ARRAY_JOIN_ORDER,
  ARRAY_PERCENTILE_ORDER,
  ARRAY_SLICE_ORDER,
} from './array';
import { TOSTRING_ORDER, FORMAT_TIME_ORDER } from './str';

/** Dotted builtin name → args that must arrive as a plain value.
 *  Exported so `scalar_spec_integrity.test.ts` can assert that every name still
 *  resolves, that `idx` and `names` stay in lockstep, that each `idx` still
 *  points at the matching entry of its family's `bindArgs` order, that every
 *  non-prefix `idx` carries the `order` the funnel needs, and that each `order`
 *  equals its family's exported constant element-by-element. */
export const SCALAR_ARGS: Record<string, ScalarSpec> = {
  // ── array.* ──────────────────────────────────────────────────────────────
  'array.slice': { idx: [1, 2], names: ['index_from', 'index_to'], order: ARRAY_SLICE_ORDER },
  'array.fill': { idx: [2, 3], names: ['index', 'length'], order: ARRAY_FILL_ORDER },
  'array.variance': { idx: [1], names: ['biased'], order: ARRAY_BIASED_ORDER },
  'array.stdev': { idx: [1], names: ['biased'], order: ARRAY_BIASED_ORDER },
  'array.standardize': { idx: [1], names: ['biased'], order: ARRAY_BIASED_ORDER },
  'array.covariance': { idx: [2], names: ['biased'], order: ARRAY_COV_ORDER },
  'array.join': { idx: [1], names: ['separator'], order: ARRAY_JOIN_ORDER },
  'array.percentile_linear_interpolation': { idx: [1], names: ['percentage'], order: ARRAY_PERCENTILE_ORDER },
  'array.percentile_nearest_rank': { idx: [1], names: ['percentage'], order: ARRAY_PERCENTILE_ORDER },
  'array.percentrank': { idx: [1], names: ['value'], order: ARRAY_ID_VALUE_ORDER },
  'array.includes': { idx: [1], names: ['value'], order: ARRAY_ID_VALUE_ORDER },
  'array.indexof': { idx: [1], names: ['value'], order: ARRAY_ID_VALUE_ORDER },
  'array.lastindexof': { idx: [1], names: ['value'], order: ARRAY_ID_VALUE_ORDER },
  'array.binary_search': { idx: [1], names: ['value'], order: ARRAY_ID_VALUE_ORDER },
  'array.binary_search_leftmost': { idx: [1], names: ['value'], order: ARRAY_ID_VALUE_ORDER },
  'array.binary_search_rightmost': { idx: [1], names: ['value'], order: ARRAY_ID_VALUE_ORDER },
  'array.get': { idx: [1], names: ['index'], order: ARRAY_ID_INDEX_ORDER },
  'array.set': { idx: [1], names: ['index'], order: ARRAY_ID_INDEX_VALUE_ORDER },
  'array.insert': { idx: [1], names: ['index'], order: ARRAY_ID_INDEX_VALUE_ORDER },
  'array.remove': { idx: [1], names: ['index'], order: ARRAY_ID_INDEX_ORDER },
  'array.new': { idx: [0, 1], names: ['size', 'initial_value'] },
  // ── math.* ───────────────────────────────────────────────────────────────
  // math.round binds through `liftNums`, which APPENDS named args after the
  // positionals (`math.ts:100` `args.concat(namedValues(...))`) instead of
  // filling the slots bindArgs leaves free. A bindArgs `order` therefore does
  // not describe it: with `order` declared, `math.round(number = 2, close)`
  // resolved `close` to slot 1 (`precision`) and flattened args[0] — a history
  // read that must stay a series (`math.ts:129` `v.v.get(i)`), shifting
  // `ta.sma` by one bar (R3 finding I1). Without `order` the raw-index path
  // applies, which is what this family's binding actually needs.
  'math.round': { idx: [1], names: ['precision'] },
  'math.round_to_mintick': { idx: [0], names: ['number'] },
  'math.tonumber': { idx: [0], names: ['v'] },
  'math.random': { idx: [0, 1, 2], names: ['min', 'max', 'seed'] },
  // ── color.* ──────────────────────────────────────────────────────────────
  'color.rgb': { idx: [0, 1, 2], names: ['red', 'green', 'blue'] },
  'color.from_gradient': { idx: [0, 1, 2], names: ['value', 'bottom_value', 'top_value'] },
  // ── str.* ────────────────────────────────────────────────────────────────
  'str.tostring': { idx: [1], names: ['format'], order: TOSTRING_ORDER },
  'str.format': { idx: [0], names: ['template'] },
  'str.format_time': { idx: [1], names: ['format'], order: FORMAT_TIME_ORDER },
  'str.replace': { idx: [0, 1, 2], names: ['source', 'target', 'replacement'] },
  'str.replace_all': { idx: [0, 1, 2], names: ['source', 'target', 'replacement'] },
  'str.contains': { idx: [0, 1], names: ['source', 'str'] },
  'str.startswith': { idx: [0, 1], names: ['source', 'str'] },
  'str.endswith': { idx: [0, 1], names: ['source', 'str'] },
  'str.length': { idx: [0], names: ['string'] },
  'str.substring': { idx: [0, 1, 2], names: ['string', 'begin_pos', 'end_pos'] },
  'str.split': { idx: [0, 1], names: ['string', 'separator'] },
  'str.join': { idx: [0, 1], names: ['array', 'separator'] },
  'str.repeat': { idx: [0, 1], names: ['string', 'repetition'] },
  'str.lower': { idx: [0], names: ['string'] },
  'str.upper': { idx: [0], names: ['string'] },
  'str.trim': { idx: [0], names: ['string'] },
  'str.pos': { idx: [0, 1], names: ['source', 'substr'] },
  'str.match': { idx: [0, 1], names: ['source', 'regex'] },
  'str.tonumber': { idx: [0], names: ['string'] },
  // ── plot/hline/input option slots ────────────────────────────────────────
  // Positions follow each family's `bindArgs` order (reused from the module
  // that registers it, so the order has one source). Only slots read through a
  // `kind === 'na'` (or `kind === 'array'`) guard are listed — slots read via
  // `strArg`/`rawDefval` already unwrap.
  // Measured: scratch/perf/wrapA-na-ident-audit.mts.
  plot: { idx: [1, 3, 4, 11], names: ['title', 'linewidth', 'style', 'display'], order: PLOT_ORDER },
  // plotshape/plotchar `title` goes through `bound.has('title') ? strArg(…)`,
  // which unwraps on its own ⇒ only `display` would need declaring — but
  // plotchar never reads `display` (plot.ts), so only plotshape is listed.
  plotshape: { idx: [11], names: ['display'], order: SHAPE_ORDER },
  plotbar: { idx: [4, 8], names: ['title', 'display'], order: PLOTBAR_ORDER },
  plotcandle: { idx: [4, 10], names: ['title', 'display'], order: PLOTCANDLE_ORDER },
  hline: { idx: [3, 4, 6], names: ['linestyle', 'linewidth', 'display'], order: HLINE_ORDER },
  'input.int': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  'input.float': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  // scalarInput → recordAndOverride reads all seven option slots for every
  // input.* family (input.ts:115-128), so every family declares the same
  // positions — including the string/price ones, whose type does not use them
  // but whose schema still receives them when the arg is present.
  'input.string': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  'input.price': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  // ENUM_ORDER = defval, title, options, tooltip, inline, group, confirm, display, active
  'input.enum': { idx: [2, 3, 4, 5], names: ['options', 'tooltip', 'inline', 'group'], order: ENUM_ORDER },
  // Every other `input.*` registration funnels through scalarInput →
  // recordAndOverride and reads the same seven option slots (input.ts:115-128),
  // so they need the declaration too — measured 11/59 differing call points
  // with only the five typed ones declared (reviewer finding F1).
  // idx 0 (`defval`) stays undeclared on purpose: `input.source` and bare
  // `input()` inspect it as a series.
  'input.bool': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  'input.color': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  'input.timeframe': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  'input.session': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  'input.symbol': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  'input.text_area': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  'input.time': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  'input.source': { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
  input: { idx: [2, 3, 4, 5, 6, 7, 8], names: ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'], order: INPUT_ORDER },
};

let installed = 0;
for (const name of Object.keys(SCALAR_ARGS)) {
  const fn = BUILTINS.get(name);
  if (fn === undefined) {
    console.log(`scalarDeclPatch: no builtin '${name}'`);
    continue;
  }
  SCALAR_BUILTINS.set(fn, SCALAR_ARGS[name]!);
  installed++;
}
console.log(`scalarDeclPatch: ${installed} scalar specs installed`);
