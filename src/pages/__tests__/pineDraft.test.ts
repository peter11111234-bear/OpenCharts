import { describe, it, expect, vi, afterEach } from 'vitest';
import { PINE_DRAFT_KEY, createDraftWriter, draftRestore, readPineDraft, writePineDraft } from '../pineDraft.ts';

/** Minimal in-memory Storage. */
function memStore(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  } as Storage & { map: Map<string, string> };
}

/** Storage whose every write throws, like a full quota. */
const fullStore = (): Storage => ({
  ...memStore(),
  setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
} as unknown as Storage);

const none = () => false;
const has = (...ids: string[]) => (id: string) => ids.includes(id);

describe('writePineDraft / readPineDraft', () => {
  it('round-trips { id, src } under the draft key', () => {
    const s = memStore();
    writePineDraft(s, { id: 'a', src: 'body' });
    expect(s.map.get(PINE_DRAFT_KEY)).toBe(JSON.stringify({ id: 'a', src: 'body' }));
    expect(readPineDraft(s)).toEqual({ id: 'a', src: 'body' });
  });

  it('a null id (unsaved buffer) round-trips as null', () => {
    const s = memStore();
    writePineDraft(s, { id: null, src: 'new' });
    expect(readPineDraft(s)).toEqual({ id: null, src: 'new' });
  });

  it('a write that throws is swallowed, not propagated', () => {
    expect(() => writePineDraft(fullStore(), { id: null, src: 'x' })).not.toThrow();
  });

  it('read returns null when nothing is stored', () => {
    expect(readPineDraft(memStore())).toBeNull();
  });

  it('read returns null for corrupt JSON, a missing src, or a non-string src', () => {
    const s = memStore();
    s.setItem(PINE_DRAFT_KEY, '{not json');
    expect(readPineDraft(s)).toBeNull();
    s.setItem(PINE_DRAFT_KEY, JSON.stringify({ id: 'a' }));
    expect(readPineDraft(s)).toBeNull();
    s.setItem(PINE_DRAFT_KEY, JSON.stringify({ id: 'a', src: 42 }));
    expect(readPineDraft(s)).toBeNull();
  });

  it('read tolerates a non-string id by treating it as null', () => {
    const s = memStore();
    s.setItem(PINE_DRAFT_KEY, JSON.stringify({ id: 7, src: 'body' }));
    expect(readPineDraft(s)).toEqual({ id: null, src: 'body' });
  });

  it('read returns null when storage itself throws', () => {
    const s = memStore();
    s.getItem = () => { throw new DOMException('denied', 'SecurityError'); };
    expect(readPineDraft(s)).toBeNull();
  });
});

describe('createDraftWriter', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a burst of schedules writes once, after the pause', () => {
    vi.useFakeTimers();
    const s = memStore();
    let text = 'a';
    const w = createDraftWriter(s, () => ({ id: null, src: text }), 500);
    w.schedule(); text = 'ab'; w.schedule(); text = 'abc'; w.schedule();
    vi.advanceTimersByTime(499);
    expect(s.map.has(PINE_DRAFT_KEY)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(readPineDraft(s)).toEqual({ id: null, src: 'abc' });
  });

  it('flush writes immediately and cancels the pending timer', () => {
    vi.useFakeTimers();
    const s = memStore();
    let text = 'x';
    const w = createDraftWriter(s, () => ({ id: 'a', src: text }), 500);
    w.schedule(); text = 'xy';
    w.flush();
    expect(readPineDraft(s)).toEqual({ id: 'a', src: 'xy' });
    s.map.clear();
    vi.advanceTimersByTime(1000);
    expect(s.map.has(PINE_DRAFT_KEY)).toBe(false);
  });

  it('a read that throws (editor torn down) is ignored by flush', () => {
    const s = memStore();
    const w = createDraftWriter(s, () => { throw new Error('disposed'); });
    expect(() => w.flush()).not.toThrow();
    expect(s.map.has(PINE_DRAFT_KEY)).toBe(false);
  });
});

describe('draftRestore', () => {
  it('no draft → nothing to restore', () => {
    expect(draftRestore(null, null, none)).toBeNull();
    expect(draftRestore(null, 'a', none)).toBeNull();
  });

  it('new unsaved buffer (no current script): restores the text, id null', () => {
    expect(draftRestore({ id: null, src: 'new' }, null, none)).toEqual({ src: 'new', id: null });
  });

  it('no current script, draft names a script still in the library: adopts that id', () => {
    expect(draftRestore({ id: 'a', src: 'edit' }, null, has('a'))).toEqual({ src: 'edit', id: 'a' });
  });

  it('no current script, draft names a script that was deleted: restores text, drops the id', () => {
    expect(draftRestore({ id: 'gone', src: 'edit' }, null, none)).toEqual({ src: 'edit', id: null });
  });

  it('same script is open: keeps its unsaved edits (the F5 case for a saved script)', () => {
    expect(draftRestore({ id: 'a', src: 'unsaved' }, 'a', has('a'))).toEqual({ src: 'unsaved', id: 'a' });
  });

  it('a different script is open: the draft is not applied', () => {
    expect(draftRestore({ id: 'a', src: 'unsaved' }, 'b', has('a', 'b'))).toBeNull();
  });

  it('an unsaved draft does not replace a saved script that is open', () => {
    expect(draftRestore({ id: null, src: 'scratch' }, 'b', has('b'))).toBeNull();
  });
});
