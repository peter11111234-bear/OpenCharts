/**
 * Regression tests for the Pine editor's Run/Save status reporting.
 *
 * Both bugs are the same class: the UI printed success while the underlying
 * call (updateCode / localStorage write) had failed. The pop-out window talks
 * to this module over BroadcastChannel, so the tests drive that protocol and
 * read back the "status" messages the module posts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pineLibCreate } from '../../pine/lib/pineLib.ts';
import { openPineEditorWithScript } from '../velaPineEditor.ts';

const CH = 'opencharts.pine.win';

type Status = { v: string; kind: string };

function channelHarness() {
  const sender = new BroadcastChannel(CH);
  const listener = new BroadcastChannel(CH);
  const statuses: Status[] = [];
  listener.onmessage = (e) => {
    const m = e.data as { t?: string; v?: string; kind?: string };
    if (m.t === 'status') statuses.push({ v: String(m.v), kind: String(m.kind) });
  };
  const waitFor = async (pred: () => boolean, ms = 2000) => {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  };
  const close = () => { sender.close(); listener.close(); };
  return { send: (m: Record<string, unknown>) => sender.postMessage(m), statuses, waitFor, close };
}

function mkChart(opts: {
  updateResult?: () => Promise<{ ok: boolean; error: Error | null }>;
} = {}) {
  const handle = {
    id: 'h1', title: 'T', source: 'x', visible: true, inputs: [], inputValues: () => ({}),
    updateCode: vi.fn(opts.updateResult ?? (async () => ({ ok: true, error: null }))),
  };
  const list: unknown[] = [];
  const chart = {
    indicators: () => list,
    runIndicator: vi.fn(async () => {
      list.push(handle);
      return { ok: true, handle, error: null, context: null };
    }),
  };
  return { chart, handle };
}

function mkCtx(chart: unknown) {
  return {
    chart,
    host: document.createElement('div'),
    togglePanel: vi.fn(),
    toast: vi.fn(),
  } as never;
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, 'open').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BUG 1: Run must not report success when updateCode fails', () => {
  it('in-place update failure shows an err status carrying the error text', async () => {
    const s = pineLibCreate('S', '//@version=6\nindicator("S")');
    const { chart, handle } = mkChart({
      updateResult: async () => ({ ok: false, error: new Error('syntax boom') }),
    });
    openPineEditorWithScript(mkCtx(chart), s.id);
    const h = channelHarness();
    try {
      h.send({ t: 'value', v: '//@version=6\nindicator("S") broken((' });
      h.send({ t: 'cmd', c: 'run' }); // 1st run: adds the indicator, records handleId
      await h.waitFor(() => h.statuses.some((x) => x.v === 'Added'), 2000);
      h.send({ t: 'cmd', c: 'run' }); // 2nd run: takes the updateCode path
      await h.waitFor(() => handle.updateCode.mock.calls.length > 0, 2000);
      await h.waitFor(() => h.statuses.some((x) => x.kind === 'err'), 2000);
      const last = h.statuses.at(-1);
      expect(handle.updateCode).toHaveBeenCalled();
      expect(last?.kind).toBe('err');
      expect(last?.v).toContain('syntax boom');
      expect(last?.v).not.toBe('Updated in place');
    } finally { h.close(); }
  });

  it('a successful in-place update still reports "Updated in place"', async () => {
    const s = pineLibCreate('S', '//@version=6\nindicator("S")');
    const { chart, handle } = mkChart();
    openPineEditorWithScript(mkCtx(chart), s.id);
    const h = channelHarness();
    try {
      h.send({ t: 'value', v: '//@version=6\nindicator("S") // v2' });
      h.send({ t: 'cmd', c: 'run' });
      await h.waitFor(() => h.statuses.some((x) => x.v === 'Added'), 2000);
      h.send({ t: 'cmd', c: 'run' });
      await h.waitFor(() => h.statuses.some((x) => x.v === 'Updated in place'), 2000);
      const last = h.statuses.at(-1);
      expect(handle.updateCode).toHaveBeenCalled();
      expect(last?.v).toBe('Updated in place');
      expect(last?.kind).toBe('ok');
    } finally { h.close(); }
  });
});

describe('BUG 3: saving an existing script must report a storage failure', () => {
  it('popSave (existing id) reports err, not "Saved", when the write throws', async () => {
    const s = pineLibCreate('Existing', 'old');
    const { chart } = mkChart();
    openPineEditorWithScript(mkCtx(chart), s.id);
    const h = channelHarness();
    try {
      h.send({ t: 'value', v: 'changed-body' });
      await new Promise((r) => setTimeout(r, 30));
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
      h.send({ t: 'cmd', c: 'save' });
      await h.waitFor(
        () => h.statuses.some((x) => x.v.startsWith('Saved')) || h.statuses.some((x) => x.kind === 'err'),
        2000,
      );
      const last = h.statuses.at(-1);
      expect(last?.kind).toBe('err');
      expect(last?.v.startsWith('Saved')).toBe(false);
    } finally { h.close(); }
  });
});
