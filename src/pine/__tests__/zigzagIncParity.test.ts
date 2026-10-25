// Incremental parity with the ZigZag stub in play: a live session ticked through
// the DIY script with switch_fibonacci on must match a fresh full run. The stub
// keeps its state in a `var` UDT, so this checks that the state rolls back on a
// forming-bar tick and is not double-applied when a bar commits.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { parse } from '../parser';
import { incRun, runScript, type IncLive } from '../interpreter';
import type { BarData, RunResult } from '../contracts';
import '../builtins/index';
import '../mtf';

const SRC_PATH = 'C:/Users/bear9/pine-editor-fix-evidence/diy-tv-clean-full.txt';
const LEDGER = readFileSync(SRC_PATH, 'utf8').replace(/^\uFEFF/, '');
const INPUTS = { Fibonacci: true };
const OPTS = { symbol: 'X', timeframe: '5', inputValues: INPUTS };

const oscBars = (n: number): BarData[] => {
  const bars: BarData[] = [];
  for (let i = 0; i < n; i++) {
    const p = 22000 + Math.sin(i / 8) * 500 + Math.sin(i / 3) * 80;
    bars.push({ openTime: i * 300000, open: p, high: p + 40, low: p - 40, close: p + 5, volume: 1000 });
  }
  return bars;
};

/** Same observable surfaces as inc-parity.test.ts `expectSame`. */
const expectSame = (a: RunResult, b: RunResult) => {
  const plotVals = (r: RunResult) =>
    [...r.plots.entries()].map(([k, p]) => [k, p.values.map((v) => JSON.stringify(v))]);
  expect(plotVals(a)).toEqual(plotVals(b));
  expect(a.drawings.map((d) => [d.kind, JSON.stringify(d.props)])).toEqual(
    b.drawings.map((d) => [d.kind, JSON.stringify(d.props)]));
  expect(a.warnings).toEqual(b.warnings);
};

describe('incremental parity: DIY ZigZag / Fibonacci', () => {
  it('forming-bar tick, then a committed bar, both match a full rerun', { timeout: 300_000 }, async () => {
    const parsed = parse(LEDGER);
    const bars = oscBars(80);

    const first = await incRun(parsed, bars, { incKey: 'zz', incSession: null, inputValues: INPUTS });
    expect(first.live, 'session should be live for the DIY script').not.toBeNull();
    expectSame(first.result, await runScript(parse(LEDGER), bars, OPTS));

    // Tick the forming bar: same length, last bar moved.
    const ticked = bars.slice();
    const last = ticked[ticked.length - 1]!;
    ticked[ticked.length - 1] = { ...last, high: last.high + 120, close: last.close + 60 };
    const r = await incRun(parsed, ticked, { incKey: 'zz', incSession: first.live as IncLive, inputValues: INPUTS });
    expectSame(r.result, await runScript(parse(LEDGER), ticked, OPTS));

    // Commit: append a bar, so the forming bar becomes closed.
    const next = ticked[ticked.length - 1]!.openTime + 300000;
    const grown = [...ticked, { openTime: next, open: 22000, high: 22300, low: 21800, close: 22100, volume: 900 }];
    const r2 = await incRun(parsed, grown, { incKey: 'zz', incSession: r.live as IncLive, inputValues: INPUTS });
    expectSame(r2.result, await runScript(parse(LEDGER), grown, OPTS));

    // The incremental result must actually carry the Fibonacci levels, not just
    // agree with a run that drew nothing: horizontal lines, one per level.
    const levels = r2.result.drawings.filter((d) => d.kind === 'line' && d.props.y1 === d.props.y2);
    expect(levels.length).toBeGreaterThan(0);
  });
});
