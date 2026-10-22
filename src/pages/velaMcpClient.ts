/**
 * Connects the open /vela page to the dev server's MCP bridge (side effect,
 * imported once by VelaPage). External agents (Claude Code, OMP) call
 * http://localhost:5173/__mcp; the bridge relays each tool call here over SSE
 * and this page answers with what the chart shows (services/vela-mcp/).
 *
 * One EventSource per tab (module singleton); the newest tab wins on the
 * server side. The attachment only keeps the latest WidgetContext — its
 * getters resolve to the selected chart cell at call time.
 *
 * Import from "@luxalgo/vela/plugin", NOT the root barrel (separate module
 * instances — see velaPineEditor.ts header).
 */
import { registerWidgetAttachment, type WidgetContext } from "@luxalgo/vela/plugin";
import { ShioajiVelaProvider } from "../services/shioaji/velaProvider.ts";
import { createBarsGate } from "../services/vela-mcp/barsGate.ts";
import { createMcpState, runTool } from "../services/vela-mcp/handlers.ts";
import { OHLCV_MAX_BARS } from "../services/vela-mcp/mcpTools.ts";
import { textResult, type ToolResult } from "../services/vela-mcp/protocol.ts";
import { lookbackMs } from "./techRating.ts";

const provider = new ShioajiVelaProvider();
const bars = createBarsGate(
  (symbol, timeframe) => {
    const to = Date.now();
    return provider.getBars(symbol, timeframe, { from: to - lookbackMs(timeframe), to, limit: OHLCV_MAX_BARS });
  },
  { ttlMs: 30_000, minGapMs: 2_000 },
);
const state = createMcpState();

let current: WidgetContext | null = null;
let source: EventSource | null = null;

async function answer(id: number, name: string, args: Record<string, unknown>): Promise<void> {
  let result: ToolResult;
  try {
    result = current
      ? await runTool(current, state, { bars }, name, args)
      : textResult("圖表還沒準備好", true);
  } catch (e) {
    result = textResult(`工具執行失敗：${e instanceof Error ? e.message : String(e)}`, true);
  }
  await fetch("/__mcp/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, result }),
  }).catch(() => undefined);
}

function connect(): void {
  if (source) return;
  source = new EventSource("/__mcp/bridge");
  source.onmessage = (e) => {
    let msg: { id?: unknown; name?: unknown; args?: unknown };
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (typeof msg.id !== "number" || typeof msg.name !== "string") return;
    const args = typeof msg.args === "object" && msg.args !== null ? (msg.args as Record<string, unknown>) : {};
    void answer(msg.id, msg.name, args);
  };
  // Another tab took over: stop, so the two tabs do not keep stealing the bridge.
  source.addEventListener("replaced", () => {
    source?.close();
  });
}

registerWidgetAttachment({
  id: "opencharts.vela-mcp",
  mount(ctx) {
    current = ctx;
    connect();
    return () => {
      if (current === ctx) current = null;
    };
  },
});
