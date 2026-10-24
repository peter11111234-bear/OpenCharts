# Pine 直譯器 F2：每個 builtin 呼叫的固定開銷（規劃稿，未核准、未動工）

日期：2026-10-24 · 範圍：`src/pine/interpreter.ts`、`src/pine/builtins/util.ts` · 狀態：**已定案並完成 env 修法（做法 B，見第 2.9 節）；builtin 分派（步驟 1–3）不做**

> 2026-10-24 完成：env 修法已實作並通過測試（`2026-10-24-pine-udf-jit-flag-snapshot.md`），前後比較見第 2.9 節。路線圖的 40 µs 與 1.9 ms 已加註記。改動尚未 commit。

## 1. 結論先說

- 路線圖（`docs/2026-10-20-pine-interpreter-roadmap.md`、myopenchart `pine-interpreter.md`）寫的「每個 builtin 呼叫約 40 µs」與「評分腳本 1.9 ms/bar」**無法重現**。今天在目前程式碼上量到每次 builtin 呼叫約 **3 µs**（負載未受控，僅供量級參考）。
- 每根 bar 的固定成本，**主因已找到且已覆核**：每根 bar 讀取 2 次 `process.env`（`interpreter.ts:3033` → `debugFlags.ts:80`），單次讀取約 25–32 µs，兩次約佔輕量腳本每根的近一半。
- 技術評分腳本（44 個 `ta.*` 呼叫點）在低負載下 370 µs/bar、env 佔約 13%；在 100% 負載下 0.92 ms/bar。**絕對值受負載影響很大，目前沒有可以定案的評分腳本基準。**
- builtin 分派（F2 原本的目標）每次約 3 µs，即使全部省掉，對評分腳本的收益也有限。
- 結論：**真正值得先做的是 env 讀取的修法（需要你核准語意變化，見第 7 節）；F2 的分派優化排在後面，只在安靜機器上量到明確收益時才做。**

## 2. 實測證據（2026-10-24，單一 Node 行程，`npx vite-node`）

> 注意：本節是第一輪量測，**負載未受控**，只供量級參考。env 佔比與評分腳本數字以第 2.5、2.6 節為準。

方法：3000 根合成 bar，每個腳本跑 8 次取最小值；比較「額外呼叫 N 次」與「不加呼叫」的差，再除以 `3000 × N`。

| 腳本 | 最小耗時 (ms) | 備註 |
|---|---|---|
| base：`plot(close)` | 242 | 固定開銷 ≈ 80 µs／bar |
| nz0：40 條 `plot(close)` 不含呼叫 | 192 | 波動約 ±20% |
| nz10：10 個 `nz(close)` | 328 | ≈ 2.9 µs／呼叫 |
| nz40：40 個 `nz(close)` | 693 | ≈ 3.8 µs／呼叫 |
| sma10：10 個 `ta.sma(close, i+2)` | 328 | ≈ 2.9 µs／呼叫 |
| sma40：40 個 `ta.sma(close, i+2)` | 561 | ≈ 2.7 µs／呼叫 |

注意事項：
- 第一次版本的 `ta.sma` 全部用同一個週期 20，結果 sma10 看起來沒有成本，疑似重複的 callsite 被快取。改成每個 callsite 不同週期後才穩定，**以後量測都要讓每個 callsite 的參數不同**。
- 這是單次量測、單一機器，絕對值會隨負載漂移。要下決定前，應該在**相同負載**下重跑，並用 `perf_bench.test.ts` 或 Node `--cpu-prof` 做交叉驗證。

## 2.5 步驟 0 結果（2026-10-24，子代理剖析 + 我獨立覆核）

**主要來源找到了：每根 bar 的 `process.env` 讀取。**

