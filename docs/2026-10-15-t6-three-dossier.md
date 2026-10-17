# T6③ 實作地圖 — builtin 呼叫路徑的 per-call 配置

> 唯讀探子。**本機探子的工具集只有 `read`／`grep`／`glob`（無 shell），故無法跑 `md5sum`。**
> 改用「讀檔時的總行數」當樹狀態指紋（樹正在被改，行數也算不穩，僅供比對）。
> 讀檔時間：2026-10-15（同批 doc 之後）。

## 0. 檔案指紋（無 md5，改記行數 / 與母代理近期值比對）

| 檔案 | 行數（本探子讀到） | 母代理 md5 記錄 | 備註 |
|---|---|---|---|
| `src/pine/builtins/ta.ts` | 2183 | `196c04d1…` | 吻合；已含 `stateFor(...,cap?)`＋`VS_LEN_MAX=16`（`:450`） |
| `src/pine/mtf.ts` | 2411 | `79d67c66…` | 吻合 |
| `src/pine/interpreter.ts` | 3963 | `ff74775f…` | — |
| `src/pine/builtins/util.ts` | 326 | — | `bindArgs` 在此 |
| `src/pine/builtins/math.ts` | 347 | — | `namedValues`/`liftNums` 在此 |
| `src/pine/series.ts` | 730 | `e158d372…` | 未深入（非本 ticket 主體） |

---

## 1. 配置點表（熱路徑逐一）

「每次呼叫配置了什麼」＝在**所有** builtin call 都會發生的配置；「可否移除」分三級：
**A＝可安全提升/刪除（零保留風險）**、**B＝可提升但需先驗無保留**、**C＝不可移除（身分語意）**。

