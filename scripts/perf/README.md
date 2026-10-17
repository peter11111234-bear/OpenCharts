# pine-bench — Pine 直譯器分階段效能基準 harness

**規格正文**：`docs/2026-10-14-pine-perf-align.md` §「P5 REAL PLAN v1 — Pine 分階段效能基準 harness」。

這是 **A3／A4／A5／A6 的量測儀器**：先有儀器，才有門檻。它**只觀測，不改 `src/**`**，
也不引入任何新的引擎 API —— 底下呼叫的每個函式、每個計數器都是 repo 既有的公開介面。

| 項目 | 路徑 |
|---|---|
| CLI | `scripts/perf/pine-bench.mjs` |
| 模組 | `scripts/perf/lib/{pine,bars,counters,engines,report}.mjs` |
| 固定資料 | `scripts/perf/fixtures/bars-5m-mxf-500.json`（由 `scratch/_bars_mxf.json` 固化，兩者 md5 相同；原檔未動） |
| 結果 | `bench/pine/<label>.json`（`--out` 可改） |
| 本檔 | 跑法、欄位、判定規則、已知限制 |

---

## 1. 跑法

```bash
cd C:/Users/bear9/OpenCharts

# 單一腳本，兩條 engine path，3 次取 median，輸出 markdown 表
npx tsx scripts/perf/pine-bench.mjs \
  --script "C:/Users/bear9/high452/HIGH455/high452_phase3.pine" \
  --bars 500 --repeat 3 --md

# 多腳本 + 根數掃描（判線性／超線性）
npx tsx scripts/perf/pine-bench.mjs \
  --script src/pine/TRIS390.pine --script final.pine \
  --scale 100,200,500 --repeat 3 --md

# 真實資料（本機 shioaji server；kbars 只服務 1m，其餘週期由本機 resample）
npx tsx scripts/perf/pine-bench.mjs --fetch-bars 15000 --tf 5 --bars 2000 --repeat 3

# 與既有 baseline 逐欄 diff（>10% 才標 regression／improvement）
npx tsx scripts/perf/pine-bench.mjs ... --label run2 \
  --compare bench/pine/run1.json --md

# 診斷 app 與 direct 的差異來源（多跑一趟 incRun）
npx tsx scripts/perf/pine-bench.mjs --script final.pine --diag --repeat 3 --md
```

`npx tsx` 是**必須**的，不是偏好：`src/pine/builtins/index.ts` 用無副檔名相對匯入 ＋ TS
parameter properties，`node --experimental-strip-types` 載不起來（同樣的理由記在
`scratch/perf-probe.mjs` 檔頭，本 harness 取代它）。

**import 順序鐵律**：`scripts/perf/lib/pine.mjs` 是唯一的引擎入口，它第一行就
`import '../../../src/pine/builtins/index.ts'`（註冊 builtin 表 ＋ mtf hooks），之後才 re-export
其餘模組。任何新模組都**只准**從 `./pine.mjs` 取得引擎符號，不要自己直接 import `src/pine/*`。

### CLI 選項

| 選項 | 預設 | 說明 |
|---|---|---|
| `--script <path.pine>` | `src/pine/TRIS390.pine` | 可重複 |
| `--bars <n>` | 500 | 由尾端取最後 n 根當 chart |
| `--bars-file <json>` | — | 自訂 bars，接受 `{t,o,h,l,c}` 或 `{time/openTime,open,...}`。**檔案的週期必須就是 `--tf`**（不做二次 resample，chart 序列直接採用）；要比 chart 更細的 tf 只能靠 `--fetch-bars` |
| `--fetch-bars <n>` | — | 由 `http://127.0.0.1:8080` 取 n 根 **1m** 當基底，再 resample 成 chart tf |
| `--tf <tf>` | `5` | chart timeframe（同時是 `tf_sec` 判斷基準） |
| `--symbol <code>` | `MXFJ6` | kbars 合約代碼（FUT/TAIFEX） |
| `--repeat <n>` | 3 | 計時樣本數（median 由此而來） |
| `--warmup <n>` | 2 | 進入計時前先空跑幾次；**冷啟動第一趟可慢數倍**，別設 0 |
| `--scale a,b,c` | — | 多根數掃描（覆寫 `--bars`）；每個 N 必須 ≤ 可用 bars，否則直接報錯 |
| `--engine-path app,direct` | 兩條都跑 | 見 §2 |
| `--out <path>` | `bench/pine/<label>.json` | |
| `--label <name>` | `pine-bench-<yyyyMMdd-HHmmss>` | baseline 標籤，`--compare` 會記錄它 |
| `--md` | 關 | 印完整 markdown 表（不給時只印精簡總表） |
| `--compare <baseline.json>` | — | 逐欄 diff，見 §6 |
| `--diag` | 關 | 額外量 `incRun`（診斷 app/direct 差異；每筆多跑一整趟） |
| `--no-instrument` | 關 | 跳過計數器收集（`__evalNodeCounts` 將為 `n/a`） |
| `--quiet` | 關 | 只印 JSON 路徑 |

