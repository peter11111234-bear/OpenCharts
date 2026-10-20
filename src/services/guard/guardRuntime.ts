import { ClosedPositionSchema, type ClosedPosition } from "../schemas.ts";
import { subscribeChannel } from "../demo/bus.ts";
import { getSeedPrice } from "../demo/candles.ts";
import * as engine from "../demo/engine.ts";
import { checkEntry, checkStopChange, GUARD_MODE, type Decision, type GuardMode } from "./orderGuard.ts";

/**
 * Side-effect half of the order guard. Builds the rule context from the paper
 * engine, applies the verdict per mode, and appends every decision and every
 * closed trade to logs/order-guard.jsonl (dev middleware in vite.config.ts).
 *
 * Exits are never routed here: closePosition, closeAllPositions, cancelOrder
 * and the SL/TP fills inside engine.mark() must never be blocked.
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

export function guardedPlaceOrder(data: engine.PlaceOrderArgs, mode: GuardMode = GUARD_MODE) {
  const decision = checkEntry(data, {
    now: new Date(),
    // Same fallback as engine.placeOrder's MARKET fill: before the first tick the
    // engine fills at the seed price, so the guard must judge against it too.
    lastPrice: engine.getLastPrice(data.symbol) || getSeedPrice(data.symbol),
    positions: engine.getPositions(),
    closed: engine.getClosedPositions(),
  });
  const enforce = mode === "enforce";
  if (enforce && decision.verdict === "veto") {
    postGuardLog({ kind: "entry", mode, intent: data, decision, orderId: null, positionOpenedAt: null });
    throw vetoError(decision);
  }
  const sized = enforce && decision.verdict === "reduce" ? { ...data, quantity: decision.quantity } : data;
  const order = engine.placeOrder(sized);
  // A MARKET order fills synchronously and its position is the newest one.
  // Resting LIMIT/STOP orders fill later: no join key for them.
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

const unsubscribeOutcomes = subscribeChannel("closed-positions", (event) => {
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
});

// HMR re-runs this module when orderGuard.ts changes, but bus.ts keeps its
// subscribers: without this, every rule edit adds a duplicate outcome line
// and guard_report.py would double the P&L of every later trade.
import.meta.hot?.dispose(unsubscribeOutcomes);
