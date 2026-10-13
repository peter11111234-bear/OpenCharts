# 交接：Pine ⇄ TV 標準庫對齊（S5 strategy 保真度 → S7 ta.\*/常數）

日期：2026-10-13 ｜ 專案：`C:\Users\bear9\OpenCharts`（Pine Script v6 直譯器在 `src/pine/`）

前一份交接：`docs/2026-10-13-fix-four-pain-points-handoff.md`（S1–S4）。本檔接續。

**檔名說 s5，但內容涵蓋到 S7**（同一天同一條線，附錄直接往下加，沒有另開檔）：

| 章節 | 內容 | commit |
|---|---|---|
| §0–§5 | S5 strategy 保真度 ＋ TV oracle 初版 | `a74c7ed` |
| §6 | `strategy.*` 96/96 全註冊 | `8de652c` |
| §7 | 「缺 312」的真實分解 ＋ 對齊報告改量 backlog | `3f7a95f` |
| §8 | `ta.*` 13 ＋ 常數 75（backlog 238 → 150） | `962df6d` |
| §9 | **交接清單：未完成事項**（先讀這節） | `962df6d` |
| §10 | 追加：`map.*`、A 四項、B 三項、TS 技術債(275→0)、45 顆資料源 stub(backlog 140→95) ＋**對 §9.2 三處前提的更正** | `a66631b`＋`6e5c6d4` |
| §10.7–§10.8 | 45 顆資料源 stub(140→95)、小刀批次 10/14(95→85) | `bf82d48`＋`a76318e` |
| §10.9 | 未知具名引數驗證 v2：2 個綁定點 → **6 個**（JIT binder／`math.*`／宣告／`request.*`）＋ draw setter/getter 的 `id=` 回歸修正；P8 review 後再修 3 處假警告 | `c9344b2` ＋ S10（本輪） |
| §10.10 | `timeframe.from_seconds`／`weekofyear`／`timenow`／`in_seconds` 月長修正（backlog 85→82） | S10（本輪） |

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

---

## 8. 2026-10-13 追加：backlog 238 → 150（S7：ta.* 13 ＋ 常數 75）

第 7 節把 312 拆成「40 誤報 / 34 語法 / 238 真缺口」之後，這一輪收掉其中 88 個：

| 批次 | 數量 | 內容 |
|---|---|---|
| `ta.*` 真函式 | 13 | `accdist` `alma` `barssince` `falling` `iii` `max` `min` `percentrank` `pivot_point_levels` `range` `rci` `rising` `wvad` |
| 常數／列舉 | 75 | `currency` 43、`dayofweek` 7、`chart.is_*` 7、`plot` 4、`scale` 3、`adjustment` 3、`backadjustment` 3、`settlement_as_close` 3、`display.pine_screener` 1、`input.enum` 1 |

報告現在印：`TV names: 887 | registered: 663 | absent from registry: 224 | alignment backlog: 150`。

### 8.1 `ta.*` 的實作要點（`src/pine/builtins/ta.ts`）

- **13 個全部有現成參考**：`src/pine/pinets{Stateless,StatefulA,StatefulB}.ts` 是 pinets 的逐字移植
  （只掛在測試 shim 上，`pinetsAll` 沒有生產 import）。公式照它抄，**不要**直接把 shim 接進生產
  （那是另一套 PtSeries/PineTsCtx 執行環境）。
- **`ta.accdist` / `ta.iii` / `ta.wvad` 是變數不是函式**（`plot(ta.iii)` 合法、`ta.iii()` 不合法）
  → 註冊成 `registerLazyConstant` + `FnSeries`，比照既有的 `ta.tr` / `ta.obv` / `ta.wad`。
- `ta.iii` / `ta.wvad` 是**逐 bar**（官方文件「the same on pine」的鏡射就是逐 bar 公式），
  只有 `ta.accdist` 累加；`range === 0` 貢獻 0。
- `ta.max` / `ta.min` 是**全歷史**的 running 極值（v6 語意），不是 rolling。
- `ta.range` 的窗口是「最近 length 個**非 na** 值」；`ta.percentrank` 的 na 比較為 false 但不改變分母。
- `ta.barssince` 用遞推（cond → 0；否則 prev+1；prev 是 na 就維持 na）——**不要**寫成每 bar 往回掃，
  條件永不成立時會退化成 O(n²)。
- **陷阱**：`reg(name, fn, false)` 會讓 `evalArg` 不再把純量引數包成 per-callsite BarSeries
  （`interpreter.ts:1303` `noHist`），需要讀歷史的引數（例如 barssince 的 condition）**必須**用預設
  `hist = true`。
- **測試陷阱**：`x = ta.iii` 這種「先把 series 常數綁到變數」的寫法會讓 plot 拿到未解開的 series
  Value（畫出來是空的）；`plot(ta.iii, "x")` 直接寫才對。布林值不能直接 plot，用 `? 1 : 0`。

### 8.2 常數的兩個判斷

- **`currency.*` 的值改成裸碼**（`currency.TWD === 'TWD'`）：TV 就是這樣，原本的 13 個存的是
  `'currency.TWD'`。`accountCurrencyOf` 已改成讀裸碼（保留 legacy 前綴剝除），`strategy.test.ts` 的斷言同步更新。
- **`chart.bg_color` / `chart.left_visible_bar_time` / `chart.right_visible_bar_time` 刻意不註冊**：
  本引擎沒有圖表顏色與可見區間來源，補成 na 只會蓋掉現在有用的 `unknown constant` 警告。
  這 3 個（＋`syminfo` 27 欄位＋資料源類）是第 7 節「D 批：有資料源才做」的同一條線。

### 8.3 剩下的 150，按價值

| 批次 | 數量 | 建議 |
|---|---|---|
| `matrix.*` | 48 | 沒腳本在用，最後做 |
| `syminfo` 缺欄位 | 27 | 有基本面資料源才做 |
| `map.*` | 10 | Pine v6 的 UDT 風格腳本會用，值得做 |
| `footprint` / `ticker` / `volume_row` / `earnings` / `dividends` / `request` / `splits` | 45 | 需要 tick／基本面資料源 → 註冊成 stub + warn |
| `(global)` `ask`/`bid`/`timenow`/`time_tradingday`/`weekofyear`/`last_bar_time` | 6 | 有資料源才做 |
| `timeframe` / `array.copy` / `label.copy` / `box.copy` / `line.copy` / `chart.*` 3 | 12 | 小刀，順手做 |

