// ── Builtin helpers ─────────────────────────────────────────────────────────
// Shared coercion/arg-binding helpers + the runtime ctx extension fields that
// builtins and the interpreter both rely on (all optional on BuiltinCtx so the
// contract file stays frozen).
//
// Conventions (no wrappers, used inline):
//   na check      → `v.kind === 'na'`
//   na value      → `NA` (imported from contracts)
//   bool value    → `cond ? VTRUE : VFALSE`
//   string value  → `{ kind: 'string', v: s }`

import type { Arg, BuiltinCtx, DrawObj, InputSchemaLite, Node, Value } from '../contracts';

/** Runtime context extension fields. `BuiltinCtx` is frozen in contracts.ts, so
 *  builtins access these via this interface — the interpreter populates them
 *  opportunistically; every builtin must tolerate them being absent. */
export interface RtCtx extends BuiltinCtx {
  /** Unique id for the current call site (e.g. `#3` in source order). */
  callsite?: string;
  /** User overrides for `input.*`, keyed by title or generated id. */
  inputs?: Record<string, unknown>;
  /** `input.*` pushes collected schemas here (dedup by id). */
  inputSchemas?: InputSchemaLite[];
  /** call-site → id for the 2nd+ input sharing a title (scriptDecl.planInputIds).
   *  Such an input answers to this id only, never to the shared title. */
  dupInputIds?: Map<string, string>;
  /** Call node → that id, for the whole script. Set on the chart ctx before the
   *  run; mtf copies it into each request.security ctx with `inputs`. */
  inputPlan?: Map<object, string>;
  /** call-site → plot sink index. */
  plotIds?: Map<string, number>;
  /** Next free plot sink index (also counts hline sinks). */
  plotSeq?: number;
  /** Live drawing objects backing `*.all` constants. */
  liveLines?: DrawObj[];
  liveLabels?: DrawObj[];
  liveBoxes?: DrawObj[];
  liveTables?: DrawObj[];
  livePolylines?: DrawObj[];
  liveLinefills?: DrawObj[];
  /** barIndex → (callsite → color) for `bgcolor` / `barcolor` — per-callsite layers. */
  bgcolors?: Map<number, Map<string, string>>;
  barcolors?: Map<number, Map<string, string>>;
  /** call-site → last bar alert() fired (freq gating). */
  alertstate?: Map<string, number>;
  /** Registered alertcondition entries. */
  alertconditions?: { title: string; msg: string }[];
  /** fill() descriptors linking two plot indices. */
  fills?: { plot1: number; plot2: number; color?: string; title?: string; fillgaps?: boolean }[];
  /** fill() call-site → index into `fills` — TV keeps one fill object per call
   *  site, updated each bar, so we overwrite rather than push duplicates. */
  fillSites?: Map<string, number>;
  /** Internal counter for generated input ids / fill ids. */
  miscSeq?: number;
  /** Per-run persistent state for stateful builtins (ta.rma/ema chains, supertrend…).
   *  ta.ts keys it as a nested-Map chain (parts = string|number|bool|undefined);
   *  strategy.* uses flat 'strategy|*' string keys on the same map. Created once
   *  per run by the interpreter (or lazily by the builtin itself when absent). */
  state?: Map<unknown, unknown>;
  /** Block/UDF nesting depth of the currently evaluating code (0 = global
   *  scope). Maintained by the interpreter's evalBlock/callUdfValue; builtins
   *  restricted to global scope (plot family, CE10188) warn-and-skip when >0. */
  scopeDepth?: number;
  /** Set of warn-once keys already emitted this run (see warnOnce). */
  warnKeys?: Set<string>;
  /** Drawing object quotas from the indicator()/strategy() declaration
   *  (max_*_count). Absent → default 50. */
  declQuotas?: { lines?: number; labels?: number; boxes?: number; tables?: number; polylines?: number };
}

