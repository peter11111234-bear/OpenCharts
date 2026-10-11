// ── Pine → JS codegen (spike Slice-A) ────────────────────────────────────────
// Emits a top-level-body JS source string; runScriptInner compiles it via
// `new Function` and calls it once per bar with a runtime-shim `R`, the
// runState, the shared Frame, and the nodeTable.
//
// Design (from ScoutRisk/ScoutFeasibility):
// - Bindings go through interpreter machinery — decl/var/reassign call
//   bindDeclared/slotFor/evalReassign-equivalent helpers; JS `let` is never
//   used for Pine names (declSlots/CowSeries/siteKey would be lost).
// - Blocks (if arms) push/pop a REAL Scope child so shadowing, := write-
//   through, and evalExpr fallback all observe the same scope chain.
// - Calls transpile through R.call — full dispatch mirror (X.new, ns.fn,
//   obj.method, UDF/builtin bare) with descriptor args for deferred evalArg.
// - Per-stmt try/catch → R.stmtErr preserves wrapPineError line attribution.
// - run.topStmtIdx set per top-level stmt (ensureList pruning reads it).

import type { Arg, Node } from './contracts';

type Emit = { code: string; ok: true } | { ok: false };
const no: Emit = { ok: false };

const idxOf = new WeakMap<Node, number>();
let nextIdx = 0;
function N(n: Node): number {
  let i = idxOf.get(n);
  if (i === undefined) { i = ++nextIdx; idxOf.set(n, i); }
  return i;
}

function expr(n: Node): Emit {
  switch (n.type) {
    case 'num':   return { ok: true, code: `R.num(${n.v},${n.isInt})` };
    case 'str':   return { ok: true, code: `R.str(${JSON.stringify(n.v)})` };
    case 'bool':  return { ok: true, code: n.v ? 'R.TRUE' : 'R.FALSE' };
    case 'color': return { ok: true, code: `R.color(${JSON.stringify(n.v)})` };
    case 'na':    return { ok: true, code: 'R.NA' };
    case 'ident': return { ok: true, code: `R.ident(${JSON.stringify(n.name)})` };
    case 'unary': {
      const a = expr(n.arg);
      if (!a.ok) return a;
      return { ok: true, code: `R.unary(${JSON.stringify(n.op)},${a.code})` };
    }
    case 'binary': {
      const L = expr(n.left), Rr = expr(n.right);
      if (!L.ok) return L; if (!Rr.ok) return Rr;
      if (n.op === 'and') return { ok: true, code: `R.and(()=>${L.code},()=>${Rr.code})` };
      if (n.op === 'or')  return { ok: true, code: `R.or(()=>${L.code},()=>${Rr.code})` };
      return { ok: true, code: `R.binary(${JSON.stringify(n.op)},${L.code},${Rr.code})` };
    }
    case 'ternary': {
      const T = expr(n.test), C = expr(n.cons), A = expr(n.alt);
      if (!T.ok) return T; if (!C.ok) return C; if (!A.ok) return A;
      return { ok: true, code: `(R.truth(${T.code})?${C.code}:${A.code})` };
    }
    case 'arraylit': {
      const items = n.items.map(expr);
      if (items.some(i => !i.ok)) return no;
      return { ok: true, code: `R.arr([${items.map(i => i.ok ? i.code : '').join(',')}])` };
    }
    case 'histref': {
      // Ident-target only in v1 — non-ident needs callHist site tracking.
      if (n.obj.type !== 'ident') return no;
      const I = expr(n.idx);
      if (!I.ok) return I;
      return { ok: true, code: `R.hist(${JSON.stringify(n.obj.name)},${I.code})` };
    }
    case 'member': {
      if (n.computed) return no;
      // `ns.prop` where ns is an unbound ident → constant/builtin namespace
      // lookup (evalMember's first branch); bound ident or expr → value path.
      if (n.obj.type === 'ident') {
        return { ok: true, code: `R.memberIdent(${JSON.stringify(n.obj.name)},${JSON.stringify(n.prop)})` };
      }
      const O = expr(n.obj);
      if (!O.ok) return O;
      return { ok: true, code: `R.member(${O.code},${JSON.stringify(n.prop)})` };
    }
    case 'call': {
      // Args ride as descriptors so R.call can pick evalArg semantics AFTER
      // dispatch resolves (litFastPath differs builtin vs udf/method; ident
      // args keep series for CowSeries; X.new takes raw evalExpr values).
      const args = n.args.map(a => arg(a));
      if (args.some(a => !a.ok)) return no;
      return { ok: true, code: `R.call(${N(n)},[${args.map(a => a.ok ? a.code : '').join(',')}])` };
    }
    default: return no;
  }
}

/** Arg → `{k:'i'|'l'|'e',...}` descriptor code. `i`=ident (series-or-expr),
 * `l`=literal num/bool (LitSeries fast path for builtins only), `e`=expr.
 * Named args keep their name for the builtin `named` map / param binding. */
function arg(a: Arg): Emit {
  const name = a.name === undefined ? '' : `,n:${JSON.stringify(a.name)}`;
  const v = a.value;
  if (v.type === 'ident')
    return { ok: true, code: `{k:'i',x:${N(v)},i:${JSON.stringify(v.name)}${name}}` };
  if (v.type === 'num' || v.type === 'bool')
    return { ok: true, code: `{k:'l',x:${N(v)}${name}}` };
  const e = expr(v);
  if (!e.ok) return e;
  return { ok: true, code: `{k:'e',x:${N(v)},f:()=>${e.code}${name}}` };
}

