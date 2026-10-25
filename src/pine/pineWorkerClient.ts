// Main-thread side of the pine worker RPC. Lazy-spawns a module Worker,
// serializes one run at a time, and proxies fetchSeries back to the caller.
import type { BarData, RunResult } from './contracts';
import type { ParsedInput, RunOptions } from './interpreter';
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

export interface ClientRunOpts extends Omit<RunOptions, 'fetchSeries' | 'shouldAbort' | 'incSession'> {
  fetchSeries?: FetchSeriesFn;
}

interface PendingRun {
  id: number;
  resolve: (r: RunResult) => void;
  reject: (e: Error) => void;
  fetchSeries?: FetchSeriesFn;
  /** Deadline handle — cleared by EVERY settle point (see clearTimer), so a
   *  finished run can't be rejected/terminated by its own stale timer. */
  timer?: ReturnType<typeof setTimeout>;
  /** Deadline budget left, in ms. Held across pauses so a run that spends
   *  minutes waiting on `fetchSeries` neither loses nor resets its clock. */
  remaining: number;
  /** Wall-clock start of the current (unpaused) timing stretch. */
  startedAt: number;
  /** In-flight fetches on this thread; >0 pauses the run deadline. */
  fetchDepth: number;
  /** One ceiling per in-flight fetch (`timeoutMs` each) — the run deadline is
   *  paused, so a provider that never answers would otherwise stall forever. */
  fetchTimers: Set<ReturnType<typeof setTimeout>>;
  /** Wall-clock ceiling for the whole run — unlike `timer` it does NOT pause
   *  while a provider call is served, so a script that fans out unbounded
   *  `request.security` calls (each one cheap) still dies. */
  totalTimer?: ReturnType<typeof setTimeout>;
  /** AST this run referenced by id; kept so a PineAstMiss can resend it. */
  astId?: string;
  /** The parsed body was NOT in the run message (worker claimed to have it). */
  astOmitted: boolean;
  /** The single PineAstMiss resend already happened — never retry twice. */
  astResent: boolean;
  parsed?: ParsedInput;
  /** Message as sent (parsed stripped when the worker already had the AST). */
  runMsg?: RunMsg;
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object';

/** The `run` arm of the worker protocol — the client keeps the message it sent
 *  so a PineAstMiss can resend the AST body on the same run id. */
type RunMsg = Extract<ToWorker, { t: 'run' }>;

/** A run that blew a deadline (per-run, per-fetch, or the whole-run ceiling).
 *  Typed so the engine can tell "this script is wedged" from "this script
 *  threw" — only the former suspends the session. Message keeps the
 *  `Pine script run timed out after Ns` shape callers/tests match on. */
export class PineRunTimeoutError extends Error {
  constructor(secs: number, reason?: string) {
    super(reason
      ? `Pine script run timed out after ${secs}s ${reason}`
      : `Pine script run timed out after ${secs}s`);
    this.name = 'PineRunTimeoutError';
  }
}

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

/** AST identity table: a prepared script's `parsed` object gets one stable id
 *  for its lifetime, so a client can tell the worker "you already have this
 *  AST" instead of paying structured-clone (~19–27ms for TRIS390) on every
 *  live tick. Weak: an edited script re-parses to a NEW object → new id.
 *  Module-level (not per-client) because the pool hands workers between
 *  clients. */
const astIds = new WeakMap<object, string>();
let astSeq = 0;
function astIdFor(parsed: object): string {
  let id = astIds.get(parsed);
  if (id === undefined) {
    id = String(++astSeq);
    astIds.set(parsed, id);
  }
  return id;
}

/** Per-worker record of the AST ids whose FULL body that worker has received —
 *  the only ids it may be sent by reference. Also module-level: a worker is
 *  shared across clients through the pool. A fresh worker has no entry, so its
 *  first run always carries `parsed`. */
const workerAsts = new WeakMap<WorkerLike, Set<string>>();
/** Record that `w` now holds AST `id` in full — only called after a successful
 *  post that actually carried the body (or one the worker will cache). */
function rememberAst(w: WorkerLike, id: string): void {
  let known = workerAsts.get(w);
  if (known === undefined) { known = new Set(); workerAsts.set(w, known); }
  known.add(id);
}

export class PineRunClient {
  private worker: WorkerLike | null = null;
  private pending: PendingRun | null = null;
  private nextId = 1;
  /** Set when the platform has no Worker or the worker dies on transport —
   *  callers fall back to in-process. Read-only for external consumers. */
  private _unavailable: boolean;
  /** True after the last completed run left a resumable incremental session
   *  on this client's worker — the engine reads it to keep per-tick
   *  updates enabled for heavy scripts. */
  incAlive = false;
  /** Retained plot map for incremental sessions — the worker ships
   *  `plotDelta` (tail-only) instead of recloning ~5000 values per tick, so
   *  the client keeps the full arrays and applies the patch. Reused arrays
   *  are engine-private; the model builder maps them into new series each
   *  tick, so in-place truncation+append is safe. */
  private lastPlots: RunResult['plots'] | null = null;

