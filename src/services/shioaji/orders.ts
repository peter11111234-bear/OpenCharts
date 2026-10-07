import type { Order } from "../schemas.ts";
import { getTwInstrument } from "./instruments.ts";
import type { ContractRef } from "./server.ts";

/**
 * Phase 1 live order gateway (simulation account).
 *
 * Routes stock orders to the local shioaji server; futures stay on the paper
 * engine because the simulation environment exposes no futures account
 * (verified 2026-09-18: /api/v1/auth/accounts returns the stock account only).
 *
 * Verified shapes (shioaji 1.7.2):
 * - POST /api/v1/order/place_order {contract, stock_order|futures_order}
 * - POST /api/v1/order/trades       {broker_id?, account_id?} → Trade[]
 * - POST /api/v1/order/cancel_order {trade_id}
 * - POST /api/v1/order/update_price {trade_id, price}
 * - POST /api/v1/order/update_qty   {trade_id, quantity}
 * - GET  /api/v1/auth/accounts → [{account_type, broker_id, account_id, ...}]
 */

const BASE = "/shioaji";

export type OrderMode = "paper" | "sim";

const MODE_KEY = "oc_order_mode";

export function getOrderMode(): OrderMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "sim" ? "sim" : "paper";
  } catch {
    return "paper";
  }
}

export function setOrderMode(mode: OrderMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore privacy-mode errors
  }
}

interface ServerAccount {
  account_type: string;
  broker_id: string;
  account_id: string;
}

let accountsCache: { at: number; accounts: ServerAccount[] } | null = null;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`shioaji ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getServerAccounts(): Promise<ServerAccount[]> {
  if (accountsCache && Date.now() - accountsCache.at < 5 * 60_000) return accountsCache.accounts;
  const res = await fetch(`${BASE}/api/v1/auth/accounts`);
  if (!res.ok) throw new Error(`shioaji accounts failed: ${res.status}`);
  const accounts = (await res.json()) as ServerAccount[];
  accountsCache = { at: Date.now(), accounts };
  return accounts;
}

function stockAccountOf(accounts: ServerAccount[]): ServerAccount | undefined {
  return accounts.find((a) => a.account_type === "S");
}

interface ServerTrade {
  contract: { security_type: string; exchange: string; code: string };
  order: {
    id: string;
    action: string;
    price: number;
    quantity: number;
    order_type: string;
    price_type: string;
    order_lot?: string;
    account?: { account_id?: string };
    ordno?: string;
  };
  status: { id: string; status: string; order_quantity?: number; modified_price?: number };
}

function mapStatus(s: string): string {
  switch (s) {
    case "PendingSubmit":
    case "PreSubmitted":
    case "Submitted":
      return "OPEN";
    case "PartiallyFilled":
      return "PARTIALLY_FILLED";
    case "Filled":
      return "FILLED";
    case "Cancelled":
      return "CANCELLED";
    case "Failed":
      return "REJECTED";
    default:
      return s.toUpperCase();
  }
}

function mapTrade(t: ServerTrade, accountId: string): Order {
  const side = t.order.action === "Sell" ? "SELL" : "BUY";
  const type = t.order.price_type === "MKT" ? "MARKET" : t.order.price_type === "STP" ? "STOP" : "LIMIT";
  return {
    id: t.status.id || t.order.id,
    accountId,
    symbolName: t.contract.code,
    side: side as "BUY" | "SELL",
    type: type as "MARKET" | "LIMIT" | "STOP",
    quantity: t.order.quantity,
    price: t.order.price,
    stopPrice: null,
    takeProfit: null,
    stopLoss: null,
    status: mapStatus(t.status.status),
    filledQuantity: 0,
    avgFillPrice: null,
    comment: t.order.ordno ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export interface LivePlaceArgs {
  accountId: string;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  price?: number;
  stopPrice?: number;
}

function isSimFuturesBlocked(contract: ContractRef): boolean {
  return contract.security_type === "FUT";
}

export async function placeLiveOrder(args: LivePlaceArgs): Promise<Order> {
  const inst = getTwInstrument(args.symbol);
  if (!inst) throw new Error(`未知商品: ${args.symbol}`);
  if (isSimFuturesBlocked(inst.contract)) {
    throw new Error("模擬環境無期貨帳戶，期貨請用紙上單（正式環境需 CA）");
  }
  const accounts = await getServerAccounts();
  const acct = stockAccountOf(accounts);
  if (!acct) throw new Error("找不到現貨帳戶");

  const action = args.side === "SELL" ? "Sell" : "Buy";
  // Engine quantity for stocks is in lots (張); odd-lot arrives fractional.
  // Server wants integer shares + order_lot flag.
  const isOdd = args.quantity < 1;
  const shares = Math.round(args.quantity * 1000);
  const priceType = args.type === "MARKET" ? "MKT" : "LMT";
  const price = args.type === "MARKET" ? 0 : (args.price ?? args.stopPrice ?? 0);
  if (price <= 0 && args.type !== "MARKET") throw new Error("限價單需要價格");

  const body = {
    contract: inst.contract,
    stock_order: {
      action,
      price,
      quantity: isOdd ? shares : Math.round(args.quantity),
      price_type: priceType,
      order_type: "ROD",
      order_lot: isOdd ? "IntradayOdd" : "Common",
      order_cond: "Cash",
      account: { broker_id: acct.broker_id, account_id: acct.account_id },
    },
  };
  const trade = await post<ServerTrade>("/api/v1/order/place_order", body);
  if (trade.status.status === "Failed") {
    throw new Error("委託失敗（可能是漲跌幅範圍外）");
  }
  return mapTrade(trade, args.accountId);
}

export async function getLiveOrders(accountId: string): Promise<Order[]> {
  const accounts = await getServerAccounts();
  const results: Order[] = [];
  for (const acct of accounts) {
    if (acct.account_type !== "S") continue;
    const trades = await post<ServerTrade[]>("/api/v1/order/trades", {
      broker_id: acct.broker_id,
      account_id: acct.account_id,
    });
    for (const t of trades) results.push(mapTrade(t, accountId));
  }
  return results;
}

export async function cancelLiveOrder(orderId: string): Promise<{ success: boolean }> {
  await post("/api/v1/order/cancel_order", { trade_id: orderId });
  return { success: true };
}

export async function modifyLiveOrder(
  orderId: string,
  mods: { price?: number; quantity?: number },
): Promise<unknown> {
  if (mods.price !== undefined) {
    return post("/api/v1/order/update_price", { trade_id: orderId, price: mods.price });
  }
  if (mods.quantity !== undefined) {
    return post("/api/v1/order/update_qty", { trade_id: orderId, quantity: Math.round(mods.quantity) });
  }
  return { success: true };
}
