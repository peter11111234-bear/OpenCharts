# R5 剩餘工作自動跑報告（2026-10-15 窗口 B：18:00–20:00）

## 開工狀態檢查（18:00）
- 讀取 `docs/2026-10-15-r5-autorun-status.json`：T1、T2、T7 已標記 done；T3–T12 為 not_started（T5 cancelled）
- 樹狀態：`src/pine/series.ts` md5 `e158d372f3a4`（含 T7 修補）、`src/pine/mtf.ts` md5 `79d67c66b8e1`
- 基線驗證：`npx vitest run src/pine` 954 passed | 1 skipped、`tsc --noEmit` 0、四支 digest `ze7byn/kb0glc/1580h2/p4gddl` 逐字相同、golden 0 差異

## 任務執行記錄

### T8：會交易腳本 Θ(B²) 歸因與 series registry 成長
> **狀態**：done  
> **開始**：18:05  
> **完成**：21:05  
> **依據文件**：`docs/2026-10-15-t8-replay-attribution.md`、`scratch/perf/t2-trade-calib.json`、`scratch/perf/t2-trade-scan.json`、`scratch/perf/t8-replay-attrib.json`、`scratch/perf/t8-replay-attrib-variants.json`

**歸因結論**：
1. **Replay ramp 是主導項**：`simAt` 以 `uptoBar` 為鍵，每個 `strategy.*` 讀取都傳 `ctx.barIndex`；build/全趟的 barIndex 單調遞增 ⇒ **每根必然 miss** ⇒ 每次 `simulate()` 都從第 0 根重走到第 N 根。成本＝Σ uptoBar ＝ B(B−1)/2。實測：`replaySteps` = 4,950 / 19,900 / 124,750（bars 100/200/500），5× bars 得 ≈29.5×（平方級）。
2. **Epoch cache 丟棄貢獻 0 步**：`epochRebuildSteps` 0/0/0、`wastedReplays` 0 ⇒ 該機制不是主因。
3. **seriesSet 不隨 tick 成長**：實測固定 12（`scratch/perf/t2-scale-20261015-210126.json` 的 `retained.seriesSet`），與舊觀測 +150/+201 不符（可能是舊版探針誤讀）。

**修法方向（未實作）**：讓 Sim 增量（`simulate(N)` ＝ `simulate(N−1)` ＋ 新一根的 fills），或把鍵由 `uptoBar` 改為「已提交前綴＋增量」，使連續 bar 命中。驗收：`replaySteps` 由 B(B−1)/2 降為 O(B)；四支 digest 不變；`s1-inc-probe` parity 6/6；golden 0 差異。

---

### T6：MACD701_v72 MTF 成本（打點② → 打點①）
> **狀態**：in_progress  
> **開始**：21:10  
> **依據文件**：`docs/2026-10-15-r5-macd701-mtf-attribution.md` §3

---

### T9：dvs(ema/hma)、stv(rma) 同型上限
> **狀態**：pending

---

### T10：adaptive tick-skip 政策
> **狀態**：pending

---

### T11：MTF per-caller 快取命中 = 0
> **狀態**：pending

---

### T12：小項列管
> **狀態**：pending

---

### T3：靜機 A3 複測
> **狀態**：pending

---

### T4：A6 增量 tick 預算安靜機複核
> **狀態**：pending

---

## 收尾檢查（預計 19:45 開始）
- [ ] `src/pine` md5 與開工前相同
- [ ] `npx vitest run src/pine` 954 passed
- [ ] `tsc --noEmit` 0
- [ ] 四支 digest 仍為 `ze7byn/kb0glc/1580h2/p4gddl`
- [ ] golden 0 差異
- [ ] 更新 status.json 並追加 PROGRESS.md

---

# R5 收尾報告（窗口 D，omp；2026-10-15 23:0x–23:3x）

