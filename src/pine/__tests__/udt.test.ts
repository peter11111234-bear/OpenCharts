import { beforeEach, describe, expect, it } from 'vitest';
import type { BarData, BuiltinCtx, FieldDecl, MethodDecl, Node, Param, TypeDecl, UdfDecl, Value } from '../contracts';
import { NA, Scope, Series } from '../contracts';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import {
  UDT_REGISTRY,
  bindUdtGlobalScope,
  callUdtMethod,
  getField,
  getUdtMethod,
  hasUdtMethod,
  isUdtType,
  newUdt,
  normalizeSelfType,
  parseArrayElemType,
  registerMethod,
  registerType,
  setField,
} from '../udt';

// ── AST helpers (parser output shapes, hand-built) ──────────────────────────

const num = (v: number): Node => ({ type: 'num', v, isInt: true });
const ident = (name: string): Node => ({ type: 'ident', name });
const member = (obj: Node, prop: string): Node => ({ type: 'member', obj, prop });
const binary = (op: string, left: Node, right: Node): Node => ({ type: 'binary', op, left, right });
const field = (name: string, typeAnn: string, def?: Node): FieldDecl =>
  ({ type: 'field', name, typeAnn, default: def });

// ── minimal BuiltinCtx; callUdf binds params and evals the method body ──────

function evalNode(n: Node, scope: Scope): Value {
  switch (n.type) {
    case 'num': return { kind: 'int', v: n.v };
    case 'ident': {
      const v = scope.lookup(n.name);
      if (v instanceof Series) return v.cur();
      if (v === undefined) throw new Error(`unknown ident ${n.name}`);
      return v;
    }
    case 'member': {
      const obj = evalNode(n.obj, scope);
      return getField(obj, n.prop);
    }
    case 'binary': {
      const l = evalNode(n.left, scope);
      const r = evalNode(n.right, scope);
      const lv = l.kind === 'int' || l.kind === 'float' ? l.v : NaN;
      const rv = r.kind === 'int' || r.kind === 'float' ? r.v : NaN;
      return { kind: 'int', v: n.op === '+' ? lv + rv : n.op === '-' ? lv - rv : lv * rv };
    }
    default:
      return NA;
  }
}

function callUdfSpy(fn: UdfDecl, args: Value[]): Value {
  const scope = new Scope(fn.closure);
  fn.params.forEach((p: Param, i: number) => scope.define(p.name, args[i] ?? NA));
  const body = Array.isArray(fn.body) ? fn.body : [fn.body];
  let last: Value = { kind: 'void' };
  for (const stmt of body) last = evalNode(stmt, scope);
  return last;
}

