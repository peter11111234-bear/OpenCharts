/**
 * Shioaji live feed watchdog + price sanity guard.
 *
 * Root-cause findings (2026-09-18 MXFJ6 15:25 corrupt bar O=2460):
 * 1. Server kbars history is CLEAN (633 bars, 0 anomalies) → corruption did
 *    NOT come from history. It entered through the live tick path.
 * 2. Corruption coincided EXACTLY with the shioaji server death window
 *    (last good bar 15:25 → server confirmed dead 15:32). A dying server
 *    emits garbage ticks; the feed painted the first garbage tick as the
 *    new 1m bar's open and it stuck (O=2460, L=2460, later ticks fixed H/C).
 * 3. Defense that was missing (added below):
 *    - price sanity filter: drop ticks >5% away from last close
 *      (futures limit is 10%; 2460 vs 47550 is 94% off — obvious garbage);
 *    - resubscribe watchdog: server restart wipes subscriptions (in-memory),
 *      so EventSource auto-reconnect alone delivers silence; re-POST
 *      subscribe when a stream goes quiet >20s;
 *    - seed lastClose from snapshot at feed start so the guard works
 *      from the first tick.
 */

import { publish } from "../demo/bus.ts";
import { mark } from "../demo/engine.ts";
import {
  getSnapshots,
  openEventSource,
  subscribeQuote,
  tickEventName,
  tickStreamPath,
  type TickEvent,
} from "./server.ts";
import { LIVE_INSTRUMENTS } from "./instruments.ts";

