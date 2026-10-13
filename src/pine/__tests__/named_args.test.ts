// ── Unknown named arguments are surfaced, never silently dropped ────────────
// TV rejects an unknown named argument at compile time ("Unknown argument").
// This engine has no signature table at parse time, so both bind paths name the
// argument at runtime and continue — hard-erroring would break scripts that run
// today. Two silent paths existed (both measured, both fixed here):
//
//   builtins   `bindArgs` (builtins/util.ts) — an unknown key landed in the Map
//              under a name nobody reads, so the slot stayed undefined/NA. This
//              is what made R20's MZigZag return all-na: `array.unshift(a,
//              value=v)` hit an internal slot named 'val'.
//   UDF calls  `bindCallArgs` (interpreter.ts) — the arg was pushed onto the
//              positionals list and bound to the next free slot, so
//              `f(bogus=3)` silently wrote 3 into parameter 0.

import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { RunResult } from '../contracts';
import '../builtins/index';
import { mkBars } from './golden';

const BARS = mkBars(3);
const OPTS = { symbol: 'X', timeframe: 'D', fetchSeries: async () => [] } as const;
const run = (body: string): Promise<RunResult> =>
  runScript(parse(`indicator("t")\n${body}`), BARS, OPTS);

/** First plot's per-bar numeric values ('na' for anything non-numeric). */
function plotNums(r: RunResult): unknown[] {
  const plot = r.plots.get('plot_0') ?? r.plots.values().next().value;
  return (plot?.values ?? []).map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na'));
}
const unknown = (r: RunResult) => r.warnings.filter(w => w.startsWith('unknown named argument'));

describe('unknown named arguments', () => {
  it('a builtin warns and names both the argument and the real signature', async () => {
    const r = await run(`a = array.new_int(0)
array.push(a, bogus=1)
plot(array.get(a, 0))`);
    expect(unknown(r)).toHaveLength(1);
    expect(unknown(r)[0]).toContain("'bogus='");
    expect(unknown(r)[0]).toContain('(id, value)');
    // The behaviour change is the warning, not the value: the slot stays unbound.
    expect(plotNums(r)).toEqual(['na', 'na', 'na']);
  });

  it('a ta.* call warns too', async () => {
    const r = await run('plot(ta.sma(close, 5, bogus=1))');
    expect(unknown(r)).toHaveLength(1);
    expect(unknown(r)[0]).toContain('(source, length)');
  });

  it('the reference name for a slot binds (R20 guard: array.unshift value=)', async () => {
    const r = await run(`a = array.new_int(0)
array.unshift(a, value=7)
plot(array.get(a, 0))`);
    expect(unknown(r)).toEqual([]);
    expect(plotNums(r)).toEqual([7, 7, 7]);
  });

  it('the series→source alias still binds (no false positive)', async () => {
    const r = await run('plot(ta.sma(series=close, 2))');
    expect(unknown(r)).toEqual([]);
    const vals = plotNums(r);
    expect(vals[0]).toBe('na');            // window not full on bar 0
    expect(vals.slice(1).every(v => typeof v === 'number')).toBe(true);
  });

  it('a UDF call warns and does not write the parameter', async () => {
    const r = await run(`f(a) =>
    a
plot(f(bogus=3))`);
    expect(unknown(r)).toHaveLength(1);
    expect(unknown(r)[0]).toContain('(a)');
    expect(plotNums(r)).toEqual(['na', 'na', 'na']);
  });

  it('a duplicated UDF argument warns and keeps the first binding', async () => {
    const r = await run(`f(a) =>
    a
plot(f(a=3, a=9))`);
    expect(r.warnings.filter(w => w.startsWith('duplicate named argument'))).toHaveLength(1);
    expect(plotNums(r)).toEqual([3, 3, 3]);
  });
});
