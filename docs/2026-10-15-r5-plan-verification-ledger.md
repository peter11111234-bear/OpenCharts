# R5 計畫書 —— 獨立查驗缺陷帳（2026-10-15）

> 方法：6 個獨立唯讀探子（V1–V6）分頭查驗 `docs/superpowers/plans/2026-10-15-r5-remaining-fixes.md`
> 的每一項可執行性前提，要求「逐字原文＋file:line」證據，任務設定為「找出計畫哪裡是錯的」。
> 根因：計畫先憑記憶寫、後查驗（違反「先查驗好再寫」）。以下 11 條全部有探子證據。

| # | 缺陷 | 抓到的探子 | 處置 |
|---|---|---|---|
| 1 | Task 1 測試 import 的 `./harness` 與 `runPine`／`expectEqualValuesAcrossCaps` 不存在 | V1 | 改寫：用 `ta.test.ts:22-56` 的 `newCtx/pushBar/runBars` ＋ `BUILTINS.get('ta.dmi')` |
| 2 | 想從 `RunResult` 讀 `ctxState` —— 該欄位不存在（`interpreter.ts:3174-3188` 無 `state`） | V1 | 改為直呼 builtin 後讀 `(ctx as RtCtx).state`；counters 不含 `dvs/stv`，無法替代 |
| 3 | 「子群加總 ≤16」語意錯 | V1 | 改為斷言單一 leaf map 的 size（`state.get('dvs').get('dmi+p').get(diL).size`） |
| 4 | 用 `t9-distinct-len.mjs --bench` 驗 dmi/kc —— `TARGET_KINDS` 僅 `dvs/ema,dvs/hma,dvs/hma-in,stv/rma` | V6 | 該腳本只驗既有 4 型；dmi/kc 由新測試驗。且 `benchMaxDistinctLenSaturating` 只寫 JSON 不印 stdout |
| 5 | **T6② patch 會 crash**：刪唯一建立點 `mtf.ts:2384 spec.cw ??= []` 卻留無防護的 `:2387 spec.cw.length = 0`；寫入路徑 `:243 if (!spec.cw) return;` 不 lazy 建立 | V2 | **patch 下架**（`.WITHDRAWN`）；改為 D2 決策（T2，需人工確認） |
| 6 | 9 行斷言寫成「7 條」；`--warmup 0`；「`--bars 500` 的 bench」（凍結值皆 100 根） | V3/V6 | 以 V3 實測表改正（`perf_bench:161`；`mtf.test:365/383/429/468/624/675`；`mtf_invariance:266/268`） |
| 7 | Task 4 要改的那一行**現樹已修**（`ta.ts:412` 改 set 側 `i < ctx.barIndex`），且原 probe 驗不出差異 | V4 | 整段重寫：改為「覆核既有修法 ＋ 加 V4 的 `ta.stoch` 判別性測試（1050 → 525）」 |
| 8 | Task 5 skip 側測試構造不出來：既有 `DelayedEngine` 必留 live session；且必須同步斷言（`waitFor` 會永久 hang） | V5 | 需新增 `HeavyNoLiveEngine`（跑完把 `opts.incHolder.live=null` 且 `active=false`） |
| 9 | digest 重現指令用 `scratch/perf/app-scripts/macd701_v72.pine`，重現不出 `1580h2`（權威來源為 `high452/MACDV7.04/MACD701_v72.pine`） | V6＋自行覆核 | 指令改寫（含 `--bars-file`／`--tf`／`--symbol`／`--engine-path direct`）；凍結值：`ze7byn/kb0glc/1580h2/p4gddl` |
| 10 | 排序自我矛盾：Architecture `T11→T6②` vs `Blocked by` 反向 | V6 | 實驗（patch 逐 hunk 字串套用）證明兩序皆相容且最終內容**逐字相同** ⇒ 統一為 `T11→T6②` |
| 11 | 我自己的查驗腳本有 bug（Fact Annex 只掃行內 backtick；`json.loads` 硬讀含控制字檔而炸） | 我 | 已修正做法：路徑一律用「全檔 regex ＋ 逐一存在性檢查」；讀 JSON 前先清洗控制字元 |

