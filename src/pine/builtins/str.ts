// ── str.* builtins ──────────────────────────────────────────────────────────
// String formatting, conversion, and manipulation. `str.format` supports
// {N}, {name}, {N,date}, {N,time}, {N,time,pattern} placeholders.

import { NA, VFALSE, VTRUE } from '../contracts';
import type { BuiltinCtx, Value } from '../contracts';
import { registerBuiltin, registerConstant } from './registry';
import { asNum, asStr, bindArgs } from './util';
import { partsOf, tzOf } from './time';

const strVal = (v: string): Value => ({ kind: 'string', v });

/** Pine-style display string for any value (also used by array.join). */
export function toDisplay(v: Value): string {
  switch (v.kind) {
    case 'na':
      return 'NaN';
    case 'int':
    case 'float':
      return String(v.v);
    case 'bool':
      return v.v ? 'true' : 'false';
    case 'string':
      return v.v;
    case 'color':
      return v.v;
    case 'array':
      return `[${v.v.map(toDisplay).join(', ')}]`;
    case 'matrix':
      return `[${v.v.map((row) => `[${row.map(toDisplay).join(', ')}]`).join(', ')}]`;
    case 'map':
      return `{${[...v.v.entries()].map(([k, val]) => `${k}=${toDisplay(val)}`).join(', ')}}`;
    case 'udt':
      return v.v.typeName;
    case 'series':
      return toDisplay(v.v.cur());
    default:
      return v.kind;
  }
}

/** Unwrap a series to its current-bar value. */
const cur = (v: Value): Value => (v.kind === 'series' ? v.v.cur() : v);

// ── Numeric format patterns ─────────────────────────────────────────────────

// '#,##0.00'-style: count decimals from #/0 chars after '.', group on ','.
function fmtPattern(v: number, pat: string): string {
  const dot = pat.indexOf('.');
  const intPart = dot === -1 ? pat : pat.slice(0, dot);
  const frac = dot === -1 ? '' : pat.slice(dot + 1);
  let decimals = 0;
  for (const ch of frac) if (ch === '#' || ch === '0') decimals++;
  const grouping = intPart.includes(',');
  let out = Math.abs(v).toFixed(decimals);
  if (grouping) {
    const dotIdx = out.indexOf('.');
    const i = dotIdx === -1 ? out : out.slice(0, dotIdx);
    const f = dotIdx === -1 ? '' : out.slice(dotIdx);
    out = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + f;
  }
  return (v < 0 ? '-' : '') + out;
}

function mintickDecimals(ctx: BuiltinCtx): number {
  const t = ctx.syminfo['mintick'];
  if (!t || (t.kind !== 'int' && t.kind !== 'float') || t.v <= 0) return 2;
  const s = String(t.v);
  return s.includes('.') ? s.split('.')[1]!.length : 0;
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function fmtVolume(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return trimZeros((v / 1e9).toFixed(3)) + 'B';
  if (abs >= 1e6) return trimZeros((v / 1e6).toFixed(3)) + 'M';
  if (abs >= 1e3) return trimZeros((v / 1e3).toFixed(3)) + 'K';
  return String(v);
}

function numStr(v: number, fmt: string | undefined, ctx: BuiltinCtx): string {
  if (fmt === undefined) return String(v);
  if (fmt === 'format.mintick' || fmt === 'mintick' || fmt === 'format.price' || fmt === 'price') {
    return v.toFixed(mintickDecimals(ctx));
  }
  if (fmt === 'format.percent' || fmt === 'percent') return (v * 100).toFixed(2) + '%';
  if (fmt === 'format.volume' || fmt === 'volume') return fmtVolume(v);
  if (fmt === 'format.inherit' || fmt === 'inherit') return String(v);
  if (/[#0]/.test(fmt)) return fmtPattern(v, fmt);
  return String(v);
}

// ── Time formatting ─────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number, l = 2) => String(n).padStart(l, '0');

/** TV-pattern time formatter (yyyy MM MMM MMMM dd d HH H hh h mm ss SSS a EEE).
 *  Defaults to UTC; pass an IANA tz (e.g. syminfo.timezone) to format in-zone. */
export function fmtTime(ms: number, pat: string, tz?: string): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'NaN';
  let p: Record<string, number>;
  if (tz === undefined) {
    p = {
      yyyy: d.getUTCFullYear(), M: d.getUTCMonth() + 1, d: d.getUTCDate(),
      H: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(),
      S: d.getUTCMilliseconds(), w: d.getUTCDay(),
    };
  } else {
    const parts = partsOf(ms, tz);
    const g = (t: string): number => Number(parts.find((x) => x.type === t)?.value ?? 0);
    const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
      .indexOf(String(parts.find((x) => x.type === 'weekday')?.value ?? '').toLowerCase());
    p = {
      yyyy: g('year'), M: g('month'), d: g('day'),
      H: g('hour') === 24 ? 0 : g('hour'), m: g('minute'), s: g('second'),
      S: d.getUTCMilliseconds(), w: wd,
    };
  }
  const h24 = p.H!;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const table: Record<string, string> = {
    yyyy: String(p.yyyy), yy: pad(p.yyyy! % 100),
    MMMM: MONTHS[p.M! - 1]!, MMM: MONTHS[p.M! - 1]!.slice(0, 3), MM: pad(p.M!), M: String(p.M),
    dd: pad(p.d!), d: String(p.d),
    EEEE: DAYS[p.w!]!, EEE: DAYS[p.w!]!.slice(0, 3),
    HH: pad(h24), H: String(h24), hh: pad(h12), h: String(h12),
    mm: pad(p.m!), ss: pad(p.s!), SSS: pad(p.S!, 3),
    a: h24 < 12 ? 'AM' : 'PM',
  };
  return pat.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|ss|SSS|a/g, (t) => table[t] ?? t);
}

// ── str.tostring / str.tonumber ─────────────────────────────────────────────

registerBuiltin('str', 'tostring', (ctx, args, named) => {
  const bound = bindArgs(args, named, ['value', 'format']);
  const raw = bound.get('value') ?? named['v'];
  if (!raw) return strVal('NaN');
  const v = cur(raw);
  const fmtV = bound.get('format');
  if ((v.kind === 'int' || v.kind === 'float') && fmtV !== undefined && fmtV.kind !== 'na') {
    if (fmtV.kind === 'string') return strVal(numStr(v.v, fmtV.v, ctx));
    // Pine v4 compat: numeric second arg = decimal places.
    if (fmtV.kind === 'int' || fmtV.kind === 'float') {
      return strVal(v.v.toFixed(Math.max(0, Math.trunc(fmtV.v))));
    }
  }
  return strVal(toDisplay(v));
});

registerBuiltin('str', 'tonumber', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['string']);
  const s = bound.get('string');
  if (!s || s.kind === 'na') return NA;
  if (s.kind === 'int' || s.kind === 'float') return s;
  if (s.kind === 'bool') return { kind: 'int', v: s.v ? 1 : 0 };
  const t = asStr(s).replace(/,/g, '').trim();
  if (t === '') return NA;
  const n = Number(t);
  return Number.isNaN(n) ? NA : { kind: 'float', v: n };
});

