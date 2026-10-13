// ── map.* stdlib-alignment additions ────────────────────────────────────────
// The 10 TV v6 names the engine did not answer: map.clear / contains / copy /
// get / keys / put / put_all / remove / size / values. Semantics per the
// official reference. The typed-key encoding is pinned too, because a key
// collision would be a wrong VALUE rather than a missing name.

import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { RunResult } from '../contracts';
import { BUILTINS } from '../builtins/registry';
import '../builtins/index';
import { mkBars } from './golden';

const BARS = mkBars(3);
const OPTS = { symbol: 'X', timeframe: 'D', fetchSeries: async () => [] } as const;

const run = (src: string): Promise<RunResult> =>
  runScript(parse(`indicator("t")\n${src}`), BARS, OPTS);

/** One plot sink as numbers — na reads back as null (that IS the assertion for
 *  a missing key). `plot` needs global scope, so scripts end in plot calls. */
const sink = (r: RunResult, name: string): (number | null)[] =>
  (r.plots.get(name)?.values ?? []).map((v) =>
    v.kind === 'int' || v.kind === 'float' ? v.v : null);

describe('map.* stdlib alignment', () => {
  it('registers every previously missing name', () => {
    for (const n of ['clear', 'contains', 'copy', 'get', 'keys', 'put', 'put_all', 'remove', 'size', 'values']) {
      expect(BUILTINS.has(`map.${n}`), `map.${n}`).toBe(true);
    }
  });

  it('round-trips string keys through new/put/get/size/contains', async () => {
    const r = await run(`m = map.new<string, float>()
map.put(m, "a", 1.5)
map.put(m, "b", 2)
plot(map.size(m), "size")
plot(map.contains(m, "a") ? 1 : 0, "has")
plot(map.contains(m, "zz") ? 1 : 0, "hasnot")
plot(map.get(m, "b") - map.get(m, "a"), "delta")
plot(map.get(m, "zz"), "absent")`);
    expect(sink(r, 'size')).toEqual([2, 2, 2]);
    expect(sink(r, 'has')).toEqual([1, 1, 1]);
    expect(sink(r, 'hasnot')).toEqual([0, 0, 0]);
    expect(sink(r, 'delta')).toEqual([0.5, 0.5, 0.5]);
    expect(sink(r, 'absent')).toEqual([null, null, null]);   // missing key → na
  });

  it('keys are typed: int 1 and string "1" are different keys', async () => {
    const r = await run(`m = map.new<string, float>()
map.put(m, 1, 10)
map.put(m, "1", 20)
plot(map.size(m), "size")
plot(map.get(m, 1) + map.get(m, "1"), "sum")
plot(array.get(map.keys(m), 0) == 1 ? 10 : 0, "k0int")
plot(array.get(map.keys(m), 1) == "1" ? 1 : 0, "k1str")`);
    expect(sink(r, 'size')).toEqual([2, 2, 2]);
    expect(sink(r, 'sum')).toEqual([30, 30, 30]);
    expect(sink(r, 'k0int')).toEqual([10, 10, 10]);   // keys() rebuilds the int
    expect(sink(r, 'k1str')).toEqual([1, 1, 1]);
  });

  it('put returns the stored value, remove returns the removed one', async () => {
    const r = await run(`m = map.new<string, float>()
plot(map.put(m, "k", 7), "put")
plot(map.remove(m, "k"), "removed")
plot(map.size(m), "size")
plot(map.remove(m, "gone"), "gone")`);
    expect(sink(r, 'put')).toEqual([7, 7, 7]);
    expect(sink(r, 'removed')).toEqual([7, 7, 7]);
    expect(sink(r, 'size')).toEqual([0, 0, 0]);
    expect(sink(r, 'gone')).toEqual([null, null, null]);   // absent key → na
  });

  it('keys/values follow insertion order; copy is independent; put_all merges', async () => {
    const r = await run(`m = map.new<string, float>()
map.put(m, "a", 1)
map.put(m, "b", 2)
c = map.copy(m)
map.put(m, "c", 3)
d = map.new<string, float>()
map.put_all(d, m)
plot(map.size(m), "msize")
plot(map.size(c), "csize")
plot(map.size(d), "dsize")
plot(array.size(map.values(m)), "vals")
plot(array.get(map.keys(c), 1) == "b" ? 1 : 0, "order")`);
    expect(sink(r, 'msize')).toEqual([3, 3, 3]);
    expect(sink(r, 'csize')).toEqual([2, 2, 2]);   // copy did not see "c"
    expect(sink(r, 'dsize')).toEqual([3, 3, 3]);
    expect(sink(r, 'vals')).toEqual([3, 3, 3]);
    expect(sink(r, 'order')).toEqual([1, 1, 1]);
  });

  it('clear empties the map in place', async () => {
    const r = await run(`m = map.new<string, float>()
map.put(m, "a", 1)
map.clear(m)
plot(map.size(m), "size")`);
    expect(sink(r, 'size')).toEqual([0, 0, 0]);
  });

  it('a method receiver works like the namespace call', async () => {
    const r = await run(`m = map.new<string, float>()
map.put(m, "a", 5)
plot(m.get("a"), "get")
plot(m.size(), "size")`);
    expect(sink(r, 'get')).toEqual([5, 5, 5]);
    expect(sink(r, 'size')).toEqual([1, 1, 1]);
  });

  it('rejects a non-primitive key instead of storing it silently', async () => {
    await expect(run(`m = map.new<float, float>()
map.put(m, array.new<float>(1), 1)`)).rejects
      .toThrow(/map key must be int, float, bool, string or color/);
  });
});
