// ── MTF evaluator: request.security(sym, tf, expr, gaps, lookahead) ────────
//
// Flow (interpreter integration via registerMtf):
//   prepareSecurity(body, frame0)  — AST-scan; record every request.security Call
//                                    node, statically resolve (sym, tf) when the
//                                    args are string literals or bound to an
//                                    input.timeframe/input.string default.
//   await prefetchSecurity(ctx)    — ctx.fetchSeries(sym, tf) once per unique
//                                    (sym, tf); bars shared between call sites.
//   tryEvalSecurity(node, frame)   — per-bar hook inside evalExpr's Call case.
//                                    Returns null when `node` is not a
//                                    request.security call.
//
// Semantics (TradingView):
//   lookahead_off → value of the last tf bar COMPLETED at the chart bar's
//                   open time (no future leak on the developing tf bar).
//   lookahead_on  → value of the tf bar containing the chart bar's end
//                   (final value of the developing tf bar — future leak,
//                   TradingView-compatible).
//   gaps_off      → every chart bar emits (forward-filled by alignment).
//   gaps_on       → only the first chart bar inside each tf bar emits;
//                   other chart bars get na.
//   Values are evaluated once per (call-site node, tf bar) and cached —
//   a tf bar's expression is never recomputed for later chart bars.
//
// Expression forms: `close`/`open`/… (tf series), `expr[n]` (tf history),
// `[a, b]` tuple (array Value), `f(...)` UDF calls (body evaluated inside the
// tf frame), bare `name` referencing a top-level global → the global's
// producer expression is re-evaluated in the tf context.

import type { Arg, BarData, BuiltinCtx, Call, Node, Param, PineType, UdfDecl, Value } from './contracts';
import { BREAK, CONTINUE, NA, ReturnSignal, Scope, Series } from './contracts';
import { PineRuntimeError } from './errors';
import { astChildren, callsiteKey, evalBlock, evalExpr, registerMtf } from './interpreter';
import { BarSeries, ForwardingSeries, histGetAt, seriesHooks } from './series';
import { FOR_IN } from './parser';
import { BUILTINS, CONSTANTS } from './builtins/registry';
import type { Frame } from './scope';
import { buildSyminfo } from './context';

// ── evaluator hooks ─────────────────────────────────────────────────────────
// Real interpreter evaluation, adapted to the (node, scope, ctx) triple so tf
// child frames can be built without touching interpreter Frame internals.

const evalHook = (node: Node, scope: Scope, ctx: BuiltinCtx): Value =>
  evalExpr(node, { scope, ctx });

const blockHook = (stmts: Node[], scope: Scope, ctx: BuiltinCtx): Value =>
  evalBlock(stmts, { scope, ctx });

// ── timeframe helpers ───────────────────────────────────────────────────────

/** Parse a Pine timeframe string → milliseconds, or null for calendar units. */
export function tfToMs(tf: string): number | null {
  const m = /^(\d*)\s*([a-zA-Z]*)$/.exec(tf.trim());
  if (!m) return null;
  const n = m[1] === '' ? 1 : parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch ((m[2] ?? '').toUpperCase()) {
    case '': return n * 60_000;   // bare number = minutes
    case 'S': return n * 1_000;
    case 'H': return n * 3_600_000;
    default: return null;         // D/W/M are calendar units
  }
}

function tfParts(tf: string): { n: number; unit: string } {
  const m = /^(\d*)\s*([a-zA-Z]*)$/.exec(tf.trim());
  const n = !m || m[1] === '' ? 1 : parseInt(m[1]!, 10);
  const unit = (m?.[2] ?? '').toUpperCase();
  return { n, unit: unit === '' ? 'MIN' : unit };
}

const DAY = 86_400_000;

/** Floor a UTC timestamp to the start of its tf bar (UTC-anchored). */
export function tfFloor(t: number, tf: string): number {
  const { n, unit } = tfParts(tf);
  if (unit === 'D') {
    const day = Math.floor(t / DAY);
    return Math.floor(day / n) * n * DAY;
  }
  if (unit === 'W') {
    const day = Math.floor(t / DAY);
    const dow = (((day % 7) + 7) % 7 + 4) % 7;         // epoch day 0 = Thursday
    const monday = day - ((dow + 6) % 7);              // back to Monday
    // Anchor Monday-grouped weeks to epoch Thursday (1969-12-29 = anchor -3).
    return (Math.floor((monday + 3) / (7 * n)) * 7 * n - 3) * DAY;
  }
  if (unit === 'M') {
    const d = new Date(t);
    const total = d.getUTCFullYear() * 12 + d.getUTCMonth();
    const g = Math.floor(total / n) * n;
    return Date.UTC(Math.floor(g / 12), g % 12, 1);
  }
  const ms = tfToMs(tf) ?? 60_000;
  return t - (t % ms);
}

/** Start of the NEXT tf bar after the bar starting at `start` (calendar-aware). */
export function tfNext(start: number, tf: string): number {
  const { n, unit } = tfParts(tf);
  if (unit === 'M') {
    const d = new Date(start);
    const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
    return Date.UTC(Math.floor(total / 12), total % 12, 1);
  }
  if (unit === 'W') return start + 7 * n * DAY;
  if (unit === 'D') return start + n * DAY;
  return start + (tfToMs(tf) ?? 60_000);
}

// ── spec collection ─────────────────────────────────────────────────────────

const DYNAMIC = '__dynamic__';
const CHART_SYM = ''; // '' = chart symbol; fetchSeries resolves it

/**
 * A file-level name usable inside security expressions.
 * `node` is the producer expression (null when declared only inside a branch —
 * the decl then rides in `writes` via declAsWrite). `pick` indexes tuple
 * destructure members. `once` = `var` decl (init at tf bar 0 only). `writes`
 * lists top-level stmts that `:=`-mutate the name — replayed per tf bar.
 * `inBranch` marks decls inside top-level if/seq branches: the guard is NOT
 * replayed, so the producer evaluates unconditionally (warned once).
 */
interface GlobalDef {
  node: Node | null;
  pick?: number;
  once: boolean;
  writes: Node[];
  inBranch?: boolean;
  /** The decl stmt was rewritten into `writes` — init via replay, not producer. */
  initInWrites?: boolean;
}

interface SecuritySpec {
  node: Call;
  sym: string;                    // declared symbol ('', DYNAMIC, or literal)
  tf: string;                     // declared tf (literal or DYNAMIC)
  symResolved?: string;           // latest dynamic resolution (sym stays DYNAMIC)
  tfResolved?: string;            // latest dynamic tf resolution (tf stays DYNAMIC)
  symNode?: Node; tfNode?: Node;  // raw arg nodes (for dynamic resolution)
  exprs: Node[];                  // tuple-expanded expression args
  gaps: 'off' | 'on';
  lookahead: 'off' | 'on';
  /** security_lower_tf: return array of per-lower-bar values. */
  isLtf?: boolean;
  // ── runtime state ──
  bars: BarData[] | null;
  scope: Scope | null;            // persistent tf scope (parent = caller pivot)
  pivot: Scope | null;            // delegates to the live caller scope
  callerScope: Scope | null;      // scope that invoked security this bar
  /** Callsite-composed caller identity (chartHist/lastChartBar key): the same
   *  security node reached through different UDF callsites keeps separate
   *  chart-domain histories. Rebound per call alongside callerScope. */
  callerKey: object | null;
  durableCache: Map<Node, WeakMap<Scope, Map<number, Value>>> | null; // eval cache for the stable root scope
  seenCallers: WeakSet<Scope>;        // caller scopes seen before — recurring ⇒ durable cache
  ctx: BuiltinCtx | null;         // child ctx with tf series
  series: Record<string, BarSeries>;
  loaded: number;                 // tf bars pushed into series so far
  nodeCache: Map<Node, WeakMap<Scope, Map<number, Value>>>; // node → caller scope → tfBarIndex → value
  agnosticCache: Map<Node, Map<number, Value>> | null; // caller-agnostic evals: node → tfBarIndex → value
  agnosticSafe: Map<Node, boolean> | null;            // gate verdict per expr node (survives tf rebuilds)
  prodVerdicts: Map<Node, boolean> | null;            // producer-walk verdicts shared across the spec's gated exprs
  lastEmit?: Map<object, number>; // gaps_on: last tfIdx that emitted, per caller callsite
  warned: Set<string>;
  varScope: Scope | null;         // sibling scope holding mutated-global slots
  varProg: Node[];                // ordered top-level stmts writing mutated globals
  varUpto: number;                // varProg replayed through this tf bar
  varInited: Set<string>;         // `once` globals already initialized
  /** First-hit warm-up done: tf bars 0..last j evaluated so strict-window
   *  expressions see full history when the call is chart-gated. */
  warmed?: boolean;
  /** Chart-domain emit history per expr node — `security(...)[n]` on the chart
   *  reads the previous CHART bar's mapped value, not the previous tf bar. */
  chartHist?: Map<Node, Map<object, BarSeries>>;
  /** Latest chart bar each caller callsite emitted on (emit dedup guard). */
  lastChartBar?: Map<object, number>;
}

interface MtfStore {
  byNode: Map<Call, SecuritySpec>;
  fetched: Map<string, BarData[]>;   // `${sym}\n${tf}` → bars
  globals: Map<string, GlobalDef>;   // top-level name → producer/writes
  staticEnv: Map<string, string>;    // input.* default values by var name
  funcs: Map<string, Node>;          // UDF decls — prebind so prefetch-time globals can call them
  varProg: Node[];                   // ordered top-level stmts replayed per tf bar (mutated globals)
}

function newStore(): MtfStore {
  return { byNode: new Map(), fetched: new Map(), globals: new Map(), staticEnv: new Map(), funcs: new Map(), varProg: [] };
}

let store: MtfStore = newStore();

/** Reset all MTF state (tests / new run). */
export function resetMtf(): void {
  store = newStore();
}

// ── AST walk ────────────────────────────────────────────────────────────────

function eachNode(node: Node | Node[] | undefined | null, fn: (n: Node) => void): void {
  if (!node) return;
  if (Array.isArray(node)) { for (const n of node) eachNode(n, fn); return; }
  fn(node);
  const n = node as unknown as Record<string, unknown>;
  for (const k of Object.keys(n)) {
    if (k === 'loc' || k === 'type') continue;
    const v = n[k];
    if (Array.isArray(v)) {
      for (const item of v as unknown[]) {
        if (item && typeof item === 'object' && 'type' in (item as object)) eachNode(item as Node, fn);
        else if (item && typeof item === 'object') {
          // Arg / case / elseIf wrappers: {name,value}, {test,body}, {body}
          const w = item as Record<string, unknown>;
          if (w.value && typeof w.value === 'object' && 'type' in (w.value as object)) eachNode(w.value as Node, fn);
          if (w.test && typeof w.test === 'object' && 'type' in (w.test as object)) eachNode(w.test as Node, fn);
          if (Array.isArray(w.body)) eachNode(w.body as Node[], fn);
        }
      }
    } else if (v && typeof v === 'object' && 'type' in (v as object)) {
      eachNode(v as Node, fn);
    }
  }
}

