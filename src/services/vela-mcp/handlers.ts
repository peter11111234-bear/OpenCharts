/**
 * Page side of the Vela MCP server: runs one tool call against the live chart
 * and reports what the chart actually shows afterwards (never a guessed
 * success). Every drawing / indicator change reuses the AI 副駕駛 checks
 * (checkToolCall → applyAction), so the price-band, Taipei-time, symbol
 * whitelist and indicator-key rules are the same ones the panel enforces.
 *
 * MCP may only remove what MCP created (ids tracked in McpState); the
 * trader's own drawings and indicators are never touched.
 */
import type { OHLCV } from "@luxalgo/vela";
import { applyAction } from "../../pages/aiAssistantPanel.ts";
import { checkToolCall, describeAction, msToTaipei, taipeiToMs, type ChartSnapshot } from "../ai-assistant/tools.ts";
import type { FetchBars } from "./barsGate.ts";
import { OHLCV_MAX_BARS, PINE_MAX_CHARS } from "./mcpTools.ts";
import { textResult, type ToolResult } from "./protocol.ts";

type InputScalar = number | string | boolean;

export interface McpIndicator {
  readonly id: string;
  readonly title: string;
  readonly visible: boolean;
  readonly inputs: ReadonlyArray<unknown>;
  inputValues(): Record<string, unknown>;
  setInputs(values: Record<string, InputScalar>): void;
  remove(): void;
  context(select?: ReadonlyArray<"plots">): Promise<{
    plots: Record<string, ReadonlyArray<{ time: number; value: unknown }>>;
  } | null>;
}

export interface McpScriptResult {
  ok: boolean;
  error: Error | null;
  run: {
    readonly id: string;
    readonly title: string;
    readonly kind: string;
    readonly time: number;
    readonly plots: Readonly<Record<string, number | null>>;
    readonly warnings: ReadonlyArray<{ message: string }>;
  } | null;
  remove(): void;
}

export interface McpDrawing {
  id: string;
  type: string;
  anchors: ReadonlyArray<{ time: number; price: number }>;
}

/** The slice of WidgetContext the tools use (mockable in tests). */
export interface McpChartCtx {
  readonly symbol: string;
  readonly timeframe: string;
  setSymbol(s: string): void;
  setTimeframe(tf: string): void;
  addNativeIndicator(type: string): void;
  readonly chart: {
    drawings: {
      add(type: never, init?: unknown): unknown;
      remove(id: string): unknown;
      all(): ReadonlyArray<McpDrawing>;
    };
    indicators(): ReadonlyArray<McpIndicator>;
    availableNativeIndicators(): Promise<ReadonlyArray<{ type: string; supported: boolean }>>;
    getVisibleRange(): { from: number; to: number } | null;
    setVisibleRange(range: { from: number; to: number }): unknown;
    readonly renderer: { screenshot(): string | null };
    runScript(source: string): Promise<McpScriptResult>;
  };
}

/** Ids this page's MCP session created; lost on page reload (then nothing is removable). */
export interface McpState {
  drawings: Set<string>;
  indicators: Set<string>;
}

export const createMcpState = (): McpState => ({ drawings: new Set(), indicators: new Set() });

export interface HandlerDeps {
  /** Gated history read (barsGate.ts): serial, cached, spaced. */
  bars: FetchBars;
}

const json = (o: unknown): ToolResult => textResult(JSON.stringify(o, null, 1));
const fail = (msg: string): ToolResult => textResult(msg, true);

/** Non-price tools still go through checkToolCall; they never read the band fields. */
function stubSnap(ctx: McpChartCtx, extra: Partial<ChartSnapshot>): ChartSnapshot {
  return {
    symbol: ctx.symbol,
    timeframe: ctx.timeframe,
    firstTime: 0,
    lastTime: 0,
    low: 0,
    high: 0,
    lastClose: 0,
    indicators: [],
    nativeTypes: [],
    ...extra,
  };
}

