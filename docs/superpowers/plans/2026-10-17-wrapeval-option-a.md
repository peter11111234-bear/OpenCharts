# 選項 A：`evalArg` 邊界按「引數形狀」收斂包裝 — REAL PLAN v1（2026-10-17）

> 來源：
> - inventory：唯讀 scout 全掃 `src/pine/builtins/` 20 檔，真錯 **(a) 類 33 站**、高影響 6 站（見 §2）。**該報告未實測**（沙箱無 shell）⇒ 其行為後果全為 `[INFERENCE]`。
> - 已修先例：C1/I-a 的 5 處 `snap` 補丁（`array.ts:73/236/248/306/448`）。
> - 本計畫狀態：**v1 草稿**；`【待實測】` 標記者需等 `WrapAExternal`（8 組 A/B 實測＋設計骨架）回來補數字，方可進 P6。

## 0. 為什麼不是「逐站點 `snap`」

- `evalArg` 的包裝不是只針對 literal/ident：**任何變數 ident**（因「每個具名變數都擁有一個 `BarSeries`」，`interpreter.ts:647-654`＋`scope.ts:101-103`）、any num/bool literal（**不看 `noHist`**，`:1632-1650`）、any series 值（`:1653-1655`）都會被包成 `{kind:'series'}`。只有裸字面 `na` 以 `{kind:'na'}` 直達。
- 真錯站點 **33**（不是 5）：`array` 9、`str` 9、`input` 6、`math` 4、`color` 2、`plot` 1 群（14 個 `bound.get`）、`draw` 1、`strategy` 1。
- 已修的 5 處證明「逐站修會漏」——同批兄弟站全數未修。

## 1. 目標與非目標

**目標**：在 `evalArg`（含其 **JIT 逐字鏡像**）引入**按註冊宣告的引數形狀**決定「值語意」引數的交遞形態，使值語意引數一律拿到**當前純量**（等價於 `snap`：`unwrapped(v) ?? NA`），一次收乾淨；並在驗證後**回退**已加的逐站 `snap` 補丁。

**非目標**：
- 不改 `ta.*`（`HIST_NS={ta:true}`，`registry.ts:26-27`）任何行為。
- 不改 `math.liftNums`（`math.ts:119`）、`nz`（`:274-296`）、`input.source(close)`（`input.ts:204/216/230`）依賴「拿到 series」的既有語意。
- 不動 golden/digest 的既有值（**除**修正後必須 re-baseline 的部分，且需另行核准）。

## 2. 已確認的靜態契約（可直接依賴）

| 事實 | 出處 |
|---|---|
| 包裝點與分支 | `interpreter.ts:1627-1630`(ident)／`:1632-1650`(literal，不看 `noHist`)／`:1653-1655`(series)／`:1656`(非數值直通)／`:1658`(`noHist` 直通)／`:1661-1670` |
| 呼叫端 | builtin `:1531`；`x.method()` 型 builtin `:1470`；`noHist = !histSpecHas(spec, pos, name)`；`spec = HIST_BUILTINS.get(builtin)`（`registry.ts:17-24`） |
| **JIT 逐字鏡像（硬約束）** | `jitArgFinish`（`:2664-2680`）、`jitMatArg`（`:2685-2706`）、JIT arg 端點 `:2597`／`:2621`／`:2778` ⇒ **三處必須同步**，否則直譯/JIT 分岐 |
| 不可用 `histSpecHas` 推導 | 會把預設翻成「不包」⇒ 打壞 `math.liftNums`、`nz`、`input.source`、`ta.*` |
| 高影響 6 站 | `array.fill.length`(`array.ts:137`)、`variance/stdev/standardize/covariance` 的 `biased`(`:392/:402/:461/:481`)、`percentile_*.percentage`(`:535/:549`)、**`math.tonumber`(`math.ts:301` 整支 `switch`)** ← `【待實測】` |
| 其他 (a) 例 | `array.slice.index_to`(`:54`)、`array.join.separator`(`:426`)、`math.round` 精度(`:206`)、`math.random.seed`(`:325`)、`math.round_to_mintick`(`:221`)、`color.rgb` 通道(`color.ts:105`) |

## 3. 設計（2026-10-17 **裁決：改採 A1′＝`callBuiltin` 單一漏斗**）

> **決策依據（`WrapAExternal` 實測，影子樹）**：原計畫要求的「`evalArg`＋`jitArgFinish`＋`jitMatArg` 三處同步」（記為 A1）只能換到 **0.64%** 的單一計數器（四支腳本中僅一支有差），卻要多維護 **8 個位置**。故改採 **A1′**：在 **`callBuiltin` 單一漏斗**收斂，搭配註冊表宣告 **`ScalarSpec{idx, names}`／`scalarSpecHas`**。A1 的完整可編譯實作與 JIT parity 證據留在 `%TEMP%/wrapchk/shadow-a1`（未落地，隨時可啟用）。
>
> **A1′ 影子樹閘門（代理實跑，父代理尚未複驗）**：G1 `976 passed | 1 skipped` ✅／G3 四支 digest 逐字不變 ✅／G4 golden `14 passed | 1 skipped` ✅／G7 JIT↔直譯 PARITY OK ✅／**G2 `tsc` 未跑** ⚠️／G6 `NOISY`。repo 未被寫入。

1. **註冊側宣告**：在 builtin 註冊表新增「值語意引數」宣告（例如 `valueArgs: number[]`，或以既有的 `names`/`idx` 為基礎的 `argShape`）。**只宣告、不改預設**：未宣告者行為**完全不變**。
2. **邊界側收斂**：`evalArg` 對「被宣告為值語意」的位置，回傳**當前純量**（`unwrapped(...) ?? NA`）而非 `{kind:'series'}`；`noHist`、非數值直通、series 分支的既有行為不動。
3. **JIT 同步**：`jitArgFinish`／`jitMatArg`（與 `:2597/:2621/:2778` 端點）套用**同一判定**——建議把判定抽成**單一函式**（例如 `argShapeOf(spec, pos, name)`）供三處呼叫，避免三份分岐。
4. **回退逐站補丁**：A 覆蓋到的站點，移除其 `snap(raw)` 補丁（保留紅測試，測試應仍綠）。

**分階段（建議）**
- **Stage 1**：只宣告 §2 的**高影響 6 站**引數 → 跑閘門 §5 → 若全綠，**這是可獨立交付的最小修法**。
- **Stage 2**：其餘 (a) 類 27 站（依 `【待實測】` 分類結果逐組宣告）。
- **Stage 3**：回退 5 處逐站補丁；更新 debt 文件。

## 4. 步驟（每步附驗證）

| # | 步驟 | 驗證 |
|---|---|---|
| 1 | 快照 `interpreter.ts`（＋`registry.ts`、`array.ts`、`math.ts`）到 `%TEMP%/wrapA-backup-20261017/` 並記 md5 | `md5sum` 逐檔相符 |
| 2 | 先寫**紅測試**：針對 Stage 1 的 6 站，各 1 個走引擎路徑的 `it`（傳 **na 的 ident** vs 正確值 vs 省略），斷言 TV 語意 | 修前 FAIL（逐條貼輸出） |
| 3 | 新增宣告欄位＋單一判定函式（不改預設行為） | `npx tsc --noEmit` rc=0；`npx vitest run src/pine` **基線不變**（未宣告者零影響） |
| 4 | 套用三處邊界（`evalArg`＋兩支 JIT） | 紅測試轉綠 |
| 5 | 跑閘門 §5 全套 | 逐條貼原始輸出 |
| 6 | 若 Stage 1 全綠 ⇒ 進 Stage 2（逐組、每組跑一次閘門） | 同 §5 |
| 7 | 回退 5 處逐站補丁 | 閘門再跑；`array.ts` 只剩 B3 的 `from` 改動 |

## 5. 回歸閘門（每階段都要跑；逐條貼原始輸出）

