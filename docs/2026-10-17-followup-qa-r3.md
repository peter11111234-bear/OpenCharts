# wrapC 後續工單 QA 報告（P7 第三次，2026-10-17 20:2x–20:4x；P9 advisor 必補項後）

> 變更（本輪唯一 diff）：`src/pine/__tests__/strategy_equity_stepper.test.ts` —— 新增 3 支「SimCache 失效分支」定向測試（orders 減／增／空）＋ `oracleMismatches()` helper。**其中 2 支在停用分支自證時未轉紅（對分支不敏感），已改寫成可分辨情境**（詳見下節）。
> 前一版 `docs/2026-10-17-followup-qa-r2.md` 的五閘與突變結論仍有效（本輪只動測試檔）；`docs/2026-10-17-followup-qa.md` 已作廢。
> 原始輸出：`<tmp>/wrapc-qa-r3/{G1,G2,G3,G4,G5}.txt`；突變：`<tmp>/wrapc-qa-r3/mut-9.txt`、`mut-BR.txt` 與 `<tmp>/wrapc-mut/mut-*.log`（driver `<tmp>/ocrev/mut-driver.mjs`）。

## 驗收標準逐條（本輪）

| # | 驗收標準 | 路由 | 指令／證據 | 結果 |
|---|---|---|---|---|
| 1 | advisor P9 必補：SimCache 三條失效分支（orders 減／增／清空）各有定向測試 | code | 該檔由 10 it → **13 it**（`npx vitest run src/pine/__tests__/strategy_equity_stepper.test.ts` ⇒ **13 passed**）；三支各自斷言曲線長度＋`oracleMismatches()` 逐 bar `Object.is` | **PASS** |
| 2 | 該三支測試必須「停用對應分支 ⇒ 轉紅」（否則等於沒守到） | code | 突變批次 `<tmp>/ocrev/batch-stepper.json`（`strategy.ts` 三個分支改 `if (false)`／刪 `cache.equity.length = 0`）⇒ **3/3 red、0 mismatch**（`<tmp>/wrapc-qa-r3/mut-BR.txt`） | **PASS**（首版 2/3 mismatch，見下） |
| 3 | 本輪不得動非測試檔；既有驗收不得退步 | code | `src` 內 18:56 後僅該測試檔有 mtime 變更（掃描 1 檔）；五閘見下表（digest／golden／parity 逐字不變） | **PASS** |
| 4 | 既有 9 案例突變不退步 | code | `<tmp>/wrapc-qa-r3/mut-9.txt`：D1a／D1b／D1c／D3a′／D3b／M4x 紅、D1d／D3c／D3d 綠 ⇒ **0/9 mismatch** | **PASS** |
| 5 | 全測試綠＋`tsc` rc=0 | code | G1 **72 檔／1024 passed｜1 skipped**（r2 的 1021 ⇒ ＋3）；G2 **rc=0** | **PASS** |

### 首版 2/3 mismatch 與修法（本輪唯一發現的 Important，已就地修復）

| 突變 | 首版實測 | 為何不敏感 | 修法 |
|---|---|---|---|
| `BR-shrink`（停用 orders 縮短分支） | green（應紅） | 情境選 `[100,101,102,103]`＋平倉落 bar3 開盤＝bar3 收盤 ⇒ 「已平倉」與「未平倉」的 mark 恰好同值，memo 交回的舊曲線也滿足 oracle | 改為 1% 手續費＋bar3 開盤 110（平倉付 1.1% 出場費）：平倉 100007.9 vs 未平倉 100009，兩者可分辨 |
| `BR-append`（停用 orders 追加分支） | green（應紅） | 斷言前多讀了一根 bar4 ⇒ resume 路徑重新處理新單並用 `applyFill` 截尾回寫補回 bar3，分支被繞過 | 斷言移到「同一根 bar 重讀」之後、延伸 walk 之前（此路徑只有該分支會清 memo／drop run） |
| `BR-none`（停用無 orders 分支的清曲線） | red ✓ | — | 未改 |

## 五閘（本輪樹）

