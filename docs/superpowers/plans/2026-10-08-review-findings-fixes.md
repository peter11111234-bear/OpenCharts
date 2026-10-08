# Review Findings Fix Plan — Pine Interpreter MTF Gate + Engine Bugs

> **日期：** 2026-10-08
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 10 confirmed findings from the 2026-10-08 code review of the MTF caller-agnostic cache gate (QA7–QA17 commits) and adjacent interpreter/engine bugs, in severity order, each with a regression test.

**Architecture:** Two-file blast radius per fix where possible. Gate fixes stay inside `exprSafeForAgnostic`/`freshInit` (src/pine/mtf.ts); interpreter semantic fixes stay in `bindDeclared`/`bindCallArgs` (src/pine/interpreter.ts); output fixes in `buildModel` (src/pine/engine.ts). Every fix keeps the gate's bias: **false-REJECT is acceptable (perf loss), false-PASS is a bug (wrong values)**.

**Tech Stack:** TypeScript, Vitest (`npx vitest run src/pine/__tests__/<file>`), custom tree-walk Pine v6 interpreter.

**Spec:** The review report findings (this document's "Finding" line per task). Bug discovery date: 2026-10-08.

**Spec invariant:** A gated (caller-agnostic) `request.security` expression must never produce a value that depends on which caller scope invoked it — every fix must close a false-PASS path or a confirmed wrong-output path without breaking `npx vitest run src/pine/__tests__/mtf.test.ts` (currently 64/64).

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same verify failing after 2+ distinct fix attempts. Single red test = normal TDD loop, not a blocker.

Never stop to ask what you can look up — file locations, signatures, test names: search first. Questions that don't change your next action: note them, keep going, report at task end.

**Plan-specific Nevers:**
- NEVER make a fresh-root `:=` pass when the root could hold caller/shared state — over-reject instead (the cache degrades to per-caller, still correct).
- NEVER mutate `run.declSlots`/`run.allSeries` iteration order — `ensureBar` cadence depends on registration order.
- NEVER let a `:=` on an aliased builtin series (`close`/`open`/…) reach the inner `BarSeries.setAt` — that is exactly finding F1.
- NEVER restore persisted `request.security` scripts at boot inside the synchronous `useEffect` — that is the original page-hang the strip block prevents (see D3).

## Global Constraints

- Tests: `npx vitest run src/pine/__tests__/<file>.test.ts` from `C:/Users/bear9/OpenCharts`; a run takes ~10–20 s.
- `runTransient` test harness lives in `src/pine/__tests__/mtf.test.ts` (~line 298); new gate tests go in the same `describe('caller-agnostic eval cache')` block and reuse `assign/security/call/ident/num/str/bin/arraylit` helpers and `__mtfStats` counters (`gatePass`, `gateFail`, `evals`, `agHits`, `hits`).
- A concurrent QA agent commits to `src/pine/mtf.ts` and `src/pine/interpreter.ts` from a parallel session — re-read the target region before each edit; anchors, not line numbers.
- Pine builtins register via `registerBuiltin(ns, name, fn)` in `src/pine/builtins/*.ts`; mutating collection methods are wrapped by the local `mut(...)` helper in `src/pine/builtins/array.ts`.

## Decision Points

### D1: How far freshness reaches into nested writes (T1)
- Consumed by: Task 5
- Candidates:
  - A (existing pattern): none found — no depth tracking exists in the gate
  - B (minimal): reject any `member`/`histref` `:=` target whose access chain from the root is longer than one hop (`t.f :=` / `a[i] :=` pass; `a[i].f :=`, `u[0][0] :=` reject). Freshness stays shallow; no new set.
  - C (preferred): deep/transitive freshness — track whether every element/field inserted into a fresh container is itself fresh (`u=[a]` fresh only if `a` fresh), then allow arbitrary depth.
- Criteria:
  - Implementation stays inside `freshInit` + the `reassign` case (≤40 lines)
  - Never false-PASSes `u = [sharedArr]; u[0][0] := 1`
  - No new Set/map threaded through walk
- Chosen: B
- Rejected: C fails "no new Set threaded" and is the larger change; the common Pine pattern (`local_array[i] := x`) still passes under B.
- Revisit trigger: a real script needs `a[i].f :=` on a fully-owned deep-fresh structure through the agnostic cache (observe `gateFail` regression complaints).
- Outcome: (filled during execution)

### D2: How to isolate `x = <series-returning-call>` from write-through (T2)
- Consumed by: Task 1
- Candidates:
  - A (existing pattern): `CowSeries` (src/pine/interpreter.ts:216) — already proven for UDF params: reads delegate, first write materializes a private BarSeries
  - B (minimal): copy-on-bind — always materialize a fresh `BarSeries` copy of the RHS history at decl time (no COW wrapper)
  - C (preferred): make `evalReassign` reject `:=` on aliased decls entirely (runtime error)
- Criteria:
  - `x = input.source(close); x := 999` leaves `close` untouched at the same bar and later bars
  - `x[1]` after a `:=` still sees the written value next bar (Pine local-series semantics)
  - Read-only aliases (`x = input.source(close)` with no `:=`) keep zero per-bar allocation
- Chosen: A
- Rejected: B fails criterion 3 (copies history every bar even when never written); C changes Pine semantics — `:=` on a normal decl is legal.
- Revisit trigger: CowSeries's `writable()` history copy proves too slow on 30k-bar inputs (profile `writable` in cpuprofile).
- Outcome: (filled during execution)

### D3: Persisted heavy-script strip at boot (T2) — Status: needs human confirmation
- Consumed by: Task 10
- Candidates:
  - A (existing pattern): keep unconditional strip (status quo — silently deletes user's MTF scripts every load)
  - B (minimal): gate the strip behind a one-time flag `vela-workspace-v2.strip-heavy-v1` — runs once, parked scripts are lost forever after that load
  - C (preferred): replace deletion with **park + deferred restore** — move `request.security` entries to `vela-workspace-v2.parked-pine` (not delete), then re-run them via `requestIdleCallback`/`setTimeout(0)` per chart after first paint so boot stays fast but user scripts survive
- Criteria:
  - A saved script containing `request.security` is never silently discarded
  - Boot path keeps zero synchronous `runScript` calls (the original TRIS hang stays dead)
  - No new public API or persisted-format schema break (new keys allowed)
- Chosen: C
- Rejected: A fails criterion 1 (it deletes every load); B fails criterion 1 for any heavy script saved after the migration flag fires.
- Revisit trigger: restoring parked scripts on idle measurably janks boot again → re-park with a user-visible "heavy script skipped" toast instead of auto-run.
- Outcome: (filled during execution)

### D4: Input-driven security args — where overrides resolve (T1)
- Consumed by: Task 4
- Candidates:
  - A (existing pattern): drop `input.*` names from `store.staticEnv` (mtf.ts:326-331) → their specs become DYNAMIC → prefetch-time `runConst(spec.symNode/tfNode, pfFrame)` evaluates `input.*` with `ctx.inputs` live (input.ts:104 reads `ctx.inputs[title|id]`)
  - B (minimal): keep staticEnv but key it `{name → {defval, title}}` and apply `ctx.inputs[title]` override in a new `constString` overload
  - C (preferred): leave staticEnv; wrap the spec lookup so callers pass `ctx.inputs` down to `prepareSecurity`
- Criteria:
  - `input.timeframe('60')` with a user override `'15'` fetches/evals at `'15'`
  - No signature change to `prepareSecurity(body, _frame0?)`
  - Prefetch still happens before the bar loop (no per-bar fetch)
- Chosen: A
- Rejected: B duplicates the override machinery that `evalHook(input.*)` already implements correctly; C fails criterion 2.
- Revisit trigger: `runConst` proves unable to eval `input.*` in pfFrame (returns null → spec stays dynamic → runtime path at mtf.ts:1676 still correct, just slower) — then implement B.
- Outcome: (filled during execution)

### D5: Mutating-namespace-call guard scope (T1)
- Consumed by: Task 7
- Candidates:
  - A (existing pattern): guard only `array.*` mutators actually registered: `push, unshift, pop, shift, set, insert, remove, fill, clear, reverse, sort` (all via `mut(` in array.ts:87-259)
  - B (minimal): hardcode a `{ns → Set<name>}` table covering `array` + `map` + `matrix` even though map/matrix have no builtins yet
  - C (preferred): derive mutators from the builtin registry (`BUILTINS` in registry.ts) — flag any `array.*` name registered through `mut(`
- Criteria:
  - `array.push(v, x)` where `v` is a var-bound or non-fresh ident → gate rejects
  - No dependency on unimplemented namespaces
  - Table is reviewable in one screenful
- Chosen: A
- Rejected: B violates criterion 2 (speculative coverage); C fails "reviewable" — `mut(` wrappers don't expose a runtime marker, so derivation needs source coupling worse than the table.
- Revisit trigger: `map.*`/`matrix.*` builtins land in `src/pine/builtins/` — extend the table in the same commit.
- Outcome: (filled during execution)

## Review Ledger

(starts empty — execution appends entries)

---

### Task 1: bindDeclared alias isolation (F1 — P0)

**Blocked by:** None — can start immediately.

**Files:**
- Modify: `src/pine/interpreter.ts` — `bindDeclared` (~line 439-458), `CowSeries` class (~line 216-280)
- Test: `src/pine/__tests__/_alias_repro.test.ts` (exists from review; rename into the suite conventions)

**Interfaces:**
- Consumes: `CowSeries` (class-local, must be promoted to module scope reuse), `run.declSlots: Map<object, BarSeries>`, `trackSeries(run, s)`
- Produces: `bindDeclared` binds a `CowSeries` for `{kind:'series'}` RHS instead of the raw `BarSeries`; `CowSeries` must become `export`-able or stay module-local (it already is module-local — reuse directly)

**Assumptions:** `evalReassign`'s `slot instanceof Series` branch calls `slot.set(v)` — CowSeries.set() materializes the private copy (interpreter.ts:260-262) ✓ verified.

**Done when:**
- `npx vitest run src/pine/__tests__/_alias_repro.test.ts` → all PASS (both cases below)
- Repro 1: `x = input.source(close)` + `x := 999` at bar 2 → `plot(close)` shows 102 at bar 2, 103 at bar 3 (close uncorrupted)
- Repro 2: `x = f()` where `f() => y` — same non-corruption (already passing; keep it)
- `npx vitest run src/pine/__tests__/interpreter.test.ts` → no new failures

- [ ] **Step 1: Keep/extend the failing test**

The existing `src/pine/__tests__/_alias_repro.test.ts` already asserts `close@2 == 102` and fails (prints `close@2 = {"kind":"int","v":999}`). Add one assertion inside the same test that the write is still visible through x itself:

```ts
// after the close assertions:
const xp = plots[1]!; // plot(x) not emitted in current file — add plot(x,"x") to src
expect(num(x.values[2])).toBe(999);       // x's own series sees the write
expect(num(x.values[3])).toBe(999);       // TV semantics: := persists on x, not on close
```

Wait — TV semantics check: `x := 999` writes x's OWN series; next bar `x = input.source(close)` **rebinds** x back to the input source? In Pine, `x = input.source(close)` is a per-bar expression assignment, so `x@3` reads close@3 = 103 again (the `:=` only pokes bar 2's slot of the local series). Assert `num(x.values[3])).toBe(103)`.

- [ ] **Step 2: Implement — wrap alias in CowSeries**

In `bindDeclared` (anchor: `if (v.kind === 'series' && v.v instanceof BarSeries) {`), replace:

```ts
  if (v.kind === 'series' && v.v instanceof BarSeries) {
    // Aliased decl (x = y): registration stays unconditional — the alias
    // target's own write cadence is unknown, and add is deduped anyway.
    trackSeries(run, v.v);
    scope.define(name, v.v);
    run.declSlots.set(key, v.v);
    return v.v;
  }
```

with:

```ts
  if (v.kind === 'series' && v.v instanceof Series) {
    // Aliased decl (x = input.source(close), x = f()): bind a CowSeries so a
    // later `x := v` materializes a private copy instead of writing through
    // into the shared source series (F1 — used to corrupt ctx.close).
    const existing = run.declSlots.get(key);
    const cow = existing instanceof CowSeries ? existing : new CowSeries(v.v);
    run.declSlots.set(key, cow);
    cow.rebind(v.v);
    // Re-seed this bar's slot with the source's current value — Pine `x = e`
    // re-evaluates each bar, so a previous bar's `:=` must not carry forward
    // (same pattern as callUdfValue's param seeding, interpreter.ts:1234).
    cow.seed(v.v.cur(), bar);
    trackSeries(run, cow);
    scope.define(name, cow);
  }
```

Note: widen the guard from `instanceof BarSeries` to `instanceof Series` (CowSeries wraps non-BarSeries too — e.g. builtin open/high series). `declSlots`/`trackSeries` take `BarSeries`; `CowSeries` satisfies that through `ForwardingSeries extends BarSeries` (series.ts:243) — no casts needed.

- [ ] **Step 3: Run test**

Run: `npx vitest run src/pine/__tests__/_alias_repro.test.ts`
Expected: PASS both tests; `close@2` prints `{"kind":"float","v":102}`.

- [ ] **Step 4: Regression**

Run: `npx vitest run src/pine/__tests__/interpreter.test.ts src/pine/__tests__/series.test.ts`
Expected: no new failures vs. the pre-change run (52 + full file).

- [ ] **Step 5: Commit**

```bash
git add src/pine/interpreter.ts src/pine/__tests__/_alias_repro.test.ts
git commit -m "fix: alias decl := writes through CowSeries, not shared source (F1)"
```

---

### Task 2: display.none fill anchor emits hidden series (F2 — P0)

**Blocked by:** None — can start immediately.

**Files:**
- Modify: `src/pine/engine.ts` — the `display.none` early-continue at ~line 517-519
- Test: `src/pine/__tests__/engine.test.ts` — extend the test at ~line 163 ("display.none drops the series; hidden plot still anchors fills")

**Interfaces:**
- Consumes: `fillRefs: Set<number>` (already computed at ~line 423-424), `plotSeriesId`, `series[]` push shape `{id,title,paneId,kind:'line',points,style,visible:false}` (mirror hline anchor at :434-446)
- Produces: a `visible:false` line series per display.none plot referenced by a fill

**Done when:**
- Test asserts the emitted `fills[]` entry's `fromSeriesId`/`toSeriesId` both resolve to ids present in `model.series` (previously they dangled)
- Existing assertions (descriptor count, no hline warning) still pass
- `npx vitest run src/pine/__tests__/engine.test.ts` → all PASS

- [ ] **Step 1: Extend the failing test**

In `engine.test.ts` at the `display.none` test (~line 163), after the existing assertions add:

```ts
const m = model; // the built model used above
const fill = m.fills[0]!;
expect(m.series.some(s => s.id === fill.fromSeriesId)).toBe(true);
expect(m.series.some(s => s.id === fill.toSeriesId)).toBe(true);
const anchor = m.series.find(s => s.id === fill.fromSeriesId)!;
expect(anchor.visible).toBe(false);
```

- [ ] **Step 2: Run — confirm fill anchor missing**

Run: `npx vitest run src/pine/__tests__/engine.test.ts -t "display.none"`
Expected: FAIL on `series.some(...)` — anchor id not found.

- [ ] **Step 3: Implement**

At `engine.ts` anchor `// display.none → no rendered series, but keep the sink→series-id mapping` (~line 517), replace:

```ts
    if (opts.display === 'display.none') { plotSeriesId.set(plot.index, id); continue; }
```

with:

```ts
    // display.none → no rendered series. When a fill references this plot,
    // emit a visible:false anchor like the hline path so the band has
    // geometry (F2 — previously the fill resolved to a dangling id).
    if (opts.display === 'display.none') {
      plotSeriesId.set(plot.index, id);
      if (fillRefs.has(plot.index)) {
        const points = plot.values.map((v, i) => ({
          time: plot.time[i] ?? barTimes[i] ?? 0,
          value: numOf(v),
        }));
        series.push({
          id, title, paneId: '', kind: 'line',
          points, style: { color: opts.color ?? '#2962FF', width: opts.linewidth ?? 1, lineStyle: 'solid' as const },
          visible: false,
        });
      }
      continue;
    }
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/pine/__tests__/engine.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pine/engine.ts src/pine/__tests__/engine.test.ts
git commit -m "fix: display.none fill anchor emits hidden series (F2)"
```

---

### Task 3: CHART_SYM resolves through fetchSeries (F3 — P0)

**Blocked by:** None — can start immediately.

**Files:**
- Modify: `src/pine/mtf.ts` — `resolvedSym`/`prefetchSecurity` (~lines 562-568, 606-609) and the dynamic path (~line 1676)
- Test: `src/pine/__tests__/mtf.test.ts` — new test in `describe('caller-agnostic eval cache')` or a nearby security describe

**Interfaces:**
- Consumes: `ctx.syminfo.tickerid` (`{kind:'string',v:<symbol>}`, context.ts:70), `resolvedSym(spec)`, `store.fetched` map keyed `` `${sym}\n${tf}` ``
- Produces: `resolvedSym` never returns `''` when `ctx.fetchSeries` is defined — it returns the chart ticker; the `chartBars` shortcut covers only the no-fetchSeries path

**Done when:**
- `request.security(syminfo.tickerid, '60', close)` with `fetchSeries` defined → fetch receives the real ticker string (assert via a fetch spy), and values are non-na
- The no-`fetchSeries` fallback still returns chart bars
- `npx vitest run src/pine/__tests__/mtf.test.ts` → all PASS

- [ ] **Step 1: Failing test**

Use `runSecurity` (mtf.test.ts:92) — it already returns `fetched: string[]` recording every `fetchSeries(sym, tf)` call, and `mkCtx` sets `ctx.syminfo.tickerid = 'TEST'` (:85). Do NOT use `runTransient` — its `` `|${t}` `` fallback masks the empty-symbol bug.

```ts
it('security(syminfo.tickerid, tf, expr) fetches the chart ticker, not ""', async () => {
  const body = [
    assign('x', security(member(ident('syminfo'), 'tickerid'), str('60'), ident('close'))),
  ];
  const { values, fetched } = await runSecurity(body, chart, '15', { 'TEST|60': tf60 });
  expect(fetched).toContain('TEST|60');                        // resolved to ctx.syminfo.tickerid
  expect(fetched.every(s => !s.startsWith('|'))).toBe(true);   // never a '' symbol
  expect(values.map(valOf).some(v => v !== null && !Number.isNaN(v))).toBe(true); // real bars, not all-na
});
```

- [ ] **Step 2: Run — confirm failure**

Expected: `fetched` contains `'|60'` (empty symbol) and `'TEST|60'` is never requested → test fails on `toContain('TEST|60')`.

- [ ] **Step 3: Implement**

At `prefetchSecurity` anchor `const sym = resolvedSym(spec), tf = resolvedTf(spec);` inside the jobs loop (~line 562), and the second loop (~line 585), wrap symbol resolution:

```ts
const rawSym = resolvedSym(spec);
const sym = rawSym === CHART_SYM ? (ctx.syminfo?.tickerid?.kind === 'string' ? ctx.syminfo.tickerid.v : rawSym) : rawSym;
```

Apply the same normalization at the `tryEvalSecurity` dynamic site (anchor `sym = runConst(spec.symNode, frame) ?? CHART_SYM;` ~line 1676): after resolution, `if (sym === CHART_SYM) sym = <chart ticker from frame.ctx.syminfo>;`.

Keep the fetch key as the RESOLVED sym (`${sym}\n${tf}`) — spec.bars lookup uses the same resolved key so no mismatch.

- [ ] **Step 4: Run**

Expected: test passes; `fetched` has `'TSE:2330|60'`, no `'|60'`.

- [ ] **Step 5: Commit**

```bash
git add src/pine/mtf.ts src/pine/__tests__/mtf.test.ts
git commit -m "fix: CHART_SYM resolves to chart tickerid for fetchSeries (F3)"
```

---

### Task 4: input.* overrides honored in security args (F4 — P0)

**Blocked by:** Task 3 (same function region — `resolvedSym`/`resolvedTf` prefetch loops)

**Files:**
- Modify: `src/pine/mtf.ts` — `scanTopLevel` staticEnv capture (anchor `if (m?.ns === 'input' && (m.name === 'timeframe'` ~line 326-331)
- Test: `src/pine/__tests__/mtf.test.ts`

**Interfaces:**
- Consumes: D4 decision — drop `input.*` from `staticEnv`; `runConst` + `pfScope` prebind path (mtf.ts:518-553); `ctx.inputs` override semantics (input.ts:104)
- Produces: specs whose sym/tf derives from `input.timeframe|symbol|string` go through the DYNAMIC path → prefetch resolves via `runConst` with live `ctx.inputs`

**Done when:**
- `request.security(sym, input.timeframe('60'), close)` + `inputValues: { 'Timeframe': '15' }` → fetch spy receives tf `'15'` (or whatever the input's title resolves to)
- No-override case still fetches `'60'`
- `npx vitest run src/pine/__tests__/mtf.test.ts` → all PASS

- [ ] **Step 1: Failing test**

```ts
it('input.timeframe override flows into security tf arg', async () => {
  const fetched: string[] = [];
  const fetchSpy = async (sym: string, tf: string) => { fetched.push(`${sym}|${tf}`); return tf60; };
  const src = `indicator("t")
tfIn = input.timeframe("60", "Timeframe")
x = request.security("AAA", tfIn, close)
plot(x)`;
  await runScript(parse(src), chart, {
    symbol: 'TSE:2330', timeframe: '15', fetchSeries: fetchSpy,
    inputValues: { 'Timeframe': '15' },
  });
  expect(fetched).toContain('AAA|15');
});
```

- [ ] **Step 2: Run — confirm 'AAA|60' fetched (override ignored)**

- [ ] **Step 3: Implement**

At `scanTopLevel` anchor `if (m?.ns === 'input' && (m.name === 'timeframe' || m.name === 'string' || m.name === 'symbol')) {`, **delete the whole block** (the `st.staticEnv.set(d.name, def.v)` write):

```ts
          if (d.value.type === 'call') {
            const m = memberOf(d.value.callee);
            if (m?.ns === 'input' && (m.name === 'timeframe' || m.name === 'string' || m.name === 'symbol')) {
              const def = pickArg(d.value.args, 0, 'defval');
              if (def?.type === 'str') st.staticEnv.set(d.name, def.v);
            }
          }
```

Keep `store.globals.set(d.name, {node: d.value, …})` above untouched — the producer node is what `runConst`/`pfScope` evaluate.

Then verify `pfScope` prebind covers the name: `collectGlobalRefs(spec.symNode/tfNode, needed)` must collect `tfIn` — it does (ident referenced by the security arg is a store.globals member → collected → `evalHook(def.node)` evaluates `input.timeframe(...)` with `ctx.inputs` live).

- [ ] **Step 4: Run**

Expected: `'AAA|15'` fetched.

- [ ] **Step 5: Commit**

```bash
git add src/pine/mtf.ts src/pine/__tests__/mtf.test.ts
git commit -m "fix: input.* security args resolve via live ctx.inputs (F4)"
```

---

### Task 5: Nested `:=` hop guard — shallow freshness (F-H1 — P1)

**Blocked by:** None (same file as 3/4 but different function region — `walk` reassign case ~line 1479-1509; may land parallel if the QA agent isn't mid-edit)

**Files:**
- Modify: `src/pine/mtf.ts` — `reassign` case in `walk` (anchor `let root: Node = n.target;` ~line 1495)
- Test: `src/pine/__tests__/mtf.test.ts`

**Interfaces:**
- Consumes: `fresh`, `rebound` sets in `exprSafeForAgnostic`
- Produces: `member`/`histref` `:=` targets pass only when the access chain root→leaf is exactly 1 hop AND root ∈ fresh ∖ rebound (D1 candidate B)

**Done when:**
- `u = [0]; u[0] := 1` inside gated expr → still passes gate (1-hop, fresh)
- `u = [a]; u[0][0] := 1` → `gateFail` increments (2-hop rejected regardless of element type)
- `t = Point.new(); t.f := 1` → passes (1-hop member, fresh ctor)

- [ ] **Step 1: Failing test**

```ts
it('gate rejects 2-hop member/index := even when root is fresh', async () => {
  const f0 = __mtfStats.gateFail;
  const body = [
    assign('u', { type: 'arraylit', items: [ident('close')] } as Node),
    // seq wrapper or inline — gated expr contains the nested write
    assign('x', security(str(''), str('60'),
      { type: 'seq', stmts: [
        { type: 'reassign', target: { type: 'histref', obj: { type: 'histref', obj: ident('u'), idx: num(0) }, idx: num(0) }, value: num(1) },
        ident('close'),
      ] } as Node)),
  ];
  await runTransient(body, chart, '15', { '|60': tf60 });
  expect(__mtfStats.gateFail - f0).toBe(1);
});
```

(If `seq` is awkward to construct, nest inside an `ifexpr` arm — any container that reaches `reassign` in the walk.)

- [ ] **Step 2: Run — confirm it currently PASSES (gateFail Δ=0) — the hole**

- [ ] **Step 3: Implement**

At anchor `let root: Node = n.target;` (~line 1495), replace:

```ts
          let root: Node = n.target;
          while (root.type === 'member' || root.type === 'histref') root = root.obj;
          // A fresh root that was `:=`-rebound may now hold a shared object
          // (QA17) — the write-through put an unproven value in its slot.
          if (root.type !== 'ident' || !fresh.has(root.name) || rebound.has(root.name)) return false;
```

with:

```ts
          let root: Node = n.target;
          let hops = 0;
          while (root.type === 'member' || root.type === 'histref') { root = root.obj; hops++; }
          // Depth guard (D1): freshness is shallow — a fresh container's
          // ELEMENTS/FIELDS may still alias shared objects, so only a 1-hop
          // write (`t.f :=`, `a[i] :=`) is provably local. `a[i].f :=`,
          // `u[0][0] :=` write through an element that could be shared.
          if (hops !== 1) return false;
          // A fresh root that was `:=`-rebound may now hold a shared object
          // (QA17) — the write-through put an unproven value in its slot.
          if (root.type !== 'ident' || !fresh.has(root.name) || rebound.has(root.name)) return false;
```

- [ ] **Step 4: Run**

Expected: new test PASS; `npx vitest run src/pine/__tests__/mtf.test.ts` all PASS (existing 1-hop tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/pine/mtf.ts src/pine/__tests__/mtf.test.ts
git commit -m "fix: member/index := limited to 1 hop from fresh root (H1)"
```

---

### Task 6: Mutating-namespace-call guard (F-H2 — P1)

**Blocked by:** Task 5 (adjacent code — the `call` case of `walk`)

**Files:**
- Modify: `src/pine/mtf.ts` — `call` case in `walk` (~line 1446-1461) + new module-level table
- Test: `src/pine/__tests__/mtf.test.ts`

**Interfaces:**
- Consumes: `memberOf(callee)` helper, `bound`/`fresh`/`rebound` sets, D5 mutator table
- Produces: `ns.mut(firstArg, …)` where firstArg's root isn't fresh-and-not-rebound → gate rejects

**Done when:**
- `var a = array.from(1); array.push(a, 1)` inside gated expr → `gateFail` Δ≥1
- `u = [0]; array.push(u, 1)` → still passes (fresh root, 1st arg = u)
- `a.slice(0,1)` (non-mutator) → unaffected

- [ ] **Step 1: Failing test**

```ts
it('gate rejects array.push on a var-bound array inside security expr', async () => {
  const f0 = __mtfStats.gateFail;
  const arr: Node = { type: 'call', callee: member('array', 'from'), args: [{ value: num(1) }] } as Node;
  const push: Node = { type: 'call', callee: member('array', 'push'), args: [{ value: ident('a') }, { value: num(9) }] } as Node;
  const body = [
    { type: 'var', name: 'a', value: arr } as Node,
    assign('x', security(str(''), str('60'),
      { type: 'seq', stmts: [push, ident('close')] } as Node)),
  ];
  await runTransient(body, chart, '15', { '|60': tf60 });
  expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run — confirm currently passes (hole)**

- [ ] **Step 3: Implement**

Add module-level table near `freshInit` (~line 1217):

```ts
/** Namespace methods that mutate arg[0] in place — `:=` bypass that must
 *  pass the same fresh-root check (H2). Table is exhaustive for the
 *  registered builtins (array.ts `mut(` sites); extend when map/matrix land. */
const MUTATING_NS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['array', new Set(['push','unshift','pop','shift','set','insert','remove','fill','clear','reverse','sort'])],
]);
```

In the `call` case of `walk`, after the `request.*` and bound-callee checks (anchor `// The callee resolves via the ident case`), insert before `if (!walk(n.callee, …))`:

```ts
        // Mutating builtin on arg[0] (`array.push(a,x)`) — arg0's root must
        // satisfy the same fresh-root rule as a `:=` target (H2).
        {
          const mm = n.callee.type === 'member' && !n.callee.computed ? memberOf(n.callee) : null;
          if (mm && MUTATING_NS.get(mm.ns)?.has(mm.name) && n.args.length > 0) {
            let r0: Node = n.args[0]!.value;
            let hops = 0;
            while (r0.type === 'member' || r0.type === 'histref') { r0 = r0.obj; hops++; }
            if (hops !== 0 || r0.type !== 'ident'
                || !fresh.has(r0.name) || rebound.has(r0.name)) return false;
          }
        }
```

(`hops !== 0` — arg0 must BE the ident root itself; `array.get(u,0)` as arg0 means the pushed object is a call result = unproven.)

- [ ] **Step 4: Run**

Expected: new test PASS; full mtf.test.ts PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pine/mtf.ts src/pine/__tests__/mtf.test.ts
git commit -m "fix: gate rejects mutating ns calls on non-fresh arg0 (H2)"
```

---

### Task 7: Arrow-body `:=` merges rebound upward (F-H3 — P2)

**Blocked by:** Task 5, 6 (same `walk` function)

**Files:**
- Modify: `src/pine/mtf.ts` — `func/method/arrow` case in `walk` (~line 1463-1478)
- Test: `src/pine/__tests__/mtf.test.ts`

**Interfaces:**
- Consumes: `walkScoped` (~line 1374-1382) which already implements child-scope copy + upward rebound merge
- Produces: arrow bodies walked via `walkScoped` seeded with param names — `:=` on outer names merges; param-bound names stay local

**Done when:**
- `f = () => (u := shared); f(); u[0] := 1` (u fresh) inside gated expr → `gateFail` (rebound mark survives arrow walk)
- `f = () => [1]; f()[0] := 1` — arrow return value target is a call root → already rejected, unaffected

- [ ] **Step 1: Failing test**

Arrow IIFE inside the gated expr — must be invoked through a non-ident callee (a bound `f` ident callee rejects earlier at the `call` case's `bound.has` check, which would make the test fail for the wrong reason):

```ts
it('gate rejects member := after arrow body rebinds the fresh root (IIFE)', async () => {
  const f0 = __mtfStats.gateFail;
  // expr = seq [ u = [0],  (() => (u := close))(),  u[0] := 1 ]
  // u is fresh; the IIFE's body reassigns it to the SHARED close series →
  // rebound mark must survive the arrow walk → u[0] := rejects. (`shared`
  // would fail the gate for the wrong reason — an unbound ident in the RHS
  // rejects the reassign before the rebound-mark path is exercised.)
  const iife: Node = call(
    { type: 'arrow', params: [],
      body: [{ type: 'reassign', target: ident('u'), value: ident('close') } as Node] } as Node);
  const seq: Node = { type: 'seq', stmts: [
    assign('u', arraylit([num(0)])),
    iife,
    { type: 'reassign', target: histref(ident('u'), num(0)), value: num(1) } as Node,
    ident('close'),
  ] } as Node;
  const body = [assign('x', security(str(''), str('60'), seq))];
  await runTransient(body, chart, '15', { '|60': tf60 });
  expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
});
```

`shared` needn't exist — the gate rejects statically before eval. (`seq` is hand-constructed; the parser doesn't emit it, but `walk`'s `seq` case handles it — same pattern as existing tests' literal func decls.)

- [ ] **Step 2: Run — confirm pass (hole)**

Expected: `gateFail` Δ=0 — the rebound mark died inside the arrow body's set copy.
- [ ] **Step 3: Implement**

In the `func`/`method`/`arrow` case (~line 1463-1477), replace the manual copy + `walkBlock`:

```ts
      case 'func': case 'method': case 'arrow': {
        const b2 = new Set(bound), vb2 = new Set(varBound), f2 = new Set(fresh),
          r2 = new Set(rebound);
        const loc = new Set<string>();
        for (const p of n.params) {
          b2.add(p.name); vb2.delete(p.name); f2.delete(p.name); r2.delete(p.name);
          loc.add(p.name);
        }
        for (const p of n.params) if (p.default && !walk(p.default, bound, varBound, fresh, rebound)) return false;
        return walkBlock(n.body, b2, vb2, f2, r2, loc);
      }
```

with a scoped walk that merges non-local rebound marks upward (arrow bodies run in a child scope at CALL time; `:=` on outer names writes through — the mark must survive (H3)):

```ts
      case 'func': case 'method': case 'arrow': {
        const pnames = n.params.map(p => p.name);
        for (const p of n.params) if (p.default && !walk(p.default, bound, varBound, fresh, rebound)) return false;
        // Params seed `loc`: bound but never fresh/var/rebound, and their
        // rebound marks stay body-local. Outer names' `:=` marks merge up —
        // the arrow may be invoked inside this gated eval and the rebind
        // write-through persists on the caller-visible slot (H3).
        const inner = new Set(bound);
        for (const nm of pnames) inner.add(nm);
        return walkScoped(n.body, inner, varBound, fresh, rebound, pnames);
      }
```

`walkScoped` already seeds `loc` from `pnames`, deletes them from v2/f2/r2, and merges `r2 ∖ loc` into `rebound`.

- [ ] **Step 4: Run**

Expected: hole test fails gate; full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pine/mtf.ts src/pine/__tests__/mtf.test.ts
git commit -m "fix: arrow-body := merges rebound marks upward (H3)"
```

---

### Task 8: Child-scope rebind-then-redecl shadow hole (F-H4 — P2)

**Blocked by:** Task 7 (same walkScoped/addDeclNames machinery)

**Files:**
- Modify: `src/pine/mtf.ts` — `bind` inside `addDeclNames` (anchor `rebound?.delete(nm);` ~line 1259)
- Test: `src/pine/__tests__/mtf.test.ts`

**Interfaces:**
- Consumes: `local` merge-skip set in `walkScoped`
- Produces: `rebound.delete` on `=` redecl removed — the mark stays (safe over-reject on same-scope redecl, correct reject on child-scope shadow)

**Done when:**
- `u=[0]; if c → {u:=shared; u=[0]}; u[0]:=1` → `gateFail` (outer u was written through before the shadowing decl)
- Same-block `u=[0]; u:=shared; u=[0]; u[0]:=1` → also `gateFail` (accepted over-reject — documented)

- [ ] **Step 1: Failing test** — the `if`-arm variant above; assert `gateFail` Δ≥1.

- [ ] **Step 2: Run — confirm pass (hole)**

- [ ] **Step 3: Implement**

In `addDeclNames`'s `bind` (anchor `// `=` re-decl is scope.define — a NEW local slot`), replace:

```ts
    rebound?.delete(nm);
    local?.add(nm);
```

with:

```ts
    // Do NOT clear `rebound` here: inside a child scope this `=` shadows, but
    // an earlier `u := shared` in the SAME child already wrote through to the
    // parent's slot — clearing would drop that mark at merge time and the
    // outer binding keeps its stale `fresh` (H4). `local` alone suffices:
    // it stops the merge only for bindings the child actually owned. Cost: a
    // same-SCOPE redecl (`u:=a` then `u=[0]` in one block) now keeps the
    // stale mark → over-reject. Safe direction (perf, not correctness).
    local?.add(nm);
```

- [ ] **Step 4: Run** — both variants assert gateFail; full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pine/mtf.ts src/pine/__tests__/mtf.test.ts
git commit -m "fix: = redecl no longer clears rebound marks in child scopes (H4)"
```

---

### Task 9: tf-frame syminfo reflects requested symbol (F5 — P1)

**Blocked by:** Task 3 (touching the same `ensureTfFrame`/spec sym resolution region)

**Files:**
- Modify: `src/pine/mtf.ts` — `ensureTfFrame` ctx construction (anchor `syminfo: parent.syminfo,` ~line 1013)
- Test: `src/pine/__tests__/mtf.test.ts`

**Interfaces:**
- Consumes: `buildSyminfo(symbol, overrides)` from `src/pine/context.ts:62`; `resolvedSym(spec)` after Task 3's normalization
- Produces: `spec.ctx.syminfo` built for the requested symbol; requested-timeframe already correct (:1014-1022)

**Done when:**
- `request.security("OTHER", "60", syminfo.tickerid)` yields `"OTHER"` not the chart ticker
- `request.security(syminfo.tickerid, "60", syminfo.ticker)` yields the chart ticker (F3+ F5 compose)

- [ ] **Step 1: Failing test**

```ts
it('security expr syminfo.tickerid resolves to the requested symbol', async () => {
  const body = [
    assign('x', security(str('OTHER'), str('60'), member(ident('syminfo'), 'tickerid'))),
  ];
  const { values, fetched } = await runSecurity(body, chart, '15', { 'OTHER|60': tf60 });
  expect(fetched).toContain('OTHER|60');
  const strs = values.map(v => v.kind === 'string' ? v.v : null).filter(v => v !== null);
  expect(strs.length).toBeGreaterThan(0);
  expect(strs.every(s => s === 'OTHER')).toBe(true);   // not 'TEST' (chart ctx)
});
```

(`mkCtx` syminfo.tickerid is `'TEST'` — pre-fix the tf frame inherits it → values would be `'TEST'` → fails.)

- [ ] **Step 2: Run — confirm chart ticker ('TEST') returned**

- [ ] **Step 3: Implement**

At `ensureTfFrame` anchor `syminfo: parent.syminfo,`, compute resolved symbol before building ctx:

```ts
  const parent = frame.ctx;
  const rt = resolvedTf(spec);
  const tf = rt === DYNAMIC ? parent.timeframe.period : rt;
  const reqSym = resolvedSym(spec);
  const tfSym = reqSym === DYNAMIC || reqSym === CHART_SYM
    ? (parent.syminfo.tickerid?.kind === 'string' ? parent.syminfo.tickerid.v : '')
    : reqSym;
```

then replace `syminfo: parent.syminfo,` with:

```ts
    // syminfo.* inside security() refers to the REQUESTED symbol per TV
    // semantics — build it from resolved tf sym (F5). Carry parent's
    // provider overrides EXCEPT identity fields — context.ts:85 merges
    // overrides verbatim, so passing parent.syminfo wholesale would re-stamp
    // the chart's ticker/tickerid/prefix over the requested symbol's.
    syminfo: buildSyminfo(tfSym, syminfoSansIdentity(parent.syminfo)),
```

Add a helper above `ensureTfFrame`:

```ts
/** Provider syminfo minus identity fields — those must reflect the
 *  requested symbol, not the chart's. */
const SYMINFO_IDENTITY = new Set(['ticker', 'tickerid', 'prefix', 'description']);
function syminfoSansIdentity(src: Record<string, Value>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(src)) if (!SYMINFO_IDENTITY.has(k)) out[k] = v;
  return out;
}
```

`buildSyminfo` is currently module-private in `context.ts` (`function buildSyminfo`, :62 — no export) — first change it to `export function buildSyminfo`. `Value` is already imported into mtf.ts via `./contracts` (:31).

- [ ] **Step 4: Run** — new test PASS; suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pine/mtf.ts src/pine/__tests__/mtf.test.ts
git commit -m "fix: tf-frame syminfo built from requested symbol (F5)"
```

---

### Task 10: UDF param-default escaping signals (F7 — P2)

**Blocked by:** Task 1 (same file `interpreter.ts`, different region)

**Files:**
- Modify: `src/pine/interpreter.ts` — `bindCallArgs` default eval (~line 1198-1204)
- Test: `src/pine/__tests__/interpreter.test.ts`

**Interfaces:**
- Consumes: `pineErr`, `BREAK`/`CONTINUE` symbols, QA10 conversion pattern (interpreter.ts:1262-1272)
- Produces: `BREAK`/`CONTINUE`/`ReturnSignal` escaping a param default become `pineErr`, never reach the bar loop's warn-and-skip

**Done when:**
- `f = (x = (ifexpr-with-break)) => x` called → PineRuntimeError, not silent bar-skip
- `npx vitest run src/pine/__tests__/interpreter.test.ts` → all PASS

- [ ] **Step 1: Failing test**

```ts
it('break inside a UDF param default is an error, not a bar skip', async () => {
  // f(x = ifexpr{ then:[break] }) => x  — default holds a stmt-level break
  // inside an ifexpr arm; craft the AST directly (Pine source can't write
  // break in expr position, but the AST shape is legal for evalExpr).
  const fDecl: Node = {
    type: 'func', name: 'f',
    params: [{ name: 'x',
      default: { type: 'ifexpr', test: bool(true),
        then: [{ type: 'break', loc: undefined } as Node],
        elseIfs: [], else: [num(0)] } as Node }],
    body: ident('x'),
  } as Node;
  const body = [fDecl, assign('y', call(ident('f'), [])), plot(ident('y'))];
  await expect(runScript(body, mkBars(4), { symbol: 'X', timeframe: '1' }))
    .rejects.toThrow(/break|control-flow/);
});
```

(`call(ident('f'), [])` — zero args so the default evaluates; `mkBars`/`call`/`assign`/`plot`/`bool`/`num`/`ident` are existing interpreter.test.ts helpers.)

- [ ] **Step 2: Run — confirm warn-and-skip path**

Expected: pre-fix the throw is `BREAK` escaping `bindCallArgs` → bar loop catches it at interpreter.ts:1692 → `warn 'break/continue outside loop'` — the test fails on `.rejects.toThrow` (no error thrown, run completes with a warning).

- [ ] **Step 3: Implement**

In `bindCallArgs` (anchor `const d = params[i]!.default;` ~line 1200), wrap the default eval:

```ts
  for (let i = 0; i < params.length; i++) {
    if (!filled.has(i)) {
      const d = params[i]!.default;
      try {
        out[i] = d !== undefined ? evalExpr(d, frame) : NA;
      } catch (e) {
        // A break/continue/return escaping a default expression is invalid
        // Pine — convert like QA10's body conversion rather than letting it
        // hit the bar loop's warn-and-skip (F7).
        if (e === BREAK || e === CONTINUE || e instanceof ReturnSignal) {
          throw pineErr(d, `control-flow statement in parameter default of function call`);
        }
        throw e;
      }
    }
  }
```

- [ ] **Step 4: Run** — test throws; suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pine/interpreter.ts src/pine/__tests__/interpreter.test.ts
git commit -m "fix: escaping break/continue/return in param defaults becomes error (F7)"
```

---

### Task 11: Editor stale currentId after script delete (F8 — P2)

**Blocked by:** None — UI file, independent.

**Files:**
- Modify: `src/pages/velaPineEditor.ts` — `openEditor` state init (~line 387-388) and/or module init near `editorState` (~line 355)
- Test: `src/pine/lib/pineLib.test.ts` or a new editor-level test if a harness exists; otherwise manual verify steps

**Interfaces:**
- Consumes: `pineLibSubscribe(fn)` → unsubscribe (pineLib.ts:34), `pineLibGet(id)`
- Produces: `editorState.currentId` nulled when the bound entry is removed; draft restore validates `pineLibGet(draft.id)` before adopting the id

**Done when:**
- Delete the currently-open script via `velaPineScriptsDialog` → next Save creates a NEW entry (pineLibCreate path) instead of `pineLibSave` throwing 'script not found'
- Collapsed-draft with a deleted id opens without adopting the dead id

- [ ] **Step 1: Implement subscription**

Near `let editorState: EditorState = { currentId: null, dirty: false };` (~line 355), add:

```ts
// Keep currentId consistent with the library: deleting the open script must
// not leave a dead id that makes Save throw 'script not found' (F8).
pineLibSubscribe(() => {
  if (editorState.currentId && !pineLibGet(editorState.currentId)) {
    editorState = { ...editorState, currentId: null };
  }
});
```

And in the draft-restore block (anchor `area.value = draft.src;` ~line 724), guard the id adoption:

```ts
  } else if (draft?.src && !editorState.currentId) {
    area.value = draft.src;
    editorState.currentId = draft.id && pineLibGet(draft.id) ? draft.id : null;
```

- [ ] **Step 2: Manual verify** — open editor on a saved script, delete it in the dialog, Save → creates new entry; collapse/reopen → no dead id.

- [ ] **Step 3: Commit**

```bash
git add src/pages/velaPineEditor.ts
git commit -m "fix: clear stale editor currentId after script delete (F8)"
```

---

### Task 12: Boot strip → park + deferred restore (F10 — P2, D3)

**Blocked by:** None — but **Status: needs human confirmation on D3** before starting (deletes a destructive migration; changes persisted-data lifecycle).

**Files:**
- Modify: `src/pages/VelaPage.tsx` — the strip block (~line 224-250) and post-boot restore hook (after `ws = new VelaWorkspace(...)`)
- Test: manual browser verify (no unit harness for workspace boot)

**Interfaces:**
- Consumes: `opencharts.pine-scripts` ext entries shape `{script?: string}`, `ws` instance, `runIndicator`/indicator-attach API (confirm actual API name — search `pine-scripts` writer site)
- Produces: `vela-workspace-v2.parked-pine` localStorage key; deferred re-attach of heavy scripts after first paint

**Done when:**
- Save a workspace containing an MTF script, reload → script re-runs (asynchronously) instead of being deleted
- Boot without heavy scripts stays unchanged (no regression on light restore)
- `localStorage['vela-workspace-v2']` never loses a script entry silently

- [ ] **Step 1: Park instead of delete**

Replace the `kept` filter logic (anchor `const kept = (entries as ExtEntry[]).filter(`) with:

```ts
          const parked: unknown[] = (() => {
            try { return JSON.parse(localStorage.getItem("vela-workspace-v2.parked-pine") || "[]") as unknown[]; }
            catch { return []; }
          })();
          let stripped = false;
          for (const c of doc.charts ?? []) {
            const entries = c.ext?.["opencharts.pine-scripts"];
            if (!Array.isArray(entries)) continue;
            const kept = (entries as ExtEntry[]).filter(
              (e) => typeof e.script !== "string" || !e.script.includes("request.security"),
            );
            const moved = entries.filter(
              (e) => typeof (e as ExtEntry).script === "string" && (e as ExtEntry).script!.includes("request.security"),
            );
            if (moved.length) parked.push(...moved);
            if (kept.length !== entries.length) {
              if (kept.length) c.ext!["opencharts.pine-scripts"] = kept;
              else delete c.ext!["opencharts.pine-scripts"];
              stripped = true;
            }
          }
          if (parked.length) localStorage.setItem("vela-workspace-v2.parked-pine", JSON.stringify(parked));
          if (stripped) localStorage.setItem("vela-workspace-v2", JSON.stringify(doc));
```

- [ ] **Step 2: Deferred restore**

After `ws = new VelaWorkspace(...)` succeeds (anchor `// Indicators picker manifest`), add:

```ts
      // Re-attach parked heavy scripts off the boot path — parked, not
      // deleted, so MTF support doesn't silently eat user scripts (F10).
      const parked = (() => {
        try { return JSON.parse(localStorage.getItem("vela-workspace-v2.parked-pine") || "[]") as { script?: string }[]; }
        catch { return []; }
      })();
      if (parked.length) {
        const restore = () => {
          localStorage.removeItem("vela-workspace-v2.parked-pine");
          for (const e of parked) if (typeof e.script === "string") {
            try { ws?.state().charts[0]?.runIndicator?.({ source: e.script }); } catch { /* per-script */ }
          }
        };
        if ("requestIdleCallback" in window) requestIdleCallback(restore, { timeout: 5000 });
        else setTimeout(restore, 3000);
      }
```

(Confirm the actual re-run API name — `runIndicator` is referenced in repo docs; check `VelaWorkspace`'s chart API for the real method signature and adjust.)

- [ ] **Step 3: Manual verify** — `/vela` with a persisted MTF script → boot fast, script appears after idle; localStorage `parked-pine` emptied after restore.

- [ ] **Step 4: Commit**

```bash
git add src/pages/VelaPage.tsx
git commit -m "fix: park heavy scripts at boot and restore on idle (F10)"
```

---

### Task 13: Gate test-quality cleanup (F12 + H-residuals — P3)

**Blocked by:** Tasks 5-8 (assertion targets they create)

**Files:**
- Modify: `src/pine/__tests__/mtf.test.ts` — strengthen the dedup test (~line 508)
- Modify: `src/pine/mtf.ts` — add `prodWalks` counter to `__mtfStats`

**Interfaces:**
- Consumes: `__mtfStats` object in mtf.ts
- Produces: `__mtfStats.prodWalks` incremented inside `producerSafe` at the actual `walk(def.node, …)` site

**Done when:**
- Dedup test asserts `prodWalks` Δ counts — two gated exprs sharing one producer walk it once total (pins the spec-level hoist, which previously only the absence of double work could show)
- Full suite PASS

- [ ] **Step 1:** Add `prodWalks: 0` to `__mtfStats` (anchor `gatePass`/`gateFail` fields) and `__mtfStats.prodWalks++` right before `const ok = walk(def.node, NO_BOUND, NO_BOUND, NO_BOUND, NO_BOUND);` (~line 1426).

- [ ] **Step 2:** In the dedup test, add `const w0 = __mtfStats.prodWalks;` before run and `expect(__mtfStats.prodWalks - w0).toBe(1);` after.

- [ ] **Step 3: Run + commit** (`test: pin prodVerdicts spec-hoist via prodWalks counter`)

---

### Task 14: Sync fetchSeries throw inside timeout wrapper (F9 — P2)

**Blocked by:** Task 3 (same prefetch function)

**Files:**
- Modify: `src/pine/mtf.ts` — job construction (~line 566-568)
- Test: `src/pine/__tests__/mtf.test.ts` — fetchSeries that throws synchronously

**Done when:** sync-throw `fetchSeries` degrades to `[]` + console.warn instead of rejecting `prefetchSecurity`.

- [ ] **Step 1: Implement**

At anchor `const job = (ctx.fetchSeries ? ctx.fetchSeries(sym, tf) : Promise.resolve(chartBars!));` replace with:

```ts
    const job = ctx.fetchSeries
      ? Promise.resolve().then(() => ctx.fetchSeries!(sym, tf)) // sync throws land in the race/catch
      : Promise.resolve(chartBars!);
```

- [ ] **Step 2: Test** — `fetchSeries` that `throw new Error('sync')` (not async) → run completes, values na, warning recorded.

- [ ] **Step 3: Commit** (`fix: sync fetchSeries throw degrades inside prefetch race (F9)`)

---

### Task 15: Unify gate childNodes with interpreter astChildren (F11 — P3)

**Blocked by:** Tasks 5-8 (all gate edits land first to avoid rebase churn)

**Files:**
- Modify: `src/pine/interpreter.ts` — export `astChildren` (anchor `function astChildren(` ~line 333)
- Modify: `src/pine/mtf.ts` — replace local `childNodes` (~line 1283-1305) with the shared collector
- Test: `src/pine/__tests__/mtf.test.ts` — existing suite is the regression net; add one node shape the allowlist missed if the shared collector diverges on any (see below)

**Interfaces:**
- Consumes: `astChildren(node: object): Node[]` — recursive wrapper-transparent collector (interpreter.ts:333-352)
- Produces: gate's `default:` branch sees the same child set the runtime scanner sees — a future wrapper shape can't silently bypass the gate

**Done when:**
- `mtf.ts` no longer defines `childNodes` — `walk`'s default case calls the shared `astChildren`
- `npx vitest run src/pine/__tests__/mtf.test.ts` → all PASS (GateReview verified zero divergence on current AST shapes, so no behavior change expected)

- [ ] **Step 1: Export astChildren**

In `interpreter.ts` at anchor `function astChildren(node: object): Node[] {`, add `export`.

- [ ] **Step 2: Replace childNodes in mtf.ts**

Add `astChildren` to the existing `import { evalBlock, evalExpr, registerMtf } from './interpreter';` line (:34) → `import { astChildren, evalBlock, evalExpr, registerMtf } from './interpreter';`.

Delete the whole local `childNodes` function (anchor `/** Child expression/stmt nodes (Arg/case/Param wrappers unwrapped). */` through the closing `}` at ~line 1305), and replace the `walk` default-case call `for (const c of childNodes(n))` with `for (const c of astChildren(n))`.

CAUTION — behavioral check before committing: the two collectors differ on `loc` (interpreter's skips nothing — it recurses into `loc` harmlessly since `{line,col}` has no `'type'`; mtf's skips `loc`/`type` keys explicitly). Shared version scans `loc` — confirm no Node-typed field lives under a `loc` key (verified: `loc` is `{line:number,col:number}` per contracts.ts `Base`). Also the shared version recurses into non-array wrapper fields — strictly more coverage, safe direction.

- [ ] **Step 3: Run**

`npx vitest run src/pine/__tests__/mtf.test.ts src/pine/__tests__/interpreter.test.ts` → all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pine/mtf.ts src/pine/interpreter.ts
git commit -m "refactor: gate uses shared astChildren collector (F11)"
```
