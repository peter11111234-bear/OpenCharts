// ── Named arguments on the JIT binder ───────────────────────────────────────
// named_args.test.ts pins the interpreted binder (`bindCallArgs`,
// interpreter.ts); this file pins its JIT counterpart (`bindArgsJit`) so the
// two cannot drift. Same two UDF cases, but evaluated by the JIT-compiled
// top-level body:
//
//   unknown    `f(bogus=3)` was staged as a *positional* and bound to the next
//              free slot, so the typo silently wrote 3 into parameter 0.
//   duplicate  `f(a=3, a=9)` dropped the second binding without a word.
//
// The expression JIT is opt-in (debugFlags `jit` / `jitUdf`, read live from
// globalThis or the environment), so both switches are turned on below — this
// file behaves the same with `PINE_JIT=1 PINE_JIT_UDF=1` already exported.

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { __pineJitStats, runScript } from '../interpreter';
import type { RunResult } from '../contracts';
import '../builtins/index';
import { mkBars } from './golden';

const prevJit = process.env.PINE_JIT;
const prevUdf = process.env.PINE_JIT_UDF;
process.env.PINE_JIT = '1';
process.env.PINE_JIT_UDF = '1';
afterAll(() => {
  if (prevJit === undefined) delete process.env.PINE_JIT;
  else process.env.PINE_JIT = prevJit;
  if (prevUdf === undefined) delete process.env.PINE_JIT_UDF;
  else process.env.PINE_JIT_UDF = prevUdf;
});

const BARS = mkBars(3);
const OPTS = { symbol: 'X', timeframe: 'D', fetchSeries: async () => [] } as const;
const run = (body: string): Promise<RunResult> =>
  runScript(parse(`indicator("t")\n${body}`), BARS, OPTS);

/** First plot's per-bar numeric values ('na' for anything non-numeric). */
function plotNums(r: RunResult): unknown[] {
  const plot = r.plots.get('plot_0') ?? r.plots.values().next().value;
  return (plot?.values ?? []).map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na'));
}

describe('named arguments through the JIT binder', () => {
  it('runs the compiled top-level body — the guard is not vacuous', async () => {
    const before = __pineJitStats.runs;
    await run('plot(close)');
    expect(__pineJitStats.runs).toBeGreaterThan(before);
  });

  it('a UDF call warns and does not write the parameter', async () => {
    const r = await run(`f(a) =>
    a
plot(f(bogus=3))`);
    const warns = r.warnings.filter(w => w.startsWith('unknown named argument'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('(a)');
    expect(plotNums(r)).toEqual(['na', 'na', 'na']);
  });

  it('a dropped named argument frees its slot for the positional that follows', async () => {
    const r = await run(`f(a) =>
    a
plot(f(bogus=9, 3))`);
    expect(r.warnings.filter(w => w.startsWith('unknown named argument'))).toHaveLength(1);
    // 9 used to be staged as a positional and won parameter 0; now only the
    // real positional (3) fills it.
    expect(plotNums(r)).toEqual([3, 3, 3]);
  });

  it('a duplicated UDF argument warns and keeps the first binding', async () => {
    const r = await run(`f(a) =>
    a
plot(f(a=3, a=9))`);
    const warns = r.warnings.filter(w => w.startsWith('duplicate named argument'));
    expect(warns).toHaveLength(1);
    expect(plotNums(r)).toEqual([3, 3, 3]);
  });
});
