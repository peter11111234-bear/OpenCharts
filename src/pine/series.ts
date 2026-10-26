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
 * tfSeries) so frozen readers see exactly what a live `get(i)` would have.
 */
export const seriesHooks: {
  anchor: (s: BarSeries) => number;
  touch: (s: BarSeries) => void;
} = {
  anchor: (s) => s.currentBar,
  touch: () => {},
};

// ── incremental-eval rewind support ─────────────────────────────────────────
// A live session replays the forming bar on every tick from the last committed
// checkpoint. Every BarSeries born while a session's registry is installed
// joins that set; the incremental driver snapshots (incSnap) per committed bar
// and rewinds (incRewind) before each re-eval. See docs plan
// 2026-10-11-pine-incremental-live.md.

/** Per-series registry the owning session rewinds over. Installed only while
 *  that session evaluates — untracked runs never pay the Set.add. */
let activeSeriesSet: Set<BarSeries> | null = null;
export function setActiveSeriesSet(s: Set<BarSeries> | null): void {
  activeSeriesSet = s;
}

/** Series written since the last epoch bump. Installed and dropped exactly
 *  like `activeSeriesSet` (the owning session turns both on together), so
 *  untracked runs never pay the `markDirty` branch.
 *
 *  Why: a session's registry holds every series it ever built — for a script
 *  that allocates a handful of short-lived series per bar (CellSeries +
 *  LiftedSeries + CowSeries) that is ~40 objects per bar, so rewinding the
 *  whole set per tick is O(bars) work on state that the discarded eval never
 *  touched. Only series whose state actually changed since the checkpoint can
 *  differ from their snap; those are the ones a restore has to put back. */
///
/// One tracker PER SESSION: a worker interleaves several indicators' sessions
/// on one thread, and a shared list let session B's checkpoint/restore wipe
/// the marks session A's forming-bar eval left for A's next restore.
export interface DirtyTracker {
  /** Series written since the last epoch bump. Live — do not mutate. */
  list: BarSeries[];
  /** Monotone stamp — a series is listed at most once per epoch. */
  epoch: number;
}
export function newDirtyTracker(): DirtyTracker {
  return { list: [], epoch: 0 };
}
let dirtyTracker: DirtyTracker | null = null;

/** Install the evaluating session's tracker, or null between runs (mirrors
 *  `setActiveSeriesSet`). Uninstalling KEEPS the marks: they describe the
 *  eval that just ended, and that session's next restore still has to rewind
 *  it. `advanceDirtyEpoch` empties them. */
export function setDirtySeriesTracking(t: DirtyTracker | null): void {
  dirtyTracker = t;
}

/** Start a new epoch: everything written so far is accounted for (either
 *  snapshotted by a checkpoint or rewound by a restore). */
export function advanceDirtyEpoch(t: DirtyTracker): void {
  t.epoch++;
  t.list.length = 0;
}

/** State view of one series for the `incVerifyClean` restore assertion. */
export interface IncVerifyView {
  buf: readonly Value[];
  len: number;
  head: number;
  lastBar: number;
  firstBar: number;
  /** `LiftedSeries` memo length; -1 for classes without a lazy memo. */
  memoLen: number;
}

/** Opaque checkpoint payload for one series — produced by incSnap, consumed
 *  by incRewind on the SAME object. */
export interface IncSnap {
  lastBar: number;
  firstBar: number;
  head: number;
  buf: Value[];
  /** `buf.length` when the snapshot was taken. `buf` is stored by reference, so
   *  a later rewind cannot recover the length from the array itself — and after
   *  a sibling rewind has already truncated this series, the array behind the
   *  snapshot may still be the longer original. */
  len: number;
  /** Subclass state (virtual fn/memo/lit, CowSeries inner/cow). */
  x?: unknown;
}

/** LitSeries extra snap fields — the virtual-window flag. */
export interface LitSnapX { virtual: boolean }

/** CellSeries extra snap fields — the scalar current-value window. */
export interface CellSnapX { v: Value; n: number; virtual: boolean }

/** LiftedSeries extra snap fields — lazy-kernel state. `memoLen` feeds the
 *  `incVerifyClean` assertion only (a clean series must keep exactly the memo
 *  it had at snapshot time); incRewind ignores it. */
