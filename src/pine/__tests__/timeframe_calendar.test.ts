// ── timeframe.from_seconds / weekofyear / timenow ───────────────────────────
// Semantics quoted from the Pine v6 reference kept at scratch/pine-v6-kb:
//
//   timeframe.from_seconds  "Converts a number of seconds into a valid timeframe
//                           string" (dist/bundles/timeframe.md:88-89). It rounds
//                           up, so "604,799 seconds (one second less than 7
//                           days) will return "7D""; when the seconds "exactly
//                           represent two or more valid timeframes, the one
//                           with the larger base unit will be used. Thus
//                           604,800 seconds (7 days) returns "1W", not "7D"";
//                           "All values above 31,622,400 (366 days) return
//                           "12M"" (timeframe.md:109-118).
//   valid timeframe set     guide/concepts/timeframes.md:57-65 — seconds are the
//                           discrete 1/5/10/15/30/45, minutes 1..1440, days
//                           1..365, weeks 1..52, months 1..12. from_seconds'
//                           seconds ladder stops at 30, so 31..59 s round to
//                           "1" (measured on TV by LuxAlgo/PineTS, whose
//                           src/timeframe.ts carries the ladder used below).
//   weekofyear              "The week number of the year, in the exchange time
//                           zone, calculated from the bar's opening UNIX
//                           timestamp" (dist/bundles/variables.md:1107-1108,
//                           "series int"); the call form "Calculates the week
//                           number of the year, in a specified time zone, from a
//                           UNIX timestamp" (reference/functions/weekofyear.md:29-30,
//                           where `timezone` "default is syminfo.timezone").
//                           The numbering is ISO 8601 (Monday-start weeks that
//                           belong to the year their Thursday falls in).
//   timenow                 "Current time in UNIX format" (variables.md:1026).
//
// Every from_seconds expectation below is a value measured on TradingView
// (LuxAlgo/PineTS tests/namespaces/timeframe-parsing.test.ts).

import { describe, expect, it } from 'vitest';
import { BUILTINS, getConstant } from '../builtins';
import '../builtins';
import { NA, Series } from '../contracts';
import type { BuiltinCtx, RunResult, Value } from '../contracts';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { mkBars } from './golden';

// ── helpers ─────────────────────────────────────────────────────────────────

function mkCtx(over: Partial<BuiltinCtx> = {}): BuiltinCtx {
  return {
    barIndex: 0,
    barCount: 1,
    open: new Series(),
    high: new Series(),
    low: new Series(),
    close: new Series(),
    volume: new Series(),
    time: new Series(),
    hl2: new Series(),
    hlc3: new Series(),
    ohlc4: new Series(),
    hlcc4: new Series(),
    plots: [],
    drawings: [],
    warnings: [],
    alerts: [],
    logs: [],
    syminfo: { timezone: { kind: 'string', v: 'UTC' } },
    timeframe: {
      period: 'D',
      multiplier: 1,
      isseconds: false,
      isminutes: false,
      isdaily: true,
      isweekly: false,
      ismonthly: false,
      isintraday: false,
    },
    callUdf: () => NA,
    ...over,
  };
}

const call = (name: string, args: Value[] = [], named: Record<string, Value> = {}, ctx = mkCtx()): Value => {
  const fn = BUILTINS.get(name);
  if (!fn) throw new Error(`builtin not registered: ${name}`);
  return fn(ctx, args, named);
};

const intV = (v: number): Value => ({ kind: 'int', v });
const strV = (v: string): Value => ({ kind: 'string', v });
const num = (v: Value): unknown => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na');
const text = (v: Value): unknown => (v.kind === 'string' ? v.v : 'na');

const FS = (seconds: number): unknown => text(call('timeframe.from_seconds', [intV(seconds)]));
const SECS = (tf: string): unknown => num(call('timeframe.in_seconds', [strV(tf)]));

/** Bars one day apart starting at `iso` (UTC midnight). */
const dailyBars = (iso: string, n: number) => mkBars(n, Date.parse(iso), 86_400_000);

const run = async (src: string, bars = dailyBars('2024-12-29T00:00:00Z', 5)) =>
  runScript(parse(`indicator("t")\n${src}`), bars, { symbol: 'X', timeframe: 'D', fetchSeries: async () => [] });

/** Per-bar numeric values of the first plot ('na' for anything non-numeric). */
const firstPlot = (r: RunResult): unknown[] => {
  const plot = r.plots.get('plot_0') ?? r.plots.values().next().value;
  return (plot?.values ?? []).map(num);
};

