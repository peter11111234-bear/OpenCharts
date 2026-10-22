/**
 * Minimal MCP server core (JSON-RPC 2.0 over Streamable HTTP, JSON responses
 * only): initialize, ping, tools/list, tools/call. Hand-rolled because the
 * MCP SDK is not installed and this repo never runs `npm i`. Pure: the HTTP
 * side lives in bridge.ts, the chart side in handlers.ts.
 */
import { MCP_TOOL_NAMES, MCP_TOOLS } from "./mcpTools.ts";

export const SERVER_INFO = { name: "vela", version: "0.1.0" } as const;
/** Newest first; an unknown requested version gets the newest. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

type RpcId = string | number | null;
export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

const INSTRUCTIONS =
  "Vela 看盤（OpenCharts /vela）的圖表控制。只能看圖、切商品週期、畫線、加指標、跑 Pine，沒有下單。" +
  "時間一律用台北時間 YYYY-MM-DD HH:mm。台股紅漲綠跌。期貨只限微台 TMF／小台 MXF。" +
  "改圖的工具會回傳頁面讀回的實際狀態；回 isError 就是沒做成。";

export const textResult = (text: string, isError = false): ToolResult =>
  isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };

const err = (id: RpcId, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
const ok = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One JSON-RPC message → its response, or null for a notification (HTTP 202, no body). */
export async function handleRpc(msg: unknown, callTool: CallTool): Promise<RpcResponse | null> {
  if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return err(null, -32600, "Invalid Request");
  }
  if (!("id" in msg) || msg.id === undefined) return null;
  const id = msg.id as RpcId;
  const params = isObject(msg.params) ? msg.params : {};

  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !MCP_TOOL_NAMES.has(name)) return err(id, -32602, `Unknown tool: ${String(name)}`);
      const args = isObject(params.arguments) ? params.arguments : {};
      try {
        return ok(id, await callTool(name, args));
      } catch (e) {
        return ok(id, textResult(`工具執行失敗：${e instanceof Error ? e.message : String(e)}`, true));
      }
    }
    default:
      return err(id, -32601, `Method not found: ${msg.method}`);
  }
}
