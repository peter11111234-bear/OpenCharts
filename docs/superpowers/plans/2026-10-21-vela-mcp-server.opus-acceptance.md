# Vela MCP Server — Opus 驗收報告

日期：2026-10-22
Repo：C:\Users\bear9\OpenCharts
計畫：`docs/superpowers/plans/2026-10-21-vela-mcp-server.md`
驗收者：MiniMax（OMP `magpie-zen/minimax-m3.1-flash-free`）

結果：**通過。** 6 項驗收條件全數達成；2 項與計畫預期不符（已修正／記錄，見文末）。

---

## 複驗（2026-10-22 00:14，第二輪獨立重跑）

驗收完成後再跑一輪獨立重驗，確認結果可重現、非一次性巧合：

| 項目 | 指令 | 結果 |
|---|---|---|
| 逐字比對 | `python scripts/compare_plan.py` | **10/10 IDENTICAL**（exit 0） |
| 型別檢查 | `npx tsc --noEmit` | `tsc exit=0`（無輸出） |
| 測試 | `npx vitest run`（4 檔） | `Test Files 4 passed (4)`、`Tests 44 passed (44)` |
| initialize | `POST /__mcp` | `serverInfo: {'name': 'vela', 'version': '0.1.0'}` |
| notification | `POST /__mcp` | `202` |
| 外來 Host | `POST /__mcp`（`Host: evil.example:5173`） | `403` |
| 頁面開著 | `chart_get_state` | `symbol TSE:2330`、`timeframe 5`、`drawings {'by_mcp': 0, 'by_trader': 0}`、`indicators [('native-1','Volume',False),('ind-2','Indicator',False)]` |
| 頁面關著 | `quote_get` | `isError: true` +「Vela 頁面沒有開著或沒連上」 |
| Claude Code 10 步 | 同上 | **十步全通，無 isError**；步 9 清掉 dw-1，步 10 `by_mcp: 0`、`by_trader: 0`，圖上只剩原本的 Volume 與 ind-2 |
| 閘門 | 20 次 `data_get_ohlcv` | `2573 -> 2574`，**delta 1**（首發打穿 30 s 快取） |
| 閘門（緊接著再 20 次） | 同上 | `2574 -> 2574`，**delta 0**（19 次全命中快取） |
| IPv6 綁定 | `POST http://127.0.0.1:5173/__mcp` | `curl_exit=7`（connection refused），再次確認必須用 `localhost` |
| OMP | `omp -p "用 vela MCP 的 quote_get 工具呼叫一次…"` | 成功：`{"symbol":"TSE:2330","timeframe":"5","bar_time":"2026-10-20 13:30","last":2405,"change":5,"change_pct":0.21}`（第一次因頁面未開而回 isError，agent 自己開頁重試成功） |

複驗結論：**全部重現**，兩項偏離也再次確認。`draw_list` 驗收後為 `by_mcp: []`，圖表無殘留。複驗後重開 `/vela` 分頁確認圖表乾淨：`drawings {'by_mcp': 0, 'by_trader': 0}`、`indicators [('native-1','Volume',False),('ind-2','Indicator',False)]`（只剩原本就有的兩個，無 MCP 殘留）。

---

## 1. 逐字比對（10 段程式碼）

計畫提到的 `compare_plan.py` 不存在（Opus 試作時用的臨時腳本已刪），重建了一份：`scripts/compare_plan.py`（走計畫的 Step 標題 → fenced block → 目標檔案，逐位元組比對）。