| 閘門 | 指令 | 通過條件 |
|---|---|---|
| G1 全測試 | `npx vitest run src/pine` | 全綠；passed ≥ 現值（975） |
| G2 型別 | `npx tsc --noEmit` | rc=0 |
| G3 四支 digest | `npx tsx scripts/perf/pine-bench.mjs --script scratch/perf/app-scripts/script-a1dcdea6-95114.pine --script src/pine/TRIS390.pine --script "C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine" --script final.pine --bars 100 --repeat 2 --warmup 2` | `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` **逐字不變**（若有變 ⇒ 停手回報，需另行 re-baseline 核准） |
| G4 golden（10 支） | `npx vitest run src/pine/__tests__/golden.test.ts` | 全綠（`見高K4.55` 已於 2026-10-16 re-baseline；**禁止**在本計畫中再 `UPDATE_GOLDEN`） |
| G5 增量 parity | `npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 5` | 收尾 `PARITY OK` |
| G6 **熱路徑效能**（A 的專屬風險） | 同一台機器、前後各跑一次同一組 bench，記錄 direct 總時間中位數 | 差異在噪音內（`【待實測】` 需先定方法與門檻，建議用 `--repeat 5` 取中位數並要求 <3% 或直接標「量大於噪音才 accept」） |
| G7 JIT/直譯等價 | 既有 `qa_r2`／`inc-parity`／`e2e` 全套（G1 已含）＋若可行，對同一腳本跑 direct 與 app 兩路徑比 digest | 兩路徑 digest 相同（G3 已內建 app/direct 對照） |

## 6. Rollback

- 備份：`%TEMP%/wrapA-backup-20261017/`（`interpreter.ts`、`registry.ts`、`array.ts`、`math.ts`＋md5）。
- 任一閘門不過 ⇒ 用備份還原該檔（**禁止** `git checkout/restore/stash`）；新測試可保留（回歸資產）。
- **分階段即天然回滾點**：Stage 1 不過就整批撤回宣告欄位（未宣告＝零行為差，撤回無殘留）。

## 7. 預檢

- 無憑證、無付費、無外部服務；**不改任何全域設定**。
- shell 一律 `cd /c/Users/bear9/OpenCharts && <inline>`（禁 `cwd:`、禁 `bash <file>`）。
- **機器需相對安靜**（G6 要量熱路徑）：`【待實測】` 先記錄「修前」數字；若機器負載高（今天實測過 CPU 82%、22 node），G6 直接標 `NOISY` 不宣稱結論。
- G3 副作用：`pine-bench.mjs:499` 會寫 `bench/pine/<label>.json`（既有行為）。

## 8. 驗收標準（P0）

1. Stage 1 的 6 站紅測試由紅轉綠，且**走引擎路徑**（非直呼 builtin）（`code`）
2. `npx vitest run src/pine` 全綠、passed ≥ 975（`code`）
3. `tsc --noEmit` rc=0（`code`）
4. 四支 digest 逐字不變（`code`）
5. 10 支 golden 全綠、未新增 re-baseline（`code`）
6. `s1-inc-probe` PARITY OK（`code`）
7. 熱路徑無可量測退步（G6）（`code`，若噪音大則記 `NOISY` 並在報告標明）
8. **未宣告的 builtin 行為逐值不變**（抽 5 支腳本比 digest＋G1）（`code`）
9. 已修 5 處逐站補丁可回退且測試仍綠（Stage 3）（`code`）
10. 「不改變 `ta.*`／`math.liftNums`／`nz`／`input.source` 語意」有針對性測試或既有測試背書（`jev`）

## 9. 已填入（`WrapAExternal` 實測，2026-10-17；父代理尚未複驗）

**9.1 實證結果（推論全部成真，且更嚴重）**

| 推論 | 實測 | 判定 |
|---|---|---|
| `math.tonumber(5)` → NA | **只對 string 引數有效**：`(5)`、`(x)`、`(close)`、`(true)` **全 NA** | CONFIRMED（更嚴重） |
| 高影響 6 站（`fill.length`、4×`biased`、2×`percentage`、`tonumber`） | 全部重現 | CONFIRMED |
| `array.join.separator` → 字面 `'NaN'` | `"1NaN2NaN3"`（len 9 vs 預設 7） | CONFIRMED |
| `array.slice.index_to` | size 4 → **0** | CONFIRMED |
| `math.round` 精度 | **只差 int/float kind**（值相同） | CONFIRMED（低嚴重度） |
| 站點數 | **33 → 74 站**（含 `str.*` 多處、`plot.*` 的 title/linewidth/style/linestyle/display、`input.*` 的 minval/maxval/step/options/group/inline/tooltip 等） | 更正 |

**因果分離**（可複製的判別式）：`math.tonumber(5 + 0)` → `int:5` ✅（binary expr 走 `noHist` 直通）、`math.tonumber(input.int(5,"k"))` → `int:5` ✅；而 `math.tonumber(math.abs(5))` → `na`（內層 builtin 先回 `{kind:'series'}`，外層再包一次）。失敗集合＝`{kind:'series'}`（ident／num·bool literal／需歷史者）**∪** 內層回 series 者。

**9.2 設計（A1′）**

- 宣告：`ScalarSpec{idx, names}`／判定函式 `scalarSpecHas`；收斂點＝**`callBuiltin` 單一漏斗**。
- 特例（宣告表覆蓋不到，須就地在讀取處 `unwrapped()`）：`str.format`／`log.*` 的**具名引數**（`str.ts:190` 的 `pineFormat.lookup` 拿到未 unwrap 的 `named[key]`）。

**9.3 已完成的獨立熱修（與 A1′ 無依賴）**

- `math.tonumber`：使用者裁決「立即熱修」⇒ 見 `docs` 對應紀錄與 `src/pine/__tests__` 的新測試（**小範圍，不取代 A1′**）。

**9.4 仍待補**

- **G2 `tsc --noEmit`** 在 A1′ 樹上尚未跑（落地後必跑）。
- **G6 熱路徑量法與門檻**：代理實測 `NOISY`（同樹同設定離散 11–25%）⇒ 需安靜機；門檻建議「量大於噪音才 accept，否則標 `NOISY` 且不宣稱」。
- 「不依賴 A 可先修」清單的逐項工單化（代理已給清單，尚未拆成任務）。

### 9.5 advisor 複核修正（2026-10-17，獨立複核 `HotfixAAadisor`）

**A1′ 的結構性優勢（比 0.64% 更重要）**：shadow 實作把 spec 以**函式物件**為 key（`SCALAR_BUILTINS.set(fn, …)`／`callBuiltin` 開頭 `SCALAR_BUILTINS.get(b)`），⇒ ① 別名註冊（如 `registerBuiltin('','nz')`）自動合併；② **直譯與 JIT 共用同一張表 ⇒ A1′ 不需要 JIT 鏡像**（這才是它勝過 A1 的真正理由；0.64% 只是附帶）。

**A1′ 覆蓋面（advisor 實測抽驗）**

| 站 | base | A1′ | 覆蓋 |
|---|---|---|---|
| `arr.join(n)`（method、ident separator） | `"1NaN2NaN3"` | `"1, 2, 3"` | ✅ |
| `str.join(arr, s)` | `"str:[1, 2, 3]"` | `"str:1,2,3"` | ✅ |
| `arr.slice(0, n)`／`array.slice(arr,0,n)` | `[]` | `[1,2,3]` | ✅ |
| `math.round` 精度 | kind 差、值同 | 同 | ✅ |
| `input.int(minval=lna, …)` | `{defval:5,minval:0,maxval:0,step:0}` | `{defval:5}` | ✅（**只對具名引數**） |
| `plot(close, tna)` **位置** title | `title:"NaN", linewidth:0` | `title:"NaN"` | ❌ **位置索引未宣告即未覆蓋** |
| `str.format` 具名 placeholder | 動態 key | 動態 key | ❌ **宣告表不可能命中** |

**兩類無法由宣告表覆蓋（必須就地在讀取處 `unwrapped()`）**：
1. **動態 key 的具名引數**：`str.ts:183/187`（`pineFormat.lookup`；計畫原寫 `:190` **更正為 183/187**）＋同類 `draw.ts:641`（`(cell as …)[key] = coerce(bound.get(key) ?? NA)`）。
2. **位置索引未列入宣告**者（如 `plot` 的**位置** title）——需補宣告；若某些 builtin 的位置語意特殊，逐一列出。

