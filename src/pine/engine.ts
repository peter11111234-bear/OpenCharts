// ── Pine interpreter → Vela ScriptingEngine adapter ─────────────────────────
// Implements the `ScriptingEngine` port from `@luxalgo/vela` on top of the
// from-scratch interpreter (`runScript`). Runs in-process on the main thread —
// correct-by-construction; heavy scripts may block.

import type {
  ExecutionHandlers,
  ExecutionRequest,
  ExecutionSession,
  FetchSeries,
  IndicatorModel,
  InputSchema,
  InputValue,
  OHLCV,
  PreparedScript,
  ScriptingEngine,
} from '@luxalgo/vela';
import type { BarData, DrawObj, PlotOpts, RunResult, Value } from './contracts';
import { parse } from './parser';
import { collectInputs, runScript } from './interpreter';
import { tfFloor, tfNext } from './mtf';
import './builtins/index';
import './mtf';

/** Opaque token carried prepare → execute. */
interface PineToken {
  source: string;
  instanceId: string;
  /** Content-derived model id — stable across re-runs of the same source. */
  modelId: string;
}

const numOf = (v: Value): number | null => {
  const u = v.kind === 'series' ? v.v.cur() : v;
  if (u.kind === 'int' || u.kind === 'float') return Number.isFinite(u.v) ? u.v : null;
  return null;
};

const LINESTYLE: Record<string, 'solid' | 'dashed' | 'dotted'> = {
  'line.style_solid': 'solid',
  'line.style_dashed': 'dashed',
  'line.style_dotted': 'dotted',
};
const styleOf = (style: string | undefined): 'solid' | 'dashed' | 'dotted' => {
  if (!style) return 'solid';
  if (style in LINESTYLE) return LINESTYLE[style]!;
  const low = style.toLowerCase();
  if (low.includes('dash')) return 'dashed';
  if (low.includes('dot')) return 'dotted';
  return 'solid';
};

const inputTypeOf = (t: string): InputSchema['type'] => {
  const known: InputSchema['type'][] = [
    'int', 'float', 'bool', 'string', 'source', 'color',
    'price', 'time', 'session', 'timeframe', 'symbol', 'text_area',
  ];
  return (known as string[]).includes(t) ? (t as InputSchema['type']) : 'string';
};

const toInputSchema = (s: { id: string; name: string; type: string; defval: unknown; minval?: number; maxval?: number; step?: number; options?: unknown[]; group?: string; inline?: string; tooltip?: string }): InputSchema => ({
  key: s.id,
  title: s.name || s.id,
  type: inputTypeOf(s.type),
  defval: (typeof s.defval === 'number' || typeof s.defval === 'string' || typeof s.defval === 'boolean')
    ? s.defval as InputValue
    : String(s.defval ?? ''),
  min: s.minval,
  max: s.maxval,
  step: s.step,
  options: Array.isArray(s.options) ? s.options.map(String) : undefined,
  group: s.group,
  inline: s.inline,
  tooltip: s.tooltip,
});

const PLOT_KIND: Record<string, 'line' | 'area' | 'step' | 'histogram' | 'columns' | 'circles' | 'cross'> = {
  'plot.style_line': 'line',
  'plot.style_linebr': 'line',
  'plot.style_stepline': 'step',
  'plot.style_steplinebr': 'step',
  'plot.style_histogram': 'histogram',
  'plot.style_columns': 'columns',
  'plot.style_circles': 'circles',
  'plot.style_cross': 'cross',
  'plot.style_area': 'area',
  'plot.style_areabr': 'area',
};

const plotKindOf = (style: string | undefined): 'line' | 'area' | 'step' | 'histogram' | 'columns' | 'circles' | 'cross' =>
  ((style && PLOT_KIND[style]) ?? 'line') as 'line' | 'area' | 'step' | 'histogram' | 'columns' | 'circles' | 'cross';

const toBarData = (bars: OHLCV[]): BarData[] =>
  bars.map(b => ({
    openTime: b.time, open: b.open, high: b.high, low: b.low,
    close: b.close, volume: b.volume ?? 0,
  }));

/** Vela fetchSeries (with BarRange) → interpreter fetchSeries (sym, tf).
 *  Sizing is span-aware: a script on an N-bar chart needs `span/tfMs` tf bars
 *  for coverage plus a fixed warmup window for convergent series (ATR/EMA
 *  families settle within ~100 bars; 500 is a 5× margin). The old blanket
 *  `bars.length × 4` over-fetched HTF (300 chart bars → 1200 MONTHLY bars for
 *  a ~1-day span needing ~2) and under-covered LTF. Calendar units (D/W/M)
 *  count via tfFloor/tfNext bucketing, capped to bound cost. */
