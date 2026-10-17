# T6① 實作地圖：圖表時框 × 圖表標的的 `request.security` 不進 MTF 引擎

唯讀探索（本探子未改任何檔、未跑重型指令）。目標：讓主代理有 tsc 回饋時一次改對。

## 0. 讀檔快照（樹正在被另一代理改動）

| 檔 | md5 | 行數 |
|---|---|---|
| `src/pine/mtf.ts` | `79d67c66b8e19349b4fdaeeaef5d3d79`（brief 供，**未能自行複核**：本 session 無 shell 工具，只讀不寫） | 2411（吻合 brief） |
| `src/pine/interpreter.ts` | `ff74775f1bf415fa14f888493ba0f8d0`（同上） | 3963 |
| `src/pine/series.ts` | `e158d372f3a4328f11e2d2f5ccda8c93`（同上） | 722 |
| `src/pine/builtins/ta.ts` | `196c04d1771d0b53c77cc4e5697248e3`（同上） | 2183 |

**行號漂移警告**：`docs/2026-10-15-r5-macd701-mtf-attribution.md` §3① 與 `docs/2026-10-15-r5-fix-plan.md` P6 引的 `mtf.ts:2098-2108` / `:2118-2180` / `:2171-2173` 是**舊修訂**的行號（該 doc 描述 `:1985-2207`，現檔 `tryEvalSecurity` = **1985–2181**）。本 dossier 全部採**現行行號**，並在 §1 給出舊→新對照。

---

## 1. 判定點與條件表（變數名 + 現行行號）

**函式**：`export function tryEvalSecurity(node, frame)` → `mtf.ts:1985`，結尾 `return res;` → `:2180`。

**流程錨點（現行行號）**

| 行號 | 內容 | 交給快路徑的關係 |
|---|---|---|
| `:1987` | `if (node.type !== 'call' \|\| !isSecurityCall(node)) return null;` | **唯一合法 null 出口**（`interpreter.ts:1345` NOT_SECURITY_CALL 契約；`interpreter.ts:1371-1375`、`:2544-2548`） |
| `:1988-1989` | `const spec = store.byNode.get(node); if (!spec) return NA;` | — |
| `:1995-2003` | named-arg `warnOnce`（`SECURITY_PARAMS`） | 快路徑**必須保留**（在判定點之前） |
| `:2007-2027` | **動態 sym/tf 解析**：`sym = spec.sym, tf = spec.tf`；`:2010` `sym===CHART_SYM→ctx.syminfo.tickerid.v`；`:2011` `tf===DYNAMIC→runConst(spec.tfNode) ?? ctx.timeframe.period`；`:2012` `store.fetched.get(\`${sym}\n${tf}\`)`；`:2013-2018` 未 prefetch → warnOnce + `NA`/`[]`；`:2020-2026` 換 feed → `spec.bars=bars; spec.tfResolved=tf; resetTfFrame(spec)` | **判定點必須在此之後**（要用解析後的 `sym`/`tf`） |
| `:2029` | `const bars = spec.bars;` | 快路徑不需要 `bars` |
| `:2030-2035` | 空 feed → `NA` / `{kind:'array',v:[]}` | 快路徑不需要 |
| `:2039` | `spec.callerScope = frame.scope;` | 快路徑**必須照做**（chartHist key + expr 解析範圍） |
| `:2040` | `spec.callerKey = callsiteKey(ctx, spec.node);` | 同上（`interpreter.ts:493-501`） |
| `:2041` | `if (!spec.ctx) ensureTfFrame(spec, frame);` | **快路徑要繞過**（或永不觸發） |
| `:2054-2060` | `seenCallers` / `nodeCache`(durableCache) 路由 | 快路徑要繞過（只用 chartHist） |
| `:2066-2075` | `t0`、`chartPeriod = ctx.timeframe.period`、`chartDur` | 只有 `chartPeriod` 快路徑要用 |
| `:2077-2130` | `if (spec.isLtf) {…}`（`security_lower_tf` 全段） | 退回 |
| `:2136-2144` | **`j` 對映**：`lookahead==='on'` → `tfBarAtOrBefore(bars, t0+chartDur-1)`；否則 `at = tfBarAtOrBefore(bars,t0); j = tfBarEnd(bars,at,tf) <= t0 ? at : at-1` | 對齊的來源之一，見 §3 |
| `:2146` | `if (j < 0) return NA;` | 對齊的「首根 = NA」來源 |
| `:2157-2165` | `if (spec.gaps === 'on') {…}` emit NA / 去重 | 退回 |
| `:2170-2173` | `if (!spec.warmed) { for (let w=0; w<=j; w++) for (const e of spec.exprs) evalAt(spec,e,w); spec.warmed = true; }` | **成本主體**，快路徑繞過 |
| `:2176-2178` | `const res = spec.exprs.length===1 ? evalAt(...) : {kind:'array', v: spec.exprs.map(e=>evalAt(e,j))}` | 快路徑以等價值取代 |
| `:2179` | `emitChartAll(spec, callerKey, ctx.barIndex, res);` | 快路徑**必須保留**（`[n]` 契約） |
| `:2180` | `return res;` | 快路徑回傳「上一根已收盤 chart bar 的值」 |

