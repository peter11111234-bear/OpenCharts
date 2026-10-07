# TV-Alignment Durable Pipeline

**Purpose:** keep the TradingView-alignment work moving across sessions. Every round follows the same protocol; progress lives in `PROGRESS.md` (log) + this file (plan/ledger). A new session reads both and continues.

**Source of truth:** `PROGRESS.md` tail + `docs/superpowers/plans/2026-10-05-tv-alignment.md` + this file.

## Operating protocol (every round)

1. **Plan** — read `PROGRESS.md` tail + GapConverge P0–P2 ledger (below); pick the next slice.
2. **Dispatch** — fan to subagents. 4 built-in (`task`, `reviewer`) for core slices + free-model (`commandcode-plan/inclusionai/ling-3.1-flash:free`, `opencode-zen/muse-spark-1.3-contributor-free`) for mechanical slices. File-region ownership is declared per agent; `mtf.ts` / `strategy.ts` are single-owner.
3. **Land** — agents write code + tests; parent integrates, runs scoped suites (`npx vitest run src/pine/__tests__/<file>.test.ts -t "<name>"`).
4. **Verify** — `npx vitest run src/pine` full green + golden compare.
5. **Regen golden** — `UPDATE_GOLDEN=1 npx vitest run src/pine/__tests__/golden.test.ts` after every landed round (output-shifting changes: fills dedup, arg aliases, security warm-up, etc.).
6. **Persist** — append a `PROGRESS.md` entry (what landed, pending, debts) + update this ledger → handoff-ready.

## Round ledger

| Round | Content | State |
|---|---|---|
| R1–R3 | Plan 13 tasks + adversarial review + gap fixes (draw/polyline/table.all) | done — 392 tests green |
| R4 | conditional security warm-up, `series=` arg alias, golden harness, 6 agent fixes | done — golden regen pending |
| R5 | strategy perf surface, 3 MTF delta findings, method-on-builtin-type | done — 421+10+10 green, golden regen |
| R5b | MTF boundary probe 8/8 + chart-domain SecSeries.atOffset | done — probe kept |
| R6 | Vela UI/UX + `''` color-override black-line bug + per-bar color verification | done — ledger below |
| R7 | P1 batch: barstate semantics, strategy decl consumers, plot/fill visual params, `max_bars_back` | queued |
| R8 | delta review of R6–R7 + PROGRESS archive | queued |

### R6 details (2026-10-07)

- **黑線 root cause**: Vela `inputValues()` 對未動過的 `input.color`/`input.string` 送 `''` → coerceOverride 產生 `v:''` → `strokeStyle=''` 無效 → 繼承前一筆 stroke → 整條線黑。修：`''` = no override（color+string）。V6.7/V7 渲染實測正確。
- **數值零誤差**: 2330 5m ×1045 bars，ta.ema/ta.macd vs reference impl max|diff|=0.000000；isDarkDashed 30.3% 與參考一致 — maroon 段是腳本設計，非 bug。
- **per-bar color 證明**: 交替色 probe + perbar_color_macd dump（快線 tri-state `#00FF00/#800000/#FF0000`)。
- **velaPineEditor.ts**: 圖上指標清單（點名載入/✕刪）、scriptTitle() 支援 `indicator(title="X")`、histKey CJK encodeURIComponent、legend icon id `edit`/`move`、移除重複 action(Vela 內建 eye/gear/✕)。
- **Known limit**: legend hover reveal 未目視驗證（browser CDP 掛）；golden.test 單跑 >300s 超時（既存慢）。

## Gap ledger (GapConverge agent, 2026-10-06)

**P0** — all must land before "aligned" is claimed:
- #1 golden-value harness — DONE (`golden.ts` + `golden.test.ts`, 10 baselines)
- #2 conditional/dynamic `request.security` correctness — DONE (tf-frame warm-up)
- #3 `x := x[1]+1` undeclared self-reference — DONE (errors before rhs eval)
- #4 strategy perf surface (`closedtrades.*`, `opentrades.*`, equity, risk) — R5

