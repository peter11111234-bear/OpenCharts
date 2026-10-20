# Order Guard Phase 1 工單（2026-10-20）

> 依 `task-workflow.md` 執行。來源計畫：`docs/superpowers/plans/2026-10-19-order-guard-phase1.md`（1562 行，5 個 Task）。
> 閘門狀態檔：`.taskwf/order-guard-phase1.json`。階段產物：本檔（P0）、`docs/2026-10-20-order-guard-phase1-qa.md`（P7/P8）。

## P0 需求

在 OpenCharts 紙上交易終端加一個**確定性的進場／出場守門員**，並修掉 TXF 影子收集器「每根 bar 都 veto」的 bug。

四件事：

1. **Task 1（Python）**：`scripts/jev-shadow.py` 的波動率判定用子字串比對 legend，而 legend 文字永遠含 `"Volatile:"`，所以 61/61 根 bar 全被 veto、全被升級 DeepSeek（付費）。改成讀數值欄位（`score`、`probabilities["2"]`）。
2. **Task 2（TS）**：純規則模組 `src/services/guard/orderGuard.ts`，判斷每次進場與每次停損變更。不含任何 I/O。
3. **Task 3（TS）**：`src/services/guard/guardRuntime.ts` 把 `demoApi.placeOrder` / `demoApi.modifyPosition` 接上守門員，並把每個決策與每筆平倉寫進 `logs/order-guard.jsonl`。
4. **Task 4（Vite）**：dev middleware `POST /__guard-log` 落檔。
5. **Task 5（Python）**：`scripts/guard_report.py` 把決策 join 到平倉結果，印出各 verdict／各 rule 的虧損率，並印 `PHASE2_GATE: READY|NOT_READY`。

預設 `GUARD_MODE = "shadow"`：只記錄，永不改變任何訂單。

## P0 驗收標準（每條標 code｜jev）

| # | 驗收標準 | 類型 | 指令／判斷依據 |
|---|---|---|---|
| A1 | `scripts/jev-shadow.py` 的 gate 對 Normal regime（score 0.7、prob2 0.02）回 `approve`，對 score 1.6 回 rule `volatile` | code | `"$PY" -m pytest scripts/tests/test_jev_shadow_volatile.py -v` → 5 passed |
| A2 | `should_escalate` 對 Normal regime 回 `(False, '')`；對 score 1.0 仍回 `volatile environment` | code | 同上測試檔（`test_normal_regime_does_not_escalate`、`test_score_one_still_escalates`） |
| A3 | 檔內不再有 `'volatile' in vol_txt` 子字串比對 | code | `grep -c "'volatile' in vol_txt" scripts/jev-shadow.py` → `0` |
| A4 | `scripts/jev-shadow.py` 可編譯 | code | `"$PY" -c "import py_compile; py_compile.compile('scripts/jev-shadow.py', doraise=True)"` 無輸出 |
| A5 | Task 1 兩個檔案**不進版本控制**（使用者擁有該 commit） | code | `git status --short` 仍列兩檔為未提交 |
| A6 | `orderGuard.ts` 23 個單元測試全綠 | code | `npx vitest run src/services/__tests__/orderGuard.test.ts` → 23 passed |
| A7 | 冷卻跨午夜生效（23:58 虧損 → 00:01 進場被 veto `cooldown_after_loss`） | code | A6 內 `test_keeps_the_loss_cooldown_across_midnight` |
| A8 | 停損改 0／負數／NaN → veto `stop_invalid`；停損放寬 → veto `stop_widen` | code | A6 內 `checkStopChange` 區塊 |
| A9 | 規則丟例外 → veto 且 reason 以 `Rule failed:` 開頭（fail-closed） | code | A6 內 `test_fails_closed_when_a_rule_throws` |
| A10 | `guardRuntime.test.ts` 6 個測試全綠 | code | `npx vitest run src/services/__tests__/guardRuntime.test.ts` → 6 passed |
| A11 | shadow 模式無停損的進場**仍然成交**，且寫出一筆 verdict=veto 的 entry log | code | A10 內 `shadow mode logs a veto but still places the order` |
| A12 | enforce 模式無停損的進場**丟出** `Guard veto: Entry needs a stop-loss` 且不開倉 | code | A10 內 `enforce mode throws on a veto and opens nothing` |
| A13 | 平倉後寫出一筆 outcome，其 `openedAt` 等於 entry log 的 `positionOpenedAt` | code | A10 內 `logs the trade outcome with the entry's openedAt as join key` |
| A14 | `closePosition`／`closeAllPositions`／`cancelOrder`／`engine.mark()` **不在**守門員路徑上（Spec invariant） | code | `grep -n "closePosition\|cancelOrder\|closeAllPositions" src/services/guard/guardRuntime.ts` 只命中註解行；`src/services/demo/api.ts` 這四個方法未經守門員 |
| A15 | `GUARD_MODE` 仍是 `"shadow"`（Phase 2 才由使用者翻轉） | code | `grep -n "GUARD_MODE: GuardMode = " src/services/guard/orderGuard.ts` |
| A16 | dev server 活體：`POST {"kind":"probe"}` → 204 且檔案最後一行是該 JSON | code | `curl -s -o /dev/null -w "%{http_code}\n" -X POST …` → `204`；`tail -1 logs/order-guard.jsonl` |
| A17 | 非 JSON 物件的 body → 400，且行數不變 | code | `POST not-json` → `400`；`POST [1,2]` → `400`；行數 `unchanged` |
| A18 | `guard_report.py` 的 4 個測試全綠 | code | `"$PY" -m pytest scripts/tests/test_guard_report.py -v` → 4 passed |
| A19 | 兩個 partial outcome 的 P&L 會相加；沒有 outcome 的 entry 不計入 | code | A18 內 `test_join_sums_partials_and_skips_unmatched` |
| A20 | Phase 2 閘門需要樣本量且 flagged 虧損率要更差 | code | A18 內 `test_gate_needs_samples_and_a_worse_flagged_group` |
| A21 | 真實日誌上跑得出 `PHASE2_GATE:` 一行 | code | `"$PY" scripts/guard_report.py` |
| A22 | 全專案 typecheck 與既有測試與 baseline 相同（無新錯誤） | code | `npm run typecheck`；`npx vitest run src/services/__tests__/demo-contract.test.ts src/services/__tests__/demo-engine-resting-orders.test.ts` |
| A23 | 守門員的判斷品質符合計畫的語意意圖（規則之間的取捨是否符合 Endo 的 most-severe-wins） | jev | `taskwf-accept` 受管判斷 |
| A24 | 守門員對真實使用者的行為是安全的（不會擋住任何降低風險的動作） | jev | `taskwf-accept` 受管判斷 |

## P0 非目標

- Phase 2 的 `enforce` 模式上線（使用者手動翻 `GUARD_MODE`）。
- 台指期下單路徑接上守門員；`shioajiApi.placeLiveOrder` 接入。
- `demoApi.modifyOrder` 過守門員（Phase 2 前置，計畫已列為 4a）。
- 掛單（LIMIT/STOP）成交結果的 join（Phase 1 樣本只含市價單）。
- Pine alert 餵下單閘門、VELA 圖上的 R:R 框（跨頁，勘誤 1）。
- `scripts/jev-shadow-helpers.py`（計畫明令不改：它有重複的 `gate()`，收集器不 import）。
- `logs/` 目錄內容進版本控制。
- 修 `low_reliability_setup` 的 noul 讀取死碼（計畫 5a 附帶發現，Phase 1 不處理）。

## P0 假設

