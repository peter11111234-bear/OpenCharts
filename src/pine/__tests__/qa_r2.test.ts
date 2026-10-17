// ── QA-R2: deep boundary probes after the perf commits ───────────────────────
// Spec invariant: observable RunResult fields bit-identical vs baseline.
//   1. timestamp() DST gap: timestamp('America/New_York', 2024,3,10, 2,30,0) is
//      a nonexistent local time — pin zonedMs fixed-point behavior.
//      Also dayofweek(timestamp('UTC', 2024,1,7,0,0,0)) must be 1 (Sunday).
//   2. time('D') on hourly bars spanning Asia/Taipei midnight: bar open time
//      on first bar of each local day, na otherwise.
//   3. ta.supertrend per-callsite state (stv-x/stv-b/stv-m nested-map keys):
//      (3,10) at two callsites agree with each other; (3,10) vs (3,14) diverge.
//   4. LitSeries aliasing: x = 20; y = nz(x, 0); x := 30 — pin whether y reads
//      the updated x (materialize-on-write vs snapshot).
//   5. input.* schema dedup: input.int inside a UDF called from two places —
//      same body callsite → exactly ONE inputSchemas entry.

import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { PineInterpreterEngine, buildModel } from '../engine';
import type { RunResult } from '../contracts';
import type { OHLCV } from '@luxalgo/vela';
import '../builtins/index';

const bar = (openTime: number, c = 1) => ({ openTime, open: c, high: c + 1, low: c - 1, close: c, volume: 10 });

const plotVals = (r: RunResult, i = 0): unknown[] => {
  const plot = Array.from(r.plots.values())[i];
  if (!plot) throw new Error(`plot[${i}] missing — have ${r.plots.size}`);
  return plot.values.map(v => (v.kind === 'na' ? 'na' : 'v' in v ? v.v : undefined));
};

// ── 1. timestamp DST gap + dayofweek on explicit ms ──────────────────────────
describe('timestamp DST gap (America/New_York 2024-03-10 02:30)', () => {
  const bars = [bar(0), bar(60_000)];
  it('pins current gap-resolution semantics', async () => {
    const src = 'indicator("t")\nplot(timestamp("America/New_York", 2024, 3, 10, 2, 30, 0))';
    const r = await runScript(parse(src), bars);
    // zonedMs iterates wallUTC + tzOffsetMs to a fixed point; for a gap time it
    // settles at 07:30 UTC (= 03:30 EDT — forward-shifted, not na).
    expect(plotVals(r)).toEqual([Date.UTC(2024, 2, 10, 7, 30, 0), Date.UTC(2024, 2, 10, 7, 30, 0)]);
  });

  it('fall-back side of DST (Nov 3 01:30 ambiguous) is also deterministic', async () => {
    const src = 'indicator("t")\nplot(timestamp("America/New_York", 2024, 11, 3, 1, 30, 0))';
    const r = await runScript(parse(src), bars);
    // Pin current behavior: fold picks the earlier instant (EDT side) —
    // 01:30 EDT = 05:30 UTC, not the EST-side 06:30 UTC.
    expect(plotVals(r)).toEqual([Date.UTC(2024, 10, 3, 5, 30, 0), Date.UTC(2024, 10, 3, 5, 30, 0)]);
  });

  it("dayofweek(timestamp('UTC', 2024,1,7,0,0,0)) === 1 (Sunday)", async () => {
    const src = 'indicator("t")\nplot(dayofweek(timestamp("UTC", 2024, 1, 7, 0, 0, 0)))';
    const r = await runScript(parse(src), bars);
    expect(plotVals(r)).toEqual([1, 1]);
  });
});

// ── 2. time('D') across Asia/Taipei midnight ─────────────────────────────────
describe("time('D') local-day boundary (Asia/Taipei)", () => {
  it('emits bar open time only on first bar of each local day', async () => {
    // Hourly bars from 2024-01-01 14:00 UTC = 22:00 Asia/Taipei.
    // Local-day rollover at 16:00 UTC (00:00+8). Indices 2 and 26 are new days.
    const t0 = Date.UTC(2024, 0, 1, 14, 0, 0);
    const bars = Array.from({ length: 40 }, (_, i) => bar(t0 + i * 3_600_000));
    const src = 'indicator("t")\nplot(time("D"))';
    const r = await runScript(parse(src), bars, { symbol: 'TW:T', timeframe: '60' });
    const expected: (number | 'na')[] = bars.map((b, i) =>
      i === 0 || i === 2 || i === 26 ? b.openTime : 'na');
    expect(plotVals(r)).toEqual(expected);
  });
});

