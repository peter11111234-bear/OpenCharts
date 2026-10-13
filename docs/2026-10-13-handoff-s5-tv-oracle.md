# 交接：S5 strategy 保真度 ＋ TV 標準庫 oracle

日期：2026-10-13 ｜ 專案：`C:\Users\bear9\OpenCharts`（Pine Script v6 直譯器在 `src/pine/`）

前一份交接：`docs/2026-10-13-fix-four-pain-points-handoff.md`（S1–S4）。本檔接續。

---

## 0. 接手前必讀（環境陷阱）

1. **測試一律從 realpath 跑**：`cwd=C:/Users/bear9/OpenCharts`。
   `C:\Users\bear9\MYOPENCHART\OpenCharts` 是指向它的 junction，從那裡跑 vitest 會出現
   `Failed to load url .../src/__tests__/setup.ts`（假錯誤）。
2. **`src/pine/` 有兩份複本**：`OpenCharts/src/pine/` 與 `MYOPENCHART/pine-interpreter/`。改動只做前者。
3. **子代理狀態未知**：前一份交接說本機 `task`/scout 一律 `No model selected`（8/8）。本輪沒有派過，
   無法確認是否恢復；要派就先小規模試一次。
4. **`tsc` 基線本來就是紅的**：259 個錯誤，最大兩塊是 `src/services/queries.ts`(126)、
   `src/pine/parser.ts`(58)，全在未觸碰的檔案。別拿它判斷自己的改動，只 grep 自己動過的檔。
5. **git 是 Windows 原生**：路徑用 `C:/Users/...`，不要用 `/c/...`。
6. **【新】`strategy.ts` 卡在 import 循環裡**：`interpreter → builtins/strategy → mtf → interpreter`。
   從 `strategy.ts` import `../mtf` 或 `./time` 會讓 `mtf.ts` 模組頂層的 `registerMtf(...)`
   在載入期拿到 undefined（症狀：`TypeError: registerMtf is not a function`）。
   時區工具已抽到葉模組 **`src/pine/tz.ts`**（只 import contracts 型別），`time.ts` 原址 re-export。
   要從 strategy.ts 用時間相關的東西，只能走 `../tz`。
7. **【新】REA / CDP**：`chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=<tmp>`
   之後 REA 的 `list_browser_targets`（`cdp_endpoint: http://127.0.0.1:9222`）可用。
   `analyze_web_bundle` 在 TradingView 這種 50+ chunk 的頁面會撞 30s MCP 逾時 ——
   實務走「REA 列目標 → 頁面資源清單 → 單檔下載 → 本地抽取」。

---

## 1. 本次三個 commit

| commit | 內容 |
|---|---|
| `261d6e5` | **S1–S4**（前一份交接的成果，review 後才 commit）：golden 容差比對、未支援參數顯性化、`CMP_EPSILON=1e-10`、`session.*` + `time/time_close` |
| `1012ba9` | **S5 strategy 保真度**：`slippage`、`margin_long/short`（含 margin call）、`strategy.risk.*` 六個全上 |
| `64a91bc` | **R22**：TV 標準庫 oracle、`log.*`、`strategy()` 宣告序修正 |

### 1.1 S5（`1012ba9`）

- **slippage**（ticks）：只加在 market / stop 成交，limit 成交不加（Pine 原文 "the fill price of
  market/stop orders"）；trailing stop 同一條路徑。
- **margin_long / margin_short**：進場保證金閘（resulting position × price × pointvalue × ratio ≤ equity，
  等號放行）＋ TV Broker Emulator 追繳模型（`CurrentEquity ≤ MarginRequired` → 強平 4× 補足損失的部位）。
  `ratio − direction = 0` 時 `MarginLiquidationPrice` 不可達 → 100% 保證金的 long 永不被追繳。
- **strategy.risk.\***：`allow_entry_in` / `max_position_size` / `max_drawdown` / `max_intraday_loss` /
  `max_cons_loss_days` / `max_intraday_filled_orders`。每次呼叫在 ledger 記一筆 risk 事件，replay 走到該 bar
  才生效（保住 `simulate()` 是 `(orders, bars, cfg)` 的純函式）。觸發＝取消所有 pending + 當根收盤平倉；
  `max_drawdown` 與 `max_cons_loss_days` 永久停單，兩條 intraday 只停到當日收盤。
- **效能陷阱**：`riskWalk` 有「無規則且無可追繳部位就整段跳過」的前置判斷。**不要拿掉** ——
  拿掉後 turtle e2e（60s timeout）會從 10.5s 變成 60.4s 逾時。

### 1.2 R22（`64a91bc`）

- **`docs/tv-pine-stdlib.json`**：從官方 Pine v6 reference bundle 抽出的標準庫表面
  （1408 條 / 887 唯一名稱：name、qualified、thisType、syntax、args[name + allowedTypeIDs + required]、
  returnedTypes）。這是**第一個 TV 自己出的對照來源**，不再靠 PyneCore 或人工讀網頁。
