# 工單：strategy equity 差分覆蓋（diffcov，2026-10-17）

狀態檔：`.taskwf/state.diffcov.json`（`taskwf_gate.py --name diffcov`）。前一張工單 `wrapC 後續`（`.taskwf/state.json`，P0–P9 done、commit `45eb8b4`／`b63b7a8`）已完成交付，本工單不覆寫它。

## P0 需求定義

### 需求描述

A2 把 `SimCache.equity[b]` 改成「逐 bar 結清」語意後，只被一支隨機差分探針（`scratch/_r2-diff.mts`，1200 劇本）驗過，而該探針的呼叫面只有 `strategy.entry`／`close`／`order`＋4 種 `strategy.risk.*`。**未走過的路徑**：`strategy.exit` 的六個出場參數面、`oca_*`、`cancel`／`cancel_all`／`close_all`、`risk.max_position_size`／`risk.allow_entry_in`、多日界（`max_intraday_loss`／`max_intraday_filled_orders` 的日重置）。記帳語意改動的典型失效模式正是「沒被走過的第三條路徑」。

本工單把差分從一次性探針**產品化為常駐測試**，並把呼叫面擴到上述全部路徑；差分若冒真實不一致，就地修正或依規則裁決記帳。

### 驗收標準

| # | 標準 | 路由 |
|---|---|---|
| L1 | `npx vitest run src/pine/__tests__/strategy_equity_diff.test.ts` 全綠，且逐 bar 以 `Object.is` 比對（禁用 `toBeCloseTo`） | code |
| L2 | 覆蓋矩陣存在，且每一格都有對應 `it`：`exit`（`stop`／`limit`／`profit`／`loss`／`trail_price`／`trail_points`+`trail_offset`／`qty_percent`／`from_entry`）、`oca_name`/`oca_type`、`cancel`、`cancel_all`、`close_all`、`risk.max_position_size`、`risk.allow_entry_in`、多日界日重置 | jev |
| L3 | 全套回歸：`npx vitest run src/pine` ≥1025 passed｜1 skipped、四支 digest 逐字不變 | code |
| L4 | `npx tsc --noEmit` rc=0 | code |
| L5 | 突變自證：每個新覆蓋面至少一支「停用該面 ⇒ 測試轉紅」的臨時突變（不進 repo，證據存 QA 報告） | code |
| L6 | 差分若冒真實不一致，必須修正或經裁決記帳；不得放寬斷言、不得加 oracle 例外來掩蓋 | jev |
| L7 | 測試不得與被測邏輯共碼：oracle 必須是 frozen 副本（`shifted`+`simulate` from-scratch replay），不得呼叫新 stepper | jev |
| L8 | 決定性：同 seed 重跑同結果；不依賴系統時間／檔案順序／測試執行順序 | code |

### 非目標

- 不改 A2 的記帳語意設計本身（`strategy.ts` 的 settle 機制）；`max_cons_loss_days` 的讀取樣式相依已在前一工單裁決，**不在本工單重啟**。
- 不改 `task-workflow.md`／`taskwf_gate.py`／`jev-gate`（前一張工單的索取單已明文要求另開會話）。
- 不動第三工作流檔案（`src/pages/*`、`src/services/shioaji/*`、`src/services/nautilusClient.ts`、`src/pine/graphify-out/`、`scripts/*`）。
- 不提交 `scratch/` 探針；不做效能基準（`equityAt` 已刪，縮放議題自然消失）。
- 不新增依賴、不改 `vitest` 設定。

### 假設

1. frozen oracle（`shifted()` + `simulate()` from-scratch replay）仍是等價基準；stepper 測試檔頭宣告「DO NOT REFACTOR」是有效約定。
2. **已知界限**：oracle 內部呼叫產品碼 `simulate()`，所以本差分證明的是「stepper 與 replay 等價」，**不能**證明 `simulate()` 自身正確。此界限要寫進測試檔頭，不得含糊。
3. `risk.max_cons_loss_days` 是 oracle 的唯一例外（前一工單已裁決）；本工單的矩陣**不安裝**該規則，改由既有 pinned `it` 覆蓋。
4. 測試檔為新增檔 → 不動既有 `strategy_equity_stepper.test.ts` 的 frozen oracle（避免兩處漂移；必要時以 import 共用，但不改其內容）。

## P1 拆解

**大綱**：先把 harness 產品化（N1），再按 API 面切 4 條獨立覆蓋軌（N2–N5），全部落在同一支新測試檔 → **同檔序列寫，不併發**。

**依賴圖**：`N1 → {N2, N3, N4, N5}`；N2⊥N3⊥N4⊥N5（彼此不共用狀態，可序列執行）。`N6`（差分冒出的真實修正）只在 N2–N5 有 mismatch 時才存在。

| node | 內容 | 標記 |
|---|---|---|
| N1 | 新測試檔骨架＋共用 harness（`mkBars`／`mkRtCtx`／`callStrategy`／`ordersOf`／`recordedEquity`／`mismatches`／frozen oracle 副本） | known |
| N2 | `strategy.exit` 參數面：`stop`／`limit`／`profit`／`loss`／`trail_price`／`trail_points`+`trail_offset`／`qty_percent`／`from_entry` 的逐 bar 記帳 | unknown |
| N3 | `oca_name`／`oca_type`（含 one-cancels-all）跨 order 的影響在 stepper 下的表現 | unknown |
| N4 | `cancel`／`cancel_all`／`close_all` 對 pending 佇列與已結算 bar 的影響 | unknown |
| N5 | `risk.max_position_size`／`allow_entry_in`／多日界日重置在稀疏讀取下的行為 | unknown |
| N6 | （條件式）差分冒出的真實不一致修正＋回歸 | unknown |

**依賴/檔案**：新檔 `src/pine/__tests__/strategy_equity_diff.test.ts`；可能動 `src/pine/builtins/strategy.ts`（N6）；docs（QA 報告、交接）。估 nodes=6、files=3。