// ── 3. ta.supertrend callsite isolation (stv-x/stv-b/stv-m keys) ─────────────
describe('ta.supertrend per-callsite state isolation', () => {
  // V-shaped price path so supertrend flips direction mid-run.
  const bars = Array.from({ length: 40 }, (_, i) => {
    const c = i < 20 ? 100 - i * 2 : 60 + (i - 20) * 2;
    return { openTime: i * 60_000, open: c, high: c + 1, low: c - 1, close: c, volume: 10 };
  });

  it('(3,10) at two callsites agree; (3,10) vs (3,14) diverge; no cross-feed', async () => {
    const src = [
      'indicator("t")',
      '[s1, d1] = ta.supertrend(3, 10)',
      '[s2, d2] = ta.supertrend(3, 14)',
      '[s1b, d1b] = ta.supertrend(3, 10)',
      'plot(s1, "s10a")', 'plot(d1, "d10a")',
      'plot(s2, "s14")', 'plot(d2, "d14")',
      'plot(s1b, "s10b")', 'plot(d1b, "d10b")',
    ].join('\n');
    const r = await runScript(parse(src), bars);
    const s10a = plotVals(r, 0), d10a = plotVals(r, 1);
    const s14 = plotVals(r, 2);
    const s10b = plotVals(r, 4), d10b = plotVals(r, 5);
    // Identical params at a second callsite → identical output. Shared-key
    // contamination would double-feed the window and diverge.
    expect(s10b).toEqual(s10a);
    expect(d10b).toEqual(d10a);
    // Different length → different result somewhere.
    expect(s14).not.toEqual(s10a);
    // Direction series is ±1 wherever defined.
    for (const v of d10a) if (v !== 'na') expect([-1, 1]).toContain(v);
    // Reference: standalone single-callsite run must match s10a/d10a exactly —
    // proves the second/third callsites didn't perturb the first.
    const ref = await runScript(parse('indicator("t")\n[s, d] = ta.supertrend(3, 10)\nplot(s)\nplot(d)'), bars);
    expect(s10a).toEqual(plotVals(ref, 0));
    expect(d10a).toEqual(plotVals(ref, 1));
  });
});

// ── 4. LitSeries aliasing through nz ─────────────────────────────────────────
describe('LitSeries foreign write via :=', () => {
  it('pins y = nz(x,0) read-after-write behavior', async () => {
    const src = 'indicator("t")\nx = 20\ny = nz(x, 0)\nx := 30\nplot(y)\nplot(x)';
    const r = await runScript(parse(src), [bar(0), bar(60_000), bar(120_000)]);
    // materialize-on-write: y is a snapshot taken before x := 30 → 20.
    expect(plotVals(r, 0)).toEqual([20, 20, 20]);
    expect(plotVals(r, 1)).toEqual([30, 30, 30]);
  });
});

// ── 5. input.* schema dedup across UDF call sites ────────────────────────────
describe('input.int schema dedup via UDF double-call', () => {
  it('one schema entry for a UDF-body input reached from two callsites', async () => {
    const src = 'indicator("t")\nf() => input.int(5, "t")\na = f()\nb = f()\nplot(a)\nplot(b)';
    const r = await runScript(parse(src), [bar(0), bar(60_000), bar(120_000)]);
    const ints = r.inputs.filter(s => s.type === 'int');
    expect(ints).toHaveLength(1);
    expect(ints[0]).toMatchObject({ name: 't', defval: 5 });
    // Both f() calls still resolve the defval each bar.
    expect(plotVals(r, 0)).toEqual([5, 5, 5]);
    expect(plotVals(r, 1)).toEqual([5, 5, 5]);
  });
});

