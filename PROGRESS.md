# TV-ALIGNMENT PROGRESS
- 17:44:16 plan saved: docs/superpowers/plans/2026-10-05-tv-alignment.md (13 tasks, D1-D5)
- 18:07:33 inline edits done: T4 barstate, T5 siteStack+evalArg, T6 siteKey (stable keyCache), T8 primitive method dispatch, T9 prefetch frame0+plot offset shift; interpreter.test 32/32 green
- 18:12:55 T12 security_lower_tf implemented in mtf.ts; na() literal-callee dispatch fixed; strategyDecl wired
- 18:17:39 StrategyAgent done (14/14 strategy tests); strategyDecl wired; security_lower_tf implemented; K455 e2e passes with warn-only NaN coercion
- 19:03:58 e2e: 8/8 pass; remaining warns diagnosed — runConst globals/staticEnv fallback added (res/targetTf/execTF prefetch); ta.bb+ta.bbw added for TD_BB
- 19:25:00 session resumed after crash; root cause of e2e warn storm found: prefetch pfScope can't see UDFs + speculative globals warn — hoisted func decls into top scope (interpreter.ts:1243) + mtf.ts funcs store + scratch warnings buffer
- 19:35:00 8/8 scripts warn-free (TD_BB/TRIS390/MACD701/turtle/高量/macdV7/macd72: warns []); K455 1 benign dedup warn; array/request warns deduped; e2e asserts added (warns≤3, minPlots, minDrawings); 300/300 unit tests green
- 20:50:00 QA: 429 殺掉 10 subagent → 手動替代驗證：strategy/util 未註冊進 index.ts 已修（turtle 回歸綠）；ta golden (sma/ema/rsi/macd/nz/na) 6 plots 無 warn；error-path 6/6 受控（undef→warn+na, oob/div0/plot(na) 不 crash, y:=5 正確 throw）；perf K455 50/100/200 bars = 847/1282/2979ms（~線性偏超，contracts.ts:57+series.ts:53,88 unshift O(n²) 待優化）；已知缺口：engine.ts 不存在、runScript 無 app 呼叫端（Vela 走舊 pinets worker）
- 21:12:00 engine.ts 缺口補上：PineInterpreterEngine 實作 ScriptingEngine（prepare/collectInputs+decl meta → execute/runScript → IndicatorModel：line/histogram/markers/hline→priceLines/plotbar-candle/barColors/bgcolors/fills→fills+backgrounds/drawings→lines-boxes-labels）；VelaPage engines.pine 切到 InterpreterPineEngine；smoke MACD701/K455/TRIS390 全過；unit 291/291 綠；fills/backgrounds 映射 + line/label/box 細節待補
- 21:08:09 MTF QA: scripts/qa_mtf.mjs 9 cases（lookahead on/off、gaps_on、close[1]、UDF、tuple、global g/g[1]）→ 1 finding：tf ctx series 用 plain Series（LIFO，get(0)=最新載入 bar），global[n] 內層讀 j-off<頭時讀到最新 bar；修：tf series 改 BarSeries + setAt(絕對 bar)，evalAt 加 j<0→na guard；mtf.test 回歸 +1（14/14），全套 360/360 綠
- 22:14:21 ULTRA-QA（5 子代理）→ MTF 修正本身 PASS；另找到 BUG-1 UDF 內裸 tf series 讀 chart series、BUG-2 巢狀 global 失去 tf 語意（皆靜默錯值）、F1 input.* defval 被 series 包裝污染（input.int→NaN、input.bool(false)→true、schema defval='close'）。已修（用戶核可範圍）：mtf.ts 於 tf scope 以 TfGlobalSeries 影子化全域+以 spec.scope 為 closure 影子化 UDF，evalAt 還原 barIndex；input.ts 加 unwrapped 於 scalarInput/input.time/generic input。新增回歸：mtf.test UDF/巢狀global(+1)、output.test 包裝 defval(+2)；全套 364/364 綠；TRIS390 驗收：stLine-* 由 200 假值→0、55日高/低由 0→445、warns 0。待決：高量1.46 因 input 修正而新觸發 3 個 drawing-on-na warning（e2e 上限=3，根基層非本次改動）
- 2026-10-06 REVIEW R2 (6 subagents: CoreInterp/MtfReview/TaReview/BuiltinsReview/EngineReview + 2 free-model audit/adversarial): 模組切片 review，確認的 P0/P1：
  - **P0 engine.ts**: buildModel 丟棄全部繪圖輸出 — `r.drawings`/`fills`/`bgcolors`/`barColors` 算出但從未進 IndicatorModel（RunResult 連 fills/bgcolors/barcolors 欄位都沒有）。e2e 只測 runScript 沒測 buildModel → acceptance「K455 drawings render」實際壞。
  - **P1 語意**: `:=` 寫穿 UDF param alias → 污染 caller series（含 builtin close）；evalHistref 無 siteKey → UDF 內 `(expr)[n]` 跨 callsite 歷史互串；int/int 除法截斷（TV 5/2=2.5）；% 用 trunc 非 floor（TV -7%3=2）；na 比較回傳 na/true 而非 false；UDT registry 跨 run 不清。
  - **P1 strategy**: strategyDecl 死代碼（parser 把 decl 抽出 body，runScript 只跑 body → process_orders_on_close 等設定全部失效）；`when=` 綁了不讀；`immediately=true` 因 evalArg series-wrap 永不觸發；limit+stop 同 bar 雙觸發（應 OCO）；partial exit 虛增 closedtrades。
  - **P1 MTF**: nested evalAt 讓 stateful builtin 讀到 lastBar 而非 ctx.barIndex → `security(sym,tf,g[1])` 洩漏未來 bar；chartDur=t0-t1 跨資料缺口 → security_lower_tf 多吃後續 bar + lookahead_on 洩未來；security() 在 UDF 內 spec.scope 綁死第一個 caller frame；invokeUdf 不處理 series alias/ReturnSignal。
  - **P1 builtins**: pivothigh(src,l,r)、highest(N)、bb/bbw(mult) 因 evalArg series-wrap 全部恆 na；ta.kc 位置參數順序錯+RMA而非EMA；timestamp(tz,...) 恆 na；bare hour/dayofmonth 是 function 非 series；time(tf) 忽略參數；a[na] misparsed（histref 丟失）；plot 在 local scope 不擋（CE10188）+ sparse sink buf 時間軸錯位。
  - **覆蓋率缺口**: ScriptingEngine contract 完全無測試；e2e 全是 smoke count 無 golden values；security_lower_tf 零測試（plan T12 要求有）；zz*.test.ts 是無 assert 的 probe 計入通過數。
  - **對抗性**: int/int、%、na 比較已列；另 `nz`/`math.sum`/liftNums 回傳 raw Series → bindDeclared 存 wrapper → plots 輸出 `{kind:'series'}`；`"str"+na` 回傳 na 而非 "strNaN"。
- 2026-10-06 12:20 FIX-ROUND-2 (verification agents: LingEngine engine contract 32/37 pass): fixes landed —
  * interpreter.ts: `varip` decls emit warn-once (realtime-bar persistence not implemented, v1 scope)
  * color.ts: rgbaOf unwraps series-wrapped color Values (evalArg wraps scalars → color.new(colour=series-color) was returning na)
  * plot.ts/engine.ts/contracts.ts/util.ts: bgcolor/barcolor → per-callsite layers Map<bar,Map<site,color>>; na clears own layer only (TV: each bgcolor() = separate layer); engine flattens last-wins; output.test +1 layer regression
  * ta.ts: ta.wad/ta.pvt/ta.nvi/ta.pvi bare-variable lazy constants (TV: these are variables, not fns) — shared vstate accumulators via 'bare' key; probe_bare_ta.test.ts added
  * engine.ts: alignOf/valignOf strip align_/valign_ prefix (textAlign/hAlign/vAlign were always left/center); display.none gates hline/bar/candle/line-like branches; buildModel inputOverrides param → inputValues reflects session.update(); plotarrow sign → position aboveBar/belowBar
  * plot.ts: plotarrow pushes signed condition value (was anchor price → all arrows rendered arrowUp/belowBar)
  * strategy.ts + contracts.ts + interpreter.ts + engine.ts: ExecRec ledger in Sim → RunResult.execs → IndicatorModel.trades (TradeExecution: time/price/side/kind/label/qty/tradeId) — strategy executions now reach the model (was P1: zero markers/trades)
  * draw.ts: line.new color=na → props.color undefined → invisible flag works (was default blue)
  Pending: LingAdversarial MTF probes still running (found close[1]-inside-security anomaly under investigation)
