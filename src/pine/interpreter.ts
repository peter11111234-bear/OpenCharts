// ── Pine evaluator ───────────────────────────────────────────────────────────
// Bar-sequential interpreter over the contracts.ts AST.
//
// Slot model (Pine semantics):
//   * Every named variable owns ONE BarSeries for the whole run, keyed by the
//     declaring AST node (declSlots). BarSeries.setAt overwrites same-bar
//     writes and `ensureBar` carries forward values across bars where a
//     statement didn't execute — correct `x[1]` history for branch-local and
//     `var` bindings alike.
//   * `var x = e` evaluates `e` the first time the decl executes, then only
//     re-binds the slot afterwards (top-level `var` therefore inits at bar 0).
//   * `expr[n]` reads via histGetAt; non-Ident expressions get a lazily
//     created BarSeries in callHist so `ta.sma(close,20)[1]` has history.
//   * Function params are transient BarSeries seeded at the current bar, or an
//     ALIAS of the caller's slot when the arg is a bare identifier — so
//     `f(x) => x[1]` sees the caller's history.
//
// Peer seams:
//   * builtins/registry.ts — BUILTINS / getConstant / registerConstant
//   * builtins/util.ts     — RtCtx extension fields populated per run
//   * udt.ts               — type/method/field/dispatch (direct import)
//   * mtf.ts               — registerMtf({tryEvalSecurity, prepareSecurity,
//                            prefetchSecurity}) — injected, no static import.

import {
  BREAK,
  CONTINUE,
  NA,
  ReturnSignal,
  Series,
  VFALSE,
  VTRUE,
  type Arg,
  type BarData,
  type BuiltinCtx,
  type BuiltinFn,
  type Call,
  type ForStmt,
  type HistRef,
  type IndicatorDecl,
  type InputSchemaLite,
  type Member,
  type Node,
  type Param,
  type PlotOpts,
  type Reassign,
  type RunResult,
  type StrategyDecl,
  type SwitchStmt,
  type UdfDecl,
  type Value,
  type WhileStmt,
} from './contracts';
import { PineRuntimeError, pineErr, wrapPineError } from './errors';
import { FOR_IN } from './parser';
import { BarSeries, ForwardingSeries, LitSeries, histGetAt, valueAt } from './series';
import { Scope, blockFrame, seriesOf, type Frame } from './scope';
import { BarCtx, MemoryDrawSink } from './context';
import { BUILTINS, getConstant, kindBuiltin, registerConstant } from './builtins/registry';
import { truthy, drainBindWarnings, type RtCtx } from './builtins/util';
import { declDrawQuotas, INDICATOR_DECL_ORDER } from './builtins/draw';
import { strategyDecl, execsAt } from './builtins/strategy';
import {
  UDT_REGISTRY,
  bindUdtGlobalScope,
  callUdtMethod,
  getField,
  getUdtMethod,
  isUdtType,
  newUdt,
  registerMethod,
  registerType,
  setField,
} from './udt';

export type { Frame } from './scope';
export { PineRuntimeError } from './errors';

// ── MTF injection seam ────────────────────────────────────────────────────────

export interface MtfHooks {
  tryEvalSecurity(node: Node, frame: Frame): Value | null;
  prepareSecurity(body: Node[], frame0?: unknown): void;
  prefetchSecurity(ctx: BuiltinCtx, frame?: Frame, chartBars?: BarData[]): Promise<void>;
  /** mtf.ts binds evaluator adapters for its tf child frames. */
  bindEval?: (
    e: (n: Node, s: Scope, c: BuiltinCtx) => Value,
    b: (st: Node[], s: Scope, c: BuiltinCtx) => Value,
  ) => void;
}

let mtf: MtfHooks | null = null;

export function registerMtf(h: MtfHooks): void {
  mtf = h;
  h.bindEval?.(
    (n, s, c) => evalExpr(n, { scope: s, ctx: c }),
    (st, s, c) => evalBlock(st, { scope: s, ctx: c }),
  );
}

// ── per-run state ─────────────────────────────────────────────────────────────

interface RunState {
  /** Declaring node → the variable's BarSeries (stable across bars/scopes). */
  declSlots: Map<object, BarSeries>;
  /** Slots registered for bar-end densification — dedup for ensureList
   *  (post-pruning this holds ONLY slots that still need ensureBar). */
  trackedSlots: Set<BarSeries>;
  /** Registered slots in registration order — the bar-end densify list. */
  ensureList: BarSeries[];
  /** True only while the top-level `for (const stmt of body)` loop runs —
   *  decl slots created here are written every bar, so their ensureBar is a
   *  guaranteed no-op and they stay out of ensureList. */
  topLevelBody: boolean;
  /** Index of the currently-executing top-level stmt (-1 = not in the
   *  top-level loop). Together with pruneCutoff this decides whether a
   *  decl slot created here is provably written every bar. */
  topStmtIdx: number;
  /** First top-level stmt index that may skip the rest of the bar
   *  (top-level break/continue/return, bare or inside an if/switch arm or
   *  loop exit). Decls at or after it aren't provably written every bar,
   *  so their slots stay registered. Infinity = no early exit in body. */
  pruneCutoff: number;
  /** `expr[n]` on non-Ident obj → lazily tracked BarSeries. */
  callHist: Map<Node, BarSeries>;
  /** Call node → stable callsite id for plot/alert routing. */
  callsites: Map<Node, string>;
  callsiteSeq: number;
  /** Stack of active callsite ids (UDF nesting). Empty = top level. */
  siteStack: string[];
  nodeIds: Map<object, number>;
  nodeSeq: number;
  /** Site-path trie: callsite string → … → nodeId number → stable key object
   *  for declSlots/callHist/tupleKeys. Replaces join('|') string keys —
   *  callsite strings ('#N') and nodeId numbers live in separate key spaces,
   *  so a leaf map can mix both without collision. */
  siteTrie: Map<unknown, unknown>;
  warned: Set<string>;
  /** Top-level frame of the current bar (ctx.callUdf re-enters here). */
  topFrame: Frame | null;
  /** One-off per-run slots (bar_index synth). */
  misc: Map<string, BarSeries>;
  /** TupleAssign node → per-name slot keys. */
  tupleKeys: Map<Node, Map<string, object>>;
  /** callsite key → param name → persistent CowSeries (UDF-local series carry bar history). */
  paramCows: Map<object, Map<string, CowSeries>>;
}

const runStates = new WeakMap<BuiltinCtx, RunState>();

function runOf(ctx: BuiltinCtx): RunState {
  let r = runStates.get(ctx);
  if (!r) {
    r = {
      declSlots: new Map(),
      trackedSlots: new Set(),
      ensureList: [],
      topLevelBody: false,
      topStmtIdx: -1,
      pruneCutoff: Infinity,
      callHist: new Map(),
      callsites: new Map(),
      callsiteSeq: 0,
      siteStack: [],
      nodeIds: new Map(),
      nodeSeq: 0,
      siteTrie: new Map(),
      warned: new Set(),
      topFrame: null,
      misc: new Map(),
      tupleKeys: new Map(),
      paramCows: new Map(),
    };
    runStates.set(ctx, r);
  }
  return r;
}

function warn(run: RunState, ctx: BuiltinCtx, msg: string): void {
  if (run.warned.has(msg)) return;
  run.warned.add(msg);
  ctx.warnings.push(msg);
}

// ── value helpers ─────────────────────────────────────────────────────────────

function isNum(v: Value): v is { kind: 'int' | 'float'; v: number } {
  return v.kind === 'int' || v.kind === 'float';
}

function numVal(n: number, preferInt: boolean): Value {
  return preferInt && Number.isInteger(n) ? { kind: 'int', v: n } : { kind: 'float', v: n };
}

/** Builtins may hand back `{kind:'series'}`; interpreter ops read the current bar. */
function unseries(v: Value): Value {
  return v.kind === 'series' ? v.v.cur() : v;
}

function unseriesTruth(v: Value): boolean {
  return truthy(unseries(v));
}

/**
 * Copy-on-write series wrapper for UDF params bound by alias. Reads delegate
 * to the caller's slot (so `x[1]` sees caller history); the first `x := e`
 * materializes a private BarSeries copy of the caller's recorded history, so
 * writes stay local to the call — Pine `param :=` rebinds a local.
 */
class CowSeries extends ForwardingSeries {
  private cow: BarSeries | null = null;

  private inner: Series;

  constructor(inner: Series) {
    super();
    this.inner = inner;
  }

  override readTarget(): Series {
    return this.cow ?? this.inner;
  }

  /** Re-point at the caller's (possibly new) slot at the next bar —
   *  keeps the materialized local copy (post-`:=` history) intact. */
  rebind(inner: Series): void { this.inner = inner; }

  /** Re-seed the current bar's slot with the arg value — Pine re-binds params
   *  every invocation, so a carried-forward `:=` value must not leak into the
   *  next bar's reads. No-op until a write materialized the local copy. */
  seed(v: Value, bar: number): void {
    if (this.cow) this.cow.setAt(bar, v);
  }

  /** Materialize the private copy, mapping `inner`'s history onto bar indexes. */
  private writable(bar: number): BarSeries {
    if (this.cow) return this.cow;
    const src = this.inner;
    const base = src instanceof BarSeries ? src.currentBar : Math.max(bar, 0);
    const copy = new BarSeries();
    for (let b = 0; b <= base; b++) copy.setAt(b, histGetAt(src, base - b, base));
    this.cow = copy;
    return copy;
  }

