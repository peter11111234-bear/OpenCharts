# Vela MCP Server（外部 AI 連上 /vela 控制圖表）Implementation Plan

> **日期：** 2026-10-21
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Executor:** OMP（模型由派工時指定）。**本計畫的程式碼由 Opus 在 repo 試作並驗證過**：4 個測試檔 44 passed、`npx tsc --noEmit` 0 error；臨時 Vite（5199）上用真的 Claude Code（`claude -p --mcp-config`）連線成功，列出 18 個工具，呼叫經 Vite 轉到假頁面再拿回結果（含中文）。試作檔已刪除，working tree 已還原。執行者**逐字照抄**，不得改寫、不得「優化」。

**Goal:**
像 tradingview-mcp 控制 TradingView Desktop 一樣，讓外部 AI（Claude Code、OMP）用 MCP 連上 `http://localhost:5173/__mcp`，對開著的 `/vela` 讀圖、切商品與週期、畫線、加指標、截圖、跑 Pine。沒有下單。

**Architecture:**
MCP 端點掛在既有的 Vite dev server（Streamable HTTP、只回 JSON）。圖表在瀏覽器裡，所以 Vite 用 SSE 把每個工具呼叫轉給開著的 `/vela` 頁面；頁面用 Vela API 執行後，把「圖表實際讀回的狀態」POST 回 Vite，再回給 MCP 客戶端。改圖的檢查沿用 AI 副駕駛的 `checkToolCall` → `applyAction`。所有 Shioaji 歷史查詢經過一個閘門：一次一個、同圖 30 秒快取、兩次上游查詢至少間隔 2 秒。

```
Claude Code / OMP ──POST /__mcp (JSON-RPC)──▶ Vite :5173 ──SSE /__mcp/bridge──▶ /vela 頁面 (velaMcpClient.ts)
                  ◀──────── JSON 結果 ─────────          ◀──POST /__mcp/result──  └ handlers.ts → checkToolCall → applyAction → Vela
```

**Tech Stack:** TypeScript（strict）、`@luxalgo/vela` 0.8 plugin API、zod 3（既有）、Vitest + jsdom、Vite 6 dev middleware。不新增任何依賴（MCP SDK 未安裝，協定手寫）。

**Spec:** 本計畫的「需求（2026-10-21 使用者確認）」一節；上一版設計 `docs/superpowers/plans/2026-10-21-ai-assistant-omp-vela-mcp.md`。該計畫的 D1 刻意不做 MCP，重新考慮的條件寫的是「需要讓瀏覽器以外的 agent（例：OMP、排程）操作圖表」，本需求正好符合，所以 D1 的 Outcome 已標為 revisited。

**Spec invariant:** 外部 AI 經 MCP 的每個改圖呼叫都先過 `checkToolCall`（價格有限、> 0、落在近期 K 棒區間；台北時間字串；商品白名單 TMF／MXF／股票；指標鍵名與型別），再經 `applyAction` 執行。回報一律是頁面讀回的實際狀態：沒有頁面、逾時、失敗都回 `isError`，絕不回假成功。MCP 只能刪除自己建立的圖形與指標。工具清單裡沒有任何下單工具。`/__mcp*` 只服務 loopback Host。

---

## 需求（2026-10-21 使用者確認）

| 問題 | 使用者選擇 |
|---|---|
| 權限等級 | **B：可操作圖表**（讀資料＋切商品週期、畫線、加指標、截圖），不含下單 |
| 連線方式 | **經 Vite 中轉**（`/__mcp`，頁面主動連上來接指令），不用 CDP |
| 對齊 tradingview-mcp 的功能 | **全部四類**：圖表狀態與資料、圖表控制、畫圖與指標、Pine 腳本 |
| 改圖確認方式 | **直接執行＋防線**（不出卡片；同一套驗證，失敗回錯誤；MCP 畫的東西可一鍵清除） |

功能對齊依據：本機 `C:\Users\bear9\tradingview-mcp\src` 的工具清單（約 85 個）。不需要逆向（REA），因為有原始碼。

### 對齊表

| tradingview-mcp 工具 | Vela MCP | 備註 |
|---|---|---|
| `chart_get_state` | `chart_get_state` | 加上 `added_by_mcp`、內建指標清單、圖形擁有者計數 |
| `data_get_ohlcv` | `data_get_ohlcv` | 最多 300 根，經閘門 |
| `quote_get` | `quote_get` | 用目前週期最後一根 K 棒（不另打 snapshot 端點，省流量） |
| `data_get_study_values` | `data_get_study_values` | `handle.context(["plots"])` 的最後一點 |
| `chart_set_symbol` / `chart_set_timeframe` | 同名 | 白名單：期貨只 TMF／MXF |
| `chart_set_visible_range` / `chart_scroll_to_date` | 同名 | 台北時間字串 |
| `draw_shape` / `draw_list` / `draw_remove_one` / `draw_clear` | 同名 | 形狀：水平線、趨勢線、箭頭標記；只能刪 MCP 畫的 |
| `indicator_add` / `indicator_set_inputs` | 同名 | 內建指標；改參數驗鍵名與型別 |
| `chart_manage_indicator`（remove） | `indicator_remove` | 只能移除 MCP 加的 |
| `capture_screenshot` | `capture_screenshot` | `chart.renderer.screenshot()`，MCP image content |
| `pine_set_source`＋`pine_compile`＋`pine_get_errors` | `pine_compile` | 跑一次、回報錯誤／警告／plot 值，再拿掉 |
| `pine_smart_compile`（加到圖上） | `pine_add` | 留在圖上，可用 `indicator_remove` 拿掉 |
| 下單、alert、replay、layout／tab／pane、watchlist、`ui_*`、`symbol_search`、`pine_save/open`、策略報表 | **不做** | 下單另案（Phase 2，經訂單守門員）；其餘不是看盤判斷必需，或 Vela 沒有對應的安全 API |

---

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same verify failing after 2+ distinct fix attempts. Single red test in the "verify it fails" step = expected, not a blocker.

Never stop to ask what you can look up. Questions that don't change your next action: note them, keep going, report at task end.

用 CodeGraph 查程式碼時一律加 `-p C:/Users/bear9/MYOPENCHART`（例：`codegraph explore "applyAction checkToolCall" -p C:/Users/bear9/MYOPENCHART`）。

**Plan-specific Nevers:**
1. **NEVER rewrite, reformat, or "improve" the code blocks.** Copy each fenced block byte-for-byte into the named file (UTF-8, LF, trailing newline). Acceptance is a byte-compare against Opus's verified copies.
2. **NEVER `git commit`, `git add`, `git stash`, `git checkout --`, or `git reset`.** The working tree holds other people's uncommitted work.
3. **NEVER touch files outside the Files lists.** In `VelaPage.tsx` and `vite.config.ts` change ONLY the anchored lines given.
4. **NEVER edit `src/services/ai-assistant/tools.ts` or `src/pages/aiAssistantPanel.ts`**, import them only. The AI 副駕駛 panel keeps its own invariant (LLM only proposes; cards).
5. **NEVER add an order / trade / alert tool**, or call `guardedPlaceOrder` / Shioaji order endpoints.
6. **NEVER call `provider.getBars` from MCP code except through the bars gate** (`createBarsGate`, 30 s TTL, 2 s gap), a kbars burst drops the Shioaji session and eats the 500 MB daily quota. Settled in D3.
7. **NEVER let MCP remove a drawing or indicator it did not create** (settled in D4), and never write `localStorage["vela-workspace-v2"]`.
8. **NEVER write `vite.config.ts` or `VelaPage.tsx` during trading hours** (日盤 08:45–13:45、夜盤 15:00–05:00). Any write restarts / hot-reloads Vite and the open `/vela` loses its K 棒 until Ctrl+Shift+R. Tasks 1–4 only add new, unimported files and are safe any time; Task 5 is not.
9. **NEVER run `npx eslint`** (config is broken) **or `npx vitest run` without file paths** (CPU guard). Run only the test files each task names.
10. **NEVER `npm i`**, and never register the MCP server in the user's persistent config (`claude mcp add`, `~/.omp/agent/mcp.json`), live MCP-client tests belong to Opus acceptance (temporary `--mcp-config`); persistent registration is the user's call.

