// ── Drawing builtins ────────────────────────────────────────────────────────
// line.* / label.* / box.* / table.* against the DrawSink in ctx.drawings[0].
// Live objects are mirrored into ctx.live{Lines,Labels,Boxes,Tables} which back
// the `*.all` constants. `*.new` returns a typed Value wrapping the DrawObj.
//
// DrawObj.props holds plain JS values (numbers/strings/booleans). Props are
// declared per kind in PROP_TABLES below; `set_*`/`get_*` builtins are
// generated from those tables so naming stays consistent.

import type { Arg, BuiltinCtx, DrawObj, DrawSink, Node, Value } from '../contracts';
import { NA } from '../contracts';
import { registerBuiltin, registerConstant, registerLazyConstant } from './registry';
import {
  RtCtx, bindArgs, bindDeclArgs, truthy, asNum, asNumOrNa, asStr, asColor, strArg,
  numArg, naCoordArg, colorArg, numVal, boolArg, warnOnce, unwrapped,
} from './util';

// ── Enum constants ──────────────────────────────────────────────────────────

function enumSet(ns: string, names: readonly string[]): void {
  for (const n of names) registerConstant(ns, n, { kind: 'string', v: `${ns}.${n}` });
}

enumSet('line', [
  'style_solid', 'style_dashed', 'style_dotted',
  'style_arrow_left', 'style_arrow_right', 'style_arrow_both',
]);
enumSet('hline', ['style_solid', 'style_dashed', 'style_dotted']);
enumSet('label', [
  'style_none', 'style_xcross', 'style_cross', 'style_triangleup',
  'style_triangledown', 'style_flag', 'style_circle', 'style_square',
  'style_diamond', 'style_arrowup', 'style_arrowdown', 'style_label_up',
  'style_label_down', 'style_label_left', 'style_label_right',
  'style_label_lower_left', 'style_label_lower_right',
  'style_label_upper_left', 'style_label_upper_right', 'style_label_center',
  'style_label_outline', 'style_text_outline',
]);
enumSet('text', [
  'align_left', 'align_center', 'align_right',
  'align_top', 'align_bottom',
  'format_bold', 'format_italic', 'format_none',
  'wrap_auto', 'wrap_none',
  'format_mintick', 'format_percent', 'format_volume', 'format_inherit',
]);
enumSet('font', ['family_default', 'family_monospace']);
enumSet('chart', ['point_standard', 'point_sensitive', 'point_highres']);
registerConstant('chart', 'fg_color', { kind: 'string', v: 'chart.fg_color' });

// ── Sink + live-object plumbing ─────────────────────────────────────────────

/** Recording DrawSink fallback — used when the engine didn't provide one. */
function recordingSink(): DrawSink & { objs: DrawObj[]; nextId: number } {
  const sink: DrawSink & { objs: DrawObj[]; nextId: number } = {
    objs: [],
    nextId: 1,
    create(kind, props) {
      const obj: DrawObj = { id: sink.nextId++, kind, props: { ...props } };
      sink.objs.push(obj);
      return obj;
    },
    update(obj, props) { Object.assign(obj.props, props); },
    remove(obj) {
      const i = sink.objs.indexOf(obj);
      if (i >= 0) sink.objs.splice(i, 1);
    },
  };
  return sink;
}

function drawSink(ctx: RtCtx): DrawSink {
  if (ctx.drawings.length === 0) ctx.drawings.push(recordingSink());
  return ctx.drawings[0]!;
}

function liveArr(ctx: RtCtx, kind: 'line' | 'label' | 'box' | 'table' | 'polyline' | 'linefill'): DrawObj[] {
  switch (kind) {
    case 'line': return ctx.liveLines ??= [];
    case 'label': return ctx.liveLabels ??= [];
    case 'box': return ctx.liveBoxes ??= [];
    case 'polyline': return ctx.livePolylines ??= [];
    case 'linefill': return ctx.liveLinefills ??= [];
    default: return ctx.liveTables ??= [];
  }
}

// ── Drawing quotas (TV max_*_count) ──
// TV auto-deletes the oldest objects of a kind once the live count exceeds the
// declared limit (default 50). Quotas come from the indicator()/strategy()
// declaration via declDrawQuotas → ctx.declQuotas. Linefills draw from the
// `lines` pool — TV has no separate linefill limit.

const DEFAULT_QUOTA = 50;

const QUOTA_KEY: Record<'line' | 'label' | 'box' | 'table' | 'polyline' | 'linefill', 'lines' | 'labels' | 'boxes' | 'tables' | 'polylines'> = {
  line: 'lines',
  label: 'labels',
  box: 'boxes',
  table: 'tables',
  polyline: 'polylines',
  linefill: 'lines',
};

/** Create a drawing, mirror it live, and evict the oldest beyond the quota. */
function created(ctx: RtCtx, kind: 'line' | 'label' | 'box' | 'table' | 'polyline' | 'linefill', props: Record<string, unknown>): DrawObj {
  const obj = drawSink(ctx).create(kind, props);
  const live = liveArr(ctx, kind);
  live.push(obj);
  const quota = ctx.declQuotas?.[QUOTA_KEY[kind]] ?? DEFAULT_QUOTA;
  while (live.length > quota) {
    const old = live[0]!;
    live.shift();
    if (old !== obj) drawSink(ctx).remove(old);
  }
  return obj;
}


