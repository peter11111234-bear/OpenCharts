#!/usr/bin/env node
/**
 * pine-bench — stage-level perf harness for the Pine interpreter's indicator
 * load path. Instrument only; never touches `src/**`.
 *
 * Spec: docs/2026-10-14-pine-perf-align.md §「P5 REAL PLAN v1 — Pine 分階段效能基準 harness」.
 * Field/stage vocabulary is the repo's own (`parse`/`assertScript`/
 * `collectInputs`/`runScript`/`buildModel` from engine.ts, `prepared`/`execute`
 * from the Vela port, `markStage('assemble'|'prefetch'|'barloop')`,
 * `__mtfStats` / `__evalNodeCounts` / `__callHistWrites` / `__compiledKinds`).
 *
 * Run (tsx, not plain node — see scripts/perf/lib/pine.mjs):
 *   npx tsx scripts/perf/pine-bench.mjs --help
 *   npx tsx scripts/perf/pine-bench.mjs \
 *     --script "C:/Users/bear9/high452/HIGH455/high452_phase3.pine" \
 *     --bars 500 --repeat 3 --md
 *
 * Output: bench/pine/<label>.json (`--out`) + optional markdown on stdout.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, freemem, platform, arch } from 'node:os';

import { PineInterpreterEngine, checkScript, parse } from './lib/pine.mjs';
import { fetchKbars, makeSecurityGateway, normalizeBars, resampleTf, tfMs, toFetch, toOHLCV } from './lib/bars.mjs';
import { delta as counterDelta, setEvalCounting, snapshot as counterSnapshot } from './lib/counters.mjs';
import { runAppPass, runDirectPass, runIncRunPass, modelDigest, modelShape } from './lib/engines.mjs';
import { compare, fmt, growthFlags, mdCompare, mdCounters, mdRecords, mdStages, na, r2, spread, stats } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DEFAULT_FIXTURE = join(HERE, 'fixtures', 'bars-5m-mxf-500.json');

/** Stage keys of the record's `ms` object. `total` is the median of per-pass
 *  totals; every other key is the median of that phase's per-pass value. */
const MS_KEYS = ['parse', 'checks', 'collectInputs', 'compile', 'run', 'assemble', 'model', 'cacheGet', 'cachePut', 'prepare', 'execute', 'total'];

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `
pine-bench — Pine 直譯器分階段效能基準 (docs/2026-10-14-pine-perf-align.md §P5)

npx tsx scripts/perf/pine-bench.mjs [options]

  --script <path.pine>     可重複；預設 src/pine/TRIS390.pine
  --bars <n>               chart 根數（由尾端取最後 n 根），預設 500
  --bars-file <json>       自訂 bars（{t,o,h,l,c} 或 {time|openTime,open,...}）
  --fetch-bars <n>         由 http://127.0.0.1:8080 取 n 根 1m 當基底（真實資料）
  --tf <tf>                chart timeframe，預設 5
  --symbol <code>          kbars 合約代碼，預設 MXFJ6
  --repeat <n>             計時重複次數，預設 3
  --warmup <n>             每次進入計時前先跑幾次，預設 2（冷啟動第一趟可慢數倍，見 README「已知限制」）
  --scale <a,b,c>          多根數掃描（覆寫 --bars；每個 N 需 <= 可用 bars）
  --engine-path <a,b>      app,direct（預設兩條都跑）
  --out <path>             JSON 輸出，預設 bench/pine/<label>.json
  --label <name>           baseline 標籤，預設 pine-bench-<yyyyMMdd-HHmmss>
  --md                     印 markdown 表格
  --compare <baseline.json>  與既有結果逐欄 diff（>10% 標 regression/improvement）
  --diag                   額外量 incRun（診斷 app/direct 差異來源）
  --no-instrument          跳過計數器收集（__evalNodeCounts 將為 n/a）
  --quiet                  只輸出 --out 的一行摘要
  --help
`;