> 依 `docs/superpowers/plans/2026-10-15-r5-remaining-fixes.md` v4.2 執行。三個裁決由人工當場給定：
> **D1＝C（T11 不做）／D2＝A（保留 `??=`，只加 `resetPeak`＋`trimCw`）／D3＝B（實作二層有界表）**。

## 1. 做了什麼

| Task | 交付 | 證據 |
|---|---|---|
| **§0** | 開工前指紋覆核 | 5 檔 md5／行數／mtime 與 §0 快照**逐項一致**；守衛在 `engine.ts:338/342/347` |
| **Task 4（R5-T12#4）** | 覆核 ＋ 新 `__tests__/wring_latch.test.ts` | `ta.ts:412` 守衛逐字在。**判別力已驗**：暫時還原成 `if (v !== undefined) ring.set(i, v);` ⇒ `expected 525, received 1050` FAIL；還原 ⇒ PASS（`diff` 為空、md5 回 `9f3237e3…`） |
| **Task 5（R5-T10）** | 覆核 ＋ 只改敘述（不刪碼） | `engine.ts` 與 R5 基線 `diff -q` → **IDENTICAL**；`engine.test.ts` 23/23；兩處措辭見下 |
| **Task 1（R5-T9）** | 二層有界表 | 新 `__tests__/ta_state_bound.test.ts`；**修前 FAIL（dmi +2160／kc +1320）→ 修後 PASS**；`ta.test.ts` 70 green；`VS_LEN_MAX=1` 邊界仍全綠 |
| **Task 2（R5-T6②）** | `MtfHooks.resetPeak`／`trimCw` ＋ 4 個接線點 | 探針見 §3 |
| **Task 3（R5-T11）** | 結案不做（D1＝C） | `mtf.ts` 的 T11 符號未動（`grep -c "durableCache\|seenCallers\|EMPTY_SCOPE"` ＝ 16，與 §0 一致） |

**Task 5 的兩處措辭（改前 → 改後）**
1. `interpreter.ts` `incRunStart` 的 doc：`Returns null session for empty tapes/ineligible scripts (caller falls back to plain runScript).`
   → `Returns a null session for an empty tape or an aborted run — the caller then has no session to advance and rebuilds on the next call.`
   理由：`buildSess` 的唯一 null 是 `bars.length === 0`；`incRunStart` 的 `{live: null}` 只有空 tape ＋ `shouldAbort` 共 4 處；且 `interpreter.ts:3240` 已寫明 **Eligibility: EVERY script** ⇒「ineligible 腳本」這個概念不存在。
2. `engine.ts` `runProgram` 的 doc：`ineligible/absent → full run` → `no resume path → full run`。

## 2. 沒做什麼（及理由）

- **T11 重做**：D1＝C。A／B 的判準 2（bench 的 `perCaller` 明顯提升）需**安靜機**才量得出，今天無法通過驗收 ⇒ 做了也無法證明有效。`mtf.ts` 未動。
- **T3／T4 量測**：機器負載實測 59–79（門檻 <25）。
- **T8a stepper／T6① 圖表 tf 繞過 MTF／T6③ builtin per-call**：計畫已列 Out of scope。

## 3. 閘門（逐項實測輸出）

| 檢查 | 結果 |
|---|---|
| `npx vitest run src/pine` | **64 files passed ／ 958 passed ｜ 1 skipped** |
| `npx tsc --noEmit` | **rc=0** |
| `npx vitest run src/pine/__tests__/golden.test.ts` | **14 passed ｜ 1 skipped**，無差異 |
| 四支 digest（`pine-bench --bars 100 --repeat 2 --warmup 2`） | `ze7byn`／`kb0glc`／`1580h2`／`p4gddl` **逐字相同**（T9 後、T6② 後各驗一次） |
| `s1-inc-probe --script src/pine/TRIS390.pine --bars 500 --ticks 5` | 5 tick 全 `match`；收尾 **`PARITY OK`**；`setAt live/cold = 288032/288032`、`mtfEvals 2903/2903` |
| `t7-bisect --mode suffix --bars-list 300,400,500 --ticks 1` | 三檔全 `match`；`smallestDivergingBars = null` |

