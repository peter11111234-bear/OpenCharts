# VELA 報價小工具（實驗 2：報價列、電子熱力圖、排行榜）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/vela` 頁加三個 TradingView 風格的報價小工具，資料全部來自本機永豐 Shioaji 伺服器：(1) 圖下方常駐的報價列（目前商品資訊列 + 加權/大台/小台/微台/台積電 報價卡）、(2) 電子類股熱力圖側邊面板、(3) 排行榜側邊面板（漲幅／跌幅／成交量／成交金額）。

**Architecture:** 資料層 `src/services/shioaji/marketData.ts` 直接打 Vite 代理 `/shioaji/api/v1`（snapshots、index_components、scanner、contracts info），所有函式都吃可注入的 `HttpFn` 以便測試。共用樣式／格式化／「最新為準」執行器放 `src/pages/marketKit.ts`。三個無框架 DOM 模組（`quoteStrip.ts`、`heatmap.ts`、`hotlists.ts`）各自負責畫面與輪詢，`velaMarketWidgets.ts` 用 Vela plugin API 註冊：報價列用 `registerWidgetAttachment` + `ctx.dockStrip` 自動掛上，兩個面板用 `registerSidePanel` + 頂列按鈕。

**Tech Stack:** React 19 + Vite + TypeScript、`@luxalgo/vela` plugin API、Shioaji 本機 HTTP 伺服器（127.0.0.1:8080，經 Vite `/shioaji` 代理）、vitest（jsdom）

**Spec:** 本檔〈Spec〉一節（來源：2026-10-20 與使用者的對話）

**Spec invariant:** The widgets only READ market data and `ctx.symbol`; the single chart write allowed is `ctx.setSymbol(...)` inside a user's explicit click on a heatmap tile or hotlist row, no indicator, no drawing, no workspace (`vela-workspace-v2`) write, no `"state:changed"` subscription.

> **日期：** 2026-10-20

## Spec

1. 主圖維持 OPENCHART + VELA（`/vela`，`src/pages/VelaPage.tsx`），不得改主圖行為。
2. 資料來源 = 永豐 Shioaji 本機伺服器，不用 TradingView iframe 或 TradingView 資料。
3. 報價列：常駐在圖表下方；左邊是目前選取圖格商品的資訊列（價、漲跌、漲跌幅、今日低–高區間條、量），右邊固定 5 張卡：加權（IX0001）、大台（TXFR1）、小台（MXFR1）、微台（TMFR1）、台積電（2330）。期貨用 Shioaji 連續近月代碼（R1），自動換月。
4. 熱力圖：只掃**電子類股**（TWSE 產業別 24–31），取加權指數權重前 60 檔，依產業分組、面積 ∝ 權重、顏色依漲跌幅。
5. 排行榜：漲幅、跌幅、成交量、成交金額四個分頁，取最近一個有資料的交易日（週末／假日自動往前找）。
6. 台股色彩慣例：**紅漲綠跌**。
7. 點熱力圖方塊或排行榜列 → 主圖切到該股（使用者明確點擊才切）。
8. 目前只有盤後資料（白天收盤），畫面要能正常顯示收盤資料，不假設有即時 tick。
9. 範圍外：基本面、經濟日曆（使用者決定不做）。

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same
verify failing after 2+ distinct fix attempts. Single red test = normal TDD
loop, not a blocker.

Never stop to ask what you can look up, file locations, signatures, test
names: search first. Questions that don't change your next action: note them,
keep going, report at task end.

**Locating existing code, use CodeGraph first.** The repo is indexed by CodeGraph at `C:\Users\bear9\MYOPENCHART` (OpenCharts is reached through the `MYOPENCHART\OpenCharts` junction, so indexed paths look like `OpenCharts/src/...`). ALWAYS pass `-p C:/Users/bear9/MYOPENCHART`; without it the CLI picks up an unrelated index in `C:\Users\bear9`.
- Find a symbol: `codegraph query <name> -p C:/Users/bear9/MYOPENCHART`
- Source + call paths in one shot: `codegraph explore "<symbols or question>" -p C:/Users/bear9/MYOPENCHART`
- Who calls / what breaks: `codegraph callers <symbol> -p C:/Users/bear9/MYOPENCHART`, `codegraph impact <symbol> -p C:/Users/bear9/MYOPENCHART`
- The index is a locator, not the truth: files this plan creates are NOT in it until synced. The file on disk and this plan win over the index. Fall back to grep / reading files when CodeGraph has no answer.

**Plan-specific Nevers:**
- NEVER run `git commit`, `git add`, `git stash`, `git checkout`, `git reset` or `git restore`, settled in D1. The working tree holds the user's and another agent's uncommitted work.
- NEVER import `registerSidePanel` / `registerWidgetAction` / `registerWidgetAttachment` / `registerIcon` from the root `"@luxalgo/vela"`; use `"@luxalgo/vela/plugin"` (root and plugin are separate module instances, widgets would silently not appear). `svg16` comes from `"@luxalgo/vela/ui"`.
- NEVER call `ctx.setSymbol` anywhere except the `onPick` callbacks in `velaMarketWidgets.ts`, settled in D2.
- NEVER subscribe to the workspace `"state:changed"` event; the strip polls `ctx.symbol` (this page has a history of event-storm freezes).
- NEVER swap the colours: up = `#f23645` (red), down = `#089981` (green), settled in D3.
- NEVER flip the scanner `ascending` flags in `RANK_QUERY`. They look backwards but are verified against the live server: `ascending: true` returns the LARGEST values first (Fact Annex).
- NEVER change `fetchIndexEntries` to send any contract other than `IND / TSE / IX0001`: the server rejects other codes for this endpoint (Fact Annex).
- NEVER modify files not listed in a task's `Files:` (especially `src/components/TradingViewWidgets.tsx`, `src/services/shioaji/server.ts`, `src/services/shioaji/velaProvider.ts`, `src/pages/velaTechRating.ts`, `vite.config.ts`, `src/services/guard/*`).

## Global Constraints

- Working directory: `C:\Users\bear9\OpenCharts`（shell = Git Bash；路徑用 `/c/Users/bear9/OpenCharts`）。
- Test runner: `npx vitest run <file>`（全套 `npx vitest run`，約 4–5 分鐘，timeout 設 600000ms）。
- Typecheck: `npx tsc --noEmit` → 無輸出 = 通過。
- **不要跑 `npx eslint`**：專案的 ESLint 設定檔本來就壞，和本計畫無關。
- 程式碼註解、識別字用英文；使用者看得到的字串用繁體中文。
- 不新增 npm 依賴。
- Import 路徑沿用專案慣例：相對路徑並帶 `.ts` 副檔名。
- 測試一律用假的 `HttpFn` / 假的 deps，**單元測試不得連真伺服器**。
- 另有一個 agent 可能同時在改 `vite.config.ts`、`src/services/guard/` 底下的檔案。全套測試若在那些檔案失敗，記錄到報告，不要去修。

## Decision Points

### D1: 執行者要不要 commit   (T1)
- Consumed by: Task 1, Task 2, Task 3, Task 4, Task 5
- Candidates:
  - A (existing pattern): 每個 task 結束 `git commit`（real-plan 預設）
  - B (minimal): 不 commit，改動留在 working tree，最後列出檔案清單給使用者審
  - C (preferred): 只 `git add` 本計畫的檔案再 commit
- Criteria:
  - No commit contains a line the user wrote but has not committed
  - `src/pages/VelaPage.tsx` change can be included without its pre-existing uncommitted lines (`velaNautilusBacktest.ts`, `velaTechRating.ts` imports)
  - Executor never needs an interactive git command
- Chosen: B
- Rejected: A fails "No commit contains a line the user wrote but has not committed"; C fails "VelaPage.tsx change can be included without its pre-existing uncommitted lines" (needs `git add -p`, interactive)
- Revisit trigger: user commits or discards their pending `VelaPage.tsx` work before execution
- Outcome: held — 全程未執行任何 git 指令；`VelaPage.tsx` 只加一行 import（第 13 行），使用者的 `velaNautilusBacktest.ts` / `velaTechRating.ts` import 原樣保留。

### D2: 點擊後要不要切換主圖商品   (T1)
- Consumed by: Task 3, Task 4, Task 5
- Candidates:
  - A (existing pattern): 完全唯讀，同技術評分面板（`src/pages/techRatingPanel.ts` 只讀 `ctx.symbol`）
  - B (minimal): 點擊只複製代碼／跳 toast，不切圖
  - C (preferred): 面板模組只回報 `onPick`，由 `velaMarketWidgets.ts` 呼叫 `ctx.setSymbol(...)` 切到該股
- Criteria:
  - A click on a tile or row shows that stock on the main chart (Spec 7)
  - Panel modules (`heatmap.ts`, `hotlists.ts`) never import Vela
  - Chart is written only in response to an explicit click
- Chosen: C
- Rejected: A fails "A click on a tile or row shows that stock on the main chart"; B fails the same criterion
- Revisit trigger: `ctx.setSymbol("OTC:xxxx")` does not switch the chart for an OTC stock (provider rejects the prefix)
- Outcome: held — `heatmap.ts` / `hotlists.ts` / `quoteStrip.ts` 都只回報 `onPick`，`grep -rn "setSymbol"` 於三者無命中；`setSymbol` 僅出現在 `velaMarketWidgets.ts` 的兩個 `onPick` 內。

