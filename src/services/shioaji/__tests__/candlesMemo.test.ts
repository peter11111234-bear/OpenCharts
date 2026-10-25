import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../../schemas.ts";
import { getShioajiHistory, kbarsParseCount } from "../candles.ts";

const getKbars = vi.fn();
vi.mock("../server.ts", () => ({ getKbars: (...a: unknown[]) => getKbars(...a) }));

/**
 * L5: one kbars payload must be row-parsed once and resampled once per
 * timeframe, while the returned bars stay exactly what the old code produced.
 *
 * The oracle below is an independent re-implementation of the documented
 * semantics (open=first, high=max, low=min, close=last, volume=sum, Taipei
 * day/week buckets, kbars END-stamped minute minus one, STK 13:30:00 already
 * start-stamped) — it never calls into candles.ts internals.
 */

interface Res {
  datetime: (string | null)[];
  Open: (number | null)[];
  High: (number | null)[];
  Low: (number | null)[];
  Close: (number | null)[];
  Volume: (number | null)[];
}

const TPE_OFFSET_MS = 8 * 3600 * 1000;
const START_SEC = Date.UTC(2026, 8, 14, 1, 0, 0) / 1000; // 2026-09-14 09:00 Taipei

const INTERVALS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

function localStamp(epochSec: number): string {
  const d = new Date(epochSec * 1000 + TPE_OFFSET_MS);
  const p = (n: number) => `${n}`.padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** Deterministic 1m payload: `count` consecutive minutes plus deliberately broken rows. */
function synthetic(count = 1800, startSec = START_SEC): Res {
  const res: Res = { datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [] };
  for (let i = 0; i < count; i++) {
    res.datetime.push(localStamp(startSec + i * 60));
    const base = 100 + (i % 37);
    res.Open.push(base);
    res.High.push(base + 2);
    res.Low.push(base - 2);
    res.Close.push(base + 1);
    res.Volume.push(i % 5 === 0 ? null : 10 + (i % 5));
  }
  // Malformed rows the parser must drop, exactly like before:
  // null close, non-finite price, unparsable datetime.
  res.datetime.push(localStamp(startSec + count * 60));
  res.Open.push(101);
  res.High.push(102);
  res.Low.push(100);
  res.Close.push(null);
  res.Volume.push(7);
  res.datetime.push(localStamp(startSec + (count + 1) * 60));
  res.Open.push(Number.POSITIVE_INFINITY);
  res.High.push(102);
  res.Low.push(100);
  res.Close.push(101);
  res.Volume.push(7);
  res.datetime.push("not-a-date");
  res.Open.push(101);
  res.High.push(102);
  res.Low.push(100);
  res.Close.push(101);
  res.Volume.push(7);
  return res;
}

function taipeiDayStart(epochSec: number): number {
  const d = new Date(epochSec * 1000 + TPE_OFFSET_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() / 1000 - TPE_OFFSET_MS / 1000;
}

function taipeiWeekStart(epochSec: number): number {
  const day = taipeiDayStart(epochSec);
  const dow = new Date(day * 1000 + TPE_OFFSET_MS).getUTCDay();
  return day - ((dow + 6) % 7) * 86400;
}

function bucket(tf: string, epochSec: number): number {
  if (tf === "1d") return taipeiDayStart(epochSec);
  if (tf === "1w") return taipeiWeekStart(epochSec);
  const interval = INTERVALS[tf] ?? 60;
  return epochSec - (epochSec % interval);
}

function oracle(
  res: Res,
  securityType: string,
  tf: string,
  limit?: number,
  range?: { fromMs: number; toMs: number },
): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < res.datetime.length; i++) {
    const dt = res.datetime[i];
    if (dt === undefined || dt === null) continue;
    const open = res.Open[i];
    const high = res.High[i];
    const low = res.Low[i];
    const close = res.Close[i];
    if (open == null || high == null || low == null || close == null) continue;
    if (![open, high, low, close].every(Number.isFinite)) continue;
    let time = Math.floor(Date.parse(`${dt}+08:00`) / 1000);
    if (!Number.isFinite(time)) continue;
    if (!(securityType === "STK" && dt.slice(11, 19) === "13:30:00")) time -= 60;
    const vol = res.Volume[i];
    bars.push({
      time,
      open,
      high,
      low,
      close,
      volume: typeof vol === "number" && Number.isFinite(vol) ? vol : 0,
    });
  }
  bars.sort((a, b) => a.time - b.time);

  let out: Candle[];
  if (tf === "1m" || bars.length === 0) {
    out = bars;
  } else {
    const buckets = new Map<number, Candle>();
    for (const b of bars) {
      const key = bucket(tf, b.time);
      const cur = buckets.get(key);
      if (!cur) buckets.set(key, { ...b, time: key });
      else {
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += b.volume;
      }
    }
    out = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  }

  const want = limit && limit > 0 ? limit : 500;
  if (range && range.toMs > range.fromMs) {
    const fromSec = Math.floor(range.fromMs / 1000);
    const toSec = Math.floor(range.toMs / 1000);
    const win = out.filter((b) => b.time >= fromSec && b.time <= toSec);
    return win.length > want ? win.slice(-want) : win;
  }
  return out.length > want ? out.slice(-want) : out;
}

