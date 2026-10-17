# T6①（P6）圖表時框 × 圖表標的 `request.security` 快路徑 — REAL PLAN

- **版本**：**v2**（2026-10-16；v1 經 advisor 複核後修正設計級錯誤，見文末〈附錄 A：v1→v2 變更〉）
- **狀態**：🔒 待使用者核准後才進 P6 Execute
- **範圍**：`src/pine/mtf.ts`（單檔）＋新增測試；**不改** Vela 本體、不動 `src/pine/builtins/*`
- **依據**：Round-1 五軸（可行性／風險／模式／量測基線／Vela 上游）＋ Round-2 四節（狀態隔離／feed 對照／閘控呼叫點／checkpoint 註冊面）＋ advisor 批判複核

---

## 0. 問題與目標

`request.security(syminfo.tickerid, <圖表時框>, expr)` 目前與一般 HTF security 同路：建私有 tf 幀（`mtf.ts:1145-1218`）→ 首次命中暖機重播（`mtf.ts:2185-2188`）→ **之後每根圖表 bar 仍要重算 expr 的 producer 鏈**（圖表讀取 → `SecSeries.cur()` → `TfGlobalSeries.at(j)` → `evalAt`，`mtf.ts:876-892`）。tf == 圖表時框時 tf 幀只是圖表的複製品，這些成本全屬浪費。

### 量測基線（本輪實測）

| 腳本 | total evals | tf=5（圖表時框） | 每 bar | 來源 |
|---|---:|---:|---:|---|
| `C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine` @100 | 899 | **898（99.9%）** | ≈9 | `scratch/perf/mtf-perspec-macd701.json` |
| `src/pine/TRIS390.pine` @100 | 626 | 307（49.0%） | — | `scratch/perf/mtf-perspec-optimized.json` |

> 更正：舊筆記把 `626／307` 標成 MACD701_v72 是**標籤錯**（該產物自述 `script=src/pine/TRIS390.pine`）。
> **成本歸因更正**：898 不是「一次性暖機」，而是**每根圖表 bar 重複重算 producer 鏈**（898/100 ≈ 9 evals/bar）。真實收益＝把這 ~9 次 tf 域求值換成圖表域既有序列的歷史讀取。

---

## 1. 驗收標準

| # | 條件 | 路由 |
|---|---|---|
| **A1** | **主效能指標＝`counters.evalNodeCounts.total` 明顯下降**（它計 tf 域＋圖表域兩側的**所有**節點求值，無法靠換域灌水；`scripts/perf/lib/counters.mjs:22-33`）。MACD701_v72 @100 現值 139,264 | code |
| A1b | 輔助：`mtf.evals` 下降（**僅視為「快路徑生效」的旁證，不是效能證據**）；`per-spec invocations` **不變**（控制組）；`cwPushes`/`cwPeak` **不得上升** | code |
| A1c | wall-clock（`pine-bench` 的 `run`/`total` ms）同指令前後對照；標註 `NOISY` | code |
| A2 | digest `ze7byn`／`kb0glc`／`1580h2`／`p4gddl` 逐字不變 | code |
| A3 | `npx vitest run src/pine` 全綠；`npx tsc --noEmit` rc=0 | code |
| A4 | `s1-inc-probe` 收尾 `PARITY OK` | code |
| A5 | golden 0 差異 | code |
| A6 | 不符條件者行為與數值完全不變 | code |

---

## 2. 快路徑條件

### 2.1 靜態（每 spec 一次，memo 於 spec 欄位）

1. `!spec.isLtf`
2. `spec.gaps === 'off'`（`mtf.ts:184`）
3. `spec.lookahead === 'off'`（`mtf.ts:185`）
4. `spec.sym !== DYNAMIC`
5. **每個 expr 通過「純讀 whitelist」**（§2.3）

### 2.2 每根（在插入點判定）

6. `sym === CHART_SYM || sym === chartTicker`（`mtf.ts:155`／`:342`／`:653`）
7. `tf === ctx.timeframe.period` — **原字串全等**（禁用 `tfString`/`tfParts` 正規化）
8. **invoking ctx 必須是圖表 ctx**：`ctx.timeframe.mainPeriod === ctx.timeframe.period`
   （理由：security 表達式內的巢狀 security 在外層 **tf 幀**求值，該幀的 `period` = tf、`syminfo` = 被請求標的（`mtf.ts:1203-1205`、`mainPeriod` 轉傳於 `:1214`），否則條件 6/7 會在錯域通過）
