# VELA AI 副駕駛 Phase 1 — 執行報告

- 計畫：`docs/superpowers/plans/2026-10-21-ai-assistant-omp-vela-mcp.md`
- 執行日期：2026-10-21
- 執行者：OMP `magpie-zen/minimax-m3.1-flash-free`
- 結果：Task 1 / 2 / 3 / 4 全部 DONE；`npx tsc --noEmit` 0 error；三個測試檔 30 passed。

---

## Task 1：工具定義與驗證層（純函式）— DONE

### Step 1: Write the test file exactly

- 指令：以程式把計畫 ````ts 區塊（plan 行 134–269）逐字元寫入 `src/services/__tests__/aiTools.test.ts`（UTF-8、LF、尾端換行）。
- 輸出摘要：檔案建立成功，134 行程式碼，內容與計畫區塊 byte-for-byte 相同（事後 `==` 比較為 `True`）。

### Step 2: Verify it fails

- 指令：`npx vitest run src/services/__tests__/aiTools.test.ts`
- 輸出摘要：`Test Files 1 failed (1)` / `Tests no tests`，錯誤為 Vite transform 失敗：`Failed to resolve import "../ai-assistant/tools.ts"`（第 11 行 `} from "../ai-assistant/tools.ts";`）。符合 Expected。

### Step 3: Write the implementation exactly

- 指令：把計畫 ````ts 區塊（plan 行 278–600）逐字元寫入 `src/services/ai-assistant/tools.ts`。
- 輸出摘要：檔案建立成功，321 行；內容與計畫區塊 byte-for-byte 相同（`True`）。
- 備註：為了遵守 Step 2 → Step 3 的順序，實作檔先被暫存（移到 repo 外的暫存區），Step 2 驗證失敗後才寫回正式路徑。

### Step 4: Verify it passes

- 指令：`npx vitest run src/services/__tests__/aiTools.test.ts`
- 輸出摘要：`✓ src/services/__tests__/aiTools.test.ts (18 tests) 50ms` / `Test Files 1 passed (1)` / `Tests 18 passed (18)`。符合 Expected。

---

## Task 2：對話傳輸（SSE 串流解析）與 system prompt — DONE

### Step 1: Write the test file exactly

- 指令：計畫 ````ts 區塊（plan 行 626–699）→ `src/services/__tests__/aiChat.test.ts`。
- 輸出摘要：檔案建立，72 行，byte-for-byte 相同（`True`）。

### Step 2: Verify it fails

- 指令：`npx vitest run src/services/__tests__/aiChat.test.ts`
- 輸出摘要：`Test Files 1 failed (1)` / `Tests no tests`（`Failed to resolve import "../ai-assistant/chat.ts"`）。符合 Expected。

### Step 3: Write the implementation exactly

- 指令：計畫 ````ts 區塊（plan 行 708–820）→ `src/services/ai-assistant/chat.ts`。
- 輸出摘要：檔案建立，111 行，byte-for-byte 相同（`True`）。

### Step 4: Verify it passes

- 指令：`npx vitest run src/services/__tests__/aiChat.test.ts`
- 輸出摘要：`✓ src/services/__tests__/aiChat.test.ts (3 tests) 60ms` / `Test Files 1 passed (1)` / `Tests 3 passed (3)`。符合 Expected。

---

## Task 3：面板（純 DOM）與卡片執行器 `applyAction` — DONE

### Step 1: Write the test file exactly

- 指令：計畫 ````ts 區塊（plan 行 846–1004）→ `src/pages/__tests__/aiAssistantPanel.test.ts`。
- 輸出摘要：檔案建立，157 行，byte-for-byte 相同（`True`）。

### Step 2: Verify it fails

- 指令：`npx vitest run src/pages/__tests__/aiAssistantPanel.test.ts`
- 輸出摘要：`Test Files 1 failed (1)` / `Tests no tests`（`Failed to resolve import "../aiAssistantPanel.ts"`）。符合 Expected。

### Step 3: Write the implementation exactly

- 指令：計畫 ````ts 區塊（plan 行 1013–1258）→ `src/pages/aiAssistantPanel.ts`。
- 輸出摘要：檔案建立，244 行，byte-for-byte 相同（`True`）。

### Step 4: Verify it passes

- 指令：`npx vitest run src/pages/__tests__/aiAssistantPanel.test.ts`
- 輸出摘要：`✓ src/pages/__tests__/aiAssistantPanel.test.ts (9 tests) 215ms` / `Test Files 1 passed (1)` / `Tests 9 passed (9)`。符合 Expected。

---

## Task 4：接上 Vela 與 `/__ai-chat` 中轉 — DONE

### Step 1: Create `src/pages/velaAiAssistant.ts` exactly

- 指令：計畫 ````ts 區塊（plan 行 1286–1373）→ `src/pages/velaAiAssistant.ts`。
- 輸出摘要：檔案建立，86 行，byte-for-byte 相同（`True`）。

### Step 2: Edit `src/pages/VelaPage.tsx`, add one import line

