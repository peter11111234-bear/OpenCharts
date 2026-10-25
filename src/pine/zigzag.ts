// Self-implemented ZigZag. The TradingView ZigZag library source is not available,
// so this is our own pure-function state machine; it is NOT guaranteed to behave
// like TradingView's. Pure: no imports, no interpreter/contracts/libStubs coupling.
//
// Consumers only read `.start`/`.end`/`.price`/`.time`; `bar` is kept for tests and
// future use.

export interface ZigZagPoint {
  time: number;
  price: number;
  bar: number;
}

export interface ZigZagPivot {
  start: ZigZagPoint;
  end: ZigZagPoint;
}

export interface ZigZagBar {
  index: number;
  high: number;
  low: number;
  time: number;
}

/** -1 = current leg is down, 0 = no leg established yet, 1 = current leg is up. */
type Direction = -1 | 0 | 1;

interface ZigZagSnapshot {
  dir: Direction;
  pivots: ZigZagPoint[];
  hi: ZigZagPoint | null;
  lo: ZigZagPoint | null;
  /** Lowest low since `hi` (inclusive of the current bar). */
  minSinceHi: ZigZagPoint | null;
  /** Highest high since `lo` (inclusive of the current bar). */
  maxSinceLo: ZigZagPoint | null;
  lastIndex: number;
}

export interface ZigZagState extends ZigZagSnapshot {
  /** State before the bar currently being processed; used to rewind on replay. */
  snapshot: ZigZagSnapshot | null;
}

const point = (price: number, time: number, bar: number): ZigZagPoint => ({ price, time, bar });

const clonePoint = (p: ZigZagPoint): ZigZagPoint => ({ price: p.price, time: p.time, bar: p.bar });

const clonePoints = (ps: ZigZagPoint[]): ZigZagPoint[] => ps.map(clonePoint);

export function createZigZagState(): ZigZagState {
  return {
    dir: 0,
    pivots: [],
    hi: null,
    lo: null,
    minSinceHi: null,
    maxSinceLo: null,
    lastIndex: -1,
    snapshot: null,
  };
}

const takeSnapshot = (s: ZigZagState): ZigZagSnapshot => ({
  dir: s.dir,
  pivots: clonePoints(s.pivots),
  hi: s.hi ? clonePoint(s.hi) : null,
  lo: s.lo ? clonePoint(s.lo) : null,
  minSinceHi: s.minSinceHi ? clonePoint(s.minSinceHi) : null,
  maxSinceLo: s.maxSinceLo ? clonePoint(s.maxSinceLo) : null,
  lastIndex: s.lastIndex,
});

const applySnapshot = (s: ZigZagState, snap: ZigZagSnapshot): void => {
  s.dir = snap.dir;
  s.pivots = clonePoints(snap.pivots);
  s.hi = snap.hi ? clonePoint(snap.hi) : null;
  s.lo = snap.lo ? clonePoint(snap.lo) : null;
  s.minSinceHi = snap.minSinceHi ? clonePoint(snap.minSinceHi) : null;
  s.maxSinceLo = snap.maxSinceLo ? clonePoint(snap.maxSinceLo) : null;
  s.lastIndex = snap.lastIndex;
};

const isDevFinite = (devPct: number | undefined): devPct is number =>
  devPct !== undefined && Number.isFinite(devPct);

/**
 * Process one bar (closed or still forming).
 * @returns true iff this bar newly confirmed a pivot.
 */
