import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttleBars } from "../shioaji/velaProvider";

const bar = (time: number, close: number) => ({ time, open: 1, high: close, low: 1, close, volume: 1 });

describe("throttleBars", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst into the latest bar", () => {
    const seen: number[] = [];
    const t = throttleBars((b) => seen.push(b.close), 1000);
    for (let c = 1; c <= 50; c++) t.push(bar(60_000, c));
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([50]);
  });

  it("flushes the closing bar immediately when a new bar starts", () => {
    const seen: Array<[number, number]> = [];
    const t = throttleBars((b) => seen.push([b.time, b.close]), 1000);
    t.push(bar(60_000, 10));
    t.push(bar(60_000, 11));
    t.push(bar(120_000, 12));
    expect(seen).toEqual([[60_000, 11]]);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([[60_000, 11], [120_000, 12]]);
  });

  it("cancel drops the pending bar", () => {
    const seen: number[] = [];
    const t = throttleBars((b) => seen.push(b.close), 1000);
    t.push(bar(60_000, 1));
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([]);
  });
});
