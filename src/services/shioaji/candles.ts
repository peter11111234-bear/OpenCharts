import type { Candle } from "../schemas.ts";
import { getKbars, type KbarsResponse } from "./server.ts";
import { getTwInstrument } from "./instruments.ts";
import { toContractRef } from "./marketData.ts";

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

/**
 * Shioaji kbars stamp a 1m bar with the minute's END (09:00–09:01 trades → "09:01:00"),
 * while live bars and local recordings stamp the START (TradingView convention).
 * Verified 2026-10-22 against tick data and TAIFEX per-trade files (see
 * docs/superpowers/plans/2026-10-22-pending-work.md E3). Shift back one minute.
 * Exception: the TW stock closing auction (13:30:00 exactly) is already start-stamped.
 */
export function kbarStartSec(local: string, securityType: string): number {
  const sec = taipeiToEpochSec(local);
  if (securityType === "STK" && local.slice(11, 19) === "13:30:00") return sec;
  return sec - 60;
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

/**
 * In-flight dedup for identical kbars requests. request.security prefetch fans
 * out one fetchSeries per TIMEFRAME (1m/15m/60m), but every timeframe resolves
 * to the same server call — only the local resample differs. Three concurrent
 * identical POSTs were the dominant chunk of a ~20s indicator run. Same-shape
 * in-flight requests share the promise; a tiny TTL cache absorbs the immediate
 * re-request after a run completes (the kbars payload for the same window
 * can't change inside that window — the server's data is minute-bucketed).
 */
const KBARS_TTL_MS = 15_000;
const kbarsInflight = new Map<string, Promise<KbarsResponse>>();
const kbarsCache = new Map<string, { at: number; res: KbarsResponse }>();

/**
 * Derived-data memo keyed by kbars RESPONSE IDENTITY. The 15 s cache above hands
 * the very same response object to every timeframe of one window, but each call
 * used to re-parse ~30k rows (futures) and re-sort them, then resample — eight
 * times for a request.security script with eight timeframes. WeakMaps keep the
 * memo alive exactly as long as the response, so it expires with the TTL; there
 * is no second expiry to tune.
 */
interface ParsedKbars {
  securityType: string;
  oneMin: Candle[];
}
const parsedKbars = new WeakMap<KbarsResponse, ParsedKbars>();
const resampledKbars = new WeakMap<KbarsResponse, Map<string, Candle[]>>();

// Test-only counter: how many payloads have been row-parsed (memo-hit proof).
let parsedPayloads = 0;
export function kbarsParseCount(): number {
  return parsedPayloads;
}

/** Parallel arrays → sorted 1m Candle[]. Drops malformed rows (see below). */
function parseOneMin(res: KbarsResponse, securityType: string): Candle[] {
  parsedPayloads++;
  const n = res.datetime.length;
  const bars: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const dt = res.datetime[i];
    if (dt === undefined) continue;
    const open = res.Open[i], high = res.High[i], low = res.Low[i], close = res.Close[i];
    // A row whose parallel arrays are short/null is a MALFORMED row, not a bar priced
    // at 0: the old `?? 0` filled 0 and Vela's price autoscale then folded a real 0
    // into the visible range, flattening the whole chart. Drop the row instead.
    if (open == null || high == null || low == null || close == null) continue;
    if (![open, high, low, close].every(Number.isFinite)) continue;
    // The timestamp comes off an unvalidated `res.json()` too: an unparsable one
    // yields NaN, which survives the sort and reaches Vela as a bar with no time.
    const time = kbarStartSec(dt, securityType);
    if (!Number.isFinite(time)) continue;
    const volume = res.Volume[i];
    bars.push({
      time,
      open,
      high,
      low,
      close,
      volume: typeof volume === 'number' && Number.isFinite(volume) ? volume : 0,
    });
  }
  bars.sort((a, b) => a.time - b.time);
  return bars;
}

async function getKbarsDedup(contract: Parameters<typeof getKbars>[0], start: string, end: string): Promise<KbarsResponse> {
  const key = JSON.stringify([contract, start, end]);
  const hit = kbarsCache.get(key);
  if (hit && Date.now() - hit.at < KBARS_TTL_MS) return hit.res;
  let p = kbarsInflight.get(key);
  if (!p) {
    p = getKbars(contract, start, end);
    kbarsInflight.set(key, p);
    p.then(
      (res) => { kbarsInflight.delete(key); kbarsCache.set(key, { at: Date.now(), res }); },
      () => { kbarsInflight.delete(key); },
    );
  }
  return p;
}

export async function getShioajiHistory(
  symbol: string,
  timeframe: string,
  limit?: number,
  range?: HistoryRange,
): Promise<Candle[]> {
  // Not in the hand-listed TW_INSTRUMENTS (e.g. a heatmap/hotlist pick)? Derive
  // the contract from the code itself — the server ignores TSE vs OTC for STK kbars.
  const contract = getTwInstrument(symbol)?.contract ?? toContractRef(symbol);
  if (!contract) return [];
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
  const res = await getKbarsDedup(contract, toDateStr(start), toDateStr(end));

  // Parse once per payload. security_type feeds kbarStartSec, so a payload seen
  // under a different contract type is re-parsed (and its resamples dropped).
  const cachedParse = parsedKbars.get(res);
  let oneMin: Candle[];
  if (cachedParse && cachedParse.securityType === contract.security_type) {
    oneMin = cachedParse.oneMin;
  } else {
    oneMin = parseOneMin(res, contract.security_type);
    parsedKbars.set(res, { securityType: contract.security_type, oneMin });
    resampledKbars.delete(res);
  }

  // Resample once per (payload, timeframe).
  let byTimeframe = resampledKbars.get(res);
  if (!byTimeframe) {
    byTimeframe = new Map<string, Candle[]>();
    resampledKbars.set(res, byTimeframe);
  }
  let out = byTimeframe.get(timeframe);
  if (!out) {
    out = resample(oneMin, timeframe);
    byTimeframe.set(timeframe, out);
  }

  // Cached arrays/objects must never escape: callers own what they receive, and
  // for "1m" `out` IS the cached oneMin array. Copy the (≤ want) result.
  if (range && range.toMs > range.fromMs) {
    const fromSec = Math.floor(range.fromMs / 1000);
    const toSec = Math.floor(range.toMs / 1000);
    const win = out.filter((b) => b.time >= fromSec && b.time <= toSec);
    // The window branch used to return EVERY bar in [from,to] — a Vela-supplied
    // window (e.g. "since session open") then bypassed `want` entirely and the
    // engine evaluated thousands of bars per first paint. Cap to `want` (tail =
    // newest) exactly like the non-window branch.
    const tail = win.length > want ? win.slice(-want) : win;
    return tail.map((c) => ({ ...c }));
  }
  const tail = out.length > want ? out.slice(-want) : out;
  return tail.map((c) => ({ ...c }));
}
