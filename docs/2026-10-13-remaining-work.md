# 未完成事項總表（2026-10-13 第三輪收工）

**狀態基準**：`c9344b2`（已提交的 v1 named-arg 守衛 ＋ e2e gate ＋ golden 重生成）**＋ 目前 worktree**
（v2 的五條路徑、`indicator()` v6 參數表、timeframe/calendar 收尾、P8 review 修正；見 handoff §10.9–§10.11）。
Review 範圍就是這個聯集 —— 只看 HEAD 會漏掉 e2e gate 與 golden，只看 worktree 會漏掉 v1。
工作區：`scratch/vela_*.png` ×6 已刪。

來源：`docs/2026-10-13-handoff-s5-tv-oracle.md`（§9.2／§10.6／§10.7–§10.11，權威）＋
`docs/pynecore-conformance.json`（full 36／partial 14／missing 4／divergent 2）＋ 實測複核。

**進行中（2026-10-14 開啟）**：指標載入效能（Pine 直譯器）＋ TV 對齊工作流（task-workflow P0–P9）。
計畫與驗收標準（唯一正文）→ `docs/2026-10-14-pine-perf-align.md`；狀態與候選熱點 → 本檔 §G。

> 另一份 `docs/2026-10-13-fix-four-pain-points-handoff.md`（S1–S4）**已過期**：
> 它的 §3「沒 commit」與 §6「A 級四項待做」都被後續 commit 取代（`261d6e5`、`28b2c2d`）。

---

## 0. 接手必讀（若執行者是另一個 session，這幾條會省下大量時間）

1. **測試一律從 realpath 跑**：`cwd=C:/Users/bear9/OpenCharts`。
   `C:\Users\bear9\MYOPENCHART\OpenCharts` 是指向它的 junction，從那裡跑 vitest 會出現
   `Failed to load url .../src/__tests__/setup.ts` —— 假錯誤，檔案存在。
2. **`src/pine/` 有兩份複本**（`OpenCharts/src/pine/` 與 `MYOPENCHART/pine-interpreter/`）。**只改前者**。
3. **`reg(name, fn, false)` 是地雷**：第三個參數 `false` 會讓 `evalArg` 不再把純量引數包成 per-callsite
   BarSeries（`interpreter.ts` 的 `noHist`）。**需要讀歷史的引數必須用預設 `hist = true`**，否則會拿到錯的值。
4. **`strategy.ts` 卡在 import 循環**（`interpreter → builtins/strategy → mtf → interpreter`）。
   要從 `strategy.ts` 用時間工具，**只能走 `../tz`**（葉模組），不要 import `../mtf` 或 `./time`。
5. **`git` 是 Windows 原生**：用 `C:/Users/...`，不要 `/c/...`。
6. **`tsc` 現在是 0 錯誤** —— 這是本輪的成果，別讓它再紅（但也別拿 `tsc` 當驗收，跑測試才有意義）。
7. **原始碼掃描型守衛測試**（`src/pine/__tests__/sourceScan.ts`）是**逐字元的引號感知掃描器**；
   不要改成 regex 去註解 —— `/\/\*[\s\S]*?\*\//` 會被註解裡的 glob 誤開成永不結束的區塊註解。
8. **寫探測器時，斷言「沒有輸出」比斷言「有錯誤」更容易誤判** —— 要用實際產生的值／訊息**全文**比對。
   （教訓：先前用 `/not found/` 篩警告，漏掉 `unknown constant`，得出錯的「124 個靜默 na」結論。）
9. **同一檔案不可併發 edit**：若同時開多個 agent，**先切檔**；共用根因（例如 `api.ts` 這種）要指定**單一 owner**。
10. **vite dev server 長跑會壞**：esbuild 子行程死掉 → overlay
    `[plugin:vite:esbuild] The service is no longer running` ＋ 所有 module `net::ERR_ABORTED`。
    **`node_modules` 沒壞，重啟 dev server 就好**（不要 `npm i`）。另外：
    `taskkill` 會被本機 jev-gate 擋，harness 的 `proc://<id>/kill` 殺不掉已脫離的孤兒行程 → **換埠**起新的。

---

## A. 有計畫、未實作 —— 最該先做

