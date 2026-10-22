# VELA AI 副駕駛 Phase 1（盤中看盤助手）Implementation Plan

> **日期：** 2026-10-21（2026-10-21 改寫：原版雙通道／WebSocket／MCP 方案作廢，理由見 D1）
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Executor:** OMP `magpie-zen/minimax-m3.1-flash-free`。**本計畫的程式碼由 Opus 在 repo 試作並驗證過**（3 個測試檔 30 passed、`tsc --noEmit` 0 error、`/__ai-chat` 對真 LLM 煙霧測試通過），執行者**逐字照抄**，不得改寫、不得「優化」。

**Goal:**
在 `/vela` 右側加一個「AI 副駕駛」側邊面板：交易員直接打字問（例：「這根量這麼大能追嗎？」），面板自動把當前圖表脈絡（商品、週期、可見時間窗、最近 40 根 K 棒、圖上指標與可加的內建指標）塞進 system prompt；LLM 回覆文字串流顯示，並可**提議**圖表操作（畫水平線／趨勢線／箭頭標記、切週期、切商品、調指標參數、加內建指標），每個提議變成一張卡片，**交易員點「套用」才執行**。

**Architecture:**
整條工具迴圈在瀏覽器內跑。面板 → `POST /__ai-chat`（Vite dev middleware，固定上游與模型）→ 本機 magpie proxy `127.0.0.1:3425` 的 `auto/minimax-m3` → SSE 串流回面板。工具呼叫在前端經 `checkToolCall` 驗證（價格帶、時間、商品白名單、指標鍵名）後變成卡片；點擊後 `applyAction` 再驗一次價格並呼叫 Vela 原生 API（`ctx.chart.drawings.add`、`ctx.setTimeframe`、`handle.setInputs`、`ctx.addNativeIndicator`）。沒有 WebSocket、沒有獨立後端、沒有 MCP Server。

**Tech Stack:** TypeScript（strict）、`@luxalgo/vela` 0.8 plugin API、zod 3、Vitest + jsdom、Vite dev middleware。

**Spec invariant:** LLM 永遠只能「提議」：任何圖表變更都必須經過 `checkToolCall`（第一道）→ 交易員點擊 → `applyAction` 價格再驗（第二道）才會碰到 Vela；價格必須有限、> 0、落在提示給 LLM 的 K 棒區間附近；時間一律 Taipei wall clock 字串 ↔ epoch **ms**；Phase 1 工具清單中不存在任何下單工具。

---

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same verify failing after 2+ distinct fix attempts. Single red test in the "verify it fails" step = expected, not a blocker.

Never stop to ask what you can look up. Questions that don't change your next action: note them, keep going, report at task end.

用 CodeGraph 查程式碼時一律加 `-p C:/Users/bear9/MYOPENCHART`（例：`codegraph explore "ShioajiVelaProvider getBars" -p C:/Users/bear9/MYOPENCHART`）。

**Plan-specific Nevers:**
1. **NEVER rewrite, reformat, or "improve" the code blocks.** Copy each fenced block byte-for-byte into the named file. Acceptance is a byte-compare against Opus's verified copies.
2. **NEVER `git commit`, `git add`, `git stash`, `git checkout --`, or `git reset`.** The OpenCharts working tree holds other people's uncommitted work (`VelaPage.tsx`, `vite.config.ts`, `package.json` …).
3. **NEVER touch files outside the Files lists below.** In `VelaPage.tsx` and `vite.config.ts` change ONLY the exact anchored lines given; everything else in those files is someone else's uncommitted work.
4. **NEVER run `npx eslint`** (project config is broken) **or the full suite `npx vitest run` without file paths** (CPU guard). Run only the test files each task names.
5. **NEVER pass `0`, `NaN`, `Infinity`, negative or seconds-based values as Vela anchors.** Vela `DrawingPoint.time` is epoch **ms**; a bad price makes Vela autoscale collapse the price axis.
6. **NEVER add an order / trade tool, or call `guardedPlaceOrder` / Shioaji order endpoints.** Orders are Phase 2.
7. **NEVER subscribe to Vela workspace `"state:changed"`** (event storm froze this page before); read `ctx.symbol` / `ctx.timeframe` at use time.
8. **NEVER put an API key, token, or the upstream URL in browser code.** The upstream URL and model live only in `vite.config.ts`.

