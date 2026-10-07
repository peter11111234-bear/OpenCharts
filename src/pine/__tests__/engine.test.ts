import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { PineInterpreterEngine, buildModel } from '../engine';
import type { ExecutionRequest, IndicatorModel, OHLCV, PreparedScript } from '@luxalgo/vela';
import '../builtins/index';
import '../mtf';

const mkBars = (n: number): OHLCV[] => {
  const bars: OHLCV[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 5) * 2;
    bars.push({ time: i * 3600000, open: p, high: p + 1, low: p - 1, close: p + 0.5, volume: 1000 + i });
  }
  return bars;
};

const mkReq = (prepared: PreparedScript, bars: OHLCV[], inputs?: Record<string, number | string | boolean>): ExecutionRequest => ({
  prepared,
  market: { symbol: 'TEST', timeframe: '60' },
  bars,
  inputs,
  mode: 'static',
});

const runModel = async (src: string, bars: OHLCV[], inputs?: Record<string, number | string | boolean>): Promise<IndicatorModel> => {
  const engine = new PineInterpreterEngine();
  const prepared = await engine.prepare(src, 't1');
  const parsed = parse(src);
  const r = await runScript(parsed, bars.map(b => ({ openTime: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 })), { symbol: 'TEST', timeframe: '60' });
  const token = prepared.token as { modelId: string };
  return buildModel(token.modelId, mkReq(prepared, bars, inputs), r, bars.map(b => b.time));
};

const pointValue = (s: IndicatorModel['series'][number], i: number): number | null =>
  s.kind === 'markers' || s.kind === 'candle' || s.kind === 'bar' || !('points' in s) ? null : s.points[i]?.value ?? null;

/** onModel resolves a signal per run — no wall-clock waiting. */
const collect = () => {
  const models: IndicatorModel[] = [];
  const waiters: (() => void)[] = [];
  const onModel = (m: IndicatorModel) => {
    models.push(m);
    waiters.splice(0).forEach(w => w());
  };
  const waitFor = (k: number): Promise<IndicatorModel> => {
    const { promise, resolve } = Promise.withResolvers<IndicatorModel>();
    if (models.length >= k) resolve(models[models.length - 1]!);
    else waiters.push(() => { if (models.length >= k) resolve(models[models.length - 1]!); });
    return promise;
  };
  return { models, onModel, waitFor };
};

describe('buildModel drawing/output mapping', () => {
  it('maps fills, backgrounds, barColors, lines, labels, boxes', async () => {
    const src = `//@version=6
indicator("dr", overlay=true)
a = plot(open, title="a")
b = plot(close, title="b")
fill(a, b, color=color.new(#2962FF, 80), title="f")
bgcolor(close > open ? color.new(color.green, 90) : na)
barcolor(close > open ? color.yellow : na)
if bar_index == 10
    line.new(10, 100, 20, 110, color=color.red, width=2, extend=extend.right)
    label.new(15, 105, text="hi", style=label.style_label_down, color=color.blue, size=size.large)
    box.new(5, 120, 25, 90, bgcolor=color.new(color.orange, 80), border_color=color.white)
`;
    const bars = mkBars(60);
    const model = await runModel(src, bars);
    expect(model.fills).toHaveLength(1);
    expect(model.fills[0]!.fromSeriesId).toBe(model.series[0]!.id);
    expect(model.fills[0]!.toSeriesId).toBe(model.series[1]!.id);
    expect(model.backgrounds.length).toBeGreaterThan(0);
    expect(model.backgrounds[0]!.color).toContain('rgba');
    expect(model.barColors!.length).toBeGreaterThan(0);
    expect(typeof model.barColors![0]!.time).toBe('number');
    expect(model.lines).toHaveLength(1);
    expect(model.lines![0]!.xloc).toBe('bar_index');
    expect(model.lines![0]!.x1).toBe(10);
    expect(model.lines![0]!.extend).toBe('right');
    expect(model.labels).toHaveLength(1);
    expect(model.labels![0]!.text).toBe('hi');
    expect(model.labels![0]!.style).toBe('label_down');
    expect(model.labels![0]!.size).toBe('large');
    expect(model.boxes).toHaveLength(1);
    expect(model.boxes![0]!.left).toBe(5);
    expect(model.boxes![0]!.top).toBe(120);
  });

  it('marker fidelity: shapes, sizes, absolute location, display.none skip', async () => {
    const src = `//@version=6
indicator("mk", overlay=true)
plotshape(bar_index % 5 == 0, style=shape.triangleup, location=location.abovebar, size=size.huge, color=color.green)
plotshape(bar_index % 7 == 0, style=shape.diamond, location=location.absolute, size=size.tiny, color=color.red)
plotshape(true, style=shape.circle, location=location.belowbar, display=display.none)
`;
    const model = await runModel(src, mkBars(40));
    const all = model.series.filter(s => s.kind === 'markers');
    expect(all).toHaveLength(2); // display.none series dropped
    const tri = all[0]!.kind === 'markers' ? all[0]!.markers : [];
    expect(tri[0]!.shape).toBe('triangleUp');
    expect(tri[0]!.position).toBe('aboveBar');
    expect(tri[0]!.size).toBe('huge');
    const dia = all[1]!.kind === 'markers' ? all[1]!.markers : [];
    expect(dia[0]!.shape).toBe('diamond');
    expect(dia[0]!.position).toBe('inBar');
    expect(dia[0]!.size).toBe('tiny');
  });
});