function mkCtx(): BuiltinCtx {
  const s = new Series();
  return {
    barIndex: 0, barCount: 1,
    open: s, high: s, low: s, close: s, volume: s,
    time: s, hl2: s, hlc3: s, ohlc4: s, hlcc4: s,
    plots: [], drawings: [], warnings: [], alerts: [],
    syminfo: {},
    timeframe: { period: '1D', multiplier: 1, isseconds: false, isminutes: false, isdaily: true, isweekly: false, ismonthly: false, isintraday: false },
    callUdf: callUdfSpy,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

const typeA: TypeDecl = {
  type: 'typedecl', name: 'A',
  fields: [field('x', 'int'), field('y', 'int', num(2))],
};

beforeEach(() => UDT_REGISTRY.reset());

describe('registerType / newUdt', () => {
  it('binds positional args and applies defaults: A.new(1) → x=1, y=2', () => {
    registerType(typeA);
    const a = newUdt('A', [{ kind: 'int', v: 1 }]);
    expect(a.typeName).toBe('A');
    expect(getField(a, 'x')).toEqual({ kind: 'int', v: 1 });
    expect(getField(a, 'y')).toEqual({ kind: 'int', v: 2 });
  });

  it('fills missing fields with na when no default', () => {
    registerType({ type: 'typedecl', name: 'B', fields: [field('a', 'int'), field('b', 'float')] });
    const b = newUdt('B', []);
    expect(getField(b, 'a')).toEqual(NA);
    expect(getField(b, 'b')).toEqual(NA);
  });

  it('binds named args by field name', () => {
    registerType(typeA);
    const a = newUdt('A', [], { y: { kind: 'int', v: 9 } });
    expect(getField(a, 'x')).toEqual(NA);
    expect(getField(a, 'y')).toEqual({ kind: 'int', v: 9 });
  });

  it('throws on unknown type, extra args, unknown named field', () => {
    registerType(typeA);
    expect(() => newUdt('Nope', [])).toThrow(/unknown type 'Nope'/);
    expect(() => newUdt('A', [NA, NA, NA])).toThrow(/at most 2 arguments/);
    expect(() => newUdt('A', [], { z: NA })).toThrow(/unknown field 'z'/);
  });
});

describe('field access', () => {
  it('getField reads, setField mutates (a.x := 5)', () => {
    registerType(typeA);
    const a = newUdt('A', [{ kind: 'int', v: 1 }]);
    setField(a, 'x', { kind: 'int', v: 5 });
    expect(getField(a, 'x')).toEqual({ kind: 'int', v: 5 });
    expect(() => getField(a, 'nope')).toThrow(/no field 'nope'/);
    expect(() => setField(a, 'nope', NA)).toThrow(/no field 'nope'/);
  });

  it('getField/setField accept Value-wrapped instances', () => {
    registerType(typeA);
    const v: Value = { kind: 'udt', v: newUdt('A', [{ kind: 'int', v: 7 }]) };
    setField(v, 'x', { kind: 'int', v: 8 });
    expect(getField(v, 'x')).toEqual({ kind: 'int', v: 8 });
  });
});

describe('method dispatch', () => {
  const methodM: MethodDecl = {
    type: 'method', name: 'm', selfType: 'A',
    params: [{ name: 's', typeAnn: 'A' }],
    body: binary('+', member(ident('s'), 'x'), num(1)),
  };

  it('a.m() → s.x + 1 (with self in params)', () => {
    registerType(typeA);
    registerMethod(methodM);
    const a = newUdt('A', [{ kind: 'int', v: 1 }]);
    bindUdtGlobalScope(new Scope());
    expect(callUdtMethod(a, 'm', [], mkCtx())).toEqual({ kind: 'int', v: 2 });
  });

  it('normalizes self param when parser excludes it from params', () => {
    // Convention: when params omit the self param, bodies refer to it as `self`
    // (registerMethod injects {name:'self', typeAnn:selfType} at params[0]).
    registerType(typeA);
    registerMethod({
      ...methodM,
      params: [],
      body: binary('+', member(ident('self'), 'x'), num(1)),
    });
    const def = getUdtMethod('A', 'm');
    expect(def?.params).toHaveLength(1);
    expect(def?.params[0]?.typeAnn).toBe('A');
    const a = newUdt('A', [{ kind: 'int', v: 1 }]);
    expect(callUdtMethod(a, 'm', [], mkCtx())).toEqual({ kind: 'int', v: 2 });
  });

  it('binds extra args after self', () => {
    registerType(typeA);
    registerMethod({
      type: 'method', name: 'add', selfType: 'A',
      params: [{ name: 's', typeAnn: 'A' }, { name: 'n', typeAnn: 'int' }],
      body: binary('+', member(ident('s'), 'x'), ident('n')),
    });
    const a = newUdt('A', [{ kind: 'int', v: 10 }]);
    expect(callUdtMethod(a, 'add', [{ kind: 'int', v: 5 }], mkCtx())).toEqual({ kind: 'int', v: 15 });
  });

  it('dispatches by self type; unknown method throws', () => {
    registerType(typeA);
    registerMethod(methodM);
    expect(hasUdtMethod('A', 'm')).toBe(true);
    expect(hasUdtMethod('A', 'nope')).toBe(false);
    const a = newUdt('A', [{ kind: 'int', v: 1 }]);
    expect(() => callUdtMethod(a, 'nope', [], mkCtx())).toThrow(/not defined for type 'A'/);
  });

  it('method sees globals via bindUdtGlobalScope', () => {
    registerType(typeA);
    registerMethod({
      type: 'method', name: 'g', selfType: 'A',
      params: [{ name: 's', typeAnn: 'A' }],
      body: binary('+', member(ident('s'), 'x'), ident('gvar')),
    });
    const g = new Scope();
    g.define('gvar', { kind: 'int', v: 100 });
    bindUdtGlobalScope(g);
    const a = newUdt('A', [{ kind: 'int', v: 1 }]);
    expect(callUdtMethod(a, 'g', [], mkCtx())).toEqual({ kind: 'int', v: 101 });
  });
});

describe('arrays of UDT / nested UDT', () => {
  it('stores typed UDT arrays in fields: M.objs is A[]', () => {
    registerType(typeA);
    registerType({ type: 'typedecl', name: 'M', fields: [field('objs', 'A[]')] });
    const a1 = newUdt('A', [{ kind: 'int', v: 1 }]);
    const a2 = newUdt('A', [{ kind: 'int', v: 2 }]);
    // array.new<A>() → {kind:'array'} holding udt Values
    const arr: Value = {
      kind: 'array',
      v: [{ kind: 'udt', v: a1 }, { kind: 'udt', v: a2 }],
    };
    const m = newUdt('M', [arr]);
    const objs = getField(m, 'objs');
    expect(objs.kind).toBe('array');
    if (objs.kind === 'array') {
      expect(getField(objs.v[0]!, 'x')).toEqual({ kind: 'int', v: 1 });
      expect(getField(objs.v[1]!, 'x')).toEqual({ kind: 'int', v: 2 });
    }
  });

  it('empty array.new<A>(0) binds to A[] field', () => {
    registerType(typeA);
    registerType({ type: 'typedecl', name: 'M', fields: [field('objs', 'array<A>')] });
    const m = newUdt('M', [{ kind: 'array', v: [] }]);
    expect(getField(m, 'objs')).toEqual({ kind: 'array', v: [] });
  });

  it('parseArrayElemType recognizes T[] and array<T>', () => {
    expect(parseArrayElemType('A[]')).toBe('A');
    expect(parseArrayElemType('array<A>')).toBe('A');
    expect(parseArrayElemType('array<int>')).toBe('int');
    expect(parseArrayElemType('int')).toBeNull();
    expect(parseArrayElemType('A[][]')).toBe('A[]');
  });

  it('mutation through array element reference is visible', () => {
    registerType(typeA);
    const a = newUdt('A', [{ kind: 'int', v: 1 }]);
    const arr: Value = { kind: 'array', v: [{ kind: 'udt', v: a }] };
    if (arr.kind === 'array') setField(arr.v[0]!, 'x', { kind: 'int', v: 42 });
    expect(getField(a, 'x')).toEqual({ kind: 'int', v: 42 });
  });
});

describe('registry introspection', () => {
  it('isUdtType + UDT_REGISTRY contents', () => {
    registerType(typeA);
    expect(isUdtType('A')).toBe(true);
    expect(isUdtType('B')).toBe(false);
    expect(UDT_REGISTRY.types.get('A')?.fields.map((f) => f.name)).toEqual(['x', 'y']);
    UDT_REGISTRY.reset();
    expect(isUdtType('A')).toBe(false);
  });
});

// ── methods on builtin container types ──────────────────────────────

/** mkBars: close = i + 1. */
function mkBars(n: number): BarData[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 60_000,
    open: i + 1,
    high: i + 2,
    low: i,
    close: i + 1,
    volume: 1000 + i,
  }));
}