---

## Global Constraints

- Repo root: `C:\Users\bear9\OpenCharts`（Windows，PowerShell；`MYOPENCHART\OpenCharts` 是 junction）。
- Imports: relative paths **with `.ts`**; Vela registration imports from `"@luxalgo/vela/plugin"`, NOT the root `"@luxalgo/vela"` (separate module instances → panel silently missing). Types (`OHLCV`) from `"@luxalgo/vela"` are fine.
- Comments English; user-visible strings 繁體中文.
- Colors 紅漲綠跌：bullish `#f23645`、bearish `#089981`.
- Futures symbols: 微台 `TMF` / 小台 `MXF` only, never 大台 `TXF`. Dated front-month codes come from `frontMonthCode()` in `src/services/shioaji/instruments.ts`（結算日 13:45 換月）。
- Baseline before this plan: `npx tsc --noEmit` → **0 errors**.

---

## Decision Points

### D1: 工具迴圈放哪裡、圖表指令走什麼通道 (T1)
- Consumed by: Task 2, Task 3, Task 4
- Candidates:
  - A (original plan): Node 後端 :3001 + HTTP SSE 文字 + 獨立 WebSocket `/ws/actions` 推圖表指令 + 另寫 VELA MCP Server。
  - B (OMP as backend): OMP 跑 agent 迴圈，經 MCP 操作圖表；需另寫 VELA MCP Server 與 OMP↔瀏覽器的橋。
  - C (preferred): 迴圈在面板（瀏覽器）內跑；只有 LLM 呼叫經 Vite dev middleware 中轉（金鑰／上游留在伺服器端）；圖表操作是同頁函式呼叫。
- Criteria: 1. 文字串流不被圖表操作阻塞。 2. 圖表操作送達可驗證（不能回報假成功）。 3. 最少新服務與程式碼。 4. 不新增依賴。
- Chosen: C
- Rejected: A fails 3 & 4（多一個要啟動的服務，`ws`、`@modelcontextprotocol/sdk` 未安裝；原版 dispatcher 在前端斷線時仍回 `success: true` 違反 2）。B fails 3（兩個新元件 + 跨程序橋）。面板與圖表同頁，雙通道解的是不存在的問題。
- Revisit trigger: 需要讓「瀏覽器以外」的 agent（例：OMP、排程）操作圖表。
- Outcome: held for the in-page panel; revisited 2026-10-21 for external agents → `2026-10-21-vela-mcp-server.md`（MCP 端點掛 Vite、SSE 轉給頁面；面板本身不變）

### D2: 工具呼叫直接執行還是變卡片 (T1)
- Consumed by: Task 1, Task 3
- Candidates:
  - A: LLM 呼叫即執行（原版）。
  - C (preferred): 每個呼叫驗證後變成卡片，交易員點「套用」才執行；驗證失敗把錯誤回給 LLM，最多再給 1 輪修正。
- Criteria: 1. LLM 幻覺不能直接畫到圖上。 2. 回報給 LLM 的結果必須真實。 3. 符合需求「結構化操作卡片、一鍵可執行」。
- Chosen: C
- Rejected: A fails 1 & 2。
- Revisit trigger: 交易員明確要求某類操作（例：只畫線）免確認。
- Outcome: held

### D3: 助手用哪個模型、怎麼連 (T1)
- Consumed by: Task 4
- Candidates:
  - A: OpenCode Zen `minimax-m3.1-flash-free` 直連, 實測回 `FreeTierError: free tier can only be used from within OpenCode`。
  - B: OpenCode Go key, 實測 `api_key_expired`。
  - C (preferred): 本機 magpie proxy `http://127.0.0.1:3425/v1/chat/completions`，model `auto/minimax-m3`（回應 model 為 `minimax/minimax-m3`）, 實測非串流與串流的 tool_calls 都是標準 OpenAI 格式。