---

## 2. 兩條 engine path

| path | 做什麼 | 外部可切分的階段 |
|---|---|---|
| `app` | `new PineInterpreterEngine()` → `prepare(src, id)` → `execute(req, handlers)` 等到 `onDone`。**這是圖表真正走的路徑**（`engine.ts:258/290/322`）。 | 只有 `prepare` / `execute` / `total`。`parse`＋`checks`＋`collectInputs` 在 `prepare` 內；`run`（= `runProgram` → `incRun`）＋`buildModel`＋`modelCacheGet/Put` 在 `execute` 內 → 標 `NOT_SEPARABLE`。 |
| `direct` | `parse` → `assertScript` → `collectInputs`＋`parseDeclArgs` → `runScript` → `buildModel`，**逐段外部計時**（計畫的「逐段外部計時」）。 | `parse` / `checks` / `collectInputs` / `run` / `model` / `total`。`compile`、`assemble` 仍不可分。 |

公平性的三個前提（`H3` 要靠它們才成立）：

1. 兩條路徑拿到**同一份 chart 序列**（同一個 `BarData`／`OHLCV` 對）。
2. 兩條路徑拿到**同一個 `request.security` gateway**：`app` 由 `execute` 內部的 `toFetch` 包裝，
   `direct` 用 `lib/bars.mjs` 的 `toFetch` 鏡像（逐字對映 `engine.ts:118`，含 `FETCH_WARMUP=500`
   ／`FETCH_CAP=20000` 與 `tfFloor`/`tfNext` 的 span 計算）包裝。少這層包裝，兩邊會餵給
   直譯器**不同長度**的 tf 序列，`run` 就無從比較。
3. `buildModel` 的 `req` 兩邊都由**同一個 `PreparedScript`** 產生：`direct` 從一次
   **不計時**的 `engine.prepare()` 取得（`modelId`／`inputs`／`meta` 因此逐位元一致）。
   兩條路徑吐出的 model 會被 FNV-1a digest，JSON 的
   `checks.modelsMatchAcrossPaths` 直接驗證 —— 這是儀器自身的正確性檢查。

---

## 3. 分階段定義

| 階段 | 量測方式 | app | direct |
|---|---|---|---|
| `parse` | `parse(src)`（lexer ＋ parser） | 併入 `prepare` | ✅ |
| `checks` | `assertScript(parsed)`（整棵 AST walk，`checks.ts:423`） | 併入 `prepare` | ✅ |
| `collectInputs` | `collectInputs(body)` ＋ `parseDeclArgs(parsed.decl)` | 併入 `prepare` | ✅ |
| `compile` | compile-to-closures 無法外部單獨計時 → 只報 `counters.compile`（`__compileCalls` ＋ `__compiledKinds` 分佈） | 間接 | 間接 |
| `run` | `runScript(parsed, bars, opts)` | 併入 `execute` | ✅ |
| `assemble` | run 內部完成（`markStage('assemble')`，`interpreter.ts:3065/3514`）→ v1 一律 `null` ＋ `NOT_SEPARABLE`；`counters.stageLast` 證明跑到了這一步 | 併入 `execute` | 併入 `run` |
| `model` | `buildModel(modelId, req, r, barTimes, overrides)`（`engine.ts:556` 已 export） | 併入 `execute` | ✅ |
| `cacheGet` / `cachePut` | `modelCacheGet/Put`；Node 無 IndexedDB → `n/a` ＋ 原因（`cache.probeMs` 是實測到的 no-op 成本） | `n/a` | `n/a`（direct 根本不過 cache） |
| `prepare` / `execute` | app 路徑外層 `performance.now()` | ✅ | — |
| `total` | app：`prepare`＋`execute` 的牆鐘；direct：各階段**相加** | ✅ | ✅ |

