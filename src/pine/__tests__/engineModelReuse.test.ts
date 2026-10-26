// buildModel must be able to rebuild only the changed tail of a line series.
// The worker client already knows, per tick, which plots changed and from which
// bar index (plotChangeFrom); buildModel reuses the previous points array by
// truncating it to that index and appending the new tail. VELA reads the array
// contents every frame, never its identity, so in-place truncation is allowed —
// but the CONTENTS must stay identical to a full rebuild, which is what these
// tests lock down.
import { describe, expect, it } from 'vitest';
import { PineInterpreterEngine, buildModel, type SeriesPointLike } from '../engine';
import { createWorkerHandler } from '../pineWorker';
import { PineRunClient, plotChangeFrom, type WorkerLike } from '../pineWorkerClient';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { BarData, PlotOpts, RunResult, Value } from '../contracts';
import type { ExecutionRequest, IndicatorModel, OHLCV, PreparedScript } from '@luxalgo/vela';
import type { ToWorker } from '../pineWorkerProto';
import '../builtins/index';

const SRC = `//@version=6
indicator("delta")
e = ta.ema(close, 5)
plot(e, title="ema", color=close > open ? color.red : color.green)
plot(close, title="c")
plot(ta.highest(high, 3), title="hh")
`;

const mkBars = (n: number): BarData[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: 1_700_000_000_000 + i * 60_000,
    closeTime: 1_700_000_000_000 + (i + 1) * 60_000 - 1,
    open: 100 + i, high: 103 + i, low: 98 + i, close: 101 + i, volume: 1000 + i,
  }));

/** Tick t: rewrite the forming bar, append a new one every 4th tick. Closes
 *  swing around open so the per-bar color flips between ticks too. */
const nextTape = (bars: BarData[], t: number): BarData[] => {
  const out = bars.slice();
  const last = out[out.length - 1]!;
  if (t % 4 === 3) {
    out.push({ openTime: last.closeTime! + 1, closeTime: last.closeTime! + 60_000, open: last.close, high: last.close + 2, low: last.close - 2, close: last.close + 1, volume: 900 + t });
  } else {
    const close = last.open + (t % 2 === 0 ? -0.5 : 0.5) * (t + 1);
    out[out.length - 1] = { ...last, close, high: Math.max(last.high, close), low: Math.min(last.low, close) };
  }
  return out;
};

