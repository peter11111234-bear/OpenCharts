// ── Pine lexer — source → Token[] (provisional impl, owned by LexerAgent) ────
// Emits the Token shape from ./tokens. Python-style INDENT/DEDENT; NEWLINE is
// suppressed inside unclosed ( [ { and after a trailing continuation operator
// (',' '?' ':' or binary op) at depth 0 so multi-line calls/ternaries land on
// one logical line. `//` comments (incl. //@version) produce no tokens.

import type { Token, TokenType } from './tokens';
import { KEYWORDS, OPS1, OPS2, OPEN_BRACKETS, CLOSE_BRACKETS } from './tokens';
export type { Token } from './tokens';

export class LexError extends Error {
  loc: { line: number; col: number };
  constructor(loc: { line: number; col: number }, msg: string) {
    super(`${loc.line}:${loc.col}: ${msg}`);
    this.name = 'LexError';
    this.loc = loc;
  }
}

/** Operators after which a depth-0 newline is a line continuation (Pine
 *  allows `x = a ? b :\n      c` and `x = a +\n      b`). Lexer-only table —
 *  the shared keyword/op tables live in ./tokens. */
const CONT_OPS: Record<string, true> = {
  ',': true, '?': true, ':': true,
  '+': true, '-': true, '*': true, '/': true, '%': true,
  '<': true, '>': true, '=': true,
};


const IDENT_START = /[A-Za-z_]/;
const IDENT_CONT = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const HEX = /[0-9a-fA-F]/;

