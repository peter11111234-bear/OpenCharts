# Pine 直譯器載入效能優化 + TradingView 對齊

流程：task-workflow P0–P9。JEV 一律走受管管道 `python C:/Users/bear9/jev-laya-bench/jev_judge.py`
（gate：`taskwf-verify` / `taskwf-blocker` / `taskwf-accept` / `taskwf-review`）。

## P0 需求定義

**需求描述**

指標（Pine 腳本）載入慢。成本主要在 Pine 直譯器（parse → 執行 → 模型建構），不是渲染層。
目標：縮短載入時間，並以 TradingView 實測數字為對齊基準；語意與輸出不得改變。

**非目標**

- 不改 Pine 語意／輸出（golden 必須 0 差異）。
- 不動渲染/繪圖層（`@luxalgo/vela`、`NativeRenderer`、`autoscale`）。
- 不重寫直譯器架構、不新增第三方依賴。
- 不改公開 API 契約；若必須改，需量測依據 + P8 review 通過。
- 不優化行情抓取/後端，除非量測顯示它是載入主要成本。
- 不做 TV 程式碼複製；只取「等價行為與複雜度」的結論。

**驗收標準**（code = 可程式判定；jev = 語意判定，走受管管道）

| # | 判定 | 驗收條件 | 狀態 |
|---|---|---|---|
| A1 | code | `npx vitest run src/pine` 全綠（基線 62 檔 / 954 passed，不得退） | 待測 |
| A2 | code | golden 比對 0 差異（15 檔） | 待測 |
| A3 | code | **已定案（2026-10-15 使用者裁定，分級）**：K55 total 降幅 ≥50%、TRIS390 ≥40%、MACD701_v72 ≥30%，**外加**硬條件「四支腳本 model 內容 digest 與 baseline 逐字相同 ＋ golden 0 差異 ＋ A4 成長倍率 ≤2.2」。現值：−61~64%／−49~53%／−45%（全過） | ✅ 定案 |
| A4 | code | 成長倍率 total(1000 bars)/total(500 bars) ≤ 2.2（排除超線性） | 待測 |
| A5 | code | app 實機載入（K55 還原路徑）優化後 < 優化前 | 待測 |
| A6 | code | **已改寫（2026-10-15 使用者裁定）＝「增量 tick 預算」**：策略／MTF 腳本每個 live tick（增量）**≤100 ms**，且**增量 ≤ 冷載入 total ÷ 10**。實測：K55 55 ms/tick（26.8×）✅、TRIS390 107 ms/tick（10.9×）⚠️ 邊緣（需安靜機複測確認） | ✅ 定案（數值待安靜機複核） |
| A7 | jev | 未造第二套 convention：新快取/新儲存策略沿用既有 `modelCache` / `mtf` / `series` 模式 | 待驗 |
| A8 | jev | 無行為漂移：抽樣比對優化前後輸出 | 待驗 |

**外部依賴（唯一需要使用者配合）**

TV 端 CDP 連線（REA 用）：Chrome 155 需以獨立 profile 開
`--remote-debugging-port=9222 --user-data-dir="C:\Users\bear9\tv-cdp"`，登入後保持圖表分頁開啟。

## P1 拆解

| node | 內容 | 標記 | 依賴 |
|---|---|---|---|
| N1 | 量測 harness（phase 級 baseline） | known | — |
| N2 | 熱點定位（圖譜 + profile） | unknown | — |
| N3 | TV 端擷取與實測（REA） | unknown（需使用者開 CDP） | 使用者 |
| N4 | 優化實作 | unknown（等 N2/N3） | N1, N2, N3 |
| N5 | 回歸驗證（A1–A3） | known | N4 |
| N6 | P8 review（task-workflow 3 視角 + code-review 4 軸） | known | N5 |

## P2 Round-1 三軸探索結果

### 軸一・手段可行性（進行中）（2026-10-16 註：該軸已結案，見下 T12 判定表）

phase 級 baseline harness：4 支腳本（high452_phase3／MACD701_v72／TRIS390／final）× 500、1000 根真實 5m MXF，
輸出 `scratch/perf/phase-baseline.{json,md}`。

### 軸二・熱點盤點（完成）

呼叫鏈、H1–H10 候選熱點、誘餌排除明細 → `docs/2026-10-13-remaining-work.md` §G.1／§G.2。

摘要：主嫌 **H1 每 bar 全量重算**（`incRun` 增量不適用含 `request.security`／strategy 的腳本＝最重那幾支）、
**H2 `mtf.evalAt` miss**（UDF 每次呼叫配新 Scope）、**H3 `evalArg` 每 bar 包 series ＋ callHist 寫入**；
`contracts.ts:59` 的 `Series.unshift` 是**誘餌**（主路徑走 `BarSeries` ring＋head）。

索引可用性：graphify 直接可用（`OpenCharts/graphify-out/graph.json`）；
codegraph 的索引在 `C:\Users\bear9\MYOPENCHART\.codegraph`（120 MB），**必須從 `MYOPENCHART` 目錄呼叫**
（從 `OpenCharts` 呼叫會回報「沒有索引」）。

### 軸三・模式盤點（完成，實作必須沿用）

| 既有機制 | 位置 | 本輪必須怎麼用 |
|---|---|---|
| 觀測把手（strict 註冊） | `debugFlags.ts:33-65`、`internalNames.ts:32-36` | 新增計數/階段一律走這裡註冊，不新增 ad-hoc global |
| `markStage()` ＋ `__pineStage` | `debugFlags.ts:86`、`engine.ts` | 階段計時沿用，不另造 timing 框架 |
| `recordRunTiming` / `__pineRunLog` | `engine.ts:410-415` | app 端 run 時間的唯一來源（{bars, ms}） |
| per-node 記憶（resolve once） | `RESOLVED_BUILTIN` `interpreter.ts:1203`、`PARAM_FLAGS` `:1427`、`runStates` `:188`、`jit.ts:22` | 快取新東西用 WeakMap keyed by AST node／call，沿用同一慣例 |
| MTF 快取 ＋ in-flight 去重 | `mtf.ts:1718`（evalAt）、`:618`（jobs Map） | 修 H2 只能改既有 evalAt 快取的鍵/失效策略，不新增第二套 MTF 快取 |
| 模型快取 | `modelCache.ts:44/57/66`（IndexedDB，MAX_ENTRIES=24） | 改 key/put 策略要在同一模組內，不另開 store |
| 增量 session ＋ 輸出攤還 | `interpreter.ts:3592`（incRun）、`:2964`（emitCache）<br>~~**移除（2026-10-15）：原列的 `engine.ts:339-347` adaptive tick-skip 已證明不可達並刪除**~~ → **T10 定案（R5 收尾）：分支仍在 `engine.ts:348`，「死碼」之說不成立（`PROGRESS.md:712`），已知、接受、行為不改**（見下 T12 判定表 T10）——skip 需 `lastRunMs>500 ∧ !incHolder.live ∧ !incHolder.active`，但 `lastRunMs`／`active` 寫在同一條成功路徑、`active` 從不重設為 false、非空 tape 必然產生 live session（`incRunStart` 僅 `bars.length===0` 與 `shouldAbort` 兩處回 `live:null`，後者等價 `stopped`，而 `request()` 開頭已擋）；首跑 `lastRunMs===0` 故永不跳。回歸不變式見 `engine.test.ts` 的 `tick policy` | 這是 H1 的既有緩解路徑；擴充它，不新寫一套 |
| 行情去重 | `candles.ts` `kbarsInflight`／`kbarsCache` | 不在本輪範圍（非直譯器） |
| 效能量測 harness | `scratch/perf-probe.mjs`（先 import `builtins/index.ts`）、`perf_bench.test.ts`、`scratch/perf-baseline.json` | 新 harness 放 `scratch/perf/`，沿用同一 import 順序與確定性計數器風格 |

註：JIT 預設 **OFF**（`__pineJit` 需 opt-in，`debugFlags.ts:37`）→ 載入效能不可依賴 JIT 路徑。

## P5 REAL PLAN v1 — Pine 分階段效能基準 harness

**目標**：一支 CLI 量測「指標載入」每一階段耗時；可重複、可比較、可判線性／超線性；**不改 `src/**`**。
它是 A3／A4／A5／A6 的**量測儀器**（先有儀器，才有門檻）。

### 位置

| 項目 | 路徑 |
|---|---|
| 工具 | `scripts/perf/pine-bench.mjs` |
| 固定資料 | `scripts/perf/fixtures/bars-5m-mxf-500.json`（由 `scratch/_bars_mxf.json` 固化，確保每次可比） |
| 結果 | `bench/pine/<label>.json`（`--out` 可改）＋ `--md` 印表格 |
| 說明 | `scripts/perf/README.md`（跑法、欄位、判定規則） |

### 分階段定義（v1 可量測的顆粒度）

| 階段 | 量測方式 | v1 |
|---|---|---|
| `parse` | `parse(src)`（lexer ＋ parser） | ✅ |
| `checks` | `assertScript(parsed)`（整棵 AST walk） | ✅ |
| `collectInputs` | `collectInputs(body)` ＋ `parseDeclArgs(parsed.decl)` | ✅ |
| `compile` | compile-to-closures 無法外部單獨計時 → 記 `__compileCalls`、`__compiledKinds` 分佈 | 間接 |
| `run` | `runScript(parsed, bars, opts)` 總時間、`bars`、`ms/bar` | ✅ |
| `assemble` | run 內部完成 → v1 標 `not_separable`（v2 用 `markStage` 掛鉤） | 部分 |
| `model` | `buildModel(modelId, req, r, barTimes, overrides)`（`engine.ts:556` 已 export） | ✅ |
| `cache` | `modelCacheGet`／`modelCachePut`；IndexedDB 不可用時記 `n/a` ＋ 原因 | ✅ |
| `total(app)` | `new PineInterpreterEngine()` → `prepare()` ＋ `execute()`（app 真實路徑） | ✅ |
| counters | `__mtfStats`、`__evalNodeCounts`（top-20）、`__callHistWrites`、`BarSeries.setAt/ensureBar` 呼叫數 | ✅ |

### CLI

```
npx tsx scripts/perf/pine-bench.mjs \
  --script <path.pine> [--script <path2.pine> ...] \
  --bars 500 | --bars-file <json> | --fetch-bars <n> (本機 :8080 kbars → 本機 resample) \
  --tf 5 --repeat 5 --warmup 1 \
  --scale 100,200,500,1000,2000 \
  --engine-path app,direct \
  --out bench/pine/<label>.json --md \
  [--label <name>] [--compare <baseline.json>]
```

- `--engine-path app`：走引擎真實路徑（含 `buildModel` ＋ modelCache）。
- `--engine-path direct`：`parse` → `assertScript` → `runScript` → `buildModel` 逐段外部計時（可拆階段）。
- 預設兩條都跑，JSON 內分成 `app`／`direct` 兩組。

### 輸出欄位（JSON）

每 `(script, engine_path, bars)` 一筆：`{script, bars, ms: {parse, checks, collectInputs, run, model, total, cacheGet, cachePut}, msPerBar, min, median, max, repeats, counters: {...}, flags: []}`；
`flags` 用於標 `SUPERLINEAR`（成長倍率超過 N 比 ±30%）、`NOT_SEPARABLE`、`CACHE_N_A`。

### 判定規則

- 成長：`--scale` 每個 N 報 median；倍率 vs 最小 N 若超過 N 比 ±30% → `SUPERLINEAR`。
- 回歸：`--compare` 逐欄絕對值 ＋ %；僅 >10% 才標 `regression`／`improvement`。
- 重複性：同設定連跑兩次的 `total` 差異應 <15%，否則該環境不適合當基準（harness 自己要能指出這點）。

### 非目標（本 harness）

- 不改 `src/**`（v2 若需 stage hook，只准用既有 `markStage`，並列 P8 review）。
- 不量 UI／渲染（瀏覽器端另有 `__pineRunLog`）。
- 不量 worker 路徑（v1 主執行緒）。

### harness 自身驗收

| # | 判定 | 條件 |
|---|---|---|
| H1 | code | `--script high452_phase3.pine --bars 500 --repeat 3` 跑完且 JSON 欄位齊全 |
| H2 | code | 同設定連跑兩次，`--compare` 差異 <15%（重複性） |
| H3 | code | `app` 與 `direct` 的 `total` 差異 <20%（兩條路徑一致） |
| H4 | code | 對含 `request.security` 腳本，MTF counters 有數字；取不到資料時輸出 `n/a` ＋原因（不得靜默 0） |
| H5 | jev | 欄位／階段命名沿用 repo 既有詞彙（`__mtfStats` 欄位、`markStage` 階段名），未造第二套 |

## P4 卡點解法設計（2026-10-14 實測後定稿）

### 卡點 1：TV 對齊（A6）→ 拆成兩半，只有一半需要使用者