// ── str.format ──────────────────────────────────────────────────────────────

registerBuiltin('str', 'format', (ctx, args, named) => {
  const tpl = args[0];
  if (!tpl || tpl.kind === 'na') return NA;
  const template = asStr(tpl);
  const positional = args.slice(1).map(cur);
  const lookup = (key: string): Value | undefined => {
    if (/^\d+$/.test(key)) return positional[Number(key)];
    return named[key];
  };
  const out = template.replace(/\{([^{}]+)\}/g, (_m, body: string) => {
    const parts = body.split(',');
    const v = lookup(parts[0]!.trim());
    if (v === undefined || v.kind === 'na') return 'NaN';
    if (parts.length === 1) return toDisplay(v);
    const spec = parts[1]!.trim();
    if (v.kind === 'int' || v.kind === 'float') {
      if (spec === 'date') return fmtTime(v.v, 'yyyy-MM-dd', tzOf(ctx));
      if (spec === 'time') return fmtTime(v.v, parts[2] !== undefined ? parts.slice(2).join(',') : 'HH:mm:ss', tzOf(ctx));
      if (spec === 'percent') return (v.v * 100).toFixed(2) + '%';
      if (spec === 'mintick') return v.v.toFixed(mintickDecimals(ctx));
      if (spec === 'volume') return fmtVolume(v.v);
      if (/[#0]/.test(spec)) return fmtPattern(v.v, spec);
      return String(v.v);
    }
    return toDisplay(v);
  });
  return strVal(out);
});

registerBuiltin('str', 'format_time', (ctx, args, named) => {
  const bound = bindArgs(args, named, ['time', 'format', 'timezone']);
  const t = bound.get('time');
  if (!t || t.kind === 'na') return NA;
  const v = cur(t);
  if (v.kind !== 'int' && v.kind !== 'float') return NA;
  const f = bound.get('format');
  const pat = !f || f.kind === 'na' ? 'yyyy-MM-dd HH:mm:ss' : asStr(f);
  const tzV = bound.get('timezone');
  const tzU = tzV !== undefined ? cur(tzV) : undefined;
  const tz = tzU !== undefined && tzU.kind === 'string' ? tzU.v : tzOf(ctx);
  return strVal(fmtTime(v.v, pat, tz));
});

// ── String manipulation ─────────────────────────────────────────────────────

registerBuiltin('str', 'replace', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['source', 'target', 'replacement']);
  const s = bound.get('source');
  const t = bound.get('target');
  const r = bound.get('replacement');
  if (!s || s.kind === 'na' || !t || t.kind === 'na' || !r || r.kind === 'na') return NA;
  const src = asStr(s);
  const target = asStr(t);
  if (target === '') return strVal(src);
  const i = src.indexOf(target);
  return strVal(i === -1 ? src : src.slice(0, i) + asStr(r) + src.slice(i + target.length));
});

