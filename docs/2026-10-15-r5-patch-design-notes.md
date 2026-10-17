# R5 補丁設計註記（我這條 lane：`ta.ts` / `engine.ts`）— 2026-10-15 20:2x

> 目的：把可安全動手的幾項先寫成 **patch-ready 設計**，含逐字碼、提議 diff、驗收與**誠實的不確定**；樹空出來後序列套用。
> 對象樹：`mtf.ts` `79d67c66…`、`series.ts` `e158d372…`（已含 T7 修補）。**本檔未改任何 `src/**`。**

## 1. T12#4 C3 `wring` latch（`ta.ts`）— 1 行，但**驗收方式要換**

現碼（`ta.ts:399-407`，逐字）：

```ts
  return (i: number): number | undefined => {
    if (i < 0 || i > ctx.barIndex) return vs.get(i);
    const c = ring.get(i);
    if (c !== undefined) return c;
    const v = vs.get(i);
    if (v !== undefined) ring.set(i, v);
    return v;
  };
```

問題：`i === ctx.barIndex`（forming bar）**不早退**，會把 forming 值 `ring.set(i, v)` 鎖進 ring。
提議（單行）：

```ts
-    if (i < 0 || i > ctx.barIndex) return vs.get(i);
+    if (i < 0 || i >= ctx.barIndex) return vs.get(i);
```

- **不確定（重要）**：取證實測「三形狀皆 SAME」⇒ 這不是可觀測 bug，逐值 diff **分辨不出修前修後**。因此驗收不能是「值 diff」，必須是**針對性 probe**：造「同一 bar 內先讀 `[i]` 再改寫來源、下一 bar 再讀」的腳本，檢查 ring 是否餵出舊值。沒有這個 probe，此修**無法被證明有效**（只可主張「不可能更糟」）。
- 建議：連同 probe 一起送；否則列為「已知、接受」不修。

## 2. T9 `dvs`/`stv` 上限（`ta.ts`）— 目標表已釘死

**現況**：`wvs` 有 `WIN_LEN_MAX = 64`（`ta.ts:431`，clear-on-full，註解已附量測出處）；`wring` 有 `WIN_RING_MAX = 512`（`:363`）。**但這幾族沒有**：

| 行 | 表 | 形狀 | 成長 |
|---|---|---|---|
| `:206` | `['dvs', ...kparts(key)]` | `VS` | 長度進 key ⇒ Θ(bars) |
| `:226` | `['stv', ...kparts(key)]` | `VS` | 同上 |
| `:600` | `['dvs','ema', ...kparts(tag), len]` | `VS` | 顯式 `len` ⇒ Θ(bars) |
| `:1132 / :1482 / :1555 / :1646` | `stv-m` | `Map<bar, …>` memo | 每個 live key 一份 Θ(bars) memo |

**提議**：仿 `winStateFor`（`ta.ts:438-444`）加一個 capped 變體，並把上表路由過去：

```ts
const VS_STATE_MAX = 16;   // 量測：真實腳本每群 live distinct-len ≤9（t9-distinct-len.json）；
                           // bench 飽和形 9、cycle 7；growL-* 無界形 240 ⇒ 上限必須 plateau。
function cappedStateFor<T>(ctx: BuiltinCtx, parts: readonly KPart[], make: () => T): T {
  const byKey = stateFor<Map<number, T>>(ctx, parts.slice(0, -1), () => new Map());
  const L = parts[parts.length - 1] as unknown as number;   // 需確認 KPart 形狀
  let st = byKey.get(L);
  if (st === undefined) {
    if (byKey.size >= VS_STATE_MAX) byKey.clear();
    st = make();
    byKey.set(L, st);
  }
  return st;
}
```