### 8.4 驗證

`npx vitest run src/pine` → 全綠（見 commit message）；新增 `ta_gap.test.ts`（11 個，含
`ta.pivot_point_levels` 的 level 數值與非法 type 拋錯）與 `stdlib_constants.test.ts`（7 個，
釘實際值：`dayofweek` 整數、`currency` 裸碼、`chart.is_standard` 布林、每個新列舉集合的值）。

---

## 9. 交接清單（2026-10-13 收工）

### 9.1 本輪已落地（4 個 commit）

| commit | 內容 | 驗證 |
|---|---|---|
| `8de652c` | `strategy.*` 45 個缺口全補（96/96） | `src/pine` 全綠 833 |
| `3f7a95f` | 對齊報告改量 backlog（312 → 238），`resolvesFromCtx` 匯出 + 釘住 | `src/pine` 全綠 834 |
| （本節同批） | `ta.*` 13 個真函式 + 常數 75 個（backlog 238 → 150） | `src/pine` 全綠 852 |
| （本節同批） | `pynecore-conformance` 計數與 4 個 namespace 條目同步（full 34→36、missing 5→4） | 產生器重跑 |

### 9.2 未完成 — 依「有沒有人真的受影響」排序

#### A. TV 標準庫還缺 150（`tv_stdlib.test.ts` 會印最新數字）

| 批次 | 數量 | 建議 | 為什麼 |
|---|---|---|---|
| `matrix.*` | 48 | **最後做** | 本 repo 真實腳本 0 使用（grep 驗過），補了只讓數字好看 |
| `syminfo` 缺欄位 | 27 | 有基本面資料源才做 | 補成 na 會蓋掉現在有用的 `unknown constant` 警告 |
| `map.*` | 10 | 值得做 | Pine v6 的 UDT 風格腳本會用；`Value` kind `map` 已存在 |
| `footprint` 9 / `ticker` 9 / `volume_row` 8 / `earnings` 7 / `dividends` 5 / `request` 5 / `splits` 2 | 45 | 註冊成 **stub + warn** | 需要 tick／基本面資料源；照 `request.ts:38-42` 既有模式，警告比假 na 誠實 |
| `(global)` `ask` `bid` `timenow` `time_tradingday` `weekofyear` `last_bar_time` | 6 | 有資料源才做 | 同上 |
| `timeframe` 4 / `array.copy` `array.new_linefill` `array.new_table` / `label.copy` `label.style_text_outline` / `box.copy` / `line.copy` / `chart.*` 3 | 12 | 小刀，順手做 | `chart.bg_color`、`chart.left/right_visible_bar_time` 刻意不做（無來源） |

#### B. 引擎正確性／相容性（**不是本輪造成的**，先前就列著）

1. **PyneCore「A 級」四項 —— 一項都沒做**（本輪核對過現況）：
   - **編譯期語言規則檢查**：只有 CE10188，而且是 **runtime warn-and-skip**（`builtins/util.ts:74-85`）；
     PyneCore 的另外三個（OuterWrite / ExportCapture / SecurityDrawings）**完全沒有**
     （`grep -i outerwrite\|exportcapture\|securitydrawing` = 0 命中）。TV 在存檔前拒絕的腳本，
     在這裡會跑完並給出不同數字 —— **靜默分歧**。建議做 parse 後的 AST pass。
     ⚠️ 動手前先確認一件事：我們的 parser 允許在 UDF 內寫全域變數，TV 拒絕（OuterWrite）。
   - **ScriptRequirements 靜態偵測**：`engine.ts:225` 的 `capabilities` 是固定值
     `{streaming:false, visibleRange:false, inputs:true}`，不是掃 AST 得出的腳本需求。
     與上一項共用同一次 AST 走訪，建議一起做。
   - **保留識別字命名空間 + 守衛測試**：JIT 產 `__ret`（`jit.ts:258-263`），
     `__pine*` 有 8 個名字散在 `interpreter.ts`／`engine.ts`，**沒有任何守衛測試**
     （`compile.test.ts`／`qa_yield` 裡的 `__pine` 是測試鉤子）。可觸發的靜默錯誤：
     UDF body 是 `let __ret=R.VOID; <使用者程式碼>; return __ret;` → 使用者寫 `__ret = 5` 會覆寫回傳值。
   - **合成節點帶 loc**：`loc` 在 AST 是**選填**（`contracts.ts:100 loc?:`），所以 tsc 不會擋；
     parser 產的節點都有 loc，**interpreter 根本不合成節點**，真正缺的是
     **`mtf.ts:322 / 377 / 1993`** 三處。MTF 去糖後的程式碼出錯會退化成無行號。

2. **S5 留下的已知限制**（本檔第 3 節，全部是刻意的取捨，不是半成品）：追繳平倉不截斷成整數合約、
   risk 規則以事件密度近似逐 bar、進場保證金不足是 warn 而非 error、`session.ispremarket/postmarket`
   恆 false、跨年 D/W `bars_back` 未實作。

3. **`log.*` 沒有輸出面板**：資料在 `RunResult.logs`，本 app 沒有 logs pane。

4. **新補的 `ta.*` / `strategy.*` 指標沒有 TV 數值 oracle**：oracle 只保證**名字**對齊，
   數值是我照官方文件與 pinets 逐字移植推的，**沒有**跟 TV 端逐位比對過。
   要提升信心只能靠人工在 TV 上跑同一個腳本對數字。

#### C. 技術債

- **`tsc` 基線 275 errors**（`queries.ts` 126、`parser.ts` 58、`parser.test.ts` 23、
  `round2_verify.test.ts` 8、`store.tsx` 7、`useReplayChartData.ts` 5…）。
  計畫檔：`docs/superpowers/plans/2026-10-13-typescript-debt-remediation.md`（本輪一併進版控）。
  本輪動到的檔案 0 錯誤。