1. `scripts/jev-shadow.py` 可用 `importlib` 乾淨載入（計畫 2026-10-19 已驗證）。
2. 市價單在 `engine.placeOrder` 內同步成交；`openPosition` 把新部位推到陣列尾端，所以最新部位＝`engine.getPositions()` 最後一筆。
3. `engine.getLastPrice(symbol)` 在還沒 tick 時回 0，此時守門員用 `getSeedPrice(symbol)` 當判定基準（與 engine 的市價成交價一致）。
4. 排程器（`jev-shadow.py`）跑 5m 巡邏，不是 30s 輪詢；不需要 Scheduler。
5. 使用者用 `npm run dev` 開終端（port 5173、`strictPort: true`）。
6. 「今天」＝`ctx.now` 的本地日曆日（`toDateString`）；只套用於 `daily_loss` 與 `loss_streak`；`cooldown_after_loss` 讀最新一筆平倉（不限日期）。
7. 進場價未知（無 price 且 lastPrice 為 0）時，`stop_side` 與 `reward_risk` 略過，`stop_required` 仍適用。
8. 不安裝任何新的 npm 或 pip 套件。
9. `noUncheckedIndexedAccess: true` 開啟，索引存取回 `T | undefined`。

## Baseline（2026-10-20 15:26，執行前量測）

依計畫「Before Task 1, record the baseline once」。三段輸出逐字如下：

```
=== typecheck ===

> opencharts@0.1.0 typecheck
> tsc --noEmit

=== vitest two files ===
 ✓ src/services/__tests__/demo-contract.test.ts (4 tests) 10ms
 ✓ src/services/__tests__/demo-engine-resting-orders.test.ts (10 tests) 67ms

 Test Files  2 passed (2)
      Tests  14 passed (14)
   Start at  15:26:00
   Duration  14.95s (transform  3.12s, setup  1.70s, collect  9.49s, tests  77ms, environment 10.40s, prepare  1.22s)

=== git status ===
staged 0, unstaged 11, untracked 82
M docs/2026-10-17-wrapc-followup-workorder.md
M docs/superpowers/plans/2026-10-19-order-guard-phase1.md
M scripts/jev-shadow.py
M scripts/jev-sidecar-watchdog.ps1
M scripts/jev-sidecar.py
M scripts/preflight.ps1
M scripts/shioaji-watchdog.ps1
M scripts/start-trading-day.ps1
M src/pages/VelaPage.tsx
M src/services/shioaji/candles.ts
M src/services/shioaji/feed.ts
?? .archify/
?? .graphifyignore
?? .taskwf/
?? bench/
?? docs/2026-10-18-exploration-report.md
?? docs/2026-10-18-indicators-research-notes-1.html
?? docs/2026-10-20-order-guard-phase1-workorder.md
?? docs/notes/
?? graphify-out/
?? scratch/…（多筆未追蹤暫存）
```

結論：**typecheck 零錯誤**；兩個基準測試檔 **14 passed**。Task 3 Step 6 只比對這兩個檔與 typecheck。

注意：`src/services/demo/engine.ts`、`src/services/demo/api.ts`、`vite.config.ts` 在 baseline 的 `git status` 中**未出現**，即為乾淨檔（待 P2 探索確認）。

## P0 附記：advisor 模型切換（2026-10-20，使用者指示）

使用者要求把顧問模型改為 workbuddy 底下的 DeepSeek 4.1 Flash。已改 `~/.omp/agent/config.yml`：

- `modelRoles.advisor`：`commandcode-plan/commandcode-plan/xiaomi/mimo-v2.6-pro` → `workbuddy/workbuddy-ai/deepseek-v4.1-flash`
- `modelRoles.slow`：同上 → `workbuddy/workbuddy-ai/deepseek-v4.1-flash`（task-workflow 的 advisor 呼叫路徑是 `completion(prompt, model="slow")`，見 `docs/2026-10-17-followup-plan.md:152`）

驗證：`curl http://127.0.0.1:3425/v1/chat/completions`（model `workbuddy-ai/deepseek-v4.1-flash`）→ HTTP 200，內容 `PONG`；eval kernel `completion(..., model="slow")` → `ADVISOR-OK`。

還原法：`~/.omp/agent/config.yml` 內把 `advisor:` 與 `slow:` 兩行改回 `commandcode-plan/commandcode-plan/xiaomi/mimo-v2.6-pro`。

## P1 拆解

### 大綱

計畫已經是逐 Task、逐 Step、含逐字程式碼的定稿，所以 P1 的工作不是重新設計，而是**把計畫對映成可驗證的節點，並標出每個節點還不知道什麼**。

### 依賴圖

```
N1 (Task 1: jev-shadow volatile 修正)          ─┐ 獨立（Python，與 TS 無關）
                                                │
N2 (Task 2: orderGuard.ts 純規則)               ─┼─→ N3 (Task 3: guardRuntime 接線) ──→ N4 (Task 4: vite middleware)
                                                │        ↑ N2 的匯出是 N3 的輸入
N5 (Task 5: guard_report.py 報表)               ─┘ 獨立（只讀日誌格式，不讀 N3 的程式碼）
```

- N1 ⊥ N2 ⊥ N5（可並行）。
- N2 → N3 是唯一硬相依（`checkEntry`／`checkStopChange`／`GUARD_MODE`／`GuardMode`／`Decision`）。
- N3 → N4 軟相依：N4 的 live probe 需要 N3 的守門員在 dev server 上真的會 POST（否則探針只是測 middleware 本身）。N4 的 middleware 本身不 import N3。
- N5 ⊥ N3：N5 只讀 `logs/order-guard.jsonl` 的格式（計畫的「Log line format」段），不 import TS 程式碼。

### Node 清單

| node | 對應 Task | 內容 | known/unknown | 已知不確定點（要去查） |
|---|---|---|---|---|
| N1 | Task 1 | `scripts/jev-shadow.py` 兩處子字串比對改成 `_is_volatile()` 數值判斷；新增 `scripts/tests/test_jev_shadow_volatile.py`（5 test） | known（計畫給逐字程式碼） | 計畫的 anchor 文字是否仍與檔內一致（該檔有使用者的未提交改動） |
| N2 | Task 2 | `src/services/guard/orderGuard.ts` 8 條進場規則 + `checkStopChange`；`src/services/__tests__/orderGuard.test.ts`（23 test） | known（計畫給逐字程式碼） | `src/services/schemas.ts` 的 `Position`／`ClosedPosition` 欄位是否如計畫所述 |
| N3 | Task 3 | `src/services/guard/guardRuntime.ts`（含 outcome 訂閱 + `import.meta.hot?.dispose`）；`engine.ts` 的 `recordClose` 發 `closed-positions` 事件；`demo/api.ts` 的 `placeOrder`／`modifyPosition` 改走 runtime；`guardRuntime.test.ts`（6 test） | known（計畫給逐字程式碼） | `engine.ts` 的 `recordClose` anchor、`api.ts` 的三個 anchor、`bus.ts` 的 API 簽名、`candles.ts` 的 `getSeedPrice` 是否存在 |
| N4 | Task 4 | `vite.config.ts` 加 `guardLogPlugin()`；`POST /__guard-log` → `logs/order-guard.jsonl` | known（計畫給逐字程式碼） | `vite.config.ts` 現況（import 行、`plugins:` 行）、dev server 是否已在跑 |
| N5 | Task 5 | `scripts/guard_report.py`（`load`／`join`／`summarize`／`gate` + CLI）；`scripts/tests/test_guard_report.py`（4 test） | known（計畫給逐字程式碼） | `logs/order-guard.jsonl` 是否存在、`scripts/tests/` 目錄不存在（需新建） |

節點數 5、檔案數 11 → `tier --nodes 5 --files 11` → **heavy**。故 P1 需 advisor。

### 未知收斂計畫

所有「已知不確定點」都是**一次唯讀探索可驗證**的事實（檔案內容、符號存在與否、埠狀態），不需第二輪探索。P2 會一次查完，P4 若無殘留 unknown 就 `skipped`。

### P1 修訂：切得更細（使用者 2026-10-20：「每個任務分得很粗」）

原 5 個 node 太粗。改成 **8 個 slice**，每個 slice 有自己的檔案邊界、自己的煙霧證據、可獨立驗證。同檔不併發。

