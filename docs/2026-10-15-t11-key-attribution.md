# T11 — MTF per-caller 快取鍵歸因（唯讀，2026-10-15）

> 目標檔案（交付時請放到）：`C:/Users/bear9/OpenCharts/docs/2026-10-15-t11-key-attribution.md`
> 樹：凍結優化樹，`src/pine/mtf.ts` = 2411 行、md5 `79d67c66b8e19349b4fdaeeaef5d3d79`。
> 本檔為唯讀審計；未改任何檔案。

---

## 0. 結論（先講）

1. **「per-caller 讀取命中 = 0」是錯的**（至少在 TRIS390 上）。引擎裡 `hits` 只在 5 處 `++`：
   `:1852`(invCache) / `:1859`(per-caller) / `:1874`(agnostic) / `:1886`(per-caller) / `:1901`(per-caller)。
   `__mtfStats` 的 `agHits`(`:1874`) 與 `invHits`(`:1852`) 都是**顯式計數器**，
   因此 **per-caller 命中 = `hits − agHits − invHits`**，這是一個可直接量到的殘差（不是定義恆等式）。

2. **原始 `__mtfStats` JSON 直接證實殘差 > 0**（下表）。而且**同一腳本的殘差跨樹逐位元相同**
   （基線 `s12-clean1` @500 TRIS390 = 7481；優化 `a3-final` @500 TRIS390 = 7481）
   ⇒ 殘差是 per-caller 命中，而不是快取被 degate 後的位移。MACD701/K55/final 殘差**恆為 0**
   （它們的 expr 全是純量+agnostic，根本不走 per-caller 分支）——母代理看到的「4 份資料集逐位元吻合」
   只成立於這三支，**不適用 TRIS390**。

3. **判定的兩個情境**（母代理要求）：
   - 情境 **(a) per-caller 確實 0 命中** → 只對 MACD701_v72 / K55 app / final.pine 成立。
   - 情境 **(b) 其實有命中** → 對 **TRIS390 成立**（本輪 T11 的關注腳本）。
     §1 的鍵分岔與 §2 的 callsite 修法因此**仍然有效**，但「命中=0」的前提要改成
     「命中被寫在**短命的 UDF Scope** 下，跨 invocation 全部作廢」。

---

## 1. 寫入鍵 vs 讀取鍵（逐處，行號以 `grep` 實測為準）

三條快取路徑全部由 `evalAt(spec, node, j)`（`mtf.ts:1822-1917`）服務，鍵一律是
`const caller = spec.callerScope ?? EMPTY_SCOPE`（**`:1828`**，`EMPTY_SCOPE` 定義在 `:1344`）。

| # | 行號 | 動作 | 鍵 | 備註 |
|---|------|------|----|------|
| W0 | `:2039` | 每次 `tryEvalSecurity` 進來時 `spec.callerScope = frame.scope` | — | 來源是**呼叫者的 `Scope` 物件** |
| W1 | `:1904-1912` | `nodeCache[node][caller][j] = v`（verdict 1 的落點） | `Scope` | `:1908` 首次見到 node 才建外層 map |
| W2 | `:1861-1869` | verdict 3 若 payload immutable → 寫 `invCache`（j-less）；**mutable/series 不寫**，落到 W1 | `node` | 寫入 `m.set(node,v)` `:1867` |
| W3 | `:1888-1893` | verdict 2 若 payload immutable → 寫 `agnosticCache[node][j]`；**mutable 不寫**，落到 W1 | `node` | `by.set(j,v)` `:1893` |
| R1 | `:1858-1859` | verdict 3 的 **mutable carve-out 讀**：`nodeCache[node][caller][j]` | `Scope` | 命中只 `hits++`（無 ag/inv） |
| R2 | `:1885-1886` | verdict 2 的 **mutable carve-out 讀**：同上 | `Scope` | 同上 |
| R3 | `:1899-1901` | **verdict 1 主讀**：`nodeCache[node][caller][j]` | `Scope` | 同上 |
| M | `:2056-2062` | **路由**：`seenCallers.has(frame.scope)` → `nodeCache = durableCache`（跨 bar 持久）；否則 `seenCallers.add` + `nodeCache = new Map()`（**單次 invocation 的暫存 map**） | `WeakSet<Scope>` | 這一層是為「Scope 會換物件」而存在的補丁 |

