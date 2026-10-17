# T8a REAL PLAN：`simulate()` → 可續跑的 stepper（`simAt` 由 Θ(B²) 降為 O(B)）

> 來源：`docs/2026-10-15-r5-fix-plan.md` P2、`docs/2026-10-15-t8-stepper-dossier.md`（探索＋設計骨架，已實測）、`docs/2026-10-15-t8-replay-attribution.md`（歸因）。
> 本檔＝P5 REAL PLAN。**狀態：未動工。實作前置見 §7。**
> 本檔的閘門值以**現行基線**為準（2026-10-17 續作後）：digest `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl`；`vitest run src/pine` **70 檔／1002 passed｜1 skipped**。

## 0. 問題與驗收

- **現況**：`simAt` 以 `uptoBar` 為鍵、每個 `strategy.*` 讀取都傳 `ctx.barIndex`；build 趟 `barIndex` 單調 ⇒ 每根必 miss ⇒ 每次 `simulate()` 從 0 走到 N。`replaySteps` ＝ **B(B−1)/2**（4,950／19,900／124,750 @100/200/500）。
- **驗收（P2）**：`replaySteps` 降為 **O(B)**（附 bars 100／200／500 新表）；**硬條件**：四支 digest 逐字不變、`s1-inc-probe` parity、golden 0、`tsc` rc=0、`vitest run src/pine` 全綠。
- **停損**：任何 digest／parity 漂移 ⇒ 還原，只交歸因。

## 1. 設計決定（必須先定）

`simulate()` 有**第二個呼叫者**：`strategyEquity.ts:34-58` 的 `equityAt` 會在自己的 `shifted(ctx, b)` 上對**任意過去 bar `b`** 呼叫 `simulate(..., b)`，而 `simulate` 的進入點會 reset `o.seen`／`o.mod`／… 於**共用的 order 物件**上（`strategy.ts:301-304`）。⇒ 保留兩個 caller 共用 order scratch 就是**必然的狀態互相覆寫**（同一 bar 內 `max_drawdown` 與 `strategy.position_size` 兩種讀取順序皆會壞）。

| 選項 | 內容 | 代價 | 取捨 |
|---|---|---|---|
| **①（採用）統一 stepper、刪掉第二次 replay** | stepper 在推進時順手記 `equity[b]`（`sim` 已有 `realizedPnl/qty/avgEntry`；`riskWalk` 已算 `equityNow(b)`，`strategy.ts:662`），`equityCurve` 改讀 ctl 的逐 bar equity | 動 **2 檔**（`strategy.ts`＋`strategyEquity.ts`）；必須逐位元重現 `equityAt` 的數字 | 同時消掉共用 scratch 危害**與** `equityCurve` 自己的第二個 Θ(B²)（dossier §4.0-3） |
| ② 保留純 replay、把 per-order scratch 搬到 ctl | 把 `seen/cancelledAt/mod/trailPeak/fillQty/fillPrice` 從 order 物件移進 ctl 自有的 per-pending 記錄 | 動 **1 檔**，但 ~40 個讀寫點機械搬遷；`equityCurve` 的 Θ(B²) 仍在 | 語意風險集中在大量搬遷 |

**採用 ①**（dossier 建議；兩者都能解掉 blocker，①額外解掉第二個二次項，且不留下兩個 authoritative scratch）。

## 2. 要動的程式（精確位置）

1. **`strategy.ts:295-870` `simulate` 拆成三段**：
   - `newCtl(cfg): SimCtl` — 現行 `:296-325` 的初始化（`sim`／`pending`／`i`／`rules`／risk 游標／`fillsByDay`）＋ 新增 `last = -1`、`equity: number[]`。
   - `advanceBar(ctx, orders, cfg, ctl, k)` — 現行事件迴圈 `:327-484`，但**不重置**、所有 locals 改讀寫 `ctl`，並把 `:452` 的
     `if (o.bar > uptoBar) { o.seen = o.bar; continue; }` 改成 **`if (o.bar > k) break;`（不寫 `seen`）** ⇒ 讓 `ctl.i` 停在那筆，下次推進重訪（dossier I7）。
   - `simulate(ctx, orders, cfg, uptoBar)` **保留**為「從 0 起算的純 replay」：`const c = newCtl(cfg); advanceBar(..., c, uptoBar); return c.sim;`（供 `strategyEquity` 的罕見 `uptoBar < ctl.last` 回退路徑與既有測試續用）。
