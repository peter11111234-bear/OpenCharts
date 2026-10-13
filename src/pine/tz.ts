// ── Timezone helpers ─────────────────────────────────────────────────────────
// Shared by the calendar builtins (builtins/time.ts), builtins/session.ts and
// the strategy replay's day boundaries. Deliberately a leaf module: it imports
// nothing but contracts types. strategy.ts sits inside the
// interpreter → strategy → mtf → interpreter cycle, so it may only import
// modules that do not reach the interpreter.

import type { BuiltinCtx } from './contracts';

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
const partsFmt = (tz: string): Intl.DateTimeFormat => {
  let f = partCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
    }
    partCache.set(tz, f);
  }
  return f;
};

// (ms, tz) → calendar fields; each entry holds all 7 fields read by part().
// One formatToParts per unique (ms,tz) — was 6+ per field-access per bar.
interface DateParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  weekday: number; // 1=Sun..7=Sat (TV dayofweek); 0 = unknown
}
// Test instrumentation: counts actual Intl.formatToParts calls.
export let __partsOfCalls = 0;
// Bounded: outer map is per tz (tz count is small, ≤ ~3/run); each inner map
// is capped at 4096 (ms,DateParts) entries — it survives across runs, so
// without a cap a long session of many distinct bars would grow it forever.
// On overflow we clear and keep going: entries are a pure cache, correctness
// is unaffected (the evicted ms is just recomputed via formatToParts).
const PARTS_MEMO_CAP = 4096;
const partsMemo = new Map<string, Map<number, DateParts>>();
// numPart preserves the old semantics: a missing part yields NaN
// (old code did Number(undefined) → NaN; Number('') would be 0 — WRONG).
const numPart = (v: string | undefined): number => (v === undefined ? NaN : Number(v));
const partsRec = (ms: number, tz: string): DateParts => {
  let perMs = partsMemo.get(tz);
  if (!perMs) { perMs = new Map(); partsMemo.set(tz, perMs); }
  let r = perMs.get(ms);
  if (r !== undefined) return r;
  __partsOfCalls++;
  const parts = partsFmt(tz).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((x) => x.type === t)?.value;
  const wdStr = (get('weekday') ?? '').toLowerCase();
  const hourRaw = numPart(get('hour'));
  r = {
    year: numPart(get('year')),
    month: numPart(get('month')),
    day: numPart(get('day')),
    hour: hourRaw === 24 ? 0 : hourRaw, // preserves existing 24→0 quirk
    minute: numPart(get('minute')),
    second: numPart(get('second')),
    weekday: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(wdStr) + 1,
  };
  if (perMs.size >= PARTS_MEMO_CAP) perMs.clear();
  perMs.set(ms, r);
  return r;
};

export const partsOf = (ms: number, tz: string): Intl.DateTimeFormatPart[] => {
  // Backward-compat shim for external callers (str.ts fmtTime, tests) that want
  // the raw parts array. Synthesizes only the 7 part types partsRec stores —
  // other Intl part types (literal, dayPeriod, era, …) are NOT present; callers
  // needing them must call partsFmt(tz).formatToParts directly. Not on the hot
  // path — hot calendar callers use partsRec.
  const r = partsRec(ms, tz);
  return [
    { type: 'year', value: String(r.year) },
    { type: 'month', value: String(r.month).padStart(2, '0') },
    { type: 'day', value: String(r.day).padStart(2, '0') },
    { type: 'hour', value: String(r.hour).padStart(2, '0') },
    { type: 'minute', value: String(r.minute).padStart(2, '0') },
    { type: 'second', value: String(r.second).padStart(2, '0') },
    { type: 'weekday', value: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][r.weekday - 1]! },
  ] as Intl.DateTimeFormatPart[];
};
export const part = (ms: number, tz: string, t: Intl.DateTimeFormatPartTypes): number => {
  const r = partsRec(ms, tz);
  switch (t) {
    case 'year': return r.year;
    case 'month': return r.month;
    case 'day': return r.day;
    case 'hour': return r.hour;
    case 'minute': return r.minute;
    case 'second': return r.second;
    case 'weekday': return r.weekday;
    default: return NaN;
  }
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
export function zonedMs(tz: string, y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  const wallUTC = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wallUTC;
  for (let i = 0; i < 3; i++) {
    const t2 = wallUTC + tzOffsetMs(t, tz);
    if (t2 === t) break;
    t = t2;
  }
  return t;
}
