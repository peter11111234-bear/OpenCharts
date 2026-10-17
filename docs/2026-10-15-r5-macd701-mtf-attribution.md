# MACD701_v72「下一個打哪裡」— MTF 成本歸因（2026-10-15，唯讀審計代理 `MtfRemainingCost`）

> 唯讀分析(未跑 benchmark)。計數器取自既有 JSON;時間歸因取自既有 CPU profile(`scratch/perf/prof/macd.cpuprofile`,100 根 × 20 loops,direct)。
> 本報告的秒數皆為 **100 根 direct** 樣本,跨到 500 根屬外推會標 [推論]。

## 0. TL;DR

1. **`__mtfStats.evals` = 4,509,在 100 根與 500 根完全相同**——它是唯一「與圖表根數無關」的計數器。
   原因不是快取失效,而是它由 **tf 序列長度**驅動(`fetch limit = chart span + FETCH_WARMUP 500`,500 根 fixture 把它夾在 500 根 tf bar)。
2. 這 4,509 次 eval 的**主體是「圖表時框的 security」的暖機重播**:`MACD701_v72.pine:11-13` 的 `useCurrentRes` 預設 `true`
   ⇒ `res = timeframe.period = "5"` ＝**與圖表同時框、同標的**,卻仍走完整 MTF 路徑(`:82`)。
   其 producer chain(`macd_raw`→`fastMA`/`slowMA`→`ta.ema`/`ta.sma`)被 `TfGlobalSeries.at → evalAt` 遞迴重算整個 prelude
   ⇒ **`ta.ema` 1,300 次 / `ta.sma` 699 次**,這些是**每次冷載入都要付的固定成本**。
3. 時間大區塊(profile,100 根):`invokeBuiltin` **21.4%**、`tryEvalSecurity` **10.8%**(evalAt 5.0% + computeAt 2.5%)、
   `evalArg` **8.5%**、GC **6.6%**、`math.ts` self **4.0%**、`debugFlag` **2.8%**。**MTF 子樹 ≈ 16% of run**。
4. **`hits` 恆等於 `agHits + invHits`**(4 份資料集逐位元吻合)⇒ **per-caller 快取路徑命中數 = 0**(即 docs H2 的病態仍成立)。
5. `spec.cw`:MACD701 app@100 **cwPushes 4,717 / cwPeak 0**;**冷載入的 cw 是 O(history)**(不是 O(一根 bar));
   **`cwPeak` 欄位是壞的**(只增不減 max 的差值 ⇒ 非首跑永遠 0)。

## 1. 計數器並排（harness 差值）

| 計數器 | @100 app | @500 app | 隨根數成長 | 來源 |
|---|---|---|---|---|
| `mtf.evals` | **4,509** | **4,509** | ❌ **不變** | `bench/pine/r5-final-verify.json`、`a3-final.json` |
| `mtf.hits` | 3,602 | 3,961 | ✅ | 同上 |
| `mtf.agHits` / `invHits` | 2,100 / 1,502 | 2,459 / 1,502 | ag ✅ / **inv ❌** | 同上 |
| `evalNodeCounts.total` | 32,742 | 139,264 | ✅ | 同上 |
| └ `top20[0]` `str` | 9,327(28.5%) | 46,692(33.5%) | ✅ 純線性 | 同上 |
| `callHistWrites` | **0** | **0** | — | 同上 |
| `seriesWrites.setAt` | 17,274 | 66,352 | ✅ | 同上 |

對照 baseline `s12-clean1.json`(500 根 app):`evals=7,995` ⇒ 本輪砍了 **−43.6%**,但**剩下的 4,509 動不了**。
`growth-r3.json`(baseTf=1/5500 根 → tf 序列 ~1,100 根):`evals=10,032`(500 根)= `10,032`(1000 根)
⇒ 再次證明 **evals 跟 tf 序列走,不跟圖表根數走**。

### 1.1 兩個推論

