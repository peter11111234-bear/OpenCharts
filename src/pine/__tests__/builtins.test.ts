// ── builtins tests: math.* / str.* / array.* / color.* ─────────────────────

import { describe, expect, it } from 'vitest';
import { NA, Series } from '../contracts';
import type { BuiltinCtx, PlotOpts, Value } from '../contracts';
import { PineRuntimeError } from '../errors';
import { MemoryDrawSink } from '../context';
import { BUILTINS, getConstant } from '../builtins';
import type { RtCtx } from '../builtins/util';
// (BUILTINS/getConstant imported once above)

// ── helpers ─────────────────────────────────────────────────────────────────

export function mkBars(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 60000,
    open: i + 1,
    high: i + 2,
    low: i,
    close: i + 1,
    volume: 1000 + i,
  }));
}

export function mkCtx(over: Partial<BuiltinCtx> = {}): BuiltinCtx {
  return {
    barIndex: 0,
    barCount: 1,
    open: new Series(),
    high: new Series(),
    low: new Series(),
    close: new Series(),
    volume: new Series(),
    time: new Series(),
    hl2: new Series(),
    hlc3: new Series(),
    ohlc4: new Series(),
    hlcc4: new Series(),
    plots: [],
    drawings: [],
    warnings: [],
    alerts: [],
    syminfo: { mintick: { kind: 'float', v: 0.01 } },
    timeframe: {
      period: 'D',
      multiplier: 1,
      isseconds: false,
      isminutes: false,
      isdaily: true,
      isweekly: false,
      ismonthly: false,
      isintraday: false,
    },
    callUdf: () => NA,
    ...over,
  };
}

const call = (name: string, args: Value[] = [], named: Record<string, Value> = {}, ctx = mkCtx()): Value => {
  const fn = BUILTINS.get(name);
  if (!fn) throw new Error(`builtin not registered: ${name}`);
  return fn(ctx, args, named);
};

const intV = (v: number): Value => ({ kind: 'int', v });
const floatV = (v: number): Value => ({ kind: 'float', v });
const strV = (v: string): Value => ({ kind: 'string', v });
const boolV = (v: boolean): Value => ({ kind: 'bool', v });
const colV = (v: string): Value => ({ kind: 'color', v });

/** vals[0] = oldest bar; vals[last] = current. */
function seriesOf(vals: (number | 'na')[]): Value {
  const s = new Series();
  for (const v of vals) s.set(v === 'na' ? NA : floatV(v));
  return { kind: 'series', v: s };
}

const seriesAt = (v: Value, i: number): Value =>
  v.kind === 'series' ? v.v.get(i) : v;

// ── math.* ──────────────────────────────────────────────────────────────────

describe('math.*', () => {
  it('abs/max/min scalar + na-skip', () => {
    expect(call('math.abs', [floatV(-3)])).toEqual(floatV(3));
    expect(call('math.abs', [intV(-3)])).toEqual(intV(3));
    expect(call('math.abs', [NA])).toEqual(NA);
    expect(call('math.max', [intV(2), intV(7), intV(4)])).toEqual(intV(7));
    expect(call('math.max', [intV(2), NA])).toEqual(intV(2));
    expect(call('math.min', [intV(2), intV(7)])).toEqual(intV(2));
    expect(call('math.min', [NA, NA])).toEqual(NA);
  });

  it('round incl. precision + half-away-from-zero', () => {
    expect(call('math.round', [floatV(1.5)])).toEqual(intV(2));
    expect(call('math.round', [floatV(-1.5)])).toEqual(intV(-1)); // TV ties round up (+∞)
    expect(call('math.round', [floatV(1.2345), intV(2)])).toEqual(floatV(1.23));
    expect(call('math.round', [floatV(2.675), intV(2)])).toEqual(floatV(2.68));
  });

  it('round_to_mintick uses syminfo.mintick', () => {
    const ctx = mkCtx({ syminfo: { mintick: floatV(0.25) } });
    expect(call('math.round_to_mintick', [floatV(101.37)], {}, ctx)).toEqual(floatV(101.25));
    expect(call('math.round_to_mintick', [floatV(101.38)], {}, ctx)).toEqual(floatV(101.5));
  });

  it('sign/pow/sqrt/log/log10/exp/floor/ceil/avg', () => {
    expect(call('math.sign', [floatV(-2)])).toEqual(intV(-1));
    expect(call('math.sign', [floatV(0)])).toEqual(intV(0));
    expect(call('math.pow', [intV(2), intV(10)])).toEqual(floatV(1024));
    expect(call('math.sqrt', [floatV(9)])).toEqual(floatV(3));
    expect(call('math.log', [floatV(Math.E)])).toEqual(floatV(1));
    expect(call('math.log10', [floatV(1000)])).toEqual(floatV(3));
    expect(call('math.exp', [floatV(0)])).toEqual(floatV(1));
    expect(call('math.floor', [floatV(1.9)])).toEqual(floatV(1));
    expect(call('math.ceil', [floatV(1.1)])).toEqual(floatV(2));
    expect(call('math.avg', [floatV(2), floatV(4)])).toEqual(floatV(3));
  });

  it('trig fns + constants', () => {
    expect(call('math.sin', [floatV(Math.PI / 2)])).toEqual(floatV(1));
    expect(call('math.cos', [floatV(0)])).toEqual(floatV(1));
    expect(call('math.tan', [floatV(0)])).toEqual(floatV(0));
    expect((call('math.acos', [floatV(1)]) as { v: number }).v).toBeCloseTo(0);
    expect((call('math.asin', [floatV(1)]) as { v: number }).v).toBeCloseTo(Math.PI / 2);
    expect((call('math.atan', [floatV(1)]) as { v: number }).v).toBeCloseTo(Math.PI / 4);
    expect(getConstant('math.pi')).toEqual(floatV(Math.PI));
    expect(call('math.pi')).toEqual(floatV(Math.PI));
  });

  it('math.sum rolling window', () => {
    const r = call('math.sum', [seriesOf([1, 2, 3, 4]), intV(3)]);
    // bars 0,1 → na (incomplete window), bar2 → 6, bar3 → 9
    expect(seriesAt(r, 3)).toEqual(NA);
    expect(seriesAt(r, 2)).toEqual(NA);
    expect(seriesAt(r, 1)).toEqual(floatV(6));
    expect(seriesAt(r, 0)).toEqual(floatV(9));
  });

  it('nz unwraps na, bare + math.nz', () => {
    expect(call('nz', [NA])).toEqual(intV(0));
    expect(call('nz', [NA, intV(7)])).toEqual(intV(7));
    expect(call('math.nz', [floatV(3.5)])).toEqual(floatV(3.5));
    const s = call('nz', [seriesOf(['na', 2, 'na'])]);
    expect(seriesAt(s, 0)).toEqual(intV(0));
    expect(seriesAt(s, 1)).toEqual(floatV(2));
    expect(seriesAt(s, 2)).toEqual(intV(0));
  });

  it('tonumber + random + chain max(nz(x),0)', () => {
    expect(call('math.tonumber', [strV('12.5')])).toEqual(floatV(12.5));
    expect(call('math.tonumber', [strV('x')])).toEqual(NA);
    expect(call('math.tonumber', [boolV(true)])).toEqual(intV(1));
    const r = call('math.random', [floatV(0), floatV(10), intV(42)]) as { v: number };
    expect(r.v).toBeGreaterThanOrEqual(0);
    expect(r.v).toBeLessThan(10);
    const nzed = call('nz', [seriesOf(['na', -5, 3])]);
    const maxed = call('math.max', [nzed, intV(0)]);
    // nzed elements are float (source series was float) → float results.
    expect(seriesAt(maxed, 0)).toEqual(floatV(3));
    expect(seriesAt(maxed, 1)).toEqual(floatV(0));
    expect(seriesAt(maxed, 2)).toEqual(floatV(0));
  });
});

