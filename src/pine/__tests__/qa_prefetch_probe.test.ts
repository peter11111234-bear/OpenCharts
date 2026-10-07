// QA4 probe: prefetch fetchSeries failure → spec degrades to na, run completes,
// mutex tail stays healthy. Reject path verified; hang path bounded by the
// 30s prefetch timeout.
import { describe, expect, it, vi } from 'vitest';
import { runScript } from '../interpreter';
import { parse } from '../parser';
import { resetMtf } from '../mtf';
import type { BarData } from '../contracts';
import '../builtins/index';
import '../mtf';

const mkBarData = (n: number, tfMs = 60_000): BarData[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: i * tfMs, open: i + 1, high: i + 2, low: i, close: i + 1, volume: 1000 + i,
  }));

// One event-loop macrotask turn — mirrors turn() in qa_yield_c560c0f.test.ts.
const turn = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); ch.port2.close(); resolve(); };
  ch.port2.postMessage(null);
  return promise;
};

const SEC_SRC = 'indicator("s")\nh = request.security(syminfo.tickerid, "60", close)\nplot(h)';

describe('QA4: prefetch failure modes', () => {
  // Contract (round-4 fix): a failed/hung fetch degrades its spec to na —
  // the run completes instead of rejecting or wedging the mutex.
  it('fetchSeries reject → spec degrades to na, run completes; tail healthy', async () => {
    resetMtf();
    const res = await runScript(parse(SEC_SRC), mkBarData(6), {
      timeframe: '15',
      fetchSeries: async () => { throw new Error('shioaji down'); },
    });
    const vals = [...res.plots.values()][0]!.values;
    expect(vals).toHaveLength(6);
    expect(vals.every(v => v.kind === 'na')).toBe(true);
    const ok = await runScript(parse('indicator("ok")\nplot(close)'), mkBarData(3));
    expect([...ok.plots.values()][0]!.values).toHaveLength(3);
  });

  it('one of two specs rejects → that spec is na, the other works', async () => {
    resetMtf();
    // spec A on the CHART's own tf so it always aligns (never starved by lookahead clipping);
    // spec B's tf rejects and must degrade to na without killing A.
    const src = 'indicator("s")\na = request.security(syminfo.tickerid, "15", close)\nb = request.security(syminfo.tickerid, "120", open)\nplot(a)\nplot(b)';
    const res = await runScript(parse(src), mkBarData(6), {
      timeframe: '15',
      fetchSeries: async (_s, t) => t === '15' ? mkBarData(6) : Promise.reject(new Error('tf120 fail')),
    });
    const [pa, pb] = [...res.plots.values()];
    expect(pa!.values.some(v => v.kind !== 'na')).toBe(true);
    expect(pb!.values.every(v => v.kind === 'na')).toBe(true);
  });

  it('hung fetchSeries hits timeout → run resolves, mutex releases', async () => {
    vi.useFakeTimers();
    try {
      resetMtf();
      const { promise: gate } = Promise.withResolvers<BarData[]>(); // never resolves
      const pA = runScript(parse(SEC_SRC), mkBarData(6), {
        timeframe: '15',
        fetchSeries: () => gate,
      });
      // Fire the 30s prefetch timeout deterministically.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(31_000);
      const res = await pA;
      expect([...res.plots.values()][0]!.values.every(v => v.kind === 'na')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