const FETCH_WARMUP = 500;
const FETCH_CAP = 20_000;
const toFetch = (fetch: FetchSeries | undefined, bars: OHLCV[]): ((symbol: string, tf: string) => Promise<BarData[]>) | undefined => {
  if (!fetch) return undefined;
  const first = bars[0]?.time;
  const to = bars[bars.length - 1]?.time;
  const limit = (tf: string): number => {
    if (first === undefined || to === undefined || to <= first) {
      return Math.min(Math.max(bars.length * 4, FETCH_WARMUP), FETCH_CAP);
    }
    let n = 0;
    for (let t = tfFloor(first, tf); t <= to && n < FETCH_CAP; n++) t = tfNext(t, tf);
    return Math.min(Math.max(n + FETCH_WARMUP, FETCH_WARMUP), FETCH_CAP);
  };
  return async (symbol: string, tf: string) => {
    const lim = limit(tf);
    const out = await fetch(symbol, tf, to !== undefined ? { limit: lim, to } : { limit: lim });
    return toBarData(out);
  };
};

/** FNV-1a-ish hash of the script source — the stable model/series id base. */
const sourceHash = (source: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

/** Prop on a DrawObj as a finite number (or undefined). */
const propNum = (props: Record<string, unknown>, k: string): number | undefined => {
  const v = props[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};
const propStr = (props: Record<string, unknown>, k: string): string | undefined =>
  typeof props[k] === 'string' ? (props[k] as string) : undefined;

type DrawingXLoc = 'bar_index' | 'bar_time';
type DrawingExtend = 'none' | 'left' | 'right' | 'both';
type TextSize = 'auto' | 'tiny' | 'small' | 'normal' | 'large' | 'huge';
type TextAlign = 'left' | 'center' | 'right';

const xlocOf = (s: string | undefined): DrawingXLoc =>
  (s ?? '').includes('time') ? 'bar_time' : 'bar_index';
const extendOf = (s: string | undefined): DrawingExtend => {
  const t = (s ?? 'extend.none').split('.').pop() ?? 'none';
  return t === 'left' || t === 'right' || t === 'both' ? t : 'none';
};
const textSizeOf = (s: string | undefined): TextSize => {
  const t = (s ?? 'size.normal').split('.').pop() ?? 'normal';
  return (['tiny', 'small', 'normal', 'large', 'huge'] as const).includes(t as 'tiny') ? (t as TextSize) : 'auto';
};
const labelSizeOf = (s: string | undefined): Exclude<TextSize, 'auto'> | 'auto' => {
  const t = textSizeOf(s);
  return t === 'auto' ? 'normal' : t;
};
const alignOf = (s: string | undefined): TextAlign => {
  // Pine enums are two-segment: text.align_center → 'center'.
  const t = ((s ?? '').split('.').pop() ?? '').replace(/^align_/, '');
  return t === 'right' ? 'right' : t === 'center' ? 'center' : 'left';
};
const valignOf = (s: string | undefined): 'top' | 'center' | 'bottom' => {
  const t = ((s ?? '').split('.').pop() ?? '').replace(/^valign_/, '');
  return t === 'top' ? 'top' : t === 'bottom' ? 'bottom' : 'center';
};

const LABEL_STYLES = new Set([
  'label_up', 'label_down', 'label_left', 'label_right', 'label_center',
  'label_lower_left', 'label_lower_right', 'label_upper_left', 'label_upper_right',
  'circle', 'square', 'diamond', 'flag', 'arrowup', 'arrowdown',
  'triangleup', 'triangledown', 'cross', 'xcross', 'text_outline', 'none',
]);
const labelStyleOf = (s: string | undefined): string => {
  const t = (s ?? 'label.style_label_up').replace(/^label\.style_/, '').toLowerCase();
  return LABEL_STYLES.has(t) ? t : 'label_down';
};

/** MarkerPoint.shape token (neutral camelCase/lowercase per renderer contract). */
const markerShape = (s: string): string => {
  const t = s.toLowerCase().replace(/^shape\./, '').replace(/_/g, '');
  switch (t) {
    case 'arrowup': return 'arrowUp';
    case 'arrowdown': return 'arrowDown';
    case 'triangleup': return 'triangleUp';
    case 'triangledown': return 'triangleDown';
    case 'diamond': return 'diamond';
    case 'flag': return 'flag';
    case 'circle': return 'circle';
    case 'cross': return 'cross';
    case 'xcross': return 'xcross';
    case 'square': return 'square';
    default: return 'circle';
  }
};

/** MarkerPoint.size from Pine size.* (auto → normal). */
const markerSizeOf = (s: string | undefined): 'tiny' | 'small' | 'normal' | 'large' | 'huge' => {
  const t = (s ?? '').split('.').pop() ?? '';
  return t === 'tiny' || t === 'small' || t === 'large' || t === 'huge' ? t : 'normal';
};

/** MarkerPoint.position from plotshape location.* — absolute anchors at the
 *  series value inside the bar. */
const markerPosOf = (s: string | undefined): 'aboveBar' | 'belowBar' | 'inBar' => {
  const t = (s ?? '').split('.').pop() ?? '';
  if (t === 'abovebar' || t === 'top') return 'aboveBar';
  if (t === 'absolute') return 'inBar';
  return 'belowBar';
};

export class PineInterpreterEngine implements ScriptingEngine {
  readonly language = 'pine';
  readonly capabilities = { streaming: false, visibleRange: false, inputs: true } as const;

  async prepare(source: string, instanceId: string): Promise<PreparedScript> {
    const clean = source.replace(/^\uFEFF/, '');
    const parsed = parse(clean);
    const body = Array.isArray(parsed) ? parsed : parsed.body;
    const inputs = collectInputs(body).map(toInputSchema);
    const declArgs = !Array.isArray(parsed) && parsed.decl ? parseDeclArgs(parsed.decl) : {};
    const title = (typeof declArgs['title'] === 'string' && declArgs['title']) || 'Pine Script';
    const overlay = declArgs['overlay'] === true;
    const token: PineToken = {
      source: clean,
      instanceId,
      modelId: `pine-${sourceHash(clean)}`,
    };
    return {
      language: 'pine',
      inputs,
      meta: {
        title,
        shorttitle: typeof declArgs['shorttitle'] === 'string' ? declArgs['shorttitle'] : undefined,
        overlay,
        precision: typeof declArgs['precision'] === 'number' ? declArgs['precision'] : undefined,
        format: typeof declArgs['format'] === 'string' ? declArgs['format'] : undefined,
      },
      reactsToViewport: false,
      token,
    };
  }

  execute(req: ExecutionRequest, handlers: ExecutionHandlers): ExecutionSession {
    const token = req.prepared.token as PineToken;
    let stopped = false;
    let runId = 0;
    // Merged input overrides — update() merges, notifyBars re-runs reuse.
    let inputs: Record<string, InputValue> = { ...(req.inputs ?? {}) };
    // Bundled engines defer their first run until the 'complete' notification
    // when the bars snapshot is a partial history (backfill in progress).
    let deferred = req.historyState === 'backfill';

    // Single-flight + coalescing: at most one run in flight per session; if a
    // re-run is requested while one is executing, only the LATEST request is
    // kept (superseded ones are dropped before they even queue on the global
    // runScript mutex). The in-flight run always finishes — aborting mid-run
    // under a live tick stream would starve completion forever.
    let running = false;
    let pending: OHLCV[] | null = null;
    const request = (bars: OHLCV[]) => {
      if (stopped) return;
      pending = bars;
      if (!running) void drain();
    };
    const drain = async () => {
      running = true;
      // try/finally: a throwing handler (esp. onError) must not wedge the
      // session — `running` stuck true would silently deaden every future
      // request() forever.
      try {
        while (pending && !stopped) {
          const bars = pending;
          pending = null;
          const myRun = ++runId;
          try {
            const barData = toBarData(bars);
            const barTimes = barData.map(b => b.openTime);
            // Snapshot inputs at run start — a mid-run update() must not let the
            // stale emit advertise input values the curves weren't computed with.
            const runInputs = { ...inputs };
            const result: RunResult = await runScript(parse(token.source), barData, {
              symbol: req.market.symbol,
              timeframe: req.market.timeframe,
              fetchSeries: toFetch(req.fetchSeries, bars),
              inputValues: runInputs,
              syminfo: req.market.symbolInfo ? syminfoOf(req.market.symbolInfo) : undefined,
              // Only stop() kills a run mid-flight. A superseded run still emits
              // (myRun check is only reachable via stop()) — the pending re-run
              // right after it carries the latest bars+inputs, so the stale
              // emit is one frame of lag, not a wrong final state.
              shouldAbort: () => stopped,
            });
            if (stopped || myRun !== runId) continue;
            handlers.onModel(buildModel(token.modelId, req, result, barTimes, runInputs));
            for (const w of result.warnings) handlers.onWarning?.({ message: w, bar: bars.length - 1 });
            for (const a of result.alerts) {
              handlers.onAlert?.({ id: a.id, message: a.msg, time: bars[bars.length - 1]?.time ?? 0, barIndex: bars.length - 1 });
            }
            handlers.onDone?.();
          } catch (e) {
            if (stopped || myRun !== runId) continue;
            try {
              handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
            } catch {
              // Host handler threw — the run already failed; keep the session alive.
            }
          }
        }
      } finally {
        running = false;
        // A request may have arrived between the while-check and the flag
        // flip — re-drain so it isn't stranded.
        if (pending && !stopped) void drain();
      }
    };

    const getBars = () => req.getBars?.() ?? req.bars;
    if (!deferred) request(getBars());

    return {
      stop: () => { stopped = true; runId++; pending = null; },
      update: (next: Record<string, InputValue>) => {
        inputs = { ...inputs, ...next };
        if (!deferred) request(getBars());
      },
      setVisibleRange: () => { /* interpreter has no viewport builtins */ },
      notifyBars: (reason) => {
        if (reason === 'backfill') return; // partial history — wait for 'complete'/tick
        if (reason === 'complete') deferred = false;
        if (!deferred) request(getBars());
      },
    };
  }
}

const syminfoOf = (info: NonNullable<ExecutionRequest['market']['symbolInfo']>): Record<string, Value> => {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(info)) {
    if (typeof v === 'number') out[k] = Number.isInteger(v) ? { kind: 'int', v } : { kind: 'float', v };
    else if (typeof v === 'string') out[k] = { kind: 'string', v };
    else if (typeof v === 'boolean') out[k] = { kind: 'bool', v };
  }
  return out;
};

const parseDeclArgs = (decl: { args: { name?: string; value: unknown }[] }): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const a of decl.args) {
    // indicator(title, shorttitle, overlay, ...) — keep only what the model needs
    if (a.name) out[a.name] = litOf(a.value);
    else if (i === 0) out['title'] = litOf(a.value);
    i++;
  }
  return out;
};

