/**
 * Registers the AI 副駕駛 side panel with Vela (side effect, imported once by
 * VelaPage; the dock supplies its toggle button). The panel is aiAssistantPanel.ts; this
 * file wires it to the live chart: the snapshot the LLM sees and the actions
 * a confirmed card runs.
 *
 * Import from "@luxalgo/vela/plugin", NOT the root barrel (separate module
 * instances — see velaPineEditor.ts header).
 */
import { registerIcon, registerSidePanel, type WidgetContext } from "@luxalgo/vela/plugin";
import { svg16 } from "@luxalgo/vela/ui";
import { PROMPT_BARS, streamChat } from "../services/ai-assistant/chat.ts";
import type { ChartSnapshot } from "../services/ai-assistant/tools.ts";
import { ShioajiVelaProvider } from "../services/shioaji/velaProvider.ts";
import { applyAction, mountAiAssistantPanel } from "./aiAssistantPanel.ts";
import { lookbackMs } from "./techRating.ts";

const PANEL_ID = "opencharts.ai-assistant";

const provider = new ShioajiVelaProvider();

/** Read the active chart at question time (ctx getters resolve to the selected cell).
 *  The latest PROMPT_BARS bars regardless of zoom (one request per question, never a
 *  burst): the shioaji history call fetches the whole date range anyway, so 100 bars
 *  cost the server no more than 40. */
async function snapshot(ctx: WidgetContext) {
  const chart = ctx.chart;
  const symbol = ctx.symbol;
  const timeframe = ctx.timeframe;
  const to = Date.now();
  const from = to - lookbackMs(timeframe);
  // A malformed row (0 low/high) would widen the price band down to 0.
  const bars = (await provider.getBars(symbol, timeframe, { from, to, limit: PROMPT_BARS })).filter(
    (b) => b.low > 0 && b.high >= b.low && Number.isFinite(b.close),
  );
  const last = bars.at(-1);
  if (!last) throw new Error(`${symbol} 沒有 K 棒資料`);
  const natives = await chart.availableNativeIndicators();
  const snap: ChartSnapshot = {
    symbol,
    timeframe,
    firstTime: bars[0]!.time,
    lastTime: last.time,
    low: Math.min(...bars.map((b) => b.low)),
    high: Math.max(...bars.map((b) => b.high)),
    lastClose: last.close,
    indicators: chart
      .indicators()
      .filter((h) => h.visible && h.inputs.length > 0)
      .map((h) => ({ id: h.id, title: h.title, inputs: h.inputValues() })),
    nativeTypes: natives.filter((n) => n.supported).map((n) => n.type),
  };
  return { snap, bars };
}

registerIcon("ai-assistant", svg16('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>'));

registerSidePanel({
  id: PANEL_ID,
  title: "AI 副駕駛",
  icon: "ai-assistant",
  width: 360,
  resizable: true,
  minWidth: 280,
  mount(ctx, body) {
    const panel = mountAiAssistantPanel(body, {
      snapshot: () => snapshot(ctx),
      chat: (messages, onText) => streamChat(messages, onText),
      apply: (action, snapSymbol) => applyAction(ctx, action, snapSymbol),
    });
    return {
      destroy() {
        panel.destroy();
      },
    };
  },
});
// No separate topbar toggle: the dock already gives every side panel its own
// icon button, and a second "AI" button duplicated it.