// ── timeframe.from_seconds ──────────────────────────────────────────────────

describe('timeframe.from_seconds', () => {
  it('follows the three documented rules', () => {
    expect(FS(1)).toBe('1S');              // "one second or less will return "1S""
    expect(FS(3)).toBe('5S');              // "2-5 seconds will return "5S""
    expect(FS(604_799)).toBe('7D');        // "604,799 seconds … will return "7D""
    expect(FS(604_800)).toBe('1W');        // "604,800 seconds (7 days) returns "1W", not "7D""
    expect(FS(366 * 86_400)).toBe('12M');  // "All values above 31,622,400 (366 days) return "12M""
    expect(FS(31_536_000)).toBe('12M');    // 365 days already clamps to "12M"
    expect(FS(63_072_072)).toBe('12M');    // 2 × 365 days stays clamped
  });

  it('rounds up through the whole valid set (values measured on TradingView)', () => {
    const cases: [number, string][] = [
      [0, '1S'], [1, '1S'], [2, '5S'], [6, '10S'], [14, '15S'], [16, '30S'], [30, '30S'],
      [31, '1'], [45, '1'], [59, '1'], [60, '1'], [61, '2'],
      [3599, '60'], [3600, '60'], [3601, '61'], [86399, '1440'], [86400, '1D'], [86401, '2D'],
      [604_799, '7D'], [604_800, '1W'], [604_801, '8D'], [1_814_400, '3W'], [1_814_401, '22D'],
      [2_592_000, '30D'], [2_628_003, '1M'], [2_628_004, '31D'], [5_256_006, '2M'],
      [7_884_008, '92D'], [13_140_015, '5M'], [17_280_000, '200D'],
      [31_449_600, '52W'], [31_449_601, '365D'], [31_535_999, '365D'], [31_536_000, '12M'],
    ];
    for (const [s, tf] of cases) expect(FS(s), `from_seconds(${s})`).toBe(tf);
  });

  it('accepts the arg positionally, by name, and reports na without one', () => {
    expect(call('timeframe.from_seconds', [], { seconds: intV(300) })).toEqual({ kind: 'string', v: '5' });
    expect(call('timeframe.from_seconds', [intV(86_400)])).toEqual({ kind: 'string', v: '1D' });
    expect(call('timeframe.from_seconds', [])).toBe(NA);
  });

  it('is the inverse of in_seconds: in_seconds(from_seconds(x)) never shrinks x', () => {
    // A month is 2628003 s, not 30 days — "When the timeframe is "1M" or more,
    // calculations use 2628003 as the number of seconds in one month, which
    // represents 30.4167 (365/12) days" (timeframe.md:170-172).
    expect(SECS('1M')).toBe(2_628_003);
    expect(SECS('12M')).toBe(31_536_036);

    const exact: [number, string][] = [
      [1, '1S'], [300, '5'], [3600, '60'], [86_400, '1D'], [604_800, '1W'],
      [1_209_600, '2W'], [2_628_003, '1M'], [5_256_006, '2M'],
    ];
    for (const [x, tf] of exact) {
      expect(FS(x), `from_seconds(${x})`).toBe(tf);
      expect(SECS(tf), `in_seconds("${tf}")`).toBe(x);
    }
    // Beyond 12M's length the string clamps, so only the representable range
    // round-trips upward.
    for (let x = 0; x <= 31_536_036; x += 9973) {
      const tf = FS(x) as string;
      expect(SECS(tf), `in_seconds(from_seconds(${x})) = in_seconds("${tf}")`).toBeGreaterThanOrEqual(x);
    }
  });
});

// ── weekofyear ──────────────────────────────────────────────────────────────

