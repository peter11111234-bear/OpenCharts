// ── Compile-time script checks ──────────────────────────────────────────────
// PyneCore's four transform-time rejects — PlotScope / OuterWrite /
// ExportCapture / SecurityDrawings — plus the static ScriptRequirements scan,
// driven by ONE AST traversal (fused phases).
//
// The engine used to answer plot-in-local-scope with a runtime warn-and-skip
// (CE10188, builtins/util.ts). TradingView refuses to save such a script, so
// warn-and-skip produced numbers for a script TV would never run — a silent
// divergence. This module is the compile gate: the Vela adapter runs
// `assertScript` in prepare(), so the editor reports a source-located error
// before a single bar is evaluated. The runtime CE10188 guard stays as a safety
// net for callers that bypass prepare() (direct runScript in tests/CLI).
//
// Rule sources:
//   - tradingview.com/pine-script-docs/language/user-defined-functions — "the
//     body of a user-defined function cannot use the reassignment or compound
//     assignment operators to modify variables declared in the global scope.
//     Likewise, it cannot use these operators to reassign function parameters."
//   - TV "Cannot use 'plot' in local scope" — the output family registers once
//     at compile time, so if/for/switch/UDF bodies are rejected.
//   - PyneCore v6.10.8 release notes — library exports cannot capture
//     non-constant main() state; drawing constructors in request expressions
//     are rejected; plot/plotshape/fill/bgcolor and other declarations outside
//     the unconditional main() body raise a source-located error.
//   - Pine type qualifiers (const ⊂ input ⊂ simple ⊂ series): every input.*
//     `defval` except input.source's is `const` in TV, so a series default is a
//     compile error there and a wrong recorded default here. qualifiers.ts does
//     the inference; the request.security `timeframe` is deliberately NOT gated
//     — this engine resolves a dynamic sym/tf on purpose (mtf.ts's DYNAMIC
//     path), so rejecting it would delete a working feature.
//
// Fused phases are the point. `PINE_AST_SEQUENTIAL=1` (alias
// `PYNE_AST_SEQUENTIAL=1`, PyneCore's spelling) runs each rule as its own pass;
// checks_equivalence.test.ts asserts both modes emit identical diagnostics over
// the whole corpus. Both spellings live in debugFlags.ts — the single door for
// every diagnostic switch.

import type { ArrowFunc, Call, FuncDecl, Member, MethodDecl, Node, Reassign } from './contracts';
import { childNodes } from './astWalk';
import { debugFlag } from './debugFlags';
import { CONST_INPUTS, defvalArg, provenSeries } from './qualifiers';
import { ParseError } from './parser';
import type { ParsedInput } from './interpreter';

/** The output family that may only be called from the script's global scope. */
const PLOT_SCOPE = new Set([
  'plot', 'plotshape', 'plotchar', 'plotarrow', 'plotbar', 'plotcandle',
  'hline', 'fill', 'bgcolor', 'barcolor', 'alertcondition',
]);

/** Drawing constructors — rejected inside a request.* expression. */
const DRAW_CTORS = new Set([
  'line.new', 'label.new', 'box.new', 'table.new', 'polyline.new', 'linefill.new',
]);

/** strategy.* members that route an order (the broker gate). */
const ORDER_CALLS = new Set(['entry', 'order', 'exit', 'close', 'close_all', 'cancel', 'cancel_all']);

/** request.* members that need a foreign symbol/timeframe context. */
const SECURITY_REQS = new Set(['security', 'security_lower_tf']);

/** Builtins whose value depends on the chart viewport. */
const VIEWPORT_NAMES = new Set(['chart.left_visible_bar_time', 'chart.right_visible_bar_time']);

/** What a script needs from its host, derived statically from the AST. */
export interface ScriptRequirements {
  /** Second symbol/timeframe context (request.security[_lower_tf]). */
  security: boolean;
  /** External fundamentals/market data (request.dividends/earnings/…). */
  externalData: boolean;
  /** Routes orders (strategy.entry/order/exit/close/cancel family). */
  orders: boolean;
  /** Constructs drawing objects (line/label/box/table/polyline/linefill.new). */
  drawings: boolean;
  /** Fires alert()/alertcondition(). */
  alerts: boolean;
  /** Declares input.* values. */
  inputs: boolean;
  /** Plots the output family. */
  plots: boolean;
  /** Reads a viewport built-in → the host must re-run on viewport change. */
  viewport: boolean;
}

