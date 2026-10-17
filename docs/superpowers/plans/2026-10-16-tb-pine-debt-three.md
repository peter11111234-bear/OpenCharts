# Tier B — Pine 三項債修復 REAL PLAN（v2, 2026-10-16）

> v1 → v2 變更（advisor 複核結論，2026-10-16）：
> | v1 | 問題 | v2 |
> |---|---|---|
> | Step B1「改 2 檔各 1 運算式 ＋ 紅測試」 | **Critical**：該債早已由 `482b776`（2026-10-09）修掉；紅測試**不可能紅**；且提案的 `src.size()` 是 tf 域值混進 chart 域 `base` ⇒ **有害** | B1 降為**純驗證 ＋ 文件更正**（不碰 `src/**`） |
> | B2 文件落點寫 `docs/2026-10-15-r5-remaining-fixes.md` | **Important**：該路徑不存在（實際在 `docs/superpowers/plans/`） | 路徑更正 |
> | `mtf.ts:1063-1065/:1066-1069` | Minor 行號差一 | 更正為 `:1064-1066`／`:1067-1070` |
> | 未提 G3 副作用 | Minor | 已於 §4 註明 G3 會寫 `bench/pine/<label>.json` |

> 驗證基線（開工前實測）：`npx vitest run src/pine` = 65 files / 970 passed | 1 skipped；`npx tsc --noEmit` rc=0；四支 digest `ze7byn/kb0glc/1580h2/p4gddl`；`src/pine/mtf.ts` md5 `b8da64c1bcc03e534db45e30983fc2f8`。

## 0. 已驗證事實

| # | 事實 | 證據 |
|---|---|---|
| F1 | **B1 已修、無需改碼**：`CowSeries.writable` 的 `const base = Math.max(bar, src instanceof BarSeries ? src.currentBar : 0);`——`SecSeries.currentBar === -1` 但外層 `Math.max(bar, …)` 使其取 `bar`（chart bar ≥ 0）⇒ 副本迴圈 `b=0..bar` **會**填滿 | advisor 實跑 repro（5 bars）：`s = [na,101,102,103,104]`、`s1 = [na,na,101,102,103]` ⇒ `s1[i]==s[i-1]` ∀i≥1；另 4 變體（sec=D/20bars、sec=5/20bars、UDF 內對 param `:=`、`var` 槽讀 `s[1]/s[2]`）皆正確 |
| F2 | 該債的修補是 `482b776`（2026-10-09，「writable base seed guard」），舊碼為 `src instanceof BarSeries ? src.currentBar : Math.max(bar, 0)` | advisor 以 `git log -S` 定位 |
| F3 | ⚠️ **禁止**照 v1 提案改 `src.currentBar < 0 ? src.size() : …`：`SecSeries.size() = j+1` 是 **tf 域**（`atTf(k)` 取 tf bar k），而 `base` 索引 **chart 域**副本 ⇒ 當 `j+1 > bar` 時會 seed「未來」bar，並使 `seed()` 的 `bar >= cow.currentBar` 轉 false ⇒ 跳過每根 re-init | `mtf.ts:1064-1066`（size）、advisor 的域分析 |
| F4 | 病灶仍存在的**同構副本**：`mtf.ts:1261-1269`（`:1264` 逐字相同）——與 F1 同形，同樣**無需改** | 兩份獨立來源逐字比對 |
| F5 | `audit-cow-alias.md` 的 F3 段（`:36-48`）描述的是 **482b776 之前**的舊碼 ⇒ 該段已 superseded | advisor 對照現碼與實跑 |
| F6 | 四支 digest 不涉 `array.from` 之外的風險：`final.pine:12` 為 `float leg1 = na`（純量槽，`:=` 不經 CowSeries） | `final.pine:12-19` 逐字 |
| F7 | **B2 為零行為差**：`engine.ts` 現樹**已無**「死碼／不可達／已移除」假敘述；無 `.github` CI、無測試斷言註解文字、無腳本 grep 該註解 | grep 0 命中、`ls .github` 不存在 |
| F8 | **B3 為真債**：`array.from` 現為 `arrVal(args.slice())`（註解自述 live-series）⇒ 實測 `array.from(close, close)` 的 element0 = 完整 close 欄（**LIVE**） | `array.ts:79-80`；advisor 實測 |
| F9 | **B3 修法形狀正確**：`snap = (v) => unwrapped(v) ?? NA`（`array.ts:18`），而 `unwrapped` 對 series 取**當前值**（`util.ts:130-132`）⇒ 與同檔入庫路徑（`:103/:108/:116/:121/:131`）同構 | advisor 逐字 |
| F10 | 四支 digest 中僅 `script-a1dcdea6-95114.pine` 用 `array.from`（4 次），引數為字串字面值或 UDF **純量**參數 ⇒ 不影響 digest（最終以 G3 為準） | grep ＋ `:340/:385-388` |

## 1. 步驟

### Step B1 — 純驗證 ＋ 文件更正（**不改 `src/**`**）

1. 跑 shift 檢查 repro（沿用 F1 的腳本），把 `s` / `s1` 逐值輸出貼進報告。
   → 驗證：`s1[i] == s[i-1]` ∀i≥1（5/5）
