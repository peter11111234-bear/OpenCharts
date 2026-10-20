import { describe, it, expect, vi, beforeEach } from "vitest";
import * as engine from "../demo/engine.ts";
import { guardedModifyPosition, guardedPlaceOrder } from "../guard/guardRuntime.ts";

/** The paper engine is a module singleton: each case claims its own symbol.
 *  Symbol isolation does NOT isolate the account-wide rules (daily_loss, loss_streak,
 *  cooldown_after_loss read every symbol's closes). Keep every close at P&L >= 0
 *  (close at the entry mark), or a later case trips the 5-minute loss cooldown. */
const ACCOUNT = "guard-test";

/** Shape of one line the guard posts to /__guard-log. The runtime writes it as
 *  JSON, so the test reads it back through this narrow view instead of
 *  reaching into an unknown bag of fields. */
interface GuardLog {
  kind?: string;
  mode?: string;
  decision?: { verdict?: string; hits?: { rule: string }[] };
  positionOpenedAt?: string | null;
  symbol?: string;
  openedAt?: string;
  realizedPnl?: number;
}

let logs: GuardLog[] = [];

beforeEach(() => {
  logs = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: { body: string }) => {
      // JSON.parse returns `any`; the cast names the boundary shape the runtime posts.
      const line = JSON.parse(init.body) as GuardLog;
      logs.push(line);
      return Promise.resolve({ ok: true });
    }),
  );
});

const market = (symbol: string, extra: Partial<engine.PlaceOrderArgs> = {}) => ({
  accountId: ACCOUNT, symbol, side: "BUY", type: "MARKET", quantity: 1, ...extra,
});

describe("guard runtime", () => {
  it("shadow mode logs a veto but still places the order", () => {
    engine.mark("ETHUSD", 3_000);
    const order = guardedPlaceOrder(market("ETHUSD"), "shadow");
    expect(order.status).toBe("FILLED");
    const entry = logs.find((l) => l.kind === "entry")!;
    expect(entry).toMatchObject({ mode: "shadow", decision: { verdict: "veto" } });
    expect(typeof entry.positionOpenedAt).toBe("string");
  });

  it("enforce mode throws on a veto and opens nothing", () => {
    engine.mark("SOLUSD", 150);
    expect(() => guardedPlaceOrder(market("SOLUSD"), "enforce")).toThrow(/Guard veto: Entry needs a stop-loss/);
    expect(engine.getPositions().some((p) => p.symbolName === "SOLUSD")).toBe(false);
  });

  it("logs the trade outcome with the entry's openedAt as join key", () => {
    engine.mark("BNBUSD", 600);
    guardedPlaceOrder(market("BNBUSD", { stopLoss: 590 }), "shadow");
    const entry = logs.find((l) => l.kind === "entry")!;
    const pos = engine.getPositions().find((p) => p.symbolName === "BNBUSD")!;
    engine.closePosition(pos.id);
    const outcome = logs.find((l) => l.kind === "outcome")!;
    expect(outcome).toMatchObject({ symbol: "BNBUSD", openedAt: entry.positionOpenedAt });
    expect(typeof outcome.realizedPnl).toBe("number");
  });

  it("writes exactly one outcome line per closed position", () => {
    // The bus keeps its subscribers across an HMR reload of this module, and a
    // Set holds handlers by reference, so a second subscriber would double
    // every outcome line and guard_report.py would double the P&L.
    engine.mark("DOGEUSD", 0.2);
    guardedPlaceOrder(market("DOGEUSD", { stopLoss: 0.19 }), "shadow");
    const pos = engine.getPositions().find((p) => p.symbolName === "DOGEUSD")!;
    engine.closePosition(pos.id);
    expect(logs.filter((l) => l.kind === "outcome")).toHaveLength(1);
  });

  it("enforce mode refuses to widen a stop and leaves the stop unchanged", () => {
    engine.mark("XRPUSD", 0.5);
    guardedPlaceOrder(market("XRPUSD", { stopLoss: 0.4 }), "shadow");
    const pos = engine.getPositions().find((p) => p.symbolName === "XRPUSD")!;
    expect(() => guardedModifyPosition(pos.id, { stopLoss: 0.3 }, "enforce")).toThrow(/Guard veto/);
    expect(engine.getPositions().find((p) => p.id === pos.id)!.stopLoss).toBe(0.4);
  });

  it("allows tightening a stop and does not log a clean change", () => {
    engine.mark("ADAUSD", 0.4);
    guardedPlaceOrder(market("ADAUSD", { stopLoss: 0.3 }), "shadow");
    const pos = engine.getPositions().find((p) => p.symbolName === "ADAUSD")!;
    logs = [];
    expect(guardedModifyPosition(pos.id, { stopLoss: 0.35 }, "enforce")!.stopLoss).toBe(0.35);
    expect(logs.filter((l) => l.kind === "stop_change")).toHaveLength(0);
  });

  it("judges a symbol with no tick yet against the seed price the engine fills at", () => {
    // BTCUSD is never marked in this file. A stop far above any BTC price is on the
    // wrong side of the seed fill, so stop_side must fire instead of skipping on price 0.
    expect(engine.getLastPrice("BTCUSD")).toBe(0);
    const order = guardedPlaceOrder(market("BTCUSD", { stopLoss: 1e9 }), "shadow");
    expect(order.status).toBe("FILLED");
    const entry = logs.find((l) => l.kind === "entry")!;
    const rules = (entry.decision?.hits ?? []).map((h) => h.rule);
    expect(rules).toContain("stop_side");
  });
});
