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
  type DrawObj,
  type HistRef,
  type IndicatorDecl,
  type InputSchemaLite,
  type Member,
  type Node,
  type Param,
  type PlotSink,
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
import { BarSeries, ForwardingSeries, LitSeries, histGetAt, setActiveSeriesSet, valueAt, type IncSnap } from './series';
import { Scope, blockFrame, seriesOf, type Frame } from './scope';
import { BarCtx, MemoryDrawSink, type DrawSnap } from './context';
import { BUILTINS, HIST_BUILTINS, getConstant, histSpecHas, kindBuiltin, registerConstant } from './builtins/registry';
import { truthy, drainBindWarnings, type RtCtx } from './builtins/util';
import { declDrawQuotas, INDICATOR_DECL_ORDER, warnUnsupportedIndicatorParams } from './builtins/draw';
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
  type UdtMethodDef,
} from './udt';
import { jitCompile, jitCompileUdf } from './jit';

export type { Frame } from './scope';
export { PineRuntimeError } from './errors';

// ── MTF injection seam ────────────────────────────────────────────────────────

export interface MtfHooks {
  tryEvalSecurity(node: Node, frame: Frame): Value | null;
  prepareSecurity(body: Node[], frame0?: unknown): void;
  prefetchSecurity(ctx: BuiltinCtx, frame?: Frame, chartBars?: BarData[]): Promise<void>;
  /** The store the last prepareSecurity created — buildSess stashes it on
   *  the session so a sibling run's prepareSecurity can't wipe it. */
  sessionStore?(): unknown;
  /** Make this session's MTF store the active one before evaluation. */
  activate?(store: unknown): void;
  /** Checkpoint the ACTIVE store's per-spec tf state (snap carries the
   *  store so restore works regardless of which store is active). */
  checkpoint?(sess: PineSess): unknown;
  restore?(snap: unknown): void;
  /** Refetch every spec's feed for a live session (tape grew → higher-tf
   *  bars may have closed). No-op for stores without specs. */
  refresh?(ctx: BuiltinCtx, frame?: Frame): Promise<void>;
  /** mtf.ts binds evaluator adapters for its tf child frames. */
  bindEval?: (
    e: (n: Node, s: Scope, c: BuiltinCtx) => Value,
    b: (st: Node[], s: Scope, c: BuiltinCtx) => Value,
  ) => void;
  /** mtf.ts binds the checkpoint helpers (cloneDeep/ctx.state walkers). */
  bindSnap?: (
    c: <T>(v: T, ids: Map<unknown, unknown>) => T,
    sn: (state: Map<unknown, unknown> | undefined, ids: Map<unknown, unknown>) => CtxStateSnap,
    rs: (ck: CtxStateSnap, bar: number, ids: Map<unknown, unknown>) => void,
  ) => void;
}

let mtf: MtfHooks | null = null;

export function registerMtf(h: MtfHooks): void {
  mtf = h;
  h.bindEval?.(
    (n, s, c) => evalExpr(n, { scope: s, ctx: c }),
    (st, s, c) => evalBlock(st, { scope: s, ctx: c }),
  );
  h.bindSnap?.(cloneDeep, snapCtxState, restoreCtxState);
}

// ── per-run state ─────────────────────────────────────────────────────────────

interface RunState {
  /** Declaring node → the variable's BarSeries (stable across bars/scopes). */
  declSlots: Map<object, BarSeries>;
  /** Declaring node → live CowSeries for `var` alias decls (carries the
   *  materialized `:=` copy across bars; rebind() re-points the inner each
   *  bar so reads still see the caller's current history until a write). */
  declCows: Map<object, CowSeries>;
  /** declSlots key whose entry is FOREIGN-OWNED (ctx.close / a UDF/call /
   *  security / tf-domain series the decl merely aliases). A later
   *  mixed-kind scalar decl on the same key must NOT setAt through it —
   *  slotFor() swaps in an owned BarSeries and clears the tag. */
  declAliased: Set<object>;
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
  /** Site-path trie: callsite string → … → node → stable key object for
   *  declSlots/callHist/tupleKeys. Root map keyed by callsite string. */
  siteTrie: Map<unknown, unknown>;
  /** Parallel to siteStack: siteCtx[i] is the trie node reached after
   *  siteStack[0..i] — maintained on push/pop so siteKey() is one Map.get
   *  instead of a depth+2 trie walk. */
  siteCtx: Map<unknown, unknown>[];
  warned: Set<string>;
  /** Top-level frame of the current bar (ctx.callUdf re-enters here). */
  topFrame: Frame | null;
  /** One-off per-run slots (bar_index synth). */
  misc: Map<string, BarSeries>;
  /** TupleAssign node → per-name slot keys. */
  tupleKeys: Map<Node, Map<string, object>>;
  /** callsite key → param name → persistent CowSeries (UDF-local series carry bar history). */
  paramCows: Map<object, Map<string, CowSeries>>;
  /** UDF body Node[] → compiled JitState (lazy; undefined until first use). */
  udfJit: WeakMap<Node[], JitState | null>;
 /** Call node → selfType → resolved UdtMethodDef (null = none). Registry
  *  resets per runScript, so the cache lives on RunState, not module level. */
 udtMethodCache: WeakMap<Node, Map<string, UdtMethodDef | null>>;
}

const runStates = new WeakMap<BuiltinCtx, RunState>();

