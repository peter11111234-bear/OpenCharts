# Backlog Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**日期：** 2026-10-09

**Goal:** Close the phase-2 backlog from `2026-10-09-alias-write-through-round2.md`: real "增加到整個版面" menu behavior, TV-correct `security_lower_tf` granularity (D4), `strategy.*` QA pass, and the PineTS indicator-library spike (B3). B4 (worker 化) stays deferred — scoped, not planned.

**Architecture:** Four independent tasks. T1 wires the legend ⋯ menu item to `ctx.cells` (runtime `WorkspaceWidgetContext`) + `cell.chart.runIndicator`. T2 flips `mtf.ts`'s `isLtf` branch from nominal-slot/na-padding to existing-bars-only (TV semantics per Pine v5 docs + PineTS reference impl). T3 is a read-mostly QA pass over `strategy.ts` producing findings + regression tests. T4 adds a PineTS context facade (`src/pine/pinetsShim.ts`) and ports tr → rsi → supertrend as the pilot.

**Tech Stack:** TypeScript, vitest, Vela workspace API (`@luxalgo/vela/workspace`), local pinets-src reference tree at `C:\Users\bear9\pinets-src`.

**Spec:** this file is the spec; upstream context = `2026-10-09-alias-write-through-round2.md` Phase-2 backlog + `2026-10-07_pine-editor-tv-parity.md` Task-6 menu contract + `2026-10-05-tv-alignment.md` D4.

**Spec invariant:** TV semantics win wherever evidence exists; never reintroduce nominal-slot na-padding for `security_lower_tf` output arrays.

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same verify failing after 2+ distinct fix attempts. Single red test = normal TDD loop, not a blocker.

