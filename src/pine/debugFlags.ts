// ── Diagnostic switches ─────────────────────────────────────────────────────
// One door for every diagnostic switch the engine reads. PyneCore exposes its
// pipeline switches as env vars (PYNE_AST_TIMING / PYNE_AST_SEQUENTIAL); this
// engine had them scattered — `globalThis.__pineJit`, `process.env.PINE_JIT`,
// `globalThis.__pineEvalCount`, inline `__pineStage` writes — across
// interpreter.ts / engine.ts / checks.ts, so the same switch could be read two
// different ways. debug_flags.test.ts greps the sources and fails when a switch
// is read anywhere else.
//
// The handles themselves (`__pine*`) are registered with their reasons in
// internalNames.ts; its guard fails when a `__`-prefixed name appears in the
// engine without a registration. Adding a switch therefore means: add it here
// AND to internalNames.ts — two edits that the two guards cross-check.

interface SwitchDef {
  /** globalThis handle that turns the switch on (absent for env-only switches).
   *  Also the handle `markStage` / `recordRunTiming` write for the sinks. */
  global?: string;
  /** (env var, the value that turns it on) — the pairs are OR-ed. */
  env?: readonly (readonly [string, string])[];
  /** true = only a strict boolean `true` counts (default: whatever value is
   *  truthy), matching what each reader did before this module existed. */
  strict?: boolean;
  why: string;
}

export type DebugFlagId =
  | 'interp' | 'jit' | 'jitUdf' | 'noJitUdf' | 'jitQuiet' | 'evalCount'
  | 'astSequential' | 'stage' | 'runLog';

export const DEBUG_FLAGS: Record<DebugFlagId, SwitchDef> = {
  interp: {
    global: '__pineInterp', env: [['PINE_INTERP', '1']], strict: true,
    why: 'force the fully-interpreted path, bypassing the compiled/JIT path',
  },
  jit: {
    global: '__pineJit', env: [['PINE_JIT', '1']], strict: true,
    why: 'opt-IN the expression JIT (default OFF)',
  },
  jitUdf: {
    global: '__pineJitUdf', env: [['PINE_JIT_UDF', '1']], strict: true,
    why: 'opt-IN the UDF-body JIT (default OFF)',
  },
  noJitUdf: {
    global: '__pineNoJitUdf', env: [['PINE_JIT_UDF', '0']], strict: true,
    why: 'force the UDF-body JIT off — wins over jitUdf so a stale global cannot re-enable it',
  },
  jitQuiet: {
    global: '__pineJitQuiet',
    why: 'silence the JIT banner and the JIT compile-failure log',
  },
  evalCount: {
    global: '__pineEvalCount',
    why: 'collect per-node-type evaluation counters (`__evalNodeCounts`)',
  },
  astSequential: {
    env: [['PINE_AST_SEQUENTIAL', '1'], ['PYNE_AST_SEQUENTIAL', '1']],
    why: 'run each compile-check rule as its own AST pass (PyneCore equivalence proof); the PyneCore spelling is accepted as an alias',
  },
  stage: {
    global: '__pineStage',
    why: 'run-phase breadcrumb for hang triage — write-only, read by qa_yield',
  },
  runLog: {
    global: '__pineRunLog',
    why: 'dev-only {bars, ms} run-timing log, read by browser QA',
  },
};

type GlobalSlot = Record<string, unknown>;

/** The globalThis half of a switch. Per-bar hot paths read this one: a handle
 *  write takes effect on the next bar and costs about 0.03 µs. */
export function debugFlagGlobal(id: DebugFlagId): boolean {
  const def = DEBUG_FLAGS[id];
  if (def.global === undefined) return false;
  const g = (globalThis as GlobalSlot)[def.global];
  return def.strict === true ? g === true : Boolean(g);
}

/** The environment half of a switch. Read once per RunState (session start):
 *  process.env costs roughly 20–30 µs per read, too much for every bar. */
export function debugFlagEnv(id: DebugFlagId): boolean {
  const def = DEBUG_FLAGS[id];
  if (def.env === undefined || typeof process === 'undefined') return false;
  for (const [key, on] of def.env) if (process.env?.[key] === on) return true;
  return false;
}

/** Is the switch on? globalThis beats the environment, as it did before. */
export function debugFlag(id: DebugFlagId): boolean {
  return debugFlagGlobal(id) || debugFlagEnv(id);
}

/** Set the run-phase breadcrumb (no-op cost is one property write). */
export function markStage(stage: string): void {
  const handle = DEBUG_FLAGS.stage.global;
  if (handle === undefined) return;                 // unreachable: registered above
  (globalThis as GlobalSlot)[handle] = stage;
}

/** Append one completed run's cost to the dev-only run log, creating the sink
 *  on first use. Unconditional by design: browser QA reads it after the fact. */
export function recordRunTiming(bars: number, ms: number): void {
  const handle = DEBUG_FLAGS.runLog.global;
  if (handle === undefined) return;                 // unreachable: registered above
  const g = globalThis as GlobalSlot;
  const log = g[handle] as Array<{ bars: number; ms: number }> | undefined;
  if (log === undefined) g[handle] = [{ bars, ms }];
  else log.push({ bars, ms });
}
