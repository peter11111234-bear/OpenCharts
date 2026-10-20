# VELA 技術評分面板（實驗 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/vela` 頁加一個 TradingView 風格的「技術評分」側邊面板（半圓儀表 + 均線/震盪兩列），用永豐 Shioaji 的 K 棒、經我們自己的 Pine 直譯器計算，跟著目前選取的圖格切換商品/週期。

**Architecture:** 評分規則寫成一支 Pine 腳本 `src/pine/tech-rating.pine`（照 TradingView "Technical Ratings" 公開規則重寫），它同時自動出現在 VELA 指標選單。純邏輯模組 `techRating.ts` 抓 K 棒、在 Web Worker（失敗退回同執行緒）跑腳本、讀最後一根的 `All/MA/Osc` 值。無框架 DOM 模組 `techRatingPanel.ts` 畫儀表，`velaTechRating.ts` 用 VELA 的 `registerSidePanel` / `registerWidgetAction` 掛上側欄與頂列按鈕。

**Tech Stack:** React 19 + Vite + TypeScript、`@luxalgo/vela` 0.8.x plugin API、自研 Pine 直譯器（`src/pine/`）、vitest（jsdom）

**Spec:** 本檔〈Spec〉一節（來源：2026-10-20 與使用者的對話）

**Spec invariant:** The panel only READS the active cell's `symbol`/`timeframe`; it never changes the chart, never adds an indicator or legend row, and never writes the Vela workspace (`vela-workspace-v2`).

> **日期：** 2026-10-20

## Spec

1. 主圖維持 OPENCHART + VELA（`/vela`，`src/pages/VelaPage.tsx`），不得改主圖行為。
2. 面板資料來源 = 永豐 Shioaji（`ShioajiVelaProvider.getBars`），不用 TradingView 的 iframe 或資料。
3. 評分 = TradingView Technical Ratings 規則：15 個均線票（SMA/EMA 10/20/30/50/100/200、Ichimoku、VWMA20、HMA9）、11 個震盪票（RSI14、Stoch14/3/3、CCI20、ADX14、AO、Mom10、MACD12/26/9、StochRSI3/3/14/14、W%R14、Bull Bear Power、UO7/14/28）；每票 +1/0/-1，暖機中為 na 不計；MA = 均線票平均、Osc = 震盪票平均、All = (MA+Osc)/2。
4. 分級：(0.5,1] 強力買入、(0.1,0.5] 買入、[-0.1,0.1] 中立、[-0.5,-0.1) 賣出、[-1,-0.5) 強力賣出；無值顯示「資料不足」。
5. 面板跟隨目前選取圖格的商品/週期（含微台 `TMF`，用 `TMF` 自己的 K 棒，不換成小台）。
6. 計算不可卡住主執行緒：300 根一次約 0.6 秒，必須優先在 Worker 跑。
7. 範圍外：基本面、經濟日曆、報價卡、熱力圖、排行榜（各自另寫計畫）。

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same
verify failing after 2+ distinct fix attempts. Single red test = normal TDD
loop, not a blocker.

Never stop to ask what you can look up, file locations, signatures, test
names: search first. Questions that don't change your next action: note them,
keep going, report at task end.

**Plan-specific Nevers:**
- NEVER run `git commit`, `git add`, `git stash`, `git checkout`, `git reset` or `git restore`, settled in D2. The working tree holds the user's uncommitted work.
- NEVER import `registerSidePanel` / `registerWidgetAction` / `registerIcon` from the root `"@luxalgo/vela"`; use `"@luxalgo/vela/plugin"` (root and plugin are separate module instances, panel would silently not appear).
- NEVER call `runScript` from `techRatingPanel.ts` or `velaTechRating.ts`; all script runs go through `computeRating` → `defaultRun` (Worker first), settled in D1.
- NEVER subscribe the panel to the workspace `"state:changed"` event; it polls `ctx.symbol`/`ctx.timeframe` (Vela fires state events for drawings/style too; this page has a history of event-storm freezes).
- NEVER edit numbers/rules in `tech-rating.pine` to make a test pass. A failing interpreter test → report it (it may be an interpreter bug).
- NEVER modify files not listed in a task's `Files:` (especially `src/components/TradingViewWidgets.tsx`, `src/pages/velaPineEditor.ts`, `src/services/shioaji/velaProvider.ts`).
- NEVER rename `src/pine/tech-rating.pine`; `techRatingSource()` looks it up by the name `tech-rating`.

## Global Constraints

- Working directory: `C:\Users\bear9\OpenCharts`（shell = Git Bash；路徑用 `/c/Users/bear9/OpenCharts`）。
- Test runner: `npx vitest run <file>`（全套 `npx vitest run`，約 4–5 分鐘，timeout 設 600000ms）。
- Typecheck: `npx tsc --noEmit` → 無輸出 = 通過。
- **不要跑 `npx eslint`**：專案的 ESLint 設定檔本來就壞（v9 找不到 `eslint.config.*`），和本計畫無關。
- 程式碼註解、識別字用英文；使用者看得到的字串用繁體中文。
- 不新增 npm 依賴。
- Import 路徑沿用專案慣例：相對路徑並帶 `.ts` 副檔名（例：`"./techRating.ts"`）。

## Decision Points

### D1: 面板從哪裡拿評分數值   (T1)
- Consumed by: Task 1, Task 2, Task 3
- Candidates:
  - A (existing pattern): 把腳本當指標跑在圖上，再讀 handle 的 `series()`, `src/pages/VelaPage.tsx` `restoreParked` 用 `cell.chart.runIndicator(...)`
  - B (minimal): 只提供 `tech-rating.pine` 讓使用者自己從指標選單加，不做面板
  - C (preferred): 面板自己用 `ShioajiVelaProvider.getBars` 抓 K 棒，經 `PineRunClient`（Worker）跑同一支腳本，讀最後一根值
- Criteria:
  - Adds no indicator row to the user's chart legend
  - Delivers a side-panel gauge (Spec 5)
  - Rating rules live in exactly one file (`tech-rating.pine`)
