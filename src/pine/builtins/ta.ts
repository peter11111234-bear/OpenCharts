// ── ta.* builtins ────────────────────────────────────────────────────────────
// Technical-analysis namespace. Every function follows TV semantics:
//  - evaluated once per bar; rolling functions read src.get(i) back N bars
//  - strict windowed fns (sma/stdev/…) → na while the window is not full or any
//    element is na; `ta.sum` ignores na inside the window
//  - stateful fns (ema/rma/rsi/supertrend/sar/wad/nvi/pvi/obv/pvt/vwap/tsi/…)
//    keep per-call-site accumulators in ctx.state (RtCtx) or a WeakMap
//    fallback keyed on the ctx object, replaying from the last computed bar so
//    conditionally-invoked calls still chain correctly.
// Pine tuple results are returned as {kind:'array'} Values.

import type { BuiltinCtx, Value } from '../contracts';
import { NA, Series } from '../contracts';
import { registerBuiltin, registerLazyConstant } from './registry';
import { bindArgs, boolArg, curNum, numArg, truthy, unwrapped } from './util';
import type { RtCtx } from './util';
import { isTfBoundary } from './time';

// ── numeric helpers ──────────────────────────────────────────────────────────

// Scalar reads must unwrap: evalArg passes every numeric/bool arg as a
// per-callsite {kind:'series'} BarSeries, so `num(bound.get('length'))` must
// read the current bar through the wrapper.
const num = (v: Value | undefined): number | undefined => {
  const u = v !== undefined && v.kind === 'series' ? v.v.cur() : v;
  return u !== undefined && (u.kind === 'int' || u.kind === 'float') ? u.v : undefined;
};

// ── constant-scalar detection (scalar-arg overloads) ─────────────────────────
// evalArg wraps scalar args into BarSeries too, so `sv.kind !== 'series'` can
// never identify the `ta.highest(20)` / `ta.pivothigh(3,3)` numeric overloads.
// A wrapped literal/constant (or input.* series) has a single finite value for
// its whole history → treat it as the numeric arg, memoized per Series.

interface ConstMemo { checkedTo: number; val: number | null }
const CONST_SERIES = new WeakMap<Series, ConstMemo>();

/** If every defined slot of `s`'s history is one finite number, return it;
 *  else undefined. na slots are gaps (carry-forward fill / late first call),
 *  not evidence of variance — a scalar wrapped by evalArg stays constant. */
function constSeriesNum(s: Series): number | undefined {
  const size = s.size();
  if (size === 0) return undefined;
  const m0 = CONST_SERIES.get(s);
  let v: number | undefined;
  let i = 0;
  let m: ConstMemo;
  if (m0) {
    if (m0.val === null || m0.checkedTo >= size) return m0.val ?? undefined;
    v = m0.val; i = m0.checkedTo; m = m0;
  } else {
    m = { checkedTo: 0, val: null };
    CONST_SERIES.set(s, m);
  }
  for (; i < size; i++) {
    const h = s.get(i);
    if (h.kind === 'na') continue; // gap, not variance
    if ((h.kind !== 'int' && h.kind !== 'float') || (v !== undefined && h.v !== v)) {
      m.val = null; m.checkedTo = Math.max(m.checkedTo, 1); // proven non-constant
      return undefined;
    }
    v = h.v;
    m.checkedTo = i + 1;
  }
  m.val = v ?? null;
  m.checkedTo = size;
  return v;
}

/** Scalar-or-constant-series numeric read (scalar args that may arrive wrapped). */
const constNum = (v: Value | undefined): number | undefined => {
  if (v === undefined) return undefined;
  if (v.kind === 'series') return constSeriesNum(v.v);
  return v.kind === 'int' || v.kind === 'float' ? v.v : undefined;
};

const fl = (n: number | undefined): Value =>
  n === undefined || !Number.isFinite(n) ? NA : { kind: 'float', v: n };

const fbool = (b: boolean): Value => ({ kind: 'bool', v: b });
const arr = (...vs: Value[]): Value => ({ kind: 'array', v: vs });

// ── per-run state + virtual (derived) series ─────────────────────────────────
// VS = accessor for a bar-indexed numeric value; `last` tracks the highest bar
// ever computed so stateful fns can replay after conditional gaps.

interface VS {
  get(b: number): number | undefined;
  last: number; // highest bar attempted/computed (-1 none)
}

const SERIES_IDS = new WeakMap<Series, number>();
let nextSeriesId = 1;
const seriesId = (s: Series): number => {
  let id = SERIES_IDS.get(s);
  if (id === undefined) { id = nextSeriesId++; SERIES_IDS.set(s, id); }
  return id;
};

const CTX_STATE = new WeakMap<BuiltinCtx, Map<string, unknown>>();

function stateMap(ctx: BuiltinCtx): Map<string, unknown> {
  const rt = ctx as RtCtx;
  if (!rt.state) {
    rt.state = CTX_STATE.get(ctx) ?? new Map();
    CTX_STATE.set(ctx, rt.state);
  }
  return rt.state;
}

function stateFor<T>(ctx: BuiltinCtx, key: string, make: () => T): T {
  const m = stateMap(ctx);
  let s = m.get(key) as T | undefined;
  if (s === undefined) { s = make(); m.set(key, s); }
  return s;
}

/** Wrap a Value (series ref or scalar) into a VS keyed by `sig` at `callsite`. */
function vsOf(ctx: BuiltinCtx, v: Value | undefined, sig: string): VS {
  const rt = ctx as RtCtx;
  const site = rt.callsite ?? 'g';
  if (v !== undefined && v.kind === 'series') {
    const s = v.v;
    return stateFor<VS>(ctx, `vs|${site}|series#${seriesId(s)}`, () => ({
      last: -1,
      get(b: number): number | undefined {
        if (b > this.last) this.last = b;
        return num(s.get(ctx.barIndex - b));
      },
    }));
  }
  const c = v === undefined ? undefined : num(v);
  return stateFor<VS>(ctx, `vs|${site}|const|${sig}|${c}`, () => ({
    last: -1,
    get(b: number): number | undefined {
      if (b > this.last) this.last = b;
      return c;
    },
  }));
}

/** Memoized derived series. fn(b) may recurse via other VS (bar args ≤ b). */
function vseries(ctx: BuiltinCtx, key: string, fn: (b: number) => number | undefined): VS {
  return stateFor<VS>(ctx, `dvs|${key}`, () => {
    const memo = new Map<number, number | undefined>();
    return {
      last: -1,
      get(b: number): number | undefined {
        if (b > this.last) this.last = b;
        if (memo.has(b)) return memo.get(b);
        const v = fn(b);
        memo.set(b, v);
        return v;
      },
    };
  });
}

/** Stateful per-bar machine: step(b) runs once per bar in ascending order,
 *  replaying any gap. Result memoized per bar. */
function vstate(ctx: BuiltinCtx, key: string, step: (b: number) => number | undefined): VS {
  return stateFor<VS>(ctx, `stv|${key}`, () => {
    const memo = new Map<number, number | undefined>();
    const self: VS = {
      last: -1,
      get(b: number): number | undefined {
        if (b <= self.last) return memo.get(b);
        for (let i = self.last + 1; i <= b; i++) memo.set(i, step(i));
        self.last = b;
        return memo.get(b);
      },
    };
    return self;
  });
}

