# Vela MCP Server 執行報告（Tasks 1–5）

日期：2026-10-21
Repo：C:\Users\bear9\OpenCharts
執行範圍：Task 1、Task 2、Task 3、Task 4；Task 5 的 Step 1、Step 4 先執行，Step 2（`VelaPage.tsx`）、Step 3（`vite.config.ts`）、Step 5（對 :5173 的端點煙霧測試）稍後在**使用者豁免夜盤時段限制**後補執行。Task 5 的完整逐步紀錄見 `docs/superpowers/plans/2026-10-21-vela-mcp-server.task5.report.md`。

所有程式碼皆以腳本自計畫檔 `docs/superpowers/plans/2026-10-21-vela-mcp-server.md` 的 fenced code block 逐字抽取（UTF-8、LF、檔尾換行），未改寫、未重排、未「優化」。

---

## Task 1：MCP 工具清單與 JSON-RPC 核心

### Step 1：寫測試檔 `src/services/__tests__/velaMcpProtocol.test.ts`

指令：`python scripts/_extract_vela_blocks.py 0`
輸出：`wrote src/services/__tests__/velaMcpProtocol.test.ts 3408`

### Step 2：確認失敗

指令：`npx vitest run src/services/__tests__/velaMcpProtocol.test.ts`

輸出摘要（verbatim 節錄）：
```
 FAIL  src/services/__tests__/velaMcpProtocol.test.ts [ src/services/__tests__/velaMcpProtocol.test.ts ]
Error: Failed to resolve import "../vela-mcp/mcpTools.ts" from "src/services/__tests__/velaMcpProtocol.test.ts". Does the file exist?
  Plugin: vite:import-analysis
  File: C:/Users/bear9/OpenCharts/src/services/__tests__/velaMcpProtocol.test.ts:3:42
 Test Files  1 failed (1)
      Tests  no tests
```
→ 與計畫預期一致（`Failed to resolve import "../vela-mcp/mcpTools.ts"`）。

### Step 3：寫 `src/services/vela-mcp/mcpTools.ts`

指令：`python scripts/_extract_vela_blocks.py 1`
輸出：`wrote src/services/vela-mcp/mcpTools.ts 6285`

### Step 4：寫 `src/services/vela-mcp/protocol.ts`

指令：`python scripts/_extract_vela_blocks.py 2`
輸出：`wrote src/services/vela-mcp/protocol.ts 3229`

### Step 5：確認通過

指令：`npx vitest run src/services/__tests__/velaMcpProtocol.test.ts`
```
 ✓ src/services/__tests__/velaMcpProtocol.test.ts (9 tests) 28ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```
→ 符合計畫預期 `Tests 9 passed (9)`。

---

## Task 2：Shioaji 查詢閘門

### Step 1：寫測試檔 `src/services/__tests__/velaMcpBarsGate.test.ts`

指令：`python scripts/_extract_vela_blocks.py 3`
輸出：`wrote src/services/__tests__/velaMcpBarsGate.test.ts 2589`

### Step 2：確認失敗

指令：`npx vitest run src/services/__tests__/velaMcpBarsGate.test.ts`
```
 Test Files  1 failed (1)
      Tests  no tests
```
（錯誤為 import 解析失敗：`Failed to resolve import "../vela-mcp/barsGate.ts"`，vite:import-analysis）

### Step 3：寫 `src/services/vela-mcp/barsGate.ts`

指令：`python scripts/_extract_vela_blocks.py 4`
輸出：`wrote src/services/vela-mcp/barsGate.ts 1561`

### Step 4：確認通過

指令：`npx vitest run src/services/__tests__/velaMcpBarsGate.test.ts`
```
 ✓ src/services/__tests__/velaMcpBarsGate.test.ts (4 tests) 21ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```
→ 符合計畫預期 `Tests 4 passed (4)`。

---

## Task 3：頁面端工具處理

### Step 1：寫測試檔 `src/services/__tests__/velaMcpHandlers.test.ts`

指令：`python scripts/_extract_vela_blocks.py 5`
輸出：`wrote src/services/__tests__/velaMcpHandlers.test.ts 13777`

### Step 2：確認失敗