export function zigZagStep(
  state: ZigZagState,
  bar: ZigZagBar,
  devPct: number | undefined,
  depth: number,
): boolean {
  const n = bar.index;

  // Replaying the bar already processed: rewind and redo it from the same input.
  if (state.lastIndex >= 0 && n === state.lastIndex && state.snapshot) {
    applySnapshot(state, state.snapshot);
  }
  if (n < state.lastIndex) throw new Error('zigzag: bar index went backwards');

  state.snapshot = takeSnapshot(state);
  state.lastIndex = n;

  const finite = isDevFinite(devPct);

  if (state.dir === 0) {
    let hi = state.hi;
    let lo = state.lo;
    if (hi === null || lo === null) {
      // First bar: seed both extremes from this bar.
      hi = point(bar.high, bar.time, n);
      lo = point(bar.low, bar.time, n);
      state.minSinceHi = point(bar.low, bar.time, n);
      state.maxSinceLo = point(bar.high, bar.time, n);
    } else {
      // Keep the since-extreme trackers running across bars: a leg may be
      // confirmed later, and it must see every low/high since its extreme.
      if (bar.high > hi.price) {
        hi = point(bar.high, bar.time, n);
        state.minSinceHi = point(bar.low, bar.time, n);
      } else if (state.minSinceHi === null || bar.low < state.minSinceHi.price) {
        state.minSinceHi = point(bar.low, bar.time, n);
      }
      if (bar.low < lo.price) {
        lo = point(bar.low, bar.time, n);
        state.maxSinceLo = point(bar.high, bar.time, n);
      } else if (state.maxSinceLo === null || bar.high > state.maxSinceLo.price) {
        state.maxSinceLo = point(bar.high, bar.time, n);
      }
    }
    state.hi = hi;
    state.lo = lo;

    // A leg needs two distinct bars: at the very first bar `hi` and `lo` come from
    // the same bar, so confirming there would emit a zero-length pivot and then a
    // bogus re-confirmation once `depth` elapsed.
    if (
      finite &&
      lo.price > 0 &&
      hi.bar !== lo.bar &&
      ((hi.price - lo.price) / lo.price) * 100 >= devPct
    ) {
      if (lo.bar < hi.bar) {
        // Low came first: the up leg starts from `lo`, `hi` is its running extreme.
        state.pivots.push(clonePoint(lo));
        state.dir = 1;
      } else {
        state.pivots.push(clonePoint(hi));
        state.dir = -1;
      }
      return true;
    }
    return false;
  }

  if (state.dir === 1) {
    const hi = state.hi;
    if (hi === null) return false;

    if (bar.high > hi.price) {
      const next = point(bar.high, bar.time, n);
      state.hi = next;
      state.minSinceHi = point(bar.low, bar.time, n);
      return false;
    }

    const min = state.minSinceHi;
    if (min === null || bar.low < min.price) state.minSinceHi = point(bar.low, bar.time, n);
    const tracked = state.minSinceHi!;

    if (
      finite &&
      hi.price > 0 &&
      ((hi.price - tracked.price) / hi.price) * 100 >= devPct &&
      n - hi.bar >= depth
    ) {
      state.pivots.push(clonePoint(hi));
      state.dir = -1;
      state.lo = clonePoint(tracked);
      state.maxSinceLo = point(bar.high, bar.time, n);
      return true;
    }
    return false;
  }

  const lo = state.lo;
  if (lo === null) return false;

  if (bar.low < lo.price) {
    const next = point(bar.low, bar.time, n);
    state.lo = next;
    state.maxSinceLo = point(bar.high, bar.time, n);
    return false;
  }

  const max = state.maxSinceLo;
  if (max === null || bar.high > max.price) state.maxSinceLo = point(bar.high, bar.time, n);
  const tracked = state.maxSinceLo!;

  if (
    finite &&
    lo.price > 0 &&
    ((tracked.price - lo.price) / lo.price) * 100 >= devPct &&
    n - lo.bar >= depth
  ) {
    state.pivots.push(clonePoint(lo));
    state.dir = 1;
    state.hi = clonePoint(tracked);
    state.minSinceHi = point(bar.low, bar.time, n);
    return true;
  }
  return false;
}

/** The two most recently confirmed pivots, `start` earlier than `end`. Copies. */
export function zigZagLastPivot(state: ZigZagState): ZigZagPivot | undefined {
  const len = state.pivots.length;
  if (len < 2) return undefined;
  const start = state.pivots[len - 2]!;
  const end = state.pivots[len - 1]!;
  return { start: clonePoint(start), end: clonePoint(end) };
}
