// Ultra-QA round1 DYNAMIC lane: boundary probes for commits 814375a (security_lower_tf
// existing-bars-only), f34a86d (pinetsShim pilots), 035e8e8 (strategy close qty fix).
// Drives the real evaluator paths via vite-node — mirrors scratch/_strategy_qa.mjs +
// the runSecurity harness in src/pine/__tests__/mtf.test.ts.
import { pathToFileURL } from 'url';
const repo = 'C:/Users/bear9/OpenCharts';
const { parse } = await import(pathToFileURL(repo + '/src/pine/parser.ts'));
const { runScript } = await import(pathToFileURL(repo + '/src/pine/interpreter.ts'));
const { NA, Scope, Series } = await import(pathToFileURL(repo + '/src/pine/contracts.ts'));
const mtf = await import(pathToFileURL(repo + '/src/pine/mtf.ts'));
const { prepareSecurity, prefetchSecurity, resetMtf, tryEvalSecurity } = mtf;
await import(pathToFileURL(repo + '/src/pine/builtins/index.ts'));
const { registerPortedTa } = await import(pathToFileURL(repo + '/src/pine/pinetsShim.ts'));

const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(JSON.stringify({ name, pass, detail })); };

// ── harness (copied semantics from mtf.test.ts) ──────────────────────────────
const num = (v) => ({ type: 'num', v, isInt: Number.isInteger(v) });
const str = (v) => ({ type: 'str', v });
const ident = (name) => ({ type: 'ident', name });
const member = (obj, prop) => ({ type: 'member', obj, prop });
const assign = (name, value) => ({ type: 'assign', name, value });
const call = (callee, ...args) => ({ type: 'call', callee, args: args.map(a => ({ value: a })) });
const valOf = (v) => !v ? 'undef' : v.kind === 'na' ? 'na' : v.kind === 'int' || v.kind === 'float' ? v.v : `[${v.kind}]`;
const mkVal = (x) => (Number.isInteger(x) ? { kind: 'int', v: x } : { kind: 'float', v: x });
const M1 = 60_000;

function tfFlags(period) {
  const m = /^(\d*)([A-Za-z]*)$/.exec(period);
  const mult = m[1] === '' ? 1 : parseInt(m[1], 10);
  const u = (m[2] || '').toUpperCase();
  const intraday = u !== 'D' && u !== 'W' && u !== 'M';
  return { period, multiplier: mult, isseconds: u === 'S', isminutes: intraday,
    isdaily: u === 'D', isweekly: u === 'W', ismonthly: u === 'M', isintraday: intraday };
}
function mkCtx(bars, i, tf, opts = {}) {
  const mk = () => new Series(bars.length + 8);
  const open = mk(), high = mk(), low = mk(), close = mk(), volume = mk(), time = mk();
  const hl2 = mk(), hlc3 = mk(), ohlc4 = mk(), hlcc4 = mk();
  for (let k = 0; k <= i; k++) {
    const b = bars[k];
    open.set(mkVal(b.open)); high.set(mkVal(b.high)); low.set(mkVal(b.low));
    close.set(mkVal(b.close)); volume.set(mkVal(b.volume)); time.set(mkVal(b.openTime));
    hl2.set(mkVal((b.high + b.low) / 2)); hlc3.set(mkVal((b.high + b.low + b.close) / 3));
    ohlc4.set(mkVal((b.open + b.high + b.low + b.close) / 4));
    hlcc4.set(mkVal((b.open + b.high + b.low + b.close + b.close) / 4));
  }
  return { barIndex: i, barCount: bars.length, open, high, low, close, volume, time,
    hl2, hlc3, ohlc4, hlcc4, fetchSeries: opts.fetchSeries, plots: [], drawings: [],
    warnings: opts.warnings ?? [], alerts: [],
    syminfo: { tickerid: { kind: 'string', v: 'TEST' } }, timeframe: tfFlags(tf), callUdf: () => NA };
}
async function runSecurity(body, chartBars, chartTf, fetchMap) {
  resetMtf();
  const scope = new Scope();
  prepareSecurity(body);
  const warnings = [];
  const fetchSeries = async (s, t) => fetchMap[`${s}|${t}`] ?? fetchMap[`|${t}`] ?? [];
  await prefetchSecurity(mkCtx(chartBars, 0, chartTf, { fetchSeries, warnings }));
  const callNode = body.find(n => n.type === 'assign')?.value;
  const values = [];
  for (let i = 0; i < chartBars.length; i++)
    values.push(tryEvalSecurity(callNode, { scope, ctx: mkCtx(chartBars, i, chartTf, { fetchSeries, warnings }) }) ?? NA);
  return { values, warnings };
}
const bar = (openTime, close) => ({ openTime, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 100 });
const ltfCall = (tf) => assign('x', call(member(ident('request'), 'security_lower_tf'), str(''), str(tf), ident('close')));
const cells = (values) => values.map(v => v.kind === 'array' ? v.v.map(valOf) : `[${v.kind}]`);