- Chosen: C
- Rejected: A fails "Adds no indicator row to the user's chart legend"; B fails "Delivers a side-panel gauge"
- Revisit trigger: `getBars` for the active symbol returns bars that differ from what the chart shows (e.g. chart uses a server-side cache the provider bypasses)
- Outcome: held（Task 1–3 全程走 C：面板自抓 `getBars`、經 `PineRunClient` 跑腳本；revisit trigger 未觸發，未實測 live shioaji 對照，待人工驗收）

### D2: 執行者要不要 commit   (T1)
- Consumed by: Task 1, Task 2, Task 3
- Candidates:
  - A (existing pattern): 每個 task 結束 `git commit`（real-plan 預設）
  - B (minimal): 不 commit，改動留在 working tree，最後列出檔案清單給使用者審
  - C (preferred): 只 `git add` 本計畫的檔案再 commit
- Criteria:
  - No commit contains a line the user wrote but has not committed
  - `src/pages/VelaPage.tsx` change can be included without its pre-existing uncommitted line (`import "./velaNautilusBacktest.ts"`, references an untracked file)
  - Executor never needs an interactive git command
- Chosen: B
- Rejected: A fails "No commit contains a line the user wrote but has not committed"; C fails "VelaPage.tsx change can be included without its pre-existing uncommitted line" (needs `git add -p`, interactive)
- Revisit trigger: user commits or discards their pending `VelaPage.tsx` / `velaNautilusBacktest.ts` work before execution
- Outcome: held（未執行任何 git 寫入指令；工作區仍含使用者原有 `velaNautilusBacktest.ts` 未 commit 工作，故 `VelaPage.tsx` diff 同時顯示該行與新增行）

## Fact Annex（計畫撰寫時已實際驗證，2026-10-20）

- `parse(src: string)`, `src/pine/parser.ts`；`runScript(parsed, bars: BarData[], opts?)` → `Promise<RunResult>`, `src/pine/interpreter.ts`
- `RunResult.plots: Map<title, { values: Value[]; ... }>`；`Value` 數值型為 `{ kind: 'int' | 'float'; v: number }`，無值 `{ kind: 'na' }`, `src/pine/contracts.ts`
- `BarData = { openTime, open, high, low, close, volume, closeTime? }`, `src/pine/contracts.ts:220`
- `PineRunClient`：`new PineRunClient()`、`.unavailable: boolean`（jsdom 無 Worker → true）、`.run({ source, bars })` → `Promise<RunResult>`，同時只能一個 run（否則 reject `'run in flight'`）, `src/pine/pineWorkerClient.ts:90,218`
- `loadPineManifest()` → `{ name, script, ... }[]`，`name` = 檔名去掉 `.pine`；`src/pine/*.pine` 由 `import.meta.glob(..., { query: "?raw" })` 自動打包並出現在 VELA 指標選單, `src/pineScripts.ts:27,44`
- `ShioajiVelaProvider` 無 constructor；`getBars(ticker, timeframe, { from?, to?, limit? })` → `Promise<OHLCV[]>`，`OHLCV = { time, open, high, low, close, volume? }`（time 為毫秒）, `src/services/shioaji/velaProvider.ts:85,132`
- Vela side panel：`registerSidePanel({ id, title, icon, width, resizable, minWidth, mount(ctx, body, header) })`，`mount` 回傳 `{ onChart?, onOpen?, destroy? }`；`ctx.symbol` / `ctx.timeframe` 是即時 getter（換商品時就地套用）；`ctx.togglePanel(id, open?)`, `node_modules/@luxalgo/vela/dist/contributions-BY3zSYiZ.d.ts:1913,2056`
- 先例：`src/pages/velaPineEditor.ts` 的 `registerSidePanel({ id: "opencharts.objtree", ... })`；`registerIcon("objtree", svg16(...))`；`import { svg16 } from "@luxalgo/vela/ui"`；`src/pages/velaNautilusBacktest.ts` 的 `registerWidgetAction({ target: "topbar", order: 1, ... })`
- 全部程式碼已於 2026-10-20 在本 repo 試跑：Task 1 測試 19/19、Task 2 測試 8/8、`npx tsc --noEmit` 通過；試跑檔案已刪除，working tree 回到原狀。
- 效能實測：300 根 K 棒跑一次 `tech-rating.pine` 約 545–872ms（vitest/jsdom，同執行緒）。

## Review Ledger

（執行時追加）

---

### Task 1: 評分腳本 + 計算模組

**Blocked by:** None, can start immediately

**Files:**
- Create: `src/pine/tech-rating.pine`
- Create: `src/pages/techRating.ts`
- Test: `src/pages/__tests__/techRating.test.ts`（`src/pages/__tests__/` 目錄目前不存在，要建立）

**Interfaces:**
- Consumes: Fact Annex 的 `parse`、`runScript`、`PineRunClient`、`loadPineManifest`、`BarData`、`RunResult`、`OHLCV`
- Produces:
  - `export type RatingKey = "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell"`
  - `export const RATING_LABELS: Record<RatingKey, string>`
  - `export const RATING_BAR_LIMIT = 300`、`export const RATING_FULL_BARS = 200`
  - `export interface RatingSnapshot { all: number | null; ma: number | null; osc: number | null; bars: number }`
  - `export type FetchBarsFn = (symbol: string, timeframe: string, fromMs: number, limit: number) => Promise<OHLCV[]>`
  - `export type RunFn = (source: string, bars: BarData[]) => Promise<RunResult>`
  - `export function ratingKey(v: number | null): RatingKey | null`
  - `export function lookbackMs(timeframe: string): number`
  - `export function computeRating(symbol: string, timeframe: string, deps: { fetchBars: FetchBarsFn; run?: RunFn; now?: () => number }): Promise<RatingSnapshot>`

**Assumptions:**
- Assumption: 「上升/下降趨勢」（StochRSI、Bull Bear Power 用）以 `close` 對 `SMA(50)` 判斷。
- Assumption: Ichimoku 雲用 25 根前的先行線（`lead[25]`，即位移 26 的當根雲）。

