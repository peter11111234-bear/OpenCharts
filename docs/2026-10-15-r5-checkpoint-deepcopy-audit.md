# checkpoint 深拷貝全盤審計（2026-10-15，唯讀審計代理 `T2DeepCopyAudit`）

> ## ⚠️ 2026-10-15 事後更正：本報告的核心 Θ(B²) 假說**已被實測推翻**
> 由 `T2ScaleProbe` 的實測（`scratch/perf/t2-strategy-scale.mjs`、`t2-trade-calib.json`、`t2-trade-scan.json`）：
> 1. **TRIS390 在此 fixture 完全不下單** ⇒ `simAt()` 在 `strategy.ts:884-887` 早退 ⇒ `simCache` **從未建立** ⇒ 本報告的 B² 項在該受測體上**精確為 0**。
> 2. 用「真的會交易」的校準受測體（orders 4/8/20）實測:`elems` = 1,794/3,174/**7,314**（B² 應為 25×,實測 **4.08×**）;`Σ|execs|` = 92/184/**460 → 精確線性 5.0×**。
> 3. **機制**:`simAt` 在 `orders.length` 改變時**整個丟掉 cache**(`strategy.ts:887`)⇒ 快照裡只可能有「**當前下單 epoch**」的 Sim ⇒ `Σ|execs| ≈ B`,**不可能**達到 `rB²/2`(那需要所有 bar 的 Sim 併存)。
> 4. **真正的 Θ(B²) 在別處**:會交易腳本的 **build/全趟 `simulate` replay** — 1,487.7 / 4,574.2 / **30,024.2 ms**(5× bars → **20.2×**,≈平方);**不是 cloneDeep**。
> 5. 另一個**實測**成長項:`restoreCkpt` 對 `seriesSet` 每個 series 做 rewind,該集合**每 tick 固定 +150(B=100)/+201(B=500)**(被丟棄的 forming-bar eval 留下 series)→ 長 session 的記憶體成長隱憂。
>
> **結論**:§4 的選項 A/C 不再是優先項(B² 不存在);下面 §1–§3 的行號清單與成本模型仍可作為「有哪些結構在快照面上」的參考,但**§3 的預測表與 §4 的推薦請以本更正為準**。

> 觸發原因:S1 讓含 `strategy` 的腳本可走增量後,揭露「strategy 每 checkpoint 深拷貝 `ctx.state` plains → 成本疑隨歷史成長」。
> 本審計的結論:**主導項是 Θ(bars²),不是線性**,且**指標腳本也中招**(Θ(bars) 的 array-leaf clone)。

## 0. TL;DR

1. checkpoint 路徑上的深拷貝**不只 `strategy|*` 三個 key**:依成長階分 **5 類、≥12 個結構**,其中 **8 個是 Θ(bars)**。
2. **主導項 = Θ(bars²)**:`ctx.state['strategy|simCache'].byBar` 的 value 是含陣列(`execs`/`openLegs`/`closed`)的 `Sim` 物件;
   `cloneDeep` 會把「第 b 根的 Sim 裡『前 b 根的所有成交』」整包複製 → 每次 snapshot ≈ Σᵦ|execs_b| ≈ **r·B²/2**(r = 每根成交數)。
   同型的 bar-keyed map(`stv-m`/`vwap`/`piv.memo`,value 為物件/陣列)被判為 structural map → 退化成 Θ(bars) 的 array-leaf clone。
3. 100 根看不到:B=100 時 B²/2 只 ~5k–15k 元素複製(~1 ms);B=5000、r=1 時約 **3.75×10⁷ 元素/趟**,每次 advance 有 2 趟
   (restore + checkpoint)→ **秒級**。
4. 最小修法:**選項 A**(bar-keyed memo map 標記化 → 走既有 `nummaps` 剪枝路徑)**＋ 選項 C**(`ddCache` 改 O(1) 純量快照)。
   終局解是抄 mtf 既有的 write-log undo(`spec.cw`)。

## 1. checkpoint() 逐項清單（`src/pine/interpreter.ts:3459-3533`）

| # | 路徑 | 行 | 型別 | 每 checkpoint 元素數 / 成長階 | 誰在寫 |
|---|---|---|---|---|---|
| 1 | `seriesSnaps` | `:3464-3465` | `IncSnap`(O(1)) | O(#series) | `series.ts:173` |
| 2 | `containers` | `:3466-3479` | `Map<BarSeries, Map<bar, cloned Value>>` | **O(bars)** | `series.ts:174-177` |
| 3 | `scopeVars` | `:3480-3481` | `cloneDeep(v)` | Σ 變數大小;逐根 append 的陣列 → **O(bars)** | `bindDeclared`/賦值 |
| 4 | `snapCtxState(ctx.state)` | `:3483-3484` | 見 §2 | 見 §2 | 見 §2 |
| 5 | `drawSnap` + `drawProps` | `:3485-3487` | `cloneDeep(o.props)` | 逐根畫 label → **O(bars)** | 繪圖 builtins |
| 6 | `fills` | `:3517` | `deep2(f)` | ≤ **O(bars)** | `strategy.simulate` |
| 7 | `bgcolors`/`barcolors` | `:3519-3520` | `Map<bar, Map<callsite,color>>` | O(#bars×callsite) → **O(bars)** | `bgcolor`/`barcolor` |
| 8 | `liveArrays` | `:3521-3522` | `.slice()` | ≤ **O(bars)** | `line.new` 等逐根 |
| 9 | `cowSnaps` | `:3523-3528` | `incCowGet()`(O(1)) | O(#cow) | CowSeries 物化 |
| 10 | `mtfSnap` | `:3533` → `mtf.ts:2382-2389` / `snapSpec:2264-2308` | 每 spec 一份(scopeVars 克隆 + ctxState 走訪 + cw) | **§2 的整份成本 × #specs** | `request.security` |
| 11 | `alertsLen`/`warningsLen`/`sinkLen`/`sbufLens` | `:3515-3516`、`:3488-3490` | 純量/長度 | O(1) | — |

## 2. snapCtxState() 逐葉（`interpreter.ts:3330-3378`）— 主場

分類規則:`Map` → 若「全 number key 且 value 非物件」判為 bar memo → `nummaps`(**只剪枝、不 clone**);否則 = structural → `maps`(存 key 清單)+ 遞迴走訪。
陣列 → `arrays`(**整體 cloneDeep**)。VS(`typeof v.get==='function' && 'last' in v`)→ `vs`(O(1) 快照)。plain object → `plains`(**整體 cloneDeep**)。

| ctx.state 路徑 | clone 分類 | 元素數 / 成長階 | 寫入者 |
|---|---|---|---|
| `strategy\|orders` (Array) | `arrays` | O(bars) | `strategy.ts:942`、`:1099` |
| `strategy\|simCache` = `{count, byBar:Map<bar,Sim>}` | **`plains`→cloneDeep 整包** | **Σᵦ\|execs_b\| ≈ Θ(bars²)** | `strategy.ts:887-889` |
| `strategy\|ddCache` = `{count, equity:number[], peak,dd,trough,runup}` | `plains` | equity O(bars) | `strategyEquity.ts:66-84` |
| `strategy\|excCache` = `{byKey:Map<string,{runup,drawdown}>}` | `plains` | key 含 `endBar` → **O(bars)** | `strategy.ts:1261-1276` |
| `strategy\|cfg` | `plains` | O(1) | `strategyDecl` |
| `stv-m`(supertrend) `Map<bar,[line,dir]>` | **`maps` + N 個 `arrays` 葉** | **O(bars)/site** | `ta.ts:1159` |
| `stv-m`(fisher `[f,prevF]` / vwap `[vw,sd]`) | 同上 | **O(bars)/site** | `ta.ts:1500`、`:1680/1689` |
| `piv` = `{memo:Map<bar,number[]>, prev, cur}` | `plains`→memo 變 `maps`+`arrays` | **O(bars)/site** | `ta.ts:2158-2161` |
| `dvs`/`stv`/`ema` VS(`{last,memo:Map<bar,scalar>}`) | `vs`(快照 O(1)) | restore 掃全部 memo → **O(bars)/VS** | `ta.ts:215,233,547,567,614` |
| `wvs` = `Map<L, VS>` | `maps` + 遞迴 | O(#L) + Σ memo → **O(#L·bars)** | `ta.ts:454-470` |
| `wring` = `Map<vsId, Map<bar,number>>` | `maps` → 內層純量 → `nummaps` | 內層剪枝 **O(bars)/ring** | `ta.ts:402` |
| `vs`/`stv-x`/`stv-b` | `vs`/`plains` | O(1) | `ta.ts:189-201`、`:1129-1131` |

### 2.1 已確認**不是**深拷貝（避免誤修）

| 結構 | 行 | 性質 | 成長階 |
|---|---|---|---|
| `argSites` | `interpreter.ts:3511` | `new Map([...].map(...))`,entry 新但 `inner`/`wrap` 為**參照** | O(#callsites),**O(1) w.r.t. bars** |
| `spec.cw` | `mtf.ts:2384-2387`/`:2312-2318` | **write-log**:restore 反向 delete 後清空 | O(單根寫入數) |
| `spec.invCache` / `agnosticCache` / `nodeCache` | `mtf.ts:2241/2328`、`:2240/2242` | 存**參照**,靠 `spec.cw` 反向刪 | O(單根) |

⇒ mtf 子系統**早就用 write-log undo 解決了同一問題**(`mtf.ts:238-246 cwMap`),而 `ctx.state` 還在深拷貝。

## 3. 成本模型（B = bars）

```
每 tick 成本 C(B) = C_restore(B) + [新收根數] × C_snapshot(B)
C_snapshot(B) ≈ 3·r·B²/2·(ExecRec/Closed 欄位數≈6) + 6B + B(ddCache.equity)
              + Σ_keys(excCache) + K(stv-m/vwap/piv ≈ S·B) + O(E) + O(B: draw/bg/fills)
C_restore(B)  ≈ 同量級 plains/arrays 再複製一次 + V(VS memo) + Nm(nummap) + O(#maps keys)
```

**主導項**:`snapshot 元素數 ≈ Σ_b (13 + 6|execs_b| + 8|closed_b| + 12|openLegs_b|) ≈ 3rB²/2`
- B=100, r=1 → ~1.5×10⁴ 元素 ≈ **1 ms**(<3% of 28–150 ms tick)→「100 根看不出來」成立
- B=5000, r=1 → ~**3.75×10⁷ 元素/趟**;兩趟 → ~7.5×10⁷ 次配置 ≈ **數秒**
- 成長倍率 (B/100)²:**500→25×、2000→400×、5000→2500×**

### 3.1 可證偽預測（相對「該腳本 100 根的每 tick 中位 ms」）[INFERENCE]

| B | copy 項倍率(B²) | 成交密集腳本 | 稀疏成交/純指標 |
|---|---|---|---|
| 500 | 25× | 3–8× | 2–5× |
| 2000 | 400× | 10–40× | 5–15× |
| 5000 | 2500× | 30–120× | 10–30× |

**證偽方法**:在 `snapCtxState`/`restoreCtxState` 加元素計數器(或包一層 `cloneDeep` 計數),量 `elems(B)`。
- `elems(5000)/elems(100) ≈ 2500` → 確認 B² 機制(`simCache.byBar`)
- `≈ 50` → 是線性集合(memo/bgcolors/drawProps),主導項要改寫成那幾個

## 4. 最小修法（提案，未實作）

### 選項 A（推薦，最小可 patch）：bar-keyed memo map 標記化 → 走既有 `nummaps` 剪枝
- **改哪幾行**
  - `interpreter.ts:3333-3350`(`snapCtxState` 的 Map 分類)先看標記:
    ```ts
    const BAR_MEMO = Symbol.for('pine.barMemo');
    if ((v as any)[BAR_MEMO] === true && v.size > 0) { out.nummaps.push(v as Map<number, unknown>); continue; }
    ```
    (`nummaps` 的 restore 剪枝 `:3388` 已存在,無需改。)
  - 建立端加標記(6 處):`strategy.ts:887`、`ta.ts:1132`(supertrend)、`:1482`(fisher)、`:1555`(sar)、`:1644`(vwap)、`:2143`(`piv.memo`)
- **語意前提**:key 為 bar、**單調遞增、entry 寫一次後不再就地修改**。逐點核對:
  - `simCache.byBar`:key=`uptoBar`,`simulate()` 每次回**全新 Sim**(`:296`)→ 安全
  - `stv-m`:`ta.ts:1143-1159` 由 `lastBar.n+1` 往上、每 bb 恰寫一次 → 安全
  - ⚠️ **反例**:`wring`(`ta.ts:402` `ring.set(i,…)` 可能非單調)、`maps`(kparts 的 L/vsId 層)→ **不可**加標記
- **驗證**:① `scratch/perf/s1-inc-probe.mjs` cold vs live 逐值(含 na) 0 mismatch ② 新 probe 斷言
  `simCache.byBar` 的 restore 元素數**不再隨 B 成長**(Θ(1))、`elems(5000)/elems(100) ≤ 60`
  ③ 針對性:對同一 tape「cold 跑完第 B 根的 `ctx.state`」vs「checkpoint→restore 後」結構化 deep-equal

### 選項 B（終局解，blast radius 大）：`ctx.state` 全面 write-log undo（複製 mtf `spec.cw`）
- 改 `interpreter.ts:3382-3400`(restore 改反向 replay),寫入端全接上:`strategy.ts:887-889/942/1099/1262/1276`、
  `strategyEquity.ts:71-84`、`ta.ts:215,233,402,547,562,567,614,1159,1500,1565,1590,1680,2159`
- **風險高**:漏記一個寫入 → restore 靜默錯誤(不 throw)。**建議先做 A/C,之後再評估 B**。

### 選項 C（建議搭配 A）：`strategy|ddCache` 改 O(1) 純量快照
- `equity` 是 append-only 前綴、`peak/dd/trough/runup` 是前綴聚合 → 只需記 `{count, len, peak, dd, trough, runup}`(全純量)+ restore 時 `equity.length = len`
- 改 `interpreter.ts:3330-3407`(加專屬分支);`strategyEquity.ts:22-35`/`:66-84` 語意不變,只讓快照端讀得到這 6 欄位(或暴露 `ddCacheSnap()/ddCacheRestore()`)
- 風險低(前提:equity 前綴永不改寫 — 現況成立:`for (let b = cache.equity.length; b <= bar; b++)` 只 append)

**推薦 A + C**:A 用一個 Symbol + 6 處建立端,同時消掉 O(B²) 的 `simCache` 與指標腳本的 Θ(B) array-leaf clone;C 用 6 個純量換掉 ddCache 的 Θ(B)。兩者都局部、可被元素計數 probe 直接證偽。

## 5. 殘留 unknown（本審計未跑 benchmark，全部為靜態推導）

1. §3 的 ms 倍率是 **[INFERENCE]**;元素計數需靠 §4 的計數器 probe 實測(既有 100 根資料僅 `s1-inc-tris-final.json`,且是指標腳本、無 strategy)。
2. per-element clone 成本(ns)未量(推導用 50–150 ns/元素)。
3. **實際 app 腳本是否每根讀 `strategy.*`** 未查(兩支 app 腳本都不是 strategy 腳本)→ 決定 byBar 密度、也就是 B² 是否真成立;若只在少數根讀則退化為 O(B·X)。
4. `ta.ts:2159`(`piv.memo`)之外是否還有其他 `st.memo` 型 site 未逐一列舉(已抓 supertrend/fisher/vwap/piv,另推測 sar)。
5. `wring`/`wvs` 的插入順序是否嚴格單調**未證明** → 選項 A 不可套用在它們身上。
6. `scopeVars`/`containers`/`drawProps`/`bgcolors` 的實際每腳本成長階未量(清單已列,無數字)。
