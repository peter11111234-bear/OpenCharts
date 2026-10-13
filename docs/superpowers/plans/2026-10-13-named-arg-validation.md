# Named-argument validation — plan (2026-10-13)

Closes the R20 residual: a named argument that matches no parameter slot binds
nothing and stays silent.

## The two silent paths (measured, both real)

1. **Builtins** — `bindArgs` (`src/pine/builtins/util.ts:171`) remaps only the
   hardcoded `series→source` alias. Any other unknown name lands in the Map
   under its own key, is never read, and the slot stays `undefined` →
   `NA`/default. This is what produced MZigZag's all-na pivot buffers
   (`array.unshift(a, value=v)` vs the internal slot `'val'`).
2. **UDF calls** — `bindCallArgs` (`src/pine/interpreter.ts:1458`) is worse: a
   named arg that matches no param is not dropped, it is pushed onto
   `positionals` and then bound to the next free slot. `f(bogus=3)` silently
   writes 3 into parameter 0.

Both diverge from TV, which rejects an unknown named argument at compile time
("Unknown argument").

## Fix

### S1 — surface the unknown name (no new metadata)

`bindArgs` already iterates `Object.entries(named)` on the named path. Add the
unknown-name check there: a key that is neither in `order` nor an alias target
queues a bind warning through the existing `bindWarnQ` →
`callBuiltin` `finally` drain (`interpreter.ts:1336`) → `ctx.warnings`.
`order` is already a parameter, so **zero new per-builtin metadata**.

Keep the `series→source` hardcode and make the check alias-aware. Do not
introduce a general alias table until S2 proves one is needed (ponytail).

`bindCallArgs`: skip an unmatched named arg instead of pushing it to
`positionals`; report it with `warnOnce(ctx, 'udfarg|<name>|<key>', …)` (that
helper already dedups per run and takes `ctx`).

Warning shape (once per callsite, deduped by `ctx.warnings.includes`):

```
unknown named argument 'value=' — ignored; this function takes (id, index, value)
```

### S2 — enumerate existing offenders before believing the change is safe

Dry run already done on the 8 e2e user scripts (grep of every `name=` in the
sources, grouped by callee family). Named args actually in use:

| family | names seen |
|---|---|
| `input.*` | defval, title, minval, maxval, step, options, group, inline, tooltip |
| plot/draw | color, style, width, text, textcolor, text_size, bgcolor, size, yloc, xloc, x, y |
| strategy | qty, stop, limit, comment |
| request | lookahead, gaps |
| other | series (×1), rows |

Checked against the live signature tables: `INPUT_ORDER` already contains every
`input.*` name above, and the `plot.*`/`draw.*` `order` arrays are TV-named. So
the expected offender set is **empty except the `series→source` alias that
already exists** — S2 should be a confirmation step, not a rename round.

Still run it before finishing:

- run `npx vitest run src/pine/__tests__` and grep the warnings;
- run the 6 e2e user scripts (`e2e.test.ts`, `e2e1/e2e2`) — their
  `check(r,{maxWarns})` assertions are the canary;
- cheap corpus scan: every `xxx=` in the 8 user script sources matched against
  the callee's `order`.

Each hit is either (a) an internal name that drifted from TV's reference →
rename the slot (same one-line class as R20), or (b) a genuine alias → add it
to the alias map. Expect the `series=` family and nought else.

### S3 — tests

`src/pine/__tests__/named_args.test.ts`:

1. `array.push(a, bogus=1)` → exactly one warning naming `bogus`, and the array
   gets the same value it gets today (`NA`) — behaviour change is the warning,
   not the value.
2. `ta.sma(close, 5, bogus=1)` → warns.
3. `array.unshift(a, value=v)` → **no** warning (R20 regression guard).
4. UDF `f(a) => a` + `f(bogus=3)` → warns, and param `a` is `na`, not `3`.
5. `ta.bb(series=close, 20)` → no warning (alias path still works).

## Verification

- Full suite green with the same file/test counts as R20 (44 / 776 + 1 skip).
- e2e warn counts unchanged — any new warning means an S2 offender slipped in.
- **Warnings DO enter goldens** (`golden.ts`'s `snapshot()` compares the
  `warnings` array), so a new or reworded warning string needs
  `UPDATE_GOLDEN=1` and a look at the `.golden.json` diff. No value changes are
  expected on the tests that pass today.

## v2 (2026-10-13, after P2 exploration) — scope grew from 2 to 6 binding points