`ms` 物件固定含以上**全部**鍵；該路徑取不到的階段是 `null`（＋ `flags: NOT_SEPARABLE`／
`CACHE_N_A`）而不是 0 —— 欄位齊全但不會把「沒量到」假裝成「量到 0」。

`ms.total` 是**每次 pass 的 total 取 median**；其他欄位是**該階段每次 pass 的值取 median**。
因此 `total` 不會剛好等於 `parse+checks+collectInputs+run+model`（兩者是不同統計量），
direct 的 `total` 另外不含 await／排程開銷。要判「重心在哪」看各階段 median，
要判「絕對成本」看 `median`。

---

## 4. 輸出 JSON

```jsonc
{
  "tool": "scripts/perf/pine-bench.mjs",
  "version": 1,
  "label": "h1-high452",
  "createdAt": "2026-10-14T15:30:00.000Z",
  "env": { "node": "v24.11.1", "platform": "win32-x64", "cpus": 16, "totalMemMB": 0,
           "freeMemMB": 0, "pineJit": false, "evalCountingDuringTimedPasses": false, "note": "…" },
  "config": { "scripts": [...], "tf": "5", "symbol": "MXFJ6", "barsSource": "fixture …",
              "barsAvailable": 500, "baseTf": "5", "baseBars": 500, "bars": 500,
              "scale": null, "repeat": 3, "warmup": 2, "enginePath": ["app","direct"], ... },
  "cache": { "get": { "status": "n/a", "reason": "…" }, "put": { … },
             "probeMs": 0.11, "indexedDB": false },
  "results": [ /* 每 (script, enginePath, bars) 一筆，見下 */ ],
  "groups": { "app": [0,2], "direct": [1,3] },        // results 的索引，分 app／direct 兩組
  "growth": [ { "key": "x.pine|app", "bars": 100, "barsCurrent": 200, "baseMedian": 12.3,
                "median": 40.1, "expectedLinear": 24.6, "ratio": 1.63, "superlinear": true } ],
  "checks": {
    "modelsMatchAcrossPaths": [ { "key": "x.pine|500", "app": "1kzvcjg", "direct": "1kzvcjg", "match": true } ],
    "appVsDirectTotal":       [ { "key": "x.pine|500", "bars": 500, "appMedian": 52.4,
                                  "directMedian": 44.9, "delta": 7.6, "pct": 16.9,
                                  "within20pct": true, "incRunMs": 23.0 } ],
    "repeatsNoisy":           [ "x.pine|app|500" ]
  },
  "compare": { … },     // 僅 --compare
  "wallMs": 1234.5
}
```

### 每筆 result

```jsonc
{
  "script": "C:/…/high452_phase3.pine",
  "scriptName": "high452_phase3.pine",
  "enginePath": "app" | "direct",
  "bars": 500,
  "ms": { "parse": 31.02, "checks": 66.4, "collectInputs": 0.9, "compile": null,
          "run": 812.5, "assemble": null, "model": 4.2,
          "cacheGet": null, "cachePut": null, "prepare": 98.3, "execute": 820.1, "total": 918.4 },
  "msPerBar": 1.837, "min": 901.2, "median": 918.4, "max": 950.0,
  "repeatSpread": 0.053,          // (max-min)/median，>0.15 → flags 加 NOISY
  "phaseSpread": { "run": 0.048 },// 各階段自己的離散度
  "repeats": 3,
  "counters": { … },              // 見 §5
  "cache": { "get": {...}, "put": {...} },
  "notSeparable": ["compile", "assemble", "cacheGet", "cachePut"],
  "flags": ["NOT_SEPARABLE","CACHE_N_A"],
  "output": { "digest": { "hash": "1kzvcjg", "bytes": 40213 },
              "shape": { "series": 6, "lines": 0, … },
              "identityMatch": true, "warnings": 0 },
  "error": null,
  "modelId": "pine-1kzvcjg",
  "securityRequired": true,
  "requirements": { "security": true, "orders": false, … },   // checks.ts ScriptRequirements
  "diagnostics": { "securityCalls": 12, "securityServed": 8, "securityBlocked": 4,
                   "incRunMs": null, "incRunBars": null },
  "gateError": null, "gateDiagnostics": [], "timedOut": false
}
```

