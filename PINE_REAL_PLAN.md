# Pine Script Interpreter — REAL PLAN

## Goal
Build a from-scratch Pine Script v5/v6 interpreter in `src/pine/` that runs the user's real scripts (`MACD701`, `見高K4.55`, `TRIS390`, `TD_BB`, `turtle system`, `高量1.46`) on Vela via `ScriptingEngine`. No dependency on the broken `pinets` transpiler.

## Why not fork PineTS
- `pinets` is 46k lines; transpiler has architectural scope/named-arg bugs:
  - named args not bound (`ta.*`, `request.*`, `math.*`)
  - `var`/loop-var identifiers lose `$.var.`/`$.let.` prefix inside `SERIES[expr]` in call args
  - `var` not hoisted (Pine `var` semantics = file-scope init, run once at bar 0)
- Fixing these in-place requires understanding their AST/codegen; a clean interpreter is smaller (~8k lines) and correct by construction.

## Contract with Vela
`ScriptingEngine` interface (from `node_modules/@luxalgo/vela/dist/...`):
- `prepare(source, instanceId)` → `PreparedScript { token, inputs, props, indicatorDefaults, reactsToViewport }`
- `execute(req, handlers)` → `{ ctx, alerts, warnings, reactsToViewport, model }`
- `executeIncremental(session, req)` → same
- `update(session, update)` → incremental bar update
- `applyInput(session, inputs)` → re-run with new input values
- `onViewport` / `destroy` / `info` / `hasIncrementalSupport`

## Contract file
`src/pine/contracts.ts` — AST node union, `Value`, `Series`, `Scope`, `BuiltinCtx`, `RunResult`, `ScriptingEngine` port types. All agents code against it; do not change shape mid-build.

## Series semantics (TradingView ground truth)
- `expr[n]` = value of `expr` n bars ago; out-of-range → `na`.
- `var x = e` = evaluate `e` on bar 0 only, value persists (declared where used, no hoisting needed).
- `x = e` / `let x = e` = per-bar series assignment.
- `x := e` = reassign existing var/series.
- `expr[var]` evaluates `var` at current bar → integer index into history.
- `na` propagates through arithmetic; `nz(x, y)` unwraps.
- `if` bodies are statement blocks; `x = if cond ...` expression form returns last value of branch.
- UDFs are closures over global scope; `var` inside UDF persists per-bar like globals.
- `request.security(sym, tf, expr)` evaluates `expr` per-bar on `(sym, tf)` data, aligns result to chart bars.
- `for i = a to b` loop var is bar-local; `for..in` iterates arrays.
- `switch` on expr or bare conditions; `=>` case arms return values.
- `type X` + `method m(X self, ...)` + `X.new(...)` = UDT with dynamic method dispatch.
- `strategy()` scripts execute entry/exit calls; v1 records markers only (no PnL ledger).
## Modules
```
src/pine/
  ast.ts            — AST node types
  tokens.ts         — token types
  lexer.ts          — source → tokens (handles indent, strings, comments, operators)
  parser.ts         — tokens → AST (declarations, UDFs, if/for/switch, method calls)
  series.ts         — Series<T> ring buffer + history access
  context.ts        — per-bar state (open/high/low/close/volume/time/bar_index, var slots)
  scope.ts          — variable scopes (global/file/function/local), var vs let
  interpreter.ts    — evaluate AST; top-level loop over bars
  builtins/
    ta.ts           — ta.sma, ema, rsi, macd, atr, stdev, highest, lowest, cross, change, cum, sum, vwap
    math.ts         — math.abs, max, min, round, sign, pow, sqrt, log, exp, floor, ceil, nz
    array.ts        — array.new*, push, get, set, size, fill, includes, from, indexof, remove, shift, unshift, slice, sort
    str.ts          — str.tostring, tonumber, format, replace, contains, length, substring, split, join
    color.ts        — color.new, color.rgb, named colors, color.from_gradient
    input.ts        — input.int/float/bool/string/color/timeframe/source/price/session/symbol
    plot.ts         — plot, plotshape, plotchar, hline, fill, bgcolor, barcolor, alertcondition
    draw.ts         — line.new/set_*/delete, label.new/set_*/delete, box.new/set_*/delete, table
    request.ts      — request.security (via mtf.ts)
    strategy.ts     — strategy.entry/exit/order/close (for TRIS390/turtle)
  udt.ts            — type decl, method decl, UDT.new, field access, array<T>
  mtf.ts            — MTF evaluator (fetchSeries → evaluate expr on TF bars → align back)
  engine.ts         — ScriptingEngine impl wrapping interpreter
  errors.ts         — PineRuntimeError with line/col
  debug.ts          — optional debug/trace hooks
```

## Workstreams (10 parallel agents)
| # | Package | Files | Depends on |
|---|---|---|---|
| 1 | Lexer + tokens | `lexer.ts`, `tokens.ts` + tests | — |
| 2 | Parser | `parser.ts`, `ast.ts` + tests | 1 (AST shape shared first) |
| 3 | Series + context + scope | `series.ts`, `context.ts`, `scope.ts` + tests | — |
| 4 | Interpreter core | `interpreter.ts` + tests | 2, 3 |
| 5 | `ta.*` builtins | `builtins/ta.ts` + tests | 3 |
| 6 | `math`/`str`/`array`/`color` builtins | 4 files + tests | 3 |
| 7 | `plot`/`hline`/`fill`/`plotshape`/`alertcondition`/`input`/`barcolor`/`bgcolor` | `builtins/plot.ts`, `input.ts` + tests | 3, 6 (color) |
| 8 | UDT (`type`/`method`/`array<T>`/`.new`/field access) | `udt.ts` + tests | 2, 4 |
| 9 | MTF + `request.security` | `mtf.ts`, `builtins/request.ts` + tests | 4, 5 |
| 10 | Engine + Vela integration | `engine.ts` + smoke test | 4, 5, 7, 9 |

## Acceptance
1. `MACD701.TXT` → plots MACD lines + histogram on Vela
2. `見高K4.55.TXT` → ZigZag + SMC drawings render (may not be pixel-perfect but no crash)
3. `TRIS390.TXT` → MTF supertrend/rangefilter/halftrend plots render
4. `TD_BB.txt`, `turtle system.txt` → run without transpile errors
5. `高量1.46.TXT` → volume indicators render

## Test strategy
- Unit tests per module (`src/pine/__tests__/`)
- Golden tests: run each user script against 500-bar synthetic series, assert no throw + non-null plot data
- Integration: `runIndicator` on VelaPage → legend shows title + plots appear

## Out of scope (for v1)
- `strategy` backtest engine internals (just entry/exit markers)
- `matrix`/`map`/`polyline`/`linefill` (stub with warnings)
- `varip` (realtime-bar vars)
- `alert()` runtime firing (register only)

## Risks
- Parser edge cases (string escapes, multi-line calls, comments mid-expression)
- Series buffer sizing for `max_bars_back`
- MTF alignment (partial bars, weekends, TW sessions)
- UDT method dispatch complexity
- Performance (1772-line script × 800 bars × 20+ UDF calls per bar)

## Timeline (est)
- Parallel build: 1-2 days wall-clock
- Integration + first script pass: +0.5 day
- All 6 scripts pass: +1-2 days
