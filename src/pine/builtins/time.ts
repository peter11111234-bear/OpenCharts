// ── Calendar/time builtins: hour/minute/…, timestamp, timeframe.in_seconds ──
// All calendar fns accept an explicit `time` (ms) arg; without it they read
// the current bar's open time from ctx.time. Timezone defaults to
// syminfo.timezone (Asia/Taipei in the engine, UTC in bare test ctxs).
// Bare `hour`/`minute`/… also resolve as series vars (TV semantics) via lazy
// constants — the call form `hour(t)` still hits the builtin first.

import type { BuiltinCtx, Value } from '../contracts';
import { NA, Series } from '../contracts';
import { bindArgs, numArg, warnOnce } from './util';
import { registerBuiltin, registerLazyConstant } from './registry';
import { tfNext, tfToMs } from '../mtf';
import { part, tzOf, tzOffsetMs, zonedMs } from '../tz';

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
// The implementation lives in ../tz — a leaf module, so the strategy replay
// can reach it without entering the interpreter → strategy → mtf → interpreter
// import cycle. Re-exported here because this module is the historical import
// site (str.ts, session.ts, ta.ts, tests).

export { part, partsOf, tzOf, tzOffsetMs, zonedMs, __partsOfCalls } from '../tz';

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

// ── time / time_close / timestamp ────────────────────────────────────────────
// A Pine `session` argument is "HHMM-HHMM" or "HH:MM-HH:MM". The venue windows
// this app knows live in session.ts; time()/time_close() need only the raw spec
// plus the bar's timezone.

const DAY_MS = 86_400_000;

/** `"0900-1330"` / `"09:00-13:30"` → minutes since local midnight. */
function parseSessionSpec(spec: string): { startMin: number; endMin: number } | null {
  const m = /^(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})$/.exec(spec.trim());
  if (!m) return null;
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]);
  if (startMin >= endMin || endMin > 1440) return null;
  return { startMin, endMin };
}

/** Session bounds (epoch ms) of the local calendar day holding `ms`. */
function sessionWindow(ms: number, tz: string, spec: string): { startMs: number; endMs: number } | null {
  const parsed = parseSessionSpec(spec);
  if (parsed === null) return null;
  const y = part(ms, tz, 'year'), mo = part(ms, tz, 'month'), d = part(ms, tz, 'day');
  return {
    startMs: zonedMs(tz, y, mo, d, Math.floor(parsed.startMin / 60), parsed.startMin % 60, 0),
    endMs: zonedMs(tz, y, mo, d, Math.floor(parsed.endMin / 60), parsed.endMin % 60, 0),
  };
}

/** The session open of the previous trading day before `startMs` — a weekday
 *  template: Saturdays and Sundays carry no session (the venues in session.ts
 *  all trade Monday to Friday). */
function previousSessionStart(startMs: number, tz: string, spec: string): number {
  const parsed = parseSessionSpec(spec);
  if (parsed === null) return startMs;
  for (let d = 1; d <= 5; d++) {
    const prev = startMs - d * DAY_MS;
    const wd = part(prev, tz, 'weekday'); // 1 = Sunday, 7 = Saturday
    if (wd === 1 || wd === 7) continue;
    return zonedMs(tz, part(prev, tz, 'year'), part(prev, tz, 'month'), part(prev, tz, 'day'),
      Math.floor(parsed.startMin / 60), parsed.startMin % 60, 0);
  }
  return startMs;
}

/** Walk `back` bars of `tf` backwards from `t`. Intraday grids and month
 *  arithmetic are exact. A D/W walk that crosses the turn of the year is NOT
 *  reproduced — TradingView places that bar from the chart bar's own position
 *  inside it (measured by PyneCore: `_tv_week_walk` / `_tv_day_walk`) — so the
 *  plain arithmetic value is returned and the caller reports it once. */
function gridBack(t: number, tf: string, back: number, onCrossYear: () => void): number {
  if (back <= 0) return t;
  const ms = tfToMs(tf);
  if (ms !== null) return t - back * ms;
  const m = /^(\d*)\s*([a-zA-Z]*)$/.exec(tf.trim());
  const n = m?.[1] ? parseInt(m[1], 10) : 1;
  const unit = (m?.[2] ?? '').toUpperCase();
  if (unit === 'D' || unit === 'W') {
    const out = t - back * (unit === 'W' ? 7 * n : n) * DAY_MS;
    if (new Date(out).getUTCFullYear() !== new Date(t).getUTCFullYear()) onCrossYear();
    return out;
  }
  if (unit === 'M') {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n * back, 1);
  }
  return t;
}

// time(timeframe[, session, timezone][, bars_back]):
//   with a session → that session's opening time on bars inside it, na outside;
//   with only a timeframe → the opening time of the bar's period (na on bars
//   that do not open one, TV semantics); with no argument → the bar's own time.
// time_close(timeframe[, session, timezone]) → the session's closing time.
registerBuiltin('', 'time', (ctx, args, named) => {
  const bound = bindArgs(args, named, ['timeframe', 'session', 'timezone', 'bars_back'] as const);
  const v = ctx.time.get(0);
  if (v.kind !== 'int' && v.kind !== 'float') return NA;
  const tz = unserStr(bound.get('timezone')) ?? tzOf(ctx);
  const sessSpec = unserStr(bound.get('session'));
  const back = Math.max(0, Math.floor(unser(bound.get('bars_back')) ?? 0));

  if (sessSpec !== undefined) {
    // Inside the session the answer is the session's own opening time for a
    // calendar timeframe (every bar of the day shares one D/W/M period) and the
    // bar's own open for an intraday one; outside the session it is na.
    const win = sessionWindow(v.v, tz, sessSpec);
    if (win === null) return NA;
    if (v.v < win.startMs || v.v >= win.endMs) return NA;
    const spec = unserStr(bound.get('timeframe'));
    let day = spec !== undefined && normCalTf(spec) !== undefined ? win.startMs : v.v;
    for (let i = 0; i < back; i++) day = previousSessionStart(day, tz, sessSpec);
    return { kind: 'int', v: day };
  }

  const spec = unserStr(bound.get('timeframe'));
  if (spec === undefined) return { kind: 'int', v: v.v };
  if (!isTfBoundary(ctx, spec, ctx.barIndex)) return NA;
  return { kind: 'int', v: gridBack(v.v, spec, back, () => warnOnce(ctx, 'time|bargrid-crossyear',
    'time(): a D/W bars_back walk across the turn of the year is not reproduced — the arithmetic value is returned')) };
});

registerBuiltin('', 'time_close', (ctx, args, named) => {
  const bound = bindArgs(args, named, ['timeframe', 'session', 'timezone'] as const);
  const v = ctx.time.get(0);
  if (v.kind !== 'int' && v.kind !== 'float') return NA;
  const sessSpec = unserStr(bound.get('session'));
  if (sessSpec === undefined) {
    // Without a session the bar's close is the next period's open.
    const spec = unserStr(bound.get('timeframe')) ?? ctx.timeframe.period;
    if (!isTfBoundary(ctx, spec, ctx.barIndex)) return NA;
    return { kind: 'int', v: tfNext(v.v, spec) };
  }
  const tz = unserStr(bound.get('timezone')) ?? tzOf(ctx);
  const win = sessionWindow(v.v, tz, sessSpec);
  if (win === null) return NA;
  if (v.v < win.startMs || v.v >= win.endMs) return NA;
  return { kind: 'int', v: win.endMs };
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