| # | 位置 | 現行原文（逐字） | 每次呼叫配置 | 可否移除 | 必須保持的不變式 |
|---|---|---|---|---|---|
| P1 | `interpreter.ts:1506` | `const args: Value[] = [];` | 1 個 `Value[]` | **B** | 呼叫順序、`evalArg` 對每個 arg 恰好一次；**不可**跨 bar 快取已求值的 Value（會動 `evalNodeCounts`）。`args` 會被 `array.from`(`args.slice()`, `array.ts:80`)、`str.format`(`args.slice(1)`, `str.ts:203`) 複製，無 builtin 保留陣列本身 → 重用安全，但需全域確認 |
| P2 | `interpreter.ts:1507` | `const named: Record<string, Value> = {};` | 1 個物件 | **A** | `named` 在所有 builtin 中**只讀**（`namedValues`、`bindArgs`、`timestamp` 的 `named.timezone`）；無任何 `named[k]=`/`delete named` 寫入（grep 全樹：寫入只出現在 interpreter 的 :1391/:1456/:1512/…，即呼叫端本身）。可共用凍結 `EMPTY_NAMED` |
| P3 | `interpreter.ts:1508` | `const spec = HIST_BUILTINS.get(b);` | Map lookup（無配置） | — | 純讀 |
| P4 | `interpreter.ts:1511` | `const v = evalArg(a, frame, true, !histSpecHas(spec, a.name === undefined ? pos++ : -1, a.name));` | 每 arg 一次 `histSpecHas`（`registry.ts:22`：`spec.names.includes(name)`／`spec.idx.includes(pos)`，無配置、線性探測） | — | `noHist` 判定必須逐 arg 不變 → 影響 `__callHistWrites` 與 `setAt` |
| P5 | `interpreter.ts:1610`（ident 快路） | `if (s) return { kind: 'series', v: s };` | 1 個 `{kind:'series'}` wrapper | **C** | 識別碼→series 必須回傳同一個 `Series` 物件；wrapper 本身新建但 `v` 身分不變 |
| P6 | `interpreter.ts:1620-1623`（literal 快路） | `ls = new LitSeries(evalExpr(a.value, frame), ctx.barIndex);` / `return { kind: 'series', v: ls };` | 首次 `LitSeries`；之後 `ls.bump()`；每 call 1 個 wrapper | **C**（wrapper）／LitSeries 已快取（`run.callHist` by `siteKey`） | `siteKey(run, a.value)`→同一 AST node 必須映射到同一 slot；literal 歷史恆定（LitSeries 虛擬化） |
| P7 | `interpreter.ts:1636` | `return { kind: 'series', v: stableArgSeries(run, siteKey(run, a.value), v.v) };` | 1 個 wrapper（＋churn 時才 `new SiteSeries`） | **C**（wrapper）；`stableArgSeries` 已「偵測 churn 才包」 | `siteKey` 身分不變；只有合法 inner（純 BarSeries 家族）才可被包 |
| P8 | `interpreter.ts:1648` | `s.setAt(ctx.barIndex, v);` | 無配置 | — | **`seriesWrites.setAt` 計數必須完全不變**（`scripts/perf/lib/counters.mjs:27` patch `BarSeries.prototype.setAt`） |
| P9 | `interpreter.ts:1649` | `__callHistWrites++;` | — | — | `__callHistWrites` 必須完全不變（`interpreter.test.ts:1150` 斷言 literal 路徑 0 writes） |
| P10 | `builtins/util.ts:201` | `const out = new Map<string, Value>();` | 1 個 `Map` | **B** | 綁定語意（named 先填、positional 依序補、named 不佔位）；可改「每 callsite 重用一個 Map 並 `clear()`」，前提是無 builtin 保留 `bound` Map 跨 bar（需審） |
| P11 | `builtins/util.ts:203` | `if (Object.keys(named).length === 0) {` | **1 個 keys 陣列**（空物件也配置） | **A** | 空 named 的 fast path 行為等價 |
| P12 | `builtins/util.ts:208` | `for (const [k, v] of Object.entries(named)) {` | 非空時 1 個 pairs 陣列 | **A**（在空 fast path 之外） | 同上 |
| P13 | `builtins/ta.ts:192-199`（`vsOf`） | `return stateFor<VS>(ctx, ['vs', site, 'series', seriesId(t)], () => ({...}));` | **1 個 parts 陣列**（`['vs', site, 'series', seriesId(t)]`）；`site = rt.callsite ?? 'g'` | **B** | **key 逐位元**：parts 序列與 KPart 型別（string/number/boolean/undefined）必須完全一致；改動會重建 VS |
| P14 | `builtins/ta.ts:202-210`（`vsOf` 純量） | `return stateFor<VS>(ctx, ['vs', site, 'const', sig, c], () => ({...}));` | **1 個 parts 陣列** | **B** | 同上（`sig` 來自 arg 名） |
| P15 | `builtins/ta.ts:213`（`vseries`） | `return stateFor<VS>(ctx, ['dvs', ...kparts(key)], () => {...}, cap);` | parts 陣列 + `kparts(key)` 展開（非物件 key 時 `kparts` 又配一次 `[k]`） | **B** | key 序列不變 |
| P16 | `builtins/ta.ts:233`（`vstate`） | `return stateFor<VS>(ctx, ['stv', ...kparts(key)], () => {...}, cap);` | 同上（parts＋`kparts` 展開） | **B** | key 序列不變 |
| P17 | `builtins/ta.ts:619`（`emaVs`） | `return stateFor<VS>(ctx, ['dvs', 'ema', ...kparts(tag), len], () => {...}, VS_LEN_MAX);` | parts 陣列 + `kparts(tag)` 展開 | **B** | key 序列不變；`tag` 為字串（見 P19） |
| P18 | `builtins/ta.ts:646`,`:676`,`:682`,`:986`,`:1149-1151`,`:1499-1501`,`:1572-1574`,`:1663-1665`,`:2150-2152` | 同型 `stateFor(ctx, ['…', ...key], …)` / `winStateFor(ctx, parts, …)` | 每次呼叫 1+n 個 parts 陣列 | **B** | 一律「key 序列＋KPart 型別逐位元不變」 |
| P19 | `builtins/ta.ts:733-735`（`emaTag`） | `return \`${rt.callsite ?? 'g'}|${id}\`;`（`id` 由 `seriesId(stableSeries(sv.v))` 造，`:734`） | **1 個 template 字串** | **B** | `tag` 內容逐字元不變（它是 `dvs` key 的一部分）；`stableSeries`/`seriesId` 身分不變 |
| P20 | `builtins/math.ts:96`（`liftNums`） | `const vs = args.concat(namedValues(ctx, named, params));` | **1 個 concat 新陣列**（即使 named 空也複製） | **A** | `vs` 順序/內容不變（影響 `outKind` auto 決策與 `f(...)`） |
| P21 | `builtins/math.ts:79-80`（`namedValues`） | `const out: Value[] = [];` / `for (const [k, v] of Object.entries(named)) {` | 1 個 `out` 陣列 + 1 個 `Object.entries` pairs 陣列（空 named 也配置） | **A** | 未知 named 的 warn 行為不變 |
| P22 | `interpreter.ts:1555/1649` | （`__callHistWrites`） | — | — | 見 P9 |