- 12:30 VERIFICATION ROUND: LingEngine 32/37 probes pass → 6 findings fixed: display.none 全 branch gate（fill anchor 保留 series id）、plotarrow signed value→方向+位置、inputValues update() 生效、align_/valign_ enum 解析、line.new color=na invisible、strategy execs→model.trades。engine.test +4 regression（fill anchor/arrow/trades/inputValues）；381→382 全套綠。
- 12:55 ADVERSARIAL + REVIEW ROUND done (LingAdversarial 15/15 B probes, R2Review 5 findings):
  * interpreter.ts: time("60") builtin dispatch — bare ident falls through to BUILTINS when scope binding isn't a function value (scope-bound time BarSeries was shadowing the builtin → na + 'call target is not a function' warn)
  * interpreter.ts: CowSeries persisted per (callsite,param) via run.paramCows + rebind() — UDF `x := e` history now carries across bars (x[1] sees previous bar's reassigned value; TV semantics)
  * mtf.ts: tfAnchor restricted — tfOwned (spec OHLC series) + tfDirty (series written during tf eval) WeakSets; caller-scope chart series keep chart-bar index in get/cur/atOffset → `f(p) => security(.., p)` and UDF params inside security read the live chart value
  * strategy.ts: OCA reduce-to-zero → cancelledAt (resolveQty would refill default qty); exec ledger moved after match guard; reversal entries bump curTrade + record traded qty (|position|+qty) — tradeId round-trips correctly
  * plot.ts: plotchar default location.abovebar (TV); engine routes plotchar through markerPosOf (top→aboveBar consistent w/ plotshape)
  * engine.ts: fill() on hline plots emits warning instead of silent drop; barColors sorted by bar index (negative offsets could insert out of order)
  * probe files: probe_timefn.test.ts kept (time(tf) regression); scripts/verify_adv_*.test.ts = throwaway (vitest.probe.config.ts)
  Pending: LingAdversarial noted no module-level state pollution — dbg6 279 was its own probe's tfMsOf bug (regex empty-string ??), interpreter MTF mapping confirmed correct
- 13:02 CowSeries seed fix: params re-bound per bar via cow.seed(arg.cur(), bar) — carried-forward := values no longer leak into next bar's reads; history stays bumped. Old 'param[n] after :=' test updated to bumped-history semantics (was pinning pre-fix behavior). interpreter.test 40/40, adversarial A2+B 31/31.
- 13:25 FINAL VERIFY: npx vitest run src/pine → 386/386 green (16 files, 121s); 8/8 e2e user scripts warns [] (K455 151 drawings, TRIS390 34 plots). probes verify_adv_a2/b + vitest.probe.config.ts 保留待開發完成後刪除；src/pine 維持 staged 未 commit；'param[n] after :=' bumped-history 語意待用戶簽核。殘留缺口：table/polyline 未序列化、fill(hline↔hline) 僅 warn、strategy close_all comment 未捕捉。
- 13:50 GAP-FIX ROUND: 3 殘留缺口修復 + 1 隱性 bug。strategy.ts close_all 補 comment 傳遞；engine.ts table DrawObj → DrawingTable 序列化（cells Map→row-major grid、merges、position/frame/border）；fill(hline↔hline) 改為合成 visible:false 常數 anchor series（Vela SeriesBase.visible 語意）。附帶修：draw.ts asObj 未解 evalArg series wrap → line/label/box/table 全部 set_*/cell/delete 在直譯器路徑靜默 no-op（單測傳 raw Value 所以沒抓到）。engine.test +3 regression（hline fill/table 序列化/close_all comment）；389/389 綠，8 e2e warn-free；tsc touched-files clean。殘留：polyline.new/linefill.new builtin 本身未實作（非序列化問題）、table.all 未註冊 lazy constant。
- 16:45 FEATURE: polyline/linefill/table.all。draw.ts — chart.point{new,from_index,from_time,now,copy}（udt{typeName:'chart.point',fields:time/index/price}）、polyline.new/delete、linefill.new/set_line1|2/set_color/get_*（props 存 live DrawObj → 端點編輯自動傳播）、created() 擴六種 kind、declDrawQuotas 補 tables/polylines、linefill 佔 lines 額度；*.all lazy constant 六種全開。interpreter.ts — member-call 扁平化（chart.point.new 三層 key 才能命中 BUILTINS；scope-bound receiver 會中止扁平化）、livePolylines/liveLinefills init。engine.ts — mapDrawingLine 抽出共用，model.polylines/model.linefills 映射（points→{xloc,x,price}、fill legs 嵌入 DrawingLine）。parser.ts — `array<chart.point>` 點型別：isTypedDeclAhead/parseTypeAnn/typeArgsAhead 的 <> 掃描允許 '.'。engine.test +3（polyline 映射/linefill live legs/六種 .all）、output.test 註冊表 +11。392/392 綠，8 e2e warn-free。

- 18:40 ROUND-4 (conditional security + golden harness): MtfNaN root-caused `barstate.islast ? security(...) : na` → na — tf frame cold-start had no history for strict-window exprs. Fix: `spec.warmed` warm-up in mtf.ts replays tf bars 0..j on first hit (both ltf/non-ltf paths). final.pine A(1m)=125.1 B(15m)=142.7 C(60m)=144.6 all live on synthetic; 2 regression tests pinned (gated sma + stateful ema).
  * bindArgs series→source named-arg alias (util.ts): `ta.bb(series=…)`/`ta.bbw`/`ta.kc` silently bound nothing → TD_BB Basis/Upper/Lower all-na. Now 481/500 live. +2 tests.
  * golden harness landed: src/pine/__tests__/golden.ts (canonical RunResult→JSON, Map/Value/udt/drawings) + golden.test.ts (10 scripts incl. final/norm2 dynamic security) + scripts/golden/*.golden.json baselines. UPDATE_GOLDEN=1 regenerates; compare writes .actual.json + first-diff path on mismatch.
  * agent landings: TablePolySerialize (table/polyline DrawObj → m.tables/m.polylines, cells Map→row-major ModelTableCell[][]; +tests), FillHlineBand (fills dedup per callsite via ctx.fillSites — RunResult.fills shape changed, golden regen owed), SelfRefGate (:= on undeclared ident errors BEFORE rhs eval, PineRuntimeError), CloseAllComment (already complete — +2 pin tests), AlertcondExit (alertcondition → RunResult.alertconditions; Vela model has no field), VarTupleFlag (var [a,b]=f() persistent declSlot; non-var unchanged).
  * DeltaReview findings queued for R5: tf-domain series leak at evalAt (P1), invokeUdf CowSeries bypass, callUdf no-callNode CowSeries verbatim, nodeCache ephemeral-scope misses.
  Pending: R5 in flight (7 agents — strategy perf surface, 3 MTF findings, method-on-builtin-type, delta review). Golden regen owed after R5 lands (fills dedup + alias + warm-up all shift outputs).

- 20:25 R5 landed + ROUND-5 review fixes:
  * StrategyPerf (29/29): profit_collector/openprofit/netprofit + gross/netprofit ledger (FIFO, commission 分攤); strategy.equity/max_drawdown new module (per-bar mark-to-market, lazy ORDERS_KEY only, incremental cache invalidates on orders.length).
  * MtfSeriesLeak (P1 fix): evalAt series results now wrap in SecSeries — chart-anchored, lazily snapshotted non-BarSeries sources, writes warn+drop. SecSeries.atOffset/get delegate to spec.chartHist (chart-domain emit history) — security(...)[n] reads previous CHART bar per TV spec, not previous tf bar. My follow-up fix: emit/emitAll + chartHist/lastChartBar on SecuritySpec, resetTfFrame clears both, gaps_on skipped bars emit NA into chartHist. mtf.test.ts CHART-domain history test rewrote expectations (previous-chart-bar semantics; reads must happen inside the bar loop — cached SecSeries shares one object per tf period, get(n) is newest-relative).
  * MtfUdfP2: local CowSeries mirror per UDF invocation (copy-on-write, no param leak into caller UDF); nodeCache routed through per-invocation transient Map until caller scope proves itself stable (graduates to durableCache on second sighting — ephemeral scopes can never hit cross-bar).
  * CowSeriesP2: interpreter callUdfValue no-callNode branch wraps series args in fresh CowSeries per call — UDF `:=` on method param can't mutate caller's series history.
  * MethodBuiltinType: normalizeSelfType() strips series/simple/const/input + generic type params (array<float>→array, map<string,int>→map); parser tracks generic depth so `map<string,int>` in params doesn't split on the comma; array.m/map.m suffixes registered.
  * Round5Review findings fixed: (a) table cell Map keys — non-integer/NaN col/row guard before grid indexing (was RangeError risk); (b) bindArgs named-arg collision warn — `ta.sma(source=,series=)` now queues a warning via bindWarnQ, drained + deduped in callBuiltin.
  * Golden regen done (UPDATE_GOLDEN=1, 10/10 regenerated — fills dedup + alias + warm-up + chartHist all shift outputs). e2e 10/10 warn-free.
  Final state: 421 non-e2e tests + 10 e2e + 10 golden all green. Pending: probes verify_adv_a2/b + vitest.probe.config.ts 保留待開發完成後刪除；src/pine 維持 staged 未 commit。
- 20:52 MTF BOUNDARY PROBE (handoff slice): src/pine/__tests__/mtf_boundary_probe.test.ts — 8/8 pass, zero exceptions. Per-case observed:
  * C1 j<0 guard g[1]: [na×8, 1000×4] — first completed HTF bar emits na (no stale number).
  * C2 g[9] beyond history: na×12, no throw.
  * C3 dynamic tf not prefetched: mid-run '60'→'120' switch → na for '120' leg + EXACTLY ONE 'not prefetched' warning; str.tostring(close) variant → 29 distinct messages, each deduped ≤1 (29 total, all unique — bound holds).
    FINDING: `request.security(sym, timeframe.period, close)` is NOT a prefetch miss — bar0 runConst resolves '15' and it IS fetched; values flow, 0 warnings. The case's expected 'na+warning' only triggers on genuinely unresolvable/unfetched dynamic tfs.
  * C4 input.timeframe("60") dynamic: resolves, [na×4,100×4,101×4], 0 warnings.
  * C5 empty HTF fetch []: na×12, 0 warnings, no throw.
  * C6 HTF shorter than chart (2 tf bars / 30 chart bars): [na×4, 100×4, 110×22] — lookahead_off carries last completed tf bar; tfBarEnd/tfNext no crash on last bar.
  * C7 gaps_on+lookahead_on: [100,na×3,110,na×3,120,na×3] — first chart bar per DEVELOPING tf bar emits.
  * C8 chart before first HTF bar (chart t=-2h, tf t=0): [na×12, 100×4, 101×4] — na until first tf bar completes.
  Probe file kept (throwaway per hygiene); pending commit decision unchanged.
- 2026-10-07 UI/INPUT ROUND (Vela UX + color pipeline):
  * BUG FIX `input.ts` — Vela input panel sends `''` for untouched color/string inputs; coerceOverride wrapped it as `{kind:'color', v:''}` → canvas `strokeStyle=''` silently invalid → inherited previous stroke → WHOLE LINE RENDERED BLACK (the "黑粗線" user reported on V6.7 fast MACD). Fix: `''` treated as no-override for color+string kinds → script defval survives.
  * NUMERICS VERIFIED: on real 2330 5m bars (1045), ta.ema/ta.macd vs reference impl max|diff| = 0.000000; isEma20Neg 48.4% / isDarkDashed 30.3% identical to reference — the maroon segments are the script's own design, not an engine bug. per-bar color pipeline proven via alternating-color probe (renders red/green per bar) + perbar_color_macd dump (快週期MACD線 = [#00FF00,#800000,#FF0000] — TV-identical tri-state).
  * `velaPineEditor.ts` UI rework (TV-parity, user-requested): Pine dialog now lists 圖上指標 — click name loads source into editor (verified, full 59k V7 source), ✕ removes (verified, live rebuild). scriptTitle() helper handles `indicator(title="X")` named-arg form (was: showed "Indicator"); 3 call sites deduped. histKey CJK fix — `[^\w]+` slug destroyed Chinese titles (all → same key), now encodeURIComponent-based. Legend icon ids fixed: `pen`→`edit`, `move-vertical`→`move` (bad ids rendered blank buttons); removed my duplicate remove/visibility actions (Vela built-ins already provide eye/gear/✕).
  * Verified: interpreter.test 45/45, builtins.test 57/57, engine.test 15/15, perbar_color 1/1, perbar_color_macd 1/1 (dump confirms tri-state colors), e2e MACD雙周期V7 22 plots 0 warns. tsc clean on velaPineEditor.ts. golden.test.ts times out (>300s, pre-existing — not from this round's files).
  * Known limit: legend action icons verified in bundle API (iconAt('edit')/'move' exist, provider auto-wired chunk-DBDXKZUF.js:9204) but browser automation died (CDP timeout) — hover reveal not visually confirmed.
  * Pending: user tests legend hover icons; commit decision still open; V7 與 TV 視覺差異 user 比對中。
- 2026-10-07 PINE EDITOR TV PARITY ROUND (6 tasks + 3×QA + 3×code-review):
  * NEW `src/pine/lib/pineLib.ts` — script library: CRUD + version history (cap 20) + MRU (cap 4) + legacy `pine-hist:*` migration + subscribe. localStorage `opencharts.pineLib`.
  * `velaPineEditor.ts` rewritten — TV header [Pine Editor|name ▾|reload|Add to chart|Save|Publish|⋯|—|✕], textarea monospaced, statusbar [圖上指標 list|msg], dirty tracking, Ctrl+S save / Ctrl+O open / Escape close, name menu (Save/Copy/Rename/Versions/Create new/Recently used ≤4), collapse→sessionStorage draft, overlay→doc.body (ctx.host dies on cell:destroyed).
  * `velaPineScriptsDialog.ts` NEW — Ctrl+O dialog: search, ★fav toggle, row ⋯ menu (Rename/Duplicate/Export/Delete), MutationObserver cleanup.
  * Legend ⋯ callout — 15 TV items: 新增快訊*/增加指標*/整個版面*/收藏/視覺順序*/時間週期*/移動到*/固定至刻度*/原始碼/複製/隱藏/移除/物件樹*/設定 (*=disabled-look `· xxx（暫不支援）`); Pine vs native gate via `ind.source`.
  * `pineScripts.ts` +`combinedManifestEntries()` merges library→indicators manifest; `VelaPage.tsx` wires it.
  * QA round (3 agents): fixed `renderer.openIndicatorSettings` path (was dead `ctx.chart` lookup), runIndicator `{ok,error}` contract (was dead try/catch), stale currentId cross-script leak, 'remove'-event unsub leak, unregistered `edit` icon, phase-3 stubs → disabled-look, copy toast.
  * Code-review round (3 agents): fixed scriptId param (openPineEditorWithScript set currentId then openEditor reset it — regression from QA fix), mutation-before-open-guard removed from all 3 entry points, `open` latch desync → MutationObserver resets, popup menus ghost-on-close → `openMenus` tracking + closeModal sweep, **dialog empty-shell critical**: `dialog.append(head, searchWrap, list)` was missing, stale handleId re-add now updates id, clipboard reject → error toast not false success.
  * Known-not-fixed: isOverlay regex misses `(` in title; updateCode fails via 'error' event w/o UI feedback; confirm/prompt no headless fallback; popupMenu ×4 duplication deferred; corrupt localStorage JSON → silent empty (no backup key).
  * Commits: 359d70b (pineLib), ebe6a60 (chrome+callout), 2d63af8 (QA round), fe5fc03 (code-review round). tsc clean after each.
  * GOTCHA: PowerShell `Set-Content` defaults UTF-16 → corrupted velaPineEditor.ts mid-session; recovered via `git checkout` (lost uncommitted review fixes, re-applied). NEVER use PS -replace|Set-Content for code edits — use the edit tool.
  * Pending: user visual verify — Ctrl+Shift+R → legend ⋯ 15-item callout, Ctrl+O dialog (empty-shell fix), V7 vs TV diff per docs/TV_PINE_EDITOR_RECON.md.
  * Fix-verification (agent, this session): scriptId chain VERIFIED end-to-end — `openEditor(ctx, initialSrc, editingId, scriptId)` param is authoritative; single write at initializer `currentId: scriptId ?? (initialSrc ? null : editorState.currentId)` (velaPineEditor.ts:329); draft restore gated on `!currentId` so passed id can't be clobbered; plain open keeps currentId as deliberate "resume last script"; Save null→create / non-null→writes only that entry. Residual minors (won't fix): kept id→deleted script = empty buffer until Save throws 'script not found'; orphan dialog onPick can pre-select next session's id — consistent, low-risk.