function runOf(ctx: BuiltinCtx): RunState {
  let r = runStates.get(ctx);
  if (!r) {
    r = {
      declSlots: new Map(),
      declCows: new Map(),
      declAliased: new Set(),
      trackedSlots: new Set(),
      ensureList: [],
      topLevelBody: false,
      topStmtIdx: -1,
      pruneCutoff: Infinity,
      callHist: new Map(),
      callsites: new Map(),
      callsiteSeq: 0,
      siteStack: [],
      siteTrie: new Map(),
      siteCtx: [],
      warned: new Set(),
      topFrame: null,
      misc: new Map(),
      tupleKeys: new Map(),
      paramCows: new Map(),
      udfJit: new WeakMap(),
      udtMethodCache: new WeakMap(),
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

  /** Identity of the forwarded source — lets callers skip a rebind alloc
   *  when the incoming arg is the same series object. */
  get source(): Series { return this.inner; }

  /** True once `:=` materialized a private copy (then seed() matters). */
  get isDirty(): boolean { return this.cow !== null; }

  /** Rebind returns a NEW CowSeries sharing this one's materialized copy:
   * the `:=` history must survive the name's re-declaration, but an array
   * slot that captured THIS wrapper (evalExpr returns {kind:'series'} = the
   * wrapper object) must keep reading the old inner — mutating this.inner
   * in place would retro-mutate every stored reference. */
  rebind(inner: Series): CowSeries {
    const n = new CowSeries(inner);
    n.cow = this.cow; // shared materialized copy
    return n;
  }

  /** Re-seed the current bar's slot — Pine re-binds names every
   *  invocation/bar, so a carried-forward `:=` value must not leak into the
   *  next bar's reads. No-op until a write materialized the local copy.
   *  `v` is a THUNK: the arg's current value is only sampled when a copy
   *  exists — an eager read on a non-materialized cow would needlessly poke
   *  emit-history producers (SecSeries atOffset mutates their emit cache).
   *  Guard retro-writes: out-of-order evalAt can seed a bar the copy already
   *  advanced past — a clamped setAt would corrupt history. Drop it. */
  seed(v: () => Value, bar: number): void {
    if (this.cow && bar >= this.cow.currentBar) this.cow.setAt(bar, v());
  }

  /** Materialize the private copy, mapping `inner`'s history onto bar indexes. */
  private writable(bar: number): BarSeries {
    if (this.cow) return this.cow;
    const src = this.inner;
    const base = Math.max(bar, src instanceof BarSeries ? src.currentBar : 0);
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

  /** Incremental driver: snapshot the materialized copy (or its absence). */
  incCowGet(): { cow: BarSeries; snap: IncSnap } | null {
    return this.cow ? { cow: this.cow, snap: this.cow.incSnap() } : null;
  }
  /** Restore the materialized copy: null un-materializes; else re-link the
   *  snap's cow (rebind may have spawned a twin CowSeries since). */
  incCowSet(v: { cow: BarSeries; snap: IncSnap } | null): void {
    if (v === null) { this.cow = null; return; }
    v.cow.incRewind(v.snap);
    this.cow = v.cow;
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
  // Empty stack → the node itself is the key (top-level decls).
  if (run.siteCtx.length === 0) return node;
  // siteCtx mirrors siteStack — leaf map reached via the top entry.
  const leafMap = run.siteCtx[run.siteCtx.length - 1]!;
  let leaf = leafMap.get(node) as object | undefined;
  if (leaf === undefined) { leaf = {}; leafMap.set(node, leaf); }
  return leaf;
}

/** Push a callsite onto both stacks; siteCtx walks (and grows) the trie. */
function pushSite(run: RunState, site: string): void {
  run.siteStack.push(site);
  const parent = run.siteCtx.length ? run.siteCtx[run.siteCtx.length - 1]! : run.siteTrie;
  let child = parent.get(site) as Map<unknown, unknown> | undefined;
  if (child === undefined) { child = new Map(); parent.set(site, child); }
  run.siteCtx.push(child);
}

/** Callsite-composed identity for `node` — mtf.ts uses it to key chart-domain
 *  security() emit history per caller callSITE: a UDF body's shared AST node
 *  reached through different invocation sites must keep separate histories.
 *  (The caller Scope itself can't be the key — UDF call scopes are ephemeral,
 *  allocated fresh per invocation, so history under them would never survive
 *  to the next bar.) */
export function callsiteKey(ctx: BuiltinCtx, node: object): object {
  return siteKey(runOf(ctx), node);
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
  if (!s || run.declAliased.has(key)) {
    // Missing slot — or a foreign alias target a mixed-kind flip must not
    // write through: swap in an owned BarSeries and clear the tag.
    s = new BarSeries();
    run.declSlots.set(key, s);
    run.declAliased.delete(key);
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
    // Aliased decl (x = series expr): registration stays unconditional —
    // the alias target's own write cadence is unknown, and add is deduped
    // anyway. declSlots keeps the RAW slot but tags it foreign-owned:
    // `x := …` on the name must not write through into ctx.close or a
    // SecSeries, and a later mixed-kind scalar decl on the same key must
    // swap in an owned slot (slotFor). The name binds a CowSeries: reads
    // delegate to v.v; the first `:=` materializes a private copy.
    // EVERY series decl gets a tracked cow in declCows (`var` included):
    // rebind() returns a FRESH wrapper sharing the materialized copy (old
    // wrappers captured into arrays must keep their inner), and
    // non-persistent decls re-seed the shared copy with the current value —
    // `x = e` re-inits every bar, so a carried `:=` value must not survive.
    // trackSeries(run, v.v); — REMOVED R12: alias targets are already tracked
    // by their own binding site or written every bar; registering per-bar-fresh
    // LiftedSeries here permanently grew ensureList to 24k (83% no-op calls).
    run.declSlots.set(key, v.v);
    run.declAliased.add(key);
    let cow = run.declCows.get(key);
    if (cow && v.v === cow) {
      // Self-alias: the decl's RHS resolved to this decl's own cow (e.g.
      // `x = cond ? x : other` re-entered where x was previously bound to
      // this cow). Rebinding inner to itself would make readTarget()
      // infinitely recurse. The name stays bound to the cow; declSlots and
      // declAliased already carry the alias target's record — nothing to
      // re-point.
      scope.define(name, cow);
      return v.v;
    }
    if (!cow) {
      cow = new CowSeries(v.v);
    } else {
      // Fresh wrapper each bind: the previous wrapper object may live inside
      // array slots (vals[i] = tmpV) and must keep reading its old inner.
      // The materialized `:=` copy is adopted so write history survives.
      cow = cow.rebind(v.v);
    }
    if (!persistent) cow.seed(() => valueAt(v.v, bar), bar);
    run.declCows.set(key, cow);
    // Non-persistent decls re-init every bar: seed the materialized copy with
    // this bar's RHS value so a carried `:=` doesn't leak past a re-decl.


    scope.define(name, cow);
    return v.v;
  }
  // A `na` scalar on a decl whose raw slot is a SecSeries is the gaps_on
  // "no emission this chart bar" transport artifact, not a value to store —
  // keep the name on the existing cow (unmaterialized → forwards to the
  // SecSeries, whose cur() forward-fills the last emitted tf value). A
  // ternary like `x = cond ? high : na` produces a REAL na the user means:
  // it must land in an owned slot, not hide behind a stale ctx alias.
  if (v.kind === 'na' && run.declAliased.has(key)
      && run.declSlots.get(key)?.constructor.name === 'SecSeries') {
    const cow = run.declCows.get(key);
    if (cow) {
      scope.define(name, cow);
      return cow;
    }
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

// Perf instrumentation — counts evalNode hits per type for scratch benches.
// Zero cost in prod (guarded by global flag, lazily attached).
export const __evalNodeCounts = new Map<string, number>();

function evalNode(node: Node, frame: Frame): Value {
  const { scope, ctx } = frame;
  const run = runOf(ctx);
  const bar = ctx.barIndex;
  if ((globalThis as Record<string, unknown>).__pineEvalCount) {
    __evalNodeCounts.set(node.type, (__evalNodeCounts.get(node.type) ?? 0) + 1);
  }

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
          const s = run.declCows.get(dk) ?? run.declSlots.get(dk)!;
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
        slotFor(run, k, scope, name, /*persistent*/ !!node.var).setAt(
          bar,
          items[i] === undefined ? NA
            : items[i]!.kind === 'series' ? valueAt(items[i]!.v, bar)
            : items[i]!,
        );
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
      warnUnsupportedIndicatorParams(ctx, node.args);
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
      // Tolerant orderings: ints compare exactly, floats count a difference
      // within CMP_EPSILON as equal. `<=`/`>=` keep the raw comparison in front
      // — two equal infinities have a nan difference, which would be false.
      case '<': return (bothInt ? l.v < r.v : l.v - r.v < -CMP_EPSILON) ? VTRUE : VFALSE;
      case '>': return (bothInt ? l.v > r.v : l.v - r.v > CMP_EPSILON) ? VTRUE : VFALSE;
      case '<=': return (bothInt ? l.v <= r.v : l.v <= r.v || l.v - r.v <= CMP_EPSILON) ? VTRUE : VFALSE;
      case '>=': return (bothInt ? l.v >= r.v : l.v >= r.v || l.v - r.v >= -CMP_EPSILON) ? VTRUE : VFALSE;
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

/** Pine's comparison tolerance: `<`, `>`, `<=`, `>=`, `==`, `!=` treat float
 *  operands closer than this as equal (absolute, measured on TradingView — the
 *  boundary value itself counts as equal). Integers need no guard: int±int
 *  differences are 0 or at least 1, so the tolerance can never bridge them. */
const CMP_EPSILON = 1e-10;

function valueEq(l: Value, r: Value): boolean {
  const a = unseries(l);
  const b = unseries(r);
  if (isNum(a) || isNum(b)) {
    if (!isNum(a) || !isNum(b)) return false;
    // The tolerant branch is reachable only when a real float is involved;
    // strings, colors, booleans and object references keep exact equality.
    if (a.kind === 'int' && b.kind === 'int') return a.v === b.v;
    return Math.abs(a.v - b.v) <= CMP_EPSILON;
  }
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

  // `ns.prop` / `ns.sub.prop` where the head is not a bound identifier →
  // constant / builtin / ctx record. The chain flattens exactly like a dotted
  // builtin call, so three-level constants (strategy.direction.long,
  // strategy.oca.cancel, …) resolve instead of stopping at `ns.sub`.
  const parts: string[] = [prop];
  let head: Node = objNode;
  while (head.type === 'member' && !head.computed) { parts.unshift(head.prop); head = head.obj; }
  if (head.type === 'ident' && scope.lookup(head.name) === undefined) {
    parts.unshift(head.name);
    const key = parts.join('.');
    const c = getConstant(key, ctx);
    if (c !== undefined) return c;
    const b = BUILTINS.get(key);
    if (b) return { kind: 'function', v: b };
    if (head.name === 'syminfo') {
      const f = ctx.syminfo[prop];
      if (f !== undefined) return f;
    }
    if (head.name === 'timeframe') {
      const f = timeframeFields(ctx).get(prop);
      if (f !== undefined) return f;
    }
    if (head.name === 'barstate') {
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
  pushSite(run, site);
  try {
    return evalCallDispatch(node, frame);
  } finally {
    run.siteStack.pop();
    run.siteCtx.pop();
    rt.callsite = prevSite;
  }
}
// Call node → memoized `ns.fn` builtin resolution. Permanent per Call node:
// safe ONLY because all registerBuiltin calls run at import time
// (builtins/*.ts self-register via registry.ts) — a builtin can never appear
// after the first dispatch of a given callsite.
const RESOLVED_BUILTIN = new WeakMap<Call, { headName: string; fn: BuiltinFn | undefined }>();

/** getUdtMethod memoized per (callsite node, selfType) — a call node's method
 * name and its receiver's runtime type are bar-stable; caching skips
 * normalizeSelfType + map-key allocation per invocation (~2% UDT-heavy). */
function udtMethodAt(run: RunState, node: Call, selfType: string, name: string): UdtMethodDef | undefined {
  let byType = run.udtMethodCache.get(node);
  if (!byType) { byType = new Map(); run.udtMethodCache.set(node, byType); }
  const key = `${selfType}.${name}`;
  let hit = byType.get(key);
  if (hit === undefined) {
    hit = getUdtMethod(selfType, name) ?? null;
    byType.set(key, hit);
  }
  return hit ?? undefined;
}


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
      const def = udtMethodAt(run, node, obj.v.typeName, prop);
      if (def) {
        const bound = bindCallArgs(node.args, def.params.slice(1), frame, paramFlags(def.params, def.body));
        return callUdtMethod(obj.v, prop, bound, ctx);
      }
    } else {
      const b = kindBuiltin(obj.kind, prop);
      if (b) {
        const args: Value[] = [obj];
        const named: Record<string, Value> = {};
        const spec = HIST_BUILTINS.get(b);
        // pos starts at 1: args[0] is the receiver ('id' slot), callsite
        // positionals bind order[1..].
        let pos = 1;
        for (const a of node.args) {
          const v = evalArg(a, frame, true, !histSpecHas(spec, a.name === undefined ? pos++ : -1, a.name));
          if (a.name) named[a.name] = v;
          else args.push(v);
        }
        return callBuiltin(b, ctx, args, named, node);
      }
      const prim = udtMethodAt(run, node, obj.kind, prop);
      if (prim) {
        const bound = bindCallArgs(node.args, prim.params.slice(1), frame, paramFlags(prim.params, prim.body));
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
  const spec = HIST_BUILTINS.get(b);
  let pos = 0;
  for (const a of node.args) {
    const v = evalArg(a, frame, true, !histSpecHas(spec, a.name === undefined ? pos++ : -1, a.name));
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
    return b(ctx, args, named);
  } catch (e) {
    if (e === BREAK || e === CONTINUE || e instanceof ReturnSignal) throw e;
    throw wrapPineError(e, node);
  } finally {
    // Flush arg-binding warnings (e.g. `source=`+`series=` both given) now
    // that a ctx is reachable; dedup so a per-bar builtin warns once. Must run
    // in `finally` — on a thrown builtin the queue is module-global, so an
    // undrained warning would leak onto the NEXT call's ctx.
    for (const w of drainBindWarnings()) {
      if (!ctx.warnings.includes(w)) ctx.warnings.push(w);
    }
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
 *  A noHist arg bound to a builtin param that neither scans its history
 *  (HIST_BUILTINS, registry.ts) nor stashes the arg Value skips callHist —
 *  builtins unwrap args via .cur() so tracking is invisible to them.
 */
interface ParamFlag { hist: boolean; mut: boolean }
/** Param-array → per-name {hist: reads x[n], mut: x := / x[i] := / passed to
 *  a call}. Computed once per decl — params arrays are shared objects. */
const PARAM_FLAGS = new WeakMap<Param[], Map<string, ParamFlag>>();
function paramFlags(params: Param[], body: Node | Node[] | undefined): Map<string, ParamFlag> {
  let f = PARAM_FLAGS.get(params);
  if (f) return f;
  const names = new Set(params.map(p => p.name));
  f = new Map(params.map(p => [p.name, { hist: false, mut: false }]));
  walkNodes(body, (n) => {
    if (n.type === 'histref') {
      const o = (n as HistRef).obj;
      if (o.type === 'ident' && names.has((o as { name: string }).name))
        f!.get((o as { name: string }).name)!.hist = true;
    } else if (n.type === 'reassign') {
      const t = (n as Reassign).target;
      const nm = t.type === 'ident' ? (t as { name: string }).name
        : t.type === 'histref' && (t as HistRef).obj.type === 'ident'
          ? ((t as HistRef).obj as { name: string }).name : undefined;
      if (nm && names.has(nm)) f!.get(nm)!.mut = true;
    } else if (n.type === 'call') {
      // Param passed into another call may be history-read/mutated inside —
      // treat as needing full tracking (conservative).
      for (const a of (n as Call).args)
        if (a.value?.type === 'ident' && names.has((a.value as { name: string }).name)) {
          f!.get((a.value as { name: string }).name)!.hist = true;
          f!.get((a.value as { name: string }).name)!.mut = true;
        }
    }
  });
  PARAM_FLAGS.set(params, f);
  return f;
}

function evalArg(a: Arg, frame: Frame, litFastPath = false, noHist = false): Value {
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
  // Param never reads its own history and isn't history-passed — the arg's
  // scalar lands in a throwaway param slot; callHist tracking is waste.
  if (noHist) return v;
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

/** Bind callsite args (named first, then positional) against a param list.
 *  `flags` = paramFlags(params, body) — when given, scalar args bound to a
 *  param that never reads history skip callHist (evalArg noHist). */
function bindCallArgs(callArgs: Arg[], params: Param[], frame: Frame,
                      flags?: Map<string, ParamFlag>): Value[] {
  const out: Value[] = new Array<Value>(params.length);
  const noHist = (p: Param) => flags !== undefined && flags.get(p.name)?.hist === false;
  // Fast path: all-positional calls (the common case) skip the Set +
  // positionals staging array — eval args straight into param order.
  if (!callArgs.some(a => a.name !== undefined)) {
    const n = Math.min(callArgs.length, params.length);
    for (let i = 0; i < n; i++) out[i] = evalArg(callArgs[i]!, frame, false, noHist(params[i]!));
    for (let i = n; i < params.length; i++) {
      const d = params[i]!.default;
      out[i] = d !== undefined ? evalExpr(d, frame) : NA;
    }
    return out;
  }
  const filled = new Set<number>();
  const positionals: Arg[] = [];
  for (const a of callArgs) {
    if (a.name !== undefined) {
      const i = params.findIndex(p => p.name === a.name);
      if (i >= 0 && !filled.has(i)) {
        out[i] = evalArg(a, frame, false, noHist(params[i]!));
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
    out[p] = evalArg(a, frame, false, noHist(params[p]!));
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
  return callUdfValue(fn, bindCallArgs(node.args, fn.params, frame, paramFlags(fn.params, fn.body)), frame, node);
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
  const flags = paramFlags(fn.params, fn.body);
  fn.params.forEach((p, i) => {
    const a = args[i] ?? NA;
    if (a.kind === 'series') {
      // Param never reads its own history and is never rebound — it can bind
      // the caller's series directly; no CowSeries wrapper, no paramCows slot.
      const pf = flags.get(p.name);
      if (pf && !pf.hist && !pf.mut) { callScope.define(p.name, a.v); return; }
      if (cowKey) {
        let byParam = run.paramCows.get(cowKey);
        if (!byParam) { byParam = new Map(); run.paramCows.set(cowKey, byParam); }
        let cow = byParam.get(p.name) as CowSeries | undefined;
        if (!cow) cow = new CowSeries(a.v);
        // Skip the rebind alloc when the arg is the same series object —
        // the stored cow already forwards to it.
        else if (cow.source !== a.v) cow = cow.rebind(a.v);
        byParam.set(p.name, cow);
        // Pine re-binds params each invocation: seed this bar's slot with the
        // arg's current value so a previous bar's `:=` doesn't carry forward
        // into this bar's reads. Only build the thunk when a materialized
        // copy exists — seed() is a no-op before the first `:=`.
        if (cow.isDirty) cow.seed(() => a.v.cur(), bar);
        callScope.define(p.name, cow);
      } else {
        // No callNode (method dispatch via ctx.callUdf): seed a
        // fresh CowSeries even when the arg is already one — the
        // callee's `:=` must materialize a private copy, never
        // write through into the caller's param series.
        callScope.define(p.name, new CowSeries(a.v));
      }
    } else {
      // !hist && !mut — the param never reads x[n] and never rebinds:
      // bind the raw value; scalar x[1] is unreachable and `:=` can't fire.
      const pf = flags.get(p.name);
      if (pf && !pf.hist && !pf.mut) { callScope.define(p.name, a); return; }
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
    if (udfJitEnabled() && Array.isArray(fn.body)) {
      const js = udfJitState(fn.body, run, ctx);
      if (js) {
        // Swap the JitState's frame to this call's scope — R bindings read
        // state.cur live, so nesting/recursion save+restore around the call.
        const prevCur = js.cur;
        js.cur = callFr;
        js.scopeStack.length = 0;
        js.scopeStack.push(callScope);
        js.save.length = 0;
        try {
          __pineJitStats.udfRuns++;
          return js.fn(js.udfR, run, js.nodes);
        } finally {
          js.cur = prevCur;
        }
      }
    }
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
    // Built-in bar series are read-only — `close := x` must not write into
    // ctx.close (identity check also catches tf-frame ctx shadows, and UDF
    // param bindings pass because their slot is a different object).
    if (slot === ctx.open || slot === ctx.high || slot === ctx.low ||
        slot === ctx.close || slot === ctx.volume || slot === ctx.time ||
        slot === ctx.hl2 || slot === ctx.hlc3 || slot === ctx.ohlc4 ||
        slot === ctx.hlcc4) {
      throw pineErr(node, `cannot reassign built-in variable '${t.name}'`);
    }
    const raw = evalExpr(node.value, frame);
    const v = unseries(raw);
    if (slot instanceof BarSeries) {
      slot.setAt(bar, v);
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
// ── compile-to-closures ─────────────────────────────────────────────────────
// Top-level stmt → closure. Compiled fns embed evalExpr's exact error
// contract: rethrow BREAK/CONTINUE/ReturnSignal, else wrapPineError(e, node).
// Every read of scope/ctx.barIndex/run.* happens inside the closure — nothing
// per-run is baked at compile time.

/** Per-bar stmt closure — drop-in for evalExpr(node, frame) semantics. */
type Compiled = (frame: Frame, run: RunState) => Value;

type CompiledStmt =
  | { kind: 'direct'; fn: Compiled }
  | { kind: 'twoPhase'; isFresh: (run: RunState) => boolean; fresh: Compiled; later: Compiled }
  | { kind: 'fallback'; node: Node };

export let __compileCalls = 0; // test instrumentation
/** stmt.type → last compilation disposition (test/bench instrumentation). */
export const __compiledKinds = new Map<string, 'direct' | 'twoPhase' | 'fallback'>();

/** Compiled path enabled unless explicitly opted out (env or global).
 *  Evaluated once per runScriptInner — a mid-run flip never interleaves paths. */
function compiledEnabled(): boolean {
  const g = globalThis as Record<string, unknown>;
  if (g.__pineInterp === true) return false;
  if (typeof process !== 'undefined' && process.env?.PINE_INTERP === '1') return false;
  // Compiled path is the default; opt out via `__pineInterp`/`PINE_INTERP=1`.
  return true;
}

/** Wraps a raw per-kind body so it carries evalExpr's error contract. */
const wrapCompiled = (node: Node, body: Compiled): Compiled =>
  (frame, run) => {
    try {
      return body(frame, run);
    } catch (e) {
      if (e === BREAK || e === CONTINUE || e instanceof ReturnSignal) throw e;
      throw wrapPineError(e, node);
    }
  };

/** Child-node compiler: compilable kinds get closures; everything else
 *  delegates to evalExpr (which keeps its own error wrap for that node). */
function compileChild(node: Node): Compiled {
  const c = compile(node);
  if (c.kind === 'fallback') {
    return (frame) => evalExpr(node, frame);
  }
  if (c.kind === 'twoPhase') {
    return (frame, run) => (c.isFresh(run) ? c.fresh : c.later)(frame, run);
  }
  return c.fn;
}

function compile(stmt: Node): CompiledStmt {
  __compileCalls++;
  const out = compileStmt(stmt);
  __compiledKinds.set(
    stmt.type === 'var' && stmt.multi && stmt.multi.length > 0 ? 'var[multi]' : stmt.type,
    out.kind,
  );
  return out;
}

function compileStmt(stmt: Node): CompiledStmt {
  switch (stmt.type) {
    case 'num': { const v = stmt.isInt; const n = stmt.v;
      return { kind: 'direct', fn: wrapCompiled(stmt, () => numVal(n, v)) }; }
    case 'str': { const s = stmt.v;
      return { kind: 'direct', fn: wrapCompiled(stmt, () => ({ kind: 'string', v: s })) }; }
    case 'bool': { const b = !!stmt.v;
      return { kind: 'direct', fn: wrapCompiled(stmt, () => (b ? VTRUE : VFALSE)) }; }
    case 'color': { const c = stmt.v;
      return { kind: 'direct', fn: wrapCompiled(stmt, () => ({ kind: 'color', v: c })) }; }
    case 'na':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => NA) };
    case 'ident': { const name = stmt.name;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalIdent(name, frame)) }; }
    case 'unary': { const op = stmt.op; const arg = compileChild(stmt.arg);
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) =>
        evalUnary(op, unseries(arg(frame, run)))) }; }
    case 'binary': { const op = stmt.op;
      const L = compileChild(stmt.left), R = compileChild(stmt.right);
      if (op === 'and') return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const l = unseriesTruth(L(frame, run));
        return l && unseriesTruth(R(frame, run)) ? VTRUE : VFALSE; }) };
      if (op === 'or') return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const l = unseriesTruth(L(frame, run));
        return l || unseriesTruth(R(frame, run)) ? VTRUE : VFALSE; }) };
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) =>
        evalBinary(op, unseries(L(frame, run)), unseries(R(frame, run)), run, frame.ctx)) }; }
    case 'ternary': { const T = compileChild(stmt.test),
        C = compileChild(stmt.cons), A = compileChild(stmt.alt);
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) =>
        unseriesTruth(T(frame, run)) ? C(frame, run) : A(frame, run)) }; }
    case 'arraylit': { const items = stmt.items.map(compileChild);
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) =>
        ({ kind: 'array', v: items.map(f => f(frame, run)) })) }; }
    case 'member':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalMember(stmt as Member, frame)) };
    case 'histref':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalHistref(stmt as HistRef, frame)) };
    case 'call':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalCall(stmt as Call, frame)) };
    case 'assign': case 'let': case 'const': {
      const val = compileChild(stmt.value);
      const name = stmt.name;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const v = val(frame, run);
        bindDeclared(run, siteKey(run, stmt), frame.scope, name, v, frame.ctx.barIndex);
        return v.kind === 'series' ? v.v.cur() : v;
      }) };
    }
    case 'typed': {
      const val = stmt.value !== undefined ? compileChild(stmt.value) : null;
      const name = stmt.name;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const bar = frame.ctx.barIndex;
        if (!val) {
          slotFor(run, siteKey(run, stmt), frame.scope, name).setAt(bar, NA);
          return NA;
        }
        const v = val(frame, run);
        bindDeclared(run, siteKey(run, stmt), frame.scope, name, v, bar);
        return v.kind === 'series' ? v.v.cur() : v;
      }) };
    }
    case 'tuple': {
      // var tuple → verbatim body (per-name freshness; see Task 4 decision D2).
      // non-var: value child compiled; keys map stays in run.tupleKeys.
      const val = compileChild(stmt.value);
      const isVar = !!stmt.var; const names = stmt.names;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const scope = frame.scope, bar = frame.ctx.barIndex;
        let keys = run.tupleKeys.get(siteKey(run, stmt) as Node);
        if (!keys) { keys = new Map(); run.tupleKeys.set(siteKey(run, stmt) as Node, keys); }
        if (isVar) {
          const fresh = names.some(n => {
            const k = keys!.get(n);
            return k === undefined || !run.declSlots.has(k);
          });
          if (!fresh) {
            const carried: Value[] = [];
            for (const name of names) {
              const s = run.declSlots.get(keys!.get(name)!);
              if (s) { scope.define(name, s); carried.push(valueAt(s, bar)); }
              else carried.push(NA);
            }
            return { kind: 'array', v: carried };
          }
        }
        const v = val(frame, run);
        const items = v.kind === 'array' ? v.v : v.kind === 'matrix' ? v.v.flat() : [v];
        names.forEach((name, i) => {
          let k = keys!.get(name);
          if (!k) { k = {}; keys!.set(name, k); }
          slotFor(run, k, scope, name, /*persistent*/ isVar).setAt(
            bar,
            items[i] === undefined ? NA
              : items[i]!.kind === 'series' ? valueAt(items[i]!.v, bar)
              : items[i]!,
          );
        });
        return v;
      }) };
    }
    case 'reassign':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalReassign(stmt as Reassign, frame)) };
    case 'seq':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalBlock(stmt.stmts, frame)) };
    case 'break':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => { throw BREAK; }) };
    case 'continue':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => { throw CONTINUE; }) };
    case 'return': {
      const val = stmt.value ? compileChild(stmt.value) : null;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        throw new ReturnSignal(val ? unseries(val(frame, run)) : { kind: 'void' });
      }) };
    }
    case 'func': { const name = stmt.name, params = stmt.params, body = stmt.body;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => {
        const decl: UdfDecl = { name, params, body, closure: frame.scope }; // live scope — never bake
        frame.scope.define(name, { kind: 'function', v: decl });
        return { kind: 'void' };
      }) };
    }
    case 'arrow': { const params = stmt.params, body = stmt.body;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => ({
        kind: 'function',
        v: { name: '<anonymous>', params, body, closure: frame.scope },
      })) };
    }
    case 'method':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => { registerMethod(stmt); return { kind: 'void' }; }) };
    case 'typedecl':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => { registerType(stmt); return { kind: 'void' }; }) };
    case 'field':
      return { kind: 'direct', fn: wrapCompiled(stmt, () => ({ kind: 'void' })) };
    case 'import': { const msg = `import '${stmt.ns}.${stmt.name}' ignored (libraries not supported)`;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => { warn(run, frame.ctx, msg); return { kind: 'void' }; }) };
    }
    case 'export':
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame) => evalExpr(stmt.decl, frame)) };
    case 'var': {
      if (!stmt.multi || stmt.multi.length === 0) {
        // single-name var/varip → twoPhase: init-eval is unreachable after
        // the first write; later bars rebind the persistent slot only.
        const it = stmt;
        const init = compileChild(it.value);
        const name = it.name;
        const varip = !!stmt.varip;
        const isFresh = (run: RunState) => !run.declSlots.has(siteKey(run, it));
        const fresh: Compiled = wrapCompiled(stmt, (frame, run) => {
          if (varip) warn(run, frame.ctx, `varip treated as var (realtime-bar persistence not implemented)`);
          const v = init(frame, run);
          bindDeclared(run, siteKey(run, it), frame.scope, name, v, frame.ctx.barIndex, /*persistent*/ true);
          return v.kind === 'series' ? v.v.cur() : v;
        });
        const later: Compiled = wrapCompiled(stmt, (frame, run) => {
          const s = run.declCows.get(siteKey(run, it)) ?? run.declSlots.get(siteKey(run, it))!;
          frame.scope.define(name, s);
          return valueAt(s, frame.ctx.barIndex);
        });
        return { kind: 'twoPhase', isFresh, fresh, later };
      }
      // multi-item: verbatim per-item dispatch (freshness is per item).
      const items = stmt.multi;
      const inits = items.map(it => compileChild(it.value));
      const varip = !!stmt.varip;
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        const scope = frame.scope, bar = frame.ctx.barIndex;
        if (varip) warn(run, frame.ctx, `varip treated as var (realtime-bar persistence not implemented)`);
        let last: Value = NA;
        items.forEach((it, i) => {
          const dk = siteKey(run, it);
          const fresh = !run.declSlots.has(dk);
          if (fresh) {
            const v = inits[i]!(frame, run);
            bindDeclared(run, dk, scope, it.name, v, bar, /*persistent*/ true);
            last = v.kind === 'series' ? v.v.cur() : v;
          } else {
            const s = run.declCows.get(dk) ?? run.declSlots.get(dk)!;
            scope.define(it.name, s);
            last = valueAt(s, bar);
          }
        });
        return last;
      }) };
    }
    case 'if': case 'ifexpr': {
      const test = compileChild(stmt.test);
      const elseIfs = stmt.elseIfs.map(e => ({ test: compileChild(e.test), body: e.body }));
      const thenB = stmt.then, elseB = stmt.else;
      const isExpr = stmt.type === 'ifexpr';
      return { kind: 'direct', fn: wrapCompiled(stmt, (frame, run) => {
        let branch: Node[] | null = null;
        if (unseriesTruth(test(frame, run))) {
          branch = thenB;
        } else {
          for (const e of elseIfs) {
            if (unseriesTruth(e.test(frame, run))) { branch = e.body; break; }
          }
          if (branch === null) branch = elseB;
        }
        if (branch === null) return isExpr ? NA : { kind: 'void' };
        return evalBlock(branch, blockFrame(frame)); // verbatim: fresh child scope + scopeDepth/topLevelBody bookkeeping
      }) };
    }
    // for/while/switch stay fallback — per-iter blockFrame + loopVar BarSeries
    // + BREAK/CONTINUE absorb (evalFor/evalWhile) and switch's matched-arm
    // BREAK→void vs default-arm propagate distinction are risky to duplicate.
    // indicator/strategy stay fallback — declDrawQuotas/strategyDecl per-bar
    // idempotence is unverified (conservative per boundary matrix).
    default:
      return { kind: 'fallback', node: stmt };
  }
}

