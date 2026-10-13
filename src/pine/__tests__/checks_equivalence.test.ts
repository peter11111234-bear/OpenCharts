// ── Fused vs sequential equivalence (PyneCore's PYNE_AST_SEQUENTIAL proof) ───
// `checkScript` drives PlotScope / OuterWrite / ExportCapture /
// SecurityDrawings / requirements off ONE traversal. PyneCore proves the fused
// passes match running each rule alone; here that is a unit test instead of a
// manual env-var run: `checkScript(parsed, true)` walks each rule separately.
// Any rule that quietly depends on another rule's traversal (or on visit order)
// diverges here.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from '../parser';
import { checkScript } from '../checks';

/** Scripts shipped in the repo — always present. */
const IN_REPO = ['src/pine/ema-sample.pine', 'src/pine/TRIS390.pine', 'final.pine'];

/** The user's real scripts (the e2e corpus). Absent on a fresh clone. */
const LOCAL_CORPUS = [
  'C:/Users/bear9/high452/HIGH455/見高K4.54/見高K4.55.TXT',
  'C:/Users/bear9/high452/HP/MZigZag - HP.TXT',
  'C:/Users/bear9/high452/MACD701.TXT',
  'C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine',
  'C:/Users/bear9/high452/MACD雙周期/V7/MACD雙周期V7.TXT',
  'C:/Users/bear9/high452/TD_BB/TD_BB.txt',
  'C:/Users/bear9/high452/TRIS39/TRIS390.TXT',
  'C:/Users/bear9/high452/turtle system.txt',
  'C:/Users/bear9/high452/高量1.46/高量1.46_backup.TXT',
];

/** Constructs every rule can fire on, in the shapes the walker special-cases:
 *  nested blocks, switch, while, for, method, arrow, tuple, history refs. */
const TORTURE = `//@version=6
indicator("t", overlay = true)
var rows = 0
const LIMIT = 3
type Point
    float x
    float y
method dot(Point self, Point o) =>
    self.x * o.x + self.y * o.y
scale(v) => v * LIMIT
tick(P) =>
    total = 0.0
    for i = 0 to 2
        total += P.x
    total
pick(n) =>
    switch n
        1 => "a"
        2 => "b"
        => "c"
loop() =>
    k = 0
    while k < 2
        k += 1
    k
clean() =>
    rows + 1
if close > open
    rows += 1
[a, b] = [scale(close), tick(Point.new(1, close))]
c = request.security(syminfo.tickerid, "D", close)
plot(c + a + b + pick(loop()) + clean() + (chart.left_visible_bar_time > 0 ? 1 : 0), "x")
`;

const DIRTY = `//@version=6
library("L")
g = 0.0
var state = 0
export bump() =>
    state + 1
f(p) =>
    g := p
    p := 2
    p
if close > open
    plot(g)
line.new(bar_index, close, bar_index + 1, request.security("X", "D", label.new(bar_index, close)).x)
`;

const SOURCES: [string, string][] = [
  ['torture', TORTURE],
  ['dirty', DIRTY],
  ...IN_REPO.filter(existsSync).map((f) => [f, readFileSync(f, 'utf8')] as [string, string]),
  ...LOCAL_CORPUS.filter(existsSync).map((f) => [f, readFileSync(f, 'utf8')] as [string, string]),
];

describe('fused vs sequential AST checks', () => {
  it('covers every shipped script and the rule fixtures', () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(5);
  });

  it('emits identical diagnostics and requirements in both modes', () => {
    for (const [name, src] of SOURCES) {
      const parsed = parse(src);
      const fused = checkScript(parsed, false);
      const sequential = checkScript(parsed, true);
      expect(sequential, name).toEqual(fused);
    }
  });

  it('the dirty fixture fires every rule (the probe is not vacuous)', () => {
    const { diagnostics } = checkScript(parse(DIRTY), false);
    expect(new Set(diagnostics.map((d) => d.rule))).toEqual(
      new Set(['plot-scope', 'outer-write', 'export-capture', 'security-drawings']));
  });
});
