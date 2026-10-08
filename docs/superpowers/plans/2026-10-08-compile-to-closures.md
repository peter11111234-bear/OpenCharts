# Slice-D: Compile Top-Level Statements to Closures — Implementation Plan

> **日期：** 2026-10-08
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the per-bar `evalExpr(stmt, frame)` → `evalNode` switch dispatch over ~500 chart bars × ~200 top-level stmts by compiling each top-level stmt into a closure once per run. Measured: `runIndicator` on 見高K4.55 = 13.77s wall in real Chromium (network 0.28s — ~13.5s is interpreter eval); synthetic pipeline `scratch/_prof_high.mjs` = 5.1s 見高K / 2.1s 高量 on 500 bars.

**Architecture:** `runScriptInner` builds `CompiledStmt[]` once (after the `pruneCutoff` scan, before the bar loop). Each closure carries the *verbatim body* of its `evalNode` case, with child nodes recursively compiled where profitable. All live state (`scope`, `ctx.barIndex`, `run.siteStack`, `rt.callsite`, `run.declSlots`, `run.tupleKeys`, `run.callHist`, `run.warned`, `run.topLevelBody`/`topStmtIdx`) is read at call time — never baked. Fallback stmt kinds (`for`/`while`/`switch`/`indicator`/`strategy`/unknown) keep the existing `evalExpr` path in the same loop.

**Tech Stack:** TypeScript, vitest, `npx vite-node scratch/_prof_high.mjs`, node `--cpu-prof`, real-Chromium re-measure.

**Spec:** `scratch/sliceD-boundary.md` (authoritative stmt×compilability matrix + 10-item closure contract); prior plan `docs/superpowers/plans/2026-10-08-per-bar-eval-perf.md` Task 7 ("if targets unmet → write compile-to-closures plan").

**Spec invariant:** Bit-identical `RunResult` — `plots`, `warnings`, `drawings`, `fills`, `bgcolors`, `barcolors`, `alerts`, `alertconditions`, `inputs`, `errors`, `orderEvents`/`execs` must match the interpreted path field-for-field on the same input. Equivalence is proven by `snapshot()` (golden.ts:141) comparing compiled vs forced-interpreted runs.

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same
verify failing after 2+ distinct fix attempts. Single red test = normal TDD
loop, not a blocker.

**Plan-specific Nevers (the closure contract — from boundary matrix §"Semantics the closure MUST preserve"):**
- NEVER bake a `siteKey`/callsite into a closure — decl/callHist/tuple keys go through `siteKey(run, node)` per call so UDF-shared nodes keep per-callsite slots.
- NEVER read `ctx.barIndex` at compile time — all `setAt`/`cur`/`histGetAt` read the live bar.
- NEVER cache or reuse a `Scope`/`blockFrame` across bars — if-arms still allocate a fresh child `Scope` every bar.
- NEVER skip the `scopeDepth++/--` and `topLevelBody=false/topStmtIdx=-1` bookkeeping inside compiled `if`/`seq` bodies — that's `evalBlock`'s job verbatim (plot.* CE10188 warn-skip + ensureList pruning depend on it).
- NEVER absorb `BREAK`/`CONTINUE`/`ReturnSignal` inside a compiled closure — rethrow before `wrapPineError`, exactly like `evalExpr` (interpreter.ts:476-483).
- NEVER collapse `var`/`varip`/`var tuple` to a single path — fresh-vs-carried dispatch on `declSlots.has(dk)` must run per item per bar (interpreter.ts:594-612, 620-641).
- NEVER bypass `evalCall` for `call` nodes — the `callsiteId` + `rt.callsite` + `siteStack` push/pop (interpreter.ts:993-1006), `mtf.tryEvalSecurity` front-door (interpreter.ts:1019-1022), and `evalArg` `callHist`/`LitSeries` tracking (interpreter.ts:1193-1235) all live there.
- NEVER delete `evalExpr`/`evalNode`/`evalBlock` — fallback kinds and all nested bodies (if-arms, UDF bodies via `callUdfValue`, `mtf` `evalAt` via `evalHook`) keep interpreting.
- NEVER mutate `RunState` field types or `Frame` shape — internals-only refactor, no public API changes (`runScript`, `evalExpr`, `evalBlock`, `invokeUdf` signatures unchanged).
- NEVER compile `security()` exprs — `mtf.computeAt` → `evalHook` → `evalExpr` stays the only path into tf frames; the compiled table only covers the top-level chart body.

## Fallback table (per top-level stmt kind)

