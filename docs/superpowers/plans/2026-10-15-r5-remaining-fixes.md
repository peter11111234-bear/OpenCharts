# R5 剩餘修復 Implementation Plan（v4 · 單一權威版）

> **日期：** 2026-10-15（v4 寫於 22:4x）
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（建議）或 superpowers:executing-plans，逐任務實作。步驟用 `- [ ]` 追蹤。

**Goal:** 收掉 OpenCharts Pine 直譯器 R5 剩下的兩項設計工作（T9 加固、T11 重做），其餘項目以「覆核 ＋ 文件更正」結案，最後跑一次凍結基線驗收。

**Architecture:** 兩個檔面——`src/pine/builtins/ta.ts`（T9）與 `src/pine/mtf.ts`（T11、T6②）；其餘是覆核與文件。

**Tech Stack:** TypeScript（ESM）、Node 24、`npx vitest`、`npx tsx`、`scripts/perf/pine-bench.mjs`、`scratch/perf/*.mjs`。

**Spec:** `docs/2026-10-15-r5-remaining-autorun.md`（T1–T12 定義）＋ `docs/2026-10-15-r5-fix-plan.md`（P1–P10）。

**Spec invariant:** 任何修改都不得改變可觀測輸出——四支凍結 digest（`ze7byn`／`kb0glc`／`1580h2`／`p4gddl`，100 根）逐字相同、`golden` 0 差異、`npx vitest run src/pine` 維持 **954 passed | 1 skipped**。

---

## 版本沿革與現況（必讀；本節為唯一現況來源）

- **v1** 憑記憶寫成 → 6 個獨立探子查出 **11 處缺陷**。
- **v2/v2.1** 逐條修正 → 3 個探子 ＋ 一次全文通讀又查出 **12 處缺陷**。
- **v3** 整份重寫 → 2 個探子（一致性、程式碼草稿）再查出 **3 項阻擋 ＋ 12 項小瑕疵**（含二層 state 設計會撞 key 路徑、兩段測試草稿的編譯錯）。
- **v4（本版）**：修正上述全部。**沒有任何「請套用 patch」的步驟——因為 0 支 patch 可用。**
- 缺陷與更正歷程：`docs/2026-10-15-r5-plan-verification-ledger.md`。

## §0 執行前必做（⚠️ 樹是活躍戰場；本檔所有指紋／行號都只是快照）

2026-10-15 22:3x–22:4x 期間，`src/pine` 有多個檔被另一代理改動，並出現**兩次「整檔被還原」**：
- **21:25:50** `mtf.ts` 被還原（T11 下樹）。
- **22:38:56** `engine.ts` 被還原（**tick-skip 回到樹上**，988→1000 行）。`engine.test.ts`（22:37:11）的敘述**已同步**改成「守衛存在，且可被空 tape 觸發（保留不刪）」⇒ **兩者一致**（2026-10-15 23:0x 覆核，Task 5 通過）。
- `series.ts` 22:41:36 仍在變；`git status` 另顯示 `draw.ts`／`math.ts`／`util.ts`／`qa_r2.test.ts` 等亦被改動。

**動工前一律先跑，並以結果為準（不要照本檔行號硬改）**：

```bash
cd /c/Users/bear9/OpenCharts && md5sum src/pine/engine.ts src/pine/mtf.ts src/pine/interpreter.ts src/pine/series.ts src/pine/builtins/ta.ts
cd /c/Users/bear9/OpenCharts && npx vitest run src/pine 2>&1 | tail -6
cd /c/Users/bear9/OpenCharts && grep -n "HEAVY_RUN_MS\|lastTapeKey\|Every request runs" src/pine/engine.ts
cd /c/Users/bear9/OpenCharts && grep -c "durableCache\|seenCallers\|EMPTY_SCOPE" src/pine/mtf.ts
```
任何不一致 ⇒ **以現況為準並在驗收報告記錄**（本檔的「快照值」只用來判斷「有沒有被別人動過」）。

**快照值（2026-10-15 22:4x 實測；僅供比對，非契約）**

| 檔 | 快照 | 備註 |
|---|---|---|
| `engine.ts` | **1000 行、`a11ee77d…`、mtime 22:38:56 ⇒ tick-skip 目前在樹上**（`:330` Adaptive tick policy／`:338 HEAVY_RUN_MS`／`:342 lastTapeKey`／`:347` skip／`:344 request(bars, force=false)`） | 與 22:3x 的 988 行／`d9047a1d…`（**已移除**）不同 ⇒ 被還原 |
| `engine.test.ts` | mtime 22:37:11；`:334 describe('tick policy', …)`（**已完成**：敘述＝守衛存在、可被空 tape 觸發；新增 empty-tape 測試且偵測力已驗） | 與 `engine.ts` **一致**（Task 5 覆核通過） |
| `mtf.ts` | 2411 行、`79d67c66…`（**T11 未套**）、mtime 21:25:50 | |
| `interpreter.ts` | 3991 行、`f5dfb86b…`、mtime 22:02:23 | |
| `series.ts` | `d671c204…`、mtime 22:41:36（仍在變） | |
| `ta.ts` | `96209 B`／`9f3237e3…`、mtime 20:45:36 | T9 未套 |
| **閘門（22:0x–22:1x 實測，在 22:37 那批改動之前）** | `vitest` 62 files／954 passed | 1 skipped；`tsc` rc=0；golden 14 passed 無差異；四支 digest `ze7byn`／`kb0glc`／`1580h2`／`p4gddl` 逐字相同；`s1-inc-probe` `PARITY OK` | 已被下一列取代 |
| **閘門（現況，2026-10-15 23:3x 實測；Task 4／5／1 落地後）** | `vitest` **64 files／958 passed ｜ 1 skipped** | `tsc` rc=0；四支 digest **仍逐字相同**（T9 後與 T6② 後各驗一次）；`counters.mtf.evals` 逐項不變（430／2922／4509／215） | T6② 的 parity／golden 待 Task 6 補 |

**可套用 patch：0 支**——4 支全為 `OBSOLETE`／`WITHDRAWN`（權威清單 `scratch/perf/patches/README.txt`；套用器 `apply-all.sh` 已無清單、只印手動閘門）。

⇒ 本計畫是「加固 ＋ 裁決 ＋ 覆核」；**沒有一項是「修一個已壞的東西」**，且**不依賴樹保持不變**（每個 Task 的第一步都是重取指紋）。

## 交付用 TODO 條目（可直接列管）

| id | 動作 | blocked by | 完成判準 |
|---|---|---|---|
| **R5-T9** | T9 加固：依 **D3** 決定「實作二層 state」或「僅記錄不做」 | **D3** 裁決 | Task 1 Done-when |
| **R5-T11** | T11 重做：依 **D1** 決定 A／B／C 後實作（C＝不做即結案） | **D1** 裁決 | Task 3 驗收 A 全綠 |
| **R5-T6②** | 依 **D2** 決定候選後實作（或不做即結案） | **D2** 裁決（T2，需人工確認） | Task 2 Done-when |
| **R5-T12#4** | 覆核 `ta.ts:412` 既有修法 ＋ 加判別性測試 | — | Task 4 Done-when |
| **R5-T10** | 覆核 tick-skip 已移除 ＋ 清掉 2 處過時措辭 | — | Task 5 Done-when |
| **R5-ACCEPT** | 四支 digest／golden／parity／tsc／bisect ＋ 驗收報告 | R5-T9、R5-T11、R5-T12#4、R5-T10（T6② 若判不做則不列） | Task 6 Done-when |

## Executor Rules

只在硬阻塞停手：缺依賴、工具拒跑、同一驗證 2 次不同修法仍紅。單一紅測試＝正常 TDD 迴圈，不是阻塞。
檔案位置／行號一律先 grep；**行號是參考值不是契約**。近 24h 內有另一個代理在改 `interpreter.ts`、`engine.ts` ⇒ 動工前重取指紋。

**Plan-specific Nevers:**
- **NEVER** 套用 `scratch/perf/patches/` 底下任何檔案：4 支全為 `OBSOLETE`／`WITHDRAWN`（T11 那支**已實測改壞值**；T6② 那支套用即 TypeError）。
- **NEVER** 把 `perf_bench.test.ts:171-172`、`mtf.test.ts:1307-1310`／`:1397-1398` 當成「舊行為期待值」去更新——它們是**正確性不變式**（見 Task 3 驗收 A）。
- **NEVER** 用 `--warmup 0` 當效能基準（`scripts/perf/README.md` 已知限制 3）。
- **NEVER** 把凍結 digest 的 MACD 來源換成 repo 內的 `scratch/perf/app-scripts/macd701_v72.pine`（`title="MACD_V7.01"`、`mtfSmoothLen=5`）；權威來源是 `C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine`（`V7.03`／`8`），否則重現不出 `1580h2`。
- **NEVER** 把「人工造出 `live=null`／`active=false`」的測試子類寫成常設測試（它斷言的是不可達狀態）。
- **NEVER** 同時跑兩個 `vitest`（會製造假紅燈：`qa_yield_c560c0f.test.ts:151` 曾因此在全套中紅，單跑 13/13 過）。

