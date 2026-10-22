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
| A5 | 期貨 tick 錄製器自動化 | ✅ `scripts/fop-tick-recorder.py` 已跑（手動啟動）；`/vela` 永豐回空時讀 `public/local-bars/` | ✅ 2026-10-22 14:29 已寫進 `shioaji-watchdog.ps1`（`Get-FopRecorderProcs`／`Start-FopRecorder`，先找程序才啟動、60 秒冷卻）；實測手動結束後 30 秒內被拉起，8080 PID 未變、錄製器只有一支 |, |
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
| C4 | 3b：夜盤缺合約自動補訂（實戰） | ✅ 2026-10-22 15:42 通過：取消 MXFK6 後 21 秒看門狗 step 4 判定「missing MXFK6」→ 補訂 → 41 秒內 tick 恢復（用 AST 載入 shioaji-watchdog.ps1 正式函式的單次腳本，結束代碼 0）。注意：開著 /vela 時前端 feed.ts 看門狗約 25–30 秒內會先補回，直接取消再看 watchdog.log 會測不出 | 11/18 換月當晚再看一次 |

## D. AI 副駕駛

| # | 工作 | 現況 | 下一步 |
|---|---|---|---|
| D1 | 100 根 K 棒實測 | ✅ 數據面 2026-10-22 16:00 實測：`ShioajiVelaProvider.getBars(limit:100)` 5 分 K，2330 回 100 根（10-21 09:45 → 10-22 13:30），TMFR1 回 100 根（→ 夜盤 15:55）；一次呼叫送 2 個 kbars 請求、約 0.3MB／商品（載入時重疊範圍重複，見 index_components／kbars 重複問題）。**AI 對話實際回答未測**（要打 OMP 模型） | 有需要再測對話面 |
| D2 | 判斷副駕駛下一版 | 已規劃（記憶 `vela-ai-judgment-copilot-plan.md`） | 盤後實作：查資料工具、判斷卡、盤勢快檢 |
| D3 | MCP（A 唯讀／B 圖表控制） | 使用者未決定 | 等使用者決定 |

## F. 流量待修（2026-10-22 16:36–16:49 夜盤量測，未改程式；由使用者決定先修哪個）

量法：每 15 秒讀 `GET :8080/api/v1/auth/usage`（50 筆，813 秒，無瀏覽器開著）：合計 84 KB/分鐘；增量呈「約 40KB、約 1KB 交替」＝**每 30 秒一筆約 40KB**，與 `jev-shadow.py` 的 `--poll 30` 完全吻合（其餘來源合計 <5KB/分鐘）。

