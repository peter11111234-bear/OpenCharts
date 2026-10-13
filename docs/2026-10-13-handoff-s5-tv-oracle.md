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
| `strategy.*` | **0** | 2026-10-13 追加完成（見第 6 節）：96/96 全註冊 |
| `currency.*` | 43 | 常數，機械工作（本引擎只有 13 個） |
| `ta.*` | 13 | `alma`、`barssince`、`rising/falling`、`pivot_point_levels`、`range`、`rci`… |
| `chart.*` | 10 | `bg_color`、`is_*`（圖表類型）、`left/right_visible_bar_time` |
| `map.*` | 10 | |
| `ticker.*` / `footprint.*` / `volume_row.*` | 9 / 9 / 8 | |
| `syminfo.*` / `timeframe.*` / `barstate.*` / `dayofweek.*` | 40 / 13 / 7 / 7 | **多半是誤報** —— 這些走 `ctx.syminfo` / `timeframeFields()` / `barstateUdt()`，不在 registry |

對照表（`docs/pynecore-conformance.{json,html}`）是另一個角度：56 條裡 full 34 / partial 15 / missing 5。
兩份一起看再決定切哪一刀。

### 4.3 建議順序

1. ~~`strategy.*` 的 45 個成員~~ —— 已完成（第 6 節）。
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

---

## 6. 2026-10-13 追加：`strategy.*` 96/96 全註冊（S6）

`docs/tv-pine-stdlib.json` 的 45 個缺口一次補完；`tv_stdlib.test.ts` 的
`IMPLEMENTED_PREFIXES` 由 `'strategy.risk.'` 升級為 `'strategy.'`，整個 namespace 現在是
契約（887 名稱中 530 → 575 已註冊）。

**語意來源**：`scratch/pine-v6-kb/`（github.com/mrojas-mx/pine-script-v6-kb，TV v6 參考文件的
機器可查版，已加 .gitignore）。百分比基準照官方：整體區間指標 ÷ initial_capital，單筆指標
÷ 該筆的 size（entry price × quantity），`openprofit_percent` 是 openPL / realizedEquity。

**新增資料**：`TradeLeg`/`ClosedTrade` 各加 `id`/`comment`/`exitId`/`exitComment`；
`Sim` 加 `positionEntryName` + `maxContractsAll/Long/Short`（部位只在成交時變，逐筆追蹤即精確，
不碰 riskWalk 的跳過最佳化）。`StratCfg` 加 `marginDeclared`。

**MFE/MAE 走 lazy 掃描 + 內容鍵快取**（`excursionOf`，key 用 entry/exit bar + 價格 + 數量）：
不進 replay 熱路徑，且官方範例「每 bar 迴圈所有 trade」只會各掃一次。**注意**：
`TradeLeg.exitBar` 初始值就是 -1，用 `'exitBar' in t` 判斷 closed/open 會誤判 ——
已改成用 namespace 判斷（這個 bug 被新測試抓到）。

**`margin_liquidation_price`** 由追繳條件 `equity − margin = 0` 解出：
`(dir·Q·PV·entry − E0) / (Q·PV·(dir − ratio))`，E0 = initial_capital + realizedPnl。
分母為 0（100% 保證金 long）＝ 不可達 → na；未宣告 margin 參數 → na（照官方）。

**已知取捨**（不是半成品）：
1. `convert_to_account` / `convert_to_symbol` 沒有 FX 資料源 → 同幣別為恆等，跨幣別
   warnOnce 一次後原值返回（不編造匯率）。
2. `opentrades.capital_held` 用當前 close 的市值 × 該方向的 margin ratio（與 `marginCall`
   的 MVS 同一個價），na 條件是兩邊 margin 都是 0。
3. `closedtrades.first_index` 恆為 0（本引擎不裁切 List of Trades）。

**驗證**：`npx vitest run src/pine` → 48 檔 / 833 passed / 1 skipped；新增 7 個測試在
`strategy.test.ts` 的 `strategy metrics` 區塊（含 margin_liquidation_price 與追繳條件的一致性斷言）。
`docs/pynecore-conformance.{json,html}` 的 `ours_measured` 已同步（builtins 412→449、
constants 189→193、strategy_builtins 21→47）。

