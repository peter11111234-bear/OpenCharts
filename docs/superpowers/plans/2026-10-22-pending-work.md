# 未完成工作總表（2026-10-21 夜盤整理）

> 流程：Opus 先實作並測過 → 寫成 REAL PLAN（內嵌驗證過的程式碼）→ 使用者說「派」→ MiniMax 執行 → Opus 逐字驗收。
> 時段規則：重啟長駐程序只在 05:00–08:45 或 13:45–15:00；盤中不改 `vite.config.ts`；不 commit。

## A. 流量與資料（最優先，影響看盤）

| # | 工作 | 現況 | 下一步 | 時段 |
|---|---|---|---|---|
| A1 | 確認流量歸零時間 | 今日 531MB／500MB 超標 | 明早查 `GET :8080/api/v1/auth/usage`，記下幾點歸零 | 明早開盤前 |
| A2 | 補 tick 只補缺口（hotscan） | ✅ 已改：取消每 30 分鐘重抓、`--since` 只抓斷線後；已重啟看門狗。**RangeTime 未實打驗證** | 明天真打 1 次確認回傳正確 | 明天盤中 |
| A3 | 補 tick 完整版（REAL PLAN） | 設計已定，未實作 | scanner 收 tick 時記缺口（原始量 vs 累計量）→ 只補缺口、**補抓帳本防重複抓**、精準邊界、補不到不重試、流量保險絲（剩 <150MB 不補）、補的資料寫 `hot-ticks-backfill.jsonl` 不影響盤中判斷、backfill 不再讀 1.5GB 全檔；dashboard.py 合併邏輯要同步改 | Opus 試作＋測 → 派 MiniMax |
| A4 | 以前補的 1% 是真漏還是重複 | ✅ 2026-10-21 查完：6269 在 10–11 點補回 1,603 筆，其中 97%（1,560）是即時串流已經收過的重複資料，因為兩邊時間格式不同，去重沒認出來；真漏只有約 40 筆。`flow.py` 沒有去重，重複的會被重算一次，dashboard 的資金流因此偏多（scanner 的盤中訊號不受影響） | 歷史檔內已有的重複資料留著；A3 改成獨立檔後根除 |
| A5 | 期貨 tick 錄製器自動化 | ✅ `scripts/fop-tick-recorder.py` 已跑（手動啟動）；`/vela` 永豐回空時讀 `public/local-bars/` | 交給看門狗自動啟動／顧著 | 非開盤時段重啟看門狗 |
| A6 | 熱力圖／排行榜／報價列流量 | 熱力圖、排行榜 **30 秒不變**（使用者決定）；報價列每 5 秒打 snapshots；`index_components` 出現 429 | 量每輪用掉多少 bytes，只報告不改頻率 | 明天流量歸零後 |
| A7 | hot-ticks.jsonl 去重 | ✅ 乾淨檔已產生並通過獨立驗證：`logs/hot-ticks.dedup.jsonl`（刪 1,316,277 筆完全重複，佔 11.4%；只刪不改、刪的都有同 key 的保留行、新檔 0 重複、undated 70,978 筆全保留）。工具 `scripts/hotscan/dedup_ticks.py`＋`verify_dedup.py`＋`tests/test_dedup_ticks.py` | **換檔要使用者同意**：在 scanner 沒寫檔的時段做，舊檔改名留作備份 |
| A8 | 即時 tick 混入試撮／盤中零股？ | 去重後量÷交易所累計量的中位數仍是 1.095；累計量不變卻記了量的紀錄，盤中約每 5 秒一筆；hotscan／feed.ts 都沒過濾 `simtrade`、`intraday_odd` | **2026-10-22 09:00 後**抽原始 `tick_stk` 確認欄位；確認後才改（會影響 scanner 盤中判斷，修不修由使用者決定） |

## B. 看盤 bug

| # | 工作 | 現況 | 下一步 |
|---|---|---|---|
| B1 | FVG 高量 V1.41 在 K 棒很少時把圖變一條線 | ✅ 已修（2026-10-21）：腳本 133–134 行趨勢線初值 0. → na；使用者已貼上並確認 | — |
| B2 | 左上角週期選單點 1min 會「滑掉」 | 嫌疑：報價列每 5 秒重畫、錯誤與正常高度不同 → 版面重排 | 重現確認後固定報價列高度 |
| B3 | 兩個影響盤中判斷的資料問題（只回報，待使用者決定） | ① 漏接的量被灌進下一筆 tick → 假大單；② 2330 收盤後 14:30 重複記一筆 5574 張 | 使用者決定要不要修 |