## Global Constraints

- 專案根 `C:\Users\bear9\OpenCharts`（realpath；`MYOPENCHART\OpenCharts` 是 junction，從那裡跑 vitest 會異常）。
- **shell 陷阱**：外層 shell 是 MSYS。**不要**用 `bash <檔案>` 巢狀、**不要**給工具 `cwd:` 參數（兩者都會掉進 WSL ⇒ Linux node ＋ `@esbuild/win32-x64` 不相容）。一律 `cd /c/Users/bear9/OpenCharts && <inline>`。
- 禁止：`npm i`、`git checkout/restore/stash`、kill 他方程序。
- 動工前：`cp -r src/pine "$TEMP/r5-preapply-$(date +%H%M)"`；回退來源 `scratch/perf/r5-pine-optimized-b9/pine`。
- **四支 digest 的權威重現指令**（config 依 `scratch/perf/iso/digest-100.json`）：
```bash
cd /c/Users/bear9/OpenCharts && npx tsx scripts/perf/pine-bench.mjs \
  --script scratch/perf/app-scripts/script-a1dcdea6-95114.pine \
  --script src/pine/TRIS390.pine \
  --script "C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine" \
  --script final.pine \
  --bars 100 --bars-file scratch/perf/iso/fixtures/bars-5m-mxf-500.json \
  --tf 5 --symbol MXFJ6 --engine-path direct --repeat 2 --warmup 2 \
  --out scratch/perf/iso/digest-verify.json
```
  digest 讀 JSON 的 `results[].output.digest.hash`（`--quiet` 只印輸出路徑）。
- **parity 的輸出契約**：`scratch/perf/s1-inc-probe.mjs` 逐 tick 印 ` match`／` MISMATCH`，收尾一行 `PARITY OK` 或 `PARITY FAILURES: n`；JSON 有 `failures[]`。**沒有「6/6」這種字串**。
- **bench 的 counters 欄位**（例如 `perCaller`）出自 bench JSON（`scripts/perf/README.md` §H4 的 `counters.mtf.status` 族），**不是** `src/pine` 裡的物件；`src/pine` 端的全域計數器叫 `__mtfStats`（`mtf.ts:1351`）。兩者不要混用。
- `scratch/perf/patches/apply-all.sh` 目前已無可套用 patch，只印手動閘門；它的 `gate()` 只跑 vitest＋tsc。

## Decision Points

### D1: T11（per-caller 快取鍵改 callsite 身分）要不要做、怎麼做   (T1)
- Consumed by: Task 3
- **狀態：前一版裁決（Chosen: C 單一鍵空間）已被實測推翻，重新開放。** 證據：套用該 patch 後 `perf_bench.test.ts` 的 `PARAM_SRC` 之 `f(close) − f(open)` 被凍成常數 `0.6090120128041576`（應逐根等於圖表 `close − open`），打紅**兩條**正確性不變式（共三處斷言，見 Task 3 驗收 A）。
- Candidates:
  - A (existing pattern): 兩條鍵空間——閘門 reject（值依賴呼叫者）者維持不可能跨 chart bar 命中，其餘走 callsite 鍵。
  - B (preferred): 新增「此運算式是否讀取呼叫者綁定」的判別旗標，命中者一律關閉跨 bar 快取。
  - C (minimal): 不做 T11。現行樹即此狀態，且已驗證良好。
- Criteria:
  - 驗收 A 的三處斷言全綠
  - bench JSON 的 `perCaller`（＝`hits − agHits − invHits`）明顯提升（附改前／改後兩份 JSON）
  - 四支 digest 逐字不變
- Chosen: **C（不做 T11）** —— 2026-10-15 23:0x 裁決。
- Rejected: 前版「單一鍵空間」打紅驗收 A。本版 A／B **未採**：D1 的判準 2（bench JSON 的 `perCaller` 明顯提升）需要安靜機才量得出，在今天的機器條件下無法通過驗收 ⇒ 做了也無法證明有效。
- Revisit trigger: A/B 實作後任一正確性斷言紅 ⇒ 立即退回 C。
- Outcome: 結案。`mtf.ts` 不動（md5 `79d67c66…` 維持）。

### D2: T6② 的 cw write-log 建立策略   (T2)
- Consumed by: Task 2
- **Status: needs human confirmation**
- 已知事實（逐字證據見 Task 2）：
  - `mtf.ts:2384` `    spec.cw ??= [];` 是全樹**唯一**建立點；寫入路徑 `mtf.ts:242-245` 是 `if (!spec.cw) return;`（**不** lazy 建立）；`mtf.ts:2387` 的 `spec.cw.length = 0;` **無防護**。
  - 已下架 patch 刪掉 `:2384` 卻留 `:2387` ⇒ 冷載入第一個 checkpoint 即 `TypeError`。
  - 實測（100 vs 500 根，探針 `scratch/perf/t6-cw-growth-probe.mts`）：`cwPushes` 5,431→26,631（TRIS390）、1,600→8,000（MACD701）；`cwPeak` 298→1,200、0→3,495 ⇒ **線性成長、非二次；日誌長度確實隨 bars 增大**。量級為數千短命物件、下個 checkpoint 即清 ⇒ **偏 perf nit，不是 leak**。
- Candidates:
  - A (minimal): 保留 `??= []`，只加 `resetPeak`（讓 `cwPeak` 可按 run 讀絕對值）與 `trimCw`（`bar < lastClosed` 時清）。零崩潰風險。
  - B (preferred): 把建立移到寫入路徑並只在 forming bar 建立——需把「當前 bar／`lastClosed`」傳進寫入路徑（介面變更）。
  - C (existing pattern): 保留建立點，改成有界（`spec.cw.length >= CW_LOG_MAX` 時 `shift()`）。
- Criteria:
  - 套用後冷載入不拋例外
  - tick 路徑 counters 逐項不變
  - `restoreSpec`（`mtf.ts:2312-2317`）仍有可用的回滾來源
- Chosen: **A（保留建立點，只加 `resetPeak` ＋ `trimCw`）** —— 2026-10-15 23:0x 人工確認。
- Rejected: 無防護地刪 `:2384` 違反「冷載入不拋例外」；B（建立移到寫入路徑）需改寫入路徑介面，改動過大而收益僅是冷載入的線性成長；C（只加上限）未解決冷載入時的全量累積。
- Outcome:（執行時填）

### D3: T9 是「實作加固」還是「僅記錄」   (T1)
- Consumed by: Task 1
- Candidates:
  - A (minimal): 僅記錄——真實腳本不會變（靜態掃描結論）；既有 `ema`／`hma`／`hma-in`／`vwma-pv`／`macd-l` 已 cap；剩餘成長只在使用者寫動態長度時出現。
  - B (preferred): 實作二層 state（`dmi` 三處 ＋ `kc` 族的 `kc-b`／`kc-r`／`hl-r` 及其 EMA 分支），讓兩個變動維度都受封。
- Criteria:
  - **240 根 vs 480 根**（**同相位**）的「`dvs` ＋ `stv` 子樹總條目數」不成長（`b − a ≤ 32`）。**不可用 120 vs 240**：截斷後的地圖大小以 `VS_LEN_MAX` 為週期擺動，那兩點差半個週期 ⇒ 修好後仍留下 +48／+64 的**假殘差**（恰為 `2 × 8 × 站點數`，實測逐項吻合）
  - `npx vitest run src/pine/__tests__/ta.test.ts` 全綠
  - 四支 digest 逐字不變