- Criteria: 1. 從網頁可用。 2. 支援 tool calling + SSE。 3. 金鑰不進瀏覽器。
- Chosen: C（使用者 2026-10-21 確認接受 m3 取代 m3.1 flash）
- Rejected: A、B fail 1。
- Revisit trigger: magpie 不在線（面板會顯示「AI 服務錯誤 502 … LLM proxy unreachable」），或要換模型 → 只改 `vite.config.ts` 的 `AI_UPSTREAM` / `AI_MODEL`。
- Outcome: held

---

## Fact Annex（Opus 2026-10-21 核對）

| 事實 | 來源 |
|---|---|
| `DrawingPoint.time` 是 epoch **ms**（"Epoch ms, resolved to a fractional logical bar index"） | `node_modules/@luxalgo/vela/dist/options-CSXbjMM5.d.ts:772-777` |
| `OHLCV.time: Millis` | `options-CSXbjMM5.d.ts:11-18` |
| `chart.drawings.add(type: DrawingTypeKey, init?: AddInit): Drawing \| null`；`AddInit = { anchors, style?: Partial<DrawingStyle>, text?: DrawingText, … }` | `contributions-BY3zSYiZ.d.ts:1354-1365, 1554` |
| `DrawingStyle.lineColor/lineWidth`；`DrawingText = { value, color?, size, hAlign, vAlign }` | `options-CSXbjMM5.d.ts:847-871` |
| 錨點數：`hline` 1（min 1 max 1）、`trendline` 2、`arrowmarkup`/`arrowmarkdown` 1 | `dist/chunk-ALTGHKIM.js`（HorizontalLine / TrendLine / ArrowMark） |
| `IndicatorHandle`：`id`、`title`、`visible`、`inputs`、`inputValues()`、**`setInputs(values)`**（沒有 `updateInputs`） | `contributions-BY3zSYiZ.d.ts:306-380` |
| `chart.availableNativeIndicators(): Promise<NativeIndicatorInfo[]>`（`type`、`supported`） | `contributions-BY3zSYiZ.d.ts:593-603, 1756-1776` |
| `chart.getVisibleRange(): VisibleRange \| null`，`{ from: Millis, to: Millis }` | `contributions-BY3zSYiZ.d.ts:1882`；`options-CSXbjMM5.d.ts:1577-1580` |
| WidgetContext：`symbol`/`timeframe` live getter、`setSymbol`、`setTimeframe`、`togglePanel`、`addNativeIndicator(type)`（進 undo 時間軸）、`chart` | `contributions-BY3zSYiZ.d.ts:1917-1955` |
| 圖上沒有公開的 bars 存取；K 棒用 `ShioajiVelaProvider.getBars(symbol, tf, { from, to, limit })`（回傳 time 已是 ms） | `src/services/shioaji/velaProvider.ts:150-170`；同 `velaTechRating.ts` 用法 |
| 週期字串："1"…"240"、"D"、"W"（provider `normalizeTimeframe`） | `src/services/shioaji/velaProvider.ts:28-41` |
| 股票商品字串帶交易所前綴（hotlists 設 `TSE:2330`） | `src/pages/velaMarketWidgets.ts`（hotlists `onPick`） |
| 已用的頂列 order：1 Nautilus、2 評分、3 熱力圖、4 排行 → 本面板 **5** | `myopenchart` skill `references/vela-plugin-api.md` |
| magpie `auto/minimax-m3` 串流格式：`data: {choices:[{delta:{content}}]}`，tool_calls 以 `index` 分段累加 `function.arguments` | Opus 2026-10-21 curl 實測 |

---

## Review Ledger

*(Starts empty; execution appends `Task <N>: minor (deferred): <one-liner>`, rulings, and fix-round entries.)*