// ── Probe A: ltf > chart tf (chart 1m, request "15") ────────────────────────
// Window [t0, t0+60s). 15m bar at openTime=0 only emits under t0=0 (open===t0).
// Every other chart bar: straddling 15m bar must NOT repeat → ≤1 element.
{
  const chartBars = [0, 1, 2, 3, 29, 30].map(i => bar(i * M1, 10 + i));
  const ltf15 = [bar(0, 100), bar(15 * M1, 200), bar(30 * M1, 300)];
  const { values, warnings } = await runSecurity([ltfCall('15')], chartBars, '1', { '|15': ltf15 });
  const got = cells(values);
  const lens = got.map(c => Array.isArray(c) ? c.length : -1);
  rec('A: ltf(15m) > chart(1m) — ≤1 elem, straddle not re-emitted',
    JSON.stringify(lens) === JSON.stringify([1, 0, 0, 0, 0, 0]) && warnings.length === 0,
    { got, lens, warnings });
}

// ── Probe A2: ltf > chart with off-grid opens (misaligned 15m bars at t=7,22) ─
// Chart 1m bar at t0=7..21 sits inside ltf bar [7,22): must emit [] (bar opened
// before t0), chart bar t0=22 emits [200]. No crash, no phantom.
{
  const chartBars = [7, 8, 21, 22].map(i => bar(i * M1, 10 + i));
  const ltf15 = [bar(7 * M1, 100), bar(22 * M1, 200)];
  const { values, warnings } = await runSecurity([ltfCall('15')], chartBars, '1', { '|15': ltf15 });
  const got = cells(values);
  rec('A2: off-grid ltf bars — straddling bar skipped, aligned open emitted',
    JSON.stringify(got) === JSON.stringify([[], [], [], [200]]),
    { got, warnings });
}

// ── Probe B: chart bar opens mid-ltf-slot (unusual feed, same tf family) ─────
// Chart "15" but bars at t0 = 2m,17m,32m (drifted off grid). 5m ltf bars on
// grid every 5m. Window for chart bar at 2m is [2m,17m): existing ltf bars at
// 5m,10m,15m → [c,c,c]; the 0m bar straddling t0=2m must NOT appear.
{
  const chartBars = [2, 17, 32].map(i => bar(i * M1, 50 + i));
  const ltf5 = Array.from({ length: 8 }, (_, k) => bar(k * 5 * M1, 100 + k)); // 0..35m
  const { values } = await runSecurity([ltfCall('5')], chartBars, '15', { '|5': ltf5 });
  const got = cells(values);
  rec('B: drifted chart opens — straddling t0-Δ bar excluded, in-window only',
    JSON.stringify(got) === JSON.stringify([[101, 102, 103], [104, 105, 106], [107]]),
    { got });
}

// ── Probe C: pinetsShim ported methods on a 1-bar series (idx=0, no history) ─
// ta.tr/ta.rsi/ta.supertrend at bar 0 must not throw; na/NaN → NA Value.
{
  registerPortedTa(); // overwrites ta.tr/ta.rsi/ta.supertrend call-forms
  const src = [
    'indicator("shim")',
    'a = ta.tr(true)',
    'b = ta.rsi(close, 14)',
    '[st, d] = ta.supertrend(3, 10)',
    'plot(a)', 'plot(b)', 'plot(st)', 'plot(d)',
  ].join('\n');
  try {
    const r = await runScript(parse(src), [bar(0, 10)], { symbol: 'TEST', timeframe: 'D' });
    const col = (idx) => [...r.plots.values()][idx]?.values.map(valOf);
    const got = [col(0), col(1), col(2), col(3)];
    // tr@0 handle_na → high-low = 2; rsi@0 → na; supertrend@0 → [na, na]
    rec('C: pinetsShim pilots at idx=0 — no throw, na-safe',
      JSON.stringify(got) === JSON.stringify([[2], ['na'], ['na'], ['na']]),
      { got, warnings: [...r.warnings] });
  } catch (e) {
    rec('C: pinetsShim pilots at idx=0 — no throw, na-safe', false, 'THREW: ' + (e?.message ?? e));
  }
}

// ── Probe D: strategy.close qty_percent=50 halves position (the F2 fix) ──────
{
  const src = [
    'strategy("s")',
    'if bar_index == 0',
    '    strategy.entry("L", strategy.long, qty=2)',
    'if bar_index == 2',
    '    strategy.close("L", qty_percent=50)',
    'plot(strategy.position_size)',
    'plot(strategy.opentrades)',
  ].join('\n');
  const flat = Array.from({ length: 6 }, (_, i) => bar(i * M1, 10 + i));
  try {
    const r = await runScript(parse(src), flat, { symbol: 'TEST', timeframe: 'D' });
    const pos = [...r.plots.values()][0].values.map(valOf);
    const open = [...r.plots.values()][1].values.map(valOf);
    // fill timing: entry placed bar0 → fills bar1 open; close placed bar2 → fills bar3 open.
    // Expect pos: 0,0,2,2,1,1 and opentrades 0,0,1,1,1,1 (partial close keeps leg open).
    rec('D: close qty_percent=50 halves position',
      JSON.stringify(pos.slice(3)) === JSON.stringify([1, 1, 1]) && pos[2] === 2,
      { pos, open });
  } catch (e) {
    rec('D: close qty_percent=50 halves position', false, 'THREW: ' + (e?.message ?? e));
  }
}

const failed = results.filter(r => !r.pass);
console.log('SUMMARY ' + JSON.stringify({ total: results.length, failed: failed.map(f => f.name) }));
process.exitCode = failed.length ? 1 : 0;
