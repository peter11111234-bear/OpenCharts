// Dirty-set rewind: advancing a live session must reproduce a full rerun
// exactly, and the number of series a tick rewinds must not grow with the tape.
//
// The audit switch (PINE_INC_VERIFY_CLEAN) makes every restore assert that each
// snapshotted series OUTSIDE the dirty set is still at its snapshot state — a
// failure means a write primitive forgot its `markDirty`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from '../parser';
import { incRun, runScript, type IncLive } from '../interpreter';
import { BarSeries } from '../series';
import type { BarData, RunResult } from '../contracts';
import '../builtins/index';

beforeAll(() => { process.env.PINE_INC_VERIFY_CLEAN = '1'; });
afterAll(() => { delete process.env.PINE_INC_VERIFY_CLEAN; });

const mkBars = (n: number): BarData[] => {
  const out: BarData[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 5) * 2;
    out.push({
      openTime: 1_700_000_000_000 + i * 60_000,
      closeTime: 1_700_000_000_000 + (i + 1) * 60_000 - 1,
      open: p, high: p + 1, low: p - 1, close: p + 0.5, volume: 1000 + i,
    });
  }
  return out;
};

/** Rewrite the forming bar's close (and keep high/low consistent with it). */
const withClose = (bars: BarData[], close: number): BarData[] => {
  const out = bars.slice();
  const last = out[out.length - 1]!;
  out[out.length - 1] = {
    ...last,
    close,
    high: Math.max(last.high, close),
    low: Math.min(last.low, close),
  };
  return out;
};

const plotVals = (r: RunResult) =>
  [...r.plots.entries()].map(([k, p]) => [k, p.values.map(v => JSON.stringify(v))]);

const expectSame = (a: RunResult, b: RunResult) => {
  expect(plotVals(a)).toEqual(plotVals(b));
  expect(a.drawings.map(d => [d.kind, JSON.stringify(d.props)]))
    .toEqual(b.drawings.map(d => [d.kind, JSON.stringify(d.props)]));
  expect(a.warnings).toEqual(b.warnings);
  expect(a.fills).toEqual(b.fills);
  expect([...a.bgcolors.entries()]).toEqual([...b.bgcolors.entries()]);
  expect([...a.barcolors.entries()]).toEqual([...b.barcolors.entries()]);
};

/** Run `ticks` forming-bar updates and compare every one with a full rerun. */
async function parityTicks(src: string, bars: BarData[], closes: number[], opts: Record<string, unknown> = {}) {
  const parsed = parse(src);
  const first = await incRun(parsed, bars, { ...opts, incKey: 'd', incSession: null });
  expect(first.live).not.toBeNull();
  let live: IncLive = first.live!;
  let tape = bars;
  for (let t = 0; t < closes.length; t++) {
    tape = withClose(tape, closes[t]!);
    const inc = await incRun(parsed, tape, { ...opts, incKey: 'd', incSession: live });
    expect(inc.live, `tick ${t} lost its live session`).not.toBeNull();
    live = inc.live!;
    // A fresh parse keeps runScript from sharing any memo with the session.
    const full = await runScript(parse(src), tape, opts as never);
    expectSame(inc.result, full);
  }
}

const TECH_RATING = readFileSync(join(__dirname, '..', 'tech-rating.pine'), 'utf8');
const OPTS = { symbol: 'T', timeframe: '5' };

/** Forming closes for `n` ticks: a rising/falling mix, all finite. */
const closesOf = (bars: BarData[], n: number) =>
  Array.from({ length: n }, (_, t) => bars[bars.length - 1]!.close + Math.sin(t) * 3);

