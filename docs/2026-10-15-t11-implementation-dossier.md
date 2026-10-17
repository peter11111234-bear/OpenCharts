# T11 實作地圖 dossier — per-caller 快取鍵改 callsite 身分（唯讀審計）

> 探子輸出。**未改任何檔案**；只讀 `docs/2026-10-15-t11-key-attribution.md`、`docs/2026-10-15-r5-fix-plan.md`、
> `src/pine/mtf.ts`、`src/pine/interpreter.ts`、`src/pine/__tests__/*`。
> 本檔落 `local://t11-implementation-dossier.md`（依 Contract，探子不得寫工作樹）。

## 0. 版本指紋與方法限制

- **md5 無法取得**：本機探子只有 `read`/`grep`/`glob`/`write`（無 shell 裝置，`xd://` 208 個裝置中無 bash/exec），
  故**無法跑 `md5sum`**。改以「行錨點逐點比對」當指紋：
  | 錨點 | 母代理給的 md5 樹（T11 doc） | 我實測（現行樹） | 同？ |
  |---|---|---|---|
  | `durableCache` 宣告 | `:197` | `:197` | ✅ |
  | `seenCallers` 宣告 | `:198` | `:198` | ✅ |
  | `nodeCache` 宣告 | `:202` | `:202` | ✅ |
  | spec 初始化 | `:548` | `:548` | ✅ |
  | `EMPTY_SCOPE` | `:1344` | `:1344` | ✅ |
  | `evalAt` 取鍵 | `:1828` | `:1828` | ✅ |
  | 路由 | `:2056-2062` | `:2056-2062` | ✅ |
  | `tryEvalSecurity` 設 `callerKey` | `:2040` | `:2040` | ✅ |
  | `SpecSnap/snap/restore` | `:2243/:2291/:2330` | `:2243/:2291/:2330` | ✅ |
  | ltf/lookahead reset | `:2370` | `:2370` | ✅ |
  ⇒ **mtf.ts 相關區域自 T11 doc 寫成後未變**（檔案 2411 行）。
- 因為樹「正被另一個代理改動」，落 patch 前 **請重跑本檔 §7 的 `grep` 指紋**確認行號仍成立。

---

## 1. 逐站點 before / after（可直接貼）

### S1 — `SecuritySpec` 欄位（`:192-198`）

BEFORE（現行原文）
```ts
  callerScope: Scope | null;      // scope that invoked security this bar
  /** Callsite-composed caller identity (chartHist/lastChartBar key): the same
   *  security node reached through different UDF callsites keeps separate
   *  chart-domain histories. Rebound per call alongside callerScope. */
  callerKey: object | null;
  durableCache: Map<Node, WeakMap<Scope, Map<number, Value>>> | null; // eval cache for the stable root scope
  seenCallers: WeakSet<Scope>;        // caller scopes seen before — recurring ⇒ durable cache
```
AFTER
```ts
  callerScope: Scope | null;      // scope that invoked security this bar (PivotScope target only — NOT a cache key)
  /** Callsite-composed caller identity: the same security node reached through
   *  different UDF callsites keeps separate chart-domain histories (T11) AND
   *  separate eval-cache entries. Rebound per call alongside callerScope. */
  callerKey: object | null;
```
（`durableCache`、`seenCallers` 兩行整行刪除）

### S2 — `nodeCache` 宣告（`:202`）

BEFORE
```ts
  nodeCache: Map<Node, WeakMap<Scope, Map<number, Value>>>; // node → caller scope → tfBarIndex → value
```
AFTER
```ts
  nodeCache: Map<Node, Map<object, Map<number, Value>>>; // node → callerKey (callsite identity) → tfBarIndex → value
```

### S3 — spec 初始化（`:548`）

BEFORE
```ts
      bars: null, scope: null, pivot: null, callerScope: null, callerKey: null, durableCache: null, seenCallers: new WeakSet(), ctx: null,
```
AFTER
```ts
      bars: null, scope: null, pivot: null, callerScope: null, callerKey: null, ctx: null,
```
（`:550` `nodeCache: new Map(),` **不動**）

### S4 — `resetTfFrame`（`:1111-1115`）

BEFORE
```ts
  spec.nodeCache.clear();
  spec.agnosticCache?.clear();        // agnosticSafe survives: gate verdicts are AST-level
  spec.invCache = null;               // invVerdicts survives: verdicts are AST-level too
  spec.durableCache = null;
  spec.seenCallers = new WeakSet();
```
AFTER
```ts
  spec.nodeCache.clear();
  spec.agnosticCache?.clear();        // agnosticSafe survives: gate verdicts are AST-level
  spec.invCache = null;               // invVerdicts survives: verdicts are AST-level too
```

