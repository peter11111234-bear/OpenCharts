// ── map.* builtins ──────────────────────────────────────────────────────────
// Maps are {kind:'map', v:Map<string,Value>} — mutated in place like arrays
// (Pine reference semantics). TV v6 map keys are typed (int/float/bool/string/
// color); this engine stores every key as one canonical string, tagged per key
// kind, so `map<int,..>` key 1 and `map<string,..>` key "1" never collide.
//
// The encoding is injective: a string key whose text starts with the tag byte
// is escaped with an `s:` prefix, and every non-string kind is tagged. So
// `map.keys()` round-trips the original key Value. Untagged keys are plain
// strings — which also keeps `obj.kind === 'map'` member access in the
// interpreter (`m.foo` → key "foo") consistent with `map.get(m, "foo")`.

import { NA } from '../contracts';
import type { BuiltinCtx, Value } from '../contracts';
import { PineRuntimeError } from '../errors';
import { registerBuiltin } from './registry';
import { bindArgs, unwrapped } from './util';

const VOID: Value = { kind: 'void' };
/** Key-encoding tag. A string key that starts with it is escaped (`s:`). */
const TAG = '\u0001';

/** Canonical string form of a map key (see the file header for the encoding). */
function keyOf(v: Value | undefined): string {
  const u = v === undefined ? NA : unwrapped(v)!;
  switch (u.kind) {
    case 'string': return u.v.startsWith(TAG) ? `${TAG}s:${u.v}` : u.v;
    case 'int': return `${TAG}i:${u.v}`;
    case 'float': return `${TAG}f:${u.v}`;
    case 'bool': return `${TAG}b:${u.v ? 1 : 0}`;
    case 'color': return `${TAG}c:${u.v}`;
    case 'na': return `${TAG}n`;
    default:
      throw new PineRuntimeError(
        `map key must be int, float, bool, string or color (got ${u.kind})`);
  }
}

/** Inverse of `keyOf` — rebuilds the key Value for `map.keys()`. */
function keyValueOf(k: string): Value {
  if (!k.startsWith(TAG)) return { kind: 'string', v: k };
  const body = k.slice(TAG.length);
  const raw = body.slice(2);
  switch (body.slice(0, 2)) {
    case 's:': return { kind: 'string', v: raw };
    case 'i:': return { kind: 'int', v: Number(raw) };
    case 'f:': return { kind: 'float', v: Number(raw) };
    case 'b:': return { kind: 'bool', v: raw === '1' };
    case 'c:': return { kind: 'color', v: raw };
    default: return NA;               // `${TAG}n`
  }
}

// Args arrive as {kind:'series'} when the ident is series-bound; unwrap cur()
// before the kind check — same convention as array.ts's asArr.
const asMap = (v: Value | undefined): Map<string, Value> | null => {
  if (v === undefined) return null;
  const u = unwrapped(v)!;
  return u.kind === 'map' ? u.v : null;
};

/** Bind args and hand the map receiver to `f`; non-map receivers → na. */
const withMap = (
  order: readonly string[],
  f: (m: Map<string, Value>, bound: Map<string, Value>) => Value,
) =>
  (_ctx: BuiltinCtx, args: Value[], named: Record<string, Value>): Value => {
    const bound = bindArgs(args, named, order);
    const m = asMap(bound.get('id'));
    return m === null ? NA : f(m, bound);
  };

// ── Construction ────────────────────────────────────────────────────────────
// `map.new<KT, VT>()` / `map.new<KT, VT>(k1, v1, k2, v2, …)`: the parser drops
// the type args (v1) and the initial pairs are variadic positional args. Every
// arg is a stash (values keep live-series semantics) — same as array.from.
// Values are SNAPSHOTs, like array elements: `map.put(m, k, close)` stores the
// current close, not a live series handle.

registerBuiltin('map', 'new', (_ctx, args) => {
  const m = new Map<string, Value>();
  for (let i = 0; i + 1 < args.length; i += 2) m.set(keyOf(args[i]), unwrapped(args[i + 1]) ?? NA);
  return { kind: 'map', v: m };
}, true);

// ── Access ──────────────────────────────────────────────────────────────────

registerBuiltin('map', 'get', withMap(['id', 'key'], (m, b) => m.get(keyOf(b.get('key'))) ?? NA));

registerBuiltin('map', 'contains', withMap(['id', 'key'], (m, b) =>
  ({ kind: 'bool', v: m.has(keyOf(b.get('key'))) })));

registerBuiltin('map', 'size', withMap(['id'], (m) => ({ kind: 'int', v: m.size })));

registerBuiltin('map', 'keys', withMap(['id'], (m) =>
  ({ kind: 'array', v: [...m.keys()].map(keyValueOf) })));

registerBuiltin('map', 'values', withMap(['id'], (m) =>
  ({ kind: 'array', v: [...m.values()] })));

registerBuiltin('map', 'copy', withMap(['id'], (m) => ({ kind: 'map', v: new Map(m) })));

// ── Mutation ────────────────────────────────────────────────────────────────

registerBuiltin('map', 'put', withMap(['id', 'key', 'value'], (m, b) => {
  const v = unwrapped(b.get('value')) ?? NA;
  m.set(keyOf(b.get('key')), v);
  return v;
}), { idx: [2], names: ['value'] });

registerBuiltin('map', 'put_all', withMap(['id', 'id2'], (m, b) => {
  const src = asMap(b.get('id2'));
  if (src !== null) for (const [k, v] of src) m.set(k, v);
  return VOID;
}));

registerBuiltin('map', 'remove', withMap(['id', 'key'], (m, b) => {
  const k = keyOf(b.get('key'));
  const v = m.get(k);
  m.delete(k);
  return v ?? NA;
}));

registerBuiltin('map', 'clear', withMap(['id'], (m) => {
  m.clear();
  return VOID;
}));