export interface CheckDiag {
  /** Rule id: plot-scope | outer-write | export-capture | security-drawings. */
  rule: string;
  line: number;
  col: number;
  message: string;
}

export interface CheckResult {
  diagnostics: CheckDiag[];
  requirements: ScriptRequirements;
}

/** Walk frame: what a rule needs to know about the current position. */
interface Frame {
  /** 0 = the script's global scope; >0 = a block/UDF/loop body. */
  depth: number;
  /** Enclosing function's parameter names, or null at global scope. */
  params: readonly string[] | null;
  /** Names declared inside the enclosing function (params may be shadowed). */
  locals: ReadonlySet<string> | null;
  /** Inside a request.security(...) argument subtree. */
  inSecurity: boolean;
}

interface Ctx {
  /** Names declared at the script's top level. */
  globals: Set<string>;
  /** Global names holding non-constant state (var/varip/reassigned). */
  mutable: Set<string>;
  /** Global name → the expression that initialised it (for qualifier lookups). */
  globalValues: Map<string, Node>;
  diags: CheckDiag[];
  req: ScriptRequirements;
}

type FuncNode = FuncDecl | ArrowFunc | MethodDecl;

interface Rule {
  id: string;
  call?(node: Call, name: string, f: Frame, ctx: Ctx): void;
  member?(node: Member, chain: string, f: Frame, ctx: Ctx): void;
  reassign?(node: Reassign, name: string, f: Frame, ctx: Ctx): void;
  /** Fired for every function body (func/arrow/method) before its statements. */
  enterFunc?(decl: FuncNode, f: Frame, ctx: Ctx): void;
}

const diag = (ctx: Ctx, node: Node, rule: string, message: string): void => {
  ctx.diags.push({ rule, line: node.loc?.line ?? 0, col: node.loc?.col ?? 0, message });
};

/** `a.b.c` for a callee/member chain, or null when the head is not an ident. */
function dottedName(node: Node): string | null {
  if (node.type === 'ident') return node.name;
  if (node.type === 'member' && !node.computed) {
    const base = dottedName(node.obj);
    return base === null ? null : `${base}.${node.prop}`;
  }
  return null;
}

const RULES: readonly Rule[] = [
  {
    id: 'plot-scope',
    call: (node, name, f, ctx) => {
      if (f.depth > 0 && PLOT_SCOPE.has(name)) {
        diag(ctx, node, 'plot-scope', `Cannot use '${name}' in local scope`);
      }
    },
  },
  {
    id: 'security-drawings',
    call: (node, name, f, ctx) => {
      if (f.inSecurity && DRAW_CTORS.has(name)) {
        diag(ctx, node, 'security-drawings',
          `Cannot construct a drawing object in a request.security() expression ('${name}')`);
      }
    },
  },
  {
    id: 'outer-write',
    reassign: (node, name, f, ctx) => {
      if (f.params === null) return;                       // global scope — legal in Pine
      // A declaration inside the function body shadows a global of the same
      // name (TV: "creates a new local variable ... shadowing the global one"),
      // so the reassignment targets the local, not the outer scope.
      if (f.locals?.has(name)) return;
      if (ctx.globals.has(name)) {
        diag(ctx, node, 'outer-write', `Cannot modify global variable '${name}' in a function`);
      } else if (f.params.includes(name)) {
        diag(ctx, node, 'outer-write', `Cannot modify function parameter '${name}'`);
      }
    },
  },
  {
    id: 'export-capture',
    enterFunc: (decl, _f, ctx) => {
      // Named exports only: an arrow has no name to report, and an exported
      // value (`export myConst = 5`) has no body to capture with.
      if (!decl.export) return;
      if (decl.type === 'arrow') return;
      const used = new Set<string>();
      const declared = new Set<string>(decl.params.map((p) => p.name));
      scanNames(decl.body, used, declared);
      for (const name of used) {
        if (!ctx.mutable.has(name)) continue;
        diag(ctx, decl, 'export-capture',
          `Exported function '${decl.name}' captures non-constant global '${name}'`);
      }
    },
  },
  {
    id: 'input-const',
    call: (node, name, _f, ctx) => {
      // TV documents every input.* `defval` (except input.source's) as `const`;
      // a series default is a compile error there and a wrong recorded default
      // here. `provenSeries` only fires on a demonstrable per-bar value, so a
      // script that runs today cannot be rejected by guesswork.
      if (!CONST_INPUTS.has(name)) return;
      const defval = defvalArg(node.args);
      if (defval === undefined) return;
      const globalValues = ctx.globalValues;
      if (provenSeries(defval, (n) => globalValues.get(n), ctx.mutable)) {
        diag(ctx, node, 'input-const',
          `Cannot call '${name}' with a series 'defval' — TV requires a const default`);
      }
    },
  },
  {
    id: 'requirements',
    call: (_node, name, _f, ctx) => {
      const req = ctx.req;
      if (name === 'input' || name.startsWith('input.')) req.inputs = true;
      if (PLOT_SCOPE.has(name)) req.plots = true;
      if (name === 'alert' || name === 'alertcondition') req.alerts = true;
      if (DRAW_CTORS.has(name)) req.drawings = true;
      if (name.startsWith('strategy.') && ORDER_CALLS.has(name.slice('strategy.'.length))) req.orders = true;
      if (name.startsWith('request.')) {
        if (SECURITY_REQS.has(name.slice('request.'.length))) req.security = true;
        else req.externalData = true;
      }
    },
    member: (_node, chain, _f, ctx) => {
      if (VIEWPORT_NAMES.has(chain)) ctx.req.viewport = true;
    },
  },
];