/** Numeric literal from a decl arg node (num / unary-minus num), else undefined. */
function declNum(n: Node | undefined): number | undefined {
  if (n?.type === 'num') return n.v;
  if (n?.type === 'unary' && n.op === '-' && n.arg.type === 'num') return -n.arg.v;
  return undefined;
}

/** Pine **v6** indicator() signature order (positional binding) — name set and
 *  order come from docs/tv-pine-stdlib.json:
 *    indicator(title, shorttitle, overlay, format, precision, scale,
 *              max_bars_back, timeframe, timeframe_gaps, explicit_plot_zorder,
 *              max_lines_count, max_labels_count, max_boxes_count,
 *              calc_bars_count, max_polylines_count, dynamic_requests,
 *              behind_chart)
 *  v5-only names (linktoseries, max_tables_count, calc_chart_luminosity_order,
 *  max_circles_count, backtest_fill_limits_assumption) are dropped: TV v6
 *  rejects them, so binding them into a slot would be a silent divergence.
 *  `dynamic_requests` needs no warning — this engine always allows dynamic
 *  requests (see handoff §9.2.F) — and `behind_chart` is layer metadata. */
export const INDICATOR_DECL_ORDER = [
  'title', 'shorttitle', 'overlay', 'format', 'precision', 'scale',
  'max_bars_back', 'timeframe', 'timeframe_gaps', 'explicit_plot_zorder',
  'max_lines_count', 'max_labels_count', 'max_boxes_count', 'calc_bars_count',
  'max_polylines_count', 'dynamic_requests', 'behind_chart',
] as const;

/** `indicator()` parameters that carry behaviour this interpreter does not
 *  implement. The quota parameters (max_lines/labels/boxes/tables/polylines_count)
 *  ARE consumed by declDrawQuotas and display metadata is harmless, so only the
 *  ones that would change results or drawing capacity are listed. */
export const INDICATOR_UNSUPPORTED_PARAMS = [
  'max_bars_back', 'timeframe', 'timeframe_gaps', 'calc_bars_count',
] as const;

/** Report the declared-but-unimplemented `indicator()` parameters once per run. */
export function warnUnsupportedIndicatorParams(ctx: BuiltinCtx, args: Arg[] | undefined): void {
  const bound = bindDeclArgs(args, INDICATOR_DECL_ORDER);
  const ignored = INDICATOR_UNSUPPORTED_PARAMS.filter((n) => bound.has(n));
  if (ignored.length === 0) return;
  warnOnce(ctx, 'indicator|unsupported',
    `indicator(): ${ignored.map((n) => `'${n}'`).join(', ')} declared but not implemented — the run ignores ${ignored.length > 1 ? 'them' : 'it'}`);
}

/**
 * Read max_lines_count/max_labels_count/max_boxes_count from an indicator() /
 * strategy() decl's args into ctx.declQuotas. `order` is the decl's Pine
 * signature order for positional binding (INDICATOR_DECL_ORDER or
 * STRATEGY_DECL_ORDER from strategy.ts).
 */
export function declDrawQuotas(ctx: BuiltinCtx, args: Arg[] | undefined, order: readonly string[]): void {
  const bound = bindDeclArgs(args, order);
  const rt = ctx as RtCtx;
  const q = rt.declQuotas ??= {};
  const lines = declNum(bound.get('max_lines_count'));
  if (lines !== undefined) q.lines = lines;
  const labels = declNum(bound.get('max_labels_count'));
  if (labels !== undefined) q.labels = labels;
  const boxes = declNum(bound.get('max_boxes_count'));
  if (boxes !== undefined) q.boxes = boxes;
  const tables = declNum(bound.get('max_tables_count'));
  if (tables !== undefined) q.tables = tables;
  const polylines = declNum(bound.get('max_polylines_count'));
  if (polylines !== undefined) q.polylines = polylines;
}

/** Obj arg → DrawObj; narrows on the typed drawing Value kinds. evalArg wraps
 *  every arg in a per-callsite BarSeries — unwrap before switching on kind. */
function asObj(v: Value | undefined): DrawObj | undefined {
  if (v?.kind === 'series') return asObj(v.v.cur());
  switch (v?.kind) {
    case 'line': case 'label': case 'box': case 'table':
    case 'polyline': case 'linefill':
      return v.v;
    default:
      return undefined;
  }
}

type PropType = 'num' | 'coord' | 'str' | 'bool';

/** `na` handling differs by prop type. `num` is a count/size/width whose TV
 *  default really is 0, so na still coerces. `coord` is an x/y coordinate: na
 *  means "not drawn" (TradingView), and coercing it to 0 parks the object on
 *  bar 0 / price 0 — Vela folds a visible drawing's price into the price-pane
 *  autoscale, so one na coordinate yanks the axis floor to 0 and squashes every
 *  candle. Keep na as `undefined`; the engine drops the object instead. */
