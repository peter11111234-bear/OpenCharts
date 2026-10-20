import { ClosedPositionSchema, type ClosedPosition } from "../schemas.ts";
import { subscribeChannel } from "../demo/bus.ts";
import { getSeedPrice } from "../demo/candles.ts";
import * as engine from "../demo/engine.ts";
import {
  checkEntry,
  checkOrderChange,
  checkStopChange,
  GUARD_MODE,
  type Decision,
  type EntryIntent,
  type GuardContext,
  type GuardMode,
} from "./orderGuard.ts";

/**
 * Side-effect half of the order guard. Builds the rule context from the paper
 * engine, applies the verdict per mode, and appends every decision and every
 * closed trade to logs/order-guard.jsonl (dev middleware in vite.config.ts).
 *
 * Exits are never routed here: closePosition, closeAllPositions, cancelOrder
 * and the SL/TP fills inside engine.mark() must never be blocked.
 * modifyOrder is: an edit to a resting order can drop or misplace its stop.
 * If shioajiApi.placeOrder (services/shioaji/api.ts) is ever wired into
 * services/api.ts, its placeLiveOrder path must run checkEntry too.
 */

function postGuardLog(event: Record<string, unknown>): void {
  // Fire-and-forget: an order never waits on, or fails because of, the audit log.
  // TODO: ponytail debt, a failed POST drops the line without a trace.
  fetch("/__guard-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ts: new Date().toISOString(), mode: GUARD_MODE, ...event }),
    keepalive: true,
  }).catch(() => {});
}

function vetoError(d: Decision): Error {
  const reasons = d.hits.filter((h) => h.verdict === "veto").map((h) => h.reason);
  return new Error(`Guard veto: ${reasons.join("; ")}`);
}

function guardContext(symbol: string): GuardContext {
  return {
    now: new Date(),
    // Same fallback as engine.placeOrder's MARKET fill: before the first tick the
    // engine fills at the seed price, so the guard must judge against it too.
    lastPrice: engine.getLastPrice(symbol) || getSeedPrice(symbol),
    positions: engine.getPositions(),
    closed: engine.getClosedPositions(),
  };
}

export function guardedPlaceOrder(data: engine.PlaceOrderArgs, mode: GuardMode = GUARD_MODE) {
  const decision = checkEntry(data, guardContext(data.symbol));
  const enforce = mode === "enforce";
  if (enforce && decision.verdict === "veto") {
    postGuardLog({ kind: "entry", mode, intent: data, decision, orderId: null, positionOpenedAt: null });
    throw vetoError(decision);
  }
  const sized = enforce && decision.verdict === "reduce" ? { ...data, quantity: decision.quantity } : data;
  const order = engine.placeOrder(sized);
  // A MARKET order fills synchronously and its position is the newest one.
  // Resting LIMIT/STOP orders fill later: their join key arrives as a "fill" line.
  const positions = engine.getPositions();
  const opened = order.status === "FILLED" ? positions[positions.length - 1] : undefined;
  postGuardLog({
    kind: "entry",
    mode,
    intent: data,
    decision,
    orderId: order.id,
    positionOpenedAt: opened?.openedAt ?? null,
  });
  return order;
}

export function guardedModifyPosition(
  positionId: string,
  mods: { takeProfit?: number | null; stopLoss?: number | null },
  mode: GuardMode = GUARD_MODE,
) {
  const pos = engine.getPositions().find((p) => p.id === positionId);
  if (pos) {
    const decision = checkStopChange(pos, mods.stopLoss);
    if (decision.hits.length > 0) {
      postGuardLog({
        kind: "stop_change",
        mode,
        positionId,
        symbol: pos.symbolName,
        from: pos.stopLoss,
        to: mods.stopLoss,
        decision,
      });
    }
    if (mode === "enforce" && decision.verdict === "veto") throw vetoError(decision);
  }
  return engine.modifyPosition(positionId, mods);
}

/**
 * Resting edits run the order-level rules only (checkOrderChange). Raising the
 * size is new exposure, so it runs every entry rule; a reduce verdict then keeps
 * the old size instead of halving an order that was sized at placement.
 */
