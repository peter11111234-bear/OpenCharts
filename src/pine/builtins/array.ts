// ── array.* builtins ────────────────────────────────────────────────────────
// Arrays are {kind:'array', v:Value[]} — mutated in place by push/set/sort
// (Pine reference semantics). Pine v6 index semantics: negative indices count
// from the end; out-of-range access raises PineRuntimeError (TV behavior).

import { NA } from '../contracts';
import type { BuiltinCtx, BuiltinFn, Value } from '../contracts';
import { PineRuntimeError } from '../errors';
import { registerBuiltin, registerConstant } from './registry';
import { asNum, asStr, bindArgs, truthy, unwrapped } from './util';
import { toDisplay } from './str';

// Arrays hold SNAPSHOT values (TV semantics): `array.push(a, close)` stores the
// current close, not a live series handle. Storing the raw `{kind:'series'}`
// wrapper made every slot written from the same call site alias one live series
// — all of them then read back the CURRENT bar's value, so a rolling buffer of
// pivots read back duplicates (見高K tab_cb → ABC/harmonic lines vanished).
const snap = (v: Value | undefined): Value => unwrapped(v) ?? NA;
const VOID: Value = { kind: 'void' };
const arrVal = (v: Value[]): Value => ({ kind: 'array', v });
// Builtin args arrive as {kind:'series'} when the ident is series-bound (e.g.
// `a = request.security_lower_tf(...)`); unwrap cur() before the kind check —
// same convention as core.ts's unseries helper.
const asArr = (v: Value | undefined): Value[] | null => {
  const u = v && v.kind === 'series' ? v.v.cur() : v;
  return u && u.kind === 'array' ? u.v : null;
};

type Bound = Map<string, Value>;
const bind = (args: Value[], named: Record<string, Value>, order: readonly string[]): Bound =>
  bindArgs(args, named, order);
const idxOf = (bound: Bound, name: string, def: number): number => {
  const v = bound.get(name);
  return v === undefined || v.kind === 'na' ? def : Math.trunc(asNum(v));
};

/**
 * Pine v6 index semantics: negative indices count from the array's end
 * (-1 = last element); a resolved index outside `max` raises a runtime error
 * (TV errors on array.get/set/remove/insert out-of-range — never silent na).
 */
const resolveIdx = (bound: Bound, name: string, len: number, max: number): number => {
  const raw = idxOf(bound, name, 0);
  const i = raw < 0 ? len + raw : raw;
  if (i < 0 || i > max) {
    throw new PineRuntimeError(`Index ${raw} is out of bounds, array size is ${len}`);
  }
  return i;
};

/** Clip-style bound for array.slice (v6 clips OOB slice bounds to the range;
 *  negative counts from the end). `def` applies when the arg is absent/na. */
const clipIdx = (v: Value | undefined, len: number, def: number): number => {
  if (v === undefined || v.kind === 'na') return def;
  const raw = Math.trunc(asNum(v));
  return Math.max(0, Math.min(len, raw < 0 ? len + raw : raw));
};

// ── Construction ────────────────────────────────────────────────────────────
// array.new<T>(size=0, initial_value=na) and the typed new_* spellings share
// one implementation — element type is unchecked like TV's dynamic arrays.

const newArray = (ctx: BuiltinCtx, args: Value[], named: Record<string, Value>) => {
  const bound = bind(args, named, ['size', 'initial_value']);
  const raw = idxOf(bound, 'size', 0);
  if (!Number.isFinite(raw)) {
    const msg = `array.new_*: non-finite size coerced to 0 (got ${asStr(bound.get('size')!)}; check upstream math.log/acos or na flow)`;
    if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
  }
  const size = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const init = bound.get('initial_value');
  return arrVal(new Array<Value>(size).fill(init === undefined ? NA : init));
};
registerBuiltin('array', 'new', newArray, { idx: [1], names: ['initial_value'] });
for (const name of ['new_bool', 'new_color', 'new_float', 'new_int', 'new_line', 'new_label', 'new_box', 'new_linefill', 'new_table', 'new_string', 'new_type']) {
  registerBuiltin('array', name, newArray, { idx: [1], names: ['initial_value'] });
}

// Every arg is an element — stash keeps live-series semantics.
registerBuiltin('array', 'from', (_ctx, args) => arrVal(args.slice()), true);

// array.copy(id) — TV: "creates a copy of an existing array". Shallow: element
// Values are shared, so a nested array/map/drawing stays aliased to the same
// object (the copy is an independent *container*).
registerBuiltin('array', 'copy', (_ctx, args, named) => {
  const a = asArr(bind(args, named, ['id']).get('id'));
  return a === null ? NA : arrVal(a.slice());
});