function coerceIn(v: Value | undefined, t: PropType): number | string | boolean | undefined {
  // evalArg may hand this over as `{kind:'series'}` (a bare ident, a literal, or
  // a history-requiring expr). Unwrap first: the `kind === 'na'` guard below
  // would otherwise miss and the `str` path would store the literal text 'NaN'.
  const u = unwrapped(v);
  if (t === 'coord') return u === undefined ? undefined : asNumOrNa(u);
  if (u === undefined || u.kind === 'na') return t === 'num' ? 0 : t === 'bool' ? false : '';
  if (t === 'num') return asNum(u);
  if (t === 'bool') return truthy(u);
  return u.kind === 'color' ? asColor(u) : asStr(u);
}

function coerceOut(raw: unknown, t: PropType): Value {
  if (raw === undefined || raw === null) return NA;
  if (t === 'num' || t === 'coord') return numVal(Number(raw));
  if (t === 'bool') return raw ? { kind: 'bool', v: true } : { kind: 'bool', v: false };
  return { kind: 'string', v: String(raw) };
}

// Coordinate props are `coord` (na stays na — see coerceIn); every other numeric
// prop is a size/width/count whose default is genuinely 0.
const PROP_TABLES: Record<string, Record<string, PropType>> = {
  line: {
    x1: 'coord', y1: 'coord', x2: 'coord', y2: 'coord',
    xloc: 'str', extend: 'str', color: 'str', style: 'str', width: 'num',
  },
  label: {
    x: 'coord', y: 'coord', text: 'str', xloc: 'str', yloc: 'str',
    color: 'str', style: 'str', textcolor: 'str', size: 'str',
    textalign: 'str', tooltip: 'str',
    text_font_family: 'str', text_formatting: 'str',
  },
  box: {
    left: 'coord', top: 'coord', right: 'coord', bottom: 'coord',
    border_color: 'str', border_width: 'num', border_style: 'str',
    extend: 'str', xloc: 'str', bgcolor: 'str',
    text: 'str', text_size: 'str', text_color: 'str',
    text_halign: 'str', text_valign: 'str', text_wrap: 'str',
    text_font_family: 'str', text_formatting: 'str',
  },
  // TV exposes set_* only; the generated get_* are a harmless superset.
  table: {
    position: 'str', bgcolor: 'str', border_color: 'str', border_width: 'num',
    frame_color: 'str', frame_width: 'num',
  },
};
// NOTE: 'xloc' setters generated here for line/label/box are OVERWRITTEN later
// by hand-rolled set_xloc (TV multi-arg signature writes coords too). The
// override depends on registration order — keep table entries as-is.

for (const [kind, table] of Object.entries(PROP_TABLES)) {
  // TV's first parameter is `id` for line/label/box/linefill/polyline and
  // `table_id` for table (KB: line.set_color(id, color), table.set_bgcolor(table_id, …)).
  // Declare the reference name so `id=` / `table_id=` bind; the undocumented
  // `line_id=` / `table=` spellings now report an unknown named argument, which
  // is what TV does with them. Order is built once per registration, not per call.
  const idName = kind === 'table' ? 'table_id' : 'id';
  const idOrder: readonly string[] = [idName];
  for (const [prop, t] of Object.entries(table)) {
    const order: readonly string[] = [idName, prop];
    registerBuiltin(kind, `set_${prop}`, (c, args, named) => {
      const bound = bindArgs(args, named, order);
      const obj = asObj(bound.get(idName));
      if (obj) {
        const p = { [prop]: coerceIn(bound.get(prop), t) };
        drawSink(c as RtCtx).update(obj, p);
      }
      return { kind: 'void' };
    });
    // TV exposes set_* only; the generated getters are a harmless superset, but
    // they must bind the same reference name — `line.get_color(id = l)` used to
    // read args[0] (undefined) and return na without a message.
    registerBuiltin(kind, `get_${prop}`, (_c, args, named) => {
      const obj = asObj(bindArgs(args, named, idOrder).get(idName));
      return obj ? coerceOut(obj.props[prop], t) : NA;
    });
  }
}

// ── line ────────────────────────────────────────────────────────────────────

registerBuiltin('line', 'new', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, [
    'x1', 'y1', 'x2', 'y2', 'xloc', 'extend', 'color', 'style', 'width',
    'force_overlay',
  ] as const);
  const props: Record<string, unknown> = {
    // Coordinates keep `na`: an na endpoint means "not drawn" (TradingView) — `numArg`'s
    // 0 default parked the line at price 0 and collapsed the chart's price axis.
    x1: naCoordArg(bound, 'x1'), y1: naCoordArg(bound, 'y1'),
    x2: naCoordArg(bound, 'x2'), y2: naCoordArg(bound, 'y2'),
    xloc: strArg(bound, 'xloc', 'xloc.bar_index'),
    extend: strArg(bound, 'extend', 'extend.none'),
    // Absent → TV default blue; explicit color=na → invisible (engine flag).
    color: bound.has('color') ? colorArg(bound, 'color') : '#2962FF',
    style: strArg(bound, 'style', 'line.style_solid'),
    width: numArg(bound, 'width', 1),
  };
  // Upstream: constructor-only, no set_force_overlay. Omit the key when
  // unset — `undefined` serializes to null and diffs against goldens.
  if (bound.has('force_overlay')) props.force_overlay = boolArg(bound, 'force_overlay', false);
  const obj = created(ctx, 'line', props);
  return { kind: 'line', v: obj };
});