- 呼叫鏈：`evalOneBar`（`interpreter.ts:3033`）每根 bar 執行 `run.udfJitOn = udfJitDefault()` → `udfJitDefault`（`interpreter.ts:2311`）呼叫兩次 `debugFlag`（`noJitUdf`、`jitUdf`）→ `debugFlag`（`debugFlags.ts:80`）在全域旗標未設定時讀 `process.env.PINE_JIT_UDF`。
- 兩個旗標都以 `PINE_JIT_UDF` 為 env 來源（`debugFlags.ts:41`、`:45`），所以**每根 bar 是 2 次 `process.env` 讀取**。
- 微基準（我覆核）：`process.env` 讀一次約 **23–32 µs**（依負載而異），普通物件讀取約 0.03 µs。兩次約 46–64 µs。
- 剖析：`debugFlag` 自身時間約 57%，其他 `src/pine/` 函式皆 <2%。

**這個結果改變了優先序，但要誠實看待它的規模：**

- 對輕量腳本（例如只有 `plot(close)`）是大頭，固定開銷可砍掉約八成。
- 對技術評分那類重腳本（約 2 ms／bar），每根省 ~64 µs 只約 **3%**。所以它不是重腳本的主要瓶頸；重腳本的成本仍在 builtin 呼叫本身，F2 原本的目標。
- 對照實驗（子代理，最終版）：以普通物件取代 `process.env` 後，3000 根從 133.6 ms 降到 17.2 ms，約 **7.8 倍**（只針對 `plot(close)` 的輕量腳本）。基線每根約 42–45 µs，近似線性，無明顯固定常數。
- 修法前必查：`__tests__/debug_flags.test.ts` 會逐次切換 `globalThis`／env 並期待立即生效，快取前要先確認這個測試的預期。

**修法與需要你決定的取捨**（尚未實作）：

- **做法 A（建議）**：在 run 開始時讀一次 `udfJitDefault()`，之後每根 bar 直接用 `run.udfJitOn`。
- **語意變化**：`interpreter.ts:3030-3031` 的註解寫明「live session 的 tick 之間切換旗標，會落在下一根 bar」。做法 A 會讓切換改到**下一次 run** 才生效。這些旗標是開發用開關，正常使用者不會在盤中切換，但這是刻意的設計，要你同意才改。
- **不建議做法 B**（讓 env 讀取本身變快）：測試可能在執行期改 `process.env`，改了會破壞既有行為。

## 2.6 覆核結果（2026-10-24 下午，負載 94%→17%，已停 OpenCharts 的 vite 5173）

| 項目 | 結果 |
|---|---|
| 每根 bar 的 `process.env` 讀取次數（Proxy 計數，不改 src） | **2.00／bar**，輕量與技術評分腳本一致 |
| 單次 `process.env` 讀取（同行程） | 約 25 µs |
| `plot(close)` 輕量腳本，1000 根 | 108 µs／bar，env 估計佔 **46%** |
| `tech-rating.pine`，1000 根 | 370 µs／bar，env 估計佔 **13%** |
| `perf_bench.test.ts`（單檔） | 5／5 通過；但它量的是 MTF 的計算次數，不是時間，**無法交叉驗證 env 佔比** |
| `tech-rating.pine`，300 根，中位數 7 次，交錯跑（覆核量測） | 0.92 ms／bar（輕量腳本 0.095）；**負載 100%，不可信為基準** |

結論：
- 「每根 2 次 env 讀取」已確認，與負載無關。
- env 佔比依腳本而定：輕量腳本很大，技術評分腳本約 13%。之前子代理的「7.8 倍」只適用於輕量腳本，不能外推到技術評分。
- 技術評分在本次量測是 370 µs／bar，比先前記的 2–2.7 ms／bar 小很多。可能是 bar 數或腳本不同，要確認。
- 負載在量測時波動很大（94%→17%），絕對值只能參考比例。

## 2.7 安靜機器重測（定案依據，2026-10-24 晚間）

條件：`antigravity-tools` 與 vite 5173 已停；量測前負載 37%、量測後 41%、單次 `process.env` 讀取 20 µs（同時量）。`tech-rating.pine` 300 根，兩批各中位數 7 次，腳本交錯執行。