// length arg → int (Pine floors floats; ≤0/na → undefined).
// Series args arrive from Task-5 arg tracking — unwrap to current bar value.
function lenOf(bound: Map<string, Value>, name = 'length'): number | undefined {
  let v = bound.get(name);
  if (v === undefined) return undefined;
  if (v.kind === 'series') v = v.v.cur();
  const n = num(v);
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

// ── window helpers (strict unless noted) ─────────────────────────────────────
// windows are bar-range [b-L+1, b]; a bar out of src history reads undefined.

function winOk(vs: VS, b: number, L: number): boolean {
  for (let i = 0; i < L; i++) if (vs.get(b - i) === undefined) return false;
  return true;
}

function meanWin(vs: VS, b: number, L: number): number | undefined {
  let s = 0;
  for (let i = 0; i < L; i++) {
    const v = vs.get(b - i);
    if (v === undefined) return undefined;
    s += v;
  }
  return s / L;
}

/** Sum ignoring na/out-of-window values (ta.sum semantics). */
function sumLoose(vs: VS, b: number, L: number): number {
  let s = 0;
  for (let i = 0; i < L; i++) s += vs.get(b - i) ?? 0;
  return s;
}

function wmaWin(vs: VS, b: number, L: number): number | undefined {
  let num_ = 0, den = 0;
  for (let i = 0; i < L; i++) {
    const v = vs.get(b - i);
    if (v === undefined) return undefined;
    const w = L - i;
    num_ += v * w;
    den += w;
  }
  return num_ / den;
}

function highestWin(vs: VS, b: number, L: number): number | undefined {
  let m: number | undefined;
  for (let i = 0; i < L; i++) {
    const v = vs.get(b - i);
    if (v === undefined) return undefined;
    if (m === undefined || v > m) m = v;
  }
  return m;
}

function lowestWin(vs: VS, b: number, L: number): number | undefined {
  let m: number | undefined;
  for (let i = 0; i < L; i++) {
    const v = vs.get(b - i);
    if (v === undefined) return undefined;
    if (m === undefined || v < m) m = v;
  }
  return m;
}

function stdevWin(vs: VS, b: number, L: number, biased: boolean): number | undefined {
  const m = meanWin(vs, b, L);
  if (m === undefined) return undefined;
  let s = 0;
  for (let i = 0; i < L; i++) {
    const d = vs.get(b - i)! - m;
    s += d * d;
  }
  return Math.sqrt(s / (biased ? L : L - 1));
}

// ── ta.* building blocks shared by several builtins ──────────────────────────

function emaVs(ctx: BuiltinCtx, src: VS, len: number, tag: string): VS {
  const a = 2 / (len + 1);
  return vseries(ctx, `ema|${tag}|${len}`, (b) => {
    const x = src.get(b);
    if (x === undefined) return undefined;
    const p = b > 0 ? emaVsGet(ctx, src, len, tag, b - 1) : undefined;
    return p === undefined ? x : a * x + (1 - a) * p;
  });
}
// split accessor so the recursion above sees the same memoized VS
function emaVsGet(ctx: BuiltinCtx, src: VS, len: number, tag: string, b: number): number | undefined {
  return emaVs(ctx, src, len, tag).get(b);
}

/** Wilder RMA: seeded with SMA of the first `len` bars → na until bar len-1. */
function rmaVs(ctx: BuiltinCtx, src: VS, len: number, tag: string): VS {
  const a = 1 / len;
  return vstate(ctx, `rma|${tag}|${len}`, (b) => {
    const x = src.get(b);
    if (x === undefined) return undefined;
    if (b < len - 1) return undefined;
    if (b === len - 1) return meanWin(src, b, len);
    const p = rmaVsGet(ctx, src, len, tag, b - 1);
    if (p === undefined) return meanWin(src, b, len); // defensive reseed
    return a * x + (1 - a) * p;
  });
}
function rmaVsGet(ctx: BuiltinCtx, src: VS, len: number, tag: string, b: number): number | undefined {
  return rmaVs(ctx, src, len, tag).get(b);
}

function trVs(ctx: BuiltinCtx): VS {
  return vseries(ctx, 'tr', (b) => {
    const h = num(ctx.high.get(ctx.barIndex - b));
    const l = num(ctx.low.get(ctx.barIndex - b));
    if (h === undefined || l === undefined) return undefined;
    const pc = b > 0 ? num(ctx.close.get(ctx.barIndex - b + 1)) : undefined;
    if (pc === undefined) return undefined; // handle_na=true semantics
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
}

function hmaVs(ctx: BuiltinCtx, src: VS, len: number, tag: string): VS {
  const half = Math.max(1, Math.floor(len / 2));
  const root = Math.max(1, Math.round(Math.sqrt(len)));
  const inner = vseries(ctx, `hma-in|${tag}|${len}`, (b) => {
    const f = wmaWin(src, b, half);
    const s = wmaWin(src, b, len);
    if (f === undefined || s === undefined) return undefined;
    return 2 * f - s;
  });
  return vseries(ctx, `hma|${tag}|${len}`, (b) => wmaWin(inner, b, root));
}

// ── arg plumbing ─────────────────────────────────────────────────────────────

/** Resolve the source arg: series ref → VS over it; scalar → constant VS. */
function srcOf(ctx: BuiltinCtx, bound: Map<string, Value>, name = 'source'): VS | undefined {
  const v = bound.get(name);
  if (v === undefined) return undefined;
  return vsOf(ctx, v, `${name}`);
}

/** (source, length) overload handling used by highest/lowest/highestbars/
 *  lowestbars: a single numeric arg (scalar or constant series — evalArg wraps
 *  scalars into BarSeries) is the `length` with a default OHLC source. */
function srcLen(ctx: BuiltinCtx, bound: Map<string, Value>, defSrc: Series, defName: string): { src: VS; len: number | undefined } {
  const sv = bound.get('source');
  const lv = bound.get('length');
  if (lv === undefined) {
    const sc = constNum(sv); // ta.highest(10) — arg0 bound to 'source' slot
    if (sc !== undefined) {
      return { src: vsOf(ctx, { kind: 'series', v: defSrc }, defName), len: sc > 0 ? Math.floor(sc) : undefined };
    }
  }
  const src = sv === undefined ? vsOf(ctx, { kind: 'series', v: defSrc }, defName) : vsOf(ctx, sv, 'source');
  return { src, len: lenOf(bound) };
}

// ── builtin implementations ──────────────────────────────────────────────────

function reg(name: string, fn: (ctx: BuiltinCtx, args: Value[], named: Record<string, Value>) => Value): void {
  registerBuiltin('ta', name, fn);
}

// simple strict rolling mean
reg('sma', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  return fl(meanWin(src, ctx.barIndex, L));
});

reg('ema', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  return fl(emaVs(ctx, src, L, emaTag(ctx, b)).get(ctx.barIndex));
});

function emaTag(ctx: BuiltinCtx, bound: Map<string, Value>): string {
  const rt = ctx as RtCtx;
  const sv = bound.get('source');
  const id = sv !== undefined && sv.kind === 'series' ? `s${seriesId(sv.v)}` : `c${num(sv)}`;
  return `${rt.callsite ?? 'g'}|${id}`;
}

reg('rma', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  return fl(rmaVs(ctx, src, L, emaTag(ctx, b)).get(ctx.barIndex));
});

reg('wma', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  return fl(wmaWin(src, ctx.barIndex, L));
});

reg('hma', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  return fl(hmaVs(ctx, src, L, emaTag(ctx, b)).get(ctx.barIndex));
});

reg('vwma', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const bar = ctx.barIndex;
  let num_ = 0, den = 0;
  for (let i = 0; i < L; i++) {
    const s = src.get(bar - i);
    const vol = num(ctx.volume.get(i));
    if (s === undefined || vol === undefined) return NA;
    num_ += s * vol;
    den += vol;
  }
  return fl(den === 0 ? undefined : num_ / den);
});

// 4-bar symmetric WMA, weights 1 2 2 1
reg('swma', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source']);
  const src = srcOf(ctx, b);
  if (!src) return NA;
  const bar = ctx.barIndex;
  const w = [1, 2, 2, 1];
  let num_ = 0, den = 0;
  for (let i = 0; i < 4; i++) {
    const v = src.get(bar - i);
    if (v === undefined) return NA;
    num_ += v * w[3 - i]!; // most recent bar gets weight 1 (index 3 → far bar weight)
    den += w[3 - i]!;
  }
  return fl(num_ / den);
});