| slice | 內容 | 檔案 | 相依 | 煙霧證據 |
|---|---|---|---|---|
| S1 | Task 1 完整（測試＋修正） | `scripts/tests/test_jev_shadow_volatile.py`、`scripts/jev-shadow.py` | — | `pytest scripts/tests/test_jev_shadow_volatile.py` → 5 passed |
| S2 | Task 2 完整（測試＋實作） | `src/services/__tests__/orderGuard.test.ts`、`src/services/guard/orderGuard.ts` | — | `vitest run src/services/__tests__/orderGuard.test.ts` → 23 passed |
| S3 | guard runtime 本體（測試＋實作） | `src/services/__tests__/guardRuntime.test.ts`、`src/services/guard/guardRuntime.ts` | S2 | `vitest run src/services/__tests__/guardRuntime.test.ts` → 6 passed |
| S4 | engine 發布平倉事件 | `src/services/demo/engine.ts` | — | `vitest run demo-contract + demo-engine-resting-orders` 仍綠（baseline 14 passed） |
| S5 | demoApi 接線 | `src/services/demo/api.ts` | S3、S4 | `vitest run demo-contract` 仍綠 |
| S6 | Vite middleware | `vite.config.ts` | — | `curl POST /__guard-log` → 204／400 |
| S7 | 報表（測試＋實作） | `scripts/tests/test_guard_report.py`、`scripts/guard_report.py` | — | `pytest scripts/tests/test_guard_report.py` → 4 passed |
| S8 | 端到端串接驗證 | 無新檔 | S1–S7 | typecheck 零錯＋全部相關測試綠＋`guard_report.py` 跑得出 `PHASE2_GATE:` |

執行波次（每波 ≤3 個代理，同檔不併發）：

```
W1: S1 ‖ S2 ‖ S7      （三個互不相干的檔案組）
W2: S3 ‖ S4 ‖ S6      （S3 需 S2 已完成；S4/S6 獨立）
W3: S5                （需 S3、S4）
W4: S8                （全專案驗證）
```

commit 邊界：S2、S3+S4+S5（可合併為 Task 3 一次 commit）、S6、S7 各一次；**S1 不 commit**（使用者擁有 `scripts/jev-shadow.py` 的 commit）。

## P2 探索結果（3 軸，唯讀；主 LLM 已抽驗關鍵行號）

三個 scout：可行性（anchor 核對）、風險邊界、模式盤點。

### 可行性：所有計畫 anchor **逐字存在**，無 MISSING／DIFFERENT

| anchor | 實際位置 |
|---|---|
| `def should_escalate(ans):`（唯一） | `scripts/jev-shadow.py:747` |
| `vol` / `vol_txt` / `low_rel` 三行塊 | `scripts/jev-shadow.py:756-758`（唯一） |
| `'volatile environment (score=%s prob2=%s)'` 行 | `scripts/jev-shadow.py:779` |
| `if 'volatile' in vol_txt:` | `scripts/jev-shadow.py:780`（should_escalate）、`:896`（gate）→ 修正後需為 0 |
| `if choice == 'flat':` | `scripts/jev-shadow.py:894` |
| `return 'veto', 0.0, 'volatile environment -> risk>=1', 'volatile'` | `scripts/jev-shadow.py:897`（唯一） |
| `function recordClose(pos: Position, qty: number, exitPrice: number, realized: number): void {` | `src/services/demo/engine.ts:255` |
| `import * as engine from "./engine.ts";` | `src/services/demo/api.ts:7` |
| `placeOrder:` / `modifyPosition:` | `src/services/demo/api.ts:147` / `:158` |
| `import { defineConfig } from "vite";` / `plugins: [react()],` | `vite.config.ts:1` / `:6` |

主 LLM 抽驗（實測輸出）：

- `engine.placeOrder` 的市價成交價：`const marketPrice = resting ? 0 : (lastPrice.get(input.symbol) ?? getSeedPrice(input.symbol));` → 計畫「未 tick 時退回 `getSeedPrice`」的假設**成立**。
- `getSeedPrice`：`src/services/demo/candles.ts:109-112`，回 `prices[prices.length - 1] ?? 0`。
- `getClosedPositions`：`src/services/demo/engine.ts:58-60`，`closed.map(...)`；`closed` 由 `unshift` 維護 → **新到舊**，與計畫假設一致。
- `subscribeChannel`：`src/services/demo/bus.ts:13-22`，回傳 unsubscribe closure → 支援 `import.meta.hot?.dispose`。
- `openPosition` 在 `positions.push(pos)`（`engine.ts:123`）→ **最新部位＝陣列最後一筆**，計畫假設成立。
- `src/services/guard/` 與 `scripts/tests/` 皆**不存在** → 皆為新建。

### 風險邊界（RiskScout）

1. **工作樹乾淨度**：Task 3／4 的目標檔 `src/services/demo/engine.ts`、`src/services/demo/api.ts`、`vite.config.ts`、`package.json` **全部乾淨**（`git status --porcelain -uall -- <paths>` 無輸出）。⇒ 用明確 `git add <paths>` 提交**不會**夾帶使用者改動。**絕對不可用 `git add -A`／`git commit -a`**（會掃進 `scripts/jev-shadow.py` 的 578 行使用者改動與 11 個已改檔）。
2. **既有守門員類程式碼**：`src/` 內 `grep -i '\bveto\b'` → **零命中**。既有的進場檢查只有 `engine.placeOrder` 的輸入驗證（`engine.ts:225-241`：quantity>0、price/stopPrice/takeProfit/stopLoss 有限、LIMIT/STOP 需正價、市價 > 0）——**那個 throw 已經存在**，所以 guard 是第二個 throw 來源，不改變「既有 throw 會變未處理 rejection」這件事。
3. **既有停損驗證缺口**：`engine.modifyPosition`（`engine.ts:322-336`）完全不驗證，原樣接受 0／負數／NaN／放寬／移除 → 這正是 `checkStopChange` 要補的洞，**無重疊**。
4. **下單路徑全數經過 `demoApi.placeOrder`**：`src/services/api.ts:115-120` 的 Proxy 不做攔截（`"placeOrder" in demoApi` 為真 → 直接回原方法）。五個 UI 呼叫點：`OrderPanel.tsx:125`（桌面）、`TradingPage.tsx:309`（圖表右鍵）、`:649`（手機一鍵）、`:656`（手機確認）、`WatchlistPanel.tsx:137`（自選快閃）。⇒ D1 選 C（包在 `demoApi`）**成立**。
   唯一繞過：`engine.placeOrder` 直接呼叫（測試用）與 `shioajiApi` 的 sim 分支（`shioaji/api.ts:53-55`），後者**全 repo 無人 import**（只有 `velaProvider.ts:5` 的註解提到）→ 目前不可達。
5. **`.catch` 覆蓋率（enforce 模式才有影響）**：
   - 有處理：`OrderPanel.tsx:124-151`（`onError` → toast）、`WatchlistPanel.tsx:137-150`（`mutate` + `onError`）、`PositionModifyDialog.tsx:102-118`（try/catch）、`TradingPage.tsx:262-278`（try/catch）。
   - **無 `.catch`（未處理 rejection）**：`OrderPanel.tsx:174`（無對話框路徑）、`TradingPage.tsx:682-697`（`OrderConfirmDialog.onConfirm`，`.then().finally()` 缺 `.catch`）。
   - **靜默吞掉**：`OrderPanel.tsx:153-156` 與 `TradingPage.tsx:647-650` 的 `.catch(() => {})` → **enforce 模式下被 veto 的一鍵單完全沒有使用者回饋**。
   - 這是**既有 bug**（engine 本身的 throw 就已經這樣），enforce 只是讓它更常發生。Phase 1 保持 shadow，**不擋任何東西**，故不修（計畫 4a 已列為 Phase 2 前置）。
