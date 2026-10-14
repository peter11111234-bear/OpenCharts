# 交接：demo 歷史／圖表 review 修正輪（2026-10-14）

工作區 realpath：`C:\Users\bear9\OpenCharts`。
**勿**從 `C:\Users\bear9\MYOPENCHART\OpenCharts`（junction）跑測試。從那裡跑會出現假的
`Failed to load url .../src/__tests__/setup.ts`。

本輪狀態：**全部改動仍在 worktree，未 commit。**

---

## 1. 重開機後直接跑（依序）

```bash
cd /c/Users/bear9/OpenCharts

# 1. 型別：必須 0 error
npx tsc --noEmit

# 2. 本輪受影響的測試（快）
npx vitest run src/pages src/services
#    最近一次：5 檔 / 36 passed

# 3. 全套（約 5 分鐘）
npx vitest run

# 4. 起 UI（要跑實體冒煙時）
npx vite --port 5177 --strictPort
#    用 harness 的 proc:// 起時務必 pty:false。pty:true 會印 ready 但沒有 listener。
```

驗收下限：`tsc` 0 error；`vitest` 全綠（最近一次：70 檔 / 1043 passed / 1 skipped）。

---

## 2. 改動檔案清單（完整路徑）

**修改（6）**

| 路徑 | 內容 |
|---|---|
| `C:\Users\bear9\OpenCharts\src\services\demo\engine.ts` | 訂單 level 邊界正規化、`fillOrder`、掛單成交價、`closePositionCore`、`modifyOrder` 限 PENDING、`cancelOrder` 回報失敗、輸入驗證 |
| `C:\Users\bear9\OpenCharts\src\services\demo\candles.ts` | range 端點 inclusive、位移改 per-series anchor（tail 可重錨、windowed 不重錨） |
| `C:\Users\bear9\OpenCharts\src\services\demo\api.ts` | `placeOrder` 轉 promise rejection、`modifyOrder` 型別、`getCandlesWithMeta` 轉發 range |
| `C:\Users\bear9\OpenCharts\src\pages\trading\ChartPanel.tsx` | overlay 依型別讀 level；extras 記 base 並隨 payload 位移；改用抽出的兩個模組 |
| `C:\Users\bear9\OpenCharts\src\components\MarketDataBridge.tsx` | 補處理 `OrderUpdated` |
| `C:\Users\bear9\OpenCharts\src\services\shioaji\api.ts` | `modifyOrder` 轉發 mods（原本整包丟棄） |

**新增（5）**

| 路徑 | 內容 |
|---|---|
| `C:\Users\bear9\OpenCharts\src\pages\trading\chartHistory.ts` | `HistoricalExtension`、`rebaseExtension`、`prependExtension`（純函式） |
| `C:\Users\bear9\OpenCharts\src\pages\trading\historyLoader.ts` | loader 狀態機（`makeHistoryLoader`、`isLoadMoreEligible`、`fetchOlderRange`、`createLoadMoreState`、`extensionWindowMs`） |
| `C:\Users\bear9\OpenCharts\src\pages\__tests__\chartHistory.test.ts` | 6 條：接縫不變式（含 mutant 會紅） |
| `C:\Users\bear9\OpenCharts\src\pages\__tests__\historyLoader.test.ts` | 6 條：嚴格更舊、起點終止、gap 走位、失敗重試、請求時 base、非觸發條件 |
| `C:\Users\bear9\OpenCharts\src\services\__tests__\demo-engine-resting-orders.test.ts` | 10 條：引擎語意與 range 邊界、anchor 生命週期 |

**背景文件（本輪之外，讀了才知道全貌）**

- `C:\Users\bear9\OpenCharts\docs\2026-10-13-remaining-work.md` — Pine 直譯器流的未完成總表。
- `C:\Users\bear9\OpenCharts\docs\2026-10-13-handoff-s5-tv-oracle.md` — 同一流的權威 handoff。

---

## 3. 已完成（可驗收，附證據）

| # | 項目 | 證據 |
|---|---|---|
| 1 | 訂單 level 正規化：LIMIT→`price`、STOP→`stopPrice` | 實跑 UI：下 STOP 落 `stopPrice`、下 LIMIT 落 `price`，皆仍 PENDING |
| 2 | 掛單成交價 `min/max(level, market)` | 測試 4 個方向（BUY/SELL LIMIT、STOP） |
| 3 | `fillOrder` 是 FILLED 唯一擁有者 | 交易面板實跑 + 測試 |
| 4 | `modifyOrder` 拒絕非 PENDING；`cancelOrder` 未知 id 回 `{success:false}` | 實跑 + 測試 |
| 5 | range 端點 inclusive，與 live backend 同慣例 | loader 起點終止測試 |
| 6 | 位移 anchor：同 bucket 凍結、只有 tail 可重錨 | `chartHistory` + loader 測試；對抗驗證 40 組 |
| 7 | extras 記住自身 base 並隨 payload 位移，接縫不開洞 | 對抗驗證 `holes=0 dup=0` |
| 8 | base 在**發請求前**讀取並隨請求帶到 merge | mutant 測試：改成回應時讀 → 只有該條變紅 |
| 9 | overlay 依型別讀 level | 實跑截圖：`[P] STOP @ 64000`、`[B] LIMIT @ 63450` 兩條線 |
| 10 | `OrderUpdated` 進 upsert 清單 | diff |