// ── Mutation ────────────────────────────────────────────────────────────────

const mut = (
  order: readonly string[],
  f: (a: Value[], bound: Bound) => Value,
) =>
  (_ctx: BuiltinCtx, args: Value[], named: Record<string, Value>) => {
    const bound = bind(args, named, order);
    const a = asArr(bound.get('id'));
    return a === null ? NA : f(a, bound);
  };

registerBuiltin('array', 'push', mut(['id', 'value'], (a, b) => {
  a.push(snap(b.get('value')));
  return VOID;
}), { idx: [1], names: ['value'] });

registerBuiltin('array', 'unshift', mut(['id', 'value'], (a, b) => {
  a.unshift(snap(b.get('value')));
  return VOID;
}), { idx: [1], names: ['value'] });

registerBuiltin('array', 'pop', mut(['id'], (a) => (a.length === 0 ? NA : a.pop()!)));
registerBuiltin('array', 'shift', mut(['id'], (a) => (a.length === 0 ? NA : a.shift()!)));

registerBuiltin('array', 'set', mut(['id', 'index', 'value'], (a, b) => {
  a[resolveIdx(b, 'index', a.length, a.length - 1)] = snap(b.get('value'));
  return VOID;
}), { idx: [2], names: ['value'] });

registerBuiltin('array', 'insert', mut(['id', 'index', 'value'], (a, b) => {
  a.splice(resolveIdx(b, 'index', a.length, a.length), 0, snap(b.get('value')));
  return VOID;
}), { idx: [2], names: ['value'] });

registerBuiltin('array', 'remove', mut(['id', 'index'], (a, b) => {
  const [r] = a.splice(resolveIdx(b, 'index', a.length, a.length - 1), 1);
  return r ?? NA;
}));

registerBuiltin('array', 'fill', mut(['id', 'value', 'index', 'length'], (a, b) => {
  const v = snap(b.get('value'));
  const start = Math.max(0, idxOf(b, 'index', 0));
  const lenV = b.get('length');
  const len = lenV === undefined || lenV.kind === 'na' ? a.length - start : Math.trunc(asNum(lenV));
  for (let i = start; i < Math.min(a.length, start + len); i++) a[i] = v;
  return VOID;
}), { idx: [1], names: ['value'] });

registerBuiltin('array', 'clear', mut(['id'], (a) => {
  a.length = 0;
  return VOID;
}));

registerBuiltin('array', 'reverse', mut(['id'], (a) => {
  a.reverse();
  return VOID;
}));

// ── Access ──────────────────────────────────────────────────────────────────

registerBuiltin('array', 'get', (_ctx, args, named) => {
  const bound = bind(args, named, ['id', 'index']);
  const a = asArr(bound.get('id'));
  if (a === null) return NA;
  return a[resolveIdx(bound, 'index', a.length, a.length - 1)] ?? NA;
});

registerBuiltin('array', 'size', (_ctx, args, named) => {
  const a = asArr(bind(args, named, ['id']).get('id'));
  return { kind: 'int', v: a === null ? 0 : a.length };
});

registerBuiltin('array', 'first', (_ctx, args, named) => {
  const a = asArr(bind(args, named, ['id']).get('id'));
  return a !== null && a.length > 0 ? a[0]! : NA;
});

registerBuiltin('array', 'last', (_ctx, args, named) => {
  const a = asArr(bind(args, named, ['id']).get('id'));
  return a !== null && a.length > 0 ? a[a.length - 1]! : NA;
});

registerBuiltin('array', 'slice', (_ctx, args, named) => {
  const bound = bind(args, named, ['id', 'index_from', 'index_to']);
  const a = asArr(bound.get('id'));
  if (a === null) return NA;
  // v6: negative bounds count from the end; out-of-range bounds clip.
  const from = clipIdx(bound.get('index_from'), a.length, 0);
  const to = clipIdx(bound.get('index_to'), a.length, a.length);
  return arrVal(a.slice(from, Math.max(from, to)));
});

registerBuiltin('array', 'concat', (_ctx, args, named) => {
  const bound = bind(args, named, ['id1', 'id2']);
  const a = asArr(bound.get('id1'));
  const b = asArr(bound.get('id2'));
  if (a === null || b === null) return NA;
  return arrVal(a.concat(b));
});

// ── Search ──────────────────────────────────────────────────────────────────

