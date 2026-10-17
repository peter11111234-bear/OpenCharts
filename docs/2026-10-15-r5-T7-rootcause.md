# T7 根因收斂＋修復方向（6 front 探索後，2026-10-15 18:40）

## 一句話

> **失敗的 mtf restore** 讓重播的 forming bar 讀到**錯誤位置（j）的 HTF bar**，`f_htfBoth()` 的 `[1]` 輸出塌成 `[0]`，
> `prev*` 拿到 `roll*` 的值 → `drawings[4]/[5]` 是**新物件、錯輸入**。繪圖層無罪。

## ★ 已確認的機制（2026-10-15 19:5x，隔離樹實測，非推論）

**一句話：tf 序列在一次 rollback 裡被 rewind 兩次，第二次把 `buf` 換回「未截斷的原陣列」，造成 `buf.length` 與 `lastBar` 不一致，於是每個 `rAt`/`atOffset` 讀都位移一格。**

實測記錄（`scratch/perf/iso/rewind.json`，`npx tsx scratch/perf/iso/t7-rewind.mjs --bars 500 --ticks 1`）：

```
rewind s=696 snapLastBar=44 snapBufLen=46
       before{bufLen:45} → after{bufLen:46}     ← 長度不減反增
```

逐步：

| 步 | 動作 | `this.buf` | `lastBar` |
|---|---|---|---|
| checkpoint（build 的 bar 498 後） | `snap1 = incSnap()`、`snap2 = incSnap()`，兩者 `buf` 都指向**同一顆原陣列**（46 格）；正確水位 45 | 原陣列(46) | 44 |
| build 的 bar 499 eval | `advanceTo(spec, 45)` 追加 index 45 | 原陣列(46) | 45 |
| tick 1 rewind **#1**：`restoreCkpt` 的 `seriesSnaps`（`interpreter.ts:3546`） | `drop = 45−44 = 1 > 0` → `buf = snap1.buf.slice(0, 46−1)` → **換成新陣列(45)** | 新陣列(45) | 44 |
| tick 1 rewind **#2**：`restoreSpec` 的 `SpecSnap.snaps`（`mtf.ts:2346`） | `drop = 44−44 = 0` → else 分支 `this.buf = snap2.buf` → **指回原陣列(46)**，再 `length = 46` | 原陣列(**46**) | 44 |

⇒ 終態 `lastBar = 44` 但 `buf.length = 46`。`rAt(0)` = `buf[45]`（＝被丟棄的 forming bar 剛寫入的 48935）而不是 `buf[44]`（48959）。
`atOffset(loaded-1, 1)` 因此回傳與 `atOffset(loaded-1, 0)` 相同的值 ⇒ `[1]` 塌成 `[0]`。

**為什麼只有「尾桶只含 1 根 chart bar」的 frame 中招**：需要 rewind #1 的 `drop > 0`（被丟棄的 eval 剛好追加了一格）而 rewind #2 看到 `drop === 0`。checkpoint 在 bar 498（`j=44`，loaded=45），bar 499 使 `j=45` —— 剛好一格。尾桶含多根 chart bar 的 frame（240/D）在 bar 499 不會新增 tf bar ⇒ 兩次 rewind 的 `drop` 皆為 0 ⇒ 不觸發。

**修法**（已落在 `scratch/perf/iso/pine/series.ts`，patch 在 `scratch/perf/iso/t7-fix-series.diff`）：
`IncSnap` 增加 `len`（快照當下的 `buf.length`）作為水位；`incRewind` 永不讓 `buf.length > snap.len`，
且 `drop === 0` 時不再無條件採用 `snap.buf`。這正是 A2 排第一的「`IncSnap` 非閉環」缺口，但成因比「same-bar 就地覆寫」更單純：
**雙重回 wind ＋ 別名快照的長度不可回溯**。

> 註：早先探針報的 `barsSharedWithFetchedLive: false`（F2）**是無效觀察** —— `store.fetched.get(`${sym}\n${tf}`)` 在 probe 端以 `symResolved/tfResolved` 組鍵仍取不到（`fetchedLen` 全為 null），該測試恆真、不構成證據。F2 未被證實。


原計畫檔把分歧點標成「roll wick line / roll body box」（即 `drawings[4]/[5]`，TRIS390.pine:754/764），
並把首選懷疑指向「圖形 rollback 不完整」。**六個 front 一致推翻這個定位**：

