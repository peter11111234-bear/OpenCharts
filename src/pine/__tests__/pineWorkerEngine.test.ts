import { describe, expect, it } from 'vitest';
import { PineWorkerEngine } from '../pineWorkerEngine';
import { PineRunClient, type WorkerLike } from '../pineWorkerClient';
import { createWorkerHandler } from '../pineWorker';
import type { FromWorker, ToWorker } from '../pineWorkerProto';
import type { BarData } from '../contracts';
import type { ExecutionRequest, IndicatorModel, OHLCV, PreparedScript } from '@luxalgo/vela';

// FakeWorker: runs createWorkerHandler in-process, messages cross on
// microtasks so ordering matches a real worker's async postMessage.
class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  terminated = false;
  readonly sawRun = Promise.withResolvers<void>();
  private readonly handler = createWorkerHandler((m) => this.dispatchToMain(m));

  postMessage(m: unknown): void {
    const msg = m as ToWorker;
    queueMicrotask(() => {
      if (this.terminated) return;
      if (msg.t === 'run') this.sawRun.resolve();
      this.handler(msg);
    });
  }
  private dispatchToMain(m: FromWorker): void {
    queueMicrotask(() => this.onmessage?.({ data: m }));
  }
  terminate(): void { this.terminated = true; }
}

const pointsOf = (m: IndicatorModel, i = 0): { value: number | null }[] => {
  const s = m.series[i];
  if (!s || s.kind === 'markers' || !('points' in s)) return [];
  return s.points;
};

const mkBars = (n: number): OHLCV[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * 3600000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000 + i,
  }));

const mkReq = (prepared: PreparedScript, bars: OHLCV[], extra?: Partial<ExecutionRequest>): ExecutionRequest => ({
  prepared,
  market: { symbol: 'TEST', timeframe: '60' },
  bars,
  mode: 'static',
  ...extra,
});

const runOnce = async (engine: PineWorkerEngine, src: string, bars: OHLCV[], extra?: Partial<ExecutionRequest>): Promise<IndicatorModel> => {
  const prepared = await engine.prepare(src, 't1');
  const { promise, resolve, reject } = Promise.withResolvers<IndicatorModel>();
  engine.execute(mkReq(prepared, bars, extra), {
    onModel: resolve,
    onError: reject,
  });
  return promise;
};