// ── str.* ───────────────────────────────────────────────────────────────────

describe('str.*', () => {
  it('tostring all kinds + pattern', () => {
    expect(call('str.tostring', [floatV(1.5), strV('#.##')])).toEqual(strV('1.50'));
    expect(call('str.tostring', [floatV(1234.5), strV('#,##0.00')])).toEqual(strV('1,234.50'));
    expect(call('str.tostring', [intV(42)])).toEqual(strV('42'));
    expect(call('str.tostring', [floatV(1.5)])).toEqual(strV('1.5'));
    expect(call('str.tostring', [boolV(true)])).toEqual(strV('true'));
    expect(call('str.tostring', [NA])).toEqual(strV('NaN'));
    expect(call('str.tostring', [strV('hi')])).toEqual(strV('hi'));
    expect(call('str.tostring', [colV('#FF0000')])).toEqual(strV('#FF0000'));
  });

  it('tostring format.mintick + percent + volume', () => {
    const ctx = mkCtx({ syminfo: { mintick: floatV(0.25) } });
    const mintick = getConstant('format.mintick')!;
    expect(call('str.tostring', [floatV(1.3), mintick], {}, ctx)).toEqual(strV('1.30'));
    const percent = getConstant('format.percent')!;
    expect(call('str.tostring', [floatV(0.155), percent])).toEqual(strV('15.50%'));
    const volume = getConstant('format.volume')!;
    expect(call('str.tostring', [floatV(12345678), volume])).toEqual(strV('12.346M'));
  });

  it('tonumber', () => {
    expect(call('str.tonumber', [strV('12.5')])).toEqual(floatV(12.5));
    expect(call('str.tonumber', [strV('1,234.5')])).toEqual(floatV(1234.5));
    expect(call('str.tonumber', [strV('abc')])).toEqual(NA);
    expect(call('str.tonumber', [NA])).toEqual(NA);
  });

  it('format placeholders incl. date/time', () => {
    expect(call('str.format', [strV('{0} and {1}'), intV(1), strV('two')])).toEqual(
      strV('1 and two'),
    );
    expect(call('str.format', [strV('{0,date}'), intV(0)])).toEqual(strV('1970-01-01'));
    expect(call('str.format', [strV('{name} hit'), ], { name: strV('MACD') })).toEqual(
      strV('MACD hit'),
    );
  });

  it('format_time patterns (UTC)', () => {
    // 2021-03-15 14:30:45 UTC = 1615818645000
    const t = intV(1615818645000);
    expect(call('str.format_time', [t, strV('yyyy-MM-dd')])).toEqual(strV('2021-03-15'));
    expect(call('str.format_time', [t, strV('HH:mm')])).toEqual(strV('14:30'));
    expect(call('str.format_time', [t, strV('MM/dd/yy h a')])).toEqual(strV('03/15/21 2 PM'));
  });

  it('replace / replace_all', () => {
    expect(call('str.replace', [strV('a-b-b'), strV('b'), strV('x')])).toEqual(strV('a-x-b'));
    expect(call('str.replace_all', [strV('a-b-b'), strV('b'), strV('x')])).toEqual(strV('a-x-x'));
  });

  it('contains / startswith / endswith / length / pos / match', () => {
    expect(call('str.contains', [strV('foobar'), strV('oba')])).toEqual(boolV(true));
    expect(call('str.contains', [strV('foobar'), strV('z')])).toEqual(boolV(false));
    expect(call('str.startswith', [strV('foobar'), strV('foo')])).toEqual(boolV(true));
    expect(call('str.endswith', [strV('foobar'), strV('bar')])).toEqual(boolV(true));
    expect(call('str.length', [strV('hello')])).toEqual(intV(5));
    expect(call('str.pos', [strV('hello'), strV('ll')])).toEqual(intV(2));
    expect(call('str.pos', [strV('hello'), strV('z')])).toEqual(intV(-1));
    expect(call('str.match', [strV('AAPL'), strV('^A+')])).toEqual(boolV(true));
    expect(call('str.match', [strV('MSFT'), strV('^A+')])).toEqual(boolV(false));
  });

  it('substring / split / join / repeat / lower / upper / trim', () => {
    expect(call('str.substring', [strV('hello'), intV(1), intV(3)])).toEqual(strV('el'));
    expect(call('str.substring', [strV('hello'), intV(2)])).toEqual(strV('llo'));
    const parts = call('str.split', [strV('a,b,c'), strV(',')]);
    expect(parts.kind).toBe('array');
    expect((parts as { v: Value[] }).v).toEqual([strV('a'), strV('b'), strV('c')]);
    expect(call('str.join', [parts, strV('-')])).toEqual(strV('a-b-c'));
    expect(call('str.repeat', [strV('ab'), intV(3)])).toEqual(strV('ababab'));
    expect(call('str.lower', [strV('ABC')])).toEqual(strV('abc'));
    expect(call('str.upper', [strV('abc')])).toEqual(strV('ABC'));
    expect(call('str.trim', [strV('  x  ')])).toEqual(strV('x'));
  });
});

