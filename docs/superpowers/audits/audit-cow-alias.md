# CowSeries alias write-through audit — cbb3e40 + uncommitted `evalReassign` ctx guard

Scope: `src/pine/interpreter.ts` (CowSeries ~L216, `bindDeclared` ~L463, `evalReassign` ~L1370, var rebinds L617/L1785/L1806, tuple L633/L1707), `src/pine/series.ts`, `src/pine/mtf.ts` (CowSeries ~L1089, SecSeries ~L873).

## Findings

### F1 — `:=` writes on non-`var` alias decls are invisible to `x[1]` next bar (P1, silent data corruption)

`bindDeclared` (`interpreter.ts:478-485`) only persists the cow for `persistent` (`var`) decls. A plain decl re-binds a **fresh** `CowSeries(v.v)` each bar, so the materialized `:=` copy from the previous bar is discarded. Reads then delegate to `v.v` (e.g. `ctx.close`); `x[1]` sees `close[1]`, not the written value. In Pine a reassigned variable is a persistent slot — `x[1]` must see last bar's `:=` value.

Repro (runnable Pine):
```pine
x = close
x := 999
plot(x[1])
```
Bar 0: cow materializes copy of close, writes 999 at bar 0. Bar 1: `bindDeclared` binds a new `CowSeries(ctx.close)` — reads `close[1]` = close(0). Expected `x[1] == 999`; actual `x[1] == close(0)`. Same for `x = input.source(close); x := …` and branch-local `if cond\n    y = close\n    y := 5` (cow is per-execution, dropped at block exit).

Fix direction: persist the cow in `declCows` for alias decls generally (rebind inner each bar; keep the materialized copy so `:=` history accumulates), not only for `var`.

### F2 — Mixed-kind same-site decl writes into the shared raw slot (P1, `ctx.close` corruption)

`bindDeclared` stores the **raw** `v.v` into `declSlots` (`interpreter.ts:477`). On a later execution of the same site where the value is a scalar, `slotFor` (`interpreter.ts:443-453`) returns `declSlots.get(key)` — the shared `ctx.close`/`LitSeries`/tf-frame slot — and `bindDeclared` then calls `s.setAt(bar, v)` (`interpreter.ts:489`), writing the scalar straight into the shared caller slot. The comment at L473 justifies raw-slot storage by noting `SecSeries.setAt` warns+no-ops — but `ctx.*`, `LitSeries`, `LiftedSeries`, plain shared `BarSeries`, and tf-frame `spec.series.*` all accept the write.

Repro:
```pine
x = barstate.isfirst ? close : 1
plot(close)   // corrupted: close == 1 on all bars >= 1
```
Bar 0 binds `x → CowSeries(ctx.close)`, `declSlots[key] = ctx.close`. Bar 1: scalar branch → `ctx.close.setAt(1, 1)` — closes for bar 1+ all become 1 for every reader (other decls, `ta.sma(close)`, `plot(close)`, `close[1]`). Expected: `x` scalar 1, `close` untouched.

Same mechanism: `var x` never re-runs init so it's safe; the hole needs a non-var decl whose init expression flips kind across bars (`cond ? series : scalar`, `na` early bars).

Fix direction: keep a separate "shared alias target" marker — e.g. store `v.v` in `declSlots` but have `slotFor`/`bindDeclared` route scalar writes to a *fresh* `BarSeries` when the stored slot isn't one this decl owns (identity tag, or store `{slot, owned}` / a sentinel non-writable wrapper in `declSlots`).

### F3 — `:=` on an alias bound to `SecSeries` loses all history (P2)

`CowSeries.writable` (`interpreter.ts:244-249`; identical in `mtf.ts:1105-1111`) computes `base = src instanceof BarSeries ? src.currentBar : …`. `SecSeries extends BarSeries` but never writes its buffer — `lastBar === -1` — so `base = -1`, the copy loop `for (b=0; b<=-1; …)` produces an **empty** BarSeries, and `setAt(bar, v)` writes only the current bar.

Repro:
```pine
s = request.security(syminfo.tickerid, "D", close)
s := s + 1
plot(s[1])
```
Expected `s[1]` = previous chart bar's mapped security value (the copy should contain the full mapped history `size() = j+1` entries). Actual: copy is empty; `s[1]` = na. Bounded to aliases of `SecSeries` (and any BarSeries subclass with unwritten `lastBar`), so P2.

Fix direction: `writable` should fall back to `src.size()` when `currentBar < 0`, same as the non-BarSeries branch.

### F4 — Tuple destructured series elements bypass the cow entirely; `a[1]` reads live values (P2, pre-existing but same feature surface)

`tuple` decls bind elements via `slotFor(...).setAt(bar, items[i])` (`interpreter.ts:672-675`, compiled mirror `:1729`) — never `bindDeclared` — storing the raw `{kind:'series'}` Value inside an element BarSeries. Consequences:

- `a := 999` writes `a`'s own slot (no write-through — OK).
- But `a[1]` returns the stored series Value's **current** value, not the previous bar's: `histGetAt` on `a`'s slot returns `{kind:'series', v: ctx.close}` from bar 0's buffer; `unseries`/`histGetAt(v.v,…)` then resolves `cur()`, i.e. *today's* close. Silent wrong history for `[a,b] = [close, 1]` and `var` tuples.

Repro:
```pine
[a, b] = [close, 1]
plot(a[1])   // expected close[1]; actual close (current bar)
```

### F5 — `seed()` can retro-write below the copied base (P3, bounded)

`paramCows` `cow.seed(a.v.cur(), bar)` (`interpreter.ts:1316`) writes into the materialized cow at `bar`. If the first `:=` happened when the caller's inner had a *larger* `currentBar` than a later call's `bar` (out-of-order `evalAt` calls inside `request.security` replay at tf-bar indexes), `seed` retro-writes history — `x[1]` same-bar then sees the seeded value instead of the carried `:=` value. Narrow; relies on the tolerated retro-write path in `BarSeries.setAt`.

## Non-issues checked

- `evalReassign` ctx identity check (`interpreter.ts:1382-1389`) — catches tf-frame shadows since `spec.series.close` is the same object the tf ctx exposes; UDF param CowSeries pass through correctly (`slot instanceof BarSeries` → `setAt` → `writable`).
- `var` rebind via `declCows.get(dk) ?? declSlots.get(dk)` (L625/L1787/L1808) — correct: cow carries the `:=` copy; `valueAt` reads the cow's copy when materialized, else the inner's carried history.
- `trackSeries(run, v.v)` on the alias target — safe (deduped; ensures `LitSeries`/`LiftedSeries` carry-forward densify).
- `freezeReader` on a CowSeries — `readTarget()` unwraps to inner (≤8 hops); per-bar lifted kernels re-freeze each call, so no staleness across bars.
- `CowSeries.ensureBar` — never in `ensureList` (only raw slot is tracked); delegation to inner is harmless.
- `paramCows` rebind+seed across bars — verified `x := x+1` accumulates correctly (seed re-points current bar, history stays on the cow).
- mtf `CowSeries` in `invokeUdf` — per-call, no seed needed; `writable` F3 bug is shared.

## Suggested fixes

1. F1: persist cow for all alias decls (`run.declCows` keyed by decl site, rebind inner per execution — the existing `rebind()` already supports it).
2. F2: in `bindDeclared`/`slotFor`, don't let scalar writes land on a `declSlots` entry that is a foreign/shared series — tag the entry (`declAliases: Set<object>`) and substitute a fresh owned `BarSeries` on kind flip.
3. F3: `writable`: derive base from `src.size()` when `currentBar < 0` (`SecSeries` reports `j+1`).