> 附註：`invokeBuiltin` 每呼叫固定配置 = **P1 `args[]` + P2 `named{}`**（2 個）＋每個 series arg 一個 wrapper（P5/P6/P7）。`bindArgs` 每呼叫再加 **P10 `Map` + P11 keys 陣列**。`liftNums` 家族每呼叫再加 **P20 concat + P21 out + P21 entries**（3 個）。`ta.ema` 每呼叫再加 **P13/P19 + P15/P17** 陣列與 tag 字串。
> 對照 profile：`ta.ema` 20.55µs/call、只有 3.0 gets/bar（`scratch/perf/r3-hotspot-macd-after.txt`）⇒ 成本確實在 per-call 開銷而非視窗掃描。

---

## 2. 最小改動草稿（建議順序；每一步都可獨立 tsc 驗）

**Step 1（最安全，動 P2/P11/P20/P21）— 空 named 的零配置快路**
1. `builtins/util.ts` 匯出共用 `export const EMPTY_NAMED: Readonly<Record<string, Value>> = Object.freeze({});`
2. `interpreter.ts:1507`：`const named: Record<string, Value> = hasAnyNamed(node) ? {} : (EMPTY_NAMED as Record<string, Value>);`，其中 `hasAnyNamed(node) = node.args.some(a => a.name !== undefined)`（可在 `Call` node 上一次性快取）。
   - 因為 `named` 只讀（本表已驗），共用凍結物件安全。
3. `builtins/util.ts:203`：`Object.keys(named).length === 0` → `for (const _k in named) { hasAny = true; break; }`（或直接 `named === EMPTY_NAMED` 判定）。P11 的 keys 陣列消失。
4. `builtins/math.ts:95-96`：`const has = /* for..in named hasAny */; const vs = has ? args.concat(namedValues(ctx, named, params)) : args;`。空 named 時 P20/P21 三個陣列全消失。
   - 保守起見：`namedValues` 內部也加同樣的「空即回 `EMPTY_VALUES`」早期返回。

**Step 2（動 P10）— `bindArgs` Map 重用或延遲**
- 選項 a（低風險）：保留 Map 但空 named 時仍走 `out`；無改善。
- 選項 b：把 `out` 提升為呼叫端（每 callsite）持有的可重用 Map，`bindArgsInto(out, args, named, order)` 內先 `out.clear()`。
  - **前置審查**：確認沒有任何 builtin 把 `bound` Map 存進 `rt.state`/長命結構（目前 grep 未見；`ta.ts` 只用 `bound.get(...)` 立即取值）。
  - 同理 `args` 陣列（P1）可每 callsite 重用，但 `array.from`/`str.format` 的 `slice()` 已是複本，安全；仍建議先只做 `named`＋`bindArgs`。
- 注意：`bindArgs` 也被 `draw.ts:273` 等非熱路徑呼叫；改介面要全呼叫點一致。

**Step 3（動 P13–P19，較高風險）— parts/tag 快取**
- 只在 Step 1/2 量到不足時才做。做法：以「每 callsite 一個 scratch 陣列」重用 parts（`parts[0]=…; parts.length=n`），或把 `emaTag` 的字串依 `(callsite, seriesId)` 記憶。
- **紅線**：任何 parts 元素的值與**型別**、任何 key 字串的**逐字元內容**、`seriesId`/`stableSeries` 身分，都必須與現行相同，否則 `ta.*` 狀態 key 改變 → VS 被重建 → 數值/計數器/digest 全飄。

