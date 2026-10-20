import { describe, expect, it } from "vitest";
import type { OHLCV } from "@luxalgo/vela";
import {
  computeRating,
  lookbackMs,
  ratingKey,
  RATING_BAR_LIMIT,
  techRatingSource,
  type FetchBarsFn,
} from "../techRating.ts";

const series = (n: number, f: (i: number) => number): OHLCV[] =>
  Array.from({ length: n }, (_, i) => {
    const c = f(i);
    return { time: i * 300_000, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
  });

const fetchOf = (bars: OHLCV[]): FetchBarsFn => async () => bars;

describe("ratingKey, TradingView bands", () => {
  it.each([
    [1, "strong_buy"],
    [0.51, "strong_buy"],
    [0.5, "buy"],
    [0.11, "buy"],
    [0.1, "neutral"],
    [0, "neutral"],
    [-0.1, "neutral"],
    [-0.11, "sell"],
    [-0.5, "sell"],
    [-0.51, "strong_sell"],
  ] as const)("%s → %s", (v, key) => {
    expect(ratingKey(v)).toBe(key);
  });

  it("null / NaN → null (no rating)", () => {
    expect(ratingKey(null)).toBeNull();
    expect(ratingKey(Number.NaN)).toBeNull();
  });
});

describe("lookbackMs", () => {
  it("intraday asks for 8× the bar span, daily 1.6×", () => {
    expect(lookbackMs("5")).toBe(5 * 60_000 * RATING_BAR_LIMIT * 8);
    expect(lookbackMs("D")).toBe(1440 * 60_000 * RATING_BAR_LIMIT * 1.6);
    expect(lookbackMs("W")).toBe(10080 * 60_000 * RATING_BAR_LIMIT * 1.6);
  });
});

describe("tech-rating.pine via the interpreter", () => {
  it("is bundled in the Pine manifest", () => {
    expect(techRatingSource()).toContain('indicator("Tech Rating"');
  });

  it("steady uptrend → MA strongly positive, overall buy side", async () => {
    const r = await computeRating("TSE:2330", "5", { fetchBars: fetchOf(series(300, (i) => 100 + i)) });
    expect(r.bars).toBe(300);
    expect(r.ma).toBeGreaterThan(0.5);
    expect(r.all).toBeGreaterThan(0.1);
  });

  it("steady downtrend → MA strongly negative, overall sell side", async () => {
    const r = await computeRating("TSE:2330", "5", { fetchBars: fetchOf(series(300, (i) => 500 - i)) });
    expect(r.ma).toBeLessThan(-0.5);
    expect(r.all).toBeLessThan(-0.1);
  });

  it("every value stays inside [-1, 1]", async () => {
    const r = await computeRating("TSE:2330", "5", {
      fetchBars: fetchOf(series(300, (i) => 100 + 10 * Math.sin(i / 7))),
    });
    for (const v of [r.all, r.ma, r.osc]) {
      expect(v).not.toBeNull();
      expect(Math.abs(v!)).toBeLessThanOrEqual(1);
    }
  });

  it("no bars → all null, bars 0", async () => {
    const r = await computeRating("TSE:2330", "5", { fetchBars: fetchOf([]) });
    expect(r).toEqual({ all: null, ma: null, osc: null, bars: 0 });
  });

  it("asks the fetcher for RATING_BAR_LIMIT bars from now - lookback", async () => {
    const calls: unknown[][] = [];
    const fetchBars: FetchBarsFn = async (...args) => {
      calls.push(args);
      return [];
    };
    await computeRating("TAIFEX:TMFJ6", "60", { fetchBars, now: () => 1_000_000_000_000 });
    expect(calls).toEqual([["TAIFEX:TMFJ6", "60", 1_000_000_000_000 - lookbackMs("60"), RATING_BAR_LIMIT]]);
  });

  it("fetch failure propagates (panel shows the error)", async () => {
    const fetchBars: FetchBarsFn = async () => {
      throw new Error("shioaji down");
    };
    await expect(computeRating("TSE:2330", "5", { fetchBars })).rejects.toThrow("shioaji down");
  });
});