registerBuiltin('line', 'set_xy1', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, { x1: asNumOrNa(args[1] ?? NA), y1: asNumOrNa(args[2] ?? NA) });
  return { kind: 'void' };
});
registerBuiltin('line', 'set_xy2', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, { x2: asNumOrNa(args[1] ?? NA), y2: asNumOrNa(args[2] ?? NA) });
  return { kind: 'void' };
});
registerBuiltin('line', 'set_first_point', (c, args) => {
  const obj = asObj(args[0]);
  const p = pointXY(unwrapped(args[1]), String(obj?.props.xloc ?? 'xloc.bar_index'));
  if (obj && p) drawSink(c as RtCtx).update(obj, { x1: p.x, y1: p.y });
  return { kind: 'void' };
});
registerBuiltin('line', 'set_second_point', (c, args) => {
  const obj = asObj(args[0]);
  const p = pointXY(unwrapped(args[1]), String(obj?.props.xloc ?? 'xloc.bar_index'));
  if (obj && p) drawSink(c as RtCtx).update(obj, { x2: p.x, y2: p.y });
  return { kind: 'void' };
});
// TV signature (id, x1, x2, xloc) — writes both endpoints too; overrides the
// prop-table generated setter which only stored xloc. Coordinates keep `na`.
registerBuiltin('line', 'set_xloc', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, {
    x1: asNumOrNa(args[1] ?? NA), x2: asNumOrNa(args[2] ?? NA), xloc: asStr(args[3] ?? NA),
  });
  return { kind: 'void' };
});

registerBuiltin('line', 'get_price', (c, args) => {
  const ctx = c as RtCtx;
  const obj = asObj(args[0]);
  if (!obj) return NA;
  const barIndex = args[1] !== undefined ? asNumOrNa(args[1]) : ctx.barIndex;
  // A line with an `na` coordinate is not drawn; TV returns `na` from get_price
  // too. The old `|| 0` turned both into price 0 and a script that plots the
  // result fed that 0 straight into the price-pane autoscale.
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const x1 = num(obj.props.x1), y1 = num(obj.props.y1);
  const x2 = num(obj.props.x2), y2 = num(obj.props.y2);
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return NA;
  if (typeof barIndex !== 'number' || !Number.isFinite(barIndex)) return NA;
  const price = x2 === x1 ? y1 : y1 + ((y2 - y1) * (barIndex - x1)) / (x2 - x1);
  return numVal(price);
});

registerBuiltin('line', 'delete', (c, args) => {
  const ctx = c as RtCtx;
  const obj = asObj(args[0]);
  if (obj) {
    drawSink(ctx).remove(obj);
    const live = liveArr(ctx, 'line');
    const i = live.indexOf(obj);
    if (i >= 0) live.splice(i, 1);
  }
  return { kind: 'void' };
});

// TV clones the drawing: the result is a NEW live object (it counts against the
// kind's quota) carrying the source's current properties.
registerBuiltin('line', 'copy', (c, args) => {
  const obj = asObj(args[0]);
  return obj ? { kind: 'line', v: created(c as RtCtx, 'line', { ...obj.props }) } : NA;
});

// ── label ───────────────────────────────────────────────────────────────────

registerBuiltin('label', 'new', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, [
    'x', 'y', 'text', 'xloc', 'yloc', 'color', 'style',
    'textcolor', 'size', 'textalign', 'tooltip',
    // Upstream order: text_font_family, force_overlay, text_formatting.
    'text_font_family', 'force_overlay', 'text_formatting',
  ] as const);
  const props: Record<string, unknown> = {
    // na coordinate → not drawn (see line.new above).
    x: naCoordArg(bound, 'x'), y: naCoordArg(bound, 'y'),
    text: strArg(bound, 'text', ''),
    xloc: strArg(bound, 'xloc', 'xloc.bar_index'),
    yloc: strArg(bound, 'yloc', 'yloc.price'),
    color: colorArg(bound, 'color'),
    style: strArg(bound, 'style', 'label.style_label_up'),
    textcolor: colorArg(bound, 'textcolor'),
    size: strArg(bound, 'size', 'size.normal'),
    textalign: strArg(bound, 'textalign', 'text.align_left'),
  };
  // Stored-only fields (no downstream reader yet) and constructor-only
  // force_overlay — omit keys when unset; `undefined` diffs against goldens.
  if (bound.has('tooltip')) props.tooltip = strArg(bound, 'tooltip', '');
  if (bound.has('text_font_family')) props.text_font_family = strArg(bound, 'text_font_family', 'font.family_default');
  if (bound.has('text_formatting')) props.text_formatting = strArg(bound, 'text_formatting', 'format.none');
  if (bound.has('force_overlay')) props.force_overlay = boolArg(bound, 'force_overlay', false);
  const obj = created(ctx, 'label', props);
  return { kind: 'label', v: obj };
});

