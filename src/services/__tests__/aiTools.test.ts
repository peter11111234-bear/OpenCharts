import { describe, expect, it } from "vitest";
import {
  checkToolCall,
  describeAction,
  DOWN_COLOR,
  isAllowedSymbol,
  msToTaipei,
  taipeiToMs,
  TOOL_DEFS,
  UP_COLOR,
  type ChartSnapshot,
} from "../ai-assistant/tools.ts";

const T0 = taipeiToMs("2026-10-21 09:00")!;
const T1 = taipeiToMs("2026-10-21 13:00")!;

const snap: ChartSnapshot = {
  symbol: "TMFK6",
  timeframe: "5",
  firstTime: T0,
  lastTime: T1,
  low: 22300,
  high: 22600,
  lastClose: 22450,
  indicators: [{ id: "ind-1", title: "RSI", inputs: { length: 14, source: "close" } }],
  nativeTypes: ["vpvr", "sma"],
};

const call = (name: string, args: unknown) => checkToolCall(name, JSON.stringify(args), snap);

describe("taipei time", () => {
  it("round-trips Taipei wall clock and epoch ms", () => {
    expect(T0).toBe(Date.UTC(2026, 9, 21, 1, 0));
    expect(msToTaipei(T0)).toBe("2026-10-21 09:00");
  });

  it("rejects malformed and impossible dates", () => {
    expect(taipeiToMs("2026-10-21T09:00")).toBeNull();
    expect(taipeiToMs("2026-02-30 09:00")).toBeNull();
    expect(taipeiToMs("1729470000")).toBeNull();
  });
});

describe("checkToolCall: prices never collapse the axis", () => {
  it("accepts a sane horizontal line, anchored on the last bar, red when bullish", () => {
    const r = call("draw_horizontal_line", { price: 22450, bias: "bullish", label: "回踩線" });
    expect(r).toEqual({
      ok: true,
      action: { kind: "hline", anchor: { time: T1, price: 22450 }, label: "回踩線", color: UP_COLOR },
    });
  });

  it.each([0, -5, 224, 1e9])("rejects price %s", (price) => {
    expect(call("draw_horizontal_line", { price, bias: "bearish" }).ok).toBe(false);
  });

  it("rejects NaN / Infinity that JSON cannot even carry", () => {
    expect(checkToolCall("draw_horizontal_line", '{"price": NaN, "bias": "bullish"}', snap).ok).toBe(false);
    expect(call("draw_horizontal_line", { price: null, bias: "bullish" }).ok).toBe(false);
  });

  it("builds a green trend line from Taipei times", () => {
    const r = call("draw_trend_line", {
      from_time: "2026-10-21 09:00",
      from_price: 22550,
      to_time: "2026-10-21 12:30",
      to_price: 22350,
      bias: "bearish",
    });
    expect(r.ok && r.action).toEqual({
      kind: "trendline",
      from: { time: T0, price: 22550 },
      to: { time: taipeiToMs("2026-10-21 12:30"), price: 22350 },
      label: "",
      color: DOWN_COLOR,
    });
  });

  it("rejects epoch-second numbers and times outside the bars", () => {
    expect(call("add_mark", { time: "1729470000", price: 22400, bias: "bullish", text: "x" }).ok).toBe(false);
    const r = call("add_mark", { time: "2026-10-20 09:00", price: 22400, bias: "bullish", text: "x" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("不在圖上 K 棒範圍");
  });

  it("maps a bearish mark to a down arrow", () => {
    const r = call("add_mark", { time: "2026-10-21 10:00", price: 22500, bias: "bearish", text: "背離" });
    expect(r.ok && r.action).toMatchObject({ kind: "mark", dir: "down", color: DOWN_COLOR, text: "背離" });
  });
});

describe("checkToolCall: symbols, timeframes, indicators", () => {
  it("never switches to 大台 TXF", () => {
    expect(call("set_symbol", { symbol: "TXFK6" }).ok).toBe(false);
    expect(call("set_symbol", { symbol: "tmfk6" })).toEqual({ ok: true, action: { kind: "symbol", symbol: "TMFK6" } });
    expect(isAllowedSymbol("TSE:2330")).toBe(true);
    expect(isAllowedSymbol("MXFR1")).toBe(true);
  });

  it("accepts only listed timeframes", () => {
    expect(call("set_timeframe", { timeframe: "15" }).ok).toBe(true);
    expect(call("set_timeframe", { timeframe: "15m" }).ok).toBe(false);
  });

  it("checks indicator id, key and value type", () => {
    expect(call("set_indicator_inputs", { indicator_id: "ind-1", inputs: { length: 9 } })).toEqual({
      ok: true,
      action: { kind: "inputs", indicatorId: "ind-1", title: "RSI", inputs: { length: 9 } },
    });
    expect(call("set_indicator_inputs", { indicator_id: "nope", inputs: { length: 9 } }).ok).toBe(false);
    expect(call("set_indicator_inputs", { indicator_id: "ind-1", inputs: { period: 9 } }).ok).toBe(false);
    expect(call("set_indicator_inputs", { indicator_id: "ind-1", inputs: { length: "9" } }).ok).toBe(false);
  });

  it("adds only supported native types", () => {
    expect(call("add_native_indicator", { type: "vpvr" }).ok).toBe(true);
    expect(call("add_native_indicator", { type: "supertrend" }).ok).toBe(false);
  });

  it("rejects unknown tools and bad JSON", () => {
    expect(call("place_order", { symbol: "TMFK6" }).ok).toBe(false);
    expect(checkToolCall("set_timeframe", "{oops", snap).ok).toBe(false);
  });
});

describe("tool list", () => {
  it("has no order tool in phase 1", () => {
    expect(TOOL_DEFS.map((t) => t.function.name).some((n) => /order|trade/.test(n))).toBe(false);
  });

  it("describes cards in 繁中", () => {
    expect(describeAction({ kind: "timeframe", timeframe: "15" })).toBe("切換週期 → 15");
  });
});
