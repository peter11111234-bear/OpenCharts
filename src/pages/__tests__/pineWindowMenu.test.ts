/**
 * Popout Pine editor script menu (pine-editor.html + pineEditorWindow.ts):
 * search across the whole library, current-script marker, capped lists,
 * keyboard close, and every row still sending its `cmd` to the main window.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CH = 'opencharts.pine.win';
const scripts = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, name: i === 3 ? 'RSI Divergence' : `Script ${i}` }));
const now = Date.now();
const meta = {
  t: 'meta', name: 'RSI Divergence', id: 's3', hasId: true, dirty: false,
  recent: [scripts[3]!, scripts[7]!],
  all: scripts,
  versions: Array.from({ length: 7 }, (_, k) => ({ i: 6 - k, t: now - (k + 1) * 3_600_000 })),
};

let peer: BroadcastChannel;
const sent: Record<string, unknown>[] = [];
const tick = () => new Promise((r) => setTimeout(r, 20));
const menu = () => document.getElementById('menu')!;
const rows = () => [...menu().querySelectorAll<HTMLButtonElement>('.m-row')];
const rowText = (b: HTMLElement) => b.querySelector('.m-label')?.textContent ?? b.textContent;
const openMenu = () => { if (!menu().classList.contains('open')) document.getElementById('name')!.click(); };

beforeAll(async () => {
  const html = readFileSync(resolve(__dirname, '../../../pine-editor.html'), 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');
  peer = new BroadcastChannel(CH);
  peer.onmessage = (e) => { sent.push(e.data as Record<string, unknown>); };
  // @ts-expect-error -- a page script with no exports, loaded for its side effects
  await import('../pineEditorWindow.ts');
  peer.postMessage(meta);
  await tick();
});
afterAll(() => peer.close());

describe('popout script menu', () => {
  it('opens with the search field focused and marks the current script', () => {
    openMenu();
    expect(menu().classList.contains('open')).toBe(true);
    expect(document.activeElement).toBe(menu().querySelector('input'));
    const current = rows().filter((b) => b.classList.contains('current'));
    expect(current.map(rowText)).toEqual(['RSI Divergence']);
  });

  it('caps the library and versions, and expands versions in place', () => {
    const lib = rows().filter((b) => /^Script \d+$/.test(rowText(b) ?? ''));
    expect(lib.length).toBe(11); // 1 recent + 10 library rows
    expect(menu().textContent).toContain('+3 more');
    const versionRows = () => rows().filter((b) => /^v\d+$/.test(rowText(b) ?? ''));
    expect(versionRows().length).toBe(5);
    rows().find((b) => b.textContent === 'Show all 7 versions')!.click();
    expect(menu().classList.contains('open')).toBe(true);
    expect(versionRows().length).toBe(7);
  });

  it('searches the whole library, and Enter opens the first hit', async () => {
    const input = menu().querySelector('input')!;
    input.value = 'script 14';
    input.dispatchEvent(new Event('input'));
    expect(rows().map(rowText)).toEqual(['Script 14']);
    sent.length = 0;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(menu().classList.contains('open')).toBe(false);
    expect(sent.find((m) => m.t === 'cmd')).toMatchObject({ c: 'open', id: 's14' });
  });

  it('shows an empty state when nothing matches', () => {
    openMenu();
    const input = menu().querySelector('input')!;
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    expect(rows().length).toBe(0);
    expect(menu().textContent).toContain('No script matches "zzz"');
  });

  it('Escape closes the menu and returns focus to the editor', () => {
    menu().querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu().classList.contains('open')).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('ed'));
  });

  it('a press on the name label does not close-then-reopen the menu', () => {
    openMenu();
    const label = document.getElementById('nameLabel')!;
    label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu().classList.contains('open')).toBe(true);
    label.click();
    expect(menu().classList.contains('open')).toBe(false);
  });

  it('Create new chips still send the new command', async () => {
    openMenu();
    sent.length = 0;
    [...menu().querySelectorAll<HTMLButtonElement>('.m-chip')].find((c) => c.textContent === 'Strategy')!.click();
    await tick();
    expect(sent.find((m) => m.t === 'cmd')).toMatchObject({ c: 'new', k: 'strategy' });
  });
});
