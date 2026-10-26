import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import '../mtf';
import { mkBars } from './golden';

// request.security re-evaluates the globals its expression reads in the tf
// context. That context must see the user's input overrides, not defaults.
const ONE = [
  'indicator("t")',
  'len = input.int(33, "Uniq")',
  'y = request.security(syminfo.tickerid, "1", len)',
  'plot(y, "y")',
].join('\n');

// Same, with two inputs sharing a title: the tf context must use the same
// per-input ids as the chart (len_2 for the second).
const DUP = [
  'indicator("t")',
  'a = input.int(10, "Len")',
  'b = input.int(20, "Len")',
  'y = request.security(syminfo.tickerid, "1", b)',
  'plot(y, "y")',
].join('\n');

async function lastY(src: string, inputValues: Record<string, unknown>) {
  const bars = mkBars(5);
  const r = await runScript(parse(src), bars, {
    symbol: 'X', timeframe: '1', fetchSeries: async () => bars, inputValues,
  } as never);
  const p = [...r.plots.values()][0]!;
  const v = p.values[p.values.length - 1]!;
  return v.kind === 'int' || v.kind === 'float' ? v.v : null;
}

describe('inputs read inside request.security', () => {
  it('see the override', async () => {
    expect(await lastY(ONE, {})).toBe(33);
    expect(await lastY(ONE, { Uniq: 44 })).toBe(44);
  });

  it('a shared title resolves per input, as on the chart', async () => {
    expect(await lastY(DUP, { len_2: 5 })).toBe(5);
    expect(await lastY(DUP, { Len: 7 })).toBe(20);
  });
});
