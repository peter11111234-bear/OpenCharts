# Pine Interpreter MTF Performance — Problem Statement & Roadmap

> **日期：** 2026-10-07
> **目的：** 給 reviewer（Opus）一份完整的問題描述 + 已做/待做清單，目標是找出「為什麼這個腳本在 TradingView 上即時、在我們的 interpreter 上 13s/500bars」的**結構性**修法，而不是更多 micro-fix。

---

## 1. 問題陳述

`runScript`（`src/pine/interpreter.ts`）對 TRIS390（802 行 strategy，21 個 `request.security` 橫跨 7 個時框 × 3 個指標 UDF：`f_supertrend`/`f_rangefilter`/`f_halftrend`）：

| 里程碑 | 500 bars (5m) 耗時 | 備註 |
|---|---|---|
| baseline | 47.7s | UI 完全凍結（tab 被 watchdog 殺掉）|
| +LiftedSeries | 29.6s | lazy nz/math.max/etc |
| +circular BarSeries + ambientBar + yield | **13.3s** | UI 不再凍結但仍太慢 |

TradingView 同一腳本：肉眼即時（<1s）。我們的目標應是 **<2s @500 bars、<10s @5000 bars**（使用者圖表實際 K 棒數）。

---

## 2. 已確認的根因（有量測背書）

### 2.1 `seriesFromOffsets` 每呼叫物化整段歷史 — ✅ 已修（Task 2）
`nz`/`math.max`/`math.sum`/`math.round` 這類 pointwise kernel 在 series 輸入時，用 `len = max input size` 把 `fn(i)` 從頭到尾算完 → 每根 bar O(bars)，UDF 內每根呼叫 → O(bars²)。
**修法：** `LiftedSeries extends BarSeries`，`fn(i)` 只在 `atOffset`/`get`/`cur` 實際被讀時算（+cache）。已落地 `math.ts`。

### 2.2 `BarSeries` 用 `unshift` 寫入 — ✅ 已修（Task 1）
原 ring buffer 每次 `setAt`/`ensureBar` 填補都是 O(len) memmove；4M 次寫入 × ring length 數百～5000 → 主二次項。
**修法：** 改成 dense append（`buf[] + startBar/writeBar/lastBar`），`ensureBar` 變 O(1) marker。已落地 `series.ts`。

### 2.3 `get(n)`/`cur()` 錨定 `lastBar` 而非 ambient bar — ✅ 已修（Task 1）
沒有 ambient 時，branch 跳過的 decl slot 在 `get(0)` 會讀不到 carry-forward。加了 `setAmbientBar(bar)`/`ambientBar()`，`runScript` 每根設、跑完清。已落地。

### 2.4 殘餘 ~6s/300 bars 的來源（CPU profile，2026-10-07）
| 函式 | self time | 原因 |
|---|---|---|
| `stateFor` (ta.ts) | 564ms | 每呼叫每 bar 組 `vs\|${site}\|series#${id}` 字串 key + Map 查詢 |
| `siteKey` (interpreter) | 269ms | 每呼叫每 bar `id\|stack.join(',')` 字串 join |
| `evalCallDispatch` | 303ms | 每呼叫每 bar member-chain flatten + `scope.lookup` + `BUILTINS.get` + `bindArgs` |
| `BarSeries.setAt` (mtf patch) | 245ms | `advanceTo` + `emit`/`chartHist` + `callHist` 寫入，量大致對 |
| `invokeBuiltin`/`bindArgs`/`lookup`/`runOf` | ~500ms | per-call per-bar dispatch 開銷 |
| `tryEvalSecurity` | 85ms | cache 已命中（top-level call sites）|
| `(anon) math.ts` | 453ms | `LiftedSeries` 的 `fn(0)`/`at` 仍每根跑（正確，只是成本）|

**關鍵觀察：** 21 個 security call 都在 top level（`frame0.scope`），`evalAt` 的 (node, callerScope, j) cache **對這個腳本已經命中**——所以剩下的不是 security 評估，而是**每根 chart bar 把 802 行 top-level body 整個重跑一遍**的 dispatch + 寫入成本。

---

