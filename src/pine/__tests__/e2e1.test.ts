import { describe, it } from 'vitest';
import { readFileSync } from 'fs';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';
import '../mtf';
const mkBars = (n: number) => {
  const bars = []; let p = 22000;
  for (let i = 0; i < n; i++) { p += Math.sin(i / 20) * 100 + ((i * 7919) % 100 - 50) * 0.8; bars.push({ openTime: i * 3600000, open: p, high: p + 50, low: p - 50, close: p + 10, volume: 1000 + i }); }
  return bars;
};
describe('MACD701', () => {
  it('runs', async () => {
    const src = readFileSync('C:/Users/bear9/high452/MACD701.TXT', 'utf8').replace(/^\uFEFF/, '');
    const parsed = parse(src);
    const t0 = Date.now();
    const r = await runScript(parsed, mkBars(300), { symbol: '2330', timeframe: '60' });
    console.log('ms:', Date.now() - t0, 'title:', r.title, '| plots:', [...r.plots.keys()].length, '| warns:', r.warnings.slice(0, 8));
  }, 55000);
});
