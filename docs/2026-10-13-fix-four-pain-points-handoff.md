# 交接：解四條痛點（S1–S4）＋ PyneCore 對照表

日期：2026-10-13 ｜ 專案：`C:\Users\bear9\OpenCharts`（Pine Script v6 直譯器在 `src/pine/`）

---

## 0. 接手前必讀（環境陷阱，每個都會浪費你半小時）

1. **測試必須從 realpath 跑**：`cwd=C:/Users/bear9/OpenCharts`。
   `C:\Users\bear9\MYOPENCHART\OpenCharts` 是**指向它的 junction**；從 junction 路徑跑 vitest 會出現
   `Failed to load url .../src/__tests__/setup.ts`（假錯誤，檔案其實存在）。兩條路徑是同一份，git HEAD 同為 `f41f6bb`。
2. **`src/pine/` 有兩份複本**：`OpenCharts/src/pine/` 與 `MYOPENCHART/pine-interpreter/`（`diff -rq` 相同）。改動只做在 `OpenCharts/src/pine/`。
3. **子代理在本機不可用**：`task`/scout 一律回 `No model selected`（8/8 次失敗）。別再派，直接自己做。
4. **`tsc` 有 108 個既有錯誤**，全在未觸碰的測試檔（`parser.test.ts`、`alias_repro.test.ts`、`perbar_color.test.ts`、`probe_bare_ta.test.ts`…）。基線就是紅的，別試圖修，也別用它判斷自己的改動。
5. **git 是 Windows 原生**：`git -C /c/...` 不認 MSYS 路徑，要用 `C:/Users/...`。

## 1. 本次交付

### 1.1 PyneCore 對照表（研究交付，未 commit）
- `docs/pynecore-conformance.html` — 互動報告（56 條對照 + 18 條「值得借鑒」）
- `docs/pynecore-conformance.json` — 同資料機器可讀
- `scratch/_gen_conformance.py` — 生成器（改資料後重跑即可）
- 證據皆取自實際程式碼（實測註冊表 412 builtins / 189 constants / 61 個 ta），**不採信 PROGRESS.md 的敘述**。

### 1.2 S1 容差比對（golden 從「快照」回到「防護」）
- `src/pine/__tests__/golden.ts` — 新增 `compareSnapshots()` + `GOLDEN_ABS_TOL`/`GOLDEN_REL_TOL`（1e-9）；
  精確鍵（`index`/`id`/`bars`/`count`/`size`/`qty`/`tradeId`/`bar`/`i`/`time`）**不接受**容差；
  `null`（na）只等於 `null`；失敗訊息給出**差異路徑數、前 5 條路徑、max|Δ|、max relΔ**。
- 刪除 dead `firstDiff()`；`goldenCheck(name, r, opts?)` 簽名向後相容。
- 驗證：`golden.test.ts` 新增 5 條比較器單測（sub-tolerance 通過、1e-3 指出路徑、na≠0、整數鍵精確、缺鍵）。

### 1.3 S2 未支援參數顯性化
- `src/pine/builtins/strategy.ts` — `STRATEGY_UNSUPPORTED_PARAMS`（10 個：`calc_on_order_fills`、`calc_on_every_tick`、`max_bars_back`、`backtest_fill_limits_assumption`、`slippage`、`close_entries_rule`、`margin_long`、`margin_short`、`risk_free_rate`、`use_bar_magnifier`）+ `strategyDecl()` 內 `warnOnce`。
- `src/pine/builtins/draw.ts` — `INDICATOR_UNSUPPORTED_PARAMS`（`max_bars_back`、`backtest_fill_limits_assumption`、`max_circles_count`）+ `warnUnsupportedIndicatorParams()`。
- `src/pine/interpreter.ts` — 兩處呼叫點（`evalNode` 的 `indicator` 分支、`buildSess`）。
- **真實效果**：TRIS390 現在回報 `strategy(): 'calc_on_every_tick', 'slippage' declared but not implemented`；MACD701／見高K4.55／TD_BB／高量1.46／MACD701_v72 回報 `max_bars_back`。
- `engine.ts:376` 已有 `handlers.onWarning` → 警告會到 UI。

