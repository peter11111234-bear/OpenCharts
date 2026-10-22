import { describe, expect, it } from "vitest";
import { kbarStartSec, taipeiToEpochSec } from "./candles.ts";

describe("kbarStartSec (kbars stamp the minute END → shift to START)", () => {
  it("shifts 09:01 → 09:00 for stocks", () => {
    expect(kbarStartSec("2026-10-21T09:01:00", "STK")).toBe(taipeiToEpochSec("2026-10-21T09:00:00"));
  });
  it("shifts 13:25 → 13:24 for stocks", () => {
    expect(kbarStartSec("2026-10-21T13:25:00", "STK")).toBe(taipeiToEpochSec("2026-10-21T13:24:00"));
  });
  it("keeps the 13:30 stock closing auction bar", () => {
    expect(kbarStartSec("2026-10-21T13:30:00", "STK")).toBe(taipeiToEpochSec("2026-10-21T13:30:00"));
  });
  it("shifts futures including 13:45 → 13:44", () => {
    expect(kbarStartSec("2026-10-21T13:45:00", "FUT")).toBe(taipeiToEpochSec("2026-10-21T13:44:00"));
  });
});