| 半 | 需要誰 | 做法 | 狀態 |
|---|---|---|---|
| **靜態半** | 不需要使用者 | OMP 管理的 Chromium 開公開 TV 圖表頁（匿名可載入，實測 99 個 JS bundle，無 bot wall）→ `performance.getEntriesByType('resource')` 取 bundle 清單 → `Bun.write` 落地 → REA `recover_javascript_sources`（Wakaru 反混淆）＋本地分析 → 定位 TV 的 Pine runtime（per-bar 執行迴圈、series 儲存、`ta.*` state、`request.security` 處理） | 可立即開跑 |
| **實測半** | 使用者開 CDP | 使用者以獨立 profile 開 `--remote-debugging-port=9222` 並登入 → 兩條工具路（可互補）：**(a) REA** `list_browser_targets` → `inspect_web_page`（passive）→ `export_web_scripts` → `observe_web_execution` / `observe_web_session`；**(b) OMP browser `app.cdp_url:"http://127.0.0.1:9222"`** → `tab.run` 內有 `evaluate`／`metrics`／`profileStart|Stop`／`requests`(HAR) → 直接量「貼腳本 → study 計算完成」的 wall／CPU 時間 | 等使用者 |

- 使用者的圖表是**私有 layout**（匿名開 `tw.tradingview.com/chart/l14iDw0v/` 回 `Chart Not Found`）→ 靜態半改用公開圖表頁抓 bundle；實測半必須用他的登入 session。
- 量測點設計：TV 無公開 per-bar 計時 API，故以「同一段 bar 數、同一支腳本，貼上後到 study 出圖」的 CPU/wall 差值為準（`profileStart`/`profileStop` 取 CPU profile 佐證歸屬）。
- **降級路徑**（CDP 不可得）：A6 改為「複雜度對齊（靜態推導）＋ 內部絕對門檻」，報告須標明為推論，不得宣稱實測對齊。

### 卡點 2：新 harness 未完成（A3/A4）→ 不等它，先定暫定門檻

現有 `scratch/perf/phase-baseline.md`（run 數字齊）已足以定門檻；新 harness 只是把 `model`/`total`/`assemble` 欄位補齊。

| 項目 | 暫定門檻（依現有 baseline） | 依據 |
|---|---|---|
| A4 成長 | run 倍率(1000/500) ≤ 2.2，且優化後不得上升 | 現況 2.07（high452）／2.15（TRIS390）／1.89（MACD701） |
| A3 降幅 | K55 `run` 降幅 ≥ 50% | 下限保證，等 TV 數字回來升級為相對門檻 |
| ms/bar | high452 ≤ 16（現 31.7）、TRIS390 ≤ 6（現 12.1）、MACD701 ≤ 1（現 2.0） | 現況 ÷2 起跳 |

新 harness 交付後：先過 H2（同設定兩跑 <15%）才可採信，並成為**唯一量測來源**，舊 `scratch/perf/phase-bench.mjs` 退役。

### P3 卡點分級（受管 JEV，gate `taskwf-blocker`，2026-10-14）

| 卡點 | 判級 | 信心 | 處置 |
|---|---|---|---|
| TV 對齊實測(A6)延後到隔日 | `risk` | 1.00 | 以本地 run 門檻先動工;A6 標記為未量測,靜機後補 |
| 舊 harness 的 `model`/`total` 回 `error` | `risk` | 1.00 | A3/A4 用 run 欄即可定;由新 harness 補齊欄位 |

軸一／二／三宣稱驗證（gate `taskwf-verify`，全數通過）：`baseline_real` 0.82、`h1_dominant` 0.84、
`h5_not_hot` 0.92、`conventions_exist` 0.94、`tv_stall_not_client_compute` 0.87、`slowness_from_machine_load` 0.79。

### TV 實測（2026-10-14 收工狀態；A6 延後）

已建立：
- CDP 通道：Chrome 155 @ `127.0.0.1:9222`，獨立 profile `C:\Users\bear9\tv-cdp`，啟動檔 `C:\Users\bear9\tv-cdp-launch.cmd`
- REA 可用：`list_browser_targets` → target `02A2B9BFE1A8E48505FAD38F1AB14867`（`tw.tradingview.com/chart/l14iDw0v/`，MXF1! 小台，已登入）；`inspect_web_page`（被動）成功

使用者嘗試掛 95 KB 指標期間（272 秒視窗）的實測：

| 觀測 | 值 | 判讀 |
|---|---|---|
| `ScriptDuration` | 12.680 → 12.704 s（**+24 ms**） | 客戶端幾乎沒在算 JS |
| `TaskDuration` | +32.6 s | 任務時間增加但非 JS 執行 |
| DOM 節點 | 5,684 **不變** | 沒有新物件進入畫面 |
| worker | 只有 1 個 blob Timer worker，**無 study/pine worker** | 客戶端 study 未啟動 |
| CPU profile（457.8 s） | idle 425.5 s（93%）、GC 12.9 s、我方 evaluate 9.2 s、TV bundle 0.5 s | 同上 |
| console | 無 Pine/study 錯誤（只有 Google 登入噪音） | 無編譯錯誤可判 |

環境干擾（已確認）：機器 CPU **100%**；主要消耗者 `bun`（OMP agent host，3,978 s CPU／2.2 GB）＋三個並行子代理＋ai-memory。
→ 當下的 TV 量測**不可採信**。收工時已清掉所有 failed/exited 服務。

**明日續作（照序）**：
1. 跑 `C:\Users\bear9\tv-cdp-launch.cmd`（同 profile，登入保留）
2. **先確認機器沒有背景重活**（本次教訓：量測前必須靜機）
3. TV 分頁保持最前面（背景分頁被節流）
4. 依序掛：內建指標 → 3 行腳本 → 見高K，記錄「出現耗時」與任何錯誤訊息
5. 量測手段：`app.cdp_url` ＋ `profileStart/Stop` ＋ CDP Performance metrics 差值；需要時用 REA `observe_web_execution`
6. 靜機後**先**用新 harness 重跑本地 baseline（補上 `model`/`total`），**再**量 TV —— 同機同日才有可比性

### TV 靜態逆向結論（2026-10-14/15 完成；`scratch/tv-recon/`）

方法：OMP 管理 Chromium 匿名載入公開圖表頁 → 98 個 page bundle（5.11 MiB）＋由 webpack `hashMap` 展開的
**1,492 個 chunk（89.4 MB）全數下載**（0 失敗）→ 解 `nameMap`/`hashMap` → 字串/offset 證據比對。

**核心結論：TradingView 客戶端沒有 Pine runtime。Pine 在伺服器端編譯並執行。**

| 證據 | 內容 |
|---|---|
| 無 runtime 簽名 | `pinejs`/`PineJS`/`pine_worker`/`StudyEngine`/wasm/bytecode **0 命中**（我用 `grep -rl` 獨立複核確認） |
| 唯一安裝點 | `46286:4605` `setChartApi("site", new TVChartApi(window.WSBackendConnection))` |
| 建立 study | client 送 `create_study`（`46286:20482`）；實測 WS frame `{"m":"create_study","p":[...,"Volume@tv-basicstudies-279",...]}` |
| 伺服器回值 | `study_loading` → `du`（data_update）帶算好的值；節點名如 `hkg1-charts-free-3-stress-study-*` |
| 編譯 | `translate/<id>/<ver>`、`translate_source/<t>`（POST `{source,inputs,is_pine_ex}`）、`PineCompileFailErrorImpl` |
| MTF | 客戶端只有 `resolve_symbol`/`create_series`/`request_more_data` 原語；`request.security` 只出現在**參考文件** bundle |
| `ta.*` | 客戶端無實作（只在文件/編輯器模板） |
| 客戶端資料結構 | `PlotList`（`48903:3586`）＝陣列＋可移動視窗 `_start/_end`，寫入分派 `_prepend/_append/_updateLast/_merge`；`na` 以 `1e100` 哨兵傳輸 |

對本專案的意義：

1. **「對齊 TV 的 per-bar 時間」在客戶端不可量測** —— TV 的每 bar 成本在他們的伺服器上（我們只看到 WS 往返＋渲染）。
   先前 272 秒量到「客戶端幾乎零 JS 執行」的現象由此完全解釋。
2. 可對齊的是**架構層**：TV 的模式是「伺服器算一次 → 之後只串流增量 `du`」，客戶端**永不重算歷史**。
   我們引擎的缺口正是此處：`incRun` 增量**不適用**含 `request.security`／strategy 的腳本（`interpreter.ts:3078-3082`）
   → 那幾支每次更新都全量重算（H1）。**這就是最大且可量測的對齊點。**
3. 客戶端容器可作次要參照：他們的 `PlotList`（陣列＋移動視窗）vs 我們的 `BarSeries`（ring＋head）——兩者都不做前插，方向一致。

### A6 需要改寫（待使用者裁決）

原 A6「同腳本同 bar 數的 per-bar 成本 ≤ TV 實測 × k」**在客戶端無法量測**（見上）。建議改為可量測版本：

| 選項 | 內容 | 可量測性 |
|---|---|---|
| A6'（建議） | 客戶端**增量成本對齊**：載入完成後，任一腳本（含 MTF/strategy）每新增一根 bar 的成本 ≤ 冷跑成本 ÷ bar 數 × k（k 由實測定），即「每 tick O(1)，與歷史長度無關」 | 本機 harness 可量（`incRun` tick cost） |
| A6''（參考） | 端到端延遲參考：`create_study` → 首個 `du` 的 WS 往返時間，只當上限參考，不作 code 門檻 | 需 TV 連線；受網路影響 |
| A6''' | 取消此條 | — |

> 改寫屬**驗收變更**，需使用者明確同意後才調整 plan doc 的 A6 條目。
> → **2026-10-15 使用者同意：採用「增量 tick 預算」（上表 A6' 的強化版）**，門檻定為
> 「策略／MTF 腳本每個 live tick（增量）**≤100 ms**，且**增量 ≤ 冷載入 total ÷ 10**」；A6''／A6''' 不採用。
> 實測現值：K55 **55 ms/tick**（26.8×）✅、TRIS390 **107 ms/tick**（10.9×）⚠️ 邊緣 → 需在**安靜機**複測後才算通過（已排入 autorun T4）。

### harness 交付（P6 完成，2026-10-14/15）

交付物：`scripts/perf/pine-bench.mjs`（25 KB）＋ `scripts/perf/lib/**`＋ `scripts/perf/README.md`（20 KB）
＋ `scripts/perf/fixtures/bars-5m-mxf-500.json`（固化 500 根 5m MXF）＋ `bench/pine/*.json`（9 檔結果）。
欄位齊全：`ms{parse,checks,collectInputs,compile,run,assemble,model,cacheGet,cachePut,prepare,execute,total}`、
`msPerBar/min/median/max/repeatSpread/phaseSpread`、`counters{mtf,evalNodeCounts,callHistWrites,compile,seriesWrites}`、
`flags[]{NOT_SEPARABLE,GATE_REJECTED,CACHE_N_A,NOISY,SUPERLINEAR}`。

| 驗收 | 結果 |
|---|---|
| H1 跑得完且欄位齊全 | ✅ 跑完；但 `high452_phase3` 該筆為 `GATE_REJECTED`（見下） |
| H2 同設定兩跑 <15% | ⚠️ **71.9%**（全部四支）／**19.2%**（兩支重腳本 `--repeat 5`）；同一次 run 內 `repeatSpread` 0.06–2.27 |
| H3 `app` vs `direct` total <20% | ✅ 足量取樣（`--scale 100,200,500 --repeat 3`）6/6 過（−1.2% ~ +17.3%） |
| H4 MTF counters 有數字或 `n/a`＋原因 | ⚠️ 條件式通過：以 TRIS390（29 處）、MACD701_v72（2 處）、final（4 處）證明；`high452_phase3` 為 `n/a`＋gate 原因 |
| H5 沿用既有詞彙 | ✅ |

**H2 的失敗不是 harness 的問題**：`model` digest 與全部 counters **逐位元一致**（工作內容確定），
抖動來自環境 —— 當時本機有 15 個 `node.exe`。→ 再次確認「量測前必須靜機」；H2 需在靜機環境重測才算過。

**舊檔問題（已釐清，非缺陷）**：磁碟上的 `high452_phase3.pine`（6/10 舊檔，sha1 前綴 `84b5bf44`）在 `:74:17`
用 `input(close, "Source for Moving Averages")`，被 `assertScript` 的 `[input-const]` 規則擋下 → `prepare` 拋 `ParseError`。
自 Vela workspace 備份 blob（`%TEMP%\vela-ws-backup-20261014.json`）抽出的**真實 app 腳本**
（`scratch/perf/app-scripts/script-a1dcdea6-95114.pine`，95,114 chars，`a1dcdea6`）**不含該寫法**，可正常載入並跑出完整模型。
→ 結論：**磁碟舊檔過期，與生產無關**；後續量測一律用抽出的 app 版本（已納入 baseline 與 A3 門檻）。

其他已知限制：`modelCacheGet/Put` 在 Node 下是 no-op（`indexedDB` 未定義）→ `CACHE_N_A` 為正確標記，非缺陷。

## P5 REAL PLAN v1 — 優化切法（2026-10-14 定稿，依量測排序）

