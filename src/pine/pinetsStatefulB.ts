// ── PineTS ported ta methods — STATEFUL B tier ───────────────────────────────
// 21 methods: max, mfi, min, nvi, obv, pvi, pvt, range, rci, rising, rma, roc,
// sar, stoch, swma, tsi, valuewhen, vwap, wad, wma, wpr.
// Bodies are verbatim-adapted from pinets-src (AGPL-3.0-only); `Source:` comments
// carry the upstream path. Series = PtSeries; state via context.taState with the
// committed/tentative + lastIdx pattern.
//
// Inlined upstream helpers (not in the facade):
//   - isNa               (namespaces/ta/utils/nonNaWindow.ts:3)
//   - barState           (namespaces/ta/utils/naAware.ts:16-34)
//   - consecutiveMoves   (namespaces/ta/utils/naAware.ts:44-66)
//   - getDatePartsInTimezone (namespaces/Time.ts:33-113)
//   - hlc3 PtSeries      (facade data lacks hlc3; vwap bare form builds a
//                         read-through series over ctx.data.{high,low,close})

import {
  PtSeries as Series,
  registerPtSlice,
  type PineTsCtx,
  type PtFactory,
  type PtSlice,
} from './pinetsShim';
import { PineRuntimeError } from './errors';

// Source: pinets-src/src/namespaces/ta/utils/nonNaWindow.ts:3
const isNa = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

// Source: pinets-src/src/namespaces/ta/utils/naAware.ts:16-34 (verbatim).
interface PtBarState<T> { lastIdx: number; shared: boolean; prev: T & { callIdx: number }; current: T & { callIdx: number }; }
function barState<T extends { callIdx: number }>(context: PineTsCtx, key: string | undefined, init: () => T): PtBarState<T> | undefined {
  if (!key) return undefined;
  if (!context.taState) context.taState = {};
  let state = context.taState[key] as PtBarState<T> | undefined;
  if (!state) state = context.taState[key] = { lastIdx: -1, shared: false, prev: init(), current: init() } as PtBarState<T>;
  if (context.idx > state.lastIdx) {
    if (state.lastIdx >= 0) state.prev = { ...state.current };
    state.lastIdx = context.idx;
  } else if (state.current.callIdx === context.idx) {
    state.shared = true;
  }
  return state.shared ? undefined : state;
}

// Source: pinets-src/src/namespaces/ta/utils/naAware.ts:44-66 (verbatim).
function consecutiveMoves(context: PineTsCtx, key: string | undefined, series: Series, length: number, up: boolean): boolean {
  const moved = (a: number, b: number) => (up ? a > b : a < b);
  const state = barState(context, key, () => ({ count: 0, callIdx: -1, length: NaN }));

  let count: number;
  if (state && state.prev.callIdx === context.idx - 1 && state.prev.length === length) {
    const a = series.get(0) as number;
    const b = series.get(1) as number;
    count = isNa(a) || isNa(b) ? state.prev.count : moved(a, b) ? state.prev.count + 1 : 0;
  } else {
    count = 0;
    for (let j = 0; j < context.idx && count < length; j++) {
      const a = series.get(j) as number;
      const b = series.get(j + 1) as number;
      if (isNa(a) || isNa(b)) continue;
      if (!moved(a, b)) break;
      count++;
    }
  }

  if (state) state.current = { count, callIdx: context.idx, length };
  return count >= length;
}

// Source: pinets-src/src/namespaces/Time.ts:33-113 (verbatim; used by vwap's
// session-reset detection).
interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
}
function getDatePartsInTimezone(timestamp: number, timezone: string): DateParts {
  const tzNorm = timezone.trim();

  if (tzNorm === 'UTC' || tzNorm === 'GMT' || tzNorm === 'Etc/UTC') {
    const d = new Date(timestamp);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      dayOfWeek: d.getUTCDay(),
    };
  }

  const offsetMatch = tzNorm.match(/^(?:UTC|GMT)([+-])(\d{1,2})(?::(\d{2}))?$/i);
  if (offsetMatch) {
    const sign = offsetMatch[1] === '+' ? 1 : -1;
    const offsetHours = parseInt(offsetMatch[2]!, 10);
    const offsetMinutes = parseInt(offsetMatch[3] || '0', 10);
    const totalOffsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60 * 1000;
    const d = new Date(timestamp + totalOffsetMs);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      dayOfWeek: d.getUTCDay(),
    };
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(timestamp));
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value || '0', 10);

    let hour = get('hour');
    if (hour === 24) hour = 0;

    const weekdayStr = parts.find((p) => p.type === 'weekday')?.value || 'Sun';
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour,
      minute: get('minute'),
      second: get('second'),
      dayOfWeek: dayMap[weekdayStr] ?? 0,
    };
  } catch {
    const d = new Date(timestamp);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      dayOfWeek: d.getUTCDay(),
    };
  }
}

// ── Ported methods ──────────────────────────────────────────────────────────

// Source: pinets-src/src/namespaces/ta/methods/max.ts:22-62 (verbatim body).
function ptMax(context: PineTsCtx) {
  return (source: unknown, _callId?: string) => {
    if (!context.taState) context.taState = {};
    const stateKey = _callId || 'max';

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevMax: NaN,
        currentMax: NaN,
      };
    }

    const state = context.taState[stateKey] as { lastIdx: number; prevMax: number; currentMax: number };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevMax = state.currentMax;
      }
      state.lastIdx = context.idx;
    }

    const currentValue = Series.from(source).get(0) as number;

    let result: number;
    if (isNaN(currentValue)) {
      result = state.prevMax;
    } else if (isNaN(state.prevMax)) {
      result = currentValue;
    } else {
      result = Math.max(state.prevMax, currentValue);
    }

    state.currentMax = result;
    return context.precision(result);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/mfi.ts:23-146 (verbatim body).
