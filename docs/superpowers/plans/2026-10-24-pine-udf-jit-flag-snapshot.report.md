# 執行報告：UDF-JIT 旗標的 env 只在 RunState 建立時讀（做法 B）

日期：2026-10-24
計畫：`docs/superpowers/plans/2026-10-24-pine-udf-jit-flag-snapshot.md`
狀態：三個檔案已照計畫逐字改動，驗證步驟 2–4 全部通過。

## 1. 三個檔案的 `git diff`

```diff
diff --git a/src/pine/__tests__/debug_flags.test.ts b/src/pine/__tests__/debug_flags.test.ts
index b798a81..31443ce 100644
--- a/src/pine/__tests__/debug_flags.test.ts
+++ b/src/pine/__tests__/debug_flags.test.ts
@@ -7,7 +7,7 @@
 // `true`, non-strict ones accept whatever is truthy.
 
 import { describe, expect, it } from 'vitest';
-import { DEBUG_FLAGS, debugFlag, markStage, recordRunTiming } from '../debugFlags';
+import { DEBUG_FLAGS, debugFlag, debugFlagEnv, debugFlagGlobal, markStage, recordRunTiming } from '../debugFlags';
 import { engineCode, engineSources } from './sourceScan';
 
 const SWITCH_IDS = Object.keys(DEBUG_FLAGS) as (keyof typeof DEBUG_FLAGS)[];
@@ -95,6 +95,19 @@ describe('diagnostic switches', () => {
       if (prevUdf === undefined) delete process.env.PINE_JIT_UDF;
       else process.env.PINE_JIT_UDF = prevUdf;
     }
+    // The env half and the globalThis half are read separately: the hot path
+    // reads globalThis per bar, process.env only once per RunState.
+    const prevJitEnv = process.env.PINE_JIT_UDF;
+    try {
+      process.env.PINE_JIT_UDF = '1';
+      withoutGlobal('__pineJitUdf', () => {
+        expect(debugFlagEnv('jitUdf')).toBe(true);
+        expect(debugFlagGlobal('jitUdf')).toBe(false);
+      });
+    } finally {
+      if (prevJitEnv === undefined) delete process.env.PINE_JIT_UDF;
+      else process.env.PINE_JIT_UDF = prevJitEnv;
+    }
     // The PyneCore spelling is accepted as an alias.
     const prevSeq = process.env.PYNE_AST_SEQUENTIAL;
     try {
diff --git a/src/pine/debugFlags.ts b/src/pine/debugFlags.ts
index 04b3c27..e72dce1 100644
--- a/src/pine/debugFlags.ts
+++ b/src/pine/debugFlags.ts
@@ -69,19 +69,29 @@ export const DEBUG_FLAGS: Record<DebugFlagId, SwitchDef> = {
 
 type GlobalSlot = Record<string, unknown>;
 
-/** Is the switch on? globalThis beats the environment, as it did before. */
-export function debugFlag(id: DebugFlagId): boolean {
+/** The globalThis half of a switch. Per-bar hot paths read this one: a handle
+ *  write takes effect on the next bar and costs about 0.03 µs. */
+export function debugFlagGlobal(id: DebugFlagId): boolean {
+  const def = DEBUG_FLAGS[id];
+  if (def.global === undefined) return false;
+  const g = (globalThis as GlobalSlot)[def.global];
+  return def.strict === true ? g === true : Boolean(g);
+}
+
+/** The environment half of a switch. Read once per RunState (session start):
+ *  process.env costs roughly 20–30 µs per read, too much for every bar. */
+export function debugFlagEnv(id: DebugFlagId): boolean {
   const def = DEBUG_FLAGS[id];
-  if (def.global !== undefined) {
-    const g = (globalThis as GlobalSlot)[def.global];
-    if (def.strict === true ? g === true : Boolean(g)) return true;
-  }
-  if (def.env !== undefined && typeof process !== 'undefined') {
-    for (const [key, on] of def.env) if (process.env?.[key] === on) return true;
-  }
+  if (def.env === undefined || typeof process === 'undefined') return false;
+  for (const [key, on] of def.env) if (process.env?.[key] === on) return true;
   return false;
 }
 
+/** Is the switch on? globalThis beats the environment, as it did before. */
+export function debugFlag(id: DebugFlagId): boolean {
+  return debugFlagGlobal(id) || debugFlagEnv(id);
+}
+
 /** Set the run-phase breadcrumb (no-op cost is one property write). */
 export function markStage(stage: string): void {
   const handle = DEBUG_FLAGS.stage.global;
diff --git a/src/pine/interpreter.ts b/src/pine/interpreter.ts
index 320bd66..d7370ca 100644
--- a/src/pine/interpreter.ts
+++ b/src/pine/interpreter.ts
@@ -53,7 +53,7 @@ import {
   type WhileStmt,
 } from './contracts';
 import { PineRuntimeError, pineErr, wrapPineError } from './errors';
-import { debugFlag, markStage } from './debugFlags';
+import { debugFlag, debugFlagEnv, debugFlagGlobal, markStage } from './debugFlags';
 import { FOR_IN } from './parser';
 import { BarSeries, CellSeries, ForwardingSeries, LitSeries, histGetAt, setActiveSeriesSet, valueAt, type IncSnap } from './series';
 import { Scope, blockFrame, seriesOf, type Frame } from './scope';
@@ -205,6 +205,10 @@ interface RunState {
    *  `compiledEnabled()` already documents for the same class of switch. */
   evalCount: boolean;
   udfJitOn: boolean;
+  /** UDF-JIT env switches, read once when this RunState is born (session start).
+   *  evalOneBar combines them with the per-bar globalThis handles (udfJitNow). */
+  envNoJitUdf: boolean;
+  envJitUdf: boolean;
  /** Call node → selfType → resolved UdtMethodDef (null = none). Registry
   *  resets per runScript, so the cache lives on RunState, not module level. */
  udtMethodCache: WeakMap<Node, Map<string, Map<string, UdtMethodDef | null>>>;
@@ -262,6 +266,8 @@ function runOf(ctx: BuiltinCtx): RunState {
     // child frames); evalOneBar refreshes both once per bar.
     evalCount: debugFlag('evalCount'),
     udfJitOn: udfJitDefault(),
+    envNoJitUdf: debugFlagEnv('noJitUdf'),
+    envJitUdf: debugFlagEnv('jitUdf'),
   };
   Object.defineProperty(ctx, RUN_STATE, { value: r, enumerable: false, writable: false, configurable: false });
   return r;
@@ -2311,6 +2317,13 @@ function udfJitDefault(): boolean {
   return debugFlag('noJitUdf') ? false : debugFlag('jitUdf');
 }
 
+/** Per-bar form of udfJitDefault: globalThis handles now, env snapshot from the
+ *  RunState. NoJit wins over Jit, as in udfJitDefault. */
+function udfJitNow(run: RunState): boolean {
+  if (debugFlagGlobal('noJitUdf') || run.envNoJitUdf) return false;
+  return debugFlagGlobal('jitUdf') || run.envJitUdf;
+}
+
 /** Compile-or-fetch the per-UDF-body JitState. Cached on run.udfJit keyed by
  * the body Node[] (stable parse object). `udfR` (the jitRuntime object) is
  * built once alongside — per-call cost is then just scope swap + js.fn. */
@@ -3027,10 +3040,11 @@ function evalOneBar(s: PineSess, bar: number): 'ok' | 'ret' | PineRuntimeError {
   const { run, ctx } = s;
   if (ctx.barIndex !== bar) s.barCtx.seek(bar);
   // Diagnostic switches, re-probed once per bar instead of once per evalNode /
-  // per UDF call (see RunState.evalCount). A toggle between live-session ticks
-  // still lands on the next bar.
+  // per UDF call (see RunState.evalCount). globalThis handles land on the next
+  // bar; env values are snapshotted when the RunState is born, because
+  // process.env is too slow to read per bar.
   run.evalCount = debugFlag('evalCount');
-  run.udfJitOn = udfJitDefault();
+  run.udfJitOn = udfJitNow(run);
   try {
     // Decl slots created while topLevelBody is set are written every bar —
     // their ensureBar is a no-op, so slotFor keeps them out of ensureList
```