6. **日誌慣例**：`logs/` 已存在且被 gitignore（`.gitignore:19-20` `# runtime artifacts` / `logs/`；`git check-ignore` 確認）。`logs/order-guard.jsonl` 尚不存在。Python 端既有慣例是 `open(path,"a",encoding="utf-8")` + `json.dumps(record, separators=(",",":"), ensure_ascii=False) + "\n"`（`scripts/hotscan/storage.py:12-16`、`scripts/jev-shadow.py:480-494`）；**Node 端 `src/` 內 `appendFile` 零命中** → middleware 會是第一個 Node JSONL 寫入者，無既有慣例可抄，但 `JSON.stringify` 與 Python 那套位元相容。
7. **pytest 慣例**：repo 內**沒有任何 Python 測試**、沒有 `conftest.py`／`pytest.ini`／`pyproject.toml`。`scripts/tests/` 是**第一個** Python 測試目錄。pytest 9.0.2 已裝在釘選的 3.12 直譯器上。**PATH 陷阱**：`where python` 先撞到 `C:\Users\bear9\.openharness-venv`（pandas 3.0.5，與釘選的 2.3.3 不同版）→ 一律用完整路徑 `"$PY"`。
8. **`jev-shadow.py` 的 import 副作用**：計畫宣稱「無 `main()` 外的副作用」**不完全成立**——`:713-717` 在模組層級呼叫 `load_env()`（唯讀兩個 `.env` 檔），且 `int(os.environ.get('DEEPSEEK_MAX_PER_DAY','150'))` 在該環境變數非整數時會在 import 期丟 `ValueError`。不寫檔、不連網。**測試仍可安全 import**（實測 pytest 可跑）。

### 模式盤點（PatternScout）

- 測試檔慣例：`import { describe, it, expect } from "vitest"` **顯式匯入**（即使 `globals: true`）；相對匯入**帶 `.ts` 副檔名**（`allowImportingTsExtensions: true`）；**永遠用 `describe`+`it`，不用 `test()`**；測試名是完整行為句；fixture 用模組層級 `function` 工廠 + `SCREAMING_SNAKE` 常數 + JSDoc 說明「為什麼這樣隔離」；**不使用 `vi.stubGlobal`**（repo 內零命中，用 `vi.fn()`／`vi.spyOn`／手動還原全域）。
- `vitest.config.ts:10` `environment: "jsdom"` 全域套用；`include: ["src/**/*.test.{ts,tsx}"]` → 計畫的兩個新測試檔會被自動收錄。
- `tsconfig.json`：`strict`/`noUncheckedIndexedAccess`/`noUnusedLocals`/`noUnusedParameters` 全開 → 索引取值要 `!` 或 `?? fallback`；未用參數要 `_` 前綴。
- Python 慣例：**只用 `print()`，不用 `logging`**；模組 docstring 說明「是什麼／為什麼／怎麼跑」；`snake_case`，私有加 `_` 前綴；`main() -> int` + `if __name__ == "__main__": raise SystemExit(main())`。
- `scripts/gen_jev_fixture.py:1-7` 是新小腳本的最佳範本（docstring + `import json` + `from pathlib import Path`）。

### P2 產出的三個新事實（影響實作，非計畫外）

1. `ClosedPosition.side` 是 `z.string()`（`schemas.ts:141`），**不是** `"LONG" | "SHORT"` union → 守門員程式碼不可對平倉紀錄假設 union。
2. `demoApi.cancelAllOrders` 是常數 stub（`api.ts`），不會到 engine → 「不擋撤單」這個不變式在 demo 模式是空的（不影響實作）。
3. `PositionModifyDialog.tsx:161-164` 已在 UI 顯示 R:R（1.0/2.0 分色），但**不阻擋** → 守門員的 1.5 門檻與 UI 的 1.0/2.0 分色是兩套並存門檻，非衝突但需在交付時說明。

## P3 卡點整合

### 受管 JEV `taskwf-verify`（10 條宣稱）

結果：`{"gate": "taskwf-verify", "n": 10, "bands": {"fail": 2, "pass": 4, "gray": 4}}`

| id | 宣稱 | JEV | 主 LLM 抽驗結果 |
|---|---|---|---|
| c1 | 所有 anchor 逐字存在 | **fail** 0.22 | **成立**。證據包過大導致 JEV 讀不完（`MAX_TEXT=3000` 截斷）。實測：`grep -c "^def should_escalate(ans):"` → 1；`grep -c "vol_txt = ' '.join"` → 2（:757、:891，符合計畫預期兩處都要改）；`grep -c "^function recordClose(pos: Position, qty: number, exitPrice: number, realized: number): void {"` → 1；`api.ts:7-8` import 兩行逐字一致；`:147`／`:158` 兩行逐字一致；`vite.config.ts:1-3` 與 `:6` 逐字一致。 |
| c2 | 未 tick 時退回 `getSeedPrice` | pass 0.87 | 成立（實測 `engine.ts:241`）。 |
| c3 | 最新部位＝陣列最後一筆 | gray 0.44 | **成立**。實測 `engine.ts:123 positions.push(pos)`；`getPositions()` 為 `positions.map(...)`，保序。 |
| c4 | 五條 UI 下單路徑全經 `demoApi.placeOrder` | **fail** 0.22 | **成立**。證據包過大。實測 `api.ts:114-119` Proxy 不做攔截（`if (prop in target) return target[prop]`）；呼叫點實測命中 `queries.ts:336`、`OrderPanel.tsx:125`、`TradingPage.tsx:309`、`:656`、`WatchlistPanel.tsx:137`（`:649` 為同一處的 `.catch` 尾巴，grep 形式不同但已由 RiskScout 逐行確認）。 |
| c5 | 四個目標檔乾淨 | pass 0.87 | 成立。 |
| c6 | shadow 模式不 throw，故未處理 rejection 路徑不可達 | gray 0.45 | **成立**。實測 `OrderPanel.tsx:154 doSubmit().catch(() => {});`、`TradingPage.tsx:649 .catch(() => {});`（皆為靜默吞掉）；`GUARD_MODE` 為 `"shadow"`，`enforce` 分支不進入。 |
| c7 | `logs/` 已 gitignore | pass 0.85 | 成立。 |
| c8 | repo 無 Python 測試基建 | gray 0.46 | **成立**。實測 `ls scripts/tests` → `No such file or directory`。 |
| c9 | `ClosedPosition.side` 是 `z.string()` | pass 0.93 | 成立。 |
| c10 | 平倉紀錄新到舊且帶 `openedAt` | gray 0.65 | **成立**。實測 `engine.ts:257 closed.unshift(`、`:268 openedAt: pos.openedAt,`。 |

**結論：10 條宣稱全部成立。** 兩條 fail 與四條 gray 皆因證據包長度導致 JEV 讀不完／語意推論不足，依 `task-workflow.md` P3 規則「含 file:line 的宣稱由主 LLM 程式抽驗，不丟 JEV」，已由上表逐條實測補齊。

### 受管 JEV `taskwf-blocker`（4 條卡點）

結果：`{"gate": "taskwf-blocker", "n": 4, "bands": {"decided": 4}}` —— 四條**全部 risk，零 blocker**。

| id | 卡點 | 分級 | 裁決 |
|---|---|---|---|
| b1 | enforce 模式的 throw 落在沒有 `.catch` 的呼叫點（`OrderPanel.tsx:174`、`TradingPage.tsx:686`），一鍵路徑（`OrderPanel.tsx:154`、`TradingPage.tsx:649`）靜默吞掉 | risk 0.98 | **不修**。這是既有 bug（engine 本身 `engine.ts:225/234/239/242` 就會 throw），Phase 1 維持 shadow 不 throw。計畫 §4a 已列為 Phase 2 前置。交付時明確告知使用者。 |
| b2 | `scripts/jev-shadow.py` 有 578 行使用者未提交改動，Task 1 改完不 commit | risk 0.98 | **照計畫不 commit**。理由：計畫明令（Step 7）該 commit 屬於使用者；使用者若要 review，我提供 `git diff scripts/jev-shadow.py`。 |
| b3 | Task 4 活體探針需要 dev server | risk 0.99 | **照計畫**：先查埠；埠被佔用就探針、不殺使用者的 server；埠空著才自己起背景 server 並在探針後停掉。 |
| b4 | `scripts/jev-shadow-helpers.py` 有同樣 bug 的重複副本，無人 import | risk 0.97 | **不動**。計畫明令不改（它 :42 引用未定義的 `datetime`/`TAIPEI`，本來就會 `NameError`；且無人 import）。交付時列入「已知殘留」。 |

