# strategy.* QA findings — 2026-10-09

QA pass over `src/pine/builtins/strategy.ts` + `strategyEquity.ts`, per
`docs/superpowers/plans/2026-10-09-backlog-phase2.md` Task 3.
Probe harness: `scratch/_strategy_qa.mjs` (vite-node, drives parse → runScript).

## Inventory vs Pine v5 `strategy.*` namespace

### Implemented (present + reachable)

| Member | Kind | Notes |
|---|---|---|
| `strategy.entry` | fn | qty/qty_percent/limit/stop/oca_name/oca_type/comment honored |
| `strategy.exit` | fn | from_entry stored but **not matched** (F1); profit/loss/trail_* honored |
| `strategy.order` | fn | same machinery as entry |
| `strategy.close` | fn | id stored but **not matched** (F1); qty/qty_percent honored after F2 fix |
| `strategy.close_all` | fn | flattens position |
| `strategy.cancel` / `cancel_all` | fn | pending orders only; bare cancel warns |
| `strategy.position_size` / `position_avg_price` | var | avg re-derives from open legs after F4 fix |
| `strategy.equity` / `openprofit` / `netprofit` / `grossprofit` / `grossloss` | var | mark-to-market at bar close |
| `strategy.opentrades` / `closedtrades` | var | counts of open legs / closed legs |
| `strategy.opentrades.{entry_bar_index,entry_price,entry_time,size,commission}` | fn | trade_num 0 = oldest open leg |
| `strategy.closedtrades.{entry_bar_index,entry_price,entry_time,exit_bar_index,exit_price,exit_time,profit,size,commission}` | fn | trade_num 0 = **first** closed trade (F3 fix) |
| `strategy.max_drawdown` | var | strategyEquity.ts, mark-to-market peak-to-trough |
| `strategy.{long,short,fixed,percent_of_equity,cash}` | const | |
| `strategy.direction.{long,short,all}` | const | |
| `strategy.commission.{percent,cash_per_contract,cash_per_order}` | const | |
| `strategy.oca.{none,cancel,reduce}` (+ `strategy.order.*` aliases) | const | |
| `strategy(...)` decl | — | see "decl args" below |

### Missing vs v5 (feature gaps, documented — not bugs)

- `strategy.risk.*` whole family: `allow_entry_in`, `max_cons_loss_days`,
  `max_drawdown`, `max_intraday_filled_orders`, `max_intraday_loss`,
  `max_position_size` — calls produce `unknown constant 'strategy.risk'` warnings.
- Currency/percent rollups: `grossprofit_percent`, `grossloss_percent`,
  `netprofit_percent`, `openprofit_percent`, `max_drawdown_percent`,
  `max_runup`, `max_runup_percent`, `wintrades`, `losstrades`, `eventrades[.size]`,
  `initial_capital`, `margin_liquidation_price`, `convert_to_account`,
  `convert_to_symbol`.
- Per-trade fields: `entry_id`, `exit_id`, `entry_comment`, `exit_comment`,
  `profit_percent`, `max_drawdown[_percent]`, `max_runup[_percent]` on both
  `closedtrades.*` and `opentrades.*`.

### `strategy(...)` decl args

| Arg | Status |
|---|---|
| `initial_capital`, `currency`, `pyramiding`, `default_qty_type/value`, `commission_type/value`, `process_orders_on_close` | **honored** (process_orders_on_close fills at bar close — verified by test) |
| `calc_on_order_fills`, `calc_on_every_tick`, `use_bar_magnifier` | parsed, ignored (no intra-bar engine) — matches plan assumption |
| `slippage`, `margin_long`, `margin_short`, `backtest_fill_limits_assumption`, `risk_free_rate`, `close_entries_rule` | parsed, ignored |
| `max_*_count` quotas | parsed → `declDrawQuotas` (draw.ts) |
| `title/shorttitle/overlay/format/precision/scale/explicit_plot_zorder` | parsed for metadata |

## Behavioral findings

Severity: **Critical** = wrong trades/numbers on normal scripts; **Important** =
correctness gap on common-but-not-universal patterns; **Minor** = edge/unknown.

### F1 — Important (pinned, fix deferred): `strategy.close(id)` / `strategy.exit(from_entry)` never match entry ids

`TradeLeg`/`ClosedTrade` carry no entry id; the replay ledger consumes legs
FIFO regardless of the order's `id`/`fromEntry`. Consequences, probed:

- `strategy.close("NOPE")` with a long "L" open → still flattens (`strategy.ts`
  `resolveQty`/`fillDir` never inspect `o.id`). TV: no-op.
- `strategy.exit("X", from_entry="NOPE")` → still exits the position. TV: the
  exit binds to the named entry; no matching open entry → no fill.
- With pyramiding, `strategy.close("A")` closes FIFO (oldest leg), not the
  entry named A.