舊→新對照：doc 的判定點 `:2098-2108`（動態解析完成後）＝現行 **`:2028` 附近**；doc 的「繞過 `:2118-2180`」＝現行 **`:2136-2180`**；doc 的暖機 `:2171-2173`＝現行 **`:2170-2173`**（吻合）。

**「可以繞」的精確條件**

```ts
// 在 :2027（動態解析塊結束）之後、:2029（const bars = spec.bars）之前插入
!spec.isLtf                        // SecuritySpec.isLtf 欄位 :187；賦值 :534；分支 :2077
&& spec.gaps === 'off'             // 欄位 :184；賦值 :545 = constFlag(gapsNode,'gaps_on')（未給 → 'off' = TV 預設）
&& spec.lookahead === 'off'        // 欄位 :185；賦值 :546 = constFlag(laNode,'lookahead_on')（未給 → 'off' = TV 預設）
&& spec.sym !== DYNAMIC            // DYNAMIC 常數 :154；spec.sym 賦值 :541 = constString(symNode) ?? DYNAMIC
&& (spec.sym === CHART_SYM         // CHART_SYM 常數 :155（''）；syminfo.tickerid/ticker → CHART_SYM 在 :341
    || sym === chartTicker)        // 解析後 sym（:2007-2011）比對 :653 的 chartTicker
&& tf === ctx.timeframe.period     // tf = 解析後（:2007-2011）；chartPeriod = ctx.timeframe.period (:2067)
```

- `sym === CHART_SYM`（靜態）就是「圖表標的」的**精確靜態標記**：`mtf.ts:341` 把 `syminfo.tickerid` / `syminfo.ticker` 映成 `CHART_SYM`，`constString(:541)` 因此得 `''`。
- `tf` 為 **DYNAMIC 是允許的**（MACD701 的 `res = useCurrentRes ? timeframe.period : resCustom` 就是 DYNAMIC，`:640-642` 在 prefetch 用 `runConst` 解成 `'5'`）。判定點必須用**解析後**的 `tf`，不能用 `spec.tf`。
- `exprs`：`:544` `exprNode.type==='arraylit' ? exprNode.items : [exprNode]`。**MACD701 是 3-tuple**：`[macd_raw, signal_raw, hist_raw]`（見 §6）。
- `spec.sym !== DYNAMIC` 即文件所稱「非動態 sym」；`syminfo.tickerid` 走的是靜態路徑，**不受此限**。

**建議額外條件（見 §4/§5，主代理決策點）**：exprs 必須「圖表幀純」——每個 expr 參照的 `store.globals` 條目 `def.writes.length === 0`（`store.globals` 用法見 `:607-609`、`:1159-1161` 的 `TfVarSeries/TfGlobalSeries` 分流），且不含 `var`/`:=`（`interpreter.ts:1579-1590` 的 `hist`/`mut` 判定）。這是讓「在圖表幀重算 expr」無副作用的最小可檢查謂詞。

