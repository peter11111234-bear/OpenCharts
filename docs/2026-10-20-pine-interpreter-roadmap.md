# Pine 直譯器：獨立驗證 + 優化/強化路線圖

> **日期：** 2026-10-20
> **作者：** Claude Opus（獨立複核；前一輪 2026-10-14～16 的優化未經本人驗證與規劃）
> **範圍：** `src/pine/` 直譯器。本檔不重抄 `docs/2026-10-13-remaining-work.md`，只做三件事：
> ① 核對前一輪說法 ② 記錄今天量到的新證據 ③ 依「對你看盤的影響 ÷ 成本」排序。

---

## 0. 量測方法與雜訊（先講清楚，數字才有意義）

| 雜訊來源 | 影響 | 處理 |
|---|---|---|
| vite-node 的檔案監看（`FSWatcher`） | 佔整份 CPU profile 33.7% | 量測工具自身開銷，產品不存在 → 分析時只看 `src/pine/` 內的 self time |
| 機器負載（量測時 DeepSeek 正在跑 vitest） | 同一腳本 500 根：955–1567ms，差 1.6 倍 | **絕對毫秒數只能在安靜機定案**；本檔結論只用「比例」（成長倍率、腳本間比值、同時交錯跑的對照） |
| 合成資料 vs 真實資料 | 已實測：同一時刻交錯跑 7 次取中位數，真實 MXF 5m 2.74 ms/bar、合成正弦 2.59 ms/bar | 差距在雜訊內 → **資料形狀不影響結論** |
| Node vs 瀏覽器 | 見 §2 F1：有一項成本只存在 Node | 以 Node 量到的數字推論瀏覽器時要扣掉 |

腳本：評分腳本 `src/pine/tech-rating.pine`（約 45 個 `ta.*` 呼叫，無 MTF、無 strategy）。
工具：`scratchpad/perf/rating-bench.ts`、`real-vs-synth.ts`、`prof.py`、`parents.py`（session scratchpad，未進 repo）。

---

## 1. 前一輪說法核對（2026-10-14 `docs/2026-10-14-pine-perf-align.md`）

| 說法 | 今天的核對結果 | 判定 |
|---|---|---|
| A1：`src/pine` 測試全綠 | 全套 `npx vitest run`：85 files / 1176 passed / **1 skipped** | ✅ 成立 |
| A2：golden 0 差異（文件寫「15 檔」） | `golden.test.ts` 的清單只有 **10 支**；其中 `norm2` 的原始檔 `C:/Users/bear9/OpenCharts/norm2.pine` **已不存在** → 被 `existsSync ? it : it.skip` **靜默跳過**（就是那 1 個 skipped）。實際比對的只有 9 支 | ⚠️ 部分成立：9/10 有比對、0 差異；「15 檔」對不上；norm2 無人察覺地失去保護 |
| H1：增量執行（incRun）適用每一支腳本 | `interpreter.ts:3293` 註解 "Eligibility: EVERY script" | ⚠️ 只核到程式註解；行為未獨立實測 |
| A3：K55 −61~64%、TRIS390 −49~53%、MACD701_v72 −45% | 需要舊版 baseline + 安靜機 + 同一份資料；且當時在 Node 量，含 F1 的灌水（灌水對前後兩邊大致等比，對「降幅」影響小，但絕對值偏高） | ❓ 無法獨立驗證（未重現） |
| A4：成長倍率 ≤ 2.2（排除超線性） | 評分腳本實測：1000/300 = 3.10（線性 3.33）、2000/1000 = 2.06（線性 2.0） | ✅ 在本腳本上成立（線性） |
| A6：增量 tick ≤ 100ms；TRIS390 107ms「邊緣」 | 前一輪自己標「需安靜機複測」，至今未複測 | ❓ 仍待複測 |
| JIT 為淨虧損（預設關閉） | 未重測 | ❓ 未驗證 |

**結論：** 正確性那一側（測試、golden）大致可信，但有一個真漏洞（norm2 靜默跳過）。效能百分比全部無法獨立重現，應視為「當時、那台機器、那個負載」的數字。

---

## 2. 今天的新發現（皆已實測）

### F1　`debugFlag` 每根 K 棒讀 3 次 `process.env`（只在 Node）
- 證據：profile 中 `debugFlag` 佔直譯器 self time **5.8%**；呼叫鏈 75% 來自 `udfJitDefault` ← `evalOneBar`，25% 來自 `evalOneBar` 本身（`evalCount`）。
- 原因：`evalOneBar` 每根 bar 重新解析 `evalCount`／`noJitUdf`／`jitUdf` 三個旗標；`debugFlag()` 在有 `process` 時逐一讀 `process.env`（Windows 上約 30µs/次）。
- **瀏覽器影響 ≈ 0**（無 `process`，該分支跳過）。**Node 影響**：所有 benchmark / golden / perf harness 數字被灌水約 5%。
- 修法：旗標在 `runScriptInner` 開頭讀一次存進 RunState，`evalOneBar` 不再呼叫。約 5 行。
- 價值：低（產品無感），但讓之後所有 Node 量測變乾淨 → **便宜就先做**。