- 2026-10-21 驗收後（Opus，使用者要求）：K 棒由「可見範圍、列 40 根」改為「最近 100 根、不管縮放」。`chat.ts` `PROMPT_BARS` 40→100 並 export、提示文字「圖上可見」→「K 棒範圍」；`velaAiAssistant.ts` 改用 `lookbackMs(timeframe)`、`limit: PROMPT_BARS`，不再讀 `getVisibleRange()`。實測 ~26 token／根，100 根 ≈ 2.8k，延遲無差。3 檔 30 passed、tsc 0。**repo 現況已與上方嵌入程式碼不同**（以 repo 為準）。
- 2026-10-21 已知限制：收盤後 Shioaji kbars 不回當日 K 棒（2330 與期貨查到 10/20 13:30 為止），此時面板看到的是到前一交易日的 100 根；待查是否為 8080 盤後行為。

---

## Task Decomposition

### Task 1: 工具定義與驗證層（純函式）

**Blocked by:** None.

**Files:**
- Create: `src/services/ai-assistant/tools.ts`
- Test: `src/services/__tests__/aiTools.test.ts`

**Interfaces:**
- Produces: `TOOL_DEFS`、`checkToolCall(name, rawArgs, snap)`、`describeAction(a)`、`ChartSnapshot`、`ChartAction`、`taipeiToMs`、`msToTaipei`、`isSanePrice`、`isAllowedSymbol`、`UP_COLOR`、`DOWN_COLOR`、`TIMEFRAMES`。

**Done when:**
- `npx vitest run src/services/__tests__/aiTools.test.ts` → 18 passed。

- [ ] **Step 1: Write the test file exactly**

````ts
import { describe, expect, it } from "vitest";
import {
  checkToolCall,
  describeAction,
  DOWN_COLOR,
  isAllowedSymbol,
  msToTaipei,
  taipeiToMs,
  TOOL_DEFS,
  UP_COLOR,
  type ChartSnapshot,
} from "../ai-assistant/tools.ts";

const T0 = taipeiToMs("2026-10-21 09:00")!;
const T1 = taipeiToMs("2026-10-21 13:00")!;

const snap: ChartSnapshot = {
  symbol: "TMFK6",
  timeframe: "5",
  firstTime: T0,
  lastTime: T1,
  low: 22300,
  high: 22600,
  lastClose: 22450,
  indicators: [{ id: "ind-1", title: "RSI", inputs: { length: 14, source: "close" } }],
  nativeTypes: ["vpvr", "sma"],
};

const call = (name: string, args: unknown) => checkToolCall(name, JSON.stringify(args), snap);

describe("taipei time", () => {
  it("round-trips Taipei wall clock and epoch ms", () => {
    expect(T0).toBe(Date.UTC(2026, 9, 21, 1, 0));
    expect(msToTaipei(T0)).toBe("2026-10-21 09:00");
  });

  it("rejects malformed and impossible dates", () => {
    expect(taipeiToMs("2026-10-21T09:00")).toBeNull();
    expect(taipeiToMs("2026-02-30 09:00")).toBeNull();
    expect(taipeiToMs("1729470000")).toBeNull();
  });
});

