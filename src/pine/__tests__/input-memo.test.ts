import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins';
import { __inputSchemaBuilds } from '../builtins/input';
import { BUILTINS, registerBuiltin } from '../builtins/registry';
import { bindArgs, type RtCtx } from '../builtins/util';
import type { Value } from '../contracts';
import { NA } from '../contracts';
import { mkBars } from './golden';

// Minimal RtCtx for driving input.* builtins directly — overrides are keyed by
// title, and ctx.callsite/miscSeq control memo identity. Double-cast: the test
// ctx deliberately omits Series fields the scalar-input path never touches.
const mkCtx = () => ({
  barIndex: 0, barCount: 1, plots: [], drawings: [], warnings: [], alerts: [],
  syminfo: {},
  timeframe: { period: '1', multiplier: 1, isseconds: false, isminutes: true, isdaily: false, isweekly: false, ismonthly: false, isintraday: true },
  callUdf: () => NA,
  inputs: {} as Record<string, unknown>,
}) as unknown as RtCtx;

describe('input per-callsite memo', () => {
  it('schema build runs once per callsite, not per bar', async () => {
    const src = 'indicator("t")\na = input.int(1, "a")\nb = input.float(2.0, "b")\nplot(a+b)';
    const before = __inputSchemaBuilds;
    await runScript(parse(src), mkBars(50), {
      symbol: 'X',
      timeframe: '1',
      fetchSeries: async () => [],
    });
    const after = __inputSchemaBuilds;
    expect(after - before).toBe(2); // 2 callsites, 1 build each
  });

  it('input override is honored', async () => {
    // runScript builds a fresh ctx per run, so true mid-run ctx.inputs mutation
    // is untestable through it — the direct-builtin tests below cover
    // deletion/addition on a live ctx. This test asserts the override path.
    const src = 'indicator("t")\na = input.int(1, "a")\nplot(a)';
    const r1 = await runScript(parse(src), mkBars(5), {
      symbol: 'X',
      timeframe: '1',
      fetchSeries: async () => [],
      inputValues: { a: 7 },
    });
    // plot of `a` should be 7 (override), not 1.
    const plot = r1.plots.get('plot_0') ?? r1.plots.values().next().value;
    const vals = (plot?.values ?? []).map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na'));
    expect(vals).toEqual([7, 7, 7, 7, 7]);
  });

  it('deleting ctx.inputs mid-run falls back to defval (memo holds defval, not resolved)', () => {
    const fn = BUILTINS.get('input.int')!;
    const ctx = mkCtx();
    const inputs: Record<string, unknown> = { a: 7 };
    ctx.inputs = inputs;
    ctx.callsite = '#1';
    const args = [{ kind: 'int', v: 1 } as Value];
    const named = { title: { kind: 'string', v: 'a' } as Value };
    // Regression: first call memoized resolved=7; a second call after deleting
    // the override returned the stale 7 instead of the defval.
    expect(fn(ctx, args, named)).toEqual({ kind: 'int', v: 7 });
    delete inputs.a;
    expect(fn(ctx, args, named)).toEqual({ kind: 'int', v: 1 });
    // Re-adding an override mid-run also lands (same re-read path).
    inputs.a = 9;
    expect(fn(ctx, args, named)).toEqual({ kind: 'int', v: 9 });
  });

  it('callsite-less invocations get distinct memo keys (miscSeq increments)', () => {
    const fn = BUILTINS.get('input.int')!;
    const ctx = mkCtx();
    // No ctx.callsite — the fallback site id must differ per invocation.
    // Regression: `g${ctx.miscSeq ?? 0}` never incremented, so every callsite-less
    // call collided on 'g0' and the second input returned the first's memo.
    const v1 = fn(ctx, [{ kind: 'int', v: 1 } as Value], { title: { kind: 'string', v: 'a' } as Value });
    const v2 = fn(ctx, [{ kind: 'int', v: 2 } as Value], { title: { kind: 'string', v: 'b' } as Value });
    expect(v1).toEqual({ kind: 'int', v: 1 });
    expect(v2).toEqual({ kind: 'int', v: 2 });
  });

  it('bindWarnQ drains on thrown builtin — no leak onto the next ctx', async () => {
    // Fixture: queues a bind-time warning (series=→source collision), then throws.
    registerBuiltin('', 'zzwarnthrow', (_c, args, named) => {
      bindArgs(args, named, ['source', 'len']);
      throw new Error('zzwarnthrow boom');
    });
    const opts = { symbol: 'X', timeframe: '1', fetchSeries: async () => [] as never[] };
    // The builtin throws — runScript rethrows the bar error, but the finally
    // drain still flushed the queued warning into the (now discarded) ctx.
    await expect(runScript(parse('indicator("t")\nzzwarnthrow(source=1, series=2)'), mkBars(3), opts))
      .rejects.toThrow('zzwarnthrow boom');
    // Regression: without the finally-drain the warning stayed queued and the
    // NEXT run's first builtin call picked it up on a different ctx.
    const r2 = await runScript(parse('indicator("t")\nplot(input.int(5, "x"))'), mkBars(3), opts);
    expect(r2.warnings.filter(w => w.includes('collides'))).toEqual([]);
  });
});
