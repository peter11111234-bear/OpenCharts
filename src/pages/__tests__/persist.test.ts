import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  serializeCellScripts,
  restoreCellScripts,
  bindVelaWorkspace,
  unbindVelaWorkspace,
} from '../velaPineEditor.ts';
import type { CellStateContext } from '@luxalgo/vela/plugin';
import type { IndicatorHandle } from '@luxalgo/vela';

// ── Helpers ──────────────────────────────────────────────────────────────
// Minimal mock surface matching what serialize/restore actually read.

function mkHandle(over: Partial<IndicatorHandle> & { id: string; source?: string }): IndicatorHandle {
  const { id, ...rest } = over;
  return {
    id,
    title: over.title ?? 'Indicator',
    source: over.source,
    visible: over.visible ?? true,
    setVisible: vi.fn(),
    remove: vi.fn(),
    inputValues: vi.fn(() => over.inputValues?.() ?? {}),
    inputs: (over.inputs as IndicatorHandle['inputs']) ?? [],
    ...rest,
  } as IndicatorHandle;
}

function mkCtx(opts: {
  cellId?: string;
  handles?: IndicatorHandle[];
  addIndicator?: ReturnType<typeof vi.fn>;
}): CellStateContext {
  const handles = opts.handles ?? [];
  return {
    cellId: opts.cellId ?? 'c1',
    host: {} as HTMLElement,
    toast: vi.fn(),
    chart: {
      indicators: () => handles,
    } as unknown as CellStateContext['chart'],
    addIndicator: opts.addIndicator ?? vi.fn(),
    addNativeIndicator: vi.fn(),
  } as unknown as CellStateContext;
}

function mkWs(cells: Record<string, { id: string; external?: boolean; handle?: { id: string } | null }[]>): Parameters<typeof bindVelaWorkspace>[0] {
  return {
    cell: (id: string) => ({ instances: cells[id] }),
  } as unknown as Parameters<typeof bindVelaWorkspace>[0];
}

beforeEach(() => {
  // Deterministically clear module state: bind a dummy ws (bind clears
  // pendingAdds + inFlightAdds unconditionally), then unbind it.
  const ws = mkWs({});
  bindVelaWorkspace(ws);
  unbindVelaWorkspace(ws);
});

// ── serializeCellScripts ────────────────────────────────────────────────

describe('serializeCellScripts', () => {
  it('stamps origin=external on every serialized entry', () => {
    const h = mkHandle({ id: 'ind-1', source: 'indicator("X")\nplot(close)' });
    const ctx = mkCtx({ cellId: 'c1', handles: [h] });
    // no ws bound → isExternal treats !inst as external
    const out = serializeCellScripts(ctx);
    expect(out).toHaveLength(1);
    expect(out![0]!.origin).toBe('external');
  });

  it('excludes ledger-owned (instance.external undefined) handles', () => {
    const h1 = mkHandle({ id: 'ind-1', source: 'indicator("LEDGER")\nplot(close)' });
    const h2 = mkHandle({ id: 'ind-2', source: 'indicator("EXT")\nplot(close)' });
    const ws = mkWs({ c1: [
      { id: 'ind-1' },                    // ledger-owned
      { id: 'ind-2', external: true },    // user external
    ] });
    bindVelaWorkspace(ws);
    const out = serializeCellScripts(mkCtx({ cellId: 'c1', handles: [h1, h2] }));
    expect(out).toHaveLength(1);
    expect(out![0]!.id).toBe('ind-2');
    unbindVelaWorkspace(ws);
  });
});

// ── restoreCellScripts ──────────────────────────────────────────────────