- **pinets 移植層 5346 行只被測試 import**（`pinetsAll` 沒有生產 import）→ 同時是
  「ta 的參考實作庫」與「沒進生產的孤兒」。要決定：提升為生產 / 刪除 / 保留當測試夾具。
  **`ta.*` 13 個的公式是照它抄的**，刪之前先確認第 8.1 節已把語意記下來。

#### D. 工作區未追蹤 — **已清空（2026-10-13 第二輪）**

- ~~`scratch/vela_*.png` ×6~~ → **已刪**（使用者指示；`git status` 現在沒有未追蹤檔）。
  要重建同型截圖：`npm run dev` 之後開 `/vela`，而且**必須用 headed 視窗**拍 ——
  隱藏視窗只會拍到全黑（DOM 有內容、`canvas` 也建好了，但 rAF 不跑、畫面停在第 0 幀）。

### 9.3 環境陷阱（本檔第 0 節 ＋ 本輪新增）

- **新增**：`reg(name, fn, false)` 會讓 `evalArg` 不再把純量引數包成 per-callsite BarSeries
  （`interpreter.ts:1303` 的 `noHist`）→ 需要讀歷史的引數必須用預設 `hist = true`。
- **新增**：`x = ta.iii`（先把 series 常數綁到變數）會讓 plot 拿到未解開的 series Value；
  直接 `plot(ta.iii, "x")` 才對。布林值不能直接 plot，用 `? 1 : 0`。
- **新增**：寫探測器時，斷言「沒有輸出」比斷言「有錯誤」更容易誤判 —— 要用實際產生的值／訊息全文
  （第 7 節那個被推翻的「靜默 na」結論就是 `/not found/` 漏掉 `unknown constant` 造成的）。

### 9.4 建議的下一刀

1. **`map.*` 10 個**（Pine v6 腳本會用、`Value` kind 已存在、可獨立驗證）。
2. **PyneCore A 級第 3 項（保留名守衛）**：最便宜、修的是可觸發的靜默錯誤。
3. **A 級第 1+2 項合併**（同一次 AST 走訪）：使用者貼腳本時立刻報錯，是「對齊 TV」最直接的可見收益。

---

## 10. 2026-10-13 追加：map.\*、A 四項、B 三項、TS 技術債（S8）

§9.4 三刀全做完，另外做掉 §6 的 A+B 與 TypeScript 技術債。本節是驗證紀錄，
並且**更正舊交接三處前提**（都附反證）。

### 10.1 落地（commit）

| commit | 內容 | 驗證 |
|---|---|---|
| `3fe3ab6` | `map.*` 10 個（backlog 150 → 140） | `map.test.ts` 8 |
| `28b2c2d` | 編譯期檢查（PlotScope／OuterWrite／ExportCapture／SecurityDrawings）＋ ScriptRequirements ＋ 保留名登錄 ＋ mtf 合成節點 loc | `checks` 18／`checks_equivalence` 3／`internal_names` 5 |
| `1ca17fe` | `debugFlags` 單一開關入口 ＋ qualifier 推論 ＋ input 常數性閘 ＋ `astWalk` 共用走訪 | `debug_flags` 4／`qualifiers` 9 |
| `a66631b` | demo api facade 契約（`tsc` 275 → 27） | §10.4 |

全套 `npx vitest run src/pine` 在 `28b2c2d` 後是 53 檔 / 881 passed（1 skipped）。

### 10.2 A 段四項

- **編譯期語言規則**：新增 `src/pine/checks.ts`；`engine.prepare()` 呼叫 `assertScript()`，
  所以**貼進編輯器就在存檔前**拿到 `LINE:COL:` 錯誤（沿用 `ParseError` 格式，
  `pineMonaco.parseErrorLocation` 直接吃得下）。四條規則的出處寫在檔頭
  （TV user-defined-functions 文件、TV「Cannot use 'plot' in local scope」、PyneCore v6.10.8 release notes）。
  `plot()` 的 CE10188 執行期 warn-and-skip **保留**（直接呼叫 `runScript` 的測試／CLI 仍要護欄）。
  融合 vs 逐條兩種模式在 `checks_equivalence.test.ts` 對 12 個真實腳本 ＋ 一個規則陷阱腳本
  斷言診斷與 requirements 全等（`PINE_AST_SEQUENTIAL=1`，或 PyneCore 拼法 `PYNE_AST_SEQUENTIAL=1`）。
- **ScriptRequirements 靜態偵測**：`checkScript()` 回傳 `{security, externalData, orders, drawings,
  alerts, inputs, plots, viewport}`；`prepare()` 用它設 `reactsToViewport`（Vela 的 `PreparedScript`
  註解明說這欄位就是「Detected statically at prepare」），並放進 `PineToken.requirements`
  給實盤路徑當閘。
  ⚠️ **更正 §9.2.B.1 的前提**：`capabilities` 在 Vela port 裡是**每個引擎**的常數（
  `EngineCapabilities` 註解：「lets the orchestrator route without engine-specific checks」），
  不可能是每支腳本掃 AST 得出。能掃的是 `reactsToViewport` ＋ 上面的 requirements，
  `engine.ts:229` 已寫明。
- **保留識別字**：新增 `src/pine/internalNames.ts`（名字 → 為什麼是引擎的）＋
  `internal_names.test.ts` 掃原始碼：任何 `__` 開頭的字都必須登記（PyneCore
  `test_129_pipeline_names.py` 的等價物）；同一支測試也掃 `jitCompile`／`jitCompileUdf` 的
  **產出原始碼**，只准出現已登記的名字。
  ⚠️ **更正 §9.2.B.3 的「可觸發靜默錯誤」**：JIT 的使用者變數一律走
  `R.decl(node, "x")`（名字是字串，不是 JS 識別字），所以 `f() => __ret = 5` **不會**覆寫
  UDF 回傳值。已用 `PINE_JIT_UDF=1` 實測釘住（斷言 `__pineJitStats.udfCompiled` 必須增加，
  證明真的走了 JIT —— 否則測試會因為 UDF-JIT 的 8-stmt／native 閘而變成空測）。
  守衛的價值在**未來**：codegen 哪天把使用者名字當 JS 識別字用，這支測試會先紅。
