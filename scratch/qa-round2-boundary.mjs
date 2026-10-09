// Ultra-QA round2 BOUNDARY lane: edges round-1 lanes didn't cover.
//   1. security_lower_tf: ltf == chart tf / non-divisible ltf / empty bars.
//   2. security_lower_tf UDF with `var` state — gap-skipped ltf bars.
//   3. strategy: qty=0 / qty<0 / close qty=0 / close_all + pending limits /
//      entry on last bar.
//   4. pinetsShim: PtSeries.get(i) beyond history; na propagation into ported rsi.
//   5. ta.tr after f7054d8: handle_na=false @bar0, series-typed arg, na close
//      mid-series (builtin AND ported impl).
// Run: npx vite-node scratch/qa-round2-boundary.mjs
import { pathToFileURL } from 'url';
const repo = 'C:/Users/bear9/OpenCharts';
const { parse } = await import(pathToFileURL(repo + '/src/pine/parser.ts'));
const { runScript } = await import(pathToFileURL(repo + '/src/pine/interpreter.ts'));
const { NA, Scope, Series } = await import(pathToFileURL(repo + '/src/pine/contracts.ts'));
const mtf = await import(pathToFileURL(repo + '/src/pine/mtf.ts'));
const { prepareSecurity, prefetchSecurity, resetMtf, tryEvalSecurity } = mtf;
await import(pathToFileURL(repo + '/src/pine/builtins/index.ts'));
const shim = await import(pathToFileURL(repo + '/src/pine/pinetsShim.ts'));
const { BUILTINS } = await import(pathToFileURL(repo + '/src/pine/builtins/registry.ts'));

const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(JSON.stringify({ name, pass, detail })); };

// ── harness (same as _qa_round1_dynamic.mjs) ─────────────────────────────────
const num = (v) => ({ type: 'num', v, isInt: Number.isInteger(v) });
const str = (v) => ({ type: 'str', v });
const ident = (name) => ({ type: 'ident', name });
const member = (obj, prop) => ({ type: 'member', obj, prop });
const assign = (name, value) => ({ type: 'assign', name, value });
const call = (callee, ...args) => ({ type: 'call', callee, args: args.map(a => ({ value: a })) });
const valOf = (v) => !v ? 'undef' : v.kind === 'na' ? 'na' : v.kind === 'int' || v.kind === 'float' ? v.v : v.kind === 'bool' ? `b:${v.v}` : `[${v.kind}]`;
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
const ltfCall = (tf, expr = ident('close')) => assign('x', call(member(ident('request'), 'security_lower_tf'), str(''), str(tf), expr));
const secCall = (tf, expr) => assign('x', call(member(ident('request'), 'security'), str(''), str(tf), expr));
const cells = (values) => values.map(v => v.kind === 'array' ? v.v.map(valOf) : `[${v.kind}]`);

// ══ 1a. ltf == chart tf (15m chart, '15' ltf) ════════════════════════════════
{
  const chartBars = [0, 1, 2].map(i => bar(i * 15 * M1, 10 + i));
  const ltf15 = [0, 1, 2].map(i => bar(i * 15 * M1, 100 + i));
  const { values, warnings } = await runSecurity([ltfCall('15')], chartBars, '15', { '|15': ltf15 });
  const got = cells(values);
  rec('1a: ltf==chart tf (15m chart / "15" ltf)', false,
    { got, warnings,
      tv: 'runtime error "timeframe must be lower than the chart\'s" (same tf is rejected)',
      actual: 'emits 1 elem/bar when opens align — silently accepted' });
}

// ══ 1b. ltf does not divide chart tf (15m chart, '7' ltf) ════════════════════
{
  const chartBars = [0, 1].map(i => bar(i * 15 * M1, 10 + i));
  const ltf7 = [0, 1, 2, 3, 4].map(i => bar(i * 7 * M1, 100 + i)); // opens 0,7,14,21,28
  const { values, warnings } = await runSecurity([ltfCall('7')], chartBars, '15', { '|7': ltf7 });
  const got = cells(values);
  // [0,15): opens 0,7,14 → [100,101,102]; [15,30): opens 21,28 → [103,104]
  rec('1b: ltf 7m vs chart 15m (non-divisible)',
    JSON.stringify(got) === JSON.stringify([[100, 101, 102], [103, 104]]),
    { got, warnings, tv: 'existing ltf opens in [t0, t0+15m): [100,101,102] / [103,104]' });
}