| stmt kind | disposition | closure body |
|---|---|---|
| `num`/`str`/`bool`/`color`/`na` | `direct` | verbatim literal constructors (rare at top level, free to compile) |
| `ident` | `direct` | verbatim `evalIdent(node.name, frame)` — dynamic `scope.lookup` kept |
| `unary`/`binary`/`ternary` | `direct` | verbatim op logic; children via `compileChild` (short-circuit `and`/`or` preserved) |
| `arraylit` | `direct` | verbatim `items.map(compileChild(i))` |
| `member` | `direct` | verbatim `evalMember(node, frame)` |
| `histref` | `direct` | verbatim `evalHistref(node, frame)` — keeps ident-vs-expr `siteKey`/`callHist` split (:895-935) |
| `call` | `direct` | verbatim `evalCall(node, frame)` — single call preserves the whole callsite state machine + mtf hook + evalArg tracking |
| `assign`/`let`/`const` | `direct` | verbatim: `evalExpr(value)` (child compiled) → `bindDeclared(run, siteKey(run,node), …)` |
| `typed` | `direct` | verbatim both branches |
| `var` single-name (`!node.multi`) | `twoPhase` | `isFresh = !run.declSlots.has(siteKey(run,node))`; `fresh` = init-eval + `bindDeclared(persistent)`; `later` = `scope.define` + `valueAt` |
| `var` multi-item, `varip` | `direct` | verbatim per-item loop incl. `varip` warn — freshness is per item, not per stmt |
| `tuple` non-var | `direct` | verbatim; `run.tupleKeys` keyed by `siteKey(run,node)` stays live |
| `tuple` var | `direct` | verbatim `names.some(!declSlots)` fresh/carried dispatch (:625-641) — fresh-set is per-name, `twoPhase` can't express it; child `value` compiled inside the fresh branch |
| `reassign` | `direct` | verbatim `evalReassign(node, frame)` — live `scope.lookup`, no slot caching |
| `if`/`ifexpr` | `direct` | verbatim branch select; `test`/`elseIfs.test` via `compileChild`; arms via `evalBlock(branch, blockFrame(frame))` unchanged |
| `break`/`continue` | `direct` | verbatim `throw BREAK/CONTINUE` |
| `return` | `direct` | verbatim `throw new ReturnSignal(...)`; `value` child compiled |
| `seq` | `direct` | verbatim `evalBlock(node.stmts, frame)` — keeps scopeDepth + topLevelBody bookkeeping |
| `func` | `direct` | verbatim scope.define with **live** `closure: scope` (NOT a no-op — an if-arm `func` is nested anyway; top-level re-define is cheap and provably identical) |
| `arrow` | `direct` | verbatim — captures live scope each bar |
| `method`/`typedecl`/`field` | `direct` | verbatim register / void |
| `import` | `direct` | verbatim `warn(...)` — `run.warned` dedup makes bar 1+ a no-op |
| `export` | `direct` | verbatim `evalExpr(node.decl, frame)` — decl may itself be `var`; keep interpreted |
| `for`/`while` | `fallback` | per-iter `blockFrame` + loopVar BarSeries + BREAK/CONTINUE absorb — compile ROI low, inner is `evalBlock` anyway |
| `switch` | `fallback` | matched-arm BREAK→void vs default-arm propagate distinction (:1538-1544) — risky to duplicate |
| `indicator`/`strategy` (in-body) | `fallback` | `declDrawQuotas`/`strategyDecl` per-bar idempotence unverified — conservative per boundary matrix |
| unknown kind | `fallback` | `evalExpr(node, frame)` — forward-compatible |

## Decision Points

### D1: closure shape + error-wrap ownership   (T1)
- Consumed by: all tasks
- Candidates:
  - A: closure returns raw value, bar loop wraps errors — one shared try/catch can't attribute errors to the failing node the way `evalExpr`'s `wrapPineError(e, node)` does; a stmt-level wrapper per dispatch re-introduces a switch.
  - B (preferred): every compiled `fn` embeds `evalExpr`'s exact try/catch (rethrow BREAK/CONTINUE/ReturnSignal, else `wrapPineError(e, node)`). `CompiledStmt.fn(frame, run)` is a drop-in for `evalExpr(node, frame)` — the bar loop treats `direct`/`fallback` identically except for the call target.
  - C: compile only to depth-1 (stmt-level closures call `evalExpr` for every child) — saves the switch at stmt level only; leaves the child-dispatch cost (~90% of evalNode hits are nested exprs).
- Chosen: B, with `compileChild` recursion so expr children are also closures when their kind compiles (depth unlimited; each level keeps its own error-wrap so `node.loc` attribution is unchanged).
- Rejected: A (loses per-node error attribution), C (leaves most of the dispatch).
- Revisit trigger: deep ASTs cause compile-time recursion blowup (parser emits trees, depth ~O(10) — not expected).
- Outcome: B implemented as written (T1, 8edce9e). Per-node wrap preserved; no recursion blowup (K4.55 body compiles fine, 1205 compile() calls).

### D2: `twoPhase` vs inline fresh/carried for `var`   (T4)
- Consumed by: Task 4
- Candidates:
  - A: `direct` closure containing the verbatim `if (fresh) … else …` per item — simplest, keeps `declSlots.has(dk)` per bar (~30ns).
  - B (preferred): single-name `var` gets `{kind:'twoPhase', isFresh, fresh, later}` — the bar loop evaluates `isFresh(run)` and calls the matching closure; init-eval is un-reachable after first write instead of merely skipped. Multi-item `var`/`varip`/`var tuple` keep A because freshness is per item/name, not per stmt.
