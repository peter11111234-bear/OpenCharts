// ── Pine interpreter shared contracts ──────────────────────────────────────
// Every agent codes against these types. DO NOT change shape without owner signoff.

// ── Values ──────────────────────────────────────────────────────────────────

/** Pine runtime value kinds (TradingView type lattice). */
export type PineType =
  | 'na' | 'int' | 'float' | 'bool' | 'string' | 'color'
  | 'line' | 'label' | 'box' | 'table' | 'polyline'
  | 'linefill' | 'array' | 'matrix' | 'map' | 'udt' | 'void' | 'series' | 'function';

/** Every Pine value. `na` is a real value (not undefined) — propagation is explicit. */
export type Value =
  | { kind: 'na' }
  | { kind: 'int' | 'float'; v: number }
  | { kind: 'bool'; v: boolean }
  | { kind: 'string'; v: string }
  | { kind: 'color'; v: string }            // normalized rgba() string
  | { kind: 'line' | 'label' | 'box' | 'table' | 'polyline' | 'linefill'; v: DrawObj }
  | { kind: 'array'; v: Value[] }
  | { kind: 'matrix'; v: Value[][] }
  | { kind: 'map'; v: Map<string, Value> }
  | { kind: 'udt'; v: UdtInstance }
  | { kind: 'function'; v: UdfDecl | BuiltinFn }
  | { kind: 'void' }
  | { kind: 'series'; v: Series };          // explicit series ref (rare, internal)

export const NA: Value = { kind: 'na' };
export const VTRUE: Value = { kind: 'bool', v: true };
export const VFALSE: Value = { kind: 'bool', v: false };

// ── control-flow signals (thrown by the evaluator; not errors) ──────────────
// Shared here so mtf.ts (injected via registerMtf, no interpreter import) can
// identity-check them instead of duck-typing symbol descriptions.
export const BREAK: unique symbol = Symbol('pine.break');
export const CONTINUE: unique symbol = Symbol('pine.continue');

/** Unwinds a UDF `return` to its callsite. */
export class ReturnSignal {
  constructor(readonly value: Value) {}
}

export interface DrawObj {
  id: number;
  // union of line/label/box/table fields; runtime narrows by `kind`
  kind: 'line' | 'label' | 'box' | 'table' | 'polyline' | 'linefill';
  props: Record<string, unknown>;
}

export interface UdtInstance {
  typeName: string;
  fields: Map<string, Value>;
}

// ── Series ──────────────────────────────────────────────────────────────────
// Pine semantics: every variable/expression is a time series. `x[n]` = value n bars back.
// Implementation: ring buffer indexed by absolute bar_index; history is per-bar.

export class Series {
  /** history[0] = current bar value after write; history[n] = n bars ago. */
  private hist: Value[] = [];
  private cap: number;

  constructor(cap = 5000) { this.cap = cap; }

  /** Write the current bar's value (call at bar end or on assignment). */
  set(v: Value): void {
    this.hist.unshift(v);
    if (this.hist.length > this.cap) this.hist.length = this.cap;
  }

  /** Read value n bars ago. Out of range → na. */
  get(n: number): Value {
    if (n < 0 || n >= this.hist.length) return NA;
    return this.hist[n]!;
  }

  /** Current value (same as get(0)). */
  cur(): Value { return this.hist[0] ?? NA; }

  /** Bars of recorded history (≤ bars elapsed). */
  size(): number { return this.hist.length; }
}

// ── AST ─────────────────────────────────────────────────────────────────────
// AST node union. `loc` = {line, col} for error reporting.

export type Node =
  | NumLit | StrLit | BoolLit | ColorLit | NaLit | Ident
  | Unary | Binary | Ternary | HistRef | Call | Member
  | ArrayLit | TupleAssign | Assign | Reassign
  | IfStmt | IfExpr | ForStmt | WhileStmt | SwitchStmt | Break | Continue
  | VarDecl | LetDecl | ConstDecl | TypedDecl
  | FuncDecl | ArrowFunc | MethodDecl | TypeDecl | FieldDecl
  | ImportDecl | ExportDecl
  | IndicatorDecl | StrategyDecl
  | StmtSeq | ReturnStmt;

interface Base {
  loc?: { line: number; col: number };
  /** Parser flattens `export X` into `X` with this flag so hoisting scans see
   *  the real decl type; semantics are identical (exports matter only to
   *  library packaging, which this interpreter doesn't model). */
  export?: boolean;
}

