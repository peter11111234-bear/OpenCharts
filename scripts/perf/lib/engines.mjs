/**
 * The two measured engine paths (plan §P5 CLI: `--engine-path app,direct`).
 *
 *   app    — `new PineInterpreterEngine()` → `prepare(src, id)` → `execute(req,
 *            handlers)` awaited to `onDone`. This is the path the chart runs
 *            (engine.ts:258/290/322): parse + checks + collectInputs inside
 *            `prepare`, then `runProgram` (= incRun) + `buildModel` +
 *            `modelCacheGet/Put` inside `execute`. Only `prepare` / `execute` /
 *            `total` are observable from outside, hence `NOT_SEPARABLE`.
 *   direct — `parse` → `assertScript` → `collectInputs` → `runScript` →
 *            `buildModel`, each timed on its own (plan's 「逐段外部計時」).
 *
 * Fairness rules the H3 comparison depends on:
 *   - both paths are handed the SAME chart series (same `BarData`/`OHLCV` pair)
 *   - both get the SAME `fetchSeries` gateway (the `direct` path wraps it with
 *     the `toFetch` mirror, because `app` gets that wrapper for free inside
 *     `execute`)
 *   - `buildModel` gets a `req` built from the SAME `PreparedScript` in both
 *     paths — `direct` obtains it from one *untimed* `engine.prepare()` call,
 *     so `modelId` / `inputValues` / `meta` are byte-identical and the two
 *     emitted models can be digested and compared.
 *
 * `parseDeclArgs` / `litOf` below mirror engine.ts:504/519 (module-private
 * there); they are the only duplicated engine logic, and only to time the
 * `collectInputs` stage the plan defines as `collectInputs(body)` +
 * `parseDeclArgs(parsed.decl)`.
 */

import {
  PineInterpreterEngine, assertScript, buildModel, collectInputs, incRun, parse, runScript,
} from './pine.mjs';
import { toBarData } from './bars.mjs';

/** FNV-1a over the model JSON — cheap identity check for the two paths. */
export function modelDigest(model) {
  const s = JSON.stringify(model);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return { hash: (h >>> 0).toString(36), bytes: s.length };
}

/** Shape summary so a reader can see the model was really assembled. */
export function modelShape(model) {
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  return {
    series: n(model.series),
    priceLines: n(model.priceLines),
    fills: n(model.fills),
    backgrounds: n(model.backgrounds),
    barColors: n(model.barColors),
    lines: n(model.lines),
    labels: n(model.labels),
    boxes: n(model.boxes),
    polylines: n(model.polylines),
    linefills: n(model.linefills),
    tables: n(model.tables),
  };
}

const litOf = (n) => (n && typeof n === 'object' && 'v' in n ? n.v : undefined);

/** Mirror of engine.ts:504. */
const parseDeclArgs = (decl) => {
  const out = {};
  let i = 0;
  for (const a of decl.args) {
    if (a.name) out[a.name] = litOf(a.value);
    else if (i === 0) out.title = litOf(a.value);
    i++;
  }
  return out;
};

const mkReq = (prepared, ohlcv, market, fetchSeries) => ({
  prepared,
  market,
  bars: ohlcv,
  fetchSeries,
  inputs: {},
  mode: 'static',
});

// ── app path ────────────────────────────────────────────────────────────────

/**
 * One `app` pass. Resolves on `onDone` / `onError`; the watchdog stops the
 * session and reports `timedOut` rather than hanging the sweep.
 */
export async function runAppPass(src, { ohlcv, market, fetchSeries, timeoutMs = 600_000, instanceId = 'pine-bench' }) {
  let model = null;
  let error = null;
  let timedOut = false;
  const done = Promise.withResolvers();
  let session = null;

  const t0 = performance.now();
  const engine = new PineInterpreterEngine();
  let prepared;
  try {
    prepared = await engine.prepare(src, instanceId);
  } catch (e) {
    // `assertScript` (checks.ts:423) is the repo's compile gate — the chart
    // stops here too. Report the gate's own timing, not a fabricated run.
    return {
      ms: { prepare: performance.now() - t0, execute: null, total: performance.now() - t0 },
      model: null, error: e instanceof Error ? e : new Error(String(e)), timedOut: false, prepared: null,
    };
  }
  const t1 = performance.now();
  try {
    session = engine.execute(mkReq(prepared, ohlcv, market, fetchSeries), {
      onModel: (m) => { model = m; },
      onError: (e) => { error = e; done.resolve(); },
      onDone: () => done.resolve(),
    });
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    done.resolve();
  }
  const timer = setTimeout(() => { timedOut = true; done.resolve(); }, timeoutMs);
  await done.promise;
  clearTimeout(timer);
  const t2 = performance.now();
  if (timedOut) try { session?.stop(); } catch { /* already dead */ }

  return {
    ms: { prepare: t1 - t0, execute: t2 - t1, total: t2 - t0 },
    model, error, timedOut, prepared,
  };
}