export interface LiftedSnapX {
  fn: ((k: number) => Value) | null;
  len: number;
  vLen: number;
  shift: number;
  memoLen: number;
}

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
  /** Logical start of the recorded window. Reads before it (and in the
   *  virtual leading-NA zone, bars < the bar of `buf[head]`) answer NA —
   *  identical to the NA backfill a fresh series used to materialize.
   *  LiftedSeries/LitSeries set it so `rLen` stays the logical count. */
  protected firstBar = 0;

  constructor(cap = 5000) {
    super(cap);
    this.capN = cap;
    if (activeSeriesSet) activeSeriesSet.add(this);
    // A series born between two checkpoints has no snap in the previous one, so
    // the incremental checkpoint must see it in the dirty list even if nothing
    // writes it: that is what makes the dirty list a complete "changed since
    // the last checkpoint" set without rescanning the whole registry.
    this.markDirty();
  }

  /** Set when any written Value is a mutable container (array/map/udt/
   *  matrix). The incremental driver deep-clones slot payloads only for
   *  flagged series — scalar-only series rewind by truncation alone. */
  hasContainers = false;

  /** Deepest history read ever seen (`rAt(k)` with the largest k), i.e. how far
   *  back the script can still reach into this series. The incremental driver
   *  narrows its container snapshot to that window. Monotone by design: it is
   *  an observation log, not state — never snapshotted, never rewound, and not
   *  zeroed by a null rewind (reads of a discarded tick still happened). */
  protected maxOff = 0;

  /** `len` of the most recent incSnap(). Snaps sharing one array only grow in
   *  length over time, so the newest one covers every entry the others do. */
  private snapLen = -1;

  /** Tracker + epoch this series was last listed under (null/-1 = never).
   *  Not part of the snapshotted state: it is a stamp, not a value. */
  private dirtyOwner: DirtyTracker | null = null;
  private dirtyMark = -1;

  /** Record that this series' state is about to change. Every write primitive
   *  calls this BEFORE mutating, so a restore that runs while the eval is
   *  abandoned still rewinds it. One load when tracking is off. */
  protected markDirty(): void {
    const t = dirtyTracker;
    if (t !== null && (this.dirtyMark !== t.epoch || this.dirtyOwner !== t)) {
      this.dirtyOwner = t;
      this.dirtyMark = t.epoch;
      t.list.push(this);
    }
  }

  /** Debug view for the `incVerifyClean` assertion in the interpreter's
   *  restoreCkpt — everything an incRewind could have put back. `memoLen` is
   *  -1 here; the classes that own a lazy memo override it. */
  incVerify(): IncVerifyView {
    return { buf: this.buf, len: this.buf.length, head: this.head, lastBar: this.lastBar, firstBar: this.firstBar, memoLen: -1 };
  }

  /** Checkpoint payload for the incremental driver. */
  incSnap(): IncSnap {
    this.snapLen = this.buf.length;
    return { lastBar: this.lastBar, firstBar: this.firstBar, head: this.head, buf: this.buf, len: this.buf.length };
  }

  /** Rewind to a snap taken on this object; a null snap resets to
   *  never-written (series born during the re-evaluated bar). Subclasses
   *  layer their private state onto `snap.x`.
   *
   *  `snap.buf` is held by reference and several snapshots can alias one array —
   *  the interpreter's `seriesSnaps` and the MTF store's per-spec snaps both
   *  cover tf-frame series. Rewinding in place would therefore destroy the other
   *  snapshot, and by the time the second one runs, `this.buf` may already have
   *  been replaced by a shorter slice while the snapshot still points at the
   *  longer original. On the non-null path below, the target entry count is
   *  `snap.len` (the length at snapshot time) and nothing else; the length is
   *  left alone when it already matches, so the append-only case stays
   *  allocation-free.
   *
   *  The common tick — the forming bar appended exactly one entry since the
   *  newest snap — pops that entry in place instead of copying the whole
   *  buffer. Popping is safe only for the newest snap on this very array: an
   *  older aliasing snap is never longer, so the popped entry is outside every
   *  snapshot. Anything else (an older snap, a replaced array, a larger
   *  overshoot) takes the copying path.
   *
   *  The `null` path still empties `this.buf` in place, so a snapshot aliasing
   *  that array loses its data with it — the same loss the old drop arithmetic
   *  had, kept deliberately to avoid a fresh array per born-this-bar series. */
  incRewind(snap: IncSnap | null): void {
    if (snap === null) {
      this.buf.length = 0;
      this.head = 0;
      this.lastBar = -1;
      this.firstBar = 0;
      this.hasContainers = false;
      return;
    }
    if (this.buf.length !== snap.len) {
      if (this.buf === snap.buf && snap.len === this.snapLen && this.buf.length === snap.len + 1 && snap.len >= this.head) this.buf.pop();
      else this.buf = snap.buf.slice(0, snap.len);
    }
    this.head = snap.head;
    this.lastBar = snap.lastBar;
    this.firstBar = snap.firstBar;
  }

  /** Absolute bar index recorded at buffer index `i` (head-adjusted). The
   *  incremental driver needs it to clone container payloads per bar. */
  incBarAt(i: number): number {
    return this.lastBar - (this.buf.length - 1 - i);
  }

  /** Internal buffer view for the incremental driver's container snapshot —
   *  index i records absolute bar incBarAt(i). Read-only use only. */
  get incBuf(): Value[] {
    return this.buf;
  }

  /** Deepest history read so far — the container-window bound (see `maxOff`). */
  get incMaxOff(): number {
    return this.maxOff;
  }

  /** Bar index of the newest written slot (-1 when empty). */
  get currentBar(): number {
    return this.lastBar;
  }

  /** Recorded history length (logical window: leading NA zone counts). */
  protected rLen(): number {
    return Math.min(this.lastBar - this.firstBar + 1, this.capN);
  }

  /** Value at ring index k (0 = newest); undefined outside recorded history. */
  protected rAt(k: number): Value | undefined {
    if (k > this.maxOff) this.maxOff = k;
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
    this.markDirty();
    if (!this.hasContainers) {
      const k = v.kind;
      if (k === 'array' || k === 'map' || k === 'matrix' || k === 'udt') this.hasContainers = true;
    }
    if (bar === this.lastBar) {
      if (this.buf.length === this.head) this.buf.push(v);
      else this.buf[this.buf.length - 1] = v;
      return;
    }
    if (bar > this.lastBar) {
      // Empty buffer: the gap is the leading virtual-NA zone — no fill needed
      // (reads answer NA there). Only a non-empty buffer must materialize the
      // carry-forward gap so buf[buf.length-1] stays aligned with lastBar and
      // a later same-bar overwrite writes the newest slot.
      if (this.buf.length !== this.head) {
        const fill = this.rAt(0) ?? NA;
        for (let b = this.lastBar + 1; b < bar; b++) this.buf.push(fill);
      }
      this.buf.push(v);
      this.lastBar = bar;
      this.trim();
      return;
    }
    // Retro-write into already-recorded history (shouldn't happen in the
    // forward bar loop; tolerated for robustness). Writes into the virtual
    // leading-NA zone are dropped — those bars read NA either way.
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
    this.markDirty();
    // Fresh series: nothing recorded to carry forward — advancing lastBar
    // makes the whole window virtual-NA without materializing bar+1 slots.
    if (this.buf.length === this.head) { this.lastBar = bar; return; }
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
    if (bar > this.lastBar) { this.markDirty(); this.lastBar = bar; }
  }

  /** Virtual history length: one entry per bar in [firstBar, lastBar], capped. */
  protected override rLen(): number {
    if (!this.virtual) return super.rLen();
    return Math.min(this.lastBar - this.firstBar + 1, this.capN);
  }

  /** Every recorded slot holds the literal; outside the window → undefined. */
  protected override rAt(k: number): Value | undefined {
    if (k > this.maxOff) this.maxOff = k;
    if (!this.virtual) return super.rAt(k);
    return k >= 0 && k < this.rLen() ? this.lit : undefined;
  }

  /** Copy the virtual window into real storage, then plain BarSeries rules. */
  private materialize(): void {
    this.markDirty();
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

  override incSnap(): IncSnap {
    const s = super.incSnap();
    s.x = { virtual: this.virtual };
    return s;
  }

  override incRewind(snap: IncSnap | null): void {
    super.incRewind(snap);
    // null = born inside the re-evaluated bar → back to the fresh virtual state.
    this.virtual = snap === null ? true : (snap.x as LitSnapX).virtual;
  }
}