- Criteria:
  - `var x = f()` where `f` has a side effect must evaluate `f` exactly once per (node × callsite path) — regression test asserts the count, not just values.
  - carried-path must do `scope.define(name, s)` + `valueAt(s, bar)` verbatim (rebind every bar — an if-arm may have shadowed the name in a sibling scope).
- Chosen: B for single-name `var`; A for multi/`varip`/`var tuple` (documented in fallback table).
- Rejected: —
- Revisit trigger: none expected — `declSlots.has` is already the semantic source of truth.
- Outcome: B implemented for single-name `var` (T4, 11e5a35); multi/`varip`/`var tuple` kept verbatim-A. Side-effect-count test pins init at exactly 1 eval.

### D3: feature-flag mechanism   (T1)
- Consumed by: Task 1 (harness), Task 6 (default flip), rollback
- Candidates:
  - A: env var only (`PINE_INTERP=1`) — unreachable in the built browser bundle.
  - B (preferred): `(globalThis as any).__pineInterp === true` OR `process.env.PINE_INTERP === '1'`, evaluated once per `runScriptInner` call. Matches existing `globalThis.__pineStage` convention; browser escape hatch = `window.__pineInterp = true` before run; tests toggle the global.
  - C: `RunOptions` field — public API change, rejected by Global Constraints.
- Chosen: B
- Rejected: A (browser), C (API surface)
- Revisit trigger: flag needs per-script granularity → move into `RunOptions` then (breaking change, separate discussion).
- Outcome: B implemented. Verified: `PINE_INTERP=1` → `__compileCalls` delta 0; `window.__pineInterp = true` → same in Chromium. Both opt-outs reach the bar loop.

### D4: code placement   (T1)
- Consumed by: Task 1
- Candidates:
  - A (preferred): `compile()`/`compileChild`/`CompiledStmt` live in `interpreter.ts` — every callee (`evalMember`, `evalReassign`, `bindDeclared`, `siteKey`, `warn`, `numVal`, `unseries`…) is module-private; a `compile.ts` would force ~15 new exports or a circular import.
  - B: separate file — rejected, export churn.
- Chosen: A — new `// ── compile-to-closures ──` section between `evalSwitch` (:1548) and `runScript` (:1550).
- Outcome: A implemented — compile machinery lives in `interpreter.ts` between evalSwitch and runScript; zero new exports except test instrumentation.

## Global Constraints

- Every task ends with `npx vitest run src/pine/__tests__/` green (597 baseline).
- Equivalence harness (`snapshot()` compare, compiled vs `__pineInterp`) must pass on every corpus script before any task commits.
- Measurable delta on `scratch/_prof_high.mjs` recorded in the Review Ledger per task.
- Commits prefixed `perf:` (behavior) / `chore:` (cleanup) / `test:` (test-only).
- The interpreted path is never deleted — rollback = flag flip or single-commit revert.

## Test Matrix

**New file `src/pine/__tests__/compile.test.ts`:**

| Test | What it proves |
|---|---|
| `equivalence corpus` (~12 scripts × `snapshot()` compare, flag on/off) | bit-identical `RunResult` per corpus row |
| corpus: `var x = f()` + `var [a,b]=g()` + multi `var p=1,q=2` | two-phase fresh/carried + per-item dispatch |
| corpus: `if/elseif/else`, `ifexpr`, ternary | blockFrame/scopeDepth/elseIf chain parity |
| corpus: `for`, `for-in [k,v]`, `while`, `switch` w/ default + `break` | fallback kinds still run via evalExpr; exceptions absorbed identically |
| corpus: top-level `break`/`continue` → warning; top-level `return` | bar-loop catch parity (:1754-1762) |
| corpus: `x := `, `a[i] := `, `udt.field := ` | evalReassign verbatim incl. error paths |
| corpus: `x[1]`, `f(x)[1]`, `ta.sma(close,20)[1]` | histref ident/callHist split + evalArg tracking |
| corpus: `request.security(sym, tf, expr)` + UDF-wrapped security callsite | mtf.tryEvalSecurity routing via verbatim evalCall |
| corpus: `func` decl + UDF call reading `param[1]` + `param := ` | CowSeries/paramCows untouched; `func` closure binds live scope |
| corpus: `import`/`export`/`method`/`typedecl`/`arrow`/`seq` | misc kinds parity incl. warn dedup |
| `var init side-effect count` | `f` pushes to array; `array.size(arr)` pinned — fails if init re-evals per bar |
| `error attribution` | runtime error inside compiled stmt carries identical `wrapPineError` message/loc |
| `flag off = byte-identical code path` | `__pineInterp=true` skips compile entirely; `run.compiled` never built |

**Must stay green (no edits expected):** `golden.test.ts`, `interpreter.test.ts`, `mtf.test.ts`, `mtf_invariance.test.ts`, `mtf_boundary_probe.test.ts`, `strategy.test.ts`, `strategy_equity.test.ts`, `e2e*.test.ts`, `ta.test.ts`, `udt.test.ts`, `input-memo.test.ts`, `time-parts-memo.test.ts`, `perf_bench.test.ts`, `qa_*.test.ts`, `perbar_*.test.ts`, `probe_*.test.ts`.

