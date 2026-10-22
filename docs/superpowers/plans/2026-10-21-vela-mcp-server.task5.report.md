# Vela MCP Server 執行報告（Task 5）

日期：2026-10-21
Repo：C:\Users\bear9\OpenCharts
計畫：`docs/superpowers/plans/2026-10-21-vela-mcp-server.md`
執行範圍：Task 5 的 Step 1–Step 6（全部）。

## 時段豁免（Time-window override）

Task 5 原本規定「執行時段：13:45–14:55，或週末／休市日。夜盤 15:00–05:00 也算盤中（Never #8）。開工前先跑 `date` 確認；不在時段內就停在 Step 1 之前並回報。」

開工前依計畫跑 `date`：

指令：`date`
輸出：
```
Wed Oct 21 23:40:25 CST 2026
```

23:40 CST 屬夜盤時段，依 Never #8 原應停在 Step 1 之前。**使用者已明確豁免今晚的時段限制**（當晚未交易），故本次照計畫繼續執行 Step 2、Step 3、Step 5。

豁免範圍：僅限**時段**。其他所有規則照舊生效 —— 未動 `src/services/ai-assistant/tools.ts` 與 `src/pages/aiAssistantPanel.ts`；未加任何下單／alert 工具；未 `git add / commit / stash / checkout -- / reset`；未 `npm i`；未 `npx eslint`；未跑無路徑的 `npx vitest run`；未執行任何 MCP 客戶端、未把 server 註冊到任何持久設定（Never #10）。

---

## Step 1：建立 `src/pages/velaMcpClient.ts`

以腳本自計畫檔的 fenced code block 逐字抽取（UTF-8、LF、檔尾換行），未改寫。

指令：`python scripts/_task5_extract.py`
輸出：`wrote src/pages/velaMcpClient.ts 2948`

逐字比對（重新讀計畫檔同一段 block 與實檔比對位元組）：

指令：`python scripts/_task5_verify.py`
輸出：`IDENTICAL  2948 bytes`

## Step 2：在 `src/pages/VelaPage.tsx` 註冊 client

錨點 `import "./velaAiAssistant.ts";`（`:14`），在其後新增一行。

指令（編輯後驗證，比對計畫 Step 2 的 Original / Replacement 兩段）：

```
plan original block : 'import "./velaAiAssistant.ts"; // 註冊「AI 副駕駛」側邊面板與頂列 "AI" 按鈕（side effect）\n'
plan replacement blk: 'import "./velaAiAssistant.ts"; // 註冊「AI 副駕駛」側邊面板與頂列 "AI" 按鈕（side effect）\nimport "./velaMcpClient.ts"; // 連上 /__mcp 中轉，讓外部 AI（Claude Code／OMP）用 MCP 控制圖表（side effect）\n'
OK: original anchor present verbatim
OK: replacement block present verbatim
OK: replacement appears exactly once
OK: anchor line appears exactly once
```

行尾維持原檔的 CRLF：`CRLF 400 bare LF 0`，檔尾仍有換行。

## Step 3：在 `vite.config.ts` 掛上 plugin

Edit A（`:4` 錨點 `import path from "path";`）、Edit B（`:210` 錨點 `plugins: [react(), guardLogPlugin(), aiChatPlugin()],`）。

指令（編輯後驗證，比對計畫 Step 3 的四段 block）：

```
--- Edit A
  orig: 'import path from "path";\n'
  repl: 'import path from "path";\nimport { velaMcpPlugin } from "./src/services/vela-mcp/bridge.ts";\n'
  OK: replacement present verbatim, exactly once; original block no longer stands alone
--- Edit B
  orig: '  plugins: [react(), guardLogPlugin(), aiChatPlugin()],\n'
  repl: '  plugins: [react(), guardLogPlugin(), aiChatPlugin(), velaMcpPlugin()],\n'
  OK: replacement present verbatim, exactly once; original block no longer stands alone
OK: both vite.config.ts edits verified
```