Fix needs per-leg `entryId` plumbing through `TradeLeg`, FIFO consumption
filtered by `o.id`/`fromEntry`, and close-id → leg matching — >20 lines,
deferred. Pinned as `it.fails` regression tests in
`src/pine/__tests__/strategy.test.ts` ("strategy QA 2026-10-09" describe).

### F2 — FIXED: `strategy.close` ignored `qty`/`qty_percent`

`resolveQty` returned the full position for `kind==='close'` before checking
qty args. v5 `close(id, comment, qty, qty_percent, …)` supports partial
closes. Fix: removed the early `return pos`; close shares the exit branch.
Regression tests: "strategy.close honors qty", "honors qty_percent".

### F3 — FIXED: `strategy.closedtrades.*` indexed most-recent-first

`regClosed` used `rows[rows.length-1-i]`. Pine v5 numbers closed trades
chronologically (`trade_num` 0 = first closed trade; last = `strategy.closedtrades
- 1`). Fix: `rows[i]`. Existing test "index 0 = most recent" pinned the wrong
order — corrected to chronological, plus the runScript accessor test.

### F4 — FIXED: same-direction fills consumed open legs + stale `avgEntry`/`openTrades`

Two intertwined ledger bugs in `applyFill`:

- `closing = min(|match|, |sim.qty|)` ran the FIFO consume for **any** fill
  while positioned — including same-direction entries, which "closed" legs
  (pushing phantom `closed` rows) while `sim.qty` still grew. Now gated:
  `closing` only when `sign(match) !== sign(sim.qty)`.
- `avgEntry` was a blend kept at entry and never revised on partial exits, and
  `openTrades` incremented on entries but never decremented. Post-fix:
  `openTrades = openLegs.length` and `avgEntry = Σ leg.qty·leg.price / Σ leg.qty`
  re-derived after every fill — TV's "average entry price of open trades".
- Realized PnL booked at blended `avgEntry` instead of the consumed leg's
  price; now booked per leg inside the FIFO loop, so `netprofit` (Σ leg
  profits) equals `realizedPnl` exactly and `closedtrades.profit` is leg-exact.
- `closedTrades` now increments per fully-consumed leg (inside the loop)
  instead of the batch `Math.max(1, openTrades)` at flat.

Regression tests: "position_avg_price re-derives from remaining legs",
"equity is continuous across a partial exit", plus existing suite.

### F5 — FIXED: v5 positional arg order for entry/exit/order/close/close_all

`ENTRY_ORDER`/`EXIT_ORDER`/`ORDER_ORDER`/`CLOSE_ORDER` carried `when` (and for
close, `immediately`) mid-signature; `close_all` reused `CLOSE_ORDER`, binding
positional arg0 to a dead `id` slot. v5 signatures (TV reference):

- `entry(id, direction, qty, limit, stop, oca_name, oca_type, comment, …)`
- `exit(id, from_entry, qty, qty_percent, profit, limit, loss, stop, trail_price,
  trail_points, trail_offset, oca_name, oca_type, comment, …)`
- `order(id, direction, qty, limit, stop, oca_name, oca_type, comment, …)`
- `close(id, comment, qty, qty_percent, alert_message, immediately, …)`
- `close_all(comment, alert_message, immediately, …)`

`when`/`comment_disabled` remain bindable as named args (bindArgs accepts any
named key) but no longer consume positional slots. `strategy.exit` also gained
`oca_name`/`oca_type` wiring (they're in the v5 signature and the OCA
machinery already existed).

### F6 — Verified correct (probes P1/P2/P11)

- Same-bar entry+close: both settle at next bar's open → net flat. ✓ TV.
- Duplicate pending entry id → modifies in place (qty/limit/stop via `mod`). ✓
- OCA groups: `oca.cancel` retires siblings on first fill (existing test +
  probe). ✓ `oca.reduce` implemented.
- `calc_on_order_fills`/`calc_on_every_tick` parse and are ignored; declared
  but un-honored per design (no intra-bar replay). ✓ documented.
- Fill model: next-bar open default, same-bar close for `process_orders_on_close`
  / `immediately`, limit/stop OCO pair with conservative worse-price fill,
  gap-through-open adjustment, trailing-stop arming. ✓ covered by existing tests.

### F7 — Minor / unverified: duplicate pending id with reversed direction

`dupe` match requires `p.dir === o.dir`; a same-id reversed-direction entry
creates a second pending order (both may fill → e.g. net −1 after two entries).
TV's modify semantics don't clearly cover direction changes (docs list
qty/limit/stop as modifiable). Both interpretations are defensible; flagged,
not pinned — needs a live-TV check.

### F8 — Minor: `when=` named arg still accepted

v5 deprecated `when` on all order calls (use `if`); we still honor `when=`
named for v4-style scripts. Harmless superset; noted for the record.

## Repro commands

```bash
npx vite-node scratch/_strategy_qa.mjs        # behavioral probes
npx vitest run src/pine/__tests__/strategy.test.ts
npx vitest run src/pine/__tests__/
```
