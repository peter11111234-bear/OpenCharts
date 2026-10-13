// ── math.* named arguments are matched against TV's reference signature ─────
// liftNums appended every named value as if it were positional, so
// `math.round(1.5, bogus=1)` read `bogus` as `precision` (2 → 1.5) with no
// message. Names below come from docs/tv-pine-stdlib.json
// (math.round(number, precision), math.pow(base, exponent), …).

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

describe('math.* unknown named arguments', () => {
  it('math.round(1.5, bogus=1) warns once and keeps the precision-less result', async () => {
    const r = await run('plot(math.round(1.5, bogus=1))');
    expect(unknown(r)).toHaveLength(1);
    expect(unknown(r)[0]).toBe(
      "unknown named argument 'bogus=' — ignored; this function takes (number, precision)");
    // Same as math.round(1.5) → int 2, NOT 1.5 rounded to one decimal.
    expect(plotNums(r)).toEqual([2, 2, 2]);
  });

  it('the reference names bind (math.round(number=, precision=))', async () => {
    const named = await run('plot(math.round(number=1.5, precision=1))');
    const positional = await run('plot(math.round(1.5, 1))');
    expect(unknown(named)).toEqual([]);
    expect(plotNums(named)).toEqual(plotNums(positional));
    expect(plotNums(named)).toEqual([1.5, 1.5, 1.5]);
  });

  it('other liftNums builtins warn through the same helper', async () => {
    // math.pow(base, exponent) — valid named call is unchanged…
    const ok = await run('plot(math.pow(base=2, exponent=3))');
    expect(unknown(ok)).toEqual([]);
    expect(plotNums(ok)).toEqual([8, 8, 8]);

    // …an unknown name is dropped (the value stays 2^3, not 2^9).
    const bad = await run('plot(math.pow(base=2, exponent=3, bogus=9))');
    expect(unknown(bad)).toHaveLength(1);
    expect(unknown(bad)[0]).toBe(
      "unknown named argument 'bogus=' — ignored; this function takes (base, exponent)");
    expect(plotNums(bad)).toEqual([8, 8, 8]);

    // math.todegrees(radians) — second call site, same message shape.
    const deg = await run('plot(math.todegrees(radians=1, bogus=1))');
    expect(unknown(deg)).toHaveLength(1);
    expect(unknown(deg)[0]).toBe(
      "unknown named argument 'bogus=' — ignored; this function takes (radians)");

    // math.max is variadic: the reference label is reported verbatim.
    const vmax = await run('plot(math.max(1, bogus=2))');
    expect(unknown(vmax)).toHaveLength(1);
    expect(unknown(vmax)[0]).toBe(
      "unknown named argument 'bogus=' — ignored; this function takes (number0, number1, ...)");
    expect(plotNums(vmax)).toEqual([1, 1, 1]);

    // …and because the ladder is unbounded, any number<k> a caller names still
    // binds (rejecting number2= would be a divergence of our own making).
    const vnum = await run('plot(math.max(number0=1, number2=9))');
    expect(unknown(vnum)).toEqual([]);
    expect(plotNums(vnum)).toEqual([9, 9, 9]);
  });
});