export interface NumLit extends Base { type: 'num'; v: number; isInt: boolean }
export interface StrLit extends Base { type: 'str'; v: string }
export interface BoolLit extends Base { type: 'bool'; v: boolean }
export interface ColorLit extends Base { type: 'color'; v: string }   // #RRGGBB / #RRGGBBAA
export interface NaLit extends Base { type: 'na' }
export interface Ident extends Base { type: 'ident'; name: string }
export interface Unary extends Base { type: 'unary'; op: string; arg: Node }
export interface Binary extends Base { type: 'binary'; op: string; left: Node; right: Node }
export interface Ternary extends Base { type: 'ternary'; test: Node; cons: Node; alt: Node }
/** `expr[n]` — history reference. `idx` may be any expr (evaluated at current bar). */
export interface HistRef extends Base { type: 'histref'; obj: Node; idx: Node }
/** `f(args)` — positional and/or named args. */
export interface Call extends Base { type: 'call'; callee: Node; args: Arg[] }
export interface Arg { name?: string; value: Node }
export interface Member extends Base { type: 'member'; obj: Node; prop: string; computed?: boolean }
export interface ArrayLit extends Base { type: 'arraylit'; items: Node[] }
/** `[a, b, c] = expr` */
export interface TupleAssign extends Base { type: 'tuple'; names: string[]; value: Node; /** `var [a,b] = f()` — each binding inits once and persists across bars. */ var?: boolean }
/** `x = expr` (declare) */
export interface Assign extends Base { type: 'assign'; name: string; typeAnn?: string; value: Node }
/** `x := expr` (reassign) */
export interface Reassign extends Base { type: 'reassign'; target: Node; value: Node }
export interface IfStmt extends Base { type: 'if'; test: Node; then: Node[]; elseIfs: { test: Node; body: Node[] }[]; else: Node[] | null }
/** `x = if cond ... else ...` — if as expression (returns last value of taken branch). */
export interface IfExpr extends Base { type: 'ifexpr'; test: Node; then: Node[]; elseIfs: { test: Node; body: Node[] }[]; else: Node[] | null }
export interface ForStmt extends Base { type: 'for'; varName: string; from: Node; to: Node; step?: Node; body: Node[] }
export interface WhileStmt extends Base { type: 'while'; test: Node; body: Node[] }
export interface SwitchStmt extends Base { type: 'switch'; subject?: Node; cases: { test?: Node; body: Node[] }[] }
export interface Break extends Base { type: 'break' }
export interface Continue extends Base { type: 'continue' }
/** `var x = e` — init once at bar 0. */
export interface VarDecl extends Base { type: 'var'; name: string; typeAnn?: string; value: Node; multi?: { name: string; typeAnn?: string; value: Node }[]; /** `varip` was used — interpreter should warn once that realtime semantics are approximated by `var`. */ varip?: boolean }
/** `x = e` at statement level is Assign; `let` same as Assign semantically. */
export interface LetDecl extends Base { type: 'let'; name: string; typeAnn?: string; value: Node }
export interface ConstDecl extends Base { type: 'const'; name: string; typeAnn?: string; value: Node }
export interface TypedDecl extends Base { type: 'typed'; ann: string; name: string; value?: Node }
/** `f(a, b) => body` — body is expr or block. */
export interface FuncDecl extends Base { type: 'func'; name: string; params: Param[]; body: Node | Node[] }
export interface ArrowFunc extends Base { type: 'arrow'; params: Param[]; body: Node | Node[] }
/** `method m(T self, args) => body` — dispatch by first param's type. */
export interface MethodDecl extends Base { type: 'method'; name: string; selfType: string; params: Param[]; body: Node | Node[] }
/** `type Name` + indented field lines. */
export interface TypeDecl extends Base { type: 'typedecl'; name: string; fields: FieldDecl[] }
export interface FieldDecl extends Base { type: 'field'; name: string; typeAnn: string; default?: Node }
export interface Param { name: string; typeAnn?: string; default?: Node }
export interface ImportDecl extends Base { type: 'import'; ns: string; name: string; alias?: string }
export interface ExportDecl extends Base { type: 'export'; decl: Node }
export interface IndicatorDecl extends Base { type: 'indicator'; args: Arg[] }
export interface StrategyDecl extends Base { type: 'strategy'; args: Arg[] }
export interface StmtSeq extends Base { type: 'seq'; stmts: Node[] }
export interface ReturnStmt extends Base { type: 'return'; value?: Node }

// ── Scope ───────────────────────────────────────────────────────────────────

export class Scope {
  private vars = new Map<string, Series | Value>();
  private parent?: Scope;

  constructor(parent?: Scope) { this.parent = parent; }

