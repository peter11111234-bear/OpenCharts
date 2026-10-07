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
  RtCtx, bindArgs, bindDeclArgs, truthy, asNum, asStr, asColor, strArg,
  numArg, colorArg, numVal,
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
  'style_label_outline',
]);
enumSet('text', [
  'align_left', 'align_center', 'align_right',
  'align_top', 'align_bottom',
  'wrap_auto', 'wrap_none',
  'format_mintick', 'format_percent', 'format_volume', 'format_inherit',
]);
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

function liveArr(ctx: RtCtx, kind: 'line' | 'label' | 'box' | 'table'): DrawObj[] {
  switch (kind) {
    case 'line': return ctx.liveLines ??= [];
    case 'label': return ctx.liveLabels ??= [];
    case 'box': return ctx.liveBoxes ??= [];
    default: return ctx.liveTables ??= [];
  }
}

// ── Drawing quotas (TV max_lines_count / max_labels_count / max_boxes_count) ──
// TV auto-deletes the oldest objects of a kind once the live count exceeds the
// declared limit (default 50). Quotas come from the indicator()/strategy()
// declaration via declDrawQuotas → ctx.declQuotas.

const DEFAULT_QUOTA = 50;

const QUOTA_KEY: Record<'line' | 'label' | 'box', 'lines' | 'labels' | 'boxes'> = {
  line: 'lines',
  label: 'labels',
  box: 'boxes',
};

/** Create a drawing, mirror it live, and evict the oldest beyond the quota. */
function created(ctx: RtCtx, kind: 'line' | 'label' | 'box' | 'table', props: Record<string, unknown>): DrawObj {
  const obj = drawSink(ctx).create(kind, props);
  const live = liveArr(ctx, kind);
  live.push(obj);
  if (kind === 'table') return obj; // no quota field in this interpreter's decl set
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

/** Pine v5 indicator() signature order (positional binding). */
export const INDICATOR_DECL_ORDER = [
  'title', 'shorttitle', 'overlay', 'format', 'precision', 'scale',
  'max_bars_back', 'backtest_fill_limits_assumption',
  'linktoseries', 'max_lines_count', 'max_labels_count', 'max_boxes_count',
  'max_tables_count', 'max_polylines_count', 'calc_chart_luminosity_order',
  'explicit_plot_zorder', 'max_circles_count',
] as const;

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
}

/** Obj arg → DrawObj; narrows on the typed drawing Value kinds. */
function asObj(v: Value | undefined): DrawObj | undefined {
  switch (v?.kind) {
    case 'line': case 'label': case 'box': case 'table':
    case 'polyline': case 'linefill':
      return v.v;
    default:
      return undefined;
  }
}

type PropType = 'num' | 'str' | 'bool';

function coerceIn(v: Value | undefined, t: PropType): number | string | boolean {
  if (v === undefined || v.kind === 'na') return t === 'num' ? 0 : t === 'bool' ? false : '';
  if (t === 'num') return asNum(v);
  if (t === 'bool') return truthy(v);
  return v.kind === 'color' ? asColor(v) : asStr(v);
}

function coerceOut(raw: unknown, t: PropType): Value {
  if (raw === undefined || raw === null) return NA;
  if (t === 'num') return numVal(Number(raw));
  if (t === 'bool') return raw ? { kind: 'bool', v: true } : { kind: 'bool', v: false };
  return { kind: 'string', v: String(raw) };
}

const PROP_TABLES: Record<string, Record<string, PropType>> = {
  line: {
    x1: 'num', y1: 'num', x2: 'num', y2: 'num',
    xloc: 'str', extend: 'str', color: 'str', style: 'str', width: 'num',
  },
  label: {
    x: 'num', y: 'num', text: 'str', xloc: 'str', yloc: 'str',
    color: 'str', style: 'str', textcolor: 'str', size: 'str',
    textalign: 'str', tooltip: 'str',
  },
  box: {
    left: 'num', top: 'num', right: 'num', bottom: 'num',
    border_color: 'str', border_width: 'num', border_style: 'str',
    extend: 'str', xloc: 'str', bgcolor: 'str',
    text: 'str', text_size: 'str', text_color: 'str',
    text_halign: 'str', text_valign: 'str', text_wrap: 'str',
  },
};

for (const [kind, table] of Object.entries(PROP_TABLES)) {
  for (const [prop, t] of Object.entries(table)) {
    registerBuiltin(kind, `set_${prop}`, (c, args, named) => {
      const bound = bindArgs(args, named, [kind, prop] as const);
      const obj = asObj(bound.get(kind));
      if (obj) {
        const p = { [prop]: coerceIn(bound.get(prop), t) };
        drawSink(c as RtCtx).update(obj, p);
      }
      return { kind: 'void' };
    });
    registerBuiltin(kind, `get_${prop}`, (_c, args) => {
      const obj = asObj(args[0]);
      return obj ? coerceOut(obj.props[prop], t) : NA;
    });
  }
}

// ── line ────────────────────────────────────────────────────────────────────

registerBuiltin('line', 'new', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, [
    'x1', 'y1', 'x2', 'y2', 'xloc', 'extend', 'color', 'style', 'width',
  ] as const);
  const props: Record<string, unknown> = {
    x1: numArg(bound, 'x1', 0), y1: numArg(bound, 'y1', 0),
    x2: numArg(bound, 'x2', 0), y2: numArg(bound, 'y2', 0),
    xloc: strArg(bound, 'xloc', 'xloc.bar_index'),
    extend: strArg(bound, 'extend', 'extend.none'),
    // Absent → TV default blue; explicit color=na → invisible (engine flag).
    color: bound.has('color') ? colorArg(bound, 'color') : '#2962FF',
    style: strArg(bound, 'style', 'line.style_solid'),
    width: numArg(bound, 'width', 1),
  };
  const obj = created(ctx, 'line', props);
  return { kind: 'line', v: obj };
});

