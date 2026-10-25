// AST-by-reference protocol: once a worker holds a prepared script's AST, the
// client ships only its id — the per-tick structured-clone of the whole AST
// disappears. Covers the miss path (worker evicted the body) and the
// incremental session that must keep working across reference runs.
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
 *  `parsed`. Messages cross on microtasks, like a real worker's postMessage. */
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

const SRC = `//@version=6
indicator("ast cache")
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


describe('pine worker AST cache (send AST once per worker)', () => {
  it('sends the AST on the first run only, with identical results', async () => {
    const w = new RecordingWorker();
    const c = new PineRunClient({ factory: () => w });
    const parsed = parse(SRC);
    const bars = mkBars(60);

    const a = await c.run({ parsed, bars });
    const b = await c.run({ parsed, bars });
    const d = await c.run({ parsed, bars });

    const runs = w.runs();
    expect(runs).toHaveLength(3);
    expect(runs[0]!.parsed).toBeDefined();
    expect(runs[1]!.parsed).toBeUndefined();
    expect(runs[2]!.parsed).toBeUndefined();
    // The id travels on every run — it is what the worker resolves against.
    expect(runs.map((r) => r.astId)).toEqual([runs[0]!.astId, runs[0]!.astId, runs[0]!.astId]);
    expect(typeof runs[0]!.astId).toBe('string');

    const ref = plotsOf(await runScript(parse(SRC), bars));
    expect(plotsOf(a)).toEqual(ref);
    expect(plotsOf(b)).toEqual(ref);
    expect(plotsOf(d)).toEqual(ref);
  });

  it('different parsed objects each carry their AST the first time', async () => {
    const w = new RecordingWorker();
    const c = new PineRunClient({ factory: () => w });
    const bars = mkBars(30);
    const p1 = parse(SRC);
    const p2 = parse(SRC.replace('ta.sma(close, 5)', 'ta.sma(close, 9)'));
    expect(p1).not.toBe(p2);

    await c.run({ parsed: p1, bars });
    await c.run({ parsed: p2, bars });
    await c.run({ parsed: p1, bars });
    await c.run({ parsed: p2, bars });

    const runs = w.runs();
    expect(runs.map((r) => r.parsed !== undefined)).toEqual([true, true, false, false]);
    expect(runs[0]!.astId).not.toBe(runs[1]!.astId);
  });

  it('a fresh worker always gets the AST body', async () => {
    const w1 = new RecordingWorker();
    const w2 = new RecordingWorker();
    const parsed = parse(SRC);
    const bars = mkBars(20);

    await new PineRunClient({ factory: () => w1 }).run({ parsed, bars });
    const second = await new PineRunClient({ factory: () => w1 }).run({ parsed, bars });
    const third = await new PineRunClient({ factory: () => w2 }).run({ parsed, bars });

    expect(w1.runs().map((r) => r.parsed !== undefined)).toEqual([true, false]);
    // New client + new worker: module-level id is shared, the worker cache is not.
    expect(w2.runs()[0]!.parsed).toBeDefined();
    expect(w2.runs()[0]!.astId).toBe(w1.runs()[0]!.astId);
    expect(plotsOf(second)).toEqual(plotsOf(third));
  });

  it('recovers from a worker-side eviction via one PineAstMiss resend', async () => {
    const w = new RecordingWorker();
    const c = new PineRunClient({ factory: () => w });
    const bars = mkBars(20);
    const first = parse(SRC);

    await c.run({ parsed: first, bars });
    // Fill the worker's 8-slot AST cache with other prepared ASTs — the first
    // one is the oldest and gets evicted. The client still believes it is there.
    for (let i = 0; i < 8; i++) {
      await c.run({ parsed: parse(SRC.replace('5)', `${i + 6})`)), bars });
    }

    const before = w.sent.length;
    const result = await c.run({ parsed: first, bars });
    const runs = w.runs();

    // Exactly two messages for this run: the reference attempt, then the body.
    expect(w.sent.length - before).toBe(2);
    const [missed, resent] = runs.slice(-2) as [typeof runs[0], typeof runs[0]];
    expect(missed.id).toBe(resent.id);
    expect(missed.parsed).toBeUndefined();
    expect(resent.parsed).toBeDefined();
    expect(w.got.filter((m) => m.t === 'fail' && m.error.name === 'PineAstMiss')).toHaveLength(1);
    expect(plotsOf(result)).toEqual(plotsOf(await runScript(parse(SRC), bars)));

    // The body is cached again — the next run goes back to id-only.
    const after = w.sent.length;
    await c.run({ parsed: first, bars });
    expect(w.sent.length - after).toBe(1);
    expect(w.runs().at(-1)!.parsed).toBeUndefined();
  });

  it('keeps incremental sessions alive across reference-only ticks', async () => {
    const w = new RecordingWorker();
    const c = new PineRunClient({ factory: () => w });
    const parsed = parse(SRC);
    const opts = { incKey: 'inc-1' };

    const bars = mkBars(20);
    await c.run({ parsed, bars, opts });
    // Same incKey, growing tape: ticks 2..3 must resolve the AST by id.
    const tick2Bars = [...bars, ...mkBars(3, 200).map((b, i) => ({ ...b, openTime: b.openTime + i }))];
    const tick2 = await c.run({ parsed, bars: tick2Bars, opts });
    // Compare NOW: the client patches this Map in place, so a later tick would
    // mutate the arrays under the assertion.
    expect(plotsOf(tick2)).toEqual(plotsOf(await runScript(parse(SRC), tick2Bars)));
    const tick3Bars = [...tick2Bars, ...mkBars(2, 300).map((b, i) => ({ ...b, openTime: b.openTime + i }))];
    const tick3 = await c.run({ parsed, bars: tick3Bars, opts });

    const runs = w.runs();
    expect(runs.map((r) => r.parsed !== undefined)).toEqual([true, false, false]);
    const dones = w.got.filter((m) => m.t === 'done');
    expect(dones.map((m) => (m.t === 'done' ? m.incAlive : undefined))).toEqual([true, true, true]);
    expect(dones.at(-1)!.t === 'done' && dones.at(-1)!.plotDelta !== undefined).toBe(true);

    // Patched client-side plots must equal a fresh full run on the final tape.
    expect(plotsOf(tick3)).toEqual(plotsOf(await runScript(parse(SRC), tick3Bars)));
  });
});