**數字更正／標註**
- **「74 站」= `[UNVERIFIED]`**（advisor 只能複現 `grep -c "kind === 'na'"` = 63＋`switch(…kind)` = 8；shadow 的宣告面為 **57 builtins／~111 params**）。同量級，但精確值需那份 inventory 清單；**引用時標 UNVERIFIED**。
- 0.64% **VERIFIED**（`counters.callHistWrites`：`1863/11660/0/0` → A1 為 `1851`，僅 1 支腳本有差）——且該差異是**計數器不是時間**，G6 每次皆 `NOISY`（離散 11–25%）。
- 「8 個位置」**VERIFIED**（`diff` 恰 8 個 code hunk）。A1 與 A1′ **行為等價 VERIFIED**（98/98 條 plot 逐字相同）。

**落地後必跑**：`tsc --noEmit`（A1′ 樹上尚未跑）。**→ 2026-10-17 續作已跑：rc=0（見 §11.3）。**

**§9.4 三項待補的現況（2026-10-17 續作）**

| 項 | 狀態 |
|---|---|
| G2 `tsc --noEmit` | ✅ 已跑，rc=0（§11.3） |
| G6 熱路徑門檻 | ❌ 未定；需安靜機（量測離散 11–25%） |
| 「不依賴 A 可先修」清單工單化 | ❌ 未拆成任務（清單本體＝`WrapAExternal.ClassASweep.md`，逐站含 `file:line`＋位置＋後果） |
| 第 1 類（動態 key 就地 unwrap） | ✅ `str.ts:183` 已修；`draw.ts:641` 判定無判別力故不改（§11.2） |
| 第 2 類（位置索引未宣告） | ❌ 仍在：11 個 builtin 的 `idx` 為空（§11.4）；試補已證可關閉缺口 |

## 10. 待辦：advisor 複核 → 🔒 使用者核准 → Stage 1

**狀態（2026-10-17 續作）**：使用者已核准 Stage 1 → **A1′ 已落地並通過全部閘門**，詳見 §11。Stage 2（補宣告面缺口）／Stage 3（回退逐站補丁）仍待裁決。

## 11. 落地報告（2026-10-17；原 `A1PrimeLand` 於 07:10 機器意外關機時中斷，本節為續作）

> 本節的閘門全部在續作中**重跑**，不沿用中斷前的日誌。

### 11.1 移植對照

`diff -rq src "$TEMP/wrapchk/shadow/src"` 只有三筆差異，其餘逐位元相同：

| 檔案 | 差異 |
|---|---|
| `src/pine/builtins/math.ts` | repo 多一支（`math.tonumber` 熱修，晚於 shadow 快照） |
| `src/pine/builtins/str.ts` | 本次 step 5 新增（見 11.2） |
| `src/pine/__tests__/wrap_eval_a1prime.test.ts` | 只在 repo（新測試資產） |

⇒ A1′ 的 hunk 與 shadow 相同，未夾帶 A1 的三處同步，也未夾帶並行工作流的其他改動。

落地檔案：`builtins/registry.ts`（`ScalarSpec`／`SCALAR_BUILTINS`／`registerBuiltin` 第 5 參數）、`interpreter.ts:1551`（`callBuiltin` 單一漏斗；函式物件為 key ⇒ 別名自動合併、直譯與 JIT 共用一張表）、`builtins/index.ts`（末行 import）、`builtins/scalarDeclPatch.ts`（宣告表；載入時 `57 scalar specs installed`，無 `no builtin` 警告）。

### 11.2 step 5：動態 key 的就地 unwrap

| 站點 | 處置 | 依據 |
|---|---|---|
| `str.ts:183`（`pineFormat.lookup`） | 改 `unwrapped(...)` | 判別力已驗：修前 `expected '0.25' to be '25.00%'` |
| `draw.ts:641`（`cell_set_*`） | **不改** | 四條 `coerce` 全走 `asStr`／`asColor`，兩者本就 `series → cur()`（`util.ts:156-171`）；`table.cell_set_text(t,0,0,ident)` 修前即 PASS ⇒ 無判別力，改了是無效改動 |

紅→綠：`npx vitest run src/pine/__tests__/wrap_eval_a1prime.test.ts -t "step 5"` 修前 `1 failed | 2 passed | 10 skipped`，修後該檔 **14 passed**。

### 11.3 閘門（全數重跑，07:27–07:35）

| 閘門 | 指令 | 結果 |
|---|---|---|
| G2 型別 | `npx tsc --noEmit` | **rc=0**（影子樹從未跑過的一項） |
| G1 全測試 | `npx vitest run src/pine` | **69 檔／990 passed｜1 skipped** |
| G3 digest | `pine-bench … --bars 100 --repeat 2 --warmup 2` | `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` **逐字不變**；app=direct 四支 PASS |
| G4 golden | `npx vitest run src/pine/__tests__/golden.test.ts` | **14 passed｜1 skipped**（未 re-baseline） |
| G5 增量 parity | `s1-inc-probe --script src/pine/TRIS390.pine --bars 500 --ticks 5` | **`PARITY OK`** |

原始輸出留存於 `%TEMP%/wrapA-land-20261017/`：`G1-post.txt`、`G2-post.txt`、`G3-post2.txt`、`G4-post.txt`、`G5-post.txt`、`step5-postfix.txt`。

### 11.4 宣告面覆蓋率實測（引擎路徑 A/B）

探針：`scratch/perf/wrapA-coverage-audit.mts`。手法＝同一腳本跑兩次，第二次先把該 builtin 的 `ScalarSpec` 從表中刪除（＝ A1′ 之前的行為）；兩次結果相同 ⇒ 該站未被宣告覆蓋。

| 站點 | 有宣告 | 刪宣告 | 覆蓋 |
|---|---|---|---|
| `array.variance(a, na-ident)` | 1.25 | 1.667 | ✅ |
| `array.stdev(a, na-ident)` | 1.118 | 1.291 | ✅ |
| `array.standardize(a, na-ident)` | ±1.342 | ±1.162 | ✅ |
| `array.covariance(a, b, na-ident)` | 2.5 | 3.333 | ✅ |
| `array.percentile_linear_interpolation(a, na-ident)` | `na` | 10 | ✅ |
| `array.percentile_nearest_rank(a, na-ident)` | `na` | 10 | ✅ |
| `array.fill(a, 7, 1, na-ident)` | 7 | 0 | ✅ |
| `plot(close, na-ident)`（**位置** title） | `["NaN","h"]` | `["NaN","h"]` | ❌ |
| `input.int(5, "k", na-ident)`（**位置** minval） | `{minval:0, defval:5}` | 同左 | ❌ |
| `input.int(5, "k", minval = na-ident)`（具名） | `{defval:5}` | `{minval:0, defval:5}` | ✅ |

**缺口只在呼叫端用「位置」傳引數時出現**，且僅限宣告表中 `idx: []` 的 11 個 builtin：`plot`／`plotshape`／`plotchar`／`plotbar`／`plotcandle`／`hline`／`input.int`／`input.float`／`input.price`／`input.string`／`input.enum`。

缺口可由宣告表關閉（實驗後已還原）：`plot` 補 `idx:[1,3,4,11,12,13]`、`input.int` 補 `idx:[2,3,4,5,6,7,8,10]` 後，`plot(close, na-ident)` 的標題由 `"NaN"` 變成自動名 `plot_0`，`input.int(5,"k", na-ident)` 的 `minval:0` 變成省略。

### 11.5 tb 計畫 §9.3「同族未清站點」現況

§9.3 記錄的 6 站（`variance`／`stdev`／`standardize`／`covariance`／`fill.length`／`percentile_*`）已由本次宣告表覆蓋（見 11.4）。`array.percentrank`／`includes`／`indexof`／`lastindexof`／`binary_search`／`binary_search_leftmost`／`binary_search_rightmost` 亦由宣告表覆蓋（`scalarDeclPatch.ts:28-34`，每條皆 `{ idx: [1], names: ['value'] }`）。

> **2026-10-17 修正**：本句原寫「目前由逐站補丁覆蓋，兩者不衝突」，與 §11.7 的 Stage 3（逐站補丁**已全部回退**）矛盾。現樹複驗：`array.ts` 只剩 6 處 `snap()`（line 84／107／112／120／125／135，皆非 Stage 3 對象），§11.7 表列的 236／248／306／448 已無 `snap`；`math.ts` 的 `math.tonumber` 讀 `bound.get('v')` 不帶 `unwrapped`。⇒ 覆蓋機制只有**宣告表一種**，不存在補丁與宣告並存。

