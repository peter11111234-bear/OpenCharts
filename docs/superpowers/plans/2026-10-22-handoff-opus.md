# 交接：2026-10-22（Opus 對話）

Sonnet 另一個對話的細項待辦在 `docs/superpowers/plans/2026-10-22-pending-work.md`（F 區），本檔不重複，只列要追的事和注意事項。

## 一、等時間驗證（不用決定，到點看結果）

| 何時 | 看什麼 | 怎麼看 | 預期 |
|---|---|---|---|
| 10-23 05:10 後 | jev-shadow 整晚流量 | Sonnet 的 `night_usage_from_1826.txt`（舊的 `night_usage.txt` 含暫停時段，不準） | jev-shadow 夜盤約 7MB |
| 10-23 夜盤／日盤 | F5 計數器真的接上 | 重啟後第一根「應跟單」的 K 棒，即時風控判決 = `jev-risk-recompute.py` 重算結果 | 0 差異（目前只有單元測試證明） |
| 10-23 日盤收盤後 | d2f7758 流量修正效果 | `GET :8080/api/v1/auth/usage` 跟 10-21（500MB）、10-22 比 | 熱力圖約 64MB／日盤，總量明顯下降 |
| 10-23 16:00 後 | 期交所每日下載排程 `OpenCharts-Taifex-Daily`（E4） | `schtasks /query /tn OpenCharts-Taifex-Daily /v`、`logs/taifex-daily-update.log` | LastTaskResult 0、有 10-23 檔 |
| 約 2026-11-21 | OpenCode Zen key 到期 | sidecar `:8787/health` 的 `paid_today` ≈ `calls_today` 就是過期 | 換新 key：先小請求測 200 再寫 `~/.local/share/opencode/auth.json` 的 `opencode-go` |
| 約 11 月下旬 | 高波動減半檢討報告 | `logs/jev-volatile-review.md`（排程 `JEV-Volatile-Review`） | 只用日盤算 P60，夜盤另段 |

## 二、待做（要人動手）

| 項目 | 誰 | 備註 |
|---|---|---|
| 預設瀏覽器改 Chrome | 使用者 | Windows 設定 → 預設應用程式 → 網頁瀏覽器。UCPD 擋程式修改，只能手按 |
| 加回 MACD_V7.04、MACD雙周期 V7 | 使用者 | 原始碼 `MYOPENCHART\high452\MACDV7.04\MACDV7.04.TXT`、`MYOPENCHART\high452\MACD雙周期\V7\MACD雙周期V7.TXT`；在 Chrome 的 Pine Editor 貼上 → 存進「我的腳本」→ 加到圖上 |
| F4b：sidecar 遇 401 記住失敗並提醒 | Sonnet | 現在 key 過期時每次靜默改走付費 TypeSafe |
| D1 重疊範圍重複 kbars 請求 | Sonnet | 先量每次多花多少 KB，再決定修不修 |
| D1 AI 回答實測 | Sonnet | 數據面已完成，AI 回答未測 |
| 下午多出 ~130MB 的來源 | Sonnet | 逐時段對帳，不再打 kbars |
| 成交量差 1–4 口（MXFR1 vs 期交所） | 待查 | 不急 |
| 15:08 伺服器卡 10 秒 | 觀察 | 收盤後數 watchdog.log 的 `HTTP probe failed`，常出現再查 |
| A7、B3、D2、D3、A8、E3 舊資料、norm2.pine | 使用者決定 | |
| A3 REAL PLAN | Opus | 使用者開口才寫 |
| 直譯器重構 phase 2 | 暫緩 | phase 3 不建議 |

## 三、今天的結論（避免重查）

- **/vela 指標不見 = 用 Edge 開了**。Windows 預設瀏覽器是 Edge；指標與「我的腳本」在 Chrome 的 localStorage。沒有程式刪資料。Edge 裡那個 `opencharts.backup-20261022` 是空的，不用管。
- **C4 看門狗補訂通過**：用 `scratchpad\test-watchdog-resub.ps1` 驗證，21 秒判定缺漏並補訂，41 秒內恢復。之前兩次失敗是前端 feed.ts 先補回（20 秒門檻），不是程式問題。
- **jev-shadow**（commit 84721e0、147ce8f、9f053c6、e3c2dec、bb01286、a5ef300）：
  - 只看小台 MXF 近月，5 分 K 週期（`TF_SECONDS=300`）。使用者確認：合約不加、週期不改，要下哪個合約使用者自己決定。
  - 每根 5 分 K 完成後 10 秒才抓一次，不開盤不抓：流量 84KB/分 → 4KB/分。
  - `--all-sessions`：日盤、夜盤都判斷，紀錄有 `session` 欄位。
  - 風控：跟單 5 次上限**分日夜各自計算**（shadow 專用，真正的 `orderGuard.ts` 沒有這條）；連虧 3 次、今日虧損、+800 獲利保護**依交易日合併**（15:00 為界，跟 orderGuard.ts 一樣）。
  - 啟動時重播同一交易日紀錄，接回計數器（F5）。
  - 歷史紀錄已用新規則離線重算並覆蓋，原檔備份 `logs/jev-shadow-mxf.pre-recompute.jsonl`。
- **付費 = TypeSafe（api.typesafe.ai）**，免費 = OpenCode Zen。10-22 付費 314 次是因為 OpenCode key 過期；18:44 已換新 key（舊檔備份 `auth.json.bak-20261022`）。

## 四、注意事項

- **改程式的時機**：盤中別改 `vite.config.ts`（會弄壞開著的 /vela）；jev-shadow、看門狗只在 05:00–08:45 或週末重啟（10-22 有在夜盤重啟過，影響小，但別當常態）。
- **Shioaji 流量**：每天 500MB（含夜盤），超過會靜默回空。不要並行、密集打 kbars；量流量用 `:8080/api/v1/auth/usage`，不要另外打 kbars 去量。
- **多個 AI 並行**：OpenCharts 常有 Sonnet／MiniMax 同時在改。範圍外的改動先問；檔案行號會變，引用前重讀。
- **金鑰**：不印、不寫進程式或 commit（Shioaji `C:\MyTradingProjects\.env`、OpenCode `auth.json`）。這把 OpenCode key 曾貼在對話裡，下次換時可順便作廢。
- **新增系統排程前先問使用者**（E4 那個是 Sonnet 先建後報）。
- **驗證 Sonnet 回報**：純查證派 Haiku，判斷才由 Opus 做。
- **測試方法要控制變數**：例如有前端分頁時，後端看門狗一定搶輸。測不出來先檢查測法，不要先懷疑程式。
