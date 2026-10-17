// Regression test for `math.tonumber`'s scalar read path.
//
// ROOT CAUSE (measured, do not re-litigate): `evalArg` wraps EVERY literal arg
// (ignoring `noHist`), every bare identifier, and every history-requiring arg
// into `{kind:'series'}` before a builtin sees it (only a bare `na` literal and
// non-numeric kinds pass through unwrapped). `math.tonumber` switched on
// `v.kind` with no `series` case ⇒ its `default: NA` swallowed all of them, so
// `math.tonumber(5)`, `math.tonumber(x)` (x = 3), `math.tonumber(close)` and
// `math.tonumber(true)` all returned `na`.
//
// This file drives the real parse → runScript engine path (same shape as
// alias_repro.test.ts) so the wrapper is exercised, not bypassed.
import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';

const bars = Array.from({ length: 5 }, (_, i) => ({
  openTime: 1_700_000_000_000 + i * 60_000,
  open: i, high: i + 1, low: i - 1, close: 100 + i, volume: 1,
}));

const num = (v: unknown): unknown =>
  v && typeof v === 'object' && 'v' in v ? v.v : v;
const isNa = (v: unknown): boolean =>
  !!v && typeof v === 'object' && 'kind' in v && v.kind === 'na';

const src = `//@version=6
indicator("tonumber-args")
x = 3
plot(math.tonumber(5), "lit")
plot(math.tonumber(x), "var")
plot(math.tonumber(close), "close")
plot(math.tonumber(true), "bool")
plot(math.tonumber("42"), "str")
plot(math.tonumber(5 + 0), "expr")
plot(math.tonumber(math.abs(5)), "inner")
plot(math.tonumber(na), "na")`;

describe('math.tonumber accepts wrapped (series) args', () => {
  it('reads the current scalar for literal/ident/series/bool args', async () => {
    const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
    const plots = [...r.plots.values()];
    const [lit, vr, cl, bool, str, expr, inner, na] = plots;

    // W1/W2: literal `5` and bare ident `x` are wrapped by evalArg.
    expect(lit!.values.map(num)).toEqual([5, 5, 5, 5, 5]);
    expect(vr!.values.map(num)).toEqual([3, 3, 3, 3, 3]);
    // W1/W2 + history: `close` is a series → current bar's close.
    expect(cl!.values.map(num)).toEqual([100, 101, 102, 103, 104]);
    // Bool branch is unchanged by this fix: math.ts maps true → int 1
    // (builtins.test.ts:159 asserts exactly this for the unwrapped call).
    expect(bool!.values.map(num)).toEqual([1, 1, 1, 1, 1]);
    // Must-not-regress: string parsing (existing branch).
    expect(str!.values.map(num)).toEqual([42, 42, 42, 42, 42]);
    // Already worked: binary expr goes through the noHist/scalar path.
    expect(expr!.values.map(num)).toEqual([5, 5, 5, 5, 5]);
    // Inner builtin `math.abs(5)` returns a series → outer call re-wraps it.
    expect(inner!.values.map(num)).toEqual([5, 5, 5, 5, 5]);
    // Bare `na` literal stays na — must not change.
    expect(na!.values.every(isNa)).toBe(true);
  });
});
