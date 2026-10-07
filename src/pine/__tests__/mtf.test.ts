// ── mtf.ts tests ────────────────────────────────────────────────────────────
// Drives prepareSecurity → prefetchSecurity → tryEvalSecurity directly with
// hand-built AST + BuiltinCtx, so it exercises MTF semantics even before the
// interpreter lands (fallback evaluator path).

import { describe, expect, it, beforeEach } from 'vitest';
import type { BarData, BuiltinCtx, Node, Scope as ScopeT, UdfDecl, Value } from '../contracts';
import { NA, Scope, Series } from '../contracts';
import { BarSeries } from '../series';
import {
  prepareSecurity, prefetchSecurity, resetMtf, tfFloor, tfNext, tfToMs, tryEvalSecurity,
} from '../mtf';
import { parse } from '../parser';
import { evalExpr, runScript } from '../interpreter';
import '../builtins'; // registers builtins for the e2e test

// ── AST builders ────────────────────────────────────────────────────────────

const num = (v: number): Node => ({ type: 'num', v, isInt: Number.isInteger(v) });
const str = (v: string): Node => ({ type: 'str', v });
const ident = (name: string): Node => ({ type: 'ident', name });
const member = (obj: Node, prop: string): Node => ({ type: 'member', obj, prop });
const histref = (obj: Node, idx: Node): Node => ({ type: 'histref', obj, idx });
const binary = (op: string, left: Node, right: Node): Node => ({ type: 'binary', op, left, right });
const arraylit = (items: Node[]): Node => ({ type: 'arraylit', items });
const assign = (name: string, value: Node): Node => ({ type: 'assign', name, value });
const call = (callee: Node, ...args: (Node | { name: string; value: Node })[]): Node => ({
  type: 'call', callee,
  args: args.map(a => 'type' in (a as Node) ? { value: a as Node } : a as { name: string; value: Node }),
});
const security = (sym: Node, tf: Node, expr: Node, gaps?: Node, lookahead?: Node): Node =>
  call(member(ident('request'), 'security'), sym, tf, expr,
    ...(gaps ? [gaps] : []), ...(lookahead ? [lookahead] : []));

// ── bar + ctx builders ──────────────────────────────────────────────────────

function mkBars(n: number, tfMs: number, start = 0, closeFn: (i: number) => number = i => i): BarData[] {
  const bars: BarData[] = [];
  for (let i = 0; i < n; i++) {
    const c = closeFn(i);
    bars.push({ openTime: start + i * tfMs, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 100 + i });
  }
  return bars;
}

const mkVal = (x: number): Value => (Number.isInteger(x) ? { kind: 'int', v: x } : { kind: 'float', v: x });

function tfFlags(period: string): BuiltinCtx['timeframe'] {
  const m = /^(\d*)([A-Za-z]*)$/.exec(period)!;
  const mult = m![1] === '' ? 1 : parseInt(m![1]!, 10);
  const u = (m![2] || '').toUpperCase();
  const intraday = u !== 'D' && u !== 'W' && u !== 'M';
  return {
    period, multiplier: mult,
    isseconds: u === 'S', isminutes: intraday, isdaily: u === 'D',
    isweekly: u === 'W', ismonthly: u === 'M', isintraday: intraday,
  };
}

