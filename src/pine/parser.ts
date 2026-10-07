// ── Pine parser — Token[] → Node[] (contracts.ts AST) ───────────────────────
// Recursive-descent over the Python-style INDENT/DEDENT token stream from
// ./lexer. All statement/expression forms per PINE_REAL_PLAN.md.
//
// Conventions the interpreter relies on (single source of truth):
//  - `for x in e` → ForStmt with from = Ident{name: FOR_IN}, to = e. FOR_IN is
//    not a legal Pine identifier so it can never collide with user code.
//  - `return` / `varip` / `as` arrive as `ident` (not keywords).
//  - `<type> name = e` (`int x = 1`, `array<float> a = ...`) → TypedDecl.
//    `x = e` untyped → Assign. `x := e` → Reassign.
//  - `var x = e` → VarDecl (init-once). `var a=1, var float b=na` → VarDecl
//    with `multi`; first decl duplicated into .name/.typeAnn/.value.
//    `var [a,b] = f()` → TupleAssign flagged `var` (bindings init once).
//  - Top-level `indicator(...)`/`strategy(...)` → returned as `decl`, NOT
//    included in `body`. `strategy.entry(...)` still parses as a normal call.
//  - `export <decl>` flattens: the inner decl node is returned with
//    `export: true` (no ExportDecl wrapper), so hoisting scans see the real
//    node type. `varip` decls are VarDecl nodes with `varip: true`.
//  - Member access on keyword namespaces (`color.orange`, `strategy.entry`)
//    parses as Member — keywords are legal property names.
//  - `expr[n]` → HistRef (there is no plain index node; array.get etc. are
//    builtins). `a.b.c[n]` → HistRef over Member.

import { tokenize } from './lexer';
import type { Token } from './tokens';
import type {
  Node, Arg, Param, FieldDecl, VarDecl, TypedDecl, Assign, Reassign,
  IfStmt, IfExpr, ForStmt, WhileStmt, SwitchStmt, FuncDecl, ArrowFunc,
  MethodDecl, TypeDecl, ImportDecl, IndicatorDecl, StrategyDecl,
  TupleAssign, Ident, NumLit, StrLit, BoolLit, ColorLit, NaLit, Call,
  Member, HistRef, Binary, Unary, Ternary, ArrayLit, Break, Continue,
  ReturnStmt, LetDecl, ConstDecl,
} from './contracts';

/** Sentinel Ident name marking `for x in e` in ForStmt.from. `<`/`>` can never
 *  appear in a real identifier, so this cannot collide with source text. */
export const FOR_IN = '<for-in>';

export class ParseError extends Error {
  loc: { line: number; col: number };
  constructor(loc: { line: number; col: number }, msg: string) {
    super(`${loc.line}:${loc.col}: ${msg}`);
    this.name = 'ParseError';
    this.loc = loc;
  }
}

const TYPE_QUALIFIERS: Record<string, true> = {
  series: true, simple: true, const: true, input: true,
};

class Parser {
  private pos = 0;
  constructor(private toks: Token[]) {}

  // ── token plumbing ─────────────────────────────────────────────────────────

  private peek(k = 0): Token {
    return this.toks[Math.min(this.pos + k, this.toks.length - 1)];
  }
  private next(): Token {
    const t = this.toks[this.pos];
    if (t.type !== 'eof') this.pos++;
    return t;
  }
  private at(type: Token['type'], v?: string): boolean {
    const t = this.peek();
    return t.type === type && (v === undefined || t.v === v);
  }
  private atOp(v: string): boolean {
    return this.at('op', v);
  }
  private atKw(v: string): boolean {
    return this.at('keyword', v);
  }
  private err(msg: string, loc?: { line: number; col: number }): never {
    throw new ParseError(loc ?? this.peek().loc, msg);
  }
  private expect(type: Token['type'], v?: string): Token {
    const t = this.peek();
    if (t.type !== type || (v !== undefined && t.v !== v)) {
      this.err(`expected ${v ?? type}, got ${t.type}${t.v ? ` '${t.v}'` : ''}`);
    }
    return this.next();
  }
  private expectOp(v: string): Token {
    return this.expect('op', v);
  }
  private skipNl(): void {
    while (this.at('newline')) this.next();
  }
  /** Is `t` a valid operand start? (lookahead only) */
  private isExprStart(t: Token): boolean {
    switch (t.type) {
      case 'num': case 'str': case 'bool': case 'na': case 'color':
      case 'ident':
        return true;
      case 'keyword':
        return t.v === 'if' || t.v === 'switch' || t.v === 'not';
      case 'op':
        return t.v === '(' || t.v === '[' || t.v === '-' || t.v === '+' ||
               t.v === '!';
      default:
        return false;
    }
  }
  /** When false, bare `ident =>` does not parse as an ArrowFunc — used while
   *  scanning switch-arm tests so `a > b => v` splits at the arm arrow. */
  private bareArrow = true;


