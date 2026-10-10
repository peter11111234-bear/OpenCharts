# Vela TV-Parity Round 7 — Implementation Plan (v1)

> **日期：** 2026-10-10
> **For agentic workers:** REQUIRED SUB-SKILL: task-workflow (P0–P9). Steps use checkbox (`- [ ]`) syntax.

**Goal:** 收斂 TV-parity 剩餘缺口 + 本輪 review 風險：去 `window.__vela` internals、legend ⋯ 溢出選單、scripts dialog 分類、pendingAdds dead-cell 清掃、文件 persist。

**Architecture:** 全部走既有 vela plugin seam（registerStatePersistence / registerLegendAction / registerSidePanel / pineLib)。不新增平行 store，不造第二套 dialog/menu convention。

**Tech Stack:** Vite + React + @luxalgo/vela SDK + pineLib localStorage。

**Spec:** `docs/TV_PINE_EDITOR_RECON.md`（缺口表）+ `docs/TV_ALIGNMENT_PIPELINE.md`(R6/R7 ledger)

**Spec invariant:** 不自創 UI — 每個新表面對齊 TV 行為或 vela 既有 seam；凡「新的東西」必須有 TV 對應或明確標註為 local-equivalent。

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same verify failing after 2+ distinct fix attempts. Single red test = normal loop, not a blocker.

Never stop to ask what you can look up — file locations, signatures, test names: search first.

**Plan-specific Nevers:**
- NEVER 改回 modal overlay — side panel 是 TV parity 決定，已定稿。
- NEVER 用 `window.__vela` 當資料來源 — 它是 VelaPage debug handle，不是 vela API；D1 決定的公開路徑是 `ws.cell(id).instances`。
- NEVER 在 `serializeCellScripts` 裡用 manifest-name 字串比對當 ownership 判斷 — external-flag 是唯一可信來源（已修復 compounding bug，回退會復活它）。

## Global Constraints

- `npx tsc --noEmit` 對 touched 檔零錯誤（repo 既有 trading-pages 錯誤不在範圍）
- `npx vitest run src/pine` 全綠
- 新 localStorage key 用 `opencharts.<area>.<name>` 前綴（PatternScout Q13 確認慣例）
- 新 UI 用 `vela-pine-*` / `vela-layouts-*` class prefix + inject-once `<style>` pattern
- Toast 走 `ctx.toast(msg, kind)`；既有 helper `toast(ctx, msg, kind)` 已包 try/catch

## Decision Points

### D1: serializeCellScripts 怎麼拿 instances ledger   (T1)
- Consumed by: Task 1
- Candidates:
  - A (existing pattern): `window.__vela` 全域 — VelaPage.tsx:297 設的 debug handle
  - B (minimal): 移除 external-flag 檢查，回退 manifest-name 比對
  - C (preferred): `VelaPage` 呼叫 `bindVelaWorkspace(ws)` 把 ws 存 module-level,serialize 用 `ws.cell(ctx.cellId)?.instances`
- Criteria:
  - No reliance on undocumented globals
  - No reintroduction of compounding-EMA bug (ext must never contain ledger-owned)
  - Graceful when ws unavailable (degrade, not crash)
- Chosen: C
- Rejected: A fails criterion 1 (self-assigned debug global); B fails criterion 2 (name-match was the original bug — same-source≠same-ownership)
- Revisit trigger: vela adds instances accessor to CellStateContext → drop the module ref
- Outcome: (execution fills)

### D2: Legend ⋯ overflow — callout vs action+menu   (T1)
- Consumed by: Task 2
- Candidates:
  - A (existing pattern): `registerLegendCallout` — bubble with `content.items` button list
  - B (minimal): leave current `edit` icon only
  - C (preferred): `registerLegendAction` id `more` + hand-rolled `.vela-pine-menu` (same pattern as name menu) anchored on row rect
- Criteria:
  - ⋯ visible on hover alongside built-in controls (TV parity)
  - Can carry ≥3 items (Source code / Hide / Remove)
  - Consistent with existing menu convention (`.vela-pine-menu` + dismiss-on-mousedown)