## 2. 必須退回原路徑的清單

| 條件 | 判定式 | 行號 | 理由 |
|---|---|---|---|
| `lookahead_on` | `spec.lookahead !== 'off'` | `:185`,`:546`,`:2137` | 要取 developing tf bar（`t0+chartDur-1`）；且 `snapSpec/tailRisk`（`:2277`）、`restoreSpec`（`:2368`）都對 on 有特殊處理 |
| `gaps_on` | `spec.gaps !== 'off'` | `:184`,`:545`,`:2157` | 需 per-tf-bar 去重（`spec.lastEmit`，`:2157-2165`），語意不是單純延遲一根 |
| `security_lower_tf` | `spec.isLtf` | `:187`,`:534`,`:2077` | 回傳 per-lower-bar 陣列，完全不同的 emit 迴圈（`:2111-2129`） |
| 動態 sym | `spec.sym === DYNAMIC` | `:154`,`:541`,`:2008` | sym 每根可能改變，無法與圖表標的建立靜態等同 |
| 動態 tuple / 非圖表幀純 expr | （見 §1 建議條件 / §4 決策） | `:544` | tuple 成員可能含 `var`/`:=` 或 lazy series 來源 |
| （隱含）`j < 0` | — | `:2146` | 首根無已完成 bar → **NA**；快路徑必須等價（見 §3 第 3 點） |

**注意**：`spec.tf === DYNAMIC` **不在**退回清單（MACD701 靠它命中）；只要**解析後** `tf === ctx.timeframe.period` 即可。

## 3. 對齊語義（lookahead_off：值 = 上一根已收盤 chart bar 的值）

### 3.1 現況由三個協作件共同產生

1. **`j` 選取**：`:2136-2144`。同 tf 時，chart bar N 的 `t0` 恰是 tf bar N 的 openTime ⇒ `at = N`，而 `tfBarEnd(bars,N,tf) > t0` ⇒ `j = N-1`。
2. **求值錨定**：`computeAt`（`:1918-1944`）`advanceTo(spec,j)`（`:1211`）把 tf 幀 series 寫到 `j`，然後 `:1921-1922` `spec.ctx.barIndex = j; tfAnchor = spec.ctx;` 再加上全域 monkey-patch（`:804-842`：`BarSeries.prototype.get/cur/atOffset` + `tfSeries` WeakSet + `seriesHooks.anchor/touch`）——**tfAnchor 不是 null 時，凡在 `tfSeries` 內的 series，其 `get(n)/cur()/atOffset` 一律相對於 `tfAnchor.barIndex` 重新定錨**。這是「`close` 讀到 tf bar j 而非最新根」的唯一機制。tf 幀自己的 OHLC/shadows 在 `:1139` `tfSeries.add(b)`。
3. **包裝與歷史**：`alignToChart`（`:1088-1101`）把 `{kind:'series'}` 結果包成 `SecSeries`（`:1014+`，`cur()` = `src.atOffset(j,0)`、`[n]` = `spec.chartHist` 的 chart 域歷史）；`emitChartAll`（`:2195-2210`）把「這根 chart bar 的映射值」寫進 `chartHist`（`emitChartOne` `:2184-2192`，`s.setAt(bar, v.v.cur())`）。

**結論（實作地圖核心）**：lookahead_off 的「上一根已收盤值」＝**在 tf 幀把 expr 求值於 `j = N-1`**。此值同時被 (a) 直接回傳、(b) 寫入 `chartHist[N]`（供 chart 端 `[n]` 讀 `chartHist[N-n]`）。兩條路徑都必須等價提供。

### 3.2 繞過時怎麼等價提供

**等價命題**：同 tf 下 `tf bar k ≡ chart bar k`（同 `bars`），所以「expr 於 tf bar N-1 的值」＝「expr 於 chart bar N-1 的值」。因此快路徑只需提供 **expr 在 chart 幀、bar N-1 的值**，並照原契約寫入 `chartHist[N]`。

三種等價供法（成本/風險遞增）：

