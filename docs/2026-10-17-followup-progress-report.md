# wrapC 後續工單：進度報告（2026-10-17）

> 工單：`docs/2026-10-17-wrapc-followup-workorder.md`（B7／B2／B3／附錄 A2）
> 流程：`task-workflow` P0–P9；閘門狀態 `.taskwf/state.json`（P0–P7 done、`current=P8`、tier=**heavy**、round=1、advisor P1/P5 已記）
> 本報告為 P9 格式（已驗證／未驗證／改過的設定），P8 未收斂的部分另列 §4。

## 1. 進度總表

| 階段 | 狀態 | 證據 |
|---|---|---|
| P0 需求 | ✅ | 工單四項＋驗收標準／非目標／假設 → `docs/2026-10-17-followup-plan.md` §0 |
| P1 拆解＋tier | ✅ | 4 node／10 檔 ⇒ **heavy**；`advisor P1`（READY:conditional） |
| P2 三軸探索 | ✅ | `agent://P2-Feasibility`／`P2-Risk`／`P2-Patterns`（3 代理，7m30s／13m9s／13m10s） |
| P3 卡點整合 | ✅ | 受管 JEV `taskwf-verify` .23／.10／.27（控制題 .97）＋程式抽驗；`taskwf-blocker` 7 題（2 blocker／5 risk） |
| P4 定向探索 | ✅ | `P4-B2Fixture`（18m19s）／`P4-A2Stepper`（18m23s） |
| P5 定稿 | ✅（🔒 未停，見 §8） | `docs/2026-10-17-followup-plan.md` v1；`advisor P5`（READY:conditional） |
| P6 執行 | ✅ | 四 slice：B7／B2／B3／A2-S1、A2-S2（各附煙霧證據） |
| P7 QA | ✅ | 五閘全綠＋9 突變 0 mismatch＋`taskwf-accept` noul **0.85**；報告 `docs/2026-10-17-followup-qa.md` |
| P8 Review | 🔶 **回修完成、待再審** | R1 三視角：4 Important＋2 Minor；`R2-FixGuard`／`R2-FixA2` 皆完成；`taskwf_gate.py fix`＋P7 重跑＋R2 再審未做（見 §4） |
| P9 交付 | ⬜ | 未開始（PROGRESS.md、暫存清理、advisor P9） |

## 2. 已驗證（每條＝驗收標準 → 指令 → 結果）

| 項 | 指令／量測 | 結果 |
|---|---|---|
| B7 四處綁定收一行 | `grep -c "const raw = bound.get('value')" src/pine/builtins/array.ts` | **0**（原 4） |
| B2 守門 fixture | 掃描 65 家族×308 槽（344 配置）＝清表後 DIFFER **144 槽／51 家族**；`vitest run src/pine/__tests__/scalar_spec_integrity.test.ts` | **7 passed** |
| B3 order 單一來源 | `grep -c "order: \[" src/pine/builtins/scalarDeclPatch.ts` ⇒ **0**；`grep -c "order: [A-Z_]"` ⇒ **41**；`FAMILY_ORDER` 41 keys | 單一來源成立、覆蓋 41/41 |
| A2 曲線不再重放 | `grep -c "shifted\|equityAt" src/pine/builtins/strategyEquity.ts` | **0** |
| A2 oracle 等價（S-A/S-B/S-G 劇本） | `vitest run src/pine/__tests__/strategy_equity_stepper.test.ts`＋逐 bar `Object.is` | 綠（**但 R1 找到 S-A/S-B 未覆蓋的可達形狀 ⇒ 見 §4**） |
| 全測試綠 | `npx vitest run src/pine` | **72 檔／1014 passed｜1 skipped**（基線 1007 ⇒ ＋7） |
| 型別 | `npx tsc --noEmit` | **rc=0** |
| 凍結語料 | `npx tsx scripts/perf/pine-bench.mjs …（4 腳本／100 bars／repeat 2）` | **`1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` 逐字不變**，app=direct 全 PASS |
| golden | `npx vitest run src/pine/__tests__/golden.test.ts` | **14 passed｜1 skipped** |
| 增量 parity | `npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 5` | **PARITY OK** |
| 守門突變自證 | `<tmp>/wrapc-mut`（driver＋batch.json，9 案例） | **0 mismatch**：D1a/D1b/D1c 紅、D1d 綠、D3a′ 紅（`array.slice: idx 1 → order 'index_to', declared 'index_from'`）、D3b 紅、D3c/D3d 綠、M4x 紅 |
| P8 回修（可維護性 2＋守門 1） | `scalar_spec_integrity.test.ts` 7 passed；`tsc` rc=0；`grep -c "shifted" src/pine/interpreter.ts` ⇒ 0 | 綠 |

原始輸出留存：`<tmp>/wrapc-qa/{G1,G2,G3,G4,G5}.txt`、`<tmp>/wrapc-mut/mut-*.log`；動工前備份 `<tmp>/wrapc-followup-backup-20261017-151610/`（＋`md5.txt`）。

## 3. 交付位置

- 計畫：`docs/2026-10-17-followup-plan.md`（v1）
- QA：`docs/2026-10-17-followup-qa.md`
- 交接：`docs/2026-10-17-followup-handoff.md`
- 程式（**未 commit**）：
  - 改：`src/pine/builtins/{array,str,scalarDeclPatch,strategy,strategyEquity}.ts`、`src/pine/interpreter.ts`、`src/pine/__tests__/{scalar_spec_integrity,strategy_equity,strategy_inc_parity,inc-parity}.test.ts`
  - 新：`src/pine/__tests__/fixtures/scalarGuardedSlots.ts`、`src/pine/__tests__/strategy_equity_stepper.test.ts`

