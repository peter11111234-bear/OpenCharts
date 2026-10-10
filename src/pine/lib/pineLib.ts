/**
 * User Pine script library — the localStorage-backed "My scripts" store.
 *
 * TV's Pine Editor treats each script as a first-class object with a name,
 * a current source, and a version stack. This mirrors that model. Scripts
 * here are separate from `src/pine/*.pine` (build-time manifest, read-only);
 * both feed the indicators picker.
 */
export interface PineScriptEntry {
  /** Stable id — 'scr_' + base36 timestamp + rand. */
  id: string;
  /** Display name (TV's script title). */
  name: string;
  /** Current source (matches versions.at(-1).src after every save). */
  source: string;
  createdAt: number;
  updatedAt: number;
  /** Every saved version, oldest → newest. Capped at VERSION_CAP. */
  versions: { t: number; src: string }[];
}

type Doc = { version: 1; scripts: PineScriptEntry[] };

const LIB_KEY = 'opencharts.pine.lib';
const RECENT_KEY = 'opencharts.pine.recent';
const LEGACY_PREFIX = 'pine-hist:';
const VERSION_CAP = 50;
const RECENT_CAP = 8;

const subs = new Set<() => void>();
function emit(): void {
  for (const f of subs) f();
}
export function pineLibSubscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

// Quota/denied writes used to be swallowed silently — a save LOOKED done but
// nothing persisted (the "my scripts vanished" class of bug). The library is
// UI-free, so failures surface through registered handlers (the Pine editor
// routes to ctx.toast AND its statusline; a Set so one open editor can't steal
// the slot from another, and closed editors just no-op). Unsubscribe via the
// returned disposer.
const errorSubs = new Set<(msg: string) => void>();
export function pineLibOnWriteError(fn: (msg: string) => void): () => void {
  errorSubs.add(fn);
  return () => { errorSubs.delete(fn); };
}
function reportWriteError(e: unknown): void {
  const msg = `Script library save failed: ${e instanceof Error ? e.message : String(e)}`;
  for (const f of errorSubs) f(msg);
}

function readDoc(): Doc {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    if (!raw) return { version: 1, scripts: [] };
    const d = JSON.parse(raw) as Doc;
    if (d?.version !== 1 || !Array.isArray(d.scripts)) return { version: 1, scripts: [] };
    return d;
  } catch {
    return { version: 1, scripts: [] };
  }
}
let lastWriteFailed = false;
/** True when the most recent writeDoc hit a quota/denied error — lets callers
 *  (the editor's save path) report failure instead of "Saved". */
export function pineLibWriteFailed(): boolean { return lastWriteFailed; }

function writeDoc(d: Doc): void {
  lastWriteFailed = false;
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(d));
  } catch (e) {
    // quota/denied — the caller's entry is still live in memory for this session
    // but won't survive a reload; say so instead of faking success.
    lastWriteFailed = true;
    reportWriteError(e);
  }
  emit();
}

function uid(): string {
  return 'scr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

export function pineLibList(): PineScriptEntry[] {
  return [...readDoc().scripts].sort((a, b) => b.updatedAt - a.updatedAt);
}
export function pineLibGet(id: string): PineScriptEntry | undefined {
  return readDoc().scripts.find(s => s.id === id);
}
export function pineLibCreate(name: string, source: string): PineScriptEntry {
  const now = Date.now();
  const entry: PineScriptEntry = {
    id: uid(),
    name: name.trim() || 'Untitled script',
    source,
    createdAt: now,
    updatedAt: now,
    versions: [{ t: now, src: source }],
  };
  const d = readDoc();
  d.scripts.push(entry);
  writeDoc(d);
  pineLibRecentPush(entry.id);
  return entry;
}
export function pineLibSave(id: string, source: string): PineScriptEntry {
  const d = readDoc();
  const e = d.scripts.find(s => s.id === id);
  if (!e) throw new Error(`pineLib: script not found: ${id}`);
  if (e.source === source) { lastWriteFailed = false; return e; } // no-op save — clear stale flag
  e.source = source;
  e.updatedAt = Date.now();
  e.versions.push({ t: e.updatedAt, src: source });
  while (e.versions.length > VERSION_CAP) e.versions.shift();
  writeDoc(d);
  pineLibRecentPush(id);
  return e;
}
export function pineLibRename(id: string, name: string): PineScriptEntry {
  const d = readDoc();
  const e = d.scripts.find(s => s.id === id);
  if (!e) throw new Error(`pineLib: script not found: ${id}`);
  e.name = name.trim() || e.name;
  e.updatedAt = Date.now();
  writeDoc(d);
  return e;
}
export function pineLibDuplicate(id: string): PineScriptEntry {
  const src = pineLibGet(id);
  if (!src) throw new Error(`pineLib: script not found: ${id}`);
  return pineLibCreate(`Copy of ${src.name}`, src.source);
}
export function pineLibRemove(id: string): void {
  const d = readDoc();
  d.scripts = d.scripts.filter(s => s.id !== id);
  writeDoc(d);
  const r = pineLibRecent().filter(x => x !== id);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(r)); } catch { /* quota */ }
}
export function pineLibRecentPush(id: string): void {
  const cur = pineLibRecent().filter(x => x !== id);
  cur.unshift(id);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, RECENT_CAP))); } catch { /* quota */ }
}
export function pineLibRecent(): string[] {
  try {
    const r = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/**
 * One-shot migration from the legacy `pine-hist:{title}` → [{t,src}] format.
 * Idempotent: skips entries whose latest src already exists in the library.
 * Returns number of scripts migrated.
 */
export function pineLibMigrateLegacyHist(): number {
  const doc = readDoc();
  const legacyKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(LEGACY_PREFIX)) legacyKeys.push(k);
  }
  let added = 0;
  for (const k of legacyKeys) {
    let entries: { t: number; src: string }[];
    try {
      const parsed = JSON.parse(localStorage.getItem(k) || '[]');
      if (!Array.isArray(parsed)) continue;
      entries = parsed;
    } catch {
      continue;
    }
    if (entries.length === 0) continue;
    const lastSrc = entries[entries.length - 1]!.src;
    if (doc.scripts.some(s => s.source === lastSrc)) continue;
    // old key was encodeURIComponent(title); decode back to the real name.
    let name = 'Imported script';
    try { name = decodeURIComponent(k.slice(LEGACY_PREFIX.length)) || name; } catch { /* malformed % */ }
    doc.scripts.push({
      id: uid(),
      name,
      source: lastSrc,
      createdAt: entries[0]!.t,
      updatedAt: entries[entries.length - 1]!.t,
      versions: entries.slice(-VERSION_CAP),
    });
    added++;
  }
  if (added) writeDoc(doc);
  return added;
}