const litOf = (n: unknown): unknown => {
  const node = n as { type?: string; v?: unknown };
  if (node && typeof node === 'object' && 'v' in node) return node.v;
  return undefined;
};

type ModelFill = NonNullable<IndicatorModel['fills']>[number];
type ModelLine = NonNullable<IndicatorModel['lines']>[number];
type ModelBox = NonNullable<IndicatorModel['boxes']>[number];
type ModelLabel = NonNullable<IndicatorModel['labels']>[number];
type ModelBg = NonNullable<IndicatorModel['backgrounds']>[number];

type ModelTable = NonNullable<IndicatorModel['tables']>[number];
type ModelTableCell = ModelTable['cells'][number][number];
type ModelPolyline = NonNullable<IndicatorModel['polylines']>[number];
type ModelLinefill = NonNullable<IndicatorModel['linefills']>[number];

/** line DrawObj props → DrawingLine (shared by the `lines` list and embedded
 *  linefill legs — a linefill's endpoints must render identically). */
const mapDrawingLine = (p: Record<string, unknown>, id: string): ModelLine | undefined => {
  const x1 = propNum(p, 'x1'), y1 = propNum(p, 'y1');
  const x2 = propNum(p, 'x2'), y2 = propNum(p, 'y2');
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return undefined;
  const styleStr = (propStr(p, 'style') ?? '').toLowerCase();
  return {
    id, paneId: '',
    xloc: xlocOf(propStr(p, 'xloc')),
    x1, y1, x2, y2,
    extend: extendOf(propStr(p, 'extend')),
    color: propStr(p, 'color'),
    invisible: propStr(p, 'color') === undefined,
    width: Math.max(1, propNum(p, 'width') ?? 1),
    style: styleOf(propStr(p, 'style')),
    arrowLeft: styleStr.includes('arrow_left') || styleStr.includes('arrow_both'),
    arrowRight: styleStr.includes('arrow_right') || styleStr.includes('arrow_both'),
  };
};