**同一支 `evalAt` 內，寫鍵與讀鍵是同一行程式算出的同一個變數**（`:1828` 只算一次），
所以「鍵對不上」必定發生在**跨呼叫**（不同次 `evalAt` 之間），不可能發生在單次內。

### 1.1 身分在哪裡分岔（核心）

- **寫入鍵 = 呼叫者的 `Scope` 物件身分。** 對 top-level 的 `request.security`，`frame.scope`
  是**根 scope**（`interpreter.ts:2940/2989` 建一次、跨 bar 持有）⇒ `:2056` 第二次起走
  `durableCache` ⇒ 這些條目**能**跨 bar 命中（TRIS390 的 7481 就是這樣來的）。
- **但 security 一旦在 UDF 內，呼叫者 scope 是「每次 invocation 新配一個物件」**：
  `callUdfValue` 的 `const callScope = new Scope(fn.closure)`（**`interpreter.ts:1733`**）。
  因此寫在 `callScope_N` 下的 `nodeCache[node][Scope_N][j]` 對 `callScope_{N+1}` **永遠讀不到**
  （不同物件）；`:2060` 也只會把它記進 `seenCallers` 卻因為 key 換了而用不到 `durableCache`。
  ⇒ **per-caller 條目對 UDF 呼叫者是「只寫不讀」的死條目**（就是 `:2046-2055` 註解自己承認的病態）。
- 對照組：**同一支 spec 已經有 per-callsite 的穩定身分**，只是沒被 eval 快取使用：
  - `spec.callerKey = callsiteKey(ctx, spec.node)`（**`mtf.ts:2040`**），
  - `chartHist` 用它當鍵（`:1036`，`SecSeries.forCaller` `:1068`），
  - `lastEmit` / `lastChartBar` 也用它（`:2199` 附近的 `callerKey`、`emitChartAll`）。
  - `callsiteKey(ctx,node)` = `siteKey(runOf(ctx), node)`（**`interpreter.ts:499`**、`:477`），
    而且**同一個身分**已經被 `callUdfValue` 用來讓 UDF 的 param CowSeries 跨 bar 存活
    （`const cowKey = siteKey(run, callNode)`，**`interpreter.ts:1734`**）。
- **結論：eval 快取用的是「弱身分（Scope 物件）」；chart 歷史用的是「強身分（callsite trie 葉節點）」。
  同一支 spec 裡兩套身分並存，這就是分岔點。**

---

## 2. 最小改法（用 callsite key 取代 Scope 身分）

**只動 `mtf.ts` 的 `nodeCache` 鍵與其路由；`invCache`/`agnosticCache`/verdict 邏輯不動。**

### 2.1 diff 草稿

```diff
@@ interface SecuritySpec（:190-206）
-  nodeCache: Map<Node, WeakMap<Scope, Map<number, Value>>>; // node → caller scope → tfBarIndex → value
+  /** per-callsite eval cache. 鍵 = spec.callerKey（callsite 身分，interpreter.ts:499），
+   *  不是呼叫者 Scope 物件（UDF callScope 每次 invocation 都新配 ⇒ 寫了就讀不到）。 */
+  nodeCache: Map<Node, Map<object, Map<number, Value>>>;   // node → callerKey → tfBarIndex → value
-  durableCache: Map<Node, WeakMap<Scope, Map<number, Value>>> | null;
-  seenCallers: WeakSet<Scope>;
+  // durableCache / seenCallers 移除：callerKey 天生跨 bar 穩定，不再需要 seen 升級。

@@ 新 spec（:548-551）
-      bars: null, scope: null, pivot: null, callerScope: null, callerKey: null, durableCache: null, seenCallers: new WeakSet(), ctx: null,
+      bars: null, scope: null, pivot: null, callerScope: null, callerKey: null, ctx: null,
@@ resetTfFrame（:1111-1115）
       spec.nodeCache.clear();
       spec.agnosticCache?.clear();
       spec.invCache = null;
-      spec.durableCache = null;
-      spec.seenCallers = new WeakSet();

@@ evalAt（:1828）
-  const caller = spec.callerScope ?? EMPTY_SCOPE;
+  // 寫鍵 = 讀鍵 = callsite 身分（tryEvalSecurity :2040 每次進來重設）
+  const caller = spec.callerKey ?? spec.node;

@@ R1/R2/R3 三處（:1858, :1885, :1899-1901）與 W1（:1904-1912）
   → 完全不改（同一變數 `caller`，語意自動變成 callsite 鍵）。

@@ 路由（:2056-2062）整段刪除（nodeCache 不再需要每次 invocation 換 map）
-  if (spec.seenCallers.has(frame.scope)) { … spec.nodeCache = spec.durableCache; }
-  else { spec.seenCallers.add(frame.scope); spec.nodeCache = new Map(); }

@@ SpecSnap（:2242-2243）/ snapSpec（:2290-2291）/ restore（:2329-2330）
-  nodeCache / durableCache 兩個欄位：durableCache 欄位刪除；nodeCache 照舊（同一物件參照）。
```

