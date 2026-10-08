// ── mtf.ts tests ────────────────────────────────────────────────────────────
// Drives prepareSecurity → prefetchSecurity → tryEvalSecurity directly with
// hand-built AST + BuiltinCtx, so it exercises MTF semantics even before the
// interpreter lands (fallback evaluator path).

import { describe, expect, it, beforeEach } from 'vitest';
import type { BarData, BuiltinCtx, Node, Scope as ScopeT, UdfDecl, Value } from '../contracts';
import { NA, Scope, Series } from '../contracts';
import { BarSeries } from '../series';
import {
  prepareSecurity, prefetchSecurity, resetMtf, tfFloor, tfNext, tfToMs, tryEvalSecurity, __mtfStats,
} from '../mtf';
import { parse } from '../parser';
import { evalExpr, runScript } from '../interpreter';
import '../builtins'; // registers builtins for the e2e test
import { registerMethod } from '../udt';


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

describe('caller-agnostic eval cache', () => {
  beforeEach(resetMtf);
  const M15 = 900_000, H1 = 3_600_000;
  const chart = mkBars(12, M15, 0);
  const tf60 = mkBars(3, H1, 0, i => 100 + i * 100);

  /** Like runSecurity but each bar calls with a FRESH child scope — the same
   *  transient shape a UDF invocation produces (fresh callScope per bar). */
  async function runTransient(
    body: Node[], chartBars: BarData[], chartTf: string,
    fetchMap: Record<string, BarData[]>, extra?: (scope: ScopeT) => void,
  ): Promise<{ values: Value[]; warnings: string[] }> {
    resetMtf();
    const scope = new Scope();
    extra?.(scope);
    prepareSecurity(body);
    const warnings: string[] = [];
    const fetchSeries = async (s: string, t: string): Promise<BarData[]> =>
      fetchMap[`${s}|${t}`] ?? fetchMap[`|${t}`] ?? [];
    await prefetchSecurity(mkCtx(chartBars, 0, chartTf, { fetchSeries, warnings }));
    const values: Value[] = [];
    const callNode = findSecurityCall(body)!;
    for (let i = 0; i < chartBars.length; i++) {
      values.push(tryEvalSecurity(callNode,
        { scope: new Scope(scope), ctx: mkCtx(chartBars, i, chartTf, { fetchSeries, warnings }) }) ?? NA);
    }
    return { values, warnings };
  }

  it('caller-agnostic expr survives transient caller scopes (node,j cache)', async () => {
    // Before the agnostic cache every fresh scope looked unseen → nodeCache was
    // reset per bar → warmup replayed O(j) evals each bar. With the gate the
    // `close` expr caches per (node, j) and only j=0..1 ever compute.
    const e0 = __mtfStats.evals, h0 = __mtfStats.hits, a0 = __mtfStats.agHits;
    const body = [assign('x', security(str(''), str('60'), ident('close')))];
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(values.map(valOf).slice(4, 8)).toEqual([100, 100, 100, 100]);
    expect(values.map(valOf).slice(8, 12)).toEqual([200, 200, 200, 200]);
    expect(__mtfStats.evals - e0).toBeLessThanOrEqual(3);
    expect(__mtfStats.hits - h0).toBeGreaterThanOrEqual(6);
    expect(__mtfStats.agHits - a0).toBeGreaterThanOrEqual(6);
  });

  it('expr referencing a caller binding stays per-caller (gate rejects)', async () => {
    const e0 = __mtfStats.evals, f0 = __mtfStats.gateFail;
    const body = [assign('x', security(str(''), str('60'), ident('p')))];
    const a = await runTransient(body, chart, '15', { '|60': tf60 },
      scope => scope.define('p', mkVal(7)));
    const b = await runTransient(body, chart, '15', { '|60': tf60 },
      scope => scope.define('p', mkVal(9)));
    expect(valOf(a.values[4]!)).toBe(7);
    expect(valOf(b.values[4]!)).toBe(9);
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(2); // rejected in both runs
    // Per-caller path under a transient scope still recomputes (no agnostic).
    expect(__mtfStats.evals - e0).toBeGreaterThanOrEqual(12);
  });

  it('function-valued global callee scans the producer — free caller ident rejects', async () => {
    // q_fn = () => p: the callee ident is a file-level global holding a
    // function VALUE. Its body `p` resolves through PivotScope → callerScope,
    // so the gate must walk the producer and reject (QA1 finding — previously
    // the callee passed via S0 membership without scanning the body).
    const e0 = __mtfStats.evals, f0 = __mtfStats.gateFail;
    const arrow: Node = { type: 'arrow', params: [], body: ident('p') };
    const body = [
      assign('q_fn', arrow),
      assign('x', security(str(''), str('60'), call(ident('q_fn')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 },
      scope => scope.define('p', mkVal(7)));
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
    // Rejected → per-caller path under transient scopes recomputes every bar.
    expect(__mtfStats.evals - e0).toBeGreaterThanOrEqual(12);
  });

  it('function-valued global with no free idents still passes (producer walk)', async () => {
    // g = () => close: producer body's only ident is a chart series name —
    // caller-independent, so the gate walks it and passes (agnostic path).
    const e0 = __mtfStats.evals, a0 = __mtfStats.agHits;
    const arrow: Node = { type: 'arrow', params: [], body: ident('close') };
    const body = [
      assign('g', arrow),
      assign('x', security(str(''), str('60'), call(ident('g')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.agHits - a0).toBeGreaterThanOrEqual(6);
    // Outer call node + producer arrow both gated → ≤ 2 evals per tf bar.
    expect(__mtfStats.evals - e0).toBeLessThanOrEqual(6);
  });

  it('call through an expr-bound function param rejects', async () => {
    // (f => f()): the callee ident is bound inside the gated subtree as an
    // arrow param — its closure captures caller bindings → unsafe.
    const f0 = __mtfStats.gateFail;
    const arrow: Node = {
      type: 'arrow', params: [{ name: 'f' }], body: call(ident('f')),
    };
    const body = [assign('x', security(str(''), str('60'), arrow))];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it('producer referencing a global walks THAT producer — y = p rejects', async () => {
    // q = () => y; y = p: the producer walk used to pass `y`
    // via plain S0 membership (QA4 P1 #1 / QA6 P1) — a global inside a
    // producer chain must recurse into ITS producer, bound = ∅.
    const e0 = __mtfStats.evals, f0 = __mtfStats.gateFail;
    const arrow: Node = { type: 'arrow', params: [], body: ident('y') };
    const body = [
      assign('y', ident('p')),
      assign('q', arrow),
      assign('x', security(str(''), str('60'), call(ident('q')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 },
      scope => scope.define('p', mkVal(7)));
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
    expect(__mtfStats.evals - e0).toBeGreaterThanOrEqual(12); // per-caller path
  });

  it('global-alias chain q2 = q1 resolves transitively — rejects', async () => {
    // q2 = q1; q1 = () => p: a bare `ident` producer node used to pass via
    // S0 without resolving the chain (QA6 P1).
    const f0 = __mtfStats.gateFail;
    const arrow: Node = { type: 'arrow', params: [], body: ident('p') };
    const body = [
      assign('q1', arrow),
      assign('q2', ident('q1')),
      assign('x', security(str(''), str('60'), call(ident('q2')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 },
      scope => scope.define('p', mkVal(7)));
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it('UDF-alias param defaults walk the call-site bound — rejects', async () => {
    // f = (x = p) => x; q = f: the alias branch scanned the UDF body but
    // skipped param defaults (QA4 P1 #3) — an omitted arg evaluates the
    // default against the caller scope.
    const e0 = __mtfStats.evals, f0 = __mtfStats.gateFail;
    const fDecl = {
      type: 'func', name: 'f',
      params: [{ name: 'x', default: ident('p') }],
      body: ident('x'),
    } as Node;
    const body = [
      fDecl,
      assign('q', ident('f')),
      assign('x', security(str(''), str('60'), call(ident('q')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 },
      scope => scope.define('p', mkVal(7)));
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
    expect(__mtfStats.evals - e0).toBeGreaterThanOrEqual(12);
  });

  it('q() + q() shared producer passes — DAG dedup, no false cycle', async () => {
    // The same producer node is reached twice (QA4 P3): path-independent
    // producer walks must reuse the memoized verdict — only a node on the
    // recursion stack is a genuine cycle.
    const e0 = __mtfStats.evals, a0 = __mtfStats.agHits, f0 = __mtfStats.gateFail;
    const arrow: Node = { type: 'arrow', params: [], body: ident('close') };
    const body = [
      assign('q', arrow),
      assign('x', security(str(''), str('60'),
        binary('+', call(ident('q')), call(ident('q'))))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.agHits - a0).toBeGreaterThanOrEqual(6);
    expect(__mtfStats.evals - e0).toBeLessThanOrEqual(6);
  });

  it('array-returning agnostic expr still caches via the per-caller path', async () => {
    // Mutable-kind results skip only the SHARED agnostic write (QA6 P3):
    // the per-caller (node, caller, j) entry must still be written and
    // read, or the expr recomputes on every chart bar that maps to the
    // same tf bar. (arraylit wouldn't work — its elements split into
    // per-element exprs; array.new_float returns a real array value.)
    const e0 = __mtfStats.evals, a0 = __mtfStats.agHits;
    const body = [assign('x', security(str(''), str('60'),
      call(member(ident('array'), 'new_float'), num(0), ident('close'))))];
    // Stable caller scope → per-caller entries hit across chart bars.
    await runSecurity(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.agHits - a0).toBe(0);
    // Without the per-caller fallthrough this is ~10 evals (one per chart
    // bar mapped to a completed tf bar); cached it stays ≤ 4.
    expect(__mtfStats.evals - e0).toBeLessThanOrEqual(4);
  });

  it('dynamic tf switch drops agnostic values — recomputed on the new tf', async () => {
    const tf15 = mkBars(12, M15, 0, i => i * 10);
    const aCall = security(str(''), ident('tf'), ident('close'));
    const body = [
      assign('tf', { type: 'ternary', test: binary('>', ident('bar_index'), num(4)), cons: str('15'), alt: str('60') }),
      assign('a', aCall),
      assign('b', security(str(''), str('15'), ident('close'))), // prefetches '|15'
    ];
    resetMtf();
    const scope = new Scope();
    prepareSecurity(body);
    const warnings: string[] = [];
    const fetchSeries = async (_s: string, t: string): Promise<BarData[]> =>
      Promise.resolve(t === '15' ? tf15 : tf60);
    const ctx0 = mkCtx(chart, 0, '15', { fetchSeries, warnings });
    await prefetchSecurity(ctx0, { scope, ctx: ctx0 });
    const values: Value[] = [];
    for (let i = 0; i < chart.length; i++) {
      values.push(tryEvalSecurity(aCall,
        { scope: new Scope(scope), ctx: mkCtx(chart, i, '15', { fetchSeries, warnings }) }) ?? NA);
    }
    expect(warnings).toEqual([]);
    expect(valOf(values[3]!)).toBe('na');  // 60m bar0 still open at t0=2.7M
    expect(valOf(values[4]!)).toBe(100);   // 60m bar0 completes at t0=3.6M
    expect(valOf(values[5]!)).toBe(40);    // switched to 15m → recompute j=4
    expect(valOf(values[6]!)).toBe(50);
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

  it('series param := inside a ctx.callUdf UDF cannot mutate the caller series', async () => {
    // A method dispatched through spec.ctx.callUdf binds a `{kind:'series'}`
    // arg into a param slot. Without CowSeries the body's `s := …` writes
    // straight into spec.series.close — every later ident read in the SAME
    // spec sees the corrupted tf bar. Tuple [n.twist(close), close] pins it:
    // the second element must still read the unmutated tf close.
    registerMethod({
      type: 'method', name: 'twistP2', selfType: 'int',
      params: [{ name: 'self', typeAnn: 'int' }, { name: 's', typeAnn: 'series' }],
      body: [
        { type: 'reassign', target: ident('s'), value: binary('+', ident('s'), num(1)) } as Node,
        ident('s'),
      ],
    });
    const chartBars = mkBars(8, M15, 0);
    const tf60 = mkBars(2, H1, 0, i => 10 + i);
    const twist = call(member(num(1), 'twistP2'), ident('close'));
    const body = [
      assign('x', security(str(''), str('60'), arraylit([twist, ident('close')]))),
    ];
    const { values, warnings } = await runSecurity(body, chartBars, '15', { '|60': tf60 });
    const cell = (i: number): (number | 'na')[] =>
      values[i]!.kind === 'array' ? values[i]!.v.map(valOf) : [];
    expect(warnings).toEqual([]);
    for (let i = 4; i < 8; i++) expect(cell(i)).toEqual([11, 10]); // bumped copy, pristine close
  });

  it('security() inside a UDF stays consistent across bars (transient cache, no thrash)', async () => {
    // Each bar's UDF call allocates a fresh call scope. Caching evalAt results
    // under that ephemeral Scope object can never hit on the next bar — and a
    // STABLE key would be wrong (bindings differ per call). The cache now lives
    // per invocation; this pins the per-bar values a direct call produces.
    const chartBars = mkBars(8, M15, 0);   // close i
    const tf60 = mkBars(2, H1, 0, i => 10 + i);
    const fDecl: Node = {
      type: 'func', name: 'f', params: [{ name: 'x' }],
      body: security(str(''), str('60'), ident('x')),
    };
    const body = [
      fDecl,
      assign('a', call(ident('f'), ident('close'))),
    ];
    resetMtf();
    const scope = new Scope();
    prepareSecurity(body);
    const warnings: string[] = [];
    const fetchSeries = async (_s: string, t: string): Promise<BarData[]> =>
      Promise.resolve(t === '60' ? tf60 : []);
    evalExpr(fDecl, { scope, ctx: mkCtx(chartBars, 0, '15', { fetchSeries, warnings }) });
    await prefetchSecurity(mkCtx(chartBars, 0, '15', { fetchSeries, warnings }));
    const gotA: (number | 'na')[] = [];
    for (let i = 0; i < chartBars.length; i++) {
      const ctx = mkCtx(chartBars, i, '15', { fetchSeries, warnings });
      evalExpr(fDecl, { scope, ctx });
      gotA.push(valOf(evalExpr(body[1]!, { scope, ctx })));
    }
    // completed 60m bar0 for chart bars 4-7 → chart close at those bars.
    expect(gotA.slice(0, 4)).toEqual(['na', 'na', 'na', 'na']);
    expect(gotA.slice(4, 8)).toEqual([4, 5, 6, 7]);
    expect(warnings).toEqual([]);
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

  it('series-valued expr (ta.tr) does not leak the tf series — lookahead_off anchoring', async () => {
    // `ta.tr` resolves to a lazy FnSeries — a tf-context series returned as
    // {kind:'series'}. Returned verbatim it leaks tf-indexed history into the
    // chart frame; the wrap must re-anchor cur()/get(n) at the mapped tf bar j.
    // tr@0 na (no prev close); tr@k = max(2, |1-(-0.5)|, |−1-0.5|) + k*100 base.
    const chartBars = mkBars(16, M15, 0);
    const tf60 = mkBars(3, H1, 0, i => i * 100);
    const body = [assign('x', security(str(''), str('60'), member(ident('ta'), 'tr')))];
    const { values } = await runSecurity(body, chartBars, '15', { '|60': tf60 });
    const got = values.map(v => (v.kind === 'series' ? valOf(v.v.cur()) : valOf(v)));
    expect(got.slice(0, 8)).toEqual(Array(8).fill('na'));          // no completed bar / tr@0 = na
    expect(got.slice(8, 12)).toEqual([101, 101, 101, 101]); // tr@tf bar1
    expect(got.slice(12, 16)).toEqual([101, 101, 101, 101]); // tr@tf bar2
  });

  it('series-valued expr under lookahead_on reads the developing tf bar, not the loaded lastBar', async () => {
    // With the leak the chart read the tf series' newest-loaded slot — the
    // same value on every chart bar within a tf bar's range. After the wrap,
    // cur() is pinned to the developing bar j this chart bar maps to.
    const chartBars = mkBars(12, M15, 0);
    const tf60 = mkBars(3, H1, 0, i => i * 100);
    const body = [assign('x', security(str(''), str('60'), member(ident('ta'), 'tr'),
      member(ident('barmerge'), 'gaps_off'), member(ident('barmerge'), 'lookahead_on')))];
    const { values } = await runSecurity(body, chartBars, '15', { '|60': tf60 });
    const got = values.map(v => (v.kind === 'series' ? valOf(v.v.cur()) : valOf(v)));
    expect(got.slice(0, 4)).toEqual(['na', 'na', 'na', 'na']);      // developing bar0: tr needs prev close
    expect(got.slice(4, 8)).toEqual([101, 101, 101, 101]);  // developing bar1
    expect(got.slice(8, 12)).toEqual([101, 101, 101, 101]); // developing bar2
  });

  it('security(...)[n] on a series-valued expr reads CHART-domain history', async () => {
    // TV semantics: `[]` outside request.security() is chart-domain — the
    // previous chart bar's mapped value, flat within a tf period and stepping
    // only at the first chart bar of the new tf bar.
    // Layout: 15m chart, 60m tf. Completed-bar mapping (lookahead_off):
    //   chart 0-3 → j=-1 (na), 4-7 → j=0 (tr@0=na), 8-11 → j=1 (tr@1=101),
    //   12-15 → j=2 (tr@2=101).
    // Reads must happen INSIDE the loop: get(n) is newest-relative, and bars
    // sharing a tf period share one cached SecSeries — a post-loop read would
    // anchor every history read at the final bar.
    const chartBars = mkBars(16, M15, 0);
    const tf60 = mkBars(3, H1, 0, i => i * 100);
    const body = [assign('x', security(str(''), str('60'), member(ident('ta'), 'tr')))];
    resetMtf();
    const scope = new Scope();
    prepareSecurity(body);
    const warnings: string[] = [];
    const fetchSeries = async (_s: string, t: string): Promise<BarData[]> =>
      Promise.resolve(t === '60' ? tf60 : []);
    await prefetchSecurity(mkCtx(chartBars, 0, '15', { fetchSeries, warnings }));
    const callNode = findSecurityCall(body)!;
    const got: (number | 'na')[] = [];
    for (let i = 0; i < chartBars.length; i++) {
      const v = tryEvalSecurity(callNode,
        { scope, ctx: mkCtx(chartBars, i, '15', { fetchSeries, warnings }) }) ?? NA;
      got.push(v.kind === 'series' ? valOf(v.v.get(1)) : valOf(v));
    }
    // x[1] = emit of the previous chart bar (not previous tf bar).
    expect(got.slice(0, 8)).toEqual(Array(8).fill('na'));
    // bar 8: prev emit (bar7) = tr@0 = na; bars 9-11: prev emit = tr@1 = 101
    expect(got.slice(8, 12)).toEqual(['na', 101, 101, 101]);
    // bars 12-15: prev emit = tr@2 = 101
    expect(got.slice(12, 16)).toEqual([101, 101, 101, 101]);
  });

  it('security_lower_tf emits scalars for a series-valued expr', async () => {
    // Chart 15m, lower tf 5m: each chart bar spans 3 tf bars; the array
    // payload must carry per-lower-bar scalar tr values, not live tf series.
    const m5 = 300_000;
    const chartBars = mkBars(4, M15, 0);
    const tf5 = mkBars(12, m5, 0, i => 10 + i);
    const body = [assign('x', call(member(ident('request'), 'security_lower_tf'),
      str(''), str('5'), member(ident('ta'), 'tr')))];
    const { values } = await runSecurity(body, chartBars, '15', { '|5': tf5 });
    const cell = (i: number): (number | 'na')[] =>
      values[i]!.kind === 'array' ? values[i]!.v.map(valOf) : [];
    expect(cell(0)).toEqual(['na', 2, 2]);  // tr@0 na; tr@k = max(2, 2, 0) = 2
    expect(cell(1)).toEqual([2, 2, 2]);
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

  it('chart-gated security warms the tf frame — strict-window expr matches ungated', async () => {
    resetMtf();
    // barstate.islast gate: security evaluated only on the final chart bar.
    // Without warm-up the tf frame starts cold at j≈N-1 and ta.sma(close[1],20)
    // can never fill its window → na. After the fix the value equals the
    // ungated run (probe: scripts/dbg_mtf_cond_na.ts).
    const sec = 'request.security(syminfo.tickerid, "15", ta.sma(close[1], 20), barmerge.gaps_off, barmerge.lookahead_off)';
    const chartBars = mkBars(500, 60_000, 0, i => 100 + Math.sin(i / 10) * 5 + i * 0.1);
    const gated = await runScript(parse(`float v = barstate.islast ? ${sec} : na\nplot(v)`), chartBars, { symbol: 'T', timeframe: '1' });
    const plain = await runScript(parse(`float v = ${sec}\nplot(v)`), chartBars, { symbol: 'T', timeframe: '1' });
    const gLast = [...gated.plots.values()][0]!.values.at(-1)!;
    const pLast = [...plain.plots.values()][0]!.values.at(-1)!;
    expect(gLast.kind).not.toBe('na');
    expect(gLast.kind === 'na' || pLast.kind === 'na' ? 0 : Math.abs((gLast as { v: number }).v - (pLast as { v: number }).v)).toBeLessThan(1e-9);
  });

  it('chart-gated security warms stateful fns — ema does not return an unaudited seed', async () => {
    resetMtf();
    const sec = 'request.security(syminfo.tickerid, "15", ta.ema(close[1], 20), barmerge.gaps_off, barmerge.lookahead_off)';
    const chartBars = mkBars(500, 60_000, 0, i => 100 + Math.sin(i / 10) * 5 + i * 0.1);
    const gated = await runScript(parse(`float v = barstate.islast ? ${sec} : na\nplot(v)`), chartBars, { symbol: 'T', timeframe: '1' });
    const plain = await runScript(parse(`float v = ${sec}\nplot(v)`), chartBars, { symbol: 'T', timeframe: '1' });
    const gLast = [...gated.plots.values()][0]!.values.at(-1)!;
    const pLast = [...plain.plots.values()][0]!.values.at(-1)!;
    expect(gLast.kind).not.toBe('na');
    expect(gLast.kind === 'na' || pLast.kind === 'na' ? 0 : Math.abs((gLast as { v: number }).v - (pLast as { v: number }).v)).toBeLessThan(1e-9);
  });
});