**不要做**：不要跨 bar 快取 `evalArg` 的求值結果（P5/P6/P7 的 Value 必須每 bar 重新求），否則 `evalNodeCounts`（`interpreter.ts:816`）與 `setAt` 計數會變。

---

## 3. 計數器影響（硬約束：應完全不變）

| 計數器 | 來源 | 何時會動 | 本 ticket 的要求 |
|---|---|---|---|
| `evalNodeCounts` | `interpreter.ts:816`（`run.evalCount` 開關，`debugFlags.ts:52`） | 少 eval／多 eval 一個 AST node | **不變** ⇒ 不得跳過任何 `evalArg`/`evalExpr` |
| `seriesWrites.setAt` | `scripts/perf/lib/counters.mjs:27` patch `BarSeries.prototype.setAt` | 任何 `s.setAt` 呼叫數變動（含 `interpreter.ts:1648`、mtf `advanceTo`） | **不變** |
| `__callHistWrites` | `interpreter.ts:1649/2658` | `evalArg` literal/scalar→callHist 分支的寫入 | **不變**（`interpreter.test.ts:1143-1151` 直接斷言） |
| `mtf.evals` | `mtf.ts:1919`（`computeAt` 內 `__mtfStats.evals++`） | MTF cache miss | **不變** ⇒ T6③ 不得碰 `mtf.ts` 快取/`stateFor` key 的語意 |
| `mtf.hits`/`agHits`/`invHits` | `mtf.ts:1852/1859/1874/1886/1901` | per-caller 快取命中 | 連帶：key 不變 ⇒ 不動 |

> 驗收對照（母代理既有基線）：`evalNodeCounts.total` @100 app = 32,742；`seriesWrites.setAt` @100 = 17,274；`mtf.evals` = 4,509。
> 驗證面：digest `18qepy0`/`1580h2` 不變；`scratch/perf/ta-hotspot.mjs` 的 `us/call` 下降而 `gets/bar` 不變。

---

## 4. 風險清單

1. **key 身分漂移（最高）**：`stateFor`/`vseries`/`vstate`/`emaTag` 的 parts 或 tag 只要有一位元差異，`ta.*` window/EMA 狀態被重建 → 數值錯、`setAt`/digest 飄。任何 parts 快取都必須先寫下「同一 callsite 的 parts 序列與型別」golden。
2. **共用 `EMPTY_NAMED` 被誤寫**：現行所有 builtin 只讀 `named`，但若有新 builtin 寫入 → 用 `Object.freeze` 讓它在 strict mode 直接拋錯（fail-fast）。
3. **`args` 陣列重用**：`array.from`/`str.format` 已 `slice()`；但仍需確認無其他 builtin 保留 `args` 本體（目前 grep 未見）。若日後新增，重用會踩雷；`EMPTY_NAMED` 這一步不涉 `args` 重用，風險最低，建議先做。
4. **`bindArgs` Map 重用**：`bound` 若被 builtin 保留（例如放到 state），重用會跨呼叫污染。需逐 builtin 審（`draw.ts`/`ta.ts`/`strategy.ts` 的 `bindArgs` 呼叫點）。
5. **不碰 eval 語意**：任何「快取已求值 arg」的念頭都會動 `evalNodeCounts`，必須拒絕。
6. **樹在變**：本探子無 shell，無法核 md5；主代理套用前請重讀 `interpreter.ts:1505-1516`、`util.ts:194-235`、`ta.ts:162-180`、`math.ts:73-96` 確認行號未位移。

---

## 5. 一句話結論

T6③ 最低風險、最高確定性的改動是 **P2 `named`（共用凍結空物件）+ P11 `bindArgs` 的 `Object.keys` 空判定 + P20/P21 `liftNums` 空 named 快路**——三者合計每呼叫省下 3–5 個短命物件，且**完全不動任何 key 身分與計數器**；`stateFor` 的 parts 快取（P13–P19）留作第二階段，因為它是唯一會影響 `ta.*` 狀態的區域。
