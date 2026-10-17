# R5 剩餘工作自動跑（2026-10-15 12:00 → 14:00，硬停 14:00）

## 輪次與狀態檔（先讀這段）
- 這份簡報**會被執行多次**：窗口 A = 12:00–14:00、**B = 18:00–20:00**、**C = 20:30–22:15**（各約 105 分鐘後被外部強制終止）。
- **每次開工第一件事**：讀 `docs/2026-10-15-r5-autorun-status.json`（不存在就建立 `{}`）與 `docs/2026-10-15-r5-autorun-report.md`（不存在就建立）。
- **只做 status 裡不是 `"done"` 的任務**。每完成一項**立刻**更新 status（例：`{"T1":{"status":"done","evidence":"..."}}`）並追加報告；被硬停也要留下當時狀態。
- status 值只准用 `done` / `partial` / `not_started`，**不得虛報**；沒做就寫 `not_started`。
- 收尾前最後一件事：更新 status ＋ 報告 ＋ `PROGRESS.md`。

你是接手的代理。**只做下面列的 T1–T12**；每個窗口預算見 runner（約 105 分鐘後被強制終止，請在剩 15 分鐘時開始收尾）。
**優先序（照做，修復先於量測）**：**T7（正確性，最高）** → **T8** → T6 → T9 → T10 → T11 → T12 → T1 → T2 → T3 → T4。（**T5 已取消**，見該節。）
先讀 `docs/2026-10-14-pine-perf-align.md`（〈Round-5〉段、〈A5 實機量測〉段、〈A3／A4 門檻（定案）〉、〈A6 需要改寫〉）、`docs/2026-10-15-r5-decisions.md` 與 `PROGRESS.md` 尾段，再動手。

## 凍結基線（不可破壞）
- 目前工作區是**已驗證綠燈**狀態：`npx vitest run src/pine` **954 passed | 1 skipped（62 檔）**、`tsc --noEmit` **0**、
  四支腳本 digest（100 根，app＝direct）＝ `ze7byn`(K55 app) / `kb0glc`(TRIS390) / `p4gddl`(final) / `1580h2`(MACD701_v72)、golden 0 差異。
