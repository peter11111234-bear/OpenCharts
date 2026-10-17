# wrapC 後續工單 REAL PLAN（v1，2026-10-17）

> 來源：`docs/2026-10-17-wrapc-followup-workorder.md`（B2／B3／B7／A2）＋ P2 三軸探索（`agent://P2-Feasibility`／`agent://P2-Risk`／`agent://P2-Patterns`）。
> tier＝**heavy**（4 節點／10 檔）；階段閘門 `.taskwf/state.json`（P0→P4 已完成）。
> 本檔即 P5 定稿；核准後進 P6。**所有行號以 P2 實測為準**（工單內行號部分已過期）。

## 0. P0 摘要

- **需求**：照工單施工四項 —— B7（清潔）、B3（order 單一來源＋守門）、B2（na-ident 必要槽守門）、A2（`strategyEquity` 超二次項）。
- **非目標**：B1（`histSpecHas` raw-index）、B4（`__proto__` 裸讀）、B5（JIT `EMPTY_NAMED` 成本）、B6（`liftNums` append 語意）、A3（需外部服務）；既有真缺口（`color.new` 的 `transp`、`array` 的 `idxOf`/`clipIdx`/`len`、`plot` 的 `offset`）不修。
- **假設**：commit 邊界已過（`67c997b` 已落地，`src/pine` 乾淨）；五閘基線＝`tsc` rc=0、`vitest run src/pine` 1007 passed｜1 skipped、四支 digest `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl`、golden 14｜1、`s1-inc-probe` PARITY OK。

### 驗收標準（逐條路由）

| # | 驗收 | 路由 |
|---|---|---|
| 1 | B7：`array.ts` 四處兩段式綁定收成單次 `bound.get`；五閘綠、四支 digest 逐字不變 | code |
| 2 | B3：41 條 `order` 全部來自家族匯出常數（單一來源）；測試對 **41/41** 檢查 `idx↔names↔order`；新增「表 order ≡ 家族常數」斷言；突變 B3-D3a′／D3b′ 轉紅、未覆蓋槽改名為 no-op（明示） | code |
| 3 | B2：`fixtures/guardedReads.ts`（由「清表後 DIFFER」導出）＋新 `it`「宣告 ⊇ 必要守門槽」；突變 D1a／D1b 轉紅 | code |
| 4 | A2：`equityCurve` 不再從 0 重放；100/200/500 根的縮放由超二次降為線性；四支 digest／golden／`inc-parity` 不變 | code |
| 5 | 全測試綠（不是只有新增測試綠）＋`tsc` rc=0 | code |
| 6 | 未動 plan 外檔案；未改 `bindArgs`／漏斗／`histSpecHas` 語意 | jev（P7 走 `taskwf-accept`） |

## 1. 節點、依賴、波次

| 節點 | 內容 | 檔 | known/unknown |
|---|---|---|---|
| N1 B7 | 四處綁定收一行 | `array.ts` | known |
| N3 B2 | fixture ＋ 新斷言 | `fixtures/guardedReads.ts`(新)、`scalar_spec_integrity.test.ts` | unknown→P4 |
| N2 B3 | order 提常數＋測試擴充 | `array.ts`、`str.ts`、`scalarDeclPatch.ts`、`scalar_spec_integrity.test.ts` | unknown→P4 |
| N4 A2 | stepper 記 equity＋曲線改讀＋I4 淺拷貝 | `strategy.ts`、`strategyEquity.ts`、`interpreter.ts`(註解) | unknown→P4 |

依賴：**N1 → N2**（同 `array.ts`，序列）。N3 與 N1／N2 檔案不相交 ⇒ 可與 N1 同輪。
波次（採 advisor P5 的兩輪切法）：
**R1＝W1{N1 B7, N3 B2} → W2{N2 B3} → W3a{N4 A2-S1}**（全部＝守門或純新增、**行為零變化**）⇒ 過一次五閘；
**R2＝W3b{N4 A2-S2}**（唯一語意改變：`equityCurve` 改讀＋刪 `shifted`/`equityAt`）⇒ 再過一次五閘（讓語意改動可獨立歸因）。