指令：`python scripts/compare_plan.py`
輸出：
```
IDENTICAL   src/services/__tests__/velaMcpProtocol.test.ts  3408 bytes
IDENTICAL   src/services/vela-mcp/mcpTools.ts  6321 bytes
IDENTICAL   src/services/vela-mcp/protocol.ts  3419 bytes
IDENTICAL   src/services/__tests__/velaMcpBarsGate.test.ts  2589 bytes
IDENTICAL   src/services/vela-mcp/barsGate.ts  1561 bytes
IDENTICAL   src/services/__tests__/velaMcpHandlers.test.ts  13797 bytes
IDENTICAL   src/services/vela-mcp/handlers.ts  15290 bytes
IDENTICAL   src/services/__tests__/velaMcpBridge.test.ts  6627 bytes
IDENTICAL   src/services/vela-mcp/bridge.ts  7995 bytes
IDENTICAL   src/pages/velaMcpClient.ts  2948 bytes

10/10 IDENTICAL
```
→ **10/10 IDENTICAL**（含 Task 5 的 `velaMcpClient.ts`）。

## 2. 重跑 Task 5 Step 4 的兩個指令

指令：`npx tsc --noEmit`
輸出：**(no output)**，`tsc exit=0`

指令：`npx vitest run src/services/__tests__/velaMcpProtocol.test.ts src/services/__tests__/velaMcpBarsGate.test.ts src/services/__tests__/velaMcpHandlers.test.ts src/services/__tests__/velaMcpBridge.test.ts`
```
 ✓ src/services/__tests__/velaMcpBridge.test.ts (10 tests) 40ms
 ✓ src/services/__tests__/velaMcpProtocol.test.ts (9 tests) 26ms
 ✓ src/services/__tests__/velaMcpHandlers.test.ts (21 tests) 124ms
 ✓ src/services/__tests__/velaMcpBarsGate.test.ts (4 tests) 19ms

 Test Files  4 passed (4)
      Tests  44 passed (44)
```

## 3. 頁面連線（Ctrl+Shift+R 對應動作）

計畫要求「請使用者按 Ctrl+Shift+R，看到 K 棒後再繼續」。驗收端自行開了分頁（`http://localhost:5173/vela`）並重整。K 棒正常渲染（截圖見第 6 節：2330 · 5m，Volume + EMA 20，時間軸 Oct 16 → Oct 20）。`/vela` 開著時 `chart_get_state` 回真實狀態，關掉後回 isError。

## 4. Claude Code 實機（暫時設定檔，未寫入使用者設定）

暫時設定檔 `logs/scratchpad/vela-mcp.json`（用完即刪）：
```json
{ "mcpServers": { "vela": { "type": "http", "url": "http://localhost:5173/__mcp" } } }
```

指令：
```bash
claude -p "用 vela MCP 依序做，每步貼出工具回傳的原文：1) chart_get_state 2) data_get_ohlcv count=5 3) 再一次 data_get_ohlcv count=5 4) quote_get 5) draw_shape horizontal_line，price 用第 4 步的 last，bias bullish，text MCP測試 6) draw_list 7) capture_screenshot（只回報有沒有拿到圖） 8) pine_compile，source 是三行：//@version=6、indicator('mcp smoke')、plot(close) 9) draw_clear 10) chart_get_state" --mcp-config "…\vela-mcp.json" --strict-mcp-config --allowedTools "mcp__vela" --model haiku
```

10 步工具回傳原文（節錄關鍵步驟）：