**(a) 固定成本 ≈ 6,200 node evals**:用 @100/@500 兩點解 `count = a + b·N` → 固定部分 ≈ 6,200(與 4,509 次 evals 同階＝MTF 暖機重播),線性部分 ≈ **261 node/根**。

**(b) 命中路徑完全沒被用到**:`3,602 = 2,100 + 1,502`(100)、`3,961 = 2,459 + 1,502`(500)、`8,293 = 4,949 + 3,344`、`8,791 = 5,447 + 3,344`
四次**恰好相等** ⇒ `mtf.ts:1859/:1886/:1901` 三條 per-caller 讀取(`nodeCache`/`durableCache`)命中 = 0。

### 1.2 時間歸因（profile，100 根 direct，on-CPU 7.18s / 21 趟）

| 區塊 | 占比 | 每趟(≈233ms) |
|---|---|---|
| `invokeBuiltin` | **21.4%** | ~50ms |
| ├ `callBuiltin` | 11.3% | ~26ms(`ta.ts` 4.6%、`input.ts` 3.0%) |
| └ `evalArg`→`evalExpr` | 8.5% | ~20ms |
| `tryEvalSecurity`(MTF) | **10.8%** | ~25ms |
| ├ `evalAt ⋯ at` | 5.0% | ~12ms |
| └ `computeAt`/`advanceTo` | 2.5% | ~6ms |
| `invokeUdf` | 5.9% | ~14ms |
| `bindDeclared` | 4.3% | ~10ms |
| GC | **6.6%** | ~15ms |
| self `evalCallDispatch` / `math.ts` / `evalMember` / `debugFlag` / `bindArgs` | 5.1 / **4.0** / 3.3 / **2.8** / 2.5 % | ~12/9/8/7/6ms |

輔助`scratch/perf/r3-hotspot-macd-after.txt`(100 根,run_ms 333.2):`ta_self_ms=57.2`(**17.2%**);`ta.ema` 1,300 calls / 26.72ms / **20.55µs/call**、`ta.sma` 699 / 12.92ms。
註:`ta.ema` 只有 **3.0 gets/bar** ⇒ 貴的不是視窗掃描,是**每次呼叫的固定開銷**。

## 2. 為什麼貴（映射到 `mtf.ts`）

| 行 | 內容 |
|---|---|
| `:176-236` | `SecuritySpec`:`nodeCache`/`agnosticCache`/`invCache`/`durableCache`/`chartHist`/`warmed`/`cw` |
| `:1824-1916` | `evalAt()` 本體;`:1838-1849` verdict memo(1=caller-scoped/2=agnostic/3=tf-invariant) |
| `:1851-1853`/`:1871-1882`/`:1898-1901` | 三條快取讀取(`invCache`/`agnosticCache[node][j]`/`nodeCache[node][caller][j]`) |
| `:1859`/`:1886`/`:1901` | per-caller 讀取——**命中數 0** |
| `:866-880`/`:975-978` | `TfGlobalSeries.at`/`TfVarSeries.at` → **遞迴 `evalAt`**(producer 重算) |
| `:1088-1100`/`:1068-1072` | `alignToChart` 每次配一個 `SecSeries`;`forCaller` 再包一個 |
| `:2170-2173` | `if (!spec.warmed) for (let w=0; w<=j; w++) … evalAt(spec,e,w)` ← **暖機重播整個 prelude** |
| `:2098-2108`/`:2118-2180` | 動態 sym/tf 解析 → j 對映 → emit(打點 ① 的繞過點) |
| `:242-246`/`:2380-2390` | `cwMap`(每次快取寫入 push `{m,k}`)/`mtfCheckpoint` |

三層成本疊起來:(1) 每次 miss 都是一整棵樹重算且走遞迴 evalAt;
(2) 成本由 **tf prelude** 決定(`:2171-2173` 的 `0..j` 迴圈;`j` = 第一根 chart bar 的 tf 索引,被 `FETCH_WARMUP=500` 撐大);
(3) 每次 eval 的配置開銷(`alignToChart` 新 `SecSeries`、`forCaller` 再包、`advanceTo` 每次寫 5–6 個 series、`cwMap` push)。

