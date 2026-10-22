/**
 * Chat transport for the VELA AI assistant. The browser POSTs to the dev
 * middleware /__ai-chat (vite.config.ts), which pins the model and forwards to
 * the local LLM proxy; the reply is an OpenAI Chat Completions SSE stream.
 * The whole tool loop runs in this page, so chart actions never travel over a
 * second channel.
 */
import type { OHLCV } from "@luxalgo/vela";
import { msToTaipei, TOOL_DEFS, type ChartSnapshot } from "./tools.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatReply {
  content: string;
  toolCalls: ToolCall[];
}

interface Delta {
  content?: string | null;
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

/** Bars listed verbatim in the prompt; also how many the panel fetches.
 *  Measured 2026-10-21: ~26 prompt tokens per bar, 100 bars ≈ 2.8k, no latency change. */
export const PROMPT_BARS = 100;

/** Stream one completion; `onText` gets each text chunk as it arrives. */
export async function streamChat(
  messages: ChatMessage[],
  onText: (chunk: string) => void,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ChatReply> {
  const res = await fetchImpl("/__ai-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, tools: TOOL_DEFS }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`AI 服務錯誤 ${res.status}: ${(await res.text()).slice(0, 200)}`);

  let content = "";
  const calls: ToolCall[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      let delta: Delta | undefined;
      try {
        delta = (JSON.parse(data) as { choices?: Array<{ delta?: Delta }> }).choices?.[0]?.delta;
      } catch {
        continue; // keep-alive or a partial vendor line: not ours to fail on
      }
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
  }
  return { content, toolCalls: calls.filter(Boolean) };
}

/** System prompt: the chart state the trader is looking at, so a bare
 *  "這根量這麼大能追嗎？" needs no further context. */
export function buildSystemPrompt(snap: ChartSnapshot, bars: readonly OHLCV[]): string {
  const rows = bars
    .slice(-PROMPT_BARS)
    .map((b) => `${msToTaipei(b.time)} O${b.open} H${b.high} L${b.low} C${b.close} V${b.volume ?? 0}`)
    .join("\n");
  const inds = snap.indicators.length
    ? snap.indicators.map((i) => `- id=${i.id} ${i.title} inputs=${JSON.stringify(i.inputs)}`).join("\n")
    : "（無）";
  return [
    "你是 VELA 看盤副駕駛，協助台指期／台股交易員盤中判讀。用繁體中文、精簡回答。",
    "台股慣例紅漲綠跌。交易商品是微台 TMF，不碰大台 TXF。",
    "你只能『提議』圖表操作：呼叫工具會變成卡片，交易員點了才會執行。沒有下單工具，不要假裝能下單。",
    "工具裡的時間一律用台北時間 YYYY-MM-DD HH:mm，從下面 K 棒列表抄；價格要落在圖上區間內。",
    "",
    `商品 ${snap.symbol}　週期 ${snap.timeframe}　最新收盤 ${snap.lastClose}`,
    `K 棒範圍 ${msToTaipei(snap.firstTime)} ～ ${msToTaipei(snap.lastTime)}，區間低 ${snap.low} 高 ${snap.high}`,
    `最近 ${Math.min(bars.length, PROMPT_BARS)} 根 K 棒：`,
    rows,
    "",
    "圖上指標：",
    inds,
    `可加入的內建指標 type：${snap.nativeTypes.join(", ") || "（無）"}`,
  ].join("\n");
}