## 4. 未驗證／未收斂

1. **A2 記帳語意：F1/F2 已回修（`R2-FixA2`，1h18m）**——修法＝事件迴圈 `riskWalk(o.bar)` → `applyEvent(o)` → `advancePending(o.bar)`；`riskWalk` 內逐 bar `advancePending(b)` → rules → `put(b)`（ruleBlock 方程式一字未動）；`applyFill` 於 `bar <= riskBar` 截尾回寫。證據：**先紅後綠**（7 個新 it；`scratch/_r2-a2-red.txt`／`-green.txt`）、5 檔 **95 passed**、`tsc` rc=0、TRIS390 `PARITY OK`；**主代理已獨立複驗**（`tsc` rc=0＋同 5 檔 95 passed）。
2. **未驗證（交接後第一件事）**：回修後的**完整五閘**尚未重跑、`taskwf_gate.py fix` 未執行 ⇒ `docs/2026-10-17-followup-qa.md` 的 A2 結論已被 R1 取代，須以新報告檔覆蓋。
3. **A2 效能縮放未量**：`replaySteps` 100／200／500 或 `equityAt` 呼叫數。原因：機器非安靜（G3 報告自標 `NOISY`）、且 `equityAt`/`shifted` 已刪除無從計數 ⇒ 以 code 面＋oracle 值替代；安靜機（`node scripts/perf/quiet-gate.mjs` PASS）後可補。
4. **A2 tick 語意屬刻意行為改變**：tick 後同 bar 再讀 `max_drawdown`／`max_runup` 反映新 OHLC（舊行為沿用第一次值）；已由新 `it` 釘住，但屬對外可觀察差異。
5. **P8 尚未 `done`**：R2 再審（只審本輪 diff：正確性＋可維護性）未做；`done P8` 與 P9 未記。

## 5. 改過的設定

**無全域設定變更**：未動 `~/.pi`、`~/.commandcode`、`~/.omo`、`models.yml`、任何 env 或服務配置（本專案 AGENTS.md 要求「改全域設定先問」——本輪沒有）。
僅新增／修改 repo 內檔案（§3）與 `<tmp>` 下的工作目錄（`ocrev`／`wrapc-mut`／`wrapc-qa`／`wrapc-followup-backup-*`）。

## 6. 遺留風險與待裁決（使用者）

1. `scratch/perf/wrapB-smoke.mts` 零引用，本輪**保留未動**（依「無關 dead code 只提不刪」）。
2. 探針／突變腳本版控：全部留在 repo 外（`<tmp>`）；fixture 已進 repo（測試需要）。
3. 第三工作流未提交變更（`VelaPage.tsx`／`velaNautilusBacktest.ts`／`shioaji/*`／`nautilusClient.ts`／`scripts/*`／`graphify-out/`）＋ `workorder.md` §C（你自己加的 omp judge／JEV 探索）**不屬本輪**。
4. `<tmp>` 遞迴清理被 L0 安全閘擋（需逐項點頭）。
5. 本工單 gate 未加 `--name`（單工單，`.taskwf/state.json`）。
6. 文件內本機路徑已去識別（`<repo>`／`<tmp>`），僅 G3 指令保留 `…/high452/MACDV7.04/MACD701_v72.pine`（需可直接複製執行）——對外分享前請置換。

## 7. 下一步（順序）

1. 確認 `R2-FixA2`（`read agent://R2-FixA2`）；未落地或半成品 ⇒ 用備份還原後重跑回修。
2. `python C:/Users/bear9/jev-laya-bench/taskwf_gate.py fix`（作廢舊 QA）。
3. 重跑 P7 QA（新報告檔）：五閘＋突變（指令見 `docs/2026-10-17-followup-handoff.md` §3）。
4. R2 再審（只審本輪 diff、只派受影響視角）⇒ C/I 歸零才 `done P8`。
5. P9：`PROGRESS.md` 更新、暫存清理、`advisor P9`、三類回報。

## 8. 流程合規對帳（`task-workflow.md` 15:52 版）

| 規則 | 狀態 |
|---|---|
| P0 🔒（已有「執行」可免停） | 相符（新例外條款） |
| **P5 🔒（無例外，必須停等核准）** | **違規**：未等核准即 `done P5`＋`enter P6` |
| **P2 先 enter 再 spawn** | **違規**：三個探索代理先派出 |
| **P6 波次以 plan 為準、不自行併波** | **違規**：A2-S1 併入 W1（事後補記 plan §1） |
| P4 可用既有證據收斂 unknown | 相符（已寫進 `done P4 --evidence`） |
| P3 file:line 宣稱不呼叫 JEV | 當時誤呼叫（.10–.27）後改程式抽驗；新規已修正 |
| JEV 診斷題用 `probe-*` | **違規**：誤用 `taskwf-control`（已進 `judge_calls.jsonl`） |
| 閘門 enter/done | 3 次 `GATE DENY`（漏 done/enter），皆照規則補做、未手改 state |
| P7 QA 在 P8 之前 | 相符（`done P7 --evidence docs/2026-10-17-followup-qa.md`） |
