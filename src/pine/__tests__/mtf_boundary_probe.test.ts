// ── MTF error/boundary probe (handoff round) ───────────────────────────────
// Eight cases over request.security edge paths: j<0 history guard, na
// propagation, dynamic-tf prefetch misses & deduped warnings, empty/short HTF
// feeds, gaps_on×lookahead_on, chart-before-HTF alignment. Every case is
// wrapped in try/catch; observed values dump via console.log for review.
// THROWAWAY probe — delete after review (kept out of golden baseline).

import { describe, expect, it } from 'vitest';
import type { BarData, Value } from '../contracts';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import '../mtf';

const M15 = 900_000, H1 = 3_600_000;

function mkBars(n: number, tfMs: number, start = 0, closeFn: (i: number) => number = i => i): BarData[] {
  const bars: BarData[] = [];
  for (let i = 0; i < n; i++) {
    const c = closeFn(i);
    bars.push({ openTime: start + i * tfMs, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 100 + i });
  }
  return bars;
}

/** Run a script; capture thrown exceptions instead of failing silently. */
async function run(src: string, bars: BarData[], opts: Parameters<typeof runScript>[2]) {
  try {
    const res = await runScript(parse(src), bars, opts);
    return { res, threw: null as string | null };
  } catch (e) {
    return { res: null, threw: e instanceof Error ? e.message : String(e) };
  }
}

/** Per-bar numeric values of a named plot (or the first plot), 'na' for non-nums. */
const plotVals = (r: { plots: Map<string, { values: Value[] }> } | null, name?: string) =>
  (name ? r?.plots.get(name)?.values : r ? [...r.plots.values()][0]?.values : [])
    ?.map(v => v.kind === 'int' || v.kind === 'float' ? v.v : 'na') ?? [];