- **(A) 零重算：expr 是純量識別/圖表域 series 的 ident**。`macd_raw` 等 top-level `=` 全域在圖表幀已是 `BarSeries`（`bindDeclared` `interpreter.ts:653-703`，series 結果走 `CowSeries`，`CowSeries.atOffset` `interpreter.ts:375-377` → `src.atOffset`）。直接 `series.atOffset(N-1, 0)` 即得，O(1)、位元等價。
- **(B) 一般式（推薦主線）：圖表幀每根求值一次 + 1 根延遲**。於 bar N 用 `evalHook(expr, frame.scope, ctx)`（chart 幀、自然錨定，不需碰 `tfAnchor`）求值一次（與慢路徑「每 tf bar 一次」同次數）；把**前一根本身**的結果回傳。
- **(C) 最一般但有害**：沿用 `computeAt` 的錨定手法，把 `tfAnchor` 換成「barIndex = N-1 的圖表 ctx」——**需要把圖表 series 加進 `tfSeries`**（`:802`,`:807-809`,`:840-841`），而 `tfSeries` 是 WeakSet **不可移除** ⇒ 會永久影響其他 spec（如 `"D"` leg）的 tf 求值。**不建議**。

**(B) 的兩個關鍵細節**
1. *series 結果*：`raw.v` 是**活跳**圖表 series，`cur()` 會在當根（N）讀錯。回傳時必須重新以 `j = N-1` 包裝 ⇒ **直接重用 `alignToChart(spec, e, raw, N-1)`**（`:1088`）即得與慢路徑同形的 `SecSeries`（慢路徑 src = tf 幀 series、j = N-1；兩者數值相同）。
2. *寫入 `chartHist` 的值必須已是「延遲後」的值*（慢路徑 `emitChartAll(…, ctx.barIndex, res)` 的 `res` 是 `j` 的值）。做法：以**前一根**的值呼叫 `emitChartAll(spec, callerKey, N, delayed)`；`emitChartOne` 的 `v.v.cur()`（`:2190`）此時讀的是已 `j=N-1` 包裝的 `SecSeries` ⇒ 得到 `close[N-1]`，寫入 slot N ⇒ 與慢路徑逐位元一致。
3 . *首根*：慢路徑 `:2146` `j<0 → return NA` **且不 emit**。快路徑在 `N === 0` 必須同樣 **NA 且跳過 `emitChartAll`**（否則 `chartHist` slot 0 多一筆 NA）。
4. *延遲緩衝*：每 spec 一個 `Map<callerKey, Value>` 存「上一根的 raw」（scalar 存數值、series 存剛求出的 Value，回傳時才用 (1) 重新以 `N-1` 包裝）。1 個 slot／caller，成本可忽略。

## 4. 最小改動草稿（精確落點）

**落點**：`mtf.ts` `:2028`（`}` 收掉動態解析塊之後、`const bars = spec.bars;` 之前），單一 `return`。

```ts
  // ── T6① chart-tf × chart-sym fast path: no tf frame, no warm-up ──
  if (!spec.isLtf && spec.gaps === 'off' && spec.lookahead === 'off'
      && spec.sym !== DYNAMIC
      && (spec.sym === CHART_SYM || sym === chartTicker)
      && tf === ctx.timeframe.period
      && exprsChartPure(spec))            // 見 §1 建議條件（可先不寫、見 §5 風險 R3）
    return evalChartTf(spec, frame, ctx);
```

（`:2039-2041` 的 `callerScope`/`callerKey` 賦值與 `chartTicker`（`:653` 同式）在快路徑內自行補做；`chartTicker` 需從 `ctx.syminfo.tickerid?.kind === 'string' ? ... : CHART_SYM` 現地取。）

