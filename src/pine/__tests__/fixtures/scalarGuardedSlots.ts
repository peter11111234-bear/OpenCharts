// Fixture for scalar_spec_integrity.test.ts — the NECESSARY guarded-read set.
//
// Derivation (not a guess): the export probe is not version-controlled; its
// method and current values are recorded in docs/2026-10-17-followup-plan.md
// §2. It sweeps EVERY positional slot of every family SCALAR_ARGS declares,
// comparing a literal `na` against an `na`-bound IDENT at the SAME slot, and
// keeps the slots whose observable surface still DIFFERS once SCALAR_BUILTINS
// is CLEARED. With the table in place the same sweep reports 0 differences —
// that is the invariant this fixture guards: the declaration table must cover
// the set, which is why the assertion is one-way (declared ⊇ necessary). Extra
// declarations are allowed on purpose (`input.*` option slot 5 `options`,
// `math.tonumber[0]`, `str.format[0]`, `math.round[0]`, `plot`/`input.*` slots
// that no guard reads); never assert the reverse.
//
// Maintenance: re-derive with the probe (method in §2 of the plan) after
// changing a family's `bindArgs` order, and EXTEND this table whenever a builtin
// starts reading an argument through a `kind` test (`kind === 'na'`,
// `kind === 'array'`, `switch (v.kind)`). `GUARDED_SLOT_ORDER` below holds the
// `bindArgs` parameter lists of the guarded families that EXPORT NO ORDER
// CONSTANT — nothing to reference — so a failure can still name
// `family[slot] param` (the test reads it as the `?? GUARDED_SLOT_ORDER[family]`
// fallback, i.e. only when its FAMILY_ORDER has no order for the family).
// Families whose order IS exported resolve through the test's FAMILY_ORDER and
// are deliberately absent here: `plot`/`hline`/`input.*` (plot.ts/input.ts) and
// `array.*`/`str.tostring`/`str.format_time` (the module-qualified `*_ORDER`
// constants). The test never reads an entry whose family FAMILY_ORDER covers,
// so re-listing one only re-creates the hand-written second order list those
// constants exist to remove.

export const GUARDED_SLOT_ORDER: Record<string, readonly string[]> = {
  'array.new': ['size', 'initial_value'],
  'math.round': ['number', 'precision'],
  'math.round_to_mintick': ['number'],
  'math.random': ['min', 'max', 'seed'],
  'color.rgb': ['red', 'green', 'blue', 'transp'],
  'color.from_gradient': ['value', 'bottom_value', 'top_value', 'bottom_color', 'top_color'],
  'str.format': ['template', 'positional0', 'positional1'],
  'str.replace': ['source', 'target', 'replacement'],
  'str.replace_all': ['source', 'target', 'replacement'],
  'str.contains': ['source', 'str'],
  'str.startswith': ['source', 'str'],
  'str.endswith': ['source', 'str'],
  'str.length': ['string'],
  'str.substring': ['string', 'begin_pos', 'end_pos'],
  'str.split': ['string', 'separator'],
  'str.join': ['array', 'separator'],
  'str.repeat': ['string', 'repetition'],
  'str.lower': ['string'],
  'str.upper': ['string'],
  'str.trim': ['string'],
  'str.pos': ['source', 'substr'],
  'str.match': ['source', 'regex'],
};

export const GUARDED_SLOTS: Record<string, readonly string[]> = {
  'array.new': ['initial_value'],
  'array.slice': ['index_to'],
  'array.fill': ['length'],
  'array.variance': ['biased'],
  'array.stdev': ['biased'],
  'array.standardize': ['biased'],
  'array.covariance': ['biased'],
  'array.join': ['separator'],
  'array.percentile_linear_interpolation': ['percentage'],
  'array.percentile_nearest_rank': ['percentage'],
  'math.round': ['precision'],
  'math.round_to_mintick': ['number'],
  'math.random': ['max', 'seed'],
  'color.rgb': ['red', 'green', 'blue'],
  'color.from_gradient': ['value', 'bottom_value', 'top_value'],
  'str.format': ['template'],
  'str.format_time': ['format'],
  'str.replace': ['source', 'target', 'replacement'],
  'str.replace_all': ['source', 'target', 'replacement'],
  'str.contains': ['source', 'str'],
  'str.startswith': ['source', 'str'],
  'str.endswith': ['source', 'str'],
  'str.length': ['string'],
  'str.substring': ['string', 'begin_pos', 'end_pos'],
  'str.split': ['string', 'separator'],
  'str.join': ['array', 'separator'],
  'str.repeat': ['string', 'repetition'],
  'str.lower': ['string'],
  'str.upper': ['string'],
  'str.trim': ['string'],
  'str.pos': ['source', 'substr'],
  'str.match': ['source', 'regex'],
  'plot': ['title', 'linewidth', 'style', 'display'],
  'plotshape': ['display'],
  'plotbar': ['title', 'display'],
  'plotcandle': ['title', 'display'],
  'hline': ['linestyle', 'linewidth', 'display'],
  'input.int': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.float': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.price': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.bool': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.string': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.color': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.timeframe': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.session': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.symbol': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.text_area': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.time': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.source': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input': ['minval', 'maxval', 'step', 'group', 'inline', 'tooltip'],
  'input.enum': ['tooltip', 'inline', 'group'],
};
