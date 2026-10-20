// Golden-value e2e: snapshot each real script's full RunResult (plot values,
// drawing props, fills, colors, warnings) into scripts/golden/*.golden.json.
// First commit generated via UPDATE_GOLDEN=1 — review the .golden.json before
// landing. After that, any semantic change shows up as a diff.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { BarData } from '../contracts';

import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';
import '../mtf';
import { compareSnapshots, fetchTf, goldenCheck, mkBars } from './golden';

const load = (p: string) => readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

// Sources live in the repo next to their snapshots: a golden without its
// source cannot be regenerated or trusted. Copied from high452 on 2026-10-21.
const REPO = join(__dirname, '..', '..', '..');
const GOLDEN_DIR = join(REPO, 'scripts', 'golden');
const src = (f: string) => join(GOLDEN_DIR, 'src', f);

// Each case: script path + run options. fetchSeries: base 1m bars resampled to
// whatever tf the script requests (mirrors dbg_real.ts semantics).
const BASE_1M = mkBars(3000, 0, 60_000);
const BASE_15M = mkBars(2000, 0, 15 * 60_000);
const BASE_60M = mkBars(1500, 0, 3_600_000);
const BASE_D = mkBars(1000, 0, 86_400_000);

const CASES: { name: string; file: string; timeframe: string; bars: BarData[]; fetch?: (s: string, t: string) => Promise<BarData[]> }[] = [
  { name: '見高K4.55', file: src('見高K4.55.TXT'), timeframe: '15', bars: BASE_15M.slice(-500) },
  { name: 'TRIS390', file: src('TRIS390.TXT'), timeframe: '15', bars: BASE_15M.slice(-500), fetch: fetchTf(BASE_1M) },
  { name: 'TD_BB', file: src('TD_BB.txt'), timeframe: '60', bars: BASE_60M.slice(-500) },
  { name: 'turtle', file: src('turtle.txt'), timeframe: 'D', bars: BASE_D.slice(-500) },
  { name: '高量1.46', file: src('高量1.46.TXT'), timeframe: 'D', bars: BASE_D.slice(-500), fetch: fetchTf(BASE_1M) },
  { name: 'MACD雙周期V7', file: src('MACD雙周期V7.TXT'), timeframe: '60', bars: BASE_60M.slice(-500) },
  { name: 'MACDV7.04', file: src('MACDV7.04.TXT'), timeframe: '60', bars: BASE_60M.slice(-500), fetch: fetchTf(BASE_1M) },
  // Dynamic security mainline — final.pine has three conditional
  // request.security branches gated on barstate.islast; 1m chart exercises
  // all three (1m/15m/60m legs all hit request.security on the last bar).
  { name: 'final', file: join(REPO, 'final.pine'), timeframe: '1', bars: BASE_1M.slice(-1000), fetch: fetchTf(BASE_1M) },
];

describe('golden e2e', () => {
  for (const c of CASES) {
    // A missing source fails loudly. It used to skip, and the norm2 case sat
    // skipped for days after its untracked source vanished (2026-10-20).
    it(c.name, async () => {
      if (!existsSync(c.file)) throw new Error(`golden source missing: ${c.file}`);
      const parsed = parse(load(c.file));
      const r = await runScript(parsed, c.bars, {
        symbol: '2330',
        timeframe: c.timeframe,
        fetchSeries: c.fetch,
      });
      goldenCheck(c.name, r);
    }, 120_000);
  }

  it('every snapshot has a case and every case has a snapshot', () => {
    const snapshots = readdirSync(GOLDEN_DIR)
      .filter((f) => f.endsWith('.golden.json'))
      .map((f) => f.slice(0, -'.golden.json'.length))
      .sort();
    expect(snapshots).toEqual(CASES.map((c) => c.name).sort());
  });
});

// ── comparator unit tests ───────────────────────────────────────────────────

describe('golden comparator', () => {
  it('passes a sub-tolerance float difference', () => {
    const r = compareSnapshots(
      { plots: { a: { values: [1, 2.0000000001] } } },
      { plots: { a: { values: [1, 2] } } },
    );
    expect(r.diffs).toHaveLength(0);
    expect(r.maxAbs).toBeGreaterThan(0);
  });

  it('fails a 1e-3 difference and names the exact path', () => {
    const r = compareSnapshots(
      { plots: { a: { values: [1, 2.001] } } },
      { plots: { a: { values: [1, 2] } } },
    );
    expect(r.diffs).toHaveLength(1);
    expect(r.diffs[0]!.path).toBe('plots.a.values[1]');
  });

  it('never treats na (null) as zero', () => {
    expect(compareSnapshots({ v: [null] }, { v: [0] }).diffs).toHaveLength(1);
    expect(compareSnapshots({ v: [null] }, { v: [null] }).diffs).toHaveLength(0);
  });

  it('compares integer-valued keys exactly', () => {
    expect(compareSnapshots({ index: 3 }, { index: 4 }).diffs).toHaveLength(1);
    expect(compareSnapshots({ time: 1_700_000_000_000 }, { time: 1_700_000_000_001 }).diffs).toHaveLength(1);
    expect(compareSnapshots({ plots: { p: { values: [7] } } }, { plots: { p: { values: [7.0000000001] } } }).diffs).toHaveLength(0);
  });

  it('reports a missing key as a structural diff', () => {
    expect(compareSnapshots({ a: 1 }, { a: 1, b: 2 }).diffs).toHaveLength(1);
    expect(compareSnapshots({ a: 1, b: 2 }, { a: 1 }).diffs).toHaveLength(1);
  });
});
