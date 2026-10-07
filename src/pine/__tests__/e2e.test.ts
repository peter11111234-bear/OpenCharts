import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { RunResult } from '../contracts';
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

/** Assert alignment surface: low warn count + expected plot/drawing output. */
const check = (r: RunResult, opts: {
  maxWarns?: number; minPlots?: number; minDrawings?: number;
}) => {
  const maxWarns = opts.maxWarns ?? 3;
  const warns = r.warnings.filter(w => !/lookahead|dynamic/.test(w));
  if (warns.length > maxWarns) {
    // Print full warn list on failure for diagnosis
    console.log('WARN STORM:', warns.slice(0, 20));
  }
  expect(warns.length).toBeLessThanOrEqual(maxWarns);
  if (opts.minPlots) expect(r.plots.size).toBeGreaterThanOrEqual(opts.minPlots);
  if (opts.minDrawings) expect(r.drawings.length).toBeGreaterThanOrEqual(opts.minDrawings);
};

describe('e2e user scripts', () => {
  it('MACD701', async () => {
    const src = readFileSync('C:/Users/bear9/high452/MACD701.TXT', 'utf8').replace(/^\uFEFF/, '');
    const parsed = parse(src);
    const r = await runScript(parsed, mkBars(500), { symbol: '2330', timeframe: '60' });
    console.log('MACD701 → title:', r.title, '| plots:', [...r.plots.keys()].length, '| drawings:', r.drawings.length, '| warns:', r.warnings.slice(0, 6));
    check(r, { minPlots: 3 });
  }, 60000);
  it('見高K4.55', async () => {
    const src = readFileSync('C:/Users/bear9/high452/HIGH455/見高K4.54/見高K4.55.TXT', 'utf8').replace(/^\uFEFF/, '');
    const parsed = parse(src);
    const r = await runScript(parsed, mkBars(500), { symbol: '2330', timeframe: '15' });
    console.log('K455 → plots:', [...r.plots.keys()].length, '| drawings:', r.drawings.length, '| warns:', r.warnings.slice(0, 6));
    check(r, { minPlots: 5, minDrawings: 1 });
  }, 60000);
  it('TRIS390', async () => {
    const src = readFileSync('C:/Users/bear9/high452/TRIS39/TRIS390.TXT', 'utf8').replace(/^\uFEFF/, '');
    const parsed = parse(src);
    const r = await runScript(parsed, mkBars(500), { symbol: '2330', timeframe: '15', fetchSeries: async () => mkBars(500) });
    console.log('TRIS390 → plots:', [...r.plots.keys()].length, '| warns:', r.warnings.slice(0, 6));
    check(r, { minPlots: 20, minDrawings: 1 });
  }, 60000);
  it('TD_BB', async () => {
    const src = readFileSync('C:/Users/bear9/high452/TD_BB/TD_BB.txt', 'utf8').replace(/^\uFEFF/, '');
    const parsed = parse(src);
    const r = await runScript(parsed, mkBars(500), { symbol: '2330', timeframe: '60' });
    console.log('TD_BB → plots:', [...r.plots.keys()].length, '| warns:', r.warnings.slice(0, 6));
    check(r, { minPlots: 15 });
  }, 60000);
  it('turtle', async () => {
    const src = readFileSync('C:/Users/bear9/high452/turtle system.txt', 'utf8').replace(/^\uFEFF/, '');
    const parsed = parse(src);
    const r = await runScript(parsed, mkBars(500), { symbol: '2330', timeframe: 'D' });
    console.log('turtle → plots:', [...r.plots.keys()].length, '| warns:', r.warnings.slice(0, 6));
    check(r, { minPlots: 3 });
  }, 60000);
  it('高量1.46', async () => {
    const src = readFileSync('C:/Users/bear9/high452/高量1.46/高量1.46_backup.TXT', 'utf8').replace(/^\uFEFF/, '');
    const parsed = parse(src);
    const r = await runScript(parsed, mkBars(500), { symbol: '2330', timeframe: 'D', fetchSeries: async () => mkBars(500) });
    console.log('高量 → plots:', [...r.plots.keys()].length, '| warns:', r.warnings.slice(0, 6));
    check(r, { minPlots: 3 });
  }, 60000);
  it('MACD雙周期V7', async () => {
    const src = readFileSync('C:/Users/bear9/high452/MACD雙周期/V7/MACD雙周期V7.TXT', 'utf8').replace(/^\uFEFF/, '');
    const parsed = parse(src);
    const r = await runScript(parsed, mkBars(500), { symbol: '2330', timeframe: '60' });
    console.log('MACD雙周期V7 → plots:', [...r.plots.keys()].length, '| warns:', r.warnings.slice(0, 6));
    check(r, { minPlots: 15 });
  }, 60000);
  it('MACD701_v72', async () => {
    const src = readFileSync('C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine', 'utf8').replace(/^\uFEFF/, '');
    const parsed = parse(src);
    const r = await runScript(parsed, mkBars(500), { symbol: '2330', timeframe: '60' });
    console.log('MACD701_v72 → plots:', [...r.plots.keys()].length, '| warns:', r.warnings.slice(0, 6));
    check(r, { minPlots: 3 });
  }, 60000);
});