  override get currentBar(): number {
    return this.cow ? this.cow.currentBar
      : this.inner instanceof BarSeries ? this.inner.currentBar : 0;
  }
  override setAt(bar: number, v: Value): void {
    this.writable(this.cow ? this.cow.currentBar : bar).setAt(bar, v);
  }
  override set(v: Value): void {
    if (this.cow) this.cow.set(v);
    else this.writable(0).set(v);
  }
  override get(n: number): Value {
    return (this.cow ?? this.inner).get(n);
  }
  override cur(): Value {
    return (this.cow ?? this.inner).cur();
  }
  override size(): number {
    return (this.cow ?? this.inner).size();
  }
  override atOffset(bar: number, n: number): Value {
    const src = this.cow ?? this.inner;
    return src instanceof BarSeries ? src.atOffset(bar, n) : src.get(n);
  }
  override ensureBar(bar: number): void {
    if (this.cow) this.cow.ensureBar(bar);
    else if (this.inner instanceof BarSeries) this.inner.ensureBar(bar);
  }
}

/** Pine default stringification (`+` concat, warnings). */
export function pineStr(v: Value): string {
  switch (v.kind) {
    case 'na': return 'NaN';
    case 'int': case 'float': return String(v.v);
    case 'bool': return v.v ? 'true' : 'false';
    case 'string': return v.v;
    case 'color': return v.v;
    case 'series': return pineStr(v.v.cur());
    case 'void': return 'void';
    case 'function': return 'function';
    case 'array': return `[${v.v.map(pineStr).join(', ')}]`;
    case 'udt': return v.v.typeName;
    default: return v.kind;
  }
}

// ── slot management ───────────────────────────────────────────────────────────

/**
 * The BarSeries backing a declaration, keyed by an object unique to the name
 * (the decl node, or a per-item object for `var a=…, b=…` and tuple assigns).
 * Re-binding the same slot in the current scope keeps history stable across
 * bars and nested block scopes.
 */

/**
 * Per-callsite slot key: top-level code keys by decl node; inside a UDF the
 * same AST node is shared across callsites, so compose with the site path.
 */
function siteKey(run: RunState, node: object): object {
  const stack = run.siteStack;
  if (stack.length === 0) return node;
  let id = run.nodeIds.get(node);
  if (id === undefined) { id = run.nodeSeq++; run.nodeIds.set(node, id); }
  // Walk/create the trie: root → site1 → site2 → … → leaf nodeId → object.
  // Callsite keys are '#N' strings, nodeIds are numbers — no key-space
  // collision at the leaf level.
  let m: Map<unknown, unknown> = run.siteTrie;
  for (const s of stack) {
    let next = m.get(s) as Map<unknown, unknown> | undefined;
    if (next === undefined) { next = new Map(); m.set(s, next); }
    m = next;
  }
  let leaf = m.get(id) as object | undefined;
  if (leaf === undefined) { leaf = {}; m.set(id, leaf); }
  return leaf;
}

/** Register a slot for bar-end densification (deduped via trackedSlots). */
function trackSeries(run: RunState, s: BarSeries): void {
  if (!run.trackedSlots.has(s)) {
    run.trackedSlots.add(s);
    run.ensureList.push(s);
  }
}

/** Child nodes of an AST node (skips scalars like loc/type/name). Shared
 *  with mtf.ts's gate walker via this export (F11). */
export function astChildren(node: object): Node[] {
  const out: Node[] = [];
  const collect = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const it of v) collect(it);
    } else if ('type' in v) {
      out.push(v as Node);
    } else {
      // Wrapper objects without a `type` field — elseIfs entries
      // ({test, body}), call args ({name?, value}), var-multi items
      // ({name, typeAnn?, value}), switch cases — transparently expose
      // their Node-valued fields. No visited set needed: the parser
      // emits trees, and an (impossible) shared subtree would only
      // rescan nodes, never corrupt the result.
      for (const inner of Object.values(v)) collect(inner);
    }
  };
  for (const v of Object.values(node)) collect(v);
  return out;
}

/**
 * May evaluating this top-level stmt skip the REST of the body's stmts?
 * `return` always exits the run; `break`/`continue` exit the top-level
 * sequence unless a loop or switch on the path absorbs them (`for`/
 * `while` absorb both in their body, `switch` absorbs `break` in matched
 * case bodies). Function bodies are opaque — their `return`/`break`/
 * `continue` can't escape to the top level. Used once per run to pick
 * `run.pruneCutoff`: decls at or after an early-exit stmt aren't provably
 * written every bar, so their slots keep registering for ensureBar.
 */
function stmtMayExitTop(n: Node, absorbBreak: boolean, absorbCont: boolean): boolean {
  switch (n.type) {
    case 'return': return true;
    case 'break': return !absorbBreak;
    case 'continue': return !absorbCont;
    case 'func': case 'method': case 'arrow': return false;
    case 'for': case 'while': {
      // Loop bodies absorb break/continue; bound/test exprs can't contain
      // them, but scan generically with the outer flags anyway.
      const loop = n as { body?: Node[]; from?: Node; to?: Node; step?: Node; test?: Node };
      for (const s of loop.body ?? []) if (stmtMayExitTop(s, true, true)) return true;
      for (const e of [loop.from, loop.to, loop.step, loop.test]) {
        if (e && stmtMayExitTop(e, absorbBreak, absorbCont)) return true;
      }
      return false;
    }
    case 'switch': {
      const sw = n as { subject?: Node; cases?: { test?: Node; body?: Node[] }[] };
      if (sw.subject && stmtMayExitTop(sw.subject, absorbBreak, absorbCont)) return true;
      for (const c of sw.cases ?? []) {
        if (c.test && stmtMayExitTop(c.test, absorbBreak, absorbCont)) return true;
        // Only matched arms (c.test !== undefined) run inside a try that
        // absorbs BREAK — evalSwitch catches BREAK around c.test arms
        // only; the default arm propagates break/continue out, so its
        // body scans with the outer absorbBreak. CONTINUE escapes every
        // arm either way (absorbCont unchanged).
        const armAbsorb = c.test !== undefined ? true : absorbBreak;
        for (const s of c.body ?? []) {
          if (stmtMayExitTop(s, armAbsorb, absorbCont)) return true;
        }
      }
      return false;
    }
    default: {
      for (const c of astChildren(n)) {
        if (stmtMayExitTop(c, absorbBreak, absorbCont)) return true;
      }
      return false;
    }
  }
}

/**
 * The BarSeries backing a declaration. `persistent` slots (var decls —
 * written once then carried) and slots created outside the top-level body
 * (if/for/while/switch arms, seq, UDF bodies — conditionally executed) must
 * be densified at every bar end, so they join ensureList. Top-level non-var
 * decl slots are setAt every bar, which makes ensureBar a guaranteed no-op;
 * skipping their registration is a pure perf win with identical semantics —
 * UNLESS the stmt sits at/after a top-level early-exit point: a `break`/
 * `continue`/`return` (bare or inside an if arm) can skip the rest of the
 * body on some bar, leaving that decl unwritten and its history misaligned.
 * `run.pruneCutoff` marks the first such stmt; at-or-after decls register.
 */
function slotFor(
  run: RunState,
  key: object,
  scope: Scope,
  name: string,
  persistent = false,
): BarSeries {
  let s = run.declSlots.get(key);
  if (!s) {
    s = new BarSeries();
    run.declSlots.set(key, s);
    if (persistent || !run.topLevelBody || run.topStmtIdx >= run.pruneCutoff) {
      trackSeries(run, s);
    }
  }
  scope.define(name, s);
  return s;
}

/** Write a declaration value: series-valued results alias the inner series. */
function bindDeclared(
  run: RunState,
  key: object,
  scope: Scope,
  name: string,
  v: Value,
  bar: number,
  persistent = false,
): BarSeries {
  if (v.kind === 'series' && v.v instanceof BarSeries) {
    // Aliased decl (x = y): registration stays unconditional — the alias
    // target's own write cadence is unknown, and add is deduped anyway.
    trackSeries(run, v.v);
    scope.define(name, v.v);
    run.declSlots.set(key, v.v);
    return v.v;
  }
  const s = slotFor(run, key, scope, name, persistent);
  s.setAt(bar, v);
  return s;
}

// ── exports: evalExpr / evalBlock ─────────────────────────────────────────────

export function evalExpr(node: Node, frame: Frame): Value {
  try {
    return evalNode(node, frame);
  } catch (e) {
    if (e === BREAK || e === CONTINUE || e instanceof ReturnSignal) throw e;
    throw wrapPineError(e, node);
  }
}

export function evalBlock(stmts: Node[], frame: Frame): Value {
  // evalBlock runs only for nested bodies (if/for/while/switch arms, UDF
  // blocks, seq) — bump scopeDepth so global-scope-only builtins (plot family,
  // CE10188) can warn-and-skip.
  const rt = frame.ctx as RtCtx;
  rt.scopeDepth = (rt.scopeDepth ?? 0) + 1;
  // Nested bodies may run conditionally — decl slots created here are NOT
  // provably written every bar, so they must register for ensureBar.
  const run = runOf(frame.ctx);
  const wasTop = run.topLevelBody, wasIdx = run.topStmtIdx;
  run.topLevelBody = false; run.topStmtIdx = -1;
  try {
    let last: Value = { kind: 'void' };
    for (const s of stmts) last = evalExpr(s, frame);
    return last;
  } finally {
    run.topLevelBody = wasTop; run.topStmtIdx = wasIdx;
    rt.scopeDepth!--;
  }
}