// ── array.* ─────────────────────────────────────────────────────────────────

const arrOf = (xs: (number | 'na')[]): Value =>
  ({
    kind: 'array',
    v: xs.map((x) => (x === 'na' ? NA : floatV(x))),
  }) as Value;

const arrNums = (v: Value): number[] =>
  v.kind === 'array' ? v.v.map((e) => (e.kind === 'na' ? NaN : asNum(e))) : [];
const asNum = (e: Value): number => (e.kind === 'int' || e.kind === 'float' ? e.v : NaN);

describe('array.*', () => {
  it('new<T> + push/get/size roundtrip (acceptance)', () => {
    const a = call('array.new', [intV(0)]);
    expect(a.kind).toBe('array');
    expect(arrNums(a)).toEqual([]);
    call('array.push', [a, intV(10)]);
    call('array.push', [a, intV(20)]);
    expect(call('array.size', [a])).toEqual(intV(2));
    expect(call('array.get', [a, intV(0)])).toEqual(intV(10));
    expect(call('array.get', [a, intV(1)])).toEqual(intV(20));
    // v6: out-of-range index is a runtime error, not silent na
    expect(() => call('array.get', [a, intV(9)])).toThrow(PineRuntimeError);
  });

  it('new_* variants + from + fill', () => {
    const a = call('array.new_float', [intV(3), floatV(1.5)]);
    expect(arrNums(a)).toEqual([1.5, 1.5, 1.5]);
    const b = call('array.new', [intV(2)]); // generic new<T> → na-filled
    expect(b.kind === 'array' && b.v.every((e) => e.kind === 'na')).toBe(true);
    const c = call('array.from', [intV(1), intV(2), intV(3)]);
    expect(arrNums(c)).toEqual([1, 2, 3]);
    call('array.fill', [c, intV(9)]);
    expect(arrNums(c)).toEqual([9, 9, 9]);
    for (const name of ['new_bool', 'new_color', 'new_int', 'new_line', 'new_label', 'new_box', 'new_string', 'new_type']) {
      expect(BUILTINS.has(`array.${name}`)).toBe(true);
    }
  });

  it('unshift/pop/shift/set/insert/remove/clear', () => {
    const a = arrOf([1, 3]);
    call('array.unshift', [a, intV(0)]);
    expect(arrNums(a)).toEqual([0, 1, 3]);
    call('array.insert', [a, intV(2), intV(2)]);
    expect(arrNums(a)).toEqual([0, 1, 2, 3]);
    expect(call('array.pop', [a])).toEqual(floatV(3));
    expect(call('array.shift', [a])).toEqual(intV(0)); // unshifted element was int
    call('array.set', [a, intV(0), intV(7)]);
    expect(arrNums(a)).toEqual([7, 2]);
    expect(call('array.remove', [a, intV(0)])).toEqual(intV(7));
    expect(arrNums(a)).toEqual([2]);
    call('array.clear', [a]);
    expect(call('array.size', [a])).toEqual(intV(0));
    expect(call('array.pop', [a])).toEqual(NA);
  });

  it('includes/indexof/lastindexof/slice/concat/reverse/first/last', () => {
    const a = arrOf([1, 2, 3, 2]);
    expect(call('array.includes', [a, floatV(3)])).toEqual(boolV(true));
    expect(call('array.includes', [a, floatV(9)])).toEqual(boolV(false));
    expect(call('array.indexof', [a, floatV(2)])).toEqual(intV(1));
    expect(call('array.lastindexof', [a, floatV(2)])).toEqual(intV(3));
    expect(arrNums(call('array.slice', [a, intV(1), intV(3)]))).toEqual([2, 3]);
    expect(arrNums(call('array.concat', [a, arrOf([4])]))).toEqual([1, 2, 3, 2, 4]);
    const r = arrOf([1, 2, 3]);
    call('array.reverse', [r]);
    expect(arrNums(r)).toEqual([3, 2, 1]);
    expect(call('array.first', [a])).toEqual(floatV(1));
    expect(call('array.last', [a])).toEqual(floatV(2));
  });

  it('sort/sort_indices/binary_search family', () => {
    const a = arrOf([3, 1, 2]);
    call('array.sort', [a]);
    expect(arrNums(a)).toEqual([1, 2, 3]);
    const desc = getConstant('order.descending')!;
    const b = arrOf([3, 1, 2]);
    call('array.sort', [b, desc]);
    expect(arrNums(b)).toEqual([3, 2, 1]);
    const idx = arrNums(call('array.sort_indices', [arrOf([30, 10, 20])]));
    expect(idx).toEqual([1, 2, 0]);
    const s = arrOf([1, 2, 2, 2, 3]);
    expect(call('array.binary_search', [s, intV(2)])).toEqual(intV(1));
    expect(call('array.binary_search_leftmost', [s, intV(2)])).toEqual(intV(1));
    expect(call('array.binary_search_rightmost', [s, intV(2)])).toEqual(intV(3));
    expect(call('array.binary_search', [s, intV(9)])).toEqual(intV(-6));
  });

  it('stats: max/min/avg/median/mode/stdev/variance/sum/range', () => {
    const a = arrOf([1, 2, 3, 4]);
    expect(call('array.max', [a])).toEqual(floatV(4));
    expect(call('array.min', [a])).toEqual(floatV(1));
    expect(call('array.avg', [a])).toEqual(floatV(2.5));
    expect(call('array.median', [a])).toEqual(floatV(2.5));
    expect(call('array.median', [arrOf([1, 2, 9])])).toEqual(floatV(2));
    expect(call('array.mode', [arrOf([1, 2, 2, 3, 3, 3])])).toEqual(floatV(3));
    expect(call('array.sum', [a])).toEqual(floatV(10));
    expect(call('array.range', [a])).toEqual(floatV(3));
    // population var/stdev of [1,2,3,4]: var=1.25, sd=sqrt(1.25)
    expect((call('array.variance', [a]) as { v: number }).v).toBeCloseTo(1.25);
    expect((call('array.stdev', [a]) as { v: number }).v).toBeCloseTo(Math.sqrt(1.25));
    // sample (biased=false): var = 5/3
    expect((call('array.variance', [a, boolV(false)]) as { v: number }).v).toBeCloseTo(5 / 3);
    expect(call('array.avg', [{ kind: 'array', v: [] }])).toEqual(NA);
  });

  it('every/some/join/abs/percentrank/standardize', () => {
    const t = call('array.from', [boolV(true), boolV(true)]);
    const f = call('array.from', [boolV(true), boolV(false)]);
    expect(call('array.every', [t])).toEqual(boolV(true));
    expect(call('array.every', [f])).toEqual(boolV(false));
    expect(call('array.some', [f])).toEqual(boolV(true));
    expect(call('array.join', [arrOf([1, 2]), strV('|')])).toEqual(strV('1|2'));
    const abs = call('array.abs', [arrOf([-1, 2, 'na'])]);
    expect(arrNums(abs)[0]).toBe(1);
    expect(arrNums(abs)[2]).toBeNaN();
    expect(call('array.percentrank', [arrOf([1, 2, 3, 4]), floatV(2)])).toEqual(floatV(50));
    const std = call('array.standardize', [arrOf([1, 2, 3, 4])]);
    const sd = Math.sqrt(1.25);
    expect(arrNums(std)[0]).toBeCloseTo(-1.5 / sd);
    expect(arrNums(std)[3]).toBeCloseTo(1.5 / sd);
  });

  it('covariance/correlation/percentiles', () => {
    const x = arrOf([1, 2, 3]);
    const y = arrOf([2, 4, 6]);
    expect((call('array.covariance', [x, y]) as { v: number }).v).toBeCloseTo(4 / 3);
    expect((call('array.correlation', [x, y]) as { v: number }).v).toBeCloseTo(1);
    const a = arrOf([10, 20, 30, 40]);
    expect(call('array.percentile_linear_interpolation', [a, floatV(50)])).toEqual(floatV(25));
    expect(call('array.percentile_nearest_rank', [a, floatV(50)])).toEqual(floatV(20));
    expect(call('array.percentile_nearest_rank', [a, floatV(100)])).toEqual(floatV(40));
  });
});