interface BarState {
  bucket: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Max sane per-tick deviation from last close (fraction). Futures ±10% hard limit. */
const MAX_TICK_DEVIATION = 0.05;
/** Re-POST subscribe if a stream is silent longer than this (ms). */
const QUIET_THRESHOLD_MS = 20_000;

const sources: EventSource[] = [];
const bars = new Map<string, BarState>();
const lastClose = new Map<string, number>();
const lastTickAt = new Map<string, number>();
let started = false;
let watchdog: ReturnType<typeof setInterval> | null = null;

function minuteBucket(epochSec: number): number {
  return epochSec - (epochSec % 60);
}

function tickPrice(t: TickEvent): number {
  const v = typeof t.close === "string" ? parseFloat(t.close) : t.close;
  return Number.isFinite(v) ? (v as number) : NaN;
}

function tickEpochSec(t: TickEvent): number {
  // Live tick date comes from the CONTRACT (e.g. MXFJ6 expiry), not the bar —
  // only the wall-clock time is trustworthy. Anchor to today's Taipei date.
  const ms = Date.parse(`${t.date}T${t.time}+08:00`);
  if (Number.isFinite(ms)) {
    const d = new Date(ms);
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    // If the tick's date is more than a day off today, the date field is a
    // contract/expiry date — rebuild with today's date + tick's wall time.
    const dayMs = 86400 * 1000;
    const tickDay = Math.floor((ms + 8 * 3600 * 1000) / dayMs);
    const todayDay = Math.floor((Date.now() + 8 * 3600 * 1000) / dayMs);
    if (Math.abs(tickDay - todayDay) <= 1) return Math.floor(ms / 1000);
    const hh = `${d.getUTCHours()}`.padStart(2, "0");
    const mm = `${d.getUTCMinutes()}`.padStart(2, "0");
    const ss = `${d.getUTCSeconds()}`.padStart(2, "0");
    const y = now.getUTCFullYear();
    const mo = `${now.getUTCMonth() + 1}`.padStart(2, "0");
    const dy = `${now.getUTCDate()}`.padStart(2, "0");
    const fixed = Date.parse(`${y}-${mo}-${dy}T${hh}:${mm}:${ss}+08:00`);
    if (Number.isFinite(fixed)) return Math.floor(fixed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function isSane(symbol: string, price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  const ref = lastClose.get(symbol);
  if (ref === undefined || ref <= 0) return true; // not seeded yet — accept
  return Math.abs(price - ref) / ref <= MAX_TICK_DEVIATION;
}

function handleTick(symbol: string, tickSize: number, t: TickEvent): void {
  const price = tickPrice(t);
  if (!isSane(symbol, price)) {
    console.warn(`[shioaji] dropped insane tick ${symbol} price=${t.close}`);
    return;
  }
  lastClose.set(symbol, price);
  lastTickAt.set(symbol, Date.now());
  const half = tickSize / 2;
  const nowMs = Date.now();

  publish("market-data", {
    eventType: "MarketTick",
    symbol,
    bid: price - half,
    ask: price + half,
    occurredAt: nowMs,
  });
  mark(symbol, price);

  const bucket = minuteBucket(tickEpochSec(t));
  const cur = bars.get(symbol);
  if (!cur || cur.bucket !== bucket) {
    if (cur) publish("market-data", { eventType: "CandleClosed", symbol, timeframe: "1m" });
    bars.set(symbol, { bucket, open: price, high: price, low: price, close: price, volume: t.volume ?? 0 });
  } else {
    cur.high = Math.max(cur.high, price);
    cur.low = Math.min(cur.low, price);
    cur.close = price;
    cur.volume += t.volume ?? 0;
  }
  const bar = bars.get(symbol);
  if (!bar) return;
  publish("market-data", {
    eventType: "CandleUpdate",
    symbol,
    timeframe: "1m",
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    timestamp: bar.bucket,
  });
}

async function subscribeAll(): Promise<void> {
  await Promise.all(
    LIVE_INSTRUMENTS.map((i) =>
      subscribeQuote(i.contract, "Tick").catch((e) => console.error(`[shioaji] subscribe ${i.symbol.name} failed`, e)),
    ),
  );
}

async function seedCloses(): Promise<void> {
  try {
    const snaps = await getSnapshots(LIVE_INSTRUMENTS.map((i) => i.contract));
    for (const s of snaps) {
      if (s && s.close > 0) {
        const inst = LIVE_INSTRUMENTS.find((x) => x.contract.code === s.code);
        if (inst) lastClose.set(inst.symbol.name, s.close);
      }
    }
  } catch (e) {
    console.error("[shioaji] snapshot seed failed", e);
  }
}

function openStreams(): void {
  const byType = new Map<string, { path: string; event: string }>();
  for (const i of LIVE_INSTRUMENTS) {
    if (!byType.has(i.contract.security_type)) {
      byType.set(i.contract.security_type, {
        path: tickStreamPath(i.contract.security_type),
        event: tickEventName(i.contract.security_type),
      });
    }
  }
  for (const [, s] of byType) {
    const es = openEventSource(s.path);
    es.addEventListener(s.event, (e) => {
      try {
        const t = JSON.parse((e as MessageEvent).data) as TickEvent;
        const inst = LIVE_INSTRUMENTS.find((x) => x.contract.code === t.code);
        if (inst) handleTick(inst.symbol.name, inst.symbol.tickSize, t);
      } catch (err) {
        console.error("[shioaji] bad tick event", err);
      }
    });
    es.onerror = () => console.error(`[shioaji] SSE ${s.path} error (auto-retrying)`);
    sources.push(es);
  }
}

/** 關掉 CLOSED (不再自連) 的舊流並重開 — 冪等, 活著的不動. */
function reopenDeadStreams(): void {
  const kept: EventSource[] = [];
  let dropped = 0;
  for (const es of sources.splice(0)) {
    if (es.readyState === EventSource.CLOSED) {
      dropped++;
      try {
        es.close();
      } catch {
        /* already dead */
      }
    } else {
      kept.push(es);
    }
  }
  sources.push(...kept);
  if (dropped > 0) {
    console.warn(`[shioaji] ${dropped} dead SSE stream(s) — reopening`);
    for (const es of sources.splice(0)) {
      try {
        es.close();
      } catch {
        /* already dead */
      }
    }
    openStreams();
  }
}

function ensureWatchdog(): void {
  if (watchdog) return;
  // Watchdog: server restarts wipe subscriptions; silence means resubscribe.
  watchdog = setInterval(() => {
    try {
      reopenDeadStreams();
    } catch (err) {
      console.error("[shioaji] reopen streams failed", err);
    }
    const quiet = LIVE_INSTRUMENTS.filter((i) => Date.now() - (lastTickAt.get(i.symbol.name) ?? 0) > QUIET_THRESHOLD_MS);
    if (quiet.length > 0) {
      console.warn(`[shioaji] quiet streams: ${quiet.map((i) => i.symbol.name).join(",")} — resubscribing`);
      void subscribeAll();
    }
  }, 10_000);
}

/** Console 逃生口: 卡住時在 DevTools 跑 `await __shioajiResubscribe()` 即重訂+重連. */
function exposeResubscribe(): void {
  try {
    (window as unknown as Record<string, unknown>).__shioajiResubscribe = () => {
      try {
        reopenDeadStreams();
      } catch (err) {
        console.error("[shioaji] reopen streams failed", err);
      }
      return subscribeAll();
    };
  } catch {
    /* non-browser (SSR/test) */
  }
}

export async function startShioajiFeed(): Promise<void> {
  if (started) return;
  started = true;

  try {
    await seedCloses();
    await subscribeAll();
    openStreams();
  } finally {
    // 保證 watchdog 一定建成: 之前中途拋錯會留下 started=true + 無 watchdog,
    // 後續 subscribe() 直接 return → 永久靜默 (2026-10-16 MXFJ6 事故).
    ensureWatchdog();
  }
  exposeResubscribe();
}

export function stopShioajiFeed(): void {
  for (const es of sources.splice(0)) es.close();
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  bars.clear();
  try {
    delete (window as unknown as Record<string, unknown>).__shioajiResubscribe;
  } catch {
    /* non-browser */
  }
  started = false;
}