function isSecurityCall(n: Node): n is Call {
  if (n.type !== 'call') return false;
  const c = n.callee;
  return c.type === 'member' && !c.computed
    && (c.prop === 'security' || c.prop === 'security_lower_tf')
    && c.obj.type === 'ident' && c.obj.name === 'request';
}

function memberOf(node: Node | undefined): { ns: string; name: string } | null {
  if (!node || node.type !== 'member') return null;
  if (node.obj.type === 'ident') return { ns: node.obj.name, name: node.prop };
  return null;
}

/** Pick arg by name (named arg) falling back to positional index. */
function pickArg(args: Arg[], idx: number, ...names: string[]): Node | undefined {
  for (const nm of names) {
    const a = args.find(a => a.name === nm);
    if (a) return a.value;
  }
  const pos = args.filter(a => a.name === undefined);
  return pos[idx]?.value;
}

// ── static const resolution ─────────────────────────────────────────────────

function constString(node: Node | undefined, env: Map<string, string>): string | null {
  if (!node) return null;
  if (node.type === 'str') return node.v;
  if (node.type === 'num') return String(node.v);
  if (node.type === 'ident') return env.get(node.name) ?? null;
  if (node.type === 'member') {
    const m = memberOf(node);
    if (m?.ns === 'syminfo' && (m.name === 'tickerid' || m.name === 'ticker')) return CHART_SYM;
    // timeframe.period etc. are dynamic — resolved lazily at first call
  }
  return null;
}

function constFlag(node: Node | undefined, on: string): 'off' | 'on' {
  if (!node) return 'off';
  if (node.type === 'member' && node.prop.includes(on)) return 'on';
  if (node.type === 'ident' && node.name.includes(on)) return 'on';
  if (node.type === 'str' && node.v.includes(on)) return 'on';
  return 'off';
}

/** True for the decl node types that bind a name at file level. */
const isDeclType = (t: string): boolean =>
  t === 'assign' || t === 'let' || t === 'const' || t === 'var' || t === 'typed';

/**
 * Rewrite a name-binding decl as a `:=` reassign so replaying a top-level
 * `if` branch writes the shared mutated-global slot instead of creating a
 * throwaway block-local binding. `var` decls keep init-once semantics via
 * `varInited` — their unconditional `node` producer already seeds the slot.
 * Tuples and `var` multi-decl components are left as-is (see warn path).
 */
function declAsWrite(s: Node): Node | null {
  const d = s as { type: string; name?: string; value?: Node };
  if (!isDeclType(d.type)) return null;
  if (d.type === 'var' || !d.name || !d.value) return null;
  return { type: 'reassign', target: { type: 'ident', name: d.name }, value: d.value } as Node;
}

/**
 * Scan top-level stmts for input.* defaults (staticEnv), name→producer
 * globals, and `:=` mutation programs (GlobalDef.writes).
 *
 * Collected exhaustively: plain/multi decls, `[a,b] = expr` tuple members
 * (pick = index into the tuple result), `export` (parser flattens it to the
 * inner decl), and decls inside top-level `if`/`seq` statements (inBranch —
 * producer evaluated unconditionally, warned once on read).
 *
 * Mutation model: a global that is `:=`-reassigned at top level becomes a
 * TfVarSeries — per tf bar the init (`var` decls once at bar 0, others every
 * bar) then the ordered list of containing top-level stmts is replayed inside
 * varScope so `g := g + 1` accumulates. Stmts are shared across globals and
 * replayed once per tf bar regardless of how many globals they touch.
 */
function scanTopLevel(body: Node[], st: MtfStore): void {
  // Pass 1 — decls (record containing top-level stmt so pass 2 can replay it).
  const declStmt = new Map<string, Node>();
  const walkDecls = (stmts: Node[], top: Node, inBranch: boolean): void => {
    for (const s of stmts) {
      const d = s as {
        type: string; name?: string; value?: Node; names?: string[];
        multi?: { name: string; value: Node }[];
        then?: Node[]; elseIfs?: { body: Node[] }[]; else?: Node[] | null;
        stmts?: Node[];
      };
      if (isDeclType(d.type)) {
        if (d.name && d.value) {
          const prev = st.globals.get(d.name);
          st.globals.set(d.name, {
            node: d.value,
            once: d.type === 'var' || (prev?.once ?? false),
            writes: prev?.writes ?? [],
            inBranch: inBranch || prev?.inBranch,
          });
          declStmt.set(d.name, top);
          // input.* defaults deliberately NOT captured into staticEnv — the
          // ctx.inputs override must win at runConst time (F4).
        } else if (d.type === 'var' && d.multi) {
          for (const mi of d.multi) {
            if (!mi.name || !mi.value) continue;
            const prev = st.globals.get(mi.name);
            st.globals.set(mi.name, {
              node: mi.value, once: true,
              writes: prev?.writes ?? [],
              inBranch: inBranch || prev?.inBranch,
            });
            declStmt.set(mi.name, top);
          }
        } else if (d.name && !d.value) {
          // `float x` — uninitialized decl; producer reads na at the tf bar.
          st.globals.set(d.name, {
            node: { type: 'na' } as Node, once: d.type === 'var',
            writes: st.globals.get(d.name)?.writes ?? [],
            inBranch: inBranch || st.globals.get(d.name)?.inBranch,
          });
          declStmt.set(d.name, top);
        }
      } else if (d.type === 'tuple' && d.names && d.value) {
        d.names.forEach((name, i) => {
          const prev = st.globals.get(name);
          st.globals.set(name, {
            node: d.value!, pick: i,
            once: prev?.once ?? false,
            writes: prev?.writes ?? [],
            inBranch: inBranch || prev?.inBranch,
          });
          declStmt.set(name, top);
        });
      } else if (d.type === 'if' || d.type === 'ifexpr') {
        walkDecls(d.then ?? [], top, true);
        for (const e of d.elseIfs ?? []) walkDecls(e.body, top, true);
        if (d.else) walkDecls(d.else, top, true);
      } else if (d.type === 'seq' && d.stmts) {
        walkDecls(d.stmts, top, inBranch);
      }
      // `f(...) => …` — prefetch globals may invoke it; prebind in pfScope.
      if (d.type === 'func' && d.name) st.funcs.set(d.name, s);
    }
  };
  for (const s of body) walkDecls([s], s, false);

  // Pass 2 — collect the top-level stmts that `:=`-mutate each global.
  // Descends into branch bodies but not into function decls (writes inside a
  // UDF land on the TfVarSeries slot, which warns + drops — see setAt).
  const walkWrites = (n: Node, top: Node): void => {
    const d = n as {
      type: string; target?: Node; name?: string; body?: Node | Node[];
      value?: Node; test?: Node;
      then?: Node[]; elseIfs?: { body: Node[] }[]; else?: Node[] | null;
      stmts?: Node[]; cases?: { body: Node[] }[]; decl?: Node;
    };
    if (d.type === 'func' || d.type === 'arrow' || d.type === 'method') return;
    if (d.type === 'reassign') {
      if (d.target?.type === 'ident') {
        const def = st.globals.get(d.target.name);
        if (def && !def.writes.includes(top)) def.writes.push(top);
      }
      if (d.value) walkWrites(d.value, top);   // `g := if c → h := 1` etc.
      return;
    }
    if (d.value && (isDeclType(d.type) || d.type === 'tuple')) {
      walkWrites(d.value, top);                // `x = if c → g := 1`
    }
    for (const k of ['then', 'else', 'stmts'] as const) {
      const sub = d[k];
      if (Array.isArray(sub)) for (const s of sub) walkWrites(s, top);
    }
    for (const e of d.elseIfs ?? []) for (const s of e.body) walkWrites(s, top);
    for (const c of d.cases ?? []) for (const s of c.body) walkWrites(s, top);
    if (d.decl) walkWrites(d.decl, top);
  };
  for (const s of body) walkWrites(s, s);

  // Mutated names get their decl stmt rewritten to a `:=` write so
  // conditional inits (`if c → g = e`) also replay; decls that can't be
  // rewritten (var/tuple/multi) keep producer-driven init in TfVarSeries.
  // declWrites maps the original decl stmt → its synthetic reassign so the
  // replay program stays in body order.
  const declWrites = new Map<Node, Node>();
  for (const [name, def] of st.globals) {
    if (def.writes.length === 0) continue;
    const top = declStmt.get(name);
    if (!top) continue;
    const w = declAsWrite(top);
    if (!w) continue;
    def.writes.unshift(w);
    def.initInWrites = true;
    declWrites.set(top, w);
  }
  // Shared ordered replay program: every top-level stmt writing a mutated
  // global (or its rewritten decl), in body order, deduplicated.
  const inProg = new Set<Node>();
  for (const def of st.globals.values()) for (const w of def.writes) inProg.add(w);
  for (const s of body) {
    const w = declWrites.get(s);
    if (w) st.varProg.push(w);
    else if (inProg.has(s)) st.varProg.push(s);
  }
}

/**
 * AST-scan for request.security calls; record specs + global producers.
 * `frame0` accepted for interpreter call-site symmetry (unused — the tf scope
 * parent pivots to the live caller frame at each evaluation).
 */
export function prepareSecurity(body: Node[], _frame0?: unknown): void {
  store = newStore();
  scanTopLevel(body, store);
  eachNode(body, n => {
    if (!isSecurityCall(n)) return;
    const symNode = pickArg(n.args, 0, 'symbol');
    const tfNode = pickArg(n.args, 1, 'timeframe');
    const exprNode = pickArg(n.args, 2, 'expression');
    const isLtf = n.callee.type === 'member' && n.callee.prop === 'security_lower_tf';
    // security_lower_tf's arg4/arg5 are ignore_invalid_symbol/currency —
    // gaps/lookahead don't exist for it, so only plain security() reads them.
    const gapsNode = isLtf ? undefined : pickArg(n.args, 3, 'gaps');
    const laNode = isLtf ? undefined : pickArg(n.args, 4, 'lookahead');
    store.byNode.set(n, {
      node: n,
      sym: constString(symNode, store.staticEnv) ?? DYNAMIC,
      tf: constString(tfNode, store.staticEnv) ?? DYNAMIC,
      symNode, tfNode,
      exprs: exprNode ? (exprNode.type === 'arraylit' ? exprNode.items : [exprNode]) : [],
      gaps: constFlag(gapsNode, 'gaps_on'),
      lookahead: constFlag(laNode, 'lookahead_on'),
      isLtf,
      bars: null, scope: null, pivot: null, callerScope: null, callerKey: null, durableCache: null, seenCallers: new WeakSet(), ctx: null,
      series: {}, loaded: 0,
      nodeCache: new Map(),
      agnosticCache: null, agnosticSafe: null, prodVerdicts: null,
      warned: new Set(),
      varScope: null, varProg: [], varUpto: -1, varInited: new Set(),
    });
  });
}

// ── prefetch ────────────────────────────────────────────────────────────────

/** Reconstruct chart BarData[] from a BuiltinCtx's series (no fetchSeries path). */
function chartBarsFromCtx(ctx: BuiltinCtx): BarData[] {
  const num = (s: Series, i: number): number => {
    const v = s.get(i);
    return v.kind === 'int' || v.kind === 'float' ? v.v : NaN;
  };
  const bars: BarData[] = [];
  for (let i = ctx.close.size() - 1; i >= 0; i--) {
    bars.push({
      openTime: num(ctx.time, i),
      open: num(ctx.open, i), high: num(ctx.high, i), low: num(ctx.low, i),
      close: num(ctx.close, i), volume: num(ctx.volume, i),
    });
  }
  return bars;
}

