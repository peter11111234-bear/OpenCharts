# T8a feasibility dossier — can `simulate()` become a resumable stepper so `simAt`'s cache goes Θ(B²) → O(B)?

Read-only pass, 2026-10-15. No `src/**` touched.

## 0. Tree fingerprint at read time
- **md5 NOT captured**: this sandbox exposes only `read`/`grep`/`glob`/`web_search`/`write` — **no shell**, so `md5sum`/`wc` are unavailable. Fingerprint below is line-count based; re-verify md5 before applying.
- `src/pine/builtins/strategy.ts` = **1782 lines** (the file under study; the working tree is being edited by another agent — `ta.ts` at `196c04d1…`).
- `src/pine/interpreter.ts` = **3963 lines**.
- `src/pine/builtins/strategyEquity.ts` = **122 lines** ← **second `simulate()` caller, see §4.0**.
- Docs read: `docs/2026-10-15-t8-replay-attribution.md`, `docs/2026-10-15-r5-patch-design-notes.md` §6/§6.1, `docs/2026-10-15-r5-fix-plan.md` §P2.

**Verdict: feasible, single-file, and the checkpoint surface needs no `interpreter.ts` change — BUT only if the second caller (`strategyEquity.ts`) is resolved (§4.0). That is the one non-obvious blocker.**

---

## 1. `simulate()` — inputs and mutated shared state (line anchors)

Signature: `simulate(ctx, orders, cfg, uptoBar): Sim` — `strategy.ts:295` (body 295–870).

### Inputs
| Input | Site | Notes |
|---|---|---|
| `ctx` | :295 | OHLC/time series only (`openAt/closeAt/highAt/lowAt/timeAt`, :268-273); `syminfo.mintick` (:256), `pointvalue` (:265), `tzOf` (:500). |
| `orders: StratOrder[]` | :295 | the shared ledger `ctx.state['strategy|orders']` (`ORDERS_KEY`, :214). **Mutated in place** (scratch, see below). |
| `cfg: StratCfg` | :295 | read-only (`cfgOf(ctx)` = `ctx.state['strategy|cfg']`, :249). |
| `uptoBar` | :295 | replay horizon; clamped in `advancePending` (:323) and `riskWalk` (:628). |

### Mutations to **shared** (outlives one call) state
| Target | Reset on entry | Written | Read |
|---|---|---|---|
| `orders[].seen` | :302 | :334, :337 (`advancePending`), :430, :435 (`fillCandidate`), :452, :458, :463, :464, :470, :476, :478, :480 | :326, :339, :447 |
| `orders[].cancelledAt` | :302 | :468 (cancel), :575 (`trigger`), :859, :865 (OCA cancel/reduce) | :327, :339, :465 |
| `orders[].fillQty` / `fillPrice` | :303 | :438-439 (and trail :~393-397) | :330, :339 |
| `orders[].trailPeak` | :302 | :349-352 (trail arm/extreme) | :350, :353 |
| `orders[].mod` | :303 | :476 (duplicate-id modify), :867 (OCA reduce) | :377-378 (`fillCandidate` limit/stop), :861 |
| `o.ocaName/ocaType` | never | read-only | :857-858 |

### Mutations to **local** (per-call) state → these are exactly the future cursor
| State | Decl | Written |
|---|---|---|
| `sim: Sim` | :296 | throughout `applyFill` :758-853, `flattenAt` :563, `marginCall` :604 |
| `pending: StratOrder[]` | :305 | splice :340, push :481 |
| `i` (order scan cursor) | :309 | :451 |
| `rules: ActiveRules` | :311 | `applyRisk` :508-518 |
| `riskBar, haltBar, sessionHaltDay, day, dayStartEquity, dayPeak, peakEquity, consLoss` | :312-319 | `riskWalk` :635-698, trigger :577-578 |
| `fillsByDay: Map` | :324 | :331 |

### Immutable / derived (do NOT need to persist)
`n`, `tick` (:300), `pointValue` (:325) are re-derived from `ctx` each call.

---

## 2. Cursor state needed to resume bar k → k+1

The body is **already written around monotonic cursors** — the only thing that makes it restart-from-0 is the **reset block at :301-304** plus fresh locals at :296-325. To resume, persist exactly:

1. `sim` (live accumulator — mutated, never re-derived).
2. `pending` — plus **each pending order's own cursor**: `seen`, `cancelledAt`, `mod`, `trailPeak`, `fillQty`, `fillPrice` (today these live on the order object).
3. `i` — next unprocessed order index.
4. `rules`.
5. Risk cursor: `riskBar, haltBar, sessionHaltDay, day, dayStartEquity, dayPeak, peakEquity, consLoss, fillsByDay`.
6. `last` — highest bar already advanced to (new; not in current code).

