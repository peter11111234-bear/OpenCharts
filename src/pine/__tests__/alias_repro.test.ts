// REPRO of a KNOWN pre-existing bug (unrelated to the MTF cache work —
// same bug tracked as P1 in PROGRESS.md R2):
// `x = <series-aliasing expr>; x := …` writes through into the shared slot —
// an input.source alias corrupts ctx.close; a UDF-returned series corrupts
// the callee's slot. Marked it.fails until the alias write-through is fixed;
// flip to `it` when the bug lands.
import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';

const bars = Array.from({ length: 5 }, (_, i) => ({
  time: 1_700_000_000_000 + i * 60_000,
  open: i, high: i + 1, low: i - 1, close: 100 + i, volume: 1,
}));

const num = (v: unknown): unknown =>
  v && typeof v === 'object' && 'v' in v ? v.v : v;

describe('bindDeclared alias write-through (pre-existing bug)', () => {
  it.fails('x = input.source(close); x := 999 — must not corrupt ctx.close', async () => {
    const src = `//@version=6
indicator("t")
x = input.source(close)
if bar_index == 2
    x := 999
cafter = close
plot(close, "c")
plot(cafter, "cafter")`;
    const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
    const plots = [...r.plots.values()];
    const c = plots[0]!, cafter = plots[1]!;
    expect(num(c.values[2])).toBe(102);       // BUG: write-through makes this 999
    expect(num(cafter.values[2])).toBe(102);
    expect(num(c.values[3])).toBe(103);
  });

  // NOTE: this variant now PASSES — the UDF-alias write-through was fixed by
  // an earlier change; kept as a regular `it` to guard the regression.
  it('x = f() UDF series alias; x := 999 — must not corrupt the shared slot', async () => {
    const src = `//@version=6
indicator("t")
y = close * 1.0
f() => y
x = f()
if bar_index == 2
    x := 999
yafter = y
plot(y, "y")
plot(yafter, "yafter")`;
    const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
    const plots = [...r.plots.values()];
    const y = plots[0]!, yafter = plots[1]!;
    expect(num(y.values[2])).toBe(102);       // BUG: write-through makes this 999
    expect(num(yafter.values[2])).toBe(102);
    expect(num(y.values[3])).toBe(103);
  });
});
