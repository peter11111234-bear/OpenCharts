import { describe, expect, it } from 'vitest';
import { PineInterpreterEngine, buildModel } from '../engine';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { IndicatorModel, OHLCV } from '@luxalgo/vela';
import '../builtins/index';
import '../mtf';

// plot(display=display.data_window) shows only in the Data Window. Rendering it
// as a normal line put a ±100 signal on a ~22000 price pane and squashed the
// candles into a flat line (DIY Custom Strategy Builder's long/Short Signal).
const mkBars = (n: number): OHLCV[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * 3600000, open: 22000 + i, high: 22010 + i, low: 21990 + i, close: 22005 + i, volume: 1000,
  }));

async function model(src: string): Promise<IndicatorModel> {
  const engine = new PineInterpreterEngine();
  const prepared = await engine.prepare(src, 't1');
  const bars = mkBars(5);
  const r = await runScript(parse(src), bars.map((b) => ({ openTime: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 })), { symbol: 'TEST', timeframe: '60' });
  const req = { prepared, market: { symbol: 'TEST', timeframe: '60' }, bars, mode: 'static' as const };
  return buildModel((prepared.token as { modelId: string }).modelId, req, r, bars.map((b) => b.time));
}

const series = (m: IndicatorModel, title: string) => m.series.find((s) => s.title === title)!;

describe('plot display= surfaces', () => {
  it('display.data_window stays off the pane and the price scale', async () => {
    const m = await model('//@version=6\nindicator("d", overlay=true)\nplot(close, "px")\nplot(100, "sig", display=display.data_window)\n');
    expect(series(m, 'sig').display).toEqual({ pane: false, priceScale: false, legend: false, dataWindow: true });
    expect(series(m, 'px').display).toBeUndefined();
  });

  it('display.status_line and display.price_scale keep only their own surface', async () => {
    const m = await model('//@version=6\nindicator("d")\nplot(1, "a", display=display.status_line)\nplot(2, "b", display=display.price_scale)\n');
    expect(series(m, 'a').display).toEqual({ pane: false, priceScale: false, legend: true, dataWindow: false });
    expect(series(m, 'b').display).toEqual({ pane: false, priceScale: true, legend: false, dataWindow: false });
  });

  it('display.all and display.pane draw as before', async () => {
    const m = await model('//@version=6\nindicator("d")\nplot(1, "a", display=display.all)\nplot(2, "b", display=display.pane)\n');
    expect(series(m, 'a').display).toBeUndefined();
    expect(series(m, 'b').display).toBeUndefined();
  });
});