## 3. 下輪打點（3 個，全部可被現有 harness 量到）

### ①（最高 ROI）「圖表時框 × 圖表標的」的 `request.security` 不進 MTF 引擎
- **動哪裡**:判定點 `mtf.ts:2098-2108`(動態解析完成、`resetTfFrame` 之後);繞過 `:2118-2180` 與暖機 `:2171-2173`
- **證據**:`MACD701_v72.pine:11-13`(預設 `true`)、`:82`(同標的+同時框+lookahead_off+gaps_off);bench `config.tf="5"`
- **預期**:100 根 **−20~35ms(−8~14%)**;500 根同額(固定成本)≈ **−3~4%** [推論];合併 ③ 有機會吃掉 830→750 的缺口
- **風險**:**中高**。tf==chart tf 的對齊必須精確等於「上一根已完成 chart bar 的值」(lookahead_off);
  `lookahead_on`/`gaps_on`/`security_lower_tf`/動態 sym 或 tuple **必須明確退回**原路徑;**不得改動 model digest**
- **驗證**:`counters.mtf.evals` 應自 4,509 明顯下降 + `checks.modelsMatchAcrossPaths`(digest `1580h2` 不變) +
  `scripts/golden/*` 0 差異 + `scratch/perf/s1-inc-probe.mjs` 6/6 維持

### ②（最安全、harness 直接可量）`spec.cw` 冷載入不必全程開著日誌
- **動哪裡**:`mtf.ts:242-246`(`cwMap`)、`:2380-2390`(`mtfCheckpoint`);種下點 `interpreter.ts:3768`、真正 checkpoint `:3689-3691`
- **證據**:app@100 `cwPushes=4,717`(≈ `evals`);同一棵樹 tick 路徑只有 23/23/51/28/28/48(`s1-inc-tris-cw.json`)
- **預期**:每次冷載入少 ~4,700 筆配置(100 根);5000 根 [推論] ≈23 萬筆、~10MB;時間 1–3%(allocation/GC 級),**零語意風險**
- **風險**:低但需精確——只在 forming-bar eval 期間開 logging;若停用時機早於 rollback 會漏記(由 parity 把守)
- **驗證**:`counters.mtf.cwPushes` 冷載入應掉到 ~0(tick 路徑數字不變) + parity 6/6

### ③（最大單一量測區塊）builtin 呼叫路徑的 per-call 配置
- **動哪裡**:`interpreter.ts:1505-1513`(每 call `args[]`+`named{}`)、`:1604-1650`(`evalArg` 每 series arg 一個 `{kind:'series'}`+`siteKey` 探測)、
  `builtins/util.ts` `bindArgs`(每 call 建 `Map`+字面 name 陣列)、`builtins/ta.ts:162-179`(`stateFor` 每次呼叫重建 `parts` 陣列+巢狀 Map)、
  `builtins/math.ts:94-96`(`args.concat(namedValues(...))` + `Object.entries(named)` = 每 call 兩個陣列)
- **證據**:profile `invokeBuiltin` 21.4% + `callBuiltin` 11.3% + `evalArg` 8.5% + `math.ts` self 4.0% + `bindArgs` 2.5%;
  `ta.ema` **20.55µs/call 但只有 3.0 gets/bar** ⇒ 成本在 per-call 開銷
- **預期**:**5–10%**;500 根同量級或更高 [推論]
- **風險**:中。`stateFor` 的 key 身分必須逐位元保持(否則 ta.* 狀態被重建)
- **驗證**:`evalNodeCounts`/`setAt`/`mtf.evals` **完全不變**、digest `18qepy0`/`1580h2` 不變;
  `scratch/perf/ta-hotspot.mjs` 的 `us/call` 下降而 `gets/bar` 不變

> 第 4 候選(列管,不單獨開輪):literal `Value` 每次求值重新配置(`interpreter.ts:821`、`:2093`、`:3842`、`:2395`)——`str` 在 500 根是 46,692 次(33.5% of node evals),但每次只是小物件配置,屬「乾淨但不大」。

