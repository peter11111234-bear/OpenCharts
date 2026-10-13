# Pine 直譯器核心技術債 — 盤點與後續計畫（2026-10-13）

> **來源**：使用者提供之技術債清單 ＋ 逐項對照**現行碼**與**既有計畫**。
> **原則：保留最新決定** —— 已被後續 commit／較新文件解決者列為「作廢」，不重複施工。
> **狀態基準**：Repo `C:/Users/bear9/OpenCharts`，`main`，HEAD `9611616`，工作區乾淨。
> **最新權威文件**：`docs/2026-10-13-remaining-work.md`、`docs/superpowers/plans/2026-10-13-mzigzag-hp-fix-handoff.md`（皆晚於 `2026-10-12-pine-tv-alignment-handoff.md`）。

---

## 1. 已作廢 —— 有最新決定，不再施工

| # | 使用者清單項目 | 判定 | 證據（file:line / commit） |
|---|---|---|---|
| 1 | `int / int` 被整數截斷，應為浮點（5/2=2.5） | **已正確** | `src/pine/interpreter.ts:1019` `case '/': return { kind:'float', v: l.v / r.v }`；測試 `__tests__/interpreter.test.ts:611`「int/int → float」 |
| 2 | `%` 在負數應用 floor（-7%3=2），非 JS trunc | **已正確** | `src/pine/interpreter.ts:1020-1023` `l.v - r.v * Math.floor(l.v / r.v)`；測試 `interpreter.test.ts:836`「7%-3=-2, 7%2.5=2」 |
| 3 | 具名引數防呆（未知具名被靜默忽略／誤綁進 UDF 位置） | **已實作** | `c9344b2`（v1：`bindArgs`＋`bindCallArgs`）＋ `9611616`（v2：6 個綁定點 `bindArgsJit`/`liftNums`/`bindDeclArgs`/`tryEvalSecurity`）；測試 `named_args.test.ts`、`named_args_jit.test.ts`；`e2e.test.ts` 永久 gate |
| 4 | Strategy 同 bar `limit`＋`stop` 缺 OCO 互斥 | **已實作** | `src/pine/builtins/strategy.ts:347-350`（單筆 limit+stop 成 OCO 對，同 bar 皆觸及時取保守成交價）；`:852-861`（OCA 群組成交後兄弟單 `cancel`＝`cancelledAt=bar-1`／`reduce`＝縮量，註記「one-cancels-others, not first-touched-wins-later」） |
| 5 | Partial exit 虛增 `closedtrades`；歷史索引需對齊 TV（0=第一筆） | **已修** | `docs/superpowers/plans/2026-10-09-backlog-phase2.md` 之 F2/F3/F4（F3＝`closedtrades.*` 改時序；F4＝逐 leg 記帳，`closedTrades` 只計被吃掉的 leg） |
| 6 | `when=` 繫結與 `immediately=true` 觸發 | **已實作** | `strategy.ts:947-954`（v5 簽章序；`when` 僅作具名、不佔位置槽）；`:960-961`（entry/exit/order/close 皆讀 `when`）；`:1007`（`close`/`close_all` 讀 `immediately`） |
| 7 | MTF：`security()` 內巢狀呼叫 stateful 內建誤讀 `lastBar`；UDF 閉包 scope 傳遞 | **已修** | `docs/pynecore-conformance.json` `sec-nested` status=full（「巢狀 + UDF callsite 各有 callerKey，避免 chartHist 互串」）；`src/pine/mtf.ts:1887` `spec.callerKey = callsiteKey(ctx, spec.node)`、`:1998`；測試 `mtf_invariance.test.ts` N1–N6；`2026-10-08-mtf-eval-cache-perf.md`（`nodeCache` 重置真根因已解） |
| 8 | Handoff A：諧波 / ABC 綠線在 Vela 漏繪 | **已解** | `docs/superpowers/plans/2026-10-13-mzigzag-hp-fix-handoff.md` R20：根因＝`array.push/unshift` 具名槽寫成 `'val'`（TV 是 `value`）→ 修 `src/pine/builtins/array.ts`；實測 canvas 出線（101 line/26 label）＋ `ABCD`/`Double Top` 標籤 |

---

## 2. 新列入計畫 —— open、先前只散落在 audit／handoff，未成計畫

