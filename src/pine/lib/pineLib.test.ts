import { describe, it, expect, beforeEach } from 'vitest';
import {
  pineLibList, pineLibGet, pineLibCreate, pineLibSave, pineLibRename,
  pineLibDuplicate, pineLibRemove, pineLibRecentPush, pineLibRecent,
  pineLibMigrateLegacyHist,
} from './pineLib.ts';

beforeEach(() => localStorage.clear());

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
