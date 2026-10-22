import { describe, expect, it } from "vitest";
import { frontMonthCode, LIVE_INSTRUMENTS, TW_INSTRUMENTS } from "../shioaji/instruments.ts";

const taipei = (iso: string) => new Date(`${iso}+08:00`);

describe("frontMonthCode", () => {
  it("keeps the expiring month through the expiry-day session (3rd Wed 2026-10-21)", () => {
    expect(frontMonthCode("TMF", taipei("2026-10-21T13:44:59"))).toBe("TMFJ6");
  });

  it("rolls at 13:45 on expiry day: the 15:00 night session trades next month", () => {
    expect(frontMonthCode("TMF", taipei("2026-10-21T13:45:00"))).toBe("TMFK6");
    expect(frontMonthCode("MXF", taipei("2026-10-21T15:00:00"))).toBe("MXFK6");
    expect(frontMonthCode("MXF", taipei("2026-10-22T09:00:00"))).toBe("MXFK6");
  });

  it("before the 3rd Wednesday it is still this month; December rolls into next year", () => {
    expect(frontMonthCode("TMF", taipei("2026-10-01T09:00:00"))).toBe("TMFJ6");
    // 2026-12 3rd Wednesday = 16th
    expect(frontMonthCode("TMF", taipei("2026-12-16T14:00:00"))).toBe("TMFA7");
  });

  it("uses Taipei time, not UTC (00:30 Taipei on the 1st is still that day)", () => {
    expect(frontMonthCode("TMF", new Date("2026-10-31T16:30:00Z"))).toBe("TMFK6"); // 11-01 00:30 Taipei
  });
});

describe("instrument lists", () => {
  it("live = 2330 + 微台 + 小台 front months; continuous months are history-only", () => {
    expect(LIVE_INSTRUMENTS.map((i) => i.contract.code)).toEqual(["2330", frontMonthCode("TMF"), frontMonthCode("MXF")]);
    expect(TW_INSTRUMENTS.map((i) => i.contract.code).slice(3)).toEqual(["TMFR1", "MXFR1"]);
    expect(TW_INSTRUMENTS.find((i) => i.contract.code === "TMFR1")!.symbol.displayName).toBe("微台 連續近月");
    expect(TW_INSTRUMENTS.find((i) => i.contract.code === frontMonthCode("TMF"))!.symbol.contractSize).toBe(10);
  });
});
