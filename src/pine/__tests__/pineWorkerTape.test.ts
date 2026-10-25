// Bars-by-reference protocol: once a worker holds an incKey's tape, the client
// ships only the changed tail (base/from/tail) instead of all ~5000 bars. The
// worker rebuilds the tape from its own copy, so the per-tick structured clone
// collapses to a handful of bars. Covers miss handling (worker evicted the
// tape), client-side shrink/prefix detection, and worker turnover.
import { describe, it, expect } from 'vitest';
import { createWorkerHandler } from '../pineWorker';
import { PineRunClient, type WorkerLike } from '../pineWorkerClient';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { BarData, RunResult } from '../contracts';
import type { ToWorker, FromWorker } from '../pineWorkerProto';
import '../builtins/index';

/** FakeWorker: runs createWorkerHandler in-process and records every `run`
 *  message the client posted, so the test can assert which ones carried
 *  `bars` and which carried `tape`. Messages cross on microtasks, like a real
 *  worker's postMessage. */
class RecordingWorker implements WorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  terminated = false;
  readonly sent: ToWorker[] = [];
  readonly got: FromWorker[] = [];
  private readonly handler = createWorkerHandler((m) => {
    this.got.push(m);
    queueMicrotask(() => this.onmessage?.({ data: m }));
  });

  postMessage(m: unknown): void {
    const msg = m as ToWorker;
    this.sent.push(msg);
    queueMicrotask(() => {
      if (this.terminated) return;
      this.handler(msg);
    });
  }
  terminate(): void { this.terminated = true; }

  /** `run` messages only — fetch plumbing is irrelevant here. */
  runs(): Extract<ToWorker, { t: 'run' }>[] {
    return this.sent.filter((m): m is Extract<ToWorker, { t: 'run' }> => m.t === 'run');
  }
}

const mkBars = (n: number, base = 100): BarData[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: 1_700_000_000_000 + i * 60_000,
    closeTime: 1_700_000_000_000 + (i + 1) * 60_000 - 1,
    open: base + i - 1,
    high: base + i + 2,
    low: base + i - 2,
    close: base + i,
    volume: 1000 + i,
  }));

/** A new tape with the forming (last) bar rewritten — the live-tick shape. */
const rewriteLast = (bars: BarData[], close: number): BarData[] => {
  const out = bars.slice();
  const last = out[out.length - 1]!;
  out[out.length - 1] = { ...last, close, high: Math.max(last.high, close) };
  return out;
};

/** A new tape with one extra bar appended. */
const appendBar = (bars: BarData[]): BarData[] => {
  const last = bars[bars.length - 1]!;
  return [...bars, {
    openTime: last.openTime + 60_000,
    closeTime: last.closeTime! + 60_000,
    open: last.close,
    high: last.close + 3,
    low: last.close - 3,
    close: last.close + 2,
    volume: last.volume + 10,
  }];
};

const SRC = `//@version=6
indicator("tape")
var n = 0
n := n + 1
sma = ta.sma(close, 5)
plot(sma, title="sma")
plot(n, title="n")
plot(close, title="c")
`;

/** Observable surfaces of two results, as JSON-comparable arrays. */
const plotsOf = (r: RunResult): [string, string][] =>
  [...r.plots.entries()].map(([k, p]) => [k, JSON.stringify([p.index, p.values])]);

/** Plots of an independent full run over `bars`. */
const fullRunPlots = async (bars: BarData[]): Promise<[string, string][]> =>
  plotsOf(await runScript(parse(SRC), bars));

