// ── plot / output builtins ──────────────────────────────────────────────────
// plot, plotshape, plotchar, plotarrow, plotbar, plotcandle, hline, fill,
// bgcolor, barcolor, alertcondition, alert + enum constants
// (shape.*, location.*, size.*, display.*, barmerge.*, alert.freq_*).
//
// Sink routing: each plot-family call site owns one PlotSink. The interpreter
// sets ctx.callsite to a stable id per Call node; sinks are assigned lazily in
// first-encounter order (ctx.plotIds / ctx.plotSeq). Missing sink slots get a
// recording sink appended to ctx.plots so data is never dropped.
//
// plot()/plotshape()/plotarrow() return `{kind:'int', v: sinkIndex}` — that int
// is a plot id, the documented convention for fill(plotA, plotB, …) args.

import type { BuiltinCtx, PlotOpts, PlotSink, Value } from '../contracts';
import { NA, VFALSE } from '../contracts';
import { registerBuiltin, registerConstant } from './registry';
import {
  RtCtx, bindArgs, truthy, asNum, asStr, strArg, boolArg,
  colorArg, curNum, inLocalScope, numArg, plotVal, numVal,
} from './util';

// ── Enum constants ──────────────────────────────────────────────────────────
// Value = full dotted name; comparisons against literal strings use `asStr`.

function enumSet(ns: string, names: readonly string[]): void {
  for (const n of names) registerConstant(ns, n, { kind: 'string', v: `${ns}.${n}` });
}

enumSet('shape', [
  'xcross', 'cross', 'circle', 'triangleup', 'triangledown', 'flag',
  'square', 'diamond', 'arrowup', 'arrowdown', 'labelup', 'labeldown',
  'labelleft', 'labelright', 'labellowerleft', 'labelloweright',
  'labelupperleft', 'labelupperright', 'labelcenter', 'none',
]);
enumSet('location', [
  'abovebar', 'belowbar', 'top', 'bottom', 'absolute',
]);
enumSet('size', [
  'auto', 'tiny', 'small', 'normal', 'large', 'huge',
]);
enumSet('position', [
  'top_left', 'top_center', 'top_right',
  'middle_left', 'middle_center', 'middle_right',
  'bottom_left', 'bottom_center', 'bottom_right',
]);
enumSet('display', ['all', 'none', 'data_window', 'pane', 'price_scale', 'status_line']);
enumSet('xloc', ['bar_index', 'bar_time']);
enumSet('yloc', ['price', 'abovebar', 'belowbar']);
enumSet('extend', ['none', 'left', 'right', 'both']);
enumSet('barmerge', ['gaps_off', 'gaps_on', 'lookahead_off', 'lookahead_on']);
enumSet('alert', [
  'freq_once_per_bar', 'freq_once_per_bar_close', 'freq_all',
]);

// plot.style_* display constants
enumSet('plot', ['style_line', 'style_linebr', 'style_stepline', 'style_steplinebr',
  'style_circles', 'style_cross', 'style_area', 'style_areabr', 'style_columns',
  'style_histogram']);

// ── Sink routing ────────────────────────────────────────────────────────────

/** Recording sink fallback: buffers pushed values so ctx.plots entries always
 *  carry data even if the engine didn't pre-create sinks. Entries carry the
 *  barIndex so sparse (conditional) plots align to their own bar. */
function recordingSink(
  ctx: BuiltinCtx,
): PlotSink & { buf: { value: Value; opts: PlotOpts; barIndex?: number }[] } {
  const sink: PlotSink & { buf: { value: Value; opts: PlotOpts; barIndex?: number }[] } = {
    buf: [],
    push(value: Value, opts: PlotOpts): void {
      sink.buf.push({ value, opts, barIndex: ctx.barIndex });
    },
  };
  return sink;
}