// ── dispatcher ────────────────────────────────────────────────────────────────


function ctxSeries(ctx: BuiltinCtx, name: string): Series | undefined {
  switch (name) {
    case 'open': return ctx.open;
    case 'high': return ctx.high;
    case 'low': return ctx.low;
    case 'close': return ctx.close;
    case 'volume': return ctx.volume;
    case 'time': return ctx.time;
    case 'hl2': return ctx.hl2;
    case 'hlc3': return ctx.hlc3;
    case 'ohlc4': return ctx.ohlc4;
    case 'hlcc4': return ctx.hlcc4;
    default: return undefined;
  }
}

function evalNode(node: Node, frame: Frame): Value {
  const { scope, ctx } = frame;
  const run = runOf(ctx);
  const bar = ctx.barIndex;

  switch (node.type) {
    case 'num': return numVal(node.v, node.isInt);
    case 'str': return { kind: 'string', v: node.v };
    case 'bool': return node.v ? VTRUE : VFALSE;
    case 'color': return { kind: 'color', v: node.v };
    case 'na': return NA;

    case 'ident': return evalIdent(node.name, frame);

    case 'unary': return evalUnary(node.op, unseries(evalExpr(node.arg, frame)));

    case 'binary': {
      const op = node.op;
      if (op === 'and') {
        const l = unseriesTruth(evalExpr(node.left, frame));
        return l && unseriesTruth(evalExpr(node.right, frame)) ? VTRUE : VFALSE;
      }
      if (op === 'or') {
        const l = unseriesTruth(evalExpr(node.left, frame));
        return l || unseriesTruth(evalExpr(node.right, frame)) ? VTRUE : VFALSE;
      }
      return evalBinary(
        op,
        unseries(evalExpr(node.left, frame)),
        unseries(evalExpr(node.right, frame)),
        run,
        ctx,
      );
    }

    case 'ternary': {
      const t = unseriesTruth(evalExpr(node.test, frame));
      return evalExpr(t ? node.cons : node.alt, frame);
    }

    case 'histref': return evalHistref(node, frame);

    case 'call': return evalCall(node, frame);

    case 'member': return evalMember(node, frame);

    case 'arraylit':
      return { kind: 'array', v: node.items.map(i => evalExpr(i, frame)) };

    // ── declarations / assignment ──────────────────────────────────────

    case 'assign':
    case 'let':
    case 'const': {
      const v = evalExpr(node.value, frame);
      bindDeclared(run, siteKey(run, node), scope, node.name, v, bar);
      return v.kind === 'series' ? v.v.cur() : v;
    }

    case 'typed': {
      if (node.value === undefined) {
        slotFor(run, siteKey(run, node), scope, node.name).setAt(bar, NA);
        return NA;
      }
      const v = evalExpr(node.value, frame);
      bindDeclared(run, siteKey(run, node), scope, node.name, v, bar);
      return v.kind === 'series' ? v.v.cur() : v;
    }

    case 'var': {
      if (node.varip) warn(run, ctx, `varip treated as var (realtime-bar persistence not implemented)`);
      const items = node.multi && node.multi.length > 0 ? node.multi : [node];
      let last: Value = NA;
      for (const it of items) {
        const dk = siteKey(run, it);
        const fresh = !run.declSlots.has(dk);
        if (fresh) {
          const v = evalExpr(it.value, frame);
          bindDeclared(run, dk, scope, it.name, v, bar, /*persistent*/ true);
          last = v.kind === 'series' ? v.v.cur() : v;
        } else {
          const s = run.declSlots.get(dk)!;
          scope.define(it.name, s);
          last = valueAt(s, bar);
        }
      }
      return last;
    }

    case 'tuple': {
      let keys = run.tupleKeys.get(siteKey(run, node) as Node);
      if (!keys) {
        keys = new Map();
        run.tupleKeys.set(siteKey(run, node) as Node, keys);
      }
      if (node.var) {
        // `var [a,b] = f()`: evaluate + bind on the first execution
        // only; later executions re-bind the names to their persistent
        // slots (ensureBar carry-forward supplies `x[1]` history),
        // matching scalar `var x = e`.
        const fresh = node.names.some(n => {
          const k = keys!.get(n);
          return k === undefined || !run.declSlots.has(k);
        });
        if (!fresh) {
          const carried: Value[] = [];
          for (const name of node.names) {
            const s = run.declSlots.get(keys!.get(name)!);
            if (s) {
              scope.define(name, s);
              carried.push(valueAt(s, bar));
            } else {
              carried.push(NA);
            }
          }
          return { kind: 'array', v: carried };
        }
      }
      const v = evalExpr(node.value, frame);
      const items =
        v.kind === 'array' ? v.v : v.kind === 'matrix' ? v.v.flat() : [v];
      node.names.forEach((name, i) => {
        let k = keys!.get(name);
        if (!k) {
          k = {};
          keys!.set(name, k);
        }
        slotFor(run, k, scope, name, /*persistent*/ !!node.var).setAt(bar, items[i] ?? NA);
      });
      return v;
    }

    case 'reassign': return evalReassign(node, frame);

    // ── control flow ────────────────────────────────────────────────────

    case 'if':
    case 'ifexpr': {
      let branch: Node[] | null = null;
      if (unseriesTruth(evalExpr(node.test, frame))) {
        branch = node.then;
      } else {
        for (const e of node.elseIfs) {
          if (unseriesTruth(evalExpr(e.test, frame))) {
            branch = e.body;
            break;
          }
        }
        if (branch === null) branch = node.else;
      }
      if (branch === null) return node.type === 'ifexpr' ? NA : { kind: 'void' };
      return evalBlock(branch, blockFrame(frame));
    }

    case 'for': return evalFor(node, frame);
    case 'while': return evalWhile(node, frame);
    case 'switch': return evalSwitch(node, frame);
    case 'break': throw BREAK;
    case 'continue': throw CONTINUE;
    case 'return':
      throw new ReturnSignal(
        node.value ? unseries(evalExpr(node.value, frame)) : { kind: 'void' },
      );

    // ── functions / types ───────────────────────────────────────────────

    case 'func': {
      const decl: UdfDecl = {
        name: node.name,
        params: node.params,
        body: node.body,
        closure: scope,
      };
      scope.define(node.name, { kind: 'function', v: decl });
      return { kind: 'void' };
    }

    case 'arrow':
      return {
        kind: 'function',
        v: { name: '<anonymous>', params: node.params, body: node.body, closure: scope },
      };

    case 'method':
      registerMethod(node);
      return { kind: 'void' };

    case 'typedecl':
      registerType(node);
      return { kind: 'void' };

    case 'field': return { kind: 'void' };

    case 'import':
      warn(run, ctx, `import '${node.ns}.${node.name}' ignored (libraries not supported)`);
      return { kind: 'void' };

    case 'export': return evalExpr(node.decl, frame);

    case 'seq': return evalBlock(node.stmts, frame);

    case 'indicator':
      declDrawQuotas(ctx, node.args, INDICATOR_DECL_ORDER);
      return { kind: 'void' };
    case 'strategy':
      strategyDecl(ctx, node);
      return { kind: 'void' };
  }
}

// ── identifiers ───────────────────────────────────────────────────────────────

function evalIdent(name: string, frame: Frame): Value {
  const { scope, ctx } = frame;
  const run = runOf(ctx);
  const bar = ctx.barIndex;

  const slot = scope.lookup(name);
  if (slot !== undefined) {
    return slot instanceof Series ? valueAt(slot, bar) : slot;
  }
  const s = ctxSeries(ctx, name);
  if (s) return valueAt(s, bar);
  if (name === 'bar_index') return valueAt(barIndexSeries(run, ctx), bar);
  if (name === 'last_bar_index') return { kind: 'int', v: ctx.barCount - 1 };
  if (name === 'barstate') return { kind: 'udt', v: barstateUdt(ctx) };
  if (name === 'syminfo') {
    return { kind: 'udt', v: { typeName: 'syminfo', fields: new Map(Object.entries(ctx.syminfo)) } };
  }
  if (name === 'timeframe') {
    return { kind: 'udt', v: { typeName: 'timeframe', fields: timeframeFields(ctx) } };
  }

  // Constants first: bare calendar vars (hour/minute/…) are lazy series
  // constants that must shadow their builtin call forms; the call form
  // `hour(t)` is unaffected — evalCallDispatch checks BUILTINS first.
  const c = getConstant(name, ctx);
  if (c !== undefined) return c;
  const b = BUILTINS.get(name);
  if (b) return { kind: 'function', v: b };

  warn(run, ctx, `identifier '${name}' not found`);
  return NA;
}

/** Synthetic per-run bar_index series (`close[bar_index]` needs the ident as Series). */
function barIndexSeries(run: RunState, ctx: BuiltinCtx): BarSeries {
  let s = run.misc.get('bar_index');
  if (!s) {
    s = new BarSeries();
    run.misc.set('bar_index', s);
    trackSeries(run, s);
  }
  for (let i = s.currentBar + 1; i <= ctx.barIndex; i++) s.setAt(i, { kind: 'int', v: i });
  return s;
}

function barstateUdt(ctx: BuiltinCtx): { typeName: string; fields: Map<string, Value> } {
  const b = ctx.barIndex;
  const n = ctx.barCount;
  const fields = new Map<string, Value>([
    ['isnew', n > 0 ? VTRUE : VFALSE],
    ['islast', b === n - 1 ? VTRUE : VFALSE],
    ['isfirst', b === 0 ? VTRUE : VFALSE],
    ['ishistory', b < n - 1 ? VTRUE : VFALSE],
    ['isrealtime', VFALSE],
    ['isconfirmed', n > 0 ? VTRUE : VFALSE],
    ['islastconfirmedhistory', b === n - 1 ? VTRUE : VFALSE],
  ]);
  return { typeName: 'barstate', fields };
}