/** Fetch bars for every statically-resolvable (sym, tf) spec. Await in runScript. */
export async function prefetchSecurity(ctx: BuiltinCtx, frame?: Frame, allBars?: BarData[]): Promise<void> {
  const chartBars = ctx.fetchSeries ? null : allBars ?? chartBarsFromCtx(ctx);
  // Resolve bar0-constant dynamic specs (e.g. input.timeframe, ternary of consts)
  // before fetching so they hit the static (sym, tf) prefetch path.
  {
    // Prebind statically-resolvable globals into a prefetch scope so runConst
    // can evaluate ternaries/idents like `useCurrentTF ? "60" : "15"`. With no
    // caller frame (prepare-only tests) an empty scope still resolves
    // input.*-only producers — they read ctx.inputs, not scope (F4).
    const pfScope = frame ? new Scope(frame.scope) : new Scope();
    for (const [name, v] of store.staticEnv) {
      pfScope.define(name, { kind: 'string', v });
    }
    // Bind UDFs first — global producers (and their bodies) may reference them.
    for (const [name, node] of store.funcs) {
      const f = node as { params: Param[]; body: Node | Node[] };
      pfScope.define(name, {
        kind: 'function',
        v: { name, params: f.params, body: f.body, closure: pfScope },
      });
    }
    // Prebind is speculative — globals that can't resolve at bar0 stay unbound
    // and fall back to the dynamic path. Swap in a scratch warnings buffer so
    // speculative 'identifier not found' noise doesn't leak into RunResult.
    // Only globals reachable from a dynamic sym/tf arg are evaluated: evaluating
    // unrelated producers would run their side effects (e.g. UDF var counters).
    const needed = new Set<string>();
    for (const spec of store.byNode.values()) {
      if (spec.sym === DYNAMIC) collectGlobalRefs(spec.symNode, needed);
      if (spec.tf === DYNAMIC) collectGlobalRefs(spec.tfNode, needed);
    }
    for (let grew = true; grew; ) {
      grew = false;
      for (const name of [...needed]) {
        const before = needed.size;
        collectGlobalRefs(store.globals.get(name)?.node ?? undefined, needed);
        if (needed.size > before) grew = true;
      }
    }
    const realWarnings = ctx.warnings;
    ctx.warnings = [];
    try {
      for (const name of needed) {
        if (pfScope.lookup(name) !== undefined) continue;
        const def = store.globals.get(name);
        if (!def?.node) continue;
        try {
          const val = evalHook(def.node, pfScope, ctx);
          const u = val.kind === 'series' ? val.v.cur() : val;
          pfScope.define(name, u);
        } catch { /* leave unbound — falls back to dynamic */ }
      }
    } finally {
      ctx.warnings = realWarnings;
    }
    const pfFrame: Frame = { scope: pfScope, ctx: frame?.ctx ?? ctx };
    for (const spec of store.byNode.values()) {
      if (spec.sym === DYNAMIC && spec.symNode) {
        const s = runConst(spec.symNode, pfFrame); if (s) spec.symResolved = s;
      }
      if (spec.tf === DYNAMIC && spec.tfNode) {
        const t = runConst(spec.tfNode, pfFrame); if (t) spec.tfResolved = t;
      }
    }
  }
  // Per-job timeout + failure isolation: a hung provider promise would hold
  // the global runScript mutex forever (all Pine sessions wedge until reload),
  // and Promise.all's first-rejection would kill the whole run — TV semantics
  // degrade a failed security() to na, so do the same via an empty series.
  const PREFETCH_TIMEOUT_MS = 30_000;
  const jobs = new Map<string, Promise<BarData[]>>();
  // CHART_SYM ('' = syminfo.tickerid) must resolve to the real ticker for
  // fetchSeries — the provider can't route an empty symbol (F3).
  const chartTicker = ctx.syminfo?.tickerid?.kind === 'string' ? ctx.syminfo.tickerid.v : CHART_SYM;
  for (const spec of store.byNode.values()) {
    const sym = resolvedSym(spec) === CHART_SYM ? chartTicker : resolvedSym(spec);
    const tf = resolvedTf(spec);
    if (sym === DYNAMIC || tf === DYNAMIC) continue;
    const key = `${sym}\n${tf}`;
    if (store.fetched.has(key) || jobs.has(key)) continue;
    const job = ctx.fetchSeries
      ? Promise.resolve().then(() => ctx.fetchSeries!(sym, tf)) // sync throws land in the race/catch (F9)
      : Promise.resolve(chartBars!);
    jobs.set(key, Promise.race([
      job,
      (() => {
        const { promise, reject } = Promise.withResolvers<BarData[]>();
        setTimeout(() => reject(new Error(`fetchSeries timeout ${PREFETCH_TIMEOUT_MS}ms`)), PREFETCH_TIMEOUT_MS);
        return promise;
      })(),
    ]).catch((e) => {
      console.warn(`[pine] prefetch ${sym} ${tf} failed:`, e instanceof Error ? e.message : e);
      return [] as BarData[];
    }));
  }
  const keys = [...jobs.keys()];
  const results = await Promise.all(keys.map(k => jobs.get(k)!));
  keys.forEach((k, i) => store.fetched.set(k, results[i]!));
  for (const spec of store.byNode.values()) {
    const sym = resolvedSym(spec) === CHART_SYM ? chartTicker : resolvedSym(spec), tf = resolvedTf(spec);
    if (sym === DYNAMIC || tf === DYNAMIC) continue;
    spec.bars = store.fetched.get(`${sym}\n${tf}`) ?? [];
  }
}

/** Names of file-level globals referenced anywhere inside `node`. */
function collectGlobalRefs(node: Node | undefined, out: Set<string>): void {
  if (!node) return;
  eachNode(node, n => {
    if (n.type === 'ident' && store.globals.has(n.name)) out.add(n.name);
  });
}

// ── alignment ───────────────────────────────────────────────────────────────

function numOf(v: Value): number | null {
  return v.kind === 'int' || v.kind === 'float' ? v.v : null;
}

/** Sym/tf to fetch and align with — dynamic specs use their latest resolution. */
function resolvedSym(spec: SecuritySpec): string {
  return spec.sym === DYNAMIC ? spec.symResolved ?? DYNAMIC : spec.sym;
}
function resolvedTf(spec: SecuritySpec): string {
  return spec.tf === DYNAMIC ? spec.tfResolved ?? DYNAMIC : spec.tf;
}

