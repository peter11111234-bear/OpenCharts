// Main-thread side of the pine worker RPC. Lazy-spawns a module Worker,
// serializes one run at a time, and proxies fetchSeries back to the caller.
import type { BarData, RunResult } from './contracts';
import type { RunOptions } from './interpreter';
import { PineRuntimeError } from './errors';
import type { FailError, ToWorker, FromWorker } from './pineWorkerProto';

/** Minimal Worker surface — tests inject a FakeWorker implementing this. */
export interface WorkerLike {
  postMessage(m: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror?: ((e: unknown) => void) | null;
}

export type FetchSeriesFn = (symbol: string, tf: string) => Promise<BarData[]>;

export interface ClientRunOpts extends Omit<RunOptions, 'fetchSeries' | 'shouldAbort'> {
  fetchSeries?: FetchSeriesFn;
}

interface PendingRun {
  id: number;
  resolve: (r: RunResult) => void;
  reject: (e: Error) => void;
  fetchSeries?: FetchSeriesFn;
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object';

function reviveError(e: FailError): Error {
  if (e.name === 'PineRuntimeError') {
    const err = new PineRuntimeError(e.message, { line: e.line ?? 0, col: e.col ?? 0 });
    if (e.stack) err.stack = e.stack;
    return err;
  }
  const err = new Error(e.message);
  err.name = e.name;
  if (e.stack) err.stack = e.stack;
  return err;
}

/**
 * Idle worker pool — a session's worker survives run end for the NEXT session to
 * reuse. Without this every indicator add/restore pays the full module-Worker
 * spawn (300–900ms in dev, still real in prod); a page with N pine indicators
 * multiplied that by N on every reload. Workers are stateless between runs (the
 * handler clears its pending map on settle), so reuse is safe. Factory-supplied
 * workers (tests) bypass the pool — the client owns their lifecycle contract.
 */
const POOL_CAP = 4;
const workerPool: WorkerLike[] = [];

/** Pre-warm the pool so a restore storm hits hot workers. Spawning overlaps
 *  provider history fetch — the first real run finds an idle worker. Call once
 *  after the workspace exists (VelaPage does). */
export function prewarmPineWorkers(n = 2): void {
  if (typeof Worker === 'undefined') return;
  for (let i = workerPool.length; i < Math.min(n, POOL_CAP); i++) {
    try {
      releaseWorker(new Worker(new URL('./pineWorker.ts', import.meta.url), { type: 'module' }) as WorkerLike);
    } catch { break; } // no worker support → engine falls back in-process anyway
  }
}

// A pooled worker that dies idle (module-eval failure, CSP kill) must not be
// handed out again — takeWorker would postMessage into a corpse and the run
// would hang forever with no fallback. Mark it dead on error and cull on take.
const deadWorkers = new Set<WorkerLike>();
function takeWorker(factory?: () => WorkerLike): WorkerLike {
  if (factory) return factory();
  while (workerPool.length) {
    const w = workerPool.pop()!;
    if (deadWorkers.delete(w)) { w.terminate(); continue; }
    w.onerror = null;
    return w;
  }
  return new Worker(new URL('./pineWorker.ts', import.meta.url), { type: 'module' }) as WorkerLike;
}
function releaseWorker(w: WorkerLike): void {
  if (workerPool.length >= POOL_CAP || deadWorkers.has(w)) { w.terminate(); return; }
  w.onmessage = null;
  // Keep an error watcher while idle: a dead pooled worker is a hang, not a fallback.
  w.onerror = () => { deadWorkers.add(w); };
  if (w.onmessageerror !== undefined) w.onmessageerror = () => { deadWorkers.add(w); };
  workerPool.push(w);
}

export class PineRunClient {
  private worker: WorkerLike | null = null;
  private pending: PendingRun | null = null;
  private nextId = 1;
  /** Set when the platform has no Worker or the worker dies on transport —
   *  callers fall back to in-process. Read-only for external consumers. */
  private _unavailable: boolean;
  get unavailable(): boolean { return this._unavailable; }
  private readonly factory?: () => WorkerLike;