/** Mutable payloads the incremental driver deep-clones per bar (kinds whose
 *  Value holds a reference). Mirrors BarSeries.setAt's own check. */
function isContainerValue(v: Value): boolean {
  const k = v.kind;
  return k === 'array' || k === 'map' || k === 'matrix' || k === 'udt';
}

/**
 * Current-value slot — the series `new BarSeries(); setAt(bar, v)` produces,
 * with no buffer to allocate or push through. `get(0)` is `v`, one entry per
 * elapsed bar is claimed (`size()`), every older offset answers na, and
 * carry-forward works exactly as the plain series' does. That is precisely the
 * shape of the two write-only sites the interpreter rebuilds per bar:
 * `for` variables (a fresh slot per loop iteration — the name is rebound each
 * iteration, so nothing outlives the bar) and UDF scalar params that are only
 * `:=`-written (bound fresh per call, never read for history).
 *
 * Invariant — virtual state ≡ the BarSeries it replaces: `buf = [v] * n`,
 * `head = 0`, `firstBar = 0`, `lastBar = writeBar`. Every inherited read
 * (`get`/`cur`/`peek`/`atOffset`/`size`, plus mtf's tf-anchoring overrides)
 * derives the same answers from the same two primitives, so only `rAt` (the
 * storage view) and the write paths need overrides.
 *
 * Why a `BarSeries` subclass at all: `evalReassign` requires
 * `slot instanceof BarSeries` (`x := e` on a loop var / param), `histGetAt`
 * routes BarSeries through `atOffset` (carry-forward), and `bindDeclared` only
 * aliases BarSeries slots — a bare `Series` would leak into the model as a
 * value. It is therefore also whitelisted by `freezeReader`; otherwise every
 * lazy kernel (`nz`, `math.sum`, …) reading the slot would drop to the eager
 * O(history) rebuild.
 *
 * Deliberate limits — each one a `materialize()` back to plain storage: a write
 * on a different bar (carry-forward fill / retro-write), a container payload
 * (the incremental driver deep-clones containers out of `incBuf`), a container
 * seed. A slot is thus either a scalar current-value cell or an ordinary
 * BarSeries, never a third thing.
 */
