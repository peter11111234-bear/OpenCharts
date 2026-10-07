// ── Per-bar builtin context builder ──────────────────────────────────────────
// BarCtx pre-creates the OHLCV/derived Series and a single BuiltinCtx object,
// then advances them bar-by-bar (forward-only, matching Pine's bar loop).

import {
  type BarData,
  type BuiltinCtx,
  type DrawObj,
  type DrawSink,
  type PlotOpts,
  type PlotSink,
  type Value,
} from './contracts';
import { BarSeries } from './series';
export type TimeframeInfo = BuiltinCtx['timeframe'];

/**
 * Parse a market/timeframe string ("15", "30S", "4H", "D", "2D", "W", "M")
 * into the BuiltinCtx.timeframe shape. Bare numbers are minutes; 'M' (exactly,
 * uppercase) is months — TradingView convention.
 */
export function parseTimeframe(period: string): TimeframeInfo {
  const p = period.trim();
  const m = /^(\d*)\s*([A-Za-z])?$/.exec(p);
  if (!m || (m[1] === '' && !m[2])) throw new Error(`Pine: cannot parse timeframe '${period}'`);
  const multiplier = m[1]! === '' ? 1 : parseInt(m[1]!, 10);
  if (!(multiplier > 0)) throw new Error(`Pine: timeframe multiplier must be > 0 in '${period}'`);
  const suffix = m[2];
  const unit = suffix === 'M' ? 'month' : suffix?.toLowerCase() === 'm' ? 'min' : (suffix?.toLowerCase() ?? 'min');
  const isseconds = unit === 's';
  const isminutes = unit === 'min' || unit === 'h';
  const isdaily = unit === 'd';
  const isweekly = unit === 'w';
  const ismonthly = unit === 'month';
  return {
    period,
    multiplier,
    isseconds,
    isminutes,
    isdaily,
    isweekly,
    ismonthly,
    isintraday: isseconds || isminutes,
  };
}

export interface BarCtxOpts {
  /** 'PREFIX:TICKER' or bare ticker; feeds syminfo.ticker/tickerid/prefix. */
  symbol?: string;
  /** Timeframe string — '15', 'D', 'W', 'M', '30S', '4H'. Default 'D'. */
  market?: string;
  /** Alias for `market` (ignored when market is set). */
  timeframe?: string;
  fetchSeries?: BuiltinCtx['fetchSeries'];
  plots?: PlotSink[];
  drawings?: DrawSink[];
  /** Partial syminfo overrides, merged over the inferred defaults. */
  syminfo?: Record<string, Value>;
  callUdf?: BuiltinCtx['callUdf'];
}

function buildSyminfo(symbol: string, overrides?: Record<string, Value>): Record<string, Value> {
  const colon = symbol.indexOf(':');
  const hasPrefix = colon > 0;
  const prefix = hasPrefix ? symbol.slice(0, colon) : '';
  const ticker = hasPrefix ? symbol.slice(colon + 1) : symbol;
  const isTW = prefix === 'TWSE' || prefix === 'TPEx' || prefix === 'TPEX' || prefix === 'TAIFEX';
  const info: Record<string, Value> = {
    ticker: { kind: 'string', v: ticker },
    tickerid: { kind: 'string', v: symbol },
    prefix: { kind: 'string', v: prefix },
    description: { kind: 'string', v: ticker },
    type: { kind: 'string', v: 'stock' },
    // TW venue defaults: TWD currency, Asia/Taipei, regular 09:00–13:30 session.
    currency: { kind: 'string', v: isTW ? 'TWD' : 'USD' },
    basecurrency: { kind: 'string', v: isTW ? 'TWD' : 'USD' },
    timezone: { kind: 'string', v: 'Asia/Taipei' },
    session: { kind: 'string', v: 'regular' },
    mintick: { kind: 'float', v: 0.01 },
    pricescale: { kind: 'int', v: 100 },
    pointvalue: { kind: 'float', v: 1 },
    minmov: { kind: 'int', v: 1 },
    volumetype: { kind: 'string', v: 'base' },
  };
  if (overrides) for (const [k, v] of Object.entries(overrides)) info[k] = v;
  return info;
}

const f = (v: number): Value => ({ kind: 'float', v });

