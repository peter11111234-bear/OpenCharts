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
  registerWidgetAttachment,
  registerSidePanel,
  registerStatePersistence,
  registerLegendAction,
  registerIcon,
  type CellStateContext,
  type InputValue,
  type SidePanelHeader,
  type WidgetContext,
} from "@luxalgo/vela/plugin";
// `svg16` is a pure helper (builds markup), but it lives only in /ui — the
// registry itself is chunk-BZQM2XO7.js, shared via plugin's re-export.
// IndicatorHandle only re-exports from the root barrel; a type-only import is
// erased at compile time, so this cannot duplicate the contribution registry.
import type { IndicatorHandle, SerializedDrawing } from "@luxalgo/vela";
import { svg16 } from "@luxalgo/vela/ui";
import type { WorkspaceWidgetContext } from "@luxalgo/vela/workspace";
import {
  pineLibCreate, pineLibGet, pineLibList, pineLibSave, pineLibRename,
  pineLibDuplicate, pineLibRecent, pineLibRecentPush, pineLibOnWriteError,
  pineLibWriteFailed,
  pineLibMigrateLegacyHist, pineLibSubscribe,
} from "../pine/lib/pineLib.ts";
import { openScriptsDialog } from "./velaPineScriptsDialog.ts";
import { combinedManifestEntries } from "../pineScripts.ts";
import type { PineEditorHandle, PineLintError } from "../pine/pineMonaco.ts";