## 4. `spec.cw` 觀測與長歷史隱憂

| 路徑 | cw 生命期 | 長度 |
|---|---|---|
| 冷載入(`incRunStart`) | bar −1 → bar N−2(全趟) | ≈ 每根 26–45 筆 ⇒ 100 根 ≈4.7k、500 根 ≈2.3 萬、**5000 根 ≈23 萬** |
| live tick(`incAdvance`) | 一個 forming bar | 23–51(實測) |

`interpreter.ts:3766-3769` 在還沒跑任何 bar 就先 `checkpoint(s,-1)`,把 `spec.cw ??= []` 從 bar −1 開著;
直到 bar N−2 的**唯一一次** checkpoint 才清空(`:3690`,註解說明「per-bar checkpoints were O(N²)」)。
⇒ **冷載入的 cw 是 O(history)**;且第一次 tick 的 rollback(`mtf.ts:2310-2316`)要**逐筆走完整個 log 再清空**。

**同族第二隱憂**(同屬 checkpoint 成本,非 mtf.ts):`snapCtxState` 對每個 plain object `cloneDeep`(`interpreter.ts:3330-3331`,還原 `:3389-3391`);
strategy 腳本的 `simCache.byBar`/`excCache`/`ddCache.equity` 走這條 ⇒ 冷載入只有 2 次 checkpoint 故 O(history) 一次,
但 **live tick 每收一根就一次** ⇒ 長 session Θ(history)/tick。**其 B² 版本已由另一份審計量化 → 見 `docs/2026-10-15-r5-checkpoint-deepcopy-audit.md`。**

## 5. 證據索引

| 位置 | 內容 |
|---|---|
| `mtf.ts:1824-1948` | `evalAt` 三條快取＋verdict memo;`computeAt`/`evalNode` |
| `mtf.ts:866-880`/`:975-978` | `TfGlobalSeries.at`/`TfVarSeries.at` → 遞迴 `evalAt` |
| `mtf.ts:1068-1100` | `forCaller` 再包;`alignToChart` 每次配 `SecSeries` |
| `mtf.ts:1211-1233` | `advanceTo`(tf bars → per-spec BarSeries) |
| `mtf.ts:1985-2207` | `tryEvalSecurity`(callerScope/callerKey 重綁、seenCallers 路由、j 對映、`warmed` 重播、`emitChartAll`) |
| `mtf.ts:242-246`/`:2264-2316`/`:2380-2390` | `cwMap` / `snapSpec`+`restoreSpec` / `mtfCheckpoint`(cwPeak、清空) |
| `interpreter.ts:475-501`/`:1505-1513`/`:1604-1650` | `siteKey`+`callsiteKey` / `invokeBuiltin` / `evalArg` |
| `interpreter.ts:3330-3331`/`:3389-3391`/`:3459`/`:3537`/`:3690`/`:3768` | `snapCtxState`/`restoreCtxState`/`checkpoint()`/`mtf.checkpoint()`/唯一 checkpoint/`checkpoint(s,-1)` seed |
| `ta.ts:162-179`,`:186`,`:600`,`:705-708` | `stateFor` 巢狀 Map 與 key parts;`ta.ema` 本體 |
| `math.ts:94-96` | `liftNums`:`args.concat(namedValues(...))` |
| `input.ts:98-140` | `recordAndOverride`(每根每 input:WeakMap+Map+2 dict+`{...v}`) |
| `MACD701_v72.pine:11-13,56,77-82,206` | `res = timeframe.period`(預設 chart tf)、`divHigherTF="D"`、producer、兩個 `request.security` |
| `scripts/perf/lib/bars.mjs:20-21,140-160` | `FETCH_WARMUP=500`、`limit = n + 500` |

**唯一需要新儀器的地方**:若要把 `evals/hits` **按 spec 分開計數**(現有 `__mtfStats` 是全域單一計數器,無法區分 "5" 與 "D" 兩個 spec) → 打點 ① 的精確收益需要它。
