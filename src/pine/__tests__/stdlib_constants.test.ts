// ── Pinned values for the TV v6 stdlib constants closed by this batch ───────
// Presence alone is not enough: a constant that resolves to the wrong value is
// still a silent mis-computation for the user. Each case below pins the real
// Value TV documents, and the dayofweek/input.enum cases tie the constant to
// the builtin that consumes it.

import { describe, expect, it } from 'vitest';
import { getConstant } from '../builtins';
import '../builtins';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { RunResult } from '../contracts';
import { mkBars } from './golden';

/** First plot's per-bar numeric values (na for non-numeric) — 4 call sites. */
function plotNums(r: RunResult): unknown[] {
  const plot = r.plots.get('plot_0') ?? r.plots.values().next().value;
  return (plot?.values ?? []).map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na'));
}

const BARS = mkBars(3);
const OPTS = { symbol: 'X', timeframe: 'D', fetchSeries: async () => [] } as const;

describe('stdlib enum constants', () => {
  it('dayofweek.* are TV integers (Sunday = 1 … Saturday = 7)', () => {
    expect(getConstant('dayofweek.sunday')).toEqual({ kind: 'int', v: 1 });
    expect(getConstant('dayofweek.monday')).toEqual({ kind: 'int', v: 2 });
    expect(getConstant('dayofweek.tuesday')).toEqual({ kind: 'int', v: 3 });
    expect(getConstant('dayofweek.wednesday')).toEqual({ kind: 'int', v: 4 });
    expect(getConstant('dayofweek.thursday')).toEqual({ kind: 'int', v: 5 });
    expect(getConstant('dayofweek.friday')).toEqual({ kind: 'int', v: 6 });
    expect(getConstant('dayofweek.saturday')).toEqual({ kind: 'int', v: 7 });
  });

  it('dayofweek.* numbering agrees with the dayofweek(time) builtin', async () => {
    // 2024-01-07 is a Sunday → 1; 2024-01-08 a Monday → 2.
    const sun = await runScript(
      parse('indicator("t")\nplot(dayofweek(timestamp("UTC", 2024, 1, 7, 0, 0, 0)))'), BARS, OPTS);
    const mon = await runScript(
      parse('indicator("t")\nplot(dayofweek(timestamp("UTC", 2024, 1, 8, 0, 0, 0)))'), BARS, OPTS);
    expect(plotNums(sun)).toEqual([1, 1, 1]);
    expect(plotNums(mon)).toEqual([2, 2, 2]);
    expect(getConstant('dayofweek.sunday')).toEqual({ kind: 'int', v: plotNums(sun)[0] });
    expect(getConstant('dayofweek.monday')).toEqual({ kind: 'int', v: plotNums(mon)[0] });
  });

  it('currency.* carry the bare code, not a dotted name', () => {
    expect(getConstant('currency.TWD')).toEqual({ kind: 'string', v: 'TWD' });
    expect(getConstant('currency.NONE')).toEqual({ kind: 'string', v: 'NONE' });
    expect(getConstant('currency.USD')).toEqual({ kind: 'string', v: 'USD' });
    // All 56 TV v6 codes, each value === its own name.
    const codes = [
      'NONE', 'USD', 'EUR', 'AUD', 'GBP', 'NZD', 'CAD', 'CHF', 'HKD', 'JPY', 'NOK', 'SEK',
      'SGD', 'TRY', 'ZAR', 'RUB', 'BTC', 'ETH', 'MYR', 'KRW', 'USDT', 'INR', 'PLN', 'PKR',
      'EGP', 'AED', 'COP', 'MXN', 'CLP', 'BRL', 'ARS', 'PEN', 'IDR', 'SAR', 'BDT', 'BHD',
      'CNY', 'CZK', 'DKK', 'HUF', 'ILS', 'ISK', 'KES', 'KWD', 'LKR', 'MAD', 'NGN', 'PHP',
      'QAR', 'RON', 'RSD', 'THB', 'TND', 'TWD', 'VES', 'VND',
    ];
    expect(codes).toHaveLength(56);
    expect(codes.map(c => getConstant(`currency.${c}`))).toEqual(codes.map(c => ({ kind: 'string', v: c })));
  });

  it('chart.is_* are booleans for this app (standard candles only)', () => {
    expect(getConstant('chart.is_standard')).toEqual({ kind: 'bool', v: true });
    expect(getConstant('chart.is_renko')).toEqual({ kind: 'bool', v: false });
    expect(getConstant('chart.is_heikinashi')).toEqual({ kind: 'bool', v: false });
    expect(getConstant('chart.is_linebreak')).toEqual({ kind: 'bool', v: false });
    expect(getConstant('chart.is_kagi')).toEqual({ kind: 'bool', v: false });
    expect(getConstant('chart.is_pnf')).toEqual({ kind: 'bool', v: false });
    expect(getConstant('chart.is_range')).toEqual({ kind: 'bool', v: false });
  });

  it('one name from each new enum set resolves to its dotted name', () => {
    expect(getConstant('plot.linestyle_solid')).toEqual({ kind: 'string', v: 'plot.linestyle_solid' });
    expect(getConstant('plot.style_stepline_diamond')).toEqual({ kind: 'string', v: 'plot.style_stepline_diamond' });
    expect(getConstant('display.pine_screener')).toEqual({ kind: 'string', v: 'display.pine_screener' });
    expect(getConstant('scale.right')).toEqual({ kind: 'string', v: 'scale.right' });
    expect(getConstant('adjustment.splits')).toEqual({ kind: 'string', v: 'adjustment.splits' });
    expect(getConstant('backadjustment.on')).toEqual({ kind: 'string', v: 'backadjustment.on' });
    expect(getConstant('settlement_as_close.inherit')).toEqual({ kind: 'string', v: 'settlement_as_close.inherit' });
    // …and the rest of each new set, so a truncated list is caught.
    expect(['right', 'left', 'none'].map(n => getConstant(`scale.${n}`)))
      .toEqual(['right', 'left', 'none'].map(n => ({ kind: 'string', v: `scale.${n}` })));
    expect(['none', 'splits', 'dividends'].map(n => getConstant(`adjustment.${n}`)))
      .toEqual(['none', 'splits', 'dividends'].map(n => ({ kind: 'string', v: `adjustment.${n}` })));
    expect(['inherit', 'on', 'off'].map(n => getConstant(`backadjustment.${n}`)))
      .toEqual(['inherit', 'on', 'off'].map(n => ({ kind: 'string', v: `backadjustment.${n}` })));
    expect(['inherit', 'on', 'off'].map(n => getConstant(`settlement_as_close.${n}`)))
      .toEqual(['inherit', 'on', 'off'].map(n => ({ kind: 'string', v: `settlement_as_close.${n}` })));
    expect(['solid', 'dashed', 'dotted'].map(n => getConstant(`plot.linestyle_${n}`)))
      .toEqual(['solid', 'dashed', 'dotted'].map(n => ({ kind: 'string', v: `plot.linestyle_${n}` })));
  });

  it('input.enum returns the defval and records the options in the schema', async () => {
    const r = await runScript(
      parse('indicator("t")\nm = input.enum("a", "mode", ["a", "b", "c"])\nplot(m == "a" ? 1 : 0)'), BARS, OPTS);
    expect(plotNums(r)).toEqual([1, 1, 1]);
    expect(r.inputs.find(i => i.name === 'mode')).toMatchObject({
      type: 'enum', defval: 'a', options: ['a', 'b', 'c'],
    });
  });

  it('input.enum honors an override', async () => {
    const r = await runScript(
      parse('indicator("t")\nm = input.enum("a", "mode", ["a", "b"])\nplot(m == "b" ? 1 : 0)'),
      BARS, { ...OPTS, inputValues: { mode: 'b' } });
    expect(plotNums(r)).toEqual([1, 1, 1]);
  });
});
