// ── Engine-internal identifier namespace ────────────────────────────────────
// Single registry for every `__`-prefixed name the engine injects into, or
// reads back from, a scope a user script can also see: JS locals in generated
// code, globalThis debug switches, and the module-level instrumentation
// counters/re-exports.
//
// internal_names.test.ts fails when a source file grows a `__`-prefixed name
// that is not in this table (PyneCore guards its `__pyne_*__` namespace the same
// way, test_129_pipeline_names.py). That is the guard: a new injection must be
// registered with a reason, so nobody silently adds a name that a user script
// could collide with.
//
// User scripts cannot collide today, by construction: every Pine identifier is
// resolved through the interpreter Scope by NAME STRING — jit.ts emits
// `R.decl(node, "x")` / `R.ident("x")`, never a bare JS identifier. A Pine
// variable called `__ret` therefore lives in the Pine scope while the compiled
// closure's own `__ret` stays private. internal_names.test.ts pins that
// behaviour with the UDF JIT enabled (the exact scenario from the handoff:
// `f() => __ret = 5` must NOT overwrite the UDF return value).

/** Prefix reserved for engine-owned globals and debug switches. New globalThis
 *  flags MUST use it — nothing else in the engine may define a bare `__x`. */
export const INTERNAL_PREFIX = '__pine';

/** name → why the engine owns the name. */
export const INTERNAL_NAMES: Record<string, string> = {
  // generated code (jit.ts)
  '__ret': 'JIT: the return slot of a compiled UDF body (a JS local in the generated closure)',
  '__ds': 'JIT: the hoisted arg-descriptor array, one per compile',

  // globalThis debug switches
  '__pineStage': 'globalThis: the run phase currently executing (hang triage)',
  '__pineRunLog': 'globalThis: dev-only {bars, ms} log of completed engine runs',
  '__pineInterp': 'globalThis: force the fully-interpreted path, bypassing the JIT',
  '__pineJit': 'globalThis: opt-IN the expression JIT (default OFF)',
  '__pineJitUdf': 'globalThis: opt-IN the UDF-body JIT (default OFF)',
  '__pineNoJitUdf': 'globalThis: force the UDF-body JIT off',
  '__pineJitQuiet': 'globalThis: silence the JIT banner and compile-failure log',
  '__pineEvalCount': 'globalThis: enable the per-node-type evaluation counters',
  '__mtfStats': 'globalThis: MTF prefetch/eval counters',

  // module-level instrumentation (test seams, re-exported by name)
  '__pineJitStats': 'module export: JIT run/compile/gate counters',
  '__evalNodeCounts': 'module export: per-node-type evaluation counters',
  '__callHistWrites': 'module export: callHist write counter (test instrumentation)',
  '__compileCalls': 'module export: body-compile counter (test instrumentation)',
  '__compiledKinds': 'module export: per-body compile kind (test instrumentation)',
  '__inputSchemaBuilds': 'module export: input-schema build counter (test instrumentation)',
  '__partsOfCalls': 'module export: tz part-memo counter (test instrumentation)',
  '__resetModelCache': 'module export: test seam that drops the derived-model cache',

  // sentinels
  '__dynamic__': 'mtf sentinel: sym/tf spec that must be resolved at run time',
  '__deleted': 'draw.ts props flag: the drawing was deleted or evicted; handles to it read na',
};
