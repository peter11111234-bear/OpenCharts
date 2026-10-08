// ── MTF cache invariance suite ──────────────────────────────────────────────
// Promoted from scratch/divergence-wrapped.mjs (T1-T8) and
// scratch/final-sweep.mjs (N1-N6). Invariant under test: caller-agnostic
// caching, pruning and cutoff must not change observable semantics vs the
// per-caller path. Source-level (parsed) scripts, not hand-built AST —
// these pin user-visible behavior end to end.

import { describe, expect, it, beforeEach } from 'vitest';
import '../builtins/index'; // registers the full builtin set
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { resetMtf, __mtfStats } from '../mtf';
import type { BarData, RunResult, Value } from '../contracts';

const M15 = 900_000, H1 = 3_600_000;

const mkBars = (n: number, tfMs: number, start = 0, f: (i: number) => number = i => i): BarData[] =>
  Array.from({ length: n }, (_, i) => {
    const c = f(i);
    return { openTime: start + i * tfMs, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 100 + i };
  });

const valOf = (v: Value | undefined): number | 'na' =>
  v && (v.kind === 'int' || v.kind === 'float') ? v.v : 'na';

/** 24 × 15m chart bars; fetch serves '60' (6 × H1) and '15' (chart itself). */
const run = async (src: string, tf = '15'): Promise<RunResult> => {
  resetMtf();
  return runScript(parse(src), mkBars(24, M15, 0, i => 1000 + i), {
    symbol: 'T', timeframe: tf,
    fetchSeries: async (_s: string, t: string): Promise<BarData[]> =>
      t === '60' ? mkBars(6, H1, 0, i => 100 + i * 10)
        : t === '15' ? mkBars(24, M15, 0, i => 1000 + i)
          : [],
  });
};

const col = (res: RunResult, name: string): (number | 'na')[] =>
  (res.plots.get(name)?.values ?? []).map(valOf);

const snap = () => ({ ...__mtfStats });

