# 直譯器拆檔 第 1 階段 執行報告
- 執行者：MiniMax 3
- 時間：2026-10-22
- 工作目錄：`C:/Users/bear9/OpenCharts-split-p1`（worktree，分支 `refactor/interp-split-p1`）。計畫中所有 `C:/Users/bear9/OpenCharts` 路徑皆改用此 worktree，未進入、未讀寫、未在原目錄執行任何指令。

## 開工前檢查
- HEAD=`ec232c7`（`git rev-parse --short HEAD`）；`git diff --quiet ec232c7 HEAD -- src/pine` → exit 0。
- `git status --short src/pine` → 空（輸出為空）。
- `ls src/pine/astUtil.ts src/pine/scriptDecl.ts` → 兩者皆 `No such file or directory`（ls exit=2）。
- 新檔不存在＝是。
- 額外確認（不修改任何東西，只比對）：`src/pine/interpreter.ts` 的 LF 正規化 sha256 於 `ec232c7` 為 `5627bf5b708a55bbbace983e8f535c826ef3aebbf462d889d00b28b2c19bc7ab`，與計畫釘選值一致。
- 時段限制：依使用者指示，worktree 隔離故不適用本次。

## 步驟 2 輸出
```
src/pine/astUtil.ts: 119 lines moved
src/pine/scriptDecl.ts: 116 lines moved
src/pine/interpreter.ts: 4084 -> 3850 lines
```
（與計畫預期三行完全一致，含數字。）

## 3.1 verify
```
VERIFY OK: moved verbatim, no lines lost or duplicated, no other src/pine changes
```

## 3.2 tsc
- `npx tsc --noEmit` → exit code 0，無任何輸出。

## 3.3 匯出名單
```
PineRuntimeError,__callHistWrites,__compileCalls,__compiledKinds,__evalNodeCounts,__pineJitStats,astChildren,callsiteKey,collectInputs,evalBlock,evalExpr,incAdvance,incRun,incRunStart,pineStr,registerMtf,resolvesFromCtx,restoreCtxState,runScript,snapCtxState,yieldStats
```
與預期相同＝是（逐字一致）。

## 3.4 vitest
```
 Test Files  105 passed (105)
      Tests  1360 passed (1360)
   Duration  421.04s
```

## 3.5 bench
- before（`split-p1-before`）direct：`run` median = 4738.03 ms，`total` median = 4762.51 ms。
- after（`split-p1-after`）direct：`run` median = 5021.45 ms，`total` median = 5045.28 ms。
- `--compare split-p1-before → split-p1-after`：direct `run` Δ = +283.42 ms（**+6.0%**），direct `total` Δ = +282.77 ms（+5.9%）；app `total` Δ = +13.5%；工具回報「總最大差異 13.46% → 重複性(<15%) PASS」。
- 判定：direct `run` median 變慢 6.0%，遠低於 30% 門檻 → 非異常，屬機器量測雜訊範圍（計畫 3.5 說明本機同設定可差 20% 以上）。
- 附註：counters（mtf.evals / mtf.hits / evalNodes / callHistWrites / compile.calls / setAt / ensureBar）before 與 after 完全一致；model digest app/direct 皆為 `3huclf`（match PASS）。

## 有沒有做計畫以外的事
沒有。全程未手改任何 `.ts` 檔；程式碼變更僅由 `python -I scripts/refactor/split_interpreter.py` 產生。未修改 `scripts/refactor/` 下任何腳本。未跑 `npx eslint`。未 commit、未 push。未修改 `src/pine` 以外原始碼（僅新增 bench JSON 與本報告檔）。

## 工作區狀態（供驗收比對）
```
 M src/pine/interpreter.ts
?? bench/
?? docs/superpowers/plans/2026-10-22-interpreter-split-phase1.md   （計畫檔，本次執行前即存在於 worktree）
?? scripts/refactor/                                                （計畫腳本，本次執行前即存在於 worktree）
?? src/pine/astUtil.ts
?? src/pine/scriptDecl.ts
```