**T6② 探針**（`scratch/perf/t6-cw-growth-probe.mts`）

| 腳本 | bars | `cwPushes`（前→後） | `cwPeak`（前→後） |
|---|---|---|---|
| `TRIS390` | 100 / 500 | 5,431 → **5,431** ／ 26,631 → **26,631** | 298 → **3** ／ 1,200 → **3** |
| `script-a1dc…` | 100 / 500 | 402 → **402** ／ 2,002 → **2,002** | 0 → **0** ／ 0 → **0** |
| `MACD701_v72` | 100 / 500 | 1,600 → **1,600** ／ 8,000 → **8,000** | 0 → **10** ／ 3,495 → **10** |

⇒ 推入數逐項不變；`cwPeak` 由隨 bars 成長變成**常數**。
（探針原本讀 `cwPeak` 的**差值** —— 那正是它恆 0 的原因；已改成讀絕對值，因為 `resetPeak()` 現在每 run 開頭歸零。）

## 4. 改動檔（md5 現況）

| 檔 | md5 | 相對 §0 快照 |
|---|---|---|
| `mtf.ts` | `f907773384231e783e3d1cfa609566c1` | 變（T6② hooks ＋ 註解） |
| `interpreter.ts` | `4e99b544ea1501ff4d7caea66a801a33` | 變（措辭 ＋ hooks ＋ 接線） |
| `engine.ts` | `d076ee4ae599e9b7ad01589a099180aa` | 變（措辭） |
| `builtins/ta.ts` | `45d85594470333f9ba3d4b6903c30cea` | 變（T9） |
| `series.ts` | `d671c2046cf9d0f44bb0001bd589375f` | **不變** |

新增測試：`__tests__/wring_latch.test.ts`、`__tests__/ta_state_bound.test.ts`，以及 `__tests__/engine.test.ts` 的 empty-tape 測試 ⇒ 954 → **958 passed**。

## 5. 執行中發現的計畫缺陷（正文已修）

1. **Task 1 站點表不完整**：漏了 dmi 的 4 條 `rmaVs` 鏈（落 `stv`，佔 dmi 成長 2/3）⇒ 實際 **13 站**，非 6。
2. **Task 1 判準有相位假象**：120 vs 240 差半個 `VS_LEN_MAX` 週期 ⇒ 修好後仍留 +48／+64 的假殘差（＝`2 × 8 × 站點數`）；改用同相位 240 vs 480。
3. **§0 一處過時**：`engine.test.ts` 與 `engine.ts` 實際已一致（該檔最後修改 22:37:11，早於我們的註解修正）。

## 6. 殘留 unknown

1. **未 commit**：依 `AGENTS.md`〈Commit discipline〉「present the change and **wait for the user's review and approval** before committing」，所有改動仍在工作區。
2. **T11 的效能病態仍在**（D1＝C 結案）：per-caller 快取命中＝0、TRIS390 殘差 7481@500。要動它需安靜機 ＋ 重做設計。
3. **T9 的加固只對「動態長度」的使用者腳本有意義**：全 repo `.pine` 沒有腳本對 `dmi`／`kc` 傳動態長度 ⇒ 四支 digest 不變是預期結果，不是「沒生效」。
4. **`trimCw` 的安全性靠一個前提**：唯一可還原的 checkpoint 在 `lastClosed`。未來若新增其他 checkpoint 位置，此前提失效（已寫進 `MtfHooks.trimCw` 的註解）。
5. **T3／T4 仍未量**（負載 59–79）。

## 7. ROUND 1 QA 追加發現（2026-10-15 23:5x）

