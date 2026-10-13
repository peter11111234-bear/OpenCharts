# Throwaway generator: builds pynecore-conformance.json + .html from one data table.
# Delete after use. Data verified against the real code on 2026-10-13.
import json, os, html

OUT_DIR = r"C:/Users/bear9/MYOPENCHART/OpenCharts/docs"

SRC = "src/pine/"

ITEMS = [
 # ── A. 執行模型與語意 ────────────────────────────────────────────────
 dict(id="series-history", area="A. 執行模型與語意", item="Series 歷史 x[n]",
   pynecore="full — SeriesImpl 環形緩衝，預設 max_bars_back=500",
   status="full", evidence=SRC+"series.ts · BarSeries.atOffset/get", 
   note="環形緩衝 + 絕對 bar 索引；越界與負索引回 na。",
   gap=""),
 dict(id="persistent-var", area="A. 執行模型與語意", item="Persistent / var 跨 bar 狀態",
   pynecore="full — Persistent[T] → 狀態向量 slot",
   status="full", evidence=SRC+"interpreter.ts:727", note="decl slot 只在首次初始化，之後每 bar 重新綁定。", gap=""),
 dict(id="varip", area="A. 執行模型與語意", item="varip（intrabar persistent）",
   pynecore="full — IBPersistent，重執行時不回滾",
   status="partial", evidence=SRC+"interpreter.ts:728,2015,2033",
   note="warn 一次後當作 var 處理；real-time bar 的 varip 語意未實作。",
   gap="live tick 重執行時 varip 不會累積 —— 對照 PyneCore IBPersistent。"),
 dict(id="function-isolation", area="A. 執行模型與語意", item="Function isolation（每個呼叫點獨立狀態）",
   pynecore="full — callee state 佔用 caller 狀態向量的子 slot",
   status="full", evidence=SRC+"interpreter.ts:164-168,380-384",
   note="siteTrie + siteKey 為每個 callsite 配置穩定鍵，CowSeries 提供 copy-on-write 歷史。", gap=""),
 dict(id="na-propagation", area="A. 執行模型與語意", item="na 傳播（算術 / 邏輯）",
   pynecore="full — NA[T] 覆寫所有運算子",
   status="full", evidence=SRC+"interpreter.ts:964-1040",
   note="任一邊 na → 算術回 na；比較回 false（TV v6）。", gap=""),
 dict(id="float-tolerance", area="A. 執行模型與語意", item="浮點比較容差（Pine tolerant equality）",
   pynecore="full — FloatTolerance pass（user-code-only）",
   status="full", evidence=SRC+"interpreter.ts CMP_EPSILON（evalBinary / valueEq）",
   note="CMP_EPSILON = 1e-10 絕對容差走 < > <= >= == !=；int 走精確路徑；ta.crossover 等 builtin 保持位元精確（規格明載）。",
   gap=""),
 dict(id="div-zero", area="A. 執行模型與語意", item="/ 除以零",
   pynecore="full — 除法 pass 給 Pine 語意", status="full",
   evidence=SRC+"interpreter.ts:986-988", note="r.v === 0 → NA。", gap=""),
 dict(id="int-division", area="A. 執行模型與語意", item="int / int 除法",
   pynecore="full — int 以整數 float 傳遞", status="full",
   evidence=SRC+"interpreter.ts:986-988", note="永遠回 float（5/2 = 2.5）。", gap=""),
 dict(id="modulo-floor", area="A. 執行模型與語意", item="% 取模方向",
   pynecore="full", status="full", evidence=SRC+"interpreter.ts:989-992",
   note="floor 基底：a - b*floor(a/b)，符號跟隨除數（-7%3 = 2）。", gap=""),
 dict(id="rollback", area="A. 執行模型與語意", item="同一 bar 重執行的回滾（commit / rollback）",
   pynecore="full — Persistent 回滾至 bar 開盤狀態；varip 不回滾",
   status="full", evidence=SRC+"mtf.ts:2008-2150 · interpreter.ts incRun/checkpoint",
   note="增量執行有 checkpoint/restore；MTF spec 也有自己的 rollback 面。", gap=""),
 dict(id="max-bars-back", area="A. 執行模型與語意", item="max_bars_back / 歷史緩衝上限",
   pynecore="full — 每個 series 可設定", status="missing",
   evidence=SRC+"builtins/strategy.ts STRATEGY_UNSUPPORTED_PARAMS · builtins/draw.ts INDICATOR_UNSUPPORTED_PARAMS",
   note="decl 接受該參數但不讀取；歷史緩衝無上限設定。宣告時會 warnOnce 一次（不再靜默）。",
   gap="長腳本 + 大 lookback 時記憶體與語意皆無護欄。"),
 dict(id="udt", area="A. 執行模型與語意", item="UDT / method / enum",
   pynecore="full — 經 PyneComp 編譯", status="full",
   evidence=SRC+"udt.ts · interpreter.ts:1155 udtMethodAt",
   note="type / method / .new / 欄位存取 / 動態分派皆有；method 查找有 callsite 快取。", gap=""),
 dict(id="library-import", area="A. 執行模型與語意", item="Pine library import / export",
   pynecore="full（經 PyneComp）", status="partial",
   evidence=SRC+"contracts.ts ImportDecl/ExportDecl · parser.ts",
   note="AST 有節點；跨檔案解析與 export 捕捉未見完整實作與測試。",
   gap="使用 `import user/lib/1 as x` 的真實腳本會失敗。"),

 # ── B. 運算子與容器細節 ──────────────────────────────────────────────
 dict(id="string-na", area="B. 運算子與容器", item="字串 + na（\"s\" + na）",
   pynecore="full — na 傳播", status="partial",
   evidence=SRC+"interpreter.ts:1000-1003 pineStr",
   note="字串串接走 pineStr()；na 的轉字串結果未在此路徑硬性驗證。", gap="需以 TV 行為（'NaN' 串接）加一則回歸測試。"),
 dict(id="array-oob", area="B. 運算子與容器", item="容器索引越界",
   pynecore="full — 讀回 na（Pine 語意）", status="divergent",
   evidence=SRC+"interpreter.ts:1643-1647（array 索引越界 throw）",
   note="`arr[i]` 越界直接 throw PineRuntimeError，不是回 na。",
   gap="Pine 的 array.get 越界回 na；只有 array.set 才是錯誤。目前行為會讓腳本中斷。"),
 dict(id="map-type", area="B. 運算子與容器", item="map 型別與存取",
   pynecore="full — map 11 函式", status="partial",
   evidence=SRC+"contracts.ts Value kind 'map' · interpreter.ts:1115,1632,1651",
   note="Value kind、`.` 與 `[]` 存取、clone、解構都有；但 registry 無任何 map.* 函式。",
   gap="map.new / map.put / map.get / map.contains / map.keys / map.values 等全缺。"),
 dict(id="matrix-type", area="B. 運算子與容器", item="matrix 型別與函式",
   pynecore="full — matrix 51 函式", status="missing",
   evidence=SRC+"contracts.ts Value kind 'matrix' · interpreter.ts:778,1683",
   note="Value kind 與 flat 解構存在；無 matrix.* builtin（Pine 有 51 個）。",
   gap="matrix.new / get / set / rows / cols / mult … 全缺。"),
 dict(id="tuple-ternary", area="B. 運算子與容器", item="tuple（多回傳）與三元運算",
   pynecore="full（Pine 限制 tuple 不走 ternary）", status="full",
   evidence=SRC+"contracts.ts TupleAssign · interpreter.ts:777-790",
   note="tuple 解構支援 var/非 var、array/matrix flat；未見把 tuple 塞進 ternary 的路徑。", gap=""),

 # ── C. MTF / request.* ──────────────────────────────────────────────
 dict(id="sec-htf", area="C. MTF / request.*", item="request.security 高時框",
   pynecore="full — 多行程 + 共享記憶體", status="full",
   evidence=SRC+"mtf.ts:524 prefetchSecurity · interpreter tryEvalSecurity",
   note="(sym, tf) 每個唯一組合抓一次，多 callsite 共用；有 warm-up 補歷史。", gap=""),
 dict(id="sec-lookahead", area="C. MTF / request.*", item="lookahead_on / lookahead_off 政策",
   pynecore="divergent（刻意）—— lookahead_on 不洩漏未來，只給已建構的期間",
   status="full", evidence=SRC+"mtf.ts:14-22,1924-1930",
   note="lookahead_on 取含該 chart bar 末端的 tf bar（developing → 洩漏），與 TradingView 一致。",
   gap="這是**有意的路線差異**：你做圖表對齊 TV；PyneCore 做回測拒絕洩漏。不是缺陷，但兩者結果必然不同。"),
 dict(id="sec-gaps", area="C. MTF / request.*", item="barmerge.gaps_on / gaps_off",
   pynecore="full", status="full", evidence=SRC+"mtf.ts:20-22,145,1936-1938",
   note="gaps_off 前向填滿；gaps_on 只在每個 tf bar 內第一根 chart bar 發射，其餘 na。", gap=""),
 dict(id="sec-chartdomain", area="C. MTF / request.*", item="security(...)[n] 的歷史域",
   pynecore="full — close[1] idiom 對齊", status="full",
   evidence=SRC+"mtf.ts:958-994 SecSeries（chart-domain，僅 SecSeries 系列）",
   note="`[n]` 讀前一根 CHART bar 的映射值（Pine 語意），非前一根 tf bar。", gap=""),
 dict(id="sec-ltf", area="C. MTF / request.*", item="request.security_lower_tf",
   pynecore="full — 回傳 intrabar 值陣列", status="full",
   evidence=SRC+"builtins/request.ts:28 · mtf.ts ltf 路徑(lookahead/gaps 不適用)",
   note="LTF 用獨立路徑；gap 內仍會評估每個 tf bar 以維持 stateful 正性。", gap=""),
 dict(id="sec-nested", area="C. MTF / request.*", item="巢狀 security 與 UDF 內呼叫",
   pynecore="full", status="full",
   evidence=SRC+"__tests__/mtf_invariance.test.ts N1-N6",
   note="巢狀 + UDF callsite 各有 callerKey，避免 chartHist 互串。", gap=""),
 dict(id="sec-dynamic", area="C. MTF / request.*", item="動態 timeframe/symbol（非 bar0 常數）",
   pynecore="full — 條件式呼叫合法", status="partial",
   evidence=SRC+"mtf.ts:1801（未 prefetch → warn + na）",
   note="bar0 可解析者會進 prefetch 路徑；執行期才解析出的 tf 只回 na 並 warn 一次。", gap="依 PyneCore/TV，dynamic_requests 條件式應可用；目前是降級而非評估。"),
 dict(id="sec-nodata", area="C. MTF / request.*", item="request.currency_rate / dividends / splits / earnings / financial / economic / quandl / seed / footprint",
   pynecore="currency_rate full；其餘 no data feed（na 或 raise）",
   status="missing", evidence=SRC+"builtins/request.ts:38-42 STUBS",
   note="全部註冊為 stub：回 na 並累積一則 not supported 警告。",
   gap="若腳本依賴 currency 換算（PyneCore 支援 TOML 自動偵測），結果會整個偏掉。"),
 dict(id="sec-perf-model", area="C. MTF / request.*", item="MTF 執行成本模型",
   pynecore="每個 security 一個 OS 行程", status="full",
   evidence=SRC+"mtf.ts 單一行程內的 tf frame + (node,j) 快取",
   note="同行程 tf frame，agnostic cache + warm-up；有 span-aware fetch 上限。", gap=""),

 # ── D. Namespace 覆蓋 ───────────────────────────────────────────────
 dict(id="ns-ta", area="D. Namespace 覆蓋", item="ta.*",
   pynecore="full — 67 函式（含 alma / iii / accdist / wvad / rising / falling）",
   status="full", evidence=SRC+"builtins/ta.ts（實測註冊 71 個）",
   note="實測 71 個（含 kcW/kcw 分歧命名、nadarayaWatsonEnvelope 為擴充）。2026-10-13 補上 alma / accdist / iii / wvad / barssince / falling / rising / max / min / percentrank / pivot_point_levels / range / rci 共 13 個，tv-pine-stdlib oracle 的 ta.* 已無缺口。",
   gap=""),
 dict(id="ns-math", area="D. Namespace 覆蓋", item="math.*",
   pynecore="full — 24 函式 + e/pi/phi/rphi",
   status="full", evidence=SRC+"builtins/math.ts（實測 30 個）", note="另含 nz/tonumber/random/todegrees/toradians/round_to_mintick/avg。", gap=""),
 dict(id="ns-str", area="D. Namespace 覆蓋", item="str.* / string.*",
   pynecore="full — 21 函式（Pyne 命名為 string）",
   status="full", evidence=SRC+"builtins/str.ts（實測 19 個）",
   note="Pine 官方 19 個全齊（含 format_time/match/pos）。", gap=""),
 dict(id="ns-array", area="D. Namespace 覆蓋", item="array.*",
   pynecore="full — 57 函式", status="partial",
   evidence=SRC+"builtins/array.ts（實測 54 個）",
   note="new/new_*/push/pop/set/insert/remove/fill/sort/binary_search/percentile/covariance… 齊。",
   gap="需與 Pine v6 逐項核對（PyneCore 57 vs 實測 54）。"),
 dict(id="ns-session", area="D. Namespace 覆蓋", item="session.*",
   pynecore="full — 8 函式（含 extended hours）", status="full",
   evidence=SRC+"builtins/session.ts（7 函式 + 4 常數）",
   note="ismarket / isfirstbar(_regular) / islastbar(_regular) / ispremarket / ispostmarket；venue 表 TWSE/TPEx 09:00–13:30、TAIFEX 08:45–13:45，未知 venue = 24 小時。",
   gap="ispremarket / ispostmarket 一律 false（本 app 無 extended-hours 資料源，不猜）。"),
 dict(id="ns-timeframe", area="D. Namespace 覆蓋", item="timeframe.*",
   pynecore="full — 19 函式", status="partial",
   evidence=SRC+"builtins/time.ts:294 in_seconds · interpreter.ts:935 timeframeFields（9 欄位）",
   note="只有 in_seconds 一個函式；period/multiplier/isintraday/… 以 UDT 欄位提供。",
   gap="timeframe.from_seconds / change / isdwm 之外的多數轉換函式缺。"),
 dict(id="ns-syminfo", area="D. Namespace 覆蓋", item="syminfo.*",
   pynecore="full — 20+ 欄位（TOML metadata）", status="partial",
   evidence=SRC+"context.ts:64-83 buildSyminfo（14 欄位）",
   note="ticker/tickerid/prefix/currency/timezone/mintick/pricescale/pointvalue/session/type…；TW 預設 Asia/Taipei + TWD。",
   gap="無 exchange、volumetype 之外的 industry/sector/country、無 session 起訖時間欄位。"),
 dict(id="ns-barstate", area="D. Namespace 覆蓋", item="barstate.*",
   pynecore="full — 5 旗標", status="full",
   evidence=SRC+"interpreter.ts:920-933 barstateUdt（7 欄位）",
   note="isnew/islast/isfirst/ishistory/isrealtime/isconfirmed/islastconfirmedhistory；isrealtime 恆 false。", gap=""),
 dict(id="ns-chart", area="D. Namespace 覆蓋", item="chart.*",
   pynecore="full — chart 型別/顏色旗標", status="partial",
   evidence=SRC+"builtins/draw.ts（chart.point.* 6 個 + fg_color）· builtins/plot.ts（is_* 7 個）",
   note="chart.point.* 家族、fg_color、is_standard/is_renko/… 7 個型別旗標（本 app 只畫標準 K 線，故 is_standard=true、其餘 false）。",
   gap="chart.bg_color / left_visible_bar_time / right_visible_bar_time 刻意不註冊 —— 本引擎沒有圖表顏色與可見區間來源，補成 na 只會蓋掉有用的 unknown constant 警告。"),
 dict(id="ns-currency", area="D. Namespace 覆蓋", item="currency.* 常數",
   pynecore="full — 21 種", status="full",
   evidence=SRC+"builtins/strategy.ts CURRENCY_CODES（實測 56 個）",
   note="TV v6 全部 56 個代碼；值是裸碼（`currency.TWD === 'TWD'`，與 TV 一致，非點名）。`currency.NONE` = 用圖表商品的幣別（見 accountCurrencyOf）。",
   gap=""),
 dict(id="ns-log", area="D. Namespace 覆蓋", item="log.*",
   pynecore="full — info/warning/error", status="partial",
   evidence=SRC+"builtins/log.ts（2 個 overload × info/warning/error）",
   note="R22 已實作，placeholder 走 str.format 同一套 pineFormat()；輸出收在 ctx.logs → RunResult.logs（{level, bar, msg}）。",
   gap="本 app 沒有 logs pane，資料只到 RunResult.logs —— UI 未接。"),
 dict(id="ns-alert", area="D. Namespace 覆蓋", item="alert() 與 alert.* 常數",
   pynecore="full — 1 函式 + 3 頻率常數", status="full",
   evidence=SRC+"registry: alert + alert.freq_*（3） · alertcondition",
   note="alert 註冊為 builtin；條件式警報經 alertcondition 進 RunResult。", gap=""),
 dict(id="ns-runtime", area="D. Namespace 覆蓋", item="runtime.error()",
   pynecore="full", status="full", evidence=SRC+"builtins/core.ts:68",
   note="丟 PineRuntimeError 終止腳本。", gap=""),
 dict(id="ns-input", area="D. Namespace 覆蓋", item="input.* 型別",
   pynecore="full（以函式參數表達）", status="full",
   evidence=SRC+"builtins/input.ts:167-193（12 型別）",
   note="int/float/bool/string/color/timeframe/session/symbol/text_area/price/time/source；record-and-override 支援 UI 覆寫。", gap=""),
 dict(id="ns-plot", area="D. Namespace 覆蓋", item="plot 家族與警報輸出",
   pynecore="full（輸出 CSV / --viz NDJSON，無 renderer）", status="full",
   evidence=SRC+"registry: plot/plotshape/plotchar/plotarrow/plotbar/plotcandle/hline/fill/bgcolor/barcolor/alertcondition",
   note="另有 plot.* 10 種 style 常數、hline.*、location.*、size.*、shape.* 常數。", gap=""),

 # ── E. 繪圖物件 ────────────────────────────────────────────────────
 dict(id="draw-api", area="E. 繪圖物件", item="line / label / box 完整 API",
   pynecore="no renderer（API 與狀態完整，--viz 匯出）",
   status="full", evidence=SRC+"builtins/draw.ts（line 26 / label 31 / box 43 個）",
   note="new/set_*/get_*/delete + .all 惰性常數；含 chart.point 設定器。", gap=""),
 dict(id="draw-table", area="E. 繪圖物件", item="table / polyline / linefill",
   pynecore="no renderer（狀態完整）", status="full",
   evidence=SRC+"registry: table 29 / polyline 3 / linefill 9",
   note="table cell/merge/frame 齊；linefill 端點為 live 物件（編輯會傳播）。", gap=""),
 dict(id="draw-quota", area="E. 繪圖物件", item="每物件配額（max_lines_count …）",
   pynecore="full", status="full",
   evidence=SRC+"interpreter.ts:874 declDrawQuotas(INDICATOR_DECL_ORDER) · draw.ts:127-131",
   note="indicator/strategy decl 的配額參數會生效（曾因只處理 strategy decl 而全部壓到 50）。", gap=""),

 # ── F. strategy 引擎 ───────────────────────────────────────────────
 dict(id="strat-core", area="F. strategy 引擎", item="進出場 / 限價停損 / 反手",
   pynecore="full（TV 精確 10 步 margin call）", status="full",
   evidence=SRC+"builtins/strategy.ts:261-360 fillCandidate",
   note="市價/限價/停損、process_orders_on_close 與 immediate 的成交 bar 規則、反手一次成交。", gap=""),
 dict(id="strat-pyramiding", area="F. strategy 引擎", item="pyramiding / position 管理",
   pynecore="full", status="full", evidence=SRC+"strategy.ts:363,523-537",
   note="同向加倉受 pyramiding 限制；avgEntry 以名目金額加權。", gap=""),
 dict(id="strat-oco", area="F. strategy 引擎", item="OCA 群組 / TP-SL / trailing",
   pynecore="full", status="full", evidence=SRC+"strategy.ts:270-304,527-540",
   note="oca cancel/reduce、profit/loss ticks、trail_price/points/offset 皆有。", gap=""),
 dict(id="strat-commission", area="F. strategy 引擎", item="commission / equity / 損益",
   pynecore="full（含 margin call、slippage）", status="partial",
   evidence=SRC+"strategy.ts:378-392,850-865 · strategyEquity.ts:59 max_drawdown",
   note="percent / cash_per_contract / cash_per_order 手續費、FIFO 平倉、equity/max_drawdown/gross/net。",
   gap="risk_free_rate 未實作（宣告時 warnOnce）。"),
 dict(id="strat-decl-ignored", area="F. strategy 引擎", item="strategy() 宣告參數的實際生效範圍",
   pynecore="full", status="partial",
   evidence=SRC+"strategy.ts STRATEGY_DECL_ORDER vs strategyDecl()/STRATEGY_UNSUPPORTED_PARAMS",
   note="生效：initial_capital、default_qty_type/value、commission_type/value、process_orders_on_close、currency、pyramiding、slippage、margin_long/short。",
   gap="仍接受但忽略（宣告時 warnOnce 一次）：calc_on_order_fills / calc_on_every_tick / max_bars_back / backtest_fill_limits_assumption / close_entries_rule / risk_free_rate / use_bar_magnifier。"),
 dict(id="strat-risk", area="F. strategy 引擎", item="strategy.risk.*",
   pynecore="full", status="full",
   evidence=SRC+"builtins/strategy.ts（6 個註冊 + simulate 的 riskWalk）",
   note="allow_entry_in / max_drawdown / max_intraday_loss / max_cons_loss_days / max_intraday_filled_orders / max_position_size；規則記在 ledger 裡，replay 到該 bar 才生效。",
   gap=""),
 dict(id="strat-coof", area="F. strategy 引擎", item="calc_on_order_fills / calc_on_every_history_tick 的重執行語意",
   pynecore="full — 每 bar 多次執行並回滾；有 magnifier",
   status="missing", evidence=SRC+"strategy.ts:915（僅宣告表）",
   note="參數被接受但不觸發重執行；bar 內回滾只在增量 tick 路徑存在。",
   gap="策略在 TV 的 bar 內多次執行結果不會重現。"),

 # ── G. 驗證與工程 ──────────────────────────────────────────────────
 dict(id="verify-corpus", area="G. 驗證與工程", item="對 TV 的語意一致性驗證",
   pynecore="1,000 個公開腳本；1,353 個可比輸出全 match；1.317 億值中 99.771% bit-identical；353,577 筆交易時點一致；逐 script 公開（wild.pynesys.io）",
   status="partial", evidence=SRC+"__tests__/golden.test.ts（10 golden）+ scripts/golden/*.json",
   note="10 個 golden + 8 個 e2e 使用者腳本 + 多個 probe；oracle 為 pine-tools 的 TradingView 自動化。",
   gap="缺：大規模 corpus、bit-identical 比率量化、逐 script 可重現報告、交易時點一致性統計。"),
 dict(id="verify-overrides", area="G. 驗證與工程", item="golden 基線是否反映現況",
   pynecore="每個腳本以 SHA-256 釘住來源並公開結果",
   status="partial", evidence=SRC+"docs/superpowers/plans/2026-10-11-pine-residual-perf-v1.md（golden 曾兩次被覆寫）",
   note="golden 檔案曾被 UPDATE_GOLDEN=1 覆寫並帶入當時行為。",
   gap="基線血統不可考 —— 需要「基線變更須附語意理由」的規則。"),
 dict(id="verify-oracle", area="G. 驗證與工程", item="ground truth 來源",
   pynecore="TradingView 官方輸出（透過 corpus 對比）",
   status="full", evidence="MYOPENCHART/pine-tools（Puppeteer 直接問 TV 編譯）",
   note="一等 oracle 是 TradingView 本身，不依賴任何第三方的重實作。",
   gap=""),
 dict(id="license-flow", area="G. 驗證與工程", item="第三方程式碼授權",
   pynecore="Apache-2.0（商用友善）",
   status="divergent", evidence=SRC+"pinetsStateless/StatefulA/StatefulB/Composite.ts（68 個 ta 由 AGPL PineTS 移植）",
   note="B3 以 verbatim-adapted 方式移植 PineTS 的 ta 實作。",
   gap="PineTS 為 AGPL-3.0：一旦散佈或對外提供服務，AGPL §13 要求釋出完整源碼；需購買 LuxAlgo 商業授權或改寫為獨立實作。"),
]

