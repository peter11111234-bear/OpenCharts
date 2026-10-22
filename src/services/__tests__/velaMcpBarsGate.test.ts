import type { OHLCV } from "@luxalgo/vela";
import { describe, expect, it, vi } from "vitest";
import { createBarsGate } from "../vela-mcp/barsGate.ts";

const BAR: OHLCV = { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 };

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

describe("createBarsGate", () => {
  it("10 rapid calls for the same chart make one upstream fetch", async () => {
    const c = clock();
    const fetch = vi.fn(async () => [BAR]);
    const get = createBarsGate(fetch, { ttlMs: 30_000, minGapMs: 2_000, now: c.now, sleep: c.sleep });
    const all = await Promise.all(Array.from({ length: 10 }, () => get("TMFR1", "5")));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(all.every((b) => b[0] === BAR)).toBe(true);
  });

  it("different charts are fetched one at a time, at least minGap apart", async () => {
    const c = clock();
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    const fetch = vi.fn(async () => {
      starts.push(c.now());
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return [BAR];
    });
    const get = createBarsGate(fetch, { ttlMs: 30_000, minGapMs: 2_000, now: c.now, sleep: c.sleep });
    await Promise.all([get("TMFR1", "5"), get("TMFR1", "15"), get("2330", "D")]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
    expect(starts).toEqual([0, 2_000, 4_000]);
  });

  it("refetches after the TTL", async () => {
    const c = clock();
    const fetch = vi.fn(async () => [BAR]);
    const get = createBarsGate(fetch, { ttlMs: 30_000, minGapMs: 2_000, now: c.now, sleep: c.sleep });
    await get("TMFR1", "5");
    c.advance(29_999);
    await get("TMFR1", "5");
    expect(fetch).toHaveBeenCalledTimes(1);
    c.advance(1);
    await get("TMFR1", "5");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a failed fetch is not cached and does not jam the queue", async () => {
    const c = clock();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue([BAR]);
    const get = createBarsGate(fetch, { ttlMs: 30_000, minGapMs: 2_000, now: c.now, sleep: c.sleep });
    await expect(get("TMFR1", "5")).rejects.toThrow("429");
    await expect(get("TMFR1", "5")).resolves.toEqual([BAR]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
