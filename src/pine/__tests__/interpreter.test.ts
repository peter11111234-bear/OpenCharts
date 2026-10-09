// ── Interpreter tests ────────────────────────────────────────────────────────
// Hand-built AST (parser lands separately). Bars via mkBars per shared spec.

import { describe, expect, it } from 'vitest';
import type { Arg, BarData, IndicatorDecl, Node, RunResult, Value } from '../contracts';
import { collectInputs, runScript, __callHistWrites } from '../interpreter';
import { FOR_IN, parse } from '../parser';
import '../builtins'; // registers the full builtin set (plot/array/draw/…)
import { BarSeries } from '../series';

// ── AST builders ──────────────────────────────────────────────────────────────

const num = (v: number): Node => ({ type: 'num', v, isInt: Number.isInteger(v) });
const str = (v: string): Node => ({ type: 'str', v });
const bool = (v: boolean): Node => ({ type: 'bool', v });
const ident = (name: string): Node => ({ type: 'ident', name });
const naLit: Node = { type: 'na' };
const bin = (op: string, left: Node, right: Node): Node => ({ type: 'binary', op, left, right });
const un = (op: string, arg: Node): Node => ({ type: 'unary', op, arg });
const assign = (name: string, value: Node): Node => ({ type: 'assign', name, value });
const varDecl = (name: string, value: Node): Node => ({ type: 'var', name, value });
const reassign = (name: string, value: Node): Node =>
  ({ type: 'reassign', target: ident(name), value });
const member = (obj: Node, prop: string): Node => ({ type: 'member', obj, prop });
const call = (callee: Node, args: Arg[]): Node => ({ type: 'call', callee, args });
const nsCall = (ns: string, name: string, args: Arg[]): Node =>
  call(member(ident(ns), name), args);
const histref = (obj: Node, idx: Node): Node => ({ type: 'histref', obj, idx });
const funcDecl = (name: string, params: string[], body: Node | Node[]): Node => ({
  type: 'func',
  name,
  params: params.map(p => ({ name: p })),
  body,
});

const plot = (value: Node, title?: string): Node =>
  call(ident('plot'), [
    { value },
    ...(title !== undefined ? [{ name: 'title', value: str(title) }] : []),
  ]);

const indicatorDecl = (args: Arg[]): IndicatorDecl => ({ type: 'indicator', args });

// ── bars ──────────────────────────────────────────────────────────────────────

/** mkBars: close = i + 1 so history/histref assertions are unambiguous. */
function mkBars(n: number): BarData[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: i * 60_000,
    open: i + 1,
    high: i + 2,
    low: i,
    close: i + 1,
    volume: 1000 + i,
  }));
}

// ── result helpers ────────────────────────────────────────────────────────────

function firstPlotValues(res: RunResult): Value[] {
  const first = res.plots.values().next().value;
  if (!first) throw new Error('no plots in result');
  return first.values;
}

function nums(vals: Value[]): (number | 'na')[] {
  return vals.map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na'));
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runScript basics', () => {
  it('indicator + x = 1 + plot(x) runs all bars', async () => {
    const body: Node[] = [assign('x', num(1)), plot(ident('x'), 'x')];
    const res = await runScript(
      { decl: indicatorDecl([{ value: str('t') }]), body },
      mkBars(5),
    );
    expect(res.title).toBe('t');
    expect(nums(firstPlotValues(res))).toEqual([1, 1, 1, 1, 1]);
    expect(firstPlotValues(res)).toHaveLength(5);
  });

  it('accepts bare Node[] body', async () => {
    const res = await runScript([assign('x', num(2)), plot(ident('x'))], mkBars(3));
    expect(nums(firstPlotValues(res))).toEqual([2, 2, 2]);
  });

  it('close/high/low/open series read per bar', async () => {
    const res = await runScript([plot(ident('close'), 'c')], mkBars(4));
    expect(nums(firstPlotValues(res))).toEqual([1, 2, 3, 4]);
  });
});

