# TV Recon R9 — Charting-Library Code Evidence (2026-10-11)

**Sources**: `https://static.tradingview.com/static/bundles/60244.<hash>.js` (1.35MB, chart engine) + `en.4333.<hash>.js` (116KB, en-US locale strings). Pulled via webpack runtime chunk-name map; verified live against `www.tradingview.com/chart` DOM (data-qa-id hooks: `legend-source-item`, `legend-more-action`, `pine-script-title-button`, `script-more-options`, `tv-script-widget`, `pine-editor-dialog`).

**Method limits**: live legend ⋯ would not open headless (Volume-only legend + anon session); menu shapes below are code-derived, not screenshot-verified.

## Legend ⋯ menu — code-derived shape

| TV item | charting-lib method / string | vela API today | our menu state |
|---|---|---|---|
| Add alert on {title} | string `Add alert on {title}` (+`… at {price}`) | none | disabled 正確 |
| Apply these indicators to entire layout | `Apply these indicators to entire layout` | `runIndicator` per cell loop | 已做 (`增加到整個版面`) — label OK |
| Add to watchlist / favorite | not in en.4333 (separate chunk) | — | — |
| **Visual order ▸** | `insert {title} after {target}`, `insert {title} before {target}`, `send {title} backward`, bring forward (methods `insertAfter`/`insertBefore`/`sendBackward`/`bringForward`, `changeZOrder`) | **no indicator z-order API** (bringToFront/sendToBack are DrawingController-only) | disabled 正確 |
| 時間週期的可見性 | not located | — | disabled |
| **Move to ▸** | `merge up`, `merge down`, `unmerge up`, `unmerge down`, `merge to pane` (methods `mergeToPane`, `paneFor`); NOT a flat pane list | `handle.moveTo({pane:'<id>'})` maps to `merge to pane`; `moveTo('price')` = merge into main; `moveTo({newPane})` = new pane. **Adjacent-pane merge up/down: compute via `chart.panes.list()` order ±1** | agent shipped flat pane list — needs merge up/down rows + `merge to pane ▸` submenu shape |
| **Pin to scale ▸** | `pin`, `move {title} to new left scale` (`detachToLeft`), `move {title} to new right scale` (`detachToRight`), `make {title} no scale (Full screen)` (`detachNoScale`), pin-to-existing (`moveToScale` + `MoveToExistingPriceScaleUndoCommand`) | `PaneAxis` type exists in vela d.ts ('none' \| {bands}) but no per-indicator scale-assign surface confirmed | disabled pending scale-API check |
| Source code | `"Source code"` | `openEditor` | 已做 |
| Hide | `"Hide"` | `h.setVisible(false)` | 已做 |
| Remove | `"Remove"` / `Remove {indicators}` | `h.remove()` | 已做 |
| Object tree | `"Object tree"` | host side panel (registered) | 已做 (R9 menu agent) |
| Settings… | `"Settings"` | `renderer.openIndicatorSettings` | 已做 |

## Scale semantics evidence (charting-lib)
- `detachToLeft`/`detachToRight`/`detachNoScale` → `MoveToNewPriceScaleUndoCommand(model, src, pane, 'left'|'right'|'overlay')` — pin-to-scale operates on (source, pane, axis-side) triple; `detachNoScale` = overlay/full-screen mode.
- `moveToScale` wraps `MoveToExistingPriceScaleUndoCommand` + reassigns currency/unit/metric on pin (`sourceNewCurrencyOnPinningToPriceScale` etc.) — pinning an indicator to another scale adopts that scale's formatting.

## Editor chrome (live DOM, verified)
Toolbar L→R: **title button** (`pine-script-title-button`, shows `Untitled script`, aria-haspopup=menu — file ops menu, only opens for saved scripts) · **Add to chart** (`add-script-to-chart`, Ctrl+↵ tooltip) · **Save** (`pine-script-save-button`, class `unsaved-*` when dirty) · **Publish** (`publish-script`) · **More** (`script-more-options`, aria-haspopup=menu).
Status bar R→L: `Line 1, Col 1` (click → Go to line) · `Open console` · `Pine Script® v6` + `Open Pine Reference`.
More-menu items (live-verified): `Editor settings…`, `New window`, `New tab`, `Profiler mode`, `Pine logs`, `Command Palette`, `Release notes`, `Help`.

## Script persistence keys (observed in bundles)
`Pine.recently_used_scripts`, `pine_editor.versions_history.settings`, `openScriptDialog.viewState`, `saved_scripts_limit`/`pine_free_saved_scripts_limit`, `pine_editor.lastOpenReleaseNotesTime`, `editor_console_open`, `bottom_duplicate_popup`. Backend: `pine-facade.tradingview.com`.

## Vela gaps confirmed this round
- No indicator z-order (`insertBefore/insertAfter/sendBackward/bringForward`) — keep disabled.
- Scale pin (left/right/no-scale + pin-to-existing) needs `PaneAxis`-shaped API — agent to verify whether `AddIndicatorOptions`/`IndicatorHandle` exposes it before re-enabling.
- TV's `merge up/down` = adjacent-pane merge computed from pane order — implementable on top of `chart.panes.list()`.