### F2　每個 builtin 呼叫的固定成本偏高（真正的效能題目）
- 證據：同一台機器同一時刻，評分腳本 1.9 ms/bar；只有一個 `ta.sma` 的腳本 0.062 ms/bar → 約 **40µs／呼叫／根**。瀏覽器裡一樣存在。
- profile（只計 `src/pine/`）：`interpreter.ts` 48%、`ta.ts` 24%、`math.ts` 6%。前幾名分散：`evalCallDispatch` 6.6%、`evalNode` 5.8%、`invokeBuiltin` 4.7%、`ta.get` 4.3%、`evalArg` 3.4%、`callBuiltin` 2.7%、`vsOf` 2.3%、`bindArgs` 2.1%、`stateFor` 1.7%、`lookup` 1.5%。
- 解讀：**沒有單一熱點**，是樹走訪直譯器「每呼叫：分派 → 包參數 → 綁定 → 查狀態」的固定開銷。前一輪 G.2 的 H3（`evalArg` 包 series）、H4（每 bar 配置）是同一件事的一部分。
- 對你的影響：300 根算一次 0.6–0.9 秒。評分面板已經放進 Worker，所以不卡畫面；但多支指標同時開、或 live tick 時會累加。
- 方向（需另寫 REAL PLAN，含安靜機 baseline）：每個呼叫點在第一次執行時把「builtin 函式 + 參數綁定表 + ta 狀態槽」解析一次並快取在 AST 節點上（沿用既有 `RESOLVED_BUILTIN`／`PARAM_FLAGS` 的 WeakMap 慣例），之後每根 bar 直接走預綁定路徑。目標：評分腳本 ≤ 1 ms/bar。
- 風險：中。golden 9 支 + 全套測試是安全網；先修 F3 讓安全網完整。

### F3　golden 安全網有洞
- `norm2.pine` 不見了，`golden.test.ts` 用 `it.skip` 靜默跳過。之後做 F2 這種大改動時，norm2 涵蓋的行為（`request.security` 的 1m 動態分支）沒有保護。
- 修法（二選一，需要你決定）：找回 `norm2.pine`；或改成「原始檔缺少 → 測試失敗」，並把 norm2 從清單移除，同時寫明原因。
- 價值：高（F2 的前置條件），成本：極低。

### F4　可以自動化的 TradingView 數值對照（解決待辦 D1「新 `ta.*` 沒有 TV 數值 oracle」）
- 實測 `scanner.tradingview.com/symbol` 可回傳 `TWSE:2330` 的 `RSI`、`MACD.macd/signal`、`Stoch.K`、`CCI20`、`ADX`、`AO`、`Mom`、`W.R`、`UO`、`EMA20`、`SMA200`，以及 `Recommend.MA/Other/All`（即 TV 的技術評分）；加 `|60`、`|15`、`|5` 後綴可取盤中週期。
- 用法：同一商品、同一週期，用 Shioaji K 棒跑我們的 `ta.*` 與 `tech-rating.pine`，和 TV 數值比對（容差制；EMA 類需足夠暖機）。
- 這是目前唯一能**自動**對 TV 數字的管道，原本 D1 寫的是「只能人工在 TV 對數字」。
- 限制：這是 TradingView 未公開的內部端點，可能隨時變動；只適合個人開發時的對照工具，不進產品路徑。K 棒來源不同（TV vs 永豐）會有小差異，所以要用容差，不做逐位比對。

---

## 3. 強化（非效能）, 從既有待辦中挑出「會讓你看錯數字」的

| # | 項目（來源） | 為什麼重要 | 成本 |
|---|---|---|---|
| S1 | D10：副窗 `plotshape` 預設 `location.belowbar` 會把 K 棒價格折進副窗座標軸（`remaining-work.md` D.10） | 副窗指標被壓成一條線，**看起來像指標壞了** | 中（要重生成 golden） |
| S2 | D5：44 個繪圖存取函式不看具名參數，例如 `line.delete(id = l)` 會靜默不做事 | 腳本行為和 TV 不同，而且**沒有任何警告** | 中（逐函式對簽章） |
| S3 | D11：point 型 setter 遇到 na 是 no-op，舊端點仍然留在圖上 | 畫面殘留舊線 | 低 |
| S4 | D2：`log.*` 沒有輸出面板 | 除錯 Pine 腳本時看不到 log，修 bug 變慢；剛好可以用 VELA 的 `registerSidePanel` 做，和技術評分面板同一套模式 | 低–中 |
| S5 | D8：`tz.ts` 的 Intl 快取無上限 | 惡意或寫壞的腳本可以讓記憶體一直長 | 低 |

---

## 4. 建議順序（影響 ÷ 成本）

| 順序 | 項目 | 成本 | 為什麼排這裡 |
|---|---|---|---|
| 1 | **F3** golden 安全網補洞 | 10 分鐘 | 之後所有改動的前提；需要你決定 norm2 要找回還是移除 |
| 2 | **F1** `debugFlag` 每次執行只讀一次 | 30 分鐘 | 讓之後的量測數字乾淨 |
| 3 | **F4** TV 數值對照工具（先用在 `tech-rating.pine` 和 10 個常用 `ta.*`） | 半天 | 同時驗證評分面板和 `ta.*` 的正確性，直接解決 D1 |
| 4 | **S1** 副窗 plotshape 座標軸 | 半天 | 最常見、最像「指標壞掉」的視覺錯誤 |
| 5 | **S4** Pine log 面板 | 半天 | 你說「遇到問題再修」，log 面板會讓每次修 bug 都比較快 |
| 6 | **F2** 呼叫點預綁定（大改，需另寫 REAL PLAN、安靜機 baseline） | 2–3 天 | 唯一能讓瀏覽器裡真正變快的項目；要先完成 1、2 |
| 7 | S2、S3、S5 | 各半天內 | 遇到相關腳本時再做 |

**不建議做的：** 為了清除 vite-node 的檔案監看雜訊去改量測工具。直接在分析時排除就好，改了沒有收益。
