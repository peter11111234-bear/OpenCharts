# JEV 影子收集器 — 營運手冊（JEV_SHADOW_OPS）

最後更新：2026-10-16

本檔說明 `scripts/jev-shadow.py`（影子收集器）、`scripts/jev-sidecar.py`（決策代理）、
`scripts/jev-shadow-watchdog.ps1`（看護）三者如何運作、如何排查、如何回溯。

---

## 1. 它是什麼

每個完成的 5m K 棒：向本機 shioaji 取 1m → 重採樣成 5m → 算 Jev-Trades 指標組（pandas parity）
＋ 1m 大單流特徵 → `POST /decide` 給 sidecar → 寫進 `logs/jev-shadow.jsonl`。

**只看不做，不下任何單。** 目的是在接執行層之前，先量出 Jev 的判斷到底有沒有 edge。

| 檔案 | 角色 |
|---|---|
| `scripts/jev-shadow.py` | 收集器。5m 週期決定、寫資料集 |
| `scripts/jev-sidecar.py` | 決策代理。`:8787`，`POST /decide {state, questions}` |
| `scripts/jev-shadow-watchdog.ps1` | 看護。每 60s 確認 sidecar 與收集器都活著 |
| `logs/jev-shadow.jsonl` | **資料集**：只有成功回答（有 `answers`）的列 |
| `logs/jev-shadow-errors.jsonl` | 診斷：失敗、被限流、被 park 的列 |
| `logs/jev-sidecar-spend.json` | 當日呼叫數 / 付費呼叫數 |

---

## 2. 2026-10-16 修掉的三個問題（附證據）

### 問題 1：sidecar 掛掉，收集器把 bar 燒光
- 649 列中 426 列失敗：419 筆 `URLError WinError 10061`（連線被拒，sidecar 沒開）＋ 7 筆 `TimeoutError`。
- 失敗區間：`2026-09-22 13:10` → `2026-09-24 10:15`（9/23 整天 230 根全毀）。
- **根因（程式缺陷，不是意外）**：舊 `logged_bar_times()` 把「所有列」都當成已處理，
  且主迴圈無條件 `seen.add(bar["time"])`。所以 bar 一旦失敗就被永久跳過，**永不重試**。
  sidecar 掛兩天，收集器照樣把 426 根燒成灰。

### 問題 2：收集器停了沒人知道
- 最後一筆 bar = `2026-09-24 10:15`。sidecar 與 shioaji 都活著，只有收集器沒在跑。
- **根因**：`start-trading-day.ps1` 從來沒管過 sidecar 與收集器；既有的
  `jev-sidecar-watchdog.ps1` 沒被排程、也沒釘 python 路徑（排程環境只有 machine PATH）。

### 問題 3：key 失效 + 免費額度被打爆
- sidecar 只讀 `OPENROUTER_API_KEY`，該 key 已被撤銷 → `upstream 401: {"message":"User not found."}`
  → 每次決策都 502。
- 改用 `opencode-go` 的 **JEV-FREE**（`jev-1.13-free`，$0）後，一次回溯爆量 300 筆把免費
  額度打到 `FreeUsageLimitError`（429，>15 分鐘未恢復）→ 全部 fallback 到付費 TypeSafe。

---

## 3. 改了什麼

### `jev-shadow.py`
- **只有拿到 `answers` 的 bar 才算完成**；失敗的留在待辦，下一輪重試（不再永久燒毀）。
- **sidecar 不可用或冷卻中時，一根 bar 都不消耗**（避免重演 426 根）。
- **客戶端限速**：`--rate`（預設 6 次/分，gap 10s）；**單輪上限** `--max-per-cycle`（預設 3），
  回溯不會一次爆發把免費額度打爆。
- **429/503 立即返回、不重試**，改走退避（60s → 120s → … 上限 900s）。
- **失敗寫 `jev-shadow-errors.jsonl`**，資料集保持乾淨。
- **自動換月**：`--symbol auto`（預設）用第三個週三結算日判斷近月，`TXFJ6` → 10/22 起自動變 `TXFK6`。
  舊版硬寫 `TXFJ6`，10/21 之後會靜默收到 0 根。
- **回溯參數**：`--since / --until / --warmup`（見 §5）。
- 每列新增 `channel` 欄位（`jev-zen` = 免費 / `jev-direct` = 付費），可事後算成本。

### `jev-sidecar.py`
- 改為 **channel 鏈**：`jev-zen`（opencode-go JEV-FREE，$0）→ `jev-direct`（TypeSafe，付費）。
  依需求移除了 OpenRouter。
