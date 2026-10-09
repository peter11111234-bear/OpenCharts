// ── pinetsShim (B3 spike) tests ─────────────────────────────────────────────
// The shim ports pinets-src ta methods into BuiltinFn shape. registerPortedTa
// OVERWRITES the production ta.tr/ta.rsi/ta.supertrend builtins for this file
// (registerBuiltin is a Map.set) — originals are captured first and restored
// after, so nothing leaks to other test files (vitest isolates modules per
// file anyway, belt & suspenders).
//
// Parity contract (plan Step 0): ported impls register under the SAME names
// because ta.tr/rsi/supertrend already exist — the test asserts ported output
// equals the existing builtin output bar-for-bar.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../builtins';
import { BUILTINS } from '../builtins/registry';
import { Series } from '../contracts';
import type { BarData, BuiltinCtx, BuiltinFn, Value } from '../contracts';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { registerPortedTa } from '../pinetsShim';

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

// Wiggly data so rsi windows are never all-flat (pinets returns 100 there;
// our builtin returns na on a no-move window — the documented divergence).
const WAVY = mkBars(40, (i) => ({
  open: 100 + i,
  high: 102 + i + (i % 3),
  low: 99 + i - (i % 2),
  close: 100 + i + (i % 5) - (i % 3),
}));

function newCtx(bars: BarData[]): BuiltinCtx {
  return {
    barIndex: -1,
    barCount: bars.length,
    open: new Series(), high: new Series(), low: new Series(), close: new Series(),
    volume: new Series(), time: new Series(),
    hl2: new Series(), hlc3: new Series(), ohlc4: new Series(), hlcc4: new Series(),
    plots: [], drawings: [], warnings: [], alerts: [],
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
const ser = (s: Series): Value => ({ kind: 'series', v: s });

let orig: Map<string, BuiltinFn | undefined>;
beforeAll(() => {
  orig = registerPortedTa();
});
afterAll(() => {
  for (const [name, fn] of orig) {
    if (fn) BUILTINS.set(`ta.${name}`, fn);
  }
});

describe('pinetsShim pilots', () => {
  it('ta.tr ported: hand-computed TR over 8 bars', () => {
    // pinets tr(handle_na=true default) returns high−low on bar 0 where
    // close[1] is na; our builtin now matches TV/pinets on every bar.
    const bars: BarData[] = [
      { openTime: 0, open: 10, high: 12, low: 8, close: 10, volume: 1 },
      { openTime: 1, open: 10, high: 15, low: 9, close: 14, volume: 1 },
      { openTime: 2, open: 14, high: 16, low: 13, close: 15, volume: 1 },
    ];
    const res = runBars(bars, (c) => BUILTINS.get('ta.tr')!(c, [], {}));
    expect(numv(res[0]!)).toBeCloseTo(4, 9);                       // pinets: h−l
    expect(numv(res[1]!)).toBeCloseTo(Math.max(6, 5, 1), 9);       // 15-9,|15-10|,|9-10|
    expect(numv(res[2]!)).toBeCloseTo(Math.max(3, 2, 1), 9);       // 16-13,|16-14|,|13-14|
    // handle_na=false → NaN on bar0 (pinets), i.e. na Value
    const res2 = runBars(bars, (c) => BUILTINS.get('ta.tr')!(c, [], { handle_na: { kind: 'bool', v: false } }));
    expect(res2[0]!.kind).toBe('na');
  });

  it('ta.tr ported == existing builtin bar-for-bar (parity)', () => {
    const origTr = orig.get('tr')!;
    const a = runBars(WAVY, (c) => origTr(c, [], {}));
    const b = runBars(WAVY, (c) => BUILTINS.get('ta.tr')!(c, [], {}));
    for (let i = 0; i < WAVY.length; i++) {
      expect(numv(b[i]!)).toBeCloseTo(numv(a[i]!), 8);
    }
  });

  it('ta.rsi ported == existing builtin bar-for-bar (parity)', () => {
    const origRsi = orig.get('rsi')!;
    const a = runBars(WAVY, (c) => origRsi(c, [ser(c.close), { kind: 'int', v: 14 }], {}));
    const b = runBars(WAVY, (c) => BUILTINS.get('ta.rsi')!(c, [ser(c.close), { kind: 'int', v: 14 }], {}));
    for (let i = 0; i < WAVY.length; i++) {
      if (a[i]!.kind === 'na') {
        expect(b[i]!.kind).toBe('na'); // both na through the seed window
      } else {
        expect(numv(b[i]!)).toBeCloseTo(numv(a[i]!), 8);
      }
    }
  });

  it('ta.supertrend ported returns [st, dir] tuples; dir flips on a reversal', () => {
    // Long rise then a sharp drop — ATR period 10 → first output at bar 9
    // (pinets counts tr from bar0; ours seeds rma one bar later — documented).
    const bars = mkBars(30, (i) => ({
      open: 100 + (i < 20 ? i : 20 - (i - 19) * 4),
      high: 102 + (i < 20 ? i : 20 - (i - 19) * 4),
      low: 99 + (i < 20 ? i : 20 - (i - 19) * 4),
      close: 100 + (i < 20 ? i : 20 - (i - 19) * 4),
    }));
    const res = runBars(bars, (c) => BUILTINS.get('ta.supertrend')!(c, [{ kind: 'int', v: 3 }, { kind: 'int', v: 10 }], {}));
    // Pinets emits [[NaN, NaN]] until the first ATR at bar 9 (atrPeriod 10,
    // counting tr from bar 0) — an array of na, not a bare na Value.
    expect(res[8]!.kind).toBe('array');
    expect(numv(res[8]!.kind === 'array' ? res[8]!.v[0]! : res[8]!)).toBeNaN();
    const dirs: number[] = [];
    for (let i = 9; i < bars.length; i++) {
      const v = res[i]!;
      if (v.kind !== 'array') throw new Error(`expected tuple, got ${v.kind}`);
      const [st, dir] = v.v;
      expect(Number.isFinite(numv(st!))).toBe(true);
      dirs.push(numv(dir!));
    }
    expect(dirs.every((d) => d === 1 || d === -1)).toBe(true);
    expect(dirs.some((d) => d === -1)).toBe(true);  // rising leg → uptrend
    expect(dirs.some((d) => d === 1)).toBe(true);   // drop flips to downtrend
  });

  it('ported ta.rsi is reachable from a pine script via runScript', async () => {
    const src = `indicator("t")\nplot(ta.rsi(close, 14), "r")\n`;
    const r = await runScript(parse(src), WAVY, { symbol: 'T', timeframe: '1' });
    const vals = r.plots.get('r')!.values;
    // Compare with the ORIGINAL builtin driven directly — the true parity bar.
    const origRsi = orig.get('rsi')!;
    const direct = runBars(WAVY, (c) => origRsi(c, [ser(c.close), { kind: 'int', v: 14 }], {}));
    for (let i = 0; i < WAVY.length; i++) {
      if (direct[i]!.kind === 'na') expect(vals[i]!.kind).toBe('na');
      else expect(numv(vals[i]!)).toBeCloseTo(numv(direct[i]!), 8);
    }
  });
});