### TODO checklist

- [ ] **N1**（P2）`CowSeries.writable` 對 `SecSeries`：`currentBar<0` → `base=-1` → 副本空 → 別名 `s[1]` 讀 na。**修法已定**：`writable` 在 `currentBar<0` 時 fallback `src.size()`（同非 BarSeries 分支）。
  - 證據：`docs/superpowers/audits/audit-cow-alias.md:38-49`（含 repro）
  - 檔案：`src/pine/interpreter.ts`（`CowSeries.writable`）、`src/pine/mtf.ts:1105-1111`（同構副本）
- [ ] **N2**（latent）`array.from(...)` 仍存 live series 而非快照（TV 快照）。參照 R18 的 `snap()` 修法（`src/pine/builtins/array.ts`）。
  - 證據：`2026-10-13-mzigzag-hp-fix-handoff.md §2 B`
- [ ] **N3**（perf）Handoff B：KJ 瀏覽器首跑時間未重測（修 A/B 後應約 8s/500 bars）。
  - 證據：`2026-10-12-pine-tv-alignment-handoff.md §2 B`
- [ ] **N4**（UX）Handoff D：Vela 頂欄週期釘選（`timeframeFavorites` 寫入 workspace state，免下拉自動關閉）。
  - 證據：`2026-10-12-pine-tv-alignment-handoff.md §2 D`
- [ ] **N5**（UX）Handoff E：Vela data-window 面板未接線（`chart.getDataWindowReadout()` 已回傳，`VelaPage` 沒渲染）。
  - 證據：`2026-10-12-pine-tv-alignment-handoff.md §2 E`
- [ ] **N6**（perf）Handoff G／R15 殘項：`R.call` arg fast-arm、`str` 歸屬、tf-domain `callHist → histSpecHas`。
  - 證據：`2026-10-12-pine-tv-alignment-handoff.md §2 G`、`2026-10-11-pine-residual-perf-v1.md`
- [ ] **N7**（correctness；需 TV oracle 定案）Strategy 殘留語意：
  - 同 bar「pending limit entry」vs「market exit」成交順序［INFERENCE，需 live TV 對照］
  - `strategy.close(id)` / `strategy.exit(from_entry)` id 比對（現行 unmatched id 仍 FIFO 平倉；`strategy.test.ts` 以 `it.fails` 釘住）
  - partial exit 下 `netprofit` vs `equity` 時序差
  - reversal 成交的手續費分攤（全記在平倉腿）
  - 證據：`docs/superpowers/plans/2026-10-09-backlog-phase2.md` deferred 段、`docs/strategy-qa-2026-10-09.md`

---

## 3. 已在他處列管（不重複列，僅交叉引用）

`docs/2026-10-13-remaining-work.md`：
- §B TV 標準庫缺 82（matrix 48 最後做／syminfo 27 等資料源／(global) 4／chart 3 刻意不做）
- §C PyneCore missing 4（`max_bars_back`、`matrix` 型別、`request.security` 無資料、`strategy.calc_on_order_fills`）／partial 14
- §D1–D9（新 `ta.*`/`strategy.*` 無 TV 數值 oracle、`log.*` 無面板、S5 五條刻意限制、`matrix.*` stub、**D5 手寫 drawing builtin 不看 `named`（draw 27＋core 8＋strategy 9）**、D6 `from_seconds` 邊界、D7 `duplicate named argument` 語意不一、D8 `tz.ts` 快取無上限、D9 `timenow` 破 cache 不變式）
- §E（TS 防回歸／pinets 移植層 5346 行孤兒／常數摺疊未做／broker port 未做）
- §F 明確決定「不做」

---

## 4. 建議順序

1. **N1** —— 便宜、有明確修法，與 P8 review 抓到的 `tz`/`timenow` 同屬「邊界洩漏」家族。
2. **N2** —— 與 R18 的 array-snapshot 同家族，一次收乾淨。
3. **remaining-work §建議順序**：D5（draw named-blind）→ C（`calc_on_order_fills`/`varip`）→ E（TS 防回歸，10 分鐘）→ D1（TV 數值 oracle）。
4. **N3–N6** —— UX/perf，等真實需求。
5. **N7** —— 需人工在 TV 對照，成本最高。
