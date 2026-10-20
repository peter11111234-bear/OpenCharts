import { describe, it, expect, vi } from "vitest";
import { publish } from "../demo/bus.ts";

/** The bus keeps its subscribers when a module is re-evaluated (an HMR reload),
 *  and a Set holds handlers by reference, so a second subscription to the same
 *  channel would write a second outcome line for every closed position and
 *  guard_report.py would double the P&L of every later trade.
 *
 *  `import.meta.hot?.dispose` cannot prevent that: Vite only calls the
 *  disposer registered for the module that accepted the update, and a .ts file
 *  is never an HMR boundary. The runtime therefore anchors its subscription on
 *  globalThis. This test re-evaluates the module the way the browser does. */
describe("guard outcome subscription", () => {
  // The second import re-transforms the whole module graph (the candle data
  // files are eagerly globbed), which takes seconds on this machine.
  it("writes one outcome line even after the module is evaluated again", { timeout: 30_000 }, async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { body: string }) => {
      posts.push(init.body);
      return Promise.resolve({ ok: true });
    }));

    const closed = {
      eventType: "PositionRealized",
      _entity: {
        id: "x", accountId: "a", symbolName: "ETHUSD", side: "LONG", quantity: 1,
        entryPrice: 100, exitPrice: 90, realizedPnl: -10, commission: 0, swap: 0,
        openedAt: "2026-10-20T09:00:00Z", closedAt: "2026-10-20T10:00:00Z",
      },
    };

    // First evaluation: the module subscribes.
    await import("../guard/guardRuntime.ts");
    // Second evaluation, different specifier: what the browser does on HMR.
    // The query string is what makes it a fresh module instance; tsc has no
    // type for a specifier with a query, but Vite resolves it at runtime.
    // @ts-expect-error -- query specifier has no type declaration
    await import("../guard/guardRuntime.ts?reload=1");

    publish("closed-positions", closed);
    await new Promise((r) => setImmediate(r));

    expect(posts).toHaveLength(1);
  });
});