describe('MTF error/boundary (probe)', () => {
  it('C1: j<0 guard — g[1] on the first completed HTF bar is na, not stale', async () => {
    const src = [
      'indicator("c1")',
      'g = close * 10',
      'h = request.security(syminfo.tickerid, "60", g[1])',
      'plot(h)',
    ].join('\n');
    const chart = mkBars(12, M15, 0);
    const htf = mkBars(3, H1, 0, i => 100 + i * 10);          // tf closes 100,110,120
    const { res, threw } = await run(src, chart, {
      timeframe: '15',
      fetchSeries: async (_s, t) => (t === '60' ? htf : []),
    });
    console.log('C1 threw:', threw, '| values:', plotVals(res ?? { plots: new Map() }));
    expect(threw).toBeNull();
    // completed tf index: -1 (bars0-3), 0 (4-7), 1 (8-11)
    expect(plotVals(res!)).toEqual(['na', 'na', 'na', 'na', 'na', 'na', 'na', 'na', 1000, 1000, 1000, 1000]);
  });

  it('C2: na propagation — g[9] beyond history is all na, no throw', async () => {
    const src = [
      'indicator("c2")',
      'g = close * 10',
      'h = request.security(syminfo.tickerid, "60", g[9])',
      'plot(h)',
    ].join('\n');
    const chart = mkBars(12, M15, 0);
    const htf = mkBars(3, H1, 0, i => 100 + i * 10);
    const { res, threw } = await run(src, chart, {
      timeframe: '15',
      fetchSeries: async (_s, t) => (t === '60' ? htf : []),
    });
    console.log('C2 threw:', threw, '| values:', plotVals(res ?? { plots: new Map() }));
    expect(threw).toBeNull();
    expect(plotVals(res!)).toEqual(Array(12).fill('na'));
  });

  it('C3: dynamic tf not prefetched — all na + bounded "not prefetched" warnings', async () => {
    // FINDING recorded in console: `timeframe.period` is NOT a miss — the
    // bar0 prefetch runConst resolves it to '15' and fetches it, so values
    // flow and zero warnings fire. The true never-prefetched path needs a tf
    // that either can't resolve at bar0 or resolves to an unfetched key.
    const src = [
      'indicator("c3")',
      'sel = bar_index < 25 ? "60" : "120"',
      'h = request.security(syminfo.tickerid, sel, close)',
      'plot(h)',
    ].join('\n');
    const chart = mkBars(30, M15, 0, i => i);
    const tf60 = mkBars(4, H1, 0, i => 100 + i);
    const { res, threw } = await run(src, chart, {
      timeframe: '15',
      fetchSeries: async (_s, t) => (t === '60' ? tf60 : []),
    });
    console.log('C3 threw:', threw, '| warnings:', res?.warnings, '| values:', plotVals(res));
    expect(threw).toBeNull();
    const hits = res!.warnings.filter(w => w.includes('not prefetched'));
    // bar0 prefetch resolves '60' and fetches it; the '120' leg (bars 25-29)
    // hits the same fetched-miss key → ONE deduped warning, na for those bars.
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain('"120"');
    const v = plotVals(res!);
    expect(v.slice(0, 4)).toEqual(Array(4).fill('na'));            // tf bar0 developing
    expect(v.slice(4, 8)).toEqual(Array(4).fill(100));             // completed tf bar0
    expect(v.slice(25)).toEqual(Array(5).fill('na'));              // unfetched '120' leg

    // Never-resolvable tf (str.tostring(close) — a new tf string per bar):
    // each unique message fires once (≤1 per message bound); chart closes
    // 0..29 → 29 unique tf strings → 29 warnings, all na.
    const { res: r2, threw: t2 } = await run(
      ['indicator("c3b")',
       'h = request.security(syminfo.tickerid, str.tostring(close), close)',
       'plot(h)'].join('\n'),
      chart, { timeframe: '15', fetchSeries: async () => [] });
    console.log('C3b threw:', t2, '| warnings:', r2?.warnings);
    expect(t2).toBeNull();
    expect(plotVals(r2)).toEqual(Array(30).fill('na'));
    const w2 = r2!.warnings.filter(w => w.includes('not prefetched'));
    expect(w2.length).toBe(29);                        // bars 1-29 each a new tf
    expect(new Set(w2).size).toBe(w2.length);           // ≤1 per unique message
    expect(w2[0]).toContain('"1"');

    // timeframe.period leg — observed: prefetch resolves + fetches (no miss).
    const { res: r3, threw: t3 } = await run(
      ['indicator("c3c")',
       'h = request.security(syminfo.tickerid, timeframe.period, close)',
       'plot(h)'].join('\n'),
      chart, { timeframe: '15', fetchSeries: async (_s, t) => (t === '15' ? chart : []) });
    console.log('C3c threw:', t3, '| warnings:', r3?.warnings);
    expect(t3).toBeNull();
    expect(r3!.warnings.filter(w => w.includes('not prefetched')).length).toBe(0);
  });

  it('C4: dynamic tf resolvable at bar0 (input.timeframe) — resolves, no warning', async () => {
    const src = [
      'indicator("c4")',
      'tf = input.timeframe("60", "HTF")',
      'h = request.security(syminfo.tickerid, tf, close)',
      'plot(h)',
    ].join('\n');
    const chart = mkBars(12, M15, 0);
    const htf = mkBars(3, H1, 0, i => 100 + i);
    const { res, threw } = await run(src, chart, {
      timeframe: '15',
      fetchSeries: async (_s, t) => (t === '60' ? htf : []),
    });
    console.log('C4 threw:', threw, '| warnings:', res?.warnings, '| values:', plotVals(res ?? { plots: new Map() }));
    expect(threw).toBeNull();
    expect(res!.warnings.filter(w => w.includes('security'))).toEqual([]);
    expect(plotVals(res!).slice(0, 4)).toEqual(Array(4).fill('na'));
    expect(plotVals(res!).slice(4, 8)).toEqual(Array(4).fill(100));
    expect(plotVals(res!).slice(8, 12)).toEqual(Array(4).fill(101));
  });

  it('C5: empty HTF fetch — all na, no throw', async () => {
    const src = [
      'indicator("c5")',
      'h = request.security(syminfo.tickerid, "60", close)',
      'plot(h)',
    ].join('\n');
    const chart = mkBars(12, M15, 0);
    const { res, threw } = await run(src, chart, {
      timeframe: '15',
      fetchSeries: async () => [],
    });
    console.log('C5 threw:', threw, '| warnings:', res?.warnings);
    expect(threw).toBeNull();
    expect(plotVals(res!)).toEqual(Array(12).fill('na'));
  });

  it('C6: HTF shorter than chart (2 tf bars, 30 chart bars) — values while covered, then carry/na', async () => {
    const src = [
      'indicator("c6")',
      'h = request.security(syminfo.tickerid, "60", close, barmerge.gaps_off, barmerge.lookahead_off)',
      'plot(h)',
    ].join('\n');
    const chart = mkBars(30, M15, 0);
    const htf = mkBars(2, H1, 0, i => 100 + i * 10);           // only 2 tf bars
    const { res, threw } = await run(src, chart, {
      timeframe: '15',
      fetchSeries: async (_s, t) => (t === '60' ? htf : []),
    });
    console.log('C6 threw:', threw, '| values:', plotVals(res ?? { plots: new Map() }));
    expect(threw).toBeNull();
    const v = plotVals(res!);
    expect(v.slice(0, 4)).toEqual(Array(4).fill('na'));
    expect(v.slice(4, 8)).toEqual(Array(4).fill(100));
    // Last tf bar never completes mid-run on real data; but nominal tfNext
    // end for the last bar: after 2*H1 it "completes" → bar 8+ carries 110.
    expect(v.slice(8)).toEqual(Array(22).fill(110));
  });

  it('C7: gaps_on + lookahead_on — first chart bar per DEVELOPING tf bar emits, rest na', async () => {
    const src = [
      'indicator("c7")',
      'h = request.security(syminfo.tickerid, "60", close, barmerge.gaps_on, barmerge.lookahead_on)',
      'plot(h)',
    ].join('\n');
    const chart = mkBars(12, M15, 0);
    const htf = mkBars(3, H1, 0, i => 100 + i * 10);
    const { res, threw } = await run(src, chart, {
      timeframe: '15',
      fetchSeries: async (_s, t) => (t === '60' ? htf : []),
    });
    console.log('C7 threw:', threw, '| values:', plotVals(res ?? { plots: new Map() }));
    expect(threw).toBeNull();
    // lookahead_on: chart bar i maps to the tf bar containing its END →
    // developing tf bar 0 emits on chart bar 0 only, then na until tf bar 1.
    expect(plotVals(res!)).toEqual([100, 'na', 'na', 'na', 110, 'na', 'na', 'na', 120, 'na', 'na', 'na']);
  });

  it('C8: chart starts before first HTF bar — na until first tf bar completes', async () => {
    const src = [
      'indicator("c8")',
      'h = request.security(syminfo.tickerid, "60", close)',
      'plot(h)',
    ].join('\n');
    // Chart opens at t=-2h; first HTF bar opens at t=0 → bars before t0+1h see nothing.
    const chart = mkBars(20, M15, -2 * H1);
    const htf = mkBars(4, H1, 0, i => 100 + i);                // tf opens at t=0
    const { res, threw } = await run(src, chart, {
      timeframe: '15',
      fetchSeries: async (_s, t) => (t === '60' ? htf : []),
    });
    console.log('C8 threw:', threw, '| values:', plotVals(res ?? { plots: new Map() }));
    expect(threw).toBeNull();
    const v = plotVals(res!);
    // bars 0-11 (openTime -2h..+45m): no completed tf bar → na
    expect(v.slice(0, 12)).toEqual(Array(12).fill('na'));
    // bar 12 opens at t=1h → tf bar0 completed → 100; bars 16+ → 101
    expect(v.slice(12, 16)).toEqual(Array(4).fill(100));
    expect(v.slice(16, 20)).toEqual(Array(4).fill(101));
  });
});