| # | 項目 | 現況 |
|---|---|---|
| A1 | **未知具名引數的驗證** | **已完成（6 個綁定點）**。v1（`c9344b2`）：`bindArgs` ＋ `bindCallArgs` 走「指名 ＋ 忽略 ＋ 每 run 警告一次」＋ `duplicate named argument`，外加 `e2e.test.ts` 的永久 gate。v2（本輪，handoff §10.9）：補齊同型的另外四條 —— `bindArgsJit`（JIT binder，v1 的測試在 `PINE_JIT=1 PINE_JIT_UDF=1` 下 2 failed）、`liftNums`（`math.*` 未知名變成下一個位置引數 → **值錯**）、`bindDeclArgs`（宣告期靜默）、`tryEvalSecurity`（`request.*` 的真參數被靜默丟棄）。P8 review 後再修掉三處**這一輪自己製造的假警告**（`request.*` 參數表兩個方向都錯、宣告期 flush 位置、`indicator()` 的 v5→v6 參數表）＋ 產生的 drawing getter 不吃 `id=`。**剩下的同型項見 D5** |
| A2 | Vela 截圖去留 | **已結案**：6 張全刪（使用者指示）。要重建同型截圖記得用 **headed** 視窗（隱藏視窗只拍到全黑） |

---

## B. TV 標準庫還缺 82（`tv_stdlib.test.ts` 會印最新數字）

現況（本輪後）：`TV names: 887 | registered: 731 | absent: 156 | alignment backlog: 82`
（140 → 95 是 45 顆資料源 stub；95 → 85 是小刀批次 10 顆；**85 → 82** 是本輪的
`timeframe.from_seconds`／`weekofyear`／`timenow`，見 handoff §10.10）

| 批次 | 量 | 建議 | 理由 |
|---|---|---|---|
| `matrix.*` | 48 | **最後做** | 本 repo 真實腳本 0 使用（已 grep 驗證） |
| `syminfo` 缺欄位 | 27 | 等資料源 | 補成 na 會**蓋掉**現在有用的 `unknown constant` 警告 |
| `(global)` `ask` `bid` `time_tradingday` `last_bar_time` | 4 | 等資料源 | 同上（`timenow`／`weekofyear` 本輪已補） |
| `chart.bg_color`／`left_visible_bar_time`／`right_visible_bar_time` | 3 | **刻意不做** | 無圖表主題色／可見區間來源，補 na 只會蓋掉警告（§9.2.F） |

合計：48 + 27 + 4 + 3 = **82** ✓

## C. PyneCore 對照表 —— missing 4 ／ partial 14

| 狀態 | 條目 |
|---|---|
| **missing 4** | `max_bars_back`、`matrix` 型別、`request.security` 的無資料情境、`strategy.calc_on_order_fills` |
| **partial 14** | `varip`、library import、string na、`map` 型別、security dynamic、`ns-array`／`ns-timeframe`／`ns-syminfo`／`ns-chart`／`ns-log`、`strategy.commission`、strategy 宣告被忽略的參數、驗證 corpus、驗證 overrides |

## D. 引擎正確性／相容性（無明確期限）

1. **新補的 `ta.*`／`strategy.*` 沒有 TV 數值 oracle** —— oracle 只保證**名字**對齊；
   數值是照官方文件 ＋ pinets 逐字移植推的，**沒有跟 TV 逐位比對**。要提升信心只能人工在 TV 跑同一個腳本對數字。
2. **`log.*` 沒有輸出面板** —— 資料在 `RunResult.logs`，本 app 沒有 logs pane。
3. **S5 留下的五條刻意限制**（見 S5 handoff §3）：追繳平倉不截斷成整數合約、risk 規則以事件密度近似逐 bar、
   進場保證金不足時 warn 而非 error、`session.ispremarket/ispostmarket` 恆 false、跨年 D/W `bars_back` 未實作。
