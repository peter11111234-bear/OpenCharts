import type { Order } from "../../services/schemas.ts";

/**
 * Extract the target price level of an order for chart overlay representation.
 *
 * Contract:
 * - A LIMIT order carries its target price in `price`.
 * - A STOP order carries its trigger level in `stopPrice`.
 * - A MARKET order has neither (executes immediately at market) -> null.
 * - Non-finite numbers or null values resolve to null.
 */
export function orderLevel(order: Pick<Order, "type" | "price" | "stopPrice">): number | null {
  const raw = order.type === "STOP" ? order.stopPrice : order.type === "LIMIT" ? order.price : null;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}