// ── direct path ─────────────────────────────────────────────────────────────

/**
 * One `direct` pass. `prepared` may come from `runAppPass` (reused, untimed) or
 * from a throwaway `engine.prepare()` — either way it is NOT part of the timed
 * region; it only supplies `buildModel`'s host-side `req`.
 */
export async function runDirectPass(src, chartBars, prepared, { ohlcv, market, interpFetch, timeoutMs = 600_000 }) {
  let error = null;
  let result = null;
  const phases = {};
  const sum = () => Object.values(phases).reduce((a, b) => a + b, 0);

  let t = performance.now();
  let parsed;
  try {
    parsed = parse(src);
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    return { ms: { ...phases, total: sum() }, model: null, error, timedOut: false };
  }
  phases.parse = performance.now() - t;

  t = performance.now();
  let requirements = null;
  try {
    requirements = assertScript(parsed);
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    // The gate throws on the FIRST diagnostic but `checkScript` runs every rule
    // before returning, so the elapsed time is the real, complete checks cost —
    // kept so a rejected direct record is still comparable to app's `prepare`.
    phases.checks = performance.now() - t;
    return { ms: { ...phases, total: sum() }, model: null, error, timedOut: false };
  }
  phases.checks = performance.now() - t;

  t = performance.now();
  const body = Array.isArray(parsed) ? parsed : parsed.body;
  const inputs = collectInputs(body);
  const declArgs = !Array.isArray(parsed) && parsed.decl ? parseDeclArgs(parsed.decl) : {};
  phases.collectInputs = performance.now() - t;

  t = performance.now();
  let timedOut = false;
  let timer = null;
  try {
    const watchdog = new Promise((r) => { timer = setTimeout(() => { timedOut = true; r(null); }, timeoutMs); });
    const raced = await Promise.race([
      runScript(parsed, chartBars, {
        symbol: market.symbol,
        timeframe: market.timeframe,
        fetchSeries: interpFetch,
        inputValues: {},
      }),
      watchdog,
    ]);
    result = raced;
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
  phases.run = performance.now() - t;

  t = performance.now();
  let model = null;
  if (result) {
    if (!prepared) {
      error = error ?? new Error('no PreparedScript available — compile gate rejected the source, so buildModel cannot be driven');
    } else {
      try {
        model = buildModel(prepared.token.modelId, mkReq(prepared, ohlcv, market, undefined), result, chartBars.map((b) => b.openTime));
      } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
      }
    }
  }
  phases.model = performance.now() - t;

  phases.total = sum();
  return {
    ms: phases,
    model,
    error,
    timedOut,
    requirements,
    meta: { inputs: inputs.length, declArgs },
    warnings: result?.warnings ?? null,
  };
}

/**
 * Diagnostic pass for H3: the `app` path runs the interpreter through
 * `incRun` (engine.ts `runProgram` → interpreter.ts:3592), which for an
 * indicator script takes the incremental `incRunStart` branch (session build +
 * per-closed-bar checkpoint), NOT `runScriptInner` the `direct` path uses.
 * Timing `incRun` from the harness pins any `app` vs `direct` gap to that
 * branch difference instead of guesswork. Only run under `--diag`: it is a
 * whole extra pass per record.
 */
export async function runIncRunPass(parsed, chartBars, opts) {
  const t = performance.now();
  const out = await incRun(parsed, chartBars, { ...opts, incHolder: { live: null } });
  return { ms: performance.now() - t, result: out.result };
}

export { collectInputs, parseDeclArgs, toBarData };