---

## Global Constraints

- Repo root: `C:\Users\bear9\OpenCharts`（Windows，PowerShell；`MYOPENCHART\OpenCharts` 是 junction）。
- Imports: relative paths **with `.ts`**; Vela registration imports from `"@luxalgo/vela/plugin"`, NOT the root `"@luxalgo/vela"`. Types (`OHLCV`) from `"@luxalgo/vela"` are fine.
- No `@types/node` in this repo and `tsconfig` includes only `src/`: server-side code under `src/` uses the minimal `BridgeReq` / `BridgeRes` shapes, not `node:http` types.
- Comments English; user-visible strings 繁體中文.
- Colors 紅漲綠跌：bullish `#f23645`、bearish `#089981`（from `tools.ts`）。
- Futures symbols: 微台 `TMF` / 小台 `MXF` only, never 大台 `TXF`.
- Times across the MCP boundary: Taipei wall clock `YYYY-MM-DD HH:mm`; Vela anchors epoch **ms**.
- `bridge.ts`, `protocol.ts`, `mcpTools.ts` become **vite.config.ts dependencies** in Task 5: Vite restarts on any change to them (`isConfigDependency` in `node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js`), so after Task 5 they follow the same trading-hours rule as `vite.config.ts`, and they must not import anything outside `src/services/vela-mcp/` (that is why `MCP_TIMEFRAMES` is a copy).
- Baseline before this plan: `npx tsc --noEmit` → **0 errors**.

---

## Decision Points

### D1: MCP 端點放哪裡、用什麼傳輸 (T1)
- Consumed by: Task 1, Task 4, Task 5
- Candidates:
  - A (existing pattern): Vite dev middleware，像 `/__ai-chat`（`vite.config.ts` 的 `aiChatPlugin`）。在 `/__mcp` 手寫 Streamable HTTP（只回 JSON）。
  - B (minimal): 獨立 stdio MCP 程式（`node xxx.mjs`），自己再連 Vite 或瀏覽器。
  - C (preferred alt): CDP，跟 tradingview-mcp 一樣用 `--remote-debugging-port` 在頁面執行 JS。
- Criteria:
  1. No extra process to start besides the existing Vite.
  2. Both Claude Code and OMP can connect (both accept `type: "http"`; verified: `~/.omp/agent/mcp.json` already has http entries).
  3. No new npm dependency.
  4. The browser can be opened normally (no special launch flag).
- Chosen: A
- Rejected: B fails 1 (one more process, plus a bridge back to the page anyway). C fails 4 (browser must start with a debug port, which the user declined).
- Revisit trigger: an MCP client that only speaks stdio must connect → add a stdio→HTTP shim; do not move the server.
- Outcome: **held，實機驗證通過。** 端點 `http://localhost:5173/__mcp`（Vite dev middleware，Streamable HTTP，只回 JSON）。不需額外行程、未新增任何 npm 依賴、瀏覽器正常開啟即可用。Claude Code 2.1.306 以 `type: "http"` + 暫時 `--mcp-config` 實機連線成功，10 步工具呼叫全數回傳原文。**注意**：此機 Vite 只綁 IPv6 `::1`，`http://127.0.0.1:5173/__mcp` 連不上（connection refused），要用 `localhost`。

### D2: Vite 怎麼把指令送到頁面 (T1)
- Consumed by: Task 4, Task 5
- Candidates:
  - A (existing pattern): none found for server→page push (searched `vite.config.ts`, `src/services/shioaji/feed.ts`, feed.ts consumes SSE from 8080 but nothing in Vite pushes to the page).
  - B (minimal): page polls `GET /__mcp/next` every N ms.
  - C (preferred): page holds one `EventSource('/__mcp/bridge')`; answers with `POST /__mcp/result {id, result}`; newest tab wins; disconnect fails pending calls at once.
- Criteria:
  1. A call reaches the page in under 100 ms when idle.
  2. A closed / reloaded page turns pending calls into errors without waiting for the timeout.
  3. No `ws` server code (the `ws` package exists but adds an upgrade handler to the shared dev server).
- Chosen: C
- Rejected: B fails 1 (latency = poll interval) and 2 (no disconnect signal).
- Revisit trigger: a corporate proxy / extension buffers SSE so commands arrive late (observable: `chart_get_state` takes > 1 s while the page is idle).
- Outcome: **held，實機驗證通過。** 頁面端 `EventSource("/__mcp/bridge")` 一條 SSE；指令 `data: {id,name,args}`，頁面 `POST /__mcp/result {id,result}` 回答案。實測：10 次 `data_get_ohlcv` 全程 0.4–0.7 s（每次 < 100 ms）；`draw_shape`→`draw_list` 往返 < 1 s。newest tab wins 實測：第二個分頁開 SSE 後，第一個分頁收到 `event: replaced` 並被 end，指令只送給新分頁。無 `ws` 程式碼。

### D3: Shioaji 查詢保護 (T1)
- Consumed by: Task 2, Task 3, Task 5
- Candidates:
  - A (existing pattern): `throttleBars` in `src/services/shioaji/velaProvider.ts`, coalesces **live** bars for rendering; it does not gate history queries. No query cache exists in `getBars`.
  - B (minimal): call `provider.getBars` directly per tool call (the AI panel does this, one call per question).
  - C (preferred): `createBarsGate`, serial queue, 30 s cache per symbol+timeframe, ≥ 2 s between upstream fetches, failures not cached.
- Criteria:
  1. 10 rapid `data_get_ohlcv` calls on one chart produce one upstream fetch.
  2. Two upstream fetches never overlap.
  3. A failed fetch (429, empty quota) is retried on the next call, not served from cache.
- Chosen: C
- Rejected: A fails 1 (wrong layer). B fails 1 and 2 (agents loop on tools; see memory `shioaji-no-burst-queries`).
- Revisit trigger: an agent needs bars fresher than 30 s for a decision (observable: user reports MCP quote lagging the chart).
- Outcome: **held，實機驗證通過（但計畫的閘門量測方式要修正）。** `createBarsGate` 實測：20 次連續 `data_get_ohlcv` → 上游 kbars **delta 0**；等 30 s TTL 過期後再 1 次 → delta **1**。頁面關閉時 MCP 呼叫直接回 isError、kbars delta 0（不碰上游）。失敗不快取：`cache.set` 在 `await fetchBars` 成功後才執行。**計畫 Step 4 原本寫的「前後各記一次 `grep -c kbars`，差值 ≤ 1」不可靠**：實測 2 分鐘閒置、頁面開著時 kbars 會自己 +8、頁面關著時 2 分鐘也 +4（背景排程的行情回補），底噪音遠大於 MCP 本身的貢獻。要量 MCP 的貢獻必須用「同一段時間內 MCP 呼叫造成的 delta」，或把頁面與背景排程關掉再量。