/** Resolve (creating if needed) the sink index for this call site. */
function plotIndex(ctx: RtCtx): number {
  ctx.plotIds ??= new Map();
  ctx.plotSeq ??= ctx.plots.length;
  const id = ctx.callsite ?? `auto_${ctx.plotSeq}`;
  let idx = ctx.plotIds.get(id);
  if (idx === undefined) {
    idx = ctx.plotSeq++;
    ctx.plotIds.set(id, idx);
  }
  while (ctx.plots.length <= idx) ctx.plots.push(recordingSink(ctx));
  return idx;
}

function sinkAt(ctx: RtCtx, idx: number): PlotSink {
  while (ctx.plots.length <= idx) ctx.plots.push(recordingSink(ctx));
  return ctx.plots[idx]!;
}

// ── plot ────────────────────────────────────────────────────────────────────

const PLOT_ORDER = [
  'series', 'title', 'color', 'linewidth', 'style', 'trackprice',
  'histbase', 'offset', 'join', 'editable', 'show_last', 'display',
  'format', 'precision', 'force_overlay',
] as const;

registerBuiltin('', 'plot', (c, args, named) => {
  const ctx = c as RtCtx;
  if (inLocalScope(ctx, 'plot')) return NA;
  const bound = bindArgs(args, named, PLOT_ORDER);
  const idx = plotIndex(ctx);

  const opts: PlotOpts = {};
  const title = bound.get('title');
  if (title !== undefined && title.kind !== 'na') opts.title = asStr(title);
  const color = colorArg(bound, 'color');
  if (color !== undefined) opts.color = color;
  const lw = bound.get('linewidth');
  if (lw !== undefined && lw.kind !== 'na') opts.linewidth = asNum(lw);
  const style = bound.get('style');
  if (style !== undefined && style.kind !== 'na') opts.style = asStr(style);
  const display = bound.get('display');
  if (display !== undefined && display.kind !== 'na') opts.display = asStr(display);
  const off = bound.get('offset');
  if (off !== undefined && off.kind !== 'na') {
    const n = curNum(off);
    if (n !== undefined) opts.offset = n;
  }

  const series = bound.get('series');
  sinkAt(ctx, idx).push(series === undefined ? NA : plotVal(series), opts);
  return { kind: 'int', v: idx };
});

// ── plotshape / plotchar / plotarrow ────────────────────────────────────────

const SHAPE_ORDER = [
  'series', 'title', 'style', 'location', 'color', 'offset', 'text',
  'textcolor', 'editable', 'size', 'show_last', 'display',
] as const;

/** Anchor price for a truthy shape/char marker. `location.top`/`bottom` are
 *  pane regions (no price meaning); bool cond under `location.absolute` has no
 *  numeric anchor — TV renders it above the bar area, so it anchors at high.
 *  The location flag rides on opts so the engine can map it to its marker
 *  position regardless of the numeric fallback used here. */
function shapeAnchor(ctx: RtCtx, cond: Value, loc: string): Value {
  if (loc.endsWith('abovebar') || loc.endsWith('top')) return plotVal({ kind: 'series', v: ctx.high });
  if (loc.endsWith('absolute')) {
    const n = curNum(cond);
    return n === undefined ? plotVal({ kind: 'series', v: ctx.high }) : numVal(n);
  }
  return plotVal({ kind: 'series', v: ctx.low }); // belowbar / bottom / unknown
}

/** Copy bound offset= into opts (engine shifts the marker row). */
function copyOffset(bound: Map<string, Value>, opts: PlotOpts & Record<string, unknown>): void {
  const off = bound.get('offset');
  if (off !== undefined && off.kind !== 'na') {
    const n = curNum(off);
    if (n !== undefined) opts.offset = n;
  }
}