function ptMfi(context: PineTsCtx) {
  return (source: unknown, _length: unknown, _callId?: string) => {
    const length = Series.from(_length).get(0) as number;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `mfi_${length}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevUpperWindow: [] as number[],
        prevLowerWindow: [] as number[],
        prevUpperSum: 0,
        prevLowerSum: 0,
        currentUpperWindow: [] as number[],
        currentLowerWindow: [] as number[],
        currentUpperSum: 0,
        currentLowerSum: 0,
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number;
      prevUpperWindow: number[]; prevLowerWindow: number[];
      prevUpperSum: number; prevLowerSum: number;
      currentUpperWindow: number[]; currentLowerWindow: number[];
      currentUpperSum: number; currentLowerSum: number;
    };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevUpperWindow = [...state.currentUpperWindow];
        state.prevLowerWindow = [...state.currentLowerWindow];
        state.prevUpperSum = state.currentUpperSum;
        state.prevLowerSum = state.currentLowerSum;
      }
      state.lastIdx = context.idx;
    }

    const currentSrc = Series.from(source).get(0) as number;
    const previousSrc = Series.from(source).get(1) as number;
    const volume = context.get(context.data.volume, 0) as number;

    if (isNaN(currentSrc) || isNaN(volume)) {
      return NaN;
    }

    const change = isNaN(previousSrc) ? NaN : currentSrc - previousSrc;

    const upperComponent = volume * (change <= 0 ? 0 : currentSrc);
    const lowerComponent = volume * (change >= 0 ? 0 : currentSrc);

    const upperWindow = [...state.prevUpperWindow];
    const lowerWindow = [...state.prevLowerWindow];
    let upperSum = state.prevUpperSum;
    let lowerSum = state.prevLowerSum;

    upperWindow.unshift(upperComponent);
    lowerWindow.unshift(lowerComponent);
    upperSum += upperComponent;
    lowerSum += lowerComponent;

    if (upperWindow.length < length) {
      state.currentUpperWindow = upperWindow;
      state.currentLowerWindow = lowerWindow;
      state.currentUpperSum = upperSum;
      state.currentLowerSum = lowerSum;
      return NaN;
    }

    if (upperWindow.length > length) {
      const oldUpper = upperWindow.pop()!;
      const oldLower = lowerWindow.pop()!;
      upperSum -= oldUpper;
      lowerSum -= oldLower;
    }

    state.currentUpperWindow = upperWindow;
    state.currentLowerWindow = lowerWindow;
    state.currentUpperSum = upperSum;
    state.currentLowerSum = lowerSum;

    if (lowerSum === 0) {
      if (upperSum === 0) {
        return context.precision(100);
      }
      return context.precision(100);
    }

    if (upperSum === 0) {
      return context.precision(0);
    }

    const mfi = 100.0 - 100.0 / (1.0 + upperSum / lowerSum);

    return context.precision(mfi);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/min.ts:22-62 (verbatim body).
function ptMin(context: PineTsCtx) {
  return (source: unknown, _callId?: string) => {
    if (!context.taState) context.taState = {};
    const stateKey = _callId || 'min';

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevMin: NaN,
        currentMin: NaN,
      };
    }

    const state = context.taState[stateKey] as { lastIdx: number; prevMin: number; currentMin: number };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevMin = state.currentMin;
      }
      state.lastIdx = context.idx;
    }

    const currentValue = Series.from(source).get(0) as number;

    let result: number;
    if (isNaN(currentValue)) {
      result = state.prevMin;
    } else if (isNaN(state.prevMin)) {
      result = currentValue;
    } else {
      result = Math.min(state.prevMin, currentValue);
    }

    state.currentMin = result;
    return context.precision(result);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/nvi.ts:12-62 (verbatim body).
function ptNvi(context: PineTsCtx) {
  return (_callId?: string) => {
    if (!context.taState) context.taState = {};
    const stateKey = _callId || 'nvi';

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        committedNVI: 1.0,
        tentativeNVI: 1.0,
      };
    }

    const state = context.taState[stateKey] as { lastIdx: number; committedNVI: number; tentativeNVI: number };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.committedNVI = state.tentativeNVI;
      }
      state.lastIdx = context.idx;
    }

    const close = context.get(context.data.close, 0) as number;
    const prevClose = context.get(context.data.close, 1) as number;
    const volume = context.get(context.data.volume, 0) as number;
    const prevVolume = context.get(context.data.volume, 1) as number;

    const c0 = isNaN(close) ? 0 : close;
    const c1 = isNaN(prevClose) ? 0 : prevClose;
    const v0 = isNaN(volume) ? 0 : volume;
    const v1 = isNaN(prevVolume) ? 0 : prevVolume;

    let currentNVI = state.committedNVI;

    if (c0 === 0 || c1 === 0) {
      // nvi remains the same
    } else {
      if (v0 < v1) {
        const change = (c0 - c1) / c1;
        currentNVI = currentNVI + change * currentNVI;
      }
    }

    state.tentativeNVI = currentNVI;

    return context.precision(currentNVI);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/obv.ts:20-76 (verbatim body).
function ptObv(context: PineTsCtx) {
  return (_callId?: string) => {
    if (!context.taState) context.taState = {};
    const stateKey = _callId || 'obv';

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        committedOBV: 0,
        tentativeOBV: 0,
      };
    }

    const state = context.taState[stateKey] as { lastIdx: number; committedOBV: number; tentativeOBV: number };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.committedOBV = state.tentativeOBV;
      }
      state.lastIdx = context.idx;
    }

    const close0 = context.get(context.data.close, 0) as number;
    const volume0 = context.get(context.data.volume, 0) as number;

    const close1 = context.get(context.data.close, 1) as number;

    if (isNaN(close1)) {
      state.tentativeOBV = 0;
      return context.precision(0);
    }

    let currentOBV = state.committedOBV;

    if (close0 > close1) {
      currentOBV += volume0;
    } else if (close0 < close1) {
      currentOBV -= volume0;
    } else {
      // Price unchanged: keep previous OBV
    }

    state.tentativeOBV = currentOBV;

    return context.precision(currentOBV);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/pvi.ts:12-62 (verbatim body).
function ptPvi(context: PineTsCtx) {
  return (_callId?: string) => {
    if (!context.taState) context.taState = {};
    const stateKey = _callId || 'pvi';

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        committedPVI: 1.0,
        tentativePVI: 1.0,
      };
    }

    const state = context.taState[stateKey] as { lastIdx: number; committedPVI: number; tentativePVI: number };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.committedPVI = state.tentativePVI;
      }
      state.lastIdx = context.idx;
    }

    const close = context.get(context.data.close, 0) as number;
    const prevClose = context.get(context.data.close, 1) as number;
    const volume = context.get(context.data.volume, 0) as number;
    const prevVolume = context.get(context.data.volume, 1) as number;

    const c0 = isNaN(close) ? 0 : close;
    const c1 = isNaN(prevClose) ? 0 : prevClose;
    const v0 = isNaN(volume) ? 0 : volume;
    const v1 = isNaN(prevVolume) ? 0 : prevVolume;

    let currentPVI = state.committedPVI;

    if (c0 === 0 || c1 === 0) {
      // pvi remains the same
    } else {
      if (v0 > v1) {
        const change = (c0 - c1) / c1;
        currentPVI = currentPVI + change * currentPVI;
      }
    }

    state.tentativePVI = currentPVI;

    return context.precision(currentPVI);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/pvt.ts:15-56 (verbatim body).
function ptPvt(context: PineTsCtx) {
  return (_callId?: string) => {
    if (!context.taState) context.taState = {};
    const stateKey = _callId || 'pvt';

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevCumulativeSum: 0,
        currentCumulativeSum: 0,
      };
    }

    const state = context.taState[stateKey] as { lastIdx: number; prevCumulativeSum: number; currentCumulativeSum: number };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevCumulativeSum = state.currentCumulativeSum;
      }
      state.lastIdx = context.idx;
    }

    const close = context.get(context.data.close, 0) as number;
    const prevClose = context.get(context.data.close, 1) as number;
    const volume = context.get(context.data.volume, 0) as number;

    let currentSum = state.prevCumulativeSum;

    if (!isNaN(close) && !isNaN(prevClose) && !isNaN(volume) && prevClose !== 0) {
      const term = ((close - prevClose) / prevClose) * volume;
      currentSum += term;
    }

    state.currentCumulativeSum = currentSum;

    return context.precision(currentSum);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/range.ts:16-84 (verbatim body).
function ptRange(context: PineTsCtx) {
  return (source: unknown, _length: unknown, _callId?: string) => {
    const length = Series.from(_length).get(0) as number;
    if (!(length >= 1)) return NaN;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `range_${length}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevWindow: [] as number[],
        prevCallCount: 0,
        currentWindow: [] as number[],
        currentCallCount: 0,
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number; prevWindow: number[]; prevCallCount: number;
      currentWindow: number[]; currentCallCount: number;
    };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevWindow = state.currentWindow;
        state.prevCallCount = state.currentCallCount;
      }
      state.lastIdx = context.idx;
    }

    const series = Series.from(source);

    const window = [...state.prevWindow];

    if (state.prevCallCount === 0) {
      for (let i = 1; i <= context.idx && window.length < length; i++) {
        const v = series.get(i) as number;
        if (!isNa(v)) window.unshift(v);
      }
    }

    const currentValue = series.get(0);
    if (!isNa(currentValue)) window.push(currentValue as number);
    while (window.length > length) window.shift();

    state.currentWindow = window;
    state.currentCallCount = state.prevCallCount + 1;

    if (window.length < length) {
      return NaN;
    }

    let max = Number.MIN_VALUE;
    let min = Infinity;
    for (const v of window) {
      if (v > max) max = v;
      if (v < min) min = v;
    }
    return context.precision(max - min);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/rci.ts:12-85 (verbatim body).