### D3: 漲跌顏色   (T1)
- Consumed by: Task 1, Task 2, Task 3, Task 4
- Candidates:
  - A (existing pattern): TradingView 預設綠漲紅跌（`react-ts-tradingview-widgets` 的 iframe 外觀）
  - B (minimal): 不上色，只顯示正負號
  - C (preferred): 台股慣例紅漲綠跌，色碼集中在 `marketKit.ts` 的 `UP` / `DOWN`
- Criteria:
  - Up moves render red, down moves render green (Spec 6)
  - Colour values are defined in exactly one module
- Chosen: C
- Rejected: A fails "Up moves render red"; B fails "Up moves render red"
- Revisit trigger: user asks for TradingView colours
- Outcome: held — `UP = "#f23645"`、`DOWN = "#089981"` 只定義在 `src/pages/marketKit.ts`；報價列與排行榜測試分別斷言 `#f23645` / `#089981` 出現，`heatColor` 由同一組 RGB 常數內插。

### D4: 股票名稱顯示   (T1)
- Consumed by: Task 1, Task 4
- Candidates:
  - A (existing pattern): 直接顯示伺服器的 `name`
  - B (minimal): 只顯示代碼
  - C (preferred): 顯示代碼；名稱經 `cleanName` 過濾，含 U+FFFD（亂碼）就不顯示
- Criteria:
  - Never shows mojibake (U+FFFD) to the user
  - Shows a readable name when the server returns one
- Chosen: C
- Rejected: A fails "Never shows mojibake" (2026-10-20 實測 `6547`、`00878` 曾回亂碼); B fails "Shows a readable name when the server returns one"
- Revisit trigger: server names are always clean for a full week
- Outcome: held — `cleanName` 在 `marketData.ts` 統一過濾 U+FFFD，`fetchRanking` 與 `fetchContractInfo` 都經過它；測試「cleanName drops mojibake」「caches per code」皆通過（後者斷言亂碼 name 被清成 `""`）。

## Fact Annex（計畫撰寫時已實際驗證，2026-10-20）

伺服器：`shioaji server start` → `127.0.0.1:8080`；前端經 Vite 代理 `/shioaji` 存取（`defaultHttp` 打 `/shioaji/api/v1${path}`）。

- `POST /api/v1/data/snapshots {contracts: ContractRef[]}` → 陣列，欄位 `code, exchange, open, high, low, close, change_price, change_rate, total_volume, total_amount, datetime`。連續期貨 `TXFR1/MXFR1/TMFR1` 與指數 `IX0001`（`security_type: "IND"`, `exchange: "TSE"`）都可用。
- `POST /api/v1/data/index_components {contract: {security_type:"IND", exchange:"TSE", code:"IX0001"}}` → `{entries: [...]}`，1087 筆，約 448 KB / 0.25 s；每筆 `contract{exchange,code}`、`category`（TWSE 產業別代碼）、`price`（字串）、`pct_chg`（字串）、`reference_weight_ppm`、`total_amount`。電子類 24–31 共 458 檔。其他 code 會被拒絕。
- `POST /api/v1/data/scanner {scanner_type, count, ascending, date}`：`date` **必填**（`YYYY-MM-DD`）；`ascending: true` 回傳**最大值在前**；非交易日回 `[]`。項目有 `date, code, name, close, change_price, total_volume, total_amount`，**沒有 exchange**、`code` 可能帶尾端空白。
- `GET /api/v1/data/contracts/{code}/info` → `{code, exchange, name, category}`；未知代碼 404。`name` 有時是亂碼（U+FFFD）。
- `ContractRef` 型別：`src/services/shioaji/server.ts`（`{ security_type, exchange, code }`）。
- Vela `WidgetContext`（`node_modules/@luxalgo/vela/dist/contributions-BY3zSYiZ.d.ts:1913`）：`symbol` / `timeframe` 是**即時 getter，永遠解析到目前選取的圖格**；`setSymbol(symbol)`；`togglePanel(id, open?)`；`dockStrip(el) => undock`（全寬條，位於圖表區與底列之間）；`host`（widget 根元素）。`registerWidgetAttachment({ id, mount(ctx) => dispose })`（同檔 :2125）。
- 先例：`src/pages/velaTechRating.ts`（`registerSidePanel` + `registerWidgetAction` + `registerIcon`，`order: 2`）；`src/pages/techRatingPanel.ts`（輪詢 `ctx.symbol`）。
- 全部程式碼已於 2026-10-20 在本 repo 試跑：4 個測試檔共 27/27 通過、`npx tsc --noEmit` 通過；試跑檔案已刪除，working tree 回到原狀。
- 對真伺服器煙霧測試（2026-10-20 盤後）：報價 6 檔全有值（例 `TMFR1 46955 +1.32%`、`2330 2405 -0.61%`、`OTC 6547 51`）；熱力圖 1087 筆 → 60 塊、7 個產業組；四個排行榜都回 `2026-10-20` 的 5 筆；`6547` 查得 `exchange: OTC`。

## Review Ledger

（執行時追加）

- 2026-10-20 執行：Task 1–5 全部 DONE。4 個測試檔 27/27 通過，`npx tsc --noEmit` 無輸出，全套 92 檔 / 1234 passed / 1 skipped / 0 failed。未執行任何 git 指令、未跑 eslint、未改動 `Files:` 以外的檔案（僅本計畫 doc 的 Decision Outcome 與本 Ledger）。詳見 `2026-10-20-vela-quote-widgets.report.md`。

---

### Task 1: 資料層 + 共用工具

**Blocked by:** None, can start immediately

**Files:**
- Create: `src/services/shioaji/marketData.ts`
- Create: `src/pages/marketKit.ts`
- Test: `src/services/__tests__/marketData.test.ts`（若 `src/services/__tests__/` 不存在就建立）

**Interfaces:**
- Consumes: `ContractRef` from `src/services/shioaji/server.ts`
- Produces:
  - `marketData.ts`: `type HttpFn`, `defaultHttp`, `interface QuoteSnap`, `fetchQuotes(refs, http?)`, `ELECTRONICS_CATEGORIES`, `interface IndexEntry`, `fetchIndexEntries(http?)`, `type RankKind = "gainers" | "losers" | "volume" | "amount"`, `interface RankRow`, `taipeiDate(d)`, `cleanName(name)`, `fetchRanking(kind, count, now, http?, maxDaysBack?)`, `interface ContractInfo`, `fetchContractInfo(code, http?)`, `clearContractInfoCache()`, `toContractRef(symbol): ContractRef | null`
  - `marketKit.ts`: `UP`, `DOWN`, `FLAT`, `CATEGORY_NAMES`, `changeColor(pct)`, `heatColor(pct, maxAbs?)`, `fmtPct`, `fmtNum`, `fmtBig`, `escapeHtml`, `ensureMarketStyles(doc)`, `latestRunner(task, onResult, onError) => { run(), dispose() }`

**Assumptions:** None

**Done when:**
- `npx vitest run src/services/__tests__/marketData.test.ts` → `11 passed`
- `fetchRanking` on a Sunday walks back to Friday (test "walks back past empty (non-trading) days") → PASS
- server 404 on contract info → `fetchContractInfo` resolves `null` (test "returns null when the server 404s") → PASS
- `npx tsc --noEmit` → no output

- [ ] **Step 1: Write the failing test**, create `src/services/__tests__/marketData.test.ts` with exactly:

````ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearContractInfoCache,
  cleanName,
  fetchContractInfo,
  fetchIndexEntries,
  fetchQuotes,
  fetchRanking,
  taipeiDate,
  toContractRef,
  type HttpFn,
} from "../shioaji/marketData.ts";

describe("fetchQuotes", () => {
  it("posts the refs and maps snake_case fields", async () => {
    const http = vi.fn<HttpFn>(async () => [
      { code: "TMFR1", exchange: "TAIFEX", open: 1, high: 3, low: 0.5, close: 2, change_price: -1, change_rate: -33.3, total_volume: 10, total_amount: 20, datetime: "2026-10-20T13:45:00" },
    ]);
    const refs = [{ security_type: "FUT" as const, exchange: "TAIFEX" as const, code: "TMFR1" }];
    const out = await fetchQuotes(refs, http);
    expect(http).toHaveBeenCalledWith("/data/snapshots", { method: "POST", body: { contracts: refs } });
    expect(out[0]).toMatchObject({ code: "TMFR1", close: 2, changePrice: -1, changeRate: -33.3, totalVolume: 10 });
  });

  it("skips the request for an empty list", async () => {
    const http = vi.fn<HttpFn>();
    expect(await fetchQuotes([], http)).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });
});

describe("fetchIndexEntries", () => {
  it("parses string prices and drops entries without a % change", async () => {
    const http = vi.fn<HttpFn>(async () => ({
      entries: [
        { contract: { exchange: "TSE", code: "2330" }, category: "24", price: "1005", pct_chg: "1.52", reference_weight_ppm: 300000, total_amount: 9 },
        { contract: { exchange: "TSE", code: "9999" }, category: "24", price: null, pct_chg: null, reference_weight_ppm: 5 },
      ],
    }));
    const out = await fetchIndexEntries(http);
    expect(out).toEqual([{ code: "2330", exchange: "TSE", category: "24", price: 1005, pct: 1.52, weightPpm: 300000, amount: 9 }]);
    expect(http.mock.calls[0]![1]).toEqual({
      method: "POST",
      body: { contract: { security_type: "IND", exchange: "TSE", code: "IX0001" } },
    });
  });
});

