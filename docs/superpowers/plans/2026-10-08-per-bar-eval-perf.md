# Per-Bar Eval Loop Performance Implementation Plan

> **日期：** 2026-10-08
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut 見高K4.55 from ~6s/500bars and 高量1.46 from ~3.2s/500bars to <4s / <2s by eliminating per-bar dispatch and state-key overhead, without touching the interpreter's semantics.

**Architecture:** Three converging optimizations, each independently measurable:
- **Slice A** — `builtins/time.ts` memoizes `partsOf` output per `(ms, tz)` so `hour/minute/dayofmonth/...` builtins each resolve in O(1) instead of N `Intl.formatToParts` calls per bar.
- **Slice B** — `builtins/input.ts` memoizes `recordAndOverride` per callsite: schema construction + dedup runs once, per-bar work drops to a single `ctx.inputs[title]` lookup.
- **Slice C** — `interpreter.ts` + `builtins/ta.ts` + `builtins/util.ts`: kill string keys (`stateFor` nested-Map), literal args skip `callHist` BarSeries, dispatch via `WeakMap<Call,…>` pre-resolution, `siteKey` drops the `join('|')`, `bindArgs` positional fast-path, dead-code cleanup (`keyCache`, `SERIES_IDENTITY`).

**Tech Stack:** TypeScript, vitest, node `--cpu-prof` + `inspector` for profiling.

**Spec:** `docs/superpowers/plans/2026-10-07-pine-mtf-performance.md` §2.4/§3 (10-07 roadmap), updated by 2026-10-08 scout reports.

**Spec invariant:** No behavior change — every observable `RunResult` field (`plots`, `warnings`, `drawings`, `inputSchemas`, `errors`, `orderEvents`) must be bit-identical before vs after each task on the same input.

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same
verify failing after 2+ distinct fix attempts. Single red test = normal TDD
loop, not a blocker.

**Plan-specific Nevers:**
- NEVER cache `ctx.inputs[title]` — the override must be re-read every bar (frozen at run start today, but the re-read is one hash lookup and stays correct if Vela ever injects mid-run).
- NEVER return a cached `Value` object from `recordAndOverride`'s memo — return a fresh `Value` each bar (consumers may mutate).
- NEVER mutate `RunState`'s public field types (`siteStack` stays `string[]`, `callsiteSeq` stays `number`); internals-only refactor.
- NEVER delete `keyCache`/`SERIES_IDENTITY` in the same commit as a behavior change — separate cleanup commit so the behavior diff stays reviewable.
- NEVER change `stateFor`/`vsOf`/`vseries`/`vstate` signatures — all ~15 call sites in ta.ts keep their existing call shape; only the `key` argument construction moves from string to object/number/array.

## Scout Risk Findings (folded into tasks below — read before editing)

| Task | Verdict | Binding conditions |
|---|---|---|
| Task 3 stateFor | SAFE-WITH-CONDITIONS | (a) `vsOf` key parts keep the `'const'`/`'series'` branch tag as its own part — never collapse arity; (b) first-level part namespace NEVER uses `'strategy\|*'` (strategy.ts:151-153 + strategyEquity.ts:17-18 own `strategy\|orders/cfg/simCache/ddCache`); (c) `undefined`/`NaN` leaf parts passed as-is (Map SameValueZero handles both) |
| Task 4 evalArg | SAFE-WITH-CONDITIONS | (a) fast-path ONLY on `invokeBuiltin`'s arg loop + `obj.method` builtin loop (interpreter.ts:1058,1111) — `bindCallArgs` (UDF/UDT-method binding, L1171-1200) MUST keep callHist wrap: `f(20)` + `x[1]` inside UDF reads the arg's tracked BarSeries (callUdfValue L1216-1232 binds `a.v` via CowSeries); skipping wrap turns `x[1]` from 20 into na — semantic regression; (b) parser node types are `'num'/'str'/'bool'/'color'/'na'` (parser.ts:932-947) — NO `'int'/'float'` node type; (c) `'str'/'color'/'na'` already bypass wrap at L1156 — real saving is `'num'/'bool'` only |
| Task 5 dispatch | SAFE-WITH-CONDITIONS | (a) miss-sentinel is permanent per Call node — safe only because all `registerBuiltin` calls run at import-time (registry.ts:16-18); code comment must state this precondition; (b) ordering preserved: `tryEvalSecurity` → UDT `.new` → member-chain WeakMap → `obj.method` kindBuiltin → `na()` — WeakMap insert stays AFTER the UDT-new early return; (c) siteKey trie leaf separates callsite-string keys from nodeId-number keys (callsite is always `'#N'`, never collides); (d) bonus: `drainBindWarnings()` allocates a fresh array per builtin call — add `if (bindWarnQ.length === 0) return EMPTY` fast-path |

## Global Constraints

- Every task must produce a measurable delta via `scratch/_prof_high.mjs` (or its inspector variant) on 見高K4.55 + 高量1.46.
- All existing tests must pass: `npx vitest run src/pine/__tests__/` (excluding the two slow probe tests only if they exceed CI timeout).
- No public API changes: `runScript`, `evalNode`, `evalExpr`, `evalBlock`, `invokeUdf`, `registerBuiltin`, `stateFor`/`vsOf`/`vseries`/`vstate` signatures unchanged.
- Every commit message starts with `perf:` or `chore:`.

## Decision Points

### D1: `partsOf` memoization shape   (T1)
- Consumed by: Task 1 (Slice A)
- Candidates:
  - A (existing pattern): extend existing `partCache` (per-tz `DateTimeFormat`) — but the expensive call is `formatToParts` itself, not the formatter construction. Pattern doesn't reach the hot call.
  - B (minimal): cache only `part(ms,tz,field)` per (ms,tz,field) — saves each field separately; `tzOffsetMs` calls `part` 6× so still saves.
  - C (preferred): cache `formatToParts(ms, tz)` → `DateParts` record (`{year,month,day,hour,minute,second,weekday}`) per `(ms,tz)` — one Intl call per new ms, all 7 fields cheap reads thereafter.