### 11.6 已知殘留（**全數已裁決**；本節保留裁決歷史）

> 2026-10-17 收斂：本節原標「待裁決」，但五項全部已有結論（1／2／3／5 已修，4 定案）⇒ 標題與敘述改為歷史記錄，不再代表待辦。

1. ~~**宣告面缺口**：11 個 builtin 的位置索引未宣告（11.4）。~~ **已修（§11.8）。**
2. ~~**shim 定位**：…頭部仍寫「SHADOW-ONLY」…~~ **已修：頭部改為陳述現況（§11.8）。**
3. ~~**`plot` 位置引數**：中斷前任務書明文「不要動」，故未動。~~ **已修（§11.8，經使用者放行）。**
4. **G6 熱路徑門檻（2026-10-17 定案：用噪音底，不用絕對 %）**
   - **前置**：`node scripts/perf/quiet-gate.mjs`（3 次取樣 × 5s，門檻 25%）須全數 `ok`。2026-10-17 08:0x 實測 **31.9／46.6／31.7% ⇒ `NOISY`**，干擾來源是自身測試與子代理的 node 程序（`node=11`）；必須全部停手後再量。
   - **協定**：**交錯 A/B**（`%TEMP%/wrapchk/ab-bench.sh` 已是此形式：base → patch → base → patch），`--repeat 5 --warmup 2 --engine-path direct`，四支凍結腳本；每臂至少 **6 輪交錯**（2 輪／臂不夠）。
   - **判定**：`|Δ median| > 兩臂各自的 (max − min) 範圍` 才宣稱差異；否則記「**無可量測差異**（協定噪音 > 效果量）」，不得宣稱退步或進步。
   - **已知噪音量級**（2026-10-17 06:0x 既有資料，每臂 2 次；原始 json `scratch/perf/{abase1,abase2,apatch1,apatch2}.json`）：單腳本離散 **7–35%**，四支聚合出現 **−29%** 的假效果（A1′ 不可能真快 29%）⇒ 那是協定偽影，不是效能收益。
   - **本批的預期效果量 ≈ 0**（A1′ 只多一次 `Map.get`，同時省掉數處 per-site `unwrap`）⇒ G6 的正式結論就是「NOISY，不宣稱」；協定留在本節，供日後真正的效能改動使用。
5. ~~**Stage 3**：見 §11.7。~~ **已執行並通過閘門（見 §11.7；使用者 2026-10-17 放行）。**

### 11.7 Stage 3（回退逐站補丁）可行性實驗

試作內容（**已還原**；還原後 `array.ts`／`math.ts` 的 md5 與實驗前逐檔相同）：

| 檔案:行 | 實驗改動 |
|---|---|
| `array.ts:73` | `snap(bound.get('initial_value'))` → `bound.get('initial_value') ?? NA` |
| `array.ts:236`／`248`／`306`／`448` | `const v = snap(raw)` → `const v = raw` |
| `math.ts:304` | `unwrapped(bound.get('v'))` → `bound.get('v')` |

`?? NA` 必須保留：漏斗只做 unwrap，不會把「被省略的引數」補成 `NA`。`snap` 的定義正是 `unwrapped(v) ?? NA`（`array.ts:18`），故只有 `?? NA` 這半段不是 A1′ 的職責。

> **行號與驗證來源（2026-10-17 補記）**：上表行號為**實驗當時**的樹；本節要證的是「移除後仍綠」⇒ 現樹已無這些改動（複驗見 §11.5 的註記）。本節末段「還原後 md5 與實驗前逐檔相同」**不能用** `%TEMP%/wrapA-land-20261017/{array,math}.ts.bak` 當來源 —— 那是 07:38 的**移植前**備份，與現樹 md5 不同屬預期（現樹含 A1′ 的 `array.from` 逐元素 `snap` 等改動）。覆蓋歸屬一律以 §11.8〈覆蓋歸屬〉為準。

試作樹上的實跑結果：

| 檢查 | 結果 |
|---|---|
| 相關 4 支測試檔（`array_arg_snapshot`／`array_from_snapshot`／`math_tonumber_arg`／`wrap_eval_a1prime`） | **4 檔／20 passed** |
| G1 全測試 `npx vitest run src/pine` | **69 檔／991 passed｜1 skipped** |
| G3 四支 digest | `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` **逐字不變** |

⇒ A1′ 已取代這 6 處逐站補丁。這些測試本來是修前的紅測試（例如 `math_tonumber_arg` 修前 `expected [{kind:na}×5] to deeply equal [5,5,5,5,5]`），移除補丁後仍綠，即補丁已無作用。**Stage 3 可安全執行**。

原始輸出：`%TEMP%/wrapA-land-20261017/G1-stage3trial.txt`、`G3-stage3trial.txt`。

### 11.8 續作第二批（2026-10-17 07:4x–07:5x）：把 §11.4／§11.6 的缺口全部修掉

判別式（不需改宣告）：同一位置分別傳**字面 `na`**（一律以未包裝的 na 抵達 guard）與**綁到 na 的 ident**（被包成 `{kind:'series'}`）。兩者輸出一致 ⇒ 無缺陷。探針 `scratch/perf/wrapA-na-ident-audit.mts`。

修前 **12/14 缺陷**，修後 **0/14**：

| 站點 | 修前（ident） | 修後 |
|---|---|---|
| `plot` 位置 title(idx 1) | 標題變文字 `"NaN"` | 自動名 `plot_0` |
| `plot` 位置 linewidth(3)／style(4)／display(11) | 0／`"NaN"`／`"NaN"` | 全部不設 |
| `hline` 位置 linestyle(3)／linewidth(4) | `"NaN"`／0 | 不設 |
| `plotbar` title(4)／display(8)、`plotcandle` title(4)／display(10) | `"NaN"` | 不設 |
| `input.*` 位置 minval(2)／maxval(3)／step(4)／options(5)／group(6)／inline(7)／tooltip(8) | `0`／`0`／`0`／不填／`"NaN"`／`"NaN"`／`"NaN"` | 一律省略 |
| `draw.ts:204` `coerceIn`（`set_<prop>` 的 str prop） | `'NaN'` | `''` |
| `strategy.ts:1104` `strOf`（`id`/`from_entry`/`oca_name`/`oca_type`/`comment`/`value`，共 14 個呼叫點） | `'NaN'` | 預設值（`''`／`'entry'`／…） |

**修法**（兩種，依站點性質分開）

1. **宣告表可達的位置槽** ⇒ 補 `idx`：`plot [1,3,4,11]`、`plotshape [11]`、`plotchar [11]`、`plotbar [4,8]`、`plotcandle [4,10]`、`hline [3,4,6]`、`input.int/float [2..8]`、`input.price [2,3,4,6,7,8]`、`input.string [5,6,7,8]`、`input.enum [2,3,4,5]`（各自依 `PLOT_ORDER`／`SHAPE_ORDER`／`INPUT_ORDER`／`ENUM_ORDER`）。未列入者（如 `plotshape` 的 title）走 `bound.has('title') ? strArg(…)`，`strArg` 本身會 unwrap ⇒ 無缺陷。
2. **動態 key ⇒ 就地 unwrap**：`draw.ts:204` `coerceIn` 先 `unwrapped(v)`；`strategy.ts:1104` `strOf` 先 `unwrapped(v)`。宣告表按名字對不上這些讀取點。

**靜態收斂稽核**：全 `builtins/*` 再掃一遍 `kind ===`／`switch(.kind)`，剩下的守衛全部落在已 unwrap 的區域（`core.ts` 的 `unser`、`log.ts` 的 `cur`、`draw.ts:737` 的 `unwrapped(bound.get('points'))`、`array.ts` 的 `valueEq`/`cmp` 元素、`session.ts` 的 `ctx.syminfo`）。**（此敘述已被獨立複核推翻，見下方 F1。）** `scalarDeclPatch.ts` 頭部改為陳述現況（移除已不成立的「SHADOW-ONLY／migration table」）。

**獨立複核（`reviewer` 子代理，2026-10-17 08:0x–08:2x，只讀）**

已獨立證實的（它自己重跑，非引用本節）：