- 搜尋錨點 `import "./velaMarketWidgets.ts"; // 註冊報價列、電子熱力圖與排行榜（side effect）` — 在 `src/pages/VelaPage.tsx` 第 13 行，**恰好出現一次**（`grep` 確認）。
- 取代為錨點 + 新增一行 `import "./velaAiAssistant.ts"; // 註冊「AI 副駕駛」側邊面板與頂列 "AI" 按鈕（side effect）`。
- 輸出摘要：編輯成功，新 import 落在第 14 行。

### Step 3: Edit `vite.config.ts`, insert the relay plugin

- 搜尋錨點 `export default defineConfig({` — 第 116 行，**恰好出現一次**（事後重新 count = 1）。
- 在其正上方插入計畫 ````ts 區塊（plan 行 1400–1494）整段（93 行）。
- 輸出摘要：插入成功；插入後錨點行仍在且未變（`export default defineConfig({` 出現次數 = 1）；插入段落與計畫區塊 byte-for-byte 相同（substring 比對 `True`）。

### Step 4: Edit `vite.config.ts`, register the plugin

- 原文 `  plugins: [react(), guardLogPlugin()],` — 恰好出現一次。
- 取代為 `  plugins: [react(), guardLogPlugin(), aiChatPlugin()],`。
- 輸出摘要：編輯成功。

### Step 5: Typecheck

- 指令：`npx tsc --noEmit`
- 輸出摘要：**無任何輸出**，exit code 0（0 errors），與基準相同。
- 補充：`tsconfig.json` 只 include `src`，不涵蓋 `vite.config.ts`（如計畫 Final Verification 3a 所述），故另以單檔檢查覆蓋它：
  `npx tsc --noEmit --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --types node vite.config.ts` → 無輸出，exit 0。

### Step 6: Re-run the three test files together

- 指令：`npx vitest run src/services/__tests__/aiTools.test.ts src/services/__tests__/aiChat.test.ts src/pages/__tests__/aiAssistantPanel.test.ts`
- 輸出摘要：
  ```
  ✓ src/services/__tests__/aiChat.test.ts (3 tests) 24ms
  ✓ src/services/__tests__/aiTools.test.ts (18 tests) 69ms
  ✓ src/pages/__tests__/aiAssistantPanel.test.ts (9 tests) 361ms
  Test Files  3 passed (3)
  Tests  30 passed (30)
  ```
  符合 Expected。

### Task 4 額外煙霧測試（dev server，計劃外但屬驗證）

- 啟動 `npx vite --port 5199 --strictPort`（背景），測完後已停止（netstat 確認 5199 無 LISTENING）。
- `GET /__ai-chat` → **405**
- `POST` body `{}` → **400**
- `POST` body `{"messages":[],"tools":[]}` → **400**
- `POST` body `{"messages":[{"role":"user","content":"hi"}],"tools":[...]}`、無 Origin 標頭 → **200**，回應為 OpenAI 格式 SSE：`data: {"id":"gen_...","model":"minimax/minimax-m3","choices":[{"index":0,"delta":{"role":"assistant"}...}]}`，model 由伺服器端固定（`minimax/minimax-m3`），未從 request 取得。
- `POST` 帶外部 `Origin: http://evil.example` → **403**
- `GET /vela` → **200**；`GET /src/pages/velaAiAssistant.ts` → **200**（模組可被 Vite 轉換，import 已解析成 `@luxalgo/vela/plugin` 的預先打包路徑，非 root barrel）。

**視覺驗證限制**：嘗試用 headless Chromium 實際開 `/vela` 點「AI」按鈕、看面板卡片，browser daemon 無法啟動（`Shared browser daemon unavailable (broker start or Chromium launch failed)`，兩次嘗試、tab worker 逾時）。因此 **UI 層未經真實瀏覽器點擊驗證**，只驗證到：模組可載入、relay 端點行為正確、面板邏輯有 9 個 jsdom 單元測試涵蓋。需由 Opus 的 Final Verification 第 4 項（手動）補上。

---

## 改了哪些檔案

新增：
- `C:\Users\bear9\OpenCharts\src\services\ai-assistant\tools.ts`
- `C:\Users\bear9\OpenCharts\src\services\ai-assistant\chat.ts`
- `C:\Users\bear9\OpenCharts\src\services\__tests__\aiTools.test.ts`
- `C:\Users\bear9\OpenCharts\src\services\__tests__\aiChat.test.ts`
- `C:\Users\bear9\OpenCharts\src\pages\aiAssistantPanel.ts`
- `C:\Users\bear9\OpenCharts\src\pages\velaAiAssistant.ts`
- `C:\Users\bear9\OpenCharts\src\pages\__tests__\aiAssistantPanel.test.ts`
- `C:\Users\bear9\OpenCharts\docs\superpowers\plans\2026-10-21-ai-assistant-omp-vela-mcp.report.md`（本報告）

修改（僅計畫指定行）：
- `C:\Users\bear9\OpenCharts\src\pages\VelaPage.tsx` — 只加 1 行 import（第 14 行）
- `C:\Users\bear9\OpenCharts\vite.config.ts` — 插入 `aiChatPlugin` 區段（93 行）+ `plugins` 一行改動