export function guardedModifyOrder(orderId: string, mods: engine.ModifyOrderArgs, mode: GuardMode = GUARD_MODE) {
  const order = engine.getOrders().find((o) => o.id === orderId && o.status === "PENDING");
  if (!order) return engine.modifyOrder(orderId, mods);
  const pick = <T,>(next: T | null | undefined, cur: T | null): T | undefined =>
    (next !== undefined ? next : cur) ?? undefined;
  const level = pick(mods.price, order.type === "STOP" ? order.stopPrice : order.price);
  const intent: EntryIntent = {
    symbol: order.symbolName,
    side: order.side,
    type: order.type,
    quantity: mods.quantity ?? order.quantity,
    ...(order.type === "STOP" ? { stopPrice: level } : { price: level }),
    stopLoss: pick(mods.stopLoss, order.stopLoss),
    takeProfit: pick(mods.takeProfit, order.takeProfit),
  };
  const adds = intent.quantity > order.quantity;
  const ctx = guardContext(order.symbolName);
  const decision = adds ? checkEntry(intent, ctx) : checkOrderChange(intent, ctx);
  if (decision.hits.length > 0) postGuardLog({ kind: "order_modify", mode, orderId, intent, decision });
  if (mode === "enforce" && decision.verdict === "veto") throw vetoError(decision);
  const sized = mode === "enforce" && decision.verdict === "reduce" ? { ...mods, quantity: order.quantity } : mods;
  return engine.modifyOrder(orderId, sized);
}

/** A resting order opens its position when it fills, after the entry line was
 *  written with positionOpenedAt null: this line supplies the join key. */
function onPositionOpened(event: unknown): void {
  if (typeof event !== "object" || event === null) return;
  const e = event as { eventType?: unknown; orderId?: unknown; _entity?: { symbolName?: unknown; openedAt?: unknown } };
  if (e.eventType !== "PositionOpened" || typeof e.orderId !== "string") return;
  if (typeof e._entity?.openedAt !== "string") return;
  postGuardLog({ kind: "fill", orderId: e.orderId, symbol: e._entity.symbolName, positionOpenedAt: e._entity.openedAt });
}

function onClosedPosition(event: unknown): void {
  // The bus payload is `unknown`: pull the record out by key and validate it
  // against the app's own schema instead of trusting the shape.
  const entity = typeof event === "object" && event !== null && "_entity" in event ? event._entity : null;
  const parsed = ClosedPositionSchema.safeParse(entity);
  if (!parsed.success) return;
  const c: ClosedPosition = parsed.data;
  postGuardLog({
    kind: "outcome",
    symbol: c.symbolName,
    side: c.side,
    openedAt: c.openedAt,
    closedAt: c.closedAt,
    realizedPnl: c.realizedPnl,
  });
}

/**
 * One subscription for the whole page, anchored on globalThis.
 *
 * Editing orderGuard.ts re-evaluates this module, but bus.ts keeps its
 * subscribers and the Set holds the handler by reference, so a fresh arrow
 * function would be a second subscriber: every rule edit would add another
 * outcome line and guard_report.py would double the P&L of every later trade.
 *
 * `import.meta.hot?.dispose` cannot fix that: Vite only calls the disposer
 * registered for the module that accepted the update, and a .ts file is never
 * an HMR boundary (only a source-level `.accept` makes one). The first
 * instance wins and stays subscribed for the page's lifetime; rule edits
 * therefore need a reload to take effect.
 */
const OUTCOME_SUB_KEY = "__openchartsGuardOutcomeSubscription";
type GuardGlobal = typeof globalThis & { [OUTCOME_SUB_KEY]?: true };
const guardGlobal = globalThis as GuardGlobal;
if (!guardGlobal[OUTCOME_SUB_KEY]) {
  guardGlobal[OUTCOME_SUB_KEY] = true;
  subscribeChannel("closed-positions", onClosedPosition);
  subscribeChannel("positions", onPositionOpened);
}