// ── color.* ─────────────────────────────────────────────────────────────────

describe('color.*', () => {
  it('named constants + color.na', () => {
    expect(getConstant('color.red')).toEqual(colV('#FF0000'));
    expect(getConstant('color.blue')).toEqual(colV('#0000FF'));
    expect(getConstant('color.orange')).toEqual(colV('#FF8000'));
    expect(getConstant('color.teal')).toEqual(colV('#008080'));
    for (const n of ['white', 'black', 'green', 'purple', 'yellow', 'gray', 'aqua', 'fuchsia', 'lime', 'maroon', 'navy', 'olive', 'silver']) {
      expect(getConstant(`color.${n}`)).toBeDefined();
    }
    expect(getConstant('color.na')).toEqual(NA);
  });

  it('color.new(color.red, 50) → rgba alpha .5 (acceptance)', () => {
    const red = getConstant('color.red')!;
    expect(call('color.new', [red, intV(50)])).toEqual(colV('rgba(255, 0, 0, 0.5)'));
    expect(call('color.new', [red, intV(0)])).toEqual(colV('#FF0000'));
    expect(call('color.new', [red, intV(100)])).toEqual(colV('rgba(255, 0, 0, 0)'));
    expect(call('color.new', [NA, intV(50)])).toEqual(NA);
  });

  it('color.rgb + transp', () => {
    expect(call('color.rgb', [intV(255), intV(128), intV(0)])).toEqual(colV('#FF8000'));
    expect(call('color.rgb', [intV(0), intV(0), intV(0), intV(50)])).toEqual(
      colV('rgba(0, 0, 0, 0.5)'),
    );
  });

  it('from_gradient lerps channels', () => {
    const black = getConstant('color.black')!;
    const white = getConstant('color.white')!;
    expect(call('color.from_gradient', [floatV(5), floatV(0), floatV(10), black, white])).toEqual(
      colV('#808080'),
    );
    expect(call('color.from_gradient', [floatV(0), floatV(0), floatV(10), black, white])).toEqual(
      colV('#000000'),
    );
    expect(call('color.from_gradient', [NA, floatV(0), floatV(10), black, white])).toEqual(NA);
  });

  it('r/g/b/t extraction', () => {
    expect(call('color.r', [colV('#FF8040')])).toEqual(intV(255));
    expect(call('color.g', [colV('#FF8040')])).toEqual(intV(128));
    expect(call('color.b', [colV('#FF8040')])).toEqual(intV(64));
    expect(call('color.t', [colV('rgba(0, 0, 0, 0.5)')])).toEqual(floatV(50));
    expect(call('color.t', [colV('#FF0000')])).toEqual(floatV(0));
  });
});