// ── Slice-E: JIT host ───────────────────────────────────────────────────────
// jit.ts transpiles the top-level body into one JS source; each bar calls the
// compiled function with a shim `R` that delegates to the same helpers the
// evaluator uses — semantics are not re-implemented, only dispatch is skipped.

/** `__pineJit` — opt-IN flag; default OFF. Measured 2026-10-11 on K4.55
 * (935 bars): jit 2.59ms/bar vs compiled 2.30 vs interp 1.75 — R-call +
 * arg-descriptor + thunk overhead exceeds the dispatch savings at this
 * transpile depth (672/798 native). Kept as an opt-in experiment while the
 * real cost centre (series/UDF machinery, not node dispatch) is un-JITted.
 * `__pineInterp` still forces the fully-interpreted path. */
function jitEnabled(): boolean {
  const g = globalThis as Record<string, unknown>;
  if (g.__pineJit === true) return true;
  if (typeof process !== 'undefined' && process.env?.PINE_JIT === '1') return true;
  return false;
}

/** UDF-body JIT — default OFF since 2026-10-11. R12's −38% was measured
 *  before R13/R14 reworked the interpreted path (siteCtx hoist, paramFlags,
 *  histSpecHas); re-measured on both real scripts the JIT is now a net loss
 *  everywhere: MACD雙周期V7 5.75→4.47 ms/bar off, K4.55 4.12→3.14 off, even a
 *  10-stmt hot UDF loses (79 vs 67ms). The call preamble + scope swap cost
 *  more than the emit saves. Opt back in via `__pineJitUdf=true` /
 *  PINE_JIT_UDF=1; `__pineNoJitUdf` / PINE_JIT_UDF=0 also forces off.
 *  Compile failures silently fall back to the interpreted body. */
