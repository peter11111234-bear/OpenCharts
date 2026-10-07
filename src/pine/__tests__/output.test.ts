// Tests for builtins/input.ts, builtins/plot.ts, builtins/draw.ts.
// Drives BUILTINS directly with a mock RtCtx (interpreter not required):
// each call gets ctx.callsite set like the interpreter would.

import { describe, it, expect, beforeAll } from 'vitest';
import { Series, NA, VTRUE, VFALSE } from '../contracts';
import type { BarData, BuiltinFn, DrawObj, PlotOpts, PlotSink, Value } from '../contracts';
import { BUILTINS, getConstant } from '../builtins/registry';
import type { RtCtx } from '../builtins/util';
import '../builtins/input';
import '../builtins/plot';
import '../builtins/draw';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { PineInterpreterEngine, buildModel } from '../engine';

// ── helpers ─────────────────────────────────────────────────────────────────

export function mkBars(n: number): BarData[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 60000,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000 + i * 10,
  }));
}

function mkCtx(barCount: number): RtCtx {
  const s = () => new Series();
  return {
    barIndex: 0,
    barCount,
    open: s(), high: s(), low: s(), close: s(),
    volume: s(), time: s(), hl2: s(), hlc3: s(), ohlc4: s(), hlcc4: s(),
    plots: [], drawings: [], warnings: [], alerts: [],
    syminfo: {},
    timeframe: {
      period: '1', multiplier: 1, isseconds: false, isminutes: true,
      isdaily: false, isweekly: false, ismonthly: false, isintraday: true,
    },
    callUdf: () => NA,
  };
}

/** Feed one bar into all ctx series (call before setting barIndex per bar). */
function feed(ctx: RtCtx, b: BarData): void {
  ctx.open.set({ kind: 'float', v: b.open });
  ctx.high.set({ kind: 'float', v: b.high });
  ctx.low.set({ kind: 'float', v: b.low });
  ctx.close.set({ kind: 'float', v: b.close });
  ctx.volume.set({ kind: 'float', v: b.volume });
  ctx.time.set({ kind: 'int', v: b.openTime });
  ctx.hl2.set({ kind: 'float', v: (b.high + b.low) / 2 });
  ctx.hlc3.set({ kind: 'float', v: (b.high + b.low + b.close) / 3 });
  ctx.ohlc4.set({ kind: 'float', v: (b.open + b.high + b.low + b.close) / 4 });
  ctx.hlcc4.set({ kind: 'float', v: (b.high + b.low + 2 * b.close) / 4 });
}

function fn(key: string): BuiltinFn {
  const f = BUILTINS.get(key);
  if (!f) throw new Error(`builtin ${key} not registered`);
  return f;
}

/** Call a builtin as the interpreter would: set callsite, pass args. */
function call(ctx: RtCtx, key: string, callsite: string, args: Value[] = [], named: Record<string, Value> = {}): Value {
  ctx.callsite = callsite;
  return fn(key)(ctx, args, named);
}

/** The recording sink appended by plot builtins carries a `buf` — narrow to it. */
function buf(ctx: RtCtx, i: number): { value: Value; opts: PlotOpts }[] {
  const sink: PlotSink = ctx.plots[i]!;
  if ('buf' in sink && Array.isArray(sink.buf)) {
    return sink.buf as { value: Value; opts: PlotOpts }[];
  }
  throw new Error(`plots[${i}] is not a recording sink`);
}

function numOf(v: Value): number {
  if (v.kind === 'int' || v.kind === 'float') return v.v;
  throw new Error(`expected numeric Value, got ${v.kind}`);
}

function arrOf(v: Value): Value[] {
  if (v.kind === 'array') return v.v;
  throw new Error(`expected array Value, got ${v.kind}`);
}

function drawObjOf(v: Value): DrawObj {
  switch (v.kind) {
    case 'line': case 'label': case 'box': case 'table':
    case 'polyline': case 'linefill':
      return v.v;
    default:
      throw new Error(`expected drawing Value, got ${v.kind}`);
  }
}

/** Read an extra (non-PlotOpts) option a builtin stashed on opts. */
function optExtra(opts: PlotOpts, key: string): unknown {
  return (opts as unknown as Record<string, unknown>)[key];
}

