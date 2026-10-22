import { beforeEach, describe, expect, it, vi } from "vitest";

const getKbars = vi.fn();
vi.mock("../shioaji/server.ts", () => ({ getKbars: (...a: unknown[]) => getKbars(...a) }));

const { getShioajiHistory } = await import("../shioaji/candles.ts");

const empty = { ts: [], datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [] };

describe("getShioajiHistory contract fallback", () => {
  beforeEach(() => getKbars.mockReset().mockResolvedValue(empty));

  it("fetches a stock that is not in TW_INSTRUMENTS (heatmap / hotlist pick)", async () => {
    await getShioajiHistory("3081", "5");
    expect(getKbars.mock.calls[0]![0]).toEqual({ security_type: "STK", exchange: "TSE", code: "3081" });
  });

  it("still uses the listed contract for known instruments", async () => {
    await getShioajiHistory("TMFR1", "5", undefined, { fromMs: 1, toMs: 2 * 86_400_000 });
    expect(getKbars.mock.calls[0]![0]).toEqual({ security_type: "FUT", exchange: "TAIFEX", code: "TMFR1" });
  });

  it("returns nothing (no request) for an unparseable symbol", async () => {
    expect(await getShioajiHistory("not a code", "5")).toEqual([]);
    expect(getKbars).not.toHaveBeenCalled();
  });
});