- Criteria:
  - Must reduce `Intl.DateTimeFormat.formatToParts` calls per bar from ~8-12 (6 fields × N uses + tzOffsetMs's 6) to ≤1-2.
  - Cache memory bounded (bounded by distinct `ms` × `tz` pairs = O(bars × 1), no unbounded accumulation across runs).
  - `tz` variations must not collide (Asia/Taipei vs UTC produce different parts).
- Chosen: C
- Rejected: A (doesn't reach `formatToParts`), B (still walks the Map N times per call chain when fields are the same ms — C collapses to one lookup).
- Revisit trigger: `DateParts` record layout ever needs fields beyond the 7 calendar fields (DST flag, nanosecond, fractional second) → switch to `formatToParts` memo.
- Outcome: (fill during execution)

### D2: `recordAndOverride` memo cache shape   (T1)
- Consumed by: Task 2 (Slice B)
- Candidates:
  - A (existing pattern): `stateFor`-style `Map<string, T>` keyed on callsite — string key would just re-introduce the cost we're killing.
  - B (minimal): memoize only the schema object (`{id, title, schemaFields}`); leave `bindArgs`+`rawDefval` running per bar — saves dedup scan but not arg-bind cost.
  - C (preferred): memoize the full resolution `{id, title, resolvedValue, schemaPushed}` per callsite; per-bar work = `ctx.inputs[title] ?? ctx.inputs[id]` then pick override-or-cached-value. Cache stored in `WeakMap<RtCtx, Map<string, …>>`.
- Criteria:
  - Must remove `inputSchemas.some()` per-bar scan AND the `options.v.map(rawDefval)` per-bar cost.
  - `ctx.inputs` override lookup still runs per bar (never cached).
  - Per-`callsite` cache identity must match `ctx.callsite` lifetime (one RunState per run → `WeakMap<RtCtx>` is correct; `WeakMap` prevents GC leaks across runs).
- Chosen: C
- Rejected: A (string keys), B (doesn't remove the per-bar `bindArgs`+`rawDefval`+`options.map` overhead).
- Revisit trigger: a real-world script is found passing a `defval` that changes per bar (e.g. `input.int(x[1], …)`) — the memo would freeze the wrong defval. Then cache `{id, title, schema}` only and re-coerce defval per bar.
- Outcome: (fill during execution)

### D3: `siteKey`/`stateFor` nested-Map key shape   (T1)
- Consumed by: Task 3 (Slice C-1), Task 5 (Slice C-3)
- Candidates:
  - A (existing pattern): keep `Map<string,unknown>` with string keys — proven broken (string concat is the cost).
  - B (minimal): replace `join('|')` with array-join once per `siteKey` call → still allocates; doesn't help `stateFor`/`vsOf`/`vstate` (15+ call sites).
  - C (preferred): nested-Map chain — `Map<part1, Map<part2, Map<part3, T>>>`, parts are strings or numbers (never objects → avoids WeakMap-of-WeakMap complexity at the leaf).
- Criteria:
  - Zero string allocation in the hot path (no `join`, no template literal).
  - Same key shape usable by `siteKey` (parts = `callsite` strings) AND `stateFor`/`vsOf`/`vstate` (parts = `[fnName, callsite, seriesId|const-sig]`).
  - Memory stays bounded — one leaf per unique (callsite, series) pair, same as today's string keys.
- Chosen: C
- Rejected: A (the bug we're fixing), B (still allocates).
- Revisit trigger: a siteKey/seriesId pair becomes ambiguous across runs — number collision impossible since `nodeSeq`/`seriesId`/`callsiteSeq` are monotonic per RunState; not expected to fire.
- Outcome: (fill during execution)

### D4: `evalCallDispatch` pre-resolution cache   (T1)
- Consumed by: Task 5 (Slice C-3)
- Candidates:
  - A (existing pattern): none — BUILTINS is `Map<string, BuiltinFn>`; pre-resolution via `WeakMap<Call, BuiltinFn>` is new.
  - B (minimal): cache `parts.join('.')` per Call node → still a Map<string> lookup per call.
  - C (preferred): `WeakMap<Call, {headName, fn}>` — compute `parts` + `BUILTINS.get` once per Call node; per-bar cost = `scope.lookup(head.name)` (must re-check — a rebind mid-run is possible) + `WeakMap.get(node)`. Non-builtin paths skip.
- Criteria:
  - Must NOT cache through `scope.lookup` result — re-binding `head.name` mid-run must take effect.
  - Must cover the `callee.obj` non-ident case (member-of-member like `chart.point.new`) — only cache the *resolved* fn, not the AST walk.
  - Fallback to full path on cache miss or `scope.lookup(head.name)!==undefined`.
- Chosen: C
- Rejected: A (none exists), B (still hits Map every call).
- Revisit trigger: `run.scriptId` or `run.runSeq` makes Call node identity unstable across UDF callsites (each callsite would re-resolve once — still better than per-bar).
- Outcome: (fill during execution)

### D5: `evalArg` literal fast-path — builtin-only   (T1)
- Consumed by: Task 4 (Slice C-2)
- Candidates:
  - A (existing pattern): none — `evalArg` wraps every int/float/bool arg in `callHist` BarSeries.
  - B (minimal): apply fast-path inside `evalArg` unconditionally — UNSAFE per scout: `bindCallArgs` (UDF/UDT method binding) shares `evalArg`, and `callUdfValue` (interpreter.ts:1216-1232) reads the wrapped BarSeries to seed `x[1]` inside `f(20)`; unconditional would regress `x[1]` from `20` to `na`.
  - C (preferred): `evalArg(a, frame, litFastPath=false)` — builtin arg loops (`invokeBuiltin` L1111, `obj.method` L1058) pass `true` and skip wrap for node types `'num'/'bool'` (parser.ts:932-947 — no `'int'/'float'` type); `bindCallArgs` keeps `false` so UDF params keep history.
- Criteria:
  - `f(20)` + `x[1]` inside the UDF body must return the same value as HEAD (verified by regression test — pin the exact number, don't guess).
  - `ta.sma(close, 20)`'s `20` must not walk `siteKey`+`callHist`+`setAt` per bar.
  - `nz(x, 0)`'s `0` must still reach `nz` as `{kind:'int'}` or stable series — `nz` impl uses `unwrapped`/`cur()` so both shapes work.
- Chosen: C
- Rejected: A (doesn't exist), B (verified UNSAFE — breaks UDF param history).
- Revisit trigger: a builtin is found doing `arg.v.get(n)` on a value that used to be a `callHist` BarSeries — grep `.v.get(` in builtins/ before landing; if hit, keep wrap for that builtin's arg positions.
- Outcome: (fill during execution)

## Review Ledger

(starts empty; execution appends here)

---

### Task 1: Slice A — `partsOf` `(ms,tz)` memoization

**Blocked by:** None — can start immediately.

**Files:**
- Modify: `src/pine/builtins/time.ts` (partsOf L42-53, calFn L131-138, CalSeries L152-162, tzOffsetMs L63-67, weekId L86-91, calKey L93-103)
- Test: `src/pine/__tests__/time.test.ts` (add if missing) or a new `src/pine/__tests__/time-parts-memo.test.ts`

**Interfaces:**
- Consumes: none
- Produces: unchanged API (`part`, `partsOf`, `tzOf`, `tzOffsetMs`, `isTfBoundary` all same signatures)

**Assumptions:**
- `ctx.syminfo['timezone']` is set once per run (Vela sets `'Asia/Taipei'`).
- `partsOf` callers always pass the same `tz` within a run unless `input.timeframe`/dynamic tz is used (rare, still correct — memo key includes tz).

**Done when:**
- A counter inside `partsOf` (`__partsOfCalls`) shows ≤ `distinctMs` calls per run (previously ~`distinctMs × 8`).
- `npx vitest run src/pine/__tests__/time*` → all PASS.
- `scratch/_prof_high.mjs` self-time on `time.ts` cur/at/tzOf drops from ~14.5% to <5%.
- 見高K4.55 wall time drops by ≥0.8s.

- [ ] **Step 1: Add a counting test (red first)**

```ts
// src/pine/__tests__/time-parts-memo.test.ts
import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import { __partsOfCalls } from '../builtins/time';
import { mkBars } from './golden'; // adjust if mkBars is local — grep for it

describe('partsOf memoization', () => {
  it('hour(x)+minute(x)+year(x) on same ms hits Intl once', async () => {
    const src = 'indicator("t"); plot(hour); plot(minute); plot(year)';
    const bars = mkBars(20); // mkBars(n, startMs=0, stepMs=60_000) — no callback (golden.ts:17)
    const before = __partsOfCalls;
    await runScript(parse(src), {
      bars,
      ticker: { symbol: 'X', timeframe: '1' },
      fetchSeries: async () => ({ kind: 'array', v: [] }),
    });
    const after = __partsOfCalls;
    // Each bar evaluates 3 fields — but Intl.formatToParts must run ≤1 per distinct ms.
    // 20 bars → ≤20 formatToParts calls (vs ~60 before).
    expect(after - before).toBeLessThanOrEqual(bars.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pine/__tests__/time-parts-memo.test.ts -t "memoization"`
Expected: FAIL — `__partsOfCalls` is not exported / count is ~3× bars.

- [ ] **Step 3: Implement the memo**

Original code at `src/pine/builtins/time.ts` (anchor: `// Intl parts cache per timezone`):

```ts
// Intl parts cache per timezone
const partCache = new Map<string, Intl.DateTimeFormat>();
export const partsOf = (ms: number, tz: string): Intl.DateTimeFormatPart[] => {
  let f = partCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
    }
    partCache.set(tz, f);
  }
  return f.formatToParts(new Date(ms));
};
const part = (ms: number, tz: string, t: Intl.DateTimeFormatPartTypes): number => {
  const p = partsOf(ms, tz).find((x) => x.type === t)?.value;
  if (t === 'weekday') return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf((p ?? '').toLowerCase()) + 1;
  const n = Number(p);
  return t === 'hour' && n === 24 ? 0 : n;
};
```

Replacement:

```ts
// Intl parts cache per timezone
const partCache = new Map<string, Intl.DateTimeFormat>();
const partsFmt = (tz: string): Intl.DateTimeFormat => {
  let f = partCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
    }
    partCache.set(tz, f);
  }
  return f;
};

// (ms, tz) → calendar fields; each entry holds all 7 fields read by part().
// One formatToParts per unique (ms,tz) — was 6+ per field-access per bar.
interface DateParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  weekday: number; // 1=Sun..7=Sat (TV dayofweek); 0 = unknown
}
// Test instrumentation: counts actual Intl.formatToParts calls.
export let __partsOfCalls = 0;
// Bounded: per (tz, ms) — tz count is small (≤ ~3/run), ms count ≤ bars.
const partsMemo = new Map<string, Map<number, DateParts>>();
// numPart preserves the old semantics: a missing part yields NaN
// (old code did Number(undefined) → NaN; Number('') would be 0 — WRONG).
const numPart = (v: string | undefined): number => (v === undefined ? NaN : Number(v));
const partsRec = (ms: number, tz: string): DateParts => {
  let perMs = partsMemo.get(tz);
  if (!perMs) { perMs = new Map(); partsMemo.set(tz, perMs); }
  let r = perMs.get(ms);
  if (r !== undefined) return r;
  __partsOfCalls++;
  const parts = partsFmt(tz).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((x) => x.type === t)?.value;
  const wdStr = (get('weekday') ?? '').toLowerCase();
  const hourRaw = numPart(get('hour'));
  r = {
    year: numPart(get('year')),
    month: numPart(get('month')),
    day: numPart(get('day')),
    hour: hourRaw === 24 ? 0 : hourRaw, // preserves existing 24→0 quirk
    minute: numPart(get('minute')),
    second: numPart(get('second')),
    weekday: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(wdStr) + 1,
  };
  perMs.set(ms, r);
  return r;
};

export const partsOf = (ms: number, tz: string): Intl.DateTimeFormatPart[] => {
  // Backward-compat shim for external callers (isTfBoundary/tests) that want
  // the raw parts array. Not on the hot path — hot callers use partsRec.
  const r = partsRec(ms, tz);
  return [
    { type: 'year', value: String(r.year) },
    { type: 'month', value: String(r.month).padStart(2, '0') },
    { type: 'day', value: String(r.day).padStart(2, '0') },
    { type: 'hour', value: String(r.hour).padStart(2, '0') },
    { type: 'minute', value: String(r.minute).padStart(2, '0') },
    { type: 'second', value: String(r.second).padStart(2, '0') },
    { type: 'weekday', value: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][r.weekday - 1]! },
  ] as Intl.DateTimeFormatPart[];
};
const part = (ms: number, tz: string, t: Intl.DateTimeFormatPartTypes): number => {
  const r = partsRec(ms, tz);
  switch (t) {
    case 'year': return r.year;
    case 'month': return r.month;
    case 'day': return r.day;
    case 'hour': return r.hour;
    case 'minute': return r.minute;
    case 'second': return r.second;
    case 'weekday': return r.weekday;
    default: return NaN;
  }
};
```

- [ ] **Step 4: Run test**

Run: `npx vitest run src/pine/__tests__/time-parts-memo.test.ts src/pine/__tests__/time*` Expected: all PASS.

- [ ] **Step 5: Measure**

Run: `node --cpu-prof --cpu-prof-name=sliceA.cpuprofile --cpu-prof-dir=scratch --import tsx scratch/_prof_high.mjs` (or use the inspector variant if subprocess masks samples) → confirm `time.ts` region <5% self-time and 見高K4.55 ≥0.8s faster.

- [ ] **Step 6: Commit**

```bash
git add src/pine/builtins/time.ts src/pine/__tests__/time-parts-memo.test.ts
git commit -m "perf: memoize Intl partsOf per (ms,tz) — drop per-bar formatToParts fan-out"
```

---

### Task 2: Slice B — `recordAndOverride` per-callsite memo

**Blocked by:** None — parallel-safe with Task 1 (different files).

**Files:**
- Modify: `src/pine/builtins/input.ts` (recordAndOverride L74-106, scalarInput L108-126 + all `registerBuiltin('input', '…')` callsites)
- Test: extend `src/pine/__tests__/input.test.ts` (if exists; grep for `input.int(` tests) or new `src/pine/__tests__/input-memo.test.ts`

**Interfaces:**
- Consumes: none
- Produces: unchanged exported surface (builtins are registered, not exported)

**Assumptions:**
- `ctx.callsite` is set to a stable `#N` string per `Call` node before the builtin runs (verified: interpreter.ts:979-982).
- `ctx.inputs` is frozen per run (verified: engine.ts:283-285 snapshots `runInputs` at run start).

**Done when:**
- A counter `__inputSchemaBuilds` (test-only export) equals `#distinct input.* callsites` per run (was ~`#callsites × #bars`).
- All existing input tests pass; a new test confirms `input.int` returns the override when `ctx.inputs[id]` is set on the 2nd bar (dynamic override still honored because we re-read per bar).
- `recordAndOverride` self-time in profile drops to noise (<0.5%).

- [ ] **Step 1: Write the failing test**

```ts
// src/pine/__tests__/input-memo.test.ts
import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import { __inputSchemaBuilds } from '../builtins/input';
import { mkBars } from './golden';

describe('input per-callsite memo', () => {
  it('schema build runs once per callsite, not per bar', async () => {
    const src = 'indicator("t"); a = input.int(1, "a"); b = input.float(2.0, "b"); plot(a+b)';
    const before = __inputSchemaBuilds;
    await runScript(parse(src), {
      bars: mkBars(50),
      ticker: { symbol: 'X', timeframe: '1' },
      fetchSeries: async () => ({ kind: 'array', v: [] }),
    });
    const after = __inputSchemaBuilds;
    expect(after - before).toBe(2); // 2 callsites, 1 build each
  });

  it('mid-run override still lands (re-read per bar)', async () => {
    // Drive runScript twice: first run plants the schema; second run changes ctx.inputs
    // before the run starts. Memoized schema must not shadow the new override.
    const src = 'indicator("t"); a = input.int(1, "a"); plot(a)';
    const r1 = await runScript(parse(src), {
      bars: mkBars(5),
      ticker: { symbol: 'X', timeframe: '1' },
      fetchSeries: async () => ({ kind: 'array', v: [] }),
      inputValues: { a: 7 },
    });
    // plot of `a` should be 7 (override), not 1.
    const plot = r1.plots.get('plot_0') ?? r1.plots.values().next().value;
    expect(plot?.v?.cur?.()?.v ?? plot?.cur?.()).toBe(7); // adjust to actual shape
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/pine/__tests__/input-memo.test.ts`
Expected: FAIL — `__inputSchemaBuilds` doesn't exist / count ≠ 2.

- [ ] **Step 3: Implement the memo**

Original code (anchor: `/** Record schema (dedup by id) and look up a user override. */` at input.ts:74):

```ts
function recordAndOverride(
  ctx: RtCtx,
  bound: Map<string, Value>,
  type: string,
  defval: unknown,
): { id: string; title: string; override: unknown } {
  const title = strArg(bound, 'title', 'input');
  const id = slugify(title, `input_${ctx.callsite ?? ctx.miscSeq ?? 0}`);
  const schema: InputSchemaLite = { id, name: title, type, defval };
  // … minval/maxval/step/options/group/inline/tooltip extractors …
  ctx.inputSchemas ??= [];
  if (!ctx.inputSchemas.some(s => s.id === schema.id)) ctx.inputSchemas.push(schema);
  const override = ctx.inputs?.[title] ?? ctx.inputs?.[id];
  return { id, title, override };
}
```

Replacement:

```ts
// Per-callsite memo of {id,title,schema,resolver}. schema.push is one-shot per
// run (ctx.inputSchemas is []-reset at run start). `resolver` is the function
// that derives the coerced return value from (defval, override) — bound once
// per callsite, called per bar with the fresh override.
//
// Cache lifetime: WeakMap<RtCtx> so each run's memo is dropped with the ctx.
// Cache key: ctx.callsite — already stable `#N` per Call node, and already
// composes with siteStack inside UDFs.
interface InputMemo {
  id: string;
  title: string;
  schemaPushed: boolean;
  // rawDefval-captured value — constant per run (input-qualified).
  resolved: Value;
}
let __inputSchemaBuilds = 0;
export { __inputSchemaBuilds }; // test instrumentation only

const INPUT_MEMO = new WeakMap<RtCtx, Map<string, InputMemo>>();
const inputMemoOf = (ctx: RtCtx): Map<string, InputMemo> => {
  let m = INPUT_MEMO.get(ctx);
  if (!m) { m = new Map(); INPUT_MEMO.set(ctx, m); }
  return m;
};

function recordAndOverride(
  ctx: RtCtx,
  bound: Map<string, Value>,
  type: string,
  rawDefval: unknown,
  coerce: (defval: unknown, override: unknown) => Value,
): { id: string; title: string; value: Value } {
  const site = ctx.callsite ?? `g${ctx.miscSeq ?? 0}`;
  const memo = inputMemoOf(ctx).get(site);
  if (memo !== undefined) {
    // Re-read the override per bar — one dict lookup, correct if ctx.inputs
    // is ever injected mid-run.
    const override = ctx.inputs?.[memo.title] ?? ctx.inputs?.[memo.id];
    return { id: memo.id, title: memo.title, value: override !== undefined ? coerce(memo.resolved, override) : memo.resolved };
  }
  __inputSchemaBuilds++;
  const title = strArg(bound, 'title', 'input');
  const id = slugify(title, `input_${site}`);
  const schema: InputSchemaLite = { id, name: title, type, defval: rawDefval };
  const minval = bound.get('minval');
  if (minval !== undefined && minval.kind !== 'na') schema.minval = asNum(minval);
  const maxval = bound.get('maxval');
  if (maxval !== undefined && maxval.kind !== 'na') schema.maxval = asNum(maxval);
  const step = bound.get('step');
  if (step !== undefined && step.kind !== 'na') schema.step = asNum(step);
  const options = bound.get('options');
  if (options?.kind === 'array') schema.options = options.v.map(rawDefval);
  const group = bound.get('group');
  if (group !== undefined && group.kind !== 'na') schema.group = asStr(group);
  const inline = bound.get('inline');
  if (inline !== undefined && inline.kind !== 'na') schema.inline = asStr(inline);
  const tooltip = bound.get('tooltip');
  if (tooltip !== undefined && tooltip.kind !== 'na') schema.tooltip = asStr(tooltip);
  ctx.inputSchemas ??= [];
  if (!ctx.inputSchemas.some(s => s.id === schema.id)) ctx.inputSchemas.push(schema);
  const resolved = coerce(rawDefval, ctx.inputs?.[title] ?? ctx.inputs?.[id]);
  const entry: InputMemo = { id, title, schemaPushed: true, resolved };
  inputMemoOf(ctx).set(site, entry);
  return { id, title, value: resolved };
}
```

Then `scalarInput` becomes:

```ts
function scalarInput(
  kind: 'int' | 'float' | 'bool' | 'string' | 'color',
  schemaType: string,
  dflt: Value,
): (ctx: RtCtx, args: Value[], named: Record<string, Value>) => Value {
  return (ctx, args, named) => {
    const bound = bindArgs(args, named, INPUT_ORDER);
    const raw = rawDefval(unwrapped(bound.get('defval') ?? dflt));
    const { value } = recordAndOverride(ctx, bound, schemaType, raw, (dv, ov) => {
      const o = ov;
      if (o !== undefined && !(kind === 'color' && o === '') && !(kind === 'string' && o === '')) {
        return coerceOverride(o, kind);
      }
      return coerceOverride(dv, kind);
    });
    return value;
  };
}
```

(`coerce` is the small lambda above; the memoized `resolved` is the Value you'd have returned with no override — when an override exists we re-coerce per bar, so semantics is unchanged.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/pine/__tests__/input* src/pine/__tests__/engine*` Expected: all PASS.

- [ ] **Step 5: Measure**

Run: `scratch/_prof_high.mjs` → `recordAndOverride`/`anon input.ts` combined self-time <0.5%.

- [ ] **Step 6: Commit**

```bash
git add src/pine/builtins/input.ts src/pine/__tests__/input-memo.test.ts
git commit -m "perf: memoize input.* schema + resolved value per callsite (weakmap on ctx)"
```

---

### Task 3: Slice C-1 — `stateFor`/`vsOf`/`vseries`/`vstate` nested-Map keys

**Blocked by:** Task 1 (Task 2 orthogonal but deferring keeps diffs small).

**Files:**
- Modify: `src/pine/builtins/ta.ts` (stateMap L100-109, stateFor L111-116, vsOf L119-140, vseries L143-157, vstate L161-175, all call sites using string keys — L264, L290, L613, L775-778, L868, L875, L1032, L1080, L1113, L1186, L1277, L376)
- Modify: `src/pine/builtins/util.ts` RtCtx.state type if needed (L52 — `Map<string,unknown>` → `Map<string, Map<string|number, unknown>>` or restructure entirely)
- Test: `src/pine/__tests__/ta.test.ts` (existing; no new file needed — state correctness is covered by existing ema/rma/cum/supertrend/vwap tests)

**Interfaces:**
- Consumes: none
- Produces: same helper signatures; only the `key` argument type widens from `string` to `string | readonly (string|number)[]`.

**Assumptions:**
- `rt.callsite` is a string; `seriesId` returns number; `sdMult`/`lenOf`/etc. are numbers — all hashable as Map keys directly.

**Done when:**
- All existing ta.* tests pass unchanged (no semantic change).
- `__mtfStats.gatePass`/`gateFail`/`prodWalks` counts in the mtf suite unchanged (proves state slots still resolve identically).
- Profile: `stateFor`/`vsOf` self-time drops from ~500ms aggregate → <100ms on TRIS390-equivalent run; `ta.ts` `get` self-time drops correspondingly.

- [ ] **Step 1: Write a regression test that keys state correctly**

```ts
// add to src/pine/__tests__/ta.test.ts
it('ema/rma/cum state isolates per callsite+series (post nested-Map)', async () => {
  const bars = mkBars(30);
  // Two call sites each call ema(close, 5) — must NOT share state.
  const a = runBars(bars, (c) => call('ema', c, [ser(c.close), fv(5)]));
  const b = runBars(bars, (c) => call('ema', c, [ser(c.close), fv(5)]));
  expect(numv(a[29]!)).toBeCloseTo(numv(b[29]!), 6);
  // Different length → different series.
  const c5 = runBars(bars, (c) => call('ema', c, [ser(c.close), fv(10)]));
  expect(numv(c5[29]!)).not.toBeCloseTo(numv(a[29]!), 6);
});
```

- [ ] **Step 2: Run to verify pass already** (this asserts current behavior stays true — it's a regression test, not a failing test).

- [ ] **Step 3: Replace `stateFor` with nested-Map variant**

Original (anchor: `const CTX_STATE = new WeakMap` at ta.ts:100):

```ts
const CTX_STATE = new WeakMap<BuiltinCtx, Map<string, unknown>>();
function stateMap(ctx: BuiltinCtx): Map<string, unknown> { … }
function stateFor<T>(ctx: BuiltinCtx, key: string, make: () => T): T {
  const m = stateMap(ctx);
  let s = m.get(key) as T | undefined;
  if (s === undefined) { s = make(); m.set(key, s); }
  return s;
}
```

Replacement:

```ts
const CTX_STATE = new WeakMap<BuiltinCtx, Map<unknown, unknown>>();
function stateMap(ctx: BuiltinCtx): Map<unknown, unknown> {
  const rt = ctx as RtCtx;
  if (!rt.state) {
    rt.state = CTX_STATE.get(ctx) ?? new Map();
    CTX_STATE.set(ctx, rt.state);
  }
  return rt.state as Map<unknown, unknown>;
}

// Deep-path get-or-create: parts can be string | number, never objects.
function stateFor<T>(ctx: BuiltinCtx, parts: readonly (string | number)[], make: () => T): T {
  let m = stateMap(ctx);
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    let next = m.get(k) as Map<unknown, unknown> | undefined;
    if (next === undefined) { next = new Map(); m.set(k, next); }
    m = next;
  }
  const leaf = parts[parts.length - 1]!;
  let s = m.get(leaf) as T | undefined;
  if (s === undefined) { s = make(); m.set(leaf, s); }
  return s;
}
```

**Update all string-key call sites** — keep call shape `(ctx, [parts…], make)`. Part-arrays keep their old flat-key segment boundaries as separate parts (scout condition a — no arity collapse). Examples (anchor + replacement pairs):

- `vsOf` series branch (anchor `return stateFor<VS>(ctx, \`vs|${site}|series#${seriesId(s)}\`, …)`):
  ```ts
  return stateFor<VS>(ctx, ['vs', site, 'series', seriesId(s)], () => ({ … }));
  ```
- `vsOf` const branch (anchor `\`vs|${site}|const|${sig}|${c}\``):
  ```ts
  return stateFor<VS>(ctx, ['vs', site, 'const', sig, c ?? 'u'], () => ({ … }));
  ```
  — keep `'const'`/`'series'` branch tags as their own part; `c` may be `undefined`/`NaN` — Map SameValueZero accepts both, pass as-is (normalize `undefined`→`'u'` only if you need to distinguish "undefined" from a literal `undefined` key — in practice no collision, keep raw).

- `vseries` (anchor `\`dvs|${key}\``):
  ```ts
  return stateFor<VS>(ctx, ['dvs', key], () => { … });
  ```

- `vstate` (anchor `\`stv|${key}\``):
  ```ts
  return stateFor<VS>(ctx, ['stv', key], () => { … });
  ```

- `stv-x|…` / `stv-b|…` / `stv-m|…` (supertrend/vwap/sar state objects, e.g. anchor `\`stv-x|${key}\``):
  ```ts
  stateFor<X>(ctx, ['stv-x', key], …)
  ```
  — the `'stv-x'`/`'stv-b'`/`'stv-m'` literals are already distinct namespaces; keep them as the first part.

- `emaTag` stays a string — it's a *grouping key* for ema-chain vsOf/vstate, not a stateFor key. Callers feeding it into `stateFor`/`vstate` pass it as one `parts` element: `['ema', emaTag(…)]`. (The `${site}|${id}` concat inside emaTag is one per call, not per state lookup — acceptable.)

- Any other `stateFor<X>(ctx, \`tag|${a}|${b}\`, …)` → `stateFor<X>(ctx, ['tag', a, b], …)`.

- **Namespace guard (scout condition b):** never use `'strategy|…'` as a first-level part — strategy.ts:151-153 + strategyEquity.ts:17-18 own `strategy|orders`/`strategy|cfg`/`strategy|simCache`/`strategy|ddCache` as flat keys on the same `rt.state` map. A nested part named `strategy|orders` would collide with their flat key. All ta.ts first-parts stay in `{'vs','dvs','stv','stv-x','stv-b','stv-m','ema','rg','rl','cum','obv','wad','nvi','pvi','vwap','fisher','sar','st-atr','macd','dmi','kc','tsi','hma','rsi-g','rsi-l', …}` — audit the actual strings used after refactor and confirm none start with `'strategy|'`.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run src/pine/__tests__/` Expected: all PASS. (If any test imported `stateFor` directly, update them too.)

- [ ] **Step 5: Measure**

`scratch/_prof_high.mjs` profile: `stateFor`/`vsOf`/`get` lines drop from top-25; ta.ts block total self-time <5%.

- [ ] **Step 6: Commit**

```bash
git add src/pine/builtins/ta.ts src/pine/builtins/util.ts src/pine/__tests__/ta.test.ts
git commit -m "perf: stateFor/vsOf/vstate nested-Map keys — kill per-call string concat"
```

---

### Task 4: Slice C-2 — `evalArg` literal fast-path

**Blocked by:** Task 3 (same file region — keeps diffs reviewable; not a hard dep).

**Files:**
- Modify: `src/pine/interpreter.ts` (`evalArg` L1144-1168)
- Test: `src/pine/__tests__/interpreter.test.ts` (existing — add regression for `x[1]` on literal arg behavior)

**Interfaces:**
- Consumes: Task 3's `stateFor` signature (unrelated but co-located commits)
- Produces: `evalArg` unchanged signature

**Assumptions:**
- Parser literal node types are exactly `'num' | 'str' | 'bool' | 'color' | 'na'` (parser.ts:932-947) — there is NO `'int'`/`'float'` node type; `'num'` carries an `isInt` flag.
- `'str'/'color'/'na'` args already bypass wrap at L1156 (their evalExpr result kind isn't int/float/bool) — the real win is `'num'` + `'bool'` only.
- **Scout-verdict (BalancedCuckoo):** the fast-path is builtin-args-ONLY. `bindCallArgs` (UDF/UDT-method binding, interpreter.ts:1171-1200) MUST keep wrapping literals in callHist BarSeries: `callUdfValue` (L1216-1232) binds a series arg via CowSeries and seeds it so `x[1]` inside `f(20)` returns the accumulated constant — skipping wrap turns `x[1]` into `na` (regression).
- Therefore `evalArg` gains an opt-in flag: `evalArg(a, frame, litFastPath: boolean)`. `invokeBuiltin` (L1111) and the `obj.method` builtin loop (L1058) pass `true`; `bindCallArgs` passes `false` (or omits → default false).

**Done when:**
- `ta.sma(close, 20)` no longer calls `siteKey`+`callHist.setAt` for `20` on every bar — verify via `__callHistWrites` counter.
- Regression: `f(x) => x[1] + x; plot(f(20))` on 3 bars yields `20`, `40`, `60` (UDF path still wraps literals — `x[1]` reads the seeded callHist BarSeries).
- `nz(x, 0)` still returns `x`'s value (or `0` when `x` is na) — `nz` impl uses `unwrapped`/scalar reads on raw values.
- Existing test that asserts `ta.highest(20)`-style scalar-overload behavior still passes (`constSeriesNum` at ta.ts:41-73 branches on `v.kind==='int'` for raw scalars — scout confirmed equivalent result).

- [ ] **Step 1: Write failing tests** (two tests — fast-path fires AND UDF wrap preserved)

```ts
// src/pine/__tests__/interpreter.test.ts
import { __callHistWrites } from '../interpreter';

it('literal scalar arg bypasses callHist in builtin args', async () => {
  const writes0 = __callHistWrites;
  await runScript(parse('indicator("t"); x = ta.sma(close, 20); plot(x)'), {
    bars: mkBars(10), ticker: { symbol: 'X', timeframe: '1' },
    fetchSeries: async () => ({ kind: 'array', v: [] }),
  });
  // `close` is an ident→series (no wrap write); `20` literal must skip callHist.
  expect(__callHistWrites - writes0).toBe(0);
});

it('UDF literal arg keeps history — f(20) with x[1] unchanged', async () => {
  const src = 'indicator("t")\nf(x) => x[1] + x\nplot(f(20))';
  const r = await runScript(parse(src), {
    bars: mkBars(3), ticker: { symbol: 'X', timeframe: '1' },
    fetchSeries: async () => ({ kind: 'array', v: [] }),
  });
  const p = [...r.plots.values()][0];
  // PIN CURRENT BEHAVIOR: run on HEAD first to capture what x[1] yields at
  // bar0 under seeded callHist (likely 20 → 40) — assert that same value.
  expect(p.v.cur().v).toBe(40);
});
```

- [ ] **Step 2: Verify fail** (`__callHistWrites` doesn't exist yet — implement counter + assert).

- [ ] **Step 3: Implement**

Original (anchor `function evalArg(a: Arg, frame: Frame): Value` at interpreter.ts:1144):

```ts
function evalArg(a: Arg, frame: Frame): Value {
  const { scope, ctx } = frame;
  const run = runOf(ctx);
  if (a.value.type === 'ident') { … }
  const v = evalExpr(a.value, frame);
  if (v.kind === 'series') return v;
  if (v.kind !== 'int' && v.kind !== 'float' && v.kind !== 'bool') return v;
  const key = siteKey(run, a.value);
  let s = run.callHist.get(key as Node);
  if (!s) { s = new BarSeries(); run.callHist.set(key as Node, s); trackSeries(run, s); }
  s.setAt(ctx.barIndex, v);
  return { kind: 'series', v: s };
}
```

Replacement — `litFastPath` opt-in flag; builtin arg loops pass `true`, `bindCallArgs` keeps default `false`:

```ts
export let __callHistWrites = 0; // test instrumentation

// litFastPath=true is ONLY safe for builtin-call args: a literal num/bool has
// no history a builtin can consume (Pine `20[1]` is invalid). UDF/UDT-method
// args MUST keep the callHist BarSeries — callUdfValue seeds param history
// from it, and `f(20)` bodies may legitimately read `x[1]`.
function evalArg(a: Arg, frame: Frame, litFastPath = false): Value {
  const { scope, ctx } = frame;
  const run = runOf(ctx);
  if (a.value.type === 'ident') {
    const s = seriesOf(scope, a.value.name) ?? ctxSeries(ctx, a.value.name);
    if (s) return { kind: 'series', v: s };
  }
  const lit = a.value.type;
  if (litFastPath && (lit === 'num' || lit === 'bool')) {
    // 'str'/'color'/'na' already bypass wrap below; 'num'/'bool' are the win.
    return evalExpr(a.value, frame);
  }
  const v = evalExpr(a.value, frame);
  if (v.kind === 'series') return v;
  if (v.kind !== 'int' && v.kind !== 'float' && v.kind !== 'bool') return v;
  const key = siteKey(run, a.value);
  let s = run.callHist.get(key as Node);
  if (!s) {
    s = new BarSeries();
    run.callHist.set(key as Node, s);
    trackSeries(run, s);
  }
  s.setAt(ctx.barIndex, v);
  __callHistWrites++;
  return { kind: 'series', v: s };
}
```

Call-site changes (3 edits, all in `evalCallDispatch`/`invokeBuiltin`):

1. `invokeBuiltin` arg loop (anchor `for (const a of node.args) { const v = evalArg(a, frame);` at L1111): change to `const v = evalArg(a, frame, true);`
2. `obj.method` builtin args (anchor `for (const a of node.args) { const v = evalArg(a, frame);` at L1058): change to `const v = evalArg(a, frame, true);`
3. `bindCallArgs` — NO CHANGE (keeps `evalArg(a, frame)` default `false`).

- [ ] **Step 4: Run all tests** — `npx vitest run src/pine/__tests__/` all PASS. The UDF test must pin HEAD's actual `f(20)`+`x[1]` value — capture baseline BEFORE editing (run the script on HEAD, record result, use it in the assertion).

- [ ] **Step 5: Commit**

```bash
git add src/pine/interpreter.ts src/pine/__tests__/interpreter.test.ts
git commit -m "perf: literal num/bool args bypass callHist in builtin calls (UDF args keep wrap)"
```

---

### Task 5: Slice C-3 — dispatch WeakMap + `siteKey` trie + `bindArgs` fast-path

**Blocked by:** Task 4 (touches interpreter.ts region).

**Files:**
- Modify: `src/pine/interpreter.ts` (`siteKey` L307-317, `evalCallDispatch` member-chain L1025-1036 + `obj.method` L1044-1075, `RunState` fields L104-137)
- Modify: `src/pine/builtins/util.ts` (`bindArgs` L166-194 — positional-only fast path)
- Modify: `src/pine/builtins/registry.ts` — add `KIND_BUILTIN: Map<string, Map<string, BuiltinFn>>` alongside `BUILTINS`
- Test: existing interpreter suite covers dispatch; add one regression for `x.foo()` UDT method vs builtin

**Interfaces:**
- Produces: `registry.ts` exports `KIND_BUILTIN`; `interpreter.ts` internal `siteKey`/`evalCallDispatch`/`callBuiltin` unchanged signatures.

**Assumptions:**
- `RunState.siteStack` stays `string[]` (callsite `#N` strings). `siteKey` walks the trie by string without `join`.
- `callsiteSeq` produces `#N` strings — string trie key, not number.

**Done when:**
- `siteStack.join('|')` is gone from the hot path (grep proves).
- `evalCallDispatch` on a top-level `ta.sma(...)` hits `WeakMap.get(node)` → `BUILTINS` once per Call node ever, then `scope.lookup(head.name)` per bar only.
- `bindArgs` on `input.int(1, 'x')` with zero named args skips `Object.entries(named)` iteration.
- All interpreter tests pass; 見高K4.55 drops ≥1s more vs Task-4 baseline.

- [ ] **Step 1: Write failing test for `siteKey` trie**

```ts
// interpreter.test.ts
it('siteKey: nested UDF callsite composes without string join', async () => {
  // A UDF called twice from two sites must produce distinct slots.
  const src = `
    indicator("t")
    f() => var x = 0; x := x + 1; x
    a = f()
    b = f()
    plot(a + b)
  `;
  const r = await runScript(parse(src), { bars: mkBars(3), ticker: { symbol:'X', timeframe:'1' }, fetchSeries: async () => ({ kind:'array', v: [] }) });
  const p = r.plots.get('plot_0') ?? [...r.plots.values()][0];
  // a ends at 3, b ends at 3 → a+b at bar 2 = 3+3=6.
  expect(p?.v?.cur?.()?.v ?? 0).toBe(6);
});
```

- [ ] **Step 2: Implement `siteKey` trie (no join)**

Original (anchor `function siteKey(run: RunState, node: object): object` at L307):

```ts
function siteKey(run: RunState, node: object): object {
  if (run.siteStack.length === 0) return node;
  let id = run.nodeIds.get(node);
  if (id === undefined) { id = run.nodeSeq++; run.nodeIds.set(node, id); }
  const sp = run.siteStack.join('|');
  let path = run.siteIds.get(sp) as Map<number, object> | undefined;
  if (path === undefined) { path = new Map(); run.siteIds.set(sp, path); }
  let key = path.get(id);
  if (!key) { key = {}; path.set(id, key); }
  return key;
}
```

Replacement (trie over callsite strings — no join):

```ts
// Trie: siteIds: Map<siteStr, TrieNode>; TrieNode = Map<siteStr|number, TrieNode|object>.
// Replaces run.siteStack.join('|') + Map<string,Map<number,object>>.
interface SiteTrie { m: Map<unknown, unknown>; }
const SITE_TRIE_KEY = Symbol('site-trie-leaf');

function siteKey(run: RunState, node: object): object {
  const stack = run.siteStack;
  if (stack.length === 0) return node;
  let id = run.nodeIds.get(node);
  if (id === undefined) { id = run.nodeSeq++; run.nodeIds.set(node, id); }
  // Walk/create the trie: root → site1 → site2 → … → leaf node-id → object
  let m: Map<unknown, unknown> = run.siteTrie;
  for (const s of stack) {
    let next = m.get(s) as Map<unknown, unknown> | undefined;
    if (next === undefined) { next = new Map(); m.set(s, next); }
    m = next;
  }
  let leaf = m.get(id) as object | undefined;
  if (leaf === undefined) { leaf = {}; m.set(id, leaf); }
  return leaf;
}
```

Update `RunState` accordingly — remove `siteIds` and `keyCache`, add `siteTrie: Map<unknown,unknown>`:

```ts
// In RunState interface: replace
//   siteIds: Map<string, object>;
//   keyCache: Map<string, object>;
// with
//   siteTrie: Map<unknown, unknown>;
// In runState constructor: replace `siteIds: new Map(), keyCache: new Map()` with `siteTrie: new Map()`.
```

- [ ] **Step 3: Implement `evalCallDispatch` WeakMap resolution**

Original (anchor `if (callee.type === 'member' && !callee.computed) { const parts: string[] = …` at L1025):

```ts
if (callee.type === 'member' && !callee.computed) {
  const parts: string[] = [callee.prop];
  let head: Node = callee.obj;
  while (head.type === 'member' && !head.computed) { parts.unshift(head.prop); head = head.obj; }
  if (head.type === 'ident' && scope.lookup(head.name) === undefined) {
    parts.unshift(head.name);
    const b = BUILTINS.get(parts.join('.'));
    if (b) return invokeBuiltin(b, node, frame);
  }
}
```

Replacement:

```ts
// Per-Call memoized resolution: re-walk callee chain once per Call node.
// `headName` cached so re-checking `scope.lookup(head.name)` is just a
// hash read — scope rebinds still respected.
const RESOLVED_BUILTIN = new WeakMap<Call, { headName: string; fn: BuiltinFn }>();

if (callee.type === 'member' && !callee.computed) {
  let hit = RESOLVED_BUILTIN.get(node);
  if (hit === undefined) {
    const parts: string[] = [callee.prop];
    let head: Node = callee.obj;
    while (head.type === 'member' && !head.computed) { parts.unshift(head.prop); head = head.obj; }
    if (head.type === 'ident') {
      parts.unshift(head.name);
      const b = BUILTINS.get(parts.join('.'));
      if (b) hit = { headName: head.name, fn: b };
    }
    // Cache undefined sentinel so misses don't re-walk either.
    RESOLVED_BUILTIN.set(node, hit ?? { headName: '', fn: undefined as unknown as BuiltinFn });
  }
  if (hit.fn !== undefined && scope.lookup(hit.headName) === undefined) {
    return invokeBuiltin(hit.fn, node, frame);
  }
  // fall through — scope-bound head or miss.
}
```

(Sentinel shape: store `{headName, fn?}` where `fn` may be undefined → treat as miss. Adjust typing.)

For the `obj.method` `<kind>.<prop>` path (anchor `const b = BUILTINS.get(\`${obj.kind}.${prop}\`)` at L1054): add `KIND_BUILTIN` to `registry.ts`:

```ts
// registry.ts — parallel two-level map, populated inside registerBuiltin:
const KIND_BUILTIN = new Map<string, Map<string, BuiltinFn>>();
export function kindBuiltin(kind: string, prop: string): BuiltinFn | undefined {
  return KIND_BUILTIN.get(kind)?.get(prop);
}
// In registerBuiltin(ns, name, fn): also KIND_BUILTIN.set…(ns).set(name, fn)
```

Then `interpreter.ts:1054` becomes `const b = kindBuiltin(obj.kind, prop);` (import at top).

- [ ] **Step 4: `bindArgs` positional fast-path**

Original (anchor `export function bindArgs(` at util.ts:166):

```ts
export function bindArgs(args, named, order) {
  const out = new Map<string, Value>();
  for (const [k, v] of Object.entries(named)) { … }
  let i = 0;
  for (const name of order) { … }
  return out;
}
```

Replacement — add early-out when `named` is empty and `order` covers all positional:

```ts
export function bindArgs(args, named, order) {
  const out = new Map<string, Value>();
  const namedKeys = Object.keys(named);
  if (namedKeys.length === 0) {
    // All-positional fast path: skip entries() iteration entirely.
    for (let i = 0; i < Math.min(args.length, order.length); i++) {
      out.set(order[i]!, args[i]!);
    }
    return out;
  }
  for (const [k, v] of Object.entries(named)) { … }
  …
}
```

- [ ] **Step 4b: `drainBindWarnings` empty-queue fast-path** (scout bonus — every builtin call currently allocs a fresh array via splice)

Original (anchor `export function drainBindWarnings` at util.ts:156):

```ts
export function drainBindWarnings(): string[] {
  return bindWarnQ.splice(0, bindWarnQ.length);
}
```

Replacement:

```ts
const EMPTY_WARNINGS: readonly string[] = Object.freeze([]);
export function drainBindWarnings(): string[] {
  // Fast path: empty queue → shared frozen array (no alloc per builtin call).
  if (bindWarnQ.length === 0) return EMPTY_WARNINGS as unknown as string[];
  return bindWarnQ.splice(0, bindWarnQ.length);
}
```

(Caller at interpreter.ts:1130 iterates the result — a frozen empty array is fine; it never mutates the drained list.)

- [ ] **Step 5: Run all tests + measure**

`npx vitest run src/pine/__tests__/` all PASS + `scratch/_prof_high.mjs` shows `evalCallDispatch`/`siteKey`/`bindArgs` self-times each <1%.

- [ ] **Step 6: Commit**

```bash
git add src/pine/interpreter.ts src/pine/builtins/util.ts src/pine/builtins/registry.ts src/pine/__tests__/interpreter.test.ts
git commit -m "perf: siteKey trie (no join), evalCallDispatch WeakMap memo, bindArgs positional fast-path"
```

---

### Task 6: Cleanup — dead `keyCache`/`SERIES_IDENTITY`

**Blocked by:** Task 5 (so the cleanup commit doesn't mix with behavior changes).

**Files:**
- Modify: `src/pine/interpreter.ts` — remove `keyCache` field + init (RunState L135, L167).
- Modify: `src/pine/series.ts` — remove `SERIES_IDENTITY` WeakMap declaration (L237) + any dead comments.
- Modify: `src/pine/mtf.ts` — if `SERIES_IDENTITY` is imported, drop it.

**Done when:**
- `grep keyCache src/pine/` → 0 hits.
- `grep SERIES_IDENTITY src/pine/` → 0 hits.
- All tests still pass.

- [ ] **Step 1: grep to confirm zero consumers**

```bash
grep -rn "keyCache\|SERIES_IDENTITY" src/pine/
```

- [ ] **Step 2: Remove declarations**

```bash
git add -p src/pine/interpreter.ts src/pine/series.ts src/pine/mtf.ts
git commit -m "chore: drop dead keyCache and SERIES_IDENTITY scaffolding (QA/Task-5 leftovers)"
```

- [ ] **Step 3: Run suite** — all PASS.

---

### Task 7: Measure & decide on slice-D

**Blocked by:** Tasks 1-6.

**Files:** none — measurement only.

**Done when:**
- `scratch/_prof_high.mjs` records: 見高K4.55 wall time, 高量1.46 wall time, top-10 self-time table.
- Both are <4s / <2s respectively → plan declares DONE and slice-D (compile-to-closures) is skipped.
- Otherwise → write a follow-up plan for Task 4 (compile-to-closures) using VivaciousBuzzard's boundary matrix (already captured in scout report).

- [ ] **Step 1: Run `scratch/_prof_high.mjs`** and record numbers in plan changelog.

- [ ] **Step 2: Decision**
- If targets met → stop.
- If not → start new plan doc `2026-10-XX-compile-to-closures.md` referencing this plan's "boundary matrix" evidence.

---

## Post-mortem changelog (2026-10-08)

| Commit | Item |
|---|---|
| 4b4e634..b441877 | Tasks 1-6 landed (time part cache, input memo, stateFor/vsOf/vstate maps, LitSeries, evalCallDispatch WeakMap + siteKey, constSeriesNum rewrite) |
| 640f6f6 | constSeriesNum watermark on ctx.barIndex (multi-push residual) |
| 0574024 | lastEmit caller-scoped under gaps_on + forCaller short-circuit |
| 8007347, d2fe77a | indicator dedup: manifest scripts out of ext bag; parked/ext restore idempotent |
| 1f91c68 | kbars in-flight dedup + 15s TTL (security prefetch hit same 1m payload ×3) |
| fc3089d | __pineRunLog + __mtfStats browser QA probes |
| 8edce9e..11fc4e9 | slice-D compile-to-closures tasks 1-6; 99.5% of K4.55 body compiled; default-on, `__pineInterp`/`PINE_INTERP=1` opt-out |

**Measured (same pipeline, 500-bar synthetic):**
- 見高K4.55: 10.2s → 5.1s (pre-slice-D); post-slice-D ~5.4s — flat
- 高量1.46: 4.2s → 2.1s (pre-slice-D); post-slice-D ~2.14s — flat
- Real Chromium `runIndicator` (TSE:2330 5m, 1045 bars, fetch dedup'd): ~11.3-12.6s wall; eval stage ~11s; fetch ~0.28s

**Where the remaining time goes (bun --cpu-prof on _prof_scale.mjs):** no single hotspot — `setAt` (~0.8s spread), `bindArgs`, `ensureBar`, `evalArg`, interpreter.ts:1579 block, plus a profiler-artifact `Error` self-time (real count 0 via monkey-patch probe). evalNode dispatch already below top-5 — slice-D captured the dispatch win (~35% self-time drop on evalNode) but dispatch was only ~4% of the whole.

**Residual perf levers not pursued:** incremental ta.* window state inside tf evalAt (ta.sma recomputes its full window per tf bar — O(window) per bar instead of O(1) running); per-(spec,caller) SecSeries allocation; deeper BarSeries write paths. Expected next win is small (<10%) without algorithmic rework of per-bar ta builtins.