// ── name scans (hoisting pre-pass + export-capture) ─────────────────────────

/** Collect declared + referenced names in a subtree. Descends into functions —
 *  an inner UDF's capture is the outer function's capture too. */
function scanNames(node: Node | Node[], used: Set<string>, declared: Set<string>): void {
  for (const n of Array.isArray(node) ? node : [node]) {
    switch (n.type) {
      case 'ident': used.add(n.name); continue;
      case 'assign': case 'let': case 'const': declared.add(n.name); break;
      case 'var':
        declared.add(n.name);
        for (const m of n.multi ?? []) declared.add(m.name);
        break;
      case 'typed': declared.add(n.name); break;
      case 'tuple': for (const x of n.names) declared.add(x); break;
      case 'func': case 'method':
        declared.add(n.name);
        for (const p of n.params) declared.add(p.name);
        break;
      case 'arrow': for (const p of n.params) declared.add(p.name); break;
      case 'typedecl': declared.add(n.name); break;
      default: break;
    }
    scanNames(childNodes(n), used, declared);
  }
}

/** Top-level declarations → ctx.globals; var/varip/typed → non-constant. */
function collectGlobals(body: readonly Node[], ctx: Ctx): void {
  for (const s of body) {
    switch (s.type) {
      case 'assign': case 'let': case 'const':
        ctx.globals.add(s.name);
        ctx.globalValues.set(s.name, s.value);
        break;
      case 'var':
        ctx.globals.add(s.name);
        ctx.mutable.add(s.name);
        for (const m of s.multi ?? []) { ctx.globals.add(m.name); ctx.mutable.add(m.name); }
        break;
      case 'typed':
        ctx.globals.add(s.name);
        ctx.mutable.add(s.name);
        break;
      case 'tuple': for (const x of s.names) { ctx.globals.add(x); ctx.mutable.add(x); } break;
      case 'func': case 'method': case 'typedecl': ctx.globals.add(s.name); break;
      default: break;
    }
  }
}

/** Globals reassigned anywhere outside a function body hold mutable state. */
function markReassigned(node: Node | Node[], inFunc: boolean, ctx: Ctx): void {
  for (const n of Array.isArray(node) ? node : [node]) {
    if (n.type === 'reassign' && !inFunc) {
      const target = n.target;
      if (target.type === 'ident') ctx.mutable.add(target.name);
    }
    const nested = n.type === 'func' || n.type === 'arrow' || n.type === 'method';
    markReassigned(childNodes(n), inFunc || nested, ctx);
  }
}

// ── the walk ────────────────────────────────────────────────────────────────

interface Walk {
  rules: readonly Rule[];
  ctx: Ctx;
}