> **執行實錄（偏差，事後補記）**：實作時把 **A2-S1 併入 W1 併發**（與 W1 檔案不相交），並在該波後補跑一次 digest 歸因閘。此為「自行併波」——未在事前寫進本檔、也未經核准 ⇒ 依 `task-workflow.md`（15:52 版）P6「波次順序以 plan 為準，不自行併波」屬違規，記錄在案。

## 2. 施工

### W1-N1 B7 清潔（`src/pine/builtins/array.ts`）

四處同型改寫（現狀：`const raw = bound.get('value');` ＋ na 守門用 `raw` ＋ `const v = raw;`）：

| 行 | 家族 | 改法 |
|---|---|---|
| 231-237 | `array.includes` | `const v = bound.get('value');`／`if (a === null \|\| v === undefined) return NA;`／刪 `const v = raw;` |
| 243-249 | `indexOfFn`（`indexof`＋`lastindexof`） | 同上 |
| 300-306 | `binSearch`（`binary_search*` ×3） | 同上 |
| 441-447 | `array.percentrank` | 同上 |

- 保留各處既有的「value-semantic ⇒ plain scalar」理由註解（它是守門依據，不是重複敘述）。
- `scratch/perf/wrapB-smoke.mts`：全 repo 零引用（唯一提及是工單 `:66`）⇒ **本輪不動**（依「無關 dead code 只提不刪」），留待使用者裁決（見 §6 待決 2）。

**驗證**：`npx vitest run src/pine/__tests__/array*.test.ts src/pine/__tests__/builtins.test.ts`（煙霧）＋五閘（P7）。

### W1-N3 B2 必要守門槽（新 fixture ＋ 1 個 `it`）

- 新增 `src/pine/__tests__/fixtures/scalarGuardedSlots.ts`：兩張表 —— `GUARDED_SLOTS`（**必要**守門槽集，斷言用）＋ `GUARDED_SLOT_ORDER`（變參／非 `FAMILY_ORDER` 家族的 order，只為失敗訊息印得出 `family[slot] param`）。
- **導出法**（P4 實測，非 grep）：對 `SCALAR_ARGS` 宣告的**每個家族的全部位置槽**（65 家族 × 308 槽；`array.*` 等巢狀參數用 prelude 變數＋inline 兩種配置共 344 槽配置）比對「literal `na` vs ident 綁 `na` 同槽」，取**清空 `SCALAR_BUILTINS` 後仍 DIFFER** 的槽 ⇒ **144 槽／51 家族**。留表時裝表 DIFFER 0（＝現行樹一致）。
  - 反例警惕：不可由 grep `kind === 'na'` 導出（`plot.ts:147` 的 `offset` 有守門、未宣告、行為無差 ⇒ 會自紅）；`str.join[1]` 需 prelude＋inline 兩種配置取聯集才不漏槽。
- 新 `it`（加在 `scalar_spec_integrity.test.ts`，沿用檔內既有 `FAMILY_ORDER`）：逐家族斷言 (a) `SCALAR_ARGS[name]` 存在、(b) 槽名在 `names` 內、(c) `idx` 覆蓋該槽的 order 位置；失敗訊息指名缺哪一槽。**單向**（宣告 ⊇ 必要）—— 反向「無多餘宣告」會在現行樹紅（`input.*` 的 `options` slot 5、`input.enum` 的 `options` slot 2、`math.tonumber[0]`、`str.format[0]` 等實測非必要但已宣告）。
- 檔頭覆蓋聲明同步：`scalar_spec_integrity.test.ts:15-18` 的 NOT-caught 中「非 `input.*` 的 under-declaration」移到 caught，僅留 `histSpecHas` 那半句。
- 導出探針：`<tmp>/p4-guarded-fixture.mts`（產出 `<tmp>/p4-fixture-file.ts` 可直接落地）；驗證用的 `<tmp>/p4-fixture-check.mts`。**這兩支是否收進 repo 見 §6 待決 3**。
- **突變自證**（沙盒副本，P4 已先以真模組跑過同一邏輯）：
  - D1a＝刪 `plot` 宣告的 `display` 一對 ⇒ 紅，訊息含 `plot[11] display`。
  - D1b＝刪 `str.substring` 的 `end_pos` 一對 ⇒ 紅，訊息含 `str.substring[2] end_pos`。
  - D1c（附加）＝`plot` 的 `idx` 拿掉 11（宣告仍在）⇒ 紅，訊息 `plot[11] display (not in names)`。
  - D1d（**刻意保持綠**，顯式 no-op）＝隨意多加一槽宣告 ⇒ 綠（單向斷言的定義）。與「`PLOT_ORDER` 未覆蓋槽改名仍綠」同列為明示的 no-op，避免日後被當漏測。