function timeframeFields(ctx: BuiltinCtx): Map<string, Value> {
  const t = ctx.timeframe;
  const bool = (x: boolean): Value => (x ? VTRUE : VFALSE);
  return new Map<string, Value>([
    ['period', { kind: 'string', v: t.period }],
    ['multiplier', { kind: 'int', v: t.multiplier }],
    ['isseconds', bool(t.isseconds)],
    ['isminutes', bool(t.isminutes)],
    ['isdaily', bool(t.isdaily)],
    ['isweekly', bool(t.isweekly)],
    ['ismonthly', bool(t.ismonthly)],
    ['isintraday', bool(t.isintraday)],
    ['isdwm', bool(t.isdaily || t.isweekly || t.ismonthly)],
  ]);
}

// ── operators ────────────────────────────────────────────────────────────────

function evalUnary(op: string, a: Value): Value {
  switch (op) {
    case '-':
      if (a.kind === 'na') return NA;
      return isNum(a) ? numVal(-a.v, a.kind === 'int') : NA;
    case '+':
      return isNum(a) || a.kind === 'na' ? a : NA;
    case 'not':
    case '!':
      return truthy(a) ? VFALSE : VTRUE;
    default:
      return NA;
  }
}

function evalBinary(op: string, l: Value, r: Value, run: RunState, ctx: BuiltinCtx): Value {
  // Comparisons with na → false (TV v6: na never compares equal/true).
  const isCmp = op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=';
  if (isCmp && (l.kind === 'na' || r.kind === 'na')) return VFALSE;
  if (op === '==' || op === '!=') {
    const res = valueEq(l, r) ? VTRUE : VFALSE;
    return op === '!=' ? (res === VTRUE ? VFALSE : VTRUE) : res;
  }

  if (l.kind === 'na' || r.kind === 'na') return NA;

  // int+float → float; int/int → float (Pine `/` never truncates); /0 and %0 → na.
  if (isNum(l) && isNum(r)) {
    const bothInt = l.kind === 'int' && r.kind === 'int';
    switch (op) {
      case '+': return numVal(l.v + r.v, bothInt);
      case '-': return numVal(l.v - r.v, bothInt);
      case '*': return numVal(l.v * r.v, bothInt);
      case '/':
        if (r.v === 0) return NA;
        return { kind: 'float', v: l.v / r.v };
      case '%': {
        // TV modulo is floor-based: a - b*floor(a/b) → sign follows the divisor.
        if (r.v === 0) return NA;
        return numVal(l.v - r.v * Math.floor(l.v / r.v), bothInt);
      }
      case '<': return l.v < r.v ? VTRUE : VFALSE;
      case '>': return l.v > r.v ? VTRUE : VFALSE;
      case '<=': return l.v <= r.v ? VTRUE : VFALSE;
      case '>=': return l.v >= r.v ? VTRUE : VFALSE;
    }
  }

  if (op === '+' && (l.kind === 'string' || r.kind === 'string')) {
    return { kind: 'string', v: pineStr(l) + pineStr(r) };
  }

  if (l.kind === 'bool' && r.kind === 'bool') {
    switch (op) {
      case '<': return !l.v && r.v ? VTRUE : VFALSE;
      case '>': return l.v && !r.v ? VTRUE : VFALSE;
      case '<=': return !l.v || r.v ? VTRUE : VFALSE;
      case '>=': return l.v || !r.v ? VTRUE : VFALSE;
    }
  }

  warn(run, ctx, `cannot apply '${op}' to ${l.kind} and ${r.kind}`);
  return NA;
}

function valueEq(l: Value, r: Value): boolean {
  const a = unseries(l);
  const b = unseries(r);
  if (isNum(a) || isNum(b)) return isNum(a) && isNum(b) && a.v === b.v;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'bool' && b.kind === 'bool') return a.v === b.v;
  if ((a.kind === 'string' || a.kind === 'color') && a.kind === b.kind) {
    return a.v === (b as typeof a).v;
  }
  if ('v' in a && 'v' in b) return a.v === b.v; // reference equality for objects
  return a === b;
}

// ── history reference: expr[n] ────────────────────────────────────────────────

function evalHistref(node: HistRef, frame: Frame): Value {
  const { scope, ctx } = frame;
  const run = runOf(ctx);
  const bar = ctx.barIndex;

  const idxV = unseries(evalExpr(node.idx, frame));
  const idx = isNum(idxV) && Number.isFinite(idxV.v) ? Math.floor(idxV.v) : undefined;
  if (idx === undefined || idx < 0) return NA;

  let s: Series | undefined;
  if (node.obj.type === 'ident') {
    s = seriesOf(scope, node.obj.name) ?? ctxSeries(ctx, node.obj.name);
    if (!s && node.obj.name === 'bar_index') s = barIndexSeries(run, ctx);
    if (!s) {
      const v = evalIdent(node.obj.name, frame);
      // A constant resolving to a series (bare calendar vars, ta.tr) has real
      // per-bar history — honor offsets instead of na-ing them.
      if (v.kind === 'series') return histGetAt(v.v, idx, bar);
      // Constant / unknown ident: v[0] = v, v[n>0] = na.
      return idx === 0 ? v : NA;
    }
  } else {
    const v = evalExpr(node.obj, frame);
    if (v.kind === 'series') {
      s = v.v;
    } else {
      // Key by (node, callsite) like evalArg — a UDF body's shared AST node
      // must get one tracking series per callsite, not one shared series.
      const key = siteKey(run, node.obj);
      let tracked = run.callHist.get(key as Node);
      if (!tracked) {
        tracked = new BarSeries();
        run.callHist.set(key as Node, tracked);
        trackSeries(run, tracked);
      }
      tracked.setAt(bar, v);
      s = tracked;
    }
  }
  return histGetAt(s, idx, bar);
}

// ── member access ─────────────────────────────────────────────────────────────

function evalMember(node: Member, frame: Frame): Value {
  const { scope, ctx } = frame;
  const run = runOf(ctx);
  const objNode = node.obj;
  const prop = node.prop;

  // `ns.prop` where `ns` is not a bound identifier → constant / builtin / ctx record.
  if (objNode.type === 'ident' && scope.lookup(objNode.name) === undefined) {
    const key = `${objNode.name}.${prop}`;
    const c = getConstant(key, ctx);
    if (c !== undefined) return c;
    const b = BUILTINS.get(key);
    if (b) return { kind: 'function', v: b };
    if (objNode.name === 'syminfo') {
      const f = ctx.syminfo[prop];
      if (f !== undefined) return f;
    }
    if (objNode.name === 'timeframe') {
      const f = timeframeFields(ctx).get(prop);
      if (f !== undefined) return f;
    }
    if (objNode.name === 'barstate') {
      const f = barstateUdt(ctx).fields.get(prop);
      if (f !== undefined) return f;
    }
    warn(run, ctx, `unknown constant '${key}'`);
    return NA;
  }

  const obj = unseries(evalExpr(objNode, frame));
  if (obj.kind === 'udt') {
    try {
      return getField(obj, prop);
    } catch {
      warn(run, ctx, `type '${obj.v.typeName}' has no field '${prop}'`);
      return NA;
    }
  }
  if (obj.kind === 'map') return obj.v.get(prop) ?? NA;
  warn(run, ctx, `cannot access '${prop}' on ${obj.kind}`);
  return NA;
}

// ── calls ─────────────────────────────────────────────────────────────────────

function callsiteId(run: RunState, node: Node): string {
  let id = run.callsites.get(node);
  if (!id) {
    id = `#${run.callsiteSeq++}`;
    run.callsites.set(node, id);
  }
  return id;
}

function evalCall(node: Call, frame: Frame): Value {
  const run = runOf(frame.ctx);
  const rt = frame.ctx as RtCtx;
  const site = callsiteId(run, node);
  const prevSite = rt.callsite;
  rt.callsite = site;
  run.siteStack.push(site);
  try {
    return evalCallDispatch(node, frame);
  } finally {
    run.siteStack.pop();
    rt.callsite = prevSite;
  }
}
/** Call node → memoized `ns.fn` builtin resolution (permanent — see below). */
const RESOLVED_BUILTIN = new WeakMap<Call, { headName: string; fn: BuiltinFn | undefined }>();