2. `docs/superpowers/audits/audit-cow-alias.md:36-48` 的 F3 段加上 `~~…~~ → **已由 482b776 修復（2026-10-09）；本段描述為修復前舊碼**` 標註（不刪原文）。
3. `docs/superpowers/plans/2026-10-13-pine-core-debt-consolidated.md:29-31` 的 N1 條目改為 `[x]` 並註明 `已由 482b776 修復；驗證：shift 檢查 s1[i]==s[i-1] 全通過`。
   → 驗證：兩處 diff 逐條貼出

### Step B2 — 純驗證 ＋ 文件更正（**不改 `src/**`**）

1. `grep -n "死碼\|不可達\|已移除\|unreachable" src/pine/engine.ts` ⇒ 預期 0 命中；`ls -d .github` ⇒ 不存在。
2. 貼出既有兩側判別性測試：`engine.test.ts:361`（豁免側）、`:390`（skip 側）、`:415`（cheap 每 tick 重跑）。
3. 在 `docs/superpowers/plans/2026-10-15-r5-remaining-fixes.md` 的 P10 節補一行結案（**路徑已更正**）：`P10 已結案：敘述已更正、skip 側有測試（engine.test.ts:390）、行為不改（PROGRESS.md:712）`。
   → 驗證：grep 0 命中 ＋ 兩側測試名逐字 ＋ 該行 diff

### Step B3 — `array.from` 取快照（**唯一的碼改動**）

> B3 關閉 N2（`2026-10-13-pine-core-debt-consolidated.md` §2 新列入計畫清單的 latent 條目）。

1. **先寫紅測試** `src/pine/__tests__/array_from_snapshot.test.ts`：`array.from(<series>)` 後於後續 bar 改變來源，斷言已存元素**不變**。**先跑確認 FAIL（紅）並貼原始輸出。**
   → 驗證：`npx vitest run src/pine/__tests__/array_from_snapshot.test.ts` = FAIL
2. 改 `array.ts:80`：`arrVal(args.slice())` → 逐元素過既有 `snap()`。
   → 驗證：紅測試轉綠
3. 任何**既有**測試轉紅 ⇒ **停手回報**（代表有程式依賴 live 語意），不自行改既有斷言。
   → 驗證：`npx vitest run src/pine` 全綠、passed ≥ 970

## 2. 回歸閘門（P7，逐條貼原始輸出）

| 閘門 | 指令 | 通過條件 |
|---|---|---|
| G1 全測試 | `npx vitest run src/pine` | 全綠；passed ≥ 970 |
| G2 型別 | `npx tsc --noEmit` | rc=0 |
| G3 四支 digest | `npx tsx scripts/perf/pine-bench.mjs --script scratch/perf/app-scripts/script-a1dcdea6-95114.pine --script src/pine/TRIS390.pine --script "C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine" --script final.pine --bars 100 --repeat 2 --warmup 2` | `ze7byn`／`kb0glc`／`1580h2`／`p4gddl` 逐字不變（經 §11.5 re-baseline：`ze7byn`→`1e63vl8`） |
| G4 增量 parity | `npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 5` | 收尾 `PARITY OK` |
| G5 新測試 | B3 的紅→綠 | 紅測試先 FAIL 後 PASS，且具判別力 |

## 3. Rollback

- 動工前備份 `src/pine/builtins/array.ts` 到 `%TEMP%/tb-backup-20261016/` ＋ md5（**本輪唯一改動的程式檔**）。
- 閘門不過 → 用備份還原（**禁止** `git checkout/restore/stash`）。
- B1/B2 無碼改動 ⇒ 只還原文件段落。

## 4. 預檢

- 無憑證、無付費、無外部服務；不動任何全域設定。
- shell 一律 `cd /c/Users/bear9/OpenCharts && <inline>`（禁 `cwd:`、禁 `bash <file>`）。
- **G3 副作用**：`pine-bench.mjs:499` 會寫 `bench/pine/<label>.json`（預設無 `--out`）——屬既有行為，動工前先跑一次取得「修前」baseline 作對照。

## 5. 風險與邊界

| 風險 | 影響 | 緩解 |
|---|---|---|
| ~~B1 誤改導致域錯配~~ | 已排除（v2 不改碼） | F1/F3 |
| B3 改變 `array.from` 的 live 別名語意 | 依賴「改來源同步改陣列」的腳本會被改變（**這正是 TV 對齊要修的**） | G3 不受影響（F10）；既有測試轉紅 ⇒ 停手回報 |
| 文件更正誤刪事實 | 稽核軌跡受損 | 一律用刪節線，原文保留 |

## 6. 所有權／並行（P6）

| slice | 檔案 | owner |
|---|---|---|
| S-B3 | `src/pine/builtins/array.ts` ＋ 新測試檔 | 代理 1 |
| S-DOC | `audit-cow-alias.md`／`pine-core-debt-consolidated.md`／`r5-remaining-fixes.md`（＋B1/B2 驗證記錄） | 代理 2 |

兩 slice 無檔重疊 ⇒ 可併發。

## 7. 驗收標準（P0 修訂）

