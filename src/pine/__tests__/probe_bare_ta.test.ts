import { describe, it, expect } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';
import '../mtf';

const mkBars = (n: number) => {
  const bars = [];
  let p = 22000;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 20) * 100 + ((i * 7919) % 100 - 50) * 0.8;
    bars.push({ openTime: i * 3600000, open: p, high: p + 50, low: p - 50, close: p + 10, volume: 1000 + i });
  }
  return bars;
};

describe('probe: bare ta.* accumulators', () => {
  it('ta.wad / ta.pvt / ta.nvi / ta.pvi usable as variables incl. histref', async () => {
    const src = `
//@version=6
indicator("probe")
plot(ta.wad, "wad")
plot(ta.wad[1], "wad1")
plot(ta.pvt, "pvt")
plot(ta.nvi, "nvi")
plot(ta.pvi, "pvi")
`;
    const r = await runScript(parse(src), mkBars(30), { symbol: 'T', timeframe: '60' });
    const titles = [...r.plots.keys()];
    expect(titles).toEqual(['wad', 'wad1', 'pvt', 'nvi', 'pvi']);
    const values = (t: string) => r.plots.get(t)!.values;
    expect(values('wad')[0]?.v).toBe(0);
    expect(values('wad1')[0]?.kind).toBe('na');
    expect(values('nvi')[0]?.kind).toBe('na'); // bar 0: no prev close → accumulator not seeded
    expect(values('nvi')[29]?.v).toBeGreaterThanOrEqual(1000); // seeded at base 1000
  }, 30000);
});
