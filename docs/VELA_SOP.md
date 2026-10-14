---
name: vela
description: '看盤K棒程式有異常檢查SOP。當使用者提到 Vela、看盤、K棒開不起來、K棒沒顯示、K棒不主動更新、http://localhost:5173/vela 異常、OpenCharts 行情掛掉、或需要排查/啟動 Vela 環境時使用。包含核心伺服器端口 (:5173, :8080, :8787)、關鍵目錄、啟動腳本、金鑰設定與完整診斷 SOP。Triggers on: "vela", "Vela", "看盤", "K棒", "K棒開不起來", "沒有K棒", "K棒不會動", "K棒不更新", "啟動vela", "啟動VELA SKILL", "opencharts".'
allowed-tools: Read Write Edit Glob Grep Bash
---

# vela — 看盤K棒程式有異常檢查SOP

## 1. 架構與重要伺服器清單

OpenCharts Vela 交易終端是由前端 Vite、本機 Shioaji 行情伺服器與 Jev Sidecar 協同運作：

```
[瀏覽器分頁 :5173/vela]
       │
       ▼ (1. 前端頁面)
[Vite Dev Server :5173] ──/shioaji/* 代理──▶ [Shioaji Server :8080]
       │                                             │
       ▼ (2. 決策側車)                      (需帶 SJ_API_KEY)
[Jev Sidecar :8787]                                  ▼
                                            [永豐金雲端行情伺服器]
```

### 核心 SERVER 與連接埠（Port）

| 服務名稱 | 監聽 Port | 測試/健康端點 | 預設網址 | 啟動命令 / 腳本 |
|---|---|---|---|---|
| **前端 OpenCharts (Vite)** | `5173` | `/` (HTTP 200) | `http://localhost:5173/vela` | `cd C:\Users\bear9\OpenCharts && npx vite --port 5173` |
| **行情伺服器 (Shioaji)** | `8080` | `/api/v1/health` (回傳 healthy) | `http://127.0.0.1:8080` | `powershell -NoProfile -File scripts/scratch/up-backend.ps1` |
| **決策 Sidecar (Jev)** | `8787` | `/health` (HTTP 200) | `http://127.0.0.1:8787` | 同上（由 `up-backend.ps1` 自動拉起 `scripts/jev-sidecar.py`） |

---

## 2. 關鍵檔案與目錄絕對路徑

日後排查直接定位這些路徑，**嚴禁全磁碟盲搜**：

