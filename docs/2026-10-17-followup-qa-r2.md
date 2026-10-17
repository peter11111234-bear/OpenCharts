# wrapC 後續工單 QA 報告（P7 第二次，2026-10-17 18:4x–19:0x；回修後）

> 前一版 `docs/2026-10-17-followup-qa.md` 的 A2 結論已被 P8 R1 取代，本檔為**回修後**的驗收。
> 變更：R2-FixGuard（註解孤兒／fixture 死表項／守門反向斷言）＋ R2-FixA2（A2 記帳語意：逐 bar 結清＋遲到成交截尾回寫）。
> 原始輸出：`<tmp>/wrapc-qa-r2/{G1,G2,G3,G4,G5}.txt`；突變：`<tmp>/wrapc-mut/mut-*.log`（driver `<tmp>/ocrev/mut-driver.mjs`）。

## 驗收標準逐條

| # | 驗收標準 | 路由 | 指令／證據 | 結果 |
|---|---|---|---|---|
| 1 | B7：`array.ts` 四處兩段式綁定收成單次 `bound.get` | code | `grep -c "const raw = bound.get('value')" src/pine/builtins/array.ts` ⇒ **0** | **PASS** |
| 2 | B3：41 條 `order` 全部來自家族匯出常數；41/41 檢查；「order ≡ 家族常數」斷言；突變 D3a′／D3b 紅、未覆蓋槽改名綠 | code | `grep -c "order: \["` ⇒ 0；`order: [A-Z_]` ⇒ 41；`scalar_spec_integrity.test.ts` **7 passed**；突變 D3a2 紅（`array.slice: idx 1 → order 'index_to', declared 'index_from'`）、D3b 紅、D3c／D3d 綠 | **PASS** |
| 3 | B2：fixture（清表導出，144 槽／51 家族）＋單向斷言；突變 D1a／D1b 紅 | code | 同檔 7 passed；突變 D1a 紅（`plot[11] display (not in names)`）、D1b／D1c 紅、D1d 綠（多加宣告） | **PASS** |
| 4 | A2：`equityCurve` 不再從 0 重放；四支 digest／golden／`inc-parity` 不變 | code | `grep -c "shifted\|equityAt" src/pine/builtins/strategyEquity.ts` ⇒ **0**；G3/G4/G5 見下表 | **PASS** |
| 5 | A2：`sink[b]` 與凍結 oracle 逐位元相同（**R1 曾證偽，回修後重驗**） | code | 5 個 A2 測試檔 **95 passed**（含 7 個 R1 重現／矩陣 it，先紅後綠：`scratch/_r2-a2-red.txt` → `-green.txt`）＋ R2 複審自建兩劇本（checkpoint/rollback、同 bar 雙事件）逐 bar `Object.is` 相符 | **PASS** |
| 6 | 全測試綠（非只有新增測試綠）＋`tsc` rc=0 | code | G1 **72 檔／1021 passed｜1 skipped**（回修前 1014 ⇒ ＋7）；G2 **rc=0** | **PASS** |
| 7 | 未動 plan 外檔案；未改 `bindArgs`／漏斗／`histSpecHas` 語意 | jev→code | `git status --short -- src docs` ＝ plan §5 清單（10 改＋3 新）；R2-RevGuardFix 複核「自造 dead code／孤兒清零」 | **PASS**（JEV 未再呼叫：含 file:line 的宣稱由主代理程式抽驗） |

## 五閘（回修後）

| 閘 | 結果 |
|---|---|
| G1 `npx vitest run src/pine` | **72 files / 1021 passed \| 1 skipped**（342 s） |
| G2 `npx tsc --noEmit` | **rc=0** |
| G3 `pine-bench`（4 腳本／100 bars／repeat 2／warmup 2） | **`1e63vl8`／`kb0glc`／`1580h2`／`p4gddl`**，app＝direct 全 **PASS**（逐字不變） |
| G4 `vitest run src/pine/__tests__/golden.test.ts` | **14 passed \| 1 skipped** |
| G5 `s1-inc-probe --script src/pine/TRIS390.pine --bars 500 --ticks 5` | **PARITY OK** |

## 突變自證（回修後樹；9 案例）

| id | 期望 | 實測 |
|---|---|---|
| D1a／D1b／D1c | red | **red**（fixture／lockstep 斷言） |
| D1d（多加宣告） | green | **green** |
| D3a′（`ARRAY_SLICE_ORDER` 兩名互換） | red | **red** |
| D3b（order 由常數換漂移字面） | red | **red** |
| D3c（字面逐元素相同）／D3d（改未覆蓋槽） | green | **green** |
| M4x（非前綴 idx 無 order） | red | **red** |

**mismatches: 0/9**

## P8 R2 複審結論（只審本輪 diff）

- `R2-RevA2Fix`（正確性）：**0 Critical／0 Important／0 Minor**，判定 correct（信心 0.86）；自建兩劇本（checkpoint rollback 交路、同 bar 雙事件）逐 bar `Object.is` 相符；確認規則輸入時點＝「成交 ≤ b」與 oracle 一致、無新 look-ahead。
- `R2-RevGuardFix`（可維護性）：**0 Critical／0 Important／2 Minor**（皆註解措辭：fixture 檔頭 `array.*` 敘述、it#7 註解可達性）；孤兒與自造 dead code 清零；新斷言非恆真。

## 殘留風險（記錄不修）

1. **多 bar 回寫**（`strategy.ts:1023-1027`）：若未來允許倒序單據／倒序成交（需放寬 `BarCtx` 前進約束），`rb < riskBar` 各格會寫入含後段 realizedPnl 的值；今日不可達（`context.ts:163` forward-only）。
2. **`inc-parity.test.ts:209` fuzz 覆蓋不足**：只命中 SimCache 四條失效分支中的 forming-bar OHLC；orders 減／增／清空未自動化（R2 以手動劇本等價覆蓋）。
3. **`docs/2026-10-17-followup-qa.md`（前一版）** 的 A2 結論已作廢，勿引用。
4. **A2 效能縮放未量**（機器非安靜、`equityAt` 已刪無從計數）。
5. **A2 tick 語意屬刻意行為改變**（同 bar 再讀 dd/runup 反映新 OHLC），已由 it 釘住。
6. 兩處 Minor 註解措辭（見 R2-RevGuardFix 表）未修，記錄在案。