**`advancePending` / `riskWalk` are already incremental** — both iterate `from o.seen+1` (:326) / `from riskBar+1` (:636) to `lim`, and advance their own cursor. So calling `advancePending(k)`/`riskWalk(k)` then later `advancePending(k+1)`/`riskWalk(k+1)` reproduces one full replay exactly. The per-event calls at :454-455 (`advancePending(o.bar); riskWalk(o.bar)`) are idempotent given those cursors. **OCA `pending` is not special**: it only touches `p.cancelledAt`/`p.mod` on live pending siblings (:855-870), i.e. the same per-order cursor — persisting per-order cursor covers it.

**One required change vs. today**: the event loop's future-order guard `if (o.bar > uptoBar) { o.seen = o.bar; continue; }` (:452) *permanently drops* that order because the current code returns afterwards. A stepper must **`break` without setting `seen`**, leaving `i` at that index so the next advance revisits it. (Today `o.bar > uptoBar` is unreachable in practice — every `simAt` callsite passes `uptoBar = ctx.barIndex` and orders are appended with `bar = ctx.barIndex` (:942, :1100) — but the stepper must be robust to it.)

---

## 3. Current `o.seen` semantics — NOT re-run idempotence

- `seen` is **reset to −1 at the top of every `simulate` call** (:301-304). So it does **not** make a re-run cheap or idempotent — it exists only to make **one** invocation deterministic (its own doc comment at :292-294: "scratch fields on orders are rewritten each call, so results do not depend on call order").
- Cross-call idempotence (repeated reads at the same bar) is provided **only** by the `byBar` memo keyed on `orders.length` (`simAt` :886-889) — and that memo is wholly discarded on every new order (`cache.count !== orders.length`), which is the Θ(B²) root cause (confirmed by `t8-replay-attribution.md` §0/§2: steps exactly B(B−1)/2).
- So the doc §6.1 line "`seen` 目前只讓 replay 具冪性" is precisely correct: it is **intra-call** only.

---

## 4. Minimal refactor shape

### 4.0 BLOCKER FIRST: the second caller — `strategyEquity.ts:55`
`strategyEquity.ts` calls the engine **directly, not via `simAt`**:
```ts
// strategyEquity.ts:34-58
function shifted(ctx, b) { ... return { ...ctx, open: s(ctx.open), ... } }   // shifts Series by (barIndex-b)
function equityAt(ctx, orders, b) { const sc = shifted(ctx, b); const sim = simulate(sc, orders, cfg, b); ... }
function equityCurve(ctx) { for (let b = cache.equity.length; b <= bar; b++) equityAt(ctx, orders, b); ... }
```
It replays **at every past bar `b ≤ barIndex`** on purpose (historical equity for `strategy.max_drawdown`/`max_runup`, registered lazily). Consequences:
1. **`simulate` must remain callable as a fresh from-scratch replay at an arbitrary past `uptoBar`** — a stepper keyed to `ctx.barIndex` cannot serve `b < last`.
2. **Scratch-sharing hazard**: `simulate` resets `o.seen`/`o.mod`/… (:301-304). If the stepper keeps its cursor in the *same* order-object fields, any `max_drawdown` read in a bar (which calls `equityCurve → simulate`) **wipes the stepper's cursors** and vice-versa. Within one bar both lazy constants can be read in either order → guaranteed corruption.
3. `equityCurve` is itself Θ(B²) (one from-scratch `simulate(b)` per bar, plus a full re-replay whenever `orders.length` changes) — a second, unmeasured quadratic term.

**Therefore the shape must do one of:**
- **(Recommended) Unify on the stepper and delete the second replay**: have the stepper record `equity[b]` (and the dd/runup rollups) as it advances — `sim` already holds `realizedPnl/qty/avgEntry` and `riskWalk` already computes `equityNow(b)` (:662). `equityCurve` then reads the ctl's per-bar equity instead of calling `shifted`+`simulate`. This removes the hazard **and** the second Θ(B²). Cost: touches `strategyEquity.ts` (a second file) and must reproduce `equityAt` numbers bit-for-bit (same engine ⇒ same numbers; verify with the strategy tests).
- **(Fallback) Keep `simulate` pure and give the stepper its own scratch namespace**: move `seen/cancelledAt/mod/trailPeak/fillQty/fillPrice` **off the order objects** into ctl-owned per-pending records, so the pure replay (writing order scratch) can never clobber the stepper. This is more mechanical churn (~40 read/write sites) and adds one small record per pending order.

Do **not** skip this decision: leaving both on shared order scratch is incorrect.

