/**
 * Pop-out reconnect after the main window reloads (F5). The editor module, loaded
 * fresh, re-attaches only when this tab owns a pop-out (sessionStorage flag set by
 * openEditor), and then pings it; a pop-out's `hello` gets the buffer back.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';

const CH = 'opencharts.pine.win';
const OWNER_KEY = 'opencharts.pine.popOwner';

// Each test loads a fresh module copy, but the previous copies' channels stay
// open and would answer too. Record every channel and close them per test.
const opened: BroadcastChannel[] = [];
const NativeChannel = globalThis.BroadcastChannel;
beforeAll(() => {
  globalThis.BroadcastChannel = class extends NativeChannel {
    constructor(name: string) { super(name); opened.push(this); }
  } as typeof BroadcastChannel;
});
afterEach(() => { for (const c of opened.splice(0)) c.close(); });
afterAll(() => { globalThis.BroadcastChannel = NativeChannel; });

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

  // Every tab on the channel sees an adopt; only the one that just pinged may
  // take it, or another tab's script id / handle would be overwritten.
  it('owner tab: takes the adopt that answers its ping, ignores a late one', async () => {
    const { seen, popout } = await loadAndListen(true);
    try {
      popout.postMessage({ t: 'adopt', v: 'x = 1' });
      await new Promise((r) => setTimeout(r, 30));
      expect(seen.filter((m) => m.t === 'meta')).toHaveLength(1);
      popout.postMessage({ t: 'adopt', v: 'x = 2' });
      await new Promise((r) => setTimeout(r, 30));
      expect(seen.filter((m) => m.t === 'meta')).toHaveLength(1);
    } finally { popout.close(); }
  });

  it('owner tab: an adopt after the ping window is ignored', async () => {
    const { seen, popout } = await loadAndListen(true);
    try {
      await new Promise((r) => setTimeout(r, 2100));
      popout.postMessage({ t: 'adopt', v: 'x = 1' });
      await new Promise((r) => setTimeout(r, 30));
      expect(seen.some((m) => m.t === 'meta')).toBe(false);
    } finally { popout.close(); }
  }, 8000);

  // A popout reload sends bye then hello. A tab whose popout is gone for good
  // must stop re-attaching, or another tab's popout runs every cmd twice.
  it('bye clears the owner flag; hello restores it only for the tab holding the popout', async () => {
    const { popout } = await loadAndListen(true);
    try {
      popout.postMessage({ t: 'bye' });
      await new Promise((r) => setTimeout(r, 30));
      expect(sessionStorage.getItem(OWNER_KEY)).toBeNull();
      popout.postMessage({ t: 'hello' });
      await new Promise((r) => setTimeout(r, 30));
      expect(sessionStorage.getItem(OWNER_KEY)).toBeNull();
    } finally { popout.close(); }

    const again = await loadAndListen(true);
    try {
      again.popout.postMessage({ t: 'adopt', v: 'x = 1' });
      await new Promise((r) => setTimeout(r, 30));
      again.popout.postMessage({ t: 'bye' });
      await new Promise((r) => setTimeout(r, 30));
      again.popout.postMessage({ t: 'hello' });
      await new Promise((r) => setTimeout(r, 30));
      expect(sessionStorage.getItem(OWNER_KEY)).toBe('1');
    } finally { again.popout.close(); }
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