STATUS_LABEL = {"full": "符合", "partial": "部分", "missing": "缺", "divergent": "分歧"}
STATUS_COLOR = {"full": "var(--success)", "partial": "var(--warning)", "missing": "var(--error)", "divergent": "var(--accent)"}

# 值得借鑒但還沒做 — PyneCore 的做法，本專案沒有，且值得學。
# tier: S = 立即可做且直接解痛點 / A = 中期、需設計 / B = 文化與流程 / X = 不建議照抄
BORROWABLES = [
 dict(id="b-tv-comparator", tier="S", cost="≤1 天",
   item="TV 輸出比對 fixture（帶容差與精度參數）",
   pynecore="tests/conftest.py 的 log_comparator / dict_comparator：數值用 math.isclose 容差 + 精度參數、NA 特例、時間戳正規化",
   ours="golden.ts compareSnapshots 走 1e-9 abs/rel 容差 + 精確鍵 + na 特例；pine-tools 只取編譯錯誤與截圖，不取繪圖數值",
   why="bit-exact 會把 IEEE-754 的 ULP 噪音當成失敗，逼你用「重新產生基線」掩蓋真差異；PyneCore 明文承認次 tick 差異並用容差吸收",
   gap=""),
 dict(id="b-explicit-unsupported", tier="S", cost="≤半天",
   item="未支援的功能一律顯性化",
   pynecore="Compatibility 頁逐 feature 標 full / no-lookahead / no data feed / no renderer；不支援的呼叫會 raise 或回 na 並留痕",
   ours="strategy() / indicator() 的未實作參數改為 warnOnce（10 + 3 個），並由 golden 的 warnings 欄位守住；仍接受但無行為的參數清單見 STRATEGY_UNSUPPORTED_PARAMS",
   why="靜默忽略＝回測數字與 TV 不同卻看起來成功；這是最難查的一類錯",
   gap=""),
 dict(id="b-float-tolerance", tier="S", cost="1–2 天",
   item="浮點容差規則（寫成規則，不是散落的比較）",
   pynecore="獨立的 FloatTolerance pass；文件明列最暴露的函式（crossover/crossunder 用嚴格 > 與 <=）與建議（先四捨五入或用 math.isclose）",
   ours="interpreter.ts CMP_EPSILON = 1e-10 套在 < > <= >= == !=；int 精確路徑；ta.crossover 家族維持位元精確",
   why="你所有回歸都建立在位元相等；crossover 的邊界分歧會在真實腳本上偶發",
   gap=""),
 dict(id="b-time-grid", tier="S", cost="3–5 天",
   item="time()/time_close() 在 D/W/M 網格上的走法（含 bars_back）",
   pynecore="以 190 萬個量測值逆向出 TV 規則（跨年短 bar、mirror 規則、observed vs weekday grid、chart span off），並把演算法寫成 _tv_week_walk / _tv_day_walk / _dwm_walk_probe_ms / _chart_span_off_ms",
   ours="tfFloor/tfNext 已 calendar-aware；time(tf, session, tz, bars_back) 與 time_close 已實作、session.* 已實作；D/W 的跨年 bars_back 走法仍缺（回傳算術值並 warn 一次）",
   why="台指與美股的 session 過濾、跨年網格是實務需求，而 TV 的規則非直覺（從第一週往回一定落到前一年的短 bar）",
   gap=""),
 dict(id="b-slot-layout", tier="A", cost="需設計（高風險）",
   item="編譯期狀態配置（狀態向量樹）",
   pynecore="transform 期就把每個 state 指到 caller 狀態向量的整數 index；讀寫是 list 索引，整棵 state 樹在編譯時成形",
   ours="runtime siteKey + Map trie + CowSeries（interpreter.ts:164-168,380-384）；JIT 為 opt-in，實測 top-level 無收益、UDF 約 +20%",
   why="若要借，最省的路是在既有 jitCompileUdf 的 codegen 階段順便配 slot index，而不是再養一套機制",
   gap=""),
 dict(id="b-semantics-registry", tier="A", cost="1–2 天",
   item="語意規則的單一定義處 + 順序契約 + 文件守衛測試",
   pynecore="pipeline.py 每一步都註明「為何站在這個位置」；test_128_pipeline_docs.py 讓文件表格與程式碼不符就失敗；PYNE_AST_SEQUENTIAL 驗證融合與分離等價",
   ours="語意散在 evalBinary、bindArgs、mtf、strategy 各處，靠註解與測試記憶",
   why="你剛拿到 56 條對照表；把它變成 registry + 守衛才能防回歸，否則下次又漂移",
   gap=""),
 dict(id="b-viz-journal", tier="A", cost="2–3 天",
   item="差量輸出流（journal）與「顏色變了才送」",
   pynecore="NDJSON hdr/meta/bar/drawings/end + 可選 ev（create/update/delete）；顏色只在變更時輸出；id＝title 或 ordinal（bgcolor#0），繪圖物件用遞增 vid",
   ours="IndicatorModel 每個 bar 全量重建；engine 只有 drain/coalescing",
   why="增量 tick 時全量重生是最大浪費；差量事件流讓 UI 只 patch 變動的物件",
   gap=""),
 dict(id="b-corpus", tier="A", cost="3–5 天",
   item="corpus 級驗證與量化報告",
   pynecore="1,000 個公開腳本、1,353 個可比輸出、99.771% 位元相等、最大相對差 1.2e-10、353,577 筆交易時點一致、每個腳本以 SHA-256 釘住並逐筆公開",
   ours="10 個 golden + 8 個 e2e + 若干 probe",
   why="沒有 corpus 就不知道「還差多少」，也無法安全重構",
   gap=""),
 dict(id="b-broker-lab", tier="A", cost="需設計",
   item="可重播的 broker 模擬實驗室 + 獨立參考模型",
   pynecore="testing/broker_lab：reference.py（26 KB，TV broker 行為的參考實作）＋ runner/scheduler/subprocess，可重播",
   ours="strategy.ts 的 Sim 是唯一實作，沒有第二個模型可對照",
   why="要補 margin call／slippage 時，「差異來自哪裡」需要一個獨立參考",
   gap=""),
 dict(id="b-quirks-doc", tier="B", cost="≤2 小時",
   item="「不複製的 TV 缺陷」清單",
   pynecore="Compatibility 頁有 Known TradingView quirks not reproduced，逐條說明現象、量測範圍、要改的話去哪個函式",
   ours="修過的怪 bug 只留在 PROGRESS.md 的流水帳裡",
   why="把「明知不同」寫下來，比留一句註解可靠",
   gap=""),
 dict(id="b-resolved-limits", tier="B", cost="≤2 小時",
   item="可查的限制清單（含修掉的版本與 issue）",
   pynecore="Resolved limitations 逐條列「哪個版本修掉哪個限制 + issue 連結」",
   ours="PROGRESS.md 按時間堆疊，無法查「某限制還在不在」",
   why="限制清單是對外承諾與對內排程的共同依據",
   gap=""),
 dict(id="b-docstring-discipline", tier="B", cost="≤1 小時",
   item="測試 docstring 第一行＝runner 輸出的一句話",
   pynecore="第一行是唯一被 runner 印出的摘要，其後空行再寫緣由；conftest 明確只取第一行",
   ours="測試命名清楚，但摘要長度不一致",
   why="測試輸出可讀性；次要",
   gap=""),
 dict(id="b-cache-invalidation", tier="B", cost="≤半天",
   item="規則版本納入快取鍵",
   pynecore="transformers/ 任一檔變動即改 pipeline hash，所有已快取的 bytecode 失效",
   ours="modelCache 已用內容衍生的 model id；但 AST/語意規則版本未進 golden 或快取鍵",
   why="改語意後拿到舊快取是最惡的一種假綠",
   gap=""),
 dict(id="x-python-runtime", tier="X",
   item="照抄 Python runtime／AST 改寫本身",
   pynecore="以 @pyne 標記 + import hook 改寫 Python AST",
   ours="你已有 from-scratch TS 直譯器；R11 實測 top-level JIT 反而變慢",
   why="語言與宿主不同；價值在語意規則而非實作形式", gap=""),
 dict(id="x-lookahead-policy", tier="X",
   item="照抄「lookahead_on 不洩漏」政策",
   pynecore="刻意與 TV 分歧以保護回測",
   ours="你做圖表，必須與 TV 一致",
   why="這是目標差異，不是優劣", gap=""),
 dict(id="x-pynecomp", tier="X",
   item="改用 PyneComp 當 Pine 前端",
   pynecore="閉源、需 API key、只輸出 Pyne",
   ours="你的前端就是資產",
   why="換過去等於放棄自主性且綁定供應商", gap=""),
 dict(id="x-process-per-security", tier="X",
   item="每個 request.security 一個 OS 行程",
   pynecore="多行程 + 共享記憶體",
   ours="單行程 tf frame + agnostic cache",
   why="你要跑在瀏覽器／前端，行程模型不可行", gap=""),
 dict(id="x-no-renderer", tier="X",
   item="無渲染器的輸出模型",
   pynecore="只輸出 CSV / NDJSON",
   ours="輸出 Vela IndicatorModel 供渲染",
   why="產品目標不同", gap=""),
]

