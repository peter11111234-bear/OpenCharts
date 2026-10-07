// ── QA probes for c560c0f: error path + edge cases ──
// barErr vs shouldAbort ordering, post-stop requests, deferred backfill +
// multiple 'complete' notifications, getBars pending-overwrite stale emit,
// and MessageChannel/setTimeout yield branch selection.

import { describe, expect, it, vi } from 'vitest';
import { runScript, yieldStats } from '../interpreter';
import { parse } from '../parser';
import { resetMtf } from '../mtf';
import { PineInterpreterEngine } from '../engine';
import type { BarData } from '../contracts';
import type { ExecutionRequest, IndicatorModel, OHLCV, PreparedScript } from '@luxalgo/vela';
import '../builtins/index';
import '../mtf';

const mkBarData = (n: number): BarData[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: i * 60_000, open: i + 1, high: i + 2, low: i, close: i + 1, volume: 1000 + i,
  }));

const mkOhlcv = (n: number): OHLCV[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * 60_000, open: i + 1, high: i + 2, low: i, close: i + 1, volume: 1000 + i,
  }));

const fastClock = () => {
  let t = 0;
  return vi.spyOn(performance, 'now').mockImplementation(() => (t += 10));
};

const turn = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const c = new MessageChannel();
  c.port1.onmessage = () => resolve();
  c.port2.postMessage(null);
  return promise;
};

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

const lastPoint = (m: IndicatorModel): number | null => {
  const s = m.series.find(x => 'points' in x);
  return s && 'points' in s ? s.points.at(-1)?.value ?? null : null;
};

// Errors at bar_index==2 (mid-loop); bar_index plot makes bar count observable.
const ERR_SRC = 'indicator("e")\nif bar_index == 2\n    x := 1\nplot(bar_index)';
// Gated via request.security so a run can be parked in prefetch.
const SEC_SRC = 'indicator("s")\nh = request.security(syminfo.tickerid, "60", close)\nplot(bar_index + h * 0)';
const INPUT_SRC = 'indicator("i")\nn = input.int(5, "len")\nplot(n * 100)';

describe('S1: barErr mid-loop vs shouldAbort ordering', () => {
  it('barErr still propagates post-refactor when not aborted', async () => {
    resetMtf();
    await expect(runScript(parse(ERR_SRC), mkBarData(5))).rejects.toThrow();
  });

  it('abort wins over pending barErr: post-loop check returns empty(), no throw', async () => {
    resetMtf();
    const spy = fastClock();
    try {
      const res = await runScript(parse(ERR_SRC), mkBarData(5), { shouldAbort: () => true });
      expect(res.plots.size).toBe(0);
      expect(res.title).toBe('e');
    } finally {
      spy.mockRestore();
    }
  });

  it('engine: script error → exactly one onError, no onModel/onDone (no double-report)', async () => {
    resetMtf();
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(ERR_SRC, 'qa-err');
    const { models, onModel } = collect();
    const errors: Error[] = [];
    let dones = 0;
    const req: ExecutionRequest = {
      prepared, market: { symbol: 'T', timeframe: '60' }, bars: mkOhlcv(5), mode: 'static',
    };
    const session = engine.execute(req, {
      onModel, onError: e => errors.push(e), onDone: () => dones++,
    });
    await vi.waitFor(() => expect(errors.length).toBe(1));
    await turn(); await turn();
    expect(errors.length).toBe(1);
    expect(models).toEqual([]);
    expect(dones).toBe(0);
    session.stop();
  });
});

