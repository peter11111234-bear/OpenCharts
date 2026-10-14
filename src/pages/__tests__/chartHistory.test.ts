import { describe, it, expect } from "vitest";
import type { Candle } from "../../services/schemas.ts";
import {
  EMPTY_EXTENSION,
  prependExtension,
  rebaseExtension,
  type HistoricalExtension,
} from "../trading/chartHistory.ts";

const I = 60;
const ANCHOR = 1_700_000_000;

const bar = (time: number): Candle =>
  ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 }) as Candle;

/** The payload the chart holds: the newest bars, ending on the time base. */
const payloadAt = (anchor: number): Candle[] => [
  bar(anchor - 2 * I),
  bar(anchor - I),
  bar(anchor),
];

/** A load-older batch: older bars, ending exactly on the payload's oldest. */
const batchAt = (anchor: number): Candle[] => [
  bar(anchor - 4 * I),
  bar(anchor - 3 * I),
  bar(anchor - 2 * I),
];

/** Missing slots on the time axis between the oldest and newest bar. */
function holes(times: number[]): number {
  const unique = [...new Set(times)].sort((a, b) => a - b);
  let missing = 0;
  for (let i = 1; i < unique.length; i++) {
    missing += (unique[i]! - unique[i - 1]!) / I - 1;
  }
  return missing;
}

describe("chart history extension", () => {
  it("hands back bars that already sit in the current base untouched", () => {
    const ext: HistoricalExtension = { bars: batchAt(ANCHOR), anchor: ANCHOR };

    expect(rebaseExtension(ext, ANCHOR)).toBe(ext.bars);

    const merged = [...rebaseExtension(ext, ANCHOR), ...payloadAt(ANCHOR)];
    // The batch ends on the payload's oldest bar, so dedupe drops one copy.
    expect(new Set(merged.map((c) => c.time)).size).toBe(5);
    expect(holes(merged.map((c) => c.time))).toBe(0);
  });

  it("slides held bars onto a re-anchored payload so the seam stays contiguous", () => {
    const rolled = ANCHOR + 2 * I;
    const ext: HistoricalExtension = { bars: batchAt(ANCHOR), anchor: ANCHOR };

    const slid = rebaseExtension(ext, rolled);
    // The batch's newest bar was the payload's oldest before the roll, and the
    // slide must land it there again.
    expect(slid[slid.length - 1]!.time).toBe(rolled - 2 * I);
    expect(slid.map((c) => c.time)).toEqual([
      rolled - 4 * I,
      rolled - 3 * I,
      rolled - 2 * I,
    ]);

    const merged = [...slid, ...payloadAt(rolled)];
    expect(holes(merged.map((c) => c.time))).toBe(0);
    expect(new Set(merged.map((c) => c.time)).size).toBe(5);
  });

  it("leaves a hole when held bars from the old base are merged unslid", () => {
    const rolled = ANCHOR + 2 * I;

    // The defect the slide exists to prevent: two periods of roll leave one
    // bar missing at the seam, and the gap grows with every further roll.
    const unslid = [...batchAt(ANCHOR), ...payloadAt(rolled)];
    expect(holes(unslid.map((c) => c.time))).toBe(1);
  });

  it("returns held bars untouched when either side has no base yet", () => {
    const ext: HistoricalExtension = { bars: batchAt(ANCHOR), anchor: ANCHOR };

    expect(rebaseExtension({ bars: ext.bars, anchor: 0 }, ANCHOR + I)).toBe(ext.bars);
    expect(rebaseExtension(ext, 0)).toBe(ext.bars);
    expect(rebaseExtension(EMPTY_EXTENSION, ANCHOR + I)).toEqual([]);
  });

  it("re-bases what is already held when a new batch arrives", () => {
    const rolled = ANCHOR + 2 * I;
    const held: HistoricalExtension = { bars: batchAt(ANCHOR), anchor: ANCHOR };

    const next = prependExtension(held, batchAt(rolled), rolled);

    expect(next.anchor).toBe(rolled);
    expect(holes(next.bars.map((c) => c.time))).toBe(0);
    // Held bars moved onto the new base rather than being kept in the old one.
    expect(Math.min(...next.bars.map((c) => c.time))).toBe(rolled - 4 * I);
  });

  it("keeps the previous base when a batch arrives without one", () => {
    const held: HistoricalExtension = { bars: batchAt(ANCHOR), anchor: ANCHOR };

    expect(prependExtension(held, batchAt(ANCHOR), 0)).toEqual({
      bars: [...batchAt(ANCHOR), ...batchAt(ANCHOR)],
      anchor: ANCHOR,
    });
    expect(prependExtension(EMPTY_EXTENSION, batchAt(ANCHOR), ANCHOR)).toEqual({
      bars: batchAt(ANCHOR),
      anchor: ANCHOR,
    });
  });
});
