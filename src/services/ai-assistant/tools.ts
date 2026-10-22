/**
 * VELA AI assistant tools: the OpenAI-style tool list the LLM sees, and the
 * check that turns one tool call into a ChartAction the panel shows as a card.
 * Pure (no ctx, no I/O) so every rule here is unit-tested.
 *
 * Times cross the LLM boundary as Taipei wall clock "YYYY-MM-DD HH:mm"; Vela
 * anchors are epoch ms. Prices must be finite, > 0 and inside a band around
 * the bars the LLM was shown: a 0 / NaN / 224-for-22400 anchor makes Vela
 * autoscale the price axis down to it (the "squashed chart" bug).
 *
 * Phase 1 is charting only: there is deliberately no order tool here.
 */
import { z } from "zod";

/** 台股紅漲綠跌. */
export const UP_COLOR = "#f23645";
export const DOWN_COLOR = "#089981";

export const TIMEFRAMES = ["1", "3", "5", "15", "30", "60", "240", "D", "W"] as const;

export type InputScalar = number | string | boolean;

export interface IndicatorInfo {
  id: string;
  title: string;
  inputs: Record<string, unknown>;
}

/** What the LLM was shown; every check is against this, not the live chart. */
export interface ChartSnapshot {
  symbol: string;
  timeframe: string;
  /** Epoch ms of the first / last bar shown. */
  firstTime: number;
  lastTime: number;
  low: number;
  high: number;
  lastClose: number;
  indicators: IndicatorInfo[];
  /** Native indicator types the chart supports for this symbol. */
  nativeTypes: string[];
}

export interface Anchor {
  time: number;
  price: number;
}

export type ChartAction =
  | { kind: "hline"; anchor: Anchor; label: string; color: string }
  | { kind: "trendline"; from: Anchor; to: Anchor; label: string; color: string }
  | { kind: "mark"; anchor: Anchor; dir: "up" | "down"; text: string; color: string }
  | { kind: "timeframe"; timeframe: string }
  | { kind: "symbol"; symbol: string }
  | { kind: "inputs"; indicatorId: string; title: string; inputs: Record<string, InputScalar> }
  | { kind: "native"; type: string };

export type CheckResult = { ok: true; action: ChartAction } | { ok: false; error: string };

const TAIPEI_OFFSET_MS = 8 * 3_600_000;

export function msToTaipei(ms: number): string {
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}

/** "YYYY-MM-DD HH:mm" Taipei → epoch ms; null for anything else (incl. 2026-02-30). */
export function taipeiToMs(s: string): number | null {
  const t = s.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) - TAIPEI_OFFSET_MS;
  return msToTaipei(ms) === t ? ms : null;
}

/** 0 / NaN / Infinity / off-band prices never reach Vela. */
export function isSanePrice(p: number, snap: Pick<ChartSnapshot, "low" | "high" | "lastClose">): boolean {
  if (!Number.isFinite(p) || p <= 0) return false;
  const pad = Math.max(snap.high - snap.low, snap.lastClose * 0.02);
  return p >= snap.low - pad && p <= snap.high + pad;
}

/** Futures: TMF / MXF dated or R1 only (大台 TXF is never switched to); stocks:
 *  4–6 digits, optionally "TSE:" / "OTC:" prefixed (the form hotlists.ts sets). */
export function isAllowedSymbol(s: string): boolean {
  return /^(TMF|MXF)([A-L]\d|R1)$/.test(s) || /^((TSE|OTC):)?\d{4,6}$/.test(s);
}

const bias = z.enum(["bullish", "bearish"]);
const price = z.number();
const time = z.string();

const ARGS = {
  draw_horizontal_line: z.object({ price, bias, label: z.string().max(40).optional() }),
  draw_trend_line: z.object({
    from_time: time,
    from_price: price,
    to_time: time,
    to_price: price,
    bias,
    label: z.string().max(40).optional(),
  }),
  add_mark: z.object({ time, price, bias, text: z.string().min(1).max(40) }),
  set_timeframe: z.object({ timeframe: z.enum(TIMEFRAMES) }),
  set_symbol: z.object({ symbol: z.string() }),
  set_indicator_inputs: z.object({
    indicator_id: z.string(),
    inputs: z.record(z.union([z.number(), z.string(), z.boolean()])),
  }),
  add_native_indicator: z.object({ type: z.string() }),
};