describe('var / assign / reassign', () => {
  it('var inits once (bar 0), persists, and reassigns accumulate', async () => {
    const body: Node[] = [
      varDecl('a', num(0)),
      reassign('a', bin('+', ident('a'), num(1))),
      plot(ident('a'), 'a'),
    ];
    const res = await runScript(body, mkBars(5));
    expect(nums(firstPlotValues(res))).toEqual([1, 2, 3, 4, 5]);
  });

  it('var history is visible via [1]', async () => {
    const body: Node[] = [
      varDecl('a', num(0)),
      reassign('a', bin('+', ident('a'), num(1))),
      assign('prev', histref(ident('a'), num(1))),
      plot(ident('prev'), 'p'),
    ];
    const res = await runScript(body, mkBars(4));
    expect(nums(firstPlotValues(res))).toEqual(['na', 1, 2, 3]);
  });

  it(':= on undeclared variable throws PineRuntimeError', async () => {
    await expect(runScript([reassign('nope', num(1))], mkBars(2))).rejects.toThrow(
      /undeclared/,
    );
  });

  it(':= on a built-in series (close) throws — cannot corrupt ctx.close', async () => {
    // `close := 999` used to write straight into ctx.close, silently
    // corrupting every later read. Built-ins are read-only.
    await expect(runScript([reassign('close', num(999))], mkBars(2))).rejects.toThrow(
      /built-in variable 'close'/,
    );
  });

  it(':= on a built-in inside a UDF body still throws (identity survives scope)', async () => {
    const body: Node[] = [
      funcDecl('f', [], [reassign('close', num(999)), num(1)]),
      call(ident('f'), []),
    ];
    await expect(runScript(body, mkBars(2))).rejects.toThrow(/built-in variable 'close'/);
  });

  it(':= on a UDF param bound to close stays mutable (CowSeries, not ctx.close)', async () => {
    // f(close): the param binds a CowSeries around ctx.close — `src := …`
    // must write the private copy, not error and not corrupt ctx.close.
    const body: Node[] = [
      funcDecl('f', ['src'], [
        reassign('src', num(999)),
        ident('src'),
      ]),
      assign('r', call(ident('f'), [{ value: ident('close') }])),
      plot(ident('r'), 'r'),
      plot(ident('close'), 'c'),
    ];
    const res = await runScript(body, mkBars(3));
    const plots = [...res.plots.values()];
    expect(nums(plots[0]!.values)).toEqual([999, 999, 999]);
    expect(nums(plots[1]!.values)).toEqual([1, 2, 3]);
  });

  it(':= self-reference on undeclared name errors (x := x[1]+1)', async () => {
    await expect(
      runScript([reassign('x', bin('+', histref(ident('x'), num(1)), num(1)))], mkBars(3)),
    ).rejects.toThrow(/undeclared/);
  });

  it('var x = 0; x := nz(x[1])+1 accumulates 1,2,3 across bars', async () => {
    // TV: x[1] on bar 0 is na and na+1 propagates na — the counter idiom is nz().
    const body: Node[] = [
      varDecl('x', num(0)),
      reassign('x', bin('+', call(ident('nz'), [{ value: histref(ident('x'), num(1)) }]), num(1))),
      plot(ident('x'), 'x'),
    ];
    const res = await runScript(body, mkBars(4));
    expect(nums(firstPlotValues(res))).toEqual([1, 2, 3, 4]);
  });

  it('x = 0 then x := x+1 (non-var decl) still reassigns', async () => {
    const body: Node[] = [
      assign('x', num(0)),
      reassign('x', bin('+', ident('x'), num(1))),
      plot(ident('x'), 'x'),
    ];
    const res = await runScript(body, mkBars(3));
    // `=` declares the slot; `:=` writes it — non-var x resets to 0 each bar
    // before the := line, so every bar yields 1.
    expect(nums(firstPlotValues(res))).toEqual([1, 1, 1]);
  });

  it('plain assign creates per-bar series', async () => {
    const body: Node[] = [assign('x', ident('close')), plot(histref(ident('x'), num(1)))];
    const res = await runScript(body, mkBars(4));
    expect(nums(firstPlotValues(res))).toEqual(['na', 1, 2, 3]);
  });

  it('var [a,b] = f() binds once and persists; plain tuple resets per bar', async () => {
    // pair() → [close, high] — a fresh array every bar.
    const pair = funcDecl('pair', [], {
      type: 'arraylit', items: [ident('close'), ident('high')],
    });
    const tup = (names: string[], v: Node, isVar: boolean): Node =>
      isVar
        ? { type: 'tuple', names, value: v, var: true }
        : { type: 'tuple', names, value: v };

    // var: pair() runs once at bar 0 (a=close[0], b=high[0]) and
    // never again; a[1] reads the carried bar-0 value on later bars.
    const vr = await runScript([
      pair,
      tup(['a', 'b'], call(ident('pair'), []), true),
      plot(ident('a'), 'a'),
      plot(histref(ident('a'), num(1)), 'a1'),
      plot(ident('b'), 'b'),
    ], mkBars(4));
    const vPlots = [...vr.plots.values()].map(p => nums(p.values));
    expect(vPlots[0]).toEqual([1, 1, 1, 1]);      // a stays bar-0 close
    expect(vPlots[1]).toEqual(['na', 1, 1, 1]);   // a[1] = previous bar's a
    expect(vPlots[2]).toEqual([2, 2, 2, 2]);      // b stays bar-0 high

    // plain tuple: re-evaluated every bar — a tracks close, b tracks high.
    const pr = await runScript([
      pair,
      tup(['a', 'b'], call(ident('pair'), []), false),
      plot(ident('a'), 'a'),
      plot(histref(ident('a'), num(1)), 'a1'),
      plot(ident('b'), 'b'),
    ], mkBars(4));
    const pPlots = [...pr.plots.values()].map(p => nums(p.values));
    expect(pPlots[0]).toEqual([1, 2, 3, 4]);      // a = close per bar
    expect(pPlots[1]).toEqual(['na', 1, 2, 3]);   // a[1] = previous bar's close
    expect(pPlots[2]).toEqual([2, 3, 4, 5]);      // b = high per bar
  });
});

describe('if / ternary / switch', () => {
  it('x = if c … else … returns branch value per bar', async () => {
    const body: Node[] = [
      assign('x', {
        type: 'ifexpr',
        test: bin('>', ident('close'), num(3)),
        then: [num(1)],
        elseIfs: [],
        else: [num(2)],
      } as Node),
      plot(ident('x')),
    ];
    const res = await runScript(body, mkBars(5));
    expect(nums(firstPlotValues(res))).toEqual([2, 2, 2, 1, 1]);
  });

  it('ternary evaluates lazily', async () => {
    // alt branch reassigns undeclared — must NOT be evaluated when cond true.
    const body: Node[] = [
      assign('x', {
        type: 'ternary',
        test: bool(true),
        cons: num(7),
        alt: bin('/', num(1), num(0)),
      } as Node),
      plot(ident('x')),
    ];
    const res = await runScript(body, mkBars(2));
    expect(nums(firstPlotValues(res))).toEqual([7, 7]);
  });

  it('if statement executes taken branch only', async () => {
    const body: Node[] = [
      varDecl('hit', num(0)),
      {
        type: 'if',
        test: bin('>', ident('close'), num(2)),
        then: [reassign('hit', bin('+', ident('hit'), num(1)))],
        elseIfs: [],
        else: null,
      } as Node,
      plot(ident('hit')),
    ];
    const res = await runScript(body, mkBars(5));
    expect(nums(firstPlotValues(res))).toEqual([0, 0, 1, 2, 3]);
  });

  it('switch on subject picks matching arm', async () => {
    const body: Node[] = [
      assign('s', {
        type: 'switch',
        subject: ident('close'),
        cases: [
          { test: num(1), body: [num(100)] },
          { test: num(2), body: [num(200)] },
          { body: [num(300)] },
        ],
      } as Node),
      plot(ident('s')),
    ];
    const res = await runScript(body, mkBars(4));
    expect(nums(firstPlotValues(res))).toEqual([100, 200, 300, 300]);
  });
});