export class CellSeries extends BarSeries {
  /** Current value. `ensureBar` widens the window with copies of it. */
  private v: Value;
  /** Visible `v`-valued entries ≡ the replaced series' `buf.length - head`. */
  private n = 1;
  /** false once real storage exists — from then on everything is `super`'s. */
  private virtual = true;

  /** Bind `bar`'s value in one shot: the alloc+setAt pair the callers ran. */
  constructor(bar: number, v: Value) {
    super();
    this.v = v;
    this.lastBar = bar;
    seriesHooks.touch(this);
    // A container payload takes the same materialize path a foreign value
    // would, and must carry the deep-clone flag the real write sets: the
    // incremental driver only clones slots whose `hasContainers` is true.
    if (isContainerValue(v)) { this.materialize(); this.hasContainers = true; }
  }

  /** Copy the virtual window into real storage, then plain BarSeries rules. */
  private materialize(): void {
    this.markDirty();
    const out = new Array<Value>(this.n);
    out.fill(this.v);
    this.buf = out;
    this.head = 0;
    this.virtual = false;
  }

  /** Storage view: every visible entry holds the current value. */
  protected override rAt(k: number): Value | undefined {
    if (k > this.maxOff) this.maxOff = k;
    if (!this.virtual) return super.rAt(k);
    return k >= 0 && k < this.n ? this.v : undefined;
  }

  override setAt(bar: number, v: Value): void {
    if (this.virtual) {
      // Same-bar overwrite (the loop-var / param hot path) stays a scalar
      // store — but only while the window is the single newest entry: once
      // `ensureBar` widened it, the older copies are a *past* value and a
      // newest-slot write must not rewrite them. `touch` mirrors the
      // bookkeeping the write would have performed.
      if (bar === this.lastBar && this.n === 1 && !isContainerValue(v)) {
        this.markDirty();
        this.v = v;
        seriesHooks.touch(this);
        return;
      }
      this.materialize();
    }
    super.setAt(bar, v);
  }

  override ensureBar(bar: number): void {
    if (bar <= this.lastBar) return;
    if (!this.virtual) { super.ensureBar(bar); return; }
    this.markDirty();
    // Carry-forward repeats the one value: extend the window in O(1). n === 0
    // (rewound to never-written) keeps a virtual-na window, like an empty
    // buffer's — the whole span reads na either way.
    if (this.n > 0) this.n = Math.min(this.n + (bar - this.lastBar), this.capN);
    this.lastBar = bar;
  }

  override incSnap(): IncSnap {
    const s = super.incSnap();
    s.x = { v: this.v, n: this.n, virtual: this.virtual };
    return s;
  }