- **合成節點 loc**：`mtf.ts` 三處補來源 `loc`（`declAsWrite` 的合成 reassign、
  未初始化 `float x` 的 na 節點、`runConst` 的 str 節點）。

### 10.3 B 段三項

- **統一除錯開關**：新增 `src/pine/debugFlags.ts` —— 所有開關（`interp`／`jit`／`jitUdf`／
  `noJitUdf`／`jitQuiet`／`evalCount`／`astSequential`／`stage`／`runLog`）在這裡同時定義
  globalThis 把手與環境變數；interpreter／engine／checks 全改走
  `debugFlag()`／`markStage()`／`recordRunTiming()`。`debug_flags.test.ts` 驗兩件事：
  語意（strict 只認 `true`／`1`、`noJitUdf` 優先於 `jitUdf`）＋ **原始碼掃描**（除這個檔，
  任何地方再直接讀 `process.env.PINE_*` 或 `.__pine*` 就紅）。環境變數名刻意不變，
  所以 `scripts/scratch/bench-*.mjs` 與舊筆記不用改。
- **型別 stamp（做）／常數摺疊（刻意不做）**：`src/pine/qualifiers.ts` 的 `provenSeries()` 是
  單向保守推論——只回 true 當「值證明每 bar 會變」（bar globals、`ta.*`／`request.*`／`strategy.*`
  呼叫、任何 series 當引數的呼叫、`x[1]`、會被重塑的全域、`var`/`varip`/被 `:=` 改的全域），
  其餘一律 false，所以「不確定」永遠不會擋掉能跑的腳本。目前只有一個使用者：
  `input.*` 的 `defval` 被證明是 series → 編譯期錯誤（TV 文件：除 `input.source` 外都是 `const`；
  這裡會**靜默記錯預設值**）。12 個真實腳本 0 診斷。
  **沒做常數摺疊的理由**：本引擎的運算子語意不是 JavaScript 的（int/int 除法、`%` 取模方向、
  na 傳播、容差相等），折疊器必須重用 evaluator 的運算子才算對，否則就是本輪一直在消滅的
  「靜默分歧」；而收益很小（常數每 bar 只花幾個 node dispatch）。要做的正確形狀是
  「session 建立時用 evaluator 對 literal-only 初始式求值一次」，不是另寫一套常數算術。
  **`request.security` 的 tf 也刻意不擋**：`mtf.ts` 有一條 DYNAMIC 路徑，動態 sym/tf 是
  **刻意支援**的功能，擋掉等於刪掉一個能跑的功能（TV 會拒絕）。
- **broker plugin 介面（沒做，附反證）**：`src/services/shioaji/api.ts`（含五個
  `getOrderMode() === "sim" ? …` 的分支）全 repo **零 import**、`setOrderMode()` 零呼叫、
  `src/services/shioaji/*` 唯一的對外使用者是 `VelaPage.tsx` 取 `instruments.ts` 的商品清單。
  所以現在定義 BrokerPort 會有**零個使用者**。設計已定（~40 行：
  `BrokerPort {placeOrder,cancelOrder,modifyOrder,cancelAllOrders,listOrders}` ＋
  `paperBroker`（包 `demoApi`）／`simBroker`（包 `placeLiveOrder` 等）＋ `activeBroker()`
  取代那五個 inline 三元；`PlaceOrderInput` 與 `demo.engine.PlaceOrderArgs` 欄位相同，
  不需要 cast），等實盤路徑真的接上再做。

### 10.4 TypeScript 技術債（275 → 0）

**共同根因**（不是各自的簽章問題）：`src/services/api.ts` 的 facade 型別
`typeof demoApi & Record<string, (...args: never[]) => Promise<unknown>>` —— `never[]`
讓所有 proxy 方法不可呼叫（TS2554／TS2345），`noUncheckedIndexedAccess` 又讓每個 miss 變成
`… | undefined`（TS2722）。這是 queries 78 顆、store 7、replay 10、ChartPanel／OrderModifyDialog
各 1 顆的來源，兩顆 agent 各自診斷出來、TsState 甚至先加了 per-file 補丁又被中央修法還原。

**修法（單一契約，`a66631b`）**：
- `WidenArgs<typeof demoApi>`：payload 型別不動，參數放寬（demo 的 stub 本來就忽略引數）。
- `BackofficeApi`：58 個 back-office 方法（competition／leaderboard／firm／bots／payouts／
  analytics／push／tickets／profiles ＋ `getPreferences`）逐條宣告成
  `(...args: unknown[]) => Promise<unknown>`。**不用 index signature**：在
  `noUncheckedIndexedAccess` 下它會讓每個 miss 變 `Stub | undefined`，逼出 ~50 個無意義的
  `possibly undefined` 防禦。payload 保持 `unknown`（與修法前一致，所以不會製造新錯誤），
  註解寫明 Proxy 在執行期回 `null`。

**分派結果**（5 個 agent ＋ 1 個根因修法，全部歸零）：parser.ts 58→0、`src/pine/__tests__/*`
71→0（26 檔，多為 `mkCtx` 少 `logs: []`、`time:` 應為 `openTime:`）、store＋hook 9→0（TsState
的 per-file 補丁在中央修法後**還原成 0 diff**）、queries.ts 126→0、replay 13 ＋
ChartPanel／OrderModifyDialog 各 1 →0（TsTradeUi **沒有改任何一行**：那 13 顆的根在
queries.ts 的 hook payload，中央修法讓它們自己消失）。
queries.ts 的最終形狀：一個 `callEndpoint<T>(endpoint, ...args)` helper（單一、有註解的
payload 具名點，11 處使用；demo 層的 terminal stub 給的是 `never[]`／`null` placeholder，
back-office 給 `unknown`，所以 payload 只能在呼叫點指名）＋ `api/accounts.ts` 新增
具名的 `ReplaySessionResponse`（取代 `Awaited<ReturnType<…>>`，符合 repo 的
no-ReturnType-contracts 規則）。
`npx tsc --noEmit`（＝既有的 `npm run typecheck`）現在 **0 錯誤**。

