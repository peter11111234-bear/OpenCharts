import { describe, it, expect } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';
import '../mtf';

const mkBars = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ openTime: i * 60000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }));

describe('probe: time("60") builtin vs time series shadow', () => {
  it('time(tf) non-na on period-boundary bars only', async () => {
    const src = `//@version=6\nindicator("t")\nplot(time("60"), "b")\n`;
    const r = await runScript(parse(src), mkBars(130), { symbol: 'T', timeframe: '1' });
    const vals = r.plots.get('b')!.values;
    expect(vals[0]?.kind).not.toBe('na');
    expect(vals[0]?.v).toBe(0);
    expect(vals[1]?.kind).toBe('na');
    expect(vals[60]?.v).toBe(3600000);
    expect(vals[120]?.v).toBe(7200000);
    expect(r.warnings.filter(w => /not a function/.test(w))).toHaveLength(0);
  }, 30000);
});