- Chosen: **B（實作二層有界表）** —— 2026-10-15 23:0x 裁決；設計見本檔 Task 1 Step 3。
- Rejected: A（僅記錄）——真實腳本雖不受影響，但本項驗收可當場證明、不需安靜機，故直接加固；沿用已作廢 patch 的 `, VS_LEN_MAX` 貼法違反「總條目數不成長」（`cap` 只封最後一層）。
- Outcome: **已實作**（2026-10-15 23:2x）。新增 `memoVs`／`stateVs`／`emaSelf`／`rmaStep`／`bound2`／`rmaVsBound`／`emaVsBound`（並把 `vseries`／`vstate`／`emaVs`／`rmaVs` 改成共用同一批 closure 工廠，避免兩份正文）；站點共 **13**：dmi 7（`dmi+p`／`dmi-m`／`dmi-dx` ＋ `dmi-tr`／`dmi-pr`／`dmi-mr`／`dmi-adx`）＋ kc 6（`hl-r`、`kc-b`／`kc-r` 的 EMA 與 WMA 兩支）。
  **正文缺陷 1（站點表不完整）**：Task 1 Step 3 的表只列 6 站，漏掉 dmi 的 4 條 `rmaVs` 鏈；量測顯示 dmi 的成長有 **2/3 在 `stv`**（`rmaVs` 落 `stv`，`vseries` 落 `dvs`）⇒ 只做表上 6 站過不了本項 Done-when。
  **正文缺陷 2（判準相位）**：Done-when 寫「120 vs 240 的 `b − a ≤ 32`」，但截斷後的地圖大小以 `VS_LEN_MAX` 為週期擺動，120／240 正好差半個週期 ⇒ 修好後殘差仍是 +48（dvs）／+64（stv），恰為 `2 × 8 × 站點數`，逐項吻合。改用**同相位**的 240 vs 480 ⇒ `b − a = 0`。
  實測（修前 → 修後，240 根）：dmi `dvs` 727→55、`stv` 1449→73；kc `dvs` 1330→58。
  閘門：新測試 2 green（修前兩支皆 FAIL：dmi +2160、kc +1320）；`ta.test.ts` 70 green；全套件 **958 passed ｜ 1 skipped**（64 檔）；`tsc` rc=0；四支 digest 逐字不變（`ze7byn`／`kb0glc`／`1580h2`／`p4gddl`）；邊界檢查 `VS_LEN_MAX = 1` 時 `ta.test.ts` ＋ 新測試仍全綠 ⇒ cap 語意不滲進值。
  **⚠️ 證據等級更正（QA ROUND 1 追加）**：四支 digest 對本項是**弱證據** —— 只有 `kb0glc`（`TRIS390.pine`）碰到 T9，而它是 `ta.dmi(diLength=adxLen, adxSmoothing=adxLen)`、`adxLen` 為常數 input ⇒ **內層 key 恆定，「兩維都變」那條路沒被走到**；另三支與 `ta.dmi`／`ta.kc` 無關。且 `ta.kc`／`ta.kcw` 全樹無腳本呼叫。**本項真正的證據是 `ta_state_bound.test.ts`（240 vs 480 逼兩個維度），不是 digest。**
  **⚠️ 站點數與範圍更正（QA ROUND 1 追加，反駁代理 A3）**：
  - **站點數是 12，不是 13**：`src/pine/builtins/ta.ts` 實際轉換 = dmi 7（`1454`／`1462`／`1474` 的 `bound2` ＋ `1471`／`1472`／`1473`／`1482` 的 `rmaVsBound`）＋ kc 5（`1510` `hl-r`、`1515`／`1516` `kc-b` 的 WMA／EMA、`1518`／`1519` `kc-r` 的 WMA／EMA）。上面那行自己列的 kc 清單就是 5 個，卻寫成「kc 6 … 共 13」⇒ 記數錯。
  - **「表格已受界」不成立（頭條更正）**：受界的只有 `dmi`／`kc`／`kcW`／`kcw` 的 **`dvs`／`stv`** 子樹（240 與 960 根都停在 `dvs 103`／`stv 137`、`dvs 106`）。**總表仍隨根數成長**：`dmi-vary` 240→480 總數 58850→167058（×2.84，`wvs` 1006→1950、`wring` 57600→164864）；`kcW-vary` 29802→117026；**`macd-vary` 的 `dvs` 507→987（+480 = 2/根）⇒ 無界**。⇒ 本項交付的是「`dmi`／`kc` 的 `dvs`／`stv` 受界」，不是「表格受界」；`macd`／`wvs`／`wring` 列為後續待辦（未排入本窗口）。
  - **值中立性同時被證實**：現樹 vs T9 前的快照樹，8 支 digest 全部相同，且非 na 計數證明比較器非空洞（`dmi-cycle30` nonNa=808/900、`kc-true-range` 900/900）⇒ 抽取與改寫未改任何值。
  - **附帶（非重構改動）**：`ta.ts` 的 diff 另含 `winRingReader` 改為只鎖已收盤 bar（`ta.ts:478`），刻意且有註解 —— 它不屬於抽取。

## Review Ledger

（執行時追加：`Task <N>: minor (deferred): <一行>`、rulings、fix-round 紀錄。）

---

### Task 1: T9 加固 —— 讓 `dmi`／`kc` 族的 state 隨長度成長有界

**Blocked by:** D3（裁決前不動 `ta.ts`）。

**Files:**
- Modify: `src/pine/builtins/ta.ts`
- Test: `src/pine/__tests__/ta_state_bound.test.ts`（Create）

**背景（已查驗的 cap 語意，逐字）**
`ta.ts:162-180` 的 `stateFor`（決定性行在 `:177`）：
```ts
  const leaf = parts[parts.length - 1]!;
  let s = m.get(leaf) as T | undefined;
  if (s === undefined) {
    if (cap !== undefined && m.size >= cap) m.clear();
    s = make(); m.set(leaf, s);
  }
```
⇒ **`cap` 只清「持有最後一個 tuple 元素」的那一層 Map，且只一層**。`vseries(key, fn, cap)`（`ta.ts:212-228`）＝ `stateFor(['dvs', ...kparts(key)], makeVS, cap)` ⇒ leaf ＝ `key` 最後一個元素。

**現行站點判定**
- `dmi`：`const tag = [rt.callsite ?? 'g', diL, adxL] as const;`（`:1405`）⇒ `dmi+p`(`:1406`)／`dmi-m`(`:1414`)／`dmi-dx`(`:1426`) 的 leaf ＝ **`adxL`（長度）** ⇒ cap 有效**但只封一層**：`diL` 是中層，每個不同 `diL` 都新開一張 map ⇒ **總條目數仍隨 bars 成長**。
- `kcParts`：`const tag = [rt.callsite ?? 'g', useWma ? 'w' : 'e', L, mult, useTr] as const;`（`:1455`）⇒ `hl-r`(`:1458`)／`kc-b`(`:1463`)／`kc-r`(`:1466`) 的 leaf ＝ **`useTr`（布林；且 `hl-r` 分支下恆 `false`）** ⇒ 補 cap **完全無效**。
- 對照組（**已** cap，leaf 全落在「長度」位置）：`ema`（`emaVs` 起於 `:609`，其 capped `stateFor` 在 `:614`）／`hma-in`(`:676`)／`hma`(`:682`)／`vwma-pv`(`:770`)／`macd-l`(`:1201`)。

**風險性質（靜態掃描結論）**：全 repo `.pine` 中 `ta.dmi(` 僅出現在 `src/pine/TRIS390.pine:288`（`ta.dmi(diLength = adxLen, adxSmoothing = adxLen)`，`adxLen` 為 input ⇒ 常數）；**沒有任何** `ta.dmi/ta.kc/ta.kcw(… bar_index …)`。⇒ 這是**給使用者任意 Pine 的加固**，不是現行 fixtures 的 bug（故 D3 可選「僅記錄」）。

**Assumptions:**
- `VS_LEN_MAX = 16`（`ta.ts:450`）對兩維都夠（`scratch/perf/t9-distinct-len.json` 的 `verdict.benchMaxDistinctLenSaturating` ＝ 9）。
- 清空後下次查詢重建 ⇒ 不改值。

**Done when:**
- 新測試 PASS：**240 根與 480 根**的「`dvs` ＋ `stv` 子樹總條目數」差 ≤32（**同相位**，理由見 D3 Criteria）；值語意由既有 `ta.test.ts` 守門。
- `npx vitest run src/pine/__tests__/ta.test.ts` 全綠。
- `npx vitest run src/pine` → 954 passed（＋新測試）；`npx tsc --noEmit` → rc=0。
- 四支 digest 逐字不變（Global Constraints 指令）；`golden` 無差異。
- 邊界：把 `VS_LEN_MAX` 暫時改成 `1` → 新測試仍 PASS（值不變、只是變慢）；若值變了代表 cap 語意被誤用。

- [ ] **Step 1: 寫失敗測試**

`src/pine/__tests__/ta_state_bound.test.ts`（helper **逐字**抄 `src/pine/__tests__/ta.test.ts`：`mkBars`:15-23／`newCtx`:26-38／`pushBar`:40-53／`call`:65-69／`iv`:72）：

