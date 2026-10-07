import type { Candle, Symbol } from "../schemas.ts";
import { demoApi } from "../demo/api.ts";
import { getSnapshots } from "./server.ts";
import { getShioajiHistory, type HistoryRange } from "./candles.ts";
import {
  cancelLiveOrder,
  getLiveOrders,
  getOrderMode,
  modifyLiveOrder,
  placeLiveOrder,
} from "./orders.ts";
import { getTwInstrument, TW_SYMBOLS } from "./instruments.ts";

/**
 * Market-data half of the api surface, backed by the local shioaji server.
 * Trading/account/journal/drawings methods are inherited from the demo layer
 * (paper engine + localStorage), so only the five methods below override it.
 */

const candlesMeta = (candles: Candle[]) => ({
  candles,
  metadata: { isPartial: false, backfillQueued: false, historicalCoverageStart: null },
});

export const shioajiApi = {
  // ── Symbols & market data (real) ──
  getSymbols: (): Promise<Symbol[]> => Promise.resolve(TW_SYMBOLS),

  getCandles: (symbol: string, timeframe: string, limit?: number, range?: HistoryRange) =>
    getShioajiHistory(symbol, timeframe, limit, range),

  getCandlesWithMeta: (symbol: string, timeframe: string, limit?: number, range?: HistoryRange) =>
    getShioajiHistory(symbol, timeframe, limit, range).then(candlesMeta),

  getTick: async (symbol: string) => {
    const inst = getTwInstrument(symbol);
    if (!inst) return { symbol, bid: 0, ask: 0, timestamp: Date.now() };
    const snaps = await getSnapshots([inst.contract]);
    const s = snaps[0];
    if (!s) return { symbol, bid: 0, ask: 0, timestamp: Date.now() };
    return {
      symbol,
      bid: s.buy_price > 0 ? s.buy_price : s.close,
      ask: s.sell_price > 0 ? s.sell_price : s.close,
      timestamp: Date.now(),
    };
  },

  getMarketDataHealth: () => Promise.resolve({ status: "ok", source: "shioaji" }),

  // ── Orders: sim mode routes to the shioaji simulation account,
  //    paper mode (and all futures in sim) stay on the in-browser engine ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  placeOrder: (data: any) =>
    getOrderMode() === "sim" ? placeLiveOrder(data) : (demoApi.placeOrder as (d: any) => unknown)(data),

  cancelOrder: (orderId: string) =>
    getOrderMode() === "sim" ? cancelLiveOrder(orderId) : demoApi.cancelOrder(orderId),

  modifyOrder: (orderId: string, mods: { price?: number; quantity?: number }) =>
    getOrderMode() === "sim"
      ? modifyLiveOrder(orderId, mods)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : (demoApi.modifyOrder as (id: string, m?: any) => unknown)(orderId),

  cancelAllOrders: async () => {
    if (getOrderMode() !== "sim") return demoApi.cancelAllOrders();
    const open = (await getLiveOrders("")).filter((o) => o.status === "OPEN");
    await Promise.all(open.map((o) => cancelLiveOrder(o.id).catch(() => null)));
    return { success: true };
  },

  getOrders: (accountId?: string) =>
    getOrderMode() === "sim" ? getLiveOrders(accountId ?? "") : demoApi.getOrders(),
};