| 批次 | 輕量 `plot(close)` | 技術評分 | 比值 |
|---|---|---|---|
| 1 | 0.047 ms／bar | **0.343 ms／bar** | 7.3× |
| 2 | 0.042 ms／bar | **0.275 ms／bar** | 6.5× |

換算：每根 2 次 env 讀取 ≈ 40 µs。
- 技術評分：40 µs ÷ 275–343 µs ≈ **12–15%**（與第 2.6 節的 13% 一致）。
- 輕量腳本：40 µs 已接近總耗時 42–47 µs，即 env 幾乎就是全部固定成本。

這推翻了路線圖的兩個數字：
- **1.9 ms/bar 不是現在程式碼的實測值**。安靜機器上技術評分約 0.3 ms/bar，約為路線圖的六分之一。
- 路線圖的「40 µs／呼叫」同樣無法重現（見第 2 節，約 3 µs）。

結論：env 修法對技術評分的收益約 12–15%，對輕量腳本接近全部。builtin 分派的優化（步驟 1–3）目前沒有證據值得做。

## 2.8 執行前的新發現（阻擋派工）

- `RunState` 在 `interpreter.ts:264` 建立時就呼叫 `udfJitDefault()`，註解寫明是「MTF 子框架的初始值」。
- `evalOneBar` 每根 bar 重新讀取（`interpreter.ts:3033`）。live session 的 `PineSess` 會跨 tick 保留同一個 `RunState`。
- 因此如果把每根 bar 的讀取拿掉，**切換旗標會等到下一個 session 才生效**，比第 2.5 節說的「下一次 run」更嚴格。
- `__tests__/debug_flags.test.ts` 只直接測 `debugFlag()`，不受影響。

**需要你選一個做法（做法 A 會改變你已核准的語意）：**

- **做法 A**：刪除 `interpreter.ts:3033`，旗標只在 session 建立時讀一次（env 與 globalThis 都是）。切換旗標要開新 session。
- **做法 B（建議）**：每根 bar 只讀 `globalThis`（約 0.03 µs，開發工具用的就是這個），env 只在 session 建立時讀一次。這樣 globalThis 的切換仍然是逐 bar 生效，只有改環境變數才要開新 session。

在你選定之前，我不會派 DeepSeek，因為目前還沒有可以逐字照抄的執行計畫。

## 2.9 實作後的前後比較（2026-10-24 晚間，已完成）

做法：把 HEAD 的 `src/pine` 匯出到暫存資料夾作為「改動前」，與工作區「改動後」在同一個 Node 行程裡交錯執行（每輪前後連跑），各取中位數 7 次。量完已刪除暫存檔。

| 腳本 | 第 1 次 | 第 2 次 |
|---|---|---|
| 輕量 `plot(close)` | 0.048 → 0.008 ms/bar（**−83%**） | 0.048 → 0.009 ms/bar（**−81%**） |
| 技術評分 `tech-rating.pine` | 0.355 → 0.275 ms/bar（**−23%**） | 0.384 → 0.258 ms/bar（**−33%**） |

負載：第 1 次量測時 60–71%，第 2 次 70% → 9%。兩次方向一致，幅度受負載影響。

結論：
- 輕量腳本的固定成本幾乎全部消失。
- 技術評分省約 23–33%，比第 2.7 節預估的 12–15% 高，原因應該是量測時負載下 env 讀取比安靜時更貴，但我沒有直接量證。
- 正確性：第 2.8 節所列的 101 個測試已通過。

## 3. 現況（程式碼核對）

已經做過的最佳化（不必再做）：
- `evalCallDispatch`（`interpreter.ts:1335-1362`）：`member` 形式的 builtin 解析結果以 `RESOLVED_BUILTIN` 每個 Call 節點快取一次。
- `invokeBuiltin`（`interpreter.ts:1440`）：無 named 參數時共用 `EMPTY_NAMED` 凍結物件，不每次配置 `{}`。
- `bindArgs`（`builtins/util.ts:201`）：全位置參數走快速路徑，不呼叫 `Object.keys`。