/** Last index i with bars[i].openTime <= t, or -1. */
function tfBarAtOrBefore(bars: BarData[], t: number): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.openTime <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** End time of tf bar i (next bar's open, or nominal duration for the last bar). */
function tfBarEnd(bars: BarData[], i: number, tf: string): number {
  return i + 1 < bars.length ? bars[i + 1]!.openTime : tfNext(bars[i]!.openTime, tf);
}

// ── tf frame construction ───────────────────────────────────────────────────

const SERIES_NAMES = ['open', 'high', 'low', 'close', 'volume', 'time', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'] as const;

function mkVal(x: number): Value {
  return Number.isInteger(x) ? { kind: 'int', v: x } : { kind: 'float', v: x };
}

// ── eval anchor ─────────────────────────────────────────────────────────────
// While mtf evaluates an expression at tf bar j (evalAt sets ctx.barIndex = j),
// EVERY BarSeries.read via get()/cur() must resolve "n bars ago" relative to
// the live ctx.barIndex — never the series' own newest write. Nested evalAt
// (global producers, histrefs) evaluates at j' < j while spec.series.lastBar
// is already j, so lastBar-anchored get() leaks future bars into e.g.
// `ta.sma(close,2)` source windows. The same applies to interpreter-owned
// callHist slots a tf-context builtin may read. We therefore anchor get/cur
// on the active tf ctx for the duration of evalAt. Reads outside tf eval
// (tfAnchor === null) take the original path unchanged.

let tfAnchor: BuiltinCtx | null = null;

/** Series owned by the active tf frame (spec OHLC ctx + shadows) — reads
 *  anchor on the tf bar index. */
const tfOwned = new WeakSet<BarSeries>();
/** Series written while a tf eval is active (callHist slots, var replay) —
 *  they carry tf-domain bar indexes, so reads must anchor on tfAnchor too. */
const tfDirty = new WeakSet<BarSeries>();

const barSeriesGet = BarSeries.prototype.get;
const barSeriesCur = BarSeries.prototype.cur;
const barSeriesSetAt = BarSeries.prototype.setAt;
BarSeries.prototype.setAt = function (this: BarSeries, bar: number, v: Value): void {
  if (tfAnchor !== null) tfDirty.add(this);
  return barSeriesSetAt.call(this, bar, v);
};
BarSeries.prototype.get = function (this: BarSeries, n: number): Value {
  // Only tf-domain series re-anchor; caller-scope chart series keep their own
  // (chart-bar) index so `f(p) => security(.., p)` reads the live chart value.
  if (tfAnchor !== null && (tfOwned.has(this) || tfDirty.has(this)))
    return this.atOffset(tfAnchor.barIndex, n);
  return barSeriesGet.call(this, n);
};
BarSeries.prototype.cur = function (this: BarSeries): Value {
  if (tfAnchor !== null && (tfOwned.has(this) || tfDirty.has(this)))
    return this.atOffset(tfAnchor.barIndex, 0);
  return barSeriesCur.call(this);
};

const barSeriesAtOffset = BarSeries.prototype.atOffset;
BarSeries.prototype.atOffset = function (this: BarSeries, bar: number, n: number): Value {
  if (tfAnchor !== null) {
    // tf-domain series read at the tf bar; caller chart series read at their
    // own lastBar (the live chart bar) — never the foreign tf index.
    if (tfOwned.has(this) || tfDirty.has(this)) return barSeriesAtOffset.call(this, tfAnchor.barIndex, n);
    return barSeriesAtOffset.call(this, this.currentBar, n);
  }
  return barSeriesAtOffset.call(this, bar, n);
};

// Frozen readers (math.ts lazy lifts) must replay exactly what a live get(i)
// would have answered: tf-domain series anchor on the tf bar, everything else
// on its own lastBar. touch() mirrors the tfDirty marking a write performs.
seriesHooks.anchor = (s) =>
  tfAnchor !== null && (tfOwned.has(s) || tfDirty.has(s)) ? tfAnchor.barIndex : s.currentBar;
seriesHooks.touch = (s) => {
  if (tfAnchor !== null) tfDirty.add(s);
};

/**
 * spec.scope's parent — delegates to whichever scope invoked the security()
 * call this bar. Rebound per call via `spec.callerScope`, so the same call
 * node evaluated inside different UDF call frames resolves params/locals
 * against the LIVE caller frame instead of being frozen to the first caller.
 */
class PivotScope extends Scope {
  constructor(private spec: SecuritySpec) { super(); }
  override lookup(name: string): Series | Value | undefined {
    return this.spec.callerScope?.lookup(name);
  }
  override has(name: string): boolean {
    return this.spec.callerScope?.has(name) ?? false;
  }
}

/**
 * tf-scope shadow for a file-level global: every read re-evaluates the global's
 * producer at the requested tf bar, so `g`, `g + 1` and `g[n]` all observe the
 * tf context (and na before tf bar 0). Tuple decls (`[a, b] = expr`) carry
 * `pick` — the member's index into the tuple result.
 */
class TfGlobalSeries extends BarSeries {
  constructor(private spec: SecuritySpec, private name: string, private def: GlobalDef) { super(8); }
  private at(j: number): Value {
    const spec = this.spec;
    if (!Number.isFinite(j) || !this.def.node) return NA;
    if (this.def.inBranch) {
      warnOnce(spec, spec.ctx!,
        `request.security: '${this.name}' is declared inside a conditional branch — evaluated unconditionally in the security context`);
    }
    const v = evalAt(spec, this.def.node, j);
    const u = v.kind === 'series'
      ? (v.v instanceof BarSeries ? v.v.atOffset(j, 0) : v.v.cur())
      : v;
    return this.def.pick !== undefined
      ? (u.kind === 'array' ? u.v[this.def.pick] ?? NA : NA)
      : u;
  }
  override atOffset(bar: number, n: number): Value {
    const k = Math.floor(n);
    return Number.isFinite(k) && k >= 0 ? this.at(bar - k) : NA;
  }
  override get(n: number): Value {
    const k = Math.floor(n);
    return Number.isFinite(k) && k >= 0 ? this.at(this.spec.ctx!.barIndex - k) : NA;
  }
  override cur(): Value {
    return this.at(this.spec.ctx!.barIndex);
  }
  /** `g := …` from a UDF body lands here — top-level writes replay via TfVarSeries. */
  override setAt(_bar: number, _v: Value): void {
    warnOnce(this.spec, this.spec.ctx!,
      `request.security: '${this.name} := …' writes inside function bodies are not replayed in the security context`);
  }
  override set(v: Value): void {
    this.setAt(this.spec.ctx?.barIndex ?? 0, v);
  }
}

/**
 * tf-scope shadow for a top-level global that is `:=`-mutated: reads replay
 * the global's init + the ordered top-level write stmts (spec.varProg) per tf
 * bar into a shared `slot` — `g := g + 1` accumulates across tf bars like it
 * does on the chart. Writes from UDF bodies hit setAt: warned once, dropped.
 */
class TfVarSeries extends BarSeries {
  private readonly slot = new BarSeries();
  constructor(private spec: SecuritySpec, private name: string) {
    super(8);
    spec.varScope!.define(name, this.slot);
  }
  /** Run init + write replay for all mutated globals through tf bar j. */
  private ensure(j: number): void {
    const spec = this.spec;
    const ctx = spec.ctx!;
    if (j <= spec.varUpto) return;
    advanceTo(spec, j);
    const prevBar = ctx.barIndex, prevAnchor = tfAnchor;
    tfAnchor = ctx;
    try {
      for (let b = spec.varUpto + 1; b <= j; b++) {
        ctx.barIndex = b;
        this.initBar(b);
        for (const stmt of spec.varProg) {
          try {
            evalHook(stmt, spec.varScope!, ctx);
          } catch (e) {
            warnOnce(spec, ctx,
              `request.security: global mutation replay failed${stmt.loc ? ` (line ${stmt.loc.line})` : ''}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        spec.varUpto = b;
      }
    } finally {
      ctx.barIndex = prevBar;
      tfAnchor = prevAnchor;
    }
  }
  /** Init pass for mutated globals: `var` decls at first bar only; decls that
   *  couldn't ride in varProg (tuple/`var` multi) re-init every bar. */
  private initBar(b: number): void {
    const spec = this.spec, ctx = spec.ctx!;
    for (const [n, d] of store.globals) {
      if (d.writes.length === 0) continue;
      if (d.once ? spec.varInited.has(n) : d.initInWrites) continue;
      if (!d.node) {
        warnOnce(spec, ctx,
          `request.security: '${n}' is declared inside a conditional branch — its init is not replayed`);
        if (d.once) spec.varInited.add(n);
        continue;
      }
      if (d.inBranch) {
        warnOnce(spec, ctx,
          `request.security: '${n}' is declared inside a conditional branch — its init replays unconditionally in the security context`);
      }
      try {
        const v = evalHook(d.node, spec.varScope!, ctx);
        const u = v.kind === 'series'
          ? (v.v instanceof BarSeries ? v.v.atOffset(b, 0) : v.v.cur())
          : v;
        const out = d.pick !== undefined ? (u.kind === 'array' ? u.v[d.pick] ?? NA : NA) : u;
        const slot = spec.varScope!.lookup(n);
        if (slot instanceof BarSeries) slot.setAt(b, out);
      } catch (e) {
        warnOnce(spec, ctx,
          `request.security: '${n}' init failed in security context: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (d.once) spec.varInited.add(n);
    }
  }
  private at(j: number): Value {
    if (!Number.isFinite(j) || j < 0) return NA;
    this.ensure(j);
    return this.slot.atOffset(j, 0);
  }
  override atOffset(bar: number, n: number): Value {
    const k = Math.floor(n);
    return Number.isFinite(k) && k >= 0 ? this.at(bar - k) : NA;
  }
  override get(n: number): Value {
    const k = Math.floor(n);
    return Number.isFinite(k) && k >= 0 ? this.at(this.spec.ctx!.barIndex - k) : NA;
  }
  override cur(): Value {
    return this.at(this.spec.ctx!.barIndex);
  }
  override setAt(_bar: number, _v: Value): void {
    warnOnce(this.spec, this.spec.ctx!,
      `request.security: '${this.name} := …' writes inside function bodies are not replayed in the security context`);
  }
  override set(v: Value): void {
    this.setAt(this.spec.ctx?.barIndex ?? 0, v);
  }
}

/**
 * Chart-frame view of a series-valued security() result. `evalAt` evaluates
 * `node` in the tf frame, where a plain ident resolves to a tf-domain
 * BarSeries whose history is indexed by tf bar. Returning that object
 * verbatim leaks it into the chart frame: `cur()`/`get(n)`/`ensureBar` then
 * anchor on tf `loaded`/`lastBar` while chart reads pass chart indexes —
 * corrupt under lookahead_on (lastBar already points past the mapped bar j)
 * and meaningless on security_lower_tf specs. Instead, wrap the source so the
 * chart sees a series whose `cur()` is the tf-bar-j value and whose `[n]`
 * reads chart-domain history (the previous chart bar's mapped value, per
 * TradingView semantics — not the previous tf bar). `atOffset`/`get` delegate
 * to `spec.chartHist`, which tryEvalSecurity fills once per chart bar.
 * Writes are dropped with a warning — a security() result is read-only.
 */
class SecSeries extends BarSeries {
  constructor(
    private spec: SecuritySpec,
    private src: Series,
    private j: number,
    /** src.size() captured at wrap time — lazy ctx-anchored series drift later. */
    private srcLen: number,
    /** The security() expression node this series came from (chartHist key). */
    private exprNode: Node,
    /** Callsite-composed caller identity — same node reached via two UDF
     *  callsites keeps separate chart histories (emit writes per callerKey). */
    private callerKey: object,
  ) { super(8); }
  /** Scalar the chart should see for absolute tf bar `k` (na before tf bar 0). */
  private atTf(k: number): Value {
    if (!Number.isFinite(k) || k < 0) return NA;
    const s = this.src;
    if (s instanceof BarSeries) return s.atOffset(k, 0);
    return this.srcLen > 0 ? s.get(this.srcLen - 1 - k) : NA; // non-absolute fallback
  }
  /** Chart-domain emit history for this (expr, caller callsite) — populated by tryEvalSecurity. */
  private chartHist(): BarSeries | undefined {
    return this.spec.chartHist?.get(this.exprNode)?.get(this.callerKey);
  }
  override atOffset(bar: number, n: number): Value {
    const h = this.chartHist();
    // Chart-domain history: `[n]` reads the mapped value n CHART bars back.
    // Falls back to tf-domain when no chart history exists (pre-warm calls).
    if (h) return h.atOffset(bar, n);
    const k = Math.floor(n);
    return Number.isFinite(k) && k >= 0 ? this.atTf(this.j - k) : NA;
  }
  override get(n: number): Value {
    const h = this.chartHist();
    if (h) return h.get(n);
    return this.atOffset(0, n);
  }
  override cur(): Value {
    return this.atTf(this.j);
  }
  override size(): number {
    return this.j + 1;
  }
  override setAt(_bar: number, _v: Value): void {
    warnOnce(this.spec, this.spec.ctx!,
      'request.security: writes to a security() result series are not supported — value ignored');
  }
  override set(v: Value): void {
    this.setAt(this.j, v);
  }
  override ensureBar(_bar: number): void { /* reads anchored on tf indexes; nothing to materialize */ }
  /** Shared-payload re-key: the caller-agnostic cache may hand one SecSeries
   *  to several callers — clone it anchored on the CURRENT caller's callsite
   *  so `[n]` reads that callsite's own chart history. */
  forCaller(callerKey: object): SecSeries {
    // Same-caller re-entry on a cached hit: this series already reads the live
    // callsite's chart history — skip the clone (keeps identity-keyed caches hot).
    if (callerKey === this.callerKey) return this;
    return new SecSeries(this.spec, this.src, this.j, this.srcLen, this.exprNode, callerKey);
  }
}

/**
 * tf→chart boundary adapter for evalAt results. `{kind:'series'}` becomes a
 * chart-anchored SecSeries (preserving `[n]` history access); `{kind:'array'}`
 * elements are aligned recursively so tuple-destructured members and
 * array-literal exprs behave like their single-expr counterparts.
 *
 * A BarSeries source (absolute atOffset indexing) is wrapped lazily. A lazy
 * non-BarSeries source (FnSeries, CalSeries — reads anchored on ctx.barIndex
 * and the newest-loaded tf slot) is snapshotted NOW, while ctx.barIndex === j
 * and spec.loaded === j + 1: deferring the read would silently shift which tf
 * bar `get(0)` resolves to.
 */
function alignToChart(spec: SecuritySpec, node: Node, v: Value, j: number): Value {
  if (v.kind === 'series') {
    let src = v.v;
    if (!(src instanceof BarSeries)) {
      const snap = new BarSeries();
      const len = src.size();
      for (let k = Math.max(0, j - len + 1); k <= j; k++) snap.setAt(k, src.get(len - 1 - k));
      src = snap;
    }
    return { kind: 'series', v: new SecSeries(spec, src, j, src.size(), node, spec.callerKey ?? spec.node) };
  }
  if (v.kind === 'array') return { kind: 'array', v: v.v.map(e => alignToChart(spec, node, e, j)) };
  return v;
}

/** Drop a spec's tf frame so the next ensureTfFrame rebuilds it (tf switched). */
function resetTfFrame(spec: SecuritySpec): void {
  spec.ctx = null;
  spec.scope = null;
  spec.pivot = null;
  spec.varScope = null;
  spec.series = {};
  spec.loaded = 0;
  spec.nodeCache.clear();
  spec.agnosticCache?.clear();        // agnosticSafe survives: gate verdicts are AST-level
  spec.durableCache = null;
  spec.seenCallers = new WeakSet();
  spec.lastEmit = undefined;
  spec.varProg = [];
  spec.varUpto = -1;
  spec.varInited.clear();
  spec.warmed = false;
  spec.chartHist = undefined;    // chart-domain history is tf-frame-scoped
  spec.lastChartBar = undefined;
}

/** Provider syminfo minus identity fields — those must reflect the
 *  requested symbol, not the chart's. */
const SYMINFO_IDENTITY = new Set(['ticker', 'tickerid', 'prefix', 'description']);
function syminfoSansIdentity(src: Record<string, Value>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(src)) if (!SYMINFO_IDENTITY.has(k)) out[k] = v;
  return out;
}

function ensureTfFrame(spec: SecuritySpec, frame: { scope: Scope; ctx: BuiltinCtx }): void {
  if (spec.ctx) return;
  const bars = spec.bars ?? [];
  const cap = Math.max(bars.length + 8, 64);
  const mk = () => { const b = new BarSeries(cap); tfOwned.add(b); return b; };
  const s: Record<string, BarSeries> = {
    open: mk(), high: mk(), low: mk(), close: mk(), volume: mk(), time: mk(),
    hl2: mk(), hlc3: mk(), ohlc4: mk(), hlcc4: mk(),
  };
  spec.series = s;
  // scope chain: tf shadows → pivot (live caller frame). Names not shadowed
  // here — e.g. a UDF param whose security() call site sits inside f's body —
  // resolve against the caller's scope this bar, not a stale first caller.
  spec.pivot = new PivotScope(spec);
  spec.scope = new Scope(spec.pivot);
  spec.varScope = new Scope(spec.scope);
  spec.varProg = store.varProg;
  for (const nm of SERIES_NAMES) spec.scope.define(nm, s[nm]!);
  // Shadow file-level globals/UDFs so references *nested* inside the security
  // expression (`g + 1`, UDF bodies) resolve in the tf context, not the chart's.
  for (const [name, def] of store.globals) {
    if ((SERIES_NAMES as readonly string[]).includes(name)) continue;
    spec.scope.define(name,
      def.writes.length > 0 ? new TfVarSeries(spec, name) : new TfGlobalSeries(spec, name, def));
  }
  for (const [name, decl] of store.funcs) {
    const f = decl as { params: Param[]; body: Node | Node[] };
    spec.scope.define(name, {
      kind: 'function',
      v: { name, params: f.params, body: f.body, closure: spec.scope },
    });
  }
  const parent = frame.ctx;
  const rt = resolvedTf(spec);
  const tf = rt === DYNAMIC ? parent.timeframe.period : rt;
  const reqSym = resolvedSym(spec);
  const tfSym = reqSym === DYNAMIC || reqSym === CHART_SYM
    ? (parent.syminfo.tickerid?.kind === 'string' ? parent.syminfo.tickerid.v : '')
    : reqSym;
  const { n: mult, unit } = tfParts(tf);
  const calendar = unit === 'D' || unit === 'W' || unit === 'M';
  spec.ctx = {
    barIndex: 0,
    barCount: bars.length,
    open: s.open!, high: s.high!, low: s.low!, close: s.close!,
    volume: s.volume!, time: s.time!, hl2: s.hl2!, hlc3: s.hlc3!,
    ohlc4: s.ohlc4!, hlcc4: s.hlcc4!,
    fetchSeries: parent.fetchSeries,
    plots: [],                                    // tf ctx never emits plots/drawings
    drawings: [],
    warnings: parent.warnings,
    alerts: parent.alerts,
    // syminfo.* inside security() refers to the REQUESTED symbol per TV
    // semantics — build it from resolved tf sym (F5). Carry parent's
    // provider overrides EXCEPT identity fields — context.ts:85 merges
    // overrides verbatim, so passing parent.syminfo wholesale would re-stamp
    // the chart's ticker/tickerid/prefix over the requested symbol's.
    syminfo: buildSyminfo(tfSym, syminfoSansIdentity(parent.syminfo)),
    timeframe: {
      period: tf, multiplier: mult,
      isseconds: unit === 'S',
      isminutes: !calendar,
      isdaily: unit === 'D',
      isweekly: unit === 'W',
      ismonthly: unit === 'M',
      isintraday: !calendar,
    },
    callUdf: (fn, args) => invokeUdf(spec, fn, args),
  };
}

/** Write tf bars `loaded..j` into the per-spec BarSeries at absolute index. */
function advanceTo(spec: SecuritySpec, j: number): void {
  const bars = spec.bars!;
  while (spec.loaded <= j && spec.loaded < bars.length) {
    const b = bars[spec.loaded]!;
    spec.series.open!.setAt(spec.loaded, mkVal(b.open));
    spec.series.high!.setAt(spec.loaded, mkVal(b.high));
    spec.series.low!.setAt(spec.loaded, mkVal(b.low));
    spec.series.close!.setAt(spec.loaded, mkVal(b.close));
    spec.series.volume!.setAt(spec.loaded, mkVal(b.volume));
    spec.series.time!.setAt(spec.loaded, mkVal(b.openTime));
    spec.series.hl2!.setAt(spec.loaded, mkVal((b.high + b.low) / 2));
    spec.series.hlc3!.setAt(spec.loaded, mkVal((b.high + b.low + b.close) / 3));
    spec.series.ohlc4!.setAt(spec.loaded, mkVal((b.open + b.high + b.low + b.close) / 4));
    spec.series.hlcc4!.setAt(spec.loaded, mkVal((b.high + b.low + b.close + b.close) / 4));
    spec.loaded++;
  }
}

/**
 * Copy-on-write param series — local mirror of the interpreter's private
 * CowSeries (it isn't exported; unlike ReturnSignal/BREAK/CONTINUE, which
 * moved to contracts.ts, it has no shared seam). Reads/`x[n]` see the caller's
 * history; the first `x := …` materializes a private BarSeries so the write
 * stays local to this call instead of mutating the caller's slot.
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

/**
 * UDF invocation from a tf-context builtin callback — mirrors the
 * interpreter's callUdfValue: `{kind:'series'}` args ALIAS the caller's slot
 * through a CowSeries — reads (incl. `p[1]` history) see the caller's real
 * series, while `p := …` inside the body materializes a private copy so the
 * write can't mutate the caller's slot. Scalars seed a fresh param slot at
 * the current tf bar, and a `return` in the body unwinds via ReturnSignal
 * (imported from contracts — shared so this injected module can
 * identity-check it). Escaping BREAK/CONTINUE are converted to
 * PineRuntimeError like callUdfValue; left raw, one would be absorbed as a
 * break by an enclosing `for` inside the same security expr and silently
 * truncate it (QA13).
 */
function invokeUdf(spec: SecuritySpec, fn: UdfDecl, args: Value[]): Value {
  const ctx = spec.ctx!;
  const callScope = new Scope(fn.closure ?? spec.scope!);
  fn.params.forEach((p, i) => {
    const a = args[i] ?? (p.default ? evalNode(p.default, spec, ctx.barIndex, callScope) : NA);
    if (a.kind === 'series') {
      callScope.define(p.name, new CowSeries(a.v));
    } else {
      const s = new BarSeries();
      s.setAt(ctx.barIndex, a);
      callScope.define(p.name, s);
    }
  });
  try {
    return Array.isArray(fn.body)
      ? blockHook(fn.body, callScope, ctx)
      : evalHook(fn.body, callScope, ctx);
  } catch (e) {
    if (e instanceof ReturnSignal) return e.value;
    // Loop-internal breaks are absorbed by evalFor/evalWhile/evalSwitch
    // before they reach here — a signal escaping the whole body is invalid
    // Pine (mirrors interpreter.ts callUdfValue, QA10/QA11/QA13).
    if (e === BREAK || e === CONTINUE) {
      throw new PineRuntimeError(
        `'${e === BREAK ? 'break' : 'continue'}' outside loop in function '${fn.name}'`,
      );
    }
    throw e;
  }
}

// ── per-node evaluation in tf frame ─────────────────────────────────────────

function warnOnce(spec: SecuritySpec, ctx: BuiltinCtx, msg: string): void {
  if (spec.warned.has(msg)) return;
  spec.warned.add(msg);
  ctx.warnings.push(msg);
}

/** Cache-key sentinel for evals that ran with no caller scope (shouldn't happen post-fix). */
const EMPTY_SCOPE = new Scope();

/** Perf-probe counters (baseline probe + bench test): evalAt cache miss/hit
 *  + agnostic gate verdicts (per expr node). */
export const __mtfStats = { evals: 0, hits: 0, gatePass: 0, gateFail: 0, agHits: 0, prodWalks: 0 };
// Browser QA reads these via window.__mtfStats (exposed once at module load).
try { (globalThis as Record<string, unknown>).__mtfStats = __mtfStats; } catch { /* non-DOM */ }

// ── caller-agnostic cache gate ──────────────────────────────────────────────
// A security expression is caller-agnostic only when every name it can reach
// resolves to a binding the tf frame owns: tf series shadows (SERIES_NAMES),
// shadowed file-level globals/UDFs (spec.scope via store.globals/store.funcs),
// local bindings (UDF params / block decls), or — STRICT_NAMESPACES off —
// builtin/context namespaces. `evalIdent` runs scope.lookup BEFORE the builtin
// fallback, so a caller-bound name (UDF param, block local) silently wins over
// both: any free ident reaching a caller binding makes the cache wrong.

/** Builtin shadowing is pathological; ON = refuse all non-S0/bound names. */
const STRICT_NAMESPACES = false;

/** Kinds that must never enter the caller-agnostic cache: sharing one mutable
 *  payload across callers lets one caller's writes leak into another's view.
 *  They still flow through per-caller/transient paths; only the shared write
 *  is skipped. */
const MUTABLE_KINDS: Partial<Record<PineType, true>> = {
  array: true, udt: true, map: true, matrix: true,
  line: true, label: true, box: true, table: true, polyline: true,
  linefill: true, function: true, void: true,
};

/** Names an ident may resolve to without consulting the caller scope: builtin
 *  namespaces + bare builtins + ctx-provided names. Populated lazily — mtf.ts
 *  is imported (as a registration side effect) before builtin modules finish
 *  registering, so reading the registries at module init would see them empty. */
let KNOWN_NAMES: Set<string> | null = null;
function builtinNames(): Set<string> {
  if (KNOWN_NAMES) return KNOWN_NAMES;
  const s = new Set<string>();
  for (const k of BUILTINS.keys()) s.add(k.split('.')[0]!);
  for (const k of CONSTANTS.keys()) s.add(k.split('.')[0]!);
  // evalIdent ctx specials + bare lazy constants (calendar vars like `hour`
  // register under '' which the dotted-key scan misses).
  for (const n of [
    'bar_index', 'last_bar_index', 'barstate', 'syminfo', 'timeframe',
    'hour', 'minute', 'second', 'dayofmonth', 'dayofweek', 'month', 'year',
    'barmerge', 'format', 'order', 'display', 'currency', 'location',
    'position', 'shape', 'extend', 'adjustment', 'data', 'session',
  ]) s.add(n);
  return (KNOWN_NAMES = s);
}

/** Initializer forms provably producing a NEW object per evaluation:
 *  `[…]` arraylit, `array.new*`, and `ns.new`/`T.new` constructors. The
 *  `T.new` form is accepted only when `T` isn't a bound name — a bound
 *  receiver is a real object method, not a namespace/UDT constructor
 *  (matches the call rule below). Anything else (ident, other calls, UDF
 *  calls — no return analysis) is NOT fresh: it may alias shared
 *  caller/persistent state (QA15 P2). */
function freshInit(v: Node | undefined, bound: Set<string>): boolean {
  if (!v) return false;
  if (v.type === 'arraylit') return true;
  if (v.type === 'call' && v.callee.type === 'member' && !v.callee.computed
      && v.callee.obj.type === 'ident' && !bound.has(v.callee.obj.name)) {
    const m = memberOf(v.callee)!;
    if (m.name === 'new' || (m.ns === 'array' && m.name.startsWith('new'))) return true;
  }
  return false;
}

/** Names a decl statement binds locally (sequential scoping: visible to later
 *  stmts in the same block only). `fresh` tracks bindings whose object is
 *  provably created inside this subtree — the only member/index `:=` roots
 *  that may pass. A non-var decl SHADOWS an outer var binding of the same
 *  name → it leaves varBound (P3); every binding drops stale freshness and
 *  re-earns it from its initializer. */
function addDeclNames(node: Node, out: Set<string>, varOut?: Set<string>, fresh?: Set<string>,
  rebound?: Set<string>, local?: Set<string>, escaped?: Set<string>): void {
  const n = node as {
    type: string; name?: string; names?: string[]; var?: boolean; value?: Node;
    multi?: { name: string; value?: Node }[];
  };
  const bind = (nm: string, isVar: boolean, init?: Node): void => {
    out.add(nm);
    if (isVar) varOut?.add(nm);
    else varOut?.delete(nm); // non-var local shadows an outer var name (P3)
    if (fresh) {
      if (!isVar && freshInit(init, out)) fresh.add(nm);
      else fresh.delete(nm);
    }
    // `=` re-decl is scope.define — a NEW local slot. A stale rebound mark
    // (from an earlier `u := …` reaching this slot) no longer applies to the
    // shadowing binding — but it DID write through to the outer slot, so it
    // moves to `escaped`: the child-scope merge must NOT let the shadow
    // swallow a rebound made before the re-decl (CR3 merge hole). `local`
    // records the name so the merge skips POST-shadow rebound marks (QA17).
    // A rebound made while the name already resolved scope-local (seed or
    // earlier shadow) dies with the slot — it does not escape.
    if (rebound?.has(nm) && !local?.has(nm)) escaped?.add(nm);
    rebound?.delete(nm);
    local?.add(nm);
  };
  if (n.type === 'func' || n.type === 'method') { if (n.name) bind(n.name, false); return; }
  // Tuple destructure (checked before isDeclType — 'tuple' isn't in that set):
  // `var [a,b] = …` names are persistent slots like any other var decl.
  if (n.type === 'tuple' && n.names) {
    for (const nm of n.names) bind(nm, !!n.var);
    return;
  }
  if (!isDeclType(n.type)) return;
  if (n.type === 'var' && n.multi) {
    for (const m of n.multi) bind(m.name, true);
    return;
  }
  if (!n.name) return;
  // `var` names join BOTH bound and varBound: reads resolve to the
  // callsite-keyed persistent slot (caller-independent → agnostic-safe)
  // while `:=` on them is shared non-idempotent state and must reject
  // (QA11). A var slot's object is persistent → never fresh.
  bind(n.name, n.type === 'var', n.value);
}


/**
 * Gate: may this expr's (node, j) result be shared across caller scopes?
 * Only names the tf scope shadows make a value caller-independent:
 * SERIES_NAMES, store.globals (resolved through their PRODUCER chain —
 * a global's value comes from re-evaluating its producer in the tf
 * context, so `q = () => y; y = p` leaks `p` through the alias unless
 * the whole chain walks clean), and store.funcs (UDF body walked with
 * bound = params ∪ body decls; param DEFAULTS walk with the call-site
 * bound since they evaluate at the caller). Locals of the gated subtree
 * and — STRICT_NAMESPACES off — known builtin names also pass.
 *
 * Producer/UDF walks share `inStack` (nodes on the current recursion
 * path → genuine cycles reject) while finished producer verdicts memo
 * into `spec.prodVerdicts` (shared across the spec's gated exprs) so DAG
 * sharing (`q() + q()`, `outer = inner`) never false-rejects. `reassign`
 * to a non-bound name writes caller or tf-visible state (order-dependent)
 * → unsafe; `:=` on a var-bound name mutates a persistent callsite-keyed
 * slot shared by all callers → unsafe (var names still join `bound` —
 * reads of the slot are caller-independent, only the count differs).
 * Member/index targets (`t.f := v`, `a[i] := v`) judge by their ROOT
 * ident — they mutate the object held by that binding, not the name:
 * pass only when the root ∈ `fresh`, i.e. bound in the same subtree by
 * a provably fresh initializer (`[…]`, `array.new*`, `ns.new`/`T.new`),
 * AND the target chain is single-level. Bound-but-not-fresh roots
 * (params, `u = a` aliases, for-in vars, var slots) may hold objects
 * shared with the caller → reject (QA15 P2). Deeper chains
 * (`u[0][0] :=`, `a.b.c :=`) also reject: a fresh container's ELEMENTS
 * may alias shared state (`u = [p]`), so depth ≥ 2 can reach shared
 * interior objects (H2).
 * `:=`-rebound fresh roots also reject: the write-through puts an unproven
 * (possibly shared) value in the slot, and the rebind persists after a
 * child block exits — `rebound` marks merge from arm copies upward unless
 * the arm re-declared the name (`=` shadows → arm-local slot) (QA17).
 * Decl-level constructs inside an expression (typedecl/import/indicator/
 * strategy) are rejected outright. Memoized per node into
 * spec.agnosticSafe — the verdict is AST-level and survives tf rebuilds.
 */
function exprSafeForAgnostic(spec: SecuritySpec, node: Node): boolean {
  const memo = spec.agnosticSafe ??= new Map();
  const hit = memo.get(node);
  if (hit !== undefined) return hit;
  const tfNames = new Set<string>(SERIES_NAMES);
  const known = STRICT_NAMESPACES ? new Set<string>() : builtinNames();
  // Recursion-stack keys for cycle detection (a second visit via DAG
  // sharing must NOT reject — only a node still being walked is a cycle).
  const inStack = new Set<object>();
  // Producer walks are path-independent (bound = ∅) — verdicts memo on the
  // SPEC so exprs of one security call share them (`q() + q()` splits into
  // two gated exprs reaching the same producer node). inStack stays
  // per-call: it is the live recursion stack.
  const prodVerdicts = spec.prodVerdicts ??= new Map<Node, boolean>();
  // Producer bodies bind nothing from the gated subtree. bound/varBound/
  // fresh stay empty for the whole walk (decls always bind into copies via
  // walkScoped/udfSafe/arrow), so ONE shared set is safe — but `rebound`
  // is mutated in place (reassign marks, addDeclNames deletes), so each
  // walk gets a fresh one or it would corrupt bound/varBound/fresh (CR1).
  const NO_BOUND = new Set<string>();

  /** Verdict for a member/index `:=` target (`t.f := v`, `a[i] := v`):
   *  the write mutates the OBJECT held by the root binding, so the root
   *  ident and the chain depth — not the target node itself — decide.
   *  Pass ONLY when the root is fresh: bound in this same subtree by a
   *  provably fresh initializer (`[…]`, `array.new*`, `T.new`). Every
   *  other binding may hold an object shared with the caller — a param is
   *  its argument, `u = a` aliases whatever `a` held, a `for c in arr`
   *  var is an element of arr — so member/index writes through them
   *  mutate shared state (QA15 P2). A fresh root that was `:=`-rebound
   *  may now hold a shared object (QA17). DEPTH LIMIT: single-level
   *  targets only — a fresh container's ELEMENTS may alias shared state
   *  (`u = [p]` — u fresh, element p caller-owned), so `u[i] :=` mutates
   *  only the container's own slot while `u[0][0] :=`/`a.b.c :=` can
   *  reach shared interior objects (H2). */
  const memberTargetSafe = (target: Node, fresh: Set<string>,
    rebound: Set<string>): boolean => {
    let root: Node = target, depth = 0;
    while (root.type === 'member' || root.type === 'histref') { root = root.obj; depth++; }
    return root.type === 'ident' && depth <= 1
      && fresh.has(root.name) && !rebound.has(root.name);
  };

  const walkBlock = (stmts: Node[] | Node, bound: Set<string>, varBound: Set<string>,
    fresh: Set<string>, rebound: Set<string>, local?: Set<string>,
    escaped?: Set<string>): boolean => {
    if (!Array.isArray(stmts)) return walk(stmts, bound, varBound, fresh, rebound);
    for (const s of stmts) {
      if (!walk(s, bound, varBound, fresh, rebound)) return false;
      // sequential: earlier decls bind for later stmts
      addDeclNames(s, bound, varBound, fresh, rebound, local, escaped);
    }
    return true;
  };
  /** Walk a child-block scope (if/switch arm, loop body, seq): the runtime
   *  scope is a CHILD of the current one, so `:=` on a name bound in the
   *  parent writes through to the parent's slot — the rebind persists after
   *  the block. On exit the child's rebound names merge upward, skipping
   *  names the child re-declared (`=` is scope.define → arm-local slot)
   *  and the seed names (params/loop vars shadow for the same reason) —
   *  EXCEPT rebound marks made BEFORE the shadowing decl: those wrote the
   *  parent slot and escape via `esc` (CR3). Rebound marks are never
   *  dropped from a fresh set: a rebound root can only re-earn freshness
   *  via a `=` re-decl (QA17). */
  const walkScoped = (stmts: Node[] | Node, bound: Set<string>, varBound: Set<string>,
    fresh: Set<string>, rebound: Set<string>, seed?: Iterable<string>): boolean => {
    const b2 = new Set(bound), v2 = new Set(varBound), f2 = new Set(fresh), r2 = new Set(rebound);
    const loc = new Set<string>(seed);
    const esc = new Set<string>();
    if (seed) for (const nm of seed) { v2.delete(nm); f2.delete(nm); r2.delete(nm); }
    const ok = walkBlock(stmts, b2, v2, f2, r2, loc, esc);
    for (const nm of r2) if (!loc.has(nm)) rebound.add(nm);
    for (const nm of esc) rebound.add(nm);
    return ok;
  };
  /** Seed a callee/param scope: each param binds in the body copy and
   *  shadows any outer var/fresh/rebound mark of the same name (QA15 P3,
   *  QA17) — a param is per-eval storage aliasing the caller's argument,
   *  so `p :=` writes the param slot and `p[i] :=` mutates shared state. */
  const seedParams = (params: Param[], b: Set<string>, vb: Set<string>,
    f: Set<string>, r: Set<string>): void => {
    for (const p of params) { b.add(p.name); vb.delete(p.name); f.delete(p.name); r.delete(p.name); }
  };
  /** Walk a store.funcs UDF: param DEFAULTS evaluate at the call site
   *  (caller bound set), while the body binds only its own params/decls.
   *  `inStack` keyed on the decl node cuts recursion — pushed BEFORE the
   *  defaults walk so `f = (x = f) => x` and `f ↔ g` default ping-pong
   *  terminate (reject) instead of overflowing the stack. */
  const udfSafe = (decl: Node, bound: Set<string>, varBound: Set<string>,
    fresh: Set<string>, rebound: Set<string>): boolean => {
    if (inStack.has(decl)) return false;
    inStack.add(decl);
    try {
      const d = decl as { params?: Param[]; body?: Node | Node[] };
      for (const p of d.params ?? []) {
        if (p.default && !walk(p.default, bound, varBound, fresh, rebound)) return false;
      }
      if (!d.body) return true;
      const b2 = new Set<string>(), vb2 = new Set<string>(), f2 = new Set<string>(),
        r2 = new Set(rebound);
      // Params are bound-but-never-fresh (seedParams). UDF bodies bind
      // isolated scopes, so their rebound marks never merge to the caller.
      seedParams(d.params ?? [], b2, vb2, f2, r2);
      return walkBlock(d.body, b2, vb2, f2, r2);
    } finally {
      inStack.delete(decl);
    }
  };

  /** Walk a store.globals producer chain, bound = ∅: reading a global
   *  re-evaluates its producer in the tf context, so every name it can
   *  reach must resolve the same way (`y = p` leaks the caller binding,
   *  `outer = inner` follows the alias). A `:=`-rewritten global can't be
   *  proven stable → false. Verdicts memoize; only on-stack nodes cycle. */
  const producerSafe = (name: string): boolean => {
    const def = store.globals.get(name)!;
    if (def.writes.length > 0 || !def.node) return false;
    const v = prodVerdicts.get(def.node);
    if (v !== undefined) return v;
    if (inStack.has(def.node)) return false;
    inStack.add(def.node);
    try {
      __mtfStats.prodWalks++;
      const ok = walk(def.node, NO_BOUND, NO_BOUND, NO_BOUND, new Set());
      prodVerdicts.set(def.node, ok);
      return ok;
    } finally {
      inStack.delete(def.node);
    }
  };

  const walk = (n: Node, bound: Set<string>, varBound: Set<string>, fresh: Set<string>,
    rebound: Set<string>): boolean => {
    switch (n.type) {
      case 'ident': {
        if (bound.has(n.name)) return true;
        // Global name: resolve through its producer — `y = p` and
        // `outer = inner` chains can't auto-pass on S0 membership alone.
        if (store.globals.has(n.name)) return producerSafe(n.name);
        // UDF name (callee or function value): scan defaults + body.
        if (store.funcs.has(n.name)) return udfSafe(store.funcs.get(n.name)!, bound, varBound, fresh, rebound);
        return tfNames.has(n.name) || known.has(n.name);
      }
      case 'call': {
        // Nested request.* calls evaluate in the caller's chart scope — their
        // specs/caches are caller-keyed, so the result is caller-dependent.
        if (n.callee.type === 'member'
            && n.callee.obj.type === 'ident' && n.callee.obj.name === 'request') return false;
        // A bound callee (param/local holding a function) runs with ITS OWN
        // closure — captured caller bindings make the result caller-dependent.
        if (n.callee.type === 'ident' && bound.has(n.callee.name)) return false;
        // Calling a method on a bound object reads caller-owned state.
        if (n.callee.type === 'member' && n.callee.obj.type === 'ident'
            && bound.has(n.callee.obj.name)) return false;
        // The callee resolves via the ident case: funcs → UDF walk,
        // globals → producer-chain walk (aliases never bare-pass).
        if (!walk(n.callee, bound, varBound, fresh, rebound)) return false;
        for (const a of n.args) if (!walk(a.value, bound, varBound, fresh, rebound)) return false;
        return true;
      }
      case 'func': case 'method': case 'arrow': {
        const b2 = new Set(bound), vb2 = new Set(varBound), f2 = new Set(fresh),
          r2 = new Set(rebound);
        // The body binds an isolated scope — rebound marks never merge
        // upward (walkBlock gets no local/escaped sets).
        seedParams(n.params, b2, vb2, f2, r2);
        for (const p of n.params) if (p.default && !walk(p.default, bound, varBound, fresh, rebound)) return false;
        return walkBlock(n.body, b2, vb2, f2, r2);
      }
      case 'reassign': {
        // `:=` on a var-bound name mutates a persistent callsite-keyed slot —
        // shared under the agnostic cache, non-idempotent per eval (QA11).
        // `:=` on a name not bound inside the gated subtree writes through the
        // caller pivot (or mutates a shared tf/global slot) → order-dependent.
        if (n.target.type === 'ident'
            && (varBound.has(n.target.name) || !bound.has(n.target.name))) return false;
        if ((n.target.type === 'member' || n.target.type === 'histref')
            && !memberTargetSafe(n.target, fresh, rebound)) return false;
        if (n.target.type === 'ident') {
          // Ident `:=` passed the gate, but the write-through rebinds the
          // name to an unproven value: mark it rebound so later member/index
          // targets on this root reject, and arm copies merge the mark upward
          // (the runtime rebind persists after the block). A `=` re-decl
          // clears it — scope.define creates a new local slot (QA17).
          rebound.add(n.target.name);
        }
        if (n.target.type !== 'ident' && !walk(n.target, bound, varBound, fresh, rebound)) return false;
        return walk(n.value, bound, varBound, fresh, rebound);
      }
      case 'if': case 'ifexpr': {
        if (!walk(n.test, bound, varBound, fresh, rebound)) return false;
        if (!walkScoped(n.then, bound, varBound, fresh, rebound)) return false;
        for (const e of n.elseIfs) {
          if (!walk(e.test, bound, varBound, fresh, rebound)) return false;
          if (!walkScoped(e.body, bound, varBound, fresh, rebound)) return false;
        }
        if (n.else && !walkScoped(n.else, bound, varBound, fresh, rebound)) return false;
        return true;
      }
      case 'for': {
        const from = n.from;
        // `for x in e` parses as from = Ident FOR_IN (a sentinel, not a name).
        if (!(from.type === 'ident' && from.name === FOR_IN) && !walk(from, bound, varBound, fresh, rebound)) return false;
        if (!walk(n.to, bound, varBound, fresh, rebound)) return false;
        if (n.step && !walk(n.step, bound, varBound, fresh, rebound)) return false;
        // A loop var re-bound as a non-var local shadows an outer `var`
        // name — `c :=` inside the loop writes the loop slot, not the var
        // slot, so it leaves varBound for this body (QA13 P3). It also
        // drops freshness: a `for c in arr` element aliases arr's storage
        // (QA15 P2). Loop-var rebound marks stay loop-local: seeding the
        // names skips them in the upward merge (QA17).
        const lvars = n.varName.split(',').filter(nm => nm);
        const inner = new Set(bound);
        for (const nm of lvars) inner.add(nm);   // `[a,b]` tuple loops
        return walkScoped(n.body, inner, varBound, fresh, rebound, lvars);
      }
      case 'while':
        if (!walk(n.test, bound, varBound, fresh, rebound)) return false;
        return walkScoped(n.body, bound, varBound, fresh, rebound);
      case 'switch': {
        if (n.subject && !walk(n.subject, bound, varBound, fresh, rebound)) return false;
        for (const c of n.cases) {
          if (c.test && !walk(c.test, bound, varBound, fresh, rebound)) return false;
          if (!walkScoped(c.body, bound, varBound, fresh, rebound)) return false;
        }
        return true;
      }
      case 'seq':
        return walkScoped(n.stmts, bound, varBound, fresh, rebound);
      case 'typedecl': case 'import': case 'indicator': case 'strategy':
        return false;
      default: {
        for (const c of astChildren(n)) if (!walk(c, bound, varBound, fresh, rebound)) return false;
        return true;
      }
    }
  };

  const safe = walk(node, new Set(), new Set(), new Set(), new Set());
  memo.set(node, safe);
  if (safe) __mtfStats.gatePass++; else __mtfStats.gateFail++;
  return safe;
}

/** Evaluate `node` at tf bar `j` inside spec's tf frame. Caller-agnostic exprs
 *  share one cache keyed (node, j); caller-dependent exprs keep the
 *  (node, caller scope, j) path — an ephemeral UDF frame can bind different
 *  params per invocation, so two callers must never share an entry. */
function evalAt(spec: SecuritySpec, node: Node, j: number): Value {
  // History before the first tf bar is na — never evaluate at a negative index
  // (advanceTo is a no-op there, leaving the ctx pointed at a stale bar).
  if (j < 0) return NA;
  const agnostic = exprSafeForAgnostic(spec, node);
  const caller = spec.callerScope ?? EMPTY_SCOPE;
  let v: Value;
  if (agnostic) {
    const m = spec.agnosticCache ??= new Map();
    const hit = m.get(node)?.get(j);
    if (hit !== undefined) {
      __mtfStats.hits++; __mtfStats.agHits++;
      // A shared SecSeries anchors its [n] reads on the callsite it was built
      // under — re-key to the live caller before returning (the payload itself
      // is write-proof: SecSeries.setAt drops mutations, so sharing is safe).
      if (hit.kind === 'series' && hit.v instanceof SecSeries) {
        return { kind: 'series', v: hit.v.forCaller(spec.callerKey ?? spec.node) };
      }
      return hit;
    }
    // Mutable results can't go into the shared cache — check the per-caller
    // entry first: a prior compute may already be cached under this caller.
    const pc = spec.nodeCache.get(node)?.get(caller)?.get(j);
    if (pc !== undefined) { __mtfStats.hits++; return pc; }
    v = computeAt(spec, node, j);
    if (!(v.kind in MUTABLE_KINDS)) {
      let by = m.get(node);
      if (!by) { by = new Map(); m.set(node, by); }
      by.set(j, v);
      return v;
    }
    // Mutable payload: skip only the SHARED agnostic write (sharing one
    // object across callers would leak mutations) — the per-caller write
    // below still caches (node, caller, j) as before.
  } else {
    const m = spec.nodeCache.get(node);
    const hit = m?.get(caller)?.get(j);
    if (hit !== undefined) { __mtfStats.hits++; return hit; }
    v = computeAt(spec, node, j);
  }
  let m = spec.nodeCache.get(node);
  let byCaller = m?.get(caller);
  if (!byCaller) {
    byCaller = new Map();
    if (!m) { m = new Map(); spec.nodeCache.set(node, m); }
    m.set(caller, byCaller);
  }
  byCaller.set(j, v);
  return v;
}

/** Uncached eval of `node` at tf bar `j` (both cache paths share this). */
function computeAt(spec: SecuritySpec, node: Node, j: number): Value {
  __mtfStats.evals++;
  advanceTo(spec, j);
  const prevBar = spec.ctx!.barIndex;
  const prevAnchor = tfAnchor;
  spec.ctx!.barIndex = j;
  tfAnchor = spec.ctx;
  let v: Value;
  try {
    v = alignToChart(spec, node, evalNode(node, spec, j), j);
  } catch (e) {
    // warn once per (message); `j` stays out of the text so a persistent
    // failure doesn't re-warn per bar, but the node's source loc keeps the
    // warning from silently masking a real bug.
    const loc = node.loc ? ` at line ${node.loc.line}, col ${node.loc.col}` : '';
    warnOnce(spec, spec.ctx!, `request.security eval error${loc}: ${e instanceof Error ? e.message : String(e)}`);
    v = NA;
  } finally {
    // Nested reads (global producers, histrefs, var replay) rebase ctx.barIndex
    // and tfAnchor; restore both so the caller's remaining subexpressions read
    // the intended tf bar.
    spec.ctx!.barIndex = prevBar;
    tfAnchor = prevAnchor;
  }
  return v;
}

function evalNode(node: Node, spec: SecuritySpec, _j: number, scope?: Scope): Value {
  // Globals/UDFs are shadowed in spec.scope (ensureTfFrame), so a plain
  // evaluation resolves nested references in the tf context.
  return evalHook(node, scope ?? spec.scope!, spec.ctx!);
}

// ── public per-bar entry ────────────────────────────────────────────────────


/**
 * Interpreter hook: call inside evalExpr's Call case BEFORE evaluating args.
 * Returns the security() value for this chart bar, or null when `node` is not
 * a request.security call (fall through to normal call handling).
 */
export function tryEvalSecurity(node: Node, frame: Frame): Value | null {
  if (node.type !== 'call' || !isSecurityCall(node)) return null;
  const spec = store.byNode.get(node);
  if (!spec) return NA; // not scanned (e.g. built dynamically) — graceful na
  const ctx = frame.ctx;

  // Resolve dynamic sym/tf lazily — must hit an already-fetched key because
  // fetchSeries is async and we're in a sync per-bar context.
  let sym = spec.sym, tf = spec.tf;
  if (sym === DYNAMIC || tf === DYNAMIC) {
    if (sym === DYNAMIC && spec.symNode) sym = runConst(spec.symNode, frame) ?? CHART_SYM;
    if (sym === CHART_SYM && ctx.syminfo?.tickerid?.kind === 'string') sym = ctx.syminfo.tickerid.v;
    if (tf === DYNAMIC && spec.tfNode) tf = runConst(spec.tfNode, frame) ?? ctx.timeframe.period;
    const bars = store.fetched.get(`${sym}\n${tf}`);
    if (!bars) {
      warnOnce(spec, ctx,
        `request.security: dynamic (symbol="${sym}", timeframe="${tf}") was not prefetched — returning na`);
      return NA;
    }
    if (spec.bars !== bars || spec.tfResolved !== tf) {
      // Dynamic tf/sym switched to a different series → drop the tf frame;
      // ensureTfFrame below rebuilds series/scope/caches against the new bars.
      spec.bars = bars;
      spec.tfResolved = tf;
      resetTfFrame(spec);
    }
  }

  const bars = spec.bars;
  if (!bars || bars.length === 0) return NA;
  // Rebind the tf scope's caller pivot to THIS invocation's frame — the same
  // call node may be evaluated inside different UDF call scopes, and the
  // expression must resolve params/locals against the live caller.
  spec.callerScope = frame.scope;
  spec.callerKey = callsiteKey(ctx, spec.node);
  ensureTfFrame(spec, frame);
  // Caller-agnostic caches live outside nodeCache so the seenCallers routing
  // swap below can't orphan them. They lazy-init at their consumers
  // (evalAt / exprSafeForAgnostic) — one owner each (CR1).
  // nodeCache routing: evalAt caches per (expr node, caller scope, tf bar).
  // The caller scope is the right key — an ephemeral UDF call scope binds
  // different params per invocation, so two callers must never share an
  // entry. But that also means an ephemeral key can NEVER hit on a later
  // bar (a fresh Scope is allocated per call), so retaining entries under it
  // only grows a dead WeakMap. Route evals through a per-invocation
  // transient map until the caller proves itself stable: a Scope object that
  // shows up a second time (the root scope, held by frame0 across bars, or a
  // long-lived harness scope) graduates to the durable cross-bar cache. The
  // first sighting keeps the transient map — entries under a caller may only
  // be reused by that same caller anyway.
  if (spec.seenCallers.has(frame.scope)) {
    if (!spec.durableCache) spec.durableCache = new Map();
    spec.nodeCache = spec.durableCache;
  } else {
    spec.seenCallers.add(frame.scope);
    spec.nodeCache = new Map();
  }

  // ── map chart bar → tf bar index ──
  const t0 = numOf(ctx.time.get(0));
  if (t0 === null) return NA;
  const chartPeriod = ctx.timeframe.period;
  const chartUnit = tfParts(chartPeriod).unit;
  const chartCalendar = chartUnit === 'D' || chartUnit === 'W' || chartUnit === 'M';
  // Nominal chart-bar duration — NEVER the actual t0−t1 spacing: weekend and
  // holiday gaps (Fri→Mon = 3d) would otherwise stretch the lower-tf window
  // and shift lookahead_on's bar pick onto the next tf bar.
  const chartDur = chartCalendar
    ? tfNext(tfFloor(t0, chartPeriod), chartPeriod) - tfFloor(t0, chartPeriod)
    : tfToMs(chartPeriod) ?? DAY;

  if (spec.isLtf) {
    // security_lower_tf: one array element per NOMINAL tf slot inside the
    // current chart bar [t0, t0+chartDur), oldest-first (Pine order: index 0 =
    // earliest lower bar). A slot with no tf bar emits na — the array length
    // is chartDur/ltfDur slots, not the count of bars that happen to exist.
    // Slots align to the tf's own grid (tfFloor), so a chart bar opening
    // mid-slot still produces that slot's cell.
    const end = t0 + chartDur;
    const lt = tfBarAtOrBefore(bars, t0);
    // First bar whose openTime lies inside the window — bars starting before
    // t0 (a sparse bar straddling the chart open) already emitted under the
    // previous chart bar and must not be repeated.
    let bi = lt >= 0 && bars[lt]!.openTime === t0 ? lt : lt + 1;
    // Last bar this window can reference: openTime < end.
    const lastIn = tfBarAtOrBefore(bars, end - 1);
    // Warm-up: a gated first call creates the frame mid-series — replay tf
    // bars 0..lastIn once so strict-window exprs (ta.sma needs L bars of real
    // history) see the same history an ungated run produced. nodeCache makes
    // each eval a one-shot; cost is the work an ungated run does anyway.
    if (!spec.warmed) {
      for (let w = 0; w <= lastIn; w++) for (const e of spec.exprs) evalAt(spec, e, w);
      spec.warmed = true;
    }
    // evalAt wraps series results in SecSeries for chart-anchored [n] access;
    // inside the array payload consumers read raw values, so unwrap to the
    // tf-bar-j2 scalar.
    const scalarAt = (e: Node, j2: number): Value => {
      const v = evalAt(spec, e, j2);
      return v.kind === 'series' ? v.v.cur() : v;
    };
    const out: Value[] = [];
    // bi advances monotonically while slots step forward → O(slots + bars).
    for (let slot = tfFloor(t0, tf); slot < end;) {
      const slotEnd = tfNext(slot, tf);
      if (slotEnd <= slot) break;            // unparseable tf — no progress
      if (slotEnd > t0) {                    // slots fully before t0 belong to the prior bar
        let j2 = -1;                         // last tf bar opening inside this slot
        const lim = Math.min(slotEnd, end);
        while (bi < bars.length && bars[bi]!.openTime < lim) j2 = bi++;
        out.push(
          j2 < 0 ? NA :
          spec.exprs.length === 1
            ? scalarAt(spec.exprs[0]!, j2)
            : { kind: 'array', v: spec.exprs.map(e => scalarAt(e, j2)) },
        );
      }
      slot = slotEnd;
    }
    return { kind: 'array', v: out };
  }

  let j: number;
  if (spec.lookahead === 'on') {
    // tf bar containing the chart bar's end (developing bar → future leak).
    j = tfBarAtOrBefore(bars, t0 + chartDur - 1);
  } else {
    // last tf bar COMPLETED at the chart bar's open time.
    const at = tfBarAtOrBefore(bars, t0);
    j = at >= 0 && tfBarEnd(bars, at, tf) <= t0 ? at : at - 1;
  }
  if (j < 0) return NA;

  // Record the emitted value into chart-domain history so `security(...)[n]`
  // on the chart reads the previous chart bar's mapped value (Pine semantics)
  // instead of reaching back into tf bars. gaps_on skipped bars emit NA — the
  // value TV produces there.
  // Per-callsite key computed above — UDF callsites of the same node each
  // keep their own emit history and dedup slot.
  const callerKey = spec.callerKey ?? spec.node;
  const emit = (e: Node, v: Value): void => {
    const hist = (spec.chartHist ??= new Map());
    let by = hist.get(e);
    if (!by) { by = new Map(); hist.set(e, by); }
    let s = by.get(callerKey);
    if (!s) { s = new BarSeries(); by.set(callerKey, s); }
    s.setAt(ctx.barIndex, v.kind === 'series' ? v.v.cur() : v);
  };
  const emitAll = (v: Value): void => {
    const last = (spec.lastChartBar ??= new Map());
    if (last.get(callerKey) === ctx.barIndex) return;   // dedup same-bar re-entry
    if (spec.exprs.length === 1) emit(spec.exprs[0]!, v);
    else {
      const arr = v.kind === 'array' ? v.v : [];
      spec.exprs.forEach((e, i) => emit(e, arr[i] ?? NA));
    }
    last.set(callerKey, ctx.barIndex);
  };

  if (spec.gaps === 'on') {
    // Per-callsite like lastChartBar: two UDF callsites of this node on the same
    // chart bar each own an emit slot — B must see the mapped value, not the na
    // that a spec-scoped dedup would force after A emitted.
    const emitted = (spec.lastEmit ??= new Map());
    if (emitted.get(callerKey) === j) {
      emitAll(NA);
      return NA;                                // only first chart bar per tf bar emits
    }
    emitted.set(callerKey, j);
  }

  // Same warm-up on the non-ltf path: replay tf bars 0..j on first hit.
  if (!spec.warmed) {
    for (let w = 0; w <= j; w++) for (const e of spec.exprs) evalAt(spec, e, w);
    spec.warmed = true;
  }

  const res = spec.exprs.length === 1
    ? evalAt(spec, spec.exprs[0]!, j)
    : { kind: 'array' as const, v: spec.exprs.map(e => evalAt(spec, e, j)) };
  emitAll(res);
  return res;
}


/** Evaluate a sym/tf arg at the current chart bar (dynamic resolution path). */
function runConst(node: Node, frame: Frame): string | null {
  // Ident whose top-level producer exists (input.timeframe/ternary/…) but
  // hasn't been bound into scope yet at prefetch time → evaluate the producer.
  const target = node.type === 'ident' && store.staticEnv.has(node.name)
    ? { type: 'str', v: store.staticEnv.get(node.name)! } as Node
    : node.type === 'ident' && store.globals.has(node.name)
    ? (store.globals.get(node.name)!.node ?? node)
    : node;
  try {
    const v = evalHook(target, frame.scope, frame.ctx);
    const u = v.kind === 'series' ? v.v.cur() : v;
    if (u.kind === 'string') return u.v;
    const n = numOf(u);
    return n !== null ? String(n) : null;
  } catch { return null; }
}


// ── interpreter registration seam ───────────────────────────────────────────
// interpreter.ts can't statically import this module (it keeps the dependency
// direction acyclic), so we register ourselves. `builtins/request.ts` imports
// mtf for this side effect; engine/tests should import builtins/index.

registerMtf({ tryEvalSecurity, prepareSecurity, prefetchSecurity });