describe('restoreCellScripts', () => {
  it('origin:"external" bypasses the manifest-text skip', async () => {
    // Use a REAL bundled manifest entry so ledgerScripts.has(normScript) is true.
    // The same script text restores differently by origin:
    //   no origin → skipped (ledger dedup); origin:'external' → re-added.
    const { combinedManifestEntries } = await import('../../pineScripts.ts');
    const manifestSrc = combinedManifestEntries()[0]?.script;
    expect(manifestSrc).toBeTruthy();
    const add1 = vi.fn(), add2 = vi.fn();
    restoreCellScripts(
      [{ name: 'X', script: manifestSrc }],
      mkCtx({ cellId: 'c1', addIndicator: add1 }),
    );
    restoreCellScripts(
      [{ name: 'X', script: manifestSrc, origin: 'external' }],
      mkCtx({ cellId: 'c2', addIndicator: add2 }),
    );
    expect(add1).not.toHaveBeenCalled();  // no origin → manifest skip holds
    expect(add2).toHaveBeenCalled();      // origin:'external' → bypasses skip
  });

  it('double-restore: second call with in-flight add is skipped', () => {
    const src = 'indicator("DUP")\nplot(close)';
    const addIndicator = vi.fn();
    const ctx = mkCtx({ cellId: 'c1', handles: [], addIndicator });
    const payload = [{ name: 'D', script: src, id: 'ind-dup' }];
    restoreCellScripts(payload, ctx);  // first restore — addIndicator + inFlightAdds
    restoreCellScripts(payload, ctx);  // second restore, handles still not landed
    // inFlightAdds must block the second call (handle doesn't exist yet,
    // e.id live-check misses, claimed set is per-call fresh).
    expect(addIndicator).toHaveBeenCalledTimes(1);
  });

  it('double-restore claim is per-cellId', () => {
    const src = 'indicator("CELL2")\nplot(close)';
    const add1 = vi.fn(), add2 = vi.fn();
    restoreCellScripts([{ name: 'X', script: src }], mkCtx({ cellId: 'c1', addIndicator: add1 }));
    restoreCellScripts([{ name: 'X', script: src }], mkCtx({ cellId: 'c2', addIndicator: add2 }));
    // Different cellId → different inFlightKey → both go through.
    expect(add1).toHaveBeenCalledTimes(1);
    expect(add2).toHaveBeenCalledTimes(1);
  });

  it('old blob (no origin) on a manifest-matching script still skips', async () => {
    // Old blobs lack origin — they keep the legacy ledgerScripts dedup path.
    // Use a script that IS in the real bundled manifest (src/pine/*.pine glob):
    // ledgerScripts.has matches → restore skips (old-blob behaviour preserved).
    const { combinedManifestEntries } = await import('../../pineScripts.ts');
    const manifestSrc = combinedManifestEntries()[0]?.script;
    expect(manifestSrc).toBeTruthy();
    const addIndicator = vi.fn();
    const ctx = mkCtx({ cellId: 'c1', handles: [], addIndicator });
    restoreCellScripts([{ name: 'X', script: manifestSrc }], ctx);
    expect(addIndicator).not.toHaveBeenCalled();
  });

  it('N identical entries in ONE payload all get added', () => {
    // Serialize supports N identical external copies (per-handle consumed set);
    // restore must not collapse them — claims land after the loop.
    const src = 'indicator("TWINS")\nplot(close)';
    const addIndicator = vi.fn();
    const ctx = mkCtx({ cellId: 'c1', handles: [], addIndicator });
    restoreCellScripts(
      [{ name: 'T1', script: src }, { name: 'T2', script: src }],
      ctx,
    );
    expect(addIndicator).toHaveBeenCalledTimes(2);
  });

  it('claim released when pending entry expires → re-restore re-adds', () => {
    const src = 'indicator("EXPIRE")\nplot(close)';
    const add1 = vi.fn(), add2 = vi.fn();
    const ctx = mkCtx({ cellId: 'c1', handles: [], addIndicator: add1 });
    restoreCellScripts([{ name: 'E', script: src }], ctx);
    // Force expiry: mock performance.now past PENDING_MS, serialize sweeps the
    // pending entry AND releases its claim.
    const realNow = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockReturnValue(realNow() + 31_000);
    serializeCellScripts(ctx);
    vi.restoreAllMocks();
    // Second restore after expiry must go through — claim was released.
    restoreCellScripts([{ name: 'E', script: src }], mkCtx({ cellId: 'c1', handles: [], addIndicator: add2 }));
    expect(add2).toHaveBeenCalledTimes(1);
  });

  it('origin:"external" entry is NOT claimed by a ledger-owned live handle', () => {
    // Ledger converged first: a ledger-owned handle with identical source+inputs
    // is live. The origin:'external' entry is the user's separate add — a ledger
    // handle claiming it silently drops the add.
    const src = 'indicator("LG")\nplot(close)';
    const ledger = mkHandle({ id: 'ind-ledger', source: src });
    // ws marks ind-ledger NOT external → ledger-owned.
    const ws = mkWs({ c1: [{ id: 'ind-ledger' }] });
    bindVelaWorkspace(ws);
    const addIndicator = vi.fn();
    const ctx = mkCtx({ cellId: 'c1', handles: [ledger], addIndicator });
    restoreCellScripts([{ name: 'LG-copy', script: src, origin: 'external' }], ctx);
    unbindVelaWorkspace(ws);
    expect(addIndicator).toHaveBeenCalledTimes(1);
  });

  it('legacy no-origin entry IS claimed by a ledger-owned live handle', () => {
    // Contrast: without origin, a matching live handle claims the entry
    // (dedup of legacy polluted blobs) — pool is ALL preexisting handles.
    const src = 'indicator("LG2")\nplot(close)';
    const ledger = mkHandle({ id: 'ind-l2', source: src });
    const ws = mkWs({ c1: [{ id: 'ind-l2' }] });
    bindVelaWorkspace(ws);
    const addIndicator = vi.fn();
    const ctx = mkCtx({ cellId: 'c1', handles: [ledger], addIndicator });
    restoreCellScripts([{ name: 'LG2', script: src }], ctx);
    unbindVelaWorkspace(ws);
    expect(addIndicator).not.toHaveBeenCalled();
  });
});