`git status --porcelain` 中 `src/pine/` 只有這三個檔案為 ` M`，其餘為既有未追蹤項目（`.archify/`、`bench/`、`scratch/` 等），未觸碰。

## 2. 驗證步驟 2–4 的 summary 行（逐字）

步驟 2 `npx vitest run src/pine/__tests__/debug_flags.test.ts src/pine/__tests__/internal_names.test.ts src/pine/__tests__/named_args_jit.test.ts src/pine/__tests__/inc-parity.test.ts`：

```
 ✓ src/pine/__tests__/debug_flags.test.ts (4 tests) 374ms
 ✓ src/pine/__tests__/internal_names.test.ts (5 tests) 79ms
 ✓ src/pine/__tests__/inc-parity.test.ts (13 tests) 538ms
 ✓ src/pine/__tests__/named_args_jit.test.ts (4 tests) 59ms

 Test Files  4 passed (4)
      Tests  26 passed (26)
```

步驟 3 `npx vitest run src/pine/__tests__/strategy.test.ts src/pine/__tests__/named_args.test.ts`：

```
 ✓ src/pine/__tests__/named_args.test.ts (13 tests) 97ms
 ✓ src/pine/__tests__/strategy.test.ts (62 tests) 392ms

 Test Files  2 passed (2)
      Tests  75 passed (75)
```

