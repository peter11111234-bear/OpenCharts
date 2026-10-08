# Pine Interpreter MTF 效能加速計畫（方法 2：interpreter + cache，不編譯）

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

## Decision Points

### D1: evalAt 的 caller-agnostic 快取要怎麼 gate   (T1)
- Consumed by: Task 2
- Candidates:
  - A (existing pattern): 沿用 seenCallers/durableCache 兩層 WeakSet/WeakMap —— 已證明 transient scope 會 miss
  - B (minimal): 直接對所有 expr 用 agnostic cache（key 只含 node+j）—— 快但會讓 UDF 內 security 讀錯 param 綁定，違 spec invariant
  - C (preferred): AST 預掃 expr 子樹，若不含任何「會在 caller scope 查找」的 ident/param，才允許進 agnostic cache；其餘維持 per-caller
- Criteria:
  - `f(p) => request.security(sym, tf, p)` 這種 param 依賴必須走 per-caller 路徑
  - 純內建表達式（`close`, `ta.ema(close,20)`）必須命中 agnostic cache
  - 預掃本身不得遞迴超過 expr 子樹一次
- Chosen: C
- Rejected: A 對 transient scope 永遠 miss（現況）；B 違 spec invariant
- Revisit trigger: 預掃發現 gate 誤判率 >0（有 expr 被誤放進 agnostic）→ 改白名單保守版
- Outcome:

### D2: `run.allSeries` 每 bar 全掃要怎麼瘦身   (T1)
- Consumed by: Task 3
- Candidates:
  - A (existing pattern): 維持全掃，靠 `ensureBar` 早退 —— O(allSeries×bars) 呼叫，TRIS 是百萬級
  - B (minimal): `ensureBar` 加 `lastBar >= bar` 的 inline 快路徑（已是現況），其他不動
  - C (preferred): interpreter 維護 `dirtySeries: Set` —— setAt/set 標髒，bar 末只 ensure 髒的；髒集合每 bar 清空
- Criteria:
  - 未寫入的 series 的 `x[n]` 語意不變（carry-forward 仍生效）
  - `s[1]` 在 skipped-statement 情境仍讀到舊值
  - Set 操作不得比原全掃更貴（bars×allSeries > bars×dirty 時才划算）
- Chosen: C
- Rejected: A 就是瓶頸；B 已經在做了不夠
- Revisit trigger: dirty 追蹤讓 `x[n]` 讀到 na（漏標髒）→ 回退 A
- Outcome:

### D3: chartHist emit 的 BarSeries.setAt 是否換成 batch append   (T0 → 若 Task 3 評估後動到則升 T1)
- 現況 `emit()` 每 chart bar `s.setAt(barIndex, v)` —— setAt 有 carry-forward loop；稀疏 chart↔tf 映射時每次都補中間 bar。若 profile 顯示它佔大頭，改 `pushBulk`。

## Task 1: 可重現的效能基準（profiler + 數字）

**Blocked by:** None — can start immediately

**Files:**
- Create: `scratch/perf-probe.mjs`
- Test: `src/pine/__tests__/perf_bench.test.ts`

**Interfaces:**
- Consumes: `runScript`/`prepareSecurity`/`prefetchSecurity` from `src/pine/engine.ts`、`src/pine/mtf.ts`
- Produces: `scratch/perf-baseline.json` — { script, bars, evalAtCalls, setAtCalls, ensureBarCalls, wallMs } 讓後續 task 比對

**Assumptions:** 用合成的 MTF 腳本（2×security + ta.ema）當基準，不直接跑 TRIS 全文（太大，先把機器打點準）；TRIS 作最後驗收。

**Done when:**
- `node scratch/perf-probe.mjs` 輸出 baseline JSON，三個計數器都有非零值
- 同一腳本跑兩次，evalAtCalls 一致（確認 deterministic）
- `npx vitest run src/pine/__tests__/golden.test.ts` PASS（未動產品碼）

- [ ] **Step 1: 寫 perf-probe.mjs**
```js
// scratch/perf-probe.mjs — 注入計數鉤子到 BarSeries/evalAt，跑合成 MTF 腳本
import { parse } from '../src/pine/parser.ts';
import { prepareSecurity, prefetchSecurity } from '../src/pine/mtf.ts';
import { BarSeries } from '../src/pine/series.ts';

const counts = { evalAt: 0, setAt: 0, ensureBar: 0 };
// wrap — 生產環境不能改，這是探針
const _eval = globalThis.__evalAt_wrap ?? null;
// 直接用 Performance API 計時 + monkey-patch 計數
const origSetAt = BarSeries.prototype.setAt;
BarSeries.prototype.setAt = function(...a){ counts.setAt++; return origSetAt.apply(this,a); };
const origEnsure = BarSeries.prototype.ensureBar;
BarSeries.prototype.ensureBar = function(...a){ counts.ensureBar++; return origEnsure.apply(this,a); };
// ... 產生 N 根假 bar、準備 spec、跑一次 tryEvalSecurity across all bars
// console.log(JSON.stringify(counts));
```
- [ ] **Step 2: 跑 baseline**
Run: `node --experimental-strip-types scratch/perf-probe.mjs | tee scratch/perf-baseline.json`
Expected: 看到 evalAt/setAt/ensureBar 數量級（預期 setAt ≥ bars×10、ensureBar ≥ allSeries×bars）
- [ ] **Step 3: 把基準固化成 test**
`perf_bench.test.ts`：同一腳本兩次執行，斷言 evalAtCalls 相等（regression 檢查 —— 之後的 cache 不能改變結果，只能減少重複計算）
- [ ] **Step 4: golden test**
Run: `npx vitest run src/pine/__tests__/golden.test.ts` → 全 PASS
- [ ] **Step 5: Commit**
`git add scratch/perf-probe.mjs src/pine/__tests__/perf_bench.test.ts && git commit -m "perf: MTF eval baseline probe + bench test"`

