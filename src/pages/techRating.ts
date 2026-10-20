/**
 * Technical rating for the Vela side panel, runs src/pine/tech-rating.pine
 * (TradingView "Technical Ratings" rules) on shioaji bars. Pure logic, no DOM:
 * the panel (techRatingPanel.ts) and its Vela registration (velaTechRating.ts)
 * build on this.
 */
import type { OHLCV } from "@luxalgo/vela";
import type { BarData, RunResult } from "../pine/contracts.ts";
import { parse } from "../pine/parser.ts";
import { runScript } from "../pine/interpreter.ts";
import { PineRunClient } from "../pine/pineWorkerClient.ts";
import { loadPineManifest } from "../pineScripts.ts";
import "../pine/builtins/index.ts";

export const TECH_RATING_SCRIPT_NAME = "tech-rating";
export const RATING_BAR_LIMIT = 300;
/** Below this many bars SMA/EMA 200 are still warming up and sit out the vote. */
export const RATING_FULL_BARS = 200;

export type RatingKey = "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";

export const RATING_LABELS: Record<RatingKey, string> = {
  strong_buy: "強力買入",
  buy: "買入",
  neutral: "中立",
  sell: "賣出",
  strong_sell: "強力賣出",
};

export interface RatingSnapshot {
  all: number | null;
  ma: number | null;
  osc: number | null;
  bars: number;
}

export type RunFn = (source: string, bars: BarData[]) => Promise<RunResult>;
export type FetchBarsFn = (symbol: string, timeframe: string, fromMs: number, limit: number) => Promise<OHLCV[]>;

/** TradingView's bands: (0.5, 1] strong buy, (0.1, 0.5] buy, [-0.1, 0.1] neutral,
 *  [-0.5, -0.1) sell, [-1, -0.5) strong sell. */
export function ratingKey(v: number | null): RatingKey | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (v > 0.5) return "strong_buy";
  if (v > 0.1) return "buy";
  if (v >= -0.1) return "neutral";
  if (v >= -0.5) return "sell";
  return "strong_sell";
}

export function techRatingSource(): string {
  const entry = loadPineManifest().find((m) => m.name === TECH_RATING_SCRIPT_NAME);
  if (!entry) throw new Error(`src/pine/${TECH_RATING_SCRIPT_NAME}.pine missing`);
  return entry.script;
}

/** How far back to ask for RATING_BAR_LIMIT bars: calendar time spans
 *  non-trading hours, so intraday gets 8× and daily/weekly 1.6× headroom. */
export function lookbackMs(timeframe: string): number {
  const minutes = timeframe === "D" ? 1440 : timeframe === "W" ? 10080 : Number(timeframe) || 1;
  const headroom = minutes >= 1440 ? 1.6 : 8;
  return minutes * 60_000 * RATING_BAR_LIMIT * headroom;
}

function lastNum(r: RunResult, title: string): number | null {
  const plot = r.plots.get(title);
  const v = plot?.values[plot.values.length - 1];
  if (!v || (v.kind !== "float" && v.kind !== "int")) return null;
  return Number.isFinite(v.v) ? v.v : null;
}

export function readRating(r: RunResult, bars: number): RatingSnapshot {
  return { all: lastNum(r, "All"), ma: lastNum(r, "MA"), osc: lastNum(r, "Osc"), bars };
}

const toBarData = (b: OHLCV): BarData => ({
  openTime: b.time,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  volume: b.volume ?? 0,
});

let workerClient: PineRunClient | null = null;

/** Off the main thread when Workers exist (one 300-bar run is ~0.6s);
 *  in-process otherwise (tests, or a worker that died). */
export const defaultRun: RunFn = async (source, bars) => {
  workerClient ??= new PineRunClient();
  if (!workerClient.unavailable) {
    try {
      return await workerClient.run({ source, bars });
    } catch {
      // fall through to in-process
    }
  }
  return runScript(parse(source), bars);
};

export async function computeRating(
  symbol: string,
  timeframe: string,
  deps: { fetchBars: FetchBarsFn; run?: RunFn; now?: () => number },
): Promise<RatingSnapshot> {
  const now = deps.now?.() ?? Date.now();
  const ohlcv = await deps.fetchBars(symbol, timeframe, now - lookbackMs(timeframe), RATING_BAR_LIMIT);
  const bars = ohlcv.map(toBarData);
  if (bars.length === 0) return { all: null, ma: null, osc: null, bars: 0 };
  const result = await (deps.run ?? defaultRun)(techRatingSource(), bars);
  return readRating(result, bars.length);
}
