/**
 * Named chart layouts for the Vela workspace — the TradingView "layout name in the
 * topbar + Save / Save as / Autosave" model.
 *
 * The LIVE document still auto-persists to `vela-workspace-v2` through vela's own
 * persist seam; this module adds named snapshots on top, so "Load layout" restores
 * the WHOLE workspace doc (charts + indicators incl. `ext` pine scripts + drawings),
 * not a prefs subset like the trading page's templates.
 *
 * `velaLayoutsApi` mirrors `services/api/chart-templates.ts`: localStorage-backed
 * today, same {id,name,layoutType,panels,updatedAt} record shape so a real backend
 * can replace the storage calls without touching the UI.
 *
 * Init: `initVelaLayouts(ws)` from VelaPage once the workspace exists. The topbar
 * action is registered at import time (contribution registries require it).
 */
import { registerWidgetAction, registerIcon, type WidgetContext } from "@luxalgo/vela/plugin";
import { svg16 } from "@luxalgo/vela/ui";
import type { VelaWorkspace, WorkspaceState } from "@luxalgo/vela/workspace";

// ── Storage (swap these bodies for HTTP calls when a backend lands) ──
export interface VelaLayoutDoc {
  version: 1;
  doc: WorkspaceState;
}
export interface VelaLayout {
  id: string;
  name: string;
  layoutType: "VELA";
  panels: VelaLayoutDoc[];
  updatedAt: string;
}

const STORE_KEY = "oc_vela_layouts";
const ACTIVE_KEY = "opencharts.vela.active-layout";
const AUTOSAVE_KEY = "opencharts.vela.layout-autosave";

