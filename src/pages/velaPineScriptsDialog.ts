/**
 * "Open script…" dialog — TV's Ctrl+O script browser for the user's library.
 * Modal overlay (same pattern as the pine editor), search input at top,
 * a row per script: name + updated + versions + favorite star + ⋯ actions.
 */
import type { WidgetContext } from "@luxalgo/vela";
import {
  pineLibList, pineLibRename, pineLibDuplicate, pineLibRemove,
  pineLibSubscribe,
} from "../pine/lib/pineLib.ts";

const FAV_KEY = 'opencharts.pine.fav';

function favRead(): string[] {
  try {
    const r = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
function favToggle(id: string): void {
  const cur = favRead();
  const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
  try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch { /* quota */ }
}

export function openScriptsDialog(ctx: WidgetContext, onPick: (id: string) => void): void {
  const doc = ctx.host.ownerDocument;
  const overlay = doc.createElement("div");
  overlay.className = "vela-pine-overlay";
  const dialog = doc.createElement("div");
  dialog.className = "vela-pine-dialog vela-pine-scripts";

  // ── Header ──
  const head = doc.createElement("div");
  head.className = "vela-pine-headbar";
  const title = doc.createElement("div");
  title.className = "vela-pine-apptitle";
  title.textContent = "Open script";
  const spacer = doc.createElement("div");
  spacer.className = "vela-pine-spacer";
  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "vela-pine-hbtn";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => overlay.remove());
  head.append(title, spacer, closeBtn);

  // ── Search ──
  const searchWrap = doc.createElement("div");
  searchWrap.className = "vela-pine-searchwrap";
  const search = doc.createElement("input");
  search.className = "vela-pine-search";
  search.placeholder = "Search scripts…";
  searchWrap.append(search);

  // ── List ──
  const list = doc.createElement("div");
  list.className = "vela-pine-scriptlist";
  let query = "";

  const rowMenu = (id: string, name: string, row: HTMLElement) => {
    const menu = doc.createElement("div");
    menu.className = "vela-pine-menu";
    const r = row.getBoundingClientRect();
    menu.style.left = `${r.right - 200}px`;
    menu.style.top = `${r.bottom + 2}px`;
    const item = (label: string, fn: () => void) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "vela-pine-menuitem";
      b.textContent = label;
      b.addEventListener("click", () => { menu.remove(); fn(); });
      return b;
    };
    menu.append(
      item("Rename…", () => {
        const n = doc.defaultView?.prompt?.("Rename script", name);
        if (n?.trim()) { pineLibRename(id, n.trim()); rebuild(); }
      }),
      item("Make a copy", () => { pineLibDuplicate(id); rebuild(); }),
      item("Delete", () => {
        if (doc.defaultView?.confirm?.(`Delete "${name}"? This can't be undone.`)) {
          pineLibRemove(id);
          rebuild();
        }
      }),
    );
    const dismiss = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) { menu.remove(); doc.removeEventListener("mousedown", dismiss); } };
    doc.addEventListener("mousedown", dismiss);
    doc.body.appendChild(menu);
  };

  const rebuild = () => {
    list.innerHTML = "";
    const favs = favRead();
    const all = pineLibList();
    const filtered = query
      ? all.filter(s => s.name.toLowerCase().includes(query))
      : all;
    if (filtered.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "vela-pine-onchart-empty";
      empty.style.padding = "20px";
      empty.textContent = all.length === 0 ? "No scripts yet — create one from the editor" : `No matches for "${query}"`;
      list.append(empty);
      return;
    }
    for (const s of filtered) {
      const row = doc.createElement("div");
      row.className = "vela-pine-scriptrow";

      const star = doc.createElement("button");
      star.type = "button";
      star.className = "vela-pine-star" + (favs.includes(s.id) ? " on" : "");
      star.textContent = "★";
      star.title = "Favorite";
      star.addEventListener("click", (e) => { e.stopPropagation(); favToggle(s.id); rebuild(); });

      const nameEl = doc.createElement("span");
      nameEl.className = "vela-pine-scriptname";
      nameEl.textContent = s.name;

      const meta = doc.createElement("span");
      meta.className = "vela-pine-scriptmeta";
      meta.textContent = `${s.versions.length}v · ${new Date(s.updatedAt).toLocaleDateString("zh-TW")}`;

      const more = doc.createElement("button");
      more.type = "button";
      more.className = "vela-pine-scriptmore";
      more.textContent = "⋯";
      more.title = "Actions";
      more.addEventListener("click", (e) => { e.stopPropagation(); rowMenu(s.id, s.name, row); });

      row.append(star, nameEl, meta, more);
      row.addEventListener("click", () => {
        onPick(s.id);
        overlay.remove();
      });
      list.append(row);
    }
  };
  rebuild();

  search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); rebuild(); });

  // live refresh if another tab/cell mutates the library
  const unsub = pineLibSubscribe(rebuild);
  overlay.addEventListener("remove", () => unsub());

  dialog.append(head, searchWrap, list);
  overlay.appendChild(dialog);

  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") overlay.remove(); });

  doc.body.appendChild(overlay);
  search.focus();
}