describe("fetchRanking", () => {
  const row = { date: "2026-10-16", code: "2330 ", name: "台積電", close: 110, change_price: 10, total_volume: 5, total_amount: 7 };

  it("walks back past empty (non-trading) days and computes % change", async () => {
    const http = vi.fn<HttpFn>(async (_p, init) => {
      const body = init!.body as { date: string };
      return body.date === "2026-10-16" ? [row] : [];
    });
    // 2026-10-18 (Sun) 12:00 Taipei → 18 empty, 17 empty, 16 has data.
    const out = await fetchRanking("gainers", 20, new Date("2026-10-18T04:00:00Z"), http);
    expect(http).toHaveBeenCalledTimes(3);
    expect(http.mock.calls[0]![1]!.body).toEqual({ scanner_type: "ChangePercentRank", ascending: true, count: 20, date: "2026-10-18" });
    expect(out[0]).toMatchObject({ code: "2330", name: "台積電", changeRate: 10, date: "2026-10-16" });
  });

  it("losers ask the scanner for ascending:false", async () => {
    const http = vi.fn<HttpFn>(async () => [row]);
    await fetchRanking("losers", 5, new Date("2026-10-16T04:00:00Z"), http);
    expect(http.mock.calls[0]![1]!.body).toMatchObject({ scanner_type: "ChangePercentRank", ascending: false });
  });

  it("gives up after maxDaysBack and returns []", async () => {
    const http = vi.fn<HttpFn>(async () => []);
    expect(await fetchRanking("volume", 5, new Date("2026-10-16T04:00:00Z"), http, 2)).toEqual([]);
    expect(http).toHaveBeenCalledTimes(3);
  });
});

describe("helpers", () => {
  it("taipeiDate uses UTC+8", () => {
    expect(taipeiDate(new Date("2026-10-19T17:00:00Z"))).toBe("2026-10-20");
    expect(taipeiDate(new Date("2026-10-19T15:59:00Z"))).toBe("2026-10-19");
  });

  it("cleanName drops mojibake", () => {
    expect(cleanName("台積電")).toBe("台積電");
    expect(cleanName("��A")).toBe("");
    expect(cleanName(undefined)).toBe("");
  });

  it("toContractRef maps Vela symbols to shioaji contracts", () => {
    expect(toContractRef("TSE:2330")).toEqual({ security_type: "STK", exchange: "TSE", code: "2330" });
    expect(toContractRef("OTC:6547")).toEqual({ security_type: "STK", exchange: "OTC", code: "6547" });
    expect(toContractRef("2330")).toEqual({ security_type: "STK", exchange: "TSE", code: "2330" });
    expect(toContractRef("TAIFEX:TMFK6")).toEqual({ security_type: "FUT", exchange: "TAIFEX", code: "TMFK6" });
    expect(toContractRef("MXFR1")).toEqual({ security_type: "FUT", exchange: "TAIFEX", code: "MXFR1" });
    expect(toContractRef("IX0001")).toEqual({ security_type: "IND", exchange: "TSE", code: "IX0001" });
    expect(toContractRef("BINANCE:BTCUSDT")).toBeNull();
    expect(toContractRef("")).toBeNull();
  });
});

