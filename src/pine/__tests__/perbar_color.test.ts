// Per-bar `color=` must reach SeriesPoint.color — regression for the
// all-green histogram (MACD雙周期 columns showing one color).
import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { PineInterpreterEngine, buildModel } from '../engine';
import type { ExecutionRequest, OHLCV, PreparedScript } from '@luxalgo/vela';
import '../builtins/index';
import '../mtf';

const mkBars = (n: number): OHLCV[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * 60_000, open: i, high: i + 1, low: i - 1, close: i, volume: 100 + i,
  }));

const mkReq = (prepared: PreparedScript, bars: OHLCV[]): ExecutionRequest => ({
  prepared,
  market: { symbol: 'TEST', timeframe: '60' },
  bars,
  mode: 'static',
});

describe('per-bar plot color', () => {
  it('conditional color= reaches every SeriesPoint', async () => {
    const src = [
      'indicator("cc", overlay=false)',
      'h = close - 3',                          // <0 on bars 0-2, >=0 on 3+
      'plot(h, "h", style=plot.style_columns, color = h >= 0 ? #00FF00 : #FF0000)',
    ].join('\n');
    const bars = mkBars(8);
    const r = await runScript(parse(src), bars.map(b => ({ openTime: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })), { symbol: 'TEST', timeframe: '60' });
    const plot = r.plots.get('h')!;
    expect(plot.colors.slice(0, 4)).toEqual(['#ff0000', '#ff0000', '#ff0000', '#00ff00']);

    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(src, 't1');
    const token = prepared.token;
    if (!token || typeof token !== 'object' || !('modelId' in token)) throw new Error('no modelId');
    const model = buildModel(
      token.modelId as string,
      mkReq(prepared, bars), r, bars.map(b => b.time));
    const series = model.series!.find(s => s.title === 'h')!;
    if (!('points' in series)) throw new Error('expected line-like series');
    const pts = (series as { points: { color?: string }[] }).points;
    expect(pts.map(p => p.color)).toEqual([
      '#ff0000', '#ff0000', '#ff0000', '#00ff00',
      '#00ff00', '#00ff00', '#00ff00', '#00ff00',
    ]);
  });
});
