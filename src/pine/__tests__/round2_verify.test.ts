// Round-2 alias write-through regression tests — locks A1 (`x[1]` after
// scalar `:=`), A2 (mixed-kind decl foreign-slot write-through), A4 (tuple
// scalar-store), and the non-var/var accumulation boundary. Do not delete.
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

// A1: series-valued RHS alias + := must not write through; x[1] reads copy.
it('A1: x=input.source(close); x:=999 → x[1]==999, close intact', async () => {
  const src = `//@version=6
indicator("t")
x = input.source(close)
x := 999
plot(x)
plot(x[1])
plot(close)`;
  const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
  const p = [...r.plots.values()];
  expect(p[0]!.values.map(num)).toEqual([999, 999, 999, 999, 999]);
  // x[1] reads previous bar's value; bar0 has no history → na object.
  expect(p[1]!.values[0]).toEqual({ kind: 'na' });
  expect(p[1]!.values.slice(1).map(num)).toEqual([999, 999, 999, 999]);
  expect(p[2]!.values.map(num)).toEqual([100, 101, 102, 103, 104]);
});

it('A1b: alias without := stays a pure alias (no materialize)', async () => {
  const src = `//@version=6
indicator("t")
x = input.source(close)
plot(x)
plot(x[1])`;
  const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
  const p = [...r.plots.values()];
  expect(p[0]!.values.map(num)).toEqual([100, 101, 102, 103, 104]);
  expect(num(p[1]!.values[1])).toBe(100);
});

// A2: mixed-kind flip — scalar bar must not write through into close.
it('A2: x=cond?input.source(close):1 → close intact, x=[100,101,1,1,1]', async () => {
  const src = `//@version=6
indicator("t")
x = bar_index < 2 ? input.source(close) : 1
plot(x)
plot(close)`;
  const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
  const p = [...r.plots.values()];
  expect(p[0]!.values.map(num)).toEqual([100, 101, 1, 1, 1]);
  expect(p[1]!.values.map(num)).toEqual([100, 101, 102, 103, 104]);
});

// var alias accumulates.
it('var x=input.source(close); x:=x+1 accumulates', async () => {
  const src = `//@version=6
indicator("t")
var x = input.source(close)
x := x + 1
plot(x)
plot(close)`;
  const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
  const p = [...r.plots.values()];
  expect(p[0]!.values.map(num)).toEqual([101, 102, 103, 104, 105]);
  expect(p[1]!.values.map(num)).toEqual([100, 101, 102, 103, 104]);
});

// non-var alias := must NOT accumulate — x = e re-inits each bar.
it('non-var x=input.source(close); x:=x+1 does NOT accumulate (re-init per bar)', async () => {
  const src = `//@version=6
indicator("t")
x = input.source(close)
x := x + 1
plot(x)`;
  const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
  const p = [...r.plots.values()];
  expect(p[0]!.values.map(num)).toEqual([101, 102, 103, 104, 105]);
});

// decl inside if arm — skipped bar history carries correctly.
it('decl in if arm skipped on some bars: x[1] carry correct', async () => {
  const src = `//@version=6
indicator("t")
x = 0.0
if bar_index % 2 == 0
    y = input.source(close)
    x := y
plot(x)`;
  const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
  const p = [...r.plots.values()];
  // bars 0,2,4 take the arm: x := close → 100,102,104; others keep 0.
  expect(p[0]!.values.map(num)).toEqual([100, 0, 102, 0, 104]);
});

// A4: tuple element aliasing a ctx series — a[1] reads decl history, not
// live close[1].
it('A4: [a,b]=[input.source(close),1] → a[1] = own history', async () => {
  const src = `//@version=6
indicator("t")
[a, b] = [input.source(close), 1]
plot(a)
plot(a[1])`;
  const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
  const p = [...r.plots.values()];
  expect(p[0]!.values.map(num)).toEqual([100, 101, 102, 103, 104]);
  const a1 = p[1]!.values;
  expect(a1[0]).toEqual({ kind: 'na' });
  expect(a1.slice(1).map(num)).toEqual([100, 101, 102, 103]);
});