```ts
/** T6①: same tf + same symbol + lookahead_off + gaps_off → evaluate once per
 *  chart bar in the live chart frame and return the PREVIOUS bar's value. */
function evalChartTf(spec: SecuritySpec, frame: Frame, ctx: BuiltinCtx): Value {
  spec.callerScope = frame.scope;
  const callerKey = (spec.callerKey = callsiteKey(ctx, spec.node));
  const bar = ctx.barIndex;
  const prev = spec.chartTfPrev?.get(callerKey);      // 新欄位：Map<object, Value>

  // (1) 圖表幀求值一次（推進有狀態 expr；ident 幾乎零成本）
  const raw = spec.exprs.length === 1
    ? evalHook(spec.exprs[0]!, frame.scope, ctx)
    : { kind: 'array' as const, v: spec.exprs.map(e => evalHook(e, frame.scope, ctx)) };
  (spec.chartTfPrev ??= new Map()).set(callerKey, raw);
  cwMap(spec, spec.chartTfPrev, callerKey);           // 併入 rollback write-log（:242-246）

  if (prev === undefined || bar === 0) return NA;     // ≡ :2146 (j<0)，且不 emit
  // (2) 以 j = bar-1 重新包裝（series 才有意義；scalar 原樣）
  const delayed = spec.exprs.length === 1
    ? alignToChart(spec, spec.exprs[0]!, prev, bar - 1)
    : { kind: 'array' as const, v: spec.exprs.map((e, i) =>
        alignToChart(spec, e, (prev as {v: Value[]}).v[i] ?? NA, bar - 1)) };
  emitChartAll(spec, callerKey, bar, delayed);        // ≡ :2179，[n] 契約不變
  return delayed;
}
```

要點：
- **不動 `spec.ctx`/`spec.scope`/`spec.warmed`/`spec.bars`** ⇒ 暖機迴圈 `:2170-2173`、`advanceTo`、`TfGlobalSeries.at` 遞迴（`:866-880`）全部不發生。
- `alignToChart` 的 lazy-source 分支（`:1091-1095` 快照）在 `j = bar-1` 下會讀錯一格（它用 `src.get(len-1-k)` 相對**活跳** barIndex）。**series 來源為 `BarSeries` 時正確**；遇 lazy source（`FnSeries` `ta.ts:1788`、`CalSeries` `time.ts:122`、math lift）需退回慢路徑（可為 `exprsChartPure` 的一環）。
- 若嫌 `chartTfPrev` 佔位，亦可重用 `spec.chartHist`（含 slot N 前先讀 slot N-1）——但需在 emit 前讀、且 scalar 與 series 兩形都要處理，較繞；`chartTfPrev` 較不易錯。

## 5. 風險

| # | 風險 | 說明 / 緩解 |
|---|---|---|
| R1 | **對齊 off-by-one** | 最高風險。慢路徑值 = tf bar N-1；快路徑 = 前一根 raw。**必須**驗：首根 NA 且不 emit、`cur()` 與 `chartHist` slot 同步。 |
| R2 | **lazy series 來源** | `alignToChart` 快照分支（`:1091-1095`）在快路徑的 `j=N-1` 下讀錯。緩解：來源非 `BarSeries` 即退回（保守、覆蓋不到的東西原路走）。 |
| R3 | **副作用外洩** | 慢路徑把 expr 的 `var`/`:=` 隔離在 `spec.varScope`/`spec.scope`（`:1145-1164`）；快路徑在圖表幀重算 ⇒ 若是含 `:=`/`var` 的 expr 會汙染腳本狀態。緩解：`exprsChartPure`（參照的全域 `def.writes.length===0`）。 |
| R4 | **`tfSeries` 汙染**（僅方案 C） | WeakSet 不可移除 ⇒ 永久改變其他 spec 的 tf 求值。**勿採 C**。 |
| R5 | **中途換路徑混用** | 若某根不再滿足判定（動態 tf/sym 或 feed 改變），慢路徑會從 0..j 重新暖機。因兩路徑寫入 `chartHist[slot N]` 的值相同（都 = expr@N-1），混用本身安全；但**驗收要涵蓋**（至少 1 個 `final.pine` 類的動態 tf 案例）。 |
| R6 | **動態 tf 判定需逐根重評** | 快路徑每次呼叫都重評判定（`:2028` 就在 per-bar 路徑上）⇒ 天然安全；但 `spec.tfResolved` 只由 `:641`/`:2024` 更新，若 tf 變了但 feed key 相同，`:2020` 的 `spec.tfResolved !== tf` 會觸發 `resetTfFrame`。**快路徑不建幀 ⇒ `resetTfFrame` 對它無害**。 |
| R7 | **digest 改變** | 見 §6；位元等價論證成立則 `1580h2`/`18qepy0` 不變。 |
| R8 | **同一 Call node 多個 UDF callsite** | 快路徑用 `spec.callerKey` 分槽（`:2040` = `callsiteKey`），與慢路徑同 key ⇒ `[n]`/emit 分槽一致。 |

