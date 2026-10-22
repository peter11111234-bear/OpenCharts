# 期貨自動換月 Phase 2：看門狗與 jev-shadow 改用券商近月＋夜盤檢查（規劃）

> **日期：** 2026-10-21 規劃（設計層級，尚無程式碼）。實作照 myopenchart `agent-workflow.md`：Opus 試作驗證 → 本檔升級為 REAL PLAN（嵌入驗證過的程式碼）→ 使用者說「派」→ 執行 → Opus 驗收。
> **前置：** Phase 1（網頁）已完成：`src/services/shioaji/frontMonth.ts`、`src/pages/velaContractRoll.ts`（2026-10-21，未 commit）。

## 目標

三個會用到近月合約的地方（網頁、`scripts/shioaji-watchdog.ps1`、`scripts/jev-shadow.py`）用**同一個真相、同一套規則**決定近月，並且：
1. 結算日遇國定假日或臨時颱風假而順延時，跟著期交所走，不提早換錯。
2. 看門狗在**夜盤**也檢查期貨 tick，特別是換約當晚 15:00（新合約第一盤）。

## 現況（2026-10-21 讀程式碼確認）

| 地方 | 近月怎麼算 | 問題 |
|---|---|---|
| 網頁 | 券商 `TMFR1.target_code` 優先，規則備援，不一致警告 | ✅ 已完成 |
| `shioaji-watchdog.ps1` `Get-FrontMonth`（:130） | 純規則（15 號起第一個週三 13:45） | 不懂順延；**期貨 tick 檢查只在 08:50–13:45**（:383 `$fopInSession`），夜盤完全不看 |
| `jev-shadow.py` `front_month_symbol()`（:364），每輪重算（:608） | 純規則，追 `TXF` | 不懂順延；長駐程序，改檔後要重啟才生效 |

## 真相來源（已實測）

`GET http://127.0.0.1:8080/api/v1/data/contracts/{ROOT}R1/info` → `target_code`（券商認定近月）、`last_trading_date`（期交所最後交易日，順延會變）、`update_date`（每日更新）。2026-10-21 14:xx：`TMFR1→TMFK6`、`TMFR2→TMFL6`、`TMFJ6.last_trading_date=2026-10-21`。

## 統一判斷規則（三處一模一樣，對齊 `frontMonth.ts` 的 `pickFrontMonth`）

1. 8080 連不上 → 用規則，不警告。
2. `target_code` 或 `last_trading_date` 缺 → 用規則，警告「券商資料不完整」。
3. 現在 ≥ `last_trading_date` 13:45（券商資料過期未更新）→ 用規則，警告。
4. 否則用 `target_code`；與規則不同 → 警告「可能假日或颱風順延，以券商為準」。

**防三份實作各走各的：** 新增共用測試案例檔 `scripts/front_month_cases.json`（輸入 info / 規則碼 / 時間 → 期望 code / source / 是否警告），TS 測試、pytest、PowerShell `-SelfTest` 都讀同一份。

## 工作項目

### A. 看門狗 `shioaji-watchdog.ps1`
1. `Get-FrontMonth` → 新 `Resolve-FrontMonth($root)`：呼叫 R1 info（`-TimeoutSec 5`），照上面 4 條規則；結果快取 5 分鐘（迴圈每 15 秒一輪，不必每輪打 API）。
2. 不一致或資料過期 → `Log` ＋ `Send-Alert "換月提醒" ...`，同一訊息一天一次。
3. **夜盤檢查**：`$fopInSession` 擴成「日盤 08:50–13:45」或「夜盤 15:05–04:55」。夜盤歸屬：15:00 那段屬於「下一個交易日」，凌晨 00:00–05:00 是前一晚的延續。開不開夜盤用 `hotscan.tradingday`（已有的交易日判斷）決定，休市不誤報。
4. **換約當晚專檢**：結算日（或順延後的實際最後交易日）15:05 起，若 `tick_fop` 看不到新合約代碼 → 立即補訂＋`Send-Alert "換月後新合約沒有 tick"`。（沿用既有 `$fopMissing` 補訂邏輯，夜盤開了就自然涵蓋。）
5. `-SelfTest` 參數：讀 `front_month_cases.json` 跑判斷函式，印 PASS/FAIL 後結束（不進主迴圈）。

### B. `jev-shadow.py`
1. `front_month_symbol()` 改為先問 `TXFR1` info（`requests`／`urllib`，timeout 5s），照 4 條規則；結果快取 10 分鐘。
2. 不一致或過期 → 印出並寫進 `logs/jev-shadow-errors.jsonl`（`kind: "front_month"`），同訊息一天一次。
3. 換月時既有的 `front month rolled X -> Y` 印出保留。
4. pytest：`scripts/tests/test_front_month.py` 讀共用案例檔。

### C. 網頁（小補）
- `src/services/__tests__/frontMonthPick.test.ts` 也改讀共用案例檔，確保三處一致。

## 風險與待確認

