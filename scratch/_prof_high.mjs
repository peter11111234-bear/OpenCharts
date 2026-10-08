// Standalone CPU-profile target — runs 見高K4.55 + 高量1.46 through the
// interpreter directly (no vitest), so --cpu-prof captures the real work.
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
const repo = 'C:/Users/bear9/OpenCharts';
const { parse } = await import(pathToFileURL(repo + '/src/pine/parser.ts'));
const { runScript } = await import(pathToFileURL(repo + '/src/pine/interpreter.ts'));
await import(pathToFileURL(repo + '/src/pine/builtins/index.ts'));
await import(pathToFileURL(repo + '/src/pine/mtf.ts'));
if (process.env.PINE_COMPILED === '1') globalThis.__pineCompiled = true;

function mkBars(n, startMs = 0, stepMs = 60_000) {
  const bars = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 20) * 2 + ((i * 7919) % 100 - 50) * 0.02;
    const open = p;
    bars.push({
      openTime: startMs + i * stepMs, open,
      high: open + 1.5 + (i % 3) * 0.2,
      low: open - 1.5 - (i % 2) * 0.2,
      close: open + 0.4 + Math.cos(i / 15) * 0.3,
      volume: 1000 + i * 7 + (i % 11) * 13,
    });
  }
  return bars;
}
function resampleTf(bars, tf) {
  const m = /^(\d+)([smhdw]?)$/i.exec(tf.trim());
  const sec = m ? Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[(m[2] ?? 'm').toLowerCase()]) : 60;
  if (sec <= 60) return bars;
  const buckets = new Map();
  for (const b of bars) {
    const key = b.openTime - (b.openTime % (sec * 1000));
    const cur = buckets.get(key);
    if (!cur) buckets.set(key, { ...b, openTime: key });
    else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close; cur.volume += b.volume;
      cur.closeTime = b.closeTime ?? b.openTime;
    }
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

const CASES = [
  { name: '見高K4.55', file: 'C:/Users/bear9/high452/HIGH455/見高K4.54/見高K4.55.TXT', tf: '15', n: 500, step: 900_000 },
  { name: '高量1.46', file: 'C:/Users/bear9/high452/高量1.46/高量1.46_backup.TXT', tf: 'D', n: 500, step: 60_000 },
];
const BASE_1M = mkBars(3000, 0, 60_000);
for (const c of CASES) {
  const bars = mkBars(c.n, 0, c.step);
  const src = readFileSync(c.file, 'utf8').replace(/^﻿/, '');
  const parsed = parse(src);
  const t0 = Date.now();
  const r = await runScript(parsed, bars, {
    symbol: '2330', timeframe: c.tf,
    fetchSeries: async (s, t) => resampleTf(BASE_1M, t),
  });
  console.log(c.name, Date.now() - t0 + 'ms', 'plots=' + r.plots.size, 'warn=' + r.warnings.length);
}
