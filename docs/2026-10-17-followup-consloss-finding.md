# 附錄：A2 sink 與 oracle 的唯一分歧——`strategy.risk.max_cons_loss_days`

- 日期：2026-10-17（主代理獨立差分審查，P8 之後、P9 之前）
- 受測樹：`<repo>`（未 commit，= `R2-FixA2` + `R2-FixGuard` 落地後的樹）
- 相關腳本（repo 內，臨時探針）：`scratch/_r2-diff.mts`（隨機差分）、`scratch/_r2-consloss.mts`（定點重現）、`scratch/_r2-guard.mts`（守門稽核）
- 結論一句：**在 1200 個隨機劇本中，`SimCache.equity[b] === 舊 equityAt(b)` 對所有規則成立，唯獨 `strategy.risk.max_cons_loss_days` 不成立；且該規則下 sink 值會隨讀取樣式改變。**

## 1. 隨機差分（`scratch/_r2-diff.mts`）

方法：以 seeded RNG 生成劇本（3–14 根 bar、日界配置 0/3/5/7 根、`process_orders_on_close`、三種手續費、`immediately` 平倉、limit/stop、稀疏讀取樣式），逐 bar 以「受測 sink」對「凍結 oracle（每 b 從空狀態重跑 `simulate` 到 b）」比對 `Object.is`，並同時比對公開讀值 `strategy.equity`。

```
$ npx tsx scratch/_r2-diff.mts 800 1000          # 不含 max_cons_loss_days
scenarios=800 mismatched=0
$ npx tsx scratch/_r2-diff.mts 400 1             # 含 max_cons_loss_days
scenarios=400 mismatched=15 firstBadSeed=39      # 15/15 全部含該規則
```

含該規則時，15 個 mismatch 劇本的規則欄位全都是 `max_cons_loss_days`（另有 `max_drawdown`／`max_intraday_loss`／`max_intraday_filled_orders` 者亦僅因同場含它）。不含該規則者 1200 個劇本 **0 mismatch**。

## 2. 定點重現（`scratch/_r2-consloss.mts`）

劇本：closes `[100,97,97,101,101,105,105,108,113,117,118]`（單一日）、1% 手續費、`risk.max_cons_loss_days(1)`、bar0 `strategy.entry('E0','strategy.short',2)`；讀取樣式各異。

```
[full reads every bar] reads=[0..10]
  sink=[100000,99998.06,99998.06,99988.04,99988.04,99988.04,...,99988.04]
  orcl=[100000,99998.06,99998.06,99988.04,99988.04,99979.96,99979.96,99973.9,99963.8,99955.72,99953.7]
  diverge bars: 5:!6:!7:!8:!9:!10:!

[sparse reads] reads=[0,3,7,10]
  sink=<與上一列逐值相同>
  orcl=<與上一列逐值相同>

[only bar0 + last bar] reads=[0,10]
  sink=[100000,99998.06,99998.06,99990.06,99990.06,99982.06,99982.06,99976.06,99966.06,99958.06,99953.7]
  orcl=[100000,99998.06,99998.06,99988.04,99988.04,99979.96,99979.96,99973.9,99963.8,99955.72,99953.7]
  diverge bars: 3:!4:!5:!6:!7:!8:!9:!
```

兩件事各自成立：

1. **`sink[b] ≠ 舊 equityAt(b)`**（bar 5 起）：sink 記的是「bar 3 觸發後已平倉」的因果歷史；oracle（＝舊 `equityAt`，逐 b 從頭重放到 b）在 bar 5 才觸發，於是 bar 3 的值兩者相同、bar 5 之後分岔。
2. **`sink[b]` 依讀取樣式而變**：`sink[3]` 在讀過 bar 3 時是 `99988.04`（bar 3 就觸發），只讀 bar 0 與 bar 10 時是 `99990.06`（未觸發）。這違反 `strategy_equity_stepper.test.ts` 檔內自述的契約「the sink must be read-pattern independent」。

## 3. 根因（`src/pine/builtins/strategy.ts:782-790`）

```ts
// max_cons_loss_days is judged on the day's last bar.
if (nDays !== undefined && nDays > 0 && (b === uptoBar || dayKeyOf(b + 1) !== k)) {
```

「今日最後一根」用 `b === uptoBar` 近似，而 `uptoBar` 是**這次 run 的終點**（可能是讀取當下那根，也可能是稀疏讀取時的區間終點）。`riskWalk` 現在逐 bar 交錯且可 resume（`riskBar` 續走），因此：