1. **專案閘門比本計畫寫的寬**：`README.md`／`package.json` 定義的 gate 是 `npm run typecheck`（`tsc --noEmit`）＋ `npm run test`（**`vitest run`，全 `src/**`**）。本計畫只指定 `npx vitest run src/pine` ⇒ 跨模組（`src/services/**` 等）未被覆蓋，收尾要補跑一次全量。
2. **`npm run lint` 是死 script**：`eslint` 不在 `devDependencies`，`node_modules/eslint` 不存在 ⇒ 這支從未跑起來過（repo 既有缺陷，非本輪造成；修它需 `npm i`，違反本計畫紅線 ⇒ 只記錄）。
3. **四支 digest 對 T9 是弱證據（重要）**：只有 `kb0glc`（`src/pine/TRIS390.pine`）碰到 T9，而 `TRIS390.pine:288` 是 `ta.dmi(diLength=adxLen, adxSmoothing=adxLen)`、`adxLen` 為常數 input ⇒ **`bound2` 的內層 key 恆定，沒走「兩維都變」那條路**；另三支與 `ta.dmi`／`ta.kc` 無關。且 `ta.kc`／`ta.kcw` **全樹沒有任何 `.pine` 腳本呼叫** ⇒ kc 那半只有單元測試涵蓋。**T9 的真正證據是 `ta_state_bound.test.ts`（240 vs 480 逼兩個維度），不是 digest。**
4. **worker 路徑未被任何儀器覆蓋（真缺口）**：`PineWorkerEngine.runProgram` 丟掉 `incHolder`、只轉發 `incKey`；`pineWorker.ts` 以 `incKey` 管 `IncLive`（`INC_CAP = 8`）。但 `pineWorkerEngine.test.ts` 只跑 `mode:'static'` 單發腳本、從不發第二個 tick，也不斷言 session 重用；真正測 live tick 的 `engine.test.ts` 用**行程內**引擎 ⇒ worker 上的 `incRunStart`／`trimCw`／`resetPeak` 行為無儀器覆蓋。另：worker 端 `incHolder.live` **從不寫入**（`pineWorkerEngine.ts:44` 只寫 `.active`），而 `.live` 只有 `engine.ts:347`（skip 守衛）與 `:484` 讀 ⇒ worker 上「有 live ⇒ tick 繼續跑」這條不變量不是它實際斷言的東西。
5. **`pineWorkerEngine.ts:39` 解構漏 `incSession`（真缺陷，已修）**：註解聲稱 `shouldAbort/sessionCtx/incSession are dropped`，但解構只丟了前者三者與 `incHolder` ⇒ `incSession` 會落進 `...rest` 被 `postMessage`。**型別層早已只准丟掉它**（`pineWorkerClient.ts:19` 的 `ClientRunOpts extends Omit<RunOptions, …, 'incSession'>`），`RunOptions.incSession` 的文件也寫「the worker keys its own map」⇒ **型別說一套、執行期另一套**，TS 對 `{...rest}` 不做多餘屬性檢查故靜默。今天不可達（`incSession` 只在**基底類別** `engine.ts:484` 才注入，worker 覆寫不走那條），但**修「worker 帶 live session」的方法正是注入它** ⇒ 陷阱是為下一個人準備的（`IncLive` 內含 `ctx.callUdf` 函式 ⇒ `DataCloneError`）。**已修**：解構加入 `incSession: _incSession`；`tsc` 0、`pineWorkerEngine.test.ts` 10/10。
6. **`trimCw`／`checkpoint` 依賴模組 `store` 的脆弱性（不可達）**：`mtfTrimCw` 走模組單例；`store` 有三處換點（`mtf.ts:265` `resetMtf`、`:527` `prepareSecurity`、`:2398` `mtfRestore`）；`mtfCheckpoint` **簽名無參數**（`:2384`）⇒ 傳進去的 session 被忽略，快照的是模組 `store`；而 **`incRunStart` 從不呼叫 `activate`**（全檔只有 `:3788`，那是 `incAdvance`）。唯一窗口是迴圈裡的 `await yieldTask()`。**但是**：`runScript`（`:2847`）與 `incRun`（`:3833`）串在同一條 `runScriptTail` 鏈上，而 `incRunStart` 的讓出是**在持有鏈的期間**發生的 ⇒ 兄弟 session 進不來 ⇒ **被互斥鎖確實封住，不是可達 bug**。建議在 `incRunStart` 頂端補 `if (s.mtf !== undefined) mtf?.activate?.(s.mtf);`（與 `incAdvance` 同型；`activateStore` 是無副作用單行 ⇒ 今天是 no-op），把隱含假設顯式化，不再依賴那條互斥鎖。
7. **探針讀值語意改變（預期）**：`s1-inc-probe.mjs:152,198`／`t2-strategy-scale.mjs:427,471` 都 `resetMtf()` 但**不** `resetPeak()` ⇒ 自動重置後它們從「程序 max」變「per-run」值，歷史數字不再可比。這是修復的意圖，但記錄以免誤讀舊輸出。
8. **`restoreCkpt` 只服務 forming-bar tick（更正一項誤解）**：`incAdvance` 有 `if (firstDiff <= live.committed) return 'fallback'`（`interpreter.ts:3776`）⇒ **改動任何已收盤 bar 一律退回冷跑**，不會走 `restoreCkpt`。唯一走還原的路徑是 **forming bar 被改寫**（`firstDiff = last > committed`）⇒ 先 `restoreCkpt` 再重評 forming bar。任何驗「rollback 不變量」的測試都必須改 forming bar，改已收盤 bar 測不到東西。
9. **`trimCw` 的效果是記憶體、不是數值（實測證明）**：`mtfCheckpoint` 是**完整快照**（`snapSpec`）並在末尾把 `spec.cw.length = 0` 當基線；`mtfRestore` 走 `restoreSpec` 從快照還原 ⇒ `cw` 只是 rollback 寫入日誌，清掉它**不改任何數值**。實測：把 `:3736` 的守衛拿掉（`bar < lastClosed + 99`），`pineWorkerEngine.test.ts` 全套**仍然全綠**。⇒ **這個守衛不可能用數值型測試守住**；它的儀器是 `__mtfStats.cwPeak`（`mtfResetPeak` 歸零）與四支 digest 的 `CW_PEAK`。任何聲稱「digest 值相同 ⇒ trim 正確」的說法都在測錯的東西。
10. **新增 worker realm tick 覆蓋（真缺口已補）**：`pineWorkerEngine.test.ts` 新增第 11 支測試——以 `FakeWorker` 驅動 `mode:'live'` session、改寫 **forming bar** 觸發 `notifyBars()`，斷言 (a) `client.incAlive === true`（session 被重用而非重建）、(b) `plot n` 在 forming bar 為 **5**（`var n = 0; n := n + 1`，即 `inc-parity.test.ts` 自己那條「不得 double-apply」不變量）、(c) 整個 model 等於**對同一份 bars 冷跑一次**的結果。**判別力已用突變證明**：把 `incAdvance` 的 `restoreCkpt(s, live.ckpt)` 改成 no-op ⇒ 該測試**變紅**，diff 顯示計數器多冒出第 6 點（double-apply）。`tsc` 0、11/11 綠。