**要動的呼叫點/鍵產生方式**：唯一新的鍵來源是 `spec.callerKey`（`:2040` 已經算好、已用於
chartHist/lastEmit），**不需要新的鍵函式**；`EMPTY_SCOPE`（`:1344`）可留可刪。
`WeakMap<Scope,…>` 必須改成 `Map<object,…>`：callsite 的 trie 葉節點是 `{}` 物件，
被 `run.siteTrie` 長期持有 → 用 `Map` 不會漏（`WeakMap` 反而因為葉節點可達而失去意義）。

### 2.2 這條改動會多拿到什麼

UDF 內的 security：現在每次 invocation 都寫一份新 map，命中的只有「同一次 invocation 內」
的重讀（warm-up→per-bar、`TfGlobalSeries.at` 的遞迴重讀）。換成 callsite 鍵後，
條目在 **同一 callsite、跨 chart bar** 仍存活，只要某個 chart bar 映射到同一個 tf bar `j`
（chart tf 與請求 tf 不同、或 `[n]` 歷史讀取、或 lookahead_on 的 developing bar 重算）
就能命中 ⇒ `evals` 下降、per-caller 命中上升。top-level 呼叫者本來就走 `durableCache`，
所以**只有 UDF 包裝的 security 會受益**（TRIS390 正是這種）。

---

## 3. 風險（哪些形狀會誤命中）

1. **同一 callsite、同一 bar 內被兩個不同外層 scope 各呼叫一次**（例如迴圈內同一行呼叫同一 UDF
   兩次、或 UDF 被當函式值經由**同一語法位置**動態派發給不同閉包）。
   `siteKey` 回的是「(site stack 頂端, node)」的葉節點 → 兩個呼叫者共用同一鍵，
   而 `Scope` 身分原本能把他們分開 ⇒ 會誤命中。**這是主要風險**，需要在 review 時確認
   被改到的 spec 其 security node 是否可能在同一 bar 被同 site 二次呼叫（`invocations` > bars×callsites 就是訊號）。
   - 緩解：只對「verdict 1 且非 mutable」用 callsite 鍵，或把 `callerKey` 再併入
     `ctx.barIndex`（即 `(callsite, chartBar)`）——後者等於把「同 bar 二次呼叫」排除。
2. **`siteKey` 依賴 `run.siteCtx` 當下狀態**：若某次 `evalAt` 是在 site 堆疊為空（prefetch/frame0
   暖身）時發生，`siteKey` 回 `node` 本身，與 per-bar 的葉節點不同 ⇒ 只會 miss（安全），
   但也可能與「top-level 同 node」碰撞（top-level 每個 callsite 本來就是不同 node ⇒ 安全）。
3. **遞迴 UDF／同 site 再入**：葉節點相同 → 共用條目；值由 `(callsite, j)` 決定且 tf frame
   在固定 `j` 下是確定性的 ⇒ 只要 expr 不讀「同一 bar 內會被改動的 caller 區域變數」，值相同。
   會誤命中的形狀：expr 讀到呼叫者在**同一 tf bar 內被 `:=` 改過的區域變數**
   （agnostic 閘門已排除這種 expr 進 shared cache，但 per-caller 路徑原本靠 `Scope` 身分當第二道防線——
   改鍵後這道防線消失，必須確認 verdict 1 的 expr 不含此形狀）。
4. **trie 記憶體**：`siteKey` 已經在 `callUdfValue` 為每個 (callsite,node) 配置葉節點
   （`:1734`），eval 快取改用同一批葉節點 ⇒ **不新增配置**；但條目本身不再因
   「每次 invocation 換 map」而自動失效，長歷史下要多注意 `restoreTfFrame`/`resetTfFrame`
   是否清乾淨（`:1104-1115` 已清 `nodeCache`；`lookahead/ltf` 分支 `:2368-2375` 也清）。

