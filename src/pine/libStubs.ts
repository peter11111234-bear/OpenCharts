// ── Imported-library stubs ───────────────────────────────────────────────────
// TradingView never publishes library source, so an `import`ed namespace can't
// be executed faithfully. Phase 1 substitutes an inert namespace: every call
// yields `na` / `false` / `void`, or a placeholder instance whose methods yield
// placeholders. The rest of the script runs instead of dying on
// "identifier 'zigzag' not found".
//
// KNOWN LIMITATION: TradingView/ZigZag is backed by our own pivot detector
// (`zigzag.ts`), so Fibonacci lines are drawn but need not match TradingView's
// numbers. TradersReality/Traders_Reality_Lib stays inert — Liquidity Zones are
// still empty by construction.

import { NA, VFALSE, VTRUE, type BuiltinCtx, type BuiltinFn, type UdtInstance, type Value } from './contracts';
import { createZigZagState, zigZagLastPivot, zigZagStep, type ZigZagPoint } from './zigzag';
// `evalArg` hands every argument to a builtin as a per-callsite BarSeries, so a
// `settings` UDT arrives `{kind:'series'}` — unwrap before switching on kind.
import { unwrapped } from './builtins/util';

/** Field map that answers `na` for any field never written. A placeholder
 *  instance therefore accepts the script's own writes (`settings.devThreshold
 *  := …`) and reads back `na` instead of failing the field lookup. */
class StubFields extends Map<string, Value> {
  override get(k: string): Value {
    return super.get(k) ?? NA;
  }
}

/** Placeholder instance. The typeName is prefixed so it can never collide with
 *  a user `type` declaration (`udt.ts` validates fields only for registered
 *  types, so unknown stub fields stay writable). */
function stubInstance(typeName: string): Value {
  const inst: UdtInstance = { typeName: `lib.${typeName}`, fields: new StubFields() };
  return { kind: 'udt', v: inst };
}

const naFn: BuiltinFn = () => NA;
const voidFn: BuiltinFn = () => ({ kind: 'void' });

function udtField(typeName: string, fields: Record<string, Value>): Value {
  const inst: UdtInstance = { typeName: `lib.${typeName}`, fields: new StubFields(Object.entries(fields)) };
  return { kind: 'udt', v: inst };
}

const fn = (f: BuiltinFn): Value => ({ kind: 'function', v: f });

// ── TradingView/ZigZag ───────────────────────────────────────────────────────
// The library source is unavailable, but its behaviour is reproducible: a
// deviation/depth pivot detector. `zigzagNamespace` therefore drives our own
// `zigzag.ts` state machine (see the note there — values are NOT guaranteed to
// match TradingView).
//
// Calls made by the script: `zigzag.Settings.new(...)`, `zigzag.newInstance(…)`,
// `zigZag.update()`, `zigZag.lastPivot()`, plus `settings.devThreshold := …`.

/** Number from a possibly series-wrapped value; `na`/other kinds → undefined. */
function stubNum(v: Value | undefined): number | undefined {
  const u = unwrapped(v);
  if (u === undefined) return undefined;
  if (u.kind === 'int' || u.kind === 'float') return Number.isFinite(u.v) ? u.v : undefined;
  return undefined;
}

/** A zigzag point as the Pivot's `start`/`end`: TradingView's Pivot holds real
 *  `chart.point`s, so `line.set_first_point(lineLast, lastP.start)` must accept
 *  it — that builtin only takes `typeName === 'chart.point'`. `bar` is our own
 *  extra field (chart.point's `index` carries the same bar). */
function stubPoint(p: ZigZagPoint): Value {
  const fields = new Map<string, Value>([
    ['time', { kind: 'int', v: p.time }],
    ['index', { kind: 'int', v: p.bar }],
    ['bar', { kind: 'int', v: p.bar }],
    ['price', { kind: 'float', v: p.price }],
  ]);
  return { kind: 'udt', v: { typeName: 'chart.point', fields } };
}

const SETTINGS_TYPE = 'TradingView/ZigZag.Settings';

function zigzagNamespace(): Value {
  return udtField('TradingView/ZigZag', {
    // `zigzag.Settings.new(devThreshold, depth, …)` — `devThreshold` is the
    // constructor's initial deviation, `depth` the second parameter; the rest
    // (color, booleans, style, …) is not consulted by our detector.
    Settings: udtField(SETTINGS_TYPE, {
      new: fn((_ctx, args) => udtField(SETTINGS_TYPE, {
        devThreshold: unwrapped(args[0]) ?? NA,
        depth: unwrapped(args[1]) ?? NA,
      })),
    }),
    // `var zigzag.Pivot lastP = na` — type annotation only.
    Pivot: stubInstance('TradingView/ZigZag.Pivot'),
    // `zigzag.newInstance(settings)` — the instance keeps a reference to that
    // very Settings object, so the script's per-bar `settings.devThreshold := …`
    // is what `update()` reads (no copy).
    newInstance: fn((_ctx, args) => {
      const settings = unwrapped(args[0]);
      const state = createZigZagState();
      return udtField('TradingView/ZigZag.ZigZag', {
        update: fn((ctx: BuiltinCtx) => {
          const fields = settings?.kind === 'udt' ? settings.v.fields : undefined;
          // Per-bar bar data comes from the ctx series, current value.
          const bar = {
            index: ctx.barIndex,
            high: stubNum(ctx.high.get(0)) ?? NaN,
            low: stubNum(ctx.low.get(0)) ?? NaN,
            time: stubNum(ctx.time.get(0)) ?? NaN,
          };
          const confirmed = zigZagStep(
            state,
            bar,
            stubNum(fields?.get('devThreshold')),
            stubNum(fields?.get('depth')) ?? 0,
          );
          return confirmed ? VTRUE : VFALSE;
        }),
        lastPivot: fn(() => {
          const p = zigZagLastPivot(state);
          if (p === undefined) return NA;
          const fields = new Map<string, Value>([
            ['start', stubPoint(p.start)],
            ['end', stubPoint(p.end)],
          ]);
          return { kind: 'udt', v: { typeName: 'TradingView/ZigZag.Pivot', fields } };
        }),
      });
    }),
  });
}

// ── TradersReality/Traders_Reality_Lib ──────────────────────────────────────
// Calls made by the script: `trLib.calcPvsra(…)` (5-tuple destructure),
// `trLib.getPvsraFlagByColor(…)`, `trLib.updateZones(…)`, `trLib.cleanarr(…)`.
function tradersRealityNamespace(): Value {
  return udtField('TradersReality/Traders_Reality_Lib', {
    calcPvsra: fn(() => ({ kind: 'array', v: [NA, VFALSE, NA, NA, NA] })),
    getPvsraFlagByColor: fn(naFn),
    updateZones: fn(voidFn),
    cleanarr: fn(voidFn),
  });
}

const NAMESPACES: Record<string, () => Value> = {
  zigzag: zigzagNamespace,
  trLib: tradersRealityNamespace,
};

const BY_NAME: Record<string, () => Value> = {
  ZigZag: zigzagNamespace,
  Traders_Reality_Lib: tradersRealityNamespace,
};

/** Stub namespace for an `import <ns> as <alias>`, or undefined when no stub is
 *  known — the caller then keeps its "libraries not supported" warning. */
export function libStubNamespace(alias: string | undefined, name: string): Value | undefined {
  const make = (alias !== undefined ? NAMESPACES[alias] : undefined) ?? BY_NAME[name];
  return make?.();
}
