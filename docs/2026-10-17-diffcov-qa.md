# diffcov QA 報告（P7 → P8 回修後重跑）

工單：`docs/2026-10-17-diffcov-workorder.md`｜計畫：`docs/2026-10-17-diffcov-plan.md`（v2）
交付物：`src/pine/__tests__/strategy_equity_diff.test.ts`（477 行，新增；**產品碼零改動**）
閘門：`taskwf_gate.py --name diffcov`。本檔在 `fix` 後的 `enter P7` 之後更新（含 §4 的 P8 回修）。

## 1. 驗收標準逐條（標準 → 指令 → 結果）

| # | 標準 | 指令 | 結果（回修後重跑） |
|---|---|---|---|
| L1 | 新檔全綠、`Object.is` 逐 bar | `npx vitest run src/pine/__tests__/strategy_equity_diff.test.ts` | **14 passed**（run A／run B 同值） |
| L2 | 覆蓋矩陣每格有對應 `it`（jev） | 見 §3；`taskwf-accept` 判定 | 逐格列出；**手寫格 vs 掃描格分開標示**，未交付的手寫格照實列出 |
| L3 | 全套回歸 | `npx vitest run src/pine` | **73 files passed／1039 passed ｜ 1 skipped（1040）**；基線 72／1025 ⇒ 差額恰為新增檔（1 檔 14 測），無既有測試轉紅 |
| L4 | `tsc` | `npx tsc --noEmit` | **rc=0** |
| L5 | 非空洞性 | `npx tsx scratch/_r3-harness-selfcheck.mts` + §4 的定向突變 | 儀器自檢四種破壞全偵測；**回修後的 4 格另有定向突變證據（3 格轉紅、1 格如實註明不可分離）** |
| L6 | 差分若冒不一致必須修或裁決記帳 | P4 探針 + 本檔掃描 | **0 mismatch**（P4：4 組×300 seeds＋1200 stride pair；本檔：60 seeds）⇒ 無產品碼修正、無放寬斷言 |
| L7 | 測試不得與被測邏輯共碼 | 檔案 §FROZEN ORACLE | oracle 為 `shifted`+`simulate` 凍結副本；未呼叫新 stepper、未 import 被測 sink |
| L8 | 決定性 | 同指令連跑兩次 | run A／run B 皆 **14 passed**（固定 seed、無時間／順序依賴） |

## 2. 證據摘要（回修後）

- `git status --short -- src/pine/builtins src/pine/interpreter.ts src/pine/engine.ts` ⇒ **空**（產品碼未動）。
- 突變實驗後 `src/pine/builtins/strategy.ts` sha256 前 16 碼 = `3932c12f2abb4d58`，與實驗前一致（已還原）。
- 新增檔為本工單唯一版控產物；`scratch/**` 全為未提交探針（依計畫 §6.3）。

## 3. 覆蓋矩陣（L2）

| 面 | 覆蓋方式 | 出處 |
|---|---|---|
| `exit` `profit`（ticks→限價） | **手寫格**＋三錨 | `it('profit=10 ticks…')` |
| `exit` `loss`（ticks→停損） | **手寫格**＋三錨 | `it('loss=5 ticks…')` |
| `exit` `from_entry` | **手寫格**（全陣列斷言；判別點在 bar 5–7）＋三錨 | `it('from_entry is accepted but not used…')` |
| `exit` `trail_points`+`trail_offset` | 三錨（無手寫陣列，僅三個值） | `it('trail_points arms…')` |
| `exit` `trail_price` | **只有掃描**（無手寫格；原始碼把 trail_price 當啟動價） | sweep |
| `exit` `stop`/`limit`/`qty`/`qty_percent` | **只有掃描**（槽位已固定對齊） | sweep |
| `oca.cancel`（exit 兄弟） | **手寫格**（判別點：兄弟在 bar 5 可觸價）＋三錨 | `it('oca.cancel…')` |
| `oca.reduce`（exit 兄弟） | **手寫格**（判別 reduce vs cancel；reduce vs none 不可分離，見 §4.2） | `it('oca.reduce…')` |
| `oca_name`/`oca_type`（entry 側） | 只有掃描（槽 6/7） | sweep |
| `cancel(id)` | **手寫格**（`pyramiding=1` 使 E2 真的 pending；判別點：bar 3 可觸價） | `it('cancel(id) retires…')` |
| `cancel_all` | **手寫格**（同上） | `it('cancel_all retires…')` |
| `close_all` | 併於 `cancel(id)` 格（+ 掃描） | 同格 |
| `close('')` / `immediately=true` 變體 | **未交付**（原計畫 S3 項；掃描未涵蓋 `immediately`） | — |
| `risk.max_position_size` | **手寫格**（判別點：3 口會 +12） | `it('max_position_size caps…')` |
| `risk.allow_entry_in` | 同格（反向 entry 轉平倉） | 同格 |
| `risk.max_drawdown`（回歸） | 三錨（無手寫陣列） | `it('max_drawdown still triggers…')` |
| 多日界觸發（`max_intraday_loss`） | **手寫格**（觸發日全平） | `it('one day over the threshold…')` |
| 多日界**重置** | **手寫格**＋三錨（兩日各 0.8%、累計 1.6% 不得觸發） | `it('per-day 0.8% twice…')` |
| stride 不變性 | 真斷言（單讀 vs 稀疏讀逐元素） | `it('single-bar reads…')` |
| 互動格（exit×oca、exit×cancel、risk×日界） | **未交付為手寫格**；組合由掃描隨機覆蓋 | 計畫 S6 未做 |
| 全組合 | 60 決定性 scenario；**樣本數已釘住**（`strideChecked === 60`） | `it('60 deterministic scenarios…')` |

