// ── pinetsStatefulA (B3 tier) tests ─────────────────────────────────────────
// 24 ported ta.* methods. registerPortedTa() overwrites same-named builtins;
// originals are captured first and restored after.
//
// Parity verdicts per method (documented divergences below):
//   atr, bb, cci*, change, cmo, cross, crossover, crossunder, cum, dev,
//   highest, lowest, linreg(offset=0)  — bar-for-bar vs the original builtin.
//   (*cci: flat-window → ported 0 vs builtin na — unreachable in WAVY data.)
//   bbw        — pinets ×100 vs builtin fraction: parity holds at 100× scale.
//   highestbars, lowestbars — parity on tie-free data; ties → ported picks the
//                OLDEST equal bar (TradingView), builtin the newest.
//   ema        — seeding divergence: pinets SMA-seeds at bar `length-1`, the
//                builtin recurs from bar 0. Semantic test instead of parity.
//   dmi, kc    — same SMA-vs-recursive seeding gap (and bar-0 tr in kc's span);
//                semantic tests.
//   kcw        — canonical scalar width: builtin `ta.kcw` now computes
//                (upper-lower)/basis of EMA kc (bb/bbw convention; `ta.kcW`
//                stays the WMA tuple). The port overwrites with identical
//                semantics — verified against ported ta.kc below.
//   accdist, alma, barssince, falling — no existing builtin: smoke tests.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../builtins';
import { BUILTINS } from '../builtins/registry';
import { Series } from '../contracts';
import type { BarData, BuiltinCtx, BuiltinFn, Value } from '../contracts';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { registerPortedTa } from '../pinetsShim';
import '../pinetsStatefulA';

const mkBars = (n: number, gen?: (i: number) => Partial<BarData>): BarData[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: i * 60000,
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1000 + i * 10,
    ...(gen ? gen(i) : {}),
  }));

// Wiggly data: no flat windows, no equal-value ties.
const WAVY = mkBars(40, (i) => ({
  open: 100 + i,
  high: 102 + i + (i % 3),
  low: 99 + i - (i % 2),
  close: 100 + i + (i % 5) - (i % 3),
}));

// Strictly descending — highestbars finds the max at the oldest edge,
// lowestbars at the newest, and no ties exist anywhere.
const DESC = mkBars(30, (i) => ({
  open: 200 - i,
  high: 202 - i,
  low: 199 - i,
  close: 200 - i,
}));
// Strictly ascending close (crosses a level exactly once).
const ASC = mkBars(30, (i) => ({
  open: 100 + i,
  high: 102 + i,
  low: 99 + i,
  close: 100 + i,
}));

function newCtx(bars: BarData[]): BuiltinCtx {
  return {
    barIndex: -1,
    barCount: bars.length,
    open: new Series(), high: new Series(), low: new Series(), close: new Series(),
    volume: new Series(), time: new Series(),
    hl2: new Series(), hlc3: new Series(), ohlc4: new Series(), hlcc4: new Series(),
    plots: [], drawings: [], warnings: [], alerts: [], logs: [],
    syminfo: {},
    timeframe: { period: '1', multiplier: 1, isseconds: false, isminutes: true, isdaily: false, isweekly: false, ismonthly: false, isintraday: true },
    callUdf: () => { throw new Error('no udf in tests'); },
  };
}

function pushBar(ctx: BuiltinCtx, b: BarData, i: number): void {
  ctx.barIndex = i;
  ctx.open.set({ kind: 'float', v: b.open });
  ctx.high.set({ kind: 'float', v: b.high });
  ctx.low.set({ kind: 'float', v: b.low });
  ctx.close.set({ kind: 'float', v: b.close });
  ctx.volume.set({ kind: 'float', v: b.volume });
  ctx.time.set({ kind: 'int', v: b.openTime });
}

function runBars(bars: BarData[], fn: (ctx: BuiltinCtx) => Value): Value[] {
  const ctx = newCtx(bars);
  const out: Value[] = [];
  for (let i = 0; i < bars.length; i++) {
    pushBar(ctx, bars[i]!, i);
    out.push(fn(ctx));
  }
  return out;
}