registerBuiltin('label', 'set_xy', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, { x: asNumOrNa(args[1] ?? NA), y: asNumOrNa(args[2] ?? NA) });
  return { kind: 'void' };
});
registerBuiltin('label', 'set_point', (c, args) => {
  const obj = asObj(args[0]);
  const p = pointXY(unwrapped(args[1]), String(obj?.props.xloc ?? 'xloc.bar_index'));
  if (obj && p) drawSink(c as RtCtx).update(obj, { x: p.x, y: p.y });
  return { kind: 'void' };
});
// TV signature (id, x, xloc) — also writes the coordinate; overrides the
// prop-table generated setter which only stored xloc.
registerBuiltin('label', 'set_xloc', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, { x: asNumOrNa(args[1] ?? NA), xloc: asStr(args[2] ?? NA) });
  return { kind: 'void' };
});

registerBuiltin('label', 'delete', (c, args) => {
  const ctx = c as RtCtx;
  const obj = asObj(args[0]);
  if (obj) {
    drawSink(ctx).remove(obj);
    const live = liveArr(ctx, 'label');
    const i = live.indexOf(obj);
    if (i >= 0) live.splice(i, 1);
  }
  return { kind: 'void' };
});

// New live label carrying the source's properties (see line.copy).
registerBuiltin('label', 'copy', (c, args) => {
  const obj = asObj(args[0]);
  return obj ? { kind: 'label', v: created(c as RtCtx, 'label', { ...obj.props }) } : NA;
});

// ── box ─────────────────────────────────────────────────────────────────────

registerBuiltin('box', 'new', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, [
    // TV order: (left, top, right, bottom, xloc, extend, border_color, …)
    'left', 'top', 'right', 'bottom', 'xloc', 'extend', 'border_color',
    'border_width', 'border_style', 'bgcolor', 'text', 'text_size',
    'text_color', 'text_halign', 'text_valign', 'text_wrap',
    // Upstream ends: text_font_family, force_overlay — box.new has NO
    // text_formatting ctor param (set_text_formatting accessor only).
    'text_font_family', 'force_overlay',
  ] as const);
  const props: Record<string, unknown> = {
    // na coordinate → not drawn (see line.new above).
    left: naCoordArg(bound, 'left'), top: naCoordArg(bound, 'top'),
    right: naCoordArg(bound, 'right'), bottom: naCoordArg(bound, 'bottom'),
    border_color: colorArg(bound, 'border_color') ?? '#2962FF',
    border_width: numArg(bound, 'border_width', 1),
    border_style: strArg(bound, 'border_style', 'line.style_solid'),
    extend: strArg(bound, 'extend', 'extend.none'),
    xloc: strArg(bound, 'xloc', 'xloc.bar_index'),
    bgcolor: colorArg(bound, 'bgcolor'),
    text: strArg(bound, 'text', ''),
    text_size: strArg(bound, 'text_size', 'size.normal'),
    text_color: colorArg(bound, 'text_color'),
    text_halign: strArg(bound, 'text_halign', 'text.align_left'),
    text_valign: strArg(bound, 'text_valign', 'text.align_center'),
    text_wrap: strArg(bound, 'text_wrap', 'text.wrap_none'),
  };
  if (bound.has('text_font_family')) props.text_font_family = strArg(bound, 'text_font_family', 'font.family_default');
  if (bound.has('force_overlay')) props.force_overlay = boolArg(bound, 'force_overlay', false);
  const obj = created(ctx, 'box', props);
  return { kind: 'box', v: obj };
});

registerBuiltin('box', 'set_lefttop', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, { left: asNumOrNa(args[1] ?? NA), top: asNumOrNa(args[2] ?? NA) });
  return { kind: 'void' };
});
registerBuiltin('box', 'set_rightbottom', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, { right: asNumOrNa(args[1] ?? NA), bottom: asNumOrNa(args[2] ?? NA) });
  return { kind: 'void' };
});
registerBuiltin('box', 'set_top_left_point', (c, args) => {
  const obj = asObj(args[0]);
  const p = pointXY(unwrapped(args[1]), String(obj?.props.xloc ?? 'xloc.bar_index'));
  if (obj && p) drawSink(c as RtCtx).update(obj, { left: p.x, top: p.y });
  return { kind: 'void' };
});
registerBuiltin('box', 'set_bottom_right_point', (c, args) => {
  const obj = asObj(args[0]);
  const p = pointXY(unwrapped(args[1]), String(obj?.props.xloc ?? 'xloc.bar_index'));
  if (obj && p) drawSink(c as RtCtx).update(obj, { right: p.x, bottom: p.y });
  return { kind: 'void' };
});
// TV signature (id, left, right, xloc) — writes both edges too; overrides the
// prop-table generated setter which only stored xloc.
registerBuiltin('box', 'set_xloc', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, {
    left: asNumOrNa(args[1] ?? NA), right: asNumOrNa(args[2] ?? NA), xloc: asStr(args[3] ?? NA),
  });
  return { kind: 'void' };
});

registerBuiltin('box', 'delete', (c, args) => {
  const ctx = c as RtCtx;
  const obj = asObj(args[0]);
  if (obj) {
    drawSink(ctx).remove(obj);
    const live = liveArr(ctx, 'box');
    const i = live.indexOf(obj);
    if (i >= 0) live.splice(i, 1);
  }
  return { kind: 'void' };
});

