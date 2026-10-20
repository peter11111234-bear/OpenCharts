import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractRef } from "../../services/shioaji/server.ts";
import type { QuoteSnap } from "../../services/shioaji/marketData.ts";
import { DEFAULT_CARDS, mountQuoteStrip, type WidgetHandle } from "../quoteStrip.ts";

const snap = (code: string, close: number, changeRate: number, extra: Partial<QuoteSnap> = {}): QuoteSnap => ({
  code,
  exchange: "TSE",
  open: close,
  high: close + 10,
  low: close - 10,
  close,
  changePrice: changeRate,
  changeRate,
  totalVolume: 12_345,
  totalAmount: 0,
  datetime: "",
  ...extra,
});

describe("mountQuoteStrip", () => {
  let el: HTMLElement;
  let handle: WidgetHandle | null = null;
  const ctx = { symbol: "TSE:2330" };

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    document.body.appendChild(el);
    ctx.symbol = "TSE:2330";
  });

  afterEach(() => {
    handle?.destroy();
    handle = null;
    el.remove();
    vi.useRealTimers();
  });

  it("shows the default cards in Taiwan colours and the active symbol's info bar", async () => {
    const quotes = vi.fn(async (refs: ContractRef[]) => refs.map((r, i) => snap(r.code, 100 + i, i % 2 ? -1 : 1)));
    handle = mountQuoteStrip(ctx, el, { quotes });
    await vi.waitFor(() => expect(el.querySelectorAll(".qs-card").length).toBe(DEFAULT_CARDS.length));
    expect(el.textContent).toContain("微台");
    expect(el.textContent).toContain("TSE:2330");
    expect(el.querySelector(".qs-range-mark")).not.toBeNull();
    expect(el.innerHTML).toContain("#f23645"); // up = red
    expect(el.innerHTML).toContain("#089981"); // down = green
    // 2330 is already a card → not requested twice
    expect(quotes.mock.calls[0]![0].filter((r) => r.code === "2330")).toHaveLength(1);
  });

  it("adds the active symbol to the request when it is not a card", async () => {
    ctx.symbol = "OTC:6547";
    const quotes = vi.fn(async (refs: ContractRef[]) => refs.map((r) => snap(r.code, 50, 0)));
    handle = mountQuoteStrip(ctx, el, { quotes });
    await vi.waitFor(() => expect(el.textContent).toContain("OTC:6547"));
    expect(quotes.mock.calls[0]![0].at(-1)).toEqual({ security_type: "STK", exchange: "OTC", code: "6547" });
  });

  it("refetches when the chart symbol changes", async () => {
    const quotes = vi.fn(async (refs: ContractRef[]) => refs.map((r) => snap(r.code, 50, 0)));
    handle = mountQuoteStrip(ctx, el, { quotes, pollMs: 1000, refreshMs: 60_000 });
    await vi.waitFor(() => expect(quotes).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(quotes).toHaveBeenCalledTimes(1); // same symbol → no refetch
    ctx.symbol = "TAIFEX:TMFK6";
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(el.textContent).toContain("TAIFEX:TMFK6"));
    expect(quotes).toHaveBeenCalledTimes(2);
  });

  it("says 無報價 for a symbol shioaji cannot quote", async () => {
    ctx.symbol = "BINANCE:BTCUSDT";
    const quotes = vi.fn(async (refs: ContractRef[]) => refs.map((r) => snap(r.code, 50, 0)));
    handle = mountQuoteStrip(ctx, el, { quotes });
    await vi.waitFor(() => expect(el.textContent).toContain("BINANCE:BTCUSDT · 無報價"));
  });

  it("shows a warning when the server fails", async () => {
    const quotes = vi.fn(async () => {
      throw new Error("down");
    });
    handle = mountQuoteStrip(ctx, el, { quotes });
    await vi.waitFor(() => expect(el.textContent).toContain("報價暫停：down"));
  });

  it("destroy stops polling and clears the strip", async () => {
    const quotes = vi.fn(async (refs: ContractRef[]) => refs.map((r) => snap(r.code, 50, 0)));
    handle = mountQuoteStrip(ctx, el, { quotes, refreshMs: 5000 });
    await vi.waitFor(() => expect(quotes).toHaveBeenCalledTimes(1));
    handle.destroy();
    handle = null;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(quotes).toHaveBeenCalledTimes(1);
    expect(el.innerHTML).toBe("");
  });
});