const f = (v: number): Value => ({ kind: 'float', v });
const s = (v: string): Value => ({ kind: 'string', v });
const b = (v: boolean): Value => (v ? VTRUE : VFALSE);
const col = (v: string): Value => ({ kind: 'color', v });

// ── input.* ─────────────────────────────────────────────────────────────────

describe('input.*', () => {
  it('input.int records schema and returns defval', () => {
    const ctx = mkCtx(1);
    const v = call(ctx, 'input.int', '#0', [f(10), s('x')], { minval: f(1) });
    expect(v).toEqual({ kind: 'int', v: 10 });
    expect(ctx.inputSchemas).toHaveLength(1);
    expect(ctx.inputSchemas![0]).toMatchObject({ id: 'x', name: 'x', type: 'int', defval: 10, minval: 1 });
  });

  it('input.int honors ctx.inputs override (by title)', () => {
    const ctx = mkCtx(1);
    ctx.inputs = { Length: 21 };
    const v = call(ctx, 'input.int', '#0', [f(14), s('Length')]);
    expect(v).toEqual({ kind: 'int', v: 21 });
  });

  it('input.* variants register schemas with correct types', () => {
    const ctx = mkCtx(1);
    call(ctx, 'input.bool', '#0', [b(true), s('flag')]);
    call(ctx, 'input.string', '#1', [s('AAPL'), s('sym')]);
    call(ctx, 'input.color', '#2', [col('#FF0000'), s('c')]);
    call(ctx, 'input.timeframe', '#3', [s('D'), s('tf')]);
    call(ctx, 'input.session', '#4', [s('0930-1600'), s('sess')]);
    call(ctx, 'input.symbol', '#5', [s('TXF'), s('symbol')]);
    call(ctx, 'input.time', '#6', [{ kind: 'int', v: 1700000000000 }, s('t')]);
    call(ctx, 'input.text_area', '#7', [s('note'), s('ta')]);
    call(ctx, 'input.price', '#8', [f(5), s('p')]);
    const types = ctx.inputSchemas!.map(x => x.type);
    expect(types).toEqual(['bool', 'string', 'color', 'timeframe', 'session', 'symbol', 'time', 'text_area', 'price']);
  });

  it('input.source(close) returns the close Series', () => {
    const ctx = mkCtx(3);
    feed(ctx, mkBars(3)[2]!);
    const v = call(ctx, 'input.source', '#0', [{ kind: 'series', v: ctx.close }, s('src')]);
    expect(v).toEqual({ kind: 'series', v: ctx.close });
    expect(ctx.inputSchemas![0]).toMatchObject({ type: 'source', defval: 'close' });
  });

  it('input.source accepts a string defval and ctx override', () => {
    const ctx = mkCtx(1);
    const v = call(ctx, 'input.source', '#0', [s('hl2'), s('src')]);
    expect(v).toEqual({ kind: 'series', v: ctx.hl2 });
    ctx.inputs = { src: 'high' };
    const v2 = call(ctx, 'input.source', '#0', [s('hl2'), s('src')]);
    expect(v2).toEqual({ kind: 'series', v: ctx.high });
  });

  it('dedups schema pushes across bars', () => {
    const ctx = mkCtx(2);
    for (let i = 0; i < 2; i++) {
      ctx.barIndex = i;
      call(ctx, 'input.int', '#0', [f(10), s('x')]);
    }
    expect(ctx.inputSchemas).toHaveLength(1);
  });

  // The interpreter wraps every non-Series arg in a BarSeries (evalArg), so the
  // defval a scalar input receives arrives as `{kind:'series'}` — it must be
  // unwrapped to its current value, not stringified to the 'close' placeholder.
  const wrapped = (v: Value): Value => {
    const s = new Series(4);
    s.set(v);
    return { kind: 'series', v: s };
  };

  it('unwraps series-wrapped scalar defvals', () => {
    const ctx = mkCtx(1);
    expect(call(ctx, 'input.int', '#0', [wrapped({ kind: 'int', v: 55 }), s('P')]))
      .toEqual({ kind: 'int', v: 55 });
    expect(call(ctx, 'input.bool', '#1', [wrapped(b(false)), s('BF')]))
      .toEqual({ kind: 'bool', v: false });
    expect(call(ctx, 'input.string', '#2', [wrapped(s('hi')), s('S')]))
      .toEqual({ kind: 'string', v: 'hi' });
    expect(ctx.inputSchemas!.map(x => x.defval)).toEqual([55, false, 'hi']);
  });

  it('generic input() infers a scalar kind from a wrapped defval, still treats a price series as source', () => {
    const ctx = mkCtx(1);
    expect(call(ctx, 'input', '#0', [wrapped({ kind: 'int', v: 7 }), s('N')]))
      .toEqual({ kind: 'int', v: 7 });
    expect(ctx.inputSchemas![0]).toMatchObject({ type: 'int', defval: 7 });
    expect(call(ctx, 'input', '#1', [{ kind: 'series', v: ctx.close }, s('Src')]))
      .toEqual({ kind: 'series', v: ctx.close });
    expect(ctx.inputSchemas![1]).toMatchObject({ type: 'source', defval: 'close' });
  });

  it('keeps one schema for CJK titles (fallback id is stable per call site)', () => {
    const ctx = mkCtx(3);
    for (let i = 0; i < 3; i++) {
      ctx.barIndex = i;
      call(ctx, 'input.int', '#7', [wrapped({ kind: 'int', v: 5 }), s('顯示')]);
    }
    expect(ctx.inputSchemas).toHaveLength(1);
    expect(ctx.inputSchemas![0]).toMatchObject({ name: '顯示', type: 'int', defval: 5 });
  });
});

