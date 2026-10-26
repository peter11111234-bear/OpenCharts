import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import '../mtf';
import { mkBars } from './golden';

// request.security inside a UDF whose symbol/timeframe are the UDF's own
// parameters (DIY Custom Strategy Builder's pvsra_imnt / pvsraHigh(…)). The
// prefetch pass tries those args at global scope, where the parameters do not
// exist; that speculative miss must stay silent and the call must still
// resolve per call at run time.
const SRC = [
  'indicator("t")',
  'byRes(res, src) => request.security(syminfo.tickerid, res, src, barmerge.gaps_off, barmerge.lookahead_off)',
  'bySym(useAlt, alt, tick) => request.security(useAlt ? alt : tick, "", high, barmerge.gaps_off, barmerge.lookahead_off)',
  'plot(byRes("", close), "r")',
  'plot(bySym(false, "AAA", syminfo.tickerid), "s")',
].join('\n');

describe('request.security with UDF-parameter symbol/timeframe', () => {
  it('raises no identifier warnings and still yields values', async () => {
    const bars = mkBars(6);
    const r = await runScript(parse(SRC), bars, {
      symbol: 'X', timeframe: '1', fetchSeries: async () => bars,
    } as never);
    expect(r.warnings).toEqual([]);
    for (const p of r.plots.values()) {
      expect(p.values.some((v) => v.kind === 'int' || v.kind === 'float')).toBe(true);
    }
  });
});
