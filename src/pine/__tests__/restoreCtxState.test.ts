import { describe, expect, it } from 'vitest';
import { restoreCtxState, snapCtxState } from '../interpreter';

// A VS-shaped leaf as ta.ts builds them: memo keys never exceed `last`.
const mkVs = (keys: number[], last: number) => ({
  last,
  memo: new Map<number, number | undefined>(keys.map((k) => [k, k * 10])),
  get(b: number) { return b; },
});

const restore = (state: Map<unknown, unknown>, bar: number) => {
  const ids = new Map();
  restoreCtxState(snapCtxState(state, ids), bar, ids);
};

describe('restoreCtxState memo pruning', () => {
  it('drops exactly the VS memo keys above the committed bar, sparse keys included', () => {
    const vs = mkVs([0, 1, 2, 5, 7, 8, 9], 7);
    const state = new Map<unknown, unknown>([['v', vs]]);
    const ids = new Map();
    const ck = snapCtxState(state, ids);
    // Forming bar 8..9 evaluated after the checkpoint.
    vs.memo.set(8, 80); vs.memo.set(9, 90); vs.last = 9;
    restoreCtxState(ck, 5, ids);
    expect([...vs.memo.keys()]).toEqual([0, 1, 2, 5]);
    expect(vs.last).toBe(7);
  });

  it('keeps every key when nothing is above the bar', () => {
    const vs = mkVs([0, 1, 2], 2);
    restore(new Map<unknown, unknown>([['v', vs]]), 2);
    expect([...vs.memo.keys()]).toEqual([0, 1, 2]);
  });

  it('falls back to a full scan when the bound is not an integer', () => {
    const vs = mkVs([0, 1, 4], 4);
    const state = new Map<unknown, unknown>([['v', vs]]);
    const ids = new Map();
    const ck = snapCtxState(state, ids);
    vs.last = Number.POSITIVE_INFINITY;
    restoreCtxState(ck, 1, ids);
    expect([...vs.memo.keys()]).toEqual([0, 1]);
  });

  it('prunes bar-number maps above the bar', () => {
    const nm = new Map<number, number>([[0, 1], [3, 1], [6, 1], [2, 1]]);
    restore(new Map<unknown, unknown>([['n', nm]]), 2);
    expect([...nm.keys()]).toEqual([0, 2]);
  });
});
