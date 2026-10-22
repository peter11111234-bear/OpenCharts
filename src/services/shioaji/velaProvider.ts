/**
 * Vela DataProvider adapter for the local shioaji server.
 *
 * Wiring:
 * - History: getShioajiHistory() (POST /shioaji/api/v1/data/kbars, 1m bars
 *   resampled locally — the same path TradingPage uses).
 * - Live: demo bus "market-data" CandleUpdate events published by feed.ts.
 *   feed.ts only runs after wsClient.connect(), so the provider kicks it on
 *   first subscription (idempotent — safe on TradingPage too).
 * - Calendar: TSE 09:00–13:30 / TAIFEX 08:45–13:45 (regular) 15:00–05:00
 *   (extended), weekdays minus TWSE holiday list (public/twse-holidays-*.json).
 *
 * Unit conversions vs OpenCharts internals:
 * - Vela wants bar `time` in epoch MS; our Candle.time is epoch SECONDS.
 * - Vela timeframes are canonical strings ('5', '60', 'D', 'W'); ours are
 *   '5m'/'1h'/'1d' — normalizeTimeframe() maps between them.
 */
import type { BarRange, DataProvider, OHLCV, ProviderInfo, SymbolDescriptor, SymbolInfo } from "@luxalgo/vela";
import { bucketStart, getShioajiHistory } from "./candles.ts";
import { TW_INSTRUMENTS, getTwInstrument } from "./instruments.ts";
import { fetchIndexEntries, taipeiDate } from "./marketData.ts";
import { startShioajiFeed } from "./feed.ts";
import { subscribeChannel } from "../demo/bus.ts";
import { wsClient } from "../ws.ts";
const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;

type LocalBar = { time: number; open: number; high: number; low: number; close: number; volume: number };

/** 1m bars recorded locally, resampled to `tf` (time in epoch s): history built from
 *  TAIFEX daily files (public/local-bars/hist/<CODE>.json, scripts/taifex-local-bars.py)
 *  merged with the live recorder's public/local-bars/<CODE>.json (recorder wins on overlap). */