registerBuiltin('', 'plotshape', (c, args, named) => {
  const ctx = c as RtCtx;
  if (inLocalScope(ctx, 'plotshape')) return NA;
  const bound = bindArgs(args, named, SHAPE_ORDER);
  const idx = plotIndex(ctx);

  const opts: PlotOpts & Record<string, unknown> = { style: 'shape' };
  opts.marker = strArg(bound, 'style', 'shape.xcross');
  opts.location = strArg(bound, 'location', 'location.belowbar');
  opts.title = bound.has('title') ? strArg(bound, 'title', '') : undefined;
  opts.color = colorArg(bound, 'color');
  opts.text = bound.has('text') ? strArg(bound, 'text', '') : undefined;
  opts.size = strArg(bound, 'size', 'size.auto');
  const display = bound.get('display');
  if (display !== undefined && display.kind !== 'na') opts.display = asStr(display);
  copyOffset(bound, opts);

  const cond = bound.get('series') ?? VFALSE;
  const value: Value = truthy(cond) ? shapeAnchor(ctx, cond, opts.location as string) : NA;
  sinkAt(ctx, idx).push(value, opts as PlotOpts);
  return { kind: 'int', v: idx };
});

registerBuiltin('', 'plotchar', (c, args, named) => {
  const ctx = c as RtCtx;
  if (inLocalScope(ctx, 'plotchar')) return NA;
  const bound = bindArgs(args, named, [
    'series', 'title', 'char', 'location', 'color', 'offset', 'text',
    'textcolor', 'editable', 'size', 'show_last', 'display',
  ] as const);
  const idx = plotIndex(ctx);

  const opts: PlotOpts & Record<string, unknown> = { style: 'char' };
  opts.char = strArg(bound, 'char', '');
  opts.location = strArg(bound, 'location', 'location.abovebar');
  opts.color = colorArg(bound, 'color');
  opts.title = bound.has('title') ? strArg(bound, 'title', '') : undefined;
  copyOffset(bound, opts);
  const cond = bound.get('series') ?? VFALSE;
  const value = truthy(cond) ? shapeAnchor(ctx, cond, opts.location as string) : NA;
  sinkAt(ctx, idx).push(value, opts as PlotOpts);
  return { kind: 'int', v: idx };
});

registerBuiltin('', 'plotarrow', (c, args, named) => {
  const ctx = c as RtCtx;
  if (inLocalScope(ctx, 'plotarrow')) return NA;
  const bound = bindArgs(args, named, [
    'series', 'title', 'colorup', 'colordown', 'offset', 'minheight',
    'maxheight', 'editable', 'show_last', 'display',
  ] as const);
  const idx = plotIndex(ctx);

  const opts: PlotOpts & Record<string, unknown> = { style: 'arrow' };
  copyOffset(bound, opts);
  const cond = bound.get('series') ?? VFALSE;
  const n = curNum(cond);
  // Push the SIGNED condition value (not an anchor price) — engine derives
  // arrow direction + position from its sign: >0 → arrowUp/belowBar,
  // <0 → arrowDown/aboveBar. Nonzero magnitude passes minheight-style gates.
  let value: Value = NA;
  if (n !== undefined && n !== 0) {
    value = { kind: 'float', v: n };
    opts.color = n > 0 ? colorArg(bound, 'colorup') : colorArg(bound, 'colordown');
  }
  sinkAt(ctx, idx).push(value, opts as PlotOpts);
  return { kind: 'int', v: idx };
});

// ── plotbar / plotcandle ────────────────────────────────────────────────────

registerBuiltin('', 'plotbar', (c, args, named) => {
  const ctx = c as RtCtx;
  if (inLocalScope(ctx, 'plotbar')) return NA;
  const bound = bindArgs(args, named, [
    'open', 'high', 'low', 'close', 'title', 'color', 'editable', 'show_last', 'display',
  ] as const);
  const idx = plotIndex(ctx);
  const opts: PlotOpts & Record<string, unknown> = { style: 'bar' };
  const color = colorArg(bound, 'color');
  if (color !== undefined) opts.color = color;
  const title = bound.get('title');
  if (title !== undefined && title.kind !== 'na') opts.title = asStr(title);
  const display = bound.get('display');
  if (display !== undefined && display.kind !== 'na') opts.display = asStr(display);

  const o = curNum(bound.get('open') ?? NA);
  const h = curNum(bound.get('high') ?? NA);
  const l = curNum(bound.get('low') ?? NA);
  const cl = curNum(bound.get('close') ?? NA);
  const value: Value = (o === undefined || h === undefined || l === undefined || cl === undefined)
    ? NA
    : { kind: 'array', v: [numVal(o), numVal(h), numVal(l), numVal(cl)] };
  sinkAt(ctx, idx).push(value, opts as PlotOpts);
  return { kind: 'int', v: idx };
});

