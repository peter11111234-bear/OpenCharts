// ── Builtin + constant registry ─────────────────────────────────────────────
// Shared by every builtins/*.ts module. Builtins self-register at import time
// via `registerBuiltin('ns','name',fn)`; callers look up `BUILTINS` by the
// dotted key `ns.name` (bare `name` when ns === '').
// Enum/constant namespaces (shape.*, color.*, barmerge.*, …) live in
// `CONSTANTS` / `LAZY_CONSTANTS`, resolved via `getConstant`.

import type { BuiltinFn, Value } from '../contracts';

export const BUILTINS: Map<string, BuiltinFn> = new Map();

/** Which args of a builtin need per-bar callHist history. `true` = all args
 *  (ta.* srcOf/vsOf window scans, verbatim series passthrough like nz);
 *  {idx,names} = only those param slots (positional index AND named-arg name
 *  both covered, since callers may use either). Builtins that only read
 *  `.cur()` at call time get no entry — evalArg skips their tracking. */
export interface HistSpec { idx: readonly number[]; names: readonly string[] }
export const HIST_BUILTINS = new Map<BuiltinFn, HistSpec | true>();

/** Which args of a builtin must arrive as a PLAIN value, never a series
 *  wrapper. evalArg wraps builtin args for three reasons: a bare ident bound to
 *  a BarSeries slot (every declared variable), a num/bool literal on the
 *  litFastPath, and a scalar expression when `noHist` is false. Builtins that
 *  read an arg through `.cur()`-style helpers (`asNum`/`asStr`/`truthy`/
 *  `unwrapped`) don't care; builtins that test `v.kind === 'na'`,
 *  `switch (v.kind)` or `v.kind === 'array'` see 'series' instead of the real
 *  kind and take the wrong branch. Its `ScalarSpec` is declared in the
 *  option-A table (`builtins/scalarDeclPatch.ts`), which `callBuiltin` reads
 *  through `SCALAR_BUILTINS`; there is no per-registration entry point on
 *  purpose, so that one list stays auditable.
 *  NEVER declare an arg that must keep its history (ta.* source/vs,
 *  nz, plot's value). Scalar wins over HistSpec when both name one slot. */
export interface ScalarSpec {
  idx: readonly number[];
  names: readonly string[];
  /** The family's `bindArgs` order. `idx` holds order slots, but `callBuiltin`
   *  sees only the raw positional array — and `bindArgs` fills positionals into
   *  the slots no named arg claimed, so the two differ as soon as a named arg
   *  takes a lower slot. Required whenever `idx` is not exactly
   *  `[0, 1, … names.length-1]`; absent means "risk not modelled yet", and the
   *  unwrap then stays index-equals-slot (see the integrity test's NOT-caught
   *  list). */
  order?: readonly string[];
}
export const SCALAR_BUILTINS = new Map<BuiltinFn, ScalarSpec>();

/** Raw positional index -> the `bindArgs` order slot that positional actually
 *  lands in, for one call: a named arg claims its slot, positionals fill the
 *  rest in order (`util.ts` bindArgs). Mirrors that function's `series` →
 *  `source` alias so the two cannot disagree. */
export function positionalSlots(
  order: readonly string[],
  named: Record<string, Value>,
  argCount: number,
): number[] {
  const keys = Object.keys(named);
  const slotOf: number[] = [];
  for (let s = 0; s < order.length && slotOf.length < argCount; s++) {
    const slot = order[s]!;
    const claimed = keys.some((k) => (!order.includes(k) && k === 'series' && order.includes('source') ? 'source' : k) === slot);
    if (!claimed) slotOf.push(s);
  }
  return slotOf;
}

/** Resolve per-arg history need. Positional args match by index (named args
 *  don't consume positional slots); named args match by name. */
export function histSpecHas(spec: HistSpec | true | undefined, posIdx: number, name?: string): boolean {
  if (spec === undefined) return false;
  if (spec === true) return true;
  return name !== undefined ? spec.names.includes(name) : spec.idx.includes(posIdx);
}

/** Namespaces where every builtin consumes arg history as a series
 *  (ta.* srcOf/vsOf window args). array.* is spec-per-builtin — only
 *  element-stash params need history, index/size args don't. */
const HIST_NS: Record<string, true> = { ta: true };

/** Two-level mirror of BUILTINS for `<value.kind>.<prop>` dispatch
 *  (e.g. `arr.push` on an array receiver → kindBuiltin('array','push')).
 *  Populated by registerBuiltin — same namespacing, no string concat at
 *  dispatch time. */
const KIND_BUILTIN = new Map<string, Map<string, BuiltinFn>>();

export function kindBuiltin(kind: string, prop: string): BuiltinFn | undefined {
  return KIND_BUILTIN.get(kind)?.get(prop);
}
export const CONSTANTS: Map<string, Value> = new Map();
const LAZY_CONSTANTS = new Map<string, (ctx?: unknown) => Value>();

/** Register a builtin under `ns.name` (e.g. 'ta','sma' → 'ta.sma').
 *  Pass `ns === ''` for top-level functions (e.g. 'plot').
 *  `hist`: true = every arg keeps callHist; HistSpec = only those params;
 *  undefined defaults to HIST_NS membership (ta), false opts out. */
export function registerBuiltin(ns: string, name: string, fn: BuiltinFn, hist?: boolean | HistSpec): void {
  const key = ns ? `${ns}.${name}` : name;
  BUILTINS.set(key, fn);
  const spec = hist === undefined ? (ns in HIST_NS ? true : undefined) : hist || undefined;
  if (spec !== undefined) HIST_BUILTINS.set(fn, spec);
  let perKind = KIND_BUILTIN.get(ns);
  if (perKind === undefined) {
    perKind = new Map();
    KIND_BUILTIN.set(ns, perKind);
  }
  perKind.set(name, fn);
}

/** Register a constant Value under `ns.name` (e.g. 'shape','triangleup'). */
export function registerConstant(ns: string, name: string, v: Value): void {
  CONSTANTS.set(ns ? `${ns}.${name}` : name, v);
}

/** Register a lazily-evaluated constant (e.g. `line.all` — fresh per access).
 *  `get` may accept the current BuiltinCtx (pass it if you have it). */
export function registerLazyConstant(
  ns: string, name: string, get: (ctx?: unknown) => Value,
): void {
  LAZY_CONSTANTS.set(ns ? `${ns}.${name}` : name, get);
}

/** Look up a constant by dotted key. Lazy entries evaluate fresh each call;
 *  pass the current BuiltinCtx when available so ctx-dependent constants
 *  (like `line.all`) resolve correctly. */
export function getConstant(key: string, ctx?: unknown): Value | undefined {
  const lazy = LAZY_CONSTANTS.get(key);
  if (lazy) return lazy(ctx);
  return CONSTANTS.get(key);
}

export function hasConstant(key: string): boolean {
  return CONSTANTS.has(key) || LAZY_CONSTANTS.has(key);
}