// ── plot / hline / fill / colors / alerts ───────────────────────────────────

describe('plot family', () => {
  it('plot(close, "C", color.red) pushes aligned series values', () => {
    const bars = mkBars(4);
    const ctx = mkCtx(bars.length);
    for (let i = 0; i < bars.length; i++) {
      feed(ctx, bars[i]!);
      ctx.barIndex = i;
      call(ctx, 'plot', '#0', [{ kind: 'series', v: ctx.close }, s('C'), col('#FF0000')]);
    }
    const out = buf(ctx, 0);
    expect(out).toHaveLength(4);
    expect(out.map(e => numOf(e.value))).toEqual(bars.map(x => x.close));
    expect(out[0]!.opts.color).toBe('#FF0000');
    expect(out[0]!.opts.title).toBe('C');
  });

  it('distinct callsites route to distinct sinks; same callsite stays put', () => {
    const bars = mkBars(2);
    const ctx = mkCtx(bars.length);
    for (let i = 0; i < bars.length; i++) {
      feed(ctx, bars[i]!);
      ctx.barIndex = i;
      call(ctx, 'plot', '#0', [{ kind: 'series', v: ctx.close }]);
      call(ctx, 'plot', '#1', [{ kind: 'series', v: ctx.open }]);
    }
    expect(buf(ctx, 0).map(e => numOf(e.value))).toEqual(bars.map(x => x.close));
    expect(buf(ctx, 1).map(e => numOf(e.value))).toEqual(bars.map(x => x.open));
  });

  it('plotshape emits a marker value only when cond is truthy', () => {
    const bars = mkBars(2);
    const ctx = mkCtx(bars.length);
    for (let i = 0; i < bars.length; i++) {
      feed(ctx, bars[i]!);
      ctx.barIndex = i;
      call(ctx, 'plotshape', '#0', [b(i === 0)], {
        style: s('shape.triangleup'), location: s('location.belowbar'), color: col('#00FF00'),
      });
    }
    const out = buf(ctx, 0);
    expect(out[0]!.value).toEqual({ kind: 'float', v: bars[0]!.low });
    expect(out[1]!.value.kind).toBe('na');
    expect(optExtra(out[0]!.opts, 'marker')).toBe('shape.triangleup');
    expect(optExtra(out[0]!.opts, 'location')).toBe('location.belowbar');
    expect(out[0]!.opts.color).toBe('#00FF00');
  });

  it('plotchar and plotarrow emit markers', () => {
    const bars = mkBars(1);
    const ctx = mkCtx(1);
    feed(ctx, bars[0]!);
    call(ctx, 'plotchar', '#0', [VTRUE, s('t'), s('▲')]);
    call(ctx, 'plotarrow', '#1', [f(1), s('t')]);
    call(ctx, 'plotarrow', '#2', [f(-1), s('t')]);
    expect(buf(ctx, 0)[0]!.value).toEqual({ kind: 'float', v: bars[0]!.high }); // plotchar default location.abovebar → high
    // plotarrow pushes the signed condition — engine maps sign → direction+position.
    expect(buf(ctx, 1)[0]!.value).toEqual({ kind: 'float', v: 1 });   // up
    expect(buf(ctx, 2)[0]!.value).toEqual({ kind: 'float', v: -1 });  // down
  });

  it('plotcandle pushes an OHLC array', () => {
    const ctx = mkCtx(1);
    feed(ctx, mkBars(1)[0]!);
    call(ctx, 'plotcandle', '#0', [
      { kind: 'series', v: ctx.open }, { kind: 'series', v: ctx.high },
      { kind: 'series', v: ctx.low }, { kind: 'series', v: ctx.close },
    ]);
    const v = buf(ctx, 0)[0]!.value;
    expect(arrOf(v).map(numOf)).toEqual([100, 101, 99, 100.5]);
  });

  it('plotbar pushes an OHLC array', () => {
    const ctx = mkCtx(1);
    feed(ctx, mkBars(1)[0]!);
    call(ctx, 'plotbar', '#0', [
      { kind: 'series', v: ctx.open }, { kind: 'series', v: ctx.high },
      { kind: 'series', v: ctx.low }, { kind: 'series', v: ctx.close },
    ]);
    expect(arrOf(buf(ctx, 0)[0]!.value).map(numOf)).toEqual([100, 101, 99, 100.5]);
  });

  it('hline(70) pushes a constant line', () => {
    const ctx = mkCtx(3);
    for (let i = 0; i < 3; i++) {
      ctx.barIndex = i;
      call(ctx, 'hline', '#0', [f(70)]);
    }
    const out = buf(ctx, 0);
    expect(out.map(e => numOf(e.value))).toEqual([70, 70, 70]);
    expect(optExtra(out[0]!.opts, 'style')).toBe('hline');
  });

  it('hline(na) emits no sink', () => {
    const ctx = mkCtx(1);
    call(ctx, 'hline', '#0', [NA]);
    expect(ctx.plots.length).toBe(0);
    // hline(50) unchanged
    call(ctx, 'hline', '#0', [f(50)]);
    expect(buf(ctx, 0).map(e => numOf(e.value))).toEqual([50]);
  });

  it('fill links two plot ids', () => {
    const ctx = mkCtx(1);
    feed(ctx, mkBars(1)[0]!);
    const a = call(ctx, 'plot', '#0', [{ kind: 'series', v: ctx.close }]);
    const bb = call(ctx, 'plot', '#1', [{ kind: 'series', v: ctx.open }]);
    call(ctx, 'fill', '#2', [a, bb, col('rgba(0,255,0,0.3)')]);
    expect(ctx.fills![0]).toMatchObject({ plot1: 0, plot2: 1, color: 'rgba(0,255,0,0.3)' });
  });

  it('fill links two hline ids', () => {
    const ctx = mkCtx(1);
    feed(ctx, mkBars(1)[0]!);
    const h1 = call(ctx, 'hline', '#0', [f(50)]);
    const h2 = call(ctx, 'hline', '#1', [f(60)]);
    call(ctx, 'fill', '#2', [h1, h2, col('#FF0000')]);
    expect(ctx.fills!.length).toBe(1);
    expect(ctx.fills![0]).toMatchObject({ plot1: 0, plot2: 1, color: '#FF0000' });
  });

  it('fill links a plot id and an hline id', () => {
    const ctx = mkCtx(1);
    feed(ctx, mkBars(1)[0]!);
    const p = call(ctx, 'plot', '#0', [{ kind: 'series', v: ctx.close }]);
    const h = call(ctx, 'hline', '#1', [f(50)]);
    call(ctx, 'fill', '#2', [p, h, col('rgba(255,0,0,0.5)')]);
    expect(ctx.fills!.length).toBe(1);
    expect(ctx.fills![0]).toMatchObject({ plot1: 0, plot2: 1, color: 'rgba(255,0,0,0.5)' });
  });

  it('fill is one object per callsite — repeated bars update, not append', () => {
    const ctx = mkCtx(3);
    const bars = mkBars(3);
    for (let i = 0; i < 3; i++) {
      ctx.barIndex = i;
      feed(ctx, bars[i]!);
      const h1 = call(ctx, 'hline', '#0', [f(50)]);
      const h2 = call(ctx, 'hline', '#1', [f(60)]);
      call(ctx, 'fill', '#2', [h1, h2, col(i === 2 ? '#00FF00' : '#FF0000')]);
    }
    expect(ctx.fills!.length).toBe(1);
    // Latest bar's color wins — TV updates the existing fill object.
    expect(ctx.fills![0]!.color).toBe('#00FF00');
  });

  it('bgcolor/barcolor record per-bar color events; na clears', () => {
    const ctx = mkCtx(3);
    for (let i = 0; i < 3; i++) {
      ctx.barIndex = i;
      call(ctx, 'bgcolor', '#0', [i === 1 ? col('#112233') : NA]);
      call(ctx, 'barcolor', '#1', [i === 2 ? col('#445566') : NA]);
    }
    expect([...ctx.bgcolors!.get(1)!.values()]).toEqual(['#112233']);
    expect(ctx.bgcolors!.has(0)).toBe(false);
    expect([...ctx.barcolors!.get(2)!.values()]).toEqual(['#445566']);
  });

  it('bgcolor callsites are independent layers — na clears only its own layer', () => {
    const ctx = mkCtx(2);
    ctx.barIndex = 0;
    call(ctx, 'bgcolor', '#0', [col('#112233')]);
    call(ctx, 'bgcolor', '#1', [col('#445566')]);
    // Callsite #0 passes na on bar 0 → clears only its own layer; #1's stays.
    ctx.barIndex = 1;
    call(ctx, 'bgcolor', '#0', [NA]);
    call(ctx, 'bgcolor', '#1', [col('#778899')]);
    expect(ctx.bgcolors!.get(0)).toEqual(new Map([['#0', '#112233'], ['#1', '#445566']]));
    expect(ctx.bgcolors!.get(1)).toEqual(new Map([['#1', '#778899']]));
  });

  it('alertcondition registers the condition only; alert() gates on freq', () => {
    const ctx = mkCtx(1);
    // alertcondition registers a condition for the Create Alert dialog — it
    // never fires a runtime alert, so ctx.alerts stays empty.
    call(ctx, 'alertcondition', '#0', [VTRUE, s('xover'), s('crossed up')]);
    expect(ctx.alertconditions).toEqual([{ title: 'xover', msg: 'crossed up' }]);
    expect(ctx.alerts).toHaveLength(0);

    // alert() same bar same callsite → only once per bar
    call(ctx, 'alert', '#1', [s('hi'), s('alert.freq_once_per_bar')]);
    call(ctx, 'alert', '#1', [s('hi'), s('alert.freq_once_per_bar')]);
    expect(ctx.alerts).toHaveLength(1);
    call(ctx, 'alert', '#1', [s('hi'), s('alert.freq_all')]);
    expect(ctx.alerts).toHaveLength(2);
  });
});

