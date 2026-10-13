// ── session.* and session-aware time() / time_close() ────────────────────────
// Bars are 30 minutes on 2024-06-03 (a Monday), 00:00–08:00 UTC. Asia/Taipei is
// UTC+8, so the TW venue session 09:00–13:30 local is 01:00–05:30 UTC.

import { describe, expect, it } from 'vitest';
import type { BarData, BuiltinCtx, Value } from '../contracts';
import { BarCtx } from '../context';
import { BUILTINS } from '../builtins';

const MIN = 60_000;

function twBars(): BarData[] {
  const start = Date.UTC(2024, 5, 3, 0, 0, 0);
  return Array.from({ length: 17 }, (_, i) => ({
    openTime: start + i * 30 * MIN,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10,
  }));
}

const intV = (v: number): Value => ({ kind: 'int', v });
const strV = (v: string): Value => ({ kind: 'string', v });

function ctxAt(index: number, symbol = 'TWSE:2330', market = '30'): BuiltinCtx {
  return new BarCtx(twBars(), { market, symbol }).seek(index);
}

const call = (
  key: string,
  ctx: BuiltinCtx,
  args: Value[] = [],
  named: Record<string, Value> = {},
): Value => {
  const fn = BUILTINS.get(key);
  if (!fn) throw new Error(`missing builtin ${key}`);
  return fn(ctx, args, named);
};

describe('session.*', () => {
  it('ismarket is true inside the TW session and false outside', () => {
    expect(call('session.ismarket', ctxAt(2))).toEqual({ kind: 'bool', v: true });   // 09:00 local
    expect(call('session.ismarket', ctxAt(10))).toEqual({ kind: 'bool', v: true });  // 13:00 local
    expect(call('session.ismarket', ctxAt(1))).toEqual({ kind: 'bool', v: false });  // 08:30 local
    expect(call('session.ismarket', ctxAt(12))).toEqual({ kind: 'bool', v: false }); // 14:00 local
    expect(call('session.ismarket', ctxAt(0))).toEqual({ kind: 'bool', v: false });  // 08:00 local
  });

  it('isfirstbar is true only on the bar that opens the session', () => {
    expect(call('session.isfirstbar', ctxAt(2))).toEqual({ kind: 'bool', v: true });
    expect(call('session.isfirstbar', ctxAt(3))).toEqual({ kind: 'bool', v: false });
    expect(call('session.isfirstbar_regular', ctxAt(2))).toEqual({ kind: 'bool', v: true });
  });

  it('islastbar is true only on the bar that covers the session close', () => {
    expect(call('session.islastbar', ctxAt(10))).toEqual({ kind: 'bool', v: true });  // 13:00–13:30
    expect(call('session.islastbar', ctxAt(9))).toEqual({ kind: 'bool', v: false });  // 12:30–13:00
    expect(call('session.islastbar_regular', ctxAt(10))).toEqual({ kind: 'bool', v: true });
  });

  it('a venue without a session template trades 24 hours', () => {
    const ctx = ctxAt(0, 'BINANCE:BTCUSDT');
    expect(call('session.ismarket', ctx)).toEqual({ kind: 'bool', v: true });
    expect(call('session.isfirstbar', ctx)).toEqual({ kind: 'bool', v: false });
    expect(call('session.islastbar', ctx)).toEqual({ kind: 'bool', v: false });
  });

  it('ispremarket/ispostmarket are false without an extended-hours feed', () => {
    expect(call('session.ispremarket', ctxAt(2))).toEqual({ kind: 'bool', v: false });
    expect(call('session.ispostmarket', ctxAt(2))).toEqual({ kind: 'bool', v: false });
  });
});

describe('time() and time_close() with a session', () => {
  const sessionArgs = [strV('D'), strV('0900-1330'), strV('Asia/Taipei')];

  it('time(...) is the session open on session bars and na outside', () => {
    expect(call('time', ctxAt(2), sessionArgs)).toEqual(intV(Date.UTC(2024, 5, 3, 1, 0, 0)));
    expect(call('time', ctxAt(10), sessionArgs)).toEqual(intV(Date.UTC(2024, 5, 3, 1, 0, 0)));
    expect(call('time', ctxAt(1), sessionArgs)).toEqual({ kind: 'na' });
    expect(call('time', ctxAt(12), sessionArgs)).toEqual({ kind: 'na' });
  });

  it('time_close(...) is the session close on session bars and na outside', () => {
    expect(call('time_close', ctxAt(2), sessionArgs)).toEqual(intV(Date.UTC(2024, 5, 3, 5, 30, 0)));
    expect(call('time_close', ctxAt(12), sessionArgs)).toEqual({ kind: 'na' });
  });

  it('an intraday timeframe answers with the bar open', () => {
    expect(call('time', ctxAt(3), [strV('30'), strV('0900-1330'), strV('Asia/Taipei')]))
      .toEqual(intV(Date.UTC(2024, 5, 3, 1, 30, 0)));
  });

  it('the plain form keeps TV semantics: na unless the bar opens its period', () => {
    // 30-minute bars: every bar opens its own period, so all are non-na.
    expect(call('time', ctxAt(3), [strV('30')])).toEqual(intV(Date.UTC(2024, 5, 3, 1, 30, 0)));
    // Daily period: only the first bar of the day opens it.
    expect(call('time', ctxAt(0), [strV('D')])).toEqual(intV(Date.UTC(2024, 5, 3, 0, 0, 0)));
    expect(call('time', ctxAt(3), [strV('D')])).toEqual({ kind: 'na' });
  });
});

describe('time() bars_back', () => {
  it('walks a daily grid backwards inside the same year', () => {
    const ctx = ctxAt(0, 'BINANCE:BTCUSDT', 'D');
    expect(call('time', ctx, [strV('D')], { bars_back: intV(1) })).toEqual(intV(Date.UTC(2024, 5, 2)));
    expect(ctx.warnings).toHaveLength(0);
  });

  it('reports a walk that crosses the turn of the year instead of guessing', () => {
    const start = Date.UTC(2024, 0, 1);
    const bars: BarData[] = [{
      openTime: start, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1,
    }];
    const ctx = new BarCtx(bars, { market: 'D', symbol: 'BINANCE:BTCUSDT' }).seek(0);
    // The arithmetic value is returned, and the unsupported case is named once.
    expect(call('time', ctx, [strV('D')], { bars_back: intV(1) })).toEqual(intV(Date.UTC(2023, 11, 31)));
    expect(ctx.warnings.filter((w) => /turn of the year/.test(w))).toHaveLength(1);
  });
});