/** Build a chart ctx as of bar `i` (series contain bars[0..i]). */
function mkCtx(bars: BarData[], i: number, tf: string, opts?: {
  fetchSeries?: (s: string, t: string) => Promise<BarData[]>;
  warnings?: string[];
}): BuiltinCtx {
  const mk = () => new Series(bars.length + 8);
  const open = mk(), high = mk(), low = mk(), close = mk(), volume = mk(), time = mk();
  const hl2 = mk(), hlc3 = mk(), ohlc4 = mk(), hlcc4 = mk();
  for (let k = 0; k <= i; k++) {
    const b = bars[k]!;
    open.set(mkVal(b.open)); high.set(mkVal(b.high)); low.set(mkVal(b.low));
    close.set(mkVal(b.close)); volume.set(mkVal(b.volume)); time.set(mkVal(b.openTime));
    hl2.set(mkVal((b.high + b.low) / 2)); hlc3.set(mkVal((b.high + b.low + b.close) / 3));
    ohlc4.set(mkVal((b.open + b.high + b.low + b.close) / 4));
    hlcc4.set(mkVal((b.high + b.low + b.close + b.close) / 4));
  }
  return {
    barIndex: i, barCount: bars.length,
    open, high, low, close, volume, time, hl2, hlc3, ohlc4, hlcc4,
    fetchSeries: opts?.fetchSeries,
    plots: [], drawings: [],
    warnings: opts?.warnings ?? [],
    alerts: [],
    syminfo: { tickerid: { kind: 'string', v: 'TEST' } },
    timeframe: tfFlags(tf),
    callUdf: () => NA,
  };
}

/** Run a security-call body over all chart bars; returns per-bar values. */
async function runSecurity(
  body: Node[], chartBars: BarData[], chartTf: string,
  fetchMap: Record<string, BarData[]>, extra?: (scope: ScopeT) => void,
): Promise<{ values: Value[]; warnings: string[]; fetched: string[] }> {
  resetMtf();
  const scope = new Scope();
  extra?.(scope);
  prepareSecurity(body);
  const warnings: string[] = [];
  const fetched: string[] = [];
  const fetchSeries = async (s: string, t: string): Promise<BarData[]> => {
    fetched.push(`${s}|${t}`);
    return fetchMap[`${s}|${t}`] ?? fetchMap[`|${t}`] ?? [];
  };
  await prefetchSecurity(mkCtx(chartBars, 0, chartTf, { fetchSeries, warnings }));
  const values: Value[] = [];
  const callNode = findSecurityCall(body)!;
  for (let i = 0; i < chartBars.length; i++) {
    values.push(tryEvalSecurity(callNode, { scope, ctx: mkCtx(chartBars, i, chartTf, { fetchSeries, warnings }) }) ?? NA);
  }
  return { values, warnings, fetched };
}

function findSecurityCall(nodes: Node[]): Node | null {
  for (const n of nodes) {
    if (n.type === 'call' && n.callee.type === 'member'
        && (n.callee.prop === 'security' || n.callee.prop === 'security_lower_tf')) return n;
    const v = (n as unknown as Record<string, unknown>).value;
    if (v && typeof v === 'object' && 'type' in (v as object)) {
      const r = findSecurityCall([v as Node]);
      if (r) return r;
    }
  }
  return null;
}

const valOf = (v: Value): number | 'na' => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na');

// ── timeframe helpers ───────────────────────────────────────────────────────

describe('tf helpers', () => {
  it('tfToMs parses intraday units', () => {
    expect(tfToMs('60')).toBe(3_600_000);
    expect(tfToMs('15')).toBe(900_000);
    expect(tfToMs('1S')).toBe(1_000);
    expect(tfToMs('4H')).toBe(14_400_000);
    expect(tfToMs('D')).toBeNull();
    expect(tfToMs('W')).toBeNull();
    expect(tfToMs('3M')).toBeNull();
  });
  it('tfFloor/tfNext handle intraday + weekly + monthly', () => {
    expect(tfFloor(5_400_000, '60')).toBe(3_600_000);
    expect(tfNext(3_600_000, '60')).toBe(7_200_000);
    // 2024-01-03 is a Wednesday → W floor is Monday 2024-01-01
    const wed = Date.UTC(2024, 0, 3);
    expect(tfFloor(wed, 'W')).toBe(Date.UTC(2024, 0, 1));
    expect(tfNext(Date.UTC(2024, 0, 1), 'W')).toBe(Date.UTC(2024, 0, 8));
    // monthly floor/next
    expect(tfFloor(Date.UTC(2024, 0, 15), 'M')).toBe(Date.UTC(2024, 0, 1));
    expect(tfNext(Date.UTC(2024, 0, 1), 'M')).toBe(Date.UTC(2024, 1, 1));
  });
});