/** Sane bars only: a malformed row (0 low/high) would widen the price band down to 0. */
async function saneBars(ctx: McpChartCtx, deps: HandlerDeps): Promise<OHLCV[]> {
  const bars = (await deps.bars(ctx.symbol, ctx.timeframe)).filter(
    (b) => b.low > 0 && b.high >= b.low && Number.isFinite(b.close),
  );
  if (bars.length === 0) throw new Error(`${ctx.symbol} 沒有 K 棒資料`);
  return bars;
}

async function priceSnap(ctx: McpChartCtx, deps: HandlerDeps): Promise<ChartSnapshot> {
  const symbol = ctx.symbol;
  const bars = await saneBars(ctx, deps);
  const last = bars[bars.length - 1]!;
  return stubSnap(ctx, {
    symbol,
    firstTime: bars[0]!.time,
    lastTime: last.time,
    low: Math.min(...bars.map((b) => b.low)),
    high: Math.max(...bars.map((b) => b.high)),
    lastClose: last.close,
  });
}

const indicatorInfo = (ctx: McpChartCtx) =>
  ctx.chart
    .indicators()
    .filter((h) => h.visible && h.inputs.length > 0)
    .map((h) => ({ id: h.id, title: h.title, inputs: h.inputValues() }));

const SHAPES: Record<string, string> = {
  horizontal_line: "draw_horizontal_line",
  trend_line: "draw_trend_line",
  arrow_mark: "add_mark",
};

function drawArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { shape, text, ...rest } = args;
  if (shape === "arrow_mark") return { ...rest, text };
  return text === undefined ? rest : { ...rest, label: text };
}

function pineSummary(run: NonNullable<McpScriptResult["run"]>) {
  return {
    id: run.id,
    title: run.title,
    kind: run.kind,
    bar_time: msToTaipei(run.time),
    plots: run.plots,
    warnings: run.warnings.map((w) => w.message),
  };
}

/** Never throws: any failure (no bars, Vela error) comes back as an isError result. */
export async function runTool(
  ctx: McpChartCtx,
  state: McpState,
  deps: HandlerDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    return await dispatch(ctx, state, deps, name, args);
  } catch (e) {
    return fail(`工具執行失敗：${e instanceof Error ? e.message : String(e)}`);
  }
}