4. **`matrix.*` 只有 stub 級覆蓋**（同 B 首批）。
5. **【新】手寫 drawing builtin 完全不看 `named`**（多數 `get_*`／`delete`／`copy`／`set_xloc`／
   `get_price` 存取器）→ 對它們用具名呼叫（TV 文件化的 `line.delete(id = l)`、`line.get_price(id = l, x)`）
   會靜默 no-op，連警告都沒有。與本輪的「未知名」守衛無關（那些名字**是**合法的），是先前就存在的另一類。
   **實測盤點（2026-10-13 P8 review 複核）**：`draw.ts` **27** 個、`core.ts` **8** 個、`strategy.ts` **9** 個
   （先前文件寫「單檔 23」是低估）。本輪已先修掉其中 generated `get_<prop>`（現在吃 `id=`／`table_id=`）；
   其餘 44 個需要逐函式的 TV 簽章（oracle `docs/tv-pine-stdlib.json` 每個都有）＝一個獨立切片。
   `grep -nE "registerBuiltin\(.*\((c|_c|ctx), *args\)" src/pine/builtins/*.ts` 可重建清單。
6. **【新】`from_seconds` 邊界值的權威未定**：實作用「≥ 365 天（31,536,000 s）→ `12M`」，
   引用的是 LuxAlgo/PineTS 在 TV 上的實測表；但 KB 原文寫「above 31,622,400 (366 days) return "12M"」，
   而 12M 本身是 12 × 2,628,003 = 31,536,036 s（與 365 天差 36 秒）。同一個衝突還包括
   「45 秒該回 `45S`（KB 的合法秒階層含 45）還是 `1`（PineTS 實測）」。
   定案需要人工在 TV 上跑 `timeframe.from_seconds` 逐值對照，在那之前以實測表為準。
7. **【新】`duplicate named argument` 的語意各 binder 不一致**：builtins 走 `bindArgs` 是 last-wins
   （訊息 `collides with … overwritten`），UDF／JIT／宣告都是 first-wins。TV 兩者都是編譯錯誤，
   所以不是致命問題，但同一構造在兩條路徑結果不同（`util.ts` 的註解已明寫）。
8. **【新】`tz.ts` 的 Intl 快取沒有上限，而時間函式的 `timezone=` 是腳本可控字串**（安全 review 實測）：
   `plot(weekofyear(time, timezone = str.tostring(bar_index)))` 每根 bar 一個新字串 → `partCache`／
   `partsMemo` 各多一筆且不回收（約 0.5 KB/相異字串；1M bar 約 500 MB，跨 run 累積）。
   根因 **pre-existing**（`hour(time, timezone=…)` 走同一條路），本輪只是多開一個入口（`weekofyear`）。
   修法屬 `tz.ts` 擁有者：上限化 `partCache`／外層 `partsMemo`（內層已有 4096 上限）。
9. **【新】`timenow` 讓 model cache 的不變式失效**（安全 review）：`engine.ts` 的 `cacheKey` 不含時鐘成分，
   讀過 `timenow` 的腳本若命中 IndexedDB 快取，會看到**上次執行**的時鐘值；同一根 bar 內兩次讀也會不同。
   golden／replay 只要用到 `timenow` 就會 flake（本輪的測試只斷言值落在 before/after 之間）。
   TV 也有這個變數，所以不是「不該有」；要解就得把 `timenow` 標成不可快取／不可決定性依賴。

10. **【新】非 overlay 副窗的 `plotshape(location.abovebar/belowbar)` 會把蠟燭價折進副窗自己的價格軸**（2026-10-14 S11 review 發現，**pre-existing**，未修）：
    `engine.ts` 的 plotshape→label 投影把 `location.abovebar/belowbar`（含**預設** location）映成 label 的 `yloc`，
    而渲染器對這兩種 label 折的是 **bar 的 high/low**（`vela-src/src/renderers/shared/DrawingSceneRenderer.ts:222-225`），
    `barAt` 綁的是圖表蠟燭、與 label 所在 pane 無關（`ChromeRenderer.ts:87-96`）→ `overlay=false` 的指標（副窗）
    會被撐成 24000／48000 級距，指標數值被壓成一條線。與 S11 修的塌軸**同型**，只是搬到副窗。
    最小重現：`indicator(overlay=false)` ＋ `plotshape(cond)`（`plot.ts:180` 預設 `location.belowbar`）。
    現有 golden 腳本（MACD701／MACD雙周期V7／MACD701_v72）都用 `location.absolute`／`top`／`bottom`，未觸發。
    修法方向（未做）：非 overlay 時不要把 bar 相對位置映成 abovebar/belowbar，改用渲染器已支援且不參與價格 fold 的
    `'top'/'bottom'`；改動需重生成相關 golden。受管 JEV `taskwf-review` 判為本輪 scope 外的另案
    （`fix_now_in_this_delivery` 0.0 / `record_as_separate_pre_existing_bug` 1.0）。
    同輪 review 另兩條 minor（pre-existing，同樣未做）：`plotshape/plotchar` 從未寫 `opts.textcolor`
    （`engine.ts` 有讀、`plot.ts` 沒寫 → 腳本指定的文字色被自動對比色蓋掉）；model 上的 `MarkerPoint.price`
    不在 Vela 契約內。