describe("checkToolCall: prices never collapse the axis", () => {
  it("accepts a sane horizontal line, anchored on the last bar, red when bullish", () => {
    const r = call("draw_horizontal_line", { price: 22450, bias: "bullish", label: "回踩線" });
    expect(r).toEqual({
      ok: true,
      action: { kind: "hline", anchor: { time: T1, price: 22450 }, label: "回踩線", color: UP_COLOR },
    });
  });

  it.each([0, -5, 224, 1e9])("rejects price %s", (price) => {
    expect(call("draw_horizontal_line", { price, bias: "bearish" }).ok).toBe(false);
  });

  it("rejects NaN / Infinity that JSON cannot even carry", () => {
    expect(checkToolCall("draw_horizontal_line", '{"price": NaN, "bias": "bullish"}', snap).ok).toBe(false);
    expect(call("draw_horizontal_line", { price: null, bias: "bullish" }).ok).toBe(false);
  });

  it("builds a green trend line from Taipei times", () => {
    const r = call("draw_trend_line", {
      from_time: "2026-10-21 09:00",
      from_price: 22550,
      to_time: "2026-10-21 12:30",
      to_price: 22350,
      bias: "bearish",
    });
    expect(r.ok && r.action).toEqual({
      kind: "trendline",
      from: { time: T0, price: 22550 },
      to: { time: taipeiToMs("2026-10-21 12:30"), price: 22350 },
      label: "",
      color: DOWN_COLOR,
    });
  });

  it("rejects epoch-second numbers and times outside the bars", () => {
    expect(call("add_mark", { time: "1729470000", price: 22400, bias: "bullish", text: "x" }).ok).toBe(false);
    const r = call("add_mark", { time: "2026-10-20 09:00", price: 22400, bias: "bullish", text: "x" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("不在圖上 K 棒範圍");
  });

  it("maps a bearish mark to a down arrow", () => {
    const r = call("add_mark", { time: "2026-10-21 10:00", price: 22500, bias: "bearish", text: "背離" });
    expect(r.ok && r.action).toMatchObject({ kind: "mark", dir: "down", color: DOWN_COLOR, text: "背離" });
  });
});

describe("checkToolCall: symbols, timeframes, indicators", () => {
  it("never switches to 大台 TXF", () => {
    expect(call("set_symbol", { symbol: "TXFK6" }).ok).toBe(false);
    expect(call("set_symbol", { symbol: "tmfk6" })).toEqual({ ok: true, action: { kind: "symbol", symbol: "TMFK6" } });
    expect(isAllowedSymbol("TSE:2330")).toBe(true);
    expect(isAllowedSymbol("MXFR1")).toBe(true);
  });

  it("accepts only listed timeframes", () => {
    expect(call("set_timeframe", { timeframe: "15" }).ok).toBe(true);
    expect(call("set_timeframe", { timeframe: "15m" }).ok).toBe(false);
  });

  it("checks indicator id, key and value type", () => {
    expect(call("set_indicator_inputs", { indicator_id: "ind-1", inputs: { length: 9 } })).toEqual({
      ok: true,
      action: { kind: "inputs", indicatorId: "ind-1", title: "RSI", inputs: { length: 9 } },
    });
    expect(call("set_indicator_inputs", { indicator_id: "nope", inputs: { length: 9 } }).ok).toBe(false);
    expect(call("set_indicator_inputs", { indicator_id: "ind-1", inputs: { period: 9 } }).ok).toBe(false);
    expect(call("set_indicator_inputs", { indicator_id: "ind-1", inputs: { length: "9" } }).ok).toBe(false);
  });

  it("adds only supported native types", () => {
    expect(call("add_native_indicator", { type: "vpvr" }).ok).toBe(true);
    expect(call("add_native_indicator", { type: "supertrend" }).ok).toBe(false);
  });

  it("rejects unknown tools and bad JSON", () => {
    expect(call("place_order", { symbol: "TMFK6" }).ok).toBe(false);
    expect(checkToolCall("set_timeframe", "{oops", snap).ok).toBe(false);
  });
});

describe("tool list", () => {
  it("has no order tool in phase 1", () => {
    expect(TOOL_DEFS.map((t) => t.function.name).some((n) => /order|trade/.test(n))).toBe(false);
  });

  it("describes cards in 繁中", () => {
    expect(describeAction({ kind: "timeframe", timeframe: "15" })).toBe("切換週期 → 15");
  });
});
````

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run src/services/__tests__/aiTools.test.ts`
Expected: FAIL（`Failed to resolve import "../ai-assistant/tools.ts"`）

- [ ] **Step 3: Write the implementation exactly**

````ts
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
````

- [ ] **Step 4: Verify it passes**

Run: `npx vitest run src/services/__tests__/aiTools.test.ts`
Expected: `Tests  18 passed (18)`

---

### Task 2: 對話傳輸（SSE 串流解析）與 system prompt

**Blocked by:** Task 1

**Files:**
- Create: `src/services/ai-assistant/chat.ts`
- Test: `src/services/__tests__/aiChat.test.ts`

**Interfaces:**
- Consumes: Task 1 `TOOL_DEFS`、`msToTaipei`、`ChartSnapshot`
- Produces: `streamChat(messages, onText, fetchImpl?, signal?) → Promise<ChatReply>`、`buildSystemPrompt(snap, bars)`、`ChatMessage`、`ToolCall`、`ChatReply`。

**Done when:**
- `npx vitest run src/services/__tests__/aiChat.test.ts` → 3 passed。

- [ ] **Step 1: Write the test file exactly**

````ts
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
````

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run src/services/__tests__/aiChat.test.ts`
Expected: FAIL（`Failed to resolve import "../ai-assistant/chat.ts"`）

- [ ] **Step 3: Write the implementation exactly**

````ts
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

/** Bars listed verbatim in the prompt (the rest is summarized by low/high). */
const PROMPT_BARS = 40;

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
    `圖上可見 ${msToTaipei(snap.firstTime)} ～ ${msToTaipei(snap.lastTime)}，區間低 ${snap.low} 高 ${snap.high}`,
    `最近 ${Math.min(bars.length, PROMPT_BARS)} 根 K 棒：`,
    rows,
    "",
    "圖上指標：",
    inds,
    `可加入的內建指標 type：${snap.nativeTypes.join(", ") || "（無）"}`,
  ].join("\n");
}
````