## Review Ledger
(2026-10-08 execution — ContinuedStarfish)

- **T1 (8edce9e)** `test:` scaffolding + harness. Suite 626 total (597 + 28 new + 1 reused flag test counted... compile.test.ts = 28 tests), all green; all-fallback corpus trivially green; `__compileCalls` delta 0 with flag off.
- **T2 (e40b2b5)** `perf:` literals/ident/unary/binary/ternary/arraylit/member/histref/call cases. Suite 626 green. `_prof_high` compiled ≈ interp (6739/2825 vs 7186/2669ms) — assigns still fallback at this step, so the delta is expectedly small.
- **T3 (de58e58)** `perf:` assign/let/const/typed/tuple/reassign/seq/break/continue/return/func/arrow/method/typedecl/field/import/export. Suite 626 green. `_prof_high` compiled 5816/2113ms vs same-session interp 7186/2669ms.
- **T4 (11e5a35)** `perf:` `var` single-name → twoPhase; multi-var/varip → verbatim per-item; `if`/`ifexpr` compiled test + verbatim `evalBlock(blockFrame)` arms. Suite 626 green. `_prof_high` compiled 5496/2055ms.
- **T5 (f29f4ac)** `test:` kind-coverage audit. `_kinds.mjs` on real 見高K4.55: **399 stmts → 338 direct + 59 twoPhase + 2 fallback (`for`) = 99.5% compiled** (≥90% gate met).
- **T6 (flip)** `perf:` `compiledEnabled` returns true; opt-outs `__pineInterp`/`PINE_INTERP=1`. Suite 627 green with default-on.
  - `npx vite-node scratch/_prof_high.mjs` medians (3+ reps each): compiled 5391–5777ms (med ~5.40s) vs `PINE_INTERP=1` 5353–5594ms (med ~5.54s) → **~2.5% wall gain, NOT ≥20%**. `evalNode` self-time dropped 582→380ms (node --cpu-prof) and left top-5, but the dispatch layer was only ~4% of runtime — the remaining cost is builtin machinery (`invokeBuiltin`, `bindDeclared`, `callUdfValue`, `BarSeries.setAt`, `mtf` tf-eval), not the switch.
  - `_prof_scale.mjs`: compiled 5292/5795/5916ms vs interp 5358/5541/5622ms at 1m-bars=20000/8000/3000 — within noise; runtime dominated by mtf `evalAt` frames which never compile (contract item 10).
  - Real Chromium (vite dev :5173, in-page `runScript`, 500×15m bars, interleaved A/B, 8 reps): compiled med ~3904ms vs interp med ~3718ms — **parity within noise** (React dev-page jitter ±20%); not the 13.77s data path (that measurement included network+engine; this isolates interpreter wall).
  - Rollback drill: `window.__pineInterp = true` → `__compileCalls` delta 0 and interp timings return; `PINE_INTERP=1` → same in node. Verified.
  - **Net:** slice-D is correct (bit-identical on 30-test corpus + full suite) but delivered only ~2-3% wall on the synthetic pipeline — the evalNode-dispatch hypothesis underestimated the builtin/series machinery share. Kept enabled: it's not slower, removes a per-stmt branch layer, and the harness keeps A/B parity coverage.


---

### Task 1: Compile infra — `CompiledStmt` types, `compile()`/`compileChild`, flag, equivalence harness

**Blocked by:** None.

**Files:**
- Modify: `src/pine/interpreter.ts` — new section after `evalSwitch` (insert at :1549, before `// ── runScript ──`).
- Create: `src/pine/__tests__/compile.test.ts`.

**Interfaces:**
- Produces: `type Compiled = (frame: Frame, run: RunState) => Value`; `type CompiledStmt`; `compile(stmt: Node): CompiledStmt`; `compileChild(node: Node): Compiled`; `compiledEnabled(): boolean`. All module-private except `compile` (needed by `runScriptInner`, same module — no export required).

**Done when:**
- `compile.test.ts` exists with the corpus harness; corpus runs BOTH paths and `snapshot()`-compares.
- With only `fallback` implementations registered, corpus is trivially green (compiled==interpreted because compiled delegates to evalExpr) — this is the red→green baseline proving the harness itself.
- Flag off → `runScriptInner` never calls `compile` (assert via a counter `__compileCalls` exported for tests).

- [x] **Step 1: Write the equivalence harness (red)**

```ts
// src/pine/__tests__/compile.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import '../mtf';
import { mkBars, fetchTf, snapshot } from './golden';
import type { RunResult } from '../contracts';

const CORPUS: { name: string; src: string }[] = [
  { name: 'decls+ops', src: `
indicator("t")
a = close + 1
b = a > open ? a : open
plot(b)` },
  { name: 'var two-phase', src: `
