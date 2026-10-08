// Golden-value e2e: snapshot each real script's full RunResult (plot values,
// drawing props, fills, colors, warnings) into scripts/golden/*.golden.json.
// First commit generated via UPDATE_GOLDEN=1 — review the .golden.json before
// landing. After that, any semantic change shows up as a diff.
import { describe, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import type { BarData } from '../contracts';

import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';
import '../mtf';
import { fetchTf, goldenCheck, mkBars } from './golden';

const load = (p: string) => readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

// Each case: script path + run options. fetchSeries: base 1m bars resampled to
// whatever tf the script requests (mirrors dbg_real.ts semantics).
const BASE_1M = mkBars(3000, 0, 60_000);
const BASE_15M = mkBars(2000, 0, 15 * 60_000);
const BASE_60M = mkBars(1500, 0, 3_600_000);
const BASE_D = mkBars(1000, 0, 86_400_000);

const CASES: { name: string; file: string; timeframe: string; bars: BarData[]; fetch?: (s: string, t: string) => Promise<BarData[]> }[] = [
  { name: 'MACD701', file: 'C:/Users/bear9/high452/MACD701.TXT', timeframe: '60', bars: BASE_60M.slice(-500) },
  { name: '見高K4.55', file: 'C:/Users/bear9/high452/HIGH455/見高K4.54/見高K4.55.TXT', timeframe: '15', bars: BASE_15M.slice(-500) },
  { name: 'TRIS390', file: 'C:/Users/bear9/high452/TRIS39/TRIS390.TXT', timeframe: '15', bars: BASE_15M.slice(-500), fetch: fetchTf(BASE_1M) },
  { name: 'TD_BB', file: 'C:/Users/bear9/high452/TD_BB/TD_BB.txt', timeframe: '60', bars: BASE_60M.slice(-500) },
  { name: 'turtle', file: 'C:/Users/bear9/high452/turtle system.txt', timeframe: 'D', bars: BASE_D.slice(-500) },
  { name: '高量1.46', file: 'C:/Users/bear9/high452/高量1.46/高量1.46_backup.TXT', timeframe: 'D', bars: BASE_D.slice(-500), fetch: fetchTf(BASE_1M) },
  { name: 'MACD雙周期V7', file: 'C:/Users/bear9/high452/MACD雙周期/V7/MACD雙周期V7.TXT', timeframe: '60', bars: BASE_60M.slice(-500) },
  { name: 'MACD701_v72', file: 'C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine', timeframe: '60', bars: BASE_60M.slice(-500) },
  // Dynamic security mainline — final.pine has three conditional
  // request.security branches gated on barstate.islast; 1m chart exercises
  // all three (1m/15m/60m legs all hit request.security on the last bar).
  { name: 'final', file: 'C:/Users/bear9/OpenCharts/final.pine', timeframe: '1', bars: BASE_1M.slice(-1000), fetch: fetchTf(BASE_1M) },
  { name: 'norm2', file: 'C:/Users/bear9/OpenCharts/norm2.pine', timeframe: '1', bars: BASE_1M.slice(-1000), fetch: fetchTf(BASE_1M) },
];

describe('golden e2e', () => {
  for (const c of CASES) {
    // Missing fixture → skip, not ENOENT crash. Drop a .pine next to the repo
    // root (or restore from high452) and the case re-arms automatically.
    const runner = existsSync(c.file) ? it : it.skip;
    runner(c.name, async () => {
      const parsed = parse(load(c.file));
      const r = await runScript(parsed, c.bars, {
        symbol: '2330',
        timeframe: c.timeframe,
        fetchSeries: c.fetch,
      });
      goldenCheck(c.name, r);
    }, 120_000);
  }
});