registerBuiltin('line', 'set_xy1', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, { x1: asNum(args[1] ?? NA), y1: asNum(args[2] ?? NA) });
  return { kind: 'void' };
});
registerBuiltin('line', 'set_xy2', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, { x2: asNum(args[1] ?? NA), y2: asNum(args[2] ?? NA) });
  return { kind: 'void' };
});

registerBuiltin('line', 'get_price', (c, args) => {
  const ctx = c as RtCtx;
  const obj = asObj(args[0]);
  if (!obj) return NA;
  const barIndex = args[1] !== undefined ? asNum(args[1]) : ctx.barIndex;
  const x1 = Number(obj.props.x1) || 0;
  const y1 = Number(obj.props.y1) || 0;
  const x2 = Number(obj.props.x2) || 0;
  const y2 = Number(obj.props.y2) || 0;
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

// ── label ───────────────────────────────────────────────────────────────────

registerBuiltin('label', 'new', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, [
    'x', 'y', 'text', 'xloc', 'yloc', 'color', 'style',
    'textcolor', 'size', 'textalign', 'tooltip',
  ] as const);
  const props: Record<string, unknown> = {
    x: numArg(bound, 'x', 0), y: numArg(bound, 'y', 0),
    text: strArg(bound, 'text', ''),
    xloc: strArg(bound, 'xloc', 'xloc.bar_index'),
    yloc: strArg(bound, 'yloc', 'yloc.price'),
    color: colorArg(bound, 'color'),
    style: strArg(bound, 'style', 'label.style_label_up'),
    textcolor: colorArg(bound, 'textcolor'),
    size: strArg(bound, 'size', 'size.normal'),
    textalign: strArg(bound, 'textalign', 'text.align_left'),
    tooltip: bound.has('tooltip') ? strArg(bound, 'tooltip', '') : undefined,
  };
  const obj = created(ctx, 'label', props);
  return { kind: 'label', v: obj };
});

registerBuiltin('label', 'set_xy', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, { x: asNum(args[1] ?? NA), y: asNum(args[2] ?? NA) });
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

// ── box ─────────────────────────────────────────────────────────────────────

registerBuiltin('box', 'new', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, [
    // TV order: (left, top, right, bottom, xloc, extend, border_color, …)
    'left', 'top', 'right', 'bottom', 'xloc', 'extend', 'border_color',
    'border_width', 'border_style', 'bgcolor', 'text', 'text_size',
    'text_color', 'text_halign', 'text_valign', 'text_wrap',
  ] as const);
  const props: Record<string, unknown> = {
    left: numArg(bound, 'left', 0), top: numArg(bound, 'top', 0),
    right: numArg(bound, 'right', 0), bottom: numArg(bound, 'bottom', 0),
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
  const obj = created(ctx, 'box', props);
  return { kind: 'box', v: obj };
});

registerBuiltin('box', 'set_lefttop', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, { left: asNum(args[1] ?? NA), top: asNum(args[2] ?? NA) });
  return { kind: 'void' };
});
registerBuiltin('box', 'set_rightbottom', (c, args) => {
  const obj = asObj(args[0]);
  if (obj) drawSink(c as RtCtx).update(obj, { right: asNum(args[1] ?? NA), bottom: asNum(args[2] ?? NA) });
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
  ] as const);
  const props: Record<string, unknown> = {
    position: strArg(bound, 'position', 'position.top_center'),
    columns: numArg(bound, 'columns', 1),
    rows: numArg(bound, 'rows', 1),
    bgcolor: colorArg(bound, 'bgcolor'),
    frame_color: colorArg(bound, 'frame_color'),
    frame_width: numArg(bound, 'frame_width', 0),
    border_color: colorArg(bound, 'border_color'),
    border_width: numArg(bound, 'border_width', 0),
  };
  const obj = created(ctx, 'table', props);
  return { kind: 'table', v: obj };
});

registerBuiltin('table', 'cell', (c, args, named) => {
  const bound = bindArgs(args, named, [
    'table_id', 'column', 'row', 'text', 'width', 'height', 'text_color',
    'text_halign', 'text_valign', 'text_size', 'bgcolor', 'tooltip',
  ] as const);
  const obj = asObj(bound.get('table_id') ?? bound.get('table'));
  if (!obj) return { kind: 'void' };
  const col = numArg(bound, 'column', 0);
  const row = numArg(bound, 'row', 0);
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
    const col = numArg(bound, 'column', 0), row = numArg(bound, 'row', 0);
    const cell = cellsOf(obj).get(`${col},${row}`) ?? { text: '' };
    (cell as Record<string, unknown>)[key] = coerce(bound.get(key)!);
    cellsOf(obj).set(`${col},${row}`, cell);
    drawSink(c as RtCtx).update(obj, {});
    return { kind: 'void' };
  });
cellSetter('text', v => asStr(v));
cellSetter('text_color', v => asColor(v));
cellSetter('text_size', v => asStr(v));
cellSetter('bgcolor', v => asColor(v));
cellSetter('tooltip', v => asStr(v));

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

// ── *.all — live object arrays ──────────────────────────────────────────────
// Lazy constants: evaluated per access so mutations during the bar are seen.
// getConstant(key, ctx) callers get the live array; without ctx → empty.
// A same-named BUILTIN is the fallback if the interpreter resolves `line.all`
// through BUILTINS instead of constants.
for (const kind of ['line', 'label', 'box'] as const) {
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