describe('loops', () => {
  it('for i = 0 to 3 accumulates via +=', async () => {
    const body: Node[] = [
      assign('total', num(0)),
      {
        type: 'for',
        varName: 'i',
        from: num(0),
        to: num(3),
        body: [reassign('total', bin('+', ident('total'), ident('i')))],
      } as Node,
      plot(ident('total')),
    ];
    const res = await runScript(body, mkBars(3));
    expect(nums(firstPlotValues(res))).toEqual([6, 6, 6]);
  });

  it('for .. by step and downward ranges', async () => {
    const body: Node[] = [
      assign('total', num(0)),
      {
        type: 'for',
        varName: 'i',
        from: num(3),
        to: num(0),
        body: [reassign('total', bin('+', ident('total'), ident('i')))],
      } as Node,
      plot(ident('total')),
    ];
    const res = await runScript(body, mkBars(2));
    expect(nums(firstPlotValues(res))).toEqual([6, 6]);
  });

  it('break and continue work', async () => {
    const body: Node[] = [
      assign('total', num(0)),
      {
        type: 'for',
        varName: 'i',
        from: num(0),
        to: num(9),
        body: [
          {
            type: 'if',
            test: bin('==', ident('i'), num(2)),
            then: [{ type: 'continue' } as Node],
            elseIfs: [],
            else: null,
          } as Node,
          {
            type: 'if',
            test: bin('>=', ident('i'), num(4)),
            then: [{ type: 'break' } as Node],
            elseIfs: [],
            else: null,
          } as Node,
          reassign('total', bin('+', ident('total'), ident('i'))),
        ],
      } as Node,
      plot(ident('total')),
    ];
    const res = await runScript(body, mkBars(2));
    // i: 0+1 (skip 2) +3 then break at 4 → 4
    expect(nums(firstPlotValues(res))).toEqual([4, 4]);
  });
});

describe('for-in and element writes', () => {
  it('for x in array iterates elements', async () => {
    const body: Node[] = [
      assign('total', num(0)),
      {
        type: 'for',
        varName: 'x',
        from: ident(FOR_IN),
        to: { type: 'arraylit', items: [num(1), num(2), num(3)] },
        body: [reassign('total', bin('+', ident('total'), ident('x')))],
      } as Node,
      plot(ident('total')),
    ];
    const res = await runScript(body, mkBars(2));
    expect(nums(firstPlotValues(res))).toEqual([6, 6]);
  });

  it('a[i] := v writes array elements in place', async () => {
    const body: Node[] = [
      assign('a', { type: 'arraylit', items: [num(1), num(2)] }),
      {
        type: 'reassign',
        target: histref(ident('a'), num(0)),
        value: num(99),
      } as Node,
      assign('x', histref(ident('a'), num(0))), // reads the array itself (series hist), not element
      plot(ident('x')),
    ];
    const res = await runScript(body, mkBars(1));
    const v = firstPlotValues(res)[0];
    expect(v?.kind).toBe('array');
    expect((v as { v: Value[] }).v[0]).toEqual({ kind: 'int', v: 99 });
  });
});

describe('history reference', () => {
  it('close[bar_index] at bar i gives bar-0 close', async () => {
    const body: Node[] = [
      assign('first', histref(ident('close'), ident('bar_index'))),
      plot(ident('first')),
    ];
    const res = await runScript(body, mkBars(5));
    expect(nums(firstPlotValues(res))).toEqual([1, 1, 1, 1, 1]);
  });

  it('expr[n] on call results tracks history', async () => {
    // (close*2)[1] — non-ident obj gets a tracked series.
    const body: Node[] = [
      assign('x', histref(bin('*', ident('close'), num(2)), num(1))),
      plot(ident('x')),
    ];
    const res = await runScript(body, mkBars(4));
    expect(nums(firstPlotValues(res))).toEqual(['na', 2, 4, 6]);
  });
});

