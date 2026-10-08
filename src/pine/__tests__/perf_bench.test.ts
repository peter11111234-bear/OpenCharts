// Perf bench for MTF evalAt caching — Task 1 of
// docs/superpowers/plans/2026-10-08-mtf-eval-cache-perf.md.
// Asserts __mtfStats counters are deterministic across identical runs; the
// scratch/perf-probe.mjs + scratch/perf-baseline.json pair carries the
// wall-time number. Task 2/3 should shrink evals while these stay stable.

import { describe, expect, it } from 'vitest';
import '../builtins/index'; // registers mtf
import { __mtfStats } from '../mtf';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { mkBars } from './golden';
import type { BarData } from '../contracts';

const SRC = [
  '//@version=6',
  'indicator("perf bench")',
  'e = request.security(syminfo.tickerid, "60", ta.ema(close, 20))',
  'c = request.security(syminfo.tickerid, "60", close)',
  'plot(e)',
  'plot(c)',
].join('\n');

const CHART_BARS = mkBars(6000, 0, 300_000); // 6k 5m bars
const BASE_1M = mkBars(30_000, 0, 60_000);

/** Resample base 1m bars into `tf` (golden.ts resampleTf collapses unit-less
 *  tfs to one bar — `(m[2] ?? 'm')` is '' not 'm' — so the bench keeps its own
 *  correct copy instead of depending on that quirk). */
