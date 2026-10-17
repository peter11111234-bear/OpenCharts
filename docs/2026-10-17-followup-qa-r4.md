# wrapC 後續工單 QA 報告（P9 addendum，2026-10-17 20:4x；advisor P9 裁決後）

> 用途：`advisor P9` 裁決（走選項 ①）後落地的**唯一變更**是 `src/pine/__tests__/strategy_equity_stepper.test.ts`（新增 1 個 `it` 釘住 `max_cons_loss_days` 的刻意語意改變＋檔頭補 oracle 例外聲明）。**生產碼零變動**。
> 前一版 `docs/2026-10-17-followup-qa-r3.md` 的五閘結論對**產品路徑**仍有效（本檔只重跑受影響的閘，理由見下）。

## 變更與驗證

| # | 驗收標準 | 路由 | 指令／證據 | 結果 |
|---|---|---|---|---|
| 1 | advisor 裁決 ① 落地：`max_cons_loss_days` 的新（因果）行為被測試釘住 | code | `strategy_equity_stepper.test.ts` 由 13 → **14 it**；新 `it` 逐 bar `Object.is` 釘住 `[100000, 99998.06, 99998.06, 99988.04 ×8]`，並釘住「`sink[3] === equityAt(3)`」、「`equityAt(5) === 99979.96`」、「`sink[5] !== equityAt(5)`」 | **PASS** |
| 2 | 改變範圍限於該測試檔（不得動生產碼） | code | `src` 於 20:20 後的 mtime 掃描 ⇒ **僅 `src/pine/__tests__/strategy_equity_stepper.test.ts`** | **PASS** |
| 3 | 型別與全測試仍綠 | code | G2 `npx tsc --noEmit` ⇒ **rc=0**；G1 `npx vitest run src/pine` ⇒ **72 檔／1025 passed｜1 skipped**（r3 的 1024 ⇒ ＋1） | **PASS** |
| 4 | 產品行為不得退步 | code | 生產碼零變動 ⇒ 沿用 r3 的 G3／G4／G5：digest **`1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` 逐字不變**、golden **14｜1**、`s1-inc-probe` **PARITY OK**（`<tmp>/wrapc-qa-r3/{G3,G4,G5}.txt`）；依 `task-workflow.md`「小改動（單一測試檔）只跑相關測試」**未重跑**這三閘 | **PASS**（未重跑，理由如上） |

## 受管 JEV

- `taskwf-accept` noul「QA 報告對每條驗收標準都有具體證據」= **0.80（true）**（r3 執行，判定沿用）。
- `taskwf-review`（r3）兩條發現皆 **Important**（0.63／0.88）；去重 noul 0.38 ⇒ 主 LLM 判不同根因。

## 殘留風險

1. 本輪 P8 為**主代理自審**（子代理全日 429）；獨立視角仍缺一輪。
2. `max_cons_loss_days` 的**讀取樣式相依**屬已裁決的刻意行為（不是 bug fix 的反面）：新曲線是單一因果歷史，舊 `equityAt` 逐 bar 重算會自我矛盾。若之後要讓它讀取樣式無關，需改 `strategy.ts:784` 的 run-end 閘門，並重跑完整五閘。
3. r2 報告殘留 1–6 與 r3 報告殘留 1–4 仍有效。