- **不確定（必先確認）**：`kparts(key)` 的回傳形狀我還沒讀（`ta.ts:195-235`、`:590-605`）。若最後一個 component **不是**裸 number（例如是 `['len', 12]` 之類的 pair），上面的 `parts.slice(0,-1)` 寫法要改成「切在 L 前一層」，不能照抄。**套用前必讀這三段**。
- 另一條更保守的路：不動 `stateFor` 走法，只在**每個 leaf memo 的寫入點**做 clear-on-full（`stv-m` 那四處已是 `Map`，加 `if (memo.size >= VS_STATE_MAX) memo.clear();` 於 `set` 前），代價小、風險低、但只治 memo 不治 state 表。**建議先走這條**（改動局部、可逐處驗）。
- 驗收：240 根 `ta.ema(close, cnt+1)`／`ta.rma` 的 states／memo **有界**（附上限與實測）；逐值（含 na）0 差異；K55 `gets/bar` 不變；四支 digest 不變；golden 0；954／tsc。
- 停損：會改任何輸出值 → 不加，只交量測＋提案。

## 3. T10 adaptive tick-skip — **前提更正：不是死碼，勿盲刪**

現碼（`engine.ts`，逐字）：

```ts
    if (!force && lastRunMs > HEAVY_RUN_MS && !incHolder.live && !incHolder.active && key === lastTapeKey) return;
```

`HEAVY_RUN_MS = 500` 上方的註解說明其**設計意圖**：

> The incremental path exempts itself: once a live session exists, a tick costs ~one bar of eval, not a full tape — keep updating.

⇒ `!incHolder.live && !incHolder.active` **不是**「永不成立」，而是「增量 session 存在時刻意不跳」。至少三種情況可達：

1. **首次重跑**：live session 尚未建立，而首跑（全量）> 500 ms ⇒ 跳 tick 是**正確**行為（防佇列堆積）。
2. **拿不到 live session 的腳本**（`incRun` 回 `live === null` 的路徑）。
3. **session 失效／被丟棄後**（`active=false` 且 `live=null`）的下一跑。

**結論**：brief §T10 的「非空 tape 實質不可達 ⇒ 死碼」**不成立**（我判定為錯），**不得**直接移除。
**要動之前必須先做**：一支可達性 probe——記錄 (a) 首跑 ms、(b) 該腳本是否拿到 live session、(c) skip 是否真的發生過（在 `request()` 的 return 前加臨時計數或在 probe 側包裝 `sessionRunner`）。有數據再決定「保留／改由 `live.dead` 觸發／只改註解」。

## 4. 不歸我做（避免碰撞）

- **T12#5 `bind` 契約**（`series.ts:615`）：`series.ts` 是另一個代理的 T7 檔（它剛套 `e158d372…`）⇒ 我**不動**，等它交棒或由它一起做。
- **T8a/T8b**：同屬 `strategy.ts`／`series.ts` 交界，且 T8a 的修法（Sim 增量）需要設計討論（見 `docs/2026-10-15-t8-replay-attribution.md` §3），不宜先斬後奏。

## 5. 套用前提（與 fix-plan 一致）

1. 窗口 C（20:30–22:15）結束、且確認樹未被回退（`series.ts` 仍 `e158d372…`）。
2. 動手前新快照；回退來源 `scratch/perf/r5-pine-optimized-b9/pine`。
3. 同檔序列、不同檔可並行；每項套用後立刻跑 954／tsc／四支 digest／golden。

## 6. T8a 精確錨點（`builtins/strategy.ts`）— **不是一行能修的，需要先設計**

現碼（`strategy.ts:883-895`，逐字）：

```ts
// ── deterministic-read cache ────────────────────────────────────────────────
// Simulation is a pure function of (orders.length, uptoBar, ctx). Memoize per
// orders-array so repeated lazy reads on the same bar don't replay.

interface SimCache { count: number; byBar: Map<number, Sim> }

function simAt(ctx: BuiltinCtx, uptoBar: number): Sim {
  const st = stateOf(ctx);
  if (!st) return emptySim();
  const orders = st.get(ORDERS_KEY) as StratOrder[] | undefined;
  if (!orders || orders.length === 0) return emptySim();
  let cache = st.get(CACHE_KEY) as SimCache | undefined;
  if (!cache || cache.count !== orders.length) { cache = { count: orders.length, byBar: new Map() }; st.set(CACHE_KEY, cache); }
  let r = cache.byBar.get(uptoBar);
  if (!r) { r = simulate(ctx, orders, cfgOf(ctx), uptoBar); cache.byBar.set(uptoBar, r); }
  return r;
}
```

