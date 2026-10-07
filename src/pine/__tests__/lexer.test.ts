import { describe, expect, it } from 'vitest';
import { LexError, tokenize } from '../lexer';
import type { Token } from '../tokens';

const kinds = (src: string): string[] => tokenize(src).map((t) => t.type);
const vals = (src: string): string[] => tokenize(src).map((t) => t.v);
const ops = (src: string): string[] =>
  tokenize(src).filter((t) => t.type === 'op').map((t) => t.v);

describe('tokenize — basic expression', () => {
  it('x = ta.sma(close, 5)', () => {
    const t = tokenize('x = ta.sma(close, 5)');
    expect(t.map((k) => k.type)).toEqual([
      'ident', 'op', 'ident', 'op', 'ident', 'op', 'ident', 'op', 'num', 'op',
      'newline', 'eof',
    ]);
    expect(t.map((k) => k.v)).toEqual([
      'x', '=', 'ta', '.', 'sma', '(', 'close', ',', '5', ')', '', '',
    ]);
    expect(t[8]?.isInt).toBe(true);
  });

  it('numbers: int vs float vs exponent vs leading dot', () => {
    const t = tokenize('a=1 b=1.5 c=.5 d=1e3 e=1.');
    const nums = t.filter((k) => k.type === 'num');
    expect(nums.map((k) => k.v)).toEqual(['1', '1.5', '.5', '1e3', '1.']);
    expect(nums.map((k) => k.isInt)).toEqual([true, false, false, false, false]);
  });

  it('operators: two-char lexed before single', () => {
    expect(ops('a==b')).toEqual(['==']);
    expect(ops('a!=b')).toEqual(['!=']);
    expect(ops('a<=b')).toEqual(['<=']);
    expect(ops('a>=b')).toEqual(['>=']);
    expect(ops('a:=b')).toEqual([':=']);
    expect(ops('x=>y')).toEqual(['=>']);
    expect(ops('a=b')).toEqual(['=']);
    expect(ops('a?b:c')).toEqual(['?', ':']);
    expect(ops('a[1]')).toEqual(['[', ']']);
    expect(ops('not a')).toEqual([]); // 'not' is a keyword
  });
});

describe('tokenize — literals', () => {
  it('strings: double quotes with escapes', () => {
    const t = tokenize('s = "a\\nb\\"c\\\\"');
    expect(t[2]).toMatchObject({ type: 'str', v: 'a\nb"c\\' });
  });

  it('strings: single quotes', () => {
    const t = tokenize("s = 'it\\'s'");
    expect(t[2]).toMatchObject({ type: 'str', v: "it's" });
  });

  it('unknown escape keeps backslash verbatim', () => {
    const t = tokenize('s = "a\\pb"');
    expect(t[2]).toMatchObject({ type: 'str', v: 'a\\pb' });
  });

  it('unterminated string throws', () => {
    expect(() => tokenize('s = "abc')).toThrow(LexError);
  });

  it('color literal #FF5252', () => {
    const t = tokenize('c = #FF5252');
    expect(t[2]).toMatchObject({ type: 'color', v: '#ff5252' });
  });

  it('color literal #FF525280 (alpha)', () => {
    const t = tokenize('c=#FF525280');
    expect(t[2]).toMatchObject({ type: 'color', v: '#ff525280' });
  });

  it('bad color length throws', () => {
    expect(() => tokenize('c = #FF525')).toThrow(LexError);
  });

  it('bool and na literals', () => {
    const t = tokenize('a = true\nb = false\nc = na');
    expect(t[2]).toMatchObject({ type: 'bool', v: 'true' });
    expect(t[6]).toMatchObject({ type: 'bool', v: 'false' });
    expect(t[10]).toMatchObject({ type: 'na' });
  });
});

describe('tokenize — keywords & idents', () => {
  it('reserved words are keyword tokens', () => {
    const src = 'var let const if else for to by while switch break continue and or not import export type method indicator strategy in';
    expect(kinds(src).slice(0, -2).every((k) => k === 'keyword')).toBe(true);
  });

  it('user idents stay ident', () => {
    expect(kinds('my_var x1 _ok')).toEqual(['ident', 'ident', 'ident', 'newline', 'eof']);
    expect(vals('my_var x1 _ok').slice(0, 3)).toEqual(['my_var', 'x1', '_ok']);
  });
});

describe('tokenize — comments', () => {
  it('comment-only line emits nothing', () => {
    expect(kinds('// hello\nx=1')).toEqual(['ident', 'op', 'num', 'newline', 'eof']);
  });

  it('//@version directive skipped', () => {
    expect(kinds('//@version=6\nindicator("x")')).toEqual([
      'keyword', 'op', 'str', 'op', 'newline', 'eof',
    ]);
  });

  it('trailing comment after code', () => {
    expect(kinds('x = 1 // tail')).toEqual(['ident', 'op', 'num', 'newline', 'eof']);
  });
});