function walk(node: Node, f: Frame, w: Walk): void {
  const { rules, ctx } = w;
  switch (node.type) {
    case 'call': {
      const name = dottedName(node.callee);
      if (name !== null) {
        for (const r of rules) r.call?.(node, name, f, ctx);
      }
      // request.security(...) arguments are the rejected subtree.
      const secFrame = name !== null && name.startsWith('request.') &&
        SECURITY_REQS.has(name.slice('request.'.length)) ? { ...f, inSecurity: true } : f;
      for (const a of node.args) walk(a.value, secFrame, w);
      return;
    }
    case 'member': {
      const chain = dottedName(node);
      if (chain !== null) {
        for (const r of rules) r.member?.(node, chain, f, ctx);
      }
      walk(node.obj, f, w);
      return;
    }
    case 'reassign': {
      const target = node.target;
      if (target.type === 'ident') {
        for (const r of rules) r.reassign?.(node, target.name, f, ctx);
      }
      walk(target, f, w);
      walk(node.value, f, w);
      return;
    }
    case 'func': case 'arrow': case 'method': {
      for (const r of rules) r.enterFunc?.(node, f, ctx);
      const locals = new Set<string>();
      scanNames(node.body, new Set(), locals);
      const fnFrame: Frame = {
        depth: f.depth + 1,
        params: node.params.map((p) => p.name),
        locals,
        inSecurity: f.inSecurity,
      };
      for (const p of node.params) if (p.default !== undefined) walk(p.default, fnFrame, w);
      for (const s of Array.isArray(node.body) ? node.body : [node.body]) walk(s, fnFrame, w);
      return;
    }
    case 'seq':
      for (const s of node.stmts) walk(s, f, w);
      return;
    case 'if': case 'ifexpr': {
      walk(node.test, f, w);
      for (const part of [node.then, ...node.elseIfs.map((e) => e.body), node.else]) {
        if (part === null || part === undefined) continue;
        for (const s of part) walk(s, { ...f, depth: f.depth + 1 }, w);
      }
      return;
    }
    case 'for': {
      walk(node.from, f, w);
      walk(node.to, f, w);
      if (node.step !== undefined) walk(node.step, f, w);
      const body: Frame = {
        ...f,
        depth: f.depth + 1,
        locals: new Set([...(f.locals ?? []), node.varName]),
      };
      for (const s of node.body) walk(s, body, w);
      return;
    }
    case 'while': {
      walk(node.test, f, w);
      for (const s of node.body) walk(s, { ...f, depth: f.depth + 1 }, w);
      return;
    }
    case 'switch': {
      if (node.subject !== undefined) walk(node.subject, f, w);
      for (const c of node.cases) {
        if (c.test !== undefined) walk(c.test, f, w);
        for (const s of c.body) walk(s, { ...f, depth: f.depth + 1 }, w);
      }
      return;
    }
    default:
      for (const child of childNodes(node)) walk(child, f, w);
  }
}

/** Analyse a parsed script: language-rule diagnostics + host requirements.
 *  `sequential` runs each rule as its own pass (the PyneCore equivalence check;
 *  also available as PINE_AST_SEQUENTIAL=1 / PYNE_AST_SEQUENTIAL=1). */
export function checkScript(parsed: ParsedInput, sequential?: boolean): CheckResult {
  const body = Array.isArray(parsed) ? parsed : parsed.body;
  const decl = Array.isArray(parsed) ? null : parsed.decl;
  const ctx: Ctx = {
    globals: new Set(),
    mutable: new Set(),
    globalValues: new Map(),
    diags: [],
    req: {
      security: false, externalData: false, orders: false, drawings: false,
      alerts: false, inputs: false, plots: false, viewport: false,
    },
  };
  collectGlobals(body, ctx);
  markReassigned(body, false, ctx);

  const seq = sequential ?? debugFlag('astSequential');
  const passes = seq ? RULES.map((r) => [r]) : [RULES];
  for (const rules of passes) {
    const w: Walk = { rules, ctx };
    const global: Frame = { depth: 0, params: null, locals: null, inSecurity: false };
    if (decl !== null && decl !== undefined) walk(decl, global, w);
    for (const s of body) walk(s, global, w);
  }
  // Fused and sequential modes visit rules in different orders — normalise.
  ctx.diags.sort((a, b) =>
    a.line - b.line || a.col - b.col || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  return { diagnostics: ctx.diags, requirements: ctx.req };
}

/** Compile gate: throw a source-located ParseError on the first diagnostic. */
export function assertScript(parsed: ParsedInput): ScriptRequirements {
  const { diagnostics, requirements } = checkScript(parsed);
  const first = diagnostics[0];
  if (first !== undefined) {
    throw new ParseError({ line: first.line, col: first.col }, `${first.message} [${first.rule}]`);
  }
  return requirements;
}
