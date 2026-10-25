import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRequest, IndicatorModel, OHLCV, PreparedScript } from '@luxalgo/vela';
import '../builtins/index';
import '../mtf';

// In-memory stand-in for the IndexedDB cache (node has no indexedDB).
const store = vi.hoisted(() => new Map<string, { model: unknown; lastTime: number }>());
vi.mock('../modelCache', () => ({
  modelCacheGet: async (key: string) => store.get(key) ?? null,
  modelCachePut: async (key: string, model: unknown, lastTime: number) => {
    store.set(key, { model: structuredClone(model), lastTime });
  },
}));

const { PineInterpreterEngine, cachedPrefix } = await import('../engine');

const H = 3600000;
const mkBars = (from: number, n: number): OHLCV[] =>
  Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const p = 100 + Math.sin(i / 5) * 2;
    return { time: i * H, open: p, high: p + 1, low: p - 1, close: p + 0.5, volume: 1000 + i };
  });

const mkReq = (prepared: PreparedScript, bars: OHLCV[]): ExecutionRequest => ({
  prepared,
  market: { symbol: 'TEST', timeframe: '60' },
  bars,
  mode: 'static',
});

const SRC = `//@version=6
indicator("c", overlay=true)
plot(ta.sma(close, 3), "s")
label.new(bar_index, high, "x")
alertcondition(true, "a", "a")
if barstate.islast
    alert("hi")
`;

/** Run one session to its first full-run model; returns every onModel emit. */
const session = async (bars: OHLCV[]) => {
  const engine = new PineInterpreterEngine();
  const prepared = await engine.prepare(SRC, 't1');
  const models: IndicatorModel[] = [];
  const alerts: string[] = [];
  const { promise, resolve } = Promise.withResolvers<void>();
  const s = engine.execute(mkReq(prepared, bars), {
    onModel: (m) => { models.push(m); },
    onAlert: (a) => { alerts.push(a.message); },
    onDone: () => { if (models.some((m) => m.labels?.length)) resolve(); },
  });
  await promise;
  s.stop();
  return { models, alerts };
};

const linePoints = (m: IndicatorModel) => {
  const s = m.series.find((x) => 'points' in x && x.points);
  return s && 'points' in s ? s.points : [];
};

describe('cachedPrefix', () => {
  const model = (): IndicatorModel => ({
    id: 'm', title: 'm', paneHint: 'price',
    series: [{ id: 'm:s0', title: 's', paneId: '', kind: 'line', style: { color: '#fff', width: 1, lineStyle: 'solid' },
      points: [0, 1, 2, 3].map((i) => ({ time: i * H, value: i })) }],
    labels: [{ id: 'l', paneId: '', xloc: 'bar_time', x: 1 * H, y: 1, yloc: 'price', style: 'label_up', size: 'normal', textAlign: 'center', fontFamily: 'default' }],
  } as IndicatorModel);

  it('keeps only points before the cached forming bar that are still on the chart', () => {
    const p = cachedPrefix(model(), [1, 2, 3, 4].map((i) => i * H), 3 * H)!;
    expect(linePoints(p).map((x) => x.time)).toEqual([1 * H, 2 * H]);
  });

  it('drops drawing objects', () => {
    expect(cachedPrefix(model(), [0, 1, 2].map((i) => i * H), 3 * H)!.labels).toBeUndefined();
  });

  it('returns undefined when no point survives', () => {
    expect(cachedPrefix(model(), [7 * H, 8 * H], 3 * H)).toBeUndefined();
  });

  // Vela's value patch never updates bgcolor/barcolor, so a prefix would leave
  // them cut at the cached bar until remount; trades are skipped to keep it simple.
  it('skips models with bgcolor, barcolor or trades', () => {
    const times = [0, 1, 2].map((i) => i * H);
    const bg = { ...model(), backgrounds: [{ id: 'b', paneId: '', from: 1 * H, to: 2 * H, color: '#f00' }] } as IndicatorModel;
    const bc = { ...model(), barColors: [{ time: 1 * H, color: '#f00' }] } as IndicatorModel;
    const tr = { ...model(), trades: [{ time: 1 * H }] } as unknown as IndicatorModel;
    for (const m of [bg, bc, tr]) expect(cachedPrefix(m, times, 3 * H)).toBeUndefined();
  });

  it('markers alone are not painted (plotshape draws via labels, which the prefix drops)', () => {
    const m = { ...model(), series: [{ id: 'm:m0', title: 's', paneId: '', kind: 'shape', markers: [{ time: 1 * H }] }] } as unknown as IndicatorModel;
    expect(cachedPrefix(m, [0, 1, 2].map((i) => i * H), 3 * H)).toBeUndefined();
  });
});

describe('restore through the model cache', () => {
  beforeEach(() => store.clear());

  it('a reload on a later bar paints the cached prefix, then the full run replaces it', async () => {
    const first = await session(mkBars(0, 50));
    expect(first.models).toHaveLength(1);
    expect(store.size).toBe(1);
    expect([...store.values()][0]!.lastTime).toBe(49 * H);

    // Two bars later the window has slid: bars 2..51.
    const later = mkBars(2, 50);
    const second = await session(later);
    expect(second.models).toHaveLength(2);
    const [prefix, full] = second.models as [IndicatorModel, IndicatorModel];

    const prefixTimes = linePoints(prefix).map((p) => p.time);
    expect(prefixTimes[0]).toBe(2 * H);
    expect(prefixTimes[prefixTimes.length - 1]).toBe(48 * H);
    expect(prefix.labels).toBeUndefined();

    expect(linePoints(full).map((p) => p.time)).toEqual(later.map((b) => b.time));
    expect(full.labels?.length).toBeGreaterThan(0);
    // Alerts come from the real run, not swallowed by the cache hit.
    expect(second.alerts).toContain('hi');
  });

  it('a cache miss paints once', async () => {
    const r = await session(mkBars(0, 30));
    expect(r.models).toHaveLength(1);
  });

  it('a full run that fails after a prefix was painted blanks the prefix, then reports', async () => {
    await session(mkBars(0, 50));
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SRC, 't1');
    vi.spyOn(engine as unknown as { runProgram: () => Promise<never> }, 'runProgram')
      .mockRejectedValue(new Error('boom'));
    const models: IndicatorModel[] = [];
    const { promise, resolve } = Promise.withResolvers<Error>();
    const s = engine.execute(mkReq(prepared, mkBars(2, 50)), {
      onModel: (m) => { models.push(m); },
      onError: (e) => resolve(e),
    });
    const err = await promise;
    s.stop();
    expect(err.message).toBe('boom');
    expect(models).toHaveLength(2);
    expect(linePoints(models[0]!).length).toBeGreaterThan(0);
    expect(models[1]!.series.map((x) => x.id)).toEqual(models[0]!.series.map((x) => x.id));
    expect(linePoints(models[1]!)).toEqual([]);
  });

  it('a malformed cached row falls through to the full run', async () => {
    await session(mkBars(0, 30));
    const [key] = [...store.keys()];
    store.set(key!, { model: { series: null }, lastTime: 29 * H });
    const r = await session(mkBars(0, 30));
    expect(r.models).toHaveLength(1);
    expect(r.models[0]!.labels?.length).toBeGreaterThan(0);
  });
});
