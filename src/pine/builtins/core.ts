// ── Core Pine builtins: casts, na(), fixnan, runtime.error, typed-na ctors ──
// Pine v5: `na(x)` is a function; int/float/bool/color/string are casts;
// fixnan looks back for the last non-na value; runtime.error aborts the run.
// Typed-na constructors (line(na), label(na), …) collapse to plain na — the
// drawing layer never receives a typed-na placeholder.

import type { Value } from '../contracts';
import { NA, VFALSE, VTRUE } from '../contracts';
import { registerBuiltin } from './registry';
import { asNum, asStr } from './util';
import { pineErr } from '../errors';

const unser = (v: Value | undefined): Value | undefined =>
  v?.kind === 'series' ? v.v.cur() : v;

registerBuiltin('', 'na', (_c, args) => {
  const v = unser(args[0]);
  return v === undefined || v.kind === 'na' ? VTRUE : VFALSE;
});

registerBuiltin('', 'int', (_c, args) => {
  const v = unser(args[0]);
  if (v === undefined || v.kind === 'na') return NA;
  if (v.kind === 'int') return v;
  if (v.kind === 'float' || v.kind === 'bool') return { kind: 'int', v: Math.trunc(asNum(v)) };
  if (v.kind === 'string' || v.kind === 'color') { const n = Number(v.v); return Number.isNaN(n) ? NA : { kind: 'int', v: Math.trunc(n) }; }
  return NA;
});
registerBuiltin('', 'float', (_c, args) => {
  const v = unser(args[0]);
  if (v === undefined || v.kind === 'na') return NA;
  if (v.kind === 'float') return v;
  if (v.kind === 'int' || v.kind === 'bool' || v.kind === 'string' || v.kind === 'color') return { kind: 'float', v: asNum(v) };
  return NA;
});
registerBuiltin('', 'bool', (_c, args) => {
  const v = unser(args[0]);
  if (v === undefined || v.kind === 'na') return NA;
  if (v.kind === 'bool') return v;
  if (v.kind === 'int' || v.kind === 'float') return { kind: 'bool', v: v.v !== 0 };
  if (v.kind === 'string') return { kind: 'bool', v: v.v === 'true' || v.v === '1' };
  return NA;
});
registerBuiltin('', 'color', (_c, args) => {
  const v = unser(args[0]);
  if (v === undefined || v.kind === 'na') return NA;
  if (v.kind === 'color') return v;
  if (v.kind === 'string') return { kind: 'color', v: v.v };
  if (v.kind === 'int' || v.kind === 'float') return { kind: 'color', v: asStr(v) };
  return NA;
});
registerBuiltin('', 'string', (_c, args) => ({ kind: 'string', v: asStr(unser(args[0]) ?? NA) }));
registerBuiltin('', 'str', (_c, args) => ({ kind: 'string', v: asStr(unser(args[0]) ?? NA) }));

registerBuiltin('', 'fixnan', (_ctx, args) => {
  const v = args[0];
  if (v === undefined) return NA;
  if (v.kind === 'series') {
    for (let off = 0; off < v.v.size(); off++) {
      const h = v.v.get(off);
      if (h.kind !== 'na') return h;
    }
    return NA;
  }
  return v.kind === 'na' ? NA : v;
});

registerBuiltin('runtime', 'error', (_ctx, args, _n) => {
  const msg = args[0] === undefined ? 'runtime error' : asStr(unser(args[0])!);
  throw pineErr(undefined, msg);
});

// Typed-na constructors: line(na)/label(na)/box(na) → plain na (Pine-compatible).
for (const k of ['line', 'label', 'box', 'table', 'chart.point'] as const) {
  const [ns, name] = k.includes('.') ? (k.split('.') as [string, string]) : ['', k] as [string, string];
  registerBuiltin(ns, name, (_c, args) => {
    const v = unser(args[0]);
    return v === undefined || v.kind === 'na' ? NA : { kind: 'na', v: null } as Value;
  });
}
