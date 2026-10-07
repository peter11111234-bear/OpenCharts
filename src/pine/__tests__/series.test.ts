import { describe, expect, it } from 'vitest';
import { NA, Scope, Series, type BarData, type Value } from '../contracts';
import { BarSeries, histGet, histGetAt, mkSeries, seriesWindow, valueAt } from '../series';
import { BarCtx, CapturingPlotSink, MemoryDrawSink, parseTimeframe } from '../context';
import {
  assignVar,
  blockFrame,
  callFrame,
  defineSeries,
  readVar,
  rootFrame,
  seriesOf,
  writeVar,
} from '../scope';

function mkBars(n: number): BarData[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 60_000,
    open: 100 + i,
    high: 102 + i,
    low: 98 + i,
    close: 101 + i,
    volume: 1000 + i * 10,
  }));
}

const num = (v: Value): number => (v.kind === 'int' || v.kind === 'float' ? v.v : NaN);

describe('contract Series', () => {
  it('set/get/cur walk history backwards', () => {
    const s = new Series();
    s.set({ kind: 'float', v: 1 });
    s.set({ kind: 'float', v: 2 });
    s.set({ kind: 'float', v: 3 });
    expect(num(s.get(0))).toBe(3);
    expect(num(s.get(1))).toBe(2);
    expect(num(s.cur())).toBe(3);
    expect(s.size()).toBe(3);
  });

  it('out-of-range history returns na', () => {
    const s = new Series();
    for (let i = 0; i < 3; i++) s.set({ kind: 'float', v: i });
    expect(s.get(10)).toEqual(NA);
    expect(s.get(-1).kind).toBe('na');
  });

  it('cap drops oldest entries', () => {
    const s = new Series(4);
    for (let i = 0; i < 6; i++) s.set({ kind: 'float', v: i });
    expect(s.size()).toBe(4);
    expect(num(s.get(0))).toBe(5);
    expect(num(s.get(3))).toBe(2);
    expect(s.get(4).kind).toBe('na');
  });
});

describe('BarSeries', () => {
  it('setAt overwrites within the same bar (x := e semantics)', () => {
    const s = new BarSeries();
    s.setAt(0, { kind: 'float', v: 1 });
    s.setAt(0, { kind: 'float', v: 9 });
    s.setAt(1, { kind: 'float', v: 2 });
    expect(num(s.get(0))).toBe(2);
    expect(num(s.get(1))).toBe(9);
    expect(s.size()).toBe(2);
  });

  it('carry-forward fills unwritten bars (var persistence)', () => {
    const s = new BarSeries();
    s.setAt(0, { kind: 'float', v: 5 }); // var x = 5, never reassigned
    s.ensureBar(4);
    expect(num(s.get(0))).toBe(5); // bar 4
    expect(num(s.get(4))).toBe(5); // bar 0
    expect(s.size()).toBe(5);
  });

  it('atOffset reads carry-forward for bars past lastBar', () => {
    const s = new BarSeries();
    s.setAt(2, { kind: 'float', v: 7 });
    // read at bar 5 without ensureBar: bars 3-5 carry forward 7
    expect(num(s.atOffset(5, 0))).toBe(7);
    expect(num(s.atOffset(5, 3))).toBe(7); // bar 2
    expect(s.atOffset(5, 10).kind).toBe('na');
    expect(s.atOffset(0, 0).kind).toBe('na'); // before any write
  });

  it('get floors fractional and rejects non-finite indices', () => {
    const s = new BarSeries();
    s.set({ kind: 'float', v: 1 });
    s.set({ kind: 'float', v: 2 });
    expect(num(s.get(1.7))).toBe(1);
    expect(s.get(NaN).kind).toBe('na');
  });

  it('histGet: na index and OOR → na; Value index works', () => {
    const s = mkSeries();
    s.set({ kind: 'float', v: 10 });
    s.set({ kind: 'float', v: 20 });
    expect(num(histGet(s, { kind: 'int', v: 1 }))).toBe(10);
    expect(histGet(s, NA).kind).toBe('na');
    expect(histGet(s, { kind: 'float', v: 0.9 })).toEqual({ kind: 'float', v: 20 });
    expect(histGet(s, 99).kind).toBe('na');
  });

  it('histGetAt/valueAt honor carry-forward vs plain Series', () => {
    const bs = new BarSeries();
    bs.setAt(2, { kind: 'float', v: 42 });
    expect(num(valueAt(bs, 7))).toBe(42);
    const plain = new Series();
    plain.set({ kind: 'float', v: 3 });
    expect(num(histGetAt(plain, 0, 7))).toBe(3);
  });

  it('seriesWindow builds bar-indexed history', () => {
    const s = seriesWindow([{ kind: 'float', v: 1 }, { kind: 'float', v: 2 }], 4);
    expect(num(s.atOffset(4, 0))).toBe(2); // carry-forward from bar 1
    expect(num(s.atOffset(1, 0))).toBe(2);
    expect(num(s.atOffset(0, 0))).toBe(1);
    expect(s.atOffset(0, 1).kind).toBe('na');
  });
});