function readAll(): VelaLayout[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function writeAll(list: VelaLayout[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    // quota — the mutation is dropped; callers already have the in-memory list
  }
}

export const velaLayoutsApi = {
  list: (): Promise<VelaLayout[]> => Promise.resolve(readAll()),
  /** Upsert by name (unique per user), matching chartTemplatesApi.save semantics. */
  save: (name: string, doc: WorkspaceState): Promise<VelaLayout> => {
    const list = readAll();
    const existing = list.find((t) => t.name === name);
    const rec: VelaLayout = {
      id: existing?.id ?? crypto.randomUUID(),
      name,
      layoutType: "VELA",
      panels: [{ version: 1, doc }],
      updatedAt: new Date().toISOString(),
    };
    writeAll([...list.filter((t) => t.name !== name), rec]);
    return Promise.resolve(rec);
  },
  remove: (id: string): Promise<{ deleted: true }> => {
    writeAll(readAll().filter((t) => t.id !== id));
    return Promise.resolve({ deleted: true });
  },
  /** Rename keeps the doc, clears any name collision (save upserts by name). */
  rename: (id: string, name: string): Promise<void> => {
    const list = readAll().filter((t) => t.id === id || t.name !== name);
    const t = list.find((x) => x.id === id);
    if (t) { t.name = name; t.updatedAt = new Date().toISOString(); }
    writeAll(list);
    return Promise.resolve();
  },
};

// ── Active-layout + autosave prefs ──
export function velaActiveLayout(): string {
  return localStorage.getItem(ACTIVE_KEY) ?? "";
}
export function velaSetActiveLayout(name: string): void {
  if (name) localStorage.setItem(ACTIVE_KEY, name);
  else localStorage.removeItem(ACTIVE_KEY);
}
export function velaLayoutAutosave(): boolean {
  // TV default: autosave ON for the active layout.
  return localStorage.getItem(AUTOSAVE_KEY) !== "0";
}
export function velaSetLayoutAutosave(on: boolean): void {
  localStorage.setItem(AUTOSAVE_KEY, on ? "1" : "0");
}

// ── Workspace handle: set by VelaPage's initVelaLayouts call. ──
let wsRef: VelaWorkspace | null = null;
// Loading a layout fires state:changed ~500ms later; suppress that one autosave
// so load doesn't immediately rewrite the authored doc with canonicalized
// live state (which would merge pendingAdds etc. and silently drift it).
let autosaveSuppressedUntil = 0;

/** Call once from VelaPage after `new VelaWorkspace(...)`. Idempotent. */
export function initVelaLayouts(ws: VelaWorkspace): void {
  if (wsRef === ws) return; // StrictMode remount must not stack listeners
  wsRef = ws;
  // Autosave: every persistable change re-saves the ACTIVE named layout — same
  // debounce cadence as the live-document persist (state:changed already fires
  // post-500ms-burst, so writes here inherit it).
  ws.on("state:changed", () => {
    if (Date.now() < autosaveSuppressedUntil) return; // load-driven emit
    const name = velaActiveLayout();
    if (!velaLayoutAutosave() || !name) return;
    void velaLayoutsApi.save(name, ws.getState());
  });
  refreshTopbarLabel();
}

// ── Topbar action: label tracks the active layout name (TV parity). ──
const ACTION_ID = "opencharts.vela-layouts";
function registerAction(): void {
  registerWidgetAction({
    id: ACTION_ID,
    target: "topbar",
    align: "left",
    icon: "cloud-save",
    label: velaActiveLayout() || "Layouts",
    order: -10, // first in the contributed left cluster
    run: (ctx) => openLayoutsMenu(ctx),
  });
}
function refreshTopbarLabel(): void {
  registerAction();
  wsRef?.refreshActions();
}
function setActive(name: string): void {
  velaSetActiveLayout(name);
  refreshTopbarLabel();
}

registerIcon("cloud-save", svg16(
  '<path d="M8 11a3.5 3.5 0 0 1-.6-6.9A4.5 4.5 0 0 1 16 5.6 3.2 3.2 0 0 1 15.3 12H9"/><path d="M8 8.5V14M5.8 11 8 8.8l2.2 2.2"/>',
));
registerAction();

// ── Dropdown menu (imperative DOM — same pattern as the Pine editor modal) ──
const CSS = `
.vela-layouts-scrim{position:fixed;inset:0;z-index:9998}
.vela-layouts-menu{position:fixed;z-index:9999;min-width:230px;max-width:280px;
  background:var(--vela-bg,#1e222d);border:1px solid var(--vela-border,#2a2e39);
  border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);padding:4px 0;
  color:var(--vela-fg,#d1d4dc);font:12px/1.4 sans-serif}
.vela-layouts-menu .hd{padding:6px 12px;font-size:10px;text-transform:uppercase;
  letter-spacing:.06em;color:var(--vela-fg-muted,#868993)}
.vela-layouts-menu .empty{padding:7px 12px;color:var(--vela-fg-muted,#868993)}
.vela-layouts-menu button.row{display:flex;align-items:center;gap:8px;width:100%;
  padding:7px 12px;border:0;background:none;color:inherit;cursor:pointer;text-align:left}
.vela-layouts-menu button.row:hover{background:rgba(255,255,255,.06)}
.vela-layouts-menu button.row[disabled]{opacity:.4;cursor:default}
.vela-layouts-menu .sep{height:1px;background:var(--vela-border,#2a2e39);margin:4px 0}
.vela-layouts-menu .lrow{display:flex;align-items:center}
.vela-layouts-menu .lrow .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vela-layouts-menu .lrow .del{opacity:0;padding:2px 6px;border:0;background:none;color:#ef5350;cursor:pointer}
.vela-layouts-menu .lrow:hover .del{opacity:1}
.vela-layouts-menu .active{color:var(--vela-accent,#2962ff)}
.vela-layouts-menu .toggle{margin-left:auto;width:26px;height:14px;border-radius:7px;
  background:#434651;position:relative;transition:background .15s;flex:none}
.vela-layouts-menu .toggle.on{background:#2962ff}
.vela-layouts-menu .toggle::after{content:"";position:absolute;top:2px;left:2px;width:10px;
  height:10px;border-radius:50%;background:#fff;transition:left .15s}
.vela-layouts-menu .toggle.on::after{left:14px}
`;
let cssInjected = false;
function ensureCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const s = document.createElement("style");
  s.dataset.velaLayouts = "";
  s.textContent = CSS;
  document.head.appendChild(s);
}

