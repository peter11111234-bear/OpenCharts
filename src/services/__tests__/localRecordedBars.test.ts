import { describe, expect, it } from "vitest";
import { localRecordedBars } from "../shioaji/velaProvider.ts";

const bars = [
  { time: 1792566000, open: 10, high: 12, low: 9, close: 11, volume: 2 }, // 15:00
  { time: 1792566060, open: 11, high: 15, low: 11, close: 14, volume: 3 }, // 15:01
  { time: 1792566300, open: 14, high: 14, low: 8, close: 9, volume: 1 }, // 15:05
];
const fake = (async () => new Response(JSON.stringify(bars))) as unknown as typeof fetch;

describe("localRecordedBars", () => {
  it("resamples recorded 1m bars into the requested timeframe", async () => {
    const out = await localRecordedBars("TMFK6", "5m", 0, Date.now(), 300, fake);
    expect(out).toEqual([
      { time: 1792566000, open: 10, high: 15, low: 9, close: 14, volume: 5 },
      { time: 1792566300, open: 14, high: 14, low: 8, close: 9, volume: 1 },
    ]);
  });

  it("honors the requested window and limit", async () => {
    expect(await localRecordedBars("TMFK6", "1m", 1792566060_000, Date.now(), 1, fake)).toEqual([bars[2]]);
  });

  it("returns [] when nothing is recorded or for daily bars", async () => {
    const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await localRecordedBars("TMFK6", "1m", 0, Date.now(), 300, missing)).toEqual([]);
    expect(await localRecordedBars("TMFK6", "1d", 0, Date.now(), 300, fake)).toEqual([]);
  });

  it("merges TAIFEX history with the recorder file, recorder winning on overlap", async () => {
    const hist = [bars[0], { ...bars[1], close: 99 }];
    const live = [bars[1], bars[2]];
    const split = (async (url: string) =>
      new Response(JSON.stringify(String(url).includes("/hist/") ? hist : live))) as unknown as typeof fetch;
    expect(await localRecordedBars("TMFK6", "1m", 0, Date.now(), 300, split)).toEqual(bars);
  });
});