describe('Scope', () => {
  it('lookup chains to parent; has covers ancestors', () => {
    const root = new Scope();
    root.define('a', mkSeries({ kind: 'float', v: 1 }));
    const mid = new Scope(root);
    mid.define('b', { kind: 'bool', v: true });
    const leaf = new Scope(mid);
    leaf.define('c', mkSeries({ kind: 'float', v: 3 }));

    expect(leaf.lookup('a')).toBeDefined();
    expect(leaf.lookup('b')).toBeDefined();
    expect(leaf.has('a')).toBe(true);
    expect(leaf.has('b')).toBe(true);
    expect(leaf.has('c')).toBe(true);
    expect(leaf.has('nope')).toBe(false);
    expect(root.lookup('c')).toBeUndefined(); // no downward visibility
  });

  it('child shadowing does not affect parent', () => {
    const root = new Scope();
    defineSeries(root, 'x', { kind: 'float', v: 1 }, 0);
    const child = new Scope(root);
    defineSeries(child, 'x', { kind: 'float', v: 2 }, 0);
    expect(num(readVar(child, 'x', 0))).toBe(2);
    expect(num(readVar(root, 'x', 0))).toBe(1);
  });
});

describe('Frame helpers', () => {
  it('assignVar creates slot, writes per bar, overwrites same bar', () => {
    const ctx = new BarCtx(mkBars(5)).seek(0);
    const f = rootFrame(ctx);
    assignVar(f.scope, 'x', { kind: 'float', v: 1 }, 0);
    assignVar(f.scope, 'x', { kind: 'float', v: 2 }, 0); // same-bar overwrite
    expect(num(readVar(f.scope, 'x', 0))).toBe(2);
    assignVar(f.scope, 'x', { kind: 'float', v: 3 }, 1);
    const s = seriesOf(f.scope, 'x')!;
    expect(num(histGet(s, 1))).toBe(2);
  });

  it('var-style slot carries forward when untouched', () => {
    const ctx = new BarCtx(mkBars(5)).seek(0);
    const f = rootFrame(ctx);
    defineSeries(f.scope, 'acc', { kind: 'float', v: 100 }, 0);
    // bars 1..3 untouched → carry forward; bar 4 reassigned
    writeVar(f.scope, 'acc', { kind: 'float', v: 101 }, 4);
    const s = seriesOf(f.scope, 'acc')!;
    expect(num(histGetAt(s, 0, 3))).toBe(100);
    expect(num(histGetAt(s, 0, 4))).toBe(101);
    expect(num(histGetAt(s, 4, 4))).toBe(100);
  });

  it('writeVar throws on undeclared name', () => {
    const ctx = new BarCtx(mkBars(1)).seek(0);
    const f = rootFrame(ctx);
    expect(() => writeVar(f.scope, 'ghost', { kind: 'float', v: 1 }, 0)).toThrow(/undeclared/);
  });

  it('reassign reaches ancestor-scope slot through a block frame', () => {
    const ctx = new BarCtx(mkBars(2)).seek(1);
    const f = rootFrame(ctx);
    defineSeries(f.scope, 'y', { kind: 'float', v: 1 }, 0);
    const inner = blockFrame(f, 'i');
    writeVar(inner.scope, 'y', { kind: 'float', v: 2 }, 1);
    expect(num(readVar(f.scope, 'y', 1))).toBe(2);
  });

  it('callFrame nests scope over closure', () => {
    const ctx = new BarCtx(mkBars(1)).seek(0);
    const f = rootFrame(ctx);
    defineSeries(f.scope, 'g', { kind: 'float', v: 9 }, 0);
    const cf = callFrame(f);
    expect(cf.scope.has('g')).toBe(true); // visible through closure chain
    expect(num(readVar(cf.scope, 'g', 0))).toBe(9);
  });
});

describe('parseTimeframe', () => {
  it.each([
    ['15', { multiplier: 15, isminutes: true, isintraday: true, isdaily: false, isweekly: false, ismonthly: false, isseconds: false }],
    ['30S', { multiplier: 30, isseconds: true, isintraday: true, isminutes: false }],
    ['4H', { multiplier: 4, isminutes: true, isintraday: true }],
    ['D', { multiplier: 1, isdaily: true, isintraday: false, isminutes: false }],
    ['2D', { multiplier: 2, isdaily: true, isintraday: false }],
    ['W', { multiplier: 1, isweekly: true, isintraday: false }],
    ['3W', { multiplier: 3, isweekly: true }],
    ['M', { multiplier: 1, ismonthly: true, isintraday: false }],
    ['1m', { multiplier: 1, isminutes: true, isintraday: true }], // lowercase m = minutes
  ])('%s → %o', (input, expect_) => {
    const tf = parseTimeframe(input);
    for (const [k, v] of Object.entries(expect_)) {
      expect(tf[k as keyof typeof tf], `${input}.${k}`).toBe(v);
    }
    expect(tf.period).toBe(input);
  });

  it('rejects garbage', () => {
    expect(() => parseTimeframe('abc')).toThrow();
    expect(() => parseTimeframe('0')).toThrow();
  });
});