// ── 6. line.new with na coords (Vela UI probe finding) ──────────────────────
// Browser QA (vela-146.png): 高量1.46's ORB block calls line.new(y1=orb_h) with
// orb_h=na (ta.valuewhen never matched on TSE stock data — no 08:45 bar). TV
// draws nothing for na coords. This engine used to coerce na→0 via numArg(def=0)
// in builtins/draw.ts, so the model emitted 38 lines at y=0 and Vela folded that
// 0 into the price pane's autoscale — the axis collapsed to 0…high and every
// candle squashed flat. na coords now stay na; buildModel drops such a drawing
// (and label/marker) instead of parking it at price 0.
describe('line.new na coordinates stay na (nothing drawn)', () => {
  it('na y-coords are preserved, not coerced to 0', async () => {
    const src = [
      'indicator("t")',
      'float y = na',
      'line.new(x1 = 0, y1 = y, x2 = 1, y2 = y)',
      'plot(close)',
    ].join('\n');
    const r = await runScript(parse(src), [bar(0), bar(60_000)]);
    const line = r.drawings.find(d => d.kind === 'line');
    expect(line).toBeDefined();
    expect(line!.props.y1).toBeUndefined();
    expect(line!.props.y2).toBeUndefined();
  });

  it('na x-coords likewise stay na, real coords untouched', async () => {
    const src = 'indicator("t")\nint x = na\nline.new(x1 = x, y1 = 5, x2 = 2, y2 = 6)\nplot(close)';
    const r = await runScript(parse(src), [bar(0), bar(60_000)]);
    const line = r.drawings.find(d => d.kind === 'line');
    expect(line!.props.x1).toBeUndefined();
    expect(line!.props.y1).toBe(5);
    expect(line!.props.y2).toBe(6);
  });

  // The prop-table generated setters (line.set_x1/set_y1/…, label.set_y,
  // box.set_top/…) are a second door into the same room: they coerced na to 0
  // long after the constructors were fixed. Cover them explicitly.
  it('generic prop-table setters keep na for coordinates', async () => {
    const src = [
      'indicator("t")',
      'var line l = line.new(0, 5, 1, 6)',
      'var label lb = label.new(0, 5)',
      'var box bx = box.new(0, 5, 1, 6)',
      'line.set_y1(l, na)',
      'line.set_x2(l, na)',
      'label.set_y(lb, na)',
      'label.set_x(lb, na)',
      'box.set_top(bx, na)',
      'box.set_bottom(bx, na)',
      'plot(close)',
    ].join('\n');
    const r = await runScript(parse(src), [bar(0), bar(60_000)]);
    const line = r.drawings.find(d => d.kind === 'line');
    const label = r.drawings.find(d => d.kind === 'label');
    const box = r.drawings.find(d => d.kind === 'box');
    expect(line!.props.y1).toBeUndefined();
    expect(line!.props.x2).toBeUndefined();
    expect(line!.props.x1).toBe(0);
    expect(label!.props.y).toBeUndefined();
    expect(label!.props.x).toBeUndefined();
    expect(box!.props.top).toBeUndefined();
    expect(box!.props.bottom).toBeUndefined();
    expect(box!.props.left).toBe(0);
  });

  it('hand-rolled set_xloc setters keep na too', async () => {
    const src = [
      'indicator("t")',
      'var label lb = label.new(0, 5)',
      'var box bx = box.new(0, 5, 1, 6)',
      'label.set_xloc(lb, na, xloc.bar_index)',
      'box.set_xloc(bx, na, na, xloc.bar_index)',
      'plot(close)',
    ].join('\n');
    const r = await runScript(parse(src), [bar(0), bar(60_000)]);
    expect(r.drawings.find(d => d.kind === 'label')!.props.x).toBeUndefined();
    const box = r.drawings.find(d => d.kind === 'box');
    expect(box!.props.left).toBeUndefined();
    expect(box!.props.right).toBeUndefined();
  });

  it('an omitted required coordinate is na, not price 0', async () => {
    // line.new(x1, y1, x2) — TradingView rejects the call; drawing at 0 instead
    // is what collapsed the axis, so the missing endpoint must stay na.
    const src = 'indicator("t")\nline.new(0, 5, 1)\nplot(close)';
    const r = await runScript(parse(src), [bar(0), bar(60_000)]);
    const line = r.drawings.find(d => d.kind === 'line');
    expect(line!.props.y2).toBeUndefined();
    expect(line!.props.y1).toBe(5);
  });

  it('a non-numeric coordinate is na too, not price 0', async () => {
    // `asNum` maps an unparsable string to 0; a coordinate must not inherit that
    // (TradingView is a compile error, and 0 is a real price).
    const src = [
      'indicator("t")',
      'var line l = line.new(0, 5, 1, 6)',
      'line.new(0, "abc", 1, 2)',
      'line.set_y1(l, "abc")',
      'plot(close)',
    ].join('\n');
    const r = await runScript(parse(src), [bar(0), bar(60_000)]);
    const lines = r.drawings.filter(d => d.kind === 'line');
    expect(lines[0]!.props.y1).toBeUndefined();
    expect(lines[0]!.props.x1).toBe(0);
    expect(lines[0]!.props.y2).toBe(6);
    expect(lines[1]!.props.y1).toBeUndefined();
    expect(lines[1]!.props.y2).toBe(2);
  });

  it('non-coordinate numeric props still coerce na to their 0 default', async () => {
    const src = [
      'indicator("t")',
      'var line l = line.new(0, 5, 1, 6)',
      'var box bx = box.new(0, 5, 1, 6)',
      'line.set_width(l, na)',
      'box.set_border_width(bx, na)',
      'plot(close)',
    ].join('\n');
    const r = await runScript(parse(src), [bar(0), bar(60_000)]);
    expect(r.drawings.find(d => d.kind === 'line')!.props.width).toBe(0);
    expect(r.drawings.find(d => d.kind === 'box')!.props.border_width).toBe(0);
  });

  it('line.get_price extrapolates real coords but returns na for na coords', async () => {
    const ok = 'indicator("t")\nvar line l = line.new(0, 5, 10, 15)\nplot(line.get_price(l, 5))';
    const rOk = await runScript(parse(ok), [bar(0), bar(60_000)]);
    expect(plotVals(rOk)).toEqual([10, 10]);

    const na = 'indicator("t")\nvar line l = line.new(na, na, na, na)\nplot(line.get_price(l, 5))';
    const rNa = await runScript(parse(na), [bar(0), bar(60_000)]);
    expect(plotVals(rNa)).toEqual(['na', 'na']);

    const naBar = 'indicator("t")\nvar line l = line.new(0, 5, 10, 15)\nint bx = na\nplot(line.get_price(l, bx))';
    const rNaBar = await runScript(parse(naBar), [bar(0), bar(60_000)]);
    expect(plotVals(rNaBar)).toEqual(['na', 'na']);
  });

  it('buildModel drops the drawing instead of emitting price-0 geometry', async () => {
    const src = [
      'indicator("t")',
      'float orb_h = na',
      'var line l = line.new(0, 5, 1, 6)',
      'line.set_y1(l, orb_h)',
      'plot(close)',
    ].join('\n');
    const engine = new PineInterpreterEngine();
    const prepared = await engine.prepare(src, 'na1');
    const bars: OHLCV[] = Array.from({ length: 4 }, (_, i) => ({
      time: i * 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 10,
    }));
    const parsed = parse(src);
    const r = await runScript(parsed, bars.map(b => ({ openTime: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 })), { symbol: 'TEST', timeframe: '1' });
    // The interpreter carries `modelId` on the otherwise opaque prepared token
    // (same read as engine.test.ts's mkReq).
    const token = prepared.token as { modelId: string };
    const model = buildModel(token.modelId,
      { prepared, market: { symbol: 'TEST', timeframe: '1' }, bars, mode: 'static' },
      r, bars.map(b => b.time));
    // The line is still a live object for the script (setters keep working)…
    expect(r.drawings.find(d => d.kind === 'line')).toBeDefined();
    // …but nothing reaches the model, so no 0 can reach the pane autoscale
    // (buildModel omits the key entirely when the list is empty).
    expect(model.lines ?? []).toHaveLength(0);
  });
});