**Done when:**
- `npx vitest run src/pages/__tests__/techRating.test.ts` → 19 passed
- 300 根穩定上漲 → `ma > 0.5` 且 `all > 0.1`
- 300 根穩定下跌 → `ma < -0.5` 且 `all < -0.1`
- 0 根 K 棒 → `{ all: null, ma: null, osc: null, bars: 0 }`（邊界）
- fetcher 丟錯 → `computeRating` reject 同一個錯誤，不吞掉（失敗案例）
- `ratingKey(0.5)` → `"buy"`、`ratingKey(0.51)` → `"strong_buy"`、`ratingKey(-0.1)` → `"neutral"`（邊界）
- `npx tsc --noEmit` → 無輸出

- [ ] **Step 1: 建立 Pine 腳本**, 建立 `src/pine/tech-rating.pine`，內容完全如下：

```pine
//@version=6
//@category=OpenCharts
// Technical Rating, TradingView "Technical Ratings" rules re-implemented on
// our own data. Each component votes +1 (buy) / 0 (neutral) / -1 (sell); a
// component still warming up votes na and is left out of the average.
// MA = mean of MA votes, Osc = mean of oscillator votes, All = (MA + Osc) / 2.
indicator("Tech Rating", overlay = false)

vote(bool ready, bool buy, bool sell) => ready ? (buy ? 1.0 : sell ? -1.0 : 0.0) : na
maVote(float ma) => vote(not na(ma), ma < close, ma > close)

avgOf(array<float> votes) =>
    float s = 0.0
    int n = 0
    for v in votes
        if not na(v)
            s += v
            n += 1
    n > 0 ? s / n : na

// ── Moving averages ──
conv = math.avg(ta.highest(high, 9), ta.lowest(low, 9))
base = math.avg(ta.highest(high, 26), ta.lowest(low, 26))
lead1 = math.avg(conv, base)
lead2 = math.avg(ta.highest(high, 52), ta.lowest(low, 52))
cloud1 = lead1[25]
cloud2 = lead2[25]
ichiReady = not na(cloud2) and not na(base)
ichiVote = vote(ichiReady, base < close and ta.crossover(conv, close) and cloud1 > close and cloud1 > cloud2, base > close and ta.crossunder(conv, close) and cloud1 < close and cloud1 < cloud2)

maVotes = array.from(maVote(ta.sma(close, 10)), maVote(ta.sma(close, 20)), maVote(ta.sma(close, 30)), maVote(ta.sma(close, 50)), maVote(ta.sma(close, 100)), maVote(ta.sma(close, 200)), maVote(ta.ema(close, 10)), maVote(ta.ema(close, 20)), maVote(ta.ema(close, 30)), maVote(ta.ema(close, 50)), maVote(ta.ema(close, 100)), maVote(ta.ema(close, 200)), ichiVote, maVote(ta.vwma(close, 20)), maVote(ta.hma(close, 9)))
maRating = avgOf(maVotes)

// ── Oscillators ──
trendMa = ta.sma(close, 50)
up = close > trendMa
down = close < trendMa

rsi = ta.rsi(close, 14)
rsiVote = vote(not na(rsi[1]), rsi < 30 and rsi > rsi[1], rsi > 70 and rsi < rsi[1])

stK = ta.sma(ta.stoch(close, high, low, 14), 3)
stD = ta.sma(stK, 3)
stochVote = vote(not na(stD[1]), stK < 20 and ta.crossover(stK, stD), stK > 80 and ta.crossunder(stK, stD))

cci = ta.cci(hlc3, 20)
cciVote = vote(not na(cci[1]), cci < -100 and cci > cci[1], cci > 100 and cci < cci[1])

[diPlus, diMinus, adx] = ta.dmi(14, 14)
adxVote = vote(not na(adx) and not na(diPlus[1]), adx > 20 and diPlus[1] < diMinus[1] and diPlus > diMinus, adx > 20 and diPlus[1] > diMinus[1] and diPlus < diMinus)

ao = ta.sma(hl2, 5) - ta.sma(hl2, 34)
aoVote = vote(not na(ao[2]), (ao > 0 and ao > ao[1] and ao[1] < ao[2]) or ta.crossover(ao, 0), (ao < 0 and ao < ao[1] and ao[1] > ao[2]) or ta.crossunder(ao, 0))

mom = close - close[10]
momVote = vote(not na(mom[1]), mom > mom[1], mom < mom[1])

[macdLine, signalLine, _hist] = ta.macd(close, 12, 26, 9)
macdVote = vote(not na(signalLine), macdLine > signalLine, macdLine < signalLine)

srRsi = ta.rsi(close, 14)
srK = ta.sma(ta.stoch(srRsi, srRsi, srRsi, 14), 3)
srD = ta.sma(srK, 3)
stochRsiVote = vote(not na(srD[1]) and not na(trendMa), down and srK < 20 and srD < 20 and ta.crossover(srK, srD), up and srK > 80 and srD > 80 and ta.crossunder(srK, srD))

wpr = ta.wpr(14)
wprVote = vote(not na(wpr[1]), wpr < -80 and wpr > wpr[1], wpr > -20 and wpr < wpr[1])

e13 = ta.ema(close, 13)
bullPower = high - e13
bearPower = low - e13
bbpVote = vote(not na(bearPower[1]) and not na(trendMa), up and bearPower < 0 and bearPower > bearPower[1], down and bullPower > 0 and bullPower < bullPower[1])

bp = close - math.min(low, nz(close[1], close))
tr = math.max(high, nz(close[1], close)) - math.min(low, nz(close[1], close))
a7 = math.sum(bp, 7) / math.sum(tr, 7)
a14 = math.sum(bp, 14) / math.sum(tr, 14)
a28 = math.sum(bp, 28) / math.sum(tr, 28)
uo = 100 * (4 * a7 + 2 * a14 + a28) / 7
uoVote = vote(not na(uo), uo > 70, uo < 30)

oscVotes = array.from(rsiVote, stochVote, cciVote, adxVote, aoVote, momVote, macdVote, stochRsiVote, wprVote, bbpVote, uoVote)
oscRating = avgOf(oscVotes)

allRating = na(maRating) or na(oscRating) ? na : (maRating + oscRating) / 2

plot(allRating, "All", color = color.yellow)
plot(maRating, "MA", color = color.blue)
plot(oscRating, "Osc", color = color.orange)
hline(0.5, "Strong buy", color = color.green)
hline(0.1, "Buy", color = color.gray)
hline(-0.1, "Sell", color = color.gray)
hline(-0.5, "Strong sell", color = color.red)
```