對抗式驗證結論（4 輪）：不變式 `merged == payload + extension`、`holes=0`、`duplicatedCandles=0`、
嚴格遞增、`newest == 當前 bucket`，在 4 個 series × k=1/2/5/12/60 × 兩種操作序全部成立。

---

## 4. 未完成（等開機後）

### 4.1 commit 這批改動（0 成本，最該先做）
`git diff` 覆核 §2 的 6 個修改檔；5 個新檔要 `git add`。本輪沒有新增依賴、沒有 schema 變更。

### 4.2 抽出 overlay 的 level 選擇並測試（約 10 分鐘，建議做）
- 現況：`ChartPanel.tsx` 內 `const level = ord.type === "STOP" ? ord.stopPrice : ord.price;` 只有實跑覆蓋。
- 做法：抽成 `orderLevel(order)` 放進 `chartHistory.ts` 同層（或新檔 `orderOverlay.ts`），用 3–4 條測試覆蓋
  STOP／LIMIT／MARKET（null）三型。
- 完成判據：`npx vitest run src/pages` 涵蓋該函式。

### 4.3 決定要不要處理「跨 bucket 軸跳」（需你選方案）
- 現象：每次跨 bucket，整條序列前移 k 個週期，圖表時間軸跳一次。這是 demo 假時間軸的固有性質。
- 方案 A（現狀）：尾端永遠落在現在，但每 k 週期跳一次軸。
- 方案 B：固定 delta，讓時間軸穩定；改由 demo feed 的 tick 往前長 bar。**需要把 live bar 序列保存進 store**，
  否則圖表重建時（換 TF／主題）會在 anchor 與現在之間留洞。成本約一天，屬獨立切片。
- 決策點：ANCHOR 政策要改的話，`candles.ts` 的 `shiftDelta` 與 `ChartPanel.tsx` 的 `payloadAnchorRef` 是唯二入口。

### 4.4 S1／S5 的結構性收尾（等真的有延遲資料源再做）
- 現況：base 在請求前讀取，把窗口縮到「請求到回應之間發生重錨」。demo 走 microtask，窗口為零。
- 要徹底消除，得讓 range 回應**自帶所用 base**（例如 `getCandles` 回 `{bars, anchor}`）。
  這會動 `services/demo/api.ts` → `services/api.ts` → `queries.ts` 的契約與全部呼叫端。
- 完成判據：一個延遲 stub（回應前先推進時鐘）跑接縫探針，`holes=0`。

### 4.5 ChartPanel 掛載測試（建議**不做**）
- 現況：loader 與 merge 已抽成純模組，元件級行為由那 12 條測試覆蓋。
- 剩下的元件專屬風險只有一個：`candles.length === 0` 的早退護欄（S3）。要測它需要 RTL + 假 lightweight-charts。
- 若要補，優先序低於 4.1–4.3。

---

## 5. 本輪踩到的新坑（別重複）

1. **舊 dev server 死了不等於埠被佔。** 先 `netstat -ano | grep LISTENING`。
   當時 5173–5176 完全沒有 listener，只有新起的 5177 有。
2. **harness 對已死的 service 仍可能報 `up`。** `curl` 的結果才是事實。
3. **`cmd /c 'tasklist /FI "..."'` 的雙引號會被 shell 層吃掉** → `Invalid argument/option - 'eq'`。
   別用 filter；改 `cmd /c tasklist /FO CSV` 再自家 grep，或寫 `.ps1` 用 `-File` 跑。
4. **在瀏覽器裡 `import("/src/services/demo/engine.ts")` 拿到的不是 app 正在用的實例。**
   驗 UI 行為一律走真實介面（下單面板），不要靠頁面內 import 讀狀態。
5. **`tab.run` 有 30 秒上限。** 一輪拖曳請控制在 15 次以內，否則整輪被砍、tab 可能被 kill。
6. **vite dev server 長跑會壞**（既有記載）：esbuild 子行程死掉 → 所有 module `net::ERR_ABORTED`。
   `node_modules` 沒壞，換埠重起即可，**不要 `npm i`**。

---

## 6. 已知限制（無自動測試或不確定）

- **S1／S5**：只可能出現在帶延遲的資料源；本 build 無 HTTP 資料路徑（`services/api.ts` 包 `demoApi`）。
- **軸跳**：見 4.3，屬設計取捨而非缺陷。
- **`candles.length === 0` 護欄**：只在元件層，無自動測試（見 4.5）。
- **實際像素層面的接縫外觀**：對抗驗證的 canvas 判定屬推論，資料層結論才是直接的。
