// ── Pine worker protocol (B4) ────────────────────────────────────────────────
// Message types shared between pineWorkerClient (main thread) and pineWorker
// (worker entry). Pure types — zero runtime. One run in flight at a time; the
// client serializes via drain before sending the next `run`.
import type { BarData, RunResult, Value } from './contracts';

/** Options carried by `run` — mirrors RunOptions minus non-cloneable fields
 *  (fetchSeries becomes the fetchReq/fetchRes RPC; shouldAbort → abort msg). */
export interface WorkerOpts {
  symbol?: string;
  timeframe?: string;
  inputValues?: Record<string, unknown>;
  syminfo?: Record<string, Value>;
  hasFetch: boolean;
}

// ToWorker
export type ToWorker =
  | { t: 'run'; id: number; source: string; bars: BarData[]; opts: WorkerOpts }
  | { t: 'fetchRes'; fid: number; ok: boolean; bars?: BarData[]; error?: string };

// FromWorker
export interface FailError {
  name: string;
  message: string;
  stack?: string;
  line?: number;
  col?: number;
}

export type FromWorker =
  | { t: 'fetchReq'; fid: number; sym: string; tf: string }
  | { t: 'done'; id: number; result: RunResult }    // sanitized via sanitizeRunResult
  | { t: 'fail'; id: number; error: FailError };
