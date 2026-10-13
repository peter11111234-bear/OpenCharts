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

// ToWorker
export type ToWorker =
  | { t: 'run'; id: number; source?: string; parsed?: ParsedInput; bars: BarData[]; opts: WorkerOpts }
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