describe('UDFs', () => {
  it('f(x) => x + 1 applies per bar', async () => {
    const body: Node[] = [
      funcDecl('f', ['x'], bin('+', ident('x'), num(1))),
      assign('y', call(ident('f'), [{ value: ident('close') }])),
      plot(ident('y')),
    ];
    const res = await runScript(body, mkBars(4));
    expect(nums(firstPlotValues(res))).toEqual([2, 3, 4, 5]);
  });

  it('param aliases caller series — f(x) => x[1] sees history', async () => {
    const body: Node[] = [
      funcDecl('lag', ['x'], histref(ident('x'), num(1))),
      assign('y', call(ident('lag'), [{ value: ident('close') }])),
      plot(ident('y')),
    ];
    const res = await runScript(body, mkBars(4));
    expect(nums(firstPlotValues(res))).toEqual(['na', 1, 2, 3]);
  });

  it('named args bind by name; defaults fill gaps', async () => {
    const body: Node[] = [
      {
        type: 'func',
        name: 'f',
        params: [
          { name: 'a' },
          { name: 'b', default: num(10) },
        ],
        body: bin('+', ident('a'), ident('b')),
      } as Node,
      assign('y', call(ident('f'), [{ name: 'b', value: num(5) }, { value: num(1) }])),
      plot(ident('y')),
      assign('z', call(ident('f'), [{ value: num(2) }])),
      plot(ident('z')),
    ];
    const res = await runScript(body, mkBars(2));
    const vals = [...res.plots.values()].map(p => p.values.map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na')));
    expect(vals[0]).toEqual([6, 6]); // b=5, a=1
    expect(vals[1]).toEqual([12, 12]); // a=2, b=default 10
  });

  it('var inside UDF persists across calls', async () => {
    const body: Node[] = [
      {
        type: 'func',
        name: 'counter',
        params: [],
        body: [
          varDecl('c', num(0)),
          reassign('c', bin('+', ident('c'), num(1))),
          ident('c'),
        ],
      } as Node,
      assign('y', call(ident('counter'), [])),
      plot(ident('y')),
    ];
    const res = await runScript(body, mkBars(4));
    expect(nums(firstPlotValues(res))).toEqual([1, 2, 3, 4]);
  });
});

describe('UDF break/continue escape', () => {
  it('break escaping a UDF body aborts the run, not a silent bar-skip', async () => {
    // QA10/QA11: BREAK used to bubble to the bar loop's warn-and-skip, so
    // the rest of the bar was dropped while stmtMayExitTop still pruned
    // later decls → ta.* ordinal reads silently misaligned. Now a hard error.
    const body: Node[] = [
      funcDecl('f', [], [{ type: 'break' } as Node, num(0)]),
      assign('y', call(ident('f'), [])),
      plot(ident('y'), 'y'),
    ];
    await expect(runScript(body, mkBars(3))).rejects.toThrow(
      /'break' outside loop in function 'f'/,
    );
  });

  it('continue escaping a UDF body aborts the run too', async () => {
    const body: Node[] = [
      funcDecl('g', [], [{ type: 'continue' } as Node, num(0)]),
      assign('y', call(ident('g'), [])),
      plot(ident('y'), 'y'),
    ];
    await expect(runScript(body, mkBars(3))).rejects.toThrow(
      /'continue' outside loop in function 'g'/,
    );
  });

  it('loop-internal break inside a UDF still works', async () => {
    // evalFor absorbs the BREAK inside the UDF's own body — it must not
    // reach callUdfValue's new catch.
    const body: Node[] = [
      funcDecl('f', [], [
        {
          type: 'for',
          varName: 'i',
          from: num(0),
          to: num(10),
          body: [
            {
              type: 'if',
              test: bin('>', ident('i'), num(2)),
              then: [{ type: 'break' } as Node],
              elseIfs: [],
              else: null,
            } as Node,
            ident('i'),
          ],
        } as Node,
      ]),
      assign('y', call(ident('f'), [])),
      plot(ident('y'), 'y'),
    ];
    const res = await runScript(body, mkBars(3));
    // i: 0,1,2 evaluated; break at 3 → last value is 2.
    expect(nums(firstPlotValues(res))).toEqual([2, 2, 2]);
  });

  it('the QA10 divergence: break inside UDF called under `if` now errors', async () => {
    // Original bug: f()'s escaping BREAK skipped the rest of the bar, but
    // the `if` stmt was treated as opaque by stmtMayExitTop → y's slot was
    // pruned → ta.sma read misaligned history. Assert the new error, not
    // the old wrong value.
    const body: Node[] = [
      funcDecl('f', [], [{ type: 'break' } as Node, num(0)]),
      {
        type: 'if',
        test: bool(true),
        then: [call(ident('f'), [])],
        elseIfs: [],
        else: null,
      } as Node,
      assign('y', ident('bar_index')),
      assign('m', nsCall('ta', 'sma', [{ value: ident('y') }, { value: num(2) }])),
      plot(ident('m'), 'm'),
    ];
    await expect(runScript(body, mkBars(3))).rejects.toThrow(/'break' outside loop/);
  });
});

describe('na / operator semantics', () => {
  it('na propagates through arithmetic', async () => {
    const body: Node[] = [
      assign('x', bin('+', naLit, num(1))),
      plot(ident('x')),
    ];
    const res = await runScript(body, mkBars(2));
    expect(nums(firstPlotValues(res))).toEqual(['na', 'na']);
  });

  it('comparisons with na → false (TV v6)', async () => {
    const body: Node[] = [
      assign('ee', bin('==', naLit, naLit)),
      assign('ne', bin('!=', naLit, naLit)),
      assign('lt', bin('<', naLit, num(1))),
      assign('gt', bin('>', num(1), naLit)),
      assign('nv', naLit),
      assign('ve', bin('==', ident('nv'), num(1))),
      assign('r', num(0)),
      { type: 'if', test: ident('ee'), then: [reassign('r', num(1))], elseIfs: [], else: null } as Node,
      plot(ident('ee')),
      plot(ident('ne')),
      plot(ident('lt')),
      plot(ident('gt')),
      plot(ident('ve')),
      plot(ident('r')),
    ];
    const res = await runScript(body, mkBars(2));
    const vals = [...res.plots.values()].map(p => p.values);
    for (const p of vals.slice(0, 5)) {
      expect(p.every(v => v.kind === 'bool' && v.v === false)).toBe(true);
    }
    expect(vals[5]?.every(v => v.kind === 'int' && v.v === 0)).toBe(true);
  });

  it('na in if-cond treated as false (lenient)', async () => {
    const body: Node[] = [
      assign('r', num(0)),
      {
        type: 'if',
        test: histref(ident('close'), num(10)), // na on every 5-bar run
        then: [reassign('r', num(1))],
        elseIfs: [],
        else: [reassign('r', num(2))],
      } as Node,
      plot(ident('r')),
    ];
    const res = await runScript(body, mkBars(5));
    expect(nums(firstPlotValues(res))).toEqual([2, 2, 2, 2, 2]);
  });

  it('int + float → float; int/int → float; /0 → na', async () => {
    const body: Node[] = [
      assign('a', bin('+', { type: 'num', v: 1, isInt: true }, { type: 'num', v: 0.5, isInt: false })),
      assign('b', bin('/', num(7), num(2))),
      assign('c', bin('/', num(1), num(0))),
      plot(ident('a')),
      plot(ident('b')),
      plot(ident('c')),
    ];
    const res = await runScript(body, mkBars(1));
    const kinds = [...res.plots.values()].map(p => p.values[0]);
    expect(kinds[0]).toEqual({ kind: 'float', v: 1.5 });
    expect(kinds[1]).toEqual({ kind: 'float', v: 3.5 });
    expect(kinds[2]?.kind).toBe('na');
  });

  it('and/or/not lenient on na', async () => {
    const body: Node[] = [
      assign('x', bin('and', naLit, bool(true))),
      assign('y', bin('or', naLit, bool(true))),
      assign('z', un('not', naLit)),
      plot(ident('x')),
      plot(ident('y')),
      plot(ident('z')),
    ];
    const res = await runScript(body, mkBars(1));
    const vals = [...res.plots.values()].map(p => p.values[0]);
    expect(vals[0]).toEqual({ kind: 'bool', v: false });
    expect(vals[1]).toEqual({ kind: 'bool', v: true });
    expect(vals[2]).toEqual({ kind: 'bool', v: true });
  });

  it('string concat with +', async () => {
    const body: Node[] = [
      assign('s', bin('+', str('v='), num(42))),
      plot(ident('s')),
    ];
    const res = await runScript(body, mkBars(1));
    expect(firstPlotValues(res)[0]).toEqual({ kind: 'string', v: 'v=42' });
  });
});

describe('decls, inputs, RunResult', () => {
  it('indicator decl → title/overlay/props', async () => {
    const decl = indicatorDecl([
      { value: str('My Title') },
      { name: 'shorttitle', value: str('MT') },
      { name: 'overlay', value: bool(true) },
    ]);
    const res = await runScript({ decl, body: [plot(num(0))] }, mkBars(2));
    expect(res.title).toBe('My Title');
    expect(res.shorttitle).toBe('MT');
    expect(res.overlay).toBe(true);
    expect(res.props.length).toBe(3);
  });

  it('collectInputs finds input.* calls', async () => {
    const body: Node[] = [
      assign('len', nsCall('input', 'int', [
        { value: num(14) },
        { name: 'title', value: str('Length') },
        { name: 'minval', value: num(1) },
      ])),
      assign('src', nsCall('input', 'source', [
        { value: str('close') },
        { name: 'title', value: str('Source') },
      ])),
    ];
    const inputs = collectInputs(body);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ id: 'Length', type: 'int', defval: 14, minval: 1 });
    expect(inputs[1]).toMatchObject({ type: 'source', defval: 'close' });
  });

  it('RunResult.inputs falls back to static collectInputs', async () => {
    const body: Node[] = [
      assign('len', nsCall('input', 'int', [{ value: num(9) }, { value: str('Len') }])),
      plot(ident('len')),
    ];
    const res = await runScript(body, mkBars(2));
    // input builtin may or may not be loaded; either path yields a schema.
    const found = res.inputs.some(i => i.name === 'Len' || i.id === 'Len');
    expect(found).toBe(true);
  });
});