payload = {
  "generated": "2026-10-13",
  "target": "OpenCharts/src/pine (from-scratch Pine Script v6 interpreter, TypeScript)",
  "reference": {
    "project": "PyneSys/pynecore",
    "url": "https://github.com/PyneSys/pynecore",
    "license": "Apache-2.0",
    "note": "PyneCore 不解析 .pine；Pine → Pyne 需閉源 PyneComp。",
    "compat_doc": "https://pynecore.org/docs/overview/compatibility/",
    "core_concepts": "https://pynecore.org/docs/overview/core-concepts/"
  },
  "ours_measured": {"builtins": 460, "constants": 267, "ta_functions": 71,
                    "strategy_builtins": 47, "line": 26, "label": 31, "box": 43,
                    "table": 29, "polyline": 3, "linefill": 9},
  "counts": {},
  "items": ITEMS,
  "borrowables": BORROWABLES,
}

for it in ITEMS:
    payload["counts"][it["status"]] = payload["counts"].get(it["status"], 0) + 1

os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "pynecore-conformance.json"), "w", encoding="utf-8") as fp:
    json.dump(payload, fp, ensure_ascii=False, indent=2)

data = json.dumps(payload, ensure_ascii=False)

PAGE = """<!doctype html>
<html lang="zh-Hant">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PyneCore 對照表</title>
<style>
  :root {
    color-scheme: light dark;
    --fg: #1b1f24; --muted: #656d76; --border: #d0d7de; --surface: #f6f8fa;
    --accent: #8250df; --success: #1a7f37; --warning: #9a6700; --error: #cf222e;
    --mono: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #e6edf3; --muted: #9198a1; --border: #30363d; --surface: #161b22;
      --accent: #a371f7; --success: #3fb950; --warning: #d29922; --error: #f85149;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: var(--surface); color: var(--fg);
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Noto Sans TC", sans-serif; }
  main { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  #borrow-h { margin-top: 36px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
  .pill { border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px;
          font-size: 13px; background: var(--fg); background: color-mix(in srgb, var(--fg) 4%, transparent); }
  .pill b { font-variant-numeric: tabular-nums; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 16px; }
  button { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 6px;
           border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; }
  button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  input[type=search] { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 6px;
                       border: 1px solid var(--border); background: transparent; color: var(--fg); min-width: 220px; }
  section { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px;
            background: var(--fg); background: color-mix(in srgb, var(--fg) 2%, transparent); overflow: hidden; }
  summary { cursor: pointer; padding: 12px 16px; font-weight: 600; font-size: 15px; }
  summary span { color: var(--muted); font-weight: 400; font-size: 13px; margin-left: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 16px; border-top: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase;
       letter-spacing: .04em; }
  td.item { font-weight: 600; min-width: 190px; }
  td.status { white-space: nowrap; }
  .tag { display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
         border-radius: 999px; padding: 2px 9px; border: 1px solid currentColor; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  code { font-family: var(--mono); font-size: 12px; color: var(--muted); word-break: break-all; }
  .note { color: var(--fg); }
  .gap { color: var(--warning); }
  .gap:empty, .note:empty { display: none; }
  tr.hidden, section.hidden { display: none; }
  footer { color: var(--muted); font-size: 12px; margin-top: 20px; line-height: 1.8; }
  a { color: var(--accent); }
</style>
<body>
<main>
  <h1>PyneCore 語意對照表 — OpenCharts 自製 Pine 直譯器</h1>
  <div class="sub" id="sub"></div>
  <div class="stats" id="stats"></div>
  <div class="controls">
    <span id="filters"></span>
    <input type="search" id="q" placeholder="搜尋項目 / 證據 / 落差…">
  </div>
  <div id="body"></div>
  <h1 id="borrow-h">值得借鑒但還沒做</h1>
  <div class="sub">PyneCore 的做法、本專案沒有、且值得學。S＝立即可做且直接解痛點、A＝中期需設計、B＝文化與流程、X＝不建議照抄。</div>
  <div class="stats" id="bstats"></div>
  <div id="borrow"></div>
  <footer id="foot"></footer>
</main>
<script id="data" type="application/json">__DATA__</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const LABEL = {full:'符合', partial:'部分', missing:'缺', divergent:'分歧'};
const COLOR = {full:'var(--success)', partial:'var(--warning)', missing:'var(--error)', divergent:'var(--accent)'};
const areas = [...new Set(D.items.map(i => i.area))];
let statusFilter = null, query = '';

document.getElementById('sub').textContent =
  '基準：' + D.reference.project + '（' + D.reference.license + '）· 標的：' + D.target +
  ' · 實測 builtins ' + D.ours_measured.builtins + ' / constants ' + D.ours_measured.constants +
  ' / ta ' + D.ours_measured.ta_functions + ' · 產生於 ' + D.generated;

const stats = document.getElementById('stats');
for (const s of ['full','partial','missing','divergent']) {
  const n = D.counts[s] || 0;
  stats.insertAdjacentHTML('beforeend',
    `<span class="pill" style="color:${COLOR[s]}">${LABEL[s]} <b>${n}</b></span>`);
}
stats.insertAdjacentHTML('beforeend', `<span class="pill">總計 <b>${D.items.length}</b></span>`);

const filters = document.getElementById('filters');
[['全部', null]].concat(Object.keys(LABEL).map(k => [LABEL[k], k])).forEach(([txt, key]) => {
  const b = document.createElement('button');
  b.textContent = txt;
  b.setAttribute('aria-pressed', String(key === null));
  b.onclick = () => {
    statusFilter = key;
    [...filters.children].forEach(c => c.setAttribute('aria-pressed', String(c === b)));
    render();
  };
  filters.appendChild(b);
});
document.getElementById('q').oninput = e => { query = e.target.value.toLowerCase(); render(); };

const body = document.getElementById('body');
for (const area of areas) {
  const sec = document.createElement('section');
  sec.dataset.area = area;
  sec.innerHTML = `<details open><summary>${area}<span></span></summary>
    <table><thead><tr><th>項目</th><th>狀態</th><th>PyneCore</th><th>本專案現況與落差</th></tr></thead>
    <tbody></tbody></table></details>`;
  body.appendChild(sec);
  for (const it of D.items.filter(i => i.area === area)) {
    const tr = document.createElement('tr');
    tr.dataset.status = it.status;
    tr.dataset.hay = (it.item + ' ' + it.pynecore + ' ' + it.evidence + ' ' + it.note + ' ' + it.gap + ' ' + it.status).toLowerCase();
    tr.innerHTML =
      `<td class="item">${it.item}</td>` +
      `<td class="status"><span class="tag" style="color:${COLOR[it.status]}"><i class="dot"></i>${LABEL[it.status]}</span></td>` +
      `<td>${it.pynecore}<br><code>${it.evidence}</code></td>` +
      `<td><span class="note">${it.note}</span>${it.gap ? '<br><span class="gap">→ ' + it.gap + '</span>' : ''}</td>`;
    sec.querySelector('tbody').appendChild(tr);
  }
}

function render() {
  for (const sec of body.children) {
    let shown = 0;
    for (const tr of sec.querySelectorAll('tbody tr')) {
      const ok = (!statusFilter || tr.dataset.status === statusFilter) &&
                 (!query || tr.dataset.hay.includes(query));
      tr.classList.toggle('hidden', !ok);
      if (ok) shown++;
    }
    sec.classList.toggle('hidden', shown === 0);
    sec.querySelector('summary span').textContent =
      (statusFilter || query ? shown + ' / ' : '') + sec.querySelectorAll('tbody tr').length + ' 項';
  }
}
render();

const TIER = {S:'立即可做且直接解痛點', A:'中期需設計', B:'文化與流程', X:'不建議照抄'};
const TCOLOR = {S:'var(--error)', A:'var(--warning)', B:'var(--success)', X:'var(--muted)'};
const bstats = document.getElementById('bstats');
for (const t of ['S','A','B','X']) {
  const n = D.borrowables.filter(b => b.tier === t).length;
  if (!n) continue;
  bstats.insertAdjacentHTML('beforeend',
    `<span class="pill" style="color:${TCOLOR[t]}">${t} · ${TIER[t]} <b>${n}</b></span>`);
}
const borrow = document.getElementById('borrow');
for (const t of ['S','A','B','X']) {
  const rows = D.borrowables.filter(b => b.tier === t);
  if (!rows.length) continue;
  const sec = document.createElement('section');
  sec.innerHTML = `<details open><summary>${t} · ${TIER[t]}<span>${rows.length} 項</span></summary>
    <table><thead><tr><th>項目</th><th>PyneCore 的做法</th><th>本專案現況</th><th>為何值得 / 成本</th></tr></thead><tbody></tbody></details>`;
  borrow.appendChild(sec);
  for (const b of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="item">${b.item}</td><td>${b.pynecore}</td><td>${b.ours}</td>`
      + `<td><span class="note">${b.why}</span>${b.cost ? '<br><span class="gap">成本 ' + b.cost + '</span>' : ''}</td>`;
    sec.querySelector('tbody').appendChild(tr);
  }
}

document.getElementById('foot').innerHTML =
  '證據皆取自 ' + D.target + ' 的實際程式碼（實測註冊表 + 逐行閱讀），不採信 PROGRESS.md 的敘述。<br>' +
  'PyneCore 側資料：<a href="' + D.reference.compat_doc + '">Compatibility</a> · ' +
  '<a href="' + D.reference.core_concepts + '">Core Concepts</a> · ' +
  '<a href="' + D.reference.url + '">repo</a>。' + D.reference.note;
</script>
"""

with open(os.path.join(OUT_DIR, "pynecore-conformance.html"), "w", encoding="utf-8") as fp:
    fp.write(PAGE.replace("__DATA__", data.replace("</", "<\\/")))

print("counts:", payload["counts"])
print("wrote:", os.path.join(OUT_DIR, "pynecore-conformance.json"))
print("wrote:", os.path.join(OUT_DIR, "pynecore-conformance.html"))