### P3 結論

- 零 blocker。
- 四個 risk 的處置全部寫死在上面的裁決欄，且都在計畫範圍內，不需擴大範圍。
- 所有宣稱已由主 LLM 抽驗成立 → **無殘留 unknown node** → P4 可 `skipped`。

## P5 定稿計畫（REAL PLAN）

### P5.1 advisor P5 的裁決與修正

advisor（workbuddy deepseek-v4.1-flash）指出四類問題。裁決：

| advisor 指出 | 裁決 |
|---|---|
| **W2 有未宣告的契約相依**：S3 與 S6 必須同意端點路徑與 JSONL schema；S3 可能依賴 S4 的平倉形狀 | **採納**。① S3/S6/S7 的日誌格式**凍結**（見 P5.3），三者只能照抄。② **重排 W2：S4 移到 S3 之前**——`guardRuntime.test.ts` 的第三個案例要關倉並看到 outcome log，而 outcome log 來自 `engine.ts` 發的 `closed-positions` 事件。沒有 S4，S3 的測試必紅。 |
| S7 在 W1，無法做整合驗證 | **採納**。S7 只做純函式層（`load`／`join`／`summarize`／`gate`），整合驗證放 S8。 |
| middleware 的 body 解析、mount path、logs/ 建立可壞而測試仍綠 | **採納**。S6 有獨立活體探針（204/400/400/行數不變），S8 再跑真實鏈路。 |
| JSONL schema drift 會讓報表靜默 join 不到 | **採納**。格式凍結在 P5.3，並在 S8 驗證「一筆 entry + 一筆 outcome 真的 join 得到」。 |
| 影子模式的記錄若拋錯會改變下單行為 | **採納**。P5.4 寫成硬約束並在 S3 測試釘住。 |
| `package.json` 在提交集內卻無 slice 擁有它 | **事實澄清**：`package.json` **不被任何 slice 修改**，各 `git add` 也不含它。乾淨是為了「若被誤改要看得見」，不是要改它。 |
| Python 無測試基建，rootdir/venv 可能讓測試只在某個 cwd 通過 | **採納**。S1/S7 測試自帶 `sys.path.insert`，且一律用釘選的 `C:/Users/bear9/AppData/Local/Programs/Python/Python312/python.exe`（`where python` 會先撞到 `.openharness-venv`，pandas 版本不同）。 |
| 崩潰中斷寫會產生壞行，報表必須容忍 | **採納**（小改，見 P5.5）。 |
| close/reduce 意圖可能被誤判為進場 | **查核後不適用**：`demoApi.placeOrder` 只下新單，平倉走 `closePosition`／`closeAllPositions`（`engine.ts`），不經 `placeOrder`。已列入 S8 的檢查項。 |

### P5.2 執行波次（修正版）

同檔不併發；每波 ≤3 個 slice；每個 slice 附自己的煙霧證據。

```
W1: S1 ‖ S2 ‖ S7      三組檔案互不重疊
W2: S4 ‖ S6            S4 必須早於 S3
W3: S3                 需 S2（匯出）＋ S4（closed-positions 事件）
W4: S5                 需 S3（runtime）＋ S4
W5: S8                 全專案驗證（typecheck ＋ 相關測試 ＋ 真實鏈路）
```

commit 邊界（**只用明確路徑，絕不用 `git add -A`／`git commit -a`**）：

| commit | 檔案 | 時機 |
|---|---|---|
| C1 | `src/services/guard/orderGuard.ts`、`src/services/__tests__/orderGuard.test.ts` | S2 完成 |
| C2 | `src/services/guard/guardRuntime.ts`、`src/services/__tests__/guardRuntime.test.ts`、`src/services/demo/engine.ts`、`src/services/demo/api.ts` | S5 完成 |
| C3 | `vite.config.ts` | S6 完成 |
| C4 | `scripts/guard_report.py`、`scripts/tests/test_guard_report.py` | S7 完成 |
| — | `scripts/jev-shadow.py`、`scripts/tests/test_jev_shadow_volatile.py` | **不 commit**（使用者擁有該 commit） |

### P5.3 凍結契約：日誌線格式（S3 寫、S6 落檔、S7 讀）

三處**必須逐字一致**，任一處改動即為 defect。

寫入端（`guardRuntime.ts`）送出的 body = 這個物件：

```
{ "ts": "<ISO>", "mode": "shadow" | "enforce", ...事件欄位 }
```

三種事件：

```json
{"ts":"…","mode":"shadow","kind":"entry","intent":{"accountId":"…","symbol":"BTCUSD","side":"BUY","type":"MARKET","quantity":1,"stopLoss":98},"decision":{"verdict":"approve","quantity":1,"hits":[]},"orderId":"…","positionOpenedAt":"2026-10-19T02:00:00.000Z"}
{"ts":"…","mode":"shadow","kind":"stop_change","positionId":"…","symbol":"BTCUSD","from":98,"to":97,"decision":{"verdict":"veto","quantity":1,"hits":[{"rule":"stop_widen","verdict":"veto","reason":"…"}]}}
{"ts":"…","mode":"shadow","kind":"outcome","symbol":"BTCUSD","side":"LONG","openedAt":"2026-10-19T02:00:00.000Z","closedAt":"2026-10-19T03:00:00.000Z","realizedPnl":-12.5}
```

- `intent` 欄位 = `engine.PlaceOrderArgs` 原物件（**不做轉換**）。
- `decision.hits[]` = `{ rule, verdict, reason }`，`verdict` 只有 `"reduce" | "veto"`。
- `positionOpenedAt`：市價單＝新部位的 `openedAt`（ISO）；掛單（未成交）與被 veto 的單＝`null`。
- join key：`entry.intent.symbol == outcome.symbol` **且** `entry.positionOpenedAt == outcome.openedAt`。
- 中端點：`POST /__guard-log`，body 必須是 JSON **物件**；非物件（含陣列、壞 JSON）→ `400` 且不寫檔。

### P5.4 硬約束（違反即 defect）

1. **影子模式不得改變任何訂單**：`guardedPlaceOrder` 在 shadow 模式必須把**原始 payload 原封不動**交給 `engine.placeOrder`（只有 enforce 的 `reduce` 才改 quantity）。記錄失敗（fetch 拋錯、middleware 不可達）**不得**影響下單——`postGuardLog` 必須 `.catch(() => {})` 且不 `await`。
2. **不得擋降低風險的動作**：`closePosition`、`closeAllPositions`、`cancelOrder`、`cancelAllOrders`、`engine.mark()` 內的 SL/TP 成交，**一律不經守門員**。`checkStopChange` 允許停損移過現價（立即出場＝降風險）。
3. **`GUARD_MODE` 不得改成 `"enforce"`**（Phase 2 才由使用者翻）。
4. **`scripts/jev-shadow.py` 不得 commit**；**不得**動 `scripts/jev-shadow-helpers.py`。
5. **不得**用 `git add -A`／`git commit -a`／`git checkout`／`git restore`／`git stash`／`git reset`。
6. **不得**把守門員放進 `OrderPanel.tsx` 或 `OrderConfirmDialog`（一鍵模式會繞過對話框）。
7. **不得**新增 npm 或 pip 套件。
8. **不得**改 `vite.config.ts` 以外的設定檔；`vite.config.ts` 只加 middleware，不動既有 proxy／port／strictPort。

