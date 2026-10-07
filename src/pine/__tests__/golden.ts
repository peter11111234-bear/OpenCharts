// Golden-value harness: serialize a RunResult to a canonical JSON form and
// either snapshot it to scripts/golden/*.golden.json (UPDATE_GOLDEN=1) or
// deep-compare against the committed baseline. Deterministic by construction:
// all inputs are synthetic, all randomness is the same seeded generator.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { BarData, DrawObj, RunResult, Value } from '../contracts';

const GOLDEN_DIR = join(__dirname, '..', '..', '..', 'scripts', 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const DEC = 1e6; // 6-decimal rounding for floats

// ── deterministic bar generators ────────────────────────────────────────────

/** Deterministic chart bars, 60-second spacing. Replaces the ad-hoc mkBars in
 *  e2e.test.ts for golden runs — same shape, seeded so re-runs are stable. */
export function mkBars(n: number, startMs = 0, stepMs = 60_000): BarData[] {
  const bars: BarData[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 20) * 2 + ((i * 7919) % 100 - 50) * 0.02;
    const open = p;
    bars.push({
      openTime: startMs + i * stepMs,
      open,
      high: open + 1.5 + (i % 3) * 0.2,
      low: open - 1.5 - (i % 2) * 0.2,
      close: open + 0.4 + Math.cos(i / 15) * 0.3,
      volume: 1000 + i * 7 + (i % 11) * 13,
    });
  }
  return bars;
}

/** Deterministic resample of a base 1m series into `tf`. openTime is floored
 *  to the tf boundary — matches the bucket semantics mtf.ts expects. */
export function resampleTf(bars: BarData[], tf: string): BarData[] {
  const m = /^(\d+)([smhdw]?)$/i.exec(tf.trim());
  const sec = m
    ? Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 } as Record<string, number>)[(m[2] ?? 'm').toLowerCase()]!
    : 60;
  if (sec <= 60) return bars;
  const buckets = new Map<number, BarData>();
  for (const b of bars) {
    const key = b.openTime - (b.openTime % (sec * 1000));
    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, { ...b, openTime: key });
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

/** Deterministic fetchSeries for security(...) — generates base 1m bars then
 *  resamples into whatever tf the script asked for. Ignores `symbol`. */
export function fetchTf(baseBars: BarData[]) {
  return async (_symbol: string, tf: string): Promise<BarData[]> => resampleTf(baseBars, tf);
}

// ── canonical serialization ────────────────────────────────────────────────

const rnd = (n: number): number => (Number.isFinite(n) ? Math.round(n * DEC) / DEC : null as never);

/** Collapse a runtime Value into JSON-friendly primitives. */
export function canonValue(v: Value | undefined): unknown {
  if (v === undefined) return null;
  switch (v.kind) {
    case 'na': return null;
    case 'int':
    case 'float': return rnd(v.v);
    case 'bool':
    case 'string':
    case 'color': return v.v;
    case 'udt': {
      const o: Record<string, unknown> = { $type: v.v.typeName };
      for (const [k, fv] of [...v.v.fields.entries()].sort()) o[k] = canonValue(fv);
      return o;
    }
    case 'array': return (v.v as Value[]).map(canonValue);
    case 'map': {
      const o: Record<string, unknown> = { $map: true };
      for (const [k, fv] of [...(v.v as Map<unknown, Value>).entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
        o[String(k)] = canonValue(fv);
      }
      return o;
    }
    case 'series': return { $series: canonValue(v.v.cur()) };
    case 'function': return { $fn: typeof v.v === 'object' && 'name' in v.v ? v.v.name : 'builtin' };
    case 'void': return null;
    case 'line':
    case 'label':
    case 'box':
    case 'table':
    case 'polyline':
    case 'linefill': {
      const d = v.v as DrawObj;
      return { $draw: d.kind, id: d.id, props: canonProps(d.props) };
    }
    default: return { $kind: (v as { kind: string }).kind };
  }
}

/** Canonicalize a drawing's props map — Maps become sorted objects, Values
 *  become canonValue output, numbers round to 6dp. */
function canonProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(props).sort()) {
    out[k] = canonAny(props[k]);
  }
  return out;
}

