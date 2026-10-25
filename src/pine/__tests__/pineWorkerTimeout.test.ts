// BUG 4 — a run whose worker never replies must reject on a deadline instead
// of leaving the editor's "Running…" state pending forever.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PineRunClient, type WorkerLike } from '../pineWorkerClient';
import type { FromWorker, ToWorker } from '../pineWorkerProto';
import type { BarData, RunResult } from '../contracts';

const mkResult = (): RunResult => ({ plots: new Map() }) as unknown as RunResult;

class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  readonly sent: ToWorker[] = [];
  readonly postMessage = vi.fn((m: unknown) => { this.sent.push(m as ToWorker); });
  readonly terminate = vi.fn();
  /** Last `run` id this worker was asked to execute. */
  get lastRunId(): number {
    const m = this.sent.at(-1);
    if (!m || m.t !== 'run') throw new Error('no run message sent');
    return m.id;
  }
  replyDone(id: number): void {
    this.onmessage?.({ data: { t: 'done', id, result: mkResult() } satisfies FromWorker });
  }
  /** The `run` id this worker was first asked to execute (survives fetchRes). */
  get runId(): number {
    const m = this.sent.find((x) => x.t === 'run');
    if (!m || m.t !== 'run') throw new Error('no run message sent');
    return m.id;
  }
  /** Worker asks the main thread for an external series (request.security). */
  askFetch(fid: number): void {
    this.onmessage?.({ data: { t: 'fetchReq', fid, sym: 'ES', tf: '120' } satisfies FromWorker });
  }
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('PineRunClient run timeout', () => {
  it('rejects a run whose worker never replies', async () => {
    const w = new FakeWorker();
    const client = new PineRunClient({ factory: () => w, timeoutMs: 30_000 });
    const run = client.run({ source: 'plot(close)', bars: [] });
    const settled = expect(run).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
  });

  it('terminates the stuck worker and respawns on the next run', async () => {
    const workers: FakeWorker[] = [];
    const factory = vi.fn(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    const client = new PineRunClient({ factory, timeoutMs: 5_000 });

    const first = client.run({ source: 'plot(close)', bars: [] });
    const settled = expect(first).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;

    expect(factory).toHaveBeenCalledTimes(1);
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);

    const second = client.run({ source: 'plot(close)', bars: [] });
    expect(factory).toHaveBeenCalledTimes(2);
    const fresh = workers[1]!;
    fresh.replyDone(fresh.lastRunId);
    await expect(second).resolves.toBeDefined();
  });

  it('does not fire after a normal completion and leaves no timer behind', async () => {
    const w = new FakeWorker();
    const client = new PineRunClient({ factory: () => w, timeoutMs: 30_000 });
    const run = client.run({ source: 'plot(close)', bars: [] });

    await vi.advanceTimersByTimeAsync(10_000);
    w.replyDone(w.lastRunId);
    await expect(run).resolves.toBeDefined();
    expect(vi.getTimerCount()).toBe(0);

    // Well past the deadline: nothing may terminate/poison the client.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.terminate).not.toHaveBeenCalled();
    expect(client.unavailable).toBe(false);
  });

  it('accepts a new run after a timeout (pending cleared)', async () => {
    const workers: FakeWorker[] = [];
    const client = new PineRunClient({
      factory: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      timeoutMs: 5_000,
    });

    const first = client.run({ source: 'plot(close)', bars: [] });
    const settled = expect(first).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;

    const second = client.run({ source: 'plot(close)', bars: [] });
    const fresh = workers.at(-1)!;
    fresh.replyDone(fresh.lastRunId);
    await expect(second).resolves.toBeDefined();
  });
});

describe('PineRunClient deadline while a data fetch is in flight', () => {
  const track = (p: Promise<unknown>) => {
    const state = { settled: false };
    void p.then(() => { state.settled = true; }, () => { state.settled = true; });
    return state;
  };

  it('a 150s fetch does not consume the run deadline', async () => {
    const w = new FakeWorker();
    const client = new PineRunClient({ factory: () => w, timeoutMs: 300_000 });
    const gate = Promise.withResolvers<BarData[]>();
    const run = client.run({ source: 'plot(close)', bars: [], opts: { fetchSeries: () => gate.promise } });
    await vi.advanceTimersByTimeAsync(1);
    w.askFetch(1);
    await vi.advanceTimersByTimeAsync(150_000);   // slow provider, clock paused
    gate.resolve([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(20_000);    // active time still far under 300s
    w.replyDone(w.runId);
    await expect(run).resolves.toBeDefined();
    expect(w.terminate).not.toHaveBeenCalled();
  });

  it('a fetch that never answers rejects within the deadline and kills the worker', async () => {
    const w = new FakeWorker();
    const client = new PineRunClient({ factory: () => w, timeoutMs: 10_000 });
    const run = client.run({
      source: 'plot(close)', bars: [],
      opts: { fetchSeries: () => new Promise<BarData[]>(() => {}) },
    });
    const state = track(run);
    await vi.advanceTimersByTimeAsync(1);
    w.askFetch(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.settled).toBe(true);
    await expect(run).rejects.toThrow(/timed out/);
    expect(w.terminate).toHaveBeenCalledTimes(1);
  });

  it('the clock pauses for the fetch and resumes with the time that was left', async () => {
    const w = new FakeWorker();
    const client = new PineRunClient({ factory: () => w, timeoutMs: 60_000 });
    const gate = Promise.withResolvers<BarData[]>();
    const run = client.run({ source: 'plot(close)', bars: [], opts: { fetchSeries: () => gate.promise } });
    const state = track(run);
    await vi.advanceTimersByTimeAsync(20_000);    // 40s of deadline left
    w.askFetch(1);
    await vi.advanceTimersByTimeAsync(50_000);    // paused — must not accrue
    expect(state.settled).toBe(false);
    gate.resolve([]);
    await vi.advanceTimersByTimeAsync(39_000);    // 39s of the remaining 40
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);     // past the remaining 1s
    expect(state.settled).toBe(true);
    await expect(run).rejects.toThrow(/timed out/);
  });
});

describe('PineRunClient default deadline', () => {
  it('defaults to 60s', async () => {
    const w = new FakeWorker();
    const client = new PineRunClient({ factory: () => w });
    const run = client.run({ source: 'plot(close)', bars: [] });
    const state = { settled: false };
    void run.then(() => { state.settled = true; }, () => { state.settled = true; });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(state.settled).toBe(false);
    const rejected = expect(run).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  });
});