async function dispatch(
  ctx: McpChartCtx,
  state: McpState,
  deps: HandlerDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const chart = ctx.chart;
  switch (name) {
    case "chart_get_state": {
      const range = chart.getVisibleRange();
      const all = chart.drawings.all();
      const natives = await chart.availableNativeIndicators();
      return json({
        symbol: ctx.symbol,
        timeframe: ctx.timeframe,
        visible_range: range ? { from: msToTaipei(range.from), to: msToTaipei(range.to) } : null,
        indicators: chart.indicators().map((h) => ({
          id: h.id,
          title: h.title,
          visible: h.visible,
          inputs: h.inputValues(),
          added_by_mcp: state.indicators.has(h.id),
        })),
        native_types: natives.filter((n) => n.supported).map((n) => n.type),
        drawings: {
          by_mcp: all.filter((d) => state.drawings.has(d.id)).length,
          by_trader: all.filter((d) => !state.drawings.has(d.id)).length,
        },
      });
    }

    case "data_get_ohlcv": {
      const raw = typeof args.count === "number" ? Math.floor(args.count) : 100;
      const count = Math.min(Math.max(raw, 1), OHLCV_MAX_BARS);
      const bars = (await saneBars(ctx, deps)).slice(-count);
      return json({
        symbol: ctx.symbol,
        timeframe: ctx.timeframe,
        columns: ["time", "open", "high", "low", "close", "volume"],
        bars: bars.map((b) => [msToTaipei(b.time), b.open, b.high, b.low, b.close, b.volume]),
      });
    }

    case "quote_get": {
      const bars = await saneBars(ctx, deps);
      const last = bars[bars.length - 1]!;
      const prev = bars.length > 1 ? bars[bars.length - 2]! : null;
      return json({
        symbol: ctx.symbol,
        timeframe: ctx.timeframe,
        bar_time: msToTaipei(last.time),
        last: last.close,
        change: prev ? +(last.close - prev.close).toFixed(4) : null,
        change_pct: prev && prev.close ? +(((last.close - prev.close) / prev.close) * 100).toFixed(2) : null,
      });
    }

    case "data_get_study_values": {
      const out = [];
      for (const h of chart.indicators()) {
        const snap = await h.context(["plots"]);
        const values: Record<string, number | null> = {};
        for (const [key, points] of Object.entries(snap?.plots ?? {})) {
          const v = points[points.length - 1]?.value;
          values[key] = typeof v === "number" && Number.isFinite(v) ? v : null;
        }
        out.push({ id: h.id, title: h.title, values });
      }
      return json({ symbol: ctx.symbol, timeframe: ctx.timeframe, indicators: out });
    }

    case "chart_set_symbol":
    case "chart_set_timeframe": {
      const tool = name === "chart_set_symbol" ? "set_symbol" : "set_timeframe";
      const checked = checkToolCall(tool, JSON.stringify(args), stubSnap(ctx, {}));
      if (!checked.ok) return fail(checked.error);
      const err = applyAction(ctx, checked.action, ctx.symbol);
      if (err) return fail(err);
      const want = checked.action.kind === "symbol" ? checked.action.symbol : (args.timeframe as string);
      const now = name === "chart_set_symbol" ? ctx.symbol : ctx.timeframe;
      return json({
        requested: want,
        chart_now: now,
        note: now === want ? "已切換" : "圖表目前顯示的值和要求不同（可能還在載入，稍後用 chart_get_state 確認）",
      });
    }

    case "chart_set_visible_range": {
      const from = taipeiToMs(String(args.from ?? ""));
      const to = taipeiToMs(String(args.to ?? ""));
      if (from === null || to === null) return fail("時間格式要用 YYYY-MM-DD HH:mm（台北時間）");
      if (from >= to) return fail("from 要早於 to");
      chart.setVisibleRange({ from, to });
      const r = chart.getVisibleRange();
      return json({ visible_range: r ? { from: msToTaipei(r.from), to: msToTaipei(r.to) } : null });
    }

    case "chart_scroll_to_date": {
      const t = taipeiToMs(String(args.date ?? ""));
      if (t === null) return fail("時間格式要用 YYYY-MM-DD HH:mm（台北時間）");
      const cur = chart.getVisibleRange();
      if (!cur) return fail("圖表還沒有資料");
      const half = (cur.to - cur.from) / 2;
      chart.setVisibleRange({ from: t - half, to: t + half });
      const r = chart.getVisibleRange();
      return json({ visible_range: r ? { from: msToTaipei(r.from), to: msToTaipei(r.to) } : null });
    }

    case "draw_shape": {
      const tool = SHAPES[String(args.shape)];
      if (!tool) return fail(`shape 要是 ${Object.keys(SHAPES).join(" / ")}`);
      const snap = await priceSnap(ctx, deps);
      const checked = checkToolCall(tool, JSON.stringify(drawArgs(args)), snap);
      if (!checked.ok) return fail(checked.error);
      const before = new Set(chart.drawings.all().map((d) => d.id));
      const err = applyAction(ctx, checked.action, snap.symbol);
      if (err) return fail(err);
      const created = chart.drawings.all().filter((d) => !before.has(d.id));
      if (created.length === 0) return fail("Vela 沒有建立這個圖形");
      for (const d of created) state.drawings.add(d.id);
      return json({ id: created[0]!.id, drawn: describeAction(checked.action) });
    }

    case "draw_list": {
      const all = chart.drawings.all();
      const live = new Set(all.map((d) => d.id));
      for (const id of state.drawings) if (!live.has(id)) state.drawings.delete(id);
      return json({
        by_mcp: all
          .filter((d) => state.drawings.has(d.id))
          .map((d) => ({ id: d.id, type: d.type, anchors: d.anchors.map((a) => [msToTaipei(a.time), a.price]) })),
        by_trader_count: all.length - state.drawings.size,
      });
    }

    case "draw_remove_one": {
      const id = String(args.id ?? "");
      if (!state.drawings.has(id)) return fail(`${id} 不是 MCP 畫的，不能刪（交易員自己的圖形不動）`);
      chart.drawings.remove(id);
      state.drawings.delete(id);
      if (chart.drawings.all().some((d) => d.id === id)) return fail(`${id} 刪除後仍在圖上`);
      return json({ removed: id });
    }

    case "draw_clear": {
      const live = new Set(chart.drawings.all().map((d) => d.id));
      const ids = [...state.drawings].filter((id) => live.has(id));
      for (const id of ids) chart.drawings.remove(id);
      state.drawings.clear();
      const left = chart.drawings.all().filter((d) => ids.includes(d.id)).map((d) => d.id);
      if (left.length) return fail(`這些沒刪掉：${left.join(", ")}`);
      return json({ removed: ids.length });
    }

    case "indicator_add": {
      const natives = await chart.availableNativeIndicators();
      const snap = stubSnap(ctx, { nativeTypes: natives.filter((n) => n.supported).map((n) => n.type) });
      const checked = checkToolCall("add_native_indicator", JSON.stringify(args), snap);
      if (!checked.ok) return fail(checked.error);
      const before = new Set(chart.indicators().map((h) => h.id));
      const err = applyAction(ctx, checked.action, ctx.symbol);
      if (err) return fail(err);
      const added = chart.indicators().filter((h) => !before.has(h.id));
      if (added.length === 0) return fail(`沒有新增 ${String(args.type)}（單一實例的指標可能已在圖上）`);
      for (const h of added) state.indicators.add(h.id);
      return json({ id: added[0]!.id, title: added[0]!.title });
    }

    case "indicator_set_inputs": {
      const checked = checkToolCall("set_indicator_inputs", JSON.stringify(args), stubSnap(ctx, { indicators: indicatorInfo(ctx) }));
      if (!checked.ok) return fail(checked.error);
      const err = applyAction(ctx, checked.action, ctx.symbol);
      if (err) return fail(err);
      const h = chart.indicators().find((i) => i.id === args.indicator_id);
      return json({ id: args.indicator_id, inputs_now: h ? h.inputValues() : null });
    }

    case "indicator_remove": {
      const id = String(args.indicator_id ?? "");
      if (!state.indicators.has(id)) return fail(`${id} 不是 MCP 加的，不能移除（交易員自己的指標不動）`);
      const h = chart.indicators().find((i) => i.id === id);
      state.indicators.delete(id);
      if (!h) return json({ removed: id, note: "已不在圖上" });
      h.remove();
      if (chart.indicators().some((i) => i.id === id)) return fail(`${id} 移除後仍在圖上`);
      return json({ removed: id });
    }

    case "capture_screenshot": {
      const url = chart.renderer.screenshot();
      if (!url) return fail("這個圖表無法截圖");
      const data = url.replace(/^data:image\/png;base64,/, "");
      return { content: [{ type: "image", data, mimeType: "image/png" }] };
    }

    case "pine_compile":
    case "pine_add": {
      const source = typeof args.source === "string" ? args.source : "";
      if (!source.trim()) return fail("source 是空的");
      if (source.length > PINE_MAX_CHARS) return fail(`腳本 ${source.length} 字，超過上限 ${PINE_MAX_CHARS}`);
      const res = await chart.runScript(source);
      if (!res.ok || !res.run) {
        res.remove();
        return fail(`Pine 錯誤：${res.error?.message ?? "未知錯誤"}`);
      }
      const summary = pineSummary(res.run);
      if (name === "pine_compile") {
        res.remove();
        return json({ ok: true, removed_from_chart: true, ...summary });
      }
      state.indicators.add(res.run.id);
      return json({ ok: true, kept_on_chart: true, ...summary });
    }
  }
  return fail(`沒有這個工具：${name}`);
}