function evalCallDispatch(node: Call, frame: Frame): Value {
  const { scope, ctx } = frame;
  const run = runOf(ctx);

  // request.security — lazy args; mtf.ts evaluates expr in tf child frames.
  if (mtf) {
    const sec = mtf.tryEvalSecurity(node, frame);
    if (sec !== null) return sec;
  }

  const callee = node.callee;

  // `X.new(...)` — UDT construction.
  if (
    callee.type === 'member' &&
    !callee.computed &&
    callee.prop === 'new' &&
    callee.obj.type === 'ident' &&
    isUdtType(callee.obj.name)
  ) {
    const args: Value[] = [];
    const named: Record<string, Value> = {};
    for (const a of node.args) {
      const v = evalExpr(a.value, frame);
      if (a.name) named[a.name] = v;
      else args.push(v);
    }
    return { kind: 'udt', v: newUdt(callee.obj.name, args, named, d => evalExpr(d, frame)) };
  }

  // `ns.fn(...)` — builtin namespace call when `ns` isn't a bound var.
  // Deeper chains (chart.point.new, request.security_lower_tf, …) flatten to
  // a dotted key; a scope-bound receiver stops the flattening (it's a real
  // object method, not a namespace path).
/** Call node → memoized `ns.fn` builtin resolution (permanent — see below). */
const RESOLVED_BUILTIN = new WeakMap<Call, { headName: string; fn: BuiltinFn | undefined }>();

  if (callee.type === 'member' && !callee.computed) {
    // Per-Call memoized resolution: the callee-chain walk + BUILTINS lookup
    // run once per Call node. `headName` is cached so the per-bar re-check of
    // `scope.lookup(head.name)` is just a hash read — scope rebinds mid-run
    // runs at import time (builtins/*.ts self-register via registry.ts) — no
    // builtin can appear after first dispatch of a given callsite.
    let hit = RESOLVED_BUILTIN.get(node);
    if (hit === undefined) {
      const parts: string[] = [callee.prop];
      let head: Node = callee.obj;
      while (head.type === 'member' && !head.computed) {
        parts.unshift(head.prop);
        head = head.obj;
      }
      if (head.type === 'ident') {
        parts.unshift(head.name);
        const b = BUILTINS.get(parts.join('.'));
        hit = { headName: head.name, fn: b };
      } else {
        hit = { headName: '', fn: undefined };
      }
      RESOLVED_BUILTIN.set(node, hit);
    }
    if (hit.fn !== undefined && scope.lookup(hit.headName) === undefined) {
      return invokeBuiltin(hit.fn, node, frame);
    }
    // fall through — scope-bound head or non-builtin callee.
  }

  // `obj.method(...)` — UDT receivers own their type, so user
  // methods dispatch first. Builtin receivers keep `<kind>.<method>`
  // builtins ahead of user methods: a `method push(array self, …)`
  // must never shadow array.push — user methods extend builtin
  // types with new names only.
  if (callee.type === 'member' && !callee.computed) {
    const obj = evalExpr(callee.obj, frame);
    const prop = callee.prop;
    if (obj.kind === 'udt') {
      const def = getUdtMethod(obj.v.typeName, prop);
      if (def) {
        const bound = bindCallArgs(node.args, def.params.slice(1), frame);
        return callUdtMethod(obj.v, prop, bound, ctx);
      }
    } else {
      const b = kindBuiltin(obj.kind, prop);
      if (b) {
        const args: Value[] = [obj];
        const named: Record<string, Value> = {};
        for (const a of node.args) {
          const v = evalArg(a, frame, true);
          if (a.name) named[a.name] = v;
          else args.push(v);
        }
        return callBuiltin(b, ctx, args, named, node);
      }
      const prim = getUdtMethod(obj.kind, prop);
      if (prim) {
        const bound = bindCallArgs(node.args, prim.params.slice(1), frame);
        return callUdtMethod(obj, prop, bound, ctx);
      }
    }
    // Pine propagates na through member access — a method on na is a no-op.
    if (obj.kind === 'na') return NA;
    warn(run, ctx, `no method '${prop}' on ${obj.kind}`);
    return NA;
  }

  // Bare callee → builtin or UDF. `na` parses as a literal, not an ident —
  // dispatch na(x) through the registered builtin before generic callee eval.
  if (callee.type === 'na') {
    const b = BUILTINS.get('na');
    if (b) return invokeBuiltin(b, node, frame);
  }
  let fn: Value;
  if (callee.type === 'ident') {
    // Scope-bound data (time/open/close BarSeries, user vars) is not callable —
    // only shadow the builtin when the binding is an actual function value.
    const bound = scope.lookup(callee.name);
    const callable = bound !== undefined &&
      ((bound as Value).kind === 'function' ||
       ((bound as Series).cur?.()?.kind === 'function'));
    if (!callable) {
      const b = BUILTINS.get(callee.name);
      if (b) return invokeBuiltin(b, node, frame);
    }
    fn = evalIdent(callee.name, frame);
  } else {
    fn = evalExpr(callee, frame);
  }

  if (fn.kind === 'function') {
    if (typeof fn.v === 'function') return invokeBuiltin(fn.v as BuiltinFn, node, frame);
    return invokeUdf(fn.v as UdfDecl, node, frame);
  }
  warn(run, ctx, `call target is not a function (${fn.kind})`);
  return NA;
}

function invokeBuiltin(b: BuiltinFn, node: Call, frame: Frame): Value {
  const args: Value[] = [];
  const named: Record<string, Value> = {};
  for (const a of node.args) {
    const v = evalArg(a, frame, true);
    if (a.name) named[a.name] = v;
    else args.push(v);
  }
  return callBuiltin(b, frame.ctx, args, named, node);
}

function callBuiltin(
  b: BuiltinFn,
  ctx: BuiltinCtx,
  args: Value[],
  named: Record<string, Value>,
  node: Call,
): Value {
  try {
    const r = b(ctx, args, named);
    // Flush arg-binding warnings (e.g. `source=`+`series=` both given) now
    // that a ctx is reachable; dedup so a per-bar builtin warns once.
    for (const w of drainBindWarnings()) {
      if (!ctx.warnings.includes(w)) ctx.warnings.push(w);
    }
    return r;
  } catch (e) {
    if (e === BREAK || e === CONTINUE || e instanceof ReturnSignal) throw e;
    throw wrapPineError(e, node);
  }
}

export let __callHistWrites = 0; // test instrumentation

/**
 * Arg evaluation: a bare identifier bound to a Series passes `{kind:'series'}`
 * so builtins/UDF params can read history; anything else evaluates normally.
 *
 * litFastPath=true is ONLY for builtin-call args: a literal num/bool gets a
 * LitSeries (virtual constant history — no per-bar buffer writes) instead of
 * a real callHist BarSeries. UDF/UDT-method args MUST keep the BarSeries —
 * callUdfValue seeds param history from it and CowSeries rebinds onto it;
 * `f(20)` bodies may legitimately read `x[1]` AND mutate `x`.
 */
function evalArg(a: Arg, frame: Frame, litFastPath = false): Value {
  const { scope, ctx } = frame;
  const run = runOf(ctx);
  if (a.value.type === 'ident') {
    const s = seriesOf(scope, a.value.name) ?? ctxSeries(ctx, a.value.name);
    if (s) return { kind: 'series', v: s };
  }
  const lit = a.value.type;
  if (litFastPath && (lit === 'num' || lit === 'bool')) {
    // Literal builtin args keep a series wrapper (builtins may stash the arg
    // Value — array.new/fill — or return it verbatim — nz — and every reader
    // must still see per-bar history), but a literal's history is constant:
    // LitSeries virtualizes the buffer — no siteKey writes or per-bar pushes.
    const key = siteKey(run, a.value);
    let ls = run.callHist.get(key as Node) as LitSeries | undefined;
    if (!ls) {
      ls = new LitSeries(evalExpr(a.value, frame), ctx.barIndex);
      run.callHist.set(key as Node, ls);
      trackSeries(run, ls);
    } else {
      ls.bump(ctx.barIndex);
    }
    return { kind: 'series', v: ls };
  }
  const v = evalExpr(a.value, frame);
  if (v.kind === 'series') return v;
  // Only numeric/bool scalars are time series in Pine (`x[1]` is valid on them).
  // Arrays, maps, UDTs, strings, colors and drawings pass through untouched so
  // builtins receive the real value instead of a fresh BarSeries wrapper.
  if (v.kind !== 'int' && v.kind !== 'float' && v.kind !== 'bool') return v;
  // Track scalar/expr args in a per-(node,callsite) BarSeries so `x[1]` inside
  // UDFs and ta.* source windows see per-bar history, matching Pine semantics.
  const key = siteKey(run, a.value);
  let s = run.callHist.get(key as Node);
  if (!s) {
    s = new BarSeries();
    run.callHist.set(key as Node, s);
    trackSeries(run, s);
  }
  s.setAt(ctx.barIndex, v);
  __callHistWrites++;
  return { kind: 'series', v: s };
}

/** Bind callsite args (named first, then positional) against a param list. */
function bindCallArgs(callArgs: Arg[], params: Param[], frame: Frame): Value[] {
  const out: Value[] = new Array<Value>(params.length);
  const filled = new Set<number>();
  const positionals: Arg[] = [];
  for (const a of callArgs) {
    if (a.name !== undefined) {
      const i = params.findIndex(p => p.name === a.name);
      if (i >= 0 && !filled.has(i)) {
        out[i] = evalArg(a, frame);
        filled.add(i);
        continue;
      }
    }
    positionals.push(a);
  }
  let p = 0;
  for (const a of positionals) {
    while (p < params.length && filled.has(p)) p++;
    if (p >= params.length) break;
    out[p] = evalArg(a, frame);
    filled.add(p);
    p++;
  }
  for (let i = 0; i < params.length; i++) {
    if (!filled.has(i)) {
      const d = params[i]!.default;
      out[i] = d !== undefined ? evalExpr(d, frame) : NA;
    }
  }
  return out;
}

function invokeUdf(fn: UdfDecl, node: Call, frame: Frame): Value {
  return callUdfValue(fn, bindCallArgs(node.args, fn.params, frame), frame, node);
}

/** Bind evaluated args into a call scope. `{kind:'series'}` args alias the
 *  caller's slot through a CowSeries — reads see caller history, `:=` copies. */
