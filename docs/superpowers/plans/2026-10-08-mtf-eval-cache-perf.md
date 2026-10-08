# Pine Interpreter MTF 效能加速計畫 v2（scout 查驗後修訂）

> **日期：** 2026-10-08
> **備份：** `backup/vela-pre-mtf-perf-20261008` branch + `backup-vela-20261008` tag @ e9fdd9c

**Goal:** 讓 TRIS390（8× request.security，802 行）之類的 MTF 腳本在 /vela 從「轉一分鐘＋偶發卡死」到「幾秒內出圖」，語意與 TV 一致。

**Architecture:** 不換引擎。三個獨立加速：(1) 真實 profile 找出熱點、(2) evalAt 對「不引用 caller 綁定」的表達式改用 caller-agnostic 快取、（3) per-bar `allSeries.ensureBar` 掃描降成髒集合追蹤。每步獨立可驗證、可回退。

**Tech Stack:** TypeScript, vitest, node --cpu-prof / Performance API

**Spec:** TV parity — `request.security` 行為不改變，只改計算策略；golden test 必須維持通過。

**Spec invariant:** 任何快取都不能讓同一個 (expr, tfBar) 在不同呼叫者看到錯的值 —— 只在「表達式子樹不引用任何 caller-bound 名稱」時啟用 caller-agnostic 快取。

## Executor Rules

- Profile 先跑，數據說話；數字跟假設不符就回頭改計畫順序，不硬實作。
- golden.test.ts 是紅線：任何 task 收尾必跑 `npx vitest run src/pine/__tests__/golden.test.ts`。
- **Plan-specific Nevers:** NEVER 對引用 `x[n]`/caller param/UDF local 的 expr 啟用 agnostic cache（D1 的 gate 條件）；NEVER 在 Task 3 前動 `BarSeries.setAt` 的 carry-forward 語意。

## Global Constraints

- 不改 RunResult/series 的對外型別；不改 vela 套件（node_modules 唯讀）。
- 所有修改在 `src/pine/` 內；測試放 `src/pine/__tests__/`。
- 每個 task 完成就 commit（小步可回退）。

## Files

- `scratch/perf-probe.mjs`（新建）：vitest 外獨立跑的計時/計數探針 —— 載入 interpreter，注入 fake bars，跑指定腳本，輸出 evalAt/setAt/ensureBar 呼叫數與耗時
- `src/pine/mtf.ts`：`evalAt` 快取路由 +（Task 3）`advanceTo`/`emit` 優化
- `src/pine/interpreter.ts`：（Task 3）`run.allSeries` → `run.dirtySeries` 髒集合
- `src/pine/series.ts`：（Task 3）`ensureBar` 早退捷徑
- `src/pine/__tests__/perf_bench.test.ts`（新建）：回歸用基準測試，斷言「同一 MTF 腳本跑兩次，第二次 evalAt 數 ≤ 第一次的 X%」

## Scout 查驗結論（v2 修訂依據）

四個 scout 查驗後確認：
- **現況瓶頸確認**：transient UDF scope 不只 miss —— `tryEvalSecurity` 每次 first-sighting 會**整個重置 `spec.nodeCache = new Map()`**（mtf.ts:1248-1253），任何 security() 在 UDF/三元/條件內被呼叫時，跨 bar 快取全滅 → O(chart bars × tf bars) 重算。這是 TRIS 卡死的真根因。
- **Task 3 原案（dirtySeries）被兩個 Critical 判死**：跳過 unwritten slot 的 ensureBar 會讓 `rLen()` 停滯 → `s[4]` 讀 NA、`ta.sma(x,…)`/`size()` 讀錯位、LiftedSeries `shift` 不累積。ensureBar 不是「填值」是「實體化歷史長度」，不能跳。改成 **D+ membership pruning**（見 D2 修訂）。
- **agnostic gate 必須遞迴掃 UDF body**：expr `f()` 內的 free ident 仍可穿 PivotScope→callerScope。且 `evalIdent` 是 scope.lookup **先於** builtin fallback —— 連 `ta`/`syminfo` 都可能被 caller shadow，gate 要保留 builtin-namespace 白名單 + 註記殘留風險。
- **agnosticCache/agnosticSafe 必須加進 `resetTfFrame`** —— dynamic tf/sym 切換不清的話吐舊 symbol 的值。
- **mutable payload 不落 cache**：array/udt/map/line/label/box/table/polyline/function/void 等 kind 只可回傳不可 cache（跨 caller 共享可變物件）。
- agnostic 讀寫要在 `seenCallers` 路由重綁 `spec.nodeCache` **之前**執行。
- 好消息：var replay 是單調且 hit-safe；emit/chartHist dedup 不受 cache 影響；`mtf.test.ts:273` 已有 cache 語意測試可延伸。

