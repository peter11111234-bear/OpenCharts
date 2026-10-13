// ── Small TV v6 alignment batch: timeframe periods, array/drawing copies ────
// Semantics quoted from the v6 reference kept at scratch/pine-v6-kb
// (dist/bundles/timeframe.md, array.md, label.md):
//
//   timeframe.change(tf)   "Returns true on the first bar of a new timeframe"
//   timeframe.main_period  "A string representation of the script's main
//                          timeframe … <quantity>[<unit>] … '10S', '30',
//                          '240', '1D', '2W', '3M'"; unlike timeframe.period it
//                          does NOT follow a request.*() expression argument
//   timeframe.isticks      "true if current resolution is a ticks resolution"
//   array.copy(id)         "creates a copy of an existing array"
//   label/box/line.copy()  "Clones the … object" → a new live id

import { describe, expect, it } from 'vitest';
import { getConstant } from '../builtins';
import '../builtins';
import { tfString } from '../mtf';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { RunResult } from '../contracts';
import { mkBars } from './golden';

const BARS = mkBars(3);
const run = (src: string, timeframe = 'D'): Promise<RunResult> =>
  runScript(parse(`indicator("t")\n${src}`), BARS,
    { symbol: 'X', timeframe, fetchSeries: async () => [] });

/** First plot's per-bar numeric values ('na' for anything non-numeric). */
function plotNums(r: RunResult): unknown[] {
  const plot = r.plots.get('plot_0') ?? r.plots.values().next().value;
  return (plot?.values ?? []).map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na'));
}
const ofKind = (r: RunResult, kind: string) => r.drawings.filter(d => d.kind === kind);

describe('timeframe.* — spellings and period boundaries', () => {
  it('tfString spells timeframes the way the reference documents them', () => {
    expect(tfString('10S')).toBe('10S');
    expect(tfString('30')).toBe('30');   // 30 minutes: unit omitted
    expect(tfString('4H')).toBe('240');  // hours are expressed in minutes
    expect(tfString('1D')).toBe('1D');
    expect(tfString('2W')).toBe('2W');
    expect(tfString('3M')).toBe('3M');
  });

  it('main_period is a simple string that never changes with the chart unit', async () => {
    expect(getConstant('timeframe.main_period', { timeframe: { mainPeriod: 'D' } }))
      .toEqual({ kind: 'string', v: '1D' });
    expect(getConstant('timeframe.main_period', { timeframe: { mainPeriod: '4H' } }))
      .toEqual({ kind: 'string', v: '240' });
    expect(plotNums(await run('plot(timeframe.main_period == "1D" ? 1 : 0)'))).toEqual([1, 1, 1]);
  });

  it('isticks is false — nothing in this engine resolves to ticks', async () => {
    expect(getConstant('timeframe.isticks')).toEqual({ kind: 'bool', v: false });
    expect(plotNums(await run('plot(timeframe.isticks ? 1 : 0)'))).toEqual([0, 0, 0]);
  });

  it('change(tf) is true on the first bar of that timeframe', async () => {
    // The fixture's bars are one minute apart (mkBars default step).
    // All three sit inside the same 5-minute period, but bar 0 opens it.
    expect(plotNums(await run('plot(timeframe.change("5") ? 1 : 0)', '1'))).toEqual([1, 0, 0]);
    // Every 1-minute bar opens its own minute.
    expect(plotNums(await run('plot(timeframe.change("1") ? 1 : 0)', '1'))).toEqual([1, 1, 1]);
    // Calendar unit on intraday bars: nothing after bar 0 starts a new day.
    expect(plotNums(await run('plot(timeframe.change("1D") ? 1 : 0)', '1'))).toEqual([1, 0, 0]);
  });
});

describe('array and drawing copies', () => {
  it('array.copy is an independent container (reference example)', async () => {
    const r = await run(`a = array.from(1, 2, 3)
b = array.copy(a)
array.set(a, 0, 9)
plot(array.get(b, 0))`);
    expect(plotNums(r)).toEqual([1, 1, 1]);
  });

  it('array.new_linefill / array.new_table build id arrays like the other new_* forms', async () => {
    expect(plotNums(await run('plot(array.size(array.new_linefill(3, na)))'))).toEqual([3, 3, 3]);
    expect(plotNums(await run('plot(array.size(array.new_table(2, na)))'))).toEqual([2, 2, 2]);
  });

  it('label/box/line.copy clone a live object that does not follow the source', async () => {
    const r = await run(`l = label.new(bar_index, close, "a")
label.copy(l)
label.set_text(l, "changed")
b = box.new(bar_index, close, bar_index + 1, close + 1)
box.copy(b)
box.set_lefttop(b, 99, 99)
ln = line.new(bar_index, close, bar_index + 2, close + 1)
line.copy(ln)
line.set_xy1(ln, 99, 99)
plot(na)`);
    // One source + one copy per bar, and the source is the one that changed.
    const labels = ofKind(r, 'label');
    expect(labels).toHaveLength(6);
    expect(labels.filter(d => d.props.text === 'changed')).toHaveLength(3);
    expect(labels.filter(d => d.props.text === 'a')).toHaveLength(3);
    const boxes = ofKind(r, 'box');
    expect(boxes).toHaveLength(6);
    expect(boxes.filter(d => d.props.left === 99)).toHaveLength(3);
    const lines = ofKind(r, 'line');
    expect(lines).toHaveLength(6);
    expect(lines.filter(d => d.props.x1 === 99)).toHaveLength(3);
  });

  it('label.style_text_outline is a label style constant', () => {
    expect(getConstant('label.style_text_outline'))
      .toEqual({ kind: 'string', v: 'label.style_text_outline' });
  });
});