// New live box carrying the source's properties (see line.copy).
registerBuiltin('box', 'copy', (c, args) => {
  const obj = asObj(args[0]);
  return obj ? { kind: 'box', v: created(c as RtCtx, 'box', { ...obj.props }) } : NA;
});

// ── table ───────────────────────────────────────────────────────────────────

interface CellProps { text: string; [k: string]: unknown }

function cellsOf(obj: DrawObj): Map<string, CellProps> {
  const existing = obj.props.cells;
  // `cells` is ours only — but guard anyway in case props get serialized.
  if (existing instanceof Map) return existing as Map<string, CellProps>;
  const cells = new Map<string, CellProps>();
  obj.props.cells = cells;
  return cells;
}

registerBuiltin('table', 'new', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, [
    'position', 'columns', 'rows', 'bgcolor',
    'frame_color', 'frame_width', 'border_color', 'border_width',
    'force_overlay',
  ] as const);
  const props: Record<string, unknown> = {
    position: strArg(bound, 'position', 'position.top_center'),
    // Clamp grid size — engine allocates columns×rows eagerly.
    columns: Math.max(0, Math.min(100, Math.trunc(numArg(bound, 'columns', 1)))),
    rows: Math.max(0, Math.min(100, Math.trunc(numArg(bound, 'rows', 1)))),
    bgcolor: colorArg(bound, 'bgcolor'),
    frame_color: colorArg(bound, 'frame_color'),
    frame_width: numArg(bound, 'frame_width', 0),
    border_color: colorArg(bound, 'border_color'),
    border_width: numArg(bound, 'border_width', 0),
  };
  if (bound.has('force_overlay')) props.force_overlay = boolArg(bound, 'force_overlay', false);
  const obj = created(ctx, 'table', props);
  return { kind: 'table', v: obj };
});

registerBuiltin('table', 'cell', (c, args, named) => {
  const bound = bindArgs(args, named, [
    'table_id', 'column', 'row', 'text', 'width', 'height', 'text_color',
    'text_halign', 'text_valign', 'text_size', 'bgcolor', 'tooltip',
    'text_font_family', 'text_formatting',
  ] as const);
  const obj = asObj(bound.get('table_id') ?? bound.get('table'));
  if (!obj) return { kind: 'void' };
  const col = Math.trunc(numArg(bound, 'column', 0));
  const row = Math.trunc(numArg(bound, 'row', 0));
  if (col < 0 || row < 0) return { kind: 'void' }; // no negative-cell dead entries
  const cell: CellProps = { text: strArg(bound, 'text', '') };
  const textColor = colorArg(bound, 'text_color');
  if (textColor !== undefined) cell.text_color = textColor;
  const bg = colorArg(bound, 'bgcolor');
  if (bg !== undefined) cell.bgcolor = bg;
  if (bound.has('width')) cell.width = numArg(bound, 'width', 0);
  if (bound.has('height')) cell.height = numArg(bound, 'height', 0);
  if (bound.has('text_halign')) cell.text_halign = strArg(bound, 'text_halign', 'text.align_left');
  if (bound.has('text_valign')) cell.text_valign = strArg(bound, 'text_valign', 'text.align_center');
  if (bound.has('text_size')) cell.text_size = strArg(bound, 'text_size', 'size.normal');
  if (bound.has('tooltip')) cell.tooltip = strArg(bound, 'tooltip', '');
  if (bound.has('text_font_family')) cell.text_font_family = strArg(bound, 'text_font_family', 'font.family_default');
  if (bound.has('text_formatting')) cell.text_formatting = strArg(bound, 'text_formatting', 'format.none');
  cellsOf(obj).set(`${col},${row}`, cell);
  drawSink(c as RtCtx).update(obj, {});
  return { kind: 'void' };
});

registerBuiltin('table', 'merge_cells', (c, args, named) => {
  const bound = bindArgs(args, named, [
    'table_id', 'start_column', 'start_row', 'end_column', 'end_row',
  ] as const);
  const obj = asObj(bound.get('table_id') ?? bound.get('table'));
  if (!obj) return { kind: 'void' };
  const merges = (obj.props.merges ??= [] as unknown[]) as { c1: number; r1: number; c2: number; r2: number }[];
  merges.push({
    c1: numArg(bound, 'start_column', 0), r1: numArg(bound, 'start_row', 0),
    c2: numArg(bound, 'end_column', 0), r2: numArg(bound, 'end_row', 0),
  });
  drawSink(c as RtCtx).update(obj, {});
  return { kind: 'void' };
});

registerBuiltin('table', 'clear', (_c, args, named) => {
  const bound = bindArgs(args, named, [
    'table_id', 'start_column', 'start_row', 'end_column', 'end_row',
  ] as const);
  const obj = asObj(bound.get('table_id') ?? bound.get('table'));
  if (!obj) return { kind: 'void' };
  const cells = cellsOf(obj);
  if (!bound.has('start_column')) { cells.clear(); return { kind: 'void' }; }
  const c1 = numArg(bound, 'start_column', 0);
  const r1 = numArg(bound, 'start_row', 0);
  const c2 = numArg(bound, 'end_column', c1);
  const r2 = numArg(bound, 'end_row', r1);
  const doomed: string[] = [];
  cells.forEach((_v, key) => {
    const [cc, rr] = key.split(',').map(Number);
    if (cc! >= c1 && cc! <= c2 && rr! >= r1 && rr! <= r2) doomed.push(key);
  });
  for (const key of doomed) cells.delete(key);
  return { kind: 'void' };
});