11. **【新】point 型 setter 遇 na 點是靜默 no-op**（2026-10-14 S11 QA 複驗發現，**pre-existing**，未修）：
    `line.set_first_point`/`set_second_point`、`label.set_point`、`box.set_top_left_point`/`set_bottom_right_point`
    都走 `pointXY`（`draw.ts`），點的座標不全就回 `undefined` → setter 直接不寫、保留**舊**端點；TV 語意是把該端點
    設成 na（物件因此不繪製）。實測：`line.set_first_point(l, chart.point.from_index(2, na))` → props 完全不變、舊線段照畫。
    建議：point 缺座標時把對應的兩個座標 prop 寫 `undefined`（讓模型丟棄），而不是 no-op。與 S11 的 na 座標家族同源，
    但屬**無害方向**（不會把 0 折進價格軸），故不在 S11 修。

12. **【新】`engine.ts` 折線頂點 1:1 映射缺守衛**（同上複驗，防禦性、Pine 路徑不可達）：`points.map(pt => ({ xloc, x: pt.x, price: pt.y }))`
    遇 `pt.y === undefined` 會產出 `price: undefined`，而 Vela `PolylinePoint.price` 是必填 `number`。`polyline.new` 走 `pointXY` 過濾，
    只有手造 RunResult 會踩到。建議加守衛或比照其他物件丟棄該點。

13. **【新】plotshape/plotchar → Vela label 的投影缺專門測試**（同上複驗 O1）：`engine.ts` 新增的
    `shapeToLabelStyle` / `markerLocationToYLoc` ＋ markers 迴圈 push labels（本 session 稍早為了讓 Pine 圖形在 Vela 顯示）
    目前只有 e2e 的計數與 golden 間接覆蓋，`engine.test.ts:101-107` 只斷言 marker series。若日後 Vela 真的渲染 `kind:'markers'`
    會出現雙繪；`shapeToLabelStyle` 與 `markerShape` 是同一件事的兩份對照表（未知 shape 的 default 一個 `circle`、一個 `triangleup`）。

14. **【新】安全／資料完整性殘留**（2026-10-14 S11 安全 review，**皆 pre-existing、皆未修**，非本輪 na 座標家族）：
    * **`resample()` 產生「部分桶」且無標記**（`candles.ts`）：5m/15m 桶內少 1 根 1m 列時，仍合成一根**看起來完整**的 K 棒（高/低/量可能低報），畫面上無缺口提示。建議累計 `droppedRows`／缺口計數並回報 warning。
    * **`table.cell_set_width/height` 遇 `na` 仍壓 0**（`draw.ts`）：像素尺寸、不折價格軸，故刻意未納入本輪（與 `width`/`size` 同類）。
    * **繪製配額宣告值未夾限**（`draw.ts`）：`indicator(max_lines_count = 1000000)` 直接採用，而 KB／TV 明載合法範圍 1–500（`max_polylines_count` 1–100）。配額預設 50 有效，但配上「每根 K 棒一條線」可產生數萬個 live DrawObj，worker 每 tick 全量 clone → 可拖死 UI。
    * **`polyline.new(points)` 點數無上限**（`draw.ts`）。
    * **`MemoryDrawSink.update` 是裸 `Object.assign`**（`context.ts`）：目前所有寫入 key 都是模組常數、Pine 可控的參數名只存在於 `Map`（`bindArgs`），因此不可達；若未來新增「把使用者可控 key 傳進 update」的呼叫端，`__proto__` own key 會改寫該物件原型。建議硬化（`Object.create(null)`／擋 `__proto__`）。

