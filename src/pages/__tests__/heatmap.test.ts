import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexEntry } from "../../services/shioaji/marketData.ts";
import { layoutHeatmap, mountHeatmapPanel, squarify, type Rect } from "../heatmap.ts";
import type { WidgetHandle } from "../quoteStrip.ts";

const entry = (code: string, category: string, weightPpm: number, pct = 0): IndexEntry => ({
  code,
  exchange: "TSE",
  category,
  price: 100,
  pct,
  weightPpm,
  amount: 0,
});

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

describe("layoutHeatmap", () => {
  it("keeps only electronics (24–31), top N by weight, grouped by category", () => {
    const entries = [entry("2330", "24", 300), entry("2317", "28", 50), entry("2882", "17", 999), entry("2454", "24", 40), entry("3008", "26", 5)];
    const { groups, tiles } = layoutHeatmap(entries, 3, { x: 0, y: 0, w: 300, h: 200 });
    expect(tiles.map((t) => t.item.code).sort()).toEqual(["2317", "2330", "2454"]);
    expect(groups.map((g) => g.item).sort()).toEqual(["24", "28"]);
    const g24 = groups.find((g) => g.item === "24")!;
    for (const t of tiles.filter((t) => t.item.category === "24")) {
      expect(t.x).toBeGreaterThanOrEqual(g24.x - 1e-6);
      expect(t.x + t.w).toBeLessThanOrEqual(g24.x + g24.w + 1e-6);
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

  it("draws coloured tiles with category labels; clicking picks EXCHANGE:CODE", async () => {
    const onPick = vi.fn();
    const entries = vi.fn(async () => [entry("2330", "24", 300, 2.5), entry("2317", "28", 100, -1.2)]);
    handle = mountHeatmapPanel(body, { entries, onPick });
    await vi.waitFor(() => expect(body.querySelectorAll(".hm-tile")).toHaveLength(2));
    expect(body.textContent).toContain("半導體");
    expect(body.textContent).toContain("電子零組件");
    const tile = body.querySelector<HTMLElement>('[data-symbol="TSE:2330"]')!;
    expect(tile.style.background).not.toBe("");
    tile.click();
    expect(onPick).toHaveBeenCalledWith("TSE:2330");
  });

  it("says so when no electronics data is available", async () => {
    handle = mountHeatmapPanel(body, { entries: async () => [entry("2882", "17", 10)], onPick: vi.fn() });
    await vi.waitFor(() => expect(body.textContent).toContain("沒有電子類成分股資料"));
  });

  it("shows a warning on server failure and refreshes on its timer", async () => {
    const entries = vi.fn(async (): Promise<IndexEntry[]> => {
      throw new Error("down");
    });
    handle = mountHeatmapPanel(body, { entries, onPick: vi.fn(), refreshMs: 30_000 });
    await vi.waitFor(() => expect(body.textContent).toContain("無法取得熱力圖：down"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(entries).toHaveBeenCalledTimes(2);
  });
});
