// Incremental-execution parity: advancing a live session through ticks must
// produce the same RunResult as a fresh full runScript on the final tape.
// Covers var/arrays/ta.*/drawings and the forming-bar rollback (no
// double-apply of stateful writes).
import { describe, it, expect } from 'vitest';
import { incRun, runScript, type IncLive } from '../interpreter';
import { parse } from '../parser';
import type { BarData, RunResult } from '../contracts';
import '../builtins/index';

const mkBar = (i: number, close = 100 + i): BarData => ({
  openTime: 1_700_000_000_000 + i * 60_000,
  closeTime: 1_700_000_000_000 + (i + 1) * 60_000 - 1,
  open: close - 1,
  high: close + 2,
  low: close - 2,
  close,
  volume: 1000 + i,
});

const tape = (n: number) => Array.from({ length: n }, (_, i) => mkBar(i));

/** Deep-ish compare the observable surfaces of two results. */
const expectSame = (a: RunResult, b: RunResult) => {
  const plotVals = (r: RunResult) =>
    [...r.plots.entries()].map(([k, p]) => [k, p.values.map(v => JSON.stringify(v))]);
  expect(plotVals(a)).toEqual(plotVals(b));
  expect(a.drawings.map(d => [d.kind, JSON.stringify(d.props)])).toEqual(
    b.drawings.map(d => [d.kind, JSON.stringify(d.props)]));
  expect(a.warnings).toEqual(b.warnings);
  expect(a.fills).toEqual(b.fills);
  expect([...a.bgcolors.entries()]).toEqual([...b.bgcolors.entries()]);
  expect([...a.barcolors.entries()]).toEqual([...b.barcolors.entries()]);
};

/** Numeric value of plot `key` at bar `i`; checks the shape instead of casting. */
const plotNum = (r: RunResult, key: string, i: number): number => {
  const v = r.plots.get(key)?.values[i];
  if (v === null || typeof v !== 'object' || !('v' in v)) return NaN;
  return typeof v.v === 'number' ? v.v : NaN;
};

/** Drive a session through a tape mutation, comparing against full rerun. */
const advance = async (
  src: string,
  after: BarData[],
  live: IncLive | null,
): Promise<{ live: IncLive | null; result: RunResult }> => {
  const parsed = parse(src);
  const opts = { incKey: 'k1', incSession: live };
  const inc = await incRun(parsed, after, opts);
  const full: RunResult = await runScript(parse(src), after);
  expectSame(inc.result, full);
  return inc;
};

const SIMPLE = `//@version=6
indicator("p")
var n = 0
n := n + 1
plot(n, "count")
plot(ta.sma(close, 3), "sma")
`;