// ── table.cell_set_* — mutate an existing cell in place ──────────────────────

const cellSetter = (key: string, coerce: (v: Value) => unknown) =>
  registerBuiltin('table', `cell_set_${key}`, (c, args, named) => {
    const bound = bindArgs(args, named, ['table_id', 'column', 'row', key] as const);
    const obj = asObj(bound.get('table_id') ?? bound.get('table'));
    if (!obj) return { kind: 'void' };
    const col = Math.trunc(numArg(bound, 'column', 0)), row = Math.trunc(numArg(bound, 'row', 0));
    if (col < 0 || row < 0) return { kind: 'void' }; // out-of-grid write: no dead cell
    const cell = cellsOf(obj).get(`${col},${row}`) ?? { text: '' };
    (cell as Record<string, unknown>)[key] = coerce(bound.get(key) ?? NA);
    cellsOf(obj).set(`${col},${row}`, cell);
    drawSink(c as RtCtx).update(obj, {});
    return { kind: 'void' };
  });
cellSetter('text', v => asStr(v));
cellSetter('text_color', v => asColor(v));
cellSetter('text_size', v => asStr(v));
cellSetter('bgcolor', v => asColor(v));
cellSetter('tooltip', v => asStr(v));
cellSetter('text_halign', v => asStr(v));
cellSetter('text_valign', v => asStr(v));
cellSetter('width', v => asNum(v));
cellSetter('height', v => asNum(v));
cellSetter('text_font_family', v => asStr(v));
cellSetter('text_formatting', v => asStr(v));

registerBuiltin('table', 'delete', (c, args) => {
  const ctx = c as RtCtx;
  const obj = asObj(args[0]);
  if (obj) {
    drawSink(ctx).remove(obj);
    const live = liveArr(ctx, 'table');
    const i = live.indexOf(obj);
    if (i >= 0) live.splice(i, 1);
  }
  return { kind: 'void' };
});

// ── chart.point — polyline vertices ─────────────────────────────────────────
// A point is a UDT instance { time, index, price }; xloc picks which x the
// engine reads. `chart.point.new(...)` dispatches through the flattened
// member-call path (interpreter joins the dotted chain before BUILTINS lookup).

const chartPoint = (time: Value | undefined, index: Value | undefined, price: Value | undefined): Value => {
  const fields = new Map<string, Value>();
  fields.set('time', time ?? NA);
  fields.set('index', index ?? NA);
  fields.set('price', price ?? NA);
  return { kind: 'udt', v: { typeName: 'chart.point', fields } };
};

registerBuiltin('chart.point', 'new', (_c, args, named) => {
  const bound = bindArgs(args, named, ['time', 'index', 'price'] as const);
  return chartPoint(unwrapped(bound.get('time')), unwrapped(bound.get('index')), unwrapped(bound.get('price')));
});
registerBuiltin('chart.point', 'from_index', (_c, args, named) => {
  const bound = bindArgs(args, named, ['index', 'price'] as const);
  return chartPoint(undefined, unwrapped(bound.get('index')), unwrapped(bound.get('price')));
});
registerBuiltin('chart.point', 'from_time', (_c, args, named) => {
  const bound = bindArgs(args, named, ['time', 'price'] as const);
  return chartPoint(unwrapped(bound.get('time')), undefined, unwrapped(bound.get('price')));
});
registerBuiltin('chart.point', 'now', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, ['price'] as const);
  const t = ctx.time.cur();
  return chartPoint(t, numVal(ctx.barIndex), unwrapped(bound.get('price')));
});
registerBuiltin('chart.point', 'copy', (_c, args) => {
  const p = unwrapped(args[0]);
  // Reject non-chart.point udt — copying Foo{time,index,price} must not
  // launder a foreign type into a genuine chart.point.
  if (p?.kind !== 'udt' || p.v.typeName !== 'chart.point') return NA;
  return chartPoint(p.v.fields.get('time'), p.v.fields.get('index'), p.v.fields.get('price'));
});

/** chart.point udt → {x,y} pair honoring the drawing's xloc. Rejects other
 *  UDTs — a Foo{index,price} is not a chart.point (review: typeName check). */
const pointXY = (p: Value | undefined, xloc: string): { x: number; y: number } | undefined => {
  if (p?.kind !== 'udt' || p.v.typeName !== 'chart.point') return undefined;
  const num = (k: string): number | undefined => {
    const v = p.v.fields.get(k);
    return v !== undefined && (v.kind === 'int' || v.kind === 'float') ? v.v : undefined;
  };
  const x = xloc === 'xloc.bar_time' ? num('time') : num('index');
  const y = num('price');
  return x === undefined || y === undefined ? undefined : { x, y };
};

// ── polyline ────────────────────────────────────────────────────────────────

