// ── Pine series storage ──────────────────────────────────────────────────────
// `Series` identity comes from contracts.ts — it has private fields, so TypeScript
// treats it nominally; every module must share that single class. We re-export it
// here and layer bar-aware storage (BarSeries) + helpers on top.

import { NA, Series, type Value } from './contracts';

export { Series };

/**
 * Read-anchor hooks. `anchor(s)` = the absolute bar `s.get(0)` resolves to right
 * now; `touch(s)` mirrors the bookkeeping a write performs. Defaults are the
 * plain lastBar semantics; mtf.ts installs tf-aware versions (tfAnchor /
 * tfDirty) so frozen readers see exactly what a live `get(i)` would have.
 */
export const seriesHooks: {
  anchor: (s: BarSeries) => number;
  touch: (s: BarSeries) => void;
} = {
  anchor: (s) => s.currentBar,
  touch: () => {},
};

/**
 * Bar-aware series slot — one history entry per bar, indexed by absolute
 * bar_index. This is the slot every named variable should get (context series
 * included).
 *
 * Semantics layered on top of the contract `Series` API:
 * - `setAt(bar, v)` writes the value for an absolute bar. Writing the same bar
 *   twice *overwrites* (covers `x := e` and repeated assignments within one
 *   bar). Writing a later bar first back-fills skipped bars with the previous
 *   value — Pine `var` carry-forward: an unassigned `var x` keeps its last
 *   value on subsequent bars, and `x[1]` must see it.
 * - `set(v)` keeps contract semantics: push the next bar (≡ setAt(lastBar+1)).
 * - `atOffset(bar, n)` reads "value n bars before absolute `bar`" honoring
 *   carry-forward for bars never written (target ≥ lastBar → newest value).
 * - `ensureBar(bar)` materializes carry-forward entries up to `bar`, for hosts
 *   that want every slot's `lastBar === ctx.barIndex` at eval time.
 *
 * Storage is an append-only array (oldest → newest) behind a moving `head`:
 * ring index k (0 = newest) is `buf[buf.length - 1 - k]`. Writes are O(1)
 * amortized — a front-insert layout made every write O(history).
 */
export class BarSeries extends Series {
  protected buf: Value[] = [];
  protected head = 0;
  protected capN: number;
  protected lastBar = -1;

  constructor(cap = 5000) {
    super(cap);
    this.capN = cap;
  }

  /** Bar index of the newest written slot (-1 when empty). */
  get currentBar(): number {
    return this.lastBar;
  }

  /** Recorded history length. */
  protected rLen(): number {
    return this.buf.length - this.head;
  }

  /** Value at ring index k (0 = newest); undefined outside recorded history. */
  protected rAt(k: number): Value | undefined {
    return k >= 0 && k < this.buf.length - this.head ? this.buf[this.buf.length - 1 - k] : undefined;
  }

  /** Drop the oldest entries beyond `capN`; compact once the dead prefix dominates. */
  private trim(): void {
    const over = this.buf.length - this.head - this.capN;
    if (over > 0) this.head += over;
    if (this.head > 1024 && this.head * 2 > this.buf.length) {
      this.buf = this.buf.slice(this.head);
      this.head = 0;
    }
  }

  /** Write (or same-bar overwrite) the value for absolute `bar`. */
  setAt(bar: number, v: Value): void {
    if (bar === this.lastBar) {
      if (this.buf.length === this.head) this.buf.push(v);
      else this.buf[this.buf.length - 1] = v;
      return;
    }
    if (bar > this.lastBar) {
      // Carry-forward fill: bars lastBar+1 .. bar-1 keep the previous value.
      const fill = this.rAt(0) ?? NA;
      for (let b = this.lastBar + 1; b < bar; b++) this.buf.push(fill);
      this.buf.push(v);
      this.lastBar = bar;
      this.trim();
      return;
    }
    // Retro-write into already-recorded history (shouldn't happen in the
    // forward bar loop; tolerated for robustness).
    const k = this.lastBar - bar;
    if (k < this.buf.length - this.head) this.buf[this.buf.length - 1 - k] = v;
  }

  /** Push the next bar's value (contract `set` semantics). */
  override set(v: Value): void {
    this.setAt(this.lastBar + 1, v);
  }

  /**
   * Value `n` bars before absolute `bar`. Bars newer than `lastBar` read as the
   * carried-forward newest value; targets before recorded history → na.
   * Never patched — frozen readers use it to replay a captured anchor.
   */
  peek(bar: number, n: number): Value {
    const target = bar - Math.floor(n);
    if (target < 0 || n < 0) return NA;
    if (target >= this.lastBar) return this.rAt(0) ?? NA;
    return this.rAt(this.lastBar - target) ?? NA;
  }

  atOffset(bar: number, n: number): Value {
    return this.peek(bar, n);
  }