**排序依據**：run 佔 total 99.8%（parse 最大僅 38 ms）；run 內成本＝每 bar 全量 body 執行；
MTF 腳本另有 evalAt miss（TRIS390 46 eval/bar、MACD701_v72 26 eval/bar）。
TV 端架構（算一次＋只串流增量）使 **S1 成為唯一真正對齊的切片**；S2–S5 是純本地加速。

| # | 切片 | 目標檔案（單一擁有者） | 做法 | 驗證 | 風險/rollback |
|---|---|---|---|---|---|
| S1 | `incRun` 增量支援 **含 `request.security`／strategy** 的腳本 | `src/pine/interpreter.ts`（inc 區）＋ `mtf.ts` | 現況 `interpreter.ts:3078-3082` 直接排除 → 每次更新全量重算。改為增量 tick 只重算 forming bar，妥善處理 MTF 快取 bar 窗變動 | golden 0 差異 ＋ `mtf.test` / `qa_r2` 綠 ＋ harness 量 tick 成本（新增 `--incremental` 模式或獨立探針） | **高**（語意）→ 必過 P8；rollback `git checkout b9fcd81 -- src/pine` |
| S2 | `mtf.evalAt` 快取鍵 | `src/pine/mtf.ts` | 快取命中需 caller Scope 相同（`:1740`），但 UDF 每次呼叫配新 Scope（`:1894-1902`）→ 改以 callsite key（沿 `interpreter.ts:404 callsiteKey` 慣例）取代 Scope 身分 | `__mtfStats` evals 下降 ＋ `perf_bench.test.ts` A/B（UDF vs PARAM）＋ golden 0 差異 | 中（UDF 內狀態語意） |
| S3 | `evalArg` 每 bar 包 series ＋ callHist 寫入 | `src/pine/interpreter.ts`（evalArg/invokeBuiltin） | 不需歷史的引數避免 `new BarSeries` ＋ `setAt`（既有 `noHist`／`reg(...,false)` 機制已存在，盤點漏網的 builtin 註冊） | `__callHistWrites` 下降 ＋ `src/pine` 全綠 ＋ harness run 時間 | 低-中（**注意 remaining-work §0.3：需要歷史的引數必須 `hist=true`**） |
| S4 | `ta.*` 剩餘每 bar O(L) | `src/pine/builtins/ta.ts` | `vwma`(:610)、`corr`(:843)、`dev`(:861)、`linreg`(:1218)、`spearman`(:1902) 等改增量/RMA 式滑窗 | 各 builtin 既有測試 ＋ golden 0 差異 | 低 |
| S5 | `assembleRunResult` 重掃 | `src/pine/interpreter.ts:2947-3026` | 一次性路徑重掃每個 plot sink；沿用既有 `emitCache` 攤還思路 | harness `assemble` 段（direct 路徑）＋ golden | 低 |
| S6 | parse／prepare 一次性 | `src/pine/{lexer,parser,checks}.ts` | 95 KB 僅 38 ms → **最後做**，除非其他切片都做完 | harness `parse`／`checks` 段 | 低 |
| **S7** | **`freezeReader` 不接受非 `BarSeries` 的虛擬 series** → `math.sum`/`nz`/`math.avg` 落到 eager 重掃 | `src/pine/series.ts:457` | `ta.tr` 回 `FnSeries`（`ta.ts:1656`）→ `freezeReader` 回 null → `seriesFromOffsets`（`math.ts:35`）每次呼叫寫 `bar+1` 筆 ⇒ **二次項** | TRIS390 100 根 before/after `setAt`；`scratch/perf/s7-*.mjs` 證明 lazy/eager 逐值（含 na）相等；golden 0 差異 | 中（reader 語意） |

**二次項實測（S3 代理發現，2026-10-15）**：TRIS390 500 根 `setAt` 413,282 中 **125,250（30%）** 來自
`math.sum(ta.tr, chopLen)`（`TRIS390.pine:289`）的 eager 路徑，Σ(b+1)=125,250 → 每 bar 一次、每次 O(bar)。
總時間仍呈線性（2.15×），因為它只占寫入成本的一部分，但**這是一個真二次項**，根數變大會惡化（5,000 根即 12.5M 次寫入）。
另註：S3 探測結論 —— callHist 寫入 98% 確實被讀取（`nz` 走 `freezeReader`/`peek`），**interpreter.ts 內無可移除的 callHist 浪費**；
K55 的 for-loop 變數（35,636 寫＋35,636 配置）與 UDF mut-only 純量參數（3,487）屬同族但需 series.ts 支援，列另案。

**P6 執行規則**：每輪 ≤3 代理並行；**同檔不併發 edit**（S1/S3/S5 同檔 → 序列）；每個 slice 交付必附煙霧證據
（改動路徑實跑輸出，不接受「只交 diff」）。**S1 單獨一輪**，因為它的驗證面最廣。

**門檻（A3/A4）**：已由 `bench/pine/s12-clean1.json`（真實 app 腳本 ＋ TRIS390 ＋ MACD701_v72 ＋ final，500 根，
repeat 3）回填。**注意：真實 app 腳本是 `scratch/perf/app-scripts/script-a1dcdea6-95114.pine`（sha1 前綴 `a1dcdea6`，
95,114 chars），不是磁碟上的舊檔 `high452_phase3.pine`（`84b5bf44`，91,271 chars，被 `[input-const]` 擋）**。
舊檔問題已釐清：**app 內實際版本沒有 `input(close, …)`，可正常載入 → 非生產缺陷**（磁碟舊檔過期）。

### 優化前 baseline（乾淨環境，500 根；`app` 路徑）

| 腳本 | parse | run | **total** | ms/bar | mtf evals | evalNodes | callHistWrites | **setAt** | ensureBar |
|---|---|---|---|---|---|---|---|---|---|
| app K55（`a1dcdea6`） | 119.1 | 12,782.8 | **12,946.9** | **25.9** | 430 | 2,867,049 | 10,643 | **395,385** | 506,940 |
| TRIS390 | 29.2 | 6,894.6 | **6,923.8** | **13.8** | 8,458（hits 12,444） | 1,225,330 | 12,392 | **413,282** | 75,994 |
| MACD701_v72 | 10.5 | 1,488.2 | **1,501.9** | **3.0** | 7,995（hits 5,447） | 161,176 | 0 | 66,352 | 24,106 |
| final | 0.5 | 17.1 | **27.3** | 0.05 | 215 | 4,715 | 0 | 10,152 | 5,000 |

衍生事實：K55 = **5,734 evalNode/bar、791 setAt/bar**；TRIS390 = **827 setAt/bar、2,451 evalNode/bar**。
→ 每 bar 的節點求值與 series 寫入量是絕對量級，S3（callHist/setAt）與 S2（MTF）優先序因此確認。
H3（app vs direct）：K55 6.9%、TRIS390 2.3% 皆 PASS；MACD701 20.3%、final −37.7%（小數值＝噪音）。
model digest（app vs direct）**四支全一致** → 兩條路徑同語意。

### A3／A4 門檻（定案）

> **2026-10-15 使用者裁定（分級，取代「每支 ≥50%」）**：
> K55 total 降幅 **≥50%**／TRIS390 **≥40%**／MACD701_v72 **≥30%**，**外加硬條件**「四支腳本 model 內容 digest 與 baseline 逐字相同 ＋ golden 0 差異 ＋ A4 成長倍率 ≤2.2」。
> 作廢理由：TRIS390 同樹跨跑變異 **±9%**，門檻線（3,460 ms）落在其 min–max 區間（3,061–3,633）內 → 「每支 ≥50%」在此環境是**取樣賭博**而非可複現判據；MACD701 的 −45% 其成本集中在 MTF 每次 eval，留下輪處理。
> 現值全過：**−61~64%／−49~53%／−45%**，digest 四支逐字相同。

| 條 | 門檻 |
|---|---|
| A3 | 每支腳本的 `total` 相對本次 baseline **降幅 ≥ 50%**：K55 ≤ 6,470 ms（≤ 12.9 ms/bar）、TRIS390 ≤ 3,460 ms、MACD701 ≤ 750 ms |
| A4 | (1000/500) 倍率 ≤ 2.2，且相對 baseline **不得上升** |
| A5 | app 實機載入（真實 K55 還原路徑，樣本＝`a1dcdea6`）優化後 < 優化前 |
| A6 | **已定案：增量 tick 預算**（每 tick ≤100 ms 且 增量 ≤ 冷載入 ÷10；TRIS390 107 ms 待安靜機複核） |

## P6 Round-1 結果（滾動更新）

### S2 `mtf.ts` — 完成（+101/−8，單檔）

**計畫前提被否證（先量測後修正）**：原 H2 假設「`evalAt` 命中需 caller Scope 相同，UDF 每 bar 配新 Scope → 大量 miss」。
S2 以暫時性 diag 逐 spec 實測 TRIS390 500 根：**每個 spec 的 caller 都是同一個 Scope 物件**（`fresh=1 / reuse=499`、每節點 `callers=1`），
因為 24 個 `request.security` 全在 top-level（`frame0.scope` 跨 bar 不變）→ durable 路徑本來就生效，改 callsite key 對 TRIS390 **0 效果**，
且會打爛 `perf_bench.test.ts` 中**不得修改**的斷言（PARAM_SRC 要求 `evals > 5000`）。

**真正的浪費**：同一 producer 節點被**每個 spec、逐 tf bar** 重算 —— 例如 `atrPeriod = input.int(10, …)` 在 7 個 spec 各算 499 次（817 evals/node）。
producer evals ≈ 5,660/8,458 = **67%**，且與 tf bar 無關。

**改法**：新增 tf-bar-independent 的 `invCache`（key = AST node，**無 j**）＋ `invVerdicts` memo，白名單只放行純量字面值／`input.*`／不變 global 鏈／`unary|binary|ternary|arraylit`；
`SERIES_NAMES`、`:=` global、`ta.*`、UDF、histref、member、未知 ident 一律拒絕；`MUTABLE_KINDS`/`series` 不共享 payload（沿用既有 per-caller 寫入慣例）；
`SpecSnap`/`restoreSpec` 與 lookahead/ltf rollback 鏡射既有 `agnosticCache`（同一條 rollback 路徑）。位置 `mtf.ts:182-183, 522, 1084, 1319, 1733-1778, 1780-1859, 2167/2215/2254/2298`。

| 指標（TRIS390，`--engine-path direct`） | before | after |
|---|---|---|
| 100 根 `mtf evals` | 8,477 | **2,922（−65.5%）** |
| 100 根 `mtf hits` | 6,201 | **11,756（+89.6%）**（`invHits` 9,930） |
| 500 根 `mtf evals` | 8,458 | **2,903（−65.7%）** |
| 500 根 `mtf hits` | 12,444 | **17,999（+44.6%）**（`invHits` 9,860） |

測試：`mtf.test.ts` 86 ✓、`perf_bench.test.ts` 5 ✓、`golden.test.ts` **0 差異**、`npx vitest run src/pine` **62 檔 / 954 passed + 1 skipped** ✓、`tsc --noEmit` 0 ✓。

**保留的限制（不可含糊）**：`run ms` **無可信結論** —— 量測期間有 12+ 個 node/bun（S3/S4/S7 並行），標 `NOISY`；
時間效果需在**靜機**重測（列 P7）。另：全套測試第一次出現失敗是**同輪他檔編輯中的污染**（S3/S4 正在改 `interpreter.ts`/`ta.ts`，測試讀到改到一半的檔）；
第三次（mtimes 穩定）全綠 → **round gate 的全套測試必須在所有切片停止後才跑**。

**H2 條目更正**：由「caller Scope 身分造成 miss」改為「**producer 節點被每個 spec 逐 tf bar 重算（與 tf bar 無關者佔 67%）**」。

### S4 `builtins/ta.ts` — 完成（+58/−16，單檔）

**先量測再改**：寫了 `scratch/perf/ta-hotspot.mjs`（包 `BUILTINS` 計時＋patch `BarSeries.get` 計數）在 K55 app 腳本（100 根）量 per-builtin `Series.get`/bar。

| builtin | before gets/bar | after |
|---|---|---|
| `ta.sma` | **523.7** | **36.6** |
| `ta.ema` | **101.0** | **2.0** |
| `ta.vwma` | **68.9** | **9.1** |
| `ta.lowest` / `ta.highest` | 52.9 / 52.9 | 52.9 / 52.9（**未解**，見下） |
| **ta.\* 合計** | **1,018.7** | **371.8（−63%）** |

**根因（最小重現 `scratch/perf/repro-churn.pine`）**：`input.source(close)` **每根 bar 產生新的 CowSeries 包裝**（60 根 → 60 個不同身分；`ta.sma(close,50)` 則固定 1 個）。
`vsOf`/`winAgg` 以「包裝物件身分」當鍵 ⇒ 每 bar 丟掉整個滑動窗重建 = 每 bar 全窗 O(L) 重掃。
修法：鍵與讀都改走 `ForwardingSeries.readTarget()`（契約本就是「`get(i)` 實際讀的序列」，`series.ts:445`），值不變、鍵穩定；`:=` 物化 copy 仍各自一份 state。順帶套用到 `emaTag`/`cum`/`vwap` anchor/`srcKey`。
第二項：`ta.vwma` 每 bar O(L) 雙迴圈 → 滾動視窗（新增 `winAgg` 的 `ssum` 嚴格滑動和 ＋ `vsum` 派生序列）。