仍然每次呼叫都會執行的工作（F2 的目標）：
1. `evalCallDispatch` 對裸名稱呼叫：每次 `BUILTINS.get(callee.name)`（`:1424`）。
2. `invokeBuiltin`：每次 `node.args.some(...)`（`:1445`）、`HIST_BUILTINS.get(b)`（`:1448`）、每個參數的 `histSpecHas(...)`。
3. `evalArg`（`:1583`）：每個參數每根 bar 都做 `runOf(ctx)`、`seriesOf(scope, name)`、`ctxSeries(...)`、`siteKey(...)`、`callHist.get(...)`。
4. `callBuiltin`（`:1458`）：每次 `SCALAR_BUILTINS.get(b)`，`flushBindWarnings` 每次呼叫都會 `drainBindWarnings()`，外加 `try/finally`。
5. 內建函式本身：`bindArgs` 每次配置一個 `Map`。

## 4. 方案（由便宜到貴）

| 步驟 | 內容 | 預期收益 | 風險 |
|---|---|---|---|
| **0** | ✅ 已完成（見第 2.5、2.6 節）：主因是每根 bar 2 次 `process.env` 讀取 | 已找到 | 無（唯讀） |
| **1** | 每個 Call 節點快取「解析後的 fn、histSpec、scalarSpec、是否有 named」四項，每根 bar 直接用 | 估計每次呼叫省 0.5–1 µs（**未實測，只是估計**） | 低；注意 scope 重綁（已有註解說明 builtin 在首次分派後不會再出現） |
| **2** | `flushBindWarnings` 只在佇列非空時才 `drain`（目前已有空佇列提早返回，只需確認 `drainBindWarnings` 本身沒有配置） | 很小 | 低 |
| **3** | 內建函式的 `bindArgs` 改成固定槽位陣列，不用 `Map` | 視內建函式而定 | 中；影響所有 builtin，要跑完整 Pine 測試 |

建議：步驟 0 已完成。下一步是 **env 讀取修法（做法 A，見第 2.5 節）**，需要你核准語意變化。步驟 1–3 等安靜機器上量到明確收益再決定，目前不做。

## 5. 驗收方式

- 效能：沿用本文第 2 節的方法，在同一機器、相同負載下，改動前後各跑 3 次取最小值。**沒有至少 15% 的改善，就不合併。**
- 正確性：只跑 `src/pine/__tests__/` 中與 builtin 分派相關的檔案（`named_args.test.ts`、`strategy.test.ts`、`builtins.test.ts`、`interpreter.test.ts`、`golden.test.ts`）。**不跑全套 vitest**（2026-10-20 事故）。
- 增量一致性：`inc-parity.test.ts` 必須通過（增量與全量結果一致）。

## 6. 不做的事（Nevers）

- 不 commit、不 `git add -p`、不 stash、不 reset。
- 不碰 `vite.config.ts`、`src/services/guard/*`、`VelaPage.tsx`（見 `agent-workflow.md`）。
- 不改 `VIEWPORT_NAMES`、`alertcondition`、`capabilities.streaming`（見 `2026-10-24` 審查清單的「刻意設計」）。
- 不為了加速而移除 `warnings` 或 `bindWarnQ` 的行為。

## 7. 定案前待決定（三項）

1. **核准做法 A 的語意變化**：每次 run 開始時讀一次旗標，切換旗標要等下一次 run 才生效（現行是下一根 bar）。同意嗎？
2. ✅ **安靜機器的量測**：已完成（見第 2.7 節）。技術評分 0.275–0.343 ms／bar，env 佔約 12–15%。
3. **路線圖的「40 µs／呼叫」與「1.9 ms/bar」要不要改註記**：目前無法重現，我建議在路線圖加上「條件不明、待重測」的註記，免得之後照舊數字做決定。

定案條件：第 1 項（語意變化）與第 3 項（路線圖註記）完成後，第 1 節的數字已可以直接用第 2.7 節的結果更新，即可標為定案。