const asOHLCV = (bars: BarData[]): OHLCV[] =>
  bars.map(b => ({ time: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));

const mkReq = (prepared: PreparedScript, bars: OHLCV[]): ExecutionRequest => ({
  prepared,
  market: { symbol: 'TEST', timeframe: '60' },
  bars,
  mode: 'static',
});

const linePoints = (m: IndicatorModel): SeriesPointLike[] => {
  const s = m.series[0]!;
  if (!('points' in s)) throw new Error('expected a line series');
  return s.points as SeriesPointLike[];
};

const prep = async (src: string): Promise<{ prepared: PreparedScript; modelId: string }> => {
  const prepared = await new PineInterpreterEngine().prepare(src, 't1');
  // The engine's opaque prepare token — the tests only need the model id.
  const token = prepared.token as { modelId: string };
  return { prepared, modelId: token.modelId };
};

/** Synthetic RunResult with a single default (line) plot named `ema`. */
const mkResult = (values: number[], colors: (string | undefined)[]): RunResult => ({
  plots: new Map([['ema', {
    index: 0,
    time: values.map((_, i) => i * 60_000),
    values: values.map((v): Value => ({ kind: 'float', v })),
    opts: { style: 'plot.style_line', color: '#2962FF' } as PlotOpts,
    colors,
  }]]),
  drawings: [], fills: [], bgcolors: new Map(), barcolors: new Map(),
  alerts: [], logs: [], alertconditions: [], warnings: [], inputs: [], props: [],
  title: 'delta', overlay: false,
});

describe('buildModel line-point reuse', () => {
  it('unit: reusing from index 48 keeps the array identity and matches a full rebuild', async () => {
    const { prepared, modelId } = await prep(SRC);
    const bars = asOHLCV(mkBars(52));
    const req = mkReq(prepared, bars);
    const times = bars.map(b => b.time);

    const v1 = Array.from({ length: 50 }, (_, i) => 100 + i);
    const r1 = mkResult(v1, v1.map(() => 'green'));
    const cache = new Map<string, SeriesPointLike[]>();
    const m1 = buildModel(modelId, req, r1, times.slice(0, 50), undefined, { from: undefined, cache });
    const first = linePoints(m1);
    // The builder seeds the cache with the very array it emitted.
    expect(cache.get(`${modelId}:s0`)).toBe(first);

    // Same first 48 bars, bar 48 rewritten, two bars appended.
    const v2 = v1.slice(0, 48).concat([777, 778, 779, 780]);
    const colors2 = v1.slice(0, 48).map(() => 'green').concat(['red', 'red', 'red', 'red']);
    const r2 = mkResult(v2, colors2);
    const from = new Map([['ema', 48]]);

    const m2 = buildModel(modelId, req, r2, times.slice(0, 52), undefined, { from, cache });
    const reused = linePoints(m2);
    expect(reused).toBe(first);
    expect(cache.get(`${modelId}:s0`)).toBe(first);
    expect(reused).toEqual(linePoints(buildModel(modelId, req, r2, times.slice(0, 52))));
    expect(reused[48]!.color).toBe('red');
    expect(reused).toHaveLength(52);
  });

  it('unit: from === undefined rebuilds every point into a NEW array', async () => {
    const { prepared, modelId } = await prep(SRC);
    const bars = asOHLCV(mkBars(50));
    const req = mkReq(prepared, bars);
    const times = bars.map(b => b.time);
    const r = mkResult(Array.from({ length: 50 }, (_, i) => 100 + i), []);

    const cache = new Map<string, SeriesPointLike[]>();
    const a = linePoints(buildModel(modelId, req, r, times, undefined, { from: undefined, cache }));
    cache.clear();
    const b = linePoints(buildModel(modelId, req, r, times, undefined, { from: undefined, cache }));
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
  });

  it('end to end: twelve client ticks with reuse equal full runs; tail arrays are reused', async () => {
    const handler = createWorkerHandler((m) => { queueMicrotask(() => w.onmessage?.({ data: m })); });
    const w: WorkerLike = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage: (m: unknown) => queueMicrotask(() => handler(m as ToWorker)),
      terminate: () => {},
    };
    const client = new PineRunClient({ factory: () => w });
    const { prepared, modelId } = await prep(SRC);
    const parsed = parse(SRC);
    const cache = new Map<string, SeriesPointLike[]>();
    const identity: (SeriesPointLike[] | null)[][] = [];

    let bars = mkBars(60);
    for (let t = 0; t < 12; t++) {
      if (t > 0) bars = nextTape(bars, t);
      const times = bars.map(b => b.openTime);
      const req = mkReq(prepared, asOHLCV(bars));
      const result = await client.run({ parsed, bars, opts: { incKey: 'e2e' } });
      const from = plotChangeFrom.get(result);
      if (from === undefined) cache.clear();
      const reuse = buildModel(modelId, req, result, times, undefined, { from, cache });
      const full = buildModel(modelId, req, await runScript(parse(SRC), bars), times);
      expect(reuse.series, `tick ${t}`).toEqual(full.series);

      identity.push(reuse.series.map(s => ('points' in s ? s.points as SeriesPointLike[] : null)));
      if (t > 0) expect(from, `tick ${t} delta`).toBeDefined();
    }

    // The cached tail arrays survive the later ticks untouched in identity.
    for (let t = 3; t < identity.length; t++) {
      expect(identity[t]![0], `tick ${t}`).toBe(identity[3]![0]);
      expect(identity[t]![1], `tick ${t}`).toBe(identity[3]![1]);
    }
  });

  it('end to end: a history rewrite still equals a full run (from 0, array truncated)', async () => {
    const handler = createWorkerHandler((m) => { queueMicrotask(() => w.onmessage?.({ data: m })); });
    const w: WorkerLike = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage: (m: unknown) => queueMicrotask(() => handler(m as ToWorker)),
      terminate: () => {},
    };
    const client = new PineRunClient({ factory: () => w });
    const { prepared, modelId } = await prep(SRC);
    const parsed = parse(SRC);
    const cache = new Map<string, SeriesPointLike[]>();

    let bars = mkBars(60);
    for (let t = 0; t < 4; t++) {
      bars = nextTape(bars, t === 3 ? 0 : t);
      const times = bars.map(b => b.openTime);
      const result = await client.run({ parsed, bars, opts: { incKey: 'h' } });
      const from = plotChangeFrom.get(result);
      if (from === undefined) cache.clear();
      buildModel(modelId, mkReq(prepared, asOHLCV(bars)), result, times, undefined, { from, cache });
    }
    bars = bars.slice();
    bars[10] = { ...bars[10]!, close: 50, low: 50 };
    const times = bars.map(b => b.openTime);
    const req = mkReq(prepared, asOHLCV(bars));
    const result = await client.run({ parsed, bars, opts: { incKey: 'h' } });
    const from = plotChangeFrom.get(result)!;
    expect([...from.values()].every(v => v === 0)).toBe(true);
    const reuse = buildModel(modelId, req, result, times, undefined, { from, cache });
    const full = buildModel(modelId, req, await runScript(parse(SRC), bars), times);
    expect(reuse.series).toEqual(full.series);
  });
});