- 這些改動**全部未提交**（`git status` 可見 `src/pine/**` 為 M）。**最後一個 commit 是 `b9fcd81`（優化前）**。
- 舊快照：`C:\Users\bear9\AppData\Local\Temp\r5-snapshot-0806\`（`pine/`＋`golden/`）。

## 紅線
1. **動手前先做新快照**到 `"$TMP"/r5-snapshot-<HHmm>/`（`<HHmm>` 是實際時刻如 `1800`；先 `TMP=$(cygpath -u "${TMPDIR:-$TEMP}")`——**這條一定要先跑**，`cp -r src/pine "$TMP/r5-snapshot-<HHmm>/"` 與 `cp -r scripts/golden "$TMP/r5-snapshot-<HHmm>/"`）。任何回退都要先有快照。
   > 2026-10-16 註記：上方反引號內的 `%TEMP%\r5-snapshot-<HHmm>\` 即原文逐字。`%TEMP%` 是 **cmd** 語法，**bash 不展開**：整串會當成相對路徑照抄，於是在 repo 根長出畸形目錄（本輪隔離搬移的 `CUsersbear9AppDataLocalTempr5-snapshot-1209/` 就是這次 botched 指令留下的痕跡——`%TEMP%` 被吃成空字串、`\` 被吃掉後反斜線跳脫黏成一團）。執行請用本條的 `"$TMP"` 形式。
2. **禁止**沒有快照就 `git checkout` / `git restore` / `git stash` 任何未提交檔案——那些改動是 Round-1–5 的成果，整體回退會全毀。
3. **禁止** `npm i`；Windows shell 用 `node -e` / `npx`，不要 PowerShell 內嵌 `$`。
4. 收尾時 `src/pine` 必須回到**本輪開工時的內容**（用 md5 清單自我比對；T1 有暫時回退過就必須還原並驗證）。

## T7（**最高優先：正確性缺陷**）增量 ≠ cold 在 500 根分歧
`T2ScaleProbe` 實測（`scratch/perf/t2-scale-Accept500.json`）：
```
npx tsx scratch/perf/t2-strategy-scale.mjs --bars 500 --ticks 5
→ PARITY FAILURES: 5 — drawings[4] y1  live 48935 vs cold 48959（每一 tick 都一樣）
```
- **100 根是 5/5 match**（與既有 `s1-inc-tris-final.json` 一致）；**500 根不通過**。
- **不是探針誤差**：未修改的參考探針 `npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 1` 得到**一模一樣**的單筆 mismatch（`scratch/perf/t2-s1control-500.json`）。
- ⇒ **S1 的「parity 6/6」只在 100 根成立；500 根有不一致**（先前所有 parity 驗證都只做 100 根）。

**你要做的（順序）**
1. **重現**：跑上面兩條指令（`--ticks 1` 與 `--ticks 5`），記錄 mismatch 的節點與數值。
2. **歸因（關鍵）**：判斷是 S1 引入的、還是**既有**分歧。
   - 先**做快照**（`TMP=$(cygpath -u "${TMPDIR:-$TEMP}")`；`cp -r src/pine "$TMP/t7-optimized-<HHmm>"` ＋ 記 md5）。
     > 2026-10-16 註記：原文為 `cp -r src/pine %TEMP%/t7-optimized-<HHmm>`——bash 不展開 `%TEMP%`，且行內 `&&` 在該輪被當成一整個字串，於是在 repo 根留下 `t7-optimized-1800 && cp -r …` 這種含分隔符的畸形目錄（本輪已隔離搬移）。執行請用本條的 `"$TMP"` 形式。
   - `git checkout b9fcd81 -- src/pine` → 在**基線樹**上跑同一條 500 根探針。
   - **立刻還原**並驗 md5 全等（未還原不准收工）。
   - 基線**也**分歧 ⇒ 既有缺陷（S1 只是把它變得可見），照樣要修；基線**乾淨** ⇒ **S1 引入**，優先修 S1 或**逐段回退 S1**。
3. **收斂**：二分出「最小分歧根數」（100→500 之間）與是哪個節點/圖形（`drawings[4] y1` 對應哪個 Pine 敘述）。
4. **修或退**：修到 `--bars 500 --ticks 5` **0 mismatch**；若做不到就**把 S1 的改動逐段回退**（回退＝恢復 `incEligible`），讓引擎回到「增量只對合格腳本開啟」的已知安全狀態，並在報告寫清楚。
5. **不得**用放寬比對（容忍閾值、忽略 drawings）來讓它變綠。**紅燈就是紅燈。**

**已經可以先斷定的事（Parent 在 window A 回退期間實測，可省你一半工）**
```
$ npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 1
build: eligible=false … setAt live/cold=413282/413282 mtfEvals live/cold=8458/8458  match
ineligible — incRun fell back to a fresh full run every call (live === null)
```
⇒ 在 **S1 之前**的樹上，strategy 腳本**根本不合格增量**（`incEligible` 直接擋掉、每 call 都全量重跑）⇒ **不可能**產生「增量 vs cold」分歧。
⇒ **這個分歧必然是 S1 引入的**（不是既有缺陷），因為 S1 正是讓 strategy 走增量的那個改動。
**仍要做的**：最小分歧根數（100→500 二分）＋ 機制定位（見下）。

**首選懷疑（先查這條，再看別的）**：**圖形 rollback 不完整**。
`drawings[4] y1` 差 24 點，型式像「某個 drawing 的 y1 殘留成 forming bar 的值」。快照面裡繪圖相關的是
`drawSnap`＋`drawProps`（`interpreter.ts:3485-3487`，逐個 `cloneDeep(o.props)`）與 `liveArrays`（`:3521-3522`，只做 `.slice()`）——
檢查增量路徑（`restoreCkpt`）是否**完整**還原這三者（含「被丟棄的 forming-bar eval 新建的 drawing」是否被移除、既有 drawing 的 props 是否被改回來）。
若定位到，優先修這裡（比回退 S1 便宜得多）。

**Parent 第三次收斂（決定性，2026-10-15 14:0x）—— 推翻「上游狀態」假說**
（↑ 上面「首選懷疑」與「第二次收斂」的推論已被本段取代；僅保留其證據價值。）
用**帶診斷 plot 的受測腳本副本**（`scratch/perf/t7-tris-probe.pine` = TRIS390 ＋ 7 條 `plot()`：
`rollOpen/rollHigh/rollLow/rollClose/rollReady/curBxTime/boxWTime`），跑
`npx tsx scratch/perf/s1-inc-probe.mjs --script scratch/perf/t7-tris-probe.pine --bars 500 --ticks 1`
⇒ 結果 **`PARITY FAILURES: 1`,field 仍是 `drawings`（index 4）,值完全相同（48935 vs 48959）**；
**那 7 條上游序列的 plots 全部 match**。
⇒ **上游數值一模一樣,分歧只在「繪圖物件層」**。先前「UDF/區域 var 沒回滾」的推論**不成立**。

**新（且目前最合理）假說：live 側殘留一個「建構期」的舊繪圖物件**
- 兩側 drawings 數量相同（6/6），但 live 的值＝**建構相位**算出的那組（48935/48882），cold＝tick 重算出的一組（48959/48888）。
- 型式符合：`line.delete(rollWickLine)`（`TRIS390.pine:732`）在 tick 1 **刪到錯的物件**（`rollWickLine` 這個 var-handle 在 rollback 後的指向與 committed 不一致），
  於是舊物件（build 期建的、值 48935）**留在 sink 清單裡**，新物件再被建成 → live 的第 4 筆是舊的、cold 的是新的。
- 這也解釋為何只在 **500 根**出現：`rollReady`/session 錨（`s720_*`、`curBxTime`）要在窗內才成立 → 圖形才存在 → 才有東西可分歧（100–400 根時圖形不存在 ⇒ 恆 match）。

**下一步（18:00 場照這個順序做）**
1. **驗身分**：在 `DrawObj.id` 或 `ck.drawSnap.nextId` 上做 live/cold 比對（探針側 dump 即可，不必改引擎）；若 live 的第 4 筆 `id` 比 cold 小 ⇒ 確認為「殘留舊物件」。
2. **看 delete 目標**：在 `line.delete`/`box.delete` 的 sink 端記錄「被刪物件的 id」，比對 live 與 cold 刪的是不是同一顆。
3. **修**：讓 `restoreCkpt` 的繪圖面**與 var-handle 一致**（把 handle 的 series 回滾到 committed 物件，或在增量路徑把「刪除＋重建」做成等冪）。
   修好判準：`--bars 500 --ticks 5` **0 mismatch**（且 100 根不得退步）。
4. 做不到就**逐段回退 S1**（恢復 `incEligible`），並在報告寫明。

**Parent 已複核收斂（直接用，不必重做）** — 來源 `scratch/perf/t2-scale-Accept500.json`、`t2-s1control-500.json` 的 `failures`：
```
{ "bars":500, "tick":1, "phase":"advance", "field":"drawings", "index":4,
  "liveLen":6, "coldLen":6,
  live: line { x1:1791842700000, y1:48935, y2:48882, x2:1791842700000, xloc:"xloc.bar_time",
               extend:"extend.none", color:"#808080", style:"line.style_solid", width:1 }
  cold: line { x1:1791842700000, y1:48959, y2:48888, x2:1791842700000, … } }
