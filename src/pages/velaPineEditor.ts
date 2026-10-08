/**
 * Pine script editor for the Vela workspace.
 *
 * Vela ships no script-editing UI — this registers a topbar contributed action
 * ("Pine", pen icon, right cluster) that opens a modal with:
 *   - a dropdown of bundled src/pine/*.pine scripts (load into the editor)
 *   - a textarea to paste/edit any TradingView-style script
 *   - Run → ctx.chart.runIndicator(source) on the ACTIVE cell, or Add →
 *     ctx.addIndicator so the run enters the workspace undo/redo timeline.
 *
 * Registered at module scope (the workspace resolves contributed actions at
 * construction — "register at import time" per the SDK docs).
 */
// All contribution APIs must come from `@luxalgo/vela/plugin` — Vite resolves
// the bare `@luxalgo/vela` root and `/ui` subpath into SEPARATE module instances,
// so the contribution registry Map is duplicated. Registering on the root while
// the workspace reads the plugin instance → callouts/actions never render.
import {
  registerWidgetAction,
  registerStatePersistence,
  registerLegendAction,
  registerIcon,
  type CellStateContext,
  type WidgetContext,
} from "@luxalgo/vela/plugin";
// `svg16` is a pure helper (builds markup), but it lives only in /ui — the
// registry itself is chunk-BZQM2XO7.js, shared via plugin's re-export.
import { svg16 } from "@luxalgo/vela/ui";
import {
  pineLibCreate, pineLibGet, pineLibList, pineLibSave, pineLibRename,
  pineLibDuplicate, pineLibRecent, pineLibRecentPush,
  pineLibMigrateLegacyHist, pineLibSubscribe,
} from "../pine/lib/pineLib.ts";
import { openScriptsDialog } from "./velaPineScriptsDialog.ts";
import { combinedManifestEntries } from "../pineScripts.ts";

// ── Modal styles ── the vela-pine-* classes are ours; nothing ships them.
// Without these the overlay renders as a static <div> under #root and pushes
// the h-screen workspace out of view (chart "disappears" when opening Pine).
const PINE_CSS = `
.vela-pine-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}
.vela-pine-dialog{display:flex;flex-direction:column;width:min(900px,92vw);max-height:88vh;background:#1e222d;border:1px solid #363c4e;border-radius:8px;color:#d5d8e0;font:13px/1.4 sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6);overflow:hidden}
.vela-pine-headbar{display:flex;align-items:center;gap:4px;padding:6px 10px;border-bottom:1px solid #2a2e39}
.vela-pine-apptitle{color:#d5d8e0;font-weight:600;font-size:13px;padding:0 8px;white-space:nowrap}
.vela-pine-namebtn{display:flex;align-items:center;gap:6px;background:none;border:0;color:#ddd;padding:4px 8px;font-size:13px;cursor:pointer;border-radius:4px;max-width:260px}
.vela-pine-namebtn:hover{background:#2a2e39}
.vela-pine-namelabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vela-pine-dirty{color:#f0b90b;font-size:9px;visibility:hidden}
.vela-pine-dirty.on{visibility:visible}
.vela-pine-hbtn{background:none;border:0;color:#b2b5be;padding:4px 8px;font-size:13px;cursor:pointer;border-radius:4px;white-space:nowrap}
.vela-pine-hbtn:hover{background:#2a2e39;color:#fff}
.vela-pine-hbtn.primary{color:#2962ff}
.vela-pine-hbtn.primary:hover{color:#4a80ff;background:#2a2e39}
.vela-pine-hbtn:disabled{color:#4a4e5c;cursor:default;background:none}
.vela-pine-spacer{flex:1}
.vela-pine-area{width:100%;flex:1;min-height:320px;max-height:60vh;overflow:auto;resize:none;background:#161a24;color:#d5d8e0;border:0;padding:10px 14px;font:13px/1.55 ui-monospace,Consolas,monospace;white-space:pre;outline:none}
.vela-pine-statusbar{display:flex;align-items:center;gap:14px;padding:5px 12px;border-top:1px solid #2a2e39;color:#787b86;font-size:11px}
.vela-pine-statusbar a{color:#2962ff;text-decoration:none}
.vela-pine-statusbar a:hover{text-decoration:underline}
.vela-pine-msg{flex:1;text-align:center}
.vela-pine-msg[data-kind="ok"]{color:#26a69a}
.vela-pine-msg[data-kind="err"]{color:#ef5350}
.vela-pine-menu{position:fixed;background:#1e222d;border:1px solid #363c4e;border-radius:6px;padding:4px 0;min-width:250px;z-index:10002;box-shadow:0 8px 24px rgba(0,0,0,.5);max-height:70vh;overflow:auto}
.vela-pine-menuitem{display:flex;justify-content:space-between;align-items:center;width:100%;background:none;border:0;color:#ccc;padding:7px 14px;font-size:13px;cursor:pointer;text-align:left;gap:18px}
.vela-pine-menuitem:hover{background:#2a2e39}
.vela-pine-menuitem:disabled{color:#4a4e5c;cursor:default;background:none}
.vela-pine-menukey{color:#787b86;font-size:11px}
.vela-pine-menusep{height:1px;background:#363c4e;margin:4px 0}
.vela-pine-menuhead{color:#787b86;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:8px 14px 3px}
.vela-pine-submenu{position:fixed;background:#1e222d;border:1px solid #363c4e;border-radius:6px;padding:4px 0;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.vela-pine-onchart{border-top:1px solid #2a2e39;padding:8px 12px;max-height:150px;overflow:auto}
.vela-pine-onchart-label{color:#787b86;margin-bottom:6px;font-size:11px}
.vela-pine-onchart-empty{color:#565a68;font-size:11px}
.vela-pine-onchart-item{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px}
.vela-pine-onchart-item:hover{background:#2a2e39}
.vela-pine-onchart-name{flex:1;color:#d5d8e0;cursor:pointer;font-size:12px}
.vela-pine-onchart-name:hover{color:#6aa2ff}
.vela-pine-onchart-del{background:none;border:none;color:#8b8f9c;cursor:pointer;padding:0 4px;font-size:14px;line-height:1}
.vela-pine-scripts{min-height:400px}
.vela-pine-searchwrap{padding:10px 12px;border-bottom:1px solid #2a2e39}
.vela-pine-search{width:100%;background:#161a24;color:#d5d8e0;border:1px solid #363c4e;border-radius:4px;padding:7px 10px;font-size:13px;outline:none}
.vela-pine-search:focus{border-color:#2962ff}
.vela-pine-scriptlist{flex:1;overflow:auto;padding:4px 0}
.vela-pine-scriptrow{display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer}
.vela-pine-scriptrow:hover{background:#2a2e39}
.vela-pine-star{background:none;border:0;color:#4a4e5c;font-size:14px;cursor:pointer;padding:0 2px}
.vela-pine-star.on{color:#f0b90b}
.vela-pine-scriptname{flex:1;color:#d5d8e0;font-size:13px}
.vela-pine-scriptmeta{color:#787b86;font-size:11px}
.vela-pine-scriptmore{background:none;border:0;color:#8b8f9c;font-size:14px;cursor:pointer;padding:0 6px}
.vela-pine-scriptmore:hover{color:#fff}
.vela-pine-onchart-del:hover{color:#ef5350}
`;
{
  const style = document.createElement("style");
  style.dataset.velaPine = "";
  style.textContent = PINE_CSS;
  document.head.appendChild(style);
}