9. 空 feed 契約必須先走完：插入點在**空 feed 降級檢查（`mtf.ts:2042-2049`）之後**，故符合條件但 feed 為空者仍回 NA／`[]`（prefetch 失敗會降級成 `[]`，`mtf.ts:670-673`）
10. **runtime 形狀檢查**：expr 產生的每個 Value 必須是
    - 純量（非 series），或
    - **plain absolute-index `BarSeries`**（即 `v.v.constructor === BarSeries`；排除 `ForwardingSeries`/`SecSeries`/`LiftedSeries`/`CellSeries`/`LitSeries`/`FnSeries`/`CalSeries`）
    任一不符 → **該根改用慢路徑**
    （理由：快路徑靠「同一個 series 物件在 `bar-1` 的歷史讀取」，只有具真實 per-bar 儲存的絕對索引序列才成立；`FnSeries`（`ta.ts:1843`）／`CalSeries`（`time.ts:122`）為非 BarSeries，`LiftedSeries`（`series.ts:482`）等為 fresh-per-bar 語意）

**混用安全性（v2 簡化後成立於雙向）**：快路徑不碰 `spec.ctx`/`scope`/`warmed`/`bars`/`loaded`/`varUpto`；慢路徑進場由 `if (!spec.ctx) ensureTfFrame`（`:2055`）＋`if (!spec.warmed)`（`:2185`）從零重建。兩者寫入 `chartHist[N]` 的值同為 raw@(N−1)，故 `fast↔slow` 任意交錯皆安全，**不需要任何跨根的守衛狀態**。

### 2.3 純度閘＝純讀 whitelist（**明列允許**，不用黑名單）

> v1 用黑名單，advisor 指出漏了 `array/map/matrix` mutator、`linefill`、calendar 識別碼、UDT 方法、`ta.*` 狀態域錯位 ⇒ 改為 whitelist。

**允許**（遞迴）：
- 純量節點：`num`/`str`/`bool`/`color`/`na`
- `unary`/`binary`/`ternary`/`histref`/`arraylit`/tuple 運算元
- `ident`：內建序列名（`open/high/low/close/volume/time/hl2/hlc3/hlcc4/ohlc4`）或**圖表域 global**，且滿足：
  - `def.inBranch` 為假（每個 bar 都求值）
  - 讀取 global **不會**執行其 producer ⇒ **不需**檢查 producer 內部（MACD701 的 `macd_raw = ta.macd(…)` 因此可放行）
- `call`：僅限白名單命名空間：`math.*`、`nz`、`na`、型別轉換（`int/float/bool/string`）、`fixnan`、`math.*` 全族
- UDF 呼叫：**Phase 1 一律拒絕**（Phase 2 另議）

**拒絕**（任一出現即失格）：`ta.*`、`request.*`、`strategy.*`、`array.*`/`map.*`/`matrix.*`、所有繪圖與 sink（`plot*`/`hline`/`fill`/`linefill`/`bgcolor`/`barcolor`/`label.*`/`line.*`/`box.*`/`polyline.*`/`table.*`）、`alert*`/`alertcondition`、`log.*`、`input.*`、`runtime.*`、`indicator`/`strategy` 宣告、UDT 方法、以及**一切索引/時鐘相依識別碼**（`bar_index`、`time`、`time_close`、`hour`、`minute`、`second`、`dayofmonth`、`dayofweek`、`month`、`year`、`barstate.*`、`timenow`、`last_bar_index`、`syminfo.*`）

**判別力要求**：每一類「拒絕項」都要有單元測試；把該類放寬時測試必須變紅。

### 2.4 為何不能只複用 `exprSafeForAgnostic`

它是**呼叫者無關性**閘，不是純度閘：`ident` 只要在 builtin 命名空間（`mtf.ts:1396-1404`）或已知名單內就通過（`:1661`），call 規則只拒絕「callee/receiver 為本子樹 bound」（`:1663-1678`）⇒ `array.push(g, 1)`（`g` 為檔層 global）可通過。故僅作**參考**，不作閘門。

---

