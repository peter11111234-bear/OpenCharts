import type { SecurityType } from "./server.ts";

const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;

/**
 * Is `security_type` quoting at `nowMs`? Weekday + wall-clock only (holidays are not
 * known here: on a holiday the feed watchdog just resubscribes as it did before).
 *
 * - STK: Mon–Fri 09:00–13:30.
 * - FUT: Mon–Fri 08:45–13:45 (day) and 15:00 → next day 05:00 (night; Friday's night
 *   session runs into Saturday 05:00).
 *
 * Used by feed.ts so a silent stream outside these windows is not mistaken for a dead one
 * (2026-10-22: after the close the watchdog re-POSTed subscribe every 10s).
 */
export function isQuotingNow(securityType: SecurityType, nowMs: number): boolean {
  const t = new Date(nowMs + TAIPEI_OFFSET_MS);
  const dow = t.getUTCDay(); // 0=Sun..6=Sat, Taipei wall clock
  const min = t.getUTCHours() * 60 + t.getUTCMinutes();
  const weekday = dow >= 1 && dow <= 5;
  if (securityType === "FUT") {
    if (weekday && ((min >= 8 * 60 + 45 && min < 13 * 60 + 45) || min >= 15 * 60)) return true;
    return dow >= 2 && dow <= 6 && min < 5 * 60; // night session's after-midnight part
  }
  return weekday && min >= 9 * 60 && min < 13 * 60 + 30;
}