### 1.4 S3 浮點比較容差
- `src/pine/interpreter.ts` — `CMP_EPSILON = 1e-10`（Pine 的**絕對**容差，邊界值算相等，來自 PyneCore 在 TradingView 上的量測）；
  `evalBinary` 的 `<` `>` `<=` `>=` 與 `valueEq` 的 `==` `!=` 走容差；**int 走精確路徑**（零額外成本）；
  `<=`/`>=` 保留 raw 比較在前（兩個相等 infinity 的差是 nan）。
- **`ta.crossover`/`crossunder`/`highest` 等 builtin 保持位元精確**（規格明載，測試有守）。
- 驗證：`interpreter.test.ts` +5 條（sub-tolerance 六運算子、supra-tolerance、邊界 1e-10、整數、crossover 不受影響）。

### 1.5 S4 session 與時間網格
- 新增 `src/pine/builtins/session.ts` — `session.*` 全部 7 個（`ismarket`/`ispremarket`/`ispostmarket`/`isfirstbar`/`islastbar`/`isfirstbar_regular`/`islastbar_regular`）+ 4 個常數；venue 表 TWSE/TPEx 09:00–13:30、TAIFEX 08:45–13:45（其他 venue = 24 小時）。
- `src/pine/builtins/time.ts` — `time(timeframe, session, timezone, bars_back)` 與新增 `time_close(...)`；`zonedMs`/`part` 改為匯出；session 視窗、前一交易日、`gridBack` 走法。
- `src/pine/builtins/index.ts` — 註冊 `./session`。
- 驗證：新增 `src/pine/__tests__/session.test.ts`（11 條，含 09:00 開盤、13:00 為最後一根、14:00 不在市場、24h venue、`time`/`time_close`、intraday 形式、bars_back 走法與跨年）。

## 2. 驗證狀態（全部在 realpath 跑）

| 項目 | 結果 |
|---|---|
| `golden.test.ts`（含 5 條新比較器單測） | **14 passed / 1 skipped**（`final`/`norm2` fixture 不存在→skip） |
| `interpreter.test.ts` | **69 passed** |
| `strategy.test.ts` | **42 passed** |
| `builtins.test.ts` | **57 passed** |
| `session.test.ts` | **11 passed** |
| `UPDATE_GOLDEN=1` 重生成後再驗 | 綠（穩定） |
| `tsc` 我的檔案（session/time/strategy/draw/index/interpreter/golden/session.test/strategy.test/interpreter.test） | **0 errors**（108 個既有錯誤全在未觸碰的檔案） |
| 全套 `vitest run src/pine` | **46 files / 806 passed / 1 skipped**（186s） |
| e2e 真實腳本（使用者可見面） | `e2e1`(MACD701)、`e2e2`(K455) 的 stdout 出現 `indicator(): 'max_bars_back' …` → S2 確實到達執行路徑（`engine.ts:376` 的 `handlers.onWarning`） |

## 3. golden 基線變更（**需要 review 後才 commit**）

`UPDATE_GOLDEN=1` 重生成，只有 6 個檔案變動：`MACD701`、`MACD701_v72`、`TD_BB`、`TRIS390`、`見高K4.55`、`高量1.46`。
**變更原因只有一個：S2 新增的警告**——比對報告顯示 `max|Δ|=0`（數值零差異），差異只有 `warnings` 陣列。
其餘 3 個（`final`、`turtle`、`MACD雙周期V7`）內容未變。
> S3 的容差改動對這 10 個真腳本的繪圖值**沒有任何影響**（已驗證）。

## 4. 未完成 / 已知限制

1. **跨年 D/W 網格走法未實作**：`gridBack()` 只做年內算術；跨年時回傳算術值並 `warnOnce`（訊息含 "turn of the year"）。
   PyneCore 有量測過的規則（`_tv_week_walk`/`_tv_day_walk` 的 mirror 規則），要補就照那份文件。
2. **`session.ispremarket`/`ispostmarket` 一律 false**：本 app 無 extended-hours 資料源（`syminfo.session` 固定 `'regular'`），刻意不猜。
3. **`matrix.*` / `log.*` / `strategy.risk.*` 仍缺**（見對照表 missing 8 條）。
4. **什麼都沒 commit**：15 個已追蹤修改 + 2 個新增檔仍在工作區。