  /** `var` declaration → series slot; `let`/plain → also series (Pine semantics). */
  define(name: string, init: Series | Value): void {
    this.vars.set(name, init);
  }
  lookup(name: string): Series | Value | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }
  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false);
  }
}

// ── Builtins ────────────────────────────────────────────────────────────────

/** Runtime context passed to every builtin call, per bar. */
export interface BuiltinCtx {
  barIndex: number;
  barCount: number;
  open: Series; high: Series; low: Series; close: Series;
  volume: Series; time: Series; hl2: Series; hlc3: Series; ohlc4: Series; hlcc4: Series;
  /** `request.security` gateway — fetch (symbol, timeframe) bars aligned to chart. */
  fetchSeries?: (symbol: string, tf: string) => Promise<BarData[]>;
  /** Plot/draw sinks. */
  plots: PlotSink[];
  drawings: DrawSink[];
  warnings: string[];
  alerts: { id: string; msg: string }[];
  /** Symbol info (syminfo.*). */
  syminfo: Record<string, Value>;
  timeframe: { period: string; multiplier: number; isseconds: boolean; isminutes: boolean; isdaily: boolean; isweekly: boolean; ismonthly: boolean; isintraday: boolean };
  /** UDF call — evaluate user function with args at current bar. */
  callUdf: (fn: UdfDecl, args: Value[]) => Value;
}

export interface BarData { openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime?: number }

export interface PlotSink {
  /** Per-bar value to emit; engine buffers then aligns to bar time. */
  push(value: Value, opts: PlotOpts): void;
}

export interface PlotOpts {
  title?: string; color?: string; style?: string; linewidth?: number;
  overlay?: boolean; display?: string;
  /** Bars to shift the plot on the time axis (TV plot(offset=)). */
  offset?: number;
}

export interface DrawSink {
  create(kind: DrawObj['kind'], props: Record<string, unknown>): DrawObj;
  update(obj: DrawObj, props: Record<string, unknown>): void;
  remove(obj: DrawObj): void;
}

export type BuiltinFn = (ctx: BuiltinCtx, args: Value[], named: Record<string, Value>) => Value;

export interface UdfDecl {
  name: string;
  params: Param[];
  body: Node | Node[];
  closure: Scope;
  selfType?: string;  // method decl
}

// ── Interpreter result ──────────────────────────────────────────────────────

export interface RunResult {
  /** Named plot series: title → per-bar values + originating sink index.
   *  `colors` carries the per-bar `color=` opt (aligned to `values`) so
   *  conditional colors (`close>0 ? green : red`) survive to the model. */
  plots: Map<string, { index: number; time: number[]; values: Value[]; opts: PlotOpts; colors: (string | undefined)[] }>;
  /** Drawing objects alive at end. */
  drawings: DrawObj[];
  /** fill() descriptors; plot1/plot2 are plot-sink indexes (see `plots[].index`). */
  fills: { plot1: number; plot2: number; color?: string; title?: string; fillgaps?: boolean }[];
  /** bgcolor() per-bar colors, barIndex → (callsite → color). Each call site is a layer; na clears only its own layer. */
  bgcolors: Map<number, Map<string, string>>;
  /** barcolor() per-bar colors, barIndex → (callsite → color). */
  barcolors: Map<number, Map<string, string>>;
  /** Strategy order executions — buildModel maps to IndicatorModel.trades. */
  execs?: { bar: number; price: number; dir: number; kind: 'entry' | 'exit'; label?: string; qty: number; tradeId: number }[];
  alerts: { id: string; msg: string }[];
  /** Registered `alertcondition(...)` templates — Pine defines these at global
   *  scope for the Create-Alert dialog; the condition is evaluated later by the
   *  alert engine, so an entry is recorded once per title regardless of the
   *  condition's value. Kept separate from `alerts` (runtime `alert()` fires). */
  alertconditions: { title: string; msg: string }[];
  warnings: string[];
  /** Script-declared inputs (from input.* calls). */
  inputs: InputSchemaLite[];
  /** Declared props (indicator/strategy args). */
  props: InputSchemaLite[];
  title: string;
  shorttitle?: string;
  overlay: boolean;
}

export interface InputSchemaLite {
  id: string; name: string; type: string; defval: unknown;
  minval?: number; maxval?: number; step?: number;
  options?: unknown[]; group?: string; inline?: string; tooltip?: string;
}

// ── Vela ScriptingEngine port (from contributions-tjNExo1o.d.ts) ─────────────
// engine.ts must satisfy: { language, capabilities, prepare(source, id) → PreparedScript, execute(req, handlers) → ExecutionSession }
// Reuse Vela's types via `import type { ScriptingEngine } from '@luxalgo/vela'`.