1. B3 repro 測試紅→綠（`code`）
2. `npx vitest run src/pine` 全綠、passed ≥ 970、不放寬既有斷言（`code`）
3. `tsc --noEmit` rc=0（`code`）
4. 四支 digest 逐字不變（`code`）（經 §11.5 re-baseline：`ze7byn`→`1e63vl8`；2026-10-16 第二輪 P8 複跑仍為 `1e63vl8/kb0glc/1580h2/p4gddl`，見 §11.8）
5. B1／B2 產出**可查的驗證記錄**（shift 檢查輸出、grep 0 命中、兩側測試名）（`code`）
6. B2 的判別性測試真能判別 skip 分支（`jev`）
7. **本輪**對 `src/**` 的淨改動僅兩處：`builtins/array.ts`（1 運算式，B3；已用備份 md5 對照確認別無他改）＋ `builtins/map.ts`（2 行註解，零行為差；P8 I-e 回修）。⚠️ 注意 `git diff --stat -- src/` 顯示 22 檔：其中 `interpreter.ts`（21:53）與 `strategy.ts`（22:17）是**並行 R4 工作流**在本輪窗口內的寫入，非本輪產出；樹中無凍結基準可證其餘，故本條以「本輪改動檔案清單」而非 diff 總數判定（`code`）

## 8. 執行狀態（2026-10-16）

- 🔒 使用者已核准（「照 v2 全做 ＋ 含兩處文件更正」）→ P6 已執行。
- **P6 結果**：`array.ts` 1 運算式（`args.map((v) => snap(v))`，`:81`）＋ 新測試 `array_from_snapshot.test.ts`（修前 `expected 103 to be 102` 紅 → 修後綠）；`map.ts:76-78` 僅 2 行註解；4 處文件更正。
- **P7 閘門（實跑）**：`npx vitest run src/pine` = **66 files / 972 passed | 1 skipped**（見 §11.6：本輪後 67 files / 974 passed；2026-10-16 第二輪 P8 再加 1 `it` 後為 67 files / 975 passed，見 §11.8）；`tsc --noEmit` rc=0；四支 digest `ze7byn/kb0glc/1580h2/p4gddl` **逐字不變**（見 §11.5 re-baseline）；`s1-inc-probe` **PARITY OK**。
- **P8 第一輪**（三視角）：4 條 Important（I-b/I-c/I-d/I-e）→ 已回修。
- **P8 第二輪**（三視角）：新 Critical = 0；新 Important = 1（本節即其回修）；4 條已完成獨立複驗。
- **B1／B2**：純驗證完成（B1＝shift 檢查 `s1[i]==s[i-1]` 全通過；B2＝`engine.ts` grep 0 命中、兩側測試齊）。

## 9. 待裁決與殘留（不阻擋本計畫交付）

### 9.1 待使用者裁決（JEV `taskwf-review` 分級：Critical 1.0／Important 0.85；`gate=report_and_wait`）

| 項 | 內容 | 證據 | 為何停手 |
|---|---|---|---|
| **C1（Critical）** | `array.ts` 的 `array.includes`／`indexof`／`lastindexof`／`binary_search*` 掛 HistSpec（`{idx:[1], names:['value']}`）⇒ `bound.get('value')` 拿到 series 包裝，與元素比較恆 false | 實測 `array.includes(a, 2)` → false（陣列確實含 2）；`array.binary_search(a, 2)` → 假插入點；`scratch/perf/app-scripts/script-a1dcdea6-95114.pine` 有 5 處呼叫（`:1404` 為整塊 gate） | **修它必然改動 `ze7byn` digest**（該 digest 是驗收閘門）⇒ 需你決定是否 re-baseline（**已於 §11 解除，已修**） |
| **I-a（Important）** | `array.new(size, initial_value)` 未過 `snap`（`array.ts:71-72`）⇒ 傳 series 時存 live handle，與檔頭「Arrays hold SNAPSHOT values」矛盾 | 實測 `array.new(1, close)` 跨 bar 跟著動；`array.new(1,5)`＋`array.set` 則穩定（A/B 對照） | 超出已核准範圍（v2 僅 `array.from`）（**已於 §11 解除，已修**） |

### 9.2 已記錄不修（Minor）（清單狀態 2026-10-17：下列 #1／#2／#3／#4／#6 均為已解決，原文保留；#5 仍成立）

1. `audit-cow-alias.md:38` 內文與 `pine-core-debt-consolidated.md:31` 仍引舊行號 `mtf.ts:1105-1111`（實為 `1261-1269`／`：1264`；`:1105-1111` 現為 `alignToChart` 的 `SecSeries` 包裝）。**（2026-10-17 已修：兩處均已就地加註更正行號，原文保留。）**
2. 新測試缺「同檔獨立證明修前為 live」的對照斷言（不影響判別力：紅跑已證修前為 live）。**（2026-10-17 已修：`array_from_snapshot.test.ts` 已補同檔 live 對照斷言——來源 `close` 在後續 bar 確實遞增，而 `array.from(close)` 存下的元素恆為第 2 根之值。）**
3. `PROGRESS.md:712` 自身仍寫舊測試名（本計畫只在引用端加註「舊稱」）。**（2026-10-16 更正：本項已失效——`PROGRESS.md:712` 已由同日衛生批次更正，現同時列舊稱與新名：`heavy run → forming-bar ticks keep running (no skip)`（舊稱，2026-10-16 更正：`heavy run + live session → forming-bar ticks keep running (skip exempted)`）。**（2026-10-17 補：同一行的行號範圍亦已更正 `:309-360` → `:309-366`。）**
4. repo 根有兩個前輪畸形 shell 產生的未追蹤目錄（`%TEMP%/t7-optimized-1800 && cp -r …`、`CUsersbear9AppDataLocalTempr5-snapshot-1209`）待清理。**（2026-10-16 更正：本項已失效——兩者已隔離搬移出 repo 根至 `%TEMP%/tb-junk-quarantine-20261016/`（其內為 `%TEMP%/`（承載 `t7-optimized-1800 && cp -r …`）與 `CUsersbear9AppDataLocalTempr5-snapshot-1209/`）；`docs/2026-10-15-r5-remaining-autorun.md:21`／`:39` 的 botched 指令亦已更正為 bash 可執行形式。）**
5. 全部檔案**未 commit**（依 repo 慣例待人工覆核）。
6. T2／T5 的 `done` 語意（`docs/2026-10-15-r5-autorun-status.json`）：**已核實：語意無誤**（T2 收 `probe` = `scratch/perf/t2-strategy-scale.mjs`，且其 acceptance 本即允許「或只交歸因與最小修法提案」；T5 `reason`+`evidence` 已註明「實義為作廢」）。**（2026-10-16 更正：「無需改動」的語氣不準——該檔事後確被改過：`git status` 顯示該檔為**未追蹤**（`??`），故無 git diff 可還原變更史，但其頂層已含帶時間戳的加註 key `_read_me_before_you_start_20261015T2023`／`ownership_20261015T2033`／`tier_a_correction_20261016`，且 T2 多 `probe`、T5 多 `reason` 欄位；即該檔並非凍結。本計畫不主張該檔凍結，「語意無誤」才是本項結論。）**

