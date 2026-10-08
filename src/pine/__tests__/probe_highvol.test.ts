import { describe, it } from 'vitest';
import { readFileSync } from 'fs';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';
import '../mtf';
import { mkBars, fetchTf } from './golden';
import { __mtfStats, resetMtf } from '../mtf';

import type { BarData } from '../contracts';

const CASES = [
  { name: '高量1.46', file: 'C:/Users/bear9/high452/高量1.46/高量1.46_backup.TXT', tf: 'D', bars: (b: BarData[]) => b.slice(-500) },
  { name: '見高K4.55', file: 'C:/Users/bear9/high452/HIGH455/見高K4.54/見高K4.55.TXT', tf: '15', bars: (b: BarData[]) => b },
];

describe('indicator timing', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const src = readFileSync(c.file, 'utf8').replace(/^﻿/, '');
      const t0 = Date.now();
      const parsed = parse(src);
      const tParse = Date.now() - t0;

      const BASE_1M = mkBars(3000, 0, 60_000);
      const BASE_15M = mkBars(2000, 0, 15 * 60_000);
      const bars = c.tf === '15' ? BASE_15M.slice(-500) : BASE_1M.slice(-500);

      // Phase split: prefetch (MTF fetches) vs eval loop, by wrapping fetchSeries.
      let prefetchMs = 0, fetchN = 0;
      const fetches: string[] = [];
      const fetchSeries = async (s: string, t: string) => {
        fetchN++;
        fetches.push(`${s}|${t}`);
        const u = performance.now();
        const out = await fetchTf(BASE_1M)(s, t);
        prefetchMs += performance.now() - u;
        return out;
      };
      const t1 = Date.now();
      const r = await runScript(parsed, bars, { symbol: '2330', timeframe: c.tf, fetchSeries });
      const tRun = Date.now() - t1;
      const evalMs = tRun - prefetchMs;
      console.log(`[${c.name}] parse=${tParse}ms total=${tRun}ms fetch=${Math.round(prefetchMs)}ms(${fetchN}x) eval≈${Math.round(evalMs)}ms`);
      console.log(`[${c.name}] fetched=${JSON.stringify(fetches.slice(0, 12))}${fetches.length > 12 ? '…' : ''}`);
      console.log(`[${c.name}] stats=${JSON.stringify(__mtfStats)}`);
      console.log(`[${c.name}] warn=${r.warnings.length} ${JSON.stringify(r.warnings.slice(0, 4))} plots=${r.plots.size} draws=${r.drawings.length}`);
    }, 180_000);
  }
});
