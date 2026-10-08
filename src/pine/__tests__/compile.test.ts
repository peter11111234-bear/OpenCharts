// Slice-D parity harness: run every corpus script twice — once with the
// compiled-dispatch bar loop forced on (`__pineCompiled`, until Task 6 makes
// it the default) and once forced off (`__pineInterp`) — and snapshot()-
// compare both RunResults bit-for-bit.
import { describe, expect, it, beforeEach } from 'vitest';
import { parse } from '../parser';
import { runScript, __compileCalls, __compiledKinds, PineRuntimeError } from '../interpreter';
import '../builtins';
import '../mtf';
import { mkBars, fetchTf, snapshot } from './golden';
import type { RunResult } from '../contracts';

const CORPUS: { name: string; src: string }[] = [
  { name: 'decls+ops', src: `
indicator("t")
a = close + 1
b = a > open ? a : open
plot(b)` },
  { name: 'literals+arraylit', src: `
indicator("t")
n = 42
f = 1.5
s = "x"
b = true
c = #FF0000
z = na
arr = [1, 2, close]
plot(arr[0])` },
  { name: 'unary+binary+ident', src: `
indicator("t")
x = -close + +open
y = not (x > 0) ? -x : x
w = close > open and high > low or x != 0
plot(y)` },
  { name: 'var two-phase', src: `
indicator("t")
var x = close
var y = close * 2
plot(x[1])` },
  { name: 'var multi + varip', src: `
indicator("t")
var p = 1, q = 2
varip vip = 7
plot(p + q + vip)` },
  { name: 'var tuple', src: `
indicator("t")
var [a, b] = [close, open]
plot(a - b)` },
  { name: 'tuple non-var', src: `
indicator("t")
[a2, b2] = [close * 2, open]
plot(a2 + b2[1])` },
  { name: 'if/elseif/else', src: `
indicator("t")
r = 0.0
if close > open
    r := close
else if close == open
    r := open
else
    r := low
plot(r)` },
  { name: 'ifexpr', src: `
indicator("t")
v = if close > open
    close
else
    open
plot(v)` },
  { name: 'ternary chain', src: `
indicator("t")
t = close > open ? 1 : close < open ? -1 : 0
plot(t)` },
  { name: 'if-arm plot CE10188', src: `
indicator("t")
if bar_index > 10
    plot(close)
plot(open)` },
  { name: 'if-guarded var', src: `
indicator("t")
if close > open
    var gv = 1.0
    gv := gv + 1
plot(close)` },
  { name: 'loops fallback', src: `
indicator("t")
total = 0.0
for i = 0 to 3
    total += i
w = 0
while w < 2
    w += 1
    total += w
plot(total)` },
  { name: 'for-in kv + break/continue', src: `
indicator("t")
arr = [1, 2, 3]
t2 = 0.0
for [k, v] in arr
    if k == 1
        continue
    t2 += v
    if k == 2
        break
plot(t2)` },
  { name: 'switch fallback', src: `
indicator("t")
s = switch close > open
    true => 1.0
    => 0.0
plot(s)` },
  { name: 'top-level break/continue/return', src: `
indicator("t")
x = 1.0
if bar_index > 3
    x
plot(x)` },
  { name: 'reassign forms', src: `
indicator("t")
x = close
x := x + 1
arr = array.new_float(2, 0.0)
arr[0] := close
plot(x)` },
  { name: 'histref forms', src: `
indicator("t")
f(x) => x + 1
h1 = close[1]
h2 = f(close)[1]
h3 = ta.sma(close, 20)[1]
plot(h1 + h2 + h3)` },
  { name: 'request.security + udf wrap', src: `
indicator("t")
sec(x) => request.security(syminfo.tickerid, "60", x)
s1 = request.security(syminfo.tickerid, "60", close)
s2 = sec(open)
plot(s1 + s2)` },
  { name: 'func decl + param hist + param :=', src: `
indicator("t")
f(p) =>
    p := p + 1
    p + p[1]
plot(f(close))` },
  { name: 'typed + seq + arrow', src: `
indicator("t")
float tv = close
g = (a, b) => a + b
plot(g(tv, open))` },
  { name: 'member + method call', src: `
indicator("t")
plot(ta.sma(close, 5))` },
  { name: 'import warn dedup', src: `
indicator("t")
import foo/bar
plot(close)` },
  { name: 'export flatten', src: `
indicator("t")
export twice(x) => x * 2
plot(twice(close))` },
];

const OPTS = () => ({
  symbol: 'X', timeframe: 'D',
  fetchSeries: fetchTf(mkBars(3000)),
});

const g = globalThis as Record<string, unknown>;

