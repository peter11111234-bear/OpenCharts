# T12 小項逐項列管（取證批；行號＝現行優化樹）

樹：`src/pine`（`mtf.ts` 2411 / `interpreter.ts` 3963 / `builtins/ta.ts` 2164 / `series.ts` 722 行；`mtf.ts` md5 `79d67c66b8e19349b4fdaeeaef5d3d79`）。五項**全部在本樹存在**（逐一 grep 確認）。本批唯讀。

---

## 1. `cwPeak` 欄位壞（取「只增不減 max 的差值」⇒ 恆 0）

**現況**
- `mtf.ts:1351` `__mtfStats`（模組層單例，整程序只初始化一次）。
- `mtf.ts:2385`（`mtfCheckpoint` 內）`if (spec.cw.length > __mtfStats.cwPeak) __mtfStats.cwPeak = spec.cw.length;` ⇒ 單調不減 max。
- `mtf.ts:264` `resetMtf()` 只重置 `store`，**不碰 `__mtfStats`**。
- Harness 讀取端：`scripts/perf/lib/counters.mjs:83` `mtf[k] = after.mtf[k] - (before.mtf[k] ?? 0)`（per-window 差值）；`counters.mjs:13` 明言「Every read is a DELTA … successive runs in one process stay independent」。
- 消費者：`scratch/perf/s1-inc-probe.mjs:215`、`scratch/perf/t2-strategy-scale.mjs:420`（build）/`:462`（advance）。

**可觀測後果**：程序內第一次量測後，每個窗口差值恆 0。證據：`scratch/perf/t2-scale-20261015-134050.json` 每個新程序**第一個 build** 報 `cwPeak: 1004`（`:261`）／`3000`（`:1548`），同程序後續 advance 全 0（`:531,700,869,1038,1224`）；`r5-final-verify.json`、`a5-optimized.json`、`s1-inc-tris-*.json` 全 0。⇒ 實際讀到的是「首跑冷載入累積」，之後永遠 0，**從未讀到「單根 log 長度」**。

**最小修法**：讓它可在 harness 取樣同一邊界重置。
- `mtf.ts`：新增 `resetPeak()`（或併入 `resetMtf()`，`mtf.ts:264`）設 `__mtfStats.cwPeak = 0`。
- `interpreter.ts`：`MtfHooks`（`:89-115`）加 `resetPeak?()`，在 `incRunStart` 開頭（`:3662`，緊鄰 `checkpoint(s,-1)` `:3679`）與 `incAdvance` 開頭（`:3716`，緊鄰 `restoreCkpt` `:3751`）各呼叫一次。
- 順帶更正 `mtf.ts:1348-1350` 註解（「the writes of ONE bar」只對 tick 路徑成立）。
- 折衷（1 行、不動介面）：只在 `resetMtf()` 內歸零 → 修好冷載入數字（T6 打點②要的），tick 路徑仍讀 0。
- **`scripts/perf/**` 本批凍結**，harness 端改讀絕對峰值不在此批。

**爆炸半徑**：量測面，零語意面（無求值路徑讀 `cwPeak`）。

**需逐值等價證明？** 不需要。

**驗收**：修後 `t2-strategy-scale.mjs` 在 500/1500/3000 根上 build **與每個 advance 都非 0**，且 build 值隨 bar 數成長（O(history) 指紋）；`s1-inc-probe.mjs` parity 6/6 不變。

**建議：修**（量測專用、改動極小）。

---

## 2. `spec.cw` 冷載入 O(history)