const numv = (v: Value): number =>
  v.kind === 'int' || v.kind === 'float' ? v.v : NaN;
const boolv = (v: Value): boolean => v.kind === 'bool' && v.v;
const ser = (s: Series): Value => ({ kind: 'series', v: s });
const iv = (n: number): Value => ({ kind: 'int', v: n });
const fv = (n: number): Value => ({ kind: 'float', v: n });

const call = (name: string, c: BuiltinCtx, args: Value[]): Value =>
  BUILTINS.get(`ta.${name}`)!(c, args, {});

/** Bar-for-bar equality between the original builtin and the ported impl. */
function parity(name: string, bars: BarData[], mkArgs: (c: BuiltinCtx) => Value[], opts?: { scale?: number; tuple?: boolean }): void {
  const origFn = orig.get(name)!;
  const a = runBars(bars, (c) => origFn(c, mkArgs(c), {}));
  const b = runBars(bars, (c) => call(name, c, mkArgs(c)));
  for (let i = 0; i < bars.length; i++) {
    if (opts?.tuple) {
      const av0 = a[i]!, bv0 = b[i]!;
      expect(bv0.kind, `${name}[${i}] kind`).toBe(av0.kind);
      if (av0.kind === 'array') {
        const av = av0.v;
        const bv = bv0.kind === 'array' ? bv0.v : [];
        expect(bv.length).toBe(av.length);
        for (let k = 0; k < av.length; k++) {
          if (av[k]!.kind === 'na') expect(bv[k]!.kind, `${name}[${i}][${k}]`).toBe('na');
          else expect(numv(bv[k]!)).toBeCloseTo(numv(av[k]!) * (opts?.scale ?? 1), 8);
        }
      }
      continue;
    }
    if (a[i]!.kind === 'na') {
      expect(b[i]!.kind, `${name}[${i}]`).toBe('na');
    } else if (a[i]!.kind === 'bool') {
      expect(boolv(b[i]!), `${name}[${i}]`).toBe(boolv(a[i]!));
    } else {
      expect(numv(b[i]!), `${name}[${i}]`).toBeCloseTo(numv(a[i]!) * (opts?.scale ?? 1), 8);
    }
  }
}

let orig: Map<string, BuiltinFn | undefined>;
beforeAll(() => {
  orig = registerPortedTa();
});
afterAll(() => {
  for (const [name, fn] of orig) {
    if (fn) BUILTINS.set(`ta.${name}`, fn);
  }
});

