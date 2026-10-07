import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, FOR_IN } from '../parser';
import type {
  Node, Assign, VarDecl, TypedDecl, FuncDecl, MethodDecl, TypeDecl,
  IfStmt, IfExpr, ForStmt, WhileStmt, SwitchStmt, Call, Member, HistRef,
  Binary, Ternary, TupleAssign, ArrowFunc, ImportDecl,
  IndicatorDecl, StrategyDecl, LetDecl, ConstDecl, Reassign, ArrayLit,
  NumLit, StrLit, ColorLit,
} from '../contracts';

const body = (src: string) => parse(src).body;
const one = (src: string) => {
  const b = body(src);
  expect(b).toHaveLength(1);
  return b[0];
};

describe('script declarations', () => {
  it('parses //@version pragma + indicator(...) decl', () => {
    const { decl, body } = parse(
      '//@version=6\nindicator("x", overlay=true)\nplot(close)\n');
    expect(decl?.type).toBe('indicator');
    const d = decl as IndicatorDecl;
    expect(d.args[0].value).toMatchObject({ type: 'str', v: 'x' });
    expect(d.args[1]).toMatchObject({
      name: 'overlay', value: { type: 'bool', v: true },
    });
    expect(body).toHaveLength(1);
    expect((body[0] as Call).type).toBe('call');
  });

  it('// @version=6 comment form is skipped too', () => {
    const { decl } = parse('// @version=6\nindicator("x")\n');
    expect(decl?.type).toBe('indicator');
  });

  it('parses strategy(...) decl', () => {
    const { decl } = parse('strategy("s", overlay=false, initial_capital=1000)\n');
    expect(decl?.type).toBe('strategy');
    expect((decl as StrategyDecl).args).toHaveLength(3);
    expect((decl as StrategyDecl).args[2]).toMatchObject({
      name: 'initial_capital', value: { type: 'num', v: 1000 },
    });
  });

  it('strategy.entry() at stmt level parses as a call, not decl', () => {
    const s = one('strategy.entry("L", strategy.long, qty=1)');
    expect(s.type).toBe('call');
    const callee = (s as Call).callee as Member;
    expect(callee).toMatchObject({ type: 'member', prop: 'entry' });
    expect(callee.obj).toMatchObject({ type: 'ident', name: 'strategy' });
    expect((s as Call).args[2].name).toBe('qty');
  });
});

describe('declarations', () => {
  it('x = e → Assign', () => {
    const s = one('x = close * 2') as Assign;
    expect(s.type).toBe('assign');
    expect(s.name).toBe('x');
    expect(s.value).toMatchObject({ type: 'binary', op: '*' });
  });

  it('int x = 1 → TypedDecl', () => {
    const s = one('int x = 1') as TypedDecl;
    expect(s).toMatchObject({ type: 'typed', ann: 'int', name: 'x' });
    expect(s.value).toMatchObject({ type: 'num', v: 1, isInt: true });
  });

  it('var x = e → VarDecl', () => {
    const s = one('var x = close') as VarDecl;
    expect(s).toMatchObject({ type: 'var', name: 'x' });
  });

  it('var float pA = na, var float pB = na → VarDecl.multi', () => {
    const s = one('var float pA = na, var float pB = na') as VarDecl;
    expect(s.type).toBe('var');
    expect(s.name).toBe('pA');
    expect(s.typeAnn).toBe('float');
    expect(s.value).toMatchObject({ type: 'na' });
    expect(s.multi).toHaveLength(2);
    expect(s.multi![1]).toMatchObject({ name: 'pB', typeAnn: 'float' });
  });

  it('var array<float> a = array.new(0) → VarDecl typed', () => {
    const s = one('var array<float> a = array.new<float>(0)') as VarDecl;
    expect(s.type).toBe('var');
    expect(s.typeAnn).toBe('array<float>');
    expect(s.name).toBe('a');
    // callee survives the <float> type-arg form
    const call = s.value as Call;
    expect(call.type).toBe('call');
    expect((call.callee as Member).prop).toBe('new');
  });

  it('var DrawManager dm = DrawManager.new()', () => {
    const s = one('var DrawManager dm = DrawManager.new()') as VarDecl;
    expect(s.typeAnn).toBe('DrawManager');
    expect(s.name).toBe('dm');
  });

  it('let / const decls', () => {
    const l = one('let x = 1') as LetDecl;
    expect(l).toMatchObject({ type: 'let', name: 'x' });
    const c = one('const float PI2 = 6.28') as ConstDecl;
    expect(c).toMatchObject({ type: 'const', name: 'PI2', typeAnn: 'float' });
  });

  it('x := e → Reassign; a.b := e → Reassign on member', () => {
    const r = one('x := x + 1') as Reassign;
    expect(r.type).toBe('reassign');
    expect(r.target).toMatchObject({ type: 'ident', name: 'x' });
    const m = one('ob.y := 5') as Reassign;
    expect(m.target).toMatchObject({ type: 'member', prop: 'y' });
  });

  it('[a, b] = f() → TupleAssign', () => {
    const s = one('[m, s] = ta.macd(close, 12, 26, 9)') as TupleAssign;
    expect(s.type).toBe('tuple');
    expect(s.names).toEqual(['m', 's']);
    expect(s.value).toMatchObject({ type: 'call' });
  });

  it('varip int cnt = 0 → VarDecl flagged varip (runtime warn is interp-side)', () => {
    const s = one('varip int cnt = 0') as VarDecl;
    expect(s.type).toBe('var');
    expect(s.varip).toBe(true);
    expect(s.name).toBe('cnt');
    expect(s.typeAnn).toBe('int');
  });

  it('export type → flattened top-level TypeDecl carrying export flag', () => {
    const s = one('export type Foo\n    int x\n    float y') as TypeDecl;
    expect(s.type).toBe('typedecl');
    expect(s.name).toBe('Foo');
    expect(s.export).toBe(true);
    expect(s.fields.map(f => f.name)).toEqual(['x', 'y']);
  });

  it('export method/func flatten too — pre-registration sees the inner type', () => {
    const m = one('export method m(Foo f) => f.x') as MethodDecl;
    expect(m.type).toBe('method');
    expect(m.export).toBe(true);
  });

});