describe('pine worker tape (send only the bars tail per tick)', () => {
  it('sends tape tails for five advances with results identical to full runs', async () => {
    const w = new RecordingWorker();
    const c = new PineRunClient({ factory: () => w });
    const parsed = parse(SRC);
    const opts = { incKey: 'tape-1' };

    let bars = mkBars(40);
    const first = await c.run({ parsed, bars, opts });
    expect(plotsOf(first)).toEqual(await fullRunPlots(bars));

    // Four forming-bar rewrites, then one append — five tail-only advances.
    const history: BarData[][] = [];
    for (let i = 1; i <= 4; i++) {
      bars = rewriteLast(bars, 100 + i);
      history.push(bars);
    }
    bars = appendBar(bars);
    history.push(bars);

    for (const tape of history) {
      // Compare immediately: the client patches the plot map in place, so a
      // later tick would mutate the arrays under the assertion.
      expect(plotsOf(await c.run({ parsed, bars: tape, opts }))).toEqual(await fullRunPlots(tape));
    }

    const runs = w.runs();
    expect(runs).toHaveLength(6);
    expect(runs[0]!.bars).toBeDefined();
    expect(runs[0]!.tape).toBeUndefined();
    runs.slice(1).forEach((r, i) => {
      const tick = history[i]!;
      expect(r.bars).toBeUndefined();
      expect(r.tape).toBeDefined();
      // Only the changed tail ships: at most the forming bar + one new bar.
      expect(r.tape!.tail.length).toBeLessThanOrEqual(2);
      // base + tail reconstructs exactly this tick's tape.
      expect(r.tape!.from + r.tape!.tail.length).toBe(tick.length);
      expect(r.tape!.base).toBeLessThanOrEqual(tick.length);
    });
  });

  it('recovers from worker-side tape eviction with one full resend', async () => {
    const w = new RecordingWorker();
    const c = new PineRunClient({ factory: () => w });
    const parsed = parse(SRC);
    const key = 'tape-evict';
    const bars = mkBars(20);

    await c.run({ parsed, bars, opts: { incKey: key } });
    // Push the target's tape out of the worker's 8-slot map with 8 new keys.
    // The client keeps its own record, so it still believes the tape is there.
    for (let i = 0; i < 8; i++) {
      await c.run({ parsed, bars: mkBars(20, 200 + i), opts: { incKey: `other-${i}` } });
    }

    const next = rewriteLast(bars, 555);
    const before = w.sent.length;
    const result = await c.run({ parsed, bars: next, opts: { incKey: key } });

    // Exactly two messages for this run: the tape attempt, then the full bars.
    expect(w.sent.length - before).toBe(2);
    const [, resent] = w.runs().slice(-2);
    expect(w.got.filter((m) => m.t === 'fail' && m.error.name === 'PineTapeMiss')).toHaveLength(1);
    expect(resent!.bars).toBeDefined();
    expect(resent!.tape).toBeUndefined();
    expect(plotsOf(result)).toEqual(await fullRunPlots(next));

    // The healed tape is recorded again — the next tick goes back to tail-only.
    const after = w.sent.length;
    const again = rewriteLast(next, 556);
    expect(plotsOf(await c.run({ parsed, bars: again, opts: { incKey: key } }))).toEqual(await fullRunPlots(again));
    expect(w.sent.length - after).toBe(1);
    expect(w.runs().at(-1)!.bars).toBeUndefined();
    expect(w.runs().at(-1)!.tape!.tail.length).toBe(1);
  });

  it('sends full bars when the tape shrinks', async () => {
    const w = new RecordingWorker();
    const c = new PineRunClient({ factory: () => w });
    const parsed = parse(SRC);
    const opts = { incKey: 'tape-shrink' };

    const big = mkBars(40);
    await c.run({ parsed, bars: big, opts });
    const small = big.slice(0, 30);
    const result = await c.run({ parsed, bars: small, opts });

    const last = w.runs().at(-1)!;
    expect(last.bars).toBeDefined();
    expect(last.tape).toBeUndefined();
    expect(plotsOf(result)).toEqual(await fullRunPlots(small));
  });

  it('a fresh worker always gets the full tape', async () => {
    const w1 = new RecordingWorker();
    const w2 = new RecordingWorker();
    let spawned = 0;
    const c = new PineRunClient({ factory: () => (++spawned === 1 ? w1 : w2) });
    const parsed = parse(SRC);
    const opts = { incKey: 'tape-swap' };
    const bars = mkBars(25);

    await c.run({ parsed, bars, opts });
    const second = await c.run({ parsed, bars: rewriteLast(bars, 222), opts });
    expect(w1.runs()).toHaveLength(2);
    expect(w1.runs()[1]!.tape).toBeDefined();

    // Terminate the old worker: the client's per-worker tape record is gone
    // with it (WeakMap key), so the next run on a new worker is full.
    c.dispose();
    const third = await c.run({ parsed, bars, opts });
    expect(w2!.runs()).toHaveLength(1);
    expect(w2!.runs()[0]!.bars).toBeDefined();
    expect(w2!.runs()[0]!.tape).toBeUndefined();
    expect(plotsOf(second)).toEqual(await fullRunPlots(rewriteLast(bars, 222)));
    expect(plotsOf(third)).toEqual(await fullRunPlots(bars));
  });

  it('reports from = the first rewritten prefix index', async () => {
    const w = new RecordingWorker();
    const c = new PineRunClient({ factory: () => w });
    const parsed = parse(SRC);
    const opts = { incKey: 'tape-prefix' };

    const bars = mkBars(40);
    await c.run({ parsed, bars, opts });
    // Rewrite the middle of the tape, as a history reload does.
    const edited = bars.slice();
    edited[10] = { ...edited[10]!, close: 999, high: 1000 };
    const result = await c.run({ parsed, bars: edited, opts });

    const tape = w.runs().at(-1)!.tape!;
    expect(tape.from).toBe(10);
    expect(tape.base).toBe(40);
    expect(tape.tail).toHaveLength(30);
    expect(plotsOf(result)).toEqual(await fullRunPlots(edited));
  });

  it('heals a simultaneous AST and tape miss in one resend', async () => {
    const w = new RecordingWorker();
    const c = new PineRunClient({ factory: () => w });
    const parsed = parse(SRC);
    const opts = { incKey: 'tape-both' };
    const bars = mkBars(20);

    await c.run({ parsed, bars, opts });
    // Evict both the AST and the tape: 8 distinct fresh ASTs on 8 new keys.
    for (let i = 0; i < 8; i++) {
      const other = parse(SRC.replace('5)', `${i + 6})`));
      await c.run({ parsed: other, bars: mkBars(20, 300 + i), opts: { incKey: `sweep-${i}` } });
    }

    const next = rewriteLast(bars, 777);
    const before = w.sent.length;
    const result = await c.run({ parsed, bars: next, opts });
    // The worker resolves the AST first, so that miss is the one reported;
    // the single resend carries BOTH the AST body and the full bars, so the
    // tape miss never happens and one round trip is enough.
    const [missed, resent] = w.runs().slice(-2);
    expect(w.sent.length - before).toBe(2);
    expect(w.got.filter((m) => m.t === 'fail' && m.error.name === 'PineAstMiss')).toHaveLength(1);
    expect(missed!.parsed).toBeUndefined();
    expect(missed!.tape).toBeDefined();
    expect(resent!.parsed).toBeDefined();
    expect(resent!.bars).toBeDefined();
    expect(resent!.tape).toBeUndefined();
    expect(plotsOf(result)).toEqual(await fullRunPlots(next));
  });
});