function udfJitEnabled(): boolean {
  const g = globalThis as Record<string, unknown>;
  // NoJit wins over Jit when both flags exist — a stale off-flag must not
  // be overridden by an experiment opt-in left set on globalThis.
  if (g.__pineNoJitUdf === true) return false;
  if (typeof process !== 'undefined' && process.env?.PINE_JIT_UDF === '0') return false;
  if (g.__pineJitUdf === true) return true;
  if (typeof process !== 'undefined' && process.env?.PINE_JIT_UDF === '1') return true;
  return false;
}

/** Compile-or-fetch the per-UDF-body JitState. Cached on run.udfJit keyed by
 * the body Node[] (stable parse object). `udfR` (the jitRuntime object) is
 * built once alongside — per-call cost is then just scope swap + js.fn. */
function udfJitState(body: Node[], run: RunState, ctx: BuiltinCtx): JitState | null {
  let js = run.udfJit.get(body);
  if (js !== undefined) return js;
  try {
    const { src, nodeTable, native, fallback } = jitCompileUdf(body);
    // Two gates, both measured on MACD雙周期V7 (15 UDF bodies, all <6 stmts):
    //   size — UDF-JIT nets −20% on small bodies (call preamble + scope swap
    //          never amortize, even at 100% native emit). Threshold 8 stmts
    //          keeps K4.55's large-body −38% win.
    //   coverage — a large body mostly falling back to R.evalStmt pays the
    //          preamble on top of the interp work it still does.
    // Cache null so the gate runs once per body, not per call.
    if (body.length < 8 || native < fallback) {
      run.udfJit.set(body, null);
      __pineJitStats.udfGated++;
      return null;
    }
    const fn = new Function('R', 'run', 'nodes', `"use strict";\n${src}`) as JitState['fn'];
    js = { fn, nodes: nodeTable, cur: null as unknown as Frame, scopeStack: [], save: [], udfR: undefined };
    js.udfR = jitRuntime(js, run, ctx);
    run.udfJit.set(body, js);
    __pineJitStats.udfCompiled++;
    return js;
  } catch (e) {
    if (!(globalThis as Record<string, unknown>).__pineJitQuiet)
      console.error('[udf-jit] compile failed:', e instanceof Error ? e.message : e);
    return null; // compile failure → interpreted path keeps semantics
  }
}

/** Bench instrumentation — per-run native/fallback stmt counts. */
/** JIT arg descriptor — jit.ts emits these inline at callsites so the callee's
 * evalArg flavor is chosen after dispatch resolves:
 * `i` ident (series-or-expr), `l` literal num/bool (LitSeries fast path when
 * litFastPath), `e` deferred expr thunk, `x` nodeTable idx for callHist keys. */
type JitArg = { k: 'i' | 'l' | 'e'; x: number; i?: string; n?: string; f?: () => Value };

export const __pineJitStats = { runs: 0, native: 0, fallback: 0, compileMs: 0, udfRuns: 0, udfCompiled: 0, udfGated: 0 };

interface JitState {
  fn: (R: unknown, run: RunState, nodes: Node[]) => Value;
  nodes: Node[];
  cur: Frame;                      // mutable — pushScope rewrites .scope
  scopeStack: Scope[];             // [0] = top-level frame scope
  save: { topLevelBody: boolean; topStmtIdx: number }[];
  /** jitRuntime object for UDF bodies — bound at udfJitState creation; the
   *  top-level path leaves it undefined and holds the object externally. */
  udfR?: unknown;
}

function jitRuntime(state: JitState, run: RunState, ctx: BuiltinCtx) {
  const rt = ctx as RtCtx;
  const R = {
    NA, TRUE: VTRUE, FALSE: VFALSE, VOID: { kind: 'void' } as Value,
    BREAK, CONTINUE,
    Return: ReturnSignal,
    num: (v: number, isInt: boolean): Value => numVal(v, isInt),
    str: (v: string): Value => ({ kind: 'string', v }),
    color: (v: string): Value => ({ kind: 'color', v }),
    arr: (items: Value[]): Value => ({ kind: 'array', v: items }),
    unary: (op: string, a: Value): Value => evalUnary(op, unseries(a)),
    binary: (op: string, l: Value, r: Value): Value => evalBinary(op, unseries(l), unseries(r), run, ctx),
    and: (l: () => Value, r: () => Value): Value =>
      unseriesTruth(l()) && unseriesTruth(r()) ? VTRUE : VFALSE,
    or: (l: () => Value, r: () => Value): Value =>
      unseriesTruth(l()) || unseriesTruth(r()) ? VTRUE : VFALSE,
    truth: (v: Value): boolean => unseriesTruth(v),
    ident: (name: string): Value => evalIdent(name, state.cur),
    hist: (name: string, idxV: Value): Value => {
      // evalHistref's ident arm — scalar idx → BarSeries.get via histGetAt.
      const u = unseries(idxV);
      const idx = isNum(u) && Number.isFinite(u.v) ? Math.floor(u.v) : undefined;
      if (idx === undefined || idx < 0) return NA;
      const scope = state.cur.scope;
      const bar = ctx.barIndex;
      let s = seriesOf(scope, name) ?? ctxSeries(ctx, name);
      if (!s && name === 'bar_index') s = barIndexSeries(run, ctx);
      if (!s) {
        const v = evalIdent(name, state.cur);
        if (v.kind === 'series') return histGetAt(v.v, idx, bar);
        return idx === 0 ? v : NA;
      }
      return histGetAt(s, idx, bar);
    },
    // `ns.prop` where ns may be unbound — evalMember's first branch verbatim.
    memberIdent: (name: string, prop: string): Value => {
      const scope = state.cur.scope;
      if (scope.lookup(name) === undefined) {
        const key = `${name}.${prop}`;
        const c = getConstant(key, ctx);
        if (c !== undefined) return c;
        const b = BUILTINS.get(key);
        if (b) return { kind: 'function', v: b };
        if (name === 'syminfo') {
          const f = ctx.syminfo[prop];
          if (f !== undefined) return f;
        }
        if (name === 'timeframe') {
          const f = timeframeFields(ctx).get(prop);
          if (f !== undefined) return f;
        }
        if (name === 'barstate') {
          const f = barstateUdt(ctx).fields.get(prop);
          if (f !== undefined) return f;
        }
        warn(run, ctx, `unknown constant '${key}'`);
        return NA;
      }
      return R.member(evalIdent(name, state.cur), prop);
    },
    member: (objV: Value, prop: string): Value => {
      const obj = unseries(objV);
      if (obj.kind === 'udt') {
        try { return getField(obj, prop); }
        catch { warn(run, ctx, `type '${obj.v.typeName}' has no field '${prop}'`); return NA; }
      }
      if (obj.kind === 'map') return obj.v.get(prop) ?? NA;
      warn(run, ctx, `cannot access '${prop}' on ${obj.kind}`);
      return NA;
    },
    // ── call dispatch — evalCallDispatch verbatim; args materialize per-target
    // kind so litFastPath/series semantics match evalArg exactly.
    // `evalCall` bookkeeping verbatim — rt.callsite/siteStack so plotIndex
    // resolves a stable sink id under JIT.
    call: (idx: number, ds: JitArg[]): Value => {
      const node = state.nodes[idx] as Call;
      const site = callsiteId(run, node);
      const prevSite = rt.callsite;
      rt.callsite = site;
      pushSite(run, site);
      try {
        return jitCallDispatch(state, run, ctx, node, ds);
      } finally {
        run.siteStack.pop();
        run.siteCtx.pop();
        rt.callsite = prevSite;
      }
    },
    decl: (idx: number, name: string, init: () => Value): Value => {
      const v = init();
      bindDeclared(run, siteKey(run, state.nodes[idx]!), state.cur.scope, name, v, ctx.barIndex);
      return v.kind === 'series' ? v.v.cur() : v;
    },
    declNa: (idx: number, name: string): Value => {
      slotFor(run, siteKey(run, state.nodes[idx]!), state.cur.scope, name).setAt(ctx.barIndex, NA);
      return NA;
    },
    // var single-name: same twoPhase logic as compileStmt's var arm.
    varDecl: (idx: number, name: string, init: () => Value): Value => {
      const node = state.nodes[idx]!;
      const key = siteKey(run, node);
      if (!run.declSlots.has(key)) {
        const v = init();
        bindDeclared(run, key, state.cur.scope, name, v, ctx.barIndex, /*persistent*/ true);
        return v.kind === 'series' ? v.v.cur() : v;
      }
      const s = run.declCows.get(key) ?? run.declSlots.get(key)!;
      state.cur.scope.define(name, s);
      return valueAt(s, ctx.barIndex);
    },
    // `:=` on an ident — evalReassign's ident arm verbatim.
    set: (idx: number, name: string, init: () => Value): Value => {
      const scope = state.cur.scope;
      const slot = scope.lookup(name);
      if (slot === undefined) throw pineErr(state.nodes[idx]!, `cannot reassign undeclared variable '${name}'`);
      if (slot === ctx.open || slot === ctx.high || slot === ctx.low ||
          slot === ctx.close || slot === ctx.volume || slot === ctx.time ||
          slot === ctx.hl2 || slot === ctx.hlc3 || slot === ctx.ohlc4 ||
          slot === ctx.hlcc4) {
        throw pineErr(state.nodes[idx]!, `cannot reassign built-in variable '${name}'`);
      }
      const v = unseries(init());
      if (slot instanceof BarSeries) slot.setAt(ctx.barIndex, v);
      else throw pineErr(state.nodes[idx]!, `'${name}' is not a mutable variable`);
      return v;
    },
    pushScope: (): void => {
      state.save.push({ topLevelBody: run.topLevelBody, topStmtIdx: run.topStmtIdx });
      run.topLevelBody = false; run.topStmtIdx = -1;
      rt.scopeDepth = (rt.scopeDepth ?? 0) + 1;
      state.scopeStack.push(new Scope(state.scopeStack[state.scopeStack.length - 1]!));
      state.cur = { scope: state.scopeStack[state.scopeStack.length - 1]!, ctx };
    },
    popScope: (): void => {
      rt.scopeDepth!--;
      const s = state.save.pop()!;
      run.topLevelBody = s.topLevelBody; run.topStmtIdx = s.topStmtIdx;
      state.scopeStack.pop();
      state.cur = { scope: state.scopeStack[state.scopeStack.length - 1]!, ctx };
    },
    evalStmt: (idx: number): Value => evalExpr(state.nodes[idx]!, state.cur),
    // Control-flow signals pass through; everything else becomes a PineRuntimeError
    // wrapped with the stmt's node — identical to evalExpr's contract.
    stmtErr: (e: unknown, idx: number): never => {
      if (e === BREAK || e === CONTINUE || e instanceof ReturnSignal) throw e;
      throw wrapPineError(e, state.nodes[idx]);
    },
  };
  return R;
}