/**
 * Persist user-added Pine scripts. Vela's built-in persist only stores MANIFEST
 * indicators by name — `ctx.addIndicator` adds are flagged `external` and dropped
 * from the saved document ("their plugin's job"). This handler serializes each
 * cell's script indicators into `charts[i].ext` and re-adds them on restore.
 */
type SavedScript = { name: string; script: string; id?: string; hidden?: boolean; inputs?: Record<string, string | number | boolean> };

function serializeCellScripts(ctx: CellStateContext): SavedScript[] | undefined {
  const out: SavedScript[] = [];
  // Manifest indicators (picker adds, incl. "My scripts" library entries) are
  // persisted by vela's own ledger by NAME — serializing them here re-adds a
  // second copy on every restore (the compounding EMA20×N bug). Match on the
  // exact script text; a user-edited copy keeps its own identity and still
  // round-trips through this ext bag.
  const manifestScripts = new Set(combinedManifestEntries().map((e) => e.script));
  for (const handle of ctx.chart.indicators()) {
    if (!handle.source) continue; // native (core) indicator — not ours
    if (manifestScripts.has(handle.source)) continue; // ledger-owned — see above
    const values = handle.inputValues();
    const defaults: Record<string, string | number | boolean> = {};
    for (const s of handle.inputs) defaults[s.key] = s.defval;
    const overrides = Object.fromEntries(
      Object.entries(values).filter(([k, v]) => defaults[k] !== v),
    );
    out.push({
      name: handle.title,
      script: handle.source,
      id: handle.id,
      hidden: !handle.visible,
      inputs: Object.keys(overrides).length > 0 ? overrides : undefined,
    });
  }
  return out.length ? out : undefined;
}

function restoreCellScripts(payload: unknown, ctx: CellStateContext): void {
  if (!Array.isArray(payload)) return;
  // Legacy blobs may still carry manifest-owned entries (the dup bug wrote
  // them in). Skipping them here is the one-shot migration: vela's ledger
  // already re-adds those by name, so nothing user-visible is lost.
  const manifestScripts = new Set(combinedManifestEntries().map((e) => e.script));
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Partial<SavedScript>;
    if (typeof e.name !== "string" || typeof e.script !== "string") continue;
    if (manifestScripts.has(e.script)) continue;
    try {
      ctx.addIndicator({
        name: e.name,
        script: e.script,
        id: e.id,
        language: "pine",
        hidden: e.hidden,
        inputs: e.inputs,
      });
    } catch {
      // engine not ready or duplicate id — skip silently
    }
  }
}

