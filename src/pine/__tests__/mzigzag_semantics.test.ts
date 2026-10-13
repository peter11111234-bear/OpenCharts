// Pine ⇄ TradingView semantics pinned for the MZigZag - HP port (v5).
// Root cause of "legend shows, zero output" was #3 (`array.unshift(a, value=v)`
// silently bound nothing → na pivots). #1/#2/#4 already held at the time of the
// fix; they are pinned here so a future coercion change cannot regress them.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { RunResult } from '../contracts';
import '../builtins/index';
import '../mtf';

const OPTS = { symbol: 'X', timeframe: '5' };
const oscBars = (n: number) => {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const p = 22000 + Math.sin(i / 8) * 500 + Math.sin(i / 3) * 80;
    bars.push({ openTime: i * 300000, open: p, high: p + 40, low: p - 40, close: p + 5, volume: 1000 });
  }
  return bars;
};

const run = (src: string, n = 10, bars = oscBars(n)): Promise<RunResult> =>
  runScript(parse(src), bars, OPTS);

/** Last non-na value of a named plot. */
const lastOf = (r: RunResult, name: string) => {
  const p = r.plots.get(name);
  if (!p) throw new Error(`no plot '${name}' (have ${[...r.plots.keys()].join(',')})`);
  for (let i = p.values.length - 1; i >= 0; i--) if (p.values[i]!.kind !== 'na') return p.values[i]!;
  throw new Error(`plot '${name}' all na`);
};

describe('MZigZag - HP Pine semantics', () => {
  it('#1 numeric used as boolean in `if` (0/na → false, else true)', async () => {
    const r = await run(`indicator("t")
var n = 0
if 1.5
    n := n + 1
if 0.0
    n := n + 100
if na
    n := n + 1000
plot(n, "n")`);
    expect(lastOf(r, 'n')).toEqual({ kind: 'int', v: 10 }); // +1 per bar, nothing else
  });

  it('#2 numeric in `and`/`or`/`not`/ternary conditions', async () => {
    const r = await run(`indicator("t")
var n = 0
if 5 and true
    n := n + 1
if 0 and true
    n := n + 100
if not 0
    n := n + 1
if not 5
    n := n + 100
if 2 or false
    n := n + 1
if na or true
    n := n + 1
plot(n, "n")
plot(3 > 1 ? 10 : 20, "t")`);
    expect(lastOf(r, 'n')).toEqual({ kind: 'int', v: 40 }); // 4 per bar
    expect(lastOf(r, 't')).toEqual({ kind: 'int', v: 10 });
  });

  it('#3 array.push/unshift accept the TV reference name `value=`', async () => {
    const r = await run(`indicator("t")
var a = array.new_float(0)
if bar_index == 0
    array.unshift(a, value=42.5)
if bar_index == 1
    array.push(a, value=7.25)
plot(array.size(a), "sz")
plot(array.size(a) > 0 ? array.get(a, 0) : na, "v0")
plot(array.size(a) > 1 ? array.get(a, 1) : na, "v1")`);
    expect(lastOf(r, 'sz')).toEqual({ kind: 'int', v: 2 });
    expect(lastOf(r, 'v0')).toEqual({ kind: 'float', v: 42.5 });
    expect(lastOf(r, 'v1')).toEqual({ kind: 'float', v: 7.25 });
  });

  it('#4 bare expression statements in a UDF body still execute', async () => {
    const r = await run(`indicator("t")
var n = 0
g() =>
    n := n + 100
f(x) =>
    a = x + 1
    a
    g()
    n := n + a
f(2)
plot(n, "n")`);
    expect(lastOf(r, 'n')).toEqual({ kind: 'int', v: 1030 }); // +103 per bar
  });

  it('end-to-end: MZigZag - HP emits harmonic lines and labels', async () => {
    const src = readFileSync('C:/Users/bear9/high452/HP/MZigZag - HP.TXT', 'utf8').replace(/^\uFEFF/, '');
    const r = await runScript(parse(src), oscBars(400), OPTS);
    const lines = r.drawings.filter(d => d.kind === 'line').length;
    const labels = r.drawings.filter(d => d.kind === 'label').length;
    // Zero here = the pivot buffers hold na (named-arg regression) and no
    // pattern can ever fire.
    expect(lines).toBeGreaterThan(0);
    expect(labels).toBeGreaterThan(0);
  }, 60000);
});