/** Exported for tests — maps an interpreter RunResult onto the Vela model. */
export const buildModel = (modelId: string, req: ExecutionRequest, r: RunResult, barTimes: number[], inputOverrides?: Record<string, InputValue>): IndicatorModel => {
  const series: IndicatorModel['series'] = [];
  const fills: ModelFill[] = [];
  const backgrounds: ModelBg[] = [];
  const priceLines: IndicatorModel['priceLines'] = [];
  const lines: ModelLine[] = [];
  const boxes: ModelBox[] = [];
  const labels: ModelLabel[] = [];
  const barColors: NonNullable<IndicatorModel['barColors']> = [];
  const tables: ModelTable[] = [];
  const polylines: ModelPolyline[] = [];
  const linefills: ModelLinefill[] = [];

  // plot-sink index → emitted series id (fill() references these indexes).
  const plotSeriesId = new Map<number, string>();

  // Sink indexes referenced by fill() — an hline referenced here also needs a
  // hidden flat series so the fill band has geometry to anchor to.
  const fillRefs = new Set<number>();
  for (const f of r.fills ?? []) { fillRefs.add(f.plot1); fillRefs.add(f.plot2); }

  const hlineIdx = new Set<number>();
  for (const [title, plot] of r.plots) {
    const id = `${modelId}:s${plot.index}`;
    const opts = plot.opts as PlotOpts & Record<string, unknown>;
    const style = opts.style as string | undefined;

    if (style === 'hline') {
      hlineIdx.add(plot.index);
      if (fillRefs.has(plot.index)) {
        // Hidden constant series — `visible: false` anchors fills without painting
        // (the priceLine below is the visible line). Kept even under display.none.
        const points = plot.values.map((v, i) => ({
          time: plot.time[i] ?? barTimes[i] ?? 0,
          value: numOf(v),
        }));
        plotSeriesId.set(plot.index, id);
        series.push({
          id, title, paneId: '', kind: 'line',
          points, style: { color: opts.color ?? '#2962FF', width: opts.linewidth ?? 1, lineStyle: 'solid' as const },
          visible: false,
        });
      }
      // display.none → drop the priceLine entirely (PriceLine has no visibility field).
      if (opts.display === 'display.none') continue;
      const price = numOf(plot.values[plot.values.length - 1]!);
      if (price !== null && price !== undefined) {
        priceLines.push({
          id, paneId: '', price,
          color: opts.color, lineStyle: styleOf(opts.linestyle as string | undefined),
          width: opts.linewidth, title: title.startsWith('plot_') ? undefined : title,
        });
      }
      continue;
    }
    if (style === 'shape' || style === 'char') {
      if (opts.display === 'display.none') continue;
      const isChar = style === 'char';
      const markers = plot.values
        .map((v, i) => ({ u: v.kind === 'series' ? v.v.cur() : v, i }))
        .filter(p => (p.u.kind === 'int' || p.u.kind === 'float') ? Number.isFinite(p.u.v) : p.u.kind === 'bool' && p.u.v)
        .map(p => ({
          time: plot.time[p.i] ?? barTimes[p.i] ?? 0,
          position: markerPosOf(String(opts.location ?? '')),
          shape: isChar ? 'none' : markerShape(String((opts.marker as string | undefined) ?? 'shape.xcross')),
          color: plot.colors[p.i] ?? opts.color ?? '#2962FF',
          text: typeof opts.text === 'string' && opts.text !== ''
            ? opts.text
            : (typeof opts.char === 'string' && opts.char !== '' ? opts.char : undefined),
          size: markerSizeOf(String(opts.size ?? '')),
        }));
      if (markers.length > 0) {
        plotSeriesId.set(plot.index, id);
        series.push({ id, title, paneId: '', kind: 'markers', markers });
      }
      continue;
    }
    if (style === 'arrow') {
      if (opts.display === 'display.none') continue;
      const markers = plot.values
        .map((v, i) => ({ v: numOf(v), i }))
        .filter(p => p.v !== null && p.v !== 0)
        .map(p => ({
          time: plot.time[p.i] ?? barTimes[p.i] ?? 0,
          position: (p.v! > 0 ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
          shape: (p.v! > 0 ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
          color: plot.colors[p.i] ?? opts.color ?? '#2962FF',
        }));
      if (markers.length > 0) {
        plotSeriesId.set(plot.index, id);
        series.push({ id, title, paneId: '', kind: 'markers', markers });
      }
      continue;
    }
    if (style === 'bar' || style === 'candle') {
      if (opts.display === 'display.none') continue;
      const bars: OHLCV[] = plot.values.map((v, i) => {
        const u = v.kind === 'series' ? v.v.cur() : v;
        const arr = u.kind === 'array' ? u.v.map(numOf) : [null, null, null, null];
        return {
          time: plot.time[i] ?? barTimes[i] ?? 0,
          open: arr[0] ?? NaN, high: arr[1] ?? NaN, low: arr[2] ?? NaN, close: arr[3] ?? NaN,
        };
      }).filter(b => Number.isFinite(b.open));
      if (bars.length > 0) {
        plotSeriesId.set(plot.index, id);
        series.push({ id, title, paneId: '', kind: style as 'bar' | 'candle', bars });
      }
      continue;
    }

    // Default: line-like series. na → null gap.
    // display.none → no rendered series. When a fill references this plot,
    // emit a visible:false anchor like the hline path so the band has
    // geometry (F2 — previously the fill resolved to a dangling id).
    if (opts.display === 'display.none') {
      plotSeriesId.set(plot.index, id);
      if (fillRefs.has(plot.index)) {
        const points = plot.values.map((v, i) => ({
          time: plot.time[i] ?? barTimes[i] ?? 0,
          value: numOf(v),
        }));
        series.push({
          id, title, paneId: '', kind: 'line',
          points, style: { color: opts.color ?? '#2962FF', width: opts.linewidth ?? 1, lineStyle: 'solid' as const },
          visible: false,
        });
      }
      continue;
    }
    const points = plot.values.map((v, i) => ({
      time: plot.time[i] ?? barTimes[i] ?? 0,
      value: numOf(v),
      // Per-bar `color=` (conditional colors) — SeriesPoint.color override.
      color: plot.colors[i],
    }));
    plotSeriesId.set(plot.index, id);
    series.push({
      id, title, paneId: '', kind: plotKindOf(style),
      points, style: { color: opts.color ?? '#2962FF', width: opts.linewidth ?? 1, lineStyle: 'solid' as const },
      overlay: opts.overlay,
    });
  }

  // ── fill(plotA, plotB, …) — resolve sink indexes to series ids ──
  // fill() pushes a descriptor per bar — dedupe to one band per series pair.
  const seenFills = new Set<string>();
  for (const f of r.fills ?? []) {
    const fromSeriesId = plotSeriesId.get(f.plot1);
    const toSeriesId = plotSeriesId.get(f.plot2);
    if (!fromSeriesId || !toSeriesId) {
      if (hlineIdx.has(f.plot1) || hlineIdx.has(f.plot2))
        r.warnings.push(`fill() references an hline with no series geometry (plot ${f.plot1}→${f.plot2})`);
      continue;
    }
    const key = `${fromSeriesId}|${toSeriesId}`;
    if (seenFills.has(key)) continue;
    seenFills.add(key);
    fills.push({
      id: `${modelId}:fill${seenFills.size - 1}`,
      paneId: '',
      fromSeriesId,
      toSeriesId,
      color: f.color,
    });
  }

  // ── bgcolor — merge contiguous same-color runs into Background spans ──
  const interval = barTimes.length > 1 ? barTimes[1]! - barTimes[0]! : 0;
  const bgEntries = [...(r.bgcolors ?? new Map<number, Map<string, string>>()).entries()].sort((a, b) => a[0] - b[0]);
  const flatBg: [number, string][] = [];
  for (const [barIdx, layer] of bgEntries) {
    // Layered callsites: last-written callsite wins for display (TV stacks them).
    const colors = [...layer.values()];
    if (colors.length) flatBg.push([barIdx, colors[colors.length - 1]!]);
  }
  let bi = 0;
  let prevIdx = -1;
  for (const [barIdx, color] of flatBg) {
    const from = barTimes[barIdx];
    if (from === undefined) continue;
    const last = backgrounds[backgrounds.length - 1];
    // Merge consecutive bars of the same color into one span.
    if (last && prevIdx === barIdx - 1 && last.color === color) {
      last.to = barTimes[barIdx + 1] ?? from + interval;
    } else {
      backgrounds.push({
        id: `${modelId}:bg${bi++}`,
        paneId: '',
        from,
        to: barTimes[barIdx + 1] ?? from + interval,
        color,
      });
    }
    prevIdx = barIdx;
  }

  // ── barcolor — per-bar candle recolor, keyed by bar time ──
  for (const [barIdx, layer] of [...(r.barcolors ?? new Map<number, Map<string, string>>()).entries()].sort((a, b) => a[0] - b[0])) {
    const colors = [...layer.values()];
    if (!colors.length) continue;
    const time = barTimes[barIdx];
    if (time === undefined) continue;
    barColors.push({ time, color: colors[colors.length - 1]! });
  }

  // ── drawings — x coords stay in Pine form (bar index or epoch ms), tagged
  // by xloc; the renderer resolves them against its own time scale. ──
  for (const d of r.drawings) {
    const p = d.props;
    const did = `${modelId}:d${d.id}`;

    if (d.kind === 'line') {
      const l = mapDrawingLine(p, did);
      if (l) lines.push(l);
    } else if (d.kind === 'label') {
      const x = propNum(p, 'x');
      if (x === undefined) continue;
      const ylocRaw = (propStr(p, 'yloc') ?? 'yloc.price').split('.').pop() ?? 'price';
      const yloc = ylocRaw === 'abovebar' ? 'abovebar' : ylocRaw === 'belowbar' ? 'belowbar' : 'price';
      const text = propStr(p, 'text');
      labels.push({
        id: did, paneId: '',
        xloc: xlocOf(propStr(p, 'xloc')),
        x,
        y: propNum(p, 'y') ?? 0,
        yloc,
        text: text !== undefined && text !== '' ? text : undefined,
        style: labelStyleOf(propStr(p, 'style')) as ModelLabel['style'],
        color: propStr(p, 'color'),
        noFill: propStr(p, 'color') === undefined,
        textColor: propStr(p, 'textcolor'),
        size: labelSizeOf(propStr(p, 'size')),
        textAlign: alignOf(propStr(p, 'textalign')),
        tooltip: propStr(p, 'tooltip'),
        fontFamily: 'default',
      });
    } else if (d.kind === 'box') {
      const left = propNum(p, 'left'), top = propNum(p, 'top');
      const right = propNum(p, 'right'), bottom = propNum(p, 'bottom');
      if (left === undefined || top === undefined || right === undefined || bottom === undefined) continue;
      const text = propStr(p, 'text');
      boxes.push({
        id: did, paneId: '',
        xloc: xlocOf(propStr(p, 'xloc')),
        left, top, right, bottom,
        extend: extendOf(propStr(p, 'extend')),
        bgColor: propStr(p, 'bgcolor'),
        borderColor: propStr(p, 'border_color'),
        borderWidth: Math.max(0, propNum(p, 'border_width') ?? 1),
        borderStyle: styleOf(propStr(p, 'border_style')),
        text: text !== undefined && text !== '' ? text : undefined,
        textColor: propStr(p, 'text_color'),
        textSize: textSizeOf(propStr(p, 'text_size')),
        hAlign: alignOf(propStr(p, 'text_halign')),
        vAlign: valignOf(propStr(p, 'text_valign')),
        wrap: (propStr(p, 'text_wrap') ?? '').includes('auto'),
        fontFamily: 'default',
        bold: false,
        italic: false,
      });
    } else if (d.kind === 'table') {
      // props.cells is a live Map<'col,row', CellProps> — serialize to the
      // row-major grid Vela's DrawingTable expects.
      const cols = Math.max(0, propNum(p, 'columns') ?? 1);
      const rows = Math.max(0, propNum(p, 'rows') ?? 1);
      const posRaw = (propStr(p, 'position') ?? 'position.top_center').split('.').pop() ?? 'top_center';
      const position = (['top_left', 'top_center', 'top_right', 'middle_left', 'middle_center', 'middle_right', 'bottom_left', 'bottom_center', 'bottom_right'] as const)
        .includes(posRaw as 'top_left') ? (posRaw as ModelTable['position']) : 'top_center';
      const cells: ModelTableCell[][] = Array.from({ length: rows }, () => new Array<ModelTableCell>(cols).fill(null));
      const cellMap = p['cells'];
      if (cellMap instanceof Map) {
        for (const [key, cell] of cellMap as Map<string, Record<string, unknown>>) {
          const [colRaw, rowRaw] = key.split(',').map(Number);
          const col = colRaw ?? NaN, row = rowRaw ?? NaN;
          if (!Number.isInteger(col) || !Number.isInteger(row)
            || col < 0 || col >= cols || row < 0 || row >= rows) continue;
          const rawSize = propStr(cell, 'text_size');
          const sizeNum = rawSize !== undefined && !rawSize.startsWith('size.') ? Number(rawSize) : NaN;
          cells[row]![col] = {
            text: propStr(cell, 'text'),
            textColor: propStr(cell, 'text_color'),
            bgColor: propStr(cell, 'bgcolor'),
            hAlign: alignOf(propStr(cell, 'text_halign')),
            vAlign: valignOf(propStr(cell, 'text_valign')),
            // numeric text_size = raw pixels; named sizes map via textSizeOf.
            textSize: Number.isFinite(sizeNum) ? sizeNum : textSizeOf(rawSize),
            fontFamily: 'default',
            tooltip: propStr(cell, 'tooltip'),
            width: propNum(cell, 'width'),
            height: propNum(cell, 'height'),
            bold: false,
            italic: false,
          };
        }
      }
      const merges = (p['merges'] as { c1: number; r1: number; c2: number; r2: number }[] | undefined)
        ?.map(m => ({ startCol: m.c1, startRow: m.r1, endCol: m.c2, endRow: m.r2 })) ?? [];
      tables.push({
        id: did, paneId: '',
        position,
        columns: cols, rows,
        bgColor: propStr(p, 'bgcolor'),
        frameColor: propStr(p, 'frame_color'),
        frameWidth: Math.max(0, propNum(p, 'frame_width') ?? 0),
        borderColor: propStr(p, 'border_color'),
        borderWidth: Math.max(0, propNum(p, 'border_width') ?? 0),
        cells,
        merges,
      });
    } else if (d.kind === 'polyline') {
      const pts = (p['points'] as { x: number; y: number }[] | undefined) ?? [];
      if (pts.length === 0) continue;
      const xloc = xlocOf(propStr(p, 'xloc'));
      const styleStr = (propStr(p, 'line_style') ?? '').toLowerCase();
      polylines.push({
        id: did, paneId: '',
        points: pts.map(pt => ({ xloc, x: pt.x, price: pt.y })),
        curved: p['curved'] === true,
        closed: p['closed'] === true,
        lineColor: propStr(p, 'line_color'),
        fillColor: propStr(p, 'fill_color'),
        lineWidth: Math.max(1, propNum(p, 'line_width') ?? 1),
        lineStyle: styleOf(propStr(p, 'line_style')),
        arrowLeft: styleStr.includes('arrow_left') || styleStr.includes('arrow_both'),
        arrowRight: styleStr.includes('arrow_right') || styleStr.includes('arrow_both'),
        overlay: p['force_overlay'] === true ? true : undefined,
      });
    } else if (d.kind === 'linefill') {
      // props.line1/line2 hold the live line DrawObjs — endpoint edits made
      // after linefill.new (line.set_xy1 …) are already reflected.
      const l1 = mapDrawingLine((p['line1'] as DrawObj | undefined)?.props ?? {}, `${did}:l1`);
      const l2 = mapDrawingLine((p['line2'] as DrawObj | undefined)?.props ?? {}, `${did}:l2`);
      if (!l1 || !l2) continue;
      linefills.push({
        id: did, paneId: '',
        line1: l1, line2: l2,
        color: propStr(p, 'color'),
        overlay: p['force_overlay'] === true ? true : undefined,
      });
    }
  }

  return {
    id: modelId,
    title: r.title || req.prepared.meta.title,
    shorttitle: r.shorttitle ?? req.prepared.meta.shorttitle,
    overlay: r.overlay,
    paneHint: r.overlay ? 'price' : 'new',
    series,
    fills,
    backgrounds,
    priceLines,
    lines: lines.length > 0 ? lines : undefined,
    boxes: boxes.length > 0 ? boxes : undefined,
    labels: labels.length > 0 ? labels : undefined,
    tables: tables.length > 0 ? tables : undefined,
    polylines: polylines.length > 0 ? polylines : undefined,
    linefills: linefills.length > 0 ? linefills : undefined,
    barColors: barColors.length > 0 ? barColors : undefined,
    trades: (r.execs && r.execs.length > 0)
      ? r.execs
          .map(e => ({
            time: barTimes[e.bar] ?? 0,
            price: e.price,
            side: (e.dir > 0 ? 'buy' : 'sell') as 'buy' | 'sell',
            kind: e.kind,
            label: e.label,
            qty: e.qty,
            tradeId: `t${e.tradeId}`,
          }))
          .filter(e => e.time > 0)
      : undefined,
    inputs: req.prepared.inputs,
    inputValues: { ...inputDefaults(req.prepared.inputs), ...(req.inputs ?? {}), ...(inputOverrides ?? {}) },
  };
};

const inputDefaults = (schemas: InputSchema[]): Record<string, InputValue> => {
  const out: Record<string, InputValue> = {};
  for (const s of schemas) out[s.key] = s.defval;
  return out;
};