  get unavailable(): boolean { return this._unavailable; }
  private readonly factory?: () => WorkerLike;
  /** Deadline for one run. A wedged worker (infinite loop, OOM thrash, a
   *  dropped reply) never settles `pending`, which leaves the editor stuck on
   *  "Running…" with the run slot locked. */
  private readonly timeoutMs: number;
  /** Whole-run wall-clock ceiling, provider waits included. The paused
   *  per-run clock alone cannot bound a script whose cost is spread over many
   *  cheap provider calls; this one can. */
  private readonly totalTimeoutMs: number;

  constructor(opts?: { factory?: () => WorkerLike; timeoutMs?: number; totalTimeoutMs?: number }) {
    this.factory = opts?.factory;
    // 60s: past this a run is wedged, not slow. Long Shioaji fetches are
    // exempt — the clock pauses while a fetchReq is being served (below).
    this.timeoutMs = opts?.timeoutMs ?? 60_000;
    // 300s: the outer bound. Wall clock, never paused — a fetch storm is still
    // one run and still costs the user a stuck chart.
    this.totalTimeoutMs = opts?.totalTimeoutMs ?? 300_000;
    this._unavailable = typeof Worker === 'undefined' && !opts?.factory;
  }

  /** Cancel a run's deadlines (run + every in-flight fetch cap). Called from
   *  every settle path (done/fail, transport error, sync postMessage throw,
   *  dispose, timeout) — a surviving timer would reject an already-settled run
   *  and terminate a live worker. */
  private clearTimer(p: PendingRun | null): void {
    if (!p) return;
    if (p.timer !== undefined) { clearTimeout(p.timer); p.timer = undefined; }
    if (p.totalTimer !== undefined) { clearTimeout(p.totalTimer); p.totalTimer = undefined; }
    for (const t of p.fetchTimers) clearTimeout(t);
    p.fetchTimers.clear();
  }

  /** A provider call started: bank the elapsed deadline budget and stop the
   *  run clock. Provider latency is not the script's latency. */
  private pauseTimer(p: PendingRun): void {
    if (p.timer === undefined) return;
    clearTimeout(p.timer);
    p.timer = undefined;
    p.remaining = Math.max(0, p.remaining - (Date.now() - p.startedAt));
  }

  /** Last provider call settled: resume the run clock with the time that was
   *  left, NOT a fresh `timeoutMs`. */
  private resumeTimer(p: PendingRun): void {
    if (this.pending !== p || p.timer !== undefined) return;
    p.startedAt = Date.now();
    p.timer = setTimeout(() => this.onDeadline(p), Math.max(0, p.remaining));
  }