---

## 5. counters（全部是既有引擎計數器的**差值**，不是累計）

| 欄位 | 來源 | 備註 |
|---|---|---|
| `mtf` | `__mtfStats`（`mtf.ts:1315`） | `evals`/`hits`/`gatePass`/`gateFail`/`agHits`/`prodWalks`；**取不到資料時整包換成 `{status:"n/a", reason}`**，不會靜默 0（見 §7） |
| `evalNodeCounts.total` / `.top20` | `__evalNodeCounts`（`interpreter.ts:678`） | 需要 `globalThis.__pineEvalCount`。因此**獨立一趟 instrumented pass** 收集，不與計時樣本共用（該開關每個節點一次 `debugFlag()` ＋ `Map.set`）；`--no-instrument` 時 `top20: null` ＋ `unavailableReason` |
| `callHistWrites` | `__callHistWrites`（`interpreter.ts:1409`） | 歷史緩衝寫入次數 |
| `compile.calls` / `.kinds` / `.kindsAll` | `__compileCalls`／`__compiledKinds`（`interpreter.ts:1896-1898`） | `__compiledKinds` 是 `Map<stmtType, 'direct'\|'twoPhase'\|'fallback'>` = **每個 statement 型別最後一次的編譯處置**，不是計數器。`kinds` 只列**這一趟有變動**的條目，`kindsAll` 是整張表的絕對值 |
| `seriesWrites.setAt` / `.ensureBar` | `BarSeries.prototype` patch | 手法同 `scratch/perf-probe.mjs`；模組載入時 patch 一次 |
| `stageLast` | `globalThis.__pineStage`（`markStage`，`debugFlags.ts:86`） | 跑完應為 `"assemble"`，用來證明 run 走到了組裝階段 |
| `countersPassMs` | harness | 那一趟計數器收集本身的牆鐘，方便判斷 instrumented pass 的相對成本 |

## 6. flags 與判定規則

| flag | 意思 |
|---|---|
| `NOT_SEPARABLE` | 該路徑有階段無法從外部單獨計時（app 的 `parse`/`checks`/... 、兩條路的 `compile`/`assemble`/`cache*`）。`notSeparable` 列出是哪幾個 |
| `CACHE_N_A` | cache 階段不可用（Node 無 IndexedDB）或該路徑不過 cache |
| `SUPERLINEAR` | `--scale` 下，某個 N 的 median total 相對最小 N 的**線性期望**超出 **+30%** |
| `NOISY` | 同一設定的 `--repeat` 樣本 `(max-min)/median > 0.15` → 這台機器當下不適合當基準 |
| `GATE_REJECTED` | `assertScript`（compile gate）擋下腳本，沒有任何 run 發生（見 `gateDiagnostics`） |
| `RUN_ERROR` / `TIMEOUT` | 該筆的 run 出錯／超過 600s watchdog |
| `INSUFFICIENT_BARS` | 不會出現：N 大於可用 bars 時 CLI 直接**報錯**（附可用的修正指令），不產生垃圾筆數 |

- **成長**：`--scale` 每個 N 報 median；`growth[]` 列出線性期望與 `實際/期望`；`ratio > 1.30` → `SUPERLINEAR`。
- **回歸**（`--compare`）：逐欄絕對值 ＋ `%`，僅 **|Δ| > 10%** 標 `regression`（變慢）／`improvement`（變快）。
  `compare.repeatable` ＝ 所有 `total` 差異的最大絕對值 < 15%（計畫的 H2 門檻）。