- 2026-10-07 PINE PERF ROUND (TRIS390 21s→~4.2s @100×15, 24.8s→~15.2s @300×15):
  * Goal: TRIS390 (1772 lines, 22 request.security, f_supertrend UDF) was too slow for Vela page — 300-chart-bar run took 24.8s.
  * LANDED CHANGES (all in src/pine/, verified 21 files/448 unit + 10 golden green):
    - series.ts: `seriesHooks` {anchor,touch} seam; `ForwardingSeries` base (delegates reads to readTarget()); `LiftedSeries` — lazy per-bar evaluation for lifted builtin args (memo + carry-forward ring, exact eager semantics); `freezeReader` produces offset-frozen readers.
    - math.ts: `liftNums` uses freezeArgs/seriesFromOffsets lazy path when any arg is series → per-tf-bar work instead of full-history re-eval per chart bar.
    - interpreter.ts: `CowSeries` → ForwardingSeries + `seed()` (param := semantics unchanged); siteKey interned as object identity via siteIds map (kills per-arg string building in UDF calls).
    - mtf.ts: installs seriesHooks.anchor/touch as tfAnchor/tfDirty-aware versions so frozen readers resolve like a live get(i); CowSeries import switch.
    - ta.ts: `emaVs` memo → iterative backfill loop (was recursive-chain O(depth) per miss).
    - util.ts/builtins: bindWarnQ/drainBindWarnings plumbing (from prior round, kept).
  * ENGINE REVERT: engine.ts toFetch span-based fetch-limit rewrite ATTEMPTED then REVERTED to HEAD (4× chart bars). It broke `final` golden (dynamic tf="1" not prefetched) — root cause turned out to be my `warned` clobber, but engine change untested independently; left at HEAD. The 4× multiplier remains THE remaining O(n²) lever for HTF warm-up (22 specs × up to 1200 tf bars each).
  * FIXED BUG INTRODUCED THIS ROUND: `runOf` RunState lost `warned: new Set()` during siteIds edit (edit tool dropped a trailing line) → warn() crashed "undefined.has" → tryEvalSecurity dynamic-miss path died → misleading "not prefetched" golden diff. Restored; final/norm2 green.
  * GOLDEN REGEN: scripts/golden/*.golden.json regenerated with UPDATE_GOLDEN=1 (they were untracked, previously generated 22h ago; HEAD-stashed regen briefly produced baselines missing alertconditions/drawings — those were the committed-era artifacts, current tree's untracked goldens were overwritten twice and now encode CURRENT behavior. Verify no semantic drift slipped in if suspicious diffs appear later.)
  * BENCH (.bench/real.bundle.mjs, warm runs): 100×15: 11.8s→4.2s (-64%); 300×15: 24.8s→15.2s (-39%). First-run JIT variance up to ~21s at 300. Remaining profile (300-bar): evalCall 78% / evalNode 62% / BarSeries.get+atOffset ~24% / orig (LiftedSeries fn eval) 15% — mostly genuine per-tf-bar UDF work, near floor without per-bar compiled closures.
  * PENDING: (a) Vela page browser verification with TRIS390 (page still untested — bench proves interpreter, not UI surface); (b) UI responsiveness during 4-15s runs — no yielding added; if page freezes, consider chunked warm-up via evalAt batching + setTimeout yields; (c) engine.ts toFetch 4× limit is still the largest remaining lever — needs span-aware sizing + golden verification done as ONE committed change this time; (d) scratch cleanup: dbg*.mjs/*.cpuprofile at repo root, .bench/* harness kept.
  * UI NOTE: interpreter runs synchronously on main thread (no Web Worker anywhere in src/pine|src/pages). A 4.2s (100-bar) TRIS390 run will visibly stall; 300+ chart bars ~15s+ is a hard freeze. Options for next session, in order of effort: chunked evalAt/UDF dispatch with setTimeout yields (smallest change, keeps sync semantics), or Web Worker w/ structured-clone model output (bigger, isolates stall). Verify the actual stall via browser once the Pine indicator is added to a Vela chart — Pine editor entry was not findable in the DOM during smoke (Indicators menu only lists built-ins; Pine editor may open via plugin registry path not reachable in this session).

- 2026-10-07 PINE RESPONSIVENESS ROUND (freeze 12.3s→0.24s; starvation fix):
  * Verified in real Vela page (Chromium tab, /vela, 2330 5m): TRIS390 Add→complete ~10s, legend renders TIRS v3.87, main-thread maxGap 12,279ms→237ms. Pending (a)+(b) done.
  * interpreter.ts — bar loop yields to event loop when a bar batch exceeds 16ms (`yieldTask`, per-yield self-closing MessageChannel). MessageChannel GOTCHAS (both observed live): `addEventListener` alone does NOT start the port in Chromium — must assign `port.onmessage`; a persistent channel pins Node's event loop forever (bench process never exited) — hence one channel per yield, both ports closed on delivery.
  * interpreter.ts — `RunOptions.shouldAbort` + `runScript` global mutex (`runScriptTail` chain). REQUIRED for correctness once yields exist: UDT_REGISTRY/bindWarnQ module state can't interleave two live runs.
  * interpreter.ts — `siteStack: string[]` restored to RunState interface (field was in object literal but interface lost it — same class of drop as `warned` in R8; tsc now clean on src/pine/*).
  * interpreter.ts — exported `yieldStats {hops,maxWait}` diag; `__pineStage` global marker ('prefetch'/'barloop'/'assemble') for browser debugging. Keep both.
  * engine.ts — execute() rewritten: single-flight `drain()` + `pending` coalescing (only latest request kept while a run is in flight). `shouldAbort` fires ONLY on `stopped` — superseded runs finish AND emit (runId only bumps at drain iteration / stop(), so myRun guard is effectively stop-only); pending re-run right after carries latest bars+inputs. Live ticks would otherwise starve completion forever (observed: "Running…" for 220s+).
  * ROOT CAUSE of "Running…" hang observed pre-fix: yielded run wakes → tick already queued → shouldAbort kills run → empty() → no onDone → status stuck, forever under tick stream.
  * Verified: 21 test files / 451 tests green incl. golden 10/10 (TRIS390 34s, final 15.5s). tsc clean on src/pine/{interpreter,engine,series,mtf,contracts}.ts (rest of repo has pre-existing unrelated errors).
  * Known: restoring persisted indicators shows title "Indicator" until their model lands — workspace restore path not yet verified end-to-end (separate from Add flow, which works).
  * ROUND-3 QA + code-review fixes (commits 475004b): post-prefetch shouldAbort check (stopped run no longer pays full MTF fetch); drain() try/finally + guarded onError (throwing handler no longer zombies the session — running stuck true forever was reachable via parse-error path); toFetch degenerate-span fallback clamped to FETCH_CAP; golden.test.ts CRLF-normalized compare (stored goldens are CRLF, raw === always failed — "no diff found" false-positive storms); tsconfig lib += ES2024.Promise (withResolvers was only typed via parent-dir @types/bun fluke); bench tfMs fixed for Pine letter units ('15M'=months was NaN → HTF fetch silently skipped → real 300×15 now 6.3s vs fake 8.5s).
  * Span-aware toFetch landed: tfFloor/tfNext calendar-aware span count + FETCH_WARMUP 500 + FETCH_CAP 20000. Bench (fixed tfMs): 300×15 = 6.3s, 100×15 = 4.69s. Per-tf limits on 300×15m chart: 15m→800, 60m→576, 4H→520, D→505, W→502, M→502 (was flat 1200 for all).
  * Known-not-fixed (deferred, all documented by QA/CR): nested runScript via fetchSeries would self-deadlock the mutex (embedder contract, not reachable today); Pine-level while(true) still wedges all sessions behind mutex (widened blast radius of already-fatal case); shioaji getBars ignores BarRange.to when chart is historical (provider-level defect, separate ticket); restore-path legend title stays 'Indicator' (vela-side naming gap, pre-existing); superseded-run stale emit = one frame lag by design; E2 parse-per-run sync cost on tick storms (cache AST on PineToken candidate).
  * Verified: 23 test files / 473 tests green incl. golden 10/10; QA test files qa_yield_c560c0f (13) + qa_errorpath_c560c0f (9) kept as regression coverage.

- 2026-10-08 MTF METHOD-2 (caller-agnostic evalAt cache) — CONVERGED, 15 commits (1e4a902→8823278):
  * Landed: agnostic (node,j) cache with exprSafeForAgnostic gate (bound/varBound/fresh/rebound tracking, producerSafe transitive walk, udfSafe inStack); trackedSlots/ensureBar membership pruning (ensureBar 72000→60000); TRIS390 gate 73 pass/21 fail, evals 5988→1879; golden TRIS390 deterministic PASS.
  * QA/CR fixes folded in: global-callee bypass, transitive producer leak, param defaults, UDF break 3 escape paths, var := shared mutation, member/index aliases, := rebind taint, nested index, merge-order hole (CR3 probe-verified).
  * Test hardening commit 8823278: value assertions on reject/pass paths, gate coverage gaps (var-multi, writes>0 producer, switch-in-expr, nested request.*), promoted scratch sweeps → mtf_invariance.test.ts (T1-T8/N1-N6), alias_repro.test.ts.
  * 代辦事項 (next rounds):
    - input.source alias write-through (PROGRESS R2 P1): `x = input.source(close); x := 999` corrupts ctx.close — pinned as it.fails in src/pine/__tests__/alias_repro.test.ts; UDF-alias variant already fixed (regular it regression guard).
    - golden e2e `final`/`norm2` fixture ENOENT — pre-existing, unrelated to cache work; regenerate or restore scripts/golden fixtures.
    - Method 1 (transpile) — planned in a separate session; agnostic cache layer stays useful either way.
    - scratch/ kept tools: gate-rate.mjs (TRIS390 gate tuning), perf-probe.mjs (setAt/ensureBar counters), scratch_probe.test.ts (untracked CPU-profile harness, machine-local).
  * Suite state: 552 pass / 2 fail (the two golden fixture ENOENTs above).

- 2026-10-11 VELA R9 — phase-3 menu + B3 pinets port (commits e004144→14e5691):
  * Legend ⋯ (data-legend-action="pine-more") now TV-shaped: 移到 ▸ submenu (上移一層/下移一層/合併至 ▸ 列現有 pane via handle.moveTo({pane:id})), 物件樹 via registerSidePanel + objtree icon, 編輯入口保留. 固定至刻度/視覺順序 kept disabled — vela 無 indicator-scale-assign / z-order API (verified vs SDK .d.ts + charting-lib source).
  * REA CDP: Chrome @9222 remote-debugging 接通, inspect_web_page + capture_browser_scenario 可用; analyze_web_bundle hits MCP 30s timeout on 335-script page — chunk 下載路線取代.
  * B3 port: 68 ta methods from pinets-src into 4 tier files (stateless 15 / statefulA 24 / statefulB 21 / composite 4 + param), verbatim-adapted (any→unknown, taState typed). pinetsAll.ts aggregator orders slices so composite cross-calls (macd→ema, hma→wma, mom→change) bind REAL ports, not test stand-ins. registerPortedTa() opt-in; NOT default-on (builtins index.ts untouched).
  * Divergences documented per-tier test headers: pinets SMA-seeds EMA windows (builtin emaVs seeds bar0), bbw ×100 scale, nvi/pvi seed 1.0 vs 1000, tsi [-1,1] vs ×100, sar seed bar1 vs bar0, pivothigh strict vs tie rules, nonNaWindow na-skip vs full-window. kcw name collision: ported = scalar width (pinets semantic), builtin = TV kcW tuple — canonical mapping deferred.
  * pivot_point_levels BLOCKED: facade lacks Pine array type.
  * Verify: 830 pass / 1 skip / 47 files; tsc clean on all touched files; live CDP confirm pine-more button renders on TRIS390 chart.
  * Inventories (scout-produced, .scratch/): pinets-ta-inventory.md (68-method tiering), drawing-accessor-inventory.md (64 have / 10 trivial-add / 16 model-missing set_/get_ accessors — next port target).
  * 代辦: (a) pinetsAll→builtins 上線切換 decision + kcw canonical naming; (b) drawing accessor 10 trivial-add + 16 model-missing (chart.point setters 優先 — reuse pointXY); (c) array type for facade → unblock pivot_point_levels; (d) REA Ghidra/Hopper env vars 未配 (JS/Web only today).

- 2026-10-11 R10 — drawing accessors + kcw canonical + pivot_point_levels + REA env:
  * draw.ts: 10 trivial-add (table PROP_TABLE set_×6, cellSetter halign/valign/width/height) + 5 chart.point setters via pointXY + force_overlay (ctor-only, conditional write — golden-safe) + text_font_family/text_formatting (ctor + prop-table set_* on label/box, cellSetter on table.cell) + 3 set_xloc semantic-gap overrides (TV writes coords too). +4 tests in output.test.ts.
  * ta.kcw canonical: scalar width (upper−lower)/basis of EMA kc — bb/bbw convention; `ta.kcW` keeps the WMA tuple. kcParts() shared between kc/kcW/kcw. Semantic test replaces alias-registration smoke.
  * pivot_point_levels: ported into pinetsStatefulB (22nd) — plain number[] round-trips toValue → {kind:'array'}; PineArrayObject was a marker only. `anchor` param = caller bool series. 3 tests (freeze/developing/error paths).
  * pinetsAll→builtins flip: DEFERRED — ports carry documented na-seed/scale divergences (ema/dmi/kc seeding, bbw ×100, nvi/pvi seed, tsi/sar scale); default-on would change production scripts. registerPortedTa stays opt-in.
  * REA: Ghidra 12.1.4 + Temurin JDK 21 installed to C:/tools, GHIDRA_INSTALL_DIR/JAVA_HOME user env set — rea doctor ghidra 9/9 healthy. Native decompile/xref available. hopper/ida still unconfigured.
  * Verify: suite green (statefulB 23 + output 40 + ta tests incl. kcw); golden 9/10 (MACD701 etc. — force_overlay conditional write restored goldens); tsc clean on touched files.
  * P8 review (3 視角): fixed Woodie pivot open (upstream L98: new-period open), label/box ctor arg order vs upstream, named id/table_id on generated setters, cellSetter `!` crash, negative cell keys, table dims clamp (100), pointXY/chart.point.copy typeName checks, kcw zero-basis=0, tooltip conditional write + goldens regenerated (−46 tooltip:null). 6651f21. Suite 767 pass/1 skip/43 files.
  * Follow-up (1537afc): text_font_family/text_formatting now consumed — engine maps to vela fontFamily/bold/italic on label/box/table.cell; font.* + format.* constants registered; pivot stateKey includes type+developing (upstream _callId-only was shared-state bug, kept verbatim before).

- 2026-10-11 R11 — Slice-E JIT: built, found slower, parked opt-in (fcb6d40):
  * jit.ts transpiles top-level body → new Function; R.call delegates to evalCallDispatch-verbatim jitCallDispatch + jitMatArg (Arg descriptors defer litFastPath/series choice until dispatch). collectAll fixed for Arg.value ({name?,value} nodes). R.call carries evalCall's rt.callsite/siteStack — missing it made plotIndex emit 'auto_N' per bar (1 push/sink).
  * K4.55/935bar measured: jit 2.59 vs compiled 2.30 vs interp 1.75 ms/bar — JIT LOSES. evalNodes cut 625k→597k (~5%) but R-call/descriptor/thunk overhead > dispatch savings.
  * CPU profile (node --cpu-prof, esbuild bundle): compute 20s/935bar; ensureBar 7.4% + setAt 8.9% (BarSeries fill/trim on ensureList), call-path (evalArg+bindArgs+siteKey+bindCallArgs+invokeBuiltin+callBuiltin) ~8%, getUdtMethod 2.2%, UDF 204ms. Dispatch (evalNode+evalExpr+evalCallDispatch+evalIdent+member+siteKey) ~14% — JIT was aiming at the wrong 14%.
  * jitEnabled(): default OFF — __pineJit=true / PINE_JIT=1 opt-in; __pineInterp unchanged. interp is still fastest default.
  * Next real wins (ordered): (a) ensureList compaction — slotFor's 'top-level non-var decl' skip exists but pruneCutoff/conditional arms still register hundreds; batch ensureBar or skip no-op members; (b) evalArg callHist — scalar args already LitSeries-fasted; extend to common expr-arg shapes or cache siteKey; (c) UDF body JIT (callUdfValue→compiled body) — UDF ~13% of interp time, single biggest contained unit.

- 2026-10-11 R12 — UDF-body JIT (a8eb0cf): option (c) from R11 done, and it PAYS.
  * jit.ts: stmt() gains `ret` target mode — decl/varDecl/set assign into `__ret`,
    `if` emits __ret-initialized IIFE, `return` emits natively, unemittable stmts
    fall back to `__ret=R.evalStmt(N)` (evalStmt returns the Pine Value →
    last-executed semantics preserved inside for/while/switch bodies).
  * jitCompileUdf(): top-level codegen minus topStmtIdx + `let __ret=R.VOID` /
    `return __ret` tail — body's last stmt value = call result (evalBlock parity).
  * interpreter: callUdfValue JIT branch behind udfJitEnabled() — flag
    `__pineJitUdf` / PINE_JIT_UDF=1 (`__pineJit`/`PINE_JIT` implies). JitState
    cached on run.udfJit keyed by body Node[]; per-call = callScope swap + js.fn,
    js.cur/scopeStack/save restored → nesting/recursion safe. R.decl/declNa/
    varDecl/set now return bound Value; udfJitState surfaces compile errors
    (unless __pineJitQuiet); __pineJitStats +udfRuns/udfCompiled.
  * Verified: 9-UDF corpus (early return, var accum, x[1], nested, for, switch,
    no-branch na, tuple) snapshot-identical jit vs interp, udfRuns=2200;
    suite 762 pass / 1 skip.
  * Measured (935 bars): UDF-heavy script 0.28–0.35ms/bar jit vs 0.35–0.44 interp
    (~22% win) — UDF bodies re-eval per call so dispatch overhead amortizes where
    top-level transpile's one-shot doesn't. K4.55 still interp-fastest overall;
    both JITs stay opt-in.
  * Next real wins remain R11 (a)+(b): ensureList compaction, evalArg callHist.

- 2026-10-11 R12b — ensureList compaction (e70f785): −38% interp on K4.55.
  * Root cause: bindDeclared L504 tracked every series an alias decl pointed at.
    LiftedSeries (nz/math.max pointwise kernels) are per-call-fresh objects —
    each new one entered ensureList permanently. Measured: 24,228 'alias'
    registrations of 25,999 total → 4.87M ensureBar calls/935 bars, 83.6%
    early-return no-ops.
  * Fix: delete the trackSeries(run, v.v) line. Alias targets are already
    tracked by their own binding site or written every bar; densifying them
    through the alias is redundant.
  * Numbers: ensureCalls 4.87M→1.27M, fills 781k→782k (unchanged, real work
    preserved), interp 2.76→1.70 ms/bar, jit 2.59→2.20, compiled 2.30→1.78.
  * Verification: 9-UDF corpus + alias-hist probe (x[1]/x[2] rebind, conditional
    y, var z=nz) identical; suite 762 pass/1 skip.
  * Residual: decl 1218 / arg 426 / lit 311 still legit conditional-or-arg
    registrations; further win = skip ensureBar calls when the same callsite
    already setAt(bar) this bar (would need a per-bar dirtied flag — deferred,
    fillRate now 61% so remaining no-op share is smaller).

- 2026-10-11 R12c — BENCH 打假 + UDF JIT 預設 ON:
  * 發現 scripts/scratch/bench-jit.ts 從未 import builtins/mtf → bundle 只註冊
    52 個 drawing builtin,ta.*/input/math/plot/request.security 全部 short-circuit
    NA 且連 arg 都不評估。「interp 1.8ms/bar」「jit 2.59 較慢」「R12b −38%」全是
    空殼數字(degenerate workload)。真實 interp ~13-15ms/bar。
  * 4-agent 交叉驗證:__pineEvalCount 排除(只加 overhead)、order 排除、
    prefetchSecurity 0.1-1.8ms 排除、security 在 dash_needed ternary 後根本不執行。
    vc-nobuiltins.mjs 復現 1.5-2.5ms 證明缺 builtins 是 8x 差距主因。
  * 真實對照(K4.55, 935 bars, full builtins):
      interp 12.8-14.5 | jitUdf 9.94-10.98 (−20~25%) | 全 jit ~11.5 | compiled ~17.4
    alias removal 真實增益 −5~6%(非 −38%)。UDF JIT 是最大單一收益。
  * 修正:__pineJitUdf 改預設 ON(opt-out __pineNoJitUdf/PINE_JIT_UDF=0);
    K4.55 plot 輸出 jitUdf vs interp 逐 bit 一致;__pineJit(top-level)維持 opt-in。
  * bench-jit.ts 已補 import builtins+mtf — 之後的 bench 都是真 workload。
  * R12d follow-ups: (a) getUdtMethod memoized per (callsite,selfType) —
    udtMethodAt in interpreter.ts, 91f95ce (UDT-heavy ~2%; K4.55 neutral).
    (b) loop JIT DEFERRED — ta.* window builtins are the real cost (~8ms/bar),
    loop-stmt emit is risky (loopVar BarSeries/break semantics) for small gain.
    (c) ensureList residual audited — decl 1218/arg 426/lit 311 all legit
    conditional registrations; top-level 'arg' skip is UNSAFE (ternary arms
    keep topLevelBody=true while not evaluating every bar).
 * R13 A-list (interp arg/series plumbing): 5 recon scouts → 3 landed, 2 closed.
 * 410dac9 BarSeries firstBar virtualize (leading-NA zone no longer
   materialized): buf pushes 77M → 4.9M (-94%), K4.55 min run/bar 2.08→1.83
   (-12%). LiftedSeries.materialize anchors firstBar so rLen stays n.
 * 61e01e4 siteCtx stack: pushSite walks the trie once per callsite push;
   siteKey drops to 1 Map.get (was depth+2 + nodeIds hash ~800×/bar).
 * 56036ba call-site alloc cuts: all-positional bindCallArgs/bindArgsJit
   skip Set+positionals; cow.rebind skipped when inner===arg (CowSeries.
   source); seed thunk skipped while isDirty=false.
 * e164a76 paramFlags needsHist/mut: evalArg/jitArgFinish noHist drops
   callHist writes for params that never read x[n]; callUdfValue binds
   !hist&&!mut params directly (no CowSeries, no seed BarSeries).
   callHistWrites 222→125.8/bar (-43%). Parity interp≡jitUdf IDENTICAL.
 * A1 ta-kernel: CLOSED — winAgg already O(1); earlier 8ms attribution was
   misread (evalArg/callUdfValue marshalling, not window scan).
 * Remaining: ~110/bar builtin-side callHist writes (array.set, math.*,
   fill, nz, plot/plotshape literals) — need per-builtin reads-arg-history
   table; only ta.* source-args actually need history.
 * R14 builtin-side hist table (histSpecHas): registerBuiltin gains `hist`
   (true | HistSpec{idx,names} | false); HIST_NS defaults ta.* on, array.*
   spec'd per stash-param (val/value/initial_value only), opt-outs for
   scalar-only ta (tr/atr/supertrend/wad/pvt/nvi/pvi/dmi/sar/vortex) and
   math.sum/nz/fixnan opt-ins. evalArg/jitMatArg skip callHist per-arg.
   callHistWrites 125.8→17.4/bar (-86%), K4.55 run/bar 13.50→12.35 (-8.5%).
   Golden 9/9 + corpus parity interp≡jitUdf IDENTICAL; suite 839 green.
 * Audit basis: builtins either (a) scan arg history (ta vsOf/srcOf,
   math.sum, fixnan) or (b) stash the arg Value as a live series (array
   elements, nz verbatim passthrough). Everything else reads .cur() at
   call time — callHist invisible to it. evalHistref's own call-site
   tracking covers x[n] on builtin RESULTS, so arg tracking was pure waste.
 * R14b dead-ends (measured, do not retry): (a) ensureList caller-side
 `currentBar !== bar` skip — interleaved in-process A/B on K4.55/935:
 skip 11628 vs noskip 11586 (noise; ~5µs/bar theory vs 12ms base). Virtual-
 call cost is too small to matter at 1358 calls/bar. (b) trim() inline
 guard — same class, ~0.3% ceiling. Both reverted.