function openLayoutsMenu(ctx: WidgetContext): void {
  const ws = wsRef;
  if (!ws) return;
  ensureCss();

  document.querySelectorAll(".vela-layouts-menu, .vela-layouts-scrim").forEach((el) => el.remove());

  const scrim = document.createElement("div");
  scrim.className = "vela-layouts-scrim";
  const menu = document.createElement("div");
  menu.className = "vela-layouts-menu";
  // The action sits in the LEFT cluster → anchor the menu top-left, just under
  // the topbar (its real height comes from the workspace root, not a guessed
  // class name).
  const hostTop = ctx.host.getBoundingClientRect().top || 0;
  menu.style.top = `${Math.max(hostTop, 40) + 4}px`;
  menu.style.left = "10px";

  const close = (): void => { menu.remove(); scrim.remove(); };
  scrim.addEventListener("click", close);

  const row = (label: string, onClick: () => void, disabled = false): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "row";
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
  };
  const hd = (text: string): HTMLElement => {
    const el = document.createElement("div");
    el.className = "hd";
    el.textContent = text;
    return el;
  };

  const rebuild = (): void => {
    menu.replaceChildren();
    const active = velaActiveLayout();

    // Autosave toggle (TV parity: controls whether the active layout tracks edits)
    const as = row("Autosave", () => {
      velaSetLayoutAutosave(!velaLayoutAutosave());
      rebuild();
    });
    const tog = document.createElement("span");
    tog.className = "toggle" + (velaLayoutAutosave() ? " on" : "");
    as.appendChild(tog);
    menu.appendChild(as);

    menu.appendChild(row(`Save${active ? ` "${active}"` : ""}`, () => {
      void velaLayoutsApi.save(active, ws.getState()).then(() => ctx.toast(`Saved "${active}"`, "success"));
      close();
    }, !active));

    menu.appendChild(row("Save layout as…", () => {
      const name = document.defaultView?.prompt?.("Layout name", active)?.trim();
      if (!name) return;
      void velaLayoutsApi.save(name, ws.getState()).then(() => {
        setActive(name);
        ctx.toast(`Saved "${name}"`, "success");
      });
      close();
    }));

    menu.appendChild(row("Rename active…", () => {
      const cur = velaActiveLayout();
      const t = readAll().find((x) => x.name === cur);
      if (!t) return;
      const name = document.defaultView?.prompt?.("Rename layout", cur)?.trim();
      if (!name || name === cur) return;
      void velaLayoutsApi.rename(t.id, name).then(() => {
        setActive(name);
        rebuild();
      });
    }, !active || !readAll().some((x) => x.name === active)));

    const sepEl = document.createElement("div");
    sepEl.className = "sep";
    menu.append(sepEl, hd("Saved layouts"));

    const list = readAll().slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No saved layouts";
      menu.appendChild(empty);
    }
    for (const t of list) {
      const wrap = document.createElement("div");
      wrap.className = "lrow";
      const nameBtn = row(t.name, () => {
        const doc = t.panels[0]?.doc;
        if (!doc) return;
        ws.applyState(doc);
        // vela re-emits state:changed ~500ms after applyState — don't let that
        // load-driven emit rewrite the just-loaded layout under autosave.
        autosaveSuppressedUntil = Date.now() + 1500;
        setActive(t.name);
        ctx.toast(`Loaded "${t.name}"`, "info");
        close();
      });
      nameBtn.classList.add("name");
      if (t.name === active) nameBtn.classList.add("active");
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.title = `Delete "${t.name}"`;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void velaLayoutsApi.remove(t.id).then(() => {
          if (velaActiveLayout() === t.name) setActive("");
          rebuild();
        });
      });
      wrap.append(nameBtn, del);
      menu.appendChild(wrap);
    }
  };

  rebuild();
  document.body.append(scrim, menu);
}