describe('errors', () => {
  it('runtime error carries loc', async () => {
    const bad: Node = {
      type: 'reassign',
      target: ident('ghost'),
      value: num(1),
      loc: { line: 7, col: 3 },
    };
    try {
      await runScript([bad], mkBars(1));
      expect.unreachable('should throw');
    } catch (e) {
      const err = e as { line?: number; col?: number; message: string };
      expect(err.line).toBe(7);
      expect(err.message).toMatch(/ghost/);
    }
  });
});

describe('call args & na receivers', () => {
  const numCol = (values: Value[]): (number | null)[] =>
    values.map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : null));

  it('array values survive the call-arg path (no series wrapper)', async () => {
    const body: Node[] = [
      assign('a', nsCall('array', 'new_float', [{ value: num(3) }, { value: num(7) }])),
      call(ident('plot'), [{ value: call(member(ident('array'), 'size'), [{ value: ident('a') }]) }]),
      call(ident('plot'), [{ value: call(member(ident('array'), 'get'), [{ value: ident('a') }, { value: num(0) }]) }]),
    ];
    const res = await runScript([...body], mkBars(2));
    const series = [...res.plots.values()];
    expect(numCol(series[0]!.values)).toEqual([3, 3]);
    expect(numCol(series[1]!.values)).toEqual([7, 7]);
  });

  it('a method call on an na receiver is a silent no-op', async () => {
    const body: Node[] = [
      assign('l', naLit),
      call(member(ident('l'), 'set_x'), [{ value: num(5) }]),
      call(ident('plot'), [{ value: num(1) }]),
    ];
    const res = await runScript([...body], mkBars(2));
    expect(res.warnings.filter(w => w.includes('no method'))).toEqual([]);
  });
});