**量測**（100 根 `--engine-path direct`，A/B/A/B 交錯）：K55 app 端到端 **落在噪音內（±1%，`NOISY`）→ 不宣稱端到端降幅**（移除約 650 步/bar，而 K55 是 5,734 evalNode/bar）；
隔離同一 churn 型態的重現腳本（300 根、repeat 3）**396.8 → 135.0 ms（median 404.4 → 137.3，−66%）**，digest `q7vodg` 與 `setAt 4,800` 前後一致。
驗證：`src/pine` 全套 **62 檔/954 passed/1 skipped**；golden **0 差異**；`ta.test.ts` 70 passed；三個腳本 **model digest 逐位元相同**、`setAt`/`callHistWrites` 相同。

**S4 回報的新切片候選（未動）**：
- **S8（重要）**：`ta.highest`/`ta.lowest` 仍 52.9 gets/bar ×2，且**隨 bar 成長（超線性）** —— 來源是 `srcLen → constNum → constSeriesNum`：
  每 bar 新生的 `LiftedSeries` 身分使 `winAgg` 從歷史開頭整段重掃（`m.size===0 ⇒ end=size`）。最小重現 `scratch/perf/repro-minchurn.pine`。
  安全修法需要 **`LiftedSeries` 計算序列的穩定身分（interpreter 端）** 或精確的「是否變動」判準 → 需跨檔（S1/S5 同檔 → 排到後輪）。
- S9：`winAgg` 以 `L` 為鍵，length 每 bar 變動即重建窗（K55 `math.min(tab_abc_bar_count+1,10)`）。
- 上游治本：`input.source` 每 bar 產生新 CowSeries（interpreter 端）；本次是在 builtin 層防禦。

### S3 `interpreter.ts` — 完成（+25/−6，單檔；與計畫假設不同的真熱點）

**先 profile 再改**（`node --cpu-prof`，TRIS390 60 根）：**`debugFlag` self = 121.2 ms / 1,809 ms run = 6.7%**；
對照 `evalArg` self 僅 35 ms（1.9%）、`series.ts` 全部 65 ms（3.6%）。原因是生產路徑每個 AST node 都呼叫
`debugFlag('evalCount')`（TRIS390 100 根 = **403,439 次**），而它每次都要踩 `globalThis['__pine…']` ＋ `process.env`。

**改法**：把三個診斷開關的探測從「每 node／每次 UDF 呼叫」降為「每 run／每 bar 一次」
（`RunState.evalCount`/`udfJitOn`、`evalNode:696`、`callUdfValue:1641`、`udfJitEnabled()→udfJitDefault()`、`evalOneBar:2911-2917`）
→ 探測次數 **403,439 → 300（−99.9%）**。語意只改「開關何時被讀」；`__evalNodeCounts` 照收，live toggle 於下一 bar 生效（比原本更寬容）。

**量測的誠實界線**：A/B 交錯（3 輪）TRIS390 median −12.0%、MACD701 median −38.3%，但同機有 3 個姊妹代理在跑 benchmark，
單輪擺幅 50–130% → **可信頭條是 profile 的 −6.7%**，A/B 時間不作結論。
`callHistWrites`/`setAt`/`ensureBar`/`__mtfStats`/model digest 在 A/B 兩側**逐位元相同**。

**counter 為何動不了（實測，非推論）**：K55 500 根 callHist 寫 10,643／讀 10,474（**98%**）；TRIS390 逐 builtin 歸因顯示
`ta.ema` 315 寫/10 讀、`ta.highest+lowest` 176/196、`nz` 1,804 寫（`freezeReader`→`peek`：offset 0 立即讀、歷史惰性）；
decl slot 寫入（K55 550/bar）每筆都被讀 → **無「寫了不讀」的 site**。語意上也不能改 `hist=false`（`ta.*` 視窗引數靠 callHist series 當來源）。

**需轉派的同族發現（未動）**：`math.sum(ta.tr, chopLen)` → S7；K55 for-loop 變數（35,636 寫＋35,636 配置）與
UDF mut-only 純量參數（3,487）→ 需 `series.ts` 提供可被 `freezeReader` 接受的 current-value slot，列另案。

驗證：golden＋interpreter＋builtins **140 passed/1 skipped（golden 0 差異）**；`src/pine` 全套 **62 檔/954 passed**；`tsc --noEmit` 0。
證據：`scratch/s3-ab/*.json`（12 檔）、`bench/pine/s3-{before,after}.json`。

### Round-1 總結（S2/S3/S4/S7 四切片，各自單檔）

| 量測 | 結果 |
|---|---|
| **A3 冷載入 500 根（app 路徑）** | K55 **12,946.9 → 8,373.2 ms（−35.3%）**、TRIS390 **6,923.8 → 5,502.0（−20.5%）**、MACD701_v72 1,501.9 → 1,382.8（−7.9%）、final 27.3 → 39.5（小數值＝噪音） |
| **A3 判定** | **未達 ≥50% 門檻**（K55 −35.3%）→ P7 不收斂，需 Round-2 |
| 決定性 counters | S2 `mtf evals −65.5%`；S4 `ta.* gets/bar 1,018.7 → 371.8（−63%）`；S7 `setAt −Σ(b+1)`（TRIS390 100 根 −5,050）；S3 `debugFlag 探測 403,439 → 300`（profile self 6.7%） |
| 語意 | **四支 script 的 model digest 與 baseline 完全相同**（app/direct 亦相同）→ 可觀察輸出未變 |
| 重複性 | `--compare` 最大差 44.83% → **重複性 FAIL**，起因環境負載 91%（非靜機）→ A3 需靜機複測 |

**Round-2 切片清單（依預期貢獻排序；同檔不併發）**

| # | 切片 | 檔 | 依據 |
|---|---|---|---|
| S8 | `ta.highest`/`ta.lowest` 每 bar 從歷史開頭重掃（52.9 gets/bar ×2，**隨 bar 成長＝超線性**） | `interpreter.ts`（`srcLen→constNum→constSeriesNum` 的 `LiftedSeries` 穩定身分） | S4 最小重現 `scratch/perf/repro-minchurn.pine` |
| S10 | **上游治本**：`input.source` 每 bar 產生新 CowSeries（S4 是在 builtin 層防禦） | `interpreter.ts` | S4 repro-churn（60 根 → 60 個身分） |
| S9 | `winAgg` 以 `L` 為鍵，length 每 bar 變動即重建窗 | `builtins/ta.ts` | K55 `math.min(tab_abc_bar_count+1,10)` |
| S11 | K55 for-loop 變數（35,636 寫＋35,636 配置）與 UDF mut-only 純量參數（3,487） | `series.ts`（current-value slot；S7 已鋪好 anchor 機制） | S3 歸因 |
| S1 | `incRun` 支援 MTF/strategy | `interpreter.ts`（單獨一輪） | **注意：A3 量的是冷載入，S1 不改善 A3**；它改善的是 live tick 成本與 TV 架構對齊（A6' 量它） |

**待辦**：full `src/pine` 全套 ＋ golden 的權威複跑（Parent 執行中）；靜機後重跑 A3 對照。

### Round-2 進度（滾動更新）

**S9 `builtins/ta.ts` — 已落地**：`winAgg` 內新增 per-VS 值快取（非 na 才快取）。
- `scratch/perf/repro-varlen-cycle.pine`（L 在 1..7 循環＋reset）：`ta.sma/stdev/highest` `Series.get` **13.3 → 1.1 gets/bar（−91.7%）**
- `scratch/perf/repro-varlen.pine`（K55 型 ramp `math.min(cnt+1,10)`）：**2.4 → 1.1（−54.2%）**
- 等價性：cycle／ramp／app K55 三支腳本 probe（全精度 double ＋ na ＋ `setAt`/`ensureBar`/`callHistWrites`）**逐位元相同**

**⚠️ golden 假失敗（處置已定，不可誤判為回歸）**
Round-2 姊妹片編輯中時，`見高K4.55` 出現 **7 條 na↔值**（`plots.plot_4.values[223-225,349-351,476]`；maxAbs/maxRel=0，非浮點容忍度）。
- **反證**：Parent 在 **02:11 對 Round-1 四片凍結狀態**跑權威 golden ＝ **14 passed / 1 skipped / 0 差異**。
- S9 以「套用自己 hunk / 還原自己 hunk」兩次對照 → 失敗集合與數值**逐位元相同** → 責任不在 S9。
- 判定：**測試讀到改到一半的檔**（與 S2 先前同型污染）。
- **規則**：不得在編輯中的樹上做跨檔 gate。Round-2 全停後由 Parent 在凍結樹跑權威 gate；若仍失敗才逐片回退定位。

**S11 `series.ts` — 已落地（+130/−1，純附加）**：新增 `CellSeries`（`BarSeries` 子類 current-value slot）＋ `CellSnapX` ＋ `freezeReader` 白名單接納。
- 跨檔必要 → 照票面走「介面 ＋ 5 行提案 ＋ 探針」：提案（`scratch/perf/s11-emul/README-PATCH.txt`）＝ 1 行 import ＋ 4 個站點
  `new BarSeries(); x.setAt(bar,v)` → `new CellSeries(bar, v)`，**待 Round-2 凍結後由 Parent 套用**（`interpreter.ts` 當時被 S8/S10 佔用）。
- 語意：探針逐值（含 na）證明與原寫法等價（13 讀取情境 ＋ 3 driver snap/rewind ＋ `freezeReader` anchor 前進 ＋ `nz`/`math.sum` 真 kernel 40 根）；抛棄式複本 e2e **model digest 逐位元相同**。
- 決定性 counters（複本 e2e、`direct`）：K55 500 根 **`setAt 395,385 → 356,262（−9.89%）`**；TRIS390 0%；歸因與計畫逐位對上（`evalFor` 35,636 ＋ `callUdfValue` 3,487）。
- **誠實的否定**：票面「消除 35,636 次配置」在 `series.ts` 內**做不到**（`extends BarSeries` 仍跑父類欄位初始化）→ 只省 buf push ＋ setAt 呼叫 ＋ 128 B/slot（351.8 → 224.0 B）。真正的配置槓桿在 interpreter 端（`evalFor` 每輪 `blockFrame`＋配 slot）。
- Golden 隔離 A/B：整棵樹只差它的 3 個 hunk → `見高K4.55` **兩邊 diffs=0**，與任何 golden 差異無關。
- 附帶釐清：`scripts/golden/見高K4.55.golden.json` 的 M 是**前一輪 na 修復**留下（mtime 21:41，早於 02:11 權威跑）→ 不是本次污染的來源。

**S8／S10（`interpreter.ts`）— S10 已落地；S8 因跨片耦合暫緩（等 ta.ts 釋放）**

- **S10 已落地**（`interpreter.ts:577-590`，實質只改一個條件：`else { cow = cow.rebind(...) }` → `else if (cow.source !== v.v) { … }`）。
  機制：`CowSeries.source` ＝「目前轉送的 inner」；**只有本根 bar 的 RHS 解析到同一個 inner 才重用 wrapper**，inner 未換時 rebind 本就是 no-op ⇒ 不會對被別處捕捉的舊 wrapper 造成 retro-mutation；inner 一換仍走 `rebind()`。
  這**不是新發明**：同檔 `paramCows`（UDF 參數）早已是同一條規則 → 本片是把 decl 路徑對齊既有慣例。
  決定性 counters（frozen A/B，同一份 peer 檔只差此 hunk）：K55 100 根 `ta.sma` distinct arg-series **124 → 25**、`ta.ema` **102 → 3**；`repro-churn.pine` 60 根 **63/63/63 → 4/4/4**。
  **誠實界線**：`gets/bar` **不變**（S4 的 `readTarget()` 早已中和窗重建）→ S10 的價值是「消除每 bar 一個包裝的身分 churn」，**時間量不到**（A/B 符號互斥＝NOISY）。
- **S8 未落地（跨片耦合，留證完整）**：
  (a) 根因 dump：`ta.highest(math.min(cnt+1,10))` 的 arg `LiftedSeries`，其 `get(i)` **對每個 offset 都回同一個「當前值」**（frozen reader anchor 在 lastBar 之前 → `peek` carry-forward 收斂）→ `constSeriesNum` full-scan 判定「常數＝當前值」→ `len` 動態 → **這正是 K55 `ta.highest/lowest` 52.9 gets/bar 超線性掃描的來源，且屬語意本身**。
  (b) memo 存活後改走增量分支：拿 cross-bar `m.v`（上一根）當基準 → 誤判 non-constant → `len === undefined` → NA。
  (c) A/B 隔離證明：`frozen`(S8+S10) → `見高K4.55` plot_4 7 根 na；`nob`(皆無) 與 `s10only`(現落地) 逐位元相同且符合 golden ⇒ **失敗只由 S8 hunk 造成**。
  (d) pair（S8 wrapper ＋ `ta.ts` `constSeriesNum` 2 token：`let v: number | undefined`；增量分支 `end` 加 `, 2`）已驗證：
  K55 100 根 `ta.highest`/`ta.lowest` **51.6 → 3.1 gets/bar**（<10 達標）、`repro-minchurn` 32.8/31.7 → **4.3/3.1**、7 根 golden 值**逐位元還原**、bench digest/counters 全同。
  patch 備妥：`scratch/s8s10/s8-wrapper.patch`、`scratch/s8s10/s8-ta-memo.patch`（**等 S9 釋放 ta.ts 後由同一代理套用**）。