// ══ 1c. empty ltf bars array ═════════════════════════════════════════════════
{
  const chartBars = [0, 1].map(i => bar(i * 15 * M1, 10 + i));
  const { values, warnings } = await runSecurity([ltfCall('5')], chartBars, '15', { '|5': [] });
  const got = values.map(valOf);
  rec('1c: empty ltf bars array', got.every(v => v !== 'na'),
    { got, warnings,
      tv: 'runtime error (no data) — or [] with ignore_invalid_symbol; an EMPTY ARRAY either way, never na',
      actual: 'returns na — array.size(x) on the result errors instead of reporting 0' });
}

// ══ 2. security_lower_tf with stateful UDF (var acc) — contiguous vs gap ════
// counter() has file-level UDF state; TV evaluates the security expression on
// EVERY ltf bar (it drives its own series), so ltf bars inside a chart gap
// still advance acc. Our ltf path only evaluates bars inside emitted windows
// (+ first-call warm-up) — gap bars are skipped, values under-count.
const counterSrc = parse([
  'counter() =>',
  '    var acc = 0',
  '    acc := acc + 1',
  'x = request.security_lower_tf("", "5", counter())',
].join('\n'));
const ltf5full = Array.from({ length: 11 }, (_, k) => bar(k * 5 * M1, 100 + k)); // 0..50m
{
  // control: contiguous chart bars — accumulation must match an ungated run
  const chartBars = [0, 15, 30, 45].map(t => bar(t * M1, 10));
  const { values } = await runSecurity(counterSrc.body, chartBars, '15', { '|5': ltf5full });
  const got = cells(values);
  rec('2a: ltf UDF var acc — contiguous chart bars',
    JSON.stringify(got) === JSON.stringify([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11]]),
    { got, tv: 'acc counts every ltf bar 0..10 → [1,2,3]/[4,5,6]/[7,8,9]/[10,11]' });
}
{
  // gap: chart bars at 0,30,45 skip the [15,30) window entirely
  const chartBars = [0, 30, 45].map(t => bar(t * M1, 10));
  const { values, warnings } = await runSecurity(counterSrc.body, chartBars, '15', { '|5': ltf5full });
  const got = cells(values);
  rec('2b: ltf UDF var acc — chart gap skips ltf bars (P1)',
    JSON.stringify(got) === JSON.stringify([[1, 2, 3], [7, 8, 9], [10, 11]]),
    { got, warnings,
      tv: '[INFERENCE] ltf bars at 15/20/25m still evaluate on TV (expr runs on the tf series) → [1,2,3]/[7,8,9]/[10,11]',
      actual: 'gap bars never evaluated → acc under-counts: emitted values are eval-order ordinals, not ltf bar ordinals' });
}
{
  // same stateful UDF through plain request.security — warm-up replays tf bars
  // 0..j so chart gaps ARE covered there; probe to attribute the 2b divergence
  // to the ltf emission path specifically.
  const body = parse([
    'counter() =>',
    '    var acc = 0',
    '    acc := acc + 1',
    'x = request.security("", "5", counter())',
  ].join('\n')).body;
  const chartBars = [0, 45, 90].map(t => bar(t * M1, 10));
  const { values } = await runSecurity(body, chartBars, '15', { '|5': ltf5full });
  const got = values.map(valOf);
  rec('2c: plain security() UDF var acc across gap (attribution)',
    JSON.stringify(got) === JSON.stringify(['na', 9, 10]),
    { got, tv: 'lookahead_off: bar0 na; t0=45 → last completed ltf bar = idx8 (acc 9); t0=90 → idx9 (acc 10)' });
}