| 主張 | 證據 |
|---|---|
| `drawings[4]/[5]` 是 **`prevWickLine`(:786)／`prevBodyBox`(:795)**，不是 roll 對 | A3：`scratch/perf/t2-s1control-500.json` 的 6 個物件依 sink 插入序編號：id1 table、id2 rollWick、id3 rollBody、id4 rollLabel、id5 prevWick、id6 prevBody |
| 分歧物件是**新建的**，不是殘留舊物件 | A3：live[4]/[5] 的 props 值 = 當下 roll 對的值（48935/48882、48933/48918），x 座標與 cold[4]/[5] 相同 |
| 繪圖層**完整**在 checkpoint 面，不可能產生 y 分歧 | A2：`drawSnap`/`drawProps`/`liveArrays` 三者在 capture 與 restore 兩邊皆對稱（membership + payload） |
| 四個值**不依賴任何 UDF-local `var`** | A4：`f_supertrend`/`f_rangefilter`/`f_halftrend` 只在 29 個 `request.security`（:172-249）裡被呼叫，:710-717/:738/:754-764 完全不讀 |

## 機制（三條獨立收斂線同時指向 mtf.ts）

### 1. live 的 prev == roll，即 `[1]` 讀到同一根 HTF bar

A5 對 fixture 做逐桶算術，完全吻合：

| 桶 | 高/低 | 開/收 |
|---|---|---|
| roll `[1791835200000,1791838800000)` | 48935 / 48882 | 48918 / 48933 |
| cold prev `[1791831600000,1791835200000)` | 48959 / 48888 | 48890 / 48815→48915 |
| live prev | **48935 / 48882（= roll）** | **48918 / 48933（= roll）** |

`f_htfBoth()`（TRIS390.pine:674）回 8 個值，`[1]` 排的 `hHTF1/…`（:676 解構）在 live 側解析到與 `[0]` 相同的 60 分桶。

### 2. `:741` 閘門與長度無關 → 400/500 是**tape 相位**差，不是閾值

A5：`rollReady = not na(targetTF) and not na(rollOpen)`（:739），probe 設定 `--tf 5` ⇒ `secPerBar_rt=300`、`targetTF="60"`、`barsPerHTF=12` ⇒ 從 chart bar **11** 起閘恆真，**沒有 400→500 相交的數值條件**。
唯一可驗的 400/500 差異：N=500 末棒 `openTime 1791838800000 % 3600000 == 0`（**正好壓在 60 分邊界**，尾桶只含 1 根 chart bar）；
N=400 末棒 `% 3600000 = 238800000`（桶內 8 根）。相位族 = `N ≡ 500 (mod 12)`。

> 副產品：`logs/t7-bisect.log` 的「100/200/300/400 match」若只測過單點，**400 乾淨只是相位不代表缺陷不存在**；
> 正確判據是 404（預測壞）vs 400（預測乾淨）。

### 3. 為什麼第一 tick、同樣的值、之後不漂（sticky）

A2 的粘滯機制＋A1 的控制流：
`incRunStart` 在 build 迴圈內（`interpreter.ts:3691`，eval 完 bar 498 之後、還沒 eval 499 之前）取唯一 checkpoint；
`incAdvance` 每次 restore **同一個 ckpt 物件**（`:3751`）。任何在 build 的 bar-499 eval 時寫到 bar ≤ 498 的狀態，
之後每個 tick 都被重新注入 ⇒ 值恆定、不漂。A1 另證：tick 1（`appendedBar:false`）在 `restoreCkpt` 與 forming-bar eval
之間**只有游標被寫**（`rewindCursor` → `barCtx.ctxBar`/`ctx.barIndex` 兩個欄位）⇒ 分歧只可能來自
(a) restore 面沒涵蓋的表面，或 (b) checkpoint 存了 reference 而被丟棄的 eval 就地改掉。

### 4. 四個 delta 是四個不同量 ⇒ 不是單一 stale scalar

−24/−6（wick）與 −18/−28（box）。若走 760-763 的 minBody 分支，`Δtop − Δbottom = ΔminBody = 10 ⇒ Δatr = 250` 不可能。
一致解讀：四個成員各自從**不同 HTF bar** 讀取，或 `na(hHTF) ? rHigh_fb : hHTF`（:711）這條 security/fallback 分支翻面。

## 修復方向（按「先最小修 mtf、再收斂 series 不變式」排序）

### 第一修：mtf.restore 對 `lookahead_off` 也要丟掉 tf-tail 衍生狀態
`restoreSpec`（`mtf.ts:2310-2376`）把 `spec.warmed` **逐字還原**（`:2322`）⇒ 重播的 forming bar 會**跳過 `for (w in 0..j)` 的 tf bar 重播**（`:2185-2189`）；
而 per-(node,caller,j) 快取只在 `lookahead === 'on' || isLtf` 時被丟（`:2364-2375`）——這個腳本是 `lookahead_off`，快取**不清**。
⇒ 讓 `restoreSpec` 在 `lookahead_off` 下也清 `spec.nodeCache`/`agnosticCache`/`invCache` 並 `spec.warmed = false`（或重跑 `0..j` replay）。
`alignToChart`（`mtf.ts:1088-1090`）本身就寫了這個 hazard：deferred chart-level read 會「silently shift which tf bar `get(0)` resolves to」。