**Plan-specific Nevers:**
- NEVER touch `C:\Users\bear9\pinets-src\` — reference source, read-only.
- NEVER pass the same `id` to `runIndicator` on a second cell — same-id resolves `{ok:false}` (options-BnEPUuVV.d.ts:2090); omit `id` and let each cell mint its own.
- NEVER write nominal-slot padding back into `security_lower_tf` (D4 outcome: real bars only).
- NEVER add `pinets` to package.json deps — the spike imports nothing from node_modules/pinets; it adapts source patterns into our `BuiltinFn` shape.

## Global Constraints

- Test command: `npx vitest run <file>` per file; full pine suite = `npx vitest run src/pine/__tests__/`.
- Repo uses flat tab indentation conventions in `velaPineEditor.ts`; match existing style.
- localStorage keys stay under `opencharts.pine.*` prefix.
- Commit per task.

## Decision Points

### D1: Menu "增加到整個版面" — which inputs get propagated (T1)

- Consumed by: Task 1
- Candidates:
  - A (minimal): omit `inputs` — each cell runs the script with declaration defaults
  - B (existing pattern): copy source handle's `inputValues()` into every target cell (`IndicatorHandle.inputValues()` exists, contributions-tjNExo1o.d.ts:320)
  - C (preferred): B, but only when `h.inputValues()` is readable; fall back to A on failure
- Criteria:
  - The copied indicator on another cell shows the same configured params the user sees on the source cell
  - Implementation stays inside `toggleMoreMenu` — no new module state
  - Failure on one cell does not block the rest
- Chosen: B — A fails criterion 1 (user configured inputs get silently reset); C adds a failure path for a call that is a plain getter, not worth the branch.
- Rejected: A fails criterion 1; C fails criterion 2 marginally (dead defensive branch).
- Revisit trigger: `inputValues()` observed to throw or return partial state in practice.
- Outcome:

### D2: `security_lower_tf` granularity — CONFIRMED TV semantics (T2)

- Consumed by: Task 2
- Candidates:
  - A (existing pattern, current impl): nominal tf slots, `na` pad empty slots (mtf.ts:1769-1811)
  - B (TV-true): one element per EXISTING lower bar; missing bars skipped; array length varies
  - C (minimal): keep A, document as known deviation
- Criteria:
  - `array.size()` on TV returns count of existing intrabars, not slot count — match
  - `array.get(a, i)` indexing maps to the i-th existing intrabar — match
  - PineTS reference (`pinets-src/src/namespaces/request/methods/security_lower_tf.ts:481-515`) emits real bars only, `sOpen ∈ [myOpenTime, myCloseTime)` — match its contract
- Chosen: B — TV docs + PineTS impl + SO/Reddit reports all say existing-bars-only; current impl deviates.
- Rejected: A fails criterion 1+2; C fails criterion 1.
- **Status: T2 — needs human confirmation** (changes pinned test expectations). If user declines, fallback = C and the plan's Task 2 is skipped wholesale.
- Outcome:

### D3: PineTS shim — where ported methods land (T1)

- Consumed by: Task 4
- Candidates:
  - A (existing pattern): register into the global builtin registry via `registerBuiltin('ta', name, fn)` — same shape as `ta.ts`
  - B (minimal): a separate `pinetsShim` module self-registers at import time; no changes to ta.ts
  - C (preferred): B + keep ported names under a QA flag first (e.g. register under `ta` namespace directly — TV parity means they ARE ta.*)
- Criteria:
  - A ported method is callable from a pine script as `ta.rsi(...)` with zero script-side difference
  - State isolation per callsite matches existing `stateFor`/`vsOf` conventions
  - No changes to files outside `src/pine/pinetsShim.ts` + its test
- Chosen: B — self-registering module keeps the spike isolated; registering under `ta` gives TV parity automatically. Name collisions with existing builtins: `registerBuiltin` behavior on dup must be checked at step 0 (either overwrite-with-warn or skip-if-exists — pick skip-if-exists for the spike).
- Rejected: A fails criterion 3 (edits ta.ts); C's flag adds machinery the spike doesn't need.
- Revisit trigger: name collision handling turns out load-bearing for correctness (e.g. dup silently wins wrong impl) → surface it, decide then.
- Outcome:

## Review Ledger


### Task 3 — strategy.* QA pass (executed 2026-10-09)

Findings doc: `docs/strategy-qa-2026-10-09.md`. Probe: `scratch/_strategy_qa.mjs`.

Fixed in `src/pine/builtins/strategy.ts` (self-contained, ~30 lines total):
- **F2** `strategy.close` ignored `qty`/`qty_percent` → partial closes work.
- **F3** `closedtrades.*` indexed most-recent-first → chronological (v5: 0 = first closed trade); two stale tests corrected.
- **F4** ledger accounting: same-direction fills no longer consume open legs (FIFO `closing` now gated on opposing direction); `avgEntry`/`openTrades` re-derived from live legs each fill; realized PnL booked per-leg (matches `closedtrades.profit`, keeps equity split correct); `closedTrades` counts consumed legs.
- **F5** positional signatures aligned to v5 (`when` demoted to named-only; `close_all` gets its own order; `exit` gained `oca_name`/`oca_type` wiring).

Pinned-not-fixed (`it.fails` in `strategy.test.ts`, needs leg-level entry ids — >20 lines):
- **F1** `strategy.close(id)` / `strategy.exit(from_entry)` don't match entry ids — unmatched ids still close the position (FIFO).

Documented, no code: `strategy.risk.*` + ~37 v5 members missing; `calc_on_*`/`slippage`/`margin_*`/`use_bar_magnifier` parsed-not-honored (by design); dup-id reversed-direction modify semantics unverified (F7).

### Task 4 — B3 PineTS shim spike (executed 2026-10-09)

Step 0 collision check: `ta.tr`/`rsi`/`supertrend` all already exist in `ta.ts`; `registerBuiltin` is a plain `Map.set` — silent overwrite. Decision: register pilots under the SAME names (parity-first per plan NOTE), warn once per overwrite, test captures + restores originals (`pinetsShim.test.ts` `beforeAll`/`afterAll`). Production path untouched — `builtins/index.ts` does not import the shim.

Delivered: `src/pine/pinetsShim.ts` — `PtSeries` (upstream `Series.ts` semantics over our `contracts.Series`: `get(i)` = i bars ago, na → NaN, fractional lookback truncates), `PineTsCtx` facade (`idx`, `precision()` method — upstream signature `(value, decimals=10)`, `taState` in `ctx.state['pt|taState']` (per-RUN shared bag like upstream Context), `get()` verbatim-adapted, `data.{open,high,low,close,volume,openTime}`, `pine.{ta,syminfo}`, `ta` alias, `params`), verbatim-adapted ports of `tr` (:6-33), `rsi` (:5-117), `supertrend` (:28-187) with Source comments, `wrapPorted` (bindArgs → raw args → `_callId` = `rt.callsite`), `registerPortedTa()`.

Parity results (pinetsShim.test.ts, 5 tests green):
- `ta.tr`: ported == existing on bars ≥1 exactly (≤8dp); **bar-0 divergence** — pinets returns `high−low` for `handle_na=true` on a na `close[1]`, ours returns `na` (upstream comment inverts the v5 doc wording; our impl is the conservative read). Flagged: verify against live TV before any cutover.
- `ta.rsi`: ported == existing bar-for-bar (≤8dp), including the shared seed-bar convention (first value at bar `length`); `it.fails`-level divergence only on all-flat windows (pinets → 100, ours → na).
- `ta.supertrend`: tuple `[st, dir]` correct, dir flips on crafted reversal; ATR seeds at bar `atrPeriod-1` (counts tr from bar 0) vs ours `atrPeriod` — one-bar-earlier first value, documented.

Facade coverage over `ta/methods` (68 files, grep `context.<field>`):
- Covered: `taState` (58 files), `idx` (45), `precision` (33+), `data` (25), `get` (21), `pine` (4: hma/macd/mom via `pine.ta.*` — need sibling ports; vwap via `pine.syminfo.timezone` — covered), `ta` alias (hma), `params` (param.ts — field added).
- Uncovered: none on fields. `pine.ta.X` cross-calls create an ordering dependency tier: hma→wma, macd→ema, mom→change must be ported together or `pine.ta` must bridge to existing builtins.
- **~97% of methods need only the delivered facade**; remaining blockers are per-method semantics, not plumbing.

GO for full B3 — the port loop is mechanical (verbatim body + `Source:` comment + order tuple + a parity test). Recommended order: stateless (sma/stdev/variance/cog/correlation/median/mode…) → stateful rma-chain (ema/rma/atr) → composite (macd/hma/vwap needing `pine.ta`) → param.ts last.


---

## Task 1: "將此指標增加到整個版面" real implementation

**Blocked by:** None — can start immediately.

**Files:**
- Modify: `src/pages/velaPineEditor.ts:226-239` (the `toggleMoreMenu` items array)

**Interfaces:**
- Consumes: `WorkspaceWidgetContext.cells` (`@luxalgo/vela/workspace` — NOT re-exported by `/plugin`; import type from `@luxalgo/vela/workspace`), `cell.chart.runIndicator(source, opts)` → `{ok, handle, error}` never rejects.
- Produces: nothing exported; menu item functional.

**Assumptions:**
- The `ctx` passed to legend actions is a `WorkspaceWidgetContext` at runtime (verified: `legendActionsProviderFor(cell.chart, () => this.context())` hands workspace context). Cast: `(ctx as unknown as WorkspaceWidgetContext)`.
- `ind` param (`LegendIndicatorInfo`) has `id/title/source` only — inputs must come from the live handle via `ctx.chart.indicators().find(x => x.id === ind.id)?.inputValues()`.

**Done when:**
- `npx tsc --noEmit` (or repo's typecheck script) passes on the touched file
- Menu item no longer only toasts: on a 2-cell layout, running it on cell A's pine indicator produces a new indicator row on cell B's legend
- Source cell is skipped in the iteration (don't duplicate onto itself); cells already running the same `source` are skipped (dedup guard)
- `inputs` copied from source handle via `inputValues()`; `language:'pine'`, `title` preserved; NO `id` passed
- A cell whose `runIndicator` returns `{ok:false}` logs/continues — remaining cells still processed
- Toast reports the count, e.g. `已加入 N 個圖表`

- [ ] **Step 1: add the import**

At the top import block (anchor `import { svg16 } from "@luxalgo/vela/ui";`), add after it:

```ts
import type { WorkspaceWidgetContext } from "@luxalgo/vela/workspace";
```

- [ ] **Step 2: replace the stub item**

Anchor: `{ label: '將此指標增加到整個版面', run: () => {`

Original (verbatim, velaPineEditor.ts:235-239):

```ts
    { label: '將此指標增加到整個版面', run: () => {
        const h = ctx.chart.indicators().find(x => x.id === ind.id);
        if (!h?.source) return;
        try { ctx.toast?.(`已複製「${h.title}」到版面指標`, 'info'); } catch { /* no toast */ }
      } },
```

Replacement:

```ts
    { label: '將此指標增加到整個版面', run: () => {
        void (async () => {
          const h = ctx.chart.indicators().find(x => x.id === ind.id);
          if (!h?.source) return;
          const inputs = (() => { try { return h.inputValues(); } catch { return undefined; } })();
          const wctx = ctx as unknown as WorkspaceWidgetContext;
          const cells = wctx.cells ?? [];
          let added = 0;
          for (const cell of cells) {
            if (cell.chart === ctx.chart) continue;
            const live = cell.chart.indicators();
            if (live.some(x => x.source === h.source)) continue;
            try {
              const r = await cell.chart.runIndicator(h.source!, {
                language: 'pine', title: h.title, inputs,
              });
              if (r.ok) added++;
            } catch { /* one bad cell must not block the rest */ }
          }
          try { ctx.toast?.(added > 0 ? `已加入 ${added} 個圖表` : '其他圖表已有此指標或無可用圖表', 'info'); } catch { /* no toast */ }
        })();
        closeMoreMenu();
      } },
```

Notes for executor:
- `h.source!` is safe: guarded by `if (!h?.source) return`.
- Do NOT pass `id` — same-id on another chart resolves `ok:false` per AddIndicatorOptions docs.
- `closeMoreMenu()` exists in scope (defined ~L221); calling it matches the other items' UX (menu closes after action). If other items don't close it, match them — check `隱藏`/`移除` handlers; keep consistent.
- Persistence: `serializeCellScripts` (velaPineEditor.ts:109-135) reads live indicators at flush — indicators added via runIndicator get persisted automatically on unload/destroy. No extra write needed; flag for manual verify in smoke.

- [ ] **Step 3: typecheck + smoke**

```bash
cd /c/Users/bear9/OpenCharts && npx tsc --noEmit 2>&1 | grep velaPineEditor
```
Expected: no new errors in velaPineEditor.ts.

Manual smoke (record result in task report; if dev server not running, `npm run dev` in background, then drive via browser or just describe expected):
- 2×1 layout, add a user pine script to cell 0, open ⋯ → 將此指標增加到整個版面 → cell 1 legend shows the indicator, toast says 已加入 1 個圖表.
- Run it again → toast 其他圖表已有此指標 (dedup works).
- Reload page → both cells still show it (persistence through cell-ext flush).

- [ ] **Step 4: commit**

```bash
git add src/pages/velaPineEditor.ts
git commit -m "feat(vela): legend menu 'add to entire layout' actually runs indicator on sibling cells"
```

---

## Task 2: `security_lower_tf` — real-bars-only granularity (D2 = B)

**Blocked by:** None (code-wise independent of Task 1). **T2 gate:** only execute after user confirms D2=B.

**Files:**
- Modify: `src/pine/mtf.ts:1768-1811` (the `if (spec.isLtf)` block)
- Modify: `src/pine/__tests__/mtf.test.ts:1552-1597` (two tests pin old semantics — rewrite, don't delete assertions wholesale)

**Interfaces:**
- Consumes: `tfBarAtOrBefore(bars, t)`, `bars[i].openTime`, `evalAt(spec, expr, j)`, `spec.warmed` warmup — all unchanged.
- Produces: same return shape `{kind:'array', v: Value[]}` — length now = count of existing lower bars, possibly 0.

**Assumptions:** None.

**Done when:**
- `npx vitest run src/pine/__tests__/mtf.test.ts` → all PASS
- Sparse feed: chart bar window with bars at slot0 and slot2 → array `[v0, v2]` (length 2, no na)
- Empty window → `[]` (length 0), NOT `[na,na,na]`
- Dense feed unchanged: `[103,104,105]` still
- Tuple expr on sparse feed → `[ [c0,o0], [c2,o2] ]` length 2
- The `chartDur` nominal-duration logic (weekend gap) is UNTOUCHED — it still bounds the window; only the per-slot emission changes

- [ ] **Step 1: rewrite the isLtf emission loop**

Anchor: `// security_lower_tf: one array element per NOMINAL tf slot inside the`

Original (verbatim, mtf.ts:1769-1811):

```ts
    const end = t0 + chartDur;
    const lt = tfBarAtOrBefore(bars, t0);
    // First bar whose openTime lies inside the window — bars starting before
    // t0 (a sparse bar straddling the chart open) already emitted under the
    // previous chart bar and must not be repeated.
    let bi = lt >= 0 && bars[lt]!.openTime === t0 ? lt : lt + 1;
    // Last bar this window can reference: openTime < end.
    const lastIn = tfBarAtOrBefore(bars, end - 1);
    // Warm-up: a gated first call creates the frame mid-series — replay tf
    // bars 0..lastIn once so strict-window exprs (ta.sma needs L bars of real
    // history) see the same history an ungated run produced. nodeCache makes
    // each eval a one-shot; cost is the work an ungated run does anyway.
    if (!spec.warmed) {
      for (let w = 0; w <= lastIn; w++) for (const e of spec.exprs) evalAt(spec, e, w);
      spec.warmed = true;
    }
    // evalAt wraps series results in SecSeries for chart-anchored [n] access;
    // inside the array payload consumers read raw values, so unwrap to the
    // tf-bar-j2 scalar.
    const scalarAt = (e: Node, j2: number): Value => {
      const v = evalAt(spec, e, j2);
      return v.kind === 'series' ? v.v.cur() : v;
    };
    const out: Value[] = [];
    // bi advances monotonically while slots step forward → O(slots + bars).
    for (let slot = tfFloor(t0, tf); slot < end;) {
      const slotEnd = tfNext(slot, tf);
      if (slotEnd <= slot) break;            // unparseable tf — no progress
      if (slotEnd > t0) {                    // slots fully before t0 belong to the prior bar
        let j2 = -1;                         // last tf bar opening inside this slot
        const lim = Math.min(slotEnd, end);
        while (bi < bars.length && bars[bi]!.openTime < lim) j2 = bi++;
        out.push(
          j2 < 0 ? NA :
          spec.exprs.length === 1
            ? scalarAt(spec.exprs[0]!, j2)
            : { kind: 'array', v: spec.exprs.map(e => scalarAt(e, j2)) },
        );
      }
      slot = slotEnd;
    }
    return { kind: 'array', v: out };
  }
```

Replacement — one element per existing lower bar (TV semantics; PineTS reference: `pinets-src/src/namespaces/request/methods/security_lower_tf.ts` pushes only bars whose open ∈ [t0, end)):

```ts
    const end = t0 + chartDur;
    const lt = tfBarAtOrBefore(bars, t0);
    // First bar whose openTime lies inside the window — bars starting before
    // t0 (a sparse bar straddling the chart open) already emitted under the
    // previous chart bar and must not be repeated.
    let bi = lt >= 0 && bars[lt]!.openTime === t0 ? lt : lt + 1;
    // Last bar this window can reference: openTime < end.
    const lastIn = tfBarAtOrBefore(bars, end - 1);
    // Warm-up: a gated first call creates the frame mid-series — replay tf
    // bars 0..lastIn once so strict-window exprs (ta.sma needs L bars of real
    // history) see the same history an ungated run produced. nodeCache makes
    // each eval a one-shot; cost is the work an ungated run does anyway.
    if (!spec.warmed) {
      for (let w = 0; w <= lastIn; w++) for (const e of spec.exprs) evalAt(spec, e, w);
      spec.warmed = true;
    }
    // evalAt wraps series results in SecSeries for chart-anchored [n] access;
    // inside the array payload consumers read raw values, so unwrap to the
    // tf-bar-j2 scalar.
    const scalarAt = (e: Node, j2: number): Value => {
      const v = evalAt(spec, e, j2);
      return v.kind === 'series' ? v.v.cur() : v;
    };
    const out: Value[] = [];
    // TV semantics: one element per EXISTING lower bar inside [t0, end) —
    // missing bars are skipped, the array length varies with the feed.
    // (PineTS reference: request/methods/security_lower_tf.ts emits only
    // sOpen ∈ [openTime, closeTime) bars; no na padding.)
    while (bi < bars.length && bars[bi]!.openTime < end) {
      const j2 = bi++;
      out.push(
        spec.exprs.length === 1
          ? scalarAt(spec.exprs[0]!, j2)
          : { kind: 'array', v: spec.exprs.map(e => scalarAt(e, j2)) },
      );
    }
    return { kind: 'array', v: out };
  }
```

Also update the block comment above `const end` (lines 1769-1773): replace the nominal-slot description with the real-bars contract.

- [ ] **Step 2: rewrite the two pinned tests**

Anchor: `it('security_lower_tf pads missing lower bars with na (nominal slot count)'` (mtf.test.ts:1552).

Rewrite as real-bars-only:

```ts
  it('security_lower_tf emits only existing lower bars — no na padding', async () => {
    // Chart 15m, lower tf 5m → up to 3 slots, but TV emits only bars that
    // exist. bar0 window has bars at 0m and 10m only → [100, 102] (len 2).
    const m5 = 300_000;
    const chartBars = mkBars(3, M15, 0);
    const tf5: BarData[] = [
      { openTime: 0, open: 0, high: 1, low: -1, close: 100, volume: 1 },
      { openTime: 2 * m5, open: 0, high: 1, low: -1, close: 102, volume: 1 },
      { openTime: 3 * m5, open: 0, high: 1, low: -1, close: 103, volume: 1 },
      { openTime: 4 * m5, open: 0, high: 1, low: -1, close: 104, volume: 1 },
      { openTime: 5 * m5, open: 0, high: 1, low: -1, close: 105, volume: 1 },
      // bar2 window [30m, 45m): no bars at all → []
    ];
    const body = [assign('x', call(member(ident('request'), 'security_lower_tf'),
      str(''), str('5'), ident('close')))];
    const { values } = await runSecurity(body, chartBars, '15', { '|5': tf5 });
    const cell = (i: number): (number | 'na')[] =>
      values[i]!.kind === 'array' ? values[i]!.v.map(valOf) : [];
    expect(cell(0)).toEqual([100, 102]);           // missing 5m slot skipped
    expect(cell(1)).toEqual([103, 104, 105]);
    expect(cell(2)).toEqual([]);                   // empty window → empty array
  });
```

Anchor: `it('security_lower_tf tuple expr pads na per slot'` (mtf.test.ts:1578).

Rewrite:

```ts
  it('security_lower_tf tuple expr emits one inner array per existing bar', async () => {
    const m5 = 300_000;
    const chartBars = mkBars(1, M15, 0);
    const tf5: BarData[] = [
      { openTime: 0, open: 10, high: 1, low: -1, close: 100, volume: 1 },
      { openTime: 2 * m5, open: 30, high: 1, low: -1, close: 102, volume: 1 },
    ];
    const body = [assign('x', call(member(ident('request'), 'security_lower_tf'),
      str(''), str('5'), arraylit([ident('close'), ident('open')])))] ;
    const { values } = await runSecurity(body, chartBars, '15', { '|5': tf5 });
    const arr = values[0]!;
    expect(arr.kind).toBe('array');
    if (arr.kind !== 'array') return;
    expect(arr.v.length).toBe(2);                  // two existing bars, not three slots
    const [e0, e1] = arr.v;
    expect(e0!.kind === 'array' ? (e0 as { kind: 'array' }).v.map(valOf) : []).toEqual([100, 10]);
    expect(e1!.kind === 'array' ? (e1 as { kind: 'array' }).v.map(valOf) : []).toEqual([102, 30]);
  });
```

Also check the Fri→Mon nominal-duration test (mtf.test.ts:1401-1422): it pins `lens=[24,24,24,24]` on a DENSE hourly feed — under real-bars it still holds (all 24 hours exist). Leave it; add a comment noting density assumption if executor finds the assertion ambiguous.

- [ ] **Step 3: run tests**

```bash
npx vitest run src/pine/__tests__/mtf.test.ts
```
Expected: all PASS (the two rewritten + everything else).

```bash
npx vitest run src/pine/__tests__/
```
Expected: full suite green — watch for other tests that consumed na-padded arrays (e.g. array.size assertions on ltf output).

- [ ] **Step 4: commit**

```bash
git add src/pine/mtf.ts src/pine/__tests__/mtf.test.ts
git commit -m "fix: security_lower_tf emits existing intrabars only (TV semantics; drop nominal-slot na padding)"
```

---

## Task 3: `strategy.*` QA / review pass

**Blocked by:** None.

**Files:**
- Read: `src/pine/builtins/strategy.ts`, `src/pine/builtins/strategyEquity.ts`, relevant `src/pine/__tests__/*.test.ts`
- Create/Modify: findings appended to `docs/superpowers/plans/2026-10-09-backlog-phase2.md` Review Ledger + optionally `docs/strategy-qa-2026-10-09.md`
- Add: regression tests ONLY for confirmed bugs found (into the existing `src/pine/__tests__/` conventions)

**Interfaces:**
- Consumes: nothing.
- Produces: a findings list (severity-tagged), plus tests for any Critical/Important correctness gap that can be pinned without engine changes.

**Assumptions:** strategy sim is a lazy order-replay ledger (`simAt`) over ctx OHLC; decl args slippage/margin/calc_on_* are parsed but ignored (scout-verified).

**Done when:**
- Every `strategy.*` builtin registered in strategy.ts is listed: implemented-vs-Pine-v5-spec gap table
- Known gaps documented: `strategy.risk.*` family missing, slippage/margin ignored, `calc_on_*` flags parsed-not-honored
- Any NEW behavioral bug found gets: severity tag + file:line + minimal repro sketch
- Regression test added for each Critical/Important bug (test-first: red → confirm red → report; fixing the engine is OUT OF SCOPE unless the fix is ≤20 lines and self-contained)
- `npx vitest run src/pine/__tests__/` stays green

- [ ] **Step 1: inventory builtins**

```bash
grep -n "registerBuiltin('strategy'" src/pine/builtins/strategy.ts src/pine/builtins/strategyEquity.ts
```
List every name; compare against Pine v5 strategy namespace (entry/exit/close/order/cancel/cancel_all/close_all/risk.allow_entry_in/risk.max_*/position_size/position_avg_price/opentrades.*/closedtrades.*/equity/openprofit/grossprofit/…). Produce the table.

- [ ] **Step 2: behavioral probes**

Write `scratch/_strategy_qa.mjs` (reuse the existing scratch runner pattern — look at `scratch/_qa_parity_round2.mjs` for how tests drive the interpreter). Probe:
- `strategy.position_size` after a same-bar entry+exit ordering edge
- duplicate `strategy.entry` id semantics (modify-in-place, strategy.ts:355)
- `strategy.close` when no position
- `strategy.equity`/`closedtrades.*` consistency vs a hand-computed 3-trade case
- `calc_on_order_fills`/`process_orders_on_close` decl args: confirm they parse and are ignored (assert parse acceptance, not behavior)
- OCA groups (`oca_name`): implemented? check

- [ ] **Step 3: write findings + regression tests**

For each confirmed divergence: one vitest in `src/pine/__tests__/` (follow existing file conventions — add to the file that already covers strategy, or `strategy.test.ts` if present). Red-test = acceptable deliverable for Critical bugs the plan doesn't own fixing; document as `xtest`/failing-with-comment per repo convention — check how existing known-bad cases are marked first (`grep -rn "xit\|xtest\|test.skip\|\.todo" src/pine/__tests__/ | head`).

- [ ] **Step 4: report + commit**

Append findings to the Review Ledger of this plan file. Commit tests/docs:

```bash
git add src/pine/__tests__/ docs/superpowers/plans/2026-10-09-backlog-phase2.md docs/strategy-qa-2026-10-09.md
git commit -m "test: strategy.* QA round — findings + regression pins"
```

---

## Task 4: B3 spike — PineTS method port via context facade

**Blocked by:** None.

**Files:**
- Create: `src/pine/pinetsShim.ts`
- Test: `src/pine/__tests__/pinetsShim.test.ts`
- Read-only reference: `C:/Users/bear9/pinets-src/src/namespaces/ta/methods/{tr,rsi,supertrend,highest}.ts`, `src/Series.ts`, `src/Context.class.ts`

**Interfaces:**
- Consumes: `registerBuiltin(ns, name, fn)` (registry.ts), `BuiltinCtx` (contracts.ts:182-199), `Value` union (contracts.ts:13-26), `Series` (contracts.ts:59+), `stateFor(ctx, parts, make)` + `vsOf/vseries/vstate` (ta.ts:139-226), `bindArgs`/`numArg`/`unwrapped` (util.ts).
- Produces:
  ```ts
  // pinetsShim.ts
  export interface PineTsCtx {            // the facade a ported method sees
    idx: number;
    precision: number;
    taState: Record<string, unknown>;     // per-callsite state bag
    get(series: PineTsSeriesLike, i: number): number;
    data: { open: …; high: …; low: …; close: …; volume: …; openTime: … };
    pine: { ta: Record<string, unknown>; syminfo: Record<string, unknown> };
  }
  export function adaptSeries(v: Value, ctx: BuiltinCtx): PineTsSeriesLike;   // BarSeries → get(i) adapter
  export function makePineTsCtx(ctx: BuiltinCtx): PineTsCtx;
  export function registerPortedTa(): void;   // self-registers tr/rsi/supertrend (skip-if-exists on collision)
  ```

**Assumptions:**
- PineTS `Series.get(i)` reads `data[data.length-1-i]` (i bars ago); our adapter maps to `barSeries.get(ctx.barIndex - i)` unwrapped to number, `na` → `NaN`.
- `_callId` analogue = our callsite key (`emaTag`-style `${callsite}|…`); the shim scopes `taState` per callsite so ported methods' state isolation matches existing semantics.
- Methods return scalars or `[[tuple]]`; wrap scalars into our `Value` (`{kind:'float'|'int', v}`), tuple arrays into `{kind:'array'}`.
- commit/rollback semantics in PineTS (`taState` tentative-then-commit) map to: our per-bar loop calls builtins once per bar in-order; the ported method can commit immediately (no rollback path needed) — verify against rsi's usage before assuming; if rollback IS load-bearing, snapshot taState at bar start inside the facade.

**Done when:**
- `npx vitest run src/pine/__tests__/pinetsShim.test.ts` → all PASS
- `ta.tr(true)`, `ta.rsi(close,14)`, `ta.supertrend(3,10)` callable from a pine script via the ported impl — each checked against a hand-computed 5-10 bar expected series in the test
- Pilot ports live in pinetsShim.ts verbatim-adapted from pinets-src (comment each with source path + line range)
- Report appended to Review Ledger: coverage estimate of facade across `ta/` (grep `context\.` fields used by ~10 method files), remaining blockers for the other ~65 ta methods
- Full suite stays green

- [ ] **Step 0: collision check**

```bash
grep -n "registerBuiltin\|registerConstant" src/pine/builtins/registry.ts | head -20
```
Confirm overwrite-vs-skip semantics of re-registering `ta.rsi`. If `registerBuiltin` silently overwrites, the spike MUST register under distinct names first (`ta.rsi_pt` …) OR accept overwrite with a console.warn — record which in the report. NOTE: if tr/rsi/supertrend already exist in ta.ts (likely — check `grep -n "'tr'\|'rsi'\|'supertrend'" src/pine/builtins/ta.ts`), then the spike instead ports them under the SAME name to prove parity, and the test asserts ported-output == existing-builtin-output on identical input (strongest parity check).

- [ ] **Step 1: write the failing test**

```ts
// src/pine/__tests__/pinetsShim.test.ts
// Pattern: build a small BarData[] via the same helpers mtf.test.ts uses
// (mkBars / runSecurity exist in that file — check exports or copy minimal
// driver: runScript over N bars, collect plot('x') values).
//
// Assert: ported ta.tr on a known 8-bar series equals hand-computed TR.
// Assert: ported ta.rsi(close,14) equals our existing ta.rsi output bar-for-bar
//         (parity test — the real value of the shim).
// Assert: ported ta.supertrend(3,10) returns per-bar tuple [st, dir] with
//         dir flipping on the crafted crossover bar.
```

- [ ] **Step 2: run → RED**

`npx vitest run src/pine/__tests__/pinetsShim.test.ts` → fails (module doesn't exist).

- [ ] **Step 3: implement the facade + pilots**

Skeleton (executor fills verbatim ported bodies from pinets-src):

```ts
// src/pine/pinetsShim.ts
// PineTS context facade — lets pinets-src namespace methods run inside our
// BuiltinCtx. Source: C:/Users/bear9/pinets-src/src (v0.11.0, AGPL-3.0 —
// ported method bodies carry the upstream provenance comment).
import { registerBuiltin } from './builtins/registry';
import type { BuiltinCtx, Value } from './contracts';
// … Series adapter: class PtSeries extends … override get(i) →
//   unwrap(ctx.barIndex - i) via the backing BarSeries; na → NaN.
// … makePineTsCtx(ctx): { idx: ctx.barIndex, precision, taState: stateFor(ctx,['pt',callsite]), get, data:{…adapted OHLCV PtSeries}, pine:{ta:{},syminfo:ctx.syminfo} }
// … ported tr (pinets-src ta/methods/tr.ts:1-35), rsi (:1-113), supertrend (:1-175)
export function registerPortedTa(): void { /* registerBuiltin('ta','tr_pt', portedTr) … */ }
```

Wire-in: import+call `registerPortedTa()` once — check `src/pine/builtins/index.ts` for where builtin modules self-register; add `import '../pinetsShim'` ONLY in the test file for the spike (do NOT load in production path yet — spike output is feasibility, not default-on).

- [ ] **Step 4: run → GREEN, then parity check**

`npx vitest run src/pine/__tests__/pinetsShim.test.ts` → PASS; `npx vitest run src/pine/__tests__/` → green.

- [ ] **Step 5: report + commit**

Report (into Review Ledger): facade coverage % over `ta/methods` (count `context.<field>` usage), methods needing fields beyond the 6, estimated port cost per tier, GO/NO-GO for full B3.

```bash
git add src/pine/pinetsShim.ts src/pine/__tests__/pinetsShim.test.ts docs/superpowers/plans/2026-10-09-backlog-phase2.md
git commit -m "feat(pine): pinets-src context facade + pilot ports (tr/rsi/supertrend) — B3 spike"
```

---

## Deferred (recorded, not planned)

- **B4 — Vela worker 化**: interpreter boundary is clean (`engine.ts:execute` → `runScript(parsed, BarData[], RunOptions) → RunResult`); fetchSeries RPC only needed during prefetch; `Value` union in `plots` can embed non-cloneable objects (sanitize on marshal); no `new Worker` exists in repo today. Scope: M. Revisit after T4 report lands.
- **Menu phase-3 items**: 新增快訊 (needs alert engine — possibly tradingview MCP?), 視覺順序/移動到/固定至刻度 submenus, 物件樹 side panel, editor ⋯ (settings/palette/logs), Publish (n/a local).
- **scratch/ cleanup**: 8 one-off probes (`_b1_*`, `_prof_*`, `_qa_*`, `gate-rate.mjs`, `perf-probe.mjs`) — batch-delete in a chore commit once phase-2 lands.
- **strategy.risk.* impl**: pending T3 findings.