registerBuiltin('polyline', 'new', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, [
    'points', 'curved', 'closed', 'xloc', 'line_color', 'fill_color',
    'line_style', 'line_width', 'force_overlay',
  ] as const);
  const arr = unwrapped(bound.get('points'));
  const xloc = strArg(bound, 'xloc', 'xloc.bar_index');
  const pts: { x: number; y: number }[] = [];
  if (arr?.kind === 'array') {
    for (const el of arr.v) {
      const p = pointXY(unwrapped(el), xloc);
      if (p) pts.push(p);
    }
  }
  const props: Record<string, unknown> = {
    points: pts,
    xloc,
    curved: boolArg(bound, 'curved', false),
    closed: boolArg(bound, 'closed', false),
    // Absent → TV default blue; explicit color=na → no stroke (Vela undefined).
    line_color: bound.has('line_color') ? colorArg(bound, 'line_color') : '#2962FF',
    fill_color: colorArg(bound, 'fill_color'),
    line_style: strArg(bound, 'line_style', 'line.style_solid'),
    line_width: numArg(bound, 'line_width', 1),
    force_overlay: boolArg(bound, 'force_overlay', false),
  };
  const obj = created(ctx, 'polyline', props);
  return { kind: 'polyline', v: obj };
});

registerBuiltin('polyline', 'delete', (c, args) => {
  const ctx = c as RtCtx;
  const obj = asObj(args[0]);
  if (obj) {
    drawSink(ctx).remove(obj);
    const live = liveArr(ctx, 'polyline');
    const i = live.indexOf(obj);
    if (i >= 0) live.splice(i, 1);
  }
  return { kind: 'void' };
});

// ── linefill ────────────────────────────────────────────────────────────────
// Bands between two line objects; TV counts them against max_lines_count
// (QUOTA_KEY maps 'linefill' → 'lines'). The engine embeds the live line
// DrawObjs so endpoint edits propagate without a snapshot.

registerBuiltin('linefill', 'new', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, [
    'line1', 'line2', 'color', 'force_overlay',
  ] as const);
  const l1 = asObj(bound.get('line1'));
  const l2 = asObj(bound.get('line2'));
  if (!l1 || !l2 || l1.kind !== 'line' || l2.kind !== 'line') {
    warnOnce(ctx, 'linefill|noline', 'linefill.new() requires two line objects');
    return NA;
  }
  const props: Record<string, unknown> = {
    line1: l1, line2: l2,
    color: colorArg(bound, 'color'),
    force_overlay: boolArg(bound, 'force_overlay', false),
  };
  const obj = created(ctx, 'linefill', props);
  return { kind: 'linefill', v: obj };
});

for (const which of ['line1', 'line2'] as const) {
  registerBuiltin('linefill', `set_${which}`, (c, args, named) => {
    const bound = bindArgs(args, named, ['id', which] as const);
    const obj = asObj(bound.get('id'));
    const l = asObj(bound.get(which));
    if (obj && l?.kind === 'line') drawSink(c as RtCtx).update(obj, { [which]: l });
    return { kind: 'void' };
  });
  registerBuiltin('linefill', `get_${which}`, (_c, args) => {
    const obj = asObj(args[0]);
    const l = obj?.props[which];
    return l ? ({ kind: 'line', v: l } as Value) : NA;
  });
}

registerBuiltin('linefill', 'set_color', (c, args, named) => {
  const bound = bindArgs(args, named, ['id', 'color'] as const);
  const obj = asObj(bound.get('id'));
  if (obj) drawSink(c as RtCtx).update(obj, { color: asColor(bound.get('color') ?? NA) });
  return { kind: 'void' };
});
registerBuiltin('linefill', 'get_color', (_c, args) => {
  const obj = asObj(args[0]);
  const col = obj?.props['color'];
  return typeof col === 'string' ? ({ kind: 'color', v: col } as Value) : NA;
});

registerBuiltin('linefill', 'delete', (c, args) => {
  const ctx = c as RtCtx;
  const obj = asObj(args[0]);
  if (obj) {
    drawSink(ctx).remove(obj);
    const live = liveArr(ctx, 'linefill');
    const i = live.indexOf(obj);
    if (i >= 0) live.splice(i, 1);
  }
  return { kind: 'void' };
});

// ── *.all — live object arrays ──────────────────────────────────────────────
// Lazy constants: evaluated per access so mutations during the bar are seen.
// getConstant(key, ctx) callers get the live array; without ctx → empty.
// A same-named BUILTIN is the fallback if the interpreter resolves `line.all`
// through BUILTINS instead of constants.
for (const kind of ['line', 'label', 'box', 'table', 'polyline', 'linefill'] as const) {
  registerLazyConstant(kind, 'all', (c) => {
    const ctx = c as RtCtx | undefined;
    const live = ctx ? liveArr(ctx, kind) : [];
    return { kind: 'array', v: live.map(o => ({ kind, v: o }) as Value) };
  });
  registerBuiltin(kind, 'all', (c) => {
    const ctx = c as RtCtx;
    return { kind: 'array', v: liveArr(ctx, kind).map(o => ({ kind, v: o }) as Value) };
  });
}
