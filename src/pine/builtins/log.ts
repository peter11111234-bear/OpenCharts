// ── log.* — script output for the "Pine logs" pane ──────────────────────────
// TV's surface (read off the official v6 reference bundle, see
// docs/tv-pine-stdlib.json):
//   log.info(message) → void
//   log.info(formatString, arg0, arg1, …) → void
// and the same for log.warning / log.error. The remarks of those entries point
// at str.format(), so the placeholders use the identical grammar and both share
// pineFormat().
//
// Every call appends one record to `ctx.logs` (level, bar, message), which
// runScript copies to `RunResult.logs`. The engine does not render them yet —
// the host app owns the logs pane — but the script no longer fails with
// "identifier not found", and the output is observable.

import type { BuiltinCtx, ScriptLog, Value } from '../contracts';
import { registerBuiltin } from './registry';
import { asStr } from './util';
import { cur, pineFormat } from './str';

/** Shared body of log.info / log.warning / log.error. */
function emit(ctx: BuiltinCtx, level: ScriptLog['level'], args: Value[], named: Record<string, Value>): Value {
  const first = args[0];
  if (first === undefined || first.kind === 'na') {
    ctx.logs.push({ level, bar: ctx.barIndex, msg: 'NaN' });
    return { kind: 'void' };
  }
  // The formatter works on current-bar values, like every other string builtin.
  const rest = args.slice(1).map(cur);
  const template = asStr(cur(first));
  ctx.logs.push({ level, bar: ctx.barIndex, msg: pineFormat(ctx, template, rest, named) });
  return { kind: 'void' };
}

registerBuiltin('log', 'info', (c, args, named) => emit(c, 'info', args, named));
registerBuiltin('log', 'warning', (c, args, named) => emit(c, 'warning', args, named));
registerBuiltin('log', 'error', (c, args, named) => emit(c, 'error', args, named));