## C. 期貨換月與 JEV

| # | 工作 | 現況 | 下一步 |
|---|---|---|---|
| C1 | Phase 2（看門狗＋jev-shadow 用券商近月、夜盤檢查） | ✅ MiniMax 完成、Opus 驗收通過；看門狗已重啟到新版 | jev-shadow 尚未重啟（非開盤時段重啟） |
| C2 | Phase 2b：jev-shadow 改追 MXF | ✅ 程式已改好、測過（2026-10-21 夜）：`resolve_front_month("MXF")`、MXF 寫獨立的 `logs/jev-shadow-mxf.jsonl`（`log_for`），`logged_bar_times(path)` 依檔案分開；volatile-review／phase0-report／preflight 有 MXF 檔就讀 MXF，否則退回 TXF 檔；新增 `tests/test_jev_mxf_dataset.py`；pytest 41 passed | **只剩重啟**：明天 13:45–15:00 透過 jev-shadow-watchdog 重啟，不碰 8080；重啟後確認 log 印出 `jev-shadow MXFK6: dataset=...jev-shadow-mxf.jsonl` |
| C3 | MXF 補數據（9/22–10/21） | 改用**期交所每筆成交資料**（免費、不吃永豐流量）較佳 | 確認下載格式與可抓天數 → 小量試補 → 全量 → 重算 P60，門檻由使用者決定 |
| C4 | 3b：夜盤缺合約自動補訂（實戰） | 模擬過、夜盤探測確認有在跑；補訂這條路還沒實際觸發 | **2026-10-22 夜盤 15:06 測**：`POST /api/v1/stream/unsubscribe` 取消 **MXFK6**（不動使用者交易的 TMF）→ 約 75 秒內 `scripts/watchdog.log` 應出現 `tick_fop partial ... missing MXFK6 — subscribing` → `tick_fop` 串流恢復 MXFK6 的 tick。必須在夜盤時段測（收盤後看門狗不檢查）。11/18 換月當晚再看一次 |

## D. AI 副駕駛

| # | 工作 | 現況 | 下一步 |
|---|---|---|---|
| D1 | 100 根 K 棒實測 | 今晚流量超標，測不準 | 明天流量正常後測 |
| D2 | 判斷副駕駛下一版 | 已規劃（記憶 `vela-ai-judgment-copilot-plan.md`） | 盤後實作：查資料工具、判斷卡、盤勢快檢 |
| D3 | MCP（A 唯讀／B 圖表控制） | 使用者未決定 | 等使用者決定 |

## 建議順序

1. 明早開盤前：A1、A4（不打 API）。
2. 明天盤中：A2 實打驗證、D1、A6 量測。
3. 明天 13:45–15:00：C2 實作＋重啟 jev-shadow、A5 交給看門狗；15:06 夜盤一開測 C4（3b）。
4. 盤後：A3 寫 REAL PLAN 派 MiniMax；B1、B2 修看盤 bug；C3 補數據。

## E. 2026-10-21 晚「K 棒不自己更新」後續

| # | 項目 | 狀態 |
|---|---|---|
| E1 | 根因：`VelaPage.tsx` 自 10-07 寫死 `live: false`。改為 `liveBarsEnabled()`（預設開，`localStorage vela-live=0` 可關）＋ `throttleBars` 每秒最多 1 根 | 已改、無頭實測 OK，待使用者 F5 確認 |
| E2 | 盤後 2330 沒 tick → feed 看門狗每 10 秒 `quiet streams: 2330 — resubscribing` 重送 subscribe（疑為今天 25,884 次 subscribe 的來源）。應只在該商品交易時段內判定 quiet | 待做 |
| E3 | Shioaji kbars 時間是「分鐘起點」還是「分鐘終點」？live/本機錄製都是起點；若 kbars 是終點會差一根。額度恢復後比對 | 待查（10-22） |
| E4 | `scripts/taifex-local-bars.py MXFK6 TMFK6`：期交所逐筆 → `public/local-bars/hist/`，流量超標時當歷史備援。每天下載新檔後要重跑；換月後代碼要換 | 已做，未排程 |