## 已由本輪查驗**確認無誤**的部分
- `vseries(...cap?)`（`ta.ts:212`）、`stateFor(...cap?)`（`:162`）、`VS_LEN_MAX = 16`（`:450`）皆存在；6 個補 cap 點確實缺 cap（含 5 個已 cap 對照組）。
- T6② patch 的 5/5 hunk 原文側逐字命中（可套用）——**但套用後會 crash**（缺陷 5）。
- T11 patch 的 10 hunks、7 個被翻紅斷言的現行原文與行號全數實測吻合；刪除 `durableCache/seenCallers/EMPTY_SCOPE` **不會**破壞測試編譯（無測試引用這些符號）。
- `s1-inc-probe.mjs`／`pine-bench.mjs`／`t7-bisect.mjs`／`t9-distinct-len.mjs` 的 flag 全數存在；`s1-inc-probe` 的輸出契約是 `PARITY OK` / `PARITY FAILURES: n`（不是「6/6」）。
- `engine.ts:347` 的 skip 條件逐字相符，`HEAVY_RUN_MS = 500`；skip 側**確實零測試**。

## 附錄：查驗後的樹狀態變化（2026-10-15 21:5x）

撰寫 v2 計畫與本帳之後，另一代理（窗口 C，20:30–22:15）又推進了樹：

| 項 | 狀態 | 證據 |
|---|---|---|
| **T11** | **src 已套用**（用的是我的 patch，或等效實作） | `mtf.ts` md5 由 `79d67c66…`→`650025e1…`（2411→2388 行）；`:200` 已是 callsite 鍵型別；`:2039-2042` 為我 patch 的註解原文；`durableCache/seenCallers/EMPTY_SCOPE` 全消失 |
| T11 的 patch | **失效**，已改名 `.patches/r5-t11-callsite-cache-key.patch.APPLIED-BY-PEER` | `git apply --check` 由 rc=0 變 `error: patch failed: src/pine/mtf.ts:189` |
| T11 測試期待值 | **部分完成**：`perf_bench.test.ts` 已改（`>5000` 移除，改 `agHits===0`＋`hits>10_000`，註明 evals ~6k→~1.5k）；`mtf.test.ts:365/383/429/468/624/675`、`mtf_invariance.test.ts:266/268` **仍為舊值** | 逐行 grep（舊值 `>=12`／`Set>=4`／`every===1`／`toBe(20)` 全在） |
| 樹的健康狀態 | [推測] 上述 8 行未更新 ⇒ 那幾個 case 應為紅燈（依 V3 的機制分析：evals 由 ≈20/≈12 降為 ≈2–3） | 尚未實跑 `vitest`（避免與 owner 的活動互擾）；誰要接手請先跑 Step 0 的 vitest |
| **T9** | **尚未套用**，patch 仍有效 | `git apply --check r5-t9-gap-vs-len-cap.patch` → 通過；`ta.ts` 的 6 處仍無 `, VS_LEN_MAX` |
| **T6②** | 維持下架 | `patches/README.txt` |
| T12#4 | 樹上已完成（擋 set 版） | `ta.ts:412`（V4 查驗） |

**給接手的執行者**：本計畫 Task 3 已改為「先跑 Step 0 判定」，因為 src 面已由另一代理完成；**不要**再對 `mtf.ts` 套任何 patch。

## 狀態更正（2026-10-15 22:0x）：T11 已不在樹上

上一節「T11 src 已套用」的記載**已失效**。實測（22:0x）：