- Chosen: C
- Rejected: A fails criterion 1 — callout spec says bubble is "hidden while hover/selection controls are out", i.e. it disappears exactly when ⋯ should appear (FeasibilityScout Q2 evidence); B fails criterion 2 (edit-only ≠ overflow)
- Revisit trigger: vela adds a legend-overflow-menu seam → migrate
- Outcome: (execution fills)

### D3: Scripts dialog categories   (T0→scoped into Task 4)
- Rail tabs: `Favorites | Recent | All scripts`（Built-in 模板屬 editor 的 Create-new submenu，不在 lib — TV 的 Built-in 區是 manifest，我們已有 picker 那側）。Local choice, no D-block needed.

## Review Ledger

(starts empty)

## Fact Annex (P2 recon, verified)

- `VelaWorkspace.cell(id): ChartCell | undefined` — workspace.d.ts:869. `ChartCell.instances: readonly CellInstance[]`, `CellInstance.external?: boolean` — workspace.d.ts:134-159.
- `registerStatePersistence` has NO destroy hook; cell destroy → `dehydrate()` runs serialize first (chunk-DBDXKZUF.js:9406). `pendingAdds` cellId keys can leak if a cell dies with pending entries — bounded only if that cellId serializes again.
- `WidgetContext.chart` = live getter for ACTIVE cell (contributions d.ts:1831). `SidePanelHandle.onChart(chart: Vela)` fires on mount/rebuild/active-cell switch — our `refreshPanel?.()` usage correct.
- `registerLegendAction` reveals icon with built-in controls between them and ✕ — correct seam for TV ⋯.
- `dockStrip(el)` docks into workspace-level `stripsEl`; survives cell rebuild; undock disposer no-ops after workspace destroy.
- pineLib: `pineLibList(): PineScriptEntry[]` (updatedAt desc), `pineLibSubscribe(fn)` bare callback + returns unsub, `pineLibRecent(): string[]` cap 8. `opencharts.pine.fav` key already used by dialog stars.
- `openScriptsDialog` already: search input + star favs + row ⋯ (Rename/Copy/Delete) + pineLibSubscribe refresh. Missing: category tabs.
- `combinedManifestEntries()` already merges bundled+lib into 'My scripts' picker category — A1 requirement already met (VelaPage.tsx:287, pineScripts.ts:59-67).
- Panel mount CAN re-run (no once-guarantee); our `destroy()` resets module state — verified correct.

## Tasks

### Task 1: Replace `window.__vela` internals with `ws.cell()` public API

**Blocked by:** None — frontier task.

**Files:**
- Modify: `src/pages/velaPineEditor.ts` (serializeCellScripts body; add `bindVelaWorkspace`)
- Modify: `src/pages/VelaPage.tsx` (~:297, next to `__vela = ws` — add binding call)

**Interfaces:**
- Produces: `export function bindVelaWorkspace(ws: VelaWorkspace): void` in velaPineEditor.ts — VelaPage imports & calls once after `new VelaWorkspace`.
- Consumes: `VelaWorkspace.cell(id)` → `ChartCell.instances` (per Fact Annex).

**Assumptions:** None (D1 decided).

**Done when:**
- `grep -n "__vela" src/pages/velaPineEditor.ts` → zero hits.
- `npx tsc --noEmit` touched files → clean.
- Browser: seed ext script + manifest indicator, two reloads → `cell.instances.length` stable AND ext blob contains only external-flagged entries.

- [ ] **Step 1: Add module ref + binder**

In `src/pages/velaPineEditor.ts`, module scope (near `pendingValue` decl, anchor `let pendingValue = ""`):

```ts
// Public accessor: serialize needs cell.instances[].external to split our
// external scripts from ledger-owned manifest instances. VelaPage binds the
// workspace once at construction (bindVelaWorkspace) — window.__vela is a
// debug handle, not a data source.
let workspaceRef: { cell(id: string): { instances?: { id?: string; external?: boolean; handle?: { id: string } | null }[] } | undefined } | null = null;
export function bindVelaWorkspace(ws: NonNullable<typeof workspaceRef>): void {
  workspaceRef = ws;
}
```

- [ ] **Step 2: Swap the lookup in serializeCellScripts**

Anchor: `const ws = (window as unknown as Record<string, unknown>).__vela as { cells(): … }` — replace with:

```ts
  const cell = workspaceRef?.cell(ctx.cellId);
```