**機制（與 T8 實測吻合）**：任何一根新增下單 ⇒ `cache.count !== orders.length` ⇒ **整個 `byBar` 被丟掉**；緊接著的讀取（`uptoBar = ctx.barIndex`，單調遞增）必然 miss ⇒ 每次 `simulate()` 都從第 0 根重跑到 N ⇒ 步數 Σ = **B(B−1)/2**。這也解釋了為何 `epochRebuildSteps = 0`：reset 本身不花步數，**是 miss 在花**（每根都 miss）。

**為什麼不能一行修**：`byBar` 的 reset 是為了正確性（不同 `orders.length` 可能改變歷史成交結果）。要真增量，必須讓 `simulate` **可續跑**：

1. 先讀並理解 `simulate()` 本體（`strategy.ts:860-910` 起）：它如何依 `o.bar <= uptoBar` 過濾 orders、內部機器（`openLegs`/`closed`/`pending`/`cancelledAt`）如何在 bar 間演進。
2. 只有在「歷史成交結果不因後續下單而改變」可證時，才能做 **prefix 快取**：在 miss 時從最大已快取 `k < uptoBar` 的狀態**續跑**，而非從 0。
3. 若 (2) 不可證（例如 `pending`/OCA 會被後來的 order 改寫），則需把 `simulate` 重構成 stepper（`advance(bar)`）＋可快照狀態；這是**設計工作**，不是補丁。

**驗收（實作後）**：`replaySteps` 由 B(B−1)/2 降為 **O(B)**（bars 100/200/500 新表）；四支 digest 不變；`s1-inc-probe` parity 6/6；golden 0。
**目前狀態**：**未實作**（等 `simulate` 本體判讀完成）。

### 6.1 決定性補充：`simulate` **不是純函式**（讀 `strategy.ts:440-485` 得證）

```
:447   if (o.seen < o.bar) { ev = j; break; }
:452   if (o.bar > uptoBar) { o.seen = o.bar; continue; }
:480   o.seen = o.bar - 1; // next advance checks from this order's bar
```
以及 `applyFill` 內對 **共享** 物件的寫入：`p.cancelledAt = bar - 1`、`p.mod = {...}`（OCA 兄弟）。

⇒ 檔案頭那句「Simulation is a pure function of (orders.length, uptoBar, ctx)」與實作不符：replay 會**改寫 orders 上的 `seen` 游標與 OCA 兄弟狀態**。
⇒ 影響修法：**(a)** `byBar` 快取存的是**被原地改寫過的 Sim 物件參考**，續跑會別名化，不能直接 `byBar.get(k)` 再往下跑；**(b)** 要做真增量，必須把「游標（`o.seen` / `pending` / OCA 狀態）＋Sim」一起做成**可快照的 stepper 狀態**，由它持有，而不是散在 orders 上。
⇒ **仍是設計工作**（中等重構），且必須以四支 digest＋parity 6/6＋golden 0 為閘。
⇒ 附帶線索：`o.seen` 的存在表示設計上原本就想做增量；`seen` 目前只讓 reply 具冪性，沒讓它省下步數（實測步數仍 = B(B−1)/2）。

## 7. T6② + T12#1/#2（`mtf.ts` + `interpreter.ts` hook 表）— 設計已定，成 patch 前需一個不變式

現碼：

```ts
// mtf.ts:2380-2391
function mtfCheckpoint(): unknown {
  const ids = new Map<unknown, unknown>();
  const specs: [SecuritySpec, SpecSnap][] = [];
  for (const spec of store.byNode.values()) {
    spec.cw ??= [];                                            // ← 打開日誌
    if (spec.cw.length > __mtfStats.cwPeak) __mtfStats.cwPeak = spec.cw.length;  // ← 單調 max
    specs.push([spec, snapSpec(spec, ids)]);
    spec.cw.length = 0; // baseline — post-checkpoint writes accumulate here
  }
  return { store, specs } satisfies MtfSnap;
}
```
```ts
// interpreter.ts:3670-3696（冷載入）
const live: IncLive = { s, ckpt: checkpoint(s, -1), committed: -1, key: opts.incKey, dead: false };
const lastClosed = bars.length - 2;                 // bars[len-1] 是 forming bar
for (let bar = 0; bar < bars.length; bar++) {
  const r = evalOneBar(s, bar); …
  if (bar <= lastClosed) live.committed = bar;
  if (bar === lastClosed) live.ckpt = checkpoint(s, bar);   // ← 唯一一次；每 bar checkpoint 曾是 O(N²)
  …
}
```