## 6. 對 `counters.mtf.*` 的影響（`__mtfStats` 定義 `:1351`）

| 計數器 | 行號 | 預期變化 | 原因 |
|---|---|---|---|
| `evals` | `:1919` | **大幅下降**（該 spec 的所有 eval 歸零） | 快路徑不呼叫 `evalAt`/`computeAt` |
| `hits` | `:1852,:1859,:1874,:1886,:1901` | 下降（該 spec 的 per-caller/agnostic/inv 讀取消失） | 不走三條快取 |
| `agHits` / `invHits` | `:1874` / `:1852` | 下降 | 同上 |
| `prodWalks` | `:1628` | 下降 | 無 `TfGlobalSeries.at` 遞迴 ⇒ 無 producer-walk |
| `gatePass`/`gateFail` | `:1746` | 下降 | `exprSafeForAgnostic` 不被呼叫 |
| `cwPushes` | `:244`（`cwMap`） | **大致持平/微降** | `emitChartAll`→`emitChartOne`→`cwMap(:2187,:2188)`＋`emitChartAll` 的 `cwMap(:2203)` 仍會發生（首見才 push）；快路徑多一個 `chartTfPrev` push（每 caller 1 次） |
| `cwPeak` | `:2385` | 持平（該欄本就壞，見 P5） | — |
| （非 mtf）`seriesWrites.setAt` | — | **明顯下降** | 不再建 tf 幀、無 `advanceTo`（`:1211-1218` 每 tf bar 5-6 次 setAt） |
| （非 mtf）`evalNodeCounts.total` | — | **下降** | 不再重算 prelude（MACD701：`fastMA/slowMA/macd_raw/signal_raw/hist_raw` 全鏈每根重算消失）；只多出 3 個 ident eval/根 |

**digest**：`checks.modelsMatchAcrossPaths` 期望 **`1580h2`（MACD701@100）不變**、`18qepy0`（@500）不變。位元等價理由：同 tf 下 tf bar ≡ chart bar，且 top-level `=` 全域的圖表值與 tf 幀重算值為同一遞迴於同一 bar 資料（`ta.ema` memo 以**絕對 bar index** 為鍵，`:619-640`）⇒ 逐位元相同。**若 R3 未擋（expr 含 `:=`/`var`）則可能分歧**。
驗收建議：`scratch/perf/mtf-perspec-optimized.mjs`（fix-plan P6 指定）量「該 spec 的 evals」；另跑四支 golden 0 差異、954 passed、tsc 0、`s1-inc-probe` parity 6/6、digest `ze7byn/kb0glc/p4gddl/1580h2`。

## 7. 證據索引（現行行號）