## E. 技術債

| 項目 | 現況 |
|---|---|
| **TypeScript 防回歸** | `tsc` 已歸零，但 **repo 沒有 CI、沒有 husky/pre-commit** → 沒有人擋它再紅。計畫：`docs/superpowers/plans/2026-10-13-typescript-debt-remediation.md` Phase 3 |
| **pinets 移植層 5346 行是孤兒** | 只被測試 import（`pinetsAll` 沒有生產 import）。要決定：提升為生產／刪除／保留當測試夾具。**刪之前先確認 §8.1 的語意筆記夠用** |
| **常數摺疊未做** | 正確形狀已定（handoff §10.3）：要用 evaluator 對 literal-only 初始式求值一次，**不能**另寫一套常數算術 |
| **broker port 未做** | 設計已定（~40 行 `BrokerPort` ＋ paper/sim 實作），但 `src/services/shioaji/api.ts` 目前**零 import** → 現在做會有零個使用者。等實盤路徑接上 |

## F. 明確決定「不做」（列出來避免重複討論）

- **`request.security` 的 tf 不做編譯期檢查** —— `mtf.ts` 的 DYNAMIC 路徑是**刻意支援**的功能，擋掉等於刪掉一個能跑的功能（TV 會拒絕）。
- **`chart.bg_color`／`chart.left/right_visible_bar_time` 不註冊** —— 無圖表顏色／可見區間來源，補 na 只會蓋掉有用的警告。
- **`syminfo` 那 27 個欄位不補 na** —— 同上，維持警告比回 na 誠實。
- **未知具名引數不改成編譯期報錯** —— TV 在編譯期拒絕；本引擎沒有 parse 期簽章表，硬報錯會讓今天能跑的腳本壞掉。維持「執行期警告一次後繼續」（handoff §10.9）。

## G. 進行中：指標載入效能（Pine 直譯器）＋ TV 對齊（2026-10-14 開啟）

流程：task-workflow P0–P9（P7 QA ＋ P8 三視角 review）＋ `code-review` skill 四軸 diff review；
JEV 一律走受管管道（gate `taskwf-verify` / `taskwf-blocker` / `taskwf-accept` / `taskwf-review`）。
**計畫與驗收標準（唯一正文）**：`docs/2026-10-14-pine-perf-align.md`。

| 階段 | 狀態 | 證據 |
|---|---|---|
| P0 需求 ＋ 驗收 A1–A8（code/jev）＋ 非目標 | done | plan doc |
| P1 拆解 N1–N6（known/unknown） | done | plan doc |
| P2 三軸探索 | running | baseline harness（4 腳本 × 500/1000 真實 5m）、圖譜熱點盤點（完成，見下）、模式盤點（待） |
| P3–P6 | pending | 等 P2 回報 → 卡點分級 → REAL PLAN → 執行輪迴 |
| P7 QA ／ P8 review | pending | 判據在 plan doc |

**固定點／rollback**：`b9fcd81`（`git stash create` 快照 ＝ 優化前工作樹，含 S11 未提交改動）；
`git checkout b9fcd81 -- src/pine`。

**卡點（外部，唯一需要使用者）**：TV 端 CDP。Chrome 155 預設 profile 不給開 CDP，需獨立 profile
（`--remote-debugging-port=9222 --user-data-dir="C:\Users\bear9\tv-cdp"`）→ REA 擷取 ＋ TV per-bar 實測 → 回填 A6。

### G.1 呼叫鏈（讀碼確認）

```
engine.prepare/execute → runProgram → interpreter.runScript（全域序列化 mutex, interpreter.ts:2674）
  → buildSess（compile-to-closures :2863） → [for bar] evalOneBar（每 bar 走完整 body :2907-2921）
  → evalExpr → invokeBuiltin → evalArg（每 arg 包 {kind:'series'} ＋ callHist 寫入 :1458）
  → ta.*（winAgg :327 ／ 部分仍每 bar O(L)） ／ mtf.tryEvalSecurity :1833 → evalAt :1718（(node,caller,tfBar) 快取）
  → BarSeries（ring ＋ head, series.ts:81/:155） ＋ assembleRunResult :2947 ＋ buildModel（engine.ts:556）
  → modelCache（IndexedDB, modelCache.ts:44/57/66, MAX_ENTRIES=24）
```