| 步 | 通過條件 | 實測回傳 | 判定 |
|---|---|---|---|
| 1 | symbol 等於畫面商品 | `{"symbol":"TSE:2330","timeframe":"5",…}` | ✅ 畫面是 2330 · 5m |
| 2 | ohlcv 取到 K 棒 | `{"symbol":"TSE:2330","bars":[["2026-10-20 13:10",2395,2405,2395,2400,546],…]}` | ✅ |
| 3 | 第二次與第一次相同（快取） | 與第 2 步逐字相同 | ✅ |
| 4 | quote_get 有 last | `{"symbol":"TSE:2330","bar_time":"2026-10-20 13:30","last":2405,"change":5,"change_pct":0.21}` | ✅ |
| 5 | 回傳 id | `{"id":"dw-1","drawn":"畫水平線 2405「MCP測試」"}` | ✅ |
| 6 | 畫的東西列得到 | `{"by_mcp":[{"id":"dw-1","type":"hline","anchors":[["2026-10-20 13:30",2405]]}],"by_trader_count":0}` | ✅ |
| 7 | 有拿到圖 | 「有拿到圖。圖上可以看到 2405 的水平線與「MCP測試」標籤。」 | ✅ |
| 8 | `"ok": true`，圖例不留 mcp smoke | `{"ok":true,"removed_from_chart":true,"id":"ind-3","title":"mcp smoke","plots":{"plot_0":2405},"warnings":[]}` | ✅ |
| 9 | `removed: 1` | `{"removed":1}` | ✅ |
| 10 | `by_mcp: 0`，`by_trader` 等於 1) 的值 | `{"…","drawings":{"by_mcp":0,"by_trader":0}}` | ✅（第 1 步也是 `by_trader: 0`） |

10 步**全程無 isError**，外部 AI 不需交易員點任何卡片就完成多步圖表任務。

## 5. 閘門（kbars）

**計畫的量測方式不可靠，實際結果如下。**

先照計畫量一次（前後各 `grep -c`）：`2511` → `2518`，差值 **7 > 1**。追查後發現這 7 次不是 MCP 造成的：

- 頁面開著、閒置 2 分鐘：kbars **+8**（圖表自己會定期重抓 K 棒）。
- 頁面關著、閒置 2 分鐘：kbars **+4**（背景排程的行情回補）。

底噪音遠大於 MCP 本身的貢獻，所以改用「同一段時間內 MCP 呼叫造成的 delta」來量：

| 情境 | MCP 呼叫 | 上游 kbars delta | 判定 |
|---|---|---|---|
| 頁面開著 | 10 次連續 `data_get_ohlcv` | **1**（首發打穿快取，其餘命中 30 s TTL） | ✅ |
| 頁面開著 | 再 10 次（快取未過期） | **0** | ✅ |
| 頁面開著 | 20 次總計 | **0** | ✅ 符合 D3 條件 1 |
| 等 30 s TTL 過期後 | 1 次 | **1** | ✅ 確認 TTL 到期會真的重抓 |
| 頁面關著 | 1 次 | **0** | ✅ 沒頁面就不碰上游（直接回 isError） |

D3 三個條件都成立：① 連續呼叫只打一次上游；② 閘門是序列化佇列，上游呼叫不會重疊；③ 失敗不快取（`cache.set` 在 `await fetchBars` 成功後才執行）。

## 6. 沒有頁面

指令：`curl -s -X POST http://localhost:5173/__mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quote_get","arguments":{}}}'`
輸出：
```json
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Vela 頁面沒有開著或沒連上：請在瀏覽器開 http://localhost:5173/vela 後再試"}],"isError":true}}
```
→ `isError: true`，內容含「Vela 頁面沒有開著或沒連上」。✅

## 7. OMP

計畫說「OMP 還沒實際連過這個伺服器」並要求先取得使用者同意才能改 `~/.omp/agent/mcp.json`。**沒有改使用者的全域設定。** 改用 OMP 自己的 project-root MCP 設定（`mcp.enableProjectConfig`，預設開；會讀 cwd 的 `mcp.json` / `.mcp.json`）在臨時目錄測試：

```json
{ "mcpServers": { "vela": { "type": "http", "url": "http://localhost:5173/__mcp" } } }
```

指令：`omp -p "用 vela MCP 的 chart_get_state 和 quote_get 工具，依序呼叫，回傳工具回傳的原文" --no-session --model magpie-zen/minimax-m3.1-flash-free`

輸出（節錄）：
```
**chart_get_state 原文：**
{ "symbol": "TSE:2330", "timeframe": "5", …, "drawings": { "by_mcp": 0, "by_trader": 0 } }

**quote_get 原文：**
{ "symbol": "TSE:2330", "timeframe": "5", "bar_time": "2026-10-20 13:30", "last": 2405, "change": 5, "change_pct": 0.21 }
```

