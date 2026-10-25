// A script that blows the run deadline must be SUSPENDED, not retried forever.
// Before this, drain()'s catch reported the error but left lastRunMs stale, so
// every tick re-ran the wedged script and re-timed-out — a permanent error
// storm pinning the worker/CPU. Suspension lifts on a new session (the user
// edits the source → updateCode → execute) and on a successful update() rerun
// (input change) — 2026-10-25 user decision. An update() rerun that times out
// leaves the suspension in place; only a later change can pierce it again.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PineInterpreterEngine } from '../engine';
import { PineWorkerEngine } from '../pineWorkerEngine';
import { PineRunClient, PineRunTimeoutError, type WorkerLike } from '../pineWorkerClient';
import type { FromWorker, ToWorker } from '../pineWorkerProto';
import type { BarData, RunResult } from '../contracts';
import type { ExecutionRequest, ExecutionSession, IndicatorModel, OHLCV, PreparedScript } from '@luxalgo/vela';
import type { IncLive, ParsedInput } from '../interpreter';
import '../builtins/index';
import '../mtf';

const mkBars = (n: number): OHLCV[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * 3600000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000 + i,
  }));

const mkReq = (prepared: PreparedScript, bars: OHLCV[]): ExecutionRequest => ({
  prepared,
  market: { symbol: 'TEST', timeframe: '60' },
  bars,
  mode: 'static',
});

const SRC = `//@version=6
indicator("t")
plot(close)
`;

/** Drain the engine's await chain — every settle path here is promise-based. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

interface RunProgramSeam { runProgram: (...a: unknown[]) => Promise<unknown> }

/** `runProgram` is `protected` at compile time only — this is the runtime seam. */
const runSeam = (engine: PineInterpreterEngine): RunProgramSeam =>
  engine as unknown as RunProgramSeam;

/** Drive one execute session and collect its error callbacks. */
const startSession = (
  engine: PineInterpreterEngine,
  prepared: PreparedScript,
  onModel?: (m: IndicatorModel) => void,
): { session: ExecutionSession; errors: Error[] } => {
  const errors: Error[] = [];
  const session = engine.execute(mkReq(prepared, mkBars(8)), {
    onModel: onModel ?? (() => {}),
    onError: (e) => { errors.push(e); },
  });
  return { session, errors };
};

