import { describe, expect, it } from "vitest";
import { autoRefreshAllowed, barRefreshKey } from "../fetchPolicy.ts";

// Taipei wall clock → epoch ms (Taipei = UTC+8). 2026-10-22 is a Thursday.
const tpe = (iso: string) => Date.parse(`${iso}+08:00`);

describe("autoRefreshAllowed (user rule 2026-10-22)", () => {
  it("stock session: stocks, TAIEX and micro TAIEX refresh; other futures do not", () => {
    const t = tpe("2026-10-22T10:00:00");
    expect(autoRefreshAllowed("TSE:2330", t)).toBe(true);
    expect(autoRefreshAllowed("OTC:6547", t)).toBe(true);
    expect(autoRefreshAllowed("IX0001", t)).toBe(true);
    expect(autoRefreshAllowed("TAIFEX:TMFK6", t)).toBe(true);
    expect(autoRefreshAllowed("TMFR1", t)).toBe(true);
    expect(autoRefreshAllowed("TAIFEX:MXFK6", t)).toBe(false);
    expect(autoRefreshAllowed("TXFR1", t)).toBe(false);
  });

  it("after the stock close and at night only micro TAIEX refreshes", () => {
    for (const iso of ["2026-10-22T14:00:00", "2026-10-22T21:00:00", "2026-10-23T02:00:00"]) {
      const t = tpe(iso);
      expect(autoRefreshAllowed("TAIFEX:TMFK6", t), iso).toBe(iso !== "2026-10-22T14:00:00"); // 13:45–15:00 futures break
      expect(autoRefreshAllowed("TSE:2330", t), iso).toBe(false);
      expect(autoRefreshAllowed("IX0001", t), iso).toBe(false);
      expect(autoRefreshAllowed("MXFR1", t), iso).toBe(false);
    }
  });

  it("weekend: nothing refreshes", () => {
    const t = tpe("2026-10-24T10:00:00");
    expect(autoRefreshAllowed("TMFR1", t)).toBe(false);
    expect(autoRefreshAllowed("TSE:2330", t)).toBe(false);
  });
});

describe("barRefreshKey", () => {
  it("changes once per completed bar of the chart timeframe, after a grace", () => {
    const k = (iso: string) => barRefreshKey("5", tpe(iso));
    expect(k("2026-10-22T10:00:05")).toBe(k("2026-10-22T09:59:30")); // grace: the 09:55 bar's last 1m may not have landed
    expect(k("2026-10-22T10:04:59")).toBe(k("2026-10-22T10:00:11"));
    expect(k("2026-10-22T10:00:11")).not.toBe(k("2026-10-22T10:00:05"));
  });

  it("1m chart refreshes every minute, 60m chart every hour", () => {
    expect(barRefreshKey("1", tpe("2026-10-22T10:01:11"))).not.toBe(barRefreshKey("1", tpe("2026-10-22T10:00:59")));
    expect(barRefreshKey("60", tpe("2026-10-22T10:30:00"))).toBe(barRefreshKey("60", tpe("2026-10-22T10:59:00")));
  });
});