describe('PineWorkerEngine (FakeWorker in-process)', () => {
  it('runs a script through the worker protocol and emits a model', async () => {
    const w = new FakeWorker();
    const engine = new PineWorkerEngine(() => new PineRunClient({ factory: () => w }));
    const model = await runOnce(engine, `//@version=6
indicator("t", overlay=true)
plot(close, title="c")
`, mkBars(10));
    const pts = pointsOf(model);
    expect(pts).toHaveLength(10);
    expect(pts[0]!.value).toBeCloseTo(100.5);
  });

  it('request.security fetches via the fetchReq/fetchRes RPC', async () => {
    const engine = new PineWorkerEngine(() => new PineRunClient({ factory: () => new FakeWorker() }));
    const fetched: BarData[] = [
      { openTime: 0, open: 0, high: 0, low: 0, close: 42, volume: 0 },
      { openTime: 3600000, open: 0, high: 0, low: 0, close: 43, volume: 0 },
    ];
    const seen: string[] = [];
    const model = await runOnce(engine, `//@version=6
indicator("t")
x = request.security("ES", "120", close)
plot(x, title="x")
`, mkBars(4), {
      fetchSeries: (sym: string, tf: string) => {
        seen.push(`${sym}|${tf}`);
        return Promise.resolve(fetched.map(b => ({ ...b, time: b.openTime })) as OHLCV[]);
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(pointsOf(model).some(p => p.value !== null)).toBe(true);
  });

  it('stop() aborts + disposes the worker mid-run', async () => {
    const w = new FakeWorker();
    const engine = new PineWorkerEngine(() => new PineRunClient({ factory: () => w }));
    const prepared = await engine.prepare(`//@version=6
indicator("t")
plot(close)
`, 't1');
    let models = 0;
    const session = engine.execute(mkReq(prepared, mkBars(50)), {
      onModel: () => { models++; },
    });
    await w.sawRun.promise;   // deterministic: worker received the run
    session.stop();
    expect(w.terminated).toBe(true);
    expect(models).toBe(0);
  });
  it('surfaces a script error with name/line carried over the wire', async () => {
    const engine = new PineWorkerEngine(() => new PineRunClient({ factory: () => new FakeWorker() }));
    const prepared = await engine.prepare(`//@version=6
indicator("t")
x := 1   // reassign undeclared → PineRuntimeError at line 3
`, 't1');
    const { promise, resolve, reject } = Promise.withResolvers<Error>();
    engine.execute(mkReq(prepared, mkBars(5)), {
      onModel: () => reject(new Error('unexpected model')),
      onError: resolve,
    });
    const err = await promise;
    expect(err.name).toBe('PineRuntimeError');
    expect(err.message).toMatch(/undeclared/i);
  });

  it('concurrent execute() sessions on one engine each get their own worker', async () => {
    // Regression: Vela creates ONE engine per chart but a chart can host
    // several pine indicators → several execute() sessions. A shared client
    // would reject the second run 'run in flight'; per-session clients must
    // not (stop() of one session must also not kill the other's worker).
    const workers: FakeWorker[] = [];
    const engine = new PineWorkerEngine(() => new PineRunClient({
      factory: () => { const w = new FakeWorker(); workers.push(w); return w; },
    }));
    const src = `//@version=6
indicator("t")
plot(close)
`;
    const p1 = await engine.prepare(src, 's1');
    const p2 = await engine.prepare(src, 's2');
    const m1 = Promise.withResolvers<IndicatorModel>();
    const m2 = Promise.withResolvers<IndicatorModel>();
    const s1 = engine.execute(mkReq(p1, mkBars(8)), { onModel: m1.resolve });
    const s2 = engine.execute(mkReq(p2, mkBars(8)), { onModel: m2.resolve });
    const [model1, model2] = await Promise.all([m1.promise, m2.promise]);
    expect(pointsOf(model1)).toHaveLength(8);
    expect(pointsOf(model2)).toHaveLength(8);
    expect(workers).toHaveLength(2);
    s1.stop();
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.terminated).toBe(false);
    s2.stop();
  });

  it('no Worker global + no factory → falls back to in-process run', async () => {
    // jsdom has no Worker; a bare client reports unavailable and the engine
    // must produce the same model via super.runProgram.
    const engine = new PineWorkerEngine(() => new PineRunClient());
    const model = await runOnce(engine, `//@version=6
indicator("t")
plot(close)
`, mkBars(6));
    expect(pointsOf(model)).toHaveLength(6);
  });
});

describe('PineRunClient', () => {
  it('rejects a second run while one is in flight', async () => {
    // Gate-worker: holds 'run' until released; second run must reject sync-side.
    class GatedWorker implements WorkerLike {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      readonly gate = Promise.withResolvers<void>();
      postMessage(m: unknown): void {
        const msg = m as ToWorker;
        if (msg.t !== 'run') return;
        void this.gate.promise.then(() => this.onmessage?.({
          data: { t: 'done', id: msg.id, result: {
            plots: new Map(), drawings: [], fills: [], bgcolors: new Map(),
            barcolors: new Map(), alerts: [], alertconditions: [], logs: [], warnings: [],
            inputs: [], props: [], title: '', overlay: false,
          } } satisfies FromWorker,
        }));
      }
      terminate(): void { /* noop */ }
    }
    const w = new GatedWorker();
    const client = new PineRunClient({ factory: () => w });
    const first = client.run({ source: '', bars: [] });
    await expect(client.run({ source: '', bars: [] })).rejects.toThrow('run in flight');
    w.gate.resolve();
    await expect(first).resolves.toBeDefined();
  });

  it('ignores a done whose id does not match the live run', async () => {
    // A stray/out-of-order result must not settle the current pending run —
    // only a reply carrying the live id may resolve it.
    class StubWorker implements WorkerLike {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      postMessage(m: unknown): void {
        const msg = m as ToWorker;
        if (msg.t !== 'run') return;
        // Stray done with a wrong id arrives first, the real reply second.
        this.onmessage?.({ data: { t: 'done', id: 999, result: {} } });
        this.onmessage?.({
          data: { t: 'done', id: msg.id, result: {
            plots: new Map(), drawings: [], fills: [], bgcolors: new Map(),
            barcolors: new Map(), alerts: [], alertconditions: [], logs: [], warnings: [],
            inputs: [], props: [], title: 'real', overlay: false,
          } } satisfies FromWorker,
        });
      }
      terminate(): void { /* noop */ }
    }
    const client = new PineRunClient({ factory: () => new StubWorker() });
    const r = await client.run({ source: '', bars: [] });
    expect(r.title).toBe('real');
  });

  it('drops malformed payloads without wedging the pending run', async () => {
    // nullish/primitive messages must not throw inside onmessage — an uncaught
    // throw there would strand the run promise forever.
    class StubWorker implements WorkerLike {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      postMessage(m: unknown): void {
        const msg = m as ToWorker;
        if (msg.t !== 'run') return;
        this.onmessage?.({ data: null });
        this.onmessage?.({ data: 42 });
        this.onmessage?.({ data: { t: 'fail', id: msg.id, error: { name: 'Error', message: 'boom' } } });
      }
      terminate(): void { /* noop */ }
    }
    const client = new PineRunClient({ factory: () => new StubWorker() });
    await expect(client.run({ source: '', bars: [] })).rejects.toThrow('boom');
  });

  it('answers a malformed fetchReq with ok:false instead of dropping it', async () => {
    // A fetchReq missing sym/tf must get a reply — silently dropping it leaks
    // the worker-side pending Map entry until the run settles.
    class StubWorker implements WorkerLike {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      readonly replies: ToWorker[] = [];
      postMessage(m: unknown): void {
        const msg = m as ToWorker;
        if (msg.t === 'fetchRes') { this.replies.push(msg); return; }
        if (msg.t !== 'run') return;
        this.onmessage?.({ data: { t: 'fetchReq', fid: 7, sym: 'ES' } }); // tf missing
        this.onmessage?.({ data: { t: 'fail', id: msg.id, error: { name: 'Error', message: 'x' } } });
      }
      terminate(): void { /* noop */ }
    }
    const w = new StubWorker();
    const client = new PineRunClient({ factory: () => w });
    await expect(client.run({ source: '', bars: [], opts: { fetchSeries: async () => [] } }))
      .rejects.toThrow('x');
    expect(w.replies).toEqual([{ t: 'fetchRes', fid: 7, ok: false, error: 'malformed or unpending fetchReq' }]);
  });
});