registerStatePersistence({
  key: "opencharts.pine-scripts",
  scope: "cell",
  serialize: serializeCellScripts,
  restore: restoreCellScripts,
});

/**
 * In-process interpreter engine (from-scratch `src/pine/`, `PineInterpreterEngine`).
 * Replaces the PineTS transpiler path (scope/named-arg bugs) — source passes
 * through unchanged; the interpreter handles named args natively. BOM strip
 * lives in the base `prepare`; this alias exists so VelaPage can register it
 * without importing `src/pine/engine.ts` directly.
 */
export { PineInterpreterEngine as InterpreterPineEngine } from '../pine/engine.ts';


// 「Edit」legend action — 把指標的 source 拉回 Pine editor（openEditor 吃
// initial source，textarea 直接載入讓你改）。
registerLegendAction({
  id: "edit-in-pine",
  icon: "edit",
  tooltip: "編輯此指標腳本",
  order: 10,
  when: (ind) => ind.source !== undefined,
  run: (ctx, ind) => {
    openEditor(ctx, ind.source ?? "", ind.id);
  },
});

// 'edit' isn't in the built-in registry — register a pencil so the button isn't blank.
// Horizontal ellipsis for the legend ⋯ bubble — vela's built-in "kebab" is
// vertical (⋮); TV uses horizontal "..." so register our own.
registerIcon("more-h", svg16('<circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/>', 'fill="currentColor" stroke="none"'));
registerIcon("edit", svg16('<path d="M11.5 3.5 12.7 4.7a1 1 0 0 1 0 1.4l-8.2 8.2-2.8.7.7-2.8 8.2-8.2a1 1 0 0 1 1.4 0Z"/>'));
// Legend ⋯ (more) — a legend-row action at the END of the hover controls
// (eye / move / edit / ⋯ / ✕). The callout API renders an always-visible
// bubble instead, which floats OVER the controls — wrong slot. So this is a
// plain LegendAction whose run() deploys a small dropdown panel we manage.
registerLegendAction({
  id: "pine-more",
  icon: "more-h",
  tooltip: "更多",
  order: 999,
  run: (ctx, ind) => toggleMoreMenu(ctx, ind),
});

// ── More-menu dropdown (self-managed; positioned under the clicked ⋯) ──
// Track the last real click so the ⋯ menu can anchor to the clicked button —
// `run` receives no DOM node and activeElement isn't reliable for these.
let lastPointer = { x: 0, y: 0 };
let openMoreMenuEl: HTMLElement | null = null;
document.addEventListener('pointerdown', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);

function closeMoreMenu(): void {
  openMoreMenuEl?.remove();
  openMoreMenuEl = null;
}

