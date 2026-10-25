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
let meta: { name?: string; dirty?: boolean; hasId?: boolean; suggestName?: string; recent?: {id:string;name:string}[]; all?: {id:string;name:string}[]; versions?: {i:number;t:number}[] } | null = null;

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
  ch.postMessage({ t: "cmd", c: "save", v: ed.value, ...(name !== undefined ? { name } : {}) });
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
    hasId?: boolean; suggestName?: string;
    recent?: {id:string;name:string}[]; all?: {id:string;name:string}[]; versions?: {i:number;t:number}[] };
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
    // Parent says `Saved "<name>"` on first save and `Saved` afterwards; both
    // mean the buffer is persisted. Previously only the exact string "Saved"
    // matched, so the dot stayed lit after a first-time save.
    const v = m.v ?? "";
    if (m.kind === "ok" && (v.startsWith("Saved") || v.startsWith("Added") || v.startsWith("Updated"))) setDirty(false);
  }
  if (m.t === "name" && m.name) { nameEl.textContent = m.name; document.title = `${m.name} — Pine Editor`; }
  if (m.t === "meta") {
    meta = { name: m.name, dirty: m.dirty, hasId: m.hasId, suggestName: m.suggestName,
      recent: m.recent, all: m.all, versions: m.versions };
    if (m.name) { nameEl.textContent = m.name; document.title = `${m.name} — Pine Editor`; }
    if (typeof m.dirty === "boolean") setDirty(m.dirty);
  }
};

// ── Name dropdown — TV-parity script menu. All actions go through the
// parent via `cmd` messages; `meta` payloads carry the lists. ──
// Every command carries the live buffer so the parent never acts on a stale
// copy (its `pendingValue` lags behind the last `input` message).
const cmd = (c: string, extra: Record<string, unknown> = {}) =>
  ch.postMessage({ t: "cmd", c, v: ed.value, ...extra });

function closeMenu(): void { menuEl.classList.remove("open"); }
function item(label: string, key: string | null, fn: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  const l = document.createElement("span");
  l.textContent = label;
  b.append(l);
  if (key) { const k = document.createElement("span"); k.className = "k"; k.textContent = key; b.append(k); }
  b.addEventListener("click", () => { closeMenu(); fn(); });
  return b;
}
function head(t: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "head";
  d.textContent = t;
  return d;
}
function sep(): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "sep";
  return d;
}
function confirmDiscard(): boolean {
  return !dirty || window.confirm("Discard unsaved changes?");
}

function renderMenu(): void {
  menuEl.textContent = "";
  menuEl.append(
    item("Save script", "Ctrl+S", saveWithName),
    item("Make a copy…", null, () => cmd("copy")),
    item("Rename…", null, () => {
      const name = window.prompt("Rename script", nameEl.textContent ?? "Untitled script");
      if (name?.trim()) cmd("rename", { name: name.trim() });
    }),
    sep(),
    head("Version history"),
  );
  const vs = meta?.versions ?? [];
  if (!vs.length) menuEl.append(item("(no saved versions)", null, () => {}));
  for (const v of vs.slice(0, 10)) {
    const d = new Date(v.t);
    menuEl.append(item(`v${v.i + 1} — ${d.toLocaleString("zh-TW", { hour12: false })}`, null,
      () => { if (confirmDiscard()) cmd("hist", { i: v.i }); }));
  }
  menuEl.append(sep(), head("Create new"));
  for (const [k, label] of [["indicator", "Indicator"], ["strategy", "Strategy"], ["library", "Library"], ["builtin", "Built-in"]] as const) {
    menuEl.append(item(label, "new", () => { if (confirmDiscard()) cmd("new", { k }); }));
  }
  const recent = meta?.recent ?? [];
  if (recent.length) {
    menuEl.append(sep(), head("Recently used"));
    for (const s of recent) {
      menuEl.append(item(s.name, null, () => { if (confirmDiscard()) cmd("open", { id: s.id }); }));
    }
  }
  const rest = (meta?.all ?? []).filter((s) => !recent.some((r) => r.id === s.id)).slice(0, 10);
  if (rest.length) {
    menuEl.append(sep(), head("Library"));
    for (const s of rest) {
      menuEl.append(item(s.name, null, () => { if (confirmDiscard()) cmd("open", { id: s.id }); }));
    }
  }
}

document.getElementById("name")!.addEventListener("click", () => {
  if (menuEl.classList.contains("open")) closeMenu();
  else { renderMenu(); menuEl.classList.add("open"); }
});
document.addEventListener("mousedown", (e) => {
  if (menuEl.classList.contains("open") && !menuEl.contains(e.target as Node) && e.target !== document.getElementById("name")) closeMenu();
});

// Handshake: ask the parent for the current buffer. Parent re-sends on every
// 'hello', so popup-blocked/reload races resolve themselves.
ch.postMessage({ t: "hello" });
window.addEventListener("beforeunload", () => ch.postMessage({ t: "bye" }));
ed.focus();