| 位置 | 內容 |
|---|---|
| `mtf.ts:176-246` | `SecuritySpec` 欄位（`isLtf :187`、`gaps :184`、`lookahead :185`、`sym/tf :178-179`、`symNode/tfNode :182`）、`cwMap` `:242-246` |
| `mtf.ts:154-155` | `DYNAMIC` / `CHART_SYM` 常數 |
| `mtf.ts:308-345` | `isSecurityCall`；`syminfo.tickerid → CHART_SYM`（`:341`） |
| `mtf.ts:529-560` | `prepareSecurity` AST 掃描；spec 建構 `:539-550` |
| `mtf.ts:607-682` | `prefetchSecurity`：`runConst` 解析動態 `:636-643`；`chartTicker :653`；feed 綁定 `:678-682` |
| `mtf.ts:754-759` | `resolvedSym` / `resolvedTf` |
| `mtf.ts:761-772` | `tfBarAtOrBefore` / `tfBarEnd` |
| `mtf.ts:802-842` | **`tfAnchor` 錨定機制**（`tfSeries` / `get`/`cur`/`atOffset` patch / `seriesHooks`） |
| `mtf.ts:1014-1101` | **`SecSeries`** 與 **`alignToChart`** |
| `mtf.ts:1135-1208` | `ensureTfFrame`（`tfSeries.add` `:1139`；全域 shadow `TfGlobalSeries/TfVarSeries` `:1159-1161`） |
| `mtf.ts:1211-1218` | `advanceTo`（每 tf bar 寫 5-6 series） |
| `mtf.ts:866-880` / `:975-978` | `TfGlobalSeries.at` / `TfVarSeries.at` → 遞迴 `evalAt`（成本來源） |
| `mtf.ts:1824-1944` | `evalAt`（三快取讀 `:1851/:1859/:1874/:1886/:1901`）、`computeAt`（`:1918-1944`，錨定 `:1921-1922`） |
| `mtf.ts:1985-2181` | **`tryEvalSecurity`**（判定點 `:2028` 建議插入處；`j` `:2136-2144`；暖機 `:2170-2173`；emit `:2179`） |
| `mtf.ts:2184-2210` | `emitChartOne` / `emitChartAll` |
| `interpreter.ts:1345,1371-1375,2544-2548` | `NOT_SECURITY_CALL` 與 hook 呼叫點 |
| `interpreter.ts:493-501` | `callsiteKey` |
| `interpreter.ts:653-703` | `bindDeclared`（series ∃ alias `CowSeries`；scalar 走 slot series） |
| `interpreter.ts:1210-1246` | `evalHistref`（**scalar security 結果的 `[n]` 由 `run.callHist` 處理，非 `chartHist`**） |
| `interpreter.ts:288-380` / `:404-436` | `CowSeries` / `SiteSeries`（`atOffset` 轉發） |
| `interpreter.ts:2993-2998` | `registerMtf` 接線（`prepareSecurity`/`prefetchSecurity`） |
| `builtins/ta.ts:619-640` / `:724-731` | `emaVs`（memo 以絕對 bar 為鍵）/ `reg('ema')`（回傳 **scalar** `fl(...)`，非 series） |
| `builtins/ta.ts:1788` / `builtins/time.ts:122` | `FnSeries` / `CalSeries`（lazy 來源 → 風險 R2） |
| `C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine:11-13` | `useCurrentRes=true`（預設）、`res = useCurrentRes ? timeframe.period : resCustom` |
| `.../MACD701_v72.pine:76-82` | producer 鏈 `fastMA/slowMA/macd_raw/signal_raw/hist_raw`；**`:82` `request.security(syminfo.tickerid, res, [macd_raw, signal_raw, hist_raw], gaps=barmerge.gaps_off, lookahead=barmerge.lookahead_off)`** |

## 8. 未定/需主代理決策

1. **tuple 是否可繞**：§3① 與 P6 的退回清單寫「動態 sym/tuple」，但 **T6① 的目標腳本 MACD701 的 expr 正是 3 元 literal tuple**（`[...]`，全為靜態 ident）。若把「tuple」一律排除，**本打點的預期收益（100 根 −20~35ms）歸零** ⇒ 唯一自洽解讀是「**動態**（非 literal）tuple 才退回」。§4 草稿採此解讀。
2. **是否加 `exprsChartPure`**（擋 `:=`/`var`/lazy source）：加了較安全但條件式變多；不加則 R2/R3 直接暴露。建議先實作草稿＋**此謂詞**。
3. **`spec.chartTfPrev` 新欄位**需在 `resetTfFrame`（`:1104-1113`）與 `snapSpec/restoreSpec`（`:2264-2316`）中一併登錄/回捲，否則 forming-bar rollback 會殘留延遲值（**與 P1/T7 rewind 同一族陷阱**）。