function ptRci(context: PineTsCtx) {
  return (source: unknown, _length: unknown, _callId?: string) => {
    const length = Series.from(_length).get(0) as number;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `rci_${length}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevWindow: [] as number[],
        prevCount: 0,
        currentWindow: [] as number[],
        currentCount: 0,
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number; prevWindow: number[]; prevCount: number;
      currentWindow: number[]; currentCount: number;
    };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevWindow = state.currentWindow;
        state.prevCount = state.currentCount;
      }
      state.lastIdx = context.idx;
    }

    const currentValue = Series.from(source).get(0);

    const window: number[] = state.prevWindow.slice();
    window.push(currentValue == null ? NaN : (currentValue as number));
    if (window.length > length) window.shift();
    state.currentWindow = window;
    state.currentCount = state.prevCount + 1;

    if (length < 2 || state.currentCount <= length || window.some((v) => Number.isNaN(v))) {
      return NaN;
    }

    const order = window.map((_, i) => i).sort((a, b) => window[a]! - window[b]!);
    const ranks = new Array<number>(length);
    for (let i = 0; i < length; ) {
      let j = i;
      while (j + 1 < length && window[order[j + 1]!] === window[order[i]!]) j++;
      const rank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[order[k]!] = rank;
      i = j + 1;
    }

    const mean = (length + 1) / 2;
    let cov = 0;
    let varX = 0;
    let varY = 0;
    for (let i = 0; i < length; i++) {
      const dx = i + 1 - mean;
      const dy = ranks[i]! - mean;
      cov += dx * dy;
      varX += dx * dx;
      varY += dy * dy;
    }
    if (varY === 0) return NaN;

    return context.precision((cov / Math.sqrt(varX * varY)) * 100);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/rising.ts:23-31 (verbatim body;
// consecutiveMoves inlined above from ta/utils/naAware.ts).
function ptRising(context: PineTsCtx) {
  return (source: unknown, _length: unknown, _callId?: string) => {
    const length = Series.from(_length).get(0) as number;
    const series = Series.from(source);

    return consecutiveMoves(context, _callId, series, length, true);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/rma.ts:5-83 (verbatim body).
function ptRma(context: PineTsCtx) {
  return (source: unknown, _period: unknown, _callId?: string) => {
    const period = Series.from(_period).get(0) as number;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `rma_${period}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevRma: null as number | null,
        prevInitSum: 0,
        prevInitCount: 0,
        currentRma: null as number | null,
        currentInitSum: 0,
        currentInitCount: 0,
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number;
      prevRma: number | null; prevInitSum: number; prevInitCount: number;
      currentRma: number | null; currentInitSum: number; currentInitCount: number;
    };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevRma = state.currentRma;
        state.prevInitSum = state.currentInitSum;
        state.prevInitCount = state.currentInitCount;
      }
      state.lastIdx = context.idx;
    }

    const currentValue = Series.from(source).get(0) as number;

    if (currentValue === null || currentValue === undefined || Number.isNaN(currentValue)) {
      state.currentRma = state.prevRma;
      state.currentInitSum = state.prevInitSum;
      state.currentInitCount = state.prevInitCount;
      return NaN;
    }

    const initCount = state.prevInitCount;
    let initSum = state.prevInitSum;
    const prevRma = state.prevRma;

    if (initCount < period) {
      initSum += currentValue;
      const newCount = initCount + 1;

      state.currentInitSum = initSum;
      state.currentInitCount = newCount;

      if (newCount === period) {
        const rma = initSum / period;
        state.currentRma = rma;
        return context.precision(rma);
      }
      return NaN;
    }

    const alpha = 1 / period;
    const rma = currentValue * alpha + prevRma! * (1 - alpha);

    state.currentRma = rma;

    return context.precision(rma);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/roc.ts:5-71 (verbatim body).