```
- **build 相位 diff = null**（`log[0].diff === null`）⇒ 分歧**不在初始建構**。
- 分歧出現在 **`phase: "advance"` 的第一個 tick（tick 1）**，且該 tick **`appendedBar: false`**（沒收新 bar）⇒ 問題在「**forming bar 的 rollback ＋ 重跑**」這條路徑，不在 commit 路徑。
- tick 1..4 的四筆 mismatch **值完全相同**（48935 vs 48959）⇒ **黏住型（sticky）分歧，不累積**：tick 1 就定調，之後沒再漂。
- 圖形數量相同（6/6）⇒ **不是多/少物件**，是**同一物件的 y 值不同**。
- y 差是 −24 與 −6（**不是常數偏移**）⇒ 兩邊用了**不同的計算基礎**（例如 forming bar 的 high/low vs 已收盤 bar、或某個 series 的 current-value slot 沒被 rollback）。
- 這條 line 是 `xloc.bar_time` ＋ `x1==x2`（同一時間的垂直線段）⇒ 很可能是**每根被更新（set_y1/set_y2 型）的線**，
  其 y 來源是某個序列值 ⇒ **優先檢查兩件事**：(1) 該 line 的 `props` 是否在 rollback 被完整還原（`:3597-3602` 的 `if (p)` 分支——`p` 為 `undefined` 時**靜默不還原**）；
  (2) 該 y 來源 series 的 **current-value slot / 最後一根的寫入** 是否在 rollback 被還原（`seriesSnaps` 只回 `lastBar/firstBar/head/buf`，**current slot 是否涵蓋要看 `IncSnap` 實作**）。
- **建議的下一支儀器**：在 tick 1 的 live 與 cold 兩側，各自 dump「drawings[4] 的 props」與「該 y 來源 series 在該 bar 的值」，逐值比對，直接分出是 props 沒還原還是 series 沒還原。

**Parent 第二次收斂（對 `liveFull` vs `coldFull` 做深度比對，整個 model 只有 2 處差異）**：
```
/4/1  line props : y1 48935 vs 48959, y2 48882 vs 48888   （x1/x2/time/color/style/width 全同）
/5/1  box  props : top 48933 vs 48915, bottom 48918 vs 48890（left/right/time 全同）
```
⇒ **只有「價格座標」不同、時間座標完全相同**；**plots/series/fills/bgcolors 全部相同**。
⇒ 所以**不是序列值分歧**（序列若分歧，plot 也會分歧）；而是**這兩個繪圖的價格座標用了不同的計算分支/不同的 bar 基準**。
**推論（要驗）**：某個「決定要不要更新這兩個圖形」的**閘門狀態沒被 rollback**（例如某個純量旗標／`misc`／`tupleKeys`／`scopeVars` 條目，
或「已畫過」的標記），導致重跑時走了**不同分支**（跳過更新）⇒ 值黏在「上一次被丟棄的 forming bar」算出來的那組（tick 1 定調後每 tick 相同）。
**最直接的檢查順序**：① 該腳本裡這兩個圖形（line ＋ box）的建立/更新條件是什麼（`barstate.islast`？某旗標？）
② 那個條件的來源在 `IncCkpt` 裡有沒有被涵蓋（逐欄對 `misc`/`tupleKeys`/`scopeVars`/`declSlots`/`ctx.state` 找）。
換句話說：**先找「分支分歧」，不要再深挖 drawings 的 props 還原**（props 還原看起來是完整的）。

**已定位到受測腳本裡的對應程式碼（`src/pine/TRIS390.pine`，第 723–796 行「繪圖生命週期管理」）**：
```pine
723 // 繪圖生命週期管理
724 var label rollLabel = na
725 var line  rollWickLine = na
726 var box   rollBodyBox = na
727 var line  prevWickLine = na
728 var box   prevBodyBox = na
730 if barstate.islast
731     label.delete(rollLabel)   // ← 每 tick 先刪
732     line.delete(rollWickLine)
733     box.delete(rollBodyBox)
741 if barstate.islast and showRoll and rollReady
754     rollWickLine := line.new(wickXTime, rollHigh, wickXTime, rollLow, …, xloc=xloc.bar_time)   // ← drawings[4]（x1==x2 的垂直線）
764     rollBodyBox  := box.new(curBxTime, bodyTop, curBxTime + boxWTime, bodyBottom, …)            // ← drawings[5]
786     prevWickLine := line.new(…)   // 上一根
795     prevBodyBox  := box.new(…)
```
⇒ 分歧的 `drawings[4]`=**roll wick line**、`drawings[5]`=**roll body box**；兩者的 y 來自 `rollHigh/rollLow/bodyTop/bodyBottom`（由 rolling session 聚合而來）。
**這完全符合「黏住型分歧」的型式**：圖形在 `barstate.islast` 每次重建，若某個**上游持久狀態**（`rollOpen/rollHigh/rollLow/rollClose`、`rollReady`、`curBxTime/boxWTime/secPerBar_rt`
——特別是 **UDF 內的 `var`**：`f_supertrend` 的 `up/dn/trend`、`f_rangefilter` 的 `filt/upward/downward`、`f_halftrend` 的 `htState/stateBars`）
在 rollback 沒有回到 committed 值，重跑就會算出**另一組 y**，而 plot 看不到差（那些值只餵繪圖）。
**所以第一優先要查的是**：**UDF 區域的 `var`（函式內持久變數）在 `IncCkpt` 裡有沒有被涵蓋**（`snapCtxState` 的分類只涵蓋 `ctx.state` 的葉；
UDF `var` 若存在別的地方——例如 per-callsite 的 slot／misc／tupleKeys——就要確認它有進快照面）。

## T1（優先）A5「優化前」對照 —— 補上 A5 的 A/B 數字
**前置檢查（先做，缺就補起來）**：
- Vite 要在 `http://localhost:5173/vela` 有回應（`curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/vela` → 期望 200）。
  沒有就起：`cd C:\Users\bear9\OpenCharts && npx vite --port 5173 --strictPort`（**必須 `pty:false`**，否則假 ready；長時間掛著的 Vite 若 esbuild 子行程死掉 → 換 port 重起，**切勿 `npm i`**）。
  注意 **`127.0.0.1` 可能不通、`localhost` 才通**（Vite 綁 IPv6）。
