import { describe, it, expect, vi } from "vitest";
import * as engine from "../demo/engine.ts";
import { demoApi } from "../demo/api.ts";
import { getHistory, resetShiftCache } from "../demo/candles.ts";

/**
 * The demo paper engine is a module singleton, so each case claims its own
 * symbol. That keeps the session arrays (orders/positions) from leaking between
 * cases without needing a reset hook.
 */

const ACCOUNT = "demo-test";

function place(symbol: string, side: string, type: string, quantity: number, level?: number) {
  return engine.placeOrder({
    accountId: ACCOUNT,
    symbol,
    side,
    type,
    quantity,
    ...(type === "STOP" ? { stopPrice: level } : { price: level }),
  });
}

function orderById(id: string) {
  return engine.getOrders().find((o) => o.id === id);
}

describe("demo paper engine — resting orders", () => {
  it("rests a BUY LIMIT below the market, then fills it only at the market, never worse than its level", () => {
    engine.mark("BTCUSD", 64_000);
    const order = place("BTCUSD", "BUY", "LIMIT", 1, 60_000);

    expect(order.status).toBe("PENDING");
    expect(order.filledQuantity).toBe(0);
    expect(order.avgFillPrice).toBeNull();
    expect(engine.getPositions().some((p) => p.symbolName === "BTCUSD")).toBe(false);

    engine.mark("BTCUSD", 61_000);
    expect(orderById(order.id)!.status).toBe("PENDING");

    engine.mark("BTCUSD", 59_900);
    const filled = orderById(order.id)!;
    expect(filled.status).toBe("FILLED");
    expect(filled.avgFillPrice).toBe(59_900);
    expect(engine.getPositions().find((p) => p.symbolName === "BTCUSD")?.entryPrice).toBe(59_900);
  });

  it("triggers a SELL LIMIT upward and fills at the better of its level and the market", () => {
    engine.mark("ETHUSD", 2_000);
    const order = place("ETHUSD", "SELL", "LIMIT", 2, 2_100);
    expect(order.status).toBe("PENDING");

    engine.mark("ETHUSD", 2_050);
    expect(orderById(order.id)!.status).toBe("PENDING");

    engine.mark("ETHUSD", 2_150);
    const filled = orderById(order.id)!;
    expect(filled.status).toBe("FILLED");
    expect(filled.avgFillPrice).toBe(2_150);
    expect(engine.getPositions().find((p) => p.symbolName === "ETHUSD")?.side).toBe("SHORT");
  });

  it("treats a STOP as a trigger and fills it at the market price", () => {
    engine.mark("SOLUSD", 100);
    const order = place("SOLUSD", "BUY", "STOP", 1, 110);
    expect(order.status).toBe("PENDING");

    engine.mark("SOLUSD", 105);
    expect(orderById(order.id)!.status).toBe("PENDING");

    engine.mark("SOLUSD", 111);
    expect(orderById(order.id)!.avgFillPrice).toBe(111);
  });

  it("lands the ticket level on the field the order type triggers from", () => {
    engine.mark("BNBUSD", 500);
    const stop = place("BNBUSD", "BUY", "STOP", 1, 520);
    expect(stop.stopPrice).toBe(520);
    expect(stop.price).toBeNull();

    const limit = place("BNBUSD", "BUY", "LIMIT", 1, 480);
    expect(limit.price).toBe(480);
    expect(limit.stopPrice).toBeNull();
  });

  it("refuses to amend a filled order", () => {
    engine.mark("ADAUSD", 1);
    const order = place("ADAUSD", "BUY", "MARKET", 1);
    expect(order.status).toBe("FILLED");

    expect(engine.modifyOrder(order.id, { price: 99 })).toBeUndefined();

    const after = orderById(order.id)!;
    expect(after.price).toBeNull();
    expect(after.filledQuantity).toBe(order.filledQuantity);
  });

  it("amends a resting STOP through the ticket's price field", () => {
    engine.mark("XRPUSD", 1);
    const order = place("XRPUSD", "BUY", "STOP", 1, 2);

    expect(engine.modifyOrder(order.id, { price: 3 })?.stopPrice).toBe(3);

    engine.mark("XRPUSD", 2.5);
    expect(orderById(order.id)!.status).toBe("PENDING");

    engine.mark("XRPUSD", 3.5);
    expect(orderById(order.id)!.avgFillPrice).toBe(3.5);
  });

  it("rejects an unusable quantity instead of poisoning the account", () => {
    engine.mark("BTCUSD", 64_000);
    expect(() => place("BTCUSD", "BUY", "MARKET", -5)).toThrow();
    expect(() => place("BTCUSD", "BUY", "MARKET", 0)).toThrow();
    expect(() => place("BTCUSD", "BUY", "MARKET", Number.POSITIVE_INFINITY)).toThrow();
  });

  it("reports a cancel of an unknown order as a failure", () => {
    expect(engine.cancelOrder("no-such-order")).toEqual({ success: false });
  });
});