describe('review regressions', () => {
  it(':= on a UDF param writes a local copy, not the caller series', async () => {
    const body: Node[] = [
      funcDecl('bump', ['x'], [
        reassign('x', bin('+', ident('x'), num(1000))),
        ident('x'),
      ]),
      assign('bumped', call(ident('bump'), [{ value: ident('close') }])),
      plot(ident('close')),
      plot(ident('bumped')),
    ];
    const res = await runScript(body, mkBars(4));
    const vals = [...res.plots.values()].map(p => nums(p.values));
    expect(vals[0]).toEqual([1, 2, 3, 4]);              // close uncorrupted
    expect(vals[1]).toEqual([1001, 1002, 1003, 1004]);  // local copy got := +1000
  });

  it('param[n] after := reads the copied caller history', async () => {
    const body: Node[] = [
      funcDecl('lag', ['x'], [
        reassign('x', bin('+', ident('x'), num(1000))),
        histref(ident('x'), num(1)),
      ]),
      assign('lagged', call(ident('lag'), [{ value: ident('close') }])),
      plot(ident('lagged')),
    ];
    const res = await runScript(body, mkBars(4));
    // Pine re-binds the param each bar (seeded to the arg's current value),
    // but `:=` writes accumulate — x[1] reads the PREVIOUS bar's bumped value.
    expect(nums(firstPlotValues(res))).toEqual(['na', 1001, 1002, 1003]);
  });

  it(':= on a method param stays local through ctx.callUdf (no-callNode path)', async () => {
    // Method calls dispatch via ctx.callUdf WITHOUT a callNode — the
    // callee's series param must be a copy-on-write wrapper, never the
    // caller UDF's own param CowSeries, or the method's `:=` would
    // write through into the caller's slot.
    const body: Node[] = [
      {
        type: 'typedecl',
        name: 'Pt',
        fields: [{ type: 'field', name: 'x', typeAnn: 'float' }],
      },
      {
        type: 'method',
        selfType: 'Pt',
        name: 'bump',
        params: [
          { name: 'self', typeAnn: 'Pt' },
          { name: 'v' },
        ],
        body: [
          reassign('v', bin('+', ident('v'), num(1000))),
          ident('v'),
        ],
      },
      // outer: invoke the method with its own param, then return the
      // param — the method's `v :=` must not corrupt outer's `x`.
      funcDecl('outer', ['x'], [
        assign('pt', call(member(ident('Pt'), 'new'), [])),
        call(member(ident('pt'), 'bump'), [{ value: ident('x') }]),
        ident('x'),
      ]),
      // outerRet: return the method's result so the := is proven to run.
      funcDecl('outerRet', ['x'], [
        assign('pt2', call(member(ident('Pt'), 'new'), [])),
        call(member(ident('pt2'), 'bump'), [{ value: ident('x') }]),
      ]),
      assign('res', call(ident('outer'), [{ value: ident('close') }])),
      assign('bumped', call(ident('outerRet'), [{ value: ident('close') }])),
      plot(ident('res'), 'res'),
      plot(ident('bumped'), 'bumped'),
    ];
    const res = await runScript(body, mkBars(4));
    const vals = [...res.plots.values()].map(p => nums(p.values));
    expect(vals[0]).toEqual([1, 2, 3, 4]);            // caller param uncorrupted
    expect(vals[1]).toEqual([1001, 1002, 1003, 1004]); // method := did execute
  });

  it('expr[n] inside a UDF tracks history per callsite', async () => {
    const body: Node[] = [
      funcDecl('lag1', ['x'], histref(bin('*', ident('x'), num(2)), num(1))),
      assign('a', call(ident('lag1'), [{ value: ident('close') }])),
      assign('b', call(ident('lag1'), [{ value: ident('high') }])),
      plot(ident('a')),
      plot(ident('b')),
    ];
    const res = await runScript(body, mkBars(4));
    const vals = [...res.plots.values()].map(p => nums(p.values));
    expect(vals[0]).toEqual(['na', 2, 4, 6]);  // close*2 lagged
    expect(vals[1]).toEqual(['na', 4, 6, 8]);  // high*2 lagged — shared key would give close values
  });

  it('% is floor modulo: -7%3=2, 7%-3=-2, 7%2.5=2', async () => {
    const body: Node[] = [
      assign('a', bin('%', { type: 'num', v: -7, isInt: true }, num(3))),
      assign('b', bin('%', num(7), { type: 'num', v: -3, isInt: true })),
      assign('c', bin('%', num(7), { type: 'num', v: 2.5, isInt: false })),
      assign('d', bin('%', num(7), num(2))),
      plot(ident('a')),
      plot(ident('b')),
      plot(ident('c')),
      plot(ident('d')),
    ];
    const res = await runScript(body, mkBars(1));
    const vals = [...res.plots.values()].map(p => p.values[0]);
    expect(vals[0]).toEqual({ kind: 'int', v: 2 });
    expect(vals[1]).toEqual({ kind: 'int', v: -2 });
    expect(vals[2]).toEqual({ kind: 'float', v: 2 });
    expect(vals[3]).toEqual({ kind: 'int', v: 1 });
  });

  it('plot() inside a local scope warns + skips per CE10188', async () => {
    // TV rejects plot() in local scopes (CE10188); we warn-and-skip so the
    // conditional never registers a plot sink.
    const body: Node[] = [
      {
        type: 'if',
        test: bin('>=', ident('close'), num(3)), // true on bars 2..4 only
        then: [plot(ident('close'), 'cond')],
        elseIfs: [],
        else: null,
      } as Node,
    ];
    const res = await runScript(body, mkBars(5));
    expect(res.plots.has('cond')).toBe(false);
    expect(res.warnings.some(w => /local scope/.test(w))).toBe(true);
  });

  it('for [i, v] in array binds index and element', async () => {
    const body: Node[] = [
      assign('a', { type: 'arraylit', items: [num(10), num(20), num(30)] }),
      assign('acc', num(0)),
      {
        type: 'for',
        varName: 'i,v',
        from: ident(FOR_IN),
        to: ident('a'),
        body: [reassign('acc', bin('+', ident('acc'), bin('*', ident('i'), ident('v'))))],
      } as Node,
      plot(ident('acc')),
    ];
    const res = await runScript(body, mkBars(2));
    // 0*10 + 1*20 + 2*30 = 80
    expect(nums(firstPlotValues(res))).toEqual([80, 80]);
  });
});