- 讀過 bar 3 ⇒ run(3) 讓 bar 3 成為當次 `uptoBar` ⇒ 觸發、平倉、`haltBar=3` 永久；
- 沒讀 bar 3 ⇒ bar 3 落在 run(10) 的中段 ⇒ 不是 `uptoBar` ⇒ 不觸發。

舊實作（`equityAt(b)` 每次從頭重放到 b）**每個 bar 的值各自獨立**，但同一條曲線前後自相矛盾（bar 3 的讀值說「bar 3 已平倉」，bar 5 的讀值說「bar 5 才平倉」）。新 sink 換得的是**因果一致**的單一歷史，代價就是上述兩點。

## 4. 影響面

- 僅限使用 `strategy.risk.max_cons_loss_days` 的脚本；其餘規則（`max_drawdown`／`max_runup`／`max_intraday_loss`／`max_intraday_filled_orders`／`max_position_size`／`allow_entry_in`）在 1200 個隨機劇本下逐位相等。
- 現有四支 digest 腳本、golden 14 支、`inc-parity` 全部不受影響（回修後五閘仍綠）。
- **未被既有驗收涵蓋**：`strategy_equity_stepper.test.ts` 的矩陣只跑 `max_drawdown`；`R2-RevA2Fix` 的 0C/0I/0M 判定（信心 0.86）因此未觸及此規則。

## 5. 待裁決（未動任何生產碼）

- **選項 1（建議）**：承認這是**刻意的語意改變**（舊曲線自相矛盾 → 新曲線因果一致），在 `strategy_equity_stepper.test.ts` 補一個 `max_cons_loss_days` 的 `it` 把新值釘住，並在交接 §4「刻意語意改變」清單加第 3 條；同時把「oracle 逐位相等」的適用範圍寫明為「除 `max_cons_loss_days` 外」。
- **選項 2**：讓 sink 對該規則也讀取樣式無關（例如：規則只在 run 內跨越日界時評估，run 結束那根改為不評估 ⇒ 會改變「當日最後一根」在串流下的既有語意，需另設計並重跑五閘）。
- **不可行**：要求此規則同時滿足「與舊 `equityAt` 逐位相等」與「讀取樣式無關」——兩者在串流引擎下互斥。

## 6. 覆蓋缺口（本次差分未觸及）

`strategy.exit`（`profit`/`loss`/`trail_*`）、`cancel`/`cancel_all`、`oca_*` 群組、`close_all`、`max_position_size`、`allow_entry_in`、`default_qty_type` 各態、checkpoint `snapCtxState`/`restoreCtxState` 回捲——皆未進入本差分（前兩者在 `P9` 補的 3 支分支測試中另有覆蓋，但非本案）。

## 7. 裁決與落地（2026-10-17 20:4x，advisor P9）

- 使用者裁決走**選項 1**：承認是刻意的語意改變，並補測試釘住。
- **已落地**：`src/pine/__tests__/strategy_equity_stepper.test.ts` 新增一個 `it`（`max_cons_loss_days: the curve is the causal history, not a per-bar re-replay`），逐 bar 釘住 `[100000, 99998.06, 99998.06, 99988.04 ×8]`，並同時釘住三件事：
  1. `sink[3] === equityAt(3)`（同一 run 終點 → 同答案）；
  2. `equityAt(5) === 99979.96`（從頭重放到 5 會在 bar 5 才觸發）；
  3. `sink[5] !== equityAt(5)`（**這就是被承認的分歧**——未來若改動 run-end 閘門，這條會紅，強迫做有意識的決定）。
- 檔頭同時補一句「oracle 矩陣刻意不裝 `max_cons_loss_days`」的例外聲明。
- 觸發條件的精確機制（供後續維護）：規則安裝發生在**該單事件被 `applyEvent` 之後**，因此 bar 0 的 walk 看不到規則；首個規則感知的 bar 是 1，其日界 rollover 用 `equityNow(0)`（已含 bar 1 的新倉按 bar 0 收盤標記）當 `dayStartEquity`，故 bar 1/2 不觸發、bar 3 起才跌破。串流路徑的 run 終點即讀取那根 ⇒ 檢查在 bar 3/4 觸發且 `haltBar` 永久，之後續跑的 bar 不再檢查；從頭重放到 5 則只在 bar 5 檢查。
- 生產碼未動：`strategy.ts:784` 的閘門維持原樣，因此五閘的 digest／golden／parity 不受影響（只需跑測試檔）。