function ptRoc(context: PineTsCtx) {
  return (source: unknown, _length: unknown, _callId?: string) => {
    const length = Series.from(_length).get(0) as number;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `roc_${length}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevWindow: [] as number[],
        prevCallCount: 0,
        currentWindow: [] as number[],
        currentCallCount: 0,
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number; prevWindow: number[]; prevCallCount: number;
      currentWindow: number[]; currentCallCount: number;
    };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevWindow = [...state.currentWindow];
        state.prevCallCount = state.currentCallCount;
      }
      state.lastIdx = context.idx;
    }

    const currentValue = Series.from(source).get(0) as number;

    const window = [...state.prevWindow];

    window.unshift(currentValue);

    while (window.length > length + 1) {
      window.pop();
    }

    const callCount = state.prevCallCount + 1;
    if (window.length < length + 1 && (callCount >= length + 1 || context.idx >= length)) {
      const series = Series.from(source);
      while (window.length < length + 1) {
        window.push(series.get(window.length) as number);
      }
    }

    state.currentWindow = window;
    state.currentCallCount = callCount;

    if (window.length <= length) {
      return NaN;
    }

    const prevValue = window[length]!;
    const roc = ((currentValue - prevValue) / prevValue) * 100;
    return context.precision(roc);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/sar.ts:18-165 (verbatim body).
function ptSar(context: PineTsCtx) {
  return (_start: unknown, _inc: unknown, _max: unknown, _callId?: string) => {
    const start = Series.from(_start).get(0) as number;
    const inc = Series.from(_inc).get(0) as number;
    const max = Series.from(_max).get(0) as number;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `sar_${start}_${inc}_${max}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevResult: NaN,
        prevMaxMin: NaN,
        prevAcceleration: NaN,
        prevIsBelow: false,
        prevBarIndex: 0,
        currentResult: NaN,
        currentMaxMin: NaN,
        currentAcceleration: NaN,
        currentIsBelow: false,
        currentBarIndex: 0,
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number;
      prevResult: number; prevMaxMin: number; prevAcceleration: number;
      prevIsBelow: boolean; prevBarIndex: number;
      currentResult: number; currentMaxMin: number; currentAcceleration: number;
      currentIsBelow: boolean; currentBarIndex: number;
    };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevResult = state.currentResult;
        state.prevMaxMin = state.currentMaxMin;
        state.prevAcceleration = state.currentAcceleration;
        state.prevIsBelow = state.currentIsBelow;
        state.prevBarIndex = state.currentBarIndex;
      }
      state.lastIdx = context.idx;
    }

    let result = state.prevResult;
    let maxMin = state.prevMaxMin;
    let acceleration = state.prevAcceleration;
    let isBelow = state.prevIsBelow;
    let barIndex = state.prevBarIndex;

    const high = context.get(context.data.high, 0) as number;
    const low = context.get(context.data.low, 0) as number;
    const close = context.get(context.data.close, 0) as number;

    const prevClose = context.get(context.data.close, 1) as number;
    const prevHigh = context.get(context.data.high, 1) as number;
    const prevLow = context.get(context.data.low, 1) as number;
    const prevHigh2 = context.get(context.data.high, 2) as number;
    const prevLow2 = context.get(context.data.low, 2) as number;

    if (isNaN(high) || isNaN(low) || isNaN(close)) {
      state.currentResult = result;
      state.currentMaxMin = maxMin;
      state.currentAcceleration = acceleration;
      state.currentIsBelow = isBelow;
      state.currentBarIndex = barIndex;
      return NaN;
    }

    let isFirstTrendBar = false;

    if (barIndex === 1) {
      if (close > prevClose) {
        isBelow = true;
        maxMin = high;
        result = prevLow;
      } else {
        isBelow = false;
        maxMin = low;
        result = prevHigh;
      }
      isFirstTrendBar = true;
      acceleration = start;
    }

    if (barIndex >= 1) {
      result = result + acceleration * (maxMin - result);

      if (isBelow) {
        if (result > low) {
          isFirstTrendBar = true;
          isBelow = false;
          result = Math.max(high, maxMin);
          maxMin = low;
          acceleration = start;
        }
      } else {
        if (result < high) {
          isFirstTrendBar = true;
          isBelow = true;
          result = Math.min(low, maxMin);
          maxMin = high;
          acceleration = start;
        }
      }

      if (!isFirstTrendBar) {
        if (isBelow) {
          if (high > maxMin) {
            maxMin = high;
            acceleration = Math.min(acceleration + inc, max);
          }
        } else {
          if (low < maxMin) {
            maxMin = low;
            acceleration = Math.min(acceleration + inc, max);
          }
        }
      }

      if (isBelow) {
        result = Math.min(result, prevLow);
        if (barIndex > 1) {
          result = Math.min(result, prevLow2);
        }
      } else {
        result = Math.max(result, prevHigh);
        if (barIndex > 1) {
          result = Math.max(result, prevHigh2);
        }
      }
    }

    barIndex++;

    state.currentResult = result;
    state.currentMaxMin = maxMin;
    state.currentAcceleration = acceleration;
    state.currentIsBelow = isBelow;
    state.currentBarIndex = barIndex;

    if (barIndex <= 1) {
      return NaN;
    }

    return context.precision(result);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/stoch.ts:31-135 (verbatim body).
