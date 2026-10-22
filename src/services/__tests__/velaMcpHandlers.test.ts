import type { OHLCV } from "@luxalgo/vela";
import { describe, expect, it, vi } from "vitest";
import { taipeiToMs } from "../ai-assistant/tools.ts";
import { createMcpState, runTool, type McpChartCtx, type McpDrawing, type McpIndicator, type McpScriptResult } from "../vela-mcp/handlers.ts";
import type { ToolResult } from "../vela-mcp/protocol.ts";

const T0 = taipeiToMs("2026-10-21 09:00")!;
const BARS: OHLCV[] = Array.from({ length: 20 }, (_, i) => ({
  time: T0 + i * 300_000,
  open: 22400 + i,
  high: 22410 + i,
  low: 22390 + i,
  close: 22405 + i,
  volume: 100 + i,
}));

function indicator(id: string, inputs: Record<string, unknown>, onRemove: (id: string) => void): McpIndicator {
  const values = { ...inputs };
  return {
    id,
    title: id.toUpperCase(),
    visible: true,
    inputs: Object.keys(inputs),
    inputValues: () => ({ ...values }),
    setInputs: (v) => Object.assign(values, v),
    remove: () => onRemove(id),
    context: async () => ({ plots: { main: [{ time: T0, value: 1 }, { time: T0 + 1, value: 2.5 }], gap: [{ time: T0, value: null }] } }),
  };
}

function fakeCtx(script?: McpScriptResult) {
  let n = 0;
  const drawings: McpDrawing[] = [{ id: "user-1", type: "hline", anchors: [{ time: T0, price: 22400 }] }];
  let inds: McpIndicator[] = [];
  const drop = (id: string) => {
    inds = inds.filter((i) => i.id !== id);
  };
  inds.push(indicator("sma-user", { length: 20 }, drop));
  let range = { from: T0, to: T0 + 3_600_000 };
  const ctx = {
    symbol: "TMFR1",
    timeframe: "5",
    setSymbol: vi.fn((s: string) => {
      ctx.symbol = s;
    }),
    setTimeframe: vi.fn((tf: string) => {
      ctx.timeframe = tf;
    }),
    addNativeIndicator: vi.fn((type: string) => {
      inds.push(indicator(`${type}-${++n}`, {}, drop));
    }),
    chart: {
      drawings: {
        add: vi.fn((type: string, init: { anchors: McpDrawing["anchors"] }) => {
          const d = { id: `d${++n}`, type, anchors: init.anchors };
          drawings.push(d);
          return d;
        }) as unknown as (type: never, init?: unknown) => unknown,
        remove: vi.fn((id: string) => {
          const i = drawings.findIndex((d) => d.id === id);
          if (i >= 0) drawings.splice(i, 1);
        }),
        all: () => [...drawings],
      },
      indicators: () => [...inds],
      availableNativeIndicators: async () => [
        { type: "vpvr", supported: true },
        { type: "oi", supported: false },
      ],
      getVisibleRange: () => range,
      setVisibleRange: vi.fn((r: { from: number; to: number }) => {
        range = r;
      }),
      renderer: { screenshot: () => "data:image/png;base64,QUJD" },
      runScript: vi.fn(async () => {
        if (script?.ok && script.run) inds.push(indicator(script.run.id, {}, drop));
        return script ?? { ok: false, error: new Error("no engine"), run: null, remove: () => undefined };
      }),
    },
  };
  return { ctx: ctx as McpChartCtx & typeof ctx, drawings, inds: () => inds };
}

const deps = { bars: vi.fn(async () => BARS) };
const text = (r: ToolResult) => (r.content[0] as { text: string }).text;
const body = (r: ToolResult) => JSON.parse(text(r));

describe("runTool — reads", () => {
  it("chart_get_state reports symbol, Taipei range, indicators and drawing owners", async () => {
    const { ctx } = fakeCtx();
    const r = body(await runTool(ctx, createMcpState(), deps, "chart_get_state", {}));
    expect(r).toMatchObject({
      symbol: "TMFR1",
      timeframe: "5",
      visible_range: { from: "2026-10-21 09:00", to: "2026-10-21 10:00" },
      native_types: ["vpvr"],
      drawings: { by_mcp: 0, by_trader: 1 },
    });
    expect(r.indicators[0]).toMatchObject({ id: "sma-user", inputs: { length: 20 }, added_by_mcp: false });
  });

  it("data_get_ohlcv clamps count and prints Taipei times", async () => {
    const { ctx } = fakeCtx();
    const r = body(await runTool(ctx, createMcpState(), deps, "data_get_ohlcv", { count: 3 }));
    expect(r.bars).toHaveLength(3);
    expect(r.bars[2]).toEqual(["2026-10-21 10:35", 22419, 22429, 22409, 22424, 119]);
    const all = body(await runTool(ctx, createMcpState(), deps, "data_get_ohlcv", { count: 9999 }));
    expect(all.bars).toHaveLength(20);
  });

  it("quote_get gives last close and change vs previous bar", async () => {
    const { ctx } = fakeCtx();
    const r = body(await runTool(ctx, createMcpState(), deps, "quote_get", {}));
    expect(r).toMatchObject({ last: 22424, change: 1, bar_time: "2026-10-21 10:35" });
  });

  it("no usable bars is an error, not an empty success", async () => {
    const { ctx } = fakeCtx();
    const bad = { bars: async () => [{ ...BARS[0]!, low: 0 }] };
    const r = await runTool(ctx, createMcpState(), bad, "quote_get", {});
    expect(r.isError).toBe(true);
  });

  it("data_get_study_values takes the last finite value of each plot", async () => {
    const { ctx } = fakeCtx();
    const r = body(await runTool(ctx, createMcpState(), deps, "data_get_study_values", {}));
    expect(r.indicators[0]).toEqual({ id: "sma-user", title: "SMA-USER", values: { main: 2.5, gap: null } });
  });
});

