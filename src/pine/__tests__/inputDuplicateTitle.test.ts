import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { collectInputs } from '../scriptDecl';
import '../builtins';
import { mkBars } from './golden';

// TV tells inputs apart by position, not by title: two `input.string(..., "Type")`
// are two settings. Sharing one id made the panel list only the first, and an
// override for it leaked into the second — a MA "Type" set to EMA reached
// ta.pivot_point_levels as its pivot type ("invalid argument 'EMA'").
const SRC = [
  'indicator("t")',
  'maType = input.string("SMA", "Type", options=["SMA", "EMA"])',
  'pivType = input.string("Traditional", "Type", options=["Traditional", "Fibonacci"])',
  'plot(maType == "EMA" ? 1 : 0, "ma")',
  // 0 = its own default, 1 = set to Fibonacci, -1 = leaked from the MA input.
  'plot(pivType == "Traditional" ? 0 : pivType == "Fibonacci" ? 1 : -1, "piv")',
].join('\n');

// request.security with a dynamic tf: mtf prefetch evaluates tf2 before bar 0,
// so the run reaches the second "Timeframe" before the first.
const PREFETCH = [
  'indicator("t")',
  'tf1 = input.timeframe("60", "Timeframe")',
  'tf2 = input.timeframe("D", "Timeframe")',
  'x = request.security(syminfo.tickerid, tf2, close)',
  'plot(tf1 == "60" ? 1 : tf1 == "120" ? 2 : 9, "tf1")',
  'plot(tf2 == "D" ? 1 : tf2 == "W" ? 2 : 9, "tf2")',
].join('\n');

// CJK titles slug to '' — the 2nd of each must still get its own id.
const CJK = [
  'indicator("t")',
  'a1 = input.int(1, "週期")',
  'a2 = input.int(2, "週期")',
  'b1 = input.int(10, "長度")',
  'b2 = input.int(20, "長度")',
  'plot(a2, "a2")',
  'plot(b2, "b2")',
].join('\n');

// The 2nd "Length" must not take `length_2`, which "Length 2" slugs to.
const SLUG_CLASH = [
  'indicator("t")',
  'l1 = input.int(1, "Length")',
  'l2 = input.int(2, "Length")',
  'l3 = input.int(3, "Length 2")',
  'plot(l2, "l2")',
  'plot(l3, "l3")',
].join('\n');

// Only the taken branch runs; the id must not depend on which one that is.
const TERNARY = [
  'indicator("t")',
  'useA = input.bool(false, "Use A")',
  'v = useA ? input.int(1, "Len") : input.int(2, "Len")',
  'plot(v, "v")',
].join('\n');

async function run(src: string, inputValues: Record<string, unknown>) {
  const bars = mkBars(5);
  const r = await runScript(parse(src), bars, {
    symbol: 'X', timeframe: '1', fetchSeries: async () => bars, inputValues,
  } as never);
  // Plots in declaration order.
  const last = [...r.plots.values()].map((p) => {
    const v = p.values[p.values.length - 1]!;
    return v.kind === 'int' || v.kind === 'float' ? v.v : null;
  });
  return { last, ids: r.inputs.map((s: { id: string }) => s.id) };
}

const staticIds = (src: string) => collectInputs(parse(src) as never).map((s) => s.id);

describe('inputs that share a title', () => {
  it('get one schema each, with distinct ids', async () => {
    expect((await run(SRC, {})).ids).toEqual(['type', 'type_2']);
  });

  it('an override for the first does not reach the second', async () => {
    for (const key of ['type', 'Type']) {
      expect((await run(SRC, { [key]: 'EMA' })).last).toEqual([1, 0]);
    }
  });

  it('the second is set through its own id', async () => {
    expect((await run(SRC, { type_2: 'Fibonacci' })).last).toEqual([0, 1]);
  });

  it('the prepare-time schema lists both, with the ids the run reads', () => {
    const ids = staticIds(SRC);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe('type_2');
  });

  it('are numbered in source order even when prefetch reaches the second first', async () => {
    expect((await run(PREFETCH, { Timeframe: '120' })).last).toEqual([2, 1]);
    expect((await run(PREFETCH, { timeframe_2: 'W' })).last).toEqual([1, 2]);
  });

  it('CJK titles get distinct ids per title', async () => {
    expect(staticIds(CJK)).toEqual(['週期', '週期_2', '長度', '長度_2']);
    expect((await run(CJK, { 週期_2: 5 })).last).toEqual([5, 20]);
  });

  it('a generated id skips one a real title already uses', async () => {
    expect(staticIds(SLUG_CLASH)).toEqual(['Length', 'length_3', 'Length 2']);
    expect((await run(SLUG_CLASH, { length_3: 7 })).last).toEqual([7, 3]);
  });

  it('keep their id whichever ternary branch runs', async () => {
    expect((await run(TERNARY, { 'Use A': false, len_2: 5 })).last).toEqual([5]);
    expect((await run(TERNARY, { 'Use A': true, Len: 9 })).last).toEqual([9]);
  });

  // Save-then-reload: the panel saves every input at its prepare-time default.
  // Feeding that dict back must change nothing.
  it('a run with the prepare-time defaults matches a run with none', async () => {
    for (const src of [SRC, PREFETCH, CJK, SLUG_CLASH, TERNARY]) {
      const defaults = Object.fromEntries(
        collectInputs(parse(src) as never).map((s) => [s.id, s.defval]),
      );
      expect((await run(src, defaults)).last, src).toEqual((await run(src, {})).last);
    }
  });
});
