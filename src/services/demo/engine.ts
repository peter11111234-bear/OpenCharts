import type { Account, ClosedPosition, Fill, Order, Position } from "../schemas.ts";
import { publish } from "./bus.ts";
import { getSeedPrice } from "./candles.ts";
import { getDemoSymbol } from "./instruments.ts";

/** Orders and trade history are demo-session records, not a growing ledger. */
const HISTORY_CAP = 500;

/** The only two states this engine produces. */
export type OrderStatus = "PENDING" | "FILLED";

/**
 * In-browser paper-trading engine. The single source of truth for the demo
 * account, positions and orders. Market orders fill instantly at the latest
 * replayed price; positions are marked-to-market on every tick. State is
 * ephemeral (memory only) — a refresh starts a fresh demo session.
 */

const STARTING_BALANCE = 100_000;
const DEFAULT_LEVERAGE = 100;

const account: Account = {
  id: crypto.randomUUID(),
  userId: "demo-user",
  templateId: "demo",
  label: "Demo Account",
  status: "ACTIVE",
  balance: STARTING_BALANCE,
  equity: STARTING_BALANCE,
  margin: 0,
  freeMargin: STARTING_BALANCE,
  phase: "LIVE",
  startDate: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  isHftMode: false,
  template: { name: "Demo Account", startingBalance: STARTING_BALANCE, instrumentType: "CRYPTO" },
};

const positions: Position[] = [];
const orders: Order[] = [];
const closed: ClosedPosition[] = [];
const fills: Fill[] = [];
const lastPrice = new Map<string, number>();

export function getAccount(): Account {
  return { ...account };
}
export function getAccounts(): Account[] {
  return [getAccount()];
}
export function getPositions(): Position[] {
  return positions.map((p) => ({ ...p }));
}
export function getOrders(): Order[] {
  return orders.map((o) => ({ ...o }));
}
export function getClosedPositions(): ClosedPosition[] {
  return closed.map((c) => ({ ...c }));
}
export function getFills(): Fill[] {
  return fills.map((f) => ({ ...f }));
}
export function getLastPrice(symbol: string): number {
  return lastPrice.get(symbol) ?? 0;
}

function notional(symbol: string, qty: number, price: number): number {
  const contractSize = getDemoSymbol(symbol)?.contractSize ?? 1;
  return price * qty * contractSize;
}

function pnlOf(pos: Position, price: number): number {
  const contractSize = getDemoSymbol(pos.symbolName)?.contractSize ?? 1;
  const dir = pos.side === "LONG" ? 1 : -1;
  return (price - pos.entryPrice) * pos.quantity * contractSize * dir;
}

function recomputeEquity(): void {
  let unrealized = 0;
  let margin = 0;
  for (const p of positions) {
    const price = lastPrice.get(p.symbolName) ?? p.entryPrice;
    p.currentPrice = price;
    p.unrealizedPnl = pnlOf(p, price);
    unrealized += p.unrealizedPnl;
    margin += p.margin;
  }
  account.margin = margin;
  account.equity = account.balance + unrealized;
  account.freeMargin = account.equity - margin;
  account.updatedAt = new Date().toISOString();
}

function emitEquity(): void {
  publish("account", {
    eventType: "EquityUpdated",
    accountId: account.id,
    equity: account.equity,
    balance: account.balance,
    freeMargin: account.freeMargin,
    marginUsed: account.margin,
  });
}

function openPosition(symbol: string, side: string, qty: number, price: number, tp?: number, sl?: number): Position {
  const isLong = side === "BUY";
  const pos: Position = {
    id: crypto.randomUUID(),
    accountId: account.id,
    symbolName: symbol,
    side: isLong ? "LONG" : "SHORT",
    quantity: qty,
    entryPrice: price,
    currentPrice: price,
    unrealizedPnl: 0,
    margin: notional(symbol, qty, price) / DEFAULT_LEVERAGE,
    contractSize: getDemoSymbol(symbol)?.contractSize ?? 1,
    openedAt: new Date().toISOString(),
    takeProfit: tp ?? null,
    stopLoss: sl ?? null,
  };
  positions.push(pos);
  publish("positions", { eventType: "PositionOpened", accountId: account.id, positionId: pos.id, _entity: { ...pos } });
  return pos;
}