### S5 — `EMPTY_SCOPE` 刪除（`:1343-1344`）**（`noUnusedLocals: true` ⇒ 必須刪，否則 tsc TS6133）**

BEFORE
```ts
/** Cache-key sentinel for evals that ran with no caller scope (shouldn't happen post-fix). */
const EMPTY_SCOPE = new Scope();
```
AFTER：整段刪除。
- 全樹 grep：`EMPTY_SCOPE` 僅 `:1344`（宣告）＋ `:1828`（使用）⇒ 刪 `:1828` 用法後即無用。
- `Scope`（`import { … Scope, Series } from './contracts'`，`:32`）**仍被使用**（`:192` 型別、`:852 class PivotScope extends Scope`）⇒ import **不可刪**。

### S6 — `evalAt` 取鍵（`:1828`）

BEFORE
```ts
  const caller = spec.callerScope ?? EMPTY_SCOPE;
```
AFTER
```ts
  // T11: 寫鍵＝讀鍵＝callsite 身分（非呼叫者 Scope 物件）。tryEvalSecurity :2040
  // 在本次 invocation 的任何 evalAt 之前就已設好；`?? spec.node` 只是保險。
  const caller: object = spec.callerKey ?? spec.node;
```
（`:1828` 上的註解在 `:1343` 已刪；`caller` 型別 `object`，可用於 `Map<object,…>.get/set`）

### S7 — **R1/R2/R3 三處讀取與 W1 寫入（`:1858` / `:1885` / `:1899-1901` / `:1904-1912`）：完全不改**
同一變數 `caller` ⇒ 語意自動變成 callsite 鍵。`spec.nodeCache.get(node)?.get(caller)?.get(j)` 在新型別下逐一字元不變、可編譯。

### S8 — 路由整段刪除（`:2042-2062`）

BEFORE（現行原文，含註解）
```ts
  // Caller-agnostic caches live outside nodeCache so the seenCallers routing
  // swap below can't orphan them. They lazy-init at their consumers
  // (evalAt / exprSafeForAgnostic) — one owner each (CR1).
  // nodeCache routing: evalAt caches per (expr node, caller scope, tf bar).
  // The caller scope is the right key — an ephemeral UDF call scope binds
  // different params per invocation, so two callers must never share an
  // entry. But that also means an ephemeral key can NEVER hit on a later
  // bar (a fresh Scope is allocated per call), so retaining entries under it
  // only grows a dead WeakMap. Route evals through a per-invocation
  // transient map until the caller proves itself stable: a Scope object that
  // shows up a second time (the root scope, held by frame0 across bars, or a
  // long-lived harness scope) graduates to the durable cross-bar cache. The
  // first sighting keeps the transient map — entries under a caller may only
  // be reused by that same caller anyway.
  if (spec.seenCallers.has(frame.scope)) {
    if (!spec.durableCache) spec.durableCache = new Map();
    spec.nodeCache = spec.durableCache;
  } else {
    spec.seenCallers.add(frame.scope);
    spec.nodeCache = new Map();
  }
```
AFTER
```ts
  // T11: nodeCache is keyed by spec.callerKey (callsite identity, built one
  // line above) — stable across chart bars for UDF callers too, so the old
  // seenCallers/durableCache map-swap is gone. Caller-agnostic caches still
  // live outside nodeCache; they lazy-init at their consumers
  // (evalAt / exprSafeForAgnostic) — one owner each (CR1).
```
（`:2056-2062` 程式碼 + 對應註解整段刪除。**`:2039-2040` 兩行 `callerScope`/`callerKey` 賦值保留**。）

### S9 — `SpecSnap` 欄位（`:2243`）／`snapSpec`（`:2291`）／`restoreSpec`（`:2330`）
三處各刪一行 `durableCache`：
```ts
  durableCache: SecuritySpec['durableCache'];   // :2243 刪
    durableCache: spec.durableCache,            // :2291 刪
  spec.durableCache = ck.durableCache;          // :2330 刪
```
（`nodeCache` 三處對應列 `:2242/:2290/:2329` **不動**。留著 → TS2339「Property 'durableCache' does not exist」。）

### S10 — ltf / lookahead 逐 bar reset（`:2368-2375`）
BEFORE（`:2369-2370` 兩行）
```ts
    spec.nodeCache = new Map();
    spec.durableCache = null;
```
AFTER
```ts
    spec.nodeCache = new Map();
```
（`:2370` 刪。**語意變化須知**：舊版這裡只丟 transient map、durable 由路由還原；新版等同把整個 spec 的
per-callsite 條目丟掉一次 ⇒ 只多算一次，安全，但 `:2368-2375` 的註解應補一句「T11: nodeCache 唯一，reset 即全丟」。）