// ── Panel styles ── the vela-pine-* classes are ours; nothing ships them.
// The editor lives in a shell side PANEL (TV parity: right-dock, not a modal) —
// the shell owns the chrome (header row, close button, dock exclusivity,
// persisted width). `.vela-pine-dialog` is just our body container now.
const PINE_CSS = `
.vela-pine-dialog{display:flex;flex-direction:column;height:100%;background:var(--vela-bg,#1e222d);color:var(--vela-fg,#d1d4dc);font:13px/1.4 sans-serif;overflow:hidden}
.vela-pine-headbar{display:flex;align-items:center;gap:4px;padding:2px 4px;overflow-x:auto;white-space:nowrap}
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
.vela-pine-edhost{flex:1;min-height:0;background:#161a24;overflow:hidden}
.vela-pine-edhost .vela-pine-area{width:100%;height:100%;overflow:auto;resize:none;background:#161a24;color:#d5d8e0;border:0;padding:10px 14px;font:13px/1.55 ui-monospace,Consolas,monospace;white-space:pre;outline:none}
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
.vela-objtree{display:flex;flex-direction:column;height:100%;overflow:auto;background:var(--vela-bg,#1e222d);color:var(--vela-fg,#d1d4dc);font:12px/1.5 sans-serif;padding:4px 0}
.vela-objtree-group{color:#787b86;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:8px 12px 3px}
.vela-objtree-row{display:flex;align-items:center;gap:6px;padding:4px 8px;margin:0 4px;border-radius:4px;cursor:pointer}
.vela-objtree-row:hover{background:#2a2e39}
.vela-objtree-row.off .vela-objtree-name{color:#5d606b}
.vela-objtree-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vela-objtree-id{color:#565a68;font-size:10px}
.vela-objtree-btn{display:flex;align-items:center;background:none;border:0;color:#8b8f9c;cursor:pointer;padding:2px 3px;border-radius:3px;line-height:1}
.vela-objtree-btn:hover{color:#fff;background:#363c4e}
.vela-objtree-empty{color:#565a68;padding:4px 12px;font-size:11px}
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
 *
 * pendingAdds: entries an in-flight restore asked for that aren't in
 * indicators() yet. serializeCellScripts merges them so a persist landing
 * mid-restore (state:changed fires per addIndicator) doesn't overwrite ext with
 * a truncated list — the real "indicators vanished" path. Entries expire so a
 * failed/removed add can't resurrect.
 */
type SavedScript = { name: string; script: string; id?: string; hidden?: boolean; inputs?: Record<string, string | number | boolean>;
  // 'external' = the user added this script to the chart directly (chart.runIndicator /
  // addIndicator), NOT seeded from the manifest ledger. Old blobs have no origin and
  // fall through to the legacy manifest-text dedup; entries stamped 'external' bypass it,
  // so a user-pasted copy of a manifest script round-trips instead of silently dropping.
  origin?: 'external' };

const PENDING_MS = 30_000;
// pendingAdds stamps use a MONOTONIC clock (performance.now, not Date.now): a wall-clock
// NTP step mid-restore could prune live entries or resurrect expired ones — the 30s TTL
// must measure elapsed time, not wall time.
const pendingAdds = new Map<string, { at: number; entry: SavedScript }[]>();
// inFlightAdds: claim key cellId+'|'+normScript(script)+'|'+id+'|'+inputsSig — a
// second restore firing before the first's addIndicator lands has no handle to
// claim (preexisting snapshot is stale, e.id live-check misses). id+inputs in the
// key keep N deliberately-identical-script copies distinct; within ONE restore,
// per-call localClaims does the same dedup instead. Released when the pending
// entry leaves pendingAdds (covered, expired, or swept) — never on a twin whose
// entry is still pending. Cleared on bind/unbind (new ws = fresh claims).
const inFlightAdds = new Set<string>();
function inputsSig(inputs: Record<string, string | number | boolean> | undefined): string {
  return inputs ? Object.keys(inputs).sort().map((k) => k + '=' + String(inputs[k])).join(';') : '';
}
function inFlightKey(cellId: string, e: { script?: string; id?: string; inputs?: Record<string, string | number | boolean> }): string {
  return cellId + '|' + normScript(e.script) + '|' + (e.id ?? '') + '|' + inputsSig(e.inputs);
}
// Drops the claim only when no still-pending entry shares the key — twin entries
// (identical script+id+inputs in the same restore) share one claim.
function releaseClaim(cellId: string, e: { script?: string; id?: string; inputs?: Record<string, string | number | boolean> }, remaining: { entry: SavedScript }[]): void {
  const key = inFlightKey(cellId, e);
  if (!remaining.some((p) => inFlightKey(cellId, p.entry) === key)) inFlightAdds.delete(key);
}
// and exposes no cell accessor, so VelaPage binds the ws it built. window.__vela
// stays a debug handle only. Rebind (StrictMode remount, new ws instance)
// clears pendingAdds AND inFlightAdds: pending entries gate serialize merge,
// claims gate restore dedup — both would bleed stale state into a different
// workspace otherwise.
let workspaceRef: { cell(id: string): { instances?: { id?: string; external?: boolean; handle?: { id: string } | null }[] } | undefined } | null = null;
// Handles without an instance row (chart.runIndicator bypasses the cell ledger)
// are external by construction — shared by serialize filter and restore dedup.
function isExternalHandle(cellId: string, handleId: string): boolean {
  const inst = workspaceRef?.cell(cellId)?.instances?.find((i) => (i.handle?.id ?? i.id) === handleId);
  return !inst || inst.external === true;
}
export function bindVelaWorkspace(ws: NonNullable<typeof workspaceRef>): void {
  workspaceRef = ws;
  pendingAdds.clear();
  inFlightAdds.clear();
}
export function unbindVelaWorkspace(ws: unknown): void {
  if (workspaceRef === ws) {
    workspaceRef = null;
    pendingAdds.clear();
    inFlightAdds.clear();
  }
}

export function serializeCellScripts(ctx: CellStateContext): SavedScript[] | undefined {
  const out: SavedScript[] = [];
  // Only EXTERNAL indicators belong in ext — vela's own ledger persists manifest
  // (picker-added) indicators by name, so serializing them here re-adds a second
  // copy every restore (the compounding EMA20×N bug).
  const isExternal = (handleId: string): boolean => isExternalHandle(ctx.cellId, handleId);
  for (const handle of ctx.chart.indicators()) {
    if (!handle.source) continue; // native (core) indicator — not ours
    if (!isExternal(handle.id)) continue; // ledger-owned — vela persists it by name
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
      origin: 'external',
    });
  }
  // Sweep dead cellIds: an entry can't outlive PENDING_MS even if its cell
  // died before ever serializing again (persistence has no destroy hook —
  // dehydrate IS the last call, so this is the only prune path left).
  const nowSweep = performance.now();
  for (const [cid, arr] of pendingAdds) {
    const kept = arr.filter((p) => nowSweep - p.at < PENDING_MS);
    // Expired entries release their claim too — a dropped pending entry whose
    // claim outlived it would permanently skip re-restore of the same script.
    for (const p of arr) if (!kept.includes(p)) releaseClaim(cid, p.entry, kept);
    if (kept.length) pendingAdds.set(cid, kept); else pendingAdds.delete(cid);
  }
  // Merge entries a restore asked for that haven't become live yet — without
  // this a mid-restore persist would persist a PARTIAL list and the missing
  // entries would be lost if the tab closes before the next write.
  const pend = pendingAdds.get(ctx.cellId);
  if (pend?.length) {
    const now = performance.now();
    // Drop an entry the FIRST time it's live-covered (the live loop above
    // already wrote it) or once it expires (add failed / user removed it
    // before it landed) — a removed indicator can't resurrect, and id-less
    // entries can't double-merge while their row is live.
    // A pending entry is covered ONLY by an EXTERNAL live handle — a
    // ledger-seeded row with matching source must NOT claim it (the ledger
    // owns that row; our pending external is a separate user add), and one
    // live handle can only cover ONE pending copy: consume matches per
    // handle so N pending identical entries need N live externals, else a
    // persist after the first lands would drop the rest (data loss).
    const live = ctx.chart.indicators().filter((h) => isExternal(h.id));
    const consumed = new Set<string>();
    const still = pend.filter((p) => {
      const covered = live.some((h) => {
        if (consumed.has(h.id)) return false;
        const match =
          (p.entry.id && h.id === p.entry.id) ||
          (normScript(h.source) === normScript(p.entry.script) && inputsMatch(h, p.entry.inputs));
        if (match) consumed.add(h.id);
        return match;
      });
      return !covered && now - p.at < PENDING_MS;
    });
    for (const p of pend) if (!still.includes(p)) releaseClaim(ctx.cellId, p.entry, still);
    for (const p of still) out.push(p.entry);
    if (still.length) pendingAdds.set(ctx.cellId, still);
    else pendingAdds.delete(ctx.cellId);
  }
  return out.length ? out : undefined;
}

/** Script-text compare needs BOM + EOL normalization: engine.prepare strips
 *  BOM but keeps line endings, while manifest entries carry the verbatim file
 *  bytes — a BOM'd/CRLF script on one side and LF-only on the other would
 *  silently miss the ledger dedup and re-add a ledger-owned row as external. */
export function normScript(s: string | undefined): string {
  return (s ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

/** Overrides stored against an entry equal the live handle's? An entry with no
 *  inputs (all defaults) matches a handle whose current values are all defval —
 *  the same comparison serialize ran. */
function inputsMatch(handle: IndicatorHandle, inputs: Record<string, string | number | boolean> | undefined): boolean {
  const cur = handle.inputValues();
  const defaults: Record<string, string | number | boolean> = {};
  for (const s of handle.inputs) defaults[s.key] = s.defval;
  const overrides = inputs ?? {};
  for (const [k, v] of Object.entries(overrides)) if (cur[k] !== v) return false;
  // A stored entry must ALSO not claim a handle carrying overrides the entry
  // lacks — e.g. ledger-restored EMA20(length=50) is not "the same indicator"
  // as ext EMA20(defaults).
  for (const k of Object.keys(cur)) {
    if (!(k in overrides) && cur[k] !== defaults[k]) return false;
  }
  return true;
}

export function restoreCellScripts(payload: unknown, ctx: CellStateContext): void {
  if (!Array.isArray(payload)) return;
  // Claimable pool = handles live BEFORE this restore ran. Snapshot once:
  // indicators THIS restore adds must not satisfy later entries — otherwise
  // two deliberately-identical externals collapse (the second claims the
  // first's just-added row). Ledger-owned indicators are never serialized into
  // ext anymore (serialize checks instance.external), so identical-source
  // matches here are genuine duplicates the user added by hand.
  const preexisting = ctx.chart.indicators().filter((h) => h.source);
  const claimed = new Set<string>();
  // Legacy pollution: blobs written before instance.external was serialized
  // carried ledger-owned (manifest-seeded) indicators inside ext. Restoring
  // them via addIndicator flags a parallel copy that self-perpetuates — the
  // ledger re-adds its own seeded instance too (one duplicate per boot,
  // compounding). Two dedup paths share the work: the ledger may already be
  // converged at restore (docs say it runs after) → live-handle `hit` claims
  // matching rows; instances can also still be pending (manifest unresolved)
  // → script-text match against the manifest catches what the live list
  // can't see yet. Both sides normalize EOL/BOM (normScript) because engine
  // storage strips BOM but manifest entries carry verbatim file bytes.
  const ledgerScripts = new Set(
    combinedManifestEntries()
      .map((e) => normScript(e.script))
      .filter((s): s is string => typeof s === "string"),
  );
  // Per-call staging — claims land in inFlightAdds only AFTER the loop, so N
  // deliberately-identical entries in ONE payload all get added (each claims
  // its own live row later); a SECOND restore call still finds them claimed.
  const newClaims = new Set<string>();
  // origin:'external' entries may only be claimed by EXTERNAL live handles —
  // a ledger-owned row with matching source+inputs owns itself (the ledger
  // re-adds it); letting it claim our entry silently drops the user's add.
  const externalOnly = preexisting.filter((h) => isExternalHandle(ctx.cellId, h.id));
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Partial<SavedScript>;
    if (typeof e.name !== "string" || typeof e.script !== "string") continue;
    const flightKey = inFlightKey(ctx.cellId, e);
    // Double-restore (handles still in-flight): a second restore before the first's
    // addIndicator lands has no handle to claim — inFlightAdds is the only dedup.
    if (inFlightAdds.has(flightKey)) continue;
    // Idempotence: a restore firing twice (StrictMode remount) finds the entry's
    // own id already live → that one is ours, skip without consuming a claim.
    if (e.id && ctx.chart.indicators().some((h) => h.id === e.id)) continue;
    // A live handle with identical source AND inputs claims this entry —
    // covers duplicate ext entries and ledger-vs-ext overlap in old blobs.
    const pool = e.origin === 'external' ? externalOnly : preexisting;
    const hit = pool.find((h) => normScript(h.source) === normScript(e.script) && !claimed.has(h.id) && inputsMatch(h, e.inputs));
    if (hit) { claimed.add(hit.id); continue; }
    // Legacy blobs (no origin) keep the manifest-text skip. origin:'external' was
    // stamped only for user-added scripts (never ledger-seeded), so it safely
    // bypasses — a hand-pasted copy of a manifest script stays external.
    if (e.origin !== 'external' && ledgerScripts.has(normScript(e.script))) continue;
    try {
      ctx.addIndicator({
        name: e.name,
        script: e.script,
        id: e.id,
        language: "pine",
        hidden: e.hidden,
        inputs: e.inputs,
      });
      newClaims.add(flightKey);
      // Track until the handle is live+serialized once — a persist between now
      // and then would otherwise drop this entry from ext. origin passes through
      // (legacy entries keep no-origin until they serialize live and get stamped).
      const list = pendingAdds.get(ctx.cellId) ?? [];
      list.push({ at: performance.now(), entry: { name: e.name, script: e.script, id: e.id, hidden: e.hidden, inputs: e.inputs, origin: e.origin } });
      pendingAdds.set(ctx.cellId, list);
    } catch {
      // engine not ready or duplicate id — skip silently
    }
  }
  for (const k of newClaims) inFlightAdds.add(k);
}

registerStatePersistence({
  key: "opencharts.pine-scripts",
  scope: "cell",
  serialize: serializeCellScripts,
  restore: restoreCellScripts,
});

/**
 * Pine engine registration — worker-backed (`PineWorkerEngine`, src/pine/):
 * runScript executes in a dedicated module Worker so heavy scripts don't
 * block the UI; falls back to in-process `PineInterpreterEngine` semantics
 * when Worker is unavailable. BOM strip lives in the base `prepare`; this
 * alias exists so VelaPage can register it without importing src/pine directly.
 */
export { PineWorkerEngine as InterpreterPineEngine } from '../pine/pineWorkerEngine.ts';


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
registerIcon("objtree", svg16('<path d="M2.5 3.5h4M4 3.5v7a2 2 0 0 0 2 2h5"/><circle cx="9" cy="3.5" r="1.5"/><circle cx="13.5" cy="12.5" r="1.5"/>'));
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
let addingToLayout = false; // in-flight '增加到整個版面' run → ignore double-clicks
document.addEventListener('pointerdown', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);

/** Toast that tolerates a missing/failing toast impl — ctx.toast is optional
 *  and a handful of call sites all need the same swallow-on-throw behavior. */
function toast(ctx: WidgetContext, msg: string, kind?: 'info' | 'success' | 'error'): void {
  try { ctx.toast?.(msg, kind); } catch { /* no toast */ }
}

/** Workspace cells when ctx is the WorkspaceWidgetContext (legend actions get
 *  it at runtime); [] on a plain chart context — callers no-op benignly. */
function workspaceCells(ctx: WidgetContext): WorkspaceWidgetContext['cells'] {
  return (ctx as unknown as WorkspaceWidgetContext).cells ?? [];
}

function closeMoreMenu(): void {
  openMoreMenuEl?.remove();
  openMoreMenuEl = null;
}


/**
 * Resolve the chart that actually owns a clicked legend row. `ctx.chart` is the
 * ambient ACTIVE cell's chart, but the row lives on whichever cell rendered it —
 * and indicator ids are shared across cells (restored/parked scripts reuse
 * `entry.id`), so `ctx.chart.indicators().find(h => h.id === ind.id)` can hit the
 * wrong chart. ChartCell's DOM host isn't on the typed `ctx.cells` entries, so
 * the opener cell is recovered by hit-testing a pointer snapshot against
 * `.vela-cell[data-cell-id]` elements (the only per-cell DOM marker vela emits).
 * `point` is the pointer position captured when the ⋯ menu OPENED — not the
 * later menu-item click (the menu is body-mounted and may overlap another
 * cell, so live `lastPointer` resolves the wrong owner; keyboard-triggered
 * runs may have no pointer at all).
 */
function chartForIndicator(ctx: WidgetContext, ind: { id: string }, point: { x: number; y: number }): WidgetContext['chart'] {
  const cells = workspaceCells(ctx);
  // indicators() throws on a disposed cell — exclude it, don't blow up the menu.
  const owners = cells.filter(c => {
    try { return c.chart.indicators().some(h => h.id === ind.id); }
    catch { return false; }
  });
  if (owners.length === 1) return owners[0]!.chart;
  if (owners.length > 1 && (point.x > 0 || point.y > 0)) {
    const el = ctx.host.ownerDocument.elementFromPoint(point.x, point.y);
    const cellId = el?.closest<HTMLElement>('.vela-cell')?.dataset.cellId;
    const hit = cellId ? owners.find(c => c.id === cellId) : undefined;
    if (hit) return hit.chart;
  }
  return ctx.chart;
}

function toggleMoreMenu(ctx: WidgetContext, ind: { id: string; title: string; source?: string }): void {
  if (openMoreMenuEl) { closeMoreMenu(); return; }
  // Snapshot the pointer NOW, at menu-open time — by the time a menu item is
  // clicked, lastPointer holds the item's coords (menu is body-mounted and
  // may overlap another cell). Real-mouse flow already works because the ⋯
  // click activates the row's cell first; this covers stale-active /
  // keyboard / synthetic-click paths.
  const openPoint = { x: lastPointer.x, y: lastPointer.y };
  const doc = ctx.host.ownerDocument;

  type Item = { label: string; disabled?: boolean; primary?: boolean; sep?: boolean; sub?: (anchorBtn: HTMLElement) => void; run?: () => void };
  const isPine = typeof ind.source === 'string' && ind.source.length > 0;
  const items: Item[] = [
    { label: `為 ${ind.title} 新增快訊…`, disabled: true },
    { label: `在 ${ind.title} 上增加指標/策略…`, disabled: true },
    { label: '將此指標增加到整個版面', run: () => {
        if (addingToLayout) { toast(ctx, '處理中'); return; }
        addingToLayout = true;
        void (async () => {
          const srcChart = chartForIndicator(ctx, ind, openPoint);
          const h = srcChart.indicators().find(x => x.id === ind.id);
          if (!h?.source) return;
          let inputs: Record<string, InputValue> | undefined;
          try { inputs = h.inputValues(); } catch { /* unreadable → declaration defaults */ }
          const cells = workspaceCells(ctx);
          let added = 0;
          let timedOut = 0;
          for (const cell of cells) {
            if (cell.chart === srcChart) continue;
            try {
              if (cell.chart.indicators().some(x => normScript(x.source) === normScript(h.source))) continue; // disposed cell → throws inside try
              // A dead feed can leave runIndicator unsettled — cap the wait so
              // one wedged cell can't stall the loop (and pin addingToLayout).
              const p = cell.chart.runIndicator(h.source!, { language: 'pine', title: h.title, inputs });
              void p.catch(() => {}); // swallow late rejection — race below owns the verdict
              const r = await Promise.race([
                p,
                new Promise<null>(resolve => setTimeout(() => resolve(null), 15000)),
              ]);
              if (r === null) timedOut++;
              else if (r.ok) added++;
            } catch { /* one bad cell must not block the rest */ }
          }
            const msg = timedOut > 0
              ? (added > 0 ? `已加入 ${added} 個圖表，${timedOut} 個逾時` : `${timedOut} 個圖表加入逾時，可能仍在加入中`)
              : (added > 0 ? `已加入 ${added} 個圖表` : '其他圖表已有此指標或無可用圖表');
            toast(ctx, msg);
        })().finally(() => { addingToLayout = false; });
      } },
    { label: favsRead().includes(ind.id) ? '★ 從收藏夾移除' : '☆ 將此指標新增至收藏夾', run: () => toggleIndicatorFav(ind.id) },
    { label: '', sep: true },
    { label: '視覺順序', disabled: true },
    { label: '時間週期的可見性', disabled: true },
    { label: '移動到 ▸', sub: (btn) => openMoveSubMenu(btn) },
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
            if (p) void p.then(() => toast(ctx, '已複製', 'success'), () => toast(ctx, '複製失敗', 'error'));
          } }
      : { label: '複製（內建指標無來源）', disabled: true },
    { label: '隱藏', run: () => { chartForIndicator(ctx, ind, openPoint).indicators().find(x => x.id === ind.id)?.setVisible(false); } },
    { label: '移除', run: () => { chartForIndicator(ctx, ind, openPoint).indicators().find(x => x.id === ind.id)?.remove(); } },
    { label: '', sep: true },
    { label: '物件樹', run: () => {
        // Stash the row's owning chart — the panel's mount ctx is the ACTIVE
        // cell, but the ⋯ row can live on another cell's legend.
        objTreeChart = chartForIndicator(ctx, ind, openPoint);
        ctx.togglePanel?.(OBJTREE_PANEL_ID, true);
      } },
    { label: '', sep: true },
    { label: '設定…', run: () => {
        const renderer = chartForIndicator(ctx, ind, openPoint).renderer;
        if (renderer.supportsIndicatorSettings) renderer.openIndicatorSettings(ind.id);
        else toast(ctx, '設定功能尚未支援');
      } },
  ];

  const menu = doc.createElement('div');
  menu.style.cssText =
    'position:fixed;z-index:10001;min-width:220px;padding:4px;background:#1e222d;' +
    'border:1px solid #363c4e;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.5);' +
    'font:12px/1.5 -apple-system,"Segoe UI",sans-serif;color:#d5d8e0;user-select:none;';

  // ── '移動到 ▸' second-level menu ── appended INSIDE `menu` so the same
  // dismiss machinery covers it: menu.contains() sees submenu clicks, and
  // closeMoreMenu() removes the whole subtree. Anchors to the right of the
  // parent item's rect; flips left when it would clip the viewport edge.
  let subMenuEl: HTMLElement | null = null;
  const closeSubMenu = () => { subMenuEl?.remove(); subMenuEl = null; };

  function openMoveSubMenu(anchorBtn: HTMLElement): void {
    closeSubMenu();
    const chart = chartForIndicator(ctx, ind, openPoint);
    const handle = chart.indicators().find(x => x.id === ind.id);
    if (!handle?.moveTo) return;
    const h = handle;
    // PaneInfo carries no title — Pane.id is an engine id, not display text.
    // Label a study pane by its first indicator's title, else its order.
    // (PaneInfo isn't re-exported by the package — declare the consumed shape.)
    type PaneRow = { id: string; kind: 'price' | 'study'; order: number; indicators: readonly { id: string; title: string }[] };
    let panes: PaneRow[] = [];
    try { panes = chart.panes.list(); } catch { /* renderer without pane mgmt */ }
    const cur = panes.find(p => p.indicators.some(x => x.id === ind.id));
    type Entry = { label: string; current?: boolean; run?: () => void };
    const entries: Entry[] = [
      { label: '價格窗格', current: cur?.kind === 'price', run: () => h.moveTo('price') },
      { label: '新窗格', run: () => h.moveTo({ newPane: true }) },
      ...panes.filter(p => p.kind !== 'price').map(p => ({
        label: p.indicators[0]?.title ?? `窗格 ${p.order}`,
        current: cur?.id === p.id,
        run: () => h.moveTo({ pane: p.id }),
      })),
    ];
    const sub = doc.createElement('div');
    sub.style.cssText =
      'position:fixed;z-index:10002;min-width:160px;padding:4px;background:#1e222d;' +
      'border:1px solid #363c4e;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.5);' +
      'font:12px/1.5 -apple-system,"Segoe UI",sans-serif;color:#d5d8e0;user-select:none;';
    for (const e of entries) {
      const b = doc.createElement('button');
      b.textContent = (e.current ? '✓ ' : '') + e.label;
      b.style.cssText =
        'display:block;width:100%;text-align:left;padding:5px 12px;border:0;border-radius:4px;' +
        'background:transparent;color:' + (e.current ? '#5d606b' : '#d5d8e0') + ';' +
        'font:inherit;cursor:' + (e.current ? 'default' : 'pointer');
      if (!e.current) {
        b.addEventListener('mouseenter', () => { b.style.background = '#2a2e39'; });
        b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
        b.addEventListener('click', () => { closeMoreMenu(); e.run?.(); });
      }
      sub.appendChild(b);
    }
    menu.appendChild(sub); // inside the parent: dismissal + teardown ride along
    const pr = anchorBtn.getBoundingClientRect();
    const vw = doc.defaultView?.innerWidth ?? 1280;
    const vh = doc.defaultView?.innerHeight ?? 720;
    const sw = sub.offsetWidth, sh = sub.offsetHeight;
    const left = pr.right + 2 + sw > vw ? Math.max(8, pr.left - 2 - sw) : pr.right + 2;
    sub.style.left = left + 'px';
    sub.style.top = Math.max(8, Math.min(pr.top, vh - sh - 8)) + 'px';
    subMenuEl = sub;
  }

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
    b.addEventListener('mouseenter', () => {
      if (it.sub) { b.style.background = '#2a2e39'; it.sub(b); }
      else { closeSubMenu(); if (!it.disabled) b.style.background = '#2a2e39'; }
    });
    if (!it.disabled) {
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
      // A submenu parent keeps the menu open (hover reveals the flyout;
      // click re-arms it). Every other item closes the whole menu on click.
      b.addEventListener('click', () => { if (it.sub) it.sub(b); else { closeMoreMenu(); it.run?.(); } });
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

let writeErrorUnsub: (() => void) | null = null;
// Popup menus append to doc.body — outside the panel body — so the shell's
// panel close can't reach them. Track and clean on detach/destroy or they'd
// survive as ghost UI.
const openMenus: HTMLElement[] = [];

// ── Docked side panel (TV parity) ── the shell owns the header row, close
// button, dock exclusivity and persisted width; we mount our surface into the
// body it hands us. `panelCtx` doubles as the "mounted" latch; `pendingOpen`
// carries content for a not-yet-mounted panel.
const PANEL_ID = "opencharts.pine";
let panelCtx: WidgetContext | null = null;
let panelBody: HTMLElement | null = null;
let panelRoot: HTMLElement | null = null;      // our .vela-pine-dialog node
let undockStrip: (() => void) | null = null;   // bottom-strip undo while docked there
let bottomDocked = false;
let pendingOpen: { src: string; editingId?: string; scriptId?: string } | null = null;
let edHandle: PineEditorHandle | null = null;  // module scope for teardown/reopen
let refreshPanel: (() => void) | null = null;  // rebuildOnChart, set by mountEditor
// Buffer text staged for the editor — written by applyOpenArgs before mount,
// flushed into monaco/textarea once the surface exists.
let pendingValue = "";

/** Open the docked panel and aim the editor at `initialSrc`. If the shell
 *  hasn't mounted the panel yet, stash the args for mount to consume. */
function openEditor(ctx: WidgetContext, initialSrc = "", editingId?: string, scriptId?: string): void {
  if (!migrated) { migrated = true; try { pineLibMigrateLegacyHist(); } catch { /* first run */ } }
  const want = { src: initialSrc, editingId, scriptId };
  if (panelCtx && panelRoot) {
    // Panel already mounted (visible or hidden): apply now — if hidden the
    // shell's onOpen fires on toggle and only consumes pendingOpen, so we
    // push the buffer directly instead of stashing.
    applyOpenArgs(want);
    if (want.src && edHandle) edHandle.setValue(want.src);
    ctx.togglePanel?.(PANEL_ID, true);
    refreshPanel?.();
  } else {
    pendingOpen = want;
    ctx.togglePanel?.(PANEL_ID, true);
  }
}

function applyOpenArgs(want: { src: string; editingId?: string; scriptId?: string }): void {
  // scriptId is authoritative (caller resolved "this buffer IS that script").
  // Without it, a non-empty src means editing an indicator — reset currentId
  // so Save can't overwrite an unrelated script.
  editorState = {
    currentId: want.scriptId ?? (want.src ? null : editorState.currentId),
    dirty: false,
    handleId: want.editingId,
  };
  if (want.src) pendingValue = want.src;
}

function mountEditor(ctx: WidgetContext, body: HTMLElement, header: SidePanelHeader): void {
  if (!migrated) { migrated = true; try { pineLibMigrateLegacyHist(); } catch { /* first run */ } }
  panelCtx = ctx;
  panelBody = body;
  const doc = ctx.host.ownerDocument;

  const root = doc.createElement("div");
  root.className = "vela-pine-dialog";
  panelRoot = root;
  if (pendingOpen) { const w = pendingOpen; pendingOpen = null; applyOpenArgs(w); }

  // ── Editor surface ── Monaco when it mounts; textarea fallback for
  // environments where monaco can't run (jsdom, worker-less CSP). `area` keeps
  // the textarea-shaped API the rest of this function already uses — writes
  // before mount land in pendingValue and flush into the editor on create.
  const edHost = doc.createElement("div");
  edHost.className = "vela-pine-edhost";
  let ed: PineEditorHandle | null = null;
  let ta: HTMLTextAreaElement | null = null;
  // Bound lazily by mountMonaco — lintOnChange/markRunError no-op until then.
  let lintPineSrc: ((src: string) => PineLintError | null) | null = null;
  let parseErrLoc: ((err: string) => PineLintError | null) | null = null;
  const lintTimers: number[] = [];
  function lintOnChange(): void {
    if (!lintPineSrc || !ed) return;
    for (const t of lintTimers) doc.defaultView?.clearTimeout?.(t);
    lintTimers.length = 0;
    lintTimers.push(doc.defaultView?.setTimeout?.(() => {
      if (lintPineSrc && ed) ed.markError(lintPineSrc(ed.getValue()));
    }, 400) ?? 0);
  }
  /** Surface a run/compile error in the editor + statusbar. */
  function markRunError(err: string): void {
    setStatus(`Error: ${err}`, "err");
    const loc = parseErrLoc?.(err) ?? null;
    if (loc && ed) {
      ed.markError(loc);
      ed.setPosition(loc.line, loc.col);
      ed.focus();
    }
  }
  function mountFallback(): void {
    if (ta) return;
    const el = doc.createElement("textarea");
    el.className = "vela-pine-area";
    el.spellcheck = false;
    el.value = pendingValue;
    el.addEventListener("input", onContentChanged);
    el.addEventListener("keyup", () => updateCursorFromFallback());
    el.addEventListener("click", () => updateCursorFromFallback());
    edHost.appendChild(el);
    ta = el;
  }
  /** Fold any existing textarea buffer back into pendingValue + remove the
   *  fallback — called inside async closures where `ta` narrows to `never`. */
  function adoptFallbackToPending(): void {
    if (!ta) return;
    pendingValue = ta.value;
    ta.remove();
    ta = null;
  }
  const area = {
    get value(): string { return ed ? ed.getValue() : ta ? ta.value : pendingValue; },
    set value(v: string) {
      pendingValue = v;
      if (ed) ed.setValue(v);
      if (ta) ta.value = v;
    },
    focus(): void { ed ? ed.focus() : ta?.focus(); },
  };
  function updateCursorFromFallback(): void {
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    cursorPos.textContent = `Line ${before.split("\n").length}, Col ${pos - before.lastIndexOf("\n")}`;
  }

  const statusMsg = doc.createElement("span");
  statusMsg.className = "vela-pine-msg";
  const setStatus = (text: string, kind: "" | "ok" | "err" = "") => {
    statusMsg.textContent = text;
    statusMsg.dataset.kind = kind;
  };

  // ── Header ── the shell owns the panel's row, title and ✕; our controls go
  // into header.slot. TV order: [name ▾] [↻] [Add to chart] [Save] [Publish] [⋯]
  const headbar = doc.createElement("div");
  headbar.className = "vela-pine-headbar";

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
        if (pineLibWriteFailed()) return; // status already shown via onWriteError
        editorState.currentId = s.id;
        setStatus(`Saved "${s.name}"`, "ok");
      } else {
        pineLibSave(editorState.currentId, src);
        if (pineLibWriteFailed()) return;
        setStatus("Saved", "ok");
      }
      editorState.dirty = false;
      refreshName();
    } catch (e) {
      setStatus(`Save failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  };
  // Quota/denied writes inside pineLib would otherwise report "Saved" while
  // nothing hit storage — surface them in the statusline while THIS editor is
  // open, and always via ctx.toast (a write can fail while no editor is open,
  // or a second editor would steal a single-slot handler).
  writeErrorUnsub = pineLibOnWriteError((msg) => {
    if (statusMsg.isConnected) setStatus(msg, "err");
    ctx.toast(msg, "error");
  });

  const makeCopy = () => {
    if (!editorState.currentId) { setStatus("Save the script first", "err"); return; }
    pineLibSave(editorState.currentId, area.value); // capture current buffer
    if (pineLibWriteFailed()) return;
    const c = pineLibDuplicate(editorState.currentId);
    if (pineLibWriteFailed()) return;
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
      item(bottomDocked ? "Move script back to side panel" : "Move script to bottom", null, () => { dockToBottom(); }),
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
              markRunError('error' in r ? String(r.error) : 'unknown');
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
            markRunError('error' in r ? String(r.error) : 'unknown');
            return;
          }
          setStatus("Added", "ok");
        }
        rebuildOnChart();
      } catch (e) {
        markRunError(e instanceof Error ? e.message : String(e));
      }
    })();
  });

  const saveBtn = doc.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "vela-pine-hbtn";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", saveScript);

  // TV header order: [Publish script] [⋯] [—] [✕]. No community backend exists
  // locally, so Publish maps to the local-equivalent share: copy the source to
  // the clipboard AND drop a .pine download — the script leaves the app either
  // way (TV's publish sends it to a shared library; here the clipboard/file is
  // the handoff seam).
  const publishBtn = doc.createElement("button");
  publishBtn.type = "button";
  publishBtn.className = "vela-pine-hbtn";
  publishBtn.textContent = "Publish script";
  publishBtn.title = "Copy source + download .pine";
  publishBtn.addEventListener("click", () => {
    const src = area.value;
    const name = scriptTitle(src, editorState.currentId ? pineLibGet(editorState.currentId)?.name ?? "script" : "script");
    // Clipboard first — headless/denied contexts still get the file.
    void doc.defaultView?.navigator?.clipboard?.writeText?.(src).catch(() => {});
    const blob = new Blob([src], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^\w\-. \u4e00-\u9fff]/g, "_")}.pine`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus(`Shared "${name}" — copied + downloaded`, "ok");
  });
  const moreBtn = doc.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "vela-pine-hbtn";
  moreBtn.textContent = "⋯";
  moreBtn.title = "More";
  moreBtn.disabled = true;   // phase 3: Editor settings / Command palette / Pine logs

  // Dock-to-bottom: `dockStrip` parks the WHOLE root between the chart area and
  // the bottom bar (TV's "Move script to bottom"). Calling again while docked
  // moves it back into the panel body.
  const dockToBottom = () => {
    if (!panelRoot || !panelCtx) return;
    if (bottomDocked) {
      undockStrip?.(); undockStrip = null; bottomDocked = false;
      panelBody?.appendChild(panelRoot);
      panelCtx.togglePanel?.(PANEL_ID, true);
      setStatus("Docked at side", "ok");
      return;
    }
    try { sessionStorage.setItem("opencharts.pine.draft", JSON.stringify({ id: editorState.currentId, src: area.value })); } catch { /* quota */ }
    panelCtx.togglePanel?.(PANEL_ID, false);
    undockStrip = panelCtx.dockStrip?.(panelRoot) ?? null;
    bottomDocked = !!undockStrip;
    setStatus(bottomDocked ? "Docked at bottom" : "Bottom dock unavailable", bottomDocked ? "ok" : "err");
  };

  headbar.append(nameBtn, reloadBtn, addToChartBtn, saveBtn, publishBtn, moreBtn);

  // ── Buffer init: pendingOpen src (staged by applyOpenArgs) > collapsed
  // draft > current library entry > template ──
  const draft = (() => { try { return JSON.parse(sessionStorage.getItem("opencharts.pine.draft") || "null") as { id: string | null; src: string } | null; } catch { return null; } })();
  if (pendingValue) {
    area.value = pendingValue;
  } else if (draft?.src && !editorState.currentId) {
    area.value = draft.src;
    editorState.currentId = draft.id && pineLibGet(draft.id) ? draft.id : null;
  } else if (editorState.currentId) {
    area.value = pineLibGet(editorState.currentId)?.source ?? "";
  } else {
    area.value = TEMPLATES.indicator;
  }
  try { sessionStorage.removeItem("opencharts.pine.draft"); } catch { /* noop */ }
  refreshName();

  /** Single change hook for both monaco (`ed.onChange`) and fallback
   *  (`input` listener) — dirty tracking + debounced live lint. */
  function onContentChanged(): void {
    editorState.dirty = true;
    refreshName();
    lintOnChange();
  }

  // ── On-chart indicators: what this cell is currently running ──
  const onChart = doc.createElement("div");
  onChart.className = "vela-pine-onchart";
  const onChartLabel = doc.createElement("div");
  onChartLabel.className = "vela-pine-onchart-label";
  const rebuildOnChart = () => {
    const handles = (panelCtx ?? ctx).chart.indicators().filter(h => typeof h.source === 'string' && h.source.length > 0);
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
  refreshPanel = rebuildOnChart; // panel handle's onChart/onOpen reach it
  rebuildOnChart();

  // ── Statusbar ──
  const statusbar = doc.createElement("div");
  statusbar.className = "vela-pine-statusbar";
  const cursorPos = doc.createElement("button");
  cursorPos.type = "button";
  cursorPos.className = "vela-pine-hbtn";
  cursorPos.title = "Go to line";
  // Monaco reports cursor moves via onCursor; the textarea fallback drives the
  // same label through updateCursorFromFallback (hooked on keyup/click there).
  const setCursorLabel = (line: number, col: number) => {
    cursorPos.textContent = `Line ${line}, Col ${col}`;
  };
  setCursorLabel(1, 1);
  cursorPos.addEventListener("click", () => {
    const input = doc.defaultView?.prompt?.("Go to line:column", "1:1");
    if (!input) return;
    const m = /^(\d+)(?::(\d+))?$/.exec(input.trim());
    if (!m) { setStatus("Use line:col", "err"); return; }
    const line = Math.max(1, parseInt(m[1]!, 10));
    const col = Math.max(1, parseInt(m[2] ?? "1", 10));
    if (ed) {
      ed.focus();
      ed.setPosition(line, col);
      setCursorLabel(line, col);
      return;
    }
    if (!ta) return;
    const lines = ta.value.split("\n");
    let pos = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i]!.length + 1;
    pos += Math.min(col - 1, lines[Math.min(line - 1, lines.length - 1)]!.length);
    ta.focus();
    ta.setSelectionRange(pos, pos);
    updateCursorFromFallback();
  });

  const verLabel = doc.createElement("a");
  verLabel.textContent = "Pine Script v6";
  verLabel.href = "https://www.tradingview.com/pine-script-reference/v6/";
  verLabel.target = "_blank";
  verLabel.rel = "noopener";

  statusbar.append(cursorPos, statusMsg, verLabel);

  // ── Assemble ── the shell owns the panel's header row and close button;
  // our controls live in `header.slot` (between title and ✕), the body gets
  // the editor host + on-chart list + statusbar.
  header.slot.appendChild(headbar);
  root.append(edHost, onChartLabel, onChart, statusbar);
  body.appendChild(root);

  root.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveScript(); }
    if ((e.ctrlKey || e.metaKey) && e.key === "o") { e.preventDefault(); openScriptsDialogAction(); }
  });

  // The shell removes the panel body from the DOM on close (no onClose hook) —
  // watch root connectivity to drop floating menus that would survive as
  // ghosts, and mirror the textarea's visible state. The monaco instance is
  // kept: detaching doesn't lose buffer/undo history.
  const mo = new MutationObserver(() => {
    if (!root.isConnected) { for (const m of openMenus) m.remove(); openMenus.length = 0; }
  });
  mo.observe(doc.documentElement, { childList: true, subtree: true });

  // ── Monaco mount (lazy chunk). The textarea fallback mounts FIRST so the
  // buffer is editable immediately; mountPineEditor swaps it out when the
  // monaco chunk resolves, folding any early edits into pendingValue.
  mountFallback();
  void (async () => {
    try {
      const mod = await import("../pine/pineMonaco.ts");
      if (panelRoot !== root || !root.isConnected && !body.isConnected) return; // torn down or superseded
      lintPineSrc = mod.lintPineSource;
      parseErrLoc = mod.parseErrorLocation;
      // `ta` narrows to `never` inside this async closure — adoptFallbackToPending
      // lives outside it so the real type is preserved.
      adoptFallbackToPending();
      const handle = await mod.mountPineEditor(edHost, { initialValue: pendingValue });
      if (panelRoot !== root) { handle.dispose(); return; }
      ed = handle;
      edHandle = handle; // module handle: destroy() must reach the live editor
      ed.onChange(onContentChanged);
      ed.onCursor((line, col) => setCursorLabel(line, col));
      const km = ed.monaco.KeyMod;
      const kc = ed.monaco.KeyCode;
      ed.addKeybinding(km.CtrlCmd | kc.KeyS, saveScript);
      ed.addKeybinding(km.CtrlCmd | kc.KeyO, () => { openScriptsDialogAction(); });
      ed.addKeybinding(km.CtrlCmd | kc.Enter, () => { addToChartBtn.click(); });
      lintOnChange();
      ed.focus();
    } catch (e) {
      // Monaco can't run here (jsdom, worker-less CSP) — the textarea keeps
      // editing usable and surfaces the failure instead of dying silently.
      mountFallback();
      setStatus(`Monaco unavailable (${e instanceof Error ? e.message : String(e)}) — textarea mode`, "err");
    }
  })();
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

// ── Right rail (TV parity) ── TV puts Pine Editor in the right-hand vertical
// toolbar; the topbar button alone isn't the same affordance. A widget
// attachment appends a slim icon column at the end of the .vela-ws-main flex
// row — after the panel dock, so it stays the outermost right column.
const RAIL_CSS = `
.vela-pine-rail{display:flex;flex-direction:column;gap:2px;padding:6px 2px;
  width:34px;flex:none;align-items:center;
  border-left:1px solid var(--vela-border,#2a2e39);
  background:var(--vela-bg,#1e222d)}
.vela-pine-rail button{width:28px;height:28px;display:flex;align-items:center;
  justify-content:center;border:0;border-radius:4px;background:none;
  color:var(--vela-fg-muted,#868993);cursor:pointer}
.vela-pine-rail button:hover{background:rgba(255,255,255,.08);color:var(--vela-fg,#d1d4dc)}
.vela-pine-rail svg{width:16px;height:16px}
`;
// The editor is a contributed SIDE PANEL — a docked column beside the chart
// (TV parity: right dock with collapse/close in the shell chrome). Registered
// at import time; the shell hands mount() the body + a header slot.
registerSidePanel({
  id: PANEL_ID,
  title: "Pine Editor",
  icon: "edit",
  width: 520,
  resizable: true,
  minWidth: 320,
  mount(ctx, body, header) {
    mountEditor(ctx, body, header);
    return {
      // Re-bind to the cell's chart whenever the active cell changes — the
      // panel's ctx is the mount-time cell; rebuild re-reads through it.
      onChart() { refreshPanel?.(); },
      onOpen() {
        // Consume args stashed while the panel was closed (rail/legend open)
        // and push the stashed source into the LIVE editor, not just state.
        if (pendingOpen && panelRoot) {
          const w = pendingOpen; pendingOpen = null;
          applyOpenArgs(w);
          refreshPanel?.();
          if (edHandle) edHandle.setValue(pendingValue);
        }
      },
      destroy() {
        writeErrorUnsub?.(); writeErrorUnsub = null;
        for (const m of openMenus) m.remove(); openMenus.length = 0;
        undockStrip?.(); undockStrip = null; bottomDocked = false;
        edHandle?.dispose(); edHandle = null;
        panelCtx = null; panelBody = null; panelRoot = null; refreshPanel = null;
      },
    };
  },
});

// ── Object tree panel (legend ⋯ → 物件樹; TV parity: "Object tree") ──
// A contributed side panel listing the owning chart's indicators and user
// drawings — flat grouped list (TV nests drawings under panes; keep it simple).
// `objTreeChart` carries a one-shot override from the legend opener: without
// it mount would bind the ACTIVE cell, but a ⋯ menu can belong to another
// cell. Mount consumes the override, then onChart re-follows the active cell.
const OBJTREE_PANEL_ID = "opencharts.objtree";
let objTreeChart: WidgetContext['chart'] | null = null;
const OT_EYE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg>';
const OT_EYE_OFF = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 3l10 10M6.8 4.2A7 7 0 0 1 8 4c4.1 0 6.5 4 6.5 4a15 15 0 0 1-2.3 2.7M9.6 11.7A7 7 0 0 1 8 12c-4.1 0-6.5-4-6.5-4a15 15 0 0 1 2-2.4"/></svg>';
const OT_GEAR = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4"/></svg>';
const OT_TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 4.5h11M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4.5l.7 8a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.7-8"/></svg>';

function mountObjectTree(ctx: WidgetContext, body: HTMLElement): { onChart(c: WidgetContext['chart']): void; destroy(): void } {
  const doc = ctx.host.ownerDocument;
  let chart = ctx.chart;
  let unsubs: (() => void)[] = [];

  const root = doc.createElement("div");
  root.className = "vela-objtree";
  body.appendChild(root);

  const mkBtn = (title: string, svg: string, onClick: () => void): HTMLButtonElement => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "vela-objtree-btn";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = svg;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
  };

  const refresh = () => { if (root.isConnected) rebuild(); };

  function bind(c: WidgetContext['chart']): void {
    chart = c;
    for (const u of unsubs) u();
    unsubs = [];
    // Rebuild on every object-tree-relevant mutation so external edits (in-chart
    // deletes, legend eye toggles, pane merges) stay reflected without polling.
    for (const ev of [
      "indicator:added", "indicator:removed", "indicator:moved", "indicator:visibility",
      "pane:changed", "pane:moved",
      "drawing:created", "drawing:removed", "drawing:edited",
    ] as const) {
      unsubs.push(chart.on(ev, refresh));
    }
    rebuild();
  }

  function rebuild(): void {
    root.textContent = "";
    const group = (label: string): void => {
      const g = doc.createElement("div");
      g.className = "vela-objtree-group";
      g.textContent = label;
      root.appendChild(g);
    };
    const empty = (label: string): void => {
      const d = doc.createElement("div");
      d.className = "vela-objtree-empty";
      d.textContent = label;
      root.appendChild(d);
    };
    const row = (name: string, meta: string | null): HTMLElement => {
      const r = doc.createElement("div");
      r.className = "vela-objtree-row";
      const n = doc.createElement("span");
      n.className = "vela-objtree-name";
      n.textContent = name;
      r.appendChild(n);
      if (meta) {
        const m = doc.createElement("span");
        m.className = "vela-objtree-id";
        m.textContent = meta;
        r.appendChild(m);
      }
      return r;
    };

    // ── 指標 ── eye → setVisible, gear → renderer settings dialog, ✕ → remove
    group("指標");
    let handles: IndicatorHandle[] = [];
    try { handles = chart.indicators(); } catch { /* disposed cell */ }
    if (!handles.length) empty("無指標");
    for (const h of handles) {
      const r = row(h.title, null);
      if (!h.visible) r.classList.add("off");
      r.title = h.id;
      r.addEventListener("click", () => {
        if (chart.renderer.supportsIndicatorSettings) chart.renderer.openIndicatorSettings(h.id);
      });
      r.appendChild(mkBtn(h.visible ? "隱藏" : "顯示", h.visible ? OT_EYE : OT_EYE_OFF, () => {
        try { h.setVisible(!h.visible); } catch { /* gone */ }
        rebuild();
      }));
      r.appendChild(mkBtn("設定…", OT_GEAR, () => {
        if (chart.renderer.supportsIndicatorSettings) chart.renderer.openIndicatorSettings(h.id);
      }));
      r.appendChild(mkBtn("移除", OT_TRASH, () => {
        try { h.remove(); } catch { /* gone */ }
        rebuild();
      }));
      root.appendChild(r);
    }

    // ── 繪圖 ── row click selects + opens settings; eye → show, ✕ → remove
    group("繪圖");
    let drawings: SerializedDrawing[] = [];
    try { drawings = chart.drawings.all(); } catch { /* disposed cell */ }
    if (!drawings.length) empty("無繪圖");
    for (const d of drawings) {
      const r = row(d.type, `…${d.id.slice(-4)}`);
      if (!d.visible) r.classList.add("off");
      r.title = d.id;
      r.addEventListener("click", () => {
        try { chart.drawings.select([d.id]); chart.drawings.openSettings(d.id); }
        catch { /* gone */ }
      });
      r.appendChild(mkBtn(d.visible ? "隱藏" : "顯示", d.visible ? OT_EYE : OT_EYE_OFF, () => {
        try { chart.drawings.show(d.id, !d.visible); } catch { /* gone */ }
        rebuild();
      }));
      r.appendChild(mkBtn("移除", OT_TRASH, () => {
        try { chart.drawings.remove(d.id); } catch { /* gone */ }
        rebuild();
      }));
      root.appendChild(r);
    }
  }

  bind(objTreeChart ?? chart); // consume the legend-opener override if set
  objTreeChart = null;
  return {
    // Rebind to the cell's chart whenever the active cell changes.
    onChart(c) { bind(c); },
    destroy() { for (const u of unsubs) u(); unsubs = []; },
  };
}

registerSidePanel({
  id: OBJTREE_PANEL_ID,
  title: "物件樹",
  icon: "objtree",
  width: 280,
  resizable: true,
  minWidth: 220,
  mount(ctx, body) { return mountObjectTree(ctx, body); },
});
registerWidgetAttachment({
  id: "opencharts.pine-rail",
  mount(ctx) {
    const doc = ctx.host.ownerDocument;
    const main = ctx.host.querySelector?.(".vela-ws-main") as HTMLElement | null;
    if (!main) return () => {}; // layout variant without the row → skip rail
    if (!doc.querySelector("style[data-vela-pine-rail]")) {
      const s = doc.createElement("style");
      s.dataset.velaPineRail = "";
      s.textContent = RAIL_CSS;
      doc.head.appendChild(s);
    }
    const rail = doc.createElement("div");
    rail.className = "vela-pine-rail";
    const mkBtn = (title: string, svg: string, onClick: () => void): HTMLButtonElement => {
      const b = doc.createElement("button");
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", title);
      b.innerHTML = svg;
      b.addEventListener("click", onClick);
      return b;
    };
    const PEN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M11.5 3.5 12.7 4.7a1 1 0 0 1 0 1.4l-8.2 8.2-2.8.7.7-2.8 8.2-8.2a1 1 0 0 1 1.4 0Z"/></svg>';
    const FOLDER = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h5A1.5 1.5 0 0 1 14.5 6.5v5A1.5 1.5 0 0 1 13 13H3.5A1.5 1.5 0 0 1 2 11.5Z"/></svg>';
    rail.append(
      mkBtn("Pine Editor", PEN, () => openEditor(ctx)),
      mkBtn("My scripts", FOLDER, () => openScriptsDialog(ctx, (id) => openPineEditorWithScript(ctx, id))),
    );
    main.appendChild(rail);
    return () => rail.remove();
  },
});