---

## 7. 2026-10-13 追加：312 的真實分解（度量修正）

第 4.2 節那個「缺 312」是 **registry 原始 diff**，不是待辦數。用
`scratch/_gap_class.ts` 把 887 個名字逐個真的跑一遍，得到：

| 分類 | 數量 | 內容 | 判定 |
|---|---|---|---|
| 走別的路徑解析 | 40 | 全域 11（`close`/`high`/`volume`/`bar_index`/`hlc3`…）、`syminfo` 13、`timeframe` 9、`barstate` 7 | **不是缺口** —— 走 `ctxSeries` / `ctx.syminfo` / `timeframeFields` / `barstateUdt` |
| 語言語法 | 34 | 關鍵字（`and`/`or`/`for`/`while`/`var`/`enum`/`type`/`import`/`export`/`simple`/`series`/`const`/`method`/`once`/`varip`）、宣告語句（`indicator`/`strategy`/`library`）、namespace 根（`array`/`matrix`/`map`/`polyline`/`linefill`/`footprint`/`volume_row`）、參數名（`max_bars_back`/`size`/`initial_value`/`rows`/`columns`）、`not`/`if`/`switch`/`for...in` | **不是缺口** —— 當值用本來就該報錯 |
| **真實缺口** | **238** | 見下 | 待辦 |

**312 = 40 + 34 + 238**（`registryAbsent` → `alignment backlog`）。

`tv_stdlib.test.ts` 已改成印兩個數字，並新增一個測試用 9 個代表名（正反案例）
驗證 `resolvesFromCtx()`（新匯出於 `interpreter.ts`，與 `evalIdent`/`evalMember`
的非 registry 分支同源）跟引擎的實際行為一致 —— 度量本身現在是可驗證的。

### 238 個真實缺口，按價值分四批

| 批次 | 數量 | 內容 | 成本 |
|---|---|---|---|
| A. 純常數 | ~70 | `currency` 43、`plot` 4、`dayofweek` 7、`adjustment` 3、`scale` 3、`backadjustment` 3、`settlement_as_close` 3、`display` 1、`input` 1、`chart` 的部分 | 半天，機械 |
| B. stub + warn | ~45 | `footprint` 9、`volume_row` 8、`ticker` 9、`earnings` 7、`dividends` 5、`request` 5、`splits` 2（照 `request.ts:38-42` 既有模式） | 半天 |
| C. 真函式 | ~72 | `ta` 13（**優先**，有腳本在用）、`map` 10、`matrix` 48（沒腳本在用，最後）、`array.copy`/`label.copy`/`box.copy`/`line.copy` | 1–2 天 |
| D. 需資料源 | 27+6 | `syminfo` 缺的 27 個欄位（多為基本面／分析師資料）、全域 `ask`/`bid`/`timenow`/`time_tradingday`/`weekofyear`/`last_bar_time` | 有資料源才做 |

**注意**：`syminfo` 那 27 個欄位補成 na 會**蓋掉**現在有用的 `unknown constant` 警告
卻不給資料 —— 沒有資料源之前，維持警告比回 na 誠實。

### 一個被推翻的中間結論（留著當教訓）

第一次探測時我用 `/not found/` 篩警告，得出「124 個值類名稱靜默回 na、不報警告」，
準備去修「靜默失敗」。**那是探測器的 bug**：member 解析失敗的訊息是
`unknown constant 'currency.AED'`，不含 "not found"，所以被誤判成「沒有警告」。
改成 `/not found|unknown constant/` 後 silent = 0。

**本引擎沒有靜默失敗這一類**：未註冊的 `ns.member` 一律 `unknown constant`、
未註冊的裸名／namespace 根一律 `identifier 'x' not found`，都是每 run 一次的警告。
寫探測器時，斷言「沒有輸出」比斷言「有錯誤」更容易誤判 —— 要用實際產生的值／訊息全文。