- [ ] **Step 4: Verify it passes**

Run: `npx vitest run src/services/__tests__/aiChat.test.ts`
Expected: `Tests  3 passed (3)`

---

### Task 3: 面板（純 DOM）與卡片執行器 `applyAction`

**Blocked by:** Task 1, Task 2

**Files:**
- Create: `src/pages/aiAssistantPanel.ts`
- Test: `src/pages/__tests__/aiAssistantPanel.test.ts`

**Interfaces:**
- Consumes: Task 1 `checkToolCall`、`describeAction`；Task 2 `buildSystemPrompt`、`ChatMessage`、`ChatReply`
- Produces: `mountAiAssistantPanel(body, deps) → { destroy() }`、`applyAction(ctx, action, snapSymbol) → string | null`、`AssistantChartCtx`、`AssistantDeps`。

**Done when:**
- `npx vitest run src/pages/__tests__/aiAssistantPanel.test.ts` → 9 passed。

- [ ] **Step 1: Write the test file exactly**

````ts
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
````

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run src/pages/__tests__/aiAssistantPanel.test.ts`
Expected: FAIL（`Failed to resolve import "../aiAssistantPanel.ts"`）

- [ ] **Step 3: Write the implementation exactly**

````ts
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
````

- [ ] **Step 4: Verify it passes**

Run: `npx vitest run src/pages/__tests__/aiAssistantPanel.test.ts`
Expected: `Tests  9 passed (9)`

---

### Task 4: 接上 Vela（註冊面板與頂列按鈕）與 `/__ai-chat` 中轉

**Blocked by:** Task 3

**Files:**
- Create: `src/pages/velaAiAssistant.ts`
- Modify: `src/pages/VelaPage.tsx`（只加 1 行 import）
- Modify: `vite.config.ts`（加 `aiChatPlugin` 一段 + 改 `plugins` 一行）

**Interfaces:**
- Consumes: Task 2 `streamChat`；Task 3 `mountAiAssistantPanel`、`applyAction`；`ShioajiVelaProvider`
- Produces: side panel `opencharts.ai-assistant`（標題「AI 副駕駛」）、頂列按鈕 `opencharts.ai-assistant.toggle`（label「AI」、`order: 5`）、dev endpoint `POST /__ai-chat`。

**Done when:**
- `npx tsc --noEmit` → 0 errors（與基準相同）。
- `VelaPage.tsx` 與 `vite.config.ts` 的 `git diff` 只多出下面指定的行；其餘內容與修改前完全相同。

- [ ] **Step 1: Create `src/pages/velaAiAssistant.ts` exactly**

````ts
/**
 * Registers the AI 副駕駛 side panel and its topbar toggle with Vela (side
 * effect, imported once by VelaPage). The panel is aiAssistantPanel.ts; this
 * file wires it to the live chart: the snapshot the LLM sees and the actions
 * a confirmed card runs.
 *
 * Import from "@luxalgo/vela/plugin", NOT the root barrel (separate module
 * instances — see velaPineEditor.ts header).
 */
import { registerIcon, registerSidePanel, registerWidgetAction, type WidgetContext } from "@luxalgo/vela/plugin";
import { svg16 } from "@luxalgo/vela/ui";
import { streamChat } from "../services/ai-assistant/chat.ts";
import type { ChartSnapshot } from "../services/ai-assistant/tools.ts";
import { ShioajiVelaProvider } from "../services/shioaji/velaProvider.ts";
import { applyAction, mountAiAssistantPanel } from "./aiAssistantPanel.ts";

const PANEL_ID = "opencharts.ai-assistant";
/** Bars fetched for the visible window (one request per question, never a burst). */
const MAX_BARS = 300;

const provider = new ShioajiVelaProvider();

/** Read the active chart at question time (ctx getters resolve to the selected cell). */
async function snapshot(ctx: WidgetContext) {
  const chart = ctx.chart;
  const symbol = ctx.symbol;
  const timeframe = ctx.timeframe;
  const vr = chart.getVisibleRange();
  const to = vr?.to ?? Date.now();
  const from = vr?.from ?? to - 86_400_000;
  // A malformed row (0 low/high) would widen the price band down to 0.
  const bars = (await provider.getBars(symbol, timeframe, { from, to, limit: MAX_BARS })).filter(
    (b) => b.time >= from && b.time <= to && b.low > 0 && b.high >= b.low && Number.isFinite(b.close),
  );
  const last = bars.at(-1);
  if (!last) throw new Error(`${symbol} 在可見範圍內沒有 K 棒`);
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

registerWidgetAction({
  id: "opencharts.ai-assistant.toggle",
  target: "topbar",
  align: "right",
  icon: "ai-assistant",
  label: "AI",
  order: 5,
  run: (ctx) => ctx.togglePanel(PANEL_ID),
});
````

- [ ] **Step 2: Edit `src/pages/VelaPage.tsx`, add one import line**

搜尋錨點（必須恰好出現一次）：

````tsx
import "./velaMarketWidgets.ts"; // 註冊報價列、電子熱力圖與排行榜（side effect）
````

取代為：

````tsx
import "./velaMarketWidgets.ts"; // 註冊報價列、電子熱力圖與排行榜（side effect）
import "./velaAiAssistant.ts"; // 註冊「AI 副駕駛」側邊面板與頂列 "AI" 按鈕（side effect）
````

- [ ] **Step 3: Edit `vite.config.ts`, insert the relay plugin**

搜尋錨點（必須恰好出現一次）：

````ts
export default defineConfig({
````

在這一行**正上方**插入下面整段（插入後該錨點行保持不變）：

````ts
/** Dev-only LLM relay for the AI 副駕駛 panel (src/pages/velaAiAssistant.ts):
 *  POST /__ai-chat {messages, tools} → local LLM proxy, streamed back as SSE.
 *  The upstream URL and model are fixed here, never taken from the request,
 *  so this cannot be used as an open relay; same loopback-origin, POST-only
 *  and body-cap rules as /__guard-log. */
const AI_UPSTREAM = "http://127.0.0.1:3425/v1/chat/completions"; // local magpie proxy
const AI_MODEL = "auto/minimax-m3";
const AI_MAX_BODY = 512 * 1024;

function aiChatPlugin(): Plugin {
  return {
    name: "ai-chat-relay",
    configureServer(server) {
      server.middlewares.use("/__ai-chat", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const origin = req.headers.origin;
        if (origin) {
          let originUrl: URL | null = null;
          try {
            originUrl = new URL(origin);
          } catch {
            originUrl = null;
          }
          if (!req.headers.host || !originUrl || originUrl.host !== req.headers.host || !GUARD_LOG_HOSTS.has(originUrl.hostname)) {
            res.statusCode = 403;
            res.end();
            return;
          }
        }
        let body = "";
        let size = 0;
        let tooLarge = false;
        req.on("data", (chunk) => {
          if (tooLarge) return;
          size += Buffer.byteLength(chunk);
          if (size > AI_MAX_BODY) {
            tooLarge = true;
            body = "";
            return;
          }
          body += chunk;
        });
        req.on("end", async () => {
          if (tooLarge) {
            res.statusCode = 413;
            res.end();
            return;
          }
          let parsed: { messages?: unknown; tools?: unknown } | null = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = null;
          }
          if (!parsed || !Array.isArray(parsed.messages) || !Array.isArray(parsed.tools)) {
            res.statusCode = 400;
            res.end();
            return;
          }
          try {
            const up = await fetch(AI_UPSTREAM, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: AI_MODEL, stream: true, messages: parsed.messages, tools: parsed.tools }),
            });
            res.statusCode = up.status;
            res.setHeader("Content-Type", up.headers.get("content-type") ?? "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            if (!up.body) {
              res.end();
              return;
            }
            const reader = up.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          } catch (e) {
            if (!res.headersSent) res.statusCode = 502;
            res.end(`LLM proxy unreachable: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
      });
    },
  };
}

