# Audit: `:=` read-only builtin check (`evalReassign`, interpreter.ts ~L1378-1386)

Scope: paths reaching a builtin's mutable write (`setAt`/`set`) bypassing the new ident check; false positives; the `slot instanceof Series` path; tf-domain `ctx` inside `evalAt`/security.

## Summary

The ident check itself is correct and complete for its narrow target: `scope.lookup(t.name)` returns the builtin series only when the name resolves to `ctx.{open…hlcc4}` — exactly the top-scope binding (runScriptInner L1990-1997) or a tf-frame builtin (mtf.ts L1012-1013), both identity-compared against `frame.ctx`. All shadowing paths (UDF params → CowSeries, `var`/plain decls → CowSeries or fresh BarSeries, for-loop vars → per-iteration BarSeries, block redecls → own slot) bind a *different* object, so no false positives.

**One real hole found** (outside `:=`, same invariant): `bindDeclared`'s raw-slot reuse lets a scalar decl write into a shared builtin series. Verified end-to-end.

## Findings

### F1 — P1: mixed-kind decl writes scalars into `ctx.close` via `declSlots`/`slotFor` raw-slot reuse

Where: `src/pine/interpreter.ts` — `bindDeclared` L462-490: series path does `run.declSlots.set(key, v.v)` (raw object, L477); scalar path falls to `slotFor(...)` which returns `run.declSlots.get(key)` unchanged (L442-452) and then `s.setAt(bar, v)` (L489) writes **into the previously-bound series object**.

Why it hits builtins: builtins that return a builtin series verbatim — `input.source(close)` (`builtins/input.ts` L193-211: `defval` is `{kind:'series',v:ctx.close}` returned as-is) and generic `input(close)` (L215-235: `raw0` returned verbatim when it is a named source) — hand `ctx.close` itself to `declSlots`. On a later bar where the decl evaluates to a scalar, `s.setAt(bar, scalar)` mutates `ctx.close`'s ring buffer. It also `scope.define('x', ctx.close)` so `x[1]` afterwards aliases builtin history.

Repro (verified):
AST — `x = bar_index == 0 ? input.source(close) : 777`, `plot(close)`, `plot(x)`, 4 bars close=1..4:
- expected: close `[1,2,3,4]`, x `[1,777,777,777]`
- actual: close `[1,777,777,777]` (corrupted), x `[1,777,777,777]`

Equivalent Pine:
    indicator("t")
    x = bar_index == 0 ? input.source(close) : 777
    plot(close)  // prints 777 on bars >= 1

Same hole via `x = bar_index == 0 ? input(close) : 777`.

Fix direction: `slotFor` should not reuse a `declSlots` entry it doesn't own for scalar writes — when `declSlots.get(key)` is a foreign/shared series (came from the series-bind path), allocate a fresh BarSeries, or mark whether the entry is an owned decl slot vs an aliased external series.

### F2 — P3: `else if (slot instanceof Series) { slot.set(v) }` at interpreter.ts L1383-1384 is effectively unreachable / misaligned if reached

`set(v)` pushes `lastBar+1` (Series contract), not `setAt(barIndex)` — it would misalign history for any non-BarSeries Series bound under a name. All in-tree Series impls extend `BarSeries` (CowSeries, LitSeries, LiftedSeries, SecSeries, TfVarSeries, TfGlobalSeries), so the branch is dead today — a trap if a bare `Series` ever lands in scope.

### F3 — latent (same class as F1): raw-slot scalar writes silently corrupt ANY shared series object

If a builtin ever returns a shared series (callHist slot, memoized result), a mixed-kind decl's scalar branch writes into it. SecSeries/TfVarSeries/TfGlobalSeries are protected (setAt warn+drop) — scalar writes landing on them produce spurious warnings in tf frames, marginal.

## Checked and clear

- UDF param named `close`/`volume`/`hl2`/etc.: `callUdfValue` binds CowSeries (callsite-keyed `paramCows`, rebind+seed each bar) or fresh CowSeries via `ctx.callUdf`; `slot !== ctx.close` → writes materialize private copy. Verified: `f(close) => close := 7` → result `[7,7,7]`, real close `[1,2,3]`.
- `var x = <series>` rebind: `declCows` path; `x :=` writes into cow, never the raw. Verified.
- tf ctx inside `request.security`: `spec.ctx.close` is a spec-owned BarSeries; `close := x` in the security expr → identity check fires → PineRuntimeError → `computeAt` catches → warnOnce "request.security eval error … cannot reassign built-in variable 'close'" + NA.
- UDF bodies inside security: `invokeUdf` (mtf.ts L1157) binds fresh CowSeries; unbound builtin idents resolve via spec.scope → tf builtins → same error, caught.
- Member targets (`x.f :=`): obj is `unseries`ed → scalar for series bindings → `cannot assign field`; no series write path.
- Histref targets (`a[i] :=`): `unseries` yields scalar `cur()`; `close[0] := v` → `cannot write history/element on float` warn + NA.
- Tuple destructure, for-in/for-to loop vars: always fresh BarSeries via `slotFor`/`defineSeries`; `close` as a loop var shadows legally, `close :=` inside writes the loop-var slot.
- `close = e` redeclare: defines a shadowing decl slot (TV rejects redeclaring builtins; not a `:=` hole).
- Compiled path: `reassign` → `evalReassign` verbatim (L1736-1737); parity.
- `bar_index`, `syminfo`, `timeframe`, `barstate`, `last_bar_index`: not scope-bound Series → `:=` errors; consistent with TV read-only.
- `nz`/`fixnan`/`math.sum`/`ta.*`: return fresh LiftedSeries/BarSeries per call, never the arg verbatim → F1 only reachable via `input.source`/`input(close)` today.
