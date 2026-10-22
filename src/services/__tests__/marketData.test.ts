import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearContractInfoCache,
  cleanName,
  fetchContractInfo,
  fetchIndexEntries,
  fetchQuotes,
  fetchRanking,
  fetchStockEntries,
  taipeiDate,
  toContractRef,
  type HttpFn,
} from "../shioaji/marketData.ts";

describe("fetchQuotes", () => {
  it("posts the refs and maps snake_case fields", async () => {
    const http = vi.fn<HttpFn>(async () => [
      { code: "TMFR1", exchange: "TAIFEX", open: 1, high: 3, low: 0.5, close: 2, change_price: -1, change_rate: -33.3, total_volume: 10, total_amount: 20, datetime: "2026-10-20T13:45:00" },
    ]);
    const refs = [{ security_type: "FUT" as const, exchange: "TAIFEX" as const, code: "TMFR1" }];
    const out = await fetchQuotes(refs, http);
    expect(http).toHaveBeenCalledWith("/data/snapshots", { method: "POST", body: { contracts: refs } });
    expect(out[0]).toMatchObject({ code: "TMFR1", close: 2, changePrice: -1, changeRate: -33.3, totalVolume: 10 });
  });

  it("skips the request for an empty list", async () => {
    const http = vi.fn<HttpFn>();
    expect(await fetchQuotes([], http)).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });
});