### 9.3 同族未清站點（P9 advisor 發現，2026-10-16，**記錄待裁決**）

根因**不同源**於 C1：`evalArg` 的 **literal/ident 包裝路徑**會無條件把值包成 `{kind:'series'}`（`interpreter.ts:1636-1650`），與 HistSpec 無關（`registry.ts:17-30` 的 `HIST_NS` 只有 `ta`）。故凡「以元素/值語意讀 arg」的站點都可能踩到，本輪只清了 `includes/indexof/lastindexof/binary_search*`、`percentrank`、`array.new`。

| 行 | 函式 | 實測後果（引擎路徑） |
|---|---|---|
| `:387-393`／`:397-403`／`:455-461`／`:474-481` | `variance`／`stdev`／`standardize`／`covariance` | 包裝 na 使 `biasedV.kind === 'na'` 不成立 ⇒ 把**文件化預設 `biased=true` 翻成 false**：`array.variance(b, bna)`＝1.667 vs `array.variance(b)`＝1.25（`stdev` 1.291 vs 1.118） |
| `:133-140` | `fill`（`length`） | 包裝 na 使 `lenV.kind === 'na'` 不成立 ⇒ 填 0 格（字面 na 會填到尾） |
| `:527-535`／`:541-549` | `percentile_linear_interpolation`／`percentile_nearest_rank` | `p.kind === 'na'` 只接住**未包裝**的 na；**觸發條件比 §11.8 記的更普通**——`float bna = na` 這種 ident 就觸發 ⇒ rank 退化成 `xs[0]` |

**另記（Minor）**：`src/pine/__tests__/array_arg_snapshot.test.ts` 內註解 `// C1 bug ⇒ -4` 實測為 **-2**（3 元素插入點 1），純註解錯誤、需更正。

**判定**：全部為**既有缺陷**（非本輪引入），觸發條件窄（皆需傳入 na 的 ident），且**未經使用者核准擴大範圍** ⇒ 依 task-workflow「剩餘發現交使用者裁決」記錄於此，不在本輪修。

## 10. P9 對抗性複核（獨立 advisor，2026-10-16 22:20–22:28）

**advisor 自行重跑的閘門（與本計畫 §8 同值，見 §11.6：本輪後 67 files / 974 passed；§8 的 66 files / 972 passed 為 re-baseline 前）**：`npx tsc --noEmit` rc=0；`npx vitest run src/pine` = 66 files / 972 passed | 1 skipped；pine-bench 四支 digest `ze7byn/kb0glc/1580h2/p4gddl`（見 §11.5：僅 `ze7byn`→`1e63vl8`，其餘三支逐字不變）且 app vs direct 全 PASS；`s1-inc-probe` 5/5 match ＋ `PARITY OK`；`scratch/perf/tb-b1-shift-check.mjs` PASS；C1 復現（`array.includes(a,2)`→0、`indexof`→-1、`binary_search`→-1）、I-a 復現（`array.new(1, close)`→ live）。

**四項必須知道的限制**

1. **樹未凍結**：並行 R4 工作流在本輪窗口內寫了 `interpreter.ts`（21:53）與 `strategy.ts`（22:17）。任何人在其後再寫一次，就會作廢 §8 與 §10 的閘門證據 → 重跑時**必須在最後一次寫入之後**。
2. **`bench/pine/pine-bench-20261016-191836.json` 是離群值**：該次 MACD701 digest = `n13oly`（`mtf.ts` 20:10 改動中的 WIP 態），非本輪結果；判讀 digest 閘門時請用 `16:45`／`17:09`（本輪前）與 `21:39`／`22:20`（本輪後）。
3. **JEV 分級無 repo 內記錄**：C1／I-a 的 `taskwf-review` 分級（critical 1.0／important 0.85；`gate=report_and_wait` 1.0）產出於受管管道，payload 在 `%TEMP%/tb-jev-review.json`；本計畫僅記結論。advisor 已自行復現兩者的**實質**，故 §9.1 的停手結論不受影響。
4. **驗收 #2 的 +2 不可全歸因本輪**：新增測試只貢獻 1 個 passed；另 1 個來自並行工作流的 `src/pine/__tests__/inc-parity.test.ts`（7 → 13 個 `it`）。