行尾維持原檔的 LF：`CRLF 0 bare LF 283`，檔尾仍有換行。

兩個檔案我只加了 3 行（其它 diff 是既有的他人未提交變更，未動）：

指令：`git diff vite.config.ts | grep -E "^[+-].*velaMcpPlugin"` / `git diff src/pages/VelaPage.tsx | grep -E "^[+-].*velaMcpClient"`
輸出：
```
+import { velaMcpPlugin } from "./src/services/vela-mcp/bridge.ts";
+  plugins: [react(), guardLogPlugin(), aiChatPlugin(), velaMcpPlugin()],
+import "./velaMcpClient.ts"; // 連上 /__mcp 中轉，讓外部 AI（Claude Code／OMP）用 MCP 控制圖表（side effect）
```

## Step 4：型別檢查與計畫測試

指令：`npx tsc --noEmit`
輸出：**(no output)**，`tsc exit=0`

指令：`npx vitest run src/services/__tests__/velaMcpProtocol.test.ts src/services/__tests__/velaMcpBarsGate.test.ts src/services/__tests__/velaMcpHandlers.test.ts src/services/__tests__/velaMcpBridge.test.ts`
```
 ✓ src/services/__tests__/velaMcpProtocol.test.ts (9 tests) 37ms
 ✓ src/services/__tests__/velaMcpHandlers.test.ts (21 tests) 119ms
 ✓ src/services/__tests__/velaMcpBridge.test.ts (10 tests) 42ms
 ✓ src/services/__tests__/velaMcpBarsGate.test.ts (4 tests) 23ms

 Test Files  4 passed (4)
      Tests  44 passed (44)
```
→ 符合計畫預期 `Test Files 4 passed (4)`、`Tests 44 passed (44)`。

## Step 5：端點煙霧測試（對真的 :5173）

### Vite 已因 vite.config.ts 變更而重啟

指令：`grep -n "restarting server\|server restarted\|Re-optimizing" logs/vite-dev.log | tail -5`
輸出：
```
174:下午11:42:25 [vite] server restarted.
175:下午11:42:28 [vite] vite.config.ts changed, restarting server...
176:下午11:42:28 [vite] vite.config.ts changed, restarting server...
177:下午11:42:44 [vite] (client) Re-optimizing dependencies because vite config has changed
178:下午11:42:46 [vite] server restarted.
```
→ 有 `vite.config.ts changed, restarting server...`，符合計畫預期。Vite 自己重啟，執行者沒有重啟或殺任何行程。

### 第一條：initialize

計畫原指令用 `http://127.0.0.1:5173/__mcp`，但此機 Vite 只綁 IPv6 `::1`，`127.0.0.1:5173` 直接 connection refused（curl exit 7）。改用 `http://localhost:5173/__mcp`（`scripts/autorun/README.md` 已記錄此現象：「Vite 綁 IPv6：`localhost:5173` 通、`127.0.0.1:5173` 可能不通」）。

指令：`curl -s -X POST http://localhost:5173/__mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'`
輸出：
```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"vela","version":"0.1.0"},"instructions":"Vela 看盤（OpenCharts /vela）的圖表控制。只能看圖、切商品週期、畫線、加指標、跑 Pine，沒有下單。時間一律用台北時間 YYYY-MM-DD HH:mm。台股紅漲綠跌。期貨只限微台 TMF／小台 MXF。改圖的工具會回傳頁面讀回的實際狀態；回 isError 就是沒做成。"}}
```
→ 含 `"serverInfo":{"name":"vela"`，符合計畫預期。

### 第二條：notification → 202

指令：`curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5173/__mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'`
輸出：`202`

### 第三條：非本機 Host → 403

指令：`curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5173/__mcp -H "Host: evil.example:5173" -H "Content-Type: application/json" -d '{}'`
輸出：`403`