// ══ 3. strategy boundaries ═══════════════════════════════════════════════════
const strat = async (src, n = 6) => {
  const bars = Array.from({ length: n }, (_, i) => bar(i * M1, 10 + i));
  const r = await runScript(parse(src), bars, { symbol: 'TEST', timeframe: '1' });
  const col = (idx) => [...r.plots.values()][idx]?.values.map(valOf);
  return { r, col };
};
{
  const { col } = await strat(`strategy("s")
if bar_index == 0
    strategy.entry("L", strategy.long, qty=0)
plot(strategy.position_size)`);
  rec('3a: strategy.entry qty=0', col(0).every(v => v === 0),
    { pos: col(0), tv: 'qty=0 → zero contracts, no position', actual: 'qty>0 fails → silently falls back to default_qty_value=1 → fills 1' });
}
{
  const { col } = await strat(`strategy("s")
if bar_index == 0
    strategy.entry("L", strategy.long, qty=-2)
plot(strategy.position_size)`);
  rec('3b: strategy.entry qty=-2', col(0).every(v => v === 0),
    { pos: col(0), tv: '[INFERENCE] negative qty is invalid — no long fill', actual: 'qty>0 fails → default_qty_value=1 → fills +1' });
}
{
  const { col } = await strat(`strategy("s")
if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 3
    strategy.close("L", qty=0)
plot(strategy.position_size)`);
  const pos = col(0);
  rec('3c: strategy.close qty=0', pos[5] === 2 && pos[4] === 2,
    { pos, tv: 'qty=0 → zero contracts → position stays +2', actual: 'qty>0 && eqPct>0 both fail → falls back to FULL position close → 0' });
}
{
  // close_all does NOT cancel pending entry orders (TV doc): a limit entry
  // placed before close_all must still fill later.
  const bars = Array.from({ length: 7 }, (_, i) => bar(i * M1, 10 + i));
  // bar3 dips to low=8.5 (limit 9 fills), others stay above 9
  bars[3] = { openTime: 3 * M1, open: 13, high: 14, low: 8.5, close: 13, volume: 100 };
  const r = await runScript(parse(`strategy("s")
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
    strategy.entry("L2", strategy.long, qty=1, limit=9)
if bar_index == 2
    strategy.close_all()
plot(strategy.position_size)`), bars, { symbol: 'TEST', timeframe: '1' });
  const pos = [...r.plots.values()][0].values.map(valOf);
  const l2Filled = (r.execs ?? []).some(e => e.label === 'L2');
  rec('3d: close_all leaves pending limit entry alive (TV: correct)',
    l2Filled,
    { pos, execs: r.execs,
      tv: 'close_all() does NOT cancel pending orders — L2 fills at bar3 limit',
      note: 'l2 survived + filled. Same-bar ordering: ours fills the pending entry BEFORE the market exit (qty +1 then -2 → net 0); TV likely nets +1 (market exit at open, limit fills intra-bar later) — intra-bar ordering nuance [INFERENCE]' });
}
{
  const { col } = await strat(`strategy("s")
if bar_index == 4
    strategy.entry("L", strategy.long)
plot(strategy.position_size)`, 5);
  rec('3e: entry on last bar — no next bar to fill', col(0).every(v => v === 0),
    { pos: col(0), tv: 'order placed on last bar never fills → flat' });
}
{
  // control for 3d sequencing: cancel_all AFTER close_all on same bar must
  // cancel the queued exit too (TV ordering caveat).
  const { col } = await strat(`strategy("s")
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 2
    strategy.close_all()
    strategy.cancel_all()
plot(strategy.position_size)`);
  const pos = col(0);
  rec('3f: close_all then cancel_all same bar — exit cancelled (TV caveat)',
    pos[4] === 1 && pos[5] === 1,
    { pos, tv: 'cancel_all kills the queued close_all exit → stays +1', });
}