registerBuiltin('', 'plotcandle', (c, args, named) => {
  const ctx = c as RtCtx;
  if (inLocalScope(ctx, 'plotcandle')) return NA;
  const bound = bindArgs(args, named, [
    'open', 'high', 'low', 'close', 'title', 'color', 'wickcolor',
    'editable', 'show_last', 'bordercolor', 'display',
  ] as const);
  const idx = plotIndex(ctx);
  const opts: PlotOpts & Record<string, unknown> = { style: 'candle' };
  const color = colorArg(bound, 'color');
  if (color !== undefined) opts.color = color;
  const title = bound.get('title');
  if (title !== undefined && title.kind !== 'na') opts.title = asStr(title);
  const display = bound.get('display');
  if (display !== undefined && display.kind !== 'na') opts.display = asStr(display);
  const wick = colorArg(bound, 'wickcolor');
  if (wick !== undefined) opts.wickcolor = wick;
  const border = colorArg(bound, 'bordercolor');
  if (border !== undefined) opts.bordercolor = border;

  const o = curNum(bound.get('open') ?? NA);
  const h = curNum(bound.get('high') ?? NA);
  const l = curNum(bound.get('low') ?? NA);
  const cl = curNum(bound.get('close') ?? NA);
  const value: Value = (o === undefined || h === undefined || l === undefined || cl === undefined)
    ? NA
    : { kind: 'array', v: [numVal(o), numVal(h), numVal(l), numVal(cl)] };
  sinkAt(ctx, idx).push(value, opts as PlotOpts);
  return { kind: 'int', v: idx };
});

// ── hline ───────────────────────────────────────────────────────────────────

registerBuiltin('', 'hline', (c, args, named) => {
  const ctx = c as RtCtx;
  if (inLocalScope(ctx, 'hline')) return NA;
  const bound = bindArgs(args, named, [
    'price', 'title', 'color', 'linestyle', 'linewidth', 'editable', 'display',
  ] as const);
  const price = bound.get('price') ?? NA;
  const pv = price.kind === 'series' ? price.v.cur() : price;
  if (pv.kind === 'na') return NA; // hline(na) draws nothing, allocates no slot
  const idx = plotIndex(ctx);
  const opts: PlotOpts & Record<string, unknown> = { style: 'hline' };
  if (bound.has('title')) opts.title = strArg(bound, 'title', '');
  const color = colorArg(bound, 'color');
  if (color !== undefined) opts.color = color;
  const ls = bound.get('linestyle');
  if (ls !== undefined && ls.kind !== 'na') opts.linestyle = asStr(ls);
  const lw = bound.get('linewidth');
  if (lw !== undefined && lw.kind !== 'na') opts.linewidth = asNum(lw);
  const display = bound.get('display');
  if (display !== undefined && display.kind !== 'na') opts.display = asStr(display);

  sinkAt(ctx, idx).push(plotVal(price), opts as PlotOpts);
  return { kind: 'int', v: idx };
});

// ── fill ────────────────────────────────────────────────────────────────────
// fill(plotA, plotB, color, ...) — links two plot ids. Recorded on ctx as a
// fill descriptor; the engine renders the band between the two series.

registerBuiltin('', 'fill', (c, args, named) => {
  const ctx = c as RtCtx;
  if (inLocalScope(ctx, 'fill')) return { kind: 'void' };
  const bound = bindArgs(args, named, [
    'plot1', 'plot2', 'color', 'title', 'editable', 'show_last',
    'fillgaps', 'display', 'force_overlay',
  ] as const);

  ctx.fills ??= [];
  const a = bound.get('plot1');
  const b = bound.get('plot2');
  // evalArg wraps every arg in a per-callsite BarSeries — unwrap to the int id.
  const ua = a?.kind === 'series' ? a.v.cur() : a;
  const ub = b?.kind === 'series' ? b.v.cur() : b;
  const nOf = (u: Value | undefined): number =>
    u && (u.kind === 'int' || u.kind === 'float') ? u.v : -1;
  ctx.fills.push({
    plot1: nOf(ua),
    plot2: nOf(ub),
    color: colorArg(bound, 'color'),
    title: bound.has('title') ? strArg(bound, 'title', '') : undefined,
    fillgaps: boolArg(bound, 'fillgaps', false),
  });
  return { kind: 'void' };
});