- [ ] **Step 2: 寫失敗測試**, 建立 `src/pages/__tests__/techRating.test.ts`，內容完全如下：

```ts
import { describe, expect, it } from "vitest";
import type { OHLCV } from "@luxalgo/vela";
import {
  computeRating,
  lookbackMs,
  ratingKey,
  RATING_BAR_LIMIT,
  techRatingSource,
  type FetchBarsFn,
} from "../techRating.ts";

const series = (n: number, f: (i: number) => number): OHLCV[] =>
  Array.from({ length: n }, (_, i) => {
    const c = f(i);
    return { time: i * 300_000, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
  });

const fetchOf = (bars: OHLCV[]): FetchBarsFn => async () => bars;

describe("ratingKey, TradingView bands", () => {
  it.each([
    [1, "strong_buy"],
    [0.51, "strong_buy"],
    [0.5, "buy"],
    [0.11, "buy"],
    [0.1, "neutral"],
    [0, "neutral"],
    [-0.1, "neutral"],
    [-0.11, "sell"],
    [-0.5, "sell"],
    [-0.51, "strong_sell"],
  ] as const)("%s → %s", (v, key) => {
    expect(ratingKey(v)).toBe(key);
  });

  it("null / NaN → null (no rating)", () => {
    expect(ratingKey(null)).toBeNull();
    expect(ratingKey(Number.NaN)).toBeNull();
  });
});

describe("lookbackMs", () => {
  it("intraday asks for 8× the bar span, daily 1.6×", () => {
    expect(lookbackMs("5")).toBe(5 * 60_000 * RATING_BAR_LIMIT * 8);
    expect(lookbackMs("D")).toBe(1440 * 60_000 * RATING_BAR_LIMIT * 1.6);
    expect(lookbackMs("W")).toBe(10080 * 60_000 * RATING_BAR_LIMIT * 1.6);
  });
});

describe("tech-rating.pine via the interpreter", () => {
  it("is bundled in the Pine manifest", () => {
    expect(techRatingSource()).toContain('indicator("Tech Rating"');
  });

  it("steady uptrend → MA strongly positive, overall buy side", async () => {
    const r = await computeRating("TSE:2330", "5", { fetchBars: fetchOf(series(300, (i) => 100 + i)) });
    expect(r.bars).toBe(300);
    expect(r.ma).toBeGreaterThan(0.5);
    expect(r.all).toBeGreaterThan(0.1);
  });

  it("steady downtrend → MA strongly negative, overall sell side", async () => {
    const r = await computeRating("TSE:2330", "5", { fetchBars: fetchOf(series(300, (i) => 500 - i)) });
    expect(r.ma).toBeLessThan(-0.5);
    expect(r.all).toBeLessThan(-0.1);
  });

  it("every value stays inside [-1, 1]", async () => {
    const r = await computeRating("TSE:2330", "5", {
      fetchBars: fetchOf(series(300, (i) => 100 + 10 * Math.sin(i / 7))),
    });
    for (const v of [r.all, r.ma, r.osc]) {
      expect(v).not.toBeNull();
      expect(Math.abs(v!)).toBeLessThanOrEqual(1);
    }
  });

  it("no bars → all null, bars 0", async () => {
    const r = await computeRating("TSE:2330", "5", { fetchBars: fetchOf([]) });
    expect(r).toEqual({ all: null, ma: null, osc: null, bars: 0 });
  });

  it("asks the fetcher for RATING_BAR_LIMIT bars from now - lookback", async () => {
    const calls: unknown[][] = [];
    const fetchBars: FetchBarsFn = async (...args) => {
      calls.push(args);
      return [];
    };
    await computeRating("TAIFEX:TMFJ6", "60", { fetchBars, now: () => 1_000_000_000_000 });
    expect(calls).toEqual([["TAIFEX:TMFJ6", "60", 1_000_000_000_000 - lookbackMs("60"), RATING_BAR_LIMIT]]);
  });

  it("fetch failure propagates (panel shows the error)", async () => {
    const fetchBars: FetchBarsFn = async () => {
      throw new Error("shioaji down");
    };
    await expect(computeRating("TSE:2330", "5", { fetchBars })).rejects.toThrow("shioaji down");
  });
});
```

- [ ] **Step 3: 確認測試失敗**

Run: `cd /c/Users/bear9/OpenCharts && npx vitest run src/pages/__tests__/techRating.test.ts`
Expected: FAIL, `Failed to resolve import "../techRating.ts"`（模組還不存在）

- [ ] **Step 4: 實作**, 建立 `src/pages/techRating.ts`，內容完全如下：