- 2026-10-11 R15 — RESIDUAL PROFILE + REAL PLAN v1 (post-R14):
  * P3 verify (JEV daily_cap 降級主 LLM): scout claims VERIFIED vs source —
    computeAt mtf.ts:1663 sole eval site, cache-before-dispatch 1619-1634;
    callUdfValue interpreter.ts:1517-1534 already jitUdf (gap closed since R12c).
    Gate-fail cross-caller (node,j) memo REJECTED as semantically unsafe —
    transient-cache miss is REQUIRED (UDF param bindings differ per invocation).
  * Fresh profiles flip the target: K4.55 mtfStats.evals=0 (NO security) —
    1.57M evalNodes, top ident/str/call; udfRuns 258k. MTF memo lever = zero
    help for K4.55. TRIS390: evals 50k, str 168k (56%), tf callHist 227.9/bar.
  * Plan: docs/superpowers/plans/2026-10-11-pine-residual-perf-v1.md —
    S1 R.call arg fast-arms + top-level jit A/B (main), S2 str attribution,
    S3 tf-domain callHist→histSpecHas, S4 (investigate-only) caller-binding
    content fingerprint. Targets <9ms K4.55 / <14ms TRIS390.
- 2026-10-11 R16 — INCREMENTAL LIVE-TICK EXECUTION (landed):
  * Problem: every tick → full runScript (500 bars); ~150ms/refresh heavy →
    UI hang reports. Root cause was NOT per-bar cost — no incremental path.
  * Landed: TV-style committed/rollback. closed bars eval once; forming bar
    re-evals per tick from the previous checkpoint. interpreter.ts split
    runScriptInner → buildSess/evalOneBar/assembleRunResult + incRun/
    incRunStart/incAdvance/checkpoint/restoreCkpt; pineWorker incSessions
    (incKey, cap 8); client keeps session workers out of the pool;
    engine incHolder + heavy-tick exemption; double-parse fixed via
    msg.parsed.
  * Four real bugs caught by parity test: committed must exclude the
    forming bar; structural number-keyed ctx.state maps vs bar-memos;
    restore must rewind BarCtx cursor (seek skip ate ctx series pushes);
    incRun must key-match before reusing a session (input update stuck).
  * Perf smoke (500 bars, 10 ta.* + UDF): full 152ms → tick p50 2.7ms /
    append 3.8ms. v1 excludes strategy + request.* (auto full-run).
  * Verify: src/pine/__tests__/inc-parity.test.ts (5 tick scenarios vs
    full rerun, value-level diff); suite 769+5 green; tsc clean on touched
    files. Plan doc: docs/superpowers/plans/2026-10-11-pine-incremental-live.md.

- 2026-10-12 R17 - DRAW-QUOTA BUG (indicator decl stripped from body):
  * Symptom: 見高K on Vela/TV diverged hard — only ~42 zigzag lines vs TV's
    many; every drawing kind capped at exactly 50.
  * Root cause: parse() returns { decl, body }; indicator(...) lives in
    `decl`, not `body`. buildSess called strategyDecl() for strategy decls but
    NEVER declDrawQuotas() for indicator decls, so max_lines_count/
    max_labels_count/max_boxes_count were ignored and created() fell back to
    DEFAULT_QUOTA=50 (draw.ts:92).
  * Fix: interpreter.ts buildSess — `else if (decl?.type === 'indicator')
    declDrawQuotas(ctx, decl.args, INDICATOR_DECL_ORDER)`.
  * Measured (MXF 5m 2906 bars, 見高K4.55): drawings 151 → 937
    (white zigzag lines 42 → 241; labels 50 → 87; boxes 50 → 350).
  * Also: feed.ts tickEpochSec hardened against a contract/expiry date in the
    live tick's `date` field (anchor wall time to today when >1 day off).

