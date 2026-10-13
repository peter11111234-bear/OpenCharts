// ── Built-model cache (IndexedDB) ────────────────────────────────────────────
// Re-running a heavy Pine script on every page restore is the dominant first-
// paint cost (見高K ~16ms/bar × the loaded window, × every indicator). The
// built IndicatorModel is plain JSON, and `modelId` is already a source
// content hash, so a (modelId, symbol, tf, inputs, bar-window) key is exact:
// any edit, symbol/timeframe change, input change, or new bar misses the cache.
//
// No-op when IndexedDB is unavailable (SSR/jsdom/node tests).

const DB_NAME = 'opencharts-pine-model';
const STORE = 'models';
const MAX_ENTRIES = 24;

type CacheRow = { key: string; at: number; model: unknown };

let dbP: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbP;
}

/** Read a cached model, or null on miss/unavailable storage. */
export async function modelCacheGet(key: string): Promise<unknown | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(key);
      rq.onsuccess = () => resolve((rq.result as CacheRow | undefined)?.model ?? null);
      rq.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Store a model and evict the oldest rows past MAX_ENTRIES. */
export async function modelCachePut(key: string, model: unknown): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key, at: Date.now(), model } satisfies CacheRow);
    tx.oncomplete = () => { void prune(d); };
  } catch { /* quota / private mode — cache is best-effort */ }
}

async function prune(d: IDBDatabase): Promise<void> {
  try {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const keys: { key: string; at: number }[] = [];
    const rq = store.openCursor();
    rq.onsuccess = () => {
      const cur = rq.result;
      if (cur) { keys.push({ key: (cur.value as CacheRow).key, at: (cur.value as CacheRow).at }); cur.continue(); return; }
      if (keys.length <= MAX_ENTRIES) return;
      keys.sort((a, b) => a.at - b.at);
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) store.delete(k.key);
    };
  } catch { /* best-effort */ }
}

/** Test/harness hook — drop the cached connection so a fresh DB can open. */
export function __resetModelCache(): void { dbP = null; }