Delete the `ws`/`cells().find(...)` lines. `isExternal` keeps using `cell?.instances?.find(...)`.

Fallback when `workspaceRef` unset or cell undefined: treat **every** handle with `.source` as external (conservative — restore-side dedup via `claimed`+`inputsMatch` absorbs transient dups; data loss is worse than a dup).

- [ ] **Step 3: Wire in VelaPage**

Anchor `initVelaLayouts(ws);` (VelaPage.tsx:~299) — add immediately after:

```ts
    bindVelaWorkspace(ws);
```

Add import: `import { bindVelaWorkspace } from "./velaPineEditor.ts";` alongside the existing velaLayouts import (anchor: `import { initVelaLayouts } from "./velaLayouts.ts";`).

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit | grep velaPineEditor\|VelaPage` → empty.
Browser smoke: open `/vela`, run `chart.runIndicator('indicator("X")\nplot(close)')`, reload twice → script indicators count stable; `dehydrateExt()` blob has only our entries.

- [ ] **Step 5: Commit**
```bash
git add src/pages/velaPineEditor.ts src/pages/VelaPage.tsx
git commit -m "refactor(vela): serialize scripts via ws.cell().instances, drop __vela internals"
```

### Task 2: Legend ⋯ overflow menu (Source code / Hide / Remove)

**Blocked by:** None — frontier task. **Same file as Task 1 → serialize or patch-buffer.**

**Files:**
- Modify: `src/pages/velaPineEditor.ts` (new registerLegendAction `pine-more` + menu builder; reuse `.vela-pine-menu` CSS)

**Interfaces:**
- Consumes: `registerLegendAction`, `LegendIndicatorInfo {id,title,source?}`, existing `openEditor(ctx, src, handleId)`, existing `svg16`+`registerIcon("more-h")` already registered.
- Produces: none consumed elsewhere.

**Assumptions:** `h.hide?.()`/`h.show?.()` or visibility flag on IndicatorHandle — check `visible` getter + a hide method exists; if absent, item shows disabled (verify before writing the Hide branch; TV parity needs visible toggle which exists as `handle.visible`).

**Done when:**
- Hovering a script indicator row shows ⋯ between edit and ✕.
- Menu lists Source code / Hide(or Show)/Remove; each works.
- tsc clean; browser smoke screenshot/description of menu items.

- [ ] **Step 1: Register the action**

Anchor: existing `registerLegendAction({ id: "edit-in-pine", ... })` block — add immediately after it:

```ts
// TV parity: every indicator row gets a ⋯ overflow (hover-revealed with the
// built-in controls). Callout bubbles hide exactly when controls show, so this
// is an action + hand-rolled menu (same .vela-pine-menu convention).
registerLegendAction({
  id: "pine-more",
  icon: "more-h",
  tooltip: "更多",
  order: 90, // after edit(10)/move, before ✕
  when: () => true, // natives too — Hide/Remove apply to them
  run: (ctx, ind) => openLegendOverflowMenu(ctx, ind),
});
```

- [ ] **Step 2: Implement openLegendOverflowMenu**

New function before `openEditor`. Hand-rolled `.vela-pine-menu` (copy the dismiss pattern from `openNameMenu`: doc mousedown dismiss + `openMenus.push`). Anchor position: `ctx.host.getBoundingClientRect()` won't work — the action's trigger element isn't handed to run(). Use `document.querySelector('.vela-legend-row--active, [data-selected]')` fallthrough to the row containing `ind.id`, else center of `ctx.host`. Items:

```ts
const handle = ctx.chart.indicators().find(h => h.id === ind.id);
// IndicatorHandle: `readonly visible: boolean` + `setVisible(visible: boolean)`
// (contributions d.ts:317/346) + `remove?()` — verified in the SDK surface.
item("Source code", () => { if (ind.source) openEditor(ctx, ind.source, ind.id); }, !ind.source),
item(handle?.visible ? "Hide" : "Show", () => { handle?.setVisible(!handle.visible); }, !handle),
sep(),
item("Remove", () => { handle?.remove?.(); }, !handle),
```

- [ ] **Step 3: Verify**
Browser: `/vela` with a script indicator → hover legend → ⋯ appears → click → menu opens at row → Source code opens panel with source loaded. tsc clean.

- [ ] **Step 4: Commit**
```bash
git commit -am "feat(vela): legend overflow menu — source/hide/remove (TV parity)"
```

### Task 3: Multi-cell rebind verification (test-only task)

**Blocked by:** None.

**Files:**
- None to modify unless test fails (then fix lands in same task report).

**Done when:**
- Evidence exists (browser eval transcript) that after switching active cell: panel's on-chart list shows THE ACTIVE cell's indicators and Add to chart targets it. If it fails, the fix (rebind through `panelCtx.chart` live getter — already the case) plus a regression note lands in the task report.

- [ ] **Step 1:** Browser eval: open `/vela`, split to 2 cells (layout action or `ws.addCell()` if exposed), add a script indicator on cell2 only, switch active cell → read panel's `.vela-pine-onchart` list before/after.
- [ ] **Step 2:** If stale → in `rebuildOnChart` confirm `(panelCtx ?? ctx).chart` — it already is; the likely fix is nothing. Record result.

### Task 4: Scripts dialog category rail

**Blocked by:** None. (Different file than Tasks 1-2.)

**Files:**
- Modify: `src/pages/velaPineScriptsDialog.ts` (rail + filtering; reuse `vela-pine-*` CSS + FAV_KEY + pineLibRecent)

**Done when:**
- Dialog shows rail: `★ Favorites | Recent | All` filtering `pineLibList()` results (favs from `opencharts.pine.fav`, recent from `pineLibRecent()`, all = current list). Search still works within the active tab.
- tsc clean; browser smoke shows rail + switching tabs refilters.

- [ ] **Step 1:** Add tab state `let tab: 'fav'|'recent'|'all' = 'all'` inside `openScriptsDialog`; filter `all` before query filter:
```ts
const pool = tab === 'fav' ? all.filter(s => favs.includes(s.id))
         : tab === 'recent' ? pineLibRecent().map(id => pineLibGet(id)).filter(Boolean) as PineScriptEntry[]
         : all;