describe('pinetsStatefulA — parity vs displaced builtins', () => {
  it('ta.atr ported == builtin bar-for-bar', () => {
    // Both seed an SMA of tr over the first `length` bars.
    parity('atr', WAVY, () => [iv(5)]);
  });

  it('ta.bb ported == builtin bar-for-bar ([basis, upper, lower])', () => {
    parity('bb', WAVY, (c) => [ser(c.close), iv(10), iv(2)], { tuple: true });
  });

  it('ta.bbw ported == builtin × 100 (pinets percent scale)', () => {
    // Documented: pinets returns (2·dev/basis)·100, the builtin the raw fraction.
    // Both emit na while the window is underfilled.
    parity('bbw', WAVY, (c) => [ser(c.close), iv(10), iv(2)], { scale: 100 });
  });

  it('ta.cci ported == builtin bar-for-bar (no flat windows in WAVY)', () => {
    // Documented divergence not exercised here: a flat window yields ported 0
    // (upstream "avoid division by zero") vs builtin na.
    parity('cci', WAVY, (c) => [ser(c.close), iv(10)]);
  });

  it('ta.change ported == builtin bar-for-bar (explicit and default length)', () => {
    parity('change', WAVY, (c) => [ser(c.close), iv(3)]);
    // ta.change(src) — length defaults to 1 on both sides (shim guard in the port).
    parity('change', WAVY, (c) => [ser(c.close)]);
  });

  it('ta.cmo ported == builtin bar-for-bar', () => {
    parity('cmo', WAVY, (c) => [ser(c.close), iv(9)]);
  });

  it('ta.cross/crossover/crossunder ported == builtin bar-for-bar', () => {
    // close crosses the constant level 115 exactly once in ASC (close goes
    // 100→129); ported prev-pair walk == builtin bar-1 compare with no na data.
    for (const name of ['cross', 'crossover', 'crossunder'] as const) {
      parity(name, ASC, (c) => [ser(c.close), fv(115)]);
    }
  });

  it('ta.cum ported == builtin bar-for-bar', () => {
    parity('cum', WAVY, (c) => [ser(c.close)]);
  });

  it('ta.dev ported == builtin bar-for-bar', () => {
    parity('dev', WAVY, (c) => [ser(c.close), iv(10)]);
  });

  it('ta.highest/ta.lowest ported == builtin bar-for-bar (source form)', () => {
    parity('highest', WAVY, (c) => [ser(c.close), iv(5)]);
    parity('lowest', WAVY, (c) => [ser(c.close), iv(5)]);
  });

  it('ta.highest(n)/ta.lowest(n) one-arg form == builtin', () => {
    // Both impls treat a scalar first arg as length over high/low.
    parity('highest', WAVY, () => [iv(4)]);
    parity('lowest', WAVY, () => [iv(4)]);
  });

  it('ta.highestbars/ta.lowestbars ported == builtin on tie-free data', () => {
    // Documented divergence on ties: ported keeps the OLDEST equal bar
    // (`>=`/`<=` scanning newest→oldest, TradingView semantics), the builtin
    // returns the first (newest) match. DESC/ASC have no ties.
    parity('highestbars', DESC, (c) => [ser(c.close), iv(5)]);
    parity('lowestbars', DESC, (c) => [ser(c.close), iv(5)]);
    // Sanity: strict descent → oldest bar of the window is the max.
    const r = runBars(DESC, (c) => call('highestbars', c, [ser(c.close), iv(5)]));
    expect(numv(r[10]!)).toBe(-4);
    const rl = runBars(DESC, (c) => call('lowestbars', c, [ser(c.close), iv(5)]));
    expect(numv(rl[10]!)).toBeCloseTo(0, 8); // -0 under Object.is; value-equal 0
  });

  it('ta.linreg ported == builtin at offset 0 (documented offset sign divergence)', () => {
    // offset=0: both evaluate intercept+slope·(L-1). For offset≠0 the builtin
    // projects forward (-offset), pinets evaluates bars back (+offset).
    parity('linreg', WAVY, (c) => [ser(c.close), iv(10), iv(0)]);
  });
});

