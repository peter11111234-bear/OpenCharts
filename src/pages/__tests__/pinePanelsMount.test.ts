/**
 * The workspace mounts contributed side panels while it is still being built,
 * before any cell is active — the WidgetContext chart getter throws then. A
 * panel whose mount throws is still docked, but with no handle, so it never
 * receives the onChart that follows (VELA's dock swallows the error). The
 * Pine Editor panel must survive a chart-less mount and fill in on onChart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sidePanels, widgetAttachments, type SidePanelHandle } from '@luxalgo/vela/plugin';
import '../velaPineEditor.ts';

type AnyChart = Record<string, unknown>;

const panel = (id: string) => {
  const p = sidePanels().find((d) => d.id === id);
  if (!p) throw new Error(`side panel ${id} not registered`);
  return p;
};

const fakeChart = (titles: string[]): AnyChart => ({
  indicators: () => titles.map((title, i) => ({ id: `ind-${i}`, title, visible: true, source: `//@version=6\nindicator("${title}")` })),
  drawings: { all: () => [] },
  on: () => () => {},
  renderer: { supportsIndicatorSettings: false },
});

const header = () => ({ slot: document.createElement('div'), setTitle: () => {}, maximized: false, setMaximized: () => {} }) as never;

let handles: (SidePanelHandle | void)[] = [];
let bodies: HTMLElement[] = [];
const mk = () => { const b = document.createElement('div'); document.body.appendChild(b); bodies.push(b); return b; };

afterEach(() => {
  for (const h of handles) h?.destroy?.();
  for (const b of bodies) b.remove();
  handles = []; bodies = [];
});

describe('side panels mounted before the workspace has an active cell', () => {
  it('the duplicate 物件樹 panel is gone — VELA ships its own Object tree', () => {
    expect(sidePanels().some((d) => d.id === 'opencharts.objtree')).toBe(false);
  });

  it('Pine Editor: mount does not throw, then lists on-chart scripts once onChart arrives', () => {
    const body = mk();
    let chart: AnyChart | null = null;
    const ctx = {
      host: document.body,
      get chart() { if (!chart) throw new Error('VelaWorkspace has no active cell yet'); return chart; },
      togglePanel: () => {},
    } as never;
    const h = panel('opencharts.pine').mount(ctx, body, header());
    handles.push(h);
    expect(h?.onChart).toBeTypeOf('function');
    // The cell appears; the dock forwards it. The editor re-reads through ctx.
    chart = fakeChart(['My Script']);
    h!.onChart!(chart as never);
    expect(body.textContent).toContain('On-chart indicators (1)');
  });
});

describe("the dock's Pine Editor icon", () => {
  it('opens the standalone window instead of the narrow side column', () => {
    const host = mk();
    const dockBtn = (id: string) => {
      const b = document.createElement('button');
      b.className = `vela-widget-tool vela-widget-panel-${id}`;
      host.appendChild(b);
      const dockToggle = vi.fn();
      b.addEventListener('click', dockToggle);
      return { b, dockToggle };
    };
    const pine = dockBtn('opencharts.pine');
    const other = dockBtn('opencharts.ai-assistant');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const att = widgetAttachments().find((a) => a.id === 'opencharts.pine-dock-window');
    if (!att) throw new Error('attachment not registered');
    const dispose = att.mount({ host, chart: {}, togglePanel: vi.fn() } as never);
    try {
      pine.b.click();
      expect(open).toHaveBeenCalledWith('/pine-editor.html', 'opencharts.pine', expect.any(String));
      expect(pine.dockToggle).not.toHaveBeenCalled();
      other.b.click();
      expect(other.dockToggle).toHaveBeenCalledOnce();
    } finally {
      dispose?.();
      open.mockRestore();
    }
  });
});