## 11. C1／I-a 修正與 re-baseline（2026-10-16 22:39–23:1x，owner：FixC1IA）

使用者於 22:5x 裁決**放行 golden re-baseline**（§9.1 的停手項解除）：`scripts/golden/見高K4.55.golden.json` 存的是修正**前**＝含 bug 的自我快照（不是 TV oracle），修正語意本來就要同步更新它。以下為落地記錄。

### 11.1 修法（`src/pine/builtins/array.ts`，只在**讀取點**包 `snap()`；**未刪 HistSpec**）

| 修後行 | 函式 | 舊文 → 新文 |
|---|---|---|
| `:71-74` | `newArray`（`array.new` 與 11 個 `new_*` 共用） | `const init = bound.get('initial_value');` / `return arrVal(new Array<Value>(size).fill(init === undefined ? NA : init));` → `const init = snap(bound.get('initial_value'));` / `return arrVal(new Array<Value>(size).fill(init));`（`snap` 對 `undefined` 已回 `NA`，三元式省去後等價） |
| `:230-234` | `array.includes` | `const v = bound.get('value');` / `if (a === null \|\| v === undefined) return NA;` → `const raw = bound.get('value');` / `if (a === null \|\| raw === undefined) return NA;` / `const v = snap(raw);` |
| `:242-246` | `indexOfFn`（`array.indexof`／`lastindexof`） | 同上（`v` → `raw` ＋ `const v = snap(raw);`） |
| `:299-304` | `binSearch`（`binary_search`／`_leftmost`／`_rightmost`） | 同上 |

根因：這三個 builtin 註冊 `HistSpec { idx: [1], names: ['value'] }` ⇒ `evalArg` 把 value 引數**無條件包成 `{kind:'series'}`** ⇒ `valueEq`／`cmp` 拿包裝體與元素比較 ⇒ 恆 false。故修法只能在讀取點過既有的 `snap`（`array.ts:18`）取當下值，**不可刪 HistSpec**。

C1 修前／修後對照（引擎路徑實測）：`array.includes(a, 2)` `false`→`true`；`array.indexof(a, 2)` `-1`→`1`；`array.lastindexof(a, 2)` `-1`→`1`；`array.binary_search(a, 2)` 假插入點→`1`。
I-a 修前／修後：`array.new(1, close)`（bar 2 建立）在 bar 3／4 讀回 `103`／`104`（live handle）→ `102`／`102`（快照），與檔頭 `:13-19`「Arrays hold SNAPSHOT values」契約一致。

### 11.2 紅測試（新檔 `src/pine/__tests__/array_arg_snapshot.test.ts`，2 `it`，走 `runScript(parse(src), bars, …)` 引擎路徑）

修前（紅，原始輸出）：
```
 × array value-arg snapshot (C1) ... → expected +0 to be 1
 × array.new(size, initial_value) snapshot semantics (I-a) ... → expected 103 to be 102
 Test Files  1 failed (1)   Tests  2 failed (2)
```
修後（綠）：`Tests  2 passed (2)`。反向案例（`includes(a,9)`→`0`、`indexof(a,9)`→`-1`）修前後皆同，未放寬。

### 11.3 golden re-baseline 明細（**只動 `scripts/golden/見高K4.55.golden.json`**）

機制用 repo 既有的 `UPDATE_GOLDEN=1`（`golden.ts:10` / `:268`）：`UPDATE_GOLDEN=1 npx vitest run src/pine/__tests__/golden.test.ts -t "見高K4.55"` ⇒ 該案 PASS，且寫出的 golden 與測試自產的 `見高K4.55.actual.json` **逐位元組相同**（md5 `5ffb66058d409597825c5c19869783d6`）。

前後差異集合＝**恰 16 條**（0 結構差異；10 條 `props.textcolor`＋6 條 `props.tooltip`）：

| path | 舊值 | 新值 |
|---|---|---|
| `.drawings[38].props.textcolor` | `#FFFFFF` | `#000000` |
| `.drawings[47].props.tooltip` | `倒N 目標\nN: 79.0\nV: 77.2\nE: 75.0` | `倒N 目標\nN: 79.0 ✓\nV: 77.2\nE: 75.0` |
| `.drawings[63].props.textcolor` | `#FFFFFF` | `#000000` |
| `.drawings[66].props.tooltip` | `倒N 目標\nV: 79.0\nN: 4.2\nE: 1.0` | `倒N 目標\nV: 79.0 ✓\nN: 4.2\nE: 1.0` |
| `.drawings[75].props.textcolor` | `#FFFFFF` | `#000000` |
| `.drawings[75].props.tooltip` | `正N 目標\nE: 87.3\nV: 87.0\nN: 83.4` | `正N 目標\nE: 87.3 ✓\nV: 87.0 ✓\nN: 83.4 ✓` |
| `.drawings[76].props.textcolor` | `#FFFFFF` | `#000000` |
| `.drawings[79].props.textcolor` | `#FFFFFF` | `#000000` |
| `.drawings[79].props.tooltip` | `正N 目標\nE: 90.4\nV: 88.5\nN: 86.7` | `正N 目標\nE: 90.4 ✓\nV: 88.5 ✓\nN: 86.7 ✓` |
| `.drawings[80].props.textcolor` | `#FFFFFF` | `#000000` |
| `.drawings[103].props.tooltip` | `正N 目標\nE: 232.6\nN: 229.6\nV: 159.9` | `正N 目標\nE: 232.6\nN: 229.6\nV: 159.9 ✓` |
| `.drawings[104].props.textcolor` | `#FFFFFF` | `#000000` |
| `.drawings[110].props.textcolor` | `#FFFFFF` | `#000000` |
| `.drawings[115].props.textcolor` | `#FFFFFF` | `#000000` |
| `.drawings[115].props.tooltip` | `倒N 目標\nN: 157.8\nV: 154.5\nE: 153.8` | `倒N 目標\nN: 157.8 ✓\nV: 154.5 ✓\nE: 153.8 ✓` |
| `.drawings[116].props.textcolor` | `#FFFFFF` | `#000000` |