### 第二修：same-length tick 也要 refresh
`interpreter.ts:3756` 把 `mtf.refresh` 閘在 `bars.length > oldLen`；但 same-length tick 會改寫 forming bar 的 OHLC，
HTF feed 的尾桶內容已變而 `spec.bars` 仍是 build 時的。`firstDiff`（`:3728-3733`）已經知道哪根改了，改用它當閘。

### 第三修：`SpecSnap` 缺三塊
1. `spec.bars` 只存 reference（`mtf.ts:2304`，restore 只 re-point `:2339`）→ 要存內容；`store.fetched` 完全沒進快照（`:2380-2390`）→ 補進去。
2. `spec.seenCallers` 不在 `SpecSnap` → rollback 後停在 `resetTfFrame` 的 `new WeakSet()`（`:1113`），下次 `tryEvalSecurity` 把 `spec.nodeCache` 降級成 transient Map（`:2058-2065`）。
3. mtf 快取恢復語意是「post-checkpoint 更新過的 key 直接刪，不還原成 pre-checkpoint 值」（`:2312-2320`）→ 語意要明講。

### ✅ 已落（就是這個）：`BarSeries` 快照長度水位
**已確認並已修**。`IncSnap` 新增必填 `len: number`（快照當下的 `buf.length`）；`incSnap()` 回傳它；
`incRewind()` 收斂成單一判準：

```ts
if (this.buf.length !== snap.len) this.buf = snap.buf.slice(0, snap.len);
```

改動只在 `series.ts`，patch：`scratch/perf/iso/t7-fix-series.diff`（`git apply` 到 `src/pine/series.ts`）。

原本我猜的成因（same-bar／retro 就地覆寫污染快照）**不是**本案主因；主因是**同一次 rollback 的雙次 rewind ＋ 別名快照長度不可回溯**。

**我自己中途犯過的錯（留紀錄，別重犯）**：第一版寫成
`from = (snap.buf === this.buf ? this.buf.length : snap.len) - drop` —— 在「快照陣列已被前一次 rewind 脫離」時多減了一次 `drop`。
別名時 `snapBufLen - drop` 恰好等於 `snap.len`，所以錯誤被掩蓋；到 tick 2（`snap.buf !== this.buf`）就少一格，
`plots[32]`（`TRIS390.pine:657` ← `turtle_hi = ta.highest(high, 55)[1]`，:362，純 chart-tape）從 tick 2 起分歧。
**判別法**：`firstDiff` 依 `KEYS` 順序、`plots` 在 `drawings` 之前 ⇒ 修前每 tick 都報 `drawings[4]` 即證明修前 `plots` 相同 ⇒ 該殘餘是修補引入。
**正確目標長度永遠是 `snap.len`**，與 `drop` 無關。

**驗證**（隔離樹 `scratch/perf/iso/`，不經 `src/pine`）：

| 檢查 | 結果 | 證據 |
|---|---|---|
| `--bars 500 --ticks 5` | **0 mismatch**（build＋tick1–5 全 `diff: null`；tick 5 有新增 bar、bars=501） | `scratch/perf/iso/verify500-t5-fix2.json` |
| `--bars 100 --ticks 5`（不退步） | 0 mismatch | `scratch/perf/iso/verify100-t5-fix2.json` |
| `--bars 400 --ticks 5`（相位關對照） | 0 mismatch（預期乾淨） | `scratch/perf/iso/verify400-t5-fix2.json` |
| 修前同條件對照 `--bars 500 --ticks 5` | tick1–5 **每 tick** 都 `drawings[4]` 分歧 | `scratch/perf/iso-pre/pre-fix-t5.json` |
| **四支 model digest**（100 根、`--engine-path direct`、repeat 2/warmup 2） | `ze7byn`(K55 app)／`kb0glc`(TRIS390)／`1580h2`(MACD701_v72)／`p4gddl`(final) —— **與 R5 記錄逐字相同** | `scratch/perf/iso/digest-100.json`（比對 `bench/pine/r4c1-before.json`） |
| 引擎自帶 parity 測試 `pine/__tests__/inc-parity.test.ts` | **7/7 passed** | `npx vitest run --config scratch/perf/iso/vitest.config.ts pine/__tests__/inc-parity.test.ts` |
| 全 pine 套件 | **954 passed ｜ 1 skipped（62 檔）** = 文件基準（含 `golden.test.ts` 對 TRIS390／MACD701_v72／final 等 10 支的 model 比對） | `npx vitest run --config scratch/perf/iso/vitest.config.ts` |
| `tsc --noEmit`（修補樹／原始樹） | 0／0 錯 | `scratch/perf/iso/tsconfig.json` |

