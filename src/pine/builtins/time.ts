// ── Calendar/time builtins: hour/minute/…, timestamp, timeframe.in_seconds ──
// All calendar fns accept an explicit `time` (ms) arg; without it they read
// the current bar's open time from ctx.time. Timezone defaults to
// syminfo.timezone (Asia/Taipei in the engine, UTC in bare test ctxs).
// Bare `hour`/`minute`/… also resolve as series vars (TV semantics) via lazy
// constants — the call form `hour(t)` still hits the builtin first.

import type { BuiltinCtx, Value } from '../contracts';
import { NA, Series } from '../contracts';
import { bindArgs, numArg } from './util';
import { registerBuiltin, registerLazyConstant } from './registry';
import { tfToMs } from '../mtf';

const unser = (v: Value | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const x = v.kind === 'series' ? v.v.cur() : v;
  return x.kind === 'int' || x.kind === 'float' ? x.v : undefined;
};

const unserStr = (v: Value | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const x = v.kind === 'series' ? v.v.cur() : v;
  return x.kind === 'string' ? x.v : undefined;
};

// ── timezone helpers ─────────────────────────────────────────────────────────

/** syminfo.timezone, or 'UTC' when absent/invalid. */
export function tzOf(ctx: BuiltinCtx): string {
  const t = ctx.syminfo['timezone'];
  const s = t && t.kind === 'string' ? t.v : 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return s;
  } catch {
    return 'UTC';
  }
}

// Intl parts cache per timezone
const partCache = new Map<string, Intl.DateTimeFormat>();
export const partsOf = (ms: number, tz: string): Intl.DateTimeFormatPart[] => {
  let f = partCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
    }
    partCache.set(tz, f);
  }
  return f.formatToParts(new Date(ms));
};
const part = (ms: number, tz: string, t: Intl.DateTimeFormatPartTypes): number => {
  const p = partsOf(ms, tz).find((x) => x.type === t)?.value;
  if (t === 'weekday') return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf((p ?? '').toLowerCase()) + 1;
  const n = Number(p);
  return t === 'hour' && n === 24 ? 0 : n;
};

/** tzOffsetMs(ms) = instant − wall-clock-UTC for the zone `tz` at instant ms.
 *  = −(conventional UTC offset); Asia/Taipei → −8h. */
export function tzOffsetMs(ms: number, tz: string): number {
  const y = part(ms, tz, 'year'), mo = part(ms, tz, 'month'), d = part(ms, tz, 'day');
  const h = part(ms, tz, 'hour'), mi = part(ms, tz, 'minute'), s = part(ms, tz, 'second');
  return ms - Date.UTC(y, mo - 1, d, h, mi, s);
}

/** Wall-clock (y,mo,d,h,mi,s) expressed in `tz` → epoch ms. instant =
 *  wallUTC + tzOffsetMs(instant); iterate to the fixed point (handles DST). */
function zonedMs(tz: string, y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  const wallUTC = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wallUTC;
  for (let i = 0; i < 3; i++) {
    const t2 = wallUTC + tzOffsetMs(t, tz);
    if (t2 === t) break;
    t = t2;
  }
  return t;
}

// ── timeframe boundary detection ─────────────────────────────────────────────
// A bar "opens a new period" when the intraday period index floor(t/tfMs)
// differs from the previous bar's, or (calendar tfs) the calendar key changes.

const weekId = (ms: number, tz: string): number => {
  const wd = part(ms, tz, 'weekday'); // 1 = Sunday
  const mondayDelta = wd === 1 ? 6 : wd - 2;
  // local wall-clock day index minus distance back to its Monday → week bucket
  return Math.floor(((ms - tzOffsetMs(ms, tz)) / 86_400_000 - mondayDelta) / 7);
};

function calKey(ms: number, tz: string, unit: string): number | undefined {
  const y = part(ms, tz, 'year'), mo = part(ms, tz, 'month');
  switch (unit) {
    case 'D': return y * 10000 + mo * 100 + part(ms, tz, 'day');
    case 'W': return weekId(ms, tz);
    case 'M': return y * 12 + mo;
    case 'Q': return y * 4 + Math.floor((mo - 1) / 3);
    case 'Y': return y;
    default: return undefined;
  }
}

const normCalTf = (spec: string): string | undefined => {
  const t = spec.trim().toUpperCase();
  if (['D', '1D'].includes(t)) return 'D';
  if (['W', '1W'].includes(t)) return 'W';
  if (['M', '1M'].includes(t)) return 'M';
  if (['Q', '1Q', '3M'].includes(t)) return 'Q';
  if (['Y', '1Y', '12M'].includes(t)) return 'Y';
  return undefined;
};

/** True when absolute bar `bar` opens a new `spec` period vs bar-1. */
export function isTfBoundary(ctx: BuiltinCtx, spec: string, bar: number): boolean {
  if (bar <= 0) return true;
  const t = unser(ctx.time.get(0)); // current bar's open time
  const p = unser(ctx.time.get(1)); // previous bar's open time
  if (t === undefined || p === undefined) return bar === 0;
  const tz = tzOf(ctx);
  const ms = tfToMs(spec);
  if (ms !== null) return Math.floor(t / ms) !== Math.floor(p / ms);
  const unit = normCalTf(spec);
  if (unit !== undefined) return calKey(t, tz, unit) !== calKey(p, tz, unit);
  return false;
}

// ── calendar fields ──────────────────────────────────────────────────────────

