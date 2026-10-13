// ── Data-source-dependent TV v6 namespaces: the warn contract ───────────────
// These 45 entries must RESOLVE (an unregistered name reports "identifier not
// found" / "unknown constant", which hides the real reason: the engine has no
// such data source) and they must WARN.
//
// Silence is the failure this file pins. The fields especially must not be
// static string constants: `asNum` coerces the dotted selector through
// `Number('earnings.actual')` → NaN → 0, so `plot(earnings.actual)` would draw
// a flat line at 0 and say nothing about it.

import { describe, expect, it } from 'vitest';
import { BUILTINS, getConstant } from '../builtins';
import '../builtins';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { RunResult } from '../contracts';
import { mkBars } from './golden';

/** footprint.* 9 + ticker.* 9 + volume_row.* 8 + request.* 5. */
const FUNCTIONS = [
  'footprint.buy_volume', 'footprint.delta', 'footprint.get_row_by_price', 'footprint.poc',
  'footprint.rows', 'footprint.sell_volume', 'footprint.total_volume', 'footprint.vah',
  'footprint.val',
  'ticker.heikinashi', 'ticker.inherit', 'ticker.kagi', 'ticker.linebreak', 'ticker.modify',
  'ticker.new', 'ticker.pointfigure', 'ticker.renko', 'ticker.standard',
  'volume_row.buy_volume', 'volume_row.delta', 'volume_row.down_price',
  'volume_row.has_buy_imbalance', 'volume_row.has_sell_imbalance', 'volume_row.sell_volume',
  'volume_row.total_volume', 'volume_row.up_price',
  'request.economic', 'request.financial', 'request.footprint', 'request.quandl', 'request.seed',
];

/** earnings.* 7 + dividends.* 5 + splits.* 2 — field selectors, lazy constants. */
const FIELDS = [
  'earnings.actual', 'earnings.estimate', 'earnings.future_eps',
  'earnings.future_period_end_time', 'earnings.future_revenue', 'earnings.future_time',
  'earnings.standardized',
  'dividends.future_amount', 'dividends.future_ex_date', 'dividends.future_pay_date',
  'dividends.gross', 'dividends.net',
  'splits.denominator', 'splits.numerator',
];

const BARS = mkBars(3);
const OPTS = { symbol: 'X', timeframe: 'D', fetchSeries: async () => [] } as const;

/** First plot's per-bar numeric values ('na' for anything non-numeric). */
function plotNums(r: RunResult): unknown[] {
  const plot = r.plots.get('plot_0') ?? r.plots.values().next().value;
  return (plot?.values ?? []).map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na'));
}

describe('data-source stubs resolve, warn, and return na', () => {
  it('registers all 45 names (31 functions, 14 fields)', () => {
    expect(FUNCTIONS).toHaveLength(31);
    expect(FIELDS).toHaveLength(14);
    for (const n of FUNCTIONS) expect(BUILTINS.has(n), n).toBe(true);
    // A field resolves through the lazy path, so a bare lookup is enough to
    // prove it is registered — and it warns whether or not a ctx is supplied.
    for (const n of FIELDS) expect(getConstant(n), n).toEqual({ kind: 'na' });
  });

  it('using all 45 in one script: no name-not-found, exactly one warning each', async () => {
    const used = [...FUNCTIONS.map(n => `plot(${n}(1))`), ...FIELDS.map(n => `plot(${n})`)];
    const r = await runScript(parse(`indicator("t")\n${used.join('\n')}`), BARS, OPTS);
    expect(r.warnings.filter(w => /not found|unknown constant/.test(w))).toEqual([]);
    for (const n of [...FUNCTIONS, ...FIELDS]) {
      expect(r.warnings.filter(w => w.startsWith(`${n}: not supported`)), n).toHaveLength(1);
    }
  });

  it('a field selector is na, not the coerced zero a string constant would give', async () => {
    const earn = await runScript(parse('indicator("t")\nplot(earnings.actual)'), BARS, OPTS);
    expect(plotNums(earn)).toEqual(['na', 'na', 'na']);
    expect(earn.warnings).toContain('earnings.actual: not supported — no earnings data source is wired; returning na');
  });

  it('footprint and ticker stubs return na and name themselves in the warning', async () => {
    const fp = await runScript(parse('indicator("t")\nplot(footprint.poc(1))'), BARS, OPTS);
    expect(plotNums(fp)).toEqual(['na', 'na', 'na']);
    expect(fp.warnings).toContain('footprint.poc: not supported — no tick-level footprint data source is wired; returning na');
    const tk = await runScript(parse('indicator("t")\nplot(ticker.renko("X"))'), BARS, OPTS);
    expect(plotNums(tk)).toEqual(['na', 'na', 'na']);
    expect(tk.warnings).toContain('ticker.renko: not supported — alternative ticker ids are not resolved by this engine; returning na');
  });
});