2. **`simAt`（`strategy.ts:879-891` 一帶）改寫**：
   ```ts
   function simAt(ctx, uptoBar) {
     const st = stateOf(ctx); if (!st) return emptySim();
     const orders = st.get(ORDERS_KEY); if (!orders?.length) return emptySim();
     let ctl = st.get(CTL_KEY);
     if (!ctl) { ctl = newCtl(cfgOf(ctx)); st.set(CTL_KEY, ctl); }
     if (uptoBar < ctl.last) return simulate(ctx, orders, cfgOf(ctx), uptoBar); // 回退路徑（罕見）
     advanceBar(ctx, orders, cfgOf(ctx), ctl, uptoBar);                          // k === ctl.last 時為廉價 no-op
     return ctl.sim;
   }
   ```
   `SimCache { count, byBar }` 由 `SimCtl` 取代（**單一 live `sim` ＋ `last`**，不再需要 `byBar` Map）。
3. **`advanceBar` 內推進 `equity[b]`**：在 `riskWalk(k)` 收尾後記錄當根 equity（與 `strategyEquity.ts` 現行 `equityAt` 同口徑；見 §4 I8）。
4. **`strategyEquity.ts:34-58`**：`equityCurve` 改讀 ctl 的 `equity[b]`（缺則先 `simAt(b)` 補），刪掉 `shifted`＋`simulate` 這條重放；`max_drawdown`／`max_runup` 的 rollup 邏輯不變。
5. **`interpreter.ts:3237-3240`** 的註解（聲稱 `simulate` 是「pure function of (orders, bars, cfg, uptoBar)」）改為陳述現況 —— **只改註解，不改邏輯**。

## 3. Rollback 與紅線

- 動手前把 `strategy.ts`／`strategyEquity.ts`／`interpreter.ts` 備份到 `%TEMP%/t8a-backup-<ts>/` 並記 md5。
- 禁止 `npm i`／`git checkout|restore|stash`；shell 一律 `cd /c/Users/bear9/OpenCharts && <inline>`。
- 同檔不可並發 edit：本計畫 owner 獨占 `strategy.ts`／`strategyEquity.ts`。

## 4. 驗證義務（dossier §5 的不變式，逐條要測試）

| # | 不變式 | 守門測試 |
|---|---|---|
| I1 | bar k 的狀態與 `bar > k` 的 order 無關（前綴重用正當性） | `inc-parity.test.ts` 的 `expectSame`；四支 digest |
| I2 | `advanceBar(k)` ≡ `simulate(uptoBar=k)`，含 `k = ctl.last` 重入 | `strategy.test.ts`、`strategy_equity.test.ts` 的逐 bar `seek` 序列；golden |
| I3 | 同 bar 內 append order 後重讀要看到它 | `strategy.test.ts:376-378`（`immediately=true` 的 close） |
| I4 | 沒有呼叫者在兩次 advance 之間持有 `Sim`／`.execs`／`.closed`／`openLegs` 參照（單一 live `sim` 是別名） | **實作前先確認**：`interpreter.ts:3178` 的 `execs: execsAt(...)` 是否即用即棄；若有其他持有者 ⇒ 回傳 `execs`／`closed`／`openLegs` 的淺拷貝 |
| I5 | 同 `limit` 下 `advancePending`／`riskWalk` 冪等 | replay parity；risk 測試（dd/runup 精確值） |
| I6 | checkpoint rollback 精確還原 ctl（含 per-order scratch） | `inc-parity.test.ts`（tick parity、forming-bar rollback、24 random ticks） |
| I7 | `:452` 的 future-order guard 不再永久丟單 | **新測試**：formed bar 內 append order（`o.bar > k`）後下次推進仍處理 |
| I8 | `ctl.equity[b]` ≡ 舊 `strategyEquity.equityAt(b)` 的數字 | `strategy_equity.test.ts` 的 `max_drawdown`／`max_runup` 精確值 |