/** evalCallDispatch verbatim for the JIT — one dispatch branch per shape
 * (X.new / ns.fn / obj.method / bare) with jitMatArg picking the arg flavor. */
function jitCallDispatch(state: JitState, run: RunState, ctx: BuiltinCtx,
                       node: Call, ds: JitArg[]): Value {
  const scope = state.cur.scope;
  const frame = state.cur;
  if (mtf) {
    const sec = mtf.tryEvalSecurity(node, frame);
    if (sec !== null) return sec;
  }
  const callee = node.callee;
  if (callee.type === 'member' && !callee.computed && callee.prop === 'new'
      && callee.obj.type === 'ident' && isUdtType(callee.obj.name)) {
    const args: Value[] = [];
    const named: Record<string, Value> = {};
    for (const d of ds) {
      const v = jitMatArgExpr(state, d);
      if (d.n !== undefined) named[d.n] = v; else args.push(v);
    }
    return { kind: 'udt', v: newUdt(callee.obj.name, args, named, d => evalExpr(d, frame)) };
  }
  if (callee.type === 'member' && !callee.computed) {
    let hit = RESOLVED_BUILTIN.get(node);
    if (hit === undefined) {
      const parts: string[] = [callee.prop];
      let head: Node = callee.obj;
      while (head.type === 'member' && !head.computed) { parts.unshift(head.prop); head = head.obj; }
      if (head.type === 'ident') {
        parts.unshift(head.name);
        hit = { headName: head.name, fn: BUILTINS.get(parts.join('.')) };
      } else hit = { headName: '', fn: undefined };
      RESOLVED_BUILTIN.set(node, hit);
    }
    if (hit.fn !== undefined && scope.lookup(hit.headName) === undefined) {
      const args: Value[] = [];
      const named: Record<string, Value> = {};
      const spec = HIST_BUILTINS.get(hit.fn);
      for (const d of ds) {
        const v = jitMatArg(state, run, ctx, d, true,
          !histSpecHas(spec, d.n === undefined ? args.length : -1, d.n));
        if (d.n !== undefined) named[d.n] = v; else args.push(v);
      }
      return callBuiltin(hit.fn, ctx, args, named, node);
    }
    const obj = evalExpr(callee.obj, frame);
    const prop = callee.prop;
    if (obj.kind === 'udt') {
      const def = udtMethodAt(run, node, obj.v.typeName, prop);
      if (def) {
        const bound = bindArgsJit(state, run, ctx, node.args, ds, def.params.slice(1), paramFlags(def.params, def.body));
        return callUdtMethod(obj.v, prop, bound, ctx);
      }
    } else {
      const b = kindBuiltin(obj.kind, prop);
      if (b) {
        const args: Value[] = [obj];
        const named: Record<string, Value> = {};
        const spec = HIST_BUILTINS.get(b);
        for (const d of ds) {
          // args.length already counts the receiver at [0] — callsite
          // positional j binds order index j+1 = args.length.
          const v = jitMatArg(state, run, ctx, d, true,
            !histSpecHas(spec, d.n === undefined ? args.length : -1, d.n));
          if (d.n !== undefined) named[d.n] = v; else args.push(v);
        }
        return callBuiltin(b, ctx, args, named, node);
      }
      const prim = udtMethodAt(run, node, obj.kind, prop);
      if (prim) {
        const bound = bindArgsJit(state, run, ctx, node.args, ds, prim.params.slice(1), paramFlags(prim.params, prim.body));
        return callUdtMethod(obj, prop, bound, ctx);
      }
    }
    if (obj.kind === 'na') return NA;
    warn(run, ctx, `no method '${prop}' on ${obj.kind}`);
    return NA;
  }
  if (callee.type === 'na') {
    const b = BUILTINS.get('na');
    if (b) return jitBuiltinArgsInvoke(state, run, ctx, b, ds, node);
  }
  let fn: Value;
  if (callee.type === 'ident') {
    const bound = scope.lookup(callee.name);
    const callable = bound !== undefined &&
      ((bound as Value).kind === 'function' ||
       ((bound as Series).cur?.()?.kind === 'function'));
    if (!callable) {
      const b = BUILTINS.get(callee.name);
      if (b) return jitBuiltinArgsInvoke(state, run, ctx, b, ds, node);
    }
    fn = evalIdent(callee.name, frame);
  } else {
    fn = evalExpr(callee, frame);
  }
  if (fn.kind === 'function') {
    if (typeof fn.v === 'function') return jitBuiltinArgsInvoke(state, run, ctx, fn.v as BuiltinFn, ds, node);
    return callUdfValue(fn.v as UdfDecl, bindArgsJit(state, run, ctx, node.args, ds, fn.v.params, paramFlags(fn.v.params, fn.v.body)), frame, node);
  }
  warn(run, ctx, `call target is not a function (${fn.kind})`);
  return NA;
}

/** evalArg tail — wrap a plain-evaluated arg in its callsite BarSeries
 * (callHist), mirroring evalArg's post-evalExpr path. */
