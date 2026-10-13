# 未完成事項總表（2026-10-13 收工）

**狀態基準**：HEAD = `bf82d48`（45 顆資料源 stub，backlog 140 → 95）。
工作區只剩 `scratch/vela_*.png` ×6 未追蹤，**沒有未 commit 的程式改動**。

來源：`docs/2026-10-13-handoff-s5-tv-oracle.md`（§9.2／§10.6／§10.7，權威）＋
`docs/pynecore-conformance.json`（full 36／partial 14／missing 4／divergent 2）＋ 實測複核。

> 另一份 `docs/2026-10-13-fix-four-pain-points-handoff.md`（S1–S4）**已過期**：
> 它的 §3「沒 commit」與 §6「A 級四項待做」都被後續 commit 取代（`261d6e5`、`28b2c2d`）。

---

## 0. 接手必讀（若執行者是另一個 session，這幾條會省下大量時間）

1. **測試一律從 realpath 跑**：`cwd=C:/Users/bear9/OpenCharts`。
   `C:\Users\bear9\MYOPENCHART\OpenCharts` 是指向它的 junction，從那裡跑 vitest 會出現
   `Failed to load url .../src/__tests__/setup.ts` —— 假錯誤，檔案存在。
2. **`src/pine/` 有兩份複本**（`OpenCharts/src/pine/` 與 `MYOPENCHART/pine-interpreter/`）。**只改前者**。
3. **`reg(name, fn, false)` 是地雷**：第三個參數 `false` 會讓 `evalArg` 不再把純量引數包成 per-callsite
   BarSeries（`interpreter.ts:1303` 的 `noHist`）。**需要讀歷史的引數必須用預設 `hist = true`**，否則會拿到錯的值。
4. **`strategy.ts` 卡在 import 循環**（`interpreter → builtins/strategy → mtf → interpreter`）。
   要從 `strategy.ts` 用時間工具，**只能走 `../tz`**（葉模組），不要 import `../mtf` 或 `./time`。
5. **`git` 是 Windows 原生**：用 `C:/Users/...`，不要 `/c/...`。
6. **`tsc` 現在是 0 錯誤** —— 這是本輪的成果，別讓它再紅（但也別拿 `tsc` 當驗收，跑測試才有意義）。
7. **原始碼掃描型守衛測試**（`src/pine/__tests__/sourceScan.ts`）是**逐字元的引號感知掃描器**；
   不要改成 regex 去註解 —— `/\/\*[\s\S]*?\*\//` 會被註解裡的 glob 誤開成永不結束的區塊註解。
8. **寫探測器時，斷言「沒有輸出」比斷言「有錯誤」更容易誤判** —— 要用實際產生的值／訊息**全文**比對。
   （教訓：先前用 `/not found/` 篩警告，漏掉 `unknown constant`，得出錯的「124 個靜默 na」結論。）
9. **同一檔案不可併發 edit**：若同時開多個 agent，**先切檔**；共用根因（例如 `api.ts` 這種）要指定**單一 owner**。

---

## A. 有計畫、未實作 —— 最該先做

| # | 項目 | 證據 | 成本 |
|---|---|---|---|
| A1 | **未知具名引數的驗證**（`bindArgs` 警告未知名 ＋ `bindCallArgs` 不要再把它推成位置引數） | 計畫已寫好：`docs/superpowers/plans/2026-10-13-named-arg-validation.md`；實測 grep `unknown named argument`／`udfarg` = **0 命中**，`src/pine/__tests__/named_arg*` **不存在** | ~25 行 ＋ 5 個測試 |
| A2 | 6 張 Vela 截圖的去留（commit 當證據 or 刪） | `scratch/vela_{2330,err20,fatlines,harmonic,noharmonic,zoom}_window.png` 未追蹤 | 1 分鐘 |

**A1 為什麼值得**：R20 的 MZigZag「零輸出」根因就是它（`value=` 綁不進 `'val'` 槽，靜默全 na）。
R20 只修了那 5 個 `array.*` 的槽名；**通用防護沒做** —— 下一個參數名漂移還會靜默出錯。
已知的兩條靜默路徑：`util.ts:171`（builtins，未知名落進沒人讀的 key）、
`interpreter.ts:1458`（UDF，未知名被推成位置引數，`f(bogus=3)` 靜默覆寫參數 0）。
計畫的 S2 已做過 dry run：8 支真實腳本裡預期**沒有**其他違規者（只有既有的 `series→source` 別名）。

---

## B. TV 標準庫還缺 85（`tv_stdlib.test.ts` 會印最新數字）

現況（2026-10-13 第二輪後）：`TV names: 887 | registered: 728 | absent: 159 | alignment backlog: 85`
（先前的 `140 → 95` 是 45 顆資料源 stub；`95 → 85` 是「小刀」批次 10 顆，見 handoff §10.8）

