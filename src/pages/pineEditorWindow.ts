// Popout Pine editor window — a textarea + toolbar synced with the main
// app's panel editor over BroadcastChannel. The main window owns all logic
// (save/run/lint); this window only edits and sends commands.
const CH = "opencharts.pine.win";
const ch = new BroadcastChannel(CH);

const ed = document.getElementById("ed") as HTMLTextAreaElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;
const cursorEl = document.getElementById("cursor") as HTMLSpanElement;
const nameEl = document.getElementById("nameLabel") as HTMLSpanElement;
const dirtyEl = document.getElementById("dirty") as HTMLSpanElement;
const menuEl = document.getElementById("menu") as HTMLDivElement;

let applying = false;
let dirty = false;
let meta: { name?: string; dirty?: boolean; id?: string; hasId?: boolean; suggestName?: string; recent?: {id:string;name:string}[]; all?: {id:string;name:string}[]; versions?: {i:number;t:number}[] } | null = null;

function setDirty(d: boolean): void {
  dirty = d;
  dirtyEl.classList.toggle("on", d);
}

function updateCursor(): void {
  const pos = ed.selectionStart;
  const before = ed.value.slice(0, pos);
  cursorEl.textContent = `Line ${before.split("\n").length}, Col ${pos - before.lastIndexOf("\n")}`;
}

ed.addEventListener("input", () => {
  if (applying) return;
  setDirty(true);
  ch.postMessage({ t: "value", v: ed.value });
});
ed.addEventListener("keyup", updateCursor);
ed.addEventListener("click", updateCursor);
// Save: the name prompt MUST run in THIS window. A prompt() in the main window
// is not tied to the click that triggered it, so Chrome returns null and every
// first-time save reported "Save cancelled" (red status) without saving.
// The dirty dot is cleared by the parent's status reply, never optimistically —
// an optimistic clear hid storage failures.
function saveWithName(): void {
  // Every command carries the live buffer (`v`). The parent used to act on its
  // own `pendingValue` copy, which lags whenever the `input` message has not
  // landed yet — that stale copy is what got saved/run instead of what is on
  // screen. The buffer travels with the command now, so there is no window
  // where the two disagree.
  let name: string | undefined;
  if (!meta || !meta.hasId) {
    // Derive the default from THIS buffer, not from meta: meta.suggestName is
    // a round-trip old and would suggest the previous script's title.
    const suggested = /(?:indicator|strategy)\s*\([^)]*?(?:title\s*=\s*)?["']([^"']+)["']/.exec(ed.value)?.[1]
      ?? meta?.suggestName ?? "Untitled script";
    const input = window.prompt("Script name", suggested);
    if (input === null || !input.trim()) { statusEl.textContent = "Save cancelled"; statusEl.dataset.kind = ""; return; }
    name = input;
  }
  cmd("save", name !== undefined ? { name } : {});
}

ed.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveWithName(); }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); cmd("run"); }
  if (e.key === "Tab") { // indent without focus escape
    e.preventDefault();
    const s = ed.selectionStart, en = ed.selectionEnd;
    ed.setRangeText("  ", s, en, "end");
    setDirty(true);
    ch.postMessage({ t: "value", v: ed.value });
  }
});

document.getElementById("btn-run")!.addEventListener("click", () => cmd("run"));
document.getElementById("btn-save")!.addEventListener("click", saveWithName);
document.getElementById("btn-reload")!.addEventListener("click", () => cmd("reload"));
document.getElementById("btn-clear")!.addEventListener("click", () => {
  ed.value = "";
  setDirty(true);
  ch.postMessage({ t: "value", v: "" });
  ed.focus();
});

ch.onmessage = (e) => {
  const m = e.data as { t?: string; v?: string; name?: string; kind?: string; dirty?: boolean;
    id?: string; hasId?: boolean; suggestName?: string;
    recent?: {id:string;name:string}[]; all?: {id:string;name:string}[]; versions?: {i:number;t:number}[] };
  // A freshly (re)loaded main window has lost the buffer and script id — hand
  // it ours instead of letting it push its empty state over this editor.
  if (m.t === "ping") ch.postMessage({ t: "adopt", v: ed.value, id: meta?.id, dirty });
  if (m.t === "status" || m.t === "meta") clearTimeout(noReplyTimer);
  if (m.t === "value" && typeof m.v === "string" && m.v !== ed.value) {
    const pos = ed.selectionStart;
    applying = true;
    ed.value = m.v;
    applying = false;
    ed.selectionStart = ed.selectionEnd = Math.min(pos, m.v.length);
  }
  if (m.t === "status") {
    statusEl.textContent = m.v ?? "";
    statusEl.dataset.kind = m.kind ?? "";
    // ONLY a save clears the dot. "Added"/"Updated" mean the script ran on the
    // chart — nothing was written to the library, so the parent's
    // editorState.dirty stays true. Clearing here hid unsaved edits: the next
    // new/open/hist skipped its discard confirm and threw the buffer away.
    const v = m.v ?? "";
    if (m.kind === "ok" && v.startsWith("Saved")) setDirty(false);
  }
  if (m.t === "name" && m.name) { nameEl.textContent = m.name; document.title = `${m.name} — Pine Editor`; }
  if (m.t === "meta") {
    meta = { name: m.name, dirty: m.dirty, id: m.id, hasId: m.hasId, suggestName: m.suggestName,
      recent: m.recent, all: m.all, versions: m.versions };
    if (m.name) { nameEl.textContent = m.name; document.title = `${m.name} — Pine Editor`; }
    if (typeof m.dirty === "boolean") setDirty(m.dirty);
  }
};