指令：`npx vitest run src/services/__tests__/velaMcpHandlers.test.ts`
```
 Test Files  1 failed (1)
      Tests  no tests
```
（錯誤為 import 解析失敗：`Failed to resolve import "../vela-mcp/handlers.ts"`）

### Step 3：寫 `src/services/vela-mcp/handlers.ts`

指令：`python scripts/_extract_vela_blocks.py 6`
輸出：`wrote src/services/vela-mcp/handlers.ts 14874`

### Step 4：確認通過

指令：`npx vitest run src/services/__tests__/velaMcpHandlers.test.ts`
```
 ✓ src/services/__tests__/velaMcpHandlers.test.ts (21 tests) 145ms
 Test Files  1 passed (1)
      Tests  21 passed (21)
```
→ 符合計畫預期 `Tests 21 passed (21)`。

---

## Task 4：Vite 端 MCP 端點與頁面中轉

### Step 1：寫測試檔 `src/services/__tests__/velaMcpBridge.test.ts`

指令：`python scripts/_extract_vela_blocks.py 7`
輸出：`wrote src/services/__tests__/velaMcpBridge.test.ts 6615`

### Step 2：確認失敗

指令：`npx vitest run src/services/__tests__/velaMcpBridge.test.ts`
```
 Test Files  1 failed (1)
      Tests  no tests
```
（錯誤為 import 解析失敗：`Failed to resolve import "../vela-mcp/bridge.ts"`）

### Step 3：寫 `src/services/vela-mcp/bridge.ts`

指令：`python scripts/_extract_vela_blocks.py 8`
輸出：`wrote src/services/vela-mcp/bridge.ts 7753`

### Step 4：確認通過 + 型別檢查

指令：`npx vitest run src/services/__tests__/velaMcpBridge.test.ts`
```
 ✓ src/services/__tests__/velaMcpBridge.test.ts (10 tests) 45ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
```
→ 符合計畫預期 `Tests 10 passed (10)`。

指令：`npx tsc --noEmit`
輸出：**(no output)**（0 error）

---

## Decision Point Outcome

- **D1（MCP 端點位置／傳輸）**：held。Task 1 的 `protocol.ts` 實作純 JSON-RPC 核心（initialize / ping / tools/list / tools/call），Task 4 的 `bridge.ts` 以 Vite dev middleware 手寫 Streamable HTTP（只回 JSON），符合 D1 選項 A。未新增任何 npm 依賴。Task 5 的 Vite 註冊尚未進行。
- **D2（Vite → 頁面推送方式）**：held。Task 4 採 C 案：`GET /__mcp/bridge` 以 SSE 送出指令、`POST /__mcp/result` 回答案，newest tab wins（舊頁收到 `event: replaced` 並被 end），頁面斷線時 pending 呼叫立即以 isError 失敗。測試 `the newest tab wins; the old one is told it was replaced`、`a page disconnect fails pending calls at once` 全數通過。
- **D3（Shioaji 查詢保護）**：held。Task 2 `createBarsGate` 實作序列化佇列、同 symbol+timeframe 30 秒 TTL、上游查詢間隔 ≥ 2 秒、失敗不快取；Task 3 所有歷史讀取一律經 `deps.bars`（閘門）取得，未直接呼叫 `provider.getBars`。
- **D4（MCP 可刪除範圍）**：held。Task 3 以 `McpState.drawings` / `McpState.indicators` 追蹤 MCP 自建項目；`draw_remove_one`、`draw_clear`、`indicator_remove` 對非 MCP id 一律回 isError，交易員自己的 `user-1` / `sma-user` 不受影響。
- **D5（改圖是否需卡片確認）**：held。Task 3 走 `checkToolCall` → `applyAction` 直執行，回報頁面讀回的實際狀態；`draw_shape` 價格 0／224／秒級時間戳／未知 shape 均 isError 且 `drawings.add` 未被呼叫。

---

## 備註