```ts
import { describe, it, expect } from 'vitest';
import '../builtins/ta';
import { BUILTINS } from '../builtins/registry';
import { Series } from '../contracts';
import type { BarData, BuiltinCtx, Value } from '../contracts';
import type { RtCtx } from '../builtins/util';

// ── helper：逐字抄自 ta.test.ts:15-72 ────────────────────────────────────────
const mkBars = (n: number, gen?: (i: number) => Partial<BarData>): BarData[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: i * 60000,
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1000 + i * 10,
    ...(gen ? gen(i) : {}),
  }));

function newCtx(bars: BarData[]): BuiltinCtx {
  return {
    barIndex: -1,
    barCount: bars.length,
    open: new Series(), high: new Series(), low: new Series(), close: new Series(),
    volume: new Series(), time: new Series(),
    hl2: new Series(), hlc3: new Series(), ohlc4: new Series(), hlcc4: new Series(),
    plots: [], drawings: [], warnings: [], alerts: [], logs: [],
    syminfo: {},
    timeframe: { period: '1', multiplier: 1, isseconds: false, isminutes: true, isdaily: false, isweekly: false, ismonthly: false, isintraday: true },
    callUdf: () => { throw new Error('no udf in tests'); },
  };
}

function pushBar(ctx: BuiltinCtx, b: BarData, i: number): void {
  ctx.barIndex = i;
  ctx.open.set({ kind: 'float', v: b.open });
  ctx.high.set({ kind: 'float', v: b.high });
  ctx.low.set({ kind: 'float', v: b.low });
  ctx.close.set({ kind: 'float', v: b.close });
  ctx.volume.set({ kind: 'float', v: b.volume });
  ctx.time.set({ kind: 'int', v: b.openTime });
  ctx.hl2.set({ kind: 'float', v: (b.high + b.low) / 2 });
  ctx.hlc3.set({ kind: 'float', v: (b.high + b.low + b.close) / 3 });
  ctx.ohlc4.set({ kind: 'float', v: (b.open + b.high + b.low + b.close) / 4 });
  ctx.hlcc4.set({ kind: 'float', v: (b.high + b.low + b.close + b.close) / 4 });
}

const call = (name: string, ctx: BuiltinCtx, args: Value[], named: Record<string, Value> = {}): Value => {
  const fn = BUILTINS.get(`ta.${name}`);
  if (!fn) throw new Error(`ta.${name} not registered`);
  return fn(ctx, args, named);
};
const iv = (n: number): Value => ({ kind: 'int', v: n });

/** 子樹「所有層」的條目總數——這才是「總量有界」的度量（單看 leaf map 抓不到中層成長）。 */
function totalEntries(ctx: BuiltinCtx, group: string): number {
  let n = 0;
  const walk = (m: Map<unknown, unknown>) => {
    for (const [, v] of m) { n++; if (v instanceof Map) walk(v); }
  };
  const g = (ctx as RtCtx).state?.get(group);
  if (g instanceof Map) walk(g);
  return n;
}

/** dmi：只吃 (diLength, adxSmoothing) 兩個位置參數，OHLC 由 ctx 自讀
 *  （權威用法：ta.test.ts:458 `call('dmi', c, [iv(14), iv(14)])`）。 */
function dmiEntries(bars: number): number {
  const bs = mkBars(bars);
  const ctx = newCtx(bs);
  for (let i = 0; i < bars; i++) {
    pushBar(ctx, bs[i]!, i);
    const len = iv(i + 1);
    call('dmi', ctx, [len, len]);
  }
  return totalEntries(ctx, 'dvs');
}

/** kc：位置序 (source, length, mult, useTrueRange)；每根都給不同 L 與 mult ⇒ 兩維都逼出來。 */
function kcEntries(bars: number): number {
  const bs = mkBars(bars);
  const ctx = newCtx(bs);
  for (let i = 0; i < bars; i++) {
    pushBar(ctx, bs[i]!, i);
    const L = iv(i + 1), mult = iv(2 + (i % 3));
    call('kc', ctx, [{ kind: 'series', v: ctx.close }, L, mult, { kind: 'bool', v: false }]);
  }
  return totalEntries(ctx, 'dvs');
}

describe('ta state tables are bounded in total, not just per leaf map', () => {
  it('dmi: doubling bars must not double the entries', () => {
    const a = dmiEntries(120), b = dmiEntries(240);
    expect(a).toBeGreaterThan(0);
    expect(b - a).toBeLessThanOrEqual(32);      // 未修時 b−a ≈ 120 ⇒ FAIL
  });

  it('kc: doubling bars must not double the entries', () => {
    const a = kcEntries(120), b = kcEntries(240);
    expect(a).toBeGreaterThan(0);
    expect(b - a).toBeLessThanOrEqual(32);      // 未修時 leaf=useTr 恆 2，但中層 (L,mult) 每根新開 ⇒ FAIL
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /c/Users/bear9/OpenCharts && npx vitest run src/pine/__tests__/ta_state_bound.test.ts`
Expected: **兩個 it 都 FAIL**（`b − a` 遠大於 32）。

- [ ] **Step 3: 實作二層有界表（D3 選 B 時；照 `winStateFor:456-464` 的形狀）**

**為什麼不能用 `vseries` 疊兩層**：`vseries` 的葉節點會落在 `['dvs', ...key]` 這條 stateMap 路徑上；若再把容器放在同一條路徑的中間層，內層走訪會把容器當 Map 用 ⇒ `m.get is not a function`。`winStateFor` 的解法是：**被 cap 的那層放「普通 Map」，狀態物件存在該 Map 內，不進 stateMap 樹**。

先在 `ta.ts` 內（`winStateFor` 附近）加兩個小工具：

```ts
/** 照 vseries(:212-228) 的形狀建一個 memo VS——用於需要自訂存放位置與兩層 cap 的場合。 */
function memoVs(fn: (b: number) => number | undefined): VS {
  const memo = new Map<number, number | undefined>();
  return {
    last: -1,
    memo,
    get(b: number): number | undefined {
      if (b > this.last) this.last = b;
      if (memo.has(b)) return memo.get(b);
      const v = fn(b);
      memo.set(b, v);
      return v;
    },
  };
}

/** 兩層有界的 L-keyed 表：`parts` 尾端那一維吃 `stateFor` 的 cap，
 *  內層以 `innerKey` 為鍵、自行 clear（形狀照 winStateFor:456-464）。 */
function bound2<T>(ctx: BuiltinCtx, parts: readonly KPart[], innerKey: number | string, make: () => T): T {
  const byInner = stateFor<Map<number | string, T>>(ctx, parts, () => new Map(), VS_LEN_MAX);
  let st = byInner.get(innerKey);
  if (st === undefined) {
    if (byInner.size >= VS_LEN_MAX) byInner.clear();
    st = make();
    byInner.set(innerKey, st);
  }
  return st;
}
```

**站點改法（先做 `dmi+p`，其餘同型）**。原文（`:1405-1412`，逐字）：
```ts
  const tag = [rt.callsite ?? 'g', diL, adxL] as const;
  const plusDM = vseries(ctx, ['dmi+p', ...tag], (bb) => {
    const off = ctx.barIndex - bb;
    const h = num(ctx.high.get(off)), hp = num(ctx.high.get(off + 1));
    const l = num(ctx.low.get(off)), lp = num(ctx.low.get(off + 1));
    if (h === undefined || hp === undefined || l === undefined || lp === undefined) return undefined;
    const up = h - hp, dn = lp - l;
    return up > dn && up > 0 ? up : 0;
  });
```
改成（**lambda body 逐字不動**，只換外層容器）：
```ts
  const tag = [rt.callsite ?? 'g', diL, adxL] as const;
  const plusDM = bound2(ctx, ['dvs', 'dmi+p', rt.callsite ?? 'g', diL], adxL, () => memoVs((bb) => {
    const off = ctx.barIndex - bb;
    const h = num(ctx.high.get(off)), hp = num(ctx.high.get(off + 1));
    const l = num(ctx.low.get(off)), lp = num(ctx.low.get(off + 1));
    if (h === undefined || hp === undefined || l === undefined || lp === undefined) return undefined;
    const up = h - hp, dn = lp - l;
    return up > dn && up > 0 ? up : 0;
  }));
```
同型套用到 6 個站點。**模板只有 4 個元素**（`['dvs', '<key>', <site>, <尾端維>]`）＋ 一個內層 key：
```ts
bound2(ctx, ['dvs', '<key>', rt.callsite ?? 'g', <尾端維>], <內層 key>, () => memoVs(fn))
```
| 站點 | 行（參考） | 分支 | `parts` 尾端（吃 cap） | 內層 key |
|---|---|---|---|---|
| `dmi+p` | `:1406` | — | `diL` | `adxL` |
| `dmi-m` | `:1414` | — | `diL` | `adxL` |
| `dmi-dx` | `:1426` | — | `diL` | `adxL` |
| `kc-b` | `:1463` | **WMA**（`vseries`） | `L` | `` `${mult}|${useTr}` `` |
| `kc-r` | `:1466` | **WMA**（`vseries`） | `L` | `` `${mult}|${useTr}` `` |
| `hl-r` | `:1458` | WMA 分支專用（`useTr === false` 時才建） | `L` | `` `${mult}|${useTr}` `` |
| `kc-b`（`:1464`）／`kc-r`（`:1467`） | 同 | **EMA**（`emaVs(ctx, src, L, ['kc-b', ...tag])`） | `L` 或 `len`（依 `emaVs` 內部） | 同 |