const saysTimeout = () => Promise.reject(new PineRunTimeoutError(60));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('engine: timeout suspends the session instead of retrying every tick', () => {
  it('A: onError fires once with the 暫停 message', async () => {
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SRC, 't1');
    const spy = vi.spyOn(runSeam(engine), 'runProgram').mockImplementation(saysTimeout);
    const { errors } = startSession(engine, prepared);
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('暫停');
    expect(errors[0]!.message).toContain('逾時');
    expect(spy.mock.calls).toHaveLength(1);
  });

  it('B: three ticks after the timeout never re-run the script', async () => {
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SRC, 't1');
    const spy = vi.spyOn(runSeam(engine), 'runProgram').mockImplementation(saysTimeout);
    const { session } = startSession(engine, prepared);
    await flush();
    expect(spy.mock.calls).toHaveLength(1);
    session.notifyBars(); // live tick (no reason)
    session.notifyBars(); // live tick (no reason)
    session.notifyBars(); // live tick (no reason)
    await flush();
    expect(spy.mock.calls).toHaveLength(1);
  });

  it('C: a user input change still forces one run through the suspension', async () => {
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SRC, 't1');
    const spy = vi.spyOn(runSeam(engine), 'runProgram').mockImplementation(saysTimeout);
    const { session } = startSession(engine, prepared);
    await flush();
    expect(spy.mock.calls).toHaveLength(1);
    session.update({ len: 7 });
    await flush();
    expect(spy.mock.calls).toHaveLength(2);
  });

  it('D: a NEW session (code edit) runs normally after a timeout', async () => {
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SRC, 't1');
    const spy = vi.spyOn(runSeam(engine), 'runProgram').mockImplementation(saysTimeout);
    startSession(engine, prepared);
    await flush();
    expect(spy.mock.calls).toHaveLength(1);
    // updateCode stops the old session and execute()s the new source — a fresh
    // closure, so the suspension does not carry over.
    spy.mockRestore();
    const models: IndicatorModel[] = [];
    startSession(engine, prepared, (m) => models.push(m));
    // Real interpreter run — await the emit itself, not a guessed tick count.
    await vi.waitFor(() => expect(models).toHaveLength(1));
  });

  it('F: a tick that arrived DURING the timed-out run must not re-run', async () => {
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SRC, 't1');
    const gate = Promise.withResolvers<RunResult>();
    const spy = vi.spyOn(runSeam(engine), 'runProgram').mockImplementation(() => gate.promise);
    const { session } = startSession(engine, prepared);
    await flush();
    expect(spy.mock.calls).toHaveLength(1);
    session.notifyBars(); // live tick (no reason) // lands while the run is in flight
    gate.reject(new PineRunTimeoutError(60));
    await flush();
    expect(spy.mock.calls).toHaveLength(1);
  });

  it("G: notifyBars('complete') does not lift the suspension", async () => {
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SRC, 't1');
    const spy = vi.spyOn(runSeam(engine), 'runProgram').mockImplementation(saysTimeout);
    const { session } = startSession(engine, prepared);
    await flush();
    session.notifyBars('complete');
    await flush();
    expect(spy.mock.calls).toHaveLength(1);
  });

  it('H: a SUCCESSFUL update() rerun lifts the suspension, so later ticks run', async () => {
    // 2026-10-25 使用者決定：成功的 update（改參數）解除暫停。
    // The old assertion pinned the opposite — the suspension survived the
    // update() rerun and later ticks stayed blocked.
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SRC, 't1');
    const spy = vi.spyOn(runSeam(engine), 'runProgram').mockImplementationOnce(saysTimeout);
    const models: IndicatorModel[] = [];
    const { session } = startSession(engine, prepared, (m) => models.push(m));
    await flush();
    expect(spy.mock.calls).toHaveLength(1);
    session.update({ len: 3 });   // pierces the suspension, then runs for real
    await vi.waitFor(() => expect(models).toHaveLength(1));
    expect(spy.mock.calls).toHaveLength(2);
    session.notifyBars();         // live tick (no reason) — suspension is gone
    await vi.waitFor(() => expect(spy.mock.calls).toHaveLength(3));
  });

  it('I: an update() rerun that times out keeps the suspension', async () => {
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SRC, 't1');
    const spy = vi.spyOn(runSeam(engine), 'runProgram').mockImplementation(saysTimeout);
    const { session } = startSession(engine, prepared);
    await flush();
    session.update({ len: 3 });
    await flush();
    expect(spy.mock.calls).toHaveLength(2);
    session.notifyBars(); // live tick (no reason) // still suspended
    await flush();
    expect(spy.mock.calls).toHaveLength(2);
  });

  it('J: a tick during the revived run is dropped; ticks run again once it succeeds', async () => {
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SRC, 't1');
    const spy = vi.spyOn(runSeam(engine), 'runProgram').mockImplementationOnce(saysTimeout);
    const models: IndicatorModel[] = [];
    const { session } = startSession(engine, prepared, (m) => models.push(m));
    await flush();
    expect(spy.mock.calls).toHaveLength(1);
    session.update({ len: 3 });   // pierces the suspension
    session.notifyBars();         // live tick, still suspended at this instant — dropped
    await vi.waitFor(() => expect(models).toHaveLength(1)); // the rerun succeeded
    expect(spy.mock.calls).toHaveLength(2);
    session.notifyBars();         // live tick (no reason) // suspension lifted
    await vi.waitFor(() => expect(spy.mock.calls).toHaveLength(3));
  });

  it('K: the timeout message carries the underlying reason', async () => {
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(SRC, 't1');
    vi.spyOn(runSeam(engine), 'runProgram').mockImplementation(
      () => Promise.reject(new PineRunTimeoutError(300, '(total run-time limit)')),
    );
    const { errors } = startSession(engine, prepared);
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('total run-time limit');
    expect(errors[0]!.message).toContain('暫停');
    expect(errors[0]!.message).toContain('逾時');
  });
});