const calFn = (field: Intl.DateTimeFormatPartTypes) =>
  (_c: BuiltinCtx, args: Value[], named: Record<string, Value>): Value => {
    const bound = bindArgs(args, named, ['time', 'timezone'] as const);
    const ms = unser(bound.get('time')) ?? unser(_c.time.get(0));
    if (ms === undefined) return NA;
    const tz = unserStr(bound.get('timezone')) ?? tzOf(_c);
    return { kind: 'int', v: part(ms, tz, field) };
  };
const CAL_FIELDS = [
  ['hour', 'hour'], ['minute', 'minute'], ['second', 'second'],
  ['dayofmonth', 'day'], ['month', 'month'], ['year', 'year'], ['dayofweek', 'weekday'],
] as const;

for (const [n, f] of CAL_FIELDS)
  registerBuiltin('', n, calFn(f as Intl.DateTimeFormatPartTypes));

// Bare calendar vars (`hour == 15`) resolve as series vars in TV. The call form
// `hour(t)` is unaffected — evalCallDispatch consults BUILTINS before constants;
// the bare-ident path consults constants first (evalIdent). Calendar series
// extend Series (get(n) = n bars ago) computed on demand from ctx.time.

class CalSeries extends Series {
  constructor(private ctx: BuiltinCtx, private field: Intl.DateTimeFormatPartTypes) { super(); }
  private at(off: number): Value {
    const t = this.ctx.time.get(off);
    if (t.kind !== 'int' && t.kind !== 'float') return NA;
    return { kind: 'int', v: part(t.v, tzOf(this.ctx), this.field) };
  }
  override get(n: number): Value { return n >= 0 && Number.isFinite(n) ? this.at(Math.floor(n)) : NA; }
  override cur(): Value { return this.at(0); }
  override size(): number { return this.ctx.barIndex + 1; }
}

for (const [n, f] of CAL_FIELDS)
  registerLazyConstant('', n, (c) =>
    c === undefined ? NA : { kind: 'series', v: new CalSeries(c as BuiltinCtx, f as Intl.DateTimeFormatPartTypes) });

// ── time / timestamp ─────────────────────────────────────────────────────────

// time(timeframe): na except on bars that open a new `timeframe` period; that
// bar's open time is the period's opening time (TV semantics). No arg → bar time.
registerBuiltin('', 'time', (_c, args, named) => {
  const bound = bindArgs(args, named, ['timeframe'] as const);
  const v = _c.time.get(0);
  if (v.kind !== 'int' && v.kind !== 'float') return NA;
  const spec = unserStr(bound.get('timeframe'));
  if (spec === undefined) return v;
  return isTfBoundary(_c, spec, _c.barIndex) ? v : NA;
});

// timestamp overloads:
//   timestamp(year, month, day, hour, minute[, second])           → UTC fields
//   timestamp(tz, year, month, day, hour, minute[, second])       → tz fields
//   timestamp("…parseable date string…")                          → Date.parse
registerBuiltin('', 'timestamp', (_c, args, named) => {
  const firstRaw = args[0];
  const firstIsStr = unserStr(firstRaw) !== undefined;
  const order = (named.timezone !== undefined || firstIsStr)
    ? (['timezone', 'year', 'month', 'day', 'hour', 'minute', 'second'] as const)
    : (['year', 'month', 'day', 'hour', 'minute', 'second', 'timezone'] as const);
  const bound = bindArgs(args, named, order);
  const tzS = unserStr(bound.get('timezone'));
  const y = numArg(bound, 'year', NaN);
  if (!Number.isFinite(y)) {
    // Legacy single-string form: timestamp("2009-01-01 00:00")
    if (tzS !== undefined) {
      const ms = Date.parse(tzS);
      return Number.isNaN(ms) ? NA : { kind: 'int', v: ms };
    }
    return NA;
  }
  const mo = numArg(bound, 'month', 1), d = numArg(bound, 'day', 1),
    h = numArg(bound, 'hour', 0), mi = numArg(bound, 'minute', 0), s = numArg(bound, 'second', 0);
  const ms = tzS !== undefined ? zonedMs(tzS, y, mo, d, h, mi, s) : Date.UTC(y, mo - 1, d, h, mi, s);
  return { kind: 'int', v: ms };
});

// timeframe.in_seconds — intraday via tfToMs; calendar units (D/W/M) get fixed
// day counts (1d=86400s, 1w=604800s, 1m=2592000s) since tfToMs returns null.
const tfSeconds = (tf: string): number | null => {
  const ms = tfToMs(tf);
  if (ms !== null) return Math.floor(ms / 1000);
  const m = /^(\d*)\s*([a-zA-Z]*)$/.exec(tf.trim());
  if (!m) return null;
  const n = m[1] === '' ? 1 : parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch ((m[2] ?? '').toUpperCase()) {
    case 'D': return n * 86_400;
    case 'W': return n * 604_800;
    case 'M': return n * 2_592_000;
    default: return null;
  }
};

registerBuiltin('timeframe', 'in_seconds', (c, args, named) => {
  const bound = bindArgs(args, named, ['timeframe'] as const);
  const tf = unserStr(bound.get('timeframe')) ?? c.timeframe.period;
  const s = tfSeconds(tf);
  return s === null ? NA : { kind: 'int', v: s };
});

// Bare `timeframe.in_seconds` (no call) — constant form for scripts that read
// it as a value rather than calling it.
registerLazyConstant('timeframe', 'in_seconds', (c) => {
  const ctx = c as BuiltinCtx | undefined;
  if (!ctx) return NA;
  const s = tfSeconds(ctx.timeframe.period);
  return s === null ? NA : { kind: 'int', v: s };
});


