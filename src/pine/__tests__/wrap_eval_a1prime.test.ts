// A1′ landing (docs/superpowers/plans/2026-10-17-wrapeval-option-a.md §3/§9.5):
// engine-path coverage for the ScalarSpec declaration table in
// src/pine/builtins/scalarDeclPatch.ts.
//
// Discriminating cases (FAIL before the port, PASS after) are marked
// DISCRIMINATING; the rest are regression guards for sites that already
// happened to work through `asNum`/`asStr` unwrapping or the Stage-3 per-site
// patches (`array.ts`, `math.ts:304`) and therefore cannot fail pre-port.
import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { RunResult } from '../contracts';
import '../builtins/index';

const bars = Array.from({ length: 5 }, (_, i) => ({
  openTime: 1_700_000_000_000 + i * 60_000,
  open: i, high: i + 1, low: i - 1, close: 100 + i, volume: 1,
}));

const num = (v: unknown): unknown =>
  v !== null && typeof v === 'object' && 'v' in v ? v.v : v;

const run = (src: string) =>
  runScript(parse(`//@version=6\nindicator("t")\n${src}`), bars, { symbol: 'X', timeframe: '1' });

const firstPlot = (r: RunResult, title: string): unknown => num(r.plots.get(title)!.values[0]);

describe('A1′ ScalarSpec — args declared value-semantic arrive unwrapped', () => {
  // ── advisor-sampled five (plan §9.5) ─────────────────────────────────────
  it('arr.join(n) — ident separator (regression guard; passes pre-port)', async () => {
    const r = await run(`
a = array.from(1, 2, 3)
n = ","
plot(str.length(a.join(n)), "len")`);
    expect(firstPlot(r, 'len')).toBe(5); // "1,2,3"
  });

  it('array.slice(arr, 0, n) — ident index_to (regression guard; passes pre-port)', async () => {
    const r = await run(`
arr = array.from(1, 2, 3, 4)
k = 3
plot(array.size(array.slice(arr, 0, k)), "size")`);
    expect(firstPlot(r, 'size')).toBe(3);
  });

  it('math.round(x, p) — ident precision (regression guard; value same pre/post port)', async () => {
    const r = await run(`
p = 2
plot(str.tostring(math.round(3.14159, p)), "s")`);
    expect(firstPlot(r, 's')).toBe('3.14');
  });

  it('math.tonumber(5) — literal arg (regression guard; fixed by math.ts hotfix)', async () => {
    const r = await run(`plot(math.tonumber(5), "tn")`);
    expect(firstPlot(r, 'tn')).toBe(5);
  });

  // ── DISCRIMINATING ───────────────────────────────────────────────────────
  it('input.int(minval = na-ident) — named arg must be dropped (DISCRIMINATING)', async () => {
    const r = await run(`
m = na
input.int(5, "k", minval = m)
plot(close, "c")`);
    expect(r.inputs).toHaveLength(1);
    expect(r.inputs[0]!.minval).toBeUndefined(); // pre-port: 0
  });

  it('input.int(maxval = na-ident) — named arg must be dropped (DISCRIMINATING)', async () => {
    const r = await run(`
m = na
input.int(5, "k", maxval = m)
plot(close, "c")`);
    expect(r.inputs[0]!.maxval).toBeUndefined(); // pre-port: 0
  });

  it('str.join(arr, sep) — ident array + ident separator (DISCRIMINATING)', async () => {
    const r = await run(`
a = array.from(1, 2, 3)
n = ","
plot(str.length(str.join(a, n)), "len")`);
    expect(firstPlot(r, 'len')).toBe(5); // pre-port: 9 ("[1, 2, 3]")
  });

  it('color.rgb(r, g, b) — ident channels (regression guard; channels already unwrapped pre-port)', async () => {
    const r = await run(`
r = 10
g = 20
b = 30
plot(color.rgb(r, g, b) == color.rgb(10, 20, 30) ? 1 : 0, "eq")`);
    expect(firstPlot(r, 'eq')).toBe(1);
  });

  // ── declaration-table must NOT touch history semantics (plan §8.10) ───────
  it('array.variance(a, biased-ident) — declared arg still computes', async () => {
    const r = await run(`
a = array.from(1, 2, 3, 4)
biased = true
plot(array.variance(a, biased), "v")`);
    expect(firstPlot(r, 'v')).toBeCloseTo(1.25, 10);
  });

  it('array.percentile_linear_interpolation(a, p) — ident percentage', async () => {
    const r = await run(`
a = array.from(1, 2, 3, 4)
p = 50
plot(array.percentile_linear_interpolation(a, p), "p")`);
    expect(firstPlot(r, 'p')).toBeCloseTo(2.5, 10);
  });

  it('array.fill(a, v, index, na-ident length) — declared length reaches the na default', async () => {
    const r = await run(`
a = array.new(3, 0)
lna = na
array.fill(a, 7, 1, lna)
plot(array.get(a, 2), "x")`);
    // With the declaration the ident arrives as na ⇒ fill to end ⇒ 7.
    // Same site measured pre-port in docs/superpowers/plans/2026-10-16-tb-pine-debt-three.md §9.3
    // (wrapped na defeated the `kind === 'na'` guard ⇒ 0 cells filled).
    expect(firstPlot(r, 'x')).toBe(7);
  });
});

// Sites the declaration table cannot reach: the key is chosen at runtime, so
// the read point itself must unwrap (plan §9.5, step 5).
describe('A1′ step 5 — in-place unwrap at dynamic-key read points', () => {
  it('str.format("{p,percent}", p = ident) — named spec must see the scalar (DISCRIMINATING)', async () => {
    const r = await run(`
pv = 0.25
log.info("{p,percent}", p = pv)
plot(close, "c")`);
    expect(r.logs[0]!.msg).toBe('25.00%'); // pre-fix: "0.25" (spec not applied)
  });

  it('log.info("{n}", n = ident) — named placeholder renders the scalar', async () => {
    const r = await run(`
nm = "Bob"
log.info("hi {name}", name = nm)
plot(close, "c")`);
    expect(r.logs[0]!.msg).toBe('hi Bob');
  });

  it('table.cell_set_text(t, 0, 0, ident) — cell reads the scalar (engine path)', async () => {
    const r = await run(`
var table t = table.new(position.top_right, 1, 1)
txt = "hi"
table.cell_set_text(t, 0, 0, txt)
plot(close, "c")`);
    const obj = r.drawings[0]!;
    // `props.cells` is a Map at runtime; the DrawObj props type is not exported.
    const cells = obj.props.cells as Map<string, { text?: string }>;
    expect(cells.get('0,0')?.text).toBe('hi');
  });
});