describe('tokenize — indentation', () => {
  it('if block emits INDENT/DEDENT', () => {
    const t = tokenize('if x\n    y = 1\nz = 2');
    expect(t.map((k) => k.type)).toEqual([
      'keyword', 'ident', 'newline',
      'indent', 'ident', 'op', 'num', 'newline',
      'dedent', 'ident', 'op', 'num', 'newline',
      'eof',
    ]);
  });

  it('nested blocks emit multiple dedents', () => {
    const t = tokenize('if a\n    if b\n        c = 1\nd = 2');
    const dedents = t.filter((k) => k.type === 'dedent');
    const indents = t.filter((k) => k.type === 'indent');
    expect(indents).toHaveLength(2);
    expect(dedents).toHaveLength(2);
  });

  it('dedent to intermediate level emits one dedent', () => {
    const t = tokenize('if a\n    if b\n        c = 1\n    d = 2');
    // one dedent unwinds level 8→4 at d's line; the remaining dedent at EOF
    const beforeD = t.slice(0, t.findIndex((k) => k.v === 'd'));
    expect(beforeD.filter((k) => k.type === 'dedent')).toHaveLength(1);
  });

  it('tabs count as one level (width 4)', () => {
    const t = tokenize('if a\n\tb = 1');
    expect(t.some((k) => k.type === 'indent')).toBe(true);
  });

  it('inconsistent dedent throws', () => {
    expect(() => tokenize('if a\n        b = 1\n  c = 2')).toThrow(LexError);
  });

  it('blank and comment lines inside block do not dedent', () => {
    const t = tokenize('if a\n    b = 1\n\n    // note\n    c = 2\nd = 3');
    const dedentIdx = t.findIndex((k) => k.type === 'dedent');
    const zIdx = t.findIndex((k) => k.v === 'd');
    expect(dedentIdx).toBeGreaterThan(-1);
    expect(dedentIdx).toBeLessThan(zIdx);
  });
});

describe('tokenize — line continuation', () => {
  it('call args across lines inside parens = one logical line', () => {
    const t = tokenize('line.new(\n  x1=1,\n  y1=2)');
    expect(t.filter((k) => k.type === 'newline')).toHaveLength(1);
    expect(t.map((k) => k.type)).toEqual([
      'ident', 'op', 'ident', 'op',
      'ident', 'op', 'num', 'op',
      'ident', 'op', 'num', 'op',
      'newline', 'eof',
    ]);
    // no indent tokens — indentation inside parens is ignored
    expect(t.some((k) => k.type === 'indent' || k.type === 'dedent')).toBe(false);
  });

  it('trailing comma continues at depth 0', () => {
    const t = tokenize('x = a,\n  b');
    expect(t.filter((k) => k.type === 'newline')).toHaveLength(1);
    expect(t.some((k) => k.type === 'indent')).toBe(false);
    expect(t.map((k) => k.v).slice(0, 5)).toEqual(['x', '=', 'a', ',', 'b']);
  });

  it('comma inside parens still continues via depth', () => {
    const t = tokenize('f(a,\n  b)');
    expect(t.filter((k) => k.type === 'newline')).toHaveLength(1);
    expect(t.some((k) => k.type === 'indent')).toBe(false);
  });

  it('bracket continuation survives blank/comment lines inside', () => {
    const t = tokenize('f(a,\n\n  // cmt\n  b)');
    expect(t.filter((k) => k.type === 'newline')).toHaveLength(1);
  });

  it('unclosed bracket at EOF throws', () => {
    expect(() => tokenize('f(a,')).toThrow(LexError);
  });

  it('unmatched closer throws', () => {
    expect(() => tokenize('x = 1)')).toThrow(LexError);
  });
});

describe('tokenize — misc', () => {
  it('CRLF and trailing newline handled', () => {
    expect(kinds('a = 1\r\nb = 2\r\n')).toEqual([
      'ident', 'op', 'num', 'newline',
      'ident', 'op', 'num', 'newline',
      'eof',
    ]);
  });

  it('empty source → just eof', () => {
    expect(kinds('')).toEqual(['eof']);
    expect(kinds('\n\n// only comments\n')).toEqual(['eof']);
  });

  it('loc reports physical line of token start', () => {
    const t = tokenize('a = f(1,\n    2)');
    const two = t.find((k) => k.v === '2');
    expect(two?.loc).toEqual({ line: 2, col: 5 });
  });

  it('full indicator snippet round-trips', () => {
    const src = [
      '//@version=6',
      'indicator("EMA 20", overlay=true)',
      'plot(ta.ema(close, 20), color=color.orange, linewidth=2)',
    ].join('\n');
    const t = tokenize(src);
    expect(t[0]).toMatchObject({ type: 'keyword', v: 'indicator' });
    expect(t[t.length - 1]?.type).toBe('eof');
    expect(t.filter((k) => k.type === 'newline')).toHaveLength(2);
    // every emitted token satisfies the Token shape
    for (const k of t as Token[]) expect(typeof k.v).toBe('string');
  });
});