// ── alertcondition → RunResult ───────────────────────────────────────────────

describe('alertcondition reaches RunResult', () => {
  it('runScript carries registered alertconditions out of the interpreter', async () => {
    const bars = mkBars(5);
    const r = await runScript(
      parse([
        'indicator("AC", overlay=true)',
        'alertcondition(close > open, "up", "crossed up")',
        'alertcondition(close < open, "down", "crossed down")',
      ].join('\n')),
      bars,
    );
    expect(r.alertconditions).toEqual([
      { title: 'up', msg: 'crossed up' },
      { title: 'down', msg: 'crossed down' },
    ]);
    // Registration-only: it never becomes a runtime alert().
    expect(r.alerts).toHaveLength(0);
  });

  it('registers once per title even though alertcondition runs every bar', async () => {
    const bars = mkBars(6);
    const r = await runScript(
      parse([
        'indicator("AC", overlay=true)',
        'alertcondition(close > open, "up", "crossed up")',
      ].join('\n')),
      bars,
    );
    expect(r.alertconditions).toEqual([{ title: 'up', msg: 'crossed up' }]);
  });

  it('a false condition still registers — Pine defines the template, the alert engine evaluates it', async () => {
    const bars = mkBars(3);
    const r = await runScript(
      parse([
        'indicator("AC", overlay=true)',
        'alertcondition(false, "never", "never fires")',
      ].join('\n')),
      bars,
    );
    expect(r.alertconditions).toEqual([{ title: 'never', msg: 'never fires' }]);
  });

  it('no alertcondition call → empty array, and a zero-bar run still carries it', async () => {
    const bars = mkBars(3);
    const r = await runScript(parse('indicator("AC", overlay=true)\nplot(close)'), bars);
    expect(r.alertconditions).toEqual([]);

    // No alertcondition in source means nothing can be registered; the field is
    // still present (never undefined) so callers need no optional chaining.
    const empty = await runScript(parse('indicator("AC")'), []);
    expect(empty.alertconditions).toEqual([]);
  });

  it('buildModel does not drop or mangle them (IndicatorModel has no alert field)', async () => {
    const bars = mkBars(4);
    const src = [
      'indicator("AC", overlay=true)',
      'alertcondition(close > open, "up", "crossed up")',
    ].join('\n');
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(src, 't1');
    const r = await runScript(parse(src), bars, { symbol: 'TEST', timeframe: '60' });
    const token = prepared.token as { modelId: string };
    const model = buildModel(
      token.modelId,
      { prepared, market: { symbol: 'TEST', timeframe: '60' }, bars: bars.map(b => ({
        time: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
      })), mode: 'static' },
      r,
      bars.map(b => b.openTime),
    );
    // RunResult is the sole outlet — Vela's IndicatorModel carries no alerts
    // or alertConditions field, so nothing lands on the model.
    expect(r.alertconditions).toHaveLength(1);
    expect('alertconditions' in model).toBe(false);
    expect('alerts' in model).toBe(false);
  });
});