- **付費用量上限**：`JEV_PAID_MAX_CALLS`（預設 300/日），回溯不會偷偷把 TypeSafe 餘額燒光。
- **免費額度 429 退避**：指數成長、上限 900s，並在 `/health` 回報 `rate_limited_for`。
- 順手修掉：舊碼達到 `429 daily cap` 後**沒有 `return`**，會繼續發送請求。

### `jev-shadow-watchdog.ps1`（新）
同時看顧 sidecar 與收集器，每 60s 一次；連續失敗 3 次退避 5 分鐘。
固定用絕對路徑 python（排程環境 PATH 問題）。**不覆寫** `JEV_PAID_MAX_CALLS`，
所以看護重啟後一定回到安全預設。

### 排程
`start-trading-day.ps1` 新增步驟 **4.5**：每交易日 08:30 重開
`jev-shadow-watchdog.ps1`（並清掉舊的 `jev-sidecar-watchdog.ps1`，避免兩者搶 port）。

### `preflight.ps1`
新增兩項檢查：收集器程序存在、資料集 26 小時內有寫入。

---

## 4. 日常操作

```powershell
# 看全部是否健康
powershell -ExecutionPolicy Bypass -File C:\Users\bear9\OpenCharts\scripts\preflight.ps1

# sidecar 狀態（含免費額度冷卻與付費用量）
Invoke-WebRequest http://127.0.0.1:8787/health -UseBasicParsing | Select-Object -ExpandProperty Content

# 收集器 / 看護
Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -match 'jev-shadow\.py' }
Get-Content C:\Users\bear9\OpenCharts\logs\jev-shadow-watchdog.log -Tail 20

# 今天收了幾根、走哪條 channel
Get-Content C:\Users\bear9\OpenCharts\logs\jev-shadow.jsonl -Tail 20 |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Group-Object channel | ForEach-Object { "$($_.Name)  $($_.Count)" }
```

手動重啟整套（看護會自己接回）：

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\bear9\OpenCharts\scripts\jev-shadow-watchdog.ps1
```

---

## 5. 回溯（backfill）指定日期的 bar

```powershell
# 注意：先停掉常駐收集器，否則兩個實例會同時寫同一個檔
Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
  Where-Object { $_.CommandLine -match 'jev-shadow\.py' } | Stop-Process -Force

python C:\Users\bear9\OpenCharts\scripts\jev-shadow.py `
  --symbol TXFJ6 --since 2026-09-22 --until 2026-09-24 `
  --days 30 --warmup 6000 --rate 20 --max-per-cycle 15 --poll 10
```

- `--since/--until`：只決定這個台北日期區間的 bar；抓取範圍自動往前多抓 3 天當指標暖機。
- `--warmup`：保留多少根 5m 當暖機（預設 400 ≈ 1.4 天；回溯要調大）。
- shioaji 只提供 **約 30 天** 的 1m 歷史（實測 `days=30` 回 21751 根，最早 2026-09-16）。
- 回溯跑完請**停掉它**，再讓看護拉起正常 live 收集器。

---

## 6. 目前已知缺口（尚未實作）

1. **夜盤也收**：資料集含 15:00 之後的夜盤 bar（例如 `10-14 21:20`）。
   `plan-v1` 明說不做夜盤；分析前需先按時段過濾，否則會混到不同市場結構的樣本。
2. **缺 DeepSeek 升級層**：`plan-v1` §4.5 要求 Phase 0「Jev 和 DeepSeek 兩層都出決策」。
   目前只有 Jev 一層。`.env` 已有 `DEEPSEEK_API_KEY`，可作影子第二層接入。
3. **缺 §6 風控規則**：口數、連虧停手、單日最大跟單次數等實作都還沒有。
4. **未量測 edge**：資料集有了，但還沒算過 `action_choice` 分布與後續 N 根實際走勢。
   這是「這個系統到底能不能用」的唯一判準。

---

## 7. 免費額度實測（2026-10-16）

| Channel | 模型 | 成本 | 實測 |
|---|---|---|---|
| `jev-zen` | `jev-1.13-free` | **$0**（OpenCode GO） | 正常可用；爆量後 429 `FreeUsageLimitError`，>15 分鐘未恢復 |
| `jev-direct` | `jev-1.13.0` | 付費（TypeSafe，額度充足） | 正常可用 |
| ~~OpenRouter~~ | ~~`typesafe/jev-1.13`~~ | — | 已移除；`OPENROUTER_API_KEY` 回 401 `User not found` |

Jev 單價約 `$0.042 / 1M input tokens`（輸出免費），所以付費 fallback 的成本量級是
「幾百筆 ≈ 幾美分」，真正的瓶頸是**免費配額**而不是錢。限制器的作用是保護配額。
