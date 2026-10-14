import { describe, expect, it } from "vitest";
import { orderLevel } from "../trading/orderOverlay.ts";

describe("orderLevel", () => {
  it("extracts price for LIMIT order", () => {
    expect(orderLevel({ type: "LIMIT", price: 105.5, stopPrice: null })).toBe(105.5);
    // Even if stopPrice is populated by mistake, LIMIT should strictly use price
    expect(orderLevel({ type: "LIMIT", price: 200, stopPrice: 190 })).toBe(200);
  });

  it("extracts stopPrice for STOP order", () => {
    expect(orderLevel({ type: "STOP", price: null, stopPrice: 95.25 })).toBe(95.25);
    // Even if price is populated, STOP should strictly use stopPrice
    expect(orderLevel({ type: "STOP", price: 100, stopPrice: 90 })).toBe(90);
  });

  it("returns null for MARKET order", () => {
    expect(orderLevel({ type: "MARKET", price: null, stopPrice: null })).toBeNull();
    // Even with stray prices, MARKET executes at market and has no price line
    expect(orderLevel({ type: "MARKET", price: 100, stopPrice: 90 })).toBeNull();
  });

  it("returns null when price or stopPrice is null, undefined, or non-finite", () => {
    expect(orderLevel({ type: "LIMIT", price: null, stopPrice: null })).toBeNull();
    expect(orderLevel({ type: "STOP", price: null, stopPrice: null })).toBeNull();
    expect(orderLevel({ type: "LIMIT", price: NaN, stopPrice: null })).toBeNull();
    expect(orderLevel({ type: "STOP", price: null, stopPrice: Infinity })).toBeNull();
  });
});