describe('stable ids', () => {
  it('same source → same model + series ids across runs', async () => {
    const src = `//@version=6\nindicator("s", overlay=true)\nplot(close)\nplot(open)\n`;
    const bars = mkBars(30);
    const m1 = await runModel(src, bars);
    const m2 = await runModel(src, bars);
    expect(m1.id).toBe(m2.id);
    expect(m1.series.map(s => s.id)).toEqual(m2.series.map(s => s.id));
  });
});

describe('session input merging', () => {
  it('update() inputs persist through notifyBars re-runs', async () => {
    const engine = new PineInterpreterEngine();
    const src = `//@version=6\nindicator("i", overlay=true)\nn = input.int(5, "len")\nplot(n * 100)\n`;
    const prepared = await engine.prepare(src, 's1');
    const bars = mkBars(20);
    const c = collect();
    const session = engine.execute(mkReq(prepared, bars), { onModel: c.onModel });
    const m1 = await c.waitFor(1);
    expect(pointValue(m1.series[0]!, 0)).toBe(500);
    session.update({ len: 9 });
    const m2 = await c.waitFor(2);
    expect(pointValue(m2.series[0]!, 0)).toBe(900);
    // notifyBars must keep the merged inputs, not revert to req.inputs.
    session.notifyBars();
    const m3 = await c.waitFor(3);
    expect(pointValue(m3.series[0]!, 0)).toBe(900);
    session.stop();
  });

  it('defers first run while historyState=backfill until complete', async () => {
    const engine = new PineInterpreterEngine();
    const src = `//@version=6\nindicator("d")\nplot(close)\n`;
    const prepared = await engine.prepare(src, 's2');
    const bars = mkBars(20);
    const req = mkReq(prepared, bars);
    req.historyState = 'backfill';
    const c = collect();
    const session = engine.execute(req, { onModel: c.onModel });
    session.notifyBars('backfill');
    expect(c.models).toHaveLength(0); // still deferred on partial chunks
    session.notifyBars('complete');
    const m = await c.waitFor(1);
    expect(m.series).toHaveLength(1);
    session.stop();
  });
});

describe('regressions — R2 verification findings', () => {
  it('display.none drops the series; hidden plot still anchors fills', async () => {
    const m = await runModel(
      `//@version=6\nindicator("d")\np1 = plot(close, display=display.none)\np2 = plot(open)\nfill(p1, p2)\n`,
      mkBars(5));
    // Only p2 renders; the hidden p1 series id still resolves the fill anchor.
    expect(m.series).toHaveLength(1);
    expect(m.fills).toHaveLength(1);
  });

  it('plotarrow maps sign → arrowUp/belowBar vs arrowDown/aboveBar', async () => {
    // Alternating close>open / close<open bars so both arrow kinds appear.
    const bars = mkBars(10).map((b, i) => ({ ...b, close: i % 2 ? b.open - 0.5 : b.open + 0.5 }));
    const m = await runModel(
      `//@version=6\nindicator("a")\nplotarrow(close > open ? 1 : close < open ? -1 : na)\n`,
      bars);
    const mk = m.series[0];
    expect(mk?.kind).toBe('markers');
    if (mk?.kind !== 'markers') return;
    const ups = mk.markers.filter(k => k.shape === 'arrowUp');
    const dns = mk.markers.filter(k => k.shape === 'arrowDown');
    expect(ups.length).toBeGreaterThan(0);
    expect(dns.length).toBeGreaterThan(0);
    expect(ups.every(k => k.position === 'belowBar')).toBe(true);
    expect(dns.every(k => k.position === 'aboveBar')).toBe(true);
  });

  it('strategy executions reach model.trades as TradeExecution[]', async () => {
    const src = `//@version=6\nstrategy("s", overlay=true)\nif bar_index == 2\n    strategy.entry("L", strategy.long)\nif bar_index == 5\n    strategy.close("L", comment="out")\n`;
    const m = await runModel(src, mkBars(10));
    expect(m.trades?.length).toBeGreaterThan(0);
    const t = m.trades![0]!;
    expect(t.kind).toBe('entry');
    expect(t.side).toBe('buy');
    expect(t.price).toBeGreaterThan(0);
    const exit = m.trades!.find(x => x.kind === 'exit');
    expect(exit?.label).toBe('out');
    expect(exit?.tradeId).toBe(t.tradeId); // same round-trip
  });

  it('inputValues reflect session.update() overrides', async () => {
    const engine = new PineInterpreterEngine();
    const src = `//@version=6\nindicator("i")\nn = input.int(10, "len")\nplot(n)\n`;
    const prepared = await engine.prepare(src, 's3');
    const c = collect();
    const session = engine.execute(mkReq(prepared, mkBars(5)), { onModel: c.onModel });
    await c.waitFor(1);
    session.update({ len: 5 });
    const m = await c.waitFor(2);
    expect(m.inputValues['len']).toBe(5);
    session.stop();
  });
});
