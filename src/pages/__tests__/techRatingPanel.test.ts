import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountTechRatingPanel, type RatingPanelHandle } from "../techRatingPanel.ts";
import type { RatingSnapshot } from "../techRating.ts";

const snap = (all: number | null, ma: number | null, osc: number | null, bars = 300): RatingSnapshot => ({
  all,
  ma,
  osc,
  bars,
});

describe("mountTechRatingPanel", () => {
  let body: HTMLElement;
  let handle: RatingPanelHandle | null = null;
  const ctx = { symbol: "TSE:2330", timeframe: "5" };

  beforeEach(() => {
    vi.useFakeTimers();
    body = document.createElement("div");
    document.body.appendChild(body);
    ctx.symbol = "TSE:2330";
    ctx.timeframe = "5";
  });

  afterEach(() => {
    handle?.destroy();
    handle = null;
    body.remove();
    vi.useRealTimers();
  });

  it("renders the overall label, MA and oscillator rows, and a needle", async () => {
    const compute = vi.fn(async () => snap(0.48, 0.87, 0.1));
    handle = mountTechRatingPanel(ctx, body, { compute });
    await vi.waitFor(() => expect(body.textContent).toContain("買入"));
    expect(body.textContent).toContain("0.48");
    expect(body.textContent).toContain("強力買入 0.87");
    expect(body.textContent).toContain("中立 0.10");
    expect(body.textContent).toContain("TSE:2330 · 5 · 300 根 K 棒");
    expect(body.querySelector(".tr-needle")).not.toBeNull();
    expect(compute).toHaveBeenCalledWith("TSE:2330", "5");
  });

  it("null rating → 資料不足 and no needle", async () => {
    handle = mountTechRatingPanel(ctx, body, { compute: async () => snap(null, null, null, 0) });
    await vi.waitFor(() => expect(body.textContent).toContain("資料不足"));
    expect(body.querySelector(".tr-needle")).toBeNull();
  });

  it("fewer than 200 bars shows the warm-up warning", async () => {
    handle = mountTechRatingPanel(ctx, body, { compute: async () => snap(0.2, 0.3, 0.1, 120) });
    await vi.waitFor(() => expect(body.textContent).toContain("只有 120 根 K 棒"));
  });

  it("compute error is shown, not thrown", async () => {
    handle = mountTechRatingPanel(ctx, body, {
      compute: async () => {
        throw new Error("shioaji down");
      },
    });
    await vi.waitFor(() => expect(body.textContent).toContain("無法取得評分：shioaji down"));
  });

  it("symbol switch triggers a recompute for the new symbol", async () => {
    const compute = vi.fn(async () => snap(0.2, 0.2, 0.2));
    handle = mountTechRatingPanel(ctx, body, { compute, pollMs: 1000 });
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    ctx.symbol = "TAIFEX:TMFJ6";
    await vi.advanceTimersByTimeAsync(1000);
    expect(compute).toHaveBeenLastCalledWith("TAIFEX:TMFJ6", "5");
  });

  it("unchanged symbol does NOT recompute on the poll tick", async () => {
    const compute = vi.fn(async () => snap(0.2, 0.2, 0.2));
    handle = mountTechRatingPanel(ctx, body, { compute, pollMs: 1000, refreshMs: 60_000 });
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("with autoRefreshKey: refreshes only when the key changes, never when it is null", async () => {
    const compute = vi.fn(async () => snap(0.2, 0.2, 0.2));
    let key: string | null = "a";
    handle = mountTechRatingPanel(ctx, body, { compute, pollMs: 1000, checkMs: 1000, autoRefreshKey: () => key });
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(compute).toHaveBeenCalledTimes(1); // same bar: no refetch
    key = "b";
    await vi.advanceTimersByTimeAsync(1000);
    expect(compute).toHaveBeenCalledTimes(2); // new bar closed
    key = null;
    await vi.advanceTimersByTimeAsync(5000);
    expect(compute).toHaveBeenCalledTimes(2); // market closed for this symbol
    ctx.symbol = "TAIFEX:TMFJ6";
    await vi.advanceTimersByTimeAsync(1000);
    expect(compute).toHaveBeenCalledTimes(3); // a symbol switch still computes once
  });

  it("a stale result never overwrites the newer symbol", async () => {
    let release!: (s: RatingSnapshot) => void;
    const compute = vi
      .fn<(s: string, tf: string) => Promise<RatingSnapshot>>()
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockImplementation(async () => snap(-0.6, -0.6, -0.6));
    handle = mountTechRatingPanel(ctx, body, { compute, pollMs: 1000 });
    ctx.symbol = "TAIFEX:TMFJ6";
    await vi.advanceTimersByTimeAsync(1000); // queued behind the in-flight run
    release(snap(0.9, 0.9, 0.9));
    await vi.waitFor(() => expect(body.textContent).toContain("強力賣出"));
    expect(body.textContent).toContain("TAIFEX:TMFJ6");
  });

  it("destroy stops polling and removes the DOM", async () => {
    const compute = vi.fn(async () => snap(0.2, 0.2, 0.2));
    handle = mountTechRatingPanel(ctx, body, { compute, pollMs: 1000 });
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    handle.destroy();
    handle = null;
    ctx.symbol = "OTC:6547";
    await vi.advanceTimersByTimeAsync(5000);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(body.querySelector(".tr-panel")).toBeNull();
  });
});