reg('rsi', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const tag = emaTag(ctx, b);
  const gains = vseries(ctx, `rsi-g|${tag}`, (bb) => {
    if (bb <= 0) return undefined;
    const c = src.get(bb), p = src.get(bb - 1);
    if (c === undefined || p === undefined) return undefined;
    return Math.max(c - p, 0);
  });
  const losses = vseries(ctx, `rsi-l|${tag}`, (bb) => {
    if (bb <= 0) return undefined;
    const c = src.get(bb), p = src.get(bb - 1);
    if (c === undefined || p === undefined) return undefined;
    return Math.max(p - c, 0);
  });
  const g = rmaVs(ctx, gains, L, `rg|${tag}`).get(ctx.barIndex);
  const l = rmaVs(ctx, losses, L, `rl|${tag}`).get(ctx.barIndex);
  if (g === undefined || l === undefined) return NA;
  if (l === 0) return g === 0 ? NA : fl(100); // flat window → na (TV), not 50
  return fl(100 - 100 / (1 + g / l));
});

reg('tr', (ctx, args, named) => {
  const b = bindArgs(args, named, ['handle_na']);
  const handleNa = b.get('handle_na') === undefined ? true : truthy(b.get('handle_na')!);
  const bar = ctx.barIndex;
  const h = num(ctx.high.get(0)), l = num(ctx.low.get(0));
  if (h === undefined || l === undefined) return NA;
  const pc = bar > 0 ? num(ctx.close.get(1)) : undefined;
  if (pc === undefined) return handleNa ? NA : fl(h - l);
  return fl(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
});

reg('atr', (ctx, args, named) => {
  const b = bindArgs(args, named, ['length']);
  const L = lenOf(b);
  if (L === undefined) return NA;
  return fl(rmaVs(ctx, trVs(ctx), L, 'atr').get(ctx.barIndex));
});

reg('stdev', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length', 'biased']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const biased = boolArg(b, 'biased', true);
  // biased=false needs ≥2 samples (÷L-1); biased=true & L==1 → 0 (fl covers it).
  if (L < 2 && !biased) return NA;
  return fl(stdevWin(src, ctx.barIndex, L, biased));
});

reg('variance', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length', 'biased']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const biased = boolArg(b, 'biased', true);
  if (L < 2 && !biased) return NA;
  const m = meanWin(src, ctx.barIndex, L);
  if (m === undefined) return NA;
  let s = 0;
  for (let i = 0; i < L; i++) {
    const d = src.get(ctx.barIndex - i)! - m;
    s += d * d;
  }
  return fl(s / (biased ? L : L - 1));
});

reg('bb', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length', 'mult']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  const m = numArg(b, 'mult', 2);
  if (!src || L === undefined || !Number.isFinite(m)) return arr(NA, NA, NA);
  const basis = meanWin(src, ctx.barIndex, L);
  const sd = stdevWin(src, ctx.barIndex, L, true);
  if (basis === undefined || sd === undefined) return arr(NA, NA, NA);
  return arr(fl(basis), fl(basis + m * sd), fl(basis - m * sd));
});

reg('bbw', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length', 'mult']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  const m = numArg(b, 'mult', 2);
  if (!src || L === undefined || !Number.isFinite(m)) return NA;
  const basis = meanWin(src, ctx.barIndex, L);
  const sd = stdevWin(src, ctx.barIndex, L, true);
  if (basis === undefined || sd === undefined || basis === 0) return NA;
  return fl(((basis + m * sd) - (basis - m * sd)) / basis);
});


reg('highest', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const { src, len } = srcLen(ctx, b, ctx.high, 'high');
  if (len === undefined) return NA;
  return fl(highestWin(src, ctx.barIndex, len));
});

reg('lowest', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const { src, len } = srcLen(ctx, b, ctx.low, 'low');
  if (len === undefined) return NA;
  return fl(lowestWin(src, ctx.barIndex, len));
});

reg('highestbars', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const { src, len } = srcLen(ctx, b, ctx.high, 'high');
  if (len === undefined) return NA;
  const m = highestWin(src, ctx.barIndex, len);
  if (m === undefined) return NA;
  for (let i = 0; i < len; i++) if (src.get(ctx.barIndex - i) === m) return { kind: 'int', v: i === 0 ? 0 : -i };
  return NA;
});

reg('lowestbars', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const { src, len } = srcLen(ctx, b, ctx.low, 'low');
  if (len === undefined) return NA;
  const m = lowestWin(src, ctx.barIndex, len);
  if (m === undefined) return NA;
  for (let i = 0; i < len; i++) if (src.get(ctx.barIndex - i) === m) return { kind: 'int', v: i === 0 ? 0 : -i };
  return NA;
});

function crossImpl(ctx: BuiltinCtx, args: Value[], named: Record<string, Value>, mode: 'over' | 'under' | 'any'): Value {
  const b = bindArgs(args, named, ['source1', 'source2']);
  const s1 = srcOf(ctx, b, 'source1'); const s2 = srcOf(ctx, b, 'source2');
  if (!s1 || !s2) return fbool(false);
  const bar = ctx.barIndex;
  const a1 = s1.get(bar), b1 = s2.get(bar);
  const a0 = s1.get(bar - 1), b0 = s2.get(bar - 1);
  if (a1 === undefined || b1 === undefined || a0 === undefined || b0 === undefined) return fbool(false);
  const over = a1 > b1 && a0 <= b0;
  const under = a1 < b1 && a0 >= b0;
  return fbool(mode === 'over' ? over : mode === 'under' ? under : over || under);
}
reg('cross', (ctx, a, n) => crossImpl(ctx, a, n, 'any'));
reg('crossover', (ctx, a, n) => crossImpl(ctx, a, n, 'over'));
reg('crossunder', (ctx, a, n) => crossImpl(ctx, a, n, 'under'));

reg('change', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b);
  if (!src) return NA;
  const L = lenOf(b) ?? 1;
  const bar = ctx.barIndex;
  const c = src.get(bar), p = src.get(bar - L);
  return c === undefined || p === undefined ? NA : fl(c - p);
});

reg('roc', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const bar = ctx.barIndex;
  const c = src.get(bar), p = src.get(bar - L);
  if (c === undefined || p === undefined || p === 0) return NA;
  return fl(100 * (c - p) / p);
});

function momImpl(ctx: BuiltinCtx, args: Value[], named: Record<string, Value>): Value {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const bar = ctx.barIndex;
  const c = src.get(bar), p = src.get(bar - L);
  return c === undefined || p === undefined ? NA : fl(c - p);
}
reg('momentum', momImpl);
reg('mom', momImpl);

reg('cum', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source']);
  const src = srcOf(ctx, b);
  if (!src) return NA;
  const rt = ctx as RtCtx;
  const sv = b.get('source');
  const srcTag = sv !== undefined && sv.kind === 'series' ? `s${seriesId(sv.v)}` : `c${num(sv)}`;
  const cum = vstate(ctx, `cum|${rt.callsite ?? 'g'}|${srcTag}`, (bb) => {
    const x = src.get(bb);
    if (x === undefined) return undefined;
    const p = cum.get(bb - 1);
    return (p ?? 0) + x;
  });
  return fl(cum.get(ctx.barIndex));
});

reg('sum', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  return fl(sumLoose(src, ctx.barIndex, L));
});

function corImpl(ctx: BuiltinCtx, args: Value[], named: Record<string, Value>): Value {
  const b = bindArgs(args, named, ['source_a', 'source_b', 'length']);
  const sa = srcOf(ctx, b, 'source_a'); const sb = srcOf(ctx, b, 'source_b');
  const L = lenOf(b);
  if (!sa || !sb || L === undefined || L < 2) return NA;
  const bar = ctx.barIndex;
  if (!winOk(sa, bar, L) || !winOk(sb, bar, L)) return NA;
  const ma = meanWin(sa, bar, L)!, mb = meanWin(sb, bar, L)!;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < L; i++) {
    const da = sa.get(bar - i)! - ma, db = sb.get(bar - i)! - mb;
    sxy += da * db; sxx += da * da; syy += db * db;
  }
  const den = Math.sqrt(sxx * syy);
  return fl(den === 0 ? undefined : sxy / den);
}
reg('cor', corImpl);
reg('correlation', corImpl);