## 3. 核心設計：落後一根 = **歷史讀取**（v2 移除 v1 的快取與守衛）

tf == 圖表時框時慢路徑的 `j` 恆為 `N-1`（`tfBarAtOrBefore(bars,t0)` 取到 t0 本身，`tfBarEnd(t0) = t0 + dur > t0` ⇒ `j = at − 1`，`mtf.ts:2150-2159`）。既有測試已釘住此語意：`mtf.test.ts:1922-1931`（chart tf `'15'`、`security(syminfo.tickerid,"15",close)`，期望 `['na',10,11,12,13,14]`）。

**設計**：在插入點（§4）於**圖表幀**求值一次，然後

```ts
delayed = alignToChart(spec, e, rawAtN, ctx.barIndex - 1)   // 每個 expr 各一次
emitChartAll(spec, callerKey, ctx.barIndex, delayed)        // 慣例不變：chartHist[N] = raw@(N-1)
return spec.exprs.length === 1 ? delayed : { kind:'array', v: exprs.map(...) }
```

- `SecSeries.cur()` = `atTf(j)` = `src.atOffset(j, 0)`（`mtf.ts:1038-1043`、`:1061-1063`）；圖表序列是絕對索引 ⇒ **讀 `N-1` 是歷史讀取，與「rawAtN 何時取得」無關** ⇒ 不需要記上一根、不需要新增任何 state。
- `[n]` 歷史仍由 `spec.chartHist` 提供（`SecSeries.atOffset:1048-1055`）；**emit 慣例不得改**（`chartHist[k]` 必須繼續放落後值）。
- 純量／array 結果各依 `alignToChart` 原分支處理（`:1098-1110`）。
- 求值器：`evalHook(e, frame.scope, frame.ctx)`（`mtf.ts:45-46`），且**必須用真正的圖表 ctx 物件**（RunState 掛在 ctx 的 symbol slot 上，`interpreter.ts:232-263`；`{...ctx}` 會丟掉它）——這也是純度閘必須「拒絕呼叫」的原因：任何呼叫都可能在圖表 ctx 寫狀態。

**因 v2 移除 `chartTfPrev`，v1 的三個註冊面（`resetTfFrame`／`SpecSnap, snapSpec`／`restoreSpec` 的 `cloneH!` copy）與 R6 全部消失**；快路徑只讀既有序列、只寫既有的 `chartHist`（其快照/回滾機制已存在）。

---

## 4. 插入點

`tryEvalSecurity`（`mtf.ts:1999`）內，**`:2054` 之後**（`spec.callerScope = frame.scope; spec.callerKey = callsiteKey(ctx, spec.node);`）**、`:2055` 之前**（`if (!spec.ctx) ensureTfFrame(spec, frame);`）。

- 必須在動態 sym/tf 解析塊（`:2021-2041`）之後 ⇒ 條件 6/7 才可用解析後的值（MACD701 的 `res = timeframe.period` 是 DYNAMIC）
- 必須在空 feed 降級（`:2042-2049`）之後 ⇒ 條件 9
- 必須在 `callerKey` 賦值（`:2054`）之後 ⇒ `emitChartAll`／`alignToChart` 皆以 `spec.callerKey` 為鍵（`:2169`）

---

## 5. 步驟

### Step 0（零行為改動）：純度閘 predicate ＋ 其單元測試
- 只新增一個純函式（AST → boolean）與測試，**不接進 `tryEvalSecurity`**
- **驗**：`tsc` 0；`vitest run src/pine` 全綠；四支 digest 不變；**判別力實驗**：逐類放寬拒絕項 ⇒ 對應測試必須變紅
- **不做**：不新增全域統計計數器（advisor 指出：靜態算不出完整資格集合（動態 tf），且新計數器無輸出管道、急切求值會擾動被釘死的 `gatePass/gateFail/prodWalks` 精確值，如 `mtf.test.ts:355-365`、`mtf_invariance.test.ts:189-190`）

### Step 1：接線快路徑
- 依 §2/§3/§4 加入判定與求值分支；runtime 形狀檢查不合格即落回慢路徑
- **驗（全跑）**：`tsc` 0；`vitest run src/pine` 全綠；四支 digest 逐字不變；`s1-inc-probe` `PARITY OK`；golden 0 差異；per-spec 探針（`mtf-perspec-optimized.mjs` / `mtf-perspec-optimized.mjs --script …`）；`evalNodeCounts.total` 前後對照
- **退**：還原 `mtf.ts`（單檔）

