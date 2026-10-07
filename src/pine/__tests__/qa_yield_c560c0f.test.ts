// ── QA probes for c560c0f: yield + runScript mutex + engine drain coalescing ──
// Behavior-only checks: forced-clock yields, abort contract, serialization,
// poisoned-tail, __pineStage/yieldStats observability.
// No wall-clock sleeps: blocked-state assertions await a couple of macrotask
// turns (MessageChannel) — enough turns for any unserialized run to reach its
// fetchSeries — and completion is awaited via the mutex itself or the
// event-driven collect() helper.

import { describe, expect, it, vi } from 'vitest';
import { runScript, yieldStats } from '../interpreter';
import { parse } from '../parser';
import { resetMtf } from '../mtf';
import { PineInterpreterEngine } from '../engine';
import type { BarData, RunResult, Value } from '../contracts';
import type { ExecutionRequest, IndicatorModel, OHLCV } from '@luxalgo/vela';
import '../builtins/index';
import '../mtf';

const mkBarData = (n: number, tfMs = 60_000): BarData[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: i * tfMs, open: i + 1, high: i + 2, low: i, close: i + 1, volume: 1000 + i,
  }));

const mkOhlcv = (n: number): OHLCV[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * 60_000, open: i + 1, high: i + 2, low: i, close: i + 1, volume: 1000 + i,
  }));

const num = (v: Value): number | 'na' =>
  v.kind === 'int' || v.kind === 'float' ? v.v : 'na';

/** performance.now advances 10ms per call → every 2nd bar crosses the 16ms
 *  budget, forcing yieldTask() deterministically without wall-clock waits. */
const fastClock = () => {
  let t = 0;
  return vi.spyOn(performance, 'now').mockImplementation(() => (t += 10));
};

const stage = (): unknown => (globalThis as Record<string, unknown>).__pineStage;

/** One real macrotask turn via MessageChannel — same mechanism yieldTask uses. */
const turn = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const c = new MessageChannel();
  c.port1.onmessage = () => resolve();
  c.port2.postMessage(null);
  return promise;
};

const SEC_SRC = `indicator("s")
h = request.security(syminfo.tickerid, "60", close)
plot(h)`;

/** onModel resolves a signal per run — no wall-clock waiting. */
const collect = () => {
  const models: IndicatorModel[] = [];
  const waiters: { k: number; resolve: (m: IndicatorModel) => void }[] = [];
  const onModel = (m: IndicatorModel) => {
    models.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (models.length >= waiters[i]!.k) { waiters[i]!.resolve(m); waiters.splice(i, 1); }
    }
  };
  const waitFor = (k: number): Promise<IndicatorModel> => {
    if (models.length >= k) return Promise.resolve(models[models.length - 1]!);
    const { promise, resolve } = Promise.withResolvers<IndicatorModel>();
    waiters.push({ k, resolve });
    return promise;
  };
  return { models, onModel, waitFor };
};