## 8. ROUND 1 收斂與交付（2026-10-16 00:1x）

**收斂判定**：
- **全測綠**：`npm run test`（專案定義的 gate，全 `src/**`）⇒ **73 檔全過 / 1059 passed ｜ 1 skipped**；`npx tsc --noEmit` rc=0。先前只跑 `src/pine` 子集（§7-1）的缺口已關閉。
- **驗收逐條**：計畫 D1／D2／D3 的裁決與 Done-when 逐項對照完畢；T9 的值中立性由跨樹 8 digest 證實；T6② 的 cw 峰值由 digest 的 `CW_PEAK` 觀測。
- **新發現**：A3 的範圍推翻（下表）已記入計畫 D3 的更正註記，列為後續待辦 ⇒ 不屬本窗口交付範圍，不構成未收斂。

**T9／T6② 反駁判決（`VerifyT9AndT6tw2`，22 分鐘）**：

| 主張 | 判決 | 關鍵證據 |
|---|---|---|
| 抽取與改寫**行為等價** | ✅ 成立 | 現樹 vs T9 前快照樹，**8 支 digest 全同**（各 300 根）；非 na 計數證明比較器非空洞（`dmi-cycle30` 808/900、`kc-true-range` 900/900） |
| `rmaVsGet` 無其他呼叫者 | ✅ 成立 | `grep -rn rmaVsGet src/` 空 |
| 站點數 = 13 | ❌ 推翻 | 實為 **12**（dmi 7 ＋ kc 5）；計畫自身列出的 kc 清單即 5 個 |
| 「表格已受界」 | ❌ 推翻 | `dvs`/`stv` 對 dmi/kc 受界（240→960 根停在 103/137、106）；**總表不受界**：`dmi-vary` 58850→167058、`kcW-vary` 29802→117026、**`macd-vary` `dvs` +2/根** |