P2 three-axis exploration (read-only `task` agents) found same-class silent paths that v1 missed. All four verified by reading the code and/or reproducing:

| # | path | behaviour today | grade |
|---|---|---|---|
| 1 | `bindArgsJit` (`src/pine/interpreter.ts:2543-2549`) | unknown name still `positionals.push` → binds to param 0; duplicate name silently ignored | **blocker** — v1's own tests fail under `PINE_JIT=1 PINE_JIT_UDF=1` (2 failed / 4 passed, reproducible). JIT is **off by default** (`PROGRESS.md:160` — `PINE_JIT=1` is the documented opt-in), so the defect is latent but on a supported path; a user who opts in gets the exact silent mis-binding this feature exists to remove |
| 2 | `liftNums` (`src/pine/builtins/math.ts:60-63`) | `args.concat(Object.values(named))` → an unknown named arg becomes the **next positional** (`math.round(1.5, bogus=1)` uses bogus as precision) | risk (wrong value, worse than dropping) |
| 3 | `bindDeclArgs` (`src/pine/builtins/util.ts:91-100`) | `bound.set(a.name, …)` into a key nobody reads, zero warning (`indicator(bogus=1)`) | risk |
| 4 | `pickArg` (`src/pine/mtf.ts:292-299`) | fixed name list only; TV's real `request.security` parameters (`ignore_invalid_symbol` / `currency` / `calc_bars_count`; `ignore_invalid_timeframe` for the LTF form) are silently dropped. **This line's first draft named the wrong parameters** — `adjustment` / `backadjustment` / `settlement_as_close` belong to `ticker.new`/`ticker.modify`, not `request.*` — and the first version of the guard then reported those as "declared but not implemented" while calling the real ones unknown. Both directions wrong; corrected in v2.1 (§10.9 + §10.11 of the handoff) | risk (semantic divergence) |
| 5 | UDT `T.new` (`src/pine/udt.ts:163-176`) | throws on an unknown field name | not a gap (TV errors too, and it is not silent) → document only |

Not gaps: `str.format` / `log.*` keys are free-form template keys by design.

**Scope decision**: fix 1–4. Each is the same shape — resolve the name, skip it, warn once through the existing channels (`bindWarnQ` for bind-time, `warn(run, ctx, …)` where a run/ctx is reachable). No new abstraction, no metadata table (ponytail). #1 must be fixed or the blocker stays.

**Deliberate divergence (kept from v1)**: TV rejects an unknown named argument at *compile* time; this engine has no parse-time signature table and hard-erroring would break scripts that run today, so it warns once at runtime and continues. Recorded in `PROGRESS.md` (S9).

**Verification**: `named_args.test.ts` + `named_args_jit.test.ts` + `named_args_math.test.ts`; the same tests green with `PINE_JIT=1 PINE_JIT_UDF=1`; `e2e.test.ts` + `golden.test.ts` green; full `src/pine` suite green; `npx tsc --noEmit` 0.

**Rollback**: each path's guard is an independent 3–6 line hunk; reverting means deleting that hunk only. No data or format change.

## v2 — P6 execution results (2026-10-13)