// ── draw enums + format.price + cell aliases ─────────────────────────────────

it('draw enums + format.price + cell aliases registered', () => {
  expect(getConstant('text.align_top')).toBeDefined();
  expect(getConstant('text.align_bottom')).toBeDefined();
  expect(getConstant('chart.point_standard')).toBeDefined();
  expect(getConstant('chart.fg_color')).toBeDefined();
  expect(getConstant('format.price')).toBeDefined();
  for (const k of ['table.cell_set_text','table.cell_set_text_color','table.cell_set_text_size','table.cell_set_bgcolor','table.cell_set_tooltip'])
    expect(BUILTINS.has(k), k).toBe(true);
});

// ── na() / casts / fixnan / runtime.error ───────────────────────────────────

it('na() / casts / fixnan / runtime.error', () => {
  const ctx = mkCtx();
  expect(call('na', [floatV(1)], {}, ctx)).toEqual({kind:'bool', v:false});
  expect(call('na', [NA], {}, ctx)).toEqual({kind:'bool', v:true});
  expect(call('int', [floatV(3.9)], {}, ctx)).toEqual({kind:'int', v:3});
  expect(call('int', [NA], {}, ctx)).toEqual(NA);
  expect(call('float', [intV(2)], {}, ctx)).toEqual({kind:'float', v:2});
  expect(call('bool', [intV(0)], {}, ctx)).toEqual({kind:'bool', v:false});
  expect(call('color', [strV('#ff0000')], {}, ctx)).toEqual({kind:'color', v:'#ff0000'});
  expect(call('string', [intV(5)], {}, ctx)).toEqual({kind:'string', v:'5'});
  // fixnan via series: na at bar1 → bar0 value
  const ctx2 = mkCtx();
  const r: Value[] = [];
  for (let i = 0; i < 3; i++) {
    ctx2.barIndex = i;
    ctx2.close.set(floatV(1));
    r.push(i === 0 ? call('fixnan', [NA], {}, ctx2) : call('fixnan', [floatV(7)], {}, ctx2));
  }
  expect(r[0]!.kind).toBe('na');
  expect(r[1]).toEqual({kind:'float', v:7});
});

it('runtime.error throws PineRuntimeError', () => {
  const ctx = mkCtx();
  expect(() => call('runtime.error', [strV('boom')], {}, ctx)).toThrow(/boom/);
});

// ── calendar builtins + timeframe.in_seconds ────────────────────────────────

it('calendar builtins + in_seconds', () => {
  const ctx = mkCtx(); // ctx.time.get(0) = bar openTime ms
  // 2024-03-15 14:30 UTC = 1710513000000
  const t = {kind:'int' as const, v: 1710513000000};
  expect(call('hour',[t],{},ctx)).toEqual({kind:'int', v:14});
  expect(call('minute',[t],{},ctx)).toEqual({kind:'int', v:30});
  expect(call('dayofmonth',[t],{},ctx)).toEqual({kind:'int', v:15});
  expect(call('month',[t],{},ctx)).toEqual({kind:'int', v:3});
  expect(call('year',[t],{},ctx)).toEqual({kind:'int', v:2024});
  expect(call('dayofweek',[t],{},ctx)).toEqual({kind:'int', v:6}); // Friday (Sun=1)
  expect(call('timeframe.in_seconds',[],{},ctx)).toEqual({kind:'int', v:86400}); // mkCtx tf 'D'
  expect(call('timestamp',[intV(2024),intV(3),intV(15),intV(14),intV(30),intV(0)],{},ctx)).toEqual({kind:'int', v:1710513000000});
});