- 行情要能給 bars：`curl -s http://127.0.0.1:8080/api/v1/health`；掛了就照 `skill://vela` 的啟動 SOP（金鑰、Windows pipe 死鎖陷阱：stdout/stderr 一律導到檔案）。
- 若資料源起不來 → 明確停下 T1 並在報告寫「前置不可得」，**不要**用假數字頂替。

程序已寫好在 `scratch/perf/a5-real-app.md`（關鍵：app boot 會把含 `request.security` 的腳本**剝離**到
`localStorage['vela-workspace-v2.parked-pine']`，idle 時才延遲還原 → **兩個 key 都要塞**；`tab.evaluate` 是表達式，要用 IIFE）。
1. 新快照 → 跑**優化後**一次（應為 ~9.9 s／500 根）→ 記錄。
2. `git checkout b9fcd81 -- src/pine` → 等 Vite 重整 → 跑**優化前**一次 → 記錄。
3. 還原（從第 1 步的新快照）→ `md5sum src/pine/*.ts` 與快照逐檔相同 → 再跑一次確認回到優化後數字。
- **驗收**：A5 兩個數字都在（優化後 < 優化前，預期差距 ≈2.5×）；樹還原且 md5 全等；`npx vitest run src/pine/__tests__/golden.test.ts` 0 差異。
- 觀測點：`globalThis.__pineRunLog`（`[{bars,ms}]`）、`window.__vela.cells()[0].chart.indicators()`。

