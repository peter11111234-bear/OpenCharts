/**
 * Single import door for the Pine perf harness — `scripts/perf/pine-bench.mjs`.
 *
 * ORDER IS LOAD-BEARING. `src/pine/builtins/index.ts` MUST be evaluated before
 * any other `src/pine` module: it registers the builtin table and the mtf hooks
 * (`registerMtf`) that parser/interpreter resolve at module load. This mirrors
 * the iron rule documented at the head of `scratch/perf-probe.mjs`, the probe
 * this harness replaces. Same reason the CLI is `npx tsx`: the engine uses
 * extensionless relative imports and TS parameter properties, so plain
 * `node --experimental-strip-types` cannot load it.
 *
 * Observe-only: nothing here writes to `src/**` (plan §P5 「不改 src/**」).
 * Everything re-exported below is a pre-existing export — no new engine API.
 */

import '../../../src/pine/builtins/index.ts';

// ── pipeline ────────────────────────────────────────────────────────────────
export { parse } from '../../../src/pine/parser.ts';
export { assertScript, checkScript } from '../../../src/pine/checks.ts';
export { collectInputs, runScript, incRun } from '../../../src/pine/interpreter.ts';
export { PineInterpreterEngine, buildModel } from '../../../src/pine/engine.ts';
export { BarSeries } from '../../../src/pine/series.ts';

// ── timeframe helpers (reused so the harness resamples like the engine) ─────
export { tfFloor, tfNext, tfToMs } from '../../../src/pine/mtf.ts';

// ── cache stage (no-op outside a browser: `db()` resolves null without IDB) ──
export { modelCacheGet, modelCachePut, __resetModelCache } from '../../../src/pine/modelCache.ts';

// ── counters ────────────────────────────────────────────────────────────────
// `__mtfStats` and the two kind-maps are module objects; `__callHistWrites` /
// `__compileCalls` are `export let`, so an importer always reads the live value
// (never a stale snapshot). `__evalNodeCounts` is populated only while
// `globalThis.__pineEvalCount` is truthy → the harness runs those collection
// passes separately so the timing passes stay uninstrumented.
export { __mtfStats, resetMtf } from '../../../src/pine/mtf.ts';
export { __evalNodeCounts, __callHistWrites, __compileCalls, __compiledKinds } from '../../../src/pine/interpreter.ts';