/** Cache of per-(callsite,param) CowSeries so a UDF-local series persists
 *  across bars — Pine params keep bar history; `x :=` writes accumulate on
 *  the same slot, and `x[1]` next bar sees the previous bar's reassigned value. */
function callUdfValue(fn: UdfDecl, args: Value[], frame: Frame, callNode?: Node): Value {
  const { ctx } = frame;
  const bar = ctx.barIndex;
  const run = runOf(ctx);
  const callScope = new Scope(fn.closure);
  const cowKey = callNode ? (siteKey(run, callNode) as object) : null;
  fn.params.forEach((p, i) => {
    const a = args[i] ?? NA;
    if (a.kind === 'series') {
      if (cowKey) {
        let byParam = run.paramCows.get(cowKey);
        if (!byParam) { byParam = new Map(); run.paramCows.set(cowKey, byParam); }
        let cow = byParam.get(p.name) as CowSeries | undefined;
        if (!cow) { cow = new CowSeries(a.v); byParam.set(p.name, cow); }
        else cow.rebind(a.v);
        // Pine re-binds params each invocation: seed this bar's slot with the
        // arg's current value so a previous bar's `:=` doesn't carry forward
        // into this bar's reads (history stays bumped).
        cow.seed(a.v.cur(), bar);
        callScope.define(p.name, cow);
      } else {
        // No callNode (method dispatch via ctx.callUdf): seed a
        // fresh CowSeries even when the arg is already one — the
        // callee's `:=` must materialize a private copy, never
        // write through into the caller's param series.
        callScope.define(p.name, new CowSeries(a.v));
      }
    } else {
      const s = new BarSeries();
      s.setAt(bar, a);
      callScope.define(p.name, s);
    }
  });
  const callFr: Frame = { scope: callScope, ctx };
  const rt = ctx as RtCtx;
  rt.scopeDepth = (rt.scopeDepth ?? 0) + 1;
  // UDF bodies run conditionally — a single-expression body evaluated via
  // evalExpr would otherwise inherit the top-level flag and wrongly prune
  // a decl slot it creates.
  const wasTop = run.topLevelBody, wasIdx = run.topStmtIdx;
  run.topLevelBody = false; run.topStmtIdx = -1;
  try {
    if (Array.isArray(fn.body)) return evalBlock(fn.body, callFr);
    return evalExpr(fn.body, callFr);
  } catch (e) {
    if (e instanceof ReturnSignal) return e.value;
    if (e === BREAK || e === CONTINUE) {
      // Loop-internal breaks are absorbed by evalFor/evalWhile/evalSwitch
      // before they reach here — a signal escaping the whole body is invalid
      // Pine (TV rejects at compile time). Erroring beats the bar loop's
      // warn-and-skip, which would prune later decls and silently misalign
      // ta.* ordinal reads (stmtMayExitTop can't see inside callee closures).
      throw pineErr(
        callNode,
        `'${e === BREAK ? 'break' : 'continue'}' outside loop in function '${fn.name}'`,
      );
    }
    throw e;
  } finally {
    run.topLevelBody = wasTop; run.topStmtIdx = wasIdx;
    rt.scopeDepth!--;
  }
}

// ── reassignment ──────────────────────────────────────────────────────────────

function evalReassign(node: Reassign, frame: Frame): Value {
  const { scope, ctx } = frame;
  const run = runOf(ctx);
  const bar = ctx.barIndex;
  const t = node.target;

  if (t.type === 'ident') {
    // `:=` requires a previously-declared name — resolve BEFORE evaluating the
    // RHS so `x := x[1]+1` on an undeclared x errors (TV: "Cannot use x before
    // declaration") instead of warning "identifier not found" mid-RHS.
    const slot = scope.lookup(t.name);
    if (slot === undefined) {
      throw pineErr(node, `cannot reassign undeclared variable '${t.name}'`);
    }
    const raw = evalExpr(node.value, frame);
    const v = unseries(raw);
    if (slot instanceof BarSeries) {
      slot.setAt(bar, v);
    } else if (slot instanceof Series) {
      slot.set(v);
    } else {
      throw pineErr(node, `'${t.name}' is not a mutable variable`);
    }
    return v;
  }

  if (t.type === 'member' && !t.computed) {
    const obj = unseries(evalExpr(t.obj, frame));
    const v = unseries(evalExpr(node.value, frame));
    if (obj.kind === 'udt') {
      setField(obj, t.prop, v);
      return v;
    }
    if (obj.kind === 'map') {
      obj.v.set(t.prop, v);
      return v;
    }
    throw pineErr(node, `cannot assign field '${t.prop}' on ${obj.kind}`);
  }
  if (t.type === 'histref') {
    // `a[i] := v` — element write on array/map values (series history is immutable).
    const obj = unseries(evalExpr(t.obj, frame));
    const key = unseries(evalExpr(t.idx, frame));
    const v = unseries(evalExpr(node.value, frame));
    if (obj.kind === 'array' && isNum(key)) {
      const i = Math.floor(key.v);
      if (i < 0 || i >= obj.v.length) {
        throw pineErr(node, `array index ${i} out of bounds (size ${obj.v.length})`);
      }
      obj.v[i] = v;
      return v;
    }
    if (obj.kind === 'map') {
      obj.v.set(pineStr(key), v);
      return v;
    }
    warn(run, ctx, `cannot write history/element on ${obj.kind}`);
    return NA;
  }

  warn(run, ctx, 'unsupported reassignment target');
  return NA;
}

// ── control flow ─────────────────────────────────────────────────────────────

function evalFor(node: ForStmt, frame: Frame): Value {
  const { ctx } = frame;
  const run = runOf(ctx);
  const bar = ctx.barIndex;

  // `for x in e` — ParserAgent emits from = Ident{name: FOR_IN}, to = expr.
  if (node.from.type === 'ident' && node.from.name === FOR_IN) {
    const coll = unseries(evalExpr(node.to, frame));
    // Two-var for-in (`for [k,v] in map`): parser encodes varName='k,v'.
    const kv = node.varName.includes(',') ? node.varName.split(',').map(s => s.trim()) : null;
    const items: Value[] =
      coll.kind === 'array' ? coll.v
      : coll.kind === 'map'
        ? kv
          ? [...coll.v.entries()].map(([k, v]) => ({
              kind: 'array', v: [{ kind: 'string', v: k } as Value, v],
            }) as Value)
          : [...coll.v.keys()].map(k => ({ kind: 'string', v: k }) as Value)
      : coll.kind === 'matrix' ? coll.v.map(row => ({ kind: 'array', v: row } as Value))
      : [];
    let last: Value = { kind: 'void' };
    let count = 0;
    for (const item of items) {
      if (++count > 100_000) {
        warn(run, ctx, 'for..in loop exceeded 100000 iterations — aborting');
        break;
      }
      const fr = blockFrame(frame, node.varName);
      if (kv) {
        // `[k,v]` destructure: map entries yield (key, val); arrays and
        // matrices yield (index, element) — kv[1] is a row array for matrices.
        const pair: Value[] =
          coll.kind === 'map' && item.kind === 'array'
            ? item.v
            : [{ kind: 'int', v: count - 1 } as Value, item];
        for (const [j, nm] of kv.entries()) {
          const lv = new BarSeries();
          lv.setAt(bar, pair[j] ?? NA);
          fr.scope.define(nm, lv);
        }
      } else {
        const lv = new BarSeries();
        lv.setAt(bar, item);
        fr.scope.define(node.varName, lv);
      }
      try {
        last = evalBlock(node.body, fr);
      } catch (e) {
        if (e === BREAK) break;
        if (e === CONTINUE) continue;
        throw e;
      }
    }
    return last;
  }

  const fromV = unseries(evalExpr(node.from, frame));
  const toV = unseries(evalExpr(node.to, frame));
  const stepV = node.step ? unseries(evalExpr(node.step, frame)) : ({ kind: 'int', v: 1 } as Value);
  if (!isNum(fromV) || !isNum(toV) || !isNum(stepV)) return { kind: 'void' };
  let step = Math.floor(stepV.v);
  if (step === 0) step = 1;
  const from = Math.floor(fromV.v);
  const to = Math.floor(toV.v);
  const dir = to >= from ? Math.abs(step) : -Math.abs(step);

  let last: Value = { kind: 'void' };
  let count = 0;
  for (let i = from; dir > 0 ? i <= to : i >= to; i += dir) {
    if (++count > 100_000) {
      warn(run, ctx, 'for loop exceeded 100000 iterations — aborting');
      break;
    }
    const fr = blockFrame(frame, node.varName);
    const lv = new BarSeries();
    lv.setAt(bar, { kind: 'int', v: i });
    fr.scope.define(node.varName, lv);
    try {
      last = evalBlock(node.body, fr);
    } catch (e) {
      if (e === BREAK) break;
      if (e === CONTINUE) continue;
      throw e;
    }
  }
  return last;
}

function evalWhile(node: WhileStmt, frame: Frame): Value {
  const { ctx } = frame;
  const run = runOf(ctx);
  let last: Value = { kind: 'void' };
  let count = 0;
  while (unseriesTruth(evalExpr(node.test, frame))) {
    if (++count > 100_000) {
      warn(run, ctx, 'while loop exceeded 100000 iterations — aborting');
      break;
    }
    try {
      last = evalBlock(node.body, blockFrame(frame));
    } catch (e) {
      if (e === BREAK) break;
      if (e === CONTINUE) continue;
      throw e;
    }
  }
  return last;
}