| 檔 | mtime | 現況 |
|---|---|---|
| `src/pine/mtf.ts` | **21:25:50** | md5 **`79d67c66b8e19349b4fdaeeaef5d3d79`**、**2411 行**、`durableCache\|seenCallers\|EMPTY_SCOPE` = **16 命中**、`:202 nodeCache: Map<Node, WeakMap<Scope, Map<number, Value>>>` ⇒ **T11 前的狀態** |
| `src/pine/__tests__/{mtf,mtf_invariance,perf_bench}.test.ts` | 21:25:50 | **與 HEAD 相同**（`git status` 無改動）；`mtf.test.ts:365/383/429/468` = `>=12`、`:624/675` = `Set>=4`、`mtf_invariance:266` = `every===1`、`:268` = `toBe(20)` ⇒ T11 前期待值 |
| `src/pine/builtins/ta.ts` | 20:45:36 | `VS_LEN_MAX)` = 6 ⇒ **T9 未套** |
| `src/pine/interpreter.ts` / `series.ts` | 21:02 / 20:57 | `2c3c1796…` / `f93a461c…`（皆相對 HEAD 有改動） |

- 時序證據：`$TEMP/r5-preapply-2105` 存在 ⇒ **21:05 有人跑過 `apply-all.sh`**（把 T11 套上）；21:25:50 有批次還原（四個檔同秒寫）。
- 我 21:23:45 起的那次 `vitest`（2 failed | 952 passed）是跑在**T11 已套**的舊狀態上，**不代表現況**。
- 兩支 patch 對現行樹實測：`r5-t11-callsite-cache-key.patch` **APPLIES**（已還原檔名）、`r5-t9-gap-vs-len-cap.patch` **APPLIES**。
- ⚠️ 未解：`perf_bench.test.ts` 內同時存在 `:161 expect(d.evals).toBeGreaterThan(5000)`（T11 前）與 `:183 agHits===0`／`:184 hits>4000`（T11 後敘述＋門檻），而該檔與 HEAD 相同。若 T11 要套回，這兩處必須一起裁定（見 plan Task 3 Step 4）。

## 現況複驗（2026-10-15 21:31:15 起跑，對「已復原」的樹）→ **全綠**

```
Test Files  62 passed (62)
     Tests  954 passed | 1 skipped (955)
```

- 交叉指紋：現行 `src/pine/mtf.ts` md5 `79d67c66b8e19349b4fdaeeaef5d3d79` **與 `docs/2026-10-15-r5-autorun-report.md`（18:00 窗口 B 基線）記載的 `79d67c66b8e1` 逐字相同** ⇒ 復原後等於 18:00 已驗基線。
- 但 `series.ts`（`f93a461c…` vs 基線 `e158d372…`）與 `interpreter.ts`（`2c3c1796…`）**已偏離** 18:00 基線 ⇒ 18:00 的 digest/golden 驗證**不自動轉移**，須重跑（見下）。
- **更正**：先前說 `perf_bench.test.ts` 是「半新半舊混種」——錯。該檔與 HEAD 相同，且**在 T11 前的樹上會過**。真正的 T11 耦合是 `:161 expect(d.evals).toBeGreaterThan(5000)`：T11 會令 evals 由 ~6k 降至 ~1.5k ⇒ 套 T11 必紅（與 V3 的機制分析一致）。
- 21:23:45 那次 `2 failed` 是跑在「T11 已套」的中間狀態，**不代表現況**；該狀態已被 21:25:50 的還原消除。

## P10 定案：adaptive tick-skip 是**不可達死碼**（2026-10-15 22:0x 查驗）

**爭點**：另一對話的計畫（P10）要「把 `engine.ts` 的 adaptive tick-skip 當死碼移除」；V5 的查驗則說「skip 側零測試 ⇒ 不可證明死碼」。**裁決：P10 成立，V5/我的保守立場被推翻。**

**skip 條件**（`src/pine/engine.ts:347`）：
```ts
if (!force && lastRunMs > HEAVY_RUN_MS && !incHolder.live && !incHolder.active && key === lastTapeKey) return;
```
`HEAVY_RUN_MS = 500`（`:338`）；`lastRunMs` 僅在 run 成功後寫（`:413`）；`lastTapeKey = key`（`:348`）。

