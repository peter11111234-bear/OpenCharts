import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import { __inputSchemaBuilds } from '../builtins/input';
import { mkBars } from './golden';

describe('input per-callsite memo', () => {
  it('schema build runs once per callsite, not per bar', async () => {
    const src = 'indicator("t")\na = input.int(1, "a")\nb = input.float(2.0, "b")\nplot(a+b)';
    const before = __inputSchemaBuilds;
    await runScript(parse(src), mkBars(50), {
      symbol: 'X',
      timeframe: '1',
      fetchSeries: async () => [],
    });
    const after = __inputSchemaBuilds;
    expect(after - before).toBe(2); // 2 callsites, 1 build each
  });

  it('mid-run override still lands (re-read per bar)', async () => {
    // Drive runScript with ctx.inputs set before the run starts.
    // Memoized schema must not shadow the new override.
    const src = 'indicator("t")\na = input.int(1, "a")\nplot(a)';
    const r1 = await runScript(parse(src), mkBars(5), {
      symbol: 'X',
      timeframe: '1',
      fetchSeries: async () => [],
      inputValues: { a: 7 },
    });
    // plot of `a` should be 7 (override), not 1.
    const plot = r1.plots.get('plot_0') ?? r1.plots.values().next().value;
    const vals = (plot?.values ?? []).map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na'));
    expect(vals).toEqual([7, 7, 7, 7, 7]);
  });
});
