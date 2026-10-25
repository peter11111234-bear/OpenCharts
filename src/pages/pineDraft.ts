/**
 * Session draft for the docked Pine editor. The editor mirrors its live buffer
 * here so an F5 reload brings unsaved text back. Kept free of DOM and editor
 * state so the read, write and restore rules can be unit-tested directly.
 */

export const PINE_DRAFT_KEY = "opencharts.pine.draft";

export interface PineDraft {
  id: string | null;
  src: string;
}

/** Store the draft. A failing store (quota, disabled storage) is ignored: the
 *  draft is a convenience, the editor keeps working without it. */
export function writePineDraft(store: Storage, draft: PineDraft): void {
  try { store.setItem(PINE_DRAFT_KEY, JSON.stringify(draft)); } catch { /* quota or disabled */ }
}

/**
 * Debounced draft writer: keystrokes call `schedule()`, and the write happens
 * once typing pauses for `delayMs`. `flush()` writes now and is what the unload
 * handler calls, so the last keystrokes are never lost. A `read()` that throws
 * (editor already torn down) is ignored rather than surfacing as an error.
 */
export function createDraftWriter(
  store: Storage,
  read: () => PineDraft,
  delayMs = 500,
): { schedule: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    try { writePineDraft(store, read()); } catch { /* buffer unreadable mid-teardown */ }
  };
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };
  return { schedule, flush };
}

/** Read the draft back, or null when it is missing or malformed. */
export function readPineDraft(store: Storage): PineDraft | null {
  try {
    const v = JSON.parse(store.getItem(PINE_DRAFT_KEY) || "null") as Partial<PineDraft> | null;
    if (!v || typeof v.src !== "string") return null;
    return { id: typeof v.id === "string" ? v.id : null, src: v.src };
  } catch {
    return null;
  }
}

/**
 * Decide whether a draft replaces the buffer at mount.
 * - No script open (currentId null): restore the text, and adopt the draft's
 *   script id only if that script still exists in the library.
 * - A script is open and the draft belongs to it: restore its unsaved text.
 * - Otherwise (a different script is open): leave the library text alone.
 */
export function draftRestore(
  draft: PineDraft | null,
  currentId: string | null,
  hasLibraryEntry: (id: string) => boolean,
): { src: string; id: string | null } | null {
  if (!draft) return null;
  if (!currentId) {
    return { src: draft.src, id: draft.id !== null && hasLibraryEntry(draft.id) ? draft.id : null };
  }
  if (draft.id === currentId) return { src: draft.src, id: currentId };
  return null;
}
