// Ad-hoc indicator probe — not a regression test; delete when done.
import { describe, it } from 'vitest';
import { readFileSync } from 'fs';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';
import '../mtf';
import { mkBars } from './golden';

const CASES = [
  { name: 'TD_BB', file: 'C:/Users/bear9/high452/TD_BB/TD_BB.txt', tf: '60', bars: mkBars(500, 0, 3_600_000) },
  { name: 'MACD701_v72', file: 'C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine', tf: '60', bars: mkBars(500, 0, 3_600_000) },
];

describe('indicator probes', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const src = readFileSync(c.file, 'utf8').replace(/^﻿/, '');
      const parsed = parse(src);
      console.log(`[${c.name}] stmts=${parsed.body.length} decl=${parsed.decl?.title ?? 'n/a'}`);
      const t0 = Date.now();
      const r = await runScript(parsed, c.bars, { symbol: '2330', timeframe: c.tf });
      console.log(`[${c.name}] run=${Date.now() - t0}ms warnings=${JSON.stringify(r.warnings.slice(0, 8))}`);
      console.log(`[${c.name}] plots=${JSON.stringify([...r.plots.keys()])}`);
      for (const [k, p] of r.plots) {
        const last = p.values.slice(-2).map(v => v.kind + (('v' in v) ? '=' + JSON.stringify(v.v).slice(0, 40) : ''));
        console.log(`[${c.name}]   ${k}: ${JSON.stringify(last)}`);
      }
      console.log(`[${c.name}] drawings=${r.drawings.length} ${JSON.stringify(r.drawings.slice(0, 4).map(d => d.kind + ':' + d.id))}`);
      console.log(`[${c.name}] inputs=${JSON.stringify(r.inputs.map(i => `${i.type}:${i.name}`))}`);
    }, 120_000);
  }
});
