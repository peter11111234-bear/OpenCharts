# Phase 0 量測報告（影子資料集）

日期：2026-10-16（親自查驗，非子代理）
更新：2026-10-16 收盤後複核（新增 §8；資料維持 1202 列，今日已無新 bar）
資料：`logs/jev-shadow.jsonl`（1202 列）、`logs/jev-shadow-errors.jsonl`（426 列，歷史失敗診斷）
方法：唯讀 Python 統計 + `/health`；前向報酬為模擬 proxy，非真實損益。

## 1. 樣本規模

- 資料集 1202 列，bar_time 2026-09-21T13:45+08:00 → 2026-10-16T13:45+08:00。
- 日盤（08:45–13:45）僅 306 列，夜盤殘留 896 列。原因：日盤 filter 今日才上線，歷史夜盤已寫入，分析時必須先過濾。
- errors log 426 列為 9/22–9/24 失敗診斷列，不進資料集。

## 2. action_choice 分布

- hold 1137（94.6%），buy 65（5.4%），sell 0。
- 平均 confidence 0.759；hold 0.777（n=1137），buy 0.443（n=65）。
- confidence < 0.6 共 264 列，其中 buy 57、hold 207。
- 最大發現：資料集裡 Jev 從沒說過 sell。方向是不對稱的，Phase 1 前必須先解釋（是標的偏多、問題設計偏多，還是閾值問題）。

## 3. channel / 成本

- channel 欄位：legacy（無標記）594，jev-direct 608。legacy 是加欄位之前的列。
- model：typesafe relay 223、jev-1.13-free 176、jev-1.13.0 803。
- `/health` 當下：calls_today 990，paid_today 611，paid_max 2000（注意：2000 是今日手動 backfill 時 shell 內 `JEV_PAID_MAX_CALLS=2000` 的殘留；程式預設已改為 1000，看護重啟後會回到 1000）。
- Jev 單價約 $0.042/M input、輸出免費，幾百筆是美分級。瓶頸是免費配額不是錢。

## 4. DeepSeek 升級層（§4.4）

- 1202 列中 deepseek 欄位 populated：0。
- 原因：wiring 今日才上線，歷史列不可能有；且舊 volatility trigger 用字串 contains 'volatile' 比對，但 Jev 回的是 score 0–1.3 數字（實測 min 0.06 / max 1.3 / mean 0.63，≥1.0 共 156 列），舊條件永遠不觸發。今日已修為 score≥1.0 或 prob2≥0.5。
- Divergence rate：尚無資料，無法計算。等明日盤中新列帶 deepseek 欄位後才能算（Phase 1 門檻：分歧率 < 15%）。

## 5. §6 risk gate 分布

- 1202 列中 risk_gate verdict 非 n/a：0。原因同上（今日才 wiring 上線）。
- 新 code 已 live（collector pid 13736，今日稍早另有舊碼重影 pid 13612 已殺掉，只留一個）。
- 明日盤後才能統計 approve/reduce/veto 與 rule 分布。

## 6. 前向報酬 proxy（模擬，非真實）

- 方法：方向 buy=+1、sell=−1、hold=0；找 bar_time +1h / +4h 最近 bar 的收盤價，報酬 = 方向 × (future−entry)/entry。無成本、無滑價、模擬 fill。
- 全樣本 buy：1H n=65 mean −0.077%、median −0.031%、hit 0.385；4H n=59 mean −0.043%、median −0.004%、hit 0.492。sell 無樣本。
- 日盤子集 buy：1H n=18 mean −0.244%、median −0.133%、hit 0.167；4H n=12 mean −0.977%、median −1.261%、hit 0.000。
- 解讀：樣本太小（日盤 buy 僅 18），且 4H 前向會跨進夜盤／收盤，結論只能是「目前看不到正期望的證據」，不能是「證偽」。sell 零樣本所以空頭完全無法評估。

## 7. 結論

- Divergence rate：無資料（待新列）。
- 模擬 EV：buy 為負但樣本小，不做定論；sell 無法評估。
- Gate veto rate：無資料（待新列）。
- 建議：**繼續 Phase 0，不進 Phase 1**。三個先決條件：(a) 收至少 5 個完整日盤日的新列（含 risk_gate + deepseek 欄位）；(b) 算出 divergence rate；(c) 先解釋 sell-zero 與 buy 低 confidence 偏態，再談口數。

## 8. 收盤後複核（2026-10-16 15:00 後）

- 資料集維持 1202 列，最後一根 bar 為今日 13:45（收盤），收盤後無新列是正常的。
- 新 wiring 列（risk_gate / deepseek 欄位）仍為 0 筆：wiring 上線時市場已收盤，首批帶欄位新列要等下週一（10/19）08:45 開盤後。
- 行程：collector 僅剩 pid 13736（稍早同時跑的舊碼 13612 已殺掉，同一檔案雙寫 race 已排除）；sidecar 健康，今日 paid 611（paid_max 2000 是今日手動 backfill 殘留 env，看護重啟後回到預設 1000）。
- 下週一開盤後驗收：新列應帶 `risk_gate.verdict`（approve/reduce/veto）與觸發時的 `deepseek`（approve/veto/reduce），屆時回來算分歧率與 gate 分布。