**本窗口交付定義**：T9（`dmi`/`kc` 的 `dvs`/`stv` 受界，值中立）＋ T6②（`resetPeak` 自動重置 ＋ `trimCw`）＋ 三項 QA 修正（worker 邊界 `incSession`、worker tick 覆蓋、文件更正）。**不含**：`macd`/`wvs`/`wring` 的無界成長（後續待辦）。

## 9. P8 三視角 Code Review（2026-10-16 00:4x）

範圍：未提交工作樹全部 16 檔（+1933/-367）。三支代理（正確性／安全／可維護性），**只讀**。

**判定：無 blocker**；1 個 major（安全，既有缺陷）、2 個 minor（正確性）、4 個 minor（可維護性）。核心機制經正確性代理逐條追過後成立：`IncSnap.len` 水位修掉雙次 rewind 的別名長度問題；`CellSeries` virtual ≡ `buf=[v]*n`；`stableArgSeries`/`SiteSeries` 只換 identity 不換值；`bound2`/`VS_LEN_MAX`/`WIN_LEN_MAX`/`WIN_RING_MAX` 只丟可重算 state；`tfInvariant` 不跨 caller 共用；`coerceIn('coord')` 與 engine 消費端一致；`EMPTY_NAMED` 無任何寫入。

### 9.1 本輪已修

| 來源 | 問題 | 處置與證據 |
|---|---|---|
| 可維護性 #1 | `ta_state_bound.test.ts` 的 fixture 讓兩維**同步**成長 ⇒ `bound2` 的**內層** cap（`ta.ts:297`）從未觸發，刪掉它整套仍綠 | 新增 `dmiInnerEntries`（**固定** `diLength`、成長 `adxSmoothing`，因為 `dmi` 的 outer 末端是 `diL`、內層 map 以 `adxL` 為鍵）＋新測試。**突變證明**：拿掉 `:297` 內層清空 ⇒ 新測試**紅**（`expected 1440 ≤ 32`），而舊 fixture 那支**仍綠** ⇒ 代理指控成立；還原後 3/3 綠 |
| 可維護性 #2 | `series.ts:14` 註解仍寫 `tfDirty`（已併入 `tfSeries`）、`input.ts:81` 仍寫 `siteStack`（已改名 `siteCtx`） | 兩處改字（**註解說謊**與 §7-5 同類） |
| 可維護性 #3 | `PROGRESS.md:720` 仍寫 T9「13 站點」 | 改為 12 ＋ 更正註記 |
| 可維護性 #4 | `docs/2026-10-13-remaining-work.md:195,200`（H1 主張增量不適用 `request.security`/strategy；H7 把 `vwma` 列為每 bar O(L) 直掃）已被本輪改動推翻 | 兩列標註推翻（H1 現為 "Eligibility: EVERY script"；H7 的 `vwma` 已走滑動窗 `ssumWin`） |
| 安全 #2 | `str.format` 的 `{key}` 走 named 記錄的**原型鏈**：`{constructor}` 取到繼承成員並渲染成 `undefined` 而非 `NaN`（經確認**非**原型污染、無外洩） | `str.ts:183` 改用 `Object.hasOwn(named, key)` |
| 正確性 F1 | 「1 根 tape／top-level 早退時 seed checkpoint 不可還原」（代理自評信心 0.75，靜態推導） | **測試推翻**：兩情境與冷跑**完全等價**（`inc-parity.test.ts` 新增 2 支，9/9 綠）；兩支保留為**永久覆蓋**——原 fuzz 測試的 tape 是 12 根且無早退，正好沒蓋到這兩塊 |
| 正確性 F2 | `trimCw` 讓早退時 seed 的 rollback 日誌為空 | 代理自述**值中立**（自癒快取），F1 已證等價 ⇒ 不需修 |