````

- [ ] **Step 4: Edit `vite.config.ts`, register the plugin**

原文（必須恰好出現一次）：

````ts
  plugins: [react(), guardLogPlugin()],
````

取代為：

````ts
  plugins: [react(), guardLogPlugin(), aiChatPlugin()],
````

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output（0 errors）

- [ ] **Step 6: Re-run the three test files together**

Run: `npx vitest run src/services/__tests__/aiTools.test.ts src/services/__tests__/aiChat.test.ts src/pages/__tests__/aiAssistantPanel.test.ts`
Expected: `Test Files  3 passed (3)`、`Tests  30 passed (30)`

---

## Final Verification（Opus 驗收，不由執行者做）

1. 逐字比對：計畫內每個程式碼區塊 ↔ repo 實檔 → 全部 IDENTICAL。
2. `npx tsc --noEmit` 0 errors；3 個測試檔 30 passed。
3. `git diff -- src/pages/VelaPage.tsx vite.config.ts` 只多出 Task 4 指定的行。
3a. `tsconfig.json` 只 include `src`，Task 4 Step 5 的 tsc **不涵蓋 `vite.config.ts`**：中轉層由 Opus 另跑單檔 tsc 與 `/__ai-chat` 煙霧測試（暫開 Vite 於 5199：GET→405、外部 Origin→403、壞 body→400、正常→200 SSE 且 model 由伺服器決定）。
4. 手動（需 magpie 在線、Shioaji 8080 在線）：開 `http://localhost:5173/vela` → 頂列「AI」→ 問「在最近低點畫支撐線」→ 出現卡片 → 點「套用」→ 線畫在正確價位、**價格軸沒有被壓扁**、顏色紅／綠正確；切到別的商品再點舊卡片 → 顯示「圖表已切到 …」不畫。

---

## Phase 2（本計畫不執行，留作下一份計畫的輸入）

- **Pine 現場腳本**（`chart.runScript(source)`）：需腳本長度上限、執行逾時與「重腳本凍結主執行緒」防護（vela skill 第 8 條），且同樣走卡片確認。
- **下單提議** `propose_order`（商品、多空、口數、停損、停利、理由）：
  - 一律以 **enforce** 模式呼叫訂單守門員（不跟全域 `GUARD_MODE = "shadow"`）：veto 直接駁回並在對話說明理由，reduce 自動減半口數。
  - 目前 `guardedPlaceOrder` 接的是紙上交易引擎；Shioaji 實單路徑尚未接入（`src/services/guard/guardRuntime.ts` 註解），「授權模式直送 8080」要另案。
  - 下單代碼必須是 `frontMonthCode("TMF")` 解析出的實際近月，禁止 `TMFR1`。
  - 確認卡片同時在圖上畫進場／停損／停利線（沿用本計畫的 `applyAction` 防線）。

- 2026-10-21 14:56 更正：「收盤後 kbars 缺當天資料」的根因是當日 Shioaji 流量超過 500MB 上限（`GET /api/v1/auth/usage` 顯示 remaining 為負），不是 API 收盤後不給資料。
