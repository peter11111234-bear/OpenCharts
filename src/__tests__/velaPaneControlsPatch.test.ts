import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards patches/@luxalgo+vela+0.8.4.patch (L4): PaneControls.refresh() used to
// tear down and rebuild every pane's buttons on each call — 3 calls per
// indicator mount, all in one frame on a workspace restore. The patch rebuilds
// a pane's cluster only when the state its buttons encode changed. The class
// is not exported, so this slices it out of the INSTALLED dist chunk; a
// failure here after `npm install` means the patch did not apply.
const require = createRequire(import.meta.url);
const distDir = dirname(require.resolve('@luxalgo/vela'));
const chunk = readFileSync(join(distDir, 'chunk-UNUVPQFW.js'), 'utf8');
const start = chunk.indexOf('var PaneControls = class {');
const end = chunk.indexOf('// src/renderers/native/chrome/axisLayout.ts');
const PaneControls = new Function(
  'ICONS', 'CLUSTER_PILL', 'ensureStyles2',
  `${chunk.slice(start, end)}\nreturn PaneControls;`,
)({ up: '<i></i>', down: '<i></i>', collapse: '<i></i>', expand: '<i></i>', maximize: '<i></i>', restore: '<i></i>' }, '#000', () => {}) as new (
  plot: HTMLElement, theme: unknown, deps: unknown,
) => { refresh(): void; destroy(): void };

interface Pane { id: string; kind: string; index: number; count: number; collapsed: boolean; maximized: boolean; top: number; height: number }

const mk = () => {
  const plot = document.createElement('div');
  document.body.appendChild(plot);
  const panes: Pane[] = [
    { id: 'price', kind: 'price', index: 0, count: 2, collapsed: false, maximized: false, top: 0, height: 300 },
    { id: 'rsi', kind: 'study', index: 1, count: 2, collapsed: false, maximized: false, top: 300, height: 100 },
  ];
  const pc = new PaneControls(plot, {}, {
    panes: () => panes, rightAxis: () => 64,
    onMove: () => {}, onToggleCollapse: () => {}, onToggleMaximize: () => {},
  });
  const buttons = () => [...plot.querySelectorAll('button')];
  return { pc, panes, buttons };
};

describe('vela PaneControls patch (L4)', () => {
  it('found the class in the installed dist', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it('a refresh with unchanged panes keeps the existing buttons', () => {
    const { pc, buttons } = mk();
    const before = buttons();
    expect(before.length).toBe(5); // price: maximize; study: up/down/collapse/maximize
    pc.refresh();
    pc.refresh();
    const after = buttons();
    expect(after).toHaveLength(before.length);
    after.forEach((b, i) => expect(b).toBe(before[i]));
    pc.destroy();
  });

  it('a state change rebuilds that pane only', () => {
    const { pc, panes, buttons } = mk();
    const priceBtn = buttons()[0];
    panes[1]!.collapsed = true;
    pc.refresh();
    expect(buttons()[0]).toBe(priceBtn);
    expect(buttons().some((b) => b.title === 'Expand pane')).toBe(true);
    pc.destroy();
  });

  it('modelToValuePatch passes series arrays through without scanning them (T4)', () => {
    // Same patch file: the dirty range it computed (a pass over every point of
    // every series per update) had no reader. A points array that throws on
    // iteration proves the pass is gone; the arrays must still go through by
    // reference.
    const fnStart = chunk.indexOf('function modelToValuePatch(model) {');
    const fnEnd = chunk.indexOf('\n}\n', fnStart) + 2;
    expect(fnStart).toBeGreaterThan(0);
    const modelToValuePatch = new Function('isLineLikeSeries', `${chunk.slice(fnStart, fnEnd)}\nreturn modelToValuePatch;`)(
      (s: { kind: string }) => s.kind === 'line',
    ) as (m: unknown) => { dirty: unknown; series: { points?: unknown; bars?: unknown }[] };
    const untouchable = new Proxy([{ time: 1, value: 1 }], {
      get(t, k, r) {
        if (k === Symbol.iterator) throw new Error('points were scanned');
        return Reflect.get(t, k, r);
      },
    });
    const bars = [{ time: 1, open: 1, high: 1, low: 1, close: 1 }];
    const out = modelToValuePatch({
      id: 'm', series: [{ id: 'a', kind: 'line', points: untouchable }, { id: 'b', kind: 'candle', bars }],
    });
    expect(out.series[0]!.points).toBe(untouchable);
    expect(out.series[1]!.bars).toBe(bars);
    expect(out.dirty).toEqual({ from: 0, to: 0 });
  });

  it('adding a pane updates index/count-dependent buttons', () => {
    const { pc, panes, buttons } = mk();
    panes.forEach((p) => { p.count = 3; });
    panes.push({ id: 'macd', kind: 'study', index: 2, count: 3, collapsed: false, maximized: false, top: 400, height: 100 });
    pc.refresh();
    const down = buttons().filter((b) => b.dataset.role === 'down');
    expect(down.map((b) => b.disabled)).toEqual([false, true]);
    pc.destroy();
  });
});