function evalSwitch(node: SwitchStmt, frame: Frame): Value {
  const subj = node.subject !== undefined ? unseries(evalExpr(node.subject, frame)) : undefined;
  let defaultBody: Node[] | null = null;
  for (const c of node.cases) {
    if (c.test === undefined) {
      defaultBody = c.body;
      continue;
    }
    let hit: boolean;
    if (subj === undefined) {
      hit = unseriesTruth(evalExpr(c.test, frame));
    } else {
      const arm = unseries(evalExpr(c.test, frame));
      if (subj.kind === 'na' && arm.kind === 'na') hit = true;
      else if (subj.kind === 'na' || arm.kind === 'na') hit = false;
      else hit = valueEq(subj, arm);
    }
    if (hit) {
      try {
        return evalBlock(c.body, blockFrame(frame));
      } catch (e) {
        if (e === BREAK) return { kind: 'void' };
        throw e;
      }
    }
  }
  if (defaultBody) return evalBlock(defaultBody, blockFrame(frame));
  return NA;
}

// ── runScript ────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** 'PREFIX:TICKER' for syminfo. */
  symbol?: string;
  /** Timeframe string — '15', 'D', 'W', '4H'. Default 'D'. */
  timeframe?: string;
  fetchSeries?: (symbol: string, tf: string) => Promise<BarData[]>;
  /** input.* overrides keyed by title or id. */
  inputValues?: Record<string, unknown>;
  syminfo?: Record<string, Value>;
  /** Called at each macrotask yield during the bar loop; truthy = caller superseded this run, bail out. */
  shouldAbort?: () => boolean;
}

export type ParsedInput =
  | Node[]
  | { decl?: IndicatorDecl | StrategyDecl | null; body: Node[] };