describe('functions / methods / types', () => {
  it('f(a, b) => expr → FuncDecl', () => {
    const s = one('f(a, b) => a + b') as FuncDecl;
    expect(s.type).toBe('func');
    expect(s.name).toBe('f');
    expect(s.params.map(p => p.name)).toEqual(['a', 'b']);
    expect(s.body).toMatchObject({ type: 'binary', op: '+' });
  });

  it('f() => block body → FuncDecl with Node[]', () => {
    const s = one('f(x) =>\n    a = x + 1\n    a * 2') as FuncDecl;
    expect(Array.isArray(s.body)).toBe(true);
    expect(s.body as Node[]).toHaveLength(2);
  });

  it('params carry type anns + defaults', () => {
    const s = one('g(float src, int len = 14) => src') as FuncDecl;
    expect(s.params[0]).toMatchObject({ name: 'src', typeAnn: 'float' });
    expect(s.params[1].name).toBe('len');
    expect(s.params[1].typeAnn).toBe('int');
    expect(s.params[1].default).toMatchObject({ type: 'num', v: 14 });
  });

  it('method m(T self, x) → MethodDecl, self preserved in params[0]', () => {
    const src = 'type T\n    int v\nmethod add(T s, int n) => s.v + n';
    const b = body(src);
    const m = b[1] as MethodDecl;
    expect(m.type).toBe('method');
    expect(m.name).toBe('add');
    expect(m.selfType).toBe('T');
    expect(m.params[0]).toMatchObject({ name: 's', typeAnn: 'T' });
    expect(m.params[1]).toMatchObject({ name: 'n', typeAnn: 'int' });
  });

  it('type X + indented field lines → TypeDecl', () => {
    const s = one('type Point\n    float x\n    float y = 0.0\n    string tag') as TypeDecl;
    expect(s.type).toBe('typedecl');
    expect(s.name).toBe('Point');
    expect(s.fields.map(f => [f.name, f.typeAnn])).toEqual([
      ['x', 'float'], ['y', 'float'], ['tag', 'string'],
    ]);
    expect(s.fields[1].default).toMatchObject({ type: 'num', v: 0 });
  });
});