### P5.5 對原計畫的一處最小偏離（記錄理由）

`scripts/guard_report.py` 的 `load()` 改用 `try/except json.JSONDecodeError: continue` 跳過壞行，理由：**對齊 repo 既有慣例**（`scripts/jev-shadow.py:460-477` 的 `logged_bar_times()` 與 `scripts/hotscan/storage.py:49-58` 都如此），且崩潰中斷寫會留下半行 JSON，報表不該整份崩掉。計畫原本的 `load()` 直接 `json.loads` 會炸。

除此之外**不偏離計畫**：所有程式碼、測試、指令、提交訊息都照 `docs/superpowers/plans/2026-10-19-order-guard-phase1.md` 的逐字內容。

### P5.6 每個 slice 的步驟／驗證／回滾

| slice | 步驟 | 驗證 | 回滾 |
|---|---|---|---|
| S1 | ① 寫 `scripts/tests/test_jev_shadow_volatile.py` ② 跑測試確認紅 ③ 加 `_is_volatile` ④ 修 `should_escalate` ⑤ 修 `RiskSession.gate` ⑥ 跑測試＋py_compile＋grep | `pytest scripts/tests/test_jev_shadow_volatile.py -v` → 5 passed；`py_compile` 無輸出；`grep -c "'volatile' in vol_txt" scripts/jev-shadow.py` → 0；`grep -c "if choice in ('flat', 'hold'):"` → 1 | 檔案本來就有使用者的未提交改動，**不做 git 回滾**；出問題時只把本次改的三個 hunk 改回去（手動） |
| S2 | ① 寫 `src/services/__tests__/orderGuard.test.ts` ② 跑測試確認紅（解析不到 import） ③ 寫 `src/services/guard/orderGuard.ts` ④ 跑測試＋typecheck | `vitest run src/services/__tests__/orderGuard.test.ts` → 23 passed；`npm run typecheck` → 與 baseline 相同（零錯） | `git checkout --` 該兩個新檔（皆為新建，無使用者改動） |
| S4 | 改 `engine.ts` 的 `recordClose`：抽成 `const record: ClosedPosition = {...}`、`closed.unshift(record)`、加 `publish("closed-positions", { eventType: "PositionRealized", _entity: { ...record } })` | `vitest run demo-contract + demo-engine-resting-orders` → 仍 14 passed（baseline）；`npm run typecheck` → 零錯 | 該檔目前乾淨 → `git checkout -- src/services/demo/engine.ts` 安全 |
| S6 | 改 `vite.config.ts`：加 `import fs from "node:fs"`、`type Plugin`、`guardLogPlugin()`、註冊 | `npm run typecheck` → 與 baseline 相同（`vite.config.ts` 在 tsconfig include 之外）；活體探針 → 204 / `{"kind":"probe"}` / 400 / 400 / `unchanged` | 該檔目前乾淨 → `git checkout -- vite.config.ts` 安全 |
| S3 | ① 寫 `src/services/__tests__/guardRuntime.test.ts` ② 跑測試確認紅 ③ 寫 `src/services/guard/guardRuntime.ts` ④ 跑測試＋typecheck＋兩個 grep | `vitest run src/services/__tests__/guardRuntime.test.ts` → 6 passed；`grep -n "import.meta.hot?.dispose"` → 1 命中；`grep -n "closePosition\|cancelOrder\|closeAllPositions"` → 只命中註解行 | 該兩個檔皆為新建 → `git checkout --` 安全 |
| S7 | ① 寫 `scripts/tests/test_guard_report.py` ② 跑測試確認紅（ModuleNotFoundError） ③ 寫 `scripts/guard_report.py` ④ 跑測試＋py_compile＋真實日誌 | `pytest scripts/tests/test_guard_report.py -v` → 4 passed；`py_compile` 無輸出；`python scripts/guard_report.py` → 印出 `PHASE2_GATE:` | 兩個檔皆為新建 → 刪掉即可 |
| S5 | 改 `src/services/demo/api.ts`：加 import、`placeOrder`、`modifyPosition` 三處 | `vitest run demo-contract + demo-engine-resting-orders` → 仍 14 passed；`npm run typecheck` → 零錯 | 該檔目前乾淨 → `git checkout -- src/services/demo/api.ts` 安全 |
| S8 | 全專案驗證 | 見 P5.7 | — |

### P5.7 S8 端到端驗收（advisor 指定的最重要檢查）

advisor：「單元測試可能全綠，但 shadow 的端到端不變式仍是壞的。」故 S8 必須跑**真實鏈路**：

1. `npm run typecheck` → 零錯（與 baseline 同）。
2. `npx vitest run src/services/__tests__/orderGuard.test.ts src/services/__tests__/guardRuntime.test.ts src/services/__tests__/demo-contract.test.ts src/services/__tests__/demo-engine-resting-orders.test.ts` → 全綠。
3. `"$PY" -m pytest scripts/tests -v --tb=short` → 9 passed（Task 1 的 5 + Task 5 的 4）。
4. **真實鏈路**：起 dev server（埠空才起；已被佔用則不殺使用者的），用一個**一次性**腳本把 `fetch` 指向 `http://localhost:5173/__guard-log`（真實 middleware），走 `demoApi.placeOrder` 一次 → 確認 `logs/order-guard.jsonl` 恰好多一筆 `kind:"entry"`、engine 內多一個部位、**訂單內容與未接守門員時逐欄一致**（影子模式不得改單）→ 再 `closePosition` → 確認多一筆 `kind:"outcome"` → 跑 `python scripts/guard_report.py` → 確認那筆 entry **被 join 到**（loss_rate 分組出現 n≥1）。
5. `grep -n "GUARD_MODE: GuardMode = " src/services/guard/orderGuard.ts` → 仍為 `"shadow"`。
6. `git status --short` → 確認 `scripts/jev-shadow.py` 與 `scripts/tests/test_jev_shadow_volatile.py` **仍未提交**，且四個目標檔的改動只有本次內容。

### P5.8 預檢（開工前必做）

- [x] `npm run typecheck` 乾淨（baseline 已量測）
- [x] 兩個基準測試檔 14 passed（baseline 已量測）
- [x] 四個目標檔 `git status` 乾淨（P2 已驗）
- [x] `logs/` 已被 gitignore（P2 已驗）
- [x] 釘選的 Python 3.12 有 pytest 9.0.2（P2 已驗）
- [x] `getSeedPrice`／`getClosedPositions`／`subscribeChannel`／`publish` 存在且簽名相符（P2 已驗）
- [ ] 確認 `src/services/guard/` 與 `scripts/tests/` 仍不存在（避免覆蓋使用者後來放的東西）

### P5.9 全域設定變更清單

| 檔案 | 變更 | 原因 | 還原法 |
|---|---|---|---|
| `~/.omp/agent/config.yml` | `modelRoles.advisor`、`modelRoles.slow` → `workbuddy/workbuddy-ai/deepseek-v4.1-flash` | 使用者 2026-10-20 指示 | 改回 `commandcode-plan/commandcode-plan/xiaomi/mimo-v2.6-pro` |
| `docs/2026-10-20-order-guard-phase1-workorder.md` | 新增（流程產物） | task-workflow 工單 | 刪除 |
| `.taskwf/order-guard-phase1.json` | 新增（閘門狀態） | task-workflow 閘門 | 刪除 |

**沒有其他全域設定變更。** 沒有安裝任何套件。沒有改環境變數。沒有改 `package.json`／`tsconfig.json`／`vitest.config.ts`。

### P5.10 成本

- 零新增 API 費用。advisor 走 workbuddy 免費通道（~10/31）。
- pytest、vitest、tsc 全為本機既有工具。
- dev server 僅在需要活體探針時短暫起停。

## P6 執行紀錄

### W1（S1 ‖ S2 ‖ S7）— 已派出

