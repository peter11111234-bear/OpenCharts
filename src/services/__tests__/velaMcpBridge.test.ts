import { afterEach, describe, expect, it, vi } from "vitest";
import { createVelaMcp, isLocalRequest, NO_PAGE, type BridgeReq, type BridgeRes } from "../vela-mcp/bridge.ts";

function req(method: string, body?: string, headers: Record<string, string> = { host: "127.0.0.1:5173" }, url = "/") {
  const handlers: Record<string, Array<(c?: unknown) => void>> = {};
  const r: BridgeReq & { emit(ev: string, c?: unknown): void } = {
    method,
    url,
    headers,
    on(ev, cb) {
      (handlers[ev] ??= []).push(cb);
      return r;
    },
    emit(ev, c) {
      for (const cb of handlers[ev] ?? []) cb(c);
    },
  };
  if (body !== undefined) {
    queueMicrotask(() => {
      r.emit("data", new TextEncoder().encode(body));
      r.emit("end");
    });
  }
  return r;
}

function res() {
  const r = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
    body: "",
    setHeader(k: string, v: string) {
      r.headers[k] = v;
    },
    write(c: string) {
      r.chunks.push(c);
    },
    end(c?: string) {
      r.ended = true;
      r.body = c ?? "";
    },
  };
  return r as BridgeRes & typeof r;
}

/** id null = a notification (no id field). */
const rpcBody = (method: string, params?: unknown, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });

/** The last command the page received over SSE. */
function lastCommand(page: ReturnType<typeof res>) {
  const data = page.chunks.filter((c) => c.startsWith("data: ")).at(-1)!;
  return JSON.parse(data.slice(6)) as { id: number; name: string; args: unknown };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isLocalRequest", () => {
  it("accepts loopback hosts with or without a same-host origin", () => {
    expect(isLocalRequest(req("GET", undefined, { host: "localhost:5173" }))).toBe(true);
    expect(isLocalRequest(req("GET", undefined, { host: "[::1]:5173" }))).toBe(true);
    expect(isLocalRequest(req("GET", undefined, { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" }))).toBe(true);
  });

  it("rejects a rebinding host and a foreign origin", () => {
    expect(isLocalRequest(req("GET", undefined, { host: "evil.example:5173" }))).toBe(false);
    expect(isLocalRequest(req("GET", undefined, { host: "127.0.0.1:5173", origin: "http://evil.example" }))).toBe(false);
    expect(isLocalRequest(req("GET", undefined, {}))).toBe(false);
  });
});

describe("createVelaMcp — /__mcp", () => {
  it("initialize answers JSON; a notification gets 202 with no body", async () => {
    const mcp = createVelaMcp();
    const r1 = res();
    await mcp.rpc(req("POST", rpcBody("initialize", { protocolVersion: "2025-06-18" })), r1);
    expect(r1.statusCode).toBe(200);
    expect(r1.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(r1.body).result.serverInfo.name).toBe("vela");
    const r2 = res();
    await mcp.rpc(req("POST", rpcBody("notifications/initialized", undefined, null)), r2);
    expect(r2.statusCode).toBe(202);
    expect(r2.body).toBe("");
  });

  it("GET is 405, a foreign host 403, bad JSON a -32700 error", async () => {
    const mcp = createVelaMcp();
    const g = res();
    await mcp.rpc(req("GET"), g);
    expect(g.statusCode).toBe(405);
    const f = res();
    await mcp.rpc(req("POST", rpcBody("ping"), { host: "evil.example" }), f);
    expect(f.statusCode).toBe(403);
    const b = res();
    await mcp.rpc(req("POST", "{not json"), b);
    expect(JSON.parse(b.body).error.code).toBe(-32700);
  });

  it("a tool call with no page open is an MCP error, not a success", async () => {
    const mcp = createVelaMcp();
    const r = res();
    await mcp.rpc(req("POST", rpcBody("tools/call", { name: "quote_get", arguments: {} })), r);
    const result = JSON.parse(r.body).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(NO_PAGE);
  });
});

describe("createVelaMcp — page bridge", () => {
  it("relays a call to the page and returns the page's answer", async () => {
    const mcp = createVelaMcp();
    const page = res();
    mcp.bridge(req("GET"), page);
    expect(page.headers["Content-Type"]).toBe("text/event-stream");
    const pending = mcp.call("chart_set_timeframe", { timeframe: "5" });
    const cmd = lastCommand(page);
    expect(cmd).toMatchObject({ name: "chart_set_timeframe", args: { timeframe: "5" } });
    const answer = { content: [{ type: "text", text: "done" }] };
    const r = res();
    await mcp.result(req("POST", JSON.stringify({ id: cmd.id, result: answer })), r);
    expect(r.statusCode).toBe(204);
    await expect(pending).resolves.toEqual(answer);
  });

  it("times out with an error; Pine timeouts mention the frozen page", async () => {
    vi.useFakeTimers();
    const mcp = createVelaMcp({ timeoutMs: 1_000, pineTimeoutMs: 5_000 });
    mcp.bridge(req("GET"), res());
    const quick = mcp.call("quote_get", {});
    const pine = mcp.call("pine_add", { source: "x" });
    await vi.advanceTimersByTimeAsync(1_000);
    const q = await quick;
    expect(q.isError).toBe(true);
    await vi.advanceTimersByTimeAsync(4_000);
    const p = await pine;
    expect(p.isError).toBe(true);
    expect((p.content[0] as { text: string }).text).toContain("重新整理");
  });

  it("a page disconnect fails pending calls at once", async () => {
    const mcp = createVelaMcp();
    const pageReq = req("GET");
    mcp.bridge(pageReq, res());
    const pending = mcp.call("quote_get", {});
    pageReq.emit("close");
    expect((await pending).isError).toBe(true);
    expect(mcp.connected()).toBe(false);
  });

  it("the newest tab wins; the old one is told it was replaced", async () => {
    const mcp = createVelaMcp();
    const oldPage = res();
    const oldReq = req("GET");
    mcp.bridge(oldReq, oldPage);
    const newPage = res();
    mcp.bridge(req("GET"), newPage);
    expect(oldPage.chunks.some((c) => c.startsWith("event: replaced"))).toBe(true);
    expect(oldPage.ended).toBe(true);
    oldReq.emit("close");
    expect(mcp.connected()).toBe(true);
    void mcp.call("quote_get", {});
    expect(lastCommand(newPage).name).toBe("quote_get");
  });

  it("rejects malformed results and unknown ids do nothing", async () => {
    const mcp = createVelaMcp();
    const bad = res();
    await mcp.result(req("POST", JSON.stringify({ id: "1" })), bad);
    expect(bad.statusCode).toBe(400);
    const unknown = res();
    await mcp.result(req("POST", JSON.stringify({ id: 999, result: { content: [] } })), unknown);
    expect(unknown.statusCode).toBe(204);
  });
});
