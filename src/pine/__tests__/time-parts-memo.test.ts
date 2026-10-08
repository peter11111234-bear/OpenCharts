import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import { __partsOfCalls } from '../builtins/time';
import { mkBars } from './golden';

describe('partsOf memoization', () => {
  it('hour(x)+minute(x)+year(x) on same ms hits Intl once', async () => {
    const src = 'indicator("t")\nplot(hour)\nplot(minute)\nplot(year)';
    const bars = mkBars(20); // mkBars(n, startMs=0, stepMs=60_000) — no callback (golden.ts:17)
    const before = __partsOfCalls;
    await runScript(parse(src), bars, {
      symbol: 'X',
      timeframe: '1',
      fetchSeries: async () => [],
    });
    const after = __partsOfCalls;
    // Each bar evaluates 3 fields — but Intl.formatToParts must run ≤1 per distinct ms.
    // 20 bars → ≤20 formatToParts calls (vs ~60 before).
    expect(after - before).toBeLessThanOrEqual(bars.length);
  });
});