// ── array index semantics (Pine v6) ─────────────────────────────────────────
// Negative indices count from the end; genuinely out-of-range indices raise a
// runtime error (they do NOT silently yield na / no-op).

describe('array index semantics', () => {
  it('negative index counts from the end (get/set/remove/insert/slice)', () => {
    const a = arrOf([10, 20, 30]);
    expect(call('array.get', [a, intV(-1)])).toEqual(floatV(30));
    expect(call('array.get', [a, intV(-3)])).toEqual(floatV(10));
    call('array.set', [a, intV(-2), intV(25)]);
    expect(arrNums(a)).toEqual([10, 25, 30]);
    expect(call('array.remove', [a, intV(-1)])).toEqual(floatV(30));
    expect(arrNums(a)).toEqual([10, 25]);
    call('array.insert', [a, intV(-1), intV(24)]); // inserts before the last element
    expect(arrNums(a)).toEqual([10, 24, 25]);
    expect(arrNums(call('array.slice', [arrOf([1, 2, 3, 4]), intV(-3), intV(-1)]))).toEqual([2, 3]);
    expect(arrNums(call('array.slice', [arrOf([1, 2, 3, 4]), intV(-2)]))).toEqual([3, 4]);
  });

  it('out-of-range index throws PineRuntimeError', () => {
    const a = arrOf([1, 2, 3]);
    expect(() => call('array.get', [a, intV(3)])).toThrow(PineRuntimeError);
    expect(() => call('array.get', [a, intV(-4)])).toThrow(PineRuntimeError);
    expect(() => call('array.set', [a, intV(3), intV(9)])).toThrow(PineRuntimeError);
    expect(() => call('array.set', [a, intV(-4), intV(9)])).toThrow(PineRuntimeError);
    expect(() => call('array.remove', [a, intV(3)])).toThrow(PineRuntimeError);
    expect(() => call('array.remove', [a, intV(-4)])).toThrow(PineRuntimeError);
    expect(() => call('array.insert', [a, intV(4), intV(9)])).toThrow(PineRuntimeError);
    expect(() => call('array.insert', [a, intV(-5), intV(9)])).toThrow(PineRuntimeError);
    // insert at index == size appends (legal)
    call('array.insert', [a, intV(3), intV(4)]);
    expect(arrNums(a)).toEqual([1, 2, 3, 4]);
  });
});

// ── plot family semantics ───────────────────────────────────────────────────

const recSink = (ctx: BuiltinCtx, i: number): { value: Value; opts: PlotOpts }[] => {
  const sink = ctx.plots[i];
  if (!sink || !('buf' in sink) || !Array.isArray(sink.buf)) throw new Error('not a recording sink');
  return sink.buf as { value: Value; opts: PlotOpts }[];
};

describe('plot family fixes', () => {
  const seedHilo = (ctx: BuiltinCtx, hi = 12, lo = 8): void => {
    ctx.high.set(floatV(hi));
    ctx.low.set(floatV(lo));
  };

  it('plotshape/plotchar/plotarrow forward offset= to sink opts', () => {
    const ctx: RtCtx = mkCtx();
    seedHilo(ctx);
    ctx.callsite = '#a';
    call('plotshape', [boolV(true)], { offset: intV(2) }, ctx);
    ctx.callsite = '#b';
    call('plotchar', [boolV(true)], { offset: intV(-1) }, ctx);
    ctx.callsite = '#c';
    call('plotarrow', [floatV(1)], { offset: intV(3) }, ctx);
    expect(recSink(ctx, 0)[0]!.opts.offset).toBe(2);
    expect(recSink(ctx, 1)[0]!.opts.offset).toBe(-1);
    expect(recSink(ctx, 2)[0]!.opts.offset).toBe(3);
  });

  it('plotshape bool cond + location.top emits a numeric marker value', () => {
    const ctx: RtCtx = mkCtx();
    seedHilo(ctx);
    ctx.callsite = '#t';
    call('plotshape', [boolV(true)], { location: strV('location.top') }, ctx);
    const e = recSink(ctx, 0)[0]!;
    // Pane-top anchor falls back to the bar high — the engine must see a number.
    expect(e.value).toEqual(floatV(12));
    const topOpts = e.opts as PlotOpts & { location?: string }; // location stored as opts extra
    expect(topOpts.location).toBe('location.top');
  });

  it('plotshape bool cond + location.absolute anchors at bar high; numeric cond uses its value', () => {
    const ctx: RtCtx = mkCtx();
    seedHilo(ctx);
    ctx.callsite = '#t';
    call('plotshape', [boolV(true)], { location: strV('location.absolute') }, ctx);
    expect(recSink(ctx, 0)[0]!.value).toEqual(floatV(12));
    ctx.callsite = '#u';
    call('plotshape', [floatV(42)], { location: strV('location.absolute') }, ctx);
    expect(recSink(ctx, 1)[0]!.value).toEqual(intV(42)); // numVal keeps int kind
  });

  it('barcolor/bgcolor key colors by barIndex + offset', () => {
    const ctx: RtCtx = mkCtx();
    ctx.barIndex = 0;
    call('barcolor', [colV('#112233')], { offset: intV(1) }, ctx);
    call('bgcolor', [colV('#445566')], { offset: intV(2) }, ctx);
    expect(ctx.barcolors!.get(1)).toEqual(new Map([[ctx.callsite ?? '#top', '#112233']]));
    expect(ctx.barcolors!.has(0)).toBe(false);
    expect(ctx.bgcolors!.get(2)).toEqual(new Map([[ctx.callsite ?? '#top', '#445566']]));
  });

  it('plotbar/plotcandle copy title= and display= to opts', () => {
    const ctx: RtCtx = mkCtx();
    ctx.callsite = '#b';
    call('plotbar', [floatV(1), floatV(2), floatV(0), floatV(1.5)], {
      title: strV('B'), display: strV('display.pane'),
    }, ctx);
    ctx.callsite = '#c';
    call('plotcandle', [floatV(1), floatV(2), floatV(0), floatV(1.5)], {
      title: strV('C'), display: strV('display.none'),
    }, ctx);
    expect(recSink(ctx, 0)[0]!.opts.title).toBe('B');
    expect(recSink(ctx, 0)[0]!.opts.display).toBe('display.pane');
    expect(recSink(ctx, 1)[0]!.opts.title).toBe('C');
    expect(recSink(ctx, 1)[0]!.opts.display).toBe('display.none');
  });

  it('plot family warns + skips in local scope (CE10188)', () => {
    const ctx: RtCtx = mkCtx();
    ctx.scopeDepth = 1;
    const r = call('plot', [floatV(1)], {}, ctx);
    expect(r.kind).toBe('na');
    expect(ctx.plots.length).toBe(0);
    expect(ctx.warnings.some(w => /global scope/.test(w))).toBe(true);
    // same callsite warns once
    call('plot', [floatV(2)], {}, ctx);
    expect(ctx.warnings.filter(w => /global scope/.test(w))).toHaveLength(1);
    // global scope still works
    ctx.scopeDepth = 0;
    call('plot', [floatV(1)], {}, ctx);
    expect(ctx.plots.length).toBe(1);
  });

  it('alertcondition registers the condition but never pushes runtime alerts', () => {
    const ctx: RtCtx = mkCtx();
    call('alertcondition', [boolV(true), strV('xover'), strV('crossed up')], {}, ctx);
    expect(ctx.alerts).toHaveLength(0);
    expect(ctx.alertconditions).toEqual([{ title: 'xover', msg: 'crossed up' }]);
  });
});