// Macrotask yield without setTimeout's 4ms clamp. One MessageChannel per
// yield, self-closing on delivery — a persistent channel keeps Node's event
// loop alive forever (hangs CLI/test teardown; observed: bench process never
// exited). The onmessage PROPERTY must be assigned to start the port —
// addEventListener alone leaves it suspended (observed: headless Chromium
// never delivers).
/** Diagnostics: cumulative yield hop count + worst wait across all runs. */
export const yieldStats = { hops: 0, maxWait: 0 };
const yieldTask = (): Promise<void> => {
  if (typeof MessageChannel === 'undefined') {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    return promise;
  }
  const t0 = nowMs();
  const { promise, resolve } = Promise.withResolvers<void>();
  const ch = new MessageChannel();
  ch.port1.onmessage = () => {
    ch.port1.onmessage = null;
    ch.port1.close();
    ch.port2.close();
    const w = nowMs() - t0;
    yieldStats.hops++;
    if (w > yieldStats.maxWait) yieldStats.maxWait = w;
    resolve();
  };
  ch.port2.postMessage(null);
  return promise;
};
const nowMs = typeof performance !== 'undefined' ? () => performance.now() : Date.now;
// Serialize runScript executions — module state (UDT_REGISTRY, bindWarnQ,
// warn dedup) is per-run; interleaving two live runs (possible now that the
// bar loop yields) corrupts it. Queue in call order.
let runScriptTail: Promise<void> = Promise.resolve();
export function runScript(
  parsed: ParsedInput,
  bars: BarData[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const p = runScriptTail.then(() => runScriptInner(parsed, bars, opts));
  runScriptTail = p.then(() => {}, () => {});
  return p;
}

async function runScriptInner(
  parsed: ParsedInput,
  bars: BarData[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const decl = Array.isArray(parsed) ? null : (parsed.decl ?? null);
  const body = Array.isArray(parsed) ? parsed : parsed.body;

  // UDT registries are module globals — clear types/methods/scope from any
  // previous run before this script's decls re-register.
  UDT_REGISTRY.reset();

  const empty = (): RunResult => ({
    plots: new Map(),
    drawings: [],
    fills: [],
    bgcolors: new Map(),
    barcolors: new Map(),
    alerts: [],
    alertconditions: [],
    warnings: [],
    inputs: collectInputs(body),
    props: declProps(decl),
    title: declTitle(decl) ?? '',
    shorttitle: declShortTitle(decl),
    overlay: declOverlay(decl),
  });
  if (bars.length === 0) return empty();

  const ctxRef: { current: BuiltinCtx | null } = { current: null };
  const barCtx = new BarCtx(bars, {
    symbol: opts.symbol ?? '',
    market: opts.timeframe ?? 'D',
    fetchSeries: opts.fetchSeries,
    syminfo: opts.syminfo,
    callUdf: (fn, args) => {
      const ctx = ctxRef.current;
      if (!ctx) throw new PineRuntimeError('callUdf invoked before bar loop');
      const top = runOf(ctx).topFrame;
      return callUdfValue(fn, args, top ?? { scope: new Scope(), ctx });
    },
  });

  const drawSink = new MemoryDrawSink();
  const ctx = barCtx.seek(0) as RtCtx;
  ctxRef.current = ctx;
  ctx.drawings = [drawSink];
  ctx.inputs = opts.inputValues ?? {};
  ctx.inputSchemas = [];
  ctx.plotIds = new Map();
  ctx.plotSeq = 0;
  ctx.liveLines = [];
  ctx.liveLabels = [];
  ctx.liveBoxes = [];
  ctx.liveTables = [];
  ctx.livePolylines = [];
  ctx.liveLinefills = [];
  ctx.bgcolors = new Map();
  ctx.barcolors = new Map();
  ctx.alertstate = new Map();
  ctx.fills = [];
  ctx.fillSites = new Map();
  ctx.state = new Map();

  const run = runOf(ctx);
  const scope = new Scope();
  bindUdtGlobalScope(scope);

  // strategy(...) decl: the parser strips it from `body`, so evaluate it once
  // here — strategy.ts writes ctx.state['strategy|cfg'] (pyramiding,
  // commission, process_orders_on_close, default_qty…). indicator() decl
  // fields are read directly via declProps/declTitle/etc.
  if (decl?.type === 'strategy') strategyDecl(ctx, decl);

  // Bind context series + globals into the top scope.
  const bound: Record<string, Series> = {
    open: ctx.open, high: ctx.high, low: ctx.low, close: ctx.close,
    volume: ctx.volume, time: ctx.time,
    hl2: ctx.hl2, hlc3: ctx.hlc3, ohlc4: ctx.ohlc4, hlcc4: ctx.hlcc4,
  };
  for (const name of Object.keys(bound)) {
    const s = bound[name]!;
    scope.define(name, s);
    if (s instanceof BarSeries) trackSeries(run, s);
  }

  // Pre-register type/method/func decls so dispatch works regardless of decl
  // order — Pine hoists UDFs, and prefetchSecurity's pfScope resolves globals
  // that call them before the first bar executes.
  for (const s of body) {
    if (s.type === 'typedecl') registerType(s);
    else if (s.type === 'method') registerMethod(s);
    else if (s.type === 'func') {
      scope.define(s.name, {
        kind: 'function',
        v: { name: s.name, params: s.params, body: s.body, closure: scope },
      });
    }
  }

  const frame0: Frame = { scope, ctx };
  run.topFrame = frame0;

  // MTF pre-pass: collect security specs; resolve unique (sym,tf) fetches.
  if (mtf) {
    mtf.prepareSecurity(body, frame0);
    (globalThis as Record<string, unknown>).__pineStage = 'prefetch';
    await mtf.prefetchSecurity(ctx, frame0, bars);
    (globalThis as Record<string, unknown>).__pineStage = 'barloop';
  }
  // A stopped run pays full prefetch otherwise — check before the bar loop.
  if (opts.shouldAbort?.()) return empty();

  // ── bar loop ──
  // Static early-exit scan: the first top-level stmt that may skip the rest
  // of the body (bare or if/switch-arm break/continue/return) caps pruning —
  // decls at or after it aren't provably written every bar, so their slots
  // must stay in ensureList or `x[1]` misaligns on skipped bars.
  run.pruneCutoff = Infinity; // default: no early exit in body (matches runOf init)
  for (let i = 0; i < body.length; i++) {
    if (stmtMayExitTop(body[i]!, false, false)) { run.pruneCutoff = i; break; }
  }
  let barErr: PineRuntimeError | null = null;
  let sliceStart = nowMs();
  for (let bar = 0; bar < bars.length; bar++) {
    if (bar > 0) barCtx.seek(bar);
    try {
      // Decl slots created while topLevelBody is set are written every bar —
      // their ensureBar is a no-op, so slotFor keeps them out of ensureList
      // (topStmtIdx < pruneCutoff only; see the scan above).
      run.topLevelBody = true;
      try {
        for (let i = 0; i < body.length; i++) {
          run.topStmtIdx = i;
          evalExpr(body[i]!, frame0);
        }
      } finally {
        run.topStmtIdx = -1;
        run.topLevelBody = false;
      }
    } catch (e) {
      if (e === BREAK || e === CONTINUE) {
        warn(run, ctx, 'break/continue outside loop');
      } else if (e instanceof ReturnSignal) {
        break; // top-level return stops the script
      } else {
        barErr = wrapPineError(e, undefined);
        break;
      }
    }
    // Densify every slot to `bar` (carry-forward for skipped statements).
    for (let i = 0; i < run.ensureList.length; i++) run.ensureList[i]!.ensureBar(bar);
    // Yield to the event loop when one bar batch has hogged >16ms so input,
    // paint, and pending fetch callbacks can run. Fast bars (most scripts)
    // amortize this to a near-zero-cost time check.
    if (nowMs() - sliceStart > 16) {
      await yieldTask();
      sliceStart = nowMs();
      if (opts.shouldAbort?.()) return empty();
    }
  }
  (globalThis as Record<string, unknown>).__pineStage = 'assemble';
  if (opts.shouldAbort?.()) return empty();
  if (barErr) throw barErr;

  // ── assemble RunResult ──
  const plots: RunResult['plots'] = new Map();
  // Extrapolate off-range times by average bar duration, never bare indexes.
  const barDur = bars.length > 1
    ? (bars[bars.length - 1]!.openTime - bars[0]!.openTime) / (bars.length - 1)
    : 60_000;
  const lastTime = bars[bars.length - 1]!.openTime;
  const timeAt = (bi: number): number =>
    bars[bi]?.openTime ?? lastTime + (bi - bars.length + 1) * barDur;
  ctx.plots.forEach((sink, idx) => {
    const raw = 'buf' in sink ? sink.buf : undefined;
    const buf = Array.isArray(raw)
      ? (raw as { value: Value; opts: PlotOpts; barIndex?: number }[])
      : undefined;
    if (!buf || buf.length === 0) return;
    const rawTitle = buf[0]?.opts.title;
    const title = rawTitle && rawTitle !== '' ? rawTitle : `plot_${idx}`;
    let key = title;
    let k = 1;
    while (plots.has(key)) key = `${title}#${++k}`;
    const offset = Math.floor(buf[buf.length - 1]!.opts.offset ?? 0);
    // Entry barIndex is recorded at push time — sparse sinks (plot inside
    // if/for) map each value to its own bar, not buf position.
    plots.set(key, {
      index: idx,
      time: buf.map((p, i) => timeAt((p.barIndex ?? i) + offset)),
      values: buf.map(p => p.value),
      opts: buf[buf.length - 1]!.opts,
      colors: buf.map(p => p.opts.color),
    });
  });

  return {
    plots,
    drawings: drawSink.objects.slice(),
    fills: (ctx.fills ?? []).slice(),
    bgcolors: new Map(ctx.bgcolors ?? []),
    barcolors: new Map(ctx.barcolors ?? []),
    execs: execsAt(ctx, ctx.barIndex),
    alerts: ctx.alerts.slice(),
    alertconditions: (ctx.alertconditions ?? []).slice(),
    warnings: ctx.warnings.slice(),
    inputs: ctx.inputSchemas && ctx.inputSchemas.length > 0 ? ctx.inputSchemas : collectInputs(body),
    props: declProps(decl),
    title: declTitle(decl) ?? '',
    shorttitle: declShortTitle(decl),
    overlay: declOverlay(decl),
  };
}

// ── script declaration (indicator/strategy) ───────────────────────────────────

function declArgValue(decl: IndicatorDecl | StrategyDecl | null, name: string): Value | undefined {
  if (!decl) return undefined;
  const named = decl.args.find(a => a.name === name);
  return named ? staticLit(named.value) : undefined;
}

function declTitle(decl: IndicatorDecl | StrategyDecl | null): string | undefined {
  const named = declArgValue(decl, 'title');
  if (named?.kind === 'string') return named.v;
  const first = decl?.args.find(a => a.name === undefined);
  const v = first ? staticLit(first.value) : undefined;
  return v?.kind === 'string' ? v.v : undefined;
}

function declShortTitle(decl: IndicatorDecl | StrategyDecl | null): string | undefined {
  const v = declArgValue(decl, 'shorttitle');
  return v?.kind === 'string' ? v.v : undefined;
}

function declOverlay(decl: IndicatorDecl | StrategyDecl | null): boolean {
  const v = declArgValue(decl, 'overlay');
  return v?.kind === 'bool' ? v.v : false;
}

function declProps(decl: IndicatorDecl | StrategyDecl | null): InputSchemaLite[] {
  if (!decl) return [];
  return decl.args.map((a, i) => {
    const v = staticLit(a.value);
    return {
      id: a.name ?? `arg_${i}`,
      name: a.name ?? `arg_${i}`,
      type: v?.kind ?? 'na',
      defval: v && 'v' in v ? v.v : undefined,
    };
  });
}

/** Evaluate literal-ish nodes at scan time (no frame). */
function staticLit(n: Node): Value | undefined {
  switch (n.type) {
    case 'num': return numVal(n.v, n.isInt);
    case 'str': return { kind: 'string', v: n.v };
    case 'bool': return n.v ? VTRUE : VFALSE;
    case 'color': return { kind: 'color', v: n.v };
    case 'na': return NA;
    case 'unary': {
      if (n.op !== '-') return undefined;
      const a = staticLit(n.arg);
      return a && isNum(a) ? numVal(-a.v, a.kind === 'int') : undefined;
    }
    case 'member':
      return n.obj.type === 'ident' ? getConstant(`${n.obj.name}.${n.prop}`) : undefined;
    default:
      return undefined;
  }
}

// ── input schema collection (prepare-time backstop) ───────────────────────────

/**
 * Walk `body` for `input.<kind>(...)` calls and emit InputSchemaLite entries.
 * Live runs prefer ctx.inputSchemas (populated by builtins/input.ts with
 * override-aware ids); this static pass is the fallback / prepare-time path.
 */
export function collectInputs(body: Node[]): InputSchemaLite[] {
  const out: InputSchemaLite[] = [];
  const seen = new Set<string>();
  let seq = 0;

  const argVal = (args: Arg[], idx: number, name: string): Value | undefined => {
    const named = args.find(a => a.name === name);
    const node = named?.value ?? args.filter(a => a.name === undefined)[idx]?.value;
    return node ? staticLit(node) : undefined;
  };

  walkNodes(body, n => {
    if (n.type !== 'call') return;
    const c = n.callee;
    if (c.type !== 'member' || c.obj.type !== 'ident' || c.obj.name !== 'input') return;
    const kind = c.prop;
    const defval = argVal(n.args, 0, 'defval');
    const title = argVal(n.args, 1, 'title');
    const idArg = argVal(n.args, -1, 'id');
    const titleStr = title?.kind === 'string' ? title.v : '';
    const id =
      idArg?.kind === 'string' && idArg.v ? idArg.v : titleStr || `input_${kind}_${seq++}`;
    if (seen.has(id)) return;
    seen.add(id);
    const schema: InputSchemaLite = {
      id,
      name: titleStr || id,
      type: kind,
      defval: defval && 'v' in defval ? defval.v : undefined,
    };
    const minval = argVal(n.args, -1, 'minval');
    const maxval = argVal(n.args, -1, 'maxval');
    const step = argVal(n.args, -1, 'step');
    const group = argVal(n.args, -1, 'group');
    const inline = argVal(n.args, -1, 'inline');
    const tooltip = argVal(n.args, -1, 'tooltip');
    const options = argVal(n.args, -1, 'options');
    if (minval && isNum(minval)) schema.minval = minval.v;
    if (maxval && isNum(maxval)) schema.maxval = maxval.v;
    if (step && isNum(step)) schema.step = step.v;
    if (group?.kind === 'string') schema.group = group.v;
    if (inline?.kind === 'string') schema.inline = inline.v;
    if (tooltip?.kind === 'string') schema.tooltip = tooltip.v;
    if (options?.kind === 'array') {
      schema.options = options.v.map(v => ('v' in v ? v.v : v.kind));
    }
    out.push(schema);
  });
  return out;
}

/** Generic recursive AST walker (Arg / case / elseIf wrappers handled).
 *  Kept separate from astChildren: this one VISITS each node (callback)
 *  and recurses pre-order, while astChildren only COLLECTS one level of
 *  children — stmtMayExitTop needs that two-phase shape. Unifying them
 *  isn't worth the flag-parameter complexity (CR2). */
function walkNodes(nodes: Node | Node[] | undefined | null, fn: (n: Node) => void): void {
  if (!nodes) return;
  if (Array.isArray(nodes)) {
    for (const n of nodes) walkNodes(n, fn);
    return;
  }
  fn(nodes);
  const rec = nodes as unknown as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (k === 'loc' || k === 'type') continue;
    const v = rec[k];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (!item || typeof item !== 'object') continue;
        if ('type' in item) {
          walkNodes(item as Node, fn);
          continue;
        }
        // Arg / case / elseIf wrapper objects
        if ('value' in item && item.value && typeof item.value === 'object' && 'type' in item.value)
          walkNodes(item.value as Node, fn);
        if ('body' in item && Array.isArray(item.body)) walkNodes(item.body as Node[], fn);
        if ('test' in item && item.test && typeof item.test === 'object' && 'type' in item.test)
          walkNodes(item.test as Node, fn);
      }
    } else if (v && typeof v === 'object' && 'type' in v) {
      walkNodes(v as Node, fn);
    }
  }
}

// ── interpreter-owned constants ───────────────────────────────────────────────

registerConstant('', 'na', NA);
registerConstant('', 'true', VTRUE);
registerConstant('', 'false', VFALSE);
registerConstant('math', 'pi', { kind: 'float', v: Math.PI });
registerConstant('math', 'e', { kind: 'float', v: Math.E });
registerConstant('math', 'phi', { kind: 'float', v: (1 + Math.sqrt(5)) / 2 });
registerConstant('barmerge', 'gaps_off', { kind: 'string', v: 'barmerge.gaps_off' });
registerConstant('barmerge', 'gaps_on', { kind: 'string', v: 'barmerge.gaps_on' });
registerConstant('barmerge', 'lookahead_off', { kind: 'string', v: 'barmerge.lookahead_off' });
registerConstant('barmerge', 'lookahead_on', { kind: 'string', v: 'barmerge.lookahead_on' });