registerBuiltin('str', 'replace_all', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['source', 'target', 'replacement']);
  const s = bound.get('source');
  const t = bound.get('target');
  const r = bound.get('replacement');
  if (!s || s.kind === 'na' || !t || t.kind === 'na' || !r || r.kind === 'na') return NA;
  const src = asStr(s);
  const target = asStr(t);
  return strVal(target === '' ? src : src.split(target).join(asStr(r)));
});

const strBool = (fn: (s: string, sub: string) => boolean) =>
  (_ctx: BuiltinCtx, args: Value[], named: Record<string, Value>) => {
    const bound = bindArgs(args, named, ['source', 'str']);
    const s = bound.get('source');
    const sub = bound.get('str');
    if (!s || s.kind === 'na' || !sub || sub.kind === 'na') return NA;
    return fn(asStr(s), asStr(sub)) ? VTRUE : VFALSE;
  };

registerBuiltin('str', 'contains', strBool((s, sub) => s.includes(sub)));
registerBuiltin('str', 'startswith', strBool((s, sub) => s.startsWith(sub)));
registerBuiltin('str', 'endswith', strBool((s, sub) => s.endsWith(sub)));

registerBuiltin('str', 'length', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['string']);
  const s = bound.get('string');
  if (!s || s.kind === 'na') return NA;
  return { kind: 'int', v: asStr(s).length };
});

registerBuiltin('str', 'substring', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['string', 'begin_pos', 'end_pos']);
  const s = bound.get('string');
  const b = bound.get('begin_pos');
  if (!s || s.kind === 'na' || !b || b.kind === 'na') return NA;
  const src = asStr(s);
  const begin = Math.max(0, Math.trunc(asNum(b)));
  const e = bound.get('end_pos');
  const end = !e || e.kind === 'na' ? src.length : Math.min(src.length, Math.trunc(asNum(e)));
  return strVal(src.slice(begin, Math.max(begin, end)));
});

registerBuiltin('str', 'split', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['string', 'separator']);
  const s = bound.get('string');
  if (!s || s.kind === 'na') return NA;
  const sepV = bound.get('separator');
  const sep = !sepV || sepV.kind === 'na' ? ',' : asStr(sepV);
  const src = asStr(s);
  return { kind: 'array', v: (sep === '' ? [src] : src.split(sep)).map(strVal) };
});

registerBuiltin('str', 'join', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['array', 'separator']);
  const a = bound.get('array');
  if (!a || a.kind === 'na') return NA;
  if (a.kind !== 'array') return strVal(toDisplay(a));
  const sepV = bound.get('separator');
  const sep = !sepV || sepV.kind === 'na' ? ', ' : asStr(sepV);
  return strVal(a.v.map(toDisplay).join(sep));
});

registerBuiltin('str', 'repeat', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['string', 'repetition']);
  const s = bound.get('string');
  const n = bound.get('repetition');
  if (!s || s.kind === 'na' || !n || n.kind === 'na') return NA;
  return strVal(asStr(s).repeat(Math.max(0, Math.trunc(asNum(n)))));
});

registerBuiltin('str', 'lower', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['string']);
  const s = bound.get('string');
  return !s || s.kind === 'na' ? NA : strVal(asStr(s).toLowerCase());
});

registerBuiltin('str', 'upper', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['string']);
  const s = bound.get('string');
  return !s || s.kind === 'na' ? NA : strVal(asStr(s).toUpperCase());
});

registerBuiltin('str', 'trim', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['string']);
  const s = bound.get('string');
  return !s || s.kind === 'na' ? NA : strVal(asStr(s).trim());
});

registerBuiltin('str', 'pos', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['source', 'substr']);
  const s = bound.get('source');
  const sub = bound.get('substr');
  if (!s || s.kind === 'na' || !sub || sub.kind === 'na') return NA;
  return { kind: 'int', v: asStr(s).indexOf(asStr(sub)) };
});

registerBuiltin('str', 'match', (_ctx, args, named) => {
  const bound = bindArgs(args, named, ['source', 'regex']);
  const s = bound.get('source');
  const re = bound.get('regex');
  if (!s || s.kind === 'na' || !re || re.kind === 'na') return NA;
  try {
    return new RegExp(asStr(re)).test(asStr(s)) ? VTRUE : VFALSE;
  } catch {
    return NA;
  }
});

// ── format.* constants ──────────────────────────────────────────────────────

for (const name of ['mintick', 'price', 'percent', 'volume', 'inherit', 'time']) {
  registerConstant('format', name, { kind: 'string', v: `format.${name}` });
}