// ── drawing quotas + arg aliases ────────────────────────────────────────────

describe('drawing fixes', () => {
  it('line/label/box counts are capped at max_*_count (default 50, oldest dropped)', () => {
    const ctx: RtCtx = mkCtx();
    const sink = new MemoryDrawSink();
    ctx.drawings = [sink];
    for (let i = 0; i < 55; i++) call('line.new', [floatV(i), floatV(1), floatV(i + 1), floatV(2)], {}, ctx);
    expect(ctx.liveLines).toHaveLength(50);
    expect(sink.objects.filter(o => o.kind === 'line')).toHaveLength(50);
    // oldest evicted: first live line is bar 5
    expect(ctx.liveLines![0]!.props.x1).toBe(5);
  });

  it('declared max_lines_count/max_labels_count/max_boxes_count override the default', () => {
    const ctx: RtCtx = mkCtx();
    const sink = new MemoryDrawSink();
    ctx.drawings = [sink];
    ctx.declQuotas = { lines: 2, labels: 3, boxes: 1 };
    for (let i = 0; i < 4; i++) call('line.new', [floatV(i), floatV(1), floatV(i), floatV(2)], {}, ctx);
    for (let i = 0; i < 5; i++) call('label.new', [floatV(i), floatV(1)], {}, ctx);
    for (let i = 0; i < 3; i++) call('box.new', [floatV(i), floatV(1), floatV(i), floatV(2)], {}, ctx);
    expect(ctx.liveLines).toHaveLength(2);
    expect(ctx.liveLabels).toHaveLength(3);
    expect(ctx.liveBoxes).toHaveLength(1);
  });

  it('table.clear/table.merge_cells accept table_id named alias', () => {
    const ctx: RtCtx = mkCtx();
    ctx.drawings = [new MemoryDrawSink()];
    const t = call('table.new', [strV('position.top_right'), intV(2), intV(2)], {}, ctx);
    call('table.cell', [t, intV(0), intV(0), strV('A')], {}, ctx);
    call('table.merge_cells', [t], { table_id: t, start_column: intV(0), start_row: intV(0), end_column: intV(1), end_row: intV(0) }, ctx);
    if (t.kind !== 'table') throw new Error('expected table');
    const props = t.v.props;
    expect(Array.isArray(props.merges)).toBe(true);
    call('table.clear', [t], { table_id: t }, ctx);
    const cells = props.cells;
    if (!(cells instanceof Map)) throw new Error('cells not a Map');
    expect(cells.size).toBe(0);
  });

  it('box.new positional order puts xloc then extend at positions 5/6', () => {
    const ctx: RtCtx = mkCtx();
    ctx.drawings = [new MemoryDrawSink()];
    // box.new(left, top, right, bottom, xloc, extend, border_color, ...)
    const bx = call('box.new', [
      floatV(0), floatV(10), floatV(5), floatV(1),
      strV('xloc.bar_time'), strV('extend.right'),
    ], {}, ctx);
    if (bx.kind !== 'box') throw new Error('expected box');
    expect(bx.v.props.xloc).toBe('xloc.bar_time');
    expect(bx.v.props.extend).toBe('extend.right');
  });
});

// ── time/tz + raw-Series-leak regressions ───────────────────────────────────
// Fixes: timestamp(tz-first) overload, bare calendar vars as series,
// time(tf) period gating, nz/math.sum emitting BarSeries (not raw Series),
// str.format_time honoring its timezone arg.

