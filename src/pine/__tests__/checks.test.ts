// ── Compile-time script checks ──────────────────────────────────────────────
// PyneCore's four transform-time rejects + the static requirements scan. The
// point of these tests is the DIVERGENCE story: TV refuses to save these
// scripts, so "it ran and printed a number" is the bug, not the fix.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from '../parser';
import { assertScript, checkScript } from '../checks';

const analyse = (src: string) => checkScript(parse(src));

const indicator = (body: string): string => `//@version=6\nindicator("t")\n${body}`;

describe('plot-scope (CE10188 as a compile error)', () => {
  it('accepts the output family at global scope', () => {
    const r = analyse(indicator('plot(close, "x")\nhline(1)\nbgcolor(color.red)'));
    expect(r.diagnostics).toEqual([]);
  });

  it('accepts a conditional VALUE at global scope (the TV workaround)', () => {
    const r = analyse(indicator('plot(close > open ? close : na, "x")'));
    expect(r.diagnostics).toEqual([]);
  });

  it('rejects plot inside an if block with a line number', () => {
    const r = analyse(indicator('if close > open\n    plot(close, "x")'));
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ rule: 'plot-scope', line: 4 });
    expect(r.diagnostics[0]!.message).toBe("Cannot use 'plot' in local scope");
  });

  it('rejects the whole output family in a for loop and in a UDF body', () => {
    const loop = analyse(indicator('for i = 0 to 2\n    bgcolor(color.red)'));
    expect(loop.diagnostics.map((d) => d.rule)).toEqual(['plot-scope']);
    const udf = analyse(indicator('f() =>\n    plot(close, "x")\nplot(f(), "y")'));
    expect(udf.diagnostics.map((d) => d.rule)).toEqual(['plot-scope']);
  });
});

describe('outer-write (TV: no global writes from a function body)', () => {
  it('rejects reassigning a global inside a UDF', () => {
    const r = analyse(indicator('total = 0.0\nf() =>\n    total := 1.0\ntotal := f()\nplot(total)'));
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ rule: 'outer-write', line: 5 });
    expect(r.diagnostics[0]!.message).toBe("Cannot modify global variable 'total' in a function");
  });

  it('rejects reassigning a function parameter', () => {
    const r = analyse(indicator('f(a) =>\n    a := a + 1\n    a\nplot(f(1))'));
    expect(r.diagnostics.map((d) => d.message)).toEqual(["Cannot modify function parameter 'a'"]);
  });

  it('accepts local declarations and reads of globals', () => {
    const r = analyse(indicator('k = 2.0\nf(a) =>\n    b = a * k\n    b + 1\nplot(f(close))'));
    expect(r.diagnostics).toEqual([]);
  });

  it('accepts a global reassignment from global block scopes (still global scope)', () => {
    const r = analyse(indicator('x = 1.0\nif close > open\n    x := 2.0\nplot(x)'));
    expect(r.diagnostics).toEqual([]);
  });

  it('lets a local shadow a global name inside a function', () => {
    const r = analyse(indicator('v = 1.0\nf() =>\n    v = 2.0\n    v := 3.0\n    v\nplot(f())'));
    expect(r.diagnostics).toEqual([]);
  });
});

describe('security-drawings', () => {
  it('rejects a drawing constructor in a request.security expression', () => {
    const r = analyse(indicator('x = request.security(syminfo.tickerid, "D", line.new(bar_index, close, bar_index + 1, close))\nplot(close)'));
    expect(r.diagnostics.map((d) => d.rule)).toEqual(['security-drawings']);
    expect(r.diagnostics[0]!.message).toContain("'line.new'");
  });

  it('accepts drawing objects outside request expressions', () => {
    const r = analyse(indicator('line.new(bar_index, close, bar_index + 1, close)\nplot(close)'));
    expect(r.diagnostics).toEqual([]);
  });
});

describe('export-capture', () => {
  it('rejects an exported function capturing non-constant global state', () => {
    const src = `//@version=6
library("L")
var counter = 0
export bump() =>
    counter + 1
plot(1)`;
    const r = analyse(src);
    expect(r.diagnostics.map((d) => d.rule)).toEqual(['export-capture']);
    expect(r.diagnostics[0]!.message).toBe("Exported function 'bump' captures non-constant global 'counter'");
  });

  it('accepts a constant capture', () => {
    const src = `//@version=6
library("L")
const limit = 10
export isBig(v) =>
    v > limit
plot(1)`;
    expect(analyse(src).diagnostics).toEqual([]);
  });
});

describe('ScriptRequirements', () => {
  it('reports nothing for a plain plot script', () => {
    expect(analyse(indicator('plot(close)')).requirements).toEqual({
      security: false, externalData: false, orders: false, drawings: false,
      alerts: false, inputs: false, plots: true, viewport: false,
    });
  });

  it('detects each host dependency', () => {
    const r = analyse(indicator([
      'a = input.float(1.0, "a")',
      's = request.security("X", "D", close)',
      'e = request.earnings("X")',
      'strategy.entry("L", strategy.long)',
      'line.new(bar_index, s, bar_index + 1, s)',
      'alert("hi")',
      'plot(s + e + a + (chart.left_visible_bar_time > 0 ? 1 : 0))',
    ].join('\n')));
    expect(r.diagnostics).toEqual([]);
    expect(r.requirements).toEqual({
      security: true, externalData: true, orders: true, drawings: true,
      alerts: true, inputs: true, plots: true, viewport: true,
    });
  });
});

describe('assertScript', () => {
  it('throws a LINE:COL-located ParseError on the first diagnostic', () => {
    expect(() => assertScript(parse(indicator('if close > open\n    plot(close)'))))
      .toThrow(/^4:5: Cannot use 'plot' in local scope \[plot-scope\]$/);
  });

  it('returns the requirements when the script is clean', () => {
    expect(assertScript(parse(indicator('plot(close)'))).plots).toBe(true);
  });
});

describe('the shipped corpus', () => {
  it('passes the checks (the real scripts stay runnable)', () => {
    for (const f of ['src/pine/ema-sample.pine', 'src/pine/TRIS390.pine', 'final.pine']) {
      const src = readFileSync(f, 'utf8');
      const r = checkScript(parse(src));
      expect(r.diagnostics, `${f}: ${JSON.stringify(r.diagnostics)}`).toEqual([]);
    }
  });
});