async function runBoth(src: string): Promise<{ interp: RunResult; comp: RunResult }> {
  const bars = mkBars(60);
  g.__pineInterp = true;
  const interp = await runScript(parse(src), bars, OPTS());
  delete g.__pineInterp;
  g.__pineCompiled = true;
  const comp = await runScript(parse(src), bars, OPTS());
  delete g.__pineCompiled;
  return { interp, comp };
}

describe('compiled vs interpreted parity', () => {
  beforeEach(() => { delete g.__pineInterp; delete g.__pineCompiled; });
  for (const c of CORPUS) {
    it(c.name, async () => {
      const { interp, comp } = await runBoth(c.src);
      expect(snapshot(comp)).toEqual(snapshot(interp));
    });
  }

  it('var init side-effect count', async () => {
    // f() pushes into a persistent array; a compiled `var` that re-evals its
    // init every bar would grow arr — pin the final size at 1.
    const src = `
indicator("t")
var arr = array.new_float()
f() =>
    array.push(arr, 1.0)
    1.0
var v = f()
plot(array.size(arr))`;
    const { interp, comp } = await runBoth(src);
    expect(snapshot(comp)).toEqual(snapshot(interp));
    const plot = [...comp.plots.values()][0]!;
    const last = plot.values[plot.values.length - 1]!;
    expect(last).toEqual({ kind: 'int', v: 1 });
  });

  it('error attribution identical', async () => {
    const src = `
indicator("t")
x = 1.0
if bar_index > 3
    x := 2.0
undeclared := 5
plot(x)`;
    const bars = mkBars(10);
    const runOne = async (): Promise<{ msg: string; line: number; col: number }> => {
      try {
        await runScript(parse(src), bars, OPTS());
      } catch (e) {
        const err = e as PineRuntimeError;
        return { msg: err.message, line: err.line, col: err.col };
      }
      throw new Error('expected runScript to throw');
    };
    g.__pineInterp = true;
    const interp = await runOne();
    delete g.__pineInterp;
    g.__pineCompiled = true;
    const comp = await runOne();
    delete g.__pineCompiled;
    expect(comp).toEqual(interp);
    expect(comp.msg).toContain('undeclared');
  });

  it('flag off → compile() never called', async () => {
    const before = __compileCalls;
    g.__pineInterp = true;
    await runScript(parse('indicator("t")\nplot(close)'), mkBars(5), OPTS());
    delete g.__pineInterp;
    expect(__compileCalls).toBe(before);
  });

  it('flag on → compile() called once per top-level stmt', async () => {
    const src = 'indicator("t")\na = close\nplot(a)';
    const before = __compileCalls;
    g.__pineCompiled = true;
    await runScript(parse(src), mkBars(5), OPTS());
    delete g.__pineCompiled;
    // 2 top-level stmts (assign + call; indicator() lives in decl) + children.
    expect(__compileCalls - before).toBeGreaterThanOrEqual(2);
  });

  it('call stmts compile to direct closures', async () => {
    g.__pineCompiled = true;
    await runScript(parse('indicator("t")\nplot(close * 2 + open / 3)'), mkBars(5), OPTS());
    delete g.__pineCompiled;
    expect(__compiledKinds.get('call')).toBe('direct');
  });

  it('kind coverage: every seen type resolves per the fallback table', async () => {
    // Dispositions pinned by the plan's fallback table; types absent from the
    // map after a corpus run are unobserved, not unexpected.
    const EXPECTED: Record<string, 'direct' | 'twoPhase' | 'fallback'> = {
      num: 'direct', str: 'direct', bool: 'direct', color: 'direct', na: 'direct',
      ident: 'direct', unary: 'direct', binary: 'direct', ternary: 'direct',
      arraylit: 'direct', member: 'direct', histref: 'direct', call: 'direct',
      assign: 'direct', let: 'direct', const: 'direct', typed: 'direct',
      var: 'twoPhase', 'var[multi]': 'direct', tuple: 'direct',
      reassign: 'direct', if: 'direct', ifexpr: 'direct',
      break: 'direct', continue: 'direct', return: 'direct',
      seq: 'direct', func: 'direct', arrow: 'direct',
      method: 'direct', typedecl: 'direct', field: 'direct',
      import: 'direct', export: 'direct',
      for: 'fallback', while: 'fallback', switch: 'fallback',
      indicator: 'fallback', strategy: 'fallback',
    };
    g.__pineCompiled = true;
    for (const c of CORPUS) await runScript(parse(c.src), mkBars(10), OPTS());
    delete g.__pineCompiled;
    for (const [type, kind] of __compiledKinds) {
      expect(EXPECTED[type], `unexpected compiled kind for '${type}'`).toBe(kind);
    }
    // Fallback kinds stay fallback (loop/switch exception semantics).
    expect(__compiledKinds.get('for')).toBe('fallback');
    expect(__compiledKinds.get('switch')).toBe('fallback');
    expect(__compiledKinds.get('while')).toBe('fallback');
  });
});