export async function localRecordedBars(
  name: string,
  tf: string,
  fromMs: number,
  toMs: number,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalBar[]> {
  if (!name || tf === "1d" || tf === "1w") return [];
  const load = async (path: string): Promise<LocalBar[]> => {
    try {
      const res = await fetchImpl(`/local-bars/${path}${encodeURIComponent(name)}.json`, { cache: "no-store" });
      return res.ok ? ((await res.json()) as LocalBar[]) : [];
    } catch {
      return [];
    }
  };
  const byMinute = new Map<number, LocalBar>();
  for (const part of await Promise.all([load("hist/"), load("")])) for (const b of part) byMinute.set(b.time, b);
  const out = new Map<number, LocalBar>();
  for (const b of [...byMinute.values()].sort((a, b) => a.time - b.time)) {
    if (b.time * 1000 < fromMs || b.time * 1000 > toMs || !(b.low > 0)) continue;
    const key = bucketStart(tf, b.time);
    const cur = out.get(key);
    if (!cur) out.set(key, { ...b, time: key });
    else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  return [...out.values()].sort((a, b) => a.time - b.time).slice(-limit);
}

/** listSymbols only needs the component codes, but index_components returns every stock's
 *  live quote too (~730 KB of quota for TSE+OTC). Codes change at most daily: keep one
 *  list per Taipei day, and only a complete one (both exchanges answered). */
const COMPONENT_CODES_KEY = "opencharts.componentCodes.v1";
type ComponentCode = { code: string; exchange: string };

async function componentCodes(): Promise<ComponentCode[]> {
  const today = taipeiDate(new Date());
  try {
    const c = JSON.parse(localStorage.getItem(COMPONENT_CODES_KEY) ?? "null") as { date?: string; codes?: ComponentCode[] } | null;
    if (c?.date === today && Array.isArray(c.codes) && c.codes.length > 0) return c.codes;
  } catch {
    /* no storage (private window / tests): just fetch */
  }
  const lists = await Promise.all([fetchIndexEntries(undefined, "TSE"), fetchIndexEntries(undefined, "OTC")]).catch(
    () => [] as ComponentCode[][],
  );
  const codes = lists.flat().map((e) => ({ code: e.code, exchange: e.exchange }));
  if (lists.length === 2 && lists.every((l) => l.length > 0)) {
    try {
      localStorage.setItem(COMPONENT_CODES_KEY, JSON.stringify({ date: today, codes }));
    } catch {
      /* storage full / blocked: next load fetches again */
    }
  }
  return codes;
}

/** Vela canonical → our timeframe key. */
/** Live bars reach Vela at most this often: every onBar re-renders and re-runs
 *  each Pine indicator, and raw tick rate is what froze /vela on 2026-10-07. */
export const LIVE_BAR_THROTTLE_MS = 1000;

/** Coalesce live bars to one onBar per `ms` (latest wins). A bar with a new
 *  time flushes the pending one first, so a closing bar's final value is kept. */
export function throttleBars(onBar: (bar: OHLCV) => void, ms: number) {
  let pending: OHLCV | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const bar = pending;
    pending = undefined;
    if (bar) onBar(bar);
  };
  return {
    push(bar: OHLCV) {
      if (pending && pending.time !== bar.time) flush();
      pending = bar;
      timer ??= setTimeout(flush, ms);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}

export function normalizeTimeframe(tf: string): string {
  if (tf === "D" || tf === "1d") return "1d";
  if (tf === "W" || tf === "1w") return "1w";
  const m = /^(\d+)([mM]?)$/.exec(tf);
  if (m) {
    const n = Number(m[1]);
    if (n === 60) return "1h";
    if (n === 240) return "4h";
    if (n > 0) return `${n}m`;
  }
  const h = /^(\d+)h$/.exec(tf);
  if (h) return `${Number(h[1])}h`;
  return tf;
}


// ── Holiday list (fetched from /twse-holidays-{year}.json, cached) ──
const holidayCache = new Map<number, Promise<Set<string>>>();
function holidays(year: number): Promise<Set<string>> {
  let p = holidayCache.get(year);
  if (!p) {
    p = fetch(`/twse-holidays-${year}.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: string[]) => new Set(list))
      .catch(() => new Set<string>());
    holidayCache.set(year, p);
  }
  return p;
}

function taipeiDateStr(epochMs: number): string {
  // Shift to Taipei wall clock, then take its UTC date fields.
  const d = new Date(epochMs + TAIPEI_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function taipeiDayStartMs(epochMs: number): number {
  const s = taipeiDateStr(epochMs);
  // Parse the Taipei-date back to a real epoch ms (midnight in +08:00).
  return Date.parse(`${s}T00:00:00+08:00`);
}

interface CandleUpdateEvent {
  eventType: string;
  symbol?: string;
  timeframe?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  /** feed.ts emits bar open-time in epoch SECONDS. */
  timestamp?: number;
}

export class ShioajiVelaProvider implements DataProvider {
  info(): ProviderInfo {
    return {
      name: "shioaji",
      displayName: "SinoPac Shioaji",
      supportedTimeframes: ["1", "5", "15", "30", "60", "240", "D", "W"],
      capabilities: { enumerate: true, stream: true, symbolInfo: true },
    };
  }

  /**
   * Vela resolves `TSE:3037` / `OTC:3081` against this index — a stock missing
   * here never loads (the chart spins forever), so besides the hand-listed
   * instruments it indexes every TAIEX and TPEx component (heatmap / hotlist
   * picks). If the server is down, the hand-listed ones still resolve.
   */
  async listSymbols(): Promise<SymbolDescriptor[]> {
    const listed: SymbolDescriptor[] = TW_INSTRUMENTS.map((i) => ({
      ticker: i.symbol.name,
      description: i.symbol.displayName ?? undefined,
      type: i.contract.security_type === "FUT" ? "futures" : "stock",
      prefix: i.contract.exchange, // TSE / OTC / TAIFEX = listing-venue prefix
    }));
    const seen = new Set(listed.map((d) => d.ticker));
    for (const e of await componentCodes()) {
      if (seen.has(e.code)) continue;
      seen.add(e.code);
      listed.push({ ticker: e.code, type: "stock", prefix: e.exchange });
    }
    return listed;
  }

  async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
    const name = this.toInstrumentName(ticker);
    const inst = getTwInstrument(name);
    if (inst) {
      return {
        ticker: inst.symbol.name,
        description: inst.symbol.displayName,
        mintick: inst.symbol.tickSize,
        timezone: "Asia/Taipei",
        currency: "TWD",
        exchange: inst.contract.exchange,
        type: inst.contract.security_type === "FUT" ? "futures" : "stock",
      };
    }
    // 任意代碼 fallback — 不在 TW_INSTRUMENTS 的台股/期貨。exchange 從前綴或代碼形狀推。
    const exchange = this.inferExchange(ticker);
    const isFut = exchange === "TAIFEX";
    return {
      ticker: name,
      description: name,
      mintick: isFut ? 1 : 0.01, // 股票預設 0.01；實際 tickSize 以交易所為準
      timezone: "Asia/Taipei",
      currency: "TWD",
      exchange,
      type: isFut ? "futures" : "stock",
    };
  }

  async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    const name = this.toInstrumentName(ticker);
    const tf = normalizeTimeframe(timeframe);
    // Honor Vela's requested window (it asks for roughly what fills the
    // viewport). The old `Math.max(limit, 2000)` floor was added while
    // chasing a phantom "missing drawings" cause and made every first paint
    // evaluate 2000+ bars (~16ms/bar → 30s+). Drawings/history needs are met
    // by the window Vela asks for; older bars load on demand.
    const fromMs = range.from ?? Date.now() - 29 * 86400 * 1000;
    const toMs = range.to ?? Date.now();
    let candles = await getShioajiHistory(name, tf, range.limit ?? 300, { fromMs, toMs });
    // Shioaji returns nothing once the daily 500MB quota is spent: fall back to
    // the 1m bars scripts/fop-tick-recorder.py builds from the live tick stream.
    if (candles.length === 0) candles = await localRecordedBars(name, tf, fromMs, toMs, range.limit ?? 300);
    return candles.map((c) => ({
      time: c.time * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    const name = this.toInstrumentName(ticker);
    const tf = normalizeTimeframe(timeframe);

    // Start both the wsClient and the real Shioaji SSE feed. Both are idempotent.
    wsClient.connect();
    void startShioajiFeed();
    let agg: OHLCV | undefined;
    // CandleUpdate carries the RUNNING total of the current 1m bar, so the
    // multi-tf aggregate adds only the delta between updates. Baseline resets
    // each time the 1m bucket rolls (detected via timestamp change).
    let last1mStart = -1;
    let prev1mVol = 0;
    const out = throttleBars(onBar, LIVE_BAR_THROTTLE_MS);

    const unsub = subscribeChannel("market-data", (raw) => {
      const ev = raw as CandleUpdateEvent;
      if (ev.eventType !== "CandleUpdate" || ev.symbol !== name || ev.timestamp === undefined) return;
      if (ev.open === undefined || ev.high === undefined || ev.low === undefined || ev.close === undefined) return;

      if (tf === "1m") {
        out.push({ time: ev.timestamp * 1000, open: ev.open, high: ev.high, low: ev.low, close: ev.close, volume: ev.volume });
        return;
      }
      // Aggregate 1m → target timeframe using the same bucket math as resample().
      const volDelta = ev.timestamp === last1mStart ? Math.max(0, (ev.volume ?? 0) - prev1mVol) : (ev.volume ?? 0);
      last1mStart = ev.timestamp;
      prev1mVol = ev.volume ?? 0;

      const startSec = bucketStart(tf, ev.timestamp);
      if (!agg || agg.time !== startSec * 1000) {
        agg = { time: startSec * 1000, open: ev.open, high: ev.high, low: ev.low, close: ev.close, volume: volDelta };
      } else {
        agg.high = Math.max(agg.high, ev.high);
        agg.low = Math.min(agg.low, ev.low);
        agg.close = ev.close;
        agg.volume = (agg.volume ?? 0) + volDelta;
      }
      out.push({ ...agg });
    });

    return () => {
      unsub();
      out.cancel();
      agg = undefined;
    };
  }

  async getCalendar(
    ticker: string,
    range: { from: number; to: number; session?: string },
  ): Promise<ReadonlyArray<readonly [number, number]>> {
    const inst = getTwInstrument(this.toInstrumentName(ticker));
    const isFut = inst?.contract.security_type === "FUT";
    const extended = range.session === "extended";

    // Regular session windows (Taipei wall-clock hour/min → minutes).
    const sessionOpenMin = isFut ? 8 * 60 + 45 : 9 * 60;
    const sessionCloseMin = isFut ? 13 * 60 + 45 : 13 * 60 + 30;

    const windows: Array<readonly [number, number]> = [];
    let dayStart = taipeiDayStartMs(range.from);
    while (dayStart < range.to) {
      const dateStr = taipeiDateStr(dayStart);
      const dow = new Date(dayStart + TAIPEI_OFFSET_MS).getUTCDay();
      const weekday = dow >= 1 && dow <= 5;
      const holidaySet = await holidays(Number(dateStr.slice(0, 4)));
      if (weekday && !holidaySet.has(dateStr)) {
        const open = dayStart + sessionOpenMin * 60_000;
        const close = dayStart + sessionCloseMin * 60_000;
        windows.push([Math.max(open, range.from), Math.min(close, range.to)]);
        if (extended && isFut) {
          // TAIFEX night session 15:00–next-day 05:00 (regular+night = full tape).
          const nightOpen = dayStart + 15 * 60 * 60_000;
          const nightClose = dayStart + 86400_000 + 5 * 60 * 60_000;
          windows.push([Math.max(nightOpen, range.from), Math.min(nightClose, range.to)]);
        }
      }
      dayStart += 86400_000;
    }
    return windows.filter(([s, e]) => e > s);
  }

  /**
   * Strip venue prefix ('TSE:') and any '.ext' suffix — Vela keeps them opaque
   * but our instrument map / shioaji contract codes don't.
   */
  private toInstrumentName(ticker: string): string {
    const colon = ticker.indexOf(":");
    const bare = colon >= 0 ? ticker.slice(colon + 1) : ticker;
    const dot = bare.indexOf(".");
    return dot >= 0 ? bare.slice(0, dot) : bare;
  }

  /** Infer exchange/type from the prefix ('TSE:'|'OTC:'|'TAIFEX:') or bare code shape. */
  private inferExchange(ticker: string): "TSE" | "OTC" | "TAIFEX" {
    if (ticker.startsWith("OTC:")) return "OTC";
    if (ticker.startsWith("TAIFEX:")) return "TAIFEX";
    if (ticker.startsWith("TSE:")) return "TSE";
    const name = this.toInstrumentName(ticker);
    return /^[A-Z]{3,}/.test(name) ? "TAIFEX" : "TSE"; // alpha-only => futures root, else stock
  }
}