```ts
/**
 * Technical rating for the Vela side panel, runs src/pine/tech-rating.pine
 * (TradingView "Technical Ratings" rules) on shioaji bars. Pure logic, no DOM:
 * the panel (techRatingPanel.ts) and its Vela registration (velaTechRating.ts)
 * build on this.
 */
import type { OHLCV } from "@luxalgo/vela";
import type { BarData, RunResult } from "../pine/contracts.ts";
import { parse } from "../pine/parser.ts";
import { runScript } from "../pine/interpreter.ts";
import { PineRunClient } from "../pine/pineWorkerClient.ts";
import { loadPineManifest } from "../pineScripts.ts";
import "../pine/builtins/index.ts";

export const TECH_RATING_SCRIPT_NAME = "tech-rating";
export const RATING_BAR_LIMIT = 300;
/** Below this many bars SMA/EMA 200 are still warming up and sit out the vote. */
export const RATING_FULL_BARS = 200;

export type RatingKey = "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";

export const RATING_LABELS: Record<RatingKey, string> = {
  strong_buy: "強力買入",
  buy: "買入",
  neutral: "中立",
  sell: "賣出",
  strong_sell: "強力賣出",
};

export interface RatingSnapshot {
  all: number | null;
  ma: number | null;
  osc: number | null;
  bars: number;
}

export type RunFn = (source: string, bars: BarData[]) => Promise<RunResult>;
export type FetchBarsFn = (symbol: string, timeframe: string, fromMs: number, limit: number) => Promise<OHLCV[]>;

/** TradingView's bands: (0.5, 1] strong buy, (0.1, 0.5] buy, [-0.1, 0.1] neutral,
 *  [-0.5, -0.1) sell, [-1, -0.5) strong sell. */
export function ratingKey(v: number | null): RatingKey | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (v > 0.5) return "strong_buy";
  if (v > 0.1) return "buy";
  if (v >= -0.1) return "neutral";
  if (v >= -0.5) return "sell";
  return "strong_sell";
}

export function techRatingSource(): string {
  const entry = loadPineManifest().find((m) => m.name === TECH_RATING_SCRIPT_NAME);
  if (!entry) throw new Error(`src/pine/${TECH_RATING_SCRIPT_NAME}.pine missing`);
  return entry.script;
}

/** How far back to ask for RATING_BAR_LIMIT bars: calendar time spans
 *  non-trading hours, so intraday gets 8× and daily/weekly 1.6× headroom. */
export function lookbackMs(timeframe: string): number {
  const minutes = timeframe === "D" ? 1440 : timeframe === "W" ? 10080 : Number(timeframe) || 1;
  const headroom = minutes >= 1440 ? 1.6 : 8;
  return minutes * 60_000 * RATING_BAR_LIMIT * headroom;
}

function lastNum(r: RunResult, title: string): number | null {
  const plot = r.plots.get(title);
  const v = plot?.values[plot.values.length - 1];
  if (!v || (v.kind !== "float" && v.kind !== "int")) return null;
  return Number.isFinite(v.v) ? v.v : null;
}

export function readRating(r: RunResult, bars: number): RatingSnapshot {
  return { all: lastNum(r, "All"), ma: lastNum(r, "MA"), osc: lastNum(r, "Osc"), bars };
}

const toBarData = (b: OHLCV): BarData => ({
  openTime: b.time,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  volume: b.volume ?? 0,
});

let workerClient: PineRunClient | null = null;

/** Off the main thread when Workers exist (one 300-bar run is ~0.6s);
 *  in-process otherwise (tests, or a worker that died). */
export const defaultRun: RunFn = async (source, bars) => {
  workerClient ??= new PineRunClient();
  if (!workerClient.unavailable) {
    try {
      return await workerClient.run({ source, bars });
    } catch {
      // fall through to in-process
    }
  }
  return runScript(parse(source), bars);
};

export async function computeRating(
  symbol: string,
  timeframe: string,
  deps: { fetchBars: FetchBarsFn; run?: RunFn; now?: () => number },
): Promise<RatingSnapshot> {
  const now = deps.now?.() ?? Date.now();
  const ohlcv = await deps.fetchBars(symbol, timeframe, now - lookbackMs(timeframe), RATING_BAR_LIMIT);
  const bars = ohlcv.map(toBarData);
  if (bars.length === 0) return { all: null, ma: null, osc: null, bars: 0 };
  const result = await (deps.run ?? defaultRun)(techRatingSource(), bars);
  return readRating(result, bars.length);
}
```

- [ ] **Step 5: 確認測試通過**

Run: `cd /c/Users/bear9/OpenCharts && npx vitest run src/pages/__tests__/techRating.test.ts`
Expected: `Tests  19 passed (19)`

- [ ] **Step 6: 型別檢查**

Run: `cd /c/Users/bear9/OpenCharts && npx tsc --noEmit`
Expected: 無輸出

- [ ] **Step 7: 不 commit（D2）**, 在 task 報告中列出：`src/pine/tech-rating.pine`、`src/pages/techRating.ts`、`src/pages/__tests__/techRating.test.ts`。

---

### Task 2: 儀表面板（DOM）

**Blocked by:** Task 1（import `RatingSnapshot`、`ratingKey`、`RATING_LABELS`、`RATING_FULL_BARS`）

**Files:**
- Create: `src/pages/techRatingPanel.ts`
- Test: `src/pages/__tests__/techRatingPanel.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RatingSnapshot`、`RatingKey`、`ratingKey`、`RATING_LABELS`、`RATING_FULL_BARS`
- Produces:
  - `export interface RatingPanelCtx { readonly symbol: string; readonly timeframe: string }`
  - `export interface RatingPanelDeps { compute: (symbol: string, timeframe: string) => Promise<RatingSnapshot>; pollMs?: number; refreshMs?: number }`
  - `export interface RatingPanelHandle { refresh(): void; destroy(): void }`
  - `export function mountTechRatingPanel(ctx: RatingPanelCtx, body: HTMLElement, deps: RatingPanelDeps): RatingPanelHandle`

**Assumptions:**
- Assumption: 面板隱藏時仍每 60 秒重算一次（在 Worker 跑，不卡主執行緒），不偵測可見性。

**Done when:**
- `npx vitest run src/pages/__tests__/techRatingPanel.test.ts` → 8 passed
- 評分 0.48 → 畫面顯示「買入」、「0.48」，且有 `.tr-needle` 指針
- 評分 null → 顯示「資料不足」，沒有指針（邊界）
- compute 丟錯 → 顯示「無法取得評分：<訊息>」，不往外丟（失敗案例）
- 商品沒變 → 輪詢 5 秒內不重算；商品變了 → 1 秒內用新商品重算
- 舊商品的慢結果不會蓋掉新商品的畫面
- `destroy()` 後不再重算，`.tr-panel` 從 DOM 移除
- `npx tsc --noEmit` → 無輸出

- [ ] **Step 1: 寫失敗測試**, 建立 `src/pages/__tests__/techRatingPanel.test.ts`，內容完全如下：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountTechRatingPanel, type RatingPanelHandle } from "../techRatingPanel.ts";
import type { RatingSnapshot } from "../techRating.ts";

const snap = (all: number | null, ma: number | null, osc: number | null, bars = 300): RatingSnapshot => ({
  all,
  ma,
  osc,
  bars,
});

