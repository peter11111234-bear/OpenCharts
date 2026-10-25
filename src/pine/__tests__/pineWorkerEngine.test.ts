import { afterEach, describe, expect, it, vi } from 'vitest';
import { PineWorkerEngine } from '../pineWorkerEngine';
import { PineInterpreterEngine } from '../engine';
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

  it('a live tick reuses the worker session; its model equals a cold run of the same bars', async () => {
    // Coverage gap this closes: every other test here is mode:'static' and
    // one-shot, so nothing ever ticked a worker-backend session. The worker
    // realm runs its OWN incRunStart/incAdvance (pineWorker.ts keys IncLive by
    // incKey), so the tick path — including the forming-bar rollback — had no
    // cross-realm coverage at all.
    //
    // The tick rewrites the FORMING bar: that is the only case incAdvance
    // does not bail to 'fallback' (a changed closed bar trips
    // `firstDiff <= live.committed` and forces a cold run), so it is the case
    // restoreCkpt + re-eval must get right — the repo's own invariant from
    // inc-parity.test.ts: "var counter must not double-apply on forming-bar
    // rollback".
    //
    // Note this test does NOT cover the trimCw guard: trimCw only drops a
    // rollback write-log, and mtfCheckpoint/mtfRestore restore from a full
    // snapshot, so removing that guard changes no value (verified by mutation
    // — the suite stayed green). trimCw is a memory bound; cwPeak and the
    // digest probes are its instrument, not this.
    const src = `//@version=6
indicator("t")
x = request.security("ES", "120", close)
var n = 0
n := n + 1
plot(n, title="n")
plot(x, title="x")
`;
    const fetched: BarData[] = [
      { openTime: 0, open: 0, high: 0, low: 0, close: 42, volume: 0 },
      { openTime: 3600000, open: 0, high: 0, low: 0, close: 43, volume: 0 },
    ];
    const fetchSeries = (): Promise<OHLCV[]> =>
      Promise.resolve(fetched.map(b => ({ ...b, time: b.openTime })) as OHLCV[]);

    const client = new PineRunClient({ factory: () => new FakeWorker() });
    const engine = new PineWorkerEngine(() => client);

    // 5 bars ⇒ lastClosed = 3, so trimCw fires on bars 0..2 during the build
    // and the session's checkpoint sits at bar 3.
    const startLive = async (bars: OHLCV[]) => {
      const prepared = await engine.prepare(src, 't1');
      const tape = { bars };
      const models: IndicatorModel[] = [];
      const waiters: (() => void)[] = [];
      const waitFor = (k: number): Promise<void> => {
        const { promise, resolve } = Promise.withResolvers<void>();
        if (models.length >= k) resolve();
        else waiters.push(() => { if (models.length >= k) resolve(); });
        return promise;
      };
      const session = engine.execute(
        mkReq(prepared, tape.bars, { mode: 'live', getBars: () => tape.bars, fetchSeries }),
        { onModel: (m) => { models.push(m); waiters.splice(0).forEach(w => w()); } },
      );
      return { tape, models, waitFor, session };
    };

    const live = await startLive(mkBars(5));
    await live.waitFor(1);
    // Rewrite the FORMING bar (index 4), same time — the rollback path.
    const revised = live.tape.bars.slice();
    revised[4] = { ...revised[4]!, close: 108.25 };
    live.tape.bars = revised;
    live.session.notifyBars();
    await live.waitFor(2);
    const alive = client.incAlive;
    live.session.stop();

    // Oracle: a fresh live session on the same final tape (same lastClosed).
    const cold = await startLive(revised);
    await cold.waitFor(1);
    cold.session.stop();

    expect(alive).toBe(true);                                   // tick reused the worker's session
    expect(live.models).toHaveLength(2);
    // 5 bars ⇒ n counts bars seen: 5 at the forming bar, never 6. A rollback
    // that failed to undo the first bar-4 evaluation would double-apply it.
    expect(pointsOf(live.models[1]!, 0)[4]!.value).toBe(5);
    expect(pointsOf(cold.models[0]!, 1).some(p => p.value !== null)).toBe(true);
    expect(pointsOf(live.models[1]!)).toEqual(pointsOf(cold.models[0]!));
    expect(pointsOf(live.models[1]!, 1)).toEqual(pointsOf(cold.models[0]!, 1));
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

// BUG 4 / engine seam: a run whose worker never replies must reject through
// the engine WITHOUT falling back to the in-process interpreter (a fallback
// would silently run the wedged script on the UI thread) and without poisoning
// the client for later runs.
describe('PineWorkerEngine run timeout', () => {
  class SilentWorker implements WorkerLike {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessageerror: ((e: unknown) => void) | null = null;
    readonly postMessage = vi.fn((_m: unknown) => { /* never answers */ });
    readonly terminate = vi.fn();
  }

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** Starts a run against a mute worker and advances past the deadline. */
  const runToDeadline = async (timeoutMs: number) => {
    const w = new SilentWorker();
    const client = new PineRunClient({ factory: () => w, timeoutMs });
    const engine = new PineWorkerEngine(() => client);
    const prepared = await engine.prepare(`//@version=6
indicator("t")
plot(close)
`, 't1');
    const err = Promise.withResolvers<Error>();
    const models: IndicatorModel[] = [];
    const state = { settled: false };
    void err.promise.then(() => { state.settled = true; }, () => { state.settled = true; });
    vi.useFakeTimers();
    const session = engine.execute(mkReq(prepared, mkBars(4)), {
      onModel: (m) => models.push(m),
      onError: err.resolve,
    });
    await vi.advanceTimersByTimeAsync(timeoutMs);
    return { w, client, models, session, error: err.promise, state };
  };

  it('rejects without falling back to the in-process interpreter', async () => {
    // super.runProgram is the fallback seam; a timeout must not reach it.
    const spy = vi.spyOn(
      PineInterpreterEngine.prototype as unknown as { runProgram: (...a: unknown[]) => Promise<unknown> },
      'runProgram',
    );
    const run = await runToDeadline(5_000);
    expect(run.state.settled).toBe(true);
    const e = await run.error;
    expect(e.message).toMatch(/timed out/);
    expect(spy).not.toHaveBeenCalled();
    expect(run.models).toHaveLength(0);
    run.session.stop();
  });

  it('does not mark the client unavailable — later runs still use the worker', async () => {
    const run = await runToDeadline(5_000);
    expect(run.state.settled).toBe(true);
    await run.error;
    expect(run.client.unavailable).toBe(false);
    expect(run.w.terminate).toHaveBeenCalledTimes(1);   // wedged worker killed
    run.session.stop();
  });
});
