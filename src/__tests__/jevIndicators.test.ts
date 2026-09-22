import { describe, it, expect } from "vitest";
import fixture from "./fixtures/jev-indicators.json";
import { calculateJevIndicators, type CandleData } from "../services/jev/jevIndicators";

const candles = fixture.candles as CandleData[];
const expected = fixture.expected as Record<string, number | null>;
const TOL = 1e-4;

describe("calculateJevIndicators (pandas parity)", () => {
  const result = calculateJevIndicators(candles);

  it("returns exactly the Jev-Trades key set", () => {
    expect(Object.keys(result).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.keys(expected))("%s matches pandas within 1e-4", (key) => {
    const exp = expected[key];
    const got = result[key];
    if (exp === null || exp === undefined) {
      expect(got).toBeNull();
    } else {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - exp)).toBeLessThan(TOL);
    }
  });

  it("returns all nulls on empty input", () => {
    const r = calculateJevIndicators([]);
    expect(Object.values(r).every((v) => v === null)).toBe(true);
  });

  it("returns nulls for long-period MAs on short input", () => {
    const r = calculateJevIndicators(candles.slice(0, 30));
    expect(r["ema_200"]).toBeNull();
    expect(r["sma_200"]).toBeNull();
    expect(r["hull_ma_9"]).not.toBeNull();
    expect(r["relative_strength_index_14"]).not.toBeNull();
  });
});