function toggleMoreMenu(ctx: WidgetContext, ind: { id: string; title: string; source?: string }): void {
  if (openMoreMenuEl) { closeMoreMenu(); return; }
  const doc = ctx.host.ownerDocument;

  type Item = { label: string; disabled?: boolean; primary?: boolean; sep?: boolean; run?: () => void };
  const isPine = typeof ind.source === 'string' && ind.source.length > 0;
  const items: Item[] = [
    { label: `為 ${ind.title} 新增快訊…`, disabled: true },
    { label: `在 ${ind.title} 上增加指標/策略…`, disabled: true },
    { label: '將此指標增加到整個版面', run: () => {
        const h = ctx.chart.indicators().find(x => x.id === ind.id);
        if (!h?.source) return;
        try { ctx.toast?.(`已複製「${h.title}」到版面指標`, 'info'); } catch { /* no toast */ }
      } },
    { label: favsRead().includes(ind.id) ? '★ 從收藏夾移除' : '☆ 將此指標新增至收藏夾', run: () => toggleIndicatorFav(ind.id) },
    { label: '', sep: true },
    { label: '視覺順序', disabled: true },
    { label: '時間週期的可見性', disabled: true },
    { label: '移動到', disabled: true },
    { label: '固定至刻度', disabled: true },
    { label: '', sep: true },
    isPine
      ? { label: '原始碼…', primary: true, run: () => {
            const match = pineLibList().find(s => s.source === ind.source);
            if (match) openPineEditorWithScript(ctx, match.id);
            else openEditor(ctx, ind.source ?? '', ind.id);
          } }
      : { label: '原始碼（內建指標不可編輯）', disabled: true },
    { label: '', sep: true },
    isPine
      ? { label: '複製', run: () => {
            const p = navigator.clipboard?.writeText(ind.source ?? '');
            if (p) void p.then(() => { try { ctx.toast?.('已複製', 'success'); } catch {} }, () => { try { ctx.toast?.('複製失敗', 'error'); } catch {} });
          } }
      : { label: '複製（內建指標無來源）', disabled: true },
    { label: '隱藏', run: () => { ctx.chart.indicators().find(x => x.id === ind.id)?.setVisible(false); } },
    { label: '移除', run: () => { ctx.chart.indicators().find(x => x.id === ind.id)?.remove(); } },
    { label: '', sep: true },
    { label: '物件樹', disabled: true },
    { label: '', sep: true },
    { label: '設定…', run: () => {
        const renderer = ctx.chart.renderer;
        if (renderer.supportsIndicatorSettings) renderer.openIndicatorSettings(ind.id);
      } },
  ];

  const menu = doc.createElement('div');
  menu.style.cssText =
    'position:fixed;z-index:10001;min-width:220px;padding:4px;background:#1e222d;' +
    'border:1px solid #363c4e;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.5);' +
    'font:12px/1.5 -apple-system,"Segoe UI",sans-serif;color:#d5d8e0;user-select:none;';

  for (const it of items) {
    if (it.sep) {
      const hr = doc.createElement('div');
      hr.style.cssText = 'height:1px;margin:4px 8px;background:#2a2e39;';
      menu.appendChild(hr);
      continue;
    }
    const b = doc.createElement('button');
    b.textContent = it.label;
    b.style.cssText =
      'display:block;width:100%;text-align:left;padding:5px 12px;border:0;border-radius:4px;' +
      'background:transparent;color:' + (it.disabled ? '#5d606b' : it.primary ? '#2962ff' : '#d5d8e0') + ';' +
      'font:inherit;cursor:' + (it.disabled ? 'default' : 'pointer');
    if (!it.disabled) {
      b.addEventListener('mouseenter', () => { b.style.background = '#2a2e39'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
      b.addEventListener('click', () => { closeMoreMenu(); it.run?.(); });
    }
    menu.appendChild(b);
  }

  // Anchor: last real pointer position (the ⋯ click) → open below it. Fall
  // back to the legend row matched by the title span, then dead-center.
  let anchor: DOMRect | null = null;
  if (lastPointer.x > 0 && lastPointer.y > 0) {
    anchor = new DOMRect(lastPointer.x - 8, lastPointer.y - 8, 16, 16);
  }
  if (!anchor) {
    for (const pane of doc.querySelectorAll('[data-vela-pane]')) {
      for (const row of pane.querySelectorAll('div')) {
        const name = row.querySelector('span span');
        if (name && name.textContent === ind.title) { anchor = row.getBoundingClientRect(); break; }
      }
      if (anchor) break;
    }
  }

  doc.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = doc.defaultView?.innerWidth ?? 1280;
  const vh = doc.defaultView?.innerHeight ?? 720;
  const left = anchor ? Math.min(anchor.left, vw - mw - 8) : vw / 2 - mw / 2;
  const top = anchor ? (anchor.bottom + 4 + mh > vh ? anchor.top - 4 - mh : anchor.bottom + 4) : vh / 2 - mh / 2;
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
  openMoreMenuEl = menu;

  const dismiss = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      closeMoreMenu();
      doc.removeEventListener('mousedown', dismiss, true);
    }
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      closeMoreMenu();
      doc.removeEventListener('keydown', esc, true);
      doc.removeEventListener('mousedown', dismiss, true);
    }
  };
  doc.addEventListener('mousedown', dismiss, true);
  doc.addEventListener('keydown', esc, true);
}