function stmt(n: Node, depth: number): Emit {
  const pad = '  '.repeat(depth);
  switch (n.type) {
    case 'assign': case 'let': case 'const': {
      const v = expr(n.value);
      if (!v.ok) return v;
      return { ok: true, code: `${pad}R.decl(${N(n)},${JSON.stringify(n.name)},()=>${v.code});` };
    }
    case 'typed': {
      if (n.value === undefined) return { ok: true, code: `${pad}R.declNa(${N(n)},${JSON.stringify(n.name)});` };
      const v = expr(n.value);
      if (!v.ok) return v;
      return { ok: true, code: `${pad}R.decl(${N(n)},${JSON.stringify(n.name)},()=>${v.code});` };
    }
    case 'var': {
      if (n.multi && n.multi.length) return no;
      const v = expr(n.value);
      if (!v.ok) return v;
      return { ok: true, code: `${pad}R.varDecl(${N(n)},${JSON.stringify(n.name)},()=>${v.code});` };
    }
    case 'reassign': {
      if (n.target.type !== 'ident') return no;
      const v = expr(n.value);
      if (!v.ok) return v;
      return { ok: true, code: `${pad}R.set(${N(n)},${JSON.stringify(n.target.name)},()=>${v.code});` };
    }
    case 'if': {
      const T = expr(n.test);
      if (!T.ok) return T;
      let code = `${pad}if(R.truth(${T.code})){\n${arm(n.then, depth + 1)}\n${pad}}`;
      for (const e of n.elseIfs) {
        const ET = expr(e.test);
        if (!ET.ok) return ET;
        code += ` else if(R.truth(${ET.code})){\n${arm(e.body, depth + 1)}\n${pad}}`;
      }
      if (n.else) code += ` else{\n${arm(n.else, depth + 1)}\n${pad}}`;
      return { ok: true, code };
    }
    case 'seq': {
      const inner = n.stmts.map(s => stmt(s, depth));
      if (inner.some(i => !i.ok)) return no;
      return { ok: true, code: inner.map(i => i.ok ? i.code : '').join('\n') };
    }
    case 'break':    return { ok: true, code: `${pad}throw R.BREAK;` };
    case 'continue': return { ok: true, code: `${pad}throw R.CONTINUE;` };
    case 'return': {
      const v = n.value ? expr(n.value) : { ok: true as const, code: 'R.VOID' };
      if (!v.ok) return v;
      return { ok: true, code: `${pad}throw new R.Return(${v.code});` };
    }
    default: {
      const e = expr(n);
      if (e.ok) return { ok: true, code: `${pad}${e.code};` };
      return no;
    }
  }
}

/** Nested block: push a real child Scope, run stmts, pop. Mirrors evalBlock's
 *  blockFrame + scopeDepth/topLevelBody bookkeeping (done inside R.pushScope). */
function arm(stmts: Node[], depth: number): string {
  const pad = '  '.repeat(depth);
  return `${pad}R.pushScope();\n${pad}try{\n${block(stmts, depth + 1)}\n${pad}}finally{R.popScope();}`;
}

function block(stmts: Node[], depth: number): string {
  return stmts.map(s => {
    const e = stmt(s, depth);
    const body = e.ok ? e.code : `${'  '.repeat(depth)}R.evalStmt(${N(s)});`;
    // Per-stmt error wrap preserves wrapPineError(node) attribution.
    return `${'  '.repeat(depth)}try{\n${body}\n${'  '.repeat(depth)}}catch(e){R.stmtErr(e,${N(s)});}`;
  }).join('\n');
}

function collectAll(body: Node[]): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => {
    out[N(n)] = n;
    for (const v of Object.values(n)) walkObj(v);
  };
  // Arg wrappers (`{name?, value:Node}`) carry no `.type` — recurse every
  // object/array so `R.evalExpr(x)` indices resolve for arg nodes too.
  const walkObj = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walkObj(x); return; }
    if ('type' in v) walk(v as Node);
    else for (const x of Object.values(v)) walkObj(x);
  };
  body.forEach(walk);
  return out;
}

export interface JitCompileResult {
  /** JS source for `new Function('R','frame','run','nodes', src)`. */
  src: string;
  /** nodeTable[idx] → Node for R.evalStmt / R.stmtErr. */
  nodeTable: Node[];
  /** Top-level stmt counts (bench instrumentation). */
  native: number;
  fallback: number;
}

export function jitCompile(body: Node[]): JitCompileResult {
  nextIdx = 0;
  const table = collectAll(body);
  const src = body.map((s, i) => {
    const e = stmt(s, 0);
    const inner = e.ok ? e.code : `R.evalStmt(${N(s)});`;
    // topStmtIdx per stmt — slotFor's ensureList pruning reads it.
    return `run.topStmtIdx=${i};\ntry{\n${inner}\n}catch(e){R.stmtErr(e,${N(s)});}`;
  }).join('\n');
  let native = 0, fallback = 0;
  for (const s of body) (stmt(s, 0).ok ? native++ : fallback++);
  return { src, nodeTable: table, native, fallback };
}
