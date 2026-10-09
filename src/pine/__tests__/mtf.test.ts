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
    expect(fetched).toEqual(['TEST|60']); // CHART_SYM resolves to ctx.syminfo.tickerid (F3)
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
    // tf arg is a scope-only ident — the frameless prefetch can't resolve it,
    // so it stays dynamic and the eval-time (sym, tf) pair has no fetched bars.
    const body = [assign('x', security(str(''), ident('dyn_tf'), ident('close')))];
    const { values, warnings } = await runSecurity(body, chart, '15', {},
      scope => scope.define('dyn_tf', { kind: 'string', v: '120' }));
    expect(values.every(v => v.kind === 'na')).toBe(true);
    expect(warnings.filter(w => w.includes('not prefetched'))).toHaveLength(1);
  });

  it('sync-throw fetchSeries degrades to na instead of rejecting prefetch (F9)', async () => {
    resetMtf();
    const body = [assign('x', security(str('AAA'), str('60'), ident('close')))];
    prepareSecurity(body);
    const warnings: string[] = [];
    const syncThrow = (_s: string, _t: string): Promise<BarData[]> => { throw new Error('sync'); };
    const bars = mkBars(12, 900_000, 0);
    // Pre-fix: the throw escaped prefetchSecurity's await → whole call rejects.
    await expect(
      prefetchSecurity(mkCtx(bars, 0, '15', { fetchSeries: syncThrow, warnings })),
    ).resolves.toBeUndefined();
    const callNode = findSecurityCall(body)!;
    const scope = new Scope();
    const v = tryEvalSecurity(callNode, { scope, ctx: mkCtx(bars, 5, '15', { fetchSeries: syncThrow, warnings }) });
    expect(v?.kind).toBe('na');
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
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.agHits - a0).toBeGreaterThanOrEqual(6);
    // Outer call node + producer arrow both gated → ≤ 2 evals per tf bar.
    expect(__mtfStats.evals - e0).toBeLessThanOrEqual(6);
    // Pin the served value: tf60 closes are 100/200/300.
    expect(values.map(valOf).slice(4, 8)).toEqual([100, 100, 100, 100]);
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
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 },
      scope => scope.define('p', mkVal(7)));
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
    expect(__mtfStats.evals - e0).toBeGreaterThanOrEqual(12); // per-caller path
    // Rejected → per-caller eval still resolves p from the caller scope.
    expect(values.map(valOf).slice(4, 8)).toEqual([7, 7, 7, 7]);
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
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 },
      scope => scope.define('p', mkVal(7)));
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
    expect(values.map(valOf).slice(4, 8)).toEqual([7, 7, 7, 7]);
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
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 },
      scope => scope.define('p', mkVal(7)));
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
    expect(__mtfStats.evals - e0).toBeGreaterThanOrEqual(12);
    // Omitted arg → default p=7 evaluated per caller.
    expect(values.map(valOf).slice(4, 8)).toEqual([7, 7, 7, 7]);
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
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.agHits - a0).toBeGreaterThanOrEqual(6);
    expect(__mtfStats.evals - e0).toBeLessThanOrEqual(6);
    // q()+q() = 2*close → 200 on completed tf bar0.
    expect(values.map(valOf).slice(4, 8)).toEqual([200, 200, 200, 200]);
  });

  it('self-recursive param default f = (x = f) => x terminates — no stack overflow', async () => {
    // inStack must mark the UDF decl BEFORE its param defaults walk (QA7
    // P1): the default `f` re-enters udfSafe(f) and used to recurse
    // forever. Now the on-stack decl rejects → gateFail, finite. The call
    // passes x explicitly so the RUNTIME never evaluates the default.
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const fDecl = {
      type: 'func', name: 'f',
      params: [{ name: 'x', default: ident('f') }],
      body: ident('x'),
    } as Node;
    const body = [
      fDecl,
      assign('x', security(str(''), str('60'), call(ident('f'), num(0)))),
    ];
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(1); // one gated node, one verdict
    expect(__mtfStats.gatePass - p0).toBe(0); // verdict consistent: always reject
    expect(values).toHaveLength(12);          // run completed — no overflow
  });

  it('mutual param defaults f ↔ g ping-pong terminates — no stack overflow', async () => {
    // f = (x = g()) => x; g = (y = f()) => y: f's default enters g, whose
    // default re-enters f — the shared inStack cuts the ping-pong on the
    // second visit instead of overflowing (QA7 P1).
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const fDecl = {
      type: 'func', name: 'f',
      params: [{ name: 'x', default: call(ident('g')) }],
      body: ident('x'),
    } as Node;
    const gDecl = {
      type: 'func', name: 'g',
      params: [{ name: 'y', default: call(ident('f')) }],
      body: ident('y'),
    } as Node;
    const body = [
      fDecl, gDecl,
      assign('x', security(str(''), str('60'), call(ident('f'), num(0)))),
    ];
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(1);
    expect(__mtfStats.gatePass - p0).toBe(0); // consistent reject, no overflow
    expect(values).toHaveLength(12);
  });

  it('two gated exprs sharing one producer dedup via spec prodVerdicts', async () => {
    // security's arraylit expr splits into TWO gated nodes; both reach q's
    // producer. prodVerdicts now lives on the spec (QA7 P3) so the second
    // gate walk reuses the first's verdict — both must still pass.
    const e0 = __mtfStats.evals, a0 = __mtfStats.agHits, f0 = __mtfStats.gateFail, w0 = __mtfStats.prodWalks;
    const arrow: Node = { type: 'arrow', params: [], body: ident('close') };
    const body = [
      assign('q', arrow),
      assign('x', security(str(''), str('60'),
        { type: 'arraylit', items: [call(ident('q')), call(ident('q'))] } as Node)),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.agHits - a0).toBeGreaterThanOrEqual(6);
    expect(__mtfStats.evals - e0).toBeLessThanOrEqual(12);
    expect(__mtfStats.prodWalks - w0).toBe(1); // two gated exprs → one producer walk (spec hoist)
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
  it(':= on a var-declared name inside a UDF body rejects — shared slot', async () => {
    // ctr() => var c = -1; c := c + 1 (QA11): `var` names used to land in
    // `bound` like ordinary locals, so the reassign passed — but var slots
    // are persistent callsite-keyed RunState slots whose mutation count
    // differs by how often the node evaluated. The agnostic cache would
    // dedupe what must stay per-caller (divergence.mjs T2).
    const f0 = __mtfStats.gateFail;
    const ctr = {
      type: 'func', name: 'ctr', params: [],
      body: [
        { type: 'var', name: 'c', value: num(-1) } as Node,
        { type: 'reassign', target: ident('c'), value: binary('+', ident('c'), num(1)) } as Node,
        ident('c'),
      ],
    } as Node;
    const body = [
      ctr,
      assign('x', security(str(''), str('60'), call(ident('ctr')))),
    ];
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
    // Rejected → each per-caller eval draws the next counter value; a
    // shared agnostic entry would pin every chart bar of a tf bar to the
    // same draw (≤3 distinct over the run). Per-caller draws differ.
    expect(new Set(values.slice(4).map(valOf)).size).toBeGreaterThanOrEqual(4);
  });

  it('read-only var inside a UDF body still passes — slot reads are caller-independent', async () => {
    // var v = close; v: the init evaluates once and every caller sees the
    // same slot at tf bar j — only var MUTATION count differs by caller,
    // so a read-only var body is agnostic-safe.
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const rd = {
      type: 'func', name: 'rd', params: [],
      body: [
        { type: 'var', name: 'v', value: ident('close') } as Node,
        ident('v'),
      ],
    } as Node;
    const body = [
      rd,
      assign('x', security(str(''), str('60'), call(ident('rd')))),
    ];
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.gatePass - p0).toBeGreaterThanOrEqual(1);
    // var v = close inits once → constant 100 (tf60 bar0 close) everywhere.
    expect(values.map(valOf).slice(4, 8)).toEqual([100, 100, 100, 100]);
  });

  it('var + := inside an if-arm block still rejects', async () => {
    // Var decls are legal inside if/switch/seq arm blocks; the varBound
    // set must thread into arm walks the same way bound does.
    const f0 = __mtfStats.gateFail;
    const f = {
      type: 'func', name: 'f', params: [],
      body: [
        {
          type: 'if', test: { type: 'bool', v: true } as Node,
          then: [
            { type: 'var', name: 'c', value: num(0) } as Node,
            { type: 'reassign', target: ident('c'), value: binary('+', ident('c'), num(1)) } as Node,
            ident('c'),
          ],
          elseIfs: [], else: null,
        } as Node,
      ],
    } as Node;
    const body = [
      f,
      assign('x', security(str(''), str('60'), call(ident('f')))),
    ];
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
    // Same escape channel as the flat-body case: per-caller draws differ.
    expect(new Set(values.slice(4).map(valOf)).size).toBeGreaterThanOrEqual(4);
  });

  it('UDF param default reaching a var-mutating callee rejects', async () => {
    // f = (x = ctr()) => x: the default walks with the call-site bound;
    // ctr's body mutates a var slot → reject through the default edge.
    const f0 = __mtfStats.gateFail;
    const ctr = {
      type: 'func', name: 'ctr', params: [],
      body: [
        { type: 'var', name: 'c', value: num(-1) } as Node,
        { type: 'reassign', target: ident('c'), value: binary('+', ident('c'), num(1)) } as Node,
        ident('c'),
      ],
    } as Node;
    const fDecl = {
      type: 'func', name: 'f',
      params: [{ name: 'x', default: call(ident('ctr')) }],
      body: ident('x'),
    } as Node;
    const body = [
      ctr, fDecl,
      assign('x', security(str(''), str('60'), call(ident('f')))),
    ];
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
    expect(values).toHaveLength(12); // rejected → per-caller path still evaluates
  });

  it(':= through a member target on a var-bound root rejects — shared slot object', async () => {
    // `var t = …; t.v := v` — the member target used to take the plain
    // read-safety walk (t is bound → pass), but the write mutates the object
    // held by the persistent var slot — same non-idempotence as `t :=` (QA13).
    const f0 = __mtfStats.gateFail;
    const f = {
      type: 'func', name: 'wrt', params: [],
      body: [
        { type: 'var', name: 't', value: arraylit([num(0)]) } as Node,
        { type: 'reassign', target: member(ident('t'), 'v'),
          value: binary('+', member(ident('t'), 'v'), num(1)) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      f,
      assign('x', security(str(''), str('60'), call(ident('wrt')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it(':= through an index target on a var-bound root rejects — shared slot object', async () => {
    // `var a = [0]; a[0] := a[0] + 1` — index-write on the var slot's array
    // is shared across callers under the agnostic cache (QA13).
    const f0 = __mtfStats.gateFail;
    const f = {
      type: 'func', name: 'wri', params: [],
      body: [
        { type: 'var', name: 'a', value: arraylit([num(0)]) } as Node,
        { type: 'reassign', target: histref(ident('a'), num(0)),
          value: binary('+', histref(ident('a'), num(0)), num(1)) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      f,
      assign('x', security(str(''), str('60'), call(ident('wri')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it(':= through an index target on an expr-local binding still passes', async () => {
    // `a = [0]; a[0] := …` — `a` binds inside the gated subtree (non-var),
    // so the mutated object is created fresh per eval: caller-independent
    // → agnostic-safe (the member/index pass branch of QA13). Reads use
    // array.get — `a[0]` on a series-held array is series-history syntax.
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const f = {
      type: 'func', name: 'locw', params: [],
      body: [
        assign('a', arraylit([num(0)])),
        { type: 'reassign', target: histref(ident('a'), num(0)),
          value: binary('+',
            call(member(ident('array'), 'get'), ident('a'), num(0)), num(1)) } as Node,
        call(member(ident('array'), 'get'), ident('a'), num(0)),
      ],
    } as Node;
    const body = [
      f,
      assign('x', security(str(''), str('60'), call(ident('locw')))),
    ];
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.gatePass - p0).toBeGreaterThanOrEqual(1);
    expect(values.map(valOf).slice(4, 8)).toEqual([1, 1, 1, 1]); // a[0]=0 → 1
  });

  it('loop var re-bound over an outer var name un-shadows varBound', async () => {
    // `var c = 0; for c = 0 to 5 { c := c+1 }` — the loop-local c is a
    // non-var binding that shadows the outer var slot, so `c :=` inside
    // the body writes a per-eval slot → agnostic-safe (QA13 P3).
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const f = {
      type: 'func', name: 'shad', params: [],
      body: [
        { type: 'var', name: 'c', value: num(0) } as Node,
        {
          type: 'for', varName: 'c', from: num(0), to: num(5),
          body: [
            { type: 'reassign', target: ident('c'),
              value: binary('+', ident('c'), num(1)) } as Node,
          ],
        } as Node,
        ident('c'),
      ],
    } as Node;
    const body = [
      f,
      assign('x', security(str(''), str('60'), call(ident('shad')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.gatePass - p0).toBeGreaterThanOrEqual(1);
  });

  it('index := through a non-var ALIAS of shared state rejects — u=a', async () => {
    // `var a=[0]; u=a; u[0]:=…` — `u` is bound non-var, but its initializer
    // is an ident so the binding ALIASES the persistent var slot's array.
    // 'bound non-var root is safe' was wrong here; only provably fresh
    // roots pass now (QA15 P2).
    const f0 = __mtfStats.gateFail;
    const f = {
      type: 'func', name: 'aliasw', params: [],
      body: [
        { type: 'var', name: 'a', value: arraylit([num(0)]) } as Node,
        assign('u', ident('a')),
        { type: 'reassign', target: histref(ident('u'), num(0)),
          value: binary('+',
            call(member(ident('array'), 'get'), ident('u'), num(0)), num(1)) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      f,
      assign('x', security(str(''), str('60'), call(ident('aliasw')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it('index := on a UDF PARAM rejects — the param aliases the caller argument', async () => {
    // `g(x) => x[0] := x[0]+1` called as g(a) mutates the array the CALLER
    // passed in — a param root is bound-but-never-fresh (QA15 P2).
    const f0 = __mtfStats.gateFail;
    const g = {
      type: 'func', name: 'g',
      params: [{ name: 'x' }],
      body: [
        { type: 'reassign', target: histref(ident('x'), num(0)),
          value: binary('+',
            call(member(ident('array'), 'get'), ident('x'), num(0)), num(1)) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      { type: 'var', name: 'a', value: arraylit([num(0)]) } as Node,
      g,
      assign('x', security(str(''), str('60'), call(ident('g'), ident('a')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it('index := on a fresh arraylit binding still passes — expr-local object', async () => {
    // `u = [0]; u[0] := …` — u is bound by a provably fresh initializer in
    // the same subtree, so the mutated array is created per eval (QA15 P2).
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const f = {
      type: 'func', name: 'freshw', params: [],
      body: [
        assign('u', arraylit([num(0)])),
        { type: 'reassign', target: histref(ident('u'), num(0)),
          value: binary('+',
            call(member(ident('array'), 'get'), ident('u'), num(0)), num(1)) } as Node,
        call(member(ident('array'), 'get'), ident('u'), num(0)),
      ],
    } as Node;
    const body = [
      f,
      assign('x', security(str(''), str('60'), call(ident('freshw')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.gatePass - p0).toBeGreaterThanOrEqual(1);
  });

  it('param shadowing a var name un-shadows varBound — := writes the param slot', async () => {
    // `var c = 0; h = (c) => c := c + 1` INSIDE a gated UDF — the arrow's
    // param c deletes c from the copied varBound, so `c :=` writes the
    // param slot, not the persistent var slot (QA15 P3). Declaring (not
    // calling) the arrow exercises this: the gate walks decl bodies, and
    // a bound callee would reject under the closure rule. (The var decl
    // must be inside the gated body — at top level the producerSafe walk
    // would see varBound = ∅ and exercise nothing.)
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const g = {
      type: 'func', name: 'pshadow', params: [],
      body: [
        { type: 'var', name: 'c', value: num(0) } as Node,
        assign('h', {
          type: 'arrow', params: [{ name: 'c' }],
          body: { type: 'reassign', target: ident('c'),
                  value: binary('+', ident('c'), num(1)) } as Node,
        } as Node),
      ],
    } as Node;
    const body = [
      g,
      assign('x', security(str(''), str('60'), call(ident('pshadow')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.gatePass - p0).toBeGreaterThanOrEqual(1);
  });

  it('non-var decl inside an if arm shadows the outer var — := writes the local slot', async () => {
    // `var c = 0; if ok → c = 9; c := c + 1` — the inner non-var decl
    // rebinds `c`, so it must leave varBound for the rest of that block
    // (QA15 P3).
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const f = {
      type: 'func', name: 'shdecl', params: [],
      body: [
        { type: 'var', name: 'c', value: num(0) } as Node,
        {
          type: 'if', test: { type: 'bool', v: true } as Node,
          then: [
            assign('c', num(9)),
            { type: 'reassign', target: ident('c'),
              value: binary('+', ident('c'), num(1)) } as Node,
          ],
          elseIfs: [], else: null,
        } as Node,
        ident('c'),
      ],
    } as Node;
    const body = [
      f,
      assign('x', security(str(''), str('60'), call(ident('shdecl')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.gatePass - p0).toBeGreaterThanOrEqual(1);
  });

  it('index := on a for-in element rejects — element aliases the iterated array', async () => {
    // `for c in a → c[0] := …` — a for-in var aliases an element of the
    // caller-visible array `a`, so it is bound-but-not-fresh → reject
    // (QA15 P2 for-in alias class).
    const f0 = __mtfStats.gateFail;
    const f = {
      type: 'func', name: 'forinw', params: [],
      body: [
        {
          type: 'for', varName: 'c',
          from: { type: 'ident', name: '<for-in>' } as Node,
          to: ident('a'),
          body: [
            { type: 'reassign', target: histref(ident('c'), num(0)),
              value: num(0) } as Node,
          ],
        } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      { type: 'var', name: 'a', value: arraylit([arraylit([num(0)])]) } as Node,
      f,
      assign('x', security(str(''), str('60'), call(ident('forinw')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it(':= rebind of a fresh root to a param rejects — u := p writes through', async () => {
    // `u = [0]; u := p; u[0] := …` — the ident rebind passed the gate (u is
    // a bound non-var local), but the write-through makes u's slot alias the
    // caller-visible param array. u stayed `fresh`, so `u[0] :=` used to
    // mutate the caller's persistent var array under the agnostic cache
    // (QA17). The rebind must drop the root's fresh eligibility.
    const f0 = __mtfStats.gateFail;
    const g = {
      type: 'func', name: 'rebindw', params: [{ name: 'p' }],
      body: [
        assign('u', arraylit([num(0)])),
        { type: 'reassign', target: ident('u'), value: ident('p') } as Node,
        { type: 'reassign', target: histref(ident('u'), num(0)), value: num(99) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      { type: 'var', name: 'a', value: arraylit([num(0)]) } as Node,
      g,
      assign('x', security(str(''), str('60'), call(ident('rebindw'), ident('a')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it('arm-nested := rebind rejects — the rebind persists after the block', async () => {
    // `u = [0]; if ok → u := p; u[0] := …` — the arm walks a COPY of the
    // tracking sets; a naive `fresh.delete` in that copy leaves the parent's
    // u fresh. Runtime `:=` writes through to the ancestor slot, so the
    // rebind survives the arm: rebound marks merge upward (QA17).
    const f0 = __mtfStats.gateFail;
    const g = {
      type: 'func', name: 'armw', params: [{ name: 'p' }],
      body: [
        assign('u', arraylit([num(0)])),
        {
          type: 'if', test: { type: 'bool', v: true } as Node,
          then: [{ type: 'reassign', target: ident('u'), value: ident('p') } as Node],
          elseIfs: [], else: null,
        } as Node,
        { type: 'reassign', target: histref(ident('u'), num(0)), value: num(99) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      { type: 'var', name: 'a', value: arraylit([num(0)]) } as Node,
      g,
      assign('x', security(str(''), str('60'), call(ident('armw'), ident('a')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it('rebound before an arm-local shadow still escapes — u[0] := after rejects', async () => {
    // `u = [0]; if c → u := p; u = [9]; … u[0] :=` — the `=` re-decl shadows
    // for POST-decl marks, but the `u := p` BEFORE it wrote through to the
    // outer slot, so parent's u stays bound to p after the arm. A merge that
    // swallows pre-shadow rebound marks leaves u `fresh` → u[0] := passes
    // and mutates the caller's `a` under the agnostic cache (CR3 hole).
    const f0 = __mtfStats.gateFail;
    const g = {
      type: 'func', name: 'shrebind', params: [{ name: 'p' }],
      body: [
        assign('u', arraylit([num(0)])),
        {
          type: 'if', test: { type: 'bool', v: true } as Node,
          then: [
            { type: 'reassign', target: ident('u'), value: ident('p') } as Node,
            assign('u', arraylit([num(9)])),
          ],
          elseIfs: [], else: null,
        } as Node,
        { type: 'reassign', target: histref(ident('u'), num(0)), value: num(99) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      { type: 'var', name: 'a', value: arraylit([num(0)]) } as Node,
      g,
      assign('x', security(str(''), str('60'), call(ident('shrebind'), ident('a')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it('= re-decl inside an arm shadows — outer fresh root stays eligible', async () => {
    // `u = [0]; if c → u = [9]` — `=` is scope.define: the arm's u is a NEW
    // arm-local slot, not a rebind of the outer u. After the arm, `u[0] :=`
    // still writes the outer fresh array → agnostic-safe (QA17 shadow rule).
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const g = {
      type: 'func', name: 'shadw', params: [],
      body: [
        assign('u', arraylit([num(0)])),
        {
          type: 'if', test: { type: 'bool', v: true } as Node,
          then: [assign('u', arraylit([num(9)]))],
          elseIfs: [], else: null,
        } as Node,
        { type: 'reassign', target: histref(ident('u'), num(0)), value: num(1) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      g,
      assign('x', security(str(''), str('60'), call(ident('shadw')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.gatePass - p0).toBeGreaterThanOrEqual(1);
  });

  it('index := on an un-rebound fresh root still passes — regression', async () => {
    // `u = [0]; u[0] := 1` — plain member/index write on a fresh root with
    // no intervening rebind stays agnostic-safe (QA17 must not regress it).
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const g = {
      type: 'func', name: 'plainw', params: [],
      body: [
        assign('u', arraylit([num(0)])),
        { type: 'reassign', target: histref(ident('u'), num(0)), value: num(1) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      g,
      assign('x', security(str(''), str('60'), call(ident('plainw')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.gatePass - p0).toBeGreaterThanOrEqual(1);
  });

  it('nested index := on a fresh container rejects — element may alias shared state', async () => {
    // `u = [p]; u[0][0] := 42` — u is a fresh container but its ELEMENT
    // aliases the caller's var-held array p; the depth-2 target writes
    // through u[0] into shared state. The gate counts chain depth rather
    // than tracking element freshness, so this rejects (H2).
    const f0 = __mtfStats.gateFail;
    const g = {
      type: 'func', name: 'nestw', params: [{ name: 'p' }],
      body: [
        assign('u', arraylit([ident('p')])),
        { type: 'reassign', target: histref(histref(ident('u'), num(0)), num(0)),
          value: num(42) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      { type: 'var', name: 'a', value: arraylit([num(7)]) } as Node,
      g,
      assign('x', security(str(''), str('60'), call(ident('nestw'), ident('a')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it('nested index := rejects even with a literal element — conservative depth rule', async () => {
    // `u = [0]; u[0][0] := 1` — the element is a plain int here (the write
    // would throw at runtime → warns + na), but the gate counts depth, not
    // element freshness, so depth ≥ 2 still rejects (H2).
    const f0 = __mtfStats.gateFail;
    const g = {
      type: 'func', name: 'nestlit', params: [],
      body: [
        assign('u', arraylit([num(0)])),
        { type: 'reassign', target: histref(histref(ident('u'), num(0)), num(0)),
          value: num(1) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      g,
      assign('x', security(str(''), str('60'), call(ident('nestlit')))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it('member := on a fresh root is single-level — gate still passes', async () => {
    // `u = [0]; u.f := 1` — a single member step on a fresh root writes the
    // container's own slot; the depth limit only cuts depth ≥ 2 (H2). The
    // verdict is structural — field validity at runtime is irrelevant here.
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const g = {
      type: 'func', name: 'memw', params: [],
      body: [
        assign('u', arraylit([num(0)])),
        { type: 'reassign', target: member(ident('u'), 'f'), value: num(1) } as Node,
        num(0),
      ],
    } as Node;
    const body = [
      g,
      assign('x', security(str(''), str('60'), call(ident('memw')))),
    ];
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.gatePass - p0).toBeGreaterThanOrEqual(1);
    // Runtime can't evaluate u.f on an arraylit → warns and serves na; the
    // gate verdict itself is structural (field validity is irrelevant to it).
    expect(values.map(valOf).slice(4, 8)).toEqual(['na', 'na', 'na', 'na']);
  });

  it('var multi-decl components bind as var — read passes, := rejects', async () => {
    // `var a = 1, b = 2` (VarDecl.multi): every component must land in
    // varBound — a missed component reads unbound → reject; a missed var
    // mark lets `b :=` pass while mutating the persistent slot.
    const f = {
      type: 'func', name: 'vm', params: [],
      body: [
        { type: 'var', name: 'a', value: num(1),
          multi: [{ name: 'a', value: num(1) }, { name: 'b', value: num(2) }] } as Node,
        ident('b'),
      ],
    } as Node;
    const body = [
      f,
      assign('x', security(str(''), str('60'), call(ident('vm')))),
    ];
    const p0 = __mtfStats.gatePass, f0 = __mtfStats.gateFail;
    const { values } = await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBe(0);
    expect(__mtfStats.gatePass - p0).toBeGreaterThanOrEqual(1);
    expect(values.map(valOf).slice(4, 8)).toEqual([2, 2, 2, 2]);

    const wr = {
      type: 'func', name: 'vmw', params: [],
      body: [
        { type: 'var', name: 'a', value: num(1),
          multi: [{ name: 'a', value: num(1) }, { name: 'b', value: num(2) }] } as Node,
        { type: 'reassign', target: ident('b'), value: num(9) } as Node,
        ident('b'),
      ],
    } as Node;
    const f1 = __mtfStats.gateFail;
    await runTransient([wr, assign('x', security(str(''), str('60'), call(ident('vmw'))))],
      chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f1).toBeGreaterThanOrEqual(1);
  });

  it('global producer with := writes is unsafe — producerSafe rejects', async () => {
    // g read at top level then rewritten with := — writes.length>0 means
    // the producer's value depends on evaluation order → reject (R38).
    const f0 = __mtfStats.gateFail;
    const body = [
      assign('g', num(1)),
      { type: 'reassign', target: ident('g'), value: binary('+', ident('g'), num(1)) } as Node,
      assign('x', security(str(''), str('60'), ident('g'))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it('switch inside a gated expr walks every arm — caller ident arm rejects', async () => {
    // R21: subject + case tests + arms all walk. An arm referencing a
    // caller binding must fail the whole expr.
    const f0 = __mtfStats.gateFail;
    const sw: Node = {
      type: 'switch', subject: num(1),
      cases: [
        { test: num(1), body: [ident('p')] },
        { body: [ident('close')] },
      ],
    } as Node;
    const body = [assign('x', security(str(''), str('60'), sw))];
    await runTransient(body, chart, '15', { '|60': tf60 },
      scope => scope.define('p', mkVal(7)));
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
  });

  it('nested request.* call inside the gated expr rejects — direct form', async () => {
    // R7: a request.* member callee anywhere in the expr rejects. The
    // producer-side variant lives in mtf_invariance (N4/divergence T4).
    const f0 = __mtfStats.gateFail;
    const body = [
      assign('x', security(str(''), str('60'),
        binary('+', security(str(''), str('15'), ident('close')), num(1)))),
    ];
    await runTransient(body, chart, '15', { '|60': tf60 });
    expect(__mtfStats.gateFail - f0).toBeGreaterThanOrEqual(1);
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

  it('break inside a ctx.callUdf UDF errors — no silent truncation of an enclosing loop', async () => {
    // QA13: a method dispatched through spec.ctx.callUdf (invokeUdf) whose
    // body contains an escaping `break` used to rethrow the raw BREAK symbol.
    // Inside a `for` in the same security expr the enclosing evalFor would
    // ABSORB it as a normal break — silently truncating the loop. invokeUdf
    // now converts it to PineRuntimeError like callUdfValue (QA10/QA11).
    registerMethod({
      type: 'method', name: 'boomP3', selfType: 'int',
      params: [{ name: 'self', typeAnn: 'int' }],
      body: [{ type: 'break' } as Node, num(0)],
    });
    const chartBars = mkBars(8, M15, 0);
    const tf60 = mkBars(2, H1, 0, i => 10 + i);
    const loop: Node = {
      type: 'for', varName: 'i', from: num(0), to: num(3),
      body: [call(member(num(1), 'boomP3'))],
    };
    const body = [
      assign('x', security(str(''), str('60'), loop)),
    ];
    const { values, warnings } = await runSecurity(body, chartBars, '15', { '|60': tf60 });
    // The converted error surfaces via evalAt's warn-and-na — the loop is
    // NOT silently truncated by absorbing the raw signal.
    expect(warnings.some(w => /'break' outside loop in function 'int\.boomP3'/.test(w))).toBe(true);
    expect(values.every(v => v.kind === 'na')).toBe(true);
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
  it('security_lower_tf pads missing lower bars with na (nominal slot count)', async () => {
    // Chart 15m, lower tf 5m → 3 nominal slots per chart bar. Chart bar0's
    // window has only slots 0 and 2 populated; slot 1 must emit na instead of
    // shrinking the array.
    const m5 = 300_000;
    const chartBars = mkBars(3, M15, 0);
    const tf5: BarData[] = [
      // bar0 window [0, 15m): slots at 0,5,10 — bar at 5m missing
      { openTime: 0, open: 0, high: 1, low: -1, close: 100, volume: 1 },
      { openTime: 2 * m5, open: 0, high: 1, low: -1, close: 102, volume: 1 },
      // bar1 window [15m, 30m): all three slots present
      { openTime: 3 * m5, open: 0, high: 1, low: -1, close: 103, volume: 1 },
      { openTime: 4 * m5, open: 0, high: 1, low: -1, close: 104, volume: 1 },
      { openTime: 5 * m5, open: 0, high: 1, low: -1, close: 105, volume: 1 },
      // bar2 window [30m, 45m): no bars at all → all na
    ];
    const body = [assign('x', call(member(ident('request'), 'security_lower_tf'),
      str(''), str('5'), ident('close')))];
    const { values } = await runSecurity(body, chartBars, '15', { '|5': tf5 });
    const cell = (i: number): (number | 'na')[] =>
      values[i]!.kind === 'array' ? values[i]!.v.map(valOf) : [];
    expect(cell(0)).toEqual([100, 'na', 102]);
    expect(cell(1)).toEqual([103, 104, 105]);
    expect(cell(2)).toEqual(['na', 'na', 'na']);   // empty window still emits 3 slots
  });

  it('security_lower_tf tuple expr pads na per slot', async () => {
    const m5 = 300_000;
    const chartBars = mkBars(1, M15, 0);
    const tf5: BarData[] = [
      { openTime: 0, open: 10, high: 1, low: -1, close: 100, volume: 1 },
      { openTime: 2 * m5, open: 30, high: 1, low: -1, close: 102, volume: 1 },
    ];
    const body = [assign('x', call(member(ident('request'), 'security_lower_tf'),
      str(''), str('5'), arraylit([ident('close'), ident('open')])))] ;
    const { values } = await runSecurity(body, chartBars, '15', { '|5': tf5 });
    const arr = values[0]!;
    expect(arr.kind).toBe('array');
    if (arr.kind !== 'array') return;
    expect(arr.v.length).toBe(3);
    const [e0, e1, e2] = arr.v;
    expect(e0!.kind === 'array' ? (e0 as { kind: 'array' }).v.map(valOf) : []).toEqual([100, 10]);
    expect(e1!.kind).toBe('na');                   // missing slot → na, not an inner array
    expect(e2!.kind === 'array' ? (e2 as { kind: 'array' }).v.map(valOf) : []).toEqual([102, 30]);
  });

  it('security_lower_tf shares the fetchSeries pipeline — one fetch for the ltf key', async () => {
    const m5 = 300_000;
    const chartBars = mkBars(2, M15, 0);
    const tf5 = mkBars(6, m5, 0, i => 50 + i);
    const body = [assign('x', call(member(ident('request'), 'security_lower_tf'),
      str(''), str('5'), ident('close')))];
    const { values, fetched } = await runSecurity(body, chartBars, '15', { '|5': tf5 });
    expect(fetched).toEqual(['TEST|5']);           // single prefetch, no per-bar refetch
    const cell = (i: number): (number | 'na')[] =>
      values[i]!.kind === 'array' ? values[i]!.v.map(valOf) : [];
    expect(cell(0)).toEqual([50, 51, 52]);
    expect(cell(1)).toEqual([53, 54, 55]);
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

  it('input.timeframe override flows into security tf arg (F4)', async () => {
    resetMtf();
    const src = [
      'indicator("t")',
      'tfIn = input.timeframe("60", "Timeframe")',
      'x = request.security("AAA", tfIn, close)',
      'plot(x)',
    ].join('\n');
    const fetched: string[] = [];
    await runScript(parse(src), mkBars(12, 900_000, 0), {
      timeframe: '15',
      fetchSeries: async (s, t) => { fetched.push(`${s}|${t}`); return []; },
      inputValues: { Timeframe: '15' },
    });
    expect(fetched).toContain('AAA|15'); // override wins, not the "60" defval
    expect(fetched).not.toContain('AAA|60');
  });

  it('security(syminfo.tickerid, tf, expr) fetches the chart ticker, not "" (F3)', async () => {
    const body = [
      assign('x', security(member(ident('syminfo'), 'tickerid'), str('60'), ident('close'))),
    ];
    const { values, fetched } = await runSecurity(body, mkBars(12, 900_000, 0), '15', { 'TEST|60': mkBars(3, 3_600_000, 0, i => 100 + i * 100) });
    expect(fetched).toContain('TEST|60');
    expect(fetched.every(s => !s.startsWith('|'))).toBe(true);
    expect(values.map(valOf).some(v => v !== 'na')).toBe(true);
  });

  it('security expr syminfo.tickerid resolves to the requested symbol (F5)', async () => {
    const body = [
      assign('x', security(str('OTHER'), str('60'), member(ident('syminfo'), 'tickerid'))),
    ];
    const { values } = await runSecurity(body, mkBars(12, 900_000, 0), '15',
      { 'OTHER|60': mkBars(3, 3_600_000, 0, i => 100 + i * 100) });
    // tf frame's syminfo is built from 'OTHER', not the chart's 'TEST'.
    const strs = values.filter((v): v is Extract<typeof v, { kind: 'string' }> => v.kind === 'string');
    expect(strs.map(v => v.v).includes('OTHER')).toBe(true);
    expect(strs.every(v => v.v !== 'TEST')).toBe(true);
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

  it('UDF callsites of the same security() keep separate [n] chart history', async () => {
    // f(x) wraps request.security: f(close) and f(volume) on one bar evaluate
    // the same spec under different caller scopes. chartHist/lastChartBar were
    // spec-scoped — caller-1 emitted, caller-2's emitAll deduped away, so
    // b[1] silently read caller-1's (close) history instead of its own.
    resetMtf();
    const src = [
      'indicator("sec hist")',
      // nz(x) returns {kind:'series'} for a series arg — a scalar expr would
      // bind a plain decl slot and never reach SecSeries/chartHist.
      'f(x) => request.security(syminfo.tickerid, "60", nz(x), barmerge.gaps_off, barmerge.lookahead_off)',
      'a = f(close)',
      'b = f(volume)',
      'plot(a[1], "a1")',
      'plot(b[1], "b1")',
    ].join('\n');
    const M15 = 900_000, H1 = 3_600_000;
    const chartBars = mkBars(8, M15, 0);                  // close i, volume 100+i
    const tfBars = mkBars(2, H1, 0, i => 10 + i);
    const res = await runScript(parse(src), chartBars, {
      timeframe: '15',
      fetchSeries: async (_s, t) => (t === '60' ? tfBars : []),
    });
    const col = (name: string): (number | 'na')[] => (res.plots.get(name)?.values ?? []).map(valOf);
    // Completed 60m bar0 for chart bars 4-7; [1] is the previous chart bar's
    // emission for THAT callsite.
    // nz's frozen-reader anchors on tf indexes inside the tf frame, so each
    // caller's series is a constant slice of its source — the point is that
    // b's [1] history carries B's emissions (100 = volume lane), not a's (0).
    expect(col('a1').slice(4, 8)).toEqual(['na', 0, 0, 0]);
    expect(col('b1').slice(4, 8)).toEqual(['na', 100, 100, 100]);
  });

  it('gaps_on: two UDF callsites of the same security() each get the mapped value', async () => {
    // lastEmit was spec-scoped: on every emit bar caller A ran first and set
    // lastEmit=j, so caller B's same-bar call hit the dedup → emitAll(NA) →
    // B returned na FOREVER (and its chart history filled with na). Pine
    // gives each callsite the mapped value; only the FOLLOWING chart bars
    // inside the tf bar emit na.
    resetMtf();
    const src = [
      'indicator("gaps_on callsites")',
      'f(x) => request.security(syminfo.tickerid, "60", nz(x), barmerge.gaps_on, barmerge.lookahead_off)',
      'a = f(close)',
      'b = f(volume)',
      'plot(a[1], "a1")',
      'plot(b, "b")',
      'plot(b[1], "b1")',
    ].join('\n');
    const M15 = 900_000, H1 = 3_600_000;
    const chartBars = mkBars(12, M15, 0);                 // close i, volume 100+i
    const tfBars = mkBars(2, H1, 0, i => 10 + i);
    const res = await runScript(parse(src), chartBars, {
      timeframe: '15',
      fetchSeries: async (_s, t) => (t === '60' ? tfBars : []),
    });
    const col = (name: string): (number | 'na')[] => (res.plots.get(name)?.values ?? []).map(valOf);
    // Completed 60m bar0 covers chart bars 4-7, bar1 covers 8-11. nz anchors
    // on tf indexes: tf bar j maps to chart[j] — B's lane is volume → 100/101,
    // not A's close lane (0/1) and not na (the pre-fix bug).
    // A bound security() result aliases the SecSeries whose cur() reads atTf
    // directly, so `b` forward-fills; the gaps_on na's land in the emit
    // history — visible through [1]: value only on the bar after an emit bar.
    expect(col('b')).toEqual(['na', 'na', 'na', 'na', 100, 100, 100, 100, 101, 101, 101, 101]);
    expect(col('a1')).toEqual(['na', 'na', 'na', 'na', 'na', 0, 'na', 'na', 'na', 1, 'na', 'na']);
    expect(col('b1')).toEqual(['na', 'na', 'na', 'na', 'na', 100, 'na', 'na', 'na', 101, 'na', 'na']);
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
