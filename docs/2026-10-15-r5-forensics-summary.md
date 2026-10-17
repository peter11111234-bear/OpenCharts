# R5 取證摘要（六探子，2026-10-15 20:2x）

> 對「凍結優化樹」取證：`src/pine/mtf.ts` md5 `79d67c66b8e19349b4fdaeeaef5d3d79`（2411 行）、`interpreter.ts` 3963、`series.ts` 722、`builtins/ta.ts` 2164。
> 取證期間 `src/pine` 未被修改；原始證據在 `scratch/perf/`，各項細節在對應 docs。

## 1. 四處更正（最重要，推翻既有文件結論）

### 1.1 T7 根因＝(d) 上游雙 rewind，不是繪圖層 rollback 不完整

- **三個原假說全部被推翻**：(a) 沒有殘留建構期物件（5 個 drawing 全是新實例）；(b) committed checkpoint 的繪圖面只有 table、沒有可還原的 props；(c) handle 每次 `islast` 都由 `:= line.new(...)` 重綁，`line.delete(舊 handle)` 是 no-op。
- **`id` 不是身分標記**：idx4/5 的 id live=cold=5/6；`sameRefAsTick0=[true,false,…]`；`context.ts:264-270 incRestore` 把 nextId 7→2 後重新配號 ⇒ 票券「id 相同 ⇒ (b)」的判別法失效。
- **機制**：tf-frame 序列的 `[1]` 在 forming bar 被讀成當前值。別名 `snap.buf` 同一次 rollback 被 rewind 兩次（`interpreter.ts:3546` 先、`mtf.ts:2396→2346/2354` 後，病灶 `series.ts:114-128`）→ `prevFrozen_H/L`（`TRIS390.pine:718-721`）→ `prevWickLine/prevBodyBox` 價格座標差 24/6 點。
- **活化律（10/10 相符）**：只有 forming bar 是新框首根（`slotInFrame==0`）才分歧；歷史長度無關（suffix 300/400/500 全 mismatch）。
- **最小分歧根數＝150、非單調**（120 match／150 mismatch／200–400 match／500 mismatch）。
- 旁證：`scratch/perf/iso/rewind.json`（每個 tf-frame series 恰 rewind 2 次）、`s1-inc-t7-tris-probe.json`（首個分歧欄 `plots[36]`）。
- **未驗**：只掃 `hHTF1/lHTF1` 一組 security；其餘 28 個與其他 tf 未驗。

### 1.2 T8 主導項＝每根 `simAt` miss 的 replay ramp（**不是** epoch cache 丟棄）

- `replaySteps` ＝ **B(B−1)/2**：4,950／19,900／124,750（bars 100/200/500）；5× bars → 29.5×。
- `epochRebuildSteps` ＝ **0/0/0**、`wastedReplays` ＝ 0 ⇒ 丟棄造成的額外重算為零。
- 差分：epoch 數 25×（4→100）→ 步數僅 **+2%**；讀取砍到 B/25 → 步數 249、ms 938→43.9；完全不讀 → 全趟 1 次 replay、23/45 ms（線性）。
- 修法方向（未實作）：Sim 增量（`simulate(N)=simulate(N−1)+新一根`）或鍵改「已提交前綴＋增量」。詳見 `docs/2026-10-15-t8-replay-attribution.md`。

### 1.3 T11 前提更正：「per-caller 命中＝0」只對三支成立

- MACD701／K55／final 的 expr 全純量＋agnostic ⇒ 根本不走 per-caller 路徑（殘差恆 0）。
- **TRIS390 有殘差**：per-caller ＝ `hits−agHits−invHits` ＝ **7481 @500／1692 @100**，且**跨樹逐位元相同**（基線 `s12-clean1` 12444−4963；優化 `a3-final` 17999−658−9860）⇒ R5 未動到該路徑。
- **`invHits` 必須用顯式計數器**（`counters.mjs snapshot()`）；`hits−agHits` 是探針反推值，不可當命中證據。
- 真缺陷：寫鍵＝呼叫者 `Scope`，UDF 內每次 invocation 都是新配 `callScope`（`interpreter.ts:1733`）⇒ 寫了永遠讀不回；穩定身分已在＝`spec.callerKey`（`mtf.ts:2040`／`interpreter.ts:499`）。詳見 `docs/2026-10-15-t11-key-attribution.md`。

### 1.4 T12 五項全部存在於本樹（逐項 grep 驗證）

| # | 項 | 判定 |
|---|---|---|
| 1 | `cwPeak` 恆 0（`__mtfStats` 模組單例永不重置＋harness 取差值） | **修**（`MtfHooks.resetPeak()`） |
| 2 | `spec.cw` 冷載入 Θ(bars)（≈2/bar；100 根 4,717 pushes／1,500 根 3,000；entries 全死重寫） | **修**（`MtfHooks.trimCw?()`） |
| 3 | C2 `ta.vwma` 1 ulp（rel≈2e-15、golden 無 vwma plot） | **只記錄**（修＝拿效能換零收益） |
| 4 | C3 `wring` latch（`ta.ts:402-403`；實測三形狀 SAME） | **修 1 行**（`i < ctx.barIndex` 才 set） |
| 5 | `bind` 契約（`series.ts:615` duck test；零測試覆蓋） | **修 3 行**（`readonly siteAnchor?: true`） |

詳見 `docs/2026-10-15-t12-small-items.md`。

## 2. 新增可用儀器（都已落檔、零引擎改動）

| 儀器 | 檔案 | 用途 |
|---|---|---|
| per-spec 計數 | `scratch/perf/mtf-perspec-optimized.{mjs,json}` | TRIS390 100 根 total evals 626／hits 3265／agHits 130（基線 1701／2190／1007）；26 站 byCallsite 可加總回全域、residual 0 |
| T7 二分／位移 | `scratch/perf/t7-{identity,bisect,bisect-suffix,shift}.{mjs,json}` | 最小分歧根數、活化律、`[1]` 位移點 |
| T8 歸因 | `scratch/perf/t8-replay-attrib*.{mjs,json}` | replay 步數／epoch 差分實驗 |
| T9 上限量測 | `scratch/perf/t9-distinct-len.{mjs,json}` | 真實腳本每群 ≤9；`growL-*` 無界形 240 |

## 3. 樹與回退來源

- 優化樹複本：`scratch/perf/r5-pine-optimized-b9/pine`（131 檔，與 runner pre-flight 快照逐檔 md5 相同）。
- 現況：`series.ts` md5 `e158d372f3a4328f11e2d2f5ccda8c93`（T7 patch，另一代理套用）、`mtf.ts` `79d67c66…`。
- `docs/2026-10-15-r5-autorun-status.json` 曾因多一個 `}` 而無法 parse（13:45 起），已於 20:21 修復（備份 `.bak-20261015-2021`）。

## 4. 缺口（未做／未驗）

1. T7 修補的 `--bars 500 --ticks 5` 0 mismatch 與 bisect/suffix 全 match 驗收**未閉合**。
2. T8b（series registry 每 tick +150/+201）**未量**，與 replay ramp 是兩個獨立項。
3. 5,000 根未跑（先前 timeout）。
4. T3／T4（A3 分級門檻、A6 增量預算）需安靜機；機器在取證期間負載 77–91%，未產出有效數字。