---

## 2. 型別連鎖清單（一次改對的關鍵）

| # | 項目 | 結論 |
|---|---|---|
| T1 | `SecuritySpec.nodeCache` | `Map<Node, WeakMap<Scope, Map<number, Value>>>` → `Map<Node, Map<object, Map<number, Value>>>`（+ 註解）。整個改動唯一必要的型別變更。 |
| T2 | `cwMap`（`:242`）簽章 | **不需改、也不該改。** 現行已是 `m: { delete(k: unknown): boolean }`。`Map<object,X>.delete(key: object)` 與現行 `WeakMap<Scope,X>.delete(key: Scope)` 一樣，對 `delete(k: unknown)` 都是 **method 雙變性（bivariance）** 相容（`strictFunctionTypes` 只作用在函式型別屬性，不作用在 method）。⇒ **T11 doc §2.3「cwMap 參數型別必須跟著放寬」是誤判**（沒有更寬的形式可放寬）。實作時**不要動** `:242`，否則白跑 parity。 |
| T3 | `cwMap` 呼叫點 | `:1908` 傳 `spec.nodeCache`（Map）、`:1909` 傳內層 `m`（改後是 Map，改前是 WeakMap）——兩者都有 `delete` ⇒ 不變。 |
| T4 | `evalAt` 的 `caller` 變數 | `spec.callerKey ?? spec.node` ⇒ 推得 `object`（`object \| Call`）。可作 `Map<object,…>` 的鍵。**不需新鍵函式**（`callsiteKey` 已 import，`:34`）。 |
| T5 | `durableCache` / `seenCallers` 欄位 | 全數 9+5 處刪除（見 §1 S1/S3/S4/S8/S9/S10）。少刪任一行 → tsc 立即紅（`durableCache` 屬 SpecSnap 時是 TS2339；欄位殘留時是「未使用」或語意殘留）。 |
| T6 | `EMPTY_SCOPE` | `noUnusedLocals: true`（`tsconfig.json:15`）⇒ 刪 `:1828` 用法後 **必須刪 `:1343-1344`**，否則 tsc TS6133。 |
| T7 | `Scope` import | 仍需要（`:192` 型別、`:852 extends`）⇒ 不刪。 |
| T8 | `SpecSnap.durableCache` 型別引用 | 刪欄位時必須同步刪 `snapSpec`/`restoreSpec` 三處，否則 `SecuritySpec['durableCache']` 解析失敗（TS2339）。 |

---

## 3. 賦值時機 vs 讀取時機（任務第 4 點，已逐一驗證）

- 賦值：`spec.callerKey = callsiteKey(ctx, spec.node)` — `mtf.ts:2040`，在 `tryEvalSecurity` 內、`ensureTfFrame` 之後。
- 讀取：`mtf.ts:1828`（`evalAt`）、`:1097`（`alignToChart` 的 SecSeries 鍵）、`:1879`（`forCaller`）、`:2155`（`lastEmit` key）。
- **全部 `evalAt` 呼叫點都在 `:2040` 之後**：
  | 呼叫點 | 位置 | 前置條件 |
  |---|---|---|
  | `:2113`, `:2120` | ltf warm-up/`scalarAt` | 同函式，晚於 `:2040` |
  | `:2172` | 非 ltf warm-up replay | 同上 |
  | `:2177-2178` | 主回傳 | 同上 |
  | `:875` | `TfGlobalSeries.at` | 只能經 `spec.scope` 的影子 series 讀到，而那發生在 tf 上下文求值（`computeAt`）內 ⇒ 也在 `:2040` 之後 |
  ⇒ **同一 callsite 一定先設好**：`spec.callerKey` 不可能在「該 spec 的第一次 evalAt」時還是 `null`。`?? spec.node` 只是防禦性 fallback（實際不可達）。
- 反面確認：`tryEvalSecurity` 是唯一入口（`interpreter.ts:1371-1374`、`:2544-2548`，`evalCallDispatch` 內、`evalCall` 的 `pushSite` 之後）；除了測試 harness 直接呼叫外，無其他路徑能對某 spec 觸發 `evalAt`。
- **測試 harness 的關鍵副作用**：`__tests__/mtf.test.ts:319` 的 `runTransient` 與 `:98` 的 `runSecurity` **直接呼叫 `tryEvalSecurity`**，其 ctx 由 `mkCtx` 每 bar 新建 ⇒ `runOf(ctx)` 新 RunState、`siteCtx.length === 0` ⇒ `siteKey` 回 **`node` 本身**（`interpreter.ts:477`）⇒ `callerKey === spec.node`，**跨 bar 穩定**。改用 callsite 鍵後，這些 harness 的 per-caller 快取會從「每 bar 清空」變成「整個 run 持久」。這正是 §4 測試翻盤的根因。

