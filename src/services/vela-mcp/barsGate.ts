/**
 * Every Shioaji history read an MCP tool makes goes through one gate: calls run
 * one at a time, a symbol+timeframe is reused for ttlMs, and two upstream
 * fetches are at least minGapMs apart. External agents loop on tools, and a
 * burst of kbars queries drops the Shioaji session (the watchdog cannot bring
 * it back) and eats the 500 MB daily quota. Failed fetches are not cached.
 */
import type { OHLCV } from "@luxalgo/vela";

export interface BarsGateOptions {
  ttlMs: number;
  minGapMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type FetchBars = (symbol: string, timeframe: string) => Promise<OHLCV[]>;

export function createBarsGate(fetchBars: FetchBars, opts: BarsGateOptions): FetchBars {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cache = new Map<string, { at: number; bars: OHLCV[] }>();
  let chain: Promise<unknown> = Promise.resolve();
  let lastFetch = Number.NEGATIVE_INFINITY;

  return (symbol, timeframe) => {
    const key = `${symbol}|${timeframe}`;
    const run = chain.then(async () => {
      const hit = cache.get(key);
      if (hit && now() - hit.at < opts.ttlMs) return hit.bars;
      const wait = lastFetch + opts.minGapMs - now();
      if (wait > 0) await sleep(wait);
      lastFetch = now();
      const bars = await fetchBars(symbol, timeframe);
      cache.set(key, { at: now(), bars });
      return bars;
    });
    chain = run.catch(() => undefined);
    return run;
  };
}