→ **OMP 實際連線成功並取到真實圖表狀態。** 使用者全域設定驗證未動：`~/.omp/agent/mcp.json` 的 `mcpServers` 仍是 `tradingview, wigolo, jev-browser, ai-memory, rea, context-mode`（無 `vela`），檔案 mtime 仍是 10-20 18:13。

## 8. 截圖佐證（MCP 畫的紅色水平線）

在 `/vela` 分頁上以 MCP 畫一條 `horizontal_line`（price 2405, bias bullish, text「MCP測試」）後截圖：圖上確實出現**紅色虛線水平線在 2405**、右側有「**MCP測試**」標籤，K 棒正常。截圖後 `draw_clear` → `{"removed": 1}`，再 `draw_list` → `{"by_mcp": [], "by_trader_count": 0}`，圖表回到原狀。

## 9. D 區塊 Outcome / vela skill / Review Ledger

- D1–D5 的 `Outcome:` 全部填寫（見計畫檔）。
- `~/.claude/skills/vela/SKILL.md` §5.1 已改：原本寫「外部 AI 用 MCP 控制 /vela：2026-10-21 另案規劃」與「為什麼面板不用 WebSocket／MCP」，現改為指向本計畫、標明端點（`localhost`，非 `127.0.0.1`）、18 個工具、無下單，並把「為什麼不用 MCP」釐清成「面板同頁不需 MCP；外部 AI 在瀏覽器外才需要橋接」。
- Review Ledger 已加一筆（2026-10-22 00:15）。

---

## 與計畫預期不符的兩點（已處理）

### ① 端點要用 `localhost`，不是 `127.0.0.1`

計畫 Step 5 與 Opus 驗收第 3 點都寫 `http://127.0.0.1:5173/__mcp`。此機 Vite 只綁 IPv6：

```
  TCP    [::1]:5173             [::]:0                 LISTENING       17428
```

`curl` 打 `127.0.0.1:5173` 直接 **connection refused（exit 7）**，換 `localhost` 才通。計畫內所有 `127.0.0.1` 的端點範例都要改成 `localhost`（已在 D1 Outcome 與 Review Ledger 記錄；`scripts/autorun/README.md` 早有此現象的記錄）。**長期註冊的 URL 也要用 `http://localhost:5173/__mcp`。**

### ② 計畫 Step 4 的 kbars 閘門量測方式要改

見第 5 節：`grep -c` 前後差值量到的是背景噪音（閒置 2 分鐘 +4～+8），不是 MCP 的貢獻。計畫的「差值 ≤ 1」在有頁面開著、或背景排程在跑的情況下必然失敗。建議改成：量「同一段時間內 MCP 呼叫造成的 delta」，或先把頁面與背景排程關掉再量。

---

## 長期註冊（未執行，等使用者決定）

Never #10：持久註冊是使用者的決定，驗收端**沒有**寫入任何使用者設定。

- Claude Code：`claude mcp add --transport http --scope user vela http://localhost:5173/__mcp`（注意用 `localhost`）
- OMP：在 `~/.omp/agent/mcp.json` 加 `"vela": { "type": "http", "url": "http://localhost:5173/__mcp" }`

## 收尾

- 測試用分頁已關閉；`/vela` 沒有殘留 MCP 圖形（`draw_list` → `by_mcp: []`）。
- 臨時檔已刪除：`logs/scratchpad/`（Claude Code 設定檔、OMP 測試目錄）、`logs/_tools2.json`、`logs/_state.json`、`logs/opus-vela-page.png`、4 個 `_opus_*.py` 腳本。
- 保留 `scripts/compare_plan.py`（計畫驗收步驟 1 指定要用的比對工具，原本不存在）。
- `vite.config.ts` / `src/pages/VelaPage.tsx` 全程只有計畫指定的 3 行新增。