/**
 * Forward-only cursor over chart bars. `seek(i)`/`next()` fill every context
 * Series through bar i and return the shared BuiltinCtx (mutated in place —
 * do not retain across bars).
 */
export class BarCtx {
  readonly bars: BarData[];
  readonly barCount: number;
  readonly open = new BarSeries();
  readonly high = new BarSeries();
  readonly low = new BarSeries();
  readonly close = new BarSeries();
  readonly volume = new BarSeries();
  readonly time = new BarSeries();
  readonly hl2 = new BarSeries();
  readonly hlc3 = new BarSeries();
  readonly ohlc4 = new BarSeries();
  readonly hlcc4 = new BarSeries();
  readonly timeframe: TimeframeInfo;
  readonly syminfo: Record<string, Value>;

  private readonly ctx: BuiltinCtx;
  private ctxBar = -1;

  constructor(bars: BarData[], opts: BarCtxOpts = {}) {
    this.bars = bars;
    this.barCount = bars.length;
    this.timeframe = parseTimeframe(opts.market ?? opts.timeframe ?? 'D');
    this.syminfo = buildSyminfo(opts.symbol ?? '', opts.syminfo);
    this.ctx = {
      barIndex: 0,
      barCount: bars.length,
      open: this.open,
      high: this.high,
      low: this.low,
      close: this.close,
      volume: this.volume,
      time: this.time,
      hl2: this.hl2,
      hlc3: this.hlc3,
      ohlc4: this.ohlc4,
      hlcc4: this.hlcc4,
      plots: opts.plots ?? [],
      drawings: opts.drawings ?? [],
      warnings: [],
      alerts: [],
      syminfo: this.syminfo,
      timeframe: this.timeframe,
      callUdf:
        opts.callUdf ??
        (() => {
          throw new Error('Pine: callUdf not wired — interpreter must supply it');
        }),
    };
    if (opts.fetchSeries) this.ctx.fetchSeries = opts.fetchSeries;
  }

  /** Advance to absolute bar `bar` (forward-only). */
  seek(bar: number): BuiltinCtx {
    if (bar < 0 || bar >= this.barCount) {
      throw new Error(`Pine: bar ${bar} out of range (0..${this.barCount - 1})`);
    }
    if (bar < this.ctxBar) throw new Error(`Pine: BarCtx is forward-only (at ${this.ctxBar}, asked ${bar})`);
    for (let i = this.ctxBar + 1; i <= bar; i++) this.pushBar(this.bars[i]!);
    this.ctx.barIndex = bar;
    this.ctxBar = bar;
    return this.ctx;
  }

  /** Advance one bar; null at end of data. */
  next(): BuiltinCtx | null {
    return this.ctxBar + 1 >= this.barCount ? null : this.seek(this.ctxBar + 1);
  }

  private pushBar(b: BarData): void {
    this.open.set(f(b.open));
    this.high.set(f(b.high));
    this.low.set(f(b.low));
    this.close.set(f(b.close));
    this.volume.set(f(b.volume));
    this.time.set({ kind: 'int', v: b.openTime });
    this.hl2.set(f((b.high + b.low) / 2));
    this.hlc3.set(f((b.high + b.low + b.close) / 3));
    this.ohlc4.set(f((b.open + b.high + b.low + b.close) / 4));
    this.hlcc4.set(f((b.high + b.low + b.close + b.close) / 4));
  }
}

/** PlotSink that records every push — tests and RunResult assembly. */
export class CapturingPlotSink implements PlotSink {
  readonly pushes: { value: Value; opts: PlotOpts }[] = [];
  push(value: Value, opts: PlotOpts): void {
    this.pushes.push({ value, opts });
  }
}

/** DrawSink backed by an in-memory object list — tests and RunResult assembly. */
export class MemoryDrawSink implements DrawSink {
  readonly objects: DrawObj[] = [];
  private nextId = 1;
  create(kind: DrawObj['kind'], props: Record<string, unknown>): DrawObj {
    const obj: DrawObj = { id: this.nextId++, kind, props: { ...props } };
    this.objects.push(obj);
    return obj;
  }
  update(obj: DrawObj, props: Record<string, unknown>): void {
    Object.assign(obj.props, props);
  }
  remove(obj: DrawObj): void {
    const i = this.objects.indexOf(obj);
    if (i >= 0) this.objects.splice(i, 1);
  }
}