**⚠️ 上表不完整（2026-10-15 23:2x 實測後補）：漏了 dmi 的 4 條 `rmaVs` 鏈。**
`dmi-tr`／`dmi-pr`／`dmi-mr`／`dmi-adx` 走 `rmaVs` → `vstate` ⇒ 落在 **`stv`**，不是 `dvs`。
240 根實測：dmi 的 `stv` 成長 **+1440**、`dvs` **+720** ⇒ **`stv` 是 `dvs` 的兩倍**；只做上表那 6 個站點**過不了本項 Done-when**。
這 4 條不能用 `bound2(... () => memoVs(fn))`，要用 `rmaVsBound(ctx, src, len, ['stv', 'rma', '<key>', site, <outer>], <inner>)` ——
`rmaStep` 的 `self` 必須重新解析**同一個兩層位置**（`rmaVsGet` 做不到這件事，改完後它已無呼叫者而刪除）。
`emaVs` 側同理需要 `emaVsBound`（kc 的 EMA 分支）。**實際站點總數＝13，不是 6。**

**兩點必須寫明**：
1. **`w`/`e` 那一維在 `tag` 裡（`[site, useWma ? 'w' : 'e', L, mult, useTr]`，`ta.ts:1455`）**：上表的模板以 `parts` 尾端＝`L` 表達，**`w`/`e` 必須留在 `parts` 內**（`['dvs','kc-b', site, w|e, L]`），否則 WMA／EMA 兩支會共用 state。表上只寫「尾端維」是為了可讀，實作要保留完整 `tag` 前綴。
2. **EMA 分支同樣要改，不是「若測試仍紅才改」**：Step 1 的 `kcEntries` 走 `ta.kc`（＝**EMA** 分支）⇒ 只改 WMA 分支測試仍會紅。用 `ta.kcw`／`ta.kcW` 可另外打到 WMA 分支。

- [ ] **Step 4: 跑測試確認通過** → `ta_state_bound.test.ts` 兩個 it 皆 PASS；並跑 `npx vitest run src/pine/__tests__/ta.test.ts` 全綠。
- [ ] **Step 5: 全套＋型別＋digest**

```bash
cd /c/Users/bear9/OpenCharts && npx vitest run src/pine && npx tsc --noEmit
```
Expected: 954 passed（＋新測試）／rc=0；四支 digest 逐字不變（Global Constraints 指令）。

- [ ] **Step 6: Commit** — `git add src/pine/builtins/ta.ts src/pine/__tests__/ta_state_bound.test.ts && git commit -m "fix(ta): bound the dmi/kc state tables in both varying dimensions"`

（若 D3 選 A：本任務只做「在 `docs/2026-10-15-t12-small-items.md` 追加一段：真實腳本不變、僅在動態長度時有理論成長、已作廢 patch 不採用」，然後結案。）

---

### Task 2: T6② cw write-log（**BLOCKED：等 D2 人工確認**）

**Blocked by:** D2（`Status: needs human confirmation`）。確認前**不得動任何程式碼**。

**Files（確認後）:**
- Modify: `src/pine/mtf.ts`（`mtfCheckpoint`:2380／`mtfRestore`:2392／自我註冊:2405-2411）
- Modify（候選 B 才需要）: `src/pine/interpreter.ts`（`incRunStart` 接線：`live.ckpt` 初始化 ~`:3705`、`:3719`、`:3793`；`restoreCkpt(s, live.ckpt)` 唯一呼叫 `:3779`（定義 `:3557`）；`ck.mtfSnap` 觸發 `:3624`）
- 已下架（僅供診斷，**勿套**）: `scratch/perf/patches/r5-t6tw-t12-cwpeak-trim.patch.WITHDRAWN`

**Interfaces（候選 A/C 皆需要）:**
- Produces: `MtfHooks.resetPeak?(): void`、`MtfHooks.trimCw?(): void`（加到 `MtfHooks` 介面內；該介面位於 `interpreter.ts:86-113`）

**Assumptions:**
- 可還原的 checkpoint 來源只有 `live.ckpt`（寫入點見上列 `interpreter.ts` 三處；`restoreCkpt` 全樹唯一呼叫點 `:3779`）⇒ 「`bar < lastClosed` 才清日誌」不會清掉不該清的東西；單根 tape（`lastClosed=-1`）時 `bar < -1` 永不成立。
- `resetMtf()`（`mtf.ts:264`）只 `store = newStore()`、**不碰** `__mtfStats`（`:1351`）⇒ 峰值需另設重置入口才能按 run 讀絕對值。

**Done when（依所選候選）:**
- 套用後**冷載入不拋例外**（現有 954 passed 維持）。
- A／C ⇒ `cwPushes` 維持現狀（線性、實測值見下表）；B ⇒ 冷載入不再隨根數成長（100 vs 500 比值 <2）。
- `resetPeak()` 後**首跑**即可讀到非 0 的 `cwPeak`（它是 max，讀絕對值，不可取差值）。
- tick 路徑 counters 逐項不變；`PARITY OK`；四支 digest 逐字不變。

**診斷證據（勿重蹈）**——已下架 patch hunk1 逐字：
```diff
-    spec.cw ??= [];
-    if (spec.cw.length > __mtfStats.cwPeak) __mtfStats.cwPeak = spec.cw.length;
+    if (spec.cw !== undefined && spec.cw.length > __mtfStats.cwPeak) __mtfStats.cwPeak = spec.cw.length;
     specs.push([spec, snapSpec(spec, ids)]);
     spec.cw.length = 0; // baseline — post-checkpoint writes accumulate here   ← context，無防護
```
`mtfCheckpoint` 在 `specs.push(...)` 之後仍對**每個 spec** 執行 `spec.cw.length = 0;`；唯一建立點被刪後該行必炸。原 patch 註解「The write path opens it lazily」與 `mtf.ts:243 if (!spec.cw) return;` 矛盾。

**實測（2026-10-15 22:1x，探針 `scratch/perf/t6-cw-growth-probe.mts`）**

| 腳本 | bars | `cwPushes` | `cwPeak` |
|---|---|---|---|
| `src/pine/TRIS390.pine` | 100 → 500 | 5,431 → 26,631 | 298 → 1,200 |
| `scratch/perf/app-scripts/script-a1dcdea6-95114.pine` | 100 → 500 | 402 → 2,002 | 0 → 0 |
| `C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine` | 100 → 500 | 1,600 → 8,000 | 0 → 3,495 |

⇒ **線性成長（非二次）**；日誌長度確實隨 bars 增大，但量級為數千短命物件且下個 checkpoint 即清 ⇒ 偏 perf nit。**依此，候選 A 已足夠。**

**Steps:** D2 確認後再拆（候選 A 的步驟可由 `resetPeak`／`trimCw` 兩支小函式 ＋ 兩處接線直接寫出）。

---

### Task 3: T11 per-caller 快取鍵 —— **不做為止（前版 patch 已證明改壞值）**

**Blocked by:** D1（裁決前不得動 `mtf.ts`）。
**Done when（＝驗收 A 的三處斷言全綠，且 B／C／D 全過）**。

**現況（2026-10-15 22:2x；omp 實測 ＋ 本計畫覆核）**
- `scratch/perf/patches/r5-t11-callsite-cache-key.patch.WITHDRAWN-BREAKS-VALUES` 套用乾淨、`tsc` 0、閘門計數變好——**但會改壞值**：
  - omp 實測（真樹）：套用後 `perf_bench.test.ts` 的 `PARAM_SRC` 之 `a − a2`（`f(close) − f(open)`）在 bar 13–18 **恆為 0.6090120128041576**；應為圖表自己的 `close − open`（0.5942／0.5785／0.5621／0.5449／0.5271／0.5087）。
- 機制：閘門 reject 的運算式（verdict 1／caller-scoped）之值**依賴呼叫者當下的值**（`p` ＝ `close`|`open`，逐 chart bar 變）；鍵改成不含任何隨 chart bar 變化的量（callsite 身分）⇒ 必然在同一個 tf bar 內回用第一次算出的值。
- ⇒ **D1 的 revisit trigger 已觸發**：本項停止，改列設計重做（A／B 或 C 不做）。

**Files（重做時）:**
- Modify: `src/pine/mtf.ts`
- Modify（**只允許**更新描述舊快取行為的期待值；驗收 A 的三處**不可動**）: `src/pine/__tests__/{mtf,mtf_invariance,perf_bench}.test.ts`
- 參考：`docs/2026-10-15-t11-implementation-dossier.md`（逐站點 before/after）、`docs/2026-10-15-omp-p2-p7-p10-notes.md`〈P4〉

**Assumptions:**
- `cwMap`（`mtf.ts:242`）不需改（參數已是 `{ delete(k: unknown): boolean }`，方法雙變性相容）。
- 刪除 `durableCache`／`seenCallers`／`EMPTY_SCOPE` 不會破壞測試編譯（**在 `src/pine` 內**只有 `mtf.ts` 與測試註解提到這些符號；`PROGRESS.md`、`graphify-out/`、`scratch/**/pine` 舊快照亦有字串，但不參與編譯）。

**驗收（任何重做選項都必須先過；行號已對 live 樹複驗）**

