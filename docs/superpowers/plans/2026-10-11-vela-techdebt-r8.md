# Vela Tech-Debt Round 8 — Implementation Plan (v2, post-review)

> **日期:** 2026-10-11
> **For agentic workers:** REQUIRED SUB-SKILL: task-workflow (P0-P9). Steps use checkbox (`- [ ]`) syntax.

**Goal:** 修 R7 遺留的三個技術債 — (1) ext blob 加 `origin` 欄位讓手動加的 manifest-source external 可 round-trip,(2) pendingAdds 換單調時鐘,(3) double-restore 的 claim 競態。

**Architecture/Patterns:** 既有 dedup 路徑在 `velaPineEditor.ts` 的 `serializeCellScripts`/`restoreCellScripts`(cell-scoped `registerStatePersistence` for `opencharts.pine-scripts`)。ledger = vela 自己 manifest-seeded 的 indicator store;ext blob 只放使用者手動加的 external 指標。

## 三個修復點

### 1. ext blob `origin` 欄位
- `SavedScript` 加 `origin?: 'external'`。
- `serializeCellScripts` 每個 external entry 標 `origin: 'external'`。
- `restoreCellScripts`:
  - `e.origin !== 'external'` → 保留舊邏輯(`ledgerScripts.has(normScript(e.script))` skip)。
  - `e.origin === 'external'` → bypass ledgerScripts skip;**且** `hit` claim pool 限縮到 external live handles(`preexisting.filter(h => isExternalHandle(...))`) — ledger-owned row 不能吞掉使用者的 add。
- 相容性:older blob 無 `origin` → fallback 舊行為;older client 看到 `origin` 欄位直接忽略(additive-safe)。

### 2. pendingAdds 單調時鐘
- 4 處 `Date.now()` → `performance.now()`(sweep 的 `nowSweep`、merge 的 `now`、pending push 的 `at`)。
- 原因:NTP/wall-clock 跳變在 30s TTL 內會誤剪 live 條目或復活過期條目。
- 全部都是 page-context(非 worker),`performance.now` 存在。

### 3. double-restore claim
- `inFlightAdds: Set<string>`,key = `cellId | normScript(script) | e.id | inputsSig(e.inputs)`。
- 每個 entry 在 `addIndicator` 成功後,claim 先入 `newClaims`(per-call staging),**loop 結束才批次進 `inFlightAdds`** — 同 payload 內 N 份相同條目全放行(serializer 靠 per-handle `consumed` set 支援),但**第二次 restore** 遇到已在 `inFlightAdds` 的 key 就 skip。
- Claim 釋放:
  - covered(serialize merge 時 live handle 命中)→ `releaseClaim(cellId, entry, still)`
  - expired(TTL 過期，被 `pend.filter` 剪掉)→ 同上
  - dead-cellId sweep→ 同上
  - bind/unbind(new ws)→ `inFlightAdds.clear()`
  - twin-aware:`releaseClaim` 只在 `remaining` 裡沒有同 key 的 entry 才 `delete`。
- 為什麼不用 ws-identity key:同一 ws 同一 cellId 也可能連續 restore 兩次(applyState),claim 必須活到 pending entry 落地或過期，不是活到 ws 結束。

## 驗收標準(code + jev)
- [ ] `serializeCellScripts` 產出的每個 entry 帶 `origin: 'external'`。
- [ ] restore:`origin:'external'` + script==manifest → `addIndicator` called;`origin` undefined + script==manifest → skipped。
- [ ] restore:`origin:'external'` entry 只被 external live handle claim,ledger-owned handle 不 claim。
- [ ] 同 payload 兩份相同 script 全 `addIndicator` ×2。
- [ ] 第二次 restore(same cellId, same payload, handles 未落地）→ skip(addIndicator total 仍 1)。
- [ ] pending entry 過期後 re-restore → re-add(claim 已釋放)。
- [ ] `Date.now()` 在 velaPineEditor.ts 歸零。
- [ ] bind/unbind 清 `inFlightAdds`(StrictMode 兩 ws 互不染)。
- [ ] 全測綠(vitest run 全 suite)。

## 回滾路徑
- 全部邏輯在 `velaPineEditor.ts` + 新測試檔 `src/pages/__tests__/persist.test.ts`。
- `git revert HEAD` 回滾整輪；或單獨 revert `origin` 欄位（另兩個修復不互相依賴）。
- `inFlightAdds`/`pendingAdds`/`localClaims`/`releaseClaim` 是 in-memory，重開 page 即歸零。

## 非目標
- 不動 ledger 本體(`pineLib.ts`)、`velaLayouts.ts`、worker。
- 不動 TradingView 對齊 pipeline(`docs/TV_ALIGNMENT_PIPELINE.md`) — 那是另一個工作流。
- 不動 `public/monaco/`(untracked，非本次產出）。