## Decision Points

### D1: evalAt 的 caller-agnostic 快取要怎麼 gate   (T1)
- Consumed by: Task 2
- Candidates:
  - A (existing pattern): 沿用 seenCallers/durableCache 兩層 WeakSet/WeakMap —— 已證明 transient scope 會 miss
  - B (minimal): 直接對所有 expr 用 agnostic cache（key 只含 node+j）—— 快但會讓 UDF 內 security 讀錯 param 綁定，違 spec invariant
  - C (preferred): AST 預掃 expr 子樹 **+ 遞迴掃被呼叫的 UDF body**（scout 確認必要），free ident ∉ S0 ∪ local-decls ∪ builtin-namespaces 即 unsafe；其餘維持 per-caller
- Criteria:
  - `f(p) => request.security(sym, tf, p)` 這種 param 依賴必須走 per-caller 路徑
  - 純內建表達式（`close`, `ta.ema(close,20)`）必須命中 agnostic cache
  - gate 掃描包含 UDF body 遞迴（visited set 防環），不只看 expr 表面 ident
  - cache 寫入時再檢 `v.kind`：mutable kind（array/udt/map/line/label/box/table/function/void）不落 cache
- Chosen: C
- Rejected: A 對 transient scope 永遠 miss（現況）；B 違 spec invariant
- Revisit trigger: 預掃發現 gate 誤判率 >0（有 expr 被誤放進 agnostic）→ 改白名單保守版
- Outcome:
- Gate spec（scout GateSpecScout 產出，直接照實作）：
  - `S0 = SERIES_NAMES ∪ store.globals ∪ store.funcs`（spec.scope 自己 Map 裡的名字，mtf.ts:974-984）
  - walk node：ident → bound ∪ S0；member/call root → S0 ∪ KNOWN_BUILTIN_NS（flag `STRICT_NAMESPACES` 預設 OFF：builtin 名被 caller shadow 是病態情境，但會共享第一 caller 的綁定 —— 若要零風險改 ON，代價是 `ta.sma` 全不 cache）
  - call callee-ident ∈ S0-funcs → 遞迴 walk UDF body（bound = params ∪ collectDecls(body)，visited set 防環）
  - 其他（histref base、ternary、arraylit、ifexpr…）遞迴 walk
  - typedecl/import/strategy/indicator 出現在 expr → false（保守）

### D2: `run.allSeries` 每 bar 全掃要怎麼瘦身   (T1 — v2 改 D+ 方案)
- Consumed by: Task 3
- Candidates:
  - A (existing pattern): 維持全掃，靠 `ensureBar` 早退 —— O(allSeries×bars) 呼叫
  - B (minimal): `ensureBar` 加 `lastBar >= bar` 的 inline 快路徑（已是現況），其他不動
  - C (preferred): **membership pruning + batch loop** —— top-level 非 `var` decl slot（每 bar 必寫 → ensureBar 保證 no-op）不加入 allSeries；Set→Array + 手動 index loop 降 Set-iter 開銷。語意嚴格不變（被拿掉的 slot 的 ensureBar 本來就 no-op）。scout 判 SAFE。
  - ~~D (dirtySeries)~~：REJECTED —— 兩個 Critical：unwritten slot 的 rLen() 停滯壞 `x[n]`/`ta.*`/`size()`；LiftedSeries shift 沒寫入可標髒，永遠不會被標到。
- Criteria:
  - 被移除的 slot 必須可證明「每 bar 都被寫入」（top-level、非 var、非 evalBlock 內建立）
  - `var` decl、UDF/branch 內 decl、callHist tracking series、LiftedSeries 全部**保留**在 allSeries
  - series-aliased decl（`x = y` 註冊的是 y 的 series）add 維持無條件
- Chosen: C
- Rejected: A 就是瓶頸；B 已經在做了不夠；D 語意破壞（見上）
- Revisit trigger: 有 top-level slot 被誤判成「每 bar 必寫」而其實可跳過 → 回退 A
- Outcome:
- 實作細節：interpreter.ts slotFor/bindDeclared/callHist 的 `run.allSeries.add` 改為 `if (topLevelBody) skip`；`topLevelBody` flag 只在 `for (const stmt of body) evalExpr` 迴圈內為 true。

### D3: chartHist emit 的 BarSeries.setAt 是否換成 batch append   (T0)
- scout 澄清：emit 用的是 ctx.barIndex 連續寫，carry-forward fill 只在 security call 被條件 gate 跳 bar 時才補 —— 一般情境 O(1)，不是熱點。降 T0，profile 顯示佔比 >15% 再升。

## Task 1: 可重現的效能基準（profiler + 數字）

**Blocked by:** None — can start immediately