### 7.1 修法（三處）

1. **`resetPeak()`**：`__mtfStats` 是模組單例、永不重置，harness 取 per-window 差值 ⇒ 首跑後恆 0。
   `MtfHooks` 加 `resetPeak?(): void`；mtf.ts 實作 `() => { __mtfStats.cwPeak = 0; }`；在 `incRunStart` 開頭（= 冷載入前）呼叫。之後 harness 的差值＝該趟真實峰值。
2. **`trimCw()`**：冷載入期間日誌從 `bar −1` 一路累積到 `lastClosed`（≈2 pushes/bar）才清。
   加 `MtfHooks.trimCw?(): void`；mtf.ts 實作「跑 `for (const spec of store.byNode.values()) if (spec.cw) spec.cw.length = 0;`」；在冷載入迴圈內、**`bar < lastClosed`** 時於每根已收盤邊界呼叫。
3. **`mtfCheckpoint` 不再主動開日誌**：`spec.cw ??= []` 移除，改為 `if (spec.cw && spec.cw.length > __mtfStats.cwPeak) …`（由寫入路徑 lazy 開）。

### 7.2 必須先證的不變式（**這是成 patch 的閘**）

日誌（`spec.cw`）的唯一用途是讓 `restoreSpec` **撤銷 checkpoint 之後的寫入**。因此清日誌的前提是「**不存在會被還原的、比當前 bar 更早的 checkpoint**」。冷載入期間：

- 保留的 checkpoint 只有兩個：種子（`bar = −1`）與最後的 `lastClosed`。
- `lastClosed` 一到就會**覆寫** `live.ckpt` ⇒ 種子在 `bars.length ≥ 2` 時**必然被取代**，其日誌可安全丟棄 ⇒ 在 `bar < lastClosed` 清日誌安全。
- **邊界**：`bars.length === 1` ⇒ `lastClosed = −1` ⇒ 迴圈裡 `bar < lastClosed` **永不成立** ⇒ 不會清 ⇒ 種子日誌完整 ✓。
- `bars.length === 2` ⇒ `lastClosed = 0` ⇒ 清日誌的範圍是空集合 ✓。
- **仍未追**：`incAdvance` 是否會用到**非** `live.ckpt` 的 checkpoint（若有第三個保留點，這條不變式就不成立）。⇒ **套用前必須 grep `restoreCkpt(`／`mtf.restore(` 的所有呼叫點確認還原來源只有 `live.ckpt`。**

### 7.3 驗收

冷載入 `counters.mtf.cwPushes → ~0`（**tick 路徑數字不變**）；`cwPeak` 能讀出「單根 log 長度」；四支 digest 不變；golden 0；954／tsc；`s1-inc-probe` parity 6/6。
**狀態**：設計已定、**尚未成 patch**（卡在 7.2 的 grep 確認 + 需要讀 mtf.ts 的自註冊字面以掛兩個新 hook）。

## 8. T10 前提更正（**已被樹上的測試否證**）— 建議：只改文件，不動行為

`src/pine/__tests__/engine.test.ts:309-360` 的註解與測試逐字：

```
// ── adaptive tick policy ────────────────────────────────────────────────────
// A run slower than HEAVY_RUN_MS flips the session to per-bar updates:
// forming-bar ticks (same tail time, new data) are skipped; a new bar still
// re-runs. The incremental path EXEMPTS itself (engine.ts request(): the skip
// needs `!incHolder.live`) — once a live IncLive exists a tick costs ~one bar
// of eval, not a full tape, so every tick keeps updating. Cheap scripts keep
// per-tick behavior. Verified by counting runs through a latency-controlled …
describe('adaptive tick policy', () => { …
  it('heavy run + live session → forming-bar ticks keep running (skip exempted)', async () => {
```