### D4: MCP 能刪哪些東西 (T1)
- Consumed by: Task 3
- Candidates:
  - A (existing pattern): Vela `drawings.remove(id)` / `IndicatorHandle.remove()` on any id (what tradingview-mcp's `draw_clear` does to all drawings).
  - B (minimal): no remove tools.
  - C (preferred): track ids MCP created (`McpState`); remove / clear only those; ids found by diffing `drawings.all()` / `indicators()` before and after the change.
- Criteria:
  1. The trader's own drawings and indicators survive any MCP call.
  2. An agent can undo its own drawings in one call.
- Chosen: C
- Rejected: A fails 1. B fails 2.
- Revisit trigger: the user asks MCP to clean up drawings they made by hand.
- Outcome: **held，實機驗證通過。** `McpState` 追蹤 MCP 自建項目。實測：`draw_shape` 回 `id: dw-1`；`draw_list` → `by_mcp: [{id:dw-1, type:hline, anchors:[["2026-10-20 13:30",2405]]}]`、`by_trader_count: 0`；`draw_clear` → `{"removed": 1}`；再 `draw_list` → `by_mcp: []`。交易員自己的圖形與指標不受影響（`chart_get_state` 的 `by_trader` 計數在整輪 MCP 操作前後不變）。

### D5: 改圖要不要卡片確認 (T1, user-confirmed 2026-10-21)
- Consumed by: Task 3
- Candidates:
  - A (existing pattern): AI 副駕駛的卡片（`aiAssistantPanel.ts`），交易員點「套用」才執行。
  - C (preferred): direct execution behind the same checks (`checkToolCall` → `applyAction`); errors go back to the agent.
- Criteria:
  1. An agent can finish a multi-step chart task without the trader clicking.
  2. A hallucinated price / time / symbol never reaches Vela.
- Chosen: C（使用者選「直接執行＋防線」）
- Rejected: A fails 1.
- Revisit trigger: the user asks for confirmation on some class of MCP actions.
- Outcome: **held，實機驗證通過。** Claude Code 10 步全程無 isError、不需交易員點任何卡片：`chart_get_state` → `data_get_ohlcv` ×2 → `quote_get` → `draw_shape` → `draw_list` → `capture_screenshot` → `pine_compile` → `draw_clear` → `chart_get_state`。防線仍有效：參數錯誤回 isError（實測 `shape: "horizontal_line"` 以外的形狀 → `shape 要是 horizontal_line / trend_line / arrow_mark`），沒有頁面 → isError。Pine 編譯 `{"ok":true,"removed_from_chart":true}`，編譯完自動從圖上拿掉，圖例不殘留「mcp smoke」。

---

## Fact Annex（Opus 試作時逐一確認，2026-10-21）

| 事實 | 證據 |
|---|---|
| `checkToolCall`, `describeAction`, `msToTaipei`, `taipeiToMs`, `TIMEFRAMES`, `ChartSnapshot` exported | `src/services/ai-assistant/tools.ts` |
| `applyAction(ctx, action, snapSymbol): string \| null` exported, pure (no registration side effect) | `src/pages/aiAssistantPanel.ts` |
| `ShioajiVelaProvider#getBars(ticker, timeframe, { from, to, limit })` | `src/services/shioaji/velaProvider.ts:186` |
| `lookbackMs(timeframe)` exported; `RATING_BAR_LIMIT = 300` | `src/pages/techRating.ts:16,59` |
| `screenshot()` lives on `chart.renderer` (`RendererControl`), NOT on `chart` | `node_modules/@luxalgo/vela/dist/contributions-BY3zSYiZ.d.ts:1138,1187`（tsc caught this during the trial） |
| `chart.runScript(source)` never rejects; `{ ok, run, error, remove() }`; `run.plots`, `run.warnings[].message` | same file `:687-705`, `:98-102` |
| `IndicatorHandle.remove()`, `.context(select)` → `{ plots: Record<key, {time,value}[]> }` | same file `:306-420`, `:210-246` |
| `DrawingsControl.add/remove/all()`; `SerializedDrawing { id, type, anchors }` | same file `:1516`; `options-CSXbjMM5.d.ts:933` |
| `registerWidgetAttachment({ id, mount(ctx) => dispose })` | same file `:2047-2051`, `:2125` |
| Real `WidgetContext` is assignable to `McpChartCtx` **without a cast** | trial `tsc --noEmit` 0 errors with `runTool(current, …)` |
| `@modelcontextprotocol/sdk` not installed; `@types/node` not installed; `zod`, `ws` installed | `ls node_modules` |
| Claude Code 2.1.306 connects to `type: "http"` MCP; OMP `~/.omp/agent/mcp.json` already uses `type: "http"` entries | trial `claude -p --mcp-config` listed all 18 tools |
| Vite restarts when any config **dependency** changes, not only `vite.config.ts` | `node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:39272` `isConfigDependency` |
| Shioaji logs every kbars request as `path=/api/v1/data/kbars` | `logs/shioaji-stdout.log`（1458 lines on 2026-10-21） |
| Vite `server.middlewares.use("/__mcp", …)` also matches `/__mcp/bridge` → register sub-paths first | connect prefix matching; trial order worked |
| `/vela` page import line anchor exists | `src/pages/VelaPage.tsx:14` `import "./velaAiAssistant.ts";` |
| `vite.config.ts` anchors exist | `:4` `import path from "path";`、`:210` `plugins: [react(), guardLogPlugin(), aiChatPlugin()],` |

---

## Review Ledger

- 2026-10-21 18:25 Tasks 1–4: MiniMax (OMP `magpie-zen/minimax-m3.1-flash-free`) executed; Opus acceptance: 9/9 blocks IDENTICAL (`velaMcpClient.ts` absent as intended, Task 5), 4 files 44 passed, `tsc --noEmit` 0 errors, `vite.config.ts` / `VelaPage.tsx` untouched. Task 5 + Opus 驗收 deferred (night session).
- 2026-10-22 00:15 Task 5 + Opus 驗收（MiniMax, `magpie-zen/minimax-m3.1-flash-free`）: 使用者豁免夜盤時段限制（當晚未交易），Task 5 全部完成。**逐字比對 10/10 IDENTICAL**（`scripts/compare_plan.py`，含 `velaMcpClient.ts`）；`tsc --noEmit` 0 errors；4 檔 44 passed。Step 2/3 只各加 1 行（`VelaPage.tsx` 保留 CRLF、`vite.config.ts` 保留 LF）。Vite 自行重啟（`vite.config.ts changed, restarting server...`）。**Claude Code 2.1.306 實機（暫時 `--mcp-config`，未寫入使用者設定）10 步全通**：symbol `TSE:2330` 等於畫面商品、`draw_shape` 回 `id: dw-1`、圖上出現紅色水平線 2405 與「MCP測試」標籤（附截圖）、`pine_compile` → `{"ok":true,"removed_from_chart":true}`、`draw_clear` → `{"removed":1}`、收尾 `by_mcp: 0`。18 個工具、無下單工具。**兩項與計畫不符，已修正／記錄**：① 端點必須用 `http://localhost:5173/__mcp`（此機 Vite 只綁 IPv6 `::1`，`127.0.0.1` connection refused）；② 計畫 Step 4 的 kbars 閘門量測方式不可靠（閒置時底噪音 2 分鐘 +4～+8，遠大於 MCP 貢獻），改以「同一段時間內 MCP 呼叫造成的 delta」量測：20 次連續呼叫 → delta 0，TTL 過期後 1 次 → delta 1。

---

### Task 1: MCP 工具清單與 JSON-RPC 核心（純函式）

**Blocked by:** None, can start immediately

**Files:**
- Create: `src/services/vela-mcp/mcpTools.ts`
- Create: `src/services/vela-mcp/protocol.ts`
- Test: `src/services/__tests__/velaMcpProtocol.test.ts`

**Interfaces:**
- Consumes: nothing at runtime (the test imports `TIMEFRAMES` from `src/services/ai-assistant/tools.ts` to compare)
- Produces:
  - `mcpTools.ts`: `MCP_TIMEFRAMES`、`MCP_TOOLS: McpToolDef[]`（18 個）、`MCP_TOOL_NAMES: ReadonlySet<string>`、`PINE_TOOLS: ReadonlySet<string>`、`PINE_MAX_CHARS = 20_000`、`OHLCV_MAX_BARS = 300`
  - `protocol.ts`: `handleRpc(msg: unknown, callTool: CallTool): Promise<RpcResponse | null>`、`textResult(text: string, isError?: boolean): ToolResult`、`type ToolResult = { content: ToolContent[]; isError?: boolean }`、`type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>`、`PROTOCOL_VERSIONS`、`SERVER_INFO`

**Assumptions:** JSON-RPC batch arrays are rejected (-32600); Streamable HTTP 2025-06-18 dropped batching.

**Done when:**
- `npx vitest run src/services/__tests__/velaMcpProtocol.test.ts` → 9 passed
- `MCP_TIMEFRAMES` equals `TIMEFRAMES` from `ai-assistant/tools.ts`（test asserts it）
- `tools/list` names contain no `order|trade|buy|sell`（test asserts it）
- `tools/call` with `place_order` → JSON-RPC error `-32602`, callTool never invoked
- a message without `id` → `null`（HTTP 202 later）

- [ ] **Step 1: Write the test file exactly**, `src/services/__tests__/velaMcpProtocol.test.ts`

````ts
import { describe, expect, it, vi } from "vitest";
import { TIMEFRAMES } from "../ai-assistant/tools.ts";
import { MCP_TIMEFRAMES, MCP_TOOLS } from "../vela-mcp/mcpTools.ts";
import { handleRpc, PROTOCOL_VERSIONS, textResult } from "../vela-mcp/protocol.ts";

const never = vi.fn(async () => textResult("unused"));

describe("handleRpc", () => {
  it("initialize echoes a known protocol version and names the server", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, never);
    expect(r?.id).toBe(1);
    expect(r?.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "vela" }, capabilities: { tools: {} } });
  });

  it("initialize answers an unknown version with the newest one", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, never);
    expect((r?.result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it("a notification gets no response", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, never)).toBeNull();
  });

  it("tools/list returns every tool, and none of them places orders", async () => {
    const r = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, never);
    const tools = (r?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(tools.some((t) => /order|trade|buy|sell/i.test(t.name))).toBe(false);
  });

  it("tools/call passes name and arguments through", async () => {
    const call = vi.fn(async () => textResult("ok"));
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "chart_set_timeframe", arguments: { timeframe: "5" } } },
      call,
    );
    expect(call).toHaveBeenCalledWith("chart_set_timeframe", { timeframe: "5" });
    expect(r?.result).toEqual(textResult("ok"));
  });

  it("tools/call with an unknown tool is a JSON-RPC error, not a call", async () => {
    const call = vi.fn(async () => textResult("ok"));
    const r = await handleRpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "place_order" } }, call);
    expect(r?.error?.code).toBe(-32602);
    expect(call).not.toHaveBeenCalled();
  });

  it("a throwing tool becomes an isError result", async () => {
    const r = await handleRpc(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "quote_get", arguments: {} } },
      async () => {
        throw new Error("boom");
      },
    );
    expect(r?.result).toMatchObject({ isError: true });
  });

  it("rejects malformed messages and unknown methods", async () => {
    expect((await handleRpc([], never))?.error?.code).toBe(-32600);
    expect((await handleRpc({ jsonrpc: "1.0", id: 1, method: "ping" }, never))?.error?.code).toBe(-32600);
    expect((await handleRpc({ jsonrpc: "2.0", id: 7, method: "resources/list" }, never))?.error?.code).toBe(-32601);
    expect((await handleRpc({ jsonrpc: "2.0", id: 8, method: "ping" }, never))?.result).toEqual({});
  });
});