function ptStoch(context: PineTsCtx) {
  return (source: unknown, high: unknown, low: unknown, _length: unknown, _callId?: string) => {
    const length = Series.from(_length).get(0) as number;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `stoch_${length}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevHighWindow: [] as number[],
        prevLowWindow: [] as number[],
        prevStoch: NaN,
        currentHighWindow: [] as number[],
        currentLowWindow: [] as number[],
        currentStoch: NaN,
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number;
      prevHighWindow: number[]; prevLowWindow: number[]; prevStoch: number;
      currentHighWindow: number[]; currentLowWindow: number[]; currentStoch: number;
    };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevHighWindow = [...state.currentHighWindow];
        state.prevLowWindow = [...state.currentLowWindow];
        state.prevStoch = state.currentStoch;
      }
      state.lastIdx = context.idx;
    }

    const currentSource = Series.from(source).get(0) as number;
    const currentHigh = Series.from(high).get(0) as number;
    const currentLow = Series.from(low).get(0) as number;

    const highWindow = [...state.prevHighWindow];
    const lowWindow = [...state.prevLowWindow];

    highWindow.unshift(currentHigh);
    lowWindow.unshift(currentLow);

    if (highWindow.length > length) {
      highWindow.pop();
      lowWindow.pop();
    }

    state.currentHighWindow = highWindow;
    state.currentLowWindow = lowWindow;

    const result = (value: number): unknown => {
      if (Number.isNaN(value)) {
        state.currentStoch = state.prevStoch;
        return state.prevStoch;
      }
      state.currentStoch = value;
      return context.precision(value);
    };

    if (highWindow.length < length) {
      return result(NaN);
    }

    const extreme = (window: number[], higher: boolean) => {
      let best = NaN;
      for (let i = 0; i < length; i++) {
        const v = window[i]!;
        if (Number.isNaN(v)) break;
        if (Number.isNaN(best) || (higher ? v > best : v < best)) best = v;
      }
      return best;
    };
    const highest = extreme(highWindow, true);
    const lowest = extreme(lowWindow, false);

    const range = highest - lowest;

    if (range === 0) {
      if (currentSource === lowest) return result(NaN);
      state.currentStoch = NaN;
      return NaN;
    }

    return result((100 * (currentSource - lowest)) / range);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/swma.ts:20-85 (verbatim body).
function ptSwma(context: PineTsCtx) {
  return (source: unknown, _callId?: string) => {
    const period = 4;
    const weights = [1, 2, 2, 1];
    const weightSum = 6;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `swma`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevWindow: [] as number[],
        currentWindow: [] as number[],
      };
    }

    const state = context.taState[stateKey] as { lastIdx: number; prevWindow: number[]; currentWindow: number[] };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevWindow = [...state.currentWindow];
      }
      state.lastIdx = context.idx;
    }

    const currentValue = Series.from(source).get(0) as number;

    const window = [...state.prevWindow];

    window.unshift(currentValue);

    while (window.length > period) {
      window.pop();
    }

    if (window.length < period && context.idx >= period - 1) {
      const series = Series.from(source);
      while (window.length < period) {
        window.push(series.get(window.length) as number);
      }
    }

    state.currentWindow = window;

    if (window.length < period) {
      return NaN;
    }

    let swma = 0;
    for (let i = 0; i < period; i++) {
      swma += weights[i]! * window[period - 1 - i]!;
    }
    swma /= weightSum;

    return context.precision(swma);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/tsi.ts:26-208 (verbatim body).
function ptTsi(context: PineTsCtx) {
  return (source: unknown, _shortLength: unknown, _longLength: unknown, _callId?: string) => {
    const shortLength = Series.from(_shortLength).get(0) as number;
    const longLength = Series.from(_longLength).get(0) as number;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `tsi_${shortLength}_${longLength}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevSource: NaN,
        prevEma1PcValue: NaN, prevEma1PcCount: 0, prevEma1PcSum: 0,
        prevEma2PcValue: NaN, prevEma2PcCount: 0, prevEma2PcSum: 0,
        prevEma1AbsValue: NaN, prevEma1AbsCount: 0, prevEma1AbsSum: 0,
        prevEma2AbsValue: NaN, prevEma2AbsCount: 0, prevEma2AbsSum: 0,
        currentSource: NaN,
        currentEma1PcValue: NaN, currentEma1PcCount: 0, currentEma1PcSum: 0,
        currentEma2PcValue: NaN, currentEma2PcCount: 0, currentEma2PcSum: 0,
        currentEma1AbsValue: NaN, currentEma1AbsCount: 0, currentEma1AbsSum: 0,
        currentEma2AbsValue: NaN, currentEma2AbsCount: 0, currentEma2AbsSum: 0,
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number; prevSource: number;
      prevEma1PcValue: number; prevEma1PcCount: number; prevEma1PcSum: number;
      prevEma2PcValue: number; prevEma2PcCount: number; prevEma2PcSum: number;
      prevEma1AbsValue: number; prevEma1AbsCount: number; prevEma1AbsSum: number;
      prevEma2AbsValue: number; prevEma2AbsCount: number; prevEma2AbsSum: number;
      currentSource: number;
      currentEma1PcValue: number; currentEma1PcCount: number; currentEma1PcSum: number;
      currentEma2PcValue: number; currentEma2PcCount: number; currentEma2PcSum: number;
      currentEma1AbsValue: number; currentEma1AbsCount: number; currentEma1AbsSum: number;
      currentEma2AbsValue: number; currentEma2AbsCount: number; currentEma2AbsSum: number;
    };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevSource = state.currentSource;
        state.prevEma1PcValue = state.currentEma1PcValue;
        state.prevEma1PcCount = state.currentEma1PcCount;
        state.prevEma1PcSum = state.currentEma1PcSum;
        state.prevEma2PcValue = state.currentEma2PcValue;
        state.prevEma2PcCount = state.currentEma2PcCount;
        state.prevEma2PcSum = state.currentEma2PcSum;
        state.prevEma1AbsValue = state.currentEma1AbsValue;
        state.prevEma1AbsCount = state.currentEma1AbsCount;
        state.prevEma1AbsSum = state.currentEma1AbsSum;
        state.prevEma2AbsValue = state.currentEma2AbsValue;
        state.prevEma2AbsCount = state.currentEma2AbsCount;
        state.prevEma2AbsSum = state.currentEma2AbsSum;
      }
      state.lastIdx = context.idx;
    }

    const currentSource = Series.from(source).get(0) as number;

    if (isNaN(currentSource)) {
      state.currentSource = NaN;
      return NaN;
    }

    const pc = isNaN(state.prevSource) ? NaN : currentSource - state.prevSource;

    state.currentSource = currentSource;

    if (isNaN(pc)) {
      return NaN;
    }

    const absPC = Math.abs(pc);

    const ema1PcMultiplier = 2 / (longLength + 1);
    const ema2PcMultiplier = 2 / (shortLength + 1);
    const ema1AbsMultiplier = 2 / (longLength + 1);
    const ema2AbsMultiplier = 2 / (shortLength + 1);

    let ema1PcCount = state.prevEma1PcCount;
    let ema1PcSum = state.prevEma1PcSum;
    let ema1PcValue = state.prevEma1PcValue;

    ema1PcCount++;
    if (ema1PcCount <= longLength) {
      ema1PcSum += pc;
      if (ema1PcCount === longLength) {
        ema1PcValue = ema1PcSum / longLength;
      }
    } else {
      ema1PcValue = pc * ema1PcMultiplier + ema1PcValue * (1 - ema1PcMultiplier);
    }

    let ema1AbsCount = state.prevEma1AbsCount;
    let ema1AbsSum = state.prevEma1AbsSum;
    let ema1AbsValue = state.prevEma1AbsValue;

    ema1AbsCount++;
    if (ema1AbsCount <= longLength) {
      ema1AbsSum += absPC;
      if (ema1AbsCount === longLength) {
        ema1AbsValue = ema1AbsSum / longLength;
      }
    } else {
      ema1AbsValue = absPC * ema1AbsMultiplier + ema1AbsValue * (1 - ema1AbsMultiplier);
    }

    if (isNaN(ema1PcValue) || isNaN(ema1AbsValue)) {
      state.currentEma1PcCount = ema1PcCount;
      state.currentEma1PcSum = ema1PcSum;
      state.currentEma1PcValue = ema1PcValue;
      state.currentEma1AbsCount = ema1AbsCount;
      state.currentEma1AbsSum = ema1AbsSum;
      state.currentEma1AbsValue = ema1AbsValue;
      return NaN;
    }

    let ema2PcCount = state.prevEma2PcCount;
    let ema2PcSum = state.prevEma2PcSum;
    let ema2PcValue = state.prevEma2PcValue;

    ema2PcCount++;
    if (ema2PcCount <= shortLength) {
      ema2PcSum += ema1PcValue;
      if (ema2PcCount === shortLength) {
        ema2PcValue = ema2PcSum / shortLength;
      }
    } else {
      ema2PcValue = ema1PcValue * ema2PcMultiplier + ema2PcValue * (1 - ema2PcMultiplier);
    }

    let ema2AbsCount = state.prevEma2AbsCount;
    let ema2AbsSum = state.prevEma2AbsSum;
    let ema2AbsValue = state.prevEma2AbsValue;

    ema2AbsCount++;
    if (ema2AbsCount <= shortLength) {
      ema2AbsSum += ema1AbsValue;
      if (ema2AbsCount === shortLength) {
        ema2AbsValue = ema2AbsSum / shortLength;
      }
    } else {
      ema2AbsValue = ema1AbsValue * ema2AbsMultiplier + ema2AbsValue * (1 - ema2AbsMultiplier);
    }

    state.currentEma1PcCount = ema1PcCount;
    state.currentEma1PcSum = ema1PcSum;
    state.currentEma1PcValue = ema1PcValue;

    state.currentEma1AbsCount = ema1AbsCount;
    state.currentEma1AbsSum = ema1AbsSum;
    state.currentEma1AbsValue = ema1AbsValue;

    state.currentEma2PcCount = ema2PcCount;
    state.currentEma2PcSum = ema2PcSum;
    state.currentEma2PcValue = ema2PcValue;

    state.currentEma2AbsCount = ema2AbsCount;
    state.currentEma2AbsSum = ema2AbsSum;
    state.currentEma2AbsValue = ema2AbsValue;

    if (isNaN(ema2PcValue) || isNaN(ema2AbsValue)) {
      return NaN;
    }

    if (ema2AbsValue === 0) {
      return context.precision(0);
    }

    const tsi = ema2PcValue / ema2AbsValue;

    return context.precision(tsi);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/valuewhen.ts:10-66 (verbatim body).
