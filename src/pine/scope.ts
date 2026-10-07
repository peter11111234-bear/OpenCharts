// ── Pine scopes & evaluation frames ──────────────────────────────────────────
// `Scope` identity comes from contracts.ts (private fields → nominal type; all
// modules must share that one class). Re-exported here; this module adds the
// Frame type the interpreter evaluates against plus var/series slot helpers.

import { NA, Scope, Series, type BuiltinCtx, type UdfDecl, type Value } from './contracts';
import { BarSeries, histGetAt } from './series';

export { Scope };

/**
 * Per-bar evaluation context threaded through evalExpr/evalBlock.
 * - `scope`   — innermost variable scope; frames nest per UDF call.
 * - `ctx`     — builtin context for the current bar (OHLCV, sinks, syminfo).
 * - `loopVar` — name of the enclosing `for` loop variable, if any. Loop vars
 *               are ordinary BarSeries defined in the frame's child scope;
 *               the field exists so `break`/`continue`/nested shadowing can
 *               find the innermost binding quickly.
 */
export interface Frame {
  scope: Scope;
  ctx: BuiltinCtx;
  loopVar?: string;
}

/** Root frame for bar evaluation. */
export function rootFrame(ctx: BuiltinCtx): Frame {
  return { scope: new Scope(), ctx };
}

/** Child frame for a UDF call: params/loop var land in a scope chained to the function's closure. */
export function callFrame(parent: Frame, closure?: Scope): Frame {
  return { scope: new Scope(closure ?? parent.scope), ctx: parent.ctx };
}

/** Child frame for an indented block / loop body sharing the same ctx. */
export function blockFrame(parent: Frame, loopVar?: string): Frame {
  const f: Frame = { scope: new Scope(parent.scope), ctx: parent.ctx };
  if (loopVar !== undefined) f.loopVar = loopVar;
  return f;
}

/** Define a mutable series slot in `scope`, writing `init` at `bar`. */
export function defineSeries(scope: Scope, name: string, init: Value, bar: number, cap = 5000): BarSeries {
  const s = new BarSeries(cap);
  s.setAt(bar, init);
  scope.define(name, s);
  return s;
}

/**
 * Declare/assign `name` at `bar`: shadows in `scope` when the name is not
 * already defined *in this scope* (Pine `x = e` rebinds each bar but the slot
 * is created once), otherwise writes through to the existing slot — including
 * one in an ancestor scope.
 */
export function assignVar(scope: Scope, name: string, v: Value, bar: number): BarSeries {
  const slot = scope.lookup(name);
  if (slot instanceof BarSeries) {
    slot.setAt(bar, v);
    return slot;
  }
  if (slot instanceof Series) slot.set(v);
  return defineSeries(scope, name, v, bar);
}

/**
 * `x := e` — reassign an existing variable in place. Throws when the name is
 * undeclared (Pine compile error territory, surfaced as runtime error).
 */
export function writeVar(scope: Scope, name: string, v: Value, bar: number): void {
  const slot = scope.lookup(name);
  if (slot instanceof BarSeries) {
    slot.setAt(bar, v);
    return;
  }
  if (slot instanceof Series) {
    slot.set(v);
    return;
  }
  if (slot === undefined) throw new Error(`Pine: cannot reassign undeclared variable '${name}'`);
  throw new Error(`Pine: '${name}' is immutable (function/type binding)`);
}

/**
 * Read a variable's current-bar value. Series slots read via carry-forward;
 * anything else (functions, immutables) is returned as-is. Unknown → na.
 */
export function readVar(scope: Scope, name: string, bar: number): Value {
  const slot = scope.lookup(name);
  if (slot === undefined) return NA;
  if (slot instanceof Series) return histGetAt(slot, 0, bar);
  return slot;
}

/**
 * Look up a slot as a Series for history-reference (`name[n]`). Plain-Value
 * slots are constants: `v[0] = v`, `v[n>0] = na` — so we only expose true
 * Series here and let the caller decide how to read constants.
 */
export function seriesOf(scope: Scope, name: string): Series | undefined {
  const slot = scope.lookup(name);
  return slot instanceof Series ? slot : undefined;
}

/** Bind UDF params into a fresh call scope; defaults handled by caller. */
export function bindParams(fn: UdfDecl, args: Value[], parent: Frame): Frame {
  const frame = callFrame(parent, fn.closure);
  for (let i = 0; i < fn.params.length; i++) {
    const p = fn.params[i]!;
    const v = args[i] ?? NA;
    defineSeries(frame.scope, p.name, v, parent.ctx.barIndex);
  }
  return frame;
}