**若採停損（命中仍為 0，T11 的停損條）**：先確認 `callsiteKey` 在該腳本真的有值
（`spec.callerKey != null`；`siteCtx` 非空），否則鍵會退化成 `spec.node`，就等於 per-node 快取，
對 UDF 內同一 node 的不同 callsite 會**互吞**。

---

## 4. 驗證方式（命令；MSYS：一律 `cd /c/Users/bear9/OpenCharts && <inline>`）

**先量「現況真值」**（關鍵：把**顯式** `invHits` 讀出來；per-spec 探針的 `snap()` 沒讀它，所以看不到）：

```bash
cd /c/Users/bear9/OpenCharts && npx tsx scripts/perf/pine-bench.mjs --script src/pine/TRIS390.pine \
  --bars 100 --repeat 1 --warmup 0 --instrument --out scratch/perf/t11-check.json --md
# 讀 out.results[0].counters.mtf，計算 perCaller = hits - agHits - invHits（期望 > 0，見 §0 表）
```

（替代：任何會 dump `{...__mtfStats}` 的既有 harness／`scripts/perf/lib/counters.mjs` 的
`snapshot()` 都有 `invHits` 欄；`scratch/perf/s1-inc-probe.mjs` 的 `log[].cold` 只挑了 4 個欄位，**不含** invHits，故不能用它判 per-caller。）

**改完後驗收**：
```bash
cd /c/Users/bear9/OpenCharts && npx tsx scripts/perf/pine-bench.mjs --script src/pine/TRIS390.pine \
  --bars 100 --repeat 1 --warmup 0 --instrument --out scratch/perf/t11-after.json --md
# ① perCaller > 0（UDF 版本應上升）② counters.mtf.evals 比 t11-check.json 下降
cd /c/Users/bear9/OpenCharts && npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 5   # 0 mismatch
cd /c/Users/bear9/OpenCharts && npx tsx scratch/perf/s1-inc-probe.mjs --script scratch/perf/t7-tris-probe.pine --bars 500 --ticks 1
cd /c/Users/bear9/OpenCharts && npx vitest run src/pine     # 954 passed | 1 skipped
cd /c/Users/bear9/OpenCharts && npx tsc --noEmit            # 0 error
# 四支凍結 digest 不變：ze7byn(K55 app) / kb0glc(TRIS390) / p4gddl(final) / 1580h2(MACD701_v72)；golden 0 差異
```

---

## 5. 證據附錄（原始 `__mtfStats`，per-caller = hits − agHits − invHits）

| 來源檔 | 樹 / 路徑 | 腳本@bars | evals | hits | agHits | invHits(顯式) | per-caller |
|---|---|---|---|---|---|---|---|
| `bench/pine/s12-clean1.json` | 基線（**無** invHits 欄 ⇒ 無 invCache） | TRIS390@500 app | 8458 | 12444 | 4963 | — | **7481** |
| `bench/pine/a3-final.json` | 優化（有 invCache） | TRIS390@500 app | 2903 | 17999 | 658 | 9860 | **7481** |
| `bench/pine/r5-final-verify.json` | 優化（較早快照） | TRIS390@100 app | 2922 | 11756 | 134 | 9930 | **1692** |
| `bench/pine/a3-final.json` | 優化 | MACD701@500 | 4509 | 3961 | 2459 | 1502 | **0** |
| `bench/pine/s12-clean1.json` | 基線 | MACD701@500 | 7995 | 5447 | 5447 | — | **0** |
| `bench/pine/s12-clean1.json` | 基線 | K55 app@500 / final@500 | 430 / 215 | 2 / 2 | 2 / 2 | — | **0** |
| `scratch/perf/mtf-perspec-optimized.json` | 現凍結樹（per-spec 探針） | TRIS390@100 | 626 | 3265 | 130 | *未收錄* | 3135 = invCache + per-caller（**未拆**） |
| `scratch/perf/s1-inc-tris-cw.json` | 現凍結樹（cold runScript） | TRIS390@100 | 626 | 3265 | *未印* | *未印* | — |