**Files:**
- Create: `scratch/perf-probe.mjs`
- Modify: `src/pine/mtf.ts`（加一行 `export const __mtfStats` —— evalAt 是模組私有函式，外部 patch 不到；這是計數必要的最小生產碼改動）
- Test: `src/pine/__tests__/perf_bench.test.ts`

**Interfaces:**
- Consumes: `runScript`/`prepareSecurity`/`prefetchSecurity` from `src/pine/engine.ts`、`src/pine/mtf.ts`
- Produces: `__mtfStats = { evals: 0, hits: 0 }`（evalAt miss/hit 計數）+ `scratch/perf-baseline.json`

**Assumptions:** scout 確認 evalAt/evalHook 是 private 無法 monkey-patch；BarSeries.prototype.setAt/ensureBar 可 patch（須在 import mtf 之後）。evalAt 計數用兩條路：(a) 合成腳本用 UDF side-channel（`__probe()` 遞增 + 委派真實 expr，同 mtf.test.ts:273 的 count() 模式）；(b) 任意腳本用 `__mtfStats`。

**Done when:**
- `node scratch/perf-probe.mjs` 輸出 { evals, hits, setAtCalls, ensureBarCalls, wallMs }，evals > 0
- `__mtfStats.evals` 包含 warmup replays（那是真實工作量，要算進去）
- `npx vitest run src/pine/__tests__/golden.test.ts` PASS

- [ ] **Step 1: mtf.ts 加計數**（anchor：`const caller = spec.callerScope ?? EMPTY_SCOPE;` 上方的 hit 檢查處）
```ts
export const __mtfStats = { evals: 0, hits: 0 };
// 在 evalAt 內：hit → __mtfStats.hits++；miss 走 compute 路徑 → __mtfStats.evals++
```
- [ ] **Step 2: 寫 perf-probe.mjs**
```js
// 必須先 import builtins/index（註冊 mtf），再 patch BarSeries.prototype
import '../src/pine/builtins/index.ts';
import { BarSeries } from '../src/pine/series.ts';
import { __mtfStats } from '../src/pine/mtf.ts';
const counts = { setAt: 0, ensureBar: 0 };
const o1 = BarSeries.prototype.setAt;
BarSeries.prototype.setAt = function(...a){ counts.setAt++; return o1.apply(this,a); };
const o2 = BarSeries.prototype.ensureBar;
BarSeries.prototype.ensureBar = function(...a){ counts.ensureBar++; return o2.apply(this,a); };
// 合成腳本 2×security + ta.ema；假 bars；跑全部 chart bars
```
- [ ] **Step 3: 跑 baseline**
Run: `node --experimental-strip-types scratch/perf-probe.mjs | tee scratch/perf-baseline.json`
- [ ] **Step 4: 固化成 bench test** —— 同一腳本兩次執行，evals 一致（deterministic 檢查）
- [ ] **Step 5: golden test**
- [ ] **Step 6: Commit**

---

## Task 2: evalAt caller-agnostic 快取（最大獲益點）

**Blocked by:** Task 1（要 baseline 才能證明加速）

**Files:**
- Modify: `src/pine/mtf.ts`（evalAt ~1150-1195、tryEvalSecurity 路由 ~1237-1255、resetTfFrame ~940-955、prepareSecurity ~450-460 spec 初始化）
- Test: `src/pine/__tests__/perf_bench.test.ts`、`src/pine/__tests__/golden.test.ts`、`src/pine/__tests__/mtf.test.ts`（延伸 273 的 cache 測試加 agnostic case）

**Interfaces:**
- Consumes: `spec.nodeCache`、`spec.durableCache`、`spec.seenCallers`、`S0 = SERIES_NAMES ∪ store.globals ∪ store.funcs`
- Produces: `spec.agnosticCache: Map<Node, Map<number,Value>>`、`spec.agnosticSafe: Map<Node, boolean>`、`exprSafeForAgnostic(spec, node): boolean`（含 UDF body 遞迴）

**Assumptions:** KNOWN_BUILTIN_NS flag 預設 OFF（非 strict）：builtin 名（ta/math/syminfo…）被 caller shadow 是病態情境，接受「共享第一 caller 綁定」的殘留風險換取 `ta.sma(close,20)` 可 cache。文件註記。

**Done when:**
- `request.security(sym,tf,ta.ema(close,20))` 第二次同 j eval → agnostic hit，evals 降 ≥50%
- `f(p)=>request.security(sym,tf,p)` 仍走 per-caller（gate 拒絕）
- `g()=>request.security(sym,tf,f())` 且 f body 內有 free ident → gate 拒絕（UDF transit）
- expr 回傳 {kind:'array'} → 不落 cache（mutable guard）
- dynamic tf 切換後 agnosticCache 清空（resetTfFrame 涵蓋），agnosticSafe 保留（AST 分析結果不受 tf 切換影響 —— scout 確認 S0 重建後相同）
- golden.test.ts + mtf.test.ts 全 PASS

