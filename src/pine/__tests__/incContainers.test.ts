// Container checkpoint window (I1-③): a checkpoint only deep-clones the cells
// of a `hasContainers` series that the script's history reads can still reach,
// so a tick never pays O(bars) clones. Reading farther than the window forces
// a full rebuild instead of silently restoring stale slots.
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

/** Tick tape: mutate the forming bar most ticks, append a bar every 5th. */
function nextTape(bars: BarData[], t: number): BarData[] {
  const next = bars.slice();
  const last = next[next.length - 1]!;
  if (t % 5 === 4) {
    const open = last.closeTime ?? last.openTime + 60_000;
    next.push({
      openTime: open, closeTime: open + 60_000,
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
}

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

/** Advance `ticks` times, comparing every tick with a full rerun. Returns, per
 *  tick, whether the incremental session was replaced (i.e. it fell back). */
async function parityTicks(
  src: string, bars: BarData[], ticks: number, opts: Record<string, unknown> = OPTS,
): Promise<boolean[]> {
  const parsed = parse(src);
  const first = await incRun(parsed, bars, { ...opts, incKey: 'fx', incSession: null });
  expect(first.live).not.toBeNull();
  let live: IncLive = first.live!;
  let tape = bars;
  const replaced: boolean[] = [];
  for (let t = 0; t < ticks; t++) {
    tape = nextTape(tape, t);
    const inc = await incRun(parsed, tape, { ...opts, incKey: 'fx', incSession: live });
    expect(inc.live, `tick ${t} lost its live session`).not.toBeNull();
    replaced.push(inc.live !== live);
    live = inc.live!;
    // A fresh parse keeps runScript from sharing any memo with the session.
    expectSame(inc.result, await runScript(parse(src), tape, opts as never));
  }
  return replaced;
}

const V6 = '//@version=6\nindicator("fx")\n';
const OPTS = { symbol: 'T', timeframe: '5' };

const FX: Record<string, string> = {
  // var array pushed every bar, history read of `a[1]`.
  'fx-var-array-hist': V6 + `var a = array.new_float()
array.push(a, close)
float s1 = na
float g1 = na
if bar_index > 0
    s1 := array.size(a[1])
    g1 := array.get(a[1], array.size(a[1]) - 1)
plot(array.size(a))
plot(s1)
plot(g1)
`,
  // fresh array.from every bar, history read of `b[2]`.
  'fx-per-bar-from': V6 + `b = array.from(close, open, high)
float h2 = na
if bar_index > 1
    h2 := array.get(b[2], 0)
plot(array.avg(b))
plot(h2)
`,
  // var UDT array + array.copy + field write, history read of `c[1]`.
  'fx-udt-copy-shared': V6 + `type P
    float v
var ps = array.new<P>()
if array.size(ps) < 3
    array.push(ps, P.new(close))
p0 = array.get(ps, 0)
p0.v := p0.v + 1
c = array.copy(ps)
float prev = na
if bar_index > 0
    prev := array.get(c[1], 0).v
plot(array.get(c, 0).v)
plot(prev)
`,
  // push INTO a historical array cell.
  'fx-push-into-hist': V6 + `a = array.from(close)
float n1 = na
if bar_index > 0
    array.push(a[1], high)
    n1 := array.size(a[1])
plot(n1)
plot(array.size(a))
`,
  // offset grows with bar_index: reads leave any fixed window → full rebuild.
  'fx-growing-offset': V6 + `b = array.from(close, low)
k = math.min(bar_index, 400)
array.set(b[k], 1, close)
plot(array.get(b[k], 1))
plot(array.get(b[k], 0))
`,
};

describe('container checkpoint window', () => {
  for (const [name, src] of Object.entries(FX)) {
    it(`${name}: 30 ticks (bar every 5th) match a full rerun`, async () => {
      await parityTicks(src, mkBars(300), 30);
    }, 120_000);
  }

  it('fx-growing-offset: a growing read offset falls back to a full rebuild', async () => {
    const replaced = await parityTicks(FX['fx-growing-offset']!, mkBars(300), 30);
    const appended = replaced.filter((_, t) => t % 5 === 4);
    expect(appended.length).toBe(6);
    expect(appended.every(Boolean)).toBe(true);
  }, 120_000);

  it('maxOff records the deepest history read and survives a null rewind', () => {
    const se = new BarSeries();
    for (let i = 0; i < 10; i++) se.setAt(i, { kind: 'float', v: i });
    expect(se.incMaxOff).toBe(0);
    se.get(3);
    expect(se.incMaxOff).toBe(3);
    se.get(1);
    expect(se.incMaxOff).toBe(3); // monotone: records the max, not the last
    se.incRewind(null);
    expect(se.incMaxOff).toBe(3); // a discarded tick's reads still count
  });

  it('tech-rating: the checkpoint window covers O(1) cells, not O(bars)', async () => {
    const src = readFileSync(join(__dirname, '..', 'tech-rating.pine'), 'utf8');
    const live = (await incRun(parse(src), mkBars(2000), { ...OPTS, incKey: 'w', incSession: null })).live;
    expect(live).not.toBeNull();
    const ck = (live as unknown as {
      ckpt: { containerWin: Map<BarSeries, number> };
    }).ckpt;
    expect(ck.containerWin).toBeInstanceOf(Map);
    let cells = 0;
    for (const [se, lo] of ck.containerWin) {
      const buf = se.incBuf;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (se.incBarAt(i) < lo) break;
        const v = buf[i] as { kind?: string } | undefined;
        if (v && typeof v === 'object'
            && (v.kind === 'array' || v.kind === 'map' || v.kind === 'matrix' || v.kind === 'udt')) cells++;
      }
    }
    expect(cells).toBeGreaterThan(0);
    expect(cells).toBeLessThanOrEqual(10);
  }, 120_000);
});