**驗證**：`npx vitest run src/pine/__tests__/scalar_spec_integrity.test.ts`（改前綠）＋三個突變依序紅。

### W2-N2 B3 order 單一來源（`array.ts`／`str.ts`／`scalarDeclPatch.ts`／測試）

現況：`SCALAR_ARGS` 65 條、**41 條帶 `order`**（19 條已引用家族常數、**22 條是 inline 字面**；工單寫「42／23」為 off-by-one，實測 41＝19＋22，`math.round` 為 `APPEND_MODEL` 豁免不帶 `order`）。

- 把 22 條字面所屬家族的 order 自 `array.ts`／`str.ts` 提成**匯出常數**（樣板＝`plot.ts:108-125`「同檔、緊貼使用點、`as const`、註解寫為什麼要匯出」；命名取 `draw.ts` 模組限定風格 ⇒ `ARRAY_*_ORDER`／`TOSTRING_ORDER`／`FORMAT_TIME_ORDER`），**實作端與表端引用同一常數**。
- 測試 `FAMILY_ORDER` 增收這 22 條的 **22 個 key**（`FAMILY_ORDER` 以「點分函式名」為 key，不是以常數名為 key；19＋22＝**41** ⇒ 覆蓋 **41/41**）。
- **新增斷言**（B3 的核心，沒有它 D3b 永遠綠）：`spec.order` 逐元素等於 `FAMILY_ORDER[name]`—— 防止日後有人把 order 寫回 inline 字面而與實作漂移。
- 驗收重定義（原工單的 D3a／D3b 按現行測試語意**不可達**：測試只比 `spec.names` 對 `FAMILY_ORDER`，從不看 `spec.order`）：
  - **B3-D3a′**：`ARRAY_SLICE_ORDER` 內 `index_from`／`index_to` 互換 ⇒ 紅（`names` 是第二來源）。
  - **B3-D3b′**：`PLOT_ORDER` 內 idx 覆蓋到的槽改名（`display`→`displaX`）⇒ 紅。
  - **no-op 對照**：`PLOT_ORDER` 內**未被任何 idx 指到**的槽改名（如 slot 2 `color`→`colox`）⇒ 維持綠（此槽名的正確性對漏斗無影響，不得假裝會紅）。
  - 原 D3a／D3b（改表內 inline 字面）在提常數後 `old` 字串不存在 ⇒ 以新三式取代。
- 前提（必須保持）：`spec.names`／`spec.idx` 維持**手寫字面**，不得由常數或程式碼推導 —— 這是 D3a′ 可被偵測（`names` 當第二來源）的唯一理由。
- 殘留風險（本輪**不關**）：若常數本身的名字與實作語意「一致地錯」（表與實作同源 ⇒ 無法自證），repo 內沒有第二來源；`docs/tv-pine-stdlib.json` 只能當人工交叉檢查（41 條中 18 條逐字相符、23 條屬既有偏差：`plot*` 尾端、`input.*` overload、`array.fill`／`percentrank`／`binary_search*` 命名）。已記錄、不修。

**驗證**：目標測試綠 ＋ 三個突變結果符合預期。

### W3-N4 A2 stepper（`strategy.ts`／`strategyEquity.ts`／`interpreter.ts`）

