import '../src/pine/builtins/index.ts';
import { __mtfStats } from '../src/pine/mtf.ts';
import { parse } from '../src/pine/parser.ts';
import { runScript } from '../src/pine/interpreter.ts';
import { readFileSync } from 'node:fs';

function mkBars(n, stepMs) {
  const bars = []; let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 20) * 2;
    bars.push({ openTime: i * stepMs, open: p, high: p + 1.5, low: p - 1.5,
      close: p + 0.4, volume: 1000 + i * 7 });
  }
  return bars;
}
function resampleTf(bars, tf) {
  const m = /^(\d*)([smhdw]?)$/i.exec(tf.trim());
  if (!m || !m[1]) return bars; // 'M'/'W'-bare or unparseable → use raw bars
  const unit = (m[2] || 'm').toLowerCase();
  const sec = Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit]);
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

const src = readFileSync('src/pine/TRIS390.pine', 'utf8');
const base1m = mkBars(40 * 1440, 60_000); // 40 days of 1m for M/W/D/H tf resample
const chart = mkBars(30, 300_000);
const t0 = performance.now();
const res = await runScript(parse(src), chart, {
  symbol: 'TEST', timeframe: '5',
  fetchSeries: (_s, tf) => Promise.resolve(resampleTf(base1m, tf)),
});
console.log(JSON.stringify({
  gatePass: __mtfStats.gatePass, gateFail: __mtfStats.gateFail,
  evals: __mtfStats.evals, hits: __mtfStats.hits, agHits: __mtfStats.agHits,
  warnings: res.warnings.slice(0, 8), wallMs: Math.round(performance.now() - t0),
}, null, 2));
