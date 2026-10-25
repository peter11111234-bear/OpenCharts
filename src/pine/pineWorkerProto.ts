// ── Pine worker protocol (B4) ────────────────────────────────────────────────
// Message types shared between pineWorkerClient (main thread) and pineWorker
// (worker entry). Pure types — zero runtime. One run in flight at a time; the
// client serializes via drain before sending the next `run`.
import type { BarData, PlotOpts, RunResult, Value } from './contracts';
import type { ParsedInput } from './interpreter';

/** Options carried by `run` — mirrors RunOptions minus non-cloneable fields
 *  (fetchSeries becomes the fetchReq/fetchRes RPC; shouldAbort → abort msg). */
export interface WorkerOpts {
  symbol?: string;
  timeframe?: string;
  inputValues?: Record<string, unknown>;
  syminfo?: Record<string, Value>;
  hasFetch: boolean;
  /** Incremental-session key — same key reuses the worker's cached live
   *  session (committed-bar checkpoint + forming-bar rollback) instead of a
   *  full re-run. Content-derived (modelId|sym|tf|inputs|syminfo): a source
   *  or input edit lands on a different key and gets a fresh session. */
  incKey?: string;
}

/** Tail patch for the worker's copy of an incKey's tape: "your tape for this
 *  key should be `base` long; keep the first `from` bars, then these". The
 *  worker rebuilds the tape from its own copy, so a per-tick run clones a
 *  couple of bars instead of the whole history. `0 <= from <= base`. */
export interface TapePatch {
  base: number;
  from: number;
  tail: BarData[];
}

// ToWorker
// `astId` names the parsed AST by object identity. The client omits `parsed`
// once the target worker holds that AST (see workerAsts in pineWorkerClient);
// a worker that evicted it answers `fail` with name 'PineAstMiss' and the
// client resends the AST once on the same run id.
// Same idea for bars: `bars` = the whole tape (backward compatible), `tape` =
// a patch against the worker's copy for `opts.incKey`. A worker with no (or a
// mismatched) copy answers `fail` with name 'PineTapeMiss' and the client
// resends the full `bars` once on the same run id.
export type ToWorker =
  | { t: 'run'; id: number; source?: string; parsed?: ParsedInput; astId?: string; bars?: BarData[]; tape?: TapePatch; opts: WorkerOpts }
  | { t: 'fetchRes'; fid: number; ok: boolean; bars?: BarData[]; error?: string };

// FromWorker
export interface FailError {
  name: string;
  message: string;
  stack?: string;
  line?: number;
  col?: number;
}

/** Incremental plot delta: `from` = index the client truncates to before
 *  pushing `tail` — covers growth, rollback shrink, and tail re-writes with
 *  one shape. `drop` = keys absent from this run's plots (their entries are
 *  deleted client-side). */
export interface PlotDelta {
  key: string;
  from: number;
  tail?: { index: number; time: number[]; values: Value[]; colors: (string | undefined)[]; opts: PlotOpts };
  drop?: true;
}

export type FromWorker =
  | { t: 'fetchReq'; fid: number; sym: string; tf: string }
  | { t: 'done'; id: number; result: RunResult; incAlive?: boolean;
      /** Present on incremental reuses — result.plots is EMPTY and these
       *  deltas patch the client's retained plot map instead. */
      plotDelta?: PlotDelta[] }
  | { t: 'fail'; id: number; error: FailError };
