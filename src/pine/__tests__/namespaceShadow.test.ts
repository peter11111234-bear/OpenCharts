import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import { mkBars } from './golden';

// Pine keeps builtin namespaces and user functions apart from variables: a
// script may name a variable `size` or `array`, or reuse a function's name for
// a variable, and still call size.tiny / array.get(array, 0) / the function.
// TV compiles all three (DIY Custom Strategy Builder relies on each).

async function run(src: string) {
  const r = await runScript(parse(src), mkBars(5), { symbol: 'X', timeframe: '1' } as never);
  const last = [...r.plots.values()].map((p) => {
    const v = p.values[p.values.length - 1]!;
    return v.kind === 'int' || v.kind === 'float' ? v.v : v.kind === 'string' ? v.v : null;
  });
  return { last, warnings: r.warnings };
}

describe('variables do not hide builtin namespaces or functions', () => {
  it('a variable named size leaves size.tiny a constant', async () => {
    const { last, warnings } = await run([
      'indicator("t")',
      'size = 3',
      'plot(size, "n")',
      'plot(size.tiny == size.small ? 1 : 2, "k")',
    ].join('\n'));
    expect(warnings).toEqual([]);
    expect(last).toEqual([3, 2]);
  });

  it('array.get(array, i) with a parameter named array calls the builtin', async () => {
    const { last, warnings } = await run([
      'indicator("t")',
      'second(array) => array.get(array, 1)',
      'push2(array, v) =>',
      '    array.unshift(array, v)',
      '    array.size(array)',
      'a = array.from(7.0, 8.0)',
      'plot(second(a), "g")',
      'b = array.from(1.0)',
      'plot(push2(b, 5.0), "n")',
      'plot(array.get(b, 0) - 1, "h")',
    ].join('\n'));
    expect(warnings).toEqual([]);
    expect(last).toEqual([8, 2, 4]);
  });

  it('a UDT variable named like a namespace keeps its own method', async () => {
    const { last, warnings } = await run([
      'indicator("t")',
      'type B',
      '    float v = 1',
      'method set_left(B self, B other, float x) =>',
      '    self.v := x + other.v',
      '    self.v',
      'box = B.new()',
      'box.set_left(box, 5)',
      'plot(box.v, "v")',
    ].join('\n'));
    expect(warnings).toEqual([]);
    expect(last).toEqual([6]);
  });

  it('a variable reusing a function name does not hide the function', async () => {
    const { last, warnings } = await run([
      'indicator("t")',
      'ma(x) => x * 2',
      'ma = 1.0',
      'plot(ma, "v")',
      'plot(ma(3), "f")',
    ].join('\n'));
    expect(warnings).toEqual([]);
    expect(last).toEqual([1, 6]);
  });
});
