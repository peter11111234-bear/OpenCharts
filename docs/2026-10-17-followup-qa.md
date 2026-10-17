# wrapC 後續工單 QA 報告（P7，2026-10-17）

- 受測樹：`<repo>`（未 commit；動工前備份 `<tmp>/wrapc-followup-backup-20261017-151610/`＋md5）
- 原始輸出：`<tmp>/wrapc-qa/{G1,G2,G3,G4,G5}.txt`；突變：`<tmp>/wrapc-mut/`（`batch.json`＋`mut-<id>.log`）
- 驗收標準來源：`docs/2026-10-17-followup-plan.md` §0（P0）

## 驗收標準逐條

| # | 驗收標準 | 路由 | 指令／證據 | 結果 |
|---|---|---|---|---|
| 1 | B7：`array.ts` 四處兩段式綁定收成單次 `bound.get`；五閘綠、digest 逐字不變 | code | `grep -c "const raw = bound.get('value')" src/pine/builtins/array.ts` ⇒ **0**；G1/G2/G3/G4/G5 見下表 | **PASS** |
| 2 | B3：41 條 `order` 全來自家族匯出常數（單一來源）；`idx↔names↔order` 覆蓋 41/41；新增「order ≡ 家族常數」斷言；B3-D3a′／D3b 紅、未覆蓋槽改名綠 | code | `grep -c "order: \[" src/pine/builtins/scalarDeclPatch.ts` ⇒ **0**；`grep -c "order: [A-Z_]"` ⇒ **41**；`FAMILY_ORDER` 41 keys；`scalar_spec_integrity.test.ts` **7 passed**；突變 D3a2/D3b/D3c/D3d | **PASS** |
| 3 | B2：fixture（由「清表後 DIFFER」導出）＋新 `it`（宣告 ⊇ 必要）；突變 D1a／D1b 轉紅 | code | fixture = 144 必要槽／51 家族（65 家族×308 槽掃描）；同一檔 **7 passed**；突變 D1a/D1b/D1c 紅、D1d（多加宣告）綠 | **PASS** |
| 4 | A2：`equityCurve` 不再從 0 重放；縮放由超二次降為線性；四支 digest／golden／`inc-parity` 不變 | code | `grep -c "shifted\|equityAt" src/pine/builtins/strategyEquity.ts` ⇒ **0**；5 測試檔 **88 passed**；oracle 逐 bar `Object.is`（S-A/S-B/S-G）＋規則觸發字面值 `11.69999999999709`；G3/G4/G5 見下表 | **PASS**（縮放量測見「未驗證」1） |
| 5 | 全測試綠（非只有新增測試綠）＋`tsc` rc=0 | code | G1 **72 檔／1014 passed｜1 skipped**（基線 1007 ⇒ ＋7 新測試）；G2 **rc=0** | **PASS** |
| 6 | 未動 plan 外檔案；未改 `bindArgs`／漏斗／`histSpecHas` 語意 | jev | JEV 今日額度已盡（15:14 `daily_cap`）⇒ 依 skill fail-open，改 code 判：`git status --short -- src docs` 顯示我方變更＝plan §5 清單（7 改＋3 新：plan／fixture／stepper 測試），無 plan 外邏輯變更 | **PASS**（JEV 降級） |

## 五閘

| 閘 | 指令 | 結果 |
|---|---|---|
| G1 | `npx vitest run src/pine` | **72 files / 1014 passed \| 1 skipped**（294.8 s） |
| G2 | `npx tsc --noEmit` | **rc=0** |
| G3 | `npx tsx scripts/perf/pine-bench.mjs --script scratch/perf/app-scripts/script-a1dcdea6-95114.pine --script src/pine/TRIS390.pine --script "C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine" --script final.pine --bars 100 --repeat 2 --warmup 2` | digest **`1e63vl8`／`kb0glc`／`1580h2`／`p4gddl`**，app＝direct 全 **PASS**（基線逐字不變） |
| G4 | `npx vitest run src/pine/__tests__/golden.test.ts` | **14 passed \| 1 skipped**（32.0 s） |
| G5 | `npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 5` | **PARITY OK** |

## 突變自證（沙盒 `<tmp>/wrapc-mut`，driver 逐案套用→跑守門→還原）

| id | 內容 | 期望 | 實測 | 訊息節錄 |
|---|---|---|---|---|
| D1a | `plot` 刪 `display` 一對 | red | **red** | `['plot[11] display (not in names)']` |
| D1b | `str.substring` 刪 `end_pos` 一對 | red | **red** | `expected [ Array(1) ] to deeply equal []` |
| D1c | `plot` idx 少 11（idx/names 不對稱） | red | **red** | lockstep 斷言＋fixture |
| D1d | 多加一個非必要槽（`histbase`） | green | **green** | 7 passed（單向斷言） |
| D3a′ | `ARRAY_SLICE_ORDER` 內 `index_from`/`index_to` 互換 | red | **red** | `array.slice: idx 1 → order 'index_to', declared 'index_from'` |
| D3b | `plot` 的 `order` 由常數換成漂移字面 | red | **red** | it#7 逐元素比對 |
| D3c | `plot` 的 `order` 換成與常數逐元素相同的字面 | green | **green** | 7 passed |
| D3d | `ARRAY_SLICE_ORDER` 改 slot 0（無 idx 指到） | green | **green** | 7 passed |
| M4x | `array.new` idx 改非前綴且無 `order` | red | **red** | `['array.new']` unbacked |

**mismatches: 0/9**

## 未驗證／偏離（誠實列記）

1. **未驗證：A2 的效能縮放數字**（`replaySteps` 100／200／500 或 `equityAt` 呼叫數）。原因：機器非安靜（G3 報告自標 `NOISY`），且現行樹已無 `equityAt`／`shifted` 可數（`grep` ⇒ 0）⇒ 以「code 判＋oracle 逐值等價」替代；安靜機（`quiet-gate` PASS）後可補量。
2. **實作機制偏離計畫字面（S2）**：計畫寫「`src.length < cache.len` 時從 0 重折」，但 `simAt` 對 forming bar 是「同步 truncate→reextend」，`equityCurve` 觀測不到長度回捲 ⇒ 實作加 **`lastEq` 移動尾端守衛**（尾端值變了才重折）。行為符合計畫意圖，成本 O(B) 僅在 tick／orders 變動時。
3. **刻意語意改變（已釘住）**：tick 後同 bar 再讀 `max_drawdown`／`max_runup` 反映新 OHLC（今日沿用第一次值）⇒ 新 it 固定。
4. **非我方改動（未納入本輪驗收）**：`docs/2026-10-17-wrapc-followup-workorder.md` 新增 §C（omp judge／JEV 設定探索）、`src/pages/VelaPage.tsx`、`src/services/shioaji/{candles,feed}.ts`、`src/services/nautilusClient.ts`、`src/pages/velaNautilusBacktest.ts`（第三工作流／使用者本人改動，動工前即在樹上）。
5. **收斂判據 #3（本輪無新發現）**：本輪新發現＝2 條設計面 blocker（B3 驗收不可達、B2 表不存在），皆已在 P5 計畫內改寫並以突變證實；未留下新 bug／新 unknown ⇒ 成立。