- 現落地狀態 gate（03:00:27 最後編輯後重跑）：`tsc` 0、golden **14 passed/0 差異**、全套 **62 檔/954 passed**、bench counters/digest 與 baseline 全同。

### Round-2 總結（S8＋S10／S9／S11 落地；S11 的 5 行整合由 Parent 套用）

| 腳本（500 根，`app` 路徑） | baseline | Round-1 | **Round-2** | 相對 baseline | ms/bar | 內容 digest |
|---|---|---|---|---|---|---|
| **app K55** | 12,946.9 | 8,373.2 | **5,538.8** | **−57.2%** | 25.89 → **11.08** | `sxamcl`＝**與 baseline 相同** |
| TRIS390 | 6,923.8 | 5,502.0 | **3,765.4** | −45.6% | 13.85 → **7.53** | `3huclf`＝相同 |
| MACD701_v72 | 1,501.9 | 1,382.8 | **931.1** | −38.0% | 3.00 → **1.86** | `18qepy0`＝相同 |
| final | 27.3 | 39.5 | 36.8 | 噪音（小數值） | — | `1kzvcjg`＝相同 |

**語意等價的硬證據**：harness `checks.modelsMatchAcrossPaths` 的 **model 內容 digest 四支全部與 baseline 逐字相同**（app/direct 亦相同）
→ 在快 57% 的同時，可觀察輸出零變化。

**決定性 counters（baseline → Round-2）**：TRIS390 `mtf evals 8,458 → 2,903`、`setAt 413,282 → 288,032（−30.3%，S7 二次項）`；
MACD701 `evals 7,995 → 4,509`；K55 `setAt 395,385 → 356,262（−9.9%，S11）`、**`evalNodes` 不變（2,867,049）**
→ K55 是「每 node 變便宜 ＋ 移除重掃/二次項」，不是「node 變少」。
S11 的 5 行整合（`interpreter.ts` import ＋ 4 個站點 → `CellSeries`）由 Parent 套用，`new BarSeries()` 殘留 **10 → 6**。

**A3 判定（門檻：各腳本 total 相對 baseline 降幅 ≥50%）**

| 腳本 | 目標 | 實得 | 判定 |
|---|---|---|---|
| app K55 | ≤ 6,470 ms | **5,538.8** | ✅ **達標** |
| TRIS390 | ≤ 3,460 ms | 3,765.4 | ❌ 差 8.8% |
| MACD701_v72 | ≤ 750 ms | 931.1 | ❌ 差 19.4% |

**重複性仍 FAIL**（`totalMaxAbsPct 59.22%`，閘門量的是**全部欄位**含小數值欄如 final 27→37 ms）——
機器從未真正靜機（使用者自己的 opera/chrome ＋ 我方的測試/化驗輪流跑）→ A3 的最終數字應在靜機複測。

**Round-3 候選（給 TRIS390/MACD701 補 A3 缺口）**：這兩支的剩餘成本集中在 MTF（evals 仍 2,903／4,509）
→ 下一輪優先「MTF 每次 eval 的單位成本」（`computeAt`／`alignToChart` 快照／tf 域 callHist）與「每 node 配置（H4）」；
S1（`incRun`）仍單獨一輪、且**不改善 A3**（它改善 live tick／A6'）。

### Round-3 進度（滾動更新）

**R3C `builtins/ta.ts` — 已落地**：把 `winAgg` 內部的來源值環抽成共用 `winRingReader(ctx, vs)`（同一 `['wring', vsId]` 狀態、同一 rewind 分類），
`ta.stoch`、`ta.highestbars`、`ta.lowestbars` 的讀取改走環（掃描邏輯不動）。

| 指標（K55 100 根，`ta-hotspot.mjs`） | before | after |
|---|---|---|
| `ta.stoch` gets/bar | 38.1 | **6.2（−83.7%）** |
| `ta.highestbars` gets/bar | 36.5 | **3.1（−91.5%）** |
| `ta.lowestbars` gets/bar | 25.7 | **3.1（−87.9%）** |
| `ta.*` 總 gets/bar | 245.4 | **158.5（−35.4%）** |
| 其餘 14 支 | — | 完全不變 |

- **被否決的捷徑（留證）**：直接用 `winAgg` 的 deque index 取極值索引雖然更 O(1)，但 **NaN float 會破壞 deque「同值取最新」不變式**（NaN 永不被 pop，front 可能停在較舊的同值）→ probe `nan` 模式量到 **55/60,000 不一致** → 退回「環讀取 ＋ 原掃描」，換得逐位元等價。
- 等價證據：`scratch/perf/r3-ta-probe.mjs`（34 keys：5 模式 × 2 seed × {forward／亂序／身分 churn} ＋ 4 支真腳本 e2e）before/after **逐位元相同**；獨立重寫的「改前演算法」與 builtin 逐 bar 比對 **60,000 次 0 mismatch**；bench digest 四支逐字相同（`ze7byn`/`kb0glc`/`1580h2`/`p4gddl`）＋ `modelsMatchAcrossPaths` 全 PASS；全套 954 passed；`tsc` 0。
- **邊界（重要）**：`run ms` 本窗 NOISY、方向不一致 → 不作證據；`ta_self_ms` 持平（每次呼叫被固定成本 ~23–26 µs/call 支配）。
  **TRIS390／MACD701 完全不呼叫本片改的三支 builtin** → 兩支的 ta.* gets/bar 逐項不變（gets/call 全 ≤4）
  ⇒ **Round-3 的 A3 缺口不在 `ta.ts`，只能靠 MTF 每次 eval 單位成本（R3A）與 per-node 成本（R3B）**。
- 下一片候選（K55 專屬，未動）：`ta.mfi` 39.3、`ta.pivothigh/low` 18.0/10.8、`ta.cci` 11.2、`ta.vwma` 7.4。

**R3A `mtf.ts` — 已落地（5 處；淨 +45）**：
`tfToMs`/`tfParts` 記憶化（每 chart bar × spec 重跑 2 次 regex）；`tfOwned` ＋ `tfDirty` 併成單一 `tfSeries` WeakSet（讀取路徑原本是 OR）；
`evalAt` 路由判定記憶化（`spec.verdicts: Map<Node,1|2|3>`，**gatePass/gateFail/prodWalks 計數不變**）；
`tryEvalSecurity` 的 `emit`/`emitAll` 閉包提升為模組級（每個 (spec, chart bar) 少 2 個閉包 ＋ 2 次 `__name`）；`ensureTfFrame` 守衛內聯。
- 量到的熱點：每次 `evalAt` 的 gate 開銷 **1,662 ns/call**（`WeakSet.add` 375–625 ns vs `has` ~25 ns vs `Set.has` ~60 ns）→ 100 根 14,678 calls ≈ 24 ms、500 根 20,902 calls ≈ 35 ms。
- **關鍵事實**：`evals` **幾乎與 chart 根數無關**（100 根 2,922 vs 500 根 2,903）→ mtf 成本由 **requested series 長度**驅動，不是 chart bar。
- **明確的天花板**：mtf 在 500 根 app 路徑只佔 ~650–700 ms／3,765 ms（≈18%），其中 ~52% 是 requested series 的**歷史重播**（`FETCH_WARMUP`，`var`／有狀態 `ta.*` UDF 必須跑；減掉會改值）→ **mtf 膠水層上限 ~55–75 ms（1.5–2%），不足以補 TRIS390 的 305 ms**。
- counters 逐項相同、digest 逐字相同（`ze7byn`/`kb0glc`/`1580h2`）、golden 0、954 passed、tsc 0。

**R3B `interpreter.ts` — 已落地（6 處）**：`runOf` 加 last-ctx 單筆 memo；`udtMethodAt` key 改兩層 Map；`bindCallArgs` 的 `noHist` 提升為模組函式（＋ for 迴圈取代 `some`）；
刪除 **write-only** 的 `siteStack` 字串陣列（全 repo 無讀者）；`evalCall` 把 `run` 傳進 dispatch；`NOT_SECURITY_CALL` 跳過已被回答 `null` 的 Call node（與 `mtf.ts`「null ⟺ !isSecurityCall」跨檔不變式相依，**已在碼內註明**）。
- profile：`interpreter.ts` self **56.65% → 51.67%**（方向）；`runOf` 469→17 ms、`udtMethodAt` 410→33 ms、`bindCallArgs` 302→67 ms（同名函式 self，取樣器抖動大）。
- 決定性單位成本 × 實際次數（100 根 K55 一趟）：`runOf` 16.46→7.23 ns × 839,575、`udtMethodAt` 139.4→23.5 × 4,297、`bindCallArgs` 49.5→30.4 × 9,628、site push/pop 10.47→7.11 × 58,496 → **合計 ≈8.6 ms/趟 ≈0.8%**（量級誠實地小）。
- 500 根 counters/digest 與 Round-2 baseline **逐字相同**；golden 0；954 passed；tsc 0。

### Round-3 總結與 A3 判定（500 根，`app` 路徑）

| 腳本 | baseline | R1 | R2 | **R3** | R3 vs baseline | ms/bar | 內容 digest |
|---|---|---|---|---|---|---|---|
| **app K55** | 12,946.9 | 8,373.2 | 5,538.8 | **4,611.0** | **−64.4%** | **9.22** | `sxamcl`＝baseline |
| TRIS390 | 6,923.8 | 5,502.0 | 3,765.4 | 4,010.3 | −42.1% | 8.02 | `3huclf`＝baseline |
| MACD701_v72 | 1,501.9 | 1,382.8 | 931.1 | 996.3 | −33.7% | 1.99 | `18qepy0`＝baseline |
| final | 27.3 | 39.5 | 36.8 | 42.6 | 噪音 | 0.09 | `1kzvcjg`＝baseline |

**四支腳本的 model 內容 digest 三輪後全部仍與 baseline 逐字相同** → 優化零行為變化（這是本工作最強的驗收證據）。

**量測變異（同一棵樹連跑兩次，`--repeat 5 --warmup 2`）**：TRIS390 app median **3,120.5** vs **3,416.9（+9.5%）**，
單次內 min–max 2908–3886（±17%）；MACD701 859.7 vs 865.2（+0.6%）。
⇒ R2→R3 在 TRIS390 的「+6.5%」**落在同樹變異內 → 不是回歸**。
⇒ 但也代表：**TRIS390 的 A3（目標 3,460）在目前的量測環境無法穩定判定**（median 有時 3,120 ＝過、有時 4,010 ＝不過）。
**K55 的 repeat-5 精算另計（`bench/pine/k55-r5.json`）。**

**A3 判定（門檻：各腳本 total 相對 baseline 降幅 ≥50%）**

| 腳本 | 目標 | 實得（median） | 判定 |
|---|---|---|---|
| app K55 | ≤6,470 ms | **4,611.0（repeat 5 見下）** | ✅ **大幅達標** |
| TRIS390 | ≤3,460 ms | 3,120–4,010（跨跑變異 22%） | ⚠️ **無法穩定判定** |
| MACD701_v72 | ≤750 ms | 860–996 | ❌ 差 13–25% |

**結構性原因（R3A 實測，非實作疏漏）**：TRIS390／MACD701 的成本由 **requested series（tf 域）的求值**驅動 ——
`evals` 幾乎與 chart 根數無關（100 根 2,922 vs 500 根 2,903），其中約 **52% 是 `FETCH_WARMUP` 的歷史重播**
（`var`／有狀態 `ta.*` UDF 必須跑，**減掉就會改值**）→ mtf 膠水層上限僅 ~55–75 ms（1.5–2%），
不足以補 TRIS390 的 305 ms 缺口。要再往下只能動**暖機語意**（禁區）或 tf 域的 per-node 成本（每項約 1%）。

**待使用者裁決（驗收變更）**：A3 是否維持「每支 ≥50%」，或改為
**K55 ≥50%（已達 −64%）＋ TRIS390 ≥40%（實得 −42%）＋ MACD701 ≥30%（實得 −34%）＋ 四支 digest 不變**。

## P8 Code Review（3 reviewer：正確性＋Behavior／安全／可維護性＋Standards＋Spec；UI 軸跳過＝本次未動界面檔）

### 可維護性／Standards／Spec 軸（CRMaintainability，2026-10-15）