- **重複性**：每筆自帶 `repeatSpread`；超標就加 `NOISY` 並在 `checks.repeatsNoisy` 列出。
  harness 必須自己指出「這環境現在不適合當基準」，而不是安靜地給出漂亮數字。
- **兩條路徑一致**（H3）：`checks.appVsDirectTotal[].within20pct`，門檻 20%。

---

## 7. `n/a` ＋ 原因（計畫 H4 的硬要求）

`counters.mtf` 有三種狀態：

1. `{ status: "measured", evals, hits, gatePass, gateFail, agHits, prodWalks, gateway }` — 有數字。
2. `{ status: "n/a", reason: "script does not call request.security (…requirements.security=false)" }`
   — 腳本本來就沒有 MTF，不是「取不到」。
3. `{ status: "n/a", reason: "…" }` — 有 `request.security` 但 `evals === 0`。原因由 gateway 診斷組出來，
   例如：
   - `no security expression was evaluated at runtime (tf-gated branch / short-circuit) — gateway received 0 requests`
   - `base tf 5 cannot be resampled down to requested tf(s) 1`
   - `every gateway request returned 0 bars`
   - compile gate 擋下時：`compile gate (assertScript, checks.ts:423) rejected the script before any run …`

`gateway` 欄位本身是證據：`{ baseTf, baseBars, calls, served, empty, blocked, requestedTfs, blockedTfs, lastLimit }`。

**MTF 序列來源**：`--fetch-bars` 時基底是真實 1m kbars；否則基底就是 chart fixture，
`request.security` 要的每個 tf 都用引擎自己的 `tfFloor` 重新分桶
（`makeSecurityGateway`，`lib/bars.mjs`）。比 chart 更細的 tf 沒有子 K 可切 → 回 `[]` 並記進
`blockedTfs`（**不會**拿粗 K 冒充細 K）。

---

## 8. 已知限制

1. **cache 階段在 Node 永遠 `n/a`**。`modelCache.ts` 的 `db()` 在 `typeof indexedDB === 'undefined'`
   時 resolve `null`，所以 `modelCacheGet/Put` 是 no-op —— 這是**誠實的 n/a**，不是沒量：
   `cache.probeMs` 是實際呼叫一趟量到的成本。要量真快取命中率得在瀏覽器（另有 `__pineRunLog`）。
2. **`assemble`／`compile` 不可外部切分**。v1 依計畫標 `not_separable`，只用計數器間接呈現。
   要真拆需要 `markStage` hook，屬 v2（計畫明列要列 P8 review）。
3. **冷啟動污染**。第一趟 pass 明顯偏慢（實測同一支腳本第一趟可 ~200ms、暖機後 ~26ms）。
   預設 `--warmup 2` 已緩解，但 `--warmup 0` 的數字**不可**當基準。任何 `NOISY` 標記的筆數同理。
4. **環境噪音**。本機可能同時有其他重型工作（另一支 benchmark、dev server、shaper）。實測：跑這些基準時
   本機同時有 **15 個 `node.exe`** 在跑，於是同一支腳本同一設定的 `--repeat` 樣本
   `repeatSpread` 落在 **0.06 – 2.27**（`final.pine` direct 最小 17ms、最大 157ms），
   連跑兩次的 `total` 差異可到 **71.9%**（`--compare` 全記錄）／**19.2%**（只算 TRIS390＋MACD 兩支重腳本、`--repeat 5`）。
   相對地 model digest 每次都一致、counter 每次都相同 → **工作內容是確定的，抖動來自環境**。
   `repeatSpread`／`phaseSpread`／`NOISY`／`--compare` 的 `totalMaxAbsPct` 就是讓讀者判斷這件事的工具；
   輕量腳本（絕對值 ~20-40ms）在吵雜環境很容易 ≥15% 抖動，重腳本（~1s 以上）相對穩定。
   要當 baseline 請挑機器空的時候跑，並確認 `checks.repeatsNoisy` 是空的。