// ── security alignment ──────────────────────────────────────────────────────

describe('request.security alignment', () => {
  beforeEach(resetMtf);

  const M15 = 900_000, H1 = 3_600_000;
  // 12 × 15m chart bars = 3 hours; 3 × 60m tf bars, closes 100/200/300
  const chart = mkBars(12, M15, 0);
  const tf60 = mkBars(3, H1, 0, i => 100 + i * 100);

  it('lookahead_off returns last COMPLETED 60m close per 15m bar', async () => {
    const body = [assign('x', security(str(''), str('60'), ident('close')))];
    const { values } = await runSecurity(body, chart, '15', { '|60': tf60 });
    // t<3600000 → no completed 60m bar → na; t>=3600000 → bar0 close=100; t>=7200000 → bar1 close=200
    const got = values.map(valOf);
    expect(got.slice(0, 4)).toEqual(['na', 'na', 'na', 'na']);
    expect(got.slice(4, 8)).toEqual([100, 100, 100, 100]);
    expect(got.slice(8, 12)).toEqual([200, 200, 200, 200]);
  });

  it('lookahead_on returns developing tf bar value (future leak)', async () => {
    const body = [assign('x', security(str(''), str('60'), ident('close'),
      member(ident('barmerge'), 'gaps_off'), member(ident('barmerge'), 'lookahead_on')))];
    const { values } = await runSecurity(body, chart, '15', { '|60': tf60 });
    const got = values.map(valOf);
    expect(got.slice(0, 4)).toEqual([100, 100, 100, 100]);  // developing bar 0
    expect(got.slice(4, 8)).toEqual([200, 200, 200, 200]);  // developing bar 1
    expect(got.slice(8, 12)).toEqual([300, 300, 300, 300]); // developing bar 2
  });

  it('gaps_on emits na except first chart bar inside each completed tf bar', async () => {
    const body = [assign('x', security(str(''), str('60'), ident('close'),
      member(ident('barmerge'), 'gaps_on')))];
    const { values } = await runSecurity(body, chart, '15', { '|60': tf60 });
    const got = values.map(valOf);
    expect(got.slice(0, 4)).toEqual(['na', 'na', 'na', 'na']);
    expect(got.slice(4, 8)).toEqual([100, 'na', 'na', 'na']);
    expect(got.slice(8, 12)).toEqual([200, 'na', 'na', 'na']);
  });

  it('expr[n] reads tf history — weekly prev close', async () => {
    // 21 daily bars from Monday 2024-01-01; 3 weekly bars closes 10/20/30
    const day = 86_400_000, mon = Date.UTC(2024, 0, 1);
    const dBars = mkBars(21, day, mon);
    const wBars = mkBars(3, 7 * day, mon, i => 10 + i * 10);
    const body = [assign('x', security(str(''), str('W'), histref(ident('close'), num(1))))];
    const { values } = await runSecurity(body, dBars, 'D', { '|W': wBars });
    const got = values.map(valOf);
    // week0 (d0-6): no completed W bar → na
    expect(got.slice(0, 7)).toEqual(['na', 'na', 'na', 'na', 'na', 'na', 'na']);
    // week1 (d7-13): last completed = W0; close[1] at W0 → out of range → na
    expect(got.slice(7, 14)).toEqual(['na', 'na', 'na', 'na', 'na', 'na', 'na']);
    // week2 (d14-20): last completed = W1; close[1] at W1 → W0 close = 10
    expect(got.slice(14, 21)).toEqual([10, 10, 10, 10, 10, 10, 10]);
  });

  it('[a,b] tuple returns array Value', async () => {
    const body = [assign('x', security(str(''), str('60'),
      arraylit([ident('close'), ident('open')])))];
    const { values } = await runSecurity(body, chart, '15', { '|60': tf60 });
    expect(values[0]!.kind).toBe('na');
    const v4 = values[4]!;
    expect(v4.kind).toBe('array');
    if (v4.kind === 'array') {
      expect(valOf(v4.v[0]!)).toBe(100);    // 60m bar0 close
      expect(valOf(v4.v[1]!)).toBe(99.5);   // 60m bar0 open = close-0.5
    }
  });

  it('input.timeframe var as tf arg resolves statically and prefetches', async () => {
    const tfVar = assign('mytf', call(member(ident('input'), 'timeframe'), str('60')));
    const body = [tfVar, assign('x', security(str(''), ident('mytf'), ident('close')))];
    const { values, fetched, warnings } = await runSecurity(body, chart, '15', { '|60': tf60 });
    expect(fetched).toEqual(['|60']);
    expect(warnings).toEqual([]);
    expect(values.map(valOf).slice(4, 8)).toEqual([100, 100, 100, 100]);
  });

  it('bare global var expr re-evaluates its producer in the tf context', async () => {
    const body = [
      assign('m', binary('*', ident('close'), num(2))),
      assign('x', security(str(''), str('60'), ident('m'))),
    ];
    const { values } = await runSecurity(body, chart, '15', { '|60': tf60 });
    expect(values.map(valOf).slice(4, 8)).toEqual([200, 200, 200, 200]);
  });

  it('global producer[n] reads tf history — na before first bar, prior bar afterwards', async () => {
    // g = close * 10 on the tf series; g[1] must read the PREVIOUS tf bar, and
    // be na when that bar does not exist (never the newest-loaded bar).
    const body = [
      assign('g', binary('*', ident('close'), num(10))),
      assign('x', security(str(''), str('60'), histref(ident('g'), num(1)))),
    ];
    const { values } = await runSecurity(body, chart, '15', { '|60': tf60 });
    const got = values.map(valOf);
    expect(got.slice(0, 4)).toEqual(['na', 'na', 'na', 'na']);     // no completed tf bar
    expect(got.slice(4, 8)).toEqual(['na', 'na', 'na', 'na']);     // bar0 has no prior
    expect(got.slice(8, 12)).toEqual([1000, 1000, 1000, 1000]);    // bar0 g = 100*10
  });

  it('UDF expression evaluates in the tf frame and caches per tf bar', async () => {
    let calls = 0;
    const tick: Value = {
      kind: 'function',
      v: () => { calls++; return mkVal(42); },
    };
    const udf: UdfDecl = {
      name: 'f', params: [{ name: 'a' }],
      body: binary('+', ident('a'), ident('close')), closure: new Scope(),
    };
    const body = [assign('x', security(str(''), str('60'), call(ident('f'), num(7))))];
    const { values } = await runSecurity(body, chart, '15', { '|60': tf60 },
      scope => { scope.define('f', { kind: 'function', v: udf }); scope.define('tick', tick); });
    expect(values.map(valOf).slice(4, 8)).toEqual([107, 107, 107, 107]); // 7 + 100
    expect(values.map(valOf).slice(8, 12)).toEqual([207, 207, 207, 207]); // 7 + 200
  });

  it('evaluates the security expr once per tf bar (cache)', async () => {
    let calls = 0;
    const count: Value = { kind: 'function', v: () => { calls++; return mkVal(calls); } };
    const body = [assign('x', security(str(''), str('60'), call(ident('count'))))];
    await runSecurity(body, chart, '15', { '|60': tf60 },
      scope => scope.define('count', count));
    expect(calls).toBe(2); // tf bars 0 and 1 only; last tf bar never completes
  });

  it('dynamic tf that was not prefetched warns once and returns na', async () => {
    const body = [assign('x', security(str(''), member(ident('timeframe'), 'period'), ident('close')))];
    const { values, warnings } = await runSecurity(body, chart, '15', {});
    expect(values.every(v => v.kind === 'na')).toBe(true);
    expect(warnings.filter(w => w.includes('not prefetched'))).toHaveLength(1);
  });
});