### 10.5 環境陷阱（本輪新增）

- **可以派子代理了**（§0 第 3 點那批「No model selected」沒再現）：本輪用了 5 個 `task` agent
  切不同檔案，互不衝突；`api.ts` 這種**共用根因**要指定**單一 owner**（我拿），否則兩個 agent
  會各自加 per-file 補丁。
- **原始碼掃描型的守衛測試不能隨便去註解**：`/\/\*[\s\S]*?\*\//` 會被註解裡的 glob
  （`src/**/*.ts`）誤開一個永不結束的區塊註解，把檔案後半整段吃掉（實測讓兩個名字從掃描消失）。
  正解是 `src/pine/__tests__/sourceScan.ts` 裡逐字元的引號感知掃描器（跳過字串／樣板內的註解符號）。
- **`Record<string, X>` ＋ `noUncheckedIndexedAccess`**：miss 會得到 `X | undefined`，
  動態 facade 不要用 index signature，逐條宣告。
- `map.*` 的 key 是**有型別的**：`Map<string,Value>` 內部用可逆編碼（字串裸存、其他 kind 加
  `\u0001` tag ＋ 逃脫），所以 `map<int,..>` 的 1 與 `map<string,..>` 的 `"1"` 不會撞；
  非原生 key 直接丟 `PineRuntimeError`，不靜默存。

### 10.6 還沒做（下一步）

1. **TS 已歸零**（§10.4）：`npm run typecheck` script **本來就在**（不是本輪新增），repo 沒有
   `.github/workflows`、也沒有 husky／pre-commit，所以「防回歸」要自己選：掛 pre-commit
   （每次 commit ~40–80s）或等有 CI 再掛。`docs/superpowers/plans/2026-10-13-typescript-debt-remediation.md`
   的 Phase 3 講的就是這件事（該計畫的 Phase 2 現在 100% 完成）。
2. **§9.2.A 剩下的 82**（45 顆資料源 stub ＋ 小刀 10 顆 ＋ 本輪的 `timeframe.from_seconds`／
   `weekofyear`／`timenow`，見 §10.7／§10.8／§10.10）：`matrix.*` 48（本 repo 真實腳本 0 使用，
   最後做）、`syminfo` 27 欄位（等基本面資料源）、`(global)` **4**（`ask`／`bid`／`time_tradingday`／
   `last_bar_time`，等資料源）、`chart.bg_color`／`left_visible_bar_time`／`right_visible_bar_time`
   （刻意不做，理由見 §9.2.F）。
3. **常數摺疊**（正確形狀見 §10.3）與**broker port**（設計見 §10.3），等對應前提成熟。
4. `scratch/vela_*.png` ×6 **已刪**（§9.2.D）；同一輪也停掉卡在 `5173` 的孤兒 dev server
   （esbuild 子行程已死，見 §10.11），新的 dev server 跑 `127.0.0.1:5174`。

---

### 10.7 2026-10-13 追加：45 顆資料源 stub（backlog 140 → 95）

`docs/tv-pine-stdlib.json` 的那 7 個批次全補齊（`footprint` 9／`ticker` 9／`volume_row` 8／
`earnings` 7／`dividends` 5／`request` 5／`splits` 2 ＝ 45），`tv_stdlib.test.ts` 印的
alignment backlog 由 **140 → 95**（`absent from registry` 214 → 169）。

檔案：
- `src/pine/builtins/datasource.ts`（新）：31 顆函式 stub ＋ 14 顆欄位 lazy constant。
- `src/pine/builtins/request.ts`：`STUBS` 補 5 個（`economic`／`financial`／`footprint`／
  `quandl`／`seed`）—— `request.*` 的 stub 留在同一個檔，訊息格式沿用既有那條。
- `src/pine/builtins/index.ts`：`import './datasource'`（builtins 是 import-time 自註冊）。
- `src/pine/__tests__/datasource.test.ts`（新，4 顆）。

兩個判斷（都不是照 §9.2 的字面抄）：

1. **函式與欄位不能用同一種方式註冊**。31 顆（`footprint.*`／`ticker.*`／`volume_row.*`／
   `request.*`）是函式 → `registerBuiltin` ＋ 警告 ＋ 回 `na`，訊息
   `'<name>: not supported — <why>; returning na'`，每個名字每次 run 只警告一次
   （沿用 `ctx.warnings.includes` 去重）。
   14 顆（`earnings.*`／`dividends.*`／`splits.*`）在 TV 是**欄位選擇子**（reference 沒有呼叫語法），
   但**不能**註冊成靜態字串常數：`plot(earnings.actual)` 會走 `asNum`，而
   `Number('earnings.actual')` 是 NaN → 回傳 **0**，畫出一條平線且一句話都不說 —— 就是這輪在消滅的
   靜默分歧。所以改用 `registerLazyConstant`（只有 lazy getter 拿得到帶 `warnings` 的 ctx）
   回 `na` ＋ 警告。
2. **`ticker.*` 選擇 stub 而不是實作**。它們表面是純函式，但 `ticker.heikinashi` 這類回的是
   「TV 後端看得懂的 ticker id 格式」（後綴／前綴慣例）；猜錯會得到一個**無法解析卻沒有警告**的
   symbol，比回 `na` ＋ 警告糟。等有能逐字比對的 oracle 再實作。

驗證：`datasource.test.ts` 4 顆（45 個名字全註冊；一次 run 用滿 45 個 → 無 `not found`／
`unknown constant`，每個名字恰一則警告；`earnings.actual` 是 `na` 不是 0；`footprint.poc`／
`ticker.renko` 回 `na` 且警告具名）、`tv_stdlib.test.ts` 3 顆、`npx tsc --noEmit` **0**、
pine 全套綠。

---

### 10.8 2026-10-13 追加：小刀批次 10/14（backlog 95 → 85）

先更正一個數量：§9.2.A 的「小刀」列寫 **12**，但它自己列出的名字是 **14**
（`timeframe` 4／`array.*` 3／`label.*` 2／`box.copy`／`line.copy`／`chart.*` 3）。
`docs/2026-10-13-remaining-work.md` B 表那個「未歸類 2」就是這個算術差：
95 − 48 − 27 − 6 = **14**，不是 12。本輪做掉其中 10 個 → **backlog 85**。