describe("mcpTools", () => {
  it("timeframes match the AI assistant's list (copied to keep vite.config deps inside vela-mcp/)", () => {
    expect([...MCP_TIMEFRAMES]).toEqual([...TIMEFRAMES]);
  });
});
````

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run src/services/__tests__/velaMcpProtocol.test.ts`
Expected: FAIL, `Failed to resolve import "../vela-mcp/mcpTools.ts"`

- [ ] **Step 3: Write `src/services/vela-mcp/mcpTools.ts` exactly**

````ts
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
````

- [ ] **Step 4: Write `src/services/vela-mcp/protocol.ts` exactly**

````ts
/**
 * Minimal MCP server core (JSON-RPC 2.0 over Streamable HTTP, JSON responses
 * only): initialize, ping, tools/list, tools/call. Hand-rolled because the
 * MCP SDK is not installed and this repo never runs `npm i`. Pure: the HTTP
 * side lives in bridge.ts, the chart side in handlers.ts.
 */
import { MCP_TOOL_NAMES, MCP_TOOLS } from "./mcpTools.ts";

export const SERVER_INFO = { name: "vela", version: "0.1.0" } as const;
/** Newest first; an unknown requested version gets the newest. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

type RpcId = string | number | null;
export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

const INSTRUCTIONS =
  "Vela 看盤（OpenCharts /vela）的圖表控制。只能看圖、切商品週期、畫線、加指標、跑 Pine，沒有下單。" +
  "時間一律用台北時間 YYYY-MM-DD HH:mm。台股紅漲綠跌。期貨只限微台 TMF／小台 MXF。" +
  "改圖的工具會回傳頁面讀回的實際狀態；回 isError 就是沒做成。";

export const textResult = (text: string, isError = false): ToolResult =>
  isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };

const err = (id: RpcId, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
const ok = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One JSON-RPC message → its response, or null for a notification (HTTP 202, no body). */
export async function handleRpc(msg: unknown, callTool: CallTool): Promise<RpcResponse | null> {
  if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return err(null, -32600, "Invalid Request");
  }
  if (!("id" in msg) || msg.id === undefined) return null;
  const id = msg.id as RpcId;
  const params = isObject(msg.params) ? msg.params : {};

  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !MCP_TOOL_NAMES.has(name)) return err(id, -32602, `Unknown tool: ${String(name)}`);
      const args = isObject(params.arguments) ? params.arguments : {};
      try {
        return ok(id, await callTool(name, args));
      } catch (e) {
        return ok(id, textResult(`工具執行失敗：${e instanceof Error ? e.message : String(e)}`, true));
      }
    }
    default:
      return err(id, -32601, `Method not found: ${msg.method}`);
  }
}
````

- [ ] **Step 5: Verify it passes**

Run: `npx vitest run src/services/__tests__/velaMcpProtocol.test.ts`
Expected: `Tests 9 passed (9)`

---

### Task 2: Shioaji 查詢閘門

**Blocked by:** None, can start immediately

**Files:**
- Create: `src/services/vela-mcp/barsGate.ts`
- Test: `src/services/__tests__/velaMcpBarsGate.test.ts`

**Interfaces:**
- Consumes: `OHLCV` type from `"@luxalgo/vela"`
- Produces: `createBarsGate(fetchBars: FetchBars, opts: BarsGateOptions): FetchBars`；`type FetchBars = (symbol: string, timeframe: string) => Promise<OHLCV[]>`；`BarsGateOptions { ttlMs; minGapMs; now?; sleep? }`

**Assumptions:** None

**Done when:**
- `npx vitest run src/services/__tests__/velaMcpBarsGate.test.ts` → 4 passed
- 10 concurrent calls for one symbol+timeframe → upstream fetched once
- 3 different charts → fetch starts at t = 0 / 2000 / 4000 ms, never 2 in flight
- a rejected fetch → next call fetches again (not cached)

- [ ] **Step 1: Write the test file exactly**, `src/services/__tests__/velaMcpBarsGate.test.ts`

````ts
import type { OHLCV } from "@luxalgo/vela";
import { describe, expect, it, vi } from "vitest";
import { createBarsGate } from "../vela-mcp/barsGate.ts";

const BAR: OHLCV = { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 };

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

describe("createBarsGate", () => {
  it("10 rapid calls for the same chart make one upstream fetch", async () => {
    const c = clock();
    const fetch = vi.fn(async () => [BAR]);
    const get = createBarsGate(fetch, { ttlMs: 30_000, minGapMs: 2_000, now: c.now, sleep: c.sleep });
    const all = await Promise.all(Array.from({ length: 10 }, () => get("TMFR1", "5")));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(all.every((b) => b[0] === BAR)).toBe(true);
  });

  it("different charts are fetched one at a time, at least minGap apart", async () => {
    const c = clock();
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    const fetch = vi.fn(async () => {
      starts.push(c.now());
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return [BAR];
    });
    const get = createBarsGate(fetch, { ttlMs: 30_000, minGapMs: 2_000, now: c.now, sleep: c.sleep });
    await Promise.all([get("TMFR1", "5"), get("TMFR1", "15"), get("2330", "D")]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
    expect(starts).toEqual([0, 2_000, 4_000]);
  });

  it("refetches after the TTL", async () => {
    const c = clock();
    const fetch = vi.fn(async () => [BAR]);
    const get = createBarsGate(fetch, { ttlMs: 30_000, minGapMs: 2_000, now: c.now, sleep: c.sleep });
    await get("TMFR1", "5");
    c.advance(29_999);
    await get("TMFR1", "5");
    expect(fetch).toHaveBeenCalledTimes(1);
    c.advance(1);
    await get("TMFR1", "5");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a failed fetch is not cached and does not jam the queue", async () => {
    const c = clock();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue([BAR]);
    const get = createBarsGate(fetch, { ttlMs: 30_000, minGapMs: 2_000, now: c.now, sleep: c.sleep });
    await expect(get("TMFR1", "5")).rejects.toThrow("429");
    await expect(get("TMFR1", "5")).resolves.toEqual([BAR]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
````

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run src/services/__tests__/velaMcpBarsGate.test.ts`
Expected: FAIL, `Failed to resolve import "../vela-mcp/barsGate.ts"`