function canonAny(x: unknown): unknown {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return rnd(x);
  if (typeof x === 'string' || typeof x === 'boolean') return x;
  if (x instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of [...x.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
      o[String(k)] = canonAny(v);
    }
    return o;
  }
  if (Array.isArray(x)) return x.map(canonAny);
  if (typeof x === 'object') {
    if ('kind' in (x as Value)) return canonValue(x as Value);
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>).sort()) {
      o[k] = canonAny((x as Record<string, unknown>)[k]);
    }
    return o;
  }
  return x;
}

/** Serialize the full RunResult into a deterministic snapshot object. */
export function snapshot(r: RunResult): Record<string, unknown> {
  const plots: Record<string, unknown> = {};
  for (const [k, p] of [...r.plots.entries()].sort()) {
    plots[k] = {
      index: p.index,
      values: p.values.map(canonValue),
      opts: canonProps(p.opts as unknown as Record<string, unknown>),
    };
  }
  const drawings = r.drawings.map(d => ({ id: d.id, kind: d.kind, props: canonProps(d.props) }));
  const bg: Record<string, unknown> = {};
  for (const [bar, layers] of [...r.bgcolors.entries()].sort((a, b) => a[0] - b[0])) {
    const o: Record<string, string> = {};
    for (const [site, col] of [...layers.entries()].sort()) o[site] = col;
    bg[String(bar)] = o;
  }
  const bc: Record<string, unknown> = {};
  for (const [bar, layers] of [...r.barcolors.entries()].sort((a, b) => a[0] - b[0])) {
    const o: Record<string, string> = {};
    for (const [site, col] of [...layers.entries()].sort()) o[site] = col;
    bc[String(bar)] = o;
  }
  return {
    title: r.title,
    overlay: r.overlay,
    plots,
    fills: r.fills.map(f => ({ ...f })),
    drawings,
    bgcolors: bg,
    barcolors: bc,
    execs: (r.execs ?? []).map(e => ({ ...e })),
    alerts: r.alerts.map(a => ({ ...a })),
    alertconditions: (r.alertconditions ?? []).map(a => ({ ...a })),
    warnings: [...r.warnings].sort(),
  };
}

// ── file IO + compare ───────────────────────────────────────────────────────

export function goldenCheck(name: string, r: RunResult): void {
  const snap = snapshot(r);
  const text = JSON.stringify(snap, null, 2) + '\n';
  const gp = join(GOLDEN_DIR, `${name}.golden.json`);
  const ap = join(GOLDEN_DIR, `${name}.actual.json`);
  if (UPDATE) {
    mkdirSync(dirname(gp), { recursive: true });
    writeFileSync(gp, text);
    return;
  }
  let want: string;
  try {
    want = readFileSync(gp, 'utf8');
  } catch {
    writeFileSync(ap, text);
    throw new Error(`golden missing for ${name} — wrote ${ap}; run UPDATE_GOLDEN=1 to commit a baseline`);
  }
  // Stored goldens may carry CRLF (Windows regen via PowerShell or autocrlf);
  // normalize before comparing — a line-ending mismatch is not a golden diff.
  if (want.replace(/\r\n/g, '\n') === text) return;
  writeFileSync(ap, text);
  const a = JSON.parse(want) as unknown;
  const b = JSON.parse(text) as unknown;
  throw new Error(`golden mismatch for ${name}\nfirst diff: ${firstDiff(a, b, '')}\nactual written → ${ap}`);
}

function firstDiff(a: unknown, b: unknown, path: string): string {
  if (a === b) return 'no diff found (should not happen)';
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path} :: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of [...keys].sort()) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in ao)) return `${p} :: missing in golden (${JSON.stringify(bo[k])})`;
    if (!(k in bo)) return `${p} :: missing in actual (${JSON.stringify(ao[k])})`;
    if (JSON.stringify(ao[k]) !== JSON.stringify(bo[k])) {
      const d = firstDiff(ao[k], bo[k], p);
      if (d !== 'no diff found (should not happen)') return d;
    }
  }
  return 'no diff found (should not happen)';
}