export type ToolName = keyof typeof ARGS;

const BIAS_DOC = "bullish = 偏多／壓力突破 (red #f23645), bearish = 偏空／跌破支撐 (green #089981)";
const TIME_DOC = 'Taipei time "YYYY-MM-DD HH:mm", copied from a bar in the context';

/** OpenAI `tools` array (Chat Completions format). */
export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "draw_horizontal_line",
      description: "Propose a horizontal support/resistance line on the current chart.",
      parameters: {
        type: "object",
        properties: {
          price: { type: "number", description: "Price level; must lie within the shown bars' range" },
          bias: { type: "string", enum: ["bullish", "bearish"], description: BIAS_DOC },
          label: { type: "string", description: "Short label, e.g. 22450 回踩線" },
        },
        required: ["price", "bias"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draw_trend_line",
      description: "Propose a trend line between two bar points on the current chart.",
      parameters: {
        type: "object",
        properties: {
          from_time: { type: "string", description: TIME_DOC },
          from_price: { type: "number" },
          to_time: { type: "string", description: TIME_DOC },
          to_price: { type: "number" },
          bias: { type: "string", enum: ["bullish", "bearish"], description: BIAS_DOC },
          label: { type: "string" },
        },
        required: ["from_time", "from_price", "to_time", "to_price", "bias"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_mark",
      description: "Propose an arrow mark with a short note at one bar (breakout, divergence, …).",
      parameters: {
        type: "object",
        properties: {
          time: { type: "string", description: TIME_DOC },
          price: { type: "number" },
          bias: { type: "string", enum: ["bullish", "bearish"], description: BIAS_DOC },
          text: { type: "string" },
        },
        required: ["time", "price", "bias", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_timeframe",
      description: "Propose switching the chart timeframe (minutes, or D / W).",
      parameters: {
        type: "object",
        properties: { timeframe: { type: "string", enum: [...TIMEFRAMES] } },
        required: ["timeframe"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_symbol",
      description: "Propose switching the chart symbol. Futures: TMF/MXF only (never TXF 大台), e.g. TMFK6; stocks: TSE:2330 or OTC:6488.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_indicator_inputs",
      description: "Propose changing inputs of an indicator already on the chart. Use the id and input keys listed in the context.",
      parameters: {
        type: "object",
        properties: {
          indicator_id: { type: "string" },
          inputs: { type: "object", description: "key → new value; keys must exist on that indicator" },
        },
        required: ["indicator_id", "inputs"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_native_indicator",
      description: "Propose adding a built-in indicator. Use a type from the context's list.",
      parameters: {
        type: "object",
        properties: { type: { type: "string" } },
        required: ["type"],
      },
    },
  },
] as const;

function anchorAt(t: string, p: number, snap: ChartSnapshot, which: string): Anchor | string {
  const ms = taipeiToMs(t);
  if (ms === null) return `${which} 時間格式錯誤：「${t}」，要用 YYYY-MM-DD HH:mm`;
  // One window of room past the last bar, so a projected trend line still fits.
  const ahead = Math.max(snap.lastTime - snap.firstTime, 86_400_000);
  if (ms < snap.firstTime || ms > snap.lastTime + ahead) {
    return `${which} 時間 ${t} 不在圖上 K 棒範圍（${msToTaipei(snap.firstTime)} ～ ${msToTaipei(snap.lastTime)}）`;
  }
  if (!isSanePrice(p, snap)) return `${which} 價格 ${p} 不合理（圖上區間 ${snap.low} ～ ${snap.high}）`;
  return { time: ms, price: p };
}

/** Parse + validate one tool call against the snapshot the LLM saw. */
export function checkToolCall(name: string, rawArgs: string, snap: ChartSnapshot): CheckResult {
  if (!(name in ARGS)) return { ok: false, error: `沒有這個工具：${name}` };
  let json: unknown;
  try {
    json = JSON.parse(rawArgs || "{}");
  } catch {
    return { ok: false, error: `${name} 的參數不是合法 JSON` };
  }
  const parsed = ARGS[name as ToolName].safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `${name} 參數錯誤：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  }
  const a = parsed.data as Record<string, unknown>;
  const color = a.bias === "bearish" ? DOWN_COLOR : UP_COLOR;

  switch (name as ToolName) {
    case "draw_horizontal_line": {
      const p = a.price as number;
      if (!isSanePrice(p, snap)) return { ok: false, error: `價格 ${p} 不合理（圖上區間 ${snap.low} ～ ${snap.high}）` };
      // hline has one anchor; its time is irrelevant to the drawing but must be a real bar.
      return { ok: true, action: { kind: "hline", anchor: { time: snap.lastTime, price: p }, label: (a.label as string) ?? "", color } };
    }
    case "draw_trend_line": {
      const from = anchorAt(a.from_time as string, a.from_price as number, snap, "起點");
      if (typeof from === "string") return { ok: false, error: from };
      const to = anchorAt(a.to_time as string, a.to_price as number, snap, "終點");
      if (typeof to === "string") return { ok: false, error: to };
      if (from.time === to.time) return { ok: false, error: "趨勢線兩點時間相同" };
      return { ok: true, action: { kind: "trendline", from, to, label: (a.label as string) ?? "", color } };
    }
    case "add_mark": {
      const anchor = anchorAt(a.time as string, a.price as number, snap, "標記");
      if (typeof anchor === "string") return { ok: false, error: anchor };
      const dir = a.bias === "bearish" ? "down" : "up";
      return { ok: true, action: { kind: "mark", anchor, dir, text: a.text as string, color } };
    }
    case "set_timeframe":
      return { ok: true, action: { kind: "timeframe", timeframe: a.timeframe as string } };
    case "set_symbol": {
      const s = (a.symbol as string).trim().toUpperCase();
      if (!isAllowedSymbol(s)) return { ok: false, error: `不允許切換到 ${s}（期貨只限微台 TMF／小台 MXF，禁切大台）` };
      return { ok: true, action: { kind: "symbol", symbol: s } };
    }
    case "set_indicator_inputs": {
      const ind = snap.indicators.find((i) => i.id === a.indicator_id);
      if (!ind) return { ok: false, error: `圖上沒有 id 為 ${String(a.indicator_id)} 的指標` };
      const inputs = a.inputs as Record<string, InputScalar>;
      const keys = Object.keys(inputs);
      if (keys.length === 0) return { ok: false, error: "沒有要改的參數" };
      for (const k of keys) {
        if (!(k in ind.inputs)) return { ok: false, error: `${ind.title} 沒有參數 ${k}（可用：${Object.keys(ind.inputs).join(", ")}）` };
        if (typeof inputs[k] !== typeof ind.inputs[k]) {
          return { ok: false, error: `${ind.title}.${k} 要 ${typeof ind.inputs[k]}，收到 ${typeof inputs[k]}` };
        }
        if (typeof inputs[k] === "number" && !Number.isFinite(inputs[k])) return { ok: false, error: `${ind.title}.${k} 不是有限數字` };
      }
      return { ok: true, action: { kind: "inputs", indicatorId: ind.id, title: ind.title, inputs } };
    }
    case "add_native_indicator": {
      const t = a.type as string;
      if (!snap.nativeTypes.includes(t)) return { ok: false, error: `不支援的內建指標 ${t}（可用：${snap.nativeTypes.join(", ")}）` };
      return { ok: true, action: { kind: "native", type: t } };
    }
  }
}

/** Card text (繁中) for one proposed action. */
export function describeAction(a: ChartAction): string {
  switch (a.kind) {
    case "hline":
      return `畫水平線 ${a.anchor.price}${a.label ? `「${a.label}」` : ""}`;
    case "trendline":
      return `畫趨勢線 ${msToTaipei(a.from.time)} ${a.from.price} → ${msToTaipei(a.to.time)} ${a.to.price}${a.label ? `「${a.label}」` : ""}`;
    case "mark":
      return `${a.dir === "up" ? "▲" : "▼"} 標記 ${msToTaipei(a.anchor.time)} ${a.anchor.price}「${a.text}」`;
    case "timeframe":
      return `切換週期 → ${a.timeframe}`;
    case "symbol":
      return `切換商品 → ${a.symbol}`;
    case "inputs":
      return `調整 ${a.title}：${Object.entries(a.inputs).map(([k, v]) => `${k}=${String(v)}`).join(", ")}`;
    case "native":
      return `加入內建指標 ${a.type}`;
  }
}