describe('pinetsStatefulA — documented divergences', () => {
  it('ta.ema: pinets SMA-seeds at bar length-1, builtin recurs from bar 0', () => {
    const origEma = orig.get('ema')!;
    const a = runBars(WAVY, (c) => origEma(c, [ser(c.close), iv(5)], {}));
    const b = runBars(WAVY, (c) => call('ema', c, [ser(c.close), iv(5)]));
    // builtin emits from bar 0; ported emits first at bar 4 — different series.
    expect(numv(a[0]!)).toBeCloseTo(WAVY[0]!.close, 8);
    expect(b[0]!.kind).toBe('na');
    expect(b[3]!.kind).toBe('na');
    // First ported value = SMA of the first 5 closes.
    const sma5 = WAVY.slice(0, 5).reduce((s, x) => s + x.close, 0) / 5;
    expect(numv(b[4]!)).toBeCloseTo(sma5, 8);
    // From there the ported series is a self-consistent EMA (α = 2/(5+1)).
    const alpha = 2 / 6;
    const expected = alpha * WAVY[5]!.close + (1 - alpha) * sma5;
    expect(numv(b[5]!)).toBeCloseTo(expected, 8);
  });

  it('ta.dmi: ported emits [+di, −di, adx]; seeds shifted one bar vs builtin', () => {
    const res = runBars(WAVY, (c) => call('dmi', c, [iv(5), iv(5)]));
    // Bars 0..4: na tuple (bar 0 has no prev bar; then 5 bars seed).
    for (let i = 0; i < 5; i++) {
      const v = res[i]!;
      if (v.kind !== 'array') throw new Error(`dmi[${i}] not tuple`);
      for (const e of v.v) expect(e!.kind).toBe('na');
    }
    // Bar 5: first finite +di/−di; adx still na (needs 5 dx values).
    const first = res[5]!;
    if (first.kind !== 'array') throw new Error('dmi[5] not tuple');
    const [p, m, adx] = first.v;
    expect(Number.isFinite(numv(p!))).toBe(true);
    expect(Number.isFinite(numv(m!))).toBe(true);
    expect(adx!.kind).toBe('na');
    // DIs are non-negative and sum ≤ 100.
    expect(numv(p!)).toBeGreaterThanOrEqual(0);
    expect(numv(m!)).toBeGreaterThanOrEqual(0);
    expect(numv(p!) + numv(m!)).toBeLessThanOrEqual(100 + 1e-9);
    // First finite adx at bar 5 + 5 - 1 = 9.
    const at9 = res[9]!;
    if (at9.kind !== 'array') throw new Error('dmi[9] not tuple');
    expect(Number.isFinite(numv(at9.v[2]!))).toBe(true);
    expect(numv(at9.v[2]!)).toBeGreaterThanOrEqual(0);
    expect(numv(at9.v[2]!)).toBeLessThanOrEqual(100);
  });

  it('ta.kc: ported emits [basis, upper, lower] once both EMAs seed', () => {
    const res = runBars(WAVY, (c) => call('kc', c, [ser(c.close), iv(5), fv(2)]));
    // useTrueRange → span is na on bar 0, so rangeEma seeds at bar 5 and the
    // first finite tuple lands one bar later than the builtin's.
    const na = res[4]!;
    if (na.kind !== 'array') throw new Error('kc[4] not tuple');
    for (const e of na.v) expect(e!.kind).toBe('na');
    const v5 = res[5]!;
    if (v5.kind !== 'array') throw new Error('kc[5] not tuple');
    const [basis, upper, lower] = v5.v;
    expect(Number.isFinite(numv(basis!))).toBe(true);
    // upper ≥ basis ≥ lower invariant.
    expect(numv(upper!)).toBeGreaterThanOrEqual(numv(basis!));
    expect(numv(basis!)).toBeGreaterThanOrEqual(numv(lower!));
    // basis at bar 5 = first EMA step off the SMA-5 seed: α·close₅+(1−α)·sma₅
    // with α = 2/(5+1) → (2·sma5 + close5)/3.
    const sma5 = WAVY.slice(0, 5).reduce((s, x) => s + x.close, 0) / 5;
    expect(numv(basis!)).toBeCloseTo((2 * sma5 + WAVY[5]!.close) / 3, 8);
  });

  it('ta.kcw: pinets scalar width = (upper−lower)/basis of ported ta.kc', () => {
    // Documented mismatch: existing ta.kcw is TV's kcW (WMA tuple). The port
    // returns the scalar width — verify it against ported kc's own bands.
    const kcRes = runBars(WAVY, (c) => call('kc', c, [ser(c.close), iv(5), fv(2)]));
    const kcwRes = runBars(WAVY, (c) => call('kcw', c, [ser(c.close), iv(5), fv(2)]));
    for (let i = 0; i < WAVY.length; i++) {
      const t = kcRes[i]!;
      if (t.kind !== 'array') throw new Error('kc not tuple');
      const [b, u, l] = t.v;
      if (b!.kind === 'na') {
        expect(kcwRes[i]!.kind, `kcw[${i}]`).toBe('na');
      } else {
        const width = (numv(u!) - numv(l!)) / numv(b!);
        expect(numv(kcwRes[i]!), `kcw[${i}]`).toBeCloseTo(width, 8);
      }
    }
  });
});

