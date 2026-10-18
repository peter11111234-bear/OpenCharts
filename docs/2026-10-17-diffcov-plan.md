# diffcov REAL PLAN（v2 定稿，2026-10-17）

工單：`docs/2026-10-17-diffcov-workorder.md`；狀態 `taskwf_gate.py --name diffcov`（tier=heavy）。
版本：v1（草稿，P5 開工時寫）→ **v2（本檔，納入 advisor P5 四點）**。差異見 §7。

## 0. 目的與不變量

把一次性差分探針產品化為常駐測試，覆蓋 `strategy.exit` 參數面、`oca_*`、`cancel`／`cancel_all`／`close_all`、`risk.max_position_size`／`allow_entry_in`、多日界。

不變量（每 bar b，`Object.is`，禁用 `toBeCloseTo`）：
1. `SimCache.equity[b]` ≡ oracle(b)（from-scratch replay：`shifted` + `simulate`）
2. 公開 `strategy.equity` 讀值 ≡ oracle(b)
3. **stride 不變性**（advisor/JEV Q4=0.72）：同一 scenario 下，逐 bar 單讀與跳躍稀疏讀得到的 sink 曲線逐元素相同
4. **凍結字面值**（v1→v2 新增，advisor Q1）：每一類面至少一格以「手導出後寫死的期望值」為第三錨 —— 不與兩個 live 計算互比，切斷共碼盲點

## 1. 交付物

- 新檔 `src/pine/__tests__/strategy_equity_diff.test.ts`（唯一新增的版控檔）
- 條件式：若差分冒出真實不一致 → `src/pine/builtins/strategy.ts` 最小修正（N6）。**P4 實測未觸發**（見 §6）
- QA 報告 `docs/2026-10-17-diffcov-qa.md`；工單／交接／回報更新

## 2. 步驟＋每步驗證

| # | 步驟 | 驗證 |
|---|---|---|
| S1 | harness 區塊：verbatim frozen oracle（`shifted`/`equityAt`）+ `mkBars`/`mkRtCtx`/`callFn`/`ordersOf`/`recordedEquity`/`mismatches` + 種子 RNG + `mintick` 設定；檔頭寫明 §4 的四條界限與 §5 的框架（characterisation，非缺陷宣告） | `npx vitest run src/pine/__tests__/strategy_equity_diff.test.ts` 出現 1 個 trivial `it` 綠 |
| S2 | G1 exit 面手寫格：`profit`/`loss`（ticks→價）、`trail_price`、`trail_points`+`trail_offset`、顯式 `stop`/`limit`、`qty`、`qty_percent`、`from_entry`（行為釘住）；每格三錨（凍結字面值＋sink＋公開讀） | 每格綠；字面值先由 oracle 印出後寫死（P7 突變轉紅） |
| S3 | G2 oca 格：`strategy.oca.cancel`（兄弟 `cancelledAt=bar−1`，禁同 bar 成交）與 `strategy.oca.reduce`（mod.qty 遞減、歸零即取消）+ 至少一格凍結字面值 | 綠 + 突變（ocaType→`none`、reduce 不遞減）轉紅 |
| S4 | G3 cancel／cancel_all／close_all 格：pending 移除後永不成交；cancel bar 的成交優先於取消；`close_all` vs `close('')`（exitId）；`immediately=true` 變體 + 至少一格凍結字面值 | 綠 + 突變（cancel 事件 no-op、close_all 降級為 close）轉紅 |
| S5 | G4 risk 格：`max_position_size`（只縮 entry、反轉只看新側、可回 0 不成交）、`allow_entry_in`（禁向 entry 變純平倉）、多日界（`max_intraday_loss`／`max_intraday_filled_orders` 跨日重置；bars 帶 `Date.UTC` 時間）+ 至少一格凍結字面值 | 綠 + 突變（日界 key 改 bar index、allow_entry_in 反向、cap 不生效）轉紅 |
| S6 | 互動格（advisor Q3）：exit×oca、exit×cancel/close_all、risk×日界 | 綠 + 每格突變轉紅 |
| S7 | 有界決定性種子掃描（N≈60 seeds × n≈12 bars，隨機組合 G1–G4；固定 seed）＋ stride 不變性檢查（單讀 vs 稀疏讀，逐元素 `Object.is`）。**常駐**（advisor Q2） | 綠；報告印 `scenarios=…/mismatched=…/stride checked=… differing=…` 供 QA 引用 |
| S8 | 全套回歸（P7／P9 前才跑，成本分級）：`npx vitest run src/pine`、`npx tsc --noEmit`、golden 14｜1、四支 digest | 全綠／digest `1e63vl8`／`kb0glc`／`1580h2`／`p4gddl` 逐字不變 |

