import { describe, expect, it, vi } from "vitest";
import { TIMEFRAMES } from "../ai-assistant/tools.ts";
import { MCP_TIMEFRAMES, MCP_TOOLS } from "../vela-mcp/mcpTools.ts";
import { handleRpc, PROTOCOL_VERSIONS, textResult } from "../vela-mcp/protocol.ts";

const never = vi.fn(async () => textResult("unused"));

describe("handleRpc", () => {
  it("initialize echoes a known protocol version and names the server", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, never);
    expect(r?.id).toBe(1);
    expect(r?.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "vela" }, capabilities: { tools: {} } });
  });

  it("initialize answers an unknown version with the newest one", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, never);
    expect((r?.result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it("a notification gets no response", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, never)).toBeNull();
  });

  it("tools/list returns every tool, and none of them places orders", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, never);
    const tools = (r?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(tools.some((t) => /order|trade|buy|sell/i.test(t.name))).toBe(false);
  });

  it("tools/call passes name and arguments through", async () => {
    const call = vi.fn(async () => textResult("ok"));
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "chart_set_timeframe", arguments: { timeframe: "5" } } },
      call,
    );
    expect(call).toHaveBeenCalledWith("chart_set_timeframe", { timeframe: "5" });
    expect(r?.result).toEqual(textResult("ok"));
  });

  it("tools/call with an unknown tool is a JSON-RPC error, not a call", async () => {
    const call = vi.fn(async () => textResult("ok"));
    const r = await handleRpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "place_order" } }, call);
    expect(r?.error?.code).toBe(-32602);
    expect(call).not.toHaveBeenCalled();
  });

  it("a throwing tool becomes an isError result", async () => {
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "quote_get", arguments: {} } },
      async () => {
        throw new Error("boom");
      },
    );
    expect(r?.result).toMatchObject({ isError: true });
  });

  it("rejects malformed messages and unknown methods", async () => {
    expect((await handleRpc([], never))?.error?.code).toBe(-32600);
    expect((await handleRpc({ jsonrpc: "1.0", id: 1, method: "ping" }, never))?.error?.code).toBe(-32600);
    expect((await handleRpc({ jsonrpc: "2.0", id: 7, method: "resources/list" }, never))?.error?.code).toBe(-32601);
    expect((await handleRpc({ jsonrpc: "2.0", id: 8, method: "ping" }, never))?.result).toEqual({});
  });
});

describe("mcpTools", () => {
  it("timeframes match the AI assistant's list (copied to keep vite.config deps inside vela-mcp/)", () => {
    expect([...MCP_TIMEFRAMES]).toEqual([...TIMEFRAMES]);
  });
});