**A. 正確性不變式（兩條不變式、三處斷言）— 不可用「更新期待值」帶過：**
1. `src/pine/__tests__/perf_bench.test.ts:171-172`（所屬 test 自 `:155` 起；`:161` 是效能斷言，見 B）：
   ```ts
   expect(diffs.every((d, i) =>
     d === null || Math.abs(d - (CHART_BARS[i]!.close - CHART_BARS[i]!.open)) < 1e-9)).toBe(true);
   ```
2. `src/pine/__tests__/mtf.test.ts:1307-1310`（test 自 `:1270` 起，名為 `security() inside a UDF resolves params against the live caller frame`）：
   ```ts
   expect(gotA.slice(4, 8)).toEqual([4, 5, 6, 7]);          // chart close
   expect(gotB.slice(4, 8)).toEqual([104, 105, 106, 107]);  // chart volume
   expect(gotA).not.toEqual(gotB);
   ```
3. 同型斷言另有 `mtf.test.ts:1397-1398`。
4. 跑法：`npx vitest run src/pine/__tests__/perf_bench.test.ts src/pine/__tests__/mtf.test.ts` 必須全綠。

**B. 效能斷言（可更新，但要附量測）：** `perf_bench.test.ts:161 expect(d.evals).toBeGreaterThan(5000)` 描述的是舊快取行為；更新時附改前／改後兩組 JSON 數值。

**C. 全域閘門：** 四支 digest 逐字不變、`golden` 無差異、954 passed、`PARITY OK`。

**D. 附證：** 貼出改前／改後的 `a − a2` **逐根陣列**（證明不是常數）。

**Steps:** 等 D1 裁決後再拆。**在此之前不要動 `mtf.ts`**；驗收 A 的三處斷言不得修改。

---

### Task 4: T12#4 —— 覆核既有修法 ＋ 加判別性測試

**Blocked by:** None.

**Files:**
- Verify: `src/pine/builtins/ta.ts`（`winRingReader`）
- Test: `src/pine/__tests__/wring_latch.test.ts`（Create）

**Assumptions:**
- 樹上**已完成**修法，形式為「擋 set」而非「擋 read」：`ta.ts:412` `    if (i < ctx.barIndex && v !== undefined) ring.set(i, v);`（對照：`scratch/perf/r5-pine-optimized-b9/pine/builtins/ta.ts:402` 為 `    if (v !== undefined) ring.set(i, v);`）。書面紀錄：`docs/2026-10-15-t12-small-items.md`、`docs/2026-10-15-r5-autorun-status.json`。
- 因此**不需要**再改那一行；本任務只做覆核 ＋ 補測試。**行號會漂 ⇒ 以文字錨點定位。**

**Done when:**
- `ta.ts:412` 的 set 側守衛逐字存在（貼出原文）。
- 新測試具判別力：把 `:412` **暫時**還原成 `if (v !== undefined) ring.set(i, v);` → FAIL；還原成正確版 → PASS（未修樹已不存在，故這是唯一可行的判別證明）。
- `npx vitest run src/pine` 954 passed（＋新測試）；`tsc` rc=0；四支 digest 不變。

- [ ] **Step 1: 覆核既有修法**

Run: `cd /c/Users/bear9/OpenCharts && grep -n "ring.set" src/pine/builtins/ta.ts`
Expected: `412:    if (i < ctx.barIndex && v !== undefined) ring.set(i, v);`（若已變動 ⇒ 回報，不要自行改）。

- [ ] **Step 2: 寫判別性測試**

`src/pine/__tests__/wring_latch.test.ts`（helper 逐字抄 `ta.test.ts`：`mkBars`:15-23／`newCtx`:26-38／`pushBar`:40-53／`call`:65-69／`ser`:71／`iv`:72／`fv`:73／`numv`:75。**注意**：`setAt` 只在 `BarSeries`（`series.ts:180-181`），`Series`（`contracts.ts:59-84`）只有 `set/get/cur/size`；`ta.stoch` 回 **float 純量**（`ta.ts:1757` 的 `return fl(...)`），不是 array，故**不需要** `arrv`）：

```ts
import { describe, it, expect } from 'vitest';
import '../builtins/ta';
import { BUILTINS } from '../builtins/registry';
import { Series } from '../contracts';
import { BarSeries } from '../series';
import type { BarData, BuiltinCtx, Value } from '../contracts';

// ── helper：逐字抄自 ta.test.ts:15-78 ────────────────────────────────────────
const mkBars = (n: number, gen?: (i: number) => Partial<BarData>): BarData[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: i * 60000,
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1000 + i * 10,
    ...(gen ? gen(i) : {}),
  }));

function newCtx(bars: BarData[]): BuiltinCtx {
  return {
    barIndex: -1,
    barCount: bars.length,
    open: new Series(), high: new Series(), low: new Series(), close: new Series(),
    volume: new Series(), time: new Series(),
    hl2: new Series(), hlc3: new Series(), ohlc4: new Series(), hlcc4: new Series(),
    plots: [], drawings: [], warnings: [], alerts: [], logs: [],
    syminfo: {},
    timeframe: { period: '1', multiplier: 1, isseconds: false, isminutes: true, isdaily: false, isweekly: false, ismonthly: false, isintraday: true },
    callUdf: () => { throw new Error('no udf in tests'); },
  };
}

function pushBar(ctx: BuiltinCtx, b: BarData, i: number): void {
  ctx.barIndex = i;
  ctx.open.set({ kind: 'float', v: b.open });
  ctx.high.set({ kind: 'float', v: b.high });
  ctx.low.set({ kind: 'float', v: b.low });
  ctx.close.set({ kind: 'float', v: b.close });
  ctx.volume.set({ kind: 'float', v: b.volume });
  ctx.time.set({ kind: 'int', v: b.openTime });
  ctx.hl2.set({ kind: 'float', v: (b.high + b.low) / 2 });
  ctx.hlc3.set({ kind: 'float', v: (b.high + b.low + b.close) / 3 });
  ctx.ohlc4.set({ kind: 'float', v: (b.open + b.high + b.low + b.close) / 4 });
  ctx.hlcc4.set({ kind: 'float', v: (b.high + b.low + b.close + b.close) / 4 });
}

const call = (name: string, ctx: BuiltinCtx, args: Value[], named: Record<string, Value> = {}): Value => {
  const fn = BUILTINS.get(`ta.${name}`);
  if (!fn) throw new Error(`ta.${name} not registered`);
  return fn(ctx, args, named);
};
const ser = (s: Series): Value => ({ kind: 'series', v: s });
const iv = (n: number): Value => ({ kind: 'int', v: n });
const fv = (n: number): Value => ({ kind: 'float', v: n });
const numv = (v: Value): number => ((v.kind === 'float' || v.kind === 'int') ? v.v : NaN);

describe('winRing must not latch the forming bar (T12#4)', () => {
  it('re-reading after rewriting the forming bar returns the new value', () => {
    const bars = mkBars(6);                       // close = 100 + i ⇒ close[5] = 105
    const ctx = newCtx(bars);
    const hi = new BarSeries(), lo = new BarSeries();   // 必須在 bar 迴圈外建立 ⇒ 兩次呼叫共用同一 VS
    let out: Value[] | undefined;

    for (let i = 0; i < bars.length; i++) {
      pushBar(ctx, bars[i]!, i);
      hi.setAt(i, fv(10));                        // 本 bar 的 high 源
      lo.setAt(i, fv(0));
      const args = () => [ser(ctx.close), ser(hi), ser(lo), iv(2)];   // stoch 參數序 (source, high, low, length)
      const first = call('stoch', ctx, args());   // 100*(105-0)/(10-0) = 1050
      if (i !== bars.length - 1) continue;
      hi.setAt(i, fv(20));                        // 就地改寫 forming bar 的源（前例 ta.test.ts:774-775）
      out = [first, call('stoch', ctx, args())];
    }

    const [first, second] = out!;                 // stoch 回 {kind:'float'} ⇒ 直接解構
    expect(numv(first)).toBe(1050);
    expect(numv(second)).toBe(525);               // 未修時 ring 回舊的 10 ⇒ 1050（公式與期望值已對 ta.ts:1735-1758 複驗）
  });
});
```

- [ ] **Step 3: 證明測試具判別力（唯一可行的 TDD 證明）**

```bash
cd /c/Users/bear9/OpenCharts && cp src/pine/builtins/ta.ts "$TEMP/ta.ts.keep"
```
把 `:412` 暫時改成 `    if (v !== undefined) ring.set(i, v);` → 跑新測試 → **Expected: FAIL**（`second` 得 1050）
還原成 `    if (i < ctx.barIndex && v !== undefined) ring.set(i, v);` → **Expected: PASS**
（用 `edit` 改，不要用 `git checkout`；改完 `diff "$TEMP/ta.ts.keep" src/pine/builtins/ta.ts` 應為空）

- [ ] **Step 4: 全套＋commit**

