import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import { mkBars } from './golden';

// A deleted drawing stays in the script's arrays. TV's getters then return na
// and setters/copy do nothing. DIY Custom Strategy Builder's supply/demand
// break check (`if close >= box.get_top(zone)` → box.copy → box.delete(zone))
// relies on it: here the stale top kept matching, a copy was made every bar,
// and the 50-box budget pushed every real zone off the chart.
async function run(src: string) {
  const r = await runScript(parse(src), mkBars(8), { symbol: 'X', timeframe: '1' } as never);
  const last = [...r.plots.values()].map((p) => {
    const v = p.values[p.values.length - 1]!;
    return v.kind === 'int' || v.kind === 'float' ? v.v : null;
  });
  return { last, boxes: r.drawings.filter((d) => d.kind === 'box').length, warnings: r.warnings };
}

describe('a deleted drawing', () => {
  it('reads na, ignores setters, and copies to na', async () => {
    const { last, boxes, warnings } = await run([
      'indicator("t")',
      'var b = box.new(0, 1000000, 1, 0)',
      'var int copies = 0',
      'if bar_index == 1',
      '    box.delete(b)',
      'if bar_index >= 1',
      '    box.set_top(b, 5)',
      '    if close >= box.get_bottom(b)',
      '        box.copy(b)',
      '        copies += 1',
      'var int copyNa = 0',
      'if bar_index >= 1',
      '    copyNa := na(box.copy(b)) ? 1 : 0',
      'plot(copies, "copies")',
      'plot(na(box.get_top(b)) ? 1 : 0, "na")',
      'plot(copyNa, "copyNa")',
    ].join('\n'));
    expect(warnings).toEqual([]);
    expect(last).toEqual([0, 1, 1]);
    expect(boxes).toBe(0);
  });

  it('a drawing evicted by max_boxes_count reads na and does not copy', async () => {
    const { last, boxes, warnings } = await run([
      'indicator("t", max_boxes_count = 2)',
      'var first = box.new(0, 7, 1, 0)',
      'if bar_index >= 1 and bar_index <= 2',
      '    box.new(bar_index, 7, bar_index + 1, 0)',
      'var int copies = 0',
      'if bar_index >= 3 and not na(box.copy(first))',
      '    copies += 1',
      'plot(copies, "copies")',
      'plot(na(box.get_top(first)) ? 1 : 0, "na")',
    ].join('\n'));
    expect(warnings).toEqual([]);
    expect(last).toEqual([0, 1]);
    expect(boxes).toBe(2);
  });

  it('a live drawing is untouched', async () => {
    const { last, boxes } = await run([
      'indicator("t")',
      'var b = box.new(0, 10, 1, 5)',
      'box.set_top(b, 12)',
      'plot(box.get_top(b), "top")',
    ].join('\n'));
    expect(last).toEqual([12]);
    expect(boxes).toBe(1);
  });
});