```
- [ ] **Step 2:** Rail = `.vela-pine-catrail` column of 3 buttons; active gets `.on`. New CSS appended to the file's style block (or shared PINE_CSS injection — follow existing ensureCss/inject-once pattern in this file).
- [ ] **Step 3-4:** browser verify + commit `feat(vela): scripts dialog category rail`.

### Task 5: pendingAdds dead-cell sweep + docs persist

**Blocked by:** Task 1 (same file — serialize region moves).

**Files:**
- Modify: `src/pages/velaPineEditor.ts` (pendingAdds map maintenance)
- Modify: `PROGRESS.md` append; `docs/TV_PINE_EDITOR_RECON.md` gap-table status updates

**Done when:**
- A sweep removes `pendingAdds` entries older than `PENDING_MS` on each serialize call regardless of cellId (or cell death deletes the key — whichever the executor can verify against workspace events; the serialize-time sweep is the documented fallback).
- PROGRESS.md has a dated R7-aligned entry listing: panel-ization, external-flag dedup, pendingAdds fix, worker-pool dead-worker cull, dockStrip bottom dock, this round's tasks.
- RECON.md gap table: modal→dock = 已對齊; My scripts picker = 已接 (pre-existing); legend ⋯ = Task 2 state; scripts dialog categories = Task 4 state.

- [ ] **Step 1:** In `serializeCellScripts`, before the `pend` block (anchor `const pend = pendingAdds.get(ctx.cellId);`), add:
```ts
  // Sweep dead cellIds: entries can't outlive their PENDING_MS window even if
  // their cell died before ever serializing again.
  const nowSweep = Date.now();
  for (const [cid, arr] of pendingAdds) {
    const kept = arr.filter((p) => nowSweep - p.at < PENDING_MS);
    if (kept.length) pendingAdds.set(cid, kept); else pendingAdds.delete(cid);
  }
```
- [ ] **Step 2:** Docs updates per Done-when.
- [ ] **Step 3:** Commit `chore(vela): pendingAdds sweep + round-7 docs`.

## Rollback

Every task is a separate commit; revert by `git revert <sha>` per task. No shared mutable file format changes (ext blob shape unchanged; pendingAdds is in-memory). Dialog rail is additive UI — safe to revert wholesale.
