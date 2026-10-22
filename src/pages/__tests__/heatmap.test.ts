import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTwStockSession, type IndexEntry } from "../../services/shioaji/marketData.ts";
import { layoutThemeHeatmap, mountHeatmapPanel, squarify, themeCodes, THEMES, type Rect, type ThemeDb } from "../heatmap.ts";
import type { WidgetHandle } from "../quoteStrip.ts";

const entry = (code: string, amount: number, pct = 0, exchange = "TSE"): IndexEntry => ({
  code,
  exchange,
  category: "24",
  price: 100,
  pct,
  weightPpm: 0,
  amount,
});

const stock = (code: string, name: string, sub_group: string) => ({ code, name, sub_group, role: `${name} role` });
const DB: ThemeDb = {
  cool: {
    title: "液冷散熱 (Liquid Cooling)",
    description: "散熱",
    stocks: { "3017": stock("3017", "奇鋐", "水冷板"), "3324": stock("3324", "雙鴻", "水冷板"), "6230": stock("6230", "尼得科超眾", "均熱片") },
  },
  cpo: {
    title: "矽光子 (CPO)",
    description: "光通訊",
    stocks: { "3017": stock("3017", "奇鋐", "散熱"), "3081": stock("3081", "聯亞", "雷射"), "9999": stock("9999", "未上市", "雷射") },
  },
};

const overlap = (a: Rect, b: Rect) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;