## 4. P8 回修（R1-RevDiffcov 的 7 項 Important）

### 4.1 已修（每項附判別性）

| # | 發現 | 修法 | 驗證 |
|---|---|---|---|
| 1 | `oca.cancel` 格空洞：兄弟 stop 95 全程不可觸（最低低點 98），移除 oca 或整支兄弟 sink 不變 | 兄弟改為 bar 5 才可觸（該 bar 低點 94），並斷言全陣列 | 突變（cancel 分支 no-op）⇒ **該格轉紅** |
| 2 | `oca.reduce` 格空洞：reduce／cancel／none 三世界 sink 相同 | 兄弟 3 口、T 只平 1 口後**兄弟以縮減後的 2 口在 bar 5 觸價**；reduce ⇒ 99995、cancel ⇒ 99999 | 突變（cancel 分支）⇒ **轉紅**；突變（reduce 分支）⇒ **仍綠**（見 4.2） |
| 3 | `from_entry` 格斷言無鑑別力（bar 4 兩世界皆 100010） | 改斷言全陣列；判別點在 bar 5–7（被尊重時部位續抱 → 100009／100008） | 反事實陣列由 R1 以同規格 harness 算出，與斷言值不同 |
| 4 | `cancel(id)`／`cancel_all` 格空洞：E2 被 pyramiding 守衛丟棄，從未 pending | `cfg.pyramiding=1` 使 E2 真的 resting，且把 bar 3 的低點壓到 E2 的限價內 | 突變（cancel 分支）⇒ **兩格皆轉紅** |
| 5 | 掃描 stride 斷言恆真（`strideChecked` 自比）＋空 sink 靜默跳過 | 改為 `expect(strideChecked).toBe(60)`，空 sink 視為失敗 | 斷言已釘樣本數 |
| 6 | 掃描 exit 參數錯位（條件推入 qty_percent 使後續位置參數整排左移） | 固定寫滿所有槽位（`F(NaN)`＝缺省） | 掃描仍綠且 oca 群確實成立 |
| 7 | QA／工單主張與程式不符 | 本檔重寫：行數、覆蓋矩陣（手寫 vs 掃描）、未交付項、close_all 出處 | 本檔即證據 |

### 4.2 如實註明的一項限制（非缺陷）

`oca.reduce` vs 無 oca：**本差分分不開**。原因是 `resolveQty` 會把兄弟的口數上限壓到剩餘部位（3 口被壓成 2），所以「縮減」與「不縮減」產生同一個成交。已用突變實證（reduce 分支停用 ⇒ oca 兩格仍綠），並寫在該 `it` 的註解裡。要分辨這兩者需要不同層級的斷言（例如檢查 `mod.qty`），**本輪未做**。

### 4.3 回修後的完整回歸

- 新檔：14 passed（run A／run B 同值）。
- 全套：73 files／1039 passed ｜ 1 skipped（1040）。
- `tsc`：rc=0。
- 產品碼：`git status` 空、`strategy.ts` sha256 `3932c12f2abb4d58` 與突變前一致。

## 5. 本輪變更與偏離（照實）

1. **L5 縮減再放寬**：原計畫 §3 的「6 類定向擾動突變」未做；改為 (a) 儀器自檢、(b) §4.1 針對回修格的**定向突變**（3 格轉紅、1 格如實不可分離）、(c) 每格的判別點註解。依新版 `task-workflow.md`「不要為了證明自創計畫外的 harness／突變測試」。
2. **計畫未交付項**（照實列出，未偽裝）：S2 的 `trail_price`／`stop`／`limit`／`qty`／`qty_percent` 手寫格、S3 的 `close('')`／`immediately=true` 變體、S6 的互動格。這些面目前**只由 60-seed 掃描覆蓋**（或未覆蓋），不是手寫格。
3. **P3 JEV 通道**：本輪用附錄的 `jev_judge.py`（`taskwf-verify`／`taskwf-blocker`；8 題卡點全 risk、4 題宣稱 0.19／0.52／0.73／0.72）；新版標準的 P3 固定模組為 `taskwf_jev.py`（子命令僅 verify／blocker／override／stats，無 review／accept），未改用。
4. **P7 accept 判定**：`taskwf-accept` noul=0.53（灰）⇒ 依規則由主 LLM 判（本檔逐條有證據、縮減已明示）＝通過。
5. **P8 規模**：本工單 heavy tier，依新版「reviewer 通常一個就夠」只派 1 位（`R1-RevDiffcov`），一次看三視角。

## 6. 收斂判定（三條）

1. **全測綠**：73 files／1039 passed ｜ 1 skipped（1040）⇒ 成立。
2. **驗收標準逐條過**：L1–L8 見 §1；L2 的未交付項已列在 §3／§5（不主張已覆蓋）⇒ 成立（L5 依縮減後的定義成立）。
3. **無新發現**：本檔 60 seeds 0 mismatch；P4 1200 scenario 0 mismatch；產品碼零改動；無新增 unknown。P8 的 7 項 Important 已回修，1 項限制（§4.2）已明文記錄 ⇒ 成立。
