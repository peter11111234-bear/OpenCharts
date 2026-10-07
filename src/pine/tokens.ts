// ── Pine tokens — shared contract between lexer and parser ──────────────────
// Token shape is FIXED: parser.ts (and anything downstream) depends on these
// exact field names. If you change this file, update parser.ts in the same pass.

export type TokenType =
  | 'num'     // numeric literal — v: literal text, isInt marks int vs float
  | 'str'     // string literal — v: unescaped value
  | 'bool'    // true / false — v: 'true' | 'false'
  | 'na'      // `na` literal — v: 'na'
  | 'color'   // #RRGGBB / #RRGGBBAA — v: normalized lowercase '#rrggbb[aa]'
  | 'ident'   // identifier — v: name
  | 'keyword' // keyword — v: keyword text (var let const if else for to by while
             //   switch break continue and or not import export type method
             //   indicator strategy in)
  | 'op'      // operator / punctuation — v: op text
  | 'newline' // end of logical line (suppressed inside unclosed ( [ { and
             // after a trailing ',' at depth 0)
  | 'indent'  // indentation increased (Python-style block start)
  | 'dedent'  // indentation decreased (one per popped level)
  | 'eof';

export interface Token {
  type: TokenType;
  /** Payload text: literal text / ident name / keyword / op / unescaped string /
   *  normalized color. Always a string; `num` keeps literal text (use isInt). */
  v: string;
  /** num only: true when the literal had no '.' / exponent. */
  isInt?: boolean;
  /** 1-based line/col of token start on the physical line. */
  loc: { line: number; col: number };
}

/** Source position alias matching AST `loc` shape. */
export interface Loc { line: number; col: number }

/** Reserved words. `and`/`or`/`not` are keyword-operator hybrids; `indicator` and
 *  `strategy` are keywords so the parser can anchor the top-level decl. */
export const KEYWORDS: Record<string, true> = {
  var: true, let: true, const: true,
  if: true, else: true, for: true, to: true, by: true, while: true, switch: true,
  break: true, continue: true,
  and: true, or: true, not: true,
  import: true, export: true, type: true, method: true,
  indicator: true, strategy: true, in: true,
};

/** Two-character operators, lexed before singles. */
export const OPS2: Record<string, true> = {
  '==': true, '!=': true, '<=': true, '>=': true, '=>': true, ':=': true,
};

/** Single-character operators / punctuation. */
export const OPS1: Record<string, true> = {
  '+': true, '-': true, '*': true, '/': true, '%': true,
  '<': true, '>': true, '=': true, '?': true, ':': true, '.': true, ',': true, ';': true,
  '(': true, ')': true, '[': true, ']': true, '{': true, '}': true, '!': true,
};

export const OPEN_BRACKETS: Record<string, true> = { '(': true, '[': true, '{': true };
export const CLOSE_BRACKETS: Record<string, true> = { ')': true, ']': true, '}': true };