  /** Index just past the bracket matching `open` at toks[openIdx] ('(' or
   *  '['), or -1. Only the matching pair is counted — `[f(x), y]` ends at
   *  the outer `]`, not `f(x)`'s `)`. */
  private matchBracket(openIdx: number, open: '(' | '['): number {
    if (this.toks[openIdx]?.type !== 'op' || this.toks[openIdx].v !== open) {
      return -1;
    }
    const close = open === '(' ? ')' : ']';
    let depth = 0;
    for (let i = openIdx; i < this.toks.length; i++) {
      const t = this.toks[i];
      if (t.type === 'op' && t.v === open) depth++;
      else if (t.type === 'op' && t.v === close) {
        depth--;
        if (depth === 0) return i + 1;
      } else if (t.type === 'newline' || t.type === 'indent' ||
                 t.type === 'dedent' || t.type === 'eof') {
        return -1;
      }
    }
    return -1;
  }

  // ── program / blocks ───────────────────────────────────────────────────────

  parseProgram(): { decl: IndicatorDecl | StrategyDecl | null; body: Node[] } {
    const body: Node[] = [];
    let decl: IndicatorDecl | StrategyDecl | null = null;
    this.skipNl();
    while (!this.at('eof')) {
      const s = this.statement();
      if (s && (s.type === 'indicator' || s.type === 'strategy')) {
        if (!decl) decl = s;
      } else if (s) {
        body.push(s);
      }
      if (this.atOp(',')) { this.next(); continue; } // `x := 1, y := 2`
      this.skipNl();
    }
    return { decl, body };
  }

  /** NEWLINE INDENT stmt* DEDENT → stmts. Returns [] when no block follows. */
  private block(): Node[] {
    this.skipNl();
    if (!this.at('indent')) return [];
    this.next();
    const out: Node[] = [];
    this.skipNl();
    while (!this.at('dedent') && !this.at('eof')) {
      const s = this.statement();
      if (s) out.push(s);
      if (this.atOp(',')) { this.next(); continue; } // `x := 1, y := 2`
      this.skipNl();
    }
    this.expect('dedent');
    return out;
  }

  // ── statements ─────────────────────────────────────────────────────────────

  private statement(): Node | null {
    const t = this.peek();
    if (t.type === 'newline' || t.type === 'eof' || t.type === 'dedent') {
      return null;
    }

    if (t.type === 'keyword') {
      switch (t.v) {
        case 'if': return this.ifNode('if');
        case 'for': return this.forStmt();
        case 'while': return this.whileStmt();
        case 'switch': return this.switchStmt();
        case 'break': this.next(); return { type: 'break', loc: t.loc } as Break;
        case 'continue':
          this.next();
          return { type: 'continue', loc: t.loc } as Continue;
        case 'var': this.next(); return this.varDecl(t.loc);
        case 'let': return this.letDecl();
        case 'const': return this.constDecl();
        case 'type': return this.typeDecl();
        case 'method': return this.methodDecl();
        case 'import': return this.importDecl();
        case 'export': return this.exportDecl();
        case 'indicator': case 'strategy':
          if (this.peek(1).type === 'op' && this.peek(1).v === '(') {
            return this.scriptDecl();
          }
          break; // e.g. `strategy.entry(...)` → expression path
        case 'else':
          this.err("unmatched 'else'");
      }
    }

    // `return` / `varip` arrive as ident (not in the keyword table)
    if (t.type === 'ident' && t.v === 'return') {
      this.next();
      const value = this.isExprStart(this.peek()) ? this.expr() : undefined;
      return { type: 'return', value, loc: t.loc } as ReturnStmt;
    }
    if (t.type === 'ident' && t.v === 'varip' &&
        (this.peek(1).type === 'ident' || this.peek(1).type === 'op')) {
      this.next();
      // Realtime-bar semantics aren't modelled; the node is flagged so the
      // interpreter can warn once that `varip` is approximated by `var`.
      return this.varDecl(t.loc, true);
    }

    if (t.type === 'op' && t.v === '[') {
      // `[a, b] = f()` is a tuple destructure; a bare `[…]` (UDF last-value,
      // expr statement) is an ArrayLit. Distinguish by `]=` after the bracket.
      const after = this.matchBracket(this.pos, '[');
      if (after > 0 && this.toks[after].type === 'op' &&
          this.toks[after].v === '=') {
        return this.tupleAssign();
      }
    }

    if (t.type === 'ident') {
      // `f(params) => …` — UDF declaration
      if (this.peek(1).type === 'op' && this.peek(1).v === '(') {
        const after = this.matchBracket(this.pos + 1, '(');
        if (after > 0 && this.toks[after].type === 'op' &&
            this.toks[after].v === '=>') {
          return this.funcDecl();
        }
      }
      // `<type> name [= e]` — TypedDecl
      if (this.isTypedDeclAhead()) return this.typedDecl();
    }

    // expression statement / assignment / reassignment / compound assign
    const e = this.expr();
    if (this.atOp(':=')) {
      this.next();
      const value = this.expr();
      return { type: 'reassign', target: e, value, loc: e.loc } as Reassign;
    }
    // `x += e` lexes as op('+') op('=') — desugar to `x := x + e`.
    const p1 = this.peek(), p2 = this.peek(1);
    if (p1.type === 'op' && p2.type === 'op' && p2.v === '=' &&
        (p1.v === '+' || p1.v === '-' || p1.v === '*' || p1.v === '/' || p1.v === '%')) {
      this.next(); this.next();
      const rhs = this.expr();
      const value: Binary = { type: 'binary', op: p1.v, left: e, right: rhs, loc: e.loc };
      return { type: 'reassign', target: e, value, loc: e.loc } as Reassign;
    }
    if (this.atOp('=')) {
      if (e.type === 'ident') {
        this.next();
        const value = this.expr();
        return { type: 'assign', name: (e as Ident).name, value, loc: e.loc } as Assign;
      }
      this.err("declaration '=' needs a bare name on the left; use ':=' to reassign");
    }
    return e;
  }