| # | 項目 | 每天浪費（估） | 狀態 / 修法 | 風險 |
|---|---|---|---|---|
| F1 | `jev-shadow.py` 每 30 秒重抓 3 日曆日 1 分 K（約 40KB，>99.9% 重複） | 修前約 115MB/天 → 修後約 11MB/天 | ✅ 2026-10-22 已修（84721e0）：只在新 5 分 K 完成後 10 秒起抓、最後一根 1 分 K 還沒到就同 bucket 重試最多 3 次、有未處理 bar 才每輪抓；重啟後實測穩態約 4KB/分鐘（修前 84KB/分鐘，約 −95%）。**F1b（147ce8f）**：使用者決定夜盤也每 5 分鐘判斷 → watchdog 加 `--all-sessions`；`market_open()` 用真實時段（日盤 08:45–13:45、夜盤 15:00–05:00、週六 05:00 至週一 08:45 休），抓取與判斷共用 `session_ok()`；風控計數（每日跟單上限 5、連虧 3、獲利保護）改依「交易日」重置（夜盤 15:00 起與隔天日盤同一交易日，同 orderGuard.ts tradingDay()；舊版整個行程只建一次、從不重置）；`jev-risk-recompute.py` 可離線重算已寫入紀錄的風控欄位（輸出新檔、不覆蓋原檔、不呼叫 /decide 或 DeepSeek）；紀錄新增 `session` 欄位；`jev-volatile-review.py` 日夜分開統計、20 日門檻只算日盤。重啟後窗口內 257 根歷史夜盤 K 棒會先補判斷（約 40 分鐘） | 假日沒有行事曆，假日仍每 5 分鐘抓一次（量小） |
| F1c | jev-shadow 風控計數的日夜規則（使用者選 A，2026-10-22） |, | ✅ e3c2dec：**跟單上限 5 次依「交易日＋時段（day／night）」分開計**（夜盤與隔天日盤各 5 次，夜盤用掉的不影響日盤）；**連虧 3 次停手、已實現損益（今日虧損）、+800 點獲利保護仍只依交易日合併**（夜盤賠的算進同交易日，同 orderGuard.ts tradingDay()）。`RiskSession.step()` 同時給即時迴圈與 `jev-risk-recompute.py` 使用，兩邊共用同一份程式碼。**注意：「5 次跟單上限分日夜」只是 shadow 模擬用的規則；真正的 orderGuard.ts 沒有次數上限。** 以後若要把次數上限加進真正的守門員，要另外決定。補判斷完成後要對整份 `jev-shadow-mxf.jsonl` 跑離線重算、給使用者看差異摘要，同意後備份再覆蓋 | 待：補完後重算＋使用者同意覆蓋 |
| F2 | `index_components`（加權 IX0001／櫃買 IX0043，340–415KB/次）同一秒多個元件各抓、30 秒輪詢 | 舊版開 /vela 2 分鐘 ≈ 7.5MB（≈ 225MB/小時）；d2f7758 已修（快取＋合併、只抓 309 檔、只在日盤更新），**修後實測未做**（要使用者 Ctrl+Shift+R＋日盤量） | 已修、待量 |, |
| F3 | /vela 載入時 kbars 送兩個重疊範圍（10-13→10-22 約 133KB 被 09-22→10-22 約 339KB 完全涵蓋）；`getBars(limit:100)` 一次也送 2 個請求（約 0.3MB/商品） | 每次載入約 0.13MB、一天視重載次數（通常 <2MB） | 未修；優先度低 |, |
| F4 | **OpenCode（opencode-go）API key 已過期**：`jev-sidecar.py` 免費通道 jev-zen 回 `401 api_key_expired`（2026-10-22 實測一次），所以今天免費 0 次、付費（jev-direct）全部由 TypeSafe 負擔（到 18:00 約 250 次，上限付費 1000/天） | 估每晚夜盤約 168 次＋日盤 61 次付費呼叫（約幾美分/天，未查帳單） | **2026-10-22 約 18:50 起 jev-zen 已恢復（付費停在 314 次、其後都走免費；應是使用者已換 key，未向使用者確認）。原處理方式**：到 OpenCode Console 建新 key，換進 `~/.local/share/opencode/auth.json` 的 `opencode-go`。換好之前每次判斷都先打一次必敗的免費通道再改走付費 |, |
| F4b | sidecar 對 401 不會記住失敗（只有 429 會進 `_RATE` 冷卻），每次 `/decide` 都重打一次必敗的免費通道 | 每次多一個失敗請求（延遲＋對 Zen 的無效呼叫） | **待改（等使用者換好 key 再決定要不要改）**：401/403 時暫時跳過免費通道一段時間（例如 30 分鐘），並把原因寫進 health | 低 |
| F5 | jev-shadow 重啟會讓風控計數（跟單上限／連虧／獲利保護）從 0 開始，但同一個交易日（夜盤＋隔天日盤）早先的決策已發生 → 重啟後的判斷與真正的訂單守門員不一致（2026-10-22 18:26 重啟後 21:10、21:15 兩根即是：原本 reduce、整日重算應為 veto） | 資料正確性，不是流量 | **待改**：啟動時用資料集裡同一交易日的紀錄重放建立 RiskSession（可重用 `jev-risk-recompute.py` 的重放邏輯）；現況靠離線重算補救 | 低 |

