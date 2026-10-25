import { describe, expect, it } from 'vitest';
import { LexError, tokenize } from '../lexer';
import { parse } from '../parser';

describe('tokenize — multi-line string literals', () => {
  it('(a) keeps a real newline inside the string value', () => {
    const t = tokenize('s = "a\nb"');
    expect(t[2]).toMatchObject({ type: 'str', v: 'a\nb' });
    expect(t.map((k) => k.type)).toEqual(['ident', 'op', 'str', 'newline', 'eof']);
  });

  it('(a2) keeps the start line/col of a multi-line string token', () => {
    const t = tokenize('x = 1\ns = "a\nb"');
    const str = t.find((k) => k.type === 'str');
    expect(str?.loc).toEqual({ line: 2, col: 5 });
  });

  it('(b) tokens after a multi-line string have correct line/col', () => {
    const t = tokenize('s = "a\nb"\nt = 1');
    const idx = t.findIndex((k) => k.type === 'ident' && k.v === 't');
    expect(idx).toBeGreaterThan(0);
    expect(t[idx]?.loc).toEqual({ line: 3, col: 1 });
    expect(t[idx + 1]?.loc).toEqual({ line: 3, col: 3 }); // '='
    expect(t[idx + 2]?.loc).toEqual({ line: 3, col: 5 }); // '1'
  });

  it('(b2) CRLF inside a string is dropped, not stored', () => {
    const t = tokenize('s = "a\r\nb"\r\nu = 2');
    expect(t[2]).toMatchObject({ type: 'str', v: 'a\nb' });
    const idx = t.findIndex((k) => k.type === 'ident' && k.v === 'u');
    expect(t[idx]?.loc).toEqual({ line: 3, col: 1 });
  });

  it('(c) unterminated at EOF still throws', () => {
    expect(() => tokenize('s = "abc')).toThrow(LexError);
    expect(() => tokenize('s = "abc')).toThrow(/unterminated string literal/);
    // newline consumed as content, then EOF
    expect(() => tokenize('s = "abc\n')).toThrow(/unterminated string literal/);
  });

  it('(d) single-line strings unchanged', () => {
    const t = tokenize('s = "abc"');
    expect(t[2]).toMatchObject({ type: 'str', v: 'abc' });
    expect(t[2]?.loc).toEqual({ line: 1, col: 5 });
    expect(tokenize('s = "a\\nb"')[2]).toMatchObject({ type: 'str', v: 'a\nb' });
  });

  it('(e) parse() accepts indicator() with a multi-line tooltip string', () => {
    const src = [
      '//@version=6',
      'indicator("M", overlay=true)',
      'tooltip = "Simple Green Cross Red. Advance',
      '     vipcondition := true"',
      'plot(close)',
    ].join('\n');
    expect(() => parse(src)).not.toThrow();
    const { decl, body } = parse(src);
    expect(decl).not.toBeNull();
    expect(body.length).toBeGreaterThan(0);
  });
});
