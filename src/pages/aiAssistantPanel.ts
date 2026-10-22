/**
 * VELA AI assistant side panel (plain DOM, like hotlists.ts). The trader types
 * a question; the panel snapshots the chart into the system prompt, streams
 * the reply, and turns each tool call into a card. Nothing touches the chart
 * until the trader clicks 套用 on a card (applyAction), so a hallucinated
 * call costs one dismissed card, never a wrong drawing.
 */
import type { OHLCV } from "@luxalgo/vela";
import { buildSystemPrompt, type ChatMessage, type ChatReply } from "../services/ai-assistant/chat.ts";
import {
  checkToolCall,
  describeAction,
  type ChartAction,
  type ChartSnapshot,
} from "../services/ai-assistant/tools.ts";

/** The slice of WidgetContext / Vela that applyAction uses (mockable in tests). */
export interface AssistantChartCtx {
  readonly symbol: string;
  setSymbol(s: string): void;
  setTimeframe(tf: string): void;
  addNativeIndicator(type: string): void;
  readonly chart: {
    drawings: { add(type: never, init?: unknown): unknown };
    indicators(): ReadonlyArray<{ id: string; setInputs(values: Record<string, number | string | boolean>): void }>;
  };
}

export interface AssistantDeps {
  snapshot: () => Promise<{ snap: ChartSnapshot; bars: readonly OHLCV[] }>;
  chat: (messages: ChatMessage[], onText: (chunk: string) => void) => Promise<ChatReply>;
  /** Runs a card; returns an error string, or null on success. */
  apply: (action: ChartAction, snapSymbol: string) => string | null;
}

/** Rounds per question: the second one exists only to let the LLM fix rejected calls. */
const MAX_ROUNDS = 2;

const STYLE_ID = "ai-assistant-style";
const CSS = `
.aia{display:flex;flex-direction:column;height:100%;font-size:13px;color:var(--vela-text,#d1d4dc)}
.aia-log{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px}
.aia-msg{padding:6px 8px;border-radius:6px;white-space:pre-wrap;word-break:break-word;line-height:1.5}
.aia-user{align-self:flex-end;max-width:85%;background:var(--vela-border,#2a2e39)}
.aia-bot{align-self:flex-start;max-width:95%;background:rgba(255,255,255,.04)}
.aia-err{color:#ff9800;font-size:12px}
.aia-card{display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--vela-border,#2a2e39);border-radius:6px}
.aia-card span{flex:1}
.aia-card button,.aia-form button{border:0;border-radius:4px;padding:4px 10px;cursor:pointer;background:#2962ff;color:#fff;font-size:12px}
.aia-card button:disabled,.aia-form button:disabled{opacity:.5;cursor:default}
.aia-form{display:flex;gap:6px;padding:8px;border-top:1px solid var(--vela-border,#2a2e39)}
.aia-form textarea{flex:1;resize:none;height:52px;background:var(--vela-bg,#131722);color:inherit;border:1px solid var(--vela-border,#2a2e39);border-radius:4px;padding:4px 6px;font:inherit}
`;

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

const sanePrice = (p: number) => Number.isFinite(p) && p > 0;

/** Execute one confirmed card on the live chart. Drawings re-check prices here
 *  (second line of defence) and refuse if the trader switched symbol since. */