- [ ] **Step 3: Write `src/services/vela-mcp/barsGate.ts` exactly**

````ts
/**
 * Every Shioaji history read an MCP tool makes goes through one gate: calls run
 * one at a time, a symbol+timeframe is reused for ttlMs, and two upstream
 * fetches are at least minGapMs apart. External agents loop on tools, and a
 * burst of kbars queries drops the Shioaji session (the watchdog cannot bring
 * it back) and eats the 500 MB daily quota. Failed fetches are not cached.
 */
import type { OHLCV } from "@luxalgo/vela";

export interface BarsGateOptions {
  ttlMs: number;
  minGapMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type FetchBars = (symbol: string, timeframe: string) => Promise<OHLCV[]>;

export function createBarsGate(fetchBars: FetchBars, opts: BarsGateOptions): FetchBars {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cache = new Map<string, { at: number; bars: OHLCV[] }>();
  let chain: Promise<unknown> = Promise.resolve();
  let lastFetch = Number.NEGATIVE_INFINITY;

  return (symbol, timeframe) => {
    const key = `${symbol}|${timeframe}`;
    const run = chain.then(async () => {
      const hit = cache.get(key);
      if (hit && now() - hit.at < opts.ttlMs) return hit.bars;
      const wait = lastFetch + opts.minGapMs - now();
      if (wait > 0) await sleep(wait);
      lastFetch = now();
      const bars = await fetchBars(symbol, timeframe);
      cache.set(key, { at: now(), bars });
      return bars;
    });
    chain = run.catch(() => undefined);
    return run;
  };
}
````

- [ ] **Step 4: Verify it passes**

Run: `npx vitest run src/services/__tests__/velaMcpBarsGate.test.ts`
Expected: `Tests 4 passed (4)`

---

### Task 3: 頁面端工具處理（讀圖、控制、畫圖、指標、截圖、Pine）

**Blocked by:** Task 1 (`textResult`, `ToolResult`, `OHLCV_MAX_BARS`, `PINE_MAX_CHARS`), Task 2 (`FetchBars` type)

**Files:**
- Create: `src/services/vela-mcp/handlers.ts`
- Test: `src/services/__tests__/velaMcpHandlers.test.ts`

**Interfaces:**
- Consumes: `checkToolCall`, `describeAction`, `msToTaipei`, `taipeiToMs`, `ChartSnapshot` (`ai-assistant/tools.ts`); `applyAction` (`pages/aiAssistantPanel.ts`); Task 1 and Task 2 exports
- Produces: `runTool(ctx: McpChartCtx, state: McpState, deps: HandlerDeps, name: string, args: Record<string, unknown>): Promise<ToolResult>`（never throws）；`createMcpState(): McpState`；`interface McpChartCtx`（the real `WidgetContext` is assignable to it without a cast）；`HandlerDeps { bars: FetchBars }`

**Assumptions:** `McpState` is per page load; after a reload MCP cannot remove what it drew earlier (it shows as `by_trader`). Accepted: the trader can still delete by hand.

**Done when:**
- `npx vitest run src/services/__tests__/velaMcpHandlers.test.ts` → 21 passed
- `draw_shape` with price `0`, `224` (vs ~22400 bars), time `"1761000000"`, or shape `"circle"` → `isError` and `drawings.add` never called
- `chart_set_symbol` `TXFK6` → `isError`, `setSymbol` never called
- `draw_remove_one` / `indicator_remove` on the trader's ids → `isError`; `draw_clear` leaves `user-1`
- no usable bars → `isError` result, not a thrown exception
- Pine: `pine_compile` calls `remove()` once; `pine_add` keeps it and tracks the id; empty or 20 001-char source → `isError` without calling `runScript`

- [ ] **Step 1: Write the test file exactly**, `src/services/__tests__/velaMcpHandlers.test.ts`

````ts
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
````

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run src/services/__tests__/velaMcpHandlers.test.ts`
Expected: FAIL, `Failed to resolve import "../vela-mcp/handlers.ts"`

- [ ] **Step 3: Write `src/services/vela-mcp/handlers.ts` exactly**

````ts
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
````

- [ ] **Step 4: Verify it passes**

Run: `npx vitest run src/services/__tests__/velaMcpHandlers.test.ts`
Expected: `Tests 21 passed (21)`

---

### Task 4: Vite 端 MCP 端點與頁面中轉

**Blocked by:** Task 1 (`handleRpc`, `textResult`, `PINE_TOOLS`)

**Files:**
- Create: `src/services/vela-mcp/bridge.ts`
- Test: `src/services/__tests__/velaMcpBridge.test.ts`

**Interfaces:**
- Consumes: Task 1 exports; `type Plugin` from `"vite"`
- Produces: `velaMcpPlugin(opts?: VelaMcpOptions): Plugin`（serves `/__mcp`, `/__mcp/bridge`, `/__mcp/result`）；`createVelaMcp(opts?)` → `{ rpc, bridge, result, call, connected }`；`isLocalRequest(req)`；`NO_PAGE`

**Assumptions:** Timeouts 15 s (tools) / 30 s (Pine); SSE keep-alive comment every 15 s; result body cap 16 MB (screenshots).

**Done when:**
- `npx vitest run src/services/__tests__/velaMcpBridge.test.ts` → 10 passed
- Host `evil.example` → 403; GET `/__mcp` → 405; bad JSON → `-32700`
- tool call with no page → `isError` with the `NO_PAGE` text (never success)
- page `close` → pending call resolves `isError` immediately; Pine timeout text contains 「重新整理」
- second page connection → first gets `event: replaced` and is ended; calls go to the new one

- [ ] **Step 1: Write the test file exactly**, `src/services/__tests__/velaMcpBridge.test.ts`

````ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVelaMcp, isLocalRequest, NO_PAGE, type BridgeReq, type BridgeRes } from "../vela-mcp/bridge.ts";

function req(method: string, body?: string, headers: Record<string, string> = { host: "127.0.0.1:5173" }, url = "/") {
  const handlers: Record<string, Array<(c?: unknown) => void>> = {};
  const r: BridgeReq & { emit(ev: string, c?: unknown): void } = {
    method,
    url,
    headers,
    on(ev, cb) {
      (handlers[ev] ??= []).push(cb);
      return r;
    },
    emit(ev, c) {
      for (const cb of handlers[ev] ?? []) cb(c);
    },
  };
  if (body !== undefined) {
    queueMicrotask(() => {
      r.emit("data", new TextEncoder().encode(body));
      r.emit("end");
    });
  }
  return r;
}

function res() {
  const r = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
    body: "",
    setHeader(k: string, v: string) {
      r.headers[k] = v;
    },
    write(c: string) {
      r.chunks.push(c);
    },
    end(c?: string) {
      r.ended = true;
      r.body = c ?? "";
    },
  };
  return r as BridgeRes & typeof r;
}

/** id null = a notification (no id field). */
const rpcBody = (method: string, params?: unknown, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });

/** The last command the page received over SSE. */
function lastCommand(page: ReturnType<typeof res>) {
  const data = page.chunks.filter((c) => c.startsWith("data: ")).at(-1)!;
  return JSON.parse(data.slice(6)) as { id: number; name: string; args: unknown };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isLocalRequest", () => {
  it("accepts loopback hosts with or without a same-host origin", () => {
    expect(isLocalRequest(req("GET", undefined, { host: "localhost:5173" }))).toBe(true);
    expect(isLocalRequest(req("GET", undefined, { host: "[::1]:5173" }))).toBe(true);
    expect(isLocalRequest(req("GET", undefined, { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" }))).toBe(true);
  });

  it("rejects a rebinding host and a foreign origin", () => {
    expect(isLocalRequest(req("GET", undefined, { host: "evil.example:5173" }))).toBe(false);
    expect(isLocalRequest(req("GET", undefined, { host: "127.0.0.1:5173", origin: "http://evil.example" }))).toBe(false);
    expect(isLocalRequest(req("GET", undefined, {}))).toBe(false);
  });
});

describe("createVelaMcp — /__mcp", () => {
  it("initialize answers JSON; a notification gets 202 with no body", async () => {
    const mcp = createVelaMcp();
    const r1 = res();
    await mcp.rpc(req("POST", rpcBody("initialize", { protocolVersion: "2025-06-18" })), r1);
    expect(r1.statusCode).toBe(200);
    expect(r1.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(r1.body).result.serverInfo.name).toBe("vela");
    const r2 = res();
    await mcp.rpc(req("POST", rpcBody("notifications/initialized", undefined, null)), r2);
    expect(r2.statusCode).toBe(202);
    expect(r2.body).toBe("");
  });

  it("GET is 405, a foreign host 403, bad JSON a -32700 error", async () => {
    const mcp = createVelaMcp();
    const g = res();
    await mcp.rpc(req("GET"), g);
    expect(g.statusCode).toBe(405);
    const f = res();
    await mcp.rpc(req("POST", rpcBody("ping"), { host: "evil.example" }), f);
    expect(f.statusCode).toBe(403);
    const b = res();
    await mcp.rpc(req("POST", "{not json"), b);
    expect(JSON.parse(b.body).error.code).toBe(-32700);
  });

  it("a tool call with no page open is an MCP error, not a success", async () => {
    const mcp = createVelaMcp();
    const r = res();
    await mcp.rpc(req("POST", rpcBody("tools/call", { name: "quote_get", arguments: {} })), r);
    const result = JSON.parse(r.body).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(NO_PAGE);
  });
});

describe("createVelaMcp — page bridge", () => {
  it("relays a call to the page and returns the page's answer", async () => {
    const mcp = createVelaMcp();
    const page = res();
    mcp.bridge(req("GET"), page);
    expect(page.headers["Content-Type"]).toBe("text/event-stream");
    const pending = mcp.call("chart_set_timeframe", { timeframe: "5" });
    const cmd = lastCommand(page);
    expect(cmd).toMatchObject({ name: "chart_set_timeframe", args: { timeframe: "5" } });
    const answer = { content: [{ type: "text", text: "done" }] };
    const r = res();
    await mcp.result(req("POST", JSON.stringify({ id: cmd.id, result: answer })), r);
    expect(r.statusCode).toBe(204);
    await expect(pending).resolves.toEqual(answer);
  });

  it("times out with an error; Pine timeouts mention the frozen page", async () => {
    vi.useFakeTimers();
    const mcp = createVelaMcp({ timeoutMs: 1_000, pineTimeoutMs: 5_000 });
    mcp.bridge(req("GET"), res());
    const quick = mcp.call("quote_get", {});
    const pine = mcp.call("pine_add", { source: "x" });
    await vi.advanceTimersByTimeAsync(1_000);
    const q = await quick;
    expect(q.isError).toBe(true);
    await vi.advanceTimersByTimeAsync(4_000);
    const p = await pine;
    expect(p.isError).toBe(true);
    expect((p.content[0] as { text: string }).text).toContain("重新整理");
  });

  it("a page disconnect fails pending calls at once", async () => {
    const mcp = createVelaMcp();
    const pageReq = req("GET");
    mcp.bridge(pageReq, res());
    const pending = mcp.call("quote_get", {});
    pageReq.emit("close");
    expect((await pending).isError).toBe(true);
    expect(mcp.connected()).toBe(false);
  });

  it("the newest tab wins; the old one is told it was replaced", async () => {
    const mcp = createVelaMcp();
    const oldPage = res();
    const oldReq = req("GET");
    mcp.bridge(oldReq, oldPage);
    const newPage = res();
    mcp.bridge(req("GET"), newPage);
    expect(oldPage.chunks.some((c) => c.startsWith("event: replaced"))).toBe(true);
    expect(oldPage.ended).toBe(true);
    oldReq.emit("close");
    expect(mcp.connected()).toBe(true);
    void mcp.call("quote_get", {});
    expect(lastCommand(newPage).name).toBe("quote_get");
  });

  it("rejects malformed results and unknown ids do nothing", async () => {
    const mcp = createVelaMcp();
    const bad = res();
    await mcp.result(req("POST", JSON.stringify({ id: "1" })), bad);
    expect(bad.statusCode).toBe(400);
    const unknown = res();
    await mcp.result(req("POST", JSON.stringify({ id: 999, result: { content: [] } })), unknown);
    expect(unknown.statusCode).toBe(204);
  });
});
````

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run src/services/__tests__/velaMcpBridge.test.ts`
Expected: FAIL, `Failed to resolve import "../vela-mcp/bridge.ts"`

- [ ] **Step 3: Write `src/services/vela-mcp/bridge.ts` exactly**

````ts
/**
 * Dev-server side of the Vela MCP server (wired into Vite by velaMcpPlugin).
 *
 *   MCP client ──POST /__mcp (JSON-RPC)──▶ Vite ──SSE /__mcp/bridge──▶ /vela page
 *                                           ◀──POST /__mcp/result────── (handlers.ts)
 *
 * The chart lives in the browser, so a tool call is relayed to the open /vela
 * page and the page's answer is returned. No page, a dropped page or a timeout
 * is an MCP error, never a success. The newest page connection wins.
 *
 * Only loopback Host headers are served: MCP clients send no Origin, so the
 * Host check is the DNS-rebinding defence on an endpoint that drives the chart.
 * Written against minimal req/res shapes (no @types/node in this repo).
 */
import type { Plugin } from "vite";
import { PINE_TOOLS } from "./mcpTools.ts";
import { handleRpc, textResult, type ToolResult } from "./protocol.ts";

export interface BridgeReq {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, cb: (chunk?: unknown) => void): unknown;
}