- 判別式探針 **14 列兩欄逐字相同 ⇒ 0/14**；`wrapA-coverage-audit.mts` 的 `plot` 位置 title 與 `input.int` 位置 minval 兩列已由「相同」變「不同」。
- **11 條新 `idx` 與各家族 `bindArgs` 順序零錯位**：它另寫 Part B 探針（每個 idx 塞入可辨識真值、讀回實際落點），`plot [1,2,3,4,11]`／`hline [3,4,6]`／`plotbar [4,8]`／`plotcandle [4,10]`／`plotshape [11]`／`input.int/float [2..8]`／`input.price [2,3,4,6,7,8]`／`input.string [5,6,7,8]`／`input.enum [2,3,4,5]` 全部落在正確欄位。
- `plot` 未宣告 `format(12)/precision(13)`、`input.int` 未宣告 `display(10)` **正確**（實作未讀該欄）。
- `draw.ts` `coerceIn` 的 `coord` 語意**未變**：`asNumOrNa` 首行本就是 `series → cur()`，故 `asNumOrNa(unwrapped(v)) ≡ asNumOrNa(v)`；na 座標仍保留不畫。行為差只限 `str` 的 na（`'NaN'` → `''`）。
- `str.ts:183`（step 5）無副作用：`pineFormat` 只有 `log.ts:30`／`str.ts:206` 兩個呼叫端，兩者傳入的 positional 都已 `.map(cur)`。
- 新測試 9 `it` 皆走 `parse`＋`runScript` 且斷言具體值（非 `toBeDefined`）。
- 57 條宣告全數命中已註冊 builtin（無 `no builtin '…'` 警告）；未誤觸需保留歷史的槽（`plot` series 0／`hline` price 0／`input` defval 0 皆未宣告）。

**F1（Important）⇒ 已回修（見 §11.9）**：`scalarInput` 是共用 helper，`input.bool`／`input.color`／`input.timeframe`／`input.session`／`input.symbol`／`input.text_area`／`input.time`／`input.source` 與裸 `input()` 共 **9 個註冊**同樣讀 `input.ts:115-128` 的 `minval/maxval/step/options/group/inline/tooltip`，但本批只宣告了 `input.int/float/price/string/enum`。實測（reviewer）：位置路徑 **11/59 DIFFER**、具名路徑 **2/18 DIFFER**（例：`input.bool(true,"k", v)` 的 na-ident ⇒ 寫入 `minval:0`；`tooltip = v` ⇒ `"NaN"`）。

**F2（Minor）⇒ 已回修（見 §11.9）**：`plotchar: { idx: [11], … }` 是死條目（`plot.ts:195-221` 從不讀 `display`）。

### 11.9 reviewer 回修（2026-10-17 08:1x）

| 項 | 處置 |
|---|---|
| F1 | `scalarDeclPatch.ts` 再補 9 條宣告（`input.bool/color/timeframe/session/symbol/text_area/time/source` ＋ 裸 `input`），全部 `idx: [2..8]`（`defval` 刻意不宣告 —— `input.source` 與裸 `input()` 要看它的 series 形態）。宣告面 **57 → 65** |
| F2 | 移除 `plotchar` 條目（一行），並改寫該段註解 |
| 回歸釘 | `scalar_arg_na_ident.test.ts` 9 → **11** `it`（新增 `input.color(color.red,"k",naIdent)` 位置 minval、`input.bool(true,"k", tooltip = naIdent)` 具名 tooltip） |

**回修驗證（用 reviewer 自己的探針，未改一行；探針已收進 `scratch/perf/wrapB-*.mts`，A/B 原始 json 為 `scratch/perf/abase{1,2}.json`／`apatch{1,2}.json`）**

| 探針 | 修前 | 修後 |
|---|---|---|
| `%TEMP%/wrapB-audit.mts` Part A（59 個呼叫點） | 11/59 DIFFER | **0/59** |
| `%TEMP%/wrapB-named.mts`（18 個具名路徑） | 2/18 DIFFER | **0/18** |
| `%TEMP%/wrapB-followup.mts`（未宣告槽的煙霧測試） | — | `input.source` 的 `defval` 仍為 `"close"`；`str.format` percent、`str.tostring` format 正常 |
| `scalar_arg_na_ident.test.ts` | — | **11 passed**（載入訊息 `65 scalar specs installed`） |

**回修後閘門（08:17–08:24，全數重跑）**：`tsc --noEmit` **rc=0**；`npx vitest run src/pine` **70 檔／1002 passed｜1 skipped**（上一版 1000 passed，＋2＝新增的兩條 input 回歸）；四支 digest `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` **逐字不變**（app=direct PASS）；golden **14 passed｜1 skipped**；`s1-inc-probe` **`PARITY OK`**。原始輸出：`%TEMP%/wrapA-land-20261017/{G2,G1,G3,G4,G5}-f1.txt`。

回歸釘：`src/pine/__tests__/scalar_arg_na_ident.test.ts`（**11** `it`，走 `parse`＋`runScript` 引擎路徑）。

**站點數對帳（取代 §9.5 的 `[UNVERIFIED]`）**：`WrapAExternal.ClassASweep.md` 的 class (a) 表逐列數＝**59 列／8 檔**（`str.ts` 22、`plot.ts` 12、`array.ts` 9、`input.ts` 7、`math.ts` 5、`color.ts` 2、`strategy.ts` 1、`draw.ts` 1）。§9.1 記的「33 → **74 站**」是參數級估算，沒有對應清單可複現；引用時改用 **59**。

**覆蓋歸屬**

| 家族 | 覆蓋機制 |
|---|---|
| `array.*`（9）、`math.*`（5）、`color.*`（2）、`str.*`（22，除具名 placeholder） | A1′ 宣告表（§11.1）＋ §11.2 的 `str.ts:183` |
| `plot.ts`（12）、`input.ts`（7） | 本批補的位置索引（§11.8 修法 1） |
| `draw.ts`（1）、`strategy.ts`（1） | 本批的就地 `unwrapped()`（§11.8 修法 2） |

**本批閘門（2026-10-17 07:54–08:00，全數重跑）**

| 閘門 | 結果 |
|---|---|
| G2 型別 | `npx tsc --noEmit` **rc=0** |
| G1 全測試 | **70 檔／1000 passed｜1 skipped**（上一版 990 passed，＋9＝新測試檔 9 `it`） |
| G3 digest | `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` **逐字不變**；app=direct 四支 PASS |
| G4 golden | **14 passed｜1 skipped**（無 re-baseline） |
| G5 增量 parity | **`PARITY OK`** |

⇒ 本批修的是既有語料沒踩到的路徑（四支 digest 與十支 golden 的腳本都沒把 na-ident 傳進這些槽位），故未動到既有輸出。原始輸出：`%TEMP%/wrapA-land-20261017/{G2,G1,G3,G4,G5}-fixbatch.txt`。

### 11.10 T3／T4 靜機量測（2026-10-17 08:2x，安靜閘門 `PASS`）

`quiet-gate` `samples=[14.5, 23.4, 13.3]%`（門檻 25%）、`shioaji:8080`／`vite:5173`／`jev:8787` 全 down ⇒ `PASS` 後量測；結果記於 `docs/2026-10-15-r5-fix-plan.md`〈量測結果（2026-10-17）〉。

- **T3（A3，500 根 app、repeat 5 median，對 baseline `b9fcd81`）**：K55 **4,382.5（−66.1%）** ≥50% ✅；TRIS390 **3,362.1（−51.4%）** ≥40% ✅；MACD701_v72 **884.3（−41.1%）** ≥30% ✅；四支 digest app=direct 逐字相同（`50rj53`／`3huclf`／`18qepy0`／`1kzvcjg`）✅；golden `14 passed | 1 skipped` 零差異 ✅。
- **T4（A6）**：TRIS390 live tick median **79.2 ms**、cold/live **34.1×**；K55 **92.3 ms**、**51.4×** ⇒ 兩支皆「≤100 ms 且 ≥10×」，且 `PARITY OK`。
- **殘項**：T3 的 **A4 成長倍率未量**（pine-bench 的 `growth` 為空陣列，A4 不吃這個協定；先前值 0.91–1.09 見 `docs/2026-10-15-r5-decisions.md`）。