**證明「`lastRunMs > 500` ∧ `active === false`」不可達**：
1. `incHolder.active` 全樹只有兩個寫入點，**皆為 `= (live !== null)` 語意**：`engine.ts:486`（in-process；且是全檔唯一寫入）與 `pineWorkerEngine.ts:44 active = client.incAlive`，而 `client.incAlive = (out.live !== null)`（`pineWorker.ts:149/159` → `pineWorkerClient.ts:158`）。**沒有任何地方把 `active` 重設為 false。**
2. 唯一把 `incAlive` 設 false 的是 `pineWorkerClient.ts:248` 的 `dispose()`；`dispose()` 只由 `stop()` 觸發，而 `stop()` 設 `stopped = true`，`request()` 在 `:345` 就早退 ⇒ **之後不會再有 tick 到得了 skip**。
3. **非空 tape 的成功 run 必然產生 live session**：`incRunStart` 對 `bars.length === 0` 已早退（`interpreter.ts:3693`）；`buildSess` 全函式的**唯一 `return null` 就是 `bars.length === 0`**（`:2904`，grep 實證）。其餘 `live: null` 出口只有 `shouldAbort()`（`:3698/:3718/:3726` ⇒ `stopped` ⇒ 依 (2) 無後續 tick）。
4. 首跑時 `lastRunMs === 0` ⇒ 第一次 request 永不跳。
5. 因此：能讓 `lastRunMs > 500` 的那次 run，必然同時把 `active` 設成 `true`；而 `active` 之後不會回到 `false`。

**worker 模式的關鍵事實**（生產線＝`velaPineEditor.ts:383` 匯出 `PineWorkerEngine`）：`pineWorkerEngine.ts:39` 把 `incHolder` 從送進 worker 的 opts **拆掉** ⇒ **主執行緒永不寫 `incHolder.live`** ⇒ `!incHolder.live` **恆真**，skip 的唯一守門是 `active`（同 (1)）。

**要移除時必須一起做**（否則留下說謊的註解／文件）：
1. `engine.ts` skip 區塊 ＋ `HEAVY_RUN_MS`／`lastRunMs`／`lastTapeKey`／`tapeKey`（若無他用）。
2. `engine.test.ts:310-316` 與 `:333-335` 的敘述（宣稱 forming-bar ticks are skipped）。
3. `docs/2026-10-14-pine-perf-align.md` 描述該政策的段落標為「已證明不可達、已移除」。
4. **保留一條不變式測試**：heavy run 後 `incHolder.active === true` 且 `!live` 不成立——這是把「死碼的前提」變成可執行斷言；若未來出現「非空 buildSess 失敗」路徑，它會先紅，而不是靜默每 tick 全量重跑卡 UI。
5. **不要**採用 V5 提議的 `HeavyNoLiveEngine` 常設測試：它靠人工偽造 `live=null, active=false` 造出**不可達狀態**；「必須偽造才驗得到」正是死碼的旁證。

## T11 定案：**patch 會改壞值，已下架**（2026-10-15 22:2x）

`r5-t11-callsite-cache-key.patch` 套用乾淨、`tsc` 0、閘門計數變好——**但會改壞值**，故下架（`.WITHDRAWN-BREAKS-VALUES`）。