```bash
cd /c/Users/bear9/OpenCharts && npx vitest run src/pine && npx tsc --noEmit
cd /c/Users/bear9/OpenCharts && git add src/pine/__tests__/wring_latch.test.ts && git commit -m "test(ta): discriminate the forming-bar winRing latch (T12#4)"
```

---

### Task 5: T10 —— **已由對方處理完畢**；本任務＝覆核（含我方對 P10 的更正）

**Blocked by:** None.

**⚠️ 更正（2026-10-15 22:5x）：我方先前的「死碼」結論有洞，以對方為準**
- 我方曾主張「skip 分支不可達、可視為死碼」。**該主張不成立**，可達路徑＝**空 tape**：
  `bars.length === 0` ⇒ `incRunStart` 回 `{ live: null }`（`:3698`）⇒ **`active === false`**；只要**前一次 run 的 `lastRunMs > 500`** 且 key 相同（空 tape 的 `tapeKey` 恆為 `"0:0"`），那條 `:347` 的 skip 就會觸發。
  我方漏掉的環節：我假設「空 tape 的 run 為 O(1)、不可能 >500ms」——那是**未經查證的假設**（`incRunStart` 對空 tape 仍會呼叫 `runScriptInner` ⇒ 仍要 parse/compile，重的腳本可能 >500ms）。
- **對方以測試證明它可達**：`src/pine/__tests__/engine.test.ts` 新增 `repeated empty-tape request is dropped while the last run is slow`，且**偵測力已驗**（把守衛停掉 ⇒ 第 405 行 `received 2` 失敗，非推論）。
- 因此對方把 P10 的移除整批**回退**：`engine.ts` 與 R5 基線 `diff -q` → **IDENTICAL**（逐字相同），`HEAVY_RUN_MS`／`lastRunMs`／`lastTapeKey`／`tapeKey`／`request()` 的 `force` 全部回來、`:338`／`:342`／`:347` 守衛在位 ⇒ **這是正確處置**。
- 附：`engine.test.ts` 原有 3 處「守衛被證明不可達並已移除」的**假註解**已被對方改成真話；`series.ts` 的 P1 註解亦已由對方收斂。

**本任務剩下唯一的工作＝覆核（不得再動程式碼、不得移除該分支）**

**Files:**
- Verify: `src/pine/engine.ts`、`src/pine/__tests__/engine.test.ts`

**Done when:**
- `engine.ts` 與 R5 基線 `diff -q` → **IDENTICAL**（或差異僅在本計畫認可範圍內）；`:338 HEAVY_RUN_MS`／`:342 lastTapeKey`／`:347` 守衛行在位。
- `npx vitest run src/pine/__tests__/engine.test.ts` → **23/23** 全綠（含新增的 empty-tape 測試）。
- 新增測試的**偵測力已在報告中記錄**（停掉守衛 ⇒ 該測試失敗）。
- `engine.ts` 與 `engine.test.ts` 的敘述**一致**（都說「守衛存在且可被空 tape 觸發」）；**不得**再出現「已移除」字樣。
- `npx vitest run src/pine` → **955 passed | 1 skipped**（現況；基線 954 是對方新增測試之前的數字）；`tsc --noEmit` → rc=0。

- [ ] **Step 1: 覆核**（上列命令／檢查逐條貼輸出）
- [ ] **Step 2: 若仍有「已移除／不可達」殘留字樣 ⇒ 只改敘述**（**不刪碼**）
- [ ] **Step 3: Commit（僅在 Step 2 有改動時）** — `git commit -m "docs(pine): tick-policy comments state the guard is live and reachable"`

**Step 2 的具體清單（三處；行號以 §0 重取者為準；**只改敘述、不刪碼**）**

1. `src/pine/interpreter.ts` 的 `incRunStart` doc（22:3x 快照在 `:3688`）：` *  Returns null session for empty tapes/ineligible scripts (caller falls` ⇒ 刪去 `/ineligible scripts`（改為 only empty tapes and aborted runs）。
   注意：`grep incEligible` = 0（沒有那個分支），但「ineligible（用 `request.*`）腳本」是**真實概念**（`inc-parity.test.ts:199` 有 live 測試，**該測試不改**）⇒ 要修的是「別讓人以為它會回 `live: null`」。
2. `src/pine/engine.ts` 的 `ineligible/absent → full run` 措辭（22:37 版在 `:477`）⇒ 改為 `no resume path → full run`。
3. 任何殘留的「守衛已移除／不可達」字樣 ⇒ 改成「守衛存在，且可被空 tape 觸發（保留不刪）」。

改完把三處的改前／改後貼進報告。

**P10 已結案（2026-10-16）**：敘述已更正、skip 側有測試（engine.test.ts:390）、豁免側有測試（engine.test.ts:361 `it('heavy run → forming-bar ticks keep running (no skip)')`）、行為不改（PROGRESS.md:712，該行測試名「heavy run + live session → forming-bar ticks keep running (skip exempted)」為舊稱，實名見 engine.test.ts:361）。

---

### Task 6: 最終驗收

**Blocked by:** Task 1、Task 3、Task 4、Task 5（Task 2 若 D2 判為不做則不列）。

**Files:**
- Create/追加: `docs/2026-10-15-r5-autorun-report.md`（**已存在則追加**，勿覆寫）
- Modify: `PROGRESS.md`

**Done when:**
- `md5sum src/pine/{mtf,interpreter,series,engine}.ts src/pine/builtins/ta.ts` 已貼出，且與動工前快照比對「改動檔＝預期集合」。
- `npx vitest run src/pine` → 954＋新增 passed；`npx tsc --noEmit` → rc=0。
- 四支 digest **逐字相同**（貼 `results[].output.digest.hash` ＝ `ze7byn`／`kb0glc`／`1580h2`／`p4gddl`；100 根，指令見 Global Constraints）。
- `npx vitest run src/pine/__tests__/golden.test.ts` → 無差異。
- `npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 5` → 收尾 **`PARITY OK`**。
- `npx tsx scratch/perf/t7-bisect.mjs --mode suffix --bars-list 300,400,500 --ticks 1` → 全 `match`。
- 報告三節：做了什麼／沒做什麼／殘留 unknown。

- [ ] **Step 1: 跑全部閘門並逐項貼輸出**（不可只寫「已通過」）。
- [ ] **Step 2: 寫報告**（逐項：結論 → 證據（檔案:行號／數字／指令）→ 殘留 unknown）。
- [ ] **Step 3: `PROGRESS.md` 追加一段**（≤10 行）。
- [ ] **Step 4: 紅燈清零**；有未過項則逐項回報並附最小重現。
- [ ] **Step 5: Commit** — `git add docs/ PROGRESS.md && git commit -m "docs(r5): final acceptance report"`

---

## Out of scope（各自獨立；不要塞進本計畫）

| 群 | 狀態與材料 |
|---|---|
| **T8a**（`simulate` 改可續跑 stepper，O(B)） | **未做**。唯一 blocker 已定位：`src/pine/builtins/strategyEquity.ts:34-58` 對每個過去 b 重呼 `simulate`，與 stepper 游標互污 ⇒ 需先把 scratch 移出 order，或讓 equityCurve 讀 stepper 的 per-bar equity。詳：`docs/2026-10-15-t8-stepper-dossier.md`、`docs/2026-10-15-t8-replay-attribution.md` |
| **T8b**（series registry 回滾剪回） | **已完成**（勿列待辦）。live 證據：`interpreter.ts` 的 `seriesCount: number;`（`:3262`）、`seriesCount: s.seriesSet.size,`（`:3512`）、剪回 `:3569-3572`；反事實探針 `scratch/perf/r5-t8b-registry-growth.mjs` |
| **T6①**（chart-tf×chart-sym 的 security 繞過 MTF） | 未做。`docs/2026-10-15-t6-one-dossier.md`（判定點 `mtf.ts:2028`，**須用解析後的 `tf`/`sym`**；`spec.tf===DYNAMIC` **不在**退回清單；「動態 tuple 才退回」）。改前基線已量（omp：MACD701@100 該 spec 307 evals，總 626） |
| **T6③**（builtin 呼叫路徑 per-call 配置） | 未做。`docs/2026-10-15-t6-three-dossier.md`（A 級可直接刪：`named{}`／`bindArgs` 的 `Object.keys()`／`liftNums` 空 named 快路）；驗收要求 `evalNodeCounts`／`setAt`／`mtf.evals` **完全不變** ⇒ 只能靠安靜機的 wall-clock 證明 |
| **T3／T4 量測** | 未做。4 支腳本：`scratch/perf/app-scripts/script-a1dcdea6-95114.pine`、`src/pine/TRIS390.pine`、`final.pine`、`C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine`（**不是** repo 內同名 scratch 檔）。**須安靜機**（`wmic cpu get loadpercentage` 連續 3 次 <25） |
| **P9／T12#2#3#5** | 已在樹上完成（`docs/2026-10-15-t12-small-items.md`）；T12#4 由 Task 4 覆核 |

## Self-Review（v4）

