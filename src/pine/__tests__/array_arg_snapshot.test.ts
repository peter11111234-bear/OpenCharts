// C1 + I-a repro (evalArg path only — never calls a builtin directly).
//
// C1: `array.includes/indexof/lastindexof/binary_search*` register the value arg
// as HistSpec { idx:[1], names:['value'] }, so evalArg hands the builtin a
// `{ kind:'series' }` wrapper. Reading it raw compared the WRAPPER against the
// stored elements ⇒ every lookup returned "not found" (false / -1 / bogus
// insertion hint). The read site must unwrap to the current-bar scalar first.
// I-a: `array.new(size, initial_value)` filled the slots with the raw arg — a
// series arg stayed a LIVE handle, contradicting the file's documented
// "Arrays hold SNAPSHOT values" contract (array.push/set already snapshot).
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

const last = (series: { values: unknown[] }): unknown => num(series.values[series.values.length - 1]);

describe('array value-arg snapshot (C1) — lookups must see the current-bar scalar', () => {
  it('includes/indexof/lastindexof/binary_search must find elements of array.from(1,2,3)', async () => {
    const src = `//@version=6
indicator("t")
a = array.from(1, 2, 3)
plot(array.includes(a, 2) ? 1 : 0, "has2")
plot(array.indexof(a, 2), "i2")
plot(array.lastindexof(a, 2), "il2")
plot(array.binary_search(a, 2), "b2")
plot(array.binary_search_rightmost(a, 2), "b2r")
plot(array.includes(a, 9) ? 1 : 0, "has9")
plot(array.indexof(a, 9), "i9")`;
    const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
    const [has2, i2, il2, b2, b2r, has9, i9] = [...r.plots.values()];
    expect(last(has2!)).toBe(1);   // C1 bug ⇒ 0
    expect(last(i2!)).toBe(1);     // C1 bug ⇒ -1
    expect(last(il2!)).toBe(1);    // C1 bug ⇒ -1
    expect(last(b2!)).toBe(1);     // C1 bug ⇒ -2 (insertion hint)
    expect(last(b2r!)).toBe(1);    // C1 bug ⇒ -2
    expect(last(has9!)).toBe(0);   // unchanged in both states
    expect(last(i9!)).toBe(-1);    // unchanged in both states
  });
});

describe('array.percentrank value-arg snapshot (I-a) — lookups must see the current-bar scalar', () => {
  it('percentrank(a, v) on array.from(1,2,3,4) must rank against the current-bar scalar', async () => {
    const src = `//@version=6
indicator("t")
a = array.from(1, 2, 3, 4)
plot(array.percentrank(a, 4), "p4")
plot(array.percentrank(a, 2), "p2")`;
    const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
    const [p4, p2] = [...r.plots.values()];
    expect(last(p4!)).toBe(100); // wrapped series ⇒ na
    expect(last(p2!)).toBe(50);  // wrapped series ⇒ na
  });
});

describe('array.new(size, initial_value) snapshot semantics (I-a)', () => {
  it('a series initial_value must be captured at the call bar, not stay live', async () => {
    const src = `//@version=6
indicator("t")
var a = array.new(1, 0)
if bar_index == 2
    a := array.new(1, close)
plot(array.get(a, 0), "e0")`;
    const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
    const e0 = [...r.plots.values()][0]!;
    expect(num(e0.values[2])).toBe(102); // bar 2 close
    expect(num(e0.values[3])).toBe(102); // LIVE bug ⇒ 103
    expect(num(e0.values[4])).toBe(102); // LIVE bug ⇒ 104
  });
});
