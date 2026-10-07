// ── Builtin + constant registry ─────────────────────────────────────────────
// Shared by every builtins/*.ts module. Builtins self-register at import time
// via `registerBuiltin('ns','name',fn)`; callers look up `BUILTINS` by the
// dotted key `ns.name` (bare `name` when ns === '').
// Enum/constant namespaces (shape.*, color.*, barmerge.*, …) live in
// `CONSTANTS` / `LAZY_CONSTANTS`, resolved via `getConstant`.

import type { BuiltinFn, Value } from '../contracts';

export const BUILTINS: Map<string, BuiltinFn> = new Map();
export const CONSTANTS: Map<string, Value> = new Map();
const LAZY_CONSTANTS = new Map<string, (ctx?: unknown) => Value>();

/** Register a builtin under `ns.name` (e.g. 'ta','sma' → 'ta.sma').
 *  Pass `ns === ''` for top-level functions (e.g. 'plot'). */
export function registerBuiltin(ns: string, name: string, fn: BuiltinFn): void {
  BUILTINS.set(ns ? `${ns}.${name}` : name, fn);
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