**靜態佐證 TRIS390 的殘差主要是 per-caller**：TRIS390 的 security expr 是 UDF 呼叫
（`f_supertrend/f_rangefilter/f_halftrend`，`src/pine/TRIS390.pine:172-198`）。
`exprSafeForAgnostic`（`mtf.ts:1506-1748`）在 UDF body 遇到 `var x` + `x := …` 會走
`case 'reassign'` 的 `varBound.has(target)` → `return false` ⇒ 這些 expr **過不了 agnostic 閘門**；
`tfInvariant`（`:1765-1813`）只放行 literal/`input.*` 的算式 ⇒ UDF 呼叫也**不可能是 verdict 3**。
⇒ 這些 expr 只能是 **verdict 1**，其命中只能記在 `:1901`（per-caller）。per-spec 表裡
`gateFail = 3`/spec 正對應這 3 條 UDF expr。

**注意**：`scratch/perf/mtf-perspec-optimized.mjs` 的 `snap()` 只讀
`evals/hits/agHits/gatePass/gateFail/prodWalks`（**不含 `invHits`**），
`finish()` 用 `invHits = hits − agHits` 反推，其 `definition` 字串自己也把該殘差標成
"per-caller/transient-path hits"。⇒ 該表的 `invHits` 欄**不能**用來主張 per-caller = 0。


---

## 2.3 補正：**完整站點清單**（實作前必讀；§2.1 的草稿漏了 3 處）

以現行樹（`mtf.ts` 2411 行、md5 `79d67c66…`）逐符號 grep 的結果：

### `durableCache`（9 處）
`:197` 宣告、`:548` spec 初始化、`:1114` `resetTfFrame` 清、`:2057/:2058` 路由（`if (!spec.durableCache) spec.durableCache = new Map(); spec.nodeCache = spec.durableCache;`）、
`:2243` `SpecSnap` 欄位、`:2291` `snapSpec` 帶出、`:2330` `restoreSpec` 還原、**`:2370` 另一處 reset（§2.1 未列）**。
⇒ 刪欄位時 **8 處都要同步**（含 `:2370`）。

### `seenCallers`（5 處程式 + 1 處註解）
`:198` 宣告、`:548` 初始化、`:1115` 清、`:2056` 讀、`:2060` 寫；另 `:2042` 註解、`src/pine/__tests__/perf_bench.test.ts:78` 僅註解（不影響編譯）。
⇒ 連同 `:2050-2062` 整段路由一起刪。

### `EMPTY_SCOPE`（2 處）— **§2.1 漏了這個副作用**
`:1344` `const EMPTY_SCOPE = new Scope();`、`:1828` `const caller = spec.callerScope ?? EMPTY_SCOPE;`。
改成 `const caller = spec.callerKey ?? spec.node;` 後 **`:1344` 變成未使用** ⇒ 必須一併刪除，否則 `noUnusedLocals`（若開啟）會編譯失敗。

### `nodeCache`（21 處）— **§2.1 漏了 `cwMap` 這條**
讀取點 `:1858`／`:1885`／`:1899`／`:1904` 用 `spec.nodeCache.get(node)?.get(caller)?.get(j)` —— 型別改 `Map<Node, Map<object, Map<number, Value>>>` 後這些**不需改**（同一個 `caller` 變數）；
但寫入點 `:1908` 是 `if (!m) { m = new Map(); cwMap(spec, spec.nodeCache, node); spec.nodeCache.set(node, m); }`
⇒ **`cwMap` 的參數型別必須跟著放寬**（它把寫入記進 write-log 以便 rollback，見 `mtf.ts:242-246` `cwMap`）。這是 `spec.cw` 機制的一部分，**改了要跑 parity 6/6**。
另有 `:550` 初始化、`:1111` `resetTfFrame` 清、`:2058/:2061` 路由賦值。

### 驗收（不變）
`perCaller = hits − agHits − invHits`（**顯式計數器**，別用 `hits−agHits` 反推）**> 0 且較現值上升**；`evals` 下降；四支 digest `ze7byn/kb0glc/p4gddl/1580h2` 不變；golden 0；`954 passed`／`tsc 0`；`s1-inc-probe` parity 6/6。
**風險**（§3 既有）：同 callsite ＋ 同 bar 二次呼叫會誤命中；`cwMap` 型別放寬後 rollback 正確性必須由 parity 把守。

> 本線**不產 patch**：這 17+ 處（含 helper 簽章與未使用常數）需要 tsc 即時回饋才安全，`mtf.ts` 現為 T6② patch 的目標檔，兩者要**序列**套用。
