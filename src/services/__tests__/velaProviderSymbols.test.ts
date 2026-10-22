import { afterEach, describe, expect, it, vi } from "vitest";
import { frontMonthCode } from "../shioaji/instruments.ts";
import { clearIndexEntriesCache } from "../shioaji/marketData.ts";
import { ShioajiVelaProvider } from "../shioaji/velaProvider.ts";

const entry = (code: string, exchange: string) => ({ contract: { exchange, code }, category: "24", price: "1", pct_chg: "0" });

afterEach(() => {
  vi.unstubAllGlobals();
  clearIndexEntriesCache();
});

describe("ShioajiVelaProvider.listSymbols", () => {
  it("indexes TAIEX and TPEx components with their listing prefix (so TSE:3037 / OTC:3081 resolve)", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const otc = JSON.parse(init.body).contract.exchange === "OTC";
      const entries = otc ? [entry("3081", "OTC")] : [entry("2330", "TSE"), entry("3037", "TSE")];
      return { ok: true, json: async () => ({ entries }) };
    });
    const list = await new ShioajiVelaProvider().listSymbols();
    expect(list.find((d) => d.ticker === "3037")).toMatchObject({ prefix: "TSE", type: "stock" });
    expect(list.find((d) => d.ticker === "3081")).toMatchObject({ prefix: "OTC", type: "stock" });
    expect(list.filter((d) => d.ticker === "2330")).toHaveLength(1); // hand-listed entry wins, no duplicate
    expect(list.find((d) => d.ticker === "2330")!.description).toBe("台積電");
  });

  it("falls back to the hand-listed instruments when the server is down", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 502 }));
    const list = await new ShioajiVelaProvider().listSymbols();
    expect(list.map((d) => d.ticker)).toEqual(["2330", frontMonthCode("TMF"), frontMonthCode("MXF"), "TMFR1", "MXFR1"]);
  });
});