**額外必驗（dossier §6）**：`SimCtl` 必須是**純物件**（`proto === Object.prototype`），否則 `snapCtxState`（`interpreter.ts:3330-3379`）不會記錄它 ⇒ **rollback 靜默失效**。`pending` 內若持有 `StratOrder` 參照，必須確認 `arrays` 先 clone orders、再以同一 `ids` 對應 clone ctl 的欄位（`snapCtxState(ctx.state, ids)`）。

## 5. TDD 循環（每步先紅後綠）

| 循環 | 紅測試 | 綠的判準 |
|---|---|---|
| C1 | 新測試：`replaySteps` 計數（bars 100／200／500）斷言 **≤ c·B**（先量現值 B(B−1)/2 作為紅） | 三個 bars 都 O(B) |
| C2 | I7 新測試（formed bar 內 append 後仍處理） | 紅→綠，且 `strategy.test.ts` 全綠 |
| C3 | I2 對照測試：同一腳本跑「逐 bar `seek`」與「一次到位」比 `Sim` 逐值相同 | 相同 |
| C4 | I8：`ctl.equity[b]` vs 舊 `equityAt(b)` 逐值相同（先把舊實作留在測試裡當 oracle） | 逐值相同後才刪舊路徑 |
| C5 | I6：`inc-parity` 的 rollback 案（含開啟 `max_drawdown` 的腳本） | 全綠 |

## 6. 閘門（每循環跑；全部貼原始輸出）

1. `npx vitest run src/pine` → 全綠、passed ≥ **1002**
2. `npx tsc --noEmit` → rc=0
3. 四支 digest：`1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` **逐字不變**
4. golden `14 passed | 1 skipped`（**禁止** `UPDATE_GOLDEN`）
5. `s1-inc-probe --script src/pine/TRIS390.pine --bars 500 --ticks 5` → `PARITY OK`
6. 新增：`replaySteps` 表（100／200／500）

## 7. 實作前置（不得跳過）

1. **先收掉當前未提交成果**（`docs/superpowers/plans/2026-10-17-wrapeval-option-a.md` §12 的 commit 草案）。理由：`strategy.ts`／`strategyEquity.ts`／`interpreter.ts` 目前都已在未提交的改動堆裡，再疊一層會讓「哪一行屬於哪個請求」不可回溯。
2. 開**新 session**（一任務一 session），標題：`T8a 快照 stepper`。
3. 開工前重跑一次 §6 的 1／2／3／4 當作基線快照（確認樹是乾淨的綠）。

## 8. 已知不確定（實作時必須先確認，不是假設）

- **I4**：`ctx.state` 內是否有東西長期持有 `Sim` 或其陣列欄位（若是 ⇒ 讀取端要淺拷貝）。
- **`equityCurve` 的惰性註冊時機**：`equity[b]` 必須在腳本讀 `max_drawdown` 之前就已由 stepper 補齊，否則會走回退路徑（回退仍正確，只是慢）。實作時以「先 `simAt(b)` 補齊到 b」實作即可，但要確認不會把 `ctl.last` 推過當前 bar（`uptoBar < ctl.last` 的分支不得被觸發）。
- **`pending` 的 clone 對應**（§4 末）：實作時加一個 rollback 探針，斷言 rollback 後 `ctl.pending` 的元素與 `orders` 陣列內對應元素是**同一物件**。

## 9. 查證結果（2026-10-17，續作；**實作早已在樹上**）

開工前查證發現：本計畫要做的 stepper **已經由 R5 線落地**（dossier 寫於其實作之前），且走的是 **§1 的選項 ②**：

