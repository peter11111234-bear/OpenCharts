import { describe, expect, it, vi } from 'vitest';
import '../builtins/index';
import '../mtf';

const parseCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../parser', async (orig) => {
  const real = await orig<typeof import('../parser')>();
  return { ...real, parse: (...a: Parameters<typeof real.parse>) => { parseCalls.n++; return real.parse(...a); } };
});

const { PineInterpreterEngine, prewarmPrepare } = await import('../engine');

type Tok = { parsed: unknown; instanceId: string; modelId: string };
const src = (tag: string) => `//@version=6\nindicator("${tag}")\nplot(close)\n`;

describe('prepare parse cache', () => {
  it('a second prepare of the same source reuses the AST, with its own token', async () => {
    const e = new PineInterpreterEngine();
    const before = parseCalls.n;
    const a = await e.prepare(src('a'), 'i1');
    const b = await new PineInterpreterEngine().prepare('﻿' + src('a'), 'i2');
    expect(parseCalls.n - before).toBe(1);
    const ta = a.token as Tok, tb = b.token as Tok;
    expect(tb.parsed).toBe(ta.parsed);
    expect([ta.instanceId, tb.instanceId]).toEqual(['i1', 'i2']);
    expect(tb.modelId).toBe(ta.modelId);
    expect(b.inputs).not.toBe(a.inputs);
  });

  it('a script that fails the compile gate is not cached and fails every time', async () => {
    const e = new PineInterpreterEngine();
    const bad = '//@version=6\nindicator("x")\nplot(close\n';
    await expect(e.prepare(bad, 'i')).rejects.toThrow();
    const before = parseCalls.n;
    await expect(e.prepare(bad, 'i')).rejects.toThrow();
    expect(parseCalls.n - before).toBe(1);
  });

  it('prewarmPrepare parses ahead so the real prepare does not parse', async () => {
    vi.useFakeTimers();
    try {
      prewarmPrepare([src('w1'), '//@version=6\nindicator("x")\nplot(close\n', src('w2')]);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    const before = parseCalls.n;
    await new PineInterpreterEngine().prepare(src('w1'), 'i');
    await new PineInterpreterEngine().prepare(src('w2'), 'i');
    expect(parseCalls.n - before).toBe(0);
  });

  it('keeps at most 8 sources (oldest evicted)', async () => {
    const e = new PineInterpreterEngine();
    for (let i = 0; i < 9; i++) await e.prepare(src('lru' + i), 'i');
    const before = parseCalls.n;
    await e.prepare(src('lru8'), 'i');
    expect(parseCalls.n - before).toBe(0);
    await e.prepare(src('lru0'), 'i');
    expect(parseCalls.n - before).toBe(1);
  });
});