// ── Name dropdown — TV-parity script menu. All actions go through the
// parent via `cmd` messages; `meta` payloads carry the lists. ──
// Every command carries the live buffer so the parent never acts on a stale
// copy (its `pendingValue` lags behind the last `input` message).
// `id` lets a reloaded main window re-attach to the script this window holds.
// Every command is answered with a status; silence means no /vela tab is
// listening (closed, or still loading) — say so instead of doing nothing.
let noReplyTimer: ReturnType<typeof setTimeout> | undefined;
const cmd = (c: string, extra: Record<string, unknown> = {}) => {
  ch.postMessage({ t: "cmd", c, v: ed.value, id: meta?.id, ...extra });
  clearTimeout(noReplyTimer);
  noReplyTimer = setTimeout(() => {
    statusEl.textContent = "主視窗沒有回應 — 請確認 /vela 分頁開著，再按一次";
    statusEl.dataset.kind = "err";
  }, 3000);
};

// Menu rows are real <button>s: Enter/Space fire `click` synchronously, so
// Save/Rename can still call window.prompt inside the user gesture.
const ICON_SAVE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 2.5h8l2.5 2.5v8.5H3z"/><path d="M5.5 2.5v3h5v-3M5.5 13.5v-4h5v4"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';
const ICON_RENAME = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 13.5h11M10 3l2.5 2.5L6 12H3.5V9.5z"/></svg>';
const VERSIONS_SHOWN = 5;
const LIBRARY_SHOWN = 10;
let menuQuery = "";
let allVersions = false;

function closeMenu(): void {
  if (!menuEl.classList.contains("open")) return;
  const hadFocus = menuEl.contains(document.activeElement);
  menuEl.classList.remove("open");
  if (hadFocus) ed.focus();
}
type Tone = "blue" | "teal" | "amber" | "violet";
function row(label: string, key: string | null, fn: () => void, opts: { icon?: string; dot?: boolean; current?: boolean; title?: string; tone?: Tone; cls?: string } = {}): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "m-row" + (opts.current ? " current" : "") + (opts.cls ? ` ${opts.cls}` : "");
  if (opts.tone) b.dataset.tone = opts.tone;
  if (opts.icon) b.insertAdjacentHTML("beforeend", opts.icon);
  if (opts.dot) { const d = document.createElement("span"); d.className = "m-dot"; b.append(d); }
  const l = document.createElement("span");
  l.className = "m-label";
  l.textContent = label;
  b.append(l);
  if (key) { const k = document.createElement("span"); k.className = "k"; k.textContent = key; b.append(k); }
  if (opts.title) b.title = opts.title;
  b.addEventListener("click", () => { closeMenu(); fn(); });
  return b;
}
function head(t: string, tone?: Tone): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "head";
  d.textContent = t;
  if (tone) d.dataset.tone = tone;
  return d;
}
function sep(): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "sep";
  return d;
}
function empty(t: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "m-empty";
  d.textContent = t;
  return d;
}
function confirmDiscard(): boolean {
  return !dirty || window.confirm("Discard unsaved changes?");
}
const relTime = new Intl.RelativeTimeFormat("zh-TW", { numeric: "auto" });
function ago(t: number): string {
  const s = Math.round((t - Date.now()) / 1000);
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60, "second"], [60, "minute"], [24, "hour"], [30, "day"], [12, "month"]];
  let v = s;
  for (const [n, unit] of steps) {
    if (Math.abs(v) < n) return relTime.format(v, unit);
    v = Math.round(v / n);
  }
  return relTime.format(v, "year");
}
function scriptRow(s: { id: string; name: string }, recent = false): HTMLButtonElement {
  const current = s.id === meta?.id;
  return row(s.name, current ? "current" : null, () => { if (confirmDiscard()) cmd("open", { id: s.id }); },
    { dot: true, current, title: s.name, cls: recent ? "recent" : undefined });
}

