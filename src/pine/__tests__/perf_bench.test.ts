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