export function tokenize(src: string): Token[] {
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1); // BOM
  const out: Token[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;
  const indents: number[] = [0];
  let depth = 0;
  let atLineStart = true;
  /** Last emitted token was a continuation op at depth 0 → next \n continues. */
  let pendingContinue = false;
  /** A newline was just suppressed → this physical line is a continuation;
   *  its leading indent is part of the expression, not block structure. */
  let contLine = false;

  const err = (msg: string): never => {
    throw new LexError({ line, col }, msg);
  };
  const push = (type: TokenType, v = '', isInt?: boolean, l = line, c = col): void => {
    const tok: Token = { type, v, loc: { line: l, col: c } };
    if (isInt !== undefined) tok.isInt = isInt;
    out.push(tok);
    pendingContinue = false;
  };
  const advance = (n = 1): void => {
    pos += n;
    col += n;
  };

  while (pos < src.length) {
    let ch: string = src[pos] ?? '';

    // ── line-start handling ──────────────────────────────────────────────────
    if (atLineStart) {
      atLineStart = false;
      if (ch === '\r') { advance(); atLineStart = true; continue; }
      if (ch === '\n') { advance(); line++; col = 1; atLineStart = true; continue; }
      const isCont: boolean = contLine;
      contLine = false;
      // measure indentation of this physical line (tab stops = 4 cols);
      // runs for EVERY non-blank line — a col-1 line like `else`/`method`
      // has ind=0 and must still unwind pending indents.
      {
        let j = pos;
        let ind = 0;
        while (j < src.length && (src[j] === ' ' || src[j] === '\t')) {
          ind = src[j] === ' ' ? ind + 1 : (Math.floor(ind / 4) + 1) * 4;
          j++;
        }
        const nc = src[j];
        const blankOrComment =
          j >= src.length ||
          nc === '\n' ||
          nc === '\r' ||
          (nc === '/' && src[j + 1] === '/');
        if (blankOrComment) {
          // skip the whole physical line incl. its '\n'; emit nothing and
          // preserve any open continuation (bracket depth / pending op)
          while (j < src.length && src[j] !== '\n') j++;
          pos = j;
          if (pos < src.length) { advance(); line++; }
          col = 1;
          atLineStart = true;
          contLine = isCont;
          continue;
        }
        // Pine line continuation: a deeper-indented line starting with a
        // binary op continues the previous logical line — pop the emitted
        // NEWLINE and skip indent tracking for this physical line.
        let isCont2 = isCont;
        if (!isCont2 && depth === 0 && ind > (indents[indents.length - 1] ?? 0) &&
            out.length > 0 && out[out.length - 1]?.type === 'newline') {
          const fc = src[j] ?? '';
          const twoC = src.slice(j, j + 2);
          const leadOp = !!OPS1[fc] && !'()[]{}!'.includes(fc) ||
              twoC === '==' || twoC === '!=' || twoC === '<=' || twoC === '>=';
          const fw = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(j))?.[0] ?? '';
          const leadKw = fw === 'and' || fw === 'or';
          if (leadOp || leadKw) {
            out.pop();          // drop the NEWLINE
            isCont2 = true;     // this physical line continues the expression
          }
        }
        if (!isCont2 && depth === 0) {
          const top = indents[indents.length - 1] ?? 0;
          if (ind > top) {
            indents.push(ind);
            push('indent', '', undefined, line, 1);
          } else if (ind < top) {
            while ((indents[indents.length - 1] ?? 0) > ind) {
              indents.pop();
              push('dedent', '', undefined, line, 1);
            }
            if (indents[indents.length - 1] !== ind) {
              throw new LexError({ line, col: 1 },
                'unindent does not match any outer indentation level');
            }
          }
        }
        advance(j - pos);
        ch = src[pos] ?? '';
      }
      // fall through to token scanning
    }

    // ── logical end of line ──────────────────────────────────────────────────
    if (ch === '\r') { advance(); continue; }
    if (ch === '\n') {
      if (depth === 0 && !pendingContinue) push('newline');
      else contLine = true; // suppressed → next physical line is a continuation
      pendingContinue = false;
      advance();
      line++;
      col = 1;
      atLineStart = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') { advance(); continue; }

    const startCol = col;

    // ── comment ──────────────────────────────────────────────────────────────
    if (ch === '/' && src[pos + 1] === '/') {
      while (pos < src.length && src[pos] !== '\n') pos++;
      continue;
    }

    // ── string ───────────────────────────────────────────────────────────────
    if (ch === '"' || ch === "'") {
      const quote = ch;
      advance();
      let v = '';
      for (;;) {
        if (pos >= src.length || src[pos] === '\n') err('unterminated string literal');
        const c = src[pos];
        if (c === '\\') {
          const e = src[pos + 1];
          const esc: Record<string, string> = {
            n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'",
          };
          v += e !== undefined && e in esc ? esc[e]
            : (e !== undefined ? `\\${e}` : '');
          advance(2);
          continue;
        }
        if (c === quote) { advance(); break; }
        v += c;
        advance();
      }
      push('str', v, undefined, line, startCol);
      continue;
    }

    // ── color literal #RRGGBB[AA] ────────────────────────────────────────────
    if (ch === '#') {
      let j = pos + 1;
      let hex = '';
      while (j < src.length && HEX.test(src[j] ?? '') && hex.length < 8) {
        hex += src[j] ?? '';
        j++;
      }
      if (hex.length !== 6 && hex.length !== 8) err(`invalid color literal '#${hex}'`);
      advance(1 + hex.length);
      push('color', `#${hex.toLowerCase()}`, undefined, line, startCol);
      continue;
    }

    // ── number ───────────────────────────────────────────────────────────────
    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(src[pos + 1] ?? ''))) {
      let j = pos;
      let isInt = true;
      if (src[j] === '.') { j++; isInt = false; } // .5
      while (j < src.length && DIGIT.test(src[j] ?? '')) j++;
      if (src[j] === '.') { isInt = false; j++; while (j < src.length && DIGIT.test(src[j] ?? '')) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (k < src.length && DIGIT.test(src[k] ?? '')) {
          isInt = false;
          while (k < src.length && DIGIT.test(src[k] ?? '')) k++;
          j = k;
        }
      }
      const text = src.slice(pos, j);
      advance(j - pos);
      push('num', text, isInt, line, startCol);
      continue;
    }

    // ── ident / keyword / bool / na ──────────────────────────────────────────
    if (IDENT_START.test(ch)) {
      let j = pos + 1;
      while (j < src.length && IDENT_CONT.test(src[j] ?? '')) j++;
      const word = src.slice(pos, j);
      advance(j - pos);
      if (word === 'true' || word === 'false') push('bool', word, undefined, line, startCol);
      else if (word === 'na') push('na', word, undefined, line, startCol);
      else if (KEYWORDS[word]) push('keyword', word, undefined, line, startCol);
      else push('ident', word, undefined, line, startCol);
      // `a and\n  b` / `a or\n  b` — line continuation after boolean ops
      if (depth === 0 && (word === 'and' || word === 'or')) pendingContinue = true;
      continue;
    }

    // ── operators ────────────────────────────────────────────────────────────
    const two = src.slice(pos, pos + 2);
    if (OPS2[two]) {
      advance(2);
      push('op', two, undefined, line, startCol);
      continue;
    }
    if (OPS1[ch]) {
      if (OPEN_BRACKETS[ch]) depth++;
      else if (CLOSE_BRACKETS[ch]) {
        if (depth === 0) err(`unmatched '${ch}'`);
        depth--;
      }
      advance();
      push('op', ch, undefined, line, startCol);
      if (depth === 0 && CONT_OPS[ch]) pendingContinue = true;
      continue;
    }

    err(`unexpected character '${ch}'`);
  }

  // ── EOF: close pending logical line + unwind indents ───────────────────────
  const last = out[out.length - 1];
  if (last && last.type !== 'newline' && last.type !== 'dedent' && last.type !== 'indent') {
    push('newline', '', undefined, line, col);
  }
  while (indents.length > 1) {
    indents.pop();
    push('dedent', '', undefined, line, col);
  }
  if (depth !== 0) {
    throw new LexError({ line, col }, `unclosed bracket at end of source (depth ${depth})`);
  }
  push('eof', '', undefined, line, col);
  return out;
}