**F1【Important｜對應 spec A7】** 同一個「series 身分 churn」問題現在有**兩套方向相反**的規則，且互相抵消：
- 規則 A（`interpreter.ts:387-398`）：`SiteSeries extends ForwardingSeries`，讀取經 `readTarget()` 轉到**當前 inner**，但**交給身分鍵的識別碼是 per-site 穩定**的（S8 的成果）。
- 規則 B（`ta.ts:139-141` `readSeries()`，用於 `ta.ts:185-186` 及 `:660/:911/:1586/:1785`）：對 `ForwardingSeries` 做 **8 跳 `readTarget()` 走到 inner** → 對被 `SiteSeries` 包過的引數，**把規則 A 刻意給的穩定身分丟掉**，落到每 bar 新生的 inner（`math.ts:29`）。
- 同一檔的 `CONST_SERIES`（`ta.ts:57-60`）卻刻意用**未經** `readSeries` 的 raw 物件 → 同一物件兩處主張相反。
- 反向也成立：`x = math.min(cnt+1,10)` 走 ident 快徑（不包 wrapper），其 `CowSeries.readTarget()`（`interpreter.ts:292-293` `return this.cow ?? this.inner`）**不**保持同一物件 → 規則 B 註解所稱的前提在此不成立。
- **Parent 複核：宣稱成立**（已逐行讀 `ta.ts:139-145`／`ta.ts:55-62`／`interpreter.ts:385-400`／`interpreter.ts:288-296`／`series.ts:600-606`）。
- 影響：**不改變數值**（規則 A 保證讀值正確）→ 屬**潛在未修完的效能**（被包過的引數仍每 bar 重建 state ⇒ O(L) 重掃）＋ convention 衝突。四支受測腳本量不到（K55 的 churn arg 是 length，走 `constNum`/`CONST_SERIES`）。
- 正確規則應是「**取穩定的一端**」——兩份實作都沒有這條。

**F2【Important】** `constSeriesNum`（`ta.ts:64-69`）的新註解只寫 memo 語意，未寫**跨檔效能前提**（鍵物件必須跨 bar 穩定；由 `interpreter.ts:379-397`＋`evalArg:1623-1625` 提供）→ 日後任一次「識別碼改走 `readSeries`」或 ident 快徑變動，都會**靜默退回 O(bar) 重掃**（正是 S8 修掉的二次項），碼內無警語。

**F3【Minor】** `NOT_SECURITY_CALL`（`interpreter.ts:1329-1339`）的跨檔不變式只在單邊註明；`mtf.ts:1960`（唯一 `return null`）那端沒有反向註記 → 日後新增第二個 null 出口會讓該 Call node 被永久跳過。建議反向註記或守衛測試。

**F4【Minor】** 同一 hop-walk 寫兩份（`series.ts:603-604` 與 `ta.ts:139-140`，連上限 `8` 都相同）→ 該 primitive 應只有一份（`ForwardingSeries`/`readTarget()` 就在 `series.ts:570-571`）。

**F5【Minor】** 同一快取政策三個命名家族：`TF_MEMO_MAX=512`（`mtf.ts:57`）vs `PARTS_MEMO_CAP=4096`（`tz.ts:51`）vs `modelCache` 的 `MAX_ENTRIES`。

**核證為「非 finding」（負面宣稱已驗）**：`siteStack` 在 `src/**` **0 命中** → 刪除乾淨；`tfOwned`/`tfDirty` 合併後無殘留讀者；`udfJitEnabled` 無殘留呼叫端；
`invCache`/`invVerdicts`/`verdicts` 全在既有 `evalAt` 內並沿用 `agnosticCache` 的 snap/restore；`winRingReader` rewind 由 `interpreter.ts:3312-3330` 分類器覆蓋；
新計數走既有 `__mtfStats`；diff 未新增任何 `__` 名；`reg(name,fn,hist)` 未被觸碰；`CellSeries` 的 dispatch 點（`freezeReader`/`histGetAt`/`evalReassign`/`incSnap`）完整。

**Spec 軸缺口（由 reviewer 列出，Parent 確認）**：**A4 完全沒量**（優化後無 1000 根量測）、**A5 只到 harness 層**（無實機瀏覽器量測）、**A3 兩支未達**、A6 待裁決、harness H2 重複性 FAIL。

### A4 補測（2026-10-15，真實 1m 資料 `--fetch-bars 5500 --tf 5`）

| 腳本 | 500 根 median | 1000 根 median | 實際/線性期望 | SUPERLINEAR |
|---|---|---|---|---|
| app K55 | 6,646.5 | 12,562.2 | **0.950** | no |
| app TRIS390 | 4,731.7 | 8,571.9 | **0.910** | no |
| app MACD701_v72 | 1,191.7 | 2,433.7 | **1.020** | no |
| （direct 三支） | — | — | 1.000 / 1.040 / 1.090 | no |

→ **六組全部無超線性訊號**（比值 0.91–1.09；S7 移除的二次項不再出現）⇒ **A4 判定通過**（≤2.2 且相對 baseline 未上升）。
註：此批用真實 1m 重採樣資料，與 500 根 fixture 的絕對值不可直接比（ratio 才是量測標的）；
另 app vs direct 在 500 根時 K55 30.6%／MACD 26.0% 標 FAIL、1000 根時降到 18.7%／18.6% PASS → 屬小樣本噪音（H3 為 medians 比較）。

### 安全軸（CRSecurity，2026-10-15）

**S1【Important｜有實測證據】** 「來源身分 churn ＋ 長度成長」時 **`wring` ring 表每 bar 新增一張 ring → Θ(bars²) 記憶體**。
- 位置：`ta.ts:376-377`（`stateFor(ctx, ['wring', vsId(vs)], …)`）。
- 觸發：（a）來源 series 物件每 bar 重建 —— **正是本 patch 為此引入的 `SiteSeries`／`stableArgSeries` 案例，但 `ta.ts:140` 的 8 跳 hop-walk 會把它還原成每 bar 新的 inner** ⇒ `seriesId(t)` 仍每 bar 變動；（b）長度隨 bar 成長（`math.min(cnt+1,10)`／`cnt+1`）。
- 實測（120 根，probe 在系統 temp）：`ta.sma(math.max(close,open), cnt+1)` → ring 119 張 / entries **7,140（≈bar²/2）**；對照 `ta.sma(close, cnt+1)` → **1 / 119**（既有表仍線性）。
  → 舊碼是 O(L) 時間 / O(bars) 記憶體；本 patch 把它變成 **O(bars²) 記憶體**（5000 根估 ≈1.2×10⁷ entries）。同一 patch 已為 tf 字串表設 `TF_MEMO_MAX`，此表卻無上限（不對稱）。
- 建議修法：同一 table 形狀加 `WIN_RING_MAX = 512` ＋ clear-on-full（`clear()` 只影響共享，已取用者的 `rd` 仍持有自己的 Map ⇒ 語意不變）。confidence 0.8。
- **與可維護性 F1 同源**（身分規則互相抵消）→ 兩軸獨立收斂到同一根因。

**S2【P3】** `interpreter.ts:210-214` 的 `lastCtx`/`lastRunState` 模組級**強引用**會把上一個被丟棄的 session 留到下一次 `runOf` 換手（延後釋放、非累積；但 5000 根的大型資料期間可觀）→ 建議把 RunState 掛在 ctx 自身。

**核證為「非 finding」**：`NOT_SECURITY_CALL` 不變式（`mtf.ts:1960-2157` 唯一 `return null` 在 `:1961`）✓、`tfInvariant` cycle 防護等價（memo 只在返回後寫）✓、
`tfSeries` 合併等價 ✓、`siteStack` 確為死碼（`git show b9fcd81` 無讀者）✓、`invCache` 不共享 mutable/series ✓、`verdicts` 不清除屬正確（AST 級判定）✓、
`CellSeries` 所有子類分派消費點完備 ✓、無跨 run 狀態洩漏（除 S2 的單筆延後釋放）。

### 正確性＋Behavior 軸（CRCorrectness，2026-10-15）

以 `git archive b9fcd81` 與工作樹做**雙樹差分探針**跑 40+ 形狀（MTF 路由、`freezeReader` 家族、vwma/stoch/highestbars、SiteSeries churn、CellSeries loop/UDF、NaN tape、incRun tick、MTF tick）。
**結論：無 P0/P1 正確性缺陷。** 硬性不變式逐條成立（`tfSeries` 三處 add 站點等價、`runStates` 全檔只有一處 `set`、`udtMethodAt` 只會更精確、`siteStack` 確為死碼、`CellSeries` 與被取代的 `BarSeries` 在 `rAt/rLen/peek/get/capN/materialize/incSnap/incRewind` 逐項等價）。

| # | 發現 | 等級 |
|---|---|---|
| C1 | `mtf.ts:1838-1851` verdict-3 分支**未先讀 `nodeCache`**（verdict-2 在 `:1867` 有讀）→ series/mutable payload 每次 `evalAt` 重算、`spec.cw` 累積不回收。可達性未證（探針顯示多數情形被 `evalIdent` 展開成純量；只有 arraylit-producer 才落到該分支） | P3 |
| C2 | `ta.vwma` 改 Kahan 補償滑動和後**不再逐位元相同**：`p@6` 舊 `105.54932822978434` vs 新 `105.54932822978432`（rel≈2e-15），在 golden 容差 1e-9 內、golden 無 vwma plot → **非缺陷**，但「輸出不得改變」若以逐字元 digest 判定會不一致（建議 spec 明列容差例外） | 氣味 |
| C3 | `ta.ts:376-383` `winRingReader` 只擋 `i<0 \|\| i>ctx.barIndex` → **forming bar 的非 na 值會被凍結**；同一 bar 稍後改寫來源時，同 callsite 同 VS 的重入可能讀到首讀值。三種自然形狀實測皆 SAME、共用面窄 → 氣味 | 氣味 |
| INFO | 探針顯示 patch **修好既有錯誤**（值得寫進 PR/changelog）：(a) `s=input.source(math.min(close,open),"S")` 後的 `ta.sma`/`ta.cum` 舊為全 na／每 bar reset，新為正確值；(b) **live tick**：同 tf 的 `request.security` 在 forming bar 重評時，舊 `incRun` ≠ cold（1019.8 vs 1020），新兩者一致 → 使用者可見 tick 值**改對**。責任 hunk **未定位** | INFO |

證據缺口：live-tick 改變的 hunk 未 bisect；`run.argSites` 不在 `IncCkpt` 快照面（靠下次重評自我修復）；NaN 例外流未窮盡；效能面不作判定。

### JEV 分級與去重（受管管道 `taskwf-review`，2026-10-15）

| 發現 | 分級 | 信心 |
|---|---|---|
| F1 身分規則互相抵消 | **Important** | 0.92 |
| S1 `wring` 表 Θ(bars²) | **Important** | 0.81 |
| F2 跨檔前提未註明 | **Important** | 0.87 |
| C1 verdict-3 未先讀快取 | **Important** | 0.64 |
| C2 vwma 1 ulp | Minor | 0.99 |
| C3 forming-bar ring latch | Minor | 0.96 |
| S2 模組級強引用 | Important（**信心僅 0.33 → 升級主 LLM，Parent 判 Minor**） | 0.33 |
| F3/F4/F5 | Minor（併入修正輪順手處理） | — |
| **去重**：F1 ∩ S1 = **同一根因**（noul 0.79）→ 以**一個修法**解決 | | |

**修正輪（P6 Round-4）已開**：R4A 修 F1＋S1（`ta.ts`＋必要時 `series.ts`；「取穩定的一端」＋ `WIN_RING_MAX` 上限）；R4B 修 C1（`mtf.ts`）＋ S2/F3（`interpreter.ts`）。修正後依工作流要**回歸＋再審**。

### P6 Round-4（P8 修正輪）

**R4A — F1＋S1（＋順手 F4/F2）已落地**（`ta.ts` md5 `abdc93b1…`、`series.ts` md5 `3c486dfd…`）
- `series.ts`：`ForwardingSeries` 新增 `bind?(inner)` 契約宣告（**宣告 `bind` 者＝per-site 身分錨，自己是穩定端**；未宣告者穩定端在其 target）＋ 唯一實作 `walkForwarding()`（8 跳）＋ 匯出 `stableSeries()`；`freezeReader` 改用同一 walk ⇒ **F4 的重複 hop-walk 收成一份**。
- `ta.ts`：刪除 `readSeries()`，5 個身分鍵（`vsOf`/`emaTag`/`cum`/`vwap` anchor/`srcKey`）改走 `stableSeries`；`seriesId` 上寫明跨 bar 穩定契約與跨檔依賴（**F2**）；**S1**：`WIN_RING_MAX = 512` ＋ `wring` 外層表改用 `TF_MEMO_MAX` 的既存形狀（滿則 `clear()`，純快取故值不變）。

