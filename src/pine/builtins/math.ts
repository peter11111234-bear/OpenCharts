// ── math.* builtins ─────────────────────────────────────────────────────────
// Scalar numeric kernels lifted over Series when any arg is a series.
// `na` propagates through every kernel except max/min/nz (which skip/unwrap).

import { NA } from '../contracts';
import type { BuiltinCtx, BuiltinFn, Value } from '../contracts';
import { BarSeries, LiftedSeries, freezeReader } from '../series';
import { registerBuiltin, registerConstant } from './registry';
import { asNum, bindArgs, numVal } from './util';

// ── Series lifting ──────────────────────────────────────────────────────────
// Returns a number or null (= na result for that bar). `kind` decides whether
// the wrapped result is 'int' or 'float' — 'auto' picks int only when every
// scalar input is int-typed.
//
// IMPORTANT: series results must be BarSeries (bar-indexed), never plain
// Series — bindDeclared aliases BarSeries into the variable's slot; a plain
// Series would be stored as a *value* inside the slot (raw-series leak into
// plots). setAt() writes oldest→newest so ring order stays correct.

/** Build a BarSeries from a per-offset fn; `len` = number of bars to write.
 *  Offset 0 = current bar. Writes oldest→newest (setAt can't retro-append).
 *  `lazy` (fn reads only frozen sources) defers each entry until it is read —
 *  same observable series, O(1) instead of O(history) per call. */
function seriesFromOffsets(ctx: BuiltinCtx, len: number, fn: (off: number) => Value, lazy = false): Value {
  if (lazy && len > 0) return { kind: 'series', v: new LiftedSeries(ctx.barIndex, len, fn, fn(0)) };
  const out = new BarSeries();
  if (len <= 0) return { kind: 'series', v: out };
  const base = ctx.barIndex - len + 1;
  if (base < 0) {
    // More history than elapsed bars (bare test ctxs / seeded series):
    // plain pushes preserve the oldest→newest order set() uses.
    for (let i = len - 1; i >= 0; i--) out.set(fn(i));
  } else {
    for (let i = len - 1; i >= 0; i--) out.setAt(base + (len - 1 - i), fn(i));
  }
  return { kind: 'series', v: out };
}

/** Per-offset readers fixed to each arg's current view (scalars read as
 *  themselves at every offset, like the old `get`-or-value read). Null when a
 *  series arg has no replayable storage — the caller must build eagerly. */
function freezeArgs(vs: Value[]): ((i: number) => Value)[] | null {
  const out: ((i: number) => Value)[] = [];
  for (const v of vs) {
    if (v.kind !== 'series') {
      out.push(() => v);
      continue;
    }
    const r = freezeReader(v.v);
    if (r === null) return null;
    out.push(r);
  }
  return out;
}

type NumKernel = (xs: [number | null, ...(number | null)[]]) => number | null;
type OutKind = 'int' | 'float' | 'auto';

export function liftNums(f: NumKernel, kind: OutKind = 'float'): BuiltinFn {
  return (ctx: BuiltinCtx, args: Value[], named: Record<string, Value>) => {
    const vs = args.concat(Object.values(named));
    const asN = (u: Value): number | null => (u.kind === 'int' || u.kind === 'float' ? u.v : null);
    // 'auto' → int only when every input is int-typed right now; decided once
    // per call so deferred entries agree with an eager build.
    const outKind: 'int' | 'float' =
      kind !== 'auto'
        ? kind
        : vs.every(
            (v) =>
              v.kind === 'int' ||
              v.kind === 'na' ||
              (v.kind === 'series' && v.v.cur().kind === 'int'),
          )
          ? 'int'
          : 'float';
    const wrap = (r: number | null): Value => {
      if (r === null) return NA;
      return outKind === 'int' ? { kind: 'int', v: Math.trunc(r) } : { kind: 'float', v: r };
    };
    if (!vs.some((v) => v.kind === 'series')) {
      return wrap(f(vs.map(asN) as [number | null, ...(number | null)[]]));
    }
    const len = Math.max(0, ...vs.map((v) => (v.kind === 'series' ? v.v.size() : 0)));
    const readers = freezeArgs(vs);
    if (readers) {
      return seriesFromOffsets(ctx, len, (i) =>
        wrap(f(readers.map((r) => asN(r(i))) as [number | null, ...(number | null)[]])), true);
    }
    return seriesFromOffsets(ctx, len, (i) =>
      wrap(f(vs.map((v) => asN(v.kind === 'series' ? v.v.get(i) : v)) as [number | null, ...(number | null)[]])));
  };
}

const nulls = (xs: (number | null)[]): xs is number[] => !xs.includes(null);

// ── Simple numeric kernels ──────────────────────────────────────────────────