function jitArgFinish(state: JitState, run: RunState, ctx: BuiltinCtx, idx: number, v: Value, noHist = false): Value {
  if (v.kind === 'series') return v;
  if (v.kind !== 'int' && v.kind !== 'float' && v.kind !== 'bool') return v;
  if (noHist) return v;
  const key = siteKey(run, state.nodes[idx]!);
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

/** Descriptor → Value. `litFastPath` applies LitSeries to 'l' args only —
 * every other shape evaluates then goes through jitArgFinish, exactly like
 * evalArg. `f` thunk missing (non-emit expr) falls back to evalExpr. */
function jitMatArg(state: JitState, run: RunState, ctx: BuiltinCtx, d: JitArg, litFastPath: boolean, noHist = false): Value {
  if (d.k === 'i') {
    const s = seriesOf(state.cur.scope, d.i!) ?? ctxSeries(ctx, d.i!);
    if (s) return { kind: 'series', v: s };
    return jitArgFinish(state, run, ctx, d.x,
      d.f ? d.f() : evalExpr(state.nodes[d.x]!, state.cur), noHist);
  }
  if (d.k === 'l' && litFastPath) {
    const key = siteKey(run, state.nodes[d.x]!);
    let ls = run.callHist.get(key as Node) as LitSeries | undefined;
    if (!ls) {
      ls = new LitSeries(evalExpr(state.nodes[d.x]!, state.cur), ctx.barIndex);
      run.callHist.set(key as Node, ls);
      trackSeries(run, ls);
    } else {
      ls.bump(ctx.barIndex);
    }
    return { kind: 'series', v: ls };
  }
  return jitArgFinish(state, run, ctx, d.x,
    d.f ? d.f() : evalExpr(state.nodes[d.x]!, state.cur), noHist);
}

/** `X.new` arg flavor — raw evalExpr on the arg's value node (evalCallDispatch
 * does not run evalArg on construction args). */
function jitMatArgExpr(state: JitState, d: JitArg): Value {
  return d.f ? d.f() : evalExpr(state.nodes[d.x]!, state.cur);
}

/** bindCallArgs on descriptor args — named first, positionals fill gaps, then
 * defaults. Uses jitMatArg(false) — UDF params never take the LitSeries path. */
function bindArgsJit(state: JitState, run: RunState, ctx: BuiltinCtx,
                     callArgs: Arg[], ds: JitArg[], params: Param[],
                     flags?: Map<string, ParamFlag>): Value[] {
  const out: Value[] = new Array<Value>(params.length);
  const noHist = (p: Param) => flags !== undefined && flags.get(p.name)?.hist === false;
  // All-positional fast path: skip Set + positionals staging entirely.
  if (!callArgs.some(a => a.name !== undefined)) {
    const n = Math.min(callArgs.length, params.length);
    for (let i = 0; i < n; i++) out[i] = jitMatArg(state, run, ctx, ds[i]!, false, noHist(params[i]!));
    for (let i = n; i < params.length; i++) {
      const dfl = params[i]!.default;
      out[i] = dfl !== undefined ? evalExpr(dfl, state.cur) : NA;
    }
    return out;
  }
  const filled = new Set<number>();
  const positionals: { a: Arg; d: JitArg }[] = [];
  callArgs.forEach((a, i) => {
    const d = ds[i]!;
    if (a.name !== undefined) {
      const p = params.findIndex(pp => pp.name === a.name);
      if (p >= 0 && !filled.has(p)) { out[p] = jitMatArg(state, run, ctx, d, false, noHist(params[p]!)); filled.add(p); return; }
    }
    positionals.push({ a, d });
  });
  let p = 0;
  for (const { d } of positionals) {
    while (p < params.length && filled.has(p)) p++;
    if (p >= params.length) break;
    out[p] = jitMatArg(state, run, ctx, d, false, noHist(params[p]!));
    filled.add(p); p++;
  }
  for (let i = 0; i < params.length; i++) {
    if (!filled.has(i)) {
      const dfl = params[i]!.default;
      out[i] = dfl !== undefined ? evalExpr(dfl, state.cur) : NA;
    }
  }
  return out;
}

function jitBuiltinArgsInvoke(state: JitState, run: RunState, ctx: BuiltinCtx,
                              b: BuiltinFn, ds: JitArg[], node: Call): Value {
  const args: Value[] = [];
  const named: Record<string, Value> = {};
  const spec = HIST_BUILTINS.get(b);
  for (const d of ds) {
    const v = jitMatArg(state, run, ctx, d, true,
      !histSpecHas(spec, d.n === undefined ? args.length : -1, d.n));
    if (d.n !== undefined) named[d.n] = v; else args.push(v);
  }
  return callBuiltin(b, ctx, args, named, node);
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
  /** Content-derived incremental-session key — the caller (worker or engine
   *  holder) persists the IncLive under it; identical key + extended tape
   *  resumes at the committed checkpoint instead of a full re-run. */
  incKey?: string;
  /** Previously returned live session for this key — in-process callers
   *  carry it; the worker keys its own map. */
  incSession?: IncLive | null;
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

/** A resumable script execution — everything a live tick session must keep
 *  alive between runs: ctx, top scope, run state, compiled bodies, and the
 *  series registry used by the incremental driver for rollback. */
interface PineSess {
  decl: IndicatorDecl | StrategyDecl | null;
  body: Node[];
  barCtx: BarCtx;
  ctx: RtCtx;
  drawSink: MemoryDrawSink;
  run: RunState;
  scope: Scope;
  frame0: Frame;
  compiledBody: CompiledStmt[] | null;
  jit: JitState | null;
  jitR: JitRt | null;
  /** Per-plot-sink assembled-array cache — append-only across incremental
   *  ticks (see PlotEmitCache). Undefined for one-shot sessions. */
  emitCache?: Map<PlotSink, PlotEmitCache>;
  /** Every BarSeries born while this session evaluates — the incremental
   *  driver snapshots and rewinds them. */
  seriesSet: Set<BarSeries>;
  /** This session's MTF store (request.* scripts) — re-activated per run so
   *  sibling runs can't wipe its spec state. */
  mtf?: unknown;
}

/** jitRuntime's public surface — named once so PineSess doesn't re-derive it. */
type JitRt = ReturnType<typeof jitRuntime>;

const emptyResult = (body: Node[], decl: IndicatorDecl | StrategyDecl | null): RunResult => ({
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

/** Build a session: ctx/scope/dispatch tables + MTF prefetch. Shared by
 *  runScriptInner (one-shot) and the incremental driver (resume). */
async function buildSess(
  parsed: ParsedInput,
  bars: BarData[],
  opts: RunOptions,
  /** Incremental sessions pass a set so every BarSeries born inside (ctx
   *  series + evaluation-time) registers for rollback. Null = one-shot. */
  seriesSet: Set<BarSeries> | null = null,
): Promise<PineSess | null> {
  const decl = Array.isArray(parsed) ? null : (parsed.decl ?? null);
  const body = Array.isArray(parsed) ? parsed : parsed.body;
  // Register ctx-series births (BarCtx ctor) into the incremental set too —
  // rewind rewrites them wholesale, but membership keeps parity checks cheap.
  if (seriesSet) setActiveSeriesSet(seriesSet);

  // UDT registries are module globals — clear types/methods/scope from any
  // previous run before this script's decls re-register.
  UDT_REGISTRY.reset();

  if (bars.length === 0) return null;

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
  // indicator(...) decl is likewise stripped from `body`, so its draw quotas
  // (max_lines_count / max_labels_count / max_boxes_count) must be read here —
  // otherwise every drawing kind falls back to DEFAULT_QUOTA=50 and scripts
  // declaring 500 lose most of their lines/labels/boxes (見高K zigzag case).
  else if (decl?.type === 'indicator') {
    declDrawQuotas(ctx, decl.args, INDICATOR_DECL_ORDER);
    warnUnsupportedIndicatorParams(ctx, decl.args);
  }

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
  // Stash the store on the session — incremental resumes re-activate it
  // before each tick so sibling runs can't wipe spec state.
  const mtfStore = mtf?.sessionStore?.();

  // ── bar-loop dispatch tables ──
  // Static early-exit scan: the first top-level stmt that may skip the rest
  // of the body (bare or if/switch-arm break/continue/return) caps pruning —
  // decls at or after it aren't provably written every bar, so their slots
  // must stay in ensureList or `x[1]` misaligns on skipped bars.
  run.pruneCutoff = Infinity; // default: no early exit in body (matches runOf init)
  for (let i = 0; i < body.length; i++) {
    if (stmtMayExitTop(body[i]!, false, false)) { run.pruneCutoff = i; break; }
  }
  // Slice-D: compile the top-level body once per run. Fallback stmts keep
  // evalExpr; topStmtIdx bookkeeping is identical either way.
  const compiledBody: CompiledStmt[] | null =
    compiledEnabled() ? body.map(compile) : null;

  // Slice-E: JIT path — transpile body to JS once; each bar invokes the same
  // compiled fn. Falls back to the compiled/interpreted path on any setup
  // failure (transpile throw, new Function CSP, malformed node table).
  let jit: JitState | null = null;
  let jitR: JitRt | null = null;
  if (jitEnabled()) {
    try {
      const t = nowMs();
      const { src, nodeTable, native, fallback } = jitCompile(body);
      __pineJitStats.compileMs += nowMs() - t;
      __pineJitStats.native += native;
      __pineJitStats.fallback += fallback;
      // `new Function` keeps the body a real function (CSP: same rules as
      // eval — workers/pages need unsafe-eval either way; vitest + vite dev
      // both allow it).
      const fn = new Function('R', 'run', 'nodes', `"use strict";\n${src}`) as JitState['fn'];
      jit = { fn, nodes: nodeTable, cur: frame0, scopeStack: [scope], save: [] };
      jitR = jitRuntime(jit, run, ctx);
      __pineJitStats.runs++;
    } catch (e) {
      console.warn('[pine-jit] setup failed, using interpreter:', e instanceof Error ? e.message : e);
      jit = null;
      jitR = null;
    }
  }
  return { decl, body, barCtx, ctx, drawSink, run, scope, frame0, compiledBody, jit, jitR, seriesSet: seriesSet ?? new Set(), mtf: mtfStore };
}

/** Evaluate one bar. 'ok' = continue; 'ret' = top-level return, stop the
 *  script; other = wrapped runtime error. */
function evalOneBar(s: PineSess, bar: number): 'ok' | 'ret' | PineRuntimeError {
  const { run, ctx } = s;
  if (ctx.barIndex !== bar) s.barCtx.seek(bar);
  try {
    // Decl slots created while topLevelBody is set are written every bar —
    // their ensureBar is a no-op, so slotFor keeps them out of ensureList
    // (topStmtIdx < pruneCutoff only; see the scan in buildSess).
    run.topLevelBody = true;
    try {
      if (s.jit && s.jitR) {
        s.jit.fn(s.jitR, run, s.jit.nodes);
      } else if (s.compiledBody) {
        for (let i = 0; i < s.body.length; i++) {
          run.topStmtIdx = i;
          const c = s.compiledBody[i]!;
          if (c.kind === 'fallback') evalExpr(c.node, s.frame0);
          else if (c.kind === 'twoPhase')
            (c.isFresh(run) ? c.fresh : c.later)(s.frame0, run);
          else c.fn(s.frame0, run);
        }
      } else {
        for (let i = 0; i < s.body.length; i++) {
          run.topStmtIdx = i;
          evalExpr(s.body[i]!, s.frame0);
        }
      }
    } finally {
      run.topStmtIdx = -1;
      run.topLevelBody = false;
    }
  } catch (e) {
    if (e === BREAK || e === CONTINUE) {
      warn(run, ctx, 'break/continue outside loop');
    } else if (e instanceof ReturnSignal) {
      return 'ret'; // top-level return stops the script
    } else {
      return wrapPineError(e, undefined);
    }
  }
  // Densify every slot to `bar` (carry-forward for skipped statements).
  for (let i = 0; i < run.ensureList.length; i++) run.ensureList[i]!.ensureBar(bar);
  return 'ok';
}

/** Per-sink emit cache entry — the assembled arrays append only; a rollback
 *  (buf shorter than emitted) truncates in place, and a live-forming-bar
 *  tail entry is always rewritten. Arrays are shared across emissions by
 *  design: consumers (model builder / sanitize) copy, and incremental
 *  sessions save the O(bars) per-tick rebuild. */
interface PlotEmitCache {
  emitted: number;
  time: number[];
  values: Value[];
  colors: (string | undefined)[];
}

/** Assemble RunResult from the session's accumulated state. */
function assembleRunResult(s: PineSess): RunResult {
  const { ctx, drawSink, body, decl, barCtx } = s;
  const bars = barCtx.bars;
  const plots: RunResult['plots'] = new Map();
  // Extrapolate off-range times by average bar duration, never bare indexes.
  const barDur = bars.length > 1
    ? (bars[bars.length - 1]!.openTime - bars[0]!.openTime) / (bars.length - 1)
    : 60_000;
  const lastTime = bars[bars.length - 1]!.openTime;
  const timeAt = (bi: number): number =>
    bars[bi]?.openTime ?? lastTime + (bi - bars.length + 1) * barDur;
  const emitCache = s.emitCache;
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
    const opts = buf[buf.length - 1]!.opts;
    let cache = emitCache?.get(sink);
    if (cache) {
      // Forming-bar rollback shrinks buf — truncate emitted arrays to match,
      // then the append loop re-pushes the tail (incl. any changed entries).
      if (cache.emitted > buf.length) {
        cache.time.length = cache.values.length = cache.colors.length = buf.length;
        cache.emitted = buf.length;
      } else if (cache.emitted > 0) {
        // The tail entry may have been re-pushed with newer tick data —
        // pop it and let the append loop re-emit.
        cache.time.pop(); cache.values.pop(); cache.colors.pop();
        cache.emitted--;
      }
      for (let i = cache.emitted; i < buf.length; i++) {
        const p = buf[i]!;
        cache.time.push(timeAt((p.barIndex ?? i) + offset));
        cache.values.push(p.value);
        cache.colors.push(p.opts.color);
      }
      cache.emitted = buf.length;
      plots.set(key, { index: idx, time: cache.time, values: cache.values, opts, colors: cache.colors });
      return;
    }
    // Entry barIndex is recorded at push time — sparse sinks (plot inside
    // if/for) map each value to its own bar, not buf position.
    const entry = {
      index: idx,
      time: buf.map((p, i) => timeAt((p.barIndex ?? i) + offset)),
      values: buf.map(p => p.value),
      opts,
      colors: buf.map(p => p.opts.color),
    };
    plots.set(key, entry);
    if (emitCache) {
      emitCache.set(sink, { emitted: buf.length, time: entry.time, values: entry.values, colors: entry.colors });
    }
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

async function runScriptInner(
  parsed: ParsedInput,
  bars: BarData[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const decl = Array.isArray(parsed) ? null : (parsed.decl ?? null);
  const body = Array.isArray(parsed) ? parsed : parsed.body;
  const empty = (): RunResult => emptyResult(body, decl);
  if (bars.length === 0) return empty();

  const s = await buildSess(parsed, bars, opts);
  if (!s) return empty();
  // A stopped run pays full prefetch otherwise — check before the bar loop.
  if (opts.shouldAbort?.()) return empty();

  let barErr: PineRuntimeError | null = null;
  let sliceStart = nowMs();
  for (let bar = 0; bar < bars.length; bar++) {
    const r = evalOneBar(s, bar);
    if (r === 'ret') break;
    if (r !== 'ok') { barErr = r; break; }
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

  return assembleRunResult(s);
}

// ── incremental execution (live-tick resume) ─────────────────────────────────
// TV-equivalent semantics: closed bars commit once; the forming bar is
// re-evaluated per tick after rolling back to the committed checkpoint. See
// docs/superpowers/plans/2026-10-11-pine-incremental-live.md.
//
// Eligibility: indicator decls without request.* — MTF specs own bar-aligned
// eval state that the rollback model doesn't cover yet, and strategy order
// execution is event-driven, not per-bar deterministic.

/** Checkpoint payload — one snapshot per committed bar boundary. */
interface IncCkpt {
  /** Last committed bar. */
  bar: number;
  scopeVars: Map<string, Series | Value>;
  seriesSnaps: Map<BarSeries, IncSnap>;
  /** series → buf-index → cloned container Value (hasContainers only). */
  containers: Map<BarSeries, Map<number, Value>>;
  declSlots: Map<object, BarSeries>;
  declCows: Map<object, CowSeries>;
  declAliased: Set<object>;
  trackedSlots: Set<BarSeries>;
  ensureLen: number;
  callHist: Map<Node, BarSeries>;
  misc: Map<string, BarSeries>;
  tupleKeys: Map<Node, Map<string, object>>;
  paramCows: Map<object, Map<string, CowSeries>>;
  /** ctx.state leaf entries needing rollback:
   *   vs — VS objects (last + memo > bar pruned, snap/restore if present)
   *   nummaps — Map<number,*> leaves (entries > bar deleted)
   *   plains — plain objects (fields overwritten by stored clone)
   *   maps — structural maps (membership restored to stored key list) */
  stateVs: { e: { last: number; memo?: Map<number, number | undefined>; snap?(): unknown; restore?(s: unknown): void }; snap: unknown; last: number }[];
  stateNumMaps: Map<number, unknown>[];
  statePlains: { obj: Record<string, unknown>; fields: Record<string, unknown> }[];
  stateMaps: { map: Map<unknown, unknown>; keys: unknown[] }[];
  drawSnap: DrawSnap;
  drawProps: Map<DrawObj, Record<string, unknown>>;
  sinkLen: number;
  sbufLens: number[];
  alertstate: Map<string, number>;
  fills: unknown[];
  fillSites: Map<string, number>;
  bgcolors: Map<number, Map<string, string>>;
  barcolors: Map<number, Map<string, string>>;
  liveArrays: unknown[][];
  /** CowSeries → materialized inner state: null = still aliasing; else the
   *  owned BarSeries + its snap. */
  cowSnaps: Map<CowSeries, { cow: BarSeries; snap: IncSnap } | null>;
  /** MTF store checkpoint — opaque to the interpreter; mtf.ts owns the
   *  shape. Present only when the session's script uses request.*. */
  mtfSnap?: unknown;
  /** Accumulator lengths — the forming bar re-appends; restore truncates. */
  alertsLen: number;
  warningsLen: number;
  alertcondLen: number;
  inSchemaLen: number;
  /** Counters/sets the forming bar may mutate. */
  plotSeq: number;
  declQuotas: RtCtx['declQuotas'];
  warnKeys: RtCtx['warnKeys'];
}

/** Live incremental session. `committed` = last bar whose state is trusted;
 *  bars after it are tentatively evaluated and rolled back per tick. */
export interface IncLive {
  s: PineSess;
  ckpt: IncCkpt;
  committed: number;
  /** Session key — advance only reuses the session when the caller's key
   *  still matches (inputs/syminfo changes land on a different key). */
  key?: string;
  /** Set by evalOneBar 'ret' or error — session can't produce another
   *  trustworthy model; the next run falls back to a fresh full eval. */
  dead: boolean;
}

/** Opaque ctx.state snapshot — shared by the chart ctx and mtf.tf child
 *  ctxs (mtf.ts consumes via registerMtf's bindSnap). */
export interface CtxStateSnap {
  vs: { e: { last: number; memo?: Map<number, number | undefined>; snap?(): unknown; restore?(s: unknown): void }; snap: unknown; last: number }[];
  nummaps: Map<number, unknown>[];
  plains: { obj: Record<string, unknown>; fields: Record<string, unknown> }[];
  maps: { map: Map<unknown, unknown>; keys: unknown[] }[];
}

/** Snapshot a BuiltinCtx.state tree: classify leaves so bar-indexed memos
 *  prune, structural maps keep membership, VS objects snap/restore. `ids`
 *  shared with the caller's cloneDeep pass preserves cross-references. */
export function snapCtxState(state: Map<unknown, unknown> | undefined, ids: Map<unknown, unknown>): CtxStateSnap {
  const out: CtxStateSnap = { vs: [], nummaps: [], plains: [], maps: [] };
  const walk = (m: Map<unknown, unknown>) => {
    for (const v of m.values()) {
      if (v instanceof Map) {
        // Bar-memo leaves (number → scalar/undefined) get key-pruned on
        // restore; STRUCTURAL maps — kparts layers like ['stv','sma',site,3]
        // whose number keys index call args, not bars — must keep their
        // entries so the VS objects inside stay reachable.
        let isBarMemo = true;
        for (const [k, val] of v) {
          if (typeof k !== 'number' || (val !== undefined && val !== null && typeof val === 'object')) {
            isBarMemo = false;
            break;
          }
        }
        if (isBarMemo && v.size > 0) {
          out.nummaps.push(v as Map<number, unknown>);
        } else {
          out.maps.push({ map: v, keys: [...v.keys()] });
          walk(v);
        }
        continue;
      }
      if (v !== null && typeof v === 'object') {
        if (typeof (v as { get?: unknown }).get === 'function' && 'last' in (v as object)) {
          const e = v as CtxStateSnap['vs'][number]['e'];
          out.vs.push({ e, snap: e.snap?.(), last: e.last });
          continue;
        }
        const proto = Object.getPrototypeOf(v);
        if (proto === Object.prototype || proto === null) {
          out.plains.push({ obj: v as Record<string, unknown>, fields: cloneDeep(v, ids) as Record<string, unknown> });
        }
        // class instances (VS handled above): pass through untouched —
        // rollback imprecision, flagged by the caller if it matters.
      }
    }
  };
  if (state) walk(state);
  return out;
}

/** Restore a ctx.state snapshot against `bar` (the committed index). */
export function restoreCtxState(ck: CtxStateSnap, bar: number, ids: Map<unknown, unknown>): void {
  for (const e of ck.vs) {
    e.e.last = e.last;
    if (e.e.memo) for (const k of [...e.e.memo.keys()]) if (k > bar) e.e.memo.delete(k);
    if (e.snap !== undefined && e.e.restore) e.e.restore(e.snap);
  }
  for (const m of ck.nummaps) for (const k of [...m.keys()]) if (k > bar) m.delete(k);
  for (const p of ck.plains) {
    for (const k of Object.keys(p.obj)) delete p.obj[k];
    Object.assign(p.obj, cloneDeep(p.fields, ids));
  }
  for (const sm of ck.maps) {
    const want = new Set(sm.keys);
    for (const k of [...sm.map.keys()]) if (!want.has(k)) sm.map.delete(k);
  }
}

/** Identity-preserving deep clone for checkpoint state. Containers (arrays,
 *  maps, plain objects, udt fields, Value wrappers) are cloned; references
 *  (Series, functions, DrawObj handles) pass through — they rewind via their
 *  own channels (seriesSnaps, drawProps). */
function cloneDeep<T>(v: T, ids: Map<unknown, unknown>): T {
  if (v === null || typeof v !== 'object') return v;
  const hit = ids.get(v);
  if (hit !== undefined) return hit as T;
  if (Array.isArray(v)) {
    const out: unknown[] = new Array(v.length);
    ids.set(v, out);
    for (let i = 0; i < v.length; i++) out[i] = cloneDeep(v[i], ids);
    return out as T;
  }
  if (v instanceof Map) {
    const out = new Map<unknown, unknown>();
    ids.set(v, out);
    for (const [k, val] of v) out.set(k, cloneDeep(val, ids));
    return out as T;
  }
  if (v instanceof Set) {
    const out = new Set<unknown>();
    ids.set(v, out);
    for (const x of v) out.add(cloneDeep(x, ids));
    return out as T;
  }
  if (v instanceof Series || v instanceof Function) return v;
  const o = v as Record<string, unknown>;
  // DrawObj handles keep identity — the sink's props snapshot restores them.
  if ('id' in o && 'kind' in o && 'props' in o) return v;
  // Value wrappers: clone payload fields by kind.
  if (typeof o.kind === 'string') {
    const kind = o.kind;
    if (kind === 'array') { const c = { kind: 'array', v: cloneDeep(o.v, ids) }; ids.set(v, c); return c as T; }
    if (kind === 'map') { const c = { kind: 'map', v: cloneDeep(o.v, ids) }; ids.set(v, c); return c as T; }
    if (kind === 'matrix') { const c = { kind: 'matrix', v: cloneDeep(o.v, ids) }; ids.set(v, c); return c as T; }
    if (kind === 'udt') {
      const src = o.v as { typeName: string; fields: Map<string, Value> };
      const c = { kind: 'udt', v: { typeName: src.typeName, fields: cloneDeep(src.fields, ids) } };
      ids.set(v, c);
      return c as T;
    }
    return v; // scalar / series / function / drawing Value — immutable or ref
  }
  const proto = Object.getPrototypeOf(v);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    ids.set(v, out);
    for (const k of Object.keys(o)) out[k] = cloneDeep(o[k], ids);
    return out as T;
  }
  // Class instance not recognized — pass through (rollback imprecision, see
  // statePlains note). VS handled by the state walk before reaching here.
  return v;
}

function checkpoint(s: PineSess, bar: number): IncCkpt {
  const { run, ctx } = s;
  const ids = new Map<unknown, unknown>();
  const seriesSnaps = new Map<BarSeries, IncSnap>();
  const containers = new Map<BarSeries, Map<number, Value>>();
  for (const se of s.seriesSet) {
    seriesSnaps.set(se, se.incSnap());
    if (se.hasContainers) {
      const m = new Map<number, Value>();
      const buf = se.incBuf;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        if (!v || typeof v !== 'object') continue;
        const k = v.kind;
        if (k === 'array' || k === 'map' || k === 'matrix' || k === 'udt') {
          m.set(se.incBarAt(i), cloneDeep(v, ids));
        }
      }
      if (m.size > 0) containers.set(se, m);
    }
  }
  const scopeVars = new Map<string, Series | Value>();
  for (const [n, v] of s.scope.varsCopy()) scopeVars.set(n, cloneDeep(v, ids));
  // ctx.state leaf classification — see IncCkpt doc.
  const { vs: stateVs, nummaps: stateNumMaps, plains: statePlains, maps: stateMaps } =
    snapCtxState(ctx.state, ids);
  const drawSnap = s.drawSink.incSnap();
  const drawProps = new Map<DrawObj, Record<string, unknown>>();
  for (const o of s.drawSink.objects) drawProps.set(o, cloneDeep(o.props, ids));
  const sbufLens: number[] = [];
  for (const sink of ctx.plots) {
    const b = (sink as { buf?: unknown[] }).buf;
    sbufLens.push(Array.isArray(b) ? b.length : -1);
  }
  const deep2 = (x: unknown) => cloneDeep(x, ids);
  return {
    bar,
    scopeVars,
    seriesSnaps,
    containers,
    declSlots: new Map(run.declSlots),
    declCows: new Map(run.declCows),
    declAliased: new Set(run.declAliased),
    trackedSlots: new Set(run.trackedSlots),
    ensureLen: run.ensureList.length,
    callHist: new Map(run.callHist),
    misc: new Map(run.misc),
    tupleKeys: new Map([...run.tupleKeys].map(([k, v]) => [k, new Map(v)])),
    paramCows: new Map([...run.paramCows].map(([k, v]) => [k, new Map(v)])),
    stateVs, stateNumMaps, statePlains, stateMaps,
    drawSnap, drawProps,
    sinkLen: ctx.plots.length,
    sbufLens,
    alertstate: new Map(ctx.alertstate),
    fills: (ctx.fills ?? []).map(f => deep2(f)),
    fillSites: new Map(ctx.fillSites),
    bgcolors: new Map([...(ctx.bgcolors ?? new Map())].map(([k, v]) => [k, new Map(v)])),
    barcolors: new Map([...(ctx.barcolors ?? new Map())].map(([k, v]) => [k, new Map(v)])),
    liveArrays: [ctx.liveLines, ctx.liveLabels, ctx.liveBoxes, ctx.liveTables, ctx.livePolylines, ctx.liveLinefills]
      .map(a => (a ?? []).slice()),
    cowSnaps: (() => {
      const m = new Map<CowSeries, { cow: BarSeries; snap: IncSnap } | null>();
      for (const c of run.declCows.values()) m.set(c, c.incCowGet());
      for (const byParam of run.paramCows.values())
        for (const c of byParam.values()) if (!m.has(c)) m.set(c, c.incCowGet());
      return m;
    })(),
    alertsLen: ctx.alerts.length,
    warningsLen: ctx.warnings.length,
    alertcondLen: (ctx.alertconditions ?? []).length,
    inSchemaLen: (ctx.inputSchemas ?? []).length,
    plotSeq: ctx.plotSeq ?? 0,
    declQuotas: ctx.declQuotas ? { ...ctx.declQuotas } : undefined,
    warnKeys: ctx.warnKeys ? new Set(ctx.warnKeys) : undefined,
    mtfSnap: mtf?.checkpoint?.(s),
  };
}

/** Restore one checkpoint — every mutable surface rolls back to committed. */
function restoreCkpt(s: PineSess, ck: IncCkpt): void {
  const { run, ctx } = s;
  const ids = new Map<unknown, unknown>();
  // Series: rewind to snap; series born during the forming bar → unseen (null).
  for (const se of s.seriesSet) se.incRewind(ck.seriesSnaps.get(se) ?? null);
  // Container slot payloads — the fresh clones re-share identity within this
  // restore pass (two names bound to the same array see the same clone).
  for (const [se, slots] of ck.containers) {
    for (const [bar, v] of slots) se.setAt(bar, cloneDeep(v, ids));
  }
  // Top scope: membership + fresh clones.
  const vars = new Map<string, Series | Value>();
  for (const [n, v] of ck.scopeVars) vars.set(n, cloneDeep(v, ids));
  s.scope.varsRestore(vars);
  // RunState map membership (+ reference values — refs are stable by design).
  const restoreMap = <K, V>(live: Map<K, V>, saved: Map<K, V>) => {
    for (const k of [...live.keys()]) if (!saved.has(k)) live.delete(k);
    for (const [k, v] of saved) live.set(k, v);
  };
  restoreMap(run.declSlots, ck.declSlots);
  restoreMap(run.declCows, ck.declCows);
  run.declAliased.clear();
  for (const x of ck.declAliased) run.declAliased.add(x);
  run.trackedSlots.clear();
  for (const x of ck.trackedSlots) run.trackedSlots.add(x);
  run.ensureList.length = ck.ensureLen;
  restoreMap(run.callHist, ck.callHist);
  restoreMap(run.misc, ck.misc);
  for (const k of [...run.tupleKeys.keys()]) if (!ck.tupleKeys.has(k)) run.tupleKeys.delete(k);
  for (const [k, saved] of ck.tupleKeys) {
    const live = run.tupleKeys.get(k) ?? new Map<string, object>();
    restoreMap(live, saved);
    run.tupleKeys.set(k, live);
  }
  for (const k of [...run.paramCows.keys()]) if (!ck.paramCows.has(k)) run.paramCows.delete(k);
  for (const [k, saved] of ck.paramCows) {
    const live = run.paramCows.get(k) ?? new Map<string, CowSeries>();
    restoreMap(live, saved);
    run.paramCows.set(k, live);
  }
  // ctx.state
  restoreCtxState({ vs: ck.stateVs, nummaps: ck.stateNumMaps, plains: ck.statePlains, maps: ck.stateMaps }, ck.bar, ids);
  // MTF per-spec tf state (request.* scripts only).
  if (ck.mtfSnap !== undefined) mtf?.restore?.(ck.mtfSnap);
  // Drawings: object list + props payloads (identity preserved).
  s.drawSink.incRestore(ck.drawSnap);
  for (const o of s.drawSink.objects) {
    const p = ck.drawProps.get(o);
    if (p) o.props = cloneDeep(p, ids);
  }
  // Plot sinks: membership + per-sink buffer length.
  ctx.plots.length = ck.sinkLen;
  for (let i = 0; i < ctx.plots.length && i < ck.sbufLens.length; i++) {
    const b = (ctx.plots[i] as { buf?: unknown[] }).buf;
    const n = ck.sbufLens[i]!;
    if (Array.isArray(b) && n >= 0) b.length = n;
  }
  // Scalars/collections on ctx — reference/clone restore.
  restoreMap(ctx.alertstate ?? (ctx.alertstate = new Map()), ck.alertstate);
  const fills = ctx.fills ?? (ctx.fills = []);
  fills.length = 0;
  for (const f of ck.fills) fills.push(cloneDeep(f, ids) as NonNullable<typeof ctx.fills>[number]);
  restoreMap(ctx.fillSites ?? (ctx.fillSites = new Map()), ck.fillSites);
  const restoreLayer = (live: Map<number, Map<string, string>> | undefined, saved: Map<number, Map<string, string>>) => {
    if (!live) return;
    for (const k of [...live.keys()]) if (!saved.has(k)) live.delete(k);
    for (const [k, v] of saved) live.set(k, new Map(v));
  };
  restoreLayer(ctx.bgcolors, ck.bgcolors);
  restoreLayer(ctx.barcolors, ck.barcolors);
  const liveLists = [ctx.liveLines, ctx.liveLabels, ctx.liveBoxes, ctx.liveTables, ctx.livePolylines, ctx.liveLinefills];
  for (let i = 0; i < liveLists.length; i++) {
    const a = liveLists[i];
    if (!a) continue;
    a.length = 0;
    for (const o of ck.liveArrays[i]!) (a as unknown[]).push(o);
  }
  // CowSeries materialized copies — before drawing/layer rewinds is fine;
  // order vs seriesSet doesn't matter (cow inners aren't in the set).
  for (const [c, snap] of ck.cowSnaps) c.incCowSet(snap);
  // Accumulators: truncate anything the forming bar appended.
  ctx.alerts.length = ck.alertsLen;
  ctx.warnings.length = ck.warningsLen;
  if (ctx.alertconditions) ctx.alertconditions.length = ck.alertcondLen;
  if (ctx.inputSchemas) ctx.inputSchemas.length = ck.inSchemaLen;
  if (ctx.plotSeq !== undefined) ctx.plotSeq = ck.plotSeq;
  if (ck.declQuotas) ctx.declQuotas = { ...ck.declQuotas };
  if (ck.warnKeys) ctx.warnKeys = new Set(ck.warnKeys);
  // JIT residual: mid-eval stacks are always empty at bar boundaries;
  // re-anchoring is belt-and-suspenders for an aborted forming eval.
  if (s.jit) {
    s.jit.scopeStack.length = 1;
    s.jit.scopeStack[0] = s.scope;
    s.jit.cur = s.frame0;
    s.jit.save.length = 0;
  }
  // Transient ctx fields — evaluation always leaves them clean at bar end.
  ctx.callsite = undefined;
  ctx.scopeDepth = 0;
  run.topLevelBody = false;
  run.topStmtIdx = -1;
  run.siteStack.length = 0;
  run.siteCtx.length = 0;
}

/** Does the script qualify for incremental resume? Strategy order execution
 *  is event-driven — it falls back to a fresh run per tick. request.* state
 *  lives in the per-session MTF store, checkpointed like everything else. */
function incEligible(parsed: ParsedInput): boolean {
  if (!Array.isArray(parsed)) return parsed.decl?.type !== 'strategy';
  return true;
}

/** First incremental run: build, evaluate every bar, checkpoint after each
 *  CLOSED bar — the forming (last) bar's state is discarded per tick, so the
 *  checkpoint must be taken at its predecessor, before it evaluates.
 *  Returns null session for empty tapes/ineligible scripts (caller falls
 *  back to plain runScript). */
export async function incRunStart(
  parsed: ParsedInput,
  bars: BarData[],
  opts: RunOptions = {},
): Promise<{ live: IncLive | null; result: RunResult }> {
  const decl = Array.isArray(parsed) ? null : (parsed.decl ?? null);
  const body = Array.isArray(parsed) ? parsed : parsed.body;
  const empty = (): RunResult => emptyResult(body, decl);
  if (bars.length === 0 || !incEligible(parsed)) return { live: null, result: await runScriptInner(parsed, bars, opts) };

  const s = await buildSess(parsed, bars, opts, new Set());
  if (s) s.emitCache = new Map(); // incremental sessions keep assembled plot arrays
  if (!s) return { live: null, result: empty() };
  if (opts.shouldAbort?.()) return { live: null, result: empty() };

  // committed = last CLOSED bar; a one-bar tape has no closed bar yet —
  // its checkpoint is the empty pre-bar state.
  const live: IncLive = { s, ckpt: checkpoint(s, -1), committed: -1, key: opts.incKey, dead: false };
  try {
    let barErr: PineRuntimeError | null = null;
    let sliceStart = nowMs();
    const lastClosed = bars.length - 2; // bars[len-1] is the forming bar
    for (let bar = 0; bar < bars.length; bar++) {
      const r = evalOneBar(s, bar);
      if (r === 'ret') break;
      if (r !== 'ok') { barErr = r; break; }
      if (bar <= lastClosed) live.committed = bar;
      // Single checkpoint at the committed boundary — per-bar checkpoints
      // were O(N^2) snapshots on first load (60s+ on 500-bar scripts).
      if (bar === lastClosed) live.ckpt = checkpoint(s, bar);
      if (nowMs() - sliceStart > 16) {
        await yieldTask();
        sliceStart = nowMs();
        if (opts.shouldAbort?.()) return { live: null, result: empty() };
      }
    }
    if (barErr) throw barErr;
  } finally {
    setActiveSeriesSet(null);
  }
  (globalThis as Record<string, unknown>).__pineStage = 'assemble';
  if (opts.shouldAbort?.()) return { live: null, result: empty() };
  return { live, result: assembleRunResult(s) };
}

const barsEq = (a: BarData | undefined, b: BarData | undefined): boolean =>
  a === b || (!!a && !!b && a.openTime === b.openTime && a.open === b.open &&
    a.high === b.high && a.low === b.low && a.close === b.close &&
    a.volume === b.volume && a.closeTime === b.closeTime);

/** Advance a live session to a changed tape. 'fallback' = caller must do a
 *  fresh run (prefix changed, session dead, or tape shrank). Otherwise:
 *  evaluate newly closed bars (checkpoint each), then rollback + re-eval the
 *  forming bar. */
export async function incAdvance(
  live: IncLive,
  bars: BarData[],
): Promise<'fallback' | RunResult> {
  const s = live.s;
  if (live.dead || bars.length === 0) return 'fallback';
  const old = s.barCtx.bars;
  const oldLen = old.length; // `old` aliases s.barCtx.bars — the in-place grow below would mask the length delta
  // Tape shrink realigns absolute indexes — index-keyed checkpoints can't
  // map back; restart. Same-length extension-free tapes still fall through
  // to the forming-bar rollback below.
  if (bars.length < old.length) return 'fallback';
  // First index where the tapes differ — a changed earlier bar invalidates
  // committed state (bars are append-only in live mode; anything else means
  // history rewrite, e.g. data reload).
  let firstDiff = old.length;
  for (let i = 0; i < old.length; i++) {
    if (!barsEq(old[i], bars[i])) { firstDiff = i; break; }
  }
  if (firstDiff <= live.committed) return 'fallback';
  // Grow/rewrite the shared tape in place.
  for (let i = 0; i < bars.length; i++) s.barCtx.bars[i] = bars[i]!;
  s.barCtx.bars.length = bars.length;
  s.barCtx.setTape(s.barCtx.bars);
  const last = bars.length - 1;
  // Restore this session's MTF store as the active one — a sibling run may
  // have prepared security against its own store meanwhile.
  if (s.mtf !== undefined) mtf?.activate?.(s.mtf);
  setActiveSeriesSet(s.seriesSet);
  try {
    // Discard last tick's tentative forming-bar eval FIRST — committed bars
    // must evaluate on clean checkpoint state, not on top of stale writes.
    // rewindCursor moves the cursor back with the series so the upcoming
    // seeks re-push the bars (no double-write: the series state was rolled
    // back to the same point).
    restoreCkpt(s, live.ckpt);
    s.barCtx.rewindCursor(live.ckpt.bar);
    // Tape grew → higher-tf feeds may carry freshly closed bars. Refresh
    // AFTER the checkpoint restore (restore rewrote spec.bars to its snap);
    // refresh's resetTfFrame drops tf frames only when content changed.
    if (bars.length > oldLen && s.mtf !== undefined && mtf?.refresh) {
      await mtf.refresh(s.ctx, s.frame0);
    }
    // Commit newly closed bars: evaluate (committed+1 .. last-1); the old
    // forming bar sits in this range and lands its final tick's data.
    for (let b = live.committed + 1; b < last; b++) {
      const r = evalOneBar(s, b);
      if (r === 'ret' || r !== 'ok') { live.dead = true; return 'fallback'; }
      live.committed = b;
      live.ckpt = checkpoint(s, b);
    }
    // Re-evaluate the forming bar with its newest data (state = post-eval
    // of the newest closed bar — the commit loop already cleaned it).
    const r = evalOneBar(s, last);
    if (r === 'ret' || r !== 'ok') { live.dead = true; return 'fallback'; }
  } finally {
    setActiveSeriesSet(null);
  }
  return assembleRunResult(s);
}

/** Session-aware runScript: advance an existing IncLive when the key matches
 *  and the tape extends; build a new one when it doesn't. Returns the session
 *  to persist for the next call (null = keep using plain runScript). */
export async function incRun(
  parsed: ParsedInput,
  bars: BarData[],
  opts: RunOptions = {},
): Promise<{ live: IncLive | null; result: RunResult }> {
  const p = runScriptTail.then(async () => {
    const prior = opts.incSession ?? null;
    // Key mismatch = the run's inputs/syminfo/source changed since this
    // session was built — resuming it would emit stale-input results.
    if (prior && prior.key === opts.incKey && incEligible(parsed)) {
      const r = await incAdvance(prior, bars);
      if (r !== 'fallback') return { live: prior, result: r };
    }
    if (!incEligible(parsed)) {
      return { live: null, result: await runScriptInner(parsed, bars, opts) };
    }
    return incRunStart(parsed, bars, opts);
  });
  runScriptTail = p.then(() => {}, () => {});
  return p;
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