function parseArgs(argv) {
  const a = {
    scripts: [], bars: null, barsFile: null, fetchBars: null, tf: '5', symbol: 'MXFJ6',
    repeat: 3, warmup: 2, scale: null, enginePath: ['app', 'direct'],
    out: null, label: null, md: false, compare: null, diag: false,
    instrument: true, quiet: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} 需要一個值`);
      return x;
    };
    switch (k) {
      case '--help': case '-h': a.help = true; break;
      case '--script': a.scripts.push(v()); break;
      case '--bars': a.bars = Number(v()); break;
      case '--bars-file': a.barsFile = v(); break;
      case '--fetch-bars': a.fetchBars = Number(v()); break;
      case '--tf': a.tf = v(); break;
      case '--symbol': a.symbol = v(); break;
      case '--repeat': a.repeat = Number(v()); break;
      case '--warmup': a.warmup = Number(v()); break;
      case '--scale': a.scale = v().split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0); break;
      case '--engine-path': a.enginePath = v().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--out': a.out = v(); break;
      case '--label': a.label = v(); break;
      case '--md': a.md = true; break;
      case '--compare': a.compare = v(); break;
      case '--diag': a.diag = true; break;
      case '--no-instrument': a.instrument = false; break;
      case '--quiet': a.quiet = true; break;
      default: throw new Error(`未知選項 ${k}\n${USAGE}`);
    }
  }
  if (a.scripts.length === 0) a.scripts = [join(ROOT, 'src', 'pine', 'TRIS390.pine')];
  for (const p of a.enginePath) if (p !== 'app' && p !== 'direct') throw new Error(`--engine-path 只接受 app|direct（收到 ${p}）`);
  if (!Number.isFinite(a.repeat) || a.repeat < 1) throw new Error('--repeat 需 >= 1');
  if (!Number.isFinite(a.warmup) || a.warmup < 0) throw new Error('--warmup 需 >= 0');
  return a;
}

const stamp = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-` +
  `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

// ── record assembly ─────────────────────────────────────────────────────────

function buildRecord({ script, enginePath, bars, samples, counters, flags, cache, notSeparable, output, error, extra }) {
  const ms = {};
  for (const k of MS_KEYS) {
    const vals = samples.map((s) => s.ms?.[k]).filter((v) => typeof v === 'number');
    ms[k] = vals.length ? r2(stats(vals).median) : null;
  }
  const ts = stats(samples.map((s) => s.ms?.total ?? NaN).filter((v) => Number.isFinite(v)));
  const spreads = {};
  for (const k of MS_KEYS) {
    const vals = samples.map((s) => s.ms?.[k]).filter((v) => typeof v === 'number');
    if (vals.length > 1) spreads[k] = r2(spread(stats(vals)));
  }
  return {
    script,
    scriptName: basename(script),
    enginePath,
    bars,
    ms,
    msPerBar: ts.median === null ? null : r2(ts.median / bars),
    min: r2(ts.min),
    median: r2(ts.median),
    max: r2(ts.max),
    repeatSpread: r2(spread(ts)),
    phaseSpread: spreads,
    repeats: samples.length,
    counters,
    cache,
    notSeparable,
    flags,
    output,
    error: error ?? null,
    ...(extra ?? {}),
  };
}

/** `n/a` + reason instead of a silent zero (plan H4 / H1 field completeness). */
const mtfCounter = (mtf, { securityRequired, gateway }) => {
  if (securityRequired === false) {
    return { status: 'n/a', reason: 'script does not call request.security (assertScript requirements.security=false)', gateway };
  }
  if (mtf.evals === 0) {
    const reasons = [];
    if (gateway.calls === 0) reasons.push('no security expression was evaluated at runtime (tf-gated branch / short-circuit) — gateway received 0 requests');
    if (gateway.blocked > 0) reasons.push(`base tf ${gateway.baseTf} cannot be resampled down to requested tf(s) ${gateway.blockedTfs.join(', ')}`);
    if (gateway.calls > 0 && gateway.served === 0) reasons.push('every gateway request returned 0 bars');
    if (reasons.length === 0) reasons.push('request.security present in source but mtf never evaluated (see counters.compile / warnings)');
    return { status: 'n/a', reason: reasons.join('; '), gateway };
  }
  return { status: 'measured', ...mtf, gateway };
};

// ── sweep ───────────────────────────────────────────────────────────────────

async function bench({ args, chartAll, baseBars, baseTf, barsSource }) {
  const ns = args.scale && args.scale.length ? args.scale : [args.bars ?? 500];
  const maxN = Math.max(...ns);
  if (maxN > chartAll.length) {
    throw new Error(
      `需要 ${maxN} 根 chart bars，但 ${barsSource} 只有 ${chartAll.length} 根。\n` +
      `  用 --fetch-bars ${maxN * Math.max(1, Math.round((tfMs(args.tf) ?? 300000) / 60000)) + 500} 取真實 1m 資料，或改用 --bars-file / 較小的 --bars。`,
    );
  }

  const records = [];
  const growth = [];

  for (const script of args.scripts) {
    if (!existsSync(script)) throw new Error(`找不到 script: ${script}`);
    const src = readFileSync(script, 'utf8').replace(/^\uFEFF/, '');

    // Host-side `PreparedScript` for the direct path's `buildModel` req and for
    // `requirements.security`. Deliberately OUTSIDE every timed region: it is
    // the same object an app-path caller would already hold.
    //
    // `PineInterpreterEngine.prepare` runs `assertScript` — the repo's compile
    // gate — so a script that fails that gate cannot be prepared here either
    // (this is the same hard stop the chart hits). Records the gate's own
    // diagnostics and keeps the sweep going instead of aborting the run; the
    // gate is `src/**` and deliberately NOT bypassed by the harness.
    let prepared = null;
    let gateError = null;
    try {
      prepared = await new PineInterpreterEngine().prepare(src, 'pine-bench-meta');
    } catch (e) {
      gateError = e;
    }
    const gateDiagnostics = gateError ? diagnosticsOf(src) : [];
    const securityRequired = prepared?.token.requirements?.security ?? null;
    const modelId = prepared?.token.modelId ?? null;

    for (const N of ns) {
      const chartBars = chartAll.slice(-N);
      const ohlcv = toOHLCV(chartBars);
      // The security gateway always serves the FULL base series; `toFetch`
      // clips it to the chart span + warmup, exactly as the engine does.
      const gw = makeSecurityGateway(baseBars, baseTf);
      const velaFetch = (symbol, tf, range) => Promise.resolve(gw.fetchSeries(symbol, tf, range));
      const interpFetch = toFetch(velaFetch, chartBars);
      const market = { symbol: args.symbol, timeframe: args.tf };

      for (const enginePath of args.enginePath) {
        const diag = { securityCalls: 0, securityServed: 0, securityBlocked: null, incRunMs: null, incRunRunMs: null };
        const pass = async () => {
          if (enginePath === 'app') return runAppPass(src, { ohlcv, market, fetchSeries: velaFetch });
          return runDirectPass(src, chartBars, prepared, { ohlcv, market, interpFetch });
        };

        for (let i = 0; i < args.warmup; i++) await pass();
        const samples = [];
        let last = null;
        let failure = null;
        for (let i = 0; i < args.repeat; i++) {
          const r = await pass();
          samples.push(r);
          last = r;
          if (r.error) failure = r.error;
          if (r.timedOut) failure = new Error(`timeout after ${600_000}ms`);
        }

        // Instrumented pass: `__evalNodeCounts` costs a flag read + Map.set per
        // evaluated node, so it never shares a run with the timing samples.
        let csnap = null;
        let countersPassMs = null;
        if (args.instrument && !failure) {
          const before = counterSnapshot();
          setEvalCounting(true);
          const t = performance.now();
          switch (enginePath) {
            case 'app': await runAppPass(src, { ohlcv, market, fetchSeries: velaFetch }); break;
            default: await runDirectPass(src, chartBars, prepared, { ohlcv, market, interpFetch });
          }
          countersPassMs = r2(performance.now() - t);
          setEvalCounting(false);
          csnap = counterDelta(before, counterSnapshot(), { instrumented: true });
        } else {
          const before = counterSnapshot();
          const t = performance.now();
          await pass();
          countersPassMs = r2(performance.now() - t);
          csnap = counterDelta(before, counterSnapshot(), { instrumented: false });
        }

        if (args.diag && !failure && prepared) {
          const opts = { symbol: market.symbol, timeframe: market.timeframe, fetchSeries: interpFetch, inputValues: {} };
          try {
            const withInc = await runIncRunPass(parse(src), chartBars, opts);
            diag.incRunMs = r2(withInc.ms);
            diag.incRunBars = chartBars.length;
          } catch (e) {
            diag.incRunError = String(e?.message ?? e);
          }
        }

        diag.securityCalls = gw.diag.calls;
        diag.securityServed = gw.diag.served;
        diag.securityBlocked = gw.diag.blocked;

        const flags = [];
        const notSeparable = [];
        if (enginePath === 'app') {
          notSeparable.push('parse', 'checks', 'collectInputs', 'run', 'model', 'cacheGet', 'cachePut', 'assemble');
        } else {
          notSeparable.push('compile', 'assemble', 'cacheGet', 'cachePut');
        }
        flags.push('NOT_SEPARABLE');
        if (gateError) flags.push('GATE_REJECTED');
        else if (last?.timedOut) flags.push('TIMEOUT');
        else if (last?.error) flags.push('RUN_ERROR');

        const counters = {
          ...csnap,
          mtf: gateError
            ? {
              status: 'n/a',
              reason: 'compile gate (assertScript, checks.ts:423) rejected the script before any run — see gateDiagnostics; nothing to measure (engine.ts prepare() is the same stop the chart hits)',
              gateway: gw.diag,
            }
            : mtfCounter(csnap.mtf, { securityRequired, gateway: gw.diag }),
          countersPassMs,
        };
        const cache = {
          get: na(idbReason(enginePath, 'get')),
          put: na(idbReason(enginePath, 'put')),
        };
        flags.push('CACHE_N_A');

        const output = last?.model
          ? {
            digest: modelDigest(last.model),
            shape: modelShape(last.model),
            identityMatch: null, // filled by the app/direct post-pass
            warnings: last.warnings?.length ?? null,
          }
          : null;

        const rec = buildRecord({
          script, enginePath, bars: N, samples, counters, flags, cache, notSeparable, output,
          error: last?.error ? String(last.error?.message ?? last.error) : null,
          extra: {
            modelId,
            securityRequired,
            diagnostics: diag,
            requirements: prepared?.token.requirements ?? null,
            gateError: gateError ? String(gateError?.message ?? gateError) : null,
            gateDiagnostics,
            timedOut: last?.timedOut ?? false,
          },
        });
        records.push(rec);
      }
    }
  }

  // ── post-passes ───────────────────────────────────────────────────────────
  // 1. app/direct model identity (the two paths must emit the same model).
  const byScriptBars = new Map();
  for (const r of records) {
    const k = `${r.scriptName}|${r.bars}`;
    if (!byScriptBars.has(k)) byScriptBars.set(k, {});
    byScriptBars.get(k)[r.enginePath] = r;
  }
  const identity = [];
  for (const [k, m] of byScriptBars) {
    const a = m.app?.output?.digest?.hash ?? null;
    const d = m.direct?.output?.digest?.hash ?? null;
    const match = a !== null && d !== null && a === d;
    if (m.app?.output) m.app.output.identityMatch = match;
    if (m.direct?.output) m.direct.output.identityMatch = match;
    if (a !== null && d !== null) identity.push({ key: k, app: a, direct: d, match });
  }

  // 2. H3: app vs direct `total` on the same (script, bars).
  const pathDeltas = [];
  for (const [k, m] of byScriptBars) {
    if (!m.app || !m.direct || m.app.median === null || m.direct.median === null) continue;
    const diff = m.app.median - m.direct.median;
    const pct = m.direct.median === 0 ? null : (diff / m.direct.median) * 100;
    pathDeltas.push({
      key: k, bars: m.app.bars, script: m.app.scriptName,
      appMedian: m.app.median, directMedian: m.direct.median,
      delta: r2(diff), pct: pct === null ? null : r2(pct),
      within20pct: pct !== null && Math.abs(pct) < 20,
      incRunMs: m.direct.diagnostics?.incRunMs ?? null,
    });
  }

  // 3. growth / SUPERLINEAR
  growth.push(...growthFlags(records));

  // 4. repeat noise → NOISY
  for (const r of records) {
    if (r.repeatSpread !== null && r.repeatSpread > 0.15) r.flags.push('NOISY');
  }

  return { records, growth, identity, pathDeltas };
}

/**
 * When the compile gate rejects a script, `checkScript` (checks.ts:392) returns
 * the same diagnostics `assertScript` throws on — captured here so a failed
 * record stays source-located and actionable.
 */
function diagnosticsOf(src) {
  try {
    const parsed = parse(src);
    const { diagnostics } = checkScript(parsed);
    return diagnostics.map((d) => ({ rule: d.rule, line: d.line, col: d.col, message: d.message }));
  } catch (e) {
    return [{ rule: 'parse', line: null, col: null, message: String(e?.message ?? e) }];
  }
}

const idbReason = (enginePath, op) =>
  enginePath === 'direct'
    ? 'direct path bypasses modelCache — engine.ts only calls modelCacheGet/Put inside execute()'
    : `modelCache${op === 'get' ? 'Get' : 'Put'} is a no-op in Node: modelCache.ts db() resolves null when indexedDB is undefined (probeMs in cache block)`;

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE); return; }

  const started = performance.now();
  const label = args.label ?? `pine-bench-${stamp()}`;

  // ── bars ──────────────────────────────────────────────────────────────────
  let chartAll;
  let baseBars;
  let baseTf;
  let barsSource;
  if (args.fetchBars) {
    const n = args.fetchBars;
    const { bars, source } = await fetchKbars({ code: args.symbol, n });
    baseBars = bars;
    baseTf = '1';
    chartAll = resampleTf(baseBars, args.tf);
    barsSource = `kbars ${source.code} ${source.start}..${source.end} (${source.returned} x 1m → ${args.tf}m)`;
  } else if (args.barsFile) {
    baseBars = normalizeBars(JSON.parse(readFileSync(args.barsFile, 'utf8')));
    baseTf = args.tf;
    chartAll = baseBars;
    barsSource = args.barsFile;
  } else {
    baseBars = normalizeBars(JSON.parse(readFileSync(DEFAULT_FIXTURE, 'utf8')));
    baseTf = args.tf;
    chartAll = baseBars;
    barsSource = `fixture ${DEFAULT_FIXTURE}`;
  }
  if (chartAll.length === 0) throw new Error(`bars 為空（來源 ${barsSource}）`);

  // Cache-stage probe: prove the `n/a` instead of assuming it.
  let cacheProbeMs = null;
  {
    const { modelCacheGet, modelCachePut } = await import('./lib/pine.mjs');
    const t = performance.now();
    await modelCacheGet(`${label}|probe`);
    await modelCachePut(`${label}|probe`, { probe: true });
    cacheProbeMs = r2(performance.now() - t);
  }

  const { records, growth, identity, pathDeltas } = await bench({ args, chartAll, baseBars, baseTf, barsSource });

  const doc = {
    tool: 'scripts/perf/pine-bench.mjs',
    version: 1,
    label,
    createdAt: new Date().toISOString(),
    env: {
      node: process.version,
      platform: `${platform()}-${arch()}`,
      cpus: cpus().length,
      totalMemMB: Math.round(totalmem() / 1048576),
      freeMemMB: Math.round(freemem() / 1048576),
      pineJit: globalThis.__pineJit === true || process.env.PINE_JIT === '1',
      evalCountingDuringTimedPasses: false,
      note: '默認抽樣期間未開啟 __pineEvalCount；計數器來自另一次 instrumented pass。環境若有其他重型工作同時執行，請看 repeatSpread / NOISY。',
    },
    config: {
      scripts: args.scripts,
      tf: args.tf,
      symbol: args.symbol,
      barsSource,
      barsAvailable: chartAll.length,
      baseTf,
      baseBars: baseBars.length,
      bars: args.bars ?? 500,
      scale: args.scale,
      repeat: args.repeat,
      warmup: args.warmup,
      enginePath: args.enginePath,
      diag: args.diag,
      instrument: args.instrument,
      out: args.out ?? `bench/pine/${label}.json`,
    },
    cache: {
      get: na(idbReason('app', 'get')),
      put: na(idbReason('app', 'put')),
      probeMs: cacheProbeMs,
      indexedDB: typeof indexedDB !== 'undefined',
    },
    results: records,
    groups: {
      app: records.map((r, i) => (r.enginePath === 'app' ? i : -1)).filter((i) => i >= 0),
      direct: records.map((r, i) => (r.enginePath === 'direct' ? i : -1)).filter((i) => i >= 0),
    },
    growth,
    checks: {
      modelsMatchAcrossPaths: identity,
      appVsDirectTotal: pathDeltas,
      repeatsNoisy: records.filter((r) => r.flags.includes('NOISY')).map((r) => `${r.scriptName}|${r.enginePath}|${r.bars}`),
    },
    wallMs: null,
  };

  if (args.compare) {
    if (!existsSync(args.compare)) throw new Error(`--compare 找不到 ${args.compare}`);
    doc.compare = compare(JSON.parse(readFileSync(args.compare, 'utf8')), doc);
  }
  doc.wallMs = r2(performance.now() - started);

  const outPath = args.out ?? join(ROOT, 'bench', 'pine', `${label}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);

  if (!args.quiet) {
    const out = [];
    const head = [
      `# pine-bench ${label}`, '',
      `bars 來源: ${barsSource}  |  chart tf: ${args.tf}  |  repeat: ${args.repeat} (warmup ${args.warmup})  |  engine-path ${args.enginePath.join('+')}  |  總耗時 ${fmt(doc.wallMs / 1000, 1)}s`,
      `JSON: ${outPath}`, '',
    ];
    const compact = [
      '| script | engine | bars | parse | run | model | total | ms/bar | median | flags |',
      '|---|---|---|---|---|---|---|---|---|---|',
      ...records.map((r) => `| ${r.scriptName} | ${r.enginePath} | ${r.bars} | ${fmt(r.ms.parse)} | ${fmt(r.ms.run)} | ${fmt(r.ms.model)} | ${fmt(r.ms.total)} | ${fmt(r.msPerBar, 3)} | ${fmt(r.median)} | ${r.flags.join(',') || '—'} |`),
      '',
    ];
    out.push(...head, ...(args.md ? [] : compact));

    if (args.md) {
      out.push('## 分階段（median, ms）', '', mdRecords(records), '');
      out.push('## app-only 階段 / cache', '', mdStages(records), '');
      out.push('## counters', '', mdCounters(records), '');
    }

    out.push('## app vs direct (H3)', '', '| script | bars | app median | direct median | Δ | Δ% | <20% | diag.incRun ms |', '|---|---|---|---|---|---|---|---|');
    for (const p of pathDeltas) out.push(`| ${p.key} | ${p.bars} | ${fmt(p.appMedian)} | ${fmt(p.directMedian)} | ${fmt(p.delta)} | ${fmt(p.pct, 1)} | ${p.within20pct ? 'PASS' : 'FAIL'} | ${p.incRunMs === null ? '—' : fmt(p.incRunMs)} |`);
    out.push('');
    if (growth.length) {
      out.push('## growth (--scale)', '', '| key | N0 | N | median(N0) | median(N) | 線性期望 | 實際/期望 | SUPERLINEAR |', '|---|---|---|---|---|---|---|---|');
      for (const g of growth) out.push(`| ${g.key} | ${g.bars} | ${g.barsCurrent} | ${fmt(g.baseMedian)} | ${fmt(g.median)} | ${fmt(g.expectedLinear)} | ${fmt(g.ratio, 3)} | ${g.superlinear ? 'YES' : 'no'} |`);
      out.push('');
    }
    if (identity.length) {
      out.push('## model identity (app vs direct digest)', '', '| key | app | direct | match |', '|---|---|---|---|');
      for (const i of identity) out.push(`| ${i.key} | ${i.app} | ${i.direct} | ${i.match ? 'PASS' : 'FAIL'} |`);
      out.push('');
    }
    if (records.some((r) => r.error)) {
      out.push('## errors', '');
      for (const r of records.filter((x) => x.error)) out.push(`- ${r.scriptName} ${r.enginePath} ${r.bars}: ${r.error}`);
      out.push('');
    }
    if (records.some((r) => r.counters.mtf.status === 'n/a')) {
      out.push('## mtf n/a', '');
      for (const r of records.filter((x) => x.counters.mtf.status === 'n/a')) out.push(`- ${r.scriptName} ${r.enginePath} ${r.bars}: ${r.counters.mtf.reason}`);
      out.push('');
    }
    if (doc.compare) out.push(mdCompare(doc.compare), '');
    process.stdout.write(`${out.join('\n')}\n`);
  } else {
    process.stdout.write(`${outPath}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`pine-bench failed: ${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
