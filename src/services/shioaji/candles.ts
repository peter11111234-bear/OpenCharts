import type { Candle } from "../schemas.ts";
import { getKbars } from "./server.ts";
import { getTwInstrument } from "./instruments.ts";

/**
 * History for Taiwan symbols via shioaji server kbars (1m bars).
 *
 * - Server returns naive Taipei wall-clock datetimes ("2026-09-18T09:01:00");
 *   we interpret them as UTC+8 → epoch seconds. Real timestamps, no shifting.
 * - kbars only serves 1m; every other timeframe is resampled locally.
 * - 1d buckets break at Taipei midnight; 1w buckets start Monday (Taipei).
 */

const TF_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;

/** "2026-09-18T09:01:00" (Taipei wall clock) → epoch seconds. */
export function taipeiToEpochSec(local: string): number {
  return Math.floor(Date.parse(`${local}+08:00`) / 1000);
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfTaipeiDay(epochSec: number): number {
  const taipei = new Date(epochSec * 1000 + TAIPEI_OFFSET_MS);
  taipei.setUTCHours(0, 0, 0, 0);
  return Math.floor(taipei.getTime() / 1000) - 8 * 3600;
}

function startOfTaipeiWeek(epochSec: number): number {
  const dayStart = startOfTaipeiDay(epochSec);
  // getUTCDay of the shifted date: 0=Sun..6=Sat → Monday-based offset
  const dow = new Date(dayStart * 1000 + TAIPEI_OFFSET_MS).getUTCDay();
  const back = (dow + 6) % 7;
  return dayStart - back * 86400;
}

export function bucketStart(timeframe: string, epochSec: number): number {
  if (timeframe === "1d") return startOfTaipeiDay(epochSec);
  if (timeframe === "1w") return startOfTaipeiWeek(epochSec);
  const interval = TF_SECONDS[timeframe] ?? 60;
  return epochSec - (epochSec % interval);
}

function resample(bars: Candle[], timeframe: string): Candle[] {
  if (timeframe === "1m" || bars.length === 0) return bars;
  const buckets = new Map<number, Candle>();
  for (const b of bars) {
    const key = bucketStart(timeframe, b.time);
    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, { ...b, time: key });
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}


export interface HistoryRange {
  fromMs: number;
  toMs: number;
}

export async function getShioajiHistory(
  symbol: string,
  timeframe: string,
  limit?: number,
  range?: HistoryRange,
): Promise<Candle[]> {
  const inst = getTwInstrument(symbol);
  if (!inst) return [];
  const want = limit && limit > 0 ? limit : 500;

  let start: Date;
  let end: Date;
  if (range && range.toMs > range.fromMs) {
    // Load-more window: pad one extra day so boundary bars resample correctly.
    end = new Date(range.toMs);
    start = new Date(Math.min(range.fromMs - 86400 * 1000, range.toMs));
    // Clamp to 90 days per request (server-side practical cap).
    if (end.getTime() - start.getTime() > 90 * 86400 * 1000) {
      start = new Date(end.getTime() - 90 * 86400 * 1000);
    }
  } else {
    // 預設初始載入：近 30 天 1m（約一個月看盤），server 實測一次可回
    // 2330 約 6.3k 根 / 期貨約 30k 根，單次請求約 1–5 秒。
    end = new Date();
    start = new Date(end.getTime() - 29 * 86400 * 1000);
  }
  const res = await getKbars(inst.contract, toDateStr(start), toDateStr(end));

  const n = res.datetime.length;
  const bars: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const dt = res.datetime[i];
    if (dt === undefined) continue;
    bars.push({
      time: taipeiToEpochSec(dt),
      open: res.Open[i] ?? 0,
      high: res.High[i] ?? 0,
      low: res.Low[i] ?? 0,
      close: res.Close[i] ?? 0,
      volume: res.Volume[i] ?? 0,
    });
  }
  bars.sort((a, b) => a.time - b.time);
  const out = resample(bars, timeframe);
  if (range && range.toMs > range.fromMs) {
    const fromSec = Math.floor(range.fromMs / 1000);
    const toSec = Math.floor(range.toMs / 1000);
    return out.filter((b) => b.time >= fromSec && b.time <= toSec);
  }
  return out.length > want ? out.slice(-want) : out;
}
