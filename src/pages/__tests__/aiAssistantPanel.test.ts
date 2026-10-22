import { describe, expect, it, vi } from "vitest";
import type { ChatReply } from "../../services/ai-assistant/chat.ts";
import { taipeiToMs, UP_COLOR, type ChartAction, type ChartSnapshot } from "../../services/ai-assistant/tools.ts";
import { applyAction, mountAiAssistantPanel, type AssistantChartCtx, type AssistantDeps } from "../aiAssistantPanel.ts";

const T = taipeiToMs("2026-10-21 13:00")!;
const snap: ChartSnapshot = {
  symbol: "TMFK6",
  timeframe: "5",
  firstTime: T - 3_600_000,
  lastTime: T,
  low: 22300,
  high: 22600,
  lastClose: 22450,
  indicators: [],
  nativeTypes: [],
};
const bars = [{ time: T, open: 22440, high: 22460, low: 22430, close: 22450, volume: 10 }];

function mockCtx(symbol = "TMFK6") {
  const add = vi.fn(() => ({}));
  const setInputs = vi.fn();
  const ctx: AssistantChartCtx = {
    symbol,
    setSymbol: vi.fn(),
    setTimeframe: vi.fn(),
    addNativeIndicator: vi.fn(),
    chart: { drawings: { add: add as never }, indicators: () => [{ id: "ind-1", setInputs }] },
  };
  return { ctx, add, setInputs };
}

const toolReply = (name: string, args: unknown): ChatReply => ({
  content: "",
  toolCalls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("applyAction", () => {
  it("draws an hline with ms anchor and 紅漲 color", () => {
    const { ctx, add } = mockCtx();
    const a: ChartAction = { kind: "hline", anchor: { time: T, price: 22400 }, label: "支撐", color: UP_COLOR };
    expect(applyAction(ctx, a, "TMFK6")).toBeNull();
    expect(add).toHaveBeenCalledWith("hline", {
      anchors: [{ time: T, price: 22400 }],
      style: { lineColor: UP_COLOR, lineWidth: 2 },
      text: { value: "支撐", color: UP_COLOR, size: "normal", hAlign: "right", vAlign: "bottom" },
    });
  });

  it("re-checks prices before Vela (second line of defence)", () => {
    const { ctx, add } = mockCtx();
    for (const price of [0, NaN, Infinity, -1]) {
      expect(applyAction(ctx, { kind: "hline", anchor: { time: T, price }, label: "", color: UP_COLOR }, "TMFK6")).toBe("價格無效");
    }
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses a drawing card after the trader switched symbol", () => {
    const { ctx, add } = mockCtx("TSE:2330");
    const a: ChartAction = { kind: "hline", anchor: { time: T, price: 22400 }, label: "", color: UP_COLOR };
    expect(applyAction(ctx, a, "TMFK6")).toContain("TSE:2330");
    expect(add).not.toHaveBeenCalled();
  });

  it("reports when Vela returns no drawing", () => {
    const { ctx, add } = mockCtx();
    add.mockReturnValueOnce(null as never);
    const a: ChartAction = { kind: "mark", anchor: { time: T, price: 22400 }, dir: "up", text: "突破", color: UP_COLOR };
    expect(applyAction(ctx, a, "TMFK6")).toBe("Vela 沒有建立這個圖形");
    expect(add).toHaveBeenCalledWith("arrowmarkup", expect.objectContaining({ anchors: [{ time: T, price: 22400 }] }));
  });

  it("sets indicator inputs through the live handle", () => {
    const { ctx, setInputs } = mockCtx();
    expect(applyAction(ctx, { kind: "inputs", indicatorId: "ind-1", title: "RSI", inputs: { length: 9 } }, "TMFK6")).toBeNull();
    expect(setInputs).toHaveBeenCalledWith({ length: 9 });
    expect(applyAction(ctx, { kind: "inputs", indicatorId: "gone", title: "MA", inputs: { length: 9 } }, "TMFK6")).toContain("已不在圖上");
  });
});

describe("mountAiAssistantPanel", () => {
  function setup(replies: ChatReply[]) {
    const body = document.createElement("div");
    document.body.appendChild(body);
    const apply = vi.fn<AssistantDeps["apply"]>(() => null);
    const chat = vi.fn<AssistantDeps["chat"]>(async (_m, onText) => {
      const r = replies.shift() ?? { content: "", toolCalls: [] };
      if (r.content) onText(r.content);
      return r;
    });
    const panel = mountAiAssistantPanel(body, { snapshot: async () => ({ snap, bars }), chat, apply });
    const ask = async (q: string) => {
      body.querySelector("textarea")!.value = q;
      body.querySelector("form")!.requestSubmit();
      await flush();
      await flush();
    };
    return { body, chat, apply, panel, ask };
  }

  it("sends the chart context, streams text, and only applies on click", async () => {
    const { body, chat, apply, ask } = setup([
      { content: "量大但收上影線，先等回踩。", toolCalls: toolReply("draw_horizontal_line", { price: 22400, bias: "bullish" }).toolCalls },
    ]);
    await ask("這根量這麼大能追嗎？");

    const sent = chat.mock.calls[0]![0];
    expect(sent[0]!.role).toBe("system");
    expect(sent[0]!.content).toContain("商品 TMFK6");
    expect(sent[1]).toEqual({ role: "user", content: "這根量這麼大能追嗎？" });
    expect(body.textContent).toContain("量大但收上影線");

    const card = body.querySelector(".aia-card")!;
    expect(card.textContent).toContain("畫水平線 22400");
    expect(apply).not.toHaveBeenCalled();
    card.querySelector("button")!.click();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ kind: "hline" }), "TMFK6");
    expect(card.querySelector("button")!.textContent).toBe("已套用");
  });

  it("blocks a bad call, tells the LLM why, and lets it retry once", async () => {
    const { body, chat, ask } = setup([
      toolReply("draw_horizontal_line", { price: 0, bias: "bullish" }),
      toolReply("draw_horizontal_line", { price: 22400, bias: "bullish" }),
    ]);
    await ask("畫支撐");
    await flush();

    expect(chat).toHaveBeenCalledTimes(2);
    expect(body.querySelector(".aia-err")!.textContent).toContain("已擋下");
    const retry = chat.mock.calls[1]![0];
    expect(retry.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c-draw_horizontal_line" });
    expect((retry.at(-1) as { content: string }).content).toContain("錯誤");
    expect(body.querySelectorAll(".aia-card")).toHaveLength(1);
  });

  it("never records an empty assistant turn", async () => {
    const { body, chat, ask } = setup([{ content: "", toolCalls: [] }, { content: "好", toolCalls: [] }]);
    await ask("hi");
    expect(body.textContent).toContain("（AI 沒有回覆）");
    await ask("再一次");
    const second = chat.mock.calls[1]![0];
    expect(second.some((m) => m.role === "assistant")).toBe(false);
    expect(second.at(-1)).toEqual({ role: "user", content: "再一次" });
  });

  it("shows the error when the chat fails, and clears the log", async () => {
    const { body, chat, ask } = setup([]);
    chat.mockRejectedValueOnce(new Error("AI 服務錯誤 502"));
    await ask("hi");
    expect(body.querySelector(".aia-err")!.textContent).toBe("AI 服務錯誤 502");
    (body.querySelectorAll("button")[1] as HTMLButtonElement).click();
    expect(body.querySelector(".aia-log")!.childElementCount).toBe(0);
  });
});