**暫存處置（B3 結論）**：探針與 A/B 原始資料已收進 repo（`scratch/perf/wrapB-*.mts`、`scratch/perf/{abase,apatch}{1,2}.json`）；閘門日誌與 pre-port 備份留在 `%TEMP%/wrapA-land-20261017/`（§11.3／§11.9 引用）；`%TEMP%/wrapchk/` 的 4 棵影子樹（各 26 MB）**刻意保留**，作為 §11.1 移植對照的可重驗證來源。

### 11.11 QA Round 1（task-workflow P7／P8；2026-10-17 09:xx，進行中）

**流程更正**：先前曾口頭稱「P7 過」，實為**不完整**——P7 的 `code` 三條成立，但 §8 驗收第 10 條標 `jev` 的那一條（「不改變 `ta.*`／`math.liftNums`／`nz`／`input.source` 語意」）**未走受管管道**。已補跑。

| Round 1 輸入 | 狀態 | 結果 |
|---|---|---|
| P7 `code`：全測試綠／驗收逐條（code 項）／無新發現 | ✅ | `vitest run src/pine` 70 檔／1002 passed｜1 skipped（§11.9）；探針 0/14、0/59、0/18 |
| P7 `jev`：驗收 #10 | ✅ | 受管管道 `taskwf-accept` → **`noul = 0.87`⇒ 成立**（payload／結果留 `%TEMP%/jev-accept-10.json`；證據＝宣告表 65 條中無 `ta.*`／`nz`／`math.liftNums`、`input.source` 只宣告 `[2..8]` 且 `defval` 刻意不宣告、全套測試與四支 digest／golden 不變、`wrapB-followup.mts` 顯示 `input.source(close)` 的 defval 仍為 `'close'`） |
| P8 視角一：正確性（`RevCorrectness`） | ⏳ 跑中 | — |
| P8 視角二：安全（`RevSecurity`） | ⏳ 跑中 | — |
| P8 視角三：可維護性（`RevMaintainability`） | ⏳ 跑中 | — |

**收斂規則**：三視角皆無 Critical／Important 才算收斂；發現先過受管 JEV `taskwf-review`（嚴重度 `choice` ＋ 成對 `noul` 去重）；只有 C/I 回修（回修→回歸→再審），上限 3 輪；第 3 輪仍有 ⇒ 停損、剩餘發現交使用者裁決。**Minor 只記錄。**

### 11.12 QA Round 2（P8 再審；2026-10-17 11:xx）

三視角對「回修後的樹」再審：R2 正確性（`RevClose`）、R2 新面（`RevNew`）。結果：**Critical 0**；Important 3（其中兩條同根因）、Minor 2。

| # | 發現 | JEV 分級 | 處置 |
|---|---|---|---|
| R2-I1 | **混用具名＋位置時解包錯位**：`ScalarSpec.idx` 語意是「家族 order 槽」，但 `callBuiltin` 拿它索引**原始位置陣列**；`bindArgs` 卻把位置參數填進未被具名佔用的槽 ⇒ 該解包的槽漏掉，F-A 的錯分支在該路徑復活（`plot(series = close, na)` 的 title 變 `"NaN"`，連 `fill()` 依賴的 plot sink 識別鍵都變）。探針 **5/5 混用案例 diverge** | **Important 0.91**；「是否需契約級修法」noul **0.83（true）** | **已修（見下）**；advisor（MiMo 2.6 Pro）選 **B**：order 收進 spec、漏斗自行換算位置→槽 |
| R2-I2 | 守門 `FAMILY_ORDER` 漏 `input.string`／`input.price` 兩鍵（**恰是 F-A 修的那兩條**）⇒ it(3) 靜默跳過 | **Important 0.99**（RevClose 同一事判 Minor ⇒ 以受管 JEV 為準） | 已補兩鍵＋新增「`FAMILY_ORDER` 每鍵必須是真條目」斷言 |
| R2-I3 | 守門檢不出 **under-declaration**（F-A 的 bug 類可無聲復發）：突變 M3／M4 全綠 | **Important 0.89** | 新增第 4 個 `it`：`input.*` 七槽完整性（機械推導自 `INPUT_ORDER`）＋`names` 重複斷言；檔頭改寫成精確覆蓋聲明 |
| R2-M1 | 46 條 array./math./str./color. 的 idx 對位無守門；`names` 重複未檢查 | Minor | `names` 重複已加斷言；其餘併入 R2-I1 的 order 覆蓋 |
| R2-M2 | `interpreter.ts:1545` 註解仍寫「Params declared `scalar` in the registry」（F-B 刪除前的措辭） | Minor | 已改寫 |
| — | `registerBuiltin` 死參數 `scalar` 殘留（4 號參數形狀相同被誤傳成 `HistSpec`，10 個 fn 受影響） | Minor（Round 1 M5） | 本輪精確化：`HistSpec` 與 `ScalarSpec` 形狀同為 `{idx,names}` ⇒ tsc 抓不到；行為由「scalar 優先」掩蓋，僅多餘 `callHist` 寫入 |

**R2-I1 的修法（使用者選「B 收斂：只補有暴露風險的家族」）**

- `ScalarSpec` 增 `order?: readonly string[]`（`registry.ts`）；新增 `positionalSlots(order, named, argCount)` —— 鏡射 `bindArgs` 的「具名先佔槽」與 `series`→`source` 別名，回傳「原始位置 → order 槽」。
- `callBuiltin`：無具名參數時仍走 `args[ix]` 快路徑；有具名且該 spec 帶 `order` 時，先換算再解包（順帶修掉「不該解包的槽被錯位壓平」）；未帶 `order` 者維持原行為。
- **暴露面量測**：65 條有 idx，其中 42 條的 idx 非「0 起連續前綴」（唯一會被錯位影響的形狀）⇒ 全數補 `order`（19 條直接重用家族常數，23 條為字面清單，其 order 逐一由 `array.ts`／`math.ts`／`str.ts` 的實作讀出）。
- 新守門斷言：**非前綴 idx 必須帶 order**，且 order 長度須能覆蓋其 idx、須包含自己的每個 name（把「未建模集合」變成顯式）。

**驗證（回修後）**

| 檢查 | 結果 |
|---|---|
| `RevClose` 的 `mixed-arg-probe.mts`（7 例） | **0/7 differing**（修前 5/5 diverge） |
| 突變自證（暫存副本 `%TEMP%/mutC`） | `M3`（`input.string` 退回修前 `[5,6,7,8]`）**轉紅**；`M6a`（idx 8→9）**轉紅**；`M4`（非 input 家族 under-declaration）仍綠 ⇒ 已在檔頭明列為未覆蓋 |
| `maint-audit` 167 槽／`drift-audit`（A)(B)29 條、(C)=`NO-SPEC plotchar`、(D) 0/3／`rev-probe` 0/45／`wrapA` 0/14／`wrapB` 0/59／具名 0/18 | 全數不退步 |
| **五閘（11:33–11:41）** | `tsc --noEmit` **rc=0**；`vitest run src/pine` **1007 passed｜1 skipped**（前一版 1005 ⇒ ＋2＝新增的兩個 `it`）；四支 digest `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` **逐字不變**（app=direct PASS）；golden **14 passed｜1 skipped**；`s1-inc-probe` **`PARITY OK`**。原始輸出：`%TEMP%/wrapA-land-20261017/{G2,G1,G3,G4,G5}-r2.txt` |

**本輪留下的已知缺口（記帳，未修）**

1. `histSpecHas`（`interpreter.ts:1531`）仍以「原始位置＝order 槽」配對 `HistSpec` —— 與 R2-I1 同形的**既有**問題，需要同一套 `order` 管線接到 `HistSpec`（本輪只做 scalar 側；已寫進守門的 NOT-caught 清單）。
2. 非 `input.*` 家族的 under-declaration 仍無單測覆蓋（期望槽集不可由匯出 order 推導）⇒ 依賴執行期探針。
3. 行為影響評估：兩者皆非本次改動引入；缺口 1 的後果是多餘／缺少 `callHist` 追蹤，非錯分支。

### 11.13 QA Round 3（P8 再審＋回修；2026-10-17 12:xx）

`tier=heavy`（nodes 6）⇒ 三視角並行；第 2 次回頭重入前已記 `advisor P8`。**0 Critical、2 Important、5 Minor**（Minor 全部記帳不修）。