// ── bgcolor / barcolor ──────────────────────────────────────────────────────

registerBuiltin('', 'bgcolor', (c, args, named) => {
  const ctx = c as RtCtx;
  if (inLocalScope(ctx, 'bgcolor')) return { kind: 'void' };
  const bound = bindArgs(args, named, [
    'color', 'offset', 'editable', 'show_last', 'title', 'display', 'force_overlay',
  ] as const);
  ctx.bgcolors ??= new Map();
  // Per-callsite layers (TV: each bgcolor() is its own layer — na clears only
  // that callsite's contribution, not another call's color).
  const at = ctx.barIndex + numArg(bound, 'offset', 0);
  const color = colorArg(bound, 'color');
  const site = ctx.callsite ?? '#top';
  const layer = ctx.bgcolors.get(at) ?? new Map<string, string>();
  if (color === undefined) layer.delete(site);
  else layer.set(site, color);
  if (layer.size > 0) ctx.bgcolors.set(at, layer);
  else ctx.bgcolors.delete(at);
  return { kind: 'void' };
});

registerBuiltin('', 'barcolor', (c, args, named) => {
  const ctx = c as RtCtx;
  if (inLocalScope(ctx, 'barcolor')) return { kind: 'void' };
  const bound = bindArgs(args, named, [
    'color', 'offset', 'editable', 'show_last', 'title', 'display', 'force_overlay',
  ] as const);
  ctx.barcolors ??= new Map();
  const at = ctx.barIndex + numArg(bound, 'offset', 0);
  const color = colorArg(bound, 'color');
  const site = ctx.callsite ?? '#top';
  const layer = ctx.barcolors.get(at) ?? new Map<string, string>();
  if (color === undefined) layer.delete(site);
  else layer.set(site, color);
  if (layer.size > 0) ctx.barcolors.set(at, layer);
  else ctx.barcolors.delete(at);
  return { kind: 'void' };
});

// ── alertcondition / alert ──────────────────────────────────────────────────

registerBuiltin('', 'alertcondition', (c, args, named) => {
  const ctx = c as RtCtx;
  if (inLocalScope(ctx, 'alertcondition')) return { kind: 'void' };
  const bound = bindArgs(args, named, ['condition', 'title', 'message'] as const);
  ctx.alertconditions ??= [];
  const title = strArg(bound, 'title', '');
  const msg = strArg(bound, 'message', '');
  // alertcondition only registers a condition for the Create Alert dialog —
  // unlike alert() it never emits runtime alerts, so ctx.alerts stays clean.
  if (!ctx.alertconditions.some(a => a.title === title)) {
    ctx.alertconditions.push({ title, msg });
  }
  return { kind: 'void' };
});

registerBuiltin('', 'alert', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, ['message', 'freq'] as const);
  const freq = strArg(bound, 'freq', 'alert.freq_once_per_bar');

  ctx.alertstate ??= new Map();
  const key = ctx.callsite ?? 'alert';
  const last = ctx.alertstate.get(key);

  let fire = true;
  if (freq.endsWith('freq_once_per_bar')) fire = last !== ctx.barIndex;
  else if (freq.endsWith('freq_once_per_bar_close')) {
    fire = ctx.barIndex === ctx.barCount - 1 && last !== ctx.barIndex;
  } // freq_all → always fire

  if (fire) {
    ctx.alertstate.set(key, ctx.barIndex);
    ctx.alerts.push({ id: key, msg: strArg(bound, 'message', '') });
  }
  return { kind: 'void' };
});