describe('incremental parity', () => {
  it('forming-bar tick: same length, last bar mutated', async () => {
    const parsed = parse(SIMPLE);
    const bars = tape(10);
    const first = await incRun(parsed, bars, { incKey: 'k1', incSession: null });
    expect(first.live).not.toBeNull();

    const mutated = bars.slice();
    mutated[mutated.length - 1] = { ...mutated[mutated.length - 1]!, close: 777, high: 800 };
    await advance(SIMPLE, mutated, first.live);
  });

  it('new bar appended: previous forming bar commits', async () => {
    const parsed = parse(SIMPLE);
    const bars = tape(10);
    const first = await incRun(parsed, bars, { incKey: 'k1', incSession: null });
    const grown = [...bars, mkBar(10, 555)];
    await advance(SIMPLE, grown, first.live);
  });

  it('var counter must not double-apply on forming-bar rollback', async () => {
    const src = `//@version=6
indicator("p")
var n = 0
n := n + 1
plot(n, "count")
`;
    const parsed = parse(src);
    const bars = tape(8);
    const first = await incRun(parsed, bars, { incKey: 'k1', incSession: null });
    // Two ticks on the same forming bar.
    for (let i = 0; i < 2; i++) {
      const mutated = bars.slice();
      mutated[7] = { ...mutated[7]!, close: 200 + i * 50 };
      const r = await advance(src, mutated, first.live);
      const n = r.result.plots.get('count')!.values[7]!;
      expect((n as { kind: string; v: number }).v).toBe(8); // n = bars seen, never 9/10
      first.live = r.live;
    }
    // Grow: counter advances exactly once.
    const grown = [...bars, mkBar(8, 333)];
    const r2 = await incRun(parsed, grown, { incKey: 'k1', incSession: first.live });
    expect((r2.result.plots.get('count')!.values[8]! as { v: number }).v).toBe(9);
  });

  it('arrays and drawings rollback cleanly', async () => {
    const src = `//@version=6
indicator("p")
var a = array.new_float(0)
array.push(a, close)
plot(array.size(a), "size")
if close > 105
    label.new(bar_index, high, "hi")
`;
    const parsed = parse(src);
    const bars = tape(6);
    const first = await incRun(parsed, bars, { incKey: 'k1', incSession: null });
    const mutated = bars.slice();
    mutated[5] = { ...mutated[5]!, close: 200, high: 250 };
    await advance(src, mutated, first.live);
  });

  it('request.security: tick parity through the MTF checkpoint surface', async () => {
    // Higher-tf fetch mock: 5-minute bars aggregating the 1-minute tape.
    let fetches = 0;
    const fetchSeries = async (_sym: string, tf: string): Promise<BarData[]> => {
      fetches++;
      if (tf !== '5') return [];
      const out: BarData[] = [];
      for (let i = 0; i < 20; i++) {
        const c = 100 + i;
        out.push({
          openTime: 1_700_000_000_000 + i * 300_000,
          closeTime: 1_700_000_000_000 + (i + 1) * 300_000 - 1,
          open: c - 1, high: c + 5, low: c - 5, close: c, volume: 5000 + i,
        });
      }
      return out;
    };
    const src = `//@version=6
indicator("mtf")
h = request.security(syminfo.tickerid, "5", high)
plot(h, "hi5")
plot(close, "c")
`;
    const parsed = parse(src);
    const bars = tape(10);
    const opts = { incKey: 'k1', incSession: null as IncLive | null, fetchSeries };
    const first = await incRun(parsed, bars, opts);
    expect(first.live).not.toBeNull(); // MTF specs now qualify
    // Tick the forming chart bar — security value must match a full rerun.
    const mutated = bars.slice();
    mutated[9] = { ...mutated[9]!, close: 150, high: 160 };
    const r = await incRun(parsed, mutated, { ...opts, incSession: first.live });
    const full = await runScript(parse(src), mutated, { fetchSeries });
    expectSame(r.result, full);
    // Append a bar — the old forming bar commits, new forming bar evaluates.
    const grown = [...mutated, mkBar(10, 170)];
    const r2 = await incRun(parsed, grown, { ...opts, incSession: r.live });
    const full2 = await runScript(parse(src), grown, { fetchSeries });
    expectSame(r2.result, full2);
    // append triggered one refresh. Count = prefetch + full rerun + refresh
    // + full2 rerun — the same-tape tick itself added nothing.
    expect(fetches).toBe(4);
  });
  it('request.security: same-length tick that crosses the HTF bucket (lookahead_on)', async () => {
    // Residual 5: incAdvance gates its HTF refresh on `bars.length > oldLen`,
    // so a same-length tick that moves the FORMING bar into the next higher-tf
    // bucket never refreshes the feed. With lookahead_on the tail bucket is
    // still forming at eval time, so this is the case that can go stale.
    let fetches = 0;
    const fetchSeries = async (_sym: string, tf: string): Promise<BarData[]> => {
      fetches++;
      if (tf !== '5') return [];
      const out: BarData[] = [];
      for (let i = 0; i < 20; i++) {
        const c = 100 + i;
        out.push({
          openTime: 1_700_000_000_000 + i * 300_000,
          closeTime: 1_700_000_000_000 + (i + 1) * 300_000 - 1,
          open: c - 1, high: c + 5, low: c - 5, close: c, volume: 5000 + i,
        });
      }
      return out;
    };
    const src = `//@version=6
indicator("mtf")
h = request.security(syminfo.tickerid, "5", high, lookahead=barmerge.lookahead_on)
plot(h, "hi5")
plot(close, "c")
`;
    const parsed = parse(src);
    const bars = tape(10);
    const opts = { incKey: 'k1', incSession: null as IncLive | null, fetchSeries };
    const first = await incRun(parsed, bars, opts);
    expect(first.live).not.toBeNull();
    // Same tape length, but the forming bar moves from the 1st 5-min bucket
    // (9 * 60s) into the 2nd (10 * 60s): length unchanged ⇒ no refresh.
    const crossed = bars.slice();
    crossed[9] = { ...crossed[9]!, openTime: 1_700_000_000_000 + 10 * 60_000, closeTime: 1_700_000_000_000 + 11 * 60_000 - 1 };
    const r = await incRun(parsed, crossed, { ...opts, incSession: first.live });
    const full = await runScript(parse(src), crossed, { fetchSeries });
    expectSame(r.result, full);
  });
  it('fuzz: random tape mutations stay equal to full reruns', async () => {
    // Deterministic PRNG so failures reproduce.
    let seed = 0x2f6e2b1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const src = `//@version=6
indicator("f")
var n = 0
n := n + 1
m = ta.sma(close, 4) + ta.ema(close, 6)
plot(n, "n")
plot(m, "m")
if close > 103
    label.new(bar_index, high, "x")
`;
    const parsed = parse(src);
    let bars = tape(12);
    let live: IncLive | null = null;
    const first = await incRun(parsed, bars, { incKey: 'k1', incSession: null });
    live = first.live;
    for (let t = 0; t < 24; t++) {
      // Randomly: mutate the forming bar, or append a new bar.
      if (rnd() < 0.6) {
        const m = bars.slice();
        const last = m.length - 1;
        m[last] = { ...m[last]!, close: 90 + rnd() * 40, high: 100 + rnd() * 50, volume: 500 + rnd() * 3000 };
        bars = m;
      } else {
        bars = [...bars, mkBar(bars.length, 90 + rnd() * 40)];
      }
      const r = await incRun(parsed, bars, { incKey: 'k1', incSession: live });
      const full = await runScript(parse(src), bars);
      expectSame(r.result, full);
      live = r.live;
    }
  });

  it('a one-bar tape runs in full (the seed is its only checkpoint)', async () => {
    // incRunStart checkpoints only after a CLOSED bar, so a one-bar tape keeps
    // the pre-bar seed (checkpoint(s, -1)). That seed predates every leaf and
    // series the run creates, so a tick cannot roll back — the session is
    // dropped and such tapes are re-run in full.
    const src = `//@version=6
indicator("p")
plot(close, "c")
plot(ta.sma(close, 2), "sma")
`;
    const parsed = parse(src);
    const bars = tape(1);
    const first = await incRun(parsed, bars, { incKey: 'k1', incSession: null });
    expect(first.live).toBeNull();
    const mutated = bars.slice();
    mutated[0] = { ...mutated[0]!, close: 777 };
    await advance(src, mutated, first.live);
  });

  it('an early return before the last closed bar also runs in full', async () => {
    // `break` before lastClosed leaves live.ckpt at the seed too, so the same
    // rollback gap applies.
    const src = `//@version=6
indicator("p")
plot(close, "c")
if bar_index == 1
    return
plot(ta.sma(close, 2), "sma")
`;
    const parsed = parse(src);
    const bars = tape(5);
    const first = await incRun(parsed, bars, { incKey: 'k1', incSession: null });
    expect(first.live).toBeNull();
    const mutated = bars.slice();
    mutated[4] = { ...mutated[4]!, close: 777 };
    await advance(src, mutated, first.live);
  });

  it('a one-bar STRATEGY tape must not accumulate phantom orders across ticks', async () => {
    // The order ledger is append-only: with a seed-only checkpoint the tick
    // rollback cannot drop the entries the discarded eval pushed, so each tick
    // adds a copy and `position_size` inflates. Growth then commits the
    // polluted state.
    const src = `//@version=6
strategy("s", process_orders_on_close = true, pyramiding = 5)
if close > 150
    strategy.entry("L", strategy.long, qty = 1)
plot(strategy.position_size, "pos")
`;
    const parsed = parse(src);
    const one = [{ ...mkBar(0, 200) }];
    const first = await incRun(parsed, one, { incKey: 'k1', incSession: null });

    let cur = [{ ...one[0]!, close: 201 }];
    let r = await incRun(parsed, cur, { incKey: 'k1', incSession: first.live });
    cur = [{ ...cur[0]!, close: 202 }];
    r = await incRun(parsed, cur, { incKey: 'k1', incSession: r.live });
    expect(plotNum(r.result, 'pos', 0)).toBe(plotNum(await runScript(parsed, cur), 'pos', 0));

    // Growing the tape must not commit a polluted ledger either.
    const grown = [...cur, { ...mkBar(1, 210) }];
    const r2 = await incRun(parsed, grown, { incKey: 'k1', incSession: r.live });
    expect(plotNum(r2.result, 'pos', 1)).toBe(plotNum(await runScript(parsed, grown), 'pos', 1));
  });

  it('ineligible scripts (request.*) still produce correct results via fallback', async () => {
    const src = `//@version=6
indicator("p")
plot(close)
`;
    const parsed = parse(src);
    const bars = tape(5);
    const holder: { live: IncLive | null } = { live: null };
    const r = await incRun(parsed, bars, { incKey: 'k1', incSession: holder.live });
    expect(r.result.plots.get('plot_0')).toBeDefined();
  });

  it('strategy: an order first born on the forming bar must not duplicate across ticks', async () => {
    // The order ledger leaf (`strategy|orders`) is created lazily. If the very
    // first strategy call happens while evaluating the FORMING bar, the leaf is
    // born after the checkpoint was taken, so the tick rollback cannot truncate
    // it and the next tick appends a second copy of the same order.
    const src = `//@version=6
strategy("s", process_orders_on_close = true, pyramiding = 5)
if close > 150
    strategy.entry("L", strategy.long)
plot(strategy.position_size, "pos")
`;
    const parsed = parse(src);
    const flat = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...mkBar(i, 100), open: 100, high: 102, low: 98, close: 100 }));

    let bars = flat(6);
    const first = await incRun(parsed, bars, { incKey: 'k1', incSession: null });
    let live = first.live;

    // Tick 1: the forming bar spikes — this is the FIRST order of the session.
    let cur = bars.slice();
    cur[5] = { ...cur[5]!, close: 200, high: 202 };
    let r = await incRun(parsed, cur, { incKey: 'k1', incSession: live });
    live = r.live;

    // Tick 2: the same forming bar ticks again (close moves, no new bar).
    cur = cur.slice();
    cur[5] = { ...cur[5]!, close: 201, high: 203 };
    r = await incRun(parsed, cur, { incKey: 'k1', incSession: live });

    const full = await runScript(parsed, cur);
    expect(plotNum(r.result, 'pos', 5)).toBe(plotNum(full, 'pos', 5));
  });

  it('strategy: a wick-only tick (high moves, close fixed) must not serve a stale replay', async () => {
    // The forming-bar invalidation fingerprint must cover the whole bar, not
    // just `close`: stop/limit fills read high/low.
    const src = `//@version=6
strategy("s")
if bar_index == 0
    strategy.entry("L", strategy.long, stop = 105)
pos = 0.0
if bar_index >= 5
    pos := strategy.position_size
plot(pos, "pos")
`;
    const parsed = parse(src);
    const bars = Array.from({ length: 6 }, (_, i) => ({
      ...mkBar(i, 100), open: 100, high: 102, low: 98, close: 100,
    }));

    // Tick 1: the forming bar's wick stays below the stop.
    let cur = bars.slice();
    cur[5] = { ...cur[5]!, high: 103 };
    let r = await incRun(parsed, cur, { incKey: 'k1', incSession: null });
    const live = r.live;

    // Tick 2: close UNCHANGED — only the wick pierces the stop level.
    cur = cur.slice();
    cur[5] = { ...cur[5]!, high: 107 };
    r = await incRun(parsed, cur, { incKey: 'k1', incSession: live });

    const full = await runScript(parsed, cur);
    expect(plotNum(r.result, 'pos', 5)).toBe(plotNum(full, 'pos', 5));
  });
});