### 9.2 未修（後續／待決策）

| 來源 | 問題 | 狀態 |
|---|---|---|
| 安全 #1（**major**） | `stateFor(...)` **不傳 `cap`** 的站點仍隨 bars 無界成長：`vwap`（`ta.ts:1715-1717`）、`fisher`（`:1551-1553`）、`sar`（`:1624-1626`）、`supe/trend`（`:1195-1197`）、`:202`；leaf 是**腳本可控數值**（`ta.sar(bar_index*1e-6, …)`）⇒ 任何第三方腳本＋長 tape 即可驅動 Θ(bars) 記憶體；**且無全域 `ctx.state` 上限、無淘汰、無 OOM 降級** | **待決策**：加全域上限當第二道防線 vs 只記錄 |
| 正確性 殘留 1 | `interpreter.ts:3804` 的 HTF refresh 仍以 `bars.length > oldLen` 為閘 ⇒ same-length tick 且 forming bar 跨桶時尾桶不重抓（既有行為、觸發面窄） | **已加測試、尚未收斂**（見下） |
| 正確性 殘留 3 | `dvs`/`stv` 總表不受界（見 §8 表） | 已列後續 |

### 9.3 殘留 1 的實驗結果（2026-10-16 上午）

已加測試 `inc-parity.test.ts` →「`request.security`: same-length tick that crosses the HTF bucket (lookahead_on)」：tape 長度不變、把 forming bar 的 `openTime` 從第 1 個 5 分桶推到第 2 個，`lookahead_on`，比對冷跑 ⇒ **PASS（10/10）**。

但**判別力實驗顯示它抓不到 refresh 閘門**：把 `:3804` 的 `bars.length > oldLen` 改成永不 refresh，新測試**仍綠**；只有既有那支的 `expect(fetches).toBe(4)`（fetch 計數）會紅。⇒ 在現在這個 fixture 裡，**值與 refresh 與否無關**（fetch stub 回傳常數內容、`resetTfFrame` 只在內容變更時丟棄 tf frame），所以殘留 1 的「尾桶落後」不是**可觀測值差異**，而是「缺少重抓」這個行為面的缺口。

**結論**：此測試保留（它覆蓋了 fuzz 測不到的地帶——跨桶），但殘留 1 仍未收斂：需要一個「內容真的變了、只有 refresh 能救」的 fixture 才能把行為面釘死，或接受「值中立、只是多一次本可避免的重抓」而在計畫裡結案。已驗：`tsc` rc=0、`inc-parity.test.ts` 10/10。

### 9.4 判定為非缺陷（不再重報）

`tfInvariant`→`false` 與拿掉 `winRingReader` 快取都是**保守降級**，綠燈即正確（危險方向是「過度 eager」，已有 `perf_bench.test.ts`/`mtf.test.ts` 的 `agHits`/`evals` 門檻擋住）；`CwEntry` 的 `{o,k}` 變體為死碼（非缺陷）；「lint 死 script」§7-2 已記。