// MTF eval baseline probe — Task 1 of docs/superpowers/plans/2026-10-08-mtf-eval-cache-perf.md
//
// Run:  npx tsx scratch/perf-probe.mjs | tee scratch/perf-baseline.json
//       (vite-node also works; plain `node --experimental-strip-types` does NOT —
//        builtins/index.ts uses extensionless imports + parameter properties)
//
// Output: { evals, hits, setAtCalls, ensureBarCalls, wallMs, chartBars, tfBars }

// Must import builtins FIRST (registers mtf via interpreter's registerMtf hook).
import '../src/pine/builtins/index.ts';
import { BarSeries } from '../src/pine/series.ts';
import { __mtfStats } from '../src/pine/mtf.ts';
import { parse } from '../src/pine/parser.ts';
import { runScript } from '../src/pine/interpreter.ts';

// ── patch BarSeries write paths AFTER mtf is loaded ─────────────────────────
const counts = { setAt: 0, ensureBar: 0 };
const o1 = BarSeries.prototype.setAt;
BarSeries.prototype.setAt = function (...a) { counts.setAt++; return o1.apply(this, a); };
const o2 = BarSeries.prototype.ensureBar;
BarSeries.prototype.ensureBar = function (...a) { counts.ensureBar++; return o2.apply(this, a); };

// ── deterministic fake bars (same generator shape as __tests__/golden.ts) ────
function mkBars(n, stepMs, startMs = 0) {
  const bars = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 20) * 2 + ((i * 7919) % 100 - 50) * 0.02;
    bars.push({
      openTime: startMs + i * stepMs,
      open: p,
      high: p + 1.5 + (i % 3) * 0.2,
      low: p - 1.5 - (i % 2) * 0.2,
      close: p + 0.4 + Math.cos(i / 15) * 0.3,
      volume: 1000 + i * 7 + (i % 11) * 13,
    });
  }
  return bars;
}

/** Resample base bars to `tf` (bucket = floor to tf boundary, like golden.ts). */
function resampleTf(bars, tf) {
  const m = /^(\d+)([smhdw]?)$/i.exec(tf.trim());
  const sec = Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[(m[2] || 'm').toLowerCase()]);
  if (sec <= 60) return bars;
  const buckets = new Map();
  for (const b of bars) {
    const key = b.openTime - (b.openTime % (sec * 1000));
    const cur = buckets.get(key);
    if (!cur) buckets.set(key, { ...b, openTime: key });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

// ── synthetic workload: 5m chart (6k bars), 2 security calls, ta.ema in expr ─
const CHART_TF_MS = 300_000; // 5m
const chartBars = mkBars(6000, CHART_TF_MS);
const base1m = mkBars(30_000, 60_000); // covers the whole chart span
const fetchSeries = async (_sym, tf) => resampleTf(base1m, tf);

const SRC = [
  '//@version=6',
  'indicator("perf probe")',
  'e = request.security(syminfo.tickerid, "60", ta.ema(close, 20))',
  'c = request.security(syminfo.tickerid, "60", close)',
  'plot(e)',
  'plot(c)',
].join('\n');

const t0 = performance.now();
const res = await runScript(parse(SRC), chartBars, {
  symbol: 'TEST',
  timeframe: '5',
  fetchSeries,
});
const wallMs = Math.round(performance.now() - t0);

const tfBars60 = resampleTf(base1m, '60').length;
const out = {
  evals: __mtfStats.evals,
  hits: __mtfStats.hits,
  gatePass: __mtfStats.gatePass,
  gateFail: __mtfStats.gateFail,
  agHits: __mtfStats.agHits,
  setAtCalls: counts.setAt,
  ensureBarCalls: counts.ensureBar,
  wallMs,
  chartBars: chartBars.length,
  tfBars: tfBars60,
  warnings: res.warnings.length,
};
console.log(JSON.stringify(out, null, 2));