  /**
   * Materialize entries through `bar` using carry-forward, so `get(n)` is
   * aligned when `lastBar === bar`. No-op when already at/past `bar`.
   */
  ensureBar(bar: number): void {
    if (bar <= this.lastBar) return;
    const fill = this.rAt(0) ?? NA;
    for (let b = this.lastBar + 1; b <= bar; b++) this.buf.push(fill);
    this.lastBar = bar;
    this.trim();
  }

  /** Read value `n` bars ago (relative to lastBar). OOR/non-integer → na. */
  override get(n: number): Value {
    const k = Math.floor(n);
    if (!Number.isFinite(k) || k < 0 || k >= this.rLen()) return NA;
    return this.rAt(k) ?? NA;
  }

  override cur(): Value {
    return this.rAt(0) ?? NA;
  }

  override size(): number {
    return this.rLen();
  }
}
/**
 * Constant-history series for literal call args (`ta.sma(close, 20)`'s `20`).
 * A callHist BarSeries written the same literal every bar is observably just
 * `[lit, lit, lit, …]` — every reader (get/cur/peek/atOffset/size) sees `lit`
 * within [firstBar, lastBar] and `na` outside. LitSeries answers those reads
 * from the window bounds instead of a per-bar buffer write: `bump`/`setAt` of
 * the same literal only advance `lastBar`, `ensureBar` densifies in O(1).
 *
 * Only callers that write ONE fixed literal may use it (evalArg's num/bool
 * literal path goes through `bump`). A foreign-value `setAt`/`set`
 * (e.g. `x := v` on a name aliased to a LitSeries) materializes real storage
 * first — LiftedSeries pattern — so the slot degrades to plain BarSeries.
 */
export class LitSeries extends BarSeries {
  private lit: Value;
  private firstBar: number;
  /** false after materialize() — reads fall back to real buffer storage. */
  private virtual = true;

  constructor(lit: Value, bar: number, cap = 5000) {
    super(cap);
    this.lit = lit;
    this.firstBar = bar;
    this.lastBar = bar;
    seriesHooks.touch(this);
  }

  /** Same-literal touch (one call site, one literal): extend the window. */
  bump(bar: number): void {
    if (!this.virtual) { super.setAt(bar, this.lit); return; }
    if (bar > this.lastBar) this.lastBar = bar;
  }

  /** Virtual history length: one entry per bar in [firstBar, lastBar], capped. */
  protected override rLen(): number {
    if (!this.virtual) return super.rLen();
    return Math.min(this.lastBar - this.firstBar + 1, this.capN);
  }

  /** Every recorded slot holds the literal; outside the window → undefined. */
  protected override rAt(k: number): Value | undefined {
    if (!this.virtual) return super.rAt(k);
    return k >= 0 && k < this.rLen() ? this.lit : undefined;
  }

  /** Copy the virtual window into real storage, then plain BarSeries rules. */
  private materialize(): void {
    const n = this.rLen();
    const out = new Array<Value>(n);
    for (let k = 0; k < n; k++) out[n - 1 - k] = this.lit;
    this.buf = out;
    this.head = 0;
    this.virtual = false;
  }

  override setAt(bar: number, v: Value): void {
    if (this.virtual) {
      if (v === this.lit) { this.bump(bar); return; }
      this.materialize();
    }
    super.setAt(bar, v);
  }

  override ensureBar(bar: number): void {
    if (this.virtual) { this.bump(bar); return; }
    super.ensureBar(bar);
  }
}



/**
 * Lazily-evaluated result of a pointwise series kernel (nz, math.max, …).
 * Observably identical to the BarSeries an eager build would produce —
 * `len` entries `fn(len-1) … fn(0)` written oldest→newest ending at
 * `barIndex` (NA back-fill before that), or bars 0..len-1 when `len`
 * exceeds the elapsed bars — but entry k is computed only when read.
 *
 * `fn` must read its sources through anchors frozen at construction (see
 * `freezeReader`), and `v0` is `fn(0)` evaluated eagerly: a source's newest
 * bar can still be overwritten later in the same bar, older bars cannot.
 * Any write materializes the eager layout and falls back to plain storage.
 */
export class LiftedSeries extends BarSeries {
  private fn: ((k: number) => Value) | null;
  private len: number;
  private vLen: number;
  /** Carry-forward entries appended by ensureBar (ring index ≤ shift → fn(0)). */
  private shift = 0;
  private memo: Value[] = [];

  constructor(barIndex: number, len: number, fn: (k: number) => Value, v0: Value) {
    super();
    this.fn = fn;
    this.len = len;
    const base = barIndex - len + 1;
    this.lastBar = base < 0 ? len - 1 : barIndex;
    this.vLen = Math.min(base < 0 ? len : barIndex + 1, this.capN);
    this.memo[0] = v0;
    seriesHooks.touch(this);
  }

