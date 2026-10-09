// B1 perf probe — heavy windowed ta.* inside tf security exprs.
// Before: *Win re-scans L bars per evalAt step → O(tfBars·L).
// After:  winAgg slides the window → O(tfBars).
// Run: npx tsx scratch/_b1_win_probe.mjs

import '../src/pine/builtins/index.ts';
import { __mtfStats } from '../src/pine/mtf.ts';
import { parse } from '../src/pine/parser.ts';
import { runScript } from '../src/pine/interpreter.ts';

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

const CHART_TF_MS = 300_000; // 5m
const chartBars = mkBars(6000, CHART_TF_MS);
const base1m = mkBars(30_000, 60_000);
const fetchSeries = async (_sym, tf) => resampleTf(base1m, tf);

// tf "15" → 2000 tf bars; L=400 × 6 exprs (hma = 3 wma windows) → old path
// ≈ 2000×400×8 vs.get calls per security spec, new path O(tfBars) slides.
const SRC = [
  '//@version=6',
  'indicator("b1 win probe")',
  'a = request.security(syminfo.tickerid, "15", ta.sma(close, 400))',
  'w = request.security(syminfo.tickerid, "15", ta.wma(close, 400))',
  'h = request.security(syminfo.tickerid, "15", ta.highest(high, 400))',
  'l = request.security(syminfo.tickerid, "15", ta.lowest(low, 400))',
  's = request.security(syminfo.tickerid, "15", ta.stdev(close, 400))',
  'm = request.security(syminfo.tickerid, "15", ta.hma(close, 400))',
  'plot(a)', 'plot(w)', 'plot(h)', 'plot(l)', 'plot(s)', 'plot(m)',
].join('\n');

const t0 = performance.now();
const res = await runScript(parse(SRC), chartBars, {
  symbol: 'TEST',
  timeframe: '5',
  fetchSeries,
});
const wallMs = Math.round(performance.now() - t0);

console.log(JSON.stringify({
  wallMs,
  evals: __mtfStats.evals,
  hits: __mtfStats.hits,
  warnings: res.warnings.length,
}));