| # | 發現（視角） | JEV | 處置 |
|---|---|---|---|
| R3-I1 | **`math.round` 走 append 模型，被 `order` 錯位解包 ⇒ 歷史壓平**（`R3-RevGuard`）。`math.round(number = 2, close)` 的 `args[0]`（表內**未宣告**的 `number` 槽，實作讀歷史 `math.ts:129`）被壓平，`ta.sma` 整體偏移一根 bar（H4 `102..105` vs H5 `101..104`）。**R2 引入**（R2 前 raw-index 映射恰與 append 模型一致） | 內部一致：**Important** | ✅ 修：`scalarDeclPatch.ts` 收回 `math.round` 的 `order`（附模型說明）＋ `scalar_spec_integrity.test.ts` 新增 `APPEND_MODEL` 顯式豁免與反向斷言（豁免鍵必須是真條目且仍無 `order`） |
| R3-F2 | **具名解包漏 `series=`→`source` 別名**（三視角共同發現）。`bindArgs`（`util.ts:222`）與 `positionalSlots`（`registry.ts:60`）都做 canon，唯獨 `callBuiltin` 的具名迴圈沒有 ⇒ `str.contains(series = naIdent, "x")` 得 `false`、`source = naIdent` 得 `na`（`str.ts:254` 的 `kind==='na'` 守衛看穿包裝）。**先於 R2**，影響 names 含 `source` 的 7 個 `str.*` | **Important 0.97**（另兩位評 Minor ⇒ 以受管 JEV 為準） | ✅ 修：具名迴圈加 canon（僅當宣告名為 `source` 且未顯式給 `source=`），寫回原鍵 |

**驗證（兩條修正後）**

| 檢查 | 結果 |
|---|---|
| `scratch/perf/wrapC-mixed-alias-audit.mts`（新收進 repo） | `H4 == H5 == H6 == H7` 皆 `["NaN","NaN","101","102","103","104"]`（＝pre-R2，偏移消失）；`C1 == C2 == NaN`、`C3 == C4 == true`、`C5 == C6` |
| `tsc --noEmit` | rc=0（過程中抓到 `APPEND_MODEL` 宣告未接線，已修） |
| `scalar_spec_integrity.test.ts` | **5 passed** |
| 探針 6 項 | `maint-audit` 167 槽 DIFFER 0／`drift` 0 misalign、`(C)=1`＝`NO-SPEC plotchar`、`(D)` 0/3／`rev-probe` 0/45／`wrapA` 0/14／`wrapB` 0/59／具名 0/18 |
| **五閘（12:31–12:40）** | `tsc` rc=0；`vitest run src/pine` **1007 passed｜1 skipped**；四支 digest **逐字不變**（app=direct PASS）；golden 14｜1；`PARITY OK`。原始輸出：`%TEMP%/wrapA-land-20261017/{G2,G1,G3,G4,G5}-r3.txt` |
| JEV 去重 | `same_root_cause`（R3-F2 與已關閉的 R2-I1）noul **0.44**（邊界）⇒ 升級我判：**同類不同面**（canon／placement 規則散在 `bindArgs`／`positionalSlots`／具名迴圈三處），各自修、共用同一條語意 |

**三視角的獨立結論**：`R3-RevOrder` 23/23 字面 `order` 與實作逐條一致、19 條常數 7/7 全查一致、`positionalSlots` ≡ `bindArgs`（11+1 邊界、3010 組合 0 分歧）、R2-I1 **closed**；`R3-RevGuard` 三個新守門斷言皆以突變自證會紅（`M1a`/`M1b`／`M2a-c`／`M3`），前綴條目不誤判，並列出仍漏抓者（`D1a`/`D1b`/`D2`/`D3a`/`D3b`）；`R3-RevSecurity` 跨執行狀態**無可達**的 series→純值壓平（IncSnap／checkpoint／sink 鍵一致）、Pine 路徑無新增動態執行／外部 I/O。

**本輪新增的 Minor 記帳（皆不修）**

1. `histSpecHas`（`interpreter.ts:1531`）仍以「原始位置＝order 槽」配對 `HistSpec` —— 與 R2-I1 同形的既有問題。
2. 非 `input.*` 家族的 under-declaration 無單測覆蓋（`D1a`/`D1b` 突變仍綠）。
3. `named[n]` 原型鏈裸讀（`interpreter.ts:1570`）：`__proto__` 向量僅被 lexer 的 `KEYWORDS` 表意外擋下。
4. `positionalSlots` 成本：最壞 8.44 µs/call；JIT 路徑在無具名參數時仍付 0.25 µs/call（`interpreter.ts:2603/2624/2645/2805`）。
5. `liftNums` append 模型的**既有**參數對調語意（TV 應為 `round(2, close)`，引擎兩版皆 `round(close, 2)`）——非本次引入，修它需改 `liftNums` 綁定語意。
6. `order` 同長度但錯名字（`D3a`/`D3b`）只能靠人工對照（本次 R3-RevOrder 已逐條做過）。

**R4 窄幅再審（`R4-RevRound3Fix`，探針預算 ≤4）⇒ 0 Critical／0 Important／0 Minor，P8 收斂**

| 驗收項 | 結論 |
|---|---|
| I1 歷史壓平 | ✅ 修好：四種拼法包 `ta.sma(…, 3)` 全為 `["na","na",101,102,103,104]`（前兩根 na 證明 window 真在讀歷史，`close` 未再被壓平） |
| 豁免守門 | ✅ 會紅：刪 `array.slice` 的 `order` → 紅於 unbacked（`:117`）；`APPEND_MODEL` 改假鍵 → 紅於 unbacked（fail-safe，先被擋）；**假鍵＋把 `math.round` 的 `order` 加回** → 紅於 stale 斷言（`:121`），證明該斷言可達且抓「豁免活過頭」 |
| F2 完備性 | ✅ `sc.names` 含 `source` 的 7 條全受惠（`replace`／`replace_all`／`contains`／`startswith`／`endswith`／`pos`／`match`）；顯式 `source=` 優先＝改前逐字相同；不誤傷（`ta.sma(series = close, 3)` ≡ `ta.sma(close, 3)`、`nz(series = naIdent, 5)` = 5） |
| 新缺陷 | ✅ 無：`named` 每次呼叫新建、`EMPTY_NAMED` 凍結且 canon 明確跳過、壓平冪等、下游 `bindArgs` 另建 Map |

**R4 列出的殘留風險（皆改前既有，不屬本次兩修法，未修）**

1. 【最重要】**`liftNums` 按「呼叫順序」append（`math.ts:100`）**：`math.round(precision = 2, number = close)`、`math.round(number = close, 2)` 得 `round(2, close)`≈2，與引擎自身 UDF／`bindArgs` 的 named-to-slot 契約（`util.ts:197-199`、`interpreter.ts:1757-1765`）**語意相反**；若 TV 真按 named-to-slot，則連 R3 釘住的 `math.round(number = 2, close)` ≡ `math.round(close, 2)` 本身都可疑 ⇒ 建議對照 TV 文件後再定案。
2. `hasP`（`math.ts:210-212`）漏看經 `number=` 送達的 precision ⇒ 混用拼法在非整數結果會被 `toInt` 截斷。
3. 豁免 stale 斷言對「假鍵」類突變會先被 unbacked 擋（fail-safe；其獨立價值在「真條目補了 `order`」與「鍵被刪」）。
4. `histSpecHas` 的 raw-index 對映（＝§11.13 缺口 1）。

## 12. commit 準備（草案；**未執行 commit**）

### 12.1 未提交現況

| 類別 | 數量 |
|---|---|
| tracked 已改（`M`） | **39**（`src/pine` 26、`src/services` 2、`scripts` 7、`docs` 4） |
| untracked（`??`） | **107**（其中 `src/`＋`docs/`＋`scratch/` 共 46） |

**本輪（A1′ 線）觸及的檔案**：`M` `src/pine/builtins/{registry,plot,input,index}.ts`、`src/pine/interpreter.ts`；`??` `src/pine/builtins/scalarDeclPatch.ts`、`src/pine/__tests__/scalar_spec_integrity.test.ts`、`scratch/perf/wrapC-mixed-alias-audit.mts`。

**關鍵限制**：兩條主線混在同一棵樹，且 **`src/pine/interpreter.ts` 兩線都動**（R5 的 checkpoint／`trimCw`／`argSites`，加 A1′ 的 `callBuiltin` 漏斗）⇒ **檔案粒度切不開**。