reg('dev', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const bar = ctx.barIndex;
  const m = meanWin(src, bar, L);
  if (m === undefined) return NA;
  let s = 0;
  for (let i = 0; i < L; i++) s += Math.abs(src.get(bar - i)! - m);
  return fl(s / L);
});

function windowVals(vs: VS, b: number, L: number): number[] | undefined {
  const out: number[] = [];
  for (let i = 0; i < L; i++) {
    const v = vs.get(b - i);
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out.sort((x, y) => x - y);
}

reg('median', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const w = windowVals(src, ctx.barIndex, L);
  if (!w) return NA;
  const mid = Math.floor(L / 2);
  return fl(L % 2 === 1 ? w[mid] : (w[mid - 1]! + w[mid]!) / 2);
});

reg('mode', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const counts = new Map<number, number>();
  for (let i = 0; i < L; i++) {
    const v = src.get(ctx.barIndex - i);
    if (v === undefined) return NA;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: number | undefined, bestC = 0;
  for (const [v, c] of counts) if (c > bestC) { best = v; bestC = c; }
  return fl(best);
});

reg('percentile_linear_interpolation', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length', 'percentage']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  const pct = numArg(b, 'percentage', NaN);
  if (!src || L === undefined || !Number.isFinite(pct) || pct < 0 || pct > 100) return NA;
  const w = windowVals(src, ctx.barIndex, L);
  if (!w) return NA;
  const pos = (pct / 100) * (L - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return fl(w[lo]! + (w[hi]! - w[lo]!) * (pos - lo));
});

reg('percentile_nearest_rank', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length', 'percentage']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  const pct = numArg(b, 'percentage', NaN);
  if (!src || L === undefined || !Number.isFinite(pct) || pct < 0 || pct > 100) return NA;
  const w = windowVals(src, ctx.barIndex, L);
  if (!w) return NA;
  const rank = Math.max(1, Math.ceil((pct / 100) * L));
  return fl(w[rank - 1]);
});

// pivot neighborhood: center bar c; d in [-right, left], d>0 = left (older) side,
// neighbor bar = c - d. Strict: every neighbor must be strictly lower/higher.

function pivotScan(src: VS, c: number, left: number, right: number, high: boolean): number | undefined {
  const center = src.get(c);
  if (center === undefined) return undefined;
  for (let d = -right; d <= left; d++) {
    if (d === 0) continue;
    const v = src.get(c - d);
    if (v === undefined) return undefined;
    if (high ? v >= center : v <= center) {
      // strict pivot: neighbors must be strictly lower/higher
      if (v === center) return undefined;
      return undefined;
    }
  }
  return center;
}

// ta.pivothigh/pivotlow: 3-arg (source, leftbars, rightbars) and overload
// (leftbars[, rightbars]) on a default OHLC source. Scalar args arrive wrapped
// in BarSeries (evalArg), so use constNum/num (series-aware) everywhere.
function pivotImpl(ctx: BuiltinCtx, args: Value[], named: Record<string, Value>, high: boolean): Value {
  const b = bindArgs(args, named, ['source', 'leftbars', 'rightbars']);
  const sv = b.get('source'), lb = b.get('leftbars'), rb = b.get('rightbars');
  let src: VS | undefined; let left: number | undefined; let right: number | undefined;
  const sc = constNum(sv);
  if (sc !== undefined && rb === undefined) {
    // ta.pivothigh(3, 3) — arg0 bound to 'source'; default source = high/low
    left = Math.floor(sc);
    const r = constNum(lb);
    right = r === undefined ? left : Math.floor(r);
    src = vsOf(ctx, { kind: 'series', v: high ? ctx.high : ctx.low }, high ? 'high' : 'low');
  } else {
    src = sv === undefined ? undefined : vsOf(ctx, sv, 'source');
    const l = num(lb), r = num(rb);
    left = l === undefined ? undefined : Math.floor(l);
    right = r === undefined ? left : Math.floor(r);
  }
  if (!src || left === undefined || right === undefined || left < 1 || right < 1) return NA;
  return fl(pivotScan(src, ctx.barIndex - right, left, right, high));
}

reg('pivothigh', (ctx, args, named) => pivotImpl(ctx, args, named, true));
reg('pivotlow', (ctx, args, named) => pivotImpl(ctx, args, named, false));

// ── supertrend ───────────────────────────────────────────────────────────────

interface StState { up?: number; dn?: number; dir?: number }

reg('supertrend', (ctx, args, named) => {
  const b = bindArgs(args, named, ['factor', 'atrPeriod', 'length']);
  const factor = numArg(b, 'factor', NaN);
  const L = lenOf(b, 'atrPeriod') ?? lenOf(b, 'length');
  if (!Number.isFinite(factor) || L === undefined) return arr(NA, NA);
  const rt = ctx as RtCtx;
  const key = `st|${rt.callsite ?? 'g'}|${factor}|${L}`;
  const atr = rmaVs(ctx, trVs(ctx), L, `st-atr|${key}`);
  const st = stateFor<StState>(ctx, `stv-x|${key}`, () => ({}));
  const lastBar = stateFor<{ n: number }>(ctx, `stv-b|${key}`, () => ({ n: -1 }));
  const memo = stateFor<Map<number, [number, number] | undefined>>(ctx, `stv-m|${key}`, () => new Map());
  const bar = ctx.barIndex;
  if (memo.has(bar)) {
    const m = memo.get(bar);
    return m === undefined ? arr(NA, NA) : arr(fl(m[0]), { kind: 'float', v: m[1] });
  }
  let out: [number, number] | undefined;
  for (let bb = lastBar.n + 1; bb <= bar; bb++) {
    const a = atr.get(bb);
    const mid = hl2At(ctx, bb);
    const c = num(ctx.close.get(ctx.barIndex - bb));
    if (a === undefined || mid === undefined || c === undefined) { memo.set(bb, undefined); out = undefined; continue; }
    const upRaw = mid - factor * a;
    const dnRaw = mid + factor * a;
    const pc = num(ctx.close.get(ctx.barIndex - bb + 1));
    // TV ratchets: band keeps the tighter of (raw, prev) unless prev close
    // already traded through the prev band (incl. equality → no carry).
    const up = (st.up !== undefined && pc !== undefined && pc >= st.up) ? Math.max(upRaw, st.up) : upRaw;
    const dn = (st.dn !== undefined && pc !== undefined && pc <= st.dn) ? Math.min(dnRaw, st.dn) : dnRaw;
    const aPrev = atr.get(bb - 1);
    let dir: number;
    // TV: `direction := 1 if atr[1] na` — initial direction is downtrend (1).
    if (aPrev === undefined || st.dir === undefined) dir = 1;
    else if (st.dir === 1) dir = c > dn ? -1 : 1;
    else dir = c < up ? 1 : -1;
    st.up = up; st.dn = dn; st.dir = dir;
    const line = dir === -1 ? up : dn;
    memo.set(bb, [line, dir]);
    out = [line, dir];
  }
  lastBar.n = bar;
  return out === undefined ? arr(NA, NA) : arr(fl(out[0]), { kind: 'float', v: out[1] });
});

function hl2At(ctx: BuiltinCtx, b: number): number | undefined {
  const off = ctx.barIndex - b;
  const h = num(ctx.high.get(off)), l = num(ctx.low.get(off));
  return h === undefined || l === undefined ? undefined : (h + l) / 2;
}

// ── supertrend done; MACD ────────────────────────────────────────────────────

