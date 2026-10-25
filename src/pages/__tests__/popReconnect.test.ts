/**
 * Pop-out reconnect after the main window reloads (F5). The editor module, loaded
 * fresh, re-attaches only when this tab owns a pop-out (sessionStorage flag set by
 * openEditor), and then pings it; a pop-out's `hello` gets the buffer back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const CH = 'opencharts.pine.win';
const OWNER_KEY = 'opencharts.pine.popOwner';

/** Load a fresh copy of the editor module and collect what it posts on the channel. */
async function loadAndListen(owner: boolean) {
  vi.resetModules();
  sessionStorage.clear();
  if (owner) sessionStorage.setItem(OWNER_KEY, '1');
  const seen: { t: string; v?: string }[] = [];
  const popout = new BroadcastChannel(CH);
  popout.onmessage = (e) => { seen.push(e.data as { t: string; v?: string }); };
  await import('../velaPineEditor.ts');
  await new Promise((r) => setTimeout(r, 30));
  return { seen, popout };
}

beforeEach(() => {
  localStorage.clear();
});

describe('pop-out reconnect after a main-window reload', () => {
  it('owner tab: a freshly loaded editor pings the pop-out', async () => {
    const { seen, popout } = await loadAndListen(true);
    try {
      expect(seen.map((m) => m.t)).toContain('ping');
    } finally { popout.close(); }
  });

  it('non-owner tab: no ping, so other /vela tabs stay silent', async () => {
    const { seen, popout } = await loadAndListen(false);
    try {
      expect(seen.map((m) => m.t)).not.toContain('ping');
    } finally { popout.close(); }
  });

  it('owner tab: a pop-out hello gets the buffer back as a value message', async () => {
    const { seen, popout } = await loadAndListen(true);
    try {
      popout.postMessage({ t: 'hello' });
      await new Promise((r) => setTimeout(r, 30));
      expect(seen.some((m) => m.t === 'value')).toBe(true);
    } finally { popout.close(); }
  });
});