describe('methods on builtin types', () => {
  it('array<float> selfType registers under the base kind', () => {
    registerMethod({
      type: 'method', name: 'bump', selfType: 'array<float>',
      params: [{ name: 'self', typeAnn: 'array<float>' }, { name: 'n', typeAnn: 'int' }],
      body: binary('+', ident('n'), num(1)),
    });
    expect(hasUdtMethod('array', 'bump')).toBe(true);
    expect(hasUdtMethod('array<float>', 'bump')).toBe(true);
    expect(getUdtMethod('array<float>', 'bump')?.name).toBe('bump');
    const arr: Value = { kind: 'array', v: [] };
    expect(callUdtMethod(arr, 'bump', [{ kind: 'int', v: 41 }], mkCtx()))
      .toEqual({ kind: 'int', v: 42 });
  });

  it('map<string,int> and float[] selfTypes normalize to map/array', () => {
    registerMethod({
      type: 'method', name: 'k', selfType: 'map<string,int>',
      params: [{ name: 'self', typeAnn: 'map<string,int>' }],
      body: num(1),
    });
    registerMethod({
      type: 'method', name: 'last', selfType: 'float[]',
      params: [{ name: 'self', typeAnn: 'float[]' }],
      body: num(2),
    });
    expect(hasUdtMethod('map', 'k')).toBe(true);
    expect(hasUdtMethod('array', 'last')).toBe(true);
  });

  it('normalizeSelfType strips qualifiers, generics, array suffixes', () => {
    expect(normalizeSelfType('array<float>')).toBe('array');
    expect(normalizeSelfType('map<string,int>')).toBe('map');
    expect(normalizeSelfType('map<string,array<int>>')).toBe('map');
    expect(normalizeSelfType('float[]')).toBe('array');
    expect(normalizeSelfType('series float')).toBe('float');
    expect(normalizeSelfType('series array<float>')).toBe('array');
    expect(normalizeSelfType('Level')).toBe('Level');
    expect(normalizeSelfType('int')).toBe('int');
  });

  it('a.firstOr(0) dispatches on an array receiver (full script)', async () => {
    const src = [
      'method firstOr(array<float> self, float fb) => self.size() > 0 ? self.get(0) : fb',
      'var a = array.new<float>()',
      'if bar_index == 0',
      '    a.push(3.5)',
      'plot(a.firstOr(0.0))',
      'plot(a.size())',
    ].join('\n');
    const r = await runScript(parse(src), mkBars(3));
    const vals = [...r.plots.values()].map(p =>
      p.values.map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na')));
    expect(vals[0]).toEqual([3.5, 3.5, 3.5]);
    expect(vals[1]).toEqual([1, 1, 1]);
  });

  it('a.push stays the builtin when a user array method exists', async () => {
    const src = [
      'method sz(array<float> self) => self.size() + 1000',
      'var a = array.new<float>()',
      'a.push(1.0)',
      'plot(array.size(a))',
      'plot(a.sz())',
    ].join('\n');
    const r = await runScript(parse(src), mkBars(3));
    const vals = [...r.plots.values()].map(p =>
      p.values.map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na')));
    expect(vals[0]).toEqual([1, 2, 3]);          // builtin array.push ran
    expect(vals[1]).toEqual([1001, 1002, 1003]); // user method dispatched
  });
});