reg('macd', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'fastlen', 'slowlen', 'siglen']);
  const src = srcOf(ctx, b);
  const fast = lenOf(b, 'fastlen'), slow = lenOf(b, 'slowlen'), sig = lenOf(b, 'siglen');
  if (!src || fast === undefined || slow === undefined || sig === undefined) return arr(NA, NA, NA);
  const tag = emaTag(ctx, b);
  const fastE = emaVs(ctx, src, fast, `macd-f|${tag}`);
  const slowE = emaVs(ctx, src, slow, `macd-s|${tag}`);
  const macdL = vseries(ctx, `macd-l|${tag}|${fast}|${slow}`, (bb) => {
    const f = fastE.get(bb), s = slowE.get(bb);
    return f === undefined || s === undefined ? undefined : f - s;
  });
  const sigL = emaVs(ctx, macdL, sig, `macd-g|${tag}`);
  const bar = ctx.barIndex;
  const m = macdL.get(bar), s = sigL.get(bar);
  const h = m === undefined || s === undefined ? undefined : m - s;
  return arr(fl(m), fl(s), fl(h));
});

// ── accumulation / volume statefuls ──────────────────────────────────────────

function wadVs(ctx: BuiltinCtx, key: string) {
  const acc = vstate(ctx, key, (bb) => {
    // TV: accumulators hold their last value when a step input is na
    // (cum(prev) carry), rather than emitting na and resetting the chain.
    const prev = acc.get(bb - 1);
    const c = num(ctx.close.get(ctx.barIndex - bb));
    if (c === undefined) return prev;
    const pc = num(ctx.close.get(ctx.barIndex - bb + 1));
    let t: number;
    if (pc === undefined) t = 0; // na momentum → no contribution (was: c)
    else if (c > pc) {
      const l = num(ctx.low.get(ctx.barIndex - bb));
      if (l === undefined) return prev;
      t = c - Math.min(l, pc);
    } else if (c < pc) {
      const h = num(ctx.high.get(ctx.barIndex - bb));
      if (h === undefined) return prev;
      t = c - Math.max(h, pc);
    } else t = 0;
    return (prev ?? 0) + t;
  });
  return acc;
}

reg('wad', (ctx, args, named) => {
  bindArgs(args, named, []);
  const rt = ctx as RtCtx;
  return fl(wadVs(ctx, `wad|${rt.callsite ?? 'g'}`).get(ctx.barIndex));
});

reg('obv', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source']);
  const src = srcOf(ctx, b) ?? vsOf(ctx, { kind: 'series', v: ctx.close }, 'close');
  const rt = ctx as RtCtx;
  const obv = vstate(ctx, `obv|${rt.callsite ?? 'g'}|${emaTag(ctx, b)}`, (bb) => {
    const prev = obv.get(bb - 1);
    const c = src.get(bb), p = src.get(bb - 1), vol = num(ctx.volume.get(ctx.barIndex - bb));
    if (c === undefined || p === undefined || vol === undefined) return prev;
    const base = prev ?? 0;
    return base + (c > p ? vol : c < p ? -vol : 0);
  });
  return fl(obv.get(ctx.barIndex));
});

function pvtVs(ctx: BuiltinCtx, key: string) {
  const acc = vstate(ctx, key, (bb) => {
    const prev = acc.get(bb - 1);
    const c = num(ctx.close.get(ctx.barIndex - bb));
    const p = num(ctx.close.get(ctx.barIndex - bb + 1));
    const vol = num(ctx.volume.get(ctx.barIndex - bb));
    if (c === undefined || p === undefined || vol === undefined || p === 0) return prev;
    return (prev ?? 0) + ((c - p) / p) * vol;
  });
  return acc;
}

reg('pvt', (ctx, args, named) => {
  bindArgs(args, named, []);
  const rt = ctx as RtCtx;
  return fl(pvtVs(ctx, `pvt|${rt.callsite ?? 'g'}`).get(ctx.barIndex));
});

function nviPviVs(ctx: BuiltinCtx, useVolumeDown: boolean, key: string) {
  const acc = vstate(ctx, key, (bb) => {
    const prev = acc.get(bb - 1);
    const c = num(ctx.close.get(ctx.barIndex - bb));
    const p = num(ctx.close.get(ctx.barIndex - bb + 1));
    const v = num(ctx.volume.get(ctx.barIndex - bb));
    const pv = num(ctx.volume.get(ctx.barIndex - bb + 1));
    if (c === undefined || p === undefined || v === undefined || pv === undefined || p === 0) return prev;
    const base = prev ?? 1000;
    const active = useVolumeDown ? v < pv : v > pv;
    return active ? base * (1 + (c - p) / p) : base;
  });
  return acc;
}

function nviPvi(ctx: BuiltinCtx, useVolumeDown: boolean): Value {
  const rt = ctx as RtCtx;
  const name = useVolumeDown ? 'nvi' : 'pvi';
  return fl(nviPviVs(ctx, useVolumeDown, `${name}|${rt.callsite ?? 'g'}`).get(ctx.barIndex));
}
reg('nvi', (ctx) => nviPvi(ctx, true));
reg('pvi', (ctx) => nviPvi(ctx, false));

// ── cci / cmo / cog / mfi / wpr / linreg / cor helpers ────────────────────────

reg('cci', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const bar = ctx.barIndex;
  const m = meanWin(src, bar, L);
  if (m === undefined) return NA;
  let dev = 0;
  for (let i = 0; i < L; i++) dev += Math.abs(src.get(bar - i)! - m);
  const md = dev / L;
  const tp = src.get(bar)!;
  return fl(md === 0 ? undefined : (tp - m) / (0.015 * md)); // flat window → na (TV)
});

reg('cmo', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const bar = ctx.barIndex;
  let up = 0, dn = 0;
  for (let i = 0; i < L; i++) {
    const c = src.get(bar - i), p = src.get(bar - i - 1);
    if (c === undefined || p === undefined) return NA;
    const d = c - p;
    if (d > 0) up += d; else dn += -d;
  }
  const tot = up + dn;
  return fl(tot === 0 ? 0 : 100 * (up - dn) / tot);
});

reg('cog', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  if (!src || L === undefined) return NA;
  const bar = ctx.barIndex;
  let num_ = 0, den = 0;
  for (let i = 0; i < L; i++) {
    const v = src.get(bar - i);
    if (v === undefined) return NA;
    num_ += v * (i + 1);
    den += v;
  }
  return fl(den === 0 ? undefined : -num_ / den);
});

reg('mfi', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b) ?? vsOf(ctx, { kind: 'series', v: ctx.hlc3 }, 'hlc3');
  const L = lenOf(b);
  if (L === undefined) return NA;
  const bar = ctx.barIndex;
  let pos = 0, neg = 0;
  for (let i = 0; i < L; i++) {
    const t = src.get(bar - i), tp = src.get(bar - i - 1);
    const v = num(ctx.volume.get(i));
    if (t === undefined || tp === undefined || v === undefined) return NA;
    const mf = t * v;
    if (t > tp) pos += mf; else if (t < tp) neg += mf;
  }
  if (neg === 0) return pos === 0 ? NA : fl(100); // flat window → na (TV), not 50
  return fl(100 - 100 / (1 + pos / neg));
});

reg('wpr', (ctx, args, named) => {
  const b = bindArgs(args, named, ['length']);
  const L = lenOf(b);
  if (L === undefined) return NA;
  const bar = ctx.barIndex;
  const hh = highestWin(vsOf(ctx, { kind: 'series', v: ctx.high }, 'high'), bar, L);
  const ll = lowestWin(vsOf(ctx, { kind: 'series', v: ctx.low }, 'low'), bar, L);
  const c = num(ctx.close.get(0));
  if (hh === undefined || ll === undefined || c === undefined) return NA;
  const den = hh - ll;
  return fl(den === 0 ? undefined : -100 * (hh - c) / den); // hh==ll → na (TV)
});