/** Structural for scalars, reference for aggregates. */
export function valueEq(a: Value, b: Value): boolean {
  if (a.kind !== b.kind) {
    const an = a.kind === 'int' || a.kind === 'float' ? a.v : null;
    const bn = b.kind === 'int' || b.kind === 'float' ? b.v : null;
    return an !== null && bn !== null && an === bn;
  }
  switch (a.kind) {
    case 'na':
      return true;
    case 'int':
    case 'float':
    case 'string':
    case 'color':
      return (b as Value & { v: typeof a.v }).v === a.v;
    case 'bool':
      return (b as Value & { v: boolean }).v === a.v;
    case 'udt':
    case 'line':
    case 'label':
    case 'box':
    case 'table':
    case 'polyline':
    case 'linefill':
    case 'array':
    case 'matrix':
    case 'map':
      return a.v === (b as Value & { v: unknown }).v;
    default:
      return a === b;
  }
}

registerBuiltin('array', 'includes', (_ctx, args, named) => {
  const bound = bind(args, named, ['id', 'value']);
  const a = asArr(bound.get('id'));
  const v = bound.get('value');
  if (a === null || v === undefined) return NA;
  return { kind: 'bool', v: a.some((e) => valueEq(e, v)) };
}, { idx: [1], names: ['value'] });
const indexOfFn =
  (fromEnd: boolean): BuiltinFn =>
  (_ctx, args, named) => {
    const bound = bind(args, named, ['id', 'value']);
    const a = asArr(bound.get('id'));
    const v = bound.get('value');
    if (a === null || v === undefined) return NA;
    let found = -1;
    if (fromEnd) {
      for (let i = a.length - 1; i >= 0; i--) {
        if (valueEq(a[i]!, v)) { found = i; break; }
      }
    } else {
      for (let i = 0; i < a.length; i++) {
        if (valueEq(a[i]!, v)) { found = i; break; }
      }
    }
    return { kind: 'int', v: found };
  };
registerBuiltin('array', 'indexof', indexOfFn(false), { idx: [1], names: ['value'] });
registerBuiltin('array', 'lastindexof', indexOfFn(true), { idx: [1], names: ['value'] });

// ── Sort / binary search ────────────────────────────────────────────────────

function cmp(a: Value, b: Value): number {
  const an = a.kind === 'int' || a.kind === 'float' ? a.v : null;
  const bn = b.kind === 'int' || b.kind === 'float' ? b.v : null;
  if (an !== null && bn !== null) return an - bn;
  if (a.kind === 'string' && b.kind === 'string') return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  const as = toDisplay(a);
  const bs = toDisplay(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

const isDesc = (bound: Bound): boolean => {
  const o = bound.get('order');
  return o !== undefined && o.kind !== 'na' && asStr(o).includes('descending');
};

registerBuiltin('array', 'sort', mut(['id', 'order'], (a, b) => {
  const d = isDesc(b);
  a.sort((x, y) => (d ? cmp(y, x) : cmp(x, y)));
  return VOID;
}));

registerBuiltin('array', 'sort_indices', (_ctx, args, named) => {
  const bound = bind(args, named, ['id', 'order']);
  const a = asArr(bound.get('id'));
  if (a === null) return NA;
  const d = isDesc(bound);
  const idx = a.map((_v, i) => i).sort((x, y) => (d ? cmp(a[y]!, a[x]!) : cmp(a[x]!, a[y]!)));
  return arrVal(idx.map((i) => ({ kind: 'int', v: i }) as Value));
});

const binSearch =
  (edge: 'any' | 'left' | 'right'): BuiltinFn =>
  (_ctx, args, named) => {
    const bound = bind(args, named, ['id', 'value']);
    const a = asArr(bound.get('id'));
    const v = bound.get('value');
    if (a === null || v === undefined) return NA;
    // TV: returns index if found, else negative insertion hint.
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmp(a[mid]!, v) < 0) lo = mid + 1;
      else hi = mid;
    }
    const ins = lo;
    if (ins < a.length && valueEq(a[ins]!, v)) {
      if (edge === 'right') {
        let r = ins;
        while (r + 1 < a.length && valueEq(a[r + 1]!, v)) r++;
        return { kind: 'int', v: r };
      }
      return { kind: 'int', v: ins }; // leftmost by construction of lower bound
    }
    return { kind: 'int', v: -(ins + 1) };
  };
registerBuiltin('array', 'binary_search', binSearch('any'), { idx: [1], names: ['value'] });
registerBuiltin('array', 'binary_search_leftmost', binSearch('left'), { idx: [1], names: ['value'] });
registerBuiltin('array', 'binary_search_rightmost', binSearch('right'), { idx: [1], names: ['value'] });

