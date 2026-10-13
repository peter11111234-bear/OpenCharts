# Pine Incremental Live-Tick Execution — 2026-10-11

## 問題
每個 live tick → `notifyBars` → 全量 `runScript` 500 bars。K4.55 ~5ms/bar →
每 tick ~2.5-3.5s，UI 上 = 掛死。`capabilities.streaming:false` 所以 Vela 永遠走
`mode:'static'` 全量重跑。

## 設計（TV 語意）
- 已收盤 bar 的 script state 是 final，不重算。
- forming bar 每 tick 從「上一根收盤 checkpoint」rollback 重算
  （TV 的 realtime rollback；`var` 在 forming bar 上不重複 init）。
- tape 前綴不變才走增量；bar 數縮水 / 歷史 bar 被改 → fallback 全量。

## Checkpoint / Restore 面
| 面 | 做法 |
|---|---|
| BarSeries buf | registry（session-scoped，ctor 時 tag）；snapshot `lastBar`/`firstBar`；restore 截 `buf` 尾 + 回寫欄位。新 series → `lastBar=firstBar-1` |
| buf 內 container Value | series `hasContainers` flag；只對 flagged series snapshot 可變 slot 的 deep clone（單一 identity map 保 sharing）|
| Scope.vars | Map 淺拷貝 + 每值 deep-clone（containers）|
| declSlots/declCows/declAliased/tupleKeys/paramCows/callHist/misc/ensureList/trackedSlots | 成員 + value 引用拷貝還原（var-once `fresh` 判定依賴）|
| callsites/callsiteSeq/siteTrie/siteCtx/warned | 保留 — 純 deterministic id 快取，重放重建同值 |
| ctx.state | VS `{get,last,memo}` → `last=min(k)`、memo 刪 >k（memo 提為 own prop）；`Map<number,*>` leaf → 刪 >k；純 leaf obj → clone-restore 欄位；巢狀 Map → 成員還原 |
| drawSink | objects 陣列 + nextId + 每 obj props 還原（原 obj 身分不變 — 外部 handle 有效）|
| ctx.live*/fills/fillSites/bgcolors/barcolors/alertstate/alerts | 拷貝還原 |
| ctx.plots sinks | buf 長度 + sinks 成員 |
| warnings | 保留（warned dedup）|
| jit/udfJit/compiledBody | 跨 tick 保留 — 免重編譯 |

## 資料面
- `BarCtx` 改可變 tape：`setTape`/`updateBar`/`barCount` 動態。
- `ta.ts` VS：memo 提為 own property（vstate/vseries/wvs）。
- `interpreter.ts`：`runScriptInner` → `PineRunSession`（build/evalBar/assemble/advance）。
- worker：`run` msg 帶 `parsed`（AST clone，順修雙 parse）；worker 存 session map，
  key = source+inputs+syminfo+symbol+tf 指紋；透明 advance-or-rebuild。
- engine：`streaming:true`；`mode==='live'` 不發 onDone；token 帶 `parsed`；
  base sessionRunner 回 `{}` bag 讓 in-process path 也增量。

## v1 排除（fallback 全量）
- `decl.type==='strategy'`；body 內 `request.*` member call。
- 非可預期 shape（state 出現 class instance 等）→ 記 imprecise 仍走增量？— v1 保守：fallback。

## 驗收
- 增量 replay ≡ 全量：tick 模擬 harness（var、陣列、繪圖、ta.* 全系列、UDF、if-decl、histref）逐值比對。
- 500-bar tape × 200 ticks：evalNode 增量 ≈ 每 tick 1 bar 的量。
- suite 全綠 + golden 9/9。

## 落地狀態（2026-10-11 實作）
- `interpreter.ts`：`runScriptInner` 拆為 `buildSess`/`evalOneBar`/`assembleRunResult`；
  增量驅動 `incRunStart`/`incAdvance`/`incRun` + `checkpoint`/`restoreCkpt`/`cloneDeep`。
  committed = 最後一根收盤 bar；forming bar 每 tick rollback 重算。
- `series.ts`：`incBuf` getter；`activeSeriesSet` ctor 註冊已存在。
- `context.ts`：`BarCtx.setBar(bar, b)`（絕對索引寫入）。
- `pineWorkerProto.ts`：`WorkerOpts.incKey`；worker 內 `incSessions` map（cap 8，FIFO）。
- `pineWorker.ts`：`incRun` 驅動，`incKey` 存取 session。
- `pineWorkerEngine.ts`：`incKey` 過界，`incHolder` 留在主線程。
- `engine.ts`：`incKey = modelId|sym|tf|inputs|syminfo`；in-process 走 `incRun` + `incHolder`。
### 差異修正記錄
- committed 語意改為「最後一根 closed bar」——forming bar 的 tentative 狀態
  不可入 checkpoint（單 checkpoint 下 committed bar 值變化無法回滾）。
- advance 順序：restore → commit loop → setBar(last) → evalOneBar(last)。
  （原稿「commit 後 restore」會把 forming 殘值帶進 commit 評估。）