  override incRewind(snap: IncSnap | null): void {
    super.incRewind(snap);
    if (snap === null) {
      // Born inside the re-evaluated bar → never-written window (all reads na).
      // The object is unreachable after the rewind; the state only has to be
      // safe, not true.
      this.n = 0;
      this.virtual = true;
      return;
    }
    const x = snap.x as CellSnapX;
    this.v = x.v;
    this.n = x.n;
    this.virtual = x.virtual;
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
      // A memo entry IS state: it pins `fn(k)` (a source's value at a fixed
      // absolute bar). Writing one must therefore make the series dirty, or a
      // kept memo could outlive a discarded eval.
      this.markDirty();
      v = this.fn!(k);
      this.memo[k] = v;
    }
    return v;
  }

  protected override rLen(): number {
    return this.fn ? Math.min(this.vLen + this.shift, this.capN) : super.rLen();
  }

  protected override rAt(k: number): Value | undefined {
    if (k > this.maxOff) this.maxOff = k;
    if (!this.fn) return super.rAt(k);
    if (!(k >= 0 && k < Math.min(this.vLen + this.shift, this.capN))) return undefined;
    return k <= this.shift ? this.memo[0] : this.orig(k - this.shift);
  }

  private materialize(): void {
    this.markDirty();
    const n = this.rLen();
    const out = new Array<Value>(n);
    for (let k = 0; k < n; k++) out[n - 1 - k] = this.rAt(k)!;
    this.fn = null;
    this.memo = [];
    this.buf = out;
    this.head = 0;
    // Materialized buf holds exactly n real entries with no leading-NA
    // backfill — anchor the logical window so base rLen stays n.
    this.firstBar = this.lastBar - n + 1;
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
    this.markDirty();
    this.shift += bar - this.lastBar;
    this.lastBar = bar;
  }

  override incSnap(): IncSnap {
    const s = super.incSnap();
    s.x = { fn: this.fn, len: this.len, vLen: this.vLen, shift: this.shift, memoLen: this.memo.length };
    return s;
  }

  override incVerify(): IncVerifyView {
    const s = super.incVerify();
    s.memoLen = this.memo.length;
    return s;
  }

  override incRewind(snap: IncSnap | null): void {
    super.incRewind(snap);
    if (snap === null) {
      // Born inside the re-evaluated bar → inert; the object is unreachable
      // after rewind anyway, so field values only need to be safe, not true.
      this.fn = null;
      this.len = 0;
      this.vLen = 0;
      this.shift = 0;
      this.memo = [];
      return;
    }
    const x = snap.x as LiftedSnapX;
    this.fn = x.fn;
    this.len = x.len;
    this.vLen = x.vLen;
    this.shift = x.shift;
    // Drop the lazy memo — replayed values must come through the sources'
    // rewound anchors, not entries cached during the discarded eval.
    this.memo = [];
  }
}


/**
 * Base for wrappers whose reads forward to another series (copy-on-write UDF
 * params). `readTarget()` is the series `get(i)` currently reads.
 *
 * `bind` is the *per-site identity anchor* contract (interpreter's `SiteSeries`,
 * interpreter.ts:404): an implementation declares it when the wrapper object
 * itself is created ONCE per call-arg site and merely re-pointed at each bar's
 * fresh series. Such a wrapper is the stable end of the chain — its
 * `readTarget()` churns every bar, which is exactly what `stableSeries` must
 * not follow. Wrappers re-created every bar (`CowSeries`, `input.source`
 * views) leave it undefined: their *target* is the stable end.
 */
export abstract class ForwardingSeries extends BarSeries {
  abstract readTarget(): Series;
  bind?(inner: BarSeries): void;
  /** Explicit marker for the classes that implement `bind`. `bind` alone is a
   *  duck test, and a duck test silently adopts any future class that happens to
   *  carry a `bind` for an unrelated purpose — `stableSeries` would then key a
   *  cross-bar memo on a churning object. Declaring this flag alongside `bind`
   *  keeps the pair honest: `SiteSeries` is the only implementor
   *  (interpreter.ts:404), and `stableSeries` reads this flag, not the method. */
  readonly siteAnchor?: true;
}

/** Bounded walk over a forwarding chain. `step` returns the next hop, or its
 *  own argument to end the walk. The 8-hop cap is the chain's only termination
 *  guard (a wrapper that forwards to itself, or an absurdly deep chain, stops
 *  instead of looping) — `freezeReader` and `stableSeries` share it. */
function walkForwarding(s: Series, step: (t: ForwardingSeries) => Series): Series {
  let t: Series = s;
  for (let hop = 0; hop < 8 && t instanceof ForwardingSeries; hop++) {
    const n = step(t);
    if (n === t) break;
    t = n;
  }
  return t;
}

