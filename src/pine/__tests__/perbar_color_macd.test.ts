// Probe: dump every plot's distinct per-bar colors for MACD雙周期V7.
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';
import '../mtf';

const SRC = readFileSync('C:/Users/bear9/high452/MACD雙周期/V7/MACD雙周期V7.TXT', 'utf8');

const mkBars = (n: number) => {
  const bars = []; let p = 22000;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 20) * 100 + ((i * 7919) % 100 - 50) * 0.8;
    bars.push({ openTime: i * 900000, open: p, high: p + 50, low: p - 50, close: p + 10, volume: 1000 + i });
  }
  return bars;
};

describe('MACDV7 color dump', () => {
  it('lists each plot + distinct colors', async () => {
    const r = await runScript(parse(SRC), mkBars(200), { symbol: '2330', timeframe: '15' });
    for (const [title, p] of r.plots) {
      const dc = [...new Set(p.colors)];
      const vals = p.values.slice(-5).map(v => v.kind === 'int' || v.kind === 'float' ? v.v : v.kind);
      console.log(`${title} | colors: ${JSON.stringify(dc)} | last5: ${JSON.stringify(vals)}`);
    }
    console.log('warns:', r.warnings.slice(0, 10));
  }, 60000);
});
