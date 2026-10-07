// ── Pine series storage ──────────────────────────────────────────────────────
// `Series` identity comes from contracts.ts — it has private fields, so TypeScript
// treats it nominally; every module must share that single class. We re-export it
// here and layer bar-aware storage (BarSeries) + helpers on top.

import { NA, Series, type Value } from './contracts';

export { Series };

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
 */
export class BarSeries extends Series {
  /** ring[0] = value at `lastBar`; ring[k] = value at `lastBar - k`. */
  private ring: Value[] = [];
  private capN: number;
  private lastBar = -1;

  constructor(cap = 5000) {
    super(cap);
    this.capN = cap;
  }

  /** Bar index of the newest written slot (-1 when empty). */
  get currentBar(): number {
    return this.lastBar;
  }

  /** Write (or same-bar overwrite) the value for absolute `bar`. */
  setAt(bar: number, v: Value): void {
    if (bar === this.lastBar) {
      if (this.ring.length === 0) this.ring.push(v);
      else this.ring[0] = v;
      return;
    }
    if (bar > this.lastBar) {
      // Carry-forward fill: bars lastBar+1 .. bar-1 keep the previous value.
      const fill = this.ring[0] ?? NA;
      for (let b = this.lastBar + 1; b < bar; b++) this.ring.unshift(fill);
      this.ring.unshift(v);
      this.lastBar = bar;
      if (this.ring.length > this.capN) this.ring.length = this.capN;
      return;
    }
    // Retro-write into already-recorded history (shouldn't happen in the
    // forward bar loop; tolerated for robustness).
    const k = this.lastBar - bar;
    if (k < this.ring.length) this.ring[k] = v;
  }

  /** Push the next bar's value (contract `set` semantics). */
  override set(v: Value): void {
    this.setAt(this.lastBar + 1, v);
  }

  /**
   * Value `n` bars before absolute `bar`. Bars newer than `lastBar` read as the
   * carried-forward newest value; targets before recorded history → na.
   */
  atOffset(bar: number, n: number): Value {
    const target = bar - Math.floor(n);
    if (target < 0 || n < 0) return NA;
    if (target >= this.lastBar) return this.ring[0] ?? NA;
    return this.ring[this.lastBar - target] ?? NA;
  }

  /**
   * Materialize entries through `bar` using carry-forward, so `get(n)` is
   * aligned when `lastBar === bar`. No-op when already at/past `bar`.
   */
  ensureBar(bar: number): void {
    if (bar <= this.lastBar) return;
    const fill = this.ring[0] ?? NA;
    for (let b = this.lastBar + 1; b <= bar; b++) this.ring.unshift(fill);
    this.lastBar = bar;
    if (this.ring.length > this.capN) this.ring.length = this.capN;
  }

  /** Read value `n` bars ago (relative to lastBar). OOR/non-integer → na. */
  override get(n: number): Value {
    const k = Math.floor(n);
    if (!Number.isFinite(k) || k < 0 || k >= this.ring.length) return NA;
    return this.ring[k] ?? NA;
  }

  override cur(): Value {
    return this.ring[0] ?? NA;
  }

  override size(): number {
    return this.ring.length;
  }
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
