# T8 歸因（實測）：Θ(B²) 主導項＝每根 `simAt` miss 的 replay ramp，**不是** epoch cache 丟棄

> 取證於 2026-10-15 20:0x，代理 `T8Attrib2`，凍結優化樹（`src/pine` 未動）。
> 取代 `docs/2026-10-15-r5-checkpoint-deepcopy-audit.md` 更正段對 T8 主因的指向，以及 `docs/2026-10-15-r5-remaining-autorun.md` §T8 的「先做 epoch 歸因」敘述。

## 0. TL;DR

1. **replay 步數精確等於 B(B−1)/2**：4,950 / 19,900 / 124,750（bars 100/200/500）⇒ 5× bars 得 29.5×（平方級）。
2. **epoch cache 丟棄造成的額外重算＝0 步**（`epochRebuildSteps` 0/0/0、`wastedReplays` 0）⇒ 該機制**不是**主因，甚至不是次因。
3. **主因**：`simAt` 以 `uptoBar` 為鍵，而每個 `strategy.*` 讀取都傳 `ctx.barIndex`；build/全趟的 barIndex 單調遞增 ⇒ **每根必然 miss** ⇒ 每次 `simulate()` 都從第 0 根重走到第 N 根。成本＝Σ uptoBar ＝ B(B−1)/2。

## 1. 實測數據（hook-free 暖機後 build，同 `buildMs` 口徑）

| bars | replayMs | replaySteps | epochRebuilds | epochRebuildSteps | wastedReplays | replay 佔 build |
|---|---|---|---|---|---|---|
| 100 | 793.09 | 4,950 | 4 | 0 | 0 | 81.5% |
| 200 | 3321.78 | 19,900 | 8 | 0 | 0 | 89.6% |
| 500 | 23422.09 | 124,750 | 20 | 0 | 0 | 91.4% |

`epochRebuilds` ＝ 最終 `orders.length`（每推 1 張單丟一次 cache，B/25）。
`hookOverheadFactor` ＝ 1.05 / 1.19 / 0.98 ⇒ 計數本身可信。
產物：`scratch/perf/t8-replay-attrib.json`（`--bars-list 100,200,500`）。

## 2. 差分實驗（證明 epoch 之外無殘留）

| 變體 | 效果 |
|---|---|
| epoch 數放大 25×（4→100，`t8-trade-k1.pine` 每 2 根改 `orders.length`） | 步數 4,950 → **5,049（+2%）** |
| 讀取數砍到 B/25 | 步數 → **249**；ms 938 → **43.9（−21×）** |
| 完全不讀 `strategy.*` | 全趟**只剩 1 次 replay**，23/45 ms（線性） |

產物：`scratch/perf/t8-replay-attrib-variants.json`、`scratch/perf/t8-docmatch.json`。

## 3. 修法方向（**未實作、未驗證**，僅提案）

1. **讓 Sim 增量**：`simulate(N)` ＝ `simulate(N−1)` ＋ 新一根的 fills，只在「首個改變的 order」之後重算，而非每次從 0 重走。
2. 或把鍵由 `uptoBar` 改為「已提交前綴＋增量」，使連續 bar 命中（與 1 等價但實作面較小）。
3. 驗收（若實作）：`replaySteps` 由 B(B−1)/2 降為 **O(B)**；四支 digest 不變；`s1-inc-probe` parity 6/6；golden 0 差異。

## 4. 缺的 counter（最小需求，若要長期量測）

引擎目前**沒有 `simAt` 一級計數**（本探針靠攔 `Map.prototype` 才量到）。最小加：

- `src/pine/debugFlags.ts`：新增 `simAtProbe: {global:'__pineSimAtCount'}`；
- `src/pine/internalNames.ts`：註冊；
- `src/pine/builtins/strategy.ts` 三處遞增：`simAt` 過 `orders.length===0` 後 `calls++`；`:887` 分支 `rebuilds++`；`:888 if(!r)` 內 `misses++ / replays++ / steps += uptoBar`。

## 5. 未解／未確認

1. 舊記錄值 1,487.7 / 4,574.2 / 30,024.2 ms（`t2-trade-calib.json` 的 `buildMs`）與本探針 793.09 / 3321.78 / 23422.09 之差不符固定比例（1.88 / 1.38 / 1.28）⇒ 歸因於**同時段鄰居負載**（非方法差異）[INFERENCE]；需要靜機複測才能定案。
2. series registry 每 tick +150/+201 的成長（T8b）**本次未量**，與本節的 replay ramp 是兩個獨立項。
3. 5,000 根未跑（先前 timeout）。