describe('incremental dirty tracking', () => {
  // A worker interleaves several indicators' sessions on one thread: one
  // session's checkpoint/restore must not wipe the marks another session's
  // forming-bar eval left for its own next restore.
  it('two sessions interleaved tick by tick each match a full rerun', async () => {
    const other = `//@version=6
indicator("b")
float acc = 0.0
acc := nz(acc[1]) + close
plot(ta.ema(close, 5), "e")
plot(acc, "a")
`;
    const sess = [TECH_RATING, other].map((src) => ({ src, parsed: parse(src), tape: mkBars(300), live: null as IncLive | null }));
    for (const [i, x] of sess.entries()) {
      x.live = (await incRun(x.parsed, x.tape, { ...OPTS, incKey: 'two' + i, incSession: null })).live;
    }
    const closes = closesOf(sess[0]!.tape, 8);
    for (let t = 0; t < closes.length; t++) {
      for (const [i, x] of sess.entries()) {
        x.tape = withClose(x.tape, closes[t]! + i);
        const inc = await incRun(x.parsed, x.tape, { ...OPTS, incKey: 'two' + i, incSession: x.live });
        expect(inc.live, `session ${i} tick ${t} lost its live session`).not.toBeNull();
        x.live = inc.live;
        expectSame(inc.result, await runScript(parse(x.src), x.tape, OPTS as never));
      }
    }
  }, 120_000);

  it('tech-rating: 20 forming-bar ticks match a full rerun', async () => {
    const bars = mkBars(500);
    await parityTicks(TECH_RATING, bars, closesOf(bars, 20), OPTS);
  }, 120_000);

  const IFDECL: Record<string, string> = {
    ifdecl: `//@version=6
indicator("ifdecl")
float out = na
if close > 1000
    float y = close * 2
    out := y + nz(y[1])
plot(out, "o")
plot(close, "c")
`,
    ifvar: `//@version=6
indicator("ifvar")
float out = na
if close > 1000
    var float acc = 0.0
    acc += close
    out := acc
plot(out, "o")
`,
    ifta: `//@version=6
indicator("ifta")
float out = na
if close > 1000
    out := ta.sma(close, 3)
plot(out, "o")
`,
  };

  for (const [name, src] of Object.entries(IFDECL)) {
    it(`if-scoped declaration (${name}): 6 ticks across the 1000 threshold match`, async () => {
      await parityTicks(src, mkBars(300), [2000, 2001, 100, 2002, 100, 2003]);
    }, 60_000);
  }

  const ARRAY_SRC = `//@version=6
indicator("arr")
var arr = array.from(1.0, 2.0)
array.push(arr, close)
float s = array.sum(arr)
plot(s, "s")
plot(array.size(arr), "n")
`;

  const UDT_SRC = `//@version=6
indicator("udt")
type P
    float v
    int n
var P p = P.new(0.0, 0)
p.v := p.v + close
p.n := p.n + 1
plot(p.v, "v")
plot(p.n, "n")
`;

  for (const [name, src] of [['array', ARRAY_SRC], ['udt', UDT_SRC]] as const) {
    it(`${name} state: 20 forming-bar ticks match a full rerun`, async () => {
      const bars = mkBars(200);
      await parityTicks(src, bars, closesOf(bars, 20));
    }, 60_000);
  }

  it('rewinds a number of series independent of the tape length', async () => {
    const proto = BarSeries.prototype as unknown as { incRewind: BarSeries['incRewind'] };
    const shipped = proto.incRewind;
    let calls = 0;
    proto.incRewind = function (this: BarSeries, snap) { calls++; shipped.call(this, snap); };
    const medians: number[] = [];
    try {
      for (const k of [500, 2000]) {
        const parsed = parse(TECH_RATING);
        const bars = mkBars(k);
        const first = await incRun(parsed, bars, { ...OPTS, incKey: 'c', incSession: null });
        expect(first.live).not.toBeNull();
        const live = first.live!;
        let tape = bars;
        const perTick: number[] = [];
        for (let t = 0; t < 10; t++) {
          tape = withClose(tape, tape[tape.length - 1]!.close + (t % 2 ? 0.5 : -0.5));
          calls = 0;
          await incRun(parsed, tape, { ...OPTS, incKey: 'c', incSession: live });
          perTick.push(calls);
        }
        perTick.sort((a, b) => a - b);
        medians.push(perTick[Math.floor(perTick.length / 2)]!);
      }
    } finally {
      proto.incRewind = shipped;
    }
    const [small, large] = medians as [number, number];
    expect(small).toBeGreaterThan(0);
    // Same script, 4x the tape: the rewind count must not follow K (<10% apart).
    expect(Math.abs(large - small) / Math.max(large, small)).toBeLessThanOrEqual(0.1);
  }, 120_000);
});