---

## Task 2: evalAt caller-agnostic 快取（最大獲益點）

**Blocked by:** Task 1（要 baseline 才能證明加速）

**Files:**
- Modify: `src/pine/mtf.ts:1150-1190`（evalAt）、`src/pine/mtf.ts:1240-1260`（cache 路由）
- Test: `src/pine/__tests__/perf_bench.test.ts`（加斷言）、`src/pine/__tests__/golden.test.ts`（語意回歸）

**Interfaces:**
- Consumes: `spec.nodeCache`（Map<Node, WeakMap<Scope, Map<number,Value>>>）、`spec.seenCallers`（WeakSet）
- Produces: `spec.agnosticCache: Map<Node, Map<number,Value>> | null` + `exprSafeForAgnostic(node: Node): boolean`

**Assumptions:** UDF 定義在 prepareSecurity 已掃進 spec.scope；expr 內的 ident 若解析自 spec.scope 就是 caller-independent。

**Done when:**
- 合成腳本 `request.security(sym,tf,ta.ema(close,20))` 第二次 evalAt 命中 agnostic cache，evalAtCalls 降 ≥50%
- 腳本 `f(p)=>request.security(sym,tf,p)` 仍走 per-caller 路徑（agnostic 不誤放）
- golden.test.ts 全 PASS
- 重跑 perf-probe：evalAtCalls 明顯下降，setAt/ensureBar 不變（cache 不改語意只省重算）

- [ ] **Step 1: 失敗測試先寫**
```ts
// perf_bench.test.ts 新增：同一 node 在 UDF 外評估兩次 → 第二次 cache hit
it('agnostic expr caches across bars', () => {
  const src = `//@version=6\nindicator("x")\nplot(request.security(syminfo.tickerid,"60",ta.ema(close,20)))`;
  // run 2 passes; count evalAt invocations via probe hook
  expect(counts2).toBeLessThan(counts1);
});
```
- [ ] **Step 2: 確認紅**
Run: `npx vitest run src/pine/__tests__/perf_bench.test.ts` → FAIL（現況沒有 agnostic）
- [ ] **Step 3: 實作**
在 `evalAt` 前加 `exprSafeForAgnostic(spec, node)`：遞迴掃 node 子樹，若發現 `ident` 其 `name` 不在 spec.scope 內建/全域集合中（即可能解析到 caller 綁定），回 false。安全則 cache key 改用固定 `AGNOSTIC_SCOPE` sentinel。
原碼（`evalAt` 開頭，anchor `const caller = spec.callerScope ?? EMPTY_SCOPE;`）：
```ts
const caller = spec.callerScope ?? EMPTY_SCOPE;
let m = spec.nodeCache.get(node);
```
改為：
```ts
const safe = spec.agnosticSafe?.get(node) ?? computeAgnosticSafe(spec, node);
const caller = safe ? AGNOSTIC_SCOPE : (spec.callerScope ?? EMPTY_SCOPE);
const cacheRoot = safe ? (spec.agnosticCache ??= new Map()) : spec.nodeCache;
let m = cacheRoot.get(node);
```
- [ ] **Step 4: 綠**
Run: `npx vitest run src/pine/__tests__/perf_bench.test.ts src/pine/__tests__/golden.test.ts` → 全 PASS
- [ ] **Step 5: 量測**
`node scratch/perf-probe.mjs` — evalAtCalls 應降 ≥50%，寫入 `perf-baseline.json` 更新欄位
- [ ] **Step 6: Commit**

---

## Task 3: per-bar ensureBar 全掃 → dirtySeries

**Blocked by:** Task 1（同樣要 baseline）；可與 Task 2 平行，但建議 Task 2 先上（獨立量測）

**Files:**
- Modify: `src/pine/interpreter.ts:1534`（`for (const s of run.allSeries) s.ensureBar(bar)`）、`src/pine/interpreter.ts`（RunResult 組裝的 allSeries 收集處）
- Modify: `src/pine/series.ts`（`BarSeries.setAt`/`set`/`ensureBar` 加 dirty 標記）
- Test: `src/pine/__tests__/golden.test.ts`、系列 carry-forward 測試（`x[1]`/`x[2]` 語意）

**Interfaces:**
- Consumes: `run.allSeries`
- Produces: `run.dirtySeries: Set<Series>`，bar 末只跑 `for (const s of run.dirtySeries) s.ensureBar(bar)`；`dirtySeries.clear()` 每 bar 重置

**Assumptions:** `LiftedSeries.ensureBar` 的 `shift +=` 路徑也要列入 dirty 追蹤（不標髒會跳過物化）。

**Done when:**
- `plot(close[1])` 系列在 skipped-statement 情境仍讀到前值（既有測試 PASS）
- perf-probe：ensureBarCalls 從 `allSeries×bars` 降到 `dirtySeries×bars`（TRIS 場景應 ≥10x 差異）
- golden.test.ts 全 PASS

- [ ] **Step 1: 失敗測試** —— dirtySeries 存在且 bar 末只跑髒的
- [ ] **Step 2: 紅**
- [ ] **Step 3: 實作** —— `setAt`/`set` 呼叫時 `run.dirtySeries.add(this)`；`ensureBar` 呼叫後 `delete`。anchor：`for (const s of run.allSeries) s.ensureBar(bar);`
- [ ] **Step 4: 綠 + 量測**
- [ ] **Step 5: Commit**

---

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