// ══ 4. pinetsShim boundaries ═════════════════════════════════════════════════
{
  const { PtSeries } = shim;
  const s = new Series(8);
  s.set({ kind: 'float', v: 42 }); // one bar of history
  const live = PtSeries.fromPine(s);
  const mat = new PtSeries([1, 2, 3]); // newest=3
  const checks = {
    live_now: live.get(0), live_beyond: live.get(5), live_neg: live.get(-1),
    live_frac: live.get(2.7), live_na: live.get(NaN),
    mat_0: mat.get(0), mat_2: mat.get(2), mat_beyond: mat.get(5), mat_neg: mat.get(-1),
  };
  const ok = checks.live_now === 42 && Number.isNaN(checks.live_beyond) && Number.isNaN(checks.live_neg)
    && Number.isNaN(checks.live_frac) && checks.live_na === 42
    && checks.mat_0 === 3 && checks.mat_2 === 1 && Number.isNaN(checks.mat_beyond) && Number.isNaN(checks.mat_neg);
  rec('4a: PtSeries.get(i) beyond history → NaN (no throw)', ok, checks);
}
// na propagation through ported rsi. close: 10,na,12,13,14,15,16 (period 3).
// TV/pinets: na bar stores value, next bar's diff is na → first real value
// needs `period` consecutive diffs AFTER the na → expect [na,na,na,na,na,100,100].
{
  const displaced = shim.registerPortedTa(); // now ta.* = ported impls
  try {
    const r = await runScript(parse(`indicator("t")
s = bar_index == 1 ? na : close
plot(ta.rsi(s, 3))`), Array.from({ length: 7 }, (_, i) => bar(i * M1, 10 + i)), { symbol: 'TEST', timeframe: '1' });
    const got = [...r.plots.values()][0].values.map(valOf);
    rec('4b: ported rsi — na source bar propagates (seed shift)',
      JSON.stringify(got) === JSON.stringify(['na', 'na', 'na', 'na', 'na', 100, 100]),
      { got, tv: 'na bar does not advance averages; diff after na is na → first value at bar5', warnings: [...r.warnings] });
  } catch (e) { rec('4b: ported rsi — na source bar propagates', false, 'THREW: ' + (e?.message ?? e)); }
  {
    const r = await runScript(parse(`indicator("t")
plot(ta.rsi(na, 3))`), [bar(0, 10), bar(M1, 11)], { symbol: 'TEST', timeframe: '1' });
    const got = [...r.plots.values()][0].values.map(valOf);
    rec('4c: ported rsi — scalar na source → na, no throw', got.every(v => v === 'na'), { got, warnings: [...r.warnings] });
  }
  // ── 5. ta.tr — ported impl boundaries (builtin checked first below) ──
  {
    const r = await runScript(parse(`indicator("t")
plot(ta.tr(false))
plot(ta.tr(true))
plot(ta.tr(bar_index > 0))`), [bar(0, 10), bar(M1, 11)], { symbol: 'TEST', timeframe: '1' });
    const f = [...r.plots.values()][0].values.map(valOf);
    const t = [...r.plots.values()][1].values.map(valOf);
    const ser = [...r.plots.values()][2].values.map(valOf);
    rec('5b: ported tr — handle_na=false @bar0 → na; series arg honors cur()',
      f[0] === 'na' && t[0] === 2 && ser[0] === 'na' && ser[1] === 2,
      { trFalse: f, trTrue: t, trSeries: ser,
        tv: 'handle_na=false @bar0 → na; series handle_na=bar_index>0 → bar0 na, bar1 real tr' });
  }
  {
    // NaN close mid-series (only close — h/l finite): bar1's tr uses finite
    // close[1]; bar2 sees close[1]=NaN → handle_na=true must yield h−l.
    const nb = bar(0, 10); const nanBar = { ...bar(M1, 0), close: NaN };
    const r = await runScript(parse(`indicator("t")
plot(ta.tr(true))`), [nb, nanBar, bar(2 * M1, 12)], { symbol: 'TEST', timeframe: '1' });
    const got = [...r.plots.values()][0].values.map(valOf);
    rec('5c: ported tr — NaN close mid-series, handle_na=true → h−l',
      JSON.stringify(got) === JSON.stringify([2, 11, 2]),
      { got, tv: 'bar1 tr=11 (finite close[1]=10, h=1/l=−1); bar2: isNaN(close1) → handle_na honored → h−l=2' });
  }
  // restore displaced builtins so builtin tr probes run the FIXED impl
  for (const [name, fn] of displaced) if (fn) BUILTINS.set(`ta.${name}`, fn);
}
// builtin ta.tr (the f7054d8 fix): handle_na=false @bar0, series arg, NaN close.
{
  const r = await runScript(parse(`indicator("t")
plot(ta.tr(false))
plot(ta.tr(true))
plot(ta.tr(bar_index > 0))`), [bar(0, 10), bar(M1, 11)], { symbol: 'TEST', timeframe: '1' });
  const f = [...r.plots.values()][0].values.map(valOf);
  const t = [...r.plots.values()][1].values.map(valOf);
  const ser = [...r.plots.values()][2].values.map(valOf);
  rec('5a: builtin tr — handle_na=false @bar0 → na; true → h−l; series arg ok',
    f[0] === 'na' && t[0] === 2 && f[1] === 2 && ser[0] === 'na' && ser[1] === 2,
    { trFalse: f, trTrue: t, trSeries: ser, tv: 'bar0: false→na, true→h−l=2; series handle_na: bar0 false→na, bar1→2' });
}
{
  // builtin tr: NaN close[1] is a numeric float, so `pc === undefined` is
  // false → Math.max spreads NaN → na. The ported impl checks isNaN(close1)
  // and returns h−l — a real asymmetry between the two ta.tr impls.
  const nb = bar(0, 10); const nanBar = { ...bar(M1, 0), close: NaN };
  const r = await runScript(parse(`indicator("t")
plot(ta.tr(true))`), [nb, nanBar, bar(2 * M1, 12)], { symbol: 'TEST', timeframe: '1' });
  const got = [...r.plots.values()][0].values.map(valOf);
  rec('5d: builtin tr — NaN close mid-series, handle_na=true',
    JSON.stringify(got) === JSON.stringify([2, 11, 2]),
    { got, tv: 'handle_na=true → na prev close → h−l=2 (TV treats na close[1] as missing)',
      actual: 'num() sees NaN as a number → Math.max → na. Ported impl returns h−l (correct per handle_na) — asymmetry. [INFERENCE: real feeds rarely carry na mid-series]' });
}

const failed = results.filter(r => !r.pass);
console.log('SUMMARY ' + JSON.stringify({ total: results.length, failed: failed.map(f => f.name) }));
process.exitCode = 0; // boundary probes record expected-vs-actual; FAILs are findings, not crashes