**做了 —— 語意逐條取自 `scratch/pine-v6-kb/dist/bundles/*.md`（不是猜的）**

| 名字 | 實作 |
|---|---|
| `timeframe.change(tf)` | 複用既有的 `isTfBoundary(ctx, tf, bar)`（time.ts 導出，session／mtf 已在用）。TV：「Returns true on the first bar of a new timeframe」 |
| `timeframe.main_period` | 新增 `ctx.timeframe.mainPeriod`（表頭 tf）；`mtf.ts` 把 parent 的值帶進 request.* 的 child ctx（TV 明講這個值**不隨** request.* 變）；輸出過 `tfString()` 正規化：`"30"` 分／`"240"` 時／`"10S"`／`"1D"`／`"2W"`／`"3M"` |
| `timeframe.isticks` | 恆 `false`（沒有任何路徑把 ctx.timeframe 標成 tick 解析度） |
| `array.copy(id)` | 淺拷貝容器（`a.slice()`）—— TV：「creates a copy of an existing array」 |
| `array.new_linefill`／`array.new_table` | 併進既有 `new_*` 迴圈（同一個 `newArray`；linefill/table 型別本來就有） |
| `label.copy`／`box.copy`／`line.copy` | `created(ctx, kind, {...src.props})` → 新的 live 物件（吃該 kind 的配額），props 不共享 |
| `label.style_text_outline` | 併進 label 的 `enumSet`（dotted-string 慣例） |

**沒做（4）**
- `timeframe.from_seconds`：TV 的規則需要「合法 timeframe 集合」（例：2–5 秒 → `"5S"` 而**不是** `"3S"`）；
  KB 只有函式頁、沒有 tf 字串規格頁 → 照猜會生出**靜默錯誤的字串**，等規格到手再做。
- `chart.bg_color`／`chart.left_visible_bar_time`／`chart.right_visible_bar_time`：§9.2 已決定不做
  （沒有圖表主題色／可見區間來源）。

驗證：`stdlib_small_batch.test.ts` 8 顆（`tfString` 對 TV 文件例子、main_period／isticks／change 三態、
`array.copy` 獨立性照 TV 範例、new_linefill／new_table 大小、三個 copy 的 live 物件數與 props 不連動、
style_text_outline 常數）、`tv_stdlib.test.ts` 印 **85**、`npx tsc --noEmit` **0**、pine 全套綠。

---

### 10.9 2026-10-13 追加：未知具名引數驗證 v2（2 條路徑 → 5 條）

計畫正文：`docs/superpowers/plans/2026-10-13-named-arg-validation.md`。v1（`bindArgs`／`bindCallArgs`）
已隨 `c9344b2` 落地；本節是 v2 —— 三軸唯讀探索（3 個 `task` 代理）找出**同型**的另外四條（表格 #1–#4），
全部實測重現。含 v1 在內，會產生這類警告的綁定點共 **6 個**：
`bindArgs`、`bindCallArgs`、`bindArgsJit`、`bindDeclArgs`、`liftNums` 的 `namedValues`、
`request.*` 的 `tryEvalSecurity`。

| # | 路徑 | 原本行為 | 級別 |
|---|---|---|---|
| 1 | `bindArgsJit`（`src/pine/interpreter.ts`） | 未知名仍被推成位置引數 → 綁到參數 0；重複名靜默忽略。**v1 自己的測試在 `PINE_JIT=1 PINE_JIT_UDF=1` 下 2 failed / 4 passed**（JIT 預設關，是 documented opt-in，所以是潛伏但走在支援路徑上） | **blocker** |
| 2 | `liftNums`（`src/pine/builtins/math.ts`） | `args.concat(Object.values(named))` → 未知名變成**下一個位置引數**：`math.round(1.5, bogus=1)` 把 `bogus` 當 `precision`（**值錯**，比丟掉更糟） | risk |
| 3 | `bindDeclArgs`（`src/pine/builtins/util.ts`） | `bound.set(a.name, …)` 進一個沒人讀的 key，零訊息（`indicator(bogus=1)`） | risk |
| 4 | `pickArg`（`src/pine/mtf.ts`） | 只認固定名單；`adjustment=`／`backadjustment=`／`currency=` 是 TV **真有**的參數卻被靜默丟掉 | risk（語意分歧） |
| 5 | UDT `T.new`（`src/pine/udt.ts`） | 未知名直接 throw | 不是缺口（TV 也錯，且不靜默）→ 只記錄 |

**修法（#1–#4）**：同一個形狀 —— 解析名字 → 跳過 → 每 run 警告一次。bind 期一律走 `bindWarnQ`，
**誰產生、誰排空**：builtin 呼叫由 `callBuiltin` 的 finally 排空；宣告期沒有 ctx，所以在
`runScriptCore` 綁完 top-level decl 之後呼叫 `flushBindWarnings(ctx)`（`evalNode` 的
`indicator`／`strategy` 分支各留一行給 nested decl）。**這裡踩過一次**：v2 第一版只把 flush
裝在 `evalNode` 那兩個分支，而 top-level 宣告由 parser 抽成 `decl`、根本不走那條路
（P8 正確性 review 抓到）→ 症狀是「自己那一輪看不到、警告留給下一個腳本」。

- `request.*` 分兩類回報：**TV 有、本引擎沒做**（`ignore_invalid_symbol`／`currency`／
  `calc_bars_count`／`ignore_invalid_timeframe` → `request.security(): 'x' declared but not implemented`）
  vs **TV v6 根本沒有的名字**（`unknown named argument`）。參數表逐字對 `docs/tv-pine-stdlib.json`
  （security 8 個、security_lower_tf 7 個）。**v2 第一版這裡兩個方向都寫錯**：把
  `adjustment`／`backadjustment`／`settlement_as_close` 當成 request.* 的參數（其實是
  `ticker.new`／`ticker.modify` 的），又漏了上面四個真參數 —— 等於製造新的假警告
  （P8 兩個 review 角度同時抓到，已修）。