---

## 4. ⚠️ 最大風險：既有測試 expectation 會翻（T11 doc 完全沒提）

T11 doc §3 只列了「誤命中」風險，**漏了「這些測試把舊行為寫死了」**。驗收要求 `954 passed | 1 skipped`，
因此下列斷言**必須同步更新**，否則改完必紅：

| 檔案:行 | 現行斷言 | 為何會翻 | 建議 |
|---|---|---|---|
| `src/pine/__tests__/perf_bench.test.ts:161` | `expect(d.evals).toBeGreaterThan(5000)`（PARAM_SRC：`f(p)=>security(...,p)` + 3 個 UDF callsite） | 3 個 callsite 各得穩定 leaf ⇒ 條目跨 bar 存活 ⇒ evals 大幅下降 | 改成量測後的值（或 `toBeLessThan` 的反向斷言 + 保留 `:166-172` 的正確性斷言） |
| `src/pine/__tests__/mtf.test.ts:365` | `evals - e0 >= 12`（transient scope，verdict 1） | 同上；harness 的 key 退化成 `spec.node` ⇒ 跨 bar 命中 ⇒ 約 2–3 | 改量測值 |
| `mtf.test.ts:383` / `:429` / `:468` | 同上 `>= 12` | 同上 | 同上 |
| `mtf.test.ts:624` / `:675` | `new Set(values.slice(4).map(valOf)).size >= 4`（counter UDF） | 每 (node, j) 只算一次 ⇒ distinct ≈ 不同 tf bar 數（≈2–3） | 改門檻或改成「同 tf bar 的 chart bar 值相同」 |
| `mtf_invariance.test.ts:263-268` (N5a) | `s.slice(4).every(v===1)` ＋ `evals - s0.evals === 20`（exact） | **語意變化**：mutable array（`array.new(0)`）改為 per-(callsite, j) 共享 ⇒ 變成 N5b 形狀（push 累積 1,2,3,4） | 見 §4.1：這是**行為**改變，不只是數字 |
| 註解需同步 | `mtf.test.ts:341-343,364,382-383`、`perf_bench.test.ts:77-79,143-144,158-160`、`mtf_invariance.test.ts:263-264` | 都在描述 seenCallers 清空行為 | 一併改寫（不影響編譯，但別留假敘述） |

**不受影響**（已確認）：`mtf.test.ts:349-351`（agnostic 路徑）、`:398/:487/:552/:570`（上界，只會更低）、
`perf_bench.test.ts:145-146,184-190`（UDF_SRC agnostic／ARR_SRC 為 top-level 已是 durable）、
`mtf_invariance.test.ts:274-291`（N5b top-level durable，形狀不變）。
`probe_highvol.test.ts:46` 只 `console.log`，無斷言。

### 4.1 N5a 是真正的行為改變（不是單純數字）
- 現行：UDF 內 `request.security(..., array.new(0))` 每次 invocation 拿到**全新的 array**（呼叫者 Scope 每 bar 新配 ⇒ 快取讀不到）。
- 改後：array 是 **mutable kind**，而 verdict 1 的寫入路徑（`:1904-1912`）**沒有** mutable 閘門（agnostic 路徑 `:1888` 才有）⇒ 同一 (callsite, tf bar) 回**同一個 array 物件**，`array.push` 會累積 —— 與 top-level 的 N5b 行為一致（N5b `:279-285` 明文期待 1,2,3,4）。
- 這在 Pine 語意上**可辯**（每次 UDF invocation 本該新物件），但 N5b 已把「共享」確立為本引擎的既有契約 ⇒ T11 讓 UDF 與 top-level 對齊是**一致的**。
- 若母代理要「不改 mutable 語意」的保守版：在 verdict 1 寫入前加 `v.kind in MUTABLE_KINDS` 閘門 ⇒ 但這會**同時**打破 N5b（top-level array 也不再共享）。要同時保 N5a＋N5b，就必須保留「scope 身分」這條軌（mutable 走舊 `seenCallers/durableCache`，非 mutable 走 callsite 鍵）——即**兩套鍵空間**，改動量遠大於 T11 doc 的草稿。**建議採草稿＋更新 N5a 期待值**（TRIS390 的 expr 是純量/序列，不受 mutable 軌影響）。