function makeOrder(input: PlaceOrderArgs, status: OrderStatus, avgFillPrice: number | null): Order {
  const now = new Date().toISOString();
  const type = (input.type as Order["type"]) ?? "MARKET";
  // The tickets disagree on which field carries the level: the desktop ticket
  // sends price for LIMIT and stopPrice for STOP, while the mobile ticket and
  // the chart quick-order send everything as price. Land it once here, on the
  // field this type triggers from, so no caller can silently mis-place a level.
  const level = type === "MARKET" ? null : (input.price ?? input.stopPrice ?? null);
  const levelOnStop = type === "STOP";
  return {
    id: crypto.randomUUID(),
    accountId: account.id,
    symbolName: input.symbol,
    side: input.side === "BUY" ? "BUY" : "SELL",
    type,
    quantity: input.quantity,
    price: levelOnStop ? null : level,
    stopPrice: levelOnStop ? level : null,
    takeProfit: input.takeProfit ?? null,
    stopLoss: input.stopLoss ?? null,
    status,
    filledQuantity: status === "FILLED" ? input.quantity : 0,
    avgFillPrice,
    comment: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Does a resting order trigger at this market price? */
function triggersAt(order: Order, price: number): boolean {
  const buying = order.side === "BUY";
  if (order.type === "LIMIT" && order.price != null) {
    return buying ? price <= order.price : price >= order.price;
  }
  if (order.type === "STOP" && order.stopPrice != null) {
    return buying ? price >= order.stopPrice : price <= order.stopPrice;
  }
  return false;
}

/**
 * Fill price for a triggered resting order. A LIMIT never fills worse than its
 * own level, so a market that gapped through it fills at the better price; a
 * STOP is a pure trigger and fills at the market, matching how SL/TP close.
 */
function restingFillPrice(order: Order, market: number): number {
  if (order.type === "LIMIT" && order.price != null) {
    return order.side === "BUY" ? Math.min(order.price, market) : Math.max(order.price, market);
  }
  return market;
}

export type PlaceOrderArgs = {
  accountId: string;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  price?: number;
  stopPrice?: number;
  takeProfit?: number;
  stopLoss?: number;
};

/** The single owner of the FILLED transition. */
function fillOrder(order: Order, price: number): void {
  order.status = "FILLED";
  order.filledQuantity = order.quantity;
  order.avgFillPrice = price;
  order.updatedAt = new Date().toISOString();
  publish("orders", { eventType: "OrderFilled", accountId: account.id, orderId: order.id, _entity: { ...order } });
  openPosition(
    order.symbolName,
    order.side,
    order.quantity,
    price,
    order.takeProfit ?? undefined,
    order.stopLoss ?? undefined,
  );
}

/** Keep the session records bounded; a demo tab must not grow without limit. */
function trimHistory(): void {
  if (orders.length > HISTORY_CAP) orders.length = HISTORY_CAP;
  if (closed.length > HISTORY_CAP) closed.length = HISTORY_CAP;
  if (fills.length > HISTORY_CAP) fills.length = HISTORY_CAP;
}

/**
 * MARKET orders fill instantly at the latest traded price and open a position.
 * LIMIT and STOP orders rest as PENDING until mark() sees the market reach
 * their level; a triggered order fills per restingFillPrice, never at the raw
 * price the user typed. Bad input is rejected here rather than poisoning the
 * account, because the mobile ticket forwards whatever the user typed.
 */
export function placeOrder(input: PlaceOrderArgs): Order {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new Error("Quantity must be a positive, finite number");
  }
  for (const [name, value] of [
    ["price", input.price],
    ["stopPrice", input.stopPrice],
    ["takeProfit", input.takeProfit],
    ["stopLoss", input.stopLoss],
  ] as const) {
    if (value != null && !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  }
  const resting = input.type === "LIMIT" || input.type === "STOP";
  if (resting) {
    const level = input.price ?? input.stopPrice;
    if (level == null || level <= 0) throw new Error(`${input.type} orders need a positive price`);
  }
  const marketPrice = resting ? 0 : (lastPrice.get(input.symbol) ?? getSeedPrice(input.symbol));
  if (!resting && !(marketPrice > 0)) throw new Error(`No tradable price for ${input.symbol}`);
  const order = resting ? makeOrder(input, "PENDING", null) : makeOrder(input, "FILLED", marketPrice);
  orders.unshift(order);
  publish("orders", { eventType: "OrderPlaced", accountId: account.id, orderId: order.id, _entity: { ...order } });
  if (order.status === "FILLED") {
    fillOrder(order, marketPrice);
    recomputeEquity();
    emitEquity();
  }
  trimHistory();
  return order;
}

function recordClose(pos: Position, qty: number, exitPrice: number, realized: number): void {
  const now = new Date().toISOString();
  closed.unshift({
    id: crypto.randomUUID(),
    accountId: account.id,
    symbolName: pos.symbolName,
    side: pos.side,
    quantity: qty,
    entryPrice: pos.entryPrice,
    exitPrice,
    realizedPnl: realized,
    commission: 0,
    swap: 0,
    openedAt: pos.openedAt,
    closedAt: now,
    isPartialClose: qty < pos.quantity,
  });
  fills.unshift({
    id: crypto.randomUUID(),
    orderId: pos.id,
    accountId: account.id,
    symbolName: pos.symbolName,
    side: pos.side === "LONG" ? "SELL" : "BUY",
    quantity: qty,
    price: exitPrice,
    commission: 0,
    realizedPnl: realized,
    createdAt: now,
  });
}

/** Close a position without recomputing or emitting the account. */
function closePositionCore(positionId: string, quantity?: number): boolean {
  const idx = positions.findIndex((p) => p.id === positionId);
  if (idx < 0) return false;
  if (quantity !== undefined && (!Number.isFinite(quantity) || quantity <= 0)) return false;
  const pos = positions[idx]!;
  const price = lastPrice.get(pos.symbolName) ?? pos.entryPrice;
  const qty = quantity && quantity < pos.quantity ? quantity : pos.quantity;
  const realized = pnlOf({ ...pos, quantity: qty }, price);
  account.balance += realized;
  recordClose(pos, qty, price, realized);
  if (qty >= pos.quantity) {
    positions.splice(idx, 1);
    publish("positions", { eventType: "PositionClosed", accountId: account.id, positionId });
  } else {
    pos.quantity -= qty;
    publish("positions", { eventType: "PositionUpdated", accountId: account.id, positionId, quantity: pos.quantity });
  }
  trimHistory();
  return true;
}

export function closePosition(positionId: string, quantity?: number): { success: boolean } {
  const closed = closePositionCore(positionId, quantity);
  if (closed) {
    recomputeEquity();
    emitEquity();
  }
  return { success: closed };
}

export function closeAllPositions(): { success: boolean } {
  for (const p of [...positions]) closePosition(p.id);
  return { success: true };
}

export function modifyPosition(
  positionId: string,
  mods: { takeProfit?: number | null; stopLoss?: number | null },
): Position | undefined {
  const pos = positions.find((p) => p.id === positionId);
  if (!pos) return undefined;
  if (mods.takeProfit !== undefined) pos.takeProfit = mods.takeProfit;
  if (mods.stopLoss !== undefined) pos.stopLoss = mods.stopLoss;
  publish("positions", {
    eventType: "PositionUpdated",
    accountId: account.id,
    positionId,
    unrealizedPnl: pos.unrealizedPnl,
    quantity: pos.quantity,
    averagePrice: pos.entryPrice,
  });
  return { ...pos };
}

export type ModifyOrderArgs = {
  /** The order's level. Both tickets carry it here, for LIMIT and STOP alike. */
  price?: number | null;
  quantity?: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
};

/**
 * Amend a PENDING order. An unknown id or an already-filled order returns
 * undefined — a filled order is a historical record and stays immutable.
 */
export function modifyOrder(orderId: string, mods: ModifyOrderArgs): Order | undefined {
  const order = orders.find((o) => o.id === orderId);
  if (!order || order.status !== "PENDING") return undefined;
  if (mods.price !== undefined) {
    if (mods.price !== null && (!Number.isFinite(mods.price) || mods.price <= 0)) return undefined;
    if (order.type === "STOP") order.stopPrice = mods.price;
    else order.price = mods.price;
  }
  if (mods.quantity !== undefined) {
    if (!Number.isFinite(mods.quantity) || mods.quantity <= 0) return undefined;
    order.quantity = mods.quantity;
  }
  if (mods.takeProfit !== undefined) order.takeProfit = mods.takeProfit;
  if (mods.stopLoss !== undefined) order.stopLoss = mods.stopLoss;
  order.updatedAt = new Date().toISOString();
  publish("orders", { eventType: "OrderUpdated", accountId: account.id, orderId, _entity: { ...order } });
  return { ...order };
}

export function cancelOrder(orderId: string): { success: boolean } {
  const idx = orders.findIndex((o) => o.id === orderId);
  if (idx < 0) return { success: false };
  orders.splice(idx, 1);
  publish("orders", { eventType: "OrderCanceled", accountId: account.id, orderId });
  return { success: true };
}

function checkStops(pos: Position, price: number): boolean {
  const hitTp = pos.takeProfit != null && (pos.side === "LONG" ? price >= pos.takeProfit : price <= pos.takeProfit);
  const hitSl = pos.stopLoss != null && (pos.side === "LONG" ? price <= pos.stopLoss : price >= pos.stopLoss);
  return hitTp || hitSl;
}

/** Fill every resting order whose level this price has reached. */
function matchRestingOrders(symbol: string, price: number): number {
  let filled = 0;
  for (const order of orders) {
    if (order.symbolName !== symbol || order.status !== "PENDING") continue;
    if (!triggersAt(order, price)) continue;
    fillOrder(order, restingFillPrice(order, price));
    filled += 1;
  }
  return filled;
}

/**
 * Called by the feed on every replayed tick: fills resting orders, marks
 * positions, fires SL/TP. Prices arrive far more often than anything changes,
 * so the idle path costs one array filter and nothing more. The account is
 * recomputed and emitted exactly once per tick, because a single tick can both
 * fill an order and close a position.
 */
export function mark(symbol: string, price: number): void {
  lastPrice.set(symbol, price);
  const filled = matchRestingOrders(symbol, price);
  const affected = positions.filter((p) => p.symbolName === symbol);
  if (affected.length === 0 && filled === 0) return;
  for (const pos of affected) {
    if (checkStops(pos, price)) {
      closePositionCore(pos.id);
      continue;
    }
    pos.currentPrice = price;
    pos.unrealizedPnl = pnlOf(pos, price);
    publish("positions", {
      eventType: "PositionUpdated",
      accountId: account.id,
      positionId: pos.id,
      unrealizedPnl: pos.unrealizedPnl,
      quantity: pos.quantity,
      averagePrice: pos.entryPrice,
    });
  }
  recomputeEquity();
  emitEquity();
}