describe('control flow', () => {
  it('if/else if/else stmt', () => {
    const s = one(
      'if a > b\n' +
      '    x := 1\n' +
      'else if a < b\n' +
      '    x := 2\n' +
      'else\n' +
      '    x := 3') as IfStmt;
    expect(s.type).toBe('if');
    expect(s.then).toHaveLength(1);
    expect(s.elseIfs).toHaveLength(1);
    expect(s.elseIfs[0].body).toHaveLength(1);
    expect(s.else).toHaveLength(1);
  });

  it('x = if cond ... → IfExpr', () => {
    const s = one('x = if a\n    1\nelse\n    2') as Assign;
    expect(s.type).toBe('assign');
    const ie = s.value as IfExpr;
    expect(ie.type).toBe('ifexpr');
    expect(ie.then).toHaveLength(1);
    expect(ie.else).toHaveLength(1);
  });

  it('for i = a to b by s', () => {
    const s = one('for i = 0 to 10 by 2\n    x := i') as ForStmt;
    expect(s.type).toBe('for');
    expect(s.varName).toBe('i');
    expect(s.step).toMatchObject({ type: 'num', v: 2 });
    expect(s.body).toHaveLength(1);
  });

  it('for x in arr → ForStmt with FOR_IN marker', () => {
    const s = one('for x in arr\n    y := x') as ForStmt;
    expect(s.type).toBe('for');
    expect(s.varName).toBe('x');
    expect(s.from).toMatchObject({ type: 'ident', name: FOR_IN });
    expect(s.to).toMatchObject({ type: 'ident', name: 'arr' });
  });

  it('while loop', () => {
    const s = one('while i < 10\n    i := i + 1') as WhileStmt;
    expect(s.type).toBe('while');
    expect(s.test).toMatchObject({ type: 'binary', op: '<' });
  });

  it('switch with subject', () => {
    const s = one(
      'x = switch tf\n' +
      '    "D" => 1\n' +
      '    "W" => 7\n' +
      '    => 0') as Assign;
    const sw = s.value as SwitchStmt;
    expect(sw.type).toBe('switch');
    expect(sw.subject).toMatchObject({ type: 'ident', name: 'tf' });
    expect(sw.cases).toHaveLength(3);
    expect(sw.cases[0].test).toMatchObject({ type: 'str', v: 'D' });
    expect(sw.cases[2].test).toBeUndefined();
  });

  it('bare-condition switch', () => {
    const s = one(
      'switch\n' +
      '    a > b => 1\n' +
      '    a < b => -1\n' +
      '    => 0') as SwitchStmt;
    expect(s.type).toBe('switch');
    expect(s.subject).toBeUndefined();
    expect(s.cases[0].test).toMatchObject({ type: 'binary', op: '>' });
  });

  it('break / continue inside loop', () => {
    const s = one(
      'for i = 0 to 9\n    if i > 5\n        break\n    continue') as ForStmt;
    const inner = s.body[0] as IfStmt;
    expect(inner.then[0].type).toBe('break');
    expect(s.body[1].type).toBe('continue');
  });
  it('switch arm body can be an array literal', () => {
    const s = one(
      'x = switch c\n    true => f(1)\n    false => [na, int(na)]') as Assign;
    const sw = s.value as SwitchStmt;
    expect(sw.cases[1].body[0].type).toBe('arraylit');
  });

  it('compound assign += desugars to reassign', () => {
    const s = one('x += 1') as Reassign;
    expect(s.type).toBe('reassign');
    expect(s.target).toMatchObject({ type: 'ident', name: 'x' });
    expect(s.value).toMatchObject({ type: 'binary', op: '+' });
  });

  it('comma-separated statements on one line', () => {
    const b = body('x := 1, y := 2');
    expect(b).toHaveLength(2);
    expect(b[0].type).toBe('reassign');
    expect(b[1].type).toBe('reassign');
  });

  it('deeper-indented line starting with `and` continues the expression', () => {
    const b = body('bool d = a and b\n     and c > e\nnext = 1');
    expect(b).toHaveLength(2);
    const td = b[0] as TypedDecl;
    expect(td.type).toBe('typed');
    // `and` chain folded into one value expression
    expect((td.value as Binary).op).toBe('and');
  });

  it('bare [a, b, c] statement is an ArrayLit (UDF last value)', () => {
    const f = one('f(x) =>\n    y = x + 1\n    [y, x]') as FuncDecl;
    const b = f.body as Node[];
    expect(b[1].type).toBe('arraylit');
  });

  it('keyword used as identifier: f(cond, indicator)', () => {
    const f = one('f(cond, indicator) => cond and indicator') as FuncDecl;
    expect(f.params.map(p => p.name)).toEqual(['cond', 'indicator']);
  });

});