describe('BarCtx', () => {
  it('exposes OHLCV + derived series per bar with correct history', () => {
    const bars = mkBars(10);
    const bc = new BarCtx(bars, { market: '15', symbol: 'TWSE:2330' });
    const ctx = bc.seek(7);
    expect(ctx.barIndex).toBe(7);
    expect(ctx.barCount).toBe(10);
    // current bar values
    expect(num(ctx.close.cur())).toBe(108);
    expect(num(ctx.open.cur())).toBe(107);
    expect(num(ctx.volume.cur())).toBe(1070);
    expect(num(ctx.time.cur())).toBe(7 * 60_000);
    // history: close[3] = bar 4 close
    expect(num(ctx.close.get(3))).toBe(105);
    expect(ctx.close.get(8).kind).toBe('na'); // only 8 bars of history
    // derived: hl2 = (h+l)/2 = (109+105)/2 = 107; hlc3 = (109+105+108)/3
    expect(num(ctx.hl2.cur())).toBeCloseTo(107);
    expect(num(ctx.hlc3.cur())).toBeCloseTo((109 + 105 + 108) / 3);
    expect(num(ctx.ohlc4.cur())).toBeCloseTo((107 + 109 + 105 + 108) / 4);
    expect(num(ctx.hlcc4.cur())).toBeCloseTo((109 + 105 + 108 + 108) / 4);
  });

  it('next() walks forward and returns null at end', () => {
    const bc = new BarCtx(mkBars(3));
    const c0 = bc.next()!;
    expect(c0.barIndex).toBe(0);
    bc.next();
    const c2 = bc.next()!;
    expect(c2.barIndex).toBe(2);
    expect(bc.next()).toBeNull();
  });

  it('seek is forward-only and bounded', () => {
    const bc = new BarCtx(mkBars(3));
    bc.seek(2);
    expect(() => bc.seek(1)).toThrow(/forward-only/);
    expect(() => bc.seek(3)).toThrow(/out of range/);
  });

  it('timeframe and syminfo surface in ctx', () => {
    const ctx = new BarCtx(mkBars(2), { market: '15', symbol: 'TWSE:2330' }).seek(0);
    expect(ctx.timeframe.isminutes).toBe(true);
    expect(ctx.timeframe.isintraday).toBe(true);
    expect(ctx.timeframe.multiplier).toBe(15);
    expect(ctx.syminfo['ticker']).toEqual({ kind: 'string', v: '2330' });
    expect(ctx.syminfo['prefix']).toEqual({ kind: 'string', v: 'TWSE' });
    expect(ctx.syminfo['tickerid']).toEqual({ kind: 'string', v: 'TWSE:2330' });
    expect(ctx.syminfo['currency']).toEqual({ kind: 'string', v: 'TWD' });
    expect(ctx.syminfo['timezone']).toEqual({ kind: 'string', v: 'Asia/Taipei' });
    expect(ctx.syminfo['session']).toEqual({ kind: 'string', v: 'regular' });
  });

  it('syminfo overrides merge', () => {
    const ctx = new BarCtx(mkBars(1), {
      syminfo: { mintick: { kind: 'float', v: 0.05 }, session: { kind: 'string', v: 'extended' } },
    }).seek(0);
    expect(ctx.syminfo['mintick']).toEqual({ kind: 'float', v: 0.05 });
    expect(ctx.syminfo['session']).toEqual({ kind: 'string', v: 'extended' });
  });

  it('warnings/alerts arrays persist across bars; fetchSeries passthrough', async () => {
    const fetch = async () => mkBars(2);
    const bc = new BarCtx(mkBars(2), { fetchSeries: fetch });
    const c0 = bc.seek(0);
    c0.warnings.push('w1');
    const c1 = bc.seek(1);
    expect(c1.warnings).toEqual(['w1']);
    expect(await c1.fetchSeries!('X', 'D')).toHaveLength(2);
  });

  it('plot/draw sinks capture pushes', () => {
    const plot = new CapturingPlotSink();
    const draw = new MemoryDrawSink();
    const ctx = new BarCtx(mkBars(1), { plots: [plot], drawings: [draw] }).seek(0);
    ctx.plots[0]!.push({ kind: 'float', v: 1.5 }, { title: 't' });
    const obj = ctx.drawings[0]!.create('line', { x1: 0 });
    ctx.drawings[0]!.update(obj, { color: 'red' });
    expect(plot.pushes).toEqual([{ value: { kind: 'float', v: 1.5 }, opts: { title: 't' } }]);
    expect(draw.objects[0]!.props).toEqual({ x1: 0, color: 'red' });
    ctx.drawings[0]!.remove(obj);
    expect(draw.objects).toHaveLength(0);
  });
});