/** Emit a warning at most once per run+key (warnings land on ctx.warnings). */
export function warnOnce(ctx: BuiltinCtx, key: string, msg: string): void {
  const rt = ctx as RtCtx;
  rt.warnKeys ??= new Set();
  if (rt.warnKeys.has(key)) return;
  rt.warnKeys.add(key);
  ctx.warnings.push(msg);
}

/**
 * CE10188: the plot/output family may only be called from the script's global
 * scope. In a local scope (if/for/while/switch block or UDF body) TradingView
 * rejects the call at compile time; here we warn once per callsite and the
 * caller skips. Returns true when the call must be skipped.
 */
export function inLocalScope(ctx: BuiltinCtx, name: string): boolean {
  const rt = ctx as RtCtx;
  if (!(rt.scopeDepth !== undefined && rt.scopeDepth > 0)) return false;
  warnOnce(ctx, `localscope|${rt.callsite ?? name}`, `${name}() in local scope, skipped per CE10188 — must be global scope`);
  return true;
}

/**
 * Bind declaration-arg AST nodes against a Pine signature order — same fill
 * rules as bindArgs but on unevaluated nodes (indicator()/strategy() decls).
 */
export function bindDeclArgs(args: Arg[] | undefined, order: readonly string[]): Map<string, Node> {
  const bound = new Map<string, Node>();
  let pi = 0;
  for (const a of args ?? []) {
    if (a.name !== undefined) {
      // TV rejects an unknown parameter name in indicator()/strategy() at
      // compile time; this layer has the reference order, so name it. Declarations
      // are bound before any run ctx exists, so the warning rides the same bind
      // queue bindArgs uses — drained by flushBindWarnings at the decl site
      // (callBuiltin only drains for its own builtin calls). A decl is bound
      // twice (declDrawQuotas + warnUnsupportedIndicatorParams, or strategyDecl
      // + declDrawQuotas), so a message is queued twice and the ctx.warnings
      // dedup on flush collapses it to one.
      if (!order.includes(a.name)) {
        bindWarnQ.push(
          `unknown named argument '${a.name}=' — ignored; this declaration takes (${order.join(', ')})`);
        continue;
      }
      if (bound.has(a.name)) {
        // Keep the FIRST binding, matching bindCallArgs (bindArgs warns
        // "overwritten" for the builtin path — TV errors on both).
        bindWarnQ.push(
          `duplicate named argument '${a.name}=' — ignored (this declaration parameter is already bound)`);
        continue;
      }
      bound.set(a.name, a.value);
      continue;
    }
    while (pi < order.length && bound.has(order[pi]!)) pi++;
    if (pi < order.length) bound.set(order[pi++]!, a.value);
  }
  return bound;
}
// ── Arg unwrapping ─────────────────────────────────────────────────────────
// evalArg wraps EVERY numeric/bool arg in a per-callsite BarSeries, so builtins
// must unwrap `{kind:'series'}` before reading scalars via num()/strOf()-style
// reads. numArg/strArg/boolArg/colorArg/curNum already unwrap; raw helpers below.

/** Series → current-bar Value; anything else → itself. */
export function unwrapped(v: Value | undefined): Value | undefined {
  return v !== undefined && v.kind === 'series' ? v.v.cur() : v;
}

// ── Coercion ────────────────────────────────────────────────────────────────

/** Truthiness: na → false, bool → itself, numbers → !== 0, others → true. */
export function truthy(v: Value): boolean {
  const u = v.kind === 'series' ? v.v.cur() : v;
  switch (u.kind) {
    case 'na': return false;
    case 'bool': return u.v;
    case 'int': case 'float': return u.v !== 0;
    case 'string': return u.v.length > 0;
    default: return true;
  }
}

export function asNum(v: Value): number {
  const u = v.kind === 'series' ? v.v.cur() : v;
  if (u.kind === 'int' || u.kind === 'float') return u.v;
  if (u.kind === 'bool') return u.v ? 1 : 0;
  if (u.kind === 'string') { const n = Number(u.v); return Number.isNaN(n) ? 0 : n; }
  return 0;
}