  /** `<type> name`, `<type<params>> name`, `<type>[] name` lookahead —
   *  distinguishes `int x` (decl) from `x < y` (expr). */
  private isTypedDeclAhead(): boolean {
    const t1 = this.peek(1);
    if (t1.type === 'ident') return true;                       // int x
    if (t1.type === 'op' && t1.v === '[') {
      return this.peek(2).type === 'op' && this.peek(2).v === ']' &&
             this.peek(3).type === 'ident';                     // int[] x
    }
    if (t1.type === 'op' && t1.v === '<') {
      let depth = 0;
      for (let i = this.pos + 1; i < this.toks.length; i++) {
        const tk = this.toks[i];
        if (tk.type === 'op' && tk.v === '<') depth++;
        else if (tk.type === 'op' && tk.v === '>') {
          depth--;
          if (depth === 0) return this.toks[i + 1]?.type === 'ident';
        } else if (tk.type !== 'ident' && tk.type !== 'keyword' &&
                   !(tk.type === 'op' &&
                     (tk.v === ',' || tk.v === '[' || tk.v === ']' || tk.v === '.'))) {
          return false;
        }
      }
    }
    return false;
  }

  // ── declarations ───────────────────────────────────────────────────────────

  /** True when a type annotation precedes the variable name at cursor:
   *  `int x`, `series float x`, `array<float> x`, `int[] x`. A lone ident
   *  followed by `=`/`,`/newline is NOT a typed head (it's the name itself). */
  private looksLikeTypedHead(): boolean {
    const t = this.peek();
    const q = (t.type === 'ident' && TYPE_QUALIFIERS[t.v]) ||
              (t.type === 'keyword' && t.v === 'const');
    if (q && (this.peek(1).type === 'ident' || this.peek(1).type === 'keyword')) {
      return true; // qualifier is always followed by a type name
    }
    return this.isTypedDeclAhead();
  }

  /** `var [type] name = e` (+ multi `, [var] [type] name = e`), or
   *  `var [a,b] = f()` → TupleAssign carrying `var`. `varip` enters
   *  via varip=true and sets the `varip` flag on the resulting VarDecl. */
  private varDecl(loc: { line: number; col: number }, varip = false): Node {
    if (this.atOp('[')) {
      return this.tupleAssign(true); // `var [a,b] = f()` — bindings persist
    }
    const parts: { name: string; typeAnn?: string; value: Node }[] = [];
    for (;;) {
      const typeAnn = this.looksLikeTypedHead() ? this.parseTypeAnn() : undefined;
      const name = this.expect('ident').v;
      let value: Node;
      if (this.atOp('=')) {
        this.next();
        value = this.expr();
      } else {
        value = { type: 'na', loc: this.peek().loc } as NaLit; // `var float p`
      }
      const part: { name: string; typeAnn?: string; value: Node } = { name, value };
      if (typeAnn) part.typeAnn = typeAnn;
      parts.push(part);
      if (!this.atOp(',')) break;
      this.next();
      // `var`/`let`/`const` may repeat after the comma: `var a=1, var float b=na`
      if (this.atKw('var') || this.atKw('let') || this.atKw('const')) this.next();
    }
    const first = parts[0];
    const node: VarDecl = { type: 'var', name: first.name, value: first.value, loc };
    if (varip) node.varip = true;
    if (first.typeAnn) node.typeAnn = first.typeAnn;
    if (parts.length > 1) node.multi = parts;
    return node;
  }