注意：以上 F1 是夜盤量測。**日盤**還有 scanner（SSE）、熱力圖（309 檔）、排行榜、報價列，流量會大得多，明天日盤要另外量一次（同樣 15 秒取樣）才能下結論。另外：`jev-shadow-mxf.jsonl` 目前只有日盤 bar（10-21、10-22 各 61 筆），夜盤沒有決策紀錄, , 若夜盤也要決策，需要使用者確認（`--all-sessions`）；方案 A 不依賴這點，夜盤也只會每 5 分鐘抓一次。

## 建議順序

1. 明早開盤前：A1、A4（不打 API）。
2. 明天盤中：A2 實打驗證、D1、A6 量測。
3. 明天 13:45–15:00：C2 實作＋重啟 jev-shadow、A5 交給看門狗；15:06 夜盤一開測 C4（3b）。
4. 盤後：A3 寫 REAL PLAN 派 MiniMax；B1、B2 修看盤 bug；C3 補數據。

## E. 2026-10-21 晚「K 棒不自己更新」後續

| # | 項目 | 狀態 |
|---|---|---|
| E1 | 根因：`VelaPage.tsx` 自 10-07 寫死 `live: false`。改為 `liveBarsEnabled()`（預設開，`localStorage vela-live=0` 可關）＋ `throttleBars` 每秒最多 1 根 | 已改、無頭實測 OK，待使用者 F5 確認 |
| E2 | 盤後 2330 沒 tick → feed 看門狗每 10 秒 `quiet streams: 2330 — resubscribing` 重送 subscribe（疑為今天 25,884 次 subscribe 的來源）。應只在該商品交易時段內判定 quiet | ✅ 2026-10-22 已修：新增 `tradingSession.ts` 的 `isQuotingNow`，`feed.ts` 只對「此刻應有行情」的商品判 quiet（股票 09:00–13:30；期貨 08:45–13:45＋15:00–隔日05:00；未含國定假日，假日仍會重訂）；待使用者 Ctrl+Shift+R 載入新版 |
| E3 | Shioaji kbars 時間是「分鐘起點」還是「分鐘終點」？ | ✅ 2026-10-22 查證：**kbars 標分鐘終點**（09:00–09:01 的成交標 09:01），我們的 live（`feed.ts`）、`fop-tick-recorder.py`、`taifex-local-bars.py` 標起點（同 TradingView）——不是永豐錯，是慣例不同，/vela 把兩種接在一起。證據：① 2330 10-21 kbars 無 09:00、首根 09:01＝09:00:07 開盤撮合（量 1748 吻合）；② tick 自算 09:00／09:01／13:24 分別＝kbars 09:01／09:02／13:25；③ MXFK6 對期交所逐筆：時間不動 583 根只 20 根同量，kbars −60s 後 583/583 同量；期貨日盤首根 08:46、末根 13:45。**規則不是一律 −60s**：股票 13:30 收盤集合競價（成交時間 13:30:00 整）起點標法也是 13:30，要保留不動。影響：`candles.ts` 歷史晚一分鐘、5 分 K 分錯格；`jev-shadow.py` `fetch_1m` 同樣錯位，已存的 `jev-shadow*.jsonl` 是用錯位 5 分 K 算的 | 待使用者同意後**收盤後**改：① `candles.ts` 讀入 −60s（股票 13:30 例外）＋測試 09:01→09:00、13:25→13:24、13:30 不變；② `jev-shadow.py` 同規則，舊資料是否重算另議；③ 改完使用者 Ctrl+Shift+R |
| E4 | `scripts/taifex-local-bars.py MXFK6 TMFK6`：期交所逐筆 → `public/local-bars/hist/`，流量超標時當歷史備援 | ✅ 2026-10-22：新增 `scripts/taifex-daily-update.py`（下載最近 6 個平日的 Daily zip，最新 2 天會重抓；再重建本月＋下月的 MXF/TMF 歷史檔，不吃永豐流量，約 7 分鐘）；已排程 `OpenCharts-Taifex-Daily` 平日 16:00（pythonw、log 在 `logs/taifex-daily-update.log`）；可 `schtasks /delete /tn OpenCharts-Taifex-Daily /f` 移除 | 11/18 換月後看新代碼檔有沒有產出 |