| 閘 | 結果 |
|---|---|
| G1 `npx vitest run src/pine` | **72 files / 1024 passed \| 1 skipped**（292.7 s） |
| G2 `npx tsc --noEmit` | **rc=0** |
| G3 `pine-bench`（4 腳本／100 bars／repeat 2／warmup 2） | **`1e63vl8`／`kb0glc`／`1580h2`／`p4gddl`**，app＝direct 全 **PASS**（逐字不變） |
| G4 `vitest run src/pine/__tests__/golden.test.ts` | **14 passed \| 1 skipped** |
| G5 `s1-inc-probe --script src/pine/TRIS390.pine --bars 500 --ticks 5` | **PARITY OK** |

## P8 R3 再審（本輪 diff＝測試檔；**由主代理自審，非獨立子代理**）

子代理無法派出：`opencode-go` 全日額度用盡（`mimo-v2.6-pro`／`deepseek-v4.1-flash` 皆回 `429 Go usage limit exceeded, retry-after-ms≈1.3e8`，三次嘗試後依停損改為主代理自審）。以此為限。

| # | 發現 | 級別 | 處置 |
|---|---|---|---|
| 1 | 新增的 `BR-shrink`／`BR-append` 兩支測試對其分支**不敏感**（停用分支仍綠）⇒ 表面覆蓋但無守門力 | Important | **已修**（上節）；改後 3/3 red |
| 2 | `strategy.risk.max_cons_loss_days` 不滿足 A2 的 oracle 逐位相等，且 sink 值隨讀取樣式改變（隨機差分 1200 劇本：除該規則外 0 mismatch；`strategy.ts:784` 的 `b === uptoBar` 閘門＋可 resume 的逐 bar 交錯） | **Important（新，超出本輪 diff）** | **未動，交使用者裁決**：`docs/2026-10-17-followup-consloss-finding.md`；handoff §4.8 |
| 3 | 前輪守門修正（F3 註解／F4 `GUARDED_SLOT_ORDER` 22 條／F5 反向斷言）複核 | 無發現 | 22 條與 `FAMILY_ORDER` 完全不重疊、51 個 `GUARDED_SLOTS` 家族全落在兩表中之一、41 個帶 `order` 的條目全部有 `FAMILY_ORDER` key（反向斷言非恆真） |
| 4 | 文件去識別（F6）殘留 | Minor | `C:/Users/bear9/jev-laya-bench/taskwf_gate.py` 在 handoff §3／progress-report 各一處未去識別（handoff §2 的 F6 敘述只提到 G3 路徑）；`%TEMP%` 出現於 handoff §4.6 與 workorder §C（語意正確、非路徑外洩） |

- 測試品質複核：`oracleMismatches()` 以凍結 oracle（非受測碼路徑）逐 bar `Object.is`，非恆真；`BR-none` 斷言 `length 0` ＋ `max_drawdown 0`，停用分支即紅。

## 受管 JEV（`jev_judge.py`，2026-10-17 20:5x）

| gate | 題 | 結果 |
|---|---|---|
| `taskwf-review` | 發現 #1（兩支分支測試不敏感）嚴重度 | **Important**（信心 0.63；機率 Important 0.72／Critical 0.21） |
| `taskwf-review` | 發現 #2（`max_cons_loss_days` 差分）嚴重度 | **Important**（信心 0.88；Important 0.91） |
| `taskwf-review` | 去重 noul（#1 與 #2 同根因？） | 0.38（低於 0.5、低信心）⇒ 依規則升級主 LLM：**不同根因，保留兩條** |
| `taskwf-accept` | 「QA 報告每條驗收都有具體證據」 | **0.80（true）** |

請求內容：`<tmp>/wrapc-qa-r3/jev-review2.json`、`jev-accept.json`。首跑把多標籤塞進單一 `label` 鍵，JEV 原樣回傳 `label`（格式誤用），改為每標籤一鍵後取得上表結果。

## 殘留風險（記錄不修）

1. **`max_cons_loss_days`（見上 #2）**：待裁決；在此之前，「oracle 逐位相等」的適用範圍應視為「除該規則外」。
2. **本輪 P8 為自審**（子代理 429）；獨立視角缺一輪。
3. r2 報告的殘留風險 1–6 仍成立（多 bar 回寫不可達、fuzz 覆蓋、A2 效能縮放未量、tick 語意為刻意改變、兩處註解措辭未修）。
4. `BR-shrink` 的數值（100007.9／100009）依賴 1% 手續費與 bar3 開盤＝收盤 110 的構造；改 `mkBars` 語意時需同步。