**現況（本樹錨點）**
- 寫入：`mtf.ts:242-246` `cwMap`（`!spec.cw` 直接 return）；呼叫點 `mtf.ts:1866/1891/1908/1909/1912/2166/2187/2189/2203`。
- **唯一建立點**：`mtf.ts:2384` `spec.cw ??= []`（在 `mtfCheckpoint` 內）。
- 清空：`mtf.ts:2387`（`mtfCheckpoint`）、`mtf.ts:2312-2318`（`restoreSpec`）。
- `mtfCheckpoint` 只經 `checkpoint()` → `mtf?.checkpoint?.(s)`（`interpreter.ts:3537`）抵達。
- 種下點：`interpreter.ts:3679` `checkpoint(s,-1)`（**第一次、把日誌打開**）；真正 checkpoint：`interpreter.ts:3691` `if (bar === lastClosed) live.ckpt = checkpoint(s, bar)`（**全日唯一一次、清空日誌**）。
- 冷載入迴圈：`interpreter.ts:3683-3698`，**每根 bar 都不 checkpoint**（`:3689-3690` 明載為避開首次載入 O(N²) 快照）。
- tick 路徑：`incAdvance` `interpreter.ts:3761-3766` 每根新收盤 bar 各 checkpoint 一次 ⇒ ≤ 一根 bar 寫入；rollback `restoreCkpt`（`:3751`）→ `mtfRestore` → `restoreSpec`（`mtf.ts:2312-2316`）逐筆走完整個 log。

**可觀測後果**：冷載入期間日誌累積**每一根已收盤 bar** 的寫入（bar 0..lastClosed），因 −1 的種下 checkpoint 開了它、下一次清空是 lastClosed 那唯一一次。實測 100 根 → 4,717 pushes（`r5s1-coldload-100.json:434`）；由第 1 項「首跑 cwPeak 即該累積」可讀出 500 根 → 1,004、1,500 根 → 3,000（≈2 筆/bar）（`t2-scale-20261015-134050.json:261,1548`）。⇒ **per-spec O(history) 記憶體**，且第一次 `incAdvance` 的 rollback 要走完它（`mtf.ts:2312-2316`）。無任何消費者需要這些 entries：−1 那份 `SpecSnap` 已被 lastClosed 那次覆寫（`interpreter.ts:3691`），bar < lastClosed 的 entries 是純死重。