1. **Spec 覆蓋**：T9→Task 1；T6②→Task 2；T11→Task 3；T12#4→Task 4；T10→Task 5；驗收→Task 6。T7 已由另一代理落地（Task 6 以 bisect 驗收）；T3／T4／T8a／T6①／T6③ 明列 Out of scope 並附材料。**無未指派項**。
2. **檔名/日期**：`2026-10-15-r5-remaining-fixes.md` 含日期；標頭有 `> **日期：**`。
3. **Placeholder 掃描**：無 `TBD`／`TODO`；每個 code step 都有實際程式碼或實際命令。Task 2／Task 3 的 Steps 以 `**Steps:**` 明寫「等裁決後再拆」（D 區塊的規定動作）。
4. **型別一致**：`memoVs`／`bound2`／`VS_LEN_MAX`／`resetPeak`／`trimCw`／`DelayedEngine` 全文一致；**本文不採用**任何「人工造 `live=null`」的測試子類。
5. **錨點掃描**：所有「編輯既有程式碼」的步驟都附原文 ＋ 可搜錨點（Task 1 Step 3 的 6 列站點表、Task 4 Step 1/3、Task 5 Step 2）。
6. **決策掃描**：D1（T1，3 候選／3 判準／具名失敗理由／可觀察 revisit trigger）；D2（T2，`needs human confirmation`，3 候選）；D3（T1，2 候選）。T1＋T2 ＝ 3 ≤ 5。
7. **Done-when 掃描**：每任務都有可檢查條件與至少一個失敗／邊界條件（Task 1 的 `b − a ≤ 32` 兩個 it、Task 3 的三處正確性斷言、Task 4 的還原 FAIL／正確 PASS、Task 5 的 grep 只命中註解、Task 6 的紅燈清零）。
8. **Edge fit**：`Blocked by` 非 None 者共 **4 條**（Task 1←D3；Task 2←D2；Task 3←D1；Task 6←1,3,4,5），皆對應真實資料／介面依賴。
9. **引用存在性**：文中所有 patch 名皆為實際檔名；**沒有任何「請套用 patch」的步驟**；`scratch/perf/patches/README.txt` 已同步為「0 支可用」。

## 附錄 A：Fact Annex（本計畫每個可執行斷言的出處）

| 項 | 出處／實測 |
|---|---|
| 954 passed／tsc rc=0／golden 14 passed | 22:02–22:08 實跑 |
| 四支 digest／`PARITY OK` | 22:0x–22:1x 實跑（`scratch/perf/iso/digest-verify-*.json`） |
| tick-skip 已移除 | `engine.ts:330-338` 註解逐字；`request()` 無 `force`；988 行 |
| `live: null` 5 處 | `interpreter.ts:3698／3702／3703／3723／3731`（live 樹） |
| `buildSess` 界線與唯一 null | `:2891-3050`／`:2909` |
| `stateFor` 的 cap 語意 | `ta.ts:162-180`，決定性行 `:177` |
| `vseries` 的工廠形狀 | `ta.ts:212-228`（`{last, memo, get}`） |
| `winStateFor` 樣板 | `ta.ts:456-464`；`WIN_LEN_MAX:441`；`VS_LEN_MAX:450` |
| `dmi`／`kc` 的 tag | `ta.ts:1405`／`:1455`；站點 `:1406/1414/1426/1458/1463/1466` |
| 已 cap 對照組 | `ema`（`emaVs:609`／capped `stateFor:614`）／`hma-in:676`／`hma:682`／`vwma-pv:770`／`macd-l:1201` |
| `ta.ts:412` set 側守衛 | 逐字 `if (i < ctx.barIndex && v !== undefined) ring.set(i, v);` |
| `Series` vs `BarSeries` | `contracts.ts:59-84`（無 `setAt`）／`series.ts:89`＋`:180-181`（`setAt`） |
| `ta.test.ts` helper | `mkBars:15-23`／`newCtx:26-38`／`pushBar:40-53`／`call:65-69`／`ser:71`／`iv:72`／`fv:73`／`numv:75`／`dmi` 用法 `:458`／`stoch` 用法 `:497-499`／`BarSeries` 用法 `:542,754,771,774-775` |
| 三處正確性斷言 | `perf_bench.test.ts:171-172`（test `:155` 起）／`mtf.test.ts:1307-1310`（test `:1270` 起）／`:1397-1398` |
| `stoch` 公式與回傳 | `ta.ts:1735-1758`（`return fl(...)`） |
| cw 實測 | 探針 `scratch/perf/t6-cw-growth-probe.mts` 輸出（見 Task 2 表） |
| `MtfHooks` 位置 | `interpreter.ts:86-113` |
| `seriesCount` 剪回 | `interpreter.ts:3262/3512/3569-3572` |
| 腳本 flag | `pine-bench.mjs`（USAGE 內列）；`s1-inc-probe.mjs`（`--script/--bars/--ticks/--commit/--tf/--fixture/--json`）；`t7-bisect.mjs`（`--mode/--bars-list/--ticks/--out`） |

## 附錄 C：v4.2 更新與勘誤（2026-10-15 22:5x；**本附錄取代正文中下列值**）

**A. 閘門現況**（取代正文的「954 passed」）
- `npx vitest run src/pine` → **62 檔全過、955 passed | 1 skipped**（22:44:20 實測）。
  ⇒ Spec invariant 改述為「**passed 數不得下降**（基線 954；現況 955＝對方新增 `repeated empty-tape request is dropped while the last run is slow`）」。
- `npx tsc --noEmit` → rc=0；`npx vitest run src/pine/__tests__/engine.test.ts` → **23/23**。
- `src/pine/engine.ts` 與 R5 基線 `diff -q` → **IDENTICAL**（P10 回退後的狀態）。
- 四支 digest／golden／`PARITY OK` 仍是 22:0x–22:1x 的實測值（22:37 之後未重驗；Task 6 會跑一次）。

**B. Task 5 的現況（取代正文任何「skip 已移除」的敘述）**
- 對方已完成：`engine.ts` 回退（skip 在樹上）、`engine.test.ts` 3 處假註解更正、**新增 empty-tape 測試（偵測力已驗）**、`series.ts` 的 P1 註解收斂。
- 本計畫只做「覆核 ＋ 三處措辭」，**不得刪碼**（Task 5 Step 2 的清單）。

**C. 錨點勘誤**（正文這些值請以本表為準）

| 正文寫 | 正確值 |
|---|---|
| `ta.ts:1757` 的 `return fl(...)` | **`:1758`**（`:1757` 是 `if (c === undefined \|\| h === l) return NA;`） |
| `emaVs` 起於 `:609`、capped `stateFor` 在 `:614` | **`:613`／`:619`** |
| `engine.test.ts:333` 是 describe | **`:334`**（`:333` 為空行） |
| Task 2 的 `live.ckpt` 初始化 `~:3705` | **`:3707`** |
| Task 4 Step 2 稱 `numv`「逐字抄 `ta.test.ts:75`」 | `ta.test.ts:75-78` 的 `numv` 是 **throw 版**（`throw new Error(...)`）；草稿的 inline 版**功能等價但非逐字** |
| Task 1 Step 1 的 `kcEntries` 註解「leaf=useTr 恆 2」 | 該測試只傳 `useTrueRange=false` ⇒ leaf map **恆 1 個 key**（但仍會因中層 `(L,mult)` 每根新開而紅） |
| 正文「`engine.ts` 988 行／skip 已移除」 | **作廢**：現為 **1000 行、skip 在樹上**（見 §0 快照表） |

**D. 已知仍未同步的正文措辭**（不影響可執行性）：Task 1 Step 1 的 `kcEntries` 註解與 Task 4 的 `numv` 說明仍留有舊文字；執行時以 Step 1 的實際結果為準。


## 附錄 B：驗證憑證與殘留未知

- **驗證憑證**：本計畫的前提由 **11 個獨立唯讀探子** ＋ 1 次全文通讀查證（V1–V6、P10AliveNull、P10ActiveWriters、T9CapSemantics、T11GuardTests、PlanConsistency、V3Consistency、V3CodeSketch）。缺陷與更正歷程：`docs/2026-10-15-r5-plan-verification-ledger.md`。
- **殘留未知**：
  1. `interpreter.ts`／`engine.ts` 在 22:0x–22:3x 仍被另一代理改動 ⇒ 動工前務必重取指紋（本檔行號為 22:3x 實測值）。
  2. D1／D2／D3 三個裁決尚未定案（候選與判準已寫齊）。
  3. `qa_yield_c560c0f.test.ts:151` 曾在「同時跑兩個 vitest」時假紅（單跑 13/13 過）⇒ 見 Plan-specific Nevers。
  4. Task 1 Step 3 的 `bound2`／`memoVs` 為**依 `winStateFor`／`vseries` 的實作形狀設計**，尚未編譯過；Step 2 的測試會在第一時間驗證它（若 `tsc` 紅，先修型別再跑測試）。