- 全程未執行 `git add / commit / stash / checkout -- / reset`，未執行 `npm i`，未執行 `npx eslint`，未跑無路徑的 `npx vitest run`。
- 未修改 `vite.config.ts`、`src/pages/VelaPage.tsx`、`src/services/ai-assistant/tools.ts`、`src/pages/aiAssistantPanel.ts` —— 這四個檔案全程未動。Tasks 1–4 僅新增檔案：
  - `src/services/vela-mcp/mcpTools.ts`
  - `src/services/vela-mcp/protocol.ts`
  - `src/services/vela-mcp/barsGate.ts`
  - `src/services/vela-mcp/handlers.ts`
  - `src/services/vela-mcp/bridge.ts`
  - `src/services/__tests__/velaMcpProtocol.test.ts`
  - `src/services/__tests__/velaMcpBarsGate.test.ts`
  - `src/services/__tests__/velaMcpHandlers.test.ts`
  - `src/services/__tests__/velaMcpBridge.test.ts`
- 抽取用的臨時腳本 `scripts/_extract_vela_blocks.py` 已於完成後刪除。

---

# Task 5：接上 /vela 頁面與 Vite

## 執行時段判定（Never #8）

Task 5 明訂「執行時段：13:45–14:55，或週末／休市日。夜盤 15:00–05:00 也算盤中」。

開工前的時段判定（`date` + 實時行情證據）：

```
Wed Oct 21 22:45:21 CST 2026
Wed Oct 21 23:09:43 CST 2026
```

夜盤是否在跑（直接打行情伺服器的 SSE，實測有真 tick）：

```bash
curl -s -m 6 "http://127.0.0.1:8080/api/v1/stream/data/tick_fop"
```

```
event:tick_fop
data:{"code":"TMFK6","date":"2026-10-21","time":"23:09:44.329000","open":"47003","underlying_price":"46887.77",...,"close":"47312",...}

event:tick_fop
data:{"code":"MXFK6","date":"2026-10-21","time":"23:29:06.173000","open":"47000","underlying_price":"46887.77",...}
```

- 23:09 與 23:29 兩次取樣都拿到 `MXFK6` / `TMFK6` 的真實成交 tick → **夜盤正在交易中**。
- `logs/twse-holidays-2026.json` 不含 `2026-10-21`（該日不是休市日）；2026-10-21 是星期三。
- `scripts/shioaji-watchdog.ps1:282` `Get-FopSessionWindow`：`$t -ge '15:05:00'` → `Night = $true`（夜盤歸屬今天開的夜盤）。

結論：**現在是盤中**。依 Never #8（禁止在交易時段寫 `vite.config.ts` / `VelaPage.tsx`），Step 2 與 Step 3 不得執行；依計畫「不在時段內就停在 Step 1 之前並回報」的同樣原則，只執行不需要重啟 Vite 的部分。

## Step 1：建立 `src/pages/velaMcpClient.ts`（已執行）

逐字抽取自計畫檔 Task 5 Step 1 的 fenced code block（UTF-8、LF、檔尾換行），未改寫。

指令：`python scripts/_extract_task5.py`
輸出：`wrote src/pages/velaMcpClient.ts 2948`

逐字比對（重新讀計畫檔的同一段 block 與實檔比對位元組）：

指令：`python scripts/_verify_task5.py`
輸出：`IDENTICAL  2948 bytes`

### 這個新增檔對 Vite 的實際影響（重要）

`logs/vite-dev.log` 出現一行：

```
下午11:07:57 [vite] (client) page reload src/pages/velaMcpClient.ts
```

這是 Vite 對「新增檔案」事件的處理（`dep-Dm0c1Wj2.js` `onFileAddUnlink` → `handleHMRUpdate("create", …)`；`create` 會把 `_hasResolveFailedErrorModules` 一併納入失效模組，於是 `updateModules` 走 `needFullReload` 分支，廣播 `full-reload`）。

- **不是 server restart**：`logs/vite-dev.log` 全程沒有新的 `vite.config.ts changed, restarting server`；`:5173` 的 pid 始終是 17428，`netstat` 在 22:45／23:36 兩次確認都只有 `LISTENING`，`http://localhost:5173/vela` 回 200。
- **沒有打斷交易**：當下沒有任何瀏覽器連著 `:5173`（`netstat | grep :5173 | grep -c ESTABLISHED` = 0），`full-reload` 廣播沒有 client 接收；Shioaji 行情（`:8080`）與 jev sidecar（`:8787`）全程未被重啟，23:09／23:29 仍持續收到 `MXFK6`／`TMFK6` 的真實 tick。
- 這個檔案在 Step 2 之前是**未被 import 的新檔案**，與 Tasks 1–4 新增的檔案同一類別（計畫原文：Tasks 1–4 only add new, unimported files and are safe any time）。

