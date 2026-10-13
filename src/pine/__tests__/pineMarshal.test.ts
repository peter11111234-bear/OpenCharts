import { describe, expect, it } from 'vitest';
import { NA, Series } from '../contracts';
import type { BuiltinFn, DrawObj, RunResult, Value } from '../contracts';
import { PineRuntimeError } from '../errors';
import { marshalError, sanitizeDrawObj, sanitizeRunResult, sanitizeValue } from '../pineMarshal';

const fn: BuiltinFn = () => NA;
const fval: Value = { kind: 'function', v: fn };

describe('sanitizeValue', () => {
  it('passes primitives through as shallow copies', () => {
    expect(sanitizeValue({ kind: 'float', v: 1.5 })).toEqual({ kind: 'float', v: 1.5 });
    expect(sanitizeValue({ kind: 'bool', v: true })).toEqual({ kind: 'bool', v: true });
    expect(sanitizeValue({ kind: 'string', v: 'x' })).toEqual({ kind: 'string', v: 'x' });
    expect(sanitizeValue({ kind: 'color', v: 'rgba(0,0,0,1)' })).toEqual({ kind: 'color', v: 'rgba(0,0,0,1)' });
    expect(sanitizeValue(NA)).toEqual({ kind: 'na' });
  });

  it('function → NA, void → NA', () => {
    expect(sanitizeValue(fval)).toEqual(NA);
    expect(sanitizeValue({ kind: 'void' })).toEqual(NA);
  });

  it('series resolves to cur() value', () => {
    const s = new Series();
    s.set({ kind: 'float', v: 42 });
    expect(sanitizeValue({ kind: 'series', v: s })).toEqual({ kind: 'float', v: 42 });
  });

  it('series with empty history → NA', () => {
    expect(sanitizeValue({ kind: 'series', v: new Series() })).toEqual(NA);
  });

  it('nested array-of-function: functions become NA elements', () => {
    const arr: Value = { kind: 'array', v: [{ kind: 'int', v: 1 }, fval, { kind: 'array', v: [fval] }] };
    expect(sanitizeValue(arr)).toEqual({
      kind: 'array',
      v: [{ kind: 'int', v: 1 }, NA, { kind: 'array', v: [NA] }],
    });
  });

  it('udt fields recurse (nested function → NA)', () => {
    const udt: Value = {
      kind: 'udt',
      v: { typeName: 'Point', fields: new Map<string, Value>([['x', { kind: 'float', v: 3 }], ['cb', fval]]) },
    };
    const out = sanitizeValue(udt);
    expect(out.kind).toBe('udt');
    if (out.kind !== 'udt') return;
    expect(out.v.typeName).toBe('Point');
    expect(out.v.fields).toBeInstanceOf(Map);
    expect(out.v.fields.get('x')).toEqual({ kind: 'float', v: 3 });
    expect(out.v.fields.get('cb')).toEqual(NA);
  });

  it('map recurses entries into a fresh Map', () => {
    const m: Value = { kind: 'map', v: new Map<string, Value>([['a', fval], ['b', { kind: 'string', v: 's' }]]) };
    const out = sanitizeValue(m);
    expect(out.kind).toBe('map');
    if (out.kind !== 'map') return;
    expect(out.v).not.toBe(m.v);
    expect(out.v.get('a')).toEqual(NA);
    expect(out.v.get('b')).toEqual({ kind: 'string', v: 's' });
  });
  it('self-referencing udt collapses the cycle to NA instead of recursing forever', () => {
    const udt: Value = { kind: 'udt', v: { typeName: 'Node', fields: new Map() } };
    udt.v.fields.set('self', udt); // a.f := a
    const out = sanitizeValue(udt);
    expect(out.kind).toBe('udt');
    if (out.kind !== 'udt') return;
    expect(out.v.fields.get('self')).toEqual(NA);
    expect(() => structuredClone(out)).not.toThrow();
  });

  it('shared non-cyclic reference between siblings still clones twice', () => {
    const shared: Value = { kind: 'array', v: [{ kind: 'int', v: 7 }] };
    const out = sanitizeValue({ kind: 'array', v: [shared, shared] });
    expect(out).toEqual({ kind: 'array', v: [shared, { kind: 'array', v: [{ kind: 'int', v: 7 }] }] });
    // both branches sanitized independently — the second is NOT the cycle collapse
    if (out.kind === 'array') expect(out.v[1]!.kind).toBe('array');
  });
});