import { BarSeries } from '../series';
import { parse } from '../parser';
import { runScript } from '../interpreter';

/** Push one minute bar into ctx series at index i (forward-only, like BarCtx).
 *  Series.get(0) always reads the newest slot — callers must push+eval per bar. */
function pushMinuteBar(ctx: BuiltinCtx, i: number): void {
  ctx.barIndex = i;
  ctx.time.set({ kind: 'int', v: i * 60_000 });
  ctx.open.set(floatV(i + 1)); ctx.high.set(floatV(i + 2));
  ctx.low.set(floatV(i)); ctx.close.set(floatV(i + 1));
  ctx.volume.set(floatV(1000 + i));
}

describe('timestamp overloads + timezone', () => {
  it('tz-first: timestamp("Asia/Taipei", y,m,d,h,mi)', () => {
    const r = call('timestamp', [strV('Asia/Taipei'), intV(2024), intV(1), intV(2), intV(8), intV(50)]);
    // 2024-01-02 08:50 Asia/Taipei = 00:50 UTC
    expect(r).toEqual(intV(Date.UTC(2024, 0, 2, 0, 50, 0)));
  });
  it('year-first UTC form still works', () => {
    const r = call('timestamp', [intV(2024), intV(1), intV(2), intV(8), intV(50)]);
    expect(r).toEqual(intV(Date.UTC(2024, 0, 2, 8, 50, 0)));
  });
  it('tz-last named form', () => {
    const r = call('timestamp', [intV(2024), intV(1), intV(2), intV(8), intV(50)], { timezone: strV('Asia/Taipei') });
    expect(r).toEqual(intV(Date.UTC(2024, 0, 2, 0, 50, 0)));
  });
});

describe('time(timeframe) period gating', () => {
  it('returns na except on bars opening a new 60m period', () => {
    const ctx = mkCtx();
    const results = [0, 1, 2, 3, 4, 5].map((i) => {
      pushMinuteBar(ctx, i);
      return call('time', [strV('60')], {}, ctx);
    });
    // bar 0 (t=0, period start) → int; bars 1..5 (t=1..5 min) → na
    expect(results[0]).toEqual(intV(0));
    for (let i = 1; i < 6; i++) expect(results[i]!.kind).toBe('na');
  });
  it('no-arg time() returns current bar time', () => {
    const ctx = mkCtx();
    for (let i = 0; i < 3; i++) pushMinuteBar(ctx, i);
    expect(call('time', [], {}, ctx)).toEqual(intV(120_000));
  });
});

describe('bare calendar vars resolve as series', () => {
  it('getConstant("hour") yields a series with per-bar int values', () => {
    const ctx = mkCtx();
    for (let i = 0; i < 3; i++) pushMinuteBar(ctx, i);
    const c = getConstant('hour', ctx);
    expect(c?.kind).toBe('series');
    if (c?.kind !== 'series') throw new Error('no series');
    // syminfo.timezone unset → UTC; bars are 1-min so all hours = 0
    expect(c.v.cur()).toEqual(intV(0));
    expect(c.v.get(2)).toEqual(intV(0));
  });
  it('call form hour(t) still hits the builtin', () => {
    const ctx = mkCtx();
    pushMinuteBar(ctx, 0);
    const r = call('hour', [intV(3_600_000)], {}, ctx); // 01:00 UTC
    expect(r).toEqual(intV(1));
  });
});

describe('raw Series leak (BarSeries contract)', () => {
  it('nz/mah.sum/liftNums results are BarSeries aliased by bindDeclared', async () => {
    const parsed = parse([
      'indicator("t")',
      'y = nz(close, -1)',
      'z = math.max(close, open)',
      'w = math.sum(close, 2)',
      'plot(y)',
      'plot(z)',
      'plot(w)',
    ].join('\n'));
    const res = await runScript(parsed, mkBars(5));
    for (const [, p] of res.plots) {
      for (const v of p.values) {
        // per-bar values must be scalars — a leaked {kind:'series'} wrapper fails
        expect(['int', 'float', 'na']).toContain(v.kind);
      }
    }
    // z = max(close,open): mkBars close=i+1, open=i+1 → i+1
    const z = [...res.plots.values()][1]!;
    expect(z.values[4]).toEqual(floatV(5));
  });

  it('nz() returns a BarSeries instance (not raw Series)', () => {
    const ctx = mkCtx();
    for (let i = 0; i < 3; i++) pushMinuteBar(ctx, i);
    const r = call('math.nz', [{ kind: 'series', v: ctx.close }, intV(-1)], {}, ctx);
    expect(r.kind).toBe('series');
    if (r.kind === 'series') expect(r.v).toBeInstanceOf(BarSeries);
  });
});

describe('str.format_time timezone', () => {
  it('formats in the given tz', () => {
    const ms = Date.UTC(2024, 0, 2, 0, 50, 0); // 00:50 UTC = 08:50 Asia/Taipei
    const r = call('str.format_time', [intV(ms), strV('HH:mm'), strV('Asia/Taipei')]);
    expect(r).toEqual(strV('08:50'));
  });
  it('defaults to syminfo.timezone', () => {
    const ctx = mkCtx({ syminfo: { timezone: strV('Asia/Taipei') } });
    const r = call('str.format_time', [intV(Date.UTC(2024, 0, 2, 0, 50, 0)), strV('HH:mm')], {}, ctx);
    expect(r).toEqual(strV('08:50'));
  });
});
