# Pine ⇄ TradingView alignment + first-paint perf — HANDOFF (2026-10-12)

Session covered R16–R19. Everything below is measured, not assumed.
Repo: `C:\Users\bear9\OpenCharts`. **Nothing is committed yet.**

## 1. Done & verified this session

### R16 — Incremental live-tick execution
- `incRun` / `incAdvance` / `incRunStart`: closed bars evaluate once; the forming
  bar rolls back from a checkpoint and re-evaluates.
- Both paths (in-process `engine.ts`, worker `pineWorker.ts`) use it; session
  keyed by `incKey`; double `parse()` removed (`msg.parsed`).
- Measured: 500 bars × 10 plots tick **152ms → 1.21ms**.
- Tests: `src/pine/__tests__/inc-parity.test.ts` (7 cases + fuzz vs full rerun).

### R17 — MTF coverage + worker delta protocol
- `request.*` scripts now qualify for incremental (`incEligible` only excludes
  `strategy`). Per-session MTF store; per-spec checkpoint/restore
  (`src/pine/mtf.ts`); `refreshSecurity` refetches HTF feeds when the tape grows.
- Worker sends only a plot **tail delta** (`pineWorkerProto.ts` `PlotDelta`,
  `pineWorker.ts` `plotsDelta`, client patches retained arrays).
- Measured: MTF tick **270ms → 0.87ms**; transport **9.5ms → ~0.3ms**.

### R18 — Three interpreter bugs behind "Vela shows far fewer lines than TV"
1. **Draw quotas never read.** `parse()` returns `{ decl, body }`; `indicator(...)`
   sits in `decl`, so `buildSess`'s body loop never hit `case 'indicator'` and
   `declDrawQuotas` was never called → every drawing kind fell back to
   `DEFAULT_QUOTA = 50` (`builtins/draw.ts:92`) even when the script declared 500.
   Fix: `interpreter.ts` buildSess calls `declDrawQuotas` for indicator decls.
   Measured: drawings 151 → 937; white zigzag 42 → 241.
2. **`array.max/min/sum/avg/range/median` ignored series-wrapped elements.**
   `numsOf` filtered by kind *before* unwrapping `{kind:'series'}`, so a buffer
   filled from series args looked empty → `na`. Fix: unwrap first (`builtins/array.ts`).
3. **Array store was not a snapshot (the big one).** `array.push/set/insert/unshift/fill`
   stored the raw `{kind:'series'}` wrapper. Every slot written from one call site
   then aliased ONE live series, so a rolling buffer read back the same current
   value in every slot. TV stores snapshots. Fix: `snap()` (unwrap to `cur()`)
   at all store sites. Symptom: 見高K `tab_cb` (ZigZag pivot ring) returned
   duplicate pivots → `tab_rate` stuck at 0/1 → ABC lines never drawn; same for
   the harmonic ZigZag buffers. After: `rInBand` 0 → 149.

Also: first-run O(N²) checkpointing fixed (single checkpoint at the committed
boundary, not per bar) — this was the 60s+ first load.

Line census on 見高K (MXF 5m, 2909 bars) after fixes: 404 lines (241 white zigzag,
20 ABC `xloc.bar_time`, 50+50 divergence, harmonic teal/olive/fuchsia/lime),
147 labels (A/B/C ×10). Goldens regenerated.

### R19 — First-paint cost
- Profile (`node --cpu-prof`, 見高K on real MXF 5m): **83% of busy time is
  `evalOneBar`; no single function >5%** after that. Cost ~16 ms/bar, linear:
  200 bars 3.3s / 400 6.5s / 800 12.9s / 2000 ≈32s / 2900 ≈46s.
  So the felt slowness was **bar count**, not a hot loop.
- Fix A: `velaProvider.getBars` floored the limit at 2000
  (`Math.max(limit, 2000)`) — removed; honor Vela's requested window.
- Fix B: `getShioajiHistory`'s windowed branch returned *every* bar in
  `[from,to]` and ignored `want` → a Vela-supplied window bypassed the limit.
  Now capped to `want` (tail).
- Fix C: new `src/pine/modelCache.ts` (IndexedDB). Key =
  `modelId(source hash)|symbol|tf|inputs|barCount|lastBarOpenTime`. Served only
  for the **first run of a session** (page restore); tick/update runs always
  recompute. Hooked in `engine.ts` drain (`firstRun` flag).