## 3. 待做項目（依影響排序）

### Task 3 — 消掉 per-call 字串鍵 + dispatch 常數（預估 −30~50%）
- `siteKey`：改成 interned object trie（`Map<object, Map<object, object>>`），回傳穩定 object identity，不再 `join(',')`。
- `stateFor`/`vsOf`/`vstate`：`Map<number /*callsite*/, Map<object, T>>` 取代字串 key。
- `evalCallDispatch`：每個 Call node 的 member-chain / builtin target 預解析一次（`WeakMap<Call, resolved>`），bar loop 裡直接查表。
- `evalArg`：literal args（num/bool/str）不再配 `callHist` BarSeries，用 `ConstSeries`。

### Task 4 — 編譯 top-level body 成 per-bar closures（結構性，預估再 −30~50%）
把 `for (const stmt of body) evalExpr(stmt, frame0)` 改成一次 pre-pass 產生 `Array<(frame) => Value>`，closure 裡已綁好 resolved call target / decl slot key，bar loop 只跑 closure。這是 TV 真正做的事（script → per-bar step function）。
- UDF body 也走 `evalCallDispatch`，可先只編譯 top level；UDF 內部再一輪。

### Task 5 — `LiveLiftedSeries`（ta.* 對 `nz`/`math.max` 參數的 cross-bar memo 才會中）
`vsOf` 用 `seriesId(s)` 當 key，但 `nz()` 每根產生新的 `LiftedSeries` → 每根新 VS → ta.* window 重算。改成 per-(callsite, args) 的穩定 lifted series，`at(bar)` 以 bar 為 anchor。

### Task 6 — Web Worker（只在 <2s 仍達不到時做）
搬 `runScript` 到 worker，主執行緒不凍結。要 marshal `RunResult`（`Map`/`BarSeries`/`Value`）。不加速，只藏延遲。

### 已知但低優先
- `evalAt` 對 **UDF/if 內** 的 security call 永遠 miss（`blockFrame` 每根新 Scope）→ 應改用 `siteKey` 當 cache key（Task 3 的 trie 可直接複用）。TRIS390 的 security 在 top level 所以這個腳本不受影響，但對其他腳本是炸彈。
- `emit`/`chartHist`/`advanceTo` 寫入量正確（~50-100K setAt），不是瓶頸。
- `tfDirty`/`tfOwned` WeakSet 不清除是既有地雷，暫不動。

---

## 4. 已驗證的數字

- `test_mtf.mjs`：500 synthetic 5m bars，`runScript` 13.275s（yield 每 64 bar）。
- `diag.mjs`（200 bars）：`ensureBar` 964K 次呼叫（現在 O(1)），`setAt` 357K 次 / 4.07M entries。
- CPU profile（300 bars，`--cpu-prof`）：總 self-time ~4.9s，`run` 6.494s。

## 5. 給 reviewer 的問題

1. Task 4（compile-to-closures）是不是正確的下一步？還是有更便宜的結構性改法（例如：bar loop 裡 cache「上根沒變的 statement」直接跳過——但 `var`/side-effect 讓這不安全）？
2. `LiftedSeries` 的 lazy `atOffset` 有沒有我看漏的 Pine 語義坑（`x := ` reassign、`x[n] := ` hist-assign、`x` 被當 function arg 傳進 UDF）？
3. `emit`/`chartHist`/`advanceTo` 的寫入量還能再砍嗎？
4. Worker 化是不是其實該先做——因為就算到 2s，5000 bars 的腳本還是會卡 20s？

---

## 6. 目前 diff 狀態

- `src/pine/series.ts`：circular buffer + `setAmbientBar`/`ambientBar`（已落地）
- `src/pine/interpreter.ts`：`setAmbientBar(bar)` + 每 64 bar yield（已落地）
- `src/pine/builtins/math.ts`：`LiftedSeries`/`readOff`/`refBar`/`seriesFromOffsets(sources)`（已落地）
- 未動：`mtf.ts`（evalAt cache key）、`ta.ts`（stateFor/vsOf）、`siteKey`、`evalCallDispatch`、`evalArg`
- `npm test` 尚未跑（改動後第一次跑）