| 項目 | 絕對路徑 | 說明 |
|---|---|---|
| **前端專案根目錄** | `C:\Users\bear9\OpenCharts` | **務必用 realpath，切勿使用 `MYOPENCHART\OpenCharts` junction** |
| **Vela 路由入口** | `C:\Users\bear9\OpenCharts\src\pages\VelaPage.tsx` | 對應 `/vela` 路由，掛載 `@luxalgo/vela` WebGL2 畫布 |
| **行情資料配接器** | `C:\Users\bear9\OpenCharts\src\services\shioaji\velaProvider.ts` | 呼叫 `kbars` 抓歷史，並在 `subscribe()` 拉起 `startShioajiFeed()` 串流 |
| **即時行情串流服務** | `C:\Users\bear9\OpenCharts\src\services\shioaji\feed.ts` | 監聽 SSE Tick，聚合 1m K 棒並發布 `CandleUpdate` 事件 |
| **Vite 代理設定** | `C:\Users\bear9\OpenCharts\vite.config.ts` | 設定 `/shioaji` 代理至 `127.0.0.1:8080`（`strictPort: true`） |
| **Shioaji 金鑰設定** | `C:\MyTradingProjects\.env` | **存放真實金鑰**（`SHIOAJI_API_KEY`、`SHIOAJI_SECRET_KEY`） |
| **Shioaji 執行檔** | `C:\Users\bear9\.openharness-venv\Scripts\shioaji.exe` | Rust CLI 行情伺服器主程式 |
| **一鍵啟動後端腳本** | `C:\Users\bear9\OpenCharts\scripts\scratch\up-backend.ps1` | 自動載入金鑰並拉起 8080 與 8787 服務 |
| **每日開工排程腳本** | `C:\Users\bear9\OpenCharts\scripts\start-trading-day.ps1` | 08:30 自動化健檢與行情監控腳本 |
| **日誌目錄** | `C:\Users\bear9\OpenCharts\logs\` | 存放 `shioaji-out.log`、`shioaji-err.log`、`vite-dev.log` |

---

## 3. 看盤K棒程式異常排查 SOP（標準 5 步法）

當使用者回報「網頁打不開」、「沒有 K 棒」或「**K 棒不會主動跳動更新**」時，依序由外向內檢測：

### Step 1：檢查前端 Vite 是否存活（5173）
```bash
cmd /c "netstat -ano | findstr :5173"
```
* **無輸出（Port 未開）**：
  在 `C:\Users\bear9\OpenCharts` 啟動 Vite：
  ```bash
  npx vite --port 5173
  ```
* **有輸出但瀏覽器報錯**：檢查是否為 esbuild crash，關閉該 PID 重啟即可。

### Step 2：檢查後端行情伺服器是否健康（8080）
```bash
powershell -NoProfile -Command "(Invoke-WebRequest -Uri 'http://127.0.0.1:8080/api/v1/health' -UseBasicParsing).Content"
```
* **正常輸出**：包含 `{"status":"healthy","version":"1.7.7"}`。
* **異常（連線意外關閉 / 404 / 無回應）**：
  直接執行一鍵拉起腳本：
  ```bash
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\bear9\OpenCharts\scripts\scratch\up-backend.ps1"
  ```

### Step 3：檢查 Vite Proxy 反向代理轉發
```bash
powershell -NoProfile -Command "(Invoke-WebRequest -Uri 'http://localhost:5173/shioaji/api/v1/auth/accounts' -UseBasicParsing).StatusCode"
```
* **正常輸出**：`200`（並回傳帳戶 JSON 陣列）。
* **異常（回傳 500 或 504）**：代表 8080 未啟動或 Vite proxy 斷線，重啟 8080 與 Vite。

### Step 4：檢查 K 棒歷史資料撈取
```bash
powershell -NoProfile -Command "Invoke-RestMethod -Uri 'http://localhost:5173/shioaji/api/v1/data/kbars' -Method Post -ContentType 'application/json' -Body '{\"contract\":{\"security_type\":\"STK\",\"exchange\":\"TSE\",\"code\":\"2330\"},\"start\":\"2026-10-01\",\"end\":\"2026-10-14\"}' | Select-Object -ExpandProperty datetime | Measure-Object | Select-Object Count"
```
* **正常輸出**：`Count` 為 2,000 根以上（K 棒資料正常）。
* **若是 0 筆**：檢查股票代碼格式（如 `TSE:2330`）與休市狀態。

### Step 5：檢查即時 SSE Tick 串流與即時更新（K 棒不會動時）
```bash
powershell -NoProfile -Command "(Invoke-WebRequest -Uri 'http://localhost:5173/shioaji/api/v1/stream/data/tick_stk' -Headers @{'Accept'='text/event-stream'} -TimeoutSec 3).StatusCode"
```
* **正常輸出**：`200`（連線成功並維持 SSE 串流）。
* **檢查機制**：確認 `src/services/shioaji/velaProvider.ts` 的 `subscribe()` 是否有呼叫 `void startShioajiFeed()`。若漏呼叫，前端只會顯示開盤歷史靜態棒，無法隨盤中即時 Tick 自動更新。

---

## 4. 重大技術陷阱與避坑規範（必讀）

1. **即時行情必須拉起 `startShioajiFeed()`**：
   - Vela 頁面的即時 K 棒依賴 `src/services/shioaji/velaProvider.ts` 監聽事件匯流排上的 `CandleUpdate`。
   - `startShioajiFeed()`（位於 `src/services/shioaji/feed.ts`）負責連接 Shioaji 8080 的 SSE 串流（`/api/v1/stream/data/tick_stk` / `tick_fop`），並在本地聚合 1m K 棒後發布 `CandleUpdate`。
   - 若 `velaProvider.ts` 內只啟動虛擬 demo 的 `wsClient.connect()`，即時 SSE 行情不會建立，導致 K 棒靜止不動。

2. **環境變數名稱不一致陷阱**：
   - `C:\MyTradingProjects\.env` 內記錄的變數為 `SHIOAJI_API_KEY` 與 `SHIOAJI_SECRET_KEY`。
   - 但底層 Rust CLI `shioaji server` 強制讀取 **`SJ_API_KEY`** 與 **`SJ_SEC_KEY`**。
   - 啟動後端時必須執行變數名稱映射，否則伺服器會直接 crash 報 `SJ_API_KEY environment variable is required`。

3. **Windows Pipe Buffer 死鎖（Deadlock）陷阱**：
   - 在 Windows 上透過背景行程（`.NET ProcessStartInfo` 或 Node `spawn`）啟動 `shioaji.exe` 時，**嚴禁設為 `RedirectStandardOutput=true` 卻未即時讀取 pipe**。
   - OS 管道緩衝區僅 4KB，日誌填滿後行程將永久死鎖，外部 HTTP 請求會被立即中斷（出現 `基礎連接已關閉: 連接意外關閉` 或 `socket closed unexpectedly`）。
   - **唯一正確解法**：標準輸出/錯誤務必重定向到實體檔案（如 `logs/shioaji-out.log`）。

4. **Vite esbuild 長跑死掉**：
   - 手冊記載（`docs/2026-10-13-remaining-work.md §0.10`）：Vite dev server 長時間掛著，esbuild 子行程死掉時，前端 overlay 會報 `[plugin:vite:esbuild] The service is no longer running`。
   - **解決方式**：殺掉 node 進程換 port 重起即可，**切勿執行 `npm i` 浪費時間**。

5. **Harness proc:// 啟動規範**：
   - 用 harness `proc://` 啟動前端時務必設 `pty: false`。若設 `pty: true` 會假印 ready 但實際上沒有 listener。
