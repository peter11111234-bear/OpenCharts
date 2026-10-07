// ── color.* builtins ────────────────────────────────────────────────────────
// Colors normalize to '#RRGGBB' when opaque, 'rgba(r, g, b, a)' otherwise.
// Transparency is 0–100 (TV convention); alpha internally 0–1.

import { NA } from '../contracts';
import type { Value } from '../contracts';
import { registerBuiltin, registerConstant } from './registry';
import { asNum, bindArgs } from './util';

export interface Rgba {
  r: number; // 0–255
  g: number;
  b: number;
  a: number; // 0–1
}

const NAMED_HEX: Record<string, string> = {
  white: '#FFFFFF', black: '#000000', red: '#FF0000', green: '#008000',
  blue: '#0000FF', orange: '#FF8000', purple: '#800080', yellow: '#FFFF00',
  gray: '#808080', aqua: '#00FFFF', fuchsia: '#FF00FF', lime: '#00FF00',
  maroon: '#800000', navy: '#000080', olive: '#808000', silver: '#C0C0C0',
  teal: '#008080',
};

/** Parse '#RGB' | '#RRGGBB' | '#RRGGBBAA' | 'rgb(...)' | 'rgba(...)' | named. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  const hex = NAMED_HEX[s] ?? input.trim();
  if (hex.startsWith('#')) {
    const h = hex.slice(1);
    if (!/^[0-9a-fA-F]+$/.test(h)) return null;
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    if (full.length === 6) {
      return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
        a: 1,
      };
    }
    if (full.length === 8) {
      return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
        a: parseInt(full.slice(6, 8), 16) / 255,
      };
    }
    return null;
  }
  const m = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(
    input.trim(),
  );
  if (!m) return null;
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function toColorString(c: Rgba): string {
  const r = clamp255(c.r);
  const g = clamp255(c.g);
  const b = clamp255(c.b);
  const a = Math.max(0, Math.min(1, c.a));
  if (a >= 0.999) {
    const h = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  const alpha = Math.round(a * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Normalize any color-ish Value → Rgba, or null for na/unparseable. */
function rgbaOf(v: Value | undefined): Rgba | null {
  // evalArg wraps scalars in per-callsite BarSeries — unwrap to current value.
  if (v?.kind === 'series') v = v.v.cur();
  if (!v || v.kind === 'na') return null;
  const s = v.kind === 'color' ? v.v : v.kind === 'string' ? v.v : null;
  return s === null ? null : parseColor(s);
}

const colVal = (c: Rgba): Value => ({ kind: 'color', v: toColorString(c) });

// color.new(color, transp) — adjust alpha; transp 0 = opaque, 100 = invisible.
registerBuiltin('color', 'new', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['color', 'transp']);
  const base = rgbaOf(bound.get('color'));
  if (base === null) return NA;
  const tV = bound.get('transp');
  const transp = tV === undefined || tV.kind === 'na' ? 0 : asNum(tV);
  return colVal({ ...base, a: 1 - Math.max(0, Math.min(100, transp)) / 100 });
});

// color.rgb(red, green, blue, transp=0)
registerBuiltin('color', 'rgb', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['red', 'green', 'blue', 'transp']);
  const r = bound.get('red');
  const g = bound.get('green');
  const b = bound.get('blue');
  if (!r || r.kind === 'na' || !g || g.kind === 'na' || !b || b.kind === 'na') return NA;
  const tV = bound.get('transp');
  const transp = tV === undefined || tV.kind === 'na' ? 0 : asNum(tV);
  return colVal({
    r: asNum(r),
    g: asNum(g),
    b: asNum(b),
    a: 1 - Math.max(0, Math.min(100, transp)) / 100,
  });
});

// color.from_gradient(value, bottom_value, top_value, bottom_color, top_color)
registerBuiltin('color', 'from_gradient', (_ctx, args, named) => {
  const bound = bindArgs(args, named, [
    'value',
    'bottom_value',
    'top_value',
    'bottom_color',
    'top_color',
  ]);
  const v = bound.get('value');
  const lo = bound.get('bottom_value');
  const hi = bound.get('top_value');
  if (!v || v.kind === 'na' || !lo || lo.kind === 'na' || !hi || hi.kind === 'na') return NA;
  const c0 = rgbaOf(bound.get('bottom_color'));
  const c1 = rgbaOf(bound.get('top_color'));
  if (c0 === null || c1 === null) return NA;
  const vn = asNum(v);
  const loN = asNum(lo);
  const hiN = asNum(hi);
  const t = hiN === loN ? 0 : Math.max(0, Math.min(1, (vn - loN) / (hiN - loN)));
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return colVal({
    r: lerp(c0.r, c1.r),
    g: lerp(c0.g, c1.g),
    b: lerp(c0.b, c1.b),
    a: lerp(c0.a, c1.a),
  });
});

// Channel extractors: color.r/g/b → 0–255 int; color.t → transparency 0–100.
for (const ch of ['r', 'g', 'b'] as const) {
  registerBuiltin('color', ch, (_ctx, args, named) => {
    const bound = bindArgs(args, named, ['color']);
    const c = rgbaOf(bound.get('color'));
    return c === null ? NA : { kind: 'int', v: clamp255(c[ch]) };
  });
}
registerBuiltin('color', 't', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['color']);
  const c = rgbaOf(bound.get('color'));
  return c === null ? NA : { kind: 'float', v: (1 - Math.max(0, Math.min(1, c.a))) * 100 };
});

// ── Named constants + color.na ──────────────────────────────────────────────

for (const [name, hex] of Object.entries(NAMED_HEX)) {
  const v: Value = { kind: 'color', v: hex };
  registerConstant('color', name, v);
  // Callable form too: color.red() appears in some scripts.
  registerBuiltin('color', name, () => v);
}
registerConstant('color', 'na', NA);
registerBuiltin('color', 'na', () => NA);
