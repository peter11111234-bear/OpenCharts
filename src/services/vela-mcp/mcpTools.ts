/**
 * The MCP tool list external agents (Claude Code, OMP) see when they connect to
 * /__mcp. Names follow tradingview-mcp (tradesdontlie) so prompts written for
 * that server carry over; only the subset Vela can do safely is offered.
 *
 * There is deliberately no order / trade tool. Times cross the boundary as
 * Taipei wall clock "YYYY-MM-DD HH:mm" (see ai-assistant/tools.ts).
 */

/** Same list as ai-assistant/tools.ts TIMEFRAMES (a test keeps them equal). Copied, not
 *  imported: this file is a vite.config.ts dependency, and Vite restarts on any change to
 *  one — importing tools.ts would make every AI-panel edit break the open /vela. */
export const MCP_TIMEFRAMES = ["1", "3", "5", "15", "30", "60", "240", "D", "W"] as const;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const TIME = { type: "string", description: 'Taipei time "YYYY-MM-DD HH:mm"' };
const BIAS = {
  type: "string",
  enum: ["bullish", "bearish"],
  description: "bullish = 偏多／壓力突破 (red #f23645), bearish = 偏空／跌破支撐 (green #089981)",
};
const NONE = { type: "object" as const, properties: {} };

/** Pine sources above this many characters are refused (a heavy script freezes /vela). */
export const PINE_MAX_CHARS = 20_000;
export const OHLCV_MAX_BARS = 300;

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "chart_get_state",
    description: "Current chart: symbol, timeframe, visible range, indicators (id, title, inputs, added_by_mcp), drawing counts.",
    inputSchema: NONE,
  },
  {
    name: "data_get_ohlcv",
    description: `Latest bars of the current chart (oldest first). count 1–${OHLCV_MAX_BARS}, default 100. Cached ~30 s.`,
    inputSchema: { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: OHLCV_MAX_BARS } } },
  },
  {
    name: "quote_get",
    description: "Last price of the current chart symbol: last bar close, change vs previous bar, bar time.",
    inputSchema: NONE,
  },
  {
    name: "data_get_study_values",
    description: "Latest value of every plot of every indicator on the chart.",
    inputSchema: NONE,
  },
  {
    name: "chart_set_symbol",
    description: "Switch the chart symbol. Futures: TMF / MXF only (never TXF 大台), e.g. TMFK6 or TMFR1; stocks: 2330, TSE:2330, OTC:6488.",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
  {
    name: "chart_set_timeframe",
    description: "Switch the chart timeframe (minutes, or D / W).",
    inputSchema: { type: "object", properties: { timeframe: { type: "string", enum: [...MCP_TIMEFRAMES] } }, required: ["timeframe"] },
  },
  {
    name: "chart_set_visible_range",
    description: "Show exactly this time window.",
    inputSchema: { type: "object", properties: { from: TIME, to: TIME }, required: ["from", "to"] },
  },
  {
    name: "chart_scroll_to_date",
    description: "Center the chart on a time, keeping the current zoom.",
    inputSchema: { type: "object", properties: { date: TIME }, required: ["date"] },
  },
  {
    name: "draw_shape",
    description:
      "Draw on the current chart. horizontal_line needs price; trend_line needs from_time/from_price/to_time/to_price; arrow_mark needs time/price/text. Prices must lie near the recent bars' range. Returns the drawing id.",
    inputSchema: {
      type: "object",
      properties: {
        shape: { type: "string", enum: ["horizontal_line", "trend_line", "arrow_mark"] },
        bias: BIAS,
        price: { type: "number" },
        time: TIME,
        from_time: TIME,
        from_price: { type: "number" },
        to_time: TIME,
        to_price: { type: "number" },
        text: { type: "string", description: "Label (max 40 chars); required for arrow_mark" },
      },
      required: ["shape", "bias"],
    },
  },
  {
    name: "draw_list",
    description: "Drawings this MCP session created (id, type, anchors), plus how many the trader drew.",
    inputSchema: NONE,
  },
  {
    name: "draw_remove_one",
    description: "Remove one drawing this MCP session created. The trader's own drawings cannot be removed.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "draw_clear",
    description: "Remove every drawing this MCP session created. The trader's own drawings stay.",
    inputSchema: NONE,
  },
  {
    name: "indicator_add",
    description: "Add a built-in indicator by type (see chart_get_state.native_types).",
    inputSchema: { type: "object", properties: { type: { type: "string" } }, required: ["type"] },
  },
  {
    name: "indicator_set_inputs",
    description: "Change inputs of an indicator on the chart; keys and value types must match chart_get_state.",
    inputSchema: {
      type: "object",
      properties: { indicator_id: { type: "string" }, inputs: { type: "object" } },
      required: ["indicator_id", "inputs"],
    },
  },
  {
    name: "indicator_remove",
    description: "Remove an indicator this MCP session added (indicator_add / pine_add). The trader's own indicators stay.",
    inputSchema: { type: "object", properties: { indicator_id: { type: "string" } }, required: ["indicator_id"] },
  },
  {
    name: "capture_screenshot",
    description: "PNG of the current chart (DOM overlays such as tables and the legend are not included).",
    inputSchema: NONE,
  },
  {
    name: "pine_compile",
    description: `Compile and run a Pine v6 script once, report errors / warnings / last plot values, then take it off the chart. Max ${PINE_MAX_CHARS} chars.`,
    inputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
  },
  {
    name: "pine_add",
    description: `Run a Pine v6 script and keep it on the chart (removable with indicator_remove). Max ${PINE_MAX_CHARS} chars.`,
    inputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
  },
];

export const MCP_TOOL_NAMES: ReadonlySet<string> = new Set(MCP_TOOLS.map((t) => t.name));

/** Tools that may run a Pine script (longer bridge timeout, freeze warning). */
export const PINE_TOOLS: ReadonlySet<string> = new Set(["pine_compile", "pine_add"]);