function ptValuewhen(context: PineTsCtx) {
  return (condition: unknown, source: unknown, _occurrence: unknown, _callId?: string) => {
    if (!context.taState) context.taState = {};
    const stateKey = _callId || 'valuewhen';

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevValues: [] as unknown[],
        currentValues: [] as unknown[],
      };
    }
    const state = context.taState[stateKey] as { lastIdx: number; prevValues: unknown[]; currentValues: unknown[] };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevValues = [...state.currentValues];
      }
      state.lastIdx = context.idx;
    }

    const cond = Series.from(condition).get(0);
    const val = Series.from(source).get(0);
    const occurrence = Series.from(_occurrence).get(0) as number;

    const values = [...state.prevValues];

    if (cond) {
      values.push(val);
    }

    state.currentValues = values;

    if (isNaN(occurrence) || occurrence < 0) {
      return NaN;
    }

    const index = values.length - 1 - occurrence;

    if (index < 0) {
      return NaN;
    }

    const result = values[index];

    if (typeof result === 'number') {
      return context.precision(result);
    }
    return result;
  };
}

// Source: pinets-src/src/namespaces/ta/methods/vwap.ts:23-124 (verbatim body,
// two adaptations: (a) facade data has no hlc3 — bare form builds a
// read-through PtSeries over high/low/close; (b) trailing-undefined args are
// dropped so args.length matches the upstream rest-args arity).
function ptVwap(context: PineTsCtx) {
  // hlc3 read-through for the bare `ta.vwap()` form: PtSeries.readBack is
  // private in the facade (same shape fromPine sets), so build it once here.
  const hlc3Series = new Series();
  type ReadBackHost = { readBack: (i: number) => unknown }; // PtSeries private field
  const host = hlc3Series as unknown as ReadBackHost;
  host.readBack = (i: number) => {
    const h = context.get(context.data.high, i) as number;
    const l = context.get(context.data.low, i) as number;
    const c = context.get(context.data.close, i) as number;
    return isNaN(h) || isNaN(l) || isNaN(c) ? NaN : (h + l + c) / 3;
  };
  return (...args: unknown[]) => {
    const _callId: string | undefined = typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined;
    // wrapPorted always passes `order.length` positionals — drop the trailing
    // undefineds so hasAnchor/hasBands see the caller's real arity.
    while (args.length && args[args.length - 1] === undefined) args.pop();
    const source = args.length > 0 ? args[0] : hlc3Series;
    const hasAnchor = args.length >= 2;
    const hasBands = args.length >= 3;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `vwap_${args.length}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevCumulativePV: 0,
        prevCumulativeVolume: 0,
        prevCumulativePPV: 0,
        prevStarted: false,
        prevLastSessionDate: null as string | null,
        currentCumulativePV: 0,
        currentCumulativeVolume: 0,
        currentCumulativePPV: 0,
        currentStarted: false,
        currentLastSessionDate: null as string | null,
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number;
      prevCumulativePV: number; prevCumulativeVolume: number; prevCumulativePPV: number;
      prevStarted: boolean; prevLastSessionDate: string | null;
      currentCumulativePV: number; currentCumulativeVolume: number; currentCumulativePPV: number;
      currentStarted: boolean; currentLastSessionDate: string | null;
    };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevCumulativePV = state.currentCumulativePV;
        state.prevCumulativeVolume = state.currentCumulativeVolume;
        state.prevCumulativePPV = state.currentCumulativePPV;
        state.prevStarted = state.currentStarted;
        state.prevLastSessionDate = state.currentLastSessionDate;
      }
      state.lastIdx = context.idx;
    }

    const currentPrice = Series.from(source).get(0) as number;
    const currentVolume = Series.from(context.data.volume).get(0) as number;

    let cumulativePV = state.prevCumulativePV;
    let cumulativeVolume = state.prevCumulativeVolume;
    let cumulativePPV = state.prevCumulativePPV;
    let started = state.prevStarted;
    let lastSessionDate = state.prevLastSessionDate;

    let reset: boolean;
    if (hasAnchor) {
      reset = !!Series.from(args[1]).get(0);
    } else {
      const currentOpenTime = Series.from(context.data.openTime).get(0) as number;
      const timezone = (context.pine?.syminfo?.timezone as string | undefined) || 'UTC';
      const parts = getDatePartsInTimezone(currentOpenTime, timezone);
      const currentSessionDate = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
      reset = lastSessionDate !== currentSessionDate;
      lastSessionDate = currentSessionDate;
    }

    if (reset) {
      cumulativePV = 0;
      cumulativeVolume = 0;
      cumulativePPV = 0;
      started = true;
    }

    if (started) {
      cumulativePV += currentPrice * currentVolume;
      cumulativeVolume += currentVolume;
      cumulativePPV += currentPrice * currentPrice * currentVolume;
    }

    state.currentCumulativePV = cumulativePV;
    state.currentCumulativeVolume = cumulativeVolume;
    state.currentCumulativePPV = cumulativePPV;
    state.currentStarted = started;
    state.currentLastSessionDate = lastSessionDate;

    const vwap = started && cumulativeVolume !== 0 ? cumulativePV / cumulativeVolume : NaN;

    if (!hasBands) {
      return isNaN(vwap) ? NaN : context.precision(vwap);
    }

    const mult = Series.from(args[2]).get(0) as number;
    const variance = cumulativePPV / cumulativeVolume - vwap * vwap;
    const deviation = Math.sqrt(Math.max(variance, 0));
    return [[context.precision(vwap), context.precision(vwap + mult * deviation), context.precision(vwap - mult * deviation)]];
  };
}

// Source: pinets-src/src/namespaces/ta/methods/wad.ts:16-73 (verbatim body).
function ptWad(context: PineTsCtx) {
  return (_callId?: string) => {
    if (!context.taState) context.taState = {};
    const stateKey = _callId || 'wad';

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevCumulativeSum: 0,
        currentCumulativeSum: 0,
      };
    }

    const state = context.taState[stateKey] as { lastIdx: number; prevCumulativeSum: number; currentCumulativeSum: number };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevCumulativeSum = state.currentCumulativeSum;
      }
      state.lastIdx = context.idx;
    }

    const close = context.get(context.data.close, 0) as number;
    const high = context.get(context.data.high, 0) as number;
    const low = context.get(context.data.low, 0) as number;
    const prevClose = context.get(context.data.close, 1) as number;

    if (isNaN(close) || isNaN(high) || isNaN(low)) {
      state.currentCumulativeSum = state.prevCumulativeSum;
      return context.precision(state.prevCumulativeSum);
    }

    let gain = 0;

    if (!isNaN(prevClose)) {
      const trueHigh = Math.max(high, prevClose);
      const trueLow = Math.min(low, prevClose);
      const mom = close - prevClose;

      if (mom > 0) {
        gain = close - trueLow;
      } else if (mom < 0) {
        gain = close - trueHigh;
      }
    }

    const currentSum = state.prevCumulativeSum + gain;

    state.currentCumulativeSum = currentSum;

    return context.precision(currentSum);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/wma.ts:5-78 (verbatim body).
function ptWma(context: PineTsCtx) {
  return (source: unknown, _period: unknown, _callId?: string) => {
    const period = Series.from(_period).get(0) as number;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `wma_${period}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevWindow: [] as number[],
        prevCallCount: 0,
        currentWindow: [] as number[],
        currentCallCount: 0,
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number; prevWindow: number[]; prevCallCount: number;
      currentWindow: number[]; currentCallCount: number;
    };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevWindow = [...state.currentWindow];
        state.prevCallCount = state.currentCallCount;
      }
      state.lastIdx = context.idx;
    }

    const currentValue = Series.from(source).get(0) as number;
    const currentIsNa = currentValue === null || currentValue === undefined || Number.isNaN(currentValue);

    const window = [...state.prevWindow];

    window.unshift(currentIsNa ? (window.length ? window[0]! : NaN) : currentValue);

    while (window.length > period) {
      window.pop();
    }

    const callCount = state.prevCallCount + 1;
    if (window.length < period && (callCount >= period || context.idx >= period - 1)) {
      const series = Series.from(source);
      while (window.length < period) {
        window.push(series.get(window.length) as number);
      }
      for (let i = window.length - 2; i >= 0; i--) {
        if (Number.isNaN(window[i])) window[i] = window[i + 1]!;
      }
    }

    state.currentWindow = window;
    state.currentCallCount = callCount;

    if (window.length < period || currentIsNa || window.some((v) => Number.isNaN(v))) {
      return NaN;
    }

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < period; i++) {
      const weight = period - i;
      numerator += window[i]! * weight;
      denominator += weight;
    }

    const wma = numerator / denominator;
    return context.precision(wma);
  };
}