export interface BridgeRes {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}

export interface VelaMcpOptions {
  timeoutMs?: number;
  pineTimeoutMs?: number;
  keepAliveMs?: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RPC_MAX_BODY = 1024 * 1024;
/** A chart PNG as base64 can be several MB. */
const RESULT_MAX_BODY = 16 * 1024 * 1024;

export const NO_PAGE = "Vela 頁面沒有開著或沒連上：請在瀏覽器開 http://localhost:5173/vela 後再試";

function header(req: BridgeReq, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function hostname(hostPort: string): string {
  return hostPort.startsWith("[") ? hostPort.slice(0, hostPort.indexOf("]") + 1) : hostPort.split(":")[0]!;
}

/** Loopback Host, and a same-host loopback Origin when one is sent. */
export function isLocalRequest(req: BridgeReq): boolean {
  const host = header(req, "host");
  if (!host || !LOCAL_HOSTS.has(hostname(host))) return false;
  const origin = header(req, "origin");
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host === host && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function readBody(req: BridgeReq, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    let body = "";
    let size = 0;
    let tooLarge = false;
    // Streaming decode: a multi-byte character (繁中 in Pine sources) can straddle two chunks.
    const dec = new TextDecoder();
    req.on("data", (chunk) => {
      if (tooLarge) return;
      const s = typeof chunk === "string" ? chunk : dec.decode(chunk as Uint8Array, { stream: true });
      size += s.length;
      if (size > max) {
        tooLarge = true;
        body = "";
        return;
      }
      body += s;
    });
    req.on("end", () => resolve(tooLarge ? null : body + dec.decode()));
  });
}

function end(res: BridgeRes, status: number, body?: string, type?: string): void {
  res.statusCode = status;
  if (type) res.setHeader("Content-Type", type);
  res.end(body);
}

interface Pending {
  resolve(r: ToolResult): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createVelaMcp(opts: VelaMcpOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pineTimeoutMs = opts.pineTimeoutMs ?? 30_000;
  const keepAliveMs = opts.keepAliveMs ?? 15_000;
  let page: BridgeRes | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function settle(id: number, r: ToolResult): void {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(r);
  }

  function failAll(msg: string): void {
    for (const id of [...pending.keys()]) settle(id, textResult(msg, true));
  }

  /** Relay one tool call to the page and wait for its answer. */
  function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!page) return Promise.resolve(textResult(NO_PAGE, true));
    const id = nextId++;
    const pine = PINE_TOOLS.has(name);
    const ms = pine ? pineTimeoutMs : timeoutMs;
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        const hint = pine ? "；如果 /vela 頁面卡住，是腳本太重凍結了頁面，請重新整理" : "";
        settle(id, textResult(`Vela 頁面 ${ms / 1000} 秒內沒回應${hint}`, true));
      }, ms);
      pending.set(id, { resolve, timer });
      page!.write(`data: ${JSON.stringify({ id, name, args })}\n\n`);
    });
  }

  /** POST /__mcp — the MCP endpoint (Streamable HTTP, JSON responses). */
  async function rpc(req: BridgeReq, res: BridgeRes): Promise<void> {
    if (!isLocalRequest(req)) return end(res, 403);
    if (req.url && req.url !== "/" && !req.url.startsWith("/?")) return end(res, 404);
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return end(res, 405);
    }
    const body = await readBody(req, RPC_MAX_BODY);
    if (body === null) return end(res, 413);
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      const parseErr = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
      return end(res, 400, JSON.stringify(parseErr), "application/json");
    }
    const reply = await handleRpc(msg, call);
    if (reply === null) return end(res, 202);
    end(res, 200, JSON.stringify(reply), "application/json");
  }

  /** GET /__mcp/bridge — the /vela page's command stream (SSE). */
  function bridge(req: BridgeReq, res: BridgeRes): void {
    if (!isLocalRequest(req)) return end(res, 403);
    if (req.method !== "GET") return end(res, 405);
    if (page) {
      page.write("event: replaced\ndata: {}\n\n");
      page.end();
      failAll("Vela 頁面換成另一個分頁，這個呼叫已取消，請重試");
    }
    const me = res;
    page = me;
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write("retry: 2000\n\n");
    const ping = setInterval(() => me.write(": ping\n\n"), keepAliveMs);
    req.on("close", () => {
      clearInterval(ping);
      if (page !== me) return;
      page = null;
      failAll("Vela 頁面中斷連線（重新整理或關閉了），這個呼叫沒有完成");
    });
  }

  /** POST /__mcp/result — the page's answer {id, result}. */
  async function result(req: BridgeReq, res: BridgeRes): Promise<void> {
    if (!isLocalRequest(req)) return end(res, 403);
    if (req.method !== "POST") return end(res, 405);
    const body = await readBody(req, RESULT_MAX_BODY);
    if (body === null) return end(res, 413);
    let msg: { id?: unknown; result?: ToolResult } | null = null;
    try {
      msg = JSON.parse(body);
    } catch {
      msg = null;
    }
    if (!msg || typeof msg.id !== "number" || !msg.result || !Array.isArray(msg.result.content)) return end(res, 400);
    settle(msg.id, msg.result);
    end(res, 204);
  }

  return { rpc, bridge, result, call, connected: () => page !== null };
}