// ── drawings ────────────────────────────────────────────────────────────────

describe('drawings', () => {
  it('line.new creates a DrawObj, setters mutate, delete removes', () => {
    const ctx = mkCtx(1);
    const l = call(ctx, 'line.new', '#0', [f(0), f(100), f(10), f(110)]);
    expect(l.kind).toBe('line');
    const obj = drawObjOf(l);
    expect(obj.props).toMatchObject({ x1: 0, y1: 100, x2: 10, y2: 110 });
    expect(ctx.liveLines).toHaveLength(1);

    call(ctx, 'line.set_x2', '#1', [l, f(20)]);
    call(ctx, 'line.set_color', '#2', [l, col('#ABCDEF')]);
    expect(obj.props.x2).toBe(20);
    expect(obj.props.color).toBe('#ABCDEF');

    call(ctx, 'line.set_xy1', '#3', [l, f(5), f(50)]);
    expect(obj.props).toMatchObject({ x1: 5, y1: 50 });

    call(ctx, 'line.delete', '#4', [l]);
    expect(ctx.liveLines).toHaveLength(0);
  });

  it('line.get_* reads props; line.get_price interpolates', () => {
    const ctx = mkCtx(1);
    const l = call(ctx, 'line.new', '#0', [f(0), f(0), f(10), f(100)]);
    expect(call(ctx, 'line.get_y2', '#1', [l])).toEqual({ kind: 'int', v: 100 });
    // barIndex 5 → midpoint 50
    expect(numOf(call(ctx, 'line.get_price', '#2', [l, f(5)]))).toBe(50);
  });

  it('label.new / set_text / delete', () => {
    const ctx = mkCtx(1);
    const lb = call(ctx, 'label.new', '#0', [f(0), f(100), s('hello')], {
      style: s('label.style_label_up'), color: col('#123456'),
    });
    expect(lb.kind).toBe('label');
    const obj = drawObjOf(lb);
    expect(obj.props.text).toBe('hello');
    call(ctx, 'label.set_text', '#1', [lb, s('bye')]);
    expect(obj.props.text).toBe('bye');
    call(ctx, 'label.delete', '#2', [lb]);
    expect(ctx.liveLabels).toHaveLength(0);
  });

  it('box.new / set_rightbottom / delete', () => {
    const ctx = mkCtx(1);
    const bx = call(ctx, 'box.new', '#0', [f(0), f(110), f(10), f(90)], {
      bgcolor: col('rgba(0,0,255,0.2)'),
    });
    expect(bx.kind).toBe('box');
    const obj = drawObjOf(bx);
    call(ctx, 'box.set_rightbottom', '#1', [bx, f(20), f(80)]);
    expect(obj.props).toMatchObject({ right: 20, bottom: 80 });
    call(ctx, 'box.delete', '#2', [bx]);
    expect(ctx.liveBoxes).toHaveLength(0);
  });

  it('table.new / cell / merge_cells / clear', () => {
    const ctx = mkCtx(1);
    const t = call(ctx, 'table.new', '#0', [s('position.top_right'), f(2), f(2)]);
    expect(t.kind).toBe('table');
    const obj = drawObjOf(t);
    call(ctx, 'table.cell', '#1', [t, f(0), f(0), s('A')]);
    call(ctx, 'table.cell', '#2', [t, f(1), f(1), s('B')]);
    call(ctx, 'table.merge_cells', '#3', [t, f(0), f(0), f(1), f(0)]);

    const cells = obj.props.cells;
    if (!(cells instanceof Map)) throw new Error('cells not a Map');
    expect((cells.get('0,0') as { text: string }).text).toBe('A');
    expect((cells.get('1,1') as { text: string }).text).toBe('B');
    expect(Array.isArray(obj.props.merges)).toBe(true);

    call(ctx, 'table.clear', '#4', [t, f(0), f(0), f(0), f(0)]);
    expect(cells.has('0,0')).toBe(false);
    expect(cells.has('1,1')).toBe(true);
    call(ctx, 'table.clear', '#5', [t]);
    expect(cells.size).toBe(0);
  });

  it('line.all reflects live objects via lazy constants', () => {
    const ctx = mkCtx(1);
    const l1 = call(ctx, 'line.new', '#0', [f(0), f(1), f(2), f(3)]);
    call(ctx, 'line.new', '#1', [f(0), f(1), f(2), f(3)]);
    const all = getConstant('line.all', ctx)!;
    expect(arrOf(all)).toHaveLength(2);
    call(ctx, 'line.delete', '#2', [l1]);
    expect(arrOf(getConstant('line.all', ctx)!)).toHaveLength(1);
  });
});