describe('expressions', () => {
  it('precedence: 1 + 2 * 3 → 1 + (2*3)', () => {
    const s = one('x = 1 + 2 * 3') as Assign;
    const b = s.value as Binary;
    expect(b.op).toBe('+');
    expect((b.right as Binary).op).toBe('*');
  });

  it('and/or/not', () => {
    const s = one('x = not a and b or c') as Assign;
    const or = s.value as Binary;
    expect(or.op).toBe('or');
    const and = or.left as Binary;
    expect(and.op).toBe('and');
    expect(and.left).toMatchObject({ type: 'unary', op: 'not' });
  });

  it('ternary chains nest right', () => {
    const s = one('x = a ? 1 : b ? 2 : 3') as Assign;
    const t = s.value as Ternary;
    expect(t.type).toBe('ternary');
    expect((t.alt as Ternary).type).toBe('ternary');
    expect(((t.alt as Ternary).alt as NumLit).v).toBe(3);
  });

  it('expr[n] histref incl. dynamic index', () => {
    const s = one('x = close[1] + open[n]') as Assign;
    const add = s.value as Binary;
    const h = add.left as HistRef;
    expect(h.type).toBe('histref');
    expect(h.obj).toMatchObject({ type: 'ident', name: 'close' });
    expect(h.idx).toMatchObject({ type: 'num', v: 1 });
  });

  it('histref index may be any expr: a[na], a[true], a[not x], a["k"], a[b+c]', () => {
    const cases: [string, object][] = [
      ['x = a[na]', { type: 'na' }],
      ['x = a[true]', { type: 'bool', v: true }],
      ['x = a[not x]', { type: 'unary', op: 'not' }],
      ['x = a["k"]', { type: 'str', v: 'k' }],
      ['x = a[1 + 2]', { type: 'binary', op: '+' }],
      ['x = a[f(1)]', { type: 'call' }],
    ];
    for (const [src, idx] of cases) {
      const s = one(src) as Assign;
      const h = s.value as HistRef;
      expect(h.type, src).toBe('histref');
      expect(h.obj).toMatchObject({ type: 'ident', name: 'a' });
      expect(h.idx, src).toMatchObject(idx);
    }
  });

  it('a[1, 2] still parses as ident + stray arraylit stmt (comma → not histref)', () => {
    const b = body('a[1, 2]');
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ type: 'ident', name: 'a' });
    expect(b[1].type).toBe('arraylit');
  });


  it('member chains a.b.c.d', () => {
    const s = one('x = a.b.c.d') as Assign;
    let m = s.value as Member;
    expect(m.prop).toBe('d');
    m = m.obj as Member;
    expect(m.prop).toBe('c');
  });

  it('keyword member: color.orange / format.price / strategy.long', () => {
    for (const src of ['x = color.orange', 'x = format.price', 'x = strategy.long']) {
      const s = one(src) as Assign;
      expect(s.value).toMatchObject({ type: 'member' });
    }
  });

  it('named + positional call args', () => {
    const s = one('plot(close, "C", color=color.red, linewidth=2)') as Call;
    expect(s.args).toHaveLength(4);
    expect(s.args[2]).toMatchObject({ name: 'color' });
    expect((s.args[2].value as Member).prop).toBe('red');
    expect(s.args[3].name).toBe('linewidth');
  });

  it('multi-line call args parse to one Call', () => {
    const s = one('line.new(\n    x1=1,\n    y1=2,\n    color=color.blue)') as Call;
    expect(s.type).toBe('call');
    expect(s.args.map(a => a.name)).toEqual(['x1', 'y1', 'color']);
  });

  it('array literal + arrow fn arg', () => {
    const a = one('x = [1, 2, 3]') as Assign;
    expect((a.value as ArrayLit).items).toHaveLength(3);
    const c = one('a.map(a, (v) => v * 2)') as Call;
    const arrow = c.args[1].value as ArrowFunc;
    expect(arrow.type).toBe('arrow');
    expect(arrow.params[0].name).toBe('v');
  });

  it('import / export', () => {
    const i = one('import user/lib/2 as lb') as ImportDecl;
    expect(i.type).toBe('import');
    expect(i.ns).toBe('user/lib/2');
    expect(i.name).toBe('lib');
    expect(i.alias).toBe('lb');
    const e = one('export twice(float x) => x * 2') as FuncDecl;
    expect(e.type).toBe('func');
    expect(e.name).toBe('twice');
    expect(e.export).toBe(true);
  });

  it('literals: float vs int, strings, bool, na, color', () => {
    const s = one('x = 2.5') as Assign;
    expect(s.value).toMatchObject({ type: 'num', v: 2.5, isInt: false });
    const q = one("s = 'hi\\n'") as Assign;
    expect((q.value as StrLit).v).toBe('hi\n');
    const c = one('c = #FF5252') as Assign;
    expect((c.value as ColorLit).v).toBe('#ff5252');
  });
});

describe('real script', () => {
  it('parses first 60 lines of MACD701.TXT without error', () => {
    const src = readFileSync('C:/Users/bear9/high452/MACD701.TXT', 'utf8')
      .split('\n')
      .slice(0, 60)
      .join('\n');
    const { decl, body } = parse(src);
    expect(decl?.type).toBe('indicator');
    expect(body.length).toBeGreaterThan(10);
  });

  it('ema-sample.pine parses', () => {
    const src = readFileSync('src/pine/ema-sample.pine', 'utf8');
    const { decl, body } = parse(src);
    expect(decl?.type).toBe('indicator');
    expect(body).toHaveLength(1);
  });
});