describe('trackedSlots membership pruning (ensureBar list)', () => {
  /** Unique series the bar-end densify loop touched during one run. */
  async function densified(body: Node[], nBars = 4): Promise<Set<BarSeries>> {
    const seen = new Set<BarSeries>();
    const orig = BarSeries.prototype.ensureBar;
    BarSeries.prototype.ensureBar = function (bar: number) {
      seen.add(this);
      return orig.call(this, bar);
    };
    try {
      await runScript(body, mkBars(nBars));
    } finally {
      BarSeries.prototype.ensureBar = orig;
    }
    return seen;
  }

  it('top-level decl slot is skipped; if-branch and var slots stay', async () => {
    const baseline = await densified([plot(ident('close'), 'c')]);

    // Top-level `x = e` writes its slot every bar → its ensureBar is a
    // guaranteed no-op → slot must NOT join the densify list.
    const top = await densified([
      assign('x', bin('+', ident('close'), num(1))),
      plot(ident('x'), 'x'),
    ]);
    expect(top.size).toBe(baseline.size);

    // An if-branch decl only writes when the arm runs → slot MUST stay
    // registered even when the condition is constant-true (structural gate).
    const cond = await densified([
      {
        type: 'if',
        test: bool(true),
        then: [assign('y', bin('+', ident('close'), num(1)))],
        elseIfs: [],
        else: null,
      } as Node,
      plot(ident('close'), 'c'),
    ]);
    expect(cond.size).toBe(baseline.size + 1);

    // `var` inits once then relies on ensureBar carry-forward → stays.
    const varb = await densified([
      varDecl('v', num(1)),
      plot(ident('v'), 'v'),
    ]);
    expect(varb.size).toBe(baseline.size + 1);
  });

  it('x[1] on a pruned top-level slot still carries forward', async () => {
    const res = await runScript(
      [
        assign('x', bin('+', ident('close'), num(1))),
        assign('prev', histref(ident('x'), num(1))),
        plot(ident('prev'), 'p'),
      ],
      mkBars(4),
    );
    expect(nums(firstPlotValues(res))).toEqual(['na', 2, 3, 4]);
  });

  it('decl after a top-level early-exit stmt stays in ensureList', async () => {
    // `if cond / break` inside the top-level body can skip the remaining
    // stmts on some bars (BREAK/CONTINUE escape evalBlock and land on the
    // 'outside loop' warn). A decl AFTER that point isn't provably written
    // every bar → its slot must keep registering for ensureBar, or history
    // misaligns on skipped bars. Decls BEFORE the exit still prune.
    const baseline = await densified([plot(ident('close'), 'c')]);

    const after = await densified([
      {
        type: 'if',
        test: bin('>', ident('close'), num(1000)), // constant-false is fine:
        then: [{ type: 'break', loc: undefined } as Node], // structural scan
        elseIfs: [],
        else: null,
      } as Node,
      assign('y', bin('+', ident('close'), num(1))),
    ]);
    expect(after.size).toBe(baseline.size + 1); // y's slot registered

    // Same shape but the decl sits BEFORE the early-exit stmt → still pruned.
    const before = await densified([
      assign('y', bin('+', ident('close'), num(1))),
      {
        type: 'if',
        test: bin('>', ident('close'), num(1000)),
        then: [{ type: 'break', loc: undefined } as Node],
        elseIfs: [],
        else: null,
      } as Node,
    ]);
    expect(before.size).toBe(baseline.size);
  });

  it('skipped bars keep history aligned via ensureBar carry-forward', async () => {
    // break fires on bars 1-2 (close 2,3): z is unwritten there. With z
    // registered (decl after the early-exit stmt) ensureBar carries bar0's
    // value forward, so the bar-3 read of z[1] sees the CARRIED bar-2 slot.
    const res = await runScript(
      [
        {
          type: 'if',
          test: bin('and',
            bin('>', ident('close'), num(1)),
            bin('<', ident('close'), num(4))),
          then: [{ type: 'break', loc: undefined } as Node],
          elseIfs: [],
          else: null,
        } as Node,
        assign('z', ident('close')),
        assign('prev', histref(ident('z'), num(1))),
        plot(ident('prev'), 'p'),
      ],
      mkBars(4),
    );
    // z: [1, carried 1, carried 1, 4]; prev=z[1] written only bars 0,3:
    // [na, carried na, carried na, z@2 = 1] → plot emits on bars 0 and 3
    // only: [na, 1]. Without registration z's bar-2 slot is unset → the
    // bar-3 histref read misaligns.
    expect(nums(firstPlotValues(res))).toEqual(['na', 1]);
  });

  it('top-level decl + conditional := keeps write semantics', async () => {
    const res = await runScript(
      [
        assign('x', num(0)),
        {
          type: 'if',
          test: bin('>=', ident('close'), num(3)),
          then: [reassign('x', bin('+', ident('x'), num(10)))],
          elseIfs: [],
          else: null,
        } as Node,
        plot(ident('x'), 'x'),
      ],
      mkBars(4),
    );
    expect(nums(firstPlotValues(res))).toEqual([0, 0, 10, 10]);
  });
  it('scanner sees breaks inside non-type wrapper objects (elseIfs, call args)', async () => {
    // elseIfs entries are {test, body} objects with no `type` field — the
    // scanner must recurse INTO the wrapper so this break still marks the
    // stmt as a possible early exit. Conditions are constant-false so the
    // break is structural-only and never fires at runtime (mirroring the
    // `close > 1000` pattern above).
    const baseline = await densified([plot(ident('close'), 'c')]);

    const elseIf = await densified([
      {
        type: 'if',
        test: bin('>', ident('close'), num(1000)),
        then: [num(0)],
        elseIfs: [
          { test: bool(false), body: [{ type: 'break', loc: undefined } as Node] },
        ],
        else: null,
      } as Node,
      assign('y', bin('+', ident('close'), num(1))),
    ]);
    expect(elseIf.size).toBe(baseline.size + 1); // y stays registered

    // Same wrapper hole one level deeper: an ifexpr with a break buried
    // inside a call arg ({name?, value} — also no `type` field). evalArg
    // wraps non-ident scalar args in a tracked BarSeries, so compare
    // against a break-free control run: the only difference should be
    // y's slot staying registered.
    const ifexpr = (withBreak: boolean): Node => ({
      type: 'ifexpr',
      test: bin('>', ident('close'), num(1000)),
      then: [num(0)],
      elseIfs: [
        {
          test: bool(false),
          body: withBreak ? [{ type: 'break', loc: undefined } as Node] : [num(0)],
        },
      ],
      else: [num(1)],
    }) as Node;
    const noBreak = await densified([
      nsCall('math', 'abs', [{ value: ifexpr(false) }]),
      assign('y', bin('+', ident('close'), num(1))),
    ]);
    const callArg = await densified([
      nsCall('math', 'abs', [{ value: ifexpr(true) }]),
      assign('y', bin('+', ident('close'), num(1))),
    ]);
    expect(callArg.size).toBe(noBreak.size + 1); // y stays registered
  });

  it('loop absorbs a break in its body; switch default arm does not', async () => {
    const baseline = await densified([plot(ident('close'), 'c')]);

    // for-bodies absorb break/continue → a decl after the loop still
    // prunes (pins the no-false-positive direction).
    const looped = await densified([
      {
        type: 'for',
        varName: 'i',
        from: num(0),
        to: num(10),
        body: [{
          type: 'if',
          test: bool(true),
          then: [{ type: 'break', loc: undefined } as Node],
          elseIfs: [],
          else: null,
        } as Node],
      } as Node,
      assign('y', bin('+', ident('close'), num(1))),
    ]);
    expect(looped.size).toBe(baseline.size); // y pruned

    // evalSwitch only catches BREAK around MATCHED arms (c.test set) —
    // a break in the default arm escapes the switch, so a decl after it
    // must keep registering. Matched arm `1` fires on bar 0 (close=1) so
    // y evaluates at least once and registers; the default arm runs the
    // remaining bars.
    const matched = await densified([
      {
        type: 'switch',
        subject: ident('close'),
        cases: [
          { test: num(1), body: [{ type: 'break', loc: undefined } as Node] },
          { body: [num(0)] },
        ],
      } as Node,
      assign('y', bin('+', ident('close'), num(1))),
    ]);
    const dflt = await densified([
      {
        type: 'switch',
        subject: ident('close'),
        cases: [
          { test: num(1), body: [num(0)] },
          { body: [{ type: 'break', loc: undefined } as Node] },
        ],
      } as Node,
      assign('y', bin('+', ident('close'), num(1))),
    ]);
    expect(dflt.size).toBe(matched.size + 1); // y registered only for default
  });

});