## 2. Unfinished — continue after handoff

**A. Harmonic/ABC green lines on the user's screen (HIGHEST PRIORITY, open).**
Engine→model verified to contain them, but the user still reports them missing
in Vela. Need to determine whether Vela drops them or the app path differs.
Next: hard-reload and re-look; if still missing, inspect Vela's drawing store
from the page (`tab.run`) or step through `DrawingLine` emission.

**B. KJ in-browser first-run timing not re-measured.** Last browser run was
>45s and never completed (cause undetermined — possibly parked in
`prefetchSecurity`, or the `runIndicator` await chain). After Fix A/B it should
be ~8s for 500 bars. Re-measure.

**C. Per-bar ~16ms interpreter cost — untouched.** No single hotspot. Untried
levers: UDF-call path micro-opts (K4.55 issues ~430 calls/bar), reducing
per-arg wrapping (`evalArg`), revisiting the UDF JIT. Also cheap: `runOf()`
property cache instead of a WeakMap get; memoize `udfJitEnabled()` per run.
Each ~1–3% (deliberately skipped — YAGNI until needed).

**D. Vela topbar timeframe pinning.** `timeframeFavorites` lives in the
workspace state (`statusline-model-*.d.ts`); writing it pins e.g. `1m` to the
topbar and avoids the dropdown that auto-closes in ~1s.

**E. Vela data-window panel unwired.** `chart.getDataWindowReadout()` returns
date/time + OHLCV + per-indicator values, pre-formatted; VelaPage never renders
it. (Distinct from the in-chart legend/status line, which already works.)

**F. `array.from(...)` still stores live series** (left alone deliberately —
see the comment in `builtins/array.ts`). TV snapshots; latent divergence.

**G. R15 residuals** (from the earlier residual-perf plan, not started):
`R.call` arg fast-arms, `str` attribution, tf-domain `callHist → histSpecHas`.

**H. strategy incremental** — evaluated and rejected (order execution is
event-driven); do not reopen without a new design.

## 3. Environment notes

- **Dev server**: `scripts/dev-up.ps1` (idempotent). Its probe hits `/` which
  still returns 200 when the **esbuild child has died** → it reports "vite OK"
  while transforms fail. Recovery: `Stop-Process` whatever holds :5173, then run
  the script.
- **Tests**: `npx vitest run src/pine/__tests__` (43 files, 771 pass / 1 skip).
- **Goldens**: `UPDATE_GOLDEN=1 npx vitest run src/pine/__tests__/golden.test.ts`.
- **CPU profile recipe** (tsx spawns a child, so `--cpu-prof` on `npx tsx` only
  profiles the launcher — run the loader in-process):
  `node --cpu-prof --cpu-prof-dir=scratch --cpu-prof-name=x.cpuprofile --import "file:///C:/Users/bear9/AppData/Local/npm-cache/_npx/fd45a72a545557e9/node_modules/tsx/dist/esm/index.mjs" <probe.ts>`
- **Probe recipe used throughout**: POST to `http://localhost:8080/api/v1/data/kbars`,
  resample 1m → 5m, `runScript`, then inspect `r.drawings` / `r.plots`. When the
  value is only reachable mid-script, inject counters via string surgery and
  `plot` them (see the R18 investigation).
- **JS toolchain gotcha**: bash → PowerShell needs single quotes; put `$_`,
  `$env:` etc. in a `.ps1` file rather than inline double quotes.

## 4. Key source files

- `src/pine/interpreter.ts` — `buildSess`, `incRunStart`, `checkpoint`,
  `restoreCkpt`, `assembleRunResult` (emit cache), `barstateUdt`
- `src/pine/mtf.ts` — `prepareSecurity`, `tryEvalSecurity`, spec
  checkpoint/restore, `refreshSecurity`
- `src/pine/engine.ts` — `execute` drain loop, model cache hook, `buildModel`
- `src/pine/modelCache.ts` — IndexedDB model cache (new)
- `src/pine/builtins/array.ts` — `snap()`, `numsOf`
- `src/pine/builtins/draw.ts` — drawing quotas
- `src/pine/pineWorker*.ts` — worker protocol + plot delta
- `src/services/shioaji/{velaProvider,candles,feed}.ts` — bar limit, window
  slice, live tick time anchoring