  private letDecl(): LetDecl {
    const kw = this.next();
    const typeAnn = this.looksLikeTypedHead() ? this.parseTypeAnn() : undefined;
    const name = this.expect('ident').v;
    this.expectOp('=');
    const value = this.expr();
    const n: LetDecl = { type: 'let', name, value, loc: kw.loc };
    if (typeAnn) n.typeAnn = typeAnn;
    return n;
  }

  private constDecl(): ConstDecl {
    const kw = this.next();
    const typeAnn = this.looksLikeTypedHead() ? this.parseTypeAnn() : undefined;
    const name = this.expect('ident').v;
    this.expectOp('=');
    const value = this.expr();
    const n: ConstDecl = { type: 'const', name, value, loc: kw.loc };
    if (typeAnn) n.typeAnn = typeAnn;
    return n;
  }

  /** `<type> name [= e]` — `int x = 1`, `array<float> a = array.new(0)`. */
  private typedDecl(): TypedDecl {
    const loc = this.peek().loc;
    const ann = this.parseTypeAnn();
    const name = this.expect('ident').v;
    const n: TypedDecl = { type: 'typed', ann, name, loc };
    if (this.atOp('=')) {
      this.next();
      n.value = this.expr();
    }
    return n;
  }

  /** Type annotation text: `[qualifiers] base[<params>][[]]` → e.g.
   *  'series float', 'array<float>', 'map<string,int>', 'int[]'. */
  private parseTypeAnn(): string {
    const quals: string[] = [];
    for (;;) {
      const t = this.peek();
      const isQual =
        (t.type === 'ident' && TYPE_QUALIFIERS[t.v]) ||
        (t.type === 'keyword' && t.v === 'const');
      if (!isQual || this.peek(1).type !== 'ident') break;
      quals.push(t.v);
      this.next();
    }
    const base = this.peek();
    if (base.type !== 'ident' && base.type !== 'keyword') {
      this.err('expected type name');
    }
    let ann = (quals.length ? quals.join(' ') + ' ' : '') + this.next().v;
    if (this.atOp('<')) {
      ann += this.next().v;
      let depth = 1;
      while (depth > 0) {
        const t = this.next();
        if (t.type === 'eof') this.err('unterminated type parameters');
        if (t.type === 'op') {
          if (t.v === '<') depth++;
          else if (t.v === '>') depth--;
          else if (t.v !== ',' && t.v !== '[' && t.v !== ']' && t.v !== '.') {
            this.err(`unexpected '${t.v}' in type parameters`);
          }
        } else if (t.type !== 'ident' && t.type !== 'keyword') {
          this.err(`unexpected ${t.type} in type parameters`);
        }
        ann += t.v === ',' ? ', ' : t.v;
      }
    }
    while (this.atOp('[') && this.peek(1).type === 'op' && this.peek(1).v === ']') {
      this.next();
      this.next();
      ann += '[]';
    }
    return ann;
  }

  private tupleAssign(varFlag = false): TupleAssign {
    const loc = this.expectOp('[').loc;
    const names: string[] = [];
    if (!this.atOp(']')) {
      for (;;) {
        names.push(this.expect('ident').v);
        if (!this.atOp(',')) break;
        this.next();
      }
    }
    this.expectOp(']');
    this.expectOp('=');
    const value = this.expr();
    return varFlag
      ? { type: 'tuple', names, value, loc, var: true }
      : { type: 'tuple', names, value, loc };
  }

  // ── functions ──────────────────────────────────────────────────────────────

  /** `name(p1, p2) => expr|block`. Caller verified `ident ( … ) =>`. */
  private funcDecl(): FuncDecl {
    const name = this.next();
    const params = this.params();
    this.expectOp('=>');
    const body = this.funcBody();
    return { type: 'func', name: name.v, params, body, loc: name.loc };
  }

  private funcBody(): Node | Node[] {
    return this.at('newline') ? this.block() : this.expr();
  }