describe("demo history windowing", () => {
  it("windows inclusively at both ends, so the boundary bar the chart already holds comes back and dedupe absorbs it", async () => {
    resetShiftCache();
    const full = await demoApi.getCandles("BTCUSD", "1h");
    const oldest = full[0]!.time;
    const boundary = full[700]!.time;
    const windowMs = 500 * 3600 * 1000;

    const window = await demoApi.getCandles("BTCUSD", "1h", undefined, {
      fromMs: boundary * 1000 - windowMs,
      toMs: boundary * 1000,
    });

    expect(window.length).toBe(501);
    expect(window[0]!.time).toBe(oldest + 200 * 3600);
    expect(window[window.length - 1]!.time).toBe(boundary);
    // The boundary bar is byte-identical to the one on the chart, so the merge
    // dedupe drops it rather than losing a real bar.
    expect(window[window.length - 1]).toEqual(full[700]);

    // A window entirely before the series returns nothing — that is the signal
    // the loader reads as the start of history.
    const before = await demoApi.getCandles("BTCUSD", "1h", undefined, {
      fromMs: 0,
      toMs: (oldest - 1) * 1000,
    });
    expect(before).toEqual([]);
  });

  it("pins one time base inside a bucket, re-anchors the tail on the next, and never moves it for a window", () => {
    vi.useFakeTimers();
    try {
      resetShiftCache();
      const t0 = Date.parse("2026-01-01T00:30:00Z");
      const hourMs = 3_600_000;
      const bucketSec = (iso: string) => Date.parse(iso) / 1000;

      vi.setSystemTime(t0);
      const first = getHistory("ETHUSD", "1h");
      expect(first[first.length - 1]!.time).toBe(bucketSec("2026-01-01T00:00:00Z"));

      // Repeat fetches inside the bucket stay byte-identical, so React Query
      // collapses them and no repair refetch repaints.
      expect(getHistory("ETHUSD", "1h")).toEqual(first);
      vi.setSystemTime(t0 + 20 * 60_000); // 00:50 — still inside the 00:00 bucket
      expect(getHistory("ETHUSD", "1h")).toEqual(first);

      // The next bucket must not leave the tail behind the wall clock.
      vi.setSystemTime(t0 + hourMs);
      const rolled = getHistory("ETHUSD", "1h");
      expect(rolled[rolled.length - 1]!.time).toBe(bucketSec("2026-01-01T01:00:00Z"));
      expect(rolled).not.toEqual(first);

      // A windowed fetch keeps the anchored base: contiguity with the bars on
      // screen outranks freshness on the load-older path.
      vi.setSystemTime(t0 + 2 * hourMs);
      const windowed = getHistory("ETHUSD", "1h", undefined, { fromMs: 0, toMs: 4e15 });
      expect(windowed[windowed.length - 1]!.time).toBe(bucketSec("2026-01-01T01:00:00Z"));

      const tail = getHistory("ETHUSD", "1h");
      expect(tail[tail.length - 1]!.time).toBe(bucketSec("2026-01-01T02:00:00Z"));
    } finally {
      vi.useRealTimers();
    }
  });
});