reg('linreg', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length', 'offset']);
  const src = srcOf(ctx, b); const L = lenOf(b);
  const off = Math.trunc(numArg(b, 'offset', 0));
  if (!src || L === undefined || L < 2) return NA;
  const bar = ctx.barIndex;
  if (!winOk(src, bar, L)) return NA;
  // OLS: x = 0..L-1 (0 = most recent), y = src values
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < L; i++) {
    const y = src.get(bar - i)!;
    sx += i; sy += y; sxy += i * y; sxx += i * i;
  }
  const den = L * sxx - sx * sx;
  if (den === 0) return NA;
  const slope = (L * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / L;
  return fl(intercept + slope * -off); // evaluated at x = -offset (offset>0 → future projection)
});

// ── dmi ──────────────────────────────────────────────────────────────────────

reg('dmi', (ctx, args, named) => {
  const b = bindArgs(args, named, ['diLength', 'adxSmoothing', 'dilength', 'adxsmoothing']);
  const diL = lenOf(b, 'diLength') ?? lenOf(b, 'dilength');
  const adxL = lenOf(b, 'adxSmoothing') ?? lenOf(b, 'adxsmoothing') ?? diL;
  if (diL === undefined || adxL === undefined) return arr(NA, NA, NA);
  const rt = ctx as RtCtx;
  const tag = `${rt.callsite ?? 'g'}|${diL}|${adxL}`;
  const plusDM = vseries(ctx, `dmi+p|${tag}`, (bb) => {
    const off = ctx.barIndex - bb;
    const h = num(ctx.high.get(off)), hp = num(ctx.high.get(off + 1));
    const l = num(ctx.low.get(off)), lp = num(ctx.low.get(off + 1));
    if (h === undefined || hp === undefined || l === undefined || lp === undefined) return undefined;
    const up = h - hp, dn = lp - l;
    return up > dn && up > 0 ? up : 0;
  });
  const minusDM = vseries(ctx, `dmi-m|${tag}`, (bb) => {
    const off = ctx.barIndex - bb;
    const h = num(ctx.high.get(off)), hp = num(ctx.high.get(off + 1));
    const l = num(ctx.low.get(off)), lp = num(ctx.low.get(off + 1));
    if (h === undefined || hp === undefined || l === undefined || lp === undefined) return undefined;
    const up = h - hp, dn = lp - l;
    return dn > up && dn > 0 ? dn : 0;
  });
  const tr = trVs(ctx);
  const trS = rmaVs(ctx, tr, diL, `dmi-tr|${tag}`);
  const pS = rmaVs(ctx, plusDM, diL, `dmi-pr|${tag}`);
  const mS = rmaVs(ctx, minusDM, diL, `dmi-mr|${tag}`);
  const dx = vseries(ctx, `dmi-dx|${tag}`, (bb) => {
    const t = trS.get(bb), p = pS.get(bb), m = mS.get(bb);
    if (t === undefined || p === undefined || m === undefined) return undefined;
    // TV fixnan(): 0/na tr smooth → +di/-di read as 0, not na.
    const pdi = t === 0 ? 0 : 100 * p / t, mdi = t === 0 ? 0 : 100 * m / t;
    const s = pdi + mdi;
    return s === 0 ? 0 : 100 * Math.abs(pdi - mdi) / s;
  });
  const adx = rmaVs(ctx, dx, adxL, `dmi-adx|${tag}`);
  const bar = ctx.barIndex;
  const t = trS.get(bar);
  const p = t === undefined ? undefined : (pS.get(bar) === undefined ? undefined : (t === 0 ? 0 : 100 * pS.get(bar)! / t));
  const m = t === undefined ? undefined : (mS.get(bar) === undefined ? undefined : (t === 0 ? 0 : 100 * mS.get(bar)! / t));
  return arr(fl(p), fl(m), fl(adx.get(bar)));
});

// ── kc / kcW ────────────────────────────────────────────────────────────────

// TV signature: ta.kc(source, length, mult, useTrueRange) — basis = ma(src, L),
// range = ma(useTrueRange ? ta.tr : high - low, L), both EMA (kc) or WMA (kcW).
function kcImpl(ctx: BuiltinCtx, args: Value[], named: Record<string, Value>, useWma: boolean): Value {
  const b = bindArgs(args, named, ['source', 'length', 'mult', 'useTrueRange']);
  const src = srcOf(ctx, b) ?? vsOf(ctx, { kind: 'series', v: ctx.close }, 'close');
  const L = lenOf(b) ?? 20;
  const mult = numArg(b, 'mult', 2);
  const useTr = boolArg(b, 'useTrueRange', true);
  const rt = ctx as RtCtx;
  const tag = `${rt.callsite ?? 'g'}|${useWma ? 'w' : 'e'}|${L}|${mult}|${useTr}`;
  const rngSrc = useTr
    ? trVs(ctx)
    : vseries(ctx, `hl-r|${tag}`, (bb) => {
        const h = num(ctx.high.get(ctx.barIndex - bb)), l = num(ctx.low.get(ctx.barIndex - bb));
        return h === undefined || l === undefined ? undefined : h - l;
      });
  const basis = useWma
    ? vseries(ctx, `kc-b|${tag}`, (bb) => wmaWin(src, bb, L))
    : emaVs(ctx, src, L, `kc-b|${tag}`);
  const rng = useWma
    ? vseries(ctx, `kc-r|${tag}`, (bb) => wmaWin(rngSrc, bb, L))
    : emaVs(ctx, rngSrc, L, `kc-r|${tag}`);
  const bar = ctx.barIndex;
  const base = basis.get(bar), r = rng.get(bar);
  if (base === undefined || r === undefined) return arr(NA, NA, NA);
  return arr(fl(base), fl(base + mult * r), fl(base - mult * r));
}
reg('kc', (ctx, a, n) => kcImpl(ctx, a, n, false));
reg('kcW', (ctx, a, n) => kcImpl(ctx, a, n, true));
reg('kcw', (ctx, a, n) => kcImpl(ctx, a, n, true));

// ── fisher transform ─────────────────────────────────────────────────────────
// LuxAlgo-style: [fisher, trigger] where trigger = fisher[1]. Value = normalized
// price in [-1,1] smoothed ×0.33, signal = atanh recursion ×0.5.

interface FisherState { v?: number; f?: number }

reg('fisher', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'length']);
  const src = srcOf(ctx, b) ?? vsOf(ctx, { kind: 'series', v: ctx.hlc3 }, 'hlc3');
  const L = lenOf(b) ?? 9;
  const rt = ctx as RtCtx;
  const key = `fisher|${rt.callsite ?? 'g'}|${emaTag(ctx, b)}|${L}`;
  const st = stateFor<FisherState>(ctx, `stv-x|${key}`, () => ({}));
  const lastBar = stateFor<{ n: number }>(ctx, `stv-b|${key}`, () => ({ n: -1 }));
  const memo = stateFor<Map<number, [number, number] | undefined>>(ctx, `stv-m|${key}`, () => new Map());
  const bar = ctx.barIndex;
  if (memo.has(bar)) {
    const m = memo.get(bar);
    return m === undefined ? arr(NA, NA) : arr(fl(m[0]), fl(m[1]));
  }
  let out: [number, number] | undefined;
  for (let bb = lastBar.n + 1; bb <= bar; bb++) {
    const price = src.get(bb);
    const hi = highestWin(src, bb, L), lo = lowestWin(src, bb, L);
    if (price === undefined || hi === undefined || lo === undefined) { memo.set(bb, undefined); out = undefined; continue; }
    const range = hi - lo;
    let v = range === 0 ? 0 : 0.66 * ((price - lo) / range - 0.5) + 0.67 * (st.v ?? 0);
    if (v > 0.99) v = 0.999;
    if (v < -0.99) v = -0.999;
    const f = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * (st.f ?? 0);
    const prevF = st.f ?? 0;
    st.v = v; st.f = f;
    memo.set(bb, [f, prevF]);
    out = [f, prevF];
  }
  lastBar.n = bar;
  return out === undefined ? arr(NA, NA) : arr(fl(out[0]), fl(out[1]));
});