## 5. 建議下一步

1. review 那 6 個 golden 檔的 diff（應只有 `warnings` 欄位）。
2. commit（訊息建議：`pine: S1 tolerant golden compare, S2 unsupported-param warnings, S3 Pine 1e-10 comparison tolerance, S4 session.* + time/time_close`）。
3. 接著做對照表裡 `partial` 的 15 條（優先：`strategy.risk.*`、`margin_long/short`、`slippage` —— 因為它們會讓回測數字失真）。

## 6. PyneCore 可再借鑒的機制（已排除已做的 S1–S4）

已驗證**不需要**重做：CE10188 plot-scope 規則（`builtins/util.ts:75-85`，但只是 runtime warn-and-skip）、未讀歷史參數不加 callHist（`paramFlags needsHist`，與 PyneCore 的 `UnusedSeriesDetector` 同向）。

### A. 立即可整合

| 項目 | PyneCore 的做法 | 整合點與收益 | 成本 |
|---|---|---|---|
| **編譯期語言規則檢查** | `PlotScope`／`OuterWrite`／`ExportCapture`／`SecurityDrawings` 是四個 compile-time reject（附位置） | 你目前只有 CE10188 且是 runtime 跳過；另外三個完全沒有。提升為 parse 後的 AST 掃描 → Vela 可在存檔前報錯 | 1–2 天 |
| **`ScriptRequirements`** | 靜態偵測策略需要的 broker 能力 | `engine.ts:225` 的 `capabilities` 目前是固定值。掃 AST 得出「需要 request.security／下單／drawing 配額」→ 對 shioaji 實盤路徑是安全閘 | 0.5–1 天 |
| **保留識別字命名空間 + 守衛測試** | 注入名一律帶 `·` 或 `__pyne_*__`，`test_129_pipeline_names.py` 保證任何新的 `__x__` 字面值都被登記 | 你的 JIT 產 `__ret`、全域開關 `__pineStage`/`__pineJit*` 散落。要做任何 codegen 就需要這條（PyneCore 明說變數 `__bool1__` 會被生成物遮蔽） | 0.5 天 |
| **合成的節點一律帶位置** | 最後一個 pass `FixLocations` 給所有合成節點補位置，錯誤永遠有行號 | 檢查 `errors.ts`/parser/interpreter 的合成節點是否都有 `loc`；沒有就會退化成無行號錯誤 | 0.5 天 |

### B. 值得但要設計

- **常數摺疊 + 型別 stamp**（PyneCore 的 `ConstFold` + `PineType`）：影響 `const`/`simple`/`series` 判斷，進而影響 `request.security` 的 tf 參數合法性與 `input` 的常數性——你目前靠 runtime 猜。3–5 天，風險高。
- **fused phases + sequential 等價驗證**：多個 AST 規則共用一次 traversal，並用 `PYNE_AST_SEQUENTIAL=1` 證明融合前後輸出逐位元相同。**與 A 的編譯期檢查一起做**（先分開寫、再加融合）。
- **統一的除錯開關**（PyneCore: `PYNE_AST_TIMING`／`PYNE_AST_SEQUENTIAL`）：你現在是零散的 `__pineStage`／`__pineEvalCount`／`yieldStats`。0.5 天。
- **broker plugin 介面**（PyneCore 有 `plugin-system.md` 33KB + `broker-plugin-authoring.md` 31KB）：`services/shioaji/orders.ts` 目前標「Phase 1 live order gateway (simulation account)」；先定下單/查詢/回報抽象，避免券商細節滲進策略層。需設計。

### C. 只在你要做 X 時才值得

- **syminfo 由外部 metadata 驅動**（PyneCore: per-symbol TOML）：你的 `buildSyminfo` 是硬編碼 14 欄位 + TW 特例；要支援美股/加密才值得。
- **資料下載 CLI + `.ohlcv` v2 格式**（int64 ms + float32 delta + tick grid snap）：若要把歷史資料離線化或加速載入。
- **bytecode／pipeline hash 快取失效**：若要做「跨 session 的編譯結果快取」（目前 `modelCache` 是內容衍生，但沒納入規則版本）。