describe("squarify", () => {
  const rect = { x: 0, y: 0, w: 300, h: 200 };
  const items = [6, 6, 4, 3, 2, 2, 1].map((value, i) => ({ item: i, value }));

  it("tiles fill the rect, area ∝ value, inside bounds, no overlap", () => {
    const out = squarify(items, rect);
    expect(out).toHaveLength(items.length);
    const total = out.reduce((s, r) => s + r.w * r.h, 0);
    expect(total).toBeCloseTo(300 * 200, 6);
    for (const r of out) {
      expect(r.w * r.h).toBeCloseTo((items[r.item]!.value / 24) * 60_000, 6);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(300 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(200 + 1e-6);
    }
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) expect(overlap(out[i]!, out[j]!)).toBe(false);
  });

  it("ignores non-positive values and empty rects", () => {
    expect(squarify([{ item: "a", value: 0 }, { item: "b", value: -1 }], rect)).toEqual([]);
    expect(squarify(items, { x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
  });
});

describe("layoutThemeHeatmap", () => {
  const rect = { x: 0, y: 0, w: 300, h: 200 };
  const quotes = [entry("3017", 50), entry("3324", 30), entry("6230", 20), entry("3081", 10, 0, "OTC")];

  it("overview: one group per theme (short title), a stock may sit in several, top N by turnover", () => {
    const { groups, tiles, missing } = layoutThemeHeatmap(DB, null, quotes, rect, 2);
    expect(groups.map((g) => g.item).sort()).toEqual(["液冷散熱", "矽光子"]);
    const inCool = tiles.filter((t) => t.item.stock.sub_group !== "散熱" && t.item.stock.sub_group !== "雷射");
    expect(inCool.map((t) => t.item.stock.code).sort()).toEqual(["3017", "3324"]);
    expect(tiles.filter((t) => t.item.quote.code === "3017")).toHaveLength(2);
    expect(missing.map((m) => m.code)).toEqual(["9999"]);
  });

  it("one theme: all its stocks, grouped by sub_group, area ∝ turnover, inside their group", () => {
    const { groups, tiles } = layoutThemeHeatmap(DB, "cool", quotes, rect);
    expect(groups.map((g) => g.item).sort()).toEqual(["均熱片", "水冷板"]);
    expect(tiles).toHaveLength(3);
    const area = (c: string) => tiles.find((t) => t.item.quote.code === c)!;
    expect(area("3017").w * area("3017").h).toBeCloseTo((50 / 100) * 60_000, 6);
    const g = groups.find((g) => g.item === "水冷板")!;
    for (const t of tiles.filter((t) => t.item.stock.sub_group === "水冷板")) {
      expect(t.x).toBeGreaterThanOrEqual(g.x - 1e-6);
      expect(t.x + t.w).toBeLessThanOrEqual(g.x + g.w + 1e-6);
    }
  });

  it("leaves a label strip at the top of each group", () => {
    const { groups, tiles } = layoutThemeHeatmap(DB, "cool", quotes, rect, 8, 13);
    for (const t of tiles) {
      const g = groups.find((g) => g.item === t.item.stock.sub_group)!;
      expect(t.y).toBeGreaterThanOrEqual(g.y + 13 - 1e-6);
      expect(t.y + t.h).toBeLessThanOrEqual(g.y + g.h + 1e-6);
    }
  });

  it("equal-sized tiles before any turnover (pre-market)", () => {
    const { tiles } = layoutThemeHeatmap(DB, "cool", quotes.map((q) => ({ ...q, amount: 0 })), rect);
    expect(tiles).toHaveLength(3);
    for (const t of tiles) expect(t.w * t.h).toBeCloseTo(60_000 / 3, 6);
  });

  it("the bundled database parses: 11 themes, every stock has code/name/sub_group", () => {
    expect(Object.keys(THEMES)).toHaveLength(11);
    for (const t of Object.values(THEMES))
      for (const [k, s] of Object.entries(t.stocks)) {
        expect(s.code).toBe(k);
        expect(s.name && s.sub_group).toBeTruthy();
      }
  });
});

describe("mountHeatmapPanel", () => {
  let body: HTMLElement;
  let handle: WidgetHandle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    body = document.createElement("div");
    document.body.appendChild(body);
  });

  afterEach(() => {
    handle?.destroy();
    handle = null;
    body.remove();
    vi.useRealTimers();
  });

  it("draws named tiles with group labels; clicking picks EXCHANGE:CODE (OTC too)", async () => {
    const onPick = vi.fn();
    const entries = vi.fn(async () => [entry("3017", 50, 2.5), entry("3081", 10, -1.2, "OTC")]);
    handle = mountHeatmapPanel(body, { entries, onPick, themes: DB });
    await vi.waitFor(() => expect(body.querySelectorAll(".hm-tile")).toHaveLength(3));
    expect(body.textContent).toContain("液冷散熱");
    expect(body.textContent).toContain("奇鋐");
    expect(body.textContent).toContain("3 檔無報價（雙鴻、尼得科超眾、未上市）");
    const tile = body.querySelector<HTMLElement>('[data-symbol="OTC:3081"]')!;
    expect(tile.style.background).not.toBe("");
    expect(tile.title).toContain("聯亞 role");
    tile.click();
    expect(onPick).toHaveBeenCalledWith("OTC:3081");
  });

  it("switching theme redraws from the last data without refetching", async () => {
    const entries = vi.fn(async () => [entry("3017", 50), entry("3324", 30), entry("6230", 20)]);
    handle = mountHeatmapPanel(body, { entries, onPick: vi.fn(), themes: DB });
    await vi.waitFor(() => expect(body.querySelectorAll(".hm-tile")).toHaveLength(4));
    const select = body.querySelector<HTMLSelectElement>("select")!;
    select.value = "cool";
    select.dispatchEvent(new Event("change"));
    expect(body.querySelectorAll(".hm-tile")).toHaveLength(3);
    expect(body.textContent).toContain("水冷板");
    expect(entries).toHaveBeenCalledTimes(1);
  });

  it("says so when no theme stock has a quote", async () => {
    handle = mountHeatmapPanel(body, { entries: async () => [entry("2882", 10)], onPick: vi.fn(), themes: DB });
    await vi.waitFor(() => expect(body.textContent).toContain("沒有主題股報價資料"));
  });

  it("shows a warning on server failure and refreshes on its timer", async () => {
    const entries = vi.fn(async (): Promise<IndexEntry[]> => {
      throw new Error("down");
    });
    handle = mountHeatmapPanel(body, { entries, onPick: vi.fn(), refreshMs: 30_000, isOpen: () => true });
    await vi.waitFor(() => expect(body.textContent).toContain("無法取得熱力圖：down"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(entries).toHaveBeenCalledTimes(2);
  });

  it("loads once on mount but skips timer refreshes outside the stock session", async () => {
    const entries = vi.fn(async () => [entry("3017", 50)]);
    handle = mountHeatmapPanel(body, { entries, onPick: vi.fn(), themes: DB, refreshMs: 30_000, isOpen: () => false });
    await vi.waitFor(() => expect(entries).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(entries).toHaveBeenCalledTimes(1);
  });
});

describe("themeCodes", () => {
  it("lists each stock once even when it sits in several themes (395 rows → 309 codes)", () => {
    const rows = Object.values(THEMES).flatMap((t) => Object.values(t.stocks));
    expect(rows).toHaveLength(395);
    const codes = themeCodes();
    expect(codes).toHaveLength(309);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("isTwStockSession", () => {
  // Instants in UTC; Taipei = UTC+8. 2026-10-22 is a Thursday.
  it.each([
    ["2026-10-22T00:59:00Z", false], // 08:59
    ["2026-10-22T01:00:00Z", true], // 09:00
    ["2026-10-22T05:35:00Z", true], // 13:35 (closing auction settles)
    ["2026-10-22T05:36:00Z", false], // 13:36
    ["2026-10-24T02:00:00Z", false], // Saturday 10:00
    ["2026-10-25T02:00:00Z", false], // Sunday 10:00
  ])("%s → %s", (iso, want) => {
    expect(isTwStockSession(new Date(iso))).toBe(want);
  });
});