| 項目 | 說明 | 處理 |
|---|---|---|
| 颱風假的交易日判斷 | `hotscan.tradingday` 讀的是**證交所**休市表；臨時颱風假不一定及時進表 → 夜盤檢查可能誤報「沒 tick」 | 告警文字附「若今天颱風停市可忽略」；不自動重啟 8080（只重訂閱） |
| 結算日前一晚宣布颱風假 | 券商資料要等下次每日更新才改 | 規則 3 會偵測「券商過期」並警告；網頁已有同樣警告 |
| 夜盤是否開市的細規則 | 假日前一晚的夜盤是否取消，需以期交所公告為準 | 試作時用歷史 tick 紀錄（`logs/` tick log）核對最近幾個假日前夜的實際情況 |
| 長駐程序重啟 | 看門狗、jev-shadow 改檔後要重啟才生效 | 只在完全不開盤的時段（05:00–08:45 或 13:45–15:00）重啟；重啟看門狗不碰 8080 |

## 時程與成本

- **時段：** 改檔＋重啟只能在 05:00–08:45 或 13:45–15:00。建議 **2026-10-22 13:45** 開始，15:00 前驗收。下次換月 2026-11-18。
- **Opus 試作驗證：** 約 1.5–2 小時（PS ＋ Python ＋共用案例＋夜盤邏輯）。
- **派工：** 同 AI 副駕駛流程（OMP `magpie-zen/minimax-m3.1-flash-free` 逐字照抄），或因檔案少、涉及長駐程序重啟，由 Opus 直接做完, , 由使用者決定。

## 驗收

1. `front_month_cases.json` 三處測試全過（vitest、pytest、`shioaji-watchdog.ps1 -SelfTest`）。
2. 模擬：`HOTSCAN_FAKE_TRADING_DAY` ＋ 假的 R1 回應（順延、過期、斷線）各跑一次，看 log／alert 內容。
3. 實戰：下一次夜盤 15:05 後，看門狗 log 出現夜盤 `tick_fop` 檢查紀錄；換月當晚（11/18）新合約 tick 檢查通過。

---

## Phase 2b：jev-shadow 改追小台 MXF ＋ 補數據（2026-10-21 使用者決定）

**為什麼：** 真正量大的是小台 MXF（大台一口金額高、量反而小），大單／量能判斷要看 MXF。

**關鍵限制（讀程式碼發現）：** `logged_bar_times()`（jev-shadow.py 約 :468）只用 `bar_time` 判斷「問過沒」，不分商品 → MXF 若寫進同一份 `jev-shadow.jsonl`，TXF 問過的時間點全被跳過、實際收不到。**所以 MXF 必須寫新檔**。

### 要改的地方（全部）

| # | 檔案 | 改什麼 |
|---|---|---|
| 1 | `scripts/jev-shadow.py` | 兩處 `resolve_front_month("TXF")`（約 :676、:702）→ `"MXF"`；`CONTRACTS` 補 `MXFK6`；紀錄檔依商品分流：`log_for(symbol)` → TXF 仍寫 `logs/jev-shadow.jsonl`（舊資料原封不動），MXF 寫 `logs/jev-shadow-mxf.jsonl`；`logged_bar_times()` 改讀對應檔；檔頭說明 TXF→MXF。錯誤檔 `jev-shadow-errors.jsonl` 共用（每行已帶 symbol）。 |
| 2 | `scripts/jev-volatile-review.py` | `DATA` 改讀 `jev-shadow-mxf.jsonl`。 |
| 3 | `scripts/preflight.ps1`（:53） | 新鮮度檢查改看 `jev-shadow-mxf.jsonl`，否則開工健檢會誤報「收集器沒寫檔」。 |
| 4 | `scripts/jev-phase0-report.py`（:7） | 報告來源改 MXF 檔（或加參數可選）。 |
| 5 | `scripts/tests/` | 新增：MXF 寫新檔、TXF 仍寫舊檔、`logged_bar_times` 不會跨商品互相跳過；既有 `test_jev_shadow_volatile.py`、`test_jev_front_month.py`、`test_jev_volatile_review.py`、`test_front_month_shared.py` 全過。 |
| 6 | 記憶／skill | `myopenchart` 待做清單與 P60 說明、vela skill 提到 jev-shadow 的地方：改成 MXF。 |

### 補數據（backfill）

- **工具現成：** `jev-shadow.py --symbol MXFJ6 --since 2026-09-22 --until 2026-10-21`（MXFJ6 自 9/16 13:45 起是近月，涵蓋和 TXF 舊資料同一段期間）。
- **量：** 約 1,300–1,600 根 5 分 K（看是否含夜盤；照舊資料的範圍）。
- **額度與速度：** sidecar 每日上限 2,000 次、付費通道每日 1,000 次。用 `--rate 6`（每分鐘 6 次）約 4 小時，不會把免費額度一次燒光（2026-10-16 的教訓）；同時夜盤即時收集也在用額度，所以**分兩天跑**或排在不開盤時段。
- **Shioaji：** 補數據要抓歷史 K 棒，依序抓、不並行（遵守「不可密集查詢」）。
- **補完後：** 立刻用 MXF 資料重算 P60，和現行 0.67 比較；**有了補回的資料，就不用等 20 個交易日**，檢討可以提前。門檻要不要改由使用者決定。

### 順序

1. MiniMax Phase 2 驗收通過。
2. Opus 依上表改 1–5，跑全部 jev 測試。
3. 不開盤時段重啟 jev-shadow（透過 `jev-shadow-watchdog.ps1`，不碰 8080）→ 開始即時收 MXF。
4. 不開盤時段跑 backfill（分批、`--rate 6`）。
5. 重算 P60 → 給使用者看報告 → 決定門檻。