隔離執行方式：`scratch/perf/iso/build-iso.cjs`（探針）與 `build-bench.cjs`（digest bench）把 5 個 harness lib 複製到 `scratch/perf/iso/lib/`，
只改寫 engine 樹前綴成 `../pine/`；`fixtures/` 與 `scripts/` 以 junction 指向真目錄（不複製、不漂移）。

`IncSnap` 不在任何公開面、全 repo 無手寫快照字面值、無序列化往返 ⇒ 新增必填 `len` 不會破壞其他消費者
（見 `scratch/perf/t7/T7-FIX-REVIEW-BRIEF.md` 對應的 R2 盤點）。

> 上面第一～第三修（mtf 面）**未被證實為 T7 成因**，保留為潛在缺陷列管，不要當成本次修法的一部分。

### 不修（列管，別浪費時間）
- 繪圖層（`draw.ts` / `MemoryDrawSink` delete、id、排序、`drawProps` restore）：**正確且完整**，A2/A3 雙邊證明對稱。
- UDF-local `var` / `paramCows`：**完整在 capture + restore 兩面**（A4：`declSlots` + `paramCows` + `scopeVars` 全覆蓋）。
- 原計畫的「首選懷疑：drawSnap/drawProps/liveArrays 還原不完整」→ 已推翻，改列於此避免有人重做。

## 驗證（依序，全部等 `src/pine` 回到優化樹後才跑）

| # | 探針 | 預測 | 意義 |
|---|---|---|---|
| F1 | 在 build 的 bar-499 eval 與 tick-1 replay 兩側 log `na(hHTF)`／`j`／`spec.loaded`／`spec.bars.length`／`spec.series.high.atOffset(j,0)`／`spec.bars[j]` | 若 `na(hHTF)` 或 `j` 不同 ⇒ 本鏈確認為載體 | 定位分支翻面 vs 位置偏移 |
| F2 | restore 後立即比 `spec.bars === store.fetched.get(sym+tf)` 與長度 | 預測 `spec.bars.length` = build 長度、`store.fetched` 是另一個陣列 | 驗第三修 |
| F3 | `--bars 404` vs `--bars 400` | 404 壞、400 乾淨 | 驗相位理論（**取代無腦 400→500 線性二分**；425/450 皆 ≡ 5/6 (mod 12) 會假乾淨） |
| F4 | `--bars 31` vs `--bars 32` | 32 起可能壞（`p*_fb` 家族 bar 23 才齊） | 驗 N=24 推導 |
| F5 | 畫 raw `rollOpen/High/Low/Close` 兩側比 | 值相同 ⇒ 載體在繪圖層；不同 ⇒ F1 定源 | 載體二擇一 |
| F6 | canon 加 `d.id`（`t7-identity.mjs:62` → `[d.id, d.kind, JSON.stringify(d.props)]`） | 500 根 `drawIdsMatch===false`、100/200/300/400 `true` | 讓身分分歧可見（`s1`/`t2` 的 canon 別動，保留基線可比） |
| F7 | `MemoryDrawSink.prototype.create/remove` patch（`live.s.drawSink.constructor` 取類別，不 import） | `deletedIdsLive !== deletedIdsCold` 或 `remove` 的 `inList === -1` ⇒ 分歧在 `:730-735` 的 delete/`na`-handle | 定位 delete 路徑 |

F1–F7 全部是 probe-side 改動，**零引擎改動**（A6 方法論）。

## 儀器現況
`scratch/perf/t7-identity.mjs` 已存在，已實作 id + nextId 半邊（live only）；缺 delete 紀錄、cold 側 counter、y-source 值。
注意 `scripts/perf/lib/pine.mjs:19-38` **hard-code `../../../src/pine/*.ts`** ⇒ 探針載入的是 `src/pine` 的內容，
所以**優化樹必須在 `src/pine` 才能跑**（不能直接指 `scratch/perf/r5-pine-optimized-b9`）。

## 驗收（T7 定義，不放寬）
`--bars 500 --ticks 5` **0 mismatch**；100 根不得退步；不得用容忍閾值／忽略 drawings 變綠。
收斂後必須仍：`npx vitest run src/pine` 954 passed｜1 skipped、`tsc` 0、
四支 digest `ze7byn`/`kb0glc`/`p4gddl`/`1580h2` 不變、golden 0 差異。