| 批次 | 量 | 建議 | 理由 |
|---|---|---|---|
| `matrix.*` | 48 | **最後做** | 本 repo 真實腳本 0 使用（已 grep 驗證） |
| `syminfo` 缺欄位 | 27 | 等資料源 | 補成 na 會**蓋掉**現在有用的 `unknown constant` 警告 |
| `(global)` `ask` `bid` `timenow` `time_tradingday` `weekofyear` `last_bar_time` | 6 | 等資料源 | 同上 |
| 小刀 | 14 | 順手做（10 已做，見下） | `timeframe` 4／`array.*` 3／`label.*` 2／`box.copy`／`line.copy`／`chart.*` 3 |
| （未歸類） | ~~2~~ | **已釐清：不是未歸類** | 上面合計 93 與 95 差 2，是因為「小刀」列實際列了 14 個名字、數量欄卻寫 12。修好後：48+27+6+14 = 95 ✓ |

## C. PyneCore 對照表 —— missing 4 ／ partial 14

| 狀態 | 條目 |
|---|---|
| **missing 4** | `max_bars_back`、`matrix` 型別、`request.security` 的無資料情境、`strategy.calc_on_order_fills` |
| **partial 14** | `varip`、library import、string na、`map` 型別、security dynamic、`ns-array`／`ns-timeframe`／`ns-syminfo`／`ns-chart`／`ns-log`、`strategy.commission`、strategy 宣告被忽略的參數、驗證 corpus、驗證 overrides |

## D. 引擎正確性／相容性（無明確期限）

1. **新補的 `ta.*`／`strategy.*` 沒有 TV 數值 oracle** —— oracle 只保證**名字**對齊；
   數值是照官方文件 ＋ pinets 逐字移植推的，**沒有跟 TV 逐位比對**。要提升信心只能人工在 TV 跑同一個腳本對數字。
2. **`log.*` 沒有輸出面板** —— 資料在 `RunResult.logs`，本 app 沒有 logs pane。
3. **S5 留下的五條刻意限制**（見 S5 handoff §3）：追繳平倉不截斷成整數合約、risk 規則以事件密度近似逐 bar、
   進場保證金不足時 warn 而非 error、`session.ispremarket/ispostmarket` 恆 false、跨年 D/W `bars_back` 未實作。
4. **`matrix.*` 只有 stub 級覆蓋**（同 B 首批）。

## E. 技術債

| 項目 | 現況 |
|---|---|
| **TypeScript 防回歸** | `tsc` 已歸零，但 **repo 沒有 CI、沒有 husky/pre-commit** → 沒有人擋它再紅。計畫：`docs/superpowers/plans/2026-10-13-typescript-debt-remediation.md` Phase 3 |
| **pinets 移植層 5346 行是孤兒** | 只被測試 import（`pinetsAll` 沒有生產 import）。要決定：提升為生產／刪除／保留當測試夾具。**刪之前先確認 §8.1 的語意筆記夠用** |
| **常數摺疊未做** | 正確形狀已定（S5 handoff §10.3）：要用 evaluator 對 literal-only 初始式求值一次，**不能**另寫一套常數算術 |
| **broker port 未做** | 設計已定（~40 行 `BrokerPort` ＋ paper/sim 實作），但 `src/services/shioaji/api.ts` 目前**零 import** → 現在做會有零個使用者。等實盤路徑接上 |

## F. 明確決定「不做」（列出來避免重複討論）

- **`request.security` 的 tf 不做編譯期檢查** —— `mtf.ts` 的 DYNAMIC 路徑是**刻意支援**的功能，擋掉等於刪掉一個能跑的功能（TV 會拒絕）。
- **`chart.bg_color`／`chart.left/right_visible_bar_time` 不註冊** —— 無圖表顏色／可見區間來源，補 na 只會蓋掉有用的警告。
- **`syminfo` 那 27 個欄位不補 na** —— 同上，維持警告比回 na 誠實。

---

## 建議順序

1. **A1**（named-arg validation）—— 最便宜，修的是**可觸發的靜默錯誤**，且計畫與 dry run 都做完了。
2. **A2**（PNG 去留）＋ **E 的 TypeScript 防回歸**（10 分鐘的事，但決定這輪 275→0 會不會再爛掉）。
3. **C 的 `strategy.calc_on_order_fills` 與 `varip`** —— 對照表裡「會影響數字」的那一類。
4. **B 的小刀批次**（14 顆，已做 10；剩 `timeframe.from_seconds` ＋ 刻意不做的 `chart.*` 3）。
5. 其餘等資料源或真實需求（B 的 `matrix.*`／`syminfo`、E 的 broker port）。