export function asStr(v: Value): string {
  const u = v.kind === 'series' ? v.v.cur() : v;
  switch (u.kind) {
    case 'string': return u.v;
    case 'int': case 'float': return String(u.v);
    case 'bool': return u.v ? 'true' : 'false';
    case 'color': return u.v;
    case 'na': return 'NaN';
    default: return String(u);
  }
}

export function asColor(v: Value): string {
  const u = v.kind === 'series' ? v.v.cur() : v;
  return u.kind === 'color' ? u.v : asStr(u);
}

// ── Arg binding ─────────────────────────────────────────────────────────────

/** Bind-time warnings queued until the caller's ctx is reachable. Drained by
 *  the interpreter's callBuiltin funnel. */
const bindWarnQ: string[] = [];

const EMPTY_WARNINGS: readonly string[] = Object.freeze([]);

/** Pop all queued bind-time warnings (empties the queue). */
export function drainBindWarnings(): string[] {
  // Fast path: empty queue → shared frozen array (no alloc per builtin call).
  if (bindWarnQ.length === 0) return EMPTY_WARNINGS as unknown as string[];
  return bindWarnQ.splice(0, bindWarnQ.length);
}

/** Shared frozen empty named-arg record. `invokeBuiltin` hands this out for
 *  every call with no `name=value` argument, so the hot path stops allocating
 *  a fresh `{}` per call. No builtin writes into `named` (every `named[...]=`
 *  in the tree sits at a call site, never inside a builtin), and the freeze
 *  makes a future writer fail loudly instead of corrupting the shared object. */
export const EMPTY_NAMED: Readonly<Record<string, Value>> = Object.freeze({});

/**
 * Bind positional+named args against a Pine parameter order.
 * Named args win their slot; positional args fill remaining slots in order —
 * a named-filled slot does NOT consume a positional (Pine allows named args
 * anywhere in the call).
 */
export function bindArgs(
  args: Value[],
  named: Record<string, Value>,
  order: readonly string[],
): Map<string, Value> {
  // TV's reference names differ from our internal order names on a few
  // functions (ta.bb(series, …), ta.bbw(series, …), ta.kc(series, …) vs our
  // 'source'). A named arg that isn't in `order` remaps through this table
  // when its alias target is — otherwise `ta.bb(series=…)` silently binds
  // nothing and returns na (observed: TD_BB Basis/Upper/Lower all-na).
  const out = new Map<string, Value>();
  // All-positional fast path: no named args → skip the named-merge loop. The
  // shared singleton short-circuits ahead of `Object.keys`, which used to
  // allocate an array on every call just to ask whether it was empty.
  if (named === EMPTY_NAMED || Object.keys(named).length === 0) {
    for (let i = 0; i < Math.min(args.length, order.length); i++) {
      out.set(order[i]!, args[i]!);
    }
    return out;
  }
  for (const [k, v] of Object.entries(named)) {
    const canon = !order.includes(k) && k === 'series' && order.includes('source') ? 'source' : k;
    if (!order.includes(canon)) {
      // TV rejects an unknown named argument at compile time ("Unknown
      // argument"); this layer sees no signature table, so the name is surfaced
      // here instead. Letting it through bound nothing and left the slot
      // undefined — MZigZag's `array.unshift(a, value=v)` hit an internal slot
      // named 'val', so every pivot came out na with no message.
      bindWarnQ.push(
        `unknown named argument '${k}=' — ignored; this function takes (${order.join(', ')})`);
      continue;
    }
    if (out.has(canon)) bindWarnQ.push(
      `named arg '${k}' collides with '${canon}' — the earlier binding is overwritten`);
    out.set(canon, v);
  }
  let i = 0;
  for (const name of order) {
    if (i >= args.length) break;
    if (!out.has(name)) {
      out.set(name, args[i]!);
      i++;
    }
  }
  // Extra positional args beyond the signature are ignored (Pine would error;
  // we stay lenient).
  return out;
}

