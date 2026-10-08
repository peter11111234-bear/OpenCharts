// Pure-expr microbench for slice-D: 2000 bars of `plot(close*2+open/3)`-style
// stmt-level arithmetic. evalNode self-time should drop once expr stmts
// compile to closures (compare with __pineInterp=1 or PINE_INTERP=1).
import { pathToFileURL } from 'url';
const repo = 'C:/Users/bear9/OpenCharts';
const { parse } = await import(pathToFileURL(repo + '/src/pine/parser.ts'));
const { runScript } = await import(pathToFileURL(repo + '/src/pine/interpreter.ts'));
await import(pathToFileURL(repo + '/src/pine/builtins/index.ts'));
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

const src = `
indicator("expr")
a = close * 2 + open / 3
b = a > open ? a : open
c = -a + b
plot(c)`;
const parsed = parse(src);
const bars = mkBars(2000);
const t0 = Date.now();
const r = await runScript(parsed, bars, { symbol: 'X', timeframe: 'D' });
console.log('expr2000', Date.now() - t0 + 'ms', 'plots=' + r.plots.size, 'warn=' + r.warnings.length);