export function velaMcpPlugin(opts: VelaMcpOptions = {}): Plugin {
  return {
    name: "vela-mcp",
    configureServer(server) {
      const mcp = createVelaMcp(opts);
      // Sub-paths first: connect's "/__mcp" prefix also matches them.
      server.middlewares.use("/__mcp/bridge", (req, res) => mcp.bridge(req as unknown as BridgeReq, res as unknown as BridgeRes));
      server.middlewares.use("/__mcp/result", (req, res) => void mcp.result(req as unknown as BridgeReq, res as unknown as BridgeRes));
      server.middlewares.use("/__mcp", (req, res) => void mcp.rpc(req as unknown as BridgeReq, res as unknown as BridgeRes));
    },
  };
}
````

- [ ] **Step 4: Verify it passes, then type-check**

Run: `npx vitest run src/services/__tests__/velaMcpBridge.test.ts`
Expected: `Tests 10 passed (10)`

Run: `npx tsc --noEmit`
Expected: no output (0 errors)

---

### Task 5: 接上 /vela 頁面與 Vite（**只在非交易時段**）

**Blocked by:** Task 3 (`runTool`, `createMcpState`), Task 4 (`velaMcpPlugin`)

**執行時段：** 13:45–14:55，或週末／休市日。夜盤 15:00–05:00 也算盤中（Never #8）。開工前先跑 `date` 確認；不在時段內就停在 Step 1 之前並回報。

**Files:**
- Create: `src/pages/velaMcpClient.ts`
- Modify: `src/pages/VelaPage.tsx`（一行 import）
- Modify: `vite.config.ts`（一行 import、`plugins` 陣列加一項）

**Interfaces:**
- Consumes: `runTool`, `createMcpState` (Task 3)；`createBarsGate` (Task 2)；`OHLCV_MAX_BARS` (Task 1)；`velaMcpPlugin` (Task 4)
- Produces: the running endpoint `http://localhost:5173/__mcp`

**Assumptions:** Vite 5173 is running (`netstat -ano | grep -E ':5173 .*LISTENING'`).

**Done when:**
- `npx tsc --noEmit` → 0 errors
- the 4 test files from Tasks 1–4 → 44 passed in one run（9 + 4 + 21 + 10）
- `logs/vite-dev.log` shows `vite.config.ts changed, restarting server`
- `curl` initialize on `http://127.0.0.1:5173/__mcp` → `serverInfo.name` = `vela`; a notification → `202`
- `curl` with Host `evil.example:5173` → `403`
- the executor stops after Step 6; the live page checks are Opus acceptance (next section), not this task

- [ ] **Step 1: Create `src/pages/velaMcpClient.ts` exactly**

````ts
/**
 * Connects the open /vela page to the dev server's MCP bridge (side effect,
 * imported once by VelaPage). External agents (Claude Code, OMP) call
 * http://localhost:5173/__mcp; the bridge relays each tool call here over SSE
 * and this page answers with what the chart shows (services/vela-mcp/).
 *
 * One EventSource per tab (module singleton); the newest tab wins on the
 * server side. The attachment only keeps the latest WidgetContext — its
 * getters resolve to the selected chart cell at call time.
 *
 * Import from "@luxalgo/vela/plugin", NOT the root barrel (separate module
 * instances — see velaPineEditor.ts header).
 */
import { registerWidgetAttachment, type WidgetContext } from "@luxalgo/vela/plugin";
import { ShioajiVelaProvider } from "../services/shioaji/velaProvider.ts";
import { createBarsGate } from "../services/vela-mcp/barsGate.ts";
import { createMcpState, runTool } from "../services/vela-mcp/handlers.ts";
import { OHLCV_MAX_BARS } from "../services/vela-mcp/mcpTools.ts";
import { textResult, type ToolResult } from "../services/vela-mcp/protocol.ts";
import { lookbackMs } from "./techRating.ts";

