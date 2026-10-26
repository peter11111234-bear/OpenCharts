// ── Pine type qualifiers (const ⊂ input ⊂ simple ⊂ series) ───────────────────
// Two things are pinned: the inference is SOUND (it says "series" only when the
// value demonstrably changes per bar) and the input.* gate fires on exactly the
// cases TV rejects. The negative cases matter as much as the positive ones: a
// false "series" verdict would reject a script that runs today.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from '../parser';
import { checkScript } from '../checks';
import { runScript } from '../interpreter';
import '../builtins/index';
import { mkBars } from './golden';
import { provenSeries } from '../qualifiers';
import type { Node } from '../contracts';

/** The initializer node of `x = <expr>` in a throwaway script. */
function exprNode(expr: string): Node {
  const parsed = parse(`//@version=6\nindicator("t")\nx = ${expr}`);
  for (const n of Array.isArray(parsed) ? parsed : parsed.body) {
    if (n.type === 'assign') return n.value;
  }
  throw new Error(`probe did not parse: ${expr}`);
}

const indicator = (body: string): string => `//@version=6\nindicator("t")\n${body}`;

const rules = (src: string): string[] => checkScript(parse(src)).diagnostics.map((d) => d.rule);

describe('provenSeries', () => {
  it('proves a per-bar value', () => {
    for (const e of [
      'close', 'ta.sma(close, 2)', 'str.tostring(close)', 'close[1]',
      'close > open ? 1 : 2', 'nz(close)', 'strategy.equity', 'strategy.position_size',
    ]) {
      expect(provenSeries(exprNode(e)), e).toBe(true);
    }
  });

  it('refuses to prove a value that cannot change per bar', () => {
    for (const e of [
      '1', '"D"', 'true', 'na', 'syminfo.tickerid', 'timeframe.period', 'barstate.islast',
      'str.tostring("a")', 'input.int(1)', 'math.max(1, 2)', 'array.new<float>(1)',
    ]) {
      expect(provenSeries(exprNode(e)), e).toBe(false);
    }
  });

  it('follows a global to its initializer, and stops when it is mutated', () => {
    const ident = exprNode('x');
    const series = new Map([['x', exprNode('ta.ema(close, 9)')]]);
    const literal = new Map([['x', exprNode('5')]]);
    expect(provenSeries(ident, (n) => series.get(n))).toBe(true);
    expect(provenSeries(ident, (n) => literal.get(n))).toBe(false);
    // var / varip / reassigned state is series by TV's definition, whatever it holds.
    expect(provenSeries(ident, (n) => literal.get(n), new Set(['x']))).toBe(true);
  });

  it('does not recurse forever on a self-referential global', () => {
    const ident = exprNode('x');
    const self = new Map([['x', exprNode('x')]]);
    expect(provenSeries(ident, (n) => self.get(n))).toBe(false);
  });
});

describe('input-const gate', () => {
  it('rejects a series defval (TV requires const)', () => {
    const r = checkScript(parse(indicator('a = input.int(close)\nplot(close)')));
    expect(r.diagnostics.map((d) => d.rule)).toEqual(['input-const']);
    expect(r.diagnostics[0]!.message).toBe(
      "Cannot call 'input.int' with a series 'defval' — TV requires a const default");
  });

  it('reaches through a global producer and a named argument', () => {
    expect(rules(indicator('src = ta.sma(close, 3)\na = input.float(src)\nplot(close)')))
      .toEqual(['input-const']);
    expect(rules(indicator('a = input.string(defval = str.tostring(close))\nplot(close)')))
      .toEqual(['input-const']);
  });

  it('rejects a var-held name (mutable state is series)', () => {
    expect(rules(indicator('var int n = 0\nn += 1\na = input.int(n)\nplot(close)')))
      .toEqual(['input-const']);
  });

  it('accepts literals, consts, simple names, and input.source', () => {
    const clean = [
      'a = input.int(1)',
      'const K = 5',
      'b = input.int(K)',
      'c = input.string("D")',
      'd = input.source(close)',
      'e = input.timeframe(timeframe.period)',
      'f = input.float(math.max(1.0, 2.0))',
      'plot(close)',
    ].join('\n');
    expect(rules(indicator(clean))).toEqual([]);
  });

  it('accepts a bare input() with a price-source default (TV series overload)', () => {
    expect(rules(indicator('a = input(close)\nb = input(hl2, "src")\nplot(a + b)'))).toEqual([]);
  });

  it('the exempted input(close) really tracks close on every bar', async () => {
    const r = await runScript(parse(indicator('a = input(close)\nplot(a, "a")\nplot(close, "c")')),
      mkBars(6), { symbol: 'X', timeframe: '1' } as never);
    const [a, c] = [...r.plots.values()].map((p) => p.values.map((v) => (v.kind === 'float' ? v.v : null)));
    expect(new Set(c).size).toBeGreaterThan(1);
    expect(a).toEqual(c);
  });

  it('still rejects a bare input() whose series default is not a price source', () => {
    expect(rules(indicator('a = input(ta.sma(close, 3))\nplot(close)'))).toEqual(['input-const']);
    // An alias is not exempt: at run time input() only recognises the price
    // series itself, so `input(p)` would freeze at bar 0's value.
    expect(rules(indicator('p = ohlc4\na = input(p)\nplot(a)'))).toEqual(['input-const']);
  });
});

describe('the gate against real scripts', () => {
  it('does not fire on the shipped corpus', () => {
    const files = [
      'src/pine/ema-sample.pine', 'src/pine/TRIS390.pine', 'final.pine',
      'scripts/golden/src/見高K4.55.TXT',
      'C:/Users/bear9/high452/HP/MZigZag - HP.TXT',
      'C:/Users/bear9/high452/MACD701.TXT',
      'C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine',
      'C:/Users/bear9/high452/MACD雙周期/V7/MACD雙周期V7.TXT',
      'C:/Users/bear9/high452/TD_BB/TD_BB.txt',
      'C:/Users/bear9/high452/TRIS39/TRIS390.TXT',
      'C:/Users/bear9/high452/turtle system.txt',
      'C:/Users/bear9/high452/高量1.46/高量1.46_backup.TXT',
    ];
    const seen = files.filter(existsSync);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const f of seen) {
      const r = checkScript(parse(readFileSync(f, 'utf8')));
      expect(r.diagnostics, f).toEqual([]);
    }
  });
});
