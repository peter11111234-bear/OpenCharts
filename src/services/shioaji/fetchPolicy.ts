/**
 * When periodic Shioaji refetches are worth the daily quota (user rule, 2026-10-22):
 * - stock session (weekdays 09:00–13:30): stocks, the TAIEX index and micro TAIEX (TMF);
 * - after the stock close and in the futures night session: micro TAIEX only.
 * Other futures (MXF/TXF) never auto-refresh. A symbol switch still loads once —
 * this only gates the timers that refetch the same market again and again.
 */
import { bucketStart } from "./candles.ts";
import { toContractRef } from "./marketData.ts";
import { isQuotingNow } from "./tradingSession.ts";
import { normalizeTimeframe } from "./velaProvider.ts";

export function autoRefreshAllowed(symbol: string, nowMs: number): boolean {
  const ref = toContractRef(symbol);
  if (!ref) return false;
  if (ref.security_type === "FUT") return ref.code.startsWith("TMF") && isQuotingNow("FUT", nowMs);
  return isQuotingNow("STK", nowMs); // stocks and the TAIEX index share the stock session
}

/** Wait this long past a bar boundary so the bar's last 1m kbar has landed on the server. */
const BAR_GRACE_S = 10;

/** Changes once per completed bar of `timeframe` — refetching more often only re-downloads the same bars. */
export function barRefreshKey(timeframe: string, nowMs: number): string {
  return String(bucketStart(normalizeTimeframe(timeframe), Math.floor(nowMs / 1000) - BAR_GRACE_S));
}
