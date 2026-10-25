import { describe, it, expect } from 'vitest';
import { parse } from '../parser';
import type {
  Node, Assign, Reassign, SwitchStmt, IfStmt, Binary, Ident, NumLit,
} from '../contracts';

const one = (src: string) => {
  const b = parse(src).body;
  expect(b).toHaveLength(1);
  return b[0]!;
};

/** `x = switch …` → the SwitchStmt bound to `x`. */
const switchOf = (src: string) => {
  const a = one(src) as Assign;
  expect(a.type).toBe('assign');
  expect(a.value.type).toBe('switch');
  return a.value as SwitchStmt;
};

describe('switch arm compound assignment', () => {
  it('inline arm value may be `+=`', () => {
    const sw = switchOf('x = switch\n    close > open => posVol += volume');
    const body = sw.cases[0]!.body;
    expect(body).toHaveLength(1);
    const r = body[0] as Reassign;
    expect(r.type).toBe('reassign');
    expect(r.target).toMatchObject({ type: 'ident', name: 'posVol' });
    expect((r.value as Binary).op).toBe('+');
    expect((r.value as Binary).left).toMatchObject({ name: 'posVol' });
    expect((r.value as Binary).right).toMatchObject({ name: 'volume' });
  });

  it('inline arm value may be `-=` / `*=` / `/=` / `%=`', () => {
    for (const [srcOp, op] of [['-', '-'], ['*', '*'], ['/', '/'], ['%', '%']] as const) {
      const sw = switchOf(`x = switch\n    true => posVol ${srcOp}= volume`);
      const r = sw.cases[0]!.body[0] as Reassign;
      expect(r.type).toBe('reassign');
      expect(r.target).toMatchObject({ type: 'ident', name: 'posVol' });
      expect((r.value as Binary).op).toBe(op);
    }
  });

  it('plain inline arm value still parses', () => {
    const sw = switchOf('x = switch\n    c > 0 => 1\n    => 0');
    expect(sw.cases[0]!.body[0]).toMatchObject({ type: 'num', v: 1 });
    expect(sw.cases[1]!.body[0]).toMatchObject({ type: 'num', v: 0 });
    expect(sw.cases[1]!.test).toBeUndefined();
  });

  it('`if` block compound assignment unchanged', () => {
    const s = one('if c\n    x += 1') as IfStmt;
    expect(s.type).toBe('if');
    const r = s.then[0] as Reassign;
    expect(r.type).toBe('reassign');
    expect((r.value as Binary).op).toBe('+');
    expect((r.value as Binary).right as NumLit).toMatchObject({ v: 1 });
    expect((r.target as Ident).name).toBe('x');
  });

  it('multi-branch switch block containing `+=` parses as a statement', () => {
    const nodes = parse(
      'posVol = 0.0\n' +
      'switch\n' +
      '    close > open  => posVol += volume\n' +
      '    close < open  => posVol -= volume\n' +
      '    => posVol := 0.0\n').body;
    expect(nodes).toHaveLength(2);
    const sw = nodes[1] as SwitchStmt;
    expect(sw.type).toBe('switch');
    expect(sw.cases).toHaveLength(3);
    expect(sw.cases[0]!.body[0]!.type).toBe('reassign');
    expect(sw.cases[1]!.body[0]!.type).toBe('reassign');
    expect(sw.cases[2]!.body[0]!.type).toBe('reassign');
    expect(sw.cases.map(c => c.test?.type)).toEqual(['binary', 'binary', undefined] as (Node['type'] | undefined)[]);
  });
});