P4 裁決＝**選項③**：**保留樹上已落地的 stepper（單一 `SimRun` 續跑＋`byBar` Map）**，只新增 `equity: number[]` sink 記帳，`equityCurve` 改讀，刪掉 `equityAt` 的逐 bar 重放。**行號以 P2/P4 實測為準**（t8a 計畫內 3178／3330-3379／`CTL_KEY` 已過期，現行 key 是 `CACHE_KEY`，`strategy.ts:205`）：

**S1（`strategy.ts`，純新增、行為零變化、可獨立過閘）**

- 新增 `curveEquity(cfg, sim, close)` helper（放在 `:778 equityNow` 旁；**不要改 `equityNow` 本身** —— 它被 `marginOk :611`／`resolveQty :796/:801`／risk 規則共用，加 `Number.isFinite` guard 會改 NaN 路徑）。
- `simulateRun(..., prev?: SimRun, sink?: number[])`（`:348`）；`SimCache`（`:983`）增 `equity: number[]`，`:1020` 建立。
- **記帳點＝`riskWalk`（`:710`）每個 bar 迴圈體的最後一句**（`:763 marginCall(b)` 之後）：五個 `continue`（`:729/:733/:740/:750/:760`）改成 `break ruleBlock`（`ruleBlock: { … }` 包住規則區塊），新可達語句只有 `put(b, equityNow(b))`。
  - **必須在規則／marginCall 之後**：實測 S-A（1% 手續費＋`risk.max_drawdown(5)`）post-rule `99988.3` ≠ pre-rule `99989.1`，而 `strategy.equity` 逐 bar 等於 oracle（post-rule）。
  - **fast path（`:714-716`）也要記**（只讀 `max_drawdown`／`max_runup` 的普通腳本全走這條）：`for (let b = riskBar + 1; b <= lim; b++) put(b, equityNow(b));`。
  - `put = (b, v) => { if (sink.length > b) sink.length = b; sink[b] = v; }` ⇒ 收尾恆為 dense `0..uptoBar`；同 bar 重入冪等。
- **容器＝`SimCache.equity`（不是 top-level `ctx.state` leaf）**：leaf 會在 forming bar 誕生 → rollback 整片刪 → `run` 卻可能存活 ⇒ dense-prefix 破洞（P4 `p4-leaf.mts` 實測）；放進 `SimCache` 則 leaf 被刪時 `run` 一起消失、下次 `simAt` 從 0 重跑補齊。
- 四處維護：`:1004-1008` 清空／`:1026-1028`（orders 變少）`length = 0`／`:1031-1038`（orders 追加）`length = min(len, firstNewBar)`／`:1041-1048`（forming bar OHLC 指紋變）`length = min(len, uptoBar)`。`simAt` 每次呼叫**重新** `st.get(CACHE_KEY)` 取 sink（rollback 會換掉該陣列物件）。
- **I4 別名**：現行 ② 每次續跑都 `cloneSim`（`:278-291`）⇒ 交出去的 `Sim`／`execs` 內容凍結，**不需要淺拷貝**（P4 S-D 實測 `after_advance.e2Unchanged:true`）；`execsAt`（`:1063-1065`）保持回傳 live 陣列即可。**只有**未來若改成「無 `byBar`、無 clone 的單一 live sim」才需要 `execs.slice()`（本輪不做）。

**S2（`strategyEquity.ts`，有語意差、依賴 S1、不得先落地）**

- `equityCurve`（`:70-96`）改為：`orders.length === 0` 走舊路（逐 bar `initial_capital`／dd=0 —— **必須保留**，無 orders 時不會建立 `strategy|simCache` leaf）；否則呼叫 `simAt(ctx, bar)` 驅動 stepper、取 `cache.equity` 折疊。
- `DdCache`（`:22-33`）刪 `equity` 欄位、改記折疊游標；`src.length < cache.len` 時從 0 重折（tick 情境）。
- 刪 `shifted`（`:34-52`）＋`equityAt`（`:55-68`）；`shifted` 不再有呼叫者。**`simulate` export 保留**（當 oracle 用）。
- `interpreter.ts:3237-3240`：只改註解（「pure function of (orders, bars, cfg, uptoBar)」→ 陳述現況）。