5. **`runScript` vs `incRun`**：app 路徑的 `runProgram` 走 `incRun` → `interpreter.ts:3592`，對
   indicator 腳本會走 `incRunStart`（建 session ＋ checkpoint），direct 路徑走 `runScriptInner`。
   兩者不是同一個函式，所以 app 與 direct 的 `run` 天生可能有一點差異。
   `--diag` 的 `incRunMs` 就是在**同一個 process、鄰接時間**量同一件事來釘住這個問題：
   實測（`bench/pine/scale-diag.json`）TRIS390@500 `incRun` 7209.75ms vs direct `run` 8437.44ms、
   TRIS390@100 2390.89 vs 2309.87、MACD@500 1388.63 vs 1240.81 —— 有正有負，**方向不一致 =
   落在環境噪音內**，沒有系統性偏向，所以 app/direct 的差主要是排程抖動而非分支差異。
   （strategy 腳本 `incEligible === false`，兩條路徑都會落到 `runScriptInner`。）
6. **direct 的 `total` 不含 await／排程開銷**，是各階段相加；app 的 `total` 是純牆鐘。
7. **kbars 只服務 1m**，其他週期一律本機 resample（`src/services/shioaji/candles.ts` 同一事實）。
   `--fetch-bars` 需要 `http://127.0.0.1:8080` 活著，且契約代碼（預設 `MXFJ6`）有資料。
8. **compile gate 擋下的腳本量不到**。`PineInterpreterEngine.prepare` 會呼叫 `assertScript`，
   gate 一擋就沒有任何 run（圖表端也是同一個 stop）。harness **不繞過** gate（那是 `src/**`），
   只把 `gateError` ＋ `gateDiagnostics`（`checkScript` 的完整診斷，含 `rule`/`line`/`col`/`message`）寫進該筆，
   並讓整趟跑完。腳本層級的失敗**不會**讓 CLI 失敗（exit code 仍為 0）；harness 自身的 bug 才會 exit 1。
9. **`--scale` 的 N 受可用 bars 限制**。預設 fixture 只有 500 根，`--scale 100,200,500,1000,2000`
   需要先 `--fetch-bars` 或換更長的 `--bars-file`，否則 CLI 直接報錯（不產生假的成長曲線）。
10. **`msPerBar`** ＝ median total ÷ bars；跨 tfs 比較沒有意義（tf 不同，per-bar 工作量不同）。
11. 不改 `src/**` 是硬邊界：`lib/engines.mjs` 鏡像了 `engine.ts:504`（`parseDeclArgs`/`litOf`）與
    `engine.ts:118`（`toFetch`）這三段 module-private 邏輯，並在檔頭標明出處。若引擎之後改了這幾段，
    鏡像必須同步 —— 這是本 harness 唯一需要人工維護的耦合。

---

## 9. 驗收對照

| # | 條件 | 本 harness 的對應 |
|---|---|---|
| H1 | `--script high452_phase3.pine --bars 500 --repeat 3` 跑完且 JSON 欄位齊全 | 每筆 result 固定含 §4 全欄位；該腳本目前被 compile gate 擋下 → 該筆 `GATE_REJECTED` ＋ `gateDiagnostics`，其餘腳本照常量到 |
| H2 | 同設定連跑兩次，`--compare` 差異 <15% | `--compare` 輸出 `compare.totalMaxAbsPct` 與 `repeatable`；每筆另有 `repeatSpread`／`NOISY` |
| H3 | `app` 與 `direct` 的 `total` 差異 <20% | `checks.appVsDirectTotal[].within20pct`；`--diag` 提供 `incRunMs` 供診斷（限制 5） |
| H4 | MTF counters 有數字；取不到 → `n/a` ＋原因 | `counters.mtf.status` 三態 ＋ `reason` ＋ `gateway` 證據（§7） |
| H5 | 欄位／階段命名沿用 repo 既有詞彙 | `parse`/`assertScript`/`collectInputs`/`runScript`/`buildModel`/`prepared`/`execute`/`assemble`/`__mtfStats`/`__evalNodeCounts`/`__callHistWrites`/`__compiledKinds`，以及 `modelCacheGet/Put`、`tfFloor`/`tfNext` |