describe('weekofyear', () => {
  const weekAt = (iso: string, tz = 'UTC'): unknown =>
    num(call('weekofyear', [intV(Date.parse(iso)), strV(tz)]));

  it('is the ISO 8601 week of the timestamp in the given time zone', () => {
    expect(weekAt('2024-01-01T00:00:00Z')).toBe(1);
    expect(weekAt('2021-01-04T00:00:00Z')).toBe(1);   // first Monday: week 1
    expect(weekAt('2024-12-29T00:00:00Z')).toBe(52);  // Sunday closes week 52
    expect(weekAt('2024-12-30T00:00:00Z')).toBe(1);   // a late-December Monday is week 1 of 2025
    expect(weekAt('2025-01-01T00:00:00Z')).toBe(1);
    expect(weekAt('2022-01-01T00:00:00Z')).toBe(52);  // Jan 1-3 can be the previous year's last week
    expect(weekAt('2016-01-01T00:00:00Z')).toBe(53);
    expect(weekAt('2020-12-31T00:00:00Z')).toBe(53);
  });

  it('shifts with the time zone, because the week follows the local calendar date', () => {
    // 2025-01-05 20:00 UTC is still Sunday (week 1) in UTC, but Monday 04:00
    // in the exchange time zone (week 2).
    expect(weekAt('2025-01-05T20:00:00Z', 'UTC')).toBe(1);
    expect(weekAt('2025-01-05T20:00:00Z', 'Asia/Taipei')).toBe(2);
    // An unknown/absent zone falls back to syminfo.timezone.
    const ctx = mkCtx({ syminfo: { timezone: { kind: 'string', v: 'Asia/Taipei' } } });
    expect(num(call('weekofyear', [intV(Date.parse('2025-01-05T20:00:00Z'))], {}, ctx))).toBe(2);
  });

  it('bare `weekofyear` is a series over the bar opens, in the exchange time zone', () => {
    const times = [
      Date.parse('2024-12-27T00:00:00Z'),
      Date.parse('2024-12-29T00:00:00Z'),
      Date.parse('2024-12-30T00:00:00Z'),
    ];
    const ctx = mkCtx({ barIndex: 2, barCount: 3 });
    for (const t of times) ctx.time.set(intV(t));
    const c = getConstant('weekofyear', ctx);
    expect(c?.kind).toBe('series');
    if (c?.kind !== 'series') throw new Error('weekofyear must be a series constant');
    const s = c.v;
    expect(num(s.get(0))).toBe(1);   // 2024-12-30 → week 1 of 2025
    expect(num(s.get(1))).toBe(52);  // 2024-12-29 → week 52 of 2024
    expect(num(s.get(2))).toBe(52);  // 2024-12-27 → week 52 of 2024
    expect(num(s.get(3))).toBe('na');// older than the recorded history
    // No context → na (same shape as the other calendar lazy constants).
    expect(getConstant('weekofyear')).toBe(NA);
  });

  it('resolves in a script and reports the same week per bar', async () => {
    const r = await run('plot(weekofyear)');
    expect(firstPlot(r)).toEqual([52, 1, 1, 1, 1]);
    expect(r.warnings.filter((w) => /not found|unknown constant/.test(w))).toEqual([]);
  });
});

// ── timenow ─────────────────────────────────────────────────────────────────

describe('timenow', () => {
  it('is the host clock in milliseconds', () => {
    const before = Date.now();
    const v = getConstant('timenow')!;
    const after = Date.now();
    expect(v.kind).toBe('int');
    expect(num(v) as number).toBeGreaterThanOrEqual(before);
    expect(num(v) as number).toBeLessThanOrEqual(after);
  });

  it('resolves in a script without warnings', async () => {
    const r = await run('plot(timenow > 0 ? 1 : 0)');
    expect(firstPlot(r)).toEqual([1, 1, 1, 1, 1]);
    expect(r.warnings.filter((w) => /not found|unknown constant/.test(w))).toEqual([]);
  });
});

// ── registry shape ──────────────────────────────────────────────────────────

describe('registry', () => {
  it('registers the implemented names', () => {
    expect(BUILTINS.has('timeframe.from_seconds')).toBe(true);
    expect(BUILTINS.has('weekofyear')).toBe(true);
    expect(getConstant('weekofyear')).toBeDefined();
    expect(getConstant('timenow')).toBeDefined();
  });

  it('leaves ask/bid data-less (recorded decision, not an oversight)', () => {
    // docs/2026-10-13-remaining-work.md §F: a name with no data source keeps its
    // informative "unknown constant" warning instead of being registered as na —
    // "補 na 只會蓋掉有用的警告 / 維持警告比回 na 誠實". ask/bid are "available
    // only on the "1T" timeframe" (variables.md:61, 151), which this engine
    // never runs on, so they stay unregistered rather than answering a fixed na.
    expect(BUILTINS.has('ask')).toBe(false);
    expect(getConstant('ask')).toBeUndefined();
    expect(BUILTINS.has('bid')).toBe(false);
    expect(getConstant('bid')).toBeUndefined();
  });
});