// ── Numeric stats ───────────────────────────────────────────────────────────

// Elements stored via array.set/push from a series arg (e.g. `array.set(a, i,
// ta.sma(close, n))`) keep their `{kind:'series'}` wrapper — evaluate them to
// the current-bar scalar before the numeric filter, else max/min/sum/avg
// silently see an empty list and return na (見高K ABC band bug).
const numsOf = (a: Value[]): number[] =>
  a
    .map((e) => (e.kind === 'series' ? e.v.cur() : e))
    .filter((e) => e.kind === 'int' || e.kind === 'float')
    .map((e) => asNum(e));

const stat1 =
  (f: (xs: number[]) => number | null): BuiltinFn =>
  (_ctx, args, named) => {
    const a = asArr(bind(args, named, ['id']).get('id'));
    if (a === null) return NA;
    const r = f(numsOf(a));
    return r === null ? NA : { kind: 'float', v: r };
  };

registerBuiltin('array', 'sum', stat1((xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0))));
registerBuiltin('array', 'avg', stat1((xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length)));
registerBuiltin('array', 'max', stat1((xs) => (xs.length === 0 ? null : Math.max(...xs))));
registerBuiltin('array', 'min', stat1((xs) => (xs.length === 0 ? null : Math.min(...xs))));
registerBuiltin('array', 'range', stat1((xs) => (xs.length === 0 ? null : Math.max(...xs) - Math.min(...xs))));

registerBuiltin('array', 'median', stat1((xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}));

registerBuiltin('array', 'mode', stat1((xs) => {
  if (xs.length === 0) return null;
  const freq = new Map<number, { n: number; first: number }>();
  xs.forEach((x, i) => {
    const e = freq.get(x);
    freq.set(x, { n: (e?.n ?? 0) + 1, first: e?.first ?? i });
  });
  let best: { n: number; first: number; v: number } | null = null;
  for (const [v, e] of freq) {
    if (best === null || e.n > best.n || (e.n === best.n && e.first < best.first)) {
      best = { n: e.n, first: e.first, v };
    }
  }
  return best?.v ?? null;
}));

const varianceCore = (xs: number[], biased: boolean): number | null => {
  const ddof = biased ? 0 : 1;
  if (xs.length <= ddof) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - ddof);
};

registerBuiltin('array', 'variance', (_ctx, args, named) => {
  const bound = bind(args, named, ['id', 'biased']);
  const a = asArr(bound.get('id'));
  if (a === null) return NA;
  const biasedV = bound.get('biased');
  const biased = biasedV === undefined || biasedV.kind === 'na' ? true : truthy(biasedV);
  const r = varianceCore(numsOf(a), biased);
  return r === null ? NA : { kind: 'float', v: r };
});

registerBuiltin('array', 'stdev', (_ctx, args, named) => {
  const bound = bind(args, named, ['id', 'biased']);
  const a = asArr(bound.get('id'));
  if (a === null) return NA;
  const biasedV = bound.get('biased');
  const biased = biasedV === undefined || biasedV.kind === 'na' ? true : truthy(biasedV);
  const r = varianceCore(numsOf(a), biased);
  return r === null ? NA : { kind: 'float', v: Math.sqrt(r) };
});

// ── Boolean / transforms ────────────────────────────────────────────────────

registerBuiltin('array', 'every', (_ctx, args, named) => {
  const a = asArr(bind(args, named, ['id']).get('id'));
  if (a === null) return NA;
  return { kind: 'bool', v: a.every((e) => e.kind !== 'na' && truthy(e)) };
});

registerBuiltin('array', 'some', (_ctx, args, named) => {
  const a = asArr(bind(args, named, ['id']).get('id'));
  if (a === null) return NA;
  return { kind: 'bool', v: a.some((e) => e.kind !== 'na' && truthy(e)) };
});

registerBuiltin('array', 'join', (_ctx, args, named) => {
  const bound = bind(args, named, ['id', 'separator']);
  const a = asArr(bound.get('id'));
  if (a === null) return NA;
  const sepV = bound.get('separator');
  const sep = sepV === undefined || sepV.kind === 'na' ? ', ' : asStr(sepV);
  return { kind: 'string', v: a.map(toDisplay).join(sep) };
});

registerBuiltin('array', 'abs', (_ctx, args, named) => {
  const a = asArr(bind(args, named, ['id']).get('id'));
  if (a === null) return NA;
  return arrVal(
    a.map((e) =>
      e.kind === 'int' || e.kind === 'float' ? { kind: e.kind, v: Math.abs(e.v) } : e,
    ),
  );
});