describe("fetchContractInfo", () => {
  beforeEach(() => clearContractInfoCache());

  it("caches per code", async () => {
    const http = vi.fn<HttpFn>(async () => ({ code: "6547", exchange: "OTC", name: "�", category: 22 }));
    const a = await fetchContractInfo("6547", http);
    const b = await fetchContractInfo("6547", http);
    expect(a).toEqual({ code: "6547", exchange: "OTC", name: "", category: "22" });
    expect(b).toBe(a);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("returns null when the server 404s", async () => {
    const http = vi.fn<HttpFn>(async () => {
      throw new Error("404");
    });
    expect(await fetchContractInfo("0000", http)).toBeNull();
  });
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/services/__tests__/marketData.test.ts`
Expected: FAIL, `Failed to resolve import "../shioaji/marketData.ts"`

- [ ] **Step 3: Create `src/services/shioaji/marketData.ts`** with exactly:

````ts
/**
 * Market-wide data for the Vela quote widgets (quote strip, electronics
 * heatmap, hotlists), straight from the local shioaji server through the Vite
 * `/shioaji` proxy like server.ts. Server behaviour verified 2026-10-20:
 * - snapshots accept continuous futures (TXFR1/MXFR1/TMFR1) and the index IX0001.
 * - index_components only accepts IND/TSE/IX0001 (or IX0043/OTC).
 * - scanner requires `date`; `ascending: true` returns the LARGEST values first;
 *   a non-trading date returns [].
 * - names from scanner / contract info are often mojibake (U+FFFD) — see cleanName.
 */
import type { ContractRef } from "./server.ts";

const BASE = "/shioaji/api/v1";

export type HttpFn = (path: string, init?: { method?: "GET" | "POST"; body?: unknown }) => Promise<unknown>;

export const defaultHttp: HttpFn = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`shioaji ${path} failed: ${res.status}`);
  return res.json();
};

// ── Snapshots ──

export interface QuoteSnap {
  code: string;
  exchange: string;
  open: number;
  high: number;
  low: number;
  close: number;
  changePrice: number;
  changeRate: number;
  totalVolume: number;
  totalAmount: number;
  datetime: string;
}

interface RawSnap {
  code: string;
  exchange: string;
  open: number;
  high: number;
  low: number;
  close: number;
  change_price?: number;
  change_rate?: number;
  total_volume?: number;
  total_amount?: number;
  datetime?: string;
}

export async function fetchQuotes(refs: ContractRef[], http: HttpFn = defaultHttp): Promise<QuoteSnap[]> {
  if (refs.length === 0) return [];
  const raw = (await http("/data/snapshots", { method: "POST", body: { contracts: refs } })) as RawSnap[];
  return raw.map((s) => ({
    code: s.code,
    exchange: s.exchange,
    open: s.open,
    high: s.high,
    low: s.low,
    close: s.close,
    changePrice: s.change_price ?? 0,
    changeRate: s.change_rate ?? 0,
    totalVolume: s.total_volume ?? 0,
    totalAmount: s.total_amount ?? 0,
    datetime: s.datetime ?? "",
  }));
}

// ── Index components (heatmap) ──

/** TWSE industry codes for the electronics sector. */
export const ELECTRONICS_CATEGORIES: readonly string[] = ["24", "25", "26", "27", "28", "29", "30", "31"];

export interface IndexEntry {
  code: string;
  exchange: string;
  category: string;
  price: number;
  pct: number;
  weightPpm: number;
  amount: number;
}

interface RawEntry {
  contract: { exchange: string; code: string };
  category: string;
  price?: string | null;
  pct_chg?: string | null;
  reference_weight_ppm?: number | null;
  total_amount?: number | null;
}

export async function fetchIndexEntries(http: HttpFn = defaultHttp): Promise<IndexEntry[]> {
  const raw = (await http("/data/index_components", {
    method: "POST",
    body: { contract: { security_type: "IND", exchange: "TSE", code: "IX0001" } },
  })) as { entries?: RawEntry[] };
  return (raw.entries ?? [])
    .map((e) => ({
      code: e.contract.code,
      exchange: e.contract.exchange,
      category: String(e.category),
      price: e.price == null ? Number.NaN : Number(e.price),
      pct: e.pct_chg == null ? Number.NaN : Number(e.pct_chg),
      weightPpm: e.reference_weight_ppm ?? 0,
      amount: e.total_amount ?? 0,
    }))
    .filter((e) => Number.isFinite(e.pct));
}

// ── Scanner (hotlists) ──

export type RankKind = "gainers" | "losers" | "volume" | "amount";

const RANK_QUERY: Record<RankKind, { scanner_type: string; ascending: boolean }> = {
  gainers: { scanner_type: "ChangePercentRank", ascending: true },
  losers: { scanner_type: "ChangePercentRank", ascending: false },
  volume: { scanner_type: "VolumeRank", ascending: true },
  amount: { scanner_type: "AmountRank", ascending: true },
};

export interface RankRow {
  code: string;
  name: string;
  close: number;
  changePrice: number;
  changeRate: number;
  totalVolume: number;
  totalAmount: number;
  date: string;
}

interface RawRank {
  date: string;
  code: string;
  name?: string;
  close: number;
  change_price: number;
  total_volume: number;
  total_amount: number;
}

/** YYYY-MM-DD of `d` in Asia/Taipei (UTC+8, no DST). */
export function taipeiDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** The server often returns names with U+FFFD (lost encoding) — show none rather than garbage. */
export function cleanName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return n.includes("�") ? "" : n;
}

/** Latest trading day's ranking: walks back from `now` past weekends/holidays (empty days). */
export async function fetchRanking(
  kind: RankKind,
  count: number,
  now: Date,
  http: HttpFn = defaultHttp,
  maxDaysBack = 7,
): Promise<RankRow[]> {
  const q = RANK_QUERY[kind];
  for (let back = 0; back <= maxDaysBack; back++) {
    const date = taipeiDate(new Date(now.getTime() - back * 86_400_000));
    const raw = (await http("/data/scanner", { method: "POST", body: { ...q, count, date } })) as RawRank[];
    if (raw.length === 0) continue;
    return raw.map((r) => {
      const prev = r.close - r.change_price;
      return {
        code: r.code.trim(),
        name: cleanName(r.name),
        close: r.close,
        changePrice: r.change_price,
        changeRate: prev > 0 ? (r.change_price / prev) * 100 : 0,
        totalVolume: r.total_volume,
        totalAmount: r.total_amount,
        date: r.date,
      };
    });
  }
  return [];
}

// ── Contract info (exchange lookup for click-to-switch) ──

export interface ContractInfo {
  code: string;
  exchange: string;
  name: string;
  category: string;
}

const infoCache = new Map<string, Promise<ContractInfo | null>>();

export function fetchContractInfo(code: string, http: HttpFn = defaultHttp): Promise<ContractInfo | null> {
  let hit = infoCache.get(code);
  if (!hit) {
    hit = (http(`/data/contracts/${encodeURIComponent(code)}/info`) as Promise<ContractInfo>).then(
      (i) => ({ code: i.code, exchange: i.exchange, name: cleanName(i.name), category: String(i.category) }),
      () => null,
    );
    infoCache.set(code, hit);
  }
  return hit;
}

export function clearContractInfoCache(): void {
  infoCache.clear();
}

// ── Vela symbol → shioaji contract ──

/** `TSE:2330` / `OTC:6547` / `TAIFEX:TMFK6` / bare `2330` / `TXFR1` / `IX0001`.
 *  Bare numeric codes are assumed TSE (Vela's symbol picker always prefixes OTC). */
export function toContractRef(symbol: string): ContractRef | null {
  const colon = symbol.indexOf(":");
  const prefix = colon < 0 ? "" : symbol.slice(0, colon).trim().toUpperCase();
  const code = (colon < 0 ? symbol : symbol.slice(colon + 1)).trim().toUpperCase();
  if (!code) return null;
  if (/^IX\d{4}$/.test(code)) return { security_type: "IND", exchange: prefix === "OTC" ? "OTC" : "TSE", code };
  if (prefix === "TAIFEX" || (prefix === "" && /^[A-Z]{3}(R[12]|[A-L]\d)$/.test(code))) {
    return { security_type: "FUT", exchange: "TAIFEX", code };
  }
  if (prefix === "TSE" || prefix === "OTC") return { security_type: "STK", exchange: prefix, code };
  if (prefix === "" && /^\d{4,6}[A-Z]?$/.test(code)) return { security_type: "STK", exchange: "TSE", code };
  return null;
}
````

- [ ] **Step 4: Create `src/pages/marketKit.ts`** with exactly:

````ts
/**
 * Shared kit for the Vela quote widgets (strip, heatmap, hotlists). Taiwan colour convention:
 * red = up, green = down (the opposite of TradingView's default).
 */
export const UP = "#f23645";
export const DOWN = "#089981";
export const FLAT = "#787b86";

export const CATEGORY_NAMES: Record<string, string> = {
  "24": "半導體",
  "25": "電腦週邊",
  "26": "光電",
  "27": "通信網路",
  "28": "電子零組件",
  "29": "電子通路",
  "30": "資訊服務",
  "31": "其他電子",
};

export function changeColor(pct: number): string {
  if (!Number.isFinite(pct) || pct === 0) return FLAT;
  return pct > 0 ? UP : DOWN;
}

const BASE_RGB: [number, number, number] = [54, 58, 69];
const UP_RGB: [number, number, number] = [242, 54, 69];
const DOWN_RGB: [number, number, number] = [8, 153, 129];

/** Heatmap tile colour: neutral grey at 0%, full red/green at ±maxAbs%. */
export function heatColor(pct: number, maxAbs = 3): string {
  if (!Number.isFinite(pct)) return `rgb(${BASE_RGB.join(",")})`;
  const t = Math.min(1, Math.abs(pct) / maxAbs);
  const to = pct >= 0 ? UP_RGB : DOWN_RGB;
  const mix = BASE_RGB.map((b, i) => Math.round(b + (to[i]! - b) * t));
  return `rgb(${mix.join(",")})`;
}

export function fmtPct(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** 億 / 萬 for volumes and turnover. */
export function fmtBig(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}億`;
  if (Math.abs(v) >= 1e4) return `${Math.round(v / 1e4)}萬`;
  return String(Math.round(v));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE_ID = "data-market-widgets";
const CSS = `
.mw{color:var(--vela-fg,#d1d4dc);font:12px/1.4 -apple-system,Segoe UI,sans-serif}
.mw-meta{color:var(--vela-fg-muted,#868993);font-size:11px}
.mw-warn{color:#f9a825;font-size:11px}
.qs-strip{display:flex;align-items:center;gap:16px;padding:4px 10px;overflow-x:auto;white-space:nowrap;
  border-top:1px solid var(--vela-border,#2a2e39);background:var(--vela-bg,#131722)}
.qs-info{display:flex;align-items:center;gap:8px;padding-right:12px;border-right:1px solid var(--vela-border,#2a2e39)}
.qs-range{position:relative;width:80px;height:4px;border-radius:2px;background:var(--vela-border,#2a2e39)}
.qs-range-mark{position:absolute;top:-3px;width:2px;height:10px;background:currentColor}
.qs-card{display:flex;flex-direction:column;line-height:1.2}
.qs-card b{font-weight:600}
.hm-box{position:relative;width:100%}
.hm-tile{position:absolute;box-sizing:border-box;border:1px solid var(--vela-bg,#131722);overflow:hidden;
  cursor:pointer;color:#fff;font-size:10px;line-height:1.15;padding:2px}
.hm-group{position:absolute;box-sizing:border-box;border:1px solid #000;pointer-events:none}
.hm-group span{position:absolute;top:0;left:2px;font-size:9px;color:rgba(255,255,255,.75)}
.hl-tabs{display:flex;gap:4px;margin-bottom:6px}
.hl-tabs button{flex:1;border:0;border-radius:4px;padding:4px 0;background:var(--vela-border,#2a2e39);
  color:inherit;cursor:pointer}
.hl-tabs button[data-active]{background:#2962ff;color:#fff}
.hl-table{width:100%;border-collapse:collapse}
.hl-table td{padding:3px 2px;border-top:1px solid var(--vela-border,#2a2e39)}
.hl-table tr{cursor:pointer}
.hl-table td.num{text-align:right}
`;

/** Inject the widgets' stylesheet once per document. */
export function ensureMarketStyles(doc: Document): void {
  if (doc.querySelector(`style[${STYLE_ID}]`)) return;
  const s = doc.createElement("style");
  s.setAttribute(STYLE_ID, "");
  s.textContent = CSS;
  doc.head.appendChild(s);
}

/**
 * Serial "latest wins" runner: a run() while one is in flight queues exactly
 * one rerun, and the superseded run's result is dropped (so a slow reply for
 * the old symbol never paints over the new one).
 */
export function latestRunner<T>(
  task: () => Promise<T>,
  onResult: (r: T) => void,
  onError: (e: unknown) => void,
): { run(): void; dispose(): void } {
  let busy = false;
  let again = false;
  let disposed = false;
  const run = (): void => {
    if (disposed) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    task()
      .then(
        (r) => {
          if (!disposed && !again) onResult(r);
        },
        (e: unknown) => {
          if (!disposed && !again) onError(e);
        },
      )
      .finally(() => {
        busy = false;
        if (again) {
          again = false;
          run();
        }
      });
  };
  return {
    run,
    dispose() {
      disposed = true;
    },
  };
}
````

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run src/services/__tests__/marketData.test.ts`
Expected: `Tests  11 passed (11)`

Run: `npx tsc --noEmit`
Expected: no output

---

### Task 2: 報價列（資訊列 + 報價卡）

**Blocked by:** Task 1

**Files:**
- Create: `src/pages/quoteStrip.ts`
- Test: `src/pages/__tests__/quoteStrip.test.ts`

**Interfaces:**
- Consumes: Task 1 `toContractRef`, `QuoteSnap`, `changeColor`, `ensureMarketStyles`, `escapeHtml`, `fmtBig`, `fmtNum`, `fmtPct`, `latestRunner`
- Produces: `interface StripCard`, `DEFAULT_CARDS`, `interface QuoteStripDeps`, `interface WidgetHandle { refresh(): void; destroy(): void }`, `mountQuoteStrip(ctx: { readonly symbol: string }, el: HTMLElement, deps: QuoteStripDeps): WidgetHandle`

**Assumptions:** None

**Done when:**
- `npx vitest run src/pages/__tests__/quoteStrip.test.ts` → `6 passed`
- symbol not quotable by shioaji (`BINANCE:BTCUSDT`) → strip shows `無報價` (test) → PASS
- server failure → strip shows `報價暫停：` (test) → PASS
- `npx tsc --noEmit` → no output

- [ ] **Step 1: Write the failing test**, create `src/pages/__tests__/quoteStrip.test.ts` with exactly:

````ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractRef } from "../../services/shioaji/server.ts";
import type { QuoteSnap } from "../../services/shioaji/marketData.ts";
import { DEFAULT_CARDS, mountQuoteStrip, type WidgetHandle } from "../quoteStrip.ts";

const snap = (code: string, close: number, changeRate: number, extra: Partial<QuoteSnap> = {}): QuoteSnap => ({
  code,
  exchange: "TSE",
  open: close,
  high: close + 10,
  low: close - 10,
  close,
  changePrice: changeRate,
  changeRate,
  totalVolume: 12_345,
  totalAmount: 0,
  datetime: "",
  ...extra,
});

describe("mountQuoteStrip", () => {
  let el: HTMLElement;
  let handle: WidgetHandle | null = null;
  const ctx = { symbol: "TSE:2330" };

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    document.body.appendChild(el);
    ctx.symbol = "TSE:2330";
  });

  afterEach(() => {
    handle?.destroy();
    handle = null;
    el.remove();
    vi.useRealTimers();
  });

  it("shows the default cards in Taiwan colours and the active symbol's info bar", async () => {
    const quotes = vi.fn(async (refs: ContractRef[]) => refs.map((r, i) => snap(r.code, 100 + i, i % 2 ? -1 : 1)));
    handle = mountQuoteStrip(ctx, el, { quotes });
    await vi.waitFor(() => expect(el.querySelectorAll(".qs-card").length).toBe(DEFAULT_CARDS.length));
    expect(el.textContent).toContain("微台");
    expect(el.textContent).toContain("TSE:2330");
    expect(el.querySelector(".qs-range-mark")).not.toBeNull();
    expect(el.innerHTML).toContain("#f23645"); // up = red
    expect(el.innerHTML).toContain("#089981"); // down = green
    // 2330 is already a card → not requested twice
    expect(quotes.mock.calls[0]![0].filter((r) => r.code === "2330")).toHaveLength(1);
  });

  it("adds the active symbol to the request when it is not a card", async () => {
    ctx.symbol = "OTC:6547";
    const quotes = vi.fn(async (refs: ContractRef[]) => refs.map((r) => snap(r.code, 50, 0)));
    handle = mountQuoteStrip(ctx, el, { quotes });
    await vi.waitFor(() => expect(el.textContent).toContain("OTC:6547"));
    expect(quotes.mock.calls[0]![0].at(-1)).toEqual({ security_type: "STK", exchange: "OTC", code: "6547" });
  });

  it("refetches when the chart symbol changes", async () => {
    const quotes = vi.fn(async (refs: ContractRef[]) => refs.map((r) => snap(r.code, 50, 0)));
    handle = mountQuoteStrip(ctx, el, { quotes, pollMs: 1000, refreshMs: 60_000 });
    await vi.waitFor(() => expect(quotes).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(quotes).toHaveBeenCalledTimes(1); // same symbol → no refetch
    ctx.symbol = "TAIFEX:TMFK6";
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(el.textContent).toContain("TAIFEX:TMFK6"));
    expect(quotes).toHaveBeenCalledTimes(2);
  });

  it("says 無報價 for a symbol shioaji cannot quote", async () => {
    ctx.symbol = "BINANCE:BTCUSDT";
    const quotes = vi.fn(async (refs: ContractRef[]) => refs.map((r) => snap(r.code, 50, 0)));
    handle = mountQuoteStrip(ctx, el, { quotes });
    await vi.waitFor(() => expect(el.textContent).toContain("BINANCE:BTCUSDT · 無報價"));
  });

  it("shows a warning when the server fails", async () => {
    const quotes = vi.fn(async () => {
      throw new Error("down");
    });
    handle = mountQuoteStrip(ctx, el, { quotes });
    await vi.waitFor(() => expect(el.textContent).toContain("報價暫停：down"));
  });

  it("destroy stops polling and clears the strip", async () => {
    const quotes = vi.fn(async (refs: ContractRef[]) => refs.map((r) => snap(r.code, 50, 0)));
    handle = mountQuoteStrip(ctx, el, { quotes, refreshMs: 5000 });
    await vi.waitFor(() => expect(quotes).toHaveBeenCalledTimes(1));
    handle.destroy();
    handle = null;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(quotes).toHaveBeenCalledTimes(1);
    expect(el.innerHTML).toBe("");
  });
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/pages/__tests__/quoteStrip.test.ts`
Expected: FAIL, `Failed to resolve import "../quoteStrip.ts"`

- [ ] **Step 3: Create `src/pages/quoteStrip.ts`** with exactly:

````ts
/**
 * Quote strip docked under the Vela charts: the active symbol's info bar
 * (price, change, day-range bar, volume) plus fixed cards for 加權 / 大台 /
 * 小台 / 微台 / 台積電. Futures use shioaji's continuous codes (R1) so the
 * cards roll to the next contract by themselves. Read-only: never touches
 * the chart.
 */
import type { ContractRef } from "../services/shioaji/server.ts";
import { toContractRef, type QuoteSnap } from "../services/shioaji/marketData.ts";
import { changeColor, ensureMarketStyles, escapeHtml, fmtBig, fmtNum, fmtPct, latestRunner } from "./marketKit.ts";

export interface StripCard {
  label: string;
  ref: ContractRef;
}

export const DEFAULT_CARDS: readonly StripCard[] = [
  { label: "加權", ref: { security_type: "IND", exchange: "TSE", code: "IX0001" } },
  { label: "大台", ref: { security_type: "FUT", exchange: "TAIFEX", code: "TXFR1" } },
  { label: "小台", ref: { security_type: "FUT", exchange: "TAIFEX", code: "MXFR1" } },
  { label: "微台", ref: { security_type: "FUT", exchange: "TAIFEX", code: "TMFR1" } },
  { label: "台積電", ref: { security_type: "STK", exchange: "TSE", code: "2330" } },
];

export interface QuoteStripDeps {
  quotes: (refs: ContractRef[]) => Promise<QuoteSnap[]>;
  cards?: readonly StripCard[];
  /** How often to check whether the active symbol changed. */
  pollMs?: number;
  /** How often to refresh quotes for the same symbol. */
  refreshMs?: number;
}

export interface WidgetHandle {
  refresh(): void;
  destroy(): void;
}

function infoHtml(symbol: string, q: QuoteSnap | undefined): string {
  if (!q) return `<span class="mw-meta">${escapeHtml(symbol)} · 無報價</span>`;
  const span = q.high - q.low;
  const pos = span > 0 ? Math.min(100, Math.max(0, ((q.close - q.low) / span) * 100)) : 50;
  const color = changeColor(q.changeRate);
  return (
    `<b>${escapeHtml(symbol)}</b>` +
    `<b style="color:${color}">${fmtNum(q.close)}</b>` +
    `<span style="color:${color}">${q.changePrice > 0 ? "+" : ""}${fmtNum(q.changePrice)} (${fmtPct(q.changeRate)})</span>` +
    `<span class="mw-meta">低 ${fmtNum(q.low)}</span>` +
    `<span class="qs-range" title="今日區間"><span class="qs-range-mark" style="left:${pos.toFixed(1)}%;color:${color}"></span></span>` +
    `<span class="mw-meta">高 ${fmtNum(q.high)} · 量 ${fmtBig(q.totalVolume)}</span>`
  );
}

function cardHtml(card: StripCard, q: QuoteSnap | undefined): string {
  if (!q) return `<span class="qs-card"><span class="mw-meta">${escapeHtml(card.label)}</span><b>—</b></span>`;
  const color = changeColor(q.changeRate);
  return (
    `<span class="qs-card" title="${escapeHtml(card.ref.code)}">` +
    `<span class="mw-meta">${escapeHtml(card.label)}</span>` +
    `<b style="color:${color}">${fmtNum(q.close)} <small>${fmtPct(q.changeRate)}</small></b>` +
    `</span>`
  );
}

export function mountQuoteStrip(ctx: { readonly symbol: string }, el: HTMLElement, deps: QuoteStripDeps): WidgetHandle {
  ensureMarketStyles(el.ownerDocument);
  el.classList.add("mw", "qs-strip");
  const cards = deps.cards ?? DEFAULT_CARDS;
  let lastSymbol = "";

  const runner = latestRunner(
    async () => {
      const symbol = ctx.symbol;
      lastSymbol = symbol;
      const active = toContractRef(symbol);
      const refs = cards.map((c) => c.ref);
      if (active && !refs.some((r) => r.code === active.code && r.exchange === active.exchange)) refs.push(active);
      const quotes = await deps.quotes(refs);
      return { symbol, active, quotes };
    },
    ({ symbol, active, quotes }) => {
      const byCode = new Map(quotes.map((q) => [q.code, q]));
      const activeQuote = active ? byCode.get(active.code) : undefined;
      el.innerHTML =
        `<span class="qs-info">${infoHtml(symbol, activeQuote)}</span>` +
        cards.map((c) => cardHtml(c, byCode.get(c.ref.code))).join("");
    },
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      el.innerHTML = `<span class="mw-warn">報價暫停：${escapeHtml(msg)}</span>`;
    },
  );

  const poll = setInterval(() => {
    if (ctx.symbol !== lastSymbol) runner.run();
  }, deps.pollMs ?? 1000);
  const tick = setInterval(() => runner.run(), deps.refreshMs ?? 5000);
  runner.run();

  return {
    refresh: () => runner.run(),
    destroy() {
      runner.dispose();
      clearInterval(poll);
      clearInterval(tick);
      el.innerHTML = "";
    },
  };
}
````

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/pages/__tests__/quoteStrip.test.ts`
Expected: `Tests  6 passed (6)`

Run: `npx tsc --noEmit`
Expected: no output

---

### Task 3: 電子類股熱力圖

**Blocked by:** Task 2（imports the `WidgetHandle` type from `quoteStrip.ts`）

**Files:**
- Create: `src/pages/heatmap.ts`
- Test: `src/pages/__tests__/heatmap.test.ts`

**Interfaces:**
- Consumes: Task 1 `ELECTRONICS_CATEGORIES`, `IndexEntry`, `CATEGORY_NAMES`, `ensureMarketStyles`, `escapeHtml`, `fmtPct`, `heatColor`, `latestRunner`; Task 2 `WidgetHandle`
- Produces: `interface Rect`, `squarify<T>(items, rect)`, `interface HeatmapLayout`, `layoutHeatmap(entries, topN, rect)`, `interface HeatmapDeps { entries; onPick(symbol); topN?; height?; refreshMs? }`, `HEATMAP_TOP_N = 60`, `mountHeatmapPanel(body, deps): WidgetHandle`

**Assumptions:** `squarify` is the Bruls et al. squarified treemap; tests check area ∝ value, bounds and no overlap, not exact coordinates.

**Done when:**
- `npx vitest run src/pages/__tests__/heatmap.test.ts` → `6 passed`
- non-electronics stock (category `17`) never appears as a tile (test "keeps only electronics") → PASS
- no electronics data → panel shows `沒有電子類成分股資料` (test) → PASS
- `npx tsc --noEmit` → no output

- [ ] **Step 1: Write the failing test**, create `src/pages/__tests__/heatmap.test.ts` with exactly:

````ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexEntry } from "../../services/shioaji/marketData.ts";
import { layoutHeatmap, mountHeatmapPanel, squarify, type Rect } from "../heatmap.ts";
import type { WidgetHandle } from "../quoteStrip.ts";

const entry = (code: string, category: string, weightPpm: number, pct = 0): IndexEntry => ({
  code,
  exchange: "TSE",
  category,
  price: 100,
  pct,
  weightPpm,
  amount: 0,
});

const overlap = (a: Rect, b: Rect) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;

describe("squarify", () => {
  const rect = { x: 0, y: 0, w: 300, h: 200 };
  const items = [6, 6, 4, 3, 2, 2, 1].map((value, i) => ({ item: i, value }));

  it("tiles fill the rect, area ∝ value, inside bounds, no overlap", () => {
    const out = squarify(items, rect);
    expect(out).toHaveLength(items.length);
    const total = out.reduce((s, r) => s + r.w * r.h, 0);
    expect(total).toBeCloseTo(300 * 200, 6);
    for (const r of out) {
      expect(r.w * r.h).toBeCloseTo((items[r.item]!.value / 24) * 60_000, 6);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(300 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(200 + 1e-6);
    }
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) expect(overlap(out[i]!, out[j]!)).toBe(false);
  });

  it("ignores non-positive values and empty rects", () => {
    expect(squarify([{ item: "a", value: 0 }, { item: "b", value: -1 }], rect)).toEqual([]);
    expect(squarify(items, { x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
  });
});

describe("layoutHeatmap", () => {
  it("keeps only electronics (24–31), top N by weight, grouped by category", () => {
    const entries = [entry("2330", "24", 300), entry("2317", "28", 50), entry("2882", "17", 999), entry("2454", "24", 40), entry("3008", "26", 5)];
    const { groups, tiles } = layoutHeatmap(entries, 3, { x: 0, y: 0, w: 300, h: 200 });
    expect(tiles.map((t) => t.item.code).sort()).toEqual(["2317", "2330", "2454"]);
    expect(groups.map((g) => g.item).sort()).toEqual(["24", "28"]);
    const g24 = groups.find((g) => g.item === "24")!;
    for (const t of tiles.filter((t) => t.item.category === "24")) {
      expect(t.x).toBeGreaterThanOrEqual(g24.x - 1e-6);
      expect(t.x + t.w).toBeLessThanOrEqual(g24.x + g24.w + 1e-6);
    }
  });
});

describe("mountHeatmapPanel", () => {
  let body: HTMLElement;
  let handle: WidgetHandle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    body = document.createElement("div");
    document.body.appendChild(body);
  });

  afterEach(() => {
    handle?.destroy();
    handle = null;
    body.remove();
    vi.useRealTimers();
  });

  it("draws coloured tiles with category labels; clicking picks EXCHANGE:CODE", async () => {
    const onPick = vi.fn();
    const entries = vi.fn(async () => [entry("2330", "24", 300, 2.5), entry("2317", "28", 100, -1.2)]);
    handle = mountHeatmapPanel(body, { entries, onPick });
    await vi.waitFor(() => expect(body.querySelectorAll(".hm-tile")).toHaveLength(2));
    expect(body.textContent).toContain("半導體");
    expect(body.textContent).toContain("電子零組件");
    const tile = body.querySelector<HTMLElement>('[data-symbol="TSE:2330"]')!;
    expect(tile.style.background).not.toBe("");
    tile.click();
    expect(onPick).toHaveBeenCalledWith("TSE:2330");
  });

  it("says so when no electronics data is available", async () => {
    handle = mountHeatmapPanel(body, { entries: async () => [entry("2882", "17", 10)], onPick: vi.fn() });
    await vi.waitFor(() => expect(body.textContent).toContain("沒有電子類成分股資料"));
  });

  it("shows a warning on server failure and refreshes on its timer", async () => {
    const entries = vi.fn(async (): Promise<IndexEntry[]> => {
      throw new Error("down");
    });
    handle = mountHeatmapPanel(body, { entries, onPick: vi.fn(), refreshMs: 30_000 });
    await vi.waitFor(() => expect(body.textContent).toContain("無法取得熱力圖：down"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(entries).toHaveBeenCalledTimes(2);
  });
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/pages/__tests__/heatmap.test.ts`
Expected: FAIL, `Failed to resolve import "../heatmap.ts"`

- [ ] **Step 3: Create `src/pages/heatmap.ts`** with exactly:

````ts
/**
 * Electronics heatmap side panel (TradingView "Stock Heatmap" look) on
 * shioaji's TAIEX components: tiles grouped by TWSE industry (24–31), sized by
 * index weight, coloured by % change (red up / green down). Clicking a tile
 * switches the active chart to that stock — the only chart write, and only on
 * an explicit click.
 */
import { ELECTRONICS_CATEGORIES, type IndexEntry } from "../services/shioaji/marketData.ts";
import { CATEGORY_NAMES, ensureMarketStyles, escapeHtml, fmtPct, heatColor, latestRunner } from "./marketKit.ts";
import type { WidgetHandle } from "./quoteStrip.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap (Bruls et al.): lays out positive values into `rect`,
 *  area ∝ value, largest first, keeping tiles as close to square as it can. */
export function squarify<T>(items: ReadonlyArray<{ item: T; value: number }>, rect: Rect): Array<Rect & { item: T }> {
  const vals = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = vals.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const out: Array<Rect & { item: T }> = [];
  let { x, y, w, h } = rect;
  type Cell = { item: T; area: number };
  let row: Cell[] = [];

  const worst = (r: Cell[], side: number): number => {
    const s = r.reduce((a, c) => a + c.area, 0);
    let max = 0;
    for (const c of r) max = Math.max(max, (side * side * c.area) / (s * s), (s * s) / (side * side * c.area));
    return max;
  };
  const place = (r: Cell[]): void => {
    const s = r.reduce((a, c) => a + c.area, 0);
    if (w >= h) {
      const colW = s / h;
      let cy = y;
      for (const c of r) {
        const ch = c.area / colW;
        out.push({ item: c.item, x, y: cy, w: colW, h: ch });
        cy += ch;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = s / w;
      let cx = x;
      for (const c of r) {
        const cw = c.area / rowH;
        out.push({ item: c.item, x: cx, y, w: cw, h: rowH });
        cx += cw;
      }
      y += rowH;
      h -= rowH;
    }
  };

  for (const v of vals) {
    const cell = { item: v.item, area: v.value * scale };
    const side = Math.min(w, h);
    if (row.length === 0 || worst([...row, cell], side) <= worst(row, side)) row.push(cell);
    else {
      place(row);
      row = [cell];
    }
  }
  if (row.length) place(row);
  return out;
}

export interface HeatmapLayout {
  groups: Array<Rect & { item: string }>;
  tiles: Array<Rect & { item: IndexEntry }>;
}

/** Top `topN` electronics stocks by index weight, grouped by industry. */
export function layoutHeatmap(entries: readonly IndexEntry[], topN: number, rect: Rect): HeatmapLayout {
  const picked = entries
    .filter((e) => ELECTRONICS_CATEGORIES.includes(e.category) && e.weightPpm > 0)
    .sort((a, b) => b.weightPpm - a.weightPpm)
    .slice(0, topN);
  const byCat = new Map<string, IndexEntry[]>();
  for (const e of picked) byCat.set(e.category, [...(byCat.get(e.category) ?? []), e]);
  const groups = squarify(
    [...byCat.entries()].map(([cat, list]) => ({ item: cat, value: list.reduce((s, e) => s + e.weightPpm, 0) })),
    rect,
  );
  const tiles = groups.flatMap((g) =>
    squarify(
      (byCat.get(g.item) ?? []).map((e) => ({ item: e, value: e.weightPpm })),
      { x: g.x, y: g.y, w: g.w, h: g.h },
    ),
  );
  return { groups, tiles };
}

export interface HeatmapDeps {
  entries: () => Promise<IndexEntry[]>;
  onPick: (symbol: string) => void;
  topN?: number;
  height?: number;
  refreshMs?: number;
}

export const HEATMAP_TOP_N = 60;

export function mountHeatmapPanel(body: HTMLElement, deps: HeatmapDeps): WidgetHandle {
  const doc = body.ownerDocument;
  ensureMarketStyles(doc);
  const root = doc.createElement("div");
  root.className = "mw";
  root.style.padding = "8px";
  body.appendChild(root);
  const topN = deps.topN ?? HEATMAP_TOP_N;
  const height = deps.height ?? 420;

  root.addEventListener("click", (ev) => {
    const tile = (ev.target as HTMLElement).closest?.("[data-symbol]") as HTMLElement | null;
    if (tile?.dataset.symbol) deps.onPick(tile.dataset.symbol);
  });

  const runner = latestRunner(
    () => deps.entries(),
    (entries) => {
      const width = root.clientWidth > 0 ? root.clientWidth - 16 : 300;
      const { groups, tiles } = layoutHeatmap(entries, topN, { x: 0, y: 0, w: width, h: height });
      if (tiles.length === 0) {
        root.innerHTML = `<div class="mw-meta">沒有電子類成分股資料</div>`;
        return;
      }
      const box = (r: Rect) =>
        `left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${r.w.toFixed(1)}px;height:${r.h.toFixed(1)}px`;
      const tileHtml = tiles
        .map((t) => {
          const e = t.item;
          const label = t.w >= 34 && t.h >= 22 ? `${escapeHtml(e.code)}<br>${fmtPct(e.pct)}` : "";
          const title = `${e.code} ${fmtPct(e.pct)} · 權重 ${(e.weightPpm / 10_000).toFixed(2)}%`;
          return `<div class="hm-tile" data-symbol="${escapeHtml(`${e.exchange}:${e.code}`)}" title="${escapeHtml(title)}" style="${box(t)};background:${heatColor(e.pct)}">${label}</div>`;
        })
        .join("");
      const groupHtml = groups
        .map((g) => `<div class="hm-group" style="${box(g)}"><span>${escapeHtml(CATEGORY_NAMES[g.item] ?? g.item)}</span></div>`)
        .join("");
      root.innerHTML =
        `<div class="mw-meta">電子類前 ${tiles.length} 大（依加權指數權重）· 點方塊切換商品</div>` +
        `<div class="hm-box" style="height:${height}px">${tileHtml}${groupHtml}</div>` +
        `<div class="mw-meta">${fmtPct(-3)} <span style="color:${heatColor(-3)}">■</span> 0 <span style="color:${heatColor(3)}">■</span> ${fmtPct(3)}</div>`;
    },
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      root.innerHTML = `<div class="mw-warn">無法取得熱力圖：${escapeHtml(msg)}</div>`;
    },
  );

  const tick = setInterval(() => runner.run(), deps.refreshMs ?? 30_000);
  runner.run();

  return {
    refresh: () => runner.run(),
    destroy() {
      runner.dispose();
      clearInterval(tick);
      root.remove();
    },
  };
}
````

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/pages/__tests__/heatmap.test.ts`
Expected: `Tests  6 passed (6)`

Run: `npx tsc --noEmit`
Expected: no output

---

### Task 4: 排行榜

**Blocked by:** Task 2（imports the `WidgetHandle` type from `quoteStrip.ts`）

**Files:**
- Create: `src/pages/hotlists.ts`
- Test: `src/pages/__tests__/hotlists.test.ts`

**Interfaces:**
- Consumes: Task 1 `RankKind`, `RankRow`, `changeColor`, `ensureMarketStyles`, `escapeHtml`, `fmtBig`, `fmtNum`, `fmtPct`, `latestRunner`; Task 2 `WidgetHandle`
- Produces: `HOTLIST_TABS`, `interface HotlistsDeps { ranking(kind); onPick(code); refreshMs? }`, `mountHotlistsPanel(body, deps): WidgetHandle`

**Assumptions:** None

**Done when:**
- `npx vitest run src/pages/__tests__/hotlists.test.ts` → `4 passed`
- empty ranking → `無資料`; failing ranking → `無法取得排行：` (test "empty and failing rankings show a message") → PASS
- `npx tsc --noEmit` → no output

- [ ] **Step 1: Write the failing test**, create `src/pages/__tests__/hotlists.test.ts` with exactly:

````ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RankKind, RankRow } from "../../services/shioaji/marketData.ts";
import { mountHotlistsPanel } from "../hotlists.ts";
import type { WidgetHandle } from "../quoteStrip.ts";

const row = (code: string, changeRate: number): RankRow => ({
  code,
  name: "",
  close: 100,
  changePrice: changeRate,
  changeRate,
  totalVolume: 25_000,
  totalAmount: 300_000_000,
  date: "2026-10-16",
});

describe("mountHotlistsPanel", () => {
  let body: HTMLElement;
  let handle: WidgetHandle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    body = document.createElement("div");
    document.body.appendChild(body);
  });

  afterEach(() => {
    handle?.destroy();
    handle = null;
    body.remove();
    vi.useRealTimers();
  });

  it("starts on 漲幅 and lists rows with the data date", async () => {
    const ranking = vi.fn(async (_k: RankKind) => [row("2330", 9.9), row("6547", 5)]);
    handle = mountHotlistsPanel(body, { ranking, onPick: vi.fn() });
    await vi.waitFor(() => expect(body.querySelectorAll("tr[data-code]")).toHaveLength(2));
    expect(ranking).toHaveBeenCalledWith("gainers");
    expect(body.textContent).toContain("資料日 2026-10-16");
    expect(body.querySelector("button[data-active]")!.textContent).toBe("漲幅");
    expect(body.innerHTML).toContain("#f23645");
  });

  it("switching tab fetches that ranking; amount shows 億", async () => {
    const ranking = vi.fn(async (_k: RankKind) => [row("2330", -3)]);
    handle = mountHotlistsPanel(body, { ranking, onPick: vi.fn() });
    await vi.waitFor(() => expect(ranking).toHaveBeenCalledTimes(1));
    body.querySelector<HTMLButtonElement>('button[data-kind="amount"]')!.click();
    await vi.waitFor(() => expect(ranking).toHaveBeenLastCalledWith("amount"));
    await vi.waitFor(() => expect(body.textContent).toContain("億"));
    expect(body.querySelector("button[data-active]")!.textContent).toBe("成交金額");
  });

  it("clicking a row picks its code", async () => {
    const onPick = vi.fn();
    handle = mountHotlistsPanel(body, { ranking: async () => [row("6547", 1)], onPick });
    await vi.waitFor(() => expect(body.querySelector("tr[data-code]")).not.toBeNull());
    body.querySelector<HTMLElement>("tr[data-code] td")!.click();
    expect(onPick).toHaveBeenCalledWith("6547");
  });

  it("empty and failing rankings show a message", async () => {
    handle = mountHotlistsPanel(body, { ranking: async () => [], onPick: vi.fn() });
    await vi.waitFor(() => expect(body.textContent).toContain("無資料"));
    handle.destroy();
    handle = mountHotlistsPanel(body, {
      ranking: async () => {
        throw new Error("down");
      },
      onPick: vi.fn(),
    });
    await vi.waitFor(() => expect(body.textContent).toContain("無法取得排行：down"));
  });
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/pages/__tests__/hotlists.test.ts`
Expected: FAIL, `Failed to resolve import "../hotlists.ts"`

- [ ] **Step 3: Create `src/pages/hotlists.ts`** with exactly:

````ts
/**
 * Hotlists side panel (TradingView "Stock Market" hotlists look) on shioaji's
 * scanner: 漲幅 / 跌幅 / 成交量 / 成交金額, latest trading day. Clicking a row
 * switches the active chart to that stock (explicit click only).
 */
import type { RankKind, RankRow } from "../services/shioaji/marketData.ts";
import { changeColor, ensureMarketStyles, escapeHtml, fmtBig, fmtNum, fmtPct, latestRunner } from "./marketKit.ts";
import type { WidgetHandle } from "./quoteStrip.ts";

export const HOTLIST_TABS: ReadonlyArray<[RankKind, string]> = [
  ["gainers", "漲幅"],
  ["losers", "跌幅"],
  ["volume", "成交量"],
  ["amount", "成交金額"],
];

export interface HotlistsDeps {
  ranking: (kind: RankKind) => Promise<RankRow[]>;
  /** Called with the stock code of a clicked row. */
  onPick: (code: string) => void;
  refreshMs?: number;
}

export function mountHotlistsPanel(body: HTMLElement, deps: HotlistsDeps): WidgetHandle {
  const doc = body.ownerDocument;
  ensureMarketStyles(doc);
  const root = doc.createElement("div");
  root.className = "mw";
  root.style.padding = "8px";
  body.appendChild(root);

  let kind: RankKind = "gainers";
  const tabs = doc.createElement("div");
  tabs.className = "hl-tabs";
  for (const [k, label] of HOTLIST_TABS) {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.kind = k;
    tabs.appendChild(b);
  }
  const list = doc.createElement("div");
  root.append(tabs, list);

  const markTab = () => {
    for (const b of tabs.querySelectorAll("button")) {
      if ((b as HTMLButtonElement).dataset.kind === kind) b.setAttribute("data-active", "");
      else b.removeAttribute("data-active");
    }
  };

  const runner = latestRunner(
    async () => {
      const k = kind;
      return { k, rows: await deps.ranking(k) };
    },
    ({ k, rows }) => {
      if (rows.length === 0) {
        list.innerHTML = `<div class="mw-meta">無資料</div>`;
        return;
      }
      const last = k === "amount" ? "金額" : "量";
      list.innerHTML =
        `<div class="mw-meta">資料日 ${escapeHtml(rows[0]!.date)} · 點列切換商品</div>` +
        `<table class="hl-table"><tbody>` +
        rows
          .map((r, i) => {
            const big = k === "amount" ? r.totalAmount : r.totalVolume;
            return (
              `<tr data-code="${escapeHtml(r.code)}">` +
              `<td class="mw-meta">${i + 1}</td>` +
              `<td><b>${escapeHtml(r.code)}</b> <span class="mw-meta">${escapeHtml(r.name)}</span></td>` +
              `<td class="num">${fmtNum(r.close)}</td>` +
              `<td class="num" style="color:${changeColor(r.changeRate)}">${fmtPct(r.changeRate)}</td>` +
              `<td class="num mw-meta" title="${last}">${fmtBig(big)}</td>` +
              `</tr>`
            );
          })
          .join("") +
        `</tbody></table>`;
    },
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      list.innerHTML = `<div class="mw-warn">無法取得排行：${escapeHtml(msg)}</div>`;
    },
  );

  tabs.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest?.("button") as HTMLButtonElement | null;
    const k = b?.dataset.kind as RankKind | undefined;
    if (!k || k === kind) return;
    kind = k;
    markTab();
    list.innerHTML = `<div class="mw-meta">載入中…</div>`;
    runner.run();
  });
  list.addEventListener("click", (ev) => {
    const tr = (ev.target as HTMLElement).closest?.("tr[data-code]") as HTMLElement | null;
    if (tr?.dataset.code) deps.onPick(tr.dataset.code);
  });

  markTab();
  const tick = setInterval(() => runner.run(), deps.refreshMs ?? 30_000);
  runner.run();

  return {
    refresh: () => runner.run(),
    destroy() {
      runner.dispose();
      clearInterval(tick);
      root.remove();
    },
  };
}
````

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run src/pages/__tests__/hotlists.test.ts`
Expected: `Tests  4 passed (4)`

Run: `npx tsc --noEmit`
Expected: no output

---

### Task 5: 註冊到 Vela + 全套驗證

**Blocked by:** Task 1, Task 2, Task 3, Task 4

**Files:**
- Create: `src/pages/velaMarketWidgets.ts`
- Modify: `src/pages/VelaPage.tsx`（只加一行 import）

**Interfaces:**
- Consumes: Task 1 `fetchContractInfo`, `fetchIndexEntries`, `fetchQuotes`, `fetchRanking`; Task 2 `mountQuoteStrip`; Task 3 `mountHeatmapPanel`; Task 4 `mountHotlistsPanel`
- Produces: side-effect module registering attachment `opencharts.quote-strip`, side panels `opencharts.heatmap` / `opencharts.hotlists`, topbar actions `opencharts.heatmap.toggle`（熱力圖, order 3）/ `opencharts.hotlists.toggle`（排行, order 4）, icons `heatmap` / `hotlist`

**Assumptions:** Vela mounts an attachment once per widget shell; the `.qs-strip` guard keeps it to one strip per page.

**Done when:**
- `npx tsc --noEmit` → no output
- `npx vitest run src/services/__tests__/marketData.test.ts src/pages/__tests__/quoteStrip.test.ts src/pages/__tests__/heatmap.test.ts src/pages/__tests__/hotlists.test.ts` → `Test Files  4 passed (4)`, `Tests  27 passed (27)`
- `npx vitest run`（全套）→ 本計畫的 4 個測試檔全過；其他失敗若在 `vite.config.ts` / `src/services/guard/` 相關檔，記錄到報告，不修
- `grep -c "velaMarketWidgets" src/pages/VelaPage.tsx` → `1`
- `grep -rn "setSymbol" src/pages/heatmap.ts src/pages/hotlists.ts src/pages/quoteStrip.ts` → no match（D2）

- [ ] **Step 1: Create `src/pages/velaMarketWidgets.ts`** with exactly:

````ts
/**
 * Registers the quote widgets with Vela (side effect — imported once by
 * VelaPage): the quote strip (auto-docked under the charts), the electronics
 * heatmap and the hotlists side panels plus their topbar toggles. All data
 * comes from the local shioaji server; see services/shioaji/marketData.ts.
 *
 * Import from "@luxalgo/vela/plugin", NOT the root barrel (separate module
 * instances — see velaPineEditor.ts header).
 */
import { registerIcon, registerSidePanel, registerWidgetAction, registerWidgetAttachment } from "@luxalgo/vela/plugin";
import { svg16 } from "@luxalgo/vela/ui";
import {
  fetchContractInfo,
  fetchIndexEntries,
  fetchQuotes,
  fetchRanking,
} from "../services/shioaji/marketData.ts";
import { mountHeatmapPanel } from "./heatmap.ts";
import { mountHotlistsPanel } from "./hotlists.ts";
import { mountQuoteStrip } from "./quoteStrip.ts";

const HEATMAP_ID = "opencharts.heatmap";
const HOTLISTS_ID = "opencharts.hotlists";

registerIcon("heatmap", svg16('<rect x="2" y="2" width="7" height="7"/><rect x="10" y="2" width="4" height="4"/><rect x="10" y="7" width="4" height="7"/><rect x="2" y="10" width="7" height="4"/>'));
registerIcon("hotlist", svg16('<path d="M3 4h10M3 8h7M3 12h4"/>'));

registerWidgetAttachment({
  id: "opencharts.quote-strip",
  mount(ctx) {
    const doc = ctx.host.ownerDocument;
    if (doc.querySelector(".qs-strip")) return () => {}; // one strip per page
    const el = doc.createElement("div");
    const undock = ctx.dockStrip(el);
    const strip = mountQuoteStrip(ctx, el, { quotes: (refs) => fetchQuotes(refs) });
    return () => {
      strip.destroy();
      undock();
    };
  },
});

registerSidePanel({
  id: HEATMAP_ID,
  title: "電子熱力圖",
  icon: "heatmap",
  width: 360,
  resizable: true,
  minWidth: 280,
  mount(ctx, body) {
    const panel = mountHeatmapPanel(body, {
      entries: () => fetchIndexEntries(),
      onPick: (symbol) => ctx.setSymbol(symbol),
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

registerSidePanel({
  id: HOTLISTS_ID,
  title: "排行榜",
  icon: "hotlist",
  width: 320,
  resizable: true,
  minWidth: 260,
  mount(ctx, body) {
    const panel = mountHotlistsPanel(body, {
      ranking: (kind) => fetchRanking(kind, 20, new Date()),
      onPick: (code) => {
        void fetchContractInfo(code).then((info) => ctx.setSymbol(`${info?.exchange ?? "TSE"}:${code}`));
      },
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
  id: "opencharts.heatmap.toggle",
  target: "topbar",
  align: "right",
  icon: "heatmap",
  label: "熱力圖",
  order: 3,
  run: (ctx) => ctx.togglePanel(HEATMAP_ID),
});

registerWidgetAction({
  id: "opencharts.hotlists.toggle",
  target: "topbar",
  align: "right",
  icon: "hotlist",
  label: "排行",
  order: 4,
  run: (ctx) => ctx.togglePanel(HOTLISTS_ID),
});
````

- [ ] **Step 2: Add the import to `src/pages/VelaPage.tsx`**

Anchor (search for this exact line; do not trust line numbers): `import "./velaTechRating.ts";`

Original:

````tsx
import "./velaTechRating.ts"; // 註冊「技術評分」側邊面板與頂列 "評分" 按鈕（side effect）
````

Replacement:

````tsx
import "./velaTechRating.ts"; // 註冊「技術評分」側邊面板與頂列 "評分" 按鈕（side effect）
import "./velaMarketWidgets.ts"; // 註冊報價列、電子熱力圖與排行榜（side effect）
````

Do NOT touch any other line of `VelaPage.tsx` (it contains the user's uncommitted `velaNautilusBacktest.ts` import; leave it).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output

- [ ] **Step 4: Run the plan's 4 test files together**

Run: `npx vitest run src/services/__tests__/marketData.test.ts src/pages/__tests__/quoteStrip.test.ts src/pages/__tests__/heatmap.test.ts src/pages/__tests__/hotlists.test.ts`
Expected: `Test Files  4 passed (4)` and `Tests  27 passed (27)`

- [ ] **Step 5: Run the full suite** (timeout 600000ms)

Run: `npx vitest run`
Expected: 0 failed. If anything fails outside this plan's files, record file + test name in the report; do not fix it.

- [ ] **Step 6: Guard checks**

Run: `grep -c "velaMarketWidgets" src/pages/VelaPage.tsx`
Expected: `1`

Run: `grep -rn "setSymbol" src/pages/heatmap.ts src/pages/hotlists.ts src/pages/quoteStrip.ts`
Expected: no output

- [ ] **Step 7: Do NOT commit** (D1). List every file you created or modified in the report.

## 人工驗收（使用者，執行完成後）

1. 啟動 Shioaji 伺服器與 `npm run dev`，開 `/vela`。
2. 圖下方出現報價列：左側為目前商品資訊列，右側 5 張卡（加權／大台／小台／微台／台積電），漲紅跌綠。
3. 切換主圖商品（例如 `TAIFEX:TMFK6`）→ 1 秒內資訊列跟著換。
4. 頂列「熱力圖」→ 電子類前 60 大方塊，依產業分組；點 2330 → 主圖切到台積電。
5. 頂列「排行」→ 四個分頁都有資料（顯示資料日）；點一列上櫃股（例 6547）→ 主圖切到 `OTC:6547`。