| slice | 代理 | 檔案組 | 狀態 |
|---|---|---|---|
| S1 | `S1_JevShadowFix` | `scripts/jev-shadow.py` ＋ `scripts/tests/test_jev_shadow_volatile.py` | ✅ 完成（不 commit） |
| S2 | `S2_OrderGuard` | `src/services/guard/orderGuard.ts` ＋ `src/services/__tests__/orderGuard.test.ts` | ✅ 完成 |
| S7 | `S7_GuardReport` | `scripts/guard_report.py` ＋ `scripts/tests/test_guard_report.py` | ✅ 完成 |

三組檔案互不重疊，符合「同檔不併發」。每個 slice 的任務書都內嵌：計畫逐字程式碼、TDD 紅→綠要求、煙霧證據指令、專案慣例（`.ts` 副檔名匯入、`describe`+`it` 不用 `test()`、`noUncheckedIndexedAccess`、釘選的 Python 絕對路徑）、以及禁止事項（不 commit、不 `git add -A`、不動 `jev-shadow-helpers.py`、不裝套件）。

S7 額外加了一條計畫外的最小偏離（已在 P5.5 記錄並說明理由）：`load()` 跳過壞行 ＋ 一個釘住它的測試。

### W2（S4 ‖ S6）— 2026-10-20 18:58（關機後接續）

| slice | 檔案組 | 狀態 | 驗證 |
|---|---|---|---|
| S4 | `src/services/demo/engine.ts`（`recordClose`） | ✅ 完成 | `demo-contract` + `demo-engine-resting-orders` → 14 passed（與 baseline 同）；`npm run typecheck` 零錯 |
| S6 | `vite.config.ts`（`guardLogPlugin`） | ✅ 完成 | 活體探針 → `204` / `{"kind":"probe"}` / `400` / `400` / `unchanged` |

S4 把 `recordClose` 的 `closed.unshift({...})` 抽成 `const record: ClosedPosition = {...}` ＋ `closed.unshift(record)` ＋ `publish("closed-positions", { eventType: "PositionRealized", _entity: { ...record } })`。

S6 加 `import fs from "node:fs"`、`type Plugin`、`guardLogPlugin()`，只註冊 middleware，未動既有 proxy／port／strictPort。

### W3（W4）— S3 guardRuntime ＋ S5 api 接線 — 2026-10-20 19:05

| slice | 檔案組 | 狀態 | 驗證 |
|---|---|---|---|
| S3 | `src/services/guard/guardRuntime.ts` ＋ `src/services/__tests__/guardRuntime.test.ts` | ✅ 完成 | 紅：解析不到 import；綠：`vitest run guardRuntime.test.ts` → 6 passed |
| S5 | `src/services/demo/api.ts`（import ＋ `placeOrder` ＋ `modifyPosition`） | ✅ 完成 | 四檔聯測 → 43 passed；`npm run typecheck` 零錯 |

**計畫外最小偏離 #2（記錄理由）**：計畫逐字碼用 `(event as { _entity: ClosedPosition })._entity` 讀 bus 事件。本專案規則 `ts-no-inline-cast-access` 禁止 inline cast 取成員，故改用 `ClosedPositionSchema.safeParse()`（`src/services/schemas.ts` 已有 zod schema）驗證後取值。行為等價：驗證失敗時不寫 outcome 行（原本的 cast 不會失敗）。

### W5 — S8 端到端 — 2026-10-20 19:10

- `npm run typecheck` → 零錯。
- `vitest run` 四檔（orderGuard / guardRuntime / demo-contract / demo-engine-resting-orders）→ 43 passed。
- `python -m pytest scripts/tests -v` → 10 passed（Task 1 的 5 ＋ Task 5 的 5）。
- **真實鏈路**：dev server（5173，pid 10780）＋ 真實 middleware。一次性腳本 `src/services/__tests__/guard-e2e-scratch.test.ts` 走 `demoApi.placeOrder`（ETHUSD MARKET qty 2，stopLoss 1600，takeProfit 1900）→ `demoApi.closePosition`，確認：
  - `logs/order-guard.jsonl` 恰好多 2 行：1 筆 `kind:"entry"` ＋ 1 筆 `kind:"outcome"`；
  - shadow 模式訂單 payload 逐欄一致（`intent` 原樣：`quantity:2, stopLoss:1600, takeProfit:1900`）；
  - join key 成立：`outcome.openedAt == entry.positionOpenedAt`（`2026-10-20T11:10:52.366Z`）；
  - `realizedPnl` 為數字（0，於進場價出場）。
- `python scripts/guard_report.py` → `approve n=3 loss_rate=0.000 pnl=0.0` ／ `PHASE2_GATE: NOT_READY`（樣本不足，符合預期）。
- 一次性腳本已刪除，`scripts/tests/__pycache__/*.pyc` 已清。
- `grep -n "GUARD_MODE: GuardMode = " src/services/guard/orderGuard.ts` → `export const GUARD_MODE: GuardMode = "shadow";`（未翻 enforce）。
- `grep -n "closePosition\|cancelOrder\|closeAllPositions" src/services/guard/guardRuntime.ts` → 只命中 1 行註解。
- `grep -n "import.meta.hot?.dispose"` → 1 命中。

### 提交邊界（全部用明確路徑，無 `git add -A`）

| commit | 檔案 |
|---|---|
| `9e6932d` | `src/services/guard/orderGuard.ts`、`src/services/__tests__/orderGuard.test.ts` |
| `4b43061` | `scripts/guard_report.py`、`scripts/tests/test_guard_report.py` |
| `8c0675e` | `src/services/guard/guardRuntime.ts`、`src/services/__tests__/guardRuntime.test.ts`、`src/services/demo/engine.ts`、`src/services/demo/api.ts` |
| `ee95f55` | `vite.config.ts` |

`scripts/jev-shadow.py` 與 `scripts/tests/test_jev_shadow_volatile.py` **仍未提交**（使用者擁有該 commit）。

## P7 QA 驗收（2026-10-20 19:13–22:50，三輪）

QA 報告：`docs/2026-10-20-order-guard-phase1-qa.md`

- **Round 1（19:13–19:18）**：A1–A22 硬指標 22/22 通過；A23/A24 受管 JEV `taskwf-accept`（choice 題型，附程式碼原文）→ `most_severe_wins` 0.96、`exits_untouched_shadow_passthrough` 0.99。第一次用 noul 題型問了兩次都落在灰區（0.73/0.59、0.55/0.43），改 choice 題型（可由程式碼逐字核對的事實）後信心 0.96/0.99。
- **Round 2（22:03–22:06）**：P8 回修後重跑，全部通過。另修「日誌不存在時 `guard_report.py` traceback」（計畫 Step 4 預期輸出是「`PHASE2_GATE:` 一行或 `no log yet`」）。
- **Round 3（22:47–22:50）**：P8 Round 2 回修後重跑，全部通過。ROUND 3 是回頭重做上限，故不再派 reviewer，改由主 LLM 逐檔自查 + 實測，查出並修 2 項（body 上限用字元數而非位元組數；middleware 註記與實作不符）。

## P8 Code Review（2026-10-20 21:00–22:50，三輪）

heavy tier，3 個 reviewer 並行（正確性／安全／可維護性）。**共 13 項 Important、零 Critical**，全部實測確認並修正。

- **Round 1（7 項）**：`lossStreak` 分批平倉重複計數；進場路徑接受非正數停損；`entryOf` 對 LIMIT 用錯成交價；`guard_report.gate()` 不篩 mode；`join()` 遇畸形 entry KeyError；dev sink 對任何來源／方法／大小開放寫入且 `logs/` 可靜態讀取；`import.meta.hot?.dispose` 永不觸發導致 HMR 後 outcome 重複。
- **Round 2（4 項）**：`lossStreak` 聚合 key 缺 symbol；`join()` 的 hits 未過濾；`/logs/` 的 404 前綴檢查可繞過；body 上限只設旗標仍持續累積。
- **Round 3（2 項，主 LLM 自查）**：body 上限用字元數；註記與實作不符。