- 2026-10-12 R18 - PINE INTERPRETER TV-ALIGNMENT BUGS (3 fixes):
  * Context: 見高K4.55 rendered far fewer lines on Vela than TV (same script,
    same symbol). Root causes were all in OUR from-scratch interpreter
    (src/pine/**), not in Vela (renderer) or TV.
  * FIX 1 (draw quotas): parse() returns { decl, body }; indicator(...) lives
    in `decl`, so buildSess's body loop never reached `case 'indicator'` and
    declDrawQuotas was never called → every drawing kind fell back to
    DEFAULT_QUOTA=50 (draw.ts:92) even when the script declared 500.
    buildSess now calls declDrawQuotas for indicator decls (interpreter.ts).
    Measured (MXF 5m, 見高K4.55): drawings 151 -> 937; white zigzag 42 -> 241.
  * FIX 2 (array stats): array.max/min/sum/avg/range/median filtered elements
    by kind BEFORE unwrapping {kind:'series'} → series-sourced elements were
    dropped, so array.max returned na. numsOf now unwraps first (array.ts).
  * FIX 3 (array store semantics — the big one): push/set/insert/unshift/fill
    stored the raw {kind:'series'} wrapper. Every slot written from one call
    site then aliased ONE live series, so a rolling buffer read back the same
    current value in every slot. TV arrays hold SNAPSHOT values. Added snap()
    (unwraps series to cur()) at all array store sites (array.ts).
    Symptom: 見高K tab_cb (ZigZag pivot ring buffer) returned duplicate
    pivots → tab_rate stuck at 0/1 → ABC lines never drawn; same for the
    harmonic ZigZag buffers. After fix: rInBand 0 -> 149; ABC lines
    10 lime + 10 red (xloc.bar_time) now emitted.
  * Verified: line census on 見高K (MXF 5m 2909 bars) — 404 lines
    (241 white zigzag, 20 ABC bar_time, 50+50 divergence, harmonic
    teal/olive/fuchsia/lime), 147 labels (A/B/C x10). Goldens regenerated
    (UPDATE_GOLDEN=1) since drawing counts legitimately changed.
  * NOT a Vela issue: Vela supports xloc.bar_time / colors / widths; it
    renders whatever the engine emits.

- 2026-10-12 R19 - FIRST-PAINT COST (perf, measured):
  * Profile (node --cpu-prof, 見高K4.55 on real MXF 5m): 83% of busy time is
    evalOneBar; NO single function >5% after that. Cost is ~16 ms/bar and
    scales linearly (200 bars 3.3s, 400 6.5s, 800 12.9s → 2000 ~32s,
    2900 ~46s). The felt "3 indicators take minutes" was mostly bar COUNT,
    not a hot loop.
  * Bug A: velaProvider floored the bar limit at 2000 (Math.max(limit,2000))
    while chasing a phantom "missing drawings" cause → every first paint
    evaluated 2000+ bars. Removed; honor Vela's requested window.
  * Bug B: getShioajiHistory's windowed branch returned EVERY bar in
    [from,to] and ignored `want` — a Vela-supplied window ("since session
    open") bypassed the limit entirely. Now capped to `want` (tail).
  * Bug C (cached results): new src/pine/modelCache.ts — IndexedDB cache of
    the built IndicatorModel keyed by (modelId=source hash, symbol, tf,
    inputs, bar count, last bar openTime). Served ONLY for the first run of
    a session (page restore); tick/update runs always recompute. Any edit,
    tf/symbol change, input change or new bar misses the cache.
  * NOT done: micro-opts in the interpreter hot path (runOf property cache,
    udfJitEnabled memo, UDF arg-wrap reduction) — each ~1-3%, deliberately
    skipped (ponytail: YAGNI until measured need).

- 2026-10-13 R20 - MZigZag - HP "legend shows, zero output" (silent na):
  * Symptom: MZigZag - HP (high452/HP) renders nothing in Vela while 見高K4.55
    does. Interpreter + engine both "succeed" with warns [].
  * Root cause (single, named arg): `array.unshift(a, value=v)` /
    `array.push(a, value=v)` bound NOTHING. The builtins' internal param slot
    was named 'val'; TV's reference name is `value`. bindArgs only matches
    `order` names (+ the one series→source alias), so the named arg landed as
    an unknown name, 'val' stayed undefined, and `snap(undefined) -> na` was
    pushed. The three pivot buffers therefore grew to the right length with
    ALL-na values → every ratio in detect_harmonic_pattern came out na →
    wm_pattern never true → no lines, no labels. Silent: nothing throws,
    nothing warns.
  * Fix: builtins/array.ts push/unshift/binary_search(_leftmost/_rightmost)
    param slot 'val' -> 'value' (+ HistSpec names). Class audit: the other 28
    array.* registrations already used TV names, so the mismatch was confined
    to these 5.
  * Measured (real MXF 500 bars, node): MZ drawings {table:1} (+0 lines) ->
    {table:1, line:101, label:26}. Oscillating synthetic 400 bars: 30 lines /
    14 labels. Instrumented run showed pivots buffer size 71 but px/pa/pb/pc/pd
    all na before the fix, real prices + ratios (xab 1.14, abc 1.45, bcd 1.08,
    xad 1.28) after.
  * The other 4 primitives the handoff listed as suspects were verified ALREADY
    correct (unseriesTruth/truthy coerce numbers in if/and/or/not/ternary;
    bare expression statements in a UDF body do execute) — pinned by tests so a
    future coercion change cannot regress them.
  * Tests: new src/pine/__tests__/mzigzag_semantics.test.ts (5 cases: numeric→
    bool in `if`; numeric in and/or/not/ternary; named `value=` on push/unshift;
    bare UDF statements; e2e MZigZag emits lines+labels).
  * Vela verified (not just node): dev server had died the way dev-up.ps1 cannot
    see — esbuild child gone, `/` still 200, every transform 500, page mounts
    empty with no console error. Recovered by Stop-Process on the :5173 owner +
    scripts/dev-up.ps1. Then `window.__vela.chart.runIndicator(mzSrc)` on 2330 5m
    -> ok, 2.0s, and the canvas shows the harmonic lines + Double Top /
    Butterfly Double Top / ABCD labels.
  * Residual (not fixed, out of scope): a named arg that matches no slot still
    binds nothing silently — no warn. Same failure class could hide behind any
    other builtin whose internal name drifts from TV's.

- 2026-10-13 R21 - S5: strategy 保真度（slippage / margin / strategy.risk.*）:
  * slippage（ticks）：只加在 market 與 stop 成交，limit 成交不加（Pine 原文
    "added to or subtracted from the fill price of market/stop orders"）。
    fillCandidate 以 fromStop 旗標決定；trailing stop 走同一條路徑。
  * margin_long / margin_short：進場保證金閘（resulting position × price ×
    pointvalue × ratio ≤ equity，等號放行 —— percent_of_equity 的成交額剛好
    落在 equity 上）＋ TV Broker Emulator 的 margin call（CurrentEquity ≤
    MarginRequired → 強平 4× 補足損失的部位）。ratio − direction = 0 時
    MarginLiquidationPrice 不可達 → 100% 保證金的 long 永不被追繳。
  * strategy.risk.* 六個全上：allow_entry_in / max_position_size /
    max_drawdown / max_intraday_loss / max_cons_loss_days /
    max_intraday_filled_orders。每次呼叫在 ledger 記一筆 risk 事件，replay
    走到該 bar 才生效（保住 simulate 是 (orders, bars, cfg) 的純函式）。
    觸發＝取消所有 pending + 當根收盤平倉；max_drawdown 與 max_cons_loss_days
    永久停單，兩條 intraday 只停到當日收盤。
  * 附帶修好 evalMember 只認 2 層常數：`strategy.direction.long` 這類 3 層
    常數原本回 na 並報 "unknown constant" → 改成與呼叫路徑相同的鏈式攤平。
  * 架構：tz 工具（tzOf / part / partsOf / tzOffsetMs / zonedMs）從
    builtins/time.ts 抽到新檔 src/pine/tz.ts —— strategy.ts 位於
    interpreter → strategy → mtf → interpreter 的 import 循環內，只能 import
    碰不到 interpreter 的葉模組；time.ts 原址 re-export 保持相容。
  * 效能：riskWalk 加「無規則且無可追繳部位就整段跳過」的前置判斷。未加前
    turtle e2e（60s timeout）跑到 60.4s 逾時，加了之後 10.5s。
  * 測試：strategy.test.ts +12（slippage 2、margin 3、risk 6、decl 1）。
  * 驗證：src/pine 46 檔 / 818 passed / 1 skipped（166s）；golden 重生成後
    只有 TRIS390 的 warnings 變（max|Δ|=0，其餘 8 個 byte-identical）；
    tsc 在本次動到的檔案 0 錯誤（基線本來就是紅的：queries.ts 126、
    parser.ts 58…）。
  * 對照表同步：docs/pynecore-conformance.{json,html} 重生成（full 31→34、
    missing 8→5），scratch/_gen_conformance.py 的資料表一併更新。
  * 已知限制：追繳平倉不截斷成整數合約（本引擎全程用分數部位，TV 會截）；
    risk 規則以事件密度近似逐 bar 評估；進場保證金不足時直接不成交並
    warnOnce（TV 是拒絕並報錯），因此宣告 margin 的腳本可能少幾筆進場。

- 2026-10-13 R22 - TV 標準庫 oracle（REA）＋ log.* ＋ strategy() 宣告序修正:
  * **新對照來源**：`docs/tv-pine-stdlib.json` —— 從官方 Pine v6 reference
    bundle 抽出 1408 條 / 887 個唯一名稱的標準庫表面（name / qualified /
    thisType / syntax / args[name + allowedTypeIDs + required] /
    returnedTypes）。這是第一個「TV 自己出的」對照，不再靠 PyneCore 或人工
    讀網頁。產生器 `scratch/_extract_tv_stdlib.mjs`（`--auto` 自行定位 chunk：
    頁面 → runtime chunk 的 chunk-id→hash map → 依大小探測）。
  * **REA 用法**：Chrome `--remote-debugging-port=9222` ＋ REA
    `list_browser_targets` 可用；`analyze_web_bundle` 在 50+ chunk 的頁面會
    撞 30s MCP 上限，實務走「REA 列目標 → 資源清單 → 單檔下載 → 本地抽取」。
  * **新測試** `src/pine/__tests__/tv_stdlib.test.ts`：本引擎「聲稱支援」的
    namespace（log. / strategy.risk. / session. / str. ＋ 具名清單）逐一對
    oracle 名稱斷言存在，並印出剩餘缺口 —— 目前 887 個名稱中 530 已註冊、
    357 缺（最大塊：matrix 48、strategy 45、currency 43、ta 13、chart 10、
    map 10；syminfo/timeframe/barstate 走 ctx-record 屬誤報）。
  * **log.\***（`src/pine/builtins/log.ts`）：log.info/warning/error，兩個
    overload（message ／ formatString + arg0…），placeholder 走 str.format
    同一套語法（TV 的 log.* remarks 明指 str.format）；格式化抽成 str.ts 的
    `pineFormat()` 共用。輸出收在 `ctx.logs` → `RunResult.logs`
    （level / bar / msg）。UI 未接（本 app 沒有 logs pane）。
  * **strategy() 宣告序修正**：`STRATEGY_DECL_ORDER` 原本第 26 格是
    `max_tables_count`（strategy() 沒有這個參數），且缺 `calc_bars_count` /
    `fill_orders_on_standard_ohlc` / `dynamic_requests` / `behind_chart` /
    `calc_on_every_history_tick` → 第 25 格之後的位置參數全部錯位。已對齊 TV
    的 34 格；新增的四個行為參數一併進 `STRATEGY_UNSUPPORTED_PARAMS`。
  * 測試：`log.test.ts` 6 條、`tv_stdlib.test.ts` 2 條。
  * 驗證：src/pine **48 檔 / 826 passed / 1 skipped**（196s）；golden 不需
    重生成（全綠）。
  * 已知限制：bundle 的 chunk hash 隨 TV 部署變動（`--auto` 會重新定位）；
    oracle 只有表面（名稱/參數/型別），不含散文與執行期語意。

---

## 2026-10-13（S9）未知具名引數驗證 ＋ 小刀批次 10/14

* **未知具名引數不再靜默**（計畫 `docs/superpowers/plans/2026-10-13-named-arg-validation.md`）。
  兩條路徑原本都會安靜吞掉打錯的名字：
  * `bindArgs`（`src/pine/builtins/util.ts`）把未知名塞進 Map 裡一個沒人讀的 key，
    槽位留 `undefined` → `NA`／預設值。R20 的 MZigZag 全 na 就是這個：
    `array.unshift(a, value=v)` 的內部槽當時叫 `'val'`，綁不進去且零訊息。
  * `bindCallArgs`（`src/pine/interpreter.ts`）更糟：未知名被推成**位置引數**，
    綁到下一個空槽，所以 `f(bogus=3)` 會把 3 寫進參數 0。
  現在兩條路徑都只做一件事：**指名 + 忽略 + 每 run 警告一次**
  （`unknown named argument 'bogus=' — ignored; this function takes (id, value)`），
  另補 `duplicate named argument`（同一參數名綁兩次，TV 也是錯；保留第一次的綁定）。
  別名檢查維持只有既有的 `series → source`（不加通用 alias 表，等真的有需要）。
* **刻意分歧（記錄在案，不假裝 parity）**：TV 在**編譯期**就拒絕未知具名引數；
  本引擎沒有 parse 期的簽章表，而硬報錯會讓今天能跑的腳本直接壞掉
  → 我們選擇**執行期警告一次後繼續**。
* 測試：`src/pine/__tests__/named_args.test.ts` 6 條（builtin 未知名、`ta.*` 未知名、
  R20 的 `value=` 真的綁得進去、`series→source` 別名無誤報、UDF 未知名不寫入參數、
  UDF 重複名保留第一次）；`e2e.test.ts` 的 `check()` 追加**永久 gate**：
  8 支真實使用者腳本不得出現任何 `unknown named argument`（＝槽名漂移的 canary，
  之前只看 `maxWarns ≤ 3`，被 1–2 則新警告滲透也看不出來）。
* 驗證：`src/pine` **59 檔 / 921 passed / 1 skipped**；`npx tsc --noEmit` **0**；
  golden 不需重生成（警告不進 golden，成功案例的值不變）。

---

## 2026-10-13（S10）未知具名引數 v2（2 → 5 條路徑）＋ timeframe/calendar 收尾

* **v1 只修 2 條路徑，v2 補齊同型的另外 3 條**（計畫：`docs/superpowers/plans/2026-10-13-named-arg-validation.md`）。
  三軸唯讀探索找出並實測重現：

  | # | 路徑 | 原本行為 | 級別 |
  |---|---|---|---|
  | 1 | `bindArgsJit`（`interpreter.ts`） | 未知名被推成位置引數 → 綁到參數 0；重複名靜默忽略。`PINE_JIT=1 PINE_JIT_UDF=1` 下 v1 的測試 2 failed / 4 passed（JIT 是 opt-in 路徑） | blocker |
  | 2 | `liftNums`（`math.ts`） | `args.concat(Object.values(named))` → `math.round(1.5, bogus=1)` 把 `bogus` 當 precision，**值錯**（比丟掉更糟） | risk |
  | 3 | `bindDeclArgs`（`util.ts`） | 未知名進沒人讀的 key，零訊息（`indicator(bogus=1)`） | risk |
  | 4 | `pickArg`（`mtf.ts`） | `request.*` 的 `adjustment`／`backadjustment`／`currency`——TV 真有的參數——被靜默丟掉 | risk |
  | 5 | UDT `T.new`（`udt.ts`） | 未知名直接 throw | 不是缺口（TV 也錯，且不靜默） |

  1–4 的修法同一個形狀：解析名字 → 跳過 → 每 run 警告一次。`request.*` 另外把
  「TV 有這個參數、我們沒實作」與「TV 也沒有這個名字」分成兩種訊息。
* **順手修掉一個回歸**：`draw.ts` 生成的 setter 把物件槽宣告成**內部名**（drawing kind），
  TV 文件上的 `id=` 因此被丟掉並開警告（`line.set_color(id=l, …)`）；
  現在槽名用 TV 的參考名（`table` 用 `table_id`，其餘 `id`），順序在註冊期建一次、
  不在每次呼叫重算。未文件的 `line_id=`／`table=` 現在如 TV 一樣報未知名。
* **timeframe／calendar 收尾**（backlog **85 → 82**）：`timeframe.from_seconds`（秒階梯 1/5/10/15/30；
  ≥365 天 → `12M`；恰好整週／整月時優先較大單位）、`weekofyear`（ISO 8601，`timezone` 預設
  `syminfo.timezone`）、`timenow`（`Date.now()`，**非決定性** → golden 不得使用）、
  `timeframe.in_seconds` 的月長 2592000 → **2628003**（TV 文件：1 個月 = 30.4167 天 = 365/12）。
  語意逐條取自 `scratch/pine-v6-kb/dist/bundles/`。
* 驗證：`src/pine` **62 檔 / 947 passed / 1 skipped**；`PINE_JIT=1 PINE_JIT_UDF=1` 下的 named-args
  3 檔 **20 passed**（修前 baseline：2 failed / 4 passed）；`npx tsc --noEmit` **0**；
  `tv_stdlib.test.ts` 印 **82**（887 名稱 / 731 已註冊 / 156 缺）。
* **警告會進 golden**：`golden.ts` 的 `snapshot()` 把 `warnings` 一起比對，所以新增／改動任何警告字串
  都要 `UPDATE_GOLDEN=1` 重生成，並在 review 時看 `.golden.json` 的 diff（`c9344b2` 就重生成過
  `scripts/golden/高量1.46.golden.json`，唯一差異是 `tooltip=` 那條警告）。先前的文件寫「警告不進 golden」是錯的。
* P8 三視角 review（正確性／可維護性各 1 個 `task` 代理）的發現與處置見 handoff §10.11；
  本輪因此又多修：`request.security` 參數表（假 unknown ＋ 錯分類）、宣告期警告的 flush 位置、
  v6 `indicator()` 參數表（假 unknown）、產生的 drawing getter 不吃 `id=`。
* 已知限制：JIT 變體只跑 named-args 那 3 檔（不是整套）；`draw.ts`／`core.ts`／`strategy.ts` 另有
  實測 27／8／9 個手寫註冊完全不看 `named`（多數 `get_*`／`delete`／`set_xloc`）→ 具名呼叫會靜默 no-op，
  屬先前就存在的另一類，盤點與切片見 `docs/2026-10-13-remaining-work.md` D5。

## 2026-10-14（S11）na 座標被壓成 0 → 價格軸塌到 0（使用者回報的 K 棒壓扁）

* 症狀：`/vela` 5 分 K，捲到 10/12 19:00 附近**往左**捲，價格軸由 48250–49500 塌成 0–48500，K 棒壓扁。
* 根因（兩條證據）：(1) Vela `computePaneScale`（`vela-src/src/renderers/native/core/autoscale.ts`）把可見範圍內每個
  drawing 的價格折進價格軸，只排除 `null`/`NaN`、**不排除 0**；(2) Pine 繪圖座標為 `na` 時，`draw.ts` 的
  `numArg(...,0)`／`asNum` 把它壓成 0。使用者自己的腳本 見高K4.55 之 golden fixture 就有 **11 條** na 座標被記成 0
  （`drawings[2]` 的 x1/x2/y1/y2 全 0），任一被捲進可見範圍即觸發。
* 修法（surgical，不碰 `@luxalgo/vela`／`vela-src`）：
  - `src/pine/builtins/util.ts`：`naCoordArg`（繪圖座標專用：`na`＝不畫、**缺參數也＝na**、只認 `int/float`）、
    `asNumOrNa`（多參數 setter 用的位置值版本）；兩者都保留 `undefined` 而不壓 0。
  - `src/pine/builtins/draw.ts`：`line.new`／`label.new`／`box.new` 座標改用 `naCoordArg`；`PROP_TABLES` 座標欄位新增
    `'coord'` 型別（表驅動 `set_x1/set_y1/set_x/set_y/set_left/top/right/bottom` 因此保留 na；`width`／`size` 等 `num` 仍壓 0）；
    手寫 `line/label/box.set_xloc` 改 `asNumOrNa`；`line.get_price` 任一座標或 barIndex 為 na 時回 `na`（原本 `Number()||0`）。
  - `src/pine/engine.ts`：`yloc === 'price'` 且價格座標為 na 的 label/marker 直接 `continue`（不再 `?? 0`）。
  - `src/services/shioaji/candles.ts`：kbars 畸形列（OHLC 非有限、`datetime` 無法解析）**丟棄**，不再補 0 價 K 棒；volume 非有限 → 0。
* 驗證：`npx tsc --noEmit` **0**；`src/pine` **62 檔 / 953 passed / 1 skipped**；`golden.test.ts` **15 檔全綠**
  （見高K4.55 13.3s）；`src/services` 綠。實機（headless Chromium，:5173/vela）：na 座標探針腳本（每 25 bar 一組
  `line.new(...,na)`＋`label.new(...,na)`）模型 **0 物件**；500 根 5 分 K（起 2026-10-12 18:55 台北＝回報的 19:00 區間）
  逐窗掃描 pane scale.min ∈ **48137–48833**，8/8 窗無一塌到 0；**正對照**：價格 100 的正常 label 仍被折入
  （min −6023）→ 折入機制仍在，證明上面是「不再產生 0」而非「折入失效」。
  golden `見高K4.55.golden.json` 重生：11 條路徑 `0 → null`，其餘 0 差異（`max|Δ|=0`）。
* P8 三視角 review（正確性／安全／可維護性各 1 代理）＋ 2 輪影響面審計：3 個獨立來源都指出
  `label/box.set_xloc` 與「必填座標漏參數」兩個**同類**破口 → 本輪一併修掉。受管 JEV（`taskwf-review`）
  判 F1 為 pre-existing 另案（fix now 0.0 / 另案記錄 1.0）。
* 殘留（另案記錄於 `docs/2026-10-13-remaining-work.md` D10）：非 overlay 副窗的
  `plotshape(location.abovebar/belowbar)` 會把該 pane 的蠟燭 high/low 折進**副窗自己的**軸（pre-existing；
  使用者的腳本用 `absolute`／`top`／`bottom` 不會踩到）；`plotshape/plotchar` 從未寫 `opts.textcolor`；
  `MarkerPoint.price` 不在 Vela 契約內。
* 已知限制：使用者那支重型腳本（95 KB、`request.security` MTF）在 app 主執行緒直呼 `chart.runIndicator` 會凍結頁面
  （VelaPage 的 `parked-pine` 機制就是為此存在），因此實機 E2E 用小型探針腳本做**機制**驗證；該腳本自身的模型正確性
  由 `golden.test.ts`（同一支腳本、500 bar、in-process）覆蓋。

## 2026-10-14（S12）開啟：指標載入效能（Pine 直譯器）＋ TV 對齊工作流

* 需求：指標載入慢，成本主要在 Pine 直譯器；要求與 TradingView 對齊，並用 REA 擷取 TV 端實測。
* 流程：task-workflow P0–P9（P7 QA ＋ P8 三視角 review）＋ `code-review` skill 四軸 diff review；
  JEV 一律走受管管道（gate `taskwf-verify` / `taskwf-blocker` / `taskwf-accept` / `taskwf-review`）。
* P0/P1 定稿 → `docs/2026-10-14-pine-perf-align.md`（驗收 A1–A8 每條標 code/jev、非目標、N1–N6 依賴圖）。
* P2 三軸探索進行中：phase 級 baseline harness（見高K4.55／MACD701_v72／TRIS390／final × 500、1000 根真實 5m）
  ＋ 兩套圖譜熱點盤點；結論與候選熱點記於 `docs/2026-10-13-remaining-work.md` §G。
* Review 固定點：`b9fcd81`（`git stash create` 快照 ＝ 優化前完整工作樹，含 S11 未提交改動）
  → P8 用 `git diff b9fcd81` 只審本次效能改動。Rollback：`git checkout b9fcd81 -- src/pine`。
* 卡點（外部，唯一需要使用者配合）：TV 端 CDP。Chrome 155 的預設 profile 不給開 CDP，需獨立 profile：
  `--remote-debugging-port=9222 --user-data-dir="C:\Users\bear9\tv-cdp"`，登入後保持圖表分頁開著
  → REA `list_browser_targets` / `inspect_web_page` / `export_web_scripts` / `recover_javascript_sources` /
  `observe_web_execution`，並回填 A6 的 TV per-bar 對齊門檻。
* 更正前的記載：PROGRESS 2026-10-05 進度列「`contracts.ts:57` ＋ `series.ts:53,88` unshift O(n²) 待優化」——
  經讀碼確認**主路徑不成立**（指標載入走 `BarSeries` ring＋head，`Series.unshift` 只在 pinets shim／測試觸發）。

### 2026-10-14（S12）收尾：量測、JEV、TV 通道與環境教訓

* **軸一 baseline（`scratch/perf/phase-baseline.md`）**：run（N=500/1000）＝見高K4.55 15,866／32,905 ms、
  TRIS390 6,070／13,066 ms、MACD701_v72 993／1,882 ms、final 13.2／22.2 ms；**成長倍率 1.68–2.15×＝線性**（無 O(n²) 訊號）；
  parse 最大僅 38 ms（95 KB）→ H10 排除。缺口：`model`/`total` 欄回 `error`（新 harness 補）。
* **受管 JEV 判定**：`taskwf-verify` 六條宣稱 0.79–0.94 全過；`taskwf-blocker` 判「TV 對齊延後」與「舊 harness 缺欄」
  皆為 `risk`（信心 1.00）→ 優化主線可動工，A6 標未量測。
* **TV 通道已建立**：Chrome 155 @ `127.0.0.1:9222`（獨立 profile `C:\Users\bear9\tv-cdp`，
  啟動檔 `C:\Users\bear9\tv-cdp-launch.cmd`）；REA `list_browser_targets`／`inspect_web_page` 均成功
  （target `02A2B9BFE1A8E48505FAD38F1AB14867`，`tw.tradingview.com/chart/l14iDw0v/`）。
* **TV 實測（272 s 視窗）**：`ScriptDuration` 只 +24 ms、`TaskDuration` +32.6 s、DOM 5,684 不變、無 study worker、
  CPU profile 93% idle、console 無 Pine 錯誤 → **TV 端停滯不是客戶端 per-bar 計算**（消費者嘗試掛 95 KB 指標時）。
* **環境教訓（重要）**：當時 CPU **100%**，元凶是我方背景：`bun`（agent host 3,978 s／2.2 GB）＋ 3 個並行子代理
  ＋ ai-memory；使用者回報「TV 以前很快、現在很慢」即由此而來。→ **凡要量 TV 或本機效能，必須先靜機**；
  收工已清掉所有 failed/exited 服務（shioaji-prod/sim、四支 vite、omp.browser.headed、chrome-cdp、vela-cdp）。
* 明日續作順序見 `docs/2026-10-14-pine-perf-align.md`〈TV 實測〉末段（開啟動檔 → 確認靜機 → 分三步掛指標 →
  量測 → 先用新 harness 補本地 baseline 再量 TV）。

### 2026-10-14（S12）尾聲：TV 靜態逆向結論與 harness 交付

* **TV 靜態逆向（`scratch/tv-recon/`，98 page bundle 5.11 MiB＋webpack 展開的 1,492 chunk 89.4 MB 全抓）**：
  **TradingView 客戶端沒有 Pine runtime** —— `pinejs`/`PineJS`/wasm/bytecode 0 命中（我另用 `grep -rl` 獨立複核）；
  client 只送 `create_study`（`46286:20482`），伺服器回 `study_loading` → `du`（已算好的值），
  編譯走 `translate_source`（`74429:38754`）。`request.security`／`ta.*` 只出現在**參考文件** bundle。
  客戶端容器 `PlotList`（`48903:3586`，陣列＋可移動視窗）是唯一可對照的資料結構。
* **⇒ 原驗收 A6「per-bar ≤ TV × k」在客戶端不可量測**（TV 的每 bar 成本在他們的伺服器）。已提三個替代版本
  （A6'：客戶端增量成本對齊，建議；A6''：WS 往返延遲只當參考；A6'''：取消），**待使用者裁決後才改 plan doc**。
  可量測且真正對應差距的對齊點是**架構層**：TV「算一次＋只串流增量」 vs 我們 `incRun` **不適用含 MTF／strategy 的腳本**
  （`interpreter.ts:3078-3082`）→ 那幾支每次全量重算（H1）。
* **harness 交付（P6）**：`scripts/perf/pine-bench.mjs`（25 KB）＋ `lib/**`＋README（20 KB）＋固化 fixture
  ＋ `bench/pine/*.json`。H1/H3/H5 過；**H2 未過（同設定兩跑 total 差 71.9%／重腳本 19.2%）**，但 `model` digest 與所有
  counters 逐位元一致 → 內容確定、抖動來自環境（當時 15 個 `node.exe`）→ **H2 需靜機重測**。
  `modelCache*` 在 Node 下為 no-op → `CACHE_N_A` 正確。
* **新發現（可能阻擋 A5）**：`high452_phase3.pine:74:17` `input(close,…)` 被 `assertScript` 的 `[input-const]` 擋下
  → `prepare` 拋 `ParseError`；該檔為 6/10 舊檔，待確認 app 內實際版本是否同樣被擋（若是則為獨立缺陷）。

### 2026-10-14（S12）收工：乾淨 baseline、門檻定案、舊檔釐清

* **舊檔問題已釐清（非缺陷）**：從 Vela workspace 備份 blob（`%TEMP%\vela-ws-backup-20261014.json`）抽出**真實 app 腳本**
  → `scratch/perf/app-scripts/script-a1dcdea6-95114.pine`（95,114 chars、sha1 前綴 `a1dcdea6`、v6、**無** `input(close,…)`）
  可正常 prepare 並跑完整模型；磁碟上的 `high452_phase3.pine`（`84b5bf44`、91,271 chars、6/10）才是被 gate 擋的過期檔。
  → **後續量測一律用抽出的 app 版本**。
* **乾淨 baseline（`bench/pine/s12-clean1.json`，500 根，`app` 路徑，repeat 3）**：
  app K55 total **12,946.9 ms（25.9 ms/bar）**、TRIS390 **6,923.8（13.8）**、MACD701_v72 **1,501.9（3.0）**、final 27.3；
  counters：K55 `evalNodes 2,867,049`（5,734/bar）、`setAt 395,385`（791/bar）、`ensureBar 506,940`、`callHistWrites 10,643`；
  TRIS390 `setAt 413,282`（827/bar）、`mtf evals 8,458／hits 12,444`。
  H3（app vs direct）K55 6.9%、TRIS390 2.3% PASS；**model digest 四支 app/direct 全一致**。
* **A3/A4 門檻定案**：A3 = 各腳本 total 相對上列 baseline 降幅 ≥50%（K55 ≤6,470 ms／≤12.9 ms/bar、TRIS390 ≤3,460、
  MACD701 ≤750）；A4 = (1000/500) 倍率 ≤2.2 且不得上升。A5 樣本改為真實 app 版；A6 待裁決。
* **P5 REAL PLAN v1 定稿**（切法依量測排序）：S1 `incRun` 支援 MTF／strategy（唯一真正對齊 TV 架構者，單獨一輪）、
  S2 `mtf.evalAt` 快取鍵改 callsite key、S3 `evalArg`/callHist 減量、S4 `ta.*` 餘留 O(L)、S5 `assembleRunResult`、S6 parse（最後做）。

### 2026-10-15（S13）P6 Round-1／Round-2 落地：K55 −57.2%，A3 對 K55 達標

* **Round-1（4 片，各自單檔）**：S2 `mtf.ts` producer 不變值快取（`mtf evals −65.5%`，並**否證**原 H2「caller Scope 身分」假設）；
  S3 `interpreter.ts` 熱點不是 callHist 而是**每 node 讀 debugFlag**（403,439 → 300 次；profile self **6.7%**）；
  S4 `ta.ts` 身分改走 `readTarget()` ＋ `ta.vwma` 滾動窗（`ta.*` gets/bar **1,018.7 → 371.8**）；
  S7 `series.ts` `freezeReader` 接受 live-anchor 虛擬 series（移除 `math.sum(ta.tr,L)` 的**二次項**，46,210 次逐值比對 0 mismatch）。
* **Round-2（3 片）**：S8＋S10 `interpreter.ts`（派生 series 身分穩定 ＋ CowSeries 重用；
  K55 `ta.highest/lowest` **51.6 → 3.1 gets/bar**）；S9 `ta.ts` `winAgg` per-VS 值快取（varlen cycle **−91.7%**）；
  S11 `series.ts` 新增 `CellSeries` ＋ **Parent 套 5 行整合**（K55 `setAt 395,385 → 356,262`）。
  註：S8 與 `ta.ts` 的 `constSeriesNum` **兩 token 互為前提**（單套 S8 會讓 `見高K4.55` 7 根 plotshape 變 na）→ 已一併落地並留 A/B 證據。
* **A3（500 根，`app` 路徑）**：K55 **12,946.9 → 5,538.8 ms（−57.2%，達標）**、TRIS390 6,923.8 → **3,765.4（−45.6%，差 8.8%）**、
  MACD701_v72 1,501.9 → **931.1（−38.0%，差 19.4%）**、final（小數值噪音）。
* **語意**：harness `checks.modelsMatchAcrossPaths` 的 model 內容 digest **四支全部與 baseline 逐字相同**；
  golden **14 passed / 0 差異**；全套 **62 檔 / 954 passed / 1 skipped**；`tsc --noEmit` 0。
* **重複性仍 FAIL**（`totalMaxAbsPct 59.22%`，機器從未靜機）→ A3 最終數字待靜機複測。
* Round-3 已開：R3A `mtf.ts` 單位成本／R3B `interpreter.ts` 每 node 成本／R3C `ta.ts` 餘留 O(L)。
* 檔案：`docs/2026-10-14-pine-perf-align.md`（Round-1／2 總結、A3 判定、Round-3 候選）；`bench/pine/s12-{clean1,round1,round2}.json`。

### 2026-10-15（S13）P6 Round-3 落地：K55 −64.4%；A3 對兩支 MTF 腳本遇結構天花板

* **R3A `mtf.ts`**（5 處：`tfToMs`/`tfParts` 記憶化、`tfOwned`+`tfDirty` 併為單一 WeakSet、`evalAt` 路由判定記憶化、`emit*` 閉包提升、`ensureTfFrame` 守衛內聯）：
  每次 `evalAt` 的 gate 開銷 **1,662 ns/call**（`WeakSet.add` 375–625 ns vs `has` ~25 ns）。
  **關鍵事實**：`evals` 幾乎與 chart 根數無關（100 根 2,922 vs 500 根 2,903）→ 成本由 **requested series 長度**驅動；
  mtf 在 500 根 app 路徑只佔 ~650–700 ms／3,765 ms（≈18%），其中 **~52% 是 `FETCH_WARMUP` 歷史重播**（減掉會改值）
  ⇒ **mtf 膠水層天花板 ~55–75 ms（1.5–2%）**，補不了 TRIS390 的 305 ms 缺口。
* **R3B `interpreter.ts`**（6 處：`runOf` last-ctx memo、`udtMethodAt` 兩層 Map、`bindCallArgs` 提升、刪除 write-only `siteStack`、
  `evalCall` 傳 `run`、`NOT_SECURITY_CALL` 跳過）：決定性單位成本 × 實際次數 ≈ **8.6 ms／100 根 K55（≈0.8%）**（量級誠實地小）；
  `interpreter.ts` self 56.65% → 51.67%（方向）。
* **R3C `builtins/ta.ts`**（`winAgg` 來源值環抽成共用 `winRingReader`）：K55 `ta.stoch` 38.1→**6.2**、`ta.highestbars` 36.5→**3.1**、
  `ta.lowestbars` 25.7→**3.1** gets/bar；`ta.*` 總 245.4→**158.5（−35.4%）**。
  **否決的捷徑**：直接用 `winAgg` deque index 取極值索引（更 O(1)）因 **NaN 破壞「同值取最新」不變式**而退回（probe 量到 55/60,000 不一致）。
* **A3（500 根 app）**：K55 **12,946.9 → 4,611.0（−64.4%）**、TRIS390 4,010.3（−42.1%）、MACD701 996.3（−33.7%）、final（噪音）。
  **model 內容 digest 四支三輪後全部仍與 baseline 逐字相同**（零行為變化）。
* **變異量化**（同樹連跑兩次、`--repeat 5`）：TRIS390 median 3,120.5 vs 3,416.9（+9.5%）、單次內 min–max ±17%；
  MACD701 859.7 vs 865.2 → R2→R3 的 +6.5% **落在變異內，不是回歸**；TRIS390 的 A3 門檻（3,460）**在此環境無法穩定判定**。
* **待裁決**：A3 是否維持「每支 ≥50%」，或改為 K55 ≥50%（已達）＋ TRIS390 ≥40%＋ MACD701 ≥30%＋四支 digest 不變（結構原因已證）。

### 2026-10-15（S13）P8 review → Round-4 修正 → 再審 → P9 交付

* **P8（3 reviewer × 六軸）**：無 P0/P1 正確性缺陷；雙樹差分探針（40+ 形狀）無值差異。
  4 個 Important：**F1**（身分規則兩套互相抵消,0.92）、**S1**（`wring` 表 Θ(bars²) 記憶體,0.81）、**F2**（跨檔前提未註明,0.87）、**C1**（verdict-3 未先讀快取,0.64）；
  Minor：C2（vwma 1 ulp）、C3（forming-bar ring latch）、S2（模組級強引用，JEV 0.33 → Parent 判 Minor）、F3/F4/F5。
  JEV 去重：**F1∩S1 同根因**（0.79）→ 一個修法。
* **Round-4 修正**：**F1＋S1** 以「取穩定的一端」統一（`series.ts` 新增 `ForwardingSeries.bind?` 契約 ＋ `stableSeries()`，`ta.ts` 5 個身分鍵改走它並加 `WIN_RING_MAX=512`；同時合併重複 hop-walk＝F4）
  → churn 形狀 ring **120 張/7,260 entries → 2/121**、`gets/bar` **60.5 → 1.01**、240 根維持線性。
  **C1** 補 per-caller 讀取（**可達性已證**：容器型 tf-invariant 節點 93 evals/0 hits → 23/70）；**S2** RunState 改掛 ctx 的 non-enumerable symbol；**F3** 補反向契約。
* **再審**：四組修正全部修好、**未發現新缺陷**；`hits` 守恆（93=23+70）。⇒ **P8 Critical/Important 歸零**。
* **A3 現況（500 根 app）**：K55 **−61.9%**（12,946.9→4,928.6）✅、TRIS390 **−53.0%**（→3,251.6）✅、MACD701 **−42.8%**（→859.2）❌、final 噪音；
  四支 model 內容 digest 與 baseline **逐字相同**。
* **A4**：六組 0.91–1.09 → 無超線性 ✅。**JEV `taskwf-accept`：A7 0.80 ✓、A8 0.87 ✓**。
* **P9 交付**：工具 `scripts/perf/pine-bench.mjs`（＋README/fixtures/lib）、結果 `bench/pine/*.json`（43）、計畫與證據 `docs/2026-10-14-pine-perf-align.md`；
  清理 TV bundle/chunk 原始下載（91 MB）與所有引擎複本 → `scratch/` 120 MB → **23 MB**（`src/**` 未動）。
* **未收斂（待使用者裁決）**：A3 的 MACD701（−42.8% vs 50%，其成本仍集中 MTF 每次 eval）、**A5 實機載入未量**、**A6 待裁決**（TV 無客戶端 runtime）、harness H2 需靜機複測。
* 本輪總 diff：`ta.ts`/`interpreter.ts`/`mtf.ts`/`series.ts` 四檔 **+806/−166**；rollback `git checkout b9fcd81 -- src/pine`。


### 2026-10-15（R5）S1 增量支援 strategy/security 落地 ＋ `wvs` 上限

* **S1（`interpreter.ts`＋`mtf.ts`）**：移除 `incEligible` → **全部腳本可走 `incRun` 增量**；`IncCkpt` 納入 `argSites`（reviewer 缺口 1）＋ `stateArrays`（`strategy|orders` 的陣列葉進快照面）。
  Parity（100 根＋6 tick、逐值含 na、比對 plots/drawings/fills/alerts/logs）：TRIS390（strategy＋29 security）**6/6 相同**、K55 app **6/6 相同**；
  每 tick **10.9×／26.8×** 快於 cold（`evalNodes` 1/54、`setAt` 1/8~1/23）。`spec.cw` 以「**證明有界**」取代硬上限（每次 checkpoint 清空 ⇒ 長度 ≤ 一根 bar 的 distinct 寫入數）。
  測試前提依裁定更新：`engine.test.ts` 斷言 `runs 1/2/3` → **1/2/3/4**（收緊，非放寬）。
* **`wvs` 上限**：`ta.ts` 新增 `WIN_LEN_MAX = 64`（clear-on-full）→ 240 根 growL states **240→64**、`ta.highest` deque **4,483→1,891**；
  10 個 shape 逐值（含 na）**0 差異**、K55 `gets/bar` 17 列**逐項不變**。
* **殘留（明列）**：strategy `ctx.state` plains 每 checkpoint 深拷貝 → 成本隨歷史成長、**非 O(1)**（5,000 根未量，本輪最大未量化項）；
  `cw` 無硬上限；僅驗 100 根＋6 tick；adaptive tick-skip 在非空 tape 實質不可達（`engine.ts` 未動）；同型 `dvs`/`stv` 未收。
* **A5 實機**：破解 app 的 parked-pine 機制（boot 剝離 → idle 延遲還原）→ 優化後 app 內引擎實跑 **9,919 ms／500 根**（指標 `k55` 確實掛上跑完）。
  「優化前」對照待 `src/pine` 可動時補（程序見 `scratch/perf/a5-real-app.md`）。

### 2026-10-15（R5-T7）T7 正確性缺陷：修復完成（`series.ts` 快照長度水位）

* **根因（推翻原「繪圖層 rollback 不完整」假說）**：tf-frame `BarSeries` 在**同一次 rollback 被 rewind 兩次**（`restoreCkpt` 的 `seriesSnaps` 先、`restoreSpec` 的 `SpecSnap.snaps` 後）。第一次 `drop>0` 把 `buf` 換成切片；第二次 `drop===0` 走 else 分支，把**別名而未截斷的原陣列**接回 ⇒ 終態 `lastBar=44` 卻 `buf.length=46` ⇒ `rAt`/`atOffset` 位移一格 ⇒ `[1]` 塌成 `[0]` ⇒ `prevWickLine`/`prevBodyBox`（即 `drawings[4]/[5]`，**不是** roll 對）拿到 roll 值。鐵證 `scratch/perf/iso/rewind.json`（`snapLastBar=44, snapBufLen=46, before{bufLen:45}→after{bufLen:46}`）。
* **修法**：`series.ts` 的 `IncSnap` 新增 `len`（快照當下 `buf.length`）作為水位；`incRewind` 收斂成 `if (this.buf.length !== snap.len) this.buf = snap.buf.slice(0, snap.len);`（別名且長度已對時不重新分配＝維持原效能）。單檔 +13/−6，patch `scratch/perf/iso/t7-fix-series.diff`。
* **真樹驗收**：`--bars 500 --ticks 5` **0 mismatch**；`npx vitest run src/pine` **954 passed｜1 skipped（62 檔）**；`tsc --noEmit` 0；四支 digest `ze7byn`/`kb0glc`/`1580h2`/`p4gddl` **逐字不變**。另：100／400 根不退步、修前對照每 tick 都紅。
* **順帶更正**：400 vs 500 是 tape 相位（`N ≡ 500 mod 12`）而非閾值；`見高K4.55.golden.json` 的 `0→null` 是 na 座標修復的既定結果、working copy 正確。
* 詳見 `docs/2026-10-15-r5-T7-rootcause.md`。

### 2026-10-15（取證／復原線）六探子結論＋四處更正

* **樹曾被回退**：窗口 B 的 T7 程序在 18:00–18:06 把 `src/pine` 清成基線 `b9fcd81`（R5 成果未提交）。19:37 以 runner pre-flight 快照還原（`%TEMP%\r5-snapshot-B-20261015-1800`，逐檔 md5 相同），並 `git reset -q -- src/pine` 清掉被 checkout 汙染的 index（否則 `git checkout -- src/pine` 會再清一次）。還原後 `npx vitest run src/pine` **954 passed | 1 skipped**、`tsc --noEmit` **0**。
* **六個唯讀探子**對凍結樹取證，四處更正既有文件（細節：`docs/2026-10-15-r5-forensics-summary.md`）：
  1. **T7 根因＝(d) 上游雙 rewind**：`interpreter.ts:3546` 先、`mtf.ts:2396→2346/2354` 後，病灶 `series.ts:114-128` ⇒ tf-frame 序列的 `[1]` 在 forming bar 被讀成當前值。原 (a)(b)(c) 三假說（殘留物件／props 未還原／handle 失效）**全被推翻**；`id` 不是身分標記（`context.ts:264-270 incRestore` 會重編號）。活化律＝forming bar 是新框首根（`slotInFrame==0`）；最小分歧根數 **150、非單調**。
  2. **T8 主導項＝每根 `simAt` miss 的 ramp**：`replaySteps` ＝ **B(B−1)/2**（4,950／19,900／124,750）；epoch cache 丟棄貢獻 **0 步**，不是主因（與 audit 更正段指向不同）。且 `simulate` **非純函式**（改寫共享 orders 的 `o.seen` 與 OCA 兄弟狀態，`strategy.ts:447/452/480`）⇒ 真修法需「自持游標的可快照 stepper」。
  3. **T11 前提更正**：「per-caller 命中＝0」只對 MACD701／K55／final 成立；**TRIS390 殘差 7481@500／1692@100 且跨樹逐位元相同**。寫鍵＝UDF 內每次 invocation 新配的 `callScope`（`interpreter.ts:1733`）⇒ 寫了永遠讀不回；穩定身分已存在＝`spec.callerKey`（`mtf.ts:2040`）。`invHits` 必須用**顯式計數器**（`hits−agHits` 是反推值，不可當命中證據）。
  4. **T12 五項全在**：`cwPeak` 恆 0、`spec.cw` 冷載入 Θ(bars)（≈2 pushes/bar）、C2 只記錄、C3 1 行（逐值 diff 分辨不出，需 probe）、`bind` 契約待 `series.ts` owner。
* **新儀器（零引擎改動）**：per-spec evals/hits（`scratch/perf/mtf-perspec-optimized.{mjs,json}`；TRIS390 100 根 total 626／3265／130，基線 1701／2190／1007）；T7 二分/位移探針；T8 歸因探針；T9 distinct-len（真實腳本每群 ≤9；`growL-*` 無界形 240）。
* **T10 前提更正**：「adaptive tick-skip 是死碼」**不成立**——`src/pine/__tests__/engine.test.ts:309-366` 明載豁免設計並有測試 `heavy run → forming-bar ticks keep running (no skip)`（舊稱，2026-10-16 更正：`heavy run + live session → forming-bar ticks keep running (skip exempted)`）⇒ **行為不改，只更正文件**。
* **交付**：`docs/2026-10-15-r5-fix-plan.md`（P1–P10 修復清單＋所有權矩陣）、`r5-patch-design-notes.md`（T8a 錨點／非純函式證據／T6② 設計與不變式／T9 覆蓋缺口）、`r5-forensics-summary.md`；patch `scratch/perf/patches/r5-t6tw-t12-cwpeak-trim.patch`（T6②＋T12#1/#2，`git apply --check` 乾淨）＋`apply-all.sh`（含閘門）；回退來源 `scratch/perf/r5-pine-optimized-b9/pine`。
* **附註**：`docs/2026-10-15-r5-autorun-status.json` 自 13:45 起因多餘 `}` 無法 `JSON.parse`（`windows.B.started` 因此為 null），20:21 已修復並加「開工前必讀」。

### 2026-10-15（R5 收尾，窗口 D）計畫 v4.2 執行完畢

* **裁決**：D1＝C（T11 不做，`mtf.ts` 未動）／D2＝A（保留 `spec.cw ??= []`，只加 `resetPeak()`＋`trimCw()`）／D3＝B（實作二層有界表）。
* **T12#4**：`ta.ts:412` 守衛逐字在；新 `wring_latch.test.ts`，**判別力已驗**（還原守衛 ⇒ FAIL `expected 525, received 1050`）。**T10**：`engine.ts` 與 R5 基線 **IDENTICAL**，只改 2 處過時措辭（`interpreter.ts` 的 `ineligible scripts` —— 「Eligibility: EVERY script」已不存在；`engine.ts` 的 `ineligible/absent` → `no resume path`）。
* **T9**：新 `ta_state_bound.test.ts`（**修前 FAIL：dmi +2160／kc +1320 → 修後 PASS**）；新增 `bound2`／`memoVs`／`stateVs`／`emaSelf`／`rmaStep`／`rmaVsBound`／`emaVsBound`，**12 站點**（原記 13，QA ROUND 1 更正：dmi 7 ＋ kc 5）——計畫表只列 6，漏了 dmi 4 條 `rmaVs` 鏈（落 `stv`，佔 dmi 成長 2/3）。
* **T6②**：`MtfHooks.resetPeak`／`trimCw` ＋ 4 接線。探針：`cwPushes` 逐項不變；`cwPeak` **298/1200 → 3/3**（TRIS390）、**0/3495 → 10/10**（MACD701）⇒ 由 Θ(bars) 變常數。
* **閘門**：`npx vitest run src/pine` **64 檔／958 passed ｜ 1 skipped**（基線 954，＋4 支新測試）；`tsc` rc=0；golden **14 passed** 無差異；四支 digest `ze7byn`／`kb0glc`／`1580h2`／`p4gddl` **逐字相同**；`s1-inc-probe` **`PARITY OK`**；`t7-bisect` 300/400/500 全 `match`。
* **改動檔**：`mtf.ts`／`interpreter.ts`／`engine.ts`／`builtins/ta.ts`（`series.ts` 不變）；**未 commit**（依 `AGENTS.md` 的 commit discipline，待人工覆核）。
* **未做**：T3／T4（負載 59–79）、T8a、T6①、T6③（計畫列 Out of scope）；T11 的效能病態仍在（TRIS390 殘差 7481@500）。詳見 `docs/2026-10-15-r5-autorun-report.md`〈R5 收尾報告〉。

### 2026-10-17（續作）A1′ 落地完成＋step 5＋Stage 3 可行性

* **背景**：原 `A1PrimeLand` 子代理於 07:10 機器意外關機時中斷（session `01a14396`）。續作先核對落地狀態，再收尾。
* **核對**：`diff -rq src %TEMP%/wrapchk/shadow/src` 只 3 筆差異（`math.ts` 為較新的 `tonumber` 熱修、`str.ts` 為本次 step 5、測試檔只在 repo）⇒ A1′ 的 hunk 與 shadow 相同、無夾帶。機制＝`registry.ts` 的 `SCALAR_BUILTINS`（函式物件為 key）＋`interpreter.ts:1551` `callBuiltin` 單一漏斗；宣告表在 `builtins/scalarDeclPatch.ts`（57 builtins）。
* **step 5**：`str.ts:183` `pineFormat.lookup` 加 `unwrapped()`（修前 `expected '0.25' to be '25.00%'` → 修後綠）；`draw.ts:641` **判定無判別力故不改**（四條 `coerce` 全走 `asStr`/`asColor`，兩者本就 `series → cur()`）。測試檔 `wrap_eval_a1prime.test.ts` 14 passed。
* **閘門（全數重跑）**：`tsc --noEmit` rc=0；`npx vitest run src/pine` **69 檔／990 passed｜1 skipped**；四支 digest `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` **逐字不變**（app=direct 全 PASS）；golden **14 passed｜1 skipped**（未 re-baseline）；`s1-inc-probe` **PARITY OK**。
* **覆蓋率實測**（新探針 `scratch/perf/wrapA-coverage-audit.mts`，引擎路徑 A/B）：`array.variance/stdev/standardize/covariance`、`percentile_linear_interpolation/nearest_rank`、`fill.length` 皆由宣告表覆蓋（＝tb 計畫 §9.3 的 6 站）；**位置引數**在 11 個 builtin（`plot`/`plotshape`/`plotchar`/`plotbar`/`plotcandle`/`hline`/`input.*` 家族）未宣告 ⇒ 缺口仍在，試補 `idx` 已證可關閉。
* **Stage 3 試作（已還原）**：移除 6 處逐站補丁（`array.ts:73/236/248/306/448`＋`math.ts:304`）後，4 支相關測試檔 20 passed、全套 **991 passed｜1 skipped**、四支 digest 逐字不變 ⇒ A1′ 已取代這些補丁。唯一例外：`array.new` 的 `?? NA` 必須保留（漏斗只 unwrap，不補 NA）。
* 詳見 `docs/superpowers/plans/2026-10-17-wrapeval-option-a.md` §11。

### 2026-10-17（續作第二批）把 §11.4 的宣告面缺口與 2 個動態 key 讀取點全部修掉

* **判別式**（新探針 `scratch/perf/wrapA-na-ident-audit.mts`，引擎路徑）：同一位置傳**字面 `na`** vs **綁到 na 的 ident**；不一致即缺陷。修前 **12/14 缺陷 → 修後 0/14**。
* **修的站點**：`plot` 位置 title/linewidth/style/display、`hline` linestyle/linewidth、`plotbar`/`plotcandle` title/display、`input.*` 位置 minval/maxval/step/options/group/inline/tooltip（以上補宣告 `idx`）；`draw.ts:204` `coerceIn`（`set_<prop>` 的 str prop）與 `strategy.ts:1104` `strOf`（14 個呼叫點）改就地 `unwrapped()`。
* **站點數對帳**：`WrapAExternal.ClassASweep.md` 逐列＝**59 列／8 檔**（str 22、plot 12、array 9、input 7、math 5、color 2、strategy 1、draw 1）；§9.1 的「74 站」為無清單可複現的估算，引用改用 59。
* **靜態收斂稽核**：全 `builtins/*` 重掃 `kind ===`／`switch(.kind)`，剩餘守衛皆在已 unwrap 的區域（`core.ts unser`、`log.ts cur`、`draw.ts` polyline 的 `unwrapped`、`array.ts valueEq/cmp` 元素、`session.ts ctx.syminfo`）⇒ 本類無殘留候選。
* **閘門**：`tsc` rc=0；`npx vitest run src/pine` **70 檔／1000 passed｜1 skipped**；四支 digest `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` **逐字不變**；golden **14 passed｜1 skipped**；`s1-inc-probe` **PARITY OK**。
* **回歸釘**：新檔 `src/pine/__tests__/scalar_arg_na_ident.test.ts`（9 `it`）。
* 詳見同計畫書 §11.8。

### 2026-10-17（續作第三批）reviewer 回修 F1／F2＋Stage 3 落地

* **Stage 3 已執行並通過閘門**：回退 6 處逐站補丁（`array.ts:74/237/249/306/447`、`math.ts:302`），保留 `array.new` 的 `?? NA`、`math.ts` 移除已無用的 `unwrapped` import。`tsc` rc=0；`npx vitest run src/pine` **70 檔／1000 passed｜1 skipped**；四支 digest `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` **逐字不變**；golden **14 passed｜1 skipped**；`s1-inc-probe` **PARITY OK**。
* **獨立複核（reviewer 子代理）**：14/14 判別式一致、11 條新 `idx` 與 `bindArgs` 順序**零錯位**（另寫 Part B 探針逐一塞真值驗落點）、`coerceIn` 的 `coord` na 語意未變、`str.ts:183` 無副作用、57 條宣告全數命中。**發現 F1（Important）**：`input.bool/color/timeframe/session/symbol/text_area/time/source` 與裸 `input()` 共 9 個註冊同樣走 `scalarInput → recordAndOverride`，未宣告 ⇒ 位置路徑 11/59、具名路徑 2/18 仍 DIFFER。**F2（Minor）**：`plotchar` 的 `display` 宣告是死條目。
* **回修**：補 9 條宣告（宣告面 57 → **65**）、移除 `plotchar` 死條目、回歸測試 9 → **11** `it`。以 reviewer 自己的探針複驗：Part A **0/59**、具名 **0/18**、followup 煙霧測試正常（`input.source` 的 `defval` 仍 `"close"`）。
* 詳見同計畫書 §11.8／§11.9。

### 2026-10-17 T3／T4 靜機量測完成（R5 遺留的效能交付）

* **前置**：全部工作停手後 `quiet-gate` 取得 **PASS**（`samples=[14.5, 23.4, 13.3]%`，門檻 25%；三服務埠全 down）。先前 08:0x 一次是 `NOISY`（31.9／46.6／31.7%），干擾來自本機自己的 node 程序。
* **T3（A3，500 根 app、repeat 5 median，對 baseline `b9fcd81`）**：K55 **4,382.5（−66.1%）** ≥50% ✅／TRIS390 **3,362.1（−51.4%）** ≥40% ✅／MACD701_v72 **884.3（−41.1%）** ≥30% ✅。硬條件：四支 digest app=direct 逐字相同（`50rj53`／`3huclf`／`18qepy0`／`1kzvcjg`）、golden 14 passed｜1 skipped 零差異 ✅。
* **T4（A6）**：TRIS390 live tick median **79.2 ms**、cold/live **34.1×**；K55 **92.3 ms**、**51.4×** ⇒ 皆「≤100 ms 且增量 ≤ cold÷10」，兩者 `PARITY OK`。
* **殘項**：T3 的 **A4 成長倍率未量**（pine-bench 的 `growth` 為空；需另跑成長探針）。詳見 `docs/2026-10-15-r5-fix-plan.md`〈量測結果（2026-10-17）〉。
* **G6 決定不跑**：效果量 ≈0 < 噪音底（離散 7–35%；2 次／臂曾出現 −29% 假效果）⇒ 記「無可量測差異」，協定留在計畫書 §11.6。

### 2026-10-17 T8a（D1）查證：stepper 早已落地，量測確認 O(B)

* **查證發現**：`simulate` 的續跑 stepper **已由 R5 線實作**（`docs/2026-10-15-t8-stepper-dossier.md` 寫於實作之前）——`SimRun`（`strategy.ts:322-341`）＋ `OrderCursor`（`:299-317`，刻意與 `StratOrder` 分離 ⇒ 無共用 scratch 危害）＋ `simulateRun(ctx, orders, cfg, uptoBar, prev?)`（`:349`）＋ `:522` 的 future-order guard 已修（`break` 而非標記 seen）＋ `simAt` 以 `cache.run` 續跑（`:1046-1058`）。⇒ 計畫 §1 的取捨已固化為「選項 ②」，無需再決策。
* **驗收量測**（探針 `scratch/perf/t8-replay-attrib.mjs`，產物 `scratch/perf/t8-replay-attrib-postfix.json`）：`replayMs` **793.09→49.67／3,321.78→165.90／23,422.09→667.05 ms**（bars 100/200/500；−93.7%／−95.0%／−97.2%）；每次 replay 中位 **0.26–0.32 ms**、p95 ≤0.68 ms（**與 B 無關**）、max 8.2/18.4/47.1 ms（每次只少數幾趟＝每 epoch 首趟與失效後完整重放）；`epochRebuilds` 4/8/20 → **1**。⇒ 總工作量＝一趟完整＋(B−1) 次單根推進＝**O(B)**（舊制 4,950／19,900／124,750）。
* **方法註記**：本輪為探針新增 `advancedSteps`，但它在 B 上恆等於 B、**只是下界、不具判別力**；判別力來自每趟 ms 分布（若仍從 0 重放，500 根中位會是 ~47 ms，實測 0.263 ms）。
* **D1 未改任何 `src/`**（只動 `scratch/perf/`），閘門沿用 reviewer 回修後的結果。
* **新殘項 R2（不在 P2 範圍）**：`strategyEquity.ts` 的 `equityAt` 仍對每個過去 bar 從 0 重放 ⇒ 讀 `strategy.max_drawdown`／`max_runup` 的腳本有超二次項——實測 100 根 21.51 vs **798.21 ms**、500 根 148.43 vs **108,204.61 ms**（5× bars ⇒ 135.6×）。修法＝T8a 計畫 §1 的選項 ①。
* 詳見 `docs/superpowers/plans/2026-10-17-t8a-snapshot-stepper.md` §9。

### 2026-10-17 T8b（P3，記憶體）查證：已完成

* 修法＝`IncCkpt.seriesCount`（`interpreter.ts:3290` 的註解即描述此病）＋ `incRestoreCkpt`（`:3609-3613`）還原時把 `s.seriesSet` 裁回該計數，刪掉「被丟棄的 forming-bar eval 期間誕生」的序列。
* **實測**（新探針 `scratch/perf/t8b-series-growth.mjs`，現行 API `incRunStart`／`incAdvance`，100 根 + 6 次 forming tick）：build 後 `seriesSet = 12`，**tick 1..6 全部 = 12（Δ = 0）** ⇒ 每 tick 成長 **0**（原為 +150@B=100／+201@B=500）。驗收達成。
* 舊探針 `t8-series-growth2.mjs` 已失效（import 的 `evalOneBar` 不再匯出）。
* 另：`D2 `T6①`` 經查證**已結案不做**（`2026-10-16-t6a-chart-tf-security-fastpath.md` 附錄 B.6 定案：前提「tf 幀是圖表 tape 的複製品」已否證，快路徑在驗收配置下零收益，已完整回退、patch 另存）；`D4 T11` 亦已由使用者裁定不做；`D5 T12 剩項` 三項皆已在樹上（`siteAnchor` 契約 `interpreter.ts:416`／`series.ts:600`、T12#4 ring latch、`resetPeak`/`trimCw`）。
* **D3 T6③（P7）查證**：實作在樹上（`EMPTY_NAMED`：`builtins/util.ts:193` 定義／`:215` 早退、`interpreter.ts:1401/1464/1527/1558` 使用）。驗收以**計數器對帳**通過——MACD701_v72 @100（app）：`evalNodeCounts.total` **32,742 → 32,742**、`seriesWrites.setAt` **17,274 → 17,274**、`mtf.evals` **4,509 → 4,509**（基線取自 `docs/2026-10-15-t6-three-dossier.md:90`；實測資料 `bench/pine/pine-bench-20261017-082112.json`）⇒ 三者逐位元不變，且該量測落在 A1′／第二批／F1 回修／Stage 3 **之後**，順帶證明那幾批未動到這些計數器。

### 2026-10-17 P8 Code Review（R1→R2 回修、R3 再審）

* **R1（三視角）**：`0 Critical`；3 條 Important（受管 JEV `taskwf-review` 分級）＋ 7 Minor ⇒ 回修 **F-A**（宣告表漏 `input.string` 2/3/4、`input.price` 5）、**F-B**（`registerBuiltin` 死參數 `scalar`）、**F-C**（宣告面零守門）＋回歸：`tsc` rc=0、`vitest run src/pine` 1005 passed｜1 skipped、四支 digest 逐字不變、golden 14｜1、`PARITY OK`。
* **R2（正確性 `RevClose`、新面 `RevNew`）**：`0 Critical`；Important 3（其中兩條同根因）、Minor 2。
  * **R2-I1 混用具名＋位置時解包錯位**（`ScalarSpec.idx` 語意是 order 槽，但 `callBuiltin` 拿它索引原始位置陣列；`bindArgs` 卻把位置參數填進未被具名佔用的槽）⇒ F-A 的錯分支在該路徑復活：`plot(series = close, na)` 的 title 變 `"NaN"`、連 `fill()` 依賴的 sink 識別鍵都變；探針 **5/5 diverge**。受管 JEV：**Important 0.91**、「是否需契約級修法」noul **0.83（true）**。advisor（`opencode-go/mimo-v2.6-pro`）選 **B**；使用者裁決走 **B 收斂**。
  * **修法**：`ScalarSpec` 增 `order?` ＋ 新增 `positionalSlots()`（鏡射 `bindArgs` 的具名先佔槽與 `series`→`source` 別名）；`callBuiltin` 無具名時維持 `args[ix]` 快路徑，有具名且帶 `order` 時先換算再解包（順帶修掉「不該解包的槽被錯位壓平」）。**42 條**（idx 非 0 起前綴者全數）補 `order`：19 條重用 `plot.ts`／`input.ts` 常數，23 條字面清單（逐一由 `array.ts`／`math.ts`／`str.ts` 實作讀出）。新守門斷言：非前綴 idx 必須帶 `order`、order 須涵蓋其 idx 與 names。
  * **R2-I2／I-3（守門）**：`FAMILY_ORDER` 漏 `input.string`／`input.price`（恰是 F-A 主角，it(3) 靜默跳過，JEV Important 0.99）＋ 守門檢不出 under-declaration（JEV Important 0.89）⇒ 補兩鍵＋反向斷言，並新增 `input.*` 七槽完整性斷言、`names` 重複斷言、檔頭改寫成精確覆蓋聲明。
  * **驗證**：RevClose 混用探針 **0/7 differing**（修前 5/5）；突變自證 `M3`／`M6a` 由綠轉紅、`M4` 仍綠（已明列未覆蓋）；`maint-audit` 167 槽 0／`drift` 0 misalign／`rev-probe` 0/45／`wrapA` 0/14／`wrapB` 0/59／具名 0/18 全不退步；**五閘（11:33–11:41）**`tsc` rc=0、`vitest run src/pine` **1007 passed｜1 skipped**、四支 digest 逐字不變、golden 14｜1、`PARITY OK`。
  * **留下缺口（記帳）**：`histSpecHas`（`interpreter.ts:1531`）仍以「原始位置＝order 槽」配對 `HistSpec`（與 R2-I1 同形的**既有**問題，需同一套 order 管線）；非 `input.*` 家族的 under-declaration 仍無單測覆蓋。
* **R3（三視角，tier=heavy）**：`R3-RevOrder`（契約保真；R2-I1 closed）／`R3-RevGuard`（突變證守門；抓到 I1）／`R3-RevSecurity`（信任邊界；抓到 F2）——結果見下一節。
* **流程註記**：`taskwf_gate.py tier --nodes 6 --files 4` ⇒ **heavy**（P8 三視角並行）；第 2 次回頭重入（R3）前已記 `advisor P8`；子代理命名一律 `R<輪次>-…`（新規則，已寫進 `task-workflow.md` P8 節）。詳細報告：`docs/superpowers/plans/2026-10-17-wrapeval-option-a.md` §11.9／§11.11／§11.12。

### 2026-10-17 P8 Round 3（三視角再審＋兩條 Important 回修）

* **0 Critical、2 Important、5 Minor**（Minor 記帳不修，清單見計畫 §11.13）。
* **R3-I1（R2 引入）**：`math.round` 走 append 模型（`math.ts:100` `args.concat(namedValues(...))`）而非 `bindArgs`，R2 給它補的 `order` 反而把它推進錯的映射 ⇒ `math.round(number = 2, close)` 的 `args[0]`（實作讀歷史的 `number` 槽）被壓平，`ta.sma` 偏移一根 bar。修法：收回該條 `order`＋守門新增 `APPEND_MODEL` 顯式豁免（附「豁免鍵必須是真條目且仍無 order」反向斷言）。
* **R3-F2（先於 R2）**：具名解包漏 `series=`→`source` 別名（`bindArgs` 與 `positionalSlots` 都做 canon，唯獨具名迴圈沒做）⇒ `str.contains(series = naIdent,"x")` 得 `false` 而非 `na`；JEV 定級 **Important 0.97**（另兩位評 Minor，以受管 JEV 為準）。修法：具名迴圈加 canon（僅當宣告名為 `source` 且未顯式給）。
* **驗證**：新探針收進 repo（`scratch/perf/wrapC-mixed-alias-audit.mts`）——`H4 == H5 == H6 == H7`（偏移消失）、`C1 == C2`、`C3 == C4`；`tsc` rc=0；守門 5 passed；探針 6 項不退步；**五閘** `1007 passed｜1 skipped`、四支 digest 逐字不變、golden 14｜1、`PARITY OK`。
* **三視角獨立結論**：`R3-RevOrder` 23/23 字面 order 與實作一致、19 條常數全查一致、`positionalSlots` ≡ `bindArgs`（3010 組合 0 分歧）、R2-I1 closed；`R3-RevGuard` 新守門三個斷言皆以突變自證會紅，並列出仍漏抓者；`R3-RevSecurity` 跨執行狀態無可達壓平、無新增動態執行／I/O。
* **新增 Minor 記帳**：`histSpecHas` 裸索引（既有同形）、非 input 家族 under-declaration 無單測、`named[n]` 原型鏈裸讀、`positionalSlots` 成本（最壞 8.44 µs/call）、`liftNums` 既有參數對調語意。
* **R4 窄幅再審（`R4-RevRound3Fix`）⇒ 0 Critical／0 Important／0 Minor，P8 收斂**：I1 的歷史壓平已修（四種拼法包 `ta.sma` 全 `[na,na,101,102,103,104]`）；豁免守門三種突變都會紅（含「假鍵＋把 order 加回」→ 紅於 stale 斷言）；F2 的 7 個 `str.*` 全受惠且不誤傷 `ta.*`／`nz`；`named` 物件不被共享故 canon 無副作用。
* **R4 新列殘留風險（皆改前既有）**：① 最重要——`liftNums` 按呼叫順序 append（`math.ts:100`），與 UDF／`bindArgs` 的 named-to-slot 契約語意相反，建議對照 TV 文件定案；② `hasP`（`math.ts:210-212`）漏看經 `number=` 送達的 precision ⇒ 非整數結果被截斷；③ 豁免 stale 斷言對假鍵類會被 unbacked 先擋（fail-safe）；④ `histSpecHas` 孿生缺口。