## T2（次）S1 殘留風險量化：strategy 增量在**長歷史**下的成本
S1 已讓 strategy 走增量，但 `ctx.state` 的 plains（`strategy|simCache.byBar`、`excCache`、`ddCache.equity`）**每個 checkpoint 深拷貝** ⇒ 懷疑成本隨歷史長度成長（非 O(1)）；100 根不顯著，**5,000 根未量**。
- 在 `scratch/perf/` 寫探針（沿用 `s1-inc-probe.mjs` 的 parity 檢查），量 `bars = 500 / 2000 / 5000` 的**每 tick 中位 ms**（腳本用 `src/pine/TRIS390.pine`）。
- **驗收**：① 一張表（bars × 每 tick 中位 ms × 相對 500 根的倍率）② 結論「O(1)-like / 隨歷史成長」並附回歸係數或倍率 ③ 若判定為成長，**寫出**（不一定實作）最小修法（例：只深拷貝被本 tick 觸碰的 key、或改用 persistent 快照）④ 不得改語意：若順手實作，必須附 parity（含 na 逐值）與四支 digest 不變。
- 若 5,000 根跑不完，就報 500/2000 的實測與外插，並明說未達。

## T3（次）靜機 A3 複測（複核**已定案的分級門檻**）
- 確認當下負載低（`Get-CimInstance Win32_Processor | % LoadPercentage` 或等價、並記下同時有幾個 `node.exe`）。
- 跑 4 支腳本 500 根：`npx tsx scripts/perf/pine-bench.mjs --script <4 支> --bars 500 --repeat 5 --warmup 2 --out bench/pine/r5-autorun-a3.json --md`
- **驗收**：K55 / TRIS390 / MACD701 各自的 median、min–max、降幅（對 baseline `12,946.9 / 6,923.8 / 1,501.9`）、`NOISY` 旗標，並註明當時負載與 node 數。

## T4（A6 新判據複核，需安靜機）
使用者 2026-10-15 已把 A6 改寫定案為「**增量 tick 預算**」：**每個 live tick（增量）≤100 ms** 且 **增量 ≤ 冷載入 total ÷ 10**。
- 量測對象：**K55 app 腳本**（`scratch/perf/app-scripts/script-a1dcdea6-95114.pine`）與 **TRIS390**（`src/pine/TRIS390.pine`，strategy）。
- 方法：先確認負載低（記下負載%與同時 `node.exe` 數），再量「每個 tick 的增量中位 ms」與「同設定的冷載入 total」，算倍率。
  現成探針：`scratch/perf/s1-inc-probe.mjs`（`--bars 100 --ticks 6 --commit 3`，已內含 cold vs 增量 parity）；若 `scratch/perf/t2-strategy-scale.mjs` 存在就優先沿用。
