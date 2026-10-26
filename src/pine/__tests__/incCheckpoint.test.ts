// Incremental checkpoints: a new closed bar must re-snapshot only the series
// that changed since the previous checkpoint, and the result must still match a
// full rerun bit for bit.
//
// The audit switch (PINE_INC_VERIFY_CLEAN) additionally asserts, after every
// incremental checkpoint, that each series in the registry has a snap and that
// the carried-over snaps still describe live state.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from '../parser';
import { incRun, runScript, type IncLive } from '../interpreter';
import { BarSeries } from '../series';
import type { BarData, RunResult } from '../contracts';
import '../builtins/index';

const TECH_RATING = readFileSync(join(__dirname, '..', 'tech-rating.pine'), 'utf8');
const OPTS = { symbol: 'T', timeframe: '5' };

// Same synthetic tape as parity-bench.mts — integer-safe arithmetic keeps the
// two runs bit-identical.
const mkBars = (n: number, seed = 0): BarData[] => {
  const out: BarData[] = [];
  let p = 100 + seed;
  for (let i = 0; i < n; i++) {
    p += Math.sin((i + seed) / 5) * 2;
    out.push({
      openTime: 1_700_000_000_000 + i * 60_000,
      closeTime: 1_700_000_000_000 + (i + 1) * 60_000 - 1,
      open: p, high: p + 1, low: p - 1, close: p + 0.5, volume: 1000 + i,
    });
  }
  return out;
};

const appendBar = (next: BarData[], t: number, salt: number) => {
  const last = next[next.length - 1]!;
  const closeTime = last.closeTime!;
  next.push({
    openTime: closeTime + 1, closeTime: closeTime + 60_000,
    open: last.close, high: last.close + 1.5, low: last.close - 1.5,
    close: last.close + 0.7 + salt + Math.sin(t) * 0.4,
    volume: 900 + t,
  });
};

/** 'newbar' = append a bar every tick; 'catchup' = append 3 bars at once every
 *  4th tick (the others just move the forming bar). */
type Pattern = 'newbar' | 'catchup' | 'mixed';
const nextTape = (bars: BarData[], t: number, pattern: Pattern): BarData[] => {
  const next = bars.slice();
  if (pattern === 'newbar' || (pattern === 'catchup' && t % 4 === 3)) {
    for (let i = 0; i < (pattern === 'newbar' ? 1 : 3); i++) appendBar(next, t + i, 0);
    return next;
  }
  const last = next[next.length - 1]!;
  if (pattern === 'mixed' && t % 5 === 4) {
    next.push({
      openTime: last.closeTime! + 1, closeTime: last.closeTime! + 60_000,
      open: last.close, high: last.close + 1.5, low: last.close - 1.5,
      close: last.close + 0.7, volume: 900 + t,
    });
  } else {
    next[next.length - 1] = {
      ...last,
      high: last.high + (t % 3) * 0.3, low: last.low - (t % 2) * 0.2,
      close: last.close + Math.sin(t) * 1.1, volume: last.volume + t,
    };
  }
  return next;
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

/** Advance `ticks` times with `pattern` and compare each tick with a full run. */
async function parityTape(src: string, bars: BarData[], ticks: number, pattern: Pattern) {
  const parsed = parse(src);
  const first = await incRun(parsed, bars, { ...OPTS, incKey: 'ck', incSession: null });
  expect(first.live).not.toBeNull();
  let live: IncLive = first.live!;
  let tape = bars;
  for (let t = 0; t < ticks; t++) {
    tape = nextTape(tape, t, pattern);
    const inc = await incRun(parsed, tape, { ...OPTS, incKey: 'ck', incSession: live });
    expect(inc.live, `tick ${t} lost its live session`).not.toBeNull();
    live = inc.live!;
    // A fresh parse keeps runScript from sharing any memo with the session.
    expectSame(inc.result, await runScript(parse(src), tape, OPTS as never));
  }
}

// Verbatim copy of parity-bench.mts's `fx-conditional-calls` fixture: ta.* calls
// hidden behind branches that flip between ticks, so the commit path runs both
// the append and the slice rewind.
const CONDITIONAL = `//@version=6
indicator("fx")
float e = na
if close > open
    e := ta.ema(close, 10)
float r = na
if close < open
    r := ta.rsi(close, 7)
plot(e)
plot(r)
plot(ta.sma(close, 5))
`;

describe('incremental checkpoint', () => {
  it('tech-rating: 50 single-bar advances match a full rerun', async () => {
    await parityTape(TECH_RATING, mkBars(300), 50, 'newbar');
  }, 300_000);

  it('tech-rating: 50 mixed ticks, 3 new bars every 4th, match a full rerun', async () => {
    await parityTape(TECH_RATING, mkBars(300), 50, 'catchup');
  }, 300_000);

  it('conditional ta.* calls: 30 mixed ticks match a full rerun', async () => {
    await parityTape(CONDITIONAL, mkBars(300), 30, 'mixed');
  }, 120_000);

  it('conditional ta.* calls: 30 single-bar advances match a full rerun', async () => {
    await parityTape(CONDITIONAL, mkBars(300), 30, 'newbar');
  }, 120_000);

  it('snapshots far fewer series than the registry holds when one bar closes', async () => {
    const proto = BarSeries.prototype as unknown as { incSnap: BarSeries['incSnap'] };
    const shipped = proto.incSnap;
    let calls = 0;
    proto.incSnap = function (this: BarSeries) { calls++; return shipped.call(this); };
    try {
      const parsed = parse(TECH_RATING);
      let tape = mkBars(2000);
      const first = await incRun(parsed, tape, { ...OPTS, incKey: 's', incSession: null });
      expect(first.live).not.toBeNull();
      let live = first.live!;
      // One forming-bar tick, then one tick that closes a bar (commit + checkpoint).
      tape = nextTape(tape, 0, 'newbar');
      live = (await incRun(parsed, tape, { ...OPTS, incKey: 's', incSession: live })).live!;
      calls = 0;
      tape = nextTape(tape, 1, 'newbar');
      const inc = await incRun(parsed, tape, { ...OPTS, incKey: 's', incSession: live });
      expect(inc.live).not.toBeNull();
      expect(live.s.seriesSet.size).toBeGreaterThan(2000);
      expect(calls).toBeLessThan(2000);
    } finally {
      proto.incSnap = shipped;
    }
  }, 300_000);
});

describe('incremental checkpoint under PINE_INC_VERIFY_CLEAN', () => {
  beforeAll(() => { process.env.PINE_INC_VERIFY_CLEAN = '1'; });
  afterAll(() => { delete process.env.PINE_INC_VERIFY_CLEAN; });

  it('tech-rating: 25 single-bar advances pass the clean-state audit', async () => {
    await parityTape(TECH_RATING, mkBars(300), 25, 'newbar');
  }, 300_000);

  it('conditional ta.* calls: 30 mixed ticks pass the clean-state audit', async () => {
    await parityTape(CONDITIONAL, mkBars(300), 30, 'mixed');
  }, 120_000);
});