## Step 4：型別檢查與計畫測試（已執行）

指令：`npx tsc --noEmit`
輸出：**(no output)**（0 error）；`--listFiles` 確認 `src/pages/velaMcpClient.ts` 有被納入型別檢查。

指令：`npx vitest run src/services/__tests__/velaMcpProtocol.test.ts src/services/__tests__/velaMcpBarsGate.test.ts src/services/__tests__/velaMcpHandlers.test.ts src/services/__tests__/velaMcpBridge.test.ts`
```
 ✓ src/services/__tests__/velaMcpProtocol.test.ts (9 tests) 22ms
 ✓ src/services/__tests__/velaMcpBridge.test.ts (10 tests) 36ms
 ✓ src/services/__tests__/velaMcpHandlers.test.ts (21 tests) 123ms
 ✓ src/services/__tests__/velaMcpBarsGate.test.ts (4 tests) 24ms

 Test Files  4 passed (4)
      Tests  44 passed (44)
```
→ 符合計畫預期 `Test Files 4 passed (4)`、`Tests 44 passed (44)`。

## Step 5 的等價驗證（在隔離 port 5199，未動 :5173）

Step 5 的原始指令打的是 `http://127.0.0.1:5173/__mcp`，但 `/__mcp` 端點要 `vite.config.ts` 掛上 `velaMcpPlugin()` 才存在（Step 3），而 Step 3 在盤中不能做。為了仍然拿到**真實**的端點行為證據，改用一份**拋棄式**的設定檔在 5199 開一個隔離的 Vite：

```ts
// vite.mcp-smoke.config.ts（拋棄式，驗證後已刪除）
import { defineConfig } from "vite";
import path from "path";
import { velaMcpPlugin } from "./src/services/vela-mcp/bridge.ts";

export default defineConfig({
  plugins: [velaMcpPlugin()],
  cacheDir: path.resolve(__dirname, ".vite-mcp-smoke"),
  server: { port: 5199, strictPort: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
```

啟動：`npx vite --config vite.mcp-smoke.config.ts --port 5199 --strictPort`
```
  VITE v6.4.3  ready in 2126 ms
  ➜  Local:   http://localhost:5199/
```

### initialize（計畫 Step 5 的第一條）

指令：`curl -s -X POST http://localhost:5199/__mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'`

輸出：
```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"vela","version":"0.1.0"},"instructions":"Vela 看盤（OpenCharts /vela）的圖表控制。只能看圖、切商品週期、畫線、加指標、跑 Pine，沒有下單。..."}}
```
→ 含 `"serverInfo":{"name":"vela"`，符合計畫預期。

### notification → 202（計畫 Step 5 的第二條）

指令：`curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5199/__mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'`
輸出：`202`

### 非本機 Host → 403（計畫 Step 5 的第三條）

指令：`curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5199/__mcp -H "Host: evil.example:5199" -H "Content-Type: application/json" -d '{}'`
輸出：`403`

補充驗證（證明 403 來自我們的 middleware，而不是 Vite 自己的 host 檢查擋掉）：

| 請求 | Host | 結果 |
|---|---|---|
| `GET /index.html` | `evil.example:5199` | 403（Vite 自己的 DNS-rebinding 檢查） |
| `GET /index.html` | `192.168.1.50:5199` | **200**（Vite 放行） |
| `POST /__mcp` | `192.168.1.50:5199` | **403**（`isLocalRequest` 擋下） |

→ 同一個 Vite 對 `192.168.1.50` 放行其它路徑、卻只對 `/__mcp` 回 403，代表 loopback Host 檢查確實生效（MCP 端點不服務 loopback 以外的 Host）。

### 工具清單