全數可歸因：`見高K4.55.TXT` 的 4 個達標追蹤 gate 都寫成 `array.includes(<done 陣列>, false)`——`:1404`（bull）／`:1424`（bear）／`:1444`（kHigh）／`:1450`（kLow）。修前恆 false ⇒ 區塊從未進入 ⇒ 無 `✓`、label 停在白字；修後進入 ⇒ `:1419`／`:1439` 的 `label.set_tooltip(get_sorted_text(...))` 追加 `✓`（6 條），`:1421`／`:1441`／`:1447`／`:1453` 的 `label.set_textcolor(..., color.black)` 生效（10 條）。集合與機制**恰好一一對應，無多餘副作用**。

範圍佐證：其餘 9 支 golden 的 md5 前後**完全相同**（`turtle / TD_BB / MACD701 / MACD雙周期V7 / final / 高量1.46 / TRIS390 / MACD701_v72 / norm2`），`git status --porcelain scripts/golden/` 只列 `見高K4.55.golden.json`。

**追記（2026-10-16 第二輪 P8 複核，I-B）：與 HEAD 的 golden diff 是 27 條；本節的「16 條」是「本輪前檔案 → 本輪後檔案」的差異，不是與 HEAD 的差異。**

- 現況實測：`git diff --numstat -- scripts/golden/見高K4.55.golden.json` = **27/27**。逐路徑拆解（以 `node` 走訪 HEAD blob vs 工作區檔案）= 上面表格那 **16 條**（10 `textcolor` ＋ 6 `tooltip`）＋ **11 條本輪前的未提交漂移**：

| path | 舊 | 新 |
|---|---|---|
| `.drawings[0].props.x1` | `0` | `null` |
| `.drawings[2].props.x1` | `0` | `null` |
| `.drawings[2].props.x2` | `0` | `null` |
| `.drawings[2].props.y1` | `0` | `null` |
| `.drawings[2].props.y2` | `0` | `null` |
| `.drawings[5].props.x` | `0` | `null` |
| `.drawings[5].props.y` | `0` | `null` |
| `.drawings[9].props.y` | `0` | `null` |
| `.drawings[10].props.y2` | `0` | `null` |
| `.drawings[32].props.x1` | `0` | `null` |
| `.drawings[33].props.x` | `0` | `null` |

- 來源：`src/pine/builtins/draw.ts` 的未提交 na-coord 修正（檔案 mtime `2026-10-15 13:49:05`）——`type PropType = 'num' | 'coord' | 'str' | 'bool'`；`coerceIn` 對 `coord` 回 `asNumOrNa(v)`（`num` 仍視 na 為 0）；`PROP_TABLES` 的 `line`／`label`／`box` 座標由 `'num'→'coord'`；`line.new` 改 `naCoordArg(bound, 'x1'…)`；`line.set_x1`／`set_x2` 改 `asNumOrNa`。na 座標不再被硬轉成 `0`（`0` 會被 autoscale 當錨點、把整張圖壓扁），改留 `undefined` ⇒ 引擎丟掉該物件 ⇒ golden 由 `0` 變 `null`。
- **「非本輪」判定（三項獨立證據）**：
  1. **反事實實測**：把 `array.ts` 還原成 C1 修正**前**（`%TEMP%/tb-backup-20261016/array.ts.pre-c1`，md5 `18075e64a613e0b41f48b6d980d7dedd`）後跑 `UPDATE_GOLDEN=1 npx vitest run src/pine/__tests__/golden.test.ts -t "見高K4.55"` 重生 golden ⇒ 與 HEAD blob 的 diff = **恰 11 條**，**全部是上表座標，一條 tooltip／textcolor 都沒有**；同一份重生檔再與本輪 golden（md5 `5ffb66058d409597825c5c19869783d6`）比對 = **16 條、座標 0 條**。⇒ 兩組差異彼此正交，座標那 11 條與 array 修正無關。
  2. **時序**：本輪前的 golden（md5 `a5f7c27e5c4982932d1ba13d3a94ebf9`，即 §11.7 記的「舊版」）在 `%TEMP%/r5-snapshot-B-20261015-1800/`、`%TEMP%/r5-snapshot-C-20261015-2030/`、`%TEMP%/t7-optimized-1800/` 三處備份中**逐位元相同**，且其與 HEAD blob 的逐路徑 diff 就是上表那 11 條 ⇒ 該漂移 **2026-10-15** 就已在檔案裡，早於本輪（10-16 22:39 起）。
  3. 本輪 `UPDATE_GOLDEN` 的差異集合本節已記為「恰 16 條」，其中**不含任何座標條目** ⇒ 當時檔案內座標已是 `null`。