describe("mountTechRatingPanel", () => {
  let body: HTMLElement;
  let handle: RatingPanelHandle | null = null;
  const ctx = { symbol: "TSE:2330", timeframe: "5" };

  beforeEach(() => {
    vi.useFakeTimers();
    body = document.createElement("div");
    document.body.appendChild(body);
    ctx.symbol = "TSE:2330";
    ctx.timeframe = "5";
  });

  afterEach(() => {
    handle?.destroy();
    handle = null;
    body.remove();
    vi.useRealTimers();
  });

  it("renders the overall label, MA and oscillator rows, and a needle", async () => {
    const compute = vi.fn(async () => snap(0.48, 0.87, 0.1));
    handle = mountTechRatingPanel(ctx, body, { compute });
    await vi.waitFor(() => expect(body.textContent).toContain("買入"));
    expect(body.textContent).toContain("0.48");
    expect(body.textContent).toContain("強力買入 0.87");
    expect(body.textContent).toContain("中立 0.10");
    expect(body.textContent).toContain("TSE:2330 · 5 · 300 根 K 棒");
    expect(body.querySelector(".tr-needle")).not.toBeNull();
    expect(compute).toHaveBeenCalledWith("TSE:2330", "5");
  });

  it("null rating → 資料不足 and no needle", async () => {
    handle = mountTechRatingPanel(ctx, body, { compute: async () => snap(null, null, null, 0) });
    await vi.waitFor(() => expect(body.textContent).toContain("資料不足"));
    expect(body.querySelector(".tr-needle")).toBeNull();
  });

  it("fewer than 200 bars shows the warm-up warning", async () => {
    handle = mountTechRatingPanel(ctx, body, { compute: async () => snap(0.2, 0.3, 0.1, 120) });
    await vi.waitFor(() => expect(body.textContent).toContain("只有 120 根 K 棒"));
  });

  it("compute error is shown, not thrown", async () => {
    handle = mountTechRatingPanel(ctx, body, {
      compute: async () => {
        throw new Error("shioaji down");
      },
    });
    await vi.waitFor(() => expect(body.textContent).toContain("無法取得評分：shioaji down"));
  });

  it("symbol switch triggers a recompute for the new symbol", async () => {
    const compute = vi.fn(async () => snap(0.2, 0.2, 0.2));
    handle = mountTechRatingPanel(ctx, body, { compute, pollMs: 1000 });
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    ctx.symbol = "TAIFEX:TMFJ6";
    await vi.advanceTimersByTimeAsync(1000);
    expect(compute).toHaveBeenLastCalledWith("TAIFEX:TMFJ6", "5");
  });

  it("unchanged symbol does NOT recompute on the poll tick", async () => {
    const compute = vi.fn(async () => snap(0.2, 0.2, 0.2));
    handle = mountTechRatingPanel(ctx, body, { compute, pollMs: 1000, refreshMs: 60_000 });
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("a stale result never overwrites the newer symbol", async () => {
    let release!: (s: RatingSnapshot) => void;
    const compute = vi
      .fn<(s: string, tf: string) => Promise<RatingSnapshot>>()
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockImplementation(async () => snap(-0.6, -0.6, -0.6));
    handle = mountTechRatingPanel(ctx, body, { compute, pollMs: 1000 });
    ctx.symbol = "TAIFEX:TMFJ6";
    await vi.advanceTimersByTimeAsync(1000); // queued behind the in-flight run
    release(snap(0.9, 0.9, 0.9));
    await vi.waitFor(() => expect(body.textContent).toContain("強力賣出"));
    expect(body.textContent).toContain("TAIFEX:TMFJ6");
  });

  it("destroy stops polling and removes the DOM", async () => {
    const compute = vi.fn(async () => snap(0.2, 0.2, 0.2));
    handle = mountTechRatingPanel(ctx, body, { compute, pollMs: 1000 });
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1));
    handle.destroy();
    handle = null;
    ctx.symbol = "OTC:6547";
    await vi.advanceTimersByTimeAsync(5000);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(body.querySelector(".tr-panel")).toBeNull();
  });
});
```

- [ ] **Step 2: 確認測試失敗**

Run: `cd /c/Users/bear9/OpenCharts && npx vitest run src/pages/__tests__/techRatingPanel.test.ts`
Expected: FAIL, `Failed to resolve import "../techRatingPanel.ts"`

- [ ] **Step 3: 實作**, 建立 `src/pages/techRatingPanel.ts`，內容完全如下：

```ts
/**
 * Technical-rating side panel body: a TradingView-style half-circle gauge
 * (strong sell → strong buy) plus MA / oscillator rows. Framework-free DOM so
 * it mounts straight into a Vela side panel; it only READS the market from
 * ctx (symbol/timeframe) and never touches the chart.
 */
import { RATING_FULL_BARS, RATING_LABELS, ratingKey, type RatingKey, type RatingSnapshot } from "./techRating.ts";

export interface RatingPanelCtx {
  readonly symbol: string;
  readonly timeframe: string;
}

export interface RatingPanelDeps {
  compute: (symbol: string, timeframe: string) => Promise<RatingSnapshot>;
  /** How often to check whether the active symbol/timeframe changed. */
  pollMs?: number;
  /** How often to recompute for the same market (new bars). */
  refreshMs?: number;
}

export interface RatingPanelHandle {
  refresh(): void;
  destroy(): void;
}

const BANDS: ReadonlyArray<[number, number, RatingKey]> = [
  [-1, -0.5, "strong_sell"],
  [-0.5, -0.1, "sell"],
  [-0.1, 0.1, "neutral"],
  [0.1, 0.5, "buy"],
  [0.5, 1, "strong_buy"],
];

const COLORS: Record<RatingKey, string> = {
  strong_sell: "#f23645",
  sell: "#f77c80",
  neutral: "#787b86",
  buy: "#5b9cf6",
  strong_buy: "#2962ff",
};

