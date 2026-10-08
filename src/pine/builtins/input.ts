// ── input.* builtins ────────────────────────────────────────────────────────
// Each input.* call does two things:
//   1. Records an InputSchemaLite into ctx.inputSchemas (prepare-time schema
//      collection; deduped by id since calls repeat every bar).
//   2. Returns the effective value: ctx.inputs[title|id] override if present,
//      else the defval.
// `input.source` resolves to a builtin price Series (open/high/low/close/
// hl2/hlc3/ohlc4/hlcc4/volume/time) — a Series Value, so history refs work.

import type { InputSchemaLite, Series, Value } from '../contracts';
import { NA } from '../contracts';
import { registerBuiltin } from './registry';
import {
  RtCtx, bindArgs, strArg, asNum, asStr, slugify,
} from './util';

const INPUT_ORDER = [
  'defval', 'title', 'minval', 'maxval', 'step', 'options',
  'group', 'inline', 'tooltip', 'confirm', 'display',
] as const;

const SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume', 'time'] as const;
type SourceName = (typeof SOURCES)[number];

function seriesNamed(ctx: RtCtx, name: string): Series | undefined {
  switch (name as SourceName) {
    case 'open': return ctx.open;
    case 'high': return ctx.high;
    case 'low': return ctx.low;
    case 'close': return ctx.close;
    case 'hl2': return ctx.hl2;
    case 'hlc3': return ctx.hlc3;
    case 'ohlc4': return ctx.ohlc4;
    case 'hlcc4': return ctx.hlcc4;
    case 'volume': return ctx.volume;
    case 'time': return ctx.time;
    default: return undefined;
  }
}

/** Reverse-detect which builtin series a defval refers to (for schema defval). */
function sourceNameOf(ctx: RtCtx, s: Series): string {
  for (const n of SOURCES) if (seriesNamed(ctx, n) === s) return n;
  return 'close';
}

/** Wrap a raw JS override or a Value into a Value of the requested kind. */
function coerceOverride(raw: unknown, kind: 'int' | 'float' | 'bool' | 'string' | 'color'): Value {
  if (raw !== null && typeof raw === 'object' && 'kind' in (raw as Value)) return raw as Value;
  switch (kind) {
    case 'int': return { kind: 'int', v: Math.trunc(Number(raw)) };
    case 'float': return { kind: 'float', v: Number(raw) };
    case 'bool': return { kind: 'bool', v: Boolean(raw) };
    case 'color': return { kind: 'color', v: String(raw) };
    default: return { kind: 'string', v: String(raw) };
  }
}

/** Scalar args arrive series-wrapped from the interpreter (evalArg); read the current value. */
function unwrapped(v: Value): Value {
  return v.kind === 'series' ? v.v.cur() : v;
}

function rawDefval(v: Value): unknown {
  switch (v.kind) {
    case 'int': case 'float': return v.v;
    case 'bool': return v.v;
    case 'string': case 'color': return v.v;
    default: return undefined;
  }
}

// Per-callsite memo of {id,title,schema,resolver}. schema.push is one-shot per
// run (ctx.inputSchemas is []-reset at run start). `resolver` is the function
// that derives the coerced return value from (defval, override) — bound once
// per callsite, called per bar with the fresh override.
//
// Cache lifetime: WeakMap<RtCtx> so each run's memo is dropped with the ctx.
// Cache key: ctx.callsite — already stable `#N` per Call node, and already
// composes with siteStack inside UDFs.
interface InputMemo {
  id: string;
  title: string;
  schemaPushed: boolean;
  // rawDefval-captured value — constant per run (input-qualified).
  resolved: Value;
}
let __inputSchemaBuilds = 0;
export { __inputSchemaBuilds }; // test instrumentation only

const INPUT_MEMO = new WeakMap<RtCtx, Map<string, InputMemo>>();
const inputMemoOf = (ctx: RtCtx): Map<string, InputMemo> => {
  let m = INPUT_MEMO.get(ctx);
  if (!m) { m = new Map(); INPUT_MEMO.set(ctx, m); }
  return m;
};