**最小修法**：只在 rollback 窗口內開日誌。於 `incRunStart` 迴圈（`interpreter.ts:3683-3698`）在 `lastClosed` 之前的每個已收盤邊界清空各 spec 的 log：`MtfHooks`（`interpreter.ts:89-115`）加 `trimCw?()`，`mtf.ts` 實作 `for (const spec of store.byNode.values()) if (spec.cw) spec.cw.length = 0;`（O(#specs)/bar，非 O(history)）。
- 順帶更正 `docs/2026-10-14-pine-perf-align.md:749` 與 `docs/2026-10-15-r5-remaining-autorun.md:192` 的舊行號（`interpreter.ts:3768/:3690` → 本樹 `:3679` 種下 / `:3691` 真正 checkpoint）。

**爆炸半徑**：`mtf.ts` + `interpreter.ts` 一個呼叫點；純 write-log，非求值路徑。

**需逐值等價證明？** 需要（它是 rollback 面本身，雖只該丟棄死重）。

**驗收**：`s1-inc-probe.mjs` parity 6/6、四支凍結 digest 不變、golden 0；冷載入 `counters.mtf.cwPushes` 掉到 ~0 且 **tick 路徑數字不變**。

**建議：修**（已排定的 T6 打點②；語意風險低、半徑有界）。

---

## 3. C2 `ta.vwma` 1 ulp

**現況**
- `ta.ts:740-758` `reg('vwma', …)`：現走 `ssumWin(ctx, pv, bar, L)` / `ssumWin(ctx, vol, bar, L)`（`:581-582` → `winAgg(ctx,'ssum',…)`）。
- Kahan 補償滑動累加：`ta.ts:444-448` `accAdd`、`:471` `sum()`（回傳 `acc.x + acc.c`）。
- 舊語意仍以 fallback scan 存在：`ta.ts:287-295` `ssumScan`，由 `winAgg` 的 `direct()`（`ta.ts:516`）使用。
- 已量測紀錄：`docs/2026-10-14-pine-perf-align.md:657` — 舊 `105.54932822978434` vs 新 `…432`（rel ≈ 2e-15），在 golden 容差 1e-9 內；**golden 無 vwma plot**。

**可觀測後果**：`Δ` 是「加減滑動 vs 由左而右重掃」的浮點順序差，確定性、次容差；只破壞逐位元 digest 比對，不影響數值正確性。

**最小修法（若修）**：vwma 兩個和改回嚴格掃描 — `ta.ts:754-755` 用 `ssumScan` 取代 `ssumWin`（只針對 vwma 的 2 行回退），代價是回復 O(L)/bar 重掃（正是當初要移除的成本）。

**爆炸半徑**：`ta.ts` vwma 一處（若修）。

**需逐值等價證明？** 若修，需要；`docs:657` 已記下預期 1 ulp 差，證明應斷言「≤1 ulp 且結構解讀 0 差異」。

**驗收（若修）**：vwma 輸出對舊 scan 逐值 ≤1 ulp；四支 digest 不變（golden 無 vwma plot）。

**建議：只記錄** — 已是文件化的可容許浮點假象、無正確性影響；「修」等於為零使用者可見收益撤掉效能改善。在 `docs/2026-10-14-pine-perf-align.md` 遺留清單把它從「open smell」改標為「已知／接受／附容差例外」。

---

## 4. C3 forming-bar `wring` latch

**現況**
- `ta.ts:388-405` `winRingReader`；latch 即 `ta.ts:399` `if (i < 0 || i > ctx.barIndex) return vs.get(i);` 與 `ta.ts:402-403` `const v = vs.get(i); if (v !== undefined) ring.set(i, v);`。
- 表：`ta.ts:389` `stateFor(ctx, ['wring'], () => new Map())`，鍵 `vsId(vs)`（`:390`），上限 `WIN_RING_MAX = 512`（`ta.ts:363`，clear-on-full `:393`）。
- rewind 面：`interpreter.ts:3330-3358` `snapCtxState`（把 `wring` 內層 Map 歸為 `nummaps`）、`:3360-3384` `restoreCtxState`（`:3377` 剪掉 key `> bar` 者）。
- 紀錄（原判行號 `ta.ts:376-383`）：`docs/2026-10-14-pine-perf-align.md:658` —「forming bar 的非 na 值會被凍結；同一 bar 稍後改寫來源時，同 callsite 同 VS 的重入可能讀到首讀值。三種自然形狀實測皆 SAME、共用面窄 → 氣味」。

**可觀測後果**：reader 把 **forming bar 自己的值**（`i === ctx.barIndex` 且非 undefined）存進**跨視窗共用**的 ring；若同一根 bar 稍後來源被改寫，同 callsite 同 VS 的再次讀取會回傳首次讀取值。tick 路徑因 rollback 剪掉 `> ck.bar` 的鍵（`interpreter.ts:3377`）而在下一 tick 重算，曝露面限於**同 bar 內重入**；且因 ring 是全 VS 共用，影響不限原呼叫者（所有以同一 VS 為源的視窗）。**實測三種自然形狀皆 SAME** ⇒ 未觀察到值差。

**最小修法**：只對「嚴格低於 forming bar」的索引做 latch — `ta.ts:402-403` 改為 `if (v !== undefined && i < ctx.barIndex) ring.set(i, v);`。1 行、無簽章變更；代價是 forming bar 每次讀多一次 `vs.get`（可忽略），換掉整個跨視窗凍結面。

**爆炸半徑**：`ta.ts` 一處；只影響快取，不影響任何讀值語意。

**需逐值等價證明？** 需要（動到快取）；四支凍結腳本逐值 diff + parity 6/6 即可。因實測本就 0 差異，證明實務上「無差異即通過」，故須搭配**針對性斷言**（probe：在 forming bar 內改寫來源後重讀，今日是唯一能曝露它的形狀）。

**驗收**：該 probe 由「首讀值」改為「新值」；四支 digest + parity 6/6 不變。

**建議：修（1 行、低風險）**，前提是本批已在動 `ta.ts`；否則**只記錄**並附該 probe 提案。

---

## 5. `bind` 結構契約顯式化（R4 F3 遺留）

**現況**
- 宣告：`series.ts:580` `bind?(inner: BarSeries): void;`（`ForwardingSeries`，`series.ts:578-581`），文件塊 `:568-577`。
- 消費者：`series.ts:614-616` `stableSeries` → `walkForwarding(s, (t) => (t.bind !== undefined ? t : t.readTarget()))`（`:615`）—— **duck-typed 名稱存在性測試**。
- 生產者：**全樹唯一實作**是 `SiteSeries.bind`（`interpreter.ts:404-415`，方法在 `:412`），建立／重綁於 `interpreter.ts:522-534` `stableArgSeries`（`:530-531`）。
- 刻意無 `bind` 的 `ForwardingSeries` 子類：`interpreter.ts:288` `CowSeries`（用 `rebind`，`:314`）、`mtf.ts:1236` `CowSeries`（私有鏡像）；`LiftedSeries`（`series.ts:544`）extends `BarSeries` 而非 `ForwardingSeries`。
- `src/pine` 內**沒有任何測試**引用 `stableSeries`/`SiteSeries`/`siteAnchor`（grep 只命中 src 檔與 doc 註解）。
- 紀錄：`docs/2026-10-14-pine-perf-align.md:682`（R4B 宣告）、`:756`（F3 已補註記）、`docs/2026-10-15-r5-remaining-autorun.md:218`。

**可觀測後果**：今日**無**（樹上唯一 `bind` 就是預期那個）。殘留風險是**未來**某個 `ForwardingSeries` 子類為無關用途定義 `bind` 成員：`stableSeries` 會在它身上停步，把手把 ta.ts 的身分鍵表（`vs`/`wring`/`wvs`）指向逐 bar churn 的鍵 ⇒ Θ(bars²) 表成長（S1 形狀），**靜默、僅效能、值不變**。反向亦然：`bind` 是 optional，新的 per-site wrapper 忘了宣告也不會被型別系統攔下，`stableSeries` 會循 `readTarget()` 進入逐 bar churn。⇒ 契約靠慣例，不靠型別。

**最小修法（推薦）**：用顯式標記取代名稱 duck test。
- `series.ts:580` 保留 `bind?()`（那是 hand-off），另加不可碰撞旗標 `readonly siteAnchor?: true;`；`SiteSeries`（`interpreter.ts:404-412`）設 `siteAnchor = true`；`series.ts:615` 改測 `t.siteAnchor === true`。共 3 行、零行為差異。
- 較重方案：把契約搬進 `series.ts`（如 `export abstract class SiteAnchorSeries extends ForwardingSeries { abstract bind(...): void }`），編譯器強制，但要跨檔搬類別。
- 旗標若嫌 hacky，等價做法是由 `series.ts` 匯出 module-scoped `Symbol`，在 `SiteSeries` 以 computed member 標記。

**爆炸半徑**：`series.ts` + `interpreter.ts` 各 1-2 行；全部是身分分類管線。

**需逐值等價證明？** 不需要（選出的穩定端必須相同）。驗收以斷言為準：`stableSeries(siteSeries) === siteSeries`、`stableSeries(cow) === cow.readTarget()`，外加四支 digest + parity 6/6。

**建議：修（3 行、零行為差異）** —— 便宜且把慣例變成編譯器／lint 守得住；若本批只做記錄，至少補上「選對穩定端」的測試（今日沒有）。

---

## 總表

| # | 項 | 本樹位置 | 後果 | 半徑 | 逐值證明 | 建議 |
|---|---|---|---|---|---|---|
| 1 | `cwPeak` 壞 | `mtf.ts:1351/2385/264` + `counters.mjs:83` | per-window 差值恆 0（首跑後） | 量測面 | 不需 | **修** |
| 2 | `spec.cw` 冷載入 O(history) | `mtf.ts:242/2384/2387/2312` + `interpreter.ts:3679/3691/3683-3698` | per-spec Θ(bars) log + 首次 rollback 全走 | `mtf.ts`+1 呼叫點 | 需要 | **修** |
| 3 | C2 vwma 1 ulp | `ta.ts:740-758` / `444-448` / `287-295` | 只破壞逐位元 digest（rel≈2e-15） | `ta.ts` 一處 | 若修需要 | **只記錄** |
| 4 | C3 forming-bar ring latch | `ta.ts:399,402-403` | 同 bar 重入可讀到首讀值（實測皆 SAME） | `ta.ts` 一處 | 需要（+針對性 probe） | **修（1 行）**，否則記錄 |
| 5 | `bind` 契約顯式化 | `series.ts:580/615`、`interpreter.ts:412` | 今日無；未來名稱碰撞 ⇒ 靜默 Θ(bars²) | 3 行 | 不需（改斷言） | **修** |

五項皆確認**存在於現行優化樹**（非舊樹）。本批唯讀，未改動任何檔案。