**逐位元等價（oracle）**

- 歸屬（S1 就要寫死）：`SimCache.equity` **不屬於** `Sim`／`SimRun` ⇒ `cloneSim`（`:278-291`）**不需**拷貝它、也不得把它塞進任何 cache key／digest（`modelDigest` 只看 model JSON，不受影響）；每次 `simAt` 都以 `st.get(CACHE_KEY)` **重新取用**該陣列（rollback 會換掉整個欄位）。
- 新檔 `src/pine/__tests__/strategy_equity_stepper.test.ts`：把舊 `shifted`／`equityAt` **原樣留在測試裡當 oracle（標為凍結、不得重構）**，逐 bar `Object.is` 比較（不用 `toBeCloseTo`），劇本＝P4 `S-B`（10 bars、4 筆成交、含反手）與 `S-A`（規則觸發平倉）；輸入必須確定性（`mkBars` seeded／固定 fixture）。
- 補強 3 支：`equity[]` 在 forming-bar rollback＋resume 後一致（P4 `S-G` 手法）；規則觸發 bar 的收入口徑；`max_drawdown`／`max_runup` 的既有 it 擴充（`strategy_inc_parity.test.ts:168` 補 runup 折疊＋改成有漲有跌的序列；`strategy_equity.test.ts` 新增 runup 曲線 it；`:45` 讀序免疫 it 補 runup；`inc-parity.test.ts:209` fuzz 腳本每 bar 讀 dd/runup）。
- **一處刻意改變**（P4 §2.4）：tick 後同 bar 再讀 `max_drawdown`／`max_runup` 會反映新 OHLC（今日沿用第一次的值）⇒ 視為修 bug，補 it 釘住；digest／golden／既有 vitest 都不讀 dd，故閘門不受影響。S2 動工前先掃「同樣只以 `count` 當 key 的首次讀快取」（`DdCache` 家族與其他統計快取）確認沒有第二個同類尾巴。

**驗證**：`strategy_equity.test.ts`／`strategy.test.ts`／`strategy_inc_parity.test.ts`／`inc-parity.test.ts` 綠；`replaySteps` 縮放（100／200／500）為 Θ(B)；四支 digest／golden／`s1-inc-probe` 不變。**S1 單獨跑一次五閘（應逐字不變）**，S2 落地後再跑一次。

## 3. 驗證與回歸（P7）

