// Fibonacci wiring: the `TradingView/ZigZag` library stub is backed by our own
// `src/pine/zigzag.ts` state machine, so the script's Fibonacci block finally
// computes. These tests pin that the stub receives the real per-bar data and
// the call context, and that the level prices are the numbers the script's own
// formula (`startPrice2 + height * level`) must produce. They do NOT pin
// TradingView parity — the library source is unavailable.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { BarData, DrawObj, RunResult } from '../contracts';
import '../builtins/index';
import '../mtf';

const OPTS = { symbol: 'X', timeframe: '5' };
const SRC_PATH = 'C:/Users/bear9/pine-editor-fix-evidence/diy-tv-clean-full.txt';
const BARS = 200;

/** Same shape as the `oscBars` generator in mzigzag_semantics.test.ts: enough
 *  swing to confirm many pivots at the script's default dev=3 / depth=10. */
const oscBars = (n: number): BarData[] => {
  const bars: BarData[] = [];
  for (let i = 0; i < n; i++) {
    const p = 22000 + Math.sin(i / 8) * 500 + Math.sin(i / 3) * 80;
    bars.push({ openTime: i * 300000, open: p, high: p + 40, low: p - 40, close: p + 5, volume: 1000 });
  }
  return bars;
};

const LEDGER = readFileSync(SRC_PATH, 'utf8').replace(/^\uFEFF/, '');

/** One run of the whole DIY script with only the Fibonacci switch forced. */
const runFib = (fibonacci: boolean, bars = oscBars(BARS)): Promise<RunResult> =>
  runScript(parse(LEDGER), bars, { ...OPTS, inputValues: { Fibonacci: fibonacci } });

/** Horizontal lines only: `_draw_line` sets both endpoints to the level price,
 *  so every Fibonacci level is one. The in-script supply/demand zigzag also
 *  draws lines on this data, but those are sloped. */
const fibLines = (r: RunResult): DrawObj[] =>
  r.drawings.filter((d) => d.kind === 'line' && d.props.y1 === d.props.y2);

/** `_draw_label` puts the level number first in the label text. */
const levelLabels = (r: RunResult): { level: number; y: number }[] =>
  r.drawings
    .filter((d) => d.kind === 'label' && typeof d.props.text === 'string')
    .map((d) => ({ level: Number(String(d.props.text).split('\n')[0]), y: Number(d.props.y) }))
    .filter((l) => Number.isFinite(l.level) && Number.isFinite(l.y));

describe('probe: `var` inside a UDF survives bars', () => {
  it('counts every call across 10 bars', async () => {
    const src = [
      '//@version=6',
      'indicator("probe", overlay = true)',
      'f() =>',
      '    var int n = 0',
      '    n += 1',
      '    n',
      'plot(f(), title = "probe")',
    ].join('\n');
    const r = await runScript(parse(src), oscBars(10), OPTS);
    const p = r.plots.get('probe')!;
    const last = p.values[p.values.length - 1]!;
    expect(last.kind).toBe('int');
    expect(last.kind === 'int' ? last.v : NaN).toBe(10);
  });
});

describe('DIY Fibonacci ← self-implemented ZigZag', () => {
  it('switch_fibonacci on: every fib level is drawn at startPrice2 + height*level', { timeout: 180_000 }, async () => {
    const bars = oscBars(BARS);
    const r = await runFib(true, bars);

    // Default show flags: levels 0, 0.5, 1. The dashed zigzag leg is sloped.
    const levels = fibLines(r);
    expect(levels.map((d) => d.props.y1)).toHaveLength(3);

    // Last confirmed pivot: start = the leg's origin point, end = where it
    // ended. `xloc.bar_time` lines carry those two timestamps.
    const leg = r.drawings.find((d) => d.kind === 'line' && d.props.xloc === 'xloc.bar_time' && d.props.y1 !== d.props.y2);
    expect(leg, 'zigzag leg line').toBeDefined();
    const startTime = Number(leg!.props.x1);
    const endTime = Number(leg!.props.x2);
    const startBar = bars.find((b) => b.openTime === startTime);
    const endBar = bars.find((b) => b.openTime === endTime);
    expect(startBar && endBar, `pivot bars at ${startTime}/${endTime}`).toBeTruthy();
    expect(endTime).toBeGreaterThan(startTime);
    // A confirmed pivot sits on a bar extreme, never mid-bar.
    expect(Math.abs(Number(leg!.props.y1) - startBar!.high) < 1e-9 || Math.abs(Number(leg!.props.y1) - startBar!.low) < 1e-9).toBe(true);
    expect(Math.abs(Number(leg!.props.y2) - endBar!.high) < 1e-9 || Math.abs(Number(leg!.props.y2) - endBar!.low) < 1e-9).toBe(true);

    // startPrice2 = lastP.end.price, height = lastP.start.price - lastP.end.price
    // (reverse2 is off by default), so level 0 is the end price and level 1 the
    // start price — here a down leg, hence descending.
    const endPrice = Number(leg!.props.y2);
    const startPrice2 = endPrice;
    const height = Number(leg!.props.y1) - endPrice;

    const byLevel = new Map(levelLabels(r).map((l) => [l.level, l.y]));
    for (const level of [0, 0.5, 1]) {
      const expected = startPrice2 + height * level;
      const line = levels.find((d) => Math.abs(Number(d.props.y1) - expected) < 1e-9);
      expect(line, `line at level ${level} = ${expected}`).toBeDefined();
      expect(Number(line!.props.x1)).toBe(startTime);
      expect(Number(line!.props.x2)).toBe(endTime);
      // The label carries the same price the line does.
      expect(byLevel.get(level)).toBeCloseTo(expected, 9);
    }
    expect(startPrice2 + height).toBeCloseTo(Number(leg!.props.y1), 9);
  });

  it('switch_fibonacci off: no Fibonacci levels, no zigzag leg', { timeout: 180_000 }, async () => {
    const r = await runFib(false);
    expect(fibLines(r)).toEqual([]);
    expect(r.drawings.filter((d) => d.kind === 'line' && d.props.xloc === 'xloc.bar_time')).toEqual([]);
  });
});