// ── enum constants ──────────────────────────────────────────────────────────

describe('enum constants', () => {
  it('shape/location/size/line.style_*/label.style_*/barmerge/alert.freq_* resolve', () => {
    for (const k of [
      'shape.triangleup', 'shape.xcross', 'location.belowbar', 'location.abovebar',
      'size.tiny', 'size.huge', 'line.style_solid', 'line.style_dashed',
      'label.style_label_up', 'label.style_xcross',
      'hline.style_solid', 'hline.style_dotted',
      'barmerge.gaps_off', 'barmerge.gaps_on', 'barmerge.lookahead_off', 'barmerge.lookahead_on',
      'alert.freq_once_per_bar', 'alert.freq_once_per_bar_close', 'alert.freq_all',
      'xloc.bar_index', 'xloc.bar_time', 'yloc.price', 'yloc.abovebar', 'yloc.belowbar',
      'extend.none', 'extend.both', 'position.top_right', 'display.all', 'display.none',
      'plot.style_line', 'plot.style_histogram', 'plot.style_columns',
      'text.align_left', 'text.wrap_none', 'text.format_mintick',
    ]) {
      const v = getConstant(k);
      expect(v, k).toBeDefined();
      if (v?.kind !== 'string') throw new Error(`${k} not a string constant`);
      expect(v.v).toBe(k);
    }
  });
});

beforeAll(() => {
  // sanity: every expected builtin key registered
  for (const k of [
    'plot', 'plotshape', 'plotchar', 'plotarrow', 'plotbar', 'plotcandle',
    'hline', 'fill', 'bgcolor', 'barcolor', 'alertcondition', 'alert',
    'input', 'input.int', 'input.float', 'input.bool', 'input.string',
    'input.color', 'input.timeframe', 'input.source', 'input.price',
    'input.session', 'input.symbol', 'input.time', 'input.text_area',
    'line.new', 'line.delete', 'line.set_x1', 'line.set_xy1', 'line.get_price',
    'label.new', 'label.set_text', 'label.delete',
    'box.new', 'box.set_rightbottom', 'box.delete',
    'table.new', 'table.cell', 'table.merge_cells', 'table.clear',
    'chart.point.new', 'chart.point.from_index', 'chart.point.from_time', 'chart.point.now', 'chart.point.copy',
    'polyline.new', 'polyline.delete',
    'linefill.new', 'linefill.delete', 'linefill.set_line1', 'linefill.set_line2', 'linefill.set_color', 'linefill.get_color',
  ]) {
    expect(BUILTINS.has(k), k).toBe(true);
  }
});