| 計畫要求 | 樹上現況 |
|---|---|
| `SimCtl` 持有 cursor | `SimRun`（`strategy.ts:322-341`）＋ `OrderCursor`（`:299-317`，**刻意與 `StratOrder` 分離**）＋ `cursors: Map<seq, OrderCursor>` |
| `advanceBar` 續跑 | `export function simulateRun(ctx, orders, cfg, uptoBar, prev?)`（`:349`）；`resume = prev !== undefined && prev.bar <= uptoBar` |
| `:452` future-order guard 修正 | 已修：`:522 if (o.bar > uptoBar) break; // Future order: stop before advancing i or its cursor` |
| `simAt` 改讀／寫 ctl | `:1046-1058`：`const prev = cache.run && cache.run.bar <= uptoBar ? cache.run : undefined; const run = simulateRun(..., prev); cache.run = run;`（append／rollback／intraday tick 三種失效都已處理） |

⇒ §1 的取捨（①統一 equity／②scratch 移出 order）**已由實作固化為 ②**，該決策不再需要討論。§4 的 I7 已滿足；I4／I8 在 ② 下不適用。

### 9.1 驗收量測（探針 `scratch/perf/t8-replay-attrib.mjs`；產物 `scratch/perf/t8-replay-attrib-postfix.json`）

修前值取自 `docs/2026-10-15-t8-replay-attribution.md` §1（同探針、同口徑）。

| bars | `replayMs` 修前 → 修後 | 降幅 | 每次 replay ms（中位／p95／**max**） | `epochRebuilds` |
|---|---|---|---|---|
| 100 | 793.09 → **49.67** | −93.7% | 0.316 / 0.630 / **8.24** | 4 → **1** |
| 200 | 3,321.78 → **165.90** | −95.0% | 0.259 / 0.631 / **18.42** | 8 → **1** |
| 500 | 23,422.09 → **667.05** | −97.2% | 0.263 / 0.678 / **47.05** | 20 → **1** |

**判讀**：每次 replay 的**中位成本與 B 無關**（0.26–0.32 ms，p95 ≤0.68 ms）⇒ 典型一趟只走 1 根；`max` 隨 B 線性（8→18→47 ms）且只出現極少數次 ⇒ 那是「每個 epoch 的第一趟」與失效後的完整重放。總工作量 ＝ **一趟完整 ＋ (B−1) 次單根推進 = O(B)**（舊制為 B(B−1)/2 ＝ 4,950／19,900／124,750）。**驗收達成。**

**方法註記**：本輪為探針新增了 `advancedSteps`（同一 cache 相鄰 replay 終點之差）— 它在 B 上恆等於 B、**是下界且不具判別力**（任何新增一根的呼叫都會得 1，無法分辨「續跑」與「從 0 重放」）。判別力來自上表的**每趟 ms 分布**：若仍是從 0 重放，500 根時的中位數會是 ~47 ms（＝修前 23,422/499），實測是 0.263 ms（差 179×）。

**閘門**：D1 **未修改任何 `src/` 檔**（只動 `scratch/perf/` 的探針），故沿用 reviewer 回修後的閘門：`tsc` rc=0、`vitest run src/pine` **70 檔／1002 passed｜1 skipped**、四支 digest 逐字不變、golden 14 passed｜1 skipped、`PARITY OK`。

### 9.2 殘項 R2（新發現，不在 P2 驗收範圍）

`strategyEquity.ts:53-58` 的 `equityAt` 仍對每個過去 bar 直接呼叫 `simulate(shifted(ctx,b), orders, cfg, b)`（**從 0 重放**），因此**讀 `strategy.max_drawdown`／`max_runup` 的腳本另有自己的超二次項**（且 `DdCache.count` 在 orders 變動時整條重算）。實測（`scratch/perf/t8a-dd-{read,noread}.pine`，app 路徑）：

| bars | 每根不讀 dd | 每根讀 dd | 倍率 |
|---|---|---|---|
| 100 | 21.51 ms | **798.21 ms** | 37.1× |
| 500 | 148.43 ms | **108,204.61 ms** | 729× |

（5× bars ⇒ 135.6×，比二次的 25× 還糟 ⇒ 除 `equityAt` 的 Σb 外，另有 `count` 失效導致的整條重算。）修法即本計畫 §1 的選項 ①：讓 stepper 推進時順手記 `equity[b]`，`equityCurve` 改讀它。**建議另開任務**（影響面：`strategyEquity.ts` ＋ `strategy.ts` 的 `SimRun` 增欄）。