  /** `(p1, t2 p2, qual t3 p3 = d, …)` — last token per param is the name,
   *  everything before is type-annotation text (spaces around <>,[] squeezed). */
  private params(): Param[] {
    this.expectOp('(');
    const out: Param[] = [];
    while (!this.atOp(')') && !this.at('eof')) {
      const words: Token[] = [];
      // Commas inside type parameters (`map<string,int>`) separate
      // type arguments, not params — only a depth-0 comma ends the
      // annotation word run.
      let genericDepth = 0;
      for (;;) {
        const t = this.peek();
        if (t.type === 'op' && t.v === '<') genericDepth++;
        else if (t.type === 'op' && t.v === '>' && genericDepth > 0) genericDepth--;
        if (t.type === 'op' && (t.v === '=' || t.v === ')')) break;
        if (t.type === 'op' && t.v === ',' && genericDepth === 0) break;
        if (t.type === 'eof' || t.type === 'newline') {
          this.err('unterminated parameter list');
        }
        words.push(t);
        this.next();
      }
      if (words.length === 0) this.err('empty parameter');
      const p: Param = { name: words[words.length - 1].v };
      if (words.length > 1) {
        p.typeAnn = words.slice(0, -1).map(w => w.v).join(' ')
          .replace(/\s*([<>\[\],])\s*/g, '$1');
      }
      if (this.atOp('=')) {
        this.next();
        p.default = this.expr();
      }
      out.push(p);
      if (!this.atOp(',')) break;
      this.next();
    }
    this.expectOp(')');
    return out;
  }

  /** `method m(T self, args) => body` — the self param stays params[0] with
   *  its declared name; selfType = its annotation (fallback: its name). */
  private methodDecl(): MethodDecl {
    const kw = this.next();
    const name = this.expect('ident').v;
    const params = this.params();
    this.expectOp('=>');
    const body = this.funcBody();
    const selfType = params[0]?.typeAnn ?? params[0]?.name ?? 'self';
    return { type: 'method', name, selfType, params, body, loc: kw.loc };
  }

  // ── type decl ──────────────────────────────────────────────────────────────

  private typeDecl(): TypeDecl {
    const kw = this.next();
    const name = this.expect('ident').v;
    const stmts = this.block();
    const fields: FieldDecl[] = [];
    for (const raw of stmts) {
      const s = raw;
      if (s.type === 'typed') {
        const td = s as TypedDecl;
        const f: FieldDecl = {
          type: 'field', name: td.name, typeAnn: td.ann, loc: td.loc,
        };
        if (td.value) f.default = td.value;
        fields.push(f);
      } else if (s.type === 'assign') {
        const a = s as Assign;
        fields.push({
          type: 'field', name: a.name, typeAnn: 'auto', default: a.value,
          loc: a.loc,
        });
      } else {
        this.err('only field declarations allowed inside `type` block',
                 s.loc ?? kw.loc);
      }
    }
    return { type: 'typedecl', name, fields, loc: kw.loc };
  }

  // ── control flow ───────────────────────────────────────────────────────────

  /** `if` at statement level → IfStmt; in expression → IfExpr. `else if`
   *  chains flatten into elseIfs. */
  private ifNode(kind: 'if' | 'ifexpr'): IfStmt | IfExpr {
    return this.ifImpl(kind);
  }

  private ifImpl(kind: 'if' | 'ifexpr'): IfStmt | IfExpr {
    const kw = this.next();
    const test = this.expr();
    const then = this.block();
    const elseIfs: { test: Node; body: Node[] }[] = [];
    let elseBody: Node[] | null = null;
    // After the then-block's DEDENT the `else` token follows directly — the
    // lexer emits dedent at line start with no NEWLINE between it and `else`.
    if (this.atKw('else')) {
      this.next();
      if (this.atKw('if')) {
        const sub = this.ifImpl(kind);
        elseIfs.push({ test: sub.test, body: sub.then });
        elseIfs.push(...sub.elseIfs);
        elseBody = sub.else;
      } else {
        elseBody = this.block();
      }
    }
    return {
      type: kind, test, then, elseIfs, else: elseBody, loc: kw.loc,
    } as IfStmt;
  }

  private forStmt(): ForStmt {
    const kw = this.next();
    let varName: string;
    if (this.atOp('[')) {
      // `for [k, v] in map` — two-var form; 'k,v' can't be a real ident so
      // varName.includes(',') unambiguously flags it (interp convention).
      this.next();
      const names: string[] = [this.expect('ident').v];
      while (this.atOp(',')) { this.next(); names.push(this.expect('ident').v); }
      this.expectOp(']');
      varName = names.join(',');
    } else {
      varName = this.expect('ident').v;
    }
    let from: Node;
    let to: Node;
    let step: Node | undefined;
    if (this.atKw('in')) {
      this.next();
      from = { type: 'ident', name: FOR_IN, loc: kw.loc } as Ident;
      to = this.expr();
    } else {
      this.expectOp('=');
      from = this.expr();
      if (!this.atKw('to')) this.err("expected 'to' in for-statement");
      this.next();
      to = this.expr();
      if (this.atKw('by')) {
        this.next();
        step = this.expr();
      }
    }
    const body = this.block();
    const n: ForStmt = { type: 'for', varName, from, to, body, loc: kw.loc };
    if (step) n.step = step;
    return n;
  }