- [ ] **Step 1: 失敗測試**（perf_bench 加 agnostic hit 斷言 + UDF-param 誤放斷言 + array-kind 不落 cache 斷言）
- [ ] **Step 2: 紅**
- [ ] **Step 3: 實作**
  - `exprSafeForAgnostic`：walk 全 Node union；ident → bound ∪ S0 ∪ KNOWN_BUILTIN_NS；call callee-ident ∈ funcs → 遞迴 walk body（visited set）；member/call root 同規則；typedecl/import → false
  - spec 初始化加 `agnosticCache: null, agnosticSafe: null`（prepareSecurity spec literal ~455）
  - `tryEvalSecurity`：agnostic 讀寫放在 `spec.callerScope = frame.scope` 之後、`seenCallers` 路由**之前**（anchor：`// nodeCache routing:`）
  - `evalAt`：safe → key = (node, j) in agnosticCache；unsafe → 原 (node, caller, j) 路徑。寫入前 `if (isMutableKind(v)) skip`（array/udt/map/line/label/box/table/polyline/linefill/matrix/function/void 不寫）
  - `resetTfFrame`：加 `spec.agnosticCache?.clear()`（agnosticSafe 不清）
- [ ] **Step 4: 綠 + 量測**
- [ ] **Step 5: Commit**

---

## Task 3: allSeries membership pruning + batch loop（v2 取代 dirtySeries）

**Blocked by:** Task 1（要 baseline）；與 Task 2 無依賴但建議 Task 2 先上

**Files:**
- Modify: `src/pine/interpreter.ts`（allSeries 註冊點 :310/:326/:632/:784/:1037/:1486 + bar 迴圈 :1534）
- Test: `src/pine/__tests__/golden.test.ts`、既有 `x[n]`/carry-forward 測試

**Interfaces:**
- Consumes: `run.allSeries`（Set<BarSeries>，6 個註冊點）
- Produces: `run.ensureList: BarSeries[]`（Array 取代 Set）+ `topLevelBody: boolean` flag（只在 `for (const stmt of body) evalExpr` 迴圈內 true）

**Assumptions:** scout 證明 top-level 非-var decl slot 每 bar 必寫 → ensureBar 保證 no-op → 不註冊語意嚴格不變。必須先驗證：var decl init-once 行為（跳過後續 bar 的 var slot 必須保留註冊）；series-aliased decl（x=y 註冊 y）add 維持無條件。

**Done when:**
- `plot(close[1])`、`x := 1; x[1]` 在 if 分支情境語意不變（既有測試 PASS）
- allSeries.size 縮減（top-level decl 多的腳本應 ≥50%）
- ensureBar 呼叫總數下降（量測）；語意層面全 PASS
- golden.test.ts 全 PASS

- [ ] **Step 1: 失敗測試** —— 斷言 top-level decl slot 不在 allSeries、if 內 decl slot 仍在
- [ ] **Step 2: 紅**
- [ ] **Step 3: 實作** —— `topLevelBody` flag（evalProgram 主迴圈設 true，evalBlock/UDF 內 false）；各註冊點 `if (!topLevelBody || isVarDecl || isAliased) run.ensureList.push(s)`；anchor：`for (const s of run.allSeries) s.ensureBar(bar);` 改 `for (let i = 0; i < run.ensureList.length; i++) run.ensureList[i].ensureBar(bar)`
- [ ] **Step 4: 綠 + 量測**
- [ ] **Step 5: Commit**

## Task 4: TRIS390 驗收（真實腳本）

**Blocked by:** Task 2、Task 3

**Files:**
- Test: `src/pine/__tests__/tris_smoke.test.ts`（新建，或用既有 bench harness）
- 不動產品碼

**Interfaces:**
- Consumes: `src/pine/TRIS390.pine`、perf-probe 的計時介面

**Done when:**
- TRIS390 在 5m 5 年資料上 `runIndicator` wall time 從 baseline（Task 1 測得）下降 ≥5x
- `request.security` 回傳的 MTF 表格不再是全 0（數值正確性順帶驗證）
- 記憶體無爆增（profile heap 檢查）

- [ ] **Step 1: 跑 TRIS baseline**（Task 1 的 probe 換腳本路徑）
- [ ] **Step 2: 跑 Task 2/3 後的 TRIS** → 記錄新時間
- [ ] **Step 3: 寫 smoke test** 斷言 wall time < 門檻（取 baseline/3 保守）
- [ ] **Step 4: Commit**

---

## Review Ledger

（執行時填）