### 補充驗證：403 確實來自 MCP middleware，而非 Vite 自己的 host 檢查

| 請求 | Host | 結果 |
|---|---|---|
| `GET /index.html` | `192.168.1.50:5173` | **200**（Vite 放行） |
| `POST /__mcp` | `192.168.1.50:5173` | **403**（`isLocalRequest` 擋下） |

→ 同一個 Vite 對該 Host 放行其它路徑、卻只對 `/__mcp` 回 403，代表 loopback Host 檢查確實生效（MCP 端點不服務 loopback 以外的 Host）。

### 工具清單

指令：`curl -s -X POST http://localhost:5173/__mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}'`
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

指令：`curl -s -X POST http://localhost:5173/__mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"chart_get_state","arguments":{}}}'`
```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Vela 頁面沒有開著或沒連上：請在瀏覽器開 http://localhost:5173/vela 後再試"}],"isError":true}}
```
→ `isError: true`，沒有假成功。

### 頁面端 SSE 通道

指令：`curl -s -N -m 3 http://localhost:5173/__mcp/bridge`
輸出：`retry: 2000` → SSE 開得起來，`velaMcpClient.ts` 的 `new EventSource("/__mcp/bridge")` 有得接。

### 全鏈路中轉（SSE → 頁面 → POST result → MCP 客戶端）

以腳本扮演頁面端（開 SSE、收到指令後 `POST /__mcp/result` 回答案）：
```
tool call HTTP status: 200
tool call body: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"chart ok"}]}}
relayed to page: [{'id': 1, 'name': 'chart_get_state', 'args': {}}]
PASS: MCP client received the page's answer
```
→ MCP 客戶端拿到的是**頁面回報的狀態**，不是 server 自己編的。

### newest tab wins

```
first tab events: ['event: replaced', 'data: {}']
second tab events: ['data: {"id":2,"name":"chart_get_state","args":{}}']
PASS: newest tab wins, old tab told 'replaced'
```

## 收尾

服務狀態（全程未重啟或殺任何行程）：

指令：`netstat -ano | grep -E ":5173|:8080|:8787" | grep LISTENING`
輸出：
```
  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       20228
  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       19000
  TCP    [::1]:5173             [::]:0                 LISTENING       17428
```
→ 5173 / 8080 / 8787 三個都在跑，pid 與執行前一致（Vite 是自己重啟的，pid 17428 未變）。

行情仍在正常推送（夜盤未受影響）：
```
event:tick_fop
data:{"code":"TMFK6","date":"2026-10-21","time":"23:48:03.213000","open":"47003","underlying_price":"46887.77",...}
```

`http://localhost:5173/vela` 回 200。

臨時腳本已刪除：`scripts/_task5_extract.py`、`scripts/_task5_verify.py`、`scripts/_task5_verify_vp.py`、`scripts/_task5_verify_vc.py`、`scripts/_task5_relay.py`、`scripts/_task5_tabs.py`、`logs/_t.json`。

## Done when 對照

| 計畫條件 | 結果 |
|---|---|
| `npx tsc --noEmit` → 0 errors | ✅ `tsc exit=0` |
| 4 個測試檔 → 44 passed | ✅ `Tests 44 passed (44)` |
| `logs/vite-dev.log` 出現 `vite.config.ts changed, restarting server` | ✅ 11:42:28 |
| initialize → `serverInfo.name` = `vela` | ✅ |
| notification → `202` | ✅ |
| Host `evil.example:5173` → `403` | ✅ |
| 執行者在 Step 6 後停止，實機頁面檢查留給 Opus 驗收 | ✅ |

---

Task 5 完成（Step 1–Step 6 全部執行）。今晚的時段限制由使用者豁免，其餘規則皆遵守。

vite.config.ts 已更新、Vite 已重啟：請在 /vela 分頁按 Ctrl+Shift+R。實機驗收由 Opus 做。