⇒ **結論（推翻 brief §T10「非空 tape 實質不可達 ⇒ 死碼」）**：
- 條件 `!incHolder.live && !incHolder.active` 是**刻意的豁免**，且**有測試保障**；三種可達情況（首次重跑尚無 live、拿不到 live 的腳本、live 失效後）都成立。
- **不得移除、不得改語義**。正確處置＝把「死碼」這個說法從文件更正掉（本節即更正），並在 `docs/2026-10-14-pine-perf-align.md` 的遺留清單寫「已知、接受、理由」。
- 若仍想動：唯一有價值的方向是**補註解**說明豁免條件（或加測試覆蓋「非 live 且 heavy ⇒ 確實跳」的那一半，若目前只測了豁免側）。

## 9. T9 patch 的常數語意（待驗完 `kparts` 後定案）

`stateForCapped` 的 `max` 檢查落在「**葉的父層 map**」上——語意等同「該 group 的 L 鍵數上限」**若且唯若** `kparts(key)` 的最後一個 component 就是 L。
- 已知：`emaVs`（`ta.ts:600`）是 `['dvs','ema', ...kparts(tag), len]` ⇒ 葉 = `len`（裸 number）⇒ 語意精確 ✓。
- 待驗：`vseries`（`['dvs', ...kparts(key)]`）與 `vstate`（`['stv', ...kparts(key)]`）的 `kparts(key)` 尾端是什麼（number L？tag 字串？pair？）。若尾端**不是** L，`VS_STATE_MAX=16` 會變成「tag 上限」而非「L 上限」——值仍正確（只是重算），但語意與註解不符，需改註解或改用 `winStateFor` 式（明確傳 `L`）的呼叫形狀。

## 10. 更正（2026-10-15 20:4x）：T9 已由另一代理實作；我的 ta.ts patch 作廢

**樹已變動**：`src/pine/builtins/ta.ts` md5 `6344a2a0…` → **`196c04d1…`**（2183 行；相對基線 +218/−44）。
`stateFor` 簽章現為 `(ctx, parts, make, cap?: number)`（`:162`），且 `VS_LEN_MAX = 16` 已存在（`:450`）。

⇒ **§9 的 `stateForCapped` 方案作廢**：我重造了倉庫**本來就有**的 `cap` 參數機制。教訓寫在這裡：動 ta.ts 前先 grep `cap`／`VS_LEN_MAX`，不要憑「看起來沒有」就新增機制。
⇒ 我的 patch 檔已改名 `scratch/perf/patches/r5-t9-t12c3-ta.patch.OBSOLETE`（`git apply --check` 已 FAIL，見 `patches/README.txt`）。

### 10.1 對方 cap 的覆蓋範圍（實測行號）

| 已套 `VS_LEN_MAX` | 呼叫 |
|---|---|
| `:640` | `emaVs`（`['dvs','ema', ...kparts(tag), len]`） |
| `:654` | `rmaVs`（`['rma', ...kparts(tag), len]`） |
| `:681` | `hmaVs` inner（`['hma-in', ...kparts(tag), len]`） |
| `:682` | `hmaVs` outer（`['hma', ...kparts(tag), len]`） |

⇒ 與 `t9-distinct-len.json` 量到的四群（`dvs/ema`、`stv/rma`、`dvs/hma`、`dvs/hma-in`）**一一對應** ⇒ T9 的主目標已達成。

### 10.2 仍缺 cap 的 L-keyed 呼叫點（**T9 未竟項**）

鍵尾端是 **L（會隨長度增長）** 但未傳 `cap`：

| 行 | 呼叫 | 鍵 |
|---|---|---|
| `:770` | `vseries(ctx, ['vwma-pv', emaTag(ctx, b), L], …)` | 尾端 `L` |
| `:1201` | `vseries(ctx, ['macd-l', tag, fast, slow], …)` | 尾端 `slow`（=L） |
| `:1463` | `vseries(ctx, ['kc-b', ...tag], … wmaWin(ctx, src, bb, L))` | `tag` 內含 L（待確認） |
| `:1466` | `vseries(ctx, ['kc-r', ...tag], …)` | 同上 |