describe('request.security regression fixes', () => {
  beforeEach(resetMtf);

  const M15 = 900_000, H1 = 3_600_000;

  it('g[1] never leaks the newest-loaded tf bar into window builtins', async () => {
    // g = ta.sma(close,2); g[1] must evaluate sma at tf bar j-1, not read
    // the already-loaded bar j inside the window (future leak).
    // tf closes 0,100,200 → sma@0 na, sma@1 = 50, sma@2 = 150 → g[1]@j2 = 50.
    const chartBars = mkBars(20, M15, 0);
    const tf60 = mkBars(4, H1, 0, i => i * 100);
    const body = [
      assign('g', call(member(ident('ta'), 'sma'), ident('close'), num(2))),
      assign('x', security(str(''), str('60'), histref(ident('g'), num(1)))),
    ];
    const { values } = await runSecurity(body, chartBars, '15', { '|60': tf60 });
    const got = values.map(valOf);
    // j = completed 60m bar: bars 8-11 → j1 (g[1] → sma@0 = na),
    // 12-15 → j2 (g[1] → sma@1 = 50), 16-19 → j3 (g[1] → sma@2 = 150).
    // With the leak, j2 would read sma@2 = 150 from the loaded bar-3 window.
    expect(got.slice(0, 12)).toEqual(Array(12).fill('na'));
    expect(got.slice(12, 16)).toEqual([50, 50, 50, 50]);    // sma@1 = (0+100)/2
    expect(got.slice(16, 20)).toEqual([150, 150, 150, 150]); // sma@2 = (100+200)/2
  });

  it('security() inside a UDF resolves params against the live caller frame', async () => {
    // f(x) => request.security(sym, tf, x): x must bind per call —
    // f(close) and f(volume) on the same call node must not share bindings.
    const chartBars = mkBars(8, M15, 0);   // close i, volume 100+i
    const tf60 = mkBars(2, H1, 0, i => 10 + i);
    const fDecl: Node = {
      type: 'func', name: 'f', params: [{ name: 'x' }],
      body: security(str(''), str('60'), ident('x')),
    };
    const body = [
      fDecl,
      assign('a', call(ident('f'), ident('close'))),
      assign('b', call(ident('f'), ident('volume'))),
    ];
    resetMtf();
    const scope = new Scope();
    prepareSecurity(body);
    const warnings: string[] = [];
    const fetchSeries = async (_s: string, t: string): Promise<BarData[]> =>
      Promise.resolve(t === '60' ? tf60 : []);
    const ctx0 = mkCtx(chartBars, 0, '15', { fetchSeries, warnings });
    evalExpr(fDecl, { scope, ctx: ctx0 });   // bind `f` into the caller scope
    await prefetchSecurity(ctx0);

    // Drive like the interpreter: each chart bar evaluates both call sites.
    const gotA: (number | 'na')[] = [];
    const gotB: (number | 'na')[] = [];
    for (let i = 0; i < chartBars.length; i++) {
      const ctx = mkCtx(chartBars, i, '15', { fetchSeries, warnings });
      const frame = { scope, ctx };
      gotA.push(valOf(evalExpr(body[1]!, frame)));
      gotB.push(valOf(evalExpr(body[2]!, frame)));
    }
    // completed 60m bar0 for chart bars 4-7. The harness feeds plain `Series`
    // (not BarSeries), so caller-bound params resolve to the current chart
    // bar's value — distinct per caller is what this test pins down: the OLD
    // bug froze spec.scope to the first caller, so `x` stayed `close` for both.
    expect(gotA.slice(0, 4)).toEqual(['na', 'na', 'na', 'na']);
    expect(gotA.slice(4, 8)).toEqual([4, 5, 6, 7]);          // chart close
    expect(gotB.slice(4, 8)).toEqual([104, 105, 106, 107]);  // chart volume
    expect(gotA).not.toEqual(gotB);
  });

  it('chartDur uses nominal tf duration — a Fri→Mon gap does not stretch the lower window', async () => {
    // Daily chart bars Fri/Mon/Tue/Wed; security_lower_tf("60") must return
    // exactly the hourly bars of each day. With chartDur = t0−t1 the Monday
    // bar would span 72h and absorb Tuesday's and Wednesday's bars.
    const day = 86_400_000, fri = Date.UTC(2024, 0, 5); // 2024-01-05 Friday
    const dBars: BarData[] = [0, 3, 4, 5].map(d => ({
      openTime: fri + d * day, open: d, high: d + 1, low: d - 1, close: d, volume: d,
    }));
    const hourly: BarData[] = [];
    for (let h = 0; h < 144; h++) {
      hourly.push({ openTime: fri + h * H1, open: h, high: h, low: h, close: h, volume: h });
    }
    const body = [assign('x', call(member(ident('request'), 'security_lower_tf'),
      str(''), str('60'), ident('close')))];
    const { values } = await runSecurity(body, dBars, 'D', { '|60': hourly });
    const lens = values.map(v => (v.kind === 'array' ? v.v.length : -1));
    expect(lens).toEqual([24, 24, 24, 24]);
    // Monday's window holds Monday's 24 hourly bars (closes 72..95).
    const mon = values[1]!;
    expect(mon.kind).toBe('array');
    if (mon.kind === 'array') {
      expect(mon.v.map(valOf)).toEqual(Array.from({ length: 24 }, (_, k) => 72 + k));
    }
  });

  it('lookahead_on across a gap picks the bar containing the nominal bar end', async () => {
    // Daily chart Fri/Mon with D tf: Mon's lookahead bar must be the Monday
    // daily bar — not Wednesday's (which chartDur=3d would reach).
    const day = 86_400_000, fri = Date.UTC(2024, 0, 5);
    const dBars: BarData[] = [0, 3].map(d => ({
      openTime: fri + d * day, open: 0, high: 0, low: 0, close: 0, volume: 0,
    }));
    const dTf: BarData[] = [0, 3, 4, 5].map(d => ({
      openTime: fri + d * day, open: 0, high: 0, low: 0, close: 500 + d, volume: 0,
    }));
    const body = [assign('x', security(str(''), str('D'), ident('close'),
      member(ident('barmerge'), 'gaps_off'), member(ident('barmerge'), 'lookahead_on')))];
    const { values } = await runSecurity(body, dBars, 'D', { '|D': dTf });
    expect(valOf(values[0]!)).toBe(500);   // Fri end → Friday bar
    expect(valOf(values[1]!)).toBe(503);   // Mon end → Monday bar, not Wed's 505
  });

  it('var g := g + 1 replays per tf bar (top-level mutations honored)', async () => {
    // var g counts up once per tf bar; security(..., g) must read the replayed
    // counter, not the init value frozen at bar 0.
    const chartBars = mkBars(8, M15, 0);
    const tf60 = mkBars(2, H1, 0, i => 100 + i);
    const body = [
      { type: 'var', name: 'g', value: num(0) } as Node,
      { type: 'reassign', target: ident('g'), value: binary('+', ident('g'), num(1)) } as Node,
      assign('x', security(str(''), str('60'), ident('g'))),
    ];
    const { values } = await runSecurity(body, chartBars, '15', { '|60': tf60 });
    // tf bar0: g = 0+1 = 1; tf bar1: g = 1+1 = 2.
    expect(values.map(valOf).slice(4, 8)).toEqual([1, 1, 1, 1]);
  });

  it('eval errors warn with the expression source position', async () => {
    const chartBars = mkBars(8, M15, 0);
    const tf60 = mkBars(2, H1, 0);
    // `zz := 1` reassigns an undeclared name → pineErr throw inside evalAt.
    const boom: Node = {
      type: 'ifexpr', test: { type: 'bool', v: true } as Node,
      then: [{ type: 'reassign', target: ident('zz'), value: num(1) } as Node],
      elseIfs: [], else: null, loc: { line: 7, col: 3 },
    } as Node;
    const body = [assign('x', security(str(''), str('60'), boom))];
    const { values, warnings } = await runSecurity(body, chartBars, '15', { '|60': tf60 });
    expect(values.every(v => v.kind === 'na')).toBe(true);
    expect(warnings.some(w => w.includes('request.security eval error') && w.includes('line 7'))).toBe(true);
  });
});