### 4.1 Proposed `SimCtl` (stepper) — sketch
```ts
// replaces `SimCache { count, byBar }` at strategy.ts:879
interface SimCtl {
  last: number;                 // highest bar advanced (-1 none)
  sim: Sim;                     // live accumulator (4.0-recommended also: equity: number[])
  pending: StratOrder[];        // own cursor entries (or PendingEnt[] under the fallback)
  i: number;
  rules: ActiveRules;
  riskBar: number; haltBar: number; sessionHaltDay: number;
  day: number; dayStartEquity: number; dayPeak: number; peakEquity: number; consLoss: number;
  fillsByDay: Map<number, number>;
  // per-order cursor (seen/cancelledAt/mod/…) — on orders today, or moved here
}

/** Resume from ctl.last+1 .. k (idempotent when k === last). */
function advanceBar(ctx, orders, cfg, ctl, k) {
  // same body as simulate :327-484, but: no reset block; ctl.i/ctl.pending/ctl.rules/...
  // and `if (o.bar > k) break;` (NOT mark-seen) at the old :452 guard.
  // then: advancePending(k); riskWalk(k);
}

function simAt(ctx, uptoBar) {
  const st = stateOf(ctx); if (!st) return emptySim();
  const orders = st.get(ORDERS_KEY); if (!orders?.length) return emptySim();
  let ctl = st.get(CTL_KEY);
  if (!ctl) { ctl = newCtl(cfgOf(ctx)); st.set(CTL_KEY, ctl); }
  if (uptoBar < ctl.last) return simulate(ctx, orders, cfgOf(ctx), uptoBar); // rare fallback (4.0 fallback path)
  advanceBar(ctx, orders, cfgOf(ctx), ctl, uptoBar);
  return ctl.sim;
}
```
`advanceBar(k)` when `k === ctl.last` is a cheap no-op scan (no new events; `advancePending`/`riskWalk` already at `k`). This is what makes **repeated same-bar reads free** — no `byBar` Map needed; a single live `sim` + `last` replaces it.

Total work becomes **one pass** = O(B + Σ live-pending-days) (each order processed once, each pending order touched once per bar it lives) instead of B(B−1)/2.

### 4.2 Why the O(B) claim holds (soundness of prefix reuse)
- Orders are **append-only, chronologically by `bar`** (`pushOrder` :942 sets `bar = ctx.barIndex`; `pushRisk` :1100 same). So an order added while at bar k has `bar ≥ k`.
- An invocation of `simulate(uptoBar=k)` never lets an order with `bar > k` affect the result: the event loop drops them (:452) and `advancePending`/`riskWalk` clamp to `k` (:323, :628). ⇒ **state at bar k is a function of orders with `bar ≤ k` only** ⇒ appending later orders cannot change it ⇒ prefix reuse is sound.
- All `simAt` callsites pass `uptoBar = ctx.barIndex` (verified: strategy.ts :1164,1170,1178,1186,1193,1198,1209,1221,1237,1285,1341,1367,1395,1396…; `execsAt` :896), and `barIndex` is monotonic non-decreasing within a session (`BarCtx.seek` is forward-only — asserted in `series.test.ts:259-262`). The engine's `ctx.state` (hence `ctl`) is fresh per `runScript` session; incremental rollback moves `barIndex` only *back to the same committed bar*, i.e. `ctl.last` rollback is handled by checkpoint restore (§6), not by an in-place decrease.
- The one intra-bar growth case is handled: a script may read `strategy.position_size` (advance to k), then call `strategy.entry` (append order with `bar = k`), then read again — `advanceBar(k)` re-scans from `ctl.i` and picks up the new order. **`strategy.test.ts:376-378` exercises exactly this** (entry at bar 0 → `seek(2)` → `close(immediately=true)` → same-bar read must see the close).

---

## 5. Proof obligations (what must hold) and the tests that guard them

| # | Invariant | Guarded by |
|---|---|---|
| I1 | State at bar k is independent of orders with `bar > k` (prefix-reuse soundness, §4.2) | full-run vs incremental parity — `inc-parity.test.ts` (`expectSame`); digest equality on 4 scripts |
| I2 | `advanceBar(k)` output ≡ `simulate(uptoBar=k)` for every k, including `k = ctl.last` re-entry | `strategy.test.ts` + `strategy_equity.test.ts` (per-bar `seek` sequences, exact numbers), golden files |
| I3 | Re-entry at the same bar after an order append is processed (`ctl.i` rescan) | `strategy.test.ts:376-378` (immediate close) |
| I4 | No caller retains a `Sim`/`.execs`/`.closed`/`.openLegs` reference across an advance (single live `sim` aliases) | `assembleRunResult` (:3178 `execs: execsAt(...)`) consumes immediately; **must confirm no other holder** — otherwise return a shallow copy of `execs`/`closed`/`openLegs` |
| I5 | `advancePending`/`riskWalk` idempotence at equal `limit` | replay parity; risk tests (`strategy_equity.test.ts` dd/runup) |
| I6 | Checkpoint rollback restores cursor exactly (incl. per-order scratch) | `inc-parity.test.ts` (tick parity, forming-bar rollback, 24 random ticks) |
| I7 | Future-order guard no longer permanently drops (:452 → `break`) | new targeted test: append-order-during-formed-bar case |
| I8 | If §4.0-recommended: ctl equity[b] ≡ `strategyEquity.equityAt(b)` numbers | `strategy_equity.test.ts` (max_drawdown/runup exact values) |