describe("runTool — chart control", () => {
  it("chart_set_symbol switches allowed symbols and reads the chart back", async () => {
    const { ctx } = fakeCtx();
    const r = body(await runTool(ctx, createMcpState(), deps, "chart_set_symbol", { symbol: "tmfk6" }));
    expect(ctx.setSymbol).toHaveBeenCalledWith("TMFK6");
    expect(r).toMatchObject({ requested: "TMFK6", chart_now: "TMFK6" });
  });

  it("chart_set_symbol refuses 大台 TXF", async () => {
    const { ctx } = fakeCtx();
    const r = await runTool(ctx, createMcpState(), deps, "chart_set_symbol", { symbol: "TXFK6" });
    expect(r.isError).toBe(true);
    expect(ctx.setSymbol).not.toHaveBeenCalled();
  });

  it("chart_set_timeframe rejects an unknown timeframe", async () => {
    const { ctx } = fakeCtx();
    expect((await runTool(ctx, createMcpState(), deps, "chart_set_timeframe", { timeframe: "2" })).isError).toBe(true);
    const ok = body(await runTool(ctx, createMcpState(), deps, "chart_set_timeframe", { timeframe: "15" }));
    expect(ok.chart_now).toBe("15");
  });

  it("chart_set_visible_range converts Taipei times and rejects bad ones", async () => {
    const { ctx } = fakeCtx();
    const r = body(await runTool(ctx, createMcpState(), deps, "chart_set_visible_range", { from: "2026-10-21 09:30", to: "2026-10-21 10:30" }));
    expect(ctx.chart.setVisibleRange).toHaveBeenCalledWith({ from: T0 + 1_800_000, to: T0 + 5_400_000 });
    expect(r.visible_range).toEqual({ from: "2026-10-21 09:30", to: "2026-10-21 10:30" });
    expect((await runTool(ctx, createMcpState(), deps, "chart_set_visible_range", { from: "1761000000", to: "x" })).isError).toBe(true);
    expect((await runTool(ctx, createMcpState(), deps, "chart_set_visible_range", { from: "2026-10-21 10:30", to: "2026-10-21 09:30" })).isError).toBe(true);
  });

  it("chart_scroll_to_date centers on the date keeping the width", async () => {
    const { ctx } = fakeCtx();
    await runTool(ctx, createMcpState(), deps, "chart_scroll_to_date", { date: "2026-10-21 12:00" });
    const c = taipeiToMs("2026-10-21 12:00")!;
    expect(ctx.chart.setVisibleRange).toHaveBeenCalledWith({ from: c - 1_800_000, to: c + 1_800_000 });
  });
});

describe("runTool — drawings", () => {
  it("draw_shape draws a sane horizontal line and returns the new id", async () => {
    const { ctx } = fakeCtx();
    const state = createMcpState();
    const r = body(await runTool(ctx, state, deps, "draw_shape", { shape: "horizontal_line", price: 22420, bias: "bullish", text: "壓力" }));
    expect(r.id).toMatch(/^d\d+$/);
    expect(state.drawings.has(r.id)).toBe(true);
    expect(r.drawn).toContain("22420");
  });

  it("draw_shape refuses 0, off-band and second-based times before touching the chart", async () => {
    const { ctx } = fakeCtx();
    const state = createMcpState();
    for (const args of [
      { shape: "horizontal_line", price: 0, bias: "bullish" },
      { shape: "horizontal_line", price: 224, bias: "bullish" },
      { shape: "arrow_mark", time: "1761000000", price: 22420, bias: "bearish", text: "x" },
      { shape: "circle", bias: "bullish" },
    ]) {
      expect((await runTool(ctx, state, deps, "draw_shape", args)).isError).toBe(true);
    }
    expect(ctx.chart.drawings.add).not.toHaveBeenCalled();
  });

  it("draw_shape trend_line and arrow_mark map onto the checked actions", async () => {
    const { ctx } = fakeCtx();
    const state = createMcpState();
    const tl = await runTool(ctx, state, deps, "draw_shape", {
      shape: "trend_line",
      from_time: "2026-10-21 09:00",
      from_price: 22395,
      to_time: "2026-10-21 10:00",
      to_price: 22420,
      bias: "bullish",
    });
    expect(tl.isError).toBeUndefined();
    const mk = await runTool(ctx, state, deps, "draw_shape", { shape: "arrow_mark", time: "2026-10-21 09:30", price: 22410, bias: "bearish", text: "跌破" });
    expect(mk.isError).toBeUndefined();
    expect(ctx.chart.drawings.add).toHaveBeenCalledWith("arrowmarkdown", expect.anything());
    expect(state.drawings.size).toBe(2);
  });

  it("draw_remove_one and draw_clear only touch MCP drawings", async () => {
    const { ctx, drawings } = fakeCtx();
    const state = createMcpState();
    const a = body(await runTool(ctx, state, deps, "draw_shape", { shape: "horizontal_line", price: 22420, bias: "bullish" }));
    await runTool(ctx, state, deps, "draw_shape", { shape: "horizontal_line", price: 22410, bias: "bearish" });
    expect((await runTool(ctx, state, deps, "draw_remove_one", { id: "user-1" })).isError).toBe(true);
    expect(body(await runTool(ctx, state, deps, "draw_remove_one", { id: a.id }))).toEqual({ removed: a.id });
    const list = body(await runTool(ctx, state, deps, "draw_list", {}));
    expect(list.by_mcp).toHaveLength(1);
    expect(list.by_trader_count).toBe(1);
    expect(body(await runTool(ctx, state, deps, "draw_clear", {}))).toEqual({ removed: 1 });
    expect(drawings.map((d) => d.id)).toEqual(["user-1"]);
  });
});

