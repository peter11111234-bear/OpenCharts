/**
 * Reporting for the Pine perf harness: statistics, markdown tables, and the
 * `--compare` per-field diff (plan §P5 判定規則: 僅 >10% 才標
 * `regression` ／ `improvement`).
 */

/** `min` / `median` / `max` / `mean` over the repeat samples, in ms. */
export function stats(samples) {
  if (samples.length === 0) return { min: null, median: null, max: null, mean: null };
  const s = [...samples].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return {
    min: s[0],
    median,
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

/** Relative spread of the repeat samples — the environment-noise signal. */
export const spread = (s) => (s.median && s.median > 0 ? (s.max - s.min) / s.median : null);

export const r2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
export const fmt = (n, d = 2) => (n === null || n === undefined ? 'n/a' : Number(n).toFixed(d));

/** `n/a` + reason, never a silent 0 (plan H4). */
export const na = (reason) => ({ status: 'n/a', reason });

// ── markdown ────────────────────────────────────────────────────────────────

const MS_COLS = ['parse', 'checks', 'collectInputs', 'run', 'model', 'total'];

export function mdRecords(records) {
  const head = ['script', 'engine', 'bars', ...MS_COLS, 'ms/bar', 'median', 'min', 'max', 'flags'];
  const lines = [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
  ];
  for (const r of records) {
    const cells = [
      r.scriptName, r.enginePath, String(r.bars),
      ...MS_COLS.map((k) => fmt(r.ms[k])),
      fmt(r.msPerBar, 3), fmt(r.median), fmt(r.min), fmt(r.max),
      r.flags.length ? r.flags.join(',') : '—',
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

export function mdStages(records) {
  const head = ['script', 'engine', 'bars', 'prepare', 'execute', 'cacheGet', 'cachePut', 'assemble'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of records) {
    lines.push(`| ${[
      r.scriptName, r.enginePath, String(r.bars),
      fmt(r.ms.prepare), fmt(r.ms.execute), fmt(r.ms.cacheGet), fmt(r.ms.cachePut), fmt(r.ms.assemble),
    ].join(' | ')} |`);
  }
  return lines.join('\n');
}

export function mdCounters(records) {
  const head = ['script', 'engine', 'bars', 'mtf.evals', 'mtf.hits', 'evalNodes', 'callHistWrites', 'compile.calls', 'setAt', 'ensureBar'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of records) {
    const c = r.counters;
    const mtf = c.mtf?.evals === undefined ? 'n/a' : `${c.mtf.evals}/${c.mtf.hits}`;
    const evalNodes = c.evalNodeCounts?.top20 ? String(c.evalNodeCounts.total) : 'n/a';
    lines.push(`| ${[
      r.scriptName, r.enginePath, String(r.bars),
      c.mtf?.evals === undefined ? 'n/a' : String(c.mtf.evals),
      c.mtf?.hits === undefined ? 'n/a' : String(c.mtf.hits),
      evalNodes,
      String(c.callHistWrites),
      String(c.compile?.calls ?? 'n/a'),
      String(c.seriesWrites?.setAt ?? 'n/a'),
      String(c.seriesWrites?.ensureBar ?? 'n/a'),
    ].join(' | ')} |`);
  }
  return lines.join('\n');
}

// ── compare ─────────────────────────────────────────────────────────────────

const keyOf = (r) => `${r.scriptName}|${r.enginePath}|${r.bars}`;
const CMP_FIELDS = [...MS_COLS, 'prepare', 'execute', 'msPerBar', 'median'];

/**
 * Per-field diff of two runs. `rule` follows the plan: only a |Δ| > 10% is
 * labelled `regression` (slower) or `improvement` (faster); everything else is
 * kept for the record but left unlabelled.
 */
export function compare(baseline, next, threshold = 0.10) {
  const base = new Map(baseline.results.map((r) => [keyOf(r), r]));
  const rows = [];
  for (const r of next.results) {
    const b = base.get(keyOf(r));
    if (!b) continue;
    const fields = [];
    for (const f of CMP_FIELDS) {
      const bv = b.ms[f];
      const nv = r.ms[f];
      if (typeof bv !== 'number' || typeof nv !== 'number') continue;
      const abs = nv - bv;
      const pct = bv === 0 ? null : abs / bv;
      let rule = 'equal';
      if (pct !== null && Math.abs(pct) > threshold) rule = pct > 0 ? 'regression' : 'improvement';
      fields.push({ field: f, baseline: r2(bv), current: r2(nv), delta: r2(abs), pct: pct === null ? null : r2(pct * 100), rule });
    }
    rows.push({ key: keyOf(r), script: r.scriptName, enginePath: r.enginePath, bars: r.bars, fields });
  }
  const total = rows.flatMap((r) => r.fields.filter((f) => f.field === 'total'));
  const worst = total.length ? Math.max(...total.map((f) => Math.abs(f.pct ?? 0))) : null;
  return {
    baselineLabel: baseline.label ?? null,
    currentLabel: next.label ?? null,
    thresholdPct: threshold * 100,
    // H2: same settings run twice must land inside 15% on `total`.
    totalMaxAbsPct: worst === null ? null : r2(worst),
    repeatable: worst === null ? null : worst < 15,
    rows,
  };
}

export function mdCompare(cmp) {
  const lines = [
    `### --compare  ${cmp.baselineLabel ?? '?'} → ${cmp.currentLabel ?? '?'}  (門檻 ±${cmp.thresholdPct}%)`,
    '',
    `total 最大差異 **${fmt(cmp.totalMaxAbsPct, 2)}%** → 重複性（<15%）: **${cmp.repeatable ? 'PASS' : 'FAIL'}**`,
    '',
    '| script | engine | bars | field | baseline | current | Δ | Δ% | 判定 |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of cmp.rows) {
    for (const f of r.fields) {
      lines.push(`| ${r.script} | ${r.enginePath} | ${r.bars} | ${f.field} | ${fmt(f.baseline)} | ${fmt(f.current)} | ${fmt(f.delta)} | ${f.pct === null ? 'n/a' : fmt(f.pct, 1)} | ${f.rule} |`);
    }
  }
  return lines.join('\n');
}

/**
 * `--scale` growth verdict. For each (script, enginePath) the median total at
 * each N is compared to the linear expectation `median(N0) * N/N0`; >+30%
 * deviation flags `SUPERLINEAR` on that record (plan §P5 判定規則).
 */
export function growthFlags(records, tolerance = 0.30) {
  const groups = new Map();
  for (const r of records) {
    const k = `${r.scriptName}|${r.enginePath}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [k, rs] of groups) {
    const sorted = [...rs].sort((a, b) => a.bars - b.bars);
    if (sorted.length < 2) continue;
    const base = sorted[0];
    for (const r of sorted.slice(1)) {
      const expect = (base.median * r.bars) / base.bars;
      const ratio = expect > 0 ? r.median / expect : null;
      if (ratio !== null && ratio > 1 + tolerance) r.flags.push('SUPERLINEAR');
      out.push({
        key: k, bars: base.bars, barsCurrent: r.bars,
        baseMedian: r2(base.median), median: r2(r.median),
        expectedLinear: r2(expect), ratio: ratio === null ? null : r2(ratio),
        superlinear: ratio !== null && ratio > 1 + tolerance,
      });
    }
  }
  return out;
}
