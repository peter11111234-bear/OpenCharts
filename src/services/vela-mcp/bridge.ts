/**
 * Dev-server side of the Vela MCP server (wired into Vite by velaMcpPlugin).
 *
 *   MCP client ──POST /__mcp (JSON-RPC)──▶ Vite ──SSE /__mcp/bridge──▶ /vela page
 *                                           ◀──POST /__mcp/result────── (handlers.ts)
 *
 * The chart lives in the browser, so a tool call is relayed to the open /vela
 * page and the page's answer is returned. No page, a dropped page or a timeout
 * is an MCP error, never a success. The newest page connection wins.
 *
 * Only loopback Host headers are served: MCP clients send no Origin, so the
 * Host check is the DNS-rebinding defence on an endpoint that drives the chart.
 * Written against minimal req/res shapes (no @types/node in this repo).
 */
import type { Plugin } from "vite";
import { PINE_TOOLS } from "./mcpTools.ts";
import { handleRpc, textResult, type ToolResult } from "./protocol.ts";

export interface BridgeReq {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, cb: (chunk?: unknown) => void): unknown;
}

export interface BridgeRes {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}

export interface VelaMcpOptions {
  timeoutMs?: number;
  pineTimeoutMs?: number;
  keepAliveMs?: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RPC_MAX_BODY = 1024 * 1024;
/** A chart PNG as base64 can be several MB. */
const RESULT_MAX_BODY = 16 * 1024 * 1024;

export const NO_PAGE = "Vela 頁面沒有開著或沒連上：請在瀏覽器開 http://localhost:5173/vela 後再試";

function header(req: BridgeReq, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function hostname(hostPort: string): string {
  return hostPort.startsWith("[") ? hostPort.slice(0, hostPort.indexOf("]") + 1) : hostPort.split(":")[0]!;
}

/** Loopback Host, and a same-host loopback Origin when one is sent. */
export function isLocalRequest(req: BridgeReq): boolean {
  const host = header(req, "host");
  if (!host || !LOCAL_HOSTS.has(hostname(host))) return false;
  const origin = header(req, "origin");
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host === host && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function readBody(req: BridgeReq, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    let body = "";
    let size = 0;
    let tooLarge = false;
    // Streaming decode: a multi-byte character (繁中 in Pine sources) can straddle two chunks.
    const dec = new TextDecoder();
    req.on("data", (chunk) => {
      if (tooLarge) return;
      const s = typeof chunk === "string" ? chunk : dec.decode(chunk as Uint8Array, { stream: true });
      size += s.length;
      if (size > max) {
        tooLarge = true;
        body = "";
        return;
      }
      body += s;
    });
    req.on("end", () => resolve(tooLarge ? null : body + dec.decode()));
  });
}

function end(res: BridgeRes, status: number, body?: string, type?: string): void {
  res.statusCode = status;
  if (type) res.setHeader("Content-Type", type);
  res.end(body);
}

interface Pending {
  resolve(r: ToolResult): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createVelaMcp(opts: VelaMcpOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pineTimeoutMs = opts.pineTimeoutMs ?? 30_000;
  const keepAliveMs = opts.keepAliveMs ?? 15_000;
  let page: BridgeRes | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function settle(id: number, r: ToolResult): void {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(r);
  }

  function failAll(msg: string): void {
    for (const id of [...pending.keys()]) settle(id, textResult(msg, true));
  }

  /** Relay one tool call to the page and wait for its answer. */
  function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!page) return Promise.resolve(textResult(NO_PAGE, true));
    const id = nextId++;
    const pine = PINE_TOOLS.has(name);
    const ms = pine ? pineTimeoutMs : timeoutMs;
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        const hint = pine ? "；如果 /vela 頁面卡住，是腳本太重凍結了頁面，請重新整理" : "";
        settle(id, textResult(`Vela 頁面 ${ms / 1000} 秒內沒回應${hint}`, true));
      }, ms);
      pending.set(id, { resolve, timer });
      page!.write(`data: ${JSON.stringify({ id, name, args })}\n\n`);
    });
  }

  /** POST /__mcp — the MCP endpoint (Streamable HTTP, JSON responses). */
  async function rpc(req: BridgeReq, res: BridgeRes): Promise<void> {
    if (!isLocalRequest(req)) return end(res, 403);
    if (req.url && req.url !== "/" && !req.url.startsWith("/?")) return end(res, 404);
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return end(res, 405);
    }
    const body = await readBody(req, RPC_MAX_BODY);
    if (body === null) return end(res, 413);
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      const parseErr = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
      return end(res, 400, JSON.stringify(parseErr), "application/json");
    }
    const reply = await handleRpc(msg, call);
    if (reply === null) return end(res, 202);
    end(res, 200, JSON.stringify(reply), "application/json");
  }

  /** GET /__mcp/bridge — the /vela page's command stream (SSE). */
  function bridge(req: BridgeReq, res: BridgeRes): void {
    if (!isLocalRequest(req)) return end(res, 403);
    if (req.method !== "GET") return end(res, 405);
    if (page) {
      page.write("event: replaced\ndata: {}\n\n");
      page.end();
      failAll("Vela 頁面換成另一個分頁，這個呼叫已取消，請重試");
    }
    const me = res;
    page = me;
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write("retry: 2000\n\n");
    const ping = setInterval(() => me.write(": ping\n\n"), keepAliveMs);
    req.on("close", () => {
      clearInterval(ping);
      if (page !== me) return;
      page = null;
      failAll("Vela 頁面中斷連線（重新整理或關閉了），這個呼叫沒有完成");
    });
  }

  /** POST /__mcp/result — the page's answer {id, result}. */
  async function result(req: BridgeReq, res: BridgeRes): Promise<void> {
    if (!isLocalRequest(req)) return end(res, 403);
    if (req.method !== "POST") return end(res, 405);
    const body = await readBody(req, RESULT_MAX_BODY);
    if (body === null) return end(res, 413);
    let msg: { id?: unknown; result?: ToolResult } | null = null;
    try {
      msg = JSON.parse(body);
    } catch {
      msg = null;
    }
    if (!msg || typeof msg.id !== "number" || !msg.result || !Array.isArray(msg.result.content)) return end(res, 400);
    settle(msg.id, msg.result);
    end(res, 204);
  }

  return { rpc, bridge, result, call, connected: () => page !== null };
}

export function velaMcpPlugin(opts: VelaMcpOptions = {}): Plugin {
  return {
    name: "vela-mcp",
    configureServer(server) {
      const mcp = createVelaMcp(opts);
      // Sub-paths first: connect's "/__mcp" prefix also matches them.
      server.middlewares.use("/__mcp/bridge", (req, res) => mcp.bridge(req as unknown as BridgeReq, res as unknown as BridgeRes));
      server.middlewares.use("/__mcp/result", (req, res) => void mcp.result(req as unknown as BridgeReq, res as unknown as BridgeRes));
      server.middlewares.use("/__mcp", (req, res) => void mcp.rpc(req as unknown as BridgeReq, res as unknown as BridgeRes));
    },
  };
}