- **`log.*`**：`log.info/warning/error`，兩個 overload；placeholder 走 `str.format` 同一套語法
  （格式化抽成 `str.ts` 的 `pineFormat()` 共用）；輸出收在 `ctx.logs` → `RunResult.logs`
  （`{level, bar, msg}`）。**UI 未接** —— 本 app 沒有 logs pane。
- **`strategy()` 宣告序修正**：原本第 26 格是 `max_tables_count`（strategy() 沒這個參數），且缺
  `calc_bars_count` / `fill_orders_on_standard_ohlc` / `dynamic_requests` / `behind_chart` /
  `calc_on_every_history_tick` → 第 25 格之後的位置參數全部錯位。已對齊 TV 的 34 格。

---

## 2. 驗證狀態（全部在 realpath 跑）

| 項目 | 結果 |
|---|---|
| `npx vitest run src/pine` | **48 檔 / 826 passed / 1 skipped**（196s） |
| golden | 全綠，**不需重生成**（S5 那次重生成後只有 TRIS390 的 warnings 變，`max\|Δ\|=0`） |
| `tsc` 本次動到的檔案 | 0 錯誤 |
| e2e turtle | 10.5s（`riskWalk` 前置判斷生效） |

---

## 3. 已知限制（刻意留下，不是半成品）

1. **追繳平倉不截斷成整數合約**：本引擎全程用分數部位，TV 會 `TRUNCATE` 到最小合約單位。
2. **risk 規則以事件密度近似逐 bar 評估**：`advancePending` 一次補到事件 bar，
   事件稀疏時 bar 內時序會失真。
3. **進場保證金不足時直接不成交並 warnOnce**：TV 是拒絕並報錯。無 TV oracle 可實測，這是唯一
   無法驗證的一段；副作用是宣告 margin 的腳本可能少幾筆進場（turtle 用合成資料跑就會觸發）。
4. **`session.ispremarket` / `ispostmarket` 一律 false**：本 app 無 extended-hours 資料源。
5. **跨年 D/W `bars_back` 走法未實作**：回傳算術值並 warn 一次（PyneCore 有量測過的 mirror 規則可照抄）。
6. **`log.*` 沒有輸出面板**：資料在 `RunResult.logs`，UI 要另做。

---

## 4. 下一步

### 4.1 TV oracle 怎麼用

```bash
# 更新 oracle（bundle 的 chunk hash 隨 TV 部署變動，--auto 會重新定位）
node scratch/_extract_tv_stdlib.mjs --auto docs/tv-pine-stdlib.json

# 看目前缺口（會印出 887 個 TV 名稱中還缺哪些，依 namespace 分組）
npx vitest run src/pine/__tests__/tv_stdlib.test.ts
```

`scratch/tv-bundle/` 已加進 `.gitignore`（第三方 bundle 不進版控）。

### 4.2 目前缺口（R22 量測）

| namespace | 缺 | 備註 |
|---|---|---|
| `matrix.*` | 48 | 純工作量；`Value` kind 與 flat 解構已鋪好路 |
| `strategy.*` | 45 | v5/v6 成員：`account_currency`、`avg_*_trade*`、`closedtrades.entry_id/exit_id/entry_comment/…`、`max_runup`、`wintrades/losstrades/eventrades`… |
| `currency.*` | 43 | 常數，機械工作（本引擎只有 13 個） |
| `ta.*` | 13 | `alma`、`barssince`、`rising/falling`、`pivot_point_levels`、`range`、`rci`… |
| `chart.*` | 10 | `bg_color`、`is_*`（圖表類型）、`left/right_visible_bar_time` |
| `map.*` | 10 | |
| `ticker.*` / `footprint.*` / `volume_row.*` | 9 / 9 / 8 | |
| `syminfo.*` / `timeframe.*` / `barstate.*` / `dayofweek.*` | 40 / 13 / 7 / 7 | **多半是誤報** —— 這些走 `ctx.syminfo` / `timeframeFields()` / `barstateUdt()`，不在 registry |

對照表（`docs/pynecore-conformance.{json,html}`）是另一個角度：56 條裡 full 34 / partial 15 / missing 5。
兩份一起看再決定切哪一刀。

### 4.3 建議順序

1. `strategy.*` 的 45 個成員 —— 直接影響回測數字與 UI 欄位（跟剛做完的 S5 同一條線）。
2. `ta.*` 的 13 個 —— 有真實腳本在用（`barssince`、`rising/falling` 最常見）。
3. `currency.*` 43 個常數 —— 半天、機械。
4. `matrix.*` 48 個 —— 沒腳本在用，計畫文件的 P2 原則是「等真有腳本要用再做」。

---

## 5. 工作區未 commit 的東西

- `docs/2026-10-13-fix-four-pain-points-handoff.md`（前一份交接）
- `docs/superpowers/plans/2026-10-13-typescript-debt-remediation.md`
- `scratch/vela_*.png`（6 張 Vela 截圖）
- `scratch/tv-bundle/`（已 gitignore）

三個 commit 之後工作區乾淨（`git status` 只剩上面這些未追蹤檔）。
