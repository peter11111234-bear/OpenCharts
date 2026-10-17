/**
 * Counter capture for the Pine perf harness.
 *
 * All counters are pre-existing engine instrumentation (no new engine API):
 *   - `__mtfStats`        mtf.ts:1315 — request.security eval/cache totals
 *   - `__evalNodeCounts`  interpreter.ts:678 — per-node-type eval hits, only
 *                         populated while `globalThis.__pineEvalCount` is on
 *   - `__callHistWrites`  interpreter.ts:1409 — history-buffer writes
 *   - `__compileCalls` / `__compiledKinds`  interpreter.ts:1896-1898
 *   - `BarSeries.setAt` / `ensureBar` — call counts by prototype patch, the
 *                         same technique as `scratch/perf-probe.mjs`
 *
 * Every read is a DELTA (`after - before`) so successive runs in one process
 * stay independent, exactly like `perf_bench.test.ts` does with `__mtfStats`.
 */

import {
  BarSeries, __callHistWrites, __compileCalls, __compiledKinds, __evalNodeCounts, __mtfStats,
} from './pine.mjs';

/** Set by the harness around the instrumented pass only. */
export const EVAL_COUNT_HANDLE = '__pineEvalCount';

// ── prototype patch (installed once, at module load) ────────────────────────
const seriesWrites = { setAt: 0, ensureBar: 0 };
const rawSetAt = BarSeries.prototype.setAt;
BarSeries.prototype.setAt = function (...args) { seriesWrites.setAt++; return rawSetAt.apply(this, args); };
const rawEnsureBar = BarSeries.prototype.ensureBar;
BarSeries.prototype.ensureBar = function (...args) { seriesWrites.ensureBar++; return rawEnsureBar.apply(this, args); };

/** Toggle the eval-node counter switch (globalThis beats env, debugFlags.ts:58). */
export function setEvalCounting(on) {
  globalThis[EVAL_COUNT_HANDLE] = on === true;
}

const mapSnapshot = (m) => new Map(m);
const mapDelta = (before, after) => {
  const out = {};
  for (const [k, v] of after) {
    const d = v - (before.get(k) ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
};

/**
 * `__compiledKinds` is `Map<stmtType, 'direct'|'twoPhase'|'fallback'>` — the
 * LAST compilation disposition per statement type, not a counter. A numeric
 * subtraction would be meaningless, so the per-pass view is "entries that
 * changed during this pass" (new key or flipped disposition).
 */
const kindChanges = (before, after) => {
  const out = {};
  for (const [k, v] of after) if (before.get(k) !== v) out[k] = v;
  return out;
};
const kindsAll = (after) => Object.fromEntries(after);

/** Everything the engine exposes, as an absolute snapshot. */
export function snapshot() {
  return {
    mtf: { ...__mtfStats },
    evalNodeCounts: mapSnapshot(__evalNodeCounts),
    callHistWrites: __callHistWrites,
    compileCalls: __compileCalls,
    compiledKinds: mapSnapshot(__compiledKinds),
    seriesWrites: { ...seriesWrites },
    stage: globalThis.__pineStage,
  };
}

/** Top-N node-type entries of an `evalNodeCounts` delta, descending. */
const topNodes = (counts, n) =>
  Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

/**
 * Per-run counter record. `instrumented` marks the pass where
 * `__evalNodeCounts` was switched on (that pass is not used for timing — the
 * flag costs a `debugFlag()` read plus a Map.set per evaluated node).
 */
export function delta(before, after, { instrumented = false } = {}) {
  const mtf = {};
  for (const k of Object.keys(after.mtf)) mtf[k] = after.mtf[k] - (before.mtf[k] ?? 0);
  const evalDelta = mapDelta(before.evalNodeCounts, after.evalNodeCounts);
  const evalTotal = Object.values(evalDelta).reduce((a, b) => a + b, 0);
  return {
    mtf,
    evalNodeCounts: {
      total: evalTotal,
      top20: instrumented ? topNodes(evalDelta, 20).map(([type, count]) => ({ type, count })) : null,
      unavailableReason: instrumented
        ? null
        : `__evalNodeCounts is only written while globalThis.${EVAL_COUNT_HANDLE} is truthy (debugFlags.ts 'evalCount')`,
    },
    callHistWrites: after.callHistWrites - before.callHistWrites,
    compile: {
      calls: after.compileCalls - before.compileCalls,
      // per-pass: statement types (re)compiled in THIS pass
      kinds: kindChanges(before.compiledKinds, after.compiledKinds),
      // absolute: last disposition per statement type over the whole process
      kindsAll: kindsAll(after.compiledKinds),
    },
    seriesWrites: {
      setAt: after.seriesWrites.setAt - before.seriesWrites.setAt,
      ensureBar: after.seriesWrites.ensureBar - before.seriesWrites.ensureBar,
    },
    // `markStage` (debugFlags.ts:86) writes globalThis.__pineStage; the last
    // value after a run proves the run reached the interpreter's 'assemble'
    // phase (interpreter.ts:3065/3514) — the stage the plan calls
    // `not_separable` in v1.
    stageLast: typeof after.stage === 'string' ? after.stage : null,
  };
}