/**
 * Identity anchor for an identity-keyed cache: **the stable end** of the
 * forwarding chain. Two wrapper families disagree about which end that is —
 * a wrapper re-created every bar (`CowSeries`, `input.source` views) must be
 * skipped in favour of its target, while a wrapper created once per site and
 * re-bound every bar (`SiteSeries`, via the `bind` contract above) must be
 * kept. Following `readTarget()` unconditionally gets one of them wrong in
 * each direction; this picks the end that is the same object across bars,
 * which is the only property a cross-bar memo may key on.
 *
 * Values are unaffected either way: reading through a wrapper is by definition
 * reading what it currently forwards to (`get`/`cur`/`size`/`atOffset` all
 * delegate), so both ends answer the same thing this bar. Cross-file contract:
 * a cache keyed on this result MUST stay stable across bars — that is what
 * `SiteSeries`/`stableArgSeries` (interpreter.ts:404/522) exist to provide,
 * and what ta.ts's `wring`/`vs`/`wvs` tables depend on.
 */
export function stableSeries(s: Series): Series {
  return walkForwarding(s, (t) => (t.siteAnchor === true ? t : t.readTarget()));
}

/** Structural shape of a live-anchor computed series: it carries its own
 *  BuiltinCtx (`ctx`), so `ctx.barIndex` is the bar its `get` is anchored on. */
interface LiveAnchor { ctx?: { barIndex?: unknown } }

/**
 * Live-anchor computed series — the non-`BarSeries` family that recomputes
 * `get(i)` from bar data instead of storing per-bar slots: ta.ts `FnSeries`
 * (bare `ta.tr`/`ta.obv`/`ta.wad`…) and time.ts `CalSeries` (bare `hour`…).
 * `get(i)` there means "i bars before the anchor *its own ctx* is on", which
 * moves with every bar — the opposite of a BarSeries slot, whose history is
 * absolute. Identified structurally and self-validating: the series carries
 * its BuiltinCtx and claims one bar of history per elapsed ctx bar
 * (`size() === ctx.barIndex + 1`). A hist-backed `Series` carries no ctx, and
 * any other subclass failing either half is left to the eager path (null).
 * Returns that ctx — the anchor is `ctx.barIndex` *live*, never a constant.
 */
function liveAnchorCtx(s: Series): { barIndex: number } | null {
  const c = (s as Series & LiveAnchor).ctx;
  const b = c?.barIndex;
  if (typeof b !== 'number' || !Number.isInteger(b) || b < 0) return null;
  return s.size() === b + 1 ? (c as { barIndex: number }) : null;
}

/**
 * Freeze `s`'s current `get(i)` view: returns a reader that keeps answering
 * what `s.get(i)` answers now, even after `s` (or the eval anchor) moves on.
 * Null when `s` has no replayable view — callers must then evaluate eagerly.
 */
export function freezeReader(s: Series): ((i: number) => Value) | null {
  const t = walkForwarding(s, (w) => w.readTarget());
  if (!(t instanceof BarSeries)) {
    // Pin the anchor `a` and re-map every read by how far the anchor has moved
    // since, so `r(i)` keeps answering bar `a - i`: exactly what `get(i)`
    // answered when the reader was frozen. `get(n)` is "n bars before the live
    // anchor" by definition, so the re-mapping is exact for every offset whose
    // target bar is not ahead of the live anchor — including the out-of-window
    // offsets a rolling kernel reads past its own length.
    const c = liveAnchorCtx(t);
    if (c === null) return null;
    const a = c.barIndex;
    // `max(0,…)` mirrors `peek`'s carry-forward: inside a bar loop the anchor
    // only moves forward (mtf re-anchors nested reads at the tf bar instead of
    // rewinding the series), so the argument stays ≥ 0; the clamp only keeps a
    // rewound/foreign anchor from asking a stateful source (ta.obv/ta.wad) for
    // a bar it has not reached — a negative offset there would memoize garbage.
    return (i) => { const n = i + c.barIndex - a; return t.get(n > 0 ? n : 0); };
  }
  // BarSeries subclasses with REAL per-bar storage are replayable by `peek`;
  // anything else (a forwarding/foreign wrapper) must be left to the eager path.
  if (t.constructor !== BarSeries
      && !(t instanceof LitSeries) && !(t instanceof LiftedSeries) && !(t instanceof CellSeries)) return null;
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