const CSS = `
.tr-panel{display:flex;flex-direction:column;gap:10px;padding:12px;color:var(--vela-fg,#d1d4dc);
  font:12px/1.4 -apple-system,Segoe UI,sans-serif}
.tr-gauge{width:100%;max-width:240px;align-self:center}
.tr-main{text-align:center;font-size:18px;font-weight:600}
.tr-row{display:flex;justify-content:space-between;padding:4px 0;border-top:1px solid var(--vela-border,#2a2e39)}
.tr-meta{color:var(--vela-fg-muted,#868993);font-size:11px}
.tr-warn{color:#f9a825;font-size:11px}
`;

// Gauge geometry: centre (100,100), radius 80; v = -1 at the left, +1 at the right.
const point = (v: number, r: number): [number, number] => {
  const theta = Math.PI * (1 - (v + 1) / 2);
  return [100 + r * Math.cos(theta), 100 - r * Math.sin(theta)];
};

function gaugeSvg(v: number | null): string {
  const arcs = BANDS.map(([from, to, key]) => {
    const [x1, y1] = point(from, 80);
    const [x2, y2] = point(to, 80);
    return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A80 80 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${COLORS[key]}" stroke-width="14" fill="none"/>`;
  }).join("");
  const needle =
    v === null
      ? ""
      : (() => {
          const [x, y] = point(Math.max(-1, Math.min(1, v)), 66);
          return `<line class="tr-needle" x1="100" y1="100" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="100" cy="100" r="5" fill="currentColor"/>`;
        })();
  return `<svg class="tr-gauge" viewBox="0 0 200 110" role="img" aria-label="技術評分儀表">${arcs}${needle}</svg>`;
}

const labelOf = (v: number | null): string => {
  const key = ratingKey(v);
  return key ? RATING_LABELS[key] : "資料不足";
};
const colorOf = (v: number | null): string => {
  const key = ratingKey(v);
  return key ? COLORS[key] : COLORS.neutral;
};
const fmt = (v: number | null): string => (v === null ? ", " : v.toFixed(2));

export function mountTechRatingPanel(ctx: RatingPanelCtx, body: HTMLElement, deps: RatingPanelDeps): RatingPanelHandle {
  const doc = body.ownerDocument;
  if (!doc.querySelector("style[data-tech-rating]")) {
    const s = doc.createElement("style");
    s.dataset.techRating = "";
    s.textContent = CSS;
    doc.head.appendChild(s);
  }
  const root = doc.createElement("div");
  root.className = "tr-panel";
  body.appendChild(root);

  let seq = 0;
  let busy = false;
  let again = false;
  let lastKey = "";
  let disposed = false;

  const render = (html: string) => {
    root.innerHTML = html;
  };

  const show = (snap: RatingSnapshot, symbol: string, timeframe: string) => {
    const warn =
      snap.bars > 0 && snap.bars < RATING_FULL_BARS
        ? `<div class="tr-warn">只有 ${snap.bars} 根 K 棒（少於 ${RATING_FULL_BARS}），長週期均線未納入</div>`
        : "";
    render(
      gaugeSvg(snap.all) +
        `<div class="tr-main" style="color:${colorOf(snap.all)}">${labelOf(snap.all)} <span class="tr-meta">${fmt(snap.all)}</span></div>` +
        `<div class="tr-row"><span>均線</span><span style="color:${colorOf(snap.ma)}">${labelOf(snap.ma)} ${fmt(snap.ma)}</span></div>` +
        `<div class="tr-row"><span>震盪指標</span><span style="color:${colorOf(snap.osc)}">${labelOf(snap.osc)} ${fmt(snap.osc)}</span></div>` +
        `<div class="tr-meta">${symbol} · ${timeframe} · ${snap.bars} 根 K 棒</div>` +
        warn,
    );
  };

  const refresh = () => {
    if (disposed) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    const mine = ++seq;
    const symbol = ctx.symbol;
    const timeframe = ctx.timeframe;
    lastKey = `${symbol}|${timeframe}`;
    if (!root.firstChild) render(`<div class="tr-meta">計算中…</div>`);
    deps
      .compute(symbol, timeframe)
      .then(
        (snap) => {
          if (!disposed && mine === seq) show(snap, symbol, timeframe);
        },
        (err: unknown) => {
          if (!disposed && mine === seq) {
            const msg = err instanceof Error ? err.message : String(err);
            render(`<div class="tr-warn">無法取得評分：${msg.replace(/[<>&]/g, "")}</div>`);
          }
        },
      )
      .finally(() => {
        busy = false;
        if (again) {
          again = false;
          refresh();
        }
      });
  };

  // Symbol/timeframe switches are applied in place, so poll the live getters, // a string compare per second is far cheaper than recomputing on every
  // Vela state event (drawings/style changes fire those too).
  const poll = setInterval(() => {
    if (`${ctx.symbol}|${ctx.timeframe}` !== lastKey) refresh();
  }, deps.pollMs ?? 1000);
  const tick = setInterval(refresh, deps.refreshMs ?? 60_000);

  refresh();

  return {
    refresh,
    destroy() {
      disposed = true;
      clearInterval(poll);
      clearInterval(tick);
      root.remove();
    },
  };
}
```

- [ ] **Step 4: 確認測試通過**

Run: `cd /c/Users/bear9/OpenCharts && npx vitest run src/pages/__tests__/techRatingPanel.test.ts`
Expected: `Tests  8 passed (8)`

- [ ] **Step 5: 型別檢查**

Run: `cd /c/Users/bear9/OpenCharts && npx tsc --noEmit`
Expected: 無輸出

- [ ] **Step 6: 不 commit（D2）**, 在 task 報告中列出：`src/pages/techRatingPanel.ts`、`src/pages/__tests__/techRatingPanel.test.ts`。

---

### Task 3: 掛到 VELA（側欄 + 頂列按鈕）並全套驗證

**Blocked by:** Task 1（`computeRating`、`FetchBarsFn`）、Task 2（`mountTechRatingPanel`）

**Files:**
- Create: `src/pages/velaTechRating.ts`
- Modify: `src/pages/VelaPage.tsx`（只加一行 import）

**Interfaces:**
- Consumes: Task 1 `computeRating(symbol, timeframe, { fetchBars })`、`FetchBarsFn`；Task 2 `mountTechRatingPanel(ctx, body, { compute })`
- Produces: Vela side panel id `"opencharts.tech-rating"`；topbar action id `"opencharts.tech-rating.toggle"`（label「評分」）

**Assumptions:**
- Assumption: 頂列按鈕 `order: 2`，排在 Nautilus 回測（`order: 1`）之後。

**Done when:**
- `src/pages/VelaPage.tsx` 的 diff 只比執行前多一行 `import "./velaTechRating.ts"; ...`，其他行（含使用者原有的 `velaNautilusBacktest` import）不變
- `npx tsc --noEmit` → 無輸出
- `npx vitest run` → 0 failed；Test Files 87、passed ≥ 1204（執行前基準：85 files、1177 passed、1 skipped；本計畫新增 2 files / 27 tests）；若有失敗，逐一確認是否本計畫造成，非本計畫造成的列入報告（失敗案例）
- `git status --short` 的新增項目只有本計畫列出的 6 個新檔 + `VelaPage.tsx` 修改

- [ ] **Step 1: 建立註冊檔**, 建立 `src/pages/velaTechRating.ts`，內容完全如下：

```ts
/**
 * Registers the 技術評分 side panel and its topbar toggle with Vela (side
 * effect, imported once by VelaPage). The rating runs on shioaji bars through
 * our own Pine interpreter; see techRating.ts / techRatingPanel.ts.
 *
 * Import from "@luxalgo/vela/plugin", NOT the root barrel: the root and /ui
 * subpath are separate module instances, and registering on the wrong one
 * leaves the panel invisible (see velaPineEditor.ts header).
 */