let current: Res;

beforeEach(() => {
  current = synthetic();
  getKbars.mockReset().mockImplementation(() => Promise.resolve(current));
});

afterEach(() => {
  vi.useRealTimers();
});

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d"];

describe("getShioajiHistory kbars memo", () => {
  it("matches the reference implementation with and without a window", async () => {
    const range = { fromMs: (START_SEC + 600 * 60) * 1000, toMs: (START_SEC + 1200 * 60) * 1000 };
    for (const tf of TIMEFRAMES) {
      const full = await getShioajiHistory("2330", tf, 100);
      expect(full).toEqual(oracle(current, "STK", tf, 100));

      const win = await getShioajiHistory("2330", tf, 40, range);
      expect(win).toEqual(oracle(current, "STK", tf, 40, range));
    }
  });

  it("row-parses one payload once for five timeframes", async () => {
    const before = kbarsParseCount();
    for (const tf of TIMEFRAMES) await getShioajiHistory("2317", tf, 50);
    expect(kbarsParseCount() - before).toBe(1);
  });

  it("never hands out cached objects", async () => {
    const first = await getShioajiHistory("3081", "5m", 30);
    expect(first.length).toBeGreaterThan(0);
    first[0]!.close = -1;
    first[0]!.volume = -1;
    first.push({ time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 });

    const second = await getShioajiHistory("3081", "5m", 30);
    expect(second).toEqual(oracle(current, "STK", "5m", 30));
    expect(second[0]).not.toBe(first[0]);
  });

  it("re-parses once the 15 s TTL expires and a new payload arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T02:00:00Z"));
    const range = { fromMs: (START_SEC + 300 * 60) * 1000, toMs: (START_SEC + 900 * 60) * 1000 };

    const start = kbarsParseCount();
    await getShioajiHistory("1101", "5m", 50, range);
    expect(kbarsParseCount() - start).toBe(1);

    // Same cached response object: no re-parse, no new fetch.
    await getShioajiHistory("1101", "5m", 50, range);
    expect(kbarsParseCount() - start).toBe(1);

    // TTL expired → new payload object → parse again, results follow the new data.
    current = synthetic(120, START_SEC + 300 * 60);
    vi.setSystemTime(new Date(Date.now() + 16_000));
    const refetched = await getShioajiHistory("1101", "5m", 50, range);
    expect(kbarsParseCount() - start).toBe(2);
    expect(refetched).toEqual(oracle(current, "STK", "5m", 50, range));
  });
});