describe('sanitizeDrawObj', () => {
  it('table props.cells Map survives the walk', () => {
    const cells = new Map<string, unknown>([['0,0', 'hi'], ['0,1', 7]]);
    const table: DrawObj = { id: 1, kind: 'table', props: { cells, border_width: 1 } };
    const out = sanitizeDrawObj(table);
    expect(out).toEqual({ id: 1, kind: 'table', props: { cells, border_width: 1 } });
    expect(out.props['cells']).toBeInstanceOf(Map);
    expect(out.props['cells']).not.toBe(cells);
    expect((out.props['cells'] as Map<string, unknown>).get('0,0')).toBe('hi');
  });

  it('linefill props.line1 (DrawObj ref) recurses', () => {
    const line1: DrawObj = { id: 2, kind: 'line', props: { x1: 0, fn: () => 1 } };
    const lf: DrawObj = { id: 3, kind: 'linefill', props: { line1, line2: { id: 4, kind: 'line', props: {} } } };
    const out = sanitizeDrawObj(lf);
    const l1 = out.props['line1'] as DrawObj;
    expect(l1).toEqual({ id: 2, kind: 'line', props: { x1: 0, fn: null } });
    expect(out.props['line2']).toEqual({ id: 4, kind: 'line', props: {} });
  });

  it('Value-shaped prop routes through sanitizeValue', () => {
    const o: DrawObj = { id: 5, kind: 'label', props: { extra: { kind: 'function', v: fn } } };
    expect(sanitizeDrawObj(o).props['extra']).toEqual(NA);
  });

  it('class instances in props → null', () => {
    const o: DrawObj = { id: 6, kind: 'box', props: { s: new Series(), keep: { a: 1 } } };
    const out = sanitizeDrawObj(o);
    expect(out.props['s']).toBeNull();
    expect(out.props['keep']).toEqual({ a: 1 });
  });

  it('Map prop with non-cloneable key still sanitizes', () => {
    const m = new Map<unknown, unknown>([[fn, { kind: 'int', v: 1 }]]);
    const o: DrawObj = { id: 1, kind: 'table', props: { cells: m } };
    const out = sanitizeDrawObj(o);
    expect(() => structuredClone(out)).not.toThrow();
    const cells = out.props.cells as Map<unknown, unknown>;
    expect([...cells.keys()]).toEqual([null]); // function key → null
  });

  it('plain prop object with a `kind` string but no `v` is walked, not misrouted to sanitizeValue', () => {
    const o: DrawObj = { id: 1, kind: 'label', props: { meta: { kind: 'line', text: 'not a Value' } } };
    const out = sanitizeDrawObj(o);
    expect(out.props.meta).toEqual({ kind: 'line', text: 'not a Value' });
  });
});

describe('sanitizeRunResult', () => {
  it('structuredClone round-trips and deep-equals expected', () => {
    const r: RunResult = {
      plots: new Map([
        ['close', {
          index: 0,
          time: [1000, 2000],
          values: [{ kind: 'float', v: 1 }, fval], // function Value → NA
          opts: { title: 'close', color: 'rgba(1,2,3,1)' },
          colors: ['rgba(1,2,3,1)', undefined],
        }],
      ]),
      drawings: [{ id: 1, kind: 'line', props: { x1: 0, y1: 1, s: new Series() } }],
      fills: [{ plot1: 0, plot2: 1, color: 'red' }],
      bgcolors: new Map([[0, new Map([['s', 'blue']])]]),
      barcolors: new Map(),
      alerts: [{ id: 'a', msg: 'm' }],
      alertconditions: [{ title: 't', msg: 'm' }],
      logs: [],
      warnings: ['w'],
      inputs: [{ id: 'i', name: 'n', type: 'int', defval: 1 }],
      props: [],
      title: 'T',
      overlay: true,
    };
    const out = structuredClone(sanitizeRunResult(r));
    expect(out).toEqual({
      ...r,
      plots: new Map([['close', {
        index: 0, time: [1000, 2000],
        values: [{ kind: 'float', v: 1 }, NA],
        opts: { title: 'close', color: 'rgba(1,2,3,1)' },
        colors: ['rgba(1,2,3,1)', undefined],
      }]]),
      drawings: [{ id: 1, kind: 'line', props: { x1: 0, y1: 1, s: null } }],
    });
  });

  it('raw unsanitized result throws under structuredClone (proves sanitize is load-bearing)', () => {
    const r: RunResult = {
      plots: new Map([['p', { index: 0, time: [], values: [fval], opts: {}, colors: [] }]]),
      drawings: [], fills: [], bgcolors: new Map(), barcolors: new Map(),
      alerts: [], alertconditions: [], logs: [], warnings: [], inputs: [], props: [],
      title: '', overlay: false,
    };
    expect(() => structuredClone(r)).toThrow();
    expect(() => structuredClone(sanitizeRunResult(r))).not.toThrow();
  });
});

describe('marshalError', () => {
  it('PineRuntimeError carries line/col', () => {
    const e = marshalError(new PineRuntimeError('boom', { line: 3, col: 7 }));
    expect(e).toMatchObject({ name: 'PineRuntimeError', message: 'boom', line: 3, col: 7 });
    expect(typeof e.stack === 'string' || e.stack === undefined).toBe(true);
  });

  it('plain Error → name/message only', () => {
    expect(marshalError(new TypeError('x'))).toMatchObject({ name: 'TypeError', message: 'x' });
  });

  it('non-Error → String(e)', () => {
    expect(marshalError('oops')).toEqual({ name: 'Error', message: 'oops' });
  });
});