function renderList(list: HTMLElement): void {
  list.textContent = "";
  const all = meta?.all ?? [];
  const q = menuQuery.trim().toLowerCase();
  if (q) {
    // Searching covers the whole library, not just the rows the menu shows.
    const hits = all.filter((s) => s.name.toLowerCase().includes(q));
    list.append(head(`Scripts · ${hits.length}`, "blue"));
    if (!hits.length) list.append(empty(`No script matches "${menuQuery.trim()}"`));
    for (const s of hits) list.append(scriptRow(s));
    return;
  }
  list.append(
    row("Save script", "Ctrl+S", saveWithName, { icon: ICON_SAVE, tone: "blue" }),
    row("Make a copy…", null, () => cmd("copy"), { icon: ICON_COPY, tone: "teal" }),
    row("Rename…", null, () => {
      const name = window.prompt("Rename script", nameEl.textContent ?? "Untitled script");
      if (name?.trim()) cmd("rename", { name: name.trim() });
    }, { icon: ICON_RENAME, tone: "amber" }),
    head("Create new", "violet"),
  );
  const grid = document.createElement("div");
  grid.className = "m-new";
  for (const [k, label, tone] of [["indicator", "Indicator", "blue"], ["strategy", "Strategy", "amber"], ["library", "Library", "violet"], ["builtin", "Built-in", "teal"]] as const) {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "m-chip";
    c.dataset.tone = tone;
    c.textContent = label;
    c.title = `New ${label.toLowerCase()} script`;
    c.addEventListener("click", () => { closeMenu(); if (confirmDiscard()) cmd("new", { k }); });
    grid.append(c);
  }
  list.append(grid);

  const recent = meta?.recent ?? [];
  if (recent.length) {
    list.append(sep(), head("Recently used", "amber"));
    for (const s of recent) list.append(scriptRow(s, true));
  }
  const rest = all.filter((s) => !recent.some((r) => r.id === s.id));
  if (rest.length) {
    list.append(sep(), head("Library", "blue"));
    for (const s of rest.slice(0, LIBRARY_SHOWN)) list.append(scriptRow(s));
    if (rest.length > LIBRARY_SHOWN) list.append(empty(`+${rest.length - LIBRARY_SHOWN} more — type to search`));
  }

  list.append(sep(), head("Version history", "teal"));
  const vs = meta?.versions ?? [];
  if (!vs.length) list.append(empty("No saved versions yet"));
  for (const [n, v] of (allVersions ? vs : vs.slice(0, VERSIONS_SHOWN)).entries()) {
    list.append(row(`v${v.i + 1}`, ago(v.t), () => { if (confirmDiscard()) cmd("hist", { i: v.i }); },
      { title: new Date(v.t).toLocaleString("zh-TW", { hour12: false }), cls: n === 0 ? "ver latest" : "ver" }));
  }
  if (!allVersions && vs.length > VERSIONS_SHOWN) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "m-row m-more";
    more.textContent = `Show all ${vs.length} versions`;
    // Re-render in place — keeps the menu open, unlike a regular row.
    more.addEventListener("click", () => { allVersions = true; renderList(list); });
    list.append(more);
  }
}

function renderMenu(): void {
  menuEl.textContent = "";
  menuQuery = "";
  allVersions = false;
  const search = document.createElement("div");
  search.className = "m-search";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Search scripts…";
  input.setAttribute("aria-label", "Search scripts");
  search.append(input);
  const list = document.createElement("div");
  list.className = "m-scroll";
  input.addEventListener("input", () => { menuQuery = input.value; renderList(list); });
  input.addEventListener("keydown", (e) => {
    // Enter opens the first hit — straight from the keydown, still a gesture.
    if (e.key === "Enter" && menuQuery.trim()) { e.preventDefault(); list.querySelector<HTMLButtonElement>(".m-row")?.click(); }
  });
  menuEl.append(search, list);
  renderList(list);
}

function openMenu(): void {
  renderMenu();
  menuEl.classList.add("open");
  menuEl.querySelector("input")?.focus();
}
document.getElementById("name")!.addEventListener("click", () => {
  if (menuEl.classList.contains("open")) closeMenu();
  else openMenu();
});
document.addEventListener("mousedown", (e) => {
  // closest(): a press on the label span inside #name must count as #name,
  // or the mousedown closes the menu and the click reopens it.
  const t = e.target as Element | null;
  if (menuEl.classList.contains("open") && !menuEl.contains(t) && !t?.closest?.("#name")) closeMenu();
});
menuEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const stops = [...menuEl.querySelectorAll<HTMLElement>("input, button")];
  const i = stops.indexOf(document.activeElement as HTMLElement);
  const next = stops[(i + (e.key === "ArrowDown" ? 1 : -1) + stops.length) % stops.length];
  if (next) { e.preventDefault(); next.focus(); }
});

// Handshake: ask the parent for the current buffer. Parent re-sends on every
// 'hello', so popup-blocked/reload races resolve themselves.
ch.postMessage({ t: "hello" });
window.addEventListener("beforeunload", () => ch.postMessage({ t: "bye" }));
ed.focus();