步驟 4 `npx tsc --noEmit`：

```
tsc exit: 0
```

（輸出為空，0 bytes；耗時約 34 秒，未逾時。）

## 3. 新測試的 verbose 行

`npx vitest run src/pine/__tests__/debug_flags.test.ts --reporter=verbose`：

```
 ✓ src/pine/__tests__/debug_flags.test.ts > diagnostic switches > every switch declares a handle or an env var, plus a reason
 ✓ src/pine/__tests__/debug_flags.test.ts > diagnostic switches > is read through this module only
 ✓ src/pine/__tests__/debug_flags.test.ts > diagnostic switches > honours the global handle and the env var, strict flags only for `true`/`1`
 ✓ src/pine/__tests__/debug_flags.test.ts > diagnostic switches > sinks write the registered handles

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

「原始碼掃描」測試 `is read through this module only` 通過，未被放寬或刪除。

## 4. 偏離計畫的地方

1. **沒有新增獨立的 `it()` 名稱。** 計畫 3b 指定的程式碼區塊是一段裸語句（`const prevJitEnv = ...` 開頭），不是 `it(...)` 包裹，且指定插入位置在既有 `it('honours the global handle and the env var, ...')` 的函式體內、`// The PyneCore spelling is accepted as an alias.` 之前。我照計畫逐字插入，因此新斷言跑在既有的 4 個 `it()` 中的第 3 個之內，verbose 輸出沒有新的測試名稱。這與計畫「驗證」第 5 點「逐一確認：新測試名稱出現在 verbose 輸出」不相容——我選擇遵守「程式碼區塊逐字照抄」，不自行改寫成 `it()`。若要獨立名稱，需另行授權修改計畫。
2. 無其他偏離。三個檔案的每一處改動與計畫的程式碼區塊逐字一致（含註解文字、縮排、`debugFlag` 的 JSDoc 保留、`GlobalSlot` 未重複宣告）。

## 5. 不確定或失敗的部分

- 無失敗項目。
- 不確定（未驗證）：env 快照只在 `runOf()` 建立 RunState 時讀取，因此 session 執行中修改 `process.env.PINE_JIT_UDF` 不會在後續 bar 生效（計畫刻意如此）；我沒有另寫測試去釘住「mid-session 改 env 不生效」這個新行為，因為計畫未要求且禁止改動計畫外的程式碼/斷言。
- 未做效能驗證（計畫明定不在本次範圍）。
- 過程中在 `scratch/_udf-jit-flag.diff` 產生暫存 diff 檔，已於寫完報告後刪除。