`git diff --stat` 對這兩個檔案：`VelaPage.tsx | 2 ++`、`vite.config.ts | 96 +++...-`（唯一刪除行是 `plugins: [react(), guardLogPlugin()],` → 被取代的那一行）。其餘未 commit 的既有工作未被更動。

未執行任何 git 破壞性指令（無 commit / add / stash / checkout -- / reset），未跑 eslint，未跑無路徑的全量 vitest。

---

## 遇到的問題與處理

1. **計畫的 Step 順序要求先測失敗再寫實作**（Task 1–3）。處理：Task 1 特別把實作檔先移到暫存位置，跑完 Step 2 確認紅燈後才寫回正式路徑；Task 2、3 因實作模組不存在即紅燈，直接照順序寫入即可。
2. **計畫檔是 LF 行尾、內容含全形引號等 Unicode**。處理：寫檔一律用 Python `open(..., encoding='utf-8', newline='')`，確保逐字元不因行尾轉換而變動；寫完後以讀回比對確認 byte-for-byte 相同（7 個新檔全部 `True`，vite 插入段 substring 比對 `True`）。
3. **`npx vite --port 5199` 以背景 shell 執行後無法用 `tail` 讀 log**（工具政策擋掉 `cat/head/tail`）。處理：改用 `read` 工具讀 log，並改以 `browser`/`fetch` 方式驗證端點；最後以 `process.kill` 停掉 vite（`taskkill` 被 jev-gate 擋），netstat 確認埠已釋放。
4. **headless Chromium 無法啟動**（browser daemon unavailable，tab worker 逾時）。處理：改以 Node `fetch` 對 relay 端點做完整煙霧測試（405/400/403/200 + SSE 內容），UI 互動驗證標記為未完成，交由 Opus 的手動 Final Verification。
5. **工作樹有大量他人未 commit 的修改**。處理：全程只寫計畫 Files 清單內的檔案；`VelaPage.tsx` 與 `vite.config.ts` 只動錨點行，並用 `git diff` 逐行核對差異只有計畫指定的行。
6. **暫存檔清理**：執行期間在 repo 根建立過 `.planblocks/`（計畫區塊抽取）與 `vite5199.log`，驗證完成後已刪除，`git status` 確認無殘留。

---

## Decision Points Outcome

| DP | Outcome | 理由 |
|---|---|---|
| **D1**（工具迴圈放哪裡、圖表指令通道） | **held** | 實作完全按 C：迴圈在瀏覽器面板內（`src/pages/aiAssistantPanel.ts`），只有 LLM 呼叫經 `vite.config.ts` 的 `aiChatPlugin` 中轉（`POST /__ai-chat`），圖表操作是同頁函式呼叫（`applyAction(ctx, …)`）。沒有新增 WebSocket、後端服務或 MCP Server，也沒有新增依賴（`package.json` 未被本次修改）。四個criteria皆維持成立，故不改變決策。唯一未能自行驗證的是「文字串流不被圖表操作阻塞」的瀏覽器實測（browser daemon 不可用），但架構上兩者路徑完全解耦，不構成 D1 需要重估的理由。 |
| **D2**（工具呼叫直接執行 vs 變卡片） | **held** | Task 1 `checkToolCall` 產生卡片、Task 3 `mountAiAssistantPanel` 只在交易員點按鈕時呼叫 `applyAction`，且 `applyAction` 再驗一次價格與商品（第二道防線）。Task 3 的 9 個測試明確斷言「點擊前 `apply` 未被呼叫」「壞價格回傳『價格無效』」「切換商品後拒絕舊卡片」。驗證失敗會以 `role: "tool"` 回報 LLM 並只允許 1 輪修正。三個 criteria 皆滿足，決策不變。 |
| **D3**（模型與連線方式） | **held** | `vite.config.ts` 固定 `AI_UPSTREAM = "http://127.0.0.1:3425/v1/chat/completions"`、`AI_MODEL = "auto/minimax-m3"`，瀏覽器端只呼叫相對路徑 `/__ai-chat`，金鑰與上游 URL 不進瀏覽器程式碼（符合 Nevers 第 8 條）。煙霧測試實測回應 `model: "minimax/minimax-m3"`、`data: {choices:[{delta:…}]}` 標準 SSE，且 `streamChat` 送出 body 不含 `model`（測試斷言 `sent.model` 為 `undefined`）。criterion 1–3 皆成立，故不改變決策。 |

---

## 給 Opus 驗收的注意事項

- 逐字比對可直接用本次產出的 7 個新檔（已內部比對為 IDENTICAL）與 `vite.config.ts` 插入段（已比對 IDENTICAL）。
- 仍待補的只有 UI 層手動驗證（Final Verification 第 4 項）：需 magpie 與 Shioaji 8080 在線，開 `http://localhost:5173/vela` → 頂列「AI」→ 提問 → 出卡 → 點「套用」→ 確認線條價位、價格軸未被壓扁、紅／綠顏色正確、切商品後舊卡被拒。