| 探針（120 根，`scratch/perf/r4-f1s1-rings.mjs`） | before | after |
|---|---|---|
| `ta.sma(math.max(close,open), cnt+1)` ring 張數 / entries | **120 / 7,260（Θ(bars²)）** | **2 / 121** |
| 同上 `gets/bar` | 60.5 | **1.01** |
| `ta.sma(math.max(close,open), 10)` | 120 / 1,155 | 2 / 121 |
| `ta.sma(close, cnt+1)`（對照，無 churn） | 1 / 120 | 1 / 120 |
- 240 根複測：rings **2** / entries **241** / gets **241** → **線性、有界**。
- 語意：四支腳本 app+direct digest 與 R3 狀態**逐字相同**（`ze7byn`/`kb0glc`/`1580h2`/`p4gddl`）、counters 逐項相同、golden **0 差異**、`src/pine` **954 passed**、`tsc` 0。

**R4A 回報的殘留（待裁決／列管）（2026-10-16 註：殘留已結案，見下 T12 判定表）**：
1. `wvs` 表以 `L` 為鍵：**無上限成長的 L** 會每 bar 建一個 winAgg state（240 根 = 240 個，deque 1,871 → 4,483 ≈ O(bars·log bars)）——**與本次修法無關、屬既有設計**（S9 當時只用飽和 L 量測）→ **P6 R5 已收（2026-10-15）**：`ta.ts` 新增 `WIN_LEN_MAX = 64`（clear-on-full，per `(kind, source-VS)` 群）；240 根 growL 240 → **64** states、`ta.highest` deque **4,483 → 1,891**、10 個 shape 逐值（含 na）**0 差異**、K55 `gets/bar` Σ **158.5 不變**、四支腳本 digest 逐字相同、golden 0 差異。~~**同型未收**：`dvs`(ema/hma) 與 `stv`(rma) 仍以 len 為鍵無上限（240 根各 240 states／28,920 memo，量級更大）。~~ → **R5 已收（T9；見下 T12 判定表 T9）**。
2. `clear()` 與 rewind 交互：`restoreCtxState` 對 structural map 只刪不補 → clear 後回滾由下次使用重建（純快取 ⇒ 值相同），無專屬測試，靠既有 incremental/golden e2e 覆蓋。
3. ~~`bind` 是**結構性契約**（非 `instanceof`，避免與 interpreter 成環）→ 日後若其他 wrapper 也加 `bind` 會被誤判；建議後續改顯式宣告。~~ → **R5 已修（改顯式 `siteAnchor`：`series.ts:600`＋`:634-636`＋`interpreter.ts:416`）**。
4. 同一 arg site **跨 bar 換不同來源家族**（`cond ? math.max(close,open) : math.max(high,low)`）未建 probe → 未驗證角落。

**R4B — C1（可達性已證）＋ S2 ＋ F3 已落地**（`mtf.ts` md5 `9f07ff90…`、`interpreter.ts` md5 `97775c87…`）
- **C1**（`mtf.ts:1848-1854`）：verdict-3 在 `computeAt` 前補上 verdict-2 同款 per-caller 讀取（`hits++` 與 verdict-2 的 mutable 讀法一致，不動 `agHits`/`invHits`）；docstring 與 routing 註解改寫（原文「j-keyed paths 永遠看不到 verdict-3」已被 mutable/series carve-out 推翻）。
  **可達性實測**（`scratch/_r4c1-probe.mts`，96 根 15m chart／tf 60）：**tf-invariant 但值為容器**的節點（ternary／巢狀 array）確實可達 → `true ? [1,2] : [3,4]` 由 **93 evals / 0 hits → 23 / 70**；`[[1,2],[3,4]]` 186/0 → 46/140。
  **修正 reviewer 措辭**：頂層 arraylit **不會**落到該分支（會被切成逐元素純量 part-node）。
  live session：單場 96 根 cw write-log 189 → 119 推入、evals 93 → 23（同階，非二次）。
- **S2**（`interpreter.ts:201-254`）：刪 `runStates` WeakMap ＋ 兩個模組級強引用，RunState 改掛 ctx 自身的 **non-enumerable symbol** 槽（**刻意** non-enumerable：`{...ctx}` 不得繼承，維持與 WeakMap 相同語意）→ 隨 ctx 死亡。
- **F3**：`mtf.ts:1968-1981` 加反向契約 JSDoc ＋ 行內註記（以符號名互指）。
- 驗收：A/B 隔離 bench（R4A 檔固定）四支腳本 counters/digest **完全相同**；golden 0 差異且未寫 golden 檔；`tsc` 0；`src/pine` 三次全綠（954 passed；06:17 曾單次紅燈、同 hash 樹重跑即綠 → 判 flaky，**Parent 於最終凍結樹再驗**）。
- 殘留：`spec.cw` 的「每 distinct (node,caller,j) 一筆」未上限化（僅增量路徑，量級與 evals 同階）。

**本輪總 diff（相對 `b9fcd81`）**：`ta.ts +185/−?`、`interpreter.ts +315/−?`、`mtf.ts +253/−?`、`series.ts +219/−?`（4 檔、合計 +806/−166）。

## P9 交付（2026-10-15，等再審收尾後定稿）

### 交付物

| 類 | 內容 |
|---|---|
| 工具 | `scripts/perf/pine-bench.mjs`（＋`lib/**`、`README.md`、`fixtures/bars-5m-mxf-500.json`） |
| 結果 | `bench/pine/*.json`（43 檔：`s12-clean1`＝baseline、`s12-round{1..4}`、growth、各切片 A/B） |
| 計畫/證據 | `docs/2026-10-14-pine-perf-align.md`（P0 需求與 A1–A8、P1 拆解、P2 三軸、P3 卡點、P5 切片表、P6 Round-1–4、P8 review、本節） |
| 記錄 | `PROGRESS.md` 的 S12（開啟/收工）與 S13（Round-1–3）條目 |
| 探針（保留） | `scratch/perf/`：`ta-hotspot.mjs`、`s7-freeze-reader.mjs`、`s9-value-probe.mjs`、`r3-ta-probe.mjs`、`r4-f1s1-rings.mjs`、`repro-*.pine`、`app-scripts/script-a1dcdea6-95114.pine`（真實 app 版 K55） |
| TV 逆向分析（保留） | `scratch/tv-recon/{README.md,chunk-map.md,downloads.md,_*.json}` |

### 清理（已執行）

刪除 **TV bundle/chunk 原始下載（91 MB，可由 `_loaded-js.json`／`_chunkmap.json` 重抓）** 與所有**引擎複本**（`s11-emul/pine`、`s11-golden/*-pine`、`s8s10/{frozen,nob,s10only,paired}`、`prof/before-pine`、`_r4c1-ab`）→ `scratch/` 由 ~120 MB 降至 **23 MB**。`src/**` 未動。

### 驗收現況（凍結樹 `b9fcd81..worktree`，4 檔 +806/−166）

| 條 | 狀態 |
|---|---|
| A1 全測綠 | ✅ `src/pine` **62 檔 / 954 passed / 1 skipped**＋`tsc --noEmit` 0 |
| A2 golden 0 差異 | ✅ **14 passed / 1 skipped**，且未寫任何 golden 檔 |
| A3 效能 | **K55 −61.9%（12,946.9→4,928.6 ms）✅；TRIS390 −53.0%（→3,251.6）✅；MACD701 −42.8%（→859.2）❌**；final 噪音 |
| A4 成長倍率 | ✅ 六組 0.91–1.09（無超線性） |
| A5 實機載入 | ⏳ **未量**（需 Vite＋app 環境跑瀏覽器載入；等使用者決定是否做） |
| A6 TV 對齊 | ⏳ 原條目不可量測（TV 無客戶端 runtime）→ 待裁決 A6'／A6''／取消 |
| A7 未造第二套 convention | ⚠️ review 曾判 F1 違反（身分規則兩套）→ **Round-4 已統一**（`stableSeries` 一份 primitive） |
| A8 無行為漂移 | ✅ 四支腳本 model 內容 digest 與 baseline **逐字相同**；例外：`ta.vwma` 改用 Kahan 後 rel≈2e-15（在 golden 容差內，已記錄） |

### 遺留（明列，不隱藏）

1. **MACD701 −42.8%**：差門檻 12.7%（約 110 ms）；其成本仍集中在 MTF 每次 eval（evals 4,509）→ 需再一輪或改門檻。
2. **A5 未量**（實機瀏覽器載入）。
3. **A6 已改寫定案**（增量 tick 預算：每 tick ≤100 ms 且 增量 ≤ 冷載入 ÷10）；K55 55 ms ✅、TRIS390 107 ms ⚠️ 邊緣 → 安靜機複測（autorun T4）。
4. **harness H2 重複性**：本機非靜機 → 未通過；A3/A4 的「最終蓋章數字」建議在靜機複測。
5. ~~`wvs` 表以 L 為鍵：無上限成長的 L 為 O(bars·log bars)（既有設計，非本輪引入）~~ → **R5 已收**（`WIN_LEN_MAX = 64`）；~~同型 `dvs`/`stv` 仍列管。~~ → **R5 已收（T9）**。
6. `spec.cw` 每 (node,caller,j) 一筆、無上限：**tick 路徑** ≤ 一根 bar 的寫入數（23–51 實測），但**冷載入是 O(history)**（`interpreter.ts:3768` 從 bar −1 就開著；100 根 4,717 筆、5000 根 ≈23 萬筆 [推論]）~~→ 已排入 T6 打點 ②；`cwPeak` 欄位是壞的（max 的差值，恆 0）~~ → **R5 已收（P5／T6②）**：原 patch 下架（刪唯一建立點 ⇒ 冷載入 TypeError），等效修法另路落地（`interpreter.ts:107/110/3740/3757`、`mtf.ts:2394`／`:2415`／`:2422`；見下 T12 判定表 P5）。
7. C2（`ta.vwma` 1 ulp）、~~C3（forming-bar ring latch）~~ → **R5 已修（`ta.ts:478`＋`wring_latch.test.ts`）**、~~`bind` 結構契約誤判風險~~ → **R5 已修（`series.ts:600`＋`:634-636`＋`interpreter.ts:416`）**、同 arg site 跨 bar 換來源家族未驗證。

### P7／P8 判定（2026-10-15）

**P8 → Critical/Important 歸零**：三視角＋四軸 review 後，4 個 Important（F1 0.92／S1 0.81／F2 0.87／C1 0.64）**全部修正並經再審複驗**；
再審結論「四組修正全部修好、**未發現修正引入的新缺陷**」；S2 由 Parent 判 Minor 但已順手修、F3 已補註記、F4 已合併 primitive。
Minor 列管：C2（`ta.vwma` 1 ulp）、~~C3（forming-bar ring latch）~~ → **R5 已修（`ta.ts:478`＋`wring_latch.test.ts`）**、F5（命名三家族）。
~~限制列管：`wvs` 以 L 為鍵在無上限成長 L 時 O(bars·log bars)、`spec.cw` 每 (node,caller,j) 一筆未上限。~~ → **R5 已收**（`wvs` 見 `WIN_LEN_MAX = 64`／T9；`spec.cw` 見下 T12 判定表 P5：原 patch 下架、等效修法另路落地）。
再審另列 4 項「無法靜態確認」（`WIN_RING_MAX` clear×rewind 無專屬測試、同 arg site 換來源家族未驗證、`hits` 守恆由差額推得、`LiftedSeries` 不變式未重跑）。

**P7 三條判據**：① 全測綠 ✅（954 passed、golden 0 差異、`tsc` 0）② A1–A8 逐條：A1/A2/A4/A7/A8 ✅、A3 **2/3 支達標**、A5 未量、A6 待裁決 ③ 無新發現 ✅（review 與再審皆未發現新缺陷）。
→ **尚未完全收斂**，卡在使用者三個裁決（A3 門檻／A5 是否量／A6 改寫）。

**受管 JEV 全程結果**：`taskwf-verify` 6 條 0.79–0.94（全過）；`taskwf-blocker` TV 延後 1.00／舊 harness 缺欄 1.00（皆 risk）；
`taskwf-review` F1 0.92／S1 0.81／F2 0.87／C1 0.64（Important）、C2 0.99／C3 0.96（Minor）、S2 0.33（升級主 LLM → Minor）、**F1∩S1 同源 0.79**；
**`taskwf-accept` A7 0.80 ✓、A8 0.87 ✓**。

### 最終 A3 複測與 A5 嘗試（2026-10-15，負載 34%，`--repeat 5 --warmup 2`）

| 腳本（500 根 app） | baseline | 最終複測 median | min–max | 降幅 | 判定 |
|---|---|---|---|---|---|
| app K55 | 12,946.9 | **5,041.3** | 4,171.7–5,876.4 | **−61.1%** | ✅ |
| TRIS390 | 6,923.8 | **3,540.7** | 3,061.7–3,633.3 | −48.9% | ⚠️（前一輪 3,251.6＝−53.0%；**跨跑變異使其貼在門檻上**） |
| MACD701_v72 | 1,501.9 | **829.8** | 808.3–1,163.4 | −44.8% | ❌ |