// ── Favorites for indicator rows (separate from script favorites) ──
const IND_FAV_KEY = 'opencharts.pine.ind-fav';
function favsRead(): string[] {
  try { const r = JSON.parse(localStorage.getItem(IND_FAV_KEY) || '[]'); return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
function toggleIndicatorFav(id: string): void {
  const cur = favsRead();
  const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
  try { localStorage.setItem(IND_FAV_KEY, JSON.stringify(next)); } catch { /* quota */ }
}



// Extract indicator/strategy title from source. Handles both
// `indicator("X", ...)` and `indicator(title = "X", ...)`; falls back to "pine".
function scriptTitle(src: string, fallback = "pine"): string {
  const m = /(?:indicator|strategy)\s*\([^)]*?(?:title\s*=\s*)?["']([^"']+)["']/.exec(src);
  return m?.[1] ?? fallback;
}



const EDITOR_ID = "pine-editor";
let open = false;

// Editor session state — which library script is loaded, whether the buffer
// has unsaved edits, and (if launched from the legend ⋯) which on-chart
// indicator handle we're updating in place.
type EditorState = { currentId: string | null; dirty: boolean; handleId?: string };
let editorState: EditorState = { currentId: null, dirty: false };

// Keep currentId consistent with the library: deleting the open script must
// not leave a dead id that makes Save throw 'script not found' (F8).
pineLibSubscribe(() => {
  if (editorState.currentId && !pineLibGet(editorState.currentId)) {
    editorState = { ...editorState, currentId: null };
  }
});

// Run the pine-hist → pineLib migration once per session, first editor open.
let migrated = false;

const TEMPLATES = {
  indicator: `//@version=6\nindicator("My indicator", overlay=true)\nplot(close)\n`,
  strategy: `//@version=6\nstrategy("My strategy", overlay=true)\nif close > open\n    strategy.entry("Long", strategy.long)\n`,
  library: `//@version=6\nlibrary("MyLibrary")\nexport add(float a, float b) =>\n    a + b\n`,
  builtin: `//@version=6\n// Copied from a built-in — replace the body.\nindicator("Built-in copy", overlay=true)\nplot(ta.sma(close, 20))\n`,
};

function closeModal(overlay: HTMLElement, menus?: HTMLElement[]): void {
  for (const m of menus ?? []) m.remove();
  overlay.remove();
  open = false;
}

function openEditor(ctx: WidgetContext, initialSrc = "", editingId?: string, scriptId?: string): void {
  if (open) return;
  open = true;
  if (!migrated) { migrated = true; try { pineLibMigrateLegacyHist(); } catch { /* first run */ } }
  const doc = ctx.host.ownerDocument;

  const overlay = doc.createElement("div");
  overlay.className = "vela-pine-overlay";
  const dialog = doc.createElement("div");
  dialog.className = "vela-pine-dialog";

  // scriptId is authoritative (caller resolved "this buffer IS that script").
  // Without it, a non-empty initialSrc means editing an indicator — reset
  // currentId so Save can't overwrite an unrelated script.
  editorState = {
    currentId: scriptId ?? (initialSrc ? null : editorState.currentId),
    dirty: false,
    handleId: editingId,
  };
  // Popup menus append to doc.body (outside overlay) — track so closeModal
  // can clean them; otherwise they survive as ghost UI.
  const openMenus: HTMLElement[] = [];
  const area = doc.createElement("textarea");
  area.className = "vela-pine-area";
  area.spellcheck = false;

  const statusMsg = doc.createElement("span");
  statusMsg.className = "vela-pine-msg";
  const setStatus = (text: string, kind: "" | "ok" | "err" = "") => {
    statusMsg.textContent = text;
    statusMsg.dataset.kind = kind;
  };

  // ── Header ── TV: [Pine Editor] [name ▾] ... [Add to chart] [Save] [⋯] [—] [✕]
  const headbar = doc.createElement("div");
  headbar.className = "vela-pine-headbar";
  const appTitle = doc.createElement("div");
  appTitle.className = "vela-pine-apptitle";
  appTitle.textContent = "Pine Editor";

  const nameBtn = doc.createElement("button");
  nameBtn.type = "button";
  nameBtn.className = "vela-pine-namebtn";
  const nameLabel = doc.createElement("span");
  nameLabel.className = "vela-pine-namelabel";
  const dirtyDot = doc.createElement("span");
  dirtyDot.className = "vela-pine-dirty";
  dirtyDot.textContent = "●";
  const caret = doc.createElement("span");
  caret.textContent = " ▾";
  nameBtn.append(nameLabel, dirtyDot, caret);

  const refreshName = () => {
    const s = editorState.currentId ? pineLibGet(editorState.currentId) : undefined;
    nameLabel.textContent = s?.name ?? "Untitled script";
    dirtyDot.classList.toggle("on", editorState.dirty);
  };

  const saveScript = () => {
    const src = area.value;
    try {
      if (!editorState.currentId) {
        const def = scriptTitle(src, "Untitled script");
        const name = doc.defaultView?.prompt?.("Script name", def) ?? "";
        if (!name.trim()) return;
        const s = pineLibCreate(name.trim(), src);
        editorState.currentId = s.id;
        setStatus(`Saved "${s.name}"`, "ok");
      } else {
        pineLibSave(editorState.currentId, src);
        setStatus("Saved", "ok");
      }
      editorState.dirty = false;
      refreshName();
    } catch (e) {
      setStatus(`Save failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  };

  const makeCopy = () => {
    if (!editorState.currentId) { setStatus("Save the script first", "err"); return; }
    pineLibSave(editorState.currentId, area.value); // capture current buffer
    const c = pineLibDuplicate(editorState.currentId);
    editorState.currentId = c.id;
    area.value = c.source;
    editorState.dirty = false;
    refreshName();
    setStatus(`Duplicated to "${c.name}"`, "ok");
  };

  const renameScript = () => {
    if (!editorState.currentId) { setStatus("Save the script first", "err"); return; }
    const cur = pineLibGet(editorState.currentId)!;
    const name = doc.defaultView?.prompt?.("Rename script", cur.name);
    if (name?.trim()) {
      pineLibRename(editorState.currentId, name.trim());
      refreshName();
      setStatus(`Renamed to "${name.trim()}"`, "ok");
    }
  };

  const openVersionHistory = () => {
    if (!editorState.currentId) { setStatus("No saved script — no versions yet", "err"); return; }
    const s = pineLibGet(editorState.currentId)!;
    const menu = doc.createElement("div");
    menu.className = "vela-pine-menu";
    const r = nameBtn.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4}px`;
    const head = doc.createElement("div");
    head.className = "vela-pine-menuhead";
    head.textContent = `Version history — ${s.versions.length}`;
    menu.append(head);
    for (let i = s.versions.length - 1; i >= 0; i--) {
      const v = s.versions[i]!;
      const item = doc.createElement("button");
      item.type = "button";
      item.className = "vela-pine-menuitem";
      const d = new Date(v.t);
      item.innerHTML = `<span>v${i + 1} — ${d.toLocaleString("zh-TW", { hour12: false })}</span><span class="vela-pine-menukey">Load</span>`;
      item.addEventListener("click", () => {
        area.value = v.src;
        editorState.dirty = true;
        refreshName();
        setStatus(`Loaded v${i + 1} (unsaved)`, "ok");
        menu.remove();
      });
      menu.append(item);
    }
    const dismiss = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) { menu.remove(); doc.removeEventListener("mousedown", dismiss); } };
    doc.addEventListener("mousedown", dismiss);
    openMenus.push(menu);
    doc.body.appendChild(menu);
  };

  const openScriptsDialogAction = () => {
    openScriptsDialog(ctx, (id) => {
      if (editorState.dirty && !doc.defaultView?.confirm?.("Discard unsaved changes?")) return;
      const s = pineLibGet(id);
      if (!s) return;
      editorState.currentId = s.id;
      editorState.handleId = undefined;
      area.value = s.source;
      editorState.dirty = false;
      refreshName();
      pineLibRecentPush(s.id);
      setStatus(`Opened "${s.name}"`, "ok");
    });
  };


  const openCreateNew = () => {
    const menu = doc.createElement("div");
    menu.className = "vela-pine-menu";
    const r = nameBtn.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4}px`;
    for (const [key, label] of [["indicator", "Indicator"], ["strategy", "Strategy"], ["library", "Library"], ["builtin", "Built-in"]] as const) {
      const item = doc.createElement("button");
      item.type = "button";
      item.className = "vela-pine-menuitem";
      item.innerHTML = `<span>${label}</span><span class="vela-pine-menukey">new</span>`;
      item.addEventListener("click", () => {
        if (editorState.dirty && !doc.defaultView?.confirm?.("Discard unsaved changes?")) { menu.remove(); return; }
        editorState.currentId = null;
        editorState.handleId = undefined;
        area.value = TEMPLATES[key];
        editorState.dirty = false;
        refreshName();
        setStatus(`New ${label.toLowerCase()} template`, "ok");
        menu.remove();
      });
      menu.append(item);
    }
    const dismiss = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) { menu.remove(); doc.removeEventListener("mousedown", dismiss); } };
    doc.addEventListener("mousedown", dismiss);
    openMenus.push(menu);
    doc.body.appendChild(menu);
  };

  const openNameMenu = () => {
    const menu = doc.createElement("div");
    menu.className = "vela-pine-menu";
    const r = nameBtn.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4}px`;

    const item = (label: string, key: string | null, fn: () => void, disabled = false) => {
      const el = doc.createElement("button");
      el.type = "button";
      el.className = "vela-pine-menuitem";
      el.disabled = disabled;
      el.innerHTML = `<span>${label}</span><span class="vela-pine-menukey">${key ?? ""}</span>`;
      el.addEventListener("click", () => { menu.remove(); fn(); });
      return el;
    };
    const sep = () => { const d = doc.createElement("div"); d.className = "vela-pine-menusep"; return d; };
    const head = (t: string) => { const d = doc.createElement("div"); d.className = "vela-pine-menuhead"; d.textContent = t; return d; };

    menu.append(
      item("Save script", "Ctrl + S", saveScript),
      item("Make a copy…", null, makeCopy),
      item("Rename…", null, renameScript),
      item("Version history…", null, openVersionHistory),
      item("Move script to bottom", null, () => { setStatus("Bottom dock: not in this phase"); }, true),
      sep(),
      item("Create new ▸", null, openCreateNew),
      sep(),
    );
    const recent = pineLibRecent().slice(0, 4).map(id => pineLibGet(id)).filter((s): s is NonNullable<typeof s> => !!s);
    if (recent.length > 0) {
      menu.append(head("Recently used"));
      for (const s of recent) {
        menu.append(item(s.name, null, () => {
          if (editorState.dirty && !doc.defaultView?.confirm?.("Discard unsaved changes?")) return;
          editorState.currentId = s.id;
          editorState.handleId = undefined;
          area.value = s.source;
          editorState.dirty = false;
          refreshName();
          pineLibRecentPush(s.id);
          setStatus(`Opened "${s.name}"`, "ok");
        }));
      }
      menu.append(sep());
    }
    menu.append(item("Open script…", "Ctrl + O", openScriptsDialogAction));

    const dismiss = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) { menu.remove(); doc.removeEventListener("mousedown", dismiss); } };
    doc.addEventListener("mousedown", dismiss);
    openMenus.push(menu);
    doc.body.appendChild(menu);
  };
  nameBtn.addEventListener("click", openNameMenu);

  const addToChartBtn = doc.createElement("button");
  addToChartBtn.type = "button";
  addToChartBtn.className = "vela-pine-hbtn primary";
  addToChartBtn.textContent = "Add to chart";

  // TV's two refresh icons: ~ (reload script = reload source from library) and
  // ⭮ (re-compile = re-run the buffer without saving). Both are tiny icon
  // buttons; using text glyphs keeps it ASCII.
  const reloadBtn = doc.createElement("button");
  reloadBtn.type = "button";
  reloadBtn.className = "vela-pine-hbtn";
  reloadBtn.textContent = "↻";
  reloadBtn.title = "Reload script from library";
  reloadBtn.addEventListener("click", () => {
    if (!editorState.currentId) { setStatus("Nothing to reload", "err"); return; }
    const s = pineLibGet(editorState.currentId);
    if (!s) { setStatus("Script no longer in library", "err"); return; }
    if (editorState.dirty && !doc.defaultView?.confirm?.("Discard unsaved changes?")) return;
    area.value = s.source;
    editorState.dirty = false;
    refreshName();
    setStatus("Reloaded", "ok");
  });

  addToChartBtn.addEventListener("click", () => {
    void (async () => {
      setStatus("Running…");
      try {
        const src = area.value;
        // No overlay detection here: the old regex missed multi-line decls and
        // strategy() entirely, and passing {pane:"new"} overrides the script's
        // own overlay=true. runIndicator with no options routes on the parsed
        // model's overlay flag — TV semantics.
        if (editorState.handleId) {
          const handle = ctx.chart.indicators().find((h) => h.id === editorState.handleId);
          if (handle) {
            handle.updateCode(src);
            setStatus("Updated in place", "ok");
          } else {
            const r = await ctx.chart.runIndicator(src);
            if (r && typeof r === 'object' && 'ok' in r && r.ok === false) {
              setStatus(`Run failed: ${'error' in r ? String(r.error) : 'unknown'}`, "err");
              return;
            }
            setStatus("Original gone — added new", "ok");
            // Update handleId to the new indicator so next Add hits updateCode.
            const added = ctx.chart.indicators().at(-1);
            if (added) editorState.handleId = added.id;
          }
        } else {
          const r = await ctx.chart.runIndicator(src);
          if (r && typeof r === 'object' && 'ok' in r && r.ok === false) {
            setStatus(`Run failed: ${'error' in r ? String(r.error) : 'unknown'}`, "err");
            return;
          }
          setStatus("Added", "ok");
        }
        rebuildOnChart();
      } catch (e) {
        setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, "err");
      }
    })();
  });

  const saveBtn = doc.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "vela-pine-hbtn";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", saveScript);

  // TV header order: [Publish script] [⋯] [—] [✕]. Publish is a community
  // feature we don't have — keep it disabled for pixel-parity.
  const publishBtn = doc.createElement("button");
  publishBtn.type = "button";
  publishBtn.className = "vela-pine-hbtn";
  publishBtn.textContent = "Publish script";
  publishBtn.disabled = true;
  publishBtn.title = "Publish: not available locally";

  const moreBtn = doc.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "vela-pine-hbtn";
  moreBtn.textContent = "⋯";
  moreBtn.title = "More";
  moreBtn.disabled = true;   // phase 3: Editor settings / Command palette / Pine logs

  const collapseBtn = doc.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "vela-pine-hbtn";
  collapseBtn.textContent = "—";
  collapseBtn.title = "Collapse";
  collapseBtn.addEventListener("click", () => {
    try { sessionStorage.setItem("opencharts.pine.draft", JSON.stringify({ id: editorState.currentId, src: area.value })); } catch { /* quota */ }
    closeModal(overlay, openMenus);
  });

  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "vela-pine-hbtn";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", () => {
    if (editorState.dirty && !doc.defaultView?.confirm?.("Unsaved changes will be lost. Close anyway?")) return;
    closeModal(overlay, openMenus);
  });

  const spacer = doc.createElement("div");
  spacer.className = "vela-pine-spacer";

  headbar.append(appTitle, nameBtn, reloadBtn, spacer, addToChartBtn, saveBtn, publishBtn, moreBtn, collapseBtn, closeBtn);

  // ── Buffer init: legend-edit src > collapsed draft > library entry > template ──
  const draft = (() => { try { return JSON.parse(sessionStorage.getItem("opencharts.pine.draft") || "null") as { id: string | null; src: string } | null; } catch { return null; } })();
  if (initialSrc) {
    area.value = initialSrc;
  } else if (draft?.src && !editorState.currentId) {
    area.value = draft.src;
    editorState.currentId = draft.id && pineLibGet(draft.id) ? draft.id : null;
  } else if (editorState.currentId) {
    area.value = pineLibGet(editorState.currentId)?.source ?? initialSrc;
  } else {
    area.value = TEMPLATES.indicator;
  }
  try { sessionStorage.removeItem("opencharts.pine.draft"); } catch { /* noop */ }
  refreshName();

  area.addEventListener("input", () => {
    editorState.dirty = true;
    refreshName();
  });

  // ── On-chart indicators: what this cell is currently running ──
  const onChart = doc.createElement("div");
  onChart.className = "vela-pine-onchart";
  const onChartLabel = doc.createElement("div");
  onChartLabel.className = "vela-pine-onchart-label";
  const rebuildOnChart = () => {
    const handles = ctx.chart.indicators().filter(h => typeof h.source === 'string' && h.source.length > 0);
    onChartLabel.textContent = handles.length === 0 ? "On-chart indicators (none)" : `On-chart indicators (${handles.length}) — click to load`;
    [...onChart.querySelectorAll('.vela-pine-onchart-item, .vela-pine-onchart-empty')].forEach(e => e.remove());
    if (handles.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "vela-pine-onchart-empty";
      empty.textContent = "No indicators yet — run a script with Add to chart";
      onChart.appendChild(empty);
      return;
    }
    for (const h of handles) {
      const row = doc.createElement("div");
      row.className = "vela-pine-onchart-item";
      const name = doc.createElement("span");
      name.className = "vela-pine-onchart-name";
      const t = scriptTitle(h.source ?? '', (h.title !== 'Indicator' && h.title !== 'Strategy' ? h.title : h.id) ?? h.id ?? 'pine');
      name.textContent = t;
      name.title = "Load into editor";
      name.addEventListener("click", () => {
        if (editorState.dirty && !doc.defaultView?.confirm?.("Discard unsaved changes?")) return;
        const match = pineLibList().find(s => s.source === h.source);
        editorState.currentId = match?.id ?? null;
        editorState.handleId = h.id;
        area.value = h.source ?? '';
        editorState.dirty = false;
        refreshName();
        setStatus(`Loaded "${t}" — Update in place`, "ok");
      });
      const del = doc.createElement("button");
      del.type = "button";
      del.className = "vela-pine-onchart-del";
      del.textContent = "✕";
      del.title = "Remove from chart";
      del.addEventListener("click", () => {
        try { h.remove?.(); } catch { /* older vela */ }
        rebuildOnChart();
        setStatus(`Removed "${t}"`, "ok");
      });
      row.append(name, del);
      onChart.appendChild(row);
    }
  };
  rebuildOnChart();

  // ── Statusbar ──
  const statusbar = doc.createElement("div");
  statusbar.className = "vela-pine-statusbar";
  const cursorPos = doc.createElement("button");
  cursorPos.type = "button";
  cursorPos.className = "vela-pine-hbtn";
  cursorPos.title = "Go to line";
  const updateCursor = () => {
    const pos = area.selectionStart;
    const before = area.value.slice(0, pos);
    const line = before.split("\n").length;
    const col = pos - before.lastIndexOf("\n");
    cursorPos.textContent = `Line ${line}, Col ${col}`;
  };
  updateCursor();
  area.addEventListener("keyup", updateCursor);
  area.addEventListener("click", updateCursor);
  area.addEventListener("input", updateCursor);
  cursorPos.addEventListener("click", () => {
    const input = doc.defaultView?.prompt?.("Go to line:column", "1:1");
    if (!input) return;
    const m = /^(\d+)(?::(\d+))?$/.exec(input.trim());
    if (!m) { setStatus("Use line:col", "err"); return; }
    const line = Math.max(1, parseInt(m[1]!, 10));
    const col = Math.max(1, parseInt(m[2] ?? "1", 10));
    const lines = area.value.split("\n");
    let pos = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i]!.length + 1;
    pos += Math.min(col - 1, lines[Math.min(line - 1, lines.length - 1)]!.length);
    area.focus();
    area.setSelectionRange(pos, pos);
    updateCursor();
  });

  const verLabel = doc.createElement("a");
  verLabel.textContent = "Pine Script v6";
  verLabel.href = "https://www.tradingview.com/pine-script-reference/v6/";
  verLabel.target = "_blank";
  verLabel.rel = "noopener";

  statusbar.append(cursorPos, statusMsg, verLabel);

  // ── Assemble ──
  dialog.append(headbar, area, onChartLabel, onChart, statusbar);
  overlay.appendChild(dialog);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      if (editorState.dirty && !doc.defaultView?.confirm?.("Unsaved changes will be lost. Close anyway?")) return;
      closeModal(overlay, openMenus);
    }
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (editorState.dirty && !doc.defaultView?.confirm?.("Unsaved changes will be lost. Close anyway?")) return;
      closeModal(overlay, openMenus);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveScript(); }
    if ((e.ctrlKey || e.metaKey) && e.key === "o") { e.preventDefault(); openScriptsDialogAction(); }
  });

  // Append to document.body — ctx.host is a cell host that dies on
  // cell:destroyed (undo, layout change, state restore), taking the modal with it.
  // MutationObserver catches external .remove() (HMR, devtools, other teardown)
  // so `open` doesn't latch permanently.
  const mo = new MutationObserver(() => {
    if (!overlay.isConnected) { open = false; mo.disconnect(); }
  });
  doc.body.appendChild(overlay);
  mo.observe(doc.documentElement, { childList: true, subtree: true });
  area.focus();
}

/** Legend ⋯ → Edit source code entry point: load a saved library script by id. */
export function openPineEditorWithScript(ctx: WidgetContext, scriptId: string): void {
  const s = pineLibGet(scriptId);
  if (!s) return;
  openEditor(ctx, s.source, undefined, s.id);
}


registerWidgetAction({
  id: EDITOR_ID,
  target: "topbar",
  align: "right",
  icon: "pen",
  label: "Pine",
  order: 0,
  run: (ctx) => openEditor(ctx),
});
