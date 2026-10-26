// ── matrix.* builtins (subset) ───────────────────────────────────────────────
// Matrices are {kind:'matrix', v: Value[][]} — rows of element Values, mutated
// in place like arrays (Pine reference semantics). Only the row-oriented subset
// scripts use for history buffers is here: new/rows/columns/get/set/row/
// add_row/remove_row. The column count is the first row's length, so a
// `matrix.new(0, n)` reports 0 columns until its first row — TV keeps n.

import { NA } from '../contracts';
import type { BuiltinCtx, Value } from '../contracts';
import { PineRuntimeError } from '../errors';
import { registerBuiltin } from './registry';
import { asNum, bindArgs, unwrapped } from './util';

const VOID: Value = { kind: 'void' };

const asRows = (v: Value | undefined): Value[][] | null => {
  if (v === undefined) return null;
  const u = unwrapped(v)!;
  return u.kind === 'matrix' ? u.v : null;
};
const asArr = (v: Value | undefined): Value[] | null => {
  if (v === undefined) return null;
  const u = unwrapped(v)!;
  return u.kind === 'array' ? u.v : null;
};
const cols = (m: Value[][]): number => m[0]?.length ?? 0;

/** Integer arg, `def` when absent/na; out of [0, max] is a runtime error (TV). */
const indexArg = (bound: Map<string, Value>, name: string, def: number, max: number, what: string): number => {
  const v = bound.get(name);
  const i = v === undefined || v.kind === 'na' ? def : Math.trunc(asNum(v));
  if (!(i >= 0 && i <= max)) throw new PineRuntimeError(`matrix ${what} index ${i} is out of bounds (0..${max})`);
  return i;
};

/** Bind args and hand the matrix receiver to `f`; non-matrix receivers → na. */
const withMatrix = (order: readonly string[], f: (m: Value[][], bound: Map<string, Value>) => Value) =>
  (_ctx: BuiltinCtx, args: Value[], named: Record<string, Value>): Value => {
    const bound = bindArgs(args, named, order);
    const m = asRows(bound.get('id'));
    return m === null ? NA : f(m, bound);
  };

// matrix.new<T>(rows=0, columns=0, initial_value=na) — the parser drops <T>.
registerBuiltin('matrix', 'new', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['rows', 'columns', 'initial_value']);
  const n = (k: string) => { const v = bound.get(k); return v === undefined || v.kind === 'na' ? 0 : Math.max(0, Math.trunc(asNum(v))); };
  const init = unwrapped(bound.get('initial_value') ?? NA)!;
  const rows: Value[][] = [];
  for (let r = 0, c = n('columns'), nr = n('rows'); r < nr; r++) rows.push(new Array<Value>(c).fill(init));
  return { kind: 'matrix', v: rows };
}, false);

registerBuiltin('matrix', 'rows', withMatrix(['id'], (m) => ({ kind: 'int', v: m.length })), false);
registerBuiltin('matrix', 'columns', withMatrix(['id'], (m) => ({ kind: 'int', v: cols(m) })), false);

registerBuiltin('matrix', 'get', withMatrix(['id', 'row', 'column'], (m, b) => {
  const r = indexArg(b, 'row', 0, m.length - 1, 'row');
  return m[r]![indexArg(b, 'column', 0, cols(m) - 1, 'column')]!;
}), false);

registerBuiltin('matrix', 'set', withMatrix(['id', 'row', 'column', 'value'], (m, b) => {
  const r = indexArg(b, 'row', 0, m.length - 1, 'row');
  m[r]![indexArg(b, 'column', 0, cols(m) - 1, 'column')] = unwrapped(b.get('value') ?? NA)!;
  return VOID;
}), false);

// row() returns a copy, like TV: editing it does not touch the matrix.
registerBuiltin('matrix', 'row', withMatrix(['id', 'row'], (m, b) =>
  ({ kind: 'array', v: [...m[indexArg(b, 'row', 0, m.length - 1, 'row')]!] })), false);

// add_row(id, row=rows, array_id) — the array's elements are copied in; an
// empty matrix takes its column count from the first row added.
registerBuiltin('matrix', 'add_row', withMatrix(['id', 'row', 'array_id'], (m, b) => {
  const at = indexArg(b, 'row', m.length, m.length, 'row');
  const src = asArr(b.get('array_id'));
  const width = m.length > 0 ? cols(m) : (src?.length ?? 0);
  if (src !== null && src.length !== width) {
    throw new PineRuntimeError(`matrix.add_row: array size ${src.length} does not match the ${width} columns`);
  }
  m.splice(at, 0, src !== null ? [...src] : new Array<Value>(width).fill(NA));
  return VOID;
}), false);

// remove_row(id, row=rows-1) → the removed row as an array.
registerBuiltin('matrix', 'remove_row', withMatrix(['id', 'row'], (m, b) => {
  const at = indexArg(b, 'row', m.length - 1, m.length - 1, 'row');
  return { kind: 'array', v: m.splice(at, 1)[0]! };
}), false);