indicator("t")
var x = close
var y = close * 2
plot(x[1])` },
  // …full corpus per Test Matrix…
];

const OPTS = (bars: ReturnType<typeof mkBars>) => ({
  symbol: 'X', timeframe: 'D',
  fetchSeries: fetchTf(mkBars(3000)),
});

const g = globalThis as Record<string, unknown>;
describe('compiled vs interpreted parity', () => {
  beforeEach(() => { delete g.__pineInterp; });
  for (const c of CORPUS) {
    it(c.name, async () => {
      const bars = mkBars(60);
      g.__pineInterp = true;
      const interp: RunResult = await runScript(parse(c.src), bars, OPTS(bars));
      delete g.__pineInterp;
      const comp: RunResult = await runScript(parse(c.src), bars, OPTS(bars));
      expect(snapshot(comp)).toEqual(snapshot(interp));
    });
  }
});
```

Run: `npx vitest run src/pine/__tests__/compile.test.ts` — expect FAIL (flag unrecognized / identical output cannot be produced until Task 6 flip — see note). For the TDD loop during Tasks 2-5, make the harness ALSO drive the compiled path explicitly: compile is enabled by default only in Task 6; until then tests set `g.__pineCompiled = true` to force-compile, and the corpus compares `__pineInterp` vs `__pineCompiled`.

- [x] **Step 2: Add types + flag + skeleton `compile()`**

```ts
// interpreter.ts, new section after evalSwitch (:1548)

// ── compile-to-closures ─────────────────────────────────────────────────────
// Top-level stmt → closure. Compiled fns embed evalExpr's exact error
// contract: rethrow BREAK/CONTINUE/ReturnSignal, else wrapPineError(e, node).
// Every read of scope/ctx.barIndex/run.* happens inside the closure — nothing
// per-run is baked at compile time.

/** Per-bar stmt closure — drop-in for evalExpr(node, frame) semantics. */
type Compiled = (frame: Frame, run: RunState) => Value;

type CompiledStmt =
  | { kind: 'direct'; fn: Compiled }
  | { kind: 'twoPhase'; isFresh: (run: RunState) => boolean; fresh: Compiled; later: Compiled }
  | { kind: 'fallback'; node: Node };

export let __compileCalls = 0; // test instrumentation

/** Compiled path enabled unless explicitly opted out (env or global).
 *  Evaluated once per runScriptInner — a mid-run flip never interleaves paths. */
function compiledEnabled(): boolean {
  const g = globalThis as Record<string, unknown>;
  if (g.__pineInterp === true) return false;
  if (typeof process !== 'undefined' && process.env?.PINE_INTERP === '1') return false;
  return true; // flipped to default-on in Task 6; during Tasks 2-5 return g.__pineCompiled === true
}

/** Wraps a raw per-kind body so it carries evalExpr's error contract. */
const wrapCompiled = (node: Node, body: Compiled): Compiled =>
  (frame, run) => {
    try {
      return body(frame, run);
    } catch (e) {
      if (e === BREAK || e === CONTINUE || e instanceof ReturnSignal) throw e;
      throw wrapPineError(e, node);
    }
  };

/** Child-node compiler: compilable kinds get closures; everything else
 *  delegates to evalExpr (which keeps its own error wrap for that node). */
function compileChild(node: Node): Compiled {
  const c = compile(node);
  if (c.kind === 'fallback') {
    return (frame) => evalExpr(node, frame);
  }
  if (c.kind === 'twoPhase') {
    return (frame, run) => (c.isFresh(run) ? c.fresh : c.later)(frame, run);
  }
  return c.fn;
}

function compile(stmt: Node): CompiledStmt {
  __compileCalls++;
  switch (stmt.type) {
    // Task 2+ fill in cases; default keeps the interpreted path.
    default:
      return { kind: 'fallback', node: stmt };
  }
}
```

- [x] **Step 3: Wire dispatch into `runScriptInner`'s bar loop** (interpreter.ts:1736-1753)

```ts
  let barErr: PineRuntimeError | null = null;
  let sliceStart = nowMs();
  // Slice-D: compile the top-level body once per run. Fallback stmts keep
  // evalExpr; topStmtIdx bookkeeping is identical either way.
  const compiledBody: CompiledStmt[] | null =
    compiledEnabled() ? body.map(compile) : null;
  for (let bar = 0; bar < bars.length; bar++) {
    if (bar > 0) barCtx.seek(bar);
    try {
      run.topLevelBody = true;
      try {
        if (compiledBody) {
          for (let i = 0; i < body.length; i++) {
            run.topStmtIdx = i;
            const c = compiledBody[i]!;
            if (c.kind === 'fallback') evalExpr(c.node, frame0);
            else if (c.kind === 'twoPhase')
              (c.isFresh(run) ? c.fresh : c.later)(frame0, run);
            else c.fn(frame0, run);
          }
        } else {
          for (let i = 0; i < body.length; i++) {
            run.topStmtIdx = i;
            evalExpr(body[i]!, frame0);
          }
        }
      } finally {
        run.topStmtIdx = -1;
        run.topLevelBody = false;
      }
    } catch (e) { /* unchanged */ }
```

