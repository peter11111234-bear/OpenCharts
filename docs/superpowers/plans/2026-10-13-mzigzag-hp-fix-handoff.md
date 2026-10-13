# MZigZag - HP "zero output" — fix + handoff (2026-10-13)

Session covered R20. Everything below is measured, not assumed.
Repo: `C:\Users\bear9\OpenCharts`. **Nothing is committed.**

## 1. Done & verified this session

### R20 — the bug (single root cause, one class of error)

Symptom: `C:\Users\bear9\high452\HP\MZigZag - HP.TXT` (Pine v5) shows the legend
in Vela and draws **nothing**; 見高K4.55 on the same chart draws fine. Both
compile and run with `warns: []`.

Root cause: **`array.push` / `array.unshift` named-argument slot was named
`'val'`, TV's reference name is `value`.**

- `bindArgs` (`src/pine/builtins/util.ts:171`) matches named args against the
  function's `order` array plus one hardcoded `series→source` alias. `value=`
  matched neither → it landed in the map under an unread key, `'val'` stayed
  `undefined`, and `snap(undefined) → na` was pushed.
- Consequence: the three pivot buffers grew to the right **length** with
  **all-na values**, so every ratio in `detect_harmonic_pattern`
  (xabRatio/abcRatio/bcdRatio/xadRatio/yxaRatio) came out `na`, `wm_pattern`
  never became true, and no line/label was ever emitted. Nothing throws,
  nothing warns.

Fix: `src/pine/builtins/array.ts` — `push`, `unshift`, `binary_search`,
`binary_search_leftmost`, `binary_search_rightmost`: param slot `'val'` →
`'value'` (plus the HistSpec `names`). Class audit: the other 28 `array.*`
registrations already used TV names, and a repo-wide grep for a `'val'` slot
finds nothing else, so the mismatch was confined to those 5.

Measured (real MXF 500 bars via `runScript`):

| | drawings |
|---|---|
| before | `{table:1}` — 0 lines, 0 labels |
| after | `{table:1, line:101, label:26}` |

Instrumented run: pivot buffer size 71 with px/pa/pb/pc/pd **all na** before;
real prices + ratios after (xab 1.14, abc 1.45, bcd 1.08, xad 1.28).
Oscillating synthetic 400 bars: 30 lines / 14 labels.

### The other 4 primitives from the 2026-10-12 handoff are NOT bugs

Verified already-correct, then pinned by tests so they cannot regress:

1. `if <float>` — `unseriesTruth`/`truthy` coerce (0/na → false, else true).
2. `<float> and/or <bool>`, ternary on a float — same coercion.
3. `not <int>` — same.
4. Bare expression statements in a UDF body (`bar`, `newDir`, `cancelW`) — the
   statement is evaluated; they are no-ops as in TV.
5. `array.unshift(zigzagpivots, value=value)` — this was the actual bug (#4
   above), and the only one.

Also confirmed **not regressed**: `math.max/min` na-propagation (R20 prerequisite
from the prior session).

### Vela verified, not just node

`npx vitest` proves the engine; Vela was checked separately because that is where
the user saw nothing.

- Dev server was in the known undetectable-failure state: the esbuild child had
  died, `/` still answered 200, **every transform answered 500**
  ("The service is no longer running"), so `/vela` mounted as an empty shell
  with **no console error at all**. Recovered by stopping the `:5173` owner and
  re-running `scripts/dev-up.ps1`.