  private orig(k: number): Value {
    if (k >= this.len) return NA;
    let v = this.memo[k];
    if (v === undefined) {
      v = this.fn!(k);
      this.memo[k] = v;
    }
    return v;
  }

  protected override rLen(): number {
    return this.fn ? Math.min(this.vLen + this.shift, this.capN) : super.rLen();
  }

  protected override rAt(k: number): Value | undefined {
    if (!this.fn) return super.rAt(k);
    if (!(k >= 0 && k < Math.min(this.vLen + this.shift, this.capN))) return undefined;
    return k <= this.shift ? this.memo[0] : this.orig(k - this.shift);
  }

  private materialize(): void {
    const n = this.rLen();
    const out = new Array<Value>(n);
    for (let k = 0; k < n; k++) out[n - 1 - k] = this.rAt(k)!;
    this.fn = null;
    this.memo = [];
    this.buf = out;
    this.head = 0;
  }

  override setAt(bar: number, v: Value): void {
    if (this.fn) this.materialize();
    super.setAt(bar, v);
  }

  override ensureBar(bar: number): void {
    if (!this.fn) {
      super.ensureBar(bar);
      return;
    }
    if (bar <= this.lastBar) return;
    this.shift += bar - this.lastBar;
    this.lastBar = bar;
  }
}

/**
 * Series that a builtin's `seriesId`-keyed state (ta.* memo, vstate) should
 * treat as one logical series across bars. A pointwise expression evaluated at
 * the same call site every bar (e.g. `ta.ema(math.abs(src - src[1]), n)`)
 * yields a fresh series object per bar; without a shared identity each bar
 * restarted the ta state and recomputed the whole history (O(bars²)).
 * Keys are callsite-path strings minted by the interpreter.
 */
export const SERIES_IDENTITY = new WeakMap<Series, string>();

/**
 * Base for wrappers whose reads forward to another series (copy-on-write UDF
 * params). `readTarget()` is the series `get(i)` currently reads.
 */
export abstract class ForwardingSeries extends BarSeries {
  abstract readTarget(): Series;
}

/**
 * Freeze `s`'s current `get(i)` view: returns a reader that keeps answering
 * what `s.get(i)` answers now, even after `s` (or the eval anchor) moves on.
 * Null when `s` has no absolute storage to replay (computed series) — callers
 * must then evaluate eagerly.
 */
export function freezeReader(s: Series): ((i: number) => Value) | null {
  let t: Series = s;
  for (let hop = 0; hop < 8 && t instanceof ForwardingSeries; hop++) t = t.readTarget();
  if (!(t instanceof BarSeries)) return null;
  if (t.constructor !== BarSeries && !(t instanceof LiftedSeries) && !(t instanceof LitSeries)) return null;
  const bs = t;
  const a = seriesHooks.anchor(bs);
  return (i) => bs.peek(a, i);
}

/** Fresh BarSeries, optionally seeded with the current bar's value. */
export function mkSeries(seed?: Value, cap = 5000): BarSeries {
  const s = new BarSeries(cap);
  if (seed !== undefined) s.set(seed);
  return s;
}

/**
 * Build a BarSeries covering bars 0..uptoBar from a per-bar array
 * (`perBar[i]` = value at bar i). Missing slots are na. Used by MTF alignment
 * to wrap expression results evaluated on another timeframe.
 */
export function seriesWindow(perBar: Value[], uptoBar: number, cap = 5000): BarSeries {
  const s = new BarSeries(cap);
  for (let i = 0; i <= uptoBar && i < perBar.length; i++) s.setAt(i, perBar[i] ?? NA);
  return s;
}

function toIndex(n: Value | number): number | undefined {
  const raw = typeof n === 'number' ? n : n.kind === 'int' || n.kind === 'float' ? n.v : NaN;
  if (!Number.isFinite(raw)) return undefined;
  return Math.floor(raw);
}

/**
 * `expr[n]` read with Pine index semantics on any Series: na/non-numeric index
 * → na, fractional index floors (Pine series int), out-of-range → na.
 */
export function histGet(s: Series, n: Value | number): Value {
  const k = toIndex(n);
  if (k === undefined) return NA;
  return s.get(k);
}

/**
 * `expr[n]` read as of absolute `bar`. BarSeries honors carry-forward gaps;
 * plain Series falls back to `get`.
 */
export function histGetAt(s: Series, n: Value | number, bar: number): Value {
  const k = toIndex(n);
  if (k === undefined) return NA;
  if (s instanceof BarSeries) return s.atOffset(bar, k);
  return s.get(k);
}

/** Current-bar value as of absolute `bar` (carry-forward aware). */
export function valueAt(s: Series, bar: number): Value {
  return histGetAt(s, 0, bar);
}
