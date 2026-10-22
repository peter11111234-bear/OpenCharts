import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, streamChat } from "../ai-assistant/chat.ts";
import { taipeiToMs, type ChartSnapshot } from "../ai-assistant/tools.ts";

/** A fetch whose body streams `chunks` (split anywhere, like a real socket). */
function sseFetch(chunks: string[], status = 200) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
}

const line = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

describe("streamChat", () => {
  it("streams text and assembles tool-call deltas split across chunks", async () => {
    const all =
      line({ role: "assistant" }) +
      line({ content: "支撐在 " }) +
      line({ content: "22400" }) +
      line({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "draw_horizontal_line", arguments: "" } }] }) +
      line({ tool_calls: [{ index: 0, function: { arguments: '{"price":224' } }] }) +
      line({ tool_calls: [{ index: 0, function: { arguments: '00,"bias":"bullish"}' } }] }) +
      "data: [DONE]\n\n";
    // Cut mid-line to prove the line buffer.
    const fetchImpl = sseFetch([all.slice(0, 37), all.slice(37, 200), all.slice(200)]);
    const texts: string[] = [];
    const reply = await streamChat([{ role: "user", content: "畫支撐" }], (t) => texts.push(t), fetchImpl);

    expect(texts.join("")).toBe("支撐在 22400");
    expect(reply.content).toBe("支撐在 22400");
    expect(reply.toolCalls).toEqual([
      { id: "call_1", type: "function", function: { name: "draw_horizontal_line", arguments: '{"price":22400,"bias":"bullish"}' } },
    ]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/__ai-chat");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.tools.length).toBeGreaterThan(0);
    expect(sent.model).toBeUndefined(); // the server pins the model
  });

  it("throws with the server message on a non-2xx reply", async () => {
    await expect(streamChat([], () => {}, sseFetch(["LLM proxy unreachable"], 502))).rejects.toThrow("502");
  });
});

describe("buildSystemPrompt", () => {
  it("packs symbol, timeframe, range, bars in Taipei time, indicators and natives", () => {
    const t = taipeiToMs("2026-10-21 13:40")!;
    const snap: ChartSnapshot = {
      symbol: "TMFK6",
      timeframe: "5",
      firstTime: t,
      lastTime: t,
      low: 22400,
      high: 22460,
      lastClose: 22450,
      indicators: [{ id: "ind-1", title: "RSI", inputs: { length: 14 } }],
      nativeTypes: ["vpvr"],
    };
    const p = buildSystemPrompt(snap, [{ time: t, open: 22410, high: 22460, low: 22400, close: 22450, volume: 812 }]);
    expect(p).toContain("商品 TMFK6　週期 5　最新收盤 22450");
    expect(p).toContain("2026-10-21 13:40 O22410 H22460 L22400 C22450 V812");
    expect(p).toContain('id=ind-1 RSI inputs={"length":14}');
    expect(p).toContain("vpvr");
    expect(p).toContain("沒有下單工具");
  });
});