- Then, against a real chart (2330 5m, real bars from the app's own provider):
  `window.__vela.chart.runIndicator(mzSrc)` → `ok`, 2.0 s, and the canvas shows
  the harmonic lines plus `Double Top` / `Butterfly Double Top` / `ABCD` labels.
- Tooling: a throwaway CDP driver (`node` + `ws://127.0.0.1:9222`) was used to
  navigate/reload/evaluate/screenshot; REA (`list_browser_targets`,
  `capture_web_screenshot`) was used for target discovery. The temp Chrome
  (`--remote-debugging-port=9222`, profile in `%TEMP%\rea-chrome`) is **stopped
  and its profile deleted**; the driver scripts were removed.

### dev-up.ps1 hardening (found by the above)

`scripts/dev-up.ps1`, 2 changes, both verified:

1. `Test-Vite` now probes `/src/main.tsx` instead of `/` — only a path that
   needs a transform can see a dead esbuild child.
2. Before starting, it reaps the `:$Port` owner **when the probe failed but the
   port is still held** and the owner is one of this repo's vite processes
   (`strictPort` would otherwise make the new vite fail to bind at all).

Verified: `Parser::ParseFile` → PARSE OK; against the healthy server →
`vite OK on :5173 — no-op` (no false negative, no stray kill). The
probe-failed path itself was not exercised (would require killing esbuild on
purpose) — it mirrors the manual recovery that was run.

### Tests / docs

- New: `src/pine/__tests__/mzigzag_semantics.test.ts` (5 cases, 110 lines).
- Full suite: **44 files / 776 passed + 1 skipped** (baseline was 43 / 771 + 1).
- `PROGRESS.md`: R20 entry appended.
- `docs/superpowers/plans/2026-10-13-named-arg-validation.md`: plan only, **not
  implemented** (see below).

## 2. Unfinished

**A. Named-argument validation (planned, not implemented).**
`docs/superpowers/plans/2026-10-13-named-arg-validation.md`. Two silent paths,
both confirmed by reading the code:

- builtins: `bindArgs` ignores an unknown name (→ the R20 bug);
- UDF calls: `bindCallArgs` (`src/pine/interpreter.ts:1458`) is worse — an
  unmatched named arg is pushed onto `positionals` and bound to the next free
  slot, so `f(bogus=3)` silently writes 3 into parameter 0.

S1 is ~25 lines: detect the unknown name in `bindArgs`' existing named-path loop
and queue it through the already-existing `bindWarnQ` → `callBuiltin` `finally`
drain (`interpreter.ts:1336`); make `bindCallArgs` skip instead of re-binding
positionally and report via `warnOnce`. S2 is a dry-run gate (a corpus scan was
already done — expected offender set is empty apart from the existing `series=`
alias). S3 is a 5-case test file. Deliberate divergence to document: TV errors at
compile time, we would warn once at runtime.

**B. `array.from(...)` still stores live series** (untracked from R18; TV
snapshots). Latent, not touched.

**C. R19 residuals** (B–G in the 2026-10-12 handoff): unchanged this session.

**D. Everything from the 2026-10-12 handoff section 2 (A–H)** other than the
harmonic-lines item, which is what this session resolved.

## 3. Environment notes

- Dev server: currently **up and healthy** (`:5173`, transforms 200). It was
  restarted this session, so a fresh log is at `logs/vite-dev.log`.
- If `/vela` ever mounts as an empty shell with no console error, that is the
  dead-esbuild signature — check a transform URL, not `/`.
- Repo: 27 modified / 17 untracked, nothing staged, nothing committed.
- Test baseline to compare against: **44 files / 776 passed + 1 skipped**.

## 4. Key source files

- `src/pine/builtins/array.ts` — `snap()`, and this session's `'val'`→`'value'`.
- `src/pine/builtins/util.ts` — `bindArgs`, `bindWarnQ`, `drainBindWarnings`,
  `truthy`, `unwrapped`.
- `src/pine/interpreter.ts` — `callBuiltin` (drain site, ~1336), `bindCallArgs`
  (~1441), `unary`/`binary`/`ternary` eval (coercion, ~660–700).
- `src/pine/__tests__/mzigzag_semantics.test.ts` — this session's regression set.
- `scripts/dev-up.ps1` — hardened probe + unhealthy-owner reap.
- `scripts/golden/*.json` — NOT regenerated this session (no value changed).