// Source: pinets-src/src/namespaces/ta/methods/wpr.ts:22-106 (verbatim body).
function ptWpr(context: PineTsCtx) {
  return (_length: unknown, _callId?: string) => {
    const length = Series.from(_length).get(0) as number;

    if (!context.taState) context.taState = {};
    const stateKey = _callId || `wpr_${length}`;

    if (!context.taState[stateKey]) {
      context.taState[stateKey] = {
        lastIdx: -1,
        prevHighWindow: [] as number[],
        prevLowWindow: [] as number[],
        currentHighWindow: [] as number[],
        currentLowWindow: [] as number[],
      };
    }

    const state = context.taState[stateKey] as {
      lastIdx: number;
      prevHighWindow: number[]; prevLowWindow: number[];
      currentHighWindow: number[]; currentLowWindow: number[];
    };

    if (context.idx > state.lastIdx) {
      if (state.lastIdx >= 0) {
        state.prevHighWindow = [...state.currentHighWindow];
        state.prevLowWindow = [...state.currentLowWindow];
      }
      state.lastIdx = context.idx;
    }

    const high = context.get(context.data.high, 0) as number;
    const low = context.get(context.data.low, 0) as number;
    const close = context.get(context.data.close, 0) as number;

    if (isNaN(high) || isNaN(low) || isNaN(close)) {
      state.currentHighWindow = [...state.prevHighWindow];
      state.currentLowWindow = [...state.prevLowWindow];
      return NaN;
    }

    const highWindow = [...state.prevHighWindow];
    const lowWindow = [...state.prevLowWindow];

    highWindow.unshift(high);
    lowWindow.unshift(low);

    if (highWindow.length > length) {
      highWindow.pop();
      lowWindow.pop();
    }

    state.currentHighWindow = highWindow;
    state.currentLowWindow = lowWindow;

    if (highWindow.length < length) {
      return NaN;
    }

    let highestHigh = highWindow[0]!;
    let lowestLow = lowWindow[0]!;

    for (let i = 1; i < length; i++) {
      if (highWindow[i]! > highestHigh) {
        highestHigh = highWindow[i]!;
      }
      if (lowWindow[i]! < lowestLow) {
        lowestLow = lowWindow[i]!;
      }
    }

    const range = highestHigh - lowestLow;

    if (range === 0) {
      return context.precision(0);
    }

    const wpr = ((highestHigh - close) / range) * -100;

    return context.precision(wpr);
  };
}
// Source: pinets-src/src/namespaces/ta/methods/pivot_point_levels.ts:1-112
// (verbatim body; PineArrayObject return becomes a plain number[] — toValue
// wraps it into a Pine {kind:'array'} Value; upstream PineRuntimeError ctor
// takes (msg, fnName) — ours takes (msg), so fn name is inlined into msg).
type PtPivotPeriod = { open: number; high: number; low: number; close: number };

const PIVOT_TYPES = ['Traditional', 'Fibonacci', 'Woodie', 'Classic', 'DM', 'Camarilla'];

