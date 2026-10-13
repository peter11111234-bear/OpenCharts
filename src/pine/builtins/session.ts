// ── session.* namespace ──────────────────────────────────────────────────────
// TradingView's session functions answer questions about the symbol venue's
// regular trading session. The interpreter has no exchange calendar, so the
// venue windows below are the ones this app supports; an unknown venue trades
// around the clock, which is Pine's default for 24-hour instruments. Extended
// hours are not modelled — syminfo.session is always 'regular' — so
// session.ispremarket / ispostmarket answer false instead of guessing.

import type { BuiltinCtx, Value } from '../contracts';
import { VFALSE, VTRUE } from '../contracts';
import { registerBuiltin, registerConstant } from './registry';
import { tfToMs } from '../mtf';
import { part, tzOf, zonedMs } from './time';

/** Regular-session window per venue prefix, minutes since local midnight. */
const VENUE_SESSIONS: Record<string, { startMin: number; endMin: number }> = {
  TWSE: { startMin: 9 * 60, endMin: 13 * 60 + 30 },
  TPEx: { startMin: 9 * 60, endMin: 13 * 60 + 30 },
  TAIFEX: { startMin: 8 * 60 + 45, endMin: 13 * 60 + 45 },
};

/** Session bounds (epoch ms) of the local calendar day holding `open`, or null
 *  for a venue with no regular session (trades 24 hours). */
function venueWindow(ctx: BuiltinCtx, open: number, tz: string): { startMs: number; endMs: number } | null {
  const prefix = ctx.syminfo['prefix'];
  const win = VENUE_SESSIONS[(prefix && prefix.kind === 'string' ? prefix.v : '').toUpperCase()];
  if (win === undefined) return null;
  const y = part(open, tz, 'year'), mo = part(open, tz, 'month'), d = part(open, tz, 'day');
  return {
    startMs: zonedMs(tz, y, mo, d, Math.floor(win.startMin / 60), win.startMin % 60, 0),
    endMs: zonedMs(tz, y, mo, d, Math.floor(win.endMin / 60), win.endMin % 60, 0),
  };
}

/** Evaluate one session predicate on the current bar. A bar whose length is
 *  unknown (a calendar timeframe) cannot be placed inside a session, so the
 *  flags answer false there. */
const sessionFlag = (
  decide: (
    ctx: BuiltinCtx,
    win: { startMs: number; endMs: number } | null,
    open: number,
    barMs: number,
  ) => boolean,
) => (ctx: BuiltinCtx): Value => {
  const v = ctx.time.get(0);
  if (v.kind !== 'int' && v.kind !== 'float') return VFALSE;
  const barMs = tfToMs(ctx.timeframe.period) ?? 0;
  if (barMs <= 0) return VFALSE;
  return decide(ctx, venueWindow(ctx, v.v, tzOf(ctx)), v.v, barMs) ? VTRUE : VFALSE;
};

registerBuiltin('session', 'ismarket', sessionFlag((_ctx, win, open) =>
  win === null || (open >= win.startMs && open < win.endMs)));
registerBuiltin('session', 'isfirstbar', sessionFlag((_ctx, win, open, barMs) =>
  win !== null && open >= win.startMs && open < win.startMs + barMs));
registerBuiltin('session', 'islastbar', sessionFlag((_ctx, win, open, barMs) =>
  win !== null && open < win.endMs && open + barMs >= win.endMs));
// The _regular variants differ from the plain ones only where extended hours
// exist; under a regular-only template they answer the same.
registerBuiltin('session', 'isfirstbar_regular', sessionFlag((_ctx, win, open, barMs) =>
  win !== null && open >= win.startMs && open < win.startMs + barMs));
registerBuiltin('session', 'islastbar_regular', sessionFlag((_ctx, win, open, barMs) =>
  win !== null && open < win.endMs && open + barMs >= win.endMs));
// No extended-hours feed exists in this app, so these are false, not guessed.
registerBuiltin('session', 'ispremarket', () => VFALSE);
registerBuiltin('session', 'ispostmarket', () => VFALSE);

registerConstant('session', 'regular', { kind: 'string', v: 'regular' });
registerConstant('session', 'extended', { kind: 'string', v: 'extended' });
registerConstant('session', 'premarket', { kind: 'string', v: 'premarket' });
registerConstant('session', 'postmarket', { kind: 'string', v: 'postmarket' });
