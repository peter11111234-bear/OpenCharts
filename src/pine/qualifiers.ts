// ── Pine type qualifiers (const / input / simple / series) ──────────────────
// TradingView's qualifier lattice, weakest first:
//   const ⊂ input ⊂ simple ⊂ series
// The interpreter never needed it — it evaluates one bar at a time and a value
// is whatever it computed. A compile-time CHECK does need it: TV refuses
// `input.int(close)` because `defval` must be `const`, and this engine would
// otherwise quietly record the first bar's close as the input default.
//
// Every inference here is one-directional and SOUND: `provenSeries` answers
// true only when the value demonstrably changes per bar. An "unknown" verdict
// therefore never rejects a script that runs, and the only risk left is missing
// a case — which is the acceptable direction for a gate.

import type { Node } from './contracts';
import { childNodes } from './astWalk';

/** Bare/member names whose value is the current bar (TV: series). */
const SERIES_NAMES = new Set([
  'open', 'high', 'low', 'close', 'volume', 'time', 'time_close',
  'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'bar_index', 'last_bar_index', 'last_bar_time',
  'strategy.equity', 'strategy.netprofit', 'strategy.grossprofit', 'strategy.grossloss',
  'strategy.openprofit', 'strategy.position_size', 'strategy.position_avg_price',
  'strategy.max_drawdown', 'strategy.max_runup',
]);

/** Namespace prefixes whose calls answer from the current bar. */
const SERIES_PREFIXES = ['ta.', 'request.', 'strategy.'];

/** input.* spellings whose `defval` TV documents as `const` — so a series
 *  default is a compile error there and a wrong default here.
 *  `input.source` is deliberately absent: its defval IS allowed to be a series.
 *  Bare `input` IS listed but exempted in checks.ts for price sources — see
 *  `provenPriceSource`: `input(close)` is TV's series overload (same as
 *  input.source), and builtins/input.ts implements exactly that branch. */
export const CONST_INPUTS = new Set([
  'input', 'input.bool', 'input.int', 'input.float', 'input.string', 'input.color',
  'input.time', 'input.timeframe', 'input.symbol', 'input.session', 'input.text_area',
  'input.price', 'input.enum',
]);

/** Builtin price series a bare `input(...)` may take as its default — the same
 *  list builtins/input.ts recognises as a source (SOURCES there). */
const SOURCE_NAMES: Record<string, true> = {
  open: true, high: true, low: true, close: true,
  hl2: true, hlc3: true, ohlc4: true, hlcc4: true,
  volume: true, time: true,
};

/** True when `node` names one of the builtin price series directly, so a bare
 *  `input(x)` is a source input rather than a scalar default. An alias
 *  (`p = ohlc4; input(p)`) does not count: builtins/input.ts matches the
 *  series object itself, and a declared name holds a copy-on-write wrapper,
 *  so at run time it takes the scalar branch and freezes at bar 0. */
export function provenPriceSource(node: Node): boolean {
  return node.type === 'ident' && SOURCE_NAMES[node.name] === true;
}

/** Resolves a global name to the expression that produced it (top-level decls). */
export type QualifierLookup = (name: string) => Node | undefined;

/** `a.b.c` for an ident/member chain, or null. */
function dottedName(node: Node): string | null {
  if (node.type === 'ident') return node.name;
  if (node.type === 'member' && !node.computed) {
    const base = dottedName(node.obj);
    return base === null ? null : `${base}.${node.prop}`;
  }
  return null;
}

/**
 * True only when `node` provably yields a per-bar value.
 *
 * `mutable` = globals that are `var`/`varip`/`typed` or reassigned anywhere;
 * those are series by TV's definition. A global that is never mutated is
 * resolved through `lookup` to its initializer, so `x = ta.sma(close, 2)` then
 * `input.int(x)` is still caught.
 */
export function provenSeries(
  node: Node,
  lookup?: QualifierLookup,
  mutable?: ReadonlySet<string>,
  seen: Set<string> = new Set(),
): boolean {
  switch (node.type) {
    case 'num': case 'str': case 'bool': case 'color': case 'na': return false;
    case 'histref': return true;                       // history of anything is series
    case 'ident': {
      const name = node.name;
      if (SERIES_NAMES.has(name)) return true;
      if (mutable?.has(name) === true) return true;     // var/varip/reassigned state
      if (seen.has(name) || lookup === undefined) return false;
      const init = lookup(name);
      if (init === undefined) return false;
      seen.add(name);
      return provenSeries(init, lookup, mutable, seen);
    }
    case 'member': {
      const chain = dottedName(node);
      if (chain !== null && SERIES_NAMES.has(chain)) return true;
      return false;                                    // syminfo/timeframe/chart are simple
    }
    case 'call': {
      const name = dottedName(node.callee);
      if (name !== null && SERIES_PREFIXES.some((p) => name.startsWith(p))) return true;
      // Any series argument makes the result a series (str.tostring(close), nz(close)…).
      return node.args.some((a) => provenSeries(a.value, lookup, mutable, seen));
    }
    case 'func': case 'arrow': case 'method': return false;
    default: {
      for (const child of childNodes(node)) {
        if (provenSeries(child, lookup, mutable, seen)) return true;
      }
      return false;
    }
  }
}

/** The argument named `defval` — positional slot 0 or the named arg. */
export function defvalArg(args: readonly { name?: string; value: Node }[]): Node | undefined {
  const named = args.find((a) => a.name === 'defval');
  if (named !== undefined) return named.value;
  const positional = args.find((a) => a.name === undefined);
  return positional?.value;
}
