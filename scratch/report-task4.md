# Task 4 — B3 PineTS shim spike — report

Status: DONE — verdict GO (see ledger).

## What changed

- `src/pine/pinetsShim.ts` (new, ~570 lines):
  - `PtSeries` — upstream `Series.ts:1-56` semantics: `get(i)` reads i bars
    ago, `na`→NaN, fractional lookback truncates, `beforeStart` on pre-history.
    Two backing modes: materialized array (verbatim upstream) and live
    read-through into our `contracts.Series`.
  - `PineTsCtx` facade: `idx` ← `ctx.barIndex`; `precision(v, d=10)` verbatim
    (method, not a field — plan sketch differed); `taState` in
    `ctx.state['pt|taState']` (per-RUN shared bag = upstream Context lifetime);
    `get()` verbatim-adapted from `Context.class.ts:826-855`; `data.{open,high,
    low,close,volume,openTime}` as PtSeries; `pine.{ta,syminfo}`; `ta` alias;
    `params` store.
  - Ported pilots with `Source:` comments: `tr` (tr.ts:6-33), `rsi`
    (rsi.ts:5-117), `supertrend` (supertrend.ts:28-187) — bodies verbatim
    modulo `unknown` typings and `as number` reads on `context.get`.
  - `wrapPorted`/`registerPortedTa` — registers under the REAL `ta.*` names.
- `src/pine/__tests__/pinetsShim.test.ts` (new): 5 tests — hand-computed tr,
  tr parity (bars ≥1), rsi bar-for-bar parity vs the displaced builtin,
  supertrend tuple + direction flip, runScript end-to-end parity.
- Plan file Review Ledger: Task 4 section with coverage + GO/NO-GO.

## Step-0 collision check (plan requirement)

`tr`/`rsi`/`supertrend` all exist in `ta.ts` → same-name registration +
parity assertions chosen per the plan's NOTE (strongest check).
`registerBuiltin` silently overwrites (Map.set) — the shim warns once per name
and the test restores displaced originals in `afterAll`. Production path NOT
wired: `builtins/index.ts` unchanged; test imports `registerPortedTa` directly.

## Test output

`npx vitest run src/pine/__tests__/pinetsShim.test.ts`:
```
✓ src/pine/__tests__/pinetsShim.test.ts (5 tests) 56ms
Test Files  1 passed (1) — Tests  5 passed (5)
```
`npx tsc --noEmit | grep pinetsShim` → clean.

## Divergences found (documented in ledger)

- `ta.tr` bar 0: pinets `handle_na=true` → `high−low`; ours → `na`. Bars ≥1
  identical. Verify against live TV before any cutover (upstream's own comment
  reads inverted vs the v5 reference).
- `ta.rsi` all-flat windows: pinets → 100; ours → na. Non-flat paths identical.
- `ta.supertrend` ATR seeds one bar earlier (counts tr from bar 0).

## Concerns

- `pine.ta.*` cross-call tier (hma/macd/mom/vwap) needs sibling ports or a
  bridge to existing builtins — ordering dependency only.
- pinets-src untouched (read-only) ✓; no package.json changes ✓.