describe('1. happy path — yield does not corrupt result', () => {
  it('forced yields: plots assemble fully, in order, values correct', async () => {
    resetMtf();
    const src = 'indicator("y")\nx = close * 2\nplot(x, "x")\nplot(x + 1, "x1")';
    const hopsBefore = yieldStats.hops;
    const spy = fastClock();
    try {
      const res = await runScript(parse(src), mkBarData(8), { shouldAbort: () => false });
      expect(res.plots.get('x')!.values.map(num)).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
      expect(res.plots.get('x1')!.values.map(num)).toEqual([3, 5, 7, 9, 11, 13, 15, 17]);
      expect(res.title).toBe('y');
      expect(res.warnings).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(yieldStats.hops).toBeGreaterThan(hopsBefore); // yields actually fired
  });

  it('barErr still thrown post-loop when yields fire (error not swallowed)', async () => {
    resetMtf();
    const spy = fastClock();
    try {
      await expect(
        runScript(parse('indicator("e")\nx := 1\nplot(1)'), mkBarData(8), { shouldAbort: () => false }),
      ).rejects.toThrow(/undeclared variable 'x'/);
    } finally {
      spy.mockRestore();
    }
  });

  it('empty() shape identical via bars=[] and via shouldAbort', async () => {
    resetMtf();
    const src = 'indicator("sh")\nn = input.int(5, "len")\nplot(n)';
    const fromNoBars = await runScript(parse(src), []);
    const spy = fastClock();
    let fromAbort: RunResult;
    try {
      fromAbort = await runScript(parse(src), mkBarData(6), { shouldAbort: () => true });
    } finally {
      spy.mockRestore();
    }
    expect(Object.keys(fromAbort!).sort()).toEqual(Object.keys(fromNoBars).sort());
    expect(fromAbort!.plots.size).toBe(0);
    expect(fromAbort!.inputs.map(i => i.name)).toEqual(fromNoBars.inputs.map(i => i.name));
    expect(fromAbort!.title).toBe(fromNoBars.title);
    expect(fromAbort!.alertconditions).toEqual([]);
    expect(fromAbort!.warnings).toEqual([]);
  });
});

describe('2. regression — no-mtf scripts + fast path', () => {
  it('no request.security: prefetch stage still runs, yield still fires, hops increment', async () => {
    resetMtf();
    const spy = fastClock();
    const stageAtYield: unknown[] = [];
    const hopsBefore = yieldStats.hops;
    try {
      await runScript(parse('indicator("p")\nplot(close)'), mkBarData(10), {
        shouldAbort: () => { stageAtYield.push(stage()); return false; },
      });
    } finally {
      spy.mockRestore();
    }
    expect(yieldStats.hops).toBeGreaterThan(hopsBefore);
    // shouldAbort fires per bar-loop yield ('barloop') and once post-loop
    // ('assemble') — both observed, in order.
    const barloopIdx = stageAtYield.indexOf('barloop');
    const assembleIdx = stageAtYield.indexOf('assemble');
    expect(barloopIdx).toBeGreaterThanOrEqual(0);
    expect(assembleIdx).toBeGreaterThan(barloopIdx);
    expect(assembleIdx).toBe(stageAtYield.length - 1);
    expect(stage()).toBe('assemble');
  });

  it('small/fast script on real clock: zero yields (hops unchanged), result intact', async () => {
    resetMtf();
    const hopsBefore = yieldStats.hops;
    const res = await runScript(parse('indicator("f")\nplot(close)'), mkBarData(20));
    expect(yieldStats.hops).toBe(hopsBefore);
    expect([...res.plots.values()][0]!.values).toHaveLength(20);
  });
});

describe('3. shouldAbort contract + engine empty-model flicker', () => {
  it('abort mid-loop returns empty() and does not throw barErr', async () => {
    resetMtf();
    const spy = fastClock();
    try {
      // Script that would throw barErr at bar 0 — abort must still win cleanly.
      const res = await runScript(parse('indicator("a")\nx := 1\nplot(1)'), mkBarData(8), {
        shouldAbort: () => true,
      });
      expect(res.plots.size).toBe(0);
      expect(res.title).toBe('a'); // decl metadata still populated
    } finally {
      spy.mockRestore();
    }
  });

  it('engine: stop() mid-run → no onModel/onError/onDone (aborted result never emitted)', async () => {
    resetMtf();
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SEC_SRC, 'qa3');
    const gate = Promise.withResolvers<void>();
    let fetchCalls = 0;
    const { models, onModel } = collect();
    const errors: unknown[] = [];
    let dones = 0;
    const req: ExecutionRequest = {
      prepared,
      market: { symbol: 'TEST', timeframe: '15' },
      bars: mkOhlcv(6),
      mode: 'static',
      fetchSeries: async () => { fetchCalls++; await gate.promise; return mkOhlcv(2); },
    };
    const spy = fastClock(); // bar loop yields right after prefetch resolves
    try {
      const session = engine.execute(req, {
        onModel,
        onError: e => errors.push(e),
        onDone: () => dones++,
      });
      while (fetchCalls === 0) await turn(); // run parked in prefetch (real signal)
      const hopsBefore = yieldStats.hops;
      session.stop();
      gate.resolve();
      // Mutex barrier: a queued runScript settles only after the aborted run's
      // drain iteration completes — deterministic completion signal.
      await runScript(parse('indicator("barrier")\nplot(close)'), mkBarData(2));
      expect(yieldStats.hops).toBeGreaterThan(hopsBefore); // aborted via a real yield
      expect(models).toEqual([]);
      expect(errors).toEqual([]);
      expect(dones).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('4. runScript mutex', () => {
  it('second runScript cannot enter prefetch while first is parked', async () => {
    resetMtf();
    const gate = Promise.withResolvers<void>();
    let aFetch = 0, bFetch = 0;
    const pA = runScript(parse(SEC_SRC), mkBarData(6), {
      timeframe: '15',
      fetchSeries: async () => { aFetch++; await gate.promise; return mkBarData(2, 3_600_000); },
    });
    const pB = runScript(parse(SEC_SRC), mkBarData(6), {
      timeframe: '15',
      fetchSeries: async () => { bFetch++; return mkBarData(2, 3_600_000); },
    });
    while (aFetch === 0) await turn(); // A parked on gate
    await turn(); await turn(); // B would reach its fetchSeries if not serialized
    expect(bFetch).toBe(0);
    gate.resolve();
    await pA;
    await vi.waitFor(() => expect(bFetch).toBe(1)); // B only after A settled
    await pB;
  });

  it('a rejecting run does not poison the tail — next run proceeds', async () => {
    resetMtf();
    await expect(runScript(parse('indicator("x")\nx := 1'), mkBarData(3))).rejects.toThrow();
    const res = await runScript(parse('indicator("ok")\nplot(close)'), mkBarData(3));
    expect([...res.plots.values()][0]!.values).toHaveLength(3);
  });

  it('call order preserved: queued B resolves only after parked A settles', async () => {
    resetMtf();
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const pA = runScript(parse(SEC_SRC), mkBarData(6), {
      timeframe: '15',
      fetchSeries: async () => { await gate.promise; return mkBarData(2, 3_600_000); },
    }).then(r => { order.push('A'); return r; });
    const pB = runScript(parse('indicator("b")\nplot(open)'), mkBarData(3))
      .then(r => { order.push('B'); return r; });
    await turn(); // give B a chance; it is behind A on the mutex
    gate.resolve();
    await Promise.all([pA, pB]);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
  });
});

describe('5. yieldStats + __pineStage', () => {
  it('hops increments only inside the message callback; maxWait recorded ≥0', async () => {
    resetMtf();
    const spy = fastClock();
    const hopsBefore = yieldStats.hops;
    try {
      await runScript(parse('indicator("s")\nplot(close)'), mkBarData(10));
    } finally {
      spy.mockRestore();
    }
    expect(yieldStats.hops).toBeGreaterThan(hopsBefore);
    expect(yieldStats.maxWait).toBeGreaterThanOrEqual(0);
  });

  it('security script: stage order prefetch → barloop → assemble', async () => {
    resetMtf();
    const seen: string[] = [];
    const spy = fastClock();
    try {
      await runScript(parse(SEC_SRC), mkBarData(6), {
        timeframe: '15',
        fetchSeries: async () => { seen.push(String(stage())); return mkBarData(2, 3_600_000); },
        shouldAbort: () => { seen.push(String(stage())); return false; },
      });
    } finally {
      spy.mockRestore();
    }
    seen.push(String(stage()));
    expect(seen[0]).toBe('prefetch');
    expect(seen.filter(s => s === 'barloop').length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe('assemble');
    expect(seen.indexOf('prefetch')).toBeLessThan(seen.indexOf('barloop'));
    expect(seen.lastIndexOf('barloop')).toBeLessThan(seen.indexOf('assemble'));
  });
});

describe('engine drain — coalescing', () => {
  it('multiple update()s during in-flight run coalesce to ONE pending run; superseded run still emits', async () => {
    resetMtf();
    const engine = new PineInterpreterEngine();
    const src = 'indicator("g")\nn = input.int(5, "len")\nh = request.security(syminfo.tickerid, "60", close)\nplot(n * 100 + h * 0, "v")';
    const prepared = await engine.prepare(src, 'qa-coal');
    const gate = Promise.withResolvers<void>();
    let fetchCalls = 0;
    const { models, onModel, waitFor } = collect();
    const errors: unknown[] = [];
    let dones = 0;
    const session = engine.execute(
      {
        prepared,
        market: { symbol: 'TEST', timeframe: '15' },
        bars: mkOhlcv(6),
        mode: 'static',
        fetchSeries: async () => { fetchCalls++; if (fetchCalls === 1) await gate.promise; return mkOhlcv(2); },
      },
      { onModel, onError: e => errors.push(e), onDone: () => dones++ },
    );
    while (fetchCalls === 0) await turn(); // parked in prefetch
    session.update({ len: 7 });
    session.update({ len: 8 });
    session.update({ len: 9 });
    gate.resolve();
    await waitFor(2); // event-driven: resolves when the 2nd model lands
    await vi.waitFor(() => expect(dones).toBe(2));
    expect(errors).toEqual([]);
    expect(models).toHaveLength(2); // superseded emits, 3 updates → 1 pending run
    const last = models[1]!;
    const line = last.series.find(s => 'points' in s);
    expect(line && 'points' in line ? line.points.at(-1)?.value : null).toBe(900);
  });
});