  private onDeadline(p: PendingRun): void {
    // A stale timer (clearTimeout missed somewhere) must never settle the run
    // that currently owns the slot.
    if (this.pending?.id !== p.id) return;
    this.pending = null;
    p.timer = undefined;
    this.clearTimer(p);
    // The worker never answered: it is wedged, not slow. Kill it so the next
    // run spawns a clean one; its incremental session dies with it.
    const stuck = this.worker;
    this.worker = null;
    this.incAlive = false;
    p.reject(new PineRunTimeoutError(this.timeoutMs / 1000));
    stuck?.terminate();
  }

  private onFetchDeadline(p: PendingRun): void {
    if (this.pending?.id !== p.id) return;
    this.pending = null;
    this.clearTimer(p);
    const stuck = this.worker;
    this.worker = null;
    this.incAlive = false;
    p.reject(new PineRunTimeoutError(this.timeoutMs / 1000, 'waiting for series data'));
    stuck?.terminate();
  }

  /** The whole run blew its wall-clock ceiling — same settle shape as the
   *  per-run deadline, but the message names the total limit so a caller can
   *  tell a provider storm from a wedged script. */
  private onTotalDeadline(p: PendingRun): void {
    if (this.pending?.id !== p.id) return;
    this.pending = null;
    this.clearTimer(p);
    const stuck = this.worker;
    this.worker = null;
    this.incAlive = false;
    p.reject(new PineRunTimeoutError(this.totalTimeoutMs / 1000, '(total run-time limit)'));
    stuck?.terminate();
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
    const p = this.pending;
    this.pending = null;
    this.clearTimer(p);
    p?.reject(err);
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
        if (msg.t === 'fail' && msg.error.name === 'PineAstMiss' && p.astOmitted
          && !p.astResent && p.astId !== undefined && p.runMsg !== undefined) {
          // The worker evicted an AST we sent by reference. It says so instead
          // of silently re-parsing — withdraw the id from its record and
          // resend the body ONCE on the same run id: same pending, same
          // deadlines (no provider time is spent), same worker. A second
          // miss is a genuine failure and falls through below.
          p.astResent = true;
          p.astOmitted = false;
          const w = this.worker;
          if (w) {
            workerAsts.get(w)?.delete(p.astId);
            p.runMsg = { ...p.runMsg, parsed: p.parsed };
            try {
              w.postMessage(p.runMsg);
              rememberAst(w, p.astId);
              return;
            } catch {
              // Post failed on the resend — settle as a normal failure.
            }
          }
        }
        this.pending = null;
        this.clearTimer(p);
        // A done that kept a resumable session must NOT release its worker
        // to the pool — pooling hands the worker to the next session with a
        // different incKey, and this session's next tick would land on a
        // fresh incSessions map (the whole point of the live session).
        const keepWorker = msg.t === 'done' && msg.incAlive === true;
        if (!this.factory && !keepWorker) {
          const w = this.worker;
          this.worker = null;
          if (w) releaseWorker(w);
        }
        if (msg.t === 'done') {
          this.incAlive = msg.incAlive === true;
          if (msg.plotDelta !== undefined) {
            // Incremental reuse — patch the retained plot map in place.
            const plots = this.lastPlots ?? new Map();
            for (const d of msg.plotDelta) {
              if (d.drop) { plots.delete(d.key); continue; }
              const t = d.tail!;
              const cur = plots.get(d.key);
              if (!cur || d.from === 0) {
                plots.set(d.key, { index: t.index, time: t.time.slice(), values: t.values.slice(), opts: t.opts, colors: t.colors.slice() });
                continue;
              }
              cur.time.length = d.from;
              cur.values.length = d.from;
              cur.colors.length = d.from;
              cur.time.push(...t.time);
              cur.values.push(...t.values);
              cur.colors.push(...t.colors);
              cur.opts = t.opts;
            }
            this.lastPlots = plots;
            p.resolve({ ...msg.result, plots });
          } else {
            // Full emit — retain as the new baseline for future deltas.
            this.lastPlots = msg.result.plots;
            p.resolve(msg.result);
          }
        }
        else p.reject(reviveError(msg.error));
        return;
      }
      if (msg.t === 'fetchReq') {
        const fid = msg.fid;
        // Capture the worker that issued the request — a fetch resolving
        // after dispose/respawn must not post into a NEW worker, where a
        // colliding fid would silently feed it stale bars.
        const w = this.worker;
        const p = this.pending;
        const fetch = p?.fetchSeries;
        // Malformed payloads answer ok:false (when a fid exists) instead of
        // being dropped — a dropped reply leaves the worker's pending Map
        // entry leaked until the run settles.
        if (!fetch || !w || !p || typeof fid !== 'number' || typeof msg.sym !== 'string' || typeof msg.tf !== 'string') {
          if (w && typeof fid === 'number') w.postMessage({ t: 'fetchRes', fid, ok: false, error: 'malformed or unpending fetchReq' } satisfies ToWorker);
          return;
        }
        // Provider latency is not the script's latency: pause the run clock
        // while a fetch is served (resumed with the remaining budget), and cap
        // each fetch so a silent provider cannot stall the run forever.
        p.fetchDepth++;
        if (p.fetchDepth === 1) this.pauseTimer(p);
        const cap = setTimeout(() => this.onFetchDeadline(p), this.timeoutMs);
        p.fetchTimers.add(cap);
        const settleFetch = () => {
          clearTimeout(cap);
          p.fetchTimers.delete(cap);
          p.fetchDepth--;
          if (p.fetchDepth === 0) this.resumeTimer(p);
        };
        fetch(msg.sym, msg.tf).then(
          (bars) => {
            settleFetch();
            w.postMessage({ t: 'fetchRes', fid, ok: true, bars } satisfies ToWorker);
          },
          (e) => {
            settleFetch();
            w.postMessage({ t: 'fetchRes', fid, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies ToWorker);
          },
        );
      }
    } catch (e) {
      // Defensive settle: a post-snapshot throw would otherwise strand the
      // run promise forever (an exception inside worker.onmessage is
      // uncaught — it does NOT surface as worker.onerror).
      const p = this.pending;
      this.pending = null;
      this.clearTimer(p);
      p?.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  run(input: { source?: string; parsed?: ParsedInput; bars: BarData[]; opts?: ClientRunOpts }): Promise<RunResult> {
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
    const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
    // AST already on this worker → send the id alone and skip the structured
    // clone (19–27ms for TRIS390 at 500 bars, paid per tick otherwise).
    const astId = input.parsed !== undefined ? astIdFor(input.parsed) : undefined;
    const omitAst = astId !== undefined && workerAsts.get(w)?.has(astId) === true;
    const pending: PendingRun = {
      id, resolve, reject, fetchSeries,
      remaining: this.timeoutMs, startedAt: Date.now(), fetchDepth: 0, fetchTimers: new Set(),
      astId, astOmitted: omitAst, astResent: false, parsed: input.parsed,
    };
    this.pending = pending;
    pending.timer = setTimeout(() => this.onDeadline(pending), this.timeoutMs);
    pending.totalTimer = setTimeout(() => this.onTotalDeadline(pending), this.totalTimeoutMs);
    const runMsg: RunMsg = {
      t: 'run', id,
      source: input.source,
      parsed: omitAst ? undefined : input.parsed,
      astId,
      bars: input.bars,
      opts: { ...opts, hasFetch: !!fetchSeries },
    };
    pending.runMsg = runMsg;
    try {
      w.postMessage(runMsg);
      // Only after a successful post does the worker own the body.
      if (!omitAst && astId !== undefined) rememberAst(w, astId);
    } catch (e) {
      // Sync postMessage throw (e.g. uncloneable inputValues) must not
      // strand pending — every later run would reject 'run in flight'.
      this.pending = null;
      this.clearTimer(pending);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
    return promise;
  }

  dispose(): void {
    this.incAlive = false;
    const p = this.pending;
    this.pending = null;
    this.clearTimer(p);
    p?.reject(new Error('disposed'));
    this.worker?.terminate();
    this.worker = null;
  }
}