| slice | owner | change | evidence |
|---|---|---|---|
| A | `JitNamedArgs` agent | `bindArgsJit` (`interpreter.ts`) mirrors `bindCallArgs`; new `named_args_jit.test.ts` (4 tests, sets/restores the JIT env itself) | `PINE_JIT=1 PINE_JIT_UDF=1 npx vitest run src/pine/__tests__/named_args.test.ts` → **8 passed** (pre-fix baseline on the same command: `2 failed | 4 passed`) |
| B | `MathNamedArgs` agent | `liftNums` validates named args against each builtin's reference params | see its report |
| C | integrator | `bindDeclArgs` guard + `flushBindWarnings` at the `indicator()`/`strategy()` decl sites (warnings would otherwise leak onto the next script's ctx) + `request.*` named-arg guard in `mtf.ts` (`adjustment`/`backadjustment`/`settlement_as_close` = declared-but-not-implemented; anything else = unknown) | `named_args.test.ts` 10 passed |
| D | integrator | **regression fix found by `P2RiskBoundary`**: the generated drawing setters (`draw.ts`, `set_<prop>` for line/label/box/table/…) declared the object slot under an internal name (the drawing kind), so TV's documented `id=` was dropped and warned; now the order carries TV's reference name (`id`, `table_id` for table), built once per registration instead of per call | new case asserts `line.set_color(id = l, color = red)` produces exactly the positional form's props, with no warning |

**Follow-up found but ruled out of this change's scope** (pre-existing, unrelated to the guard): handlers that never look at `named` at all (e.g. many `get_*`/`delete` accessors; `grep` shows 23 such registrations in `draw.ts` alone) silently no-op on a named call. Needs its own inventory + slice; counted nowhere yet.

## Cost / blast radius

~25 lines across `util.ts` + `interpreter.ts`, plus the S2 renames if any are
found. No API change, no new module, no metadata migration. The only behaviour
change on a currently-passing test would be an added warning — i.e. S2 is the
gate, not the code.

## v2 — P7 收斂 ＋ P8 三視角 review（2026-10-13）

**P7（驗收逐條，全部實跑）**

| 驗收 | 結果 |
|---|---|
| `npx vitest run src/pine` | **62 檔 / 947 passed / 1 skipped** |
| `PINE_JIT=1 PINE_JIT_UDF=1` 下的 named-args | **3 檔 / 20 passed**（修前 baseline：2 failed / 4 passed） |
| `npx tsc --noEmit` | **0** |
| golden | **警告會進 golden**（`snapshot()` 一起比對 `warnings`）→ 新增／改動警告字串要 `UPDATE_GOLDEN=1`；本輪沒有腳本用到新的警告名字，golden 未變 |
| `tv_stdlib.test.ts` | 印 **82** |

**v2.1（P8 review 後）——本輪自己製造的假警告，全部已修**

三視角 review（正確性 13m／可維護性 17m／安全 30m，三個都回來了）在**這一輪的新程式碼裡**抓到四個問題，
全都是「守衛把合法 TV 寫法報成 unknown，或把訊息寫錯」的同一個家族（安全視角另外抓到
`flushBindWarnings` 的 O(n²) 去重，已改 Set）：

1. `SECURITY_ARGS`／`SECURITY_LTF_ARGS` 兩個方向都錯：漏了 TV 真有的
   `ignore_invalid_symbol`／`currency`／`calc_bars_count`（ltf 另漏 `ignore_invalid_timeframe`），
   又把 `adjustment`／`backadjustment`／`settlement_as_close`（其實是 `ticker.new`／`ticker.modify` 的）
   當成 request.* 的參數。→ `SECURITY_PARAMS` 逐字對 `docs/tv-pine-stdlib.json`（security 8／ltf 7 個），
   真參數走 `declared but not implemented`、不在表上才 `unknown`。
2. 宣告期的 `flushBindWarnings(ctx)` 裝在 `evalNode` 的 `indicator`／`strategy` 分支，
   而 top-level 宣告是 parser 抽成 `decl`、由 `runScriptCore` 綁定 → 警告「自己那輪看不到、漏給下一支腳本」。
   → 改在 `runScriptCore` 綁完 decl 後排空；新增測試：含未知名的宣告（body 零 builtin）＋ 下一支腳本零警告。
3. `INDICATOR_DECL_ORDER` 是 v5 的表 → `indicator("t", timeframe = "240")` 等 5 個合法 v6 參數被報 unknown。
   → 整表換成 oracle 的 v6 順序，v5 專屬名移除，3 個行為參數進 `INDICATOR_UNSUPPORTED_PARAMS`。
4. 產生的 `get_<prop>` 連 `named` 都不收 → `line.get_color(id = l)` 靜默回 `na`。
   → 改成與 setter 同一組參考名（`id`／`table_id`），並補測試把**值**寫死（兩邊都 no-op 也會相等）。
5. 自查（不在 review 內）：`math.max(number2=…)` 這種 TV 無上限的 variadic 名會被丟掉 →
   以 `/^number\d+$/` 放行；`pinetsShim` 的 bind 警告沒人排空 → 同批補上。
6. 文件事實錯誤一併更正：**警告會進 golden**（原本三份文件都寫「不進」）、
   「2 → 5 條路徑」改成「2 → 6 個綁定點」、「draw.ts 23 個 named-blind handler」改成實測 27／core 8／strategy 9。

**刻意保留**（記錄而非修）：訊息樣板在 6 個產生點各一份（計畫 v2 明拒新抽象）、
`duplicate named argument` 在 builtin 是 last-wins 而 UDF／JIT／宣告是 first-wins（TV 兩者皆編譯錯誤）、
`from_seconds` 的 365 天邊界與 KB 的「366 天」文字衝突（以實測表為準，待人工在 TV 覆核）。