**同檔路由**：S1–S7 全在同一支新檔 ⇒ 序列寫、不併發（不派同檔並行 slice 代理）。若 P6 由主 LLM 序列完成，於 `done P6 --evidence` 註明未派 slice 代理。

## 3. 突變自證清單（P7 用，v2 依 advisor Q3 擴充）

面刪除型（每格）：把該面停用 ⇒ 該格必須轉紅。
**定向擾動型**（每面至少一支，確保非空洞）：
1. bar/stride off-by-one（把 sparse 讀集合偏移一根）
2. `trail_offset` 晚一格套用
3. `oca.reduce` 不遞減兄弟 qty
4. 日界 carry 用錯日（前一日基準）
5. `allow_entry_in` 閘門反向
六類突變皆以**臨時**手段施加（不進 repo，逐一還原），證據寫進 QA 報告。

## 4. 測試檔頭必須寫明的界限（不得含糊）

1. oracle 與被測共碼：本差分證明「快取折疊 ≡ from-scratch replay」，**不證明** `simulate()` 自身正確（fill 撮合／OCA／佣金／風控閾值／margin／FIFO 皆測不到）。此為結構性盲點，故加 §0-4 凍結字面值錨。
2. `strategy.exit` 的 `from_entry` 目前是死參數（一律全平）⇒ 該格是**行為釘住**，不是正確性主張；缺口回報使用者。
3. `strategy.risk.max_cons_loss_days` 已裁決為讀取樣式相依，矩陣不安裝，由既有 pinned `it` 覆蓋。
4. 斷言限縮在有限 close 的 bars：sink 走 `curveEquity`（有 finite guard），公開 `strategy.equity` 讀值無 guard ⇒ 非有限 close 兩者本就會不同。

## 5. 交付框架（v2，advisor Q4）

本工單**是回歸／特徵化覆蓋**（pinning current behaviour），**不是缺陷修復**：P4 掃描 1200 個 scenario 全 0 mismatch。測試檔頭與最終回報都要這樣寫，避免「新增測試」被誤讀為「修了 bug」。

## 6. 預檢與 P4 既有證據

- 環境：`npx vitest`／`npx tsx`／`npx tsc` 可用（前一工單實測）。
- 憑證／環境變數：不需要。花錢的呼叫：無。**全域設定：不改任何全域設定／其他工具 config。**
- 寫入範圍：新增 1 測試檔 + 條件式 `strategy.ts` + `docs/**`。
- P4 前置實測（探針 `scratch/_r3-diffcov-probe.mts`，470 行）：baseline 300 seeds 0 mismatch；G1 exit 六面 300 seeds 0（各面覆蓋 83–111 次）；G2 oca 300 seeds 0（cancel 563／reduce 554 兄弟單）；G3 cancel/close_all 300 seeds 0；G4 risk+多日界 300 seeds 0；stride 1200 pair 0 differing。主 LLM 獨立複核 G2/G4 各 60 seeds ⇒ 0。

## 7. v1 → v2 差異（advisor P5 後）

- 新增 §0-4 凍結字面值錨（Q1：切斷共碼盲點，最大偵測力提升）。
- S2/S3/S4/S5 各要求至少一格凍結字面值（不只 exit 面）。
- §3 新增定向擾動型突變清單（Q3：刪除型不足以證明非空洞）。
- S7 明定常駐（Q2）。
- 新增 §5 交付框架（Q4）。

## 8. 成本與取捨