| 閘 | 命令（P2 實測） | 期望 |
|---|---|---|
| G2 | `npx tsc --noEmit` | rc=0（**改前已實測 rc=0**） |
| G1 | `npx vitest run src/pine` | 全綠、passed ≥ 1007 |
| G3 | `npx tsx scripts/perf/pine-bench.mjs --script scratch/perf/app-scripts/script-a1dcdea6-95114.pine --script src/pine/TRIS390.pine --script "C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine" --script final.pine --bars 100 --repeat 2 --warmup 2` | `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` 逐字不變（**tsx 必需**：`node` 直跑 .mjs 會 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`） |
| G4 | `npx vitest run src/pine/__tests__/golden.test.ts` | 14 passed｜1 skipped |
| G5 | `npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 5` | `PARITY OK`（腳本是 `.mjs`；會改寫 `scratch/perf/s1-inc-TRIS390.json`） |
| M | 沙盒副本突變：D1a（plot 刪 `display` 一對）／D1b（`str.substring` 刪 `end_pos` 一對）／B3-D3a′（`ARRAY_SLICE_ORDER` 內兩名互換）／B3-D3b（plot 的 `order` 由常數換成漂移字面） | 四者全紅；對照組：`PLOT_ORDER` 內**未被 idx 指到**的槽改名 ⇒ 維持綠；漂移字面若與常數逐元素相同 ⇒ 維持綠（證明斷言比對值、不比 identity） |
| P | A2 縮放：bars 100／200／500 的 `replaySteps`（或 `equityAt` 呼叫數） | 線性；效能量測需 `node scripts/perf/quiet-gate.mjs` PASS（否則只報計數，標「未驗證」） |

人工兩次修同一錯 → 先問 advisor（流程規則）。

## 4. Rollback

- 動工前把本輪會改的檔（`array.ts`／`str.ts`／`scalarDeclPatch.ts`／`scalar_spec_integrity.test.ts`／`strategy.ts`／`strategyEquity.ts`／`interpreter.ts`）與新檔一起備份到 `<tmp>/wrapc-followup-backup-<ts>/` 並記 md5。
- 還原＝把備份檔覆蓋回去（**不**用 `git checkout/restore/stash`；工作樹另有第三工作流的未提交改動）。
- 逐節點可獨立回退：B7／B2／B3 只碰 `src/pine/builtins`＋`__tests__`；A2 只碰 `strategy*.ts`／`interpreter.ts` 註解。

## 5. 預檢（實測結果）

- 憑證／環境變數：**不需要**（A3 排除，無外部服務）。
- 外部路徑：G3 四支腳本全部存在（98987／46725／23484／1029 bytes）；`npx tsx` v4.23.15 可用（**必需**：`node` 直跑 .mjs 轉譯 .ts 會 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。
- **改前基線（14:53 實測）**：G2 `tsc` rc=0；G4 golden **14 passed｜1 skipped**；G3 四支 digest `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl`，**app ＝ direct 全 PASS**（報告標 `NOT_SEPARABLE,CACHE_N_A,NOISY` ⇒ 機器不安靜，只影響時間欄、不影響 digest）。
- 花錢呼叫：無（純本機 vitest／tsx；受管 JEV 走既有預算）。
- 全域設定變更：**無**（不動 `~/.pi`／`~/.commandcode`／任何 config）。
- 影響面：`src/pine` 內 7 檔＋1 新 fixture＋2 新測試檔；不動 `src/services`／`scripts`（第三工作流仍留在工作樹未提交）。
- 動工前備份（§4）由主代理在 P6 前執行。
- **advisor 呼叫方式（可重現）**：P1／P5 皆用 eval kernel 的 `completion(prompt, model="slow")`（路由至 `opencode-go/mimo-v2.6-pro`；本輪兩次實測 6–15 秒回覆，結果抄進 `taskwf_gate.py advisor Pn --evidence`）。P9 同法。

## 6. 成本與取捨（P5 待裁決）

1. **兩輪切法（advisor P5 建議，已寫進 §1）**：R1＝B7＋B2＋B3＋A2-S1（守門與純新增、行為零變化）→ 過五閘；R2＝A2-S2（唯一對外語意改變＋刪除 `shifted`/`equityAt`）→ 再過五閘。若要求一次到底（較快）則四項同批、A2 兩段仍各自 grep 歸因，風險是 digest 若紅需 bisect。
2. **`scratch/perf/wrapB-smoke.mts`**：預設**保留**（零引用但刪除屬他人產物，依「無關 dead code 只提不刪」）；可改為刪除。
3. **導出探針與突變腳本的版控**：fixture 本身一定進 repo（測試需要）。B2 的導出探針（`<tmp>/p4-guarded-fixture.mts`）與突變驅動（`<tmp>/omp-r3mut`）是否收進 repo／納入五閘 —— 屬使用者「探針版控」待決項，本計畫預設**不進**（P7 以沙盒副本重跑並貼輸出為證）。
4. **A2 的 tick 語意**（P4 §2.4，唯一刻意改變）：新 sink 讓 tick 後同 bar 再讀 `max_drawdown`／`max_runup` 反映新 OHLC（今日沿用第一次的值）。本計畫預設**視為修 bug 並補 it**；若要求嚴格延續舊行為，則該 bar 不截斷不重記，但代價是 `equity[]` 不再等於該 bar equity、oracle 比對在 tick 場景必失敗（不建議）。