（其餘如 `rsi-g/l`、`dmi+p/m/dx`、`tsi-m` 的鍵是 tag、不含 L ⇒ 不隨 L 成長，不在本項範圍。）
**建議**：對上表四處補 `, VS_LEN_MAX`（與對方同一常數、同一語意）；驗收＝240 根 `ta.vwma(close, bar+1)`／`ta.macd` 變長窗的 live distinct-L 有界＋逐值 0 差異＋四支 digest 不變。

### 8.1 更正（2026-10-15 21:0x）：§8 的「有測試保障」**過度宣稱**

T10CoverageDossier 逐行核過 `engine.test.ts`：

| 側 | 測試 | 行號 |
|---|---|---|
| **豁免側**（heavy ＋ live ⇒ **不**跳） | ✔ 有 | `engine.test.ts:359-386`（`runs` 1→2）＋ `:388-397`（便宜側） |
| **skip 側**（heavy ＋ 無 live ⇒ 確實跳） | ✘ **零測試** | 全 repo 無「`runs` 不變／無新 model」斷言；`engine.test.ts:310-316` 的註解只是**宣稱**會跳 |

⇒ 精確措辭應為：**「豁免側有測試；skip 側只有註解宣稱」**。

**「死碼」再判定（分兩段）**：
- 「**非空 tape 的成功路徑實質不可達**」——**成立**（in-process `engine.ts:484-486`＋`interpreter.ts:2902/3670/3675`；off-thread `pineWorkerEngine.ts:44` 同一算法）。
- 「**全域死碼、可刪**」——**不成立**：`active` 只在成功路徑寫（`pineWorkerEngine.ts:47` 的 catch 不刷新）、`dispose()` 置 `incAlive=false`（`pineWorkerClient.ts:248`）、`lastRunMs` 在例外路徑不刷新（`engine.ts:413`）、且 `active` 欄位存在的唯一理由是 off-thread 鏡射（`pineWorkerEngine.ts:42-44`）。
⇒ 建議處置：**已知、接受；要動先補測試**（補測形狀：沿用 `DelayedEngine(600ms)` spin（`engine.test.ts:318-331`）＋子類在 `super.runProgram` 後把 `opts.incHolder` 還原成 `{live:null, active:false}`；斷言**不可用 `waitFor`**，它只在第 k 個 model 到齊才 resolve，會 hang）。

## 11. T8a 可行性（T8StepperDossier 定案）：**可做，但有一個真 blocker**

- `simulate`（`strategy.ts:295-870`）**本來就是游標式**：`o.seen`（`:326`）、`riskBar`（`:636`）、`i`（`:309`）皆單調；使它每次從 0 重跑的只有入場 reset（`:301-304`）＋每次新配的 locals。
- **單一 blocker**：`strategyEquity.ts:34-58` 用 `shifted(ctx,b)` **對每個過去的 b 直接呼叫 `simulate`** ⇒ (a) 需要「任意 uptoBar 的乾淨重播」；(b) 它 reset 共享 order scratch ⇒ 與 stepper 游標**互相污染**（同 bar 內兩種 lazy 常數可任意序讀取）。
  ⇒ 二選一：**把 scratch 移出 order**，或**讓 equityCurve 改讀 stepper 的 per-bar equity**（順帶消掉第二個 Θ(B²)）。
- 唯一必須改的舊語意：未來 order 守衛 `:452` 由「標 seen 後丟棄」改為 **`break`**（否則 stepper 會永久跳過）。
- 不溢出 `interpreter.ts`：plain-object `SimCtl` 零改動即被 `plains` checkpoint 涵蓋；但 (i) `arrays` restore 會**重克隆 order 元素**（`:3389-3391`），`pending` 引用須靠同趟共享 `ids` 對上；(ii) **不可用 class**（class 實例被 `cloneDeep` 放行 ⇒ 不回滾）。
- 未驗：I1（bar k 的狀態不依賴 bar>k 的 order，以 `:452`＋clamp `:323/:628` 推得）、I4（是否有人跨 advance 持有 `Sim.execs`）。
- 全文：`docs/2026-10-15-t8-stepper-dossier.md`。