- 成本：主 LLM 序列實作 1–2 小時；測試執行 <10 秒（有界掃描）。無外部花費。
- 較快：只寫 G1–G4 手寫格（不含互動格／stride／掃描）。**較安全（建議）**：含 §2 全部 + §3 突變。
- advisor 呼叫方式（可重現）：eval kernel `completion(prompt, model="slow")`＝`opencode-go/mimo-v2.6-pro`；結論記於 `advisor P5 --evidence`。

## 9. 核准前的準備工作（P5 🔒 等待期間完成，scratch only）

字面值推導（S2–S5 第三錨）已做出可複現結果，證據：`scratch/_r3-literals.mts`、`scratch/_r3-literals2.mts`、`scratch/_r3-c1-diag.mts`。

- 6 格（exit profit／exit loss／oca cancel／cancel+close_all／max_position_size+allow_entry_in／多日界 intraday）已印出 sink／公開讀／oracle 三陣列；其中 4 格另以**手算字面值**對帳，三方 `Object.is` 全 MATCH。
- **設計約束（重要，進 P6 前必知）**：`profit`／`loss`／`trail_*` 單位是 **mintick**，而 `BarCtx` 的 `syminfo.mintick` 預設 **0.01**。首輪我把 `loss=5` 當成 5.00，實際是 0.05 → stop=99.95，exit 在第 2 根就成交（-0.05）。因此每格**必須顯式設 `ctx.syminfo.mintick`**，且 bars 要用**顯式 OHLC**（`open/high/low/close` 各自設定），否則關卡觸價與跳空調整（`adj`）會讓字面值不可預期。
- 兩條既有行為（characterisation，非缺陷，寫進檔頭）：(1) `allow_entry_in` 禁止方向的反向 `entry` 會轉為**平倉**（C5 實測：多單在第 3 根 open 被平掉）；(2) `max_intraday_loss` 觸發時於當日**全平**（C6 實測：第 2 日 -1200 後維持已實現 -1200，之後不再隨價格回復）。
- 待補（P6 內）：多日界的**重置**格需要「兩日各自未觸發、累計才超過」的設計，才能證明日界重置本身（而非只是觸發全平）。
  → **已完成（同批，C7）**：`qty=800`、3 bars/day、`max_intraday_loss(1% of equity)`，第 2 日 -800（0.8% < 1%）、第 3 日再 -800（0.806% of 99200 < 1%），累計 -1600（1.6%）**未觸發**；第 4 日回到 100000 即為判別點（重置壞掉會卡在已平倉的 98400）。手算字面值 `[100000,100000,100000,99200,99200,99200,98400,98400,98400,100000,100000,100000]` 與 sink、oracle **三方 MATCH**。
- **工具自檢（instrument non-vacuity，寫測試前必做）**：`scratch/_r3-harness-selfcheck.mts` 對同一 sink 施加四種人工破壞，全部被偵測：oracle 位移一根、1 ULP 的 sink 擾動（`Object.is` 抓到，而 1e-6 容差比較**漏掉**）、sink 截斷、stride 差 1 ULP；乾淨執行兩錨皆 MATCH。
- **P6 草稿已備妥並在 scratch 內跑綠（未寫入 repo，等 P5 核准）**：`scratch/_r3-diffcov.test.ts`（14 tests，`npx vitest run --config scratch/_vitest.scratch.config.ts` ⇒ `14 passed`，含 60 個決定性 scenario 的掃描＋stride 檢查）。複製進 `src/pine/__tests__/` 時唯一的機械改動是 import 前綴 `../src/pine/` → `../`（與既有測試同深度）。
- 草稿期間自抓到**兩個場景／harness 陷阱**（皆為我的設計錯，非產品問題，記錄以免重犯）：
  1. **harness**：`drive` 若只在「讀取 bar」執行腳本呼叫，稀疏 stride 會跑出**不同的帳本**（少下單），於是每次比較都紅。正解＝所有 bar 都依序執行呼叫，只有 equity 查詢稀疏。
  2. **場景**：賣出停損若掛在**市價之上**（多單 stop 103、市價 100）會立刻觸發並以開盤價成交（比停損價更好），把部位在下一根就打平。多單的 stop 必須設在市價之下（短單反之）。
  另記一條行為（characterisation）：賣出 stop 觸發時成交價取 `min(stop, open)`、買進取 `max(stop, open)`。