// ── evalArg literal fast-path (Slice C-2) ─────────────────────────────────────
// Literal num/bool args in *builtin* calls skip the callHist BarSeries wrap;
// UDF args keep it so `x[1]` inside a UDF body reads seeded param history.

describe('evalArg literal fast-path', () => {
  it('literal scalar arg bypasses callHist in builtin args', async () => {
    const writes0 = __callHistWrites;
    const r = await runScript(
      parse('indicator("t")\nx = ta.sma(close, 20)\nplot(x)'),
      mkBars(10),
      { symbol: 'X', timeframe: '1' },
    );
    expect(r.warnings).toHaveLength(0);
    // `close` is an ident→series (no wrap write); `20` literal must skip callHist.
    expect(__callHistWrites - writes0).toBe(0);
  });

  it('UDF literal arg keeps history — f(20) with x[1] unchanged', async () => {
    // HEAD baseline (scratch/_udf_pin.mjs): [na, 40, 40] — bar0 x[1] is na,
    // bars 1-2 read the seeded callHist BarSeries (20) → x[1]+x = 40.
    const r = await runScript(
      parse('indicator("t")\nf(x) => x[1] + x\nplot(f(20))'),
      mkBars(3),
      { symbol: 'X', timeframe: '1' },
    );
    expect(r.warnings).toHaveLength(0);
    expect(nums(firstPlotValues(r))).toEqual(['na', 40, 40]);
  });
});

// ── Slice C-3: siteKey trie + dispatch WeakMap ────────────────────────────────
// Regression guards for the dispatch refactor: callsite-keyed state must stay
// isolated across UDF callsites (trie composes without join), `ns.fn` builtins
// keep working through the WeakMap memo, and a user-declared `type`/`method`
// still outranks a builtin on a UDT receiver.

describe('Slice C-3 dispatch + siteKey trie', () => {
  it('siteKey: nested UDF callsite composes without string join', async () => {
    // A UDF called from two sites must produce distinct `var` slots.
    const r = await runScript(
      parse('indicator("t")\nf() =>\n  var x = 0\n  x := x + 1\n  x\na = f()\nb = f()\nplot(a + b)'),
      mkBars(3),
      { symbol: 'X', timeframe: '1' },
    );
    expect(r.warnings).toHaveLength(0);
    // a ends at 3, b ends at 3 → a+b at bar 2 = 6 (shared slot would give 6,9,…).
    expect(nums(firstPlotValues(r))).toEqual([2, 4, 6]);
  });

  it('ns.fn builtin still dispatches through the memoized path', async () => {
    const r = await runScript(
      parse('indicator("t")\nx = ta.sma(close, 2)\nplot(x)'),
      mkBars(4),
      { symbol: 'X', timeframe: '1' },
    );
    expect(r.warnings).toHaveLength(0);
    // sma(close,2): [na,(1+2)/2,(2+3)/2,(3+4)/2] = [na,1.5,2.5,3.5]
    expect(nums(firstPlotValues(r))).toEqual(['na', 1.5, 2.5, 3.5]);
  });

  it('UDT method beats builtin on a user type; builtin still works on real kinds', async () => {
    const r = await runScript(
      parse(
        'indicator("t")\n' +
        'type Foo\n    int v\n' +
        'method get(Foo self) => self.v * 10\n' +
        'f = Foo.new(7)\n' +
        'arr = array.new<int>(3, 5)\n' +
        'plot(f.get())\n' +
        'plot(array.get(arr, 0))',
      ),
      mkBars(2),
      { symbol: 'X', timeframe: '1' },
    );
    expect(r.warnings).toHaveLength(0);
    const vals = [...r.plots.values()].map(p => nums(p.values));
    expect(vals[0]).toEqual([70, 70]);  // UDT method ran, not a builtin
    expect(vals[1]).toEqual([5, 5]);    // array.get builtin via kindBuiltin
  });
});
