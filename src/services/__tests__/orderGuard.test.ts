import { describe, it, expect } from "vitest";
import type { ClosedPosition, Position } from "../schemas.ts";
import { checkEntry, checkStopChange, type EntryIntent, type GuardContext } from "../guard/orderGuard.ts";

const NOW = new Date("2026-10-19T10:00:00+08:00");
const AN_HOUR_AGO = "2026-10-19T09:00:00+08:00"; // outside the loss cooldown
const YESTERDAY = "2026-10-18T10:00:00+08:00";

function pos(p: Partial<Position> = {}): Position {
  return {
    id: "p1", accountId: "a", symbolName: "BTCUSD", side: "LONG", quantity: 2,
    entryPrice: 100, currentPrice: 100, unrealizedPnl: 0, margin: 1, contractSize: 1,
    openedAt: NOW.toISOString(), takeProfit: null, stopLoss: null, ...p,
  } as Position;
}

/** Each call is a separate position, so each gets its own openedAt.
 *  Partial closes of ONE position share an openedAt: pass it explicitly. */
let tradeSeq = 0;
function closedTrade(realizedPnl: number, closedAt = AN_HOUR_AGO, openedAt?: string): ClosedPosition {
  tradeSeq += 1;
  return {
    id: crypto.randomUUID(), accountId: "a", symbolName: "BTCUSD", side: "LONG", quantity: 1,
    entryPrice: 100, exitPrice: 99, realizedPnl, commission: 0, swap: 0,
    openedAt: openedAt ?? `2026-10-19T08:${String(tradeSeq).padStart(2, "0")}:00+08:00`,
    closedAt, isPartialClose: false,
  } as ClosedPosition;
}

const ctx = (o: Partial<GuardContext> = {}): GuardContext => ({
  now: NOW, lastPrice: 100, positions: [], closed: [], ...o,
});

// BUY 2 @ 100, stop 98 (risk 2), target 104 (reward 4) → R:R 2.0
const GOOD: EntryIntent = { symbol: "BTCUSD", side: "BUY", quantity: 2, stopLoss: 98, takeProfit: 104 };
const rules = (d: { hits: { rule: string }[] }) => d.hits.map((h) => h.rule);