describe('pinetsStatefulA — no-builtin smoke tests', () => {
  it('ta.accdist accumulates the CLV-weighted volume', () => {
    const res = runBars(WAVY, (c) => call('accdist', c, []));
    let expected = 0;
    for (let i = 0; i < WAVY.length; i++) {
      const b = WAVY[i]!;
      const range = b.high - b.low;
      const term = range !== 0 ? ((b.close - b.low) - (b.high - b.close)) / range * b.volume : 0;
      expected += term;
      expect(numv(res[i]!), `accdist[${i}]`).toBeCloseTo(expected, 8);
    }
  });

  it('ta.alma: hand-checked Gaussian-weighted mean', () => {
    const L = 5, off = 0.85, sig = 6;
    const res = runBars(WAVY, (c) => call('alma', c, [ser(c.close), iv(L), fv(off), fv(sig)]));
    for (let i = 0; i < L - 1; i++) expect(res[i]!.kind).toBe('na');
    // Weights: m = off·(L-1), s = L/sig, w[i]=exp(−(i−m)²/(2s²)), i 0=oldest.
    const m = off * (L - 1), s = L / sig;
    const w = Array.from({ length: L }, (_, i) => Math.exp(-Math.pow(i - m, 2) / (2 * s * s)));
    const wsum = w.reduce((a, b) => a + b, 0);
    for (const i of [4, 10, 39]) {
      let acc = 0;
      for (let k = 0; k < L; k++) acc += (w[k]! / wsum) * WAVY[i - (L - 1 - k)]!.close;
      expect(numv(res[i]!), `alma[${i}]`).toBeCloseTo(acc, 8);
    }
  });

  it('ta.barssince counts bars since the condition was true (via runScript)', async () => {
    // ASC closes are 100..129, so `close <= 101` is true on bars 0 AND 1:
    // barssince = 0 on both, then counts up from bar 2.
    const src = `indicator("t")\nplot(ta.barssince(close <= 101), "bs")\n`;
    const r = await runScript(parse(src), ASC, { symbol: 'T', timeframe: '1' });
    const vals = r.plots.get('bs')!.values;
    for (let i = 0; i < ASC.length; i++) {
      expect(numv(vals[i]!), `barssince[${i}]`).toBe(i <= 1 ? 0 : i - 1);
    }
  });

  it('ta.falling: true only after `length` consecutive declines', () => {
    const res = runBars(DESC, (c) => call('falling', c, [ser(c.close), iv(3)]));
    // Strictly descending: falling(3) first true at bar 3 (three declines: 0→1→2→3).
    for (let i = 0; i < DESC.length; i++) {
      expect(boolv(res[i]!), `falling[${i}]`).toBe(i >= 3);
    }
    // And never true on ascending data.
    const up = runBars(ASC, (c) => call('falling', c, [ser(c.close), iv(3)]));
    for (const v of up) expect(boolv(v)).toBe(false);
  });
});

describe('pinetsStatefulA — reachable from scripts', () => {
  it('ported ema/highest/crossover work via runScript', async () => {
    const src = [
      `indicator("t")`,
      `plot(ta.ema(close, 5), "e")`,
      `plot(ta.highest(4), "h")`,
      `plot(ta.crossover(close, 105) ? 1 : 0, "x")`,
    ].join('\n');
    const r = await runScript(parse(src), WAVY, { symbol: 'T', timeframe: '1' });
    const e = r.plots.get('e')!.values;
    const h = r.plots.get('h')!.values;
    const x = r.plots.get('x')!.values;
    // Same seeded EMA as the direct-builtin check above.
    const sma5 = WAVY.slice(0, 5).reduce((s, b) => s + b.close, 0) / 5;
    expect(e[3]!.kind).toBe('na');
    expect(numv(e[4]!)).toBeCloseTo(sma5, 8);
    // ta.highest(4) = rolling max of last 4 highs (one-arg form through the shim).
    for (const i of [3, 20]) {
      const mx = Math.max(...WAVY.slice(i - 3, i + 1).map((b) => b.high));
      expect(numv(h[i]!)).toBeCloseTo(mx, 8);
    }
    // WAVY close crosses 105 upward at least once.
    expect(x.some((v) => numv(v) === 1)).toBe(true);
  });
});