### G.2 候選熱點（依「可能貢獻 × 證據強度」）

| # | 熱點 | 證據 |
|---|---|---|
| H1 🔴 | 每 bar 全量重算；~~`incRun` 增量**不適用**含 `request.security`／strategy 的腳本（＝正是最重那幾支）~~ ⇒ **已推翻（QA ROUND 1，2026-10-16）**：增量現在**適用每一支腳本**，`request.security` 與 strategy 皆含——`interpreter.ts:3249` 為 "Eligibility: EVERY script"，`engine.test.ts` 的 S1 註解亦寫 "strategy decls included"；本列原引的 `:3055-3060`／`:3078-3082` 已不存在 | 文件證據 K4.55 935 bars ≈ 12.35 ms/bar 仍成立（每 bar 重算的那部分） |
| H2 🔴 | `mtf.evalAt` 快取未命中：UDF 每次呼叫配新 Scope → gate-fail 表達式幾乎每 chart bar 重算 | `mtf.ts:1718-1758`、`:1894-1902`；文件證據 TRIS390 evals 50,497／hits 30,147 |
| H3 🔴 | `evalArg` 每 bar 包 `{kind:'series'}` ＋ callHist 寫入 | `interpreter.ts:1363-1367`、`:1108-1112`；文件證據 TRIS390 callHistWrites 227.9/bar |
| H4 🟡 | 每 bar 物件／陣列配置（GC 壓力 ∝ bars × nodes × calls） | `evalOneBar:2925-2926`、`ta.ts:87-91`、`valueEq` |
| H6 🟡 | `BarSeries` trim 壓實／`incRewind` 截斷的 `slice`（O(history)） | `series.ts:163-166`、`:121-122` |
| H7 🟡 | `ta.*` 部分仍每 bar O(L) 直掃（corr／linreg／dev／spearman…）；**`vwma` 已移出本列（QA ROUND 1，2026-10-16）：現走滑動窗 `ssumWin`（`ta.ts:811-821`）** | `ta.ts:843`、`:861`、`:1218`、`:1902`（原列 `:610` 為 `vwma`，已改） |
| H8 🟡 | `modelCache` key 含 bar 窗尾 → 新 bar 即 miss；`modelCachePut` 序列化整個模型；`prune` 全表掃 | `engine.ts:379-380`、`:419`、`modelCache.ts:66-80` |
| H9 🟡 | `assembleRunResult` 每 run 重掃每個 plot sink buf | `interpreter.ts:3015-3026` |
| H10 🟡 | 95 KB 腳本的一次性 parse／assertScript（全樹 walk）／collectInputs | `engine.ts:269/274/276`、`checks.ts:302-357` |
| H5 ⚪ 誘餌 | `contracts.ts:59` `Series.set` 的 `unshift` **不是主路徑熱點**（載入走 `BarSeries` ring＋head） | `series.ts:81/:155`；`new Series(` 生產呼叫點僅 `pinetsComposite.ts:229`／shim／測試 |

**兩套索引的實際狀態**：graphify 可用（`OpenCharts/graphify-out/graph.json`，3,697 nodes／9,671 edges／180 communities，
god nodes `Value` 125、`parse()` 84、`runScript()` 69）；codegraph 索引在 `C:\Users\bear9\MYOPENCHART\.codegraph`
（`codegraph.db` 120 MB），**必須從 `MYOPENCHART` 目錄呼叫**，從 `OpenCharts` 呼叫會回報「沒有索引」。

---

## 建議順序

1. **D5（`draw.ts` 的 named-blind handler 盤點）** —— 與本輪同一個「靜默 no-op」家族，`grep` 就有清單，最便宜。
2. **C 的 `strategy.calc_on_order_fills` 與 `varip`** —— 對照表裡「會影響數字」的那一類。
3. **E 的 TypeScript 防回歸**（10 分鐘的事，但決定 275 → 0 會不會再爛掉）。
4. **D1（新 `ta.*` 的 TV 數值 oracle）** —— 要人工在 TV 對數字，成本最高但價值也最高。
5. 其餘等資料源或真實需求（B 的 `matrix.*`／`syminfo`、E 的 broker port、D6）。