import { registerIcon, registerSidePanel, registerWidgetAction } from "@luxalgo/vela/plugin";
import { svg16 } from "@luxalgo/vela/ui";
import { ShioajiVelaProvider } from "../services/shioaji/velaProvider.ts";
import { computeRating, type FetchBarsFn } from "./techRating.ts";
import { mountTechRatingPanel } from "./techRatingPanel.ts";

const PANEL_ID = "opencharts.tech-rating";

const provider = new ShioajiVelaProvider();
const fetchBars: FetchBarsFn = (symbol, timeframe, fromMs, limit) =>
  provider.getBars(symbol, timeframe, { from: fromMs, limit });

registerIcon("tech-rating", svg16('<path d="M2.5 11.5a5.5 5.5 0 0 1 11 0"/><path d="M8 11.5l3-4"/>'));

registerSidePanel({
  id: PANEL_ID,
  title: "技術評分",
  icon: "tech-rating",
  width: 300,
  resizable: true,
  minWidth: 240,
  mount(ctx, body) {
    const panel = mountTechRatingPanel(ctx, body, {
      compute: (symbol, timeframe) => computeRating(symbol, timeframe, { fetchBars }),
    });
    return {
      onOpen() {
        panel.refresh();
      },
      destroy() {
        panel.destroy();
      },
    };
  },
});

registerWidgetAction({
  id: "opencharts.tech-rating.toggle",
  target: "topbar",
  align: "right",
  icon: "tech-rating",
  label: "評分",
  order: 2,
  run: (ctx) => ctx.togglePanel(PANEL_ID),
});
```

- [ ] **Step 2: 在 VelaPage 加 import**, 檔案 `src/pages/VelaPage.tsx`

搜尋錨點：`import "./velaNautilusBacktest.ts";`

原始程式碼（完全一致，含註解）：

```ts
import "./velaNautilusBacktest.ts"; // 註冊頂列 "Nautilus 回測" 按鈕（side effect）
```

替換為：

```ts
import "./velaNautilusBacktest.ts"; // 註冊頂列 "Nautilus 回測" 按鈕（side effect）
import "./velaTechRating.ts"; // 註冊「技術評分」側邊面板與頂列 "評分" 按鈕（side effect）
```

（只加一行；不要動 `velaNautilusBacktest` 這行，它是使用者尚未 commit 的工作。）

- [ ] **Step 3: 型別檢查**

Run: `cd /c/Users/bear9/OpenCharts && npx tsc --noEmit`
Expected: 無輸出

- [ ] **Step 4: 全套測試**（timeout 600000ms）

Run: `cd /c/Users/bear9/OpenCharts && npx vitest run 2>&1 | tail -6`
Expected: `Test Files  87 passed (87)`，`Tests` 行沒有 `failed`，passed ≥ 1204

- [ ] **Step 5: 確認改動範圍**

Run: `cd /c/Users/bear9/OpenCharts && git status --short src/ && git diff src/pages/VelaPage.tsx`
Expected: 新增 `?? src/pine/tech-rating.pine`、`?? src/pages/techRating.ts`、`?? src/pages/techRatingPanel.ts`、`?? src/pages/velaTechRating.ts`、`?? src/pages/__tests__/`；`VelaPage.tsx` diff 只多出 `velaTechRating` 那一行（加上使用者原本就有的 `velaNautilusBacktest` 那行）。其他早已存在的 `M`/`??` 項目（`TradingViewWidgets.tsx`、`candles.ts`、`feed.ts`、`velaNautilusBacktest.ts`、`nautilusClient.ts`、`src/components/__tests__/`、`src/pine/graphify-out/`）不是本計畫造成，不要碰。

- [ ] **Step 6: 不 commit（D2）**, 最終報告列出全部 6 個新檔 + `VelaPage.tsx`，並附 Step 3–5 的原始輸出。

---

## 人工驗收（使用者，需本機 shioaji server 在 :3000）

1. `npm run dev` → 開 `http://localhost:5173/vela`
2. 頂列右側出現「評分」按鈕 → 點擊，右側出現「技術評分」面板，顯示儀表與「均線 / 震盪指標」兩列
3. 在圖格輸入 `TMFJ6`（或當月微台）Enter → 1 秒內面板底部商品改為微台，數值更新
4. 切換週期 5m → 1D → 面板跟著更新；拖曳/畫線時畫面不卡頓
5. 指標選單裡出現 `tech-rating`（Category: OpenCharts），加到圖上可看到 All/MA/Osc 三條線（可選）
6. 關掉 shioaji server 再切商品 → 面板顯示「無法取得評分：…」而非白屏