### Step 2：補既有偵測缺口（新測試）
1. **形狀檢查的判別力**：構造 expr 產生 `LiftedSeries`/`FnSeries` 的情形 ⇒ 斷言走慢路徑且值不變
2. **同圖表時框的 forming-bar tick**（現有 `inc-parity.test.ts:120` 是 chart `D` × security `5`，非同 tf）
3. **圖表 tape 與 (sym,tf) feed 在重疊區值不同**（現有 `golden.ts:36` 的 feed 是完整 3000 根、tape 是 `slice(-1000)`，**長度已不同但重疊區值相同**；缺的是「重疊區值不同」的情境）
4. **閘控呼叫點的等價**：照 `final.pine:16-18` 形狀（`barstate.islast` 內同 tf security）斷言與非閘控同值
- **驗**：關掉快路徑時新測試仍綠；放寬 predicate 時能變紅

### Step 3：收尾
- 全量閘門＋更新 `docs/2026-10-15-r5-fix-plan.md` P6 狀態與 `PROGRESS.md`

---

## 6. 回歸、rollback、預檢

- **rollback**：動工前備份 `src/pine/mtf.ts`（含 md5）到 `%TEMP%\t6a-snapshot-<ts>\`；單檔改動 ⇒ 還原即回滾
- **紅線**：禁 `git checkout <commit> -- src/pine`／`git restore`／`git stash`；禁 `npm i`
- **停損**：A1–A6 任一不過且 3 次修正無效 → 還原，只交歸因
- **動到的全域設定**：無
- **預檢**：`mtf.ts` md5（現 2438 行）＋`tsc` rc=0＋`vitest run src/pine` 全綠＋四支 digest 基線＋兩個 per-spec 基線檔在；快照已建；**無**需憑證/環境變數

---

## 7. 殘留風險（交付時如實說明）

| # | 風險 | 現況 |
|---|---|---|
| R4 | **生產 feed ≠ 圖表 tape**：同源非同陣列（feed 常多覆蓋 ≈ tape+500、forming bar 可能較新、HA 時 tape 是合成 bars；`engine.ts:119-130`、`chunk-UNUVPQFW.js:1079-1084`、`VelaPage.tsx:279-281`） | Phase 1 只放行「純量或 plain BarSeries 的純讀 expr」，不含索引/時鐘識別碼 ⇒ 對 OHLC 衍生值應相同；殘留差異待裁決是否加「feed↔tape 重疊區逐 bar 相等」前置檢查 |
| R7 | **TRIS390 不在 Phase 1 收益內**：其 expr 是 UDF 呼叫（`TRIS390.pine:172-202`），Phase 1 拒絕 UDF ⇒ 收益 0；MACD701_v72（純讀 tuple）不受影響 | Phase 2 另議（需先證明 UDF 內 `ta.*` 在圖表 ctx 的 per-bar 冪等性） |
| R8 | **`array.push(g,…)` 型副作用**（v1 漏網） | Phase 1 whitelist 直接拒絕 `array/map/matrix` 與 UDF ⇒ 已封 |
| R9 | 圖表 ctx 的 RunState 會被 `math.*` lift 寫入（既有 chart 行為，非新增） | 接受；不影響數值 |
| R10 | `constFlag` 只看字面（`mtf.ts:346-352`）⇒ `la = barmerge.lookahead_on; security(...,la)` 被判 `off` | **既存**，快路徑繼承同一判讀，不新增分歧 |
| R11 | `syminfo.ticker` 與 `syminfo.tickerid` 被 `constString` 收斂成同一 `CHART_SYM`（`mtf.ts:342`） | **既存**語意，快路徑繼承 |
| R12 | 生成中/當根 feed 較新時，`alignToChart` 讀的是圖表序列 | 同 R4；Phase 1 的純讀限制下應無差 |

---

## 附錄 A：v1→v2 變更（advisor 複核結論）

| v1 | 問題（附證據） | v2 |
|---|---|---|
| `chartTfPrev`＋`chartTfPrevBar`＋守衛 8 | 守衛要求「上一根走快路徑」，但慢路徑不填該槽（v1 §3.4 自述）⇒ **歸納上快路徑永不啟動**；若補寫則讀到 stale 值 | **整段移除**，改歷史讀取（`SecSeries.cur()` = `src.atOffset(N-1,0)`，`mtf.ts:1038-1043`）；連帶刪掉三個註冊面與 R6 |
| 純度閘＝黑名單 | 漏 `array/map/matrix` mutator（gate 對 namespace ident 放行，`mtf.ts:1661-1678`）、`linefill`、calendar 識別碼、UDT 方法；且 tf 幀刻意給空 sink（`mtf.ts:1193-1194`）證明「不得畫到圖表 sink」是設計不變量 | 改 **whitelist**（§2.3）；`ta.*` 與 UDF 於 Phase 1 全拒 |
| A1：`evals` 898→≤20 | `evals` 唯一遞增點在 `computeAt`（`mtf.ts:1933`），快路徑不經它 ⇒ 歸零是**同義反覆**，無法區分「有效」與「無收益」 | 主指標改 `evalNodeCounts.total`；`evals` 降級為旁證；新增控制組 `invocations` 與 `cwPushes/cwPeak` 不得上升 |
| 成本歸因＝一次性暖機 | 實測 898/100 ≈ 9 evals/bar，是**每根重算 producer 鏈** | 歸因更正（§0） |
| 條件 9＝`instanceof BarSeries` | `LiftedSeries`/`CowSeries`/`SiteSeries` 皆 extends BarSeries ⇒ 過不了濾網；真正非 BarSeries 只有 `FnSeries`/`CalSeries` | 收緊為 `constructor === BarSeries`（§2.2 條件 10） |
| 無巢狀 security 防護 | security 表達式內的巢狀 security 在外層 tf 幀求值，`period`=tf、`syminfo`=被請求標的（`mtf.ts:1203-1205`）⇒ 條件 6/7 在錯域通過 | 新增條件 8（`mainPeriod === period`） |
| 插入點 `:2036/2037` | 動態塊到 `:2041` 才結束；`:2037` 是 `spec.bars = bars;`；`:2043` 才是 `const bars = spec.bars;`；且 `callerKey` 到 `:2054` 才設定 ⇒ 會用到 stale callerKey | 插入點改 **`:2054` 之後、`:2055` 之前**（§4） |
| §3.4 引 `ensureTfFrame` 於 `:2041` | 實際在 `:2055` | 已更正 |
| §3.2 引 `restoreSpec` cloneH 於 `:2384-2385` | 實際對稱還原在 `:2372-2373` | 因該節整段移除而消失 |
| Step 2 #3 敘述 | `final`/`norm2` 的 feed 已是完整 3000 根（`golden.ts:36`）而 tape 只 1000 根，**長度已不同** | 缺口改述為「重疊區值不同」（§5 Step 2 #3） |
| §2.3 索引識別碼的理由 | 該理由（R4）對 OHLC 同樣成立 ⇒ 規則「多餘或不足」 | 保留規則但改為保守排除，並把理由改掛 R4 |

---

## 附錄 B：Step 0/1 首次實作 → 已回退（失敗報告，2026-10-16）

依 v2 §5 動工後，在**第一個驗收閘（A2 digest）**即失敗，已完整回退 `src/pine/mtf.ts`。以下為實測證據與修正後的新假設。

### B.1 做了什麼

- `SecuritySpec.chartTfFast` 靜態判定 ＋ predicate `chartTfFastExpr`：expr 必須是**裸 ident**，且為 `SERIES_NAMES` 或「宣告式（`writes.length===0`）、非分支內（`!inBranch`）」的檔層 global。
- 快路徑插在**慢路徑 `j` 計算之後**（不是 v2 §4 寫的 `:2054`）——因為實測發現 `j` 是**從 feed 推導的索引**（`tfBarAtOrBefore(bars,t0)`），不是圖表 bar index：
  - 在圖表幀對 ident 求值得到的是**當前純量**（實測 `raw[0].kind === 'float'`），不是 series ⇒ v2 的「求值後 `alignToChart(..., bar-1)`」會回當前值（實測 `['na',11,12,13,14,15]`，期望 `['na',10,...,14]`）。
  - 慢路徑的 `j = at - 1`（`at` = feed 中 `openTime === t0` 的索引）；**當 feed 不含 t0 時 `j = -1` ⇒ NA**。golden 的 `final` fixture feed 只有 **1 根**（實測 `bars = 1`），故舊值是 `null`。
- 最終實作：用慢路徑的 canonical `j`，加時戳守衛 `bars[j].openTime === numOf(ctx.time.get(1))`（即 feed 該根**必須正好是圖表前一根**），再由 `frame.scope.lookup(name)` 取**純 BarSeries**（`instanceof BarSeries && constructor === BarSeries`）做 `alignToChart(..., j)`。

### B.2 實測結果

| 項目 | 結果 |
|---|---|
| `npx tsc --noEmit` | rc=0 |
| `mtf.test.ts` / `golden.test.ts` / `mtf_invariance.test.ts` / `inc-parity.test.ts` | **127 passed ｜ 1 skipped（全綠）** |
| MACD701_v72 per-spec（@100，tf=5） | evals **898 → 0**、total 899 → 1、calls 100 |
| TRIS390 per-spec（@100，tf=5） | evals 307 → **307（不變）**，符合 R7 |
| `evalNodeCounts.total`（MACD701_v72 @100） | 32,742 → **31,403**（−4.1%） |
| `mtf.evals`（同上） | 4,509 → 3,618 |
| **`A2` digest（MACD701_v72 @100）** | **`1580h2` → `n13oly`（FAIL）** |
| model shape 差異 | **`labels` 13 → 11**（其餘 series/priceLines/fills/backgrounds/tables 全同） |

⇒ **A2 硬閘失敗**：快路徑使 MACD701_v72 少畫 2 個 label，digest 改變。已回退，回退後複驗：`tsc` 0、digest 回 `1580h2`、`labels 13`、`evalNodeCounts 32,742`、`mtf.test.ts`+`golden.test.ts` 100 passed ｜ 1 skipped。

### B.3 被推翻的假設（v2 §3 的核心）

v2 假設「純讀圖表 global 的值 == tf 幀重算 producer 的值」。**實測不成立**：MACD701_v72 的 expr 是 `macd_raw/signal_raw/hist_raw`（`= ta.macd(...)` 宣告式 global），圖表域讀值與 tf 域重算值有差異，足以改變下游比較判斷（2 個 label 消失）。

**新假設（待驗）**：差異來自「stateful builtin 的狀態槽身分」，而非數值近似——
- `ta.*` 狀態以 `(ctx, callsite, argSeriesId)` 為鍵（`ta.ts:188-210`、`emaTag:777-782`）；tf 幀與圖表幀各有自己的 `ctx.state`（`stateMap` 以 **ctx 物件**為鍵，`ta.ts:149-158`），且下游若以 security 結果當 `ta.*` 來源，`seriesId(stableSeries(arg))` 在兩條路徑指向**不同來源序列**（一條是圖表序列、一條是 tf 序列）⇒ 狀態槽不同 ⇒ 增量起算點不同，數值可能有微小分歧。
- `mtf_invariance.test.ts:46-50`（T1：tf 域 `bar_index`）已說明 tf 域與圖表域刻意不同；本路徑把 expr 挪到圖表域，等於同時挪動了**索引語意**與**下游 ta 狀態身分**。

### B.4 下一輪要先做的事（不再直接改碼）

1. **定位那 2 個 label**：用 harness 傾印 `model.drawings`（含 label 的 x/y/text）在快路徑開／關下的差異，確認是「值差」還是「索引差」。
2. **量測值差量級**：對同一 bar 比較「圖表域讀值」vs「tf 域重算值」的逐值差（需一個探針同時取兩者）。
3. 若確認是**下游 `ta.*` 狀態身分**造成：候選修法是讓快路徑回傳的 `SecSeries` 仍以 **tf 域來源語意**參與 `seriesId`（或明確要求 expr 為 `SERIES_NAMES` 裸序列，排除任何 global）——後者代價是 MACD701_v72 收益歸零（只剩 `close` 類腳本受益）。
4. 若確認是**索引語意**造成：候選修法是限定 expr 不得被任何以索引為鍵的 stateful builtin 消費（需 AST 反查消費點，成本高）。

**在 B.4 有結論前，T6① 不應再動 `mtf.ts`。**

### B.5 後續取證（已完成）：值差假設被**反證**

探針 `scratch/perf/t6a-domain-diff.mts`（新寫，唯讀觀測：以 `registerMtf` 包 `tryEvalSecurity`，同時取「慢路徑回傳值的 `cur()`」與「圖表域同名 global 在**同一 `j`** 的值」）實跑結果：

| expr | `equal@j` | `equal@N-1` | maxAbsDiff | 有差異的 bar |
|---|---|---|---|---|
| `macd_raw` | **99/100** | 99/100 | **0** | none |
| `signal_raw` | 91/100 | 91/100 | **0** | none |
| `hist_raw` | 91/100 | 91/100 | **0** | none |

（未達 100 者為其中一側 `na`，非值差。）

⇒ **「圖表域讀值 ≠ tf 域重算值」的假設不成立**：兩域的值**逐位元相同**（`maxAbsDiff = 0`）。

**修訂後的新假設**：digest 改變（`labels` 13→11）不是值差，而是**結構差**——快路徑**完全略過 `ensureTfFrame`**，因此：
1. `spec.ctx`/`spec.scope`/tf series 從未被建置；
2. 回傳的 `SecSeries` 底層來源由 **tf 序列**換成**圖表序列**（`SecSeries` 建構子第三參數 `src`），而下游若把此結果當 `ta.*` 的來源，`seriesId(stableSeries(arg))` 會指向不同物件 ⇒ 狀態槽身分改變（`ta.ts:188-210`、`emaTag:777-782`）；
3. 標記類 label 由 `outMacD`/`outSignal` 經 `ta.crossover/crossunder`（`MACD701_v72.pine:123-124`）產生，屬對「來源序列身分」敏感的一族。

~~**下一步（B.6）**~~ → **已在 B.6 完成**：重新暫時套用快路徑，但在快路徑內**仍舊呼叫 `ensureTfFrame`**（只跳過暖機與 expr 重算），據此判定差異究竟來自「少建 tf 幀」還是「來源序列身分」；並用 harness 傾印 `model.drawings` 的 label 清單做前後 diff（確認是哪 2 個 label）。

### B.6 隔離結論（2026-10-16，已定案）

- **修正曾宣稱的「值差」假設**：隔離探針（在快路徑內**仍呼叫 `ensureTfFrame`**，只跳過暖機與 expr 重算）證明兩域值**逐位元相同**（`maxAbsDiff = 0`）⇒ B.3／B.5 的「值差」方向**完全不是**原因。
- **真根因＝索引語意**：canonical `j` 是 **feed 索引**（feed 500 根 vs tape 100 根，`j = 399 + i ≥ lastBar`）⇒ `BarSeries.atOffset`（`series.ts:230`：`if (target >= this.lastBar) return this.rAt(0) ?? NA`）靜默回退 `rAt(0)`＝最新值 ⇒ 交叉點 marker **領先一根**，且 chart bar 5／10 的 marker 消失（`MACD701_v72.pine:123-124` 的 `ta.crossunder/crossover` → `:345` 的 `plotshape`；`MACD701_v72.pine` 實檔＝`scratch/perf/app-scripts/macd701_v72.pine`）。
- **加守衛後路徑正確**（守衛：`bars.length === ctx.barCount && j === ctx.barIndex - 1 && bars[0].openTime === … && bars[j].openTime === ctx.time.get(1)`）：feed == tape @500 時 digest 位元不變、tf evals **4,509 → 11**、total **−4.7%**；但**驗收配置（@100、feed 500 根）永不觸發 ⇒ 零收益**。
- **結論**：前提（「tf 幀是圖表 tape 的複製品」）**已否證 ⇒ 結案不做**。已完整回退（`src/pine/mtf.ts` md5 `b8da64c1bcc03e534db45e30983fc2f8`、2,438 行），patch 另存 `scratch/perf/patches/t6a-charttf-fastpath.SOUND-BUT-INERT.patch`。
- **回退後複驗**：四支 digest `ze7byn/kb0glc/1580h2/p4gddl` 逐字不變；`npx tsc --noEmit` rc=0；`npx vitest run src/pine` **970 passed | 1 skipped**；`s1-inc-probe` **PARITY OK**。


