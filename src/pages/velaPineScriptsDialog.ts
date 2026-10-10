/**
 * "Open script…" dialog — TV's Ctrl+O script browser for the user's library.
 * Modal overlay (same pattern as the pine editor), search input at top,
 * a category rail (★ Favorites / Recent / All) on the left, and a row per
 * script: name + updated + versions + favorite star + ⋯ actions.
 */
import type { WidgetContext } from "@luxalgo/vela";
import {
  pineLibList, pineLibGet, pineLibRecent, pineLibRename, pineLibDuplicate,
  pineLibRemove, pineLibSubscribe,
} from "../pine/lib/pineLib.ts";
import type { PineScriptEntry } from "../pine/lib/pineLib.ts";

// Modal + rail styles — inject-once. velaPineEditor's PINE_CSS redefined
// `.vela-pine-dialog` as the PANEL body (height:100%, no width bound) and
// dropped the overlay/apptitle rules the modal still mounts, so this file
// re-declares them scoped under .vela-pine-overlay. height:auto overrides the
// panel body's height:100% so small libraries don't pin at the 88vh cap.
const CATRAIL_CSS = `
.vela-pine-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}
.vela-pine-overlay .vela-pine-dialog{display:flex;flex-direction:column;width:min(900px,92vw);height:auto;max-height:88vh;background:#1e222d;border:1px solid #363c4e;border-radius:8px;color:#d5d8e0;font:13px/1.4 sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6);overflow:hidden}
.vela-pine-overlay .vela-pine-apptitle{color:#d5d8e0;font-weight:600;font-size:13px;padding:0 8px;white-space:nowrap}
.vela-pine-overlay .vela-pine-scriptlist{flex:1;overflow:auto;padding:4px 0;min-height:0}
.vela-pine-catrow{display:flex;flex:1;min-height:0}
.vela-pine-catrail{display:flex;flex-direction:column;gap:2px;width:72px;flex:0 0 72px;padding:8px 4px;border-right:1px solid #2a2e39}
.vela-pine-catrail button{background:none;border:0;color:#8b8f9c;text-align:left;padding:6px 8px;font-size:12px;cursor:pointer;border-radius:4px}
.vela-pine-catrail button:hover{color:#d5d8e0;background:#2a2e39}
.vela-pine-catrail button.on{color:#2962ff;font-weight:600}
`;
let catrailCssDone = false;


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
  // Inject rail styles once (same inject-once shape as velaPineEditor's PINE_CSS
  // block, flag-guarded since the dialog may outlive the editor module).
  if (!catrailCssDone) {
    catrailCssDone = true;
    const style = doc.createElement("style");
    style.dataset.velaPineCatrail = "";
    style.textContent = CATRAIL_CSS;
    doc.head.appendChild(style);
  }
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

  // ── Category rail + list body row ──
  type Tab = "fav" | "recent" | "all";
  let tab: Tab = "all";
  const bodyRow = doc.createElement("div");
  bodyRow.className = "vela-pine-catrow";
  const rail = doc.createElement("div");
  rail.className = "vela-pine-catrail";

  // ── List ──
  const list = doc.createElement("div");
  list.className = "vela-pine-scriptlist";
  let query = "";

  const railBtn = (label: string, t: Tab) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      tab = t;
      for (const x of rail.querySelectorAll("button")) x.classList.toggle("on", x === b);
      rebuild();
    });
    if (t === tab) b.classList.add("on");
    return b;
  };
  rail.append(railBtn("★ Favorites", "fav"), railBtn("Recent", "recent"), railBtn("All", "all"));
  bodyRow.append(rail, list);

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
    const pool: PineScriptEntry[] =
      tab === "fav" ? all.filter(s => favs.includes(s.id))
      : tab === "recent" ? pineLibRecent().map(id => pineLibGet(id)).filter((s): s is PineScriptEntry => !!s)
      : all;
    const filtered = query
      ? pool.filter(s => s.name.toLowerCase().includes(query))
      : pool;
    if (filtered.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "vela-pine-onchart-empty";
      empty.style.padding = "20px";
      empty.textContent = pool.length === 0
        ? (tab === "all" ? "No scripts yet — create one from the editor" : "No scripts here")
        : `No matches for "${query}"`;
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
  // live refresh if another tab/cell mutates the library — unsubscribe on close.
  // DOM has no 'remove' event; poll the connection flag instead.
  const unsub = pineLibSubscribe(rebuild);
  const detach = () => { unsub(); };
  // hook every close path: ✕ button, overlay click, Escape, and MutationObserver
  // for external .remove() calls.
  const mo = new MutationObserver(() => { if (!overlay.isConnected) { detach(); mo.disconnect(); } });
  dialog.append(head, searchWrap, bodyRow);
  overlay.appendChild(dialog);

  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") overlay.remove(); });
  mo.observe(doc.documentElement, { childList: true, subtree: true });
  doc.body.appendChild(overlay);
  search.focus();
}
