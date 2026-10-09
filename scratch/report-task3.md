# Task 3 — strategy.* QA pass — report

Status: DONE_WITH_CONCERNS (two confirmed TV divergences pinned as `it.fails` —
fixes need per-leg entry-id plumbing, >20 lines → deferred per plan).

## What changed

- `src/pine/builtins/strategy.ts`:
  - `ENTRY/EXIT/ORDER/CLOSE_ORDER` realigned to Pine v5 signatures; `when`
    demoted to named-only (still honored, non-positional); new `CLOSE_ALL_ORDER`
    (v5: comment first — positional `close_all("x")` was binding to dead `id`).
  - `resolveQty`: `kind==='close'` no longer returns the whole position
    unconditionally — honors `qty`/`qty_percent` (v5 params).
  - `regClosed`: `rows[i]` chronological (v5: trade_num 0 = first closed
    trade) — was most-recent-first.
  - `applyFill`: `closing` gated on opposing direction (same-direction entries
    no longer consume open legs — found mid-fix: legs vanished, closed rows
    phantom-pushed without counting); realized PnL booked per-leg at leg price;
    `closedTrades` per consumed leg; `openTrades`/`avgEntry` re-derived from
    live `openLegs` each fill.
  - `strategy.exit`: `oca_name`/`oca_type` wired (v5 signature has them).
- `src/pine/__tests__/strategy.test.ts`: two stale tests corrected to
  chronological `closedtrades` ordering; +8 QA tests (6 green, 2 `it.fails`).
- `docs/strategy-qa-2026-10-09.md`: full findings doc (inventory, gap table,
  severities, repro).
- `scratch/_strategy_qa.mjs`: probe harness (vite-node).
- Plan file Review Ledger: Task 3 section appended.

## Test output

`npx vitest run src/pine/__tests__/` (post-fix):
```
Test Files  35 passed (35)
     Tests  648 passed | 1 skipped (649)
```
strategy.test.ts: 37 tests, all green (the 2 `it.fails` pins fail as designed
and count toward the suite staying green).

## Confirmed bugs

| # | Severity | Bug | Disposition |
|---|---|---|---|
| F1 | Important | `close(id)`/`exit(from_entry)` ignore entry-id matching (unmatched ids still flatten) | pinned `it.fails`, deferred (>20-line fix) |
| F2 | Important | `close` ignored qty/qty_percent | FIXED + regression tests |
| F3 | Important | `closedtrades.*` reversed indexing | FIXED + corrected 2 stale tests |
| F4 | Important | same-dir fills ate open legs; stale avgEntry/openTrades; realized PnL at blended avg | FIXED + regression tests |
| F5 | Important | v5 positional arg misbinding (`when` positional; `close_all` shared CLOSE_ORDER) | FIXED + regression tests |

## Concerns

- F7 (dup entry id with reversed direction creates a second pending order):
  unverified against live TV — documented, not pinned.
- `when=` named arg still accepted post-deprecation (harmless superset).
- strategy.risk.* family + ~37 v5 members absent — feature gaps, not bugs.