export function numArg(bound: Map<string, Value>, name: string, def: number): number {
  const v = bound.get(name);
  if (v === undefined) return def;
  const u = v.kind === 'series' ? v.v.cur() : v;
  return u.kind === 'na' ? def : asNum(u);
}

/**
 * Drawing COORDINATE arg — unlike {@link numArg}, `na` stays `undefined`.
 * On TradingView an na coordinate means the object is not drawn; coercing it to 0
 * (the old `numArg(..., 0)` / `asNum`) parked lines/labels/boxes at price 0, and the
 * chart folds a visible drawing's price into the pane autoscale — so one na coordinate
 * anywhere in the loaded window dragged the price axis down to 0 and squashed the
 * candles. `undefined` reaches the model builder, which drops the object instead.
 * A MISSING arg is na too: a drawing coordinate has no Pine signature default
 * (line.new/label.new/box.new declare x1…bottom as required), so `line.new(x1, y1, x2)`
 * must not park the missing endpoint at price 0 where TradingView rejects the call.
 * Only int/float counts as a coordinate. `na`, an unparsable string (asNum maps it
 * to 0) and any other kind are all na: TradingView rejects the call, we just don't
 * draw — 0 is a PRICE, and parking a drawing on it collapses the pane autoscale.
 * Optional numeric props (width/size/counts) keep using {@link numArg}.
 */
export function naCoordArg(bound: Map<string, Value>, name: string): number | undefined {
  const v = bound.get(name);
  if (v === undefined) return undefined;
  const u = v.kind === 'series' ? v.v.cur() : v;
  if (u.kind !== 'int' && u.kind !== 'float') return undefined;
  return Number.isFinite(u.v) ? u.v : undefined;
}

/**
 * {@link naCoordArg} for positional (already-bound) values, e.g. the multi-arg
 * `set_*` setters: not a number → `undefined`.
 */
export function asNumOrNa(v: Value): number | undefined {
  const u = v.kind === 'series' ? v.v.cur() : v;
  if (u.kind !== 'int' && u.kind !== 'float') return undefined;
  return Number.isFinite(u.v) ? u.v : undefined;
}

export function strArg(bound: Map<string, Value>, name: string, def: string): string {
  const v = bound.get(name);
  if (v === undefined) return def;
  const u = v.kind === 'series' ? v.v.cur() : v;
  return u.kind === 'na' ? def : asStr(u);
}

export function boolArg(bound: Map<string, Value>, name: string, def: boolean): boolean {
  const v = bound.get(name);
  if (v === undefined) return def;
  const u = v.kind === 'series' ? v.v.cur() : v;
  return u.kind === 'na' ? def : truthy(u);
}

export function colorArg(bound: Map<string, Value>, name: string): string | undefined {
  const v = bound.get(name);
  if (v === undefined) return undefined;
  const u = v.kind === 'series' ? v.v.cur() : v;
  return u.kind === 'na' ? undefined : asColor(u);
}

// ── Series helpers ──────────────────────────────────────────────────────────

/** Current-bar numeric value: Series → cur(), number → itself, else undefined. */
export function curNum(v: Value): number | undefined {
  if (v.kind === 'series') return curNum(v.v.cur() as Value);
  if (v.kind === 'int' || v.kind === 'float') return v.v;
  return undefined;
}

/** Per-bar value to push into a PlotSink: unwrap Series → its current Value. */
export function plotVal(v: Value): Value {
  return v.kind === 'series' ? (v.v.cur() as Value) : v;
}

/** Wrap a JS number: int when integral, float otherwise. */
export function numVal(n: number): Value {
  return Number.isInteger(n) ? { kind: 'int', v: n } : { kind: 'float', v: n };
}

/** Slugify an input title into a stable id. */
export function slugify(s: string, fallback: string): string {
  const slug = s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || fallback;
}