**P1** — correctness/behavior gaps, batch in R6:
- `series=` named-arg alias — DONE
- `var [a,b]` tuple var — DONE
- `alertcondition` → RunResult — DONE
- table/polyline serialization — DONE
- strategy decl consumers (slippage/margin/close_entries_rule/calc_on_order_fills/risk_free_rate)
- barstate stub semantics (isconfirmed 恆真 / isrealtime 恆假)
- method on builtin types (`array<T>` selfType) — R5
- plot/fill visual params (trackprice/histbase/join/show_last/per-point color; fill colors/gradient/fillgaps/force_overlay)
- `max_bars_back` consumer
- import/library resolution — **NEVER per plan rule**
- drawing `*_set_*`/`*_get_*` accessor family (~60 fns) + ta.* long tail (alma/vpt/pivot_point_*/barssince/rising/falling)

**P2** — deferred until a real script needs them:
- `matrix.*`, `map.*`, `ticker.*`, `session.*`, `request.economic/financial/currency_rate`

## Delta-review findings (from R4 DeltaReview agent)

- P1 `mtf.ts:985-991` — series-valued security() leaks tf-domain BarSeries into chart frame → unwrap/align in evalAt (R5: `MtfSeriesLeak`)
- P2 `mtf.ts:918-934` — `invokeUdf` aliases series params without CowSeries (R5: `MtfUdfP2`)
- P2 `interpreter.ts:1064-1066` — `ctx.callUdf` no-callNode branch passes CowSeries verbatim (R5: `CowSeriesP2`)
- P2 `mtf.ts:961-990` — `nodeCache` keyed by ephemeral callScope misses every bar for security() inside UDFs (R5: `MtfUdfP2`)

## Coordination notes

- Golden baselines: `scripts/golden/*.golden.json`; `*.actual.json` = last-failed snapshot for diff review.
- Probe hygiene: `scripts/dbg_*.ts` + `scripts/verify_adv_*` stay untracked until dev completes; regenerate or delete at R7.
- Free-model dispatch: `commandcode-plan/inclusionai/ling-3.1-flash:free`, `opencode-zen/muse-spark-1.3-contributor-free`.
- Handoff: session ends → PROGRESS.md entry + this ledger updated → next session reads both, continues at the next queued round.

## R5 landed (2026-10-06 20:25)

- SecSeries → `spec.chartHist` (chart-domain `[n]` — previous CHART bar's mapped value per TV spec, not previous tf bar); `emitAll` + `lastChartBar` dedup, gaps_on skipped bars emit NA, `resetTfFrame` clears both.
- Fixed during the round: `emit` Map-write idiom, `emitAll(NA)` on tuple exprs (TypeError), engine.ts table cell `Number.isInteger` guard, `bindArgs` `source=`/`series=` collision → `bindWarnQ` drained+deduped in `callBuiltin`.
- StrategyPerf (profit_collector/openprofit/netprofit + FIFO gross/net ledger, commission 分攤), `strategy.equity`/`strategy.max_drawdown` new module.
- CowSeries mirror per UDF invocation (copy-on-write, no param leak); `nodeCache` transient→durable routing per caller scope.
- MethodBuiltinType `normalizeSelfType` + parser generic-depth comma fix.
- Verification: 421 non-e2e + 10 e2e + 10 golden all green; `tsc --noEmit` clean on touched files; golden regen done (`UPDATE_GOLDEN=1`, 10/10).
- Known residual: `var`+`security()` edge divergence; `lookahead_on`/holiday gaps untested on real data; warn text is ours not TV's.
- Next: real-data TV-diff on request.security / strategy / table scripts; commit decision still user-pending (src/pine + PROGRESS.md + scripts/golden staged).

## R5-boundary probe (2026-10-06 20:52)

- `src/pine/__tests__/mtf_boundary_probe.test.ts` — 8/8 pass, zero exceptions across all eight MTF error/boundary cases (j<0 guard, na propagation, dynamic-tf prefetch miss dedup, empty/short HTF, gaps_on×lookahead_on, chart-before-HTF).
- **Finding**: `request.security(sym, timeframe.period, close)` is NOT a prefetch miss — bar0 `runConst` resolves it and prefetch fetches it. The "not prefetched" warning path only fires for genuinely unresolvable/mid-run-switching dynamic tfs; observed ≤1 warning per unique (sym,tf) message.
- C6 semantics: lookahead_off with a 2-bar HTF on 30 chart bars carries the last completed tf bar forward (nominal `tfNext` end) — matches TV "developing bar" rules; no crash in `tfBarEnd`/`tfNext`.