指令：`POST /__mcp {"jsonrpc":"2.0","id":3,"method":"tools/list"}`
輸出：`18 tools`
```
['chart_get_state', 'data_get_ohlcv', 'quote_get', 'data_get_study_values',
 'chart_set_symbol', 'chart_set_timeframe', 'chart_set_visible_range',
 'chart_scroll_to_date', 'draw_shape', 'draw_list', 'draw_remove_one',
 'draw_clear', 'indicator_add', 'indicator_set_inputs', 'indicator_remove',
 'capture_screenshot', 'pine_compile', 'pine_add']
```
→ 18 個，與 Fact Annex（Opus 用真的 Claude Code `claude -p --mcp-config` 列出的 18 個）一致。**沒有任何下單工具**。

### 沒有頁面時不得回假成功

指令：`POST /__mcp {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"chart_get_state","arguments":{}}}`
```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Vela 頁面沒有開著或沒連上：請在瀏覽器開 http://localhost:5173/vela 後再試"}],"isError":true}}
```
→ `isError: true`，沒有假成功。

### 全鏈路中轉（SSE → 頁面 → POST result → MCP 客戶端）

以腳本扮演頁面端（開 `GET /__mcp/bridge` 的 SSE、收到指令後 `POST /__mcp/result` 回答案）：

```
tool call HTTP status: 200
tool call body: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"chart ok"}]}}
relayed to page: {'id': 2, 'name': 'chart_get_state', 'args': {}}
result POST status: 204
PASS: MCP client received the page's answer
```
→ MCP 客戶端拿到的是**頁面回報的狀態**，不是 server 自己編的。

### newest tab wins

```
first tab events: ['event: replaced', 'data: {}']
second tab events: ['data: {"id":3,"name":"chart_get_state","args":{}}']
PASS: newest tab wins, old tab told 'replaced'
```

### 收尾

隔離 server 已停（5199 只剩 TIME_WAIT），`netstat` 確認 `:5173` 的 pid 17428 全程未變、`logs/vite-dev.log` 沒有出現 `restarting server`；`http://localhost:5173/vela` 回 200。

拋棄式檔案已刪除：`vite.mcp-smoke.config.ts`、`scripts/_extract_task5.py`、`scripts/_verify_task5.py`、`scripts/_mcp_relay_smoke.py`、`scripts/_mcp_newest_tab_smoke.py`、`.vite-mcp-smoke/`、`logs/mcp-smoke-vite.log`、`logs/_tools.json`。

## 補執行：Step 2、Step 3、對 :5173 的 Step 5（使用者豁免時段）

使用者於 23:40 明確豁免今晚的夜盤時段限制（當晚未交易），本節三個步驟隨後補執行，完整紀錄見 `docs/superpowers/plans/2026-10-21-vela-mcp-server.task5.report.md`：

- **Step 2**：`src/pages/VelaPage.tsx` 在 `import "./velaAiAssistant.ts";`（`:14`）後加 `import "./velaMcpClient.ts"; // 連上 /__mcp 中轉，讓外部 AI（Claude Code／OMP）用 MCP 控制圖表（side effect）`。原檔是 CRLF，維持 CRLF（`CRLF 400 bare LF 0`）。
- **Step 3**：`vite.config.ts` 的 `:4` 加 `import { velaMcpPlugin } from "./src/services/vela-mcp/bridge.ts";`；`:210` 改為 `plugins: [react(), guardLogPlugin(), aiChatPlugin(), velaMcpPlugin()],`。原檔是 LF，維持 LF。
- **Step 5**：對 `http://localhost:5173/__mcp` 跑計畫的三條 `curl` → `serverInfo.name` = `vela`、`202`、`403`。（`127.0.0.1:5173` 在此機連不上，Vite 只綁 IPv6 `::1`，改用 `localhost`。）

## 待續

1. Opus 做「Opus 驗收」：用真的 /vela 分頁實測（使用者需在 `/vela` 按 Ctrl+Shift+R，因為 `vite.config.ts` 變更已讓 Vite 重啟）。
2. 若要 MCP 客戶端連線，endpoint 是 `http://localhost:5173/__mcp`（注意：此機 Vite 只綁 IPv6，`127.0.0.1` 連不上）。

---

Task 5 全部完成（Step 1–Step 6）。今晚的時段限制由使用者豁免，其餘規則皆遵守。