registerBuiltin('math', 'abs', liftNums((xs) => (xs[0] === null ? null : Math.abs(xs[0])), 'auto'));

registerBuiltin(
  'math',
  'max',
  liftNums((xs) => {
    let best: number | null = null;
    for (const x of xs) if (x !== null && (best === null || x > best)) best = x;
    return best;
  }, 'auto'),
);

registerBuiltin(
  'math',
  'min',
  liftNums((xs) => {
    let best: number | null = null;
    for (const x of xs) if (x !== null && (best === null || x < best)) best = x;
    return best;
  }, 'auto'),
);

registerBuiltin('math', 'sign', liftNums((xs) => (xs[0] === null ? null : Math.sign(xs[0])), 'int'));

registerBuiltin(
  'math',
  'pow',
  liftNums((xs) => (nulls(xs) ? Math.pow(xs[0]!, xs[1]!) : null)),
);
registerBuiltin(
  'math',
  'sqrt',
  liftNums((xs) => (xs[0] === null ? null : Math.sqrt(xs[0]))),
);
registerBuiltin('math', 'log', liftNums((xs) => (xs[0] === null ? null : Math.log(xs[0]))));
registerBuiltin('math', 'log10', liftNums((xs) => (xs[0] === null ? null : Math.log10(xs[0]))));
registerBuiltin('math', 'exp', liftNums((xs) => (xs[0] === null ? null : Math.exp(xs[0]))));
registerBuiltin('math', 'floor', liftNums((xs) => (xs[0] === null ? null : Math.floor(xs[0])), 'auto'));
registerBuiltin('math', 'ceil', liftNums((xs) => (xs[0] === null ? null : Math.ceil(xs[0])), 'auto'));

registerBuiltin('math', 'acos', liftNums((xs) => (xs[0] === null ? null : Math.acos(xs[0]))));
registerBuiltin('math', 'asin', liftNums((xs) => (xs[0] === null ? null : Math.asin(xs[0]))));
registerBuiltin('math', 'atan', liftNums((xs) => (xs[0] === null ? null : Math.atan(xs[0]))));
registerBuiltin('math', 'cos', liftNums((xs) => (xs[0] === null ? null : Math.cos(xs[0]))));
registerBuiltin('math', 'sin', liftNums((xs) => (xs[0] === null ? null : Math.sin(xs[0]))));
registerBuiltin('math', 'tan', liftNums((xs) => (xs[0] === null ? null : Math.tan(xs[0]))));

// TV rounds halves away from zero (math.round(-1.5) → -2).
function roundHalf(v: number, precision: number): number {
  const m = Math.pow(10, precision);
  const s = v * m;
  const fl = Math.floor(s);
  const rounded = s - fl >= 0.5 ? fl + 1 : fl;
  return rounded / m;
}

// math.round(number[, precision]) — int result without precision, float with.
registerBuiltin('math', 'round', (ctx, args, named) => {
  const f = liftNums((xs) => {
    const v = xs[0];
    if (v === null) return null;
    const p = xs[1] ?? null;
    return p === null ? roundHalf(v, 0) : roundHalf(v, Math.trunc(p));
  });
  const r = f(ctx, args, named);
  const hasP =
    (args[1] !== undefined && args[1].kind !== 'na') ||
    (named['precision'] !== undefined && named['precision'].kind !== 'na');
  if (hasP) return r;
  const toInt = (u: Value): Value =>
    u.kind === 'float' || u.kind === 'int' ? { kind: 'int', v: Math.trunc(u.v) } : u;
  if (r.kind === 'series') {
    const rd = freezeReader(r.v);
    if (rd) return seriesFromOffsets(ctx, r.v.size(), (i) => toInt(rd(i)), true);
    return seriesFromOffsets(ctx, r.v.size(), (i) => toInt(r.v.get(i)));
  }
  return toInt(r);
});
registerBuiltin('math', 'round_to_mintick', (ctx, args, named) => {
  const bound = bindArgs(args, named, ['number']);
  const v = bound.get('number');
  if (!v || v.kind === 'na') return NA;
  const n = asNum(v);
  const tickV = ctx.syminfo['mintick'];
  const tick = tickV && (tickV.kind === 'int' || tickV.kind === 'float') ? tickV.v : 0;
  if (!Number.isFinite(tick) || tick <= 0) return numVal(n);
  // Decimal places from the literal tick (avoids log10 float drift on 0.25/0.05).
  const s = String(tick);
  const dec = s.includes('.') ? s.split('.')[1]!.length : 0;
  return numVal(roundHalf(n / tick, 0) * tick === n ? n : Number((roundHalf(n / tick, 0) * tick).toFixed(dec)));
});

registerBuiltin(
  'math',
  'avg',
  liftNums((xs) => {
    const vals = xs.filter((x): x is number => x !== null);
    return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length;
  }),
);