---

## 5. 風險清單

1. **同 callsite ＋ 同 chart bar 二次呼叫**（T11 doc §3.1）：`siteKey` 只取 site 堆疊**頂端**的葉節點；同一語法位置在同一 bar 被呼叫兩次 → 共用鍵。緩解：`invocations > bars × callsites` 是訊號；必要時把 `ctx.barIndex` 併入鍵。
2. **`siteKey` 在 site 堆疊為空時回 `node`**（`interpreter.ts:477`）：只會 miss 或在 harness 下退化成 per-node 快取（安全，但正是 §4 的翻盤來源）。
3. **mutable payload 跨 invocation 共享**（§4.1）：行為改變。
4. **`:2369` 的全清**：ltf/lookahead 逐 bar rollback 現在丟掉整個 spec 的 callsite 條目（舊版只丟 transient）。安全但效能略降；若要保留，須改成只刪 post-checkpoint 的 (leaf,j)。
5. **記憶體**：條目不再因「每次 invocation 換 map」自動失效 ⇒ 生命週期 = spec 生命週期 × tf bar 數；`resetTfFrame`（`:1111`）與 `:2369` 是唯二清理點。leaves 由 `run.siteTrie` 長期持有 ⇒ 用 `Map` 不會漏（T11 doc 已述）。
6. **與 T6② 同檔**：`docs/2026-10-15-r5-fix-plan.md:89` 明定 `mtf.ts` 序列（P4 T11 → P5 → P6）⇒ 套用前確認 `mtf.ts` 沒有別的未提交改動（本檔 §7 指紋）。

---

## 6. 驗收命令（母代理在有 tsc/vitest 回饋時跑；探子未執行）

```bash
cd /c/Users/bear9/OpenCharts && npx tsc --noEmit                       # 0 error（EMPTY_SCOPE/durableCache 殘留會在此爆）
cd /c/Users/bear9/OpenCharts && npx vitest run src/pine                 # 954 passed | 1 skipped（§4 的期待值需先更新）
cd /c/Users/bear9/OpenCharts && npx tsx scripts/perf/pine-bench.mjs --script src/pine/TRIS390.pine \
  --bars 100 --repeat 1 --warmup 0 --instrument --out scratch/perf/t11-after.json --md
#   ① perCaller = hits - agHits - invHits（顯式計數器）> 0 且較 t11-check.json 上升
#   ② counters.mtf.evals 下降
cd /c/Users/bear9/OpenCharts && npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 5   # parity 6/6, 0 mismatch
cd /c/Users/bear9/OpenCharts && npx tsx scratch/perf/s1-inc-probe.mjs --script scratch/perf/t7-tris-probe.pine --bars 500 --ticks 1
```
不需 golden/digest 重跑的四支凍結 digest（**須維持不變**）：`ze7byn`(K55 app) / `kb0glc`(TRIS390) / `p4gddl`(final) / `1580h2`(MACD701_v72)。

---

## 7. 落地前後的靜態指紋（輕量、可重跑）

改動前：
```bash
cd /c/Users/bear9/OpenCharts && grep -n "durableCache\|seenCallers\|EMPTY_SCOPE" src/pine/mtf.ts
# 期望：:197 :198 :548 :1114 :1115 :1344 :1828 :2042(註解) :2056 :2057 :2058 :2060 :2243 :2291 :2330 :2370
```
改動後：
```bash
cd /c/Users/bear9/OpenCharts && grep -n "durableCache\|seenCallers\|EMPTY_SCOPE" src/pine/mtf.ts
# 期望：0 命中（只剩 __tests__ 的註解，不影響編譯）
cd /c/Users/bear9/OpenCharts && grep -n "nodeCache\|callerKey" src/pine/mtf.ts   # 人工核對 S2/S7/S8 全部站點
```

## 8. 明確「不要動」清單
- `cwMap`（`:242-246`）及其所有呼叫點。
- verdict 2 / verdict 3 兩條路徑（`:1849-1894`）的邏輯與閘門。
- `:2039` `spec.callerScope = frame.scope;`（`PivotScope` 仍靠它解析呼叫者繫結，`:852-857`）。
- `:1097` / `:1879` / `:2155` / `:2162-2167` / `:2184-2204`（chartHist / lastEmit / lastChartBar 已用 `callerKey`，改後與 nodeCache 鍵一致）。
- `:2242/:2290/:2329`（`nodeCache` 在 snap/restore 的三處）。