受管 JEV 分級（`taskwf_jev.py blocker --input`）：7/7 判為 `risk`（可繞過的風險，非 blocker），零 blocker。

### 安全邊界的最終實測

| 請求 | 結果 |
|---|---|
| `POST` 同源 JSON | 204 |
| `POST` `text/plain` + `Origin: http://evil.example` | **403** |
| `POST` `Origin: null`（sandbox iframe） | **403** |
| `GET /__guard-log` | **405** |
| `POST` 90 KB 多位元組 body | **413** |
| `POST` 200 KB ASCII body | **413** |
| `POST` `not-json` ／ `[1,2]` | **400** ／ **400** |
| `GET /logs/order-guard.jsonl` ／ `/./logs/…` ／ `/%6Cogs/…` ／ `/Logs/…` ／ `/logs%5c…` | 全部 **404** |
| `GET /` ／ `/src/main.tsx` ／ `/@vite/client` | 200（正常資源不受影響） |

## P9 交付（2026-10-20 22:55）

advisor 已問（`advisor P9`）。交付清單見 QA 報告與本 session 的最終回覆。

### 改過的設定

| 設定 | 原值 | 新值 | 還原法 |
|---|---|---|---|
| `~/.omp/agent/config.yml` 的 `modelRoles.advisor` / `slow` | `commandcode-plan/commandcode-plan/xiaomi/mimo-v2.6-pro` | `workbuddy/workbuddy-ai/deepseek-v4.1-flash` | 改回（使用者 2026-10-20 指示） |

### 提交清單（全部明確路徑，無 `git add -A`）

| commit | 內容 |
|---|---|
| `9e6932d` | `src/services/guard/orderGuard.ts` ＋ 測試 |
| `4b43061` | `scripts/guard_report.py` ＋ 測試 |
| `8c0675e` | `src/services/guard/guardRuntime.ts` ＋ 測試、`demo/engine.ts`、`demo/api.ts` |
| `ee95f55` | `vite.config.ts` |
| `53d1b55` | P8 Round 1 修正（8 檔） |
| `dd8329d` | 報表無日誌不崩潰 ＋ Round 2 QA |
| `6d885aa` | P8 Round 2 修正（5 檔） |
| `e526e26` | body 上限改用位元組數 ＋ Round 3 QA |
| `3d10de6` | Round 3 最終自查紀錄 |

### 仍需使用者動手

1. **重啟 `scripts/jev-shadow.py`**：修正未經實盤驗證。等跑完一個完整交易日（約 60 bars）後確認：規則計數器不再是 100% `volatile`，DeepSeek 觸發計數器不再每列都印 `volatile environment`。
2. **確認 `scripts/jev-shadow.py` 與 `scripts/tests/test_jev_shadow_volatile.py` 的 commit**（使用者擁有該 commit；測試在沒有修正時會失敗，兩檔必須同進一個 commit）。
3. **Phase 2 前累積樣本**：`PHASE2_GATE: NOT_READY`（approve n=1）。需 approve ≥ 20 筆、flagged ≥ 10 筆且 flagged 虧損率更差，才可把 `GUARD_MODE` 翻成 `"enforce"`。

## 開始實際下單前必修清單（Opus 審查，2026-10-21）

**狀態：#1–#5 已修（2026-10-21，使用者要求提前修）；#6 待實盤資料。**

- #1：`fillOrder` 把 `order.id` 傳進 `openPosition`，`PositionOpened` 事件帶上 `orderId`；runtime 記一筆 `kind:"fill"`，`guard_report.py` 用它補上掛單的配對鍵。
- #2：`tradingDay()` 以 15:00 為界（固定 +8 時區再加 9 小時），`daily_loss` 與 `loss_streak` 改用它。
- #3：`/__guard-log` 的 Origin hostname 限定 `localhost`／`127.0.0.1`／`[::1]`。實測：rebinding（Host 與 Origin 都是 evil.test）回 403、跨站回 403、localhost 與 127.0.0.1 回 204。
- #4：`guardedModifyOrder`。一般修改只跑訂單本身的規則（`checkOrderChange`：stop_required、stop_side、reward_risk），帳戶狀態規則不擋修改，因為不論改不改，掛單都已經在場上。加大口數視為新的進場，要跑全部規則；enforce 下判定 reduce 時保留原口數，不再砍半。
- #5：加密貨幣砍半；其他商品（期貨）向下取整，最少 1 口。
- 驗證：vitest 57 passed（新增 8 項）、pytest 16 passed、typecheck 零錯。
- 修正前的頁面要重新整理（F5），新的成交訂閱才會生效（globalThis 錨定）。

| # | 嚴重度 | 問題 | 位置 | 修法 |
|---|---|---|---|---|
| 1 | 🟠 開始收集前必修 | 掛單 LIMIT／STOP 成交後不會跟平倉結果配對（`positionOpenedAt` 永遠為 null），報表只看得到市價單，樣本偏向市價單；圖表快速下單與手機下單都走 LIMIT | `guardRuntime.ts` `guardedPlaceOrder`、`engine.ts` `fillOrder`／`openPosition` | `fillOrder` 把 `order.id` 傳進 `openPosition`，`PositionOpened` 事件帶上 `orderId`；runtime 訂閱後補記一筆 `kind:"fill"`（orderId → openedAt），`guard_report.py` 用 orderId 補上配對鍵。訂閱沿用 `globalThis` 錨定 |
| 2 | 🟡 | `daily_loss`、`loss_streak` 用本地日期 `toDateString()` 換日，夜盤跨午夜時會在盤中歸零 | `orderGuard.ts` `todaysClosed` | 改成交易日：**以 15:00 為界**（使用者 2026-10-21 確認：夜盤 15:00 到隔日 05:00、日盤 08:45 到 13:45，夜盤歸屬隔天的交易日）。台灣沒有日光節約，可用固定 +8 時區：`tradingDay = (t + 8h + 9h) 的 UTC 日期`。週五夜盤會被算成週六，與週一日盤分開，這點要記在註解 |
| 3 | 🟡 | `/__guard-log` 的同源檢查只比對 Origin 與 Host，擋不住 DNS rebinding；外掛中介層排在 Vite 6.4.3 內建 Host 檢查之前（`dep-*.js` 中 configureServer hook 先於 cors／host 驗證） | `vite.config.ts` `guardLogPlugin` | Origin 的 hostname 限定 `localhost`／`127.0.0.1`／`[::1]`，並保留原本的 host 比對 |
| 4 | ⚪ 翻 enforce 前必修（計畫 4a） | `demoApi.modifyOrder` 不經守門員；`OrderModifyDialog` 可把掛單停損清成 `null`、改價讓停損跑到錯邊，或加大口數繞過減碼 | `demo/api.ts`、`guardRuntime.ts` | 新增 `guardedModifyOrder`：把修改後的掛單組成 EntryIntent 重跑 `checkEntry`，記成 `kind:"order_modify"`（報表不計入），enforce 下 veto 就 throw |
| 5 | ⚪ 翻 enforce 前必修 | `reduce` 直接把口數砍半，期貨會變 0.5 口 | `orderGuard.ts` `decide` | 整數口數向下取整，最少 1 口（或依商品最小下單單位） |
| 6 | 備註 | DeepSeek 升級審查在 `score >= 1.0` 觸發。score 是三種狀態的加權平均，判定為 Normal 的 K 棒分數就在 1.0 附近，可能每天打滿 150 次付費呼叫 | `jev-shadow.py` `should_escalate` | 重啟收集器後先看 `logs/jev-shadow.jsonl` 的分數分布，再決定門檻 |

**另一項：** 上一節「仍需使用者動手」第 2 點說 `jev-shadow.py` 只需跟測試同進一個 commit，但它未提交的 diff 是 +559/−34 行，混有 10-16 的重試／限速機制、DeepSeek 升級審查、`RiskSession` 等多次對話的成果，不能當成單一修正提交。