**A5（實機瀏覽器載入）嘗試結果**：Vite（`localhost:5173/vela`）＋ 管理 Chromium 開啟 app **成功**（title 正常、`indicators = ['native-1']`、控制組 boot 66 ms）→ **優化後的引擎在真實 app 內可正常開機與渲染**（這本身是變更路徑的煙霧驗證）。
但**自動化「重腳本還原路徑」未觸發**（把 workspace blob 寫回 `localStorage['vela-workspace-v2']` 後重載，4.5 分鐘內 `__pineRunLog` 仍為空、indicators 仍只有 `native-1`）→ 本輪**未取得 A5 數字**。
建議：A5 由使用者直接開 `http://localhost:5173/vela` 用眼睛比（Vite 服務已留著），或以「同一支腳本、同一台機器、優化前後各一次」的手動量測為準；自動化版本的既有前置條件（parked-pine 機制）需另查。

### A5 實機量測（2026-10-15，成功）

**方法**：Vite（`localhost:5173/vela`）＋ 管理 Chromium。關鍵是 app 的 **parked-pine 機制**：boot 時會把含 `request.security` 的
`ext['opencharts.pine-scripts']` 條目**剝離並存到** `localStorage['vela-workspace-v2.parked-pine']`，之後**在 idle 時延遲還原**。
（先前兩次失敗就是只塞了 `vela-workspace-v2` 而沒塞 parked 條目。）

**結果（優化後，真實 app 路徑）**：
- `__pineRunLog` = `[{ bars: 500, ms: **9,919** }]`（引擎實跑）
- 圖上指標清單 = `['native-1', 'k55']` → **重腳本確實被掛上並跑完**；parked 條目已被消耗（`"[]"`）
- 從導航到取得該筆 log 的總牆鐘 = **42.5 s**（含 boot、行情抓取、worker 暖機、引擎執行）

**兩個意義**：
1. **變更路徑的實機煙霧驗證通過**：優化後的引擎在真實 app（dev build）內可正常載入並跑完 95 KB 腳本。
2. A5 的**「優化前」對照仍缺**：要取得必須把 `src/pine` 暫時回退到 `b9fcd81` 再量一次——**但 Round-5 代理正在改 `interpreter.ts`/`mtf.ts`，不得動 `src/pine`** → 這步排在 Round-5 收尾後執行（方法已備妥：備份 4 檔 → 回退 → 用同一招量 → 還原 → 驗 md5）。

### Round-5（S1 增量支援 strategy/security ＋ `wvs` 上限；2026-10-15 08:45）

**S1（`interpreter.ts` ＋ `mtf.ts`）：`incRun` 增量對全部腳本合格**（原「非 strategy」限制移除）
- 移除 `incEligible`（`interpreter.ts:3645-3651`、`:3766-3774`，函式刪除）；`IncCkpt` 納入 **`argSites`**（`:3261`，reviewer 缺口 1 已收）＋新增 **`stateArrays`**（`:3263-3271`／`:3354-3361`／`:3389-3392`）→ `ctx.state` 的陣列葉（`strategy|orders`）進快照面（就地 `length=0`＋回填 clone，保留陣列身分）。
- **Parity（`scratch/perf/s1-inc-probe.mjs`，100 根＋6 tick，`--commit 3`）**：逐值比對 plots（含 na）／drawings（line/box/label/table 逐鍵）／fills／bgcolors／barcolors／alerts／alertconditions／warnings／logs。
  | 腳本 | parity | live vs cold 每 tick | ratio | evalNodes |
  |---|---|---|---|---|
  | TRIS390（strategy ＋ 29× `request.security`） | **6/6 逐值相同** | 107 vs 1,089 ms | **10.9×** | 4,593 vs 246,335（**1/54**） |
  | K55 app（indicator ＋ security） | **6/6 逐值相同** | 55 vs 1,083 ms | **26.8×** | n/a |
- 新資格＝**全部腳本**；仍退回全量的情形（`incAdvance` 回 `'fallback'`）：① tape 縮短 ② committed bar（含）之前的 prefix 被改寫 ③ session `dead` ④ `incKey` 不符 ⑤ `bars.length===0`。
- `engine.test.ts:359-386` 依 Parent 裁定更新**前提**（strategy 現在有 live IncLive ⇒ forming-bar tick 不再被跳過），斷言由 `runs 1/2/3` **收緊**為 **1/2/3/4**（非放寬；標題改 `… (skip exempted)`）。
- ~~**`spec.cw` 未加硬上限**。~~ 原以「證明有界」交付,但 **2026-10-15 的 MACD701 歸因審計推翻了「≤ 一根 bar」這個說法**:
  它**只對 tick 路徑成立**(實測 23/23/51/28/28/48 per tick);**冷載入路徑是 O(history)**——
  `incRunStart` 在 bar −1 就呼叫 `checkpoint()` 把日誌打開(`interpreter.ts:3768`),直到 bar N−2 那唯一一次 checkpoint 才清空(`:3690`,`mtf.ts:2380-2390`),
  故長度 ≈ 每根 26–45 筆 × 根數(100 根 ≈ 4,717;5000 根 ≈ 23 萬筆、暫存 ~10MB [推論]),
  且第一次 tick 的 rollback(`mtf.ts:2310-2316`)要逐筆走完整個 log ⇒ O(冷載入全部寫入)。~~**列為長歷史隱憂,已排入 T6 打點 ②。**~~ → **R5 已收（P5／T6②：`mtfTrimCw` 受界冷載入日誌，`mtf.ts:2415`）**
  附帶:~~量測欄位 `cwPeak` 是**壞的**(它取一個只增不減的 max 的「差值」⇒ 非首跑永遠報 0),不可用來讀單根 log 長度。~~ → **R5 已修（`mtfResetPeak`，`mtf.ts:2422`；探針改讀絕對值）**。

**S1 殘留風險（明列）**
1. **strategy 的 `ctx.state` plains 每 checkpoint 深拷貝**（`strategy|simCache.byBar`／`excCache`／`ddCache.equity`）→ **成本隨歷史長度成長、非 O(1)**；100 根不顯著，**5,000 根未量** ← 本輪最大未量化項。
2. ~~`cw` 無硬上限／無自毀保護（極端形狀未觀察到）。~~ → **R5 已收（P5／T6②：`mtfTrimCw`＋`mtfResetPeak`，`mtf.ts:2415`／`:2422`）**。
3. 僅驗 **100 根＋6 tick**；500 根長 tick 未驗；冷載入僅 100 根 indicative 對照（K55 −6%、TRIS390 −18%，噪音級、非 H3 協定）→ **無倒退訊號**。
4. ~~adaptive tick-skip 政策在非空 tape **實質不可達**（`engine.ts` 未動）→ 下輪決定移除或改由 `live.dead` 觸發。~~ → **T10 定案：已知、接受（行為不改）**（見下 T12 判定表 T10）。

**`wvs` 上限（`ta.ts`）**：`WIN_LEN_MAX = 64`（clear-on-full，per `(kind, source-VS)` 群，沿用 `WIN_RING_MAX`/`TF_MEMO_MAX` 形狀）。240 根 growL：states **240 → 64**、`ta.highest` deque slots **4,483 → 1,891**；10 個 shape 逐值（含 na）**0 差異**；K55 `gets/bar` 17 列**逐項不變**（Σ **158.5 → 158.5**）、K55 自身 states/entries **完全不變**（maxDistinctL＝9，7× 餘裕）。~~同型未收：`dvs`(ema/hma)、`stv`(rma)（240 根各 240 states／28,920 memo，量級更大）。~~ → **R5 已收（T9；共 12 站點，見下 T12 判定表 T9）**。

## Review 固定點

- `b9fcd8120fb6d5d3efca0e75372d6db53522c9e5`（`git stash create` 快照 = 本次優化前的完整工作樹狀態，含前一輪 K 棒修復的未提交改動）。
- P8 / code-review 用 `git diff b9fcd81` 取得「本次優化」的完整 diff；前一輪修復不算在內。
- 前一輪 K 棒修復已獨立交付並驗證，不併入本次 review 範圍。
- Rollback：本次改動全在 `src/pine/**`（+ `scratch/perf/**`），`git checkout b9fcd81 -- src/pine` 即可回到優化前。

---

## 遺留清單追加（2026-10-15 20:4x，R5 收尾）— T12 逐項判定

> 依 `docs/2026-10-15-r5-remaining-autorun.md` §T12 的驗收要求：不修就寫「已知、接受、理由」。
> 逐項取證見 `docs/2026-10-15-t12-small-items.md`、`docs/2026-10-15-r5-patch-design-notes.md`。

| 項 | 判定 | 理由／證據 |
|---|---|---|
| **C2 `ta.vwma` 1 ulp** | **已知、接受（不修）** | 現行 `ta.ts` 的 vwma 走 `ssumWin` 滾動窗＋Kahan 補償（`accAdd`），與舊 `ssumScan` 的差異實測 **rel ≈ 2e-15**（1 ulp 級）；**golden 無 vwma plot**，且 `scripts/golden/*` 對它 0 差異。修（改回 O(L) 掃描）＝用效能換零收益。 |
| **C3 forming-bar `wring` latch** | **已完成（修 1 行＋判別性測試）** | latch 原在 `winRingReader` 的 `if (i < 0 || i > ctx.barIndex)` 不早退，會把 forming 值鎖進 ring → 改 `i < ctx.barIndex` 才 `set`，已套 `ta.ts:478`（`if (i < ctx.barIndex && v !== undefined) ring.set(i, v);`）。判別性測試 `src/pine/__tests__/wring_latch.test.ts`（`ta.stoch` 1050→525）已存在且實跑綠（2 files / 4 tests passed）。 |
| **`bind` 結構契約顯式化（R4 F3）** | **已完成** | `series.ts:600`（`readonly siteAnchor?: true`）＋ `series.ts:634-636`（`stableSeries` 以 `siteAnchor` 判別）＋ `interpreter.ts:416`（`readonly siteAnchor = true as const`）；舊 duck-test 引用（`series.ts:615`）已失效（該行現為 `walkForwarding` 的 `}`）。 |
| **T9 上限覆蓋缺口** | **已補齊** | `bound2`（`ta.ts:293-300`，:297 `if (byInner.size >= VS_LEN_MAX) byInner.clear();`）已覆蓋 `kc-b:1516`／`kc-r:1519`；`vwma-pv:818-819`、`macd-l:1248-1251` 已帶 `VS_LEN_MAX`（`ta.ts:516`）。判別性測試**兩檔合跑**：`ta_state_bound.test.ts`（3 支）＋ `wring_latch.test.ts`（1 支）＝ **4 passed**（修前 FAIL → 修後 PASS）。另有 dmi 7 處站點（`ta.ts:1455`（`dmi+p`）／`:1463`（`dmi-m`）／`:1475`（`dmi-dx`）為 `bound2` 直接站點，`:1472`／`:1473`／`:1474`／`:1483` 才是 `rmaVsBound` 鏈）與 kc `hl-r`（`ta.ts:1511`）由 `bound2` 覆蓋，合計 **12 站點**。 |
| **T10 adaptive tick-skip** | **已知、接受（行為不改）** | 分兩段：(a)「非空 tape 成功路徑實質不可達」**成立**；(b)「全域死碼、可刪」**不成立**（`active` 只在成功路徑寫、`dispose()` 置 `incAlive=false`、`pineWorkerEngine.ts:42-47`）。測試實況更正：**skip 側亦有測試**（`engine.test.ts:361`／`:390`／`:415`，分支本體 `engine.ts:348`）⇒「skip 側零測試」之說不成立；結論仍為**行為不改**（`PROGRESS.md:712`）。 |
| **P3 (T8b) series registry 高水位剪回** | **已完成** | registry 高水位記於 `IncSnap`，rollback 時剪回：`interpreter.ts:3275`（`seriesCount`）／`:3532`（`seriesCount: s.seriesSet.size`）／`:3580-3581`（`:3580` 註解／`:3581` 逐個 `incRewind` 迴圈）／`:3589-3594`（剪回尾巴）。見 `docs/2026-10-15-omp-p2-p7-p10-notes.md:124`。 |
| **P4 (T11) per-caller 快取鍵** | **結案不做** | patch `scratch/perf/patches/r5-t11-callsite-cache-key.patch.WITHDRAWN-BREAKS-VALUES`（套用後值凍結 0.609）⇒ 撤回不改。見 `docs/2026-10-15-r5-autorun-report.md:86`。 |
| **P5 (T62) `spec.cw` 冷載入 ＋ `cwPeak`** | **原 patch 下架；等效修法已另路落地** | 原 patch 刪唯一建立點 ⇒ 冷載入 TypeError ⇒ 下架。等效修法落地：`interpreter.ts:107`／`:110`／`:3740`／`:3757`、`mtf.ts:2394`／`:2415`／`:2422`。 |

---

> 2026-10-16 digest re-baseline：script-a1dcdea6 的 digest 由 ze7byn → 1e63vl8（原因：C1＝array.includes/indexof/lastindexof/binary_search* 對被包成 series 的引數恆 false；該腳本 :1260 的去重 gate 修前失效導致同 bar 重複繪製，修後移除重複：lines 65→59）。其餘三支 kb0glc/1580h2/p4gddl 不變。另 golden 見高K4.55 已於同日 re-baseline（16 條＝tooltip 6＋textcolor 10）。