// math.sum(source, length) — rolling window sum; na if the window is short or
// contains na (ta.sum semantics).
registerBuiltin('math', 'sum', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['source', 'length']);
  const src = bound.get('source');
  const lenV = bound.get('length');
  const len = lenV ? Math.trunc(asNum(lenV)) : 0;
  if (!src || len <= 0) return NA;
  const sumWith = (read: (k: number) => Value) => (i: number): Value => {
    let acc = 0;
    for (let k = 0; k < len; k++) {
      const u = read(i + k);
      if (u.kind !== 'int' && u.kind !== 'float') return NA;
      acc += u.v;
    }
    return { kind: 'float', v: acc };
  };
  if (src.kind !== 'series') return sumWith((k) => (k === 0 ? src : NA))(0);
  const hist = src.v.size();
  const rd = freezeReader(src.v);
  if (rd) return seriesFromOffsets(_ctx, hist, sumWith(rd), true);
  return seriesFromOffsets(_ctx, hist, sumWith((k) => src.v.get(k)));
});

// nz(source, replacement=0) — unwrap na. Registered both namespaced and bare.
const nzFn: BuiltinFn = (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['source', 'replacement']);
  const src = bound.get('source');
  const rep = bound.get('replacement');
  if (!src) return rep ?? ({ kind: 'int', v: 0 } as Value);
  if (src.kind !== 'series') {
    if (src.kind === 'na') return rep ?? { kind: 'int', v: 0 };
    return src;
  }
  const srcRd = freezeReader(src.v);
  const repRd = rep?.kind === 'series' ? freezeReader(rep.v) : undefined;
  if (srcRd && repRd !== null) {
    const repAt = (i: number): Value => (!rep ? { kind: 'int', v: 0 } : repRd ? repRd(i) : rep);
    return seriesFromOffsets(_ctx, src.v.size(), (i) => {
      const u = srcRd(i);
      return u.kind === 'na' ? repAt(i) : u;
    }, true);
  }
  const repAt = (i: number): Value => {
    if (!rep) return { kind: 'int', v: 0 };
    return rep.kind === 'series' ? rep.v.get(i) : rep;
  };
  const hist = src.v.size();
  return seriesFromOffsets(_ctx, hist, (i) => {
    const u = src.v.get(i);
    return u.kind === 'na' ? repAt(i) : u;
  });
};
registerBuiltin('math', 'nz', nzFn);
registerBuiltin('', 'nz', nzFn);

registerBuiltin('math', 'tonumber', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['v']);
  const v = bound.get('v');
  if (!v) return NA;
  switch (v.kind) {
    case 'int':
    case 'float':
      return v;
    case 'bool':
      return { kind: 'int', v: v.v ? 1 : 0 };
    case 'string': {
      const n = Number(v.v.replace(/,/g, '').trim());
      return Number.isNaN(n) ? NA : numVal(n);
    }
    default:
      return NA;
  }
});

// Deterministic per (seed, barIndex): matches TV's seeded-random contract well
// enough for tests while staying side-effect free.
registerBuiltin('math', 'random', (ctx, args, named) => {
  const bound = bindArgs(args, named, ['min', 'max', 'seed']);
  const lo = bound.get('min');
  const hi = bound.get('max');
  const seedV = bound.get('seed');
  const loN = lo === undefined || lo.kind === 'na' ? 0 : asNum(lo);
  const hiN = hi === undefined || hi.kind === 'na' ? 1 : asNum(hi);
  const seed = seedV === undefined || seedV.kind === 'na' ? ctx.barIndex : asNum(seedV);
  // xorshift32 on mixed (seed, barIndex)
  let x = (Math.imul(Math.trunc(seed), 0x9e3779b1) ^ Math.imul(ctx.barIndex + 1, 0x85ebca6b)) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  const u = (x >>> 0) / 4294967296;
  return { kind: 'float', v: loN + u * (hiN - loN) };
});

registerBuiltin('math', 'todegrees', liftNums((xs) => (xs[0] === null ? null : (xs[0] * 180) / Math.PI)));
registerBuiltin('math', 'toradians', liftNums((xs) => (xs[0] === null ? null : (xs[0] * Math.PI) / 180)));

// ── Constants ───────────────────────────────────────────────────────────────
// Registered both as constants (bare member expr) and callables (math.pi() —
// some scripts call constants like functions).

const mathConsts: Record<string, Value> = {
  pi: { kind: 'float', v: Math.PI },
  e: { kind: 'float', v: Math.E },
  phi: { kind: 'float', v: (1 + Math.sqrt(5)) / 2 },
  rphi: { kind: 'float', v: (Math.sqrt(5) - 1) / 2 },
};
for (const [name, v] of Object.entries(mathConsts)) {
  registerConstant('math', name, v);
  registerBuiltin('math', name, () => v);
}