describe('PineWorkerEngine: timeout clears the incremental holder', () => {
  class SilentWorker implements WorkerLike {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessageerror: ((e: unknown) => void) | null = null;
    readonly postMessage = vi.fn((_m: unknown) => { /* never answers */ });
    readonly terminate = vi.fn();
  }

  interface WorkerSeam {
    runProgram: (p: ParsedInput, b: BarData[], o: Record<string, unknown>) => Promise<RunResult>;
  }

  it('E: rejects PineRunTimeoutError, nulls incHolder, never falls back in-process', async () => {
    const fallback = vi.spyOn(
      PineInterpreterEngine.prototype as unknown as { runProgram: (...a: unknown[]) => Promise<unknown> },
      'runProgram',
    );
    vi.useFakeTimers();
    const client = new PineRunClient({ factory: () => new SilentWorker(), timeoutMs: 5_000 });
    const engine = new PineWorkerEngine(() => client);
    const holder: { live: IncLive | null; active?: boolean } = { live: {} as IncLive, active: true };
    /** `runProgram` is `protected` at compile time only. */
    const seam = engine as unknown as WorkerSeam;
    const run = seam.runProgram({} as ParsedInput, [], {
      symbol: 'TEST', timeframe: '60', incHolder: holder, sessionCtx: client,
    });
    const settled = expect(run).rejects.toBeInstanceOf(PineRunTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    expect(holder.live).toBe(null);
    expect(holder.active).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('PineRunClient total run-time ceiling', () => {
  class FetchWorker implements WorkerLike {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessageerror: ((e: unknown) => void) | null = null;
    readonly terminate = vi.fn();
    readonly postMessage = vi.fn((_m: unknown) => { /* never finishes */ });
    askFetch(fid: number): void {
      this.onmessage?.({ data: { t: 'fetchReq', fid, sym: 'ES', tf: '120' } satisfies FromWorker });
    }
    replyDone(id: number): void {
      this.onmessage?.({ data: { t: 'done', id, result: { plots: new Map() } as unknown as RunResult } satisfies FromWorker });
    }
    get runId(): number {
      const m = this.postMessage.mock.calls[0]?.[0] as ToWorker | undefined;
      return m?.t === 'run' ? m.id : -1;
    }
  }

  it('(a) repeated in-budget fetches still hit the wall-clock ceiling', async () => {
    vi.useFakeTimers();
    const w = new FetchWorker();
    const client = new PineRunClient({ factory: () => w, timeoutMs: 60_000, totalTimeoutMs: 100_000 });
    const gates: Array<PromiseWithResolvers<BarData[]>> = [];
    const run = client.run({
      source: 'plot(close)', bars: [],
      opts: {
        fetchSeries: () => {
          const g = Promise.withResolvers<BarData[]>();
          gates.push(g);
          return g.promise;
        },
      },
    });
    const settled = expect(run).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1);
    w.askFetch(1);
    await vi.advanceTimersByTimeAsync(40_000);   // run clock paused, wall clock runs
    gates[0]!.resolve([]);
    await vi.advanceTimersByTimeAsync(1);
    w.askFetch(2);
    await vi.advanceTimersByTimeAsync(60_000);   // wall clock now past 100s
    await settled;
    await expect(run).rejects.toThrow(/total/);
    expect(w.terminate).toHaveBeenCalledTimes(1);
  });

  it('(b) a run under the ceiling is unaffected', async () => {
    vi.useFakeTimers();
    const w = new FetchWorker();
    const client = new PineRunClient({ factory: () => w, timeoutMs: 60_000, totalTimeoutMs: 5_000 });
    const run = client.run({ source: 'plot(close)', bars: [] });
    await vi.advanceTimersByTimeAsync(4_000);
    w.replyDone(w.runId);
    await expect(run).resolves.toBeDefined();
  });

  it('(c) the ceiling timer is cleared on done and on dispose', async () => {
    vi.useFakeTimers();
    const w = new FetchWorker();
    const client = new PineRunClient({ factory: () => w, timeoutMs: 60_000, totalTimeoutMs: 300_000 });
    const run = client.run({ source: 'plot(close)', bars: [] });
    w.replyDone(w.runId);
    await expect(run).resolves.toBeDefined();
    expect(vi.getTimerCount()).toBe(0);

    const second = client.run({ source: 'plot(close)', bars: [] });
    const rejected = expect(second).rejects.toThrow('disposed');
    client.dispose();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
