import { describe, expect, it } from "vitest";
import { isQuotingNow } from "./tradingSession.ts";

/** Taipei wall clock → epoch ms. 2026-10-21 is a Wednesday. */
const tw = (d: string, hhmm: string) => Date.parse(`${d}T${hhmm}:00+08:00`);

describe("isQuotingNow", () => {
  it("stocks: 09:00 ≤ t < 13:30 on weekdays", () => {
    expect(isQuotingNow("STK", tw("2026-10-21", "10:00"))).toBe(true);
    expect(isQuotingNow("STK", tw("2026-10-21", "13:29"))).toBe(true);
    expect(isQuotingNow("STK", tw("2026-10-21", "13:30"))).toBe(false);
    expect(isQuotingNow("STK", tw("2026-10-21", "08:59"))).toBe(false);
    expect(isQuotingNow("STK", tw("2026-10-21", "20:00"))).toBe(false);
  });
  it("stocks: never on weekends", () => {
    expect(isQuotingNow("STK", tw("2026-10-24", "10:00"))).toBe(false);
    expect(isQuotingNow("STK", tw("2026-10-25", "10:00"))).toBe(false);
  });
  it("futures: day session 08:45–13:45, gap until the 15:00 night open", () => {
    expect(isQuotingNow("FUT", tw("2026-10-21", "08:45"))).toBe(true);
    expect(isQuotingNow("FUT", tw("2026-10-21", "13:44"))).toBe(true);
    expect(isQuotingNow("FUT", tw("2026-10-21", "13:45"))).toBe(false);
    expect(isQuotingNow("FUT", tw("2026-10-21", "14:30"))).toBe(false);
    expect(isQuotingNow("FUT", tw("2026-10-21", "15:00"))).toBe(true);
  });
  it("futures: night session runs past midnight to 05:00", () => {
    expect(isQuotingNow("FUT", tw("2026-10-22", "04:59"))).toBe(true);
    expect(isQuotingNow("FUT", tw("2026-10-22", "05:00"))).toBe(false);
    expect(isQuotingNow("FUT", tw("2026-10-22", "07:00"))).toBe(false);
  });
  it("futures: Friday night runs into Saturday 05:00, but not Sat–Mon otherwise", () => {
    expect(isQuotingNow("FUT", tw("2026-10-24", "04:00"))).toBe(true);
    expect(isQuotingNow("FUT", tw("2026-10-24", "06:00"))).toBe(false);
    expect(isQuotingNow("FUT", tw("2026-10-24", "16:00"))).toBe(false);
    expect(isQuotingNow("FUT", tw("2026-10-25", "03:00"))).toBe(false);
    expect(isQuotingNow("FUT", tw("2026-10-26", "03:00"))).toBe(false);
  });
});