- **驗收**：兩支腳本各自的「每 tick 中位 ms」與「倍率（cold/inc）」，並**明確寫出 TRIS390 是否 ≤100 ms**。
  參考現值（非安靜機）：K55 **55 ms／26.8×**、TRIS390 **107 ms／10.9×**（邊緣）。若安靜機仍 >100 ms → **誠實寫「A6 未過」**並附最小改進方向，不得放寬門檻。

## T5（**已取消**：B² 假說被實測推翻）
見 `docs/2026-10-15-r5-checkpoint-deepcopy-audit.md` **開頭的事後更正**。實測（`scratch/perf/t2-trade-calib.json`、`t2-trade-scan.json`）：
`simAt` 在 `orders.length` 改變時**整個丟掉 cache**（`strategy.ts:887`）⇒ 快照只含「**當前下單 epoch**」的 Sim ⇒ `Σ|execs|` 實測 **精確線性**（92/184/460），`elems` 1,794/3,174/7,314 = **4.08×**（B² 應為 25×）；
TRIS390 在此 fixture 根本不下單 ⇒ B² 項**精確為 0**。
**所以那節的 A/C 修法不做**；cloneDeep 在 500 根整趟只 ~5.6 ms（佔 tick ~5%），已確認的線性項（`containers` ~5.2 元素/根、`incRewind` ~140/根、restore 掃描 ~21/根）不值一輪。真正的 Θ(B²) 在別處 → 見 T8。

## T8（次）會交易腳本的 build/全趟 `simulate` replay 是 Θ(B²) ＋ series registry 每 tick 成長
- **Θ(B²) 主體**（實測）：build/全趟 replay **1,487.7 / 4,574.2 / 30,024.2 ms**（bars 5× 時 20.2× ≈ 平方）⇒ 這是「長歷史 ＋ 會交易腳本」真正的成本源，**不是 cloneDeep**。
  打點：`strategy.ts` 的 `simulate` 重播（`:296`、`:884-889` 一帶）——**先做歸因探針**（把 replay 拆成「每根 `simAt`」與「epoch 丟棄後整段重建」兩塊），再談修法。
- **series registry 成長**（實測）：`restoreCkpt` 對 `seriesSet` 每個 series 做 rewind；該集合每 tick 固定 **+150(B=100)／+201(B=500)**（被丟棄的 forming-bar eval 留下的 series），而歷史上的集合大小反而遞減（225/170/139）⇒ 長 session 記憶體成長隱憂。
  打點：找「forming-bar eval 建立的 series 沒被回收」的來源（`series.ts` registry ＋ `interpreter.ts` discarded-eval 路徑）。
- **驗收**：① 歸因表（bars × replay ms × `simAt` 次數 × epoch 重建次數）② seriesSet 每 tick 成長**回到 0**（或證明有界）③ 語意不變（四支 digest＋golden 0＋parity）④ 做不到就只交歸因與最小修法提案。若與 T7 衝突（同檔），**T7 優先**。
（舊 T5 的選項 A/C 細節已作廢，理由見 audit 文件的更正段；其行號清單仍可當「快照面上有哪些結構」的參考。）

## T6（次）MACD701_v72 的 MTF 成本：打點 ① ＋ ②
完整歸因、行號與驗收見 **`docs/2026-10-15-r5-macd701-mtf-attribution.md`**。
- **②（先做，最安全）**：`spec.cw` 冷載入不必全程開著（`mtf.ts:242-246`／`:2380-2390`；種下點 `interpreter.ts:3768`，真正的 checkpoint `:3689-3691`）。
  驗收：冷載入 `counters.mtf.cwPushes` 掉到 ~0、**tick 路徑數字不變**、`s1-inc-probe` parity 6/6。順手修掉壞掉的量測欄位 `cwPeak`（現為「只增不減 max 的差值」⇒ 恆 0）。