  private whileStmt(): WhileStmt {
    const kw = this.next();
    const test = this.expr();
    const body = this.block();
    return { type: 'while', test, body, loc: kw.loc };
  }

  private switchStmt(): SwitchStmt {
    const kw = this.next();
    const subject =
      this.at('newline') || this.at('indent') || this.at('eof')
        ? undefined
        : this.expr();
    this.skipNl();
    this.expect('indent');
    const cases: { test?: Node; body: Node[] }[] = [];
    this.skipNl();
    let armCount = 0;
    while (!this.at('dedent') && !this.at('eof')) {
      if (this.atOp('=>')) {
        this.next();
        cases.push({ body: this.armBody() });
      } else {
        // `=>` also terminates single-param arrows; suppress the bare
        // `x => body` form while scanning the arm's test expression so
        // `a > b => value` doesn't eat `b => value` as an ArrowFunc.
        this.bareArrow = false;
        let test: Node;
        try {
          test = this.expr();
        } finally {
          this.bareArrow = true;
        }
        this.expectOp('=>');
        cases.push({ test, body: this.armBody() });
      }
      armCount++;
      this.skipNl();
    }
    this.expect('dedent');
    return { type: 'switch', subject, cases, loc: kw.loc };
  }

  private armBody(): Node[] {
    return this.at('newline') ? this.block() : [this.expr()];
  }

  // ── module / script decls ──────────────────────────────────────────────────

  private scriptDecl(): IndicatorDecl | StrategyDecl {
    const kw = this.next(); // 'indicator' | 'strategy'
    const args = this.callArgs();
    return {
      type: kw.v === 'indicator' ? 'indicator' : 'strategy',
      args,
      loc: kw.loc,
    } as IndicatorDecl | StrategyDecl;
  }

  private importDecl(): ImportDecl {
    const kw = this.next();
    // path: ident/num joined by '.' or '/' ops (`user/lib/2` → 'user/lib/2')
    const segs: string[] = [];
    while (!this.at('newline') && !this.at('eof') && !this.at('dedent')) {
      const t = this.peek();
      if (t.type === 'ident' && (t.v === 'as' || t.v === 'in')) break;
      if (t.type === 'keyword' && t.v === 'in') break;
      if (t.type === 'ident' || t.type === 'num' ||
          (t.type === 'op' && (t.v === '.' || t.v === '/'))) {
        segs.push(this.next().v);
        continue;
      }
      break;
    }
    let alias: string | undefined;
    if (this.peek().type === 'ident' && this.peek().v === 'as') {
      this.next();
      alias = this.expect('ident').v;
    }
    // name = last non-numeric segment (skips version suffix like /2)
    let name = '';
    for (let i = segs.length - 1; i >= 0; i--) {
      if (/^[A-Za-z_]/.test(segs[i])) { name = segs[i]; break; }
    }
    const n: ImportDecl = {
      type: 'import', ns: segs.join(''), name: name || segs.join(''),
      loc: kw.loc,
    };
    if (alias) n.alias = alias;
    return n;
  }

  /** `export <decl>` flattens to the inner decl node with `export: true` —
   *  hoisting/dispatch scans (and this parser's own `type` block reader) see
   *  the real decl type without unwrapping. Export has no runtime semantics
   *  here (single-script interpreter, no library packaging). */
  private exportDecl(): Node {
    this.next(); // 'export'
    const inner = this.statement();
    if (!inner) this.err('expected declaration after export');
    inner.export = true;
    return inner;
  }

  // ── expressions ────────────────────────────────────────────────────────────

  expr(): Node {
    return this.ternary();
  }

  private ternary(): Node {
    const test = this.binOr();
    if (this.atOp('?')) {
      const loc = test.loc;
      this.next();
      const cons = this.ternary();
      this.expectOp(':');
      const alt = this.ternary(); // right-assoc: a?x:b?y:z = a?x:(b?y:z)
      return { type: 'ternary', test, cons, alt, loc } as Ternary;
    }
    return test;
  }

