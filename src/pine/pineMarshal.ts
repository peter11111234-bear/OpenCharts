// ── Pine worker marshalling (B4) ─────────────────────────────────────────────
// Sanitizes interpreter outputs into structured-clone-safe shapes before they
// cross postMessage. Whitelist: unknown/class instances collapse to null/NA
// instead of throwing DataCloneError.

import { NA } from './contracts';
import type { DrawObj, RunResult, Value } from './contracts';
import { PineRuntimeError } from './errors';
import type { FailError } from './pineWorkerProto';

const DRAW_KINDS: Record<string, true> = {
  line: true, label: true, box: true, table: true, polyline: true, linefill: true,
};

// A Value or DrawObj both expose a string `kind`; DrawObj also has numeric id + props.
function isDrawObj(x: object): x is DrawObj {
  if (!('kind' in x) || typeof x.kind !== 'string' || !(x.kind in DRAW_KINDS)) return false;
  return 'id' in x && 'props' in x;
}

/** Value kinds we know how to marshal — the 'kind' heuristic in
 *  sanitizePropVal must match this set, otherwise a plain prop object that
 *  merely has a string `kind` field would be misrouted and crash on `v`. */
const VALUE_KINDS: Record<string, true> = {
  na: true, int: true, float: true, bool: true, string: true, color: true,
  line: true, label: true, box: true, table: true, polyline: true, linefill: true,
  array: true, matrix: true, map: true, udt: true, function: true, void: true,
  series: true,
};

/** Deep-sanitize a Value for postMessage. Non-serializable kinds
 *  (function/void) collapse to NA; series resolves to its current value.
 *  `seen` breaks reference cycles — a Pine UDT can legally self-reference
 *  (a.f := a), which would otherwise recurse into a RangeError. */
export function sanitizeValue(v: Value, seen: Set<object> = new Set()): Value {
  // `seen` marks ancestors on the CURRENT recursion path only — entries are
  // deleted after their subtree returns, so shared (non-cyclic) references
  // between sibling branches still clone correctly. A Pine UDT can legally
  // self-reference (a.f := a); without the guard that recurses forever.
  switch (v.kind) {
    case 'na': case 'int': case 'float': case 'bool': case 'string': case 'color':
      return { ...v } as Value;
    case 'array': {
      if (seen.has(v.v)) return NA;
      seen.add(v.v);
      const items = v.v.map(x => sanitizeValue(x, seen));
      seen.delete(v.v);
      return { kind: 'array', v: items };
    }
    case 'matrix': {
      if (seen.has(v.v)) return NA;
      seen.add(v.v);
      const rows = v.v.map(row => row.map(x => sanitizeValue(x, seen)));
      seen.delete(v.v);
      return { kind: 'matrix', v: rows };
    }
    case 'map': {
      if (seen.has(v.v)) return NA;
      seen.add(v.v);
      const out = new Map<string, Value>();
      for (const [k, val] of v.v) out.set(k, sanitizeValue(val, seen));
      seen.delete(v.v);
      return { kind: 'map', v: out };
    }
    case 'udt': {
      if (seen.has(v.v)) return NA;
      seen.add(v.v);
      const fields = new Map<string, Value>();
      for (const [k, val] of v.v.fields) fields.set(k, sanitizeValue(val, seen));
      seen.delete(v.v);
      return { kind: 'udt', v: { typeName: v.v.typeName, fields } };
    }
    case 'series':
      return sanitizeValue(v.v.cur(), seen);
    case 'line': case 'label': case 'box': case 'table': case 'polyline': case 'linefill':
      return { kind: v.kind, v: sanitizeDrawObj(v.v, seen) };
    // function / void — nothing cloneable inside
    default:
      return NA;
  }
}

/** Sanitize a DrawObj: keep id/kind, generic-walk props. */
export function sanitizeDrawObj(o: DrawObj, seen: Set<object> = new Set()): DrawObj {
  if (seen.has(o)) return { id: o.id, kind: o.kind, props: {} };
  seen.add(o);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o.props)) props[k] = sanitizePropVal(v, seen);
  seen.delete(o);
  return { id: o.id, kind: o.kind, props };
}

// props walk: primitives pass; Array/Map/plain objects recurse; Value-shaped
// objects (kind ∈ VALUE_KINDS and a `v` field) route through sanitizeValue,
// DrawObj through sanitizeDrawObj; class instances and functions become null
// (uncloneable). `seen` is path-scoped (add before / delete after recursion).
function sanitizePropVal(x: unknown, seen: Set<object>): unknown {
  if (x === null || typeof x !== 'object') {
    return typeof x === 'function' ? null : x;
  }
  if (seen.has(x)) return null;
  if (Array.isArray(x)) {
    seen.add(x);
    const out = x.map(v => sanitizePropVal(v, seen));
    seen.delete(x);
    return out;
  }
  if (x instanceof Map) {
    seen.add(x);
    const out = new Map<unknown, unknown>();
    // Keys sanitize too — a non-cloneable key would still throw
    // DataCloneError at postMessage even with clean values.
    for (const [k, v] of x) out.set(sanitizePropVal(k, seen), sanitizePropVal(v, seen));
    seen.delete(x);
    return out;
  }
  if (isDrawObj(x)) return sanitizeDrawObj(x, seen);
  if ('kind' in x && typeof x.kind === 'string' && x.kind in VALUE_KINDS && 'v' in x) {
    return sanitizeValue(x as Value, seen);
  }
  const proto = Object.getPrototypeOf(x);
  if (proto === Object.prototype || proto === null) {
    seen.add(x);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) out[k] = sanitizePropVal(v, seen);
    seen.delete(x);
    return out;
  }
  return null; // class instance — not cloneable
}

/** Sanitize a RunResult. Plots/drawings need deep work; every other field is
 *  already cloneable and passes by reference. One path-scoped `seen` set is
 *  shared across fields so a graph spanning plots→drawings still can't loop. */
export function sanitizeRunResult(r: RunResult): RunResult {
  const seen = new Set<object>();
  const plots: RunResult['plots'] = new Map();
  for (const [title, p] of r.plots) {
    plots.set(title, { ...p, values: p.values.map(v => sanitizeValue(v, seen)) });
  }
  return {
    ...r,
    plots,
    drawings: r.drawings.map(d => sanitizeDrawObj(d, seen)),
  };
}

/** Marshal a thrown value for the `fail` message. */
export function marshalError(e: unknown): FailError {
  if (e instanceof PineRuntimeError) {
    return { name: e.name, message: e.message, stack: e.stack, line: e.line, col: e.col };
  }
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  return { name: 'Error', message: String(e) };
}