- 因此歸屬：16 條＝本輪 C1（§11.5 digest／golden 的既有記載）；11 條＝`draw.ts` 的 na-coord 修正（本輪前的未提交變更），**不在本計畫驗收範圍**。本追記只負責把來源與歸屬寫清楚，不還原 `draw.ts`、不改座標語意。

### 11.4 為何這叫「修正錯誤行為」而不是回歸

1. golden 的 `want` 值來自**我們自己引擎**（`golden.test.ts` 首行註解：First commit generated via `UPDATE_GOLDEN=1`），不是 TradingView 匯出 ⇒ 它是自我快照，修正前樹全綠正是「bug 被寫進快照」的證明。
2. 反向證據：`array.includes(<array<bool> 內含 false>, false)` 在 TV 語意下**必為 true**；`array.new(1, close)` 在 TV 語意下**必為快照**。舊輸出兩者皆反。
3. 修正後行為與同檔其他已修路徑（`array.from`＝B3、`push`／`set`／`insert`／`fill` 早已 `snap`）一致，也與檔頭 `:13-19` 的 SNAPSHOT 契約一致。

### 11.5 digest 舊 → 新（逐字）

| script | 舊（本輪前） | 新（本輪後） |
|---|---|---|
| `script-a1dcdea6-95114.pine` | `ze7byn`（72524 B；`lines` 65） | **`1e63vl8`（71288 B；`lines` 59）** |
| `TRIS390.pine` | `kb0glc`（177121 B） | `kb0glc`（177121 B）**逐字不變** |
| `MACD701_v72.pine` | `1580h2`（43752 B） | `1580h2`（43752 B）**逐字不變** |
| `final.pine` | `p4gddl`（11685 B） | `p4gddl`（11685 B）**逐字不變** |

`script-a1dcdea6-95114.pine` 有 5 處 `array.includes`（`:1404` 為整塊 gate）；修正後 `lines` 65→59，故 digest 必變。與 advisor 事前估值 `1e63vl8` 相符。

### 11.6 閘門實跑值（2026-10-16 22:39–23:16）

- **G1** 新測試 `array_arg_snapshot.test.ts`：修前紅（2 failed）→ 修後綠（2 passed）。
- **G2** `npx tsc --noEmit` → `TSC_RC=0`。
- **G3** `pine-bench --bars 100 --repeat 2 --warmup 2`（fixture `bars-5m-mxf-500.json`，total 26.9 s）→ digest 見 §11.5，`app vs direct` **model identity 四支全 PASS**（`1e63vl8/kb0glc/1580h2/p4gddl`）。附註：同次輸出的 H3 時間比 `<20%` 欄為 `22.6% / 36.9% / -15.9% / 45.8%`（3 支 FAIL）——此欄在本輪**前**的 21:39 場次同樣 FAIL（`25.96% / 22.96%`，見 `bench/pine/pine-bench-20261016-213951.json`），且 `final.pine` 標 `NOISY`，屬並行負載下的計時抖動，非身分／digest 差異。
- **G4** `s1-inc-probe --script src/pine/TRIS390.pine --bars 500 --ticks 5` → build ＋ tick1–5 全 **match**，收尾 **`PARITY OK`**（`PROBE_RC=0`）。
- **全套** `npx vitest run src/pine` → **67 files / 974 passed | 1 skipped**（基線 66 files/972 passed ＋ 本輪新測試 2 passed）。中間場次（golden 未更新時）為 67 files / 973 passed | 1 failed，**唯一紅的就是本節要 re-baseline 的 `見高K4.55`**。

### 11.7 Rollback

- 本輪開工前基線：`%TEMP%/tb-backup-20261016/array.ts.pre-c1`，md5 `18075e64a613e0b41f48b6d980d7dedd`（＝ `src/pine/builtins/array.ts` 修正前內容；`cp` 回覆即可全回退）。
- 修正版：`%TEMP%/tb-backup-20261016/array.ts.c1fix`，md5 `5e6999a9bb09c179fdaba1672a0af721`。
- 測試：`%TEMP%/tb-backup-20261016/array_arg_snapshot.test.ts`。
- golden 舊版：md5 `a5f7c27e5c4982932d1ba13d3a94ebf9` → 新版 `5ffb66058d409597825c5c19869783d6`。
- 未 commit（依 repo 慣例待人工覆核）。

### 11.8 第二輪 P8（I-A 同類站點）：`array.percentrank`（2026-10-16 23:33–23:45，owner：C1P8Fix）

- **症狀**：`array.percentrank` 在**引擎路徑**恆回 `na`——`array.from(1, 2, 3, 4)` 上 `array.percentrank(a, 4)` 應 `100`、`array.percentrank(a, 2)` 應 `50`，修前皆 `na`。
- **根因**：`array.ts:443` 讀 `const v = bound.get('value')`，下一行判 `v.kind !== 'int' && v.kind !== 'float'` ⇒ 回 `NA`。`evalArg` 的 **literal 快路徑無條件**把 num/bool 字面引數包成 `{kind:'series'}`（`interpreter.ts:1633-1645` 的 `LitSeries`；series ident 亦包），與是否掛 HistSpec 無關 ⇒ 該 kind 檢查永不通過。C1 那 4 個站點是**另一條**包裝來源（HistSpec ⇒ `noHist=false`），本站在**未掛 HistSpec** 下同樣中招。
- **HistSpec 說明（與 §11.1 的「未刪 HistSpec」對照）**：本站**本來就沒有** HistSpec——實測 `HIST_BUILTINS.get(BUILTINS.get('array.percentrank'))` = `undefined`、`histSpecHas(…, 1, 'value')` = `false`（`registry.ts:17-30`）。故無「保留 HistSpec」可言，也**未新增**：`value` 是純量探針、不是入庫元素（依 `registry.ts:26-29` 的註解，index/size/探針類引數不需要 history）。
- **修法**（比照 §11.1 的四個站點：`raw` ＋ `snap(raw)`）：

