import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
const repo = 'C:/Users/bear9/OpenCharts';
const { parse } = await import(pathToFileURL(repo + '/src/pine/parser.ts'));
const { runScript } = await import(pathToFileURL(repo + '/src/pine/interpreter.ts'));
await import(pathToFileURL(repo + '/src/pine/builtins/index.ts'));
await import(pathToFileURL(repo + '/src/pine/mtf.ts'));
if (process.env.PINE_COMPILED === '1') globalThis.__pineCompiled = true;
function mkBars(n, stepMs = 60_000) {
  const bars = []; let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 20) * 2 + ((i * 7919) % 100 - 50) * 0.02;
    const open = p;
    bars.push({ openTime: i * stepMs, open, high: open + 1.5, low: open - 1.5, close: open + 0.4, volume: 1000 + i * 7 });
  }
  return bars;
}
function resample(bars, tf) {
  const sec = Number.parseInt(tf) * 60;
  if (sec <= 60) return bars;
  const m = new Map();
  for (const b of bars) {
    const k = b.openTime - (b.openTime % (sec * 1000));
    const c = m.get(k);
    if (!c) m.set(k, { ...b, openTime: k });
    else { c.high = Math.max(c.high, b.high); c.low = Math.min(c.low, b.low); c.close = b.close; c.volume += b.volume; }
  }
  return [...m.values()];
}
const src = readFileSync('C:/Users/bear9/high452/HIGH455/見高K4.54/見高K4.55.TXT', 'utf8').replace(/^/, '');
const parsed = parse(src);
const chart = mkBars(500, 900_000); // 500 × 15m = 125h span
for (const n of [3000, 8000, 20000]) {
  const base = mkBars(n, 60_000);
  const t0 = Date.now();
  const r = await runScript(parsed, chart, { symbol: '2330', timeframe: '15', fetchSeries: async (s, t) => resample(base, t) });
  console.log(`1m-bars=${n}`, Date.now() - t0 + 'ms', 'warn=' + r.warnings.length);
}