- **順手修掉一個回歸**：`draw.ts` 生成的 setter 把物件槽宣告成**內部名**（drawing kind），
  所以 TV 文件上的 `id=` 被丟掉並開警告（`line.set_color(id = l, …)`）。現在槽名用 TV 的參考名
  （`table` 用 `table_id`，其餘 `id`），順序在**註冊期**建一次、不在每次呼叫重算；
  未文件的 `line_id=`／`table=` 現在如 TV 一樣報未知名。生成的 **getter** 一併改成吃
  `id=`／`table_id=`（它原本連 `named` 都不收 → `line.get_color(id = l)` 靜默回 `na`）。
- **v2 還產生第三種假警告**：`INDICATOR_DECL_ORDER` 是 **v5** 的表（`linktoseries`／`max_tables_count`／
  `calc_chart_luminosity_order`／`max_circles_count`／`backtest_fill_limits_assumption`），
  缺 v6 的 `timeframe`／`timeframe_gaps`／`calc_bars_count`／`dynamic_requests`／`behind_chart`
  → `indicator("t", timeframe = "240")` 會被報成 unknown。已整表換成 oracle 的 v6 順序
  （v5 專屬名留著會靜默綁錯槽，所以直接移除），並把 `timeframe`／`timeframe_gaps`／
  `calc_bars_count` 放進「declared but not implemented」。

**刻意分歧（維持 v1）**：TV 在**編譯期**拒絕未知具名引數；本引擎沒有 parse 期簽章表，
硬報錯會讓今天能跑的腳本直接壞掉 → 執行期警告一次後繼續。

**沒進本輪**（先記錄，未計數）：`grep` 顯示 `draw.ts` 單檔就有 23 個註冊完全不看 `named`
（多數是 `get_*`／`delete` 存取器）→ 具名呼叫會靜默 no-op。這是**先前就存在**、與本守衛無關的另一類。

---

### 10.10 2026-10-13 追加：timeframe／calendar 收尾（backlog 85 → 82）

三個名字 ＋ 一個數值修正，語意逐條取自 `scratch/pine-v6-kb/dist/bundles/`：

| 名字 | 實作 | 來源 |
|---|---|---|
| `timeframe.from_seconds(seconds)` | 秒階梯 **1/5/10/15/30**（`≤1 s → 1S`、`2–5 s → 5S`…）；31–59 s 落到分鐘級（45 s → `"1"`）；≥ 86400 s 無條件進位到整天；恰好整週／整月時取**較大單位**（604800 s → `1W` 而非 `7D`）；≥ 365 天（31,536,000 s）一律 `12M`。**兩處邊界與 KB 文字不一致，目前以實測表為準、尚未定案**：KB 寫「above 31,622,400 (366 days) return "12M"」，但 12M 本身是 12 × 2,628,003 = 31,536,036 s（與 365 天差 36 秒）；KB 的合法秒階層含 45，實測表卻說 45 s → `"1"`。 | `timeframe.md:88-118` ＋ `guide/concepts/timeframes.md:57-65`；邊界值逐條比對 LuxAlgo/PineTS 的 TV 實測表（**未自行在 TV 覆核**，列在 `remaining-work` D6） |
| `weekofyear`（變數＋`weekofyear(time, timezone)`） | ISO 8601：週一起算、屬於「星期四所在的那一年」（2024-12-30 是 2025 第 1 週、2022-01-01 是 2021 第 52 週）；`timezone` 預設 `syminfo.timezone` | `variables.md:1107-1108`、`functions/weekofyear.md:29-41` |
| `timenow` | `Date.now()`。**非決定性**：任何讀它的腳本都不能進 golden／replay 比對（TV 也把它歸在 repainting 變數） | `variables.md:1026-1028` |
| `timeframe.in_seconds` | 月長 2592000 → **2628003**（1 個月 = 30.4167 天 = 365/12） | `timeframe.md:170-172` |

驗證：`timeframe_calendar.test.ts` **12 顆**（`from_seconds` 的每個邊界（含 604799 s → `7D`、
604800 s → `1W`、366 天 → `12M`）、`in_seconds` 與 `from_seconds` 來回不縮水、
ISO 週跨年兩例、`timenow` 落在合理時窗）、`tv_stdlib.test.ts` 印 **82**
（`TV names: 887 | registered: 731 | absent: 156 | alignment backlog: 82`）、`npx tsc --noEmit` **0**。

---

### 10.11 2026-10-13 追加：本輪環境陷阱 ＋ P7 收斂 ＋ P8 review

#### 環境陷阱（第二輪新增，全部實際踩到）

1. **長跑的 vite dev server，它的 esbuild 子行程會死**。症狀：頁面出現
   `[plugin:vite:esbuild] The service is no longer running` 的 overlay，之後每個 module 請求都
   `net::ERR_ABORTED`，body 只剩 144 bytes，看起來像「套件沒裝好」。**`node_modules` 沒壞**
   （`@luxalgo/vela/dist/workspace.js`、`monaco-editor/.../editor.worker.js` 都在）——
   重啟 dev server 就好，不要 `npm i`。
2. **隱藏視窗的截圖會全黑**：`/vela` 的 DOM 與 7 張 1609×864 的 canvas 都在，`innerText` 也讀得到
   工具列，但截圖只有最早畫的那幾幀（差分視窗不跑 rAF）。要拍畫面用 headed（本輪的驗收截圖如此拍）。
3. **`taskkill` 會被本機 jev-gate 擋**（`jev-gate L0: provably dangerous command`）；
   harness 的 `proc://<id>/kill` 對**已脫離**的孤兒行程只清記錄、不殺行程
   （實測：記錄變 `Stopped`，`netstat` 顯示同一個 PID 仍在 LISTEN）。
   實務做法：**換埠**起新的（本輪 dev server 改跑 `127.0.0.1:5174`；`5173` 的孤兒留給人砍）。
4. `PINE_JIT=1 PINE_JIT_UDF=1` 只涵蓋 named-args 那 3 檔的驗證範圍（不是整套 suite）。

#### P7 收斂（驗收逐條，2026-10-13）