registerBuiltin('array', 'percentrank', (_ctx, args, named) => {
  const bound = bind(args, named, ['id', 'value']);
  const a = asArr(bound.get('id'));
  const v = bound.get('value');
  if (a === null || v === undefined || v.kind === 'na') return NA;
  const n = numsOf(a);
  if (n.length === 0 || (v.kind !== 'int' && v.kind !== 'float')) return NA;
  const below = n.filter((x) => x <= v.v).length;
  return { kind: 'float', v: (below / n.length) * 100 };
});

registerBuiltin('array', 'standardize', (_ctx, args, named) => {
  const bound = bind(args, named, ['id', 'biased']);
  const a = asArr(bound.get('id'));
  if (a === null) return NA;
  const biasedV = bound.get('biased');
  const biased = biasedV === undefined || biasedV.kind === 'na' ? true : truthy(biasedV);
  const xs = numsOf(a);
  const varr = varianceCore(xs, biased);
  const mean = xs.length === 0 ? 0 : xs.reduce((x, y) => x + y, 0) / xs.length;
  const sd = varr === null ? 0 : Math.sqrt(varr);
  return arrVal(
    a.map((e) =>
      e.kind === 'int' || e.kind === 'float'
        ? { kind: 'float', v: sd === 0 ? 0 : (e.v - mean) / sd }
        : e,
    ),
  );
});

registerBuiltin('array', 'covariance', (_ctx, args, named) => {
  const bound = bind(args, named, ['id1', 'id2', 'biased']);
  const a = asArr(bound.get('id1'));
  const b = asArr(bound.get('id2'));
  if (a === null || b === null) return NA;
  const biasedV = bound.get('biased');
  const biased = biasedV === undefined || biasedV.kind === 'na' ? true : truthy(biasedV);
  const pairs: [number, number][] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if ((x.kind === 'int' || x.kind === 'float') && (y.kind === 'int' || y.kind === 'float')) {
      pairs.push([x.v, y.v]);
    }
  }
  const ddof = biased ? 0 : 1;
  if (pairs.length <= ddof) return NA;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / pairs.length;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / pairs.length;
  const cov = pairs.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / (pairs.length - ddof);
  return { kind: 'float', v: cov };
});

registerBuiltin('array', 'correlation', (_ctx, args, named) => {
  const bound = bind(args, named, ['id1', 'id2', 'biased']);
  const a = asArr(bound.get('id1'));
  const b = asArr(bound.get('id2'));
  if (a === null || b === null) return NA;
  const pairs: [number, number][] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if ((x.kind === 'int' || x.kind === 'float') && (y.kind === 'int' || y.kind === 'float')) {
      pairs.push([x.v, y.v]);
    }
  }
  if (pairs.length === 0) return NA;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / pairs.length;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / pairs.length;
  let sxy = 0;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sx += (x - mx) * (x - mx);
    sy += (y - my) * (y - my);
  }
  const denom = Math.sqrt(sx * sy);
  return denom === 0 ? NA : { kind: 'float', v: sxy / denom };
});

registerBuiltin('array', 'percentile_linear_interpolation', (_ctx, args, named) => {
  const bound = bind(args, named, ['id', 'percentage']);
  const a = asArr(bound.get('id'));
  const p = bound.get('percentage');
  if (a === null || !p || p.kind === 'na') return NA;
  const xs = numsOf(a).sort((x, y) => x - y);
  if (xs.length === 0) return NA;
  const rank = (asNum(p) / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.min(xs.length - 1, lo + 1);
  const frac = rank - lo;
  return { kind: 'float', v: xs[lo]! + (xs[hi]! - xs[lo]!) * frac };
});

registerBuiltin('array', 'percentile_nearest_rank', (_ctx, args, named) => {
  const bound = bind(args, named, ['id', 'percentage']);
  const a = asArr(bound.get('id'));
  const p = bound.get('percentage');
  if (a === null || !p || p.kind === 'na') return NA;
  const xs = numsOf(a).sort((x, y) => x - y);
  if (xs.length === 0) return NA;
  const rank = Math.max(1, Math.ceil((asNum(p) / 100) * xs.length));
  return { kind: 'float', v: xs[Math.min(xs.length - 1, rank - 1)]! };
});

// ── order.* constants ───────────────────────────────────────────────────────

registerConstant('order', 'ascending', { kind: 'string', v: 'order.ascending' });
registerConstant('order', 'descending', { kind: 'string', v: 'order.descending' });