### 12.2 建議

- **一個 commit**。要拆成兩個需 `git add -p` 逐 hunk 挑（成本高、易漏），且 `interpreter.ts` 的 hunk 高度交錯。
- 動筆前請先確認：`src/services/shioaji/*`、`src/pages/VelaPage.tsx`、`scripts/*` 這幾支是否屬於本批主題（否則應另開 commit）。
- 下列 R5 條目**彙整自 `PROGRESS.md` 各輪紀錄**，非本次續作所驗；送出前請覆核。

```
pine: converge builtin arg wrapping at one funnel; land R5 engine debt

Option A (docs/superpowers/plans/2026-10-17-wrapeval-option-a.md):
- ScalarSpec declaration table + a single unwrap funnel in callBuiltin, keyed
  by the function object so aliases share one spec and the JIT needs no mirror
- declare the positional option slots of plot/hline/plotbar/plotcandle/plotshape
  and every input.* registration that reads them
- carry each family's bindArgs order in the spec so the funnel resolves a
  positional to its order slot when a named arg claims a lower one (review R2:
  raw positional index is not the slot); families that bind through liftNums
  (math.round) are exempt by name instead, because their named args are appended
- canonicalise `series=` to `source` in the named unwrap too (review R3-F2)
- unwrap in place where the key is chosen at runtime (draw coerceIn,
  strategy strOf)
- drop the six per-site unwraps the funnel now covers (array.new keeps its
  `?? NA` fallback for the omitted-argument case)
- guard it: scalar_spec_integrity.test.ts asserts every declared name resolves,
  idx/names stay in lockstep, each idx matches its family order, every input.*
  option slot is declared, and every non-prefix idx carries an order

R5 engine debt (docs/2026-10-15-r5-fix-plan.md P1-P10):
- series.ts: IncSnap length watermark so a doubly-rewound tf frame cannot alias
  an untrimmed buffer
- ta.ts: bound dvs/stv memo growth; latch the wring guard
- mtf.ts: resetPeak/trimCw keep spec.cw constant instead of Theta(bars)
- plot/draw/engine/strategy: layer-accurate na handling, table/polyline
  serialization, execution ledger into IndicatorModel.trades

Gates: tsc rc=0; vitest run src/pine 1007 passed | 1 skipped;
digests 1e63vl8/kb0glc/1580h2/p4gddl unchanged (app == direct);
golden 14 passed | 1 skipped; s1-inc-probe PARITY OK.
```

（閘門數字已於 P8 R1/R2/R3 三輪回修後重跑填入；送出前若樹又有改動需再跑一次。）

## 13. 交付摘要（P9；2026-10-17 13:xx）

**advisor P9（`opencode-go/mimo-v2.6-pro`，`completion(model="slow")`）= READY: conditional** —— 閘門全綠、R1–R4 發現全關、殘留風險皆屬既有；唯一阻塞是**流程面**（樹混合 option-A 與 R5 兩條主線、未 commit）。它點名：**「人工對照過 order 名」不得當成已驗證覆蓋**。已記入 `taskwf_gate.py advisor P9`。

### 13.1 已驗證（附證據）

| 項 | 證據 |
|---|---|
| 五閘（最終樹） | `tsc --noEmit` rc=0；`vitest run src/pine` **1007 passed｜1 skipped**；四支凍結腳本 digest `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` **逐字不變**（app=direct PASS）；golden **14 passed｜1 skipped**；`s1-inc-probe` **`PARITY OK`** |
| 宣告面／漏斗行為 | `maint-audit` **167 槽 DIFFER 0**；`drift-audit` 0 misalignment（`(C)=1`＝`NO-SPEC plotchar` 為刻意；`(D)` 0/3）；`rev-probe` **0/45**；`wrapA` **0/14**；`wrapB` **0/59**、具名 **0/18**；`wrapC` 混用＋別名 8 個案例全符合期望 |
| 混用解包（R2-I1） | `plot(series = close, na)` 等 5 個鑑別案例：修前 DIFFER → 修後 SAME；`R3-RevOrder` 亦以 3010 組合證明 `positionalSlots` ≡ `bindArgs`（11+1 邊界 0 分歧） |
| `order` 忠實度 | `R3-RevOrder` 逐條核對 **23/23 字面 order** 與實作一致、**19 條常數 7/7** 全查一致 |
| 守門有效性 | 突變自證：`M1a/M1b`（刪 order）紅、`M2a/M2b/M2c`（input.* 七槽／F-A 形狀）紅、`M3`（假鍵）紅、`M4x`（前綴判別力）紅；`R4` 補證「假鍵＋order 加回」紅於 stale 斷言 |
| 兩條 R3 Important 的修法 | `math.round` 四種拼法包 `ta.sma(…,3)` 全 `["na","na",101,102,103,104]`；`series=` 與 `source=` 七個 `str.*` 一致且不誤傷 `ta.*`／`nz` |

### 13.2 未驗證（含可自行執行的檢查）

| 項 | 現有證據到哪 | 讀者可跑的檢查 |
|---|---|---|
| 非 `input.*` 家族的 under-declaration、以及 `order` 內**同長度錯名** | 突變 `D1a`／`D1b`／`D3a`／`D3b` 皆**綠** ⇒ 盲點已**明示**（非「人工看過」） | 在 `%TEMP%` 副本刪 `plot` 的 `display` 一對（或把 `PLOT_ORDER` 兩名互換），跑 `vitest run src/pine/__tests__/scalar_spec_integrity.test.ts` ⇒ 應綠 |
| `histSpecHas`（`interpreter.ts:1531`）仍以 raw 位置配對 `HistSpec` | 四支 digest 逐字不變、golden 14｜1 ⇒ **只能說「未影響凍結語料」**，不能宣稱 history 語意正確 | 找一個 `HistSpec` 為 `{idx,names}` 的函式，以「具名佔低槽＋位置落宣告槽」呼叫，比對 `callHist` 寫入數 |
| `source=` 與 `series=` **並存**的改前/改後 runtime A/B | `R4` 以程式碼等價（`interpreter.ts:1576-1578` 與改前同構）＋現行為釘住（`source="xx", series="ab"` → `true`；反序 → `false`） | 於改前 commit 跑同一對腳本比對 |
| `liftNums` append 綁定 vs TV 文件 | `math.round(precision = 2, number = close)` 得 `round(2, close)`，與 UDF／`bindArgs` 的 named-to-slot 相反（改前既有） | 對照 TV 手冊的 named-argument 綁定規則，決定誰才對 |
| T3／T4 效能量測 | 已完成但**前提是安靜機**（quiet-gate PASS）；重跑需先確認 `shioaji:8080`／`vite:5173`／`jev:8787` 全 down | `node scripts/perf/quiet-gate.mjs` |

### 13.3 改過的設定（原值與還原方法）

| 檔案 | 改動 | 還原 |
|---|---|---|
| `~/.omp/agent/config.yml` | `modelRoles` 新增 `slow:` 與 `advisor:` ＝ `opencode-go/mimo-v2.6-pro`（原本兩者皆無） | 刪掉這兩行；備份 `config.yml.bak-20261017-*` 在 `~/.omp/agent/` |
| `C:\Users\bear9\task-workflow.md`（P8 節） | 新增「子代理命名帶輪次前綴 `R<輪次>-…`」一條 | 刪該條 |
| `OpenCharts/.taskwf/state.json` | `tier: heavy`、`advisor: {P8:1, P9:1}`（新檔；先前此目錄無 state） | 刪 `.taskwf/` |
| repo 工作樹 | `M` 39／`??` 107（option-A 與 R5 兩主線混合，**未 commit**） | 依 §12 草案 commit；未提交即等於未落地 |

### 13.4 阻塞（不屬本輪可解）

1. **commit 邊界**（§12 草案已備）：需使用者核准一個 commit 或 `git add -p` 切兩個。
2. 依 (1)：`strategyEquity` 的超二次項（R2 殘項）、R1 的真實 ≥1000 根 tape（需 `shioaji:8080`）。

**後續工單**：上述阻塞項與 §11.13 的全部 Minor 已整理成可照單施工的工單 —— `docs/2026-10-17-wrapc-followup-workorder.md`（每條含症狀／證據／根因／修法／驗收／風險，並標明全部卡在 commit 邊界）。