describe("runTool — indicators, screenshot, Pine", () => {
  it("indicator_add only adds supported types and tracks the new id", async () => {
    const { ctx } = fakeCtx();
    const state = createMcpState();
    expect((await runTool(ctx, state, deps, "indicator_add", { type: "oi" })).isError).toBe(true);
    const r = body(await runTool(ctx, state, deps, "indicator_add", { type: "vpvr" }));
    expect(state.indicators.has(r.id)).toBe(true);
  });

  it("indicator_set_inputs checks keys and types, then reads values back", async () => {
    const { ctx } = fakeCtx();
    const state = createMcpState();
    expect((await runTool(ctx, state, deps, "indicator_set_inputs", { indicator_id: "sma-user", inputs: { len: 5 } })).isError).toBe(true);
    expect((await runTool(ctx, state, deps, "indicator_set_inputs", { indicator_id: "sma-user", inputs: { length: "5" } })).isError).toBe(true);
    const r = body(await runTool(ctx, state, deps, "indicator_set_inputs", { indicator_id: "sma-user", inputs: { length: 60 } }));
    expect(r.inputs_now).toEqual({ length: 60 });
  });

  it("indicator_remove refuses the trader's indicators", async () => {
    const { ctx, inds } = fakeCtx();
    const state = createMcpState();
    expect((await runTool(ctx, state, deps, "indicator_remove", { indicator_id: "sma-user" })).isError).toBe(true);
    const added = body(await runTool(ctx, state, deps, "indicator_add", { type: "vpvr" }));
    expect(body(await runTool(ctx, state, deps, "indicator_remove", { indicator_id: added.id }))).toEqual({ removed: added.id });
    expect(inds().map((i) => i.id)).toEqual(["sma-user"]);
  });

  it("capture_screenshot returns MCP image content without the data-URL prefix", async () => {
    const { ctx } = fakeCtx();
    const r = await runTool(ctx, createMcpState(), deps, "capture_screenshot", {});
    expect(r.content[0]).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
  });

  const okRun = (remove: () => void): McpScriptResult => ({
    ok: true,
    error: null,
    run: { id: "pine-1", title: "My", kind: "indicator", time: T0, plots: { p: 1 }, warnings: [{ message: "w1" }] },
    remove,
  });

  it("pine_compile runs once, reports, and takes the script off the chart", async () => {
    const remove = vi.fn();
    const { ctx } = fakeCtx(okRun(remove));
    const r = body(await runTool(ctx, createMcpState(), deps, "pine_compile", { source: "//@version=6\nindicator('x')" }));
    expect(r).toMatchObject({ ok: true, removed_from_chart: true, plots: { p: 1 }, warnings: ["w1"], bar_time: "2026-10-21 09:00" });
    expect(remove).toHaveBeenCalledOnce();
  });

  it("pine_add keeps the script and makes it removable", async () => {
    const remove = vi.fn();
    const { ctx } = fakeCtx(okRun(remove));
    const state = createMcpState();
    const r = body(await runTool(ctx, state, deps, "pine_add", { source: "//@version=6\nindicator('x')" }));
    expect(r.kept_on_chart).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(state.indicators.has("pine-1")).toBe(true);
  });

  it("Pine errors, empty and oversized sources are isError", async () => {
    const { ctx } = fakeCtx();
    const state = createMcpState();
    const bad = await runTool(ctx, state, deps, "pine_compile", { source: "x" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("no engine");
    expect((await runTool(ctx, state, deps, "pine_add", { source: "  " })).isError).toBe(true);
    expect((await runTool(ctx, state, deps, "pine_add", { source: "a".repeat(20_001) })).isError).toBe(true);
    expect(ctx.chart.runScript).toHaveBeenCalledTimes(1);
  });
});