const provider = new ShioajiVelaProvider();
const bars = createBarsGate(
  (symbol, timeframe) => {
    const to = Date.now();
    return provider.getBars(symbol, timeframe, { from: to - lookbackMs(timeframe), to, limit: OHLCV_MAX_BARS });
  },
  { ttlMs: 30_000, minGapMs: 2_000 },
);
const state = createMcpState();

let current: WidgetContext | null = null;
let source: EventSource | null = null;

async function answer(id: number, name: string, args: Record<string, unknown>): Promise<void> {
  let result: ToolResult;
  try {
    result = current
      ? await runTool(current, state, { bars }, name, args)
      : textResult("圖表還沒準備好", true);
  } catch (e) {
    result = textResult(`工具執行失敗：${e instanceof Error ? e.message : String(e)}`, true);
  }
  await fetch("/__mcp/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, result }),
  }).catch(() => undefined);
}

function connect(): void {
  if (source) return;
  source = new EventSource("/__mcp/bridge");
  source.onmessage = (e) => {
    let msg: { id?: unknown; name?: unknown; args?: unknown };
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (typeof msg.id !== "number" || typeof msg.name !== "string") return;
    const args = typeof msg.args === "object" && msg.args !== null ? (msg.args as Record<string, unknown>) : {};
    void answer(msg.id, msg.name, args);
  };
  // Another tab took over: stop, so the two tabs do not keep stealing the bridge.
  source.addEventListener("replaced", () => {
    source?.close();
  });
}

registerWidgetAttachment({
  id: "opencharts.vela-mcp",
  mount(ctx) {
    current = ctx;
    connect();
    return () => {
      if (current === ctx) current = null;
    };
  },
});
````

- [ ] **Step 2: Register the client in `src/pages/VelaPage.tsx`**

Search anchor: `import "./velaAiAssistant.ts";`

Original (verbatim):

````ts
import "./velaAiAssistant.ts"; // 註冊「AI 副駕駛」側邊面板與頂列 "AI" 按鈕（side effect）
````

Replacement (verbatim; the original line stays, one line is added after it):

````ts
import "./velaAiAssistant.ts"; // 註冊「AI 副駕駛」側邊面板與頂列 "AI" 按鈕（side effect）
import "./velaMcpClient.ts"; // 連上 /__mcp 中轉，讓外部 AI（Claude Code／OMP）用 MCP 控制圖表（side effect）
````

Do not touch any other line of `VelaPage.tsx`.

- [ ] **Step 3: Wire the plugin into `vite.config.ts`** (this restarts the running Vite; Never #8)

Edit A. Search anchor: `import path from "path";`

Original (verbatim):

````ts
import path from "path";
````

Replacement (verbatim):

````ts
import path from "path";
import { velaMcpPlugin } from "./src/services/vela-mcp/bridge.ts";
````

Edit B. Search anchor: `plugins: [react(), guardLogPlugin(), aiChatPlugin()],`

Original (verbatim):

````ts
  plugins: [react(), guardLogPlugin(), aiChatPlugin()],
````

Replacement (verbatim):

````ts
  plugins: [react(), guardLogPlugin(), aiChatPlugin(), velaMcpPlugin()],
````

Do not touch any other line of `vite.config.ts`.

- [ ] **Step 4: Type-check and run the plan's tests**

Run: `npx tsc --noEmit`
Expected: no output

Run: `npx vitest run src/services/__tests__/velaMcpProtocol.test.ts src/services/__tests__/velaMcpBarsGate.test.ts src/services/__tests__/velaMcpHandlers.test.ts src/services/__tests__/velaMcpBridge.test.ts`
Expected: `Test Files 4 passed (4)`, `Tests 44 passed (44)`

- [ ] **Step 5: Endpoint smoke test (no page needed)**

```bash
tail -n 5 logs/vite-dev.log
curl -s -X POST http://127.0.0.1:5173/__mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:5173/__mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:5173/__mcp -H "Host: evil.example:5173" -H "Content-Type: application/json" -d '{}'
```

Expected: the log shows `vite.config.ts changed, restarting server`; the first response contains `"serverInfo":{"name":"vela"`; then `202`; then `403`.

- [ ] **Step 6: Report and stop**

Write `docs/superpowers/plans/2026-10-21-vela-mcp-server.report.md`: per task, the commands and verbatim output summaries. End the report with: 「vite.config.ts 已更新、Vite 已重啟：請在 /vela 分頁按 Ctrl+Shift+R。實機驗收由 Opus 做。」Do not run any MCP client and do not register the server anywhere (Never #10).

---

## Opus 驗收（不是執行者的 task；需要使用者的 /vela 分頁，在 Task 5 之後、非交易時段）

1. **逐字比對**：用 `compare_plan.py` 對 repo 實檔比對 10 段程式碼，全部 IDENTICAL；讀報告；重跑 Task 5 Step 4 的兩個指令。
2. **請使用者按 Ctrl+Shift+R**，看到 K 棒後再繼續（memory `vite-config-edit-breaks-open-vela`）。
3. **Claude Code 實機**（用暫時設定檔，不寫入使用者設定）：`<scratchpad>\vela-mcp.json` 內容是 `{ "mcpServers": { "vela": { "type": "http", "url": "http://127.0.0.1:5173/__mcp" } } }`，執行：

   ```bash
   claude -p "用 vela MCP 依序做，每步貼出工具回傳的原文：1) chart_get_state 2) data_get_ohlcv count=5 3) 再一次 data_get_ohlcv count=5 4) quote_get 5) draw_shape horizontal_line，price 用第 4 步的 last，bias bullish，text MCP測試 6) draw_list 7) capture_screenshot（只回報有沒有拿到圖） 8) pine_compile，source 是三行：//@version=6、indicator('mcp smoke')、plot(close) 9) draw_clear 10) chart_get_state" --mcp-config "<scratchpad>\vela-mcp.json" --strict-mcp-config --allowedTools "mcp__vela" --model haiku
   ```

   通過條件：1) 的 symbol 等於畫面上的商品；5) 回傳 `id`，圖上出現紅色水平線；7) 有拿到圖；8) `"ok": true`，圖例沒有留下「mcp smoke」；9) `removed: 1`；10) `by_mcp: 0`，`by_trader` 等於 1) 的值。
4. **閘門**：步驟 2–3 前後各記一次 `grep -c "path=/api/v1/data/kbars" logs/shioaji-stdout.log`，差值 ≤ 1。期間不要動圖表，因為圖表自己換商品或週期也會打 kbars。
5. **沒有頁面**：請使用者關掉 /vela 分頁，再用 `curl` 呼叫 `quote_get` → `"isError":true`，內容含「Vela 頁面沒有開著或沒連上」。
6. **OMP**：目前只確認過 `type: "http"` 的設定檔格式，OMP 還沒實際連過這個伺服器。`omp --help` 只有 `--config`（config.yml overlay），沒有單次 MCP 設定，所以要先取得使用者同意，才能在 `~/.omp/agent/mcp.json` 加 `"vela": { "type": "http", "url": "http://localhost:5173/__mcp" }` 實測。
7. 填各 D 區塊的 `Outcome:`、把 vela skill §5.1「為什麼不用 MCP」改成指向本計畫、寫進 Review Ledger。
8. **長期註冊由使用者決定**：Claude Code 用 `claude mcp add --transport http --scope user vela http://localhost:5173/__mcp`；OMP 見第 6 點。


## Phase 2（本計畫不執行）

- 下單提議工具：必須經訂單守門員 enforce 模式、`frontMonthCode("TMF")` 實際近月、確認卡片（見上一版計畫的 Phase 2 一節）。
- `symbol_search`（Shioaji 合約查詢）、replay、alert：等使用者提出。
- stdio 轉接：只有出現只支援 stdio 的客戶端時才做（D1 revisit trigger）。
