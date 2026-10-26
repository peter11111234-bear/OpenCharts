import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import { mkBars } from './golden';

// The matrix.* subset DIY Custom Strategy Builder's pivot history uses: a var
// matrix of rows, add_row(array_id=…), capped by remove_row(0), read back with
// rows()/columns()/row().
async function lasts(src: string) {
  const r = await runScript(parse(src), mkBars(5), { symbol: 'X', timeframe: '1' } as never);
  return {
    warnings: r.warnings,
    last: [...r.plots.values()].map((p) => {
      const v = p.values[p.values.length - 1]!;
      return v.kind === 'int' || v.kind === 'float' ? v.v : null;
    }),
  };
}

describe('matrix', () => {
  it('rows added and capped keep the newest, read back by row()', async () => {
    const { last, warnings } = await lasts([
      'indicator("t")',
      'var m = matrix.new<float>()',
      'if bar_index < 4',
      '    m.add_row(array_id = array.from(bar_index * 1.0, bar_index * 10.0))',
      'if m.rows() > 2',
      '    m.remove_row(0)',
      'plot(m.rows(), "rows")',
      'plot(m.columns(), "cols")',
      'plot(array.get(m.row(m.rows() - 1), 1), "lastv")',
      'plot(matrix.get(m, 0, 0), "first")',
    ].join('\n'));
    expect(warnings).toEqual([]);
    expect(last).toEqual([2, 2, 30, 2]);
  });

  it('new(rows, cols, init), set/get and remove_row returning the row', async () => {
    const { last, warnings } = await lasts([
      'indicator("t")',
      'm = matrix.new<int>(2, 3, 0)',
      'matrix.set(m, 1, 2, 7)',
      'gone = matrix.remove_row(m, 1)',
      'plot(m.rows(), "rows")',
      'plot(m.columns(), "cols")',
      'plot(array.get(gone, 2), "gone")',
      'plot(m.get(0, 2), "kept")',
    ].join('\n'));
    expect(warnings).toEqual([]);
    expect(last).toEqual([1, 3, 7, 0]);
  });
});
