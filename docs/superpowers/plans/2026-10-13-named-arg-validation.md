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
- No golden regeneration expected: warnings do not enter goldens, and no value
  changes on the tests that pass today.

## Deliberate divergence to record in PROGRESS.md

TV errors at compile time; we warn once at runtime and continue. Our parser has
no signature table, and hard-erroring would break scripts that work today. State
this explicitly rather than implying full parity.

## Cost / blast radius

~25 lines across `util.ts` + `interpreter.ts`, plus the S2 renames if any are
found. No API change, no new module, no metadata migration. The only behaviour
change on a currently-passing test would be an added warning — i.e. S2 is the
gate, not the code.
