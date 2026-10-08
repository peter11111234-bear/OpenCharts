// Kind-coverage audit: run the real 見高K4.55 body through the compiled path
// and report the disposition of every top-level stmt kind (direct/twoPhase/
// fallback) as recorded by __compiledKinds.
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
const repo = 'C:/Users/bear9/OpenCharts';
const { parse } = await import(pathToFileURL(repo + '/src/pine/parser.ts'));
const { runScript, __compiledKinds } = await import(pathToFileURL(repo + '/src/pine/interpreter.ts'));
await import(pathToFileURL(repo + '/src/pine/builtins/index.ts'));
await import(pathToFileURL(repo + '/src/pine/mtf.ts'));

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
      cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low);
      cur.close = b.close; cur.volume += b.volume;
      cur.closeTime = b.closeTime ?? b.openTime;
    }
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

globalThis.__pineCompiled = true;
const src = readFileSync('C:/Users/bear9/high452/HIGH455/見高K4.54/見高K4.55.TXT', 'utf8').replace(/^/, '');
const parsed = parse(src);
const bars = mkBars(500, 0, 900_000);
await runScript(parsed, bars, {
  symbol: '2330', timeframe: '15',
  fetchSeries: async (s, t) => resampleTf(mkBars(3000), t),
});

// __compiledKinds records stmt.type → disposition for every compile() call.
// Top-level audit: count each body stmt's disposition; a type absent from the
// map means no node of that type was ever compiled (default → fallback).
const counts = { direct: 0, twoPhase: 0, fallback: 0, unknown: 0 };
const byKind = new Map();
const keyOf = (s) => s.type === 'var' && s.multi && s.multi.length > 0 ? 'var[multi]' : s.type;
for (const s of parsed.body) {
  const key = keyOf(s);
  const kind = __compiledKinds.get(key) ?? 'fallback';
  counts[kind === 'twoPhase' ? 'twoPhase' : kind]++;
  byKind.set(key, kind);
}
const pct = ((counts.direct + counts.twoPhase) / parsed.body.length * 100).toFixed(1);
console.log(`top-level stmts=${parsed.body.length} direct=${counts.direct} twoPhase=${counts.twoPhase} fallback=${counts.fallback} compiledShare=${pct}%`);
console.log([...byKind.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