function pivotLevelsOf(type: string, { high: h, low: l, close: c }: PtPivotPeriod, open: number): number[] {
    const range = h - l;
    const p = (h + l + c) / 3;
    switch (type) {
        case 'Traditional':
            return [p, p * 2 - l, p * 2 - h, p + range, p - range, p * 2 + (h - 2 * l), p * 2 - (2 * h - l), p * 3 + (h - 3 * l), p * 3 - (3 * h - l), p * 4 + (h - 4 * l), p * 4 - (4 * h - l)];
        case 'Fibonacci':
            return [p, p + 0.382 * range, p - 0.382 * range, p + 0.618 * range, p - 0.618 * range, p + range, p - range, NaN, NaN, NaN, NaN];
        case 'Woodie': {
            const wp = (h + l + 2 * open) / 4;
            const r3 = h + 2 * (wp - l);
            const s3 = l - 2 * (h - wp);
            return [wp, 2 * wp - l, 2 * wp - h, wp + range, wp - range, r3, s3, r3 + range, s3 - range, NaN, NaN];
        }
        case 'Classic':
            return [p, 2 * p - l, 2 * p - h, p + range, p - range, p + 2 * range, p - 2 * range, p + 3 * range, p - 3 * range, NaN, NaN];
        case 'DM': {
            const x = c < open ? h + 2 * l + c : c > open ? 2 * h + l + c : h + l + 2 * c;
            return [x / 4, x / 2 - l, x / 2 - h, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN];
        }
        case 'Camarilla': {
            const r5 = (h / l) * c;
            return [p, c + (range * 1.1) / 12, c - (range * 1.1) / 12, c + (range * 1.1) / 6, c - (range * 1.1) / 6, c + (range * 1.1) / 4, c - (range * 1.1) / 4, c + (range * 1.1) / 2, c - (range * 1.1) / 2, r5, c - (r5 - c)];
        }
    }
    return new Array(11).fill(NaN);
}

function ptPivotPointLevels(context: PineTsCtx) {
    return (_type: unknown, _anchor: unknown, ...rest: unknown[]) => {
        // The transpiler appends the call id after the optional `developing` argument.
        const _callId: string | undefined = typeof rest[rest.length - 1] === 'string' ? rest.pop() as string : undefined;
        const type = Series.from(_type).get(0) as string;
        const anchor = Series.from(_anchor).get(0) === true;
        const developing = rest.length > 0 && Series.from(rest[0]).get(0) === true;

        if (!PIVOT_TYPES.includes(type)) {
            throw new PineRuntimeError(
                `ta.pivot_point_levels: Invalid argument '${type}' for 'type'. Possible values: ['Camarilla', 'Traditional', 'DM', 'Classic', 'Fibonacci', 'Woodie']`
            );
        }
        if (developing && type === 'Woodie') {
            throw new PineRuntimeError('ta.pivot_point_levels: `developing` cannot be `true` when `type` is "Woodie".');
        }

        if (!context.taState) context.taState = {};
        const stateKey = _callId || `pivot_point_levels_${type}_${developing}`;
        if (!context.taState[stateKey]) {
            context.taState[stateKey] = {
                lastIdx: -1,
                // Committed state
                prev: { period: null, levels: null },
                // Tentative state
                current: { period: null, levels: null },
            };
        }
        const state = context.taState[stateKey] as {
            lastIdx: number;
            prev: { period: PtPivotPeriod | null; levels: number[] | null };
            current: { period: PtPivotPeriod | null; levels: number[] | null };
        };

        // Commit logic
        if (context.idx > state.lastIdx) {
            if (state.lastIdx >= 0) state.prev = state.current;
            state.lastIdx = context.idx;
        }

        const bar: PtPivotPeriod = {
            open: Series.from(context.data.open).get(0) as number,
            high: Series.from(context.data.high).get(0) as number,
            low: Series.from(context.data.low).get(0) as number,
            close: Series.from(context.data.close).get(0) as number,
        };

        let period: PtPivotPeriod | null = state.prev.period;
        let levels: number[] | null = state.prev.levels;
        if (anchor || !period) {
            period = { ...bar };
            if (!developing && anchor && state.prev.period) {
                levels = pivotLevelsOf(type, state.prev.period, state.prev.period.open);
            }
        } else {
            period = { open: period.open, high: Math.max(period.high, bar.high), low: Math.min(period.low, bar.low), close: bar.close };
        }
        state.current = { period, levels };

        const out = developing ? pivotLevelsOf(type, period, period.open) : (levels ?? new Array(11).fill(NaN));
        // toValue maps a number[] → Pine array Value; PineArrayObject is only a
        // marker type upstream — a plain array round-trips identically.
        return out.map((v) => context.precision(v) as number);
    };
}


// ── Slice registration ──────────────────────────────────────────────────────
// order = upstream positional param names (TV names where upstream uses _x).

const SLICE: PtSlice = {
  pivot_point_levels: { factory: ptPivotPointLevels as unknown as PtFactory, order: ['type', 'anchor', 'developing'] },
  max:       { factory: ptMax as unknown as PtFactory,       order: ['source'] },
  mfi:       { factory: ptMfi as unknown as PtFactory,       order: ['source', 'length'] },
  min:       { factory: ptMin as unknown as PtFactory,       order: ['source'] },
  nvi:       { factory: ptNvi as unknown as PtFactory,       order: [] },
  obv:       { factory: ptObv as unknown as PtFactory,       order: [] },
  pvi:       { factory: ptPvi as unknown as PtFactory,       order: [] },
  pvt:       { factory: ptPvt as unknown as PtFactory,       order: [] },
  range:     { factory: ptRange as unknown as PtFactory,     order: ['source', 'length'] },
  rci:       { factory: ptRci as unknown as PtFactory,       order: ['source', 'length'] },
  rising:    { factory: ptRising as unknown as PtFactory,    order: ['source', 'length'] },
  rma:       { factory: ptRma as unknown as PtFactory,       order: ['source', 'length'] },
  roc:       { factory: ptRoc as unknown as PtFactory,       order: ['source', 'length'] },
  sar:       { factory: ptSar as unknown as PtFactory,       order: ['start', 'inc', 'max'] },
  stoch:     { factory: ptStoch as unknown as PtFactory,     order: ['source', 'high', 'low', 'length'] },
  swma:      { factory: ptSwma as unknown as PtFactory,      order: ['source'] },
  tsi:       { factory: ptTsi as unknown as PtFactory,       order: ['source', 'short_length', 'long_length'] },
  valuewhen: { factory: ptValuewhen as unknown as PtFactory, order: ['condition', 'source', 'occurrence'] },
  vwap:      { factory: ptVwap as unknown as PtFactory,      order: ['source', 'anchor', 'stdev_mult'] },
  wad:       { factory: ptWad as unknown as PtFactory,       order: [] },
  wma:       { factory: ptWma as unknown as PtFactory,       order: ['source', 'length'] },
  wpr:       { factory: ptWpr as unknown as PtFactory,       order: ['length'] },
};
registerPtSlice(SLICE);
