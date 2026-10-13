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

#### D. 工作區未追蹤

- `scratch/vela_*.png` ×6（Vela 截圖，先前 session 留下；要保留當證據就 commit，不要就刪）

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
2. **§9.2.A 剩下的 95**（本輪補掉 45 顆，見 §10.7）：`matrix.*` 48（本 repo 真實腳本 0 使用，
   最後做）、`syminfo` 27 欄位（等基本面資料源）、`(global)` 6、小刀 12（`timeframe` 4／
   `array.*` 3／`label.*` 2／`box.copy`／`line.copy`／`chart.*` 3）。
3. **常數摺疊**（正確形狀見 §10.3）與**broker port**（設計見 §10.3），等對應前提成熟。
4. `scratch/vela_*.png` ×6 仍未追蹤（§9.2.D）。

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