| 驗收 | 結果 |
|---|---|
| `npx vitest run src/pine` 全綠 | **62 檔 / 947 passed / 1 skipped**（含 P8 修正後重跑） |
| `PINE_JIT=1 PINE_JIT_UDF=1` 下的 named-args | **3 檔 / 20 passed**（修前 baseline：2 failed / 4 passed） |
| `npx tsc --noEmit` | **0**（本輪動到的檔案） |
| 新發現歸零 | 四條路徑各有測試；第 5 條（UDT `T.new`）本來就不靜默 |
| golden | **警告會進 golden**（`golden.ts` 的 `snapshot()` 一起比對 `warnings`）→ 新增／改動警告字串要 `UPDATE_GOLDEN=1` 重生成並在 review 看 diff；本輪因為沒有腳本使用新警告的名字，golden 未變 |
| `tv_stdlib.test.ts` | 印 **82** |
| `e2e.test.ts` 的永久 gate | 8 支真實使用者腳本零 `unknown named argument`，**唯一例外是白名單**：`高量1.46` 對 `box.new` 傳了 TV 沒有的 `tooltip=`（使用者腳本自身的 bug，`e2e.test.ts:37-39` 具名放行） |

附帶驗證（與本 diff 無關，但同一輪做掉）：dev server 換埠重啟後 `/vela` 真的開得起來 ——
`MODULE-LOADED`／`WS-CREATED :: cells=1`、7 張 chart canvas、無 error overlay、
2330 TSE 5m K 線 ＋ 成交量 ＋ EMA 20 正常繪製（headed 截圖）。

#### P8 三視角 review 的發現與處置

3 個 `task` 代理全部回來了（正確性 13m43s／可維護性 17m42s／安全 30m33s）。**三個角度都獨立抓到問題，
而且都落在此輪自己新寫的程式碼上** —— 同一個守衛若把合法 TV 參數報成 unknown，它就變成新的噪音來源：

| # | 發現（級別） | 處置 |
|---|---|---|
| 1 | `request.*` 參數表兩個方向都錯：漏了 TV 真有的 4 個參數、又把 `ticker.*` 的 3 個當成 request 的（Important，**本輪引入**） | 已修：`SECURITY_PARAMS` 逐字對 oracle（security 8／ltf 7 個），真參數走 `declared but not implemented`，不在表上的走 `unknown` |
| 2 | 宣告期警告的 flush 裝錯位置：top-level `indicator()`／`strategy()` 走 `runScriptCore`，`evalNode` 那兩個分支不會執行 → 自己那輪看不到、漏給下一輪（Important，**本輪引入**） | 已修：在 `runScriptCore` 綁完 decl 後排空；測試「含未知名的宣告、body 零 builtin」＋「下一支腳本 warnings 為空」把洩漏釘住 |
| 3 | `INDICATOR_DECL_ORDER` 是 v5 的表 → 合法 v6 參數（`timeframe` 等 5 個）被報 unknown（Important，**本輪引入**） | 已修：整表換成 oracle 的 v6 順序；v5 專屬名移除（TV v6 也拒絕）；3 個行為參數進 unsupported |
| 4 | 手寫 drawing builtin 完全不看 `named`（`line.delete(id = l)` 靜默 no-op）（Important，**既有**） | 本輪只修了產生的 `get_<prop>`；其餘 44 個（draw 27／core 8／strategy 9）需要逐函式簽章＝獨立切片，見 `remaining-work` D5 |
| 5 | 文件寫「警告不進 golden」與事實相反（Important，本輪引入） | 已全數改正（本節上表、PROGRESS S10、plan） |
| 6 | 新的 drawing-setter 測試可以空過（兩邊都 no-op 也會相等）（Important，本輪引入） | 已修：加 `toHaveLength(1)` 並把 `color` 期望值寫死 `#FF0000` |
| 7 | `math.*` variadic 的 `number<k>` 名（TV 的 `number0, number1, ...` 是無上限的）會被當成未知名丟掉（自查發現，本輪引入） | 已修：`/^number\d+$/` 在白名單內，只有真正不存在的名字才警告 |
| 8 | Minor：`in_seconds` 註解宣稱「永不縮水」在 12M 上限之上為假；`from_seconds` 永不產出 `45S`；duplicate 語意各 binder 不一致；`pinetsShim` 的 bind 警告沒人排空；訊息樣板 6 份重複 | 註解與文件已改精確；`pinetsShim` 已補排空；樣板重複與 duplicate 語意**刻意保留**（計畫 v2 明拒新抽象；差異已寫在 `util.ts` 註解），`45S` 等邊界爭議列入 `remaining-work` D6 |
| 9 | 安全視角（跑 30 分鐘才回）：模組全域 `bindWarnQ` 在 top-level decl 沒排空 → 腳本 A 的警告落到腳本 B（**與 #2 同一個根因**；它獨立重現，並確認現行修訂已關閉：5 個情境 own=1、下一支 run=0） | 已由 #2 的修正關閉；它要求的回歸測試＝本輪新增的「宣告警告不跨 run」案例 |
| 10 | 安全視角：`flushBindWarnings` 用 `ctx.warnings.includes` 去重 → 上萬個相異未知名時呈 O(n²)（實測 16,000 個名字 ≈ 53 秒 CPU） | 已修：改為每次 flush 建一次 `Set`，空佇列時直接返回（`callBuiltin` 與宣告路徑共用同一支） |
| 11 | 安全視角（Minor，**pre-existing**）：`tz.ts` 的 Intl 快取無上限 × 腳本可控的 `timezone=` 字串（≈0.5 KB/相異字串、跨 run 不回收）；`timenow` 讓 model cache 回放過期的時鐘值 | 記錄未修，列進 `remaining-work` D8／D9（根因都不在本輪 diff；`tz.ts` 屬另一條線） |
| 12 | 安全視角：`set_*` 移除 `line=`／`label=`／`box=`／`table=` 拼法（HEAD 可用）→ 變成警告＋no-op | 刻意的 TV 對齊（TV 文件上的名字是 `id=`／`table_id=`）；全 repo grep 沒有任何呼叫端，位置參數不受影響 |
