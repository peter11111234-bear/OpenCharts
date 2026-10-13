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