export function applyAction(ctx: AssistantChartCtx, action: ChartAction, snapSymbol: string): string | null {
  const drawing = action.kind === "hline" || action.kind === "trendline" || action.kind === "mark";
  if ((drawing || action.kind === "inputs") && ctx.symbol !== snapSymbol) {
    return `圖表已切到 ${ctx.symbol}，這張卡是針對 ${snapSymbol}`;
  }
  const add = (type: string, init: unknown) =>
    ctx.chart.drawings.add(type as never, init) ? null : "Vela 沒有建立這個圖形";
  const text = (value: string, color: string) =>
    value ? { value, color, size: "normal", hAlign: "right", vAlign: "bottom" } : undefined;

  switch (action.kind) {
    case "hline":
      if (!sanePrice(action.anchor.price)) return "價格無效";
      return add("hline", {
        anchors: [action.anchor],
        style: { lineColor: action.color, lineWidth: 2 },
        text: text(action.label, action.color),
      });
    case "trendline":
      if (!sanePrice(action.from.price) || !sanePrice(action.to.price)) return "價格無效";
      return add("trendline", {
        anchors: [action.from, action.to],
        style: { lineColor: action.color, lineWidth: 2 },
        text: text(action.label, action.color),
      });
    case "mark":
      if (!sanePrice(action.anchor.price)) return "價格無效";
      return add(action.dir === "up" ? "arrowmarkup" : "arrowmarkdown", {
        anchors: [action.anchor],
        style: { lineColor: action.color },
        text: text(action.text, action.color),
      });
    case "timeframe":
      ctx.setTimeframe(action.timeframe);
      return null;
    case "symbol":
      ctx.setSymbol(action.symbol);
      return null;
    case "inputs": {
      const h = ctx.chart.indicators().find((i) => i.id === action.indicatorId);
      if (!h) return `指標 ${action.title} 已不在圖上`;
      h.setInputs(action.inputs);
      return null;
    }
    case "native":
      ctx.addNativeIndicator(action.type);
      return null;
  }
}

export function mountAiAssistantPanel(body: HTMLElement, deps: AssistantDeps): { destroy(): void } {
  const doc = body.ownerDocument;
  ensureStyles(doc);
  const root = doc.createElement("div");
  root.className = "aia";
  const log = doc.createElement("div");
  log.className = "aia-log";
  const form = doc.createElement("form");
  form.className = "aia-form";
  const input = doc.createElement("textarea");
  input.placeholder = "問 AI 副駕駛（例：這根量這麼大能追嗎？）";
  const send = doc.createElement("button");
  send.type = "submit";
  send.textContent = "送出";
  const clear = doc.createElement("button");
  clear.type = "button";
  clear.textContent = "清除";
  form.append(input, send, clear);
  root.append(log, form);
  body.appendChild(root);

  let history: ChatMessage[] = [];
  let busy = false;
  let destroyed = false;

  const add = (cls: string, text: string) => {
    const el = doc.createElement("div");
    el.className = `aia-msg ${cls}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };

  const addCard = (action: ChartAction, snapSymbol: string) => {
    const card = doc.createElement("div");
    card.className = "aia-card";
    const label = doc.createElement("span");
    label.textContent = describeAction(action);
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.textContent = "套用";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      const err = deps.apply(action, snapSymbol);
      btn.textContent = err ? "失敗" : "已套用";
      if (err) add("aia-err", err);
    });
    card.append(label, btn);
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
  };

  async function ask(question: string) {
    busy = true;
    send.disabled = true;
    add("aia-user", question);
    try {
      const { snap, bars } = await deps.snapshot();
      // The system prompt is rebuilt every question: the chart moved since the last one.
      history = [{ role: "system", content: buildSystemPrompt(snap, bars) }, ...history.slice(1)];
      history.push({ role: "user", content: question });
      for (let round = 0; round < MAX_ROUNDS && !destroyed; round++) {
        const bubble = add("aia-bot", "");
        const reply = await deps.chat(history.slice(), (chunk) => {
          bubble.textContent += chunk;
          log.scrollTop = log.scrollHeight;
        });
        if (!reply.content && !reply.toolCalls.length) {
          // An empty assistant turn is rejected by most OpenAI-style backends on the next request.
          bubble.textContent = "（AI 沒有回覆）";
          break;
        }
        if (!reply.content) bubble.remove();
        history.push({
          role: "assistant",
          content: reply.content || null,
          ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
        });
        let rejected = false;
        for (const call of reply.toolCalls) {
          const r = checkToolCall(call.function.name, call.function.arguments, snap);
          if (r.ok) addCard(r.action, snap.symbol);
          else {
            rejected = true;
            add("aia-err", `已擋下：${r.error}`);
          }
          history.push({
            role: "tool",
            tool_call_id: call.id,
            content: r.ok ? "已顯示為操作卡片，交易員點擊後才會執行。" : `錯誤：${r.error}`,
          });
        }
        if (!rejected) break;
      }
    } catch (e) {
      add("aia-err", e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
      send.disabled = false;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || busy) return;
    input.value = "";
    void ask(q);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  clear.addEventListener("click", () => {
    history = [];
    log.replaceChildren();
  });

  return {
    destroy() {
      destroyed = true;
      root.remove();
    },
  };
}