function recordAndOverride(
  ctx: RtCtx,
  bound: Map<string, Value>,
  type: string,
  defval: unknown,
  coerce: (defval: unknown, override: unknown) => Value,
): { id: string; title: string; value: Value } {
  const site = ctx.callsite ?? `g${ctx.miscSeq ?? 0}`;
  const memo = inputMemoOf(ctx).get(site);
  if (memo !== undefined) {
    // Re-read the override per bar — one dict lookup, correct if ctx.inputs
    // is ever injected mid-run. Fresh {...} wrapper — callers may mutate the
    // returned Value, so the memoized object must never escape.
    const override = ctx.inputs?.[memo.title] ?? ctx.inputs?.[memo.id];
    const v = override !== undefined ? coerce(memo.resolved, override) : memo.resolved;
    return { id: memo.id, title: memo.title, value: { ...v } };
  }
  __inputSchemaBuilds++;
  const title = strArg(bound, 'title', 'input');
  // Fallback id must be stable per call site: CJK titles slug to '' and a
  // per-call counter would mint a fresh id every bar, defeating the schema dedup.
  const id = slugify(title, `input_${site}`);

  const schema: InputSchemaLite = { id, name: title, type, defval };
  const minval = bound.get('minval');
  if (minval !== undefined && minval.kind !== 'na') schema.minval = asNum(minval);
  const maxval = bound.get('maxval');
  if (maxval !== undefined && maxval.kind !== 'na') schema.maxval = asNum(maxval);
  const step = bound.get('step');
  if (step !== undefined && step.kind !== 'na') schema.step = asNum(step);
  const options = bound.get('options');
  if (options?.kind === 'array') schema.options = options.v.map(rawDefval);
  const group = bound.get('group');
  if (group !== undefined && group.kind !== 'na') schema.group = asStr(group);
  const inline = bound.get('inline');
  if (inline !== undefined && inline.kind !== 'na') schema.inline = asStr(inline);
  const tooltip = bound.get('tooltip');
  if (tooltip !== undefined && tooltip.kind !== 'na') schema.tooltip = asStr(tooltip);

  ctx.inputSchemas ??= [];
  if (!ctx.inputSchemas.some(s => s.id === schema.id)) ctx.inputSchemas.push(schema);

  const resolved = coerce(defval, ctx.inputs?.[title] ?? ctx.inputs?.[id]);
  const entry: InputMemo = { id, title, schemaPushed: true, resolved };
  inputMemoOf(ctx).set(site, entry);
  // Fresh wrapper here too — memo.resolved must stay untouched by callers.
  return { id, title, value: { ...resolved } };
}

function scalarInput(
  kind: 'int' | 'float' | 'bool' | 'string' | 'color',
  schemaType: string,
  dflt: Value,
): (ctx: RtCtx, args: Value[], named: Record<string, Value>) => Value {
  return (ctx, args, named) => {
    const bound = bindArgs(args, named, INPUT_ORDER);
    const raw = rawDefval(unwrapped(bound.get('defval') ?? dflt));
    const { value } = recordAndOverride(ctx, bound, schemaType, raw, (dv, ov) => {
      const o = ov;
      // Vela's input panel sends '' for untouched color/string inputs — treat
      // an empty string as "no override" so the script's defval survives.
      if (o !== undefined && !(kind === 'color' && o === '')
          && !(kind === 'string' && o === '')) {
        return coerceOverride(o, kind);
      }
      // Normalize defval to the declared kind (input.int(10.5) → 10).
      return coerceOverride(dv, kind);
    });
    return value;
  };
}

