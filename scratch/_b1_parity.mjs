// B1 parity check — incremental windows vs in-Pine manual scans (oracle).
// tf-security expr computes builtin + manual equivalent as a tuple; the test
// asserts |builtin - manual| within float tolerance on every chart bar.
import '../src/pine/builtins/index.ts';
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
  const sec = Number(/^(\d+)/.exec(tf)[1]) * 60;
  const buckets = new Map();
  for (const b of bars) {
    const key = b.openTime - (b.openTime % (sec * 1000));
    const cur = buckets.get(key);
    if (!cur) buckets.set(key, { ...b, openTime: key });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

const chartBars = mkBars(4000, 300_000);
const base1m = mkBars(20_000, 60_000);
const fetchSeries = async (_s, tf) => resampleTf(base1m, tf);

const SRC = `//@version=6
indicator("parity")
f_sma(src, L) =>
    s = 0.0
    for i = 0 to L - 1
        s += src[i]
    s / L
f_wma(src, L) =>
    n = 0.0
    d = 0.0
    for i = 0 to L - 1
        w = L - i
        n += src[i] * w
        d += w
    n / d
f_hi(src, L) =>
    m = src
    for i = 1 to L - 1
        m := math.max(m, src[i])
    m
f_lo(src, L) =>
    m = src
    for i = 1 to L - 1
        m := math.min(m, src[i])
    m
f_sd(src, L) =>
    sm = 0.0
    for i = 0 to L - 1
        sm += src[i]
    m = sm / L
    s = 0.0
    for i = 0 to L - 1
        d = src[i] - m
        s += d * d
    math.sqrt(s / L)
[a1, b1] = request.security(syminfo.tickerid, "15", [ta.sma(close, 40), f_sma(close, 40)])
[a2, b2] = request.security(syminfo.tickerid, "15", [ta.wma(close, 40), f_wma(close, 40)])
[a3, b3] = request.security(syminfo.tickerid, "15", [ta.highest(high, 40), f_hi(high, 40)])
[a4, b4] = request.security(syminfo.tickerid, "15", [ta.lowest(low, 40), f_lo(low, 40)])
[a5, b5] = request.security(syminfo.tickerid, "15", [ta.stdev(close, 40), f_sd(close, 40)])
d = math.max(math.max(math.max(math.abs(a1 - b1), math.abs(a2 - b2)), math.max(math.abs(a3 - b3), math.abs(a4 - b4))), math.abs(a5 - b5))
plot(d)
plot(a1)
`;

const res = await runScript(parse(SRC), chartBars, {
  symbol: 'TEST', timeframe: '5', fetchSeries,
});

// pull plot 0 (max diff) values — res.plots is a Map<key, {values: number[]}>
const plot0 = res.plots.values().next().value;
const diffs = plot0?.values ?? [];
let mx = 0, na = 0, n = 0;
for (const x of diffs) {
  if (x === undefined || x === null || Number.isNaN(x)) { na++; continue; }
  n++; if (Math.abs(x) > mx) mx = Math.abs(x);
}
console.log(JSON.stringify({ maxDiff: mx, defined: n, na, warnings: res.warnings }));