// ── nadaraya-watson envelope (rational quadratic kernel) ────────────────────

reg('nadarayaWatsonEnvelope', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'h', 'r', 'x_0', 'lag', 'mult']);
  const src = srcOf(ctx, b) ?? vsOf(ctx, { kind: 'series', v: ctx.close }, 'close');
  const h = numArg(b, 'h', 8);
  const r = numArg(b, 'r', 8);
  const x0 = Math.trunc(numArg(b, 'x_0', 25));
  const lag = Math.trunc(numArg(b, 'lag', 2));
  const bar = ctx.barIndex;
  let num_ = 0, den = 0;
  for (let i = 0; i < x0; i++) {
    const v = src.get(bar - i);
    if (v === undefined) return arr(NA, NA, NA);
    const w = Math.pow(1 + (i * i) / (2 * r * h * h), -r);
    num_ += v * w;
    den += w;
  }
  const yhat = num_ / den;
  // band: mean absolute error between src and kernel estimate, ×mult (default ~1)
  const mult = numArg(b, 'mult', 1);
  let mae = 0, cnt = 0;
  for (let i = 0; i < x0; i++) {
    const v = src.get(bar - i);
    if (v === undefined) break;
    // per-bar kernel estimate would be expensive; use deviation from current yhat
    mae += Math.abs(v - yhat);
    cnt++;
  }
  const band = cnt > 0 ? mult * (mae / cnt) : 0;
  void lag;
  return arr(fl(yhat + band), fl(yhat - band));
});

// ── sar ──────────────────────────────────────────────────────────────────────
// Standard Wilder parabolic SAR. state: sar value, extreme point, af, isUp.

interface SarState { sar?: number; ep?: number; af?: number; up?: boolean }

reg('sar', (ctx, args, named) => {
  const b = bindArgs(args, named, ['start', 'inc', 'max']);
  const start = numArg(b, 'start', 0.02);
  const inc = numArg(b, 'inc', 0.02);
  const max = numArg(b, 'max', 0.2);
  const rt = ctx as RtCtx;
  const key = `sar|${rt.callsite ?? 'g'}|${start}|${inc}|${max}`;
  const st = stateFor<SarState>(ctx, `stv-x|${key}`, () => ({}));
  const lastBar = stateFor<{ n: number }>(ctx, `stv-b|${key}`, () => ({ n: -1 }));
  const memo = stateFor<Map<number, number | undefined>>(ctx, `stv-m|${key}`, () => new Map());
  const bar = ctx.barIndex;
  if (memo.has(bar)) return fl(memo.get(bar));
  let out: number | undefined;
  for (let bb = lastBar.n + 1; bb <= bar; bb++) {
    const off = ctx.barIndex - bb;
    const h = num(ctx.high.get(off)), l = num(ctx.low.get(off));
    if (h === undefined || l === undefined) { memo.set(bb, undefined); out = undefined; continue; }
    if (st.sar === undefined || st.ep === undefined || st.af === undefined || st.up === undefined) {
      st.up = true; st.ep = h; st.sar = l; st.af = start;
      memo.set(bb, st.sar); out = st.sar; continue;
    }
    let sar = st.sar + st.af * (st.ep - st.sar);
    let up = st.up;
    if (up) {
      // SAR cannot be above prior two lows
      const l1 = num(ctx.low.get(off + 1)), l2 = num(ctx.low.get(off + 2));
      if (l1 !== undefined) sar = Math.min(sar, l1);
      if (l2 !== undefined) sar = Math.min(sar, l2);
      if (l < sar) { // reversal to down
        up = false; sar = st.ep; st.ep = l; st.af = start;
      } else {
        if (h > st.ep) { st.ep = h; st.af = Math.min(st.af + inc, max); }
      }
    } else {
      const h1 = num(ctx.high.get(off + 1)), h2 = num(ctx.high.get(off + 2));
      if (h1 !== undefined) sar = Math.max(sar, h1);
      if (h2 !== undefined) sar = Math.max(sar, h2);
      if (h > sar) {
        up = true; sar = st.ep; st.ep = h; st.af = start;
      } else {
        if (l < st.ep) { st.ep = l; st.af = Math.min(st.af + inc, max); }
      }
    }
    st.up = up; st.sar = sar;
    memo.set(bb, sar); out = sar;
  }
  lastBar.n = bar;
  return fl(out);
});

// ── tsi ──────────────────────────────────────────────────────────────────────

reg('tsi', (ctx, args, named) => {
  // TV names are short_length/long_length; legacy shortlen/longlen still accepted.
  const b = bindArgs(args, named, ['source', 'short_length', 'long_length', 'shortlen', 'longlen']);
  const src = srcOf(ctx, b);
  const shortL = lenOf(b, 'short_length') ?? lenOf(b, 'shortlen') ?? 13;
  const longL = lenOf(b, 'long_length') ?? lenOf(b, 'longlen') ?? 25;
  if (!src) return NA;
  const tag = emaTag(ctx, b);
  const mo = vseries(ctx, `tsi-m|${tag}`, (bb) => {
    const c = src.get(bb), p = src.get(bb - 1);
    return c === undefined || p === undefined ? undefined : c - p;
  });
  const amo = vseries(ctx, `tsi-am|${tag}`, (bb) => {
    const c = src.get(bb), p = src.get(bb - 1);
    return c === undefined || p === undefined ? undefined : Math.abs(c - p);
  });
  const ds = (s: VS, t: string) => {
    const e1 = emaVs(ctx, s, longL, `tsi1|${t}`);
    return emaVs(ctx, e1, shortL, `tsi2|${t}`);
  };
  const numS = ds(mo, `n${tag}`);
  const denS = ds(amo, `d${tag}`);
  const bar = ctx.barIndex;
  const n = numS.get(bar), d = denS.get(bar);
  if (n === undefined || d === undefined || d === 0) return NA;
  return fl(100 * n / d);
});

// ── vwap ─────────────────────────────────────────────────────────────────────
// ta.vwap(source, stdev, anchor): cumulative Σpv/Σv reset wherever `anchor` is
// truthy (bool series) or, for a timeframe-string anchor, on bars opening a new
// period. With `stdev` present the result is the tuple [vwap, upper, lower].