| 舊文 | 新文 |
|---|---|
| `const v = bound.get('value');` | `const raw = bound.get('value');` |
| `if (a === null \|\| v === undefined \|\| v.kind === 'na') return NA;` | `if (a === null \|\| raw === undefined) return NA;`（＋新增註解） |
| （無） | `const v = snap(raw);` |

`raw` 為 `na` 時 `snap` 回 `NA`，由下一行既有的 kind 檢查接住 ⇒ 與原三元式等價；`snap`（`array.ts:18`）＝「取當下值」的既有契約，與 `array.from`（B3）／`push`／`set`／`insert`／`fill` 同構。

- **紅測試**（`src/pine/__tests__/array_arg_snapshot.test.ts` 追加 1 個 `it`，新 `describe`，仍走 `runScript(parse(src), bars, …)` 引擎路徑）：
  - 修前（紅，原始輸出）：
    ```
     × array.percentrank value-arg snapshot (I-a) — lookups must see the current-bar scalar > percentrank(a, v) on array.from(1,2,3,4) must rank against the current-bar scalar
       → expected { kind: 'na' } to be 100 // Object.is equality
     Test Files  1 failed (1)   Tests  1 failed | 2 passed (3)
    ```
  - 修後：`Test Files 1 passed (1)   Tests  3 passed (3)`。
- **Minor（只記錄不修）**：`array.percentile_linear_interpolation`／`array.percentile_nearest_rank` 的 `percentage` 引數同樣會被 `evalArg` 包成 series；其 `if (a === null || !p || p.kind === 'na') return NA;` 只接住**未包裝**的 `na`，被包成 series 的 `na` 會走進 `asNum(p)`（→ 0）⇒ rank 退化成 `xs[0]` 而非 NA。影響面：僅「percentage 傳 na」這種畸形呼叫；本輪不動（改它要重排 kind 判斷，且無 golden 覆蓋）。
- **閘門實跑（2026-10-16 23:35–23:45，皆在本輪最後一次內容寫入之後；`array.ts` md5 `5aa248bfd0aeb7874d69a65d9efff0e8`、golden md5 `5ffb66058d409597825c5c19869783d6`）**：
  - **G1** `npx vitest run src/pine` → **67 files / 975 passed | 1 skipped**（基線 §11.6 的 974 ＋ 本輪 1 `it`；golden 案含在內且綠）。
  - **G2** `npx tsc --noEmit` → `TSC_RC=0`。
  - **G3** `npx tsx scripts/perf/pine-bench.mjs … --bars 100 --repeat 2 --warmup 2` → digest **`1e63vl8`／`kb0glc`／`1580h2`／`p4gddl`**，與 §11.5 **逐字相同**；`app vs direct` model identity 四支全 **PASS**。（H3 時間欄 3 支 FAIL、`final.pine` `NOISY`，與 §11.6 同因：並行負載下的計時抖動，非身分差異。）
  - **G4** `npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 5` → build ＋ tick1–5 全 `match`，收尾 **`PARITY OK`**（`PROBE_RC=0`）。
- **Rollback**：本輪前 `array.ts` md5 `5e6999a9bb09c179fdaba1672a0af721`（＝ §11.7 的 `array.ts.c1fix`，也是 `%TEMP%/tb-backup-20261016/` 內同名備份）；本輪後 `5aa248bfd0aeb7874d69a65d9efff0e8`（備份 `%TEMP%/tb-backup-20261016/array.ts.p8fix`）。回退＝把 `array.ts.c1fix` `cp` 回 `src/pine/builtins/array.ts`。
- **本輪的文件更正（I-B／I-C／I-D）**：
  - **I-B** → 本節 §11.3 的追記（27 ＝ 16 ＋ 11，附反事實實測與時序證據）。
  - **I-C** → §2 G3 列、§7 驗收 #4、§8 P7 閘門、§10 advisor 閘門各加 re-baseline 註記；§9.1 的 C1／I-a 兩列各加「已於 §11 解除，已修」；§9.2 第 3／4 條更正為已失效、第 6 條更正為「語意無誤（該檔非凍結）」。
  - **I-D** → `docs/2026-10-15-r5-remaining-autorun.md:21`／`:39` 的 `%TEMP%` 快照指令改為 bash 可執行形式（`TMP=$(cygpath -u "${TMPDIR:-$TEMP}")` ＋ `"$TMP"…`）並各加一則 2026-10-16 註記；同輪在 `docs/2026-10-14-pine-perf-align.md` 檔尾與 `docs/2026-10-15-r5-fix-plan.md` 首段各加一則 digest re-baseline 註記（`ze7byn`→`1e63vl8`，其餘三支不變）。
