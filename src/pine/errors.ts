// ── Pine runtime errors ──────────────────────────────────────────────────────
// Single error type for the evaluator: carries source location (line/col are
// 1-based, matching Token/AST `loc`). Internal control-flow signals (break /
// continue / return) live in interpreter.ts — they are NOT errors.

import type { Node } from './contracts';

export interface PineLoc {
  line: number;
  col: number;
}

export class PineRuntimeError extends Error {
  readonly line: number;
  readonly col: number;

  constructor(msg: string, loc?: PineLoc) {
    super(msg);
    this.name = 'PineRuntimeError';
    this.line = loc?.line ?? 0;
    this.col = loc?.col ?? 0;
  }
}

/** Build a PineRuntimeError anchored at an AST node. */
export function pineErr(node: Node | undefined, msg: string): PineRuntimeError {
  return new PineRuntimeError(msg, node?.loc);
}

/**
 * Convert an arbitrary thrown value into a PineRuntimeError anchored at `node`.
 * PineRuntimeError instances pass through unchanged (innermost location wins).
 */
export function wrapPineError(e: unknown, node: Node | undefined): PineRuntimeError {
  if (e instanceof PineRuntimeError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new PineRuntimeError(msg, node?.loc);
}
