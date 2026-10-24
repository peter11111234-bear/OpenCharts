// ── Diagnostic switches: one door ───────────────────────────────────────────
// debugFlags.ts is the only place a switch may be read. This test greps the
// engine sources for direct `globalThis.__pine*` / `process.env.PINE_*` reads of
// a registered switch and for inline `__pineStage` writes, so a new reader
// cannot bypass the registry (PyneCore keeps its pipeline switches in one place
// for the same reason). Semantics are pinned too: strict flags only accept
// `true`, non-strict ones accept whatever is truthy.

import { describe, expect, it } from 'vitest';
import { DEBUG_FLAGS, debugFlag, debugFlagEnv, debugFlagGlobal, markStage, recordRunTiming } from '../debugFlags';
import { engineCode, engineSources } from './sourceScan';

const SWITCH_IDS = Object.keys(DEBUG_FLAGS) as (keyof typeof DEBUG_FLAGS)[];
const g = globalThis as Record<string, unknown>;

/** Run `f` with one global handle removed, then restore it. */
function withoutGlobal<T>(handle: string, f: () => T): T {
  const saved = g[handle];
  const had = handle in g;
  delete g[handle];
  try {
    return f();
  } finally {
    if (had) g[handle] = saved;
    else delete g[handle];
  }
}

describe('diagnostic switches', () => {
  it('every switch declares a handle or an env var, plus a reason', () => {
    for (const id of SWITCH_IDS) {
      const def = DEBUG_FLAGS[id];
      expect(def.global !== undefined || def.env !== undefined, id).toBe(true);
      expect(def.why.length, id).toBeGreaterThan(10);
    }
    expect(SWITCH_IDS.length).toBeGreaterThan(5);
  });

  it('is read through this module only', () => {
    const hits: string[] = [];
    const files = engineSources('src/pine');
    expect(files.length).toBeGreaterThan(15);            // the guard is not vacuous
    for (const [file, src] of engineCode('src/pine')) {
      if (file.endsWith('debugFlags.ts')) continue;      // the single reader
      for (const id of SWITCH_IDS) {
        const def = DEBUG_FLAGS[id];
        if (def.global !== undefined && src.includes(`.${def.global}`)) hits.push(`${file}: .${def.global}`);
        for (const [key] of def.env ?? []) {
          if (src.includes(`process.env?.${key}`) || src.includes(`process.env.${key}`)) {
            hits.push(`${file}: ${key}`);
          }
        }
      }
    }
    expect(hits, 'route these through debugFlag()').toEqual([]);
  });

  it('honours the global handle and the env var, strict flags only for `true`/`1`', () => {
    const prevEnv = process.env.PINE_JIT;
    try {
      withoutGlobal('__pineJit', () => {
        delete process.env.PINE_JIT;
        expect(debugFlag('jit')).toBe(false);
        process.env.PINE_JIT = '1';
        expect(debugFlag('jit')).toBe(true);
        process.env.PINE_JIT = '0';
        expect(debugFlag('jit')).toBe(false);
        g.__pineJit = 1;                        // strict: a non-boolean does not count
        expect(debugFlag('jit')).toBe(false);
        g.__pineJit = true;
        expect(debugFlag('jit')).toBe(true);
      });
    } finally {
      if (prevEnv === undefined) delete process.env.PINE_JIT;
      else process.env.PINE_JIT = prevEnv;
    }
    // Non-strict readers keep their old truthy test.
    withoutGlobal('__pineEvalCount', () => {
      g.__pineEvalCount = 1;
      expect(debugFlag('evalCount')).toBe(true);
    });
    // UDF-JIT off wins over opt-in, and both env values live on PINE_JIT_UDF.
    const prevUdf = process.env.PINE_JIT_UDF;
    try {
      delete process.env.PINE_JIT_UDF;
      expect(debugFlag('jitUdf')).toBe(false);
      expect(debugFlag('noJitUdf')).toBe(false);
      process.env.PINE_JIT_UDF = '1';
      expect(debugFlag('jitUdf')).toBe(true);
      expect(debugFlag('noJitUdf')).toBe(false);
      process.env.PINE_JIT_UDF = '0';
      expect(debugFlag('jitUdf')).toBe(false);
      expect(debugFlag('noJitUdf')).toBe(true);
    } finally {
      if (prevUdf === undefined) delete process.env.PINE_JIT_UDF;
      else process.env.PINE_JIT_UDF = prevUdf;
    }
    // The env half and the globalThis half are read separately: the hot path
    // reads globalThis per bar, process.env only once per RunState.
    const prevJitEnv = process.env.PINE_JIT_UDF;
    try {
      process.env.PINE_JIT_UDF = '1';
      withoutGlobal('__pineJitUdf', () => {
        expect(debugFlagEnv('jitUdf')).toBe(true);
        expect(debugFlagGlobal('jitUdf')).toBe(false);
      });
    } finally {
      if (prevJitEnv === undefined) delete process.env.PINE_JIT_UDF;
      else process.env.PINE_JIT_UDF = prevJitEnv;
    }
    // The PyneCore spelling is accepted as an alias.
    const prevSeq = process.env.PYNE_AST_SEQUENTIAL;
    try {
      delete process.env.PINE_AST_SEQUENTIAL;
      delete process.env.PYNE_AST_SEQUENTIAL;
      expect(debugFlag('astSequential')).toBe(false);
      process.env.PYNE_AST_SEQUENTIAL = '1';
      expect(debugFlag('astSequential')).toBe(true);
    } finally {
      if (prevSeq === undefined) delete process.env.PYNE_AST_SEQUENTIAL;
      else process.env.PYNE_AST_SEQUENTIAL = prevSeq;
    }
  });

  it('sinks write the registered handles', () => {
    withoutGlobal('__pineStage', () => {
      markStage('prefetch');
      expect(g.__pineStage).toBe('prefetch');
    });
    withoutGlobal('__pineRunLog', () => {
      recordRunTiming(3, 12);
      recordRunTiming(4, 7);
      expect(g.__pineRunLog).toEqual([{ bars: 3, ms: 12 }, { bars: 4, ms: 7 }]);
    });
  });
});