describe('MTF cache invariance (promoted QA sweeps)', () => {
  beforeEach(resetMtf);

  it('T1: bar_index inside security is tf-domain, not chart-domain', async () => {
    const res = await run(`indicator("t")\nbi = request.security(syminfo.tickerid, "60", bar_index)\nplot(bi, "bi")`);
    const bi = col(res, 'bi');
    // Completed tf idx on a 15m chart: bars 0-3 → na, 4-7 → 0, 8-11 → 1, 20-23 → 4.
    expect(bi.slice(4, 8).every(v => v === 0)).toBe(true);
    expect(bi.slice(8, 12).every(v => v === 1)).toBe(true);
    expect(bi.slice(20, 24).every(v => v === 4)).toBe(true);
  });

  it('T2: var accumulation in a UDF — sequential draws per caller, never shared', async () => {
    // ctr() mutates a var slot → gate rejects → per-caller path → each call
    // draws the next counter value. b/c2 (different callers) and b2/d2
    // (same gated shape) must NOT see identical series — that would mean a
    // shared agnostic entry collapsed two draws into one.
    const src = [
      'indicator("t")',
      'ctr() =>',
      '    var c = -1',
      '    c := c + 1',
      '    c',
      'a = request.security(syminfo.tickerid, "60", ctr())',
      'w(x) => request.security(syminfo.tickerid, "60", ctr() + x * 0)',
      'b = w(1)',
      'c2 = w(2)',
      'w2(x) => request.security(syminfo.tickerid, "60", ctr())',
      'b2 = w2(1)',
      'd2 = w2(2)',
      'plot(a, "a")', 'plot(b, "b")', 'plot(c2, "c2")',
      'plot(b2, "b2")', 'plot(d2, "d2")',
    ].join('\n');
    const res = await run(src);
    const b = col(res, 'b'), c2 = col(res, 'c2');
    const b2 = col(res, 'b2'), d2 = col(res, 'd2');
    expect(b).not.toEqual(c2);   // shared-state bug would make these equal
    expect(b2).not.toEqual(d2);
    expect(b[4]).toBe(0);
    expect(c2[4]).toBe(1);                // second caller draws counter value 1
  });

  it('T3: break escaping a UDF is a hard error, not a silent bar-skip', async () => {
    // `if x → f()` where f contains `break`: stmtMayExitTop treats func
    // bodies as opaque → decls after the if get pruned; if the BREAK
    // silently escaped to the bar loop, ta.* ordinals would misalign.
    // Post-e990ec0 this is a runtime error.
    const src = [
      'indicator("t")',
      'f() =>',
      '    break',
      '    0',
      'x = close > 1010 and close < 1020',
      'if x',
      '    f()',
      'm = ta.sma(y, 2)',
      'y = bar_index',
      'plot(m, "m")',
    ].join('\n');
    await expect(run(src, '1')).rejects.toThrow(/'break' outside loop/);
  });

  it('T4: request.* nested in a UDF producer fails the gate', async () => {
    const src = [
      'indicator("t")',
      'q() => request.security(syminfo.tickerid, "15", close)',
      'a = request.security(syminfo.tickerid, "60", q())',
      'plot(a, "a")',
    ].join('\n');
    const s0 = snap();
    await run(src);
    expect(__mtfStats.gateFail - s0.gateFail).toBeGreaterThanOrEqual(1);
  });

  it('T5: same pure expr in two security nodes agrees bar-for-bar', async () => {
    const src = [
      'indicator("t")',
      'a = request.security(syminfo.tickerid, "60", close + 1)',
      'b = request.security(syminfo.tickerid, "60", close + 1)',
      'plot(a - b, "d")',
    ].join('\n');
    const res = await run(src);
    const d = col(res, 'd').slice(4);
    expect(d.every(v => v === 0 || v === 'na')).toBe(true);
  });

  it('T6: agnostic path ≡ per-caller path for mixed pure/caller-param exprs', async () => {
    const src = [
      'indicator("t")',
      'pure() => ta.sma(close, 5)',
      'cp(x) => x',
      'a = request.security(syminfo.tickerid, "60", ta.sma(close, 5) + pure() * 0)',
      'b = request.security(syminfo.tickerid, "60", ta.sma(close, 5) + cp(close) * 0)',
      'plot(a, "a")', 'plot(b, "b")',
    ].join('\n');
    const res = await run(src);
    expect(col(res, 'a')).toEqual(col(res, 'b'));
  });

  it('T7: var global producer keeps Pine once-init semantics on the chart side', async () => {
    // `var g = ctr()`: chart side inits once → constant. The tf view may
    // re-eval per tf bar (pre-existing Pine-approx), identical under both
    // cache paths — what we pin is the chart-side once-init invariant.
    const src = [
      'indicator("t")',
      'ctr() =>',
      '    var c = -1',
      '    c := c + 1',
      '    c',
      'var g = ctr()',
      'a = request.security(syminfo.tickerid, "60", g)',
      'plot(a, "a")',
      'plot(g, "g")',
    ].join('\n');
    const res = await run(src);
    const g = col(res, 'g');
    expect(g.every(v => v === 0 || v === 'na')).toBe(true);
  });

  it('T8: lookahead_on + agnostic cache — two specs stay identical', async () => {
    const src = [
      'indicator("t")',
      'a = request.security(syminfo.tickerid, "60", close, barmerge.gaps_off, barmerge.lookahead_on)',
      'b = request.security(syminfo.tickerid, "60", close + 0, barmerge.gaps_off, barmerge.lookahead_on)',
      'plot(a - b, "d")',
    ].join('\n');
    const res = await run(src);
    const d = col(res, 'd').slice(4);
    expect(d.every(v => v === 0 || v === 'na')).toBe(true);
  });

  it('N1: rejected expr keeps correct per-caller values + consistent var read', async () => {
    // w(p) references caller param p → gateFail → per-caller eval; the var
    // k = 10 read must still be identical for both callers.
    const src = [
      'indicator("t")',
      'f() =>',
      '    var k = 10',
      '    k + close',
      'w(p) => request.security(syminfo.tickerid, "60", f() + p)',
      'b = w(1)',
      'c2 = w(2)',
      'plot(b, "b")', 'plot(c2, "c2")',
    ].join('\n');
    const s0 = snap();
    const res = await run(src);
    expect(__mtfStats.gateFail - s0.gateFail).toBe(1);
    expect(__mtfStats.gatePass - s0.gatePass).toBe(0);
    const b = col(res, 'b'), c2 = col(res, 'c2');
    // tf closes 100..150 → b = tfClose + 10 + 1, four chart bars per tf bar.
    const wantB = [111, 111, 111, 111, 121, 121, 121, 121, 131, 131, 131, 131,
      141, 141, 141, 141, 151, 151, 151, 151];
    expect(b.slice(4)).toEqual(wantB);
    expect(c2.slice(4)).toEqual(wantB.map(v => v + 1));
  });

  it('N2: shared function-valued producer — agnostic ≡ per-caller values', async () => {
    const src = [
      'indicator("t")',
      'q() => close * 2',
      'a = request.security(syminfo.tickerid, "60", q())',
      'w(x) => request.security(syminfo.tickerid, "60", q() + x * 0)',
      'b = w(1)',
      'c2 = w(7)',
      'plot(a, "a")', 'plot(b, "b")', 'plot(c2, "c2")',
    ].join('\n');
    const s0 = snap();
    const res = await run(src);
    const a = col(res, 'a'), b = col(res, 'b'), c2 = col(res, 'c2');
    expect(a).toEqual(b);
    expect(b).toEqual(c2);
    expect(__mtfStats.gatePass - s0.gatePass).toBe(1);   // a gated pass
    expect(__mtfStats.gateFail - s0.gateFail).toBe(1);   // w gated fail
  });

  it('N3: read-only var global passes the gate and matches the non-var twin', async () => {
    const src = [
      'indicator("t")',
      'var g = close + 5',
      'g2 = close + 5',
      'a = request.security(syminfo.tickerid, "60", g)',
      'w(x) => request.security(syminfo.tickerid, "60", g + x * 0)',
      'b = w(1)',
      'c = request.security(syminfo.tickerid, "60", g2)',
      'plot(a, "a")', 'plot(b, "b")', 'plot(c, "c")',
    ].join('\n');
    const s0 = snap();
    const res = await run(src);
    expect(__mtfStats.gatePass - s0.gatePass).toBeGreaterThanOrEqual(1);
    expect(col(res, 'a')).toEqual(col(res, 'b')); // agnostic ≡ per-caller
    expect(col(res, 'a')).toEqual(col(res, 'c')); // var ≡ non-var in tf view
  });

  it('N4: nested security in a global producer — gate rejects, no shared caching', async () => {
    const src = [
      'indicator("t")',
      'q = () => request.security(syminfo.tickerid, "15", close)',
      'a = request.security(syminfo.tickerid, "60", q())',
      'plot(a, "a")',
    ].join('\n');
    const s0 = snap();
    const res = await run(src);
    expect(__mtfStats.gateFail - s0.gateFail).toBeGreaterThanOrEqual(1);
    // The inner call is served per-caller (its own eval) — never through
    // the shared agnostic cache for the nested node.
    expect(__mtfStats.agHits - s0.agHits).toBeLessThanOrEqual(1);
  });

  it('N5a: ephemeral UDF caller — fresh mutable array computed every chart bar', async () => {
    const src = [
      'indicator("t")',
      'arr(x) =>',
      '    a = request.security(syminfo.tickerid, "60", array.new(0))',
      '    array.push(a, x)',
      '    array.size(a)',
      's = arr(1)',
      'plot(s, "s")',
    ].join('\n');
    const s0 = snap();
    const res = await run(src);
    const s = col(res, 's');
    // Transient caller → nodeCache wiped → fresh array each bar → size 1
    // once a completed tf bar exists; 0 while tf bar0 still open.
    expect(s.slice(4).every(v => v === 1)).toBe(true);
    expect(s.slice(0, 4).every(v => v === 0)).toBe(true);
    expect(__mtfStats.evals - s0.evals).toBe(20); // one compute per chart bar
  });

  it('N5b: durable caller — per-caller cache accumulates pushes, never agnostic', async () => {
    const src = [
      'indicator("t")',
      'a = request.security(syminfo.tickerid, "60", array.new(0))',
      'array.push(a, 1)',
      's = array.size(a)',
      'plot(s, "s")',
    ].join('\n');
    const s0 = snap();
    const res = await run(src);
    const s = col(res, 's');
    // Same (node, caller, j) array returned across the 4 chart bars of a
    // tf bar → pushes accumulate; next tf bar gets a fresh array.
    expect(s[4]).toBe(1);
    expect(s[5]).toBe(2);
    expect(s[6]).toBe(3);
    expect(s[7]).toBe(4);
    expect(s[8]).toBe(1);
    expect(__mtfStats.evals - s0.evals).toBeLessThanOrEqual(8);  // ~tfBars
    expect(__mtfStats.agHits - s0.agHits).toBe(0);               // mutable never shared
  });

  it('N6: histref inside gated expr — agnostic ≡ per-caller twin', async () => {
    const src = [
      'indicator("t")',
      'a = request.security(syminfo.tickerid, "60", close[1] + 1)',
      'w(x) => request.security(syminfo.tickerid, "60", close[1] + x * 0)',
      'b = w(1)',
      'plot(a, "a")', 'plot(b, "b")',
    ].join('\n');
    const res = await run(src);
    const a = col(res, 'a'), b = col(res, 'b');
    // a = close[1]+1, b = close[1] → a[i] == b[i]+1 on non-na bars.
    const shifted = b.map(v => (v === 'na' ? 'na' : v + 1));
    expect(a).toEqual(shifted);
  });
});