function resampleTf(bars: BarData[], tf: string): BarData[] {
  const m = /^(\d+)([smhdw]?)$/i.exec(tf.trim())!;
  const unit = (m[2] || 'm').toLowerCase();
  const sec = Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 } as Record<string, number>)[unit]!;
  if (sec <= 60) return bars;
  const buckets = new Map<number, BarData>();
  for (const b of bars) {
    const key = b.openTime - (b.openTime % (sec * 1000));
    const cur = buckets.get(key);
    if (!cur) buckets.set(key, { ...b, openTime: key });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

async function runOnce(): Promise<{ evals: number; hits: number }> {
  const e0 = __mtfStats.evals, h0 = __mtfStats.hits;
  const res = await runScript(parse(SRC), CHART_BARS, {
    symbol: 'TEST',
    timeframe: '5',
    fetchSeries: (_s: string, tf: string) => Promise.resolve(resampleTf(BASE_1M, tf)),
  });
  expect(res.warnings).toEqual([]);
  return { evals: __mtfStats.evals - e0, hits: __mtfStats.hits - h0 };
}

describe('MTF evalAt perf bench', () => {
  it('produces identical eval/hit counts on a re-run (deterministic)', async () => {
    const a = await runOnce();
    const b = await runOnce();
    expect(a.evals).toBeGreaterThan(0);
    expect(b.evals).toBe(a.evals);
    expect(b.hits).toBe(a.hits);
  }, 120_000);
});

/** Deterministic bars with exact closes (golden.mkBars has no closeFn). */
function mkFlat(n: number, stepMs: number, closeFn: (i: number) => number): BarData[] {
  const bars: BarData[] = [];
  for (let i = 0; i < n; i++) {
    const c = closeFn(i);
    bars.push({ openTime: i * stepMs, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 100 + i });
  }
  return bars;
}

// ── Task 2: caller-agnostic cache ───────────────────────────────────────────
// `f() => security(...)` calls security() from a fresh UDF scope every chart
// bar — the seenCallers transient path would wipe nodeCache each bar, so any
// cross-bar reuse must come from the agnostic cache.

const UDF_SRC = [
  '//@version=6',
  'indicator("perf bench agnostic")',
  'f() => request.security(syminfo.tickerid, "60", ta.ema(close, 20))',
  'e = f()',
  'c = request.security(syminfo.tickerid, "60", close)',
  'plot(e, "e")',
  'plot(c, "c")',
].join('\n');

const PARAM_SRC = [
  '//@version=6',
  'indicator("perf bench param")',
  'f(p) => request.security(syminfo.tickerid, "60", p)',
  'a = f(close)',
  'a2 = f(open)',
  'b = f(close)',
  'plot(a, "a")',
  'plot(a2, "a2")',
  'plot(b, "b")',
].join('\n');

const ARR_SRC = [
  '//@version=6',
  'indicator("perf bench arr")',
  'mk() => [close, open]',
  '[x, y] = request.security(syminfo.tickerid, "60", mk())',
  'plot(x, "x")',
].join('\n');

// Dynamic tf: chart is 15m; bar_index>4 switches "60"→"15" mid-run. The "15"
// key is prefetched via the static spec on line `b`.
const DYN_SRC = [
  '//@version=6',
  'indicator("perf bench dyn")',
  'tf = bar_index > 4 ? "15" : "60"',
  'a = request.security(syminfo.tickerid, tf, close)',
  'b = request.security(syminfo.tickerid, "15", close)',
  'plot(a, "a")',
].join('\n');

async function runSrc(src: string, chartBars: BarData[] = CHART_BARS) {
  const s0 = { ...__mtfStats };
  const res = await runScript(parse(src), chartBars, {
    symbol: 'TEST',
    timeframe: '5',
    fetchSeries: (_s: string, tf: string) => Promise.resolve(resampleTf(BASE_1M, tf)),
  });
  const d = {
    evals: __mtfStats.evals - s0.evals,
    hits: __mtfStats.hits - s0.hits,
    agHits: __mtfStats.agHits - s0.agHits,
    gatePass: __mtfStats.gatePass - s0.gatePass,
    gateFail: __mtfStats.gateFail - s0.gateFail,
  };
  return { res, d };
}

describe('MTF caller-agnostic cache (Task 2)', () => {
  it('safe expr inside a per-bar UDF hits the agnostic cache (evals cut >50%)', async () => {
    const { res, d } = await runSrc(UDF_SRC);
    expect(res.warnings).toEqual([]);
    // Unsafe path would recompute every chart bar (~6000+ evals: transient
    // nodeCache wipe + O(j) warmup replay). Agnostic: ~2×tfBars.
    expect(d.evals).toBeLessThanOrEqual(1300);
    expect(d.agHits).toBeGreaterThan(4000);
    expect(d.gatePass).toBeGreaterThanOrEqual(2);
    expect(d.gateFail).toBe(0);
    // Same (node,j) ⇒ same value: all 12 chart bars inside tf bar0 read it.
    const vals = res.plots.get('e')!.values;
    expect(vals[5]).toEqual(vals[11]);        // same tf bar → same cached value
    expect(vals[5000]!.kind).not.toBe('na');  // ema(20) real once tf history fills
  }, 120_000);

  it('f(p) => security(..., p) stays per-caller (gate rejects param idents)', async () => {
    const { res, d } = await runSrc(PARAM_SRC);
    expect(res.warnings).toEqual([]);
    expect(d.gateFail).toBeGreaterThanOrEqual(1);
    // Transient caller + no agnostic cache → nodeCache wiped per bar →
    // recompute nearly every chart bar (~6k evals vs ~1k agnostic).
    expect(d.evals).toBeGreaterThan(5000);
    // Rejected expr must still serve the PASSED series: f(close) at two
    // callsites agrees bar-for-bar; f(open) differs by exactly the
    // open-vs-close delta — a wrongly-shared/stale cache can't satisfy both.
    const a = res.plots.get('a')!.values, a2 = res.plots.get('a2')!.values;
    const b = res.plots.get('b')!.values;
    expect(a.map(v => 'v' in v ? v.v : 'na')).toEqual(b.map(v => 'v' in v ? v.v : 'na'));
    const diffs = a.map((v, i) => ('v' in v && 'v' in a2[i]!) ? (v.v as number) - (a2[i]!.v as number) : null);
    // f(open) must serve the chart open at bar i — expected delta is the
    // chart's own close−open (0.4 + cos(i/15)*0.3 from golden.mkBars).
    expect(diffs.every((d, i) =>
      d === null || Math.abs(d - (CHART_BARS[i]!.close - CHART_BARS[i]!.open)) < 1e-9)).toBe(true);
  }, 120_000);


  it('array-valued expr skips the agnostic cache but still caches per-caller', async () => {
    const { res, d } = await runSrc(ARR_SRC);
    expect(res.warnings).toEqual([]);
    expect(d.gatePass).toBeGreaterThanOrEqual(1); // gate accepts mk() — the
    // mutable-kind guard (not the gate) is what skips the SHARED write.
    // The per-caller (node, caller, j) entry is still written/read, so the
    // expr computes ~once per tf bar instead of once per chart bar.
    expect(d.agHits).toBe(0);
    expect(d.hits).toBeGreaterThan(4000);  // per-caller hits across chart bars
    expect(d.evals).toBeLessThanOrEqual(1500); // ~tfBars, not ~chartBars
    // x is the tf close element of [close, open]: real once tf history
    // fills, constant within each 12-bar tf window.
    const x = res.plots.get('x')!.values;
    expect(x[2000]!.kind).not.toBe('na');
    expect(x[104]).toEqual(x[100]);
  }, 120_000);

  it('dynamic tf switch clears agnosticCache → values recomputed', async () => {
    // 10 × 15m chart bars (2.5h); tf = "60" on bars 0-4, "15" after. tf15
    // closes are distinct (i*10) so a stale post-switch read can't pass.
    const chart = mkFlat(10, 900_000, i => 50 + i);
    const tf60 = mkFlat(3, 3_600_000, i => 1000 + i);
    const tf15 = mkFlat(10, 900_000, i => i * 10);
    const res = await runScript(parse(DYN_SRC), chart, {
      symbol: 'TEST',
      timeframe: '15',
      fetchSeries: (_s: string, tf: string) =>
        Promise.resolve(tf === '15' ? tf15 : tf60),
    });
    expect(res.warnings).toEqual([]);
    const vals = res.plots.get('a')!.values.map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : NaN));
    expect(vals[3]).toBeNaN();   // 60m bar0 still open (na)
    expect(vals[4]).toBe(1000);
    expect(vals[5]).toBe(40);    // tf switch → recomputed on 15m bars (j=4)
    expect(vals[6]).toBe(50);
  }, 120_000);
});