- [x] **Step 4: Harness green with all-fallback compile** — corpus passes because compiled path delegates to `evalExpr`. `__compileCalls === body.length` per run.

- [x] **Step 5: Commit** — `test: compile-to-closures scaffolding + parity harness (all-fallback baseline)`

---

### Task 2: Compile pure expressions + literals/ident/operators

**Blocked by:** Task 1.

**Files:** Modify `src/pine/interpreter.ts` (compile switch); `src/pine/__tests__/compile.test.ts` (corpus rows).

**Done when:**
- Corpus rows for arithmetic/ternary/ident/arraylit/member/histref/call pass compiled-vs-interpreted.
- `node --cpu-prof` or self-time on `_prof_high.mjs` shows `evalNode` no longer top-3 for a pure-expr microbench (add `scratch/_prof_expr.mjs`: `plot(close*2+open/3)` over 2000 bars — expect evalNode self-time share to drop ≥50%).

- [x] **Step 1: corpus rows + red run** — `decls+ops`, `histref`, `call` rows fail until cases land… (harness uses `__pineCompiled`; before cases exist the compiled path is still all-fallback so rows pass trivially — the real red is the `var`/`if` rows in later tasks; here add a counter test: `__compileCalls` produces ≥1 `direct` stmt for `a = close+1`.)

- [x] **Step 2: cases** — in `compile()`:

```ts
    case 'num': { const v = stmt.isInt; const n = stmt.v;
      return { kind: 'direct', fn: wrapCompiled(stmt, () => numVal(n, v)) }; }
    case 'str': { const s = stmt.v;
      return { kind: 'direct', fn: wrapCompiled(stmt, () => ({ kind: 'string', v: s })) }; }
    case 'bool': { const b = !!stmt.v;
      return { kind: 'direct', fn: wrapCompiled(stmt, () => (b ? VTRUE : VFALSE)) }; }
    case 'color': { const c = stmt.v;
      return { kind: 'direct', fn: wrapCompiled(stmt, () => ({ kind: 'color', v: c })) }; }
    case 'na':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => NA) };
    case 'ident': { const name = stmt.name;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalIdent(name, frame)) }; }
    case 'unary': { const op = stmt.op; const arg = compileChild(stmt.arg);
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) =>
        evalUnary(op, unseries(arg(frame, run)))) }; }
    case 'binary': { const op = stmt.op;
      const L = compileChild(stmt.left), R = compileChild(stmt.right);
      if (op === 'and') return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const l = unseriesTruth(L(frame, run));
        return l && unseriesTruth(R(frame, run)) ? VTRUE : VFALSE; }) };
      if (op === 'or') return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const l = unseriesTruth(L(frame, run));
        return l || unseriesTruth(R(frame, run)) ? VTRUE : VFALSE; }) };
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) =>
        evalBinary(op, unseries(L(frame, run)), unseries(R(frame, run)), run, frame.ctx)) }; }
    case 'ternary': { const T = compileChild(stmt.test),
        C = compileChild(stmt.cons), A = compileChild(stmt.alt);
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) =>
        unseriesTruth(T(frame, run)) ? C(frame, run) : A(frame, run)) }; }
    case 'arraylit': { const items = stmt.items.map(compileChild);
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) =>
        ({ kind: 'array', v: items.map(f => f(frame, run)) })) }; }
    case 'member':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalMember(stmt as Member, frame)) };
    case 'histref':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalHistref(stmt as HistRef, frame)) };
    case 'call':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalCall(stmt as Call, frame)) };
```

- [x] **Step 3: corpus green + measure** — record `_prof_expr` + `_prof_high` delta in Review Ledger.
- [x] **Step 4: Commit** — `perf: compile pure-expr stmts to closures (literals/ident/ops/histref/call)`

---

### Task 3: Compile declarations + misc stmts

**Blocked by:** Task 2.

**Files:** same two files.