reg('vwap', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source', 'stdev', 'anchor']);
  const src = srcOf(ctx, b) ?? vsOf(ctx, { kind: 'series', v: ctx.hlc3 }, 'hlc3');
  const sdV = b.get('stdev');
  const sdMult = numArg(b, 'stdev', NaN);
  const hasSd = sdV !== undefined && Number.isFinite(sdMult);
  const anchorV = b.get('anchor');
  const rt = ctx as RtCtx;
  const anchorUnw0 = anchorV !== undefined ? unwrapped(anchorV) : undefined;
  const aTag = anchorV === undefined ? 'none'
    : anchorV.kind === 'series' && anchorUnw0?.kind !== 'string' ? `s${seriesId(anchorV.v)}`
    : `v${anchorUnw0 !== undefined && anchorUnw0.kind === 'string' ? anchorUnw0.v : anchorV.kind}`;
  const key = `vwap|${rt.callsite ?? 'g'}|${emaTag(ctx, b)}|${aTag}|${hasSd ? sdMult : ''}`;
  const st = stateFor<{ sv?: number; spv?: number; svv?: number }>(ctx, `stv-x|${key}`, () => ({}));
  const lastBar = stateFor<{ n: number }>(ctx, `stv-b|${key}`, () => ({ n: -1 }));
  const memo = stateFor<Map<number, [number | undefined, number | undefined] | undefined>>(ctx, `stv-m|${key}`, () => new Map());

  // Anchor test at absolute bar bb: bool-series truthy, tf-string boundary,
  // or a truthy scalar (reset every bar — degenerate but consistent).
  const anchorUnw = anchorV !== undefined ? unwrapped(anchorV) : undefined;
  const anchorStr = anchorUnw !== undefined && anchorUnw.kind === 'string' ? anchorUnw.v : undefined;
  const anchorSpec = anchorStr === 'session' ? 'D'
    : anchorStr === 'week' ? 'W'
    : anchorStr === 'month' ? 'M'
    : anchorStr === 'quarter' ? 'Q'
    : anchorStr === 'year' ? 'Y'
    : anchorStr;
  const anchorAt = (bb: number): boolean => {
    if (bb === 0) return true;
    if (anchorV === undefined) return false;
    if (anchorStr !== undefined) return isTfBoundary(ctx, anchorSpec!, bb);
    if (anchorV.kind === 'series') return truthy(anchorV.v.get(ctx.barIndex - bb));
    return truthy(anchorV);
  };

  const emit = (r: [number | undefined, number | undefined] | undefined): Value =>
    r === undefined || r[0] === undefined
      ? (hasSd ? arr(NA, NA, NA) : NA)
      : (hasSd ? arr(fl(r[0]), fl(r[0]! + sdMult * (r[1] ?? 0)), fl(r[0]! - sdMult * (r[1] ?? 0))) : fl(r[0]));

  const bar = ctx.barIndex;
  if (memo.has(bar)) return emit(memo.get(bar));
  let out: [number | undefined, number | undefined] | undefined;
  for (let bb = lastBar.n + 1; bb <= bar; bb++) {
    if (anchorAt(bb)) { st.sv = 0; st.spv = 0; st.svv = 0; }
    const p = src.get(bb), v = num(ctx.volume.get(ctx.barIndex - bb));
    if (p === undefined || v === undefined) {
      const vw = st.sv !== undefined && st.sv !== 0 ? st.spv! / st.sv : undefined;
      const sd = vw === undefined ? undefined : Math.sqrt(Math.max(0, st.svv! / st.sv! - vw * vw));
      memo.set(bb, vw === undefined ? undefined : [vw, sd]);
      out = memo.get(bb);
      continue;
    }
    st.sv = (st.sv ?? 0) + v;
    st.spv = (st.spv ?? 0) + p * v;
    st.svv = (st.svv ?? 0) + v * p * p;
    const vw = st.sv === 0 ? undefined : st.spv! / st.sv;
    const sd = vw === undefined ? undefined : Math.sqrt(Math.max(0, st.svv! / st.sv - vw * vw));
    memo.set(bb, vw === undefined ? undefined : [vw, sd]);
    out = memo.get(bb);
  }
  lastBar.n = bar;
  return emit(out);
});

// ── vortex ───────────────────────────────────────────────────────────────────

reg('vortex', (ctx, args, named) => {
  const b = bindArgs(args, named, ['length']);
  const L = lenOf(b) ?? 14;
  let vip = 0, vim = 0, trs = 0;
  for (let i = 0; i < L; i++) {
    const h = num(ctx.high.get(i)), l = num(ctx.low.get(i));
    const hp = num(ctx.high.get(i + 1)), lp = num(ctx.low.get(i + 1)), cp = num(ctx.close.get(i + 1));
    if (h === undefined || l === undefined || hp === undefined || lp === undefined) return arr(NA, NA);
    vip += Math.abs(h - lp);
    vim += Math.abs(l - hp);
    trs += cp === undefined ? h - l : Math.max(h - l, Math.abs(h - cp), Math.abs(l - cp));
  }
  if (trs === 0) return arr(NA, NA);
  return arr(fl(vip / trs), fl(vim / trs));
});

// ── stoch / valuewhen ────────────────────────────────────────────────────────

reg('stoch', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source','high','low','length'] as const);
  const src = srcOf(ctx, b, 'source');
  const hi = srcOf(ctx, b, 'high');
  const lo = srcOf(ctx, b, 'low');
  const L = lenOf(b);
  if (!src || !hi || !lo || L === undefined) return NA;
  const bar = ctx.barIndex;
  let h = -Infinity, l = Infinity;
  for (let i = 0; i < L; i++) {
    const hv = hi.get(bar - i), lv = lo.get(bar - i);
    if (hv === undefined || lv === undefined) return NA;
    if (hv > h) h = hv;
    if (lv < l) l = lv;
  }
  const c = src.get(bar);
  if (c === undefined || h === l) return NA;
  return fl(100 * (c - l) / (h - l));
});

reg('valuewhen', (ctx, args, named) => {
  const b = bindArgs(args, named, ['condition','source','occurrence'] as const);
  const condV = b.get('condition');
  const src = srcOf(ctx, b, 'source');
  const occRaw = b.get('occurrence');
  const occV = occRaw === undefined ? undefined : curNum(occRaw);
  const occ = occV === undefined || !Number.isFinite(occV) || occV < 0 ? 0 : Math.floor(occV);
  if (condV === undefined || !src) return NA;
  // Condition may be a bool series — use a truthy accessor rather than numeric VS.
  const condAt = (off: number): boolean => {
    if (condV.kind === 'series') return truthy(condV.v.get(off));
    return truthy(condV);
  };
  let seen = 0;
  for (let off = 0; off <= ctx.barIndex; off++) {
    if (condAt(off)) {
      if (seen === occ) return fl(src.get(ctx.barIndex - off));
      seen++;
    }
  }
  return NA;
});

// ── bare ta.tr / ta.obv as lazy series constants ─────────────────────────────
// Scripts use `ta.tr` / `ta.obv` as series values (no parens). FnSeries wraps a
// per-offset computation; the heavy lifting reuses the memoized tr/obv VS.

class FnSeries extends Series {
  constructor(private ctx: BuiltinCtx, private fn: (off: number) => Value) { super(); }
  override get(n: number): Value { return this.fn(n); }
  override cur(): Value { return this.fn(0); }
  override size(): number { return this.ctx.barIndex + 1; }
}

registerLazyConstant('ta', 'tr', (c) => {
  if (c === undefined) return NA;
  const ctx = c as BuiltinCtx;
  return { kind: 'series', v: new FnSeries(ctx, (off) => {
    const h = num(ctx.high.get(off)), l = num(ctx.low.get(off));
    if (h === undefined || l === undefined) return NA;
    const pc = num(ctx.close.get(off + 1));
    if (pc === undefined) return NA; // handle_na=true: bar 0 has no prev close
    return fl(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  })};
});

registerLazyConstant('ta', 'obv', (c) => {
  if (c === undefined) return NA;
  const ctx = c as BuiltinCtx;
  const closes = vsOf(ctx, { kind: 'series', v: ctx.close }, 'close');
  const obv = vstate(ctx, 'obv|bare', (bb) => {
    const cc = closes.get(bb), p = closes.get(bb - 1), vol = num(ctx.volume.get(ctx.barIndex - bb));
    if (cc === undefined || p === undefined || vol === undefined) return undefined;
    const prev = obv.get(bb - 1) ?? 0;
    return prev + (cc > p ? vol : cc < p ? -vol : 0);
  });
  return { kind: 'series', v: new FnSeries(ctx, (off) => fl(obv.get(ctx.barIndex - off))) };
});

// Bare-variable forms — TV defines these as variables, not functions:
// `plot(ta.wad)` is legal; `ta.wad()` is not. The lazy constant drives the
// same vstate accumulator (separate 'bare' key → independent memo, identical math).
const bareAccum: Record<string, (ctx: BuiltinCtx, key: string) => VS> = {
  wad: wadVs,
  pvt: pvtVs,
  nvi: (c, k) => nviPviVs(c, true, k),
  pvi: (c, k) => nviPviVs(c, false, k),
};
for (const name of ['wad', 'pvt', 'nvi', 'pvi'] as const) {
  registerLazyConstant('ta', name, (c) => {
    if (c === undefined) return NA;
    const ctx = c as BuiltinCtx;
    const acc = bareAccum[name]!(ctx, `ta.${name}|bare`);
    return { kind: 'series', v: new FnSeries(ctx, (off) => fl(acc.get(ctx.barIndex - off))) };
  });
}
