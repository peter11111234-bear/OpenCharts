// Plot deltas must hold for EVERY advance of a live session, not every other
// one: the worker used to reset its diff baseline right after computing a
// delta, so each delta tick was followed by a full re-clone of the plot map.
// Locked two ways — at the protocol (what the worker posts) and end to end
// (what the client hands the engine, against an independent full run).
import { describe, it, expect } from 'vitest';
import { createWorkerHandler } from '../pineWorker';
import { PineRunClient, type WorkerLike } from '../pineWorkerClient';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { BarData, RunResult } from '../contracts';
import type { ToWorker, FromWorker } from '../pineWorkerProto';
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

const done = (m: FromWorker): m is Extract<FromWorker, { t: 'done' }> => m.t === 'done';

describe('worker plot deltas on every advance', () => {
  it('protocol: after the first full emit, every done of a live session carries plotDelta', async () => {
    const got: FromWorker[] = [];
    let settle: () => void = () => {};
    const h = createWorkerHandler((m) => { got.push(m); if (m.t === 'done' || m.t === 'fail') settle(); });
    const parsed = parse(SRC);
    let bars = mkBars(60);
    for (let t = 0; t < 12; t++) {
      if (t > 0) bars = nextTape(bars, t);
      await new Promise<void>((r) => {
        settle = r;
        h({ t: 'run', id: t + 1, parsed, bars, opts: { incKey: 'd', hasFetch: false } } as ToWorker);
      });
    }
    const dones = got.filter(done);
    expect(got.filter((m) => m.t === 'fail')).toEqual([]);
    expect(dones).toHaveLength(12);
    expect(dones[0]!.plotDelta).toBeUndefined();
    expect(dones[0]!.result.plots.size).toBe(3);
    // Every later advance: a delta, and no plot map shipped alongside it.
    for (const d of dones.slice(1)) {
      expect(d.plotDelta).toBeDefined();
      expect(d.result.plots.size).toBe(0);
    }
  });

  it('end to end: twelve advances through the client equal full runs, with one full emit', async () => {
    const got: FromWorker[] = [];
    const handler = createWorkerHandler((m) => { got.push(m); queueMicrotask(() => w.onmessage?.({ data: m })); });
    const w: WorkerLike = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage: (m: unknown) => queueMicrotask(() => handler(m as ToWorker)),
      terminate: () => {},
    };
    const c = new PineRunClient({ factory: () => w });
    const parsed = parse(SRC);
    // Everything the engine reads from a plot: index, times, values, colors.
    const view = (r: RunResult) => [...r.plots.entries()].map(([k, p]) => [k, p.index, p.time, JSON.stringify(p.values), p.colors]);

    let bars = mkBars(60);
    for (let t = 0; t < 12; t++) {
      if (t > 0) bars = nextTape(bars, t);
      const viaClient = await c.run({ parsed, bars, opts: { incKey: 'e2e' } });
      expect(view(viaClient), `tick ${t}`).toEqual(view(await runScript(parse(SRC), bars)));
    }
    const fullEmits = got.filter(done).filter((d) => d.plotDelta === undefined);
    expect(fullEmits).toHaveLength(1);
  });

  it('a history rewrite between delta ticks resends whole plots, not just the tail', async () => {
    // plotsDelta only compares each plot's last value. A rewritten old bar makes
    // the session fall back to a fresh run, whose plots carry new opts objects —
    // that is what turns every entry into a from-0 resend. With deltas on every
    // tick nothing else would ever replace the stale prefix on the client.
    const got: FromWorker[] = [];
    const handler = createWorkerHandler((m) => { got.push(m); queueMicrotask(() => w.onmessage?.({ data: m })); });
    const w: WorkerLike = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage: (m: unknown) => queueMicrotask(() => handler(m as ToWorker)),
      terminate: () => {},
    };
    const c = new PineRunClient({ factory: () => w });
    const parsed = parse(SRC);
    const view = (r: RunResult) => [...r.plots.entries()].map(([k, p]) => [k, p.time, JSON.stringify(p.values), p.colors]);
    let bars = mkBars(60);
    for (let t = 0; t < 4; t++) bars = nextTape(bars, t === 3 ? 0 : t), await c.run({ parsed, bars, opts: { incKey: 'h' } });
    bars = bars.slice();
    bars[10] = { ...bars[10]!, close: 50, low: 50 };
    const r = await c.run({ parsed, bars, opts: { incKey: 'h' } });
    const last = got.filter(done).at(-1)!;
    expect(last.plotDelta).toBeDefined();
    expect(last.plotDelta!.every((d) => d.from === 0)).toBe(true);
    expect(view(r)).toEqual(view(await runScript(parse(SRC), bars)));
  });
});