**Done when:**
- Corpus rows for `assign`/`typed`/`tuple`/`reassign`/`seq`/`func`/`arrow`/`method`/`typedecl`/`import`/`export`/`break`/`continue`/`return` all pass parity.
- Error-attribution test green (compiled stmt's `wrapPineError` node = same loc as interpreted).

- [x] **Step 1: cases**

```ts
    case 'assign': case 'let': case 'const': {
      const val = compileChild(stmt.value);
      const name = stmt.name;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const v = val(frame, run);
        bindDeclared(run, siteKey(run, stmt), frame.scope, name, v, frame.ctx.barIndex);
        return v.kind === 'series' ? v.v.cur() : v;
      }) };
    }
    case 'typed': {
      const hasInit = stmt.value !== undefined;
      const val = hasInit ? compileChild(stmt.value) : null;
      const name = stmt.name;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const bar = frame.ctx.barIndex;
        if (!val) {
          slotFor(run, siteKey(run, stmt), frame.scope, name).setAt(bar, NA);
          return NA;
        }
        const v = val(frame, run);
        bindDeclared(run, siteKey(run, stmt), frame.scope, name, v, bar);
        return v.kind === 'series' ? v.v.cur() : v;
      }) };
    }
    case 'tuple': {
      // var tuple → verbatim body (per-name freshness; see Task 4 decision D2).
      // non-var: value child compiled; keys map stays in run.tupleKeys.
      const val = compileChild(stmt.value);
      const isVar = !!stmt.var; const names = stmt.names;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const scope = frame.scope, bar = frame.ctx.barIndex;
        let keys = run.tupleKeys.get(siteKey(run, stmt) as Node);
        if (!keys) { keys = new Map(); run.tupleKeys.set(siteKey(run, stmt) as Node, keys); }
        if (isVar) {
          const fresh = names.some(n => {
            const k = keys!.get(n);
            return k === undefined || !run.declSlots.has(k);
          });
          if (!fresh) {
            const carried: Value[] = [];
            for (const name of names) {
              const s = run.declSlots.get(keys!.get(name)!);
              if (s) { scope.define(name, s); carried.push(valueAt(s, bar)); }
              else carried.push(NA);
            }
            return { kind: 'array', v: carried };
          }
        }
        const v = val(frame, run);
        const items = v.kind === 'array' ? v.v : v.kind === 'matrix' ? v.v.flat() : [v];
        names.forEach((name, i) => {
          let k = keys!.get(name);
          if (!k) { k = {}; keys!.set(name, k); }
          slotFor(run, k, scope, name, /*persistent*/ isVar).setAt(bar, items[i] ?? NA);
        });
        return v;
      }) };
    }
    case 'reassign':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalReassign(stmt as Reassign, frame)) };
    case 'seq':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalBlock(stmt.stmts, frame)) };
    case 'break':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => { throw BREAK; }) };
    case 'continue':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => { throw CONTINUE; }) };
    case 'return': {
      const val = stmt.value ? compileChild(stmt.value) : null;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        throw new ReturnSignal(val ? unseries(val(frame, run)) : { kind: 'void' });
      }) };
    }
    case 'func': { const name = stmt.name, params = stmt.params, body = stmt.body;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => {
        const decl: UdfDecl = { name, params, body, closure: frame.scope }; // live scope — never bake
        frame.scope.define(name, { kind: 'function', v: decl });
        return { kind: 'void' };
      }) };
    }
    case 'arrow': { const params = stmt.params, body = stmt.body;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => ({
        kind: 'function',
        v: { name: '<anonymous>', params, body, closure: frame.scope },
      })) };
    }
    case 'method':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => { registerMethod(stmt); return { kind: 'void' }; }) };
    case 'typedecl':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => { registerType(stmt); return { kind: 'void' }; }) };
    case 'field':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => ({ kind: 'void' })) };
    case 'import': { const msg = `import '${stmt.ns}.${stmt.name}' ignored (libraries not supported)`;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => { warn(run, frame.ctx, msg); return { kind: 'void' }; }) };
    }
    case 'export':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalExpr(stmt.decl, frame)) };
```

- [x] **Step 2: corpus green + measure** — ledger.
- [x] **Step 3: Commit** — `perf: compile decl/misc stmts (assign/typed/tuple/reassign/seq/func/…)`

---

### Task 4: `var` two-phase + `if`/`ifexpr` compiled arms

**Blocked by:** Task 3.

**Files:** same two files.

**Done when:**
- `var x = f()` side-effect-count test pins init at exactly 1 call per (node × callsite).
- `var` inside top-level `if` arm still interprets via `evalBlock` — parity on `if`-guarded `var` corpus row.
- `if/elseif/else` + `ifexpr` corpus rows pass; `plot` inside compiled `if` arm still warns CE10188 exactly once (scopeDepth bookkeeping lives in `evalBlock` — the corpus includes `if cond \n plot(x)` and asserts warning parity).

- [x] **Step 1: cases**

```ts
    case 'var': {
      const items = stmt.multi && stmt.multi.length > 0 ? stmt.multi : [stmt];
      if (!stmt.multi || stmt.multi.length === 0) {
        // single-name var/varip → twoPhase
        const it = items[0]!;
        const init = compileChild(it.value);
        const name = it.name;
        const isFresh = (run: RunState) => !run.declSlots.has(siteKey(run, it));
        const fresh: Compiled = wrapCompiled(stmt, (frame, run) => {
          if (stmt.varip) warn(run, frame.ctx, `varip treated as var (realtime-bar persistence not implemented)`);
          const v = init(frame, run);
          bindDeclared(run, siteKey(run, it), frame.scope, name, v, frame.ctx.barIndex, /*persistent*/ true);
          return v.kind === 'series' ? v.v.cur() : v;
        });
        const later: Compiled = wrapCompiled(stmt, (frame, run) => {
          const s = run.declSlots.get(siteKey(run, it))!;
          frame.scope.define(name, s);
          return valueAt(s, frame.ctx.barIndex);
        });
        return { kind: 'twoPhase', isFresh, fresh, later };
      }
      // multi-item: verbatim per-item dispatch (freshness is per item).
      const inits = items.map(it => compileChild(it.value));
      const varip = !!stmt.varip;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const scope = frame.scope, bar = frame.ctx.barIndex;
        if (varip) warn(run, frame.ctx, `varip treated as var (realtime-bar persistence not implemented)`);
        let last: Value = NA;
        items.forEach((it, i) => {
          const dk = siteKey(run, it);
          const fresh = !run.declSlots.has(dk);
          if (fresh) {
            const v = inits[i]!(frame, run);
            bindDeclared(run, dk, scope, it.name, v, bar, /*persistent*/ true);
            last = v.kind === 'series' ? v.v.cur() : v;
          } else {
            const s = run.declSlots.get(dk)!;
            scope.define(it.name, s);
            last = valueAt(s, bar);
          }
        });
        return last;
      }) };
    }
    case 'if': case 'ifexpr': {
      const test = compileChild(stmt.test);
      const elseIfs = stmt.elseIfs.map(e => ({ test: compileChild(e.test), body: e.body }));
      const thenB = stmt.then, elseB = stmt.else;
      const isExpr = stmt.type === 'ifexpr';
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        let branch: Node[] | null = null;
        if (unseriesTruth(test(frame, run))) {
          branch = thenB;
        } else {
          for (const e of elseIfs) {
            if (unseriesTruth(e.test(frame, run))) { branch = e.body; break; }
          }
          if (branch === null) branch = elseB;
        }
        if (branch === null) return isExpr ? NA : { kind: 'void' };
        return evalBlock(branch, blockFrame(frame)); // verbatim: fresh child scope + scopeDepth/topLevelBody bookkeeping
      }) };
    }
```

- [x] **Step 2: corpus green + measure** — ledger.
- [x] **Step 3: Commit** — `perf: compile var two-phase + if/ifexpr arms`

---

### Task 5: Coverage audit + fallback confirmation

**Blocked by:** Tasks 2-4.

**Files:** `src/pine/interpreter.ts`, `compile.test.ts`.

**Done when:**
- `grep -n "case '"` in `compile()` covers every kind in the fallback table; every unlisted kind lands on `default → fallback`.
- A diagnostic counter (`__compiledKinds: Map<string,'direct'|'twoPhase'|'fallback'>` for tests) shows 見高K4.55's body compiles ≥90% `direct`+`twoPhase` (run once via `_prof_high.mjs` variant or a test that parses the real script file if available in test context — else log from the bench script).
- `for`/`while`/`switch`/`indicator`/`strategy` confirmed `fallback` with a comment citing the exception-semantics reason.

- [x] **Step 1: add kind-coverage instrumentation + audit test.**
- [x] **Step 2: corpus green.**
- [x] **Step 3: Commit** — `test: compiled-kind coverage audit`

---

### Task 6: Default-on flip + measurement + rollback verification

**Blocked by:** Tasks 1-5.

**Files:** `src/pine/interpreter.ts` (`compiledEnabled`), this plan's Review Ledger.

**Done when:**
- `compiledEnabled` returns `true` by default (opt-out via `__pineInterp`/`PINE_INTERP=1` only).
- `npx vitest run src/pine/__tests__/` — 597+new all green.
- `npx vite-node scratch/_prof_high.mjs`: record 見高K4.55 + 高量1.46 wall before/after in the ledger; target ≥20% wall reduction on 見高K4.55 synthetic (500 bars), evalNode/evalExpr self-time out of top-5.
- Real-browser re-measure: reload 見高K4.55 in the Chromium tab on the same data path that produced 13.77s; record `runIndicator` wall. Record number in ledger (expect roughly proportional drop of the interpreter share; NOT a hard gate since browser env differs).
- Rollback drill: `window.__pineInterp = true` + re-run → interpreted numbers return (proving the flag reaches the bar loop); document in ledger.

- [x] **Step 1: flip `compiledEnabled` default; run full suite.**
- [x] **Step 2: vite-node measure + ledger entry.**
- [x] **Step 3: browser re-measure + ledger entry.**
- [x] **Step 4: rollback drill + ledger entry.**
- [x] **Step 5: Commit** — `perf: enable compile-to-closures by default (opt-out __pineInterp / PINE_INTERP=1)`

---

## Rollback

- **Instant:** `globalThis.__pineInterp = true` (browser console before indicator run) or `PINE_INTERP=1` (node/vite-node). Compiled table is never built when the flag is off — zero overhead, zero risk surface.
- **Surgical:** each task is a separate `perf:` commit; revert Task 6 to return to all-fallback dispatch while keeping harness + closures for debugging.
- **Full:** `git revert` the task chain; `evalNode`/`evalExpr` are never modified in place — the interpreted path is intact throughout.
- **Known-risk ordering if a parity bug escapes:** `if`/`ifexpr` (Task 4) and `var` two-phase (Task 4) are the only closures containing control-flow logic; `call`/`histref`/`reassign` delegate verbatim so they carry near-zero semantic risk — suspect compiled-child `binary`/`ternary` short-circuit and `tuple` keys-map handling first.