registerBuiltin('input', 'int', scalarInput('int', 'int', { kind: 'int', v: 0 }));
registerBuiltin('input', 'float', scalarInput('float', 'float', { kind: 'float', v: 0 }));
registerBuiltin('input', 'bool', scalarInput('bool', 'bool', { kind: 'bool', v: false }));
registerBuiltin('input', 'string', scalarInput('string', 'string', { kind: 'string', v: '' }));
registerBuiltin('input', 'color', scalarInput('color', 'color', { kind: 'color', v: '#2962FF' }));
registerBuiltin('input', 'timeframe', scalarInput('string', 'timeframe', { kind: 'string', v: '' }));
registerBuiltin('input', 'session', scalarInput('string', 'session', { kind: 'string', v: '' }));
registerBuiltin('input', 'symbol', scalarInput('string', 'symbol', { kind: 'string', v: '' }));
registerBuiltin('input', 'text_area', scalarInput('string', 'text_area', { kind: 'string', v: '' }));
registerBuiltin('input', 'price', scalarInput('float', 'price', { kind: 'float', v: 0 }));

// input.time(defval, title, ...) → int timestamp
registerBuiltin('input', 'time', (ctx, args, named) => {
  const bound = bindArgs(args, named, INPUT_ORDER);
  const defval = unwrapped(bound.get('defval') ?? { kind: 'int', v: 0 } as Value);
  const { value } = recordAndOverride(ctx as RtCtx, bound, 'time', rawDefval(defval),
    (_dv, ov) => ov !== undefined
      ? { kind: 'int', v: Math.trunc(Number(ov)) }
      : { kind: 'int', v: Math.trunc(asNum(defval)) });
  return value;
});

// input.source(defval, title, ...) → Series Value
registerBuiltin('input', 'source', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, INPUT_ORDER);
  const defval = bound.get('defval') ?? { kind: 'series', v: ctx.close } as Value;

  const defName = defval.kind === 'series'
    ? sourceNameOf(ctx, defval.v)
    : defval.kind === 'string' ? defval.v : 'close';
  // Override: a series name ('close') or a live Series Value.
  const { value } = recordAndOverride(ctx, bound, 'source', defName, (_dv, ov) => {
    if (ov !== undefined) {
      if (ov !== null && typeof ov === 'object' && 'kind' in (ov as Value)) {
        return ov as Value;
      }
      const s = seriesNamed(ctx, String(ov));
      return s ? { kind: 'series', v: s } : { kind: 'series', v: ctx.close };
    }
    if (defval.kind === 'series') return defval;
    const s = seriesNamed(ctx, asStr(defval));
    return s ? { kind: 'series', v: s } : { kind: 'series', v: ctx.close };
  });
  return value;
});

// Generic `input(defval, title, ...)` — infers type from defval kind.
registerBuiltin('', 'input', (c, args, named) => {
  const ctx = c as RtCtx;
  const bound = bindArgs(args, named, INPUT_ORDER);
  const raw0 = bound.get('defval') ?? NA;
  // A builtin price series (input(close)) stays a source; any other series-wrapped
  // arg is a scalar defval and must be unwrapped before type inference.
  if (raw0.kind === 'series' && SOURCES.some(n => seriesNamed(ctx, n) === raw0.v)) {
    const { value } = recordAndOverride(ctx, bound, 'source', sourceNameOf(ctx, raw0.v),
      (_dv, ov) => {
        if (ov !== undefined) {
          const s = seriesNamed(ctx, String(ov));
          return s ? { kind: 'series', v: s } : raw0;
        }
        return raw0;
      });
    return value;
  }
  const defval = unwrapped(raw0);
  const kind: 'int' | 'float' | 'bool' | 'string' | 'color' =
    defval.kind === 'int' ? 'int'
    : defval.kind === 'float' ? 'float'
    : defval.kind === 'bool' ? 'bool'
    : defval.kind === 'color' ? 'color'
    : 'string';
  const raw = rawDefval(defval);
  const { value } = recordAndOverride(ctx, bound, kind, raw,
    (dv, ov) => ov !== undefined ? coerceOverride(ov, kind) : coerceOverride(dv, kind));
  return value;
});
