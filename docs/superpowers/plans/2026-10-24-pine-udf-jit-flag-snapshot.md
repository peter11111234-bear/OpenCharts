# 執行計畫：UDF-JIT 旗標的 env 只在 RunState 建立時讀（做法 B）

日期：2026-10-24 · 依據：`2026-10-24-pine-f2-builtin-call-overhead.md`（第 2.5–2.8 節）
狀態：**已核准做法 B**，可派工。執行者必須逐字照抄，不得自行改寫設計。

## 目標

每根 bar 的 `process.env` 讀取從 2 次降為 0 次。`globalThis` 的旗標仍然逐 bar 生效；環境變數只在 `RunState` 建立時（session 開始）讀一次。

## 不變式（Spec invariant）

- `debugFlag(id)` 的結果與改動前完全相同：`globalThis` 命中（依 `strict`）或 env 命中即為 true。
- UDF-JIT 的決策順序不變：`noJitUdf` 優先於 `jitUdf`。
- `evalCount` 不改（它沒有 env 來源，每 bar 讀 `globalThis` 即可）。

## 改動 1：`src/pine/debugFlags.ts`

把 `debugFlag` 函式（約第 72–83 行，從 `/** Is the switch on? ...` 開始到函式結束的 `}`）整段換成以下內容：

```ts
/** The globalThis half of a switch. Per-bar hot paths read this one: a handle
 *  write takes effect on the next bar and costs about 0.03 µs. */
export function debugFlagGlobal(id: DebugFlagId): boolean {
  const def = DEBUG_FLAGS[id];
  if (def.global === undefined) return false;
  const g = (globalThis as GlobalSlot)[def.global];
  return def.strict === true ? g === true : Boolean(g);
}

/** The environment half of a switch. Read once per RunState (session start):
 *  process.env costs roughly 20–30 µs per read, too much for every bar. */
export function debugFlagEnv(id: DebugFlagId): boolean {
  const def = DEBUG_FLAGS[id];
  if (def.env === undefined || typeof process === 'undefined') return false;
  for (const [key, on] of def.env) if (process.env?.[key] === on) return true;
  return false;
}

/** Is the switch on? globalThis beats the environment, as it did before. */
export function debugFlag(id: DebugFlagId): boolean {
  return debugFlagGlobal(id) || debugFlagEnv(id);
}
```

注意：`debugFlag` 的 JSDoc 那一行保留（它本來就在函式上方）。`GlobalSlot` 型別已存在於同檔，不要重複宣告。

## 改動 2：`src/pine/interpreter.ts`

2a. 第 56 行的 import 改為：

```ts
import { debugFlag, debugFlagEnv, debugFlagGlobal, markStage } from './debugFlags';
```

2b. `RunState` 介面：找到下面這一行（約第 207 行）：

```ts
  udfJitOn: boolean;
```

在它的下一行加入（保留前後的縮排）：

```ts
  /** UDF-JIT env switches, read once when this RunState is born (session start).
   *  evalOneBar combines them with the per-bar globalThis handles (udfJitNow). */
  envNoJitUdf: boolean;
  envJitUdf: boolean;
```

2c. RunState 建立處（約第 264 行），找到：

```ts
    udfJitOn: udfJitDefault(),
```

在它的下一行加入：

```ts
    envNoJitUdf: debugFlagEnv('noJitUdf'),
    envJitUdf: debugFlagEnv('jitUdf'),
```

2d. 在 `udfJitDefault` 函式（約第 2308–2312 行）的 `}` 之後，新增：

```ts
/** Per-bar form of udfJitDefault: globalThis handles now, env snapshot from the
 *  RunState. NoJit wins over Jit, as in udfJitDefault. */
function udfJitNow(run: RunState): boolean {
  if (debugFlagGlobal('noJitUdf') || run.envNoJitUdf) return false;
  return debugFlagGlobal('jitUdf') || run.envJitUdf;
}
```

2e. `evalOneBar`（約第 3030–3033 行）。找到這段：