describe("fetchIndexEntries", () => {
  it("parses string prices and drops entries without a % change", async () => {
    const http = vi.fn<HttpFn>(async () => ({
      entries: [
        { contract: { exchange: "TSE", code: "2330" }, category: "24", price: "1005", pct_chg: "1.52", reference_weight_ppm: 300000, total_amount: 9 },
        { contract: { exchange: "TSE", code: "9999" }, category: "24", price: null, pct_chg: null, reference_weight_ppm: 5 },
      ],
    }));
    const out = await fetchIndexEntries(http);
    expect(out).toEqual([{ code: "2330", exchange: "TSE", category: "24", price: 1005, pct: 1.52, weightPpm: 300000, amount: 9 }]);
    expect(http.mock.calls[0]![1]).toEqual({
      method: "POST",
      body: { contract: { security_type: "IND", exchange: "TSE", code: "IX0001" } },
    });
  });

  it("asks for the TPEx index when exchange is OTC", async () => {
    const http = vi.fn<HttpFn>(async () => ({ entries: [] }));
    await fetchIndexEntries(http, "OTC");
    expect(http.mock.calls[0]![1]!.body).toEqual({ contract: { security_type: "IND", exchange: "OTC", code: "IX0043" } });
  });

  it("sends one request for concurrent callers and reuses it within the TTL", async () => {
    vi.useFakeTimers();
    try {
      const http = vi.fn<HttpFn>(async () => ({ entries: [] }));
      await Promise.all([fetchIndexEntries(http), fetchIndexEntries(http), fetchIndexEntries(http)]);
      expect(http).toHaveBeenCalledTimes(1);
      await fetchIndexEntries(http, "OTC");
      expect(http).toHaveBeenCalledTimes(2); // other index = separate request
      vi.advanceTimersByTime(19_000);
      await fetchIndexEntries(http);
      expect(http).toHaveBeenCalledTimes(2); // still fresh
      vi.advanceTimersByTime(2_000);
      await fetchIndexEntries(http);
      expect(http).toHaveBeenCalledTimes(3); // expired → refetch
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a failed request", async () => {
    const http = vi.fn<HttpFn>().mockRejectedValueOnce(new Error("down")).mockResolvedValue({ entries: [] });
    await expect(fetchIndexEntries(http)).rejects.toThrow("down");
    await fetchIndexEntries(http);
    expect(http).toHaveBeenCalledTimes(2);
  });
});

describe("fetchStockEntries", () => {
  it("snapshots only the given codes and maps them to heatmap entries", async () => {
    const http = vi.fn<HttpFn>(async () => [
      { code: "3081", exchange: "OTC", open: 1, high: 1, low: 1, close: 2375, change_price: -250, change_rate: -9.52, total_volume: 3325, total_amount: 8242155000 },
    ]);
    const out = await fetchStockEntries(["3081", "2330"], http);
    // The server resolves each code's real exchange, so refs all go out as TSE.
    expect(http).toHaveBeenCalledWith("/data/snapshots", {
      method: "POST",
      body: {
        contracts: [
          { security_type: "STK", exchange: "TSE", code: "3081" },
          { security_type: "STK", exchange: "TSE", code: "2330" },
        ],
      },
    });
    expect(out).toEqual([{ code: "3081", exchange: "OTC", category: "", price: 2375, pct: -9.52, weightPpm: 0, amount: 8242155000 }]);
  });
});

describe("fetchRanking", () => {
  const row = { date: "2026-10-16", code: "2330 ", name: "台積電", close: 110, change_price: 10, total_volume: 5, total_amount: 7 };

  it("walks back past empty (non-trading) days and computes % change", async () => {
    const http = vi.fn<HttpFn>(async (_p, init) => {
      const body = init!.body as { date: string };
      return body.date === "2026-10-16" ? [row] : [];
    });
    // 2026-10-18 (Sun) 12:00 Taipei → 18 empty, 17 empty, 16 has data.
    const out = await fetchRanking("gainers", 20, new Date("2026-10-18T04:00:00Z"), http);
    expect(http).toHaveBeenCalledTimes(3);
    expect(http.mock.calls[0]![1]!.body).toEqual({ scanner_type: "ChangePercentRank", ascending: true, count: 20, date: "2026-10-18" });
    expect(out[0]).toMatchObject({ code: "2330", name: "台積電", changeRate: 10, date: "2026-10-16" });
  });

  it("losers ask the scanner for ascending:false", async () => {
    const http = vi.fn<HttpFn>(async () => [row]);
    await fetchRanking("losers", 5, new Date("2026-10-16T04:00:00Z"), http);
    expect(http.mock.calls[0]![1]!.body).toMatchObject({ scanner_type: "ChangePercentRank", ascending: false });
  });

  it("gives up after maxDaysBack and returns []", async () => {
    const http = vi.fn<HttpFn>(async () => []);
    expect(await fetchRanking("volume", 5, new Date("2026-10-16T04:00:00Z"), http, 2)).toEqual([]);
    expect(http).toHaveBeenCalledTimes(3);
  });
});

describe("helpers", () => {
  it("taipeiDate uses UTC+8", () => {
    expect(taipeiDate(new Date("2026-10-19T17:00:00Z"))).toBe("2026-10-20");
    expect(taipeiDate(new Date("2026-10-19T15:59:00Z"))).toBe("2026-10-19");
  });

  it("cleanName drops mojibake", () => {
    expect(cleanName("台積電")).toBe("台積電");
    expect(cleanName("��A")).toBe("");
    expect(cleanName(undefined)).toBe("");
  });

  it("toContractRef maps Vela symbols to shioaji contracts", () => {
    expect(toContractRef("TSE:2330")).toEqual({ security_type: "STK", exchange: "TSE", code: "2330" });
    expect(toContractRef("OTC:6547")).toEqual({ security_type: "STK", exchange: "OTC", code: "6547" });
    expect(toContractRef("2330")).toEqual({ security_type: "STK", exchange: "TSE", code: "2330" });
    expect(toContractRef("TAIFEX:TMFK6")).toEqual({ security_type: "FUT", exchange: "TAIFEX", code: "TMFK6" });
    expect(toContractRef("MXFR1")).toEqual({ security_type: "FUT", exchange: "TAIFEX", code: "MXFR1" });
    expect(toContractRef("IX0001")).toEqual({ security_type: "IND", exchange: "TSE", code: "IX0001" });
    expect(toContractRef("BINANCE:BTCUSDT")).toBeNull();
    expect(toContractRef("")).toBeNull();
  });
});

describe("fetchContractInfo", () => {
  beforeEach(() => clearContractInfoCache());

  it("caches per code", async () => {
    const http = vi.fn<HttpFn>(async () => ({ code: "6547", exchange: "OTC", name: "�", category: 22 }));
    const a = await fetchContractInfo("6547", http);
    const b = await fetchContractInfo("6547", http);
    expect(a).toEqual({ code: "6547", exchange: "OTC", name: "", category: "22" });
    expect(b).toBe(a);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("returns null when the server 404s", async () => {
    const http = vi.fn<HttpFn>(async () => {
      throw new Error("404");
    });
    expect(await fetchContractInfo("0000", http)).toBeNull();
  });
});