- **①（再做，ROI 最高但風險中高）**：`request.security` 用「**圖表時框 × 圖表標的**」時**不進 MTF 引擎**（判定點 `mtf.ts:2098-2108`；繞過 `:2118-2180` 與暖機 `:2171-2173`）。
  證據：`MACD701_v72.pine:11-13` 預設 `useCurrentRes=true` ⇒ `res="5"` ＝圖表 tf，卻貢獻 4,509 次 eval 的主體。
  `lookahead_on`／`gaps_on`／lower-tf／動態 sym 或 tuple **必須明確退回**原路徑；**不得改動 model digest**。
  驗收：`counters.mtf.evals` 自 4,509 明顯下降 ＋ digest `1580h2` 不變 ＋ golden 0 差異 ＋ parity 6/6。
- 任一心虛（parity 或 digest 有任何變化）→ **還原該打點**並誠實寫進報告。

## T9（修）`dvs`(ema/hma)、`stv`(rma) 同型無上限
依 `ta.ts` 既有 `WIN_RING_MAX` / `WIN_LEN_MAX` 的 **clear-on-full** 形狀加上限（**先量每群 live distinct-len 最大值再定值**，不要照抄 64）。
驗收：240 根 `ta.ema(close, cnt+1)` 與 `ta.rma` 的 states／memo **有界**（附上限值與實測）；輸出**逐值（含 na）0 差異**；K55 `gets/bar` 不變；四支 digest 不變；golden 0；954 passed／tsc 0。
停損：若 clear 會改變任何輸出值 → **不加**，改只交「量測＋提案」。

## T10（修）adaptive tick-skip 政策（`engine.ts`）
現況：在非空 tape 上實質**不可達**（live session 一定存在 ⇒ `!incHolder.live` 永不成立）→ 死碼＋誤導。
選項：① 移除該分支與其測試 ② 改由 `live.dead` 觸發。**先讀 `engine.test.ts:367` 附近的前提**，讓測試反映新契約（**不得放寬斷言**）。
驗收：`npx vitest run src/pine` 954 passed、`tsc` 0、四支 digest 不變。

## T11（修）MTF per-caller 快取命中 = 0（H2 病態）
證據：`hits ≡ agHits + invHits`（4 份資料集逐位元成立）⇒ `mtf.ts:1859` / `:1886` / `:1901` 三條 per-caller 讀取**從未命中**。
打點：per-caller 快取鍵改以 **callsite key** 取代 Scope 身分（沿 `interpreter.ts:404` 的 `callsiteKey` 慣例；P5 REAL PLAN 的 S2 條）。
驗收：`__mtfStats` 的 per-caller 命中數 **> 0** 且 `evals` 下降；四支 digest 不變；golden 0；954 passed／tsc 0；`s1-inc-probe` parity。
停損：命中仍為 0 → 交「為什麼鍵對不上」的歸因並**還原改動**。

## T12（修／量測）小項列管
- **`cwPeak` 欄位壞掉**（取「只增不減 max 的差值」⇒ 恆 0）：改成 `mtfCheckpoint` 記錄當下長度、由 harness 讀差值，或 harness 端改讀絕對峰值。驗收：**能讀出「單根 log 長度」**。
- **C2 `ta.vwma` 1 ulp**、**C3 forming-bar ring latch**、**`bind` 結構契約顯式化**：逐一判斷值不值得修；要修就附逐值等價證明，不修就在 `docs/2026-10-14-pine-perf-align.md` 遺留清單寫「已知、接受、理由」。

## 可選（前三項都完成且有餘裕才做）
- `dvs`(ema/hma)、`stv`(rma) 同型上限（`ta.ts`，沿用 `WIN_LEN_MAX` 形狀）：逐值 0 差異 + K55 `gets/bar` 不變。
- adaptive tick-skip 政策（非空 tape 實質不可達）：決定移除或改由 `live.dead` 觸發（`engine.ts`）。

## 交付
1. `docs/2026-10-15-r5-autorun-report.md`：T1/T2/T3 逐項**結論 → 證據（檔案:行號／數字／指令）→ 殘留 unknown**；明確寫「做了什麼、沒做什麼」。
2. 文末**自我檢查**：`src/pine` md5 與開工前相同？（列清單）／`vitest run src/pine` 幾過幾敗？／`tsc` 0？／四支 digest 是否仍為 `ze7byn/kb0glc/p4gddl/1580h2`？／golden 0 差異？
3. `PROGRESS.md` 追加一段（≤10 行）。
4. **不得**留下紅燈（測試／tsc／digest）。若某項做不完就還原該項的改動並在報告寫明。
