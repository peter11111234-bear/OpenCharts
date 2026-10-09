// Round-2 bit-identity probe: interpreted vs compiled must produce identical
// RunResult snapshots (bindDeclared is shared, but slotFor/tuple/cow paths
// diverge between the two frontends).
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
const repo = 'C:/Users/bear9/OpenCharts';
const { parse } = await import(pathToFileURL(repo + '/src/pine/parser.ts'));
const { runScript } = await import(pathToFileURL(repo + '/src/pine/interpreter.ts'));
await import(pathToFileURL(repo + '/src/pine/builtins/index.ts'));
await import(pathToFileURL(repo + '/src/pine/mtf.ts'));

// Minimal canonical serializer — numbers rounded 6dp, na→null, same shape as
// golden.ts snapshot() for plots (the only field alias/cow paths can touch).
const canon = (v) => {
  if (v == null) return null;
  if (typeof v !== 'object') return v;
  if (v.kind === 'na' || v.kind === 'void') return null;
  if (v.kind === 'int' || v.kind === 'float') return +(+v.v).toFixed(6);
  if (v.kind === 'bool' || v.kind === 'string' || v.kind === 'color') return v.v;
  return `[${v.kind}]`;
};
const snap = (r) => JSON.stringify({
  plots: [...r.plots.entries()].sort().map(([k, p]) => [k, p.values.map(canon)]),
  fills: r.fills, alerts: r.alerts, warnings: [...r.warnings].sort(),
});

function mkBars(n, startMs = 0, stepMs = 60_000) {
  const bars = []; let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 20) * 2 + ((i * 7919) % 100 - 50) * 0.02;
    const open = p;
    bars.push({ openTime: startMs + i * stepMs, open,
      high: open + 1.5 + (i % 3) * 0.2, low: open - 1.5 - (i % 2) * 0.2,
      close: open + 0.4 + Math.cos(i / 15) * 0.3, volume: 1000 + i * 7 + (i % 11) * 13 });
  }
  return bars;
}
function resampleTf(bars, tf) {
  const m = /^(\d+)([smhdw]?)$/i.exec(tf.trim());
  const sec = m ? +m[1] * ({ s:1,m:60,h:3600,d:86400,w:604800 }[(m[2]??'m').toLowerCase()]) : 60;
  if (sec <= 60) return bars;
  const b = new Map();
  for (const x of bars) {
    const k = x.openTime - (x.openTime % (sec * 1000));
    const c = b.get(k);
    if (!c) b.set(k, { ...x, openTime: k });
    else { c.high=Math.max(c.high,x.high); c.low=Math.min(c.low,x.low); c.close=x.close; c.volume+=x.volume; }
  }
  return [...b.values()].sort((a,z)=>a.openTime-z.openTime);
}

const CASES = [
  { name:'見高K4.55', file:'C:/Users/bear9/high452/HIGH455/見高K4.54/見高K4.55.TXT', tf:'15', n:500, step:900_000 },
  { name:'高量1.46',  file:'C:/Users/bear9/high452/高量1.46/高量1.46_backup.TXT',  tf:'D',  n:500, step:60_000 },
];
const BASE_1M = mkBars(3000, 0, 60_000);

for (const c of CASES) {
  const bars = mkBars(c.n, 0, c.step);
  const src = readFileSync(c.file, 'utf8').replace(/^/, '');
  const run = () => runScript(parse(src), bars, {
    symbol:'2330', timeframe:c.tf, fetchSeries: async (s,t) => resampleTf(BASE_1M, t),
  });
  globalThis.__pineInterp = true;  const ti=Date.now(); const ri=await run(); const msI=Date.now()-ti;
  delete globalThis.__pineInterp;  const tc=Date.now(); const rc=await run(); const msC=Date.now()-tc;
  const si=snap(ri), sc=snap(rc), ident=si===sc;
  console.log(JSON.stringify({ name:c.name, identical:ident, interp_ms:msI, comp_ms:msC }));
  if (!ident) {
    let i=0; while(si[i]===sc[i]) i++;
    console.log('first diff byte', i);
    console.log('interp:', si.slice(Math.max(0,i-100), i+100));
    console.log('comp  :', sc.slice(Math.max(0,i-100), i+100));
    process.exitCode = 1;
  }
}