describe('S2: stop() drain-tail', () => {
  it('requests after stop() are ignored — no model, no error', async () => {
    resetMtf();
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(INPUT_SRC, 'qa-stop');
    const { models, onModel, waitFor } = collect();
    const errors: unknown[] = [];
    const req: ExecutionRequest = {
      prepared, market: { symbol: 'T', timeframe: '60' }, bars: mkOhlcv(5), mode: 'static',
    };
    const session = engine.execute(req, { onModel, onError: e => errors.push(e) });
    await waitFor(1);
    session.stop();
    session.update({ len: 2 });
    session.notifyBars();
    session.notifyBars('complete');
    await turn(); await turn(); await turn();
    expect(models.length).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe('S3: deferred backfill', () => {
  it('update() during backfill merges inputs without running; first run uses merged inputs', async () => {
    resetMtf();
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(INPUT_SRC, 'qa-def');
    const { models, onModel, waitFor } = collect();
    const req: ExecutionRequest = {
      prepared, market: { symbol: 'T', timeframe: '60' }, bars: mkOhlcv(5), mode: 'static',
      historyState: 'backfill',
    };
    const session = engine.execute(req, { onModel });
    session.update({ len: 9 }); // merged, must NOT fire a run while deferred
    session.notifyBars('backfill');
    session.notifyBars(); // tick while deferred — still no run
    await turn(); await turn();
    expect(models).toEqual([]);
    session.notifyBars('complete');
    const m = await waitFor(1);
    expect(m.series.find(s => 'points' in s)).toBeDefined();
    expect(m.inputValues['len']).toBe(9); // merged override reached the run
    session.stop();
  });

  it('multiple complete notifications while a run is in-flight coalesce to one pending run', async () => {
    resetMtf();
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SEC_SRC, 'qa-def2');
    const gate = Promise.withResolvers<void>();
    let fetchCalls = 0;
    const { models, onModel, waitFor } = collect();
    const req: ExecutionRequest = {
      prepared, market: { symbol: 'T', timeframe: '15' }, bars: mkOhlcv(4), mode: 'static',
      historyState: 'backfill',
      fetchSeries: async () => { fetchCalls++; await gate.promise; return mkOhlcv(2); },
    };
    const errs: unknown[] = [];
    const session = engine.execute(req, { onModel, onError: e => errs.push(e) });
    session.notifyBars('complete'); // run1 starts, parks in prefetch
    while (fetchCalls === 0) await turn();
    session.notifyBars('complete');
    session.notifyBars('complete');
    session.notifyBars('complete'); // three completes → ONE pending request
    gate.resolve();
    await vi.waitFor(() => expect(models.length).toBe(2), { timeout: 3000 });
    await turn(); await turn();
    expect(models.length).toBe(2); // run1 + coalesced run2, not 4
    expect(fetchCalls).toBe(2); // pending run fetched fresh bars once
    session.stop();
  });
});

describe('S4: getBars pending overwrite — stale in-flight emit', () => {
  it('in-flight run emits stale model, pending re-run uses latest getBars()', async () => {
    resetMtf();
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SEC_SRC, 'qa-bars');
    const gate = Promise.withResolvers<void>();
    let fetchCalls = 0;
    let current = mkOhlcv(6);
    const { models, onModel, waitFor } = collect();
    const req: ExecutionRequest = {
      prepared, market: { symbol: 'T', timeframe: '15' }, bars: current, mode: 'static',
      getBars: () => current,
      fetchSeries: async () => { fetchCalls++; if (fetchCalls === 1) await gate.promise; return mkOhlcv(2); },
    };
    const errs: unknown[] = [];
    const session = engine.execute(req, { onModel, onError: e => errs.push(e) });
    while (fetchCalls === 0) await turn(); // run1 parked in prefetch with 6 bars
    current = mkOhlcv(10);
    session.notifyBars(); // pending := NEW 10-bar array
    gate.resolve();
    await vi.waitFor(() => expect(models.length).toBe(2), { timeout: 3000 });
    // Intended semantics confirmed: in-flight result IS emitted (stale, 6 bars →
    // last bar_index = 5), then the pending request re-runs on 10 bars (→ 9).
    expect(lastPoint(models[0]!)).toBe(5);
    expect(lastPoint(models[1]!)).toBe(9);
    session.stop();
  });
});

describe('S5: yield transport', () => {
  it('jsdom env provides MessageChannel — real channel branch is what tests exercise', () => {
    expect(typeof MessageChannel).toBe('function');
    expect(typeof Promise.withResolvers).toBe('function');
  });

  it('forced fallback (MessageChannel undefined) resolves via setTimeout and does not count hops', async () => {
    resetMtf();
    const orig = globalThis.MessageChannel;
    const stSpy = vi.spyOn(globalThis, 'setTimeout');
    const clock = fastClock();
    const hopsBefore = yieldStats.hops;
    try {
      (globalThis as Record<string, unknown>).MessageChannel = undefined;
      const res = await runScript(parse('indicator("f")\nplot(close)'), mkBarData(8));
      expect(res.plots.size).toBe(1);
      expect(stSpy.mock.calls.some(c => c[1] === 0)).toBe(true); // setTimeout(0) fallback used
      expect(yieldStats.hops).toBe(hopsBefore); // hops only counted in channel branch
    } finally {
      globalThis.MessageChannel = orig;
      stSpy.mockRestore();
      clock.mockRestore();
    }
  });
});