**證據（兩條獨立來源）**
1. 另一代理（omp，`docs/2026-10-15-omp-p2-p7-p10-notes.md`〈P4〉）在真樹實測：套 patch 後 `perf_bench.test.ts` 的 `PARAM_SRC`，`a − a2` = `f(close) − f(open)` 在 bar 13–18 **恆為 0.6090120128041576**；應為圖表自己的 `close − open`（0.5942／0.5785／0.5621／0.5449／0.5271／0.5087，逐根不同）。
2. 本計畫覆核 repo 既有守門斷言（`src/pine/__tests__/perf_bench.test.ts:171-172` 逐字）：
   ```ts
   expect(diffs.every((d, i) =>
     d === null || Math.abs(d - (CHART_BARS[i]!.close - CHART_BARS[i]!.open)) < 1e-9)).toBe(true);
   ```
   並附註解（`:162-170`）：「Rejected expr must still serve the PASSED series: f(close) at two callsites agrees bar-for-bar; f(open) differs by exactly the open-vs-close delta — **a wrongly-shared/stale cache can't satisfy both**」。
   ⇒ 這是**正確性不變式**，不是「舊快取行為的描述」⇒ 不可用更新期待值帶過（本計畫 v2 的 Task 3 Step 4 把它當可更新項，**是錯的**）。

**機制**：閘門 reject 的運算式（verdict 1／caller-scoped）之值依賴呼叫者**當下的值**（`p` = `close`|`open`，逐 chart bar 變）；把鍵改成不含任何隨 chart bar 變化的量（callsite 身分）⇒ 必然在同一個 tf bar 內回用第一次算出的值。D1 的 revisit trigger 因此觸發。

**後續**：需重做（omp 建議：(1) 只讓非 reject 者走 callsite 鍵；(2) 加「是否讀取呼叫者綁定」旗標；或 (3) 不做）。驗收必須含 `perf_bench.test.ts:171-172` 全綠 ＋ 逐根 delta 陣列。

## P10 定案更正（2026-10-15 22:5x）：**我方「死碼」結論有洞，對方回退正確**

**我方先前寫的**（本帳上一節）：skip 分支不可達 ⇒ 移除安全。**該結論撤回。**

**洞在哪**：我假設「空 tape 的 run 為 O(1)、不可能 >500ms」——**這是未經查證的假設**。`incRunStart` 對空 tape 仍呼叫 `runScriptInner`（仍要 parse/compile），重的腳本可以 >500ms。

**實際可達路徑**：
1. `bars.length === 0` ⇒ `incRunStart` 回 `{ live: null }`（`interpreter.ts:3698`）⇒ 該次 run 後 `active = (out.live !== null) = false`（寫入點 `engine.ts:486`／worker `pineWorkerEngine.ts:44`）。
2. 只要**前一次 run 的 `lastRunMs > 500`**，且下一次請求的 key 相同（空 tape 的 `tapeKey` 恆為 `"0:0"`）⇒ `engine.ts:347` 的 skip **觸發**。
3. ⇒ 空 tape ＋「每次 run 都 ≥500ms」的序列下，重複的空 tape 請求會被丟掉（不重跑）。

**對方（另一對話）的處置與證據**（`PROGRESS.md`〈六探子結論＋四處更正〉＋ 2026-10-15 22:5x 實證）：
- `engine.ts` 與 R5 基線 `diff -q` → **IDENTICAL**；`:338 HEAVY_RUN_MS`／`:342 lastTapeKey`／`:347` 守衛行在位。
- `engine.test.ts` 新增 `repeated empty-tape request is dropped while the last run is slow`，且**偵測力已驗**：停掉守衛 ⇒ 第 405 行 `received 2` 失敗（**實跑，非推論**）。
- `engine.test.ts` 原有 3 處「守衛被證明不可達並已移除」的假註解已改成真話；`series.ts` 的 P1 註解亦已收斂。
- `tsc --noEmit` = 0；`engine.test.ts` 23/23；`npx vitest run src/pine` → **62 檔全過、955 passed | 1 skipped**（比基線 954 多 1 條＝對方新增的測試）。

**教訓（寫給未來的我看）**：證明「不可達」時，**不能把「某條路徑很快」當成前提**；必須窮盡「使守衛條件成立」的所有狀態組合，並以**可偵測的測試**取代推論。

**本計畫的跟進**：Task 5 已改成「已由對方處理完畢 ⇒ 本任務只做覆核、不得刪碼」；`vitest` 的不變式由「954 passed」改為「**passed 數不得下降（基線 954，現況 955）**」。