  private binOr(): Node {
    let left = this.binAnd();
    while (this.atKw('or')) {
      const loc = left.loc;
      this.next();
      left = {
        type: 'binary', op: 'or', left, right: this.binAnd(), loc,
      } as Binary;
    }
    return left;
  }

  private binAnd(): Node {
    let left = this.binCmp();
    while (this.atKw('and')) {
      const loc = left.loc;
      this.next();
      left = {
        type: 'binary', op: 'and', left, right: this.binCmp(), loc,
      } as Binary;
    }
    return left;
  }

  private binCmp(): Node {
    let left = this.binAdd();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' &&
          (t.v === '==' || t.v === '!=' || t.v === '<' || t.v === '<=' ||
           t.v === '>' || t.v === '>=')) {
        const loc = left.loc;
        this.next();
        left = {
          type: 'binary', op: t.v, left, right: this.binAdd(), loc,
        } as Binary;
      } else {
        return left;
      }
    }
  }

  private binAdd(): Node {
    let left = this.binMul();
    // `x += e` lexes as `x + =`; don't eat `+` when `=` follows (compound
    // assignment is handled at statement level).
    while ((this.atOp('+') || this.atOp('-')) &&
           !(this.peek(1).type === 'op' && this.peek(1).v === '=')) {
      const op = this.next().v;
      const loc = left.loc;
      left = {
        type: 'binary', op, left, right: this.binMul(), loc,
      } as Binary;
    }
    return left;
  }

  private binMul(): Node {
    let left = this.unary();
    while ((this.atOp('*') || this.atOp('/') || this.atOp('%')) &&
           !(this.peek(1).type === 'op' && this.peek(1).v === '=')) {
      const op = this.next().v;
      const loc = left.loc;
      left = {
        type: 'binary', op, left, right: this.unary(), loc,
      } as Binary;
    }
    return left;
  }

  private unary(): Node {
    const t = this.peek();
    if (t.type === 'op' && (t.v === '-' || t.v === '+' || t.v === '!')) {
      this.next();
      return { type: 'unary', op: t.v, arg: this.unary(), loc: t.loc } as Unary;
    }
    if (t.type === 'keyword' && t.v === 'not') {
      this.next();
      return { type: 'unary', op: 'not', arg: this.unary(), loc: t.loc } as Unary;
    }
    return this.postfix();
  }

  private postfix(): Node {
    let e = this.primary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && t.v === '[' && this.histrefAhead()) {
        this.next();
        const idx = this.expr();
        this.expectOp(']');
        e = { type: 'histref', obj: e, idx, loc: e.loc } as HistRef;
      } else if (t.type === 'op' && t.v === '.') {
        this.next();
        const p = this.peek();
        if (p.type !== 'ident' && p.type !== 'keyword') {
          this.err('expected member name after .');
        }
        this.next();
        e = { type: 'member', obj: e, prop: p.v, loc: e.loc } as Member;
      } else if (t.type === 'op' && t.v === '<' && e.type === 'member' &&
                 this.typeArgsAhead()) {
        // `array.new<float>(…)` — generic call; type args dropped (v1)
        this.skipTypeArgs();
        e = { type: 'call', callee: e, args: this.callArgs(), loc: e.loc } as Call;
      } else if (t.type === 'op' && t.v === '(') {
        e = { type: 'call', callee: e, args: this.callArgs(), loc: e.loc } as Call;
      } else {
        return e;
      }
    }
  }
  /** `[` after an operand is a HistRef — Pine has no postfix array indexing —
   *  UNLESS its bracketed content contains a top-level comma, in which case
   *  the operand is a stray expression statement and `[a, b]` is a separate
   *  array literal. Any single expression — `a[na]`, `a[true]`, `a["k"]`,
   *  `a[not x]` — is a histref. Statement-level array literals never reach
   *  here (primary() owns `[`). */
  private histrefAhead(): boolean {
    let depth = 1;
    for (let i = this.pos + 1; i < this.toks.length; i++) {
      const t = this.toks[i];
      if (t.type !== 'op') {
        if (t.type === 'newline' || t.type === 'indent' ||
            t.type === 'dedent' || t.type === 'eof') return true; // unterminated: treat as histref so expr reports it
        continue;
      }
      if (t.v === '[' || t.v === '(' || t.v === '{') depth++;
      else if (t.v === ']' || t.v === ')' || t.v === '}') {
        depth--;
        if (depth === 0) return true; // closed without top-level ','
      } else if (t.v === ',' && depth === 1) {
        return false;
      }
    }
    return true;
  }


  /** `<` at cursor opens a type-arg list iff a balanced `>` precedes `(`. */
  private typeArgsAhead(): boolean {
    let depth = 0;
    for (let i = this.pos; i < this.toks.length; i++) {
      const t = this.toks[i];
      if (t.type === 'op' && t.v === '<') depth++;
      else if (t.type === 'op' && t.v === '>') {
        depth--;
        if (depth === 0) {
          const nxt = this.toks[i + 1];
          return nxt?.type === 'op' && nxt.v === '(';
        }
      } else if (t.type !== 'ident' && t.type !== 'keyword' &&
                 !(t.type === 'op' &&
                   (t.v === ',' || t.v === '[' || t.v === ']' || t.v === '.'))) {
        return false;
      }
    }
    return false;
  }

  private skipTypeArgs(): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t.type === 'op' && t.v === '<') depth++;
      else if (t.type === 'op' && t.v === '>') depth--;
    } while (depth > 0 && !this.at('eof'));
  }

  /** `( arg, name = arg, … )` — cursor is at `(`. */
  private callArgs(): Arg[] {
    this.expectOp('(');
    const args: Arg[] = [];
    while (!this.atOp(')') && !this.at('eof')) {
      let name: string | undefined;
      if (this.at('ident') && this.peek(1).type === 'op' &&
          this.peek(1).v === '=') {
        name = this.next().v;
        this.next();
      }
      const value = this.expr();
      const arg: Arg = { value };
      if (name !== undefined) arg.name = name;
      args.push(arg);
      if (!this.atOp(',')) break;
      this.next();
    }
    this.expectOp(')');
    return args;
  }

  private primary(): Node {
    const t = this.peek();
    const loc = t.loc;

    switch (t.type) {
      case 'num':
        this.next();
        return {
          type: 'num', v: Number(t.v),
          isInt: t.isInt ?? !/[.eE]/.test(t.v), loc,
        } as NumLit;
      case 'str':
        this.next();
        return { type: 'str', v: t.v, loc } as StrLit;
      case 'bool':
        this.next();
        return { type: 'bool', v: t.v === 'true', loc } as BoolLit;
      case 'color':
        this.next();
        return { type: 'color', v: t.v, loc } as ColorLit;
      case 'na':
        this.next();
        return { type: 'na', loc } as NaLit;
      case 'ident':
        this.next();
        // `x => expr` — single-param arrow without parens (suppressed while
        // scanning switch-arm tests, where `=>` ends the test instead)
        if (this.bareArrow && this.atOp('=>')) {
          this.next();
          return {
            type: 'arrow', params: [{ name: t.v }], body: this.funcBody(), loc,
          } as ArrowFunc;
        }
        return { type: 'ident', name: t.v, loc } as Ident;
      case 'keyword':
        if (t.v === 'if') return this.ifNode('ifexpr');
        if (t.v === 'switch') return this.switchStmt();
        if (t.v === 'not') {
          this.next();
          return {
            type: 'unary', op: 'not', arg: this.unary(), loc,
          } as Unary;
        }
        // keyword namespaces usable as expression roots when a member
        // follows: `color.orange`, `format.price`, `strategy.long`.
        if (this.peek(1).type === 'op' && this.peek(1).v === '.') {
          this.next();
          return { type: 'ident', name: t.v, loc } as Ident;
        }
        // lenient: Pine lets contextual keywords (`indicator`, `strategy`,
        // etc.) be used as ordinary identifiers in scripts. Fall back to
        // Ident rather than erroring — `for`/`to`/`by`/`in`/`else` would be
        // nonsense here, but surfacing as ident → runtime 'undefined var'
        // is better than a hard parse error.
        this.next();
        return { type: 'ident', name: t.v, loc } as Ident;
      case 'op':
        if (t.v === '(') {
          const after = this.matchBracket(this.pos, '(');
          if (after > 0 && this.toks[after].type === 'op' &&
              this.toks[after].v === '=>') {
            const params = this.params();
            this.expectOp('=>');
            return {
              type: 'arrow', params, body: this.funcBody(), loc,
            } as ArrowFunc;
          }
          this.next();
          const e = this.expr();
          this.expectOp(')');
          return e;
        }
        if (t.v === '[') {
          this.next();
          const items: Node[] = [];
          while (!this.atOp(']') && !this.at('eof')) {
            items.push(this.expr());
            if (!this.atOp(',')) break;
            this.next();
          }
          this.expectOp(']');
          return { type: 'arraylit', items, loc } as ArrayLit;
        }
        break;
    }
    this.err(`unexpected ${t.type}${t.v ? ` '${t.v}'` : ''}`);
  }
}

export function parse(src: string): {
  decl: IndicatorDecl | StrategyDecl | null;
  body: Node[];
} {
  return new Parser(tokenize(src)).parseProgram();
}