// ── end-to-end through parse + runScript ────────────────────────────────────

describe('request.security end-to-end', () => {
  it('runs a real script: input.timeframe + security + plot', async () => {
    resetMtf();
    const src = [
      'indicator("mtf test", overlay=true)',
      'tf = input.timeframe("60", "HTF")',
      'h = request.security(syminfo.tickerid, tf, close)',
      '[c2, o2] = request.security(syminfo.tickerid, "60", [close, open])',
      'plot(h)',
      'plot(c2)',
    ].join('\n');
    const parsed = parse(src);
    expect(parsed.body.length).toBeGreaterThan(0);

    const M15 = 900_000, H1 = 3_600_000;
    const chartBars = mkBars(12, M15, 0);
    const tfBars = mkBars(3, H1, 0, i => 100 + i * 100);
    const fetched: string[] = [];
    const res = await runScript(parsed, chartBars, {
      timeframe: '15',
      fetchSeries: async (s, t) => { fetched.push(`${s}|${t}`); return t === '60' ? tfBars : []; },
    });
    expect(fetched.length).toBeGreaterThan(0);
    expect(res.warnings.filter(w => w.includes('security'))).toEqual([]);
    const plot = [...res.plots.values()][0];
    expect(plot).toBeDefined();
    const got = plot!.values.map(valOf);
    expect(got.slice(0, 4)).toEqual(['na', 'na', 'na', 'na']);
    expect(got.slice(4, 8)).toEqual([100, 100, 100, 100]);
    expect(got.slice(8, 12)).toEqual([200, 200, 200, 200]);
  });

  it('UDF bodies and nested global refs evaluate against the tf context, not the chart', async () => {
    resetMtf();
    const src = [
      'indicator("mtf ctx")',
      'f0() => close',
      'f1() => close[1]',
      'g = close * 10',
      'fg() => g',
      'a = close * 2',
      'b = a + 1',
      'r0 = request.security(syminfo.tickerid, "60", f0(), barmerge.gaps_off, barmerge.lookahead_off)',
      'r1 = request.security(syminfo.tickerid, "60", f1(), barmerge.gaps_off, barmerge.lookahead_off)',
      'r2 = request.security(syminfo.tickerid, "60", g + 1, barmerge.gaps_off, barmerge.lookahead_off)',
      'r3 = request.security(syminfo.tickerid, "60", b, barmerge.gaps_off, barmerge.lookahead_off)',
      'r4 = request.security(syminfo.tickerid, "60", fg(), barmerge.gaps_off, barmerge.lookahead_off)',
      'plot(r0, "r0")',
      'plot(r1, "r1")',
      'plot(r2, "r2")',
      'plot(r3, "r3")',
      'plot(r4, "r4")',
    ].join('\n');
    const M15 = 900_000, H1 = 3_600_000;
    // chart closes 1000..1011 → any chart-context leak is unmistakable
    const chartBars = mkBars(12, M15, 0, i => 1000 + i);
    const tfBars = mkBars(2, H1, 0, i => 100 + i * 10);   // tf closes 100, 110
    const res = await runScript(parse(src), chartBars, {
      timeframe: '15',
      fetchSeries: async (_s, t) => (t === '60' ? tfBars : []),
    });
    expect(res.warnings).toEqual([]);
    const col = (name: string): (number | 'na')[] => (res.plots.get(name)?.values ?? []).map(valOf);
    // completed tf index: -1 (bars 0-3), 0 (bars 4-7), 1 (bars 8-11)
    expect(col('r0').slice(0, 4)).toEqual(['na', 'na', 'na', 'na']);
    expect(col('r0').slice(4, 8)).toEqual([100, 100, 100, 100]);
    expect(col('r0').slice(8)).toEqual([110, 110, 110, 110]);
    expect(col('r1').slice(4, 8)).toEqual(['na', 'na', 'na', 'na']);   // tf bar0 has no prior
    expect(col('r1').slice(8)).toEqual([100, 100, 100, 100]);
    expect(col('r2').slice(4, 8)).toEqual([1001, 1001, 1001, 1001]);
    expect(col('r2').slice(8)).toEqual([1101, 1101, 1101, 1101]);
    expect(col('r3').slice(4, 8)).toEqual([201, 201, 201, 201]);
    expect(col('r3').slice(8)).toEqual([221, 221, 221, 221]);
    expect(col('r4').slice(4, 8)).toEqual([1000, 1000, 1000, 1000]);
    expect(col('r4').slice(8)).toEqual([1100, 1100, 1100, 1100]);
  });

  it('a dynamic tf that switches mid-run rebases the spec (no stale series)', async () => {
    resetMtf();
    const M5 = 300_000, H1 = 3_600_000;
    const chart = mkBars(50, M5, 0);
    const tf60 = mkBars(4, H1, 0, i => 100 + i);        // 60m closes 100..103
    const tf120 = mkBars(2, 2 * H1, 0, i => 900 + i);   // 120m closes 900, 901
    const fetchSeries = async (_s: string, t: string): Promise<BarData[]> => (t === '60' ? tf60 : tf120);
    // `sel` resolves to "60" for bars 0-35, then "120" — both tfs are prefetched.
    const sel = new BarSeries();
    for (let i = 0; i < chart.length; i++) sel.setAt(i, { kind: 'string', v: i < 36 ? '60' : '120' });
    const scope = new Scope();
    scope.define('sel', sel);
    const dynCall = security(str(''), ident('sel'), ident('close'));
    const body: Node[] = [
      assign('a', security(str(''), str('60'), ident('close'))),
      assign('b', security(str(''), str('120'), ident('close'))),
      assign('c', dynCall),
    ];
    prepareSecurity(body);
    await prefetchSecurity(mkCtx(chart, 0, '5', { fetchSeries }));
    const got: (number | 'na')[] = [];
    for (let i = 0; i < chart.length; i++) {
      const v = tryEvalSecurity(dynCall, { scope, ctx: mkCtx(chart, i, '5', { fetchSeries }) }) ?? NA;
      got.push(valOf(v));
    }
    expect(got.slice(0, 12)).toEqual(Array(12).fill('na'));       // 60m bar0 not yet complete
    expect(got.slice(12, 24)).toEqual(Array(12).fill(100));       // completed 60m bar0
    expect(got.slice(24, 36)).toEqual(Array(12).fill(101));       // completed 60m bar1
    expect(got.slice(36, 48)).toEqual(Array(12).fill(900));       // rebased to 120m: completed bar0
    expect(got.slice(48)).toEqual([901, 901]);                    // 120m bar1
  });

  it('without fetchSeries the chart bars themselves back the tf series', async () => {
    resetMtf();
    const src = [
      'indicator("no fetch")',
      'd = request.security(syminfo.tickerid, "15", close, barmerge.gaps_off, barmerge.lookahead_off)',
      'plot(d)',
    ].join('\n');
    const chartBars = mkBars(6, 900_000, 0, i => 10 + i);
    const res = await runScript(parse(src), chartBars, { timeframe: '15' });
    const values = [...res.plots.values()][0]!.values.map(valOf);
    expect(values).toEqual(['na', 10, 11, 12, 13, 14]);
  });
});
