import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  pineLibList, pineLibGet, pineLibCreate, pineLibSave, pineLibRename,
  pineLibDuplicate, pineLibRemove, pineLibRecentPush, pineLibRecent,
  pineLibMigrateLegacyHist, pineLibWriteFailed,
} from './pineLib.ts';

const LIB_KEY = 'opencharts.pine.lib';
const CORRUPT_KEY = 'opencharts.pine.lib.corrupt';

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); });

describe('pineLib CRUD', () => {
  it('create → list has it; save pushes a version', () => {
    const a = pineLibCreate('MACD V7', '//@version=6\nindicator("MACD V7")');
    expect(pineLibList()[0]!.id).toBe(a.id);
    const b = pineLibSave(a.id, '//@version=6\nindicator("MACD V7") // v2');
    expect(b.versions.length).toBe(2);
    expect(pineLibGet(a.id)!.source).toContain('v2');
  });
  it('save with identical source is a no-op (no new version)', () => {
    const a = pineLibCreate('A', 'x');
    const b = pineLibSave(a.id, 'x');
    expect(b.versions.length).toBe(1);
  });
  it('rename + duplicate + remove', () => {
    const a = pineLibCreate('A', 'x');
    pineLibRename(a.id, 'B');
    expect(pineLibGet(a.id)!.name).toBe('B');
    const c = pineLibDuplicate(a.id);
    expect(c.name).toBe('Copy of B');
    expect(c.id).not.toBe(a.id);
    pineLibRemove(a.id);
    expect(pineLibGet(a.id)).toBeUndefined();
  });
  it('remove prunes it from recent', () => {
    const a = pineLibCreate('A', 'x');
    pineLibRecentPush(a.id);
    expect(pineLibRecent()).toContain(a.id);
    pineLibRemove(a.id);
    expect(pineLibRecent()).not.toContain(a.id);
  });
  it('recent is MRU, cap 8, dedupes', () => {
    const ids = Array.from({ length: 10 }, (_, i) => pineLibCreate('s' + i, 'x').id);
    for (const id of ids) pineLibRecentPush(id);
    const r = pineLibRecent();
    expect(r.length).toBe(8);
    pineLibRecentPush(r[3]!);
    expect(pineLibRecent()[0]).toBe(r[3]);
  });
  it('migrate legacy pine-hist:* once, preserving versions', () => {
    localStorage.setItem('pine-hist:macdv7', JSON.stringify([{ t: 1, src: 'A' }, { t: 2, src: 'B' }]));
    const n = pineLibMigrateLegacyHist();
    expect(n).toBe(1);
    const s = pineLibList()[0]!;
    expect(s.versions.length).toBe(2);
    expect(s.source).toBe('B');            // latest wins
    expect(s.createdAt).toBe(1);           // keeps earliest timestamp
    expect(s.updatedAt).toBe(2);
    expect(pineLibMigrateLegacyHist()).toBe(0); // idempotent
  });
  it('migrate skips malformed legacy entries', () => {
    localStorage.setItem('pine-hist:bad', 'not json');
    expect(pineLibMigrateLegacyHist()).toBe(0);
    localStorage.setItem('pine-hist:empty', '[]');
    expect(pineLibMigrateLegacyHist()).toBe(0);
  });
});

describe('pineLib corrupt-document protection', () => {
  const CORRUPT = '{"version":1,"scripts":[{"id":"keep-me"'; // truncated JSON
  const backupKeys = (): string[] =>
    Object.keys(localStorage).filter((k) => k === CORRUPT_KEY || k.startsWith(CORRUPT_KEY + '-'));
  const backupValues = (): (string | null)[] => backupKeys().map((k) => localStorage.getItem(k));

  it('backup key holds the original bytes when a corrupt doc is overwritten', () => {
    localStorage.setItem(LIB_KEY, CORRUPT);
    pineLibCreate('New', 'src');
    const keys = backupKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^opencharts\.pine\.lib\.corrupt-\d+/);
    expect(localStorage.getItem(keys[0]!)).toBe(CORRUPT);
  });

  it('repeated reads do not accumulate backups; one write leaves exactly one', () => {
    localStorage.setItem(LIB_KEY, CORRUPT);
    for (let i = 0; i < 5; i++) {
      pineLibGet('nope');
      pineLibList();
    }
    pineLibCreate('New', 'src');
    pineLibCreate('New 2', 'src2');
    pineLibSave(pineLibList()[0]!.id, 'src3');
    expect(backupValues()).toEqual([CORRUPT]);
  });

  it('a second, DIFFERENT corrupt doc gets its own backup instead of clobbering the first', () => {
    const second = '{"version":9,"scripts":[]}';
    localStorage.setItem(LIB_KEY, CORRUPT);
    pineLibCreate('New', 'src');
    localStorage.setItem(LIB_KEY, second);
    pineLibCreate('New 2', 'src2');
    expect(backupValues().sort()).toEqual([CORRUPT, second].sort());
  });

  it('identical corrupt content is backed up once across repeated overwrites', () => {
    for (let i = 0; i < 3; i++) {
      localStorage.setItem(LIB_KEY, CORRUPT);
      pineLibCreate('s' + i, 'src');
    }
    expect(backupValues()).toEqual([CORRUPT]);
  });

  it('caps backups at 3 and never evicts the oldest original', () => {
    const contents = ['c1-oldest', 'c2', 'c3', 'c4-newest'];
    for (const c of contents) {
      localStorage.setItem(LIB_KEY, c);
      pineLibCreate('s' + c, 'src');
    }
    const kept = backupValues();
    expect(kept).toHaveLength(3);
    // the first original survives; the second-oldest is the one retired
    expect(kept).toContain('c1-oldest');
    expect(kept).not.toContain('c2');
    expect(kept).toEqual(expect.arrayContaining(['c3', 'c4-newest']));
  });

  it('an empty (or whitespace-only) stored doc is "no data", not corruption', () => {
    localStorage.setItem(LIB_KEY, '');
    pineLibCreate('New', 'src');
    expect(backupKeys()).toEqual([]);
    localStorage.setItem(LIB_KEY, '   \n');
    pineLibCreate('New 2', 'src2');
    expect(backupKeys()).toEqual([]);
  });

  it('a blocked getItem does not throw out of the write and flags the failure', () => {
    localStorage.setItem(LIB_KEY, CORRUPT);
    const orig = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      if (k === LIB_KEY) throw new DOMException('denied', 'SecurityError');
      return orig.call(this, k);
    });
    expect(() => pineLibCreate('New', 'src')).not.toThrow();
    expect(pineLibWriteFailed()).toBe(true);
    // read LIB_KEY through the unspied origin — the spy is what makes it throw
    expect(orig.call(localStorage, LIB_KEY)).toBe(CORRUPT);
  });

  it('a failed backup leaves LIB_KEY untouched and flags the write failure', () => {
    localStorage.setItem(LIB_KEY, CORRUPT);
    const orig = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith(CORRUPT_KEY)) throw new DOMException('quota', 'QuotaExceededError');
      return orig.call(this, k, v);
    });
    pineLibCreate('New', 'src');
    expect(localStorage.getItem(LIB_KEY)).toBe(CORRUPT);
    expect(backupKeys()).toEqual([]);
    expect(pineLibWriteFailed()).toBe(true);
  });

  it('valid documents are written without a backup', () => {
    pineLibCreate('A', 'x');
    pineLibSave(pineLibList()[0]!.id, 'y');
    expect(localStorage.getItem(CORRUPT_KEY)).toBeNull();
    expect(pineLibWriteFailed()).toBe(false);
  });
});