  constructor(opts?: { factory?: () => WorkerLike }) {
    this.factory = opts?.factory;
    this._unavailable = typeof Worker === 'undefined' && !opts?.factory;
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const w = takeWorker(this.factory);
    w.onmessage = (e: { data: unknown }) => this.onMsg(e.data);
    w.onerror = (e: unknown) => this.onTransportError(e);
    w.onmessageerror = (e: unknown) => this.onTransportError(e);
    this.worker = w;
    return w;
  }

  private onTransportError(e: unknown): void {
    // A dead worker will die again on respawn — mark unavailable so the
    // engine falls back to in-process instead of looping spawn→crash.
    this._unavailable = true;
    const err = e instanceof Error ? e : new Error('worker error');
    this.pending?.reject(err);
    this.pending = null;
    this.dispose();
  }

  private onMsg(m: unknown): void {
    // Boundary validation, not a blind cast: nullish/primitive or wrongly
    // shaped payloads would throw inside onmessage — a worker-side throw is
    // uncaught and leaves `pending` hanging forever (session wedge).
    if (!isObj(m)) return;
    const msg = m as unknown as FromWorker;
    try {
      if (msg.t === 'done' || msg.t === 'fail') {
        const p = this.pending;
        if (!p || p.id !== msg.id) return; // stale/stray result must not settle the live run
        this.pending = null;
        // Settled cleanly → the worker is idle and stateless. Real workers go
        // to the pool so the next session skips spawn cost; factory-supplied
        // workers stay attached (their lifecycle is the caller's contract —
        // tests observe terminate() only on dispose/stop).
        if (!this.factory) {
          const w = this.worker;
          this.worker = null;
          if (w) releaseWorker(w);
        }
        if (msg.t === 'done') p.resolve(msg.result);
        else p.reject(reviveError(msg.error));
        return;
      }
      if (msg.t === 'fetchReq') {
        const fid = msg.fid;
        // Capture the worker that issued the request — a fetch resolving
        // after dispose/respawn must not post into a NEW worker, where a
        // colliding fid would silently feed it stale bars.
        const w = this.worker;
        const fetch = this.pending?.fetchSeries;
        // Malformed payloads answer ok:false (when a fid exists) instead of
        // being dropped — a dropped reply leaves the worker's pending Map
        // entry leaked until the run settles.
        if (!fetch || !w || typeof fid !== 'number' || typeof msg.sym !== 'string' || typeof msg.tf !== 'string') {
          if (w && typeof fid === 'number') w.postMessage({ t: 'fetchRes', fid, ok: false, error: 'malformed or unpending fetchReq' } satisfies ToWorker);
          return;
        }
        fetch(msg.sym, msg.tf).then(
          (bars) => w.postMessage({ t: 'fetchRes', fid, ok: true, bars } satisfies ToWorker),
          (e) => w.postMessage({ t: 'fetchRes', fid, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies ToWorker),
        );
      }
    } catch (e) {
      // Defensive settle: a post-snapshot throw would otherwise strand the
      // run promise forever (an exception inside worker.onmessage is
      // uncaught — it does NOT surface as worker.onerror).
      const p = this.pending;
      this.pending = null;
      p?.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  run(input: { source: string; bars: BarData[]; opts?: ClientRunOpts }): Promise<RunResult> {
    if (this.pending) return Promise.reject(new Error('run in flight'));
    if (this._unavailable) return Promise.reject(new Error('Worker unavailable'));
    let w: WorkerLike;
    try {
      w = this.ensureWorker();
    } catch (e) {
      this._unavailable = true;
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    const id = this.nextId++;
    const { fetchSeries, ...opts } = input.opts ?? {};
    return new Promise<RunResult>((resolve, reject) => {
      this.pending = { id, resolve, reject, fetchSeries };
      try {
        w.postMessage({
          t: 'run', id,
          source: input.source, bars: input.bars,
          opts: { ...opts, hasFetch: !!fetchSeries },
        } satisfies ToWorker);
      } catch (e) {
        // Sync postMessage throw (e.g. uncloneable inputValues) must not
        // strand pending — every later run would reject 'run in flight'.
        this.pending = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  dispose(): void {
    this.pending?.reject(new Error('disposed'));
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