**Gate (per `r5-fix-plan.md` P2):** `replaySteps` B(B−1)/2 → O(B) with bars 100/200/500; four digests `ze7byn`/`kb0glc`/`p4gddl`/`1580h2` byte-identical; `s1-inc-probe` parity 6/6; golden 0; `vitest run src/pine` 954 passed/1 skipped; `tsc --noEmit` 0.
**Stop-loss:** any digest/parity drift ⇒ revert, ship the attribution only.

---

## 6. Does it overflow to `interpreter.ts`? → **No, if the ctl stays a plain object.**

`strategy|simCache` is a leaf of `ctx.state`, deep-cloned by the checkpoint walker:
- `snapCtxState` (`interpreter.ts:3330-3379`) classifies each `ctx.state` leaf: Map→`nummaps`/`maps`, **array→`arrays`** (:3359), **plain object (`proto === Object.prototype`)→`plains`** (:3369), or **VS-like (`typeof v.get === 'function' && 'last' in v`)→`vs` + `snap()`/`restore()`** (:3363-3366). Class instances with other protos are **passed through untouched** (:3372-3374) — i.e. **not restored**.
- `restoreCtxState` (:3382-3400): `vs` → restore `last`, prune `memo > bar`, call `e.restore(snap)`; `arrays` → **truncate + re-`cloneDeep` each element** (:3389-3391); `plains` → delete keys + `Object.assign(cloneDeep(fields))`.

Consequences for the refactor:
- The current `SimCache` (`{count, byBar: Map}`) is a **plain object ⇒ `plains`**, so a plain-object `SimCtl` (all fields plain data/arrays/Maps) is **restored with zero `interpreter.ts` changes**.
- The only trap: **`arrays` restore replaces every order element with a fresh clone** (:3389-3391). If `SimCtl.pending` holds `StratOrder` references, they must be reconciled to the clones. This works **iff** the ctl and the orders array are snapshotted in the **same pass sharing the `ids` map** — they are (`snapCtxState(ctx.state, ids)` at :3483; `restoreCtxState(..., ids)` at :3592): `arrays` clones orders first (registering them in `ids`), then `plains` clones the ctl's fields, whose `pending` refs hit `ids` → same cloned objects. **Verify this ordering holds** when implementing.
- **Do not make `SimCtl` a class instance** — `cloneDeep`'s final branch (:3454-3456) passes it through and `snapCtxState` never records it ⇒ silent rollback loss.
- `strategy|orders` is an `arrays` leaf (already), `strategy|cfg` a `plains` leaf — unchanged.
- The interpreter's own doc comment at **:3237-3240** asserting `simulate` is "a pure function of (orders, bars, cfg, uptoBar)" is **already false** (it mutates order scratch) and **will need updating** when the stepper lands — a docs touch in `interpreter.ts`, not a logic change.

---

## 7. Risk estimate

| Risk | Severity | Mitigation |
|---|---|---|
| Second caller `strategyEquity.simulate(shiftedCtx, b<barIndex)` + shared order scratch (§4.0) | **High — correctness blocker** | unify on ctl equity (recommended) or move scratch off orders |
| `plains`/`arrays` restore ref reconciliation for `pending` (§6) | Medium | same-pass `ids` guarantee; add a probe/test |
| Single-live-`sim` aliasing (I4, `execs` held by engine) | Medium | confirm no cross-advance retention, else shallow-copy on read |
| Per-order scratch semantics when moved off-order (§4.0 fallback) | Medium | mechanical but ~40 sites; heavy re-verify |
| Algorithmic: total work may stay O(Σ live-pending-days) if many long-lived pending orders | Low | still one pass; bounded by touches, same as a single replay |
| Tree is being edited concurrently (`ta.ts` md5 moving) | Low | re-verify md5 before patch |

**Estimated shape:** one function split (`simulate` → `newCtl` + `advanceBar`), a new `SimCtl` interface, `simAt` rewrite (~:879-891), the :452 guard fix, and — recommended — a small `strategyEquity.ts` rewire. Single-file if the §4.0 **fallback** is taken (scratch moved off orders) with `strategyEquity` left calling the pure replay; two files if the **recommended** unification is taken.