```ts
  // Diagnostic switches, re-probed once per bar instead of once per evalNode /
  // per UDF call (see RunState.evalCount). A toggle between live-session ticks
  // still lands on the next bar.
  run.evalCount = debugFlag('evalCount');
  run.udfJitOn = udfJitDefault();
```

改成：

```ts
  // Diagnostic switches, re-probed once per bar instead of once per evalNode /
  // per UDF call (see RunState.evalCount). globalThis handles land on the next
  // bar; env values are snapshotted when the RunState is born, because
  // process.env is too slow to read per bar.
  run.evalCount = debugFlag('evalCount');
  run.udfJitOn = udfJitNow(run);
```

## 改動 3：`src/pine/__tests__/debug_flags.test.ts`

3a. 第 10 行的 import 改為：

```ts
import { DEBUG_FLAGS, debugFlag, debugFlagEnv, debugFlagGlobal, markStage, recordRunTiming } from '../debugFlags';
```

3b. 在 `// The PyneCore spelling is accepted as an alias.` 這一行**之前**，插入新的測試（與前面的 `it(...)` 同層，放在同一個 `describe` 內）：

```ts
    // The env half and the globalThis half are read separately: the hot path
    // reads globalThis per bar, process.env only once per RunState.
    const prevJitEnv = process.env.PINE_JIT_UDF;
    try {
      process.env.PINE_JIT_UDF = '1';
      withoutGlobal('__pineJitUdf', () => {
        expect(debugFlagEnv('jitUdf')).toBe(true);
        expect(debugFlagGlobal('jitUdf')).toBe(false);
      });
    } finally {
      if (prevJitEnv === undefined) delete process.env.PINE_JIT_UDF;
      else process.env.PINE_JIT_UDF = prevJitEnv;
    }
```

若 `withoutGlobal` 的呼叫方式與檔內現有用法不同，依現有用法調整，但不得改變斷言。

## 驗證（依序，全部要過）

1. `cd C:\Users\bear9\OpenCharts`
2. `npx vitest run src/pine/__tests__/debug_flags.test.ts src/pine/__tests__/internal_names.test.ts src/pine/__tests__/named_args_jit.test.ts src/pine/__tests__/inc-parity.test.ts`
3. `npx vitest run src/pine/__tests__/strategy.test.ts src/pine/__tests__/named_args.test.ts`
4. `npx tsc --noEmit`（若超過 5 分鐘，記錄「逾時」，不要重試整個 tsc 迴圈）
5. 逐一確認：新測試名稱出現在 verbose 輸出並通過。

若 `debug_flags.test.ts` 的「原始碼掃描」測試失敗：**不要放寬或刪除它**。把失敗訊息逐字寫進報告並停止。

## 禁止事項（Nevers）

- 不 commit、不 `git add -p`、不 stash、不 reset、不 checkout。
- 不跑全套 `npx vitest run`（2026-10-20 事故）。
- 不碰 `vite.config.ts`、`src/services/guard/*`、`VelaPage.tsx`、`src/pine/graphify-out/`。
- 不改 `VIEWPORT_NAMES`、`alertcondition`、`capabilities.streaming`。
- 不改上面沒有列出的任何程式碼；不為了讓測試過而改斷言。
- 不新增 `__pine*` 的全域名稱（internalNames 會攔）。

## 報告

寫到 `C:\Users\bear9\OpenCharts\docs\superpowers\plans\2026-10-24-pine-udf-jit-flag-snapshot.report.md`，內容：

- 三個檔案的 `git diff`（只列這三個檔案）
- 驗證步驟 2–4 的 summary 行逐字貼上
- 新測試的 verbose 行
- 任何偏離本計畫的地方（逐條說明，照實寫）
- 不確定或失敗的部分

## 完成後的 Opus 驗收

1. 用 `git diff` 確認只有三個檔案改動，且與本計畫的程式碼一致。
2. 重跑步驟 2 的測試。
3. 不在本計畫內做效能驗證；效能收益另外量。