describe("checkEntry", () => {
  it("approves a clean entry at full size", () => {
    expect(checkEntry(GOOD, ctx())).toEqual({ verdict: "approve", quantity: 2, hits: [] });
  });

  it("vetoes an entry without a stop-loss", () => {
    const d = checkEntry({ ...GOOD, stopLoss: undefined }, ctx());
    expect(d.verdict).toBe("veto");
    expect(rules(d)).toContain("stop_required");
  });

  it("vetoes a BUY whose stop is above entry", () => {
    expect(rules(checkEntry({ ...GOOD, stopLoss: 101 }, ctx()))).toContain("stop_side");
  });

  it("vetoes a SELL whose stop is below entry", () => {
    const d = checkEntry({ symbol: "BTCUSD", side: "SELL", quantity: 1, stopLoss: 99 }, ctx());
    expect(rules(d)).toContain("stop_side");
  });

  it("uses the limit price as entry when given", () => {
    // limit 95, stop 97 is above a 95 BUY entry → wrong side
    expect(rules(checkEntry({ ...GOOD, price: 95, stopLoss: 97, takeProfit: undefined }, ctx()))).toContain("stop_side");
  });

  it("uses the stop level as entry for a STOP order", () => {
    // BUY STOP at 110, stop-loss 105 is below 110 → right side, even though market is 100
    expect(checkEntry({ ...GOOD, stopPrice: 110, stopLoss: 105, takeProfit: undefined }, ctx()).verdict).toBe("approve");
  });

  it("vetoes reward/risk below 1.5", () => {
    // reward 1, risk 2 → 0.5
    expect(rules(checkEntry({ ...GOOD, takeProfit: 101 }, ctx()))).toContain("reward_risk");
  });

  it("vetoes a take-profit on the wrong side of entry", () => {
    // BUY @ 100, TP 90 is a loss target: |90 - 100| / 2 = 5.0 would pass a non-directional R:R
    const d = checkEntry({ ...GOOD, takeProfit: 90 }, ctx());
    expect(d.hits.find((h) => h.rule === "reward_risk")?.reason).toMatch(/wrong side/);
  });

  it("skips price-based rules when the entry price is unknown", () => {
    expect(checkEntry({ ...GOOD, stopLoss: 101 }, ctx({ lastPrice: 0 })).verdict).toBe("approve");
  });

  it("vetoes once today's realized loss reaches the limit", () => {
    const d = checkEntry(GOOD, ctx({ closed: [closedTrade(-300), closedTrade(-250)] }));
    expect(d.verdict).toBe("veto");
    expect(rules(d)).toContain("daily_loss");
  });

  it("ignores losses closed on an earlier day", () => {
    const old = [closedTrade(-300, YESTERDAY), closedTrade(-300, YESTERDAY), closedTrade(-300, YESTERDAY)];
    expect(checkEntry(GOOD, ctx({ closed: old })).verdict).toBe("approve");
  });

  it("halves size after 2 losses in a row", () => {
    expect(checkEntry(GOOD, ctx({ closed: [closedTrade(-10), closedTrade(-10)] }))).toMatchObject({
      verdict: "reduce", quantity: 1,
    });
  });

  it("vetoes after 3 losses in a row", () => {
    const d = checkEntry(GOOD, ctx({ closed: [closedTrade(-10), closedTrade(-10), closedTrade(-10)] }));
    expect(d.verdict).toBe("veto");
    expect(rules(d)).toContain("loss_streak");
  });

  it("counts the streak from the newest trade and stops at a win", () => {
    const closed = [closedTrade(-10), closedTrade(5), closedTrade(-10), closedTrade(-10)];
    expect(checkEntry(GOOD, ctx({ closed })).verdict).toBe("approve");
  });

  it("counts one position closed in three partial fills as a single loss", () => {
    // The engine writes one ClosedPosition per partial close, all sharing the
    // position's openedAt. Three partials of one position are ONE losing trade.
    const openedAt = "2026-10-19T08:00:00+08:00";
    const partials = [
      closedTrade(-10, AN_HOUR_AGO, openedAt),
      closedTrade(-10, AN_HOUR_AGO, openedAt),
      closedTrade(-10, AN_HOUR_AGO, openedAt),
    ];
    expect(checkEntry(GOOD, ctx({ closed: partials })).verdict).toBe("approve");
  });

  it("vetoes an entry whose stop-loss is not a positive price", () => {
    // A stop of 0 never fires on a LONG (engine: price <= stopLoss), so it is a
    // stop in name only. The exit path (checkStopChange) rejects the same values.
    for (const stopLoss of [0, -5]) {
      const d = checkEntry({ ...GOOD, stopLoss }, ctx());
      expect(d.verdict).toBe("veto");
      expect(rules(d)).toContain("stop_required");
    }
  });

  it("judges a LIMIT entry against the price it actually fills at", () => {
    // The engine fills a LIMIT no worse than its own level: BUY at min(limit, market).
    // A stop judged against the limit alone would approve a stop that sits on the
    // wrong side of the real fill and stops out on the next tick.
    const d = checkEntry(
      { symbol: "BTCUSD", side: "BUY", type: "LIMIT", quantity: 2, price: 105, stopLoss: 103 },
      ctx({ lastPrice: 100 }),
    );
    expect(d.verdict).toBe("veto");
    expect(rules(d)).toContain("stop_side");
  });

  it("vetoes an entry within 5 minutes of a losing close", () => {
    const d = checkEntry(GOOD, ctx({ closed: [closedTrade(-10, "2026-10-19T09:57:00+08:00")] }));
    expect(d.verdict).toBe("veto");
    expect(rules(d)).toEqual(["cooldown_after_loss"]);
  });

  it("allows an entry 6 minutes after a loss, or right after a win", () => {
    expect(checkEntry(GOOD, ctx({ closed: [closedTrade(-10, "2026-10-19T09:54:00+08:00")] })).verdict).toBe("approve");
    expect(checkEntry(GOOD, ctx({ closed: [closedTrade(10, "2026-10-19T09:59:00+08:00")] })).verdict).toBe("approve");
  });

  it("keeps the loss cooldown across midnight", () => {
    const d = checkEntry(GOOD, ctx({
      now: new Date("2026-10-20T00:01:00+08:00"),
      closed: [closedTrade(-10, "2026-10-19T23:58:00+08:00")],
    }));
    expect(rules(d)).toEqual(["cooldown_after_loss"]);
  });

  it("vetoes an order that would open a hedge against an open position", () => {
    expect(rules(checkEntry(GOOD, ctx({ positions: [pos({ side: "SHORT" })] })))).toContain("opposite_side");
  });

  it("vetoes adding to a losing position but allows adding to a winner", () => {
    expect(rules(checkEntry(GOOD, ctx({ positions: [pos({ unrealizedPnl: -5 })] })))).toContain("average_down");
    expect(checkEntry(GOOD, ctx({ positions: [pos({ unrealizedPnl: 5 })] })).verdict).toBe("approve");
  });

  it("fails closed when a rule throws", () => {
    const broken = ctx({ closed: null as unknown as ClosedPosition[] });
    const d = checkEntry(GOOD, broken);
    expect(d.verdict).toBe("veto");
    expect(d.hits.find((h) => h.rule === "daily_loss")?.reason).toMatch(/^Rule failed:/);
  });
});

describe("checkStopChange", () => {
  it("allows tightening and vetoes widening a LONG stop", () => {
    const p = pos({ stopLoss: 98 });
    expect(checkStopChange(p, 99).verdict).toBe("approve");
    expect(rules(checkStopChange(p, 97))).toEqual(["stop_widen"]);
  });

  it("vetoes widening a SHORT stop, vetoes removal, and ignores untouched or first stops", () => {
    expect(rules(checkStopChange(pos({ side: "SHORT", stopLoss: 102 }), 103))).toEqual(["stop_widen"]);
    expect(rules(checkStopChange(pos({ stopLoss: 98 }), null))).toEqual(["stop_removed"]);
    expect(checkStopChange(pos({ stopLoss: 98 }), undefined).verdict).toBe("approve");
    expect(checkStopChange(pos({ stopLoss: null }), 95).verdict).toBe("approve");
  });

  it("vetoes a stop that is not a positive finite number, first stop included", () => {
    expect(rules(checkStopChange(pos({ stopLoss: null }), 0))).toEqual(["stop_invalid"]);
    expect(rules(checkStopChange(pos({ stopLoss: 98 }), -1))).toEqual(["stop_invalid"]);
    expect(rules(checkStopChange(pos({ stopLoss: 98 }), Number.NaN))).toEqual(["stop_invalid"]);
  });
});
